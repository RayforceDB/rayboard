// T-462: the tab title counts what waits; a notification only for what newly arrived, named by place, not text.
import { expect, test } from 'bun:test';
import { conversationsOf, newlyUnread, tabTitle } from '../ui/tabsignal';
import { unreadIn } from '../ui/unread';

test('the tab title counts what waits, and is plain when nothing does', () => {
  expect(tabTitle(0)).toBe('rayboard');
  expect(tabTitle(3)).toBe('(3) rayboard');
  expect(tabTitle(250)).toBe('(99+) rayboard');
});

test('only what grew since the last look is news; the first look and reading are not', () => {
  const at = (n: number) => [{ key: 'c_1', label: 'New message in #general', unread: n }, { key: 'dm:u_a:u_b', label: 'New message from serhii', unread: 0 }];
  expect(newlyUnread(null, at(5))).toEqual([]);
  const before = new Map([['c_1', 1], ['dm:u_a:u_b', 0]]);
  expect(newlyUnread(before, at(2)).map((c) => c.key)).toEqual(['c_1']);
  expect(newlyUnread(before, at(0))).toEqual([]);
  expect(newlyUnread(before, at(1))).toEqual([]);
});

test('a person is told of channels and their own direct conversations, by place and sender, never by text', () => {
  const board = {
    channels: [{ id: 'c_1', name: 'general', recent: [10, 12] }],
    dms: [{ chan: 'dm:u_anton:u_serhii', recent: [11] }, { chan: 'dm:a_mica:a_morsel', recent: [13] }],
  };
  const read = new Map([['c_1', 10]]);
  const convs = conversationsOf(board, 'u_anton', (row) => unreadIn(row, read.get((row.id ?? row.chan) as string) ?? 0), (id) => id.replace(/^u_/, ''));
  expect(convs).toEqual([
    { key: 'c_1', label: 'New message in #general', unread: 1 },
    { key: 'dm:u_anton:u_serhii', label: 'New message from serhii', unread: 1 },
  ]);
});
