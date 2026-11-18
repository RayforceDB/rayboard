import type { Row } from './api';

/**
 * Messages this page sent, kept until a read of their conversation includes them. A read that was already on its
 * way when the message was accepted comes back without it; without this the message would vanish until the read
 * after (Mica, T-456).
 */
export class Sent {
  private readonly held = new Map<string, Row[]>();
  /** Remembers a message the server accepted into `where`. */
  add(where: string, m: Row): void {
    const list = this.held.get(where) ?? [];
    if (!list.some((x) => x.id === m.id)) this.held.set(where, [...list, m]);
  }
  /** What a read of `where` should show: the read itself, with any sent message it does not have yet after it in order. */
  merge(where: string, read: Row[]): Row[] {
    const list = this.held.get(where);
    if (list === undefined) return read;
    const seen = new Set(read.map((m) => m.id));
    const missing = list.filter((m) => !seen.has(m.id));
    if (missing.length === 0) { this.held.delete(where); return read; }
    this.held.set(where, missing);
    return [...read, ...missing].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  }
}
