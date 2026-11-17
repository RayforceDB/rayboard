/** Real Chromium + production-style built UI; deterministic local fixtures, no production accounts. */
import { chromium, expect } from 'playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = await mkdtemp(join(tmpdir(), 'rayboard-card-drag-'));
const build = await Bun.build({ entrypoints: ['ui/index.html'], outdir: out, minify: true, target: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, naming: { chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]', entry: '[name].[ext]' } });
if (!build.success) throw Error(build.logs.join('\n'));
const files = new Map(build.outputs.map(f => [f.path.slice(out.length), f]));
const user = { id: 'u_test', name: 'tester', role: 'member' };
const task = { id: 'T-9', title: 'Drag fixture', status: 'open', creator: user.id, assignee: user.id, priority: 1, seq: 1, rev: 1, created: new Date().toISOString() };
const board = { now: new Date().toISOString(), agents: [], people: [user], channels: [{ id: 'c_general', name: 'general' }], tasks: [task], reviews: [], dms: [{ chan: 'dm:a_morsel:a_morsel-member-client' }], enrollment: false, seq: 1 };
const clients = new Set<any>();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, server) {
  const path = new URL(req.url).pathname;
  if (path === '/ws') return server.upgrade(req) ? undefined : new Response('ws', {status:400});
  if (path === '/api/session') return Response.json({ ok: true, setup: false, user });
  if (path.startsWith('/api/call/')) return (async()=>{const args=await req.json();
    if(path.endsWith('/dashboard')) return Response.json({ok:true,result:board});
    if(path.endsWith('/activity')) return Response.json({ok:true,result:[]});
    if(path.endsWith('/read_messages')) return Response.json({ok:true,result:[]});
    if(path.endsWith('/get_task')) return Response.json({ok:true,result:{task,thread:[],evidence:[],reviews:[],subtasks:[],cost:0}});
    if(path.endsWith('/move_task')) {expect(args).toEqual({task:'T-9',status:'in_progress',rev:1}); task.status='in_progress';task.rev=2;board.seq=2;for(const c of clients)c.send(JSON.stringify({quiet:false}));return Response.json({ok:true,result:task});}
    return Response.json({ok:false,error:{code:'unsupported',message:path}},{status:400});})();
  const file=files.get(path==='/'?'/index.html':path);return file?new Response(file,{headers:{'content-type':file.type}}):new Response('not found',{status:404});
}, websocket:{open(ws){clients.add(ws)},close(ws){clients.delete(ws)},message(){}} });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const base = `http://127.0.0.1:${server.port}`;
  await page.goto(base + '/#tasks');
  const card=page.locator('.card-task'); await expect(card).toBeVisible();
  expect(await card.getAttribute('draggable')).toBe('true');
  const source=await card.boundingBox(), target=await page.locator('.lane').nth(1).boundingBox();
  await page.mouse.move(source!.x+70,source!.y+30); await page.mouse.down();
  await page.mouse.move(target!.x+70,target!.y+150,{steps:12});
  await expect(page.locator('.lane').nth(1)).toHaveClass(/drop-target/); await page.mouse.up();
  await expect(page.locator('.lane').nth(1).locator('.card-task')).toHaveCount(1);
  await expect(page.locator('.lane').nth(0).locator('.card-task')).toHaveCount(0);
  await page.locator('.lane').nth(1).locator('.card-task').click();
  await expect(page.locator('.card-task.on')).toHaveCSS('border-top-color','rgb(40, 120, 208)');
  await page.locator('.kanban').screenshot({path:'/tmp/rayboard-card-drag.png'});
  expect(errors).toEqual([]);
  console.log('CARD BROWSER PASS: real pointer drag/drop, stage update, blue selection.');
} finally {
  await browser?.close();
  await server.stop();
  await rm(out, { recursive: true, force: true });
}
