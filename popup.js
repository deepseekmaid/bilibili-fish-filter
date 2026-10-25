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
