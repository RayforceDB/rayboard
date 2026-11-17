// GitHub, read as it is: what a webhook delivery says about an issue or pull request, in the board's terms.
// Nothing here writes to GitHub (T-17 contract, stage 1). Comment bodies are never carried over: GitHub is
// where people talk, and the board only says that someone did and where.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Whether a delivery was signed with the webhook secret (X-Hub-Signature-256: sha256=<hex HMAC of the raw body>). */
export function signed(secret: string, body: string, header: string | null): boolean {
  if (secret === '' || header === null || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const want = createHmac('sha256', secret).update(body, 'utf8').digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

export interface Repo {
  /** GitHub's own id: the name of a repository can change, this cannot. */
  id: string;
  name: string;
  private: boolean;
}

export interface Item {
  /** GitHub's node id of the issue or pull request: what the board knows it by. */
  node: string;
  kind: 'issue' | 'pr';
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  /** When GitHub last changed it: an older delivery never undoes a newer one. */
  updated: string;
}

/** Something a person did on GitHub that whoever holds the task should know of, without its text. */
export interface Ping {
  /** The issue or pull request it is on, by number: a pull request's comments arrive on its issue, whose node id is not the pull request's. */
  number: number;
  login: string;
  what: string;
  url: string;
}

export interface Delivery {
  repo: Repo | null;
  item: Item | null;
  ping: Ping | null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function item(o: Record<string, unknown> | undefined, kind: 'issue' | 'pr'): Item | null {
  if (o === undefined || typeof o !== 'object' || o === null) return null;
  const node = text(o.node_id);
  const number = Number(o.number);
  if (node === '' || !Number.isSafeInteger(number)) return null;
  const merged = kind === 'pr' && (o.merged === true || text(o.merged_at) !== '');
  return {
    node,
    kind,
    number,
    url: text(o.html_url),
    title: text(o.title),
    state: o.state === 'open' ? 'open' : merged ? 'merged' : 'closed',
    author: text((o.user as Record<string, unknown> | undefined)?.login),
    updated: text(o.updated_at) || new Date(0).toISOString(),
  };
}

/** What a delivery is about, from its event name and payload; anything it does not know is left null. */
export function read(event: string, payload: Record<string, unknown>): Delivery {
  const r = payload.repository as Record<string, unknown> | undefined;
  const repo: Repo | null = r && r.id !== undefined ? { id: String(r.id), name: text(r.full_name), private: r.private === true } : null;
  const sender = text((payload.sender as Record<string, unknown> | undefined)?.login);
  const issue = payload.issue as Record<string, unknown> | undefined;
  const pull = payload.pull_request as Record<string, unknown> | undefined;
  switch (event) {
    case 'issues':
      // The issues API also describes pull requests; their own events say more, so these are left to them.
      return { repo, item: issue?.pull_request ? null : item(issue, 'issue'), ping: null };
    case 'pull_request':
      return { repo, item: item(pull, 'pr'), ping: null };
    case 'issue_comment': {
      if (payload.action !== 'created') return { repo, item: null, ping: null };
      const kind = issue?.pull_request ? 'pr' : 'issue';
      const comment = payload.comment as Record<string, unknown> | undefined;
      return { repo, item: null, ping: issue ? { number: Number(issue.number), login: sender, what: `commented on ${kind === 'pr' ? 'pull request' : 'issue'} #${issue.number}`, url: text(comment?.html_url) || text(issue.html_url) } : null };
    }
    case 'pull_request_review': {
      if (payload.action !== 'submitted') return { repo, item: null, ping: null };
      const review = payload.review as Record<string, unknown> | undefined;
      const state = text(review?.state).toLowerCase().replace(/_/g, ' ');
      return { repo, item: null, ping: pull ? { number: Number(pull.number), login: sender, what: `reviewed pull request #${pull.number}${state ? ` (${state})` : ''}`, url: text(review?.html_url) || text(pull.html_url) } : null };
    }
    default:
      return { repo, item: null, ping: null };
  }
}
