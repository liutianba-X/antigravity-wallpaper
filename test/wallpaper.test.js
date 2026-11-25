import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverWorkshopRoots, libraryPaths, scanLibrary } from '../src/library.js';
import { createWallpaperServer, parseRange } from '../src/server.js';
import { isWorkbench, injectionSource } from '../src/cdp.js';

test('Steam 多库路径解析', () => {
  assert.deepEqual(libraryPaths(String.raw`"libraryfolders" { "0" { "path" "D:\\Steam" } "1" { "path" "E:\\SteamLibrary" } }`), ['D:\\Steam', 'E:\\SteamLibrary']);
});

test('视频 Range：完整、开放、后缀和越界', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=8-100', 10), { start: 8, end: 9 });
  for (const header of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5']) assert.equal(parseRange(header, 10), null);
});

test('识别 Antigravity 2 Hub / IDE，排除其他页面', () => {
  const page = { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/test', title: 'Antigravity' };
  assert.ok(isWorkbench({ ...page, url: 'https://127.0.0.1:54321/' }));
  assert.ok(isWorkbench({ ...page, url: 'https://127.0.0.1:54321/c/conversation-id' }));
  assert.ok(isWorkbench({ ...page, title: 'New Conversation', url: 'https://127.0.0.1:54321/c/conversation-id' }));
  assert.ok(isWorkbench({ ...page, url: 'vscode-file://vscode-app/out/vs/code/electron-browser/workbench/workbench.html' }));
  assert.equal(isWorkbench({ ...page, url: 'https://example.com' }), false);
  assert.equal(isWorkbench({ ...page, title: 'Preview', url: 'https://127.0.0.1:54321/preview' }), false);
  assert.ok(isWorkbench({ ...page, url: 'http://localhost/test' }, 'Antigravity'));
  assert.doesNotThrow(() => new Function(injectionSource('', { baseUrl: 'http://127.0.0.1:32190', wallpapers: [] })));
});

test('扫描、本地文件服务、视频分片、Web 相对资源与路径隔离', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ag-wallpaper-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workshop = path.join(temp, 'steamapps', 'workshop', 'content', '431960');
  for (const [id, project, files] of [
    ['101', { title: 'Video', type: 'Video', file: '视频 clip.mp4' }, { '视频 clip.mp4': '0123456789' }],
    ['102', { title: 'Web', type: 'web', file: 'index.html' }, { 'index.html': '<script src="app.js"></script>', 'app.js': 'window.ready=true' }],
    ['103', { title: 'Scene No Preview', type: 'scene', file: 'scene.pkg' }, {}],
    ['104', { title: 'Missing', type: 'video', file: 'missing.mp4' }, {}],
    ['105', { title: 'Scene With Preview', type: 'scene', file: 'scene.pkg', preview: 'preview.gif' }, { 'preview.gif': 'GIF89a' }],
  ]) {
    const directory = path.join(workshop, id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'project.json'), JSON.stringify(project));
    for (const [name, data] of Object.entries(files)) await writeFile(path.join(directory, name), data);
  }
  const roots = await discoverWorkshopRoots({ steam: temp });
  assert.equal(roots.length, 1);
  const customDir = path.join(temp, 'custom');
  await mkdir(customDir, { recursive: true });
  await writeFile(path.join(customDir, 'bg.png'), 'PNGDATA');
  const library = await scanLibrary(roots, { customDirs: [customDir] });
  assert.equal(library.wallpapers.length, 3);
  assert.deepEqual(library.counts, { video: 2, web: 1, scene: 2, image: 1 });
  assert.equal(library.warnings.length, 1);
  let openedDir = null;
  const { server, baseUrl } = await createWallpaperServer(library, { port: 0, customDir, onOpenDir: (dir) => { openedDir = dir; } });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.deepEqual(await (await fetch(`${baseUrl}/api/status`)).json(), { app: 'antigravity-wallpaper', mode: 'preview', connection: {} });
  const openDirRes = await fetch(`${baseUrl}/api/open-dir`, { method: 'POST' });
  assert.equal(openDirRes.status, 200);
  assert.equal(openedDir, customDir);
  const catalog = await (await fetch(`${baseUrl}/api/wallpapers`)).json();
  assert.equal(catalog.wallpapers.length, 3);
  assert.equal(catalog.wallpapers.some((item) => item.type === 'scene'), false);
  const img = catalog.wallpapers.find((item) => item.type === 'image');
  assert.equal(img?.source, 'custom');
  assert.equal(await (await fetch(`${baseUrl}/wallpapers/${img.id}/${img.file}`)).text(), 'PNGDATA');

  // 导入自定义视频与图片，并校验删除权限
  const importedRes = await fetch(`${baseUrl}/api/import?name=${encodeURIComponent('风景.mp4')}`, { method: 'POST', body: 'MP4DATA' });
  assert.equal(importedRes.status, 201);
  const imported = await importedRes.json();
  assert.equal(imported.wallpaper.source, 'custom');
  assert.equal(imported.wallpaper.type, 'video');
  assert.equal(imported.wallpapers.length, 4);
  assert.equal(await (await fetch(`${baseUrl}/wallpapers/${imported.wallpaper.id}/${encodeURIComponent(imported.wallpaper.file)}`)).text(), 'MP4DATA');

  const badImport = await fetch(`${baseUrl}/api/import?name=notes.txt`, { method: 'POST', body: 'nope' });
  assert.equal(badImport.status, 400);

  const workshopItem = catalog.wallpapers.find((item) => item.source === 'workshop');
  assert.equal((await fetch(`${baseUrl}/api/wallpapers/${workshopItem.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x' }) })).status, 403);
  const renameRes = await fetch(`${baseUrl}/api/wallpapers/${imported.wallpaper.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '我的雪景' }),
  });
  assert.equal(renameRes.status, 200);
  const renamed = await renameRes.json();
  assert.equal(renamed.wallpaper.title, '我的雪景');
  assert.equal(renamed.wallpaper.file, '我的雪景.mp4');
  assert.equal(await (await fetch(`${baseUrl}/wallpapers/${renamed.wallpaper.id}/${encodeURIComponent(renamed.wallpaper.file)}`)).text(), 'MP4DATA');

  assert.equal((await fetch(`${baseUrl}/api/wallpapers/${workshopItem.id}`, { method: 'DELETE' })).status, 403);
  const delRes = await fetch(`${baseUrl}/api/wallpapers/${renamed.wallpaper.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.equal((await delRes.json()).wallpapers.length, 3);

  // 外部直接从目录删除文件后，/api/wallpapers 应实时同步移除
  await rm(path.join(customDir, 'bg.png'));
  const synced = await (await fetch(`${baseUrl}/api/wallpapers`)).json();
  assert.equal(synced.wallpapers.length, 2);
  assert.equal(synced.wallpapers.some((item) => item.file === 'bg.png'), false);
  assert.equal(catalog.wallpapers[0].directory, undefined);
  const video = catalog.wallpapers.find((item) => item.type === 'video');
  const url = `${baseUrl}/wallpapers/${video.id}/${encodeURIComponent(video.file)}`;
  const partial = await fetch(url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(partial.headers.get('content-type'), 'video/mp4');
  assert.equal(await partial.text(), '2345');
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  const badRange = await fetch(url, { headers: { Range: 'bytes=99-' } });
  assert.equal(badRange.status, 416);
  const web = catalog.wallpapers.find((item) => item.type === 'web');
  assert.equal(await (await fetch(`${baseUrl}/wallpapers/${web.id}/app.js`)).text(), 'window.ready=true');
  assert.equal((await fetch(`${baseUrl}/wallpapers/${web.id}/..%5C101%5Cproject.json`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/wallpapers/${web.id}/missing.js`)).status, 404);
  const options = await fetch(url, { method: 'OPTIONS' });
  assert.equal(options.headers.get('access-control-allow-private-network'), 'true');
  assert.ok((await (await fetch(baseUrl)).text()).includes('壁纸预览'));
});
