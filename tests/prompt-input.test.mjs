import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { uploadImage, promptImages, listSkills, withSkills, withImagePaths, claudeImageInput } from '../server/prompt-input.mjs';
import { headlessArgs, newSessionCommand } from '../server/agents.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9l0AAAAASUVORK5CYII=', 'base64');
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canban-prompt-'));

test('image upload chunks survive a restart; only completed, unchanged images are usable', () => {
  const dir = fixture();
  try {
    const first = uploadImage(dir, { name: '../写真.png', mime: 'image/png', size: png.length, data: png.subarray(0, 20).toString('base64') });
    assert.equal(first.complete, false); assert.equal(first.name, '写真.png');
    assert.throws(() => promptImages(dir, [first.id]), /完了/);
    assert.throws(() => uploadImage(dir, { id: first.id, offset: 0, data: png.subarray(20).toString('base64') }), /位置/);
    const done = uploadImage(dir, { id: first.id, offset: 20, data: png.subarray(20).toString('base64') });
    assert.equal(done.complete, true);
    const [image] = promptImages(dir, [done.id, done.id]);
    assert.deepEqual(fs.readFileSync(image.path), png);
    assert.equal(fs.statSync(image.path).mode & 0o777, 0o600);
    assert.throws(() => promptImages(dir, ['../../private']), /ID/);
    assert.throws(() => promptImages(dir, Array(9).fill(done.id)), /8枚/);
    fs.writeFileSync(image.path, 'changed');
    assert.throws(() => promptImages(dir, [done.id]), /変更/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('image type, size and malformed base64 are checked by the server', () => {
  const dir = fixture();
  try {
    assert.throws(() => uploadImage(dir, { data: png.toString('base64'), mime: 'image/svg+xml', size: png.length }), /PNG/);
    assert.throws(() => uploadImage(dir, { data: png.toString('base64'), mime: 'image/png', size: 11 * 1024 * 1024 }), /10MB/);
    assert.throws(() => uploadImage(dir, { data: 'not base64', mime: 'image/png', size: 10 }), /データ/);
    assert.throws(() => uploadImage(dir, { data: png.toString('base64'), mime: 'image/jpeg', size: png.length }), /内容/);
    assert.throws(() => uploadImage(dir, { data: Buffer.alloc(300000).toString('base64'), mime: 'image/png', size: 300000 }), /データ/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('project, user and plugin skill metadata include exact paths and folded descriptions', () => {
  const dir = fixture();
  try {
    const home = path.join(dir, 'home'), cwd = path.join(dir, 'repo', 'child');
    const paths = [path.join(home, 'skills', 'personal'), path.join(dir, 'repo', '.agents', 'skills', 'project'), path.join(home, 'plugins', 'cache', 'vendor', 'plugin', '1', 'skills', 'plugin')];
    paths.forEach((p, i) => { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'SKILL.md'), `---\nname: skill${i}\ndescription: >\n  First line\n  second line\n---\n# Skill\n`); });
    fs.mkdirSync(cwd, { recursive: true });
    fs.symlinkSync(path.join(home, 'skills'), path.join(home, 'skills', 'loop'));
    const skills = listSkills({ agent: 'codex', cwd, homeDir: home }).filter(s => s.path.startsWith(dir));
    assert.equal(skills.length, 3);
    assert.ok(skills.every(s => s.description === 'First line second line'));
    assert.ok(skills.some(s => s.path.includes('.agents')));
    assert.throws(() => withSkills('text', [{ name: 'bad\nname', path: '/x/SKILL.md' }]), /不正/);
    assert.throws(() => withSkills('text', [{ name: 'skill', path: 'relative/SKILL.md' }]), /不正/);
    assert.match(withSkills('依頼文', [skills[0]]), /依頼文\n\n使用するスキル/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('images use real Codex image arguments and Claude structured multimodal stdin', () => {
  const dir = fixture();
  try {
    const image = uploadImage(dir, { name: 'photo.png', mime: 'image/png', size: png.length, data: png.toString('base64') });
    const images = promptImages(dir, [image.id]);
    const c = headlessArgs({ agent: 'codex', nativeId: 'thread' }, { sandbox: 'read-only' }, { images });
    assert.deepEqual(c.args.slice(0, 4), ['exec', 'resume', '--image', images[0].path]);
    assert.ok(c.args.includes('sandbox_mode="read-only"'));
    assert.ok(c.args.includes('approval_policy="never"'));
    const cl = headlessArgs({ agent: 'claude', nativeId: 'thread' }, { mode: 'default' }, { images });
    assert.equal(cl.args[cl.args.indexOf('--input-format') + 1], 'stream-json');
    assert.equal(cl.args[cl.args.indexOf('--output-format') + 1], 'stream-json');
    const message = JSON.parse(claudeImageInput('画像を確認', images, dir));
    assert.deepEqual(message.message.content[0], { type: 'text', text: '画像を確認' });
    assert.equal(message.message.content[1].source.data, png.toString('base64'));
    assert.equal(JSON.parse(claudeImageInput('', images, dir)).message.content[0].type, 'image');
    assert.match(withImagePaths('依頼', images), /画像を開いて/);
    const command = newSessionCommand('codex', { cwd: '/a folder', images: [{ path: "/image's file.png" }], prompt: '画像を確認' });
    assert.match(command, /--image '.*'\\''s file.png'/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('remote image storage and skill discovery return paths on the target host', () => {
  const dir = fixture();
  try {
    const module = fs.readFileSync(new URL('../server/remote/dispatch.py', import.meta.url), 'utf8');
    const script = module.slice(0, module.indexOf('\ntry:\n    main()'));
    const image = uploadImage(dir, { name: 'photo.png', mime: 'image/png', size: png.length, data: png.toString('base64') });
    const run = (payload, code) => spawnSync('python3', ['-c', `ARGS = ${JSON.stringify(JSON.stringify(payload))}\n${script}\nHOME = ${JSON.stringify(dir)}\nARGS = json.loads(ARGS)\n${code}`], { encoding: 'utf8' });
    const result = run({ images: [{ ...image, data: png.toString('base64') }] }, 'print(json.dumps(prompt_images(ARGS)))');
    assert.equal(result.status, 0, result.stderr);
    const remote = JSON.parse(result.stdout).images[0];
    assert.ok(remote.path.startsWith(dir)); assert.deepEqual(fs.readFileSync(remote.path), png);
    const folder = path.join(dir, '.codex', 'skills', 'demo'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: demo\ndescription: test skill\n---\n');
    const skills = run({ agent: 'codex', homeDir: path.join(dir, '.codex') }, 'print(json.dumps(prompt_skills(ARGS)))');
    assert.equal(skills.status, 0, skills.stderr);
    assert.equal(JSON.parse(skills.stdout).skills[0].name, 'demo');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function composerHarness() {
  class Element {
    constructor(tag, attrs = {}, children = []) { this.tag = tag; this.children = children.filter(Boolean); this.events = {}; this.dataset = {}; this.value = attrs.value || ''; this.isConnected = true; Object.assign(this, attrs); this.classList = { add() {}, remove() {} }; }
    append(...items) { this.children.push(...items.filter(Boolean)); }
    replaceChildren(...items) { this.children = items.filter(Boolean); }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    setAttribute(key, value) { this[key] = value; }
    focus() { this.focused = true; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    async fire(name, event = {}) { for (const fn of this.events[name] || []) await fn(event); }
  }
  let calls = [], sends = 0;
  const bridge = { async callTool(name, args) { calls.push({ name, args }); return { result: name === 'canban_prompt_skills' ? { skills: [{ name: 'demo', path: '/skills/demo/SKILL.md', description: 'demo skill' }] } : { id: 'image-id', offset: args.offset + Buffer.from(args.data, 'base64').length, complete: true } }; } };
  class Reader { readAsDataURL(blob) { blob.arrayBuffer().then(b => { this.result = `data:image/png;base64,${Buffer.from(b).toString('base64')}`; this.onload(); }); } }
  const context = vm.createContext({ h: (tag, attrs, ...children) => new Element(tag, attrs, children), bridge, URL: { createObjectURL: () => 'blob:preview', revokeObjectURL() {} }, FileReader: Reader });
  vm.runInContext(fs.readFileSync(new URL('../ui/prompt-composer.js', import.meta.url), 'utf8') + '\nglobalThis.create = promptComposer;', context);
  const input = new Element('textarea'); const target = { agent: 'codex', cwd: '/repo' };
  const composer = context.create(input, { key: 'test', context: () => target, submit: () => { sends++; } });
  const nodes = (root = composer.root) => [root, ...root.children.filter(c => c instanceof Element).flatMap(c => nodes(c))];
  return { context, composer, input, target, nodes, calls, get sends() { return sends; }, Element };
}

test('composer protects IME input, selects skills, restores drafts and clears skills on a target change', async () => {
  const h = composerHarness();
  const event = { key: 'Enter', ctrlKey: true, preventDefault() {} };
  await h.input.fire('keydown', { ...event, isComposing: true });
  await h.input.fire('keydown', { ...event, keyCode: 229 });
  assert.equal(h.sends, 0);
  await h.input.fire('keydown', event); assert.equal(h.sends, 1);
  h.input.value = '依頼 $de'; h.input.selectionStart = h.input.value.length;
  await h.input.fire('input', {}); await new Promise(resolve => setImmediate(resolve));
  const choice = h.nodes().find(e => e.class === 'prompt-skill-choice'); assert.ok(choice);
  choice.onclick(); assert.equal(h.input.value, '依頼 ');
  assert.equal(h.composer.payload().skills[0].name, 'demo');
  const replacement = new h.Element('textarea');
  const next = h.context.create(replacement, { key: 'test', context: () => h.target });
  assert.equal(replacement.value, '依頼 '); assert.equal(next.payload().skills.length, 1);
  h.target.cwd = '/other'; next.contextChanged(); assert.equal(next.payload().skills.length, 0);
  next.clear(); assert.equal(next.hasContent(), false);
});

test('composer uploads pasted images, preserves assets across renders and locks during sending', async () => {
  const h = composerHarness(); let prevented = false;
  const file = new File([png], 'photo.png', { type: 'image/png' });
  await h.input.fire('paste', { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.throws(() => h.composer.payload(), /完了/);
  const replacement = new h.Element('textarea');
  const next = h.context.create(replacement, { key: 'test', context: () => h.target });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(next.payload().imageIds)), ['image-id']);
  assert.equal(next.root.dataset.unsavedForm, 'true');
  next.setSending(true); assert.equal(replacement.readOnly, true);
  next.setSending(false); assert.equal(replacement.readOnly, false);
  next.clear(); assert.equal(next.hasContent(), false); assert.equal(next.root.dataset.unsavedForm, 'false');
});

test('large pasted images are uploaded in bounded chunks and removed without leaving a draft', async () => {
  const h = composerHarness();
  const file = new File([png, Buffer.alloc(600000)], 'large.png', { type: 'image/png' });
  await h.input.fire('paste', { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }, preventDefault() {} });
  for (let i = 0; i < 10 && h.composer.draft.images[0]?.loading; i++) await new Promise(resolve => setImmediate(resolve));
  const uploads = h.calls.filter(c => c.name === 'canban_upload_prompt_image');
  assert.equal(uploads.length, 3);
  assert.ok(uploads.every(c => c.args.data.length < 350000));
  assert.equal(uploads[1].args.offset, 256 * 1024); assert.equal(uploads[1].args.id, 'image-id');
  assert.equal(h.composer.payload().imageIds[0], 'image-id');
  h.nodes().find(e => e['aria-label'] === 'large.png を削除').onclick();
  assert.equal(h.composer.hasContent(), false);
  assert.equal(h.composer.root.dataset.unsavedForm, 'false');
});
