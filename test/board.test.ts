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
  // A person is an administrator, not an implicit substitute for the named reviewer.
  // Otherwise an agent asking a peer to check its work can be closed by any admin.
  await fails(board.call(admin, 'review_task', { task: 'T-1', verdict: 'approve' }), 'forbidden');
  expect(((await board.call(admin, 'list_reviews', { mine: true })) as unknown[]).length).toBe(0);
  const human = await board.call(admin, 'get_task', { task: 'T-1' }) as { task: { status: string } };
  expect(human.task.status).toBe('in_review');
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
  expect((await inbox(c)).every((n) => n.type !== "dm")).toBe(true);
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

test('a person can describe themself and upload a bounded avatar that survives restart', async () => {
  const about = 'Designing Rayfall and analytical engines.';
  await board.call(admin, 'set_profile', { about });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const url = board.setAvatar(admin.id, png, 'png');
  expect(board.avatar(admin.id)?.bytes.equals(png)).toBe(true);
  board.close();
  board = await open();
  const person = (await board.call(board.userById(admin.id)!, 'dashboard', {}) as any).people.find((p: any) => p.id === admin.id);
  expect(person).toMatchObject({ about, avatar: url });
  expect(board.avatar(admin.id)?.bytes.equals(png)).toBe(true);
  await board.call(board.userById(admin.id)!, 'set_profile', {});
  expect(((await board.call(board.userById(admin.id)!, 'dashboard', {})) as any).people.find((p: any) => p.id === admin.id).about).toBe('');
  board.clearAvatar(admin.id);
  expect(board.avatar(admin.id)).toBeNull();
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

test('an administrator deactivates a person without deleting identity or the last admin', async () => {
  const admin = board.userById(board.store.all('users').find((u) => u.name === 'anton')!.id as string)!;
  const person = await board.createUser('temporary-person', 'a sufficiently long password', 'member');
  await expect(board.call(admin, 'deactivate_person', { user: admin.id })).rejects.toMatchObject({ code: 'conflict' });
  const result = await board.call(admin, 'deactivate_person', { user: person.id }) as any;
  expect(result.status).toBe('deactivated');
  expect(board.userById(person.id)).toBeNull();
  expect(await board.login('temporary-person', 'a sufficiently long password')).toBeNull();
  expect(board.store.get('users', person.id)?.name).toBe('temporary-person');
  await expect(board.createUser('temporary-person', 'a sufficiently long password')).rejects.toMatchObject({ code: 'conflict' });
});

test('a board move keeps revision, permissions and independent review boundaries', async () => {
  const a = await agent('draggable');
  const t = await board.call(a.actor, 'create_task', { title: 'Drag me', outcome: 'It is verified', assignee: a.actor.id, review: 'required' }) as any;
  const claimed = await board.call(a.actor, 'claim_task', { task: t.id }) as any;
  const waiting = await board.call(a.actor, 'move_task', { task: t.id, status: 'waiting', note: 'Review tomorrow', rev: claimed.rev }) as any;
  expect(waiting.status).toBe('waiting');
  await expect(board.call(a.actor, 'move_task', { task: t.id, status: 'waiting', rev: claimed.rev, note: 'stale' })).rejects.toMatchObject({ code: 'conflict' });
  const progress = await board.call(a.actor, 'move_task', { task: t.id, status: 'in_progress', rev: waiting.rev }) as any;
  await board.call(a.actor, 'update_task', { task: t.id, rev: progress.rev, outcome: 'Evidence checked' });
  const updated = board.store.get('tasks', t.id)!;
  await expect(board.call(a.actor, 'move_task', { task: t.id, status: 'done', rev: updated.rev })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(board.call(a.actor, 'move_task', { task: t.id, status: 'in_review', rev: updated.rev, reviewer: a.actor.id })).rejects.toMatchObject({ code: 'invalid' });
  await board.call(a.actor, 'move_task', { task: t.id, status: 'in_review', rev: updated.rev });
  await expect(board.call(admin, 'move_task', { task: t.id, status: 'in_progress', rev: Number(updated.rev) + 1 })).rejects.toMatchObject({ code: 'conflict' });
  await board.call(admin, 'review_task', { task: t.id, verdict: 'approve', rev: Number(updated.rev) + 1 });
  expect(board.store.get('tasks', t.id)?.status).toBe('done');
});

test('@all reaches the active subscribers of a channel, never unsubscribed accounts or direct-message outsiders', async () => {
  const a = (await agent('author')).actor;
  const b = (await agent('reader')).actor;
  const c = (await agent('outsider')).actor;
  const lurker = (await agent('lurker')).actor;
  await board.call(a, 'create_channel', { name: 'all-hands' });
  // In a channel @all is everyone following it: its active subscribers (Anton's decision on T-13).
  for (const who of [a, b, c, admin]) await board.call(who, 'set_channel_subscription', { channel: '#all-hands', subscribed: true });
  const message = await board.call(a, 'post_message', { to: '#all-hands', body: 'Please see @all; #all-hands is a channel' }) as any;
  expect(message.mentions.split(' ')).toContain(b.id);
  expect(message.mentions.split(' ')).toContain(admin.id);
  expect(message.mentions.split(' ')).not.toContain(a.id);
  // An active agent who does not follow the channel is not woken by @all, though it has an account.
  expect(message.mentions.split(' ')).not.toContain(lurker.id);
  expect((await inbox(lurker)).some((n) => n.subject === message.chan)).toBe(false);
  expect((await inbox(b)).some((n) => n.subject === message.chan && n.type === 'mention')).toBe(true);
  expect((await inbox(admin)).some((n) => n.subject === message.chan)).toBe(true);
  // A person named directly is still told, subscribed or not.
  const named = await board.call(a, 'post_message', { to: '#all-hands', body: '@all and @lurker' }) as any;
  expect(named.mentions.split(' ')).toContain(lurker.id);
  await board.call(admin, 'pause_agent', { agent: c.id, reason: 'offline test' });
  const second = await board.call(a, 'post_message', { to: '#all-hands', body: '@all again' }) as any;
  expect(second.mentions.split(' ')).not.toContain(c.id);
  const dm = await board.call(a, 'post_message', { to: '@reader', body: '@all stays between us with no third party' }) as any;
  expect(dm.mentions.split(' ')).toEqual([b.id]);
  expect((await inbox(c)).every((n) => n.type !== "dm")).toBe(true);
  expect((await inbox(c)).every((n) => n.type !== "dm")).toBe(true);
});

test('nobody can be named all, because @all already names everyone a message reaches', async () => {
  await fails(board.call(admin, 'create_agent', { name: 'all' }), 'invalid');
  await fails(board.call(admin, 'create_agent', { name: 'ALL' }), 'invalid');
  await fails(board.createUser('all', 'correct horse battery'), 'invalid');
  const { key } = (await board.call(admin, 'new_enrollment_key', {})) as { key: string };
  await fails((async () => board.register(key, { name: 'all' }))(), 'invalid');
  const member = await board.createUser('member', 'correct horse battery', 'member');
  await fails(board.call(admin, 'rename_person', { user: member.id, name: 'all' }), 'invalid');
  await board.call(admin, 'create_agent', { name: 'allison' });
  await board.call(admin, 'create_channel', { name: 'all' });
});

test('the dashboard says who last touched each task and channel, so nobody is told of their own change', async () => {
  const a = (await agent('worker')).actor;
  const t = (await board.call(admin, 'create_task', { outcome: 'x', title: 'Watched', assignee: a.id })) as { id: string };
  await board.call(admin, 'create_channel', { name: 'general' });
  const row = async () => ((await board.call(admin, 'dashboard', {})) as any).tasks.find((x: any) => x.id === t.id);
  expect((await row()).last_author).toBe(admin.id);
  const comment = (await board.call(a, 'post_message', { to: t.id, body: 'on it' })) as { seq: number };
  expect(await row()).toMatchObject({ last: comment.seq, last_author: a.id });
  await board.call(a, 'add_evidence', { task: t.id, text: 'commit abc' });
  const after = await row();
  expect(after.last).toBeGreaterThan(comment.seq);
  expect(after.last_author).toBe(a.id);
  await board.call(admin, 'post_message', { to: '#general', body: 'hello' });
  expect(((await board.call(admin, 'dashboard', {})) as any).channels[0].last_author).toBe(admin.id);
});

test('storage and contract guards from the T-15 audit', async () => {
  const a = (await agent('reporter')).actor;
  await fails(board.call(admin, 'create_task', { title: 'a\uD800b', outcome: 'x' }), 'invalid');
  await fails(board.call(a, 'report_cost', { usd: 1, tokens_in: Number.MAX_SAFE_INTEGER }), 'invalid');
  // Task ids come from the highest id, not a row count.
  await board.call(admin, 'create_task', { title: 'one', outcome: 'x' });
  await board.call(admin, 'create_task', { title: 'two', outcome: 'x' });
  expect(((await board.call(admin, 'create_task', { title: 'three', outcome: 'x' })) as { id: string }).id).toBe('T-3');
});

test('a log without its snapshot is refused instead of opening part of the board', async () => {
  const { rmSync } = await import('node:fs');
  await board.call(admin, 'create_task', { title: 'kept', outcome: 'x' });
  board.close();
  board = await open();
  await board.call(admin, 'create_task', { title: 'after restart', outcome: 'x' });
  board.close();
  rmSync(`${base}.qdb`);
  await expect(open()).rejects.toThrow(/snapshot is missing/);
  board = await (async () => { const { writeFileSync } = await import('node:fs'); writeFileSync(`${base}.log`, ''); return open(); })();
});
