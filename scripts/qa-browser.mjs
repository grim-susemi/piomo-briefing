// Real-browser acceptance run of the board (generation 4; todo 13, reworked for the rail / sidebar / tab-bar shell by todo 9).
// No dependencies: Chrome DevTools Protocol through scripts/cdp.mjs; the real extension in separate processes (this script
// forked with --lead: the extension on a fake pi host whose fake pi.session admits a delivery and then, as SENPI does for an
// idle conversation, writes its transcript entry and ends that message, so the extension's own proof path writes the
// receipt); the real board server host; the real store. Everything lives in an owned temp folder; ports
// OMO_BRIEFING_PORT_BASE (default 47400) .. +9, refused when they touch the live board's 47317-47326; one headless Chrome at
// a time with an owned temp profile, closed by identity (cdp.mjs close() kills that profile's process tree); at the end every
// process, profile, server and folder it made is checked gone.
//
// usage: node scripts/qa-browser.mjs --out <dir>
//   <dir>/result.json        per scenario pass/fail with the measured values; every Chrome pid of both runs (all processes of
//                            its profile) with its state after close; what each lead's session admitted and proved
//   <dir>/render-p95.json    20 renderPage runs on a store built through the real store API
//   <dir>/{desktop,mobile}-{board,plan,workers,alarm}.png   1440x900 and 390x844
//   <dir>/desktop-{state,annotation-sent,report-pick,file-page}.png, <dir>/mobile-<scenario>-*.png
// Desktop scenarios (1440x900, autoplay allowed):
//   a  20 publications reach the page without a click, p95 <= 1500 ms
//   b  20 publications keep the active tab, the shown and a remembered sub-tab, the sidebar view, its scroll and search text,
//      the #main anchor (content grows above it), an opened section, 2 pending annotations and a reply draft
//   c  a text selection in #main holds the update (badge) and its release applies within 300 ms
//   d  worker rows: pulse, the finished row sinks with a 350 ms move, nothing moves under reduced motion; a conversation that
//      finishes leaves the sidebar's 진행 중 filter and is listed under 끝남
//   e  alarm band, title and one chime per update; none on first load, while muted in 설정, or after a reload
//   f  계획: the box plan folds to <= 2 summary lines without anchors; opened it has every anchor exactly once
//   annotation-delivered  tray 보내기 -> answers/a-<uuid>.json -> admitted to that conversation and proven by its session
//                         (receipt proven:true) -> 보낸 피드백 shows 전달됨
//   pick-writes-answer    보고서 이걸로 고르기 -> 보내기 writes answers/<id>.json; the report then shows 답함
//   legacy-501-bad-text   POST /answer {id, sessionId, text} of 501 characters -> 400 BAD_TEXT, nothing stored (500 is stored)
//   forged-origin-403     an annotation POST with a forged Origin -> 403 FORBIDDEN_ORIGIN, nothing stored (the same request
//                         with the board's own Origin is stored)
//   unknown-asset-404     GET /assets/<unknown sha>.png -> 404; a referenced report image -> 200 with nosniff
//   i  GET / is generation 4 and the SSE model carries plan and live even with old-shape files in STATE
//   g  owner killed: 연결 끊김, the other conversation takes the server over, the page reconnects
//   h  the file:// page applies a publication within 2.5 s and offers the live link
//   file-no-send  the file:// page has no send: Markdown 복사 only, no write token, no answer buttons
//   j  /brief off: 브리핑 꺼짐
//   k  no console error or page exception in any run, no failure inside a lead's fake host
// 390x844 run (default autoplay policy; connected before each trigger; script clicks only until e-blocked's one tap):
//   m-fit, f-mobile, plan-fold-mobile, c-mobile, d-mobile, e-blocked, e-mobile, g-mobile (captures mobile-<scenario>-*.png)
// Waits are events with a bound: in-page promises (MutationObserver, apply hook, toggle), IPC replies, fs.watch.
// Cleanup also audits Chrome's own chrome_* folders in the temp root that were created by the QA browser pids.
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync, copyFileSync, watch } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, isPidAlive, listProfilePids } from './cdp.mjs';
import { openStore } from '../src/store.mjs';
import { renderPage } from '../src/render.mjs';

const SELF = fileURLToPath(import.meta.url);
const LEAD_FLAG = '--lead';
const J = JSON.stringify;

// ------------------------------------------------------------------ lead mode: this script forked as one lead conversation

// One lead conversation = the real extension on a fake pi host with a real board server host, driven over IPC:
// {id, cmd, ...} -> {id, result|error}. argv after --lead: stateDir sessionId cwd portBase.
// pi.session is test/helpers/fake-session.mjs (SENPI's ExternalAdmission contract). For an admission that starts a turn the
// host then does what SENPI does for an idle conversation: the followUp's transcript entry is written (the ledger lists the
// id as emitted) and that message ends (message_end with the custom_message), which wakes the extension's deliverer; the
// receipt is the extension's own doing. 'deliveries' reports every admission, the ledger and any failure of this fake host.
async function leadMain([stateDir, sid, cwd, base]) {
  const { createBriefingExtension } = await import('../extension.mjs');
  const { makeFakePi, makeCtx } = await import('../test/helpers/fake-pi.mjs');
  const { makeFakeSession } = await import('../test/helpers/fake-session.mjs');
  const RPC = 'senpi:extension-rpc-event';
  const listeners = new Set();
  const host = makeFakePi({ cwd });
  host.pi.events = { on(channel, fn) { if (channel === RPC) listeners.add(fn); return () => listeners.delete(fn); } };
  const { ctx } = makeCtx({ cwd, sid, file: `C:/sessions/${sid}.jsonl` });
  const session = makeFakeSession();
  const failures = [];
  const admit = session.admitExternalMessage;
  session.admitExternalMessage = (input) => {
    const res = admit(input);
    if (res && res.kind === 'started') {
      setImmediate(() => {
        session.emit(input.delivery_id);
        const message = {
          role: 'custom', customType: 'session_control_delivery', content: [{ type: 'text', text: input.text }], display: true,
          details: { delivery_id: input.delivery_id, source: 'session_control', deliverAs: input.deliverAs },
        };
        host.emit('message_end', { message }, ctx).catch((err) => failures.push(`message_end ${input.delivery_id}: ${(err && err.stack) || err}`));
      });
    }
    return res;
  };
  host.pi.session = session;
  const opened = [];
  createBriefingExtension({
    stateDir,
    env: { PATH: process.env.PATH, HERDR_BIN_PATH: '', OMO_BRIEFING_PORT_BASE: base },
    server: true,
    generation: 4,
    openPage: (p) => { opened.push(p); return { launcher: 'chrome', command: 'qa', args: [] }; },
  })(host.pi);
  const textOf = (r) => r.content.map((b) => b.text).join('\n');
  const handlers = {
    start: async () => { await host.emit('session_start', { reason: 'startup' }, ctx); return { pid: process.pid }; },
    brief: async (m) => textOf(await host.tool('brief').execute('qa', m.input, undefined, undefined, ctx)),
    plan: async (m) => textOf(await host.tool('plan_brief').execute('qa', m.input, undefined, undefined, ctx)),
    rpc: async (m) => { for (const fn of [...listeners]) fn({ name: 'omo.task.updated', data: m.data }); return true; },
    command: async (m) => { await host.commands.get(m.name).handler(m.args ?? '', ctx); return opened.at(-1) ?? null; },
    deliveries: async () => ({
      admitted: session.calls.map((c) => ({ delivery_id: c.delivery_id, sender: c.sender, deliverAs: c.deliverAs, text: c.text })),
      ledger: session.listAdmittedDeliveries(),
      failures: [...failures],
    }),
    shutdown: async () => { await host.emit('session_shutdown', {}, ctx); return true; },
  };
  process.on('message', async (m) => {
    try {
      const result = await handlers[m.cmd](m);
      process.send({ id: m.id, result });
    } catch (err) {
      process.send({ id: m.id, error: String((err && err.stack) || err) });
    }
  });
  process.on('disconnect', () => process.exit(0));
  process.send({ ready: true, pid: process.pid });
  await new Promise(() => {}); // the IPC channel and the board server keep this process alive; 'disconnect' or a kill ends it
}
if (process.argv[2] === LEAD_FLAG) await leadMain(process.argv.slice(3));

// ------------------------------------------------------------------ the QA run

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLAN_FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/view-model-plan.json'), 'utf8'));
const IMAGE_FIXTURES = path.join(ROOT, 'test/fixtures/board-assets');
const NO_AUTOPLAY_FLAG = '--autoplay-policy=no-user-gesture-required';
const PORTS = 10;
const LIVE_BOARD = [47317, 47326]; // the owner's live board: never touched
const BASE = Number(process.env.OMO_BRIEFING_PORT_BASE || 47400);
if (!Number.isInteger(BASE) || BASE < 1024 || BASE + PORTS - 1 > 65535 || (BASE <= LIVE_BOARD[1] && BASE + PORTS - 1 >= LIVE_BOARD[0])) {
  console.error(`OMO_BRIEFING_PORT_BASE=${process.env.OMO_BRIEFING_PORT_BASE}: needs ${PORTS} ports in 1024-65535 outside the live board's ${LIVE_BOARD.join('-')}`);
  process.exit(2);
}

const outIdx = process.argv.indexOf('--out');
if (outIdx < 0 || !process.argv[outIdx + 1]) {
  console.error('usage: node scripts/qa-browser.mjs --out <dir>');
  process.exit(2);
}
const OUT = path.resolve(process.argv[outIdx + 1]);
mkdirSync(OUT, { recursive: true });

const results = {};
let expectDisconnect = false;
let phase = 'run'; // 'teardown' once scenario k has judged the run: shutting the servers down cuts the streams again
const expectedNetwork = [];
const teardownNetwork = [];
const owned = { pids: [], profiles: [], tempDirs: [] };
const consoleErrors = [];
const chromeRuns = []; // one per browser: {label, browserPid, profileDir, pids (every process of the profile seen), aliveAfterClose}
const leadReports = {}; // sessionId -> what its fake host admitted and proved (read before the process is killed or shut down)
// The page the running scenarios use. Every scenario result carries the viewport name and the page's measured innerWidth/innerHeight;
// a run with `expect` (the 390x844 one) fails the scenario when the page is not that size.
let activeView = null; // { name, page, expect: { width, height } | null }
const measureViewport = async (view) => {
  if (!view) return null;
  const measured = await view.page.eval('({ innerWidth, innerHeight, devicePixelRatio })');
  if (view.expect) {
    assert.equal(measured.innerWidth, view.expect.width, `viewport width ${measured.innerWidth}, expected ${view.expect.width}`);
    assert.equal(measured.innerHeight, view.expect.height, `viewport height ${measured.innerHeight}, expected ${view.expect.height}`);
  }
  return measured;
};
const scenario = async (id, title, fn) => {
  const viewport = activeView ? activeView.name : 'whole run';
  try {
    const viewportMeasured = await measureViewport(activeView);
    results[id] = { title, pass: true, viewport, viewportMeasured, ...(await fn()) };
    console.log(`PASS (${id}) ${title}`);
  } catch (err) {
    results[id] = { title, pass: false, viewport, error: String((err && err.message) || err) };
    console.error(`FAIL (${id}) ${title}: ${(err && err.message) || err}`);
  }
};
const p95Of = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const pad6 = (n) => String(n).padStart(6, '0');
const MAX_JSON_BYTES = 4 * 1024 * 1024;
// A missing file throws ENOENT from statSync (absent), an unreadable one throws its own code, an oversized one is refused before it is read.
const readJson = (p) => {
  const size = statSync(p).size;
  if (size > MAX_JSON_BYTES) throw new Error(`${p} is ${size} bytes, over the ${MAX_JSON_BYTES} byte limit`);
  return JSON.parse(readFileSync(p, 'utf8'));
};
// A wait subscribed before its trigger: if the scenario fails before awaiting it, its later rejection is not an unhandled one.
const pending = (promise) => { promise.catch(() => {}); return promise; };

// Chrome's own scratch folders in the temp root, e.g. chrome_chrome_url_fetcher_<browser pid>_<n>: made by the browser process, so
// the name carries its pid. cleanup() removes the ones made by the QA browsers and reports them.
const TMP_ROOT = os.tmpdir();
const CHROME_TEMP_RE = /^chrome_.*_(\d+)_\d+$/;
const chromeTempNames = () => readdirSync(TMP_ROOT).filter((n) => n.startsWith('chrome_'));
let chromeTempBefore = null; // names present before the first QA browser started

// ------------------------------------------------------------------ pieces: files, http, leads, store seeding

// Errors that mean "the file is not there yet / is being replaced right now"; anything else is a real failure and rejects.
const NOT_YET = new Set(['ENOENT', 'EBUSY', 'EPERM', 'EACCES']);
function until(dir, pred, label, ms = 15_000, { recursive = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher = null;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      fn(value);
    };
    timer = setTimeout(() => finish(reject, new Error(`timeout waiting for ${label}`)), ms);
    const check = () => {
      let v = null;
      try { v = pred(); } catch (err) {
        if (!(err instanceof SyntaxError || NOT_YET.has(err.code))) { finish(reject, err); return; }
      }
      if (v) finish(resolve, v);
    };
    watcher = watch(dir, { recursive }, check);
    watcher.on('error', (err) => finish(reject, err));
    check();
  });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get({ host: '127.0.0.1', port: u.port, path: u.pathname, agent: false, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: bytes.toString('utf8'), bytes });
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error(`GET ${url} had no answer in 8s`)));
    req.on('error', reject);
  });
}

function httpPost(url, { headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(J(body));
    const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST', agent: false, headers: { 'Content-Length': data.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error(`POST ${url} had no answer in 8s`)));
    req.on('error', reject);
    req.end(data);
  });
}
// the headers a same-origin board page sends with a write (the Origin is the variable under test)
const writeHeaders = (token, origin) => ({ 'Sec-Fetch-Site': 'same-origin', Origin: origin, 'Content-Type': 'application/json', 'X-Board-Token': token });

function firstSseFrame(url, ms = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let req = null;
    const timer = setTimeout(() => { req.destroy(); reject(new Error('no SSE data frame')); }, ms);
    req = http.get({ host: '127.0.0.1', port: u.port, path: '/events', agent: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        const m = /event: data\ndata: (.*)\n\n/.exec(buf);
        if (m) { clearTimeout(timer); req.destroy(); resolve(JSON.parse(m[1])); }
      });
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
  });
}

function spawnLead(sid, state, cwd) {
  const child = fork(SELF, [LEAD_FLAG, state, sid, cwd, String(BASE)], { execArgv: [], windowsHide: true });
  owned.pids.push(child.pid);
  let seq = 0;
  const waiting = new Map();
  const ready = new Promise((resolve, reject) => {
    child.once('message', (m) => (m.ready ? resolve(m) : reject(new Error('unexpected first message'))));
    child.once('error', reject);
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.on('message', (m) => {
    const p = m.id && waiting.get(m.id);
    if (!p) return;
    waiting.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  child.on('exit', () => { for (const p of waiting.values()) p.reject(new Error(`lead ${sid} exited`)); waiting.clear(); });
  const call = (cmd, extra = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`lead ${sid} ${cmd}: no reply in 60s`)); }, 60_000);
    waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.send({ id, cmd, ...extra });
  });
  return { sid, child, ready, closed, call, pid: child.pid, alive: () => child.exitCode === null && child.signalCode === null };
}

const briefOf = (title, headline, over = {}) => ({ title, status: 'in_progress', headline, changes: [], done: [], next: '', decisions: [], ...over });
const decisionOf = (question) => ({
  question,
  options: { A: { text: '진행', consequence: '계속한다' }, B: { text: '보류', consequence: '멈춘다' } },
  recommend: 'A', reason: '빠르게 끝난다', blocks: true,
});

const ARCHIVE_SEEDS = 30; // closed conversations named "보관 작업 nn": the 닫힌 창 list is long enough to scroll
function seedBoard(store, now) {
  const projects = ['alpha-app', 'beta-site', 'gamma-tool'];
  for (let i = 0; i < 9; i++) {
    const sid = `seed-${i}`;
    const at = now - (i + 2) * 90_000;
    const title = `${projects[i % 3]} 작업 ${i + 1}`;
    store.replace(`sessions/${sid}/meta.json`, { sessionId: sid, cwd: `C:/work/${projects[i % 3]}`, title, paneId: `pane-${i}`, lastActivityAt: at, lastBriefAt: at, workerIds: [], workers: [] });
    store.writeNew(`sessions/${sid}/briefs/000001.json`, {
      at,
      brief: briefOf(title, `${i + 1}번째 작업이 진행 중입니다`, {
        next: i % 2 ? '다음 단계로 넘어간다' : '',
        changes: i % 2 ? [{ text: '화면 배치를 고침', truth: 'reported', applied: 'candidate' }] : [],
      }),
    });
  }
  for (let i = 0; i < ARCHIVE_SEEDS; i++) {
    const sid = `seed-archive-${pad6(i + 1).slice(-2)}`;
    const at = now - (i + 20) * 60_000;
    const title = `보관 작업 ${pad6(i + 1).slice(-2)}`;
    store.replace(`sessions/${sid}/meta.json`, { sessionId: sid, cwd: 'C:/work/archive', title, paneId: '', lastActivityAt: at, lastBriefAt: at, workerIds: [], workers: [] });
    store.writeNew(`sessions/${sid}/briefs/000001.json`, { at, brief: briefOf(title, '보관된 대화') });
  }
  // one conversation that is already waiting for an answer when the page is first opened
  const at = now - 30_000;
  store.replace('sessions/seed-wait/meta.json', { sessionId: 'seed-wait', cwd: 'C:/work/alpha-app', title: '먼저 기다리는 대화', paneId: 'pane-w', lastActivityAt: at, lastBriefAt: at, workerIds: [], workers: [] });
  store.writeNew('sessions/seed-wait/briefs/000001.json', { at, brief: briefOf('먼저 기다리는 대화', '결정을 기다립니다', { status: 'needs_decision' }) });
  store.allocDecisionId({ sessionId: 'seed-wait', ...decisionOf('먼저 와 있던 질문'), createdAt: at, source: 'brief' });
}

// ------------------------------------------------------------------ render p95 on a store of realistic size

function renderP95() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'omo-qa-p95-'));
  owned.tempDirs.push(dir);
  const store = openStore(path.join(dir, 'state'));
  const now = Date.now();
  const sessions = 24;
  const workersPer = 4;
  const todosPer = 12;
  for (let s = 0; s < sessions; s++) {
    const sid = `p95-${s}`;
    const at = now - (s + 1) * 60_000;
    const workers = Array.from({ length: workersPer }, (_, w) => ({
      id: `st_${s}_${w}`, name: `작업자 ${w}`, kind: 'implementation', model: 'Sol 6.1', state: w === 0 ? 'running' : 'done', step: '읽는 중',
      startedAt: at - 60_000, endedAt: w === 0 ? undefined : at, updatedAt: at,
      todo: { items: Array.from({ length: todosPer }, (_, k) => ({ text: `할 일 ${k + 1}`, status: k < 6 ? 'completed' : 'pending' })), total: todosPer, done: 6, more: 0 },
    }));
    store.replace(`sessions/${sid}/meta.json`, { sessionId: sid, cwd: `C:/work/p${s % 5}`, title: `대화 ${s}`, lastActivityAt: at, lastBriefAt: at, auto: { live: { workers } } });
    store.writeNew(`sessions/${sid}/briefs/000001.json`, { at, brief: briefOf(`대화 ${s}`, `대화 ${s} 진행`, { changes: [{ text: '고침', truth: 'reported', applied: 'candidate' }], decisions: [] }) });
    for (let d = 0; d < 2; d++) store.allocDecisionId({ sessionId: sid, ...decisionOf(`질문 ${s}-${d}`), createdAt: at, source: 'brief' });
    if (s < 3) {
      const planId = `p${String(s).padStart(12, '0')}`;
      store.writePlanRev(planId, {
        schema: 'omo-plan/1', planId, at, ownerSessionId: sid, source: { root: 'c:/p', slug: `plan-${s}`, planPath: `C:/p/.omo/plans/plan-${s}.md` },
        plan: { stage: 'running', goal: '목표', ideal: PLAN_FIXTURE.ideal, components: PLAN_FIXTURE.components, waves: PLAN_FIXTURE.waves, tasks: PLAN_FIXTURE.tasks.map(({ state, ...t }) => t), questions: [], outOfScope: [] },
      });
    }
  }
  renderPage(store, now, { generation: 4 }); // warm up the file system caches like a running board
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const res = renderPage(store, now + i, { generation: 4 });
    times.push(performance.now() - t0);
    if (!res.ok) throw new Error(`render failed: ${res.error}`);
  }
  const rounded = times.map((x) => Math.round(x * 100) / 100);
  const p95 = p95Of(times);
  const doc = {
    kind: 'synthetic store built with the real store API (no copy of the live STATE was available or authorized for this run)',
    sessions, workersPerSession: workersPer, todosPerWorker: todosPer, decisions: sessions * 2, plans: 3, runs: 20,
    timesMs: rounded, medianMs: Math.round([...times].sort((a, b) => a - b)[10] * 100) / 100, p95Ms: Math.round(p95 * 100) / 100,
    maxMs: Math.round(Math.max(...times) * 100) / 100, limitMs: 150, pass: p95 <= 150,
    dataJsBytes: Buffer.byteLength(store.readText('data.js')),
  };
  writeFileSync(path.join(OUT, 'render-p95.json'), JSON.stringify(doc, null, 2));
  return doc;
}

// ------------------------------------------------------------------ in-page helpers

const INIT_SCRIPT = `(() => {
  const W = window;
  W.__errors = [];
  const origError = console.error;
  console.error = function (...a) { W.__errors.push('console.error: ' + a.map(String).join(' ')); return origError.apply(this, a); };
  W.addEventListener('error', (e) => W.__errors.push('error: ' + (e.message || e)));
  W.addEventListener('unhandledrejection', (e) => W.__errors.push('rejection: ' + e.reason));
  W.__audio = { contexts: [], starts: 0, resumes: [] };
  const Orig = W.AudioContext;
  if (Orig) {
    W.AudioContext = function (...a) {
      const c = new Orig(...a);
      W.__audio.contexts.push(c);
      const resume = c.resume.bind(c);
      c.resume = (...args) => { const p = resume(...args); W.__audio.resumes.push(p); return p; };
      const make = c.createOscillator.bind(c);
      c.createOscillator = function () {
        const o = make();
        const start = o.start.bind(o);
        o.start = function (...b) { W.__audio.starts++; return start(...b); };
        return o;
      };
      return c;
    };
    W.AudioContext.prototype = Orig.prototype;
  }
  W.__applied = {};
  W.__waiters = [];
  // registered before page.js starts (same DOMContentLoaded event, earlier listener), so it sees the very first apply too
  document.addEventListener('DOMContentLoaded', () => {
    if (!W.BriefPage) { W.__errors.push('BriefPage missing'); return; }
    W.BriefPage.hooks.afterApply.push((model) => {
      const t = Date.now();
      W.__applied[model.seq] = t;
      const keep = [];
      for (const w of W.__waiters) { if (w.seq <= model.seq) w.fn(t); else keep.push(w); }
      W.__waiters = keep;
    });
  });
})();`;

// Resolves with the time the page showed seq (or, when publications were merged, the first applied seq at or after it).
const waitApplied = (page, seq, ms = 12_000) => page.eval(`new Promise((resolve, reject) => {
  const seq = ${seq};
  const hit = Object.keys(window.__applied).map(Number).filter((s) => s >= seq).sort((a, b) => a - b)[0];
  if (hit !== undefined) return resolve(window.__applied[hit]);
  window.__waiters.push({ seq, fn: resolve });
  setTimeout(() => reject(new Error('seq ' + seq + ' was never applied; applied=' + Object.keys(window.__applied).slice(-3))), ${ms});
})`);

const waitStatus = (page, { includes, hidden = false, ms = 14_000 }) => page.eval(`new Promise((resolve, reject) => {
  const el = document.getElementById('live-status');
  const ok = () => ${hidden ? '(el.hidden || !el.textContent)' : `(!el.hidden && el.textContent.includes(${J(includes ?? '')}))`};
  if (ok()) return resolve(el.textContent);
  const mo = new MutationObserver(() => { if (ok()) { mo.disconnect(); clearTimeout(timer); resolve(el.textContent); } });
  mo.observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
  const timer = setTimeout(() => { mo.disconnect(); reject(new Error('status wait timed out: [' + el.textContent + '] hidden=' + el.hidden)); }, ${ms});
})`);

// Resolves with the first truthy value of a page expression. It is checked now and again after every DOM mutation anywhere in the
// document (band, title, status, regions); it rejects at the deadline. The deadline stays under cdp.mjs's 15 s call limit.
const waitDom = (page, expr, { label, ms = 14_000 }) => page.eval(`new Promise((resolve, reject) => {
  let timer = null;
  let mo = null;
  const end = () => { clearTimeout(timer); mo.disconnect(); };
  const check = () => {
    let v;
    try { v = (${expr}); } catch (e) { end(); reject(e); return; }
    if (v) { end(); resolve(v); }
  };
  mo = new MutationObserver(check);
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  timer = setTimeout(() => { end(); reject(new Error(${J(`timed out waiting for ${label}`)})); }, ${ms});
  check();
})`);

const frames = (page, n = 2) => page.eval(`new Promise((resolve) => { let k = ${n}; const step = () => (k-- <= 0 ? resolve(true) : requestAnimationFrame(step)); step(); })`);

// ---- real input (CDP): a mouse event or a key is a user gesture (the 390x844 run uses none before e-blocked)
const CTRL = 2;
async function mouse(page, type, x, y, o = {}) {
  await page.client.send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: o.button || (type === 'mouseMoved' ? 'none' : 'left'),
    buttons: o.buttons || 0, clickCount: o.clickCount || 0, modifiers: o.modifiers || 0,
  });
}
async function clickAt(page, x, y) {
  await mouse(page, 'mouseMoved', x, y);
  await mouse(page, 'mousePressed', x, y, { buttons: 1, clickCount: 1 });
  await mouse(page, 'mouseReleased', x, y, { clickCount: 1 });
}
// A point inside the first element matching selector, after scrolling it to the middle of its scroller; `inside` says whether the
// mouse would really land on it there (nothing covers it).
async function point(page, selector, { fx = 0.5, fy = 0.5, scroll = true } = {}) {
  const p = await page.eval(`(() => {
    const el = document.querySelector(${J(selector)});
    if (!el) return null;
    ${scroll ? "el.scrollIntoView({ block: 'center', inline: 'nearest' });" : ''}
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * ${fx}, y = r.top + r.height * ${fy};
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: r.width, h: r.height, inside: !!hit && (hit === el || el.contains(hit)), hit: hit ? hit.tagName.toLowerCase() + '.' + [...hit.classList].join('.') : null };
  })()`);
  if (!p || !(p.w > 0 && p.h > 0)) throw new Error(`nothing visible matches ${selector}`);
  return p;
}
async function click(page, selector, o) {
  const p = await point(page, selector, o);
  if (!p.inside) throw new Error(`a click on ${selector} would land on ${p.hit}`);
  await clickAt(page, p.x, p.y);
}
async function hover(page, selector, o) {
  const p = await point(page, selector, o);
  await mouse(page, 'mouseMoved', p.x, p.y);
  await frames(page);
  return p;
}
async function key(page, name, code, vk, modifiers = 0) {
  await page.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}
const typeText = (page, text) => page.client.send('Input.insertText', { text });

// element.click() from script carries no user activation (unlike the CDP mouse events of click()), so the autoplay policy stays untouched
const jsClick = (page, selector) => page.eval(`(() => { const el = document.querySelector(${J(selector)}); if (!el) throw new Error('nothing matches ' + ${J(selector)}); el.click(); return true; })()`);

// A conversation page shown through the page's own controller (no gesture), checked on screen.
async function showPage(page, sid, sub) {
  await page.eval(`(BriefPage.open(${J(sid)}, ${J(sub)}), true)`);
  const shown = await page.eval(`(() => { const p = document.querySelector('#main .cv-page'); return p ? p.getAttribute('data-sid') + '/' + p.getAttribute('data-sub') : null; })()`);
  if (shown !== `${sid}/${sub}`) throw new Error(`${sid}/${sub} is not shown: ${shown}`);
}
const shownPage = (page) => page.eval(`(() => { const p = document.querySelector('#main .cv-page'); return p ? p.getAttribute('data-sid') + '/' + p.getAttribute('data-sub') : null; })()`);
const scrollMainTop = (page) => page.eval(`(document.getElementById('main').scrollTop = 0, true)`);
// The sidebar search, set from script (the input event the shell listens to), then left: its value must come from the state.
const setSearch = (page, text) => page.eval(`(() => { const i = document.querySelector('#side [data-sh="search"]'); i.value = ${J(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); return BriefPage.state.ui.search; })()`);

// Opens/closes a <details> by a real click on its summary; resolves after the page's own toggle listener recorded it.
async function toggleDetails(page, selector) {
  const toggled = pending(page.eval(`new Promise((resolve, reject) => {
    const d = document.querySelector(${J(selector)});
    if (!d) { reject(new Error('nothing matches ' + ${J(selector)})); return; }
    const timer = setTimeout(() => reject(new Error('no toggle event on ' + ${J(selector)})), 5000);
    d.addEventListener('toggle', () => { clearTimeout(timer); setTimeout(() => resolve(d.open), 0); }, { once: true });
  })`));
  await click(page, `${selector} > summary`);
  return toggled;
}

// One annotation through a block's 💬 button: hover the block, press the button, type, Ctrl+Enter. Returns the new count.
async function annotateBlock(page, sid, blockSel, comment) {
  const n0 = await page.eval(`BriefAnnotate.list(${J(sid)}).length`);
  await hover(page, blockSel, { fx: 0.3, fy: 0.5 });
  await click(page, `${blockSel} > .bh`, { scroll: false });
  const focused = await page.eval(`(() => { const a = document.activeElement; return !!a && a.tagName === 'TEXTAREA' && !!a.closest('.pop'); })()`);
  if (!focused) throw new Error(`the annotation tray did not open with its text box focused on ${blockSel}`);
  await typeText(page, comment);
  await key(page, 'Enter', 'Enter', 13, CTRL);
  const st = await page.eval(`({ n: BriefAnnotate.list(${J(sid)}).length, pop: !!document.querySelector('.pop') })`);
  if (st.n !== n0 + 1 || st.pop) throw new Error(`the annotation on ${blockSel} was not added: ${J({ n0, ...st })}`);
  return st.n;
}

const emulateMotion = (page, value) => page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });

function watchConsole(page, label) {
  const on = (method, fn) => {
    const list = page.client.listeners.get(method) || [];
    list.push(fn);
    page.client.listeners.set(method, list);
  };
  on('Runtime.exceptionThrown', (p) => (phase === 'teardown' ? teardownNetwork : consoleErrors).push(`${label}: exception ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`));
  on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') (phase === 'teardown' ? teardownNetwork : consoleErrors).push(`${label}: console.error ${(p.args || []).map((a) => a.value ?? a.description).join(' ')}`); });
  on('Log.entryAdded', (p) => {
    if (p.entry?.level !== 'error') return;
    const msg = `${label}: log ${p.entry.text} ${p.entry.url ?? ''}`;
    // Chrome's own network log line for a live-event stream that was cut ON PURPOSE (owner killed, briefing paused)
    const cut = expectDisconnect && /net::ERR_(CONNECTION_RESET|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_REFUSED|EMPTY_RESPONSE)\s+http:\/\/127\.0\.0\.1:\d+\/events\s*$/.test(msg);
    (phase === 'teardown' ? teardownNetwork : cut ? expectedNetwork : consoleErrors).push(msg);
  });
}

// A page that cannot be asked for its errors is a finding, not a pass: the failure is recorded in consoleErrors (scenario k fails on it)
// and in pageErrorReadFailures (result.json).
const pageErrorReadFailures = [];
const collectPageErrors = async (page, label) => {
  let list;
  try {
    list = await page.eval('window.__errors || []');
  } catch (err) {
    const note = `${label}: could not read the page's error list: ${(err && err.message) || err}`;
    pageErrorReadFailures.push(note);
    consoleErrors.push(note);
    return;
  }
  for (const e of list) consoleErrors.push(`${label}: ${e}`);
};

async function openBoard(page, url, label) {
  await collectPageErrors(page, label); // the previous document, if any
  await page.goto(url);
  await page.eval(`new Promise((resolve, reject) => {
    if (Object.keys(window.__applied).length) return resolve(true);
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => (Object.keys(window.__applied).length ? resolve(true) : reject(new Error('first paint never applied'))), 0));
    setTimeout(() => reject(new Error('first paint timeout')), 8000);
  })`);
}

// ---- Chrome by identity: every process of the profile is recorded, and checked gone after close
const pages = [];
async function launchTracked(opts, label) {
  const page = await launch(opts);
  pages.push(page);
  owned.pids.push(page.pid);
  owned.profiles.push(page.profileDir);
  page.qaRun = { label, browserPid: page.pid, profileDir: page.profileDir, pids: [page.pid], aliveAfterClose: null, listErrors: [], closeError: null };
  chromeRuns.push(page.qaRun);
  await page.client.send('Log.enable');
  watchConsole(page, label);
  return page;
}
function notePids(page) {
  try {
    page.qaRun.pids = [...new Set([...page.qaRun.pids, ...listProfilePids(page.profileDir)])].sort((a, b) => a - b);
  } catch (err) {
    page.qaRun.listErrors.push(String((err && err.message) || err));
  }
}
async function closePage(page) {
  if (page.qaClosed) return;
  notePids(page);
  try {
    await page.close();
    page.qaClosed = true;
  } catch (err) {
    page.qaRun.closeError = String((err && err.message) || err);
    throw err;
  } finally {
    page.qaRun.aliveAfterClose = page.qaRun.pids.filter((pid) => isPidAlive(pid));
  }
}

// ------------------------------------------------------------------ main

const WORKERS = [
  { id: 'st_qa1', name: '구조 조사', kind: 'explore' },
  { id: 'st_qa2', name: '화면 구현', kind: 'implementation' },
  { id: 'st_qa3', name: '시험 작성', kind: 'tester' },
];
let tick = 0;
const snapshot = (states) => {
  tick += 1000;
  return {
    parent_session_id: 'senpi:lead-A',
    tasks: WORKERS.map((w, i) => ({
      task_id: w.id, parent_session_id: 'lead-A', task_summary: w.name, agent_type: w.kind,
      resolved_model: { display: 'Sol 6.1', model_id: 'sol-6.1' }, status: states[i],
      created_at: iso(-90_000), updated_at: iso(tick), ...(states[i] === 'running' ? {} : { terminal_at: iso(tick) }),
      live_progress: { started_at: iso(-89_000), current_tool: 'read', last_assistant_line: `${w.name} 진행 중` },
    })),
  };
};

const planInput = (planPath) => ({
  planPath, stage: 'running', stageNote: PLAN_FIXTURE.stageNote, goal: PLAN_FIXTURE.goal,
  ideal: PLAN_FIXTURE.ideal, components: PLAN_FIXTURE.components, waves: PLAN_FIXTURE.waves,
  tasks: PLAN_FIXTURE.tasks.map(({ state, ...t }) => t),
  questions: PLAN_FIXTURE.questions.map(({ decisionId, ...q }) => q),
  outOfScope: PLAN_FIXTURE.outOfScope,
});
const planFileText = () => {
  const boxes = { 1: 'x', 2: 'x', 3: 'x', 4: 'x', 5: '~' };
  const lines = ['# 상황판 계획'];
  for (const t of PLAN_FIXTURE.tasks) {
    lines.push(`- [${boxes[t.id] ?? ' '}] ${t.id}. ${t.label}`);
    lines.push(`  Parallelization: Wave ${t.wave} | Blocked by: ${t.deps.length ? t.deps.join(', ') : '없음'} | Blocks: 없음`);
  }
  return `${lines.join('\n')}\n`;
};
const expectedAnchors = (planId) => {
  const a = [`${planId}/goal/main`];
  for (const x of PLAN_FIXTURE.ideal) a.push(`${planId}/is/${x.id}`, `${planId}/is/${x.id}/text`);
  for (const x of PLAN_FIXTURE.components) a.push(`${planId}/comp/${x.id}`, `${planId}/comp/${x.id}/label`, `${planId}/comp/${x.id}/text`);
  for (const x of PLAN_FIXTURE.waves) a.push(`${planId}/wave/${x.n}`, `${planId}/wave/${x.n}/label`);
  for (const x of PLAN_FIXTURE.tasks) a.push(`${planId}/task/${x.id}`, `${planId}/task/${x.id}/label`, `${planId}/task/${x.id}/what`, `${planId}/task/${x.id}/done`);
  for (const x of PLAN_FIXTURE.questions) a.push(`${planId}/q/${x.id}`, `${planId}/q/${x.id}/text`, `${planId}/q/${x.id}/answer`);
  PLAN_FIXTURE.outOfScope.forEach((_, i) => a.push(`${planId}/out/${i + 1}`, `${planId}/out/${i + 1}/text`));
  return a;
};

const TMP = mkdtempSync(path.join(os.tmpdir(), 'omo-qa-browser-'));
owned.tempDirs.push(TMP);
const STATE = path.join(TMP, 'state');
const CWD = path.join(TMP, 'proj');
mkdirSync(path.join(CWD, '.omo', 'plans'), { recursive: true });
const PLAN_PATH = path.join(CWD, '.omo', 'plans', 'living-board.md').replace(/\\/g, '/');
writeFileSync(PLAN_PATH, planFileText());
// the two report images of pick-writes-answer: the committed fixture PNG and JPEG, at absolute paths of the project
mkdirSync(path.join(CWD, 'qa-images'), { recursive: true });
const IMG_A = path.join(CWD, 'qa-images', 'layout-a.png');
const IMG_B = path.join(CWD, 'qa-images', 'layout-b.jpg');
copyFileSync(path.join(IMAGE_FIXTURES, readdirSync(IMAGE_FIXTURES).find((n) => n.endsWith('.png'))), IMG_A);
copyFileSync(path.join(IMAGE_FIXTURES, readdirSync(IMAGE_FIXTURES).find((n) => n.endsWith('.jpg'))), IMG_B);

let A = null;
let B = null;
let C = null; // third lead, started by g-mobile so there is a successor when the mobile run kills B
const pubOf = () => readJson(path.join(STATE, 'published.json'));
const serverUrl = () => `http://127.0.0.1:${readJson(path.join(STATE, 'server.json')).port}/`;
// One brief through the lead's real tool; a brief that did not publish (refused input) fails here instead of looking applied.
const published = async (lead, input) => {
  const before = pubOf().seq;
  const text = await lead.call('brief', { input });
  const after = pubOf();
  if (!(after.seq > before)) throw new Error(`brief of ${lead.sid} did not publish (seq ${before} -> ${after.seq}): ${text}`);
  return after;
};
const answersDir = () => path.join(STATE, 'answers');
const answerListing = () => readdirSync(answersDir()).sort();
const readdirIds = (dir) => {
  const names = existsSync(dir) ? readdirSync(dir) : [];
  return names.map((n) => Number(n.replace('.json', ''))).filter(Number.isInteger);
};
const boardToken = (page) => page.eval(`document.querySelector('meta[name="omo-board-token"]').getAttribute('content')`);

// b: lead-B's long 개요 page (8 changes, 12 done rows) and what the 20 publications change above the anchor
const B_CHANGES = Array.from({ length: 8 }, (_, i) => ({ text: `점검 ${i + 1}: 갱신이 와도 고른 탭, 연 칸, 스크롤 위치와 쓰던 글이 그대로인지 본다`, truth: 'reported', applied: 'candidate' }));
const B_DONE = Array.from({ length: 12 }, (_, i) => ({ text: `끝낸 일 ${i + 1}: 상태 유지 시험 준비`, truth: 'reported', applied: 'none' }));
const cut = (s, n) => [...s].slice(0, n).join('');
const LONG_HEADLINE = cut('상태 유지 시험: 위쪽 지금 칸과 흐름 줄이 길어져도 아래에서 보던 결정 카드는 화면의 같은 자리에 그대로 머물러야 하고 쓰던 글도 남아야 한다', 88);
const LONG_NEXT = cut('다음: 스무 번 갱신이 끝나면 탭, 하위 탭, 사이드바 보기와 스크롤, 검색어, 주석 둘, 답글 초안을 하나씩 다시 확인한다', 100);
// eight steps: the strip wraps to more than one row at 1440x900, so the content above the anchor grows well past the 30 px bar
const FLOW = [
  ['탭과 하위 탭 열어 두기', 'done'], ['닫힌 창 목록 검색하기', 'done'], ['사이드바 목록 내려 두기', 'done'], ['한 일 칸 손으로 펼치기', 'done'],
  ['주석 두 개 달아 두기', 'done'], ['답글 초안 써 두기', 'doing'], ['스무 번 갱신 보내기', 'todo'], ['모두 그대로인지 확인', 'todo'],
].map(([label, state]) => ({ label, state }));
const DRAFT = '스무 번 갱신돼도 이 답글 초안은 그대로 남아야 해요';
const SEARCH = '작업';
const NOTE_COMMENT = '첫 줄은 짧게\n둘째 줄: 목록을 먼저 보여 줘\n셋째 줄: 숫자는 굵게';
const PICK_DECISION = {
  question: '어느 화면 배치로 갈까요?',
  options: { A: { text: '왼쪽 목록', consequence: '목록 칸이 넓어진다' }, B: { text: '위쪽 탭', consequence: '탭 줄이 하나 생긴다' } },
  recommend: 'B', reason: '탭이 더 익숙하다', blocks: false,
};

// The state scenario b says survives: read the same way before and after the 20 publications.
const surviveProbe = (decisionId) => `(() => {
  const main = document.getElementById('main');
  const shell = document.querySelector('[data-shell]');
  const list = document.querySelector('#side [data-sh-part="list"]');
  const input = document.querySelector('#side [data-sh="search"]');
  const ui = BriefPage.state.ui;
  const page = main.querySelector('.cv-page');
  const tab = document.querySelector('#tabs .tb[data-tab="lead-B"] .tb-go');
  const ta = main.querySelector('textarea[data-draft="${decisionId}"]');
  const trayN = main.querySelector('[data-ann-tray] .tray-n b');
  const done = main.querySelector('details[data-open-key="cv:lead-B:done"]');
  const answers = ui.answers && ui.answers['${decisionId}'];
  return {
    seq: BriefPage.state.seq,
    active: ui.active, activeTabPressed: tab ? tab.getAttribute('aria-pressed') : null,
    shownPage: page ? page.getAttribute('data-sid') + '/' + page.getAttribute('data-sub') : null,
    subA: (ui.sub && ui.sub['lead-A']) || null,
    view: shell.getAttribute('data-view'), search: ui.search, searchInput: input.value,
    listRows: list.querySelectorAll('.sh-row').length, sideScrollTop: list.scrollTop, sideScrollMax: list.scrollHeight - list.clientHeight,
    mainScrollTop: main.scrollTop,
    annotations: BriefAnnotate.list('lead-B').length, trayCount: trayN ? trayN.textContent : null, marked: main.querySelectorAll('.bann').length,
    draft: ta ? ta.value : null, draftState: answers ? answers.draft : null, draftOpen: answers ? answers.open : null,
    doneOpen: done ? done.open : null,
    headline: (main.querySelector('.cv-hl') || {}).textContent || '', flowSteps: main.querySelectorAll('[data-block="flow"] .cv-fs').length,
  };
})()`;
// where a block sits: its top below #main's top edge, and its offset inside #main's scrolled content
const blockAt = (page, blockId) => page.eval(`(() => {
  const main = document.getElementById('main');
  const el = main.querySelector('[data-block="' + ${J(blockId)} + '"]');
  if (!el) return null;
  const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top;
  return { top: Math.round(top * 10) / 10, inContent: Math.round((top + main.scrollTop) * 10) / 10 };
})()`);

// 50 ms after the apply that shows `moverId` as finished (the plan's +50ms observation point): row order inside `scope`, running
// animations on the moved row, the pulse. `freeze` also pauses every finite animation so a capture shows the move in flight;
// finishFrozen ends them.
const moveProbeFor = (page, scope, moverId, { freeze = false } = {}) => pending(page.eval(`new Promise((resolve, reject) => {
  const mover = ${J(moverId)};
  const scope = ${J(scope)};
  let done = false;
  const timer = setTimeout(() => reject(new Error('worker never shown as finished')), 12000);
  BriefPage.hooks.afterApply.push(() => {
    if (done) return;
    const row = document.querySelector(scope + ' [data-worker="' + mover + '"]');
    if (!row || !row.classList.contains('w-done')) return;
    done = true;
    clearTimeout(timer);
    setTimeout(() => {
      const rows = [...document.querySelectorAll(scope + ' [data-worker]')];
      const running = document.querySelector(scope + ' .w-running > .w-dot');
      let frozen = 0;
      if (${freeze}) {
        window.__frozen = document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().endTime !== Infinity);
        window.__frozen.forEach((a) => a.pause());
        frozen = window.__frozen.length;
      }
      resolve({ order: rows.map((r) => r.getAttribute('data-worker')), moverAnimations: row.getAnimations().length, frozen,
        pulseName: running ? getComputedStyle(running).animationName : null, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches });
    }, 50);
  });
})`));
const finishFrozen = (page) => page.eval('(() => { (window.__frozen || []).forEach((a) => a.finish()); window.__frozen = []; return true; })()');
const workerRows = (scope) => `[...document.querySelectorAll(${J(`${scope} [data-worker]`)})].map((r) => r.getAttribute('data-worker'))`;
// a schema-valid long compare row (a 35-character label, a 43-character value): published by 'blocks', measured on the phone
// by 'blocks-mobile' (the label track stays bounded, the value keeps a readable width)
const LONG_ROW = { label: '보안 검토와 운영 정책 및 유지 보수 계획의 요구사항 충족 여부', A: '기존 운영 절차를 유지하면서 보안 검토를 마치고 안전하게 배포할 수 있습니다.', B: '새 운영 절차를 작성해야 합니다.' };

async function desktopRun() {
  const page = await launchTracked({ width: 1440, height: 900, extraArgs: [NO_AUTOPLAY_FLAG] }, 'desktop');
  activeView = { name: '1440x900', page, expect: null };
  await page.addInitScript(INIT_SCRIPT);
  await emulateMotion(page, 'no-preference');
  const url = serverUrl();
  await openBoard(page, url, 'desktop');
  notePids(page);

  // (e) first load records alarm keys/title without a band or sound.
  const firstLoad = await page.eval(`({ bandPresent: !!document.querySelector('#alarm-band,.alarm-row'), seen: Object.keys(JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}')), title: document.title, starts: window.__audio.starts })`);

  // (a) 20 publications -> applied in the page
  await scenario('a', 'http page: 20 publications reach the page without a click, p95 <= 1500ms', async () => {
    const values = [];
    for (let i = 0; i < 20; i++) {
      const pub = await published(A, briefOf('상황판 점검', `갱신 ${i + 1}번째`));
      const appliedAt = await waitApplied(page, pub.seq);
      values.push(appliedAt - pub.at);
    }
    const p95 = p95Of(values);
    assert.ok(p95 <= 1500, `p95 ${p95}ms`);
    return { p95Ms: p95, maxMs: Math.max(...values), valuesMs: values };
  });
  await page.screenshot(path.join(OUT, 'desktop-board.png'));

  // (b) everything the owner set up on the screen survives 20 publications
  let bDecision = null;
  await scenario('b', '20 publications keep the active tab, the shown and a remembered sub-tab, the sidebar view, scroll and search text, the #main anchor (content grows above it), an opened section, 2 pending annotations and a reply draft', async () => {
    const pub0 = await published(B, briefOf('두 번째 대화', '상태 유지 시험 시작', { changes: B_CHANGES, done: B_DONE, decisions: [decisionOf('답글 초안이 갱신을 견딜까요?')] }));
    await waitApplied(page, pub0.seq);
    bDecision = await page.eval(`(() => { const s = BriefPage.state.model.sessions.find((x) => x.id === 'lead-B'); const d = s && s.decisions.find((x) => !x.answered && !x.closed); return d ? d.id : null; })()`);
    assert.ok(Number.isInteger(bDecision), `lead-B has an open decision: ${bDecision}`);
    const decSel = `#main [data-block="dec/${bDecision}"]`;
    // lead-A opened from its sidebar row and left on 작업자, then lead-B opened the same way (개요)
    await click(page, '#side .sh-row[data-row="lead-A"] .sh-go');
    await click(page, '#main .stabs [data-sub="wk"]');
    assert.equal(await shownPage(page), 'lead-A/wk');
    await click(page, '#side .sh-row[data-row="lead-B"] .sh-go');
    assert.equal(await shownPage(page), 'lead-B/ov');
    // the folded ✔ 한 일 section opened by hand, two annotations (💬 on 지금 and on the decision card), a reply draft typed
    assert.equal(await toggleDetails(page, '#main details[data-open-key="cv:lead-B:done"]'), true, 'the 한 일 section opened');
    await annotateBlock(page, 'lead-B', '#main [data-block="now"]', '지금 줄을 한 줄로 줄여 줘');
    await annotateBlock(page, 'lead-B', decSel, '이 결정의 추천 이유를 더 짧게');
    await click(page, `${decSel} [data-act="ans-reply"]`);
    assert.equal(await page.eval(`document.activeElement === document.querySelector('#main textarea[data-draft="${bDecision}"]')`), true, 'the reply box has the focus');
    await typeText(page, DRAFT);
    assert.equal(await page.eval('BriefPage.busy()'), true, 'typing in #main holds updates');
    // the sidebar: 닫힌 창 view (the click also takes the focus out of the reply box), search text typed, list scrolled
    await click(page, '#rail [data-sh="view"][data-key="archive"]');
    await click(page, '#side [data-sh="search"]');
    await typeText(page, SEARCH);
    await page.eval('(document.activeElement && document.activeElement.blur(), true)');
    await page.eval(`(document.querySelector('#side [data-sh-part="list"]').scrollTop = 120, true)`);
    // #main: the decision card at the top edge, so 지금 and the flow strip (which grow) are above it
    await page.eval(`(() => { const main = document.getElementById('main'); const el = document.querySelector(${J(decSel)}); main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 2; return true; })()`);
    const before = await page.eval(surviveProbe(bDecision));
    assert.ok(before.listRows >= ARCHIVE_SEEDS && before.sideScrollTop >= 100 && before.sideScrollMax >= 120, `the 닫힌 창 search result scrolls: ${J(before)}`);
    assert.equal(await page.eval('BriefPage.busy()'), false, 'nothing holds the updates now (no focus or selection in #main)');
    const anchor = await page.eval('BriefPage.captureAnchor()');
    assert.ok(anchor && !/^(change|done)\//.test(anchor.id), `the page's anchor is a stable block: ${J(anchor)}`);
    const anchorBefore = await blockAt(page, anchor.id);
    let last = null;
    for (let i = 0; i < 20; i++) {
      last = await published(B, briefOf('두 번째 대화', `${LONG_HEADLINE} (${i + 1}/20)`, { next: LONG_NEXT, flow: FLOW, changes: B_CHANGES, done: B_DONE }));
      await waitApplied(page, last.seq);
    }
    const after = await page.eval(surviveProbe(bDecision));
    const anchorAfter = await blockAt(page, anchor.id);
    assert.ok(anchorAfter, `the anchor block ${anchor.id} is still on the page`);
    const moved = Math.round(Math.abs(anchorAfter.top - anchorBefore.top) * 10) / 10;
    const grewAbove = Math.round((anchorAfter.inContent - anchorBefore.inContent) * 10) / 10;
    assert.ok(after.seq >= last.seq && after.headline.includes('(20/20)') && after.flowSteps === FLOW.length, `the 20th publication is shown: ${J(after)}`);
    assert.ok(grewAbove >= 30, `content above the anchor grew by ${grewAbove}px`);
    assert.ok(moved <= 2, `the anchor ${anchor.id} moved ${moved}px on screen`);
    assert.equal(after.active, 'lead-B', 'active tab');
    assert.equal(after.activeTabPressed, 'true', 'the tab bar marks lead-B');
    assert.equal(after.shownPage, 'lead-B/ov', 'shown sub-tab');
    assert.equal(after.subA, 'wk', "lead-A's remembered sub-tab");
    assert.equal(after.view, 'archive', 'sidebar view');
    assert.equal(after.search, SEARCH, 'search text in the state');
    assert.equal(after.searchInput, SEARCH, 'search text in the box');
    assert.equal(after.listRows, before.listRows, 'the search result');
    assert.ok(Math.abs(after.sideScrollTop - before.sideScrollTop) <= 1, `sidebar scroll ${before.sideScrollTop} -> ${after.sideScrollTop}`);
    assert.equal(after.doneOpen, true, 'the opened 한 일 section');
    assert.equal(after.annotations, 2, 'pending annotations');
    assert.equal(after.trayCount, '2', 'the tray count');
    assert.ok(after.marked >= 2 && after.marked === before.marked, `annotated blocks marked: ${before.marked} -> ${after.marked}`);
    assert.equal(after.draft, DRAFT, 'the reply box text');
    assert.equal(after.draftState, DRAFT, 'the reply draft in the state');
    await page.screenshot(path.join(OUT, 'desktop-state.png'));
    return {
      publications: 20, firstSeq: pub0.seq, lastSeq: last.seq, anchor: anchor.id, anchorTopBefore: anchorBefore.top, anchorTopAfter: anchorAfter.top, movedPx: moved, grewAbovePx: grewAbove,
      before, after, capture: 'desktop-state.png',
    };
  });

  // (c) text selected inside #main -> held with a badge; released -> applied within 300ms
  await scenario('c', 'a text selection in #main holds the update (badge) and its release applies within 300ms', async () => {
    await scrollMainTop(page);
    const hl = '#main .cv-hl';
    const headlineBefore = await page.eval(`document.querySelector(${J(hl)}).textContent`);
    const selected = await page.eval(`(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector(${J(hl)})); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return String(s).length; })()`);
    assert.ok(selected > 0, 'the headline text is selected');
    const NEW = '글자를 고르는 동안 바뀐 내용';
    const badgeShown = pending(waitDom(page, `!document.getElementById('new-badge').hidden`, { label: 'the held-update badge' }));
    const pub = await published(B, briefOf('두 번째 대화', NEW, { changes: B_CHANGES }));
    await badgeShown;
    const held = await page.eval(`({ applied: BriefPage.state.seq, badge: !document.getElementById('new-badge').hidden, badgeText: document.getElementById('new-badge').textContent,
      busy: BriefPage.busy(), hl: document.querySelector(${J(hl)}).textContent })`);
    assert.ok(held.applied < pub.seq && held.badge && held.busy && held.hl === headlineBefore, `held: ${J(held)}`);
    const t0 = await page.eval('(() => { const t = Date.now(); getSelection().removeAllRanges(); return t; })()');
    const appliedAt = await waitApplied(page, pub.seq);
    const delta = appliedAt - t0;
    assert.ok(delta <= 300, `applied ${delta}ms after the selection ended`);
    const after = await page.eval(`document.querySelector(${J(hl)}).textContent`);
    assert.ok(after.includes(NEW), `released: ${after}`);
    return { heldBadge: held.badgeText, seqWhileSelected: held.applied, publishedSeq: pub.seq, appliedAfterReleaseMs: delta };
  });

  // (d) worker pulse, move to the bottom when finished, animation under normal and reduced motion; a finished conversation
  // leaves the sidebar's 진행 중 filter
  await scenario('d', 'workers: pulse while running, the finished row sinks with a 350ms move, none under reduced motion; a finished conversation leaves the sidebar 진행 중 filter for 끝남', async () => {
    await click(page, '#tabs .tb[data-tab="lead-A"] .tb-go');
    assert.equal(await shownPage(page), 'lead-A/wk', "lead-A's tab comes back on its remembered 작업자 sub-tab");
    const pub0 = await published(A, briefOf('상황판 점검', '작업자 셋이 일하는 중'));
    await waitApplied(page, pub0.seq);
    const initial = await page.eval(`(() => {
      const dot = document.querySelector('#main .w-running > .w-dot');
      return { order: ${workerRows('#main')}, running: document.querySelectorAll('#main .w-running').length,
        pulse: dot ? getComputedStyle(dot).animationName : null, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
    })()`);
    assert.equal(initial.running, 3);
    assert.equal(initial.pulse, 'w-pulse');
    assert.equal(initial.reduced, false);
    await page.screenshot(path.join(OUT, 'desktop-workers.png'));

    // normal motion: the first row finishes and sinks
    const mover1 = initial.order[0];
    const probe1 = moveProbeFor(page, '#main', mover1);
    await A.call('rpc', { data: snapshot(WORKERS.map((w) => (w.id === mover1 ? 'completed' : 'running'))) });
    const normal = await probe1;
    assert.equal(normal.order.at(-1), mover1, `finished row is last: ${normal.order}`);
    assert.ok(normal.moverAnimations > 0, 'the moved row has a running animation 50ms after the apply');

    // reduced motion: the next first row finishes; nothing animates and the pulse is off
    let reduced;
    await emulateMotion(page, 'reduce');
    try {
      const mover2 = (await page.eval(workerRows('#main')))[0];
      const probe2 = moveProbeFor(page, '#main', mover2);
      await A.call('rpc', { data: snapshot(WORKERS.map((w) => (w.id === mover1 || w.id === mover2 ? 'completed' : 'running'))) });
      reduced = await probe2;
    } finally {
      await emulateMotion(page, 'no-preference');
    }
    assert.equal(reduced.reduced, true);
    assert.equal(reduced.moverAnimations, 0, 'no animation under reduced motion');
    assert.equal(reduced.pulseName, 'none', 'the pulse is off');

    // lead-B finishes: under the sidebar's 진행 중 filter its row goes away, under 끝남 it is listed
    await click(page, '#rail [data-sh="view"][data-key="conv"]');
    assert.equal(await setSearch(page, ''), '', 'search cleared');
    await click(page, '#side [data-sh="filter"][data-key="run"]');
    await B.call('command', { name: 'decide', args: `${bDecision}A` }); // its open decision (b) would file it under 나를 기다림
    await waitApplied(page, pubOf().seq);
    const rowSel = '#side [data-sh-part="list"] .sh-row[data-row="lead-B"]';
    const runBefore = await page.eval(`({ filter: BriefPage.state.ui.filter, row: !!document.querySelector(${J(rowSel)}) })`);
    assert.deepEqual(runBefore, { filter: 'run', row: true }, 'lead-B is listed under 진행 중');
    const left = pending(waitDom(page, `!document.querySelector(${J(rowSel)})`, { label: 'lead-B leaving the 진행 중 list' }));
    const fin = await published(B, briefOf('두 번째 대화', '마쳤습니다', { status: 'done', done: [{ text: '모두 끝냄', truth: 'reported', applied: 'none' }] }));
    await left;
    await waitApplied(page, fin.seq);
    await click(page, '#side [data-sh="filter"][data-key="done"]');
    const underDone = await page.eval(`!!document.querySelector(${J(rowSel)})`);
    assert.equal(underDone, true, 'lead-B is listed under 끝남');
    await click(page, '#side [data-sh="filter"][data-key="all"]');
    return {
      pulse: initial.pulse, runningRows: initial.running, finishedRowLast: normal.order.at(-1) === mover1, moverAnimationsAt50ms: normal.moverAnimations,
      reducedMotionAnimations: reduced.moverAnimations, reducedPulseAnimationName: reduced.pulseName,
      sidebar: { runFilterBefore: runBefore.row, runFilterAfter: false, doneFilter: underDone },
    };
  });

  // (e) alarm
  await scenario('e', 'alarm: no band; recorded keys/title and one chime per update, none on first load / muted in 설정 / reload; blocked-autoplay path is in the mobile run', async () => {
    assert.equal(firstLoad.bandPresent, false, 'no band on first load');
    assert.ok(firstLoad.seen.length >= 1 && firstLoad.title.startsWith('('), `first load records alarms/title: ${J(firstLoad)}`);
    assert.equal(firstLoad.starts, 0, 'no sound for what was already waiting');
    await scrollMainTop(page);
    const t0 = await page.eval('document.title');
    const n0 = Number(/^\((\d+)\)/.exec(t0)[1]);
    const s0 = await page.eval('window.__audio.starts');
    const one = await published(A, briefOf('상황판 점검', '새 질문 하나', { decisions: [decisionOf('첫 새 질문')] }));
    await waitApplied(page, one.seq);
    const afterOne = await page.eval(`({ title: document.title, starts: window.__audio.starts, bandPresent: !!document.querySelector('#alarm-band,.alarm-row'), recorded: BriefPage.state.model.waiting.every(w => Number.isFinite(JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}')[w.key])), state: window.__audio.contexts[0] && window.__audio.contexts[0].state })`);
    assert.ok(afterOne.title.startsWith(`(${n0 + 1}) `), afterOne.title);
    assert.equal(afterOne.starts - s0, 2, 'one chime = two tones');
    assert.equal(afterOne.bandPresent, false);
    assert.equal(afterOne.recorded, true, 'new alarms are recorded');
    const four = await published(A, briefOf('상황판 점검', '새 질문 넷', { decisions: ['둘', '셋', '넷', '다섯'].map((x) => decisionOf(`동시 ${x}`)) }));
    await waitApplied(page, four.seq);
    const afterFour = await page.eval(`({ title: document.title, starts: window.__audio.starts })`);
    assert.ok(afterFour.title.startsWith(`(${n0 + 5}) `), afterFour.title);
    assert.equal(afterFour.starts - s0, 4, 'four new at once ring once');
    await page.screenshot(path.join(OUT, 'desktop-alarm.png'));
    // mute in the existing sidebar Settings view: keys stay recorded, no sound
    await click(page, '#rail [data-sh="view"][data-key="settings"]');
    await click(page, '#side [data-alarm-sound]');
    assert.equal(await page.eval(`document.querySelector('#side [data-alarm-sound]').getAttribute('aria-pressed')`), 'false', 'sound off');
    const muted = await published(A, briefOf('상황판 점검', '꺼진 동안 질문', { decisions: [decisionOf('무음 질문')] }));
    await waitApplied(page, muted.seq);
    const afterMute = await page.eval(`({ title: document.title, starts: window.__audio.starts, label: document.querySelector('#side [data-alarm-sound]').textContent })`);
    assert.equal(afterMute.starts - s0, 4, 'no tone while muted');
    assert.ok(afterMute.title.startsWith(`(${n0 + 6}) `) && afterMute.label.includes('꺼짐'), J(afterMute));
    // answering one reduces the waiting title count
    const decisionId = Math.max(...readdirIds(path.join(STATE, 'decisions')));
    await A.call('command', { name: 'decide', args: `${decisionId}A` });
    await waitApplied(page, pubOf().seq);
    const afterAnswer = await page.eval('document.title');
    assert.ok(afterAnswer.startsWith(`(${n0 + 5}) `), `answered item left: ${afterAnswer}`);
    // sound back on, reload: what was seen before does not ring again
    await click(page, '#side [data-alarm-sound]');
    assert.equal(await page.eval(`document.querySelector('#side [data-alarm-sound]').getAttribute('aria-pressed')`), 'true', 'sound on');
    await openBoard(page, url, 'desktop-reload');
    const reloaded = await page.eval(`({ starts: window.__audio.starts, bandPresent: !!document.querySelector('#alarm-band,.alarm-row'), seen: Object.keys(JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}')), title: document.title })`);
    assert.equal(reloaded.starts, 0, 'a reload does not ring for items seen before');
    assert.equal(reloaded.bandPresent, false);
    assert.ok(reloaded.seen.length >= 1);
    await click(page, '#rail [data-sh="view"][data-key="conv"]');
    return { firstLoad, startsBefore: s0, afterOne: { title: afterOne.title, starts: afterOne.starts }, afterFour, afterMute, afterAnswer, reloaded };
  });

  // (f) plan box view on the 계획 sub-tab
  await scenario('f', 'plan (계획 sub-tab): the box view folds to <= 2 summary lines without anchors; opened it has every anchor exactly once and 4 lanes', async () => {
    const planResult = await A.call('plan', { input: planInput(PLAN_PATH) });
    assert.match(planResult, /^계획 r\d+ 저장/);
    await waitApplied(page, pubOf().seq);
    await click(page, '#tabs .tb[data-tab="lead-A"] .tb-go');
    await click(page, '#main .stabs [data-sub="plan"]');
    assert.equal(await shownPage(page), 'lead-A/plan');
    const id = await page.eval(`document.querySelector('#main [data-plan]').getAttribute('data-plan')`);
    const toggle = (key) => `#main [data-act="exp"][data-key="${key}${id}"]`;
    const isOpen = (key) => page.eval(`(() => { const t = document.querySelector(${J(toggle(key))}); return t ? t.getAttribute('aria-expanded') === 'true' : null; })()`);
    const firstOpen = await isOpen('plan:');
    if (firstOpen) await click(page, toggle('plan:'));
    const collapsed = await page.eval(`(() => {
      const plan = document.querySelector('#main [data-plan]');
      return { collapsed: plan.classList.contains('plan-collapsed'), lines: plan.querySelectorAll('.plan-summary-line').length, anchors: document.querySelectorAll('#main [data-plan] [data-anchor]').length };
    })()`);
    assert.ok(collapsed.collapsed && collapsed.lines <= 2 && collapsed.anchors === 0, J(collapsed));
    for (const key of ['plan:', 'plan-tasks:', 'plan-out:']) {
      const state = await isOpen(key);
      assert.notEqual(state, null, `${key} toggle exists`);
      if (!state) await click(page, toggle(key));
    }
    const anchors = await page.eval(`[...document.querySelectorAll('#main [data-anchor]')].map((e) => e.getAttribute('data-anchor'))`);
    const expected = expectedAnchors(id);
    assert.equal(new Set(anchors).size, anchors.length, 'no duplicate anchor');
    assert.deepEqual([...anchors].sort(), [...expected].sort(), 'every plan element has exactly one anchor');
    const lanes = await page.eval(`(() => { const l = [...document.querySelectorAll('#main .plan-lane')]; return { count: l.length, current: l.filter((x) => x.classList.contains('is-current')).length, now: document.querySelectorAll('#main .plan-now').length }; })()`);
    assert.deepEqual(lanes, { count: 4, current: 1, now: 1 });
    await page.eval(`(document.querySelector('#main .plan-expanded').scrollIntoView({ block: 'start' }), true)`);
    await frames(page);
    await page.screenshot(path.join(OUT, 'desktop-plan.png'));
    return { planId: id, seededOpenOnFirstVisit: firstOpen, collapsedLines: collapsed.lines, anchorsChecked: anchors.length, lanes };
  });

  // annotation: send -> stored -> delivered (proven by the conversation's session) -> 전달됨 on the page
  await scenario('annotation-delivered', 'annotation: tray 보내기 -> answers/a-<uuid>.json -> admitted to lead-A and proven by its session (fake pi.session emitted) -> receipt proven:true -> 보낸 피드백 shows 전달됨', async () => {
    await click(page, '#tabs .tb[data-tab="lead-A"] .tb-go');
    await click(page, '#main .stabs [data-sub="ov"]');
    await scrollMainTop(page);
    const before = new Set(answerListing());
    await annotateBlock(page, 'lead-A', '#main [data-block="now"]', NOTE_COMMENT);
    const sendSel = '#main [data-ann-tray] [data-ann-act="send"]';
    const sendText = await page.eval(`(document.querySelector(${J(sendSel)}) || {}).textContent || null`);
    assert.ok(sendText && sendText.endsWith('로 보내기'), `the live tray offers 보내기: ${sendText}`);
    const stored = pending(until(answersDir(), () => {
      const name = readdirSync(answersDir()).find((n) => /^a-[0-9a-f-]{36}\.json$/.test(n) && !before.has(n));
      return name ? { name, rec: readJson(path.join(answersDir(), name)) } : null;
    }, 'answers/a-<uuid>.json'));
    await click(page, sendSel);
    const { name, rec } = await stored;
    const key = name.slice(0, -5);
    assert.equal(rec.key, key);
    assert.equal(rec.kind, 'annotation');
    assert.equal(rec.sessionId, 'lead-A');
    assert.equal(rec.fromSessionId, 'board');
    assert.equal(`a-${rec.requestId}`, key);
    for (const line of NOTE_COMMENT.split('\n')) assert.ok(rec.text.includes(line), `the stored Markdown keeps "${line}": ${J(rec.text)}`);
    const receiptFile = path.join(STATE, 'receipts', `${key}.json`);
    const receipt = await until(STATE, () => (existsSync(receiptFile) ? readJson(receiptFile) : null), `receipts/${key}.json`, 15_000, { recursive: true });
    assert.equal(receipt.key, key);
    assert.equal(receipt.sessionId, 'lead-A');
    assert.equal(receipt.proven, true, 'the receipt is a proof, not a fallback');
    const ledger = await A.call('deliveries');
    const admitted = ledger.admitted.filter((d) => d.delivery_id === key);
    assert.equal(admitted.length, 1, 'admitted exactly once');
    assert.ok(ledger.ledger.emitted.includes(key), 'the session lists the delivery as emitted');
    const head = `[상황판 피드백] a-${rec.requestId.slice(0, 8)} `;
    assert.ok(admitted[0].text.startsWith(head) && admitted[0].text.endsWith(`\n${rec.text}`), `delivered text = header line + the stored Markdown: ${J(admitted[0].text.slice(0, 160))}`);
    const chip = await waitDom(page, `(() => { const li = document.querySelector('#main [data-block="note/${key}"]'); const c = li && li.querySelector('.chip'); return c && /^전달됨/.test(c.textContent) ? c.textContent : null; })()`, { label: '전달됨 on the sent note' });
    const tray = await page.eval(`({ left: BriefAnnotate.list('lead-A').length, msg: (document.querySelector('#main [data-ann-tray] .ann-msg') || {}).textContent || null, notesOpen: !!document.querySelector('#main details.cv-notes[open]') })`);
    assert.equal(tray.left, 0, 'the sent annotations left the tray');
    assert.equal(tray.notesOpen, true, '보낸 피드백 is open');
    await page.eval(`(document.querySelector('#main [data-block="note/${key}"]').scrollIntoView({ block: 'center' }), true)`);
    await frames(page);
    await page.screenshot(path.join(OUT, 'desktop-annotation-sent.png'));
    return {
      answerFile: `answers/${name}`, stored: { key: rec.key, kind: rec.kind, sessionId: rec.sessionId, fromSessionId: rec.fromSessionId, textChars: [...rec.text].length, lines: rec.text.split('\n').length },
      receipt, admitted: { delivery_id: admitted[0].delivery_id, sender: admitted[0].sender, deliverAs: admitted[0].deliverAs, firstLine: admitted[0].text.split('\n')[0] },
      ledgerEmitted: ledger.ledger.emitted.includes(key), pageChip: chip, trayAfterSend: tray, capture: 'desktop-annotation-sent.png',
    };
  });

  // 보고서: 이걸로 고르기 -> confirm in place -> 보내기 -> answers/<id>.json
  let report = null;
  await scenario('pick-writes-answer', '보고서 "이걸로 고르기" B -> confirm in place -> 보내기 writes answers/<id>.json {option:B, fromSessionId:board}; the report then shows 답함 with B chosen', async () => {
    const pub = await published(A, briefOf('상황판 점검', '두 화면 배치를 그림으로 비교', {
      decisions: [PICK_DECISION],
      reports: [{ id: 'layout-compare', title: '화면 배치 두 안', summary: '왼쪽 목록 안과 위쪽 탭 안을 같은 크기로 찍어 비교', decisionIndex: 0,
        images: [{ path: IMG_A, alt: '왼쪽 목록 안', option: 'A' }, { path: IMG_B, alt: '위쪽 탭 안', option: 'B' }] }],
    }));
    await waitApplied(page, pub.seq);
    report = await page.eval(`(() => { const s = BriefPage.state.model.sessions.find((x) => x.id === 'lead-A'); const r = s && (s.reports || []).find((x) => x.id === 'layout-compare');
      return r ? { decisionId: r.decisionId, status: r.status, images: r.images.map((i) => ({ src: i.src, option: i.option })) } : null; })()`);
    assert.ok(report && Number.isInteger(report.decisionId) && report.images.length === 2, `the report in the model: ${J(report)}`);
    const id = report.decisionId;
    const answerFile = path.join(answersDir(), `${pad6(id)}.json`);
    assert.equal(existsSync(answerFile), false, 'no answer before the pick');
    await click(page, '#main .stabs [data-sub="rep"]');
    const loaded = await page.eval(`(() => {
      const list = [...document.querySelectorAll('#main [data-block="rep/layout-compare"] img')];
      list.forEach((i) => { i.loading = 'eager'; });
      const bound = new Promise((r) => setTimeout(() => r('timeout'), 8000));
      return Promise.race([Promise.all(list.map((i) => i.decode().then(() => i.naturalWidth, () => 0))), bound]);
    })()`);
    assert.ok(Array.isArray(loaded) && loaded.length === 2 && loaded.every((w) => w > 0), `both report images load from /assets: ${J(loaded)}`);
    const pickSel = `#main .cv-pick[data-dec="${id}"][data-opt="B"]`;
    assert.equal(await page.eval(`(document.querySelector(${J(pickSel)}) || {}).textContent || null`), '이걸로 고르기');
    await click(page, pickSel);
    const sendSel = `#main [data-act="ans-send"][data-id="${id}"][data-where="rep"]`;
    const confirm = await page.eval(`(() => { const b = document.querySelector(${J(sendSel)}); const row = b && b.closest('.ans-confirm'); return row ? row.textContent : null; })()`);
    assert.ok(confirm && confirm.includes('B'), `the confirm row asks for B in place: ${confirm}`);
    const written = pending(until(answersDir(), () => (existsSync(answerFile) ? readJson(answerFile) : null), `answers/${pad6(id)}.json`));
    await click(page, sendSel);
    const ans = await written;
    assert.equal(ans.id, id);
    assert.equal(ans.option, 'B');
    assert.equal(ans.fromSessionId, 'board');
    const shown = await waitDom(page, `(() => {
      const rep = document.querySelector('#main [data-block="rep/layout-compare"]');
      const st = rep && rep.querySelector('.rep-t .chip');
      const chosen = rep && rep.querySelector('.ropt.chosen .nm');
      const picks = rep ? [...rep.querySelectorAll('.cv-pick')] : [];
      return st && st.textContent === '답함' && chosen && chosen.textContent.startsWith('B ·') && picks.length === 2 && picks.every((b) => b.disabled)
        ? { status: st.textContent, chosen: chosen.textContent, picksDisabled: picks.length } : null;
    })()`, { label: 'the report showing 답함 with B chosen' });
    await page.eval(`(document.querySelector('#main [data-block="rep/layout-compare"]').scrollIntoView({ block: 'start' }), true)`);
    await frames(page);
    await page.screenshot(path.join(OUT, 'desktop-report-pick.png'));
    return { decisionId: id, answerFile: `answers/${pad6(id)}.json`, answer: ans, confirmRow: confirm, imagesLoadedWidths: loaded, report: shown, capture: 'desktop-report-pick.png' };
  });

  // legacy reply (no kind): 501 characters -> BAD_TEXT; the limit itself (500) is stored
  await scenario('legacy-501-bad-text', 'a legacy board reply POST /answer {id, sessionId, text} of 501 characters -> 400 BAD_TEXT and nothing stored; 500 characters are stored', async () => {
    const open = await page.eval(`(() => { const s = BriefPage.state.model.sessions.find((x) => x.id === 'lead-A');
      return s.decisions.filter((d) => !d.answered && !d.closed && !d.held && d.source === 'brief').map((d) => d.id).sort((a, b) => a - b); })()`);
    assert.ok(open.length >= 2, `two open decisions of lead-A: ${J(open)}`);
    const [tooLongId, limitId] = open;
    const token = await boardToken(page);
    const origin = new URL(url).origin;
    const before = answerListing();
    const tooLong = await httpPost(`${url}answer`, { headers: writeHeaders(token, origin), body: { id: tooLongId, sessionId: 'lead-A', text: '가'.repeat(501) } });
    assert.equal(tooLong.status, 400, `501 characters: ${tooLong.status} ${tooLong.text}`);
    assert.equal(tooLong.json && tooLong.json.code, 'BAD_TEXT');
    assert.deepEqual(answerListing(), before, 'nothing was written');
    assert.equal(existsSync(path.join(answersDir(), `${pad6(tooLongId)}.json`)), false);
    const atLimit = await httpPost(`${url}answer`, { headers: writeHeaders(token, origin), body: { id: limitId, sessionId: 'lead-A', text: '나'.repeat(500) } });
    assert.equal(atLimit.status, 200, `500 characters: ${atLimit.status} ${atLimit.text}`);
    const stored = readJson(path.join(answersDir(), `${pad6(limitId)}.json`));
    assert.equal([...stored.text].length, 500);
    return { tooLong: { id: tooLongId, chars: 501, status: tooLong.status, body: tooLong.json, answersUnchanged: true }, atLimit: { id: limitId, chars: 500, status: atLimit.status, storedChars: [...stored.text].length } };
  });

  // a write from another origin: refused before anything is read or stored
  await scenario('forged-origin-403', 'an annotation POST with a forged Origin (and Origin: null) -> 403 FORBIDDEN_ORIGIN, nothing stored; the same request with the board origin is stored', async () => {
    const token = await boardToken(page);
    const origin = new URL(url).origin;
    const requestId = randomUUID();
    const key = `a-${requestId}`;
    const file = path.join(answersDir(), `${key}.json`);
    const body = { kind: 'annotation', sessionId: 'lead-A', requestId, text: '다른 사이트에서 위조해 보낸 주석' };
    const before = answerListing();
    const forged = await httpPost(`${url}answer`, { headers: writeHeaders(token, 'http://evil.example'), body });
    const nullOrigin = await httpPost(`${url}answer`, { headers: writeHeaders(token, 'null'), body });
    for (const [label, res] of [['forged', forged], ['null', nullOrigin]]) {
      assert.equal(res.status, 403, `${label}: ${res.status} ${res.text}`);
      assert.equal(res.json && res.json.code, 'FORBIDDEN_ORIGIN', `${label}: ${res.text}`);
    }
    assert.deepEqual(answerListing(), before, 'nothing was written');
    assert.equal(existsSync(file), false);
    const real = await httpPost(`${url}answer`, { headers: writeHeaders(token, origin), body });
    assert.equal(real.status, 200, `board origin: ${real.status} ${real.text}`);
    assert.equal(existsSync(file), true, 'the same request from the board origin is stored');
    return { forged: { origin: 'http://evil.example', status: forged.status, body: forged.json }, nullOrigin: { status: nullOrigin.status, body: nullOrigin.json }, control: { origin, status: real.status, stored: `answers/${key}.json` } };
  });

  // /assets: only the images the model references, by their own hash
  await scenario('unknown-asset-404', 'GET /assets/<unknown sha>.png and a malformed asset name -> 404; the report image the model references -> 200 image/png, nosniff, bytes hashing to its name', async () => {
    assert.ok(report, 'pick-writes-answer published the report');
    const unknown = `${randomBytes(32).toString('hex')}.png`;
    const miss = await httpGet(`${url}assets/${unknown}`);
    assert.equal(miss.status, 404, `unknown: ${miss.status}`);
    const bad = await httpGet(`${url}assets/not-a-hash.png`);
    assert.equal(bad.status, 404, `malformed: ${bad.status}`);
    const src = report.images.map((i) => i.src).find((s) => /\.png$/.test(s));
    const hit = await httpGet(`${url}${src}`);
    assert.equal(hit.status, 200, `referenced: ${hit.status}`);
    assert.equal(hit.headers['content-type'], 'image/png');
    assert.equal(hit.headers['x-content-type-options'], 'nosniff');
    const sha = createHash('sha256').update(hit.bytes).digest('hex');
    assert.equal(`assets/${sha}.png`, src, 'the bytes hash to the asset name');
    return { unknown: { path: `/assets/${unknown}`, status: miss.status }, malformed: { path: '/assets/not-a-hash.png', status: bad.status }, referenced: { path: `/${src}`, status: hit.status, type: hit.headers['content-type'], nosniff: hit.headers['x-content-type-options'], bytes: hit.bytes.length } };
  });

  // 보고서 블록 (todo 8): the six kinds drawn natively with hostile strings as text; a checklist tick kept in this browser only
  // (localStorage, never sent) through a re-render and a reload; the compare's 이걸로 고르기 through the decision's own confirm row
  await scenario('blocks', '보고서 블록: six kinds as native table/SVG/dl/ol with hostile strings as text; a checklist tick survives re-render and reload and is never sent; the compare picks B through the confirm row and writes answers/<id>.json', async () => {
    const H = '<img src=x onerror="window.__blkXss=1"></svg>javascript:alert(1)';
    const pub = await published(A, briefOf('상황판 점검', '보고서 블록', {
      decisions: [{ question: '아이콘 세트를 무엇으로 할까요?', options: { A: { text: 'Lucide (ISC)', consequence: '약 11 KB' }, B: { text: 'Tabler (MIT)', consequence: '약 17 KB' } },
        recommend: 'A', reason: '가장 작고 라이선스가 단순함', blocks: false }],
      reports: [{ id: 'blocks-demo', title: '보고서 블록 예시', summary: H, decisionIndex: 0, blocks: [
        { kind: 'compare', title: '아이콘 세트 비교', decisionIndex: 0, rows: [{ label: '30개 크기', A: '약 10.9 KB', B: '약 17.1 KB' }, { label: H.slice(0, 40), A: H, B: 'MIT' }, LONG_ROW] },
        { kind: 'bars', title: '상황판 한 페이지의 무게', unit: 'KB', items: [{ label: '데이터(뷰 모델)', value: 467.7 }, { label: H.slice(0, 40), value: 0.1 + 0.2 }] },
        { kind: 'table', title: H, columns: ['항목', '지금', '차이표 행'], rows: [['홈 위치', '네 번째 칸', 2], [H, '</svg>', 13]] },
        { kind: 'kv', title: '정한 값', items: [{ key: '아이콘', value: 'Lucide (ISC)' }, { key: H.slice(0, 40), value: H }] },
        { kind: 'flow', title: '진행 단계', steps: [{ label: '조사', state: 'done' }, { label: '</svg><b>', state: 'doing' }, { label: '검증' }] },
        { kind: 'checklist', title: '시안에서 볼 것', items: [{ id: 'themes', text: '어둡게·밝게 둘 다 읽기 편하다' }, { id: 'hostile', text: H }] },
      ] }],
    }));
    await waitApplied(page, pub.seq);
    await showPage(page, 'lead-A', 'rep');
    const blk = (n) => `#main [data-block="rep/blocks-demo/blk/${n}"]`;
    const drawn = await page.eval(`(() => {
      const r = document.querySelector('#main [data-block="rep/blocks-demo"]');
      const qa = (n, s) => [...r.querySelectorAll('[data-block="rep/blocks-demo/blk/' + n + '"] ' + s)];
      return {
        figures: [...r.querySelectorAll('figure.rbk')].map((f) => [f.getAttribute('data-block'), [...f.classList].filter((c) => /^rbk/.test(c)).join(' ')]), // annotate.js adds ab, a new block flashes
        recommended: qa(0, 'table.rbk-cmp th.opt.rec .k').map((k) => k.textContent),
        bars: qa(1, 'li.bar-r').map((li) => [li.querySelectorAll('svg.bar-s rect.bar-v').length, li.querySelector('.bar-n').textContent]),
        tableNumbers: qa(2, 'table.rbk-tbl td.num').map((td) => td.textContent),
        kv: qa(3, 'dl.rbk-kvl > dt').length,
        flowSvg: qa(4, '.flowbox svg text').map((t) => t.textContent), flowSteps: qa(4, 'ol.flow-steps > li').length,
        checkKeys: qa(5, 'input[type=checkbox]').map((i) => i.getAttribute('data-check-key')),
        xss: window.__blkXss === 1, imgs: r.querySelectorAll('img').length, scripts: r.querySelectorAll('script').length,
        onAttributes: [...r.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
        jsUrls: r.querySelectorAll('[href^="javascript:"], [src^="javascript:"]').length,
        otherSvg: [...r.querySelectorAll('svg')].map((s) => s.getAttribute('class') || '').filter((c) => !/^(bar-s|flow flow-wide|ic\\b)/.test(c)),
        hostileAsText: (r.textContent.match(/<img src=x onerror=/g) || []).length,
        sideways: document.getElementById('main').scrollWidth - document.getElementById('main').clientWidth,
      };
    })()`);
    assert.deepEqual(drawn.figures, ['compare', 'bars', 'table', 'kv', 'flow', 'checklist'].map((k, n) => [`rep/blocks-demo/blk/${n}`, `rbk rbk-${k}`]));
    assert.deepEqual(drawn.recommended, ['A'], 'the linked decision recommends A');
    assert.deepEqual(drawn.bars, [[1, '467.7 KB'], [1, '0.3 KB']]);
    assert.deepEqual(drawn.tableNumbers, ['2', '13']);
    assert.equal(drawn.kv, 2);
    assert.deepEqual(drawn.flowSvg, ['조사', '</svg><b>', '검증'], 'a hostile step label is SVG text');
    assert.equal(drawn.flowSteps, 3);
    assert.deepEqual(drawn.checkKeys, ['themes', 'hostile'].map((id) => `omo-briefing.check.lead-A.blocks-demo.${id}`));
    assert.deepEqual([drawn.xss, drawn.imgs, drawn.scripts, drawn.onAttributes, drawn.jsUrls, drawn.otherSvg], [false, 0, 0, 0, 0, []], J(drawn));
    assert.ok(drawn.hostileAsText >= 8, `the hostile string shows as text: ${drawn.hostileAsText}`);
    assert.ok(drawn.sideways <= 1, `no sideways scroll in #main: ${drawn.sideways}`);

    // the tick: stored under its key, and no request carries it (tick, re-render, reload)
    const key = 'omo-briefing.check.lead-A.blocks-demo.themes';
    const box = `${blk(5)} input[data-check-key="${key}"]`;
    const requests = [];
    const onRequest = (p) => requests.push({ method: p.request.method, url: p.request.url, post: p.request.postData || '' });
    page.client.listeners.set('Network.requestWillBeSent', [...(page.client.listeners.get('Network.requestWillBeSent') || []), onRequest]);
    await page.client.send('Network.enable');
    const tickState = `(() => { const i = document.querySelector(${J(box)}); return { checked: !!i && i.checked, stored: localStorage.getItem(${J(key)}), meta: document.querySelector(${J(blk(5) + ' .rbk-m')}).textContent }; })()`;
    let ticked, reRendered, reloaded, tickWindow;
    try {
      await click(page, box);
      ticked = await waitDom(page, `(() => { const s = ${tickState}; return s.checked && s.stored === '1' ? s : null; })()`, { label: 'the tick stored under its key' });
      tickWindow = requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
      await showPage(page, 'lead-A', 'ov'); // #main drawn anew without the report
      await showPage(page, 'lead-A', 'rep');
      reRendered = await page.eval(tickState);
      await openBoard(page, url, 'desktop');
      await showPage(page, 'lead-A', 'rep');
      reloaded = await page.eval(tickState);
    } finally {
      page.client.listeners.set('Network.requestWillBeSent', (page.client.listeners.get('Network.requestWillBeSent') || []).filter((f) => f !== onRequest));
      await page.client.send('Network.disable');
    }
    const carrying = requests.filter((r) => /omo-briefing\.check|themes/.test(`${r.url} ${r.post}`));
    const expected = { checked: true, stored: '1', meta: '1/2 확인 · 이 브라우저에만\u00a0저장' };
    assert.deepEqual([ticked, reRendered, reloaded], [expected, expected, expected]);
    assert.deepEqual(tickWindow.filter((r) => !r.startsWith('GET ')), [], `the tick itself sends nothing: ${J(tickWindow)}`);
    assert.deepEqual(carrying, [], 'no request carries the tick');

    // the compare: the linked decision's options, 이걸로 고르기 B -> the decision's confirm row under the compare -> 보내기
    const decisionId = await page.eval(`(() => { const s = BriefPage.state.model.sessions.find((x) => x.id === 'lead-A'); const r = s && (s.reports || []).find((x) => x.id === 'blocks-demo'); return r ? r.decisionId : null; })()`);
    assert.ok(Number.isInteger(decisionId), `the report links its decision: ${decisionId}`);
    assert.equal(await page.eval(`document.querySelector(${J(blk(0) + ' .rbk-m')}).textContent`), `#${decisionId} 결정과\u00a0연결`);
    await click(page, `${blk(0)} table .cv-pick[data-dec="${decisionId}"][data-opt="B"]`);
    const sendSel = `${blk(0)} [data-act="ans-send"][data-id="${decisionId}"][data-where="blk"]`;
    const confirm = await waitDom(page, `(() => { const b = document.querySelector(${J(sendSel)}); const row = b && b.closest('.ans-confirm'); return row ? row.textContent : null; })()`, { label: 'the confirm row under the compare' });
    assert.ok(confirm.includes('B를 보낼까요?'), `the confirm row asks for B: ${confirm}`);
    await page.eval(`(document.querySelector(${J(blk(0))}).scrollIntoView({ block: 'center' }), true)`);
    await frames(page);
    await page.screenshot(path.join(OUT, 'desktop-blocks-pick.png'));
    const answerFile = path.join(answersDir(), `${pad6(decisionId)}.json`);
    assert.equal(existsSync(answerFile), false, 'no answer before 보내기');
    const written = pending(until(answersDir(), () => (existsSync(answerFile) ? readJson(answerFile) : null), `answers/${pad6(decisionId)}.json`));
    await click(page, sendSel);
    const ans = await written;
    assert.deepEqual([ans.id, ans.option, ans.fromSessionId], [decisionId, 'B', 'board']);
    const chosen = await waitDom(page, `(() => { const f = document.querySelector(${J(blk(0))}); const c = f && f.querySelector('table th.opt.chosen .k'); const picks = f ? [...f.querySelectorAll('.cv-pick')] : [];
      return c && picks.length === 4 && picks.every((b) => b.disabled) ? { chosen: c.textContent, picksDisabled: picks.length } : null; })()`, { label: 'B chosen in the compare, every pick disabled' });

    // captures: dark and light at 1440x900 (top: compare, bars, table; bottom: kv, flow, checklist), with the mouse on the
    // rail's empty strip (no hover outline) and the answer's 900 ms change glow over
    await mouse(page, 'mouseMoved', 8, 760);
    await waitDom(page, `!document.querySelector('#main .flash')`, { label: 'the change glow over' });
    const motion = await page.eval(`matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'`);
    const captures = ['desktop-blocks-pick.png'];
    try {
      for (const scheme of ['dark', 'light']) {
        await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: motion }] });
        for (const [part, n] of [[1, 0], [2, 3]]) {
          await page.eval(`(() => { document.querySelector(${J(blk(n))}).scrollIntoView({ block: 'start' }); document.getElementById('main').scrollBy(0, -110); return true; })()`);
          await frames(page);
          const name = `desktop-blocks-${scheme}-${part}.png`;
          await page.screenshot(path.join(OUT, name));
          captures.push(name);
        }
      }
    } finally {
      await emulateMotion(page, motion);
    }
    return { report: 'blocks-demo', drawn, tick: { key, ticked, reRendered, reloaded, tickWindow, requestsSeen: requests.length, requestsCarryingTick: carrying.length },
      compare: { decisionId, confirmRow: confirm, answerFile: `answers/${pad6(decisionId)}.json`, answer: { id: ans.id, option: ans.option, fromSessionId: ans.fromSessionId }, chosen }, captures };
  });
  return { page, url };
}

async function handoverRun({ page, url }) {
  // (i) an old-generation page / old-shape data.js in STATE does not change what the server serves
  await scenario('i', 'GET / is generation 4 and SSE carries plan and live even with old-shape files in STATE', async () => {
    writeFileSync(path.join(STATE, 'index.html'), '<!doctype html><html><body>old generation page without a marker</body></html>');
    writeFileSync(path.join(STATE, 'data.js'), '/* seq:3 */\nwindow.__briefData && window.__briefData({"schema":1,"seq":3,"generatedAt":1,"summary":{},"readErrors":[],"sessions":[]});\n');
    const root = await httpGet(url);
    assert.equal(root.status, 200);
    assert.ok(root.body.includes('<meta name="omo-briefing-generation" content="4">'), 'generation marker 4');
    assert.ok(!root.body.includes('old generation page'));
    const frame = await firstSseFrame(url);
    const withPlan = frame.sessions.find((s) => s.id === 'lead-A');
    assert.ok(withPlan.plan && withPlan.plan.tasks.length === 12, 'plan in the SSE vm');
    assert.ok(withPlan.live && withPlan.live.workers.length === 3, 'live workers in the SSE vm');
    assert.equal(frame.gen, 4);
    return { rootGeneration4: true, sseHasPlanTasks: withPlan.plan.tasks.length, sseHasLiveWorkers: withPlan.live.workers.length };
  });

  // (g) the owner dies: pages see it, the other conversation takes over, pages reconnect on their own
  await scenario('g', 'owner killed: page shows 연결 끊김, B takes the server over, page reconnects and shows the next publish', async () => {
    const before = readJson(path.join(STATE, 'server.json'));
    assert.equal(before.pid, A.pid, 'A owns the server');
    leadReports['lead-A'] = await A.call('deliveries');
    const lost = pending(waitStatus(page, { includes: '실시간 연결 끊김' }));
    expectDisconnect = true;
    const killedAt = Date.now();
    A.child.kill('SIGKILL');
    await A.closed;
    await lost;
    const lostAt = Date.now();
    await waitStatus(page, { hidden: true });
    expectDisconnect = false;
    const reconnectedAt = Date.now();
    const after = await until(STATE, () => { const r = readJson(path.join(STATE, 'server.json')); return r.pid === B.pid ? r : null; }, 'server.json names B');
    const pub = await published(B, briefOf('두 번째 대화', '인계 뒤 첫 보고'));
    await waitApplied(page, pub.seq);
    return { oldPort: before.port, newPort: after.port, samePort: before.port === after.port, notNoticedUntilMs: lostAt - killedAt, reconnectedAfterMs: reconnectedAt - killedAt, newOwnerPid: after.pid };
  });

  // (h) file origin: auto-apply within 2.5s while visible, plus the link to the live view
  await scenario('h', 'file:// page applies a publication within 2.5s and offers the live-view link', async () => {
    await openBoard(page, pathToFileURL(path.join(STATE, 'index.html')).href, 'file');
    assert.equal(await page.eval('BriefPage.transport()'), 'file');
    const pub = await published(B, briefOf('두 번째 대화', '파일 화면에서 보는 보고'));
    const appliedAt = await waitApplied(page, pub.seq, 8000);
    const latency = appliedAt - pub.at;
    assert.ok(latency <= 2500, `file page latency ${latency}ms`);
    const link = await page.eval(`(() => { const a = document.getElementById('live-link'); return { hidden: a.hidden, text: a.textContent, href: a.href }; })()`);
    assert.ok(!link.hidden && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(link.href) && link.text.includes('실시간 보기 열기'), J(link));
    return { latencyMs: latency, link };
  });

  // the file page cannot send anything: no token, copy instead of send, no answer buttons
  await scenario('file-no-send', 'the file:// page has no send: no write token, its tray offers Markdown 복사 with the 실시간 상황판에서 보내기 hint and no 보내기, no answer or 이걸로 고르기 buttons', async () => {
    const base = await page.eval(`({ transport: BriefPage.transport(), live: BriefPage.state.ui.live, token: !!document.querySelector('meta[name="omo-board-token"]'),
      mode: (document.querySelector('meta[name="omo-briefing-mode"]') || {}).content || null })`);
    assert.deepEqual(base, { transport: 'file', live: false, token: false, mode: 'file' });
    await showPage(page, 'lead-A', 'ov');
    await scrollMainTop(page);
    await annotateBlock(page, 'lead-A', '#main [data-block="now"]', '파일 화면에서 단 주석');
    const ov = await page.eval(`(() => {
      const t = document.querySelector('#main [data-ann-tray]');
      return { send: t.querySelectorAll('[data-ann-act="send"]').length, copy: [...t.querySelectorAll('[data-ann-act="copy"]')].map((b) => b.textContent),
        hint: (t.querySelector('.tray-hint') || {}).textContent || null, decisionCards: document.querySelectorAll('#main .cv-dc').length,
        answerBoxes: document.querySelectorAll('#main .ans-box').length, answerActs: document.querySelectorAll('#main [data-act^="ans-"]').length,
        readOnlyNote: !!document.querySelector('#main .note.ro') };
    })()`);
    assert.equal(ov.send, 0, 'no 보내기 in the tray');
    assert.equal(ov.copy.length, 1, `Markdown 복사 instead: ${J(ov.copy)}`);
    assert.equal(ov.hint, '실시간 상황판에서 보내기');
    assert.ok(ov.decisionCards >= 1 && ov.answerBoxes === 0 && ov.answerActs === 0 && ov.readOnlyNote, `open decisions shown read-only: ${J(ov)}`);
    await frames(page);
    await page.screenshot(path.join(OUT, 'desktop-file-page.png'));
    await showPage(page, 'lead-A', 'rep');
    const rep = await page.eval(`({ reports: document.querySelectorAll('#main .rep').length, picks: document.querySelectorAll('#main .cv-pick, #main [data-act="ans-pick"]').length,
      answerActs: document.querySelectorAll('#main [data-act^="ans-"]').length })`);
    assert.ok(rep.reports >= 1 && rep.picks === 0 && rep.answerActs === 0, `보고서 without 이걸로 고르기: ${J(rep)}`);
    return { page: base, overview: ov, reports: rep, capture: 'desktop-file-page.png' };
  });

  // (j) /brief off
  await scenario('j', '/brief off: the open page says 브리핑 꺼짐', async () => {
    await openBoard(page, serverUrl(), 'http-again');
    assert.equal(await page.eval('BriefPage.transport()'), 'http');
    const off = pending(waitStatus(page, { includes: '브리핑 꺼짐' }));
    expectDisconnect = true;
    await B.call('command', { name: 'brief', args: 'off' });
    const text = await off;
    assert.equal(existsSync(path.join(STATE, 'server.lock')), false, 'the paused owner let go of the lock');
    await B.call('command', { name: 'brief', args: 'on' });
    await waitStatus(page, { hidden: true });
    expectDisconnect = false;
    return { status: text, reconnectedAfterOn: true };
  });
}

// ------------------------------------------------------------------ 390x844 run: helpers

const MOBILE = { name: '390x844', width: 390, height: 844 };
const shot = async (page, name) => { await page.screenshot(path.join(OUT, name)); return name; };
// Captures the mobile run must leave (checked at the end next to the first-pass mobile-{board,plan,workers,alarm}.png).
const MOBILE_CAPTURES = [
  'mobile-plan-folded', 'mobile-plan-open', 'mobile-plan-closed', 'mobile-plan-reopened',
  'mobile-c-before', 'mobile-c-held', 'mobile-c-after',
  'mobile-d-before', 'mobile-d-mid', 'mobile-d-after',
  'mobile-e-before', 'mobile-e-mid', 'mobile-e-after',
  'mobile-g-before', 'mobile-g-disconnected', 'mobile-g-after',
  'mobile-blocks-dark-1', 'mobile-blocks-dark-2', 'mobile-blocks-light-1', 'mobile-blocks-light-2',
].map((n) => `${n}.png`);
const DESKTOP_CAPTURES = ['desktop-state.png', 'desktop-annotation-sent.png', 'desktop-report-pick.png', 'desktop-file-page.png',
  'desktop-blocks-pick.png', 'desktop-blocks-dark-1.png', 'desktop-blocks-dark-2.png', 'desktop-blocks-light-1.png', 'desktop-blocks-light-2.png'];

// Fresh workers of lead-B for d-mobile (lead-A's workers are already finished and its process is gone).
const MOBILE_WORKERS = [
  { id: 'st_qm1', name: '모바일 조사', kind: 'explore' },
  { id: 'st_qm2', name: '모바일 구현', kind: 'implementation' },
  { id: 'st_qm3', name: '모바일 시험', kind: 'tester' },
];
let mobileTick = 0;
const mobileSnapshot = (states) => {
  mobileTick += 1000;
  return {
    parent_session_id: 'senpi:lead-B',
    tasks: MOBILE_WORKERS.map((w, i) => ({
      task_id: w.id, parent_session_id: 'lead-B', task_summary: w.name, agent_type: w.kind,
      resolved_model: { display: 'Sol 6.1', model_id: 'sol-6.1' }, status: states[i],
      created_at: iso(-90_000), updated_at: iso(mobileTick), ...(states[i] === 'running' ? {} : { terminal_at: iso(mobileTick) }),
      live_progress: { started_at: iso(-89_000), current_tool: 'read', last_assistant_line: `${w.name} 진행 중` },
    })),
  };
};

async function mobileRun() {
  const page = await launchTracked({ width: MOBILE.width, height: MOBILE.height }, 'mobile'); // default autoplay policy: sound needs a gesture
  await page.addInitScript(INIT_SCRIPT);
  await emulateMotion(page, 'no-preference');
  activeView = { name: MOBILE.name, page, expect: { width: MOBILE.width, height: MOBILE.height } };
  await openBoard(page, serverUrl(), 'mobile'); // connected here, before every trigger below
  notePids(page);
  // The shell never lets the document scroll sideways by itself, so the shell's own scroller #main is measured as well.
  await scenario('m-fit', 'mobile first paint fits the 390px width (no sideways scroll in the document or in #main)', async () => {
    const fit = await page.eval(`(() => {
      const main = document.getElementById('main');
      const de = document.documentElement;
      const fitsDoc = () => de.scrollWidth <= innerWidth + 1;
      const fitsMain = () => main.scrollWidth <= main.clientWidth + 1;
      const r = main.getBoundingClientRect();
      const edge = Math.min(innerWidth, r.left + main.clientLeft + main.clientWidth);
      const over = (e) => e.getBoundingClientRect().right > edge + 1 && getComputedStyle(e).position !== 'fixed';
      const label = (e) => e.tagName.toLowerCase() + '.' + [...e.classList].join('.') + ' right=' + Math.round(e.getBoundingClientRect().right) + ' ws=' + getComputedStyle(e).whiteSpace + ' text=' + (e.textContent || '').trim().slice(0, 40);
      const overs = [...main.querySelectorAll('*')].filter(over);
      // the innermost overflowing elements: the ones that make their parents wide
      const wide = overs.filter((e) => ![...e.children].some(over)).slice(0, 8).map(label);
      // which element forces the width: hiding it alone brings #main and the page back inside (deepest such elements)
      let culprits = [];
      if (!fitsDoc() || !fitsMain()) {
        const fixers = new Set(overs.filter((e) => { const d = e.style.display; e.style.display = 'none'; const ok = fitsDoc() && fitsMain(); e.style.display = d; return ok; }));
        culprits = [...fixers].filter((e) => ![...e.children].some((c) => fixers.has(c))).slice(0, 6).map(label);
      }
      return { shown: BriefPage.state.ui.active || 'overview', docScrollWidth: de.scrollWidth, innerWidth, mainScrollWidth: main.scrollWidth, mainClientWidth: main.clientWidth, wide, culprits };
    })()`);
    assert.ok(fit.docScrollWidth <= fit.innerWidth + 1 && fit.mainScrollWidth <= fit.mainClientWidth + 1, J(fit));
    return fit;
  });
  await shot(page, 'mobile-board.png');

  const planToggle = (id, key) => `#main [data-act="exp"][data-key="${key}${id}"]`;
  const planOpen = (id, key) => page.eval(`(() => { const t = document.querySelector(${J(planToggle(id, key))}); return t ? t.getAttribute('aria-expanded') === 'true' : null; })()`);
  await scenario('f-mobile', 'plan at 390x844: lanes stack with ↓, anchors unique, no sideways scroll', async () => {
    await showPage(page, 'lead-A', 'plan');
    const id = await page.eval(`document.querySelector('#main [data-plan]').getAttribute('data-plan')`);
    for (const key of ['plan:', 'plan-tasks:', 'plan-out:']) {
      const state = await planOpen(id, key);
      assert.notEqual(state, null, `${key} toggle exists`);
      if (!state) await jsClick(page, planToggle(id, key));
    }
    const shape = await page.eval(`(() => {
      const main = document.getElementById('main');
      const lanes = [...document.querySelectorAll('#main .plan-lane')];
      const tops = lanes.map((l) => l.getBoundingClientRect().top + main.scrollTop);
      return { count: lanes.length, stacked: tops.every((t, i) => i === 0 || t > tops[i - 1]),
        arrow: getComputedStyle(lanes[0], '::after').content,
        overflowX: document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1 };
    })()`);
    assert.equal(shape.count, 4);
    assert.ok(shape.stacked, 'lanes are stacked top to bottom');
    assert.ok(shape.arrow.includes('↓'), `arrow ${shape.arrow}`);
    assert.equal(shape.overflowX, false, 'no sideways scroll');
    const anchors = await page.eval(`[...document.querySelectorAll('#main [data-anchor]')].map((e) => e.getAttribute('data-anchor'))`);
    assert.equal(new Set(anchors).size, anchors.length);
    await page.eval(`(document.querySelector('#main .plan-expanded').scrollIntoView({ block: 'start' }), true)`);
    await frames(page);
    await shot(page, 'mobile-plan.png');
    return shape;
  });

  await showPage(page, 'lead-A', 'wk');
  await frames(page);
  await shot(page, 'mobile-workers.png');

  // Folded / open / closed / reopened, each framed. The folded summary is measured as real lines (not a node count), the open plan
  // must carry exactly the expected anchors, and a reopen must lay out like the first open.
  await scenario('plan-fold-mobile', 'plan at 390x844: the folded summary is two framed lines; open, close and reopen keep the exact anchor set and lane layout', async () => {
    await showPage(page, 'lead-A', 'plan');
    const id = await page.eval(`document.querySelector('#main [data-plan]').getAttribute('data-plan')`);
    const setPlan = async (open) => {
      if ((await planOpen(id, 'plan:')) !== open) await jsClick(page, planToggle(id, 'plan:'));
      assert.equal(await planOpen(id, 'plan:'), open, `the plan is ${open ? 'open' : 'closed'}`);
      if (!open) return;
      for (const key of ['plan-tasks:', 'plan-out:']) {
        const state = await planOpen(id, key);
        assert.notEqual(state, null, `${key} toggle exists in the open plan`);
        if (!state) await jsClick(page, planToggle(id, key));
      }
    };
    // an element framed at the top of #main, just under the sticky sub-tab bar and tray
    const frameTop = (selector) => page.eval(`(() => {
      const main = document.getElementById('main');
      const el = document.querySelector(${J(selector)});
      const below = [...main.querySelectorAll('.stabs, .ann-tray')].filter((s) => getComputedStyle(s).position === 'sticky')
        .reduce((m, s) => Math.max(m, s.getBoundingClientRect().bottom), main.getBoundingClientRect().top);
      main.scrollTop += el.getBoundingClientRect().top - below - 8;
      return Math.round(below);
    })()`);
    const frameFolded = async (file) => {
      await page.eval(`(document.querySelector('#main [data-plan]').scrollIntoView({ block: 'center' }), true)`);
      const geo = await page.eval(`(() => {
        const plan = document.querySelector('#main [data-plan]');
        const r = plan.getBoundingClientRect();
        const m = document.getElementById('main').getBoundingClientRect();
        return { collapsed: plan.classList.contains('plan-collapsed'), anchors: plan.querySelectorAll('[data-anchor]').length,
          lines: [...plan.querySelectorAll('.plan-summary-line')].map((l) => { const b = l.getBoundingClientRect(); return { h: Math.round(b.height * 10) / 10, w: Math.round(b.width) }; }),
          top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
          mainTop: Math.round(m.top), mainBottom: Math.round(m.bottom), mainLeft: Math.round(m.left), mainRight: Math.round(m.right),
          bandPresent: !!document.querySelector('#alarm-band,.alarm-row'), innerWidth, innerHeight };
      })()`);
      assert.ok(geo.collapsed, 'the plan block is folded');
      assert.equal(geo.lines.length, 2, `two summary lines: ${J(geo.lines)}`);
      assert.ok(geo.lines.every((l) => l.h > 0 && l.h <= 30), `each summary line is one text line high: ${J(geo.lines)}`);
      assert.equal(geo.anchors, 0, 'a folded plan carries no anchor');
      assert.equal(geo.bandPresent, false);
      assert.ok(geo.top >= geo.mainTop && geo.bottom <= Math.min(geo.innerHeight, geo.mainBottom) && geo.left >= geo.mainLeft && geo.right <= geo.mainRight,
        `the folded summary is fully inside #main, below tabs: ${J(geo)}`);
      await shot(page, file);
      return geo;
    };
    const checkOpen = async () => {
      const anchors = await page.eval(`[...document.querySelectorAll('#main [data-anchor]')].map((e) => e.getAttribute('data-anchor'))`);
      assert.equal(new Set(anchors).size, anchors.length, 'no duplicate anchor');
      assert.deepEqual([...anchors].sort(), [...expectedAnchors(id)].sort(), 'every plan element has exactly one anchor');
      const shape = await page.eval(`(() => {
        const main = document.getElementById('main');
        const root = document.querySelector('#main .plan-expanded');
        const lanes = [...document.querySelectorAll('#main .plan-lane')];
        const top0 = root.getBoundingClientRect().top;
        return { count: lanes.length, offsets: lanes.map((l) => Math.round((l.getBoundingClientRect().top - top0) * 10) / 10),
          arrow: getComputedStyle(lanes[0], '::after').content,
          overflowX: document.documentElement.scrollWidth > innerWidth + 1 || main.scrollWidth > main.clientWidth + 1 };
      })()`);
      assert.equal(shape.count, 4);
      assert.ok(shape.offsets.every((t, i) => i === 0 || t > shape.offsets[i - 1]), 'lanes are stacked top to bottom');
      assert.ok(shape.arrow.includes('↓'), `arrow ${shape.arrow}`);
      assert.equal(shape.overflowX, false, 'no sideways scroll');
      return { anchors: anchors.length, offsets: shape.offsets };
    };

    await setPlan(false);
    const folded = await frameFolded('mobile-plan-folded.png');
    await setPlan(true);
    const open = await checkOpen();
    await frameTop('#main .plan-expanded');
    await shot(page, 'mobile-plan-open.png');
    await setPlan(false);
    const closed = await frameFolded('mobile-plan-closed.png');
    await setPlan(true);
    const reopened = await checkOpen();
    assert.ok(reopened.offsets.length === open.offsets.length && reopened.offsets.every((t, i) => Math.abs(t - open.offsets[i]) <= 1),
      `the reopened plan lays out like the first open: ${open.offsets} vs ${reopened.offsets}`);
    await frameTop('#main .plan-expanded');
    await shot(page, 'mobile-plan-reopened.png');
    return {
      planId: id,
      folded: { lineHeights: folded.lines.map((l) => l.h), top: folded.top, bottom: folded.bottom, bandBottom: folded.bandBottom, anchors: folded.anchors },
      open: { anchors: open.anchors, laneOffsets: open.offsets },
      closed: { lineHeights: closed.lines.map((l) => l.h), top: closed.top, bottom: closed.bottom, bandBottom: closed.bandBottom, anchors: closed.anchors },
      reopened: { anchors: reopened.anchors, laneOffsets: reopened.offsets },
      captures: ['mobile-plan-folded.png', 'mobile-plan-open.png', 'mobile-plan-closed.png', 'mobile-plan-reopened.png'],
    };
  });

  // (c) on the phone: select the headline, publish a newer seq, the page must hold it; release must apply within 300 ms.
  await scenario('c-mobile', 'mobile: a text selection holds the update (badge) and release applies within 300ms', async () => {
    await showPage(page, 'lead-B', 'ov');
    await scrollMainTop(page);
    const hl = '#main .cv-hl';
    const headlineBefore = await page.eval(`document.querySelector(${J(hl)}).textContent`);
    await shot(page, 'mobile-c-before.png');
    const selected = await page.eval(`(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector(${J(hl)})); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return String(s).length; })()`);
    assert.ok(selected > 0, 'the headline text is selected');
    const NEW_HEADLINE = '모바일에서 글자를 고르는 동안 바뀐 내용';
    const badgeShown = pending(waitDom(page, `!document.getElementById('new-badge').hidden`, { label: 'the held-update badge' }));
    const pub = await published(B, briefOf('두 번째 대화', NEW_HEADLINE));
    await badgeShown;
    const held = await page.eval(`({ applied: BriefPage.state.seq, badge: !document.getElementById('new-badge').hidden, badgeText: document.getElementById('new-badge').textContent,
      busy: BriefPage.busy(), selected: String(getSelection()).length, hl: document.querySelector(${J(hl)}).textContent })`);
    assert.ok(held.applied < pub.seq && held.badge && held.busy && held.selected > 0 && held.hl === headlineBefore, `held: ${J(held)}`);
    await shot(page, 'mobile-c-held.png');
    const t0 = await page.eval('(() => { const t = Date.now(); getSelection().removeAllRanges(); return t; })()');
    const appliedAt = await waitApplied(page, pub.seq);
    const delta = appliedAt - t0;
    assert.ok(delta <= 300, `applied ${delta}ms after the selection ended`);
    const after = await page.eval(`({ hl: document.querySelector(${J(hl)}).textContent, badge: !document.getElementById('new-badge').hidden, seq: BriefPage.state.seq })`);
    assert.ok(after.hl.includes(NEW_HEADLINE) && !after.badge && after.seq >= pub.seq, `released: ${J(after)}`);
    await shot(page, 'mobile-c-after.png');
    return {
      heldBadge: held.badgeText, seqWhileSelected: held.applied, publishedSeq: pub.seq, headlineWhileHeld: held.hl, appliedAfterReleaseMs: delta,
      captures: ['mobile-c-before.png', 'mobile-c-held.png', 'mobile-c-after.png'],
    };
  });

  // (d) on the phone: lead-B's fresh workers run, one finishes and sinks (350 ms move, caught in flight for the capture), again under
  // reduced motion (no animation, no pulse), then the conversation finishes and leaves the sidebar's 진행 중 list for 끝남.
  await scenario('d-mobile', 'mobile workers: running pulse, the finished row sinks with a 350ms move, none under reduced motion; the finished conversation leaves the sidebar 진행 중 filter for 끝남', async () => {
    await showPage(page, 'lead-B', 'wk');
    const rowsOf = workerRows('#main');
    const threeRunning = pending(waitDom(page, `document.querySelectorAll('#main .w-running').length === 3`, { label: "three running worker rows on lead-B's 작업자 page" }));
    await B.call('rpc', { data: mobileSnapshot(['running', 'running', 'running']) });
    await threeRunning;
    const initial = await page.eval(`(() => {
      const dot = document.querySelector('#main .w-running > .w-dot');
      return { order: ${rowsOf}, running: document.querySelectorAll('#main .w-running').length,
        pulse: dot ? getComputedStyle(dot).animationName : null, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
    })()`);
    assert.equal(initial.running, 3);
    assert.equal(initial.pulse, 'w-pulse');
    assert.equal(initial.reduced, false);
    assert.deepEqual([...initial.order].sort(), MOBILE_WORKERS.map((w) => w.id).sort(), 'the page shows the three mobile workers');
    await shot(page, 'mobile-d-before.png');

    // normal motion: the first row finishes and sinks
    const mover1 = initial.order[0];
    const probe1 = moveProbeFor(page, '#main', mover1, { freeze: true });
    await B.call('rpc', { data: mobileSnapshot(MOBILE_WORKERS.map((w) => (w.id === mover1 ? 'completed' : 'running'))) });
    const normal = await probe1;
    await shot(page, 'mobile-d-mid.png'); // animations paused 50 ms into the move
    await finishFrozen(page);
    // The rows are compared BY NAME, in DOM order: the row that finishes starts on top, ends last, and the others keep their order.
    assert.equal(initial.order.indexOf(mover1), 0, 'the row that finishes starts on top');
    assert.deepEqual(normal.order, [...initial.order.filter((id) => id !== mover1), mover1],
      `row names before ${initial.order} and after the first completion ${normal.order}`);
    assert.ok(normal.moverAnimations > 0, 'the moved row has a running animation 50ms after the apply');
    assert.ok(normal.frozen > 0, 'the mid capture caught animations in flight');

    // reduced motion: the next first row finishes; nothing animates and the pulse is off
    let reduced;
    let mover2;
    await emulateMotion(page, 'reduce');
    try {
      mover2 = (await page.eval(rowsOf))[0];
      const probe2 = moveProbeFor(page, '#main', mover2);
      await B.call('rpc', { data: mobileSnapshot(MOBILE_WORKERS.map((w) => (w.id === mover1 || w.id === mover2 ? 'completed' : 'running'))) });
      reduced = await probe2;
    } finally {
      await emulateMotion(page, 'no-preference');
    }
    assert.equal(reduced.reduced, true);
    assert.equal(reduced.moverAnimations, 0, 'no animation under reduced motion');
    assert.equal(reduced.pulseName, 'none', 'the pulse is off');
    await shot(page, 'mobile-d-after.png');
    const finalDone = await page.eval(`[...document.querySelectorAll('#main [data-worker]')].map((r) => r.classList.contains('w-done'))`);
    assert.deepEqual(finalDone, [false, true, true], 'one running row on top, the two finished rows below');
    const finalOrder = await page.eval(rowsOf);
    const stillRunning = initial.order.find((id) => id !== mover1 && id !== mover2);
    assert.equal(finalOrder[0], stillRunning, `the running row stays on top: ${finalOrder}`);
    assert.deepEqual([...finalOrder.slice(1)].sort(), [mover1, mover2].sort(), `the two finished rows are below it: ${finalOrder}`);

    // the conversation finishes: under the sidebar's 진행 중 filter its row goes away, under 끝남 it is listed (script clicks: the
    // overlay sidebar is not shown at this width, and no gesture may unlock audio before e-blocked)
    const rowSel = '#side [data-sh-part="list"] .sh-row[data-row="lead-B"]';
    await jsClick(page, '#side [data-sh="filter"][data-key="run"]');
    assert.deepEqual(await page.eval(`({ filter: BriefPage.state.ui.filter, row: !!document.querySelector(${J(rowSel)}) })`), { filter: 'run', row: true }, 'lead-B is listed under 진행 중');
    const left = pending(waitDom(page, `!document.querySelector(${J(rowSel)})`, { label: 'lead-B leaving the 진행 중 list' }));
    const fin = await published(B, briefOf('두 번째 대화', '모바일에서 마쳤습니다', { status: 'done', done: [{ text: '모두 끝냄', truth: 'reported', applied: 'none' }] }));
    await left;
    await waitApplied(page, fin.seq);
    const status = await page.eval(`(document.querySelector('#main .cv-chips .chip') || {}).textContent || null`);
    assert.ok(status && status.startsWith('끝'), `the page header says it finished: ${status}`);
    await jsClick(page, '#side [data-sh="filter"][data-key="done"]');
    const underDone = await page.eval(`!!document.querySelector(${J(rowSel)})`);
    assert.equal(underDone, true, 'lead-B is listed under 끝남');
    await jsClick(page, '#side [data-sh="filter"][data-key="all"]');
    return {
      pulse: initial.pulse, runningRows: initial.running, finishedRowLast: normal.order.at(-1) === mover1, moverAnimationsAt50ms: normal.moverAnimations,
      animationsInFlightForCapture: normal.frozen, reducedMotionAnimations: reduced.moverAnimations, reducedPulseAnimationName: reduced.pulseName,
      finalRowsDone: finalDone, headerStatus: status, sidebar: { runFilterBefore: true, runFilterAfter: false, doneFilter: underDone },
      rowOrder: { start: initial.order, movedRow: mover1, afterFirstCompletion: normal.order, secondMovedRow: mover2, afterBothCompletions: finalOrder },
      captures: ['mobile-d-before.png', 'mobile-d-mid.png', 'mobile-d-after.png'],
    };
  });

  await scenario('e-blocked', 'alarm without a band: recorded while autoplay is blocked, no tone while locked, one tap, native AudioContext running and owed chime settled', async () => {
    await scrollMainTop(page);
    const pub = await published(B, briefOf('두 번째 대화', '모바일에서 새 질문', { decisions: [decisionOf('모바일 질문')] }));
    await waitApplied(page, pub.seq);
    const blocked = await page.eval(`({ bandPresent: !!document.querySelector('#alarm-band,.alarm-row'), recorded: BriefPage.state.model.waiting.every(w => Number.isFinite(JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}')[w.key])), state: window.__audio.contexts[0] ? window.__audio.contexts[0].state : 'none', starts: window.__audio.starts })`);
    assert.equal(blocked.bandPresent, false);
    assert.equal(blocked.recorded, true);
    assert.equal(blocked.state, 'suspended');
    assert.equal(blocked.starts, 0, 'a locked context starts no oscillator');
    await page.screenshot(path.join(OUT, 'mobile-alarm.png'));
    copyFileSync(path.join(OUT, 'mobile-alarm.png'), path.join(OUT, 'mobile-e-before.png')); // the "before" frame of the e-mobile sequence
    const running = pending(page.eval(`new Promise((resolve, reject) => {
      const c = window.__audio.contexts[0];
      if (c.state === 'running') return resolve('running');
      c.addEventListener('statechange', () => { if (c.state === 'running') resolve('running'); });
      setTimeout(() => reject(new Error('context stayed ' + c.state)), 6000);
    })`));
    // the one tap lands on the rail's empty middle: a gesture that presses nothing
    const target = await page.eval(`(() => { const e = document.elementFromPoint(8, 500); return e ? { tag: e.tagName.toLowerCase(), cls: e.className, control: !!e.closest('button,a,input,textarea,select,[data-sh],[data-act]') } : null; })()`);
    assert.ok(target && !target.control, `the tap point presses nothing: ${J(target)}`);
    await clickAt(page, 8, 500);
    assert.equal(await running, 'running');
    // Native resume handlers were attached before this subscription; no removed UI is used as a completion signal.
    await page.eval(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('native resume did not settle')),6000);Promise.all(window.__audio.resumes).then(()=>{clearTimeout(timer);resolve(true)},e=>{clearTimeout(timer);reject(e)})})`);
    const unlocked = await page.eval(`({ state: window.__audio.contexts[0].state, starts: window.__audio.starts })`);
    assert.equal(unlocked.state, 'running');
    assert.ok(unlocked.starts === 0 || unlocked.starts === 2, `the owed chime is skipped (0) or one two-tone chime (2): ${unlocked.starts}`);
    await shot(page, 'mobile-e-mid.png');
    return {
      before: blocked.state, after: 'running', bandPresent: blocked.bandPresent, recorded: blocked.recorded, tapTarget: target, startsWhileLocked: blocked.starts, startsAfterUnlock: unlocked.starts, owedChimePlayed: unlocked.starts === 2,
      captures: ['mobile-e-before.png', 'mobile-e-mid.png'],
    };
  });

  // (e) after the unlock: ONE genuinely new waiting decision rings exactly one two-tone chime (two native oscillator starts).
  await scenario('e-mobile', 'mobile alarm after unlock: no band; one new recorded decision starts exactly two oscillators and updates title', async () => {
    const before = await page.eval(`({ title: document.title, starts: window.__audio.starts, state: window.__audio.contexts[0] ? window.__audio.contexts[0].state : 'none',
      bandPresent: !!document.querySelector('#alarm-band,.alarm-row'), seen: Object.keys(JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}')) })`);
    assert.equal(before.state, 'running', 'e-blocked left the context unlocked');
    assert.equal(before.bandPresent, false);
    assert.ok(before.seen.length >= 1, 'waiting alarms remain recorded');
    assert.ok(before.title.startsWith('('), `the title counts what is waiting: ${before.title}`);
    const waitingBefore = Number(before.title.slice(1, before.title.indexOf(')')));
    assert.ok(Number.isInteger(waitingBefore) && waitingBefore >= 1, `waiting count in the title: ${before.title}`);
    await scrollMainTop(page);
    const QUESTION = '모바일 소리 시험 질문';
    const titlePrefix = `(${waitingBefore + 1}) `;
    // subscribed before publication: recorded keys/title and chime update in the same apply
    const shown = pending(waitDom(page, `document.title.startsWith(${J(titlePrefix)}) && !document.querySelector('#alarm-band,.alarm-row') && BriefPage.state.model.waiting.some(w => w.text === ${J(QUESTION)} && Number.isFinite(JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}')[w.key]))`, { label: 'new alarm recorded and counted without a band' }));
    const pub = await published(B, briefOf('두 번째 대화', '모바일 소리 시험', { decisions: [decisionOf(QUESTION)] }));
    await shown;
    await waitApplied(page, pub.seq);
    const after = await page.eval(`({ title: document.title, starts: window.__audio.starts, state: window.__audio.contexts[0].state,
      bandPresent: !!document.querySelector('#alarm-band,.alarm-row'),
      recorded: BriefPage.state.model.waiting.every(w => Number.isFinite(JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}')[w.key])), seen: Object.keys(JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}')) })`);
    assert.equal(after.starts - before.starts, 2, `one chime = two native oscillator starts: ${before.starts} -> ${after.starts}`);
    assert.ok(after.title.startsWith(titlePrefix), `title ${before.title} -> ${after.title}`);
    assert.equal(after.bandPresent, false);
    assert.equal(after.recorded, true, 'the new decision is recorded');
    await shot(page, 'mobile-e-after.png');
    const settled = await page.eval('window.__audio.starts');
    assert.equal(settled, after.starts, 'no late extra tone after the chime');
    return {
      startsBefore: before.starts, startsAfter: after.starts, additionalStarts: after.starts - before.starts, settledStarts: settled,
      titleBefore: before.title, titleAfter: after.title, bandPresent: after.bandPresent, recordedBefore: before.seen.length, recordedAfter: after.seen.length, contextState: after.state,
      captures: ['mobile-e-before.png', 'mobile-e-mid.png', 'mobile-e-after.png'],
    };
  });

  // (g) on the phone: the page is connected, the owner (B) is killed, lead C takes the server over, the page reconnects by itself.
  // Last on purpose: B is gone afterwards and C owns the board.
  await scenario('g-mobile', 'mobile: owner killed, the page shows 연결 끊김, lead C takes the server over, the page reconnects within 10s and shows the next publish', async () => {
    C = spawnLead('lead-C', STATE, CWD);
    await C.ready;
    await C.call('start');
    const first = await published(C, briefOf('세 번째 대화', '인계를 기다리는 대화'));
    await waitApplied(page, first.seq);
    await showPage(page, 'lead-C', 'ov');
    await shot(page, 'mobile-g-before.png');
    const before = readJson(path.join(STATE, 'server.json'));
    assert.equal(before.pid, B.pid, 'B owns the server before the kill');
    leadReports['lead-B'] = await B.call('deliveries');

    // everything below is subscribed before the kill
    const lost = waitStatus(page, { includes: '실시간 연결 끊김' });
    let takeoverAt = 0;
    const takeover = until(STATE, () => { const r = readJson(path.join(STATE, 'server.json')); return r.pid === C.pid ? r : null; }, 'server.json names lead C', 14_000)
      .then((r) => { takeoverAt = Date.now(); return r; });
    const observers = Promise.allSettled([lost, takeover]); // neither can become an unhandled rejection while the other is awaited
    let lostAt = 0;
    let reconnectedAt = 0;
    let after = null;
    const killedAt = Date.now();
    expectDisconnect = true;
    try {
      B.child.kill('SIGKILL');
      await B.closed;
      await lost;
      lostAt = Date.now();
      await shot(page, 'mobile-g-disconnected.png');
      await waitStatus(page, { hidden: true });
      reconnectedAt = Date.now();
      after = await takeover;
    } finally {
      expectDisconnect = false;
    }
    assert.ok(reconnectedAt - killedAt <= 10_000, `the page reconnected ${reconnectedAt - killedAt}ms after the owner died`);
    const outcome = await observers;
    assert.deepEqual(outcome.map((o) => o.status), ['fulfilled', 'fulfilled']);

    const pub = await published(C, briefOf('세 번째 대화', '모바일 인계 뒤 첫 보고'));
    await waitApplied(page, pub.seq);
    await showPage(page, 'lead-C', 'ov');
    const headline = await page.eval(`document.querySelector('#main .cv-hl').textContent`);
    assert.ok(headline.includes('모바일 인계 뒤 첫 보고'), `the reconnected page shows the next publish: ${headline}`);
    await shot(page, 'mobile-g-after.png');
    return {
      oldPort: before.port, newPort: after.port, samePort: before.port === after.port, oldOwnerPid: before.pid, newOwnerPid: after.pid,
      notNoticedUntilMs: lostAt - killedAt, reconnectedAfterMs: reconnectedAt - killedAt, takeoverAfterMs: takeoverAt - killedAt, headlineAfterReconnect: headline,
      captures: ['mobile-g-before.png', 'mobile-g-disconnected.png', 'mobile-g-after.png'],
    };
  });

  // 보고서 블록 at 390x844 (the report of desktop 'blocks', its decision answered B there): tables as records, the flow as step
  // nodes (no scaled SVG), the compare as one card per option; 44 px controls, no text under 12 px, no sideways scroll; a tick
  // of this browser survives a reload
  await scenario('blocks-mobile', '보고서 블록 at 390x844: records, step nodes (no SVG), one card per option, 44 px controls, >= 12 px text, no sideways scroll; a tick survives a reload', async () => {
    await showPage(page, 'lead-A', 'rep');
    const blk = (n) => `#main [data-block="rep/blocks-demo/blk/${n}"]`;
    const m = await page.eval(`(() => {
      const vis = (e) => !!e && e.checkVisibility();
      const r = document.querySelector('#main [data-block="rep/blocks-demo"]');
      const qa = (n, s) => [...r.querySelectorAll('[data-block="rep/blocks-demo/blk/' + n + '"] ' + s)];
      const main = document.getElementById('main');
      const sizes = [];
      const w = document.createTreeWalker(r.querySelector('.rbks'), NodeFilter.SHOW_TEXT);
      for (let t; (t = w.nextNode());) if (t.data.trim() && vis(t.parentElement)) sizes.push(parseFloat(getComputedStyle(t.parentElement).fontSize));
      const targets = [...r.querySelectorAll('.rbks button, .rbks label')].filter(vis).map((e) => { const b = e.getBoundingClientRect(); return [e.tagName.toLowerCase() + '.' + e.className, Math.round(b.width), Math.round(b.height)]; });
      return {
        compareTable: qa(0, 'table.rbk-cmp').some(vis), cards: qa(0, '.cmpc').filter(vis).map((c) => [...c.classList].filter((x) => /^(cmpc|rec|chosen)$/.test(x)).join(' ')),
        longRow: qa(0, '.cmpc').filter(vis).map((c) => { // its third row is LONG_ROW: rendered widths and the value's line boxes
          const dt = c.querySelectorAll('dt')[2], dd = c.querySelectorAll('dd')[2], rg = document.createRange();
          rg.selectNodeContents(dd);
          return { label: dt.textContent.length, labelPx: Math.round(dt.getBoundingClientRect().width), valuePx: Math.round(dd.getBoundingClientRect().width),
            lines: new Set([...rg.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top))).size };
        }),
        tableHead: qa(2, 'thead').some(vis), recordLabels: qa(2, 'tbody td').filter(vis).map((td) => getComputedStyle(td, '::before').content),
        flowSvg: qa(4, '.flowbox svg').some(vis), steps: qa(4, 'ol.flow-steps > li').filter(vis).map((li) => li.textContent),
        minTextPx: Math.min(...sizes), texts: sizes.length, targets: targets.length, under44: targets.filter((t) => t[1] < 44 || t[2] < 44),
        sideways: { doc: document.documentElement.scrollWidth - innerWidth, main: main.scrollWidth - main.clientWidth },
      };
    })()`);
    assert.equal(m.compareTable, false, 'the compare table gives way to cards');
    assert.deepEqual(m.cards, ['cmpc rec', 'cmpc chosen'], 'A recommended, B chosen on the desktop');
    // a long row label must not take the card: every card's value track keeps >= 120 px and the 43 characters fit in <= 6 lines
    assert.ok(m.longRow.length === 2 && m.longRow.every((r) => r.label === LONG_ROW.label.length && r.valuePx >= 120 && r.lines <= 6), `long compare row readable: ${J(m.longRow)}`);
    assert.equal(m.tableHead, false);
    assert.deepEqual(m.recordLabels.slice(0, 3), ['"항목"', '"지금"', '"차이표 행"'], 'each cell carries its column name');
    assert.equal(m.flowSvg, false, 'no SVG flow below 600 px');
    assert.deepEqual(m.steps, ['1조사끝', '2</svg><b>진행 중', '3검증']);
    assert.ok(m.minTextPx >= 12, `no text under 12 px: ${m.minTextPx}`);
    assert.ok(m.targets > 0 && m.under44.length === 0, `every block control is a 44 px target: ${J(m.under44)}`);
    assert.ok(m.sideways.doc <= 1 && m.sideways.main <= 1, `no sideways scroll: ${J(m.sideways)}`);
    // a tap on the item's row ticks it; this browser's own localStorage keeps it through a reload
    const key = 'omo-briefing.check.lead-A.blocks-demo.hostile';
    const box = `${blk(5)} input[data-check-key="${key}"]`;
    await click(page, `${blk(5)} label:has(> input[data-check-key="${key}"])`);
    await waitDom(page, `localStorage.getItem(${J(key)}) === '1' && document.querySelector(${J(box)}).checked`, { label: 'the tick stored on the phone' });
    await openBoard(page, serverUrl(), 'mobile');
    await showPage(page, 'lead-A', 'rep');
    const reloaded = await page.eval(`(() => { const i = document.querySelector(${J(box)}); return { checked: !!i && i.checked, meta: document.querySelector(${J(blk(5) + ' .rbk-m')}).textContent }; })()`);
    assert.deepEqual(reloaded, { checked: true, meta: '1/2 확인 · 이 브라우저에만\u00a0저장' });
    // captures: dark and light (top: the compare cards; then the flow's step nodes and the checklist), no hover outline
    await mouse(page, 'mouseMoved', 8, 700);
    await waitDom(page, `!document.querySelector('#main .flash')`, { label: 'no change glow' });
    const motion = await page.eval(`matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'`);
    const captures = [];
    try {
      for (const scheme of ['dark', 'light']) {
        await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: motion }] });
        for (const [part, n] of [[1, 0], [2, 4]]) {
          await page.eval(`(() => { document.querySelector(${J(blk(n))}).scrollIntoView({ block: 'start' }); document.getElementById('main').scrollBy(0, -110); return true; })()`);
          await frames(page);
          captures.push(await shot(page, `mobile-blocks-${scheme}-${part}.png`));
        }
      }
    } finally {
      await emulateMotion(page, motion);
    }
    return { ...m, tick: { key, reloaded }, captures };
  });
  return page;
}

// ------------------------------------------------------------------ run and clean up

// Chrome keeps scratch folders in the temp root and normally removes them on its own exit; a browser that is killed leaves them. The ones
// made by the QA browsers (the pid in the name is theirs and the name was not there before the run) are removed here and reported in
// result.json (leftByChrome); one that cannot be removed, or whose pid is still alive, makes the cleanup unclean. A decoy folder named
// like Chrome's, planted for a QA browser pid, proves the audit really sees such folders: if it does not, the audit itself fails.
function auditChromeTemp(browserPids) {
  const audit = { tmpRoot: TMP_ROOT, browserPids, baselineEntries: chromeTempBefore ? chromeTempBefore.size : null, selfTest: 'not run', leftByChrome: [], dirs: {}, unattributed: [], errors: [] };
  if (!chromeTempBefore) {
    audit.errors.push('no baseline of chrome_* temp folders was taken before the first browser started');
    return audit;
  }
  const pidSet = new Set(browserPids.map(String));
  const decoy = browserPids.length ? `chrome_omo_qa_selftest_${browserPids[0]}_${Date.now()}` : null;
  try {
    if (decoy) mkdirSync(path.join(TMP_ROOT, decoy));
    const mine = [];
    for (const name of chromeTempNames()) {
      if (chromeTempBefore.has(name)) continue;
      const m = CHROME_TEMP_RE.exec(name);
      if (m && pidSet.has(m[1])) mine.push(name); else audit.unattributed.push(name);
    }
    audit.selfTest = !decoy ? 'skipped: no QA browser was launched' : mine.includes(decoy) ? 'ok' : 'FAILED: the audit did not see the planted decoy folder';
    audit.leftByChrome = mine.filter((n) => n !== decoy);
    for (const name of mine) {
      const dir = path.join(TMP_ROOT, name);
      if (isPidAlive(Number(CHROME_TEMP_RE.exec(name)[1]))) { audit.dirs[name] = 'OWNER ALIVE'; continue; }
      try { rmSync(dir, { recursive: true, force: true }); } catch (err) { audit.errors.push(`rm ${name}: ${err.message}`); }
      audit.dirs[name] = existsSync(dir) ? 'EXISTS' : 'removed';
    }
  } catch (err) {
    audit.errors.push(`audit: ${err.message}`);
  }
  if (decoy && !(decoy in audit.dirs)) { // the audit missed it (or failed before): take the decoy away anyway and say so
    const dir = path.join(TMP_ROOT, decoy);
    try { rmSync(dir, { recursive: true, force: true }); } catch (err) { audit.errors.push(`rm decoy ${decoy}: ${err.message}`); }
    audit.dirs[decoy] = existsSync(dir) ? 'EXISTS' : 'removed';
  }
  return audit;
}

async function cleanup() {
  const cleanupResult = { pids: {}, chromePids: {}, profiles: {}, ports: {}, tempDirs: {}, ancillary: null, errors: [] };
  for (const lead of [A, B, C]) {
    if (!lead) continue;
    try {
      if (lead.alive()) {
        await Promise.race([lead.call('shutdown'), new Promise((r) => setTimeout(r, 5000))]);
        lead.child.kill();
      }
      await lead.closed;
    } catch (err) {
      cleanupResult.errors.push(`lead ${lead.sid}: ${err.message}`);
      if (!lead.child.kill('SIGKILL') && lead.alive()) cleanupResult.errors.push(`lead ${lead.sid}: SIGKILL could not be delivered`);
    }
  }
  for (const page of pages) {
    try { await closePage(page); } catch (err) { cleanupResult.errors.push(`chrome ${page.pid}: ${err.message}`); }
  }
  for (const pid of owned.pids) cleanupResult.pids[pid] = isPidAlive(pid) ? 'ALIVE' : 'gone';
  for (const run of chromeRuns) for (const pid of run.pids) cleanupResult.chromePids[pid] = isPidAlive(pid) ? 'ALIVE' : 'gone';
  for (const p of owned.profiles) cleanupResult.profiles[p] = existsSync(p) ? 'EXISTS' : 'removed';
  for (let port = BASE; port < BASE + PORTS; port++) {
    cleanupResult.ports[port] = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.setTimeout(3000, () => { s.destroy(); resolve('NO ANSWER'); });
      s.once('connect', () => { s.destroy(); resolve('LISTENING'); });
      s.once('error', (err) => resolve(err.code === 'ECONNREFUSED' ? 'closed' : `ERROR ${err.code}`));
    });
  }
  cleanupResult.ancillary = auditChromeTemp(pages.map((p) => p.pid)); // after every QA browser is gone
  for (const d of owned.tempDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { cleanupResult.errors.push(`rm ${d}: ${err.message}`); }
    cleanupResult.tempDirs[d] = existsSync(d) ? 'EXISTS' : 'removed';
  }
  cleanupResult.clean = cleanupResult.errors.length === 0
    && Object.values(cleanupResult.pids).every((v) => v === 'gone')
    && Object.values(cleanupResult.chromePids).every((v) => v === 'gone')
    && chromeRuns.every((r) => Array.isArray(r.aliveAfterClose) && r.aliveAfterClose.length === 0)
    && Object.values(cleanupResult.profiles).every((v) => v === 'removed')
    && Object.values(cleanupResult.ports).every((v) => v === 'closed')
    && Object.values(cleanupResult.tempDirs).every((v) => v === 'removed')
    && cleanupResult.ancillary.errors.length === 0
    && cleanupResult.ancillary.selfTest === 'ok' // an audit that did not run (no QA browser was launched) cannot vouch for the Chrome temp folders
    && Object.values(cleanupResult.ancillary.dirs).every((v) => v === 'removed');
  return cleanupResult;
}

let fatal = null;
let p95doc = null;
let leadMetaErrors = null;
try {
  chromeTempBefore = new Set(chromeTempNames()); // before the first QA browser exists
  p95doc = renderP95();
  console.log(`render p95 ${p95doc.p95Ms}ms (limit 150) over ${p95doc.runs} runs`);
  const store = openStore(STATE);
  seedBoard(store, Date.now());
  A = spawnLead('lead-A', STATE, CWD);
  await A.ready;
  await A.call('start');
  B = spawnLead('lead-B', STATE, CWD);
  await B.ready;
  await B.call('start');
  assert.equal(readJson(path.join(STATE, 'server.json')).pid, A.pid, 'A started the server first');
  assert.ok(readJson(path.join(STATE, 'server.json')).port >= BASE && readJson(path.join(STATE, 'server.json')).port < BASE + PORTS, 'the board listens inside the QA port range');
  await A.call('brief', { input: briefOf('상황판 점검', '시작') });
  await B.call('brief', { input: briefOf('두 번째 대화', '대기 중인 두 번째 대화') });
  await A.call('rpc', { data: snapshot(['running', 'running', 'running']) });
  await until(STATE, () => readJson(path.join(STATE, 'sessions', 'lead-A', 'meta.json')).auto?.live?.workers?.length === 3, 'worker rows saved');
  await A.call('plan', { input: planInput(PLAN_PATH) });
  await A.call('brief', { input: briefOf('상황판 점검', '준비 끝') });

  const ctx = await desktopRun();
  await handoverRun(ctx);
  await collectPageErrors(ctx.page, 'desktop-final');
  // One Chrome at a time: the desktop browser (every process of its profile) is gone before the 390x844 one starts.
  await closePage(ctx.page);
  const mobilePage = await mobileRun();
  await collectPageErrors(mobilePage, 'mobile-final');
  activeView = null; // scenario k judges the whole run
  if (C && C.alive()) leadReports['lead-C'] = await C.call('deliveries');
  leadMetaErrors = Object.fromEntries(['lead-A', 'lead-B', 'lead-C'].map((sid) => {
    try { return [sid, readJson(path.join(STATE, 'sessions', sid, 'meta.json')).errors ?? null]; } catch (err) { return [sid, `unreadable: ${err.message}`]; }
  }));

  await scenario('k', 'no console errors or page exceptions in any run, no failure inside a lead\'s fake host', async () => {
    assert.deepEqual(consoleErrors, []);
    const failures = Object.entries(leadReports).flatMap(([sid, r]) => (r.failures || []).map((f) => `${sid}: ${f}`));
    assert.deepEqual(failures, []);
    return { errors: 0, leadsReported: Object.keys(leadReports) };
  });
  phase = 'teardown';
  for (const view of ['board', 'plan', 'workers', 'alarm']) {
    for (const device of ['desktop', 'mobile']) {
      const file = path.join(OUT, `${device}-${view}.png`);
      if (!existsSync(file) || statSync(file).size < 5000) throw new Error(`missing or tiny screenshot ${file}`);
    }
  }
  for (const name of [...DESKTOP_CAPTURES, ...MOBILE_CAPTURES]) {
    const file = path.join(OUT, name);
    if (!existsSync(file) || statSync(file).size < 5000) throw new Error(`missing or tiny screenshot ${file}`);
  }
} catch (err) {
  fatal = err;
  console.error('FATAL', err);
}

const cleanupResult = await cleanup();
const scenarioIds = ['a', 'b', 'c', 'd', 'e', 'f', 'annotation-delivered', 'pick-writes-answer', 'legacy-501-bad-text', 'forged-origin-403', 'unknown-asset-404', 'blocks', 'i', 'g', 'h', 'file-no-send', 'j', 'k'];
const extra = ['m-fit', 'f-mobile', 'plan-fold-mobile', 'c-mobile', 'd-mobile', 'e-blocked', 'e-mobile', 'g-mobile', 'blocks-mobile'];
const allPass = !fatal
  && scenarioIds.every((id) => results[id] && results[id].pass)
  && extra.every((id) => results[id] && results[id].pass)
  && p95doc && p95doc.pass && cleanupResult.clean;
const doc = {
  pass: allPass,
  finishedAt: new Date().toISOString(),
  fatal: fatal ? String(fatal.stack || fatal) : null,
  portBase: BASE,
  renderP95: p95doc ? { p95Ms: p95doc.p95Ms, limitMs: 150, pass: p95doc.pass, file: 'render-p95.json' } : null,
  viewports: { desktop: '1440x900', mobile: MOBILE.name },
  summary: {
    scenarios: [...scenarioIds, ...extra].length,
    pass: [...scenarioIds, ...extra].filter((id) => results[id] && results[id].pass).length,
    fail: [...scenarioIds, ...extra].filter((id) => !(results[id] && results[id].pass)),
  },
  chrome: chromeRuns,
  mobileScenarios: extra.map((id) => ({ id, pass: Boolean(results[id] && results[id].pass), viewport: results[id] ? results[id].viewport : null })),
  captures: Object.fromEntries([...DESKTOP_CAPTURES, ...MOBILE_CAPTURES].map((n) => [n, existsSync(path.join(OUT, n)) ? statSync(path.join(OUT, n)).size : null])),
  scenarios: results,
  consoleErrors,
  pageErrorReadFailures,
  leadDeliveries: leadReports,
  leadMetaErrors,
  expectedNetworkLogs: { note: "Chrome's own 'Failed to load resource' lines for the live-event stream that the test cut on purpose (owner process killed, /brief off); nothing else is excluded", lines: expectedNetwork },
  teardownLogs: { note: 'console/network lines that appeared after scenario k, while the servers were being shut down', lines: teardownNetwork },
  cleanup: cleanupResult,
};
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(doc, null, 2));
console.log(allPass ? 'ALL PASS' : 'FAILED');
process.exit(allPass ? 0 : 1);
