import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The RayforceDB build rayboard runs on is pinned in engine.json by the SHA-256 of its release
// archive. Nothing is loaded into the process that does not hash to the pin.

interface Pin {
  url: string;
  sha256: string;
  dir?: string;
}

const PINS = join(import.meta.dir, '..', 'engine.json');

function pin(): Pin {
  const key = `${process.platform}-${process.arch}`;
  const pins = JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, Pin>;
  const found = pins[key];
  if (found === undefined) throw new Error(`engine.json pins no RayforceDB build for ${key}; set RAYBOARD_LIB to a librayforce you built`);
  if (!/^https:\/\//.test(found.url) || !/^[0-9a-f]{64}$/.test(found.sha256)) throw new Error('engine.json: a pin needs an https url and a sha256');
  if (found.dir !== undefined && !/^[A-Za-z0-9._-]+$/.test(found.dir)) throw new Error('engine.json: dir must be one plain directory name');
  return found;
}

/** Where the pinned library lies once installed, whether or not it is there yet. */
export function libraryPath(home: string): string {
  if (process.env.RAYBOARD_LIB) return process.env.RAYBOARD_LIB;
  const p = pin();
  return join(home, 'engine', p.sha256, p.dir ?? '', 'librayforce.so');
}

/** Downloads the pinned archive when it is not installed, verifies its hash and unpacks it. Returns the library's path. */
export async function ensureEngine(home: string, log: (line: string) => void = () => {}): Promise<string> {
  const lib = libraryPath(home);
  if (existsSync(lib)) return lib;
  if (process.env.RAYBOARD_LIB) throw new Error(`RAYBOARD_LIB points at ${lib}, which does not exist`);
  const p = pin();
  const root = join(home, 'engine');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  log(`downloading RayforceDB from ${p.url}`);
  const res = await fetch(p.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`could not download the engine: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== p.sha256) throw new Error(`the engine archive hashes to ${got}, engine.json pins ${p.sha256}; nothing was installed`);
  const archive = join(root, `${p.sha256}.tar.gz`);
  writeFileSync(archive, bytes);
  // Unpacked beside its place and renamed into it, so a tree that exists is a whole one.
  const tmp = join(root, `${p.sha256}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const tar = Bun.spawnSync(['tar', '-xzf', archive, '-C', tmp, '--no-same-owner']);
  if (tar.exitCode !== 0) throw new Error(`could not unpack the engine: ${tar.stderr.toString()}`);
  rmSync(join(root, p.sha256), { recursive: true, force: true });
  renameSync(tmp, join(root, p.sha256));
  rmSync(archive);
  if (!existsSync(lib)) throw new Error(`the engine archive holds no ${p.dir ?? '.'}/librayforce.so`);
  log(`RayforceDB installed at ${lib}`);
  return lib;
}
