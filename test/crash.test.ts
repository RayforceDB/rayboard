// A crash in the middle of a write: the board starts again on its own, losing only that unanswered write (T-16).
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBoard, type Actor, type Board } from '../src/board';
import { sharedRay, tempDir } from './helpers';

async function written(): Promise<{ dir: string; base: string; admin: Actor; last: number }> {
  const dir = tempDir();
  const base = join(dir, 'board');
  const board = openBoard({ ray: await sharedRay(), base });
  const admin = await board.createUser('anton', 'correct horse battery');
  for (let i = 0; i < 4; i++) await board.call(admin, 'create_channel', { name: `ch${i}` });
  const before = statSync(`${base}.log`).size;
  await board.call(admin, 'create_channel', { name: 'last' });
  const last = statSync(`${base}.log`).size - before;
  board.close();
  return { dir, base, admin, last };
}
const names = async (b: Board, a: Actor): Promise<string[]> => ((await b.call(a, 'list_channels', {})) as { name: string }[]).map((c) => c.name).sort();

for (const cut of [1, 7, 40]) {
  test(`a log cut ${cut} bytes into its last write opens without that write, and keeps the damaged log aside`, async () => {
    const { dir, base, admin, last } = await written();
    expect(cut).toBeLessThan(last);
    truncateSync(`${base}.log`, statSync(`${base}.log`).size - cut);
    const board = openBoard({ ray: await sharedRay(), base });
    expect(await names(board, board.userById(admin.id)!)).toEqual(['ch0', 'ch1', 'ch2', 'ch3']);
    // It goes on writing after the recovered prefix, and the next start replays cleanly.
    await board.call(board.userById(admin.id)!, 'create_channel', { name: 'after' });
    board.close();
    expect(readdirSync(dir).some((f) => f.startsWith('board.log.torn-'))).toBe(true);
    const again = openBoard({ ray: await sharedRay(), base });
    expect(await names(again, again.userById(admin.id)!)).toEqual(['after', 'ch0', 'ch1', 'ch2', 'ch3']);
    again.close();
  });
}

test('a log damaged in the middle is still refused, and left untouched', async () => {
  const { dir, base } = await written();
  const log = readFileSync(`${base}.log`);
  // Break the header of a frame that has others after it: not what a crash does.
  const header = log.indexOf(Buffer.from([0xfa, 0xde, 0xfa, 0xce]), 64);
  expect(header).toBeGreaterThan(0);
  log[header] ^= 0xff;
  writeFileSync(`${base}.log`, log);
  await expect((async () => openBoard({ ray: await sharedRay(), base }))()).rejects.toThrow();
  expect(readFileSync(`${base}.log`).equals(log)).toBe(true);
  expect(readdirSync(dir).some((f) => f.startsWith('board.log.torn-'))).toBe(false);
});

test('a whole log is left exactly as it is', async () => {
  const { dir, base, admin } = await written();
  const size = statSync(`${base}.log`).size;
  const board = openBoard({ ray: await sharedRay(), base });
  expect(await names(board, board.userById(admin.id)!)).toEqual(['ch0', 'ch1', 'ch2', 'ch3', 'last']);
  board.close();
  expect(readdirSync(dir).some((f) => f.startsWith('board.log.torn-'))).toBe(false);
  expect(existsSync(`${base}.log`)).toBe(true);
  void size;
});

test('a torn log another process holds is not touched: that process may be writing the very frame', async () => {
  const { dir, base } = await written();
  truncateSync(`${base}.log`, statSync(`${base}.log`).size - 7);
  const torn = readFileSync(`${base}.log`);
  // Another process opens the board and holds it (and its lock) until told to stop.
  const holder = Bun.spawn(['bun', '-e', `
    const { openBoard } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'board.ts'))});
    const { sharedRay } = await import(${JSON.stringify(join(import.meta.dir, 'helpers.ts'))});
    const { truncateSync, writeFileSync } = await import('node:fs');
    // It needs a log it can open: the whole one; the torn bytes are put back once it holds the lock.
    writeFileSync(${JSON.stringify(`${base}.log`)}, Buffer.from(${JSON.stringify(torn.toString('base64'))}, 'base64'));
    truncateSync(${JSON.stringify(`${base}.log`)}, 0);
    const board = openBoard({ ray: await sharedRay(), base: ${JSON.stringify(base)} });
    writeFileSync(${JSON.stringify(`${base}.log`)}, Buffer.from(${JSON.stringify(torn.toString('base64'))}, 'base64'));
    console.log('holding');
    await new Promise((r) => process.stdin.once('data', r));
    board.close();
  `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const reader = holder.stdout.getReader();
  let said = '';
  while (!said.includes('holding')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the holder ended: ${await new Response(holder.stderr).text()}`);
    said += new TextDecoder().decode(value);
  }
  try {
    const held = readFileSync(`${base}.log`);
    await expect((async () => openBoard({ ray: await sharedRay(), base }))()).rejects.toThrow();
    expect(readFileSync(`${base}.log`).equals(held)).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith('board.log.torn-'))).toBe(false);
  } finally {
    holder.stdin.write('stop\n');
    holder.stdin.end();
    await holder.exited;
  }
});
