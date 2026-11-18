// T-461: beside a conversation, how many messages from others the reader has not read, not the total.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openBoard } from '../src/board';
import { unreadIn } from '../ui/unread';
import { sharedRay, tempDir } from './helpers';

test('the dashboard tells where others wrote last in each conversation, without one\'s own messages', async () => {
  const board = openBoard({ ray: await sharedRay(), base: join(tempDir(), 'board') });
  const anton = await board.createUser('anton', 'correct horse battery');
  const serhii = await board.createUser('serhii', 'correct horse battery', 'member');
  await board.call(anton, 'create_channel', { name: 'general' });
  const a1 = (await board.call(anton, 'post_message', { to: '@serhii', body: 'ping' })) as { seq: number };
  const s1 = (await board.call(serhii, 'post_message', { to: '@anton', body: 'pong' })) as { seq: number };
  const s2 = (await board.call(serhii, 'post_message', { to: '@anton', body: 'there?' })) as { seq: number };
  await board.call(serhii, 'post_message', { to: '#general', body: 'hello all' });
  const view = (await board.call(anton, 'dashboard', {})) as { dms: { chan: string; recent: number[]; n: number }[]; channels: { name: string; recent: number[] }[] };
  const dm = view.dms.find((d) => d.chan.includes(serhii.id))!;
  expect(dm.n).toBe(3);
  expect(dm.recent).toEqual([s1.seq, s2.seq]);
  expect(view.channels.find((c) => c.name === 'general')!.recent.length).toBe(1);
  // The page counts what lies beyond its read mark.
  expect(unreadIn(dm, 0)).toBe(2);
  expect(unreadIn(dm, a1.seq)).toBe(2);
  expect(unreadIn(dm, s1.seq)).toBe(1);
  expect(unreadIn(dm, s2.seq)).toBe(0);
  // Serhii, the other side, sees only anton's one message as possibly unread.
  const theirs = (await board.call(serhii, 'dashboard', {})) as { dms: { chan: string; recent: number[] }[] };
  expect(theirs.dms[0]!.recent).toEqual([a1.seq]);
});
