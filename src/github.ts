// GitHub, read as it is: what a webhook delivery says about an issue or pull request, in the board's terms.
// Nothing here writes to GitHub (T-17 contract, stage 1). Comment bodies are never carried over: GitHub is
// where people talk, and the board only says that someone did and where.

import { createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Whether a delivery was signed with the webhook secret (X-Hub-Signature-256: sha256=<hex HMAC of the raw body>). */
export function signed(secret: string, body: string, header: string | null): boolean {
  if (secret === '' || header === null || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const want = createHmac('sha256', secret).update(body, 'utf8').digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

export interface Repo {
  /** GitHub's own id: the name of a repository can change, this cannot. */
  id: string;
  name: string;
  private: boolean;
}

export interface Item {
  /** GitHub's node id of the issue or pull request: what the board knows it by. */
  node: string;
  kind: 'issue' | 'pr';
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  /** When GitHub last changed it: an older delivery never undoes a newer one. */
  updated: string;
  /** A pull request's head commit, when the delivery says it (T-446). */
  head?: string;
  /** The issues of the same repository a pull request says it closes ("Fixes #12"), when its description is given. */
  closes?: number[];
}

/** A check run on a commit (T-446): only its outcome, never its log. */
export interface Check {
  sha: string;
  name: string;
  /** queued, in_progress or completed. */
  status: string;
  /** For a completed run: success, failure, neutral, cancelled, skipped, timed_out or action_required. */
  conclusion: string;
  /** The pull requests GitHub says it ran for, by number. */
  prs: number[];
  at: string;
}

/** A reviewer's verdict on a pull request (T-446); a later one by the same reviewer replaces it. */
export interface Review {
  number: number;
  login: string;
  /** approved, changes_requested, commented or dismissed. */
  state: string;
  at: string;
}

/** The issue numbers a pull request's description says it closes, by GitHub's own closing keywords. */
export function closesIn(body: string): number[] {
  const out = new Set<number>();
  for (const m of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d{1,9})\b/gi)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/** Something a person did on GitHub that whoever holds the task should know of, without its text. */
export interface Ping {
  /** The issue or pull request it is on, by number: a pull request's comments arrive on its issue, whose node id is not the pull request's. */
  number: number;
  login: string;
  what: string;
  url: string;
}

export interface Delivery {
  repo: Repo | null;
  item: Item | null;
  ping: Ping | null;
  check?: Check | null;
  review?: Review | null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function item(o: Record<string, unknown> | undefined, kind: 'issue' | 'pr'): Item | null {
  if (o === undefined || typeof o !== 'object' || o === null) return null;
  const node = text(o.node_id);
  const number = Number(o.number);
  if (node === '' || !Number.isSafeInteger(number)) return null;
  const merged = kind === 'pr' && (o.merged === true || text(o.merged_at) !== '');
  return {
    node,
    kind,
    number,
    url: text(o.html_url),
    title: text(o.title),
    state: o.state === 'open' ? 'open' : merged ? 'merged' : 'closed',
    author: text((o.user as Record<string, unknown> | undefined)?.login),
    updated: text(o.updated_at) || new Date(0).toISOString(),
    // The issues API describes a pull request without its head; only a pull request's own description has one.
    ...(kind === 'pr' && typeof (o.head as Record<string, unknown> | undefined)?.sha === 'string' ? { head: text((o.head as Record<string, unknown>).sha) } : {}),
    ...(kind === 'pr' && typeof o.body === 'string' ? { closes: closesIn(o.body) } : {}),
  };
}

/** What a delivery is about, from its event name and payload; anything it does not know is left null. */
export function read(event: string, payload: Record<string, unknown>): Delivery {
  const r = payload.repository as Record<string, unknown> | undefined;
  const repo: Repo | null = r && r.id !== undefined ? { id: String(r.id), name: text(r.full_name), private: r.private === true } : null;
  const sender = text((payload.sender as Record<string, unknown> | undefined)?.login);
  const issue = payload.issue as Record<string, unknown> | undefined;
  const pull = payload.pull_request as Record<string, unknown> | undefined;
  switch (event) {
    case 'issues':
      // The issues API also describes pull requests; their own events say more, so these are left to them.
      return { repo, item: issue?.pull_request ? null : item(issue, 'issue'), ping: null };
    case 'pull_request':
      return { repo, item: item(pull, 'pr'), ping: null };
    case 'issue_comment': {
      if (payload.action !== 'created') return { repo, item: null, ping: null };
      const kind = issue?.pull_request ? 'pr' : 'issue';
      const comment = payload.comment as Record<string, unknown> | undefined;
      return { repo, item: null, ping: issue ? { number: Number(issue.number), login: sender, what: `commented on ${kind === 'pr' ? 'pull request' : 'issue'} #${issue.number}`, url: text(comment?.html_url) || text(issue.html_url) } : null };
    }
    case 'pull_request_review': {
      if (payload.action !== 'submitted' && payload.action !== 'synced') return { repo, item: null, ping: null };
      const review = payload.review as Record<string, unknown> | undefined;
      const state = text(review?.state).toLowerCase().replace(/_/g, ' ');
      const verdict: Review | null = pull && review ? { number: Number(pull.number), login: text((review.user as Record<string, unknown> | undefined)?.login) || sender, state: text(review.state).toLowerCase(), at: text(review.submitted_at) || new Date(0).toISOString() } : null;
      // A review read in a reconciliation is a fact, not news: nobody is woken by it.
      const news = payload.action === 'submitted';
      return { repo, item: null, review: verdict, ping: news && pull ? { number: Number(pull.number), login: sender, what: `reviewed pull request #${pull.number}${state ? ` (${state})` : ''}`, url: text(review?.html_url) || text(pull.html_url) } : null };
    }
    case 'check_run': {
      const run = payload.check_run as Record<string, unknown> | undefined;
      const sha = text(run?.head_sha);
      if (run === undefined || !/^[0-9a-f]{40}$/.test(sha)) return { repo, item: null, ping: null, check: null };
      const prs = Array.isArray(run.pull_requests) ? (run.pull_requests as Record<string, unknown>[]).map((p) => Number(p.number)).filter(Number.isSafeInteger) : [];
      return { repo, item: null, ping: null, check: { sha, name: text(run.name) || 'check', status: text(run.status) || 'queued', conclusion: text(run.conclusion), prs, at: text(run.completed_at) || text(run.started_at) || new Date(0).toISOString() } };
    }
    default:
      return { repo, item: null, ping: null };
  }
}

// ---- the GitHub App (T-19): who the board is on GitHub, and reading through it ----


type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What is kept of the App beside the board: its identity in app.json, its two secrets in files only the server reads. */
export interface AppInfo {
  id: string;
  slug: string;
  owner: string;
  html_url: string;
}

const API = 'https://api.github.com';
const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

/** A JSON Web Token signed with the App's private key: what the App shows GitHub to ask for an installation token. */
export function appJwt(appId: string, pem: string, nowSec: number): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // Backdated a minute against clock drift; GitHub allows at most ten minutes.
  const body = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const sign = createSign('RSA-SHA256');
  sign.update(`${head}.${body}`);
  return `${head}.${body}.${sign.sign(pem).toString('base64url')}`;
}

/** The manifest an administrator sends GitHub to create the App: only what the T-17 contract allows. */
export function manifest(base: string): Record<string, unknown> {
  return {
    name: `rayboard-${randomBytes(3).toString('hex')}`,
    url: base,
    hook_attributes: { url: `${base}/api/github`, active: true },
    redirect_url: `${base}/api/github/manifest`,
    setup_url: `${base}/#settings`,
    public: false,
    default_permissions: { metadata: 'read', issues: 'write', pull_requests: 'read', checks: 'read' },
    default_events: ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'check_run'],
  };
}

/** What the App was granted, as GitHub says it is: compared with what the board needs, never assumed. */
export interface Grant {
  installation: string;
  permissions: Record<string, string>;
  repos: { id: string; name: string; private: boolean }[];
}

const NEEDED: Record<string, string[]> = { metadata: ['read', 'write'], issues: ['write'], pull_requests: ['read', 'write'], checks: ['read', 'write'] };

/**
 * What is missing from a grant, in words an administrator can act on; empty when nothing is.
 * Which repositories the board follows is chosen in one place, the App's installation on GitHub, so the
 * only thing to say about repositories is that there are none.
 */
export function missing(grant: Grant): string[] {
  const out: string[] = [];
  for (const [name, ok] of Object.entries(NEEDED)) {
    if (!ok.includes(grant.permissions[name] ?? '')) out.push(`the App lacks ${name}: ${ok[0]}`);
  }
  if (grant.repos.length === 0) out.push('the App is installed on no repositories: choose them in its installation on GitHub');
  return out;
}

export class GithubApp {
  private cached: { token: string; until: number; installation: string } | null = null;
  constructor(private readonly dir: string, private readonly get: Fetch = fetch, private readonly now: () => number = Date.now) {}

  get connected(): boolean {
    return existsSync(join(this.dir, 'app.json')) && existsSync(join(this.dir, 'private-key.pem'));
  }
  info(): AppInfo | null {
    return this.connected ? (JSON.parse(readFileSync(join(this.dir, 'app.json'), 'utf8')) as AppInfo) : null;
  }

  /** Turns the one-time code GitHub gave after the App was created into the App's identity and secrets, kept on disk. */
  static async convert(dir: string, code: string, get: Fetch = fetch): Promise<AppInfo> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new Error('not a manifest code');
    const r = await get(`${API}/app-manifests/${code}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`GitHub refused the manifest code (${r.status})`);
    const app = (await r.json()) as Record<string, unknown>;
    const info: AppInfo = { id: String(app.id), slug: String(app.slug), owner: String((app.owner as Record<string, unknown> | undefined)?.login ?? ''), html_url: String(app.html_url) };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, 'private-key.pem'), String(app.pem), { mode: 0o600 });
    writeFileSync(join(dir, 'webhook_secret'), String(app.webhook_secret), { mode: 0o600 });
    writeFileSync(join(dir, 'app.json'), JSON.stringify(info, null, 2), { mode: 0o600 });
    return info;
  }

  private async call(url: string, auth: string, init: RequestInit = {}): Promise<Response> {
    const r = await this.get(url.startsWith('http') ? url : `${API}${url}`, { ...init, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: auth, ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error(`GitHub answered ${r.status} to ${url.replace(API, '')}`);
    return r;
  }

  /** An installation token for the App's installation in its owner's organisation, kept in memory until shortly before it expires. */
  private async token(): Promise<{ token: string; installation: string; permissions: Record<string, string> }> {
    const info = this.info();
    if (info === null) throw new Error('GitHub is not connected');
    const jwt = `Bearer ${appJwt(info.id, readFileSync(join(this.dir, 'private-key.pem'), 'utf8'), Math.floor(this.now() / 1000))}`;
    const installs = (await (await this.call('/app/installations', jwt)).json()) as Record<string, unknown>[];
    const mine = installs.find((i) => String((i.account as Record<string, unknown> | undefined)?.login ?? '').toLowerCase() === info.owner.toLowerCase()) ?? installs[0];
    if (mine === undefined) throw new Error('the App is not installed anywhere yet');
    const t = (await (await this.call(`/app/installations/${mine.id}/access_tokens`, jwt, { method: 'POST' })).json()) as Record<string, unknown>;
    this.cached = { token: String(t.token), installation: String(mine.id), until: Date.parse(String(t.expires_at)) - 5 * 60_000 };
    return { token: this.cached.token, installation: this.cached.installation, permissions: (t.permissions as Record<string, string>) ?? {} };
  }

  /** Every page of a list, following GitHub's Link header. */
  private async *pages(url: string, auth: string): AsyncGenerator<Record<string, unknown>[]> {
    let next: string | null = url;
    for (let guard = 0; next !== null && guard < 1000; guard++) {
      const r = await this.call(next, auth);
      const body = (await r.json()) as unknown;
      yield Array.isArray(body) ? (body as Record<string, unknown>[]) : (((body as Record<string, unknown>).repositories as Record<string, unknown>[]) ?? []);
      next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1] ?? null;
    }
  }

  /**
   * Makes an issue's or pull request's rb:* labels say `want` and nothing else of the board's (T-446): only
   * labels in `allowed` are ever taken off or put on, others are left alone. Answers the labels read back after.
   */
  async setLabel(repo: string, number: number, want: string, allowed: Set<string>): Promise<string[]> {
    if (want !== '' && !allowed.has(want)) throw new Error(`${want} is not a label the board writes`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number)) throw new Error('not a repository and number');
    const t = this.cached !== null && this.cached.until > this.now() ? this.cached : await this.token();
    const auth = `token ${t.token}`;
    const names = async (): Promise<string[]> => ((await (await this.call(`/repos/${repo}/issues/${number}/labels?per_page=100`, auth)).json()) as Record<string, unknown>[]).map((l) => String(l.name));
    const have = await names();
    for (const name of have) {
      if (allowed.has(name) && name !== want) await this.call(`/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, auth, { method: 'DELETE' });
    }
    if (want !== '' && !have.includes(want)) await this.call(`/repos/${repo}/issues/${number}/labels`, auth, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: [want] }) });
    return names();
  }

  /** What the installation was actually granted: its permissions and every repository it may read. */
  async grant(): Promise<Grant> {
    const t = await this.token();
    const repos: Grant['repos'] = [];
    for await (const page of this.pages('/installation/repositories?per_page=100', `token ${t.token}`)) {
      for (const r of page) repos.push({ id: String(r.id), name: String(r.full_name), private: r.private === true });
    }
    return { installation: t.installation, permissions: t.permissions, repos };
  }

  /**
   * Every open issue and pull request of a repository, and every one closed since the cutoff, as webhook-shaped
   * deliveries with the id each is to be taken under. An open pull request comes from the pulls API, which gives
   * its head and description, followed by its head's check runs and its reviews (T-446).
   */
  async *snapshot(repo: { id: string; name: string; private: boolean }, cutoff: string): AsyncGenerator<{ event: string; payload: Record<string, unknown>; id: string }> {
    const t = this.cached !== null && this.cached.until > this.now() ? this.cached : await this.token();
    const auth = `token ${t.token}`;
    const repository = { id: Number(repo.id), full_name: repo.name, private: repo.private };
    for (const query of ['state=open', `state=closed&since=${encodeURIComponent(cutoff)}`]) {
      for await (const page of this.pages(`/repos/${repo.name}/issues?${query}&per_page=100`, auth)) {
        for (const i of page) {
          const pr = i.pull_request as Record<string, unknown> | undefined;
          if (pr === undefined) yield { event: 'issues', payload: { action: 'synced', issue: i, repository }, id: `sync-${repo.id}-${i.number}-${i.updated_at}` };
          // An open one comes below, whole.
          else if (i.state !== 'open') yield { event: 'pull_request', payload: { action: 'synced', pull_request: { ...i, merged_at: pr.merged_at ?? null }, repository }, id: `sync-${repo.id}-${i.number}-${i.updated_at}` };
        }
      }
    }
    for await (const page of this.pages(`/repos/${repo.name}/pulls?state=open&per_page=100`, auth)) {
      for (const p of page) {
        yield { event: 'pull_request', payload: { action: 'synced', pull_request: p, repository }, id: `sync-${repo.id}-${p.number}-${p.updated_at}-pr` };
        const sha = String((p.head as Record<string, unknown> | undefined)?.sha ?? '');
        if (/^[0-9a-f]{40}$/.test(sha)) {
          const runs = (await (await this.call(`/repos/${repo.name}/commits/${sha}/check-runs?per_page=100`, auth)).json()) as { check_runs?: Record<string, unknown>[] };
          for (const run of runs.check_runs ?? []) {
            yield { event: 'check_run', payload: { action: 'synced', check_run: { ...run, pull_requests: [{ number: p.number }] }, repository }, id: `sync-check-${run.id}-${run.status}-${run.conclusion ?? ''}` };
          }
        }
        for await (const reviews of this.pages(`/repos/${repo.name}/pulls/${p.number}/reviews?per_page=100`, auth)) {
          for (const r of reviews) yield { event: 'pull_request_review', payload: { action: 'synced', review: r, pull_request: { number: p.number, html_url: p.html_url }, repository }, id: `sync-review-${r.id}-${r.state}` };
        }
      }
    }
  }
}
