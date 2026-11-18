// T-478: the feed of changes tells someone who may not know of a DM or a private task nothing, not even that it moved.
import { afterAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { openBoard } from '../src/board';
import { startServer, type Server } from '../src/server';
import { sharedRay, tempDir } from './helpers';

const servers: Server[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); });
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

async function feed(url: string, name: string) {
  const r = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ name, password: 'correct horse battery' }) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  const frames: any[] = [];
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie, Origin: url } } as never);
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error('no socket')); });
  return { ws, frames };
}

test('another pair\'s DM moving, and a private task one may not see changing, reach a page as nothing at all', async () => {
  const base = join(tempDir(), 'board');
  const board = openBoard({ ray: await sharedRay(), base });
  const anton = await board.createUser('anton', 'correct horse battery');
  const serhii = await board.createUser('serhii', 'correct horse battery', 'member');
  await board.createUser('vic', 'correct horse battery', 'member');
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dirname(base), log: () => {} });
  servers.push(server);
  const v = await feed(server.url, 'vic');
  const a = await feed(server.url, 'anton');
  await board.call(serhii, 'post_message', { to: '@anton', body: 'between us' });
  const secret = (await board.call(anton, 'create_task', { title: 'Secret', outcome: 'x', private: true })) as { id: string };
  await board.call(anton, 'update_task', { task: secret.id, title: 'Still secret', rev: 1 });
  await settle();
  expect(v.frames).toEqual([]);
  // Those it is for are told in full.
  expect(a.frames.some((f) => f.type === 'message.dm')).toBe(true);
  expect(a.frames.some((f) => f.subject === secret.id)).toBe(true);
  // A public task vic was told of, then made private: one bare word so the page looks again, then silence.
  const open = (await board.call(anton, 'create_task', { title: 'Open for now', outcome: 'x' })) as { id: string };
  await settle();
  expect(v.frames.at(-1)).toMatchObject({ subject: open.id, type: 'task.created' });
  const mark = v.frames.length;
  await board.call(anton, 'update_task', { task: open.id, private: true, rev: 1 });
  await board.call(anton, 'update_task', { task: open.id, title: 'Now private', rev: 2 });
  await settle();
  const after = v.frames.slice(mark);
  expect(after.length).toBe(1);
  expect(after[0].subject).toBeUndefined();
  v.ws.close(); a.ws.close();
});
