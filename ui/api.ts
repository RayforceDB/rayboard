import { useCallback, useEffect, useRef, useState } from 'react';

export type Row = Record<string, any>;

export interface Snapshot {
  now: string;
  agents: Row[];
  people: Row[];
  channels: Row[];
  tasks: Row[];
  reviews: Row[];
  dms: Row[];
  /** How many comments each task's thread holds, by task id in `chan`. */
  threads?: Row[];
  /** Issues and pull requests the board follows on GitHub, by the task each is worked on as. */
  github?: Row[];
  enrollment: boolean;
  invites?: Row[];
  seq: number;
}

/** The token this session's changes must carry. It lives in memory only and is asked for again when the page is loaded. */
let csrf = '';

async function send(path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: { code: string; message: string } } | null;
  if (typeof (data as { csrf?: unknown } | null)?.csrf === 'string') csrf = (data as { csrf: string }).csrf;
  if (data === null || data.ok !== true) {
    const err = new Error(data?.error?.message ?? `the server answered ${res.status}`) as Error & { code?: string };
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

export const api = {
  session: (): Promise<{ setup: boolean; user: Row | null; unsafe?: boolean }> => send('/api/session'),
  setup: (code: string, name: string, password: string) => send('/api/setup', { code, name, password }),
  join: (key: string, name: string, password: string) => send('/api/join', { key, name, password }),
  login: (name: string, password: string) => send('/api/login', { name, password }),
  logout: () => send('/api/logout', {}),
  avatar: async (file: File): Promise<string> => {
    const res = await fetch('/api/avatar', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf, 'X-Avatar-Type': file.type === 'image/png' ? 'png' : 'jpg' }, body: file });
    const data = await res.json();
    if (!res.ok || !data.ok) { const e = new Error(data?.error?.message ?? 'the upload failed') as Error & { code?: string }; e.code = data?.error?.code; throw e; }
    return data.result;
  },
  /** Keeps an image pasted into text; answers the path it is served at. */
  image: async (blob: Blob): Promise<string> => {
    const res = await fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf }, body: blob });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) { const e = new Error(data?.error?.message ?? (res.status === 413 ? 'the image is too large' : 'the upload failed')) as Error & { code?: string }; e.code = data?.error?.code; throw e; }
    return data.result.url as string;
  },
  removeAvatar: () => send('/api/call/remove_avatar', {}),
  password: (current: string, next: string) => send('/api/password', { current, next }),
  call: async <T = any>(action: string, params: Row = {}): Promise<T> => (await send(`/api/call/${action}`, params)).result as T,
  githubConnect: (owner: string): Promise<{ url: string; manifest: Row }> => send('/api/github/connect', { owner }),
  githubSync: () => send('/api/github/sync', {}),
};

/** The board as the dashboard shows it, asked for again whenever the server says something changed. `tick` grows with every change. */
export function useBoard(onSignedOut: () => void): { board: Snapshot | null; tick: number; live: boolean; failed: string; refresh: () => void } {
  const [board, setBoard] = useState<Snapshot | null>(null);
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);
  const [failed, setFailed] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    api.call<Snapshot>('dashboard').then(
      (snapshot) => {
        setBoard(snapshot);
        setFailed('');
        setTick((t) => t + 1);
      },
      (err: Error & { code?: string }) => {
        if (err.code === 'unauthorized') onSignedOut();
        // Anything else is said on the page: a board that cannot be read must not look like an empty one.
        else setFailed(err.message);
      },
    );
  }, [onSignedOut]);

  useEffect(() => {
    refresh();
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = (): void => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      socket.onopen = () => {
        setLive(true);
        refresh();
      };
      socket.onmessage = (event) => {
        if ((JSON.parse(event.data as string) as { quiet: boolean }).quiet) return;
        // Changes often come several at once; one look after the last of them is enough.
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(refresh, 120);
      };
      socket.onclose = () => {
        setLive(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    // Whether an agent is online changes without anything being written.
    const poll = setInterval(refresh, 30_000);
    return () => {
      closed = true;
      clearInterval(poll);
      if (retry !== null) clearTimeout(retry);
      socket?.close();
    };
  }, [refresh]);

  return { board, tick, live, failed, refresh };
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.round(s / 86_400)}d ago`;
  return iso.slice(0, 10);
}
export const clock = (iso: string): string => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** "Today 10:14", "Yesterday 09:02", or the date: how a conversation says when. */
export function when(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date): string => d.toDateString();
  if (day(at) === day(new Date(now))) return `Today ${time}`;
  if (day(at) === day(new Date(now - 86_400_000))) return `Yesterday ${time}`;
  return clock(iso);
}
export const usd = (n: number): string => `$${n.toFixed(2)}`;
