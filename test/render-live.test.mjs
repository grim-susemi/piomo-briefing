// Generation-4 parts of src/render.mjs: the 600KB cap, the plan / worker / waiting / server parts of the view model,
// the page template, and the async publish (free lock = finished inside the call; busy lock = awaited timers, soft = once).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import vmMod from 'node:vm';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { buildViewModel, renderPage, renderPageAsync, renderPageMaybe, pageHtml, serverInfoOf, MAX_VM_BYTES, OMITTED_CHIP } from '../src/render.mjs';

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'omo-render-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return openStore(join(dir, 'state'));
}
const session = (store, sid, { at = NOW - 1000, status = 'in_progress', auto, extra = {} } = {}) => {
  store.replace(`sessions/${sid}/meta.json`, { sessionId: sid, cwd: `C:/p/${sid}`, title: sid, lastActivityAt: at, lastBriefAt: at, ...(auto ? { auto } : {}), ...extra });
  store.writeNew(`sessions/${sid}/briefs/000001.json`, { at, brief: { title: sid, status, headline: `${sid} 진행`, changes: [], done: [], next: '', decisions: [] } });
};
const dataOf = (store) => {
  const src = store.readText('data.js');
  return JSON.parse(src.slice(src.lastIndexOf('window.__briefData(') + 'window.__briefData('.length, src.lastIndexOf(');')));
};

// ------------------------------------------------------------------ 600KB cap

test('30 conversations x 20 workers x 30 todos: data.js stays under 600KB, finished conversations lose live details first and carry the chip', (t) => {
  const store = fresh(t);
  const todo = (i) => Array.from({ length: 30 }, (_, k) => ({ text: `할 일 ${i}-${k} `.padEnd(70, '가'), status: k < 10 ? 'completed' : 'pending' }));
  const workers = (s) => Array.from({ length: 20 }, (_, i) => ({
    id: `st_${s}_${i}`, name: `작업자 ${i}`.padEnd(40, '나'), model: 'Sol 6.1', state: 'running', step: '읽는 중'.padEnd(70, '다'),
    startedAt: NOW - 60_000, updatedAt: NOW - 1000, todo: { items: todo(i), total: 30, done: 10, more: 0 },
  }));
  for (let s = 0; s < 30; s++) {
    // even: finished and old; odd: running and recent
    session(store, `s${String(s).padStart(2, '0')}`, { at: NOW - (s % 2 === 0 ? 20_000_000 + s : 1000 + s), status: s % 2 === 0 ? 'done' : 'in_progress', auto: { live: { workers: workers(s) } } });
  }
  const raw = JSON.stringify(buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false })).length;
  assert.ok(raw < MAX_VM_BYTES * 4, 'sanity: the model is built');
  const uncapped = 30 * 20 * 30 * 120;
  assert.ok(uncapped > MAX_VM_BYTES, `the uncapped model really is too big (~${uncapped})`);
  const res = renderPage(store, NOW, { isAlive: () => false });
  assert.equal(res.ok, true);
  const bytes = Buffer.byteLength(store.readText('data.js'));
  assert.ok(bytes <= MAX_VM_BYTES + 200, `data.js is ${bytes} bytes`); // + the fixed `window.__briefData(...)` wrapper
  const sessions = dataOf(store).sessions;
  const stripped = sessions.filter((s) => s.chips.includes(OMITTED_CHIP));
  assert.ok(stripped.length > 0 && stripped.every((s) => s.live === undefined));
  assert.ok(stripped.some((s) => s.tab === '끝남'), 'finished conversations are cut');
  const kept = sessions.filter((s) => s.live !== undefined);
  assert.ok(kept.length > 0 && kept.every((s) => !s.chips.includes(OMITTED_CHIP)), 'a conversation that kept its rows has no chip');
  assert.ok(kept.every((s) => s.tab !== '끝남') || stripped.length === sessions.length, 'running ones are kept before finished ones');
});

test('a model under the cap is untouched', (t) => {
  const store = fresh(t);
  session(store, 'a', { auto: { live: { workers: [{ id: 'st_1', name: 'n', state: 'running', todo: { items: [], total: 0, done: 0, more: 0 } }] } } });
  const vm = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false });
  assert.equal(vm.sessions[0].live.workers.length, 1);
  assert.ok(!vm.sessions[0].chips.includes(OMITTED_CHIP));
});

// ------------------------------------------------------------------ view model parts

test('vm.gen, vm.server and vm.waiting: server only while its pid lives, waiting only for conversations on the board', (t) => {
  const store = fresh(t);
  session(store, 'shown');
  session(store, 'old', { at: NOW - 31 * DAY });
  const two = { A: { text: 'a', consequence: 'x' }, B: { text: 'b', consequence: 'y' } };
  store.allocDecisionId({ sessionId: 'shown', question: '보이는 질문', options: two, recommend: 'A', reason: 'r', blocks: true, createdAt: NOW - 500, source: 'brief' });
  store.allocDecisionId({ sessionId: 'old', question: '안 보이는 질문', options: two, recommend: 'A', reason: 'r', blocks: true, createdAt: NOW - 400, source: 'brief' });
  store.replace('server.json', { pid: 123, port: 47999, generation: 4 });
  assert.deepEqual(serverInfoOf(store, () => true), { server: { url: 'http://127.0.0.1:47999/', generation: 4 }, error: false });
  assert.deepEqual(serverInfoOf(store, () => false), { server: null, error: false }, 'a dead owner is not an address');
  const vm = buildViewModel(store.readSnapshot(), NOW, { generation: 4, server: serverInfoOf(store, () => true).server, isAlive: () => false });
  assert.equal(vm.gen, 4);
  assert.equal(vm.server.url, 'http://127.0.0.1:47999/');
  assert.deepEqual(vm.waiting.map((w) => [w.sessionId, w.key]), [['shown', 'd1']]);
  assert.equal(buildViewModel(store.readSnapshot(), NOW).gen, null, 'a checkout has no generation');
});

test('an unreadable server.json is listed in readErrors, not read as "no server"', (t) => {
  const store = fresh(t);
  store.replace('server.json', '{ not json');
  assert.deepEqual(serverInfoOf(store, () => true), { server: null, error: false }, 'broken JSON is a record that is not an address');
  const vm = buildViewModel(store.readSnapshot(), NOW, { serverError: true });
  assert.ok(vm.readErrors.includes('server.json'));
});

test('plan model: task states from boxes and ledger, boulder work as stage, stored answer over the agent claim, link and fallback card', (t) => {
  const store = fresh(t);
  const planId = 'p0123456789ab';
  session(store, 'owner', { extra: { planIds: [planId], planChips: { [planId]: { chips: ['계획 파일이 요약 뒤에 바뀜'], checkedAt: NOW - 5000 } } } });
  session(store, 'runner');
  const q = { id: 'Q1', text: '진행할까요?', state: 'open', options: { A: { text: '진행', consequence: 'c' }, B: { text: '보류', consequence: 'd' } }, recommend: 'A', reason: 'r', blocks: true };
  store.writePlanRev(planId, {
    schema: 'omo-plan/1', planId, at: NOW - 9000, ownerSessionId: 'owner', source: { root: 'c:/p', slug: 'demo', planPath: 'C:/p/.omo/plans/demo.md' },
    plan: {
      stage: 'review', goal: '목표', ideal: [], components: [], waves: [{ n: 1, label: '기초' }],
      tasks: ['1', '2', '3', '4'].map((id) => ({ id, wave: 1, label: `일${id}`, what: 'w', done: 'd', deps: [] })), questions: [q], outOfScope: [],
    },
  });
  store.writePlanStatus(planId, {
    schema: 'omo-plan-status/1', planId, at: NOW - 3000, bySessionId: 'owner', files: {}, boxes: { 1: 'x', 2: '~' },
    ledger: { 3: { last: 'dispatch', at: NOW - 2000 } }, work: { workId: 'w1', status: 'running', sessionIds: ['senpi:runner', 'senpi:owner'] }, errors: [],
  });
  const decisionId = store.allocDecisionId({ sessionId: 'owner', question: q.text, options: q.options, recommend: 'A', reason: 'r', blocks: true, createdAt: NOW - 8000, source: 'plan', planId, qid: 'Q1' });

  let vm = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false });
  const owner = vm.sessions.find((s) => s.id === 'owner');
  assert.deepEqual(owner.plan.tasks.map((x) => x.state), ['done', 'stopped', 'doing', 'todo']);
  assert.equal(owner.plan.stage, 'running', 'a running boulder work shows the plan as running');
  assert.equal(owner.plan.questions[0].decisionId, decisionId);
  assert.deepEqual(owner.plan.chips, ['계획 파일이 요약 뒤에 바뀜']);
  assert.equal(owner.plan.checkedAt, NOW - 5000);
  const runner = vm.sessions.find((s) => s.id === 'runner');
  assert.equal(runner.plan, undefined);
  assert.deepEqual(runner.planLink, { planId, ownerId: 'owner', source: { slug: 'demo' }, stage: 'running', goal: '목표' });

  store.writeNew(`answers/${String(decisionId).padStart(6, '0')}.json`, { id: decisionId, option: 'B', at: NOW - 100 });
  vm = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false });
  const answered = vm.sessions.find((s) => s.id === 'owner').plan.questions[0];
  assert.equal(answered.state, 'answered', 'the stored answer wins over the agent claim of "open"');
  assert.equal(answered.by, 'owner');
  assert.match(answered.answer, /^B 보류/);

  // owner not on the board (too old): the executing conversation shows the plan itself
  store.replace('sessions/owner/meta.json', { sessionId: 'owner', cwd: 'C:/p/owner', title: 'owner', lastActivityAt: NOW - 40 * DAY, planIds: [planId] });
  store.replace('sessions/owner/briefs/000001.json', { at: NOW - 40 * DAY, brief: { title: 'owner', status: 'done', headline: 'h' } });
  vm = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false });
  assert.equal(vm.sessions.find((s) => s.id === 'owner'), undefined);
  assert.equal(vm.sessions.find((s) => s.id === 'runner').plan.goal, '목표');
});

test('a plan file with structure but no summary is a labelled skeleton, never a summary', (t) => {
  const store = fresh(t);
  const planId = 'pabcdef012345';
  session(store, 'a', { extra: { planFiles: { [planId]: { planPath: 'C:/p/.omo/plans/demo.md' } }, planChips: { [planId]: { chips: ['계획 요약 없음'], checkedAt: NOW - 1000 } } } });
  store.writePlanStatus(planId, {
    schema: 'omo-plan-status/1', planId, at: NOW - 500, bySessionId: 'a', files: {}, boxes: { 1: 'x' }, ledger: {}, errors: [],
    skeleton: { tasks: [{ id: '1', title: '첫째 일', wave: 1, deps: [] }, { id: '2', title: '둘째 일', wave: 2, deps: ['1'] }] },
  });
  const plan = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false }).sessions[0].plan;
  assert.ok(plan.chips.includes('자동 추출(요약 없음)') && plan.chips.includes('계획 요약 없음'));
  assert.deepEqual(plan.tasks.map((x) => [x.id, x.state, x.wave]), [['1', 'done', 1], ['2', 'todo', 2]]);
  assert.equal(plan.source.slug, 'demo');
});

// ------------------------------------------------------------------ page template

test('pageHtml inlines every page module and the first-paint model, with generation and mode markers; script text cannot break out', () => {
  const vm = { schema: 1, seq: 7, gen: 4, sessions: [{ id: 'x', title: '</script><script>alert(1)</script>' }], waiting: [], server: null };
  const html = pageHtml(vm, 4, { mode: 'server' });
  assert.match(html, /<meta name="omo-briefing-generation" content="4">/);
  assert.match(html, /<meta name="omo-briefing-mode" content="server">/);
  const order = ['g.BriefView = ', 'g.BriefPlanView = ', 'g.BriefWorkersView = ', 'g.BriefAlarm = ', 'g.BriefPage = '].map((n) => html.indexOf(n));
  assert.ok(order.every((i) => i > 0), `all five modules are inline: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'view.js first, page.js last');
  for (const css of ['.plan-view', '.w-row', '#alarm-band']) assert.ok(html.includes(css), css);
  assert.equal((html.match(/<script>/g) ?? []).length, 6, 'five modules + first paint');
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.equal(pageHtml(vm, null, { mode: 'file' }).includes('omo-briefing-generation'), false);
});

// ------------------------------------------------------------------ async publish

const holdLock = (store, pid = process.pid) => store.writeNew('render.lock', { pid, at: 1, nonce: 'held-by-test' });

test('renderPageAsync: a free lock gives the same result as renderPage, and the publish happened before the call returned', async (t) => {
  const store = fresh(t);
  session(store, 'a');
  const sync = renderPage(store, NOW);
  const promise = renderPageAsync(store, NOW);
  const seqAfterCall = JSON.parse(store.readText('published.json')).seq;
  assert.equal(seqAfterCall, sync.seqs.at(-1) + 1, 'ran inside the call, not on a later tick');
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(renderPageMaybe(store, NOW).ok, true, 'renderPageMaybe returns the plain result for a free lock');
});

test('renderPageAsync: a live render.lock is waited for on timers (event loop keeps running) and then reported like renderPage', async (t) => {
  const store = fresh(t);
  session(store, 'a');
  holdLock(store);
  const waits = [];
  let ticks = 0;
  const h = setInterval(() => { ticks++; }, 1);
  const res = await renderPageAsync(store, NOW, { sessionId: 'a', sleepAsync: async (ms) => { waits.push(ms); await new Promise((r) => setTimeout(r, 2)); } });
  clearInterval(h);
  assert.equal(res.ok, false);
  assert.equal(res.unshown, true);
  assert.match(res.error, /render\.lock/);
  assert.deepEqual(waits, [20, 40, 80, 160, 320, 640, 1280, 2560].slice(0, 8), 'same budget as the synchronous path (~5.1s)');
  assert.ok(ticks > 0, 'timers ran while it waited');
  assert.match(JSON.parse(store.readText('sessions/a/meta.json')).errors.render.message, /render\.lock/, 'recorded');
  assert.equal(store.readText('data.js'), null, 'nothing was published');
});

test('renderPageAsync soft: one look at a busy lock, no waiting, nothing recorded', async (t) => {
  const store = fresh(t);
  session(store, 'a');
  holdLock(store);
  let waited = false;
  const res = await renderPageAsync(store, NOW, { soft: true, sessionId: 'a', sleepAsync: async () => { waited = true; } });
  assert.deepEqual([res.ok, res.busy], [false, true]);
  assert.equal(waited, false);
  assert.equal(JSON.parse(store.readText('sessions/a/meta.json')).errors, undefined, 'a soft miss is not an error');
  assert.equal(store.readText('data.js'), null);
  assert.ok(store.readText('render.lock') !== null, 'a live owner is never removed');
});

test('renderPageAsync reclaims a dead owner exactly like renderPage and publishes', async (t) => {
  const store = fresh(t);
  session(store, 'a');
  store.writeNew('render.lock', { pid: 2_147_483_000, at: 1, nonce: 'dead' });
  const res = await renderPageAsync(store, NOW, { isAlive: (pid) => pid === process.pid, soft: true });
  assert.equal(res.ok, true);
  assert.ok(readFileSync(join(store.root, 'data.js'), 'utf8').includes('window.__briefData'));
});

// ------------------------------------------------------------------ attempt 2: B1, B3, B4 and the pause guard of the renderer

const PLAN_ID = 'p0123456789ab';
const twoOptions = { A: { text: '진행', consequence: 'c' }, B: { text: '보류', consequence: 'd' } };
function writePlan(store, { ownerSessionId = 'owner', questions = [], tasks = ['1'], withStatus = null } = {}) {
  store.writePlanRev(PLAN_ID, {
    schema: 'omo-plan/1', planId: PLAN_ID, at: NOW - 9000, ownerSessionId, source: { root: 'c:/p', slug: 'demo', planPath: 'C:/p/.omo/plans/demo.md' },
    plan: {
      stage: 'review', goal: '목표', ideal: [], components: [], waves: [{ n: 1, label: '기초' }],
      tasks: tasks.map((id) => ({ id, wave: 1, label: `일${id}`, what: 'w', done: 'd', deps: [] })), questions, outOfScope: [],
    },
  });
  if (withStatus) store.writePlanStatus(PLAN_ID, { schema: 'omo-plan-status/1', planId: PLAN_ID, at: NOW - 3000, bySessionId: ownerSessionId, files: {}, boxes: {}, ledger: {}, ...withStatus, errors: [] });
}
const loadPage = () => {
  const g = { console: { warn() {}, error() {} } };
  vmMod.createContext(g);
  for (const n of ['view.js', 'plan-view.js', 'workers-view.js', 'alarm.js']) vmMod.runInContext(readFileSync(new URL(`../src/page/${n}`, import.meta.url), 'utf8'), g, { filename: n });
  return g;
};

test('B1: a later agent claim "answered A" never replaces the stored owner answer B', (t) => {
  const store = fresh(t);
  session(store, 'owner');
  const open = { id: 'Q1', text: '진행할까요?', state: 'open', options: twoOptions, recommend: 'A', reason: 'r', blocks: true };
  writePlan(store, { questions: [open] });
  const id = store.allocDecisionId({ sessionId: 'owner', question: open.text, options: twoOptions, recommend: 'A', reason: 'r', blocks: true, createdAt: NOW - 8000, source: 'plan', planId: PLAN_ID, qid: 'Q1' });
  store.writeNew(`answers/${String(id).padStart(6, '0')}.json`, { id, option: 'B', at: NOW - 100 });
  writePlan(store, { questions: [{ ...open, state: 'answered', answer: 'A 진행', by: 'agent' }] }); // a valid later revision
  const vm = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false });
  const plan = vm.sessions.find((s) => s.id === 'owner').plan;
  assert.equal(plan.rev, 2, 'the answered-A revision is the one shown');
  const q = plan.questions[0];
  assert.deepEqual([q.state, q.by, q.option], ['answered', 'owner', 'B']);
  assert.match(q.answer, /^B 보류/);
});

test('B1: an agent claim of "answered" with no stored answer stays as claimed', (t) => {
  const store = fresh(t);
  session(store, 'owner');
  writePlan(store, { questions: [{ id: 'Q1', text: '?', state: 'answered', answer: 'A 진행', by: 'agent', options: twoOptions, recommend: 'A', reason: 'r', blocks: false }] });
  const q = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false }).sessions[0].plan.questions[0];
  assert.deepEqual([q.state, q.by, q.answer], ['answered', 'agent', 'A 진행']);
});

test('B3: the 600KB cap counts the ESCAPED data.js bytes: strings full of "<" (6 bytes each once escaped) still end at <= 614400', (t) => {
  const store = fresh(t);
  const lt = (n) => '<'.repeat(n);
  const workers = (s) => Array.from({ length: 20 }, (_, i) => ({
    id: `st_${s}_${i}`, name: 'name', model: 'Sol', kind: 'test', state: 'running', step: lt(80), startedAt: NOW - 60_000, updatedAt: NOW - 1000,
    todo: { items: Array.from({ length: 30 }, () => ({ text: lt(80), status: 'pending' })), total: 30, done: 0, more: 0 },
  }));
  for (let s = 0; s < 30; s++) {
    session(store, `s${String(s).padStart(2, '0')}`, { at: NOW - (s % 2 === 0 ? 20_000_000 + s : 1000 + s), status: s % 2 === 0 ? 'done' : 'in_progress', auto: { live: { workers: workers(s) } } });
  }
  const res = renderPage(store, NOW, { isAlive: () => false });
  assert.equal(res.ok, true);
  const bytes = Buffer.byteLength(store.readText('data.js'));
  assert.ok(bytes <= 614400, `data.js is ${bytes} bytes`);
  assert.equal(MAX_VM_BYTES, 614400);
  const sessions = dataOf(store).sessions;
  assert.ok(sessions.some((s) => s.chips.includes(OMITTED_CHIP)), 'the omission chip is shown');
  assert.ok(sessions.some((s) => s.live !== undefined), 'what fits is kept');
  const json = Buffer.byteLength(JSON.stringify(buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false })));
  assert.ok(json <= 614400, `/data.json view model is ${json} bytes`);
});

test('B4: no owner on the board and two executing conversations: the full plan sits on exactly one (deterministic), the other links to it; every data-anchor occurs once', (t) => {
  const store = fresh(t);
  session(store, 'runner-a', { at: NOW - 2000 });
  session(store, 'runner-b', { at: NOW - 1000 });
  store.replace('sessions/gone/meta.json', { sessionId: 'gone', cwd: 'C:/p/gone', title: 'gone', lastActivityAt: NOW - 40 * DAY, planIds: [PLAN_ID] });
  store.replace('sessions/gone/briefs/000001.json', { at: NOW - 40 * DAY, brief: { title: 'gone', status: 'done', headline: 'h' } });
  writePlan(store, { ownerSessionId: 'gone', withStatus: { work: { workId: 'w1', status: 'running', sessionIds: ['senpi:runner-a', 'senpi:runner-b'] } } });
  const build = () => buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false });
  const vm = build();
  assert.equal(vm.sessions.find((s) => s.id === 'gone'), undefined);
  const holders = vm.sessions.filter((s) => s.plan);
  assert.equal(holders.length, 1, 'one card carries the plan');
  const other = vm.sessions.find((s) => s.id !== holders[0].id);
  assert.equal(other.plan, undefined);
  assert.equal(other.planLink.ownerId, holders[0].id, 'the other card links to the one that carries the plan');
  assert.equal(JSON.stringify(other.planLink).includes('anchor'), false);
  assert.equal(build().sessions.find((s) => s.plan).id, holders[0].id, 'the choice is deterministic');
  const html = loadPage().BriefView.renderApp(vm, { expanded: { [`plan:${PLAN_ID}`]: true } });
  const anchors = [...html.matchAll(/data-anchor="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.length >= 7, `expanded plan has its anchors: ${anchors.length}`);
  assert.equal(new Set(anchors).size, anchors.length, 'every data-anchor value occurs exactly once on the page');
});

test('B2 (renderer): canPublish false before the write: nothing is written, the lock is released, the result says paused', (t) => {
  const store = fresh(t);
  session(store, 'a');
  renderPage(store, NOW);
  const before = [store.readText('data.js'), store.readText('published.json'), store.readText('index.html')];
  const res = renderPage(store, NOW + 5, { canPublish: () => false });
  assert.equal(res.ok, false);
  assert.equal(res.paused, true);
  assert.deepEqual([store.readText('data.js'), store.readText('published.json'), store.readText('index.html')], before);
  assert.equal(existsSync(join(store.root, 'render.lock')), false, 'the lock was given back');
});

test('B2 (renderer): a publish that waited for the lock and finds itself paused afterwards does not even take the lock', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omo-render-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hits = [];
  const spy = { ...nodeFs };
  for (const [k, v] of Object.entries(nodeFs)) {
    if (typeof v === 'function') spy[k] = (...a) => { if (typeof a[0] === 'string' && /render\.lock/.test(a[0])) hits.push(k); return v(...a); };
  }
  const store = openStore(join(dir, 'state'), { fs: spy });
  session(store, 'a');
  renderPage(store, NOW);
  const before = store.readText('published.json');
  holdLock(store);
  hits.length = 0;
  let paused = false;
  const res = await renderPageAsync(store, NOW + 5, {
    canPublish: () => !paused,
    sleepAsync: async () => { paused = true; hits.length = 0; /* the first look at the lock is over: from here on nothing may touch it */ rmSync(join(store.root, 'render.lock')); }, // the owner went away AND someone paused while we waited
  });
  assert.equal(res.paused, true);
  assert.equal(store.readText('published.json'), before);
  assert.equal(existsSync(join(store.root, 'render.lock')), false);
  assert.deepEqual(hits, [], 'after the wait the paused publish did not touch render.lock');
});

// ------------------------------------------------------------------ row 19: server.json is read within bounds

/** A store whose bounded-read traffic is recorded; `ctl.code` makes every read of server.json fail with that errno. */
function boundedStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'omo-render-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = { requested: 0, returned: 0, whole: 0, failed: 0 };
  const ctl = { code: null };
  const injected = () => Object.assign(new Error(`${ctl.code}: injected`), { code: ctl.code });
  const fs = {
    ...nodeFs,
    openSync(f, ...a) {
      if (ctl.code && String(f).endsWith('server.json')) { log.failed++; throw injected(); }
      return nodeFs.openSync(f, ...a);
    },
    readFileSync(f, ...a) {
      if (String(f).endsWith('server.json')) {
        log.whole++;
        if (ctl.code) { log.failed++; throw injected(); }
      }
      return nodeFs.readFileSync(f, ...a);
    },
    readSync(fd, buffer, offset, length, position) {
      log.requested += length;
      const n = nodeFs.readSync(fd, buffer, offset, length, position);
      log.returned += n;
      return n;
    },
  };
  const store = openStore(join(dir, 'state'), { fs, sleep() {} });
  return { store, log, ctl, file: join(dir, 'state', 'server.json') };
}

test('row 19 render: serverInfoOf reads a normal record in one bounded pass; an over-limit valid JSON record is a visible error that consumes no byte; a valid record recovers', (t) => {
  const { store, log, file } = boundedStore(t);
  const good = { pid: 123, port: 47999, generation: 4 };
  const address = { server: { url: 'http://127.0.0.1:47999/', generation: 4 }, error: false };
  store.replace('server.json', good);
  const size = nodeFs.statSync(file).size;
  assert.deepEqual(serverInfoOf(store, () => true), address);
  assert.equal(log.whole, 0, 'no whole-file read');
  assert.equal(log.returned, size);
  assert.ok(log.requested <= size + 2, `requested ${log.requested} for ${size} bytes`);

  const big = JSON.stringify({ ...good, pad: 'x'.repeat(20_000) }); // valid JSON, over the 16 KiB record limit
  nodeFs.writeFileSync(file, big);
  const [requested, returned] = [log.requested, log.returned];
  const bad = serverInfoOf(store, () => true);
  assert.equal(bad.server, null);
  assert.equal(bad.error, true);
  assert.ok(bad.message.includes('server.json') && bad.message.includes(String(Buffer.byteLength(big))), bad.message);
  assert.deepEqual([log.requested, log.returned, log.whole], [requested, returned, 0], 'the over-limit file was not read');
  assert.ok(buildViewModel(store.readSnapshot(), NOW, { serverError: bad.error }).readErrors.includes('server.json'));

  store.replace('server.json', good);
  assert.deepEqual(serverInfoOf(store, () => true), address, 'a valid record recovers');
});

test('row 19 render: a size-only (truncated) server.json through the real publish is refused unread; data.js lists it in readErrors, the hook sees the error, a valid record recovers', (t) => {
  const { store, log, file } = boundedStore(t);
  session(store, 'a');
  nodeFs.writeFileSync(file, '');
  nodeFs.truncateSync(file, 64 * 1024 * 1024);
  const seen = [];
  const opts = { isAlive: () => true, onServerInfo: (info) => seen.push(info) };
  assert.equal(renderPage(store, NOW, opts).ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].error, true);
  assert.deepEqual([log.requested, log.returned, log.whole], [0, 0, 0], 'not a byte of the big file was read');
  assert.ok(dataOf(store).readErrors.includes('server.json'));

  store.replace('server.json', { pid: 123, port: 47999, generation: 4 });
  assert.equal(renderPage(store, NOW + 5, opts).ok, true);
  assert.equal(seen.at(-1).error, false);
  assert.ok(!dataOf(store).readErrors.includes('server.json'));
  assert.equal(dataOf(store).server.url, 'http://127.0.0.1:47999/');
});

test('row 19 render: server.json absent is "no server" (no error); unreadable is an error with its code after a bounded number of attempts; a good read recovers', (t) => {
  const { store, log, ctl } = boundedStore(t);
  assert.deepEqual(serverInfoOf(store, () => true), { server: null, error: false }, 'absent');
  store.replace('server.json', { pid: 123, port: 47999, generation: 4 });
  ctl.code = 'EACCES';
  const info = serverInfoOf(store, () => true);
  assert.equal(info.error, true);
  assert.ok(info.message.includes('EACCES'), info.message);
  assert.ok(log.failed > 1 && log.failed <= 8, `bounded attempts: ${log.failed}`);
  ctl.code = null;
  assert.equal(serverInfoOf(store, () => true).error, false);
});
