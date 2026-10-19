// Prompt input tools: image attachments and the skills a prompt can name.
import { hostsWithState, pool } from '../board.mjs';
import { isCloudSession, CLOUD_OPERATION_REASON } from '../sources/codex-dots.mjs';
import { uploadImage, readPromptImageChunk, listSkills } from '../prompt-input.mjs';
import { resolveSession } from '../dispatch.mjs';
import { copyPromptImages } from '../prompt-clipboard.mjs';
import { readDesktopCapabilities } from '../desktop-capabilities.mjs';
import { appTool } from './shared.mjs';

export function promptTools({ store }) {
  return [
  appTool('canban_upload_prompt_image', 'プロンプトに画像を添付', {
    id: { type: 'string' }, offset: { type: 'integer' }, data: { type: 'string' },
    name: { type: 'string' }, mime: { type: 'string' }, size: { type: 'integer' },
  }, ['data'], a => uploadImage(store.dir, a)),
  appTool('canban_prompt_skills', '利用できるスキルを取得', {
    cardId: { type: 'string' }, agent: { type: 'string', enum: ['codex', 'claude'] },
    hostId: { type: 'string' }, cwd: { type: 'string' },
  }, [], async a => {
    let context = a, host = null;
    if (a.cardId) {
      const resolved = await resolveSession(store, a.cardId);
      context = resolved.session; host = resolved.host;
      if (isCloudSession(context)) return { skills: [], reason: CLOUD_OPERATION_REASON };
    } else if (a.hostId && a.hostId !== 'local') {
      host = (await hostsWithState(await store.load())).find(h => h.id === a.hostId);
      if (!host) throw new Error('Codex に登録されていない接続です');
    }
    if (!host) return { skills: listSkills(context) };
    const result = await pool.dispatch(host, { mode: 'prompt_skills', agent: context.agent || 'codex', cwd: context.cwd || '', homeDir: context.homeDir });
    if (!result.ok) throw new Error(result.error || '接続先のスキルを取得できません');
    return { skills: result.skills || [] };
  }),
  ];
}

export function promptImageTools({ store, requireLoopUi }) {
  return [
  appTool('canban_read_prompt_image', '添付画像のプレビューを読み込む', { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1, maximum: 131072 }, expectedSha256: { type: 'string' }, uiToken: { type: 'string' } }, ['id','uiToken'], a => readPromptImageChunk(store.dir, requireLoopUi(a))),
  appTool('canban_copy_prompt_images', '添付画像をコピー', { imageIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 }, uiToken: { type: 'string' } }, ['imageIds','uiToken'], async a => {
    const args = requireLoopUi(a);
    if (!(await readDesktopCapabilities(store.dir)).clipboardImages) return { state: 'unverified', reason: 'Desktopでの画像受取りを確認するまで、アプリの通常の添付操作を使ってください' };
    return copyPromptImages({ dataDir: store.dir, imageIds: args.imageIds }, { uiAuthorized: true });
  }),
  ];
}
