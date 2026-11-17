import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Avatar, useCtx } from './kit';
import type { Row } from './api';

/** The currently typed @name and where it starts. Email and @@ are not mentions. */
export type CompletionKind = 'mention' | 'channel';
export function completionAt(value: string, caret: number): { start: number; query: string; kind: CompletionKind } | null {
  const before = value.slice(0, caret);
  const at = Math.max(before.lastIndexOf('@'), before.lastIndexOf('#'));
  if (at < 0 || (at > 0 && /[\w@#]/.test(before[at - 1]!))) return null;
  // A # right after / or & belongs to a link's fragment or an entity, not to a channel.
  if (before[at] === '#' && at > 0 && /[/&]/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  return /^[\w-]*$/.test(query) ? { start: at, query, kind: before[at] === '#' ? 'channel' : 'mention' } : null;
}

export const mentionAt = (value: string, caret: number): { start: number; query: string } | null => { const found = completionAt(value, caret); return found?.kind === 'mention' ? { start: found.start, query: found.query } : null; };

/** A picker fed by the caller's already authorized dashboard, never by private conversations. */
export function MentionInput({ value, onChange, onSend, disabled, placeholder, ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder: string;
  ariaLabel?: string;
}) {
  const { board, me } = useCtx();
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Controlled/programmatic edits do not necessarily fire select or keyup.
  useEffect(() => { setCaret(input.current?.selectionStart ?? value.length); }, [value]);
  const active = dismissed ? null : completionAt(value, caret);
  const candidates = useMemo<Row[]>(() => {
    if (active?.kind === 'channel') return board.channels.filter((c) => c.name.toLowerCase().startsWith(active.query.toLowerCase()));
    const people = [...board.agents.filter((a) => a.status === 'active'), ...board.people.filter((p) => p.status === 'active' && p.id !== me.id)];
    return [{ id: '@all', name: 'all', kind: 'all' }, ...people].filter((a) => !active || a.name.startsWith(active.query.toLowerCase()));
  }, [board.agents, board.people, board.channels, active?.query, active?.kind]);
  const choose = (person: Row): void => {
    if (!active) return;
    const marker = active.kind === 'channel' ? '#' : '@';
    const next = value.slice(0, active.start) + marker + person.name + ' ' + value.slice(caret);
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
      // Ctrl/Cmd+Enter always sends, even with the list open; plain Enter or Tab picks.
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        e.preventDefault();
        choose(candidates[picked % candidates.length]!);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSend(); }
  };
  const optionId = (i: number): string => `mention-option-${i}`;
  const label = active?.kind === 'channel' ? 'Choose a channel' : 'Mention a participant';
  return <div className="mention">
    <textarea ref={input} value={value} onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart); setDismissed(false); setPicked(0); }} onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onKeyDown={key} onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)} onClick={(e) => setCaret(e.currentTarget.selectionStart)} rows={2} placeholder={placeholder} aria-label={ariaLabel} disabled={disabled} role="combobox" aria-autocomplete="list" aria-expanded={Boolean(active && candidates.length)} aria-controls="mention-options" aria-activedescendant={active && candidates.length ? optionId(picked % candidates.length) : undefined} />
    {active && candidates.length > 0 && <div className="mention-list" id="mention-options" role="listbox" aria-label={label}>
      {candidates.map((p, i) => <button type="button" id={optionId(i)} role="option" aria-selected={i === picked % candidates.length} key={p.id} className={i === picked % candidates.length ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(p)}>
          {active.kind === 'channel' ? <span className="channel-mark" aria-hidden="true">#</span> : p.id === '@all' ? <span className="all-mark" aria-hidden="true">@</span> : <Avatar id={p.id} size={28} />}
          <span>{active.kind === 'channel' ? '#' : '@'}{p.name}</span><small>{active.kind === 'channel' ? 'channel' : p.id === '@all' ? 'all participants here' : p.kind === 'user' ? p.role : p.kind}</small>
        </button>)}
    </div>}
  </div>;
}
