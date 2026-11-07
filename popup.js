/* B站大肥鱼过滤器 — 设置面板 */
const DEFAULTS = { atMode: 'off', modeFish: true, masterMode: 'startsWith', combine: 'union', autoLoad: false, fastMode: false, modeCustom: false, customNameWords: [], customTextWords: [], customCombine: 'union' };

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
    const key = btn.dataset.mode || btn.dataset.combine;
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
  paintSeg(combineSeg, combine);
  paintSeg(atSeg, atMode);
  paintSeg(masterSeg, masterMode);
  paintCustomSeg();
  if (customBox && customBlock) {
    customBlock.classList.toggle('off', !customBox.checked);
  }
  syncAddButtons();
}

function persist(patch) {
  // 只写本次真正改动的键：一次把所有键（尤其两个词表）写回，会用本窗口的旧值
  // 覆盖另一个窗口/另一台设备刚加的词语。
  const payload = patch || {
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
