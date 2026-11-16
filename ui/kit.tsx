import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Row, Snapshot } from './api';
import markOnDark from './assets/mark-on-dark.svg';
import markOnLight from './assets/mark-on-light.svg';
import rayforceOnDark from './assets/rayforce-on-dark.svg';
import rayforceOnLight from './assets/rayforce-on-light.svg';

/** The RayforceDB mark with rayboard's name set the way RayforceDB sets its own. */
export function Brand() {
  return (
    <h1 className="brand">
      <img className="on-dark" src={markOnDark} alt="" />
      <img className="on-light" src={markOnLight} alt="" />
      <span>RAY<b>BOARD</b></span>
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
}
export const BoardContext = createContext<Ctx | null>(null);
export const useCtx = (): Ctx => useContext(BoardContext)!;

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open', in_progress: 'In progress', waiting: 'Waiting', blocked: 'Blocked', in_review: 'In review', changes_requested: 'Changes requested', done: 'Done', cancelled: 'Cancelled',
  pending: 'Waiting for approval', active: 'Active', paused: 'Paused', revoked: 'Revoked', approved: 'Approved', withdrawn: 'Withdrawn',
};

export function Badge({ status }: { status: string }) {
  return <span className={`badge s-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Who({ id, empty = 'nobody' }: { id: string; empty?: string }) {
  const { name, board } = useCtx();
  if (id === '') return <span className="who none">{empty}</span>;
  if (id === 'system' || id === 'enrollment') return <span className="who none">{id}</span>;
  const agent = board.agents.find((a) => a.id === id);
  return (
    <span className={`who ${agent ? 'is-agent' : 'is-person'}`}>
      {agent && <i className={`dot ${agent.online ? 'on' : ''}`} title={agent.online ? 'online' : 'offline'} />}
      {name(id)}
    </span>
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
          <button className="ghost icon" onClick={onClose} aria-label="Close">×</button>
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
