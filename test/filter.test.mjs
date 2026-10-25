import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(root, 'content.js'), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (el) => (el.style.display === 'none' ? 'hide' : 'show');

const CASES = [
  { id: 'fish-plain', name: '大肥鱼', text: '这视频做得真不错' },
  { id: 'at-mid', name: '路人甲', text: '笑死 @小红' },
  { id: 'neither', name: '路人乙', text: '字幕有点快了' },
  { id: 'fish-replytag', name: '大肥鱼', text: '回复 @小红：我也觉得' },
  { id: 'reply-only', name: '路人丙', text: '回复 @小红：确实如此' },
  { id: 'both', name: '小鱼干儿', text: '@小红 快来看这个' },
  { id: 'reply-loose', name: '路人丁', text: '回复@小红 后面还有 @小刚' },
];

function comment(doc, spec, reply) {
  const renderer = doc.createElement(reply ? 'bili-comment-reply-renderer' : 'bili-comment-renderer');
  const shadow = renderer.attachShadow({ mode: 'open' });

  const userInfo = doc.createElement('bili-comment-user-info');
  const userShadow = userInfo.attachShadow({ mode: 'open' });
  const userName = doc.createElement('div');
  userName.id = 'user-name';
  userName.textContent = spec.name;
  userShadow.appendChild(userName);
  shadow.appendChild(userInfo);

  const rich = doc.createElement('bili-rich-text');
  const richShadow = rich.attachShadow({ mode: 'open' });
  const contents = doc.createElement('div');
  contents.id = 'contents';
  contents.textContent = spec.text;
  richShadow.appendChild(contents);
  shadow.appendChild(rich);

  return renderer;
}

function boot({ modeAt, modeFish, masterMode, atMode, combine }) {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    url: 'https://www.bilibili.com/video/BV1xx',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const doc = window.document;
  const listeners = [];

  window.chrome = {
    storage: {
      sync: { get: (defaults, cb) => cb({
        atMode: atMode || (modeAt === true ? 'contains' : modeAt === false ? 'off' : 'off'),
        modeFish,
        masterMode: masterMode || 'startsWith',
        combine: combine || 'union',
      }) },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };

  const stage = doc.getElementById('stage');
  const refs = {};
  for (const spec of CASES) {
    const thread = doc.createElement('bili-comment-thread-renderer');
    const threadShadow = thread.attachShadow({ mode: 'open' });
    const renderer = comment(doc, spec, false);
    threadShadow.appendChild(renderer);
    stage.appendChild(thread);
    refs[spec.id] = renderer;
    refs[spec.id + '#thread'] = thread;
  }

  window.eval(SOURCE);
  // 关掉后台自动加载循环，避免它和断言抢时序
  if (window.__bafAuto) window.__bafAuto.stop();
  return { window, doc, refs, listeners, stage };
}

function expectAll(refs, expected) {
  for (const [id, want] of Object.entries(expected)) {
    assert.equal(state(refs[id]), want, id + ' 的可见性');
  }
}

test('默认只开模式二：只保留昵称带鱼的评论', async () => {
  const env = boot({ modeAt: false, modeFish: true });
  try {
    await sleep(250);
    expectAll(env.refs, {
      'fish-plain': 'show',
      'fish-replytag': 'show',
      both: 'show',
      'at-mid': 'hide',
      neither: 'hide',
      'reply-only': 'hide',
      'reply-loose': 'hide',
    });
    assert.equal(state(env.refs['fish-plain#thread']), 'show', '命中的楼层应保留');
    assert.equal(state(env.refs['at-mid#thread']), 'hide', '整楼被删时应连带收起楼层容器');
    assert.equal(state(env.refs['neither#thread']), 'hide', '整楼被删时应连带收起楼层容器');
  } finally {
    env.window.close();
  }
});

test('只开模式一（包含 @）：带 @ 的都留下', async () => {
  const env = boot({ atMode: 'contains', modeFish: false, masterMode: 'off' });
  try {
    await sleep(250);
    expectAll(env.refs, {
      'at-mid': 'show',
      both: 'show',
      'reply-only': 'show',
      'reply-loose': 'show',
      'fish-replytag': 'show', // 正文含 @，包含档也留
      'fish-plain': 'hide',
      neither: 'hide',
    });
  } finally {
    env.window.close();
  }
});

test('两个都开：并集，鱼用户不会被「回复 @」规则误杀', async () => {
  const env = boot({ modeAt: true, modeFish: true });
  try {
    await sleep(250);
    expectAll(env.refs, {
      'fish-plain': 'show',
      'fish-replytag': 'show',
      both: 'show',
      'at-mid': 'show',
      'reply-only': 'show',
      'reply-loose': 'show',
      neither: 'hide',
    });
  } finally {
    env.window.close();
  }
});

test('模式一（以 @ 开头）：只有开头的保留', async () => {
  const env = boot({ atMode: 'startsWith', modeFish: false, masterMode: 'off' });
  try {
    await sleep(250);
    expectAll(env.refs, {
      both: 'show',           // 「@小红 快来看这个」
      'at-mid': 'hide',       // 「笑死 @小红」
      'reply-only': 'hide',   // 「回复 @小红…」
      'reply-loose': 'hide',
      'fish-plain': 'hide',
      neither: 'hide',
    });
  } finally {
    env.window.close();
  }
});


function combineEnv(combine) {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    url: 'https://www.bilibili.com/video/BV1xx',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const doc = window.document;
  window.chrome = {
    storage: {
      sync: { get: (d, cb) => cb({ atMode: 'contains', modeFish: true, masterMode: 'startsWith', combine }) },
      onChanged: { addListener() {} },
    },
  };

  const mk = (name, text) => {
    const thread = doc.createElement('bili-comment-thread-renderer');
    const ts = thread.attachShadow({ mode: 'open' });
    ts.appendChild(comment(doc, { name, text }, false));
    doc.getElementById('stage').appendChild(thread);
    return thread;
  };

  const allThree = mk('大肥鱼', '主人 @小红 快看');   // 三条全中
  const noAt = mk('大肥鱼', '主人你好');              // 缺 @
  const noFish = mk('路人', '主人 @小红');            // 缺鱼

  window.eval(SOURCE);
  if (window.__bafAuto) window.__bafAuto.stop();
  return { window, allThree, noAt, noFish };
}

test('并集（默认）：命中任一条就保留', async () => {
  const env = combineEnv('union');
  try {
    await sleep(250);
    assert.equal(state(env.allThree), 'show');
    assert.equal(state(env.noAt), 'show', '只有鱼和主人命中，并集应保留');
    assert.equal(state(env.noFish), 'show', '只有 @ 和主人命中，并集应保留');
  } finally {
    env.window.close();
  }
});

test('交集：三条规则全命中才保留', async () => {
  const env = combineEnv('intersect');
  try {
    await sleep(250);
    assert.equal(state(env.allThree), 'show', '三条全中才留');
    assert.equal(state(env.noAt), 'hide', '缺 @ 应删');
    assert.equal(state(env.noFish), 'hide', '缺鱼应删');
  } finally {
    env.window.close();
  }
});
test('三条规则都关：完全不过滤', async () => {
  const env = boot({ modeAt: false, modeFish: false, masterMode: 'off' });
  try {
    await sleep(250);
    expectAll(env.refs, {
      'fish-plain': 'show',
      'at-mid': 'show',
      neither: 'show',
      'fish-replytag': 'show',
      'reply-only': 'show',
      both: 'show',
      'reply-loose': 'show',
    });
  } finally {
    env.window.close();
  }
});


test('自动加载循环遇到异常不会永久卡死', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://www.bilibili.com/video/BV1xx',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const doc = window.document;
  window.chrome = { storage: { sync: { get: (d, cb) => setTimeout(() => cb(d), 0) }, onChanged: { addListener() {} } } };

  const host = doc.createElement('bili-comments');
  host.attachShadow({ mode: 'open' });
  doc.body.appendChild(host);
  // 让 kickLoad 读取组件状态时抛错，模拟 B 站改版或异常对象
  Object.defineProperty(host, 'showSpinner', {
    get() { throw new Error('boom'); },
  });

  try {
    window.eval(SOURCE);
    await sleep(900);
    const state = window.__bafAuto.state;
    assert.equal(state.running, false, '抛错后不应停在 running=true 的僵尸状态');
    assert.ok(state.cooldown > Date.now(), '应设置冷却，稍后还能重试');
  } finally {
    window.close();
  }
});

test('热切换：关掉一个模式只影响它自己那一份', async () => {
  const env = boot({ modeAt: true, modeFish: true });
  try {
    await sleep(250);
    env.listeners.forEach((fn) => fn({ modeFish: { newValue: false } }, 'sync'));
    await sleep(350);
    assert.equal(state(env.refs['fish-plain']), 'hide', '关鱼后鱼用户应被删');
    assert.equal(state(env.refs['at-mid']), 'show', '关鱼不应影响 @ 评论');

    env.listeners.forEach((fn) => fn({ modeFish: { newValue: true } }, 'sync'));
    await sleep(350);
    assert.equal(state(env.refs['fish-plain']), 'show', '开鱼后鱼用户应回来');

    env.listeners.forEach((fn) => fn({ atMode: { newValue: 'off' } }, 'sync'));
    await sleep(350);
    assert.equal(state(env.refs['at-mid']), 'hide', '关 @ 后普通 @ 评论应被删');
    assert.equal(state(env.refs['at-mid#thread']), 'hide', '楼层容器也要跟着收起');
    assert.equal(state(env.refs['fish-plain']), 'show', '关 @ 不应影响鱼用户');
    assert.equal(state(env.refs['fish-plain#thread']), 'show', '鱼用户的楼层容器应保留');
  } finally {
    env.window.close();
  }
});

test('动态插入的新楼层同样生效', async () => {
  const env = boot({ modeAt: true, modeFish: true });
  try {
    const thread = env.doc.createElement('bili-comment-thread-renderer');
    const threadShadow = thread.attachShadow({ mode: 'open' });
    const lateFish = comment(env.doc, { name: '夜宵吃鱼', text: '刚打开视频' }, false);
    const latePlain = comment(env.doc, { name: '路人戊', text: '随便看看' }, false);
    threadShadow.appendChild(lateFish);
    threadShadow.appendChild(latePlain);
    env.stage.appendChild(thread);

    await sleep(450);
    assert.equal(state(lateFish), 'show', '鱼用户应保留');
    assert.equal(state(latePlain), 'hide', '普通评论应删除');
  } finally {
    env.window.close();
  }
});

test('兼容旧版评论 DOM（.reply-item / .sub-reply-item）', async () => {
  const env = boot({ modeAt: true, modeFish: true });
  try {
    const mk = (name, text) => {
      const item = env.doc.createElement('div');
      item.className = 'sub-reply-item';
      item.innerHTML = '<div class="root-reply-container"><span class="user-name"></span></div><div class="reply-content"></div>';
      item.querySelector('.user-name').textContent = name;
      item.querySelector('.reply-content').textContent = text;
      env.stage.appendChild(item);
      return item;
    };
    const fishItem = mk('大肥鱼', '普通评论');
    const atItem = mk('路人', '中间带 @ 的评论');
    const plainItem = mk('路人', '什么都没有');

    await sleep(400);
    assert.equal(state(fishItem), 'show');
    assert.equal(state(atItem), 'show');
    assert.equal(state(plainItem), 'hide');
  } finally {
    env.window.close();
  }
});


function masterEnv(masterMode) {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    url: 'https://www.bilibili.com/video/BV1xx',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const doc = window.document;
  window.chrome = {
    storage: {
      sync: { get: (d, cb) => cb({ modeAt: false, modeFish: false, masterMode }) },
      onChanged: { addListener() {} },
    },
  };

  const stage = doc.getElementById('stage');
  const mk = (name, text) => {
    const thread = doc.createElement('bili-comment-thread-renderer');
    const ts = thread.attachShadow({ mode: 'open' });
    ts.appendChild(comment(doc, { name, text }, false));
    stage.appendChild(thread);
    return thread;
  };

  const starts = mk('路人', '主人早上好');
  const middle = mk('路人', '今天主人不在');
  const other = mk('路人', '普通评论');

  window.eval(SOURCE);
  if (window.__bafAuto) window.__bafAuto.stop();
  return { window, starts, middle, other };
}

test('模式三默认「以主人开头」：开头命中保留，句中命中删除', async () => {
  const env = masterEnv('startsWith');
  try {
    await sleep(250);
    assert.equal(state(env.starts), 'show', '「主人早上好」应以主人开头被保留');
    assert.equal(state(env.middle), 'hide', '「今天主人不在」不该被开头规则命中');
    assert.equal(state(env.other), 'hide', '普通评论仍然删除');
  } finally {
    env.window.close();
  }
});

test('模式三「包含主人」：句中命中同样保留', async () => {
  const env = masterEnv('contains');
  try {
    await sleep(250);
    assert.equal(state(env.starts), 'show');
    assert.equal(state(env.middle), 'show', '包含规则应命中句中「主人」');
    assert.equal(state(env.other), 'hide');
  } finally {
    env.window.close();
  }
});

test('模式三「关」：主人相关评论不再被它保住', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    url: 'https://www.bilibili.com/video/BV1xx',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const doc = window.document;
  try {
    // 只开模式一、模式三关掉：没有 @ 的「主人早上好」应被删除
    window.chrome = {
      storage: {
        sync: { get: (d, cb) => cb({ modeAt: true, modeFish: false, masterMode: 'off' }) },
        onChanged: { addListener() {} },
      },
    };
    const mk = (text) => {
      const thread = doc.createElement('bili-comment-thread-renderer');
      const ts = thread.attachShadow({ mode: 'open' });
      ts.appendChild(comment(doc, { name: '路人', text }, false));
      doc.getElementById('stage').appendChild(thread);
      return thread;
    };
    const starts = mk('主人早上好');
    const atOne = mk('笑死 @小红');
    window.eval(SOURCE);
    if (window.__bafAuto) window.__bafAuto.stop();

    await sleep(250);
    assert.equal(state(starts), 'hide', '模式三关了，主人开头也救不了');
    assert.equal(state(atOne), 'show', '含 @ 的照旧保留');
  } finally {
    window.close();
  }
});

test('模式三与其它规则取并集：命中「回复 @」+ 主人开头也留', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    url: 'https://www.bilibili.com/video/BV1xx',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const doc = window.document;
  try {
    window.chrome = {
      storage: {
        sync: { get: (d, cb) => cb({ modeAt: true, modeFish: false, masterMode: 'contains' }) },
        onChanged: { addListener() {} },
      },
    };
    const thread = doc.createElement('bili-comment-thread-renderer');
    const ts = thread.attachShadow({ mode: 'open' });
    ts.appendChild(comment(doc, { name: '路人', text: '回复 @小红：主人在吗' }, false));
    doc.getElementById('stage').appendChild(thread);
    window.eval(SOURCE);
    if (window.__bafAuto) window.__bafAuto.stop();

    await sleep(250);
    // 模式一排除「回复 @」开头，但模式三命中「主人」→ 并集保留
    assert.equal(state(thread), 'show');
  } finally {
    window.close();
  }
});
test('解析失败保护：取不到正文和昵称时不误删', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    url: 'https://www.bilibili.com/video/BV1xx',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  try {
    window.chrome = {
      storage: {
        sync: { get: (defaults, cb) => cb({ modeAt: true, modeFish: true }) },
        onChanged: { addListener() {} },
      },
    };
    const host = window.document.createElement('bili-comment-renderer');
    host.attachShadow({ mode: 'open' });
    window.document.getElementById('stage').appendChild(host);
    window.eval(SOURCE);

    await sleep(300);
    assert.equal(state(host), 'show');
  } finally {
    window.close();
  }
});

function autoEnv({ autoLoad, headerText, comments, onLoadMore, withButton = true }) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://www.bilibili.com/video/BV1xx',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.__clicks = 0;
  window.__scrolls = 0;
  window.Element.prototype.scrollIntoView = function () { window.__scrolls += 1; };
  window.scrollBy = function () { window.__scrolls += 1; };
  window.scrollTo = function () { window.__scrolls += 1; };
  window.chrome = {
    storage: {
      sync: { get: (defaults, cb) => cb({ modeAt: false, modeFish: true, autoLoad }) },
      onChanged: { addListener() {} },
    },
  };

  const box = window.document.createElement('bili-comments');
  const shadow = box.attachShadow({ mode: 'open' });
  if (headerText) {
    const header = window.document.createElement('div');
    header.textContent = headerText;
    shadow.appendChild(header);
  }
  for (const spec of comments) {
    const thread = window.document.createElement('bili-comment-thread-renderer');
    const threadShadow = thread.attachShadow({ mode: 'open' });
    threadShadow.appendChild(comment(window.document, spec, false));
    shadow.appendChild(thread);
  }

  // B 站的「加载更多」通常是 div，不是 button
  if (withButton) {
    const more = window.document.createElement('div');
    more.textContent = '点击加载更多';
    more.addEventListener('click', () => {
      window.__clicks += 1;
      if (typeof onLoadMore === 'function') onLoadMore(window, shadow);
    });
    shadow.appendChild(more);
  }

  window.document.body.appendChild(box);
  window.eval(SOURCE);
  if (window.__bafAuto) window.__bafAuto.stop();

  return { window, doc: window.document, shadow, box, auto: window.__bafAuto };
}

function freshTick(auto) {
  auto.state.rounds = 0;
  auto.state.idle = 0;
  auto.state.lastTotal = -1;
  auto.state.gaveUp = false;
  return auto.tick();
}


test('快速模式：默认关闭，热切换后 stats 反映出来', async () => {
  const env = boot({ modeAt: false, modeFish: false, masterMode: 'off' });
  try {
    await sleep(120);
    assert.equal(env.window.__bafStats().fastMode, false, '默认应为关闭');
    env.listeners.forEach((fn) => fn({ fastMode: { newValue: true } }, 'sync'));
    await sleep(120);
    assert.equal(env.window.__bafStats().fastMode, true, '切换后应变为开启');
  } finally {
    env.window.close();
  }
});
test('自动加载（永久逻辑）：一条都显示不出来时继续加载', async () => {
  const env = autoEnv({
    autoLoad: false,
    comments: [
      { name: '路人甲', text: '普通评论' },
      { name: '路人乙', text: '另一条普通评论' },
    ],
  });
  try {
    await sleep(150);
    assert.equal(freshTick(env.auto), 'continue', '没有可显示评论时应继续加载');
    assert.equal(env.window.__clicks, 1, '应该去点「加载更多」');
  } finally {
    env.window.close();
  }
});

test('自动加载：全程不滚动页面', async () => {
  const env = autoEnv({
    autoLoad: false,
    comments: [{ name: '路人甲', text: '普通评论' }],
  });
  try {
    await sleep(150);
    const auto = env.auto;
    freshTick(auto);
    for (let i = 0; i < 5; i += 1) auto.tick();
    assert.equal(env.window.__scrolls, 0, '不许调用 scrollTo / scrollBy / scrollIntoView');
  } finally {
    env.window.close();
  }
});

test('自动加载（永久逻辑）：出现第一条可显示评论就停', async () => {
  const env = autoEnv({
    autoLoad: false,
    comments: [
      { name: '路人甲', text: '普通评论' },
      { name: '大肥鱼', text: '这条能留下来' },
    ],
  });
  try {
    await sleep(150);
    assert.equal(freshTick(env.auto), 'visible', '已经有一条可见评论，不应继续加载');
  } finally {
    env.window.close();
  }
});

test('自动加载：组件 showEnd 为真才算到底', async () => {
  const env = autoEnv({
    autoLoad: true,
    headerText: '没有更多评论了',
    comments: [{ name: '路人甲', text: '普通评论' }],
  });
  try {
    await sleep(150);
    // 只有文案、组件还没说 showEnd：不能提前收手
    assert.equal(freshTick(env.auto), 'continue', '组件没到底就不许停');

    env.box.showEnd = true;
    assert.equal(freshTick(env.auto), 'end');
  } finally {
    env.window.close();
  }
});

test('自动加载：旧版页面（没有 bili-comments）退回「共 N 条评论」判到底', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [] });
  try {
    await sleep(150);
    env.box.remove();
    const anchor = env.doc.createElement('div');
    anchor.id = 'commentapp';
    for (let i = 0; i < 2; i += 1) {
      const item = env.doc.createElement('div');
      item.className = 'reply-item';
      item.textContent = '旧版评论 ' + i;
      anchor.appendChild(item);
    }
    const counter = env.doc.createElement('div');
    counter.textContent = '共 2 条评论';
    anchor.appendChild(counter);
    env.doc.body.appendChild(anchor);

    const auto = env.auto;
    auto.state.rounds = 0;
    auto.state.idle = 0;
    auto.state.lastTotal = -1;
    auto.state.gaveUp = false;

    assert.equal(auto.tick(), 'end');
  } finally {
    env.window.close();
  }
});

test('自动加载：getList 返回的 promise 会被记住，用来串行加速', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    const promise = Promise.resolve();
    env.box.lazyLoadDP = null;
    env.box.showSpinner = false;
    env.box.showEnd = false;
    env.box.getList = () => promise;
    env.auto.tick();
    assert.equal(env.auto.state.pending, promise, '拿到 promise 才能上一页回来立刻要下一页');
  } finally {
    env.window.close();
  }
});


test('自动加载：正在请求（showSpinner）时只等待，不叠请求也不拉视口', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    let calls = 0;
    env.box.lazyLoadDP = null;
    env.box.showSpinner = true;
    env.box.showEnd = false;
    env.box.getList = () => { calls += 1; };
    env.box.getBoundingClientRect = () => ({ top: 3000, bottom: 3200, height: 200, left: 0, right: 600, width: 600, x: 0, y: 3000, toJSON() { return this; } });

    env.auto.state.idle = 0;
    env.auto.state.lastTotal = -1;
    assert.equal(env.auto.tick(), 'continue');
    assert.equal(calls, 0, '请求中不要再发 getList');
    assert.equal(env.box.style.transform, '', '请求中也不要去拉视口');
  } finally {
    env.window.close();
  }
});

test('自动加载：同一元素不叠拉，结束后恢复（不会永久透明）', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    env.box.getBoundingClientRect = () => ({ top: 2400, bottom: 2800, height: 400, left: 0, right: 600, width: 600, x: 0, y: 2400, toJSON() { return this; } });
    env.auto.state.idle = 0;
    env.auto.state.lastTotal = -1;
    env.auto.tick();
    const first = env.auto.state.pulls;
    assert.equal(env.box.style.opacity, '0');
    env.auto.tick();
    assert.equal(env.auto.state.pulls, first, '第二次不应叠拉');
    await sleep(600);
    assert.equal(env.box.style.opacity, '', '拉完必须恢复 opacity');
    assert.equal(env.box.style.transform, '', '拉完必须恢复 transform');
  } finally {
    env.window.close();
  }
});

test('自动加载：元素没有高度时不拉（白屏就是这么来的）', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    env.box.getBoundingClientRect = () => ({ top: 2400, bottom: 2400, height: 0, left: 0, right: 600, width: 600, x: 0, y: 2400, toJSON() { return this; } });
    env.auto.state.idle = 0;
    env.auto.state.lastTotal = -1;
    env.auto.tick();
    assert.equal(env.box.style.opacity, '', '不该设置透明');
    assert.equal(env.box.style.transform, '', '不该搬动');
  } finally {
    env.window.close();
  }
});


test('自动加载：0 高的占位容器也要拉（唤醒页面懒挂载）', async () => {
  const env = autoEnv({ autoLoad: false, withButton: false, comments: [] });
  try {
    await sleep(150);
    env.box.remove();
    const anchor = env.doc.createElement('div');
    anchor.id = 'commentapp';
    anchor.getBoundingClientRect = () => ({ top: 3000, bottom: 3000, height: 0, left: 0, right: 600, width: 600, x: 0, y: 3000, toJSON() { return this; } });
    env.doc.body.appendChild(anchor);

    env.auto.state.idle = 0;
    env.auto.state.lastTotal = -1;
    env.auto.tick();
    assert.match(anchor.style.transform, /translate3d/, '占位容器要拉进视口');
  } finally {
    env.window.close();
  }
});
test('自动加载：能清掉上次运行遗留的隐形样式', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    env.box.style.opacity = '0';
    env.box.style.transform = 'translate3d(0,100px,0)';
    env.box.style.willChange = 'transform';
    env.auto.sweep();
    assert.equal(env.box.style.opacity, '');
    assert.equal(env.box.style.transform, '');
    assert.equal(env.box.style.willChange, '');
  } finally {
    env.window.close();
  }
});
test('自动加载：组件 list 变长也算进度，不会被误判成空转', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    env.box.lazyLoadDP = null;
    env.box.showSpinner = false;
    env.box.showEnd = false;
    env.box.getList = () => {};
    // DOM 里只有 1 条渲染，但组件内部已经攒了 40 条
    env.box.list = new Array(40).fill({});

    env.auto.state.rounds = 0;
    env.auto.state.idle = 5;
    env.auto.state.lastTotal = -1;
    env.auto.state.gaveUp = false;
    env.auto.tick();
    assert.equal(env.auto.state.idle, 0, 'list 变长要重置空转计数');
  } finally {
    env.window.close();
  }
});

test('自动加载开关：开着时即使有可见评论也继续加载', async () => {
  const env = autoEnv({
    autoLoad: true,
    comments: [
      { name: '大肥鱼', text: '这条能留下来' },
      { name: '路人甲', text: '普通评论' },
    ],
  });
  try {
    await sleep(150);
    assert.equal(freshTick(env.auto), 'continue', '开关打开时应继续加载到底');
  } finally {
    env.window.close();
  }
});

test('自动加载：连续没长进会退避后收手', async () => {
  const env = autoEnv({ autoLoad: true, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    const auto = env.auto;
    auto.state.rounds = 0;
    auto.state.idle = 0;
    auto.state.lastTotal = -1;
    auto.state.gaveUp = false;
    let result = 'continue';
    for (let i = 0; i < 60 && result === 'continue'; i += 1) result = auto.tick();
    assert.equal(result, 'idle', '一直没新增才判定为加载不动');
  } finally {
    env.window.close();
  }
});

let envRef = null;

test('自动加载：点「加载更多」能把评论加载到总数为止', async () => {
  const env = autoEnv({
    autoLoad: true,
    headerText: '共 3 条评论',
    comments: [{ name: '路人甲', text: '第一条' }],
    onLoadMore: (window, shadow) => {
      if (envRef && envRef.box) {
        // 模拟组件：加载到第 3 条时自己把 showEnd 置真
        if (shadow.querySelectorAll('bili-comment-thread-renderer').length + 1 >= 3) envRef.box.showEnd = true;
      }
      const count = shadow.querySelectorAll('bili-comment-thread-renderer').length;
      if (count >= 3) return;
      const thread = window.document.createElement('bili-comment-thread-renderer');
      const threadShadow = thread.attachShadow({ mode: 'open' });
      threadShadow.appendChild(comment(window.document, { name: '路人' + count, text: '第 ' + (count + 1) + ' 条' }, false));
      shadow.insertBefore(thread, shadow.lastElementChild);
    },
  });
  try {
    await sleep(150);
    envRef = env;
    const auto = env.auto;
    auto.state.rounds = 0;
    auto.state.idle = 0;
    auto.state.lastTotal = -1;
    auto.state.gaveUp = false;

    let result = 'continue';
    for (let i = 0; i < 10 && result === 'continue'; i += 1) result = auto.tick();

    assert.equal(env.shadow.querySelectorAll('bili-comment-thread-renderer').length, 3, '应该点出 3 条');
    assert.equal(result, 'end', '组件到底后应停止');
  } finally {
    env.window.close();
  }
});

test('自动加载：评论区在视口外时用 transform 拉进视口，不滚页面', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    env.box.getBoundingClientRect = () => ({
      top: 2400, bottom: 2800, height: 400, left: 0, right: 600, width: 600, x: 0, y: 2400,
      toJSON() { return this; },
    });
    env.auto.state.rounds = 0;
    env.auto.state.idle = 0;
    env.auto.state.lastTotal = -1;
    env.auto.state.gaveUp = false;

    assert.equal(env.auto.tick(), 'continue');
    assert.match(env.box.style.transform, /translate3d/, '应临时把评论区拉进视口');
    assert.equal(env.box.style.opacity, '0', '拉动期间要隐身');
    assert.equal(env.window.__scrolls, 0, '不许滚页面');

    await sleep(600);
    assert.equal(env.box.style.transform, '', '拉完要还原 transform');
    assert.equal(env.box.style.opacity, '', '拉完要还原 opacity');
  } finally {
    env.window.close();
  }
});

test('自动加载：评论区已经在视口里就不动它', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    env.box.getBoundingClientRect = () => ({
      top: 120, bottom: 520, height: 400, left: 0, right: 600, width: 600, x: 0, y: 120,
      toJSON() { return this; },
    });
    env.auto.state.rounds = 0;
    env.auto.state.lastTotal = -1;
    env.auto.tick();
    assert.equal(env.box.style.transform, '', '在视口里不应该被搬动');
  } finally {
    env.window.close();
  }
});

test('自动加载：评论区还没挂载时，拉占位容器（#comment）', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [] });
  try {
    await sleep(150);
    env.box.remove();
    const anchor = env.doc.createElement('div');
    anchor.id = 'comment';
    anchor.getBoundingClientRect = () => ({
      top: 3000, bottom: 3200, height: 200, left: 0, right: 600, width: 600, x: 0, y: 3000,
      toJSON() { return this; },
    });
    env.doc.body.appendChild(anchor);

    env.auto.state.rounds = 0;
    env.auto.state.idle = 0;
    env.auto.state.lastTotal = -1;
    env.auto.state.gaveUp = false;

    assert.equal(env.auto.tick(), 'continue');
    assert.match(anchor.style.transform, /translate3d/, '应把占位容器拉进视口');
    assert.equal(env.window.__scrolls, 0, '不许滚页面');
  } finally {
    env.window.close();
  }
});

test('自动加载：直接 resolve 组件的懒加载闸门（不滚页面）', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    let resolved = false;
    env.box.lazyLoadDP = { resolve: () => { resolved = true; }, promise: Promise.resolve() };
    env.auto.state.idle = 0;
    env.auto.state.lastTotal = -1;
    env.auto.tick();
    assert.equal(resolved, true, '应当直接放行 lazyLoadDP');
    assert.equal(env.box.lazyLoadDP, null, '放行后要清空闸门');
    assert.equal(env.window.__scrolls, 0, '不许滚页面');
  } finally {
    env.window.close();
  }
});

test('自动加载：直接调用组件 getList() 取下一页', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    let calls = 0;
    env.box.lazyLoadDP = null;
    env.box.showSpinner = false;
    env.box.showEnd = false;
    env.box.getList = () => { calls += 1; };
    env.auto.state.idle = 0;
    env.auto.state.lastTotal = -1;
    env.auto.tick();
    assert.equal(calls, 1, '应当直接调 getList');
    assert.equal(env.window.__scrolls, 0, '不许滚页面');
  } finally {
    env.window.close();
  }
});

test('自动加载：showEnd / showSpinner 时不去戳 getList', async () => {
  const env = autoEnv({ autoLoad: true, withButton: false, comments: [{ name: '路人甲', text: '普通评论' }] });
  try {
    await sleep(150);
    let calls = 0;
    env.box.lazyLoadDP = null;
    env.box.getList = () => { calls += 1; };
    env.box.showSpinner = true;
    env.box.showEnd = false;
    env.auto.tick();
    assert.equal(calls, 0, '首屏还在加载时不要插队');

    env.box.showSpinner = false;
    env.box.showEnd = true;
    env.auto.tick();
    assert.equal(calls, 0, '已经到底就不要调');
  } finally {
    env.window.close();
  }
});



