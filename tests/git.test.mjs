import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRepo, parsePrUrl, checksState, PrService } from '../server/git.mjs';
import { RuleEngine } from '../server/rules.mjs';
import { Store } from '../server/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canban-git-'));

test('repo and PR URL parsing', async () => {
  for (const u of ['git@github.com:o/r.git', 'https://github.com/o/r', 'https://github.com/o/r.git', 'ssh://git@github.com/o/r.git', 'https://x-access-token:t@github.com/o/r.git'])
    assert.equal(parseRepo(u), 'o/r', u);
  assert.equal(parseRepo('git@gitlab.com:be/sub/proj.git'), 'gitlab:be/sub/proj');
  assert.equal(parseRepo('https://gitlab.com/be/proj'), 'gitlab:be/proj');
  assert.equal(parseRepo('https://bitbucket.org/o/r.git'), null);
  assert.deepEqual(parsePrUrl('https://gitlab.com/be/proj/-/merge_requests/9'), { repo: 'gitlab:be/proj', number: 9 });
  assert.deepEqual(parsePrUrl('https://github.com/o/r/pull/12'), { repo: 'o/r', number: 12 });
});

test('check rollup aggregation', async () => {
  assert.equal(checksState([]), null);
  assert.equal(checksState([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'passing');
  assert.equal(checksState([{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'pending');
  assert.equal(checksState([{ __typename: 'CheckRun', status: 'IN_PROGRESS' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failing');
  assert.equal(checksState([{ __typename: 'StatusContext', state: 'PENDING' }]), 'pending');
});

function service(data, glab = { mrs: {} }) {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'prs.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(d, 'mrs.json'), JSON.stringify(glab));
  process.env.FAKE_GH_DATA = path.join(d, 'prs.json');
  process.env.FAKE_GLAB_DATA = path.join(d, 'mrs.json');
  return { svc: new PrService({ gh: path.join(here, 'fake-gh.sh'), glab: path.join(here, 'fake-glab.sh') }) };
}
const pr = (number, headRefName, state = 'OPEN', extra = {}) => ({ number, headRefName, state, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false, updatedAt: `2026-09-2${number % 10}T00:00:00Z`, statusCheckRollup: [], ...extra });

test('sessions are matched to PRs by branch or pr-link; default branches never match', async () => {
  const { svc } = service({ 'o/r': [pr(1, 'feat/a', 'CLOSED'), pr(2, 'feat/a'), pr(3, 'main'), pr(4, 'fix/b', 'MERGED')] });
  const s = [
    { id: 'a', gitOriginUrl: 'git@github.com:o/r.git', branch: 'feat/a' },
    { id: 'b', gitOriginUrl: 'https://github.com/o/r', branch: 'main' },
    { id: 'c', prUrl: 'https://github.com/o/r/pull/4', branch: 'whatever' },
    { id: 'd', gitOriginUrl: 'git@github.com:o/r.git', branch: 'nope' },
  ];
  const first = await svc.annotate(s.map((x) => ({ ...x })));
  assert.equal(first[0].pr, undefined, 'unknown until the repo is fetched');
  const res = await svc.annotate(s.map((x) => ({ ...x })), { wait: true });
  assert.equal(res[0].pr.number, 2); // open PR preferred over the closed one
  assert.equal(res[1].pr, null);
  assert.equal(res[2].pr.number, 4);
  assert.equal(res[3].pr, null);
});

test('PR rules fire on transitions after a baseline', async () => {
  const store = new Store(tmp());
  await store.setRule({ id: 'm', enabled: true, trigger: 'pr:merged', fromListId: 'any', toListId: 'done' });
  await store.setRule({ id: 'f', enabled: true, trigger: 'ci:failed', fromListId: 'any', toListId: 'review' });
  const engine = new RuleEngine(store);
  const t0 = 1_800_000_000_000;
  const base = { id: 'codex:x', createdAt: t0 - 1e7, updatedAt: t0, status: 'completed' };
  const ev = async (pr, now) => engine.evaluate({ rules: (await store.load()).settings.rules, sessions: [{ ...base, pr }], listOf: () => 'doing', topOrder: () => 0, now });
  assert.deepEqual(await ev(undefined, t0), []); // PR data not loaded yet
  assert.deepEqual(await ev({ state: 'MERGED', checks: 'passing' }, t0 + 1), []); // old merged PR: baseline only
  const store2 = new Store(tmp());
  await store2.setRule({ id: 'f', enabled: true, trigger: 'ci:failed', fromListId: 'any', toListId: 'review' });
  await store2.setRule({ id: 'm', enabled: true, trigger: 'pr:merged', fromListId: 'any', toListId: 'done' });
  const e2 = new RuleEngine(store2);
  const ev2 = async (pr, now) => e2.evaluate({ rules: (await store2.load()).settings.rules, sessions: [{ ...base, pr }], listOf: () => 'doing', topOrder: () => 0, now });
  await ev2({ state: 'OPEN', checks: 'pending' }, t0);
  assert.deepEqual((await ev2({ state: 'OPEN', checks: 'failing' }, t0 + 1)).map((m) => m.toListId), ['review']);
  assert.deepEqual((await ev2({ state: 'MERGED', checks: 'passing' }, t0 + 2)).map((m) => m.toListId), ['done']);
});

test('GitLab merge requests via glab, with pipeline status for open MRs', async () => {
  const mr = (iid, source_branch, state = 'opened') => ({ iid, source_branch, state, title: `MR ${iid}`, web_url: `https://gitlab.com/be/proj/-/merge_requests/${iid}`, draft: false, updated_at: '2026-09-20T00:00:00Z' });
  const { svc } = service({}, { mrs: { 'be/proj': [mr(1, 'feat/x'), mr(2, 'fix/y', 'merged')] }, pipelines: { 'be/proj!1': 'failed' } });
  const [a, b] = await svc.annotate([
    { id: 'a', gitOriginUrl: 'git@gitlab.com:be/proj.git', branch: 'feat/x' },
    { id: 'b', gitOriginUrl: 'git@gitlab.com:be/proj.git', branch: 'fix/y' },
  ], { wait: true });
  assert.equal(a.repo, 'gitlab:be/proj');
  assert.deepEqual([a.pr.provider, a.pr.number, a.pr.state, a.pr.checks], ['gitlab', 1, 'OPEN', 'failing']);
  assert.deepEqual([b.pr.number, b.pr.state, b.pr.checks], [2, 'MERGED', null]);
});
