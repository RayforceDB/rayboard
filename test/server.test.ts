import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openBoard, type Board } from '../src/board';
import { startServer, type Server } from '../src/server';
import { sharedRay, tempDir } from './helpers';

let board: Board;
let server: Server;
let cookie = '';
let token = '';
let csrf = '';

beforeAll(async () => {
  const dir = tempDir();
  board = openBoard({ ray: await sharedRay(), base: join(dir, 'board') });
  server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dir, log: () => {} });
});
afterAll(async () => {
  await server.stop();
  board.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const asUser = (): Record<string, string> => ({ Cookie: cookie, Origin: server.url, 'X-CSRF-Token': csrf });
const asAgent = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const rpc = async (method: string, params: unknown, headers = asAgent()): Promise<any> => (await post('/mcp', { jsonrpc: '2.0', id: 1, method, params }, headers)).json();

test('the first person needs the setup code, and a session needs the dashboard\'s origin', async () => {
  const code = server.setupCode!;
  expect((await post('/api/setup', { code, name: 'anton', password: 'correct horse battery' })).status).toBe(403);
  expect((await post('/api/setup', { code: 'nope', name: 'anton', password: 'correct horse battery' }, { Origin: server.url })).status).toBe(401);
  const made = await post('/api/setup', { code, name: 'anton', password: 'correct horse battery' }, { Origin: server.url });
  expect(made.status).toBe(200);
  expect(server.setupCode).toBeNull();
  expect((await post('/api/setup', { code, name: 'eve', password: 'correct horse battery' }, { Origin: server.url })).status).toBe(409);

  expect((await post('/api/login', { name: 'anton', password: 'wrong wrong wrong' }, { Origin: server.url })).status).toBe(401);
  const login = await post('/api/login', { name: 'anton', password: 'correct horse battery' }, { Origin: server.url });
  const set = login.headers.get('set-cookie')!;
  expect(set).toContain('HttpOnly');
  expect(set).toContain('SameSite=Strict');
  cookie = set.split(';')[0]!;
  csrf = ((await login.json()) as { csrf: string }).csrf;
  // The token is the session's own: the origin alone is not enough, and neither is another session's token.
  expect((await post('/api/call/dashboard', {}, { Cookie: cookie, Origin: server.url })).status).toBe(403);
  expect((await post('/api/call/dashboard', {}, { Cookie: cookie, Origin: server.url, 'X-CSRF-Token': 'x'.repeat(43) })).status).toBe(403);

  expect((await post('/api/call/dashboard', {}, { Cookie: cookie })).status).toBe(403);
  expect((await post('/api/call/dashboard', {}, { Cookie: cookie, Origin: 'https://evil.example' })).status).toBe(403);
  expect((await post('/api/call/dashboard', {}, asUser())).status).toBe(200);
  expect((await post('/api/call/dashboard', {})).status).toBe(401);
});

test('an agent works through MCP with its token and is offered nothing meant for people', async () => {
  const made = (await (await post('/api/call/create_agent', { name: 'dev', about: 'writes code' }, asUser())).json()) as { result: { token: string } };
  token = made.result.token;

  expect((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  expect((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: `Bearer ${token.slice(0, -1)}x` })).status).toBe(401);
  expect((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, asUser())).status).toBe(401);

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  expect(init.result.protocolVersion).toBe('2025-06-18');
  expect(init.result.instructions).toContain('inbox');
  expect((await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, asAgent())).status).toBe(202);

  const tools = (await rpc('tools/list', {})).result.tools as { name: string; inputSchema: { required: string[] } }[];
  const names = tools.map((t) => t.name);
  expect(names).toContain('claim_task');
  expect(names).toContain('report_cost');
  for (const forPeople of ['create_agent', 'approve_agent', 'rotate_token', 'dashboard', 'set_budget']) expect(names).not.toContain(forPeople);
  expect(tools.find((t) => t.name === 'create_task')!.inputSchema.required).toEqual(['title', 'outcome']);

  const created = await rpc('tools/call', { name: 'create_task', arguments: { title: 'Through MCP', outcome: 'a task exists', review: 'optional' } });
  expect(created.result.isError).toBe(false);
  expect(JSON.parse(created.result.content[0].text).id).toBe('T-1');
  const refused = await rpc('tools/call', { name: 'claim_task', arguments: { task: 'T-99' } });
  expect(refused.result.isError).toBe(true);
  expect(refused.result.content[0].text).toStartWith('not_found');
  expect((await rpc('tools/call', { name: 'approve_agent', arguments: { agent: 'dev' } })).error.code).toBe(-32602);
  expect((await post('/api/call/approve_agent', { agent: 'dev' }, asAgent())).status).toBe(403);
  expect((await (await post('/api/call/whoami', {}, asAgent())).json() as any).result.name).toBe('dev');
});

test('the dashboard hears of a change, and only when signed in', async () => {
  const refused = new WebSocket(`${server.url.replace('http', 'ws')}/ws`);
  await new Promise((resolve) => (refused.onerror = refused.onclose = resolve));
  // @ts-expect-error Bun's WebSocket takes headers; the browser sends these by itself.
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws`, { headers: asUser() });
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const heard = new Promise<any>((resolve) => (ws.onmessage = (e) => resolve(JSON.parse(e.data as string))));
  await rpc('tools/call', { name: 'claim_task', arguments: { task: 'T-1' } });
  expect(await heard).toMatchObject({ type: 'task.claimed', subject: 'T-1' });
  ws.close();
});

test('an agent joins with the enrollment key and waits for approval', async () => {
  expect((await post('/api/register', { key: 'rbe_guess', name: 'joiner' })).status).toBe(401);
  const { result } = (await (await post('/api/call/new_enrollment_key', {}, asUser())).json()) as { result: { key: string } };
  const joined = (await (await post('/api/register', { key: result.key, name: 'joiner', about: 'tests things' })).json()) as { result: { token: string; agent: Record<string, unknown> } };
  expect(joined.result.agent.status).toBe('pending');
  expect(joined.result.agent.token).toBeUndefined();
  const mine = { Authorization: `Bearer ${joined.result.token}` };
  expect((await post('/api/call/post_message', { to: '@dev', body: 'hi' }, mine)).status).toBe(403);
  expect((await post('/api/call/approve_agent', { agent: 'joiner' }, asUser())).status).toBe(200);
  expect((await post('/api/call/post_message', { to: '@dev', body: 'hi' }, mine)).status).toBe(200);
});

test('what is not JSON, or too much, is refused', async () => {
  expect((await fetch(`${server.url}/api/call/whoami`, { method: 'POST', headers: asAgent(), body: 'x' })).status).toBe(400);
  expect((await post('/api/call/whoami', 'x'.repeat(300_000), asAgent())).status).toBe(413);
  expect((await fetch(`${server.url}/api/nothing`)).status).toBe(404);
  expect((await fetch(`${server.url}/../../etc/passwd`)).status).toBe(503);
});

test('in unsafe mode nobody signs in, agents join without a key, and an agent is still only an agent', async () => {
  const dir = tempDir();
  const open = openBoard({ ray: await sharedRay(), base: join(dir, 'board') });
  const operator = await open.createUser('operator', 'nobody knows this one');
  const unsafe = startServer({ board: open, host: '127.0.0.1', port: 0, behindProxy: false, ui: dir, log: () => {}, unsafe: operator });
  try {
    const call = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`${unsafe.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect(unsafe.setupCode).toBeNull();
    expect(await (await fetch(`${unsafe.url}/api/session`)).json()).toMatchObject({ unsafe: true, user: { name: 'operator' } });
    // No cookie, no origin, no token: the caller oversees the board.
    expect((await call('/api/call/create_task', { title: 'By anyone', outcome: 'x' })).status).toBe(200);
    const joined = (await (await call('/api/register', { name: 'tester' })).json()) as { result: { token: string; agent: { status: string } } };
    expect(joined.result.agent.status).toBe('active');
    const bearer = { Authorization: `Bearer ${joined.result.token}` };
    expect((await call('/api/call/claim_task', { task: 'T-1' }, bearer)).status).toBe(200);
    expect((await call('/api/call/revoke_agent', { agent: 'tester' }, bearer)).status).toBe(403);
    expect((await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect((await call('/api/login', { name: 'operator', password: 'x' })).status).toBe(409);
    expect((await call('/api/call/revoke_agent', { agent: 'tester' })).status).toBe(200);
    expect((await call('/api/call/whoami', {}, bearer)).status).toBe(401);
  } finally {
    await unsafe.stop();
    open.close();
  }
});
