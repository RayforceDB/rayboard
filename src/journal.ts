import { existsSync, readFileSync } from 'node:fs';

// What one accepted change is while the board handles it: who did what to what, and the rows it
// wrote. It is kept by RayforceDB: the rows go into its tables and into its own write-ahead log
// (src/store.ts), and the rest becomes a row of the `events` table, which is the audit log.

export type Cell = string | number;
export type Row = Record<string, Cell>;

export interface Entry {
  seq: number;
  ts: string;
  /** What happened, e.g. `task.claimed`. */
  type: string;
  /** Who did it: an agent's or a person's id, or `system`. */
  actor: string;
  /** What it happened to: a task, an agent, a channel. */
  subject: string;
  /** One line a person can read in the audit log. Never holds a secret. */
  summary: string;
  /** The rows written, by table. */
  put: Record<string, Row[]>;
  /** Not shown in the audit log (an inbox cursor moving). */
  quiet?: boolean;
}

/**
 * The entries of a `journal.jsonl`, the file the first version of rayboard kept its changes in
 * before RayforceDB's own log did. Read once, to carry such a board over.
 */
export function readOldJournal(path: string): Entry[] {
  if (!existsSync(path)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      const parsed = JSON.parse(line) as Entry | { batch: Entry[] } | null;
      const found = typeof parsed === 'object' && parsed !== null && 'batch' in parsed && Array.isArray(parsed.batch) ? parsed.batch : [parsed as Entry];
      for (const e of found) if (typeof e === 'object' && e !== null && typeof e.seq === 'number' && typeof e.type === 'string' && typeof e.put === 'object') out.push(e);
    } catch {
      // Half a line left by a crash.
    }
  }
  return out;
}
