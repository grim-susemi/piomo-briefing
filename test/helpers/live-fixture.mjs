// Shared real-I/O fixtures for the deterministic live tests and their original timing backstops.
import * as nodeFs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createBriefingExtension } from '../../extension.mjs';
import { makeFakePi, makeCtx } from './fake-pi.mjs';

const HOLDER = fileURLToPath(new URL('./lock-holder.mjs', import.meta.url));
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
  let closing = false;
  const pending = new Map();
  const t = {
    created: 0,
    setTimeout(fn, ...args) { t.created++; if (closing) return globalThis.setTimeout(fn, ...args); const h = { id: ++n, unref() {} }; pending.set(h, { fn, once: true }); return h; },
    clearTimeout(h) { if (!pending.delete(h)) globalThis.clearTimeout(h); },
    setInterval(fn, ...args) { t.created++; if (closing) return globalThis.setInterval(fn, ...args); const h = { id: ++n, unref() {} }; pending.set(h, { fn, once: false }); return h; },
    clearInterval(h) { if (!pending.delete(h)) globalThis.clearInterval(h); },
    // Teardown must settle normally, including a new awaited timer, without driving live worker intervals.
    beginShutdown() { closing = true; },
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

const fixtureDirs = new WeakMap();

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
  const shutdown = async () => {
    if (!down) {
      down = true;
      timers?.beginShutdown?.();
      await host.emit('session_shutdown', {}, ctx);
    }
  };
  let dirs = fixtureDirs.get(t);
  if (!dirs) { dirs = new Map(); fixtureDirs.set(t, dirs); }
  if (!dirs.has(dir)) {
    const sessions = new Set();
    dirs.set(dir, sessions);
    t.after(async () => {
      const results = await Promise.allSettled([...sessions].map((stop) => stop()));
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;
    });
  }
  dirs.get(dir).add(shutdown);
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
  // This child also bounds itself if the test process loses its cleanup path.
  const guard = 'data:text/javascript,setTimeout(() => process.exit(124), 60000).unref();';
  const child = fork(HOLDER, [stateDir, String(holdMs)], { execArgv: ['--import', guard], timeout: 60_000 });
  const closed = new Promise((r) => child.once('close', (code, signal) => { t.diagnostic('holder exit pid=' + child.pid + ' code=' + code + ' signal=' + signal); r(); }));
  t.diagnostic('holder start pid=' + child.pid + ' path=' + HOLDER);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  let released;
  const releasedP = new Promise((r) => { released = r; });
  child.on('message', (m) => { if (m && m.type === 'released') released(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock holder did not report held')), 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('message', (m) => {
      if (m && m.type === 'held') {
        clearTimeout(timer);
        resolve({ released: releasedP, release: () => { if (child.connected) child.send({ cmd: 'release' }); } });
      }
    });
  });
}

function lagProbe(every = 20) {
  let last = performance.now();
  let max = 0;
  const h = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last - every); last = n; }, every);
  return { stop: () => clearInterval(h), max: () => max };
}


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

export { HOLDER, RPC, REGISTRY, nextBase, norm, text, goodBrief, decision, PLAN_TEXT, planInput, makeBus, fakeTimers, make, seqOf, parseData, readData, serverUrl, until, get, sse, startHolder, lagProbe, settingsFaultFs, ERR_CHIP, chipsOf, workerSnap, nextMacrotask, noHooks, seedErrors };
