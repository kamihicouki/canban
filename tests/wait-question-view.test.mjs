import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ui/requests.js', import.meta.url), 'utf8');
const view = vm.runInNewContext(`${source}\nwaitQuestionOf`);
const plain = value => JSON.parse(JSON.stringify(value));

test('an actual outstanding question is readable without adding an answer action', () => {
  const session = { status: 'waiting', signals: { wait: 'question', waitText: '検証方法を選んでください', waitOptions: ['実機', '架空データ'] } };
  assert.deepEqual(plain(view(session)), { text: '検証方法を選んでください', options: ['実機', '架空データ'] });
});

test('answered, unknown and plan waits do not retain a stale question', () => {
  const signals = { wait: 'question', waitText: '古い質問', waitOptions: ['はい'] };
  for (const session of [
    { status: 'running', signals },
    { status: 'waiting', statusKnown: false, signals },
    { status: 'waiting', signals: { ...signals, wait: 'plan' } },
    { status: 'waiting', signals: { wait: 'question', waitText: null } },
  ]) assert.equal(view(session), null);
});

test('unknown question shapes are not stringified or presented as options', () => {
  assert.equal(view({ status: 'waiting', signals: { wait: 'question', waitText: { internal: 'json' } } }), null);
  assert.deepEqual(plain(view({ status: 'waiting', signals: { wait: 'question', waitText: '問い', waitOptions: ['はい', { label: '内部JSON' }, null] } })), { text: '問い', options: ['はい'] });
});
