// Regressions from the T-15 audit: board rules and private-task confidentiality.
import { beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BoardError, openBoard, type Actor, type Board } from '../src/board';
import { sharedRay, tempDir } from './helpers';

let board: Board;
let admin: Actor;
let clock: number;
beforeEach(async () => {
  const base = join(tempDir(), 'board');
  clock = Date.UTC(2026, 10, 16, 12);
  board = openBoard({ ray: await sharedRay(), base, now: () => new Date((clock += 1000)) });
  admin = await board.createUser('anton', 'correct horse battery');
});
async function agent(name: string): Promise<Actor> {
  const made = (await board.call(admin, 'create_agent', { name })) as { token: string };
  return board.agentOfToken(made.token)!;
}
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: unknown) => (e instanceof BoardError ? e.code : String(e)));
type T = { task: { status: string; rev: number } };
const rev = async (a: Actor, id: string): Promise<number> => ((await board.call(a, 'get_task', { task: id })) as T).task.rev;
const status = async (id: string): Promise<string> => ((await board.call(admin, 'get_task', { task: id })) as T).task.status;

test('a member who is no party sees nothing of a private task in activity', async () => {
  const a = await agent('alpha');
  const member = await board.createUser('mia', 'correct horse battery', 'member');
  await board.call(a, 'create_task', { title: 'SECRET-TITLE', outcome: 'x', private: true });
  await board.call(a, 'post_message', { to: 'T-1', body: 'SECRET-COMMENT' });
  // the member cannot see the task itself...
  expect(await code(board.call(member, 'get_task', { task: 'T-1' }))).toBe('not_found');
  // ...but its history is in the audit log for them
  const log = JSON.stringify(await board.call(member, 'activity', {}));
  expect(log).not.toContain('SECRET-TITLE');
  expect(log).not.toContain('SECRET-COMMENT');
});

test('whoever holds a task cannot approve it, even when another moved it to review', async () => {
  const lead = await agent('lead');
  const dev = await agent('dev');
  await board.call(lead, 'create_task', { title: 'w', outcome: 'x', assignee: 'dev' });
  await board.call(dev, 'claim_task', { task: 'T-1' });
  await board.call(lead, 'move_task', { task: 'T-1', status: 'in_review', rev: await rev(lead, 'T-1') });
  const mine = (await board.call(dev, 'list_reviews', { mine: true })) as unknown[];
  expect(mine.length).toBe(0); // dev did the work; it must not be offered to dev
  expect(await code(board.call(dev, 'review_task', { task: 'T-1', verdict: 'approve' }))).toBe('forbidden');
});

test('the holder cannot be named reviewer of their own task from the board', async () => {
  const dev = await agent('dev');
  await board.call(admin, 'create_task', { title: 'w', outcome: 'x', assignee: 'dev' });
  await board.call(dev, 'claim_task', { task: 'T-1' });
  expect(await code(board.call(admin, 'move_task', { task: 'T-1', status: 'in_review', reviewer: 'dev', rev: await rev(admin, 'T-1') }))).not.toBe('ok');
  if ((await status('T-1')) === 'in_review') expect(await code(board.call(dev, 'review_task', { task: 'T-1', verdict: 'approve' }))).toBe('forbidden');
});

test('a person cannot skip a required review with complete_task', async () => {
  const dev = await agent('dev');
  await agent('qa');
  await board.call(admin, 'create_task', { title: 'w', outcome: 'x', assignee: 'dev' });
  await board.call(dev, 'claim_task', { task: 'T-1' });
  await board.call(dev, 'request_review', { task: 'T-1', reviewer: 'qa', note: 'n' });
  // the same admin is refused by review_task and by move_task(done)...
  expect(await code(board.call(admin, 'review_task', { task: 'T-1', verdict: 'approve' }))).toBe('forbidden');
  expect(await code(board.call(admin, 'move_task', { task: 'T-1', status: 'done', rev: await rev(admin, 'T-1') }))).toBe('forbidden');
  // ...but complete_task closes it anyway
  expect(await code(board.call(admin, 'complete_task', { task: 'T-1', result: 'r' }))).toBe('forbidden');
});

test('a member cannot complete their own required-review task without a review', async () => {
  const member = await board.createUser('mia', 'correct horse battery', 'member');
  await board.call(member, 'create_task', { title: 'w', outcome: 'x', assignee: 'mia' });
  await board.call(member, 'claim_task', { task: 'T-1' });
  expect(await code(board.call(member, 'complete_task', { task: 'T-1', result: 'mine' }))).toBe('forbidden');
});

test('agents cannot reopen done work or undo a cancellation by another through move_task', async () => {
  const lead = await agent('lead');
  const dev = await agent('dev');
  const qa = await agent('qa');
  await board.call(lead, 'create_task', { title: 'w', outcome: 'x', assignee: 'dev' });
  await board.call(dev, 'claim_task', { task: 'T-1' });
  await board.call(dev, 'request_review', { task: 'T-1', reviewer: 'qa', note: 'n' });
  await board.call(qa, 'review_task', { task: 'T-1', verdict: 'approve' });
  expect(await code(board.call(dev, 'reopen_task', { task: 'T-1' }))).toBe('forbidden'); // people only
  expect(await code(board.call(dev, 'move_task', { task: 'T-1', status: 'open', rev: await rev(dev, 'T-1') }))).toBe('forbidden');

  await board.call(lead, 'create_task', { title: 'w2', outcome: 'x', assignee: 'dev' });
  await board.call(lead, 'cancel_task', { task: 'T-2', reason: 'not wanted' });
  expect(await code(board.call(dev, 'move_task', { task: 'T-2', status: 'open', rev: await rev(dev, 'T-2') }))).toBe('forbidden');
});

test('a task in review cannot be parked as waiting with its review left pending', async () => {
  const dev = await agent('dev');
  const qa = await agent('qa');
  await board.call(admin, 'create_task', { title: 'w', outcome: 'x', assignee: 'dev' });
  await board.call(dev, 'claim_task', { task: 'T-1' });
  await board.call(dev, 'request_review', { task: 'T-1', reviewer: 'qa', note: 'first' });
  const r = await code(board.call(dev, 'move_task', { task: 'T-1', status: 'waiting', note: 'later', rev: await rev(dev, 'T-1') }));
  if (r === 'ok') {
    await board.call(dev, 'claim_task', { task: 'T-1' });
    await board.call(dev, 'request_review', { task: 'T-1', reviewer: 'qa', note: 'second' });
    await board.call(qa, 'review_task', { task: 'T-1', verdict: 'approve' });
    expect(await status('T-1')).toBe('done');
    const pending = (await board.call(admin, 'list_reviews', {})) as { task: string; note: string }[];
    expect(pending).toEqual([]); // the 'first' review of a done task is still listed as pending
  }
});

test('a public subtask does not name a private parent its reader may not see', async () => {
  const a = await agent('alpha');
  const b = await agent('beta');
  await board.call(a, 'create_task', { title: 'secret', outcome: 'x', private: true });
  await board.call(a, 'create_task', { title: 'part', outcome: 'x', parent: 'T-1' });
  expect(await code(board.call(b, 'get_task', { task: 'T-1' }))).toBe('not_found');
  const sub = (await board.call(b, 'get_task', { task: 'T-2' })) as { task: { parent: string } };
  expect(sub.task.parent).toBe('');
});

test('agents cannot rewrite a task once it is done', async () => {
  const dev = await agent('dev');
  const qa = await agent('qa');
  await board.call(dev, 'create_task', { title: 'w', outcome: 'tests pass', assignee: 'dev' });
  await board.call(dev, 'claim_task', { task: 'T-1' });
  await board.call(dev, 'request_review', { task: 'T-1', reviewer: 'qa', note: 'n' });
  await board.call(qa, 'review_task', { task: 'T-1', verdict: 'approve' });
  expect(await code(board.call(dev, 'update_task', { task: 'T-1', rev: await rev(dev, 'T-1'), outcome: 'nothing' }))).not.toBe('ok');
});

// --- probes expected to hold ---
test('a hidden private task looks like a missing one on every path for an outsider', async () => {
  const a = await agent('alpha');
  const out = await agent('outsider');
  await board.call(a, 'create_task', { title: 'SECRET', outcome: 'x', private: true });
  await board.call(a, 'post_message', { to: 'T-1', body: 'SECRET body @all @outsider' });
  for (const [act, p] of [
    ['get_task', { task: 'T-1' }], ['read_messages', { from: 'T-1' }], ['activity', { subject: 'T-1' }],
    ['claim_task', { task: 'T-1' }], ['post_message', { to: 'T-1', body: 'x' }], ['add_evidence', { task: 'T-1', text: 'x' }],
    ['report_cost', { usd: 1, task: 'T-1' }], ['list_tasks', { parent: 'T-1' }], ['create_task', { title: 't', outcome: 'o', parent: 'T-1' }],
    ['review_task', { task: 'T-1', verdict: 'approve' }], ['cancel_task', { task: 'T-1' }],
  ] as const) {
    const err = await board.call(out, act, p).then(() => null, (e: BoardError) => e);
    expect([act, err?.code, err?.message]).toEqual([act, 'not_found', 'there is no task T-1']);
  }
  const everything = JSON.stringify([
    await board.call(out, 'list_tasks', { status: 'all' }), await board.call(out, 'activity', {}), await board.call(out, 'activity', { after: 0 }),
    await board.call(out, 'list_reviews', {}), await board.call(out, 'inbox', {}), await board.call(out, 'costs', {}),
  ]);
  expect(everything).not.toContain('SECRET');
  expect(await code(board.call(out, 'report_cost', { usd: -1 }))).toBe('invalid');
});
