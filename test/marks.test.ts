// Project marks (T-20): two letters at most, the first of each part of the name.
import { expect, test } from 'bun:test';
import { initials } from '../ui/marks';

test('a project is marked by the first letter of each part of its name', () => {
  expect(initials('rayforce')).toBe('R');
  expect(initials('rayforce-q')).toBe('RQ');
  expect(initials('rayforce-rs')).toBe('RR');
  expect(initials('my_big.project')).toBe('MB');
});
