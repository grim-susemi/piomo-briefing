// Page cost by view-model size (plan board-cap-optimize, Must have 5). Each window measures the main-thread
// TaskDuration growth (CDP Performance.getMetrics, seconds) of one page over WINDOW_MS:
//   publish: PUBLISHES server publishes, one every PUBLISH_GAP_MS, must grow <= 4.5 s;
//   idle:    no change at all, must grow <= 3.0 s (server mode, and file mode whose page re-injects data.js every 2 s).
// The view model is synthetic: CARDS cards whose settled decisions are padded to exactly CAP_TIMING_BYTES of data.js text,
// injected straight into the host (no capSize), so the page receives the size under test.
// CAP_TIMING_BYTES defaults to MAX_VM_BYTES. CAP_TIMING_OUT appends one JSON line per window. The WINDOW/PUBLISH knobs are
// for dry runs only; the real measurement uses the defaults (60 s, 20 publishes, 3 s apart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../../scripts/cdp.mjs';
import { pageHtml, MAX_VM_BYTES } from '../../src/render.mjs';
import { createServerHost } from '../../src/server-host.mjs';
import { createBoardServer } from '../../src/server.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TARGET = Number(process.env.CAP_TIMING_BYTES || MAX_VM_BYTES);
const WINDOW_MS = Number(process.env.CAP_TIMING_WINDOW_MS || 60_000);
const PUBLISHES = Number(process.env.CAP_TIMING_PUBLISHES || 20);
const PUBLISH_GAP_MS = Number(process.env.CAP_TIMING_GAP_MS || 3000);
const OUT = process.env.CAP_TIMING_OUT || null;
const RUN = Number(process.env.CAP_TIMING_RUN || 0);
const BUDGET = { publish: 4.5, idle: 3.0 };
const GEN = 19;
const CARDS = 180;
const BASE_SEQ = 10000; // five digits, so publishes never change the data.js size
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/view-model-office.json'), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The data.js text the page receives (file mode writes it; server mode serves the same model as /data.json).
const dataText = (vm) => `/* seq:${vm.seq} */\nwindow.__briefData && window.__briefData(${JSON.stringify(vm)});\n`;

// CARDS cards; settled decisions are copied from a fixture card and added round-robin until the next one would not fit;
// a top-level ASCII pad then makes the data.js text exactly `target` bytes.
function buildModel(target) {
  // the smallest fixture card with a decision, so CARDS copies leave room for the settled decisions
  const [tpl] = FIXTURE.sessions.filter((s) => Array.isArray(s.decisions) && s.decisions.length > 0)
    .sort((a, b) => Buffer.byteLength(JSON.stringify(a)) - Buffer.byteLength(JSON.stringify(b)));
  assert.ok(tpl, 'fixture has a card with decisions');
  const sessions = Array.from({ length: CARDS }, (_, i) => ({ ...structuredClone(tpl), id: `syn-${i}`, decisions: [] }));
  const vm = { schema: FIXTURE.schema, seq: BASE_SEQ, generatedAt: FIXTURE.generatedAt, sessions, pad: '' };
  let size = Buffer.byteLength(dataText(vm));
  for (let n = 0; ; n++) {
    const i = n % CARDS;
    const d = { ...structuredClone(tpl.decisions[n % tpl.decisions.length]), id: `syn-${i}-d${n}`, sessionId: `syn-${i}` };
    const cost = Buffer.byteLength(JSON.stringify(d)) + 1; // +1: a comma; overcounts by one per card
    if (size + cost > target) break;
    sessions[i].decisions.push(d);
    size += cost;
  }
  const gap = target - Buffer.byteLength(dataText(vm));
  assert.ok(gap >= 0, `model overshoots ${target} B`);
  vm.pad = 'x'.repeat(gap);
  assert.equal(Buffer.byteLength(dataText(vm)), target);
  return vm;
}

const CASES = [
  { name: 'server, default screen, 20 publishes in 60 s', mode: 'server', screen: 'default', kind: 'publish' },
  { name: 'server, default screen, idle 60 s', mode: 'server', screen: 'default', kind: 'idle' },
  { name: 'file, default screen, idle 60 s', mode: 'file', screen: 'default', kind: 'idle' },
  { name: 'file, office screen, idle 60 s', mode: 'file', screen: 'office', kind: 'idle' },
  { name: 'server, office screen, idle 60 s', mode: 'server', screen: 'office', kind: 'idle' },
  { name: 'server, office screen, 20 publishes in 60 s', mode: 'server', screen: 'office', kind: 'publish' },
];

async function waitFor(page, expr, what, ms = 15000) {
  return page.eval(`new Promise((resolve, reject) => { const t0 = performance.now();
    const f = () => { let v = false; try { v = !!(${expr}); } catch (e) {}
      if (v) return resolve(true);
      if (performance.now() - t0 > ${ms}) return reject(new Error('timeout: ${what}'));
      setTimeout(f, 50); }; f(); })`);
}

const taskDuration = async (page) => (await page.client.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value;

async function measure(c) {
  const model = buildModel(TARGET);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-cap-timing-'));
  const dataFile = path.join(tmp, 'data.js');
  const out = { candidate_bytes: TARGET, run: RUN, mode: c.mode, screen: c.screen, kind: c.kind, budget_s: c.kind === 'publish' ? BUDGET.publish : BUDGET.idle };
  let host = null;
  let page = null;
  try {
    let url = null;
    if (c.mode === 'server') {
      host = createServerHost({
        stateDir: tmp, sessionId: 'cap-timing', generation: GEN,
        installedGeneration: async () => null, isEnabled: () => true,
        readSnapshot: () => ({ published: { seq: model.seq } }),
        buildViewModel: () => structuredClone(model), buildFull: () => structuredClone(model), project: () => structuredClone(model),
        getPage: (vm, token, nonce) => pageHtml(vm, GEN, { mode: 'server', token, nonce }),
        answer: () => ({ status: 500, json: { ok: false, code: 'CAP_TIMING_NO_WRITE' } }),
        focus: () => ({ status: 500, json: { ok: false, code: 'CAP_TIMING_NO_WRITE' } }),
        env: { OMO_BRIEFING_PORT_BASE: '49500' }, now: () => model.generatedAt,
        createBoardServer: (o) => createBoardServer(o),
        onError: () => {},
      });
      ({ url } = await host.ensure());
    }
    page = await launch({ width: 1440, height: 900 });
    await page.client.send('Performance.enable');
    if (c.mode === 'server') {
      await page.goto(url);
    } else {
      fs.writeFileSync(dataFile, dataText(model));
      fs.writeFileSync(path.join(tmp, 'index.html'), pageHtml(model, GEN, { mode: 'file' }));
      await page.goto(path.join(tmp, 'index.html'));
    }
    await waitFor(page, `window.BriefPage && BriefPage.state.model && BriefPage.state.model.seq === ${model.seq}`, 'the page has the model');
    if (c.screen === 'office') {
      await page.eval(`document.querySelector('[data-sh="view"][data-key="office"]').click()`);
      await waitFor(page, `document.querySelectorAll('#office .of-desk').length >= 1`, 'office screen drawn');
    }
    const start = await page.eval(`({ visibility: document.visibilityState, animations: document.getAnimations().length })`);
    const before = await taskDuration(page);
    const t0 = Date.now();
    let applied = 0;
    const publishErrors = [];
    if (c.kind === 'publish') {
      for (let k = 0; k < PUBLISHES; k++) {
        await sleep(t0 + k * PUBLISH_GAP_MS - Date.now()); // the publish schedule is the load, not the judge
        model.seq += 1;
        host.notifyPublished();
        try {
          await waitFor(page, `BriefPage.state.model.seq === ${model.seq}`, `publish ${k + 1} applied`, 8000);
          applied += 1;
        } catch (err) {
          publishErrors.push(err.message);
        }
      }
    }
    await sleep(t0 + WINDOW_MS - Date.now());
    out.window_ms = Date.now() - t0;
    out.growth_s = (await taskDuration(page)) - before;
    out.TaskDuration_before = before;
    out.visibility_start = start.visibility;
    out.visibility_end = await page.eval('document.visibilityState');
    out.page_seq = await page.eval('BriefPage.state.model.seq');
    out.model_seq = model.seq;
    if (c.mode === 'server') {
      const body = await (await fetch(new URL('/data.json', url), { cache: 'no-store' })).text();
      out.received_bytes = Buffer.byteLength(body);
    } else {
      out.received_bytes = fs.statSync(dataFile).size;
    }
    out.received_pct = Number(((100 * out.received_bytes) / TARGET).toFixed(2));
    out.publishes_sent = c.kind === 'publish' ? PUBLISHES : 0;
    out.publishes_applied = applied;
    out.publish_errors = publishErrors;
    const checks = {
      visible_at_end: out.visibility_end === 'visible',
      page_at_latest_seq: out.page_seq === model.seq,
      publishes_applied_all: c.kind !== 'publish' || applied === PUBLISHES,
      received_98_102: out.received_pct >= 98 && out.received_pct <= 102,
      office_drawn: c.screen !== 'office' || (await page.eval(`document.querySelectorAll('#office .of-desk').length`)) >= 1,
    };
    out.checks = checks;
    out.invalid_reasons = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
    out.valid = out.invalid_reasons.length === 0;
    out.pass = out.valid && out.growth_s <= out.budget_s;
    return out;
  } finally {
    if (OUT) fs.appendFileSync(OUT, JSON.stringify(out) + '\n');
    if (page) await page.close();
    if (host) await host.release();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

for (const c of CASES) {
  test(`cap size timing, ${c.name}`, { timeout: 600_000 }, async () => {
    const out = await measure(c);
    assert.ok(out.valid, `invalid window: ${out.invalid_reasons.join(', ')}`);
    assert.ok(out.growth_s <= out.budget_s, `${c.kind} growth ${out.growth_s.toFixed(3)} s > ${out.budget_s} s at ${TARGET} B`);
  });
}
