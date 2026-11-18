// Who is writing where (T-476): told by the live feed, kept only in this page, and let go when it lapses even if
// the "stopped" never arrives. This page also tells the board while its own person writes.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface Typing { chan: string; who: string; until: number }

const now = (): number => Date.now();
const entries = new Map<string, Typing>();
const subscribers = new Set<() => void>();
const notify = (): void => { for (const f of subscribers) f(); };

/** A frame from the live feed: someone writing (until in the future) or stopped (until 0). */
export function heardTyping(t: Typing): void {
  const key = `${t.chan}|${t.who}`;
  if (t.until > now()) entries.set(key, t); else entries.delete(key);
  notify();
}

/** Who, other than `me`, is writing in `chan` now. */
export function typingIn(chan: string, me: string, at = now()): string[] {
  return [...entries.values()].filter((t) => t.chan === chan && t.who !== me && t.until > at).map((t) => t.who);
}

/** The writers in a conversation, kept current: a lapse is noticed within a second without any word from the server. */
export function useTypingIn(chan: string, me: string): string[] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = (): void => setTick((n) => n + 1);
    subscribers.add(bump);
    const lapse = setInterval(bump, 1000);
    return () => { subscribers.delete(bump); clearInterval(lapse); };
  }, []);
  return typingIn(chan, me);
}

/** How often a writer's page repeats that it is writing; the board lets it lapse after 8 seconds without. */
export const REPORT_MS = 3000;

/**
 * Tells the board while there is text being written to `to`: at once, then every REPORT_MS while it changes;
 * that it stopped when the text is emptied (a sent message is cleared by the board itself), the conversation
 * changes or the page goes. Nothing is told for a reader who may not write (`to` null).
 */
export function useReportTyping(to: string | null, text: string): void {
  const last = useRef(0);
  const at = useRef<string | null>(null);
  useEffect(() => {
    if (to === null) return;
    const stop = (): void => {
      if (at.current !== null) void api.call('typing', { to: at.current, composing: false }).catch(() => {});
      at.current = null;
      last.current = 0;
    };
    if (text.trim() === '') { stop(); return; }
    if (at.current !== to || now() - last.current >= REPORT_MS) {
      at.current = to;
      last.current = now();
      void api.call('typing', { to, composing: true }).catch(() => {});
    }
  }, [to, text]);
  // Another conversation, or leaving the page: what was being written here is not being written any more.
  useEffect(() => () => {
    if (at.current !== null) void api.call('typing', { to: at.current, composing: false }).catch(() => {});
    at.current = null;
  }, [to]);
}

/** "mica is typing…", "mica and juniper are typing…", "3 people are typing…". */
export function typingLine(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}
