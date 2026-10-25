#!/usr/bin/env node
/**
 * 由 content.js 生成油猴脚本：
 *  - 去掉 Chrome 存储适配与消息通道，注入 GM 适配层；
 *  - 面板直接复用 popup.html 的样式/结构与 popup.js 的逻辑，保证与扩展弹窗一模一样。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const source = readFileSync(join(root, 'content.js'), 'utf8');
const tail = readFileSync(join(root, 'scripts/userscript/tail.js'), 'utf8');
const popupHtml = readFileSync(join(root, 'popup.html'), 'utf8');
const popupJs = readFileSync(join(root, 'popup.js'), 'utf8');

function stripRegion(code, name) {
  const re = new RegExp('[ \\t]*// BAF:' + name + '-START[\\s\\S]*?// BAF:' + name + '-END\\n?');
  const next = code.replace(re, '');
  if (next === code) throw new Error('找不到区域标记：' + name);
  return next;
}

// popup 的样式：把 body 选择器改成面板容器，其余原样
const styleMatch = popupHtml.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error('popup.html 里找不到 <style>');
const panelCss = styleMatch[1]
  .replace(/(^|\n)(\s*)body\s*\{/, '$1$2.baf-popup {')
  .replace(/\n\s*$/, '');

// popup 的 body 结构：去掉脚本标签，图标内联成 data URI
const bodyMatch = popupHtml.match(/<body>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error('popup.html 里找不到 <body>');
const iconBase64 = readFileSync(join(root, 'icons/icon48.png')).toString('base64');
const panelHtml = bodyMatch[1]
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/src="icons\/icon48\.png"/g, 'src="data:image/png;base64,' + iconBase64 + '"')
  .trim();

let body = stripRegion(source, 'ADAPTER');
body = stripRegion(body, 'MESSAGE');

if (!body.includes('// BAF:BOOT')) throw new Error('找不到 BAF:BOOT 标记');

const display = (manifest.version_name || manifest.version).replace(/^v/, '');
const injected = [
  '  const BAF_VERSION = ' + JSON.stringify(manifest.version) + ';',
  '  const BAF_VERSION_NAME = ' + JSON.stringify(manifest.version_name || 'v' + manifest.version) + ';',
  '  const PANEL_CSS = ' + JSON.stringify(panelCss) + ';',
  '  const PANEL_HTML = ' + JSON.stringify(panelHtml) + ';',
  '  const BAF_DISPLAY_VERSION = ' + JSON.stringify(display) + ';',
  '',
  '  /* ===== 下面是 popup.js 原文，作为函数体在面板里运行 ===== */',
  '  function bafPopupMain(chrome, document, globalThis) {',
  popupJs,
  '  }',
  '',
  tail,
  '',
].join('\n');

body = body.replace(/[ \t]*\/\/ BAF:BOOT[^\n]*\n/, (line) => injected + line);
body = body.replace(/\}\)\(\);\s*$/, '  setupPanel();\n})();\n');

const header = [
  '// ==UserScript==',
  '// @name         ' + manifest.name + '（油猴版）',
  '// @namespace    https://github.com/Sword-New-New/bilibili-fish-filter',
  '// @version      ' + manifest.version,
  '// @description  ' + manifest.description,
  '// @match        https://www.bilibili.com/*',
  '// @match        https://t.bilibili.com/*',
  '// @match        https://space.bilibili.com/*',
  '// @match        https://live.bilibili.com/*',
  '// @grant        GM_getValue',
  '// @grant        GM_setValue',
  '// @grant        GM_registerMenuCommand',
  '// @run-at       document-idle',
  '// @noframes',
  '// ==/UserScript==',
  '',
].join('\n');

const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'bilibili-fish-filter.user.js');
writeFileSync(outFile, header + body);
console.log('built ' + outFile + '  v' + display + '  (' + manifest.version + ')  ' + Buffer.byteLength(header + body) + ' bytes');
