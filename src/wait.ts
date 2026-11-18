// `rayboard wait` (Anton: a Claude Code adapter, without polling through the model). The waiting happens here, on
// the board's own long-poll, at no cost to any model: the command returns as soon as something is in the agent's
// inbox, and an agent session that ran it in the background wakes on its exit. It only peeks: the session reads
// the inbox itself, through MCP, so nothing is marked read by the waiting.

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Waiting {
  /** The board's address, e.g. https://work.example.org. */
  url: string;
  /** The agent's token. */
  token: string;
  /** Give up after this many seconds with nothing (0: wait for ever). */
  timeout?: number;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Told of a failed attempt that will be tried again. */
  note?: (line: string) => void;
}

export interface Item { seq: number; type: string; subject: string; sender?: string; text?: string }

/** Thrown when retrying cannot help: the token is refused, or the address is not a board. */
export class WaitError extends Error {}

/**
 * Waits until the agent's inbox has something, and returns it without marking it read. Network failures and a
 * restarting board are waited out with growing pauses (up to thirty seconds); a refused token is not.
 * Returns an empty list only when `timeout` passes first.
 */
export async function waitForInbox(o: Waiting): Promise<Item[]> {
  const get = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = o.url.replace(/\/+$/, '');
  const until = o.timeout && o.timeout > 0 ? Date.now() + o.timeout * 1000 : Infinity;
  let pause = 1000;
  while (Date.now() < until) {
    const wait = Math.max(1, Math.min(50, Math.floor((until - Date.now()) / 1000)));
    let r: Response;
    try {
      r = await get(`${base}/api/call/inbox`, { method: 'POST', headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ wait, peek: true }) });
    } catch (err) {
      o.note?.(`the board did not answer (${err instanceof Error ? err.message : String(err)}); trying again in ${pause / 1000}s`);
      await sleep(pause);
      pause = Math.min(pause * 2, 30_000);
      continue;
    }
    if (r.status === 401 || r.status === 403) throw new WaitError(`the board refused this token (${r.status}): is it this agent's, and is the agent active?`);
    if (r.status === 404) throw new WaitError(`${base} does not answer like a rayboard (404)`);
    if (!r.ok) {
      o.note?.(`the board answered ${r.status}; trying again in ${pause / 1000}s`);
      await sleep(pause);
      pause = Math.min(pause * 2, 30_000);
      continue;
    }
    pause = 1000;
    const body = (await r.json()) as { result?: { items?: Item[] } };
    const items = body.result?.items ?? [];
    if (items.length > 0) return items;
  }
  return [];
}

/** One short line per item, for the agent that wakes up to read before it opens its inbox. */
export const describe = (items: Item[]): string =>
  items.map((i) => `${i.type} ${i.subject}${i.text ? `: ${i.text.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`).join('\n');
