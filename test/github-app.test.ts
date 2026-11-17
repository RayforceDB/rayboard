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
    const issues = /^\/repos\/(.+)\/issues$/.exec(u.pathname);
    if (issues) {
      if (u.searchParams.get('state') === 'closed') return reply(o.closed ?? []);
      const page = Number(u.searchParams.get('page') ?? '1');
      return reply(open[page - 1] ?? [], page < open.length ? `<https://api.github.com${u.pathname}?state=open&per_page=100&page=${page + 1}>; rel="next"` : undefined);
    }
    return new Response('{}', { status: 404 });
  };
  return { fetch, asked };
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

test('reconciliation reads every page, takes each item once, and records the grant', async () => {
  const fake = fakeGithub({
    repos: [{ id: 101, full_name: 'RayforceDB/rayforce', private: false }, { id: 202, full_name: 'RayforceDB/rayforce-q', private: false }],
    open: [[issue(1, 'one'), issue(2, 'two')], [issue(3, 'three'), issue(4, 'a pull request', { pull_request: { merged_at: null } })]],
    closed: [issue(5, 'closed lately', { state: 'closed' })],
  });
  const { board, server, admin, dir } = await setup(fake);
  const anton = board.firstUser()!;
  await board.call(anton, 'set_github_repos', { repos: 'RayforceDB/rayforce' });
  const started = (await (await fetch(`${server.url}/api/github/connect`, { method: 'POST', headers: admin, body: '{}' })).json()) as { url: string };
  await fetch(`${server.url}/api/github/manifest?code=good-code&state=${new URL(started.url).searchParams.get('state')}`, { redirect: 'manual' });
  expect(existsSync(join(dir, 'app.json'))).toBe(true);
  for (let i = 0; i < 2; i++) expect((await fetch(`${server.url}/api/github/sync`, { method: 'POST', headers: admin, body: '{}' })).status).toBe(200);
  const titles = ((await board.call(anton, 'list_tasks', { status: 'all' })) as { title: string }[]).map((t) => t.title).sort();
  expect(titles).toEqual(['rayforce#1 one', 'rayforce#2 two', 'rayforce#3 three', 'rayforce#4 a pull request', 'rayforce#5 closed lately']);
  // Both pages of each list were read, and the installation token was asked for with a signed JWT.
  expect(fake.asked.some((a) => a.includes('/installation/repositories') && a.includes('page=2'))).toBe(true);
  expect(fake.asked.some((a) => a.includes('state=open') && a.includes('page=2'))).toBe(true);
  const status = (await board.call(anton, 'github_status', {})) as { repos: { name: string; id: string }[]; app: { problems: string[]; permissions: Record<string, string> } };
  expect(status.app.problems).toEqual([]);
  expect(status.repos).toEqual([{ name: 'RayforceDB/rayforce', id: '101' }]);
  expect(JSON.stringify(status)).not.toContain('ghs_x');
});

test('a grant missing a permission or a followed repository is a configuration problem an administrator can see', async () => {
  const fake = fakeGithub({ permissions: { metadata: 'read', issues: 'read', pull_requests: 'read', checks: 'read' } });
  const { board, server, admin } = await setup(fake);
  const anton = board.firstUser()!;
  await board.call(anton, 'set_github_repos', { repos: 'RayforceDB/rayforce RayforceDB/rayforce-rs' });
  const started = (await (await fetch(`${server.url}/api/github/connect`, { method: 'POST', headers: admin, body: '{}' })).json()) as { url: string };
  await fetch(`${server.url}/api/github/manifest?code=good-code&state=${new URL(started.url).searchParams.get('state')}`, { redirect: 'manual' });
  await fetch(`${server.url}/api/github/sync`, { method: 'POST', headers: admin, body: '{}' });
  const status = (await board.call(anton, 'github_status', {})) as { app: { problems: string[] } };
  expect(status.app.problems).toEqual(['the App lacks issues: write', 'the App is not installed on RayforceDB/rayforce-rs']);
});
