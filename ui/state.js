// Part of board.html: included into its script by server/ui.mjs and shares its scope.
const PAGE = 40;
const COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'sky', 'lime'];
const COLOR_NAMES = { gray: 'グレー', blue: '青', green: '緑', yellow: '黄', orange: 'オレンジ', red: '赤', purple: '紫', pink: 'ピンク', sky: '水色', lime: 'ライム' };
const SHARED_UI_KEYS = ['filters', 'themePref', 'layout', 'boardView', 'sidebar', 'workspacePage', 'paneGlobal', 'cardWidths', 'cardHeights', 'collapsedLanes'];
const sharedUi = { revision: null, ready: false, dirty: false, blocked: false, applying: false, inflight: false, generation: 0, timer: null, checkTimer: null };
const store = {
  get(k, d) { try { const v = localStorage.getItem(`sk:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) {
    let changed = true;
    try {
      const serialized = JSON.stringify(v);
      changed = localStorage.getItem(`sk:${k}`) !== serialized;
      localStorage.setItem(`sk:${k}`, serialized);
    } catch {}
    if (changed && SHARED_UI_KEYS.includes(k) && sharedUi.ready && !sharedUi.applying) {
      sharedUi.dirty = true;
      sharedUi.generation++;
      store.cache('sharedUiPending', { revision: sharedUi.revision });
      scheduleSharedUiSave();
    }
  },
  cache(k, v) { try { localStorage.setItem(`sk:${k}`, JSON.stringify(v)); } catch {} },
};
const DEFAULT_FILTERS = { agent: 'all', host: '', account: '', status: '', project: '', directory: '', label: '', q: '', days: 30, includeArchived: false, includeSubagents: false, groupBranch: false, fulltext: false, swimlane: '', laneHeight: 'normal' };
const LANE_HEIGHTS = { compact: ['コンパクト', '240px'], normal: ['標準', '420px'], full: ['すべて', 'none'] };
const state = {
  board: null,
  filters: { ...DEFAULT_FILTERS, ...store.get('filters', {}) },
  sideOpen: store.get('sidebar', window.innerWidth > 900),
  themePref: store.get('themePref', 'system'),
  sideQ: '',
  soloLane: null,
  lanes: [],
  shown: {},              // listId -> number of cards rendered
  drag: null,
  busy: false,
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v; // trusted markup only (icons)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const colorVar = (c) => (c ? `var(--c-${c})` : 'transparent');

function relTime(ms) {
  if (!ms) return '';
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'たった今';
  if (d < 3600) return `${Math.floor(d / 60)}分前`;
  if (d < 86400) return `${Math.floor(d / 3600)}時間前`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}日前`;
  return new Date(ms).toLocaleDateString('ja-JP');
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('ja-JP') : '-');

let toastTimer;
function toast(msg, isError = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: `toast${isError ? ' error' : ''}`, role: 'status', text: msg });
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), isError ? 5000 : 2200);
}

async function act(name, args, { reload = true, okMsg } = {}) {
  live.ownActAt = Date.now();
  try {
    const res = await bridge.callTool(name, args);
    if (okMsg) toast(okMsg);
    if (reload) await load();
    return res;
  } catch (e) {
    toast(e.message, true);
    await load();
    throw e;
  }
}
