// Office view CPU budget (plan omo-office-view, Must have 8; todo 7). The budgets are the plan's numbers and do not
// change: main-thread TaskDuration growth (CDP Performance.getMetrics, seconds, read on the office page target) <= 3.0
// for the visible office on the worst-case floor with no data change for 60 s (the avatar walks a 20-step click path
// inside that window), <= 0.3 with the tab hidden for 60 s, and <= 4.5 for 20 publishes in 60 s.
// Motion is forced on for every round (prefers-reduced-motion: no-preference), because with reduced motion the office
// animates nothing and the measurement would not be of the office as users see it. Each round is a fresh browser and a
// fresh candidate board over a temp state dir. A round is valid only when every check in its record holds (motion on,
// animations running, the avatar's 20-step click walk animated, the floor composition, the visibility states, and the
// publishes applied); an invalid round never passes and stays in the record. A case passes when one of up to 3 rounds
// is valid and within budget.
// OFFICE_CPU_OUT names the JSON record to write; OFFICE_CPU_CASES filters cases (the others are skipped, not passed);
// OFFICE_CPU_VIEW serves a scratch office-view.js instead of W's (the negative controls: the same measurement must fail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launch } from '../../scripts/cdp.mjs';
import { pageHtml } from '../../src/render.mjs';
import { createServerHost } from '../../src/server-host.mjs';
import { createBoardServer } from '../../src/server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BUDGET = { visible: 3.0, hidden: 0.3, publish: 4.5 };
const WINDOW_MS = 60_000, ROUNDS = 3, GEN = 9, PUBLISH_GAP_MS = 3000, PUBLISHES = 20, STEPS = 20;
const OUT = process.env.OFFICE_CPU_OUT || null;
const VIEW = process.env.OFFICE_CPU_VIEW || null;
const ONLY = process.env.OFFICE_CPU_CASES ? process.env.OFFICE_CPU_CASES.split(',') : null;
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/view-model-office.json'), 'utf8'));
const KINDS = ['explore', 'librarian', 'oracle', 'sisyphus', 'hephaestus', 'prometheus', 'plan-consultant', 'plan-reviewer', 'architect', 'atlas', 'qa-executor', 'code-reviewer'];
const STATES = ['running', 'waiting', 'done'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = { plan: 'omo-office-view todo 7 (Must have 8)', budgets_s: BUDGET, window_s: WINDOW_MS / 1000, rounds_max: ROUNDS,
  metric: 'Performance.getMetrics TaskDuration (seconds) of the office page target, read before and after each window',
  motion: 'prefers-reduced-motion: no-preference emulated on the office page target before navigation, every round',
  view: VIEW ? 'scratch copy: ' + VIEW : 'W src/page/office-view.js', machine: machine(), cases: {} };

// the worst case: one session whose floor has the lead desk and 12 worker desks (13 desks), each worker a walking cat
function worstCaseModel() {
  const model = structuredClone(FIXTURE);
  const s = structuredClone(model.sessions[0]);
  s.alive = true;
  s.live = { workers: Array.from({ length: 12 }, (_, i) => ({ id: 'w' + (i + 1), kind: KINDS[i], name: KINDS[i], state: STATES[i % 3], step: 'step ' + (i + 1) })) };
  model.sessions = [s];
  return model;
}

function machine() {
  const cpus = os.cpus();
  return { cpu: cpus[0].model.trim(), cores: cpus.length, ram_bytes: os.totalmem(), os: `${os.type()} ${os.release()}`, node: process.version };
}

// load before a window: the mean CPU load and how many other chrome.exe processes the PC is running
function loadBefore() {
  const query = '$c=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $n=(Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count; "$c $n"';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', query], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const [cpu, chrome] = r.status === 0 ? r.stdout.trim().split(/\s+/).map(Number) : [null, null];
  return { cpu_percent: cpu, chrome_processes_before_launch: chrome };
}

// the view file's reads go through a scratch copy when OFFICE_CPU_VIEW is set (W is only read)
function viewFs(file) {
  return Object.assign(Object.create(fs), {
    readFileSync: (p, enc) => (String(p).replace(/\\/g, '/').endsWith('/src/page/office-view.js') ? fs.readFileSync(file, enc) : fs.readFileSync(p, enc)),
  });
}

// counts the avatar's own animated walk steps: every el.animate() on its .of-walk group (window.__avatarAnimated)
const AVATAR_WATCH = `(() => { window.__avatarAnimated = 0; const real = Element.prototype.animate;
  Element.prototype.animate = function (...a) {
    if (this.classList && this.classList.contains('of-walk') && this.closest && this.closest('.of-me')) window.__avatarAnimated++;
    return real.apply(this, a); }; })()`;

async function waitFor(page, expr, what, ms = 10000) {
  return page.eval(`new Promise((resolve, reject) => { const t0 = performance.now();
    const f = () => { let v = false; try { v = !!(${expr}); } catch (e) {}
      if (v) return resolve(true);
      if (performance.now() - t0 > ${ms}) return reject(new Error('timeout: ${what}'));
      setTimeout(f, 50); }; f(); })`);
}

const taskDuration = async (page) => (await page.client.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value;
const count = (page, sel) => page.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const motionState = (page) => page.eval(`({ reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, visibility: document.visibilityState, animations: document.getAnimations().length })`);

// one real click on the walk tile 20 BFS steps from the avatar's spawn tile, on the page's own walk map (BriefOffice.scene).
// The click is a real mouse press at that tile's centre on the office svg; the avatar walks the shortest path (20 tiles).
async function clickWalk(page, steps) {
  const goal = await page.eval(`(() => { const sc = BriefOffice.scene(BriefPage.state.model, BriefPage.state.ui, Date.now());
    const f = sc.floors.find((x) => x.live) || sc.floors[0];
    const w = f.walk.w, h = f.walk.h, off = new Set(f.walk.blocked), start = f.spawn.y * w + f.spawn.x;
    const prev = new Map([[start, -1]]), dist = new Map([[start, 0]]), q = [start];
    for (let i = 0; i < q.length; i++) { const at = q[i], x = at % w, y = (at - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (off.has(n) || dist.has(n)) continue;
        dist.set(n, dist.get(at) + 1); prev.set(n, at); q.push(n); } }
    let far = start;
    for (const [t, d] of dist) if (d > dist.get(far) || (d === dist.get(far) && t < far)) far = t;
    const tiles = [];
    for (let t = far; t !== start; t = prev.get(t)) tiles.push(t);
    tiles.reverse();
    const T = tiles[${steps} - 1], tx = T % w, ty = (T - tx) / w;
    const OX = 470, OY = 120, KX = 34 * 0.866, KY = 17, S = 0.5;
    const svg = document.querySelector('#office svg.of-scene');
    const p = svg.createSVGPoint(); p.x = OX + KX * S * (tx - ty); p.y = OY + KY * S * (tx + ty + 1);
    const c = p.matrixTransform(svg.getScreenCTM());
    return { x: c.x, y: c.y, tile: [tx, ty], goalDistance: dist.get(T), pathTiles: tiles.length, spawn: [f.spawn.x, f.spawn.y],
      expectTransform: [OX + KX * S * (tx - ty), OY + KY * S * (tx + ty + 1)] }; })()`);
  await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: goal.x, y: goal.y, button: 'none', clickCount: 0 });
  await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: goal.x, y: goal.y, button: 'left', clickCount: 1 });
  await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: goal.x, y: goal.y, button: 'left', clickCount: 1 });
  await page.eval(`new Promise((resolve, reject) => { const t0 = performance.now();
    const f = () => { if ((window.__avatarAnimated || 0) >= ${steps}) return resolve(true);
      if (performance.now() - t0 > 15000) return reject(new Error('avatar animated ' + (window.__avatarAnimated || 0) + ' of ${steps}'));
      setTimeout(f, 50); }; f(); })`).catch(() => null);
  const arrived = await page.eval(`(() => { const g = document.querySelector('#office .of-me .of-walk > g'); const t = g ? g.getAttribute('transform') : '';
    const m = /translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(t || ''); if (!m) return null; return [Number(m[1]), Number(m[2])]; })()`);
  const ok = arrived && Math.abs(arrived[0] - goal.expectTransform[0]) < 1 && Math.abs(arrived[1] - goal.expectTransform[1]) < 1;
  return { planned: steps, goalDistance: goal.goalDistance, pathTiles: goal.pathTiles, goalTile: goal.tile, spawn: goal.spawn, click: [Math.round(goal.x), Math.round(goal.y)],
    animated: await page.eval('window.__avatarAnimated || 0'), arrived: !!ok, finalTransform: arrived };
}

// a second browser connection, only to make a hidden second tab with Target.createTarget and Target.activateTarget
async function browserClient(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('browser websocket timeout')), 15000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', () => reject(new Error('browser websocket error')), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  });
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }),
    close: () => ws.close(),
  };
}

// one round: a fresh browser and candidate board, motion forced on; the case's window runs once and the delta is the number
async function round(caseName) {
  const model = worstCaseModel();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-cpu-'));
  const errors = [];
  const host = createServerHost({ stateDir: tmp, sessionId: 'office-cpu', generation: GEN,
    installedGeneration: async () => null, isEnabled: () => true,
    readSnapshot: () => ({ published: { seq: model.seq } }),
    buildViewModel: () => structuredClone(model), buildFull: () => structuredClone(model), project: () => structuredClone(model),
    getPage: (vm, token, nonce) => pageHtml(vm, GEN, { mode: 'server', token, nonce, fs: VIEW ? viewFs(VIEW) : fs }),
    answer: () => ({ status: 500, json: { ok: false, code: 'CPU_NO_WRITE' } }),
    focus: () => ({ status: 500, json: { ok: false, code: 'CPU_NO_WRITE' } }),
    env: { OMO_BRIEFING_PORT_BASE: '49400' }, now: () => model.generatedAt,
    createBoardServer: (o) => createBoardServer(o),
    // SSE sockets closed by the teardown report ECONNRESET or aborted; the QA harnesses ignore those the same way
    onError: (key, e) => { if (!/aborted|ECONNRESET|EPIPE/.test(e.message)) errors.push({ key, error: e.message }); } });
  let page;
  const out = { load_before_launch: loadBefore() };
  try {
    const { url } = await host.ensure();
    page = await launch({ width: 1440, height: 900 });
    out.chrome = (await (await fetch(`http://127.0.0.1:${page.port}/json/version`)).json()).Browser;
    await page.client.send('Page.addScriptToEvaluateOnNewDocument', { source: AVATAR_WATCH });
    await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await page.goto(url);
    await page.client.send('Performance.enable');
    await waitFor(page, `window.BriefPage && BriefPage.state.model && BriefPage.state.model.seq === ${model.seq}`, 'the page has the model');
    await page.eval(`document.querySelector('[data-sh="view"][data-key="office"]').click()`);
    await waitFor(page, `document.querySelectorAll('#office .of-desk').length >= 13`, '13 desks drawn');
    const cats = await count(page, '#office .of-cat'), avatarCats = await count(page, '#office .of-me .of-cat');
    out.floor = { desks: await count(page, '#office .of-desk'), desk_cats: cats - avatarCats, avatar: await count(page, '#office .of-me') };
    const checks = { motion_on: null, floor_ok: out.floor.desks >= 12 && out.floor.desk_cats >= 12 && out.floor.avatar === 1 };
    const start = await motionState(page);
    out.motion_at_start = start;
    checks.motion_on = start.reduce === false;
    if (caseName === 'visible') {
      checks.visible_at_start = start.visibility === 'visible';
      checks.animations_running_at_start = start.animations > 0;
      const before = await taskDuration(page);
      const t0 = Date.now();
      const [walk] = await Promise.all([clickWalk(page, STEPS), sleep(WINDOW_MS)]);
      out.window_ms = Date.now() - t0;
      out.TaskDuration_before = before;
      out.TaskDuration_after = await taskDuration(page);
      out.avatar_click_walk = walk;
      out.motion_at_end = await motionState(page);
      checks.visible_at_end = out.motion_at_end.visibility === 'visible';
      checks.steps_animated_20 = walk.animated >= STEPS && walk.goalDistance === STEPS;
      checks.arrived = walk.arrived;
    } else if (caseName === 'hidden') {
      const b = await browserClient(page.port);
      const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
      await b.send('Target.activateTarget', { targetId });
      b.close();
      await waitFor(page, `document.visibilityState === 'hidden'`, 'the first tab is hidden');
      const hiddenStart = await motionState(page);
      out.motion_at_start = hiddenStart;
      checks.motion_on = hiddenStart.reduce === false;
      checks.hidden_at_start = hiddenStart.visibility === 'hidden';
      const before = await taskDuration(page);
      const t0 = Date.now();
      await sleep(WINDOW_MS);
      out.window_ms = Date.now() - t0;
      out.TaskDuration_before = before;
      out.TaskDuration_after = await taskDuration(page);
      out.motion_at_end = await motionState(page);
      checks.hidden_at_end = out.motion_at_end.visibility === 'hidden';
    } else {
      checks.visible_at_start = start.visibility === 'visible';
      checks.animations_running_at_start = start.animations > 0;
      const before = await taskDuration(page);
      const t0 = Date.now();
      let applied = 0;
      out.publish_errors = [];
      for (let k = 0; k < PUBLISHES; k++) {
        await sleep(t0 + k * PUBLISH_GAP_MS - Date.now());
        model.seq += 1;
        const w = model.sessions[0].live.workers[k % 12];
        w.state = STATES[(k + 1) % 3];
        w.step = 'publish ' + (k + 1);
        host.notifyPublished();
        try {
          await waitFor(page, `BriefPage.state.model.seq === ${model.seq}`, 'publish ' + (k + 1) + ' applied', 8000);
          applied++;
        } catch (e) {
          out.publish_errors.push(e.message);
        }
      }
      await sleep(t0 + WINDOW_MS - Date.now());
      out.window_ms = Date.now() - t0;
      out.TaskDuration_before = before;
      out.TaskDuration_after = await taskDuration(page);
      out.motion_at_end = await motionState(page);
      checks.visible_at_end = out.motion_at_end.visibility === 'visible';
      out.publishes_sent = PUBLISHES;
      out.publishes_applied = applied;
      checks.publishes_applied_all = applied === PUBLISHES;
    }
    out.growth_s = out.TaskDuration_after - out.TaskDuration_before;
    out.checks = checks;
    out.invalid_reasons = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
    out.valid = out.invalid_reasons.length === 0;
    out.server_errors = errors;
  } finally {
    if (page) await page.close();
    host.release();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return out;
}

const CASES = [['visible', 'visible idle, worst-case floor, 20-step avatar click walk'], ['hidden', 'tab hidden for 60 s'], ['publish', '20 publishes in 60 s']];
for (const [name, label] of CASES) {
  test(`office CPU budget, ${label}: a valid round within ${BUDGET[name]} s in one of ${ROUNDS} rounds`, { timeout: 900_000 }, async (t) => {
    if (ONLY && !ONLY.includes(name)) { t.skip(`not selected by OFFICE_CPU_CASES (${ONLY.join(',')})`); return; }
    const budget = BUDGET[name];
    const rounds = [];
    record.cases[name] = { budget_s: budget, label, rounds, pass: false };
    for (let i = 0; i < ROUNDS && !record.cases[name].pass; i++) {
      const r = await round(name);
      r.pass = r.valid === true && r.growth_s <= budget;
      r.margin_s = budget - r.growth_s;
      rounds.push(r);
      record.cases[name].pass = rounds.some((x) => x.pass);
      record.cases[name].best_valid_growth_s = Math.min(...rounds.filter((x) => x.valid).map((x) => x.growth_s), Infinity);
      if (OUT) fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');
    }
    assert.ok(record.cases[name].pass, `${name}: growth ${rounds.map((x) => x.growth_s.toFixed(3) + (x.valid ? '' : ' (invalid: ' + x.invalid_reasons.join('+') + ')')).join(', ')} s; budget ${budget} s; ${rounds.length} rounds`);
  });
}
