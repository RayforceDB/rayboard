/** Typing (T-476) in real Chromium against a real board on loopback: three people, no production accounts.
 * Run: bun test/browser-typing.ts (install Chromium once with bunx playwright install chromium; CHROME_PATH picks another).
 */
import { chromium } from 'playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBoard } from '../src/board';
import { ensureEngine } from '../src/engine';
import { openRay } from '../src/ray';
import { startServer } from '../src/server';

const dir = await mkdtemp(join(tmpdir(), 'rayboard-typing-'));
const ui = join(dir, 'ui');
const built = await Bun.build({ entrypoints: [join(import.meta.dir, '..', 'ui', 'index.html')], outdir: ui, target: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, naming: { chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]', entry: '[name].[ext]' } });
if (!built.success) throw new Error(built.logs.join('\n'));
const ray = openRay({ library: await ensureEngine(join(import.meta.dir, '..', '.rayboard')) });
const board = openBoard({ ray, base: join(dir, 'board') });
const anton = await board.createUser('anton', 'browser typing one');
const serhii = await board.createUser('serhii', 'browser typing two', 'member');
await board.createUser('vic', 'browser typing three', 'member');
const general = (await board.call(anton, 'create_channel', { name: 'general' })) as { id: string };
await board.call(serhii, 'post_message', { to: '@anton', body: 'hello' });
const dm = `dm:${[anton.id, serhii.id].sort().join(':')}`;
const server = startServer({ board, host: '127.0.0.1', port: 0, behindProxy: false, ui, log: () => {} });
const U = server.url;

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const failures: string[] = [];
const check = (what: string, ok: boolean): void => { if (!ok) failures.push(what); };
try {
  const page = async (name: string, password: string, hash: string) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.request.post(`${U}/api/login`, { headers: { Origin: U, 'Content-Type': 'application/json' }, data: { name, password } });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    const frames: string[] = [];
    p.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))));
    await p.goto(`${U}/#chat/${encodeURIComponent(hash)}`);
    await p.waitForSelector('.composer textarea', { timeout: 20000 });
    await p.waitForTimeout(600);
    return { ctx, p, errors, frames };
  };
  const note = async (p: { locator: (s: string) => { textContent: (o: object) => Promise<string | null> } }) => p.locator('.typing-note').textContent({ timeout: 300 }).catch(() => null);
  const a = await page('anton', 'browser typing one', dm);
  const v = await page('vic', 'browser typing three', general.id);
  const s = await page('serhii', 'browser typing two', dm);
  const box = s.p.locator('.composer textarea');

  check('nothing before anyone types', (await note(a.p)) === null);
  await box.type('Working on it', { delay: 30 });
  await a.p.waitForTimeout(500);
  check('appears while typing', (await note(a.p))?.includes('serhii is typing') === true);
  let held = true;
  for (let i = 0; i < 10; i++) { await box.type('.'); await a.p.waitForTimeout(1000); held &&= (await note(a.p))?.includes('serhii is typing') === true; }
  check('holds through 10 s of typing', held);
  await box.fill('');
  await a.p.waitForTimeout(600);
  check('gone when the text is cleared', (await note(a.p)) === null);

  // A draft carried into another conversation is nobody typing there (Mattew, T-476).
  await box.type('a draft', { delay: 30 });
  await a.p.goto(`${U}/#chat/${general.id}`);
  await a.p.waitForSelector('.composer textarea');
  await s.p.goto(`${U}/#chat/${general.id}`);
  await a.p.waitForTimeout(1500);
  check('a carried-over draft is not shown as typing', (await note(a.p)) === null);
  check('the draft did not travel as a typing frame', !a.frames.some((f) => f.includes('"typing"') && f.includes(general.id) && !f.includes('"ms":0')));
  await s.p.goto(`${U}/#chat/${encodeURIComponent(dm)}`);
  await s.p.waitForSelector('.composer textarea');

  // A closed page ends it at once.
  await a.p.goto(`${U}/#chat/${encodeURIComponent(dm)}`);
  await a.p.waitForSelector('.composer textarea');
  await s.p.locator('.composer textarea').fill('');
  await s.p.locator('.composer textarea').type('again', { delay: 30 });
  await a.p.waitForTimeout(500);
  check('appears again', (await note(a.p))?.includes('serhii is typing') === true);
  await s.ctx.close();
  await a.p.waitForTimeout(800);
  check('gone when the writer\'s page closes', (await note(a.p)) === null);

  // Someone without access to the DM was told nothing of it.
  check('no typing frame about the DM for an outsider', !v.frames.some((f) => f.includes('"typing"') && f.includes(dm)));
  check('no frame naming the DM for an outsider', !v.frames.some((f) => f.includes(dm)));
  check('no page errors', a.errors.length + v.errors.length + s.errors.length === 0);
} finally {
  await browser.close();
  await server.stop();
  board.close();
  ray.close();
  await rm(dir, { recursive: true, force: true });
}
if (failures.length > 0) { console.error(`BROWSER_TYPING_FAIL ${failures.join('; ')}`); process.exit(1); }
console.log('BROWSER_TYPING_PASS appears holds clears draft_not_typing closes outsider_silent');
