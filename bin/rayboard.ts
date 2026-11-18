#!/usr/bin/env bun
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Acme, CertStore, challengeListener, dueForRenewal, LETS_ENCRYPT, LETS_ENCRYPT_STAGING } from '../src/acme';
import { openBoard } from '../src/board';
import { ensureEngine } from '../src/engine';
import { openRay, RayError, type Ray } from '../src/ray';
import type { Board } from '../src/board';
import { startServer, VERSION } from '../src/server';

const HELP = `rayboard ${VERSION}: a shared board for AI agents and the people overseeing them

  rayboard serve     start the board
  rayboard passwd <name>   give a person a new password when theirs is lost (stop the server first)
  rayboard cert      make a self-signed certificate for trying it over a network
  rayboard engine    download and verify the pinned RayforceDB build

options for serve (or the environment variable):
  --domain <name>    the board's own name: it gets and renews its own Let's Encrypt certificate,
                     serves HTTPS on 443 and redirects HTTP on 80; nothing is needed in front   RAYBOARD_DOMAIN
  --http-port <n>    where Let's Encrypt is answered and HTTP redirected, with --domain   RAYBOARD_HTTP_PORT   80
  --acme-staging     ask Let's Encrypt's staging service, for trying --domain out
  --host <addr>      address to listen on        RAYBOARD_HOST   127.0.0.1 (0.0.0.0 with --domain)
  --port <n>         port                        RAYBOARD_PORT   4700
  --data <dir>       where the board is kept     RAYBOARD_DATA   ./.rayboard
  --tls-cert <file>  certificate chain (PEM)     RAYBOARD_TLS_CERT
  --tls-key <file>   its private key (PEM)       RAYBOARD_TLS_KEY
  --behind-proxy     TLS ends at a reverse proxy in front of this server   RAYBOARD_BEHIND_PROXY=1
  --unsafe           nobody signs in: whoever reaches the port oversees the board, and agents
                     join without a key or approval. Only where every caller is trusted: your
                     own machine, a test, an agent working on rayboard.        RAYBOARD_UNSAFE=1

Listening on anything but this machine needs TLS: --domain, a certificate here, or a proxy in front.
Ports 80 and 443 need the right to bind them: run as a service with CAP_NET_BIND_SERVICE, or setcap it on bun.`;

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const flag = (name: string, env: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : process.env[env];
};
const data = resolve(flag('data', 'RAYBOARD_DATA') ?? '.rayboard');
const log = (line: string): void => console.log(line);
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** The board kept in the data directory. It has one writer: a second process is told so, in a sentence. */
function board_(ray: Ray): Board {
  try {
    return openBoard({ ray, base: join(data, 'board'), legacy: join(data, 'journal.jsonl') });
  } catch (err) {
    if (!(err instanceof RayError) || err.code !== 'journal') throw err;
    console.error(`The board in ${data} is open in another process (a running server?), or its log is damaged.\nStop the server first; if none is running, check ${join(data, 'board.log')} with RayforceDB's (.log.validate).`);
    process.exit(2);
  }
}

async function buildUi(out: string): Promise<void> {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, '..', 'ui', 'index.html')], outdir: out, minify: true, target: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, naming: { chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]', entry: '[name].[ext]' } });
  if (!built.success) throw new Error(`the dashboard did not build:\n${built.logs.join('\n')}`);
}

if (command === 'serve') {
  // A board on its own name holds its own certificate (T-453): it listens on every address, HTTPS on 443, and
  // answers Let's Encrypt and redirects on 80. Nothing else is needed in front of it.
  const domain = flag('domain', 'RAYBOARD_DOMAIN');
  if (domain !== undefined && !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) throw new Error(`not a domain name: ${domain}`);
  const host = flag('host', 'RAYBOARD_HOST') ?? (domain ? '0.0.0.0' : '127.0.0.1');
  const port = Number(flag('port', 'RAYBOARD_PORT') ?? (domain ? 443 : 4700));
  const httpPort = Number(flag('http-port', 'RAYBOARD_HTTP_PORT') ?? 80);
  const tlsDir = join(data, 'tls');
  let cert = flag('tls-cert', 'RAYBOARD_TLS_CERT');
  let key = flag('tls-key', 'RAYBOARD_TLS_KEY');
  if (domain !== undefined && (cert !== undefined || key !== undefined)) throw new Error('--domain gets its own certificate; leave out --tls-cert and --tls-key');
  if (domain !== undefined) { cert = join(tlsDir, 'cert.pem'); key = join(tlsDir, 'key.pem'); }
  const behindProxy = args.includes('--behind-proxy') || process.env.RAYBOARD_BEHIND_PROXY === '1';
  if (domain !== undefined && behindProxy) throw new Error('--domain is for a board with nothing in front of it; leave out --behind-proxy');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`not a port: ${port}`);
  if ((cert === undefined) !== (key === undefined)) throw new Error('--tls-cert and --tls-key go together');
  const unsafe = args.includes('--unsafe') || process.env.RAYBOARD_UNSAFE === '1';
  if (!LOOPBACK.has(host) && cert === undefined && !behindProxy && !unsafe) {
    console.error(`rayboard will not listen on ${host} without TLS: tokens and passwords would cross the network in the clear.\nGive --tls-cert and --tls-key (rayboard cert makes a pair for trying it), or --behind-proxy when a reverse proxy in front ends TLS.`);
    process.exit(2);
  }
  mkdirSync(data, { recursive: true, mode: 0o700 });
  chmodSync(data, 0o700);
  const ray = openRay({ library: await ensureEngine(data, log) });
  const board = board_(ray);
  const ui = join(data, 'ui');
  await buildUi(ui);
  // In unsafe mode whoever sends no agent token is the first person of the board; a board with nobody gets one whose password nobody knows.
  const operator = unsafe ? (board.firstUser() ?? (await board.createUser('operator', randomBytes(24).toString('base64url')))) : undefined;
  // Its own certificate: the challenge listener first, then a certificate if none is held, then HTTPS.
  let renew: (() => Promise<boolean>) | undefined;
  let challenges: ReturnType<typeof challengeListener> | undefined;
  if (domain !== undefined) {
    const store = new CertStore(tlsDir);
    const answers = new Map<string, string>();
    challenges = challengeListener(host, httpPort, domain, answers, port);
    const directory = flag('acme-directory', 'RAYBOARD_ACME_DIRECTORY') ?? (args.includes('--acme-staging') ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT);
    const acme = new Acme(directory, store.account());
    const obtain = async (): Promise<void> => {
      log(`tls: asking ${new URL(directory).host} for a certificate for ${domain}`);
      const issued = await acme.issue(domain, (token, answer) => { if (answer === null) answers.delete(token); else answers.set(token, answer); });
      store.save(issued);
      log(`tls: certificate for ${domain} until ${issued.notAfter}`);
    };
    if (dueForRenewal(store.current(domain), Date.now())) await obtain();
    renew = async () => {
      if (!dueForRenewal(store.current(domain), Date.now())) return false;
      await obtain();
      return true;
    };
  }
  const server = startServer({ board, host, port, behindProxy, ui, log, ...(cert && key ? { tls: { cert, key } } : {}), ...(operator ? { unsafe: operator } : {}), ...(renew ? { renew } : {}) });
  log(`rayboard ${VERSION} on ${server.url}  (RayforceDB ${ray.commit}, data in ${data})`);
  log(`agents connect to ${server.url}/mcp with their token`);
  if (operator !== undefined) {
    log(`\nUNSAFE MODE. Nobody signs in: every request without an agent token acts as ${operator.name} and oversees the board; agents join at /api/register without a key.`);
    if (!LOOPBACK.has(host)) log(`It listens on ${host}${cert === undefined && !behindProxy ? ' without TLS' : ''}: anyone who can reach this machine has the whole board.`);
  }
  if (server.setupCode !== null) log(`\nNobody oversees this board yet. Open ${server.url} and enter this setup code:\n\n    ${server.setupCode}\n`);
  const stop = async (): Promise<void> => {
    await server.stop();
    await challenges?.stop(true);
    board.close();
    ray.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
} else if (command === 'passwd') {
  // Whoever can run this can read the journal anyway: having the server's disk is what proves the right to do it.
  const ray = openRay({ library: await ensureEngine(data, log) });
  const board = board_(ray);
  const name = args[1] !== undefined && !args[1].startsWith('--') ? args[1] : undefined;
  if (name === undefined) {
    log(board.people().length === 0 ? 'Nobody oversees this board yet: start it and use the setup code.' : `Whose password? rayboard passwd <name>\nPeople here: ${board.people().join(', ')}`);
  } else {
    const password = await board.resetPassword(name);
    log(`New password for ${name.toLowerCase()}:\n\n    ${password}\n\nSign in with it and change it (click your name in the sidebar). The reset is in the audit log.`);
  }
  board.close();
  ray.close();
} else if (command === 'engine') {
  log(await ensureEngine(data, log));
} else if (command === 'cert') {
  const name = flag('host', 'RAYBOARD_HOST') ?? 'localhost';
  if (!/^[A-Za-z0-9.:-]+$/.test(name)) throw new Error(`not a host name or address: ${name}`);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const certFile = join(data, 'cert.pem');
  const keyFile = join(data, 'key.pem');
  if (existsSync(keyFile)) throw new Error(`${keyFile} exists; remove it first to make a new pair`);
  const san = /^[0-9.]+$|:/.test(name) ? `IP:${name}` : `DNS:${name}`;
  const made = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '365', '-subj', `/CN=${name}`, '-addext', `subjectAltName=${san},DNS:localhost,IP:127.0.0.1`, '-keyout', keyFile, '-out', certFile]);
  if (made.exitCode !== 0) throw new Error(`openssl failed: ${made.stderr.toString()}`);
  chmodSync(keyFile, 0o600);
  log(`a self-signed certificate for ${name}, good for a year:\n  rayboard serve --host ${name === 'localhost' ? '0.0.0.0' : name} --tls-cert ${certFile} --tls-key ${keyFile}\nBrowsers and agents will not trust it until you tell them to; for real use, put a certificate from a CA here or a proxy in front.`);
} else {
  log(HELP);
}
