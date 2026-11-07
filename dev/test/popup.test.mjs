import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = readFileSync(join(root, 'popup.html'), 'utf8');
const SCRIPT = readFileSync(join(root, 'popup.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

function loadPopup(stored, options = {}) {
  const dom = new JSDOM(HTML, { url: 'https://example.com', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const writes = [];
  const removed = [];
  window.chrome = {
    runtime: { getManifest: () => ({ version: MANIFEST.version, version_name: MANIFEST.version_name }) },
    storage: {
      sync: {
        get: (defaults, cb) => cb({ ...defaults, ...stored }),
        remove: (keys, cb) => {
          removed.push(...(Array.isArray(keys) ? keys : [keys]));
          if (typeof cb === 'function') cb();
        },
        set: (patch, cb) => {
          writes.push(patch);
          // 模拟 Chrome：lastError 只在回调期间可见
          if (options.setError) window.chrome.runtime.lastError = { message: options.setError };
          try {
            if (typeof cb === 'function') cb();
          } finally {
            delete window.chrome.runtime.lastError;
          }
        },
      },
    },
  };
  window.eval(SCRIPT);
  return { window, doc: window.document, writes, removed };
}

const activeSeg = (doc, id) => doc.querySelector('#' + id + ' button.on')?.dataset.mode || doc.querySelector('#' + id + ' button.on')?.dataset.combine;

test('面板：旧版 modeAt:true 显示为「包含 @」', () => {
  const { window, doc } = loadPopup({ modeAt: true });
  try {
    assert.equal(activeSeg(doc, 'atSeg'), 'contains', '旧布尔值不能被显示成「关」，否则与真实过滤不一致');
  } finally {
    window.close();
  }
});

test('面板：默认规则二为「关」、组合为「并集」', () => {
  const { window, doc } = loadPopup({});
  try {
    assert.equal(activeSeg(doc, 'atSeg'), 'off');
    assert.equal(activeSeg(doc, 'combineSeg'), 'union');
    assert.equal(activeSeg(doc, 'masterSeg'), 'startsWith');
  } finally {
    window.close();
  }
});

test('面板：版本号显示 manifest.version_name', () => {
  const { window, doc } = loadPopup({});
  try {
    assert.equal(doc.getElementById('ver').textContent, MANIFEST.version_name);
  } finally {
    window.close();
  }
});

test('规则四：昵称词与评论词分别读取渲染', () => {
  const { window, doc } = loadPopup({ modeCustom: true, customNameWords: ['猫咪君'], customTextWords: ['好可爱', '字幕'] });
  try {
    assert.equal(doc.getElementById('modeCustom').checked, true);
    assert.deepEqual([...doc.querySelectorAll('#customNameChips .cChip em')].map((el) => el.textContent), ['猫咪君']);
    assert.deepEqual([...doc.querySelectorAll('#customTextChips .cChip em')].map((el) => el.textContent), ['好可爱', '字幕']);
    assert.equal(doc.getElementById('customBlock').classList.contains('off'), false);
  } finally {
    window.close();
  }
});

test('规则四：默认关闭，两个区域都为空', () => {
  const { window, doc } = loadPopup({});
  try {
    assert.equal(doc.getElementById('modeCustom').checked, false);
    assert.equal(doc.getElementById('customBlock').classList.contains('off'), true);
    assert.equal(doc.querySelectorAll('#customNameChips .cChip').length, 0);
    assert.equal(doc.querySelectorAll('#customTextChips .cChip').length, 0);
  } finally {
    window.close();
  }
});

test('规则四：昵称区加号添加，只写入 customNameWords', () => {
  const { window, doc, writes } = loadPopup({});
  try {
    const input = doc.getElementById('customNameInput');
    input.value = '  猫咪君  ';
    doc.getElementById('customNameAdd').click();
    assert.deepEqual([...doc.querySelectorAll('#customNameChips .cChip em')].map((el) => el.textContent), ['猫咪君']);
    assert.equal(doc.querySelectorAll('#customTextChips .cChip').length, 0, '不应写进评论区');
    const last = writes.at(-1);
    assert.deepEqual([...last.customNameWords], ['猫咪君']);
    assert.equal('customTextWords' in last, false, '只写本栏，别把另一栏的旧值一起写回');
    assert.equal(input.value, '', '添加后应清空输入框');
  } finally {
    window.close();
  }
});

test('规则四：评论区回车添加，只写入 customTextWords', () => {
  const { window, doc, writes } = loadPopup({ customNameWords: ['猫咪君'] });
  try {
    const input = doc.getElementById('customTextInput');
    input.value = '好可爱';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual([...doc.querySelectorAll('#customTextChips .cChip em')].map((el) => el.textContent), ['好可爱']);
    const last = writes.at(-1);
    assert.deepEqual([...last.customTextWords], ['好可爱']);
    assert.equal('customNameWords' in last, false, '昵称词不在这次写入里，避免覆盖别处的改动');
  } finally {
    window.close();
  }
});

test('规则四：两个区域的 × 只删各自的词', () => {
  const { window, doc, writes } = loadPopup({ customNameWords: ['猫咪君', '大肥鱼'], customTextWords: ['字幕'] });
  try {
    doc.querySelector('#customNameChips .cChip button').click();
    assert.deepEqual([...doc.querySelectorAll('#customNameChips .cChip em')].map((el) => el.textContent), ['大肥鱼']);
    assert.deepEqual([...writes.at(-1).customNameWords], ['大肥鱼']);
    assert.equal('customTextWords' in writes.at(-1), false, '评论词不在这次写入里');

    doc.querySelector('#customTextChips .cChip button').click();
    assert.equal(doc.querySelectorAll('#customTextChips .cChip').length, 0);
    assert.deepEqual([...writes.at(-1).customTextWords], []);
  } finally {
    window.close();
  }
});

test('规则四：重复词不重复添加，超长与空词被忽略', () => {
  const { window, doc, writes } = loadPopup({ customNameWords: ['猫咪君'] });
  try {
    const nameInput = doc.getElementById('customNameInput');
    const before = writes.length;
    nameInput.value = '猫咪君';
    doc.getElementById('customNameAdd').click();
    nameInput.value = 'x'.repeat(21);
    doc.getElementById('customNameAdd').click();
    nameInput.value = '   ';
    doc.getElementById('customNameAdd').click();
    const textInput = doc.getElementById('customTextInput');
    textInput.value = 'y'.repeat(21);
    doc.getElementById('customTextAdd').click();
    assert.deepEqual([...doc.querySelectorAll('#customNameChips .cChip em')].map((el) => el.textContent), ['猫咪君']);
    assert.equal(doc.querySelectorAll('#customTextChips .cChip').length, 0);
    assert.equal(writes.length, before, '无效输入不应触发写入');
  } finally {
    window.close();
  }
});

test('规则四：词条按文本渲染，不会被当成 HTML 注入', () => {
  const evil = '<img src=x>';
  const { window, doc } = loadPopup({ modeCustom: true, customNameWords: [evil] });
  try {
    const chips = doc.querySelectorAll('#customNameChips .cChip');
    assert.equal(chips.length, 1);
    assert.equal(doc.querySelector('#customNameChips img'), null, '不能生成 img 元素');
    assert.equal(chips[0].querySelector('em').textContent, evil, '原样显示文本');
    assert.equal(chips[0].querySelector('button').getAttribute('aria-label'), '删除「' + evil + '」');
  } finally {
    window.close();
  }
});

test('规则四：开关切换写入 modeCustom 并更新灰态', () => {
  const { window, doc, writes } = loadPopup({});
  try {
    const box = doc.getElementById('modeCustom');
    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(writes.at(-1).modeCustom, true);
    assert.equal(doc.getElementById('customBlock').classList.contains('off'), false);
  } finally {
    window.close();
  }
});

test('规则四：改开关只写该开关，不把词表旧值一起写回（防多窗口/多端互相覆盖）', () => {
  const { window, doc, writes } = loadPopup({ modeCustom: true, customNameWords: ['猫咪君'] });
  try {
    const box = doc.getElementById('modeFish');
    box.checked = false;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    const last = writes.at(-1);
    assert.equal(last.modeFish, false);
    assert.equal('customNameWords' in last, false, '未改动的昵称词表不能出现在写入里');
    assert.equal('customTextWords' in last, false, '未改动的评论词表不能出现在写入里');
    assert.equal('combine' in last, false, '未改动的组合方式也不能顺手写回');
  } finally {
    window.close();
  }
});

test('规则四内部组合：默认并集，可切交集并写入 customCombine', () => {
  const { window, doc, writes } = loadPopup({ customNameWords: ['猫咪君'], customTextWords: ['好可爱'] });
  try {
    const active = () => doc.querySelector('#customCombineSeg button.on')?.dataset.ccombine;
    assert.equal(active(), 'union');
    doc.querySelector('#customCombineSeg button[data-ccombine="intersect"]').click();
    assert.equal(active(), 'intersect');
    assert.equal(writes.at(-1).customCombine, 'intersect');
  } finally {
    window.close();
  }
});

test('规则四内部组合：读取已存的交集设置', () => {
  const { window, doc } = loadPopup({ customCombine: 'intersect' });
  try {
    assert.equal(doc.querySelector('#customCombineSeg button.on')?.dataset.ccombine, 'intersect');
  } finally {
    window.close();
  }
});

test('规则四：旧版 customWords 只显示在评论栏', () => {
  const { window, doc } = loadPopup({ customWords: ['猫咪'], modeCustom: true });
  try {
    assert.deepEqual([...doc.querySelectorAll('#customNameChips .cChip em')].map((el) => el.textContent), [], '昵称栏不应被旧列表填充');
    assert.deepEqual([...doc.querySelectorAll('#customTextChips .cChip em')].map((el) => el.textContent), ['猫咪']);
  } finally {
    window.close();
  }
});

test('规则四：删光旧版迁移来的词后清掉 customWords，重载不会回魂', () => {
  const { window, doc, writes, removed } = loadPopup({ modeCustom: true, customWords: ['猫咪'] });
  try {
    assert.equal(doc.querySelectorAll('#customTextChips .cChip').length, 1, '旧词应先显示在评论栏');
    doc.querySelector('#customTextChips .cChip button').click();
    assert.deepEqual(removed, ['customWords'], '词表由新字段接管后应删除旧字段');
    assert.deepEqual([...writes.at(-1).customTextWords], [], '新字段应写入空表');
  } finally {
    window.close();
  }
});

test('规则四：满 20 个词时加号禁用，删一个后恢复可点', () => {
  const words = Array.from({ length: 20 }, (_, i) => '词' + i);
  const { window, doc } = loadPopup({ modeCustom: true, customNameWords: words });
  try {
    const add = doc.getElementById('customNameAdd');
    assert.equal(add.disabled, true, '满 20 个时加号应禁用');
    doc.querySelector('#customNameChips .cChip button').click();
    assert.equal(doc.querySelectorAll('#customNameChips .cChip').length, 19);
    assert.equal(add.disabled, false, '删词后加号必须恢复可点，否则用户被卡死');
  } finally {
    window.close();
  }
});

test('规则四：用回车加满第 20 个词后加号立即禁用', () => {
  const words = Array.from({ length: 19 }, (_, i) => '词' + i);
  const { window, doc } = loadPopup({ modeCustom: true, customTextWords: words });
  try {
    const input = doc.getElementById('customTextInput');
    input.value = '第二十个';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(doc.querySelectorAll('#customTextChips .cChip').length, 20);
    assert.equal(doc.getElementById('customTextAdd').disabled, true, '加满后应立即禁用，而不是等下一次重绘');
  } finally {
    window.close();
  }
});

test('规则四：输入法选词中的回车不提交词语', () => {
  const { window, doc, writes } = loadPopup({ modeCustom: true });
  try {
    const input = doc.getElementById('customNameInput');
    input.value = '猫咪君';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    assert.equal(doc.querySelectorAll('#customNameChips .cChip').length, 0, '选词回车只是上屏，不能添加');
    assert.equal(input.value, '猫咪君', '输入框内容应保留');
    assert.equal(writes.length, 0, '选词回车不应触发写入');
  } finally {
    window.close();
  }
});

test('规则四：存储写入失败时提示「保存失败」而不是假装已保存', () => {
  const { window, doc } = loadPopup({ modeCustom: true }, { setError: 'QUOTA_BYTES quota exceeded' });
  try {
    const input = doc.getElementById('customNameInput');
    input.value = '猫咪君';
    doc.getElementById('customNameAdd').click();
    const saved = doc.getElementById('saved');
    assert.equal(saved.textContent, '保存失败');
    assert.equal(saved.classList.contains('err'), true);
    assert.equal(saved.classList.contains('on'), true);
  } finally {
    window.close();
  }
});
