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
    '.baf-window .baf-popup header { cursor: grab; user-select: none; touch-action: none; }',
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

  const PANEL_POS_KEY = 'baf.panel.pos.v1';

  function clampPanelPos(left, top) {
    const rect = panelWindow && panelWindow.getBoundingClientRect ? panelWindow.getBoundingClientRect() : null;
    const width = Math.round((rect && rect.width) || 328);
    const height = Math.round((rect && rect.height) || 420);
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop),
    };
  }

  function movePanel(left, top) {
    const pos = clampPanelPos(left, top);
    panelWindow.style.left = pos.left + 'px';
    panelWindow.style.top = pos.top + 'px';
    panelWindow.style.right = 'auto';
    panelWindow.style.bottom = 'auto';
    return pos;
  }

  function applyPanelPos() {
    const saved = storeGet(PANEL_POS_KEY, null);
    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return;
    movePanel(saved.left, saved.top);
  }

  /** 顶栏拖动整个面板，位置记在 GM 存储里，下次打开还在原处。 */
  function makePanelDraggable() {
    const handle = panelWindow.querySelector('.baf-popup header');
    if (!handle || handle.dataset.bafDrag === '1') return;
    handle.dataset.bafDrag = '1';

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = panelWindow.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;

      panelWindow.classList.add('is-dragging');
      movePanel(startLeft, startTop);

      const onMove = (e) => {
        movePanel(startLeft + (e.clientX - startX), startTop + (e.clientY - startY));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        panelWindow.classList.remove('is-dragging');
        const box = panelWindow.getBoundingClientRect();
        storeSet(PANEL_POS_KEY, { left: Math.round(box.left), top: Math.round(box.top) });
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      event.preventDefault();
      event.stopPropagation();
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
      applyPanelPos();
    } catch (error) {
      console.warn('[大肥鱼过滤器] 面板渲染失败', error);
    }
  }

  function setupPanel() {
    try {
      ensureHost();
      window.addEventListener('resize', () => {
        if (!panelWindow) return;
        if (!panelWindow.style.left && !panelWindow.style.top) return;
        const box = panelWindow.getBoundingClientRect();
        movePanel(box.left, box.top);
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
