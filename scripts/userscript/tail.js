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
    '  border: 0; cursor: pointer; background: #4d6bfe; color: #fff; box-shadow: 0 6px 18px rgba(77,107,254,.45);',
    '  display: flex; align-items: center; justify-content: center; z-index: 2147483000; transition: transform .15s; }',
    '.baf-fab:hover { transform: translateY(-2px); }',
    // 面板可拖动：顶栏作为拖拽把手
    '.baf-window { will-change: transform; }',
    '.baf-window .baf-popup header { cursor: grab; user-select: none; touch-action: none; }',
    '.baf-window .baf-popup header .baf-grip { display: inline-flex; align-items: center; justify-content: center;',
    '  width: 16px; height: 18px; margin-right: 2px; color: #b3b9c4; font-size: 13px; line-height: 1; }',
    '.baf-window.is-dragging .baf-popup header { cursor: grabbing; }',
    '.baf-window.is-dragging { box-shadow: 0 24px 60px rgba(15,23,42,.28); }',
  ].join('\n');

  const FAB_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">'
    + '<path d="M3 12c3-4 7-6 11-6 3 0 5 1 7 3l-3 3 3 3c-2 2-4 3-7 3-4 0-8-2-11-6z" fill="currentColor"/>'
    + '<circle cx="16" cy="11" r="1.4" fill="#4d6bfe"/></svg>';

  let panelHost = null;
  let panelShadow = null;
  let panelWindow = null;
  let panelOpen = false;

  function ensureHost() {
    if (panelHost) return;
    panelHost = document.createElement('div');
    panelHost.id = 'baf-userscript-panel';
    panelShadow = panelHost.attachShadow({ mode: 'open' });
    panelShadow.innerHTML = '<style>' + PANEL_CSS + '</style>'
      + '<style>' + PANEL_CHROME_STYLE + '</style>'
      + '<div class="baf-window" hidden></div>'
      + '<button class="baf-fab" type="button" title="B站大肥鱼过滤器设置">' + FAB_SVG + '</button>';
    document.documentElement.appendChild(panelHost);
    panelWindow = panelShadow.querySelector('.baf-window');
    panelShadow.querySelector('.baf-fab').addEventListener('click', () => togglePanel());
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
    if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return;
    const base = panelBase();
    const pos = clampOffset(saved.x, saved.y, base.left, base.top);
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
      const finish = () => {
        document.removeEventListener(DRAG_MOVE, onMove, true);
        document.removeEventListener(DRAG_UP, finish, true);
        document.removeEventListener('pointercancel', finish, true);
        document.documentElement.style.userSelect = prevUserSelect;
        panelWindow.classList.remove('is-dragging');
        storeSet(PANEL_POS_KEY, { x: panelOffset.x, y: panelOffset.y });
      };

      // 用捕获阶段监听：页面自己的 pointermove 处理不会把事件吃掉
      document.addEventListener(DRAG_MOVE, onMove, true);
      document.addEventListener(DRAG_UP, finish, true);
      document.addEventListener('pointercancel', finish, true);
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
      restorePanelOffset();
    } catch (error) {
      console.warn('[大肥鱼过滤器] 面板渲染失败', error);
    }
  }

  function setupPanel() {
    try {
      ensureHost();
      window.addEventListener('resize', () => {
        if (!panelWindow) return;
        const base = panelBase();
        const pos = clampOffset(panelOffset.x, panelOffset.y, base.left, base.top);
        applyPanelOffset(pos.x, pos.y);
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
