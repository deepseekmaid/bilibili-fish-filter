import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOURCE = readFileSync(join(root, 'content.js'), 'utf8');

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

test('评论区先挂 DOM、后挂 shadowRoot：仍会被扫描并过滤', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="commentapp"></div></body></html>', {
    url: 'https://www.bilibili.com/video/BV1xx',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const doc = window.document;
  window.chrome = {
    storage: { sync: { get: (d, cb) => cb({ modeFish: true }) }, onChanged: { addListener() {} } },
  };

  const host = doc.createElement('bili-comments');
  doc.getElementById('commentapp').appendChild(host);

  try {
    window.eval(SOURCE);
    if (window.__bafAuto) window.__bafAuto.stop();
    await sleep(200);

    // 模拟自定义元素「先连上 DOM、后挂 shadowRoot」
    const sh = host.attachShadow({ mode: 'open' });
    const thread = doc.createElement('bili-comment-thread-renderer');
    const ts = thread.attachShadow({ mode: 'open' });
    const plain = comment(doc, '路人', '普通评论');
    ts.appendChild(plain);
    sh.appendChild(thread);

    await sleep(3800); // 等一次 3s 兜底轮询
    assert.equal(plain.style.display, 'none', '后挂载的评论区也应被过滤，而不是一直不生效');
  } finally {
    window.close();
  }
});
