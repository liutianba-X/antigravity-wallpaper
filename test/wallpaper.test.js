import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { discoverWorkshopRoots, libraryPaths, scanLibrary } from '../src/library.js';
import { createWallpaperServer, parseRange } from '../src/server.js';
import { isWorkbench, injectionSource, watchWorkbenches } from '../src/cdp.js';

test('Steam 多库路径解析', () => {
  assert.deepEqual(libraryPaths(String.raw`"libraryfolders" { "0" { "path" "D:\\Steam" } "1" { "path" "E:\\SteamLibrary" } }`), ['D:\\Steam', 'E:\\SteamLibrary']);
});

test('视频 Range：完整、开放、分片上限、后缀和越界', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(parseRange('bytes=0-', 20 * 1024 * 1024), { start: 0, end: 4 * 1024 * 1024 - 1 });
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
  assert.ok(head.headers.get('etag'));
  assert.equal(head.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(await head.text(), '');
  const notModified = await fetch(url, { headers: { 'If-None-Match': head.headers.get('etag') } });
  assert.equal(notModified.status, 304);
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

test('客户端视频进度条、声音控制与暂停恢复逻辑', async () => {
  const clientCode = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(injectionSource(clientCode, { baseUrl: 'http://127.0.0.1:32190', wallpapers: [] })));

  class FakeElement extends EventTarget {
    constructor(tagName) {
      super();
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.style = { cssText: '', opacity: '', display: '' };
      this.attributes = new Map();
      this.children = [];
      this.classList = {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      };
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.value = '';
      this.textContent = '';
      this.innerHTML = '';
      this.max = '0';
      this.muted = false;
      this.volume = 1;
      this.loop = false;
      this.autoplay = false;
      this.playsInline = false;
      this.paused = true;
      this.currentTime = 0;
      this.duration = NaN;
      this.src = '';
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k); }
    removeAttribute(k) { this.attributes.delete(k); if (k === 'src') this.src = ''; }
    append(...nodes) { this.children.push(...nodes); }
    prepend(...nodes) { this.children.unshift(...nodes); }
    remove() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    getBoundingClientRect() { return { width: 0, height: 0 }; }
    click() { this.dispatchEvent(new Event('click')); }
    focus() {}
    select() {}
    load() {}
    pause() { this.paused = true; }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    attachShadow() {
      const elements = new Map();
      const make = (id, tag = 'div') => {
        const el = new FakeElement(tag);
        el.id = id;
        elements.set(`#${id}`, el);
        return el;
      };
      for (const [id, tag] of [
        ['wallpapers', 'select'], ['darkness', 'input'], ['value', 'output'],
        ['status', 'p'], ['panel', 'section'], ['toggle', 'button'],
        ['enabled', 'button'], ['remove', 'button'], ['import', 'button'],
        ['open-dir', 'button'], ['custom-actions', 'div'], ['rename', 'button'],
        ['delete', 'button'], ['rename-row', 'div'], ['rename-input', 'input'],
        ['rename-save', 'button'], ['rename-cancel', 'button'], ['file-input', 'input'],
        ['video-controls', 'div'], ['show-progress', 'input'], ['progress-wrap', 'div'],
        ['progress', 'input'], ['time-current', 'span'], ['time-duration', 'span'],
        ['mute', 'button'], ['volume', 'input'], ['volume-value', 'output'],
      ]) make(id, tag);
      this._shadowElements = elements;
      return {
        innerHTML: '',
        querySelector: (selector) => elements.get(selector) || null,
      };
    }
  }

  const storage = new Map();
  const createdVideos = [];
  const docTarget = new EventTarget();
  const document = {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    visibilityState: 'visible',
    createElement(tag) {
      const el = new FakeElement(tag);
      if (tag === 'video') createdVideos.push(el);
      return el;
    },
    querySelector() { return null; },
    addEventListener: docTarget.addEventListener.bind(docTarget),
  };
  const winTarget = new EventTarget();
  const sandbox = {
    window: null,
    document,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    fetch: () => Promise.reject(new Error('offline')),
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    AbortController,
    Event,
    innerWidth: 1280,
    innerHeight: 720,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: () => ({ backgroundColor: 'transparent' }),
    addEventListener: winTarget.addEventListener.bind(winTarget),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(clientCode, sandbox);

  const wallpapers = [
    { id: 'v1', source: 'custom', title: 'Demo Video', type: 'video', file: 'demo.mp4' },
    { id: 'i1', source: 'custom', title: 'Demo Image', type: 'image', file: 'demo.png' },
  ];
  await sandbox.__agWallpaperInstall({ baseUrl: 'http://127.0.0.1:32190', wallpapers });

  const host = document.body.children.find((el) => el.id === 'ag-wallpaper-controls');
  const ui = host._shadowElements;
  const video = createdVideos[0];
  assert.ok(video);
  assert.equal(ui.get('#video-controls').hidden, false);
  assert.equal(ui.get('#progress-wrap').hidden, false);
  assert.equal(video.muted, true);

  // 元数据加载后，进度条启用并同步时长与当前进度
  video.duration = 125;
  video.currentTime = 12;
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(ui.get('#progress').disabled, false);
  assert.equal(ui.get('#time-duration').textContent, '02:05');
  assert.equal(ui.get('#time-current').textContent, '00:12');

  // 拖动进度条时仅预览时间，松手（pointerup -> change）后才跳转并保持播放
  ui.get('#progress').dispatchEvent(new Event('pointerdown'));
  ui.get('#progress').value = '65';
  ui.get('#progress').dispatchEvent(new Event('input'));
  assert.equal(video.currentTime, 12);
  assert.equal(ui.get('#time-current').textContent, '01:05');
  winTarget.dispatchEvent(new Event('pointerup'));
  assert.equal(ui.get('#progress').value, '65');
  video.paused = true;
  ui.get('#progress').dispatchEvent(new Event('change'));
  assert.equal(video.currentTime, 65);
  assert.equal(video.paused, false);
  video.dispatchEvent(new Event('seeked'));
  assert.equal(ui.get('#time-current').textContent, '01:05');

  // 取消勾选「显示进度条」可隐藏进度栏并持久化
  ui.get('#show-progress').checked = false;
  ui.get('#show-progress').dispatchEvent(new Event('change'));
  assert.equal(ui.get('#progress-wrap').hidden, true);
  assert.equal(JSON.parse(storage.get('ag-wallpaper-settings')).showProgress, false);

  // 点击静音按钮开启声音，并调节音量
  ui.get('#mute').click();
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0.6);
  ui.get('#volume').value = '35';
  ui.get('#volume').dispatchEvent(new Event('input'));
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0.35);
  assert.equal(ui.get('#volume-value').textContent, '35%');

  // 暂停与继续视频保留当前播放进度，不重建 video 元素
  ui.get('#enabled').click();
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 65);
  assert.equal(createdVideos.length, 1);
  ui.get('#enabled').click();
  assert.equal(video.paused, false);
  assert.equal(createdVideos.length, 1);

  // 切换到图片壁纸时隐藏视频控制区
  ui.get('#wallpapers').value = 'i1';
  ui.get('#wallpapers').dispatchEvent(new Event('change'));
  assert.equal(ui.get('#video-controls').hidden, true);

  sandbox.__agWallpaper.destroy();
});

test('Antigravity CDP 端口关闭后自动触发退出回调', async (t) => {
  const mockCdp = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => mockCdp.listen(0, '127.0.0.1', resolve));
  const { port } = mockCdp.address();
  let disconnected = false;
  let resolveDisconnect;
  const disconnectedPromise = new Promise((resolve) => { resolveDisconnect = resolve; });
  let resolveConnected;
  const connectedPromise = new Promise((resolve) => { resolveConnected = resolve; });

  const stop = await watchWorkbenches({
    endpoint: `http://127.0.0.1:${port}`,
    source: '',
    pollIntervalMs: 30,
    disconnectThreshold: 2,
    onStatus(message) {
      if (message.includes('调试端口可用')) resolveConnected();
    },
    onDisconnect() {
      disconnected = true;
      resolveDisconnect();
    },
  });
  t.after(async () => {
    mockCdp.closeAllConnections();
    mockCdp.close();
    await stop();
  });

  await connectedPromise;
  assert.equal(disconnected, false);
  mockCdp.closeAllConnections();
  await new Promise((resolve) => mockCdp.close(resolve));
  await disconnectedPromise;
  assert.equal(disconnected, true);
});
