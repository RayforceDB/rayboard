import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
async function stopAll(): Promise<void> {
  await server?.stop();
  board?.close();
  server = null;
  board = null;
}
async function restart(dir: string, between?: (stopped: Board) => Promise<void>): Promise<Server> {
  await stopAll();
  if (between) {
    // What the console does with the server stopped: the board opened on its own, then closed.
    const alone = openBoard({ ray: await sharedRay(), base: join(dir, 'board') });
    await between(alone);
    alone.close();
  }
  return start(dir);
}
afterEach(async () => {
  await stopAll();
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
  expect(Object.values(JSON.parse(kept) as Record<string, { user: string }>).map((v) => Object.keys(v).sort())).toContainEqual(['stamp', 'until', 'user']);
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

test('a password reset on the console, with the server stopped, ends that person\'s sessions', async () => {
  const dir = tempDir();
  let s = await boardWithAnton(dir);
  const anton = await signIn(s, 'anton', 'correct horse battery');
  let fresh = '';
  s = await restart(dir, async (alone) => { fresh = await alone.resetPassword('anton'); });
  expect((await sessionOf(s, anton.cookie)).user).toBeNull();
  // The one that ended is gone from the file as well, and the new password signs in.
  expect(Object.keys(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as object)).toHaveLength(0);
  await signIn(s, 'anton', fresh);
});

test('a deactivated person\'s sessions end, and leave the file', async () => {
  const dir = tempDir();
  let s = await boardWithAnton(dir);
  const anton = await signIn(s, 'anton', 'correct horse battery');
  const invited = (await (await post(s, '/api/call/invite_person', { role: 'member' }, as(anton))).json()) as { result: { key: string } };
  expect((await post(s, '/api/join', { key: invited.result.key, name: 'mica', password: 'another long passphrase' })).status).toBe(200);
  const mica = await signIn(s, 'mica', 'another long passphrase');
  const id = ((await sessionOf(s, mica.cookie)).user as { id?: string } | null)?.id;
  expect((await post(s, '/api/call/deactivate_person', { user: id }, as(anton))).status).toBe(200);
  s = await restart(dir);
  expect((await sessionOf(s, mica.cookie)).user).toBeNull();
  expect(Object.values(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as Record<string, { user: string }>).map((v) => v.user)).not.toContain(id);
  expect((await sessionOf(s, anton.cookie)).user?.name).toBe('anton');
});

test('when the file cannot be written it is deleted, so a session that ended cannot come back', async () => {
  const dir = tempDir();
  let s = await boardWithAnton(dir);
  const anton = await signIn(s, 'anton', 'correct horse battery');
  const file = join(dir, 'sessions.json');
  expect(existsSync(file)).toBe(true);
  // A directory where the next file goes: writing it fails.
  mkdirSync(`${file}.next/x`, { recursive: true });
  expect((await post(s, '/api/logout', {}, as(anton))).status).toBe(200);
  expect(existsSync(file)).toBe(false);
  expect(logged.some((line) => line.includes('could not be written'))).toBe(true);
  s = await restart(dir);
  expect((await sessionOf(s, anton.cookie)).user).toBeNull();
});

test('a session in the file lasts no longer than seven days, whatever the file says', async () => {
  const dir = tempDir();
  let s = await boardWithAnton(dir);
  const anton = await signIn(s, 'anton', 'correct horse battery');
  const file = join(dir, 'sessions.json');
  const kept = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { until: number }>;
  for (const k of Object.keys(kept)) kept[k]!.until = Date.now() + 365 * 86_400_000;
  writeFileSync(file, JSON.stringify(kept));
  s = await restart(dir);
  expect((await sessionOf(s, anton.cookie)).user?.name).toBe('anton');
  await post(s, '/api/logout', {}, as(anton));
  await signIn(s, 'anton', 'correct horse battery');
  for (const v of Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, { until: number }>)) expect(v.until).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
});

test('in unsafe mode nothing is kept', async () => {
  const dir = tempDir();
  board = openBoard({ ray: await sharedRay(), base: join(dir, 'board') });
  const operator = await board.createUser('operator', 'nobody knows this one');
  server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dir, log: () => {}, unsafe: operator });
  await fetch(`${server.url}/api/session`);
  expect(existsSync(join(dir, 'sessions.json'))).toBe(false);
});
