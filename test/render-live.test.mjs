// Generation-4 parts of src/render.mjs: the 600KB cap, the plan / worker / waiting / server parts of the view model,
// the page template, and the async publish (free lock = finished inside the call; busy lock = awaited timers, soft = once).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import vmMod from 'node:vm';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openStore } from '../src/store.mjs';
import { validateBrief } from '../src/schema.mjs';
import { buildViewModel, renderPage, renderPageAsync, renderPageMaybe, pageHtml, serverInfoOf, withReports, MAX_VM_BYTES, OMITTED_CHIP } from '../src/render.mjs';

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
  const order = ['g.BriefView = ', 'g.BriefPlanView = ', 'g.BriefWorkersView = ', 'g.BriefConvo = ', 'g.BriefShell = ', 'g.BriefAlarm = ', 'g.BriefAnnotate = ', 'g.BriefPage = '].map((n) => html.indexOf(n));
  assert.ok(order.every((i) => i > 0), `all eight modules are inline: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'view.js first, page.js last');
  for (const css of ['.plan-view', '.w-row', '#alarm-band', '.sh-shell', '.cv-page', '.ann-tray']) assert.ok(html.includes(css), css);
  assert.equal((html.match(/<script>/g) ?? []).length, 9, 'eight modules + first paint');
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.equal(pageHtml(vm, null, { mode: 'file' }).includes('omo-briefing-generation'), false);
});

test('a publisher with no generation keeps a stamped page (data.js and seq still move); an older generation keeps a newer page; an unstamped page is still written', (t) => {
  const store = fresh(t);
  session(store, 'a');
  assert.equal(renderPage(store, NOW, { generation: 9, isAlive: () => true }).ok, true);
  const stamped = store.readText('index.html');
  assert.match(stamped, /<meta name="omo-briefing-generation" content="9">/);
  const seq0 = dataOf(store).seq;

  session(store, 'b');
  assert.equal(renderPage(store, NOW + 5, { generation: null, isAlive: () => true }).ok, true);
  assert.equal(store.readText('index.html'), stamped, 'null generation: index.html byte-identical');
  assert.ok(dataOf(store).seq > seq0, 'null generation: seq increased');
  assert.deepEqual(dataOf(store).sessions.map((s) => s.id).sort(), ['a', 'b'], 'null generation: data.js updated');
  const seq1 = dataOf(store).seq;

  assert.equal(renderPage(store, NOW + 10, { generation: 8, isAlive: () => true }).ok, true);
  assert.equal(store.readText('index.html'), stamped, 'gen 8 over gen 9: index.html byte-identical');
  assert.ok(dataOf(store).seq > seq1);

  store.replace('index.html', '<html>unstamped</html>');
  assert.equal(renderPage(store, NOW + 15, { generation: null, isAlive: () => true }).ok, true);
  assert.notEqual(store.readText('index.html'), '<html>unstamped</html>', 'an unstamped page is still written');
});

test('pageHtml carries the board write token as one meta in server mode only', () => {
  const vm = { schema: 1, seq: 7, gen: 4, sessions: [], waiting: [], server: null };
  const served = pageHtml(vm, 4, { mode: 'server', token: 'tok-1_x' });
  assert.equal(served.match(/<meta name="omo-board-token"/g).length, 1);
  assert.ok(served.includes('<meta name="omo-board-token" content="tok-1_x">'));
  for (const [label, html] of [
    ['server page without a token', pageHtml(vm, 4, { mode: 'server' })],
    ['server page with an empty token', pageHtml(vm, 4, { mode: 'server', token: '' })],
    ['file page', pageHtml(vm, 4, { mode: 'file', token: 'tok-1_x' })],
    ['default (file) page', pageHtml(vm, 4, { token: 'tok-1_x' })],
  ]) {
    assert.ok(!html.includes('omo-board-token') && !html.includes('tok-1_x'), `${label} has no token`);
  }
  const odd = pageHtml(vm, 4, { mode: 'server', token: '"><script>x</script>' });
  assert.ok(odd.includes('content="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"'), 'an attribute-breaking token stays inside its attribute');
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

test('board answers: answerKinds passes through (known kinds only); a board reply shows its words on the decision and the plan question', (t) => {
  const store = fresh(t);
  session(store, 'owner', { extra: { answerKinds: ['option', 'text', 'text', 'voice', 5] } });
  session(store, 'old'); // a conversation of an older generation: no answerKinds in its meta
  const open = { id: 'Q1', text: '진행할까요?', state: 'open', options: twoOptions, recommend: 'A', reason: 'r', blocks: true };
  writePlan(store, { questions: [open] });
  const id = store.allocDecisionId({ sessionId: 'owner', question: open.text, options: twoOptions, recommend: 'A', reason: 'r', blocks: true, createdAt: NOW - 8000, source: 'plan', planId: PLAN_ID, qid: 'Q1' });
  store.writeNew(`answers/${String(id).padStart(6, '0')}.json`, { id, text: '설치해 줘 <b>지금</b>', at: NOW - 100, fromSessionId: 'board' });
  const vm = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false });
  const owner = vm.sessions.find((s) => s.id === 'owner');
  assert.deepEqual(owner.answerKinds, ['option', 'text']);
  assert.deepEqual(vm.sessions.find((s) => s.id === 'old').answerKinds, []);
  const d = owner.decisions.find((x) => x.id === id);
  assert.equal(d.answered, true);
  assert.deepEqual([d.answer.option, d.answer.text], ['', '설치해 줘 <b>지금</b>']);
  const q = owner.plan.questions[0];
  assert.deepEqual([q.state, q.by, q.answer], ['answered', 'owner', '설치해 줘 <b>지금</b>']);
  assert.ok(q.option !== '', 'the state column gets a label for a reply, not an empty option');
  const page = loadPage();
  const html = page.BriefPlanView.render(owner.plan, NOW, { expanded: { ['plan:' + PLAN_ID]: true }, esc: page.BriefView.escapeHtml });
  assert.ok(html.includes('설치해 줘 &lt;b&gt;지금&lt;/b&gt;') && !html.includes('<b>지금</b>'), 'the reply is shown, escaped');
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
  const html = loadPage().BriefView.renderOverview(vm, { expanded: { [`plan:${PLAN_ID}`]: true } });
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

// ------------------------------------------------------------------ C-VM / C-BLOCK (todo 3)

// C-BLOCK grammar (plan elements plan/<anchor> are never in blockSources; plan/todo/<i> is the fallback table)
const BLOCK_ID_RE = /^(?:head|now|flow|card\/(?:plan|wk|dec|rep)|change\/\d+\/\d+|done\/\d+\/\d+|dec\/\d+|plan\/todo\/\d+|wk\/[A-Za-z0-9_-]+|rep\/[a-z0-9][a-z0-9_-]{0,63}(?:\/img\/\d+)?|note\/[^/\s]+|att\/\d+)$/;
const ABS = /^(?:[A-Za-z]:[\\/]|\/(?!\/))/;
const under = (p, root) => p.replace(/\\/g, '/').toLowerCase().startsWith(root.replace(/\\/g, '/').toLowerCase());

test('C-VM: every field for a session with a plan, evidence rows, workers and a report; blockSources follow C-BLOCK', (t) => {
  const store = fresh(t);
  const proj = join(store.root, '..', 'proj');
  nodeFs.mkdirSync(join(proj, '.omo', 'senpi-task', 'tasks'), { recursive: true });
  const rec = join(proj, '.omo', 'senpi-task', 'tasks', 'st_w1.json');
  nodeFs.writeFileSync(rec, '{}');
  const p = (n) => join(proj, n);
  const statePath = join(store.root, 'sessions', 'x', 'briefs', '000001.json');
  store.replace('sessions/a/meta.json', {
    sessionId: 'a', cwd: proj, title: 'a', lastActivityAt: NOW - 1000, hostPid: 4242, sessionFile: p('sess.jsonl'),
    auto: {
      ledgerPath: p('.omo/ledger.jsonl'),
      todoItems: { items: [{ text: '하나', status: 'completed' }, { text: '둘', status: 'in_progress' }], more: 0 },
      live: { workers: [{ id: 'st_w1', name: 'w' }, { id: 'st_nofile', name: 'n' }, { id: '../evil', name: 'e' }] },
    },
  });
  for (const seq of [1, 3]) {
    store.writeNew(`sessions/a/briefs/${String(seq).padStart(6, '0')}.json`, { at: NOW - 2000 + seq, brief: {
      title: 'a', status: 'in_progress', headline: 'h', next: '', decisions: [],
      changes: [
        { text: 'c0', truth: 'reported', applied: 'none', evidence: p('ev1.txt') },
        { text: 'c1', truth: 'reported', applied: 'none', evidence: 'relative/x.txt' },
        { text: 'c2', truth: 'reported', applied: 'none', evidence: statePath },
      ],
      done: [{ text: 'd0', truth: 'reported', applied: 'none', evidence: p('ev1.txt') }, { text: 'd1', truth: 'reported', applied: 'none', evidence: p('ev2.txt') }],
    } });
  }
  const planId = 'p0123456789ab';
  store.writePlanRev(planId, {
    schema: 'omo-plan/1', planId, at: NOW - 9000, ownerSessionId: 'a', source: { root: proj, slug: 'demo', planPath: p('.omo/plans/demo.md') },
    plan: { stage: 'review', goal: 'g', ideal: [], components: [], waves: [{ n: 1, label: 'w' }], tasks: [{ id: '1', wave: 1, label: 'l', what: 'w', done: 'd', deps: [] }], questions: [], outOfScope: [] },
  });
  const H = 'a'.repeat(64);
  store.replace('sessions/a/reports.json', [{ id: 'r1', title: 't', summary: '', decisionId: null, at: NOW - 500, images: [
    { sha: H, ext: 'png', alt: 'x', w: 1, h: 1, path: p('shot.png') }, { sha: H, ext: 'png', alt: 'y', w: 1, h: 1, path: p('shot2.png') },
  ] }]);

  const s = buildViewModel(withReports(store, store.readSnapshot()), NOW, { isAlive: (pid) => pid === 4242, stateDir: store.root }).sessions[0];
  assert.equal(s.alive, true);
  assert.equal(s.briefSeq, 3);
  assert.equal(s.briefPath, join(store.root, 'sessions', 'a', 'briefs', '000003.json'));
  assert.equal(s.sessionFile, p('sess.jsonl'));
  assert.deepEqual(s.todo, { items: [{ text: '하나', status: 'completed' }, { text: '둘', status: 'in_progress' }], more: 0 });
  assert.equal(s.plan.planId, planId);
  assert.equal(s.live.workers.length, 3);
  assert.equal(s.reports.length, 1);
  assert.deepEqual(s.attachments, [
    { label: '대화 id', path: 'a' },
    { label: '세션 파일', path: p('sess.jsonl') },
    { label: '계획 파일', path: p('.omo/plans/demo.md') },
    { label: '증거', path: p('ev1.txt') },
    { label: '증거', path: p('ev2.txt') },
    { label: '보고서 그림', path: p('shot.png') },
    { label: '보고서 그림', path: p('shot2.png') },
    { label: '실행 기록', path: p('.omo/ledger.jsonl') },
  ]);
  const att = Object.fromEntries(s.attachments.slice(1).map((a, i) => [`att/${i + 1}`, { paths: [a.path] }]));
  assert.deepEqual(s.blockSources, {
    head: { paths: [p('sess.jsonl')] },
    'change/3/0': { paths: [p('ev1.txt')] },
    'done/3/0': { paths: [p('ev1.txt')] },
    'done/3/1': { paths: [p('ev2.txt')] },
    'wk/st_w1': { paths: [rec] },
    'rep/r1': { paths: [p('shot.png'), p('shot2.png')] },
    'rep/r1/img/0': { paths: [p('shot.png')] },
    'rep/r1/img/1': { paths: [p('shot2.png')] },
    ...att,
  });
  for (const [k, v] of Object.entries(s.blockSources)) {
    assert.match(k, BLOCK_ID_RE);
    assert.ok(!k.startsWith('plan/') || k.startsWith('plan/todo/'), `plan element ${k} must not be in blockSources`);
    assert.equal(new Set(v.paths).size, v.paths.length, `${k} deduplicated`);
    for (const path of v.paths) {
      assert.match(path, ABS, `${k}: absolute`);
      assert.ok(!under(path, store.root), `${k}: no STATE path (${path})`);
    }
  }
  assert.ok(s.attachments.every((a) => a.label === '대화 id' || (ABS.test(a.path) && !under(a.path, store.root))));
});

test('C-VM: a 45-item todo gives 40 items and more:5; the fallback plan table rows point at the boulder', (t) => {
  const store = fresh(t);
  const items = Array.from({ length: 45 }, (_, i) => ({ text: `일 ${i}`, status: 'pending' }));
  session(store, 'a', { auto: { work: { name: 'w' }, todoItems: { items, more: 0 } } });
  const s = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false }).sessions[0];
  assert.equal(s.todo.items.length, 40);
  assert.equal(s.todo.more, 5);
  assert.deepEqual(s.todo.items[39], { text: '일 39', status: 'pending' });
  assert.deepEqual(s.blockSources['plan/todo/0'], { paths: ['C:/p/a/.omo/boulder.json'] });
  assert.equal(Object.keys(s.blockSources).filter((k) => k.startsWith('plan/todo/')).length, 40);
  // no collected todo: an empty list, never a throw; a corrupt entry list is ignored item by item
  session(store, 'b', { auto: { todoItems: { items: [null, 7, { text: 'ok', status: 3 }], more: -2 } } });
  const b = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false }).sessions.find((x) => x.id === 'b');
  assert.deepEqual(b.todo, { items: [{ text: 'ok', status: '' }], more: 0 });
});

test('C-VM alive: live hostPid while idle = true, dead hostPid = false, no hostPid falls back to the running check', (t) => {
  const store = fresh(t);
  session(store, 'idle-live', { extra: { hostPid: 101 } });
  session(store, 'idle-dead', { extra: { hostPid: 102 } });
  session(store, 'old-running', { extra: { running: true, pid: 103 } });
  session(store, 'old-dead-run', { extra: { running: true, pid: 104 } });
  session(store, 'old-idle', { extra: { pid: 103 } }); // pid without running is not 'open'
  session(store, 'bad-type', { extra: { hostPid: '101' } });
  const probed = [];
  const isAlive = (pid) => { probed.push(pid); return pid === 101 || pid === 103; };
  const by = Object.fromEntries(buildViewModel(store.readSnapshot(), NOW, { isAlive }).sessions.map((s) => [s.id, s.alive]));
  assert.deepEqual(by, { 'idle-live': true, 'idle-dead': false, 'old-running': true, 'old-dead-run': false, 'old-idle': false, 'bad-type': false });
  assert.ok(!probed.includes('101'), 'a hostPid of the wrong type is never probed');
});

test('C-VM cap: blockSources of finished conversations go first, before live details, and the 600KB cap holds', (t) => {
  const store = fresh(t);
  const ev = (s, i) => `C:/proj/${'e'.repeat(580)}/${s}-${i}.txt`;
  for (let n = 0; n < 30; n++) {
    const sid = `s${String(n).padStart(2, '0')}`;
    const finished = n % 2 === 0;
    store.replace(`sessions/${sid}/meta.json`, { sessionId: sid, cwd: 'C:/proj', title: sid, lastActivityAt: NOW - (n + 1) * 1000, auto: { live: { workers: [{ id: `st_${n}`, name: 'w' }] } } });
    store.writeNew(`sessions/${sid}/briefs/000001.json`, { at: NOW - (n + 1) * 1000, brief: {
      title: sid, status: finished ? 'done' : 'in_progress', headline: 'h', next: '', decisions: [], done: [],
      changes: Array.from({ length: 10 }, (_, i) => ({ text: 'c', truth: 'reported', applied: 'none', evidence: ev(sid, i) })),
    } });
  }
  const opts = { isAlive: () => false, stateDir: store.root };
  const vm = buildViewModel(store.readSnapshot(), NOW, opts);
  assert.ok(Buffer.byteLength(JSON.stringify(vm)) <= MAX_VM_BYTES, 'model over the cap');
  const done = vm.sessions.filter((s) => s.tab === '끝남');
  const active = vm.sessions.filter((s) => s.tab !== '끝남');
  const dropped = done.filter((s) => Object.keys(s.blockSources).length === 0);
  assert.ok(dropped.length > 0, 'some finished blockSources were dropped');
  assert.ok(active.every((s) => Object.keys(s.blockSources).length === 20), 'active conversations keep their block sources');
  assert.ok(vm.sessions.every((s) => s.live !== undefined && !s.chips.includes(OMITTED_CHIP)), 'nothing else was dropped');
  const keptDone = done.filter((s) => Object.keys(s.blockSources).length > 0);
  for (const k of keptDone) for (const d of dropped) assert.ok(d.lastActivityAt <= k.lastActivityAt, 'oldest finished first');
  assert.ok(vm.sessions.every((s) => s.attachments.length === 11), 'attachments are never dropped');
  // the uncapped model really is over the cap: a dropped set is as big as an active one
  const one = Buffer.byteLength(JSON.stringify(active[0].blockSources));
  assert.ok(Buffer.byteLength(JSON.stringify(vm)) + dropped.length * one > MAX_VM_BYTES, 'the uncapped model fits: the test proves nothing');
  const res = renderPage(store, NOW, { isAlive: () => false });
  assert.equal(res.ok, true);
  assert.ok(Buffer.byteLength(store.readText('data.js')) <= MAX_VM_BYTES, 'published data.js over the cap');
});

test('C-VM: an unreadable meta.json is a readError of that session, never a throw', (t) => {
  const store = fresh(t);
  session(store, 'ok');
  session(store, 'bad');
  nodeFs.writeFileSync(join(store.root, 'sessions', 'bad', 'meta.json'), '{broken');
  const vm = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false, stateDir: store.root });
  assert.ok(vm.readErrors.includes('sessions/bad/meta.json'));
  const bad = vm.sessions.find((s) => s.id === 'bad');
  assert.ok(bad && bad.chips.includes('기록 읽기 실패'));
  assert.deepEqual([bad.alive, bad.sessionFile, bad.todo, bad.attachments], [false, null, { items: [], more: 0 }, [{ label: '대화 id', path: 'bad' }]]);
});

// ---- todo 3 attempt 2 regressions (verifier B1-B3)

test('C-VM cap B1: native todo items are trimmed under the cap and counted once in vm.trimmed (C-CAP2: no per-card chip)', (t) => {
  const store = fresh(t);
  const items = (n) => Array.from({ length: 40 }, (_, i) => ({ text: `${n}-${i} `.padEnd(207, '가'), status: 'pending' }));
  for (let n = 0; n < 30; n++) session(store, `s${String(n).padStart(2, '0')}`, { at: NOW - (n + 1) * 1000, status: n % 2 ? 'done' : 'in_progress', auto: { todoItems: { items: items(n), more: 3 } } });
  const vm = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false, stateDir: store.root });
  assert.ok(Buffer.byteLength(JSON.stringify(vm)) <= MAX_VM_BYTES, `model is ${Buffer.byteLength(JSON.stringify(vm))} bytes`);
  const cut = vm.sessions.filter((s) => s.todo.items.length === 0);
  assert.ok(cut.length > 0 && cut.length < 30, 'some, not all, todo lists dropped');
  for (const s of cut) {
    assert.equal(s.todo.more, 43, 'dropped items are counted in more');
    assert.ok(!s.chips.includes(OMITTED_CHIP), 'C-CAP2 passes 3-7 add no per-card chip');
    assert.ok(!Object.keys(s.blockSources).some((k) => k.startsWith('plan/todo/')), 'their fallback rows lose their sources');
  }
  assert.deepEqual(vm.trimmed, { cards: cut.length }, 'one top-level counter of the affected cards');
  const kept = vm.sessions.filter((s) => s.todo.items.length > 0);
  for (const k of kept) assert.equal(k.todo.items.length, 40);
  const done = (s) => s.tab === '끝남';
  if (cut.some((s) => !done(s))) assert.ok(kept.every((s) => !done(s)), 'finished cards are trimmed first');
  const res = renderPage(store, NOW, { isAlive: () => false });
  assert.equal(res.ok, true);
  assert.ok(Buffer.byteLength(store.readText('data.js')) <= MAX_VM_BYTES, 'published data.js over the cap');
});

test('C-VM cap B1: distinct report image paths still fit after the reports are dropped', (t) => {
  const store = fresh(t);
  const H = 'b'.repeat(64);
  // 540 distinct paths of <= 1024 code points (the report limit), 3 UTF-8 bytes each: the attachments alone exceed the cap
  for (let n = 0; n < 30; n++) {
    const sid = `s${String(n).padStart(2, '0')}`;
    session(store, sid, { at: NOW - (n + 1) * 1000 });
    store.replace(`sessions/${sid}/reports.json`, Array.from({ length: 3 }, (_, r) => ({ id: `r${r}`, title: 't', summary: '', decisionId: null, at: NOW,
      images: Array.from({ length: 6 }, (_, i) => ({ sha: H, ext: 'png', alt: 'a', w: 1, h: 1, path: `C:/shots/${'가'.repeat(950)}/${sid}-${r}-${i}.png` })) })));
  }
  const vm = buildViewModel(withReports(store, store.readSnapshot()), NOW, { isAlive: () => false, stateDir: store.root });
  assert.ok(Buffer.byteLength(JSON.stringify(vm)) <= MAX_VM_BYTES, `model is ${Buffer.byteLength(JSON.stringify(vm))} bytes`);
  const trimmed = vm.sessions.filter((s) => s.attachments.length === 1);
  assert.ok(trimmed.length > 0, 'some attachment lists were dropped');
  for (const s of trimmed) {
    assert.deepEqual(s.attachments, [{ label: '대화 id', path: s.id }], 'the conversation id row stays');
    assert.ok(s.chips.includes(OMITTED_CHIP) && s.reports.length === 0, 'attachments go only after the reports (whose drop keeps its chip)');
  }
  assert.ok(vm.trimmed && vm.trimmed.cards >= trimmed.length, 'the trimmed cards are counted');
  for (const s of vm.sessions) for (const a of s.attachments.slice(1)) assert.ok(a.path.length > 950, 'kept paths are whole');
  const res = renderPage(store, NOW, { isAlive: () => false });
  assert.equal(res.ok, true);
  assert.ok(Buffer.byteLength(store.readText('data.js')) <= MAX_VM_BYTES, 'published data.js over the cap');
});

test('C-BLOCK B2: a dot-segment alias or a junction into STATE is excluded; the original value stays data', (t) => {
  const store = fresh(t);
  const base = join(store.root, '..');
  const proj = join(base, 'proj');
  nodeFs.mkdirSync(join(store.root, 'answers'), { recursive: true });
  nodeFs.writeFileSync(join(store.root, 'answers', '000001.json'), '{}');
  nodeFs.mkdirSync(proj, { recursive: true });
  nodeFs.symlinkSync(store.root, join(proj, 'st'), 'junction');
  const alias = `${proj.replace(/\\/g, '/')}/../state/answers/000001.json`;
  const upper = `${proj}\\..\\STATE\\answers\\000001.json`;
  const viaLink = join(proj, 'st', 'answers', '000001.json');
  const ok = join(proj, 'ok.txt');
  const changes = [alias, upper, viaLink, ok, `${proj}/./ok.txt`].map((evidence, i) => ({ text: `c${i}`, truth: 'reported', applied: 'none', evidence }));
  assert.equal(validateBrief({ title: 'a', status: 'in_progress', headline: 'h', changes, done: [], next: '', decisions: [] }).ok, true, 'the alias is valid brief input');
  store.replace('sessions/a/meta.json', { sessionId: 'a', cwd: proj, title: 'a', lastActivityAt: NOW });
  store.writeNew('sessions/a/briefs/000001.json', { at: NOW, brief: { title: 'a', status: 'in_progress', headline: 'h', changes, done: [], next: '', decisions: [] } });
  const s = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false, stateDir: store.root }).sessions[0];
  assert.equal(s.changes[0].evidence, alias, 'the row keeps its value as data');
  assert.deepEqual(s.attachments, [{ label: '대화 id', path: 'a' }, { label: '증거', path: ok }], 'aliases excluded, ./ duplicate merged');
  assert.deepEqual(Object.keys(s.blockSources).sort(), ['att/1', 'change/1/3', 'change/1/4']);
  assert.deepEqual(s.blockSources['change/1/4'], { paths: [`${proj}/./ok.txt`] }, 'kept whole, as written');
});

test('C-BLOCK B3: an accepted 4218-character evidence path is kept whole in attachments and blockSources', (t) => {
  const store = fresh(t);
  const long = `C:/${Array.from({ length: 22 }, (_, i) => String(i).padEnd(190, 'd')).join('/')}/evidence1.txt`;
  assert.equal(long.length, 4218);
  const changes = [{ text: 'long', truth: 'reported', applied: 'none', evidence: long }];
  assert.equal(validateBrief({ title: 'l', status: 'in_progress', headline: 'h', changes, done: [], next: '', decisions: [] }).ok, true);
  store.replace('sessions/long/meta.json', { sessionId: 'long', cwd: 'C:/p', title: 'l', lastActivityAt: NOW });
  store.writeNew('sessions/long/briefs/000001.json', { at: NOW, brief: { title: 'l', status: 'in_progress', headline: 'h', changes, done: [], next: '', decisions: [] } });
  const s = buildViewModel(store.readSnapshot(), NOW, { isAlive: () => false, stateDir: store.root }).sessions[0];
  assert.deepEqual(s.attachments, [{ label: '대화 id', path: 'long' }, { label: '증거', path: long }]);
  assert.deepEqual(s.blockSources['change/1/0'], { paths: [long] });
});

test('C-VM cap property: every todo-3 field at its maximum across many sessions stays under the cap (model and data.js)', (t) => {
  const store = fresh(t);
  const H = 'c'.repeat(64);
  const big = (n, tag) => `C:/${tag}/${'가'.repeat(n)}`; // 3 UTF-8 bytes per code point
  const N = 60;
  for (let n = 0; n < N; n++) {
    const sid = `s${String(n).padStart(3, '0')}-${'i'.repeat(100)}`; // long ids make briefPath long too
    const at = NOW - (n + 1) * 1000;
    const changes = Array.from({ length: 10 }, (_, i) => ({ text: 'c', truth: 'reported', applied: 'none', evidence: big(60, `ev/${sid}/${i}`) })); // the rows themselves predate todo 3: kept small
    store.replace(`sessions/${sid}/meta.json`, {
      sessionId: sid, cwd: 'C:/p', title: sid, lastActivityAt: at, hostPid: 1, sessionFile: big(4000, `sf/${sid}`),
      auto: { work: { name: 'w' }, ledgerPath: big(1000, `led/${sid}`),
        todoItems: { items: Array.from({ length: 40 }, (_, i) => ({ text: `${i}`.padEnd(300, '나'), status: 'pending' })), more: 9 } },
    });
    for (const seq of [1, 2]) store.writeNew(`sessions/${sid}/briefs/${String(seq).padStart(6, '0')}.json`, { at, brief: { title: sid, status: n % 3 ? 'in_progress' : 'done', headline: 'h', next: '', decisions: [], changes, done: [] } });
    store.replace(`sessions/${sid}/reports.json`, Array.from({ length: 3 }, (_, r) => ({ id: `r${r}`, title: 't', summary: '', decisionId: null, at,
      images: Array.from({ length: 6 }, (_, i) => ({ sha: H, ext: 'png', alt: 'a', w: 1, h: 1, path: big(1000, `img/${sid}/${r}/${i}`) })) })));
  }
  const vm = buildViewModel(withReports(store, store.readSnapshot()), NOW, { isAlive: () => true, stateDir: store.root });
  const bytes = Buffer.byteLength(JSON.stringify(vm));
  assert.ok(bytes <= MAX_VM_BYTES, `model is ${bytes} bytes`);
  for (const s of vm.sessions) {
    // a todo-3 field is either whole or its key is gone (C-CAP2 pass 6/7)
    assert.ok(!('sessionFile' in s) || s.sessionFile.length === 4000 + `C:/sf/${s.id}/`.length, 'sessionFile never shortened');
    if ('alive' in s) assert.equal(typeof s.alive, 'boolean');
    if ('briefSeq' in s) assert.ok(Number.isInteger(s.briefSeq));
  }
  assert.ok(vm.sessions.some((s) => !('sessionFile' in s)), 'the final pass really ran');
  assert.ok(vm.sessions.some((s) => 'sessionFile' in s), 'not everything was cleared');
  const touched = vm.sessions.filter((s) => !('todo' in s) || s.todo.items.length === 0);
  assert.deepEqual(vm.trimmed, { cards: touched.length }, 'every card touched by passes 3-7 counted once');
  const res = renderPage(store, NOW, { isAlive: () => true });
  assert.equal(res.ok, true);
  const dataBytes = Buffer.byteLength(store.readText('data.js'));
  assert.ok(dataBytes <= MAX_VM_BYTES, `published data.js is ${dataBytes} bytes`);
});

// ------------------------------------------------------------------ C-CAP2 (follow-up todo 14)
// Oracle = the ACTUAL accepted renderer (tree ORACLE_TREE) extracted from git into a temp dir and run on the same inputs,
// clock, liveness and final published seq. Sizes are the measured data.js / JSON bytes.

const ORACLE_TREE = 'ab7ba4f2b4b75fc5b4f58bd4a3349cd1a45240a4';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CVM_KEYS = ['alive', 'briefSeq', 'briefPath', 'sessionFile', 'todo', 'attachments', 'blockSources'];
const oracleDirs = [];
const oracleMods = new Map();
after(() => { for (const dir of oracleDirs) rmSync(dir, { recursive: true, force: true }); });
async function oracle(tree = ORACLE_TREE) {
  if (oracleMods.has(tree)) return oracleMods.get(tree);
  const oracleDir = mkdtempSync(join(tmpdir(), 'omo-oracle-'));
  oracleDirs.push(oracleDir);
  const git = (...args) => {
    const r = spawnSync('git', ['-C', REPO, ...args], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  const files = git('ls-tree', '-r', '--name-only', tree, 'src').toString('utf8').split('\n').filter(Boolean);
  for (const f of files) {
    nodeFs.mkdirSync(join(oracleDir, dirname(f)), { recursive: true });
    nodeFs.writeFileSync(join(oracleDir, f), git('cat-file', 'blob', `${tree}:${f}`));
  }
  const url = (n) => pathToFileURL(join(oracleDir, 'src', n)).href;
  const [render, store] = await Promise.all([import(url('render.mjs')), import(url('store.mjs'))]);
  const mods = { render, store };
  oracleMods.set(tree, mods);
  return mods;
}

const sidOf = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
// The verifier's minimal-session family, written straight to disk (fast); finishedEvery>0 makes every k-th one finished.
function writeMinimal(root, n, { finishedEvery = 0, headline = () => 'h', meta = () => ({}) } = {}) {
  for (let i = 0; i < n; i++) {
    const sid = sidOf(i);
    const d = join(root, 'sessions', sid);
    nodeFs.mkdirSync(join(d, 'briefs'), { recursive: true });
    const at = NOW - (i + 1) * 1000;
    nodeFs.writeFileSync(join(d, 'meta.json'), JSON.stringify({ sessionId: sid, cwd: 'C:/p', title: 's', lastActivityAt: at, ...meta(i) }));
    nodeFs.writeFileSync(join(d, 'briefs', '000001.json'), JSON.stringify({ at, brief: {
      title: 's', status: finishedEvery && i % finishedEvery === 0 ? 'done' : 'in_progress', headline: headline(i), changes: [], done: [], next: '', decisions: [],
    } }));
  }
}
const tmp = (t, p) => { const d = mkdtempSync(join(tmpdir(), p)); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const readData = (root) => {
  const text = readFileSync(join(root, 'data.js'), 'utf8');
  const vm = JSON.parse(text.slice(text.lastIndexOf('window.__briefData(') + 'window.__briefData('.length, text.lastIndexOf(');')));
  return { vm, dataBytes: Buffer.byteLength(text), jsonBytes: Buffer.byteLength(JSON.stringify(vm)) };
};
// Publish the same template with both renderers (fresh copies, so both get seq 1).
async function publishBoth(t, template) {
  const O = await oracle();
  const a = tmp(t, 'omo-cap2-o-'), b = tmp(t, 'omo-cap2-n-');
  nodeFs.cpSync(template, a, { recursive: true });
  nodeFs.cpSync(template, b, { recursive: true });
  const ro = O.render.renderPage(O.store.openStore(a), NOW, { isAlive: () => false, sleep: () => {} });
  const rn = renderPage(openStore(b), NOW, { isAlive: () => false, sleep: () => {} });
  assert.equal(ro.ok, true, 'oracle published');
  assert.equal(rn.ok, true, 'new renderer published');
  const o = readData(a), n = readData(b);
  assert.equal(o.vm.seq, n.vm.seq, 'same final seq');
  return { o, n, newRoot: b };
}
const strip = (vm) => {
  const c = structuredClone(vm);
  delete c.trimmed;
  for (const s of c.sessions) {
    for (const k of CVM_KEYS) delete s[k];
    for (const d of s.decisions) if (d.held === false) delete d.held; // todo 12: the old always-present held:false is now omitted
  }
  return c;
};
const fits = (x) => x.dataBytes <= MAX_VM_BYTES && x.jsonBytes <= MAX_VM_BYTES;
const affectedMinimal = (vm) => vm.sessions.filter((s) => CVM_KEYS.some((k) => !(k in s)));
// per pass order: finished first, then oldest first
function assertTrimOrder(vm, affected) {
  const hit = new Set(affected.map((s) => s.id));
  const done = (s) => s.tab === '끝남';
  if (vm.sessions.some((s) => hit.has(s.id) && !done(s))) assert.ok(vm.sessions.filter(done).every((s) => hit.has(s.id)), 'a live card was trimmed while a finished one was not');
  for (const a of affected) for (const k of vm.sessions) {
    if (!hit.has(k.id) && done(a) === done(k)) assert.ok(a.lastActivityAt <= k.lastActivityAt, 'a newer card was trimmed before an older one');
  }
}
function assertKeptWhole(vm, root) {
  for (const s of vm.sessions.filter((x) => CVM_KEYS.every((k) => k in x))) {
    assert.equal(s.briefPath, join(root, 'sessions', s.id, 'briefs', '000001.json'), 'kept briefPath whole');
    assert.equal(typeof s.alive, 'boolean');
    assert.equal(s.briefSeq, 1);
  }
}
// The oracle's data.js bytes grow by a fixed amount per minimal in-progress session: find the largest N that fits.
async function boundaryN(t) {
  const sizes = [];
  for (const n of [1, 2]) {
    const tpl = tmp(t, 'omo-cap2-tpl-');
    writeMinimal(tpl, n);
    sizes.push((await publishBoth(t, tpl)).o.dataBytes);
  }
  const per = sizes[1] - sizes[0];
  return Math.floor((MAX_VM_BYTES - (sizes[0] - per)) / per);
}

for (const N of [300, 1200, 1448]) {
  test(`C-CAP2 cardinality N=${N}: whenever the accepted renderer fits, the new model and data.js fit; trimmed counts affected cards`, async (t) => {
    const tpl = tmp(t, 'omo-cap2-tpl-');
    writeMinimal(tpl, N, { finishedEvery: 3 });
    const { o, n, newRoot } = await publishBoth(t, tpl);
    assert.ok(fits(o), `oracle fits (${o.dataBytes})`);
    assert.ok(fits(n), `new output fits (data.js ${n.dataBytes}, json ${n.jsonBytes})`);
    const hit = affectedMinimal(n.vm);
    if (hit.length === 0) assert.equal('trimmed' in n.vm, false, 'nothing trimmed: no counter');
    else assert.deepEqual(n.vm.trimmed, { cards: hit.length });
    assertTrimOrder(n.vm, hit);
    assertKeptWhole(n.vm, newRoot);
    assert.deepEqual(strip(n.vm), strip(o.vm), 'apart from the todo-3 keys the model is the accepted one');
    if (N === 300) assert.equal(hit.length, 0, '300 minimal cards fit with every field');
    if (N === 1200) assert.ok(hit.length > 0, '1200 cards need trimming');
  });
}

test('C-CAP2 exact boundary: the largest fitting N fits; at N+1 the new output is never larger than the accepted one', async (t) => {
  const N = await boundaryN(t);
  for (const [count, oracleFits] of [[N, true], [N + 1, false]]) {
    const tpl = tmp(t, 'omo-cap2-tpl-');
    writeMinimal(tpl, count);
    const { o, n, newRoot } = await publishBoth(t, tpl);
    assert.equal(fits(o), oracleFits, `oracle at ${count}: ${o.dataBytes} bytes`);
    if (oracleFits) assert.ok(fits(n), `new output at boundary N=${count}: ${n.dataBytes} bytes`);
    else assert.ok(n.dataBytes <= o.dataBytes, `N+1: new ${n.dataBytes} > accepted ${o.dataBytes}`);
    const hit = affectedMinimal(n.vm);
    if ('trimmed' in n.vm) assert.deepEqual(n.vm.trimmed, { cards: hit.length });
    assertTrimOrder(n.vm, hit);
    assertKeptWhole(n.vm, newRoot);
    assert.deepEqual(strip(n.vm), strip(o.vm));
  }
});

// cost of a string inside data.js (JSON + script escaping), without its quotes
const escapedCost = (s) => Buffer.byteLength(JSON.stringify(s).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')) - 2;
test('C-CAP2 exact bytes: an accepted data.js of exactly 614400 B with escaped text, and a counter-only overflow, both fit with no counter', async (t) => {
  const N = await boundaryN(t);
  const probe = tmp(t, 'omo-cap2-tpl-');
  writeMinimal(probe, N);
  const slack = MAX_VM_BYTES - (await publishBoth(t, probe)).o.dataBytes;
  const tb = Buffer.byteLength(`,"trimmed":{"cards":${N}}`);
  const ESC = '"\\</script>가\u2028\u2029';
  for (const room of [0, tb - 1]) { // 0: exactly at the cap; tb-1: the counter alone would overflow by one byte
    const want = slack - room; // extra escaped bytes in one headline
    const base = escapedCost(ESC) <= want ? ESC : '';
    const pad = base + 'a'.repeat(want - escapedCost(base));
    const tpl = tmp(t, 'omo-cap2-tpl-');
    writeMinimal(tpl, N, { headline: (i) => (i === 0 ? `h${pad}` : 'h') });
    const { o, n } = await publishBoth(t, tpl);
    assert.equal(o.dataBytes, MAX_VM_BYTES - room, 'oracle size is the intended exact value');
    assert.ok(fits(o));
    assert.ok(fits(n), `room ${room}: new data.js ${n.dataBytes}`);
    assert.equal('trimmed' in n.vm, false, 'the counter is omitted when its own bytes would overflow');
    assert.ok(o.dataBytes + tb > MAX_VM_BYTES, 'the counter really would not fit');
    assert.deepEqual(n.vm, o.vm, 'every todo-3 key was removed and nothing else changed');
    assert.ok(n.vm.sessions.some((s) => s.headline.includes('</script>')) || base === '', 'escaped text present');
  }
});

test('C-CAP2 intermediate pass: trimming native todo items suffices; the counter counts those cards and their keys remain', async (t) => {
  const tpl = tmp(t, 'omo-cap2-tpl-');
  const items = Array.from({ length: 40 }, (_, i) => ({ text: `${i} `.padEnd(300, '가'), status: 'pending' }));
  writeMinimal(tpl, 30, { finishedEvery: 2, meta: () => ({ auto: { todoItems: { items, more: 0 } } }) });
  const { o, n } = await publishBoth(t, tpl);
  assert.ok(fits(o) && fits(n), `new ${n.dataBytes}`);
  const cut = n.vm.sessions.filter((s) => s.todo.items.length === 0);
  assert.ok(cut.length > 0 && cut.length < 30, `cut ${cut.length}`);
  assert.deepEqual(n.vm.trimmed, { cards: cut.length });
  for (const s of n.vm.sessions) {
    assert.ok(CVM_KEYS.every((k) => k in s), 'no key deleted in an intermediate pass');
    assert.ok(!s.chips.includes(OMITTED_CHIP), 'passes 3-7 add no per-card chip');
  }
  for (const s of cut) assert.equal(s.todo.more, 40);
  assertTrimOrder(n.vm, cut);
  assert.deepEqual(strip(n.vm), strip(o.vm));
});

test('C-CAP2 no trimming: every C-VM field on every card, no counter, and the rest equals the accepted model', async (t) => {
  const O = await oracle();
  const store = fresh(t);
  const proj = join(store.root, '..', 'proj');
  const H = 'd'.repeat(64);
  for (const [i, sid] of ['a', 'b', 'c'].entries()) {
    store.replace(`sessions/${sid}/meta.json`, { sessionId: sid, cwd: proj, title: `t "\\</script>가\u2028`, lastActivityAt: NOW - (i + 1) * 1000, hostPid: 7, sessionFile: join(proj, `${sid}.jsonl`),
      auto: { todoItems: { items: [{ text: 'x', status: 'pending' }], more: 0 }, live: { workers: [{ id: 'st_1', name: 'w' }] } } });
    store.writeNew(`sessions/${sid}/briefs/000001.json`, { at: NOW - (i + 1) * 1000, brief: { title: sid, status: i === 2 ? 'done' : 'in_progress', headline: '<b>"h"</b>', next: '', decisions: [],
      changes: [{ text: 'c', truth: 'reported', applied: 'none', evidence: join(proj, 'ev.txt') }], done: [] } });
    store.replace(`sessions/${sid}/reports.json`, [{ id: 'r', title: 't', summary: '', decisionId: null, at: NOW, images: [{ sha: H, ext: 'png', alt: 'a', w: 1, h: 1, path: join(proj, 'i.png') }] }]);
  }
  const opts = { isAlive: (p) => p === 7, stateDir: store.root };
  const nv = buildViewModel(withReports(store, store.readSnapshot()), NOW, opts);
  const ov = O.render.buildViewModel(O.render.withReports(store, store.readSnapshot()), NOW, opts);
  assert.equal('trimmed' in nv, false);
  for (const s of nv.sessions) {
    for (const k of CVM_KEYS) assert.ok(k in s, `${s.id} keeps ${k}`);
    assert.equal(s.alive, true);
    assert.ok(s.attachments.length > 1 && Object.keys(s.blockSources).length > 0 && s.todo.items.length === 1);
  }
  assert.deepEqual(strip(nv), ov);
});

test('C-CAP2 verifier repro: 30 sessions with 8999-code-point session files fit; cleared cards lose the keys, not shorten them', () => {
  const sessions = Array.from({ length: 30 }, (_, i) => ({ sid: `sf${i}`, meta: { sessionId: `sf${i}`, cwd: 'C:/project', lastActivityAt: NOW,
    sessionFile: `C:/sessions/${Array.from({ length: 47 }, () => '가'.repeat(190)).join('/')}/sf${i}.jsonl` },
    briefs: [{ seq: 1, data: { at: NOW, brief: { title: `sf${i}`, status: i % 2 ? 'done' : 'in_progress', headline: 'h', changes: [], done: [], next: '', decisions: [] } } }] }));
  const vm = buildViewModel({ sessions }, NOW, { stateDir: 'C:/board/state', isAlive: () => false });
  assert.ok(Buffer.byteLength(JSON.stringify(vm)) <= MAX_VM_BYTES);
  const cleared = vm.sessions.filter((s) => !('sessionFile' in s));
  assert.ok(cleared.length > 0 && cleared.length < 30);
  assert.ok(vm.sessions.every((s) => !('sessionFile' in s) || s.sessionFile.endsWith(`/${s.id}.jsonl`)));
  assert.ok(vm.sessions.every((s) => !s.chips.includes(OMITTED_CHIP)));
  // pass 5 already reduced every card's attachments (id + session file -> id) before pass 6 removed keys from some
  const touched = vm.sessions.filter((s) => !('attachments' in s) || s.attachments.length === 1);
  assert.deepEqual(vm.trimmed, { cards: touched.length });
  assert.ok(touched.length >= cleared.length);
});

// ---- todo 14 attempt 2: a legacy drop (live/plan, reports) must never grow a card (verifier CAP2-1-legacy-chip-growth)
const scriptLen = (v) => Buffer.byteLength(JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
const memSize = (vm) => ({ data: Buffer.byteLength(`/* seq:${vm.seq} */\nwindow.__briefData && window.__briefData(`) + scriptLen(vm) + Buffer.byteLength(');\n'), json: Buffer.byteLength(JSON.stringify(vm)) });
const memFits = (s) => s.data <= MAX_VM_BYTES && s.json <= MAX_VM_BYTES;
function memSnap(n, c) {
  return {
    plans: c.plans ? c.plans(n) : [],
    sessions: Array.from({ length: n }, (_, i) => {
      const sid = sidOf(i);
      const at = NOW - (i + 1) * 1000;
      return { sid, meta: { sessionId: sid, cwd: 'C:/p', title: 's', lastActivityAt: at, ...(c.meta ? c.meta(i) : {}) }, ...(c.reports ? { reports: c.reports(i) } : {}),
        briefs: [{ seq: 1, data: { at, brief: { title: 's', status: c.status ? c.status(i) : 'in_progress', headline: 'h', changes: [], done: [], next: '', decisions: [] } } }] };
    }),
  };
}
const TINY_LIVE = { auto: { live: { workers: [{}] } } };
const MIN_REPORT = [{ id: 'r', title: '', summary: '', decisionId: null, at: null, images: [] }];
const LEGACY_CASES = {
  tinyLive: { meta: () => TINY_LIVE },
  tinyLiveMixed: { meta: () => TINY_LIVE, status: (i) => (i % 2 ? 'done' : 'in_progress') },
  minimalReport: { reports: () => MIN_REPORT },
  tinyLiveAndReport: { meta: () => TINY_LIVE, reports: () => MIN_REPORT, status: (i) => (i % 3 ? 'in_progress' : 'done') },
  skeletonPlan: {
    meta: (i) => ({ planFiles: { [`p${String(i).padStart(12, '0')}`]: {} } }),
    plans: (n) => Array.from({ length: n }, (_, i) => ({ planId: `p${String(i).padStart(12, '0')}`, status: { at: null, skeleton: { tasks: [{ id: '1' }] } } })),
  },
};
for (const [name, c] of Object.entries(LEGACY_CASES)) {
  test(`C-CAP2 legacy drops never grow a card: ${name} at the oracle boundary fits whenever the accepted renderer fits`, async () => {
    const O = await oracle();
    const opts = { isAlive: () => false, stateDir: 'C:/board/state' };
    const o = (n) => O.render.buildViewModel(memSnap(n, c), NOW, opts);
    const chipless = (vm) => vm.sessions.every((s) => !s.chips.includes(OMITTED_CHIP));
    // two boundaries of the accepted renderer: the largest N it fits untrimmed, and the largest N it fits after its own trimming
    for (const [label, ok] of [['untrimmed', (vm) => memFits(memSize(vm)) && chipless(vm)], ['after its own trim', (vm) => memFits(memSize(vm))]]) {
      let lo = 1, hi = 512;
      assert.ok(ok(o(lo)));
      while (ok(o(hi))) hi *= 2;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ok(o(m))) lo = m; else hi = m; }
      const ov = o(lo);
      const nv = buildViewModel(memSnap(lo, c), NOW, opts);
      const ns = memSize(nv);
      assert.ok(memFits(ns), `${name} (${label}): N=${lo} accepted ${memSize(ov).data} B fits, new ${ns.data} B does not`);
      // once every todo-3 key is gone, nothing the new renderer did may leave it bigger than the accepted one
      if (nv.sessions.every((s) => CVM_KEYS.every((k) => !(k in s))) && !('trimmed' in nv)) assert.ok(ns.data <= memSize(ov).data, `${name} (${label}): ${ns.data} > ${memSize(ov).data}`);
    }
  });
}

test('C-CAP2 legacy tiny live through the real publish: data.js fits at the oracle boundary', async (t) => {
  // the boundary from measured accepted publishes at N=1 and N=2
  const sizes = [];
  for (const n of [1, 2]) {
    const tpl = tmp(t, 'omo-cap2-tpl-');
    writeMinimal(tpl, n, { meta: () => TINY_LIVE });
    sizes.push((await publishBoth(t, tpl)).o.dataBytes);
  }
  const per = sizes[1] - sizes[0];
  const N = Math.floor((MAX_VM_BYTES - (sizes[0] - per)) / per);
  const tpl = tmp(t, 'omo-cap2-tpl-');
  writeMinimal(tpl, N, { meta: () => TINY_LIVE });
  const { o, n } = await publishBoth(t, tpl);
  assert.ok(fits(o), `accepted ${o.dataBytes}`);
  assert.ok(fits(n), `new ${n.dataBytes} at N=${N}`);
  assert.ok(n.vm.sessions.every((s) => s.live !== undefined || s.chips.includes(OMITTED_CHIP)), 'a live row is only dropped with its chip');
});

// Todo 11 must not spend bytes on false question flags at todo 14's decision-bearing boundaries.
const TODO14_TREE = 'bf120f6059f0afb47b6d018e7deeff65001693f8';
for (const [K, N] of [[1, 655], [12, 93]]) {
  test(`C-CAP2 decision boundary K=${K} N=${N}: sparse question flags keep the oracle and todo-14 guarantee`, async (t) => {
    const tpl = tmp(t, 'omo-ask-cap-tpl-');
    writeMinimal(tpl, N);
    const store = openStore(tpl);
    let id = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < K; j++) {
        id++;
        store.writeNew(`decisions/${String(id).padStart(6, '0')}.json`, {
          id, sessionId: sidOf(i), source: 'brief', question: 'q', recommend: 'A', reason: 'r', blocks: false,
          createdAt: NOW - (i + 1) * 1000,
          options: { A: { text: 'a', consequence: 'c' }, B: { text: 'b', consequence: 'd' } },
        });
      }
    }
    const T14 = await oracle(TODO14_TREE);
    const todo14Root = tmp(t, 'omo-ask-cap-t14-');
    nodeFs.cpSync(tpl, todo14Root, { recursive: true });
    assert.equal(T14.render.renderPage(T14.store.openStore(todo14Root), NOW, { isAlive: () => false, sleep: () => {} }).ok, true);
    const todo14 = readData(todo14Root);
    const { o, n } = await publishBoth(t, tpl);
    t.diagnostic(JSON.stringify({
      K, N,
      oracle: { dataBytes: o.dataBytes, jsonBytes: o.jsonBytes },
      todo14: { dataBytes: todo14.dataBytes, jsonBytes: todo14.jsonBytes },
      todo11: { dataBytes: n.dataBytes, jsonBytes: n.jsonBytes },
    }));
    assert.ok(fits(o), `accepted oracle fits (${o.dataBytes} B)`);
    assert.ok(fits(todo14), `todo 14 fits (${todo14.dataBytes} B)`);
    assert.ok(fits(n), `todo 11 must fit where both references fit: ${n.dataBytes} B`);
    assert.deepEqual(strip(n.vm), strip(todo14.vm), 'apart from C-VM trimming, todo 14 decisions remain unchanged');
    assert.equal(n.vm.sessions.reduce((count, s) => count + s.decisions.length, 0), N * K);
    assert.ok(n.vm.sessions.every((s) => s.decisions.every((d) => !('askLive' in d))), 'non-live decisions carry no question flag bytes');
  });
}

const QUESTION_FLAG_CASES = [
  { name: 'mirror', N: 860, k: 0, mirror: true },
  { name: 'dec1mirror', N: 502, k: 1, mirror: true },
  { name: 'liveask', N: 655, k: 1, liveAsk: true },
];
for (const family of QUESTION_FLAG_CASES) {
  test(`C-CAP2 question flag boundary ${family.name} N=${family.N}: pass 8 preserves the oracle and todo-14 guarantee`, async (t) => {
    const { N } = family;
    const tpl = tmp(t, 'av11b-cap-');
    const LIVE_PID = 4242;
    writeMinimal(tpl, N, { meta: (i) => family.liveAsk && i === 0 ? { hostPid: LIVE_PID, askLive: [1] } : {} });
    const templateStore = openStore(tpl);
    let id = 0;
    for (let i = 0; i < N; i++) {
      const at = NOW - (i + 1) * 1000;
      for (let j = 0; j < family.k; j++) {
        id++;
        const live = family.liveAsk && i === 0;
        templateStore.writeNew(`decisions/${String(id).padStart(6, '0')}.json`, {
          id, sessionId: sidOf(i), source: live ? 'ask' : 'brief', ...(live ? { toolCallId: 'call-1' } : {}),
          question: 'q', recommend: 'A', reason: 'r', blocks: false, createdAt: at,
          options: { A: { text: 'a', consequence: 'c' }, B: { text: 'b', consequence: 'd' } },
        });
      }
      if (family.mirror) templateStore.writeNew(`mirror/${sidOf(i)}.json`, { open: true, question: 'Which?', at, paneId: 'w1' });
    }
    const renderers = {
      oracle: await oracle(),
      todo14: await oracle(TODO14_TREE),
      todo11: { render: { renderPage }, store: { openStore } },
    };
    const outputs = {};
    let currentRoot;
    const opts = { isAlive: (pid) => pid === LIVE_PID, sleep: () => {} };
    for (const [name, modules] of Object.entries(renderers)) {
      const root = tmp(t, `av11b-pub-${name}-`);
      nodeFs.cpSync(tpl, root, { recursive: true });
      assert.equal(modules.render.renderPage(modules.store.openStore(root), NOW, opts).ok, true);
      outputs[name] = readData(root);
      if (name === 'todo11') currentRoot = root;
    }
    const current = outputs.todo11;
    t.diagnostic(JSON.stringify({
      family: family.name, N,
      ...Object.fromEntries(Object.entries(outputs).map(([name, output]) => [name, { dataBytes: output.dataBytes, jsonBytes: output.jsonBytes }])),
    }));
    assert.ok(fits(outputs.oracle), `oracle fits at ${N}: ${outputs.oracle.dataBytes} B`);
    assert.ok(fits(outputs.todo14), `todo 14 fits at ${N}: ${outputs.todo14.dataBytes} B`);
    assert.ok(fits(current), `pass 8 must fit ${family.name} at ${N}: ${current.dataBytes} B`);
    // todo 12 omits the old held:false (13 B per decision): at the liveask boundary the oracle fits, so the model now fits before
    // pass 8 and the live flag stays; the mirror families still reach pass 8
    const needsPass8 = !family.liveAsk;
    if (needsPass8) assert.ok(current.vm.sessions.every((s) => CVM_KEYS.every((key) => !(key in s))), 'flags are trimmed only after passes 1-7 exhaust the C-VM fields');
    else assert.ok(current.vm.sessions.find((s) => s.id === sidOf(0)).decisions[0].askLive === true, 'liveask: the flag is kept when the model fits with it');
    const sansFlags = strip(current.vm);
    for (const s of sansFlags.sessions) {
      for (const d of s.decisions) delete d.askLive;
      if (s.openQuestion) delete s.openQuestion.builtin;
    }
    assert.deepEqual(sansFlags, strip(outputs.todo14.vm), 'only optional flags and C-VM detail can be lost');
    assert.deepEqual(sansFlags, strip(outputs.oracle.vm));
    let removed = [];
    if (needsPass8) {
      if (current.vm.trimmed) assert.equal(current.vm.trimmed.cards, N, 'all cards touched by passes 3-8 are counted once');
      else assert.ok(!memFits(memSize({ ...current.vm, trimmed: { cards: N } })), 'counter is absent only when its own bytes do not fit');

      const eligible = current.vm.sessions.filter((s) => family.mirror || s.id === sidOf(0)).sort((a, b) =>
        ((a.tab === '끝남' ? 0 : 1) - (b.tab === '끝남' ? 0 : 1)) || (a.lastActivityAt - b.lastActivityAt));
      removed = eligible.filter((s) => family.mirror ? !('builtin' in s.openQuestion) : !s.decisions.some((d) => 'askLive' in d));
      assert.ok(removed.length > 0, 'the true flags require pass 8');
      assert.deepEqual(removed.map((s) => s.id), eligible.slice(0, removed.length).map((s) => s.id), 'flag drops follow finished-first, oldest-first order');
      if (family.mirror) assert.ok(removed.length < N, 'stop without dropping every note');
      const restored = structuredClone(current.vm);
      const last = restored.sessions.find((s) => s.id === removed.at(-1).id);
      if (family.mirror) last.openQuestion.builtin = true;
      else last.decisions[0].askLive = true;
      assert.ok(!memFits(memSize(restored)), 'restoring the last drop must exceed the cap');
    }
    if (family.liveAsk) {
      const stored = openStore(currentRoot);
      assert.deepEqual(stored.readRecord(`sessions/${sidOf(0)}/meta.json`).askLive, [1], 'model degradation never changes live-call metadata');
      assert.equal(stored.readRecord('decisions/000001.json').source, 'ask');
    }
    if (family.name === 'mirror') {
      // Force build-time seq 999 to land exactly at the cap, then publish seq 1000.
      // Its extra digits must trigger pass 8 again even after the counter was omitted.
      const flagBytes = Buffer.byteLength(',"builtin":true');
      const seqBytes = memSize({ ...current.vm, seq: 999 }).data;
      const padding = (MAX_VM_BYTES - seqBytes + flagBytes) % flagBytes;
      const buildDrops = Math.ceil((seqBytes + padding - MAX_VM_BYTES) / flagBytes);
      assert.equal(seqBytes + padding - buildDrops * flagBytes, MAX_VM_BYTES);
      const stored = openStore(currentRoot);
      stored.replace('published.json', { seq: 999 });
      const briefPath = `sessions/${sidOf(0)}/briefs/000001.json`;
      const record = stored.readRecord(briefPath);
      stored.replace(briefPath, { ...record, brief: { ...record.brief, headline: 'h' + 'a'.repeat(padding) } });
      assert.equal(renderPage(stored, NOW, opts).ok, true);
      const final = readData(currentRoot);
      assert.equal(final.vm.seq, 1000);
      assert.ok(fits(final), `final seq still fits: ${final.dataBytes} B`);
      assert.equal(final.vm.sessions.filter((s) => !('builtin' in s.openQuestion)).length, removed.length + buildDrops + 1);
      t.diagnostic(JSON.stringify({ family: family.name, finalSeq: final.vm.seq, finalDataBytes: final.dataBytes }));
    }
  });
}

// ---- todo 12: held decisions (C-HOLD 4 held={at}, heldCount) keep the C-CAP2 relative guarantee (pass 9)
const ACCEPTED_TREE = '9425d35bf0047b2bdfe6aa68b8333ef069ac6dff'; // the accepted integrated tree before todo 12
const HELD_CASES = {
  allHeld: { k: 1, held: () => true },
  halfHeld: { k: 4, held: (j) => j % 2 === 0 },
};
function heldSnap(n, c) {
  const s = memSnap(n, {});
  s.decisions = [];
  s.closures = [];
  let id = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < c.k; j++) {
      id++;
      s.decisions.push({ id, sessionId: sidOf(i), source: 'brief', question: 'q', recommend: 'A', reason: 'r', blocks: false, createdAt: NOW - (i + 1) * 1000,
        options: { A: { text: 'a', consequence: 'c' }, B: { text: 'b', consequence: 'd' } } });
      if (c.held(j)) s.closures.push({ id, reason: 'held', at: NOW - 1000000000 - id }); // 13-digit times: the widest {at}
    }
  }
  return s;
}
for (const [name, c] of Object.entries(HELD_CASES)) {
  test(`C-CAP2 held decisions ${name}: at the accepted tree's boundary the new model fits; past it, it is never larger`, async () => {
    const opts = { isAlive: () => false, stateDir: 'C:/board/state' };
    for (const [label, tree] of [['accepted', ACCEPTED_TREE], ['oracle', ORACLE_TREE]]) {
      const O = await oracle(tree);
      const o = (n) => O.render.buildViewModel(heldSnap(n, c), NOW, opts);
      const ok = (vm) => memFits(memSize(vm));
      let lo = 1, hi = 64;
      assert.ok(ok(o(lo)));
      while (ok(o(hi))) hi *= 2;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ok(o(m))) lo = m; else hi = m; }
      const nv = buildViewModel(heldSnap(lo, c), NOW, opts);
      const ns = memSize(nv);
      assert.ok(memFits(ns), `${name} vs ${label}: N=${lo} accepted ${memSize(o(lo)).data} B fits, new ${ns.data} B does not`);
      const held = nv.sessions.flatMap((s) => s.decisions.filter((d) => d.held));
      assert.equal(held.length, lo * [...Array(c.k).keys()].filter(c.held).length, 'every held decision is still marked held');
      assert.ok(nv.sessions.every((s) => s.decisions.every((d) => d.held !== false)), 'no held:false bytes');
      const past = buildViewModel(heldSnap(hi, c), NOW, opts);
      assert.ok(memSize(past).data <= memSize(o(hi)).data, `${name} vs ${label}: N=${hi} new ${memSize(past).data} B > accepted ${memSize(o(hi)).data} B`);
      if (!memFits(memSize(past))) assert.ok(past.sessions.every((s) => !('heldCount' in s) && s.decisions.every((d) => !d.held || Object.keys(d.held).length === 0)), 'exhausted: pass 9 removed heldCount and every hold time');
    }
  });
}

test('C-CAP2 pass 9 order: hold details go only after every C-VM key, finished then oldest first, and stop as soon as the model fits', async () => {
  const O = await oracle(ACCEPTED_TREE);
  const opts = { isAlive: () => false, stateDir: 'C:/board/state' };
  const c = HELD_CASES.allHeld;
  const ok = (vm) => memFits(memSize(vm));
  let lo = 1, hi = 64;
  while (ok(O.render.buildViewModel(heldSnap(hi, c), NOW, opts))) hi *= 2;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ok(O.render.buildViewModel(heldSnap(m, c), NOW, opts))) lo = m; else hi = m; }
  const nv = buildViewModel(heldSnap(lo, c), NOW, opts);
  const cut = nv.sessions.filter((s) => !('heldCount' in s));
  if (cut.length) {
    assert.ok(nv.sessions.every((s) => CVM_KEYS.every((k) => !(k in s))), 'pass 9 runs only after passes 1-7 removed every C-VM key');
    const order = nv.sessions.slice().sort((a, b) => a.lastActivityAt - b.lastActivityAt).map((s) => 'heldCount' in s);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the oldest cards lose their hold details first');
    assert.ok(cut.length < nv.sessions.length, 'stops before touching every card');
    const restored = structuredClone(nv);
    const last = restored.sessions.find((s) => s.id === cut.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0].id);
    last.heldCount = 1;
    last.decisions[0].held = { at: NOW - 1000000000 - 1 };
    assert.ok(!memFits(memSize(restored)), 'restoring the last pass-9 cut exceeds the cap');
  }
  assert.ok(ok(nv));
});

test('C-CAP2 pass 8 still drops askLive oldest first when every card has a live board question (held:false no longer pays for it)', async () => {
  const O = await oracle();
  const LIVE = 4343;
  const opts = { isAlive: (pid) => pid === LIVE, stateDir: 'C:/board/state' };
  const snap = (n) => {
    const s = memSnap(n, { meta: (i) => ({ hostPid: LIVE, askLive: [i + 1] }) });
    s.decisions = Array.from({ length: n }, (_, i) => ({ id: i + 1, sessionId: sidOf(i), source: 'ask', toolCallId: `call-${i}`, question: 'q', recommend: 'A', reason: 'r',
      blocks: false, createdAt: NOW - (i + 1) * 1000, options: { A: { text: 'a', consequence: 'c' }, B: { text: 'b', consequence: 'd' } } }));
    return s;
  };
  const ok = (vm) => memFits(memSize(vm));
  let lo = 1, hi = 64;
  while (ok(O.render.buildViewModel(snap(hi), NOW, opts))) hi *= 2;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ok(O.render.buildViewModel(snap(m), NOW, opts))) lo = m; else hi = m; }
  const nv = buildViewModel(snap(lo), NOW, opts);
  assert.ok(ok(nv), `N=${lo}: ${memSize(nv).data} B`);
  const live = nv.sessions.slice().sort((a, b) => a.lastActivityAt - b.lastActivityAt).map((s) => s.decisions[0].askLive === true);
  assert.ok(live.includes(false), 'pass 8 was needed');
  assert.ok(live.includes(true), 'pass 8 stops before dropping every flag');
  assert.deepEqual(live, [...live].sort((a, b) => a - b), 'askLive goes oldest first');
  // restored from the adapted todo-11 liveask family: pass 8 runs only after passes 1-7, counts every card once, and stops exactly
  assert.ok(nv.sessions.every((s) => CVM_KEYS.every((key) => !(key in s))), 'flags are trimmed only after passes 1-7 exhaust the C-VM fields');
  if (nv.trimmed) assert.equal(nv.trimmed.cards, lo, 'all cards touched by passes 3-8 are counted once');
  else assert.ok(!memFits(memSize({ ...nv, trimmed: { cards: lo } })), 'counter is absent only when its own bytes do not fit');
  const restored = structuredClone(nv);
  const lastDrop = restored.sessions.slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt).find((s) => s.decisions[0].askLive !== true);
  lastDrop.decisions[0].askLive = true;
  assert.ok(!memFits(memSize(restored)), 'restoring the last drop must exceed the cap');
});
