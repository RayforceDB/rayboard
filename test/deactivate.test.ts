// Deactivating from People (T-458): a guarded action whose effect is immediate.
import { afterAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { openBoard } from '../src/board';
import { startServer, type Server } from '../src/server';
import { sharedRay, tempDir } from './helpers';

const servers: Server[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); });

test('nobody deactivates themselves, even with another administrator; the last administrator stays', async () => {
  const board = openBoard({ ray: await sharedRay(), base: join(tempDir(), 'board') });
  const anton = await board.createUser('anton', 'correct horse battery');
  const second = await board.createUser('second', 'correct horse battery', 'admin');
  await expect(board.call(second, 'deactivate_person', { user: second.id })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('yourself') });
  await board.call(anton, 'deactivate_person', { user: second.id });
  // Now anton is the last administrator; a member may not deactivate anyone.
  const member = await board.createUser('member', 'correct horse battery', 'member');
  await expect(board.call(member, 'deactivate_person', { user: anton.id })).rejects.toMatchObject({ code: 'forbidden' });
  const people = (await board.call(anton, 'dashboard', {})) as { people: { name: string; status: string }[] };
  expect(people.people.find((p) => p.name === 'second')?.status).toBe('deactivated');
});

test('a deactivated person loses an open session at once, and their name is no longer a contact', async () => {
  const base = join(tempDir(), 'board');
  const board = openBoard({ ray: await sharedRay(), base });
  const anton = await board.createUser('anton', 'correct horse battery');
  const guest = await board.createUser('guest', 'correct horse battery', 'member');
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dirname(base), log: () => {} });
  servers.push(server);
  const r = await fetch(`${server.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url }, body: JSON.stringify({ name: 'guest', password: 'correct horse battery' }) });
  const headers = { Cookie: r.headers.get('set-cookie')!.split(';')[0]!, Origin: server.url, 'X-CSRF-Token': ((await r.json()) as { csrf: string }).csrf, 'Content-Type': 'application/json' };
  const dashboard = () => fetch(`${server.url}/api/call/dashboard`, { method: 'POST', headers, body: '{}' });
  expect((await dashboard()).status).toBe(200);
  await board.call(anton, 'deactivate_person', { user: guest.id });
  const after = await dashboard();
  expect(after.status).toBe(401);
  const session = (await (await fetch(`${server.url}/api/session`, { headers })).json()) as { user: unknown };
  expect(session.user).toBeNull();
  expect(await board.login('guest', 'correct horse battery')).toBeNull();
});

test('the activity line for a new person says the role they joined with', async () => {
  const board = openBoard({ ray: await sharedRay(), base: join(tempDir(), 'board') });
  await board.createUser('anton', 'correct horse battery');
  await board.createUser('serhii', 'correct horse battery', 'member');
  await board.createUser('vic', 'correct horse battery', 'viewer');
  const anton = board.userById(board.store.all('users').find((u) => u.name === 'anton')!.id as string)!;
  const lines = ((await board.call(anton, 'activity', { limit: 10 })) as { summary: string }[]).map((e) => e.summary);
  expect(lines).toContain('anton joined as an administrator');
  expect(lines).toContain('serhii joined as a member');
  expect(lines).toContain('vic joined as a viewer');
});
