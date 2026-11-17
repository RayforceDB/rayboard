import { expect, test } from 'bun:test';
import { listenToRoute, parseRoute, routeHash } from '../ui/route';

test('deep links round-trip encoded identifiers, including slash and Cyrillic', () => {
  for (const item of ['T-4', 'dm:a_one:u_two', 'a/b', 'обсуждение', '%2F']) {
    expect(parseRoute(routeHash({ view: 'chat', item }))).toEqual({ view: 'chat', item });
  }
});

test('empty, unknown and malformed hashes stay usable', () => {
  expect(parseRoute('')).toEqual({ view: 'overview', item: '' });
  expect(parseRoute('#tasks/T-4')).toEqual({ view: 'tasks', item: 'T-4' });
  expect(parseRoute('#missing/T-4')).toEqual({ view: 'overview', item: '' });
  expect(parseRoute('#chat/%E0%A4%A')).toEqual({ view: 'chat', item: '' });
});

test('subscription synchronizes initial route, both browser events and cleanup', () => {
  const target = new EventTarget() as EventTarget & { location: { hash: string } };
  target.location = { hash: '#tasks/T-4' };
  const seen: unknown[] = [];
  const stop = listenToRoute(target as unknown as Window, (route) => seen.push(route));
  target.location.hash = '#chat/dm%3Aa%3Ab';
  target.dispatchEvent(new Event('hashchange'));
  target.location.hash = '#tasks/T-4';
  target.dispatchEvent(new Event('popstate'));
  stop();
  target.location.hash = '#agents';
  target.dispatchEvent(new Event('popstate'));
  target.dispatchEvent(new Event('hashchange'));
  expect(seen).toEqual([
    { view: 'tasks', item: 'T-4' },
    { view: 'chat', item: 'dm:a:b' },
    { view: 'tasks', item: 'T-4' },
  ]);
});

test('People can be linked to directly (GitHub returns there after installing the App)', () => {
  expect(parseRoute('#people')).toEqual({ view: 'people', item: '' });
  expect(routeHash({ view: 'people', item: '' })).toBe('#people');
});
