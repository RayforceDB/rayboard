// Agent state (Anton, 18.11): an agent writing code goes quiet for minutes; working, away and offline are told apart.
import { expect, test } from 'bun:test';
import { agentState, personState } from '../ui/kit';

const now = '2026-11-18T10:45:00.000Z';
const ago = (min: number) => new Date(Date.parse(now) - min * 60_000).toISOString();
const board = (tasks: object[] = [], reviews: object[] = []) => ({ now, tasks, reviews } as never);
const agent = (o: object) => ({ id: 'a_1', status: 'active', online: 0, last_seen: '', ...o });

test('an agent with a task in progress is working while heard from lately, and away once quiet for long', () => {
  const tasks = [{ id: 'T-447', assignee: 'a_1', status: 'in_progress' }];
  expect(agentState(board(tasks), agent({ online: 1, last_seen: ago(0) })).label).toBe('Working on T-447');
  // Quiet for five minutes, writing code between two calls: still working, not offline.
  expect(agentState(board(tasks), agent({ last_seen: ago(5) })).label).toBe('Working on T-447');
  expect(agentState(board(tasks), agent({ last_seen: ago(40) }))).toMatchObject({ label: 'Away · T-447 in progress · seen 40m ago', tone: 'off' });
  expect(agentState(board(tasks), agent({})).label).toBe('Away · T-447 in progress');
});

test('without work an agent is available when connected and offline otherwise', () => {
  expect(agentState(board(), agent({ online: 1, last_seen: ago(0) })).label).toBe('Available');
  expect(agentState(board(), agent({ last_seen: ago(5) })).label).toBe('Offline · seen 5m ago');
  expect(agentState(board([], [{ reviewer: 'a_1' }]), agent({ last_seen: ago(3) })).label).toBe('Reviewing');
});

test('an agent not at work says how long ago it was last seen, with the full moment in its tooltip (T-508)', () => {
  const at = (min: number) => agentState(board(), agent({ last_seen: ago(min) }));
  expect(at(0.5).label).toBe('Offline · seen just now');
  expect(at(5).label).toBe('Offline · seen 5m ago');
  expect(at(125).label).toBe('Offline · seen 2h ago');
  expect(at(3 * 24 * 60 + 10).label).toBe('Offline · seen 3d ago');
  expect(at(125).title).toBe(`Last heard from ${new Date(ago(125)).toLocaleString()}`);
  const tasks = [{ id: 'T-447', assignee: 'a_1', status: 'in_progress' }];
  expect(agentState(board(tasks), agent({ last_seen: ago(40) })).label).toBe('Away · T-447 in progress · seen 40m ago');
  expect(agentState(board([], [{ reviewer: 'a_1' }]), agent({ last_seen: ago(40) })).label).toBe('Away · review waiting · seen 40m ago');
  // Online or at work: no suffix. Never seen: none either, and the tooltip says so.
  expect(agentState(board(), agent({ online: 1, last_seen: ago(0) })).label).toBe('Available');
  expect(agentState(board(tasks), agent({ last_seen: ago(5) })).label).toBe('Working on T-447');
  expect(agentState(board(), agent({}))).toMatchObject({ label: 'Offline', title: 'Not heard from yet' });
});

test('a person is online while their page is open, and otherwise says when they were last seen (T-508)', () => {
  const person = (o: object) => ({ id: 'u_1', status: 'active', online: 0, last_seen: '', ...o });
  expect(personState(board(), person({ online: 1, last_seen: ago(0) }))).toMatchObject({ label: 'Online', tone: 'good' });
  expect(personState(board(), person({ last_seen: ago(5) })).label).toBe('Offline · seen 5m ago');
  expect(personState(board(), person({ last_seen: ago(150) }))).toMatchObject({ label: 'Offline · seen 2h ago', title: `Last heard from ${new Date(ago(150)).toLocaleString()}` });
  expect(personState(board(), person({ last_seen: ago(2 * 24 * 60) })).label).toBe('Offline · seen 2d ago');
  expect(personState(board(), person({})).label).toBe('Offline');
});
