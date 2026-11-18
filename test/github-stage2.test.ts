// GitHub sync, stage 2 read side (T-446): a pull request's head, the issues it closes, its checks and its reviews.
import { beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openBoard, type Actor, type Board } from '../src/board';
import { closesIn } from '../src/github';
import { sharedRay, tempDir } from './helpers';

let board: Board;
let admin: Actor;
beforeEach(async () => {
  board = openBoard({ ray: await sharedRay(), base: join(tempDir(), 'board') });
  admin = await board.createUser('anton', 'correct horse battery');
  await board.call(admin, 'set_github_repos', { repos: 'RayforceDB/rayforce' });
});

const repository = { id: 101, full_name: 'RayforceDB/rayforce', private: false };
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
let n = 0;
const deliver = (event: string, payload: Record<string, unknown>) => board.githubDelivery(`d-${++n}`, event, { repository, ...payload });
const pr = (number: number, updated: string, extra: Record<string, unknown> = {}) =>
  ({ node_id: `PR_${number}`, number, html_url: `https://github.com/RayforceDB/rayforce/pull/${number}`, title: 'A change', state: 'open', user: { login: 'dev' }, updated_at: updated, head: { sha: SHA }, body: 'Fixes #3 and closes #4.', ...extra });
const issue = (number: number) => ({ node_id: `I_${number}`, number, html_url: `https://github.com/RayforceDB/rayforce/issues/${number}`, title: 'A bug', state: 'open', user: { login: 'r' }, updated_at: '2026-11-18T09:00:00Z' });
const run = (name: string, status: string, conclusion: string | null, at: string, sha = SHA, prs = [10]) =>
  ({ action: status === 'completed' ? 'completed' : 'created', check_run: { name, status, conclusion, head_sha: sha, completed_at: status === 'completed' ? at : null, started_at: at, pull_requests: prs.map((number) => ({ number })) } });
const github = async () => ((await board.call(admin, 'dashboard', {})) as { github: { number: number; checks: string; review: string; head: string; closes: number[]; closed_by: number[] }[] }).github;
const of = async (number: number) => (await github()).find((g) => g.number === number)!;

test('the closing keywords GitHub knows are read from a description', () => {
  expect(closesIn('Fixes #3 and closes #4. Resolved: #9; fixed #3 again. See #5. prefix#6')).toEqual([3, 4, 9]);
  expect(closesIn('')).toEqual([]);
});

test('a pull request shows its head, the issues it closes, and each issue shows the pull request', async () => {
  deliver('issues', { action: 'opened', issue: issue(3) });
  deliver('pull_request', { action: 'opened', pull_request: pr(10, '2026-11-18T10:00:00Z') });
  expect(await of(10)).toMatchObject({ head: SHA, closes: [3, 4], checks: 'none', review: 'none' });
  expect((await of(3)).closed_by).toEqual([10]);
  // A delivery without a description (the issues API) keeps what the last one said.
  deliver('pull_request', { action: 'edited', pull_request: { ...pr(10, '2026-11-18T10:05:00Z'), head: undefined, body: undefined } });
  expect(await of(10)).toMatchObject({ head: SHA, closes: [3, 4] });
});

test('checks come to pending, then failure, which wakes the holder once; a new head starts over', async () => {
  const agent = board.agentOfToken(((await board.call(admin, 'create_agent', { name: 'worker' })) as { token: string }).token)!;
  const t = deliver('pull_request', { action: 'opened', pull_request: pr(10, '2026-11-18T10:00:00Z') }).task!;
  await board.call(agent, 'claim_task', { task: t });
  await board.call(agent, 'inbox', {});
  deliver('check_run', run('build', 'in_progress', null, '2026-11-18T10:01:00Z'));
  deliver('check_run', run('test', 'completed', 'success', '2026-11-18T10:02:00Z'));
  expect((await of(10)).checks).toBe('pending');
  deliver('check_run', run('build', 'completed', 'failure', '2026-11-18T10:03:00Z'));
  expect((await of(10)).checks).toBe('failure');
  // An older delivery of the same run does not undo its outcome.
  expect(deliver('check_run', run('build', 'in_progress', null, '2026-11-18T10:01:30Z')).result).toBe('ignored');
  expect((await of(10)).checks).toBe('failure');
  const notes = ((await board.call(agent, 'inbox', {})) as { items: { text: string }[] }).items.map((x) => x.text);
  expect(notes).toEqual([expect.stringContaining('Checks failed on GitHub rayforce#10 (build)')]);
  // A push moves the head: its checks are counted afresh.
  deliver('pull_request', { action: 'synchronize', pull_request: { ...pr(10, '2026-11-18T10:10:00Z'), head: { sha: SHA2 } } });
  expect(await of(10)).toMatchObject({ head: SHA2, checks: 'none' });
  deliver('check_run', run('build', 'completed', 'success', '2026-11-18T10:11:00Z', SHA2));
  deliver('check_run', run('test', 'completed', 'success', '2026-11-18T10:11:00Z', SHA2));
  expect((await of(10)).checks).toBe('success');
  expect(((await board.call(agent, 'inbox', {})) as { items: unknown[] }).items).toEqual([]);
});

test('a check that arrives before its pull request is counted once the pull request is known', async () => {
  deliver('check_run', run('build', 'completed', 'success', '2026-11-18T10:01:00Z'));
  deliver('pull_request', { action: 'opened', pull_request: pr(10, '2026-11-18T10:00:00Z') });
  expect((await of(10)).checks).toBe('success');
});

test('reviews: each reviewer\'s latest verdict counts, changes requested outweigh approval, a dismissal counts for nothing', async () => {
  deliver('pull_request', { action: 'opened', pull_request: pr(10, '2026-11-18T10:00:00Z') });
  const review = (login: string, state: string, at: string) => deliver('pull_request_review', { action: 'submitted', pull_request: { number: 10, html_url: 'x' }, review: { state, user: { login }, submitted_at: at, html_url: 'y' }, sender: { login } });
  review('ann', 'APPROVED', '2026-11-18T10:01:00Z');
  expect((await of(10)).review).toBe('approved');
  review('bob', 'CHANGES_REQUESTED', '2026-11-18T10:02:00Z');
  expect((await of(10)).review).toBe('changes_requested');
  review('bob', 'APPROVED', '2026-11-18T10:03:00Z');
  expect((await of(10)).review).toBe('approved');
  // An older verdict by the same reviewer does not come back.
  review('bob', 'CHANGES_REQUESTED', '2026-11-18T10:02:30Z');
  expect((await of(10)).review).toBe('approved');
  review('ann', 'DISMISSED', '2026-11-18T10:04:00Z');
  review('bob', 'DISMISSED', '2026-11-18T10:04:00Z');
  expect((await of(10)).review).toBe('none');
});
