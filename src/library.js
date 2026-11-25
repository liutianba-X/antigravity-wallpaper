import { readFile, readdir, stat, realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);

const customVideoExts = new Set(['.mp4', '.webm', '.m4v', '.mov']);
const customImageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

export function customMediaType(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (customVideoExts.has(ext)) return 'video';
  if (customImageExts.has(ext)) return 'image';
  return null;
}

export function sanitizeCustomTitle(title) {
  const clean = String(title || '').replace(/[\0<>:"/\\|?*]/g, '_').trim().replace(/\.+$/, '');
  if (!clean || clean === '.' || clean === '..') throw Object.assign(new Error('名称不能为空'), { status: 400 });
  return clean;
}

export function sanitizeCustomFilename(filename) {
  const base = path.basename(String(filename || '').replaceAll('\\', '/')).replace(/[\0<>:"/\\|?*]/g, '_').trim();
  if (!base || base === '.' || base === '..') throw Object.assign(new Error('无效的文件名'), { status: 400 });
  if (!customMediaType(base)) throw Object.assign(new Error('仅支持常见视频（mp4/webm/m4v/mov）和图片（jpg/png/webp/gif/bmp）格式'), { status: 400 });
  return base;
}

export function makeCustomWallpaper(directory, filename) {
  const type = customMediaType(filename);
  if (!type) return null;
  return {
    id: `custom-${createHash('sha1').update(`${directory}/${filename}`).digest('hex').slice(0, 12)}`,
    workshopId: null,
    source: 'custom',
    title: path.parse(filename).name,
    type,
    file: filename,
    preview: type === 'image' ? filename : null,
    directory,
  };
}

export function libraryPaths(vdf) {
  return [...vdf.matchAll(/"path"\s*"((?:\\.|[^"\\])*)"/g)]
    .map((match) => match[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'));
}

export async function discoverWorkshopRoots({ steam, libraries = [] } = {}) {
  let steamPath = steam || process.env.STEAM_PATH;
  if (!steamPath && process.platform === 'win32') {
    try {
      const { stdout } = await exec('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
      steamPath = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i)?.[1].trim();
    } catch (error) {
      if (error.code !== 1) throw error;
    }
  }
  const roots = new Set(libraries.map((entry) => path.resolve(entry)));
  if (steamPath) {
    roots.add(path.resolve(steamPath));
    try {
      const vdf = await readFile(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      libraryPaths(vdf).forEach((entry) => roots.add(path.resolve(entry)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const workshops = [];
  for (const root of roots) {
    const workshop = path.basename(root) === '431960' ? root : path.join(root, 'steamapps', 'workshop', 'content', '431960');
    try {
      if ((await stat(workshop)).isDirectory()) workshops.push(await realpath(workshop));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return [...new Set(workshops)];
}

export async function resolveAsset(directory, name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || path.isAbsolute(name)) {
    throw Object.assign(new Error('无效的壁纸文件路径'), { status: 403 });
  }
  const root = await realpath(directory);
  const file = await realpath(path.resolve(root, name.replaceAll('\\', '/')));
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('文件不在壁纸目录内'), { status: 403 });
  }
  return file;
}

export async function scanCustomDirs(customDirs = []) {
  const wallpapers = [];
  const warnings = [];
  const resolvedDirs = [];
  const seenCustom = new Set();
  for (const dir of customDirs) {
    let resolvedDir;
    try {
      resolvedDir = await realpath(dir);
      if (!(await stat(resolvedDir)).isDirectory()) continue;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      warnings.push(`${dir}: ${error.message}`);
      continue;
    }
    if (seenCustom.has(resolvedDir)) continue;
    seenCustom.add(resolvedDir);
    resolvedDirs.push(resolvedDir);
    for (const entry of await readdir(resolvedDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const item = makeCustomWallpaper(resolvedDir, entry.name);
      if (!item) continue;
      wallpapers.push(item);
    }
  }
  return { wallpapers, warnings, customDirs: resolvedDirs };
}

export async function scanLibrary(roots, { customDirs = [] } = {}) {
  const wallpapers = [];
  const warnings = [];
  const counts = {};
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name);
      let project;
      try {
        project = JSON.parse((await readFile(path.join(directory, 'project.json'), 'utf8')).replace(/^\uFEFF/, ''));
      } catch (error) {
        warnings.push(`${entry.name}: ${error.message}`);
        continue;
      }
      const type = String(project.type || 'unknown').toLowerCase();
      counts[type] = (counts[type] || 0) + 1;
      if (!['video', 'web'].includes(type)) continue;
      try {
        const file = await resolveAsset(directory, project.file);
        if (!(await stat(file)).isFile()) throw new Error('入口不是文件');
        let preview = null;
        if (project.preview) {
          try {
            const previewFile = await resolveAsset(directory, project.preview);
            if ((await stat(previewFile)).isFile()) preview = project.preview.replaceAll('\\', '/');
          } catch { /* 预览图缺失不影响入口播放。 */ }
        }
        wallpapers.push({
          id: `${entry.name}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`,
          workshopId: entry.name,
          source: 'workshop',
          title: project.title || entry.name,
          type,
          file: project.file.replaceAll('\\', '/'),
          preview,
          directory,
        });
      } catch (error) {
        warnings.push(`${entry.name}: ${error.message}`);
      }
    }
  }
  const custom = await scanCustomDirs(customDirs);
  warnings.push(...custom.warnings);
  for (const item of custom.wallpapers) {
    counts[item.type] = (counts[item.type] || 0) + 1;
    wallpapers.push(item);
  }
  wallpapers.sort((a, b) => a.title.localeCompare(b.title));
  return { wallpapers, counts, warnings, roots, customDirs: custom.customDirs };
}

export async function allocateCustomPath(customDir, rawFilename) {
  const safe = sanitizeCustomFilename(rawFilename);
  await mkdir(customDir, { recursive: true });
  const dir = await realpath(customDir);
  const { name, ext } = path.parse(safe);
  let candidate = safe;
  let index = 1;
  while (true) {
    const full = path.join(dir, candidate);
    try {
      await stat(full);
      candidate = `${name}-${index++}${ext}`;
    } catch (error) {
      if (error.code === 'ENOENT') return { directory: dir, filename: candidate, fullPath: full };
      throw error;
    }
  }
}

export function publicLibrary(library) {
  return library.wallpapers.map(({ directory, ...wallpaper }) => wallpaper);
}
