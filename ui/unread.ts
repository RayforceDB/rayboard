import { useCallback, useState } from 'react';
import type { Row } from './api';
const KEY = 'rayboard.read.v1';
type Reads = Record<string, number>;
function readAll(): Reads {
  try { const x = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return typeof x === 'object' && x !== null && !Array.isArray(x) ? x : {}; }
  catch { return {}; }
}
/**
 * A later message cannot be acknowledged before it is present in the rendered snapshot.
 * What GitHub sync alone did (an import, a new title or state) is nobody's news: hundreds of imports would
 * all read as changed. Whoever holds such a task is told of what matters in their inbox.
 */
export function changed(row: Row, read: number, self: string): boolean {
  return Number(row.last ?? row.seq ?? 0) > read && row.last_author !== self && row.last_author !== 'github';
}
/** How many messages from others lie beyond this read mark in a conversation (the dashboard lists where the last 99 are). */
export function unreadIn(row: Row, read: number): number {
  const recent = Array.isArray(row.recent) ? (row.recent as number[]) : [];
  return recent.filter((seq) => seq > read).length;
}
export function unreadCount(rows: Row[], reads: Reads, self: string, prefix = ''): number {
  return rows.filter((r) => ((r.id ?? r.chan) as string).startsWith(prefix) && changed(r, reads[(r.id ?? r.chan) as string] ?? 0, self)).length;
}
export function useUnread(self: string) {
  const [reads, setReads] = useState<Reads>(readAll);
  const markRead = useCallback((channel: string, last: number) => {
    setReads((old) => {
      if ((old[channel] ?? 0) >= last) return old;
      const next = { ...old, [channel]: last };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* convenience only */ }
      return next;
    });
  }, []);
  return { reads, unread: (row: Row) => changed(row, reads[(row.id ?? row.chan) as string] ?? 0, self), unreadOf: (row: Row) => unreadIn(row, reads[(row.id ?? row.chan) as string] ?? 0), markRead };
}
