// ==UserScript==
// @name         B站大肥鱼过滤器（油猴版）
// @namespace    https://github.com/deepseekmaid/bilibili-fish-filter
// @version      1.0.6
// @description  B 站评论过滤：四条规则（昵称含鱼 / 正文含 @ / 正文含主人 / 自定义昵称与评论词）可独立设挡，取并集或交集，可选保留或隐藏命中的评论。
// @homepageURL  https://github.com/deepseekmaid/bilibili-fish-filter
// @supportURL   https://github.com/deepseekmaid/bilibili-fish-filter/issues
// @license      MIT
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
 * 过滤评论：默认白名单（命中的留下，其余隐藏），可切黑名单（命中的隐藏，其余保留）。
 * 只改当前页面 DOM，不改任何数据。
 *
 * 过滤方式 filterMode：
 *   'whitelist'（默认，白名单）：命中的留下，其余隐藏
 *   'blacklist'（黑名单）：命中的隐藏，其余保留
 *
 * 四条规则，可单独设挡：
 *   atMode     : 规则二「正文含 @」—— 'contains' 包含 @ / 'startsWith' 以 @ 开头 / 'off' 关
 *   modeFish   : 规则一「昵称含鱼」—— true 时昵称含「鱼 / 魚」即命中
 *   masterMode : 规则三「主人」—— 'contains' 包含 / 'startsWith' 以主人开头 / 'off' 关
 *   modeCustom : 规则四「自定义词语」—— true 时按 customCombine 组合两栏词表（单栏有词时按该栏判）
 *   customNameWords: 昵称自定义词（最多 20 个，每个 ≤ 20 字）
 *   customTextWords: 评论正文自定义词（同上）
 *   customCombine: 规则四内部两栏的组合方式—— 'union'（默认，任一栏命中）/ 'intersect'（两栏都命中）
 *
 * 组合方式 combine：
 *   'union'（默认，并集）：命中任意一条即保留
 *   'intersect'（交集）：所有启用的规则都命中才保留
 *   规则全部关掉时不做任何隐藏。
 *
 * 自动加载（都不滚动页面）：
 *   - 默认：加载到出现第一条「能显示」的评论就停；
 *   - autoLoad：一直加载到评论区全部加载完（默认关）；
 *   - fastMode：加载期间不逐页过滤，结束后统一过滤一次（默认关）。
 */
(() => {
  'use strict';

  const DEFAULTS = { filterMode: 'whitelist', atMode: 'off', modeFish: true, masterMode: 'startsWith', combine: 'union', autoLoad: false, fastMode: false, modeCustom: false, customNameWords: [], customTextWords: [], customCombine: 'union' };
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

  function sanitizeWords(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
      const word = String(raw ?? '').trim();
      if (!word || word.length > 20) continue;
      if (!out.includes(word)) out.push(word);
      if (out.length >= 20) break;
    }
    return out;
  }

  function normalize(raw) {
    const legacyWords = sanitizeWords(raw?.customWords);
    const nameWords = sanitizeWords(raw?.customNameWords);
    let textWords = sanitizeWords(raw?.customTextWords);
    // 旧版只有一个 customWords 列表：仅当两栏都没有词时按评论词回填，
    // 避免把评论词同时当成昵称词（那样会让昵称含这些词的评论被误放行）。
    if (!nameWords.length && !textWords.length && legacyWords.length) textWords = legacyWords;
    return {
      filterMode: raw?.filterMode === 'blacklist' ? 'blacklist' : 'whitelist',
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
      modeCustom: raw?.modeCustom === true,
      customNameWords: nameWords,
      customTextWords: textWords,
      customCombine: raw?.customCombine === 'intersect' ? 'intersect' : 'union',
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
    if (settings.modeCustom) {
      const hitName = settings.customNameWords.length
        && settings.customNameWords.some((word) => name.toLowerCase().includes(word.toLowerCase()));
      const hitText = settings.customTextWords.length
        && settings.customTextWords.some((word) => text.toLowerCase().includes(word.toLowerCase()));
      const hasName = settings.customNameWords.length > 0;
      const hasText = settings.customTextWords.length > 0;
      if (hasName || hasText) {
        // 只有一栏有词时按这一栏判；两栏都有词时按规则四自己的并/交设置判
        const both = hasName && hasText;
        const hit = both
          ? (settings.customCombine === 'intersect' ? (hitName && hitText) : (hitName || hitText))
          : (hasName ? hitName : hitText);
        rules.push(Boolean(hit));
      }
    }

    if (!rules.length) return false;

    // combine 只决定「规则算不算命中」；命中之后是保留还是隐藏由 filterMode 决定。
    // 白名单：并集 = 任一条命中就保留，交集 = 全部命中才保留；
    // 黑名单：并集 = 任一条命中就隐藏，交集 = 全部命中才隐藏。
    const hit = settings.combine === 'intersect' ? rules.every(Boolean) : rules.some(Boolean);
    return settings.filterMode === 'blacklist' ? hit : !hit;
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

  /** 已挂上的观察器：断开时要用，否则 SPA 换页会留下对已卸载 shadow 根的引用。 */
  const observers = new Map();

  function observe(root) {
    if (!root || observed.has(root) || typeof MutationObserver !== 'function') return;
    try {
      const observer = new MutationObserver(schedule);
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      observed.add(root);
      observers.set(root, observer);
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
        // 评论区被页面卸载了：断开它的观察器，避免一直持有已脱离的 shadow 根
        const shadow = host.shadowRoot;
        const observer = shadow ? observers.get(shadow) : null;
        if (observer) {
          try { observer.disconnect(); } catch { /* ignore */ }
          observers.delete(shadow);
          observed.delete(shadow);
        }
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

      let result;
      try {
        result = autoTick();
      } catch (error) {
        // 任何一次异常都不能让循环「活着但不再跑」：那会导致自动加载永久卡住，
        // 而且 maybeAutoLoad 看到 running=true 也不会再启动。
        console.warn('[大肥鱼过滤器] 自动加载出错，5 秒后重试', error);
        AUTO.running = false;
        if (AUTO.timer) clearTimeout(AUTO.timer);
        AUTO.timer = null;
        AUTO.gaveUp = false;
        AUTO.cooldown = Date.now() + 5000;
        schedule();
        return;
      }
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

  const BAF_VERSION = "1.0.6";
  const BAF_VERSION_NAME = "v1.06";
  const PANEL_CSS = "\n  :root { color-scheme: light; }\n  * { box-sizing: border-box; }\n  .baf-popup {\n    width: 328px; margin: 0; background: #ffffff; color: #1f2329;\n    font: 13px/1.5 \"Microsoft YaHei UI\", \"PingFang SC\", \"Segoe UI\", system-ui, sans-serif;\n    -webkit-font-smoothing: antialiased;\n  }\n  header { display: flex; gap: 9px; align-items: center; padding: 10px 14px 5px; }\n  header img { width: 26px; height: 26px; border-radius: 7px; flex: 0 0 auto; }\n  h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .2px; color: #1f2329; }\n  header p { margin: 2px 0 0; font-size: 11px; color: #8a91a0; }\n  .rulebar {\n    margin: 0 12px 5px; padding: 5px 9px; border-radius: 8px;\n    background: #f3f6ff; border: 1px solid #e3eaff;\n    font-size: 10px; line-height: 1.5; color: #55618a;\n  }\n  .rulebar b { color: #4d6bfe; font-weight: 600; }\n  .rulebar i { color: #e5484d; font-style: normal; }\n  main { padding: 0 6px 6px; }\n  .block { border-radius: 11px; border: 1px solid transparent; transition: background .16s, border-color .16s; }\n  .block + .block { margin-top: 5px; }\n  .block:not(.custom):hover { background: #f7f9fd; border-color: #edf1f8; }\n  .row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; }\n  .row .txt { flex: 1 1 auto; min-width: 0; }\n  .row b { display: block; font-size: 12.5px; font-weight: 600; color: #1f2329; }\n  .row code { font-size: 11px; color: #3b6fd4; background: #f3f6ff; padding: 0 3px; border-radius: 4px; }\n  .desc { display: block; margin-top: 3px; font-size: 10.5px; line-height: 1.5; color: #4b5563; }\n  input[type=checkbox] { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }\n  .sw {\n    flex: 0 0 auto; width: 40px; height: 23px; border-radius: 12px;\n    background: #d9dee8; position: relative; transition: background .18s ease;\n  }\n  .sw::after {\n    content: \"\"; position: absolute; top: 3px; left: 3px;\n    width: 17px; height: 17px; border-radius: 50%;\n    background: #ffffff; box-shadow: 0 1px 3px rgba(31, 35, 41, .18);\n    transition: transform .18s ease;\n  }\n  input:checked + .sw { background: #4d6bfe; }\n  input:checked + .sw::after { transform: translateX(17px); }\n  input:focus-visible + .sw { outline: 2px solid #4d6bfe; outline-offset: 2px; }\n  .hint { padding: 0 8px 5px; font-size: 10.5px; line-height: 1.5; color: #6b7280; }\n  .sub { display: flex; align-items: center; gap: 8px; padding: 0 8px 6px; }\n  .sub .cap { font-size: 11px; color: #6b7280; }\n  .seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: #f2f5fa; border: 1px solid #e5eaf3; }\n  .seg button {\n    border: 0; background: transparent; color: #6b7280; cursor: pointer;\n    font: inherit; font-size: 11px; line-height: 1; padding: 5px 11px; border-radius: 6px;\n    transition: background .16s, color .16s;\n  }\n  .seg button:hover { color: #4d6bfe; }\n  .seg button.on { background: #4d6bfe; color: #ffffff; }\n  .rulesWrap { position: relative; }\n  .block.off { opacity: .58; }\n  .custom {\n    position: absolute; right: 6px; top: 1px; width: 112px; height: 168px; margin-top: 0;\n    display: flex; flex-direction: column; gap: 4px;\n    padding: 5px 6px; border-radius: 10px; border: 1px solid #e3eaff;\n    background: linear-gradient(180deg, #fbfcff 0%, #f4f7ff 100%);\n    transition: opacity .16s ease, border-color .16s ease;\n  }\n  .custom.off { opacity: .62; }\n  .cHead { display: flex; align-items: center; justify-content: space-between; gap: 4px; }\n  .cHead b { font-size: 10px; font-weight: 600; color: #1f2329; white-space: nowrap; }\n  .cSeg { display: inline-flex; gap: 1px; padding: 1px; border-radius: 5px; background: #eef2fb; border: 1px solid #dfe6f6; }\n  .cSeg button { border: 0; background: transparent; font: inherit; font-size: 9px; line-height: 1; padding: 2px 3px; border-radius: 4px; color: #6b7280; cursor: pointer; }\n  .cSeg button.on { background: #4d6bfe; color: #fff; }\n  .cHead { gap: 2px; }\n  .cSw { position: relative; display: inline-flex; width: 28px; height: 16px; cursor: pointer; flex: 0 0 auto; }\n  .cSw input { position: absolute; opacity: 0; width: 0; height: 0; }\n  .cSw span { width: 28px; height: 16px; border-radius: 9px; background: #d9dee8; position: relative; transition: background .18s ease; }\n  .cSw span::after { content: \"\"; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(31,35,41,.2); transition: transform .18s ease; }\n  .cSw input:checked + span { background: #4d6bfe; }\n  .cSw input:checked + span::after { transform: translateX(12px); }\n  .cSw input:focus-visible + span { outline: 2px solid #4d6bfe; outline-offset: 2px; }\n  .cField { display: flex; flex-direction: column; gap: 2px; }\n  .cLabel { font-size: 9px; line-height: 1.2; color: #6b7280; }\n  .cInput { display: flex; gap: 3px; }\n  .cInput input {\n    flex: 1 1 auto; min-width: 0; height: 20px; padding: 0 4px;\n    border: 1px solid #dbe3f5; border-radius: 5px; background: #fff;\n    font: inherit; font-size: 10px; color: #1f2329; outline: none;\n  }\n  .cInput input:focus { border-color: #4d6bfe; box-shadow: 0 0 0 2px rgba(77,107,254,.12); }\n  .cInput button {\n    flex: 0 0 auto; width: 20px; height: 20px; border: 0; border-radius: 5px;\n    background: #4d6bfe; color: #fff; font-size: 13px; line-height: 1; cursor: pointer; padding: 0;\n  }\n  .cInput button:disabled { background: #c9d3ee; cursor: default; }\n  .cChips { flex: 0 0 auto; max-height: 30px; overflow-y: auto; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 2px; }\n  .cChips::-webkit-scrollbar { width: 3px; }\n  .cChips::-webkit-scrollbar-thumb { background: #d8e0f2; border-radius: 2px; }\n  .cChip { display: inline-flex; align-items: center; gap: 1px; max-width: 100%; padding: 0 3px; border-radius: 4px; border: 1px solid #dfe6f6; background: #fff; font-size: 9.5px; line-height: 1.45; color: #33415c; }\n  .cChip em { font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 68px; }\n  .cChip button { border: 0; background: transparent; color: #9aa1ad; font-size: 10px; line-height: 1; padding: 0; cursor: pointer; }\n  .cChip button:hover { color: #e5484d; }\n  footer {\n    display: flex; align-items: center; justify-content: space-between; gap: 8px;\n    padding: 6px 14px 8px; border-top: 1px solid #eef1f6;\n    font-size: 11px; color: #6b7280;\n  }\n  .notice {\n    padding: 0 14px 4px; font-size: 10px; line-height: 1.6; color: #6b7280;\n  }\n  .diag {\n    padding: 3px 14px 0; font-size: 10px; line-height: 1.45; color: #6b7280;\n    border-top: 1px solid #eef1f6;\n  }\n  footer .saved { color: #16a34a; opacity: 0; transition: opacity .2s; }\n  footer .saved.err { color: #e5484d; }\n  footer .saved.on { opacity: 1; }\n  footer .ver { color: #9aa1ad; }";
  const PANEL_HTML = "<header>\n    <img src=\"data:image/png;base64,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\" alt=\"\">\n    <div>\n      <h1>B站大肥鱼过滤器</h1>\n      <p id=\"subtitle\">白名单：命中的留下，其余删除</p>\n    </div>\n  </header>\n\n  <div class=\"notice\">没评论可显示时会自动加载更多（不滚动页面）</div>\n\n  <main>\n    <section class=\"block\" id=\"filterBlock\">\n      <div class=\"row\">\n        <div class=\"txt\"><b>过滤方式</b></div>\n        <div class=\"seg\" id=\"filterSeg\">\n          <button type=\"button\" data-filter=\"whitelist\" class=\"on\">保留命中</button>\n          <button type=\"button\" data-filter=\"blacklist\">隐藏命中</button>\n        </div>\n      </div>\n      <div class=\"hint\" id=\"filterHint\">白名单：命中规则的留下，其余隐藏</div>\n    </section>\n\n    <section class=\"block\" id=\"combineBlock\">\n      <div class=\"row\">\n        <div class=\"txt\"><b>规则组合</b></div>\n        <div class=\"seg\" id=\"combineSeg\">\n          <button type=\"button\" data-combine=\"union\" class=\"on\">并集</button>\n          <button type=\"button\" data-combine=\"intersect\">交集</button>\n        </div>\n      </div>\n      <div class=\"hint\" id=\"combineHint\">并集：命中任一就保留；交集：所有启用的规则都命中才保留</div>\n    </section>\n\n    <section class=\"block\" id=\"fishBlock\">\n      <label class=\"row\">\n        <div class=\"txt\">\n          <b>规则一：昵称含「鱼」</b>\n          <span class=\"desc\">只留昵称带「鱼 / 魚」的评论。<b style=\"display:inline;color:#4d6bfe;white-space:nowrap\">默认开启</b></span>\n        </div>\n        <input type=\"checkbox\" id=\"modeFish\">\n        <span class=\"sw\"></span>\n      </label>\n    </section>\n\n    <div class=\"rulesWrap\">\n    <section class=\"block\" id=\"atBlock\">\n      <div class=\"row\">\n        <div class=\"txt\">\n          <b>规则二：正文含 @</b>\n          <span class=\"desc\">带 <code>@</code> 的评论留下。</span>\n        </div>\n      </div>\n      <div class=\"sub\">\n        <div class=\"seg\" id=\"atSeg\">\n          <button type=\"button\" data-mode=\"contains\">包含 @</button>\n          <button type=\"button\" data-mode=\"startsWith\">以 @ 开头</button>\n          <button type=\"button\" data-mode=\"off\" class=\"on\">关</button>\n        </div>\n      </div>\n    </section>\n\n    <section class=\"block\" id=\"masterBlock\">\n      <div class=\"row\">\n        <div class=\"txt\">\n          <b>规则三：「主人」</b>\n          <span class=\"desc\">正文提到「主人」也留下。</span>\n        </div>\n      </div>\n      <div class=\"sub\">\n        <div class=\"seg\" id=\"masterSeg\">\n          <button type=\"button\" data-mode=\"contains\">包含主人</button>\n          <button type=\"button\" data-mode=\"startsWith\" class=\"on\">以主人开头</button>\n          <button type=\"button\" data-mode=\"off\">关</button>\n        </div>\n      </div>\n    </section>\n\n    <section class=\"block custom off\" id=\"customBlock\" aria-label=\"规则四：自定义昵称与评论词\">\n      <div class=\"cHead\">\n        <b>规则四</b>\n        <div class=\"cSeg\" id=\"customCombineSeg\" title=\"规则四内部：昵称栏与评论栏如何组合\">\n          <button type=\"button\" data-ccombine=\"union\" class=\"on\" aria-label=\"规则四：两栏任一命中\">并</button>\n          <button type=\"button\" data-ccombine=\"intersect\" aria-label=\"规则四：两栏都命中\">交</button>\n        </div>\n        <label class=\"cSw\" title=\"启用规则四\">\n          <input type=\"checkbox\" id=\"modeCustom\" aria-label=\"启用规则四：自定义词语\">\n          <span></span>\n        </label>\n      </div>\n      <div class=\"cField\">\n        <label class=\"cLabel\" for=\"customNameInput\">自定义昵称</label>\n        <div class=\"cInput\">\n          <input id=\"customNameInput\" type=\"text\" maxlength=\"20\" placeholder=\"昵称词\" autocomplete=\"off\">\n          <button id=\"customNameAdd\" type=\"button\" title=\"添加昵称词\" aria-label=\"添加昵称词\">+</button>\n        </div>\n        <div class=\"cChips\" id=\"customNameChips\"></div>\n      </div>\n      <div class=\"cField\">\n        <label class=\"cLabel\" for=\"customTextInput\">自定义评论</label>\n        <div class=\"cInput\">\n          <input id=\"customTextInput\" type=\"text\" maxlength=\"20\" placeholder=\"评论词\" autocomplete=\"off\">\n          <button id=\"customTextAdd\" type=\"button\" title=\"添加评论词\" aria-label=\"添加评论词\">+</button>\n        </div>\n        <div class=\"cChips\" id=\"customTextChips\"></div>\n      </div>\n    </section>\n    </div>\n\n    <section class=\"block off\" id=\"autoBlock\">\n      <label class=\"row\">\n        <div class=\"txt\">\n          <b>一直加载到底</b>\n          <span class=\"desc\">不管有没有可显示的评论，都加载到全部加载完。</span>\n        </div>\n        <input type=\"checkbox\" id=\"autoLoad\">\n        <span class=\"sw\"></span>\n      </label>\n    </section>\n\n    <section class=\"block off\" id=\"fastBlock\">\n      <label class=\"row\">\n        <div class=\"txt\">\n          <b>快速模式</b>\n          <span class=\"desc\">加载时不逐页过滤、请求零等待；可能短暂露出未过滤评论。</span>\n        </div>\n        <input type=\"checkbox\" id=\"fastMode\">\n        <span class=\"sw\"></span>\n      </label>\n    </section>\n  </main>\n\n  <div class=\"notice\" id=\"emptyNotice\">注意：规则二、三都选「以…开头」且组合为交集、规则四又没命中时，一条评论都不会显示。</div>\n  <div class=\"diag\" id=\"diag\">自动加载：待检测</div>\n\n  <footer>\n    <span id=\"count\">正在读取本页…</span>\n    <span class=\"saved\" id=\"saved\" role=\"status\" aria-live=\"polite\">已保存</span>\n    <span class=\"ver\" id=\"ver\">v1.06</span>\n  </footer>";
  const BAF_DISPLAY_VERSION = "1.06";
  const FAB_ICON = "data:image/webp;base64,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";

  /* ===== 下面是 popup.js 原文，作为函数体在面板里运行 ===== */
  function bafPopupMain(chrome, document, globalThis) {
/* B站大肥鱼过滤器 — 设置面板 */
const DEFAULTS = { filterMode: 'whitelist', atMode: 'off', modeFish: true, masterMode: 'startsWith', combine: 'union', autoLoad: false, fastMode: false, modeCustom: false, customNameWords: [], customTextWords: [], customCombine: 'union' };

// 白名单与黑名单下，同一套规则的「保留 / 隐藏」语义正好反过来，文案要跟着换
const TEXT = {
  whitelist: {
    subtitle: '白名单：命中的留下，其余删除',
    filterHint: '白名单：命中规则的留下，其余隐藏',
    combineHint: '并集：命中任一就保留；交集：所有启用的规则都命中才保留',
    emptyNotice: '注意：规则二、三都选「以…开头」且组合为交集、规则四又没命中时，一条评论都不会显示。',
  },
  blacklist: {
    subtitle: '黑名单：命中的隐藏，其余保留',
    filterHint: '黑名单：命中规则的隐藏，其余保留',
    combineHint: '并集：命中任一就隐藏；交集：所有启用的规则都命中才隐藏',
    emptyNotice: '提示：黑名单下选交集时，只有同时命中所有启用规则的评论才会被隐藏。',
  },
};

const fish = document.getElementById('modeFish');
const auto = document.getElementById('autoLoad');
const fast = document.getElementById('fastMode');
const fishBlock = document.getElementById('fishBlock');
const autoBlock = document.getElementById('autoBlock');
const fastBlock = document.getElementById('fastBlock');
const filterSeg = document.getElementById('filterSeg');
const filterHint = document.getElementById('filterHint');
const combineHint = document.getElementById('combineHint');
const emptyNotice = document.getElementById('emptyNotice');
const subtitle = document.getElementById('subtitle');
const combineSeg = document.getElementById('combineSeg');
const atSeg = document.getElementById('atSeg');
const masterSeg = document.getElementById('masterSeg');
const saved = document.getElementById('saved');
const count = document.getElementById('count');
const diag = document.getElementById('diag');
const ver = document.getElementById('ver');
const customBox = document.getElementById('modeCustom');
const customBlock = document.getElementById('customBlock');
const customCombineSeg = document.getElementById('customCombineSeg');
const customNameInput = document.getElementById('customNameInput');
const customNameAdd = document.getElementById('customNameAdd');
const customNameChips = document.getElementById('customNameChips');
const customTextInput = document.getElementById('customTextInput');
const customTextAdd = document.getElementById('customTextAdd');
const customTextChips = document.getElementById('customTextChips');

const LISTS = {
  name: {
    get: () => customNameWords,
    set: (next) => { customNameWords = next; },
    input: customNameInput,
    add: customNameAdd,
    chips: customNameChips,
    render: () => renderChips(customNameWords, customNameChips),
  },
  text: {
    get: () => customTextWords,
    set: (next) => { customTextWords = next; },
    input: customTextInput,
    add: customTextAdd,
    chips: customTextChips,
    render: () => renderChips(customTextWords, customTextChips),
  },
};

let timer = null;
let filterMode = DEFAULTS.filterMode;
let atMode = DEFAULTS.atMode;
let combine = DEFAULTS.combine;
let masterMode = DEFAULTS.masterMode;
let customNameWords = [];
let customTextWords = [];
let customCombine = DEFAULTS.customCombine;

try {
  const m = chrome.runtime.getManifest();
  ver.textContent = m.version_name || 'v' + m.version;
} catch {}

function flash(error) {
  if (!saved) return;
  saved.textContent = error ? '保存失败' : '已保存';
  saved.classList.toggle('err', Boolean(error));
  saved.classList.add('on');
  clearTimeout(timer);
  timer = setTimeout(() => saved.classList.remove('on'), error ? 2000 : 1200);
}

function paintSeg(seg, value) {
  if (!seg) return;
  for (const btn of seg.querySelectorAll('button')) {
    const key = btn.dataset.mode || btn.dataset.combine || btn.dataset.filter;
    const on = key === value;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

function sanitizeWords(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const word = String(raw ?? '').trim();
    if (!word || word.length > 20) continue;
    if (!out.includes(word)) out.push(word);
    if (out.length >= 20) break;
  }
  return out;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function renderChips(words, container) {
  if (!container) return;
  // 重绘会重置滚动位置；删一个词后别把用户甩回列表顶部
  const scrollTop = container.scrollTop;
  container.innerHTML = words.map((word, index) =>
    '<span class="cChip"><em>' + escapeHtml(word) + '</em>'
    + '<button type="button" data-index="' + index + '" title="删除「' + escapeHtml(word) + '」" aria-label="删除「' + escapeHtml(word) + '」">×</button></span>'
  ).join('');
  container.scrollTop = scrollTop;
}

function renderAllChips() {
  renderChips(customNameWords, customNameChips);
  renderChips(customTextWords, customTextChips);
}

function addWord(kind) {
  const entry = LISTS[kind];
  if (!entry || !entry.input) return;
  const word = entry.input.value.trim();
  const words = entry.get();
  if (!word || word.length > 20) return;
  // 到上限时保留输入框内容，别把用户刚打的词静默吞掉
  if (words.length >= 20) return;
  if (!words.includes(word)) {
    entry.set(words.concat(word));
    entry.render();
    syncAddButtons();
    persist({ [kind === 'name' ? 'customNameWords' : 'customTextWords']: entry.get() });
  }
  entry.input.value = '';
}

function removeWord(kind, index) {
  const entry = LISTS[kind];
  if (!entry) return;
  entry.set(entry.get().filter((_, i) => i !== index));
  entry.render();
  syncAddButtons();
  persist({ [kind === 'name' ? 'customNameWords' : 'customTextWords']: entry.get() });
}

function syncAddButtons() {
  if (customNameAdd) customNameAdd.disabled = customNameWords.length >= 20;
  if (customTextAdd) customTextAdd.disabled = customTextWords.length >= 20;
}

function paintCustomSeg() {
  if (!customCombineSeg) return;
  for (const btn of customCombineSeg.querySelectorAll('button')) {
    const on = btn.dataset.ccombine === customCombine;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

function paint() {
  fishBlock.classList.toggle('off', !fish.checked);
  autoBlock.classList.toggle('off', !auto.checked);
  fastBlock.classList.toggle('off', !fast.checked);
  paintSeg(filterSeg, filterMode);
  paintSeg(combineSeg, combine);
  paintSeg(atSeg, atMode);
  paintSeg(masterSeg, masterMode);
  paintCustomSeg();
  if (customBox && customBlock) {
    customBlock.classList.toggle('off', !customBox.checked);
  }
  const text = TEXT[filterMode === 'blacklist' ? 'blacklist' : 'whitelist'];
  if (subtitle) subtitle.textContent = text.subtitle;
  if (filterHint) filterHint.textContent = text.filterHint;
  if (combineHint) combineHint.textContent = text.combineHint;
  if (emptyNotice) emptyNotice.textContent = text.emptyNotice;
  syncAddButtons();
}

function persist(patch) {
  // 只写本次真正改动的键：一次把所有键（尤其两个词表）写回，会用本窗口的旧值
  // 覆盖另一个窗口/另一台设备刚加的词语。
  const payload = patch || {
    filterMode,
    combine,
    atMode,
    modeFish: fish.checked,
    masterMode,
    autoLoad: auto.checked,
    fastMode: fast.checked,
    modeCustom: customBox ? customBox.checked : false,
    customNameWords,
    customTextWords,
    customCombine,
  };
  chrome.storage.sync.set(payload, () => {
    // 写入失败时别假装已保存：内容脚本收不到变更，用户会以为规则生效了
    if (chrome.runtime && chrome.runtime.lastError) {
      flash(true);
      return;
    }
    // 词表一旦由新字段接管，就清掉旧版 customWords；否则用户把词删光后，
    // 下次加载 normalize 会以为「两栏都空 = 还没迁移」，把旧词又回填进评论栏。
    if (patch && ('customNameWords' in patch || 'customTextWords' in patch)) {
      try {
        chrome.storage.sync.remove?.('customWords', () => { void chrome.runtime.lastError; });
      } catch { /* 旧字段不存在或环境不支持 */ }
    }
    flash(false);
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

function bindSeg(seg, key, apply) {
  if (!seg) return;
  seg.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (!btn) return;
    apply(btn.dataset.mode);
    paint();
    persist({ [key]: btn.dataset.mode });
  });
}

function bindCustom() {
  for (const kind of ['name', 'text']) {
    const entry = LISTS[kind];
    if (entry.add) entry.add.addEventListener('click', () => addWord(kind));
    if (entry.input) {
      entry.input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        // 中文输入法选词时按 Enter 只是上屏，不能当成「添加」
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        addWord(kind);
      });
    }
    if (entry.chips) {
      entry.chips.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-index]');
        if (!btn) return;
        removeWord(kind, Number(btn.dataset.index));
      });
    }
  }
}

if (globalThis.chrome?.storage?.sync) {
  chrome.storage.sync.get(DEFAULTS, (value) => {
    // 读取失败时回调可能拿到 undefined：按默认值渲染，别让面板白屏
    value = value || {};
    fish.checked = value.modeFish !== false;
    auto.checked = value.autoLoad === true;
    fast.checked = value.fastMode === true;
    filterMode = value.filterMode === 'blacklist' ? 'blacklist' : 'whitelist';
    combine = value.combine === 'intersect' ? 'intersect' : 'union';
    // 旧版本（≤1.6）存的是布尔 modeAt；content.js 会把它迁移成「包含 @」，面板要跟着显示，否则会与真实过滤不一致
    atMode = value.atMode === 'contains' || value.atMode === 'startsWith'
      ? value.atMode
      : value.modeAt === true
        ? 'contains'
        : 'off';
    masterMode = value.masterMode === 'contains' || value.masterMode === 'off' ? value.masterMode : 'startsWith';
    if (customBox) customBox.checked = value.modeCustom === true;
    customNameWords = sanitizeWords(value.customNameWords);
    customTextWords = sanitizeWords(value.customTextWords);
    if (!customNameWords.length && !customTextWords.length) {
      customTextWords = sanitizeWords(value.customWords);
    }
    customCombine = value.customCombine === 'intersect' ? 'intersect' : 'union';
    renderAllChips();
    paint();
    readCount();
  });

  const SWITCH_KEYS = new Map([[fish, 'modeFish'], [auto, 'autoLoad'], [fast, 'fastMode'], [customBox, 'modeCustom']]);
  for (const box of [fish, auto, fast, customBox].filter(Boolean)) {
    box.addEventListener('change', () => {
      paint();
      persist({ [SWITCH_KEYS.get(box)]: box.checked });
    });
  }

  if (filterSeg) {
    filterSeg.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-filter]');
      if (!btn) return;
      filterMode = btn.dataset.filter === 'blacklist' ? 'blacklist' : 'whitelist';
      paint();
      persist({ filterMode });
    });
  }

  if (combineSeg) {
    combineSeg.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-combine]');
      if (!btn) return;
      combine = btn.dataset.combine === 'intersect' ? 'intersect' : 'union';
      paint();
      persist({ combine });
    });
  }

  bindSeg(atSeg, 'atMode', (next) => {
    atMode = next === 'contains' || next === 'startsWith' ? next : 'off';
  });
  bindSeg(masterSeg, 'masterMode', (next) => {
    masterMode = next === 'contains' || next === 'off' ? next : 'startsWith';
  });
  bindCustom();
  if (customCombineSeg) {
    customCombineSeg.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-ccombine]');
      if (!btn) return;
      customCombine = btn.dataset.ccombine === 'intersect' ? 'intersect' : 'union';
      paint();
      persist({ customCombine });
    });
  }
} else {
  // 脱离扩展环境（例如直接预览 popup.html）时按默认值渲染
  fish.checked = DEFAULTS.modeFish;
  auto.checked = DEFAULTS.autoLoad;
  fast.checked = DEFAULTS.fastMode;
  filterMode = DEFAULTS.filterMode;
  combine = DEFAULTS.combine;
  atMode = DEFAULTS.atMode;
  masterMode = DEFAULTS.masterMode;
  if (customBox) customBox.checked = DEFAULTS.modeCustom;
  customNameWords = DEFAULTS.customNameWords.slice();
  customTextWords = DEFAULTS.customTextWords.slice();
  customCombine = DEFAULTS.customCombine;
  renderAllChips();
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
  // 登记当前拖拽的收尾函数：失焦、可见性变化、或下一次按下时用它兜底
  let activeDragFinish = null;
  function runActiveDragFinish() {
    const fn = activeDragFinish;
    activeDragFinish = null;
    if (fn) fn();
  }
  const DRAG_USE_POINTER = typeof window.PointerEvent === 'function';
  const DRAG_DOWN = DRAG_USE_POINTER ? 'pointerdown' : 'mousedown';
  const DRAG_MOVE = DRAG_USE_POINTER ? 'pointermove' : 'mousemove';
  const DRAG_UP = DRAG_USE_POINTER ? 'pointerup' : 'mouseup';

  /** 按住面板任意空白处（顶栏、标题、底部留白）即可拖动；位移存进 GM 存储。 */
  function makePanelDraggable() {
    if (!panelWindow || panelWindow.dataset.bafDrag === '1') return;
    panelWindow.dataset.bafDrag = '1';

    const isInteractive = (target) => {
      if (!target || typeof target.closest !== 'function') return false;
      return Boolean(target.closest(NO_DRAG_SEL));
    };

    panelWindow.addEventListener(DRAG_DOWN, (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      // 上一次拖拽若卡住了（在窗口外松手），先收尾再重新开始
      if (panelDragging) runActiveDragFinish();
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
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        activeDragFinish = null;
        document.removeEventListener(DRAG_MOVE, onMove, true);
        document.removeEventListener(DRAG_UP, finish, true);
        document.removeEventListener('pointercancel', finish, true);
        document.removeEventListener('lostpointercapture', finish, true);
        document.removeEventListener('blur', finish, true);
        document.removeEventListener('visibilitychange', onVisibility, true);
        document.documentElement.style.userSelect = prevUserSelect;
        panelWindow.classList.remove('is-dragging');
        panelDragging = false;
        storeSet(PANEL_POS_KEY, { x: panelOffset.x, y: panelOffset.y });
        try { panelWindow.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
      };
      const onVisibility = () => { if (document.visibilityState === 'hidden') finish(); };
      activeDragFinish = finish;

      // 指针捕获：鼠标拖到窗口外松手时，pointerup 仍会回到这里
      try { panelWindow.setPointerCapture?.(event.pointerId); } catch { /* ignore */ }

      // 用捕获阶段监听：页面自己的 pointermove 处理不会把事件吃掉
      document.addEventListener(DRAG_MOVE, onMove, true);
      document.addEventListener(DRAG_UP, finish, true);
      document.addEventListener('pointercancel', finish, true);
      document.addEventListener('lostpointercapture', finish, true);
      document.addEventListener('blur', finish, true);
      document.addEventListener('visibilitychange', onVisibility, true);
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
      // 上一次拖拽若卡住（窗口外松手），先收尾，保证下一次按下一定生效
      if (fabDragging) runActiveDragFinish();
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
      let finished = false;
      const finish = (upEvent) => {
        if (finished) return;
        finished = true;
        activeDragFinish = null;
        document.removeEventListener(DRAG_MOVE, onMove, true);
        document.removeEventListener(DRAG_UP, finish, true);
        document.removeEventListener('pointercancel', finish, true);
        document.removeEventListener('lostpointercapture', finish, true);
        document.removeEventListener('blur', finish, true);
        document.removeEventListener('visibilitychange', onVisibility, true);
        fabDragging = false;
        fabEl.classList.remove('is-dragging');
        try { fabEl.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
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
      const onVisibility = () => { if (document.visibilityState === 'hidden') finish(); };
      activeDragFinish = finish;

      // 指针捕获：拖出浏览器窗口再松手也能收到 pointerup
      try { fabEl.setPointerCapture?.(event.pointerId); } catch { /* ignore */ }

      document.addEventListener(DRAG_MOVE, onMove, true);
      document.addEventListener(DRAG_UP, finish, true);
      document.addEventListener('pointercancel', finish, true);
      document.addEventListener('lostpointercapture', finish, true);
      document.addEventListener('blur', finish, true);
      document.addEventListener('visibilitychange', onVisibility, true);
    });

    fabEl.addEventListener('click', (event) => {
      // 鼠标点击已由 pointerup 判定；这里只接键盘（detail 为 0）。
      // 若上一次拖拽卡住（窗口外松手），先自愈再按轻点处理。
      if (fabDragging) runActiveDragFinish();
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
      // 头部每次都是新建的，把手要跟着补
      const header = panelWindow.querySelector('.baf-popup header');
      if (header && !header.querySelector('.baf-grip')) {
        const grip = document.createElement('span');
        grip.className = 'baf-grip';
        grip.textContent = '⠿';
        grip.title = '拖动面板';
        header.insertBefore(grip, header.firstChild);
      }
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

  // BAF:BOOT —— 构建油猴版时，适配层与设置面板会插在这一行之前
  installScrollbarStability();
  loadSettings();
  pass();
  AUTO_READY = true;
  maybeAutoLoad();

  setupPanel();
})();
