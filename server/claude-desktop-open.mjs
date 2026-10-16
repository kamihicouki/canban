// The only way Canban opens Claude Desktop (any claude:// link: a new session, a
// continue, a resume). launcher.openUrl refuses claude:// so that no other path can
// skip this, and tests/claude-desktop-open.test.mjs checks that nothing else opens it.
//
// Integrated sidebar (claude-desktop-guests.mjs): when Desktop is stopped, every other
// account's sessions are placed as guests before Desktop starts, and a watcher writes
// them back after the user's ⌘Q. A running Desktop is never touched; the link opens as is.
import { openAppUrl } from './launcher.mjs';
import { desktopRunning, planGuests, placeGuests, restoreGuests, spawnGuestWatcher, guestPaths } from './claude-desktop-guests.mjs';

const NOT_GUEST = '作業途中で終了された会話';

// url: the claude:// link. guestSessionId: the Desktop session of another account this
// link opens; it must be placeable, or nothing is opened (the link would not find it).
// Returns { ok, placed, code?, reason? }; ok=false with an opened Desktop is not an error.
export async function openClaudeDesktop({ url, guestSessionId = null, labelOf = a => a.slice(0, 8), paths = guestPaths(), watch = spawnGuestWatcher, open = openAppUrl }) {
  if (!/^claude:/i.test(url)) throw new Error('Claude Desktop のリンクではありません');
  if (await desktopRunning()) {
    if (guestSessionId) return { ok: false, opened: false, code: 'desktop_running', reason: 'Desktop を終了してから開くと、全アカウントの会話をまとめた Desktop で開けます。' };
    await open(url);
    return { ok: false, opened: true, code: 'desktop_running', placed: 0 };
  }
  if (guestSessionId) {
    const plan = await planGuests({ paths, labelOf });
    if (!plan.ok) return { ok: false, opened: false, code: 'desktop_unavailable', reason: plan.reason };
    if (!plan.guests.some(g => g.sessionId === guestSessionId)) {
      const skip = plan.skipped.find(s => s.sessionId === guestSessionId);
      return { ok: false, opened: false, code: 'not_guest', reason: skip?.reason === NOT_GUEST
        ? 'この会話は作業の途中で終了されています。ほかのアカウントで続きが走らないよう、元のアカウント（ターミナル）で再開してください。'
        : `この会話は Desktop にまとめて表示できません（${skip?.reason || '対象外'}）。` };
    }
  }
  let placed;
  try { placed = await placeGuests({ paths, labelOf }); }
  catch (error) {
    if (guestSessionId) return { ok: false, opened: false, code: error.code || 'desktop_unavailable', reason: error.message };
    await open(url);
    return { ok: false, opened: true, code: error.code || 'desktop_unavailable', reason: error.message, placed: 0 };
  }
  if (placed.placed) watch();
  try { await open(url); }
  catch (error) { if (placed.placed) await restoreGuests({ paths }); throw error; }
  return { ok: true, opened: true, placed: placed.placed, host: placed.host };
}

// Every desktop link Canban opens (Codex or Claude) goes through here.
export async function openDesktopApp(url, options = {}) {
  if (/^claude:/i.test(String(url))) return openClaudeDesktop({ ...options, url });
  await (options.open || openAppUrl)(url);
  return { ok: false, opened: true, placed: 0 };
}

// The line shown after an open, so the user can tell whether accounts were merged.
export function integratedNote(result) {
  if (result?.placed) return `全アカウントの会話をまとめて Desktop で開きました（ほかのアカウントの会話 ${result.placed} 件に 🔗 を付けています）。Desktop を ⌘Q で終了すると、それぞれのアカウントへ戻します。`;
  if (result?.opened && result.reason) return `全アカウントの会話はまとめていません（${result.reason}）。`;
  return null;
}
