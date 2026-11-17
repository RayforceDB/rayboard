import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

/** A local presentation preference, bounded so a broken/old value cannot hide the application. */
export function panelWidth(name: string, initial: number, min: number, max: number): number {
  let value: unknown = initial;
  try { value = JSON.parse(localStorage.getItem(`rayboard.panel.${name}.v1`) ?? 'null'); } catch { /* use default */ }
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : initial;
}

/** An edge separator which supports pointer dragging and keyboard arrows. Never steals pointer input. */
export function ResizeHandle({ name, value, setValue, min, max, reverse = false }: {
  name: string; value: number; setValue: (value: number) => void;
  min: number; max: number; reverse?: boolean;
}) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const resize = (next: number): void => {
    const bounded = Math.max(min, Math.min(max, Math.round(next)));
    setValue(bounded);
    try { localStorage.setItem(`rayboard.panel.${name}.v1`, JSON.stringify(bounded)); } catch { /* private browsing remains usable */ }
  };
  const down = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { id: e.pointerId, x: e.clientX, width: value };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id !== e.pointerId) return;
    resize(drag.current.width + (e.clientX - drag.current.x) * (reverse ? -1 : 1));
  };
  const up = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Home') return resize(min);
    if (e.key === 'End') return resize(max);
    const direction = (e.key === 'ArrowRight' ? 1 : -1) * (reverse ? -1 : 1);
    resize(value + direction * (e.shiftKey ? 40 : 12));
  };
  return <div className="resize-handle" role="separator" aria-label={`Resize ${name}`} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} tabIndex={0} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} />;
}
