// A vendor-shaped CLI fixture: no network, real stdio / PTY / browser helper.
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
const [agent, scenario, evidence] = process.argv.slice(2);
const record = (value) => fs.appendFileSync(evidence, `${JSON.stringify(value)}\n`);
record({ pid: process.pid, tty: !!process.stdin.isTTY, home: process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR });
const hold = setInterval(() => {}, 1000);
if (scenario === 'stubborn') for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});
if (agent === 'codex') {
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line); record({ method: m.method });
    if (m.method === 'initialize') send({ id: m.id, result: {} });
    if (m.method === 'account/login/start') {
      if (scenario === 'api-error') return send({ id: m.id, error: { message: 'secret that must stay private' } });
      if (scenario === 'early') send({ method: 'account/login/completed', params: { loginId: 'ours', success: true } });
      send({ id: m.id, result: { type: 'chatgpt', loginId: 'ours', authUrl: 'https://auth.openai.com/oauth/authorize?state=fixture' } });
      send({ method: 'account/login/completed', params: { loginId: 'someone-else', success: true } });
      if (['success', 'failure'].includes(scenario)) setTimeout(() => send({ method: 'account/login/completed', params: { loginId: 'ours', success: scenario === 'success' } }), 100);
    }
    if (m.method === 'account/login/cancel') { send({ id: m.id, result: { status: 'cancelled' } }); }
  });
} else {
  if (scenario === 'failure') { clearInterval(hold); process.exit(7); }
  const helper = spawn(process.env.BROWSER, ['https://claude.com/cai/oauth/authorize?code=true&state=fixture'], { stdio: 'ignore' });
  helper.on('close', (exit) => {
    record({ helperExit: exit });
    if (exit) process.exit(8);
    if (scenario === 'success') return setTimeout(() => process.exit(0), 100);
    process.stdout.write('\x1b[33mPaste authentication code here:\x1b[0m\n');
    let input = '';
    process.stdin.on('data', (chunk) => {
      input += chunk;
      if (input.includes('\n')) {
        record({ codeAccepted: input.trim() === 'fixture-code' });
        process.exit(input.trim() === 'fixture-code' ? 0 : 9);
      }
    });
  });
}
