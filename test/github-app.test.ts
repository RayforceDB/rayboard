// GitHub App (T-19): connecting by manifest, the permissions receipt, and reconciliation through every page.
import { afterAll, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openBoard, type Board } from '../src/board';
import { startServer, type Server } from '../src/server';
import { sharedRay, tempDir } from './helpers';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** A stand-in for GitHub: answers by path, records what was asked. */
function fakeGithub(o: { permissions?: Record<string, string>; repos?: { id: number; full_name: string; private: boolean }[]; open?: Record<string, unknown>[][]; closed?: Record<string, unknown>[] } = {}) {
  const asked: string[] = [];
  /** Labels on each issue, by "<repo>#<number>"; a person's own label is there from the start. */
  const labels = new Map<string, string[]>();
  const refuse = { writes: false };
  const permissions = o.permissions ?? { metadata: 'read', issues: 'write', pull_requests: 'read', checks: 'read' };
  const repos = o.repos ?? [{ id: 101, full_name: 'RayforceDB/rayforce', private: false }];
  const open = o.open ?? [[]];
  const reply = (body: unknown, link?: string) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...(link ? { Link: link } : {}) } });
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    asked.push(`${init?.method ?? 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname.startsWith('/app-manifests/')) {
      if (!u.pathname.includes('/good-code/')) return new Response('{}', { status: 404 });
      return reply({ id: 4242, slug: 'rayboard-test', owner: { login: 'RayforceDB' }, html_url: 'https://github.com/apps/rayboard-test', pem, webhook_secret: 'whsec', client_secret: 'NOT-KEPT' });
    }
    if (u.pathname === '/app/installations') return reply([{ id: 77, account: { login: 'RayforceDB' } }]);
    if (u.pathname === '/app/installations/77/access_tokens') return reply({ token: 'ghs_x', expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions });
    if (u.pathname === '/installation/repositories') {
      const page = Number(u.searchParams.get('page') ?? '1');
      const half = Math.ceil(repos.length / 2);
      const slice = page === 1 ? repos.slice(0, half) : repos.slice(half);
      return reply({ repositories: slice }, page === 1 && repos.length > 1 ? `<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"` : undefined);
    }
    const lab = /^\/repos\/(.+)\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(u.pathname);
    if (lab) {
      const key = `${lab[1]}#${lab[2]}`;
      const have = labels.get(key) ?? ['bug'];
      const method = init?.method ?? 'GET';
      if (method !== 'GET' && refuse.writes) return new Response('{}', { status: 403 });
      if (method === 'DELETE') labels.set(key, have.filter((l) => l !== decodeURIComponent(lab[3]!)));
      if (method === 'POST') labels.set(key, [...have, ...(JSON.parse(String(init!.body)) as { labels: string[] }).labels]);
      return reply((labels.get(key) ?? have).map((name) => ({ name })));
    }
    // Open pull requests whole, with their head and description; the head's check runs; the reviews (T-446).
    const pulls = /^\/repos\/(.+)\/pulls$/.exec(u.pathname);
    if (pulls) {
      const all = open.flat().filter((i) => i.pull_request !== undefined).map((i) => ({ ...i, head: { sha: 'a'.repeat(40) }, body: 'Fixes #1' }));
      return reply(all);
    }
    if (/^\/repos\/.+\/commits\/[0-9a-f]{40}\/check-runs$/.test(u.pathname)) {
      return reply({ check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', completed_at: '2026-11-17T10:05:00Z', head_sha: 'a'.repeat(40) }] });
    }
    if (/^\/repos\/.+\/pulls\/\d+\/reviews$/.test(u.pathname)) {
      return reply([{ id: 7, state: 'APPROVED', user: { login: 'mentor' }, submitted_at: '2026-11-17T10:06:00Z' }]);
    }
    const issues = /^\/repos\/(.+)\/issues$/.exec(u.pathname);
    if (issues) {
      if (u.searchParams.get('state') === 'closed') return reply(o.closed ?? []);
      const page = Number(u.searchParams.get('page') ?? '1');
      return reply(open[page - 1] ?? [], page < open.length ? `<https://api.github.com${u.pathname}?state=open&per_page=100&page=${page + 1}>; rel="next"` : undefined);
    }
    return new Response('{}', { status: 404 });
  };
  return { fetch, asked, labels, refuse };
}

const issue = (n: number, title: string, extra: Record<string, unknown> = {}) =>
  ({ node_id: `I_${n}`, number: n, html_url: `https://github.com/RayforceDB/rayforce/issues/${n}`, title, state: 'open', user: { login: 'someone' }, updated_at: '2026-11-17T10:00:00Z', ...extra });

const servers: Server[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); });

async function setup(fake: ReturnType<typeof fakeGithub>): Promise<{ board: Board; server: Server; admin: Record<string, string>; member: Record<string, string>; dir: string }> {
  const base = join(tempDir(), 'board');
  const board = openBoard({ ray: await sharedRay(), base });
  await board.createUser('anton', 'correct horse battery');
  await board.createUser('mia', 'correct horse battery', 'member');
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dirname(base), log: () => {}, githubFetch: fake.fetch });
  servers.push(server);
  const login = async (name: string) => {
    const r = await fetch(`${server.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url }, body: JSON.stringify({ name, password: 'correct horse battery' }) });
    return { Cookie: r.headers.get('set-cookie')!.split(';')[0]!, Origin: server.url, 'X-CSRF-Token': ((await r.json()) as { csrf: string }).csrf, 'Content-Type': 'application/json' };
  };
  return { board, server, admin: await login('anton'), member: await login('mia'), dir: join(dirname(base), 'github') };
}

test('an administrator connects GitHub by manifest: a one-time state, secrets kept on disk only, then installation', async () => {
  const fake = fakeGithub();
  const { server, admin, member, dir } = await setup(fake);
  expect((await fetch(`${server.url}/api/github/connect`, { method: 'POST', headers: member, body: '{}' })).status).toBe(403);
  const started = (await (await fetch(`${server.url}/api/github/connect`, { method: 'POST', headers: admin, body: '{}' })).json()) as { url: string; manifest: { default_permissions: Record<string, string>; hook_attributes: { url: string } } };
  // Only what the contract allows: no Projects, no contents.
  expect(started.manifest.default_permissions).toEqual({ metadata: 'read', issues: 'write', pull_requests: 'read', checks: 'read' });
  expect(started.manifest.hook_attributes.url).toBe(`${server.url}/api/github`);
  const state = new URL(started.url).searchParams.get('state')!;
  expect((await fetch(`${server.url}/api/github/manifest?code=good-code&state=forged`, { redirect: 'manual' })).status).toBe(401);
  const back = await fetch(`${server.url}/api/github/manifest?code=good-code&state=${state}`, { redirect: 'manual' });
  expect(back.status).toBe(302);
  expect(back.headers.get('location')).toBe('https://github.com/apps/rayboard-test/installations/new');
  // The state is spent.
  expect((await fetch(`${server.url}/api/github/manifest?code=good-code&state=${state}`, { redirect: 'manual' })).status).toBe(401);
  expect(statSync(join(dir, 'private-key.pem')).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, 'webhook_secret')).mode & 0o777).toBe(0o600);
  const info = readFileSync(join(dir, 'app.json'), 'utf8');
  expect(JSON.parse(info)).toEqual({ id: '4242', slug: 'rayboard-test', owner: 'RayforceDB', html_url: 'https://github.com/apps/rayboard-test' });
  expect(info).not.toContain('PRIVATE KEY');
  expect(JSON.stringify(readFileSync(join(dir, 'app.json'), 'utf8'))).not.toContain('NOT-KEPT');
  expect((await fetch(`${server.url}/api/github/connect`, { method: 'POST', headers: admin, body: '{}' })).status).toBe(409);
});

test('reconciliation follows what the App is installed on, reads every page, takes each item once, and records the grant', async () => {
  const fake = fakeGithub({
    repos: [{ id: 101, full_name: 'RayforceDB/rayforce', private: false }, { id: 202, full_name: 'RayforceDB/rayforce-q', private: false }],
    open: [[issue(1, 'one'), issue(2, 'two')], [issue(3, 'three'), issue(4, 'a pull request', { pull_request: { merged_at: null } })]],
    closed: [issue(5, 'closed lately', { state: 'closed' })],
  });
  const { board, server, admin, dir } = await setup(fake);
  const anton = board.firstUser()!;
  // A list saved by hand before connecting is replaced by the installation at the first check.
  await board.call(anton, 'set_github_repos', { repos: 'RayforceDB/elsewhere' });
  const started = (await (await fetch(`${server.url}/api/github/connect`, { method: 'POST', headers: admin, body: '{}' })).json()) as { url: string };
  await fetch(`${server.url}/api/github/manifest?code=good-code&state=${new URL(started.url).searchParams.get('state')}`, { redirect: 'manual' });
  expect(existsSync(join(dir, 'app.json'))).toBe(true);
  for (let i = 0; i < 2; i++) expect((await fetch(`${server.url}/api/github/sync`, { method: 'POST', headers: admin, body: '{}' })).status).toBe(200);
  const tasks = (await board.call(anton, 'list_tasks', { status: 'all', limit: 100 })) as { title: string; project: string }[];
  // The fake answers the same items for each repository: both repositories' copies come in, each once, each in its own project.
  expect(tasks.filter((t) => t.project === 'rayforce').map((t) => t.title).sort()).toEqual(['rayforce#1 one', 'rayforce#2 two', 'rayforce#3 three', 'rayforce#4 a pull request', 'rayforce#5 closed lately']);
  expect(tasks.filter((t) => t.project === 'rayforce-q')).toHaveLength(5);
  expect(fake.asked.some((a) => a.includes('/installation/repositories') && a.includes('page=2'))).toBe(true);
  expect(fake.asked.some((a) => a.includes('state=open') && a.includes('page=2'))).toBe(true);
  expect(fake.asked.some((a) => a.includes('/repos/RayforceDB/elsewhere/'))).toBe(false);
  const status = (await board.call(anton, 'github_status', {})) as { repos: { name: string; id: string }[]; app: { problems: string[] } };
  expect(status.app.problems).toEqual([]);
  // An open pull request is read whole: its head, the issue it closes, its checks and its review.
  const github = ((await board.call(anton, 'dashboard', {})) as { github: { repo: string; number: number; kind: string; checks: string; review: string; closes: number[]; closed_by: number[] }[] }).github;
  const pr = github.find((g) => g.repo === 'RayforceDB/rayforce' && g.number === 4)!;
  expect(pr).toMatchObject({ kind: 'pr', checks: 'success', review: 'approved', closes: [1] });
  expect(github.find((g) => g.repo === 'RayforceDB/rayforce' && g.number === 1)!.closed_by).toEqual([4]);
  expect(status.repos).toEqual([{ name: 'RayforceDB/rayforce', id: '101' }, { name: 'RayforceDB/rayforce-q', id: '202' }]);
  expect(JSON.stringify(status)).not.toContain('ghs_x');
  const events = (await board.call(anton, 'activity', { limit: 200 })) as { type: string; summary: string }[];
  expect(events.filter((e) => e.type === 'github.repos' && e.summary.startsWith('Following'))).toHaveLength(1);
});

test('a grant missing a permission is a configuration problem an administrator can see', async () => {
  const fake = fakeGithub({ permissions: { metadata: 'read', issues: 'read', pull_requests: 'read', checks: 'read' } });
  const { board, server, admin } = await setup(fake);
  const anton = board.firstUser()!;
  const started = (await (await fetch(`${server.url}/api/github/connect`, { method: 'POST', headers: admin, body: '{}' })).json()) as { url: string };
  await fetch(`${server.url}/api/github/manifest?code=good-code&state=${new URL(started.url).searchParams.get('state')}`, { redirect: 'manual' });
  await fetch(`${server.url}/api/github/sync`, { method: 'POST', headers: admin, body: '{}' });
  const status = (await board.call(anton, 'github_status', {})) as { app: { problems: string[] } };
  expect(status.app.problems).toEqual(['the App lacks issues: write']);
});

test('an App installed on no repository is flagged; repositories are otherwise never a problem, since they are chosen on GitHub', async () => {
  const { missing } = await import('../src/github');
  const permissions = { metadata: 'read', issues: 'write', pull_requests: 'read', checks: 'read' };
  expect(missing({ installation: '1', permissions, repos: [] })).toEqual(['the App is installed on no repositories: choose them in its installation on GitHub']);
  expect(missing({ installation: '1', permissions, repos: [{ id: '1', name: 'RayforceDB/rayforce', private: false }, { id: '2', name: 'RayforceDB/website', private: false }] })).toEqual([]);
});

test('a GitHub task\'s board status is written back as one rb: label, read back, and nothing else of anyone\'s is touched (T-446)', async () => {
  const fake = fakeGithub({ open: [[issue(1, 'one')]] });
  const { board, server, admin } = await setup(fake);
  const anton = board.firstUser()!;
  const started = (await (await fetch(`${server.url}/api/github/connect`, { method: 'POST', headers: admin, body: '{}' })).json()) as { url: string };
  await fetch(`${server.url}/api/github/manifest?code=good-code&state=${new URL(started.url).searchParams.get('state')}`, { redirect: 'manual' });
  await fetch(`${server.url}/api/github/sync`, { method: 'POST', headers: admin, body: '{}' });
  const t = ((await board.call(anton, 'list_tasks', { status: 'all' })) as { id: string; rev: number }[]).find(() => true)!;
  const settle = async (want: (l: string[]) => boolean) => { for (let i = 0; i < 100 && !want(fake.labels.get('RayforceDB/rayforce#1') ?? ['bug']); i++) await Bun.sleep(20); return fake.labels.get('RayforceDB/rayforce#1') ?? ['bug']; };
  // Nothing taken on the board yet: nothing written.
  expect(fake.asked.some((a) => a.includes('/labels'))).toBe(false);
  await board.call(anton, 'claim_task', { task: t.id });
  expect(await settle((l) => l.includes('rb:in-progress'))).toEqual(['bug', 'rb:in-progress']);
  const claimed = ((await board.call(anton, 'get_task', { task: t.id })) as { task: { rev: number } }).task;
  await board.call(anton, 'move_task', { task: t.id, status: 'in_review', rev: claimed.rev });
  expect(await settle((l) => l.includes('rb:review'))).toEqual(['bug', 'rb:review']);
  // Each write is kept with what reading it back showed; a write that took is not news in the activity.
  const writes = ((await board.call(anton, 'github_status', {})) as { writes: { want: string; result: string; detail: string }[] }).writes;
  expect(writes.map((w) => [w.want, w.result])).toEqual([['rb:review', 'ok'], ['rb:in-progress', 'ok']]);
  expect(writes[0]!.detail).toBe('read back: bug, rb:review');
  // GitHub refusing the write is said, and the next reconciliation tries again.
  fake.refuse.writes = true;
  const current = ((await board.call(anton, 'get_task', { task: t.id })) as { task: { rev: number } }).task;
  await board.call(anton, 'cancel_task', { task: t.id, rev: current.rev, reason: 'not ours' });
  for (let i = 0; i < 100; i++) { const ev = (await board.call(anton, 'activity', { limit: 5 })) as { summary: string }[]; if (ev.some((e) => e.summary.includes('did not take'))) break; await Bun.sleep(20); }
  expect(((await board.call(anton, 'activity', { limit: 5 })) as { summary: string }[]).some((e) => e.summary.includes('writing no label did not take'))).toBe(true);
  fake.refuse.writes = false;
  await fetch(`${server.url}/api/github/sync`, { method: 'POST', headers: admin, body: '{}' });
  expect(await settle((l) => !l.includes('rb:review'))).toEqual(['bug']);
});

test('the App never writes a label outside the board\'s own', async () => {
  const { GithubApp } = await import('../src/github');
  const app = new GithubApp(tempDir(), fakeGithub().fetch);
  await expect(app.setLabel('RayforceDB/rayforce', 1, 'priority:high', new Set(['rb:review']))).rejects.toThrow('not a label the board writes');
});

test('a pull request is labelled only once the App may write pull requests; until then it is left as it is (T-446)', async () => {
  const pull = { ...issue(4, 'a pull request', { pull_request: { merged_at: null } }) };
  for (const [grant, written] of [['read', false], ['write', true]] as const) {
    const fake = fakeGithub({ open: [[pull]], permissions: { metadata: 'read', issues: 'write', pull_requests: grant, checks: 'read' } });
    const { board, server, admin } = await setup(fake);
    const anton = board.firstUser()!;
    const started = (await (await fetch(`${server.url}/api/github/connect`, { method: 'POST', headers: admin, body: '{}' })).json()) as { url: string };
    await fetch(`${server.url}/api/github/manifest?code=good-code&state=${new URL(started.url).searchParams.get('state')}`, { redirect: 'manual' });
    await fetch(`${server.url}/api/github/sync`, { method: 'POST', headers: admin, body: '{}' });
    const t = ((await board.call(anton, 'list_tasks', { status: 'all' })) as { id: string }[])[0]!;
    await board.call(anton, 'claim_task', { task: t.id });
    for (let i = 0; i < 30 && !(fake.labels.get('RayforceDB/rayforce#4') ?? []).includes('rb:in-progress'); i++) await Bun.sleep(20);
    expect((fake.labels.get('RayforceDB/rayforce#4') ?? []).includes('rb:in-progress')).toBe(written);
  }
});
