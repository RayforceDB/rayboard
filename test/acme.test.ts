// The board's own certificate (T-453): the ACME exchange against a stand-in that checks what Let's Encrypt checks.
import { expect, test } from 'bun:test';
import { createHash, createPublicKey, generateKeyPairSync, verify, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Acme, CertStore, dueForRenewal } from '../src/acme';

const work = mkdtempSync(join(tmpdir(), 'acme-test-'));
const sh = (cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd: work });
sh('openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.crt -days 2 -subj "/CN=Fake ACME CA"');

/** An ACME server that verifies every signature and nonce, reads the HTTP-01 answer, and signs the request with a test CA. */
function fakeAcme(answers: Map<string, string>, o: { badNonceOnce?: boolean } = {}) {
  const base = 'https://acme.test';
  const nonces = new Set<string>();
  const accounts = new Map<string, Record<string, string>>();
  let n = 0;
  let order: { status: string; cert?: string } = { status: 'pending' };
  let authz = 'pending';
  let badNonce = o.badNonceOnce === true;
  const token = 'tok_' + 'x'.repeat(20);
  const reply = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => {
    const nonce = `n${++n}`;
    nonces.add(nonce);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: init.status ?? 200, headers: { 'Replay-Nonce': nonce, 'Content-Type': 'application/json', ...init.headers } });
  };
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = url.replace(base, '');
    if (path === '/dir') return reply({ newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order` });
    if (path === '/nonce') return reply('');
    const jws = JSON.parse(String(init!.body)) as { protected: string; payload: string; signature: string };
    const head = JSON.parse(Buffer.from(jws.protected, 'base64url').toString()) as { nonce: string; url: string; jwk?: Record<string, string>; kid?: string; alg: string };
    if (badNonce) { badNonce = false; return reply({ type: 'urn:ietf:params:acme:error:badNonce', detail: 'stale' }, { status: 400 }); }
    if (!nonces.delete(head.nonce)) return reply({ type: 'urn:ietf:params:acme:error:badNonce' }, { status: 400 });
    if (head.url !== url || head.alg !== 'ES256') return reply({ type: 'malformed' }, { status: 400 });
    const key = head.jwk ?? accounts.get(head.kid ?? '');
    if (key === undefined) return reply({ type: 'accountDoesNotExist' }, { status: 400 });
    const ok = verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(jws.signature, 'base64url'));
    if (!ok) return reply({ type: 'unauthorized', detail: 'bad signature' }, { status: 403 });
    const payload = jws.payload === '' ? null : JSON.parse(Buffer.from(jws.payload, 'base64url').toString());
    const thumb = Buffer.from(createHash('sha256').update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest()).toString('base64url');
    switch (path) {
      case '/account': accounts.set(`${base}/acct/1`, head.jwk!); return reply({ status: 'valid' }, { status: 201, headers: { Location: `${base}/acct/1` } });
      case '/order': return reply({ status: 'pending', authorizations: [`${base}/authz/1`], finalize: `${base}/finalize` }, { status: 201, headers: { Location: `${base}/order/1` } });
      case '/authz/1': return reply({ status: authz, challenges: [{ type: 'http-01', url: `${base}/chall/1`, token }] });
      case '/chall/1':
        // What the board publishes at /.well-known/acme-challenge/<token> must be token.thumbprint.
        authz = answers.get(token) === `${token}.${thumb}` ? 'valid' : 'invalid';
        return reply({ status: 'processing' });
      case '/finalize': {
        writeFileSync(join(work, 'req.der'), Buffer.from(payload.csr, 'base64url'));
        const r = sh('openssl req -in req.der -inform DER -verify -noout && openssl x509 -req -in req.der -inform DER -CA ca.crt -CAkey ca.key -days 90 -copy_extensions copy -out issued.crt');
        if (r.exitCode !== 0) return reply({ type: 'badCSR', detail: r.stderr.toString() }, { status: 400 });
        order = { status: 'valid', cert: readFileSync(join(work, 'issued.crt'), 'utf8') };
        return reply({ status: 'processing' });
      }
      case '/order/1': return reply({ status: order.status, ...(order.status === 'valid' ? { certificate: `${base}/cert/1` } : {}) });
      case '/cert/1': return new Response(await Bun.file(join(work, 'issued.crt')).text(), { headers: { 'Replay-Nonce': `n${++n}` } });
    }
    return reply({ type: 'notFound' }, { status: 404 });
  };
  return { fetch, directory: `${base}/dir` };
}

test('a certificate is obtained by answering the HTTP-01 challenge, through a signed exchange, and the answer is taken down after', async () => {
  const answers = new Map<string, string>();
  const published: string[] = [];
  const fake = fakeAcme(answers, { badNonceOnce: true });
  const account = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const acme = new Acme(fake.directory, account, fake.fetch, async () => {});
  const issued = await acme.issue('work.example.org', (token, answer) => { published.push(answer === null ? `-${token}` : `+${token}`); if (answer === null) answers.delete(token); else answers.set(token, answer); });
  const x = new X509Certificate(issued.cert);
  expect(x.checkHost('work.example.org')).toBe('work.example.org');
  expect(x.issuer).toContain('Fake ACME CA');
  // The certificate is for the key the board kept.
  expect(x.publicKey.export({ type: 'spki', format: 'der' }).equals(createPublicKey(issued.key).export({ type: 'spki', format: 'der' }))).toBe(true);
  expect(published).toEqual(['+tok_xxxxxxxxxxxxxxxxxxxx', '-tok_xxxxxxxxxxxxxxxxxxxx']);
  expect(answers.size).toBe(0);
});

test('a wrong challenge answer fails the order instead of hanging', async () => {
  const fake = fakeAcme(new Map());
  const acme = new Acme(fake.directory, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, fake.fetch, async () => {});
  await expect(acme.issue('work.example.org', () => {})).rejects.toThrow('invalid');
});

test('the account key and certificate are kept for the board alone, and renewal is due under thirty days', () => {
  const store = new CertStore(join(work, 'tls'));
  const key = store.account();
  expect(store.account().export({ format: 'jwk' })).toEqual(key.export({ format: 'jwk' }));
  expect(statSync(join(work, 'tls', 'account.pem')).mode & 0o777).toBe(0o600);
  expect(statSync(join(work, 'tls')).mode & 0o777).toBe(0o700);
  expect(store.current('work.example.org')).toBeNull();
  sh('openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout k.pem -out c.pem -days 90 -subj "/CN=work.example.org" -addext "subjectAltName=DNS:work.example.org"');
  store.save({ cert: readFileSync(join(work, 'c.pem'), 'utf8'), key: readFileSync(join(work, 'k.pem'), 'utf8'), notAfter: '' });
  const held = store.current('work.example.org')!;
  expect(statSync(join(work, 'tls', 'key.pem')).mode & 0o777).toBe(0o600);
  expect(store.current('other.example.org')).toBeNull();
  const now = Date.now();
  expect(dueForRenewal(held, now)).toBe(false);
  expect(dueForRenewal(held, now + 61 * 86_400_000)).toBe(true);
  expect(dueForRenewal(null, now)).toBe(true);
});

test('the plain-HTTP side answers a challenge it holds and sends everything else to HTTPS', async () => {
  const { challengeListener } = await import('../src/acme');
  const answers = new Map([['tok123', 'tok123.thumb']]);
  const l = challengeListener('127.0.0.1', 0, 'work.example.org', answers);
  try {
    const got = await fetch(`http://127.0.0.1:${l.port}/.well-known/acme-challenge/tok123`);
    expect(await got.text()).toBe('tok123.thumb');
    expect((await fetch(`http://127.0.0.1:${l.port}/.well-known/acme-challenge/other`)).status).toBe(404);
    const away = await fetch(`http://127.0.0.1:${l.port}/#tasks?x=1`, { redirect: 'manual' });
    expect(away.status).toBe(301);
    expect(away.headers.get('location')).toBe('https://work.example.org/');
    const deep = await fetch(`http://127.0.0.1:${l.port}/api/session?x=1`, { redirect: 'manual' });
    expect(deep.headers.get('location')).toBe('https://work.example.org/api/session?x=1');
  } finally {
    l.stop(true);
  }
});

test('a renewed certificate is taken up by the running server without a restart', async () => {
  const { openBoard } = await import('../src/board');
  const { startServer } = await import('../src/server');
  const { sharedRay, tempDir } = await import('./helpers');
  const dir = tempDir();
  const make = (cn: string) => sh(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ${dir}/key.pem -out ${dir}/cert.pem -days 1 -subj "/CN=${cn}"`);
  make('first');
  const board = openBoard({ ray: await sharedRay(), base: join(dir, 'board') });
  let renewed = false;
  const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui: dir, log: () => {}, tls: { cert: `${dir}/cert.pem`, key: `${dir}/key.pem` },
    renew: async () => { make('second'); renewed = true; return true; }, renewFirstMs: 50 });
  // Not spawnSync: the server answering the handshake runs in this same process.
  const subject = async () => (await new Response(Bun.spawn(['sh', '-c', `echo | openssl s_client -connect 127.0.0.1:${server.port} 2>/dev/null | openssl x509 -noout -subject`]).stdout).text()).trim();
  try {
    expect(await subject()).toContain('first');
    for (let i = 0; i < 50 && !renewed; i++) await Bun.sleep(20);
    await Bun.sleep(100);
    expect(await subject()).toContain('second');
    expect((await fetch(`${server.url}/api/session`, { tls: { rejectUnauthorized: false } } as RequestInit)).status).toBe(200);
  } finally {
    await server.stop();
  }
});
