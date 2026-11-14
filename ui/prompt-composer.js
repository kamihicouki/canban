// Shared composer for task launches and session follow-ups. Drafts survive live
// re-rendering; binary files never go into board settings or localStorage.
const promptDrafts = new Map();
const VOICE_SILENCE_MS = 5000;

function cleanTextForSpeech(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/<[a-zA-Z0-9_-]+>[\s\S]*?<\/[a-zA-Z0-9_-]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[ \t]*(?:#{1,6}\s+|[-*+]\s+|>\s+)/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const voiceMode = {
  active: false,
  silenceMs: VOICE_SILENCE_MS,
  ttsEnabled: true,
  composers: new Set(),
  current: null,
  recognition: null,
  silenceTimer: null,
  resultOffset: 0,
  lastResultsLength: 0,
  baseText: '',
  speakingCardId: null,
  lastSpokenText: new Map(),
  cleanTextForSpeech,

  getSpeechRecognition() {
    return typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  },

  resolveTarget(preferred = null) {
    for (const c of [...this.composers]) {
      if (c.root.isConnected === false) this.composers.delete(c);
    }
    if (preferred && this.composers.has(preferred) && preferred.root.isConnected !== false) return preferred;
    if (typeof document !== 'undefined') {
      const dialog = document.querySelector?.('.task-quick-dialog[open]');
      if (dialog) {
        const inDialog = [...this.composers].find(c => dialog.contains?.(c.root) && !c.root.closest?.('[hidden]'));
        if (inDialog) return inDialog;
      }
      if (typeof paneLayer !== 'undefined') {
        if (!paneLayer.hidden && typeof focusedPane === 'function') {
          const fp = focusedPane();
          if (fp?.el) {
            const inPane = [...this.composers].find(c => fp.el.contains?.(c.root));
            if (inPane) return inPane;
          }
          if (typeof panes !== 'undefined') {
            for (const p of panes) {
              const inPane = [...this.composers].find(c => p.el?.contains?.(c.root));
              if (inPane) return inPane;
            }
          }
        }
        const outsidePane = [...this.composers].find(c => document.body?.contains?.(c.root) && !paneLayer.contains?.(c.root) && !c.root.closest?.('[hidden], dialog:not([open])'));
        return outsidePane || null;
      }
      const activeEl = document.activeElement;
      if (activeEl) {
        const byFocus = [...this.composers].find(c => c.root.contains?.(activeEl) || c.root.closest?.('.pane')?.contains?.(activeEl));
        if (byFocus) return byFocus;
      }
    }
    if (this.current && this.composers.has(this.current) && this.current.root.isConnected !== false) return this.current;
    return [...this.composers].at(-1) || null;
  },

  clearSilenceTimer() {
    if (this.silenceTimer) {
      const clear = typeof clearTimeout === 'function' ? clearTimeout : (typeof window !== 'undefined' ? window.clearTimeout : null);
      if (clear) clear(this.silenceTimer);
      this.silenceTimer = null;
    }
  },

  stopSpeaking() {
    this.speakingCardId = null;
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    if (synth) {
      try { synth.cancel(); } catch {}
    }
  },

  speak(text, cardId = null) {
    if (!this.active || !this.ttsEnabled) return false;
    if (cardId && typeof paneLayer !== 'undefined' && !paneLayer.hidden && typeof focusedPane === 'function') {
      const fp = focusedPane();
      const visibleIds = typeof panes !== 'undefined' ? panes.map(p => p.id) : [];
      if (fp && fp.id !== cardId && !(fp.kind === 'task' && visibleIds.includes(cardId))) return false;
    }
    const clean = cleanTextForSpeech(text);
    if (!clean) return false;
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    const Utterance = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null;
    if (!synth || !Utterance) return false;
    try {
      synth.cancel();
      const u = new Utterance(clean);
      u.lang = (typeof navigator !== 'undefined' && navigator.language) || 'ja-JP';
      this.speakingCardId = cardId;
      u.onend = u.onerror = () => {
        if (this.speakingCardId === cardId) this.speakingCardId = null;
      };
      synth.speak(u);
      return true;
    } catch {
      return false;
    }
  },

  onAssistantMessage(cardId, text) {
    if (!this.active || !this.ttsEnabled || !text) return false;
    if (this.lastSpokenText.get(cardId) === text) return false;
    this.lastSpokenText.set(cardId, text);
    return this.speak(text, cardId);
  },

  updateUI() {
    const SR = this.getSpeechRecognition();
    for (const c of this.composers) {
      const isTarget = this.active && this.current === c;
      c.box.classList?.toggle?.('voice-active', isTarget);
      if (isTarget) {
        c.micButton.classList?.add?.('listening');
        c.micButton.innerHTML = picon('stop', 16);
        c.micButton.title = '音声入力を停止（Alt+M）';
        c.micButton.setAttribute?.('aria-label', '音声入力を停止');
        if (!c.notice.textContent || c.notice.textContent.startsWith('音声') || c.notice.textContent.startsWith('🎙')) {
          c.notice.textContent = '音声を聞き取っています…（5秒無音で自動送信）';
        }
      } else {
        c.micButton.classList?.remove?.('listening');
        c.micButton.innerHTML = picon('mic', 16);
        c.micButton.title = SR ? '音声入力（Alt+M）' : '音声認識はお使いの環境でサポートされていません';
        c.micButton.setAttribute?.('aria-label', '音声入力');
        if (c.notice.textContent?.startsWith('音声を聞き取って') || c.notice.textContent?.startsWith('🎙')) {
          c.notice.textContent = '';
        }
      }
    }
  },

  bindTarget(target, lastEventResultsLength = null) {
    if (this.current === target) {
      this.updateUI();
      return;
    }
    this.clearSilenceTimer();
    this.stopSpeaking();
    this.current = target;
    if (target) {
      let base = target.input.value || '';
      if (base && !base.endsWith(' ') && !base.endsWith('\n')) base += ' ';
      this.baseText = base;
    } else {
      this.baseText = '';
    }
    if (lastEventResultsLength !== null) {
      this.resultOffset = lastEventResultsLength;
    } else if (this.lastResultsLength) {
      this.resultOffset = this.lastResultsLength;
    }
    this.updateUI();
  },

  sync(preferred = null) {
    if (!this.active) {
      this.updateUI();
      return;
    }
    const next = this.resolveTarget(preferred);
    if (next !== this.current) {
      this.bindTarget(next);
    } else {
      this.updateUI();
    }
    if (next && !this.recognition && !next.draft.sending) {
      this.ensureRecognition();
    }
  },

  matchChoiceReply(target, text) {
    const trimmed = text.trim().replace(/[。、！？.!?\s]+$/g, '');
    if (!trimmed || typeof panes === 'undefined') return null;
    const pane = panes.find(p => p.el?.contains?.(target.root));
    const choices = pane?.choices;
    if (!choices?.length) return null;
    for (let i = 0; i < choices.length; i++) {
      const c = choices[i];
      const key = String(c.key).toLowerCase();
      const norm = trimmed.toLowerCase();
      if (
        norm === key ||
        norm === `${key}で` ||
        norm === `${key}でお願いします` ||
        norm === `${key}にする` ||
        norm === `${i + 1}` ||
        norm === `${i + 1}番` ||
        norm === `${i + 1}番で` ||
        (c.recommended && (norm === '推奨' || norm === '推奨で' || norm === 'おすすめ'))
      ) {
        return c.reply;
      }
    }
    return null;
  },

  scheduleAutoSubmit(target) {
    this.clearSilenceTimer();
    if (!this.active || !target || target.draft.sending) return;
    const setTimer = typeof setTimeout === 'function' ? setTimeout : (typeof window !== 'undefined' ? window.setTimeout : null);
    if (!setTimer) return;
    this.silenceTimer = setTimer(() => {
      this.silenceTimer = null;
      if (!this.active || this.current !== target || target.draft.sending) return;
      const val = target.input.value.trim();
      if (!val) return;
      const spokenPart = val.slice(this.baseText.trim().length).trim() || val;
      const matchedReply = this.matchChoiceReply(target, spokenPart);
      if (matchedReply) {
        target.input.value = matchedReply;
        target.draft.text = matchedReply;
      }
      this.baseText = '';
      this.resultOffset = this.lastResultsLength || 0;
      target.notice.textContent = '🎙 自動送信しました';
      target.submit?.();
    }, this.silenceMs);
  },

  ensureRecognition() {
    const SR = this.getSpeechRecognition();
    if (!SR) {
      if (this.current) this.current.notice.textContent = 'お使いのブラウザは音声認識に対応していません';
      this.active = false;
      this.updateUI();
      return;
    }
    if (this.recognition) return;
    try {
      const rec = new SR();
      this.recognition = rec;
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'ja-JP';
      this.resultOffset = 0;
      this.lastResultsLength = 0;

      rec.onstart = () => {
        if (!this.active) return;
        this.updateUI();
      };

      rec.onresult = event => {
        if (!this.active) return;
        const target = this.current || this.resolveTarget();
        if (!target || target.draft.sending) return;
        if (this.speakingCardId) this.stopSpeaking();
        this.lastResultsLength = event.results.length;
        if (this.resultOffset > event.results.length) this.resultOffset = 0;
        let interim = '', final = '';
        for (let i = this.resultOffset; i < event.results.length; ++i) {
          const res = event.results[i];
          if (res.isFinal) final += res[0].transcript;
          else interim += res[0].transcript;
        }
        const spoken = final + (interim ? (final ? ' ' : '') + interim : '');
        target.input.value = this.baseText + spoken;
        target.draft.text = target.input.value;
        target.fit();
        if (spoken.trim()) {
          target.notice.textContent = '音声を聞き取っています…（5秒無音で自動送信）';
          this.scheduleAutoSubmit(target);
        }
      };

      rec.onerror = event => {
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        if (this.current) this.current.notice.textContent = `音声認識エラー: ${event.error}`;
        this.stop();
      };

      rec.onend = () => {
        if (this.recognition === rec) this.recognition = null;
        if (this.active && typeof document !== 'undefined') {
          const target = this.current || this.resolveTarget();
          if (target && !target.draft.sending) {
            let base = target.input.value || '';
            if (base && !base.endsWith(' ') && !base.endsWith('\n')) base += ' ';
            this.baseText = base;
            try { this.ensureRecognition(); } catch {}
          }
        } else if (!this.active) {
          this.updateUI();
        }
      };

      rec.start();
    } catch (e) {
      if (this.current) this.current.notice.textContent = `音声認識を開始できませんでした: ${e.message}`;
      this.stop();
    }
  },

  start(preferred = null) {
    const target = this.resolveTarget(preferred);
    const SR = this.getSpeechRecognition();
    if (!SR) {
      if (target) target.notice.textContent = 'お使いのブラウザは音声認識に対応していません';
      return;
    }
    if (target?.draft.sending) return;
    this.active = true;
    this.current = null;
    this.bindTarget(target, 0);
    this.ensureRecognition();
  },

  stop() {
    this.active = false;
    this.clearSilenceTimer();
    this.stopSpeaking();
    const rec = this.recognition;
    this.recognition = null;
    if (rec) {
      try { rec.stop(); } catch {}
    }
    this.current = null;
    this.baseText = '';
    this.resultOffset = 0;
    this.lastResultsLength = 0;
    this.updateUI();
  },

  toggle(preferred = null) {
    if (this.active) {
      if (preferred && this.current && preferred !== this.current) {
        this.bindTarget(preferred);
        return;
      }
      this.stop();
    } else {
      this.start(preferred);
    }
  },

  onComposerCleared(instance) {
    if (this.current === instance) {
      this.clearSilenceTimer();
      this.baseText = '';
      this.resultOffset = this.lastResultsLength || 0;
    }
  }
};
globalThis.voiceMode = voiceMode;

// Codex desktop style: one rounded box with attachments on top, the text, and one row of
// [+ image] [$ skill] [leading…] ··· [actions…]; key hints sit under the box.
function promptComposer(input, { key, context, submit, placeholder, leading = [], actions = [], inside = [], place = [], keys = null }) {
  const existing = promptDrafts.get(key);
  if (existing && existing.text === existing.baseline && !existing.images.length && !existing.skills.length && !existing.sending) existing.text = existing.baseline = input.value;
  const draft = promptDrafts.get(key) || { text: input.value, baseline: input.value, images: [], skills: [], context: null, sending: false };
  promptDrafts.set(key, draft);
  input.value = draft.text;
  const root = h('div', { class: 'prompt-composer' });
  const assets = h('div', { class: 'prompt-assets', 'aria-label': '添付画像とスキル' });
  const notice = h('div', { class: 'prompt-notice muted', role: 'status', 'aria-live': 'polite' });
  const picker = h('div', { class: 'prompt-skill-picker', id: `prompt-skills-${encodeURIComponent(key)}`, hidden: true });
  const search = h('input', { class: 'text-input', type: 'search', placeholder: 'スキル名・説明で検索', 'aria-label': 'スキルを検索' });
  const choices = h('div', { class: 'prompt-skill-choices', 'aria-label': '利用できるスキル' });
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true, 'aria-label': '添付する画像を選択' });
  if (placeholder) input.placeholder = placeholder;
  const imageButton = h('button', { type: 'button', class: 'cx-ico', title: '画像を添付（貼り付け・ドロップも可）', 'aria-label': '画像を添付', html: picon('plus', 16), onclick: () => fileInput.click() });
  const skillButton = h('button', { type: 'button', class: 'cx-ico', title: 'スキルを選ぶ（$）', 'aria-label': 'スキルを選ぶ', 'aria-expanded': 'false', 'aria-controls': picker.id, text: '$', onclick: () => toggleSkills() });
  const SpeechRecognition = voiceMode.getSpeechRecognition();
  const micButton = h('button', {
    type: 'button', class: 'cx-ico prompt-mic',
    title: SpeechRecognition ? '音声入力（Alt+M）' : '音声認識はお使いの環境でサポートされていません',
    'aria-label': '音声入力', html: picon('mic', 16),
    onclick: () => toggleSpeech(),
  });
  const toolbar = h('div', { class: 'prompt-toolbar' }, imageButton, skillButton, ...leading, h('span', { class: 'grow' }), micButton, ...actions);
  picker.append(h('div', { class: 'row' }, search, h('button', { type: 'button', class: 'icon-btn', text: '✕', 'aria-label': 'スキル選択を閉じる', onclick: () => closeSkills() })), choices);
  const box = h('div', { class: 'cx-box' }, assets, input, toolbar, picker, notice, ...inside, fileInput);
  root.append(...[box, place.length ? h('div', { class: 'cx-place' }, ...place) : null, keys?.length ? h('div', { class: 'cx-keys' }, ...keys) : null].filter(Boolean));
  // The text grows with its content up to the CSS max-height, like the Codex composer.
  const fit = () => { if (!input.style) return; input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
  input.addEventListener('input', fit);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fit);
  let catalog = [], loadedContext = null, pendingSkills = null, requestGeneration = 0, token = null;
  const voiceEntry = { key, root, box, input, micButton, notice, draft, submit: () => submit?.(), fit, context };
  voiceMode.composers.add(voiceEntry);
  const currentContext = () => {
    const value = context(), signature = JSON.stringify(value);
    if (draft.context && draft.context !== signature && draft.skills.length) {
      draft.skills = []; notice.textContent = '送信先が変わったため、スキルを選び直してください';
    }
    draft.context = signature;
    return { value, signature };
  };
  function paintView() {
    root.dataset.unsavedForm = String(!!draft.images.length || !!draft.skills.length || draft.sending);
    assets.replaceChildren(...draft.images.map(i => h('div', { class: 'prompt-image' },
      i.preview ? h('img', { src: i.preview, alt: i.name }) : null,
      h('span', { class: 'ellipsis', text: i.loading ? '添付中…' : i.previewLoading ? '画像を読込み中…' : i.previewError ? `${i.name || '添付画像'}（プレビューを表示できません）` : i.name, title: i.name }),
      h('button', { type: 'button', class: 'icon-btn', text: '✕', disabled: draft.sending, 'aria-label': `${i.name} を削除`, onclick: () => {
        draft.images = draft.images.filter(x => x !== i); i.removed = true; URL.revokeObjectURL(i.preview); paint();
      } }))),
      ...(context().route === 'desktop' && draft.images.length ? [h('span', { class: 'prompt-paste-hint muted', text: '画像は起動後にコピーし、アプリの入力欄で⌘Vを押してください' })] : []),
      ...draft.skills.map(s => h('div', { class: 'prompt-skill-chip', title: s.path },
        h('span', { text: `$${s.name}` }), h('button', { type: 'button', class: 'icon-btn', text: '✕', disabled: draft.sending,
          'aria-label': `${s.name} を削除`, onclick: () => { draft.skills = draft.skills.filter(x => x.path !== s.path); paint(); } }))));
    imageButton.disabled = skillButton.disabled = micButton.disabled = input.readOnly = draft.sending;
    if (draft.sending && voiceMode.current === voiceEntry) voiceMode.clearSilenceTimer();
    root.setAttribute('aria-busy', String(draft.sending || draft.images.some(i => i.loading)));
  }
  paintView.root = root;
  draft.views ||= new Set(); draft.views.add(paintView);
  function paint() {
    for (const view of draft.views) {
      if (view === paintView || view.root.isConnected) view(); else draft.views.delete(view);
    }
  }
  async function restoreImage(item) {
    if (item.preview || item.previewLoading) return;
    item.previewLoading = true; paint();
    const current = () => !item.removed && draft.images.includes(item);
    try {
      let offset = 0, sha256, mime, size; const chunks = [];
      do {
        const response = await bridge.callTool('canban_read_prompt_image', { id: item.id, offset, maxBytes: 128*1024, ...(sha256 ? { expectedSha256: sha256 } : {}) });
        if (!current()) return;
        const part = response.result;
        if (!part || part.id !== item.id || part.offset !== offset || !Number.isInteger(part.size) || part.size < 1 || part.size > 10*1024*1024 || !['image/png','image/jpeg','image/webp','image/gif'].includes(part.mime) || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error('画像の内容を確認できません');
        if (sha256 && (part.sha256 !== sha256 || part.size !== size || part.mime !== mime)) throw new Error('画像が変更されています');
        sha256 = part.sha256; size = part.size; mime = part.mime;
        const bytes = Uint8Array.from(atob(part.data), c => c.charCodeAt(0));
        if (!bytes.length || bytes.length > 128*1024 || part.nextOffset !== offset+bytes.length || part.nextOffset > size || part.complete !== (part.nextOffset === size)) throw new Error('画像の読込み範囲が一致しません');
        chunks.push(bytes); offset = part.nextOffset; item.name ||= part.name || '添付画像';
      } while (offset < size);
      const bytes = new Uint8Array(size); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x => x.toString(16).padStart(2,'0')).join('');
      if (digest !== sha256) throw new Error('画像のハッシュが一致しません');
      if (!current()) return;
      item.mime = mime; item.preview = URL.createObjectURL(new Blob([bytes], { type: mime })); item.previewError = false;
    } catch { if (current()) item.previewError = true; }
    finally { item.previewLoading = false; paint(); }
  }
  const readData = blob => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('画像を読み取れませんでした')); reader.readAsDataURL(blob);
  });
  async function addFiles(files) {
    if (draft.sending) return;
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { notice.textContent = 'PNG・JPEG・WebP・GIFの画像を選択してください'; continue; }
      if (file.size > 10 * 1024 * 1024 || !file.size) { notice.textContent = '画像は1枚10MBまでです'; continue; }
      if (draft.images.length >= 8) { notice.textContent = '画像は8枚までです'; break; }
      const item = { name: file.name || '貼り付け画像', mime: file.type, preview: URL.createObjectURL(file), loading: true };
      draft.images.push(item); paint();
      try {
        let id, offset = 0;
        while (offset < file.size && !item.removed) {
          const chunk = file.slice(offset, offset + 256 * 1024);
          const data = await readData(chunk);
          const response = await bridge.callTool('canban_upload_prompt_image', { ...(id ? { id } : { name: item.name, mime: file.type, size: file.size }), offset, data });
          const result = response.result;
          if (typeof result.id !== 'string' || result.offset !== offset + chunk.size) throw new Error('画像のアップロードに失敗しました');
          id = result.id; offset = result.offset;
          if (offset === file.size && !result.complete) throw new Error('画像のアップロードが完了しませんでした');
        }
        item.id = id; item.loading = false;
        if (!item.removed) notice.textContent = `画像を${draft.images.length}枚添付しました`;
      } catch (error) {
        draft.images = draft.images.filter(i => i !== item); URL.revokeObjectURL(item.preview);
        notice.textContent = error.message;
      }
      paint();
    }
  }
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  input.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); addFiles(files); }
  });
  root.addEventListener('dragover', event => {
    if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); event.stopPropagation(); root.classList.add('drag-image'); }
  });
  root.addEventListener('dragleave', () => root.classList.remove('drag-image'));
  root.addEventListener('drop', event => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault(); event.stopPropagation(); root.classList.remove('drag-image'); addFiles([...event.dataTransfer.files]);
  });
  function stopSpeech() { voiceMode.stop(); }
  function startSpeech() { voiceMode.start(voiceEntry); }
  function toggleSpeech() { voiceMode.toggle(voiceEntry); }
  function closeSkills() { picker.hidden = true; search.value = ''; skillButton.setAttribute('aria-expanded', 'false'); token = null; }
  function renderChoices() {
    const query = search.value.toLowerCase().trim();
    const matches = catalog.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(query)).slice(0, 60);
    choices.replaceChildren(...matches.map(s => h('button', { type: 'button', class: 'prompt-skill-choice', title: s.path,
      disabled: draft.skills.some(x => x.path === s.path), onclick: () => {
        if (draft.skills.length >= 20) { notice.textContent = 'スキルは20個までです'; return; }
        draft.skills.push({ name: s.name, path: s.path });
        if (token && input.value.slice(token.start, token.end) === token.text) {
          input.value = input.value.slice(0, token.start) + input.value.slice(token.end);
          input.setSelectionRange(token.start, token.start); draft.text = input.value;
        }
        closeSkills(); paint(); input.focus();
      } }, h('strong', { text: s.name }), h('span', { class: 'muted', text: s.description || s.path }))));
    if (!matches.length) choices.append(h('div', { class: 'muted', text: catalog.length ? '一致するスキルがありません' : 'この送信先に利用できるスキルが見つかりません' }));
  }
  async function toggleSkills(open = picker.hidden, query = '') {
    if (!open) return closeSkills();
    picker.hidden = false; skillButton.setAttribute('aria-expanded', 'true'); search.value = query;
    const ctx = currentContext(); paint();
    const generation = ++requestGeneration;
    if (loadedContext !== ctx.signature) {
      choices.replaceChildren(h('div', { class: 'muted', text: 'スキルを取得中…' }));
      try {
        if (pendingSkills?.signature !== ctx.signature) pendingSkills = { signature: ctx.signature, promise: bridge.callTool('canban_prompt_skills', ctx.value) };
        const pending = pendingSkills;
        let response;
        try { response = await pending.promise; } finally { if (pendingSkills === pending) pendingSkills = null; }
        if (generation !== requestGeneration || JSON.stringify(context()) !== ctx.signature) return;
        catalog = response.result.skills; loadedContext = ctx.signature;
      } catch (error) { if (generation === requestGeneration) choices.replaceChildren(h('div', { role: 'alert', text: error.message })); return; }
    }
    renderChoices();
    if (!token) search.focus();
  }
  root.addEventListener('canban:pick-skill', () => { token = null; toggleSkills(true); });
  search.addEventListener('input', renderChoices);
  picker.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSkills(); input.focus(); } });
  input.addEventListener('input', event => {
    draft.text = input.value;
    if (event.isComposing) return;
    const before = input.value.slice(0, input.selectionStart), match = /(?:^|\s)([$/@][\w.:-]*)$/.exec(before);
    if (match) {
      token = { start: before.length - match[1].length, end: before.length, text: match[1] };
      toggleSkills(true, match[1].slice(1));
    } else if (token) closeSkills();
  });
  input.addEventListener('keydown', event => {
    if (event.altKey && (event.key === 'm' || event.key === 'M' || event.code === 'KeyM')) {
      event.preventDefault();
      event.stopPropagation?.();
      toggleSpeech();
      return;
    }
    if (event.key === 'Escape' && voiceMode.active && voiceMode.current === voiceEntry) {
      event.preventDefault();
      if (voiceMode.silenceTimer) {
        voiceMode.clearSilenceTimer();
        notice.textContent = '自動送信を保留しました（続けて話すか ⌘Enter で送信）';
      } else {
        stopSpeech();
      }
      return;
    }
    if (event.key === 'Escape' && !picker.hidden) { event.preventDefault(); event.stopPropagation(); closeSkills(); return; }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && event.keyCode !== 229) {
      voiceMode.clearSilenceTimer();
      event.preventDefault(); submit?.();
    }
  });
  paint();
  if (voiceMode.active) {
    if (typeof queueMicrotask === 'function') queueMicrotask(() => voiceMode.sync());
    else voiceMode.sync();
  }
  for (const item of draft.images) if (item.id && !item.preview && !item.previewError) restoreImage(item);
  return { root, box, toolbar, draft, toggleSpeech, stopSpeech, isListening: () => voiceMode.active && voiceMode.current === voiceEntry, contextChanged() { currentContext(); closeSkills(); paint(); },
    hasContent: () => !!(input.value.trim() || draft.images.length || draft.skills.length),
    payload() {
      draft.text = input.value;
      currentContext(); paint();
      if (draft.images.some(i => i.loading)) throw new Error('画像の添付が完了するまでお待ちください');
      return { imageIds: draft.images.map(i => i.id), skills: draft.skills.map(s => ({ ...s })) };
    },
    setSending(value) { draft.sending = value; paint(); if (!value && voiceMode.active) voiceMode.sync(voiceEntry); },
    clear() {
      if (draft.sending) voiceMode.onComposerCleared(voiceEntry);
      else if (voiceMode.current === voiceEntry) stopSpeech();
      draft.images.forEach(i => i.preview && URL.revokeObjectURL(i.preview));
      draft.text = draft.baseline = input.value = input.defaultValue = '';
      draft.images = []; draft.skills = []; notice.textContent = '';
      closeSkills(); paint(); fit();
    },
    restore(request) {
      if (this.hasContent()) throw new Error('入力中の指示があります。先に確認してください');
      draft.text = input.value = request.prompt || ''; draft.skills = (request.skills || []).map(s => ({ ...s }));
      // Shared drafts own the object URLs; closing a view does not release them.
      const images = request.images || (request.imageIds || []).map(id => ({ id }));
      if (!Array.isArray(images) || images.length > 8) throw new Error('画像は8枚までです');
      draft.images = images.map(i => ({ id: i.id, name: i.name, mime: i.mime, preview: '', loading: false }));
      paint(); fit(); input.focus();
      return Promise.all(draft.images.map(restoreImage));
    },
  };
}
