// T-465: the Board count and the board agree on which tasks are updated, whatever project is chosen.
import { expect, test } from 'bun:test';
import { askOnlyUpdated, onAskOnlyUpdated, takeOnlyUpdated, updatedScope } from '../ui/updated';

const tasks = [
  { id: 'T-1', project: 'rayboard', updated: true },
  { id: 'T-2', project: 'rayforce', updated: true },
  { id: 'T-3', project: 'rayforce', updated: true },
  { id: 'T-4', project: 'rayboard', updated: false },
];

test('with a project chosen and updates only elsewhere, the board says where they are (Anton: nothing updated, count 3)', () => {
  const s = updatedScope(tasks.filter((t) => t.id !== 'T-1'), (t) => t.updated, (t) => t.project === 'rayboard');
  expect(s.here).toEqual([]);
  expect(s.elsewhere).toBe(2);
  expect(s.total).toBe(2);
});

test('in a project with some updates, the rest are counted apart; with all projects, nothing is elsewhere', () => {
  const chosen = updatedScope(tasks, (t) => t.updated, (t) => t.project === 'rayforce');
  expect(chosen.here.map((t) => t.id)).toEqual(['T-2', 'T-3']);
  expect(chosen.elsewhere).toBe(1);
  const all = updatedScope(tasks, (t) => t.updated, () => true);
  expect(all.here.length).toBe(all.total);
  expect(all.elsewhere).toBe(0);
});

test('a click on the count is taken once, whether the board is already open or opens after', () => {
  expect(takeOnlyUpdated()).toBe(false);
  askOnlyUpdated();
  expect(takeOnlyUpdated()).toBe(true);
  expect(takeOnlyUpdated()).toBe(false);
  let heard = 0;
  const stop = onAskOnlyUpdated(() => { heard++; takeOnlyUpdated(); });
  askOnlyUpdated();
  expect(heard).toBe(1);
  expect(takeOnlyUpdated()).toBe(false);
  stop();
  askOnlyUpdated();
  expect(heard).toBe(1);
  expect(takeOnlyUpdated()).toBe(true);
});
