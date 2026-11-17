// Regressions from the T-15 audit: server, sessions and access.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openBoard, type Board, type Actor } from '../src/board';
import { startServer, type Server } from '../src/server';
import { sharedRay, tempDir } from './helpers';

const PNG = (n: number): Buffer => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([n])]);

async function fresh(unsafe = false): Promise<{ board: Board; server: Server; dir: string; admin?: Actor }> {
  const dir = tempDir();
  const board = openBoard({ ray: await sharedRay(), base: join(dir, 'board') });
  let op: Actor | undefined;
  if (unsafe) op = await board.createUser('operator', 'operator-password');
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dir, log: () => {}, ...(unsafe ? { unsafe: op } : {}) });
  return { board, server, dir, admin: op };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function login(server: Server, name: string, password: string): Promise<Record<string, string>> {
  const r = await post(`${server.url}/api/login`, { name, password }, { Origin: server.url });
  expect(r.status).toBe(200);
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = ((await r.json()) as { csrf: string }).csrf;
  return { Cookie: cookie, Origin: server.url, 'X-CSRF-Token': csrf };
}

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => { for (const c of cleanup) await c(); });

// F1: a member (not a party, not admin) cannot get_task a private task, but reads its history in `activity`.
test('over HTTP, a member does not see private task history in activity', async () => {
  const { board, server } = await fresh();
  cleanup.push(async () => { await server.stop(); board.close(); });
  const admin = await board.createUser('boss', 'boss-password-1');
  const member = await board.createUser('mem', 'mem-password-1', 'member');
  const t = (await board.call(admin, 'create_task', { title: 'SECRET acquisition of ACME', outcome: 'x', private: true })) as { id: string };
  await board.call(admin, 'post_message', { to: t.id, body: 'the password for the vault is hunter2' });
  await expect(board.call(member, 'get_task', { task: t.id })).rejects.toMatchObject({ code: 'not_found' });
  const log = (await board.call(member, 'activity', {})) as { subject: string; summary: string }[];
  const leaked = log.filter((e) => e.subject === t.id).map((e) => e.summary);
  expect(leaked).toEqual([]); // fails: summaries include the title and the comment text
});

// F2: a deactivated person (and one whose sessions were ended by a password change) keeps an open live feed.
test('the live feed stops when a person is deactivated', async () => {
  const { board, server } = await fresh();
  cleanup.push(async () => { await server.stop(); board.close(); });
  const admin = await board.createUser('boss', 'boss-password-1');
  const victim = await board.createUser('leaver', 'leaver-password-1', 'member');
  const h = await login(server, 'leaver', 'leaver-password-1');
  const got: string[] = [];
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws`, { headers: h } as any);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => got.push(String(m.data)));
  await board.call(admin, 'deactivate_person', { user: victim.id });
  await board.call(admin, 'create_task', { title: 'after deactivation', outcome: 'x', private: true });
  await Bun.sleep(200);
  ws.close();
  expect(got.filter((m) => m.includes('task.created'))).toEqual([]); // fails: the socket still gets events
});

// F3: a person changing their avatar deletes the file of an agent that has the same image.
test('changing the avatar of a person keeps the file an agent shares with it', async () => {
  const { board, server, dir } = await fresh();
  cleanup.push(async () => { await server.stop(); board.close(); });
  const admin = await board.createUser('boss', 'boss-password-1');
  const member = await board.createUser('mem', 'mem-password-1', 'member');
  const made = (await board.call(admin, 'create_agent', { name: 'bot' })) as { agent: { id: string } };
  board.setAgentAvatar(admin, made.agent.id, PNG(1), 'png');
  board.setAvatar(member.id, PNG(1), 'png'); // same bytes, same file
  board.setAvatar(member.id, PNG(2), 'png'); // the old one is unlinked although the agent still uses it
  expect(board.avatar(made.agent.id)).not.toBeNull(); // fails
});

// F4: two concurrent /api/setup requests with the code both create an administrator.
test('two setup requests at once create one first account', async () => {
  const { board, server } = await fresh();
  cleanup.push(async () => { await server.stop(); board.close(); });
  const code = server.setupCode!;
  const [a, b] = await Promise.all([
    post(`${server.url}/api/setup`, { code, name: 'first', password: 'first-password' }, { Origin: server.url }),
    post(`${server.url}/api/setup`, { code, name: 'second', password: 'second-password' }, { Origin: server.url }),
  ]);
  expect([a.status, b.status].sort()).toEqual([200, 409]); // fails: both 200
});

// F5: unsafe mode: any web page can read the feed (no Origin check on /ws) and the server answers to any Host (DNS rebinding).
test('unsafe mode refuses a cross-site socket and a foreign Host', async () => {
  const { board, server } = await fresh(true);
  cleanup.push(async () => { await server.stop(); board.close(); });
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws`, { headers: { Origin: 'https://evil.example' } } as any);
  const opened = await new Promise<boolean>((r) => { ws.addEventListener('open', () => r(true)); ws.addEventListener('error', () => r(false)); ws.addEventListener('close', () => r(false)); });
  ws.close();
  const r = await post(`${server.url}/api/call/create_agent`, { name: 'rebound' }, { Host: 'evil.example:4701', Origin: 'http://evil.example:4701' });
  const minted = r.status === 200;
  expect({ opened, minted }).toEqual({ opened: false, minted: false }); // fails on both
});

// A name shaped like an id would make lookups by name hit someone else: such names are refused.
test('names that look like ids are refused', async () => {
  const { board, server } = await fresh();
  cleanup.push(async () => { await server.stop(); board.close(); });
  const admin = await board.createUser('boss', 'boss-password-1');
  const victim = (await board.call(admin, 'create_agent', { name: 'victim' })) as { agent: { id: string } };
  const key = ((await board.call(admin, 'new_enrollment_key', {})) as { key: string }).key;
  expect(() => board.register(key, { name: victim.agent.id })).toThrow(/look like an id/);
  await expect(board.call(admin, 'create_agent', { name: 'u_abcdefgh' })).rejects.toMatchObject({ code: 'invalid' });
});
