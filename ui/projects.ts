import { useEffect, useState } from 'react';
import type { Row } from './api';

/** The project the Board is narrowed to: '' for every project, NONE for tasks without one. Kept per browser, as a convenience. */
export const NONE = '\u0000none';
const KEY = 'rb.project';
const EVENT = 'rb:project';

function read(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}

export function chooseProject(project: string): void {
  try { localStorage.setItem(KEY, project); } catch { /* only a convenience */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The chosen project, followed wherever it is chosen: the sidebar or the Board's own filter. */
export function useProject(): [string, (p: string) => void] {
  const [project, setProject] = useState(read);
  useEffect(() => {
    const sync = (): void => setProject(read());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return [project, chooseProject];
}

/** Every project a task on the board names, with how many of its tasks are still going on, by name. */
export function projectsOf(tasks: Row[]): { name: string; open: number; total: number }[] {
  const by = new Map<string, { name: string; open: number; total: number }>();
  for (const t of tasks) {
    const name = (t.project as string | undefined) ?? '';
    if (name === '') continue;
    const p = by.get(name) ?? { name, open: 0, total: 0 };
    p.total += 1;
    if (t.status !== 'done' && t.status !== 'cancelled') p.open += 1;
    by.set(name, p);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const inProject = (t: Row, project: string): boolean => project === '' || (project === NONE ? !t.project : t.project === project);
