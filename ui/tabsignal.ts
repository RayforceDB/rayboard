// T-462 (Anton: nothing tells me of new things while the tab is in the background): the tab's title carries how
// many things wait, and, if the person turns it on, the browser notifies of a new message while the tab is hidden.
// A notification names where something was written, never what: its text may be private or long.
import { useEffect, useRef } from 'react';
import type { Row } from './api';

const PREF = 'rayboard.notify';
export const BASE_TITLE = 'rayboard';

export const tabTitle = (waiting: number): string => (waiting > 0 ? `(${waiting > 99 ? '99+' : waiting}) ${BASE_TITLE}` : BASE_TITLE);

/** Whether this browser can notify at all, and whether this person turned it on here. */
export const notifySupported = (): boolean => typeof window !== 'undefined' && 'Notification' in window;
export function notifyWanted(): boolean {
  try { return localStorage.getItem(PREF) === 'on' && notifySupported() && Notification.permission === 'granted'; } catch { return false; }
}
/** Turns notifications on, asking the browser only now, from the person's own click. Answers whether they are on. */
export async function enableNotify(): Promise<boolean> {
  if (!notifySupported()) return false;
  const answer = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  try { localStorage.setItem(PREF, answer === 'granted' ? 'on' : 'off'); } catch { /* a preference only */ }
  return answer === 'granted';
}
export function disableNotify(): void {
  try { localStorage.setItem(PREF, 'off'); } catch { /* a preference only */ }
}

export interface Conversation { key: string; label: string; unread: number }

/**
 * Which conversations gained unread messages since the last look, as the notification lines to show:
 * nothing on the first look (what was already waiting at load is not news), nothing that went down.
 */
export function newlyUnread(before: Map<string, number> | null, now: Conversation[]): Conversation[] {
  if (before === null) return [];
  return now.filter((c) => c.unread > (before.get(c.key) ?? 0));
}

/** Keeps the tab title, and notifications if wanted, in step with what waits for this person. */
export function useTabSignal(waiting: number | null, conversations: Conversation[] | null, open: (key: string) => void): void {
  useEffect(() => {
    if (waiting !== null) document.title = tabTitle(waiting);
  }, [waiting]);
  const seen = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (conversations === null) return;
    const fresh = newlyUnread(seen.current, conversations);
    seen.current = new Map(conversations.map((c) => [c.key, c.unread]));
    if (fresh.length === 0 || !document.hidden || !notifyWanted()) return;
    for (const c of fresh.slice(0, 3)) {
      try {
        const n = new Notification(BASE_TITLE, { body: c.label, tag: c.key });
        n.onclick = () => { window.focus(); open(c.key); n.close(); };
      } catch { /* a browser that will not show it: the title still tells */ }
    }
  }, [conversations, open]);
}

/** The conversations a person is told about: channels and their own direct conversations, not agents' among themselves. */
export function conversationsOf(board: { channels: Row[]; dms: Row[] }, me: string, unreadOf: (row: Row) => number, name: (id: string) => string): Conversation[] {
  return [
    ...board.channels.map((c) => ({ key: c.id as string, label: `New message in #${c.name as string}`, unread: unreadOf(c) })),
    ...board.dms.filter((d) => (d.chan as string).split(':').includes(me)).map((d) => {
      const other = (d.chan as string).split(':').slice(1).find((id) => id !== me) ?? me;
      return { key: d.chan as string, label: `New message from ${name(other)}`, unread: unreadOf(d) };
    }),
  ];
}
