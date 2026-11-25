(() => {
  window.__agWallpaperInstall = async function ({ baseUrl, wallpapers: initialWallpapers, darkness = 0.55 }) {
    window.__agWallpaper?.destroy();
    const controller = new AbortController();
    const { signal } = controller;
    let wallpapers = [...initialWallpapers];
    try {
      const response = await fetch(`${baseUrl}/api/wallpapers`, { signal });
      if (response.ok) {
        const latest = await response.json();
        if (Array.isArray(latest.wallpapers)) wallpapers = latest.wallpapers;
      }
    } catch { /* 回退到注入时的初始列表 */ }
    const saved = JSON.parse(localStorage.getItem('ag-wallpaper-settings') || '{}');
    let current = wallpapers.find((item) => item.id === saved.id) || wallpapers.find((item) => item.type === 'video') || wallpapers[0];
    let dim = typeof saved.darkness === 'number' ? Math.min(0.95, Math.max(0, saved.darkness)) : darkness;
    let media;
    let enabled = true;
    let active = true;

    const style = document.createElement('style');
    style.id = 'ag-wallpaper-style';
    style.textContent = `
      html.ag-wallpaper-active, html.ag-wallpaper-active body { background: transparent !important; }
      html.ag-wallpaper-active body > .monaco-workbench { position: relative !important; z-index: 1 !important; }
      html.ag-wallpaper-active body > #root,
      html.ag-wallpaper-active body > #app { position: relative; z-index: 1; isolation:isolate; }
      html.ag-wallpaper-active #root,
      html.ag-wallpaper-active #app,
      html.ag-wallpaper-active .agy-shell,
      html.ag-wallpaper-active .agy-inset-shell,
      html.ag-wallpaper-active .agy-sheet,
      html.ag-wallpaper-active .agy-shell .bg-sidebar:not([role="dialog"]):not([role="menu"]),
      html.ag-wallpaper-active .ag-wallpaper-shell { background-color: transparent !important; }
      html.ag-wallpaper-active .monaco-workbench,
      html.ag-wallpaper-active .monaco-workbench .part,
      html.ag-wallpaper-active .monaco-workbench .editor-container,
      html.ag-wallpaper-active .monaco-workbench .editor-instance,
      html.ag-wallpaper-active .monaco-workbench .monaco-editor,
      html.ag-wallpaper-active .monaco-workbench .monaco-editor-background,
      html.ag-wallpaper-active .monaco-workbench .margin,
      html.ag-wallpaper-active .monaco-workbench .monaco-scrollable-element > .monaco-list-rows,
      html.ag-wallpaper-active .monaco-workbench .terminal-wrapper,
      html.ag-wallpaper-active .monaco-workbench .xterm-viewport,
      html.ag-wallpaper-active .monaco-workbench .pane-body { background-color: transparent !important; }
      html.ag-wallpaper-active .monaco-workbench {
        --vscode-editor-background: transparent !important;
        --vscode-sideBar-background: transparent !important;
        --vscode-panel-background: transparent !important;
        --vscode-terminal-background: transparent !important;
      }
    `;
    document.head.append(style);

    const layer = document.createElement('div');
    layer.id = 'ag-wallpaper-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;background:#10131b;';
    const shade = document.createElement('div');
    shade.style.cssText = 'position:absolute;inset:0;background:#000;pointer-events:none;';
    shade.style.opacity = String(dim);
    layer.append(shade);
    document.body.prepend(layer);
    document.documentElement.classList.add('ag-wallpaper-active');
    // Antigravity 2 的 Hub 使用网页布局；将主体和侧栏的布局祖先设为透明，并在 React 重写 className 后自动恢复。
    const shells = new Set();
    const markShell = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (!node.classList.contains('ag-wallpaper-shell')) node.classList.add('ag-wallpaper-shell');
      shells.add(node);
    };
    const makeShellsTransparent = () => {
      if (!active) return;
      if (!document.documentElement.classList.contains('ag-wallpaper-active')) {
        document.documentElement.classList.add('ag-wallpaper-active');
      }
      const root = document.querySelector('#root, #app');
      if (!root) return;
      for (const node of root.querySelectorAll('main, aside, [role="main"], [role="navigation"]')) {
        let ancestor = node;
        while (ancestor && root.contains(ancestor)) {
          markShell(ancestor);
          if (ancestor === root) break;
          ancestor = ancestor.parentElement;
        }
      }
      // Hub 的部分布局使用无语义 div，覆盖占据大面积的底色容器。
      const minWidth = Math.min(200, innerWidth * 0.2);
      const minHeight = innerHeight * 0.5;
      for (const node of root.querySelectorAll('div')) {
        if (node.classList.contains('ag-wallpaper-shell')) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < minWidth || rect.height < minHeight || node.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]')) continue;
        const background = getComputedStyle(node).backgroundColor;
        if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') {
          markShell(node);
        }
      }
      observer.takeRecords();
    };
    let layoutTimer;
    let layoutFrame;
    const scheduleShellScan = () => {
      if (layoutTimer || layoutFrame) return;
      layoutTimer = setTimeout(() => {
        layoutTimer = null;
        layoutFrame = requestAnimationFrame(() => { layoutFrame = null; makeShellsTransparent(); });
      }, 150);
    };
    const observer = new MutationObserver((mutations) => {
      if (!active) return;
      let needsScan = false;
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const target = mutation.target;
          if (target === document.documentElement) {
            if (!target.classList.contains('ag-wallpaper-active')) target.classList.add('ag-wallpaper-active');
          } else if (shells.has(target) && !target.classList.contains('ag-wallpaper-shell')) {
            target.classList.add('ag-wallpaper-shell');
          } else if (target.nodeType === 1 && !target.classList.contains('ag-wallpaper-shell')) {
            needsScan = true;
          }
        } else if (mutation.type === 'childList') {
          needsScan = true;
        }
      }
      observer.takeRecords();
      if (needsScan) scheduleShellScan();
    });
    makeShellsTransparent();
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    addEventListener('resize', scheduleShellScan, { signal });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        scheduleShellScan();
        if (enabled && media?.tagName === 'VIDEO' && media.paused) media.play().catch(() => {});
      }
    }, { signal });

    const host = document.createElement('div');
    host.id = 'ag-wallpaper-controls';
    host.style.cssText = 'position:fixed;right:18px;bottom:28px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { color-scheme:dark; font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif; color:#f1f2f6; display:flex; flex-direction:column; align-items:flex-end; }
        * { box-sizing:border-box; } button,select,input { font:inherit; }
        button,select { color:inherit;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 11px;transition:background-color .16s ease,border-color .16s ease,color .16s ease; }
        select option { background:#1c1c21; color:#f1f2f6; }
        button { cursor:pointer; } button:hover { background:rgba(255,255,255,.14); border-color:rgba(255,255,255,.2); }
        #toggle {
          width:34px; height:34px; padding:0; border-radius:999px;
          display:inline-flex; align-items:center; justify-content:center;
          background:rgba(24,24,28,.42);
          backdrop-filter:blur(12px) saturate(140%); -webkit-backdrop-filter:blur(12px) saturate(140%);
          border:1px solid rgba(255,255,255,.14);
          color:rgba(255,255,255,.88);
          box-shadow:0 4px 16px rgba(0,0,0,.24);
          opacity:.28;
          transition:opacity .2s ease,transform .2s ease,background-color .2s ease,border-color .2s ease,box-shadow .2s ease;
        }
        #toggle svg { width:16px; height:16px; display:block; }
        #toggle:hover, #toggle:focus-visible, #toggle[aria-expanded="true"] {
          opacity:1;
          background:rgba(32,32,38,.74);
          border-color:rgba(255,255,255,.26);
          color:#fff;
          box-shadow:0 6px 20px rgba(0,0,0,.36);
          outline:none;
        }
        #toggle:hover { transform:translateY(-1px) scale(1.04); }
        #toggle:active { transform:scale(.96); }
        #panel {
          width:320px; padding:18px; margin-bottom:10px;
          border:1px solid rgba(255,255,255,.12); border-radius:14px;
          background:rgba(20,20,24,.78);
          backdrop-filter:blur(20px) saturate(150%); -webkit-backdrop-filter:blur(20px) saturate(150%);
          box-shadow:0 16px 40px rgba(0,0,0,.45);
        }
        [hidden] { display:none !important; } h3 { font-size:14px; font-weight:600; margin:0 0 14px; letter-spacing:.01em; }
        label { display:block; margin:12px 0 6px; color:rgba(255,255,255,.82); } select,input[type=range] { width:100%; }
        input[type=range] { accent-color:#e4e4e7; }
        #status { color:rgba(255,255,255,.56); font-size:12px; margin:12px 0; overflow-wrap:anywhere; }
        .row { display:flex; justify-content:space-between; align-items:center; gap:8px; }
        .actions { display:flex; gap:8px; margin-top:8px; }
        .actions button { flex:1; padding:6px 10px; }
        #open-dir { flex:0 0 auto; }
        #rename-row { display:flex; gap:6px; margin-top:8px; }
        #rename-input { flex:1; min-width:0; color:inherit; background:rgba(0,0,0,.28); border:1px solid rgba(255,255,255,.14); border-radius:8px; padding:6px 10px; }
        #rename-row button { padding:6px 10px; }
        #delete { color:#fca5a5; border-color:rgba(248,113,113,.28); background:rgba(239,68,68,.12); }
        #delete:hover { background:rgba(239,68,68,.22); border-color:rgba(248,113,113,.4); }
        #remove { border:0; background:transparent; color:rgba(255,255,255,.62); }
        #remove:hover { background:rgba(255,255,255,.08); color:#fff; }
      </style>
      <section id="panel" hidden aria-label="壁纸设置">
        <h3>Wallpaper Engine · 本地壁纸</h3>
        <label for="wallpapers">选择壁纸</label><select id="wallpapers"></select>
        <div class="actions">
          <button id="import" type="button">+ 导入视频 / 图片</button>
          <button id="open-dir" type="button">打开目录</button>
        </div>
        <div id="custom-actions" class="actions" hidden>
          <button id="rename" type="button">重命名</button>
          <button id="delete" type="button">删除</button>
        </div>
        <div id="rename-row" hidden>
          <input id="rename-input" type="text" placeholder="输入新名称">
          <button id="rename-save" type="button">保存</button>
          <button id="rename-cancel" type="button">取消</button>
        </div>
        <input id="file-input" type="file" hidden multiple accept=".mp4,.webm,.m4v,.mov,.jpg,.jpeg,.png,.webp,.gif,.bmp">
        <label for="darkness" class="row"><span>暗色遮罩</span><output id="value"></output></label>
        <input id="darkness" type="range" min="0" max="95" step="1">
        <p id="status" role="status"></p>
        <div class="row"><button id="enabled" type="button">暂停壁纸</button><button id="remove" type="button">移除背景</button></div>
      </section>
      <button id="toggle" type="button" aria-expanded="false" aria-label="壁纸设置" title="壁纸设置">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3"/>
          <circle cx="9" cy="10" r="1.5"/>
          <path d="M21 15l-4.5-4.5a1.5 1.5 0 0 0-2.1 0L6 19"/>
        </svg>
      </button>
    `;
    document.body.append(host);
    const select = shadow.querySelector('#wallpapers');
    const slider = shadow.querySelector('#darkness');
    const output = shadow.querySelector('#value');
    const status = shadow.querySelector('#status');
    const panel = shadow.querySelector('#panel');
    const toggle = shadow.querySelector('#toggle');
    const enabledButton = shadow.querySelector('#enabled');
    const removeButton = shadow.querySelector('#remove');
    const importButton = shadow.querySelector('#import');
    const openDirButton = shadow.querySelector('#open-dir');
    const customActions = shadow.querySelector('#custom-actions');
    const renameButton = shadow.querySelector('#rename');
    const deleteButton = shadow.querySelector('#delete');
    const renameRow = shadow.querySelector('#rename-row');
    const renameInput = shadow.querySelector('#rename-input');
    const renameSave = shadow.querySelector('#rename-save');
    const renameCancel = shadow.querySelector('#rename-cancel');
    const fileInput = shadow.querySelector('#file-input');
    const closeRename = () => { renameRow.hidden = true; renameInput.value = ''; };
    const syncSelect = () => {
      select.textContent = '';
      for (const wallpaper of wallpapers) {
        const option = document.createElement('option');
        option.value = wallpaper.id;
        const label = wallpaper.type === 'image' ? 'img' : wallpaper.type;
        option.textContent = `[${label}] ${wallpaper.title}`;
        select.append(option);
      }
      if (current) select.value = current.id;
      customActions.hidden = current?.source !== 'custom';
      if (customActions.hidden) closeRename();
    };
    const refreshWallpapers = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/wallpapers`, { signal });
        if (!response.ok) return;
        const latest = await response.json();
        if (!Array.isArray(latest.wallpapers)) return;
        const prevIds = wallpapers.map((item) => `${item.id}:${item.title}`).join('|');
        const nextIds = latest.wallpapers.map((item) => `${item.id}:${item.title}`).join('|');
        if (prevIds === nextIds) return;
        wallpapers = latest.wallpapers;
        const stillExists = current && wallpapers.find((item) => item.id === current.id);
        if (stillExists) {
          current = stillExists;
          syncSelect();
        } else {
          current = wallpapers.find((item) => item.type === 'video') || wallpapers[0];
          syncSelect(); render(); persist();
        }
      } catch { /* 忽略临时网络错误 */ }
    };
    syncSelect();
    const persist = () => localStorage.setItem('ag-wallpaper-settings', JSON.stringify({ id: current?.id, darkness: dim }));
    const setDarkness = () => {
      shade.style.opacity = String(dim);
      slider.value = String(Math.round(dim * 100));
      output.textContent = `${Math.round(dim * 100)}%`;
    };
    const assetUrl = (wallpaper) => `${baseUrl}/wallpapers/${encodeURIComponent(wallpaper.id)}/${wallpaper.file.split('/').map(encodeURIComponent).join('/')}`;
    function releaseMedia() {
      if (!media) return;
      if (media.tagName === 'VIDEO') { media.pause(); media.removeAttribute('src'); media.load(); }
      media.remove();
      media = null;
    }
    const applyActiveState = (nextActive) => {
      active = nextActive;
      if (active) {
        layer.style.display = '';
        document.documentElement.classList.add('ag-wallpaper-active');
        makeShellsTransparent();
        removeButton.textContent = '移除背景';
        enabledButton.disabled = false;
        render();
      } else {
        releaseMedia();
        layer.style.display = 'none';
        for (const node of shells) node.classList.remove('ag-wallpaper-shell');
        document.documentElement.classList.remove('ag-wallpaper-active');
        removeButton.textContent = '恢复背景';
        enabledButton.disabled = true;
        status.textContent = '已移除背景（点「恢复背景」或切换壁纸即可恢复）';
      }
    };
    function render() {
      releaseMedia();
      customActions.hidden = current?.source !== 'custom';
      if (customActions.hidden) closeRename();
      if (!active || !current || !enabled) return;
      const item = current;
      select.value = item.id;
      status.textContent = item.type === 'video'
        ? `视频 · 静音循环 · ${item.title}`
        : item.type === 'image'
          ? `图片壁纸 · ${item.title}`
          : `网页壁纸 · ${item.title}`;
      const tag = item.type === 'video' ? 'video' : item.type === 'image' ? 'img' : 'iframe';
      media = document.createElement(tag);
      media.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border:0;pointer-events:none;';
      if (item.type === 'video') {
        media.muted = true;
        media.loop = true;
        media.autoplay = true;
        media.playsInline = true;
        media.addEventListener('error', () => { status.textContent = '视频加载失败，请确认本地壁纸服务正在运行或更换视频。'; }, { signal });
        const video = media;
        video.addEventListener('loadeddata', () => { status.textContent = `视频 · 静音循环 · ${item.title}`; }, { signal });
        video.src = assetUrl(item);
        video.play().catch((error) => {
          if (media === video && error.name !== 'AbortError') status.textContent = `播放失败：${error.message}`;
        });
      } else if (item.type === 'image') {
        media.alt = item.title;
        media.decoding = 'async';
        media.addEventListener('error', () => { status.textContent = '图片加载失败，请确认本地壁纸服务正在运行。'; }, { signal });
        media.src = assetUrl(item);
      } else {
        media.title = item.title;
        media.setAttribute('sandbox', 'allow-scripts');
        media.setAttribute('allow', 'autoplay');
        media.src = assetUrl(item);
      }
      layer.prepend(media);
    }
    const setPanelOpen = (open) => {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) void refreshWallpapers();
    };
    toggle.addEventListener('click', () => setPanelOpen(panel.hidden), { signal });
    document.addEventListener('pointerdown', (event) => {
      if (!panel.hidden && !event.composedPath().includes(host)) setPanelOpen(false);
    }, { signal });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden && renameRow.hidden) setPanelOpen(false);
    }, { signal });
    addEventListener('focus', () => { void refreshWallpapers(); }, { signal });
    select.addEventListener('change', () => {
      closeRename();
      current = wallpapers.find((item) => item.id === select.value);
      if (!active) applyActiveState(true);
      else render();
      persist();
    }, { signal });
    importButton.addEventListener('click', () => fileInput.click(), { signal });
    openDirButton.addEventListener('click', async () => {
      try {
        const response = await fetch(`${baseUrl}/api/open-dir`, { method: 'POST', signal });
        if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
        const data = await response.json();
        status.textContent = `已打开壁纸目录：${data.directory}`;
      } catch (error) {
        status.textContent = `打开目录失败：${error.message}`;
      }
    }, { signal });
    renameButton.addEventListener('click', () => {
      if (current?.source !== 'custom') return;
      renameRow.hidden = false;
      renameInput.value = current.title;
      renameInput.focus();
      renameInput.select();
    }, { signal });
    renameCancel.addEventListener('click', closeRename, { signal });
    const submitRename = async () => {
      if (current?.source !== 'custom') return;
      const nextTitle = renameInput.value.trim();
      if (!nextTitle) { status.textContent = '名称不能为空'; return; }
      const target = current;
      renameSave.disabled = true;
      releaseMedia();
      try {
        const response = await fetch(`${baseUrl}/api/wallpapers/${encodeURIComponent(target.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: nextTitle }),
          signal,
        });
        if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
        const data = await response.json();
        wallpapers = data.wallpapers;
        current = wallpapers.find((item) => item.id === data.wallpaper.id) || data.wallpaper;
        closeRename(); syncSelect(); render(); persist();
        status.textContent = `已重命名为：${current.title}`;
      } catch (error) {
        render();
        status.textContent = `重命名失败：${error.message}`;
      } finally {
        renameSave.disabled = false;
      }
    };
    renameSave.addEventListener('click', submitRename, { signal });
    renameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void submitRename(); }
      else if (event.key === 'Escape') { event.preventDefault(); closeRename(); }
    }, { signal });
    fileInput.addEventListener('change', async () => {
      const files = [...(fileInput.files || [])];
      fileInput.value = '';
      if (!files.length) return;
      importButton.disabled = true;
      let imported;
      try {
        for (const file of files) {
          status.textContent = `正在导入：${file.name}…`;
          const response = await fetch(`${baseUrl}/api/import?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            body: file,
            signal,
          });
          if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
          const data = await response.json();
          wallpapers = data.wallpapers;
          imported = data.wallpaper;
        }
        if (imported) {
          current = wallpapers.find((item) => item.id === imported.id) || imported;
          enabled = true;
          enabledButton.textContent = '暂停壁纸';
          syncSelect();
          if (!active) applyActiveState(true);
          else render();
          persist();
        }
      } catch (error) {
        status.textContent = `导入失败：${error.message}`;
      } finally {
        importButton.disabled = false;
      }
    }, { signal });
    deleteButton.addEventListener('click', async () => {
      if (current?.source !== 'custom') return;
      const target = current;
      deleteButton.disabled = true;
      releaseMedia();
      try {
        const response = await fetch(`${baseUrl}/api/wallpapers/${encodeURIComponent(target.id)}`, { method: 'DELETE', signal });
        if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
        const data = await response.json();
        wallpapers = data.wallpapers;
        current = wallpapers.find((item) => item.type === 'video') || wallpapers[0];
        syncSelect(); render(); persist();
        if (!current) status.textContent = '已删除，当前没有可播放壁纸，可点击上方按钮导入。';
      } catch (error) {
        render();
        status.textContent = `删除失败：${error.message}`;
      } finally {
        deleteButton.disabled = false;
      }
    }, { signal });
    slider.addEventListener('input', () => { dim = Number(slider.value) / 100; setDarkness(); persist(); }, { signal });
    enabledButton.addEventListener('click', () => {
      enabled = !enabled;
      enabledButton.textContent = enabled ? '暂停壁纸' : '继续播放';
      render();
      if (!enabled) status.textContent = '壁纸已暂停';
    }, { signal });
    const api = {
      destroy() {
        observer.disconnect(); clearTimeout(layoutTimer); cancelAnimationFrame(layoutFrame);
        for (const node of shells) node.classList.remove('ag-wallpaper-shell');
        controller.abort(); releaseMedia(); layer.remove(); host.remove(); style.remove();
        document.documentElement.classList.remove('ag-wallpaper-active');
        if (window.__agWallpaper === api) delete window.__agWallpaper;
      },
      getState() { return { id: current?.id, darkness: dim, enabled, type: current?.type }; },
    };
    window.__agWallpaper = api;
    removeButton.addEventListener('click', () => applyActiveState(!active), { signal });
    setDarkness(); render();
    if (!current) status.textContent = '没有找到 Video / Web 壁纸，请先订阅并下载对应类型。';
    return { count: wallpapers.length, selected: current?.title };
  };
})();
