// Who is writing where (T-476): told by the live feed, kept only in this page, and let go when it lapses even if
// the "stopped" never arrives. This page also tells the board while its own person writes.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface Typing { chan: string; who: string; until: number }
/** What the feed says: how many milliseconds from now it lasts (0: stopped), counted by this page's own clock. */
export interface TypingFrame { chan: string; who: string; ms: number }

/** This page, among its person's pages: closing it ends what it was typing even while another page stays open. */
export const TAB = Math.random().toString(36).slice(2, 12);

const now = (): number => Date.now();
const entries = new Map<string, Typing>();
const subscribers = new Set<() => void>();
const notify = (): void => { for (const f of subscribers) f(); };

/** A frame from the live feed: someone writing for `ms` more, or stopped (0). */
export function heardTyping(f: TypingFrame): void {
  const key = `${f.chan}|${f.who}`;
  if (f.ms > 0) entries.set(key, { chan: f.chan, who: f.who, until: now() + f.ms }); else entries.delete(key);
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
  // What the text was when this conversation was opened: a draft carried over, or already there, is nobody typing
  // (Mattew, T-476). Only a change the person makes to it here is reported.
  const seen = useRef<{ to: string | null; text: string }>({ to: null, text: '' });
  useEffect(() => {
    if (to === null) return;
    if (seen.current.to !== to) { seen.current = { to, text }; return; }
    if (seen.current.text === text) return;
    seen.current = { to, text };
    const stop = (): void => {
      if (at.current !== null) void api.call('typing', { to: at.current, composing: false, tab: TAB }).catch(() => {});
      at.current = null;
      last.current = 0;
    };
    if (text.trim() === '') { stop(); return; }
    if (at.current !== to || now() - last.current >= REPORT_MS) {
      at.current = to;
      last.current = now();
      void api.call('typing', { to, composing: true, tab: TAB }).catch(() => {});
    }
  }, [to, text]);
  // Another conversation, or leaving the page: what was being written here is not being written any more.
  useEffect(() => () => {
    if (at.current !== null) void api.call('typing', { to: at.current, composing: false, tab: TAB }).catch(() => {});
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
