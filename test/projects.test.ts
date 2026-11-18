// Projects (T-20): a task belongs to one, chosen by hand or taken from its GitHub repository, and tasks are listed by it.
import { beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BoardError, openBoard, type Actor, type Board } from '../src/board';
import { sharedRay, tempDir } from './helpers';

let board: Board;
let base: string;
let admin: Actor;
const open = async (): Promise<Board> => openBoard({ ray: await sharedRay(), base });

beforeEach(async () => {
  base = join(tempDir(), 'board');
  board = await open();
  admin = await board.createUser('anton', 'correct horse battery');
});

type T = { id: string; title: string; project: string; rev: number };
const tasks = async (p: Record<string, unknown> = {}): Promise<T[]> => (await board.call(admin, 'list_tasks', { status: 'all', ...p })) as T[];
const fails = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(BoardError);
  expect((err as BoardError).code as string).toBe(code);
};

test('a task is given a project, a subtask takes its parent\'s, and list_tasks filters by it across a restart', async () => {
  const a = (await board.call(admin, 'create_task', { title: 'Board work', outcome: 'x', project: 'RayBoard' })) as T;
  expect(a.project).toBe('rayboard');
  const sub = (await board.call(admin, 'create_task', { title: 'Part', outcome: 'x', parent: a.id })) as T;
  expect(sub.project).toBe('rayboard');
  const other = (await board.call(admin, 'create_task', { title: 'Engine', outcome: 'x', parent: a.id, project: 'rayforce' })) as T;
  expect(other.project).toBe('rayforce');
  await board.call(admin, 'create_task', { title: 'Loose', outcome: 'x' });
  board.close(); board = await open();
  expect((await tasks({ project: 'rayboard' })).map((t) => t.title).sort()).toEqual(['Board work', 'Part']);
  expect((await tasks({ project: 'none' })).map((t) => t.title)).toEqual(['Loose']);
  expect((await tasks()).map((t) => t.project).sort()).toEqual(['', 'rayboard', 'rayboard', 'rayforce']);
});

test('a project is moved with update_task, cleared with "none", and its name is checked', async () => {
  const t = (await board.call(admin, 'create_task', { title: 'Move me', outcome: 'x', project: 'rayforce' })) as T;
  const moved = (await board.call(admin, 'update_task', { task: t.id, rev: t.rev, project: 'rayforce-q' })) as T;
  expect(moved.project).toBe('rayforce-q');
  const cleared = (await board.call(admin, 'update_task', { task: t.id, rev: moved.rev, project: 'none' })) as T;
  expect(cleared.project).toBe('');
  await fails(board.call(admin, 'create_task', { title: 'Bad', outcome: 'x', project: 'two words' }), 'invalid');
  await fails(board.call(admin, 'create_task', { title: 'Bad', outcome: 'x', project: '-dash' }), 'invalid');
  await fails(board.call(admin, 'update_task', { task: t.id, rev: cleared.rev, project: 'none' }), 'invalid');
});

test('an issue from GitHub comes in under its repository\'s project, and GitHub never moves it back', async () => {
  await board.call(admin, 'set_github_repos', { repos: 'RayforceDB/rayforce-q' });
  const issue = (title: string, updated: string) => ({ node_id: 'I_1', number: 3, html_url: 'https://github.com/RayforceDB/rayforce-q/issues/3', title, state: 'open', user: { login: 'r' }, updated_at: updated });
  const repository = { id: 202, full_name: 'RayforceDB/rayforce-q', private: false };
  const id = board.githubDelivery('d1', 'issues', { action: 'opened', issue: issue('Slow join', '2026-11-18T09:00:00Z'), repository }).task!;
  let t = (await tasks()).find((x) => x.id === id)!;
  expect(t.project).toBe('rayforce-q');
  await board.call(admin, 'update_task', { task: id, rev: t.rev, project: 'rayforce' });
  board.githubDelivery('d2', 'issues', { action: 'edited', issue: issue('Slow join on keyed tables', '2026-11-18T10:00:00Z'), repository });
  t = (await tasks()).find((x) => x.id === id)!;
  expect(t.title).toBe('rayforce-q#3 Slow join on keyed tables');
  expect(t.project).toBe('rayforce');
});
