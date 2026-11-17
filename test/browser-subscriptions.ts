/** Subscription controls in real Chromium; loopback fixtures, no production accounts.
 * Run: bun test/browser-subscriptions.ts (install Chromium once with bunx playwright install chromium).
 * RAYBOARD_UI_ENTRY may select an unmodified UI for a negative control.
 */
import { chromium, expect } from 'playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outdir = await mkdtemp(join(tmpdir(), 'rayboard-subscriptions-'));
const entry = process.env.RAYBOARD_UI_ENTRY ?? 'ui/index.html';
const build = await Bun.build({ entrypoints: [entry], outdir, target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
if (!build.success) { await rm(outdir, { recursive: true }); throw new Error(build.logs.join('\n')); }
const files = new Map(build.outputs.map(f => [f.path.slice(outdir.length), f]));
const user = { id: 'u_test', name: 'tester', role: 'member' as string };
const task = { id: 'T-4', title: 'Navigation fixture', status: 'open', creator: user.id, assignee: '', priority: 1, seq: 1, rev: 1, created: new Date().toISOString() };
const board = { now: new Date().toISOString(), agents: [], people: [user], channels: [{ id: 'c_a/b', name: 'Navigation', subscribed: false }], tasks: [task], reviews: [], dms: [], enrollment: false, seq: 1 };
let loggedIn = true;
const subscriptions: boolean[] = [];
const sockets=new Set<{send(data:string):unknown}>();
const seenTasks: string[] = [], seenChats: string[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req, server) {
  const path = new URL(req.url).pathname;
  if(path==='/ws' && server.upgrade(req)) return;
  if (path === '/api/session') return Response.json({ ok: true, setup: false, user: loggedIn ? user : null });
  if (path === '/api/login') { loggedIn = true; return Response.json({ ok: true }); }
  if (path.startsWith('/api/call/')) {
    const args = await req.json() as Record<string, string>;
    switch (path.slice('/api/call/'.length)) {
      case 'set_channel_subscription': {
        expect(args.channel).toBe('c_a/b');
        expect(typeof args.subscribed).toBe('boolean');
        board.channels[0]!.subscribed = Boolean(args.subscribed);
        subscriptions.push(Boolean(args.subscribed));
        for(const socket of sockets) socket.send(JSON.stringify({quiet:false}));
        return Response.json({ok:true,result:{channel:'c_a/b',subscribed:args.subscribed}});
      }
      case 'dashboard': return Response.json({ ok: true, result: board });
      case 'read_messages': seenChats.push(args.from!); return Response.json({ ok: true, result: [] });
      case 'get_task': seenTasks.push(args.task!); return Response.json({ ok: true, result: { task: { ...task, id: args.task }, thread: [], evidence: [], reviews: [], subtasks: [], cost: 0 } });
      default: return Response.json({ ok: false, error: { code: 'unsupported', message: path } }, { status: 400 });
    }
  }
  const file = files.get(path === '/' ? '/index.html' : path);
  return file ? new Response(file, { headers: { 'content-type': file.type } }) : new Response('not found', { status: 404 });
}, websocket:{open(ws){sockets.add(ws);},message(){},close(ws){sockets.delete(ws);}} });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH}: {})});
  const page = await browser.newPage(); const errors:string[]=[];
  page.on('pageerror', e=>errors.push(e.message));
  const url=`http://127.0.0.1:${server.port}/#chat/${encodeURIComponent('c_a/b')}`;
  await page.goto(url);
  const subscribe=page.getByRole('button',{name:'Subscribe',exact:true});
  await expect(subscribe).toHaveAttribute('aria-pressed','false');
  await subscribe.click();
  await expect(page.getByRole('button',{name:'Subscribed',exact:true})).toHaveAttribute('aria-pressed','true');
  expect(subscriptions).toEqual([true]);
  await page.reload();
  await expect(page.getByRole('button',{name:'Subscribed',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Subscribed',exact:true}).click();
  await expect(subscribe).toHaveAttribute('aria-pressed','false');
  expect(subscriptions).toEqual([true,false]);
  user.role='viewer'; await page.reload();
  await expect(page.locator('main .chat')).toBeVisible();
  await expect(page.getByRole('button',{name:/^Subscribe(d)?$/})).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log('BROWSER_SUBSCRIBE_UNSUBSCRIBE_RELOAD_VIEWER_PASS_NO_PRODUCTION');
} finally {
  await browser?.close();server.stop(true);await rm(outdir,{recursive:true});
}
