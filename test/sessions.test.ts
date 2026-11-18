import { afterEach, expect, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBoard, type Board } from '../src/board';
import { startServer, type Server } from '../src/server';
import { sharedRay, tempDir } from './helpers';

// Restarting the board, as an update does, signs nobody out; ending a session ends it for good.

let board: Board | null = null;
let server: Server | null = null;
const logged: string[] = [];

async function start(dir: string): Promise<Server> {
  board = openBoard({ ray: await sharedRay(), base: join(dir, 'board') });
  server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dir, log: (line) => void logged.push(line) });
  return server;
}
async function restart(dir: string): Promise<Server> {
  await server?.stop();
  board?.close();
  return start(dir);
}
afterEach(async () => {
  await server?.stop();
  board?.close();
  server = null;
  board = null;
  logged.length = 0;
});

const post = (s: Server, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${s.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: s.url, ...headers }, body: JSON.stringify(body) });
const signIn = async (s: Server, name: string, password: string): Promise<{ cookie: string; csrf: string }> => {
  const r = await post(s, '/api/login', { name, password });
  expect(r.status).toBe(200);
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await r.json()) as { csrf: string }).csrf };
};
const as = (who: { cookie: string; csrf: string }): Record<string, string> => ({ Cookie: who.cookie, 'X-CSRF-Token': who.csrf });
const sessionOf = async (s: Server, cookie: string): Promise<{ user: { name: string } | null; csrf: string | null }> =>
  (await fetch(`${s.url}/api/session`, { headers: { Cookie: cookie } })).json() as Promise<{ user: { name: string } | null; csrf: string | null }>;

async function boardWithAnton(dir: string): Promise<Server> {
  const s = await start(dir);
  expect((await post(s, '/api/setup', { code: s.setupCode, name: 'anton', password: 'correct horse battery' })).status).toBe(200);
  return s;
}

test('a session outlives a restart of the board, with the same token for changes', async () => {
  const dir = tempDir();
  let s = await boardWithAnton(dir);
  const anton = await signIn(s, 'anton', 'correct horse battery');

  s = await restart(dir);
  const again = await sessionOf(s, anton.cookie);
  expect(again.user?.name).toBe('anton');
  expect(again.csrf).toBe(anton.csrf);
  expect((await post(s, '/api/call/dashboard', {}, as(anton))).status).toBe(200);
  // The token for changes is still the session's own.
  expect((await post(s, '/api/call/dashboard', {}, { Cookie: anton.cookie, 'X-CSRF-Token': 'x'.repeat(43) })).status).toBe(403);
});

test('what is kept on disk cannot sign anyone in, and only the board may read it', async () => {
  const dir = tempDir();
  const s = await boardWithAnton(dir);
  const anton = await signIn(s, 'anton', 'correct horse battery');
  const file = join(dir, 'sessions.json');
  const kept = readFileSync(file, 'utf8');
  const token = anton.cookie.split('=')[1]!;
  expect(kept).not.toContain(token);
  expect(kept).not.toContain(anton.csrf);
  expect(Object.values(JSON.parse(kept) as Record<string, { user: string }>).map((v) => Object.keys(v).sort())).toContainEqual(['until', 'user']);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test('signing out and a new password end sessions for good, restart or not', async () => {
  const dir = tempDir();
  let s = await boardWithAnton(dir);
  const first = await signIn(s, 'anton', 'correct horse battery');
  const second = await signIn(s, 'anton', 'correct horse battery');
  const third = await signIn(s, 'anton', 'correct horse battery');

  expect((await post(s, '/api/logout', {}, as(first))).status).toBe(200);
  s = await restart(dir);
  expect((await sessionOf(s, first.cookie)).user).toBeNull();
  expect((await sessionOf(s, second.cookie)).user?.name).toBe('anton');

  expect((await post(s, '/api/password', { current: 'correct horse battery', next: 'a brand new passphrase' }, as(second))).status).toBe(200);
  s = await restart(dir);
  expect((await sessionOf(s, second.cookie)).user).toBeNull();
  expect((await sessionOf(s, third.cookie)).user).toBeNull();
});

test('ended and unreadable sessions are left behind, and the board says why', async () => {
  const dir = tempDir();
  let s = await boardWithAnton(dir);
  const anton = await signIn(s, 'anton', 'correct horse battery');
  const file = join(dir, 'sessions.json');
  const kept = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { user: string; until: number }>;
  for (const k of Object.keys(kept)) kept[k]!.until = Date.now() - 1;
  writeFileSync(file, JSON.stringify(kept));
  s = await restart(dir);
  expect((await sessionOf(s, anton.cookie)).user).toBeNull();

  writeFileSync(file, 'not json');
  s = await restart(dir);
  expect(logged.some((line) => line.includes('could not be read'))).toBe(true);
  expect((await post(s, '/api/login', { name: 'anton', password: 'correct horse battery' })).status).toBe(200);
});
