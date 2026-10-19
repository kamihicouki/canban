import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor } from '../server/source-capabilities.mjs';

const session = { id: 'codex:t', nativeId: 't', agent: 'codex', cwd: process.cwd(), status: 'idle', statusKnown: true };
const observation = { status: 'known', records: [], mtimeMs: 1, now: 100000, dispatch: { enabled: true, allowModel: true, allowModelElevated: false }, origin: 'ui' };

test('existing local lifecycle availability is exposed per operation without enabling new native operations', () => {
  const caps = capabilitiesFor({ session, observation });
  for (const action of ['archive', 'restore', 'delete', 'open', 'sendPrompt']) assert.equal(caps[action].status, 'available', action);
  for (const action of ['fork', 'interrupt', 'pin']) assert.equal(caps[action].status, 'unsupported', action);
  assert.equal(caps.start.status, 'unknown');
  assert.equal(caps.archive.targetId, 'codex:t');
});

test('active/cloud/remote/Claude lifecycle restrictions retain separate reasons', () => {
  for (const [patch, status] of [[{ status: 'running' }, 'blocked'], [{ status: 'waiting' }, 'blocked'], [{ agent: 'claude' }, 'unsupported'], [{ host: { local: false } }, 'unsupported'], [{ sourceKind: 'codex-cloud' }, 'unsupported']]) {
    const caps = capabilitiesFor({ session: { ...session, ...patch }, observation });
    assert.equal(caps.archive.status, status);
    assert.ok(caps.archive.reason);
  }
});

test('send requires current observations, dispatch policy and elevated acknowledgement', () => {
  assert.equal(capabilitiesFor({ session }).sendPrompt.status, 'unknown');
  assert.equal(capabilitiesFor({ session, observation: { ...observation, status: 'stale' } }).sendPrompt.status, 'unknown');
  assert.equal(capabilitiesFor({ session, observation: { ...observation, dispatch: { enabled: false } } }).sendPrompt.status, 'blocked');
  assert.equal(capabilitiesFor({ session: { ...session, status: 'waiting' }, observation }).sendPrompt.status, 'blocked');
  const elevated = { ...session, sandboxPolicy: '{"type":"danger-full-access"}' };
  assert.equal(capabilitiesFor({ session: elevated, observation }).sendPrompt.status, 'blocked');
  assert.equal(capabilitiesFor({ session: elevated, observation: { ...observation, allowElevated: true } }).sendPrompt.status, 'available');
  assert.equal(capabilitiesFor({ session: elevated, observation: { ...observation, origin: 'model', allowElevated: true } }).sendPrompt.status, 'blocked');
});

test('an account mismatch blocks mutations and a named environment does not prove full start support', () => {
  const caps = capabilitiesFor({ session: { ...session, account: 'codex:a' }, account: { id: 'codex:b' }, observation });
  assert.equal(caps.sendPrompt.status, 'blocked');
  assert.equal(caps.archive.status, 'blocked');
  const environment = capabilitiesFor({ target: { id: 'env', provider: 'claude', kind: 'environment', cwd: '/one' }, observation });
  assert.equal(environment.start.status, 'unknown');
  assert.ok(environment.start.reason);
});

test('a selected account with unobserved ownership cannot advertise mutation availability', () => {
  const caps = capabilitiesFor({ session, account: { id: 'codex:selected' }, observation });
  assert.equal(caps.archive.status, 'unknown');
  assert.equal(caps.sendPrompt.status, 'unknown');
});

test('account mismatch restricts Desktop opening while preserving explicit CLI resume', () => {
  const caps = capabilitiesFor({ session: { ...session, agent: 'claude', desktopSessionId: 'local_sample', account: 'claude:owner' }, account: { id: 'claude:selected' } });
  assert.equal(caps.open.status, 'available');
  assert.equal(caps.open.routes.desktop.status, 'blocked');
  assert.equal(caps.open.routes.terminal.status, 'available');
  assert.match(caps.open.reason, /Desktop/);
});

test('compact capabilities preserve overrides and reconstruct operation defaults without a session lookup', async () => {
  const { compactCapabilities, expandCapabilities } = await import('../server/source-capabilities.mjs');
  const full = capabilitiesFor({ session });
  const wire = compactCapabilities(full);
  assert.equal(wire.compact, true);
  assert.equal(wire.operations.pin, undefined);
  assert.deepEqual(expandCapabilities(JSON.parse(JSON.stringify(wire))), full);
  assert.deepEqual(expandCapabilities(full), full);
  assert.ok(JSON.stringify(wire).length < JSON.stringify(full).length / 2);
});
