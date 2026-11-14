import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

class Element {
  constructor(tag, attrs = {}, ...children) { this.tag = tag; this.attrs = { ...attrs }; this.dataset = {}; this.children = []; Object.assign(this, attrs); for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; this.append(...children); }
  append(...children) { this.children.push(...children.flat().filter(Boolean)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attrs[key] = value; }
  removeAttribute(key) { delete this.attrs[key]; }
  matches(selector) { const cls = selector.match(/\.([\w-]+)/), attr = selector.match(/\[([\w-]+)\]/); return (!cls || (this.class || '').split(' ').includes(cls[1])) && (!attr || Object.hasOwn(this.attrs, attr[1])) && (cls || attr || this.tag === selector); }
  querySelector(selector) { for (const child of this.children) { if (child instanceof Element) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found; } } return null; }
  get textContent() { return this.text || this.children.map(child => child.textContent || '').join(''); }
  set textContent(value) { this.text = value; this.children = []; }
}

test('detail failure stops claiming permission is loading and retry retains the same draft and selection', async () => {
  const read = name => fs.readFileSync(process.env.CANBAN_LOAD_SOURCE ? path.join(process.env.CANBAN_LOAD_SOURCE,name) : new URL('../ui/'+name, import.meta.url), 'utf8');
  const requests = read('requests.js'), overlay = read('card-overlay.js');
  const h = (...args) => new Element(...args), notices = [];
  let submit, rebuilds = 0, reject;
  const context = vm.createContext({ h, state: { board: { settings: { dispatch: { enabled: true } } } }, picon: () => '', keyHint: () => null,
    promptComposer: (input, opts) => { submit = opts.submit; return { root: h('div', {}, input, ...opts.leading, ...opts.actions) }; }, toast: message => notices.push(message),
    takeSessionDetail: () => new Promise((_, fail) => { reject = fail; }), paintPendingSession: () => { rebuilds++; }, closeCards() {},
    conversationLoadingPlaceholder: () => h('div', { class: 'conv-wait' }), renderPaneKeepingDrafts() {} });
  vm.runInContext(requests.slice(requests.indexOf('function renderPendingDispatch('), requests.indexOf('function requestRow(')) + '\nthis.dispatch = renderPendingDispatch({id:"codex:mock"});', context);
  const input = context.dispatch.querySelector('textarea'); input.value = '次の改善をここから続ける'; input.selectionStart = 3; input.selectionEnd = 7;
  const conv = h('div', { class: 'th-conv', 'aria-busy': 'true' });
  const pane = { id: 'codex:mock', pending: true, d: null, el: h('article', {}, conv, context.dispatch) };
  context.panes = [pane];
  vm.runInContext(overlay.slice(overlay.indexOf('async function loadSession('), overlay.indexOf('async function openTaskCard(')), context);
  const first = vm.runInContext('loadSession(panes[0])', context); reject(new Error('tools/call がタイムアウトしました')); await first;
  assert.match(context.dispatch.querySelector('.perm-chip').textContent, /未取得/);
  assert.equal(context.dispatch.attrs['aria-busy'], 'false');
  assert.equal(context.dispatch.querySelector('.send-round').disabled, true);
  submit(); assert.match(notices.at(-1), /再読み込み/);
  const retry = vm.runInContext('loadSession(panes[0])', context);
  assert.equal(rebuilds, 0, 'retry must update the conversation placeholder, not recreate the input');
  assert.equal(context.dispatch.querySelector('textarea'), input);
  assert.equal(input.value, '次の改善をここから続ける'); assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 7);
  assert.match(context.dispatch.querySelector('.perm-chip').textContent, /確認中/);
  assert.equal(context.dispatch.attrs['aria-busy'], 'true');
  reject(new Error('再試行失敗')); await retry;
});
