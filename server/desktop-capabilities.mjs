// A local, owner-only acceptance receipt. No tool can write it. App updates
// invalidate the receipt so a fixture result never becomes a live capability.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readDesktopJson } from './claude-desktop-roots.mjs';
export async function desktopBuilds() {
  const signature = async app => {
    try { const st = await fs.stat(`/Applications/${app}.app/Contents/Resources/app.asar`, { bigint: true }); return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`; }
    catch { return null; }
  };
  return { claude: await signature('Claude'), codex: await signature('ChatGPT') };
}
export async function readDesktopCapabilities(dataDir, { builds, platform = process.platform } = {}) {
  builds ||= await desktopBuilds();
  const receipt = await readDesktopJson(path.join(dataDir, 'desktop-capabilities.json')).catch(() => null);
  const same = app => receipt?.version === 1 && builds[app] && receipt.builds?.[app] === builds[app];
  const a = receipt?.accountSwitch;
  const accountSwitch = platform === 'darwin' && !!same('claude') && a?.verified === true && a.roundTrips >= 3 && a.relogins === 0 && a.logouts === 0 && a.cliPreserved === true && a.desktopPreserved === true && a.draftsPreserved === true;
  const codexRemote = !!same('codex') && receipt?.codexRemote?.verified === true && receipt.codexRemote.modelTurns === 0 && receipt.codexRemote.draftVerified === true;
  const clipboardImages = platform === 'darwin' && !!same('claude') && !!same('codex') && receipt?.clipboardImages?.verified === true && receipt.clipboardImages.claude === true && receipt.clipboardImages.codex === true;
  return { accountSwitch, codexRemote, clipboardImages, reason: accountSwitch ? null : 'Desktop の認証保持を実機で確認してから切替を利用できます' };
}
