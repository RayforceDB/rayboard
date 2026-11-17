// GitHub sync, stage 1 (T-19): deliveries come in as tasks, once each, newest wins, nothing written back.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BoardError, openBoard, type Actor, type Board } from '../src/board';
import { startServer } from '../src/server';
import { sharedRay, tempDir } from './helpers';

let board: Board;
let admin: Actor;
let base: string;
beforeEach(async () => {
  base = join(tempDir(), 'board');
  board = openBoard({ ray: await sharedRay(), base });
  admin = await board.createUser('anton', 'correct horse battery');
  await board.call(admin, 'set_github_repos', { repos: 'RayforceDB/rayforce RayforceDB/rayforce-q' });
});

const repo = (name = 'RayforceDB/rayforce', id = 101, priv = false) => ({ id, full_name: name, private: priv });
const issue = (n: number, title: string, updated: string, state = 'open', extra: Record<string, unknown> = {}) =>
  ({ node_id: `I_${n}`, number: n, html_url: `https://github.com/RayforceDB/rayforce/issues/${n}`, title, state, user: { login: 'reporter' }, updated_at: updated, body: 'SECRET BODY TEXT', ...extra });
let n = 0;
const deliver = (event: string, payload: Record<string, unknown>, id = `d-${++n}`) => board.githubDelivery(id, event, payload);
const tasks = async (who: Actor = admin) => (await board.call(who, 'list_tasks', { status: 'all' })) as { id: string; title: string; status: string; private: number; creator: string }[];
const github = async (who: Actor = admin) => ((await board.call(who, 'dashboard', {})) as { github: { task: string; state: string; number: number }[] }).github;

test('an issue of a followed repository comes in as a task, once per delivery, with nothing of its body', async () => {
  const first = deliver('issues', { action: 'opened', issue: issue(7, 'Crash on empty table', '2026-11-17T10:00:00Z'), repository: repo() }, 'same');
  expect(first.result).toBe('applied');
  expect(deliver('issues', { action: 'opened', issue: issue(7, 'Crash on empty table', '2026-11-17T10:00:00Z'), repository: repo() }, 'same').result).toBe('duplicate');
  const all = await tasks();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ id: first.task, title: 'rayforce#7 Crash on empty table', status: 'open', creator: 'github' });
  const detail = (await board.call(admin, 'get_task', { task: first.task })) as { task: { body: string; outcome: string } };
  expect(detail.task.body).toContain('https://github.com/RayforceDB/rayforce/issues/7');
  expect(JSON.stringify(detail)).not.toContain('SECRET BODY TEXT');
  expect(await github()).toEqual([expect.objectContaining({ task: first.task, number: 7, state: 'open' })]);
});

test('an older delivery never undoes a newer one; an equal or newer one is applied', async () => {
  const t = deliver('issues', { action: 'opened', issue: issue(8, 'Old title', '2026-11-17T10:00:00Z'), repository: repo() }).task;
  deliver('issues', { action: 'edited', issue: issue(8, 'New title', '2026-11-17T11:00:00Z'), repository: repo() });
  expect(deliver('issues', { action: 'edited', issue: issue(8, 'Stale title', '2026-11-17T10:30:00Z'), repository: repo() }).result).toBe('ignored');
  expect((await tasks())[0]!.title).toBe('rayforce#8 New title');
  expect(deliver('issues', { action: 'edited', issue: issue(8, 'Same moment', '2026-11-17T11:00:00Z'), repository: repo() }).result).toBe('applied');
  expect((await tasks()).find((x) => x.id === t)!.title).toBe('rayforce#8 Same moment');
});

test('closing on GitHub is shown and told to the holder, but the task status stays theirs to decide', async () => {
  const agent = board.agentOfToken(((await board.call(admin, 'create_agent', { name: 'worker' })) as { token: string }).token)!;
  const t = deliver('issues', { action: 'opened', issue: issue(9, 'Leak', '2026-11-17T10:00:00Z'), repository: repo() }).task!;
  await board.call(agent, 'claim_task', { task: t });
  await board.call(agent, 'inbox', {});
  deliver('issues', { action: 'closed', issue: issue(9, 'Leak', '2026-11-17T12:00:00Z', 'closed'), repository: repo() });
  expect((await tasks()).find((x) => x.id === t)!.status).toBe('in_progress');
  expect((await github()).find((g) => g.task === t)!.state).toBe('closed');
  const notes = ((await board.call(agent, 'inbox', {})) as { items: { type: string; text: string }[] }).items;
  expect(notes.map((x) => x.type)).toEqual(['github']);
  expect(notes[0]!.text).toContain('was closed');
});

test('comments and reviews wake the holder with a link and no text; a pull request is found by its number', async () => {
  const agent = board.agentOfToken(((await board.call(admin, 'create_agent', { name: 'worker' })) as { token: string }).token)!;
  const pr = { node_id: 'PR_5', number: 5, html_url: 'https://github.com/RayforceDB/rayforce/pull/5', title: 'Fix it', state: 'open', user: { login: 'dev' }, updated_at: '2026-11-17T10:00:00Z' };
  const t = deliver('pull_request', { action: 'opened', pull_request: pr, repository: repo() }).task!;
  await board.call(agent, 'claim_task', { task: t });
  await board.call(agent, 'inbox', {});
  // A comment on a pull request arrives on its issue, whose node id is not the pull request's.
  deliver('issue_comment', { action: 'created', issue: { node_id: 'I_other', number: 5, html_url: pr.html_url, pull_request: {} }, comment: { html_url: `${pr.html_url}#c1`, body: 'SECRET COMMENT' }, sender: { login: 'maintainer' }, repository: repo() });
  deliver('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'changes_requested', html_url: `${pr.html_url}#r1`, body: 'SECRET REVIEW' }, sender: { login: 'maintainer' }, repository: repo() });
  const notes = ((await board.call(agent, 'inbox', {})) as { items: { text: string }[] }).items.map((x) => x.text);
  expect(notes).toHaveLength(2);
  expect(notes[0]).toContain('@maintainer commented on pull request #5');
  expect(notes[1]).toContain('reviewed pull request #5 (changes requested)');
  expect(notes.join(' ')).not.toContain('SECRET');
});

test('a repository not followed is ignored, and a followed one is kept by its id when renamed', async () => {
  expect(deliver('issues', { action: 'opened', issue: issue(1, 'x', '2026-11-17T10:00:00Z'), repository: repo('Someone/else', 999) }).result).toBe('ignored');
  expect(await tasks()).toEqual([]);
  deliver('issues', { action: 'opened', issue: issue(2, 'first', '2026-11-17T10:00:00Z'), repository: repo('RayforceDB/rayforce', 101) });
  // Renamed on GitHub: the same id still belongs to the followed repository.
  expect(deliver('issues', { action: 'opened', issue: issue(3, 'after rename', '2026-11-17T10:00:00Z'), repository: repo('RayforceDB/rayforce-core', 101) }).result).toBe('applied');
  // Another repository taking the old name is not followed through it.
  expect(deliver('issues', { action: 'opened', issue: issue(4, 'impostor', '2026-11-17T10:00:00Z'), repository: repo('RayforceDB/rayforce', 555) }).result).toBe('ignored');
  expect((await tasks()).map((t) => t.title).sort()).toEqual(['rayforce#2 first', 'rayforce-core#3 after rename']);
});

test('an issue of a private repository is a private task, hidden from those who may not see it', async () => {
  const member = await board.createUser('mia', 'correct horse battery', 'member');
  const t = deliver('issues', { action: 'opened', issue: issue(11, 'PRIVATE-TITLE', '2026-11-17T10:00:00Z'), repository: repo('RayforceDB/rayforce-q', 202, true) }).task!;
  expect((await tasks()).find((x) => x.id === t)!.private).toBe(1);
  expect((await tasks(member)).some((x) => x.id === t)).toBe(false);
  expect(await github(member)).toEqual([]);
  expect(JSON.stringify(await board.call(member, 'activity', {}))).not.toContain('PRIVATE-TITLE');
});

test('only an administrator chooses the repositories, and names must be owner/name', async () => {
  const member = await board.createUser('mia', 'correct horse battery', 'member');
  await expect(board.call(member, 'set_github_repos', { repos: 'a/b' })).rejects.toBeInstanceOf(BoardError);
  await expect(board.call(admin, 'set_github_repos', { repos: 'not-a-repo' })).rejects.toMatchObject({ code: 'invalid' });
});

const servers: { stop: () => Promise<void> }[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); });

test('the webhook takes only deliveries signed with the secret kept beside the board', async () => {
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dirname(base), log: () => {} });
  servers.push(server);
  const body = JSON.stringify({ action: 'opened', issue: issue(21, 'Signed', '2026-11-17T10:00:00Z'), repository: repo() });
  const post = (headers: Record<string, string>) => fetch(`${server.url}/api/github`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'w-1', ...headers }, body });
  expect((await post({})).status).toBe(503);
  mkdirSync(join(dirname(base), 'github'), { recursive: true });
  writeFileSync(join(dirname(base), 'github', 'webhook_secret'), 'topsecret\n', { mode: 0o600 });
  expect((await post({ 'X-Hub-Signature-256': 'sha256=00' })).status).toBe(401);
  const sig = `sha256=${createHmac('sha256', 'topsecret').update(body).digest('hex')}`;
  const ok = await post({ 'X-Hub-Signature-256': sig });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true, result: 'applied' });
  expect(await (await post({ 'X-Hub-Signature-256': sig })).json()).toMatchObject({ result: 'duplicate' });
});

test('stage-2 events (check runs) are taken, recorded and ignored, never shown as if supported', async () => {
  const t = deliver('issues', { action: 'opened', issue: issue(31, 'With checks', '2026-11-17T10:00:00Z'), repository: repo() }).task!;
  const before = JSON.stringify(await github());
  const check = deliver('check_run', { action: 'completed', check_run: { head_sha: 'abc', conclusion: 'failure', pull_requests: [{ number: 31 }] }, repository: repo() }, 'chk-1');
  expect(check.result).toBe('ignored');
  expect(deliver('check_run', { action: 'completed', check_run: {}, repository: repo() }, 'chk-1').result).toBe('duplicate');
  expect(JSON.stringify(await github())).toBe(before);
  const status = (await board.call(admin, 'github_status', {})) as { deliveries: { id: string; result: string }[] };
  expect(status.deliveries.find((d) => d.id === 'chk-1')).toMatchObject({ result: 'ignored' });
  void t;
});
