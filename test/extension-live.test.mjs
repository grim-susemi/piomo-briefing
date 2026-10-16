// Integration of the generation-4 pieces inside the extension: render.lock contention without stalls, the board server
// host, live worker rows from the task bus, plan_brief, global pause and the lead-only gate. Real files, real sockets,
// real second processes; ports 47400+. Waits are on events (file changes, SSE frames, process messages) with a bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { createBriefingExtension } from '../extension.mjs';
import { planIdOf, rootAndSlugOf } from '../src/plan-schema.mjs';
import { PLAN_CHIP_STALE, planChipMissing } from '../src/plan-tool.mjs';
import { makeFakePi, makeCtx } from './helpers/fake-pi.mjs';

const HOLDER = fileURLToPath(new URL('./helpers/lock-holder.mjs', import.meta.url));
const RPC = 'senpi:extension-rpc-event';
const REGISTRY = Symbol.for('omo.briefing.server');
let portSeed = 47400;
const nextBase = () => { const b = portSeed; portSeed += 12; return String(b); };
const norm = (p) => p.replace(/\\/g, '/');
const text = (r) => r.content.map((b) => b.text).join('\n');

const goodBrief = (over = {}) => ({
  title: '작업 하나', status: 'in_progress', headline: '목표까지 절반',
  changes: [{ text: '고침', truth: 'reported', applied: 'candidate' }], done: [], next: '다음 일', decisions: [], ...over,
});
const decision = () => ({
  question: '어느 쪽으로 갈까?',
  options: { A: { text: '가', consequence: '빠름' }, B: { text: '나', consequence: '안전' } },
  recommend: 'A', reason: '빨라서', blocks: false,
});
const PLAN_TEXT = ['# plan', '- [ ] 1. 첫째', '  Parallelization: Wave 1 | Blocked by: 없음 | Blocks: 2', '- [ ] 2. 둘째', '  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 없음', ''].join('\n');
const planInput = (planPath, over = {}) => ({
  planPath, stage: 'review', stageNote: '', goal: '목표', ideal: [{ id: 'IS-1', text: '이상' }], components: [],
  waves: [{ n: 1, label: '기초' }, { n: 2, label: '후속' }],
  tasks: [
    { id: '1', wave: 1, label: '첫째', what: '무엇', done: '끝', deps: [] },
    { id: '2', wave: 2, label: '둘째', what: '무엇', done: '끝', deps: ['1'] },
  ],
  questions: [{
    id: 'Q1', text: '진행할까요?', state: 'open',
    options: { A: { text: '진행', consequence: '간다' }, B: { text: '보류', consequence: '선다' } },
    recommend: 'A', reason: '빠르다', blocks: true,
  }],
  outOfScope: [], ...over,
});

function makeBus() {
  const m = new Map();
  return {
    on(ch, fn) { if (!m.has(ch)) m.set(ch, new Set()); m.get(ch).add(fn); return () => m.get(ch).delete(fn); },
    emit(ch, payload) { for (const fn of [...(m.get(ch) ?? [])]) fn(payload); },
    listeners: (ch) => (m.get(ch) ? m.get(ch).size : 0),
  };
}

/** Manual timers: nothing runs by itself; runAll() fires every pending callback now. Counts every creation. */
function fakeTimers() {
  let n = 0;
  const pending = new Map();
  const t = {
    created: 0,
    setTimeout(fn) { t.created++; const h = { id: ++n, unref() {} }; pending.set(h, { fn, once: true }); return h; },
    clearTimeout(h) { pending.delete(h); },
    setInterval(fn) { t.created++; const h = { id: ++n, unref() {} }; pending.set(h, { fn, once: false }); return h; },
    clearInterval(h) { pending.delete(h); },
    pending: () => pending.size,
    async runAll(rounds = 3) {
      for (let i = 0; i < rounds; i++) {
        for (const [h, { fn, once }] of [...pending]) {
          if (once) pending.delete(h);
          await fn();
        }
        await new Promise((r) => setImmediate(r));
      }
    },
  };
  return t;
}

/** One lead conversation in its own temp project and STATE (or sharing `dir` with another one). */
function make(t, o = {}) {
  const { server = false, sid = 'sess-A', sessionKind = 'interactive', file, hasUI = true, fs, timers, dir: given, extra = {} } = o;
  const dir = given ?? mkdtempSync(join(tmpdir(), 'omo-live-'));
  const stateDir = join(dir, 'state');
  const cwd = join(dir, 'proj');
  mkdirSync(join(cwd, '.omo', 'plans'), { recursive: true });
  const host = makeFakePi({ sessionKind, cwd });
  const events = makeBus();
  host.pi.events = events;
  const env = { PATH: process.env.PATH, HERDR_BIN_PATH: '', OMO_BRIEFING_PORT_BASE: o.base ?? nextBase() };
  const opened = [];
  createBriefingExtension({
    stateDir, env, server, generation: 4,
    openPage: (p) => { opened.push(p); return { launcher: 'chrome', command: 'x', args: [] }; },
    ...(fs ? { fs } : {}), ...(timers ? { timers } : {}), ...extra,
  })(host.pi);
  const { ctx, notes } = makeCtx({ cwd, sid, file: file ?? `C:/sessions/${sid}.jsonl`, hasUI });
  let down = false;
  const shutdown = async () => { if (!down) { down = true; await host.emit('session_shutdown', {}, ctx); } };
  if (!given) {
    t.after(async () => {
      await shutdown();
      rmSync(dir, { recursive: true, force: true });
    });
  } else {
    t.after(shutdown);
  }
  return {
    dir, stateDir, cwd, host, events, ctx, notes, opened, env, shutdown,
    start: () => host.emit('session_start', { reason: 'startup' }, ctx),
    brief: (input) => host.tool('brief').execute('call', input, undefined, undefined, ctx),
    command: (name, args = '') => host.commands.get(name).handler(args, ctx),
    meta: () => JSON.parse(readFileSync(join(stateDir, 'sessions', sid, 'meta.json'), 'utf8')),
  };
}

const seqOf = (stateDir) => JSON.parse(readFileSync(join(stateDir, 'published.json'), 'utf8')).seq;
const parseData = (src) => {
  const open = src.lastIndexOf('window.__briefData(') + 'window.__briefData('.length;
  return JSON.parse(src.slice(open, src.lastIndexOf(');')));
};
const readData = (stateDir) => parseData(readFileSync(join(stateDir, 'data.js'), 'utf8'));
const serverUrl = (stateDir) => `http://127.0.0.1:${JSON.parse(readFileSync(join(stateDir, 'server.json'), 'utf8')).port}/`;

/** Resolves with pred()'s first truthy value, checked now and after every change in `dir`; rejects after `ms`. */
function until(dir, pred, label, ms = 10_000) {
  return new Promise((resolve, reject) => {
    let watcher = null;
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`timeout waiting for ${label}`)); }, ms);
    const check = () => {
      let v = null;
      try { v = pred(); } catch { v = null; } // a file caught mid-replace is simply "not yet"
      if (v) { clearTimeout(timer); watcher.close(); resolve(v); }
    };
    watcher = watch(dir, check);
    check();
  });
}

function get(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get({ host: '127.0.0.1', port: u.port, path: u.pathname, agent: false, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

function sse(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get({ host: '127.0.0.1', port: u.port, path: '/events', agent: false }, (res) => {
      const state = { text: '', closed: false };
      const waiters = new Set();
      res.setEncoding('utf8');
      res.on('data', (c) => { state.text += c; for (const w of [...waiters]) w(); });
      res.on('close', () => { state.closed = true; for (const w of [...waiters]) w(); });
      const waitFor = (pred, label, ms = 5000) => new Promise((ok, no) => {
        let w = null;
        const timer = setTimeout(() => { waiters.delete(w); no(new Error(`sse timeout waiting for ${label}: ${state.text.slice(-200)}`)); }, ms);
        w = () => { if (pred(state.text)) { clearTimeout(timer); waiters.delete(w); ok(state.text); } };
        waiters.add(w);
        w();
      });
      resolve({ state, waitFor, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

function startHolder(t, stateDir, holdMs) {
  const child = fork(HOLDER, [stateDir, String(holdMs)], { execArgv: [] });
  const closed = new Promise((r) => child.once('close', r));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  let released;
  const releasedP = new Promise((r) => { released = r; });
  child.on('message', (m) => { if (m && m.type === 'released') released(); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (m) => {
      if (m && m.type === 'held') resolve({ released: releasedP, release: () => child.send({ cmd: 'release' }) });
    });
  });
}

function lagProbe(every = 20) {
  let last = performance.now();
  let max = 0;
  const h = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last - every); last = n; }, every);
  return { stop: () => clearInterval(h), max: () => max };
}

// ------------------------------------------------------------------ render.lock held by someone else

test('render.lock held 3s by another process: brief and /decide wait on timers, the terminal never stalls, then both publish', { timeout: 60_000 }, async (t) => {
  const s = make(t);
  await s.start();
  await s.brief(goodBrief({ decisions: [decision()] }));
  const before = seqOf(s.stateDir);
  const holder = await startHolder(t, s.stateDir, 3000);
  const lag = lagProbe();
  const pBrief = s.brief(goodBrief({ headline: '락 중 보고' }));
  const pDecide = s.command('decide', '1A');
  await holder.released;
  const [r] = await Promise.all([pBrief, pDecide]);
  lag.stop();
  assert.ok(lag.max() <= 200, `terminal stalled ${lag.max()}ms`);
  assert.ok(text(r).startsWith('상황판 갱신됨'), text(r));
  assert.ok(seqOf(s.stateDir) >= before + 2, 'both publications went out');
  assert.equal(s.meta().errors.render, undefined);
  assert.equal(readData(s.stateDir).sessions[0].headline, '락 중 보고');
});

test('render.lock never released: render error after ~5s with no data.js written and no stall; the next publish shows the chip once, the one after clears it (data.js and server view)', { timeout: 60_000 }, async (t) => {
  const versions = [];
  const fs = { ...nodeFs, renameSync(a, b) { if (/data\.js$/.test(String(b))) versions.push(nodeFs.readFileSync(a, 'utf8')); return nodeFs.renameSync(a, b); } };
  const s = make(t, { server: true, fs });
  await s.start();
  await s.brief(goodBrief());
  const url = serverUrl(s.stateDir);
  const written = versions.length;
  const dataBefore = readFileSync(join(s.stateDir, 'data.js'), 'utf8');
  const holder = await startHolder(t, s.stateDir, 0);
  const lag = lagProbe();
  const r = await s.brief(goodBrief({ headline: '락 계속' }));
  lag.stop();
  assert.ok(lag.max() <= 200, `terminal stalled ${lag.max()}ms`);
  assert.ok(text(r).includes('갱신되지 못함'), text(r));
  assert.match(s.meta().errors.render.message, /render\.lock/, 'recorded in the real store');
  assert.equal(versions.length, written, 'data.js was not written');
  assert.equal(readFileSync(join(s.stateDir, 'data.js'), 'utf8'), dataBefore);
  const during = JSON.parse((await get(`${url}data.json`)).body);
  assert.ok(during.sessions[0].chips.includes('오류 있음'), 'the board server built from the store already shows the chip');

  holder.release();
  await holder.released;
  const from = versions.length;
  await s.brief(goodBrief({ headline: '락 풀린 뒤' }));
  const after = versions.slice(from).map(parseData).map((d) => d.sessions[0].chips);
  assert.ok(after.length >= 2, `two publications: ${after.length}`);
  assert.ok(after[0].includes('오류 있음'), 'the first publication after the lock shows the render chip');
  assert.ok(!after.at(-1).includes('오류 있음'), 'the next successful publication clears it');
  assert.equal(s.meta().errors.render, undefined);
  const healed = JSON.parse((await get(`${url}data.json`)).body);
  assert.ok(!healed.sessions[0].chips.includes('오류 있음'));
});

test('session_shutdown stays under 2s with three SSE pages open and render.lock held elsewhere; server and files are gone', { timeout: 60_000 }, async (t) => {
  const s = make(t, { server: true });
  await s.start();
  await s.brief(goodBrief());
  const url = serverUrl(s.stateDir);
  const pages = await Promise.all([sse(url), sse(url), sse(url)]);
  await Promise.all(pages.map((p) => p.waitFor((x) => x.includes('event: data'), 'first data')));
  const holder = await startHolder(t, s.stateDir, 0);
  const t0 = performance.now();
  await s.host.emit('session_shutdown', {}, s.ctx);
  const took = performance.now() - t0;
  assert.ok(took < 2000, `shutdown took ${took}ms`);
  assert.equal(existsSync(join(s.stateDir, 'server.lock')), false);
  assert.equal(existsSync(join(s.stateDir, 'server.json')), false);
  await Promise.all(pages.map((p) => p.waitFor(() => p.state.closed, 'stream closed')));
  await assert.rejects(get(`${url}health`), /ECONNREFUSED/);
  holder.release();
  await holder.released;
});

// ------------------------------------------------------------------ board server inside the extension

test('/reload: loading the extension twice in one process leaves one server; the old instance shutting down does not close it', { timeout: 30_000 }, async (t) => {
  const a = make(t, { server: true });
  await a.start();
  const b = make(t, { server: true, dir: a.dir, base: a.env.OMO_BRIEFING_PORT_BASE });
  await b.start();
  const mine = [...globalThis[REGISTRY].servers.keys()].filter((k) => k.includes(basename(a.dir).toLowerCase()));
  assert.equal(mine.length, 1, 'one server object for this STATE in this process');
  const url = serverUrl(a.stateDir);
  assert.equal(JSON.parse((await get(`${url}health`)).body).pid, process.pid);
  await a.shutdown();
  assert.equal((await get(`${url}health`)).status, 200, 'the displaced instance leaves the running server alone');
  await b.shutdown();
  await assert.rejects(get(`${url}health`), /ECONNREFUSED/);
  assert.equal(existsSync(join(a.stateDir, 'server.lock')), false);
});

test('GET / is this generation even when STATE holds an older index.html and an old-shape data.js', { timeout: 30_000 }, async (t) => {
  const s = make(t, { server: true });
  mkdirSync(s.stateDir, { recursive: true });
  writeFileSync(join(s.stateDir, 'index.html'), '<!doctype html><html><body>old gen 1 page</body></html>');
  writeFileSync(join(s.stateDir, 'data.js'), '/* seq:5 */\nwindow.__briefData && window.__briefData({"schema":1,"seq":5,"sessions":[]});\n');
  await s.start();
  await s.brief(goodBrief());
  const page = await get(serverUrl(s.stateDir));
  assert.equal(page.status, 200);
  assert.match(page.body, /<meta name="omo-briefing-generation" content="4">/);
  assert.match(page.body, /<meta name="omo-briefing-mode" content="server">/);
  assert.ok(page.body.includes('BriefPlanView') && page.body.includes('BriefWorkersView') && page.body.includes('BriefAlarm'));
  assert.ok(!page.body.includes('old gen 1 page'));
});

test('/brief opens the live address when the server is up, the file page otherwise', { timeout: 30_000 }, async (t) => {
  const s = make(t, { server: true });
  await s.start();
  await s.command('brief', '');
  assert.equal(s.opened.at(-1), serverUrl(s.stateDir));
  assert.ok(s.notes.at(-1).text.includes(serverUrl(s.stateDir)));
  const f = make(t);
  await f.start();
  await f.command('brief', '');
  assert.equal(norm(f.opened.at(-1)), norm(join(f.stateDir, 'index.html')), 'no server: the file page');
});

test('NO_PORT: the error is a chip in the really published data.js; freeing a port and /brief recovers it', { timeout: 30_000 }, async (t) => {
  const base = Number(nextBase());
  const blockers = [];
  for (let i = 0; i < 10; i++) {
    const srv = net.createServer();
    await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(base + i, '127.0.0.1', resolve); });
    blockers.push(srv);
  }
  const closeBlockers = () => Promise.all(blockers.map((b) => new Promise((r) => b.close(r))));
  t.after(closeBlockers);
  const s = make(t, { server: true, base: String(base) });
  await s.start();
  assert.match(s.meta().errors['server:listen'].message, /포트가 없음/);
  assert.ok(readData(s.stateDir).sessions[0].chips.includes('오류 있음'), 'the published page shows it');
  assert.equal(existsSync(join(s.stateDir, 'server.lock')), false);
  await closeBlockers();
  blockers.length = 0;
  await s.command('brief', '');
  assert.equal(s.meta().errors['server:listen'], undefined);
  assert.ok(!readData(s.stateDir).sessions[0].chips.includes('오류 있음'));
  assert.ok(s.opened.at(-1).startsWith('http://127.0.0.1:'));
});

test('global pause: pages hear `paused`, the server and lock go away, and rpc events, settle, plan status and soft publishes write nothing; /brief on resumes', { timeout: 30_000 }, async (t) => {
  const timers = fakeTimers();
  const s = make(t, { server: true, timers });
  await s.start();
  await s.brief(goodBrief());
  const url = serverUrl(s.stateDir);
  const page = await sse(url);
  await page.waitFor((x) => x.includes('event: data'), 'first data');
  await s.command('brief', 'off');
  await page.waitFor((x) => x.includes('event: paused'), 'paused frame');
  assert.equal(existsSync(join(s.stateDir, 'server.lock')), false);
  assert.equal(existsSync(join(s.stateDir, 'server.json')), false);

  const files = ['published.json', 'data.js', 'index.html'];
  const bytes = () => files.map((f) => readFileSync(join(s.stateDir, f), 'utf8'));
  const frozen = bytes();
  const planPath = norm(join(s.cwd, '.omo', 'plans', 'demo.md'));
  writeFileSync(planPath, PLAN_TEXT);
  s.events.emit(RPC, { name: 'omo.task.updated', data: { parent_session_id: 'senpi:sess-A', tasks: [{ task_id: 'st_p1', parent_session_id: 'sess-A', status: 'running', task_summary: '멈춘 동안', updated_at: new Date().toISOString() }] } });
  await s.host.emit('tool_result', { toolName: 'write', input: { path: planPath }, isError: false, content: [] }, s.ctx);
  await s.host.emit('agent_settled', {}, s.ctx);
  const paused = await s.host.tool('plan_brief').execute('c', planInput(planPath), undefined, undefined, s.ctx);
  assert.equal(paused.details.disabled, true);
  await timers.runAll(4);
  assert.deepEqual(bytes(), frozen, 'nothing was published');
  assert.equal(existsSync(join(s.stateDir, 'plans')), false, 'no plan revision or status.json');
  assert.equal(existsSync(join(s.stateDir, 'server.lock')), false);

  const before = seqOf(s.stateDir);
  await s.command('brief', 'on');
  assert.ok(seqOf(s.stateDir) > before, 'resumed: published again');
  assert.equal(existsSync(join(s.stateDir, 'server.lock')), true, 'resumed: owns the server again');
  await timers.runAll(4);
  const live = readData(s.stateDir).sessions[0].live;
  assert.deepEqual(live.workers.map((w) => w.id), ['st_p1'], 'the snapshot received while paused is published once resumed');
});

test('started while paused: no lock, no server file, no listener', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omo-live-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'settings.json'), JSON.stringify({ enabled: false }));
  const s = make(t, { server: true, dir });
  // registered after make(): the session shutdown (which saves its meta) runs first, then the folder goes
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await s.start();
  assert.equal(existsSync(join(s.stateDir, 'server.lock')), false);
  assert.equal(existsSync(join(s.stateDir, 'server.json')), false);
  assert.equal(existsSync(join(s.stateDir, 'published.json')), false);
});

// ------------------------------------------------------------------ lead-only

test('worker sessions and child session files register nothing: no tools, no bus subscription, no timers, no files', async (t) => {
  const timers = fakeTimers();
  let watches = 0;
  const fs = { ...nodeFs, watch(...a) { watches++; return nodeFs.watch(...a); } };
  const worker = make(t, { sessionKind: 'worker', server: true, timers, fs });
  assert.deepEqual(worker.host.registrations, { on: [], tools: [], commands: [] });
  assert.equal(worker.events.listeners(RPC), 0);
  await worker.start();
  const child = make(t, { file: 'C:/proj/.omo/senpi-task/children/st_x/sessions/s.jsonl', server: true, timers, fs });
  await child.start();
  const print = make(t, { hasUI: false, server: true, timers, fs });
  await print.start();
  for (const x of [child, print]) {
    assert.deepEqual(x.host.registrations.tools, []);
    assert.equal(x.events.listeners(RPC), 0, 'the task-bus subscription is dropped');
    assert.equal(existsSync(x.stateDir), false);
  }
  assert.equal(timers.created, 0);
  assert.equal(watches, 0);
});

// ------------------------------------------------------------------ live workers and plans

test('task-bus snapshots become live worker rows in the published data; a later brief keeps them; a launched worker is an info-waiting row', { timeout: 30_000 }, async (t) => {
  const s = make(t);
  await s.start();
  const snap = JSON.parse(readFileSync(new URL('./fixtures/workers/snapshot.json', import.meta.url), 'utf8'));
  snap.parent_session_id = 'senpi:sess-A';
  snap.tasks[0].parent_session_id = 'sess-A';
  const now = new Date().toISOString();
  snap.tasks.forEach((x) => { x.updated_at = now; });
  s.events.emit(RPC, { name: 'omo.task.updated', data: snap });
  const d = await until(s.stateDir, () => {
    const rows = readData(s.stateDir).sessions[0]?.live?.workers;
    return rows && rows.some((w) => w.id === 'st_workerA') ? rows : null;
  }, 'worker row in data.js');
  const a = d.find((w) => w.id === 'st_workerA');
  assert.equal(a.state, 'running');
  assert.ok(!d.some((w) => w.id === 'st_foreign'), 'another parent is ignored');
  await s.brief(goodBrief());
  assert.ok(readData(s.stateDir).sessions[0].live.workers.some((w) => w.id === 'st_workerA'), 'brief does not erase the rows');

  await s.host.emit('tool_result', {
    toolName: 'task', isError: false, content: [{ type: 'text', text: 'started st_zzz9 running' }], details: { task_id: 'st_zzz9', status: 'running' },
  }, s.ctx);
  const rows = await until(s.stateDir, () => {
    const r = readData(s.stateDir).sessions[0]?.live?.workers;
    return r && r.some((w) => w.id === 'st_zzz9') ? r : null;
  }, 'info-waiting row');
  assert.equal(rows.find((w) => w.id === 'st_zzz9').state, 'waiting');
  assert.equal(readFileSync(join(s.stateDir, 'published.json'), 'utf8').includes('st_zzz9'), false);
});

test('plan_brief through the registered tool: revision, plan view model, open question as a decision and a waiting item', { timeout: 30_000 }, async (t) => {
  const s = make(t);
  await s.start();
  const planPath = norm(join(s.cwd, '.omo', 'plans', 'demo.md'));
  writeFileSync(planPath, PLAN_TEXT);
  const r = await s.host.tool('plan_brief').execute('c', planInput(planPath), undefined, undefined, s.ctx);
  assert.match(text(r), /^계획 r1 저장/);
  const planId = planIdOf(rootAndSlugOf(planPath).root, 'demo');
  assert.ok(existsSync(join(s.stateDir, 'plans', planId, 'rev-000001.json')));
  const vm = readData(s.stateDir);
  const plan = vm.sessions[0].plan;
  assert.equal(plan.goal, '목표');
  assert.deepEqual(plan.tasks.map((x) => [x.id, x.state]), [['1', 'todo'], ['2', 'todo']]);
  assert.equal(typeof plan.questions[0].decisionId, 'number');
  assert.ok(vm.waiting.some((w) => w.key.includes(planId) && w.key.endsWith(':Q1')), JSON.stringify(vm.waiting));
  assert.equal(vm.gen, 4);
});

// ------------------------------------------------------------------ attempt 2: B1, B2, B5

test('B1: real plan_brief -> /decide 1B -> a later valid revision claiming "answered A" still shows B (stored owner answer)', { timeout: 30_000 }, async (t) => {
  const s = make(t);
  await s.start();
  const planPath = norm(join(s.cwd, '.omo', 'plans', 'demo.md'));
  writeFileSync(planPath, PLAN_TEXT);
  await s.host.tool('plan_brief').execute('c', planInput(planPath), undefined, undefined, s.ctx);
  await s.command('decide', '1B');
  const claim = { ...planInput(planPath).questions[0], state: 'answered', answer: 'A 진행', by: 'agent' };
  const r = await s.host.tool('plan_brief').execute('c2', planInput(planPath, { questions: [claim] }), undefined, undefined, s.ctx);
  assert.match(text(r), /^계획 r2 저장/);
  const q = readData(s.stateDir).sessions[0].plan.questions[0];
  assert.deepEqual([q.state, q.by, q.option], ['answered', 'owner', 'B']);
  assert.match(q.answer, /^B /);
});

/** fs whose every call on a path naming render.lock is recorded (the pause guards must not even take the lock). */
function lockSpyFs() {
  const hits = [];
  const spy = { ...nodeFs };
  for (const [k, v] of Object.entries(nodeFs)) {
    if (typeof v === 'function') spy[k] = (...a) => { if (typeof a[0] === 'string' && /render\.lock/.test(a[0])) hits.push(k); return v(...a); };
  }
  return { fs: spy, hits };
}
/** An injected workers adapter that only hands out the extension's real softPublish callback. */
function captureSoft() {
  const box = {};
  box.create = (o) => { box.softPublish = o.softPublish; return new Proxy({}, { get: () => () => {} }); };
  return box;
}

test('B2: a soft publish queued behind an async lock wait does not publish after /brief off (neither does the publish it waits behind); no render.lock is touched after off', { timeout: 30_000 }, async (t) => {
  const { fs, hits } = lockSpyFs();
  const cap = captureSoft();
  let enter;
  const entered = new Promise((r) => { enter = r; });
  let open;
  const gate = new Promise((r) => { open = r; });
  let waits = 0;
  const sleepAsync = async () => { if (++waits === 1) { enter(); await gate; } };
  const s = make(t, { fs, extra: { createWorkersLive: cap.create, renderOpts: { sleepAsync } } });
  await s.start();
  await s.brief(goodBrief());
  const lock = join(s.stateDir, 'render.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: 'probe' }));
  const pHard = s.brief(goodBrief({ headline: '락 대기 중' }));
  await entered;
  const pSoft = cap.softPublish(); // enabled now: it queues behind the waiting publish
  await s.command('brief', 'off');
  const files = ['published.json', 'data.js', 'index.html'];
  const bytes = () => files.map((f) => readFileSync(join(s.stateDir, f), 'utf8'));
  const frozen = bytes();
  hits.length = 0;
  nodeFs.unlinkSync(lock);
  open();
  await Promise.all([pHard, pSoft]);
  assert.deepEqual(bytes(), frozen, 'published seq and bytes are unchanged');
  assert.deepEqual(hits, [], 'the paused extension never took render.lock');
});

test('B2: softPublish called while paused returns at once: no render.lock, no timer, no write', { timeout: 30_000 }, async (t) => {
  const { fs, hits } = lockSpyFs();
  const cap = captureSoft();
  const timers = fakeTimers();
  const s = make(t, { fs, timers, extra: { createWorkersLive: cap.create } });
  await s.start();
  await s.brief(goodBrief());
  await s.command('brief', 'off');
  const frozen = readFileSync(join(s.stateDir, 'published.json'), 'utf8');
  hits.length = 0;
  const created = timers.created;
  await cap.softPublish();
  assert.deepEqual(hits, []);
  assert.equal(timers.created, created);
  assert.equal(readFileSync(join(s.stateDir, 'published.json'), 'utf8'), frozen);
});

test('B5: a task snapshot before the session exists is not cloned: irrelevant getters are never read, 256 tasks x 64KiB junk take <= 5ms (max of 10), and the rows still appear', { timeout: 30_000 }, async (t) => {
  const s = make(t);
  const junk = 'x'.repeat(65_536);
  let reads = 0;
  const snapshot = () => ({
    parent_session_id: 'senpi:sess-A',
    get irrelevant() { reads++; return junk; },
    tasks: Array.from({ length: 256 }, (_, i) => ({
      task_id: `st_t${i}`, parent_session_id: 'sess-A', status: 'running', task_summary: `작업 ${i}`, updated_at: new Date().toISOString(), junk,
      get unused() { reads++; return junk; },
    })),
  });
  let max = 0;
  for (let i = 0; i < 10; i++) {
    const data = snapshot();
    const t0 = performance.now();
    s.events.emit(RPC, { name: 'omo.task.updated', data });
    max = Math.max(max, performance.now() - t0);
  }
  assert.equal(reads, 0, 'no irrelevant getter was read');
  assert.ok(max <= 5, `slowest of 10 early snapshots: ${max.toFixed(2)}ms`);
  await s.start();
  const rows = await until(s.stateDir, () => {
    const r = readData(s.stateDir).sessions[0]?.live?.workers;
    return r && r.some((w) => w.id === 'st_t0') ? r : null;
  }, 'rows from the early snapshot');
  assert.ok(rows.length >= 1);
});

// ------------------------------------------------------------------ row 17: pause state and settings reads

/** fs whose reads of settings.json fail with EACCES while ctl.deny is set (every failing read is counted). */
function settingsFaultFs(ctl) {
  return {
    ...nodeFs,
    readFileSync(p, ...a) {
      if (ctl.deny && norm(String(p)).endsWith('/settings.json')) {
        ctl.reads++;
        throw Object.assign(new Error('EACCES: injected settings'), { code: 'EACCES' });
      }
      return nodeFs.readFileSync(p, ...a);
    },
    // when a test sets ctl.metaWrites = [], every meta.json the store saves is recorded (its text, read just before the rename)
    renameSync(a, b) {
      if (ctl.metaWrites && /meta\.json$/.test(String(b))) ctl.metaWrites.push(nodeFs.readFileSync(a, 'utf8'));
      return nodeFs.renameSync(a, b);
    },
  };
}
const ERR_CHIP = '오류 있음';
const chipsOf = (stateDir) => readData(stateDir).sessions[0]?.chips ?? [];
const workerSnap = (...ids) => ({
  parent_session_id: 'senpi:sess-A',
  tasks: ids.map((id) => ({ task_id: id, parent_session_id: 'sess-A', status: 'running', task_summary: `일 ${id}`, updated_at: new Date().toISOString() })),
});
const nextMacrotask = () => new Promise((resolve) => setImmediate(resolve));
/** Stub delivery/mirror: nothing else reads the pause state in the middle of a command, so a publish is the only reader. */
const noHooks = { createDeliverer: () => ({}), createMirror: () => ({}) };
/** An older error of another source, on disk before the extension starts. */
function seedErrors(dir, errors) {
  const folder = join(dir, 'state', 'sessions', 'sess-A');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'meta.json'), JSON.stringify({ errors }));
}

test('row 17: a persistent EACCES on settings.json seen by the worker timers is recorded with its code, shows as the error chip, and the first good read clears it', { timeout: 60_000 }, async (t) => {
  const ctl = { deny: false, reads: 0 };
  const timers = fakeTimers();
  // workers-live rate-limits its publishes (2s) on its OWN clock; the fake timers never tick it, so it gets a clock the test moves
  const wl = { t: Date.now() };
  const s = make(t, { fs: settingsFaultFs(ctl), timers, extra: { workersLiveOptions: { now: () => wl.t } } });
  await s.start();
  await s.brief(goodBrief());
  assert.equal(s.meta().errors.settings, undefined);
  assert.ok(!chipsOf(s.stateDir).includes(ERR_CHIP));
  const idle = timers.pending();
  s.events.emit(RPC, { name: 'omo.task.updated', data: workerSnap('st_w1') });
  await timers.runAll(4);
  assert.ok(readData(s.stateDir).sessions[0].live.workers.some((w) => w.id === 'st_w1'), 'the worker row is published while the board is on');
  assert.ok(timers.pending() > idle, 'the worker interval exists while the board is on');

  ctl.deny = true;
  await timers.runAll(1); // the interval tick reads the pause state
  assert.ok(ctl.reads >= 1, 'the timer path read settings.json');
  assert.ok(s.meta().errors.settings, 'the failed read is recorded, not swallowed');
  assert.match(s.meta().errors.settings.message, /^settings: EACCES: injected settings/);
  assert.ok(chipsOf(s.stateDir).includes(ERR_CHIP), 'the published page shows it');
  assert.equal(timers.pending(), idle, 'unreadable = paused: the worker timers are gone');

  ctl.deny = false;
  wl.t += 5_000; // past the 2s publish rate limit of the live rows since the first flush
  s.events.emit(RPC, { name: 'omo.task.updated', data: workerSnap('st_w1', 'st_w2') });
  await nextMacrotask(); // only the resume probe has run: no timer has fired yet
  assert.equal(s.meta().errors.settings, undefined, 'the first good read clears the settings error');
  assert.ok(!chipsOf(s.stateDir).includes(ERR_CHIP), 'and the page');
  await timers.runAll(4);
  assert.ok(readData(s.stateDir).sessions[0].live.workers.some((w) => w.id === 'st_w2'), 'resumed by the event');
  assert.ok(timers.pending() > idle);
});

test('row 17: the settings error and its recovery touch only the settings key: an older error of another source stays throughout', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omo-live-'));
  seedErrors(dir, { decide: { at: 1, message: 'decide: older error' } });
  const ctl = { deny: false, reads: 0 };
  const timers = fakeTimers();
  const s = make(t, { dir, fs: settingsFaultFs(ctl), timers });
  // registered after make(): the session shutdown (which saves its meta) runs first, then the folder goes
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await s.start();
  assert.equal(s.meta().errors.decide.message, 'decide: older error');
  s.events.emit(RPC, { name: 'omo.task.updated', data: workerSnap('st_w1') });
  await timers.runAll(4);
  ctl.deny = true;
  await timers.runAll(1);
  assert.deepEqual(Object.keys(s.meta().errors).sort(), ['decide', 'settings']);
  assert.equal(s.meta().errors.decide.message, 'decide: older error');
  ctl.deny = false;
  s.events.emit(RPC, { name: 'omo.task.updated', data: workerSnap('st_w1', 'st_w2') });
  await nextMacrotask();
  assert.deepEqual(Object.keys(s.meta().errors), ['decide'], 'only the settings entry was cleared');
  assert.equal(s.meta().errors.decide.message, 'decide: older error');
});

test('row 17: the board owner finds settings.json unreadable at its own check: the specific settings error is recorded (not a server:lock one), the lock is let go, and /brief on after the fix recovers', { timeout: 60_000 }, async (t) => {
  const ctl = { deny: false, reads: 0 };
  const timers = fakeTimers();
  const s = make(t, { server: true, fs: settingsFaultFs(ctl), timers });
  await s.start();
  await s.brief(goodBrief());
  assert.equal(existsSync(join(s.stateDir, 'server.lock')), true, 'owns the server');
  ctl.metaWrites = [];
  ctl.deny = true;
  await timers.runAll(2); // the owner's periodic check
  assert.ok(ctl.reads >= 1, 'the owner check read settings.json');
  assert.ok(s.meta().errors.settings, 'recorded');
  assert.match(s.meta().errors.settings.message, /EACCES/);
  assert.equal(s.meta().errors['server:lock'], undefined, 'not misreported as a lock problem');
  // the clean lock release after the close would clear a wrong server:lock entry again, so the end state alone cannot tell: look at every save
  assert.ok(ctl.metaWrites.length > 0 && ctl.metaWrites.every((text) => !text.includes('server:lock')), 'a server:lock entry was never saved, not even for a moment');
  assert.equal(existsSync(join(s.stateDir, 'server.lock')), false, 'unknown pause state = paused: the lock is let go');
  assert.ok(chipsOf(s.stateDir).includes(ERR_CHIP));
  ctl.deny = false;
  await s.command('brief', 'on');
  assert.equal(s.meta().errors.settings, undefined);
  assert.equal(existsSync(join(s.stateDir, 'server.lock')), true, 'owns the server again');
  assert.ok(!chipsOf(s.stateDir).includes(ERR_CHIP));
});

test('row 17: a pause check inside a publish that finds settings.json unreadable is recorded once that publish returned, and a later publish that reads it fine clears it', { timeout: 60_000 }, async (t) => {
  const ctl = { deny: false, reads: 0 };
  const s = make(t, { fs: settingsFaultFs(ctl), extra: noHooks });
  await s.start();
  await s.brief(goodBrief({ decisions: [decision()] }));
  ctl.deny = true;
  await s.command('decide', '1A'); // /decide publishes without reading the pause state first
  assert.ok(ctl.reads >= 1, 'the publish read settings.json');
  assert.ok(s.meta().errors.settings, 'recorded after the publish');
  assert.ok(chipsOf(s.stateDir).includes(ERR_CHIP), 'and shown by the follow-up publish');
  ctl.deny = false;
  await s.command('decide', '1A');
  assert.equal(s.meta().errors.settings, undefined, 'a publish that reads it fine clears the entry');
  assert.ok(!chipsOf(s.stateDir).includes(ERR_CHIP));
});

test('row 17: a server host error that arrives while settings.json is unreadable is recorded next to the settings error, and its recovery clears both', { timeout: 60_000 }, async (t) => {
  const ctl = { deny: false, reads: 0 };
  const box = {};
  const base = { ensure: async () => null, status: () => ({}), onPaused: async () => {}, release: async () => {} };
  const fakeHost = new Proxy(base, { get: (target, key) => (key in target ? target[key] : typeof key === 'string' && key !== 'then' ? () => {} : undefined) });
  const s = make(t, { server: true, fs: settingsFaultFs(ctl), extra: { ...noHooks, createServerHost: (o) => { box.options = o; return fakeHost; } } });
  await s.start();
  ctl.deny = true;
  box.options.onError('server:lock', new Error('lock release failed'));
  assert.ok(s.meta().errors.settings, 'the unreadable pause state is recorded');
  assert.match(s.meta().errors['server:lock'].message, /lock release failed/, 'and the host error is not dropped');
  box.options.onRecover('server:lock'); // still unreadable
  assert.equal(s.meta().errors['server:lock'], undefined, 'a recovery is not dropped either');
  assert.ok(s.meta().errors.settings, 'the settings error stays while the file is unreadable');
  ctl.deny = false;
  box.options.onRecover('server:lock');
  assert.equal(s.meta().errors.settings, undefined, 'the good read cleared the settings error');
});

test('row 17: /brief off drops every worker timer at once, a snapshot received while off creates none and publishes nothing, /brief on arms them again and publishes it', { timeout: 60_000 }, async (t) => {
  const timers = fakeTimers();
  const wl = { t: Date.now() }; // workers-live's own clock (its 2s publish rate limit), moved by the test
  const s = make(t, { timers, extra: { workersLiveOptions: { now: () => wl.t } } });
  await s.start();
  await s.brief(goodBrief());
  const idle = timers.pending();
  s.events.emit(RPC, { name: 'omo.task.updated', data: workerSnap('st_w1') });
  await timers.runAll(4);
  assert.ok(timers.pending() > idle, 'a running worker is watched while the board is on');
  await s.command('brief', 'off');
  assert.equal(timers.pending(), idle, '/brief off: every worker timer is gone');
  const files = ['published.json', 'data.js', 'index.html'];
  const bytes = () => files.map((f) => readFileSync(join(s.stateDir, f), 'utf8'));
  const frozen = bytes();
  s.events.emit(RPC, { name: 'omo.task.updated', data: workerSnap('st_w1', 'st_w2') });
  await timers.runAll(4);
  assert.equal(timers.pending(), idle, 'a snapshot received while off creates no timer');
  assert.deepEqual(bytes(), frozen, 'and publishes nothing');
  wl.t += 5_000; // past the 2s publish rate limit of the live rows since the first flush
  await s.command('brief', 'on');
  assert.ok(timers.pending() > idle, '/brief on arms the timers for what is pending');
  await timers.runAll(4);
  assert.ok(readData(s.stateDir).sessions[0].live.workers.some((w) => w.id === 'st_w2'), 'the snapshot received while off is published once on');
});

// ------------------------------------------------------------------ row 18: a plain /brief recomputes the plan overlay first

/** fs that records the text of every data.js the store publishes (the temp file is read right before it is renamed into place). */
function dataWrites() {
  const versions = [];
  const fs = { ...nodeFs, renameSync(a, b) { if (/data\.js$/.test(String(b))) versions.push(nodeFs.readFileSync(a, 'utf8')); return nodeFs.renameSync(a, b); } };
  return { versions, fs };
}
const planStates = (vm) => vm.sessions[0].plan.tasks.map((x) => [x.id, x.state]);
const demoPlanPath = (s) => norm(join(s.cwd, '.omo', 'plans', 'demo.md'));
// the owner ticks task 1 and adds a third task that the agent's summary does not know
const PLAN_EDITED = `${PLAN_TEXT.replace('- [ ] 1.', '- [x] 1.')}- [ ] 3. 셋째\n`;

test('row 18: a plain /brief recomputes the plan status and chips before it publishes: data.js (first publication included) and the served /data.json show the plan as it is now, with no agent_settled and no plan_brief', { timeout: 60_000 }, async (t) => {
  const clock = { t: Date.now() };
  const { versions, fs } = dataWrites();
  const s = make(t, { server: true, fs, extra: { now: () => clock.t } });
  await s.start();
  const planPath = demoPlanPath(s);
  writeFileSync(planPath, PLAN_TEXT);
  await s.host.tool('plan_brief').execute('c', planInput(planPath), undefined, undefined, s.ctx);
  const planId = planIdOf(rootAndSlugOf(planPath).root, 'demo');
  const url = serverUrl(s.stateDir);
  const before = readData(s.stateDir);
  assert.deepEqual(planStates(before), [['1', 'todo'], ['2', 'todo']]);
  assert.ok(!before.sessions[0].plan.chips.includes(PLAN_CHIP_STALE));
  assert.ok(!before.sessions[0].plan.chips.includes(planChipMissing(1)));

  writeFileSync(planPath, PLAN_EDITED);
  clock.t += 30_000; // inside the 60s cache window: a plain /brief must not recompute
  await s.command('brief', '');
  assert.deepEqual(planStates(readData(s.stateDir)), [['1', 'todo'], ['2', 'todo']], 'inside 60s the cached status is kept');

  clock.t += 31_000; // 61s after the plan_brief call
  const from = versions.length;
  await s.command('brief', '');
  assert.ok(versions.length > from, '/brief published');
  assert.deepEqual(planStates(parseData(versions[from])), [['1', 'done'], ['2', 'todo']], 'the very first publication of /brief already carries the recomputed overlay');
  const fileVm = readData(s.stateDir);
  assert.deepEqual(planStates(fileVm), [['1', 'done'], ['2', 'todo']]);
  const served = JSON.parse((await get(`${url}data.json`)).body);
  assert.deepEqual(planStates(served), [['1', 'done'], ['2', 'todo']], 'the board server model');
  for (const chip of [PLAN_CHIP_STALE, planChipMissing(1)]) {
    assert.ok(fileVm.sessions[0].plan.chips.includes(chip), `data.js: ${chip}`);
    assert.ok(served.sessions[0].plan.chips.includes(chip), `/data.json: ${chip}`);
  }
  assert.deepEqual(nodeFs.readdirSync(join(s.stateDir, 'plans', planId)).filter((n) => /^rev-/.test(n)), ['rev-000001.json'], 'no new plan_brief');
  assert.equal(s.opened.at(-1), url, 'still opens the live address');
});

test('row 18 paused: a plain /brief while the board is off recomputes nothing and publishes nothing; after /brief on the next plain /brief does', { timeout: 60_000 }, async (t) => {
  const clock = { t: Date.now() };
  const s = make(t, { extra: { now: () => clock.t } });
  await s.start();
  const planPath = demoPlanPath(s);
  writeFileSync(planPath, PLAN_TEXT);
  await s.host.tool('plan_brief').execute('c', planInput(planPath), undefined, undefined, s.ctx);
  const planId = planIdOf(rootAndSlugOf(planPath).root, 'demo');
  const statusFile = join(s.stateDir, 'plans', planId, 'status.json');
  await s.command('brief', 'off');
  writeFileSync(planPath, PLAN_EDITED);
  clock.t += 61_000;
  const statusBefore = readFileSync(statusFile, 'utf8');
  const files = ['published.json', 'data.js', 'index.html'];
  const bytes = () => files.map((f) => readFileSync(join(s.stateDir, f), 'utf8'));
  const frozen = bytes();
  await s.command('brief', '');
  assert.equal(readFileSync(statusFile, 'utf8'), statusBefore, 'no status write while paused');
  assert.deepEqual(bytes(), frozen, 'nothing published while paused');
  assert.deepEqual(s.meta().planChips[planId].chips, [], 'no chip change while paused');
  await s.command('brief', 'on');
  await s.command('brief', '');
  const vm = readData(s.stateDir);
  assert.deepEqual(planStates(vm), [['1', 'done'], ['2', 'todo']]);
  assert.ok(vm.sessions[0].plan.chips.includes(PLAN_CHIP_STALE));
});

test('row 18 no plan: a plain /brief with no plan writes no plan files, records no plan error and opens the file page', { timeout: 60_000 }, async (t) => {
  const s = make(t);
  await s.start();
  await s.command('brief', '');
  assert.equal(existsSync(join(s.stateDir, 'plans')), false, 'no plan folder appeared');
  assert.deepEqual(s.meta().errors ?? {}, {});
  assert.equal(norm(s.opened.at(-1)), norm(join(s.stateDir, 'index.html')));
});

// ------------------------------------------------------------------ row 19: the board address file (server.json) is read within bounds

const GOOD_SERVER_JSON = () => JSON.stringify({ pid: process.pid, port: 47999, generation: 4 });

test('row 19: an over-limit server.json seen by the real publish is recorded as server:record with the refused size and shown; nothing is recorded while the board is off; a valid record clears it', { timeout: 60_000 }, async (t) => {
  const s = make(t);
  await s.start();
  await s.brief(goodBrief());
  const file = join(s.stateDir, 'server.json');
  assert.equal(s.meta().errors['server:record'], undefined);
  const big = JSON.stringify({ pid: process.pid, port: 47999, generation: 4, pad: 'x'.repeat(40_000) });
  writeFileSync(file, big);
  await s.command('brief', 'off');
  await s.command('brief', ''); // paused: the publish is refused, so nothing may be recorded
  assert.equal(s.meta().errors['server:record'], undefined, 'nothing recorded while the board is off');
  await s.command('brief', 'on'); // publishes: the read of server.json is refused
  const recorded = s.meta().errors['server:record'];
  assert.ok(recorded, 'recorded');
  assert.ok(recorded.message.includes(String(Buffer.byteLength(big))), 'with the size that was refused');
  assert.ok(readData(s.stateDir).readErrors.includes('server.json'));
  assert.ok(chipsOf(s.stateDir).includes(ERR_CHIP), 'shown by the follow-up publish');
  writeFileSync(file, GOOD_SERVER_JSON());
  await s.brief(goodBrief({ headline: '복구 뒤' }));
  assert.equal(s.meta().errors['server:record'], undefined, 'a valid record clears it');
  assert.ok(!readData(s.stateDir).readErrors.includes('server.json'));
  assert.ok(!chipsOf(s.stateDir).includes(ERR_CHIP));
});

test('row 19: the board server model (/data.json) refuses a size-only over-limit server.json unread, lists it in readErrors with the chip in the same response, records it, and a valid record recovers', { timeout: 60_000 }, async (t) => {
  const s = make(t, { server: true });
  await s.start();
  await s.brief(goodBrief());
  const url = serverUrl(s.stateDir);
  const file = join(s.stateDir, 'server.json');
  const original = readFileSync(file, 'utf8');
  const model = async () => JSON.parse((await get(`${url}data.json`)).body);
  assert.ok(!(await model()).readErrors.includes('server.json'));
  const size = 64 * 1024 * 1024;
  writeFileSync(file, '');
  nodeFs.truncateSync(file, size); // big in size only: reading it would cost 64 MiB
  const bad = await model();
  assert.ok(bad.readErrors.includes('server.json'), 'listed in readErrors');
  assert.ok(bad.sessions[0].chips.includes(ERR_CHIP), 'the chip is in the very same response');
  assert.ok(s.meta().errors['server:record'].message.includes(String(size)), 'recorded with the refused size');
  writeFileSync(file, original);
  const healed = await model();
  assert.ok(!healed.readErrors.includes('server.json'));
  assert.ok(!healed.sessions[0].chips.includes(ERR_CHIP));
  assert.equal(s.meta().errors['server:record'], undefined);
});

test('board link: with a live board server the owner is handed the live board url (brief result and the trimmed final reply), not the file path', { timeout: 60_000 }, async (t) => {
  const URL = 'http://127.0.0.1:47999/';
  const base = { ensure: async () => ({ url: URL }), status: () => ({ role: 'client', url: URL }), onPaused: async () => {}, release: async () => {} };
  const fakeHost = new Proxy(base, { get: (target, key) => (key in target ? target[key] : typeof key === 'string' && key !== 'then' ? () => {} : undefined) });
  const s = make(t, { server: true, extra: { ...noHooks, createServerHost: () => fakeHost } });
  await s.start();
  const r = await s.brief(goodBrief());
  assert.match(text(r), new RegExp(`^상황판 갱신됨: ${URL.replace(/[.]/g, '\\.')}`));
  await s.host.emit('agent_start', {}, s.ctx);
  await s.host.emit('tool_result', { toolName: 'bash', content: [], isError: false }, s.ctx);
  const ok = await s.host.emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: `끝\n상황판: ${URL}` }] } }, s.ctx);
  assert.ok(ok.every((x) => x === undefined), 'a reply that ends with the live url is left alone');
  const long = Array.from({ length: 15 }, (_, i) => `줄 ${i + 1}`).join('\n');
  const out = (await s.host.emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: long }] } }, s.ctx)).filter(Boolean);
  assert.equal(out.length, 1);
  assert.equal(out[0].message.content[0].text.split('\n').at(-1), `상황판: ${URL}`);
});
