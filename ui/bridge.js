// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Host bridge: MCP Apps (postMessage JSON-RPC) with window.openai fallback
const bridge = (() => {
  let nextId = 1;
  const waiting = new Map();
  const listeners = {};
  let nativePort = null;
  const nativeChunks = new Map();
  const isChromeExtension = () => location.protocol === 'chrome-extension:' && !!globalThis.chrome?.runtime?.connectNative;
  const on = (m, fn) => ((listeners[m] ||= []).push(fn));
  const emit = (m, p) => (listeners[m] || []).forEach((fn) => { try { fn(p); } catch (e) { console.error(e); } });

  function post(msg) { window.parent.postMessage(msg, '*'); }
  function request(method, params, timeout = 60000) {
    const id = nextId++;
    post({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} がタイムアウトしました`)); }, timeout);
      waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method, params }); }

  function settleNative(message) {
    const w = waiting.get(message?.id);
    if (!w) return;
    waiting.delete(message.id);
    clearTimeout(w.timer);
    if (message.error) w.reject(new Error(message.error.message || 'Canban Native Messaging Host error'));
    else w.resolve(message.result ?? {});
  }

  function consumeNativeMessage(message) {
    if (message?.__canbanChunk !== 1) { settleNative(message); return; }
    const { id, index, total, data } = message;
    if (!waiting.has(id) || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0 || index >= total || typeof data !== 'string') return;
    const item = nativeChunks.get(id) || { total, parts: new Array(total).fill(undefined) };
    if (item.total !== total || item.parts[index]) return;
    item.parts[index] = data;
    nativeChunks.set(id, item);
    if (item.parts.some((part) => typeof part !== 'string')) return;
    nativeChunks.delete(id);
    try {
      const decoded = item.parts.map((part) => atob(part));
      const size = decoded.reduce((n, part) => n + part.length, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of decoded) {
        for (let i = 0; i < part.length; i++) bytes[offset++] = part.charCodeAt(i);
      }
      settleNative(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      const w = waiting.get(id);
      if (w) { waiting.delete(id); clearTimeout(w.timer); w.reject(error); }
    }
  }

  function connectNative() {
    if (nativePort) return nativePort;
    try {
      nativePort = chrome.runtime.connectNative('com.kamihicouki.canban');
      nativePort.onMessage.addListener(consumeNativeMessage);
      nativePort.onDisconnect.addListener(() => {
        const reason = chrome.runtime.lastError?.message || 'Native Messaging Hostとの接続が切れました';
        nativePort = null;
        for (const [id, w] of waiting) { clearTimeout(w.timer); w.reject(new Error(reason)); }
        waiting.clear();
        nativeChunks.clear();
      });
      return nativePort;
    } catch (error) {
      nativePort = null;
      throw new Error(`Canban Native Messaging Hostに接続できません: ${error.message}`);
    }
  }

  function nativeRequest(method, params, timeout = 60000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); nativeChunks.delete(id); reject(new Error(`${method} がタイムアウトしました`)); }, timeout);
      waiting.set(id, { resolve, reject, timer });
      try { connectNative().postMessage({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { waiting.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window.parent) return;
    const m = ev.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && (m.result !== undefined || m.error !== undefined) && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error.message || 'Host error')) : w.resolve(m.result);
      return;
    }
    if (m.method) {
      emit(m.method, m.params);
      if (m.id != null) post({ jsonrpc: '2.0', id: m.id, result: {} }); // ack host requests (e.g. teardown)
    }
  });

  const openai = () => window.openai && typeof window.openai.callTool === 'function' ? window.openai : null;

  async function init() {
    if (openai()) {
      return { theme: window.openai.theme, displayMode: window.openai.displayMode };
    }
    if (isChromeExtension()) return { theme: null, displayMode: 'fullscreen', locale: 'ja-JP' };
    try {
      const res = await request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'canban', version: '__CANBAN_VERSION__' },
        appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
      }, 8000);
      notify('ui/notifications/initialized', {});
      return res?.hostContext || {};
    } catch (e) {
      console.warn('ui/initialize failed', e);
      return {};
    }
  }

  async function callTool(name, args = {}) {
    let res;
    const t0 = performance.now();
    const pending = !!hooks.pending?.();
    const concurrent = !openai() && isChromeExtension();
    if (openai()) res = await window.openai.callTool(name, args);
    else if (concurrent) res = await nativeRequest('tools/call', { name, arguments: args });
    else res = await request('tools/call', { name, arguments: args });
    hooks.after?.(name, t0, pending, concurrent);
    if (res?.isError) {
      const text = (res.content || []).map((c) => c.text).filter(Boolean).join('\n');
      throw Object.assign(new Error(text || `${name} failed`), { code: res.structuredContent?.code || null });
    }
    return res?.structuredContent ?? res;
  }

  function openLink(url) {
    if (!openai() && /^https?:/i.test(url) && hooks.linkBrowser?.()) return callTool('canban_open_external', { url });
    if (openai() && window.openai.openExternal) return window.openai.openExternal({ href: url });
    if (isChromeExtension()) return chrome.tabs.create({ url });
    return request('ui/open-link', { url }, 5000);
  }
  function requestFullscreen() {
    if (openai() && window.openai.requestDisplayMode) return window.openai.requestDisplayMode({ mode: 'fullscreen' }).catch(() => {});
    if (isChromeExtension()) return Promise.resolve();
    return request('ui/request-display-mode', { mode: 'fullscreen' }, 3000).catch(() => {});
  }
  function reportSize() {
    if (isChromeExtension()) return;
    notify('ui/notifications/size-changed', { width: document.documentElement.scrollWidth, height: Math.max(560, window.innerHeight) });
  }
  const hooks = {}; // pending(): a long poll is open; after(name, startedAt, pending, concurrent)
  return { init, callTool, on, openLink, requestFullscreen, reportSize, hooks };
})();
