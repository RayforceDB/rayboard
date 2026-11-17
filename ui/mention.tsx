import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Avatar, useCtx } from './kit';
import type { Row } from './api';

/** The currently typed @name and where it starts. Email and @@ are not mentions. */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && /[\w@]/.test(before[at - 1]!))) return null;
  const query = before.slice(at + 1);
  return /^[\w-]*$/.test(query) ? { start: at, query } : null;
}

/** A picker fed by the caller's already authorized dashboard, never by private conversations. */
export function MentionInput({ value, onChange, onSend, disabled, placeholder, ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder: string;
  ariaLabel?: string;
}) {
  const { board } = useCtx();
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const active = dismissed ? null : mentionAt(value, caret);
  const candidates = useMemo(() => [
    ...board.agents.filter((a) => a.status === 'active'),
    ...board.people.filter((p) => p.status === 'active'),
  ].filter((a) => !active || (a.name as string).startsWith(active.query.toLowerCase())), [board.agents, board.people, active?.query]);
  const choose = (person: Row): void => {
    if (!active) return;
    const next = value.slice(0, active.start) + '@' + person.name + ' ' + value.slice(caret);
    const position = active.start + person.name.length + 2;
    onChange(next);
    setCaret(position);
    setDismissed(false);
    setPicked(0);
    const restore = (): void => { input.current?.focus(); input.current?.setSelectionRange(position, position); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore); else restore();
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (active && candidates.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPicked((picked + (e.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(candidates[picked % candidates.length]!);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSend(); }
  };
  const optionId = (i: number): string => `mention-option-${i}`;
  return <div className="mention">
    <textarea ref={input} value={value} onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart); setDismissed(false); setPicked(0); }} onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onKeyDown={key} onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)} onClick={(e) => setCaret(e.currentTarget.selectionStart)} rows={2} placeholder={placeholder} aria-label={ariaLabel} disabled={disabled} role="combobox" aria-autocomplete="list" aria-expanded={Boolean(active && candidates.length)} aria-controls="mention-options" aria-activedescendant={active && candidates.length ? optionId(picked % candidates.length) : undefined} />
    {active && candidates.length > 0 && <div className="mention-list" id="mention-options" role="listbox" aria-label="Mention a participant">
      {candidates.map((p, i) => <button type="button" id={optionId(i)} role="option" aria-selected={i === picked % candidates.length} key={p.id} className={i === picked % candidates.length ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(p)}><Avatar id={p.id} size={28} /><span>@{p.name}</span><small>{p.kind === 'user' ? p.role : p.kind}</small></button>)}
    </div>}
  </div>;
}
