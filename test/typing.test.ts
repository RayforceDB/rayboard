// Typing (T-476): who is writing where, told only to those who may read it, kept nowhere, gone when it lapses.
import { afterAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { openBoard } from '../src/board';
import { startServer, type Server } from '../src/server';
import { sharedRay, tempDir } from './helpers';

const servers: Server[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); });

async function setup(typingMs = 400) {
  const base = join(tempDir(), 'board');
  const board = openBoard({ ray: await sharedRay(), base });
  const anton = await board.createUser('anton', 'correct horse battery');
  const serhii = await board.createUser('serhii', 'correct horse battery', 'member');
  const vic = await board.createUser('vic', 'correct horse battery', 'member');
  const watcher = await board.createUser('watcher', 'correct horse battery', 'viewer');
  const made = (await board.call(anton, 'create_agent', { name: 'helper' })) as { token: string };
  const helper = board.agentOfToken(made.token)!;
  await board.call(anton, 'create_channel', { name: 'general' });
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dirname(base), log: () => {}, typingMs });
  servers.push(server);
  return { board, server, anton, serhii, vic, watcher, helper, token: made.token };
}

/** A signed-in page's live feed, collecting what it is told. */
async function feed(url: string, name: string) {
  const r = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ name, password: 'correct horse battery' }) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = ((await r.json()) as { csrf: string }).csrf;
  const frames: any[] = [];
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie, Origin: url } } as never);
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error('no socket')); });
  const call = (action: string, params: object) => fetch(`${url}/api/call/${action}`, { method: 'POST', headers: { Cookie: cookie, Origin: url, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  const typing = () => frames.filter((f) => f.typing).map((f) => f.typing);
  return { ws, frames, call, typing };
}
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test('writing nowhere one may not: another pair\'s DM (also for an administrator), a private task one cannot see, as a viewer or a paused agent', async () => {
  const { board, anton, serhii, vic, watcher, helper, token } = await setup();
  const dm = `dm:${[serhii.id, vic.id].sort().join(':')}`;
  await expect(board.call(anton, 'typing', { to: dm })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(board.call(helper, 'typing', { to: dm })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(board.call(watcher, 'typing', { to: '#general' })).rejects.toMatchObject({ code: 'forbidden' });
  const secret = (await board.call(anton, 'create_task', { title: 'Secret', outcome: 'x', private: true })) as { id: string };
  await expect(board.call(vic, 'typing', { to: secret.id })).rejects.toBeDefined();
  await board.call(anton, 'pause_agent', { agent: 'helper', reason: 'test' });
  await expect(board.call(board.agentOfToken(token)!, 'typing', { to: '#general' })).rejects.toMatchObject({ code: 'paused' });
  // And where one may, it is accepted.
  expect(await board.call(serhii, 'typing', { to: dm })).toMatchObject({ ok: true, chan: dm });
});

test('nothing of it is kept, notified or counted: no event, message, note or inbox item; a post ends it', async () => {
  const { board, serhii, vic } = await setup();
  const heard: { chan: string; who: string; composing: boolean }[] = [];
  board.onTyping((t) => heard.push(t));
  const count = (t: string) => board.store.all(t as never).length;
  const before = { events: count('events'), messages: count('messages'), notes: count('notes') };
  await board.call(serhii, 'typing', { to: '@vic' });
  await board.call(serhii, 'typing', { to: '#general', composing: true });
  await board.call(serhii, 'typing', { to: '#general', composing: false });
  expect({ events: count('events'), messages: count('messages'), notes: count('notes') }).toEqual(before);
  expect(((await board.call(vic, 'inbox', {})) as { items: unknown[] }).items).toEqual([]);
  const dm = `dm:${[serhii.id, vic.id].sort().join(':')}`;
  expect(heard.slice(0, 3)).toEqual([
    { chan: dm, who: serhii.id, composing: true },
    { chan: expect.stringMatching(/^c_/), who: serhii.id, composing: true },
    { chan: expect.stringMatching(/^c_/), who: serhii.id, composing: false },
  ]);
  await board.call(serhii, 'post_message', { to: '@vic', body: 'hi' });
  expect(heard.at(-1)).toEqual({ chan: dm, who: serhii.id, composing: false });
});

test('who may read a conversation: its two and the administrators for a DM, everyone for a channel, those who see a task', async () => {
  const { board, anton, serhii, vic, helper } = await setup();
  const dm = `dm:${[serhii.id, vic.id].sort().join(':')}`;
  expect(board.mayRead(serhii.id, dm)).toBe(true);
  expect(board.mayRead(anton.id, dm)).toBe(true);
  expect(board.mayRead(helper.id, dm)).toBe(false);
  const general = board.store.all('channels' as never)[0] as { id: string };
  expect(board.mayRead(helper.id, general.id)).toBe(true);
  const secret = (await board.call(anton, 'create_task', { title: 'Secret', outcome: 'x', private: true })) as { id: string };
  expect(board.mayRead(vic.id, secret.id)).toBe(false);
  expect(board.mayRead(anton.id, secret.id)).toBe(true);
  // And the feed of changes no longer says to everyone that a DM moved.
  expect(board.mayKnow(vic.id, `dm:${[serhii.id, anton.id].sort().join(':')}`)).toBe(false);
});

test('over the live feed: told to those who may read it and to nobody else, refreshed, lapsing, and ended by a closed page', async () => {
  const { server, anton, serhii, vic } = await setup(400);
  const a = await feed(server.url, 'anton');
  const s = await feed(server.url, 'serhii');
  const v = await feed(server.url, 'vic');
  const dm = `dm:${[serhii.id, vic.id].sort().join(':')}`;
  // Serhii writes to vic: vic and the administrator are told; nobody tells serhii of himself.
  expect((await s.call('typing', { to: dm })).status).toBe(200);
  await settle();
  expect(v.typing().at(-1)).toMatchObject({ chan: dm, who: serhii.id });
  expect(v.typing().at(-1).until).toBeGreaterThan(Date.now());
  expect(a.typing().at(-1)).toMatchObject({ chan: dm, who: serhii.id });
  expect(s.typing()).toEqual([]);
  // A DM between serhii and anton is not told to vic, not even that it exists.
  const sa = `dm:${[serhii.id, anton.id].sort().join(':')}`;
  const seenByVic = v.typing().length;
  await s.call('typing', { to: sa });
  await settle();
  expect(v.typing().length).toBe(seenByVic);
  expect(a.typing().at(-1)).toMatchObject({ chan: sa });
  // Without a repeat it lapses, and the readers are told it stopped.
  await settle(1000);
  expect(v.typing().at(-1)).toMatchObject({ chan: dm, until: 0 });
  // Repeated, it stays; a closed page ends it at once.
  await s.call('typing', { to: dm });
  await settle(250);
  await s.call('typing', { to: dm });
  await settle(250);
  expect(v.typing().at(-1).until).toBeGreaterThan(0);
  s.ws.close();
  await settle(150);
  expect(v.typing().at(-1)).toMatchObject({ chan: dm, who: serhii.id, until: 0 });
  // Ordinary changes about another pair's DM reach vic's page as a bare "something changed", without whose or where.
  const s2 = await feed(server.url, 'serhii');
  const mark = v.frames.length;
  await s2.call('post_message', { to: '@anton', body: 'between us' });
  await settle();
  const told = v.frames.slice(mark).filter((f) => !f.typing);
  expect(told.length).toBeGreaterThan(0);
  for (const f of told) { expect(f.subject).toBeUndefined(); expect(f.actor).toBeUndefined(); }
  expect(a.frames.some((f) => f.subject === sa && f.type === 'message.dm')).toBe(true);
  a.ws.close(); v.ws.close(); s2.ws.close();
});

test('an agent writes only by saying so, over MCP or HTTP, and posting ends it', async () => {
  const { server, board, token, helper } = await setup(5000);
  const v = await feed(server.url, 'vic');
  const r = await fetch(`${server.url}/api/call/typing`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: '#general' }) });
  expect(r.status).toBe(200);
  await settle();
  expect(v.typing().at(-1)).toMatchObject({ who: helper.id });
  await board.call(helper, 'post_message', { to: '#general', body: 'done' });
  await settle();
  expect(v.typing().at(-1)).toMatchObject({ who: helper.id, until: 0 });
  v.ws.close();
});
