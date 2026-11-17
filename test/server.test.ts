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


test('an administrator can free an unused person name without losing its identity', async () => {
  const person = await board.createUser('morrow', 'a sufficiently long password', 'member');
  const admin = board.userById((board.people().includes('anton') ? board.store.all('users').find((u: any) => u.name === 'anton')!.id as string : ''))!;
  const renamed = await board.call(admin, 'rename_person', { user: person.id, name: 'morrow-ui' }) as any;
  expect(renamed.id).toBe(person.id);
  expect(renamed.name).toBe('morrow-ui');
  await expect(board.call(admin, 'rename_person', { user: person.id, name: 'anton' })).rejects.toMatchObject({ code: 'conflict' });
  const enrollment = await post('/api/call/new_enrollment_key', {}, asUser());
  const key = ((await enrollment.json()) as { result: { key: string } }).result.key;
  const joined = await post('/api/register', { key, name: 'morrow' }, { Origin: server.url });
  expect(joined.status).toBe(200);
  const registration = ((await joined.json()) as { result: { agent: { id: string; status: string }; token: string } }).result;
  expect(registration.agent.status).toBe('pending');
  await board.call(admin, 'approve_agent', { agent: registration.agent.id });
  expect(board.agentOfToken(registration.token)?.status).toBe('active');
});

test('a person accepts an invitation once, with a role enforced on existing sessions', async () => {
  const invite = await post('/api/call/invite_person', { role: 'member' }, asUser());
  expect(invite.status).toBe(200);
  const { result } = (await invite.json()) as { result: { key: string } };
  expect((await post('/api/join', { key: result.key, name: 'member', password: 'a private passphrase' })).status).toBe(403);
  expect((await post('/api/join', { key: 'rbi_wrong', name: 'member', password: 'a private passphrase' }, { Origin: server.url })).status).toBe(401);
  const joined = await post('/api/join', { key: result.key, name: 'member', password: 'a private passphrase' }, { Origin: server.url });
  expect(joined.status).toBe(200);
  const answer = (await joined.json()) as { user: { id: string; role: string }; csrf: string };
  expect(answer.user.role).toBe('member');
  expect((await post('/api/join', { key: result.key, name: 'other', password: 'a private passphrase' }, { Origin: server.url })).status).toBe(401);
  const memberCookie = joined.headers.get('set-cookie')!.split(';')[0]!;
  const asMember = { Cookie: memberCookie, Origin: server.url, 'X-CSRF-Token': answer.csrf };
  expect((await post('/api/call/create_agent', { name: 'unauthorized' }, asMember)).status).toBe(403);
  expect((await post('/api/call/invite_person', {}, asMember)).status).toBe(403);
  expect((await post('/api/call/create_task', { title: 'Member work', outcome: 'allowed', review: 'optional' }, asMember)).status).toBe(200);
  // A role change takes effect on an existing session without signing in again.
  expect((await post('/api/call/set_role', { user: answer.user.id, role: 'viewer' }, asUser())).status).toBe(200);
  expect((await post('/api/call/post_message', { to: '#general', body: 'not allowed' }, asMember)).status).toBe(403);
  expect((await post('/api/call/get_task', { task: 'T-1' }, asMember)).status).toBe(200);
});
test('a viewer cannot change a profile through a falsely read-only action', async () => {
  const viewer = await board.createUser('profile-viewer', 'a sufficiently long password', 'viewer');
  const actor = board.userById(viewer.id)!;
  const about = 'must not be saved';
  await expect(board.call(actor, 'set_profile', { about })).rejects.toMatchObject({ code: 'forbidden' });
  const found = await fetch(server.url + '/api/call/dashboard', { method: 'POST', headers: { 'Content-Type': 'application/json', ...asUser() }, body: '{}' });
  const dash = (await found.json() as any).result;
  expect(dash.people.find((p: any) => p.id === viewer.id).about ?? '').toBe('');
});

test('an allowed avatar fits the HTTP request limit, unlike an oversized one', async () => {
  const png = Buffer.alloc(322900, 0);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  const r = await fetch(server.url + '/api/avatar', { method: 'POST', headers: { ...asUser(), 'X-Avatar-Type': 'png', 'Content-Type': 'application/octet-stream' }, body: png });
  expect(r.status).toBe(200);
  await board.call(board.userById(board.store.all('users').find((u) => u.name === 'anton')!.id as string)!, 'remove_avatar', {});
  const over = Buffer.alloc(1024 * 1024 + 1, 0);
  const refused = await fetch(server.url + '/api/avatar', { method: 'POST', headers: { ...asUser(), 'X-Avatar-Type': 'png', 'Content-Type': 'application/octet-stream' }, body: over });
  expect(refused.status).toBe(413);
});

test('a person edits their profile and a bounded avatar stays private', async () => {
  const about = 'Works on Rayforce and likes precise tools.';
  const profile = await post('/api/call/set_profile', { about }, asUser());
  expect(profile.status).toBe(200);
  const dash = (await (await post('/api/call/dashboard', {}, asUser())).json()).result;
  expect(dash.people.find((p: any) => p.name === 'anton')).toMatchObject({ about, avatar: '' });
  expect(dash.people[0].pass).toBeUndefined();
  expect((await post('/api/call/set_profile', { about: 'x'.repeat(2001) }, asUser())).status).toBe(400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  expect((await fetch(server.url + '/api/avatar', { method: 'POST', headers: { ...asUser(), 'X-Avatar-Type': 'png', 'Content-Type': 'application/octet-stream' }, body: png })).status).toBe(200);
  const image = (await (await post('/api/call/dashboard', {}, asUser())).json()).result.people[0].avatar;
  const shown = await fetch(server.url + image, { headers: { Cookie: cookie } });
  expect(shown.status).toBe(200);
  expect(shown.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await shown.arrayBuffer()).equals(png)).toBe(true);
  expect((await fetch(server.url + image)).status).toBe(401);
  expect((await fetch(server.url + image.replace(/.$/, (c: string) => c === '0' ? '1' : '0'), { headers: { Cookie: cookie } })).status).toBe(404);
  const fake = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('<script>not executed</script>')]);
  const uploaded = await fetch(server.url + '/api/avatar', { method: 'POST', headers: { ...asUser(), 'X-Avatar-Type': 'png', 'Content-Type': 'application/octet-stream' }, body: fake });
  expect(uploaded.status).toBe(200);
  const next = (await (await post('/api/call/dashboard', {}, asUser())).json()).result.people[0].avatar;
  expect((await fetch(server.url + next, { headers: { Cookie: cookie } })).headers.get('content-security-policy')).toContain('sandbox');
  expect((await fetch(server.url + '/api/avatar', { method: 'POST', headers: { ...asUser(), 'X-Avatar-Type': 'png' }, body: 'not an image' })).status).toBe(400);
});

test('what is not JSON, or too much, is refused', async () => {
  expect((await fetch(`${server.url}/api/call/whoami`, { method: 'POST', headers: asAgent(), body: 'x' })).status).toBe(400);
  const tooLarge = await post('/api/call/whoami', 'x'.repeat(300_000), asAgent());
  expect(tooLarge.status).toBe(413);
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
