// Agent state (Anton, 18.11): an agent writing code goes quiet for minutes; working, away and offline are told apart.
import { expect, test } from 'bun:test';
import { agentState } from '../ui/kit';

const now = '2026-11-18T10:45:00.000Z';
const ago = (min: number) => new Date(Date.parse(now) - min * 60_000).toISOString();
const board = (tasks: object[] = [], reviews: object[] = []) => ({ now, tasks, reviews } as never);
const agent = (o: object) => ({ id: 'a_1', status: 'active', online: 0, last_seen: '', ...o });

test('an agent with a task in progress is working while heard from lately, and away once quiet for long', () => {
  const tasks = [{ id: 'T-447', assignee: 'a_1', status: 'in_progress' }];
  expect(agentState(board(tasks), agent({ online: 1, last_seen: ago(0) })).label).toBe('Working on T-447');
  // Quiet for five minutes, writing code between two calls: still working, not offline.
  expect(agentState(board(tasks), agent({ last_seen: ago(5) })).label).toBe('Working on T-447');
  expect(agentState(board(tasks), agent({ last_seen: ago(40) }))).toMatchObject({ label: 'Away · T-447 in progress', tone: 'off' });
  expect(agentState(board(tasks), agent({})).label).toBe('Away · T-447 in progress');
});

test('without work an agent is available when connected and offline otherwise', () => {
  expect(agentState(board(), agent({ online: 1, last_seen: ago(0) })).label).toBe('Available');
  expect(agentState(board(), agent({ last_seen: ago(5) })).label).toBe('Offline');
  expect(agentState(board([], [{ reviewer: 'a_1' }]), agent({ last_seen: ago(3) })).label).toBe('Reviewing');
});
