import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { read as readGithub } from './github';
import { readOldJournal, type Entry, type Row } from './journal';
import type { Ray } from './ray';
import { NEVER, openStore, type Store } from './store';
import { dirname, join } from 'node:path';

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
  /** People: administrators manage access; members work; viewers only read. */
  role?: 'admin' | 'member' | 'viewer';
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
  /** Whether it changes the board: a pending, paused or revoked agent and a viewer may only read. */
  mutates: boolean;
  /** Only a human administrator may call it, even among people. */
  admin?: boolean;
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
  /** Whether this person may know of what happened to this subject: false only for a private task they may not see. */
  mayKnow(user: string, subject: string): boolean;
  /** Whether this person or agent may read the conversation `chan` (a channel id, dm:a:b or a task id). */
  mayRead(id: string, chan: string): boolean;
  /** Told when someone starts or stops composing in a conversation (T-476): nothing of it is written anywhere. */
  onTyping(listener: (t: { chan: string; who: string; composing: boolean; holdMs?: number; tab?: string }) => void): void;
  /** Saves this person's PNG/JPEG, then records its hash as part of the same board update. */
  setAvatar(user: string, bytes: Buffer, type: string): string;
  /** A bounded, authenticated image chosen by this person; its id changes when it is replaced. */
  clearAvatar(user: string): void;
  avatar(user: string): { bytes: Buffer; type: string; id: string } | null;
  /** Keeps an image pasted into text and answers where it is served (T-447). PNG, JPEG, GIF or WebP, told by its bytes. */
  putImage(actor: Actor, bytes: Buffer): { id: string; url: string; type: string; size: number };
  /**
   * An image's bytes and type, for this reader: null when there is none, and when they may see none of the
   * text it is in (its uploader may always). An image is as private as the most open place it was put.
   */
  image(actor: Actor, id: string): { bytes: Buffer; type: string } | null;
  setAgentAvatar(actor: Actor, user: string, bytes: Buffer, type: string): string;
  clearAgentAvatar(actor: Actor, user: string): void;
  /** An agent asks to join with the enrollment key. It gets a token at once and can do nothing until a person approves it. */
  register(key: string, p: { name: string; kind?: string; about?: string }, open?: boolean): { agent: Row; token: string };
  /** The first person overseeing the board, or null when there is none yet. */
  firstUser(): Actor | null;
  needsSetup(): boolean;
  createUser(name: string, password: string, role?: 'admin' | 'member' | 'viewer'): Promise<Actor>;
  /** Accepts a one-time invitation and chooses a unique login and password. */
  acceptInvite(key: string, name: string, password: string): Promise<Actor>;
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
  /** Takes one signed GitHub webhook delivery (T-19): its receipt and what it changes are one write. */
  githubDelivery(delivery: string, event: string, payload: Record<string, unknown>): { result: 'applied' | 'duplicate' | 'ignored'; task?: string };
  /** Whether the board already holds this pull request whole (its head) as of this update on GitHub (T-446). */
  githubKnown(repo: string, number: number, updated: string): boolean;
  /** GitHub items whose rb:* label does not say what their task's status is (T-446): what to write, and where. */
  githubLabelTargets(): { item: string; repo: string; number: number; want: string }[];
  /** Records a label write and what reading it back showed; a write that did not take is said in the activity. */
  githubLabelWritten(item: string, want: string, ok: boolean, detail: string): void;
  /** Records what the App was actually granted and what is missing for the followed repositories (no secrets). */
  githubGrant(grant: { installation: string; permissions: Record<string, string>; repos: { id: string; name: string; private: boolean }[] }, problems: string[]): void;
  /** The repositories followed, by name and id when known. */
  githubFollowed(): { name: string; id: string }[];
  store: Store;
  options: BoardOptions;
  close(): void;
}

const NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;
/** Names a message already gives a meaning to, so nobody can be called by them: @all is everyone here. */
const RESERVED = new Set(['all']);
const reserved = (name: string): void => {
  if (RESERVED.has(name)) bad('invalid', `@${name} is reserved: it names everyone a message reaches`);
  // Lookups take an id before a name, so a name shaped like an id would point at someone else.
  if (/^[acur]_[a-z0-9]{8}$/.test(name)) bad('invalid', 'a name may not look like an id (a letter, _ and eight letters or digits)');
};
const TASK_ID = /^T-[1-9][0-9]{0,8}$/;
const TOKEN = /^rb_(a_[a-z0-9]{8})_[A-Za-z0-9_-]{43}$/;
const OPEN_STATUSES = ['open', 'in_progress', 'waiting', 'blocked', 'in_review', 'changes_requested'] as const;
/** A request id: chosen by the caller, one for each thing it wants done once. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;
const STATUSES = [...OPEN_STATUSES, 'done', 'cancelled'] as const;
/** An agent seen this recently is shown as online. */
const ONLINE_MS = 120_000;
const INBOX_WAIT_MAX = 50;
const ROLES = ['admin', 'member', 'viewer'] as const;
const ROLE: Field = { type: 'string', description: 'admin manages access, member collaborates, viewer only reads.', enum: ROLES };
const HUMAN_ROLE: Field = { ...ROLE, enum: ['member', 'viewer'] };
const INVITE_MS = 48 * 60 * 60 * 1000;
const roleOf = (u: Row): NonNullable<Actor['role']> => u.role === 'member' || u.role === 'viewer' ? u.role : 'admin';
const isAdmin = (a: Actor): boolean => a.kind === 'user' && a.role === 'admin';

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

/**
 * The only labels the board ever writes to GitHub (T-446), one per task status that says something there.
 * An open task has none: nobody has taken it on the board yet.
 */
export const BOARD_LABELS: Record<string, string> = {
  in_progress: 'rb:in-progress', changes_requested: 'rb:in-progress', in_review: 'rb:review', waiting: 'rb:blocked', blocked: 'rb:blocked', done: 'rb:done',
};
export const ALLOWED_LABELS = new Set(Object.values(BOARD_LABELS));

/** Check run conclusions that mean the checks failed. */
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/** The largest image the board keeps (T-447). */
export const IMAGE_MAX = 5 * 1024 * 1024;

/** What an image is, from its first bytes alone: a name or a declared type is never trusted. */
export function imageType(bytes: Buffer): string | null {
  const starts = (sig: number[], at = 0): boolean => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
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
  // From the highest id ever given, not a row count: an id is never given twice, even to a board missing rows.
  let tasksMade = store.all('tasks').reduce((n, t) => Math.max(n, Number(String(t.id).slice(2)) || 0), 0);
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
  const typingListeners: ((t: { chan: string; who: string; composing: boolean; holdMs?: number; tab?: string }) => void)[] = [];
  const typingTold = (t: { chan: string; who: string; composing: boolean; holdMs?: number; tab?: string }): void => { for (const l of typingListeners) l(t); };
  const seen = new Map<string, number>();
  const waiting = new Map<string, Set<() => void>>();
  /** A password hash is asynchronous: hold each invitation while it is being accepted so two requests cannot both use it. */
  const accepting = new Set<string>();

  // ---- writing ----

  interface Note {
    dest: string;
    type: string;
    subject: string;
    text: string;
  }
  /** The one way anything changes: the tables and the log, then whoever is listening. */
  function commit(type: string, actor: string, subject: string, summary: string, put: Record<string, Row[]>, notes: Note[] = [], quiet = false): Entry {
    // After a write failed, memory holds what the disk does not: nothing more is accepted, by call() or any other path.
    if (broken) throw new Error('the log could not be written; the board accepts nothing until it is restarted');
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
    const last = seen.get(a.id as string) ?? 0;
    // Online: it asked something in the last two minutes. An agent at work may go quiet for longer, writing code
    // between two calls; when it last asked is given too, so that working and gone can be told apart.
    return { ...rest, online: Date.now() - last < ONLINE_MS ? 1 : 0, last_seen: last === 0 ? '' : new Date(last).toISOString() };
  };
  const userView = (u: Row): Row => ({ id: u.id!, name: u.name!, status: u.status!, role: roleOf(u), about: u.about ?? '', avatar: u.avatar ? `/api/avatars/${u.id}/${u.avatar}` : '', created: u.created! });
  const actorOfAgent = (a: Row): Actor => ({ id: a.id as string, kind: 'agent', name: a.name as string, status: a.status as string, reason: a.reason as string });
  const actorOfUser = (u: Row): Actor => ({ id: u.id as string, kind: 'user', name: u.name as string, status: u.status as string, reason: '', role: roleOf(u) });

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
  const canSee = (actor: Actor, t: Row): boolean => isAdmin(actor) || t.private !== 1 || parties(t).includes(actor.id);
  /** Whether this reader may see some text an image was put in (T-447): a message where they may read, or a task, its review or its evidence that they may see. */
  const mayReadImage = (actor: Actor, id: string): boolean => {
    const mark = `/api/images/${id}`;
    const taskVisible = (taskId: unknown): boolean => { const t = store.get('tasks', String(taskId)); return t !== null && canSee(actor, t); };
    for (const m of store.all('messages')) {
      if (!String(m.body).includes(mark)) continue;
      const chan = String(m.chan);
      if (m.kind === 'channel') return true;
      if (m.kind === 'dm' && (chan.split(':').includes(actor.id) || isAdmin(actor))) return true;
      if (m.kind === 'task' && taskVisible(chan)) return true;
    }
    for (const t of store.all('tasks')) {
      if ([t.body, t.outcome, t.next, t.result, t.dependency, t.check].some((x) => String(x ?? '').includes(mark)) && canSee(actor, t)) return true;
    }
    for (const r of store.all('reviews')) if ((String(r.note).includes(mark) || String(r.comment).includes(mark)) && taskVisible(r.task)) return true;
    for (const e of store.all('evidence')) if (String(e.text).includes(mark) && taskVisible(e.task)) return true;
    return false;
  };
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
  const hidden = (actor: Actor): string[] => (isAdmin(actor) ? [] : store.ask(`(select {from: tasks where: (== private 1)})`).filter((t) => !canSee(actor, t)).map((t) => t.id as string));
  /** Names or ids, separated by spaces or commas, as ids. */
  /** A project is named as a repository is, compared without case: "RayForce" and "rayforce" are one project. */
  const projectName = (text: string): string => {
    const name = text.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) bad('invalid', 'a project name is 1 to 64 of a-z, 0-9, ".", "-" and "_", starting with a letter or digit');
    return name;
  };
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
      if (actor.kind === 'user' && a !== actor.id && b !== actor.id) {
        if (!isAdmin(actor)) return bad('forbidden', 'a direct conversation is visible only to its participants and administrators');
        return { chan: ref, kind: 'dm', label: ref, party: [] };
      }
      return place(actor, `@${someone(other ?? '').name}`);
    }
    if (!ref.startsWith('@')) {
      const key = ref.replace(/^#/, '').toLowerCase();
      const channel = store.all('channels').find((c) => c.id === ref || c.name === key);
      if (channel !== undefined) {
        const dir = directory();
        return { chan: channel.id as string, kind: 'channel', label: `#${channel.name}`, party: store.all('subscriptions').filter((r) => r.channel === channel.id && r.active === 1 && dir.byId.get(r.actor as string)?.status === 'active').map((r) => r.actor as string) };
      }
      if (ref.startsWith('#')) bad('not_found', `there is no channel ${clip(ref, 40)}; list_channels shows them, create_channel makes one`);
    }
    const other = someone(ref, 'channel, agent or person');
    if (other.id === actor.id) bad('invalid', 'a direct message needs somebody else to go to');
    return { chan: `dm:${[actor.id, other.id].sort().join(':')}`, kind: 'dm', label: `@${other.name}`, party: [other.id], closed: true };
  }

  /** A task as this actor may see it: a parent they may not know of is not named. */
  function shown(actor: Actor, t: Row): Row {
    if (t.parent === '' || t.parent === undefined) return t;
    const parent = store.get('tasks', t.parent as string);
    return parent !== null && canSee(actor, parent) ? t : { ...t, parent: '' };
  }

  function taskDetail(actor: Actor, t: Row): Record<string, unknown> {
    const id = { str: [t.id as string] };
    return {
      task: shown(actor, t),
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
    // Oversight permits reading another pair's DM, not injecting into it.
    to = to.trim();
    if (to.startsWith('dm:')) {
      const ids = to.slice(3).split(':');
      if (ids.length !== 2 || ids[0] === ids[1] || ids.some((id) => !directory().byId.has(id))) bad('invalid', 'a direct conversation needs two distinct existing participants');
      if (!ids.includes(actor.id)) bad('forbidden', 'you can only write to your own direct messages');
    }
    const where = place(actor, to);
    const dir = directory();
    const names = [...body.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9_-]{1,31})/gi)].map((m) => m[1]!.toLowerCase());
    const mentioned = [...new Set(names.flatMap((name) => {
      if (name === 'all') {
        if (where.closed === true) return where.party;
        // Everyone taking part here: a task's parties, or a channel's active subscribers. Nobody who merely
        // has an account is woken by a channel they do not follow (Anton, T-13).
        const eligible = where.kind === 'task' ? store.all('tasks').filter((t) => t.id === where.chan).flatMap(parties) : where.party;
        return eligible.filter((id) => id !== actor.id && dir.byId.get(id)?.status === 'active');
      }
      const who = dir.byName.get(name);
      return who?.status === 'active' ? [who.id] : [];
    }))];
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
      [...where.party, ...(where.closed === true ? [] : mentioned)].map((dest) => ({ dest, type: where.kind === 'channel' && !mentioned.includes(dest) ? 'message' : type, subject: where.chan, text: `${actor.name} in ${where.label}: ${clip(body, 400)}` })),
    );
    // What was being written is written: whoever watched it being typed stops seeing that.
    typingTold({ chan: where.chan, who: actor.id, composing: false });
    return message;
  }

  function newAgent(by: string, p: { name: string; kind?: string; about?: string; budget?: number }, status: 'pending' | 'active'): { agent: Row; token: string } {
    const name = p.name.toLowerCase();
    if (!NAME.test(name)) bad('invalid', 'a name is 2 to 32 of a-z, 0-9, - and _, and starts with a letter or a digit');
    reserved(name);
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
        project: str('Only tasks of this project; "none" for those without one.', 64),
        limit: { type: 'integer', description: 'At most this many (default 50).', min: 1, max: 500 },
      },
      run(actor, p) {
        const project = p.project === undefined ? null : p.project === 'none' ? '' : projectName(p.project as string);
        const assignee = p.assignee === undefined ? null : p.assignee === 'me' ? actor.id : p.assignee === 'none' ? '' : someone(p.assignee as string).id;
        const parent = p.parent === undefined ? null : (task(actor, p.parent as string).id as string);
        const wanted: string[] = p.status === 'all' ? [...STATUSES] : p.status !== undefined ? [p.status as string] : [...OPEN_STATUSES];
        const rows = store.ask(`(select {from: tasks where: (in status (at rb_q 'q0)) desc: seq})`, { sym: wanted });
        return rows
          .filter((t) => canSee(actor, t) && (assignee === null || t.assignee === assignee) && (parent === null || t.parent === parent) && (project === null || t.project === project))
          .slice(0, (p.limit as number | undefined) ?? 50)
          .map(({ body: _body, ...rest }) => shown(actor, rest));
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
      run(actor) {
        const subscribed = new Set(store.all('subscriptions').filter((r) => r.actor === actor.id && r.active === 1).map((r) => r.channel));
        const counts = new Map(store.ask(`(select {from: messages where: (== kind 'channel) by: {chan: chan} n: (count id) last: (max seq) last_author: (last author)})`).map((r) => [r.chan, r]));
        return store.all('channels').map((c) => ({ ...c, subscribed: subscribed.has(c.id), messages: counts.get(c.id as string)?.n ?? 0, last: counts.get(c.id as string)?.last ?? 0, last_author: counts.get(c.id as string)?.last_author ?? '' }));
      },
    },
    set_channel_subscription: {
      description: 'Subscribe yourself to notifications for future ordinary channel messages, or unsubscribe. Mentions still notify you. This does not subscribe anyone else or change channel access.',
      who: 'any', mutates: true,
      params: { channel: str('Channel name (#general) or id.', 80, true), subscribed: { type: 'boolean', description: 'Whether to receive channel notifications.', required: true } },
      run(actor, p) {
        const where = place(actor, p.channel as string);
        if (where.kind !== 'channel') bad('invalid', 'subscriptions apply only to shared channels');
        const id = `${actor.id}:${where.chan}`;
        const active = p.subscribed ? 1 : 0;
        if ((store.get('subscriptions', id)?.active ?? 0) !== active) {
          commit('channel.subscription', actor.id, where.chan, `${actor.name} ${active ? 'subscribed to' : 'unsubscribed from'} ${where.label}`, {
            subscriptions: [{ id, channel: where.chan, actor: actor.id, active }],
          });
        }
        return { channel: where.chan, subscribed: active === 1 };
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
        // Whether one may know of a task is decided when it is read, not when the note was written: a task
        // made private since is not told of to someone who may no longer see it.
        const mayKnow = (n: Row): boolean => {
          const t = TASK_ID.test(n.subject as string) ? store.get('tasks', n.subject as string) : null;
          return t === null || canSee(actor, t);
        };
        /** Up to 100 notes this actor may know of after the cursor, and how far the scan went: notes it may not
         *  know of are passed over, so they never stand between a reader (even one only peeking) and later notes. */
        const read = (): { items: Row[]; last: number; more: boolean } => {
          let last = Number(store.get('cursors', actor.id)?.seq ?? 0);
          const items: Row[] = [];
          for (;;) {
            const batch = store.ask(`(select {from: notes where: (and (in dest (at rb_q 'q0)) (> seq ${last})) asc: seq take: 500})`, { str: [actor.id] });
            for (const n of batch) {
              last = n.seq as number;
              if (!mayKnow(n)) continue;
              items.push(n);
              if (items.length === 100) return { items, last, more: true };
            }
            if (batch.length < 500) return { items, last, more: false };
          }
        };
        const cursor0 = Number(store.get('cursors', actor.id)?.seq ?? 0);
        // Moving past notes, seen or passed over, is what reading does; a peek moves nothing.
        const advance = (to: number): void => {
          if (p.peek !== true && to > Number(store.get('cursors', actor.id)?.seq ?? 0)) commit('inbox.read', actor.id, actor.id, '', { cursors: [{ id: actor.id, seq: to }] }, [], true);
        };
        let found = read();
        const wait = Math.min(INBOX_WAIT_MAX, (p.wait as number | undefined) ?? 0);
        if (found.items.length === 0 && wait > 0) {
          advance(found.last);
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
          found = read();
        }
        if (found.last > cursor0) advance(found.last);
        return { items: found.items.map(({ dest: _dest, id: _id, ...rest }) => rest), more: found.more };
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
          .filter((r) => p.mine !== true || (r.requester !== actor.id && tasks.get(r.task as string)?.assignee !== actor.id && (r.reviewer === '' || r.reviewer === actor.id)));
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
    typing: {
      description: 'Tell those who can read a conversation that you are writing to it right now, as a person typing is shown. Call it only when you are about to post there, never on a turn that posts nothing; repeat it every few seconds while you write, and it lapses by itself 8 seconds after the last call. Posting, or `composing: false`, ends it. Nothing of it is kept or notified.',
      who: 'any', mutates: false,
      params: {
        to: str('#channel, @name, dm:… or a task id: where you are writing.', 80, true),
        composing: { type: 'boolean', description: 'true while writing (the default), false to stop.' },
        hold: { type: 'integer', description: 'For an agent: how many seconds this report lasts, 1 to 60 (8 by default), for writing that takes a while; posting or `composing: false` still ends it at once.', min: 1, max: 60 },
        tab: str('For a page: which of its person\'s pages reports it, so that closing that page ends it.', 32),
      },
      run(actor, p) {
        // Read-only in the log, yet it speaks into a conversation: whoever may not post there may not type there.
        if (actor.role === 'viewer') bad('forbidden', 'viewers have read-only access');
        if (actor.kind === 'agent' && actor.status !== 'active') bad('paused', `you are ${actor.status} and can only read`);
        const to = (p.to as string).trim();
        if (to.startsWith('dm:')) {
          const ids = to.slice(3).split(':');
          if (ids.length !== 2 || !ids.includes(actor.id)) bad('forbidden', 'you can only write to your own direct messages');
        }
        const where = place(actor, to);
        // A person's page repeats its report while they type; an agent says once how long it will be writing.
        const holdMs = actor.kind === 'agent' && p.hold !== undefined ? (p.hold as number) * 1000 : undefined;
        const tab = typeof p.tab === 'string' && /^[a-z0-9]{1,32}$/i.test(p.tab) ? p.tab : undefined;
        typingTold({ chan: where.chan, who: actor.id, composing: p.composing !== false, ...(holdMs ? { holdMs } : {}), ...(tab ? { tab } : {}) });
        return { ok: true, chan: where.chan };
      },
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
        project: str('What it belongs to, such as rayforce or rayboard: lower-case letters, digits, ".", "-" and "_". A subtask takes its parent\'s when this is left out.', 64),
        priority: { type: 'integer', description: '0 low, 1 normal (default), 2 high, 3 urgent.', min: 0, max: 3 },
        review: { type: 'string', description: '"required" (default): it is done only when someone other than its author approves it. "optional": the assignee may complete it alone.', enum: ['required', 'optional'] },
      },
      run(actor, p) {
        const assignee = p.assignee === undefined ? null : available(p.assignee as string);
        const above = p.parent === undefined ? null : task(actor, p.parent as string);
        const parent = above === null ? '' : (above.id as string);
        const project = p.project !== undefined ? projectName(p.project as string) : ((above?.project as string | undefined) ?? '');
        const participants = several((p.participants as string | undefined) ?? '');
        tasksMade += 1;
        const at = now().toISOString();
        const t: Row = {
          id: `T-${tasksMade}`, title: p.title as string, body: (p.body as string | undefined) ?? '', status: 'open', creator: actor.id, assignee: assignee?.id ?? '', reviewer: '',
          parent, priority: (p.priority as number | undefined) ?? 1, review: (p.review as string | undefined) ?? 'required', result: '', created: at, updated: at, seq: seq + 1,
          outcome: p.outcome as string, next: (p.next as string | undefined) ?? '', participants: participants.join(' '), private: p.private === true ? 1 : 0, rev: 1, dependency: '', check: '', project,
        };
        commit('task.created', actor.id, t.id as string, `${actor.name} created ${t.id}: ${clip(t.title as string)}${assignee ? ` for ${assignee.name}` : ''}`, { tasks: [t] }, [
          ...(assignee ? [{ dest: assignee.id, type: 'task.assigned', subject: t.id as string, text: `${actor.name} gave you ${t.id}: ${t.title}` }] : []),
          ...participants.map((dest) => ({ dest, type: 'task.participant', subject: t.id as string, text: `${actor.name} made you a participant of ${t.id}: ${t.title}` })),
        ]);
        return t;
      },
    },
    update_task: {
      description: 'Change what a task says: its title, description, outcome, next action, priority, project, participants or privacy. Its creator, whoever holds it, or a person may. You must pass the `rev` you read, so that two changes made at once cannot silently overwrite each other.',
      who: 'any', mutates: true,
      params: {
        task: TASK,
        rev: { ...REV, required: true },
        title: str('A new title.', 200),
        body: str('A new description.', 20_000),
        outcome: str('What can be observed when it is done.', 2000),
        next: str('The next concrete action.', 500),
        priority: { type: 'integer', description: '0 low, 1 normal, 2 high, 3 urgent.', min: 0, max: 3 },
        project: str('The project it belongs to; "none" for none.', 64),
        participants: str('The full new list of participants, names separated by spaces; "none" for nobody.', 400),
        private: { type: 'boolean', description: 'Whether only its parties and the people overseeing the board see it. Only its creator or a person changes this.' },
      },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number);
        if (actor.kind !== 'user' && t.creator !== actor.id && t.assignee !== actor.id) bad('forbidden', `only the creator of ${t.id}, whoever holds it, or a person can change it`);
        if (p.private !== undefined && actor.kind !== 'user' && t.creator !== actor.id) bad('forbidden', `only the creator of ${t.id} or a person decides who may see it`);
        // What was approved stays what was reviewed: a person reopens it before it changes.
        if (actor.kind !== 'user' && (t.status === 'done' || t.status === 'cancelled')) bad('conflict', `${t.id} is ${t.status}; a person reopens it before it changes`);
        const change: Record<string, string | number> = {};
        for (const key of ['title', 'body', 'outcome', 'next', 'priority'] as const) if (p[key] !== undefined) change[key] = p[key] as string | number;
        if (p.project !== undefined) {
          if (p.project === 'none' && store.all('gh_items').some((g) => g.task === t.id)) bad('invalid', `${t.id} came from GitHub and always belongs to a project; move it to another instead`);
          change.project = p.project === 'none' ? '' : projectName(p.project as string);
        }
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
    move_task: {
      description: 'Move a task between workflow stages by its board lane. Review requires an actual verdict; a required review cannot be completed by dragging.',
      who: 'any', mutates: true,
      params: { task: TASK, status: { type: 'string', description: 'open, in_progress, waiting, blocked, in_review or done.', enum: [...OPEN_STATUSES, 'in_review', 'done'], required: true }, rev: { ...REV, required: true }, note: str('For waiting or blocked, what it waits for and when to check next.', 2000), reviewer: str('For in_review, the reviewer; not yourself.', 40) },
      run(actor, p) {
        const t = task(actor, p.task as string, p.rev as number);
        const next = p.status as string;
        if (next === t.status) return t;
        if (actor.kind !== 'user' && t.creator !== actor.id && t.assignee !== actor.id) bad('forbidden', 'only the creator, holder or a person may move this task');
        if (t.status === 'done' || t.status === 'cancelled') {
          if (next !== 'open') bad('conflict', `${t.id} is ${t.status}; reopen it to return to the board`);
          // Approved work is reopened by a person; a cancellation is undone by whoever may cancel: its creator or a person.
          if (actor.kind !== 'user' && (t.status === 'done' || t.creator !== actor.id)) bad('forbidden', t.status === 'done' ? `only a person reopens ${t.id} once it is done` : `only the creator of ${t.id} or a person undoes its cancellation`);
          return saveTask(actor, t, { status: 'open', result: '' }, 'task.reopened', `${actor.name} reopened ${t.id}`, told(t, 'task.reopened', `${actor.name} reopened ${t.id}`));
        }
        if (next === 'open') {
          if (t.status === 'in_review') bad('conflict', 'a pending review must be decided before returning to the backlog');
          return saveTask(actor, t, { status: 'open' }, 'task.backlog', `${actor.name} returned ${t.id} to the backlog`, told(t, 'task.backlog', `${actor.name} returned ${t.id} to the backlog`));
        }
        if (next === 'in_progress') {
          if (t.status === 'in_review') bad('conflict', 'a pending review must be decided before resuming work');
          if (t.status !== 'in_progress' && (t.assignee === '' || (actor.kind === 'agent' && t.assignee !== actor.id))) bad('conflict', 'claim or assign the task before starting it');
          return saveTask(actor, t, { status: 'in_progress', dependency: '', check: '' }, 'task.started', `${actor.name} moved ${t.id} to in progress`, told(t, 'task.started', `${actor.name} moved ${t.id} to in progress`));
        }
        if (next === 'waiting' || next === 'blocked') {
          if (t.status === 'in_review') bad('conflict', 'a pending review must be decided before the task waits');
          const note = (p.note as string | undefined)?.trim();
          if (!note) bad('invalid', 'waiting or blocked needs a note saying what it depends on and when to check next');
          return saveTask(actor, t, { status: next, dependency: note, check: note }, `task.${next}`, `${actor.name} moved ${t.id} to ${next}`, told(t, `task.${next}`, `${actor.name} moved ${t.id} to ${next}: ${note}`));
        }
        if (next === 'in_review') {
          if (t.status === 'in_review') return t;
          const reviewer = p.reviewer === undefined ? null : available(p.reviewer as string);
          if (reviewer?.id === actor.id || (reviewer !== null && reviewer.id === t.assignee)) bad('invalid', 'nobody reviews their own work');
          const review: Row = { id: ident('r'), task: t.id!, requester: actor.id, reviewer: reviewer?.id ?? '', status: 'pending', note: 'Moved to review from the board.', comment: '', decider: '', created: now().toISOString(), decided: NEVER, seq: seq + 1 };
          saveTask(actor, t, { status: 'in_review', reviewer: reviewer?.id ?? '' }, 'review.requested', `${actor.name} asked for review of ${t.id}`, [{ dest: reviewer?.id ?? t.creator as string, type: 'review.requested', subject: t.id as string, text: `${actor.name} asks for review of ${t.id}` }], { reviews: [review] });
          return review;
        }
        if (t.review === 'required') bad('forbidden', 'this task needs an independent review before it is done');
        if (!['in_progress', 'waiting', 'blocked', 'changes_requested'].includes(t.status as string)) bad('conflict', 'start this task before completing it');
        if (actor.kind === 'agent' && t.assignee !== actor.id) bad('forbidden', 'only its holder can complete this task');
        const open = pendingReview(t.id as string);
        if (t.result === '') bad('invalid', 'add the result before moving a task to done');
        return saveTask(actor, t, { status: 'done', result: t.result, dependency: '', check: '' }, 'task.completed', `${actor.name} completed ${t.id}`, doneNotes(t, actor), open ? { reviews: [{ ...open, status: 'withdrawn', decider: actor.id, decided: now().toISOString(), seq: seq + 1 }] } : {});
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
        // Whoever asked for it, and whoever holds the task (did the work), never decide it.
        if (review.requester === actor.id || t.assignee === actor.id) bad('forbidden', 'nobody reviews their own work');
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
        if (actor.kind !== 'user' && t.assignee !== actor.id) bad('forbidden', `${t.id} is not yours`);
        if (t.review === 'required') bad('forbidden', `${t.id} is done only when someone else approves it: use request_review, then review_task`);
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
        tokens_in: { type: 'integer', description: 'Input tokens.', min: 0, max: 1_000_000_000_000 },
        tokens_out: { type: 'integer', description: 'Output tokens.', min: 0, max: 1_000_000_000_000 },
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

    // Only the caller's own row can be changed; viewers stay read-only here too (see server.test).
    set_profile: {
      description: 'Describe yourself to the other participants.', who: 'user', mutates: true,
      params: { about: str('A short biography.', 2000) },
      run(actor, p) {
        const row = store.get('users', actor.id)!;
        const next = { ...row, about: clip((p.about as string | undefined) ?? '', 2000) };
        commit('person.profile_changed', actor.id, actor.id, actor.name + ' changed their profile', { users: [next] });
        return userView(next);
      },
    },
    set_agent_avatar: {
      description: 'Set your own PNG/JPEG avatar; an administrator may assign any agent. Base64, up to 1 MiB.',
      who: 'any', mutates: true,
      params: { agent: str('An administrator names the agent; an agent always changes itself.', 40), image: { type: 'string', description: 'Base64 image bytes.', required: true, max: 1_500_000 }, type: { type: 'string', description: 'png or jpg.', required: true, enum: ['png', 'jpg'] } },
      run(actor, p) { return api.setAgentAvatar(actor, (p.agent as string | undefined) ?? '', Buffer.from(p.image as string, 'base64').subarray(0), p.type as string); },
    },
    clear_agent_avatar: {
      description: 'Remove your own avatar, or an administrator removes an agent avatar; the default identity returns.', who: 'any', mutates: true, params: { agent: str('For an administrator, the agent id.', 40) },
      run(actor, p) { api.clearAgentAvatar(actor, (p.agent as string | undefined) ?? ''); return { ok: true }; },
    },
    remove_avatar: {
      description: 'Remove your own profile image.', who: 'user', mutates: true, params: {},
      run(actor) { api.clearAvatar(actor.id); return { ok: true }; },
    },
    // ---- for the people overseeing the board ----
    dashboard: {
      description: 'Everything the dashboard shows, in one answer.',
      who: 'user', mutates: false, params: {},
      run(actor) {
        const at = now().toISOString();
        const month = new Map(store.ask(`(select {from: costs where: (>= ts (first (at rb_q 'q0))) by: {agent: agent} usd: (sum usd)})`, { ts: monthStart(at) }).map((r) => [r.agent, Number(r.usd)]));
        // Where the last messages from others sit in each conversation, so a page counts what it has not read
        // (its read marks are its own): an unread number, not a total (Anton, T-461). At most 99 each.
        const fromOthers = new Map<string, number[]>();
        for (const m of [...store.ask(`(select {seq: seq chan: chan author: author from: messages where: (== kind 'channel)})`), ...store.ask(`(select {seq: seq chan: chan author: author from: messages where: (== kind 'dm)})`)]) {
          if (m.author === actor.id || m.author === 'github') continue;
          const list = fromOthers.get(m.chan as string) ?? [];
          list.push(Number(m.seq));
          fromOthers.set(m.chan as string, list);
        }
        const recentFrom = (chan: string): number[] => (fromOthers.get(chan) ?? []).sort((a, b) => a - b).slice(-99);
        return {
          now: at,
          agents: store.all('agents').map((a) => ({ ...agentView(a), avatar: a.avatar ? `/api/avatars/${a.id}/${a.avatar}` : '', spent: month.get(a.id as string) ?? 0 })),
          people: store.all('users').map(userView),
          channels: (actions.list_channels!.run(actor, {}) as Row[]).map((c) => ({ ...c, recent: recentFrom(c.id as string) })),
          tasks: (() => {
            const tasks = store.ask(`(select {from: tasks desc: seq take: 1000})`).filter((t) => canSee(actor, t));
            // What last happened to each task, whoever did it: a change, a comment, evidence or a review.
            // Without who, a person's own edit would come back to them as something new.
            const latest = new Map(store.ask(`(select {from: events where: (in subject (at rb_q 'q0)) by: {subject: subject} last: (max seq) last_author: (last actor)})`, { str: tasks.map((t) => t.id as string) }).map((e) => [e.subject, e]));
            return tasks.map(({ body: _body, ...rest }) => {
              const e = latest.get(rest.id as string);
              return { ...shown(actor, rest), last: Math.max(Number(rest.seq ?? 0), Number(e?.last ?? 0)), last_author: e?.last_author ?? '' };
            });
          })(),
          reviews: actions.list_reviews!.run(actor, {}),
          dms: store.ask(`(select {from: messages where: (== kind 'dm) by: {chan: chan} n: (count id) last: (max seq) last_author: (last author)})`).filter((d) => (d.chan as string).split(':').includes(actor.id) || isAdmin(actor)).map((d) => ({ ...d, recent: recentFrom(d.chan as string) })),
          threads: store.ask(`(select {from: messages where: (== kind 'task) by: {chan: chan} n: (count id) last: (max seq) last_author: (last author)})`).filter((r) => {
            const t = store.get('tasks', r.chan as string);
            return t !== null && canSee(actor, t);
          }),
          github: store.all('gh_items').filter((g) => { const t = store.get('tasks', g.task as string); return t !== null && canSee(actor, t); })
            .map((g, _i, all) => ({ task: g.task, kind: g.kind, repo: g.repo_name, number: g.number, url: g.url, state: g.state, author: g.author,
              head: g.sha ?? '', checks: g.checks || 'none', review: g.review || 'none',
              closes: String(g.closes ?? '').split(' ').filter((n) => n !== '').map(Number),
              // The pull requests of the same repository that say they close this issue.
              closed_by: g.kind === 'issue' ? all.filter((p) => p.repo === g.repo && p.kind === 'pr' && String(p.closes ?? '').split(' ').includes(String(g.number))).map((p) => Number(p.number)) : [] })),
          enrollment: (store.get('settings', 'enroll')?.value ?? '') !== '',
          invites: store.all('invites').filter((i) => (i.expires as string) > at).map((i) => ({ id: i.id, role: i.role, created: i.created, expires: i.expires, by: i.by })),
          seq,
        };
      },
    },
    create_agent: {
      description: 'Add an agent and get its token. The token is shown once.',
      who: 'user', mutates: true, admin: true, secret: true,
      params: { name: str('Its name.', 32, true), kind: str('What runs it, e.g. claude-code.', 40), about: str('What it is good at.', 500), budget: { type: 'number', description: 'US dollars a month; 0 for no limit.', min: 0, max: 1_000_000 } },
      run: (actor, p) => newAgent(actor.id, { name: p.name as string, kind: p.kind as string | undefined, about: p.about as string | undefined, budget: p.budget as number | undefined }, 'active'),
    },
    approve_agent: {
      description: 'Let an agent that asked to join take part.',
      who: 'user', mutates: true, admin: true, params: { agent: str('The agent.', 40, true) },
      run: (actor, p) => setAgent(actor, p.agent as string, { status: 'active', reason: '' }, 'agent.approved', (n) => `${actor.name} approved ${n}`, ['pending']),
    },
    pause_agent: {
      description: 'Stop an agent from changing anything until it is resumed. It can still read.',
      who: 'user', mutates: true, admin: true, params: { agent: str('The agent.', 40, true), reason: str('Why.', 300) },
      run: (actor, p) => setAgent(actor, p.agent as string, { status: 'paused', reason: (p.reason as string | undefined) ?? `paused by ${actor.name}` }, 'agent.paused', (n) => `${actor.name} paused ${n}`, ['active']),
    },
    resume_agent: {
      description: 'Let a paused agent work again. One paused for its budget is paused again at its next report unless the budget is raised.',
      who: 'user', mutates: true, admin: true, params: { agent: str('The agent.', 40, true) },
      run: (actor, p) => setAgent(actor, p.agent as string, { status: 'active', reason: '' }, 'agent.resumed', (n) => `${actor.name} resumed ${n}`, ['paused']),
    },
    revoke_agent: {
      description: 'End an agent\'s access for good. Its token stops working at once.',
      who: 'user', mutates: true, admin: true, params: { agent: str('The agent.', 40, true) },
      run: (actor, p) => setAgent(actor, p.agent as string, { status: 'revoked', reason: `revoked by ${actor.name}`, token: '' }, 'agent.revoked', (n) => `${actor.name} revoked ${n}`, ['pending', 'active', 'paused']),
    },
    rotate_token: {
      description: 'Give an agent a new token. The old one stops working at once; the new one is shown once.',
      who: 'user', mutates: true, admin: true, secret: true, params: { agent: str('The agent.', 40, true) },
      run(actor, p) {
        const target = someone(p.agent as string, 'agent');
        const token = `rb_${target.id}_${secret()}`;
        return { agent: setAgent(actor, target.id, { token: sha(token) }, 'agent.token_rotated', (n) => `${actor.name} gave ${n} a new token`, ['pending', 'active', 'paused']), token };
      },
    },
    set_budget: {
      description: 'Set what an agent may spend in a month.',
      who: 'user', mutates: true, admin: true, params: { agent: str('The agent.', 40, true), usd: { type: 'number', description: 'US dollars a month; 0 for no limit.', required: true, min: 0, max: 1_000_000 } },
      run: (actor, p) => setAgent(actor, p.agent as string, { budget: p.usd as number }, 'agent.budget', (n) => `${actor.name} set the budget of ${n} to ${usd(p.usd as number)} a month`, ['pending', 'active', 'paused']),
    },
    rename_person: {
      description: 'Rename a person, keeping their id, history and login secret. Useful to free a name for an agent.',
      who: 'user', mutates: true, admin: true,
      params: { user: str('The person.', 40, true), name: str('The new unique name.', 32, true) },
      run(actor, p) {
        const target = someone(p.user as string, 'person');
        if (target.kind !== 'user') bad('not_found', `${target.name} is an agent, not a person`);
        const name = (p.name as string).toLowerCase();
        if (!NAME.test(name)) bad('invalid', 'a name is 2 to 32 of a-z, 0-9, - and _');
        reserved(name);
        const found = directory().byName.get(name);
        if (found !== undefined && found.id !== target.id) bad('conflict', `the name ${name} is taken`);
        const row = store.get('users', target.id)!;
        const next = { ...row, name };
        commit('person.renamed', actor.id, target.id, `${target.name} was renamed ${name}`, { users: [next] });
        return userView(next);
      },
    },
    invite_person: {
      description: 'Invite a person with a one-time link, valid for 48 hours. New people are members unless another role is chosen.',
      who: 'user', mutates: true, admin: true, secret: true,
      params: { role: HUMAN_ROLE },
      run(actor, p) {
        const key = 'rbi_' + secret();
        const row = { id: 'invite:' + sha(key), token: sha(key), role: (p.role as string | undefined) ?? 'member', created: now().toISOString(), expires: new Date(now().getTime() + INVITE_MS).toISOString(), by: actor.id };
        commit('person.invited', actor.id, row.id, actor.name + ' invited a ' + row.role, { invites: [row] });
        return { key, role: row.role, expires: row.expires };
      },
    },
    revoke_invite: {
      description: 'End an invitation before it is used.',
      who: 'user', mutates: true, admin: true, params: { invite: str('The invitation id.', 80, true) },
      run(actor, p) {
        const row = store.get('invites', p.invite as string) ?? bad('not_found', 'no such invitation');
        if ((row.expires as string) <= now().toISOString()) bad('conflict', 'the invitation has expired');
        commit('person.invite_revoked', actor.id, row.id as string, actor.name + ' revoked an invitation', { invites: [{ ...row, expires: now().toISOString() }] });
        return { ok: true };
      },
    },
    set_role: {
      description: "Change a person's access. The last active administrator cannot be demoted.",
      who: 'user', mutates: true, admin: true, params: { user: str('The person.', 40, true), role: { ...ROLE, required: true } },
      run(actor, p) {
        const target = someone(p.user as string, 'person');
        const row = target.kind === 'user' ? store.get('users', target.id)! : bad('not_found', 'an agent does not have a human role');
        const role = p.role as 'admin' | 'member' | 'viewer';
        if (roleOf(row) === 'admin' && role !== 'admin' && store.all('users').filter((u) => u.status === 'active' && roleOf(u) === 'admin').length === 1) bad('conflict', 'keep at least one active administrator');
        commit('person.role_changed', actor.id, row.id as string, actor.name + ' made ' + row.name + ' a ' + role, { users: [{ ...row, role }] });
        return userView({ ...row, role });
      },
    },
    deactivate_person: {
      description: "Deactivate a person without deleting history; their identity cannot be reused.", who: 'user', mutates: true, admin: true, params: { user: str('The person.', 40, true) },
      run(actor, p) {
        const target = someone(p.user as string, 'person');
        const row = target.kind === 'user' ? store.get('users', target.id)! : bad('not_found', 'an agent is not a person');
        if (row.status !== 'active') bad('conflict', `${target.name} is not active`);
        // Nobody locks themselves out with one click; another administrator does it.
        if (row.id === actor.id) bad('conflict', 'you cannot deactivate yourself; ask another administrator');
        if (roleOf(row) === 'admin' && store.all('users').filter((u) => u.status === 'active' && roleOf(u) === 'admin').length === 1) bad('conflict', 'keep at least one active administrator');
        const next = { ...row, status: 'deactivated' };
        commit('person.deactivated', actor.id, row.id as string, actor.name + ' deactivated ' + row.name, { users: [next] });
        return userView(next);
      },
    },
    new_enrollment_key: {
      description: 'Make a new key with which agents can ask to join. The one before stops working. Shown once.',
      who: 'user', mutates: true, admin: true, secret: true, params: {},
      run(actor) {
        const key = `rbe_${secret()}`;
        commit('enrollment.rotated', actor.id, 'enrollment', `${actor.name} made a new enrollment key`, { settings: [{ id: 'enroll', value: sha(key) }] });
        return { key };
      },
    },
    disable_enrollment: {
      description: 'Stop agents from asking to join until a new key is made.',
      who: 'user', mutates: true, admin: true, params: {},
      run(actor) {
        commit('enrollment.disabled', actor.id, 'enrollment', `${actor.name} closed enrollment`, { settings: [{ id: 'enroll', value: '' }] });
        return { ok: true };
      },
    },
    set_github_repos: {
      description: 'Which GitHub repositories the board follows (owner/name, separated by spaces), until the GitHub App is connected: from then on the board follows exactly what the App is installed on, chosen on GitHub, and every check replaces this list.',
      who: 'user', mutates: true, admin: true,
      params: { repos: str('owner/name of each repository, separated by spaces; "none" for none.', 2000, true) },
      run(actor, p) {
        const names = (p.repos as string).trim() === 'none' ? [] : [...new Set((p.repos as string).split(/[\s,]+/).filter((n) => n !== ''))];
        for (const n of names) if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(n)) bad('invalid', `${clip(n, 80)} is not owner/name`);
        // A repository kept keeps the id GitHub gave it; one removed is no longer followed, and its tasks stay as they are.
        const before = followed();
        const list = names.map((name) => before.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? { name, id: '' });
        commit('github.repos', actor.id, 'github.repos', `${actor.name} set the followed GitHub repositories: ${names.join(' ') || 'none'}`, { settings: [{ id: 'github.repos', value: JSON.stringify(list) }] });
        return list;
      },
    },
    github_status: {
      description: 'The GitHub repositories followed and the last deliveries taken.',
      who: 'user', mutates: false, admin: true, params: {},
      run() {
        let app: unknown = null;
        try { app = JSON.parse(store.get('settings', 'github.app')?.value as string ?? 'null'); } catch { app = null; }
        // Who the App is, from the file the connection wrote; its key and secret are never read here.
        const file = join(dirname(options.base), 'github', 'app.json');
        let connected: unknown = null;
        try { if (existsSync(file)) { const a = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; connected = { slug: a.slug, owner: a.owner, html_url: a.html_url }; } } catch { connected = null; }
        return { repos: followed(), connected, app, deliveries: store.ask(`(select {from: gh_deliveries desc: ts take: 20})`), writes: store.ask(`(select {from: gh_writes desc: ts take: 20})`) };
      },
    },
    reconcile_github: {
      description: 'Close the tasks from GitHub whose issue or pull request is already merged or closed there and that nobody took up (no holder, no thread, no evidence): merged or closed is done, a pull request closed without merging is cancelled. With dry_run, only says what it would do.',
      who: 'user', mutates: true, admin: true,
      params: { dry_run: { type: 'boolean', description: 'Only count and list what would be closed; change nothing.' } },
      run(actor, p) {
        const dry = p.dry_run === true;
        const close: { t: Row; url: string; status: 'done' | 'cancelled'; result: string }[] = [];
        const skipped: { task: string; url: string; state: string; why: string }[] = [];
        for (const g of store.all('gh_items')) {
          const finished = finishedOnGithub(g);
          const t = finished === null ? null : store.get('tasks', g.task as string);
          if (t === null) continue;
          const why = takenUp(t);
          if (why === 'done' || why === 'cancelled') continue;
          if (why !== '') skipped.push({ task: t.id as string, url: g.url as string, state: g.state as string, why });
          else close.push({ t, url: g.url as string, ...finished! });
        }
        const num = (id: string): number => Number(id.slice(2));
        close.sort((a, b) => num(a.t.id as string) - num(b.t.id as string));
        skipped.sort((a, b) => num(a.task) - num(b.task));
        // One change per task, each in the audit log with its reason; all of them one frame of the log.
        if (!dry) {
          for (const c of close) {
            saveTask(actor, c.t, { status: c.status, result: c.result, dependency: '', check: '' }, c.status === 'done' ? 'task.completed' : 'task.cancelled', `${actor.name} closed ${c.t.id} as GitHub did: ${c.result}`, []);
          }
        }
        return {
          dry_run: dry,
          done: close.filter((c) => c.status === 'done').length,
          cancelled: close.filter((c) => c.status === 'cancelled').length,
          closed: close.map((c) => ({ task: c.t.id, status: c.status, url: c.url })),
          skipped,
        };
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

  // ---- GitHub (T-19, stage 1: read only) ----

  /** The repositories the board follows, by name, and by GitHub's id once a delivery has told it. */
  const followed = (): { name: string; id: string }[] => {
    try {
      const list = JSON.parse(store.get('settings', 'github.repos')?.value as string ?? '[]') as { name: string; id: string }[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  /** What a commit's check runs come to (T-446): none, pending while any runs, failure if any failed, else success. */
  const summarizeChecks = (runs: Row[]): string => {
    if (runs.length === 0) return 'none';
    if (runs.some((r) => r.status === 'completed' && FAILED.has(r.conclusion as string))) return 'failure';
    if (runs.some((r) => r.status !== 'completed')) return 'pending';
    return 'success';
  };
  const checksOf = (repo: string, sha: string): string => (sha === '' ? 'none' : summarizeChecks(store.all('gh_checks').filter((c) => c.repo === repo && c.sha === sha)));
  /** What a pull request's reviews come to: changes requested by anyone outweighs approval; a dismissed review counts for nothing. */
  const summarizeReviews = (reviews: Row[]): string => {
    const live = reviews.filter((r) => r.state !== 'dismissed');
    if (live.some((r) => r.state === 'changes_requested')) return 'changes_requested';
    if (live.some((r) => r.state === 'approved')) return 'approved';
    return live.some((r) => r.state === 'commented') ? 'commented' : 'none';
  };
  const reviewOf = (repo: string, number: number): string => summarizeReviews(store.all('gh_reviews').filter((r) => r.repo === repo && Number(r.number) === number));
  /**
   * What an item finished on GitHub means for a task nobody took up (T-479): merged, or an issue closed, is done;
   * a pull request closed without merging is cancelled. Null while it is open.
   */
  const finishedOnGithub = (g: { kind?: unknown; state?: unknown; url?: unknown }): { status: 'done' | 'cancelled'; result: string } | null => {
    if (g.state === 'merged') return { status: 'done', result: `Merged on GitHub: ${g.url}` };
    if (g.state !== 'closed') return null;
    return g.kind === 'pr' ? { status: 'cancelled', result: `Closed on GitHub without merging: ${g.url}` } : { status: 'done', result: `Closed on GitHub: ${g.url}` };
  };
  /**
   * Why the board may not close a task because its item finished on GitHub, or '' when it may: only a task still
   * open that nobody holds, spoke in or attached evidence to. Anything someone took up is theirs to decide.
   */
  const takenUp = (t: Row): string => {
    if (t.status !== 'open') return t.status as string;
    if (t.assignee !== '') return 'held';
    const id = { str: [t.id as string] };
    if (store.ask(`(select {from: messages where: (in chan (at rb_q 'q0)) take: 1})`, id).length > 0) return 'has a thread';
    if (store.ask(`(select {from: evidence where: (in task (at rb_q 'q0)) take: 1})`, id).length > 0) return 'has evidence';
    return '';
  };

  function githubDelivery(delivery: string, event: string, payload: Record<string, unknown>): { result: 'applied' | 'duplicate' | 'ignored'; task?: string } {
    if (broken) throw new Error('the log could not be written; the board accepts nothing until it is restarted');
    if (store.get('gh_deliveries', delivery) !== null) return { result: 'duplicate' };
    const at = now().toISOString();
    const { repo, item, ping, check = null, review = null } = readGithub(event, payload);
    const list = followed();
    // A repository is followed by its id once known; until then by its name, and the id is kept from then on.
    const entry = repo === null ? undefined : list.find((r) => (r.id !== '' ? r.id === repo.id : r.name.toLowerCase() === repo.name.toLowerCase()));
    const receipt = (result: string): Row => ({ id: delivery, ts: at, event, repo: repo?.id ?? '', result });
    if (repo === null || entry === undefined || (item === null && ping === null && check === null && review === null)) {
      commit('github.ignored', 'github', delivery, '', { gh_deliveries: [receipt('ignored')] }, [], true);
      return { result: 'ignored' };
    }
    const settings: Record<string, Row[]> = entry.id === '' ? { settings: [{ id: 'github.repos', value: JSON.stringify(list.map((r) => (r === entry ? { ...r, id: repo.id } : r))) }] } : {};
    const short = repo.name.split('/').pop() ?? repo.name;
    if (item !== null) {
      // Known by repository id and number: both never change, and unlike node ids they are the same for a pull
      // request whether GitHub describes it as itself or as the issue it also is.
      const key = `${repo.id}#${item.number}`;
      const known = store.get('gh_items', key);
      // An older delivery never undoes what a newer one said.
      if (known !== null && Date.parse(item.updated) < Date.parse(known.updated as string)) {
        commit('github.stale', 'github', known.task as string, '', { gh_deliveries: [receipt('stale')], ...settings }, [], true);
        return { result: 'ignored', task: known.task as string };
      }
      const label = `${short}#${item.number}`;
      if (known === null) {
        tasksMade += 1;
        // An item already finished on GitHub comes in finished, not as open work nobody will ever decide (T-479).
        const finished = finishedOnGithub(item);
        const t: Row = {
          id: `T-${tasksMade}`, title: clip(`${label} ${item.title}`, 200), body: `GitHub ${item.kind === 'pr' ? 'pull request' : 'issue'} ${item.url}
Reported by @${item.author} on GitHub. The conversation with its author stays there.`,
          status: finished?.status ?? 'open', creator: 'github', assignee: '', reviewer: '', parent: '', priority: 1, review: 'required', result: finished?.result ?? '', created: at, updated: at, seq: seq + 1,
          outcome: `Resolved on GitHub: ${item.url}`, next: '', participants: '', private: repo.private ? 1 : 0, rev: 1, dependency: '', check: '',
          // Its repository is its project; a person may move it elsewhere later, and GitHub never moves it back.
          project: projectName(short),
        };
        const head = item.head ?? '';
        const g: Row = { id: key, repo: repo.id, repo_name: repo.name, kind: item.kind, number: item.number, url: item.url, title: item.title, state: item.state, author: item.author, updated: item.updated, task: t.id,
          sha: head, closes: (item.closes ?? []).join(' '), checks: checksOf(repo.id, head), review: reviewOf(repo.id, item.number) };
        const already = finished === null ? '' : `, already ${item.state} (${finished.status})`;
        commit('github.imported', 'github', t.id as string, `GitHub ${label} came in as ${t.id}${already}: ${clip(item.title)}`, { tasks: [t], gh_items: [g], gh_deliveries: [receipt('applied')], ...settings });
        return { result: 'applied', task: t.id as string };
      }
      const t = store.get('tasks', known.task as string)!;
      const title = clip(`${label} ${item.title}`, 200);
      // A delivery that does not say a head or a description (the issues API) keeps what an earlier one said.
      const head = item.head ?? (known.sha as string | undefined) ?? '';
      const g: Row = { ...known, repo_name: repo.name, url: item.url, title: item.title, state: item.state, updated: item.updated,
        sha: head, closes: item.closes !== undefined ? item.closes.join(' ') : ((known.closes as string | undefined) ?? ''), checks: checksOf(repo.id, head), review: reviewOf(repo.id, item.number) };
      // GitHub's state is shown beside the task, and written into it only when nobody took the task up (T-479):
      // then it is closed as GitHub closed it. A task someone holds or spoke in is theirs to decide; they are told.
      const changed = item.state !== known.state;
      const said = item.state === 'open' ? 'was reopened' : item.state === 'merged' ? 'was merged' : 'was closed';
      const finished = changed ? finishedOnGithub(item) : null;
      const closes = finished !== null && takenUp(t) === '';
      const put: Record<string, Row[]> = { gh_items: [g], gh_deliveries: [receipt('applied')], ...settings };
      const change: Partial<Row> = {
        ...(title !== t.title || (repo.private ? 1 : 0) !== t.private ? { title, private: repo.private ? 1 : 0 } : {}),
        ...(closes ? { status: finished!.status, result: finished!.result } : {}),
      };
      if (Object.keys(change).length > 0) put.tasks = [{ ...t, ...change, updated: at, seq: seq + 1, rev: (t.rev as number) + 1 }];
      commit('github.updated', 'github', t.id as string, `GitHub ${label}${changed ? ` ${said}` : ' changed'}${closes ? `; ${t.id} is ${finished!.status}` : ''}`, put,
        changed && !closes ? parties(t).map((dest) => ({ dest, type: 'github', subject: t.id as string, text: `GitHub ${label} ${said}: ${item.url}. Decide here whether ${t.id} is done or cancelled.` })) : []);
      return { result: 'applied', task: t.id as string };
    }
    if (check !== null) {
      const id = `${repo.id}#${check.sha}#${check.name}`;
      const before = store.get('gh_checks', id);
      // A run's outcome only moves forward: an older delivery, or a queued run after a completed one, changes nothing.
      const stale = before !== null && (Date.parse(check.at) < Date.parse(before.ts as string) || (before.status === 'completed' && check.status !== 'completed'));
      const row: Row = stale ? before! : { id, repo: repo.id, sha: check.sha, name: check.name, status: check.status, conclusion: check.conclusion, ts: check.at };
      // The pull requests it ran for: those GitHub names, and any whose head it is.
      const items = store.all('gh_items').filter((g) => g.repo === repo.id && g.kind === 'pr' && (g.sha === check.sha || check.prs.includes(Number(g.number))));
      const put: Record<string, Row[]> = { gh_checks: [row], gh_deliveries: [receipt(stale ? 'stale' : 'applied')], ...settings };
      const notes: Note[] = [];
      const updated: Row[] = [];
      for (const g of items) {
        const head = g.sha === '' ? check.sha : (g.sha as string);
        if (head !== check.sha) continue;
        const summary = summarizeChecks([...store.all('gh_checks').filter((c) => c.repo === repo.id && c.sha === head && c.id !== id), row]);
        if (summary === g.checks && g.sha === head) continue;
        updated.push({ ...g, sha: head, checks: summary });
        const t = store.get('tasks', g.task as string);
        // Checks failing is news to whoever holds the task; passing, running or a reconciliation is not.
        if (t !== null && summary === 'failure' && g.checks !== 'failure' && t.assignee !== '') {
          notes.push({ dest: t.assignee as string, type: 'github', subject: t.id as string, text: `Checks failed on GitHub ${short}#${g.number} (${check.name}): ${g.url}/checks` });
        }
      }
      if (updated.length > 0) put.gh_items = updated;
      commit('github.checks', 'github', updated[0]?.task as string ?? delivery, updated.length > 0 ? `GitHub ${short}#${updated.map((g) => g.number).join(', #')} checks: ${updated[0]!.checks}` : '', put, notes, updated.length === 0 || notes.length === 0);
      return { result: stale ? 'ignored' : 'applied', ...(updated[0] ? { task: updated[0].task as string } : {}) };
    }
    if (review !== null) {
      const id = `${repo.id}#${review.number}#${review.login}`;
      const before = store.get('gh_reviews', id);
      if (before === null || Date.parse(review.at) >= Date.parse(before.ts as string)) {
        const row: Row = { id, repo: repo.id, number: review.number, login: review.login, state: review.state, ts: review.at };
        const g = store.get('gh_items', `${repo.id}#${review.number}`);
        const summary = summarizeReviews([...store.all('gh_reviews').filter((r) => r.repo === repo.id && Number(r.number) === review.number && r.id !== id), row]);
        const put: Record<string, Row[]> = { gh_reviews: [row], ...settings };
        if (g !== null && g.review !== summary) put.gh_items = [{ ...g, review: summary }];
        // A review that is also news wakes the holder below, with this same frame's receipt.
        if (ping === null) {
          commit('github.review', 'github', (g?.task as string | undefined) ?? delivery, '', { ...put, gh_deliveries: [receipt('applied')] }, [], true);
          return { result: 'applied', ...(g ? { task: g.task as string } : {}) };
        }
        commit('github.review', 'github', (g?.task as string | undefined) ?? delivery, '', put, [], true);
      } else if (ping === null) {
        commit('github.stale', 'github', delivery, '', { gh_deliveries: [receipt('stale')], ...settings }, [], true);
        return { result: 'ignored' };
      }
    }
    // Someone spoke or reviewed on GitHub: whoever holds the task is told where, not what.
    const known = store.get('gh_items', `${repo.id}#${ping!.number}`) ?? undefined;
    if (known === undefined) {
      commit('github.ignored', 'github', delivery, '', { gh_deliveries: [receipt('ignored')], ...settings }, [], true);
      return { result: 'ignored' };
    }
    const t = store.get('tasks', known.task as string)!;
    const holder = t.assignee as string;
    commit('github.activity', 'github', t.id as string, `@${ping!.login} ${ping!.what} on GitHub`, { gh_deliveries: [receipt('applied')], ...settings },
      holder === '' ? [] : [{ dest: holder, type: 'github', subject: t.id as string, text: `@${ping!.login} ${ping!.what} in ${short}: ${ping!.url}. Answer there.` }]);
    return { result: 'applied', task: t.id as string };
  }

  /** Who is told that a task is done: its creator, and whoever holds the task it is a part of. */
  function doneNotes(t: Row, actor: Actor): Note[] {
    const parent = t.parent === '' ? null : store.get('tasks', t.parent as string);
    // A private parent is named only to those who may see it: the holder above, told below.
    const text = `${t.id} is done: ${t.title}${parent && parent.private !== 1 ? ` (part of ${parent.id})` : ''}`;
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
        if (!v.isWellFormed()) bad('invalid', `${name}: "${key}" is not well-formed text (a lone UTF-16 surrogate)`);
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

  const api: Board = {
    actions,
    store,
    options,
    async call(actor, name, params) {
      if (broken) throw new Error('the log could not be written; the board accepts nothing until it is restarted');
      const action = Object.hasOwn(actions, name) ? actions[name]! : bad('not_found', `there is no action ${clip(name, 40)}`);
      if (action.who !== 'any' && action.who !== actor.kind) bad('forbidden', action.who === 'user' ? `${name} is for the people overseeing the board` : `${name} is for agents`);
      if (action.admin === true && !isAdmin(actor)) bad('forbidden', `${name} is for administrators`);
      if (action.mutates && actor.role === 'viewer') bad('forbidden', 'viewers have read-only access');
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
    setAgentAvatar(actor, user, bytes, type) {
      const target = actor.kind === 'agent' ? actor.id : user;
      if (actor.kind !== 'agent' && !isAdmin(actor)) bad('forbidden', 'only an administrator may assign another agent an avatar');
      const row = store.get('agents', target) ?? bad('not_found', 'no such agent');
      const mime = type === 'png' ? 'image/png' : type === 'jpg' ? 'image/jpeg' : '';
      const signature = type === 'png' ? Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : type === 'jpg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (mime === '' || bytes.length < 1 || bytes.length > 1024 * 1024 || !signature) bad('invalid', 'an avatar is a PNG or JPEG image, up to 1 MiB');
      const id = createHash('sha256').update(bytes).digest('hex');
      const path = join(dirname(options.base), 'avatars', id);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
      const next = { ...row, avatar: id, avatar_type: type };
      commit('agent.avatar_changed', actor.id, target, row.name + ' changed their avatar', { agents: [next] });
      const old = row.avatar as string;
      if (old && old !== id && store.all('users').every((u) => u.avatar !== old) && store.all('agents').every((a) => a.avatar !== old)) unlinkSync(join(dirname(path), old));
      return '/api/avatars/' + target + '/' + id;
    },
    clearAgentAvatar(actor, user) {
      const target = actor.kind === 'agent' ? actor.id : user;
      if (actor.kind !== 'agent' && !isAdmin(actor)) bad('forbidden', 'only an administrator may clear another agent avatar');
      const row = store.get('agents', target) ?? bad('not_found', 'no such agent');
      commit('agent.avatar_cleared', actor.id, target, row.name + ' removed their avatar', { agents: [{ ...row, avatar: '', avatar_type: '' }] });
      const old = row.avatar as string;
      if (old && store.all('users').every((u) => u.avatar !== old) && store.all('agents').every((a) => a.avatar !== old)) unlinkSync(join(dirname(options.base), 'avatars', old));
    },
    putImage(actor, bytes) {
      if (actor.role === 'viewer') bad('forbidden', 'a viewer reads the board and does not add to it');
      const type = imageType(bytes) ?? bad('invalid', 'an image is a PNG, JPEG, GIF or WebP file');
      if (bytes.length > IMAGE_MAX) bad('invalid', `an image may be up to ${IMAGE_MAX / 1024 / 1024} MB`);
      // Not named by its content: whoever knows an image must not learn whether someone else pasted it too.
      const id = randomBytes(24).toString('hex');
      const path = join(dirname(options.base), 'images', id);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
      commit('image.added', actor.id, id, '', { images: [{ id, type, size: bytes.length, by: actor.id, created: now().toISOString() }] }, [], true);
      return { id, url: `/api/images/${id}`, type, size: bytes.length };
    },
    image(actor, id) {
      if (!/^[a-f0-9]{48}$/.test(id)) return null;
      const row = store.get('images', id);
      const path = join(dirname(options.base), 'images', id);
      if (row === null || !existsSync(path)) return null;
      if (row.by !== actor.id && !mayReadImage(actor, id)) return null;
      return { bytes: readFileSync(path), type: row.type as string };
    },
    avatar(user) {
      const row = store.get('users', user) ?? store.get('agents', user);
      if (row === null || typeof row.avatar !== 'string' || !/^[a-f0-9]{64}$/.test(row.avatar)) return null;
      const path = join(dirname(options.base), 'avatars', row.avatar);
      if (!existsSync(path)) return null;
      return { bytes: readFileSync(path), type: row.avatar_type === 'png' ? 'image/png' : 'image/jpeg', id: row.avatar };
    },
    setAvatar(user, bytes, type) {
      const row = store.get('users', user) ?? bad('not_found', 'no such person');
      const mime = type === 'png' ? 'image/png' : type === 'jpg' ? 'image/jpeg' : '';
      const signature = type === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : type === 'jpg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (mime === '' || !signature) bad('invalid', 'an avatar is a PNG or JPEG image');
      const id = createHash('sha256').update(bytes).digest('hex');
      const path = join(dirname(options.base), 'avatars', id);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
      const next = { ...row, avatar: id, avatar_type: type };
      commit('person.avatar_changed', user, user, row.name + ' changed their avatar', { users: [next] });
      const old = row.avatar as string;
      if (old && old !== id && store.all('users').every((u) => u.avatar !== old) && store.all('agents').every((a) => a.avatar !== old)) unlinkSync(join(dirname(path), old));
      return '/api/avatars/' + user + '/' + id;
    },
    clearAvatar(user) {
      const row = store.get('users', user) ?? bad('not_found', 'no such person');
      const next = { ...row, avatar: '', avatar_type: '' };
      commit('person.avatar_cleared', user, user, row.name + ' removed their avatar', { users: [next] });
      const old = row.avatar as string;
      if (old && store.all('users').every((u) => u.avatar !== old) && store.all('agents').every((a) => a.avatar !== old)) unlinkSync(join(dirname(options.base), 'avatars', old));
    },
    mayKnow(user, subject) {
      const row = store.get('users', user);
      if (row === null || row.status !== 'active') return false;
      const who = actorOfUser(row);
      // A direct conversation, even only that it moved, is for its two and the administrators.
      if (subject.startsWith('dm:')) return subject.split(':').includes(who.id) || isAdmin(who);
      const t = TASK_ID.test(subject) ? store.get('tasks', subject) : null;
      return t === null || canSee(who, t);
    },
    mayRead(id, chan) {
      const user = store.get('users', id);
      const agent = user === null ? store.get('agents', id) : null;
      const who = user !== null ? (user.status === 'active' ? actorOfUser(user) : null) : agent !== null && agent.status !== 'revoked' ? actorOfAgent(agent) : null;
      if (who === null) return false;
      if (chan.startsWith('dm:')) return chan.split(':').includes(who.id) || isAdmin(who);
      if (TASK_ID.test(chan)) { const t = store.get('tasks', chan); return t !== null && canSee(who, t); }
      return store.all('channels').some((c) => c.id === chan);
    },
    onTyping: (listener) => void typingListeners.push(listener),
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
    async createUser(name, password, role = 'admin') {
      const handle = name.toLowerCase();
      if (!NAME.test(handle)) bad('invalid', 'a name is 2 to 32 of a-z, 0-9, - and _');
      reserved(handle);
      if (password.length < 10 || password.length > 200) bad('invalid', 'a password has at least 10 characters');
      const pass = await Bun.password.hash(password, { algorithm: 'argon2id' });
      if (directory().byName.has(handle)) bad('conflict', `the name ${handle} is taken`);
      if (!ROLES.includes(role)) bad('invalid', 'a person is an admin, member or viewer');
      const user: Row = { id: ident('u'), name: handle, pass, status: 'active', role, created: now().toISOString() };
      commit('user.created', user.id as string, user.id as string, `${handle} joined as ${role === 'admin' ? 'an administrator' : role === 'viewer' ? 'a viewer' : 'a member'}`, { users: [user] });
      return actorOfUser(user);
    },
    async acceptInvite(key, name, password) {
      const id = 'invite:' + sha(key);
      if (accepting.has(id)) bad('conflict', 'this invitation is already being accepted');
      accepting.add(id);
      try {
        const invitation = store.get('invites', id) ?? bad('unauthorized', 'the invitation is not valid');
        if ((invitation.expires as string) <= now().toISOString()) bad('unauthorized', 'the invitation has expired or was already used; ask for a new one');
        const user = await this.createUser(name, password, invitation.role as 'admin' | 'member' | 'viewer');
        commit('person.invite_accepted', user.id, id, user.name + ' accepted an invitation', { invites: [{ ...invitation, expires: now().toISOString() }] });
        return user;
      } finally {
        accepting.delete(id);
      }
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
    githubDelivery,
    githubFollowed: () => followed(),
    githubKnown(repo, number, updated) {
      const g = store.get('gh_items', `${repo}#${number}`);
      return g !== null && (g.sha ?? '') !== '' && Date.parse(g.updated as string) >= Date.parse(updated);
    },
    githubLabelTargets() {
      // GitHub lets an App label a pull request only with pull_requests: write; with issues: write alone it
      // answers 403. Pull requests are labelled once the grant allows it, issues always (T-446, Mica's review).
      let granted: Record<string, string> = {};
      try { granted = (JSON.parse(store.get('settings', 'github.app')?.value as string ?? '{}') as { permissions?: Record<string, string> }).permissions ?? {}; } catch { granted = {}; }
      const prs = granted.pull_requests === 'write';
      return store.all('gh_items').flatMap((g) => {
        if (g.kind === 'pr' && !prs) return [];
        const t = store.get('tasks', g.task as string);
        if (t === null) return [];
        // A cancelled task says nothing on GitHub: its label, if any, is taken off.
        const want = BOARD_LABELS[t.status as string] ?? '';
        const has = (g.label as string | undefined) ?? '';
        // An item finished on GitHub before the board ever labelled it gets no label now: closing its task for
        // GitHub's sake is not news to write back (T-479).
        if (has === '' && g.state !== 'open') return [];
        return want === has ? [] :[{ item: g.id as string, repo: g.repo_name as string, number: Number(g.number), want }];
      });
    },
    githubLabelWritten(item, want, ok, detail) {
      const g = store.get('gh_items', item);
      if (g === null) return;
      const at = now().toISOString();
      const short = String(g.repo_name).split('/').pop();
      const write: Row = { id: `w_${seq + 1}`, ts: at, item, want, result: ok ? 'ok' : 'failed', detail: clip(detail, 500) };
      commit('github.label', 'github', g.task as string, ok ? `GitHub ${short}#${g.number} labelled ${want || '(no rb: label)'}` : `GitHub ${short}#${g.number}: writing ${want || 'no label'} did not take: ${clip(detail, 200)}`,
        ok ? { gh_items: [{ ...g, label: want }], gh_writes: [write] } : { gh_writes: [write] }, [], ok);
    },
    githubGrant(grant, problems) {
      const at = now().toISOString();
      // What the App is installed on is what the board follows, by id, so a rename on GitHub keeps it.
      // A repository taken out of the installation is no longer followed; its tasks stay as they are.
      const list = grant.repos.map((r) => ({ name: r.name, id: r.id })).sort((x, y) => x.name.localeCompare(y.name));
      const stable = { installation: grant.installation, permissions: grant.permissions, repos: grant.repos.map((r) => r.name), problems };
      let before: Record<string, unknown> = {};
      try { before = JSON.parse(store.get('settings', 'github.app')?.value as string ?? '{}') as Record<string, unknown>; } catch { before = {}; }
      const { checked: _checked, ...was } = before;
      // A check that finds what the last one found writes nothing: it runs every ten minutes.
      const known = followed();
      if (JSON.stringify(was) === JSON.stringify(stable) && JSON.stringify(list) === JSON.stringify(known)) return;
      const value = JSON.stringify({ ...stable, checked: at });
      const names = (l: { name: string }[]) => l.map((r) => r.name.toLowerCase()).sort().join(' ');
      if (names(list) !== names(known)) {
        commit('github.repos', 'github', 'github.repos', `Following the repositories the GitHub App is installed on: ${list.map((r) => r.name).join(' ') || 'none'}`, { settings: [{ id: 'github.repos', value: JSON.stringify(list) }] });
      }
      commit('github.grant', 'github', 'github.app', problems.length === 0 ? 'GitHub App grant checked' : `GitHub App grant checked: ${problems.join('; ')}`,
        { settings: [{ id: 'github.app', value }, { id: 'github.repos', value: JSON.stringify(list) }] }, [], problems.length === 0);
    },
    close: () => store.close(),
  };
  // What came from GitHub always belongs to a project: one that came in without (before projects
  // existed) is put under its repository's, once, when the board opens. A person may move it, not clear it.
  {
    const at = now().toISOString();
    const filled = store.all('gh_items').flatMap((g) => {
      const t = store.get('tasks', g.task as string);
      if (t === null || (t.project ?? '') !== '') return [];
      const short = String(g.repo_name).split('/').pop() ?? '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(short)) return [];
      return [{ ...t, project: short.toLowerCase(), updated: at, seq: seq + 1, rev: (t.rev as number) + 1 }];
    });
    if (filled.length > 0) commit('github.projects', 'github', 'github.projects', `${filled.length} task${filled.length === 1 ? '' : 's'} from GitHub put under their repository's project`, { tasks: filled });
  }
  return api;
}
const DUMMY_HASH = await Bun.password.hash(randomBytes(16).toString('hex'), { algorithm: 'argon2id' });
