#!/usr/bin/env node
/** 校验版本号一致：manifest.version == package.json.version == dist 油猴脚本 @version。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const userscriptPath = join(root, 'dist/bilibili-fish-filter.user.js');

const problems = [];
if (manifest.version !== pkg.version) {
  problems.push(`manifest.version=${manifest.version} 与 package.json.version=${pkg.version} 不一致`);
}

let scriptVersion = null;
try {
  const text = readFileSync(userscriptPath, 'utf8');
  const match = text.match(/^\/\/ @version\s+(\S+)/m);
  scriptVersion = match ? match[1] : null;
  if (scriptVersion !== manifest.version) {
    problems.push(`油猴脚本 @version=${scriptVersion} 与 manifest.version=${manifest.version} 不一致（先跑 npm run build）`);
  }
} catch {
  problems.push('找不到 dist/bilibili-fish-filter.user.js（先跑 npm run build）');
}

if (problems.length) {
  console.error('版本不一致：');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}

const name = manifest.version_name ? `（显示名 ${manifest.version_name}）` : '';
console.log(`版本一致：${manifest.version} ${name}`);
