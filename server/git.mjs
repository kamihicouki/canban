// Pull request / CI status for sessions, cached per repo: GitHub via `gh`, GitLab
// (gitlab.com) via `glab`. GitHub repos are keyed "owner/repo", GitLab ones
// "gitlab:group/…/project".
// Repos come from Codex's recorded git_origin_url, a Claude `pr-link`, or
// `git config --get remote.origin.url` in the session folder (read-only, local only).
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const TTL_MS = 5 * 60e3;
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'HEAD', 'dev']);

export function parseRepo(url) {
  if (!url || typeof url !== 'string') return null;
  const gh =
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url) ||
    /^(?:ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/.*)?$/.exec(url);
  if (gh) return `${gh[1]}/${gh[2]}`;
  const gl =
    /^git@gitlab\.com:([^\s]+?)(?:\.git)?\/?$/.exec(url) ||
    /^(?:ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)gitlab\.com\/([^\s#?]+?)(?:\.git)?\/?$/.exec(url);
  return gl && gl[1].includes('/') ? `gitlab:${gl[1].split('/-/')[0]}` : null;
}

export const providerOf = (repo) => (repo?.startsWith('gitlab:') ? 'gitlab' : 'github');

export function parsePrUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url || '');
  if (m) return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  const g = /^https:\/\/gitlab\.com\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url || '');
  return g ? { repo: `gitlab:${g[1]}`, number: Number(g[2]) } : null;
}

const GITLAB_PIPELINE = { success: 'passing', failed: 'failing', canceled: 'failing', running: 'pending', pending: 'pending', created: 'pending', preparing: 'pending', waiting_for_resource: 'pending', scheduled: 'pending', manual: 'pending' };
const GITLAB_STATE = { opened: 'OPEN', merged: 'MERGED', closed: 'CLOSED', locked: 'CLOSED' };

// statusCheckRollup → 'passing' | 'failing' | 'pending' | null
export function checksState(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  let pending = false;
  for (const c of rollup) {
    const concl = String(c.conclusion || '').toUpperCase();
    const st = String(c.state || c.status || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl) || ['FAILURE', 'ERROR'].includes(st)) return 'failing';
    if (c.__typename === 'StatusContext' ? ['PENDING', 'EXPECTED'].includes(st) : st && st !== 'COMPLETED') pending = true;
  }
  return pending ? 'pending' : 'passing';
}

// At most a few child processes at a time (repo lookups can cover hundreds of folders).
const MAX_PROCS = 8;
let active = 0;
const waiters = [];
async function withSlot(fn) {
  if (active >= MAX_PROCS) await new Promise((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

function run(file, args, opts) {
  return withSlot(() => runNow(file, args, opts));
}

function runNow(file, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }),
    );
  });
}

export class PrService {
  constructor({ gh = process.env.CANBAN_GH || 'gh', glab = process.env.CANBAN_GLAB || 'glab', git = 'git', ttlMs = TTL_MS } = {}) {
    this.gh = gh;
    this.glab = glab;
    this.git = git;
    this.ttlMs = ttlMs;
    this.repos = new Map(); // repo -> { at, prs, error }
    this.inflight = new Map();
    this.cwdRepo = new Map(); // cwd -> repo | null
    this.status = { available: null, reason: null, checkedAt: 0, github: null, gitlab: null };
    this.pendingCwds = new Set();
    this.cwdJob = null;
    this.availJob = null;
    this.branchChecked = new Map(); // `${repo}#${branch}` -> checkedAt (branch-specific lookups)
  }

  async ensureAvailable() {
    const check = async (bin, name, login) => {
      const r = await run(bin, ['auth', 'status'], { timeout: 10000 });
      return { available: r.ok, reason: r.ok ? null : /ENOENT|not found/i.test(r.stderr) ? `${name} が見つかりません` : `${name} にログインしていません（${login}）` };
    };
    const [github, gitlab] = await Promise.all([check(this.gh, 'gh（GitHub CLI）', 'gh auth login'), check(this.glab, 'glab（GitLab CLI）', 'glab auth login')]);
    const available = github.available || gitlab.available;
    this.status = {
      available,
      reason: available ? null : `${github.reason} / ${gitlab.reason}`,
      checkedAt: Date.now(),
      github,
      gitlab,
    };
    return available;
  }

  providerAvailable(repo) {
    return !!this.status[providerOf(repo)]?.available;
  }

  async repoForCwd(cwd) {
    if (!cwd) return null;
    if (this.cwdRepo.has(cwd)) return this.cwdRepo.get(cwd);
    let repo = null;
    if (fs.existsSync(cwd)) {
      const r = await run(this.git, ['-C', cwd, 'config', '--get', 'remote.origin.url'], { timeout: 5000 });
      repo = r.ok ? parseRepo(r.stdout.trim()) : null;
    }
    this.cwdRepo.set(cwd, repo);
    return repo;
  }

  // Resolve a session's repo from what is already known. Unknown folders are looked
  // up in the background (returns undefined until then).
  repoForSync(session) {
    const fromPr = parsePrUrl(session.prUrl);
    if (fromPr) return fromPr.repo;
    const fromOrigin = parseRepo(session.gitOriginUrl);
    if (fromOrigin) return fromOrigin;
    if ((session.host && session.host.local === false) || !session.cwd) return null;
    if (this.cwdRepo.has(session.cwd)) return this.cwdRepo.get(session.cwd);
    this.pendingCwds.add(session.cwd);
    return undefined;
  }

  lookupPendingCwds() {
    if (this.cwdJob || !this.pendingCwds.size) return this.cwdJob;
    const cwds = [...this.pendingCwds];
    this.pendingCwds.clear();
    this.cwdJob = Promise.all(cwds.map((c) => this.repoForCwd(c))).finally(() => (this.cwdJob = null));
    return this.cwdJob;
  }

  refresh(repo) {
    if (this.inflight.has(repo)) return this.inflight.get(repo);
    const p = (providerOf(repo) === 'gitlab' ? this.fetchGitlab(repo.slice('gitlab:'.length)) : this.fetchGithub(repo))
      .then(({ prs, error }) => this.repos.set(repo, { at: Date.now(), prs, error }))
      .finally(() => this.inflight.delete(repo));
    this.inflight.set(repo, p);
    return p;
  }

  async fetchGithub(repo, branch = null) {
    const r = await run(this.gh, [
      'pr', 'list', '--repo', repo, '--state', 'all', '--limit', branch ? '5' : '200', ...(branch ? ['--head', branch] : []),
      '--json', 'number,title,url,state,isDraft,headRefName,mergedAt,updatedAt,statusCheckRollup',
    ]);
    if (!r.ok) return { prs: [], error: r.stderr.trim().split('\n').pop() || 'gh pr list に失敗しました' };
    try {
      return {
        prs: JSON.parse(r.stdout).map((p) => ({
          provider: 'github', number: p.number, title: p.title, url: p.url, state: p.state, isDraft: !!p.isDraft,
          branch: p.headRefName, mergedAt: p.mergedAt || null, updatedAt: p.updatedAt || null,
          checks: checksState(p.statusCheckRollup),
          checkRuns: (p.statusCheckRollup || []).slice(0, 30).map((c) => ({ name: c.name || c.context || '', state: String(c.conclusion || c.state || c.status || '').toLowerCase(), url: c.detailsUrl || c.targetUrl || null })),
        })),
        error: null,
      };
    } catch {
      return { prs: [], error: 'gh の応答を解析できませんでした' };
    }
  }

  async fetchGitlab(path, branch = null) {
    const r = await run(this.glab, ['mr', 'list', '-R', path, '--all', '--per-page', branch ? '5' : '100', ...(branch ? ['--source-branch', branch] : []), '-F', 'json']);
    if (!r.ok) return { prs: [], error: r.stderr.trim().split('\n').pop() || 'glab mr list に失敗しました' };
    let list;
    try {
      list = JSON.parse(r.stdout);
    } catch {
      return { prs: [], error: 'glab の応答を解析できませんでした' };
    }
    const prs = list.map((m) => ({
      provider: 'gitlab', number: m.iid, title: m.title, url: m.web_url, state: GITLAB_STATE[m.state] || 'CLOSED', isDraft: !!m.draft,
      branch: m.source_branch, mergedAt: m.merged_at || null, updatedAt: m.updated_at || null, checks: null, checkRuns: [],
    }));
    // The list has no pipeline status; look it up for open MRs only.
    await Promise.all(
      prs.filter((p) => p.state === 'OPEN').slice(0, 20).map(async (p) => {
        const d = await run(this.glab, ['api', `projects/${encodeURIComponent(path)}/merge_requests/${p.number}`], { timeout: 15000 });
        if (!d.ok) return;
        try {
          const pl = JSON.parse(d.stdout).head_pipeline;
          if (pl?.status) {
            p.checks = GITLAB_PIPELINE[pl.status] ?? null;
            p.checkRuns = [{ name: `pipeline #${pl.id}`, state: pl.status, url: pl.web_url || null }];
          }
        } catch {}
      }),
    );
    return { prs, error: null };
  }

  // PRs for branches that fell outside the repo-wide list (older ones): ask per branch.
  lookupBranches(sessions, limit = 30) {
    const jobs = [];
    for (const s of sessions) {
      if (jobs.length >= limit) break;
      if (!s.repo || !s.branch || DEFAULT_BRANCHES.has(s.branch) || parsePrUrl(s.prUrl)) continue;
      const cache = this.repos.get(s.repo);
      if (!cache || cache.error || cache.prs.some((p) => p.branch === s.branch)) continue;
      const key = `${s.repo}#${s.branch}`;
      if (Date.now() - (this.branchChecked.get(key) || 0) < this.ttlMs * 6) continue;
      this.branchChecked.set(key, Date.now());
      const fetch = providerOf(s.repo) === 'gitlab' ? this.fetchGitlab(s.repo.slice('gitlab:'.length), s.branch) : this.fetchGithub(s.repo, s.branch);
      jobs.push(fetch.then(({ prs }) => {
        const c = this.repos.get(s.repo);
        if (c) for (const p of prs) if (!c.prs.some((x) => x.number === p.number)) c.prs.push(p);
      }));
    }
    return Promise.all(jobs);
  }

  // Attach `repo` and `pr` to sessions without blocking: cached data is used now and
  // anything missing (gh check, folder lookups, stale repos) refreshes in the background.
  // `wait` awaits all of that first (tests).
  async annotate(sessions, { wait = false } = {}) {
    if (this.status.available === null || Date.now() - this.status.checkedAt > 30 * 60e3) {
      this.availJob ||= this.ensureAvailable().finally(() => (this.availJob = null));
      if (wait) await this.availJob;
    }
    if (!this.status.available) {
      for (const s of sessions) s.pr = undefined;
      return sessions;
    }
    for (const s of sessions) s.repo = this.repoForSync(s);
    if (wait) {
      await this.lookupPendingCwds();
      for (const s of sessions) if (s.repo === undefined) s.repo = this.repoForSync(s);
    } else this.lookupPendingCwds();
    for (const s of sessions) if (s.repo && !this.providerAvailable(s.repo)) s.repo = undefined;
    const refreshes = [];
    for (const repo of new Set(sessions.map((s) => s.repo).filter(Boolean))) {
      const c = this.repos.get(repo);
      if (!c || Date.now() - c.at > this.ttlMs) refreshes.push(this.refresh(repo));
    }
    if (wait) await Promise.all(refreshes);
    const branchJobs = this.lookupBranches(sessions);
    if (wait) await branchJobs;
    // undefined = not known yet (repo not fetched); null = fetched, no PR
    for (const s of sessions) s.pr = s.repo === undefined ? undefined : s.repo ? (this.repos.has(s.repo) ? this.match(s) : undefined) : null;
    return sessions;
  }

  match(s) {
    const prs = this.repos.get(s.repo)?.prs;
    if (!prs?.length) return null;
    const byLink = parsePrUrl(s.prUrl);
    if (byLink) return prs.find((p) => p.number === byLink.number) || null;
    if (!s.branch || DEFAULT_BRANCHES.has(s.branch)) return null;
    const cands = prs.filter((p) => p.branch === s.branch);
    if (!cands.length) return null;
    return cands.sort((a, b) => (a.state === 'OPEN') - (b.state === 'OPEN') || String(a.updatedAt).localeCompare(String(b.updatedAt))).pop();
  }
}
