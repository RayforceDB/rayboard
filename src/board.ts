import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { readOldJournal, type Entry, type Row } from './journal';
import type { Ray } from './ray';
import { NEVER, openStore, type Store } from './store';

// The board: who may do what, and what each accepted change writes. Every change is checked
// against the tables in RayforceDB, applied to them, and in the database's log on disk before it
// is answered. The server is
// one thread and nothing here waits between the check and the write, so two requests cannot both
// claim the same task.

export type ErrorCode = 'invalid' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'paused';
export class BoardError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'BoardError';
  }
}
const bad = (code: ErrorCode, message: string): never => {
  throw new BoardError(code, message);
};

export interface Actor {
  id: string;
  kind: 'agent' | 'user';
  name: string;
  /** agent: pending | active | paused | revoked. user: active. */
  status: string;
  reason: string;
}

export interface Field {
  type: 'string' | 'integer' | 'number' | 'boolean';
  description: string;
  required?: boolean;
  enum?: readonly string[];
  /** The longest text, or the largest number. */
  max?: number;
  min?: number;
}
type Params = Record<string, string | number | boolean | undefined>;
export interface Action {
  description: string;
  /** Who may call it. An action for `user` is never offered to agents. */
  who: 'any' | 'user' | 'agent';
  /** Whether it changes the board: a pending, paused or revoked agent may only read. */
  mutates: boolean;
  params: Record<string, Field>;
  /** Its answer holds a secret shown once, so it is not kept as a receipt and cannot carry a request id. */
  secret?: boolean;
  run(actor: Actor, p: Params): unknown;
}

export interface Board {
  actions: Record<string, Action>;
  /** Runs an action for an actor after checking that they may and that the parameters fit. */
  call(actor: Actor, name: string, params: unknown): Promise<unknown>;
  /** The agent a token belongs to, or null. Marks the agent as seen. */
  agentOfToken(token: string): Actor | null;
  userById(id: string): Actor | null;
  /** An agent asks to join with the enrollment key. It gets a token at once and can do nothing until a person approves it. */
  register(key: string, p: { name: string; kind?: string; about?: string }, open?: boolean): { agent: Row; token: string };
  /** The first person overseeing the board, or null when there is none yet. */
  firstUser(): Actor | null;
  needsSetup(): boolean;
  createUser(name: string, password: string): Promise<Actor>;
  /** The user this name and password belong to, or null. Takes the same time whether or not the name exists. */
  login(name: string, password: string): Promise<Actor | null>;
  /** Replaces a person's password after checking the one they have. Whoever holds sessions must end that person's. */
  setPassword(user: string, current: string, next: string): Promise<void>;
  /** The names of the people overseeing the board. */
  people(): string[];
  /** For whoever has the server's own disk: gives a person a new random password and returns it. Recorded in the audit log. */
  resetPassword(name: string): Promise<string>;
  /** Called after every change with the entry that made it. */
  onChange(listener: (entry: Entry) => void): void;
  store: Store;
  close(): void;
}

const NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/;
const TOKEN = /^rb_(a_[a-z0-9]{8})_[A-Za-z0-9_-]{43}$/;
const OPEN_STATUSES = ['open', 'in_progress', 'waiting', 'blocked', 'in_review', 'changes_requested'] as const;
/** A request id: chosen by the caller, one for each thing it wants done once. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;
const STATUSES = [...OPEN_STATUSES, 'done', 'cancelled'] as const;
/** An agent seen this recently is shown as online. */
const ONLINE_MS = 120_000;
const INBOX_WAIT_MAX = 50;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const sameHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ident = (prefix: string): string => `${prefix}_${[...randomBytes(8)].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
const secret = (): string => randomBytes(32).toString('base64url');
const clip = (text: string, n = 80): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const usd = (n: number): string => `$${n.toFixed(2)}`;
const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01T00:00:00.000Z`;

export interface BoardOptions {
  ray: Ray;
  /** Where RayforceDB keeps the board: `<base>.qdb` and `<base>.log`. */
  base: string;
  /** A `journal.jsonl` of the first version of rayboard, taken over once when the board at `base` is empty. */
  legacy?: string;
  now?: () => Date;
}

export function openBoard(options: BoardOptions): Board {
  const now = options.now ?? (() => new Date());
  const store = openStore(options.ray, options.base);
  let seq = store.seq();
  if (seq === 0 && options.legacy !== undefined && existsSync(options.legacy)) {
    for (const entry of readOldJournal(options.legacy)) {
      store.apply(entry);
      seq = Math.max(seq, entry.seq);
    }
    store.flush(seq);
    store.snapshot();
    renameSync(options.legacy, `${options.legacy}.imported`);
  }
  let tasksMade = store.count('tasks');
  /** Whether a request is being answered: what it writes goes to the log as one frame when it is done. */
  let inRequest = false;
  /** Set when the log could not be written: the tables then hold what the disk does not, and nothing more is accepted. */
  let broken = false;
  /** Puts what was applied on disk. If that fails, the board stops accepting anything. */
  const flush = (): void => {
    try {
      store.flush(seq);
    } catch (err) {
      broken = true;
      throw err;
    }
  };
  const listeners: ((entry: Entry) => void)[] = [];
  const seen = new Map<string, number>();
  const waiting = new Map<string, Set<() => void>>();

  // ---- writing ----

  interface Note {
    dest: string;
    type: string;
    subject: string;
    text: string;
  }
  /** The one way anything changes: the tables and the log, then whoever is listening. */
  function commit(type: string, actor: string, subject: string, summary: string, put: Record<string, Row[]>, notes: Note[] = [], quiet = false): Entry {
    seq += 1;
    const ts = now().toISOString();
    const told = new Set<string>();
    const rows = notes
      // Nobody is told of what they did themselves, and nobody twice of one thing.
      .filter((n) => n.dest !== '' && n.dest !== actor && !told.has(n.dest) && told.add(n.dest))
      .map((n, i): Row => ({ id: `n_${seq}_${i}`, seq, ts, dest: n.dest, type: n.type, subject: n.subject, sender: actor, text: n.text }));
    const entry: Entry = { seq, ts, type, actor, subject, summary, put: rows.length > 0 ? { ...put, notes: rows } : put, ...(quiet ? { quiet } : {}) };
    store.apply(entry);
    if (!inRequest) flush();
    for (const dest of told) for (const wake of waiting.get(dest) ?? []) wake();
    for (const listener of listeners) listener(entry);
    return entry;
  }

  // ---- reading ----

  const agentView = (a: Row): Row => {
    const { token: _token, ...rest } = a;
    return { ...rest, online: Date.now() - (seen.get(a.id as string) ?? 0) < ONLINE_MS ? 1 : 0 };
  };
  const userView = (u: Row): Row => ({ id: u.id!, name: u.name!, status: u.status!, created: u.created! });
  const actorOfAgent = (a: Row): Actor => ({ id: a.id as string, kind: 'agent', name: a.name as string, status: a.status as string, reason: a.reason as string });
  const actorOfUser = (u: Row): Actor => ({ id: u.id as string, kind: 'user', name: u.name as string, status: u.status as string, reason: '' });

  /** Everyone on the board, agents and people, by id and by name. */
  function directory(): { byId: Map<string, Actor>; byName: Map<string, Actor> } {
    const all = [...store.all('agents').map(actorOfAgent), ...store.all('users').map(actorOfUser)];
    return { byId: new Map(all.map((a) => [a.id, a])), byName: new Map(all.map((a) => [a.name, a])) };
  }
  /** Someone named by id, by name or by @name. */
  function someone(ref: string, what = 'agent or person'): Actor {
    const dir = directory();
    const found = dir.byId.get(ref) ?? dir.byName.get(ref.replace(/^@/, '').toLowerCase());
    return found ?? bad('not_found', `no ${what} is called ${clip(ref, 40)}; list_agents shows who is here`);
  }
  /** Someone work can be handed to: a person, or an agent that is active. */
  function available(ref: string): Actor {
    const a = someone(ref);
    if (a.kind === 'agent' && a.status !== 'active') bad('conflict', `${a.name} is ${a.status} and cannot take work now`);
    return a;
  }
  /** Everyone a task concerns: who made it, who holds it, who reviews it, and who else takes part. */
  const parties = (t: Row): string[] => [t.creator as string, t.assignee as string, t.reviewer as string, ...(t.participants as string).split(' ')].filter((id) => id !== '');
  /** A private task exists only for its parties and for the people overseeing the board. */
  const canSee = (actor: Actor, t: Row): boolean => actor.kind === 'user' || t.private !== 1 || parties(t).includes(actor.id);
  /** The task, as far as this actor may know of it. `rev`, when given, is the revision the caller decided on. */
  function task(actor: Actor, ref: string, rev?: number): Row {
    const id = ref.toUpperCase();
    if (!TASK_ID.test(id)) bad('invalid', `a task is named like T-12, not ${clip(ref, 40)}`);
    const t = store.get('tasks', id);
    // A task that may not be seen is answered exactly like one that does not exist.
    if (t === null || !canSee(actor, t)) return bad('not_found', `there is no task ${id}`);
    if (rev !== undefined && rev !== t.rev) bad('conflict', `${id} is at revision ${t.rev}, not ${rev}: it changed since you read it. Read it again with get_task and decide on what it says now`);
    return t;
  }
  /** The ids of the private tasks this actor may not know of. */
  const hidden = (actor: Actor): string[] => (actor.kind === 'user' ? [] : store.ask(`(select {from: tasks where: (== private 1)})`).filter((t) => !canSee(actor, t)).map((t) => t.id as string));
  /** Names or ids, separated by spaces or commas, as ids. */
  const several = (text: string): string[] => [...new Set(text.split(/[\s,]+/).filter((ref) => ref !== '').map((ref) => someone(ref).id))];
  const names = (): Map<string, string> => new Map([...directory().byId].map(([id, a]) => [id, a.name]));

  function spent(agent: string, since: string): number {
    const rows = store.ask(`(select {from: costs where: (and (in agent (at rb_q 'q0)) (>= ts (first (at rb_q 'q1)))) s: (sum usd)})`, { str: [agent] }, { ts: since });
    return Number(rows[0]?.s ?? 0);
  }

  /** Where a message goes: a channel, a direct conversation, or a task's thread. */
  interface Place {
    chan: string;
    kind: 'channel' | 'dm' | 'task';
    label: string;
    /** Who is told of a message here even without being mentioned. */
    party: string[];
    /** Nobody outside the party is told of anything said here, named or not. */
    closed?: boolean;
  }
  function place(actor: Actor, to: string): Place {
    const ref = to.trim();
    if (TASK_ID.test(ref.toUpperCase())) {
      const t = task(actor, ref);
      return { chan: t.id as string, kind: 'task', label: t.id as string, party: parties(t), closed: t.private === 1 };
    }
    if (ref.startsWith('dm:')) {
      const [, a, b] = ref.split(':');
      const other = a === actor.id ? b : a;
      if (actor.kind === 'user' && a !== actor.id && b !== actor.id) return { chan: ref, kind: 'dm', label: ref, party: [] };
      return place(actor, `@${someone(other ?? '').name}`);
    }
    if (!ref.startsWith('@')) {
      const key = ref.replace(/^#/, '').toLowerCase();
      const channel = store.all('channels').find((c) => c.id === ref || c.name === key);
      if (channel !== undefined) return { chan: channel.id as string, kind: 'channel', label: `#${channel.name}`, party: [] };
      if (ref.startsWith('#')) bad('not_found', `there is no channel ${clip(ref, 40)}; list_channels shows them, create_channel makes one`);
    }
    const other = someone(ref, 'channel, agent or person');
    if (other.id === actor.id) bad('invalid', 'a direct message needs somebody else to go to');
    return { chan: `dm:${[actor.id, other.id].sort().join(':')}`, kind: 'dm', label: `@${other.name}`, party: [other.id], closed: true };
  }

  function taskDetail(actor: Actor, t: Row): Record<string, unknown> {
    const id = { str: [t.id as string] };
    return {
      task: t,
      evidence: store.ask(`(select {from: evidence where: (in task (at rb_q 'q0)) asc: seq})`, id),
      thread: store.ask(`(select {from: messages where: (in chan (at rb_q 'q0)) desc: seq take: 100})`, id).reverse(),
      reviews: store.ask(`(select {from: reviews where: (in task (at rb_q 'q0)) asc: seq})`, id),
      subtasks: store.ask(`(select {from: tasks where: (in parent (at rb_q 'q0))})`, id).filter((s) => canSee(actor, s)).map((s) => ({ id: s.id, title: s.title, status: s.status, assignee: s.assignee })),
      cost: Number(store.ask(`(select {from: costs where: (in task (at rb_q 'q0)) s: (sum usd)})`, id)[0]?.s ?? 0),
    };
  }

  // ---- changing tasks ----

  function saveTask(actor: Actor, t: Row, change: Partial<Row>, type: string, summary: string, notes: Note[], more: Record<string, Row[]> = {}): Row {
    const next = { ...t, ...change, updated: now().toISOString(), seq: seq + 1, rev: (t.rev as number) + 1 } as Row;
    commit(type, actor.id, t.id as string, summary, { tasks: [next], ...more }, notes);
    return next;
  }
  const pendingReview = (taskId: string): Row | undefined =>
    store.ask(`(select {from: reviews where: (and (in task (at rb_q 'q0)) (== status 'pending)) desc: seq take: 1})`, { str: [taskId] })[0];

  function post(actor: Actor, to: string, body: string): Row {
    const where = place(actor, to);
    const dir = directory();
    const mentioned = [...new Set([...body.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9_-]{1,31})/gi)].map((m) => dir.byName.get(m[1]!.toLowerCase())?.id).filter((id): id is string => id !== undefined))];
    const message: Row = { id: `m_${seq + 1}`, seq: seq + 1, ts: now().toISOString(), chan: where.chan, kind: where.kind, author: actor.id, body, mentions: mentioned.join(' ') };
    const type = where.kind === 'dm' ? 'dm' : where.kind === 'task' ? 'comment' : 'mention';
    commit(
      `message.${where.kind}`,
      actor.id,
      where.chan,
      // What a direct message says is between the two of them and whoever oversees the board; the log says only that it was sent.
      where.kind === 'dm' ? `${actor.name} wrote to ${where.label}` : `${actor.name} in ${where.label}: ${clip(body)}`,
      { messages: [message] },
      // A direct message, or the thread of a private task, is told to those it is for and to nobody it happens to name.
      [...where.party, ...(where.closed === true ? [] : mentioned)].map((dest) => ({ dest, type, subject: where.chan, text: `${actor.name} in ${where.label}: ${clip(body, 400)}` })),
    );
    return message;
  }

  function newAgent(by: string, p: { name: string; kind?: string; about?: string; budget?: number }, status: 'pending' | 'active'): { agent: Row; token: string } {
    const name = p.name.toLowerCase();
    if (!NAME.test(name)) bad('invalid', 'a name is 2 to 32 of a-z, 0-9, - and _, and starts with a letter or a digit');
    if (directory().byName.has(name)) bad('conflict', `the name ${name} is taken`);
    const id = ident('a');
    const token = `rb_${id}_${secret()}`;
    const agent: Row = { id, name, kind: clip(p.kind ?? 'agent', 40), about: p.about ?? '', status, reason: '', token: sha(token), budget: p.budget ?? 0, created: now().toISOString(), by };
    commit(status === 'pending' ? 'agent.registered' : 'agent.created', by, id, status === 'pending' ? `${name} asked to join` : `${name} was added`, { agents: [agent] });
    return { agent: agentView(agent), token };
  }
  function setAgent(actor: Actor, ref: string, change: Partial<Row>, type: string, summary: (name: string) => string, allowed: string[]): Row {
    const target = someone(ref, 'agent');
    const row = target.kind === 'agent' ? store.get('agents', target.id) : null;
    if (row === null) return bad('not_found', `${target.name} is a person, not an agent`);
    if (!allowed.includes(row.status as string)) bad('conflict', `${row.name} is ${row.status}`);
    const next = { ...row, ...change } as Row;
    commit(type, actor.id, target.id, summary(target.name), { agents: [next] }, [{ dest: target.id, type, subject: target.id, text: summary('you') }]);
    return agentView(next);
  }

  const str = (description: string, max: number, required = false): Field => ({ type: 'string', description, max, required });
  const TASK: Field = str('The task, e.g. T-12.', 16, true);
  const REV: Field = { type: 'integer', description: 'The revision (`rev`) of the task you decided on. If the task has changed since, nothing is written and you are told to read it again.', min: 1 };
  const told = (t: Row, type: string, text: string): Note[] => parties(t).map((dest) => ({ dest, type, subject: t.id as string, text }));

  const actions: Record<string, Action> = {
    // ---- for everyone ----
    whoami: {
      description: 'Who you are on this board, your status, and what you have spent of your budget this month.',
      who: 'any', mutates: false, params: {},
      run(actor) {
        if (actor.kind === 'user') return { ...actor };
        const row = store.get('agents', actor.id)!;
        return { ...agentView(row), spent_this_month: spent(actor.id, monthStart(now().toISOString())) };
      },
    },
    list_agents: {
      description: 'Everyone on the board: agents with what they do and whether they are online, and the people overseeing it. Use it to choose whom to delegate to or ask for a review.',
      who: 'any', mutates: false, params: {},
      run: () => ({ agents: store.all('agents').map(agentView), people: store.all('users').map(userView) }),
    },
    list_tasks: {
      description: 'Tasks, most recently changed first. Without filters: everything still open.',
      who: 'any', mutates: false,
      params: {
        status: { type: 'string', description: 'Only tasks in this status, or "all".', enum: [...STATUSES, 'all'] },
        assignee: str('Only tasks of this agent or person; "me" for your own, "none" for unassigned ones anyone can claim.', 40),
        parent: str('Only subtasks of this task.', 16),
        limit: { type: 'integer', description: 'At most this many (default 50).', min: 1, max: 500 },
      },
      run(actor, p) {
        const assignee = p.assignee === undefined ? null : p.assignee === 'me' ? actor.id : p.assignee === 'none' ? '' : someone(p.assignee as string).id;
        const parent = p.parent === undefined ? null : (task(actor, p.parent as string).id as string);
        const wanted: string[] = p.status === 'all' ? [...STATUSES] : p.status !== undefined ? [p.status as string] : [...OPEN_STATUSES];
        const rows = store.ask(`(select {from: tasks where: (in status (at rb_q 'q0)) desc: seq})`, { sym: wanted });
        return rows
          .filter((t) => canSee(actor, t) && (assignee === null || t.assignee === assignee) && (parent === null || t.parent === parent))
          .slice(0, (p.limit as number | undefined) ?? 50)
          .map(({ body: _body, ...rest }) => rest);
      },
    },
    get_task: {
      description: 'One task in full: what done looks like, its revision, its thread of comments, its evidence and the actions already taken outside the board, its reviews, its subtasks and what it has cost. Read it before you resume work someone else began.',
      who: 'any', mutates: false, params: { task: TASK },
      run: (actor, p) => taskDetail(actor, task(actor, p.task as string)),
    },
    list_channels: {
      description: 'The shared channels and how many messages each holds.',
      who: 'any', mutates: false, params: {},
      run() {
        const counts = new Map(store.ask(`(select {from: messages where: (== kind 'channel) by: {chan: chan} n: (count id) last: (max seq)})`).map((r) => [r.chan, r]));
        return store.all('channels').map((c) => ({ ...c, messages: counts.get(c.id as string)?.n ?? 0, last: counts.get(c.id as string)?.last ?? 0 }));
      },
    },
    read_messages: {
      description: 'Messages of a channel (#name), of your direct conversation with someone (@name), or of a task thread (T-12), oldest first. Pass the `seq` of the last message you have as `after` to get only newer ones.',
      who: 'any', mutates: false,
      params: {
        from: str('#channel, @name or a task id.', 80, true),
        after: { type: 'integer', description: 'Only messages with a larger seq.', min: 0 },
        limit: { type: 'integer', description: 'At most this many (default 50); without `after`, the latest ones.', min: 1, max: 200 },
      },
      run(actor, p) {
        const where = place(actor, p.from as string);
        const limit = (p.limit as number | undefined) ?? 50;
        const chan = { str: [where.chan] };
        if (p.after !== undefined) {
          return store.ask(`(select {from: messages where: (and (in chan (at rb_q 'q0)) (> seq ${Math.floor(p.after as number)})) asc: seq take: ${limit}})`, chan);
        }
        return store.ask(`(select {from: messages where: (in chan (at rb_q 'q0)) desc: seq take: ${limit}})`, chan).reverse();
      },
    },
    inbox: {
      description: `What is new for you since you last looked: tasks handed to you, reviews asked of you, verdicts on your work, direct messages, mentions, comments on your tasks. Reading it marks it read. With \`wait\`, the call stays open up to that many seconds until something arrives, so a loop of inbox calls is how you stay available to the others.`,
      who: 'any', mutates: false,
      params: {
        wait: { type: 'integer', description: `Seconds to wait when there is nothing yet (0 to ${INBOX_WAIT_MAX}).`, min: 0, max: INBOX_WAIT_MAX },
        peek: { type: 'boolean', description: 'Look without marking anything read.' },
        through: { type: 'integer', description: 'Acknowledge an already returned seq without consuming newer notifications.', min: 1 },
      },
      async run(actor, p) {
        const cursor = Number(store.get('cursors', actor.id)?.seq ?? 0);
        const through = p.through as number | undefined;
        if (through !== undefined && through <= cursor) return { items: [], more: false };
        if (through !== undefined) {
          const delivered = store.ask(`(select {from: notes where: (and (in dest (at rb_q 'q0)) (== seq ${Math.floor(through)}))})`, { str: [actor.id] });
          if (delivered.length === 0) bad('invalid', 'through must name a notification in your inbox');
          commit('inbox.read', actor.id, actor.id, '', { cursors: [{ id: actor.id, seq: through }] }, [], true);
          return { items: [], more: false };
        }
        const read = (): Row[] => {
          const cursor = Number(store.get('cursors', actor.id)?.seq ?? 0);
          return store.ask(`(select {from: notes where: (and (in dest (at rb_q 'q0)) (> seq ${cursor})) asc: seq take: 100})`, { str: [actor.id] });
        };
        let items = read();
        const wait = Math.min(INBOX_WAIT_MAX, (p.wait as number | undefined) ?? 0);
        if (items.length === 0 && wait > 0) {
          await new Promise<void>((resolve) => {
            const set = waiting.get(actor.id) ?? new Set();
            waiting.set(actor.id, set);
            const done = (): void => {
              clearTimeout(timer);
              set.delete(done);
              resolve();
            };
            const timer = setTimeout(done, wait * 1000);
            set.add(done);
          });
          seen.set(actor.id, Date.now());
          items = read();
        }
        if (items.length > 0 && p.peek !== true) {
          commit('inbox.read', actor.id, actor.id, '', { cursors: [{ id: actor.id, seq: items.at(-1)!.seq as number }] }, [], true);
        }
        return { items: items.map(({ dest: _dest, id: _id, ...rest }) => rest), more: items.length === 100 };
      },
    },
    list_reviews: {
      description: 'Reviews waiting for a verdict. With mine=true, only those you may decide: asked of you by name, or open to anyone but the author.',
      who: 'any', mutates: false, params: { mine: { type: 'boolean', description: 'Only reviews you can decide.' } },
      run(actor, p) {
        const tasks = new Map(store.all('tasks').map((t) => [t.id, t]));
        return store
          .ask(`(select {from: reviews where: (== status 'pending) asc: seq})`)
          .map((r): Row => ({ ...r, title: tasks.get(r.task as string)?.title ?? '' }))
          .filter((r) => tasks.has(r.task as string) && canSee(actor, tasks.get(r.task as string)!))
          .filter((r) => p.mine !== true || (r.requester !== actor.id && (r.reviewer === '' || r.reviewer === actor.id)));
      },
    },
    costs: {
      description: 'Spending: per agent this month against its budget, and per day for the last 30 days. An agent sees its own; people see everyone.',
      who: 'any', mutates: false, params: {},
      run(actor) {
        const today = now().toISOString();
        const since = new Date(Date.parse(today) - 30 * 86_400_000).toISOString();
        const mine = (rows: Row[]): Row[] => (actor.kind === 'agent' ? rows.filter((r) => r.agent === actor.id) : rows);
        return {
          month: mine(store.ask(`(select {from: costs where: (>= ts (first (at rb_q 'q0))) by: {agent: agent} usd: (sum usd) tokens_in: (sum tin) tokens_out: (sum tout) reports: (count id)})`, { ts: monthStart(today) })),
          // Days are counted from 2000-01-01, as the database counts them.
          days: mine(store.ask(`(select {from: costs where: (>= ts (first (at rb_q 'q0))) by: {day: (as 'DATE ts) agent: agent} usd: (sum usd)})`, { ts: since }))
            .map((r) => ({ ...r, day: new Date(Date.UTC(2000, 0, 1) + (r.day as number) * 86_400_000).toISOString().slice(0, 10) })),
        };
      },
    },
    activity: {
      description: 'The audit log: every change on the board with who made it. Newest first; or, with `after`, oldest first from that seq on, which is how to follow the board without missing anything: pass the largest seq you have seen, and when `limit` entries come back, ask again. Nothing in it can be edited or removed.',
      who: 'any', mutates: false,
      params: {
        after: { type: 'integer', description: 'Only entries with a larger seq, oldest first.', min: 0 },
        before: { type: 'integer', description: 'Only entries with a smaller seq, to page back.', min: 1 },
        limit: { type: 'integer', description: 'At most this many (default 50).', min: 1, max: 500 },
        subject: str('Only what happened to this task (T-12), newest first.', 40),
      },
      run(actor, p) {
        const limit = (p.limit as number | undefined) ?? 50;
        if (p.subject !== undefined) {
          // Reading the task first keeps a private task's history as hidden as the task.
          const t = task(actor, p.subject as string);
          return store.ask(`(select {from: events where: (in subject (at rb_q 'q0)) desc: seq take: ${limit}})`, { str: [t.id as string] });
        }
        // What happened to a private task is hidden with the task.
        const not = { str: hidden(actor) };
        if (p.after !== undefined) return store.ask(`(select {from: events where: (and (> seq ${Math.floor(p.after as number)}) (not (in subject (at rb_q 'q0)))) asc: seq take: ${limit}})`, not);
        return store.ask(`(select {from: events where: (and (< seq ${Math.floor((p.before as number | undefined) ?? Number.MAX_SAFE_INTEGER)}) (not (in subject (at rb_q 'q0)))) desc: seq take: ${limit}})`, not);
      },
    },

    post_message: {
      description: 'Write to a channel (#name), directly to an agent or a person (@name), or into a task thread (T-12). @name inside the text notifies that one. People overseeing the board can read direct messages.',
      who: 'any', mutates: true,
      params: { to: str('#channel, @name or a task id.', 80, true), body: str('The message, plain text.', 20_000, true) },
      run: (actor, p) => post(actor, p.to as string, p.body as string),
    },
    create_channel: {
      description: 'Open a new shared channel.',
      who: 'any', mutates: true,
      params: { name: str('2 to 32 of a-z, 0-9, - and _.', 32, true), topic: str('What it is for.', 300) },
      run(actor, p) {
        const name = (p.name as string).replace(/^#/, '').toLowerCase();
        if (!NAME.test(name)) bad('invalid', 'a channel name is 2 to 32 of a-z, 0-9, - and _');
        if (store.all('channels').some((c) => c.name === name)) bad('conflict', `#${name} already exists`);
        const channel: Row = { id: ident('c'), name, topic: (p.topic as string | undefined) ?? '', created: now().toISOString(), by: actor.id };
        commit('channel.created', actor.id, channel.id as string, `${actor.name} opened #${name}`, { channels: [channel] });
        return channel;
      },
    },
    create_task: {
      description: 'Create a task. Leave `assignee` out and anyone may claim it; name one to delegate it. Give `parent` to split a task you hold into subtasks for others: you are told when each is done.',
      who: 'any', mutates: true,
      params: {
        title: str('One line saying what is to be done.', 200, true),
        outcome: str('What can be observed when it is done: the thing a reviewer will check.', 2000, true),
        body: str('Everything the one doing it needs: context, where things are.', 20_000),
        next: str('The next concrete action, so that whoever picks it up knows where to start.', 500),
        assignee: str('Who should do it (name or id).', 40),
        participants: str('Who else takes part, names separated by spaces: they are told of what happens to it.', 400),
        private: { type: 'boolean', description: 'Only its creator, its holder, its reviewer, its participants and the people overseeing the board see it or anything about it.' },
        parent: str('The task this is a part of.', 16),
        priority: { type: 'integer', description: '0 low, 1 normal (default), 2 high, 3 urgent.', min: 0, max: 3 },
        review: { type: 'string', description: '"required" (default): it is done only when someone other than its author approves it. "optional": the assignee may complete it alone.', enum: ['required', 'optional'] },
      },
      run(actor, p) {
        const assignee = p.assignee === undefined ? null : available(p.assignee as string);
        const parent = p.parent === undefined ? '' : (task(actor, p.parent as string).id as string);
        const participants = several((p.participants as string | undefined) ?? '');
        tasksMade += 1;
        const at = now().toISOString();
        const t: Row = {
          id: `T-${tasksMade}`, title: p.title as string, body: (p.body as string | undefined) ?? '', status: 'open', creator: actor.id, assignee: assignee?.id ?? '', reviewer: '',
          parent, priority: (p.priority as number | undefined) ?? 1, review: (p.review as string | undefined) ?? 'required', result: '', created: at, updated: at, seq: seq + 1,
          outcome: p.outcome as string, next: (p.next as string | undefined) ?? '', participants: participants.join(' '), private: p.private === true ? 1 : 0, rev: 1, dependency: '', check: '',
        };
        commit('task.created', actor.id, t.id as string, `${actor.name} created ${t.id}: ${clip(t.title as string)}${assignee ? ` for ${assignee.name}` : ''}`, { tasks: [t] }, [
          ...(assignee ? [{ dest: assignee.id, type: 'task.assigned', subject: t.id as string, text: `${actor.name} gave you ${t.id}: ${t.title}` }] : []),
          ...participants.map((dest) => ({ dest, type: 'task.participant', subject: t.id as string, text: `${actor.name} made you a participant of ${t.id}: ${t.title}` })),
        ]);
        return t;
      },
    },
    update_task: {
      description: 'Change what a task says: its title, description, outcome, next action, priority, participants or privacy. Its creator, whoever holds it, or a person may. You must pass the `rev` you read, so that two changes made at once cannot silently overwrite each other.',
      who: 'any', mutates: true,
      params: {
        task: TASK,
        rev: { ...REV, required: true },
        title: str('A new title.', 200),
        body: str('A new description.', 20_000),
        outcome: str('What can be observed when it is done.', 2000),
        next: str('The next concrete action.', 500),
        priority: { type: 'integer', description: '0 low, 1 normal, 2 high, 3 urgent.', min: 0, max: 3 },
        participants: str('The full new list of participants, names separated by spaces; "none" for nobody.', 400),
        private: { type: 'boolean', description: 'Whether only its parties and the people overseeing the board see it. Only its creator or a person changes this.' },
      },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number);
        if (actor.kind !== 'user' && t.creator !== actor.id && t.assignee !== actor.id) bad('forbidden', `only the creator of ${t.id}, whoever holds it, or a person can change it`);
        if (p.private !== undefined && actor.kind !== 'user' && t.creator !== actor.id) bad('forbidden', `only the creator of ${t.id} or a person decides who may see it`);
        const change: Record<string, string | number> = {};
        for (const key of ['title', 'body', 'outcome', 'next', 'priority'] as const) if (p[key] !== undefined) change[key] = p[key] as string | number;
        if (p.participants !== undefined) change.participants = p.participants === 'none' ? '' : several(p.participants as string).join(' ');
        if (p.private !== undefined) change.private = p.private === true ? 1 : 0;
        const changed = Object.keys(change).filter((key) => change[key] !== t[key]);
        if (changed.length === 0) bad('invalid', 'nothing would change');
        const added = change.participants === undefined ? [] : (change.participants as string).split(' ').filter((id) => id !== '' && !parties(t).includes(id));
        return saveTask(actor, t, change, 'task.updated', `${actor.name} changed ${changed.join(', ')} of ${t.id}`, [
          ...told(t, 'task.updated', `${actor.name} changed ${changed.join(', ')} of ${t.id}: ${t.title}`),
          ...added.map((dest) => ({ dest, type: 'task.participant', subject: t.id as string, text: `${actor.name} made you a participant of ${t.id}: ${change.title ?? t.title}` })),
        ]);
      },
    },
    claim_task: {
      description: 'Take a task and start on it, or resume it: one nobody holds, or one already given to you (also after changes were requested, or when what it waited for has come). Its status becomes in_progress. Before resuming work someone else began, read get_task: its evidence lists what was already done outside the board, which must not be done again.',
      who: 'any', mutates: true, params: { task: TASK, rev: REV },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number | undefined);
        if (t.assignee !== '' && t.assignee !== actor.id) bad('conflict', `${t.id} is held by ${names().get(t.assignee as string) ?? 'someone else'}`);
        if (!['open', 'changes_requested', 'waiting', 'blocked'].includes(t.status as string)) bad('conflict', `${t.id} is ${t.status}; only a task that is open, waiting, blocked or has changes requested can be started`);
        return saveTask(actor, t, { assignee: actor.id, status: 'in_progress', dependency: '', check: '' }, 'task.claimed', `${actor.name} started ${t.id}`, [{ dest: t.creator as string, type: 'task.claimed', subject: t.id as string, text: `${actor.name} started ${t.id}: ${t.title}` }]);
      },
    },
    release_task: {
      description: 'Give a task back so someone else can claim it.',
      who: 'any', mutates: true, params: { task: TASK, note: str('Why, and what the next one should know.', 2000), rev: REV },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number | undefined);
        if (t.assignee === '') bad('conflict', `${t.id} is held by nobody`);
        if (t.assignee !== actor.id && actor.kind !== 'user') bad('forbidden', `${t.id} is not yours to release`);
        if (t.status === 'done' || t.status === 'cancelled' || t.status === 'in_review') bad('conflict', `${t.id} is ${t.status}`);
        const next = saveTask(actor, t, { assignee: '', status: t.status === 'waiting' || t.status === 'blocked' ? t.status : 'open' }, 'task.released', `${actor.name} released ${t.id}`, [
          { dest: t.creator as string, type: 'task.released', subject: t.id as string, text: `${actor.name} released ${t.id}${p.note ? `: ${p.note}` : ''}` },
          { dest: t.assignee as string, type: 'task.released', subject: t.id as string, text: `${actor.name} took ${t.id} from you` },
        ]);
        if (p.note) post(actor, t.id as string, `Released: ${p.note}`);
        return next;
      },
    },
    delegate_task: {
      description: 'Hand a task to someone else: from then on they hold it. Its creator, whoever holds it, or a person may. To hand over only a part, use create_task with `parent` instead.',
      who: 'any', mutates: true,
      params: { task: TASK, to: str('Who should do it (name or id).', 40, true), note: str('What they need to know.', 2000), rev: REV },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number | undefined);
        if (actor.kind !== 'user' && t.creator !== actor.id && t.assignee !== actor.id) bad('forbidden', `only the creator of ${t.id}, whoever holds it, or a person can hand it on`);
        if (t.status === 'done' || t.status === 'cancelled' || t.status === 'in_review') bad('conflict', `${t.id} is ${t.status}`);
        const to = available(p.to as string);
        if (to.id === t.assignee) bad('conflict', `${to.name} already holds ${t.id}`);
        const next = saveTask(actor, t, { assignee: to.id, status: t.status === 'waiting' || t.status === 'blocked' ? t.status : 'open' }, 'task.delegated', `${actor.name} handed ${t.id} to ${to.name}`, [
          { dest: to.id, type: 'task.assigned', subject: t.id as string, text: `${actor.name} gave you ${t.id}: ${t.title}${p.note ? `\n${p.note}` : ''}` },
          { dest: t.assignee as string, type: 'task.delegated', subject: t.id as string, text: `${actor.name} handed ${t.id} to ${to.name}` },
          { dest: t.creator as string, type: 'task.delegated', subject: t.id as string, text: `${actor.name} handed ${t.id} to ${to.name}` },
        ]);
        if (p.note) post(actor, t.id as string, `Handed to @${to.name}: ${p.note}`);
        return next;
      },
    },
    request_review: {
      description: 'Ask for a review of a task you hold. Name a reviewer, or leave it open to anyone but you. Say in `note` what you did and where to look. The task waits in in_review for the verdict.',
      who: 'any', mutates: true,
      params: { task: TASK, reviewer: str('Who should review (name or id). Not you.', 40), note: str('What was done, the evidence that the outcome is there, and what to check.', 20_000, true), rev: REV },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number | undefined);
        if (t.assignee !== actor.id) bad('forbidden', `${t.id} is not yours; only whoever holds a task asks for its review`);
        if (t.status !== 'in_progress') bad('conflict', `${t.id} is ${t.status}; claim_task it first`);
        const reviewer = p.reviewer === undefined ? null : available(p.reviewer as string);
        if (reviewer?.id === actor.id) bad('invalid', 'nobody reviews their own work');
        const review: Row = { id: ident('r'), task: t.id!, requester: actor.id, reviewer: reviewer?.id ?? '', status: 'pending', note: p.note as string, comment: '', decider: '', created: now().toISOString(), decided: NEVER, seq: seq + 1 };
        const text = `${actor.name} asks for a review of ${t.id}: ${t.title}\n${clip(p.note as string, 400)}`;
        saveTask(actor, t, { status: 'in_review', reviewer: reviewer?.id ?? '' }, 'review.requested', `${actor.name} asked ${reviewer?.name ?? 'anyone'} to review ${t.id}`,
          [{ dest: reviewer?.id ?? (t.creator as string), type: 'review.requested', subject: t.id as string, text }], { reviews: [review] });
        return review;
      },
    },
    review_task: {
      description: 'Give your verdict on a task in review: approve (it becomes done) or request_changes (it goes back to its author with your comment). You may decide a review asked of you, or an open one that is not of your own work.',
      who: 'any', mutates: true,
      params: { task: TASK, verdict: { type: 'string', description: 'Your verdict.', enum: ['approve', 'request_changes'], required: true }, comment: str('What you found. Required when requesting changes.', 20_000), rev: REV },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number | undefined);
        const review = t.status === 'in_review' ? pendingReview(t.id as string) : undefined;
        if (review === undefined) return bad('conflict', `${t.id} is ${t.status} and has no review waiting`);
        if (review.requester === actor.id) bad('forbidden', 'nobody reviews their own work');
        if (review.reviewer !== '' && review.reviewer !== actor.id) bad('forbidden', `this review was asked of ${names().get(review.reviewer as string) ?? 'someone else'}`);
        const approve = p.verdict === 'approve';
        const comment = (p.comment as string | undefined) ?? '';
        if (!approve && comment.trim() === '') bad('invalid', 'say in `comment` what has to change');
        const decided: Row = { ...review, status: approve ? 'approved' : 'changes_requested', comment, decider: actor.id, decided: now().toISOString(), seq: seq + 1 };
        const text = approve ? `${actor.name} approved ${t.id}: ${t.title}${comment ? `\n${clip(comment, 400)}` : ''}` : `${actor.name} asks for changes to ${t.id}: ${clip(comment, 400)}`;
        const next = saveTask(actor, t, approve ? { status: 'done', result: t.result === '' ? (review.note as string) : t.result } : { status: 'changes_requested' },
          approve ? 'review.approved' : 'review.changes_requested', approve ? `${actor.name} approved ${t.id}` : `${actor.name} asked for changes to ${t.id}`,
          [{ dest: review.requester as string, type: approve ? 'review.approved' : 'review.changes_requested', subject: t.id as string, text }, ...(approve ? doneNotes(t, actor) : [])],
          { reviews: [decided] });
        return { task: next, review: decided };
      },
    },
    complete_task: {
      description: 'Mark a task you hold as done, with the evidence that its outcome is there. Only for tasks whose review is optional; otherwise use request_review.',
      who: 'any', mutates: true, params: { task: TASK, result: str('What came of it and what shows it: the evidence that the outcome is there.', 20_000, true), rev: REV },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number | undefined);
        if (actor.kind !== 'user') {
          if (t.assignee !== actor.id) bad('forbidden', `${t.id} is not yours`);
          if (t.review === 'required') bad('forbidden', `${t.id} is done only when someone else approves it: use request_review`);
        }
        if (t.status !== 'in_progress' && !(actor.kind === 'user' && OPEN_STATUSES.includes(t.status as (typeof OPEN_STATUSES)[number]))) bad('conflict', `${t.id} is ${t.status}`);
        const open = pendingReview(t.id as string);
        return saveTask(actor, t, { status: 'done', result: p.result as string, dependency: '', check: '' }, 'task.completed', `${actor.name} completed ${t.id}`, doneNotes(t, actor),
          open ? { reviews: [{ ...open, status: 'withdrawn', decider: actor.id, decided: now().toISOString(), seq: seq + 1 }] } : {});
      },
    },
    hold_task: {
      description: 'Say that a task you hold cannot go on for now: "waiting" for something that will come by itself, "blocked" by something somebody has to remove. Name what it depends on and what to check next and when, so that anyone can resume it. Resume with claim_task.',
      who: 'any', mutates: true,
      params: {
        task: TASK,
        status: { type: 'string', description: 'waiting or blocked.', enum: ['waiting', 'blocked'], required: true },
        dependency: str('What it depends on, concretely: the review of PR 12, an answer from a named person, a deploy.', 1000, true),
        next_check: str('What to check next and when, e.g. "the CI run of PR 12, tomorrow 09:00 UTC".', 500, true),
        rev: REV,
      },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number | undefined);
        if (actor.kind !== 'user' && t.assignee !== actor.id) bad('forbidden', `${t.id} is not yours`);
        if (!['in_progress', 'waiting', 'blocked'].includes(t.status as string)) bad('conflict', `${t.id} is ${t.status}; only a task in progress can be put on hold`);
        const text = `${actor.name} marked ${t.id} ${p.status}: ${p.dependency}\nNext check: ${p.next_check}`;
        return saveTask(actor, t, { status: p.status as string, dependency: p.dependency as string, check: p.next_check as string }, `task.${p.status}`, `${actor.name} marked ${t.id} ${p.status}: ${clip(p.dependency as string)}`, told(t, `task.${p.status}`, text));
      },
    },
    add_evidence: {
      description: 'Attach to a task what shows that work was done (kind "evidence": a commit, a test run, a link, a measurement), or record something done outside the board (kind "external_action": a pull request opened, a mail sent, a deploy started) under a `key` that names it. An external action can be recorded once for a task: record it BEFORE you resume or repeat anything outside, and if the board answers that it is already recorded, do not do it again. The board records what you say; it cannot know whether anything outside happened once, twice or not at all.',
      who: 'any', mutates: true,
      params: {
        task: TASK,
        text: str('The evidence, or what was done and where its result is.', 5000, true),
        kind: { type: 'string', description: 'evidence (default) or external_action.', enum: ['evidence', 'external_action'] },
        key: str('For an external action: a short name for it that anyone doing the same thing would choose, e.g. "open-pr" or "mail-to-vendor".', 80),
      },
      run(actor, p) {
        const t = task(actor, p.task as string);
        if (actor.kind !== 'user' && !parties(t).includes(actor.id)) bad('forbidden', `only those ${t.id} concerns attach evidence to it`);
        const kind = (p.kind as string | undefined) ?? 'evidence';
        const key = ((p.key as string | undefined) ?? '').trim().toLowerCase();
        if (kind === 'external_action') {
          if (key === '') bad('invalid', 'an external action needs a `key` that names it');
          const had = store.ask(`(select {from: evidence where: (and (in task (at rb_q 'q0)) (in key (at rb_q 'q1)))})`, { str: [t.id as string] }, { str: [key] })[0];
          if (had !== undefined) bad('conflict', `${t.id} already has the external action "${key}" recorded by ${names().get(had.author as string) ?? had.author} at ${had.ts}: ${clip(had.text as string, 300)}. Do not do it again`);
        }
        const evidence: Row = { id: `e_${seq + 1}`, seq: seq + 1, ts: now().toISOString(), task: t.id!, author: actor.id, kind, key: kind === 'external_action' ? key : '', text: p.text as string };
        commit('evidence.added', actor.id, t.id as string, `${actor.name} ${kind === 'external_action' ? `recorded the external action "${key}" on` : 'attached evidence to'} ${t.id}`, { evidence: [evidence] },
          told(t, 'evidence.added', `${actor.name} ${kind === 'external_action' ? `recorded "${key}" on` : 'attached evidence to'} ${t.id}: ${clip(p.text as string, 400)}`));
        return evidence;
      },
    },
    cancel_task: {
      description: 'Cancel a task that is no longer wanted. Its creator or a person may.',
      who: 'any', mutates: true, params: { task: TASK, reason: str('Why.', 2000), rev: REV },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number | undefined);
        if (actor.kind !== 'user' && t.creator !== actor.id) bad('forbidden', `only the creator of ${t.id} or a person can cancel it`);
        if (t.status === 'done' || t.status === 'cancelled') bad('conflict', `${t.id} is ${t.status}`);
        const open = pendingReview(t.id as string);
        return saveTask(actor, t, { status: 'cancelled', result: (p.reason as string | undefined) ?? '' }, 'task.cancelled', `${actor.name} cancelled ${t.id}`,
          [t.assignee, t.creator].map((dest) => ({ dest: dest as string, type: 'task.cancelled', subject: t.id as string, text: `${actor.name} cancelled ${t.id}: ${t.title}${p.reason ? `\n${p.reason}` : ''}` })),
          open ? { reviews: [{ ...open, status: 'withdrawn', decider: actor.id, decided: now().toISOString(), seq: seq + 1 }] } : {});
      },
    },

    // ---- for agents ----
    report_cost: {
      description: 'Report what your work cost, so the people overseeing the board see it and your budget is kept. Report after each piece of work. At your monthly budget you are paused until a person resumes you.',
      who: 'agent', mutates: true,
      params: {
        usd: { type: 'number', description: 'The cost in US dollars.', required: true, min: 0, max: 100_000 },
        task: str('The task it was spent on.', 16),
        model: str('The model used.', 80),
        tokens_in: { type: 'integer', description: 'Input tokens.', min: 0 },
        tokens_out: { type: 'integer', description: 'Output tokens.', min: 0 },
        note: str('Anything worth saying about it.', 300),
      },
      run(actor, p) {
        const taskId = p.task === undefined ? '' : (task(actor, p.task as string).id as string);
        const at = now().toISOString();
        const amount = p.usd as number;
        const cost: Row = { id: `x_${seq + 1}`, seq: seq + 1, ts: at, agent: actor.id, task: taskId, model: (p.model as string | undefined) ?? '', tin: (p.tokens_in as number | undefined) ?? 0, tout: (p.tokens_out as number | undefined) ?? 0, usd: amount, note: (p.note as string | undefined) ?? '' };
        const before = spent(actor.id, monthStart(at));
        const budget = Number(store.get('agents', actor.id)!.budget);
        const total = before + amount;
        commit('cost.reported', actor.id, taskId === '' ? actor.id : taskId, `${actor.name} spent ${usd(amount)}${taskId ? ` on ${taskId}` : ''}`, { costs: [cost] });
        if (budget > 0 && before < 0.8 * budget && total >= 0.8 * budget && total < budget) {
          const text = `spent ${usd(total)} of ${usd(budget)} for this month`;
          commit('budget.warning', 'system', actor.id, `${actor.name} has ${text}`, {}, [{ dest: actor.id, type: 'budget.warning', subject: actor.id, text: `you have ${text}` }]);
        }
        let paused = false;
        if (budget > 0 && total >= budget) {
          const row = store.get('agents', actor.id)!;
          commit('agent.paused', 'system', actor.id, `${actor.name} was paused: spent ${usd(total)} of ${usd(budget)} this month`, { agents: [{ ...row, status: 'paused', reason: `budget: spent ${usd(total)} of ${usd(budget)} this month` }] });
          paused = true;
        }
        return { spent_this_month: total, budget, paused };
      },
    },

    // ---- for the people overseeing the board ----
    dashboard: {
      description: 'Everything the dashboard shows, in one answer.',
      who: 'user', mutates: false, params: {},
      run() {
        const at = now().toISOString();
        const month = new Map(store.ask(`(select {from: costs where: (>= ts (first (at rb_q 'q0))) by: {agent: agent} usd: (sum usd)})`, { ts: monthStart(at) }).map((r) => [r.agent, Number(r.usd)]));
        return {
          now: at,
          agents: store.all('agents').map((a) => ({ ...agentView(a), spent: month.get(a.id as string) ?? 0 })),
          people: store.all('users').map(userView),
          channels: actions.list_channels!.run({} as Actor, {}),
          tasks: store.ask(`(select {from: tasks desc: seq take: 1000})`).map(({ body: _body, ...rest }) => rest),
          reviews: store.ask(`(select {from: reviews where: (== status 'pending) asc: seq})`),
          dms: store.ask(`(select {from: messages where: (== kind 'dm) by: {chan: chan} n: (count id) last: (max seq)})`),
          threads: store.ask(`(select {from: messages where: (== kind 'task) by: {chan: chan} n: (count id)})`),
          enrollment: (store.get('settings', 'enroll')?.value ?? '') !== '',
          seq,
        };
      },
    },
    create_agent: {
      description: 'Add an agent and get its token. The token is shown once.',
      who: 'user', mutates: true, secret: true,
      params: { name: str('Its name.', 32, true), kind: str('What runs it, e.g. claude-code.', 40), about: str('What it is good at.', 500), budget: { type: 'number', description: 'US dollars a month; 0 for no limit.', min: 0, max: 1_000_000 } },
      run: (actor, p) => newAgent(actor.id, { name: p.name as string, kind: p.kind as string | undefined, about: p.about as string | undefined, budget: p.budget as number | undefined }, 'active'),
    },
    approve_agent: {
      description: 'Let an agent that asked to join take part.',
      who: 'user', mutates: true, params: { agent: str('The agent.', 40, true) },
      run: (actor, p) => setAgent(actor, p.agent as string, { status: 'active', reason: '' }, 'agent.approved', (n) => `${actor.name} approved ${n}`, ['pending']),
    },
    pause_agent: {
      description: 'Stop an agent from changing anything until it is resumed. It can still read.',
      who: 'user', mutates: true, params: { agent: str('The agent.', 40, true), reason: str('Why.', 300) },
      run: (actor, p) => setAgent(actor, p.agent as string, { status: 'paused', reason: (p.reason as string | undefined) ?? `paused by ${actor.name}` }, 'agent.paused', (n) => `${actor.name} paused ${n}`, ['active']),
    },
    resume_agent: {
      description: 'Let a paused agent work again. One paused for its budget is paused again at its next report unless the budget is raised.',
      who: 'user', mutates: true, params: { agent: str('The agent.', 40, true) },
      run: (actor, p) => setAgent(actor, p.agent as string, { status: 'active', reason: '' }, 'agent.resumed', (n) => `${actor.name} resumed ${n}`, ['paused']),
    },
    revoke_agent: {
      description: 'End an agent\'s access for good. Its token stops working at once.',
      who: 'user', mutates: true, params: { agent: str('The agent.', 40, true) },
      run: (actor, p) => setAgent(actor, p.agent as string, { status: 'revoked', reason: `revoked by ${actor.name}`, token: '' }, 'agent.revoked', (n) => `${actor.name} revoked ${n}`, ['pending', 'active', 'paused']),
    },
    rotate_token: {
      description: 'Give an agent a new token. The old one stops working at once; the new one is shown once.',
      who: 'user', mutates: true, secret: true, params: { agent: str('The agent.', 40, true) },
      run(actor, p) {
        const target = someone(p.agent as string, 'agent');
        const token = `rb_${target.id}_${secret()}`;
        return { agent: setAgent(actor, target.id, { token: sha(token) }, 'agent.token_rotated', (n) => `${actor.name} gave ${n} a new token`, ['pending', 'active', 'paused']), token };
      },
    },
    set_budget: {
      description: 'Set what an agent may spend in a month.',
      who: 'user', mutates: true, params: { agent: str('The agent.', 40, true), usd: { type: 'number', description: 'US dollars a month; 0 for no limit.', required: true, min: 0, max: 1_000_000 } },
      run: (actor, p) => setAgent(actor, p.agent as string, { budget: p.usd as number }, 'agent.budget', (n) => `${actor.name} set the budget of ${n} to ${usd(p.usd as number)} a month`, ['pending', 'active', 'paused']),
    },
    new_enrollment_key: {
      description: 'Make a new key with which agents can ask to join. The one before stops working. Shown once.',
      who: 'user', mutates: true, secret: true, params: {},
      run(actor) {
        const key = `rbe_${secret()}`;
        commit('enrollment.rotated', actor.id, 'enrollment', `${actor.name} made a new enrollment key`, { settings: [{ id: 'enroll', value: sha(key) }] });
        return { key };
      },
    },
    disable_enrollment: {
      description: 'Stop agents from asking to join until a new key is made.',
      who: 'user', mutates: true, params: {},
      run(actor) {
        commit('enrollment.disabled', actor.id, 'enrollment', `${actor.name} closed enrollment`, { settings: [{ id: 'enroll', value: '' }] });
        return { ok: true };
      },
    },
    reopen_task: {
      description: 'Open a done or cancelled task again.',
      who: 'user', mutates: true, params: { task: TASK },
      run(actor, p) {
        const t = task(actor, p.task as string);
        if (t.status !== 'done' && t.status !== 'cancelled') bad('conflict', `${t.id} is ${t.status}`);
        return saveTask(actor, t, { status: 'open' }, 'task.reopened', `${actor.name} reopened ${t.id}`, [{ dest: t.assignee as string, type: 'task.assigned', subject: t.id as string, text: `${actor.name} reopened ${t.id}: ${t.title}` }]);
      },
    },
  };

  /** Who is told that a task is done: its creator, and whoever holds the task it is a part of. */
  function doneNotes(t: Row, actor: Actor): Note[] {
    const parent = t.parent === '' ? null : store.get('tasks', t.parent as string);
    const text = `${t.id} is done: ${t.title}${parent ? ` (part of ${parent.id})` : ''}`;
    // Whoever holds the task this is a part of is told, unless the part is private and not theirs to know of.
    const above = parent !== null && (t.private !== 1 || parties(t).includes(parent.assignee as string)) ? (parent.assignee as string) : '';
    return [...parties(t), above].map((dest) => ({ dest, type: 'task.done', subject: t.id as string, text }));
  }

  function check(name: string, action: Action, raw: unknown): Params {
    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) bad('invalid', `${name}: the parameters are one object`);
    const given = (raw ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(given)) if (!(key in action.params)) bad('invalid', `${name} has no parameter "${clip(key, 40)}"; it takes: ${Object.keys(action.params).join(', ') || 'nothing'}`);
    const out: Params = {};
    for (const [key, f] of Object.entries(action.params)) {
      const v = given[key];
      if (v === undefined || v === null || (v === '' && f.required !== true)) {
        if (f.required === true) bad('invalid', `${name} needs "${key}": ${f.description}`);
        continue;
      }
      if (f.type === 'string') {
        if (typeof v !== 'string') return bad('invalid', `${name}: "${key}" is text`);
        if (v.includes('\0')) bad('invalid', `${name}: "${key}" holds a NUL character`);
        if (f.required === true && v.trim() === '') bad('invalid', `${name} needs "${key}": ${f.description}`);
        if (f.max !== undefined && v.length > f.max) bad('invalid', `${name}: "${key}" is ${v.length} characters, at most ${f.max} fit`);
        if (f.enum !== undefined && !f.enum.includes(v)) bad('invalid', `${name}: "${key}" is one of ${f.enum.join(', ')}`);
        out[key] = v;
      } else if (f.type === 'boolean') {
        if (typeof v !== 'boolean') bad('invalid', `${name}: "${key}" is true or false`);
        out[key] = v as boolean;
      } else {
        if (typeof v !== 'number' || !Number.isFinite(v) || (f.type === 'integer' && !Number.isSafeInteger(v))) return bad('invalid', `${name}: "${key}" is ${f.type === 'integer' ? 'a whole number' : 'a number'}`);
        if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) bad('invalid', `${name}: "${key}" is between ${f.min ?? '-∞'} and ${f.max ?? '∞'}`);
        out[key] = v;
      }
    }
    return out;
  }

  return {
    actions,
    store,
    async call(actor, name, params) {
      if (broken) throw new Error('the log could not be written; the board accepts nothing until it is restarted');
      const action = Object.hasOwn(actions, name) ? actions[name]! : bad('not_found', `there is no action ${clip(name, 40)}`);
      if (action.who !== 'any' && action.who !== actor.kind) bad('forbidden', action.who === 'user' ? `${name} is for the people overseeing the board` : `${name} is for agents`);
      if (action.mutates && actor.kind === 'agent' && actor.status !== 'active') {
        bad('paused', actor.status === 'pending' ? 'you are waiting for a person to approve you; until then you can only read' : `you are ${actor.status} (${actor.reason}) and can only read`);
      }
      // A request id makes a request safe to repeat: the same id from the same actor is answered with what it was answered with before.
      let given = params;
      let requestId: unknown;
      if (action.mutates && typeof params === 'object' && params !== null && !Array.isArray(params) && 'request_id' in params) {
        const { request_id, ...rest } = params as Record<string, unknown>;
        requestId = request_id ?? undefined;
        given = rest;
      }
      const p = check(name, action, given);
      let receipt: { id: string; hash: string } | null = null;
      if (requestId !== undefined) {
        if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return bad('invalid', '`request_id` is 8 to 80 of letters, digits, ".", "_", ":" and "-"');
        if (action.secret === true) bad('invalid', `${name} shows a secret once and keeps no receipt, so it takes no request_id`);
        receipt = { id: `${actor.id}|${requestId}`, hash: sha(JSON.stringify([name, p])) };
        const had = store.get('receipts', receipt.id);
        if (had !== null) {
          if (had.hash !== receipt.hash) bad('conflict', `the request id ${requestId} was already used for a different request; a new request needs a new id`);
          return JSON.parse(had.result as string) as unknown;
        }
      }
      inRequest = true;
      let out: unknown;
      try {
        out = action.run(actor, p);
        if (receipt !== null && !(out instanceof Promise)) {
          commit('receipt', actor.id, receipt.id, '', { receipts: [{ id: receipt.id, hash: receipt.hash, result: JSON.stringify(out), ts: now().toISOString() }] }, [], true);
        }
      } finally {
        // Whatever was written is logged as one frame, also when the action failed half way: the tables never hold what the disk does not.
        inRequest = false;
        flush();
      }
      return await out;
    },
    agentOfToken(token) {
      const m = TOKEN.exec(token);
      const row = m === null ? null : store.get('agents', m[1]!);
      // Compared also when there is no such agent, so that an answer does not come sooner for an id that does not exist.
      const ok = sameHash(sha(token), (row?.token as string | undefined) || sha('nobody'));
      if (row === null || !ok || row.status === 'revoked') return null;
      seen.set(row.id as string, Date.now());
      return actorOfAgent(row);
    },
    userById(id) {
      const row = store.get('users', id);
      return row === null || row.status !== 'active' ? null : actorOfUser(row);
    },
    firstUser() {
      const row = store.all('users').find((u) => u.status === 'active');
      return row === undefined ? null : actorOfUser(row);
    },
    register(key, p, open = false) {
      if (typeof p.name !== 'string' || (p.about ?? '').length > 500 || (p.kind ?? '').length > 40) bad('invalid', 'name, kind (40) and about (500) are text');
      // In unsafe mode nobody is asked for a key and nobody waits for approval.
      if (open) return newAgent('unsafe', p, 'active');
      const pinned = (store.get('settings', 'enroll')?.value as string | undefined) ?? '';
      if (pinned === '' || !sameHash(sha(key), pinned)) bad('unauthorized', 'that is not the enrollment key of this board');
      if (store.ask(`(select {from: agents where: (== status 'pending)})`).length >= 50) bad('conflict', 'too many agents are waiting for approval');
      return newAgent('enrollment', p, 'pending');
    },
    needsSetup: () => store.count('users') === 0,
    async createUser(name, password) {
      const handle = name.toLowerCase();
      if (!NAME.test(handle)) bad('invalid', 'a name is 2 to 32 of a-z, 0-9, - and _');
      if (password.length < 10 || password.length > 200) bad('invalid', 'a password has at least 10 characters');
      const pass = await Bun.password.hash(password, { algorithm: 'argon2id' });
      if (directory().byName.has(handle)) bad('conflict', `the name ${handle} is taken`);
      const user: Row = { id: ident('u'), name: handle, pass, status: 'active', created: now().toISOString() };
      commit('user.created', user.id as string, user.id as string, `${handle} joined as a person overseeing the board`, { users: [user] });
      return actorOfUser(user);
    },
    async login(name, password) {
      const row = store.all('users').find((u) => u.name === name.toLowerCase() && u.status === 'active');
      // A hash is verified either way: how long the answer takes says nothing about whether the name exists.
      const ok = await Bun.password.verify(password.slice(0, 200), (row?.pass as string | undefined) ?? DUMMY_HASH).catch(() => false);
      return row !== undefined && ok ? actorOfUser(row) : null;
    },
    async setPassword(id, current, next) {
      const row = store.get('users', id) ?? bad('not_found', 'no such person');
      if (!(await Bun.password.verify(current.slice(0, 200), row.pass as string).catch(() => false))) bad('unauthorized', 'that is not your current password');
      if (next.length < 10 || next.length > 200) bad('invalid', 'a password has at least 10 characters');
      const pass = await Bun.password.hash(next, { algorithm: 'argon2id' });
      commit('user.password_changed', id, id, `${row.name} changed their password`, { users: [{ ...(store.get('users', id) ?? row), pass }] });
    },
    people: () => store.all('users').map((u) => u.name as string),
    async resetPassword(name) {
      const row = store.all('users').find((u) => u.name === name.toLowerCase()) ?? bad('not_found', `nobody here is called ${clip(name, 40)}`);
      const next = randomBytes(15).toString('base64url');
      const pass = await Bun.password.hash(next, { algorithm: 'argon2id' });
      commit('user.password_reset', 'system', row.id as string, `the password of ${row.name} was reset from the server's console`, { users: [{ ...row, pass }] });
      return next;
    },
    onChange: (listener) => void listeners.push(listener),
    close: () => store.close(),
  };
}

const DUMMY_HASH = await Bun.password.hash(randomBytes(16).toString('hex'), { algorithm: 'argon2id' });
