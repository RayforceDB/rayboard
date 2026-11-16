import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureEngine } from '../src/engine';
import { openRay, type Ray } from '../src/ray';

// The library has one runtime for a process, so every test file shares this one. A board binds
// its tables afresh when it opens, which is what makes each test start empty.
let ray: Ray | null = null;
export async function sharedRay(): Promise<Ray> {
  ray ??= openRay({ library: await ensureEngine(join(import.meta.dir, '..', '.rayboard')) });
  return ray;
}
export const tempDir = (): string => mkdtempSync(join(tmpdir(), 'rayboard-test-'));
