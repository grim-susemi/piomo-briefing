// Real-browser acceptance run of the generation-4 board (todo 13). No dependencies: Chrome DevTools Protocol through
// scripts/cdp.mjs, the real extension in separate processes (test/helpers/qa-lead.mjs), the real board server host, the real
// store. Everything lives in an owned temp folder, ports 47390+, headless Chrome with an owned temp profile; at the end
// every process, profile, server and folder it made is checked gone.
//
// usage: node scripts/qa-browser.mjs --out <dir>
//   <dir>/result.json        per scenario (a)-(k) pass/fail with the measured values
//   <dir>/render-p95.json    20 renderPage runs on a store built through the real store API
//   <dir>/{desktop,mobile}-{board,plan,workers,alarm}.png   1440x900 and 390x844
// Waits are events with a bound: in-page promises (MutationObserver, apply hook), IPC replies, fs.watch.
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, watch } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, isPidAlive } from './cdp.mjs';
import { openStore } from '../src/store.mjs';
import { renderPage } from '../src/render.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LEAD = path.join(ROOT, 'test/helpers/qa-lead.mjs');
const PLAN_FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/view-model-plan.json'), 'utf8'));
const BASE = 47390;
const NO_AUTOPLAY_FLAG = '--autoplay-policy=no-user-gesture-required';

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
const scenario = async (id, title, fn) => {
  try {
    results[id] = { title, pass: true, ...(await fn()) };
    console.log(`PASS (${id}) ${title}`);
  } catch (err) {
    results[id] = { title, pass: false, error: String((err && err.message) || err) };
    console.error(`FAIL (${id}) ${title}: ${(err && err.message) || err}`);
  }
};
const p95Of = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ------------------------------------------------------------------ pieces: files, http, leads, store seeding

function until(dir, pred, label, ms = 15_000) {
  return new Promise((resolve, reject) => {
    let watcher = null;
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`timeout waiting for ${label}`)); }, ms);
    const check = () => {
      let v = null;
      try { v = pred(); } catch { v = null; } // a file caught in the middle of a replace is simply "not yet"
      if (v) { clearTimeout(timer); watcher.close(); resolve(v); }
    };
    watcher = watch(dir, check);
    check();
  });
}

function httpGet(url, headers = {}) {
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
  const child = fork(LEAD, [state, sid, cwd, String(BASE)], { execArgv: [], windowsHide: true });
  owned.pids.push(child.pid);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    child.once('message', (m) => (m.ready ? resolve(m) : reject(new Error('unexpected first message'))));
    child.once('error', reject);
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.on('message', (m) => {
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  child.on('exit', () => { for (const p of pending.values()) p.reject(new Error(`lead ${sid} exited`)); pending.clear(); });
  const call = (cmd, extra = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`lead ${sid} ${cmd}: no reply in 60s`)); }, 60_000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
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
  W.__audio = { contexts: [], starts: 0 };
  const Orig = W.AudioContext;
  if (Orig) {
    W.AudioContext = function (...a) {
      const c = new Orig(...a);
      W.__audio.contexts.push(c);
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
  const ok = () => ${hidden ? '(el.hidden || !el.textContent)' : `(!el.hidden && el.textContent.includes(${JSON.stringify(includes ?? '')}))`};
  if (ok()) return resolve(el.textContent);
  const mo = new MutationObserver(() => { if (ok()) { mo.disconnect(); clearTimeout(timer); resolve(el.textContent); } });
  mo.observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
  const timer = setTimeout(() => { mo.disconnect(); reject(new Error('status wait timed out: [' + el.textContent + '] hidden=' + el.hidden)); }, ${ms});
})`);

async function click(page, selector) {
  const pt = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pt) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.client.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  }
}

async function clickAt(page, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

// element.click() from script carries no user activation (unlike the CDP mouse events of click()), so the autoplay policy stays untouched
const jsClick = (page, selector) => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('nothing matches ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);

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

const collectPageErrors = async (page, label) => {
  const list = await page.eval('window.__errors || []');
  for (const e of list) consoleErrors.push(`${label}: ${e}`);
};

async function openBoard(page, url, label) {
  await collectPageErrors(page, label).catch(() => {}); // the previous document, if any
  await page.goto(url);
  await page.eval(`new Promise((resolve, reject) => {
    if (Object.keys(window.__applied).length) return resolve(true);
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => (Object.keys(window.__applied).length ? resolve(true) : reject(new Error('first paint never applied'))), 0));
    setTimeout(() => reject(new Error('first paint timeout')), 8000);
  })`);
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

const pages = [];
let A = null;
let B = null;
const pubOf = () => readJson(path.join(STATE, 'published.json'));
const serverUrl = () => `http://127.0.0.1:${readJson(path.join(STATE, 'server.json')).port}/`;
const published = async (lead, input) => {
  await lead.call('brief', { input });
  return pubOf();
};

async function desktopRun() {
  const page = await launch({ width: 1440, height: 900, extraArgs: [NO_AUTOPLAY_FLAG] });
  pages.push(page);
  owned.pids.push(page.pid);
  owned.profiles.push(page.profileDir);
  await page.client.send('Log.enable');
  watchConsole(page, 'desktop');
  await page.addInitScript(INIT_SCRIPT);
  await emulateMotion(page, 'no-preference');
  const url = serverUrl();
  await openBoard(page, url, 'desktop');

  // (e) first load: what is already waiting shows in the band and the title, with no sound
  const firstLoad = await page.eval(`({ rows: document.querySelectorAll('#alarm-band .alarm-row').length, title: document.title, starts: window.__audio.starts })`);

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

  // (b) tab / expanded card / scroll anchor survive an apply that grows a card above the viewport
  await scenario('b', 'apply keeps the tab, the opened card and the card that was at the top of the screen', async () => {
    await click(page, '#tab-run');
    await click(page, '[data-act="exp"][data-key="detail:seed-3"]');
    await page.eval('window.scrollTo(0, 600)');
    const before = await page.eval(`(() => {
      const anchor = BriefPage.captureAnchor();
      const a = document.querySelector('[data-card="lead-B"]').getBoundingClientRect();
      return { anchor, scrollY: window.scrollY, aHeight: a.height, tab: document.querySelector('.app').getAttribute('data-tab'),
        open: document.querySelector('[data-key="detail:seed-3"]').getAttribute('aria-expanded') };
    })()`);
    assert.ok(before.scrollY > 100 && before.anchor, `scrolled: ${JSON.stringify(before)}`);
    const pub = await published(B, briefOf('두 번째 대화', '위 카드에 줄이 늘어남', {
      changes: ['첫 변화', '둘째 변화', '셋째 변화'].map((text) => ({ text, truth: 'reported', applied: 'candidate' })),
    }));
    await waitApplied(page, pub.seq);
    const after = await page.eval(`(() => {
      const el = document.querySelector('[data-card="' + ${JSON.stringify(before.anchor.id)} + '"]');
      return { top: el.getBoundingClientRect().top, aHeight: document.querySelector('[data-card="lead-B"]').getBoundingClientRect().height,
        tab: document.querySelector('.app').getAttribute('data-tab'), open: document.querySelector('[data-key="detail:seed-3"]').getAttribute('aria-expanded') };
    })()`);
    const moved = Math.abs(after.top - before.anchor.top);
    assert.ok(after.aHeight - before.aHeight >= 30, `the card above grew: ${before.aHeight} -> ${after.aHeight}`);
    assert.ok(moved <= 2, `anchor card moved ${moved}px`);
    assert.equal(after.tab, 'run');
    assert.equal(after.open, 'true');
    return { anchorCard: before.anchor.id, movedPx: moved, grewPx: after.aHeight - before.aHeight, tab: after.tab, expandedKept: after.open };
  });

  // (c) text selected -> held with a badge; released -> applied within 300ms
  await scenario('c', 'a text selection holds the update (badge) and release applies within 300ms', async () => {
    await page.eval('window.scrollTo(0, 0)');
    await page.eval(`(() => { const el = document.querySelector('[data-card] .hl'); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return String(s).length; })()`);
    const badgeShown = page.eval(`new Promise((resolve, reject) => {
      const b = document.getElementById('new-badge');
      if (!b.hidden) return resolve(true);
      const mo = new MutationObserver(() => { if (!b.hidden) { mo.disconnect(); clearTimeout(t); resolve(true); } });
      mo.observe(b, { attributes: true });
      const t = setTimeout(() => reject(new Error('badge never shown')), 6000);
    })`);
    const pub = await published(A, briefOf('상황판 점검', '글자를 고르는 동안 바뀐 내용'));
    await badgeShown;
    const held = await page.eval(`({ applied: BriefPage.state.seq, badge: !document.getElementById('new-badge').hidden,
      badgeText: document.getElementById('new-badge').textContent, bodyHasNew: document.getElementById('app').textContent.includes('글자를 고르는 동안') })`);
    assert.ok(held.applied < pub.seq && held.badge && !held.bodyHasNew, `held: ${JSON.stringify(held)}`);
    const t0 = await page.eval('(() => { const t = Date.now(); getSelection().removeAllRanges(); return t; })()');
    const appliedAt = await waitApplied(page, pub.seq);
    const delta = appliedAt - t0;
    assert.ok(delta <= 300, `applied ${delta}ms after the selection ended`);
    return { heldBadge: held.badgeText, seqWhileSelected: held.applied, publishedSeq: pub.seq, appliedAfterReleaseMs: delta };
  });

  // (d) worker pulse, move to the bottom when finished, animation under normal and reduced motion
  const moveProbe = (moverId) => page.eval(`new Promise((resolve, reject) => {
    const mover = ${JSON.stringify(moverId)};
    let done = false;
    BriefPage.hooks.afterApply.push(() => {
      if (done) return;
      const row = document.querySelector('[data-worker="' + mover + '"]');
      if (!row || !row.classList.contains('w-done')) return;
      done = true;
      setTimeout(() => {
        const rows = [...document.querySelectorAll('[data-card="lead-A"] [data-worker]')];
        const running = document.querySelector('[data-card="lead-A"] .w-running > .w-dot');
        resolve({ order: rows.map((r) => r.getAttribute('data-worker')), moverAnimations: row.getAnimations().length,
          pulseName: running ? getComputedStyle(running).animationName : null, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches });
      }, 50);
    });
    setTimeout(() => reject(new Error('worker never shown as finished')), 12000);
  })`);
  await scenario('d', 'workers: pulse while running, finished row sinks with a 350ms move, none under reduced motion, card moves to 끝남', async () => {
    await click(page, '#tab-wait'); // lead-A waits for the owner's answer (its plan question), so its card lives under 나를 기다림
    const pub0 = await published(A, briefOf('상황판 점검', '작업자 셋이 일하는 중'));
    await waitApplied(page, pub0.seq);
    const initial = await page.eval(`(() => {
      const rows = [...document.querySelectorAll('[data-card="lead-A"] [data-worker]')];
      const dot = document.querySelector('[data-card="lead-A"] .w-running > .w-dot');
      return { order: rows.map((r) => r.getAttribute('data-worker')), running: document.querySelectorAll('[data-card="lead-A"] .w-running').length,
        pulse: dot ? getComputedStyle(dot).animationName : null, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
    })()`);
    assert.equal(initial.running, 3);
    assert.equal(initial.pulse, 'w-pulse');
    assert.equal(initial.reduced, false);
    await page.eval(`document.querySelector('[data-card="lead-A"] .w-block').scrollIntoView({ block: 'center' })`);
    await page.screenshot(path.join(OUT, 'desktop-workers.png'));

    // normal motion: the first row finishes and sinks
    const mover1 = initial.order[0];
    const probe1 = moveProbe(mover1);
    await A.call('rpc', { data: snapshot(WORKERS.map((w) => (w.id === mover1 ? 'completed' : 'running'))) });
    const normal = await probe1;
    assert.equal(normal.order.at(-1), mover1, `finished row is last: ${normal.order}`);
    assert.ok(normal.moverAnimations > 0, 'the moved row has a running animation 50ms after the apply');

    // reduced motion: the next first row finishes; nothing animates and the pulse is off
    await emulateMotion(page, 'reduce');
    const mover2 = (await page.eval(`[...document.querySelectorAll('[data-card="lead-A"] [data-worker]')].map((r) => r.getAttribute('data-worker'))`))[0];
    const probe2 = moveProbe(mover2);
    await A.call('rpc', { data: snapshot(WORKERS.map((w) => (w.id === mover1 || w.id === mover2 ? 'completed' : 'running'))) });
    const reduced = await probe2;
    assert.equal(reduced.reduced, true);
    assert.equal(reduced.moverAnimations, 0, 'no animation under reduced motion');
    assert.equal(reduced.pulseName, 'none', 'the pulse is off');
    await emulateMotion(page, 'no-preference');

    // the card of a conversation that finishes leaves the shown tab, fading, and appears under 끝남
    await click(page, '#tab-run');
    const doneBefore = Number(await page.eval(`document.querySelector('#tab-done .n').textContent`));
    const cardProbe = page.eval(`new Promise((resolve, reject) => {
      let done = false;
      BriefPage.hooks.afterApply.push(() => {
        if (done || document.querySelector('[data-card="lead-B"]')) return;
        done = true;
        setTimeout(() => {
          const ghost = document.querySelector('.w-ghost');
          resolve({ ghost: Boolean(ghost), ghostAnimations: ghost ? ghost.getAnimations().length : 0, doneTab: Number(document.querySelector('#tab-done .n').textContent) });
        }, 50);
      });
      setTimeout(() => reject(new Error('card never left the shown tab')), 12000);
    })`);
    await B.call('brief', { input: briefOf('두 번째 대화', '마쳤습니다', { status: 'done', done: [{ text: '모두 끝냄', truth: 'reported', applied: 'none' }] }) });
    const left = await cardProbe;
    assert.ok(left.ghost && left.ghostAnimations > 0, `fading ghost: ${JSON.stringify(left)}`);
    assert.equal(left.doneTab, doneBefore + 1);
    await click(page, '#tab-done');
    assert.equal(await page.eval(`Boolean(document.querySelector('.app[data-tab="done"] [data-card="lead-B"]'))`), true, 'the card is under 끝남');
    await click(page, '#tab-run');
    return {
      pulse: initial.pulse, runningRows: initial.running, finishedRowLast: normal.order.at(-1) === mover1, moverAnimationsAt50ms: normal.moverAnimations,
      reducedMotionAnimations: reduced.moverAnimations, reducedPulseAnimationName: reduced.pulseName, ghostAnimationsAt50ms: left.ghostAnimations, doneTabCount: left.doneTab,
    };
  });

  // (e) alarm
  await scenario('e', 'alarm: band + title + one chime per update, none on first load / muted / reload; blocked-autoplay path is in the mobile run', async () => {
    assert.ok(firstLoad.rows >= 1 && firstLoad.title.startsWith('('), `first load shows the band: ${JSON.stringify(firstLoad)}`);
    assert.equal(firstLoad.starts, 0, 'no sound for what was already waiting');
    const waitingNow = () => page.eval('document.title');
    const t0 = await waitingNow();
    const n0 = Number(/^\((\d+)\)/.exec(t0)[1]);
    const one = await published(A, briefOf('상황판 점검', '새 질문 하나', { decisions: [decisionOf('첫 새 질문')] }));
    await waitApplied(page, one.seq);
    const afterOne = await page.eval(`({ title: document.title, starts: window.__audio.starts, band: document.getElementById('alarm-band').innerText, state: window.__audio.contexts[0] && window.__audio.contexts[0].state })`);
    assert.ok(afterOne.title.startsWith(`(${n0 + 1}) `), afterOne.title);
    assert.equal(afterOne.starts, 2, 'one chime = two tones');
    assert.ok(afterOne.band.includes('답 기다림'));
    const four = await published(A, briefOf('상황판 점검', '새 질문 넷', { decisions: ['둘', '셋', '넷', '다섯'].map((x) => decisionOf(`동시 ${x}`)) }));
    await waitApplied(page, four.seq);
    const afterFour = await page.eval(`({ title: document.title, starts: window.__audio.starts })`);
    assert.ok(afterFour.title.startsWith(`(${n0 + 5}) `), afterFour.title);
    assert.equal(afterFour.starts, 4, 'four new at once ring once');
    await page.eval('window.scrollTo(0, 0)');
    await page.screenshot(path.join(OUT, 'desktop-alarm.png'));
    // mute: the band stays, no sound
    await click(page, '[data-alarm-sound]');
    const muted = await published(A, briefOf('상황판 점검', '꺼진 동안 질문', { decisions: [decisionOf('무음 질문')] }));
    await waitApplied(page, muted.seq);
    const afterMute = await page.eval(`({ title: document.title, starts: window.__audio.starts, label: document.querySelector('[data-alarm-sound]').textContent })`);
    assert.equal(afterMute.starts, 4);
    assert.ok(afterMute.title.startsWith(`(${n0 + 6}) `) && afterMute.label.includes('꺼짐'), JSON.stringify(afterMute));
    // answering one leaves the band
    const decisionId = Math.max(...readdirIds(path.join(STATE, 'decisions')));
    await A.call('command', { name: 'decide', args: `${decisionId}A` });
    const answeredPub = pubOf();
    await waitApplied(page, answeredPub.seq);
    const afterAnswer = await page.eval('document.title');
    assert.ok(afterAnswer.startsWith(`(${n0 + 5}) `), `answered item left: ${afterAnswer}`);
    // sound back on, reload: what was seen before does not ring again
    await click(page, '[data-alarm-sound]');
    await openBoard(page, url, 'desktop-reload');
    const reloaded = await page.eval(`({ starts: window.__audio.starts, rows: document.querySelectorAll('#alarm-band .alarm-row').length, title: document.title })`);
    assert.equal(reloaded.starts, 0, 'a reload does not ring for items seen before');
    assert.ok(reloaded.rows >= 1);
    return { firstLoad, afterOne: { title: afterOne.title, starts: afterOne.starts }, afterFour, afterMute, afterAnswer, reloaded };
  });

  // (f) plan block
  await scenario('f', 'plan: collapsed in <= 2 lines, expanded has every anchor exactly once', async () => {
    const planResult = await A.call('plan', { input: planInput(PLAN_PATH) });
    assert.match(planResult, /^계획 r\d+ 저장/);
    await click(page, '#tab-wait');
    const pub = pubOf();
    await waitApplied(page, pub.seq);
    const collapsed = await page.eval(`(() => {
      const plan = document.querySelector('[data-card="lead-A"] [data-plan]');
      return { id: plan.getAttribute('data-plan'), lines: plan.querySelectorAll('.plan-summary-line').length, anchors: document.querySelectorAll('[data-plan] [data-anchor]').length };
    })()`);
    assert.ok(collapsed.lines <= 2 && collapsed.anchors === 0, JSON.stringify(collapsed));
    for (const key of ['plan:', 'plan-tasks:', 'plan-out:']) await click(page, `[data-act="exp"][data-key="${key}${collapsed.id}"]`);
    const anchors = await page.eval(`[...document.querySelectorAll('[data-card="lead-A"] [data-anchor]')].map((e) => e.getAttribute('data-anchor'))`);
    const expected = expectedAnchors(collapsed.id);
    assert.equal(new Set(anchors).size, anchors.length, 'no duplicate anchor');
    assert.deepEqual([...anchors].sort(), [...expected].sort(), 'every plan element has exactly one anchor');
    const lanes = await page.eval(`(() => { const l = [...document.querySelectorAll('[data-card="lead-A"] .plan-lane')]; return { count: l.length, current: l.filter((x) => x.classList.contains('is-current')).length, now: document.querySelectorAll('[data-card="lead-A"] .plan-now').length }; })()`);
    assert.deepEqual(lanes, { count: 4, current: 1, now: 1 });
    await page.eval(`document.querySelector('[data-card="lead-A"] .plan-expanded').scrollIntoView({ block: 'start' })`);
    await page.screenshot(path.join(OUT, 'desktop-plan.png'));
    return { planId: collapsed.id, collapsedLines: collapsed.lines, anchorsChecked: anchors.length, lanes };
  });
  return { page, url };
}

const readdirIds = (dir) => {
  const names = existsSync(dir) ? readdirSyncSafe(dir) : [];
  return names.map((n) => Number(n.replace('.json', ''))).filter(Number.isInteger);
};
import { readdirSync } from 'node:fs';
const readdirSyncSafe = (dir) => readdirSync(dir);

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
    const lost = waitStatus(page, { includes: '실시간 연결 끊김' });
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
    assert.ok(!link.hidden && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(link.href) && link.text.includes('실시간 보기 열기'), JSON.stringify(link));
    return { latencyMs: latency, link };
  });

  // (j) /brief off
  await scenario('j', '/brief off: the open page says 브리핑 꺼짐', async () => {
    await openBoard(page, serverUrl(), 'http-again');
    assert.equal(await page.eval('BriefPage.transport()'), 'http');
    const off = waitStatus(page, { includes: '브리핑 꺼짐' });
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

async function mobileRun() {
  const page = await launch({ width: 390, height: 844 }); // default autoplay policy: sound needs a gesture
  pages.push(page);
  owned.pids.push(page.pid);
  owned.profiles.push(page.profileDir);
  await page.client.send('Log.enable');
  watchConsole(page, 'mobile');
  await page.addInitScript(INIT_SCRIPT);
  await emulateMotion(page, 'no-preference');
  await openBoard(page, serverUrl(), 'mobile');
  await scenario('m-fit', 'mobile first paint fits the 390px width (no sideways scroll)', async () => {
    const fit = await page.eval(`(() => {
      const over = (e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed';
      // the innermost overflowing elements: the ones that make their parents wide
      const wide = [...document.querySelectorAll('body *')].filter((e) => over(e) && ![...e.children].some(over))
        .slice(0, 8).map((e) => e.tagName.toLowerCase() + '.' + e.className + ' right=' + Math.round(e.getBoundingClientRect().right) + ' ws=' + getComputedStyle(e).whiteSpace + ' text=' + (e.textContent || '').slice(0, 30));
      // which element forces the width: hiding it alone brings the page back to the viewport width (deepest such elements)
      const fits = () => document.documentElement.scrollWidth <= innerWidth + 1;
      let culprits = [];
      if (!fits()) {
        const fixers = new Set([...document.querySelectorAll('#app *')].filter((e) => { const d = e.style.display; e.style.display = 'none'; const ok = fits(); e.style.display = d; return ok; }));
        culprits = [...fixers].filter((e) => ![...e.children].some((c) => fixers.has(c))).slice(0, 6)
          .map((e) => e.tagName.toLowerCase() + '.' + e.className + ' text=' + (e.textContent || '').slice(0, 40));
      }
      return { scrollWidth: document.documentElement.scrollWidth, innerWidth, wide, culprits };
    })()`);
    assert.ok(fit.scrollWidth <= fit.innerWidth + 1, JSON.stringify(fit));
    return fit;
  });
  await page.screenshot(path.join(OUT, 'mobile-board.png'));

  await scenario('f-mobile', 'plan at 390x844: lanes stack with ↓, anchors unique', async () => {
    const id = await page.eval(`document.querySelector('[data-card="lead-A"] [data-plan]').getAttribute('data-plan')`);
    for (const key of ['plan:', 'plan-tasks:', 'plan-out:']) await jsClick(page, `[data-act="exp"][data-key="${key}${id}"]`);
    const shape = await page.eval(`(() => {
      const lanes = [...document.querySelectorAll('[data-card="lead-A"] .plan-lane')];
      const tops = lanes.map((l) => l.getBoundingClientRect().top + window.scrollY);
      return { count: lanes.length, stacked: tops.every((t, i) => i === 0 || t > tops[i - 1]),
        arrow: getComputedStyle(lanes[0], '::after').content, overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
    })()`);
    assert.equal(shape.count, 4);
    assert.ok(shape.stacked, 'lanes are stacked top to bottom');
    assert.ok(shape.arrow.includes('↓'), `arrow ${shape.arrow}`);
    assert.equal(shape.overflowX, false, 'no sideways scroll');
    const anchors = await page.eval(`[...document.querySelectorAll('[data-card="lead-A"] [data-anchor]')].map((e) => e.getAttribute('data-anchor'))`);
    assert.equal(new Set(anchors).size, anchors.length);
    await page.eval(`document.querySelector('[data-card="lead-A"] .plan-expanded').scrollIntoView({ block: 'start' })`);
    await page.screenshot(path.join(OUT, 'mobile-plan.png'));
    return shape;
  });

  await page.eval(`document.querySelector('[data-card="lead-A"] .w-block').scrollIntoView({ block: 'center' })`);
  await page.screenshot(path.join(OUT, 'mobile-workers.png'));

  await scenario('e-blocked', 'alarm when the browser blocks autoplay: hint, one click, AudioContext running, then the chime', async () => {
    await page.eval('window.scrollTo(0, 0)');
    const pub = await published(B, briefOf('두 번째 대화', '모바일에서 새 질문', { decisions: [decisionOf('모바일 질문')] }));
    await waitApplied(page, pub.seq);
    const blocked = await page.eval(`({ band: document.getElementById('alarm-band').innerText, state: window.__audio.contexts[0] ? window.__audio.contexts[0].state : 'none', starts: window.__audio.starts })`);
    assert.ok(blocked.band.includes('소리를 켜려면 화면을 한 번 누르세요'), blocked.band);
    assert.equal(blocked.state, 'suspended');
    await page.screenshot(path.join(OUT, 'mobile-alarm.png'));
    const running = page.eval(`new Promise((resolve, reject) => {
      const c = window.__audio.contexts[0];
      if (c.state === 'running') return resolve('running');
      c.addEventListener('statechange', () => { if (c.state === 'running') resolve('running'); });
      setTimeout(() => reject(new Error('context stayed ' + c.state)), 6000);
    })`);
    await clickAt(page, 8, 500);
    assert.equal(await running, 'running');
    return { before: blocked.state, after: 'running', hint: true };
  });
}

// ------------------------------------------------------------------ run and clean up

async function cleanup() {
  const cleanupResult = { pids: {}, profiles: {}, ports: {}, tempDirs: {}, errors: [] };
  for (const lead of [A, B]) {
    if (!lead) continue;
    try {
      if (lead.alive()) {
        await Promise.race([lead.call('shutdown'), new Promise((r) => setTimeout(r, 5000))]);
        lead.child.kill();
      }
      await lead.closed;
    } catch (err) {
      cleanupResult.errors.push(`lead ${lead.sid}: ${err.message}`);
      try { lead.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  for (const page of pages) {
    try { await page.close(); } catch (err) { cleanupResult.errors.push(`chrome ${page.pid}: ${err.message}`); }
  }
  for (const pid of owned.pids) cleanupResult.pids[pid] = isPidAlive(pid) ? 'ALIVE' : 'gone';
  for (const p of owned.profiles) cleanupResult.profiles[p] = existsSync(p) ? 'EXISTS' : 'removed';
  for (let port = BASE; port < BASE + 10; port++) {
    cleanupResult.ports[port] = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => { s.destroy(); resolve('LISTENING'); });
      s.once('error', () => resolve('closed'));
    });
  }
  for (const d of owned.tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch (err) { cleanupResult.errors.push(`rm ${d}: ${err.message}`); }
    cleanupResult.tempDirs[d] = existsSync(d) ? 'EXISTS' : 'removed';
  }
  cleanupResult.clean = cleanupResult.errors.length === 0
    && Object.values(cleanupResult.pids).every((v) => v === 'gone')
    && Object.values(cleanupResult.profiles).every((v) => v === 'removed')
    && Object.values(cleanupResult.ports).every((v) => v === 'closed')
    && Object.values(cleanupResult.tempDirs).every((v) => v === 'removed');
  return cleanupResult;
}

let fatal = null;
let p95doc = null;
try {
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
  await A.call('brief', { input: briefOf('상황판 점검', '시작') });
  await B.call('brief', { input: briefOf('두 번째 대화', '대기 중인 두 번째 대화') });
  await A.call('rpc', { data: snapshot(['running', 'running', 'running']) });
  await until(STATE, () => readJson(path.join(STATE, 'sessions', 'lead-A', 'meta.json')).auto?.live?.workers?.length === 3, 'worker rows saved');
  await A.call('plan', { input: planInput(PLAN_PATH) });
  await A.call('brief', { input: briefOf('상황판 점검', '준비 끝') });

  const ctx = await desktopRun();
  await handoverRun(ctx);
  await collectPageErrors(ctx.page, 'desktop-final');
  await mobileRun();
  await collectPageErrors(pages[1], 'mobile-final');

  await scenario('k', 'no console errors or page exceptions in any run', async () => {
    assert.deepEqual(consoleErrors, []);
    return { errors: 0 };
  });
  phase = 'teardown';
  for (const view of ['board', 'plan', 'workers', 'alarm']) {
    for (const device of ['desktop', 'mobile']) {
      const file = path.join(OUT, `${device}-${view}.png`);
      if (!existsSync(file) || statSync(file).size < 5000) throw new Error(`missing or tiny screenshot ${file}`);
    }
  }
} catch (err) {
  fatal = err;
  console.error('FATAL', err);
}

const cleanupResult = await cleanup();
const scenarioIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
const extra = ['m-fit', 'f-mobile', 'e-blocked'];
const allPass = !fatal
  && scenarioIds.every((id) => results[id] && results[id].pass)
  && extra.every((id) => results[id] && results[id].pass)
  && p95doc && p95doc.pass && cleanupResult.clean;
const doc = {
  pass: allPass,
  finishedAt: new Date().toISOString(),
  fatal: fatal ? String(fatal.stack || fatal) : null,
  renderP95: p95doc ? { p95Ms: p95doc.p95Ms, limitMs: 150, pass: p95doc.pass, file: 'render-p95.json' } : null,
  scenarios: results,
  consoleErrors,
  expectedNetworkLogs: { note: "Chrome's own 'Failed to load resource' lines for the live-event stream that the test cut on purpose (owner process killed, /brief off); nothing else is excluded", lines: expectedNetwork },
  teardownLogs: { note: 'console/network lines that appeared after scenario k, while the servers were being shut down', lines: teardownNetwork },
  cleanup: cleanupResult,
};
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(doc, null, 2));
console.log(allPass ? 'ALL PASS' : 'FAILED');
process.exit(allPass ? 0 : 1);
