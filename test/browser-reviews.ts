/** Real Chromium + built React UI; deterministic local fixtures, never production accounts.
 * Run: bun run test:reviews. RAYBOARD_UI_ENTRY may select the unmodified UI for a negative control.
 */
import { chromium, expect } from 'playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = await mkdtemp(join(tmpdir(), 'rayboard-reviews-'));
const entry = process.env.RAYBOARD_UI_ENTRY ?? 'ui/index.html';
const build = await Bun.build({ entrypoints: [entry], outdir: out, minify: true, target: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, naming: { chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]', entry: '[name].[ext]' } });
if (!build.success) throw Error(build.logs.join('\n'));
const files = new Map(build.outputs.map(f => [f.path.slice(out.length), f]));
const user = { id: 'u_anton', name: 'anton', role: 'admin' };
const agent = { id: 'a_worker', name: 'worker', kind: 'teneral', status: 'active' };
const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `T-${i + 1}`, title: `Decision ${i + 1}`, status: 'in_review', creator: agent.id, assignee: agent.id, reviewer: user.id, priority: 1, seq: i + 1, rev: 1, created: new Date().toISOString() }));
const reviews = tasks.map((t, i) => ({ id: `r_${i}`, task: t.id, title: t.title, requester: agent.id, reviewer: user.id, status: 'pending', note: `DECISION ${i + 1}\n\nOptions:\n- A\n- B\n\nRECOMMENDATION: A.`, created: new Date().toISOString() }));
const board: Record<string, any> = { now: new Date().toISOString(), agents: [agent], people: [user], channels: [], tasks, reviews, dms: [], enrollment: false, seq: 1 };
const calls: Record<string, any>[] = [];
const drawers: string[] = [];
let failNext = true;
let hold: (() => void) | undefined;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/api/session') return Response.json({ ok: true, setup: false, user });
  if (path.startsWith('/api/call/')) {
    const args = path.endsWith('/dashboard') ? {} : await req.json() as Record<string, any>;
    calls.push({ action: path.slice('/api/call/'.length), ...args });
    if (path.endsWith('/dashboard')) return Response.json({ ok: true, result: board });
    if (path.endsWith('/activity')) return Response.json({ ok: true, result: [] });
    if (path.endsWith('/get_task')) { drawers.push(args.task); const task = board.tasks.find((t: any) => t.id === args.task); return Response.json({ ok: true, result: { task, thread: [], evidence: [], reviews: board.reviews.filter((r: any) => r.task === args.task), subtasks: [], cost: 0 } }); }
    if (path.endsWith('/review_task')) {
      if (hold) await new Promise<void>((done) => { hold = done; });
      if (failNext) { failNext = false; return Response.json({ ok: false, error: { code: 'invalid', message: 'say in comment what has to change' } }, { status: 400 }); }
      const task = board.tasks.find((t: any) => t.id === args.task);
      const review = board.reviews.find((r: any) => r.task === args.task);
      task.status = args.verdict === 'approve' ? 'done' : 'changes_requested';
      board.reviews = board.reviews.filter((r: any) => r !== review);
      return Response.json({ ok: true, result: { task, review: { ...review, status: args.verdict } } });
    }
    return Response.json({ ok: false, error: { code: 'unsupported', message: path } }, { status: 400 });
  }
  const file = files.get(path === '/' ? '/index.html' : path);
  return file ? new Response(file, { headers: { 'content-type': file.type } }) : new Response('not found', { status: 404 });
} });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}/#reviews`);
  const cards = page.locator('.review-card');
  await expect(cards).toHaveCount(12);
  await expect(page.locator('.reviews-group').first()).toContainText('12');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(12);
  await expect(page.locator('.review-card .prose.clamp')).toHaveCount(0);
  await expect(cards.nth(11)).toContainText('RECOMMENDATION: A.');
  expect(drawers).toEqual([]);

  const first = cards.first();
  await expect(first.getByRole('button', { name: 'Request changes', exact: true })).toBeDisabled();
  await expect(first.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  await first.getByRole('textbox', { name: 'Comment on T-1' }).fill('Please cover the second option.');
  await expect(first.getByRole('button', { name: 'Request changes', exact: true })).toBeEnabled();
  await first.getByRole('button', { name: 'Request changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('say in comment what has to change');
  await expect(cards).toHaveCount(12);
  hold = () => {};
  await first.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(first.getByRole('button', { name: 'Approving…', exact: true })).toBeDisabled();
  await expect(first.getByRole('button', { name: 'Request changes', exact: true })).toBeDisabled();
  await first.getByRole('button', { name: 'Approving…', exact: true }).click({ force: true });
  expect(calls.filter((c) => c.action === 'review_task')).toHaveLength(2);
  hold(); hold = undefined;
  await expect(cards).toHaveCount(11);
  expect(calls.filter((c) => c.action === 'review_task').at(-1)).toMatchObject({ task: 'T-1', verdict: 'approve', comment: 'Please cover the second option.' });
  expect(drawers).toEqual([]);

  await cards.first().getByRole('textbox', { name: 'Comment on T-2' }).fill('Use option B.');
  await cards.first().getByRole('button', { name: 'Request changes', exact: true }).click();
  await expect(cards).toHaveCount(10);
  expect(calls.filter((c) => c.action === 'review_task').at(-1)).toMatchObject({ task: 'T-2', verdict: 'request_changes', comment: 'Use option B.' });
  expect(drawers).toEqual([]);

  // A viewer is not made a reviewer by this presentation, and a named reviewer is not replaced by an admin.
  user.role = 'viewer';
  await page.reload();
  await expect(cards).toHaveCount(10);
  await expect(page.locator('.review-decision')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  user.role = 'admin';
  for (const review of board.reviews) review.reviewer = 'u_other';
  await page.reload();
  await expect(page.locator('.reviews-group').first()).toContainText('Waiting for your verdict0');
  await expect(cards).toHaveCount(10);
  await expect(page.locator('.reviews-group').nth(1)).toContainText('Waiting for someone else10');
  await expect(page.locator('.review-decision')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

  await cards.first().locator('.review-open').click();
  await expect.poll(() => drawers.at(-1)).toBe('T-3');
  await expect(page.getByRole('complementary', { name: 'Task T-3', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('REVIEWS_BROWSER_PASS 12_cards full_notes inline_approve inline_changes empty_comment_disabled busy_once error_kept task_link_optional');
} finally {
  await browser?.close();
  server.stop(true);
  await rm(out, { recursive: true, force: true });
}
