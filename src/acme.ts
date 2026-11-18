// The board's own HTTPS certificate (T-453): ACME (RFC 8555), as Let's Encrypt speaks it, with the HTTP-01
// challenge. Nothing outside this file and node:crypto is used; the account key and the certificate live in the
// data directory, readable by the board alone.

import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const b64u = (data: string | Buffer | Uint8Array): string => Buffer.from(data).toString('base64url');

// ---- DER, as much as a certificate request needs ----

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const parts: number[] = [];
    let v = n;
    do { parts.unshift(v & 0x7f); v >>= 7; } while (v > 0);
    for (let i = 0; i < parts.length - 1; i++) parts[i]! |= 0x80;
    out.push(...parts);
  }
  return tlv(0x06, Buffer.from(out));
}

/** A PKCS#10 certificate request for one DNS name, signed by the certificate's own key, in DER. */
export function csr(domain: string, key: KeyObject): Buffer {
  if (!/^[a-z0-9.-]{1,253}$/i.test(domain)) throw new Error('not a domain name');
  const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(domain)))));
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer;
  const san = seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x82, Buffer.from(domain)))));
  const attributes = tlv(0xa0, seq(oid('1.2.840.113549.1.9.14'), set(seq(san))));
  const info = seq(tlv(0x02, Buffer.from([0])), name, spki, attributes);
  const signature = sign('sha256', info, key);
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}
// ---- the account, and signed requests ----

/** The public half of an account key as a JWK, its members in the order RFC 7638 hashes them. */
function jwk(key: KeyObject): Record<string, string> {
  const j = key.export({ format: 'jwk' }) as Record<string, string>;
  return { crv: j.crv!, kty: j.kty!, x: j.x!, y: j.y! };
}
/** The account key's thumbprint, which a challenge's answer is made of. */
export const thumbprint = (key: KeyObject): string => b64u(createHash('sha256').update(JSON.stringify(jwk(key))).digest());

export interface Issued { cert: string; key: string; notAfter: string }

/**
 * Asks an ACME server for a certificate for `domain`, answering its HTTP-01 challenge through `publish`, which must
 * make `http://<domain>/.well-known/acme-challenge/<token>` answer the given text for as long as it is asked to.
 */
export class Acme {
  private nonce = '';
  private kid = '';
  private dirs: Record<string, string> | null = null;
  constructor(
    private readonly directory: string,
    private readonly account: KeyObject,
    private readonly get: Fetch = fetch,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async dir(): Promise<Record<string, string>> {
    this.dirs ??= (await (await this.get(this.directory)).json()) as Record<string, string>;
    return this.dirs;
  }
  private async fresh(): Promise<string> {
    if (this.nonce !== '') { const n = this.nonce; this.nonce = ''; return n; }
    const r = await this.get((await this.dir()).newNonce!, { method: 'HEAD' });
    return r.headers.get('replay-nonce') ?? '';
  }
  /** A JWS-signed POST; `payload` null is POST-as-GET. A bad nonce is answered once more with a new one. */
  private async post(url: string, payload: unknown, accept = 'application/json', retry = true): Promise<Response> {
    const head: Record<string, unknown> = { alg: 'ES256', nonce: await this.fresh(), url, ...(this.kid ? { kid: this.kid } : { jwk: jwk(this.account) }) };
    const protectedPart = b64u(JSON.stringify(head));
    const payloadPart = payload === null ? '' : b64u(JSON.stringify(payload));
    const signature = b64u(sign('sha256', Buffer.from(`${protectedPart}.${payloadPart}`), { key: this.account, dsaEncoding: 'ieee-p1363' }));
    const r = await this.get(url, { method: 'POST', headers: { 'Content-Type': 'application/jose+json', Accept: accept }, body: JSON.stringify({ protected: protectedPart, payload: payloadPart, signature }) });
    this.nonce = r.headers.get('replay-nonce') ?? '';
    if (!r.ok) {
      const problem = (await r.clone().json().catch(() => ({}))) as { type?: string; detail?: string };
      if (retry && problem.type === 'urn:ietf:params:acme:error:badNonce') return this.post(url, payload, accept, false);
      throw new Error(`ACME ${url.replace(/^https?:\/\/[^/]+/, '')}: ${r.status} ${problem.detail ?? problem.type ?? ''}`.trim());
    }
    return r;
  }
  private async until(url: string, done: (o: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 30; i++) {
      const o = (await (await this.post(url, null)).json()) as Record<string, unknown>;
      if (o.status === 'invalid') throw new Error(`ACME: ${what} is invalid: ${JSON.stringify((o.error as Record<string, unknown> | undefined) ?? (o.challenges as unknown[] | undefined)?.find((c) => (c as Record<string, unknown>).error) ?? o).slice(0, 300)}`);
      if (done(o)) return o;
      await this.wait(2000);
    }
    throw new Error(`ACME: ${what} did not finish in time`);
  }

  async issue(domain: string, publish: (token: string, answer: string | null) => void): Promise<Issued> {
    const d = await this.dir();
    const account = await this.post(d.newAccount!, { termsOfServiceAgreed: true });
    this.kid = account.headers.get('location') ?? '';
    if (this.kid === '') throw new Error('ACME: the account has no URL');
    const placed = await this.post(d.newOrder!, { identifiers: [{ type: 'dns', value: domain }] });
    const orderUrl = placed.headers.get('location') ?? '';
    const order = (await placed.json()) as { authorizations: string[]; finalize: string };
    for (const authUrl of order.authorizations) {
      const auth = (await (await this.post(authUrl, null)).json()) as { status: string; challenges: { type: string; url: string; token: string }[] };
      if (auth.status === 'valid') continue;
      const challenge = auth.challenges.find((c) => c.type === 'http-01');
      if (challenge === undefined || !/^[\w-]+$/.test(challenge.token)) throw new Error('ACME: no HTTP-01 challenge offered');
      publish(challenge.token, `${challenge.token}.${thumbprint(this.account)}`);
      try {
        await this.post(challenge.url, {});
        await this.until(authUrl, (o) => o.status === 'valid', `the authorization for ${domain}`);
      } finally {
        publish(challenge.token, null);
      }
    }
    const certKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await this.post(order.finalize, { csr: b64u(csr(domain, certKey)) });
    const done = await this.until(orderUrl, (o) => o.status === 'valid', 'the order');
    const cert = await (await this.post(String(done.certificate), null, 'application/pem-certificate-chain')).text();
    return { cert, key: certKey.export({ type: 'pkcs8', format: 'pem' }) as string, notAfter: new Date(new X509Certificate(cert).validTo).toISOString() };
  }
}

// ---- what is kept on disk ----

/** Where the board keeps its account key and certificate: `<data>/tls`, readable by the board alone. */
export class CertStore {
  constructor(private readonly dir: string) {}
  private path(name: string): string { return join(this.dir, name); }
  /** The account key, made the first time it is asked for. */
  account(): KeyObject {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    if (!existsSync(this.path('account.pem'))) {
      const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
      writeFileSync(this.path('account.pem'), key.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600 });
    }
    return createPrivateKey(readFileSync(this.path('account.pem'), 'utf8'));
  }
  /** The certificate held for `domain`, if any, with when it expires. */
  current(domain: string): Issued | null {
    if (!existsSync(this.path('cert.pem')) || !existsSync(this.path('key.pem'))) return null;
    const cert = readFileSync(this.path('cert.pem'), 'utf8');
    const x = new X509Certificate(cert);
    if (!x.checkHost(domain)) return null;
    return { cert, key: readFileSync(this.path('key.pem'), 'utf8'), notAfter: new Date(x.validTo).toISOString() };
  }
  /** Keeps a new certificate; each file is replaced whole, so a crash leaves the old pair or the new. */
  save(issued: Issued): void {
    for (const [name, text] of [['key.pem', issued.key], ['cert.pem', issued.cert]] as const) {
      writeFileSync(this.path(`${name}.new`), text, { mode: 0o600 });
      renameSync(this.path(`${name}.new`), this.path(name));
    }
  }
}

/** Whether a certificate should be renewed now: with less than thirty days left, as Let's Encrypt advises. */
export const dueForRenewal = (issued: Issued | null, now: number): boolean => issued === null || Date.parse(issued.notAfter) - now < 30 * 86_400_000;

/**
 * The plain-HTTP side of a board that holds its own certificate: it answers ACME's HTTP-01 challenges from
 * `answers`, and sends everything else to the same path over HTTPS. Nothing of the board is served in the clear.
 */
export function challengeListener(host: string, port: number, domain: string, answers: Map<string, string>, httpsPort = 443) {
  const target = `https://${domain}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
  return Bun.serve({
    hostname: host,
    port,
    fetch(req) {
      const url = new URL(req.url);
      const token = /^\/\.well-known\/acme-challenge\/([\w-]{1,128})$/.exec(url.pathname)?.[1];
      if (token !== undefined) {
        const answer = answers.get(token);
        return answer === undefined ? new Response('not found', { status: 404 }) : new Response(answer, { headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response(null, { status: 301, headers: { Location: `${target}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' } });
    },
  });
}
