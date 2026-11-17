import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BoardError, type Actor, type Board, type ErrorCode } from './board';
import { mcp } from './mcp';

// The one door to the board: the dashboard's API, the agents' API and MCP endpoint, the live feed
// for the dashboard, and the dashboard's files.
//
// Who is asking is decided on every request: an agent by its token, a person by a session cookie.
// The two never mix: /mcp takes only a token. A request that rides on a cookie and is not a GET
// must also come from this origin and carry the token that was given to that session, which a
// page of another site can neither read nor guess. No GET changes anything.

export const VERSION = '0.1.0';
const SESSION_MS = 7 * 86_400_000;
const BODY_MAX = 256 * 1024;
const AVATAR_MAX = 1 * 1024 * 1024;
const AGENT_AVATAR_MAX = 1_500_000;
const STATUS: Record<ErrorCode, number> = { invalid: 400, unauthorized: 401, forbidden: 403, paused: 403, not_found: 404, conflict: 409 };
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', map: 'application/json', ico: 'image/x-icon', png: 'image/png', woff2: 'font/woff2' };

export interface ServerOptions {
  board: Board;
  host: string;
  port: number;
  tls?: { cert: string; key: string };
  /** TLS ends at a proxy in front, which tells the client's address in X-Forwarded-For. */
  behindProxy: boolean;
  /**
   * Unsafe mode, for a board whose every caller is trusted (a developer's own machine, a test, an
   * agent working on rayboard itself): nobody signs in. Whoever reaches the port and sends no
   * agent token is this person and oversees the board, and agents join without a key or approval.
   */
  unsafe?: Actor;
  /** The built dashboard. */
  ui: string;
  log: (line: string) => void;
}

export interface Server {
  url: string;
  port: number;
  /** The code the first person proves with that they have the server's console; null once someone exists. */
  setupCode: string | null;
  stop(): Promise<void>;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const same = (a: string, b: string): boolean => {
  const x = Buffer.from(sha(a));
  const y = Buffer.from(sha(b));
  return timingSafeEqual(x, y);
};

/** So many tries from one address in so long, and no more. */
function limiter(max: number, windowMs: number): (key: string) => boolean {
  const hits = new Map<string, { n: number; until: number }>();
  return (key) => {
    const at = Date.now();
    if (hits.size > 10_000) for (const [k, h] of hits) if (h.until < at) hits.delete(k);
    const h = hits.get(key);
    if (h === undefined || h.until < at) {
      hits.set(key, { n: 1, until: at + windowMs });
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
}

export function startServer(o: ServerOptions): Server {
  const { board } = o;
  const secure = o.tls !== undefined || o.behindProxy;
  const cookieName = secure ? '__Host-rb' : 'rb';
  const sessions = new Map<string, { user: string; until: number; csrf: string }>();
  let setupCode = board.needsSetup() && o.unsafe === undefined ? randomBytes(12).toString('hex').replace(/(.{6})(?=.)/g, '$1-') : null;
  const loginLimit = limiter(10, 10 * 60_000);
  const joinLimit = limiter(20, 60 * 60_000);

  const files = new Map<string, string>();
  for (const name of readdirSync(o.ui)) if (/^[A-Za-z0-9._-]+$/.test(name)) files.set(`/${name}`, join(o.ui, name));

  const baseHeaders: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

  const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
  const refuse = (code: ErrorCode | 'rate_limited' | 'too_large' | 'internal', message: string, status?: number, extra: Record<string, string> = {}): Response =>
    json(status ?? STATUS[code as ErrorCode] ?? 500, { ok: false, error: { code, message } }, extra);
  const failed = (err: unknown): Response => {
    if (err instanceof Error && (err.name === 'BodyTooLargeError' || /body.*large|request.*large/i.test(err.message))) return refuse('too_large', 'the request is too large', 413);
    if (err instanceof BoardError) return refuse(err.code, err.message);
    // What broke is for the operator; the caller learns only that something did.
    o.log(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return refuse('internal', 'the board failed to do this', 500);
  };

  async function body(req: Request): Promise<Record<string, unknown>> {
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new BoardError('invalid', 'send JSON, with Content-Type: application/json');
    const text = await req.text();
    if (text.length > BODY_MAX) throw new BoardError('invalid', 'the request is too large');
    try {
      const parsed = text === '' ? {} : (JSON.parse(text) as unknown);
      if (typeof parsed !== 'object' || parsed === null) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new BoardError('invalid', 'the body is not JSON');
    }
  }
  const text = (v: unknown, max = 200): string => (typeof v === 'string' && v.length <= max ? v : '');

  const sessionOf = (req: Request): { key: string; user: Actor; csrf: string } | null => {
    if (o.unsafe !== undefined) return { key: 'unsafe', user: o.unsafe, csrf: '' };
    const found = (req.headers.get('cookie') ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${cookieName}=`));
    if (found === undefined) return null;
    const key = sha(found.slice(cookieName.length + 1));
    const session = sessions.get(key);
    if (session === undefined || session.until < Date.now()) {
      sessions.delete(key);
      return null;
    }
    const user = board.userById(session.user);
    return user === null ? null : { key, user, csrf: session.csrf };
  };
  /** A new session: the cookie that carries it, and the token the dashboard must send with every change. */
  const startSession = (user: Actor): { cookie: string; csrf: string } => {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    sessions.set(sha(token), { user: user.id, until: Date.now() + SESSION_MS, csrf });
    return { cookie: `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`, csrf };
  };
  const noCookie = `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  /** The session of a request that may change something: from this origin, with the session's own token. */
  const trusted = (req: Request): { key: string; user: Actor } | Response => {
    const session = sessionOf(req);
    if (session === null) return refuse('unauthorized', 'sign in, or send an agent token as Authorization: Bearer', 401, { 'WWW-Authenticate': 'Bearer' });
    if (o.unsafe === undefined && req.method !== 'GET' && (!sameOrigin(req) || !same(req.headers.get('x-csrf-token') ?? '', session.csrf))) return refuse('forbidden', 'this request did not come from the dashboard');
    return session;
  };
  /** Whether a request that rides on a cookie was made by this site's own pages. */
  const sameOrigin = (req: Request): boolean => {
    const origin = req.headers.get('origin');
    if (origin === null) return false;
    try {
      return new URL(origin).host === req.headers.get('host');
    } catch {
      return false;
    }
  };
  const bearer = (req: Request): string | null => /^Bearer (\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? null;

  /** Who is asking, or the answer that sends them away. */
  function who(req: Request): Actor | Response {
    const token = bearer(req);
    if (token !== null) return board.agentOfToken(token) ?? refuse('unauthorized', 'that token is not valid here', 401, { 'WWW-Authenticate': 'Bearer' });
    const session = trusted(req);
    return session instanceof Response ? session : session.user;
  }

  const server = Bun.serve<{ user: string }>({
    hostname: o.host,
    port: o.port,
    ...(o.tls ? { tls: { cert: Bun.file(o.tls.cert), key: Bun.file(o.tls.key) } } : {}),
    maxRequestBodySize: AGENT_AVATAR_MAX,
    // An inbox may wait 50 seconds for something to arrive.
    idleTimeout: 90,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      const forwarded = o.behindProxy ? req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
      const ip = forwarded || srv.requestIP(req)?.address || 'unknown';
      try {
        if (path === '/ws') {
          const session = sessionOf(req);
          if (session === null || (o.unsafe === undefined && !sameOrigin(req))) return refuse('unauthorized', 'sign in first');
          return srv.upgrade(req, { data: { user: session.user.id } }) ? (undefined as unknown as Response) : refuse('invalid', 'not a websocket request');
        }
        if (path === '/mcp') {
          if (req.method !== 'POST') return new Response(null, { status: 405, headers: { ...baseHeaders, Allow: 'POST' } });
          const token = bearer(req);
          const actor = token === null ? null : board.agentOfToken(token);
          if (actor === null) return refuse('unauthorized', 'send your agent token as Authorization: Bearer', 401, { 'WWW-Authenticate': 'Bearer' });
          let message: unknown;
          try {
            message = JSON.parse(await req.text());
          } catch {
            return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
          }
          if (Array.isArray(message)) {
            if (message.length > 20) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'too many messages in one batch' } });
            const answers = (await Promise.all(message.map((m) => mcp(board, actor, m, VERSION)))).filter((a) => a !== null);
            return answers.length === 0 ? new Response(null, { status: 202, headers: baseHeaders }) : json(200, answers);
          }
          const answer = await mcp(board, actor, message, VERSION);
          return answer === null ? new Response(null, { status: 202, headers: baseHeaders }) : json(200, answer);
        }
        if (path.startsWith('/api/')) {
          if (path === '/api/health') return json(200, { ok: true, name: 'rayboard', version: VERSION });
          if (path === '/api/session' && req.method === 'GET') {
            const session = sessionOf(req);
            return json(200, { ok: true, setup: board.needsSetup(), user: session?.user ?? null, csrf: session?.csrf ?? null, unsafe: o.unsafe !== undefined });
          }
          if (o.unsafe !== undefined && req.method === 'POST' && ['/api/setup', '/api/login', '/api/join', '/api/password'].includes(path)) return refuse('conflict', 'this board runs in unsafe mode: nobody signs in, and no password is used');
          if (req.method === 'POST' && (path === '/api/setup' || path === '/api/login' || path === '/api/join')) {
            if (!sameOrigin(req)) return refuse('forbidden', 'this request did not come from the dashboard');
            if (!loginLimit(ip)) return refuse('rate_limited', 'too many tries; wait ten minutes', 429);
            const b = await body(req);
            if (path === '/api/join') {
              const user = await board.acceptInvite(text(b.key), text(b.name), text(b.password, 1000));
              const started = startSession(user);
              return json(200, { ok: true, user, csrf: started.csrf }, { 'Set-Cookie': started.cookie });
            }
            if (path === '/api/setup') {
              if (setupCode === null || !board.needsSetup()) return refuse('conflict', 'this board is already set up');
              if (!same(text(b.code).trim(), setupCode)) return refuse('unauthorized', 'that is not the setup code printed on the server\'s console');
              const user = await board.createUser(text(b.name), text(b.password, 1000));
              setupCode = null;
              const started = startSession(user);
              return json(200, { ok: true, user, csrf: started.csrf }, { 'Set-Cookie': started.cookie });
            }
            const user = await board.login(text(b.name), text(b.password, 1000));
            if (user === null) return refuse('unauthorized', 'wrong name or password');
            const started = startSession(user);
            return json(200, { ok: true, user, csrf: started.csrf }, { 'Set-Cookie': started.cookie });
          }
          if (path === '/api/password' && req.method === 'POST') {
            const session = trusted(req);
            if (session instanceof Response) return session;
            if (!loginLimit(ip)) return refuse('rate_limited', 'too many tries; wait ten minutes', 429);
            const b = await body(req);
            await board.setPassword(session.user.id, text(b.current, 1000), text(b.next, 1000));
            // Every session of this person ends, this one too: whoever had the old password is out.
            for (const [key, s] of sessions) if (s.user === session.user.id) sessions.delete(key);
            return json(200, { ok: true }, { 'Set-Cookie': noCookie });
          }
          if (path === '/api/logout' && req.method === 'POST') {
            const session = sessionOf(req);
            if (session !== null && sameOrigin(req)) sessions.delete(session.key);
            return json(200, { ok: true }, { 'Set-Cookie': noCookie });
          }
          if (path === '/api/register' && req.method === 'POST') {
            if (!joinLimit(ip)) return refuse('rate_limited', 'too many tries; wait an hour', 429);
            const b = await body(req);
            return json(200, { ok: true, result: board.register(text(b.key), { name: text(b.name), kind: text(b.kind) || undefined, about: text(b.about, 500) || undefined }, o.unsafe !== undefined) });
          }
          if (path === '/api/actions' && req.method === 'GET') {
            const actor = who(req);
            if (actor instanceof Response) return actor;
            return json(200, { ok: true, actions: Object.fromEntries(Object.entries(board.actions).filter(([, a]) => a.who === 'any' || a.who === actor.kind).map(([name, a]) => [name, { description: a.description, params: a.params }])) });
          }
          const avatar = /^\/api\/avatars\/([a-z0-9_]{2,40})\/([a-f0-9]{64})$/.exec(path);
          if (avatar && req.method === 'GET') {
            if (sessionOf(req) === null) return refuse('unauthorized', 'sign in first');
            const image = board.avatar(avatar[1]!);
            if (image === null || image.id !== avatar[2]) return refuse('not_found', 'no such avatar');
            return new Response(new Uint8Array(image.bytes), { headers: { ...baseHeaders, 'Content-Type': image.type, 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=31536000, immutable' } });
          }
          if (path === '/api/avatar' && req.method === 'POST') {
            const session = trusted(req);
            if (session instanceof Response) return session;
            const type = req.headers.get('x-avatar-type');
            if (type !== 'png' && type !== 'jpg') return refuse('invalid', 'an avatar is a PNG or JPEG image');
            const length = Number(req.headers.get('content-length'));
            if (!Number.isSafeInteger(length) || length < 1 || length > AVATAR_MAX) return refuse('invalid', 'an avatar may be up to 1 MB');
            const bytes = Buffer.from(await req.arrayBuffer());
            if (bytes.length < 1 || bytes.length > AVATAR_MAX) return refuse('invalid', 'an avatar may be up to 1 MB');
            return json(200, { ok: true, result: board.setAvatar(session.user.id, bytes, type) });
          }
          const call = /^\/api\/call\/([a-z_]{1,40})$/.exec(path);
          if (call !== null && req.method === 'POST') {
            const actor = who(req);
            if (actor instanceof Response) return actor;
            return json(200, { ok: true, result: await board.call(actor, call[1]!, await body(req)) });
          }
          return refuse('not_found', 'no such endpoint');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: baseHeaders });
        const asset = files.get(path);
        const file = asset ?? files.get('/index.html');
        if (file === undefined) return new Response('the dashboard is not built', { status: 503, headers: baseHeaders });
        const ext = file.slice(file.lastIndexOf('.') + 1);
        return new Response(Bun.file(file), {
          headers: { ...baseHeaders, 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Content-Security-Policy': CSP, 'Cache-Control': asset !== undefined && path !== '/index.html' ? 'public, max-age=31536000, immutable' : 'no-cache' },
        });
      } catch (err) {
        return failed(err);
      }
    },
    websocket: {
      open: (ws) => void ws.subscribe('board'),
      // The feed only tells; nothing is asked of it.
      message() {},
      maxPayloadLength: 1024,
    },
  });

  // The feed says that something changed and what; the dashboard asks for what it shows through the API, as itself.
  board.onChange((entry) => {
    server.publish('board', JSON.stringify({ seq: entry.seq, type: entry.type, subject: entry.subject, actor: entry.actor, quiet: entry.quiet === true }));
  });
  const sweep = setInterval(() => {
    const at = Date.now();
    for (const [key, s] of sessions) if (s.until < at) sessions.delete(key);
  }, 60_000);

  return {
    url: `${o.tls ? 'https' : 'http'}://${o.host.includes(':') ? `[${o.host}]` : o.host}:${server.port}`,
    port: server.port!,
    get setupCode() {
      return setupCode;
    },
    async stop() {
      clearInterval(sweep);
      await server.stop(true);
    },
  };
}
