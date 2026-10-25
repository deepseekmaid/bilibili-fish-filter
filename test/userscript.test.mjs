import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(root, 'dist/bilibili-fish-filter.user.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (el) => (el.style.display === 'none' ? 'hide' : 'show');

function comment(doc, name, text) {
  const renderer = doc.createElement('bili-comment-renderer');
  const sr = renderer.attachShadow({ mode: 'open' });
  const info = doc.createElement('bili-comment-user-info');
  const is = info.attachShadow({ mode: 'open' });
  const un = doc.createElement('div');
  un.id = 'user-name';
  un.textContent = name;
  is.appendChild(un);
  sr.appendChild(info);
  const rich = doc.createElement('bili-rich-text');
  const rs = rich.attachShadow({ mode: 'open' });
  const c = doc.createElement('div');
  c.id = 'contents';
  c.textContent = text;
  rs.appendChild(c);
  sr.appendChild(rich);
  return renderer;
}

function boot(stored) {
  const dom = new JSDOM('<!doctype html><html><body><div id="commentapp"></div></body></html>', {
    url: 'https://www.bilibili.com/video/BV1xx',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const doc = window.document;
  const store = { ...(stored || {}) };
  window.GM_getValue = (key, fallback) => (key in store ? store[key] : fallback);
  window.GM_setValue = (key, value) => { store[key] = value; };
  window.GM_registerMenuCommand = () => {};

  const box = doc.createElement('bili-comments');
  const shadow = box.attachShadow({ mode: 'open' });
  const mk = (name, text) => {
    const thread = doc.createElement('bili-comment-thread-renderer');
    const ts = thread.attachShadow({ mode: 'open' });
    ts.appendChild(comment(doc, name, text));
    shadow.appendChild(thread);
    return thread;
  };
  const fish = mk('大肥鱼', '这视频不错');
  const at = mk('路人甲', '@小红 快看');
  const atMid = mk('路人乙', '笑死 @小红');
  const plain = mk('路人丙', '字幕有点快');
  const master = mk('路人丁', '主人早上好');
  doc.getElementById('commentapp').appendChild(box);

  window.eval(SOURCE);
  return { window, doc, store, fish, at, atMid, plain, master };
}

test('油猴版：默认只留昵称含鱼的评论（外加默认开的以主人开头）', async () => {
  const env = boot();
  try {
    await sleep(450);
    assert.equal(state(env.fish), 'show');
    assert.equal(state(env.at), 'hide');
    assert.equal(state(env.atMid), 'hide');
    assert.equal(state(env.plain), 'hide');
    assert.equal(state(env.master), 'show', '默认规则三是「以主人开头」');
  } finally {
    env.window.close();
  }
});

test('油猴版：applySettings 改规则立即生效并写入 GM 存储', async () => {
  const env = boot();
  try {
    await sleep(400);
    env.window.__bafApply({ atMode: 'contains', masterMode: 'off' });
    await sleep(450);
    assert.equal(state(env.at), 'show');
    assert.equal(state(env.atMid), 'show');
    assert.equal(state(env.plain), 'hide');
    assert.equal(state(env.master), 'hide');
    const saved = env.store['baf.settings.v1'];
    assert.equal(saved && saved.atMode, 'contains');
  } finally {
    env.window.close();
  }
});

test('油猴版：读取已存设置', async () => {
  const env = boot({ 'baf.settings.v1': { atMode: 'startsWith', modeFish: false, masterMode: 'startsWith', combine: 'union' } });
  try {
    await sleep(450);
    assert.equal(state(env.at), 'show');
    assert.equal(state(env.atMid), 'hide');
    assert.equal(state(env.master), 'show');
    assert.equal(state(env.plain), 'hide');
  } finally {
    env.window.close();
  }
});

test('油猴版：交集口径', async () => {
  const env = boot({ 'baf.settings.v1': { atMode: 'contains', modeFish: true, masterMode: 'startsWith', combine: 'intersect' } });
  try {
    await sleep(450);
    assert.equal(state(env.fish), 'hide');
    assert.equal(state(env.at), 'hide');
    assert.equal(state(env.master), 'hide');
  } finally {
    env.window.close();
  }
});

test('油猴版：面板复用扩展弹窗（同样的结构与版本号）', async () => {
  const env = boot();
  try {
    await sleep(400);
    const host = env.doc.getElementById('baf-userscript-panel');
    assert.ok(host, '应注入面板宿主');
    const shadow = host.shadowRoot;
    assert.ok(shadow.querySelector('.baf-fab'), '应有浮动按钮');
    shadow.querySelector('.baf-fab').click();
    await sleep(150);
    for (const id of ['combineSeg', 'atSeg', 'masterSeg', 'modeFish', 'autoLoad', 'fastMode', 'ver']) {
      assert.ok(shadow.querySelector('#' + id), '面板里应有 #' + id);
    }
    assert.equal(shadow.querySelector('#ver').textContent, 'v1.01', '版本号应显示 v1.01');
    assert.match(shadow.querySelector('#count').textContent, /保留 \d+ 条 \/ 共 \d+ 条/);
    assert.ok(shadow.querySelector('.baf-popup'), '应套用弹窗样式容器');
  } finally {
    env.window.close();
  }
});
