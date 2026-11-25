import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { allocateCustomPath, makeCustomWallpaper, publicLibrary, resolveAsset, sanitizeCustomTitle, scanCustomDirs } from './library.js';

function openDirectory(directory) {
  const target = path.resolve(directory);
  if (process.platform === 'win32') {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      'Start-Process -FilePath explorer.exe -ArgumentList (\'"\' + $env:AG_OPEN_DIR + \'"\') -WindowStyle Normal',
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, AG_OPEN_DIR: target },
    });
    child.unref();
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [target], { detached: true, stdio: 'ignore' });
  child.unref();
}

const defaultCustomDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.local/custom');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end };
}

export async function createWallpaperServer(library, { port = 32190, mode = 'preview', connection = {}, customDir = defaultCustomDir, onOpenDir = openDirectory } = {}) {
  const client = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  const preview = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const byId = new Map(library.wallpapers.map((wallpaper) => [wallpaper.id, wallpaper]));
  const syncCustomWallpapers = async () => {
    const dirs = [...new Set([customDir, ...(library.customDirs || [])])];
    const { wallpapers: freshCustom } = await scanCustomDirs(dirs);
    const workshop = library.wallpapers.filter((item) => item.source !== 'custom');
    library.wallpapers = [...workshop, ...freshCustom].sort((a, b) => a.title.localeCompare(b.title));
    byId.clear();
    for (const item of library.wallpapers) byId.set(item.id, item);
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, X-Filename');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Cache-Control', 'no-cache');
    try {
      if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
      const url = new URL(request.url, 'http://localhost');
      const send = (type, content, status = 200) => {
        response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(content) });
        response.end(request.method === 'HEAD' ? undefined : content);
      };
      if (request.method === 'POST' && url.pathname === '/api/open-dir') {
        await mkdir(customDir, { recursive: true });
        onOpenDir(customDir);
        send('application/json; charset=utf-8', JSON.stringify({ directory: customDir }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/import') {
        const rawName = url.searchParams.get('name') || (request.headers['x-filename'] ? decodeURIComponent(String(request.headers['x-filename'])) : '');
        const { directory, filename, fullPath } = await allocateCustomPath(customDir, rawName);
        try {
          await pipeline(request, createWriteStream(fullPath));
          const info = await stat(fullPath);
          if (info.size === 0) throw Object.assign(new Error('文件为空'), { status: 400 });
        } catch (error) {
          await unlink(fullPath).catch(() => {});
          throw error;
        }
        const item = makeCustomWallpaper(directory, filename);
        library.wallpapers.push(item);
        library.wallpapers.sort((a, b) => a.title.localeCompare(b.title));
        byId.set(item.id, item);
        const { directory: _, ...pub } = item;
        send('application/json; charset=utf-8', JSON.stringify({ wallpaper: pub, wallpapers: publicLibrary(library) }), 201);
        return;
      }
      if (request.method === 'PATCH' && url.pathname.startsWith('/api/wallpapers/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/wallpapers/'.length));
        const item = byId.get(id);
        if (!item) { response.writeHead(404).end(); return; }
        if (item.source !== 'custom') { response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('仅支持重命名自定义导入的壁纸'); return; }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('无效的 JSON 请求'), { status: 400 }); }
        const cleanTitle = sanitizeCustomTitle(body?.title);
        const ext = path.extname(item.file);
        const nextFile = `${cleanTitle}${ext}`;
        const oldPath = await resolveAsset(item.directory, item.file);
        const nextPath = path.join(item.directory, nextFile);
        if (nextFile !== item.file) {
          if (nextFile.toLowerCase() !== item.file.toLowerCase()) {
            try { await stat(nextPath); throw Object.assign(new Error('已存在同名文件'), { status: 409 }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          await rename(oldPath, nextPath);
        }
        const updated = makeCustomWallpaper(item.directory, nextFile);
        byId.delete(id);
        const idx = library.wallpapers.indexOf(item);
        if (idx !== -1) library.wallpapers.splice(idx, 1, updated);
        library.wallpapers.sort((a, b) => a.title.localeCompare(b.title));
        byId.set(updated.id, updated);
        const { directory: _, ...pub } = updated;
        send('application/json; charset=utf-8', JSON.stringify({ wallpaper: pub, wallpapers: publicLibrary(library) }));
        return;
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/wallpapers/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/wallpapers/'.length));
        const item = byId.get(id);
        if (!item) { response.writeHead(404).end(); return; }
        if (item.source !== 'custom') { response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('仅支持删除自定义导入的壁纸'); return; }
        const file = await resolveAsset(item.directory, item.file);
        await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        byId.delete(id);
        const idx = library.wallpapers.indexOf(item);
        if (idx !== -1) library.wallpapers.splice(idx, 1);
        send('application/json; charset=utf-8', JSON.stringify({ wallpapers: publicLibrary(library) }));
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      if (url.pathname === '/api/status') {
        send('application/json; charset=utf-8', JSON.stringify({ app: 'antigravity-wallpaper', mode, connection }));
        return;
      }
      if (url.pathname === '/api/wallpapers') {
        await syncCustomWallpapers();
        send('application/json; charset=utf-8', JSON.stringify({ wallpapers: publicLibrary(library), counts: library.counts }));
        return;
      }
      if (url.pathname === '/') { send('text/html; charset=utf-8', preview); return; }
      if (url.pathname === '/client.js') { send('text/javascript; charset=utf-8', client); return; }
      const match = /^\/wallpapers\/([^/]+)\/(.+)$/.exec(url.pathname);
      const wallpaper = match && byId.get(decodeURIComponent(match[1]));
      if (!wallpaper) { response.writeHead(404).end(); return; }
      const file = await resolveAsset(wallpaper.directory, decodeURIComponent(match[2]));
      const info = await stat(file);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      const headers = { 'Content-Type': mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
      let range;
      if (request.headers.range) {
        range = parseRange(request.headers.range, info.size);
        if (!range) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
      }
      headers['Content-Length'] = range ? range.end - range.start + 1 : info.size;
      response.writeHead(range ? 206 : 200, headers);
      if (request.method === 'HEAD' || info.size === 0) { response.end(); return; }
      await pipeline(createReadStream(file, range || {}), response);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error.status || (error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500);
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, client };
}
