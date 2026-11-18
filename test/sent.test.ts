// A sent message stays shown when a read that started before it comes back without it (Mica, T-456).
import { expect, test } from 'bun:test';
import { Sent } from '../ui/sent';

test('a sent message survives a stale read, and is dropped from the holding list once a read has it', () => {
  const s = new Sent();
  const a = { id: 'm_1', seq: 1, body: 'earlier' };
  const mine = { id: 'm_3', seq: 3, body: 'mine' };
  s.add('#general', mine);
  // A read from before the send: it lacks the message, which is kept, in order.
  expect(s.merge('#general', [a]).map((m) => m.id)).toEqual(['m_1', 'm_3']);
  // Another conversation is not touched.
  expect(s.merge('#other', [a]).map((m) => m.id)).toEqual(['m_1']);
  // A later read has it, and something newer from someone else: shown once, in order.
  const theirs = { id: 'm_4', seq: 4, body: 'reply' };
  expect(s.merge('#general', [a, mine, theirs]).map((m) => m.id)).toEqual(['m_1', 'm_3', 'm_4']);
  // Since a read included it, it is no longer added to reads that do not (a deletion, a narrower page).
  expect(s.merge('#general', [a]).map((m) => m.id)).toEqual(['m_1']);
  // Adding the same message twice holds it once.
  s.add('#general', theirs); s.add('#general', theirs);
  expect(s.merge('#general', []).map((m) => m.id)).toEqual(['m_4']);
});
