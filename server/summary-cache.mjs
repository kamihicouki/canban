// Keeps the Claude transcript summaries (sources/claude.mjs) in Canban's data directory, so a server that
// starts — Codex, Claude Desktop and Chrome each start one — reads only what the transcripts gained since.
// Summaries only (title, first prompts, counts, the byte offset read so far); no conversation is copied.
import fs from 'node:fs';
import path from 'node:path';
import { importSummaries, onSummaries } from './sources/claude.mjs';

const VERSION = 1;
export function attachSummaryCache(dataDir) {
  const file = path.join(dataDir, 'cache', 'claude-summaries.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.version === VERSION) importSummaries(saved.entries);
  } catch {}
  // Written after a listing that read something new, atomically; servers that race only re-read a few files.
  return onSummaries((entries) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, entries }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {}
  });
}
