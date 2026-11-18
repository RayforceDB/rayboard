// Sending a message showed it seconds later (Anton, m_4867): every change made each dashboard fetch ~380 KB of
// uncompressed JSON. JSON answers now go out gzipped to whoever accepts it, and a sent message is answered with itself.
import { afterAll, expect, test } from 'bun:test';
import { get } from 'node:http';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { openBoard } from '../src/board';
import { startServer, type Server } from '../src/server';
import { sharedRay, tempDir } from './helpers';

const servers: Server[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); });

/** A raw GET/POST, so the test sees the bytes on the wire rather than what fetch decoded. */
function raw(url: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Record<string, unknown>; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, url);
    const req = (body === undefined ? get : (o: object, cb: never) => (require('node:http') as typeof import('node:http')).request(o, cb))(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: body === undefined ? 'GET' : 'POST', headers } as never,
      ((res: import('node:http').IncomingMessage) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(parts) }));
      }) as never,
    );
    req.on('error', reject);
    if (body !== undefined) req.end(body);
  });
}

test('JSON answers are gzipped for a client that takes gzip, and plain for one that does not', async () => {
  const base = join(tempDir(), 'board');
  const board = openBoard({ ray: await sharedRay(), base });
  const anton = await board.createUser('anton', 'correct horse battery');
  for (let i = 0; i < 40; i++) await board.call(anton, 'create_task', { title: `Task number ${i} with a title long enough to matter`, outcome: 'Something a reviewer can check, said at some length.' });
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dirname(base), log: () => {}, unsafe: anton });
  servers.push(server);
  const call = (enc: string) => raw(server.url, '/api/call/dashboard', { 'Content-Type': 'application/json', Origin: server.url, ...(enc ? { 'Accept-Encoding': enc } : {}) }, '{}');
  const zipped = await call('gzip, deflate, br');
  expect(zipped.status).toBe(200);
  expect(zipped.headers['content-encoding']).toBe('gzip');
  expect(String(zipped.headers.vary)).toContain('Accept-Encoding');
  const plain = await call('');
  expect(plain.headers['content-encoding']).toBeUndefined();
  // The same board either way; only the clock it reports moved between the two calls.
  const strip = (b: Buffer) => { const j = JSON.parse(b.toString()) as { result: Record<string, unknown> }; delete j.result.now; return j; };
  expect(strip(gunzipSync(zipped.bytes))).toEqual(strip(plain.bytes));
  expect(zipped.bytes.length * 3).toBeLessThan(plain.bytes.length);
  expect((JSON.parse(plain.bytes.toString()) as { ok: boolean }).ok).toBe(true);
  // Small answers and errors are left as they are; so is anything that is not JSON.
  const health = await raw(server.url, '/api/health', { 'Accept-Encoding': 'gzip' });
  expect(health.headers['content-encoding']).toBeUndefined();
  expect((JSON.parse(health.bytes.toString()) as { ok: boolean }).ok).toBe(true);
  // And fetch, as the dashboard uses it, reads the gzipped answer whole.
  const viaFetch = await fetch(`${server.url}/api/call/dashboard`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url }, body: '{}' });
  expect(((await viaFetch.json()) as { result: { tasks: unknown[] } }).result.tasks.length).toBe(40);
});

test('post_message answers with the message itself, which the composer shows at once', async () => {
  const base = join(tempDir(), 'board');
  const board = openBoard({ ray: await sharedRay(), base });
  const anton = await board.createUser('anton', 'correct horse battery');
  const chan = (await board.call(anton, 'create_channel', { name: 'general' })) as { id: string };
  const sent = (await board.call(anton, 'post_message', { to: '#general', body: 'hello' })) as { id: string; body: string; author: string; ts: string; chan: string };
  expect(sent.body).toBe('hello');
  expect(sent.author).toBe(anton.id);
  expect(sent.chan).toBe(chan.id);
  expect(typeof sent.ts).toBe('string');
  const listed = (await board.call(anton, 'read_messages', { from: '#general' })) as { id: string }[];
  expect(listed.at(-1)!.id).toBe(sent.id);
});
