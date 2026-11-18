import type { Row } from './api';
import { useCtx } from './kit';

/** Warm and calm hues that sit with the board's orange; a project keeps its own however the list changes. */
const HUES = [18, 32, 145, 168, 200, 222, 262, 292, 330, 352];

function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** What a project is called in two letters at most: the first of each part, so rayforce-q is RQ. */
export function initials(name: string): string {
  const parts = name.split(/[-_.]+/).filter((p) => p !== '');
  const letters = parts.length > 1 ? parts.slice(0, 2).map((p) => p[0]) : [name[0] ?? '?'];
  return letters.join('').toUpperCase();
}

/** A project's mark: its initials on a tile of its own colour. */
export function ProjectMark({ name, size = 18 }: { name: string; size?: number }) {
  const hue = HUES[hash(name) % HUES.length]!;
  const text = initials(name);
  return (
    <span className="project-mark" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * (text.length > 1 ? 0.46 : 0.58)), background: `hsl(${hue} 62% 92%)`, color: `hsl(${hue} 55% 34%)`, borderColor: `hsl(${hue} 45% 80%)` }}>
      {text}
    </span>
  );
}

export function GithubMark({ size = 13 }: { size?: number }) {
  return (
    <svg className="gh-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** The GitHub item a task is worked as, if any. */
export function useGithubItem(id: string): Row | undefined {
  const { board } = useCtx();
  return (board.github ?? []).find((x) => x.task === id);
}

/**
 * A task's number as people know it: rayforce#1211 for what came from GitHub, the board's T-number otherwise.
 * The board's number stays in the tooltip, since that is what agents and links use.
 */
export function TaskNumber({ t }: { t: Row }) {
  const g = useGithubItem(t.id as string);
  if (!g) return <code className="task-no">{t.id}</code>;
  const short = String(g.repo).split('/').pop();
  return <code className="task-no gh" title={`${t.id} on the board · ${g.kind === 'pr' ? 'pull request' : 'issue'} on GitHub`}><GithubMark />{short}#{g.number}</code>;
}

/** A task's title without the repo#number its GitHub copy begins with, when that is already shown as its number. */
export function useShownTitle(t: Row): string {
  const g = useGithubItem(t.id as string);
  if (!g) return t.title as string;
  const prefix = `${String(g.repo).split('/').pop()}#${g.number} `;
  const title = t.title as string;
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}
