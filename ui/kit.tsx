import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import type { Row, Snapshot } from './api';
import rayforceOnDark from './assets/rayforce-on-dark.svg';
import rayforceOnLight from './assets/rayforce-on-light.svg';

/** rayboard's mark: an R of rounded blocks, the bars of its bowl lighter, as cards stacked in a lane. */
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size * 0.9} viewBox="-0.5 -0.5 30 27" aria-hidden="true">
      <rect x="0.5" y="0.5" width="10.5" height="5.6" rx="1.6" fill="#ffa066" />
      <rect x="0.5" y="8.2" width="10.5" height="5.8" rx="1.6" fill="#ff8d4a" />
      <path d="M10 0.5H22a6.75 6.75 0 0 1 0 13.5H10z" fill="#ff6a13" />
      <rect x="0.5" y="15.6" width="8.6" height="9.9" rx="1.6" fill="#ff6d1a" />
      <path d="M11.6 15.6H23.4l4.8 7.1c.9 1.4.3 2.8-1.4 2.8H16z" fill="#ff6a13" stroke="#ff6a13" strokeWidth="0.8" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand() {
  return (
    <h1 className="brand">
      <Mark />
      <span>rayboard</span>
    </h1>
  );
}

export function BuiltOn() {
  return (
    <a className="built-on" href="https://rayforcedb.com/" target="_blank" rel="noreferrer noopener">
      <span>Built on</span>
      <img className="on-dark" src={rayforceOnDark} alt="RayforceDB" />
      <img className="on-light" src={rayforceOnLight} alt="RayforceDB" />
    </a>
  );
}

export interface Ctx {
  board: Snapshot;
  tick: number;
  me: Row;
  /** The name of an agent or a person by id. */
  name: (id: string) => string;
  /** Runs something that changes the board and shows what went wrong if it fails. Resolves to whether it worked. */
  act: (work: () => Promise<unknown>) => Promise<boolean>;
  open: (view: string, item?: string) => void;
  unread: (row: Row) => boolean;
  unreadOf: (row: Row) => number;
  markRead: (channel: string, last: number) => void;
}
export const BoardContext = createContext<Ctx | null>(null);
export const useCtx = (): Ctx => useContext(BoardContext)!;

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open', in_progress: 'In progress', waiting: 'Waiting', blocked: 'Blocked', in_review: 'In review', changes_requested: 'Changes requested', done: 'Done', cancelled: 'Cancelled',
  pending: 'Waiting for approval', active: 'Active', paused: 'Paused', revoked: 'Revoked', approved: 'Approved', withdrawn: 'Withdrawn',
};

/** A review this person may decide: not one they asked for, not of a task they hold, and asked of them or of anyone. */
export function mayDecide(r: Row, me: Row, tasks: Row[]): boolean {
  return r.requester !== me.id && tasks.find((t) => t.id === r.task)?.assignee !== me.id && (r.reviewer === '' || r.reviewer === me.id);
}

export function Badge({ status }: { status: string }) {
  return <span className={`badge s-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** An agent is a coloured shape, the same one wherever it appears; a person is their initial. */
const SHAPES = [
  { body: 'M12 3 22 20H2z', facet: 'M12 3 12 20H2z' },
  { body: 'M12 2 21 7v10l-9 5-9-5V7z', facet: 'M12 2 21 7l-9 5-9-5z' },
  { body: 'M12 2 22 12 12 22 2 12z', facet: 'M12 2 12 22 2 12z' },
  { body: 'M12 2.5a9.5 9.5 0 1 1 0 19a9.5 9.5 0 1 1 0-19z', facet: 'M12 2.5a9.5 9.5 0 0 0 0 19z' },
  { body: 'M12 2 21.5 9 18 21H6L2.5 9z', facet: 'M12 2 12 21H6L2.5 9z' },
  { body: 'M4 4h16v16H4z', facet: 'M4 4h16L4 20z' },
];
const HUES = ['#8b5cf6', '#f5a524', '#22b35e', '#3b82f6', '#ec4899', '#14b8a6', '#f97316'];
const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function Avatar({ id, size = 24 }: { id: string; size?: number }) {
  const { board, name } = useCtx();
  const person = board.people.find((p) => p.id === id);
  if (person?.avatar) return <img className="avatar person" src={person.avatar} width={size} height={size} alt={`${name(id)} avatar`} />;
  const agent = board.agents.find((a) => a.id === id);
  if (agent?.avatar) return <img className="avatar person" src={agent.avatar} width={size} height={size} alt={`${name(id)} avatar`} />;
  if (!agent) return <span className="avatar person" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden="true">{name(id).slice(0, 1).toUpperCase()}</span>;
  const h = hash(id);
  const shape = SHAPES[h % SHAPES.length]!;
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={shape.body} fill={HUES[(h >>> 3) % HUES.length]} />
      <path d={shape.facet} fill="#fff" opacity="0.28" />
    </svg>
  );
}

export function Who({ id, empty = 'nobody', size = 24 }: { id: string; empty?: string; size?: number }) {
  const { name } = useCtx();
  if (id === '') return <span className="who none">{empty}</span>;
  if (id === 'system' || id === 'enrollment') return <span className="who none">{id}</span>;
  return <span className="who"><Avatar id={id} size={size} />{name(id)}</span>;
}

export const PRIORITY = ['Low', 'Medium', 'High', 'Urgent'];
const PRIORITY_ICON: IconName[] = ['low', 'medium', 'high', 'high'];
export function Prio({ level }: { level: number }) {
  return <span className={`prio p${level}`}><Icon name={PRIORITY_ICON[level] ?? 'medium'} size={14} />{PRIORITY[level] ?? level}</span>;
}

const STATUS_ICON: Record<string, IconName> = { open: 'circle', in_progress: 'progress', waiting: 'clock', blocked: 'ban', in_review: 'review', changes_requested: 'undo', done: 'check', cancelled: 'x' };
export function StatusPill({ status }: { status: string }) {
  return <span className={`pill s-${status}`}><Icon name={STATUS_ICON[status] ?? 'circle'} size={15} />{STATUS_LABEL[status] ?? status}</span>;
}

/** How long an agent may go without asking the board anything and still be at work: writing code takes minutes. */
const AT_WORK_MS = 15 * 60_000;

/**
 * What an agent is doing now, as the strip above the board says it. Working means a task in progress and the
 * agent heard from lately; a task in progress whose agent has gone quiet says so instead of claiming work.
 */
export function agentState(board: Snapshot, a: Row): { label: string; tone: 'good' | 'warn' | 'bad' | 'off'; title?: string } {
  if (a.status === 'pending') return { label: 'Awaiting approval', tone: 'warn' };
  if (a.status === 'paused') return { label: 'Paused', tone: 'bad' };
  if (a.status === 'revoked') return { label: 'Revoked', tone: 'off' };
  const quiet = a.last_seen ? Date.parse(board.now) - Date.parse(a.last_seen) : Infinity;
  const recent = a.online === 1 || quiet < AT_WORK_MS;
  const seen = a.last_seen ? `Last heard from ${new Date(a.last_seen).toLocaleTimeString()}` : 'Not heard from since the board started';
  const doing = board.tasks.filter((t) => t.assignee === a.id && t.status === 'in_progress').map((t) => t.id as string);
  if (doing.length > 0) return recent
    ? { label: `Working on ${doing.slice(0, 2).join(', ')}${doing.length > 2 ? '…' : ''}`, tone: 'good', title: seen }
    : { label: `Away · ${doing[0]} in progress`, tone: 'off', title: seen };
  if (board.reviews.some((r) => r.reviewer === a.id)) return recent ? { label: 'Reviewing', tone: 'warn', title: seen } : { label: 'Away · review waiting', tone: 'off', title: seen };
  return a.online ? { label: 'Available', tone: 'good', title: seen } : { label: 'Offline', tone: 'off', title: seen };
}

export function AgentStrip() {
  const { board, me, open } = useCtx();
  const agents = board.agents.filter((a) => a.status !== 'revoked');
  if (agents.length === 0) return null;
  return (
    <section className="strip" aria-label="Agents">
      {agents.map((a) => {
        const state = agentState(board, a);
        return (
          <button key={a.id} onClick={() => open('chat', `dm:${[me.id, a.id].sort().join(':')}`)} title={a.about || a.kind}>
            <Avatar id={a.id} size={40} />
            <span className="who-state"><b>{a.name}</b><span className={`state ${state.tone}`} title={state.title}><i />{state.label}</span></span>
          </button>
        );
      })}
    </section>
  );
}

/** A button that opens a short list of actions under it. */
export function Menu({ items, label = 'More' }: { items: { label: string; icon?: IconName; danger?: boolean; run: () => void }[]; label?: string }) {
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shown) return;
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setShown(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [shown]);
  if (items.length === 0) return null;
  return (
    <div className="menu" ref={box}>
      <button className="ghost icon" aria-label={label} aria-expanded={shown} onClick={() => setShown(!shown)}><Icon name="more" /></button>
      {shown && (
        <div className="menu-list" role="menu">
          {items.map((it) => (
            <button key={it.label} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { setShown(false); it.run(); }}>
              {it.icon && <Icon name={it.icon} />}{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** A form whose submit runs `onSubmit` once, with the button disabled meanwhile. */
export function Form({ onSubmit, submit, children, danger }: { onSubmit: () => Promise<unknown>; submit: string; children: ReactNode; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  const go = (e: FormEvent): void => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    void onSubmit().finally(() => setBusy(false));
  };
  return (
    <form onSubmit={go} className="form">
      {children}
      <div className="row end">
        <button className={danger ? 'danger' : 'primary'} disabled={busy}>{submit}</button>
      </div>
    </form>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Something shown once: a token or a key, with what to do with it. */
export function Secret({ title, value, children, onClose }: { title: string; value: string; children?: ReactNode; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="form">
        <p className="warn">This is shown once. Copy it now; the board keeps only its hash.</p>
        <Copy text={value} />
        {children}
        <div className="row end">
          <button className="primary" onClick={onClose}>I have copied it</button>
        </div>
      </div>
    </Modal>
  );
}

export function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <code>{text}</code>
      <button
        className="ghost"
        onClick={() => void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
