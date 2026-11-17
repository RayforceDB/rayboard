import { beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openBoard, type Actor, type Board } from '../src/board';
import { sharedRay, tempDir } from './helpers';

let board: Board; let base: string; let admin: Actor; let clock: number;
const open = async (): Promise<Board> => openBoard({ ray: await sharedRay(), base, now: () => new Date((clock += 1000)) });
beforeEach(async () => {
  base = join(tempDir(), 'board'); clock = Date.UTC(2026, 10, 17, 12);
  board = await open(); admin = await board.createUser('anton', 'correct horse battery');
});
const agent = async (name: string): Promise<Actor> => board.agentOfToken(((await board.call(admin, 'create_agent', { name })) as { token: string }).token)!;
type Note = { seq: number; type: string; subject: string; sender: string; text: string };
// Opt-in notifications, independent of channel read access.
const subscribe = async (who: Actor, channel: string): Promise<void> => { await board.call(who, 'set_channel_subscription', { channel, subscribed: true }); };
const inbox = async (a: Actor, peek = false): Promise<Note[]> => ((await board.call(a, 'inbox', { peek })) as { items: Note[] }).items;

// R1 — the T-11 defect: an unaddressed channel line (seq204/seq280) must reach the channel's readers.
test('R1 plain channel message reaches subscribers, not the author (author subscribed too)', async () => {
  const a = await agent('aa'); const b = await agent('bb');
  await board.call(admin, 'create_channel', { name: 'general' });
  await subscribe(a, '#general'); await subscribe(b, '#general'); await subscribe(admin, '#general');
  const m = await board.call(admin, 'post_message', { to: '#general', body: 'messages still are not reaching you' }) as any;
  for (const who of [a, b]) expect((await inbox(who)).filter((n) => n.subject === m.chan)).toHaveLength(1);
  expect((await inbox(admin)).filter((n) => n.subject === m.chan)).toHaveLength(0);
});

// R2 — sender exclusion holds for self-mention and @all.
test('R2 the author is never told of their own message', async () => {
  const a = await agent('aa'); await agent('bb');
  await board.call(admin, 'create_channel', { name: 'general' });
  await board.call(a, 'post_message', { to: '#general', body: '@aa note to self, and @all' });
  expect(await inbox(a)).toEqual([]);
});

// R3 — mention + subscription (+ @all) to one recipient in one message => exactly one note, typed as mention.
test('R3 one message yields at most one note per recipient', async () => {
  const b = await agent('bb');
  await board.call(admin, 'create_channel', { name: 'general' });
  await subscribe(b, '#general');
  const m = await board.call(admin, 'post_message', { to: '#general', body: '@bb @BB @all hey @bb' }) as any;
  const notes = (await inbox(b)).filter((n) => n.subject === m.chan);
  expect(notes).toHaveLength(1);
  expect(notes[0]!.type).toBe('mention');
});

// R4 — DM isolation: names and @all inside a DM tell only the other party.
test('R4 a direct message tells only its other party, whatever it names', async () => {
  const a = await agent('aa'); const b = await agent('bb'); const c = await agent('cc');
  await board.call(admin, 'create_channel', { name: 'general' });
  await board.call(a, 'post_message', { to: '@bb', body: 'secret for @cc and @all and @anton' });
  expect((await inbox(b)).map((n) => n.type)).toEqual(['dm']);
  expect(await inbox(c)).toEqual([]);
  expect(await inbox(admin)).toEqual([]);
});

// R5 — an overseer writing into someone else's DM (API path, the UI hides the composer) must not fan out.
test('R5 an admin posting into a DM between two agents does not notify outsiders', async () => {
  const a = await agent('aa'); const b = await agent('bb'); const c = await agent('cc');
  const chan = `dm:${[a.id, b.id].sort().join(':')}`;
  await board.call(admin, 'post_message', { to: chan, body: 'overseer @all @cc' }).catch(() => undefined);
  // Either refused, or confined to the pair; never delivered to cc.
  expect(await inbox(c)).toEqual([]);
});

// R6 — delivery survives restart and the cursor: nothing lost, nothing redelivered after read.
test('R6 notes survive restart and consumed notes stay consumed', async () => {
  const b = await agent('bb');
  await board.call(admin, 'create_channel', { name: 'general' });
  await board.call(admin, 'post_message', { to: '#general', body: '@bb one' });
  board.close(); board = await open();
  expect((await inbox(b)).map((n) => n.text)).toEqual(['anton in #general: @bb one']);
  board.close(); board = await open();
  expect(await inbox(b)).toEqual([]);
});

// R7 — a waiting inbox wakes for a channel line (not just a mention) once subscriptions exist.
test('R7 a waiting inbox wakes on an unaddressed channel line', async () => {
  const b = await agent('bb');
  await board.call(admin, 'create_channel', { name: 'general' });
  await subscribe(b, '#general');
  const started = Date.now();
  const waiting = board.call(b, 'inbox', { wait: 5 }) as Promise<{ items: Note[] }>;
  await board.call(admin, 'post_message', { to: '#general', body: 'anyone?' });
  const got = await waiting;
  expect(got.items).toHaveLength(1);
  expect(Date.now() - started).toBeLessThan(2000);
});

// Paused mentions are a separate policy question; this patch preserves current behavior.
// R9 — explicit opt-in: a non-subscriber is told only when named; subscription survives restart.
test('R9 only subscribers hear unaddressed lines, and subscription survives restart', async () => {
  const sub = await agent('sub'); const other = await agent('other');
  await board.call(admin, 'create_channel', { name: 'general' });
  await subscribe(sub, '#general');
  board.close(); board = await open();
  await board.call(admin, 'post_message', { to: '#general', body: 'plain line' });
  expect((await inbox(sub)).map((n) => n.text)).toEqual(['anton in #general: plain line']);
  expect(await inbox(other)).toEqual([]);
  await board.call(admin, 'post_message', { to: '#general', body: 'now @other too' });
  expect((await inbox(other)).map((n) => n.type)).toEqual(['mention']);
});
test('subscriptions are self-only, idempotent and can be turned off', async () => {
  const sub = await agent('sub'); const other = await agent('other');
  const chan = await board.call(admin, 'create_channel', { name: 'general' }) as { id: string };
  await subscribe(sub, chan.id);
  await subscribe(sub, '#general');
  expect((await board.call(sub, 'list_channels', {}) as { subscribed: boolean }[])[0]!.subscribed).toBe(true);
  expect((await board.call(other, 'list_channels', {}) as { subscribed: boolean }[])[0]!.subscribed).toBe(false);
  await expect(board.call(sub, 'set_channel_subscription', { channel: chan.id, subscribed: true, actor: other.id })).rejects.toMatchObject({code: 'invalid'});
  await board.call(admin, 'post_message', { to: '#general', body: 'once' });
  const notes = await inbox(sub);
  expect(notes).toHaveLength(1); expect(notes[0]!.type).toBe('message');
  await board.call(sub, 'set_channel_subscription', { channel: chan.id, subscribed: false });
  board.store.snapshot(); board.close(); board = await open();
  await board.call(admin, 'post_message', { to: '#general', body: 'not subscribed' });
  expect(await inbox(sub)).toEqual([]);
  await expect(board.call(sub, 'set_channel_subscription', { channel: '@other', subscribed: true })).rejects.toMatchObject({code: 'invalid'});
});

test('admin foreign-DM writes are refused before message or notifications are created', async () => {
  const a = await agent('aa'); const b = await agent('bb'); const outsider = await agent('outsider');
  const chan = `dm:${[a.id,b.id].sort().join(':')}`;
  await expect(board.call(admin, 'post_message', { to: chan, body: '@all @outsider secret' })).rejects.toMatchObject({code: 'forbidden'});
  expect(await board.call(admin, 'read_messages', { from: chan })).toEqual([]);
  expect(await inbox(outsider)).toEqual([]); expect(await inbox(a)).toEqual([]); expect(await inbox(b)).toEqual([]);
});


test('DM write guard trims inputs and rejects malformed participant lists', async () => {
  const a = await agent('aa'); const b = await agent('bb');
  const foreign = `dm:${[a.id,b.id].sort().join(':')}`;
  await expect(board.call(admin, 'post_message', {to: `  ${foreign}  `, body: '@all private'})).rejects.toMatchObject({code:'forbidden'});
  for (const to of [`${foreign}:${admin.id}`, `dm:${admin.id}:${admin.id}`, `dm:${admin.id}:missing`]) {
    await expect(board.call(admin, 'post_message', {to, body:'no write'})).rejects.toMatchObject({code:'invalid'});
  }
  await board.call(a, 'post_message', {to:`dm:${b.id}:${a.id}`, body:'own conversation'});
  expect((await inbox(b)).map((n:any)=>n.text)).toEqual(['aa in @bb: own conversation']);
  expect(await inbox(a)).toEqual([]);
});


test('subscription mutations respect viewer and paused-agent permissions', async () => {
  const made = await board.call(admin, 'create_agent', { name: 'sub', kind: 'test' }) as { token: string };
  const a = board.agentOfToken(made.token)!;
  await board.call(admin, 'create_channel', { name: 'general' });
  const viewer = await board.createUser('viewer', 'test-password-123', 'viewer');
  await expect(board.call(viewer, 'set_channel_subscription', { channel: '#general', subscribed: true })).rejects.toMatchObject({ code: 'forbidden' });
  expect((await board.call(viewer, 'list_channels', {}) as { subscribed: boolean }[])[0]?.subscribed).toBe(false);
  await subscribe(a, '#general');
  await board.call(admin, 'pause_agent', { agent: a.id, reason: 'test pause' });
  const current = board.agentOfToken(made.token)!;
  expect(current.status).toBe('paused');
  await expect(board.call(current, 'set_channel_subscription', { channel: '#general', subscribed: false })).rejects.toMatchObject({ code: 'paused' });
});

test('subscription state and latest author coexist in channel and dashboard responses', async () => {
  const reader = await agent('reader');
  const writer = await agent('writer');
  await board.call(admin, 'create_channel', { name: 'merged' });
  await board.call(reader, 'set_channel_subscription', { channel: '#merged', subscribed: true });
  await board.call(writer, 'post_message', { to: '#merged', body: 'an ordinary message' });
  const channels = await board.call(reader, 'list_channels', {}) as { name: string; subscribed: boolean; last_author: string; messages: number }[];
  expect(channels.find(c => c.name === 'merged')).toMatchObject({ subscribed: true, last_author: writer.id, messages: 1 });
  const dashboard = await board.call(admin, 'dashboard', {}) as { channels: { name: string; subscribed: boolean; last_author: string }[] };
  expect(dashboard.channels.find(c => c.name === 'merged')).toMatchObject({ subscribed: false, last_author: writer.id });
});
