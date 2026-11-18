// Pasted images (T-447): kept by their bytes' type, within a size, served only to those signed in, inert.
import { afterAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { openBoard } from '../src/board';
import { startServer, type Server } from '../src/server';
import { sharedRay, tempDir } from './helpers';

const servers: Server[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32, 1)]);

async function setup() {
  const base = join(tempDir(), 'board');
  const board = openBoard({ ray: await sharedRay(), base });
  await board.createUser('anton', 'correct horse battery');
  await board.createUser('vic', 'correct horse battery', 'viewer');
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dirname(base), log: () => {} });
  servers.push(server);
  const login = async (name: string) => {
    const r = await fetch(`${server.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url }, body: JSON.stringify({ name, password: 'correct horse battery' }) });
    return { Cookie: r.headers.get('set-cookie')!.split(';')[0]!, Origin: server.url, 'X-CSRF-Token': ((await r.json()) as { csrf: string }).csrf };
  };
  const agentToken = ((await board.call(board.firstUser()!, 'create_agent', { name: 'helper' })) as { token: string }).token;
  return { board, server, admin: await login('anton'), viewer: await login('vic'), agentToken };
}
const upload = (url: string, headers: Record<string, string>, bytes: Buffer) => fetch(`${url}/api/images`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: bytes });

test('a person pastes an image: it is kept by what its bytes are, and served inert to whoever is signed in', async () => {
  const { server, admin, viewer, agentToken } = await setup();
  const r = await upload(server.url, admin, PNG);
  expect(r.status).toBe(200);
  const made = ((await r.json()) as { result: { url: string; type: string; size: number } }).result;
  expect(made.type).toBe('image/png');
  expect(made.url).toMatch(/^\/api\/images\/[a-f0-9]{48}$/);
  const got = await fetch(`${server.url}${made.url}`, { headers: { Cookie: viewer.Cookie } });
  expect(got.status).toBe(200);
  expect(got.headers.get('content-type')).toBe('image/png');
  expect(got.headers.get('x-content-type-options')).toBe('nosniff');
  expect(got.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
  // An agent reads it with its token; nobody reads it without signing in; an unknown id is not found.
  expect((await fetch(`${server.url}${made.url}`, { headers: { Authorization: `Bearer ${agentToken}` } })).status).toBe(200);
  expect((await fetch(`${server.url}${made.url}`)).status).toBe(401);
  expect((await fetch(`${server.url}/api/images/${'0'.repeat(48)}`, { headers: { Cookie: viewer.Cookie } })).status).toBe(404);
  // Two pastes of the same picture get different names: knowing one tells nothing of the other.
  const again = ((await (await upload(server.url, admin, PNG)).json()) as { result: { url: string } }).result.url;
  expect(again).not.toBe(made.url);
});

test('only images, within the limit, from a page of this board or an agent; a viewer adds nothing', async () => {
  const { server, admin, viewer, agentToken } = await setup();
  expect(((await (await upload(server.url, { Authorization: `Bearer ${agentToken}` }, WEBP)).json()) as { result: { type: string } }).result.type).toBe('image/webp');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  expect((await upload(server.url, admin, svg)).status).toBe(400);
  const html = Buffer.from('<html><script>alert(1)</script>');
  expect((await upload(server.url, admin, html)).status).toBe(400);
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
  expect((await upload(server.url, admin, big)).status).toBe(400);
  expect((await upload(server.url, { Cookie: admin.Cookie, Origin: admin.Origin }, PNG)).status).toBe(403);
  expect((await upload(server.url, {}, PNG)).status).toBe(401);
  expect((await upload(server.url, viewer, PNG)).status).toBe(403);
});
