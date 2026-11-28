import { EventEmitter } from 'node:events';

export class CdpSession extends EventEmitter {
  #nextId = 0;
  #pending = new Map();
  constructor(socket) {
    super();
    this.socket = socket;
    socket.addEventListener('message', ({ data }) => {
      if (this.#pending.size === 0) return;
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP 连接已关闭')); }
      this.#pending.clear();
      this.emit('disconnected');
    });
    socket.addEventListener('error', () => {});
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('CDP 连接超时')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    return new CdpSession(socket);
  }
  send(method, params = {}) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 10000);
      this.#pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

export async function getTargets(endpoint) {
  const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`CDP 返回 HTTP ${response.status}`);
  return response.json();
}

export function isWorkbench(target, targetMatch) {
  if (target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  let url;
  try { url = new URL(target.url || 'about:blank'); } catch { return false; }
  const hub = url.protocol === 'https:' && url.hostname === '127.0.0.1'
    && (url.pathname === '/' || /^\/c(?:\/|$)/.test(url.pathname) || target.title?.includes('Antigravity'));
  return targetMatch ? `${target.title} ${target.url}`.toLowerCase().includes(targetMatch.toLowerCase()) : hub || /workbench(?:\.html|[-./])/i.test(target.url);
}

export async function watchWorkbenches({ endpoint, source, targetMatch, onStatus = console.log, onDisconnect, disconnectThreshold = 2, pollIntervalMs = 2500 }) {
  const sessions = new Map();
  let stopped = false;
  let timer;
  let lastStatus;
  let hasConnected = false;
  let missedPolls = 0;
  const status = (message) => { if (lastStatus !== message) { onStatus(message); lastStatus = message; } };
  async function poll() {
    if (stopped) return;
    try {
      const allTargets = await getTargets(endpoint);
      hasConnected = true;
      missedPolls = 0;
      const targets = allTargets.filter((target) => isWorkbench(target, targetMatch));
      for (const target of targets) {
        if (stopped || sessions.has(target.id)) continue;
        const cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
        if (stopped) { cdp.close(); break; }
        sessions.set(target.id, cdp);
        cdp.once('disconnected', () => sessions.delete(target.id));
        try {
          await cdp.send('Page.enable');
          await cdp.send('Page.setBypassCSP', { enabled: true });
          const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
          cdp.scriptIdentifier = identifier;
          const result = await cdp.send('Runtime.evaluate', { expression: source, awaitPromise: true, returnByValue: true });
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
          onStatus(`已注入：${target.title}（${result.result?.value?.selected || '暂无可播放壁纸'}）`);
        } catch (error) {
          cdp.close(); sessions.delete(target.id); throw error;
        }
      }
      status(targets.length ? `已连接 ${targets.length} 个工作台，刷新页面后会自动恢复。` : '调试端口可用，等待 Antigravity 工作台页面…');
    } catch (error) {
      if (hasConnected && onDisconnect) {
        missedPolls += 1;
        if (missedPolls >= disconnectThreshold) {
          status(`Antigravity 调试端口 ${endpoint} 已关闭，壁纸服务自动退出。`);
          stopped = true;
          clearTimeout(timer);
          void onDisconnect();
          return;
        }
      }
      status(`等待 Antigravity 调试端口 ${endpoint}（${error.message}）`);
    }
    const nextDelay = sessions.size > 0 && pollIntervalMs === 2500 ? 5000 : pollIntervalMs;
    if (!stopped) timer = setTimeout(poll, nextDelay);
  }
  void poll();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    const results = await Promise.allSettled([...sessions.values()].map(async (cdp) => {
      try {
        if (cdp.scriptIdentifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: cdp.scriptIdentifier });
        await cdp.send('Runtime.evaluate', { expression: 'window.__agWallpaper?.destroy(); delete window.__agWallpaperInstall;' });
        await cdp.send('Page.setBypassCSP', { enabled: false });
      } finally { cdp.close(); }
    }));
    for (const result of results) if (result.status === 'rejected') onStatus(`移除注入失败：${result.reason.message}`);
  };
}

export function injectionSource(client, options) {
  return `(() => { if (window.top !== window) return; const install = async () => { ${client}\nreturn window.__agWallpaperInstall(${JSON.stringify(options)}); }; if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => install().catch(console.error), { once: true }); return 'scheduled'; } return install(); })()`;
}
