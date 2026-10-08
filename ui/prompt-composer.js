// Shared composer for task launches and session follow-ups. Drafts survive live
// re-rendering; binary files never go into board settings or localStorage.
const promptDrafts = new Map();
function promptComposer(input, { key, context, submit, chips = false }) {
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
  // chips: icon buttons that share one row with the permission and send controls (the caller adds them).
  const imageButton = chips
    ? h('button', { type: 'button', class: 'cx-ico', title: '画像を添付（貼り付け・ドロップも可）', 'aria-label': '画像を添付', html: picon('image', 16), onclick: () => fileInput.click() })
    : h('button', { type: 'button', class: 'btn', text: '＋ 画像', onclick: () => fileInput.click() });
  const skillButton = chips
    ? h('button', { type: 'button', class: 'cx-ico', title: 'スキルを選ぶ（$）', 'aria-label': 'スキルを選ぶ', 'aria-expanded': 'false', 'aria-controls': picker.id, text: '$', onclick: () => toggleSkills() })
    : h('button', { type: 'button', class: 'btn', text: '＄ スキル', 'aria-expanded': 'false', 'aria-controls': picker.id, onclick: () => toggleSkills() });
  const toolbar = chips ? h('div', { class: 'prompt-toolbar chips' }, imageButton, skillButton)
    : h('div', { class: 'prompt-toolbar' }, imageButton, skillButton, h('span', { class: 'muted prompt-hint', text: '画像を貼り付け・ドロップ / $ でスキル' }));
  picker.append(h('div', { class: 'row' }, search, h('button', { type: 'button', class: 'icon-btn', text: '✕', 'aria-label': 'スキル選択を閉じる', onclick: () => closeSkills() })), choices);
  root.append(assets, input, toolbar, picker, notice, fileInput);
  let catalog = [], loadedContext = null, pendingSkills = null, requestGeneration = 0, token = null;
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
      h('span', { class: 'ellipsis', text: i.loading ? '添付中…' : i.name, title: i.name }),
      h('button', { type: 'button', class: 'icon-btn', text: '✕', disabled: draft.sending, 'aria-label': `${i.name} を削除`, onclick: () => {
        draft.images = draft.images.filter(x => x !== i); i.removed = true; URL.revokeObjectURL(i.preview); paint();
      } }))),
      ...draft.skills.map(s => h('div', { class: 'prompt-skill-chip', title: s.path },
        h('span', { text: `$${s.name}` }), h('button', { type: 'button', class: 'icon-btn', text: '✕', disabled: draft.sending,
          'aria-label': `${s.name} を削除`, onclick: () => { draft.skills = draft.skills.filter(x => x.path !== s.path); paint(); } }))));
    imageButton.disabled = skillButton.disabled = input.readOnly = draft.sending;
    root.setAttribute('aria-busy', String(draft.sending || draft.images.some(i => i.loading)));
  }
  paintView.root = root;
  draft.views ||= new Set(); draft.views.add(paintView);
  function paint() {
    for (const view of draft.views) {
      if (view === paintView || view.root.isConnected) view(); else draft.views.delete(view);
    }
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
    if (event.key === 'Escape' && !picker.hidden) { event.preventDefault(); event.stopPropagation(); closeSkills(); return; }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); submit?.(); }
  });
  paint();
  return { root, toolbar, draft, contextChanged() { currentContext(); closeSkills(); paint(); },
    hasContent: () => !!(input.value.trim() || draft.images.length || draft.skills.length),
    payload() {
      draft.text = input.value;
      currentContext(); paint();
      if (draft.images.some(i => i.loading)) throw new Error('画像の添付が完了するまでお待ちください');
      return { imageIds: draft.images.map(i => i.id), skills: draft.skills.map(s => ({ ...s })) };
    },
    setSending(value) { draft.sending = value; paint(); },
    clear() { draft.images.forEach(i => i.preview && URL.revokeObjectURL(i.preview)); draft.text = draft.baseline = input.value = input.defaultValue = ''; draft.images = []; draft.skills = []; notice.textContent = ''; closeSkills(); paint(); },
    restore(request) {
      if (this.hasContent()) throw new Error('入力中の指示があります。先に確認してください');
      draft.text = input.value = request.prompt || ''; draft.skills = (request.skills || []).map(s => ({ ...s }));
      // History keeps server asset IDs; previews are fetched only on demand.
      draft.images = (request.images || []).map(i => ({ id: i.id, name: i.name, mime: i.mime, preview: '', loading: false }));
      paint(); input.focus();
    },
  };
}
