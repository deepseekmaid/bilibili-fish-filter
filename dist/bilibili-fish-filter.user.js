// ==UserScript==
// @name         B站大肥鱼过滤器（油猴版）
// @namespace    https://github.com/Sword-New-New/bilibili-fish-filter
// @version      1.0.1
// @description  白名单式 B 站评论过滤：三条规则（昵称含鱼 / 正文含 @ / 正文含主人）可独立设挡，取并集或交集。
// @match        https://www.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://live.bilibili.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==
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

  const BAF_VERSION = "1.0.1";
  const BAF_VERSION_NAME = "v1.01";
  const PANEL_CSS = "\n  :root { color-scheme: light; }\n  * { box-sizing: border-box; }\n  .baf-popup {\n    width: 328px; margin: 0; background: #ffffff; color: #1f2329;\n    font: 13px/1.5 \"Microsoft YaHei UI\", \"PingFang SC\", \"Segoe UI\", system-ui, sans-serif;\n    -webkit-font-smoothing: antialiased;\n  }\n  header { display: flex; gap: 9px; align-items: center; padding: 10px 14px 5px; }\n  header img { width: 26px; height: 26px; border-radius: 7px; flex: 0 0 auto; }\n  h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .2px; color: #1f2329; }\n  header p { margin: 2px 0 0; font-size: 11px; color: #8a91a0; }\n  .rulebar {\n    margin: 0 12px 5px; padding: 5px 9px; border-radius: 8px;\n    background: #f3f6ff; border: 1px solid #e3eaff;\n    font-size: 10px; line-height: 1.5; color: #55618a;\n  }\n  .rulebar b { color: #4d6bfe; font-weight: 600; }\n  .rulebar i { color: #e5484d; font-style: normal; }\n  main { padding: 0 6px 6px; }\n  .block { border-radius: 11px; border: 1px solid transparent; transition: background .16s, border-color .16s; }\n  .block + .block { margin-top: 5px; }\n  .block:hover { background: #f7f9fd; border-color: #edf1f8; }\n  .row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; }\n  .row .txt { flex: 1 1 auto; min-width: 0; }\n  .row b { display: block; font-size: 12.5px; font-weight: 600; color: #1f2329; }\n  .row code { font-size: 11px; color: #3b6fd4; background: #f3f6ff; padding: 0 3px; border-radius: 4px; }\n  .desc { display: block; margin-top: 3px; font-size: 10.5px; line-height: 1.5; color: #4b5563; }\n  input[type=checkbox] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }\n  .sw {\n    flex: 0 0 auto; width: 40px; height: 23px; border-radius: 12px;\n    background: #d9dee8; position: relative; transition: background .18s ease;\n  }\n  .sw::after {\n    content: \"\"; position: absolute; top: 3px; left: 3px;\n    width: 17px; height: 17px; border-radius: 50%;\n    background: #ffffff; box-shadow: 0 1px 3px rgba(31, 35, 41, .18);\n    transition: transform .18s ease;\n  }\n  input:checked + .sw { background: #4d6bfe; }\n  input:checked + .sw::after { transform: translateX(17px); }\n  input:focus-visible + .sw { outline: 2px solid #4d6bfe; outline-offset: 2px; }\n  .hint { padding: 0 8px 5px; font-size: 10.5px; line-height: 1.5; color: #6b7280; }\n  .sub { display: flex; align-items: center; gap: 8px; padding: 0 8px 6px; }\n  .sub .cap { font-size: 11px; color: #6b7280; }\n  .seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: #f2f5fa; border: 1px solid #e5eaf3; }\n  .seg button {\n    border: 0; background: transparent; color: #6b7280; cursor: pointer;\n    font: inherit; font-size: 11px; line-height: 1; padding: 5px 11px; border-radius: 6px;\n    transition: background .16s, color .16s;\n  }\n  .seg button:hover { color: #4d6bfe; }\n  .seg button.on { background: #4d6bfe; color: #ffffff; }\n  footer {\n    display: flex; align-items: center; justify-content: space-between; gap: 8px;\n    padding: 6px 14px 8px; border-top: 1px solid #eef1f6;\n    font-size: 11px; color: #6b7280;\n  }\n  .notice {\n    padding: 0 14px 4px; font-size: 10px; line-height: 1.6; color: #6b7280;\n  }\n  .diag {\n    padding: 3px 14px 0; font-size: 10px; line-height: 1.45; color: #6b7280;\n    border-top: 1px solid #eef1f6;\n  }\n  footer .saved { color: #16a34a; opacity: 0; transition: opacity .2s; }\n  footer .saved.on { opacity: 1; }\n  footer .ver { color: #9aa1ad; }";
  const PANEL_HTML = "<header>\n    <img src=\"data:image/png;base64,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\" alt=\"\">\n    <div>\n      <h1>B站大肥鱼过滤器</h1>\n      <p>白名单：命中的留下，其余删除</p>\n    </div>\n  </header>\n\n  <div class=\"notice\">没评论可显示时会自动加载更多（不滚动页面）</div>\n\n  <main>\n    <section class=\"block\" id=\"combineBlock\">\n      <div class=\"row\">\n        <div class=\"txt\"><b>规则组合</b></div>\n        <div class=\"seg\" id=\"combineSeg\">\n          <button type=\"button\" data-combine=\"union\" class=\"on\">并集</button>\n          <button type=\"button\" data-combine=\"intersect\">交集</button>\n        </div>\n      </div>\n      <div class=\"hint\">并集：命中任一就保留；交集：三条规则全命中才保留</div>\n    </section>\n\n    <section class=\"block\" id=\"fishBlock\">\n      <label class=\"row\">\n        <div class=\"txt\">\n          <b>规则一：昵称含「鱼」</b>\n          <span class=\"desc\">只留昵称带「鱼 / 魚」的评论。<b style=\"display:inline;color:#4d6bfe;white-space:nowrap\">默认开启</b></span>\n        </div>\n        <input type=\"checkbox\" id=\"modeFish\">\n        <span class=\"sw\"></span>\n      </label>\n    </section>\n\n    <section class=\"block\" id=\"atBlock\">\n      <div class=\"row\">\n        <div class=\"txt\">\n          <b>规则二：正文含 @</b>\n          <span class=\"desc\">带 <code>@</code> 的评论留下。</span>\n        </div>\n      </div>\n      <div class=\"sub\">\n        <div class=\"seg\" id=\"atSeg\">\n          <button type=\"button\" data-mode=\"contains\">包含 @</button>\n          <button type=\"button\" data-mode=\"startsWith\">以 @ 开头</button>\n          <button type=\"button\" data-mode=\"off\" class=\"on\">关</button>\n        </div>\n      </div>\n    </section>\n\n    <section class=\"block\" id=\"masterBlock\">\n      <div class=\"row\">\n        <div class=\"txt\">\n          <b>规则三：「主人」</b>\n          <span class=\"desc\">正文提到「主人」也留下。</span>\n        </div>\n      </div>\n      <div class=\"sub\">\n        <div class=\"seg\" id=\"masterSeg\">\n          <button type=\"button\" data-mode=\"contains\">包含主人</button>\n          <button type=\"button\" data-mode=\"startsWith\" class=\"on\">以主人开头</button>\n          <button type=\"button\" data-mode=\"off\">关</button>\n        </div>\n      </div>\n    </section>\n\n    <section class=\"block off\" id=\"autoBlock\">\n      <label class=\"row\">\n        <div class=\"txt\">\n          <b>一直加载到底</b>\n          <span class=\"desc\">不管有没有可显示的评论，都加载到全部加载完。</span>\n        </div>\n        <input type=\"checkbox\" id=\"autoLoad\">\n        <span class=\"sw\"></span>\n      </label>\n    </section>\n\n    <section class=\"block off\" id=\"fastBlock\">\n      <label class=\"row\">\n        <div class=\"txt\">\n          <b>快速模式</b>\n          <span class=\"desc\">加载时不逐页过滤、请求零等待；可能短暂露出未过滤评论。</span>\n        </div>\n        <input type=\"checkbox\" id=\"fastMode\">\n        <span class=\"sw\"></span>\n      </label>\n    </section>\n  </main>\n\n  <div class=\"notice\">注意：规则二、三都选「以…开头」且组合为交集时，一条评论都不会显示。</div>\n  <div class=\"diag\" id=\"diag\">自动加载：待检测</div>\n\n  <footer>\n    <span id=\"count\">正在读取本页…</span>\n    <span class=\"saved\" id=\"saved\">已保存</span>\n    <span class=\"ver\" id=\"ver\">v1.01</span>\n  </footer>";
  const BAF_DISPLAY_VERSION = "1.01";

  /* ===== 下面是 popup.js 原文，作为函数体在面板里运行 ===== */
  function bafPopupMain(chrome, document, globalThis) {
/* B站大肥鱼过滤器 — 设置面板 */
const DEFAULTS = { atMode: 'off', modeFish: true, masterMode: 'startsWith', combine: 'union', autoLoad: false, fastMode: false };

const fish = document.getElementById('modeFish');
const auto = document.getElementById('autoLoad');
const fast = document.getElementById('fastMode');
const fishBlock = document.getElementById('fishBlock');
const autoBlock = document.getElementById('autoBlock');
const fastBlock = document.getElementById('fastBlock');
const combineSeg = document.getElementById('combineSeg');
const atSeg = document.getElementById('atSeg');
const masterSeg = document.getElementById('masterSeg');
const saved = document.getElementById('saved');
const count = document.getElementById('count');
const diag = document.getElementById('diag');
const ver = document.getElementById('ver');

let timer = null;
let atMode = DEFAULTS.atMode;
let combine = DEFAULTS.combine;
let masterMode = DEFAULTS.masterMode;

try {
  const m = chrome.runtime.getManifest();
  ver.textContent = m.version_name || 'v' + m.version;
} catch {}

function flash() {
  saved.classList.add('on');
  clearTimeout(timer);
  timer = setTimeout(() => saved.classList.remove('on'), 1200);
}

function paintSeg(seg, value) {
  if (!seg) return;
  for (const btn of seg.querySelectorAll('button')) {
    const key = btn.dataset.mode || btn.dataset.combine;
    btn.classList.toggle('on', key === value);
  }
}

function paint() {
  fishBlock.classList.toggle('off', !fish.checked);
  autoBlock.classList.toggle('off', !auto.checked);
  fastBlock.classList.toggle('off', !fast.checked);
  paintSeg(combineSeg, combine);
  paintSeg(atSeg, atMode);
  paintSeg(masterSeg, masterMode);
}

function persist() {
  chrome.storage.sync.set({
    combine,
    atMode,
    modeFish: fish.checked,
    masterMode,
    autoLoad: auto.checked,
    fastMode: fast.checked,
  }, () => {
    flash();
    readCount();
  });
}

// 读取当前标签页的命中统计；不在 B 站页面时会失败，静默降级。
function readCount() {
  if (!globalThis.chrome?.tabs?.sendMessage) {
    count.textContent = '需在 B 站页面使用';
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) {
      count.textContent = '没有可用的标签页';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'BAF_STATS' }, (result) => {
      if (chrome.runtime.lastError || !result) {
        count.textContent = '当前页未运行（刷新 B 站页面试试）';
        return;
      }
      count.textContent = '保留 ' + result.visible + ' 条 / 共 ' + result.total + ' 条';
      const autoInfo = result.auto;
      if (autoInfo) {
        const status = autoInfo.running ? '加载中' : autoInfo.reason ? '停止:' + autoInfo.reason : '待机';
        diag.textContent = '自动加载 · 容器 ' + autoInfo.roots + ' · 拉 ' + autoInfo.pulls + ' · 脉冲 ' + autoInfo.pulses
          + ' · 空转 ' + autoInfo.idle + ' · ' + status + (autoInfo.via ? ' · ' + autoInfo.via : '');
      }
    });
  });
}

function bindSeg(seg, apply) {
  if (!seg) return;
  seg.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (!btn) return;
    apply(btn.dataset.mode);
    paint();
    persist();
  });
}

if (globalThis.chrome?.storage?.sync) {
  chrome.storage.sync.get(DEFAULTS, (value) => {
    fish.checked = value.modeFish !== false;
    auto.checked = value.autoLoad === true;
    fast.checked = value.fastMode === true;
    combine = value.combine === 'intersect' ? 'intersect' : 'union';
    atMode = value.atMode === 'contains' || value.atMode === 'startsWith' ? value.atMode : 'off';
    masterMode = value.masterMode === 'contains' || value.masterMode === 'off' ? value.masterMode : 'startsWith';
    paint();
    readCount();
  });

  for (const box of [fish, auto, fast]) {
    box.addEventListener('change', () => {
      paint();
      persist();
    });
  }

  if (combineSeg) {
    combineSeg.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-combine]');
      if (!btn) return;
      combine = btn.dataset.combine === 'intersect' ? 'intersect' : 'union';
      paint();
      persist();
    });
  }

  bindSeg(atSeg, (next) => {
    atMode = next === 'contains' || next === 'startsWith' ? next : 'off';
  });
  bindSeg(masterSeg, (next) => {
    masterMode = next === 'contains' || next === 'off' ? next : 'startsWith';
  });
} else {
  // 脱离扩展环境（例如直接预览 popup.html）时按默认值渲染
  fish.checked = DEFAULTS.modeFish;
  auto.checked = DEFAULTS.autoLoad;
  fast.checked = DEFAULTS.fastMode;
  combine = DEFAULTS.combine;
  atMode = DEFAULTS.atMode;
  masterMode = DEFAULTS.masterMode;
  paint();
  count.textContent = '预览模式';
}

  }

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
    Object.assign(settings, next);
    storeSet(BAF_STORE_KEY, next);
    resetAuto();
    schedule();
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

  function refreshOpenPanel() {
    if (!panelOpen || !panelWindow) return;
    try {
      // 每次打开都重建，保证「保留 N 条 / 共 M 条」是最新的
      panelWindow.innerHTML = '<div class="baf-popup">' + PANEL_HTML + '</div>';
      const chromeShim = chromeForPanel();
      const docShim = { getElementById: (id) => panelWindow.querySelector('#' + id) };
      bafPopupMain(chromeShim, docShim, { chrome: chromeShim });
    } catch (error) {
      console.warn('[大肥鱼过滤器] 面板渲染失败', error);
    }
  }

  function setupPanel() {
    try {
      ensureHost();
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

  // BAF:BOOT —— 构建油猴版时，适配层与设置面板会插在这一行之前
  installScrollbarStability();
  loadSettings();
  pass();
  AUTO_READY = true;
  maybeAutoLoad();

  setupPanel();
})();
