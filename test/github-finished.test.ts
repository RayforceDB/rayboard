// T-479: an item finished on GitHub does not sit on the board as open work nobody will ever decide.
// Going forward it comes in, or is closed, as GitHub closed it; the backlog from before is closed by reconcile_github.
import { beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BoardError, openBoard, type Actor, type Board } from '../src/board';
import { sharedRay, tempDir } from './helpers';

let board: Board;
let admin: Actor;
beforeEach(async () => {
  board = openBoard({ ray: await sharedRay(), base: join(tempDir(), 'board') });
  admin = await board.createUser('anton', 'correct horse battery');
  await board.call(admin, 'set_github_repos', { repos: 'RayforceDB/rayforce' });
});

const repository = { id: 101, full_name: 'RayforceDB/rayforce', private: false };
const issue = (n: number, updated: string, state = 'open') =>
  ({ node_id: `I_${n}`, number: n, html_url: `https://github.com/RayforceDB/rayforce/issues/${n}`, title: `Issue ${n}`, state, user: { login: 'reporter' }, updated_at: updated });
const pull = (n: number, updated: string, state = 'open', merged = false) =>
  ({ node_id: `PR_${n}`, number: n, html_url: `https://github.com/RayforceDB/rayforce/pull/${n}`, title: `PR ${n}`, state, merged, user: { login: 'dev' }, updated_at: updated, head: { sha: `sha${n}` } });
let d = 0;
const deliver = (event: string, payload: Record<string, unknown>) => board.githubDelivery(`d-${++d}`, event, { repository, ...payload });
const task = async (id: string) => ((await board.call(admin, 'get_task', { task: id })) as { task: { status: string; result: string; rev: number } }).task;
const agent = async (name: string) => board.agentOfToken(((await board.call(admin, 'create_agent', { name })) as { token: string }).token)!;

/** The board as it was before T-479: a task left open although its item is finished on GitHub. */
function finishLegacy(task: string, state: 'closed' | 'merged'): void {
  const g = board.store.all('gh_items').find((x) => x.task === task)!;
  const seq = board.store.seq() + 1;
  board.store.apply({ seq, ts: new Date().toISOString(), type: 'github.updated', actor: 'github', subject: task, summary: 'legacy', put: { gh_items: [{ ...g, state, updated: '2026-11-17T12:00:00Z' }] }, quiet: true });
}

test('an item already finished on GitHub comes in finished: merged and closed issues done, an unmerged closed PR cancelled', async () => {
  const merged = deliver('pull_request', { action: 'synced', pull_request: pull(1, '2026-11-17T10:00:00Z', 'closed', true) }).task!;
  const dropped = deliver('pull_request', { action: 'synced', pull_request: pull(2, '2026-11-17T10:00:00Z', 'closed') }).task!;
  const fixed = deliver('issues', { action: 'synced', issue: issue(3, '2026-11-17T10:00:00Z', 'closed') }).task!;
  const live = deliver('issues', { action: 'opened', issue: issue(4, '2026-11-17T10:00:00Z') }).task!;
  expect(await task(merged)).toMatchObject({ status: 'done', result: 'Merged on GitHub: https://github.com/RayforceDB/rayforce/pull/1' });
  expect(await task(dropped)).toMatchObject({ status: 'cancelled', result: 'Closed on GitHub without merging: https://github.com/RayforceDB/rayforce/pull/2' });
  expect(await task(fixed)).toMatchObject({ status: 'done', result: 'Closed on GitHub: https://github.com/RayforceDB/rayforce/issues/3' });
  expect((await task(live)).status).toBe('open');
  // Nothing finished before the board saw it is labelled on GitHub.
  expect(board.githubLabelTargets()).toEqual([]);
});

test('an item nobody took up is closed when GitHub closes it; one someone holds or spoke in stays theirs and they are told', async () => {
  const worker = await agent('worker');
  const free = deliver('issues', { action: 'opened', issue: issue(5, '2026-11-17T10:00:00Z') }).task!;
  const held = deliver('issues', { action: 'opened', issue: issue(6, '2026-11-17T10:00:00Z') }).task!;
  const talked = deliver('issues', { action: 'opened', issue: issue(7, '2026-11-17T10:00:00Z') }).task!;
  await board.call(worker, 'claim_task', { task: held });
  await board.call(worker, 'post_message', { to: talked, body: 'I will look at this' });
  await board.call(worker, 'inbox', {});
  for (const n of [5, 6, 7]) deliver('issues', { action: 'closed', issue: issue(n, '2026-11-17T12:00:00Z', 'closed') });
  expect(await task(free)).toMatchObject({ status: 'done', result: 'Closed on GitHub: https://github.com/RayforceDB/rayforce/issues/5' });
  expect((await task(held)).status).toBe('in_progress');
  expect((await task(talked)).status).toBe('open');
  const told = ((await board.call(worker, 'inbox', {})) as { items: { type: string; subject: string }[] }).items.filter((x) => x.type === 'github');
  expect(told.map((x) => x.subject)).toEqual([held]);
});

test('reconcile_github closes the backlog left open, after a dry run that changes nothing, and skips what someone took up', async () => {
  const worker = await agent('worker');
  const a = deliver('pull_request', { action: 'opened', pull_request: pull(10, '2026-11-17T10:00:00Z') }).task!;
  const b = deliver('pull_request', { action: 'opened', pull_request: pull(11, '2026-11-17T10:00:00Z') }).task!;
  const c = deliver('issues', { action: 'opened', issue: issue(12, '2026-11-17T10:00:00Z') }).task!;
  const held = deliver('issues', { action: 'opened', issue: issue(13, '2026-11-17T10:00:00Z') }).task!;
  const open = deliver('issues', { action: 'opened', issue: issue(14, '2026-11-17T10:00:00Z') }).task!;
  await board.call(worker, 'claim_task', { task: held });
  finishLegacy(a, 'merged');
  finishLegacy(b, 'closed');
  finishLegacy(c, 'closed');
  finishLegacy(held, 'closed');

  const dry = (await board.call(admin, 'reconcile_github', { dry_run: true })) as { done: number; cancelled: number; closed: { task: string; status: string }[]; skipped: { task: string; why: string }[] };
  expect(dry).toMatchObject({ dry_run: true, done: 2, cancelled: 1 });
  expect(dry.closed).toEqual([expect.objectContaining({ task: a, status: 'done' }), expect.objectContaining({ task: b, status: 'cancelled' }), expect.objectContaining({ task: c, status: 'done' })]);
  expect(dry.skipped).toEqual([expect.objectContaining({ task: held, why: 'in_progress' })]);
  expect((await task(a)).status).toBe('open');

  const real = (await board.call(admin, 'reconcile_github', { request_id: 'reconcile-1' })) as { done: number; cancelled: number };
  expect(real).toMatchObject({ dry_run: false, done: 2, cancelled: 1 });
  expect(await task(a)).toMatchObject({ status: 'done', result: 'Merged on GitHub: https://github.com/RayforceDB/rayforce/pull/10' });
  expect(await task(b)).toMatchObject({ status: 'cancelled', result: 'Closed on GitHub without merging: https://github.com/RayforceDB/rayforce/pull/11' });
  expect((await task(c)).status).toBe('done');
  expect((await task(held)).status).toBe('in_progress');
  expect((await task(open)).status).toBe('open');
  // One audit entry per task closed, each saying why.
  const log = (await board.call(admin, 'activity', {})) as { events: { type: string; subject: string; summary: string }[] } | { type: string; subject: string; summary: string }[];
  const events = Array.isArray(log) ? log : log.events;
  expect(events.filter((e) => e.summary.includes('as GitHub did')).map((e) => e.subject).sort()).toEqual([a, b, c].sort());
  // Run again: nothing left to do.
  expect(await board.call(admin, 'reconcile_github', {})).toMatchObject({ done: 0, cancelled: 0, closed: [] });
  // Closing them writes nothing back to GitHub.
  expect(board.githubLabelTargets().filter((x) => [a, b, c].some((t) => board.store.get('gh_items', x.item)?.task === t))).toEqual([]);
});

test('only an administrator may reconcile', async () => {
  const worker = await agent('worker');
  await expect(board.call(worker, 'reconcile_github', { dry_run: true })).rejects.toBeInstanceOf(BoardError);
  const member = await board.createUser('member', 'correct horse battery', 'member');
  await expect(board.call(member, 'reconcile_github', { dry_run: true })).rejects.toBeInstanceOf(BoardError);
});
