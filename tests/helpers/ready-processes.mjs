import { spawn } from 'node:child_process';

// Initialize one connection at a time, then release every writer together.
// An exited client must retain its original error instead of stranding siblings.
export async function runReadyProcesses({ inputs, cwd, signal, spawnImpl = spawn }) {
  const children = [], results = [];
  let started = false, failEarly;
  const earlyExit = new Promise((resolve, reject) => { failEarly = reject; });
  try {
    for (const [index, input] of inputs.entries()) {
      let markReady;
      const ready = new Promise(resolve => { markReady = resolve; });
      const child = spawnImpl(process.execPath, ['--no-warnings', '--input-type=module'], {
        cwd, signal, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      let out = '', err = '';
      child.stdout.on('data', value => { out += value; });
      child.stderr.on('data', value => { err += value; });
      child.on('message', message => { if (message === 'ready') markReady(); });
      const result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve({ code, out, err }));
      });
      results.push(result);
      result.then(value => {
        if (!started) failEarly(new Error(`DB client ${index} exited before all clients were ready (${value.code}): ${value.err}`));
      }, error => { if (!started) failEarly(error); });
      child.stdin.end(input);
      await Promise.race([ready, earlyExit]);
    }
    started = true;
    for (const child of children) child.send('start');
    return await Promise.all(results);
  } finally {
    for (const child of children) if (child.exitCode === null && !child.killed) child.kill();
    await Promise.allSettled(results);
  }
}
