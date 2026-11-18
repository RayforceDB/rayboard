// Project marks (T-20): two letters at most, the first of each part of the name.
import { expect, test } from 'bun:test';
import { hueOf, initials } from '../ui/marks';

test('a project is marked by the first letter of each part of its name', () => {
  expect(initials('rayforce')).toBe('R');
  expect(initials('rayforce-q')).toBe('RQ');
  expect(initials('rayforce-rs')).toBe('RR');
  expect(initials('my_big.project')).toBe('MB');
});

test('the board\'s projects each get their own hue, whatever their names hash to (Anton, 18.11)', () => {
  const names = ['rayboard', 'rayforce', 'rayforce-q', 'rayforce-rs', 'teneral'];
  const hues = names.map((n) => hueOf(n, names));
  expect(new Set(hues).size).toBe(names.length);
  // Hues stay at least 30 degrees apart around the wheel.
  for (const a of hues) for (const b of hues) if (a !== b) expect(Math.min(Math.abs(a - b), 360 - Math.abs(a - b))).toBeGreaterThanOrEqual(30);
});
