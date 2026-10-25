/* B站大肥鱼过滤器 — content script
 * 白名单式过滤：命中的留下，不命中的一律删除。
 *   modeAt   : 正文含 @（全角＠也算）→ 保留；以「回复 @」开头的除外，照样删
 *   modeFish : 作者昵称含「鱼 / 魚」→ 保留
 * 两个模式都开时取并集：含 @ 的、或鱼用户的，留下；其余删除。
 * 两个模式都关时不做任何隐藏。
 *
 * 自动加载：
 *   - 永久逻辑：页面上一条「能显示」的评论都没有时，自动往下加载，直到出现第一条；
 *   - autoLoad 开关：不管有没有出现，一直加载到评论区全部加载完（默认关）。
 */
(() => {
  'use strict';

  const DEFAULTS = { atMode: 'off', modeFish: true, masterMode: 'startsWith', combine: 'union', autoLoad: false, fastMode: false };
  const settings = { ...DEFAULTS };

  // AUTO 等常量在文件后半段才初始化，之前不能碰自动加载
  let AUTO_READY = false;

  const FISH_CHARS = ['鱼', '魚'];
  const HAS_AT = /[@＠]/;
  const REPLY_HEAD = /^\s*回复\s*[@＠]/;

  const COMMENT_SEL = 'bili-comment-renderer, bili-comment-reply-renderer';
  // 一条「楼层」：主评论 + 楼中楼 + 底部的「共 N 条回复」折叠条 + 分割线都在它里面。
  const THREAD_SEL = 'bili-comment-thread-renderer';
  const LEGACY_SEL = '.reply-item, .sub-reply-item';

  /** @type {Map<Element, {value: string, priority: string}>} */
  const hidden = new Map();
  /** @type {Set<Element>} 本轮命中的目标，用于还原已不再命中的节点 */
  let seen = new Set();

  /* ---------------------------------------------------------------- 设置 */

  function normalize(raw) {
    return {
      atMode: raw?.atMode === 'contains' || raw?.atMode === 'startsWith'
        ? raw.atMode
        : raw?.modeAt === true
          ? 'contains'
          : 'off',
      modeFish: raw?.modeFish !== false,
      masterMode: raw?.masterMode === 'contains' || raw?.masterMode === 'off' ? raw.masterMode : 'startsWith',
      combine: raw?.combine === 'intersect' ? 'intersect' : 'union',
      autoLoad: raw?.autoLoad === true,
      fastMode: raw?.fastMode === true,
    };
  }

  // BAF:ADAPTER-START —— 这段是 Chrome 扩展专用的存储适配，油猴版由构建脚本整体替换
  function loadSettings() {
    const storage = globalThis.chrome?.storage?.sync;
    if (!storage) return;
    try {
      storage.get(DEFAULTS, (value) => {
        if (chrome.runtime?.lastError) return;
        Object.assign(settings, normalize(value));
        schedule();
        maybeAutoLoad();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        let touched = false;
        if (changes.atMode) {
          const next = changes.atMode.newValue;
          settings.atMode = next === 'contains' || next === 'startsWith' ? next : 'off';
          touched = true;
        }
        if (changes.modeFish) {
          settings.modeFish = changes.modeFish.newValue !== false;
          touched = true;
        }
        if (changes.masterMode) {
          const next = changes.masterMode.newValue;
          settings.masterMode = next === 'contains' || next === 'off' ? next : 'startsWith';
          touched = true;
        }
        if (changes.combine) {
          settings.combine = changes.combine.newValue === 'intersect' ? 'intersect' : 'union';
          touched = true;
        }
        if (changes.fastMode) {
          settings.fastMode = changes.fastMode.newValue === true;
          touched = true;
        }
        if (changes.autoLoad) {
          settings.autoLoad = changes.autoLoad.newValue === true;
          resetAuto();
          touched = true;
        }
        if (touched) schedule();
      });
    } catch (error) {
      console.warn('[大肥鱼过滤器] 读取设置失败，使用默认值', error);
    }
  }
  // BAF:ADAPTER-END

  /* ------------------------------------------------------------ 显示控制 */

  function hide(el) {
    if (!hidden.has(el)) {
      hidden.set(el, {
        value: el.style.getPropertyValue('display'),
        priority: el.style.getPropertyPriority('display'),
      });
    }
    el.style.setProperty('display', 'none', 'important');
  }

  function show(el) {
    const saved = hidden.get(el);
    if (!saved) return;
    if (saved.value) el.style.setProperty('display', saved.value, saved.priority);
    else el.style.removeProperty('display');
    hidden.delete(el);
  }

  /* ------------------------------------------------------------ 取文本 */

  function textOf(comment) {
    const root = comment.shadowRoot;
    if (!root) return '';
    const rich = root.querySelector('bili-rich-text');
    const contents = rich?.shadowRoot?.querySelector('#contents');
    if (contents) return contents.textContent || '';
    const fallback = root.querySelector('#contents');
    return fallback?.textContent || '';
  }

  function nameOf(comment) {
    const root = comment.shadowRoot;
    if (!root) return '';
    const probes = [
      () => root.querySelector('bili-comment-user-info')?.shadowRoot?.querySelector('#user-name'),
      () => root.querySelector('#user-name'),
      () => root.querySelector('.user-name'),
      () => root.querySelector('[class*="user-name"]'),
      () => root.querySelector('a[href*="space.bilibili.com"]'),
      () => root.querySelector('a[data-user-id]'),
    ];
    for (const probe of probes) {
      let text = '';
      try {
        text = probe()?.textContent?.trim() || '';
      } catch {
        text = '';
      }
      if (text) return text;
    }
    return '';
  }

  /* -------------------------------------------------------------- 判定 */

  function verdict(text, name) {
    // 正文和昵称都没解析出来（多半是 B 站改版）时一律放行，避免整页评论被误删。
    if (!text && !name) return false;

    const rules = [];
    if (settings.atMode === 'contains') rules.push(HAS_AT.test(text));
    else if (settings.atMode === 'startsWith') rules.push(/^\s*[@＠]/.test(text));
    if (settings.modeFish) rules.push(FISH_CHARS.some((ch) => name.includes(ch)));
    if (settings.masterMode === 'contains') rules.push(text.includes('主人'));
    else if (settings.masterMode === 'startsWith') rules.push(/^\s*主人/.test(text));

    if (!rules.length) return false;

    // 白名单：并集 = 任一条命中就保留；交集 = 全部命中才保留
    const keep = settings.combine === 'intersect' ? rules.every(Boolean) : rules.some(Boolean);
    return !keep;
  }

  function legacyVerdict(item) {
    const text = item.querySelector('.reply-content')?.textContent || '';
    const name =
      item.querySelector('.root-reply-container .user-name')?.textContent?.trim() ||
      item.querySelector('.user-name')?.textContent?.trim() ||
      item.querySelector('a[href*="space.bilibili.com"]')?.textContent?.trim() ||
      '';
    return verdict(text, name);
  }

  /* -------------------------------------------------------------- 扫描 */

  const observed = new WeakSet();
  /** 只记 <bili-comments> 本身，不扫整页——几千条评论时全页遍历会把 CPU 打满。 */
  const ROOTS = new Set();
  const STATS = { total: 0, visible: 0 };

  function observe(root) {
    if (!root || observed.has(root) || typeof MutationObserver !== 'function') return;
    try {
      new MutationObserver(schedule).observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      observed.add(root);
    } catch {
      /* ignore */
    }
  }

  function refreshRoots() {
    let list = [];
    try {
      list = document.querySelectorAll('bili-comments');
    } catch {
      list = [];
    }
    let changed = false;
    for (const host of list) {
      if (ROOTS.has(host)) continue;
      ROOTS.add(host);
      observe(host.shadowRoot);
      changed = true;
    }
    for (const host of [...ROOTS]) {
      if (host.isConnected) continue;
      ROOTS.delete(host);
      changed = true;
    }
    return changed;
  }

  function commentRoots() {
    return [...ROOTS];
  }

  function count(comment) {
    seen.add(comment);
    STATS.total += 1;
    if (verdict(textOf(comment), nameOf(comment))) {
      hide(comment);
      return true;
    }
    show(comment);
    STATS.visible += 1;
    return false;
  }

  function scanContainer(shadow) {
    if (!shadow) return;
    observe(shadow);

    const visited = new Set();
    let threads = [];
    try {
      threads = shadow.querySelectorAll(THREAD_SEL);
    } catch {
      threads = [];
    }

    for (const thread of threads) {
      const threadShadow = thread.shadowRoot;
      const main = threadShadow ? threadShadow.querySelector('bili-comment-renderer') : null;
      if (!main) {
        show(thread);
        continue;
      }

      seen.add(thread);
      const hiddenMain = count(main);
      visited.add(main);

      // 楼中楼 / 同层多出来的评论一起判（回复渲染器也在这个 shadow 里）
      let inside = [];
      try {
        inside = threadShadow.querySelectorAll(COMMENT_SEL);
      } catch {
        inside = [];
      }
      for (const other of inside) {
        if (visited.has(other)) continue;
        visited.add(other);
        count(other);
      }

      // 主评论被删就收起整楼（否则留下「共 N 条回复」和分割线）
      if (hiddenMain) hide(thread);
      else show(thread);
    }

    // 不在 thread 里的独立评论
    let loose = [];
    try {
      loose = shadow.querySelectorAll(COMMENT_SEL);
    } catch {
      loose = [];
    }
    for (const comment of loose) {
      if (visited.has(comment) || !comment.shadowRoot) continue;
      visited.add(comment);
      count(comment);
    }

  }

  function scanLegacy() {
    let items = [];
    try {
      items = document.querySelectorAll(LEGACY_SEL);
    } catch {
      items = [];
    }
    for (const item of items) {
      seen.add(item);
      STATS.total += 1;
      if (legacyVerdict(item)) hide(item);
      else {
        show(item);
        STATS.visible += 1;
      }
    }
  }

  function pass() {
    seen = new Set();
    STATS.total = 0;
    STATS.visible = 0;
    try {
      clearStuckPull();
      refreshRoots();
      if (ROOTS.size) {
        for (const host of ROOTS) {
          scanContainer(host.shadowRoot);
          if (Array.isArray(host.list) && host.list.length > STATS.total) STATS.total = host.list.length;
        }
      } else {
        // 页面里没有 <bili-comments>（旧版评论区 / 其他结构）：整页找楼层 + 旧版条目
        scanContainer(document);
        scanLegacy();
      }
    } catch (error) {
      console.warn('[大肥鱼过滤器] 扫描出错', error);
    }
    for (const el of [...hidden.keys()]) {
      if (!seen.has(el)) show(el);
    }
  }

  /* ------------------------------------------------------------ 调度 */

  let pending = null;

  function autoBusy() {
    return AUTO_READY && AUTO.running;
  }

  function schedule() {
    if (pending) return;
    // 快速模式：加载过程中不做逐页重扫，把过滤推迟到加载结束，省掉每页一次的扫描与重排
    if (settings.fastMode && autoBusy()) return;

    const run = () => {
      pending = null;
      pass();
    };
    // 用 rAF：改完在下一帧绘制前生效，新评论不会先以“未过滤”的样子闪一下，
    // 页面高度也不会先涨再缩（滚动条抽搐的主要来源）
    pending = typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden'
      ? requestAnimationFrame(run)
      : setTimeout(run, 60);
  }

  // attachShadow 不会触发外层观察器，靠低频兜底扫描补齐延迟挂载的评论区
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;

    // 平时只查「评论区有没有出现/消失」，不重扫整棵评论树；
    // 没有 bili-comments 的旧页面才定期全量扫一次。
    const changed = refreshRoots();
    if (changed || ROOTS.size === 0) pass();

    if (location.href !== autoPath) {
      autoPath = location.href;
      resetAuto();
    }
    maybeAutoLoad();
  }, 3000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule();
  });

  /* -------------------------------------------------------- 自动加载 */

  const AUTO = {
    running: false,
    timer: null,
    rounds: 0,
    idle: 0,
    lastTotal: -1,
    lastSeenTotal: -1,
    gaveUp: false,
    reason: '',
    pulls: 0,
    pulses: 0,
    lastPulse: 0,
    via: '',
    pending: null,
    cooldown: 0,
  };

  const END_MARKERS = /没有更多评论|已经到底了|已加载全部|暂无评论|还没有评论/;
  const TOTAL_MARKERS = /共\s*([\d.]+)\s*(万)?\s*条评论/;

  /** 扫描时顺手统计，这里直接返回缓存，避免每次 tick 再遍历一遍 DOM。 */
  function commentStats() {
    return { total: STATS.total, visible: STATS.visible };
  }

  /** 已加载条数：组件自己的 list 和 DOM 渲染数取大的那个。 */
  function loadedCount() {
    let listTotal = 0;
    for (const host of ROOTS) {
      if (Array.isArray(host.list)) listTotal += host.list.length;
    }
    let legacy = 0;
    if (!ROOTS.size) {
      try {
        legacy = document.querySelectorAll(LEGACY_SEL).length;
      } catch {
        legacy = 0;
      }
    }
    return Math.max(commentStats().total + legacy, listTotal);
  }

  function reachedEnd(total) {
    const hosts = commentRoots();

    // 有 <bili-comments> 就只信它自己的 showEnd。
    // 文案匹配在真实页面上会误伤（页面里别处也写着「没有更多评论」），
    // 「共 N 条评论」又跟实际可加载条数对不上（B 站有上限/去重），都会导致提前收手。
    if (hosts.length) return hosts.some((el) => el.showEnd === true);

    // 没有组件（旧版评论区 / 其他页面）才退回文案判断
    const legacy = findAnchor();
    const text = legacy ? legacy.textContent || '' : '';
    if (END_MARKERS.test(text)) return true;
    const match = text.match(TOTAL_MARKERS);
    if (match) {
      const target = Math.round(parseFloat(match[1]) * (match[2] ? 10000 : 1));
      if (target > 0 && total >= target) return true;
    }
    return false;
  }

  const LOAD_MORE_TEXT = /加载更多|查看更多|点击加载|展开更多|显示更多|更多评论/;

  /** 在评论区里找「加载更多」按钮：不限于 button，B 站常用 div/span 当按钮。 */
  function findLoadMore(root) {
    let nodes = [];
    try {
      nodes = root.querySelectorAll('*');
    } catch {
      return null;
    }
    for (const el of nodes) {
      if (el.childElementCount > 0) continue; // 只认叶子，避免点到整块容器
      if (el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true') continue;

      const label = (el.textContent || '').trim();
      if (!label || label.length > 14) continue;
      if (!LOAD_MORE_TEXT.test(label)) continue;
      // 楼中楼的「共 N 条回复，点击查看」不算列表加载
      if (typeof el.closest === 'function' && el.closest('bili-comment-thread-renderer')) continue;
      return el;
    }
    return null;
  }

  /** 评论区如果自己是滚动容器，就滚它——不动窗口。 */
  function innerScroller(host) {
    let el = host;
    while (el && el !== document.body && el !== document.documentElement) {
      let style = null;
      try {
        style = getComputedStyle(el);
      } catch {
        style = null;
      }
      if (style && /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement || (el.getRootNode && el.getRootNode().host);
    }
    return null;
  }

  /**
   * 评论区还在视口外时，用 transform 把它临时“搬”进视口，触发它自己的
   * IntersectionObserver / 懒加载；全程 opacity:0，且不改变页面滚动位置。
   */
  /** 正在“拉进视口”的元素：同一个元素绝不叠两次，否则会把 opacity:0 存成“原值”，永久白屏。 */
  const PULL_STATE = new WeakMap();

  function restorePull(el) {
    const state = PULL_STATE.get(el);
    if (!state) return;
    PULL_STATE.delete(el);
    if (state.timer) clearTimeout(state.timer);
    try {
      el.style.opacity = state.saved.opacity;
      el.style.pointerEvents = state.saved.pointerEvents;
      el.style.transform = state.saved.transform;
      el.style.willChange = state.saved.willChange;
    } catch {
      /* ignore */
    }
    try {
      window.dispatchEvent(new Event('scroll'));
    } catch {
      /* ignore */
    }
  }

  /** 兜底：把上一次运行/异常留下的隐形样式清掉，否则评论区会整块看不见。 */
  function clearStuckPull() {
    const targets = commentRoots();
    const anchor = findAnchor();
    if (anchor) targets.push(anchor);
    for (const el of targets) {
      if (PULL_STATE.has(el)) continue;
      try {
        const transform = el.style.transform || '';
        if (el.style.opacity === '0' && transform.indexOf('translate3d') !== -1) {
          el.style.opacity = '';
          el.style.transform = '';
          el.style.willChange = '';
          el.style.pointerEvents = '';
        }
      } catch {
        /* ignore */
      }
    }
  }

  function pullIntoView(el, hold, allowZeroHeight) {
    if (!el || !el.style) return false;
    if (PULL_STATE.has(el)) return false; // 已经在拉，别叠

    let rect = null;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      return false;
    }

    const vh = window.innerHeight || 800;
    if (rect && rect.height > 0 && rect.top < vh - 80 && rect.bottom > 120) return false;
    // 普通元素没有高度说明还没渲染，拉也拉不出东西；
    // 但占位容器（#commentapp）本来就是 0 高，要拉它来触发页面的懒挂载。
    if (!rect) return false;
    if (rect.height <= 0 && !allowZeroHeight) return false;

    const delta = Math.round(100 - rect.top);
    const saved = {
      opacity: el.style.opacity,
      pointerEvents: el.style.pointerEvents,
      transform: el.style.transform,
      willChange: el.style.willChange,
    };
    PULL_STATE.set(el, { saved, timer: null });

    try {
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      el.style.willChange = 'transform';
      el.style.transform = 'translate3d(0,' + delta + 'px,0)';
    } catch {
      PULL_STATE.delete(el);
      return false;
    }

    // 只改 transform 有些实现看的是「滚动后重算的矩形」，补一次 scroll 事件
    try {
      window.dispatchEvent(new Event('scroll'));
      el.dispatchEvent(new Event('scroll'));
    } catch {
      /* ignore */
    }

    const timer = setTimeout(() => restorePull(el), hold || 400);
    const state = PULL_STATE.get(el);
    if (state) state.timer = timer;

    AUTO.pulls += 1;
    return true;
  }

  /** 还没挂载时的评论区占位容器 */
  function findAnchor() {
    const selectors = ['#comment', '#commentapp', '.comment-container', '.bb-comment', '[class*="comment-container"]'];
    for (const selector of selectors) {
      let el = null;
      try {
        el = document.querySelector(selector);
      } catch {
        el = null;
      }
      if (el) return el;
    }
    return null;
  }

  /**
   * 同一个任务里滚到底再滚回来：浏览器不会绘制中间位置，等于“看不见地滚一下”。
   * 只在评论区压根没挂载时才用，用来触发基于 scroll 事件的懒挂载。
   */
  function scrollPulse() {
    const now = Date.now();
    if (now - AUTO.lastPulse < 2500) return false;

    const y = window.scrollY || 0;
    let bottom = 0;
    try {
      bottom = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    } catch {
      bottom = 0;
    }
    if (bottom <= y + 8) return false;

    try {
      window.scrollTo(0, bottom);
      window.dispatchEvent(new Event('scroll'));
      window.scrollTo(0, y);
    } catch {
      return false;
    }

    AUTO.lastPulse = now;
    AUTO.pulses += 1;
    return true;
  }

  /**
   * 直接驱动 <bili-comments> 自己的加载逻辑，绕开滚动。
   * B 站源码（commentpc/bili-comments.js）里：
   *   - 懒加载：initLazyLoad() 用 IntersectionObserver 观察元素本身，进入视口才 resolve lazyLoadDP，之后才取首页；
   *   - 翻页：列表底部有 #continuations .trigger 也靠 IntersectionObserver 触发 getList()；
   *   - 结束：showEnd === true 时渲染「没有更多评论」。
   * 所以最稳的做法是直接 resolve 掉懒加载闸门、或者直接调 getList()。
   */
  function kickComponent(host) {
    if (!host || typeof host !== 'object') return null;
    try {
      const gate = host.lazyLoadDP;
      if (gate && typeof gate.resolve === 'function') {
        gate.resolve();
        host.lazyLoadDP = null;
        return 'lazy';
      }
      if (host.showEnd === true) return null;
      if (host.showSpinner === true) return null;
      if (typeof host.getList === 'function') {
        const pending = host.getList();
        // getList 是 async 的，拿到 promise 就能“上一页一回来立刻要下一页”，不用定时器傻等
        if (pending && typeof pending.then === 'function') AUTO.pending = pending;
        return 'api';
      }
    } catch {
      /* 组件结构变了就交给后面的兜底 */
    }
    return null;
  }

  function clickLoadMore(hosts) {
    for (const host of hosts) {
      const btn = findLoadMore(host.shadowRoot);
      if (!btn) continue;
      try {
        btn.click();
        return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  function kickLoad() {
    if (refreshRoots()) pass();
    const hosts = commentRoots();

    // 正在请求中就安静等一下，别叠请求也别去拉视口
    for (const host of hosts) {
      if (host.showSpinner === true) {
        AUTO.via = 'wait';
        return 'wait';
      }
    }

    // 0) 首选：直接调组件 API（懒加载闸门 / 下一页）
    for (const host of hosts) {
      const via = kickComponent(host);
      if (via) {
        AUTO.via = via;
        return via;
      }
    }

    // 点了两三下都没长进，说明这个按钮是「在视口里才有效」的那种，先试拉进视口
    const preferPull = AUTO.idle >= 3;

    if (!preferPull && clickLoadMore(hosts)) return 'click';

    // 评论区在视口外：偷偷把它拉进视口，触发懒加载（不滚页面）
    for (const host of hosts) {
      if (pullIntoView(host)) return 'pull';
    }

    if (preferPull && clickLoadMore(hosts)) return 'click';

    // 3) 评论区自己带滚动条：滚它，不滚窗口
    for (const host of hosts) {
      const scroller = innerScroller(host);
      if (!scroller) continue;
      try {
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        return 'inner-scroll';
      } catch {
        /* ignore */
      }
    }

    // 4) 评论区还没挂载：把占位容器（#comment 之类）也拉进视口试试
    if (!hosts.length) {
      const anchor = findAnchor();
      if (anchor && pullIntoView(anchor, 400, true)) return 'pull-anchor';
    }

    // 5) 再不行：来一次看不见的滚动脉冲
    if (!hosts.length && scrollPulse()) return 'pulse';

    // 5) 最后的兜底：只发合成 scroll 事件，页面不动
    try {
      window.dispatchEvent(new Event('scroll'));
    } catch {
      /* ignore */
    }
    return 'none';
  }

  function finishAuto(reason) {
    AUTO.running = false;
    if (AUTO.timer) clearTimeout(AUTO.timer);
    AUTO.timer = null;
    AUTO.reason = reason;

    if (reason === 'idle' && !ROOTS.size) {
      // 评论区压根没出现（页面还没懒挂载）：别放弃，过 5 秒再来
      AUTO.cooldown = Date.now() + 5000;
      AUTO.gaveUp = false;
    } else {
      AUTO.gaveUp = reason === 'end' || reason === 'idle' || reason === 'limit';
    }
    if (reason !== 'continue') console.info('[大肥鱼过滤器] 自动加载停止：' + reason);
    // 无论是快速模式（加载期间没扫）还是普通模式，收尾都要补一次过滤
    schedule();
    return reason;
  }

  function autoTick() {
    if (document.visibilityState === 'hidden') return 'pause';

    refreshRoots(); // 顺手修剪掉已经不在页面上的评论区
    const { visible } = commentStats();
    const total = loadedCount();

    // 永久逻辑：已经有一条能显示的评论，就不用再加载了
    if (!settings.autoLoad && visible > 0) return finishAuto('visible');
    if (reachedEnd(total)) return finishAuto('end');

    if (total > AUTO.lastTotal) {
      AUTO.lastTotal = total;
      AUTO.idle = 0;
    } else {
      AUTO.idle += 1;
    }

    // 连着 40 轮没长进才收手（配合退避，大约两三分钟）；期间只要加载出新评论就自动续上
    if (AUTO.idle >= 40) return finishAuto('idle');
    if (AUTO.rounds >= 600) return finishAuto('limit');

    AUTO.rounds += 1;
    kickLoad();
    return 'continue';
  }

  function startAuto() {
    if (AUTO.running) return;
    AUTO.running = true;
    AUTO.rounds = 0;
    AUTO.idle = 0;
    AUTO.lastTotal = -1;
    AUTO.gaveUp = false;
    AUTO.reason = '';

    const loop = () => {
      if (!AUTO.running) return;

      const result = autoTick();
      const pending = AUTO.pending;
      AUTO.pending = null;

      if (result === 'pause') {
        AUTO.timer = setTimeout(loop, 2000);
        return;
      }
      if (result === 'wait') {
        AUTO.timer = setTimeout(loop, 250);
        return;
      }
      if (result !== 'continue') {
        finishAuto(result);
        return;
      }

      // getList() 有 promise：上一页一回来立刻要下一页，速度就等于网络往返
      if (pending) {
        let settled = false;
        const next = () => {
          if (settled || !AUTO.running) return;
          settled = true;
          AUTO.timer = setTimeout(loop, settings.fastMode ? 0 : 60);
        };
        // 成功 → 立刻（快速模式 0ms / 普通 60ms）要下一页；失败 → 退避 800ms 再来
        pending.then(next, () => {
          if (settled || !AUTO.running) return;
          settled = true;
          AUTO.timer = setTimeout(loop, 800);
        });
        setTimeout(next, 8000); // 网络卡死也别干等
        return;
      }

      // 没有 promise（按钮/拉视口/脉冲这些路子）：退避着来
      const wait = settings.fastMode ? 120 : AUTO.idle >= 10 ? 3000 : AUTO.idle >= 4 ? 1000 : 350;
      AUTO.timer = setTimeout(loop, wait);
    };
    AUTO.timer = setTimeout(loop, 200);
  }

  function stopAuto() {
    AUTO.running = false;
    if (AUTO.timer) clearTimeout(AUTO.timer);
    AUTO.timer = null;
  }

  function maybeAutoLoad() {
    if (!AUTO_READY) return;
    if (AUTO.running) return;

    if (Date.now() < (AUTO.cooldown || 0)) return;

    const { total, visible } = commentStats();
    if (!settings.autoLoad && visible > 0) return;

    // 又长出新的评论了 → 之前放弃过也重新开始
    if (total > AUTO.lastSeenTotal) {
      AUTO.lastSeenTotal = total;
      AUTO.gaveUp = false;
    }
    if (AUTO.gaveUp) return;
    startAuto();
  }

  function resetAuto() {
    stopAuto();
    AUTO.gaveUp = false;
    AUTO.cooldown = 0;
    AUTO.lastSeenTotal = -1;
    AUTO.reason = '';
    maybeAutoLoad();
  }

  // SPA 换页面时重置判定
  let autoPath = location.href;

  /* ------------------------------------------------------------ 统计 */

  function countComments(root) {
    let total = 0;
    try {
      total += root.querySelectorAll(COMMENT_SEL).length;
    } catch {
      /* ignore */
    }
    let hosts = [];
    try {
      hosts = root.querySelectorAll('*');
    } catch {
      hosts = [];
    }
    for (const host of hosts) {
      if (host.shadowRoot) total += countComments(host.shadowRoot);
    }
    return total;
  }

  function stats() {
    const { total, visible } = commentStats();
    return {
      hidden: hidden.size,
      total,
      visible,
      ...settings,
      auto: {
        running: AUTO.running,
        roots: commentRoots().length,
        pulls: AUTO.pulls,
        pulses: AUTO.pulses,
        idle: AUTO.idle,
        reason: AUTO.reason,
        via: AUTO.via,
        anchor: Boolean(findAnchor()),
        comp: commentRoots().map((host) => ({
          lazy: host.lazyLoad === true,
          gate: Boolean(host.lazyLoadDP),
          end: host.showEnd === true,
          spin: host.showSpinner === true,
          list: Array.isArray(host.list) ? host.list.length : -1,
        })),
      },
    };
  }

  // 供自测使用
  globalThis.__bafStats = stats;
  globalThis.__bafAuto = {
    tick: autoTick,
    start: startAuto,
    stop: stopAuto,
    reset: resetAuto,
    stats: commentStats,
    state: AUTO,
    sweep: clearStuckPull,
    perf: () => {
      const start = performance.now();
      pass();
      return performance.now() - start;
    },
    // 调试用：在控制台执行 __bafAuto.probe() 能看到脚本有没有找到「加载更多」
    probe: () => {
      const roots = commentRoots();
      const buttons = roots.map((el) => findLoadMore(el.shadowRoot)?.textContent?.trim() || null);
      const scrollers = roots.map((el) => Boolean(innerScroller(el)));
      const comp = roots.map((host) => ({
        lazy: host.lazyLoad === true,
        gate: Boolean(host.lazyLoadDP),
        end: host.showEnd === true,
        spin: host.showSpinner === true,
        hasGetList: typeof host.getList === 'function',
        list: Array.isArray(host.list) ? host.list.length : -1,
      }));
      return { roots: roots.length, buttons, scrollers, comp, ...commentStats(), state: { ...AUTO } };
    },
  };

  /** 给页面留一条常驻滚动条槽位：内容高度变化时滚动条不再“出现/消失”地抽搐。 */
  function installScrollbarStability() {
    try {
      if (document.getElementById('baf-stable-scroll')) return;
      const style = document.createElement('style');
      style.id = 'baf-stable-scroll';
      style.textContent = 'html{scrollbar-gutter:stable}';
      (document.head || document.documentElement).appendChild(style);
    } catch {
      /* ignore */
    }
  }

  // BAF:BOOT —— 构建油猴版时，适配层与设置面板会插在这一行之前
  installScrollbarStability();
  loadSettings();
  pass();
  AUTO_READY = true;
  maybeAutoLoad();

  // BAF:MESSAGE-START —— 扩展弹窗读取统计用，油猴版没有消息通道，构建时剔除
  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== 'BAF_STATS') return undefined;
      respond(stats());
      return true;
    });
  }
  // BAF:MESSAGE-END
})();
