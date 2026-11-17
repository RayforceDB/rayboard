/** Real Chromium + built React UI; deterministic HTTP fixtures, no production accounts.
 * Run: bun run test:browser (install Chromium once with bunx playwright install chromium).
 * RAYBOARD_UI_ENTRY may select an unmodified UI for a negative control.
 */
import { chromium, expect } from 'playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outdir = await mkdtemp(join(tmpdir(), 'rayboard-navigation-'));
const entry = process.env.RAYBOARD_UI_ENTRY ?? 'ui/index.html';
const build = await Bun.build({ entrypoints: [entry], outdir, target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
if (!build.success) { await rm(outdir, { recursive: true }); throw new Error(build.logs.join('\n')); }
const files = new Map(build.outputs.map(f => [f.path.slice(outdir.length), f]));
const user = { id: 'u_test', name: 'tester', role: 'member' };
const task = { id: 'T-4', title: 'Navigation fixture', status: 'open', creator: user.id, assignee: '', priority: 1, seq: 1, rev: 1, created: new Date().toISOString() };
const board = { now: new Date().toISOString(), agents: [], people: [user], channels: [{ id: 'c_a/b', name: 'Navigation' }], tasks: [task], reviews: [], dms: [], enrollment: false, seq: 1 };
let loggedIn = true;
const seenTasks: string[] = [], seenChats: string[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/api/session') return Response.json({ ok: true, setup: false, user: loggedIn ? user : null });
  if (path === '/api/login') { loggedIn = true; return Response.json({ ok: true }); }
  if (path.startsWith('/api/call/')) {
    const args = await req.json() as Record<string, string>;
    switch (path.slice('/api/call/'.length)) {
      case 'dashboard': return Response.json({ ok: true, result: board });
      case 'read_messages': seenChats.push(args.from!); return Response.json({ ok: true, result: [] });
      case 'get_task': seenTasks.push(args.task!); return Response.json({ ok: true, result: { task: { ...task, id: args.task }, thread: [], evidence: [], reviews: [], subtasks: [], cost: 0 } });
      default: return Response.json({ ok: false, error: { code: 'unsupported', message: path } }, { status: 400 });
    }
  }
  const file = files.get(path === '/' ? '/index.html' : path);
  return file ? new Response(file, { headers: { 'content-type': file.type } }) : new Response('not found', { status: 404 });
} });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const base = `http://127.0.0.1:${server.port}`;
  await page.goto(base + '/#tasks/T-4');
  await expect(page.getByRole('complementary', { name: 'Task T-4', exact: true })).toBeVisible();
  // Same document URL change must update React, preserving encoded slash/colon/Cyrillic IDs.
  for (const id of ['c_a/b', 'dm:a_one:u_two', 'обсуждение', '%2F']) {
    await page.evaluate(id => { location.hash = '#chat/' + encodeURIComponent(id); }, id);
    await expect(page.locator('main .chat')).toBeVisible();
    await expect.poll(() => seenChats.at(-1)).toBe(id);
  }
  await page.evaluate(() => { location.hash = '#tasks/T-4'; });
  await expect(page.getByRole('complementary', { name: 'Task T-4', exact: true })).toBeVisible();
  // Actual internal card/sidebar clicks create entries, unlike replaceState.
  await page.locator('.shell > nav button').filter({ hasText: 'Discussions' }).click();
  await expect(page.locator('main .chat')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('complementary', { name: 'Task T-4', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.locator('main .chat')).toBeVisible();
  await page.locator('.shell > nav button').filter({ hasText: 'Board' }).click();
  await page.locator('.card-task').filter({ hasText: 'Navigation fixture' }).click();
  await expect(page.getByRole('complementary', { name: 'Task T-4', exact: true })).toBeVisible();
  const historyLength = await page.evaluate(() => history.length);
  await page.locator('.card-task').filter({ hasText: 'Navigation fixture' }).click();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Task T-4', exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('complementary', { name: 'Task T-4', exact: true })).toBeVisible();
  // A deep link survives the unauthenticated screen and login.
  loggedIn = false;
  await page.goto(base + '/#tasks/T-4');
  await page.reload(); // A fresh session request, even when only the hash changed.
  await page.locator('input[autocomplete=username]').fill('fixture');
  await page.locator('input[autocomplete=current-password]').fill('not-a-real-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Task T-4', exact: true })).toBeVisible();
  await page.goto(base + '/#chat/%E0%A4%A');
  await expect(page.locator('main .chat')).toBeVisible();
  await page.evaluate(() => { location.hash = '#unknown/T-4'; });
  await expect(page.locator('main .chat')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(seenTasks).toContain('T-4');
  console.log('BROWSER_NAVIGATION_PASS mounted_hash encoded_ids task_drawer history duplicate login malformed_hash');
} finally {
  await browser?.close();
  server.stop(true);
  await rm(outdir, { recursive: true });
}
