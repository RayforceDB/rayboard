import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { openBoard, type Actor } from '../src/board';
import { sharedRay, tempDir } from './helpers';

test('an old snapshot and journal are carried into the current schema before the next write', async () => {
  const dir = tempDir();
  const base = join(dir, 'board');
  const legacy = join(dir, 'journal.jsonl');
  writeFileSync(legacy, JSON.stringify({ seq: 1, ts: '2026-11-16T00:00:00.000Z', type: 'user.created', actor: 'u_old', subject: 'u_old', summary: 'an old person', put: { users: [{ id: 'u_old', name: 'oldperson', pass: 'oldhash', status: 'active', created: '2026-11-16T00:00:00.000Z' }] } }));
  const ray = await sharedRay();
  let board = await openBoard({ ray, base, legacy });
  const old = board.userById('u_old')!;
  expect(old.role).toBe('admin');
  await board.call(old, 'create_channel', { name: 'old-board' });
  const invite = await board.call(old, 'invite_person', {}) as { key: string };
  const member = await board.acceptInvite(invite.key, 'newperson', 'a private passphrase');
  expect(member.role).toBe('member');
  board.close();
  board = await openBoard({ ray, base });
  expect(await board.login('newperson', 'a private passphrase')).toMatchObject({ role: 'member' });
  expect(board.userById('u_old')).toMatchObject({ name: 'oldperson', role: 'admin' });
  const profile = await board.call(old, 'set_profile', { about: 'Old user, new profile' });
  expect(profile).toMatchObject({ about: 'Old user, new profile', role: 'admin' });
  expect(await board.login('oldperson', 'not the right password')).toBeNull();
  expect(await board.call(board.userById(member.id)!, 'list_channels', {})).toMatchObject([{ name: 'old-board' }]);
  board.close();
});
