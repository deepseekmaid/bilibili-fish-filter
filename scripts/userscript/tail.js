  /* ======================= 油猴适配层（构建注入） ======================= */

  const BAF_STORE_KEY = 'baf.settings.v1';

  function storeGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        const value = GM_getValue(key, fallback);
        return value === undefined ? fallback : value;
      }
      const raw = localStorage.getItem('baf:' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, value);
      else localStorage.setItem('baf:' + key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }

  function loadSettings() {
    try {
      const stored = storeGet(BAF_STORE_KEY, null);
      Object.assign(settings, normalize(stored && typeof stored === 'object' ? stored : {}));
      schedule();
      maybeAutoLoad();
    } catch (error) {
      console.warn('[大肥鱼过滤器] 读取设置失败，使用默认值', error);
    }
  }

  function applySettings(patch) {
    const next = normalize({ ...settings, ...patch });
    const autoChanged = next.autoLoad !== settings.autoLoad;
    Object.assign(settings, next);
    storeSet(BAF_STORE_KEY, next);
    // 只有「自动加载」开关变化才需要重排加载；其它规则改动直接重扫即可，
    // 否则每点一下开关都会把正在进行的加载重新开始。
    if (autoChanged) resetAuto();
    else schedule();
    return next;
  }

  /* ============ 面板：直接复用扩展弹窗的 HTML / CSS / JS ============ */

  const PANEL_CHROME_STYLE = [
    '.baf-window { position: fixed; right: 18px; bottom: 78px; width: 328px; max-height: calc(100vh - 120px);',
    '  overflow: auto; border-radius: 14px; box-shadow: 0 18px 40px rgba(15,23,42,.20); z-index: 2147483000; }',
    '.baf-window[hidden] { display: none; }',
    '.baf-window .baf-popup { border-radius: 14px; overflow: hidden; border: 1px solid #e5eaf3; }',
    '.baf-fab { position: fixed; right: 18px; bottom: 18px; width: 46px; height: 46px; border-radius: 50%;',
    '  border: 0; padding: 0; cursor: grab; background-color: #4d6bfe; background-size: cover;',
    '  background-position: center; background-repeat: no-repeat; color: #fff;',
    '  box-shadow: 0 6px 18px rgba(77,107,254,.45); z-index: 2147483000;',
    '  touch-action: none; user-select: none; will-change: transform; }',
    '.baf-fab:hover { box-shadow: 0 10px 24px rgba(77,107,254,.55); }',
    '.baf-fab.is-dragging { cursor: grabbing; box-shadow: 0 14px 30px rgba(77,107,254,.55); }',
    // 面板可拖动：顶栏作为拖拽把手
    '.baf-window { will-change: transform; }',
    '.baf-window .baf-popup header { cursor: grab; user-select: none; touch-action: none; }',
    '.baf-window .baf-popup header .baf-grip { display: inline-flex; align-items: center; justify-content: center;',
    '  width: 16px; height: 18px; margin-right: 2px; color: #b3b9c4; font-size: 13px; line-height: 1; }',
    '.baf-window.is-dragging .baf-popup header { cursor: grabbing; }',
    '.baf-window.is-dragging { box-shadow: 0 24px 60px rgba(15,23,42,.28); }',
  ].join('\n');

  let fabEl = null;

  let panelHost = null;
  let panelShadow = null;
  let panelWindow = null;
  let panelOpen = false;
  let panelDragging = false;
  let fabDragging = false;

  function ensureHost() {
    if (panelHost) return;
    panelHost = document.createElement('div');
    panelHost.id = 'baf-userscript-panel';
    panelShadow = panelHost.attachShadow({ mode: 'open' });
    panelShadow.innerHTML = '<style>' + PANEL_CSS + '</style>'
      + '<style>' + PANEL_CHROME_STYLE + '</style>'
      + '<div class="baf-window" hidden></div>'
      + '<button class="baf-fab" type="button" title="B站大肥鱼过滤器设置（拖动可移动）"></button>';
    document.documentElement.appendChild(panelHost);
    panelWindow = panelShadow.querySelector('.baf-window');
    fabEl = panelShadow.querySelector('.baf-fab');
    fabEl.style.backgroundImage = 'url("' + FAB_ICON + '")';
    makeFabDraggable();
    restoreFabOffset();
  }

  function togglePanel() {
    ensureHost();
    panelOpen = !panelOpen;
    panelWindow.hidden = !panelOpen;
    if (panelOpen) refreshOpenPanel();
  }

  function chromeForPanel() {
    return {
      runtime: {
        getManifest: () => ({ version: BAF_VERSION, version_name: BAF_VERSION_NAME }),
        lastError: undefined,
      },
      storage: {
        sync: {
          get: (defaults, cb) => cb({ ...defaults, ...settings }),
          set: (patch, cb) => {
            applySettings(patch);
            if (typeof cb === 'function') cb();
          },
        },
      },
      tabs: {
        query: (query, cb) => cb([{ id: 0 }]),
        sendMessage: (id, message, cb) => cb(stats()),
      },
    };
  }

  // 位置用「相对默认锚点的位移」表示，靠 transform 移动。
  // 不用 left/top：页面若在 html/body 上有 transform，fixed 定位会被限制在
  // 那个包含块里，left/top 会和视觉位置对不上，拖动看起来像没反应。
  const PANEL_POS_KEY = 'baf.panel.pos.v2';
  let panelOffset = { x: 0, y: 0 };

  function applyPanelOffset(x, y) {
    panelOffset = { x: Math.round(x), y: Math.round(y) };
    panelWindow.style.transform = 'translate3d(' + panelOffset.x + 'px,' + panelOffset.y + 'px,0)';
  }

  function clampOffset(x, y, baseLeft, baseTop) {
    const rect = panelWindow.getBoundingClientRect();
    const width = rect.width || 328;
    const height = rect.height || 420;
    const margin = 8;
    const minX = margin - baseLeft;
    const maxX = Math.max(minX, window.innerWidth - width - margin - baseLeft);
    const minY = margin - baseTop;
    const maxY = Math.max(minY, window.innerHeight - height - margin - baseTop);
    return {
      x: Math.min(Math.max(minX, x), maxX),
      y: Math.min(Math.max(minY, y), maxY),
    };
  }

  /** 当前 transform 为 0 时元素应在的位置（视口坐标）。 */
  function panelBase() {
    const rect = panelWindow.getBoundingClientRect();
    return { left: rect.left - panelOffset.x, top: rect.top - panelOffset.y };
  }

  function restorePanelOffset() {
    const saved = storeGet(PANEL_POS_KEY, null);
    if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return false;
    const base = panelBase();
    const pos = clampOffset(saved.x, saved.y, base.left, base.top);
    applyPanelOffset(pos.x, pos.y);
    return true;
  }

  /** 没手动摆过面板时，让它出现在悬浮球上方，右下角对齐。 */
  function placePanelNearFab() {
    if (!panelWindow || !fabEl) return;
    const fabRect = fabEl.getBoundingClientRect();
    const panelRect = panelWindow.getBoundingClientRect();
    const base = panelBase();
    const targetLeft = fabRect.right - panelRect.width;
    const targetTop = fabRect.top - panelRect.height - 12;
    const pos = clampOffset(targetLeft - base.left, targetTop - base.top, base.left, base.top);
    applyPanelOffset(pos.x, pos.y);
  }

  // 交互控件不参与拖动，避免点开关时把面板拖走
  const NO_DRAG_SEL = 'button, input, label, select, textarea, a, .seg, .sw, [data-no-drag]';
  const DRAG_USE_POINTER = typeof window.PointerEvent === 'function';
  const DRAG_DOWN = DRAG_USE_POINTER ? 'pointerdown' : 'mousedown';
  const DRAG_MOVE = DRAG_USE_POINTER ? 'pointermove' : 'mousemove';
  const DRAG_UP = DRAG_USE_POINTER ? 'pointerup' : 'mouseup';

  /** 按住面板任意空白处（顶栏、标题、底部留白）即可拖动；位移存进 GM 存储。 */
  function makePanelDraggable() {
    if (!panelWindow || panelWindow.dataset.bafDrag === '1') return;
    panelWindow.dataset.bafDrag = '1';

    const header = panelWindow.querySelector('.baf-popup header');
    if (header && !header.querySelector('.baf-grip')) {
      const grip = document.createElement('span');
      grip.className = 'baf-grip';
      grip.textContent = '⠿';
      grip.title = '拖动面板';
      header.insertBefore(grip, header.firstChild);
    }

    const isInteractive = (target) => {
      if (!target || typeof target.closest !== 'function') return false;
      return Boolean(target.closest(NO_DRAG_SEL));
    };

    panelWindow.addEventListener(DRAG_DOWN, (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (panelDragging) return;
      if (isInteractive(event.target)) return;

      // 拖动期间不要选中页面文字
      const prevUserSelect = document.documentElement.style.userSelect;
      document.documentElement.style.userSelect = 'none';
      event.preventDefault();

      const base = panelBase();
      const startX = event.clientX;
      const startY = event.clientY;
      const start = { x: panelOffset.x, y: panelOffset.y };
      panelWindow.classList.add('is-dragging');

      const onMove = (moveEvent) => {
        const next = clampOffset(
          start.x + (moveEvent.clientX - startX),
          start.y + (moveEvent.clientY - startY),
          base.left,
          base.top,
        );
        applyPanelOffset(next.x, next.y);
      };
      panelDragging = true;
      const finish = () => {
        document.removeEventListener(DRAG_MOVE, onMove, true);
        document.removeEventListener(DRAG_UP, finish, true);
        document.removeEventListener('pointercancel', finish, true);
        document.removeEventListener('blur', finish, true);
        document.documentElement.style.userSelect = prevUserSelect;
        panelWindow.classList.remove('is-dragging');
        panelDragging = false;
        storeSet(PANEL_POS_KEY, { x: panelOffset.x, y: panelOffset.y });
      };
      // 窗口失焦时 pointerup 可能收不到，直接收尾，避免卡在拖拽态
      document.addEventListener('blur', finish, true);

      // 用捕获阶段监听：页面自己的 pointermove 处理不会把事件吃掉
      document.addEventListener(DRAG_MOVE, onMove, true);
      document.addEventListener(DRAG_UP, finish, true);
      document.addEventListener('pointercancel', finish, true);
    });
  }

  const FAB_POS_KEY = 'baf.fab.pos.v1';
  let fabOffset = { x: 0, y: 0 };

  function applyFabOffset(x, y) {
    fabOffset = { x: Math.round(x), y: Math.round(y) };
    fabEl.style.transform = 'translate3d(' + fabOffset.x + 'px,' + fabOffset.y + 'px,0)';
  }

  function fabBase() {
    const rect = fabEl.getBoundingClientRect();
    return {
      left: rect.left - fabOffset.x,
      top: rect.top - fabOffset.y,
      width: rect.width,
      height: rect.height,
    };
  }

  function clampFabOffset(x, y, base) {
    const size = base.width || 46;
    const margin = 8;
    const minX = margin - base.left;
    const maxX = Math.max(minX, window.innerWidth - size - margin - base.left);
    const minY = margin - base.top;
    const maxY = Math.max(minY, window.innerHeight - size - margin - base.top);
    return {
      x: Math.min(Math.max(minX, x), maxX),
      y: Math.min(Math.max(minY, y), maxY),
    };
  }

  function restoreFabOffset() {
    const saved = storeGet(FAB_POS_KEY, null);
    if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return;
    const base = fabBase();
    const pos = clampFabOffset(saved.x, saved.y, base);
    applyFabOffset(pos.x, pos.y);
  }

  /** 悬浮球可拖动：拖动只移动它，轻点才开合面板。 */
  function makeFabDraggable() {
    if (!fabEl || fabEl.dataset.bafDrag === '1') return;
    fabEl.dataset.bafDrag = '1';

    fabEl.addEventListener(DRAG_DOWN, (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (fabDragging) return;
      event.preventDefault();

      const base = fabBase();
      const startX = event.clientX;
      const startY = event.clientY;
      const start = { x: fabOffset.x, y: fabOffset.y };
      let moved = false;

      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true;
        fabEl.classList.add('is-dragging');
        const next = clampFabOffset(start.x + dx, start.y + dy, base);
        applyFabOffset(next.x, next.y);
      };
      fabDragging = true;
      const finish = (upEvent) => {
        document.removeEventListener(DRAG_MOVE, onMove, true);
        document.removeEventListener(DRAG_UP, finish, true);
        document.removeEventListener('pointercancel', finish, true);
        document.removeEventListener('blur', finish, true);
        fabDragging = false;
        fabEl.classList.remove('is-dragging');
        if (moved) {
          storeSet(FAB_POS_KEY, fabOffset);
          return;
        }
        // 没移动就是一次轻点：在球上松手就开合面板，不需要等
        const path = upEvent && typeof upEvent.composedPath === 'function' ? upEvent.composedPath() : [];
        // 在 shadow DOM 外看，事件 target 会被重定向到宿主元素，所以两种都要认
        const onFab = (upEvent && upEvent.target === fabEl)
          || path.includes(fabEl)
          || path.includes(panelHost);
        if (onFab) togglePanel();
      };

      document.addEventListener(DRAG_MOVE, onMove, true);
      document.addEventListener(DRAG_UP, finish, true);
      document.addEventListener('pointercancel', finish, true);
      document.addEventListener('blur', finish, true);
    });

    fabEl.addEventListener('click', (event) => {
      // 鼠标的点击已在 pointerup 里判定；这里只接键盘触发的 click（detail 为 0）
      if (event.detail === 0) togglePanel();
    });
  }

  function refreshOpenPanel() {
    if (!panelOpen || !panelWindow) return;
    try {
      // 每次打开都重建，保证「保留 N 条 / 共 M 条」是最新的
      panelWindow.innerHTML = '<div class="baf-popup">' + PANEL_HTML + '</div>';
      const chromeShim = chromeForPanel();
      const docShim = { getElementById: (id) => panelWindow.querySelector('#' + id) };
      bafPopupMain(chromeShim, docShim, { chrome: chromeShim });
      makePanelDraggable();
      if (!restorePanelOffset()) placePanelNearFab();
    } catch (error) {
      console.warn('[大肥鱼过滤器] 面板渲染失败', error);
    }
  }

  function setupPanel() {
    try {
      ensureHost();
      window.addEventListener('resize', () => {
        if (panelWindow) {
          const base = panelBase();
          const pos = clampOffset(panelOffset.x, panelOffset.y, base.left, base.top);
          applyPanelOffset(pos.x, pos.y);
        }
        if (fabEl) {
          const fabBaseRect = fabBase();
          const fabPos = clampFabOffset(fabOffset.x, fabOffset.y, fabBaseRect);
          applyFabOffset(fabPos.x, fabPos.y);
        }
      });
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('打开设置面板', () => { if (!panelOpen) togglePanel(); });
        GM_registerMenuCommand('切换规则一（昵称含鱼）', () => {
          applySettings({ modeFish: !settings.modeFish });
          refreshOpenPanel();
        });
        GM_registerMenuCommand('切换快速模式', () => {
          applySettings({ fastMode: !settings.fastMode });
          refreshOpenPanel();
        });
      }
    } catch (error) {
      console.warn('[大肥鱼过滤器] 面板初始化失败', error);
    }
  }

  globalThis.__bafApply = applySettings;
  globalThis.__bafSettings = () => ({ ...settings });
  globalThis.__bafTogglePanel = () => togglePanel();
