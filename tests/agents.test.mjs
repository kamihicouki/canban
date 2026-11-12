import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopLink, fileLink, newSessionLink, resumeCommand, shq } from '../server/agents.mjs';
import { openUrl, runInTerminal, setRunner } from '../server/launcher.mjs';
import { LOCAL_HOST } from '../server/sources/util.mjs';

const remote = { id: 'remote-ssh-discovered:box', alias: 'box', label: 'box', local: false };
const codex = { agent: 'codex', nativeId: 't1', cwd: '/w/my app', host: LOCAL_HOST };
const claude = { agent: 'claude', nativeId: 'c1', cwd: '/w/web', host: LOCAL_HOST, desktopSessionId: 'local_abc-123', archived: false };

test('codex desktop links (local and remote host)', () => {
  assert.equal(desktopLink(codex).url, 'codex://threads/t1');
  assert.equal(desktopLink({ ...codex, host: remote }).url, 'codex://threads/t1?hostId=remote-ssh-discovered%3Abox');
});

test('claude desktop links: exact session, folder fallback, none for remote', () => {
  assert.deepEqual(desktopLink(claude), { url: 'claude://code/continue?session=local_abc-123', exact: true, label: 'Claude で開く' });
  const folder = desktopLink({ ...claude, desktopSessionId: null });
  assert.equal(folder.url, 'claude://code/new?folder=%2Fw%2Fweb');
  assert.equal(folder.exact, false);
  assert.equal(desktopLink({ ...claude, archived: true }).exact, false);
  assert.equal(desktopLink({ ...claude, desktopSessionId: 'local_x;rm -rf' }).exact, false);
  assert.equal(desktopLink({ ...claude, host: remote }), null);
});

test('resume commands quote paths and wrap remote sessions in ssh', () => {
  assert.equal(resumeCommand(codex), "cd '/w/my app' 2>/dev/null; codex resume t1");
  assert.equal(resumeCommand(claude), 'cd /w/web 2>/dev/null; claude --resume c1');
  assert.equal(resumeCommand({ ...claude, host: remote }), `ssh -t box 'cd /w/web 2>/dev/null; claude --resume c1'`);
  assert.equal(shq("it's"), `'it'\\''s'`);
});

test('openUrl only allows agent schemes', async () => {
  const calls = [];
  const prev = setRunner(async (f, a) => calls.push([f, ...a]));
  try {
    await openUrl('codex://threads/t1');
    await assert.rejects(openUrl('https://example.com'), /許可されていない/);
    await assert.rejects(openUrl('file:///etc/passwd'), /許可されていない/);
    if (process.platform === 'darwin') assert.deepEqual(calls, [['open', 'codex://threads/t1']]);
  } finally {
    setRunner(prev);
  }
});

test('terminal launch passes the command as argv and falls back for unsupported targets', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const prev = setRunner(async (f, a, input) => calls.push({ f, a, input }));
  try {
    const r1 = await runInTerminal({ terminal: 'ghostty', target: 'split', command: "echo 'x' \"y\"" });
    assert.deepEqual(r1, { terminal: 'ghostty', target: 'split', fellBack: false });
    assert.deepEqual(calls[0].a, ['-', "echo 'x' \"y\"", 'split']);
    assert.match(calls[0].input, /tell application "Ghostty"/);
    const r2 = await runInTerminal({ terminal: 'terminal', target: 'split', command: 'ls' });
    assert.equal(r2.target, 'new-window');
    assert.equal(r2.fellBack, true);
    await assert.rejects(runInTerminal({ terminal: 'xterm', target: 'new-tab', command: 'ls' }), /未対応/);
  } finally {
    setRunner(prev);
  }
});

test('editor file links percent-encode each folder segment', () => {
  assert.equal(fileLink('cursor', '/w/web'), 'cursor://file/w/web');
  assert.equal(fileLink('cursor', 'w/web'), 'cursor://file/w/web');
  const odd = '/w/a#b/c?d/100%/my app';
  const url = fileLink('cursor', odd);
  assert.equal(url, 'cursor://file/w/a%23b/c%3Fd/100%25/my%20app');
  assert.equal(decodeURIComponent(new URL(url).pathname), odd);
  assert.equal(new URL(url).hash, '');
  assert.equal(new URL(url).search, '');
  const local = { host: LOCAL_HOST, cwd: odd };
  assert.equal(desktopLink({ ...local, agent: 'cursor' }).url, url);
  assert.equal(desktopLink({ ...local, agent: 'antigravity' }).url, 'antigravity://file/w/a%23b/c%3Fd/100%25/my%20app');
  assert.equal(newSessionLink('cursor', { host: LOCAL_HOST, cwd: odd }).url, url);
  assert.equal(newSessionLink('antigravity', { host: LOCAL_HOST, cwd: odd }).url, 'antigravity://file/w/a%23b/c%3Fd/100%25/my%20app');
});
