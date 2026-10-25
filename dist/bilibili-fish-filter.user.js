// ==UserScript==
// @name         B站大肥鱼过滤器（油猴版）
// @namespace    https://github.com/deepseekmaid/bilibili-fish-filter
// @version      1.0.3
// @description  白名单式 B 站评论过滤：三条规则（昵称含鱼 / 正文含 @ / 正文含主人）可独立设挡，取并集或交集。
// @homepageURL  https://github.com/deepseekmaid/bilibili-fish-filter
// @supportURL   https://github.com/deepseekmaid/bilibili-fish-filter/issues
// @downloadURL  https://raw.githubusercontent.com/deepseekmaid/bilibili-fish-filter/main/dist/bilibili-fish-filter.user.js
// @updateURL    https://raw.githubusercontent.com/deepseekmaid/bilibili-fish-filter/main/dist/bilibili-fish-filter.user.js
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
      if (!host.isConnected) {
        ROOTS.delete(host);
        changed = true;
        continue;
      }
      // 自定义元素可能先挂进 DOM、后挂 shadowRoot：每次复查，补上观察器
      const shadow = host.shadowRoot;
      if (shadow && !observed.has(shadow)) {
        observe(shadow);
        changed = true;
      }
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

    // 用 rAF：改完在下一帧绘制前生效，新评论不会先以“未过滤”的样子闪一下，
    // 页面高度也不会先涨再缩（滚动条抽搐的主要来源）。
    // 但浏览器会节流甚至完全不给 rAF（窗口被遮挡、调试模式、无绘制时），
    // 一旦 rAF 不回来，pending 会一直占着、后续所有重扫都被挡掉——所以配一个定时兜底。
    const token = { done: false, rafId: 0, timerId: 0 };
    pending = token;

    const run = () => {
      if (token.done) return;
      token.done = true;
      if (pending === token) pending = null;
      if (token.rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(token.rafId);
      if (token.timerId) clearTimeout(token.timerId);
      pass();
    };

    if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') {
      token.rafId = requestAnimationFrame(run);
      token.timerId = setTimeout(run, 200);
    } else {
      token.timerId = setTimeout(run, 60);
    }
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

    const rootEl = document.documentElement;
    const prevBehavior = rootEl.style.scrollBehavior;
    try {
      // 页面若开了 scroll-behavior: smooth，恢复位置会变成一段可见的动画
      rootEl.style.scrollBehavior = 'auto';
      window.scrollTo(0, bottom);
      window.dispatchEvent(new Event('scroll'));
      window.scrollTo(0, y);
      if (Math.abs((window.scrollY || 0) - y) > 1) window.scrollTo(0, y);
    } catch {
      return false;
    } finally {
      rootEl.style.scrollBehavior = prevBehavior;
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

  const BAF_VERSION = "1.0.3";
  const BAF_VERSION_NAME = "v1.03";
  const PANEL_CSS = "\n  :root { color-scheme: light; }\n  * { box-sizing: border-box; }\n  .baf-popup {\n    width: 328px; margin: 0; background: #ffffff; color: #1f2329;\n    font: 13px/1.5 \"Microsoft YaHei UI\", \"PingFang SC\", \"Segoe UI\", system-ui, sans-serif;\n    -webkit-font-smoothing: antialiased;\n  }\n  header { display: flex; gap: 9px; align-items: center; padding: 10px 14px 5px; }\n  header img { width: 26px; height: 26px; border-radius: 7px; flex: 0 0 auto; }\n  h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .2px; color: #1f2329; }\n  header p { margin: 2px 0 0; font-size: 11px; color: #8a91a0; }\n  .rulebar {\n    margin: 0 12px 5px; padding: 5px 9px; border-radius: 8px;\n    background: #f3f6ff; border: 1px solid #e3eaff;\n    font-size: 10px; line-height: 1.5; color: #55618a;\n  }\n  .rulebar b { color: #4d6bfe; font-weight: 600; }\n  .rulebar i { color: #e5484d; font-style: normal; }\n  main { padding: 0 6px 6px; }\n  .block { border-radius: 11px; border: 1px solid transparent; transition: background .16s, border-color .16s; }\n  .block + .block { margin-top: 5px; }\n  .block:hover { background: #f7f9fd; border-color: #edf1f8; }\n  .row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; }\n  .row .txt { flex: 1 1 auto; min-width: 0; }\n  .row b { display: block; font-size: 12.5px; font-weight: 600; color: #1f2329; }\n  .row code { font-size: 11px; color: #3b6fd4; background: #f3f6ff; padding: 0 3px; border-radius: 4px; }\n  .desc { display: block; margin-top: 3px; font-size: 10.5px; line-height: 1.5; color: #4b5563; }\n  input[type=checkbox] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }\n  .sw {\n    flex: 0 0 auto; width: 40px; height: 23px; border-radius: 12px;\n    background: #d9dee8; position: relative; transition: background .18s ease;\n  }\n  .sw::after {\n    content: \"\"; position: absolute; top: 3px; left: 3px;\n    width: 17px; height: 17px; border-radius: 50%;\n    background: #ffffff; box-shadow: 0 1px 3px rgba(31, 35, 41, .18);\n    transition: transform .18s ease;\n  }\n  input:checked + .sw { background: #4d6bfe; }\n  input:checked + .sw::after { transform: translateX(17px); }\n  input:focus-visible + .sw { outline: 2px solid #4d6bfe; outline-offset: 2px; }\n  .hint { padding: 0 8px 5px; font-size: 10.5px; line-height: 1.5; color: #6b7280; }\n  .sub { display: flex; align-items: center; gap: 8px; padding: 0 8px 6px; }\n  .sub .cap { font-size: 11px; color: #6b7280; }\n  .seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: #f2f5fa; border: 1px solid #e5eaf3; }\n  .seg button {\n    border: 0; background: transparent; color: #6b7280; cursor: pointer;\n    font: inherit; font-size: 11px; line-height: 1; padding: 5px 11px; border-radius: 6px;\n    transition: background .16s, color .16s;\n  }\n  .seg button:hover { color: #4d6bfe; }\n  .seg button.on { background: #4d6bfe; color: #ffffff; }\n  footer {\n    display: flex; align-items: center; justify-content: space-between; gap: 8px;\n    padding: 6px 14px 8px; border-top: 1px solid #eef1f6;\n    font-size: 11px; color: #6b7280;\n  }\n  .notice {\n    padding: 0 14px 4px; font-size: 10px; line-height: 1.6; color: #6b7280;\n  }\n  .diag {\n    padding: 3px 14px 0; font-size: 10px; line-height: 1.45; color: #6b7280;\n    border-top: 1px solid #eef1f6;\n  }\n  footer .saved { color: #16a34a; opacity: 0; transition: opacity .2s; }\n  footer .saved.on { opacity: 1; }\n  footer .ver { color: #9aa1ad; }";
  const PANEL_HTML = "<header>\n    <img src=\"data:image/png;base64,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\" alt=\"\">\n    <div>\n      <h1>B站大肥鱼过滤器</h1>\n      <p>白名单：命中的留下，其余删除</p>\n    </div>\n  </header>\n\n  <div class=\"notice\">没评论可显示时会自动加载更多（不滚动页面）</div>\n\n  <main>\n    <section class=\"block\" id=\"combineBlock\">\n      <div class=\"row\">\n        <div class=\"txt\"><b>规则组合</b></div>\n        <div class=\"seg\" id=\"combineSeg\">\n          <button type=\"button\" data-combine=\"union\" class=\"on\">并集</button>\n          <button type=\"button\" data-combine=\"intersect\">交集</button>\n        </div>\n      </div>\n      <div class=\"hint\">并集：命中任一就保留；交集：三条规则全命中才保留</div>\n    </section>\n\n    <section class=\"block\" id=\"fishBlock\">\n      <label class=\"row\">\n        <div class=\"txt\">\n          <b>规则一：昵称含「鱼」</b>\n          <span class=\"desc\">只留昵称带「鱼 / 魚」的评论。<b style=\"display:inline;color:#4d6bfe;white-space:nowrap\">默认开启</b></span>\n        </div>\n        <input type=\"checkbox\" id=\"modeFish\">\n        <span class=\"sw\"></span>\n      </label>\n    </section>\n\n    <section class=\"block\" id=\"atBlock\">\n      <div class=\"row\">\n        <div class=\"txt\">\n          <b>规则二：正文含 @</b>\n          <span class=\"desc\">带 <code>@</code> 的评论留下。</span>\n        </div>\n      </div>\n      <div class=\"sub\">\n        <div class=\"seg\" id=\"atSeg\">\n          <button type=\"button\" data-mode=\"contains\">包含 @</button>\n          <button type=\"button\" data-mode=\"startsWith\">以 @ 开头</button>\n          <button type=\"button\" data-mode=\"off\" class=\"on\">关</button>\n        </div>\n      </div>\n    </section>\n\n    <section class=\"block\" id=\"masterBlock\">\n      <div class=\"row\">\n        <div class=\"txt\">\n          <b>规则三：「主人」</b>\n          <span class=\"desc\">正文提到「主人」也留下。</span>\n        </div>\n      </div>\n      <div class=\"sub\">\n        <div class=\"seg\" id=\"masterSeg\">\n          <button type=\"button\" data-mode=\"contains\">包含主人</button>\n          <button type=\"button\" data-mode=\"startsWith\" class=\"on\">以主人开头</button>\n          <button type=\"button\" data-mode=\"off\">关</button>\n        </div>\n      </div>\n    </section>\n\n    <section class=\"block off\" id=\"autoBlock\">\n      <label class=\"row\">\n        <div class=\"txt\">\n          <b>一直加载到底</b>\n          <span class=\"desc\">不管有没有可显示的评论，都加载到全部加载完。</span>\n        </div>\n        <input type=\"checkbox\" id=\"autoLoad\">\n        <span class=\"sw\"></span>\n      </label>\n    </section>\n\n    <section class=\"block off\" id=\"fastBlock\">\n      <label class=\"row\">\n        <div class=\"txt\">\n          <b>快速模式</b>\n          <span class=\"desc\">加载时不逐页过滤、请求零等待；可能短暂露出未过滤评论。</span>\n        </div>\n        <input type=\"checkbox\" id=\"fastMode\">\n        <span class=\"sw\"></span>\n      </label>\n    </section>\n  </main>\n\n  <div class=\"notice\">注意：规则二、三都选「以…开头」且组合为交集时，一条评论都不会显示。</div>\n  <div class=\"diag\" id=\"diag\">自动加载：待检测</div>\n\n  <footer>\n    <span id=\"count\">正在读取本页…</span>\n    <span class=\"saved\" id=\"saved\">已保存</span>\n    <span class=\"ver\" id=\"ver\">v1.03</span>\n  </footer>";
  const BAF_DISPLAY_VERSION = "1.03";
  const FAB_ICON = "data:image/png;base64,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";

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
    // 旧版本（≤1.6）存的是布尔 modeAt；content.js 会把它迁移成「包含 @」，面板要跟着显示，否则会与真实过滤不一致
    atMode = value.atMode === 'contains' || value.atMode === 'startsWith'
      ? value.atMode
      : value.modeAt === true
        ? 'contains'
        : 'off';
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
      const finish = (upEvent) => {
        document.removeEventListener(DRAG_MOVE, onMove, true);
        document.removeEventListener(DRAG_UP, finish, true);
        document.removeEventListener('pointercancel', finish, true);
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

  // BAF:BOOT —— 构建油猴版时，适配层与设置面板会插在这一行之前
  installScrollbarStability();
  loadSettings();
  pass();
  AUTO_READY = true;
  maybeAutoLoad();

  setupPanel();
})();
