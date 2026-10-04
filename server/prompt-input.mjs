// Prompt assets are kept in the same data directory as the board and requests.
// Uploads use small chunks so every MCP/Native Messaging request stays bounded.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { codexHome } from './sources/codex.mjs';
import { claudeHome } from './sources/claude.mjs';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 8;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const imageDir = dir => path.join(dir, 'prompt-images');
function imagePath(dir, id, suffix) {
  if (!ID.test(String(id))) throw new Error('画像のIDが不正です');
  return path.join(imageDir(dir), `${id}.${suffix}`);
}
function imageType(b) {
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function uploadImage(dir, { id, offset = 0, data, name, mime, size }) {
  if (typeof data !== 'string' || data.length > 350000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('画像データが不正です');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || !Number.isInteger(offset) || offset < 0) throw new Error('画像データが空か、位置が不正です');
  fs.mkdirSync(imageDir(dir), { recursive: true, mode: 0o700 });
  let meta;
  if (!id) {
    if (offset !== 0 || !TYPES[mime] || !Number.isInteger(size) || size < 1 || size > IMAGE_MAX_BYTES) throw new Error('画像は PNG・JPEG・WebP・GIF、1枚10MBまでです');
    id = crypto.randomUUID();
    meta = { id, name: path.basename(String(name || 'image')).slice(0, 200), mime, size };
    fs.writeFileSync(imagePath(dir, id, 'json'), JSON.stringify(meta), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(imagePath(dir, id, 'part'), '', { mode: 0o600, flag: 'wx' });
  } else meta = JSON.parse(fs.readFileSync(imagePath(dir, id, 'json'), 'utf8'));
  const part = imagePath(dir, id, 'part');
  if (meta.sha256 || fs.statSync(part).size !== offset || offset + bytes.length > meta.size) throw new Error('画像アップロードの位置が一致しません。もう一度追加してください');
  fs.appendFileSync(part, bytes);
  const nextOffset = offset + bytes.length;
  if (nextOffset === meta.size) {
    const content = fs.readFileSync(part);
    if (imageType(content) !== meta.mime) {
      fs.rmSync(part); fs.rmSync(imagePath(dir, id, 'json'));
      throw new Error('画像の形式と内容が一致しません');
    }
    meta.sha256 = crypto.createHash('sha256').update(content).digest('hex');
    fs.renameSync(part, imagePath(dir, id, TYPES[meta.mime]));
    fs.writeFileSync(imagePath(dir, id, 'json'), JSON.stringify(meta), { mode: 0o600 });
  }
  return { ...meta, offset: nextOffset, complete: !!meta.sha256 };
}

export function promptImages(dir, ids = []) {
  if (!Array.isArray(ids) || ids.length > IMAGE_MAX_COUNT) throw new Error('画像は8枚までです');
  return [...new Set(ids)].map(id => {
    const meta = JSON.parse(fs.readFileSync(imagePath(dir, id, 'json'), 'utf8'));
    if (!meta.sha256 || !TYPES[meta.mime]) throw new Error('アップロードが完了していない画像です');
    const file = imagePath(dir, id, TYPES[meta.mime]);
    const data = fs.readFileSync(file);
    if (data.length !== meta.size || crypto.createHash('sha256').update(data).digest('hex') !== meta.sha256) throw new Error('保存された画像が変更されています。もう一度追加してください');
    return { ...meta, path: file };
  });
}

export function skillRoots({ agent = 'codex', cwd = '', homeDir } = {}) {
  if (!['codex', 'claude'].includes(agent)) throw new Error('未対応のAI Appです');
  const home = homeDir || (agent === 'codex' ? codexHome() : claudeHome());
  const roots = [path.join(home, 'skills'), path.join(home, 'plugins', 'cache')];
  if (agent === 'codex') roots.push(path.join(os.homedir(), '.agents', 'skills'));
  if (cwd) {
    if (!path.isAbsolute(cwd)) throw new Error('作業フォルダは絶対パスで指定してください');
    let dir = cwd;
    for (;;) {
      roots.unshift(path.join(dir, agent === 'codex' ? '.agents' : '.claude', 'skills'));
      if (agent === 'codex') roots.unshift(path.join(dir, '.codex', 'skills'));
      const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
    }
  }
  return [...new Set(roots)];
}

export function listSkills(context = {}) {
  const skills = [], seen = new Set();
  const walk = (dir, depth = 0) => {
    let real; try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real) || depth > 8 || skills.length >= 1000) return;
    seen.add(real);
    const file = path.join(dir, 'SKILL.md');
    if (fs.existsSync(file)) {
      let text; try { text = fs.readFileSync(file, 'utf8').slice(0, 16000); } catch { return; }
      const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
      const name = /^name:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(header)?.[1]?.trim() || path.basename(dir);
      if (!/^[\w.:-]+$/.test(name)) return;
      let description = /^description:\s*(.+)$/m.exec(header)?.[1] || '';
      if (/^[>|]-?$/.test(description.trim())) description = /^description:\s*[>|]-?\s*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)+)/m.exec(header)?.[1]?.trim().replace(/\s+/g, ' ') || '';
      skills.push({ name, description: description.replace(/^["']|["']$/g, '').slice(0, 300), path: file });
      return;
    }
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) if (!['node_modules', '.git'].includes(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) walk(path.join(dir, entry.name), depth + 1);
  };
  skillRoots(context).forEach(root => walk(root));
  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export function withSkills(prompt, skills = []) {
  if (!Array.isArray(skills) || skills.length > 20 || skills.some(s => !s || !/^[\w.:-]+$/.test(s.name) || typeof s.path !== 'string' || !path.isAbsolute(s.path) || path.basename(s.path) !== 'SKILL.md' || /[\r\n]/.test(s.path))) throw new Error('スキルの指定が不正です');
  if (!skills.length) return String(prompt || '').trim();
  return `${String(prompt || '').trim()}\n\n使用するスキル（各 SKILL.md を読み、適用してください）:\n${skills.map(s => `$${s.name} — ${JSON.stringify(s.path)}`).join('\n')}`.trim();
}

export function withImagePaths(prompt, images) {
  if (!images.length) return prompt;
  return `${prompt}\n\n添付画像（画像を開いて内容を確認してください）:\n${images.map(i => `${JSON.stringify(i.name)}: ${JSON.stringify(i.path)}`).join('\n')}`.trim();
}

export function claudeImageInput(prompt, images, dir) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [
    ...(prompt ? [{ type: 'text', text: prompt }] : []),
    ...promptImages(dir, images.map(i => i.id)).map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: fs.readFileSync(i.path).toString('base64') } })),
  ] } }) + '\n';
}

export async function remoteImages(dir, images, host, pool) {
  if (!images.length) return [];
  const result = await pool.dispatch(host, { mode: 'prompt_images', images: promptImages(dir, images.map(i => i.id)).map(i => ({ ...i, data: fs.readFileSync(i.path).toString('base64') })) });
  if (!result.ok || !Array.isArray(result.images) || result.images.length !== images.length || result.images.some(i => !path.isAbsolute(i.path || ''))) throw new Error(result.error || '接続先に画像を保存できませんでした');
  return result.images;
}
