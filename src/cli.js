import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { discoverWorkshopRoots, scanLibrary, publicLibrary } from './library.js';
import { createWallpaperServer } from './server.js';
import { getTargets, injectionSource, watchWorkbenches } from './cdp.js';

const defaultCustomDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.local/custom');

const { values } = parseArgs({ options: {
  help: { type: 'boolean', short: 'h' }, list: { type: 'boolean' },
  'serve-only': { type: 'boolean' }, targets: { type: 'boolean' },
  steam: { type: 'string' }, library: { type: 'string', multiple: true },
  custom: { type: 'string', multiple: true },
  port: { type: 'string', default: '32190' }, 'cdp-port': { type: 'string', default: '9222' },
  'target-match': { type: 'string' }, darkness: { type: 'string', default: '0.55' },
  launch: { type: 'boolean' }, exe: { type: 'string' },
  'keep-alive': { type: 'boolean' },
} });

async function main() {
  if (values.help) {
    console.log(`Antigravity Wallpaper\n\n  npm start                         扫描壁纸 + 服务 + 自动连接 CDP\n  npm run list                      列出可播放壁纸\n  npm run preview                   仅启动浏览器预览\n  npm start -- --launch              启动 Antigravity 并开启调试端口\n\n选项：\n  --steam <目录>                    指定 Steam 安装目录\n  --library <目录>                  添加 Steam 库或 431960 目录（可重复）\n  --port <端口>                     本地服务端口，默认 32190\n  --cdp-port <端口>                 调试端口，默认 9222\n  --targets                         列出 CDP 页面\n  --target-match <文字>             按页面 URL/标题选择注入目标\n  --darkness <0..0.95>               首次使用的暗色遮罩，默认 0.55\n  --exe <路径>                      指定 Antigravity.exe\n  --keep-alive                      Antigravity 退出后保持后台服务常驻\n\n使用 --launch 前请从菜单退出已运行的 Antigravity。默认随 Antigravity 退出自动关闭，也可按 Ctrl+C 停止。`);
    return;
  }
  const port = Number(values.port);
  const cdpPort = Number(values['cdp-port']);
  const darkness = Number(values.darkness);
  if (![port, cdpPort].every((value) => Number.isInteger(value) && value > 0 && value <= 65535)) throw new Error('端口应在 1..65535 之间');
  if (!Number.isFinite(darkness) || darkness < 0 || darkness > 0.95) throw new Error('darkness 应在 0..0.95 之间');
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  if (values.targets) { console.table((await getTargets(endpoint)).map(({ id, type, title, url }) => ({ id, type, title, url }))); return; }
  const roots = await discoverWorkshopRoots({ steam: values.steam, libraries: values.library });
  const customDirs = [defaultCustomDir, ...(values.custom || [])];
  const library = await scanLibrary(roots, { customDirs });
  console.log(`壁纸目录：${[...roots, ...library.customDirs].join(', ') || defaultCustomDir}\n可播放 ${library.wallpapers.length} 张；类型统计：${JSON.stringify(library.counts)}`);
  for (const warning of library.warnings) console.warn(`跳过：${warning}`);
  if (values.list) { console.table(publicLibrary(library).map(({ workshopId, source, title, type, file }) => ({ source, workshopId: workshopId || '-', title, type, file }))); return; }
  const connection = { state: values['serve-only'] ? 'preview' : 'waiting' };
  const { server, baseUrl, client } = await createWallpaperServer(library, { port, mode: values['serve-only'] ? 'preview' : 'cdp', connection, customDir: values.custom?.[0] || defaultCustomDir });
  console.log(`预览与本地服务：${baseUrl}`);
  let stopWatching;
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await stopWatching?.(); } catch (error) { console.error(`移除注入：${error.message}`); }
    server.closeAllConnections();
    server.close();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (values['serve-only']) return;
  if (values.launch) {
    const exe = values.exe || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'Antigravity.exe');
    if (!existsSync(exe)) { await shutdown(); throw new Error(`找不到 ${exe}，请用 --exe 指定`); }
    const child = spawn(exe, [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', (error) => { console.error(`启动失败：${error.message}`); void shutdown(); });
    child.unref();
  }
  console.log(`连接 ${endpoint}；如果客户端已在运行但没开调试端口，请退出后执行 npm start -- --launch。`);
  stopWatching = await watchWorkbenches({
    endpoint,
    targetMatch: values['target-match'],
    source: injectionSource(client, { baseUrl, wallpapers: publicLibrary(library), darkness }),
    onStatus(message) { connection.message = message; connection.state = message.startsWith('已') ? 'connected' : 'waiting'; console.log(message); },
    onDisconnect: values['keep-alive'] ? undefined : shutdown,
  });
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
