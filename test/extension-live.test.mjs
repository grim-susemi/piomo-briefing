// Integration of the generation-4 pieces inside the extension: render.lock contention without stalls, the board server
// host, live worker rows from the task bus, plan_brief, global pause and the lead-only gate. Real files, real sockets,
// real second processes; ports 47400+. Waits are on events (file changes, SSE frames, process messages) with a bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import nodeTimers from 'node:timers';
import promiseTimers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { planIdOf, rootAndSlugOf } from '../src/plan-schema.mjs';
import { PLAN_CHIP_STALE, planChipMissing } from '../src/plan-tool.mjs';
import {
  RPC, REGISTRY, nextBase, norm, text, goodBrief, decision, PLAN_TEXT, planInput,
  fakeTimers, make, seqOf, parseData, readData, serverUrl, until, get, sse, startHolder,
  settingsFaultFs, ERR_CHIP, chipsOf, workerSnap, nextMacrotask, noHooks, seedErrors,
} from './helpers/live-fixture.mjs';

// Forward every caller unchanged. Synchronous retry chains share one microtask-delimited burst.
function blockingBursts() {
  const original = Atomics.wait;
  const bursts = [];
  let open = null;
  Atomics.wait = function (...args) {
    if (!open) {
      const burst = { ms: 0 };
      bursts.push(burst);
      open = burst;
      queueMicrotask(() => { if (open === burst) open = null; });
    }
    open.ms += Number(args[3] ?? Infinity);
    return Reflect.apply(original, this, args);
  };
  return {
    bursts,
    restore: () => { Atomics.wait = original; },
    assert: () => {
      for (const burst of bursts) assert.ok(burst.ms <= 200, 'blocking burst requested ' + burst.ms + 'ms');
    },
  };
}

// Native callbacks, handles and promises still run normally; only requests and completion are observed.
function shutdownTimers() {
  const originals = [];
  const entries = [];
  const handles = new Map();
  let armed = false;
  const record = (api, ms) => {
    let done;
    const entry = { api, ms, scoped: armed, pending: true, fired: false, cleared: false, done: new Promise((r) => { done = r; }) };
    entry.finish = () => { entry.pending = false; done(); };
    entries.push(entry);
    return entry;
  };
  const replace = (target, key, fn) => { originals.push([target, key, target[key]]); target[key] = fn(target[key]); };
  for (const [label, target] of [['global', globalThis], ['timers', nodeTimers]]) {
    for (const kind of ['Timeout', 'Interval']) {
      replace(target, 'set' + kind, (original) => function (fn, ms, ...args) {
        const entry = record(label + '.set' + kind, ms);
        const handle = Reflect.apply(original, this, [function (...values) {
          entry.fired = true;
          if (kind === 'Timeout') entry.finish();
          return Reflect.apply(fn, this, values);
        }, ms, ...args]);
        handles.set(handle, entry);
        return handle;
      });
      replace(target, 'clear' + kind, (original) => function (handle) {
        const entry = handles.get(handle);
        if (entry) { entry.cleared = true; entry.finish(); }
        return Reflect.apply(original, this, [handle]);
      });
    }
  }
  replace(promiseTimers, 'setTimeout', (original) => function (ms, ...args) {
    const entry = record('promises.setTimeout', ms);
    return Reflect.apply(original, this, [ms, ...args]).then((value) => {
      entry.fired = true; entry.finish(); return value;
    }, (error) => { entry.finish(); throw error; });
  });
  replace(promiseTimers, 'setInterval', (original) => function (ms, ...args) {
    const entry = record('promises.setInterval', ms);
    const iterator = Reflect.apply(original, this, [ms, ...args]);
    return (async function* () {
      try { for await (const value of iterator) { entry.fired = true; yield value; } }
      finally { entry.finish(); }
    })();
  });
  syncBuiltinESMExports();
  return {
    entries,
    arm: () => { armed = true; },
    disarm: () => { armed = false; },
    restore: () => {
      armed = false;
      for (const [target, key, original] of originals) target[key] = original;
      syncBuiltinESMExports();
    },
    async drain() {
      await Promise.all(entries.filter((e) => e.scoped && e.pending).map((e) => e.done));
      await nextMacrotask();
    },
  };
}

// Immediate ENOENT drains the real child reader before runAll's setImmediate checkpoint.
// A settings failure during a pending real child-directory read is not covered here.
const missingWorkerPath = () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
const enoentFs = { readdir: missingWorkerPath, stat: missingWorkerPath, open: missingWorkerPath };

// ------------------------------------------------------------------ render.lock held by someone else

test('render.lock held 3s by another process: brief and /decide wait on timers, the terminal never stalls, then both publish', { timeout: 60_000 }, async (t) => {
  const s = make(t);
  await s.start();
  await s.brief(goodBrief({ decisions: [decision()] }));
  const before = seqOf(s.stateDir);
  const holder = await startHolder(t, s.stateDir, 3000);
  const waits = blockingBursts();
  let pending = true;
  const turn = new Promise((resolve) => setImmediate(() => resolve(pending)));
  let r;
  try {
    const pBrief = s.brief(goodBrief({ headline: '락 중 보고' }));
    const pDecide = s.command('decide', '1A');
    const publication = Promise.all([pBrief, pDecide]).finally(() => { pending = false; });
    const ranWhilePending = await turn;
    await holder.released;
    [r] = await publication;
    assert.equal(ranWhilePending, true, 'a real event-loop turn ran while publication was pending');
    waits.assert();
  } finally { waits.restore(); }
  assert.ok(text(r).startsWith('상황판 갱신됨'), text(r));
  assert.ok(seqOf(s.stateDir) >= before + 2, 'both publications went out');
  assert.equal(s.meta().errors.render, undefined);
  assert.equal(readData(s.stateDir).sessions[0].headline, '락 중 보고');
});

test('render.lock never released: render error after ~5s with no data.js written and no stall; the next publish shows the chip once, the one after clears it (data.js and server view)', { timeout: 60_000 }, async (t) => {
  const original = globalThis.setTimeout;
  const delays = [];
  let recording = false;
  globalThis.setTimeout = function (fn, ms, ...args) {
    if (recording) delays.push(ms);
    return Reflect.apply(original, this, [fn, ms, ...args]);
  };
  syncBuiltinESMExports();
  try {
    const versions = [];
    const fs = { ...nodeFs, renameSync(a, b) { if (/data\.js$/.test(String(b))) versions.push(nodeFs.readFileSync(a, 'utf8')); return nodeFs.renameSync(a, b); } };
    const s = make(t, { server: true, fs });
    await s.start();
    await s.brief(goodBrief());
    const url = serverUrl(s.stateDir);
    const written = versions.length;
    const dataBefore = readFileSync(join(s.stateDir, 'data.js'), 'utf8');
    const holder = await startHolder(t, s.stateDir, 0);
    const waits = blockingBursts();
    let pending = true;
    const turn = new Promise((resolve) => setImmediate(() => resolve(pending)));
    let r;
    recording = true;
    try {
      const publication = s.brief(goodBrief({ headline: '락 계속' })).finally(() => { pending = false; });
      const ranWhilePending = await turn;
      r = await publication;
      assert.equal(ranWhilePending, true, 'a real event-loop turn ran while publication was pending');
      waits.assert();
    } finally { recording = false; waits.restore(); }
    const expected = [20, 40, 80, 160, 320, 640, 1280, 2560];
    let retry = 0;
    for (const delay of delays) if (delay === expected[retry]) retry++;
    assert.equal(retry, expected.length, 'the native render retry sequence is an ordered subsequence: ' + delays);
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
  } finally {
    globalThis.setTimeout = original;
    syncBuiltinESMExports();
  }
});

test('session_shutdown stays under 2s with three SSE pages open and render.lock held elsewhere; server and files are gone', { timeout: 60_000 }, async (t) => {
  const timers = shutdownTimers(); // before make(): the extension captures these functions
  const { fs, hits, creations } = lockSpyFs();
  let holder;
  const pages = [];
  try {
    const s = make(t, { server: true, fs });
    await s.start();
    await s.brief(goodBrief());
    const url = serverUrl(s.stateDir);
    pages.push(...await Promise.all([sse(url), sse(url), sse(url)]));
    await Promise.all(pages.map((p) => p.waitFor((x) => x.includes('event: data'), 'first data')));
    holder = await startHolder(t, s.stateDir, 0);
    const closed = pages.map((p) => p.waitFor(() => p.state.closed, 'stream closed'));
    hits.length = 0;
    creations.length = 0;
    timers.arm();
    try { await s.host.emit('session_shutdown', {}, s.ctx); }
    finally { timers.disarm(); }
    await Promise.all(closed);
    const scoped = timers.entries.filter((e) => e.scoped);
    t.diagnostic(JSON.stringify({ shutdownLockOps: hits, shutdownLockCreations: creations.length, errors: s.meta().errors, timers: scoped.map(({ api, ms, fired, cleared, pending }) => ({ api, ms, fired, cleared, pending })) }));
    assert.deepEqual(scoped.filter((e) => e.fired && e.ms >= 2000).map((e) => [e.api, e.ms]), [], 'no shutdown timer of 2000ms or more fired or fulfilled');
    assert.ok(scoped.some((e) => e.ms === 1200), 'the shutdown-owned step guard was observed');
    assert.ok(scoped.filter((e) => e.ms === 1200 || e.ms === 500).every((e) => e.cleared && !e.fired), 'shutdown guards were cleared without firing');
    assert.deepEqual(scoped.filter((e) => e.pending).map((e) => [e.api, e.ms]), [], 'no scoped timer was left pending');
    assert.ok(creations.length <= 1, 'render.lock was created at most once during shutdown');
    const released = JSON.parse(readFileSync(join(s.stateDir, 'server.lock'), 'utf8'));
    assert.deepEqual(
      { pid: released.pid, generation: released.generation, released: released.released, port: released.port },
      { pid: process.pid, generation: 4, released: 'quit', port: Number(new URL(url).port) },
    );
    assert.equal(existsSync(join(s.stateDir, 'server.json')), false);
    await assert.rejects(get(url + 'health'), /ECONNREFUSED/);
  } finally {
    timers.disarm();
    try {
      if (holder) { holder.release(); await holder.released; }
      for (const page of pages) page.close();
      await timers.drain();
    } finally { timers.restore(); }
  }
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
  const released = JSON.parse(readFileSync(join(a.stateDir, 'server.lock'), 'utf8'));
  assert.deepEqual(
    { pid: released.pid, generation: released.generation, released: released.released, port: released.port },
    { pid: process.pid, generation: 4, released: 'quit', port: Number(new URL(url).port) },
  );
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

test('board writes through the real server: a store fault and a failing herdr leave a diagnostic in meta.errors, the replies stay bare codes, the token is in none of it; the next success clears both', { timeout: 30_000 }, async (t) => {
  const ctl = { deny: false, focusFails: true };
  const faulty = { ...nodeFs, readFileSync: (p, ...a) => {
    if (ctl.deny && /\/decisions\/000001\.json$/.test(norm(String(p)))) throw Object.assign(new Error(`EIO: i/o error, open '${norm(String(p))}'`), { code: 'EIO' });
    return nodeFs.readFileSync(p, ...a);
  } };
  const focusArgs = [];
  const execFile = (file, args, options, cb) => {
    focusArgs.push(args);
    queueMicrotask(() => cb(ctl.focusFails ? Object.assign(new Error('Command failed: herdr tab focus'), { code: 1 }) : null, '', ''));
  };
  const quiet = () => ({ wake: async () => {}, pendingIds: () => [], dispose: async () => {} });
  const s = make(t, { server: true, fs: faulty, extra: { execFile, createDeliverer: quiet } });
  await s.start();
  await s.brief(goodBrief({ decisions: [decision()] }));
  mkdirSync(join(s.stateDir, 'sessions', 'sess-B'), { recursive: true });
  writeFileSync(join(s.stateDir, 'sessions', 'sess-B', 'meta.json'), JSON.stringify({ sessionId: 'sess-B', tabId: 'w1:t5N' }));
  const url = serverUrl(s.stateDir);
  const port = new URL(url).port;
  const token = /<meta name="omo-board-token" content="([^"]+)">/.exec((await get(url)).body)[1];
  const post = (path, obj) => new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const headers = { Connection: 'close', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Sec-Fetch-Site': 'same-origin', Origin: `http://127.0.0.1:${port}`, 'X-Board-Token': token };
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const walk = (dir) => nodeFs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

  ctl.deny = true;
  const answer = await post('/answer', { id: 1, sessionId: 'sess-A', option: 'A' });
  const focus = await post('/focus', { sessionId: 'sess-B' });
  assert.deepEqual([answer.status, answer.body], [500, '{"ok":false,"code":"IO_ERROR"}']);
  assert.deepEqual([focus.status, focus.body], [502, '{"ok":false,"code":"HERDR_FAILED"}']);
  assert.deepEqual(focusArgs, [['tab', 'focus', 'w1:t5N']]);
  assert.deepEqual(Object.keys(s.meta().errors).sort(), ['answer', 'focus']);
  assert.match(s.meta().errors.answer.message, /i\/o error, open '.*decisions\/000001\.json'/, 'the cause survives in the recorded diagnostic');
  assert.match(s.meta().errors.focus.message, /Command failed/);

  const model = await get(`${url}data.json`);
  assert.ok(model.body.includes('오류 있음'), 'the board shows the failure chip');
  const detailIn = walk(s.stateDir).filter((f) => readFileSync(f, 'utf8').includes('i/o error'));
  assert.deepEqual(detailIn.map((f) => norm(f).split('/state/')[1]), ['sessions/sess-A/meta.json'], 'the detail is in the owner\'s meta.json and nowhere a page or reply can read it');
  for (const [what, text] of [['answer reply', answer.body], ['focus reply', focus.body], ['/data.json', model.body], ...walk(s.stateDir).map((f) => [norm(f), readFileSync(f, 'utf8')])]) {
    assert.ok(!text.includes(token), `${what} carries the token`);
  }
  assert.ok(!model.body.includes('i/o error') && !model.body.includes('Command failed'), '/data.json has no detail');

  ctl.deny = false;
  ctl.focusFails = false;
  assert.equal((await post('/answer', { id: 1, sessionId: 'sess-A', option: 'A' })).status, 200);
  assert.equal((await post('/focus', { sessionId: 'sess-B' })).status, 200);
  assert.deepEqual(s.meta().errors, {}, 'the next success of each source cleared its entry');
  assert.ok(!(await get(`${url}data.json`)).body.includes('오류 있음'), 'and the chip');
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
  const creations = [];
  const spy = { ...nodeFs };
  for (const [k, v] of Object.entries(nodeFs)) {
    if (typeof v === 'function') spy[k] = (...a) => {
      const lock = typeof a[0] === 'string' && /render\.lock$/.test(a[0]);
      if (typeof a[0] === 'string' && /render\.lock/.test(a[0])) hits.push(k);
      const result = v(...a);
      if (lock && k === 'writeFileSync') creations.push(a[0]); // EEXIST attempts did not create the held lock
      return result;
    };
  }
  return { fs: spy, hits, creations };
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
  const fields = new Set(['task_id', 'parent_session_id', 'status', 'task_summary', 'description', 'name', 'agent_type', 'category',
    'model_id', 'model', 'created_at', 'updated_at', 'terminal_at', 'child_session_id', 'resolved_model', 'live_progress']);
  for (let sample = 0; sample < 10; sample++) {
    const logs = [];
    const watched = (target, allowed) => {
      const log = { reads: new Map(), other: [], ownKeys: 0, descriptors: 0, has: 0 };
      logs.push(log);
      return new Proxy(target, {
        get(o, key, receiver) {
          if (allowed.has(key)) log.reads.set(key, (log.reads.get(key) ?? 0) + 1);
          else log.other.push(String(key));
          return Reflect.get(o, key, receiver);
        },
        ownKeys(o) { log.ownKeys++; return Reflect.ownKeys(o); },
        getOwnPropertyDescriptor(o, key) { log.descriptors++; return Reflect.getOwnPropertyDescriptor(o, key); },
        has(o, key) { log.has++; return Reflect.has(o, key); },
      });
    };
    // The array itself is intentionally not proxied: only the root and individual tasks are observed.
    const tasks = Array.from({ length: 256 }, (_, i) => watched({
      task_id: 'st_t' + i, parent_session_id: 'sess-A', status: 'running', task_summary: '작업 ' + i, updated_at: new Date().toISOString(), junk,
      get unused() { reads++; return junk; },
    }, fields));
    const data = watched({ parent_session_id: 'senpi:sess-A', tasks, get irrelevant() { reads++; return junk; } }, new Set(['parent_session_id', 'tasks']));
    s.events.emit(RPC, { name: 'omo.task.updated', data });
    const root = logs.at(-1);
    assert.deepEqual([...root.reads].sort(), [['parent_session_id', 1], ['tasks', 2]], 'root access counts per snapshot');
    assert.equal(logs.length - 1, 256, 'all 256 task objects were observed');
    for (const log of logs.slice(0, -1)) {
      assert.equal(log.reads.get('task_id'), 1, 'every task was visited');
      for (const [field, count] of log.reads) assert.ok(count <= 1, field + ' read more than once per task per snapshot');
    }
    for (const log of logs) {
      assert.deepEqual(log.other, [], 'no unselected fields were read');
      assert.deepEqual([log.ownKeys, log.descriptors, log.has], [0, 0, 0], 'no enumeration, descriptors or membership checks');
    }
  }
  assert.equal(reads, 0, 'no irrelevant getter was read');
  await s.start();
  const rows = await until(s.stateDir, () => {
    const r = readData(s.stateDir).sessions[0]?.live?.workers;
    return r && r.some((w) => w.id === 'st_t0') ? r : null;
  }, 'rows from the early snapshot');
  assert.ok(rows.length >= 1);
});

// ------------------------------------------------------------------ row 17: pause state and settings reads

test('row 17: a persistent EACCES on settings.json seen by the worker timers is recorded with its code, shows as the error chip, and the first good read clears it', { timeout: 60_000 }, async (t) => {
  const ctl = { deny: false, reads: 0 };
  const timers = fakeTimers();
  // workers-live rate-limits its publishes (2s) on its OWN clock; the fake timers never tick it, so it gets a clock the test moves
  const wl = { t: Date.now() };
  const s = make(t, { fs: settingsFaultFs(ctl), timers, extra: { workersLiveOptions: { now: () => wl.t, fs: enoentFs } } });
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
  const wl = { t: Date.now() };
  const s = make(t, { dir, fs: settingsFaultFs(ctl), timers, extra: { workersLiveOptions: { now: () => wl.t, fs: enoentFs } } });
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
