#!/usr/bin/env node
/**
 * 版本号切换（只改文本，不重排 JSON）：
 *   node scripts/set-version.mjs --fix      开发/修复期：显示名改成 v1.03-fix，数字版本不变
 *   node scripts/set-version.mjs 1.0.4      正式发布：数字版本与显示名一起改（v1.04）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'manifest.json');
const pkgPath = join(root, 'package.json');

function displayName(version) {
  const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10));
  return 'v' + major + '.' + String(minor * 10 + (patch || 0)).padStart(2, '0');
}

function replaceField(text, field, value) {
  const re = new RegExp('("' + field + '"\\s*:\\s*")[^"]*(")');
  if (!re.test(text)) throw new Error('找不到字段 ' + field);
  return text.replace(re, (m, p1, p2) => p1 + value + p2);
}

const arg = process.argv[2];
if (arg === '--fix') {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const next = displayName(manifest.version) + '-fix';
  writeFileSync(manifestPath, replaceField(readFileSync(manifestPath, 'utf8'), 'version_name', next));
  console.log('开发期显示名：' + next + '（数字版本仍是 ' + manifest.version + '）');
} else if (/^\d+\.\d+\.\d+$/.test(arg || '')) {
  let manifest = readFileSync(manifestPath, 'utf8');
  manifest = replaceField(replaceField(manifest, 'version', arg), 'version_name', displayName(arg));
  writeFileSync(manifestPath, manifest);
  writeFileSync(pkgPath, replaceField(readFileSync(pkgPath, 'utf8'), 'version', arg));
  console.log('正式版本：' + arg + ' / 显示名 ' + displayName(arg));
} else {
  console.error('用法：node scripts/set-version.mjs --fix | <x.y.z>');
  process.exit(1);
}