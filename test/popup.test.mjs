import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(root, 'popup.html'), 'utf8');
const SCRIPT = readFileSync(join(root, 'popup.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

function loadPopup(stored) {
  const dom = new JSDOM(HTML, { url: 'https://example.com', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  window.chrome = {
    runtime: { getManifest: () => ({ version: MANIFEST.version, version_name: MANIFEST.version_name }) },
    storage: { sync: { get: (defaults, cb) => cb({ ...defaults, ...stored }) } },
  };
  window.eval(SCRIPT);
  return { window, doc: window.document };
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
