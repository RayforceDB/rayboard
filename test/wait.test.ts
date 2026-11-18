// `rayboard wait` (Anton: a Claude Code adapter): returns as soon as the agent has something, never marks it read.
import { afterAll, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openBoard } from '../src/board';
import { startServer, type Server } from '../src/server';
import { waitForInbox, WaitError } from '../src/wait';
import { sharedRay, tempDir } from './helpers';

const servers: Server[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); });

async function setup() {
  const base = join(tempDir(), 'board');
  const board = openBoard({ ray: await sharedRay(), base });
  const anton = await board.createUser('anton', 'correct horse battery');
  const made = (await board.call(anton, 'create_agent', { name: 'helper' })) as { token: string; agent: { id: string } };
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dirname(base), log: () => {} });
  servers.push(server);
  const agent = board.agentOfToken(made.token)!;
  return { board, anton, agent, token: made.token, server, dir: dirname(base) };
}

test('it returns what waits at once, and leaves it unread for the session to read', async () => {
  const { board, anton, agent, token, server } = await setup();
  await board.call(agent, 'inbox', {});
  await board.call(anton, 'post_message', { to: '@helper', body: 'please look at T-1' });
  const items = await waitForInbox({ url: server.url, token, timeout: 5 });
  expect(items.length).toBe(1);
  expect(items[0]!.text).toContain('please look');
  // Peeked, not read: the agent's own inbox call still gets it.
  const read = (await board.call(agent, 'inbox', {})) as { items: unknown[] };
  expect(read.items.length).toBe(1);
});

test('it wakes when something arrives while it waits, within about a second', async () => {
  const { board, anton, agent, token, server } = await setup();
  await board.call(agent, 'inbox', {});
  const started = Date.now();
  const waiting = waitForInbox({ url: server.url, token, timeout: 20 });
  setTimeout(() => void board.call(anton, 'post_message', { to: '@helper', body: 'now' }), 400);
  const items = await waiting;
  expect(items.map((i) => i.text)).toEqual([expect.stringContaining('now')]);
  expect(Date.now() - started).toBeLessThan(3000);
});

test('a refused token stops it; a board that is down is waited out; a timeout returns nothing', async () => {
  const { board, anton, agent, token, server } = await setup();
  await expect(waitForInbox({ url: server.url, token: 'rba_not-a-token', timeout: 5 })).rejects.toBeInstanceOf(WaitError);
  await board.call(agent, 'inbox', {});
  expect(await waitForInbox({ url: server.url, token, timeout: 1 })).toEqual([]);
  await board.call(anton, 'post_message', { to: '@helper', body: 'after the outage' });
  let down = 2;
  const notes: string[] = [];
  const flaky = (url: string, init?: RequestInit) => (down-- > 0 ? Promise.reject(new Error('connection refused')) : fetch(url, init));
  const items = await waitForInbox({ url: server.url, token, timeout: 10, fetch: flaky, sleep: async () => {}, note: (l) => notes.push(l) });
  expect(items.length).toBe(1);
  expect(notes.length).toBe(2);
});

test('the command says what waits and exits 0; 2 for a refused token; 3 after the timeout', async () => {
  const { board, anton, agent, token, server, dir } = await setup();
  const file = join(dir, 'token');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  const run = (...a: string[]) => Bun.spawnSync(['bun', join(import.meta.dir, '..', 'bin', 'rayboard.ts'), 'wait', '--url', server.url, ...a]);
  await board.call(agent, 'inbox', {});
  const quiet = Bun.spawn(['bun', join(import.meta.dir, '..', 'bin', 'rayboard.ts'), 'wait', '--url', server.url, '--token-file', file, '--timeout', '1']);
  expect(await quiet.exited).toBe(3);
  await board.call(anton, 'post_message', { to: '@helper', body: 'hello from anton' });
  const got = Bun.spawn(['bun', join(import.meta.dir, '..', 'bin', 'rayboard.ts'), 'wait', '--url', server.url, '--token-file', file]);
  expect(await got.exited).toBe(0);
  expect(await new Response(got.stdout).text()).toContain('hello from anton');
  writeFileSync(file, 'rba_wrong');
  const refused = Bun.spawn(['bun', join(import.meta.dir, '..', 'bin', 'rayboard.ts'), 'wait', '--url', server.url, '--token-file', file, '--timeout', '5']);
  expect(await refused.exited).toBe(2);
  expect(run().exitCode).toBe(64);
});
