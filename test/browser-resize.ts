/** Real Chromium + production-style built UI; deterministic local fixtures, no production accounts. */
import { chromium, expect } from 'playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = await mkdtemp(join(tmpdir(), 'rayboard-resize-'));
const build = await Bun.build({ entrypoints: ['ui/index.html'], outdir: out, minify: true, target: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, naming: { chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]', entry: '[name].[ext]' } });
if (!build.success) throw Error(build.logs.join('\n'));
const files = new Map(build.outputs.map(f => [f.path.slice(out.length), f]));
const user = { id: 'u_test', name: 'tester', role: 'member' };
const task = { id: 'T-9', title: 'Resize fixture', status: 'open', creator: user.id, assignee: user.id, priority: 1, seq: 1, rev: 1, created: new Date().toISOString() };
const board = { now: new Date().toISOString(), agents: [], people: [user], channels: [{ id: 'c_general', name: 'general' }], tasks: [task], reviews: [], dms: [{ chan: 'dm:a_morsel:a_morsel-member-client' }], enrollment: false, seq: 1 };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/api/session') return Response.json({ ok: true, setup: false, user });
  if (path.startsWith('/api/call/')) {
    const args = await req.json() as Record<string, string>;
    switch (path.slice('/api/call/'.length)) {
      case 'dashboard': return Response.json({ ok: true, result: board });
      case 'read_messages': return Response.json({ ok: true, result: [] });
      case 'get_task': return Response.json({ ok: true, result: { task, thread: [], evidence: [], reviews: [], subtasks: [], cost: 0 } });
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
  await page.goto(base + '/#overview');
  const sidebar = page.getByRole('separator', { name: 'Resize sidebar' });
  // This failed in the original implementation: the separator was in the DOM but invisible.
  await expect(sidebar).toBeVisible();
  const box = await sidebar.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(9);
  expect(box!.height).toBeGreaterThan(100);
  await page.mouse.move(box!.x + 4, box!.y + 250);
  await page.mouse.down();
  await page.mouse.move(box!.x + 40, box!.y + 250, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Number(await sidebar.getAttribute('aria-valuenow'))).toBeGreaterThan(236);
  const width = await sidebar.getAttribute('aria-valuenow');
  await page.reload();
  await expect.poll(() => sidebar.getAttribute('aria-valuenow')).toBe(width);

  await page.goto(base + '/#chat/c_general');
  const chat = page.getByRole('separator', { name: 'Resize conversation list' });
  await expect(chat).toBeVisible();
  await chat.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => chat.getAttribute('aria-valuenow')).toBe('232');
  const watched = page.locator('.chat aside > button').filter({ hasText: 'morsel-member-client' });
  const label = watched.locator('.grow');
  await expect(label).toBeVisible();
  const labelBox = await label.boundingBox();
  const countBox = await watched.locator('.muted').boundingBox();
  expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(countBox!.x + 1);
  const textWidth = await label.evaluate(e => e.scrollWidth);
  expect(textWidth).toBeGreaterThanOrEqual(labelBox!.width);
  expect(await label.evaluate(e => getComputedStyle(e).textOverflow)).toBe('ellipsis');

  await page.goto(base + '/#tasks/T-9');
  const drawer = page.getByRole('complementary', { name: 'Task T-9' });
  await expect(drawer).toBeVisible();
  const handle = page.getByRole('separator', { name: 'Resize task panel' });
  await expect(handle).toBeVisible();
  const before = await drawer.boundingBox();
  const edge = await handle.boundingBox();
  await page.mouse.move(edge!.x + 4, edge!.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge!.x - 80, edge!.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(400);
  expect((await drawer.boundingBox())!.width).toBeGreaterThan(before!.width);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.shell > .resize-handle')).toBeHidden();
  await expect(handle).toBeHidden();
  await expect(drawer).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(errors).toEqual([]);
  console.log('RESIZE BROWSER PASS: visible pointer/keyboard handles, persistence, name ellipsis, mobile.');
} finally {
  await browser?.close();
  await server.stop();
  await rm(out, { recursive: true, force: true });
}
