import { beforeEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BoardError, openBoard, type Actor, type Board } from '../src/board';
import { startServer } from '../src/server';
import { sharedRay, tempDir } from './helpers';

// The cases of the shared-workspace acceptance plan, each checked against the board's state and
// its audit trail rather than against what a screen shows.

let board: Board;
let dir: string;
let anton: Actor;
let mica: { actor: Actor; token: string };
let morsel: { actor: Actor; token: string };
let outsider: { actor: Actor; token: string };
const open = async (): Promise<Board> => openBoard({ ray: await sharedRay(), base: join(dir, 'board') });
/** Everything RayforceDB keeps of the board on disk: its snapshot, its log, and the logs before the last snapshot. */
const onDisk = (): string => readdirSync(dir).filter((f) => f.startsWith('board.')).map((f) => readFileSync(join(dir, f), 'latin1')).join('');
const agent = async (name: string): Promise<{ actor: Actor; token: string }> => {
  const { token } = (await board.call(anton, 'create_agent', { name })) as { token: string };
  return { actor: board.agentOfToken(token)!, token };
};
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: unknown) => (e instanceof BoardError ? e.code : String(e)));
type Detail = { task: Record<string, any>; thread: Record<string, any>[]; evidence: Record<string, any>[] };
const detail = (who: Actor, task = 'T-1'): Promise<Detail> => board.call(who, 'get_task', { task }) as Promise<Detail>;
const audit = (who: Actor): Promise<Record<string, any>[]> => board.call(who, 'activity', { after: 0, limit: 500 }) as Promise<Record<string, any>[]>;

beforeEach(async () => {
  dir = tempDir();
  board = await open();
  anton = await board.createUser('anton', 'correct horse battery');
  mica = await agent('mica');
  morsel = await agent('morsel');
  outsider = await agent('outsider');
});

test('a task goes from one agent to the other and survives a restart without anything happening twice', async () => {
  // 1. A task with an observable outcome, an owner, participants and a next action.
  await board.call(anton, 'create_channel', { name: 'shared' });
  await board.call(anton, 'create_task', { title: 'Publish the benchmark', outcome: 'The report is linked from the README', assignee: 'mica', participants: 'morsel', next: 'Run the suite on the reference machine', review: 'optional' });

  // 2. Each agent, with its own credential, sees the task and its revision.
  expect(mica.token).not.toBe(morsel.token);
  for (const who of [mica.actor, morsel.actor]) expect((await detail(who)).task).toMatchObject({ rev: 1, outcome: 'The report is linked from the README', assignee: mica.actor.id });

  // 3. Discussion in the thread stays with the task; the shared channel is apart from it.
  await board.call(mica.actor, 'post_message', { to: 'T-1', body: 'Starting the run.' });
  await board.call(morsel.actor, 'post_message', { to: '#shared', body: 'I can take over tomorrow.' });
  expect((await detail(morsel.actor)).thread.map((m) => [m.chan, m.body])).toEqual([['T-1', 'Starting the run.']]);
  expect(((await board.call(mica.actor, 'read_messages', { from: '#shared' })) as { body: string }[]).map((m) => m.body)).toEqual(['I can take over tomorrow.']);

  // 5. One advances it, attaches evidence, records what it did outside, and marks it waiting on something concrete.
  await board.call(mica.actor, 'claim_task', { task: 'T-1' });
  await board.call(mica.actor, 'add_evidence', { task: 'T-1', text: 'Suite ran: 412 cases, log at runs/41.txt' });
  await board.call(mica.actor, 'add_evidence', { task: 'T-1', kind: 'external_action', key: 'open-pr', text: 'Opened PR 12 with the report' });
  expect(await code(board.call(mica.actor, 'hold_task', { task: 'T-1', status: 'waiting' }))).toBe('invalid');
  await board.call(mica.actor, 'hold_task', { task: 'T-1', status: 'waiting', dependency: 'Review of PR 12', next_check: 'PR 12 status, tomorrow 09:00 UTC' });

  // 4. Ownership is handed over explicitly; both agents and the dashboard see one state, and the log says who did it.
  await board.call(mica.actor, 'delegate_task', { task: 'T-1', to: 'morsel', note: 'PR is open, only the merge is left.' });
  const dashboard = (await board.call(anton, 'dashboard', {})) as { tasks: Record<string, any>[] };
  const seen = [(await detail(mica.actor)).task, (await detail(morsel.actor)).task, dashboard.tasks.find((t) => t.id === 'T-1')!];
  for (const t of seen) expect(t).toMatchObject({ assignee: morsel.actor.id, status: 'waiting', rev: seen[0]!.rev, dependency: 'Review of PR 12' });
  expect((await audit(anton)).find((e) => e.type === 'task.delegated')).toMatchObject({ actor: mica.actor.id, subject: 'T-1' });

  // The other resumes it, and is stopped from repeating what was done outside.
  expect(((await board.call(morsel.actor, 'inbox', {})) as { items: { type: string }[] }).items.map((n) => n.type)).toContain('task.assigned');
  await board.call(morsel.actor, 'claim_task', { task: 'T-1' });
  expect((await detail(morsel.actor)).evidence.map((e) => [e.kind, e.key])).toEqual([['evidence', ''], ['external_action', 'open-pr']]);
  expect(await code(board.call(morsel.actor, 'add_evidence', { task: 'T-1', kind: 'external_action', key: 'Open-PR', text: 'Opening the PR' }))).toBe('conflict');

  // 6. After a restart everything is as it was, cursors included, and nothing is there twice.
  const before = { task: await detail(anton), audit: await audit(anton), shared: await board.call(anton, 'read_messages', { from: '#shared' }), dashboard: await board.call(anton, 'dashboard', {}) };
  board.close();
  board = await open();
  const [m2, s2] = [board.agentOfToken(mica.token)!, board.agentOfToken(morsel.token)!];
  expect(await detail(anton)).toEqual(before.task);
  expect(await audit(anton)).toEqual(before.audit);
  expect(await board.call(anton, 'read_messages', { from: '#shared' })).toEqual(before.shared);
  expect({ ...((await board.call(anton, 'dashboard', {})) as object), now: 0, agents: 0 }).toEqual({ ...(before.dashboard as object), now: 0, agents: 0 });
  expect(((await board.call(s2, 'inbox', {})) as { items: unknown[] }).items).toEqual([]);
  // Mica never read its inbox: what was unread before the restart is unread after it, once.
  expect(((await board.call(m2, 'inbox', { peek: true })) as { items: { type: string }[] }).items.map((n) => n.type)).toEqual(['task.assigned']);
});

test('comments made at once are both kept, in an order that does not change', async () => {
  await board.call(anton, 'create_task', { title: 'Talk', outcome: 'talked' });
  const made = (await Promise.all([
    board.call(mica.actor, 'post_message', { to: 'T-1', body: 'from mica' }),
    board.call(morsel.actor, 'post_message', { to: 'T-1', body: 'from morsel' }),
  ])) as { id: string; seq: number }[];
  expect(new Set(made.map((m) => m.id)).size).toBe(2);
  const thread = (await detail(anton)).thread;
  expect(thread.map((m) => m.body)).toEqual(['from mica', 'from morsel']);
  expect(thread.map((m) => m.seq)).toEqual(made.map((m) => m.seq).sort((a, b) => a - b));
  expect((await detail(mica.actor)).thread).toEqual(thread);
});

test('a change decided on an old revision is refused, and the task is as the first writer left it', async () => {
  await board.call(anton, 'create_task', { title: 'Old title', outcome: 'x', assignee: 'mica' });
  expect(await code(board.call(mica.actor, 'update_task', { task: 'T-1', title: 'no revision given' }))).toBe('invalid');
  await board.call(anton, 'update_task', { task: 'T-1', rev: 1, title: 'Title by anton' });
  expect(await code(board.call(mica.actor, 'update_task', { task: 'T-1', rev: 1, title: 'Title by mica' }))).toBe('conflict');
  expect(await code(board.call(mica.actor, 'claim_task', { task: 'T-1', rev: 1 }))).toBe('conflict');
  const current = (await detail(mica.actor)).task;
  expect(current).toMatchObject({ title: 'Title by anton', rev: 2 });
  await board.call(mica.actor, 'update_task', { task: 'T-1', rev: current.rev, next: 'reread, then decide' });
  expect((await detail(anton)).task).toMatchObject({ title: 'Title by anton', next: 'reread, then decide', rev: 3 });
});

test('a repeated request id is answered with the first receipt, also after a restart, and never for another request', async () => {
  await board.call(anton, 'create_task', { title: 'Once', outcome: 'x' });
  const request = { to: 'T-1', body: 'said once', request_id: 'mica-0001' };
  const first = await board.call(mica.actor, 'post_message', request);
  expect(await board.call(mica.actor, 'post_message', request)).toEqual(first);
  board.close();
  board = await open();
  const again = board.agentOfToken(mica.token)!;
  expect(await board.call(again, 'post_message', request)).toEqual(first);
  expect((await detail(anton)).thread.length).toBe(1);
  expect(await code(board.call(again, 'post_message', { ...request, body: 'something else' }))).toBe('conflict');
  // The id belongs to whoever used it: another actor's request with the same id is its own request.
  await board.call(board.agentOfToken(morsel.token)!, 'post_message', request);
  expect((await detail(anton)).thread.length).toBe(2);
  expect(await code(board.call(anton, 'create_agent', { name: 'again', request_id: 'anton-0001' }))).toBe('invalid');
  // The board is RayforceDB's own files and nothing else.
  expect(readdirSync(dir).filter((f) => !f.startsWith('rayboard-')).every((f) => /^board\.(qdb|lk|log|.+\.log)$/.test(f))).toBe(true);
  expect(onDisk()).toContain('said once');
});

test('the audit log is followed by cursor without a gap', async () => {
  for (let i = 0; i < 7; i++) await board.call(mica.actor, 'create_task', { title: `Task ${i}`, outcome: 'x' });
  const all = await audit(anton);
  const paged: number[] = [];
  for (let after = 0; ;) {
    const page = (await board.call(anton, 'activity', { after, limit: 3 })) as { seq: number }[];
    paged.push(...page.map((e) => e.seq));
    if (page.length < 3) break;
    after = page.at(-1)!.seq;
  }
  expect(paged).toEqual(all.map((e) => e.seq));
  expect(paged).toEqual([...paged].sort((a, b) => a - b));
});

test('done needs evidence, and nothing an agent can call edits or removes the audit log', async () => {
  await board.call(anton, 'create_task', { title: 'Prove it', outcome: 'x', assignee: 'mica', review: 'optional' });
  await board.call(mica.actor, 'claim_task', { task: 'T-1' });
  expect(await code(board.call(mica.actor, 'complete_task', { task: 'T-1' }))).toBe('invalid');
  expect(await code(board.call(mica.actor, 'complete_task', { task: 'T-1', result: '   ' }))).toBe('invalid');
  await board.call(mica.actor, 'complete_task', { task: 'T-1', result: 'Report at docs/bench.md, commit 4f2a' });
  expect((await detail(anton)).task).toMatchObject({ status: 'done', result: 'Report at docs/bench.md, commit 4f2a' });
  const offered = Object.entries(board.actions).filter(([, a]) => a.who !== 'user').map(([name]) => name);
  expect(offered.filter((name) => /delete|remove|purge|edit_(event|audit)|update_(event|message|evidence)/.test(name))).toEqual([]);
});

test('a private task, its thread and its audit entries exist only for its parties', async () => {
  await board.call(anton, 'create_task', { title: 'Public work', outcome: 'x' });
  await board.call(anton, 'create_task', { title: 'Secret work', outcome: 'x', assignee: 'mica', participants: 'morsel', private: true });
  await board.call(mica.actor, 'claim_task', { task: 'T-2' });
  await board.call(mica.actor, 'post_message', { to: 'T-2', body: 'the secret plan, @outsider should not hear of it' });
  await board.call(mica.actor, 'report_cost', { usd: 1, task: 'T-2' });
  await board.call(mica.actor, 'request_review', { task: 'T-2', note: 'please look' });

  const o = outsider.actor;
  expect(await code(board.call(o, 'get_task', { task: 'T-2' }))).toBe('not_found');
  expect(await code(board.call(o, 'get_task', { task: 'T-999' }))).toBe('not_found');
  expect(await code(board.call(o, 'read_messages', { from: 'T-2' }))).toBe('not_found');
  expect(await code(board.call(o, 'post_message', { to: 'T-2', body: 'hello?' }))).toBe('not_found');
  expect(await code(board.call(o, 'claim_task', { task: 'T-2' }))).toBe('not_found');
  expect(await code(board.call(o, 'review_task', { task: 'T-2', verdict: 'approve' }))).toBe('not_found');
  expect(await code(board.call(o, 'create_task', { title: 'part', outcome: 'x', parent: 'T-2' }))).toBe('not_found');
  expect(((await board.call(o, 'list_tasks', { status: 'all' })) as { id: string }[]).map((t) => t.id)).toEqual(['T-1']);
  expect(await board.call(o, 'list_reviews', {})).toEqual([]);
  expect(((await board.call(o, 'inbox', {})) as { items: unknown[] }).items).toEqual([]);
  const seen = JSON.stringify(await audit(o));
  expect(seen).not.toContain('T-2');
  expect(seen).not.toContain('Secret');
  expect(seen).toContain('T-1');

  // A participant sees all of it, and so do the people overseeing the board.
  for (const who of [morsel.actor, anton]) {
    expect((await detail(who, 'T-2')).thread.length).toBe(1);
    expect(JSON.stringify(await audit(who))).toContain('T-2');
  }
  // A participant cannot make itself more than it is.
  expect(await code(board.call(morsel.actor, 'update_task', { task: 'T-2', rev: (await detail(morsel.actor, 'T-2')).task.rev, private: false }))).toBe('forbidden');
  expect(await code(board.call(morsel.actor, 'cancel_task', { task: 'T-2' }))).toBe('forbidden');
  expect(await code(board.call(morsel.actor, 'approve_agent', { agent: 'outsider' }))).toBe('forbidden');
});

test('a revoked token and a changed password end access at once, and no GET changes anything', async () => {
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dir, log: () => {} });
  try {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`${server.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const signIn = async (password: string): Promise<Record<string, string>> => {
      const res = await post('/api/login', { name: 'anton', password }, { Origin: server.url });
      return { Cookie: res.headers.get('set-cookie')!.split(';')[0]!, Origin: server.url, 'X-CSRF-Token': ((await res.json()) as { csrf: string }).csrf };
    };
    const here = await signIn('correct horse battery');
    const elsewhere = await signIn('correct horse battery');

    const bearer = { Authorization: `Bearer ${mica.token}` };
    const ping = (): Promise<Response> => post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, bearer);
    expect((await ping()).status).toBe(200);
    expect((await post('/api/call/revoke_agent', { agent: 'mica' }, here)).status).toBe(200);
    expect((await ping()).status).toBe(401);
    expect((await post('/api/call/whoami', {}, bearer)).status).toBe(401);
    // A bearer token is no session and a session is no bearer token.
    expect((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, here)).status).toBe(401);
    expect((await post('/api/call/dashboard', {}, { Authorization: `Bearer ${here.Cookie.split('=')[1]}` })).status).toBe(401);

    const events = (await audit(anton)).length;
    for (const path of ['/api/call/create_channel?name=viaget', '/api/call/whoami', '/api/logout', '/api/password', '/mcp']) {
      expect([404, 405]).toContain((await fetch(`${server.url}${path}`, { headers: here })).status);
    }
    expect((await audit(anton)).length).toBe(events);

    expect((await post('/api/password', { current: 'not the password', next: 'a new long password' }, here)).status).toBe(401);
    expect((await post('/api/password', { current: 'correct horse battery', next: 'a new long password' }, here)).status).toBe(200);
    for (const session of [here, elsewhere]) expect((await post('/api/call/dashboard', {}, session)).status).toBe(401);
    expect((await post('/api/login', { name: 'anton', password: 'correct horse battery' }, { Origin: server.url })).status).toBe(401);
    expect((await post('/api/call/dashboard', {}, await signIn('a new long password'))).status).toBe(200);

    // Neither a password nor a token is ever written in the clear.
    const kept = onDisk();
    expect(kept).toContain('anton');
    for (const secret of ['correct horse battery', 'a new long password', mica.token, morsel.token]) expect(kept).not.toContain(secret);
  } finally {
    await server.stop();
  }
});
