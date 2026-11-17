import { beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BoardError, openBoard, type Actor, type Board } from '../src/board';
import { sharedRay, tempDir } from './helpers';

let board: Board;
let base: string;
let admin: Actor;
let clock: number;
const open = async (): Promise<Board> => openBoard({ ray: await sharedRay(), base, now: () => new Date((clock += 1000)) });

beforeEach(async () => {
  base = join(tempDir(), 'board');
  clock = Date.UTC(2026, 10, 16, 12);
  board = await open();
  admin = await board.createUser('anton', 'correct horse battery');
});

async function agent(name: string, budget = 0): Promise<{ actor: Actor; token: string }> {
  const made = (await board.call(admin, 'create_agent', { name, budget })) as { token: string };
  return { actor: board.agentOfToken(made.token)!, token: made.token };
}
const fails = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(BoardError);
  expect((err as BoardError).code as string).toBe(code);
};
const inbox = async (a: Actor): Promise<{ type: string; subject: string; text: string }[]> => ((await board.call(a, 'inbox', {})) as { items: never[] }).items;

test('inbox can acknowledge a delivered boundary without consuming a newer note', async () => {
  const a = (await agent('reader')).actor;
  const b = (await agent('other')).actor;
  await board.call(admin, 'create_task', { outcome: 'x', title: 'First', assignee: a.id });
  const first = (await board.call(a, 'inbox', { peek: true })) as { items: { seq: number }[] };
  const through = first.items[0]!.seq;
  await board.call(admin, 'create_task', { outcome: 'x', title: 'Second', assignee: a.id });
  await board.call(a, 'inbox', { through });
  await board.call(a, 'inbox', { through });
  await fails(board.call(a, 'inbox', { through: through + 2 }), 'invalid');
  await fails(board.call(b, 'inbox', { through }), 'invalid');
  const later = (await board.call(a, 'inbox', { peek: true })) as { items: { seq: number; text: string }[] };
  expect(later.items.map(n => n.text)).toEqual(['anton gave you T-2: Second']);
  board.close(); board = await open();
  expect(((await board.call(a, 'inbox', { peek: true })) as { items: { seq: number }[] }).items.map(n => n.seq)).toEqual([through + 1]);
  await board.call(a, 'inbox', { through: through + 1 });
  expect(await inbox(a)).toEqual([]);
});

test('a task is delegated, done, reviewed by another and approved', async () => {
  const lead = (await agent('lead')).actor;
  const dev = (await agent('dev')).actor;
  const qa = (await agent('qa')).actor;
  const t = (await board.call(lead, 'create_task', { outcome: 'it can be seen to work', title: 'Fix the parser', assignee: 'dev' })) as { id: string };
  expect(t.id).toBe('T-1');
  expect((await inbox(dev)).map((n) => n.type)).toEqual(['task.assigned']);
  expect(await inbox(dev)).toEqual([]);

  await fails(board.call(qa, 'claim_task', { task: 'T-1' }), 'conflict');
  await board.call(dev, 'claim_task', { task: 't-1' });
  await fails(board.call(dev, 'complete_task', { task: 'T-1', result: 'done' }), 'forbidden');
  await fails(board.call(dev, 'request_review', { task: 'T-1', reviewer: 'dev', note: 'done' }), 'invalid');
  await board.call(dev, 'request_review', { task: 'T-1', reviewer: 'qa', note: 'see the branch' });
  await fails(board.call(dev, 'review_task', { task: 'T-1', verdict: 'approve' }), 'forbidden');
  await fails(board.call(lead, 'review_task', { task: 'T-1', verdict: 'approve' }), 'forbidden');
  await fails(board.call(qa, 'review_task', { task: 'T-1', verdict: 'request_changes' }), 'invalid');
  await board.call(qa, 'review_task', { task: 'T-1', verdict: 'request_changes', comment: 'no test' });
  expect((await inbox(dev)).map((n) => n.type)).toEqual(['review.changes_requested']);
  await board.call(dev, 'claim_task', { task: 'T-1' });
  await board.call(dev, 'request_review', { task: 'T-1', note: 'test added' });
  expect(((await board.call(qa, 'list_reviews', { mine: true })) as unknown[]).length).toBe(1);
  expect(((await board.call(dev, 'list_reviews', { mine: true })) as unknown[]).length).toBe(0);
  await board.call(qa, 'review_task', { task: 'T-1', verdict: 'approve' });
  const detail = (await board.call(lead, 'get_task', { task: 'T-1' })) as { task: { status: string; result: string }; reviews: unknown[] };
  expect(detail.task.status).toBe('done');
  expect(detail.task.result).toBe('test added');
  expect(detail.reviews.length).toBe(2);
  expect((await inbox(lead)).map((n) => n.type)).toContain('task.done');
});

test('two agents cannot both claim one task, and a subtask reports to the holder of its parent', async () => {
  const a = (await agent('aa')).actor;
  const b = (await agent('bb')).actor;
  await board.call(admin, 'create_task', { outcome: 'it can be seen to work', title: 'Open work', review: 'optional' });
  await board.call(a, 'claim_task', { task: 'T-1' });
  await fails(board.call(b, 'claim_task', { task: 'T-1' }), 'conflict');
  await board.call(a, 'create_task', { outcome: 'it can be seen to work', title: 'A part', parent: 'T-1', assignee: 'bb', review: 'optional' });
  await board.call(b, 'claim_task', { task: 'T-2' });
  await board.call(b, 'complete_task', { task: 'T-2', result: 'ok' });
  expect((await inbox(a)).map((n) => n.type)).toEqual(['task.claimed', 'task.done']);
  expect(((await board.call(a, 'list_tasks', { parent: 'T-1', status: 'all' })) as unknown[]).length).toBe(1);
});

test('messages reach channels, direct conversations and mentions, and a direct conversation is closed to others', async () => {
  const a = (await agent('aa')).actor;
  const b = (await agent('bb')).actor;
  const c = (await agent('cc')).actor;
  await board.call(a, 'create_channel', { name: 'general' });
  await board.call(a, 'post_message', { to: '#general', body: 'hello @bb, and (exit 1) "quoted"' });
  await board.call(a, 'post_message', { to: '@bb', body: 'between us' });
  expect((await inbox(b)).map((n) => n.type)).toEqual(['mention', 'dm']);
  expect(await inbox(c)).toEqual([]);
  const seenByB = (await board.call(b, 'read_messages', { from: '@aa' })) as { body: string }[];
  expect(seenByB.map((m) => m.body)).toEqual(['between us']);
  expect(await board.call(c, 'read_messages', { from: '@aa' })).toEqual([]);
  const general = (await board.call(c, 'read_messages', { from: 'general' })) as { body: string; seq: number }[];
  expect(general[0]!.body).toBe('hello @bb, and (exit 1) "quoted"');
  expect(await board.call(c, 'read_messages', { from: '#general', after: general[0]!.seq })).toEqual([]);
});

test('an agent that asks to join can only read until a person approves it', async () => {
  await fails((async () => board.register('rbe_wrong', { name: 'newbie' }))(), 'unauthorized');
  const { key } = (await board.call(admin, 'new_enrollment_key', {})) as { key: string };
  const { token } = board.register(key, { name: 'newbie', about: 'writes docs' });
  const pending = board.agentOfToken(token)!;
  expect(pending.status).toBe('pending');
  await board.call(pending, 'list_tasks', {});
  await fails(board.call(pending, 'create_task', { outcome: 'it can be seen to work', title: 'x' }), 'paused');
  await fails(board.call(pending, 'approve_agent', { agent: 'newbie' }), 'forbidden');
  await board.call(admin, 'approve_agent', { agent: 'newbie' });
  await board.call(board.agentOfToken(token)!, 'create_task', { outcome: 'it can be seen to work', title: 'x' });
  await board.call(admin, 'revoke_agent', { agent: 'newbie' });
  expect(board.agentOfToken(token)).toBeNull();
});

test('an agent is paused at its budget, and a rotated token replaces the old one', async () => {
  const { actor, token } = await agent('spender', 10);
  expect(await board.call(actor, 'report_cost', { usd: 5 })).toMatchObject({ spent_this_month: 5, paused: false });
  await board.call(actor, 'report_cost', { usd: 4 });
  expect((await inbox(actor)).map((n) => n.type)).toEqual(['budget.warning']);
  expect(await board.call(actor, 'report_cost', { usd: 2 })).toMatchObject({ spent_this_month: 11, paused: true });
  await fails(board.call(board.agentOfToken(token)!, 'create_task', { outcome: 'it can be seen to work', title: 'x' }), 'paused');
  await board.call(admin, 'set_budget', { agent: 'spender', usd: 100 });
  await board.call(admin, 'resume_agent', { agent: 'spender' });
  await board.call(board.agentOfToken(token)!, 'create_task', { outcome: 'it can be seen to work', title: 'x' });
  const { token: fresh } = (await board.call(admin, 'rotate_token', { agent: 'spender' })) as { token: string };
  expect(board.agentOfToken(token)).toBeNull();
  expect(board.agentOfToken(fresh)!.name).toBe('spender');
  const costs = (await board.call(admin, 'costs', {})) as { month: { usd: number }[]; days: { day: string }[] };
  expect(costs.month[0]!.usd).toBe(11);
  expect(costs.days[0]!.day).toBe('2026-11-16');
});

test('the board is the same after a restart, and logins hold', async () => {
  const { token } = await agent('aa');
  await board.call(board.agentOfToken(token)!, 'create_task', { outcome: 'it can be seen to work', title: 'Survives' });
  const before = await board.call(admin, 'dashboard', {});
  board.close();
  board = await open();
  const after = (await board.call(admin, 'dashboard', {})) as Record<string, unknown>;
  expect({ ...after, now: 0, agents: 0 }).toEqual({ ...(before as object), now: 0, agents: 0 });
  expect(board.agentOfToken(token)!.name).toBe('aa');
  expect(await board.login('anton', 'correct horse battery')).toMatchObject({ name: 'anton' });
  expect(await board.login('anton', 'wrong password!')).toBeNull();
  expect(await board.login('nobody', 'correct horse battery')).toBeNull();
  expect(((await board.call(admin, 'create_task', { outcome: 'it can be seen to work', title: 'Next' })) as { id: string }).id).toBe('T-2');
});

test('parameters that do not fit are refused before anything runs', async () => {
  await fails(board.call(admin, 'create_task', {}), 'invalid');
  await fails(board.call(admin, 'create_task', { outcome: 'it can be seen to work', title: 'x', nope: 1 }), 'invalid');
  await fails(board.call(admin, 'create_task', { outcome: 'it can be seen to work', title: 'x', priority: 9 }), 'invalid');
  await fails(board.call(admin, 'get_task', { task: "T-1') (exit 1" }), 'invalid');
  await fails(board.call(admin, 'toString', {}), 'not_found');
  await fails(board.call(admin, 'inbox', { wait: 500 }), 'invalid');
});

test('an inbox that waits is answered when something arrives', async () => {
  const a = (await agent('aa')).actor;
  const waiting = board.call(a, 'inbox', { wait: 5 }) as Promise<{ items: { type: string }[] }>;
  await board.call(admin, 'post_message', { to: '@aa', body: 'wake up' });
  expect((await waiting).items.map((n) => n.type)).toEqual(['dm']);
});

test('a lost password is replaced from the console, and the reset is in the audit log', async () => {
  const fresh = await board.resetPassword('Anton');
  expect(await board.login('anton', 'correct horse battery')).toBeNull();
  expect(await board.login('anton', fresh)).toMatchObject({ name: 'anton' });
  expect(JSON.stringify(await board.call(admin, 'activity', {}))).toContain('user.password_reset');
  await fails(board.resetPassword('nobody'), 'not_found');
});

test('the dashboard counts each task thread, and activity can be read for one task, as private as the task', async () => {
  const a = (await agent('alpha')).actor;
  const b = (await agent('beta')).actor;
  await board.call(admin, 'create_task', { outcome: 'x', title: 'Open one' });
  await board.call(admin, 'create_task', { outcome: 'x', title: 'Hidden one', private: true, assignee: a.id });
  await board.call(a, 'post_message', { to: 'T-1', body: 'first' });
  await board.call(admin, 'post_message', { to: 'T-1', body: 'second' });
  await board.call(a, 'claim_task', { task: 'T-2' });
  const snap = (await board.call(admin, 'dashboard', {})) as { threads: { chan: string; n: number }[] };
  expect(snap.threads.map((r) => [r.chan, Number(r.n)])).toEqual([['T-1', 2]]);
  const events = (await board.call(admin, 'activity', { subject: 'T-2' })) as { subject: string; type: string }[];
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((e) => e.subject === 'T-2')).toBe(true);
  expect(events[0]!.type).toBe('task.claimed');
  await fails(board.call(b, 'activity', { subject: 'T-2' }), 'not_found');
});

test('people join by a one-time invitation, with roles and privacy that survive a restart', async () => {
  const made = (await board.call(admin, 'invite_person', {})) as { key: string; role: string; expires: string };
  expect(made.role).toBe('member');
  expect(made.key).toStartWith('rbi_');
  expect(JSON.stringify(await board.call(admin, 'dashboard', {}))).not.toContain(made.key);
  const member = await board.acceptInvite(made.key, 'colleague', 'a private passphrase');
  expect(member).toMatchObject({ kind: 'user', role: 'member' });
  expect(await board.login('colleague', 'a private passphrase')).toMatchObject({ role: 'member' });
  await fails(board.acceptInvite(made.key, 'second', 'a private passphrase'), 'unauthorized');
  await fails(board.call(member, 'create_agent', { name: 'not-allowed' }), 'forbidden');
  await fails(board.call(member, 'invite_person', {}), 'forbidden');
  await fails(board.call(member, 'set_role', { user: 'colleague', role: 'admin' }), 'forbidden');
  await board.call(member, 'create_task', { title: 'Shared work', outcome: 'done', review: 'optional' });
  await board.call(admin, 'create_task', { title: 'Private work', outcome: 'hidden', private: true });
  await fails(board.call(member, 'get_task', { task: 'T-2' }), 'not_found');
  expect(((await board.call(member, 'dashboard', {})) as { tasks: { id: string }[] }).tasks.map((t) => t.id)).not.toContain('T-2');
  expect(((await board.call(member, 'list_tasks', { status: 'all' })) as { id: string }[]).map((t) => t.id)).not.toContain('T-2');
  await fails(board.call(member, 'read_messages', { from: `dm:${admin.id}:u_somebody` }), 'forbidden');

  const viewerInvite = (await board.call(admin, 'invite_person', { role: 'viewer' })) as { key: string };
  const viewer = await board.acceptInvite(viewerInvite.key, 'observer', 'another passphrase');
  await fails(board.call(viewer, 'post_message', { to: 'T-1', body: 'not allowed' }), 'forbidden');
  await fails(board.call(viewer, 'complete_task', { task: 'T-1', result: 'not allowed' }), 'forbidden');
  expect(await board.call(viewer, 'get_task', { task: 'T-1' })).toBeTruthy();
  await fails(board.call(admin, 'set_role', { user: 'anton', role: 'viewer' }), 'conflict');

  const [a, b] = (await Promise.all([board.call(admin, 'invite_person', {}), board.call(admin, 'invite_person', {})])) as { key: string }[];
  const parallel = await Promise.allSettled([
    board.acceptInvite(a.key, 'parallel-a', 'a private passphrase'),
    board.acceptInvite(a.key, 'parallel-b', 'a private passphrase'),
  ]);
  expect(parallel.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(parallel.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const unused = (await board.call(admin, 'revoke_invite', { invite: 'invite:' + (await import('node:crypto')).createHash('sha256').update(b.key).digest('hex') })) as { ok: boolean };
  expect(unused.ok).toBe(true);
  await fails(board.acceptInvite(b.key, 'revoked', 'a private passphrase'), 'unauthorized');

  const before = await board.call(admin, 'dashboard', {});
  board.close(); board = await open();
  expect(await board.login('colleague', 'a private passphrase')).toMatchObject({ role: 'member' });
  expect(await board.login('observer', 'another passphrase')).toMatchObject({ role: 'viewer' });
  expect(await board.login('anton', 'correct horse battery')).toMatchObject({ role: 'admin' });
  expect({ ...((await board.call(admin, 'dashboard', {})) as object), now: 0 }).toEqual({ ...(before as object), now: 0 });
  await fails(board.call(board.userById(member.id)!, 'create_agent', { name: 'still-not-allowed' }), 'forbidden');
});
