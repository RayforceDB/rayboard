import type { Entry, Row } from './journal';
import { fromRayNs, toRayNs, type Column, type Ray, type Table } from './ray';

// The board's state is RayforceDB's: tables in memory, and the database's own write-ahead log on
// disk. Nothing else is kept anywhere. At start the database recovers itself from its last
// snapshot (`<base>.qdb`) and the log written since (`<base>.log`); every change after that is
// appended to the log, synced, as the very Rayfall expression that applies it to the tables, with
// its rows inside it as typed values. Everything the server knows it asks of these tables.
//
// No value that came from outside is ever part of a statement's text. Rows go in through `bind`
// and are put into the logged expression as values, and what a query is asked for goes in the
// same way, as the columns of `rb_q`.

type Kind = 'str' | 'sym' | 'i64' | 'f64' | 'ts';

/** A table whose rows are replaced by `id`, or one that only grows. */
interface Shape {
  keyed: boolean;
  columns: Record<string, Kind>;
}

export const SCHEMA = {
  users: { keyed: true, columns: { id: 'str', name: 'str', pass: 'str', status: 'sym', role: 'sym', created: 'ts' } },
  /** Only hashes of one-time human invitations are stored; an expired timestamp means used, revoked or expired. */
  invites: { keyed: true, columns: { id: 'str', token: 'str', role: 'sym', created: 'ts', expires: 'ts', by: 'str' } },
  agents: {
    keyed: true,
    columns: { id: 'str', name: 'str', kind: 'str', about: 'str', status: 'sym', reason: 'str', token: 'str', budget: 'f64', created: 'ts', by: 'str' },
  },
  settings: { keyed: true, columns: { id: 'str', value: 'str' } },
  channels: { keyed: true, columns: { id: 'str', name: 'str', topic: 'str', created: 'ts', by: 'str' } },
  tasks: {
    keyed: true,
    columns: {
      id: 'str', title: 'str', body: 'str', status: 'sym', creator: 'str', assignee: 'str', reviewer: 'str', parent: 'str',
      priority: 'i64', review: 'sym', result: 'str', created: 'ts', updated: 'ts', seq: 'i64',
      /** What can be observed when it is done; what happens next; who else takes part (ids, space-separated); whether only they see it. */
      outcome: 'str', next: 'str', participants: 'str', private: 'i64',
      /** Grows by one with every change, so a client can say which state it decided on. */
      rev: 'i64',
      /** While waiting or blocked: on what, and what to check next and when. */
      dependency: 'str', check: 'str',
    },
  },
  /** What shows that work was done, and what was done outside the board so that nobody does it twice. */
  evidence: { keyed: true, columns: { id: 'str', seq: 'i64', ts: 'ts', task: 'str', author: 'str', kind: 'sym', key: 'str', text: 'str' } },
  /** The answer each request with a request id was given, to give again when the request is repeated. */
  receipts: { keyed: true, columns: { id: 'str', hash: 'str', result: 'str', ts: 'ts' } },
  reviews: {
    keyed: true,
    columns: { id: 'str', task: 'str', requester: 'str', reviewer: 'str', status: 'sym', note: 'str', comment: 'str', decider: 'str', created: 'ts', decided: 'ts', seq: 'i64' },
  },
  cursors: { keyed: true, columns: { id: 'str', seq: 'i64' } },
  messages: { keyed: false, columns: { id: 'str', seq: 'i64', ts: 'ts', chan: 'str', kind: 'sym', author: 'str', body: 'str', mentions: 'str' } },
  costs: { keyed: false, columns: { id: 'str', seq: 'i64', ts: 'ts', agent: 'str', task: 'str', model: 'str', tin: 'i64', tout: 'i64', usd: 'f64', note: 'str' } },
  /** What each actor is to be told: the rows an inbox is made of. */
  notes: { keyed: false, columns: { id: 'str', seq: 'i64', ts: 'ts', dest: 'str', type: 'sym', subject: 'str', sender: 'str', text: 'str' } },
  events: { keyed: false, columns: { seq: 'i64', ts: 'ts', type: 'sym', actor: 'str', subject: 'str', summary: 'str' } },
} as const satisfies Record<string, Shape>;

export type TableName = keyof typeof SCHEMA;
const TABLES = Object.keys(SCHEMA) as TableName[];
/** Columns that hold a time, in any table: a result's column of that name is given back as ISO 8601. */
const TIMES = new Set(TABLES.flatMap((t) => Object.entries(SCHEMA[t].columns).filter(([, k]) => k === 'ts').map(([c]) => c)));

/** The time that stands for "never" in a column that cannot be empty. */
export const NEVER = '2000-01-01T00:00:00.000Z';

export type Param = { str: string[] } | { sym: string[] } | { ts: string };

/** What a row written before a column existed holds in it. */
const ABSENT: Record<Kind, string | number> = { str: '', sym: '', i64: 0, f64: 0, ts: '2000-01-01T00:00:00.000Z' };

function column(kind: Kind, given: unknown[], where: string): Column {
  const cells = given.map((c) => (c === undefined ? ABSENT[kind] : c));
  switch (kind) {
    case 'str':
    case 'sym':
      return { type: kind, data: cells.map((c) => (typeof c === 'string' ? c : fail(where, c))) };
    case 'i64':
      return { type: 'i64', data: BigInt64Array.from(cells, (c) => (typeof c === 'number' && Number.isSafeInteger(c) ? BigInt(c) : fail(where, c))) };
    case 'f64':
      return { type: 'f64', data: Float64Array.from(cells, (c) => (typeof c === 'number' && Number.isFinite(c) ? c : fail(where, c))) };
    case 'ts':
      return { type: 'timestamp', data: BigInt64Array.from(cells, (c) => (typeof c === 'string' ? toRayNs(c) : fail(where, c))) };
  }
}
function fail(where: string, cell: unknown): never {
  throw new Error(`${where}: ${JSON.stringify(cell)} does not fit the column`);
}

/** A result as rows. 64-bit integers here are sequence numbers and token counts, which fit a number. */
export function rowsOf(table: Table): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < table.rows; i++) {
    const row: Row = {};
    for (const name of table.names) {
      const cell = (table.columns[name] as ArrayLike<unknown>)[i];
      row[name] = typeof cell === 'bigint' ? (TIMES.has(name) ? fromRayNs(cell) : Number(cell)) : (cell as string | number);
    }
    out.push(row);
  }
  return out;
}

export interface Store {
  /** Writes the rows of one entry to the tables, and the entry itself as an event. It is not on disk until `flush`. */
  apply(entry: Entry): void;
  /** Appends everything applied since the last flush to the log as one frame, synced: after a crash all of it is there or none. */
  flush(seq: number): void;
  /** The sequence number of the last change that was flushed. */
  seq(): number;
  /** A query written in this repository. `params` become the columns q0, q1, ... of `rb_q`. */
  ask(source: string, ...params: Param[]): Row[];
  get(table: TableName, id: string): Row | null;
  all(table: TableName): Row[];
  count(table: TableName): number;
  /** Writes a snapshot of the tables and starts a fresh log, so the next start replays little. */
  snapshot(): void;
  close(): void;
}

/** So many frames, and the log is folded into a new snapshot. */
const SNAPSHOT_EVERY = 5000;

/** The names this side uses for what it hands over; they are emptied so that a snapshot holds the tables and nothing passing. */
const NAMES = '(set rb_batch null) (set rb_q null) (set rb_e null) (set rb_f null)';

/**
 * Opens the board kept at `base` (`<base>.qdb`, `<base>.log`), or begins an empty one there.
 * Throws when another process has it open.
 */
export function openStore(ray: Ray, base: string): Store {
  const empty = (t: TableName): Record<string, Column> =>
    Object.fromEntries(Object.entries(SCHEMA[t].columns).map(([name, kind]) => [name, column(kind, [], t)]));
  // Empty tables first: a board with no snapshot yet is replayed into them, and a snapshot replaces them.
  for (const t of TABLES) {
    ray.bind('rb_batch', empty(t));
    ray.run(`(set ${t} rb_batch)`);
  }
  // The database has one journal for a process; one left open by a board before this one is closed first.
  ray.run(`(do (.log.close) (set rb_seq 0) ${NAMES} null)`);
  ray.journal(base);
  // A snapshot replaces its empty table and has the columns of the version that made it. Carry
  // those rows over explicitly before another write: an upsert cannot introduce a new column.
  // This is source written here; all the values, including a password hash, stay bound as data.
  for (const t of TABLES) {
    const present = new Set(ray.table(`(select {from: ${t} take: 0})`).names);
    const added = Object.entries(SCHEMA[t].columns).filter(([name]) => !present.has(name));
    if (added.length === 0) continue;
    const before = rowsOf(ray.table(`(select {from: ${t}})`));
    const migrated = Object.fromEntries(Object.entries(SCHEMA[t].columns).map(([name, kind]) => [name, column(kind, before.map((r) => r[name]), t)]));
    ray.bind('rb_batch', migrated);
    ray.run(`(set ${t} rb_batch)`);
    console.log(`migrated ${t}: added ${added.map(([name]) => name).join(', ')}; kept ${before.length} rows`);
  }
  /** How many expressions wait in rb_p0, rb_p1, ... to be logged. */
  let pending = 0;
  // An older snapshot loaded over the current empty schema has to be rebuilt before any upsert.
  const migrate = (): void => {
    for (const t of TABLES) {
      const present = new Set(ray.table(`(select {from: ${t} take: 0})`).names);
      const added = Object.entries(SCHEMA[t].columns).filter(([name]) => !present.has(name));
      if (added.length === 0) continue;
      const before = rowsOf(ray.table(`(select {from: ${t}})`));
      const migrated = Object.fromEntries(Object.entries(SCHEMA[t].columns).map(([name, kind]) => [name, column(kind, before.map((r) => r[name]), t)]));
      ray.bind('rb_batch', migrated);
      ray.run(`(set ${t} rb_batch)`);
      console.log(`migrated ${t}: added ${added.map(([name]) => name).join(', ')}; kept ${before.length} rows`);
    }
  };
  migrate();
  /** Frames written since the last snapshot. */
  let frames = 0;

  const write = (t: TableName, rows: Row[]): void => {
    if (rows.length === 0) return;
    const shape: Shape = SCHEMA[t];
    ray.bind('rb_batch', Object.fromEntries(Object.entries(shape.columns).map(([name, kind]) => [name, column(kind, rows.map((r) => r[name]), `${t}.${name}`)])));
    // The change as an expression that holds its rows; it is applied now and logged, as it is, at the flush.
    const expr = shape.keyed ? `(list 'upsert (list 'quote '${t}) (list 'quote 'id) rb_batch)` : `(list 'insert (list 'quote '${t}) rb_batch)`;
    ray.run(`(do (set rb_p${pending} ${expr}) (eval rb_p${pending}) null)`);
    pending += 1;
  };

  const ask = (source: string, ...params: Param[]): Row[] => {
    if (params.length > 0) {
      ray.bind('rb_q', Object.fromEntries(params.map((p, i): [string, Column] => {
        if ('str' in p) return [`q${i}`, { type: 'str', data: p.str }];
        if ('sym' in p) return [`q${i}`, { type: 'sym', data: p.sym }];
        return [`q${i}`, { type: 'timestamp', data: BigInt64Array.of(toRayNs(p.ts)) }];
      })));
    }
    return rowsOf(ray.table(source));
  };
  const snapshot = (): void => ray.run(`(do ${NAMES} (.log.snapshot) null)`);
  // Every start leaves a fresh snapshot behind, so a start never replays more than one run's changes.
  snapshot();

  return {
    apply(entry) {
      for (const [t, rows] of Object.entries(entry.put)) {
        if (!(t in SCHEMA) || t === 'events') throw new Error(`a change writes to ${t}, which is no table of the board`);
        write(t as TableName, rows);
      }
      if (entry.quiet !== true) {
        write('events', [{ seq: entry.seq, ts: entry.ts, type: entry.type, actor: entry.actor, subject: entry.subject, summary: entry.summary }]);
      }
    },
    flush(seq) {
      if (pending === 0) return;
      if (!Number.isSafeInteger(seq)) throw new Error('not a sequence number');
      const exprs = Array.from({ length: pending }, (_, i) => `rb_p${i}`);
      pending = 0;
      // One frame: the changes, and how far the board has counted. Replaying it does exactly what was done here.
      ray.run(`(do (set rb_f (list 'do ${exprs.join(' ')} (list 'set 'rb_seq ${seq}) null)) (.log.write rb_f) (set rb_seq ${seq}) (set rb_f null) ${exprs.map((e) => `(set ${e} null)`).join(' ')} null)`);
      // A long run does not leave a long log to replay.
      frames += 1;
      if (frames >= SNAPSHOT_EVERY) {
        frames = 0;
        snapshot();
      }
    },
    seq: () => Number(ray.query('rb_seq')),
    ask,
    get: (t, id) => ask(`(select {from: ${t} where: (in id (at rb_q 'q0))})`, { str: [id] })[0] ?? null,
    all: (t) => rowsOf(ray.table(t)),
    count: (t) => Number(ray.query(`(count ${t})`)),
    snapshot,
    close: () => ray.run('(.log.close)'),
  };
}
