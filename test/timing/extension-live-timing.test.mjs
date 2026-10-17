// Original release-time limits; run on a quiet PC with npm run check:timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RPC, REGISTRY, nextBase, norm, text, goodBrief, decision, PLAN_TEXT, planInput,
  fakeTimers, make, seqOf, parseData, readData, serverUrl, until, get, sse, startHolder,
  settingsFaultFs, ERR_CHIP, chipsOf, workerSnap, nextMacrotask, noHooks, seedErrors,
} from '../helpers/live-fixture.mjs';
import { lagProbe } from '../helpers/live-fixture.mjs';

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
  const released = JSON.parse(nodeFs.readFileSync(join(s.stateDir, 'server.lock'), 'utf8'));
  assert.deepEqual(
    { pid: released.pid, generation: released.generation, released: released.released, port: released.port },
    { pid: process.pid, generation: 4, released: 'quit', port: Number(new URL(url).port) },
  );
  assert.equal(existsSync(join(s.stateDir, 'server.json')), false);
  await Promise.all(pages.map((p) => p.waitFor(() => p.state.closed, 'stream closed')));
  await assert.rejects(get(`${url}health`), /ECONNREFUSED/);
  holder.release();
  await holder.released;
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
