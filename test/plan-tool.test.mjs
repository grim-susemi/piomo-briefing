import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from '../src/store.mjs';
import { renderPage } from '../src/render.mjs';
import { setError, clearError } from '../src/errors.mjs';
import { createPlanTool, planChips } from '../src/plan-tool.mjs';
import { planIdOf, rootAndSlugOf } from '../src/plan-schema.mjs';
import { createBriefingExtension } from '../extension.mjs';
import { makeFakePi, makeCtx } from './helpers/fake-pi.mjs';
import { tempDir } from './helpers/temp.mjs';

const STORE_URL = pathToFileURL(fileURLToPath(new URL('../src/store.mjs', import.meta.url))).href;
const TOOL_URL = pathToFileURL(fileURLToPath(new URL('../src/plan-tool.mjs', import.meta.url))).href;
const T0 = 1_700_000_000_000;
const PLAN_TEXT = [
  '# plan',
  '- [ ] 1. 첫째',
  '  Parallelization: Wave 1 | Blocked by: 없음 | Blocks: 2',
  '- [ ] 2. 둘째',
  '  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 없음',
  '',
].join('\n');

const errno = (code) => Object.assign(new Error(`${code}: injected`), { code });
const norm = (p) => p.replace(/\\/g, '/');

/** A temp project + state dir, a real store (with switchable faults) and a plan tool wired like the extension would. */
function setup(t, { sid = 'sess-A', enabled = true, readTextWrap, toolOpts = {} } = {}) {
  const dir = realFs.mkdtempSync(join(tmpdir(), 'omo-plantool-'));
  t.after(() => realFs.rmSync(dir, { recursive: true, force: true }));
  const proj = join(dir, 'proj');
  const stateDir = join(dir, 'state');
  realFs.mkdirSync(join(proj, '.omo', 'plans'), { recursive: true });
  realFs.mkdirSync(join(proj, '.omo', 'drafts'), { recursive: true });
  const planPath = norm(join(proj, '.omo', 'plans', 'demo.md'));
  realFs.writeFileSync(planPath, PLAN_TEXT);

  const faults = { writeRev: null, readAnswer: null, unlinkRev: null };
  const fs = {
    ...realFs,
    writeFileSync(f, d, o) {
      if (faults.writeRev && /rev-\d+\.json$/.test(String(f))) throw errno(faults.writeRev);
      return realFs.writeFileSync(f, d, o);
    },
    readFileSync(f, o) {
      if (faults.readAnswer && /[\\/]answers[\\/]/.test(String(f))) throw errno(faults.readAnswer);
      return realFs.readFileSync(f, o);
    },
    unlinkSync(f) {
      if (faults.unlinkRev && /rev-\d+\.json$/.test(String(f))) throw errno(faults.unlinkRev);
      return realFs.unlinkSync(f);
    },
  };
  const store = openStore(stateDir, { fs, sleep: () => {} });
  const env = { clock: T0, publishCalls: 0, enabled, sid };
  const now = () => env.clock;
  const meta = { sessionId: sid, cwd: proj, project: 'proj', title: 't', workerIds: [], workers: [], errors: {}, lastError: null, lastActivityAt: T0 };
  const saveMeta = (m) => store.replace(`sessions/${sid}/meta.json`, m);
  saveMeta(meta);
  const publish = () => { env.publishCalls += 1; return renderPage(store, now(), { sessionId: sid, sleep: () => {} }); };
  // same contract as extension recordError/settle: record in meta.errors, save (a failed save stays in memory), publish once
  // The save's own exception is not swallowed: it goes to saveFailures. A test that breaks the meta save on purpose claims those with
  // takeSaveFailures() and asserts them; for every other test the teardown below fails it when a failure was left unclaimed.
  const saveFailures = [];
  const takeSaveFailures = () => saveFailures.splice(0);
  t.after(() => { assert.deepEqual(saveFailures.map(String), [], 'a meta save failed that the test did not claim with takeSaveFailures()'); });
  const trySave = () => { try { saveMeta(meta); } catch (err) { saveFailures.push(err); } };
  const onError = (key, err) => { if (setError(meta, key, `${key}: ${err.message}`, now())) { trySave(); publish(); } };
  const onRecover = (key) => { if (clearError(meta, key)) { trySave(); publish(); } };
  const reads = [];
  const defaultRead = async (p) => {
    reads.push(norm(p));
    try { return realFs.readFileSync(p, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  };
  const tool = createPlanTool({
    store, sessionId: sid, cwd: proj, isEnabled: () => env.enabled, publish, onError, onRecover, now,
    getMeta: () => meta, saveMeta, pageUrl: 'C:/state/index.html', readText: readTextWrap ? readTextWrap(defaultRead) : defaultRead,
    ...toolOpts,
  });
  const planId = planIdOf(rootAndSlugOf(planPath).root, 'demo');
  const mk = (over = {}) => ({
    planPath, stage: 'shaping', stageNote: '', goal: '목표', ideal: [{ id: 'IS-1', text: '이상' }], components: [],
    waves: [{ n: 1, label: '기초' }, { n: 2, label: '후속' }],
    tasks: [
      { id: '1', wave: 1, label: '첫째', what: '무엇', done: '끝', deps: [] },
      { id: '2', wave: 2, label: '둘째', what: '무엇', done: '끝', deps: ['1'] },
    ],
    questions: [], outOfScope: [], ...over,
  });
  const planDir = join(stateDir, 'plans', planId);
  const revFiles = () => (realFs.existsSync(planDir) ? realFs.readdirSync(planDir).filter((n) => /^rev-/.test(n)).sort() : []);
  const json = (rel) => JSON.parse(realFs.readFileSync(join(stateDir, rel), 'utf8'));
  const exists = (rel) => realFs.existsSync(join(stateDir, rel));
  const dataJs = () => store.readText('data.js') ?? '';
  return { dir, proj, stateDir, planPath, store, tool, meta, env, faults, planId, mk, revFiles, json, exists, dataJs, reads, saveMeta, takeSaveFailures };
}

const openQ = (id, over = {}) => ({
  id, text: `질문 ${id}?`, state: 'open',
  options: { A: { text: '가', consequence: '빠름' }, B: { text: '나', consequence: '안전' } },
  recommend: 'A', reason: '이유', blocks: false, ...over,
});
const answeredQ = (id) => ({ id, text: `질문 ${id}?`, state: 'answered', answer: 'A안', by: 'owner' });
const decisionFiles = (s) => (s.exists('decisions') ? realFs.readdirSync(join(s.stateDir, 'decisions')).sort() : []);
const dec = (s, id) => s.json(`decisions/${String(id).padStart(6, '0')}.json`);
const closure = (s, id) => {
  const rel = `decision-closures/${String(id).padStart(6, '0')}.json`;
  return s.exists(rel) ? s.json(rel) : null;
};
const tree = (root) => {
  const out = {};
  const walk = (d) => {
    for (const e of realFs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else out[norm(p)] = realFs.readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
};

// ------------------------------------------------------------------ happy path and numbering

test('plan_brief: first call writes rev-000001, status.json, meta.planIds and publishes once', async (t) => {
  const s = setup(t);
  const res = await s.tool.execute(s.mk());
  assert.deepEqual(s.revFiles(), ['rev-000001.json']);
  const rev = s.json(`plans/${s.planId}/rev-000001.json`);
  assert.equal(rev.schema, 'omo-plan/1');
  assert.equal(rev.rev, 1);
  assert.equal(rev.planId, s.planId);
  assert.equal(rev.ownerSessionId, 'sess-A');
  assert.equal(rev.plan.goal, '목표');
  assert.equal(rev.source.planPath, s.planPath);
  assert.match(rev.source.planSha256, /^[0-9a-f]{64}$/);
  const st = s.json(`plans/${s.planId}/status.json`);
  assert.equal(st.schema, 'omo-plan-status/1');
  assert.equal(st.planId, s.planId);
  assert.equal(st.bySessionId, 'sess-A');
  assert.deepEqual(st.boxes, { 1: ' ', 2: ' ' });
  assert.deepEqual(s.meta.planIds, [s.planId]);
  assert.equal(s.json('sessions/sess-A/meta.json').planIds[0], s.planId, 'meta saved');
  assert.equal(s.env.publishCalls, 1);
  assert.equal(res.details.rev, 1);
  assert.equal(res.details.planId, s.planId);
  assert.ok(s.exists('published.json') && s.exists('data.js'), 'a real publish happened');
  assert.deepEqual(s.json('published.json').seq, 1);
});

test('plan_brief: the tool definition is a registrable plan_brief tool', (t) => {
  const s = setup(t);
  assert.equal(s.tool.definition.name, 'plan_brief');
  assert.equal(typeof s.tool.definition.execute, 'function');
  assert.equal(s.tool.definition.parameters.type, 'object');
});

test('plan_brief: 12 calls keep only the newest 10 revs and numbers are never reused', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 12; i++) await s.tool.execute(s.mk({ goal: `목표 ${i}` }));
  const names = s.revFiles();
  assert.equal(names.length, 10);
  assert.equal(names[0], 'rev-000003.json');
  assert.equal(names.at(-1), 'rev-000012.json');
  const next = await s.tool.execute(s.mk({ goal: '또' }));
  assert.equal(next.details.rev, 13);
  assert.equal(s.json(`plans/${s.planId}/rev-000013.json`).plan.goal, '또');
});

test('plan_brief: two processes calling at once never share a rev number', async (t) => {
  const s = setup(t);
  const code = `
import { openStore } from ${JSON.stringify(STORE_URL)};
import { createPlanTool } from ${JSON.stringify(TOOL_URL)};
const cfg = JSON.parse(process.env.OMO_CFG);
const store = openStore(cfg.stateDir);
const tool = createPlanTool({ store, sessionId: cfg.sid, cwd: cfg.cwd, isEnabled: () => true, publish: () => ({ ok: true }),
  onError: (k, e) => { console.error('ERR', k, e.message); process.exitCode = 2; }, onRecover: () => {} });
process.stdin.setEncoding('utf8');
process.stdout.write('ready\\n');
await new Promise((r) => process.stdin.once('data', r));
const revs = [];
for (let i = 0; i < cfg.n; i++) revs.push((await tool.execute({ ...cfg.input, goal: cfg.sid + '-' + i })).details.rev);
process.stdout.write('revs ' + JSON.stringify(revs) + '\\n');
process.stdin.destroy();
`;
  const start = (sid) => {
    const cfg = { stateDir: s.stateDir, sid, cwd: s.proj, n: 4, input: s.mk() };
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, OMO_CFG: JSON.stringify(cfg) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    let err = '';
    let readyResolve;
    const ready = new Promise((r) => { readyResolve = r; });
    child.stdout.on('data', (d) => { out += d; if (out.includes('ready')) readyResolve(); });
    child.stderr.on('data', (d) => { err += d; });
    const closed = new Promise((r) => child.on('close', (c) => r({ code: c, out, err })));
    return { child, ready, closed };
  };
  const a = start('sess-X');
  const b = start('sess-Y');
  t.after(() => { a.child.kill(); b.child.kill(); });
  await Promise.all([a.ready, b.ready]);
  a.child.stdin.write('go\n');
  b.child.stdin.write('go\n');
  const [ra, rb] = await Promise.all([a.closed, b.closed]);
  assert.equal(ra.code, 0, ra.err);
  assert.equal(rb.code, 0, rb.err);
  const revs = [ra, rb].flatMap((r) => JSON.parse(/revs (.*)/.exec(r.out)[1]));
  assert.equal(new Set(revs).size, 8, `distinct numbers: ${revs}`);
  assert.deepEqual(s.revFiles(), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `rev-${String(n).padStart(6, '0')}.json`));
});

// ------------------------------------------------------------------ rejection and failure paths

test('plan_brief: an invalid input is a tool error, stores nothing and publishes nothing', async (t) => {
  const s = setup(t);
  await assert.rejects(s.tool.execute(s.mk({ goal: '가'.repeat(81) })), /goal: 80자 초과\(81\)/);
  await assert.rejects(s.tool.execute(s.mk({ planPath: norm(join(s.proj, '.omo', 'plans', 'nope.md')) })), /파일 없음/);
  assert.equal(s.exists('plans'), false);
  assert.equal(s.exists('decisions'), false);
  assert.equal(s.env.publishCalls, 0);
  assert.deepEqual(s.meta.errors, {}, 'a bad input is the agent\'s to fix, not a stored error');
});

test('plan_brief: planPath and draftPath of different plans are rejected', async (t) => {
  const s = setup(t);
  const other = norm(join(s.proj, '.omo', 'drafts', 'other.md'));
  realFs.writeFileSync(other, 'x');
  await assert.rejects(s.tool.execute(s.mk({ draftPath: other })), /서로 다른 계획/);
  assert.equal(s.exists('plans'), false);
});

test('adversarial repeated interruption: rev write EPERM -> tool error + recorded error shown on the published page; next call recovers', async (t) => {
  const s = setup(t);
  s.faults.writeRev = 'EPERM';
  await assert.rejects(s.tool.execute(s.mk()), /저장하지 못했습니다\(EPERM\)/);
  assert.deepEqual(s.revFiles(), [], 'no partial rev file');
  assert.ok(`plan:${s.planId}` in s.meta.errors);
  assert.ok(s.dataJs().includes('오류 있음'), 'the failure reached the published page');
  await assert.rejects(s.tool.execute(s.mk()), /EPERM/); // repeated interruption: same key, still one entry
  assert.equal(Object.keys(s.meta.errors).length, 1);
  s.faults.writeRev = null;
  const ok = await s.tool.execute(s.mk());
  assert.equal(ok.details.rev, 1, 'no number was burned by the failed attempts');
  assert.deepEqual(s.meta.errors, {}, 'the same key succeeding clears its error');
  assert.ok(!s.dataJs().includes('오류 있음'), 'and the page no longer shows it');
});

test('a failed old-rev delete is reported, not thrown: the rev is saved and the error is recorded', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 10; i++) await s.tool.execute(s.mk({ goal: `g${i}` }));
  s.faults.unlinkRev = 'EPERM';
  const res = await s.tool.execute(s.mk({ goal: 'g10' }));
  assert.equal(res.details.rev, 11);
  assert.ok(res.details.problems.some((p) => p.includes('삭제 실패(EPERM)')));
  assert.ok(`plan:${s.planId}` in s.meta.errors);
  s.faults.unlinkRev = null;
  await s.tool.execute(s.mk({ goal: 'g11' }));
  assert.equal(s.revFiles().length, 10, 'next call prunes again');
  assert.deepEqual(s.meta.errors, {});
});

// ------------------------------------------------------------------ questions as decisions

test('open questions become plain decisions with source plan/planId/qid; the same input reuses them', async (t) => {
  const s = setup(t);
  const input = s.mk({ questions: [openQ('Q1'), openQ('Q2')] });
  const first = await s.tool.execute(input);
  assert.equal(decisionFiles(s).length, 2);
  assert.equal(first.details.created.length, 2);
  const [d1, d2] = first.details.opened;
  assert.deepEqual([dec(s, d1).qid, dec(s, d2).qid], ['Q1', 'Q2']);
  for (const id of [d1, d2]) {
    const d = dec(s, id);
    assert.equal(d.source, 'plan');
    assert.equal(d.planId, s.planId);
    assert.equal(d.sessionId, 'sess-A');
    assert.equal(d.blocks, false);
    assert.equal(d.recommend, 'A');
  }
  const again = await s.tool.execute(input);
  assert.deepEqual(again.details.opened, [d1, d2], 'decision reuse: same ids');
  assert.deepEqual(again.details.created, []);
  assert.equal(decisionFiles(s).length, 2, 'no new decision file');
  assert.equal(again.details.rev, 2);
});

test('a question answered or dropped in a later rev closes its unanswered decision as superseded', async (t) => {
  const s = setup(t);
  const first = await s.tool.execute(s.mk({ questions: [openQ('Q1'), openQ('Q2')] }));
  const [d1, d2] = first.details.opened;
  const second = await s.tool.execute(s.mk({ questions: [answeredQ('Q1'), openQ('Q2')] }));
  assert.deepEqual(second.details.closed, [d1]);
  assert.equal(closure(s, d1).reason, 'superseded');
  assert.equal(closure(s, d2), null);
  const third = await s.tool.execute(s.mk({ questions: [] }));
  assert.deepEqual(third.details.closed, [d2], 'a question missing from the new rev is closed too');
  assert.equal(closure(s, d2).reason, 'superseded');
});

test('adversarial stale_state: a decision with a stored answer is never closed, and a stale "open" claim does not make a new one', async (t) => {
  const s = setup(t);
  const first = await s.tool.execute(s.mk({ questions: [openQ('Q1')] }));
  const [d1] = first.details.opened;
  s.store.writeNew(`answers/${String(d1).padStart(6, '0')}.json`, { id: d1, option: 'A', at: T0, fromSessionId: 'sess-A' });
  const answered = await s.tool.execute(s.mk({ questions: [answeredQ('Q1')] }));
  assert.deepEqual(answered.details.closed, []);
  assert.equal(closure(s, d1), null, 'answered decision stays open for delivery');
  const stale = await s.tool.execute(s.mk({ questions: [openQ('Q1')] }));
  assert.deepEqual(stale.details.created, [], 'stored answer wins over the agent claiming the question is open');
  assert.deepEqual(stale.details.opened, []);
  assert.equal(decisionFiles(s).length, 1);
  const dropped = await s.tool.execute(s.mk({ questions: [] }));
  assert.deepEqual(dropped.details.closed, []);
  assert.equal(closure(s, d1), null);
});

test('adversarial stale_state: a claimed (being answered) decision is not closed either', async (t) => {
  const s = setup(t);
  const first = await s.tool.execute(s.mk({ questions: [openQ('Q1')] }));
  const [d1] = first.details.opened;
  s.store.writeNew(`claims/${String(d1).padStart(6, '0')}.json`, { id: d1, pid: process.pid, at: T0, nonce: 'n' });
  const res = await s.tool.execute(s.mk({ questions: [answeredQ('Q1')] }));
  assert.deepEqual(res.details.closed, []);
  assert.equal(closure(s, d1), null);
});

test('adversarial repeated interruption: answer read EPERM -> not closed, plan:<planId> error shown; recovers and closes when readable', async (t) => {
  const s = setup(t);
  const first = await s.tool.execute(s.mk({ questions: [openQ('Q1')] }));
  const [d1] = first.details.opened;
  s.faults.readAnswer = 'EPERM';
  const res = await s.tool.execute(s.mk({ questions: [answeredQ('Q1')] }));
  assert.deepEqual(res.details.closed, [], 'unreadable answer is not "no answer"');
  assert.equal(closure(s, d1), null);
  assert.ok(res.details.problems.some((p) => p.includes(`#${d1}`) && p.includes('EPERM')));
  assert.ok(`plan:${s.planId}` in s.meta.errors);
  assert.ok(s.dataJs().includes('오류 있음'));
  assert.equal(s.revFiles().length, 2, 'the rev itself was still saved');
  s.faults.readAnswer = null;
  const again = await s.tool.execute(s.mk({ questions: [answeredQ('Q1')] }));
  assert.deepEqual(again.details.closed, [d1]);
  assert.deepEqual(s.meta.errors, {});
});

test('an unreadable decision file blocks creating a duplicate question decision (unreadable is not absent)', async (t) => {
  const s = setup(t);
  realFs.mkdirSync(join(s.stateDir, 'decisions'), { recursive: true });
  realFs.writeFileSync(join(s.stateDir, 'decisions', '000001.json'), '{ broken');
  const res = await s.tool.execute(s.mk({ questions: [openQ('Q1')] }));
  assert.deepEqual(res.details.created, []);
  assert.equal(decisionFiles(s).length, 1);
  assert.ok(res.details.problems.some((p) => p.includes('결정 파일 읽기 실패')));
  assert.ok(`plan:${s.planId}` in s.meta.errors);
});

test('another session taking over the plan supersedes the previous unanswered decision and opens its own', async (t) => {
  const a = setup(t, { sid: 'sess-A' });
  const first = await a.tool.execute(a.mk({ questions: [openQ('Q1')] }));
  const [dA] = first.details.opened;
  // second lead session on the same state dir and the same plan
  const metaB = { sessionId: 'sess-B', errors: {} };
  const toolB = createPlanTool({
    store: a.store, sessionId: 'sess-B', cwd: a.proj, isEnabled: () => true, publish: () => ({ ok: true }),
    onError: () => assert.fail('no error expected'), onRecover: () => {}, now: () => T0, getMeta: () => metaB, saveMeta: () => {},
  });
  const res = await toolB.execute(a.mk({ questions: [openQ('Q1')] }));
  assert.deepEqual(res.details.closed, [dA]);
  assert.equal(closure(a, dA).reason, 'superseded');
  assert.equal(res.details.created.length, 1);
  assert.equal(dec(a, res.details.created[0]).sessionId, 'sess-B');
  assert.equal(res.details.rev, 2);
});

test('decisionId must be this session\'s open decision; an own one is kept', async (t) => {
  const s = setup(t);
  const first = await s.tool.execute(s.mk({ questions: [openQ('Q1')] }));
  const [d1] = first.details.opened;
  const kept = await s.tool.execute(s.mk({ questions: [openQ('Q1', { decisionId: d1 })] }));
  assert.deepEqual(kept.details.opened, [d1]);
  assert.deepEqual(kept.details.created, []);
  await assert.rejects(s.tool.execute(s.mk({ questions: [openQ('Q1', { decisionId: 99 })] })), /decisionId/);
  s.store.writeNew('decisions/000050.json', { id: 50, sessionId: 'sess-OTHER', question: 'x' });
  await assert.rejects(s.tool.execute(s.mk({ questions: [openQ('Q1', { decisionId: 50 })] })), /이 세션의 열린 결정이 아님/);
});

// ------------------------------------------------------------------ pause

function briefExtension(t) {
  const { dir, onDispose } = tempDir(t, 'omo-plantool-ext-');
  const stateDir = join(dir, 'state');
  const host = makeFakePi({});
  let clock = T0;
  createBriefingExtension({
    stateDir, now: () => (clock += 1000), env: { PATH: process.env.PATH }, openPage: () => ({}), renderOpts: { sleep: () => {} },
  })(host.pi);
  const { ctx } = makeCtx({ sid: 'sess-A' });
  onDispose(() => host.emit('session_shutdown', {}, ctx));
  return { host, ctx };
}

test('paused: execute answers exactly like executeBrief and saves nothing; onToolResult/onSettled write nothing', async (t) => {
  // real executeBrief answer while paused
  const ext = briefExtension(t);
  await ext.host.emit('session_start', { reason: 'startup' }, ext.ctx);
  await ext.host.commands.get('brief').handler('off', ext.ctx);
  const briefAnswer = await ext.host.tool('brief').execute('c', {
    title: 'x', status: 'in_progress', headline: 'h', changes: [], done: [], next: '', decisions: [],
  }, undefined, undefined, ext.ctx);
  assert.equal(briefAnswer.details.disabled, true);

  const s = setup(t);
  await s.tool.execute(s.mk({ questions: [openQ('Q1')] })); // some stored state first
  s.tool.onToolResult({ toolName: 'edit', input: { path: s.planPath }, isError: false });
  s.env.clock += 120_000;
  await s.tool.onSettled();
  const before = tree(s.dir);
  const publishes = s.env.publishCalls;

  s.env.enabled = false;
  s.env.clock += 120_000;
  realFs.appendFileSync(s.planPath, 'x'); // a plan file change that must not be noticed while paused
  const paused = await s.tool.execute(s.mk({ goal: '꺼진 동안' }));
  assert.equal(paused.details.disabled, true);
  assert.deepEqual(paused.content, briefAnswer.content, 'same answer as executeBrief while paused');
  s.tool.onToolResult({ toolName: 'write', input: { path: norm(join(s.proj, '.omo', 'plans', 'other.md')) }, isError: false });
  assert.deepEqual(await s.tool.onSettled(), []);
  const after = tree(s.dir);
  after[norm(s.planPath)] = before[norm(s.planPath)]; // only the plan file itself (our own appendFileSync) differs
  assert.deepEqual(after, before, 'state dir (status.json, published, meta, decisions) is byte-identical');
  assert.equal(s.env.publishCalls, publishes, 'nothing published while paused');
});

// ------------------------------------------------------------------ plan-file writes and chips

const settledChips = async (s) => (await s.tool.onSettled()).find((r) => r.planId === s.planId)?.chips;

test('misleading_success_output: a plan file written without plan_brief shows the "계획 요약 없음" chip (edit tool), and a read does not', async (t) => {
  const s = setup(t);
  s.tool.onToolResult({ toolName: 'read', input: { path: s.planPath }, isError: false });
  s.tool.onToolResult({ toolName: 'edit', input: { path: s.planPath }, isError: true });
  assert.deepEqual(await s.tool.onSettled(), [], 'read and failed edits are not plan writes');
  s.tool.onToolResult({ toolName: 'edit', input: { path: s.planPath, edits: [] }, isError: false });
  assert.ok(s.meta.planWrites[s.planId] > 0);
  assert.deepEqual(await settledChips(s), ['계획 요약 없음']);
  assert.deepEqual(s.meta.planChips[s.planId].chips, ['계획 요약 없음']);
  assert.equal(s.meta.planChips[s.planId].checkedAt, T0, 'time of the last check');
  const st = s.json(`plans/${s.planId}/status.json`);
  assert.deepEqual(st.skeleton.tasks.map((x) => x.id), ['1', '2'], 'skeleton from the plan file without any rev');
  assert.deepEqual(s.revFiles(), []);
  // after plan_brief the chip is gone
  await s.tool.execute(s.mk());
  assert.deepEqual(s.meta.planChips[s.planId].chips, []);
});

test('apply_patch body (relative path, resolved against cwd) and a draft write are detected', async (t) => {
  const s = setup(t);
  const patch = ['*** Begin Patch', '*** Update File: .omo/plans/demo.md', '@@', '-a', '+b', '*** End Patch'].join('\n');
  s.tool.onToolResult({ toolName: 'apply_patch', input: { input: patch }, isError: false });
  assert.ok(s.meta.planWrites[s.planId] > 0);
  const draft = norm(join(s.proj, '.omo', 'drafts', 'demo.md'));
  realFs.writeFileSync(draft, '---\nstatus: draft\n---\n');
  s.tool.onToolResult({ toolName: 'write', input: { file_path: draft }, isError: false });
  assert.equal(norm(s.meta.planFiles[s.planId].draftPath), draft);
  assert.equal(norm(s.meta.planFiles[s.planId].planPath), s.planPath);
  assert.deepEqual(await settledChips(s), ['계획 요약 없음']);
  assert.equal(s.json(`plans/${s.planId}/status.json`).files.draftStatus, 'draft');
  // not a plan file: ignored
  const before = JSON.stringify(s.meta.planWrites);
  s.tool.onToolResult({ toolName: 'edit', input: { path: norm(join(s.proj, 'src', 'a.md')) }, isError: false });
  assert.equal(JSON.stringify(s.meta.planWrites), before);
});

test('a plan file changed after the summary shows "계획 파일이 요약 뒤에 바뀜"; tasks missing from the summary are counted; status is cached 60s', async (t) => {
  const s = setup(t);
  await s.tool.execute(s.mk());
  assert.deepEqual(s.meta.planChips[s.planId].chips, []);
  realFs.appendFileSync(s.planPath, '- [ ] 3. 셋째\n');
  const planReads = () => s.reads.filter((p) => p.endsWith('/demo.md')).length;
  const readsBefore = planReads();
  s.env.clock += 30_000;
  assert.deepEqual(await settledChips(s), undefined, 'inside 60s: cached, no recompute');
  assert.equal(planReads(), readsBefore, 'no plan file read inside the cache window');
  s.env.clock += 31_000;
  assert.deepEqual(await settledChips(s), ['계획 파일이 요약 뒤에 바뀜', '요약에 없는 할 일 1개']);
  assert.deepEqual(s.json(`plans/${s.planId}/status.json`).boxes['3'], ' ');
  assert.ok(s.dataJs().length > 0);
  // a later check that finds nothing new: checkedAt is that check's time, and nothing is published for it
  const publishes = s.env.publishCalls;
  s.env.clock += 61_000;
  assert.deepEqual(await settledChips(s), ['계획 파일이 요약 뒤에 바뀜', '요약에 없는 할 일 1개']);
  assert.equal(s.meta.planChips[s.planId].checkedAt, s.env.clock);
  assert.equal(s.env.publishCalls, publishes);
  // new summary that includes task 3: both chips go away
  await s.tool.execute(s.mk({ tasks: [...s.mk().tasks, { id: '3', wave: 2, label: '셋째', what: '무엇', done: '끝', deps: ['1'] }] }));
  assert.deepEqual(s.meta.planChips[s.planId].chips, []);
});

test('onSettled: an unreadable plan file is an error (plan:<planId>), not a silently missing plan; a later clean read clears it', async (t) => {
  let fail = false;
  const s = setup(t, {
    readTextWrap: (base) => async (p) => { if (fail && p.endsWith('demo.md')) throw errno('EPERM'); return base(p); },
  });
  await s.tool.execute(s.mk());
  fail = true;
  s.env.clock += 61_000;
  await s.tool.onSettled();
  assert.ok(`plan:${s.planId}` in s.meta.errors, 'recorded');
  assert.ok(s.dataJs().includes('오류 있음'), 'and shown on the published page');
  assert.equal(planChips({ rev: s.json(`plans/${s.planId}/rev-000001.json`), status: s.json(`plans/${s.planId}/status.json`) }).includes('계획 파일이 요약 뒤에 바뀜'), false, 'an unreadable file is not "changed"');
  fail = false;
  s.env.clock += 61_000;
  await s.tool.onSettled();
  assert.deepEqual(s.meta.errors, {});
});

test('planChips is pure: no rev + not written = no chip; changed draft sha counts too', () => {
  assert.deepEqual(planChips({ rev: null, planWritten: undefined }), []);
  assert.deepEqual(planChips({ rev: null, planWritten: 5 }), ['계획 요약 없음']);
  const rev = { source: { planSha256: 'a', draftSha256: 'b' }, plan: { tasks: [] } };
  assert.deepEqual(planChips({ rev, status: { files: { planSha256Now: 'a', draftSha256Now: 'c' } } }), ['계획 파일이 요약 뒤에 바뀜']);
  assert.deepEqual(planChips({ rev, status: { files: { planSha256Now: 'a' } } }), []);
});

test('onSettled picks up the plan of this session from boulder (findPlanForSession) and builds a skeleton for it', async (t) => {
  const s = setup(t);
  realFs.writeFileSync(join(s.proj, '.omo', 'boulder.json'), JSON.stringify({
    works: { w1: { work_id: 'w1', active_plan: '.omo/plans/demo.md', session_ids: ['senpi:sess-A'], status: 'active', updated_at: '2026-01-01T00:00:00Z' } },
  }));
  s.tool.onToolResult({ toolName: 'read', input: {}, isError: false });
  const out = await s.tool.onSettled();
  assert.equal(out.length, 1);
  assert.equal(out[0].planId, s.planId);
  const st = s.json(`plans/${s.planId}/status.json`);
  assert.equal(st.work.workId, 'w1');
  assert.deepEqual(st.work.sessionIds, ['senpi:sess-A']);
  assert.deepEqual(s.revFiles(), [], 'no rev invented from a boulder plan');
  assert.deepEqual(out[0].chips, [], 'no "written without summary" chip: this session did not write it');
});

test('onSettled: an unreadable boulder is reported (plan:boulder), not treated as no work', async (t) => {
  const s = setup(t, {
    readTextWrap: (base) => async (p) => { if (p.endsWith('boulder.json')) return '{ broken'; return base(p); },
  });
  await s.tool.onSettled();
  assert.ok('plan:boulder' in s.meta.errors);
});

test('repeated_interruptions: meta.json that cannot be replaced is plan:writes; it stays while the save fails and clears once a retried save works', async (t) => {
  const s = setup(t);
  s.tool.onToolResult({ toolName: 'edit', input: { path: s.planPath }, isError: false });
  const metaFile = join(s.stateDir, 'sessions', 'sess-A', 'meta.json');
  const good = realFs.readFileSync(metaFile);
  realFs.rmSync(metaFile);
  realFs.mkdirSync(metaFile); // real fault, no injection: a directory where meta.json should be
  await s.tool.onSettled();
  assert.ok('plan:writes' in s.meta.errors, 'recorded');
  s.env.clock += 61_000;
  await s.tool.onSettled();
  assert.ok('plan:writes' in s.meta.errors, 'not cleared while the save still fails');
  const lost = s.takeSaveFailures(); // the fixture's own saves of those plan errors hit the same directory and failed too
  assert.ok(lost.length > 0 && lost.every((e) => e instanceof Error && /meta\.json/.test(e.message)), `the failed saves are recorded, not swallowed: ${lost.length}`);
  realFs.rmSync(metaFile, { recursive: true });
  realFs.writeFileSync(metaFile, good);
  s.env.clock += 61_000;
  await s.tool.onSettled();
  assert.deepEqual(s.meta.errors, {});
  const disk = s.json('sessions/sess-A/meta.json');
  assert.deepEqual(disk.errors, {}, 'the clearing is saved');
  assert.deepEqual(disk.planChips[s.planId].chips, ['계획 요약 없음'], 'the change the failed save lost is saved now');
});

test('repeated_interruptions: a plan list that cannot be read once (plan:writes) is cleared by the next clean settle', async (t) => {
  const s = setup(t);
  const readPlans = s.store.readPlans;
  s.store.readPlans = () => { s.store.readPlans = readPlans; throw errno('EPERM'); }; // fails once
  await s.tool.onSettled();
  assert.ok('plan:writes' in s.meta.errors, 'recorded');
  assert.ok(s.dataJs().includes('오류 있음'), 'and shown on the published page');
  await s.tool.onSettled();
  assert.deepEqual(s.meta.errors, {});
  assert.equal(s.dataJs().includes('오류 있음'), false, 'the page no longer shows it');
});

test('row 23 fixture: a meta save that fails while a plan error is recorded is kept in saveFailures, not swallowed; the error stays in memory and the page is published once', async (t) => {
  const s = setup(t);
  const metaRel = 'sessions/sess-A/meta.json';
  const replace = s.store.replace;
  const boom = errno('EIO');
  s.store.replace = (rel, data) => {
    if (rel !== metaRel) return replace(rel, data);
    s.store.replace = replace; // fails once
    throw boom;
  };
  s.faults.writeRev = 'EPERM';
  await assert.rejects(s.tool.execute(s.mk()), /저장하지 못했습니다\(EPERM\)/);
  const failures = s.takeSaveFailures();
  assert.equal(failures.length, 1, 'exactly the one injected save failure');
  assert.equal(failures[0], boom, 'the very exception the save threw');
  assert.deepEqual(s.takeSaveFailures(), [], 'claiming empties the record');
  assert.ok(`plan:${s.planId}` in s.meta.errors, 'the plan error stays in memory although it could not be saved');
  assert.deepEqual(s.json(metaRel).errors, {}, 'nothing reached the disk');
  assert.equal(s.env.publishCalls, 1, 'published exactly once');
});

// ------------------------------------------------------------------ row 17: the pause state is checked again after every await

/** readText wrapper that parks the next read of a path matching `re` until the test releases it. */
function parkedRead() {
  const ctl = { re: null };
  ctl.arm = (re, failCode = null) => {
    ctl.re = re;
    ctl.failCode = failCode; // when set, the parked read FAILS with this errno after it is released
    ctl.inside = new Promise((resolve) => { ctl.entered = resolve; });
    ctl.gate = new Promise((resolve) => { ctl.release = resolve; });
  };
  ctl.wrap = (inner) => async (p) => {
    if (ctl.re && ctl.re.test(norm(p))) {
      ctl.re = null;
      ctl.entered();
      await ctl.gate;
      if (ctl.failCode) throw errno(ctl.failCode);
    }
    return inner(p);
  };
  return ctl;
}

test('row 17 execute: the board is switched off by another conversation while the plan files are read: nothing is written (revision, status, decision, meta) and nothing is published', async (t) => {
  const park = parkedRead();
  const s = setup(t, { readTextWrap: park.wrap });
  const before = tree(s.stateDir);
  const metaBefore = JSON.stringify(s.meta);
  park.arm(/\/plans\/demo\.md$/);
  const run = s.tool.execute(s.mk({ questions: [openQ('Q1')] }));
  await park.inside;
  s.env.enabled = false;
  park.release();
  const res = await run;
  assert.equal(res.details.disabled, true);
  assert.deepEqual(tree(s.stateDir), before, 'no revision, status.json, decision or meta file appeared');
  assert.equal(JSON.stringify(s.meta), metaBefore, 'the in-memory meta is untouched');
  assert.equal(s.env.publishCalls, 0);
  assert.deepEqual(s.revFiles(), []);
});

for (const [label, re] of [
  ['boulder.json', /\/\.omo\/boulder\.json$/],
  ['the plan file', /\/\.omo\/plans\/demo\.md$/],
]) {
  test(`row 17 onSettled: the board is switched off by another conversation while ${label} is read: no status, meta, error or publish; the interrupted pass leaves the 60s cache alone`, async (t) => {
    const park = parkedRead();
    const s = setup(t, { readTextWrap: park.wrap });
    await s.tool.execute(s.mk());
    const published = s.env.publishCalls;
    s.env.clock += 61_000;
    realFs.writeFileSync(s.planPath, PLAN_TEXT.replace('- [ ] 1.', '- [x] 1.'));
    const before = tree(s.stateDir);
    const metaBefore = JSON.stringify(s.meta);
    park.arm(re);
    const run = s.tool.onSettled();
    await park.inside;
    s.env.enabled = false;
    park.release();
    assert.deepEqual(await run, []);
    assert.deepEqual(tree(s.stateDir), before, 'status.json and meta.json are as they were');
    assert.equal(JSON.stringify(s.meta), metaBefore);
    assert.equal(s.env.publishCalls, published);
    assert.deepEqual(s.meta.errors, {});
    // the interrupted pass did not use up the cache window: once the board is on again the same change is picked up at once
    s.env.enabled = true;
    await s.tool.onSettled();
    assert.equal(s.json(`plans/${s.planId}/status.json`).boxes['1'], 'x');
  });
}

test('row 17 onSettled: a boulder read that FAILS after the board was switched off is not recorded as plan:boulder: no error entry, no meta write, no publish', async (t) => {
  const park = parkedRead();
  const s = setup(t, { readTextWrap: park.wrap });
  await s.tool.execute(s.mk());
  const published = s.env.publishCalls;
  s.env.clock += 61_000;
  const before = tree(s.stateDir);
  const metaBefore = JSON.stringify(s.meta);
  park.arm(/\/\.omo\/boulder\.json$/, 'EIO');
  const run = s.tool.onSettled();
  await park.inside;
  s.env.enabled = false;
  park.release();
  assert.deepEqual(await run, []);
  assert.deepEqual(s.meta.errors, {}, 'no plan:boulder error while the board is off');
  assert.equal(JSON.stringify(s.meta), metaBefore);
  assert.deepEqual(tree(s.stateDir), before);
  assert.equal(s.env.publishCalls, published);
});

// ------------------------------------------------------------------ row 19: boulder discovery follows the retry and size policy of the plan reads

const BOULDER_OK = JSON.stringify({
  works: { w1: { work_id: 'w1', active_plan: '.omo/plans/demo.md', session_ids: ['senpi:sess-A'], status: 'active', updated_at: '2026-01-01T00:00:00Z' } },
});
/** Reads of boulder.json are scripted: `script` holds errno codes (or 'big') consumed one per read, then the real file answers. */
function boulderScript(script) {
  const log = { attempts: 0, sleeps: [] };
  const wrap = (inner) => async (p) => {
    if (!String(p).endsWith('boulder.json')) return inner(p);
    log.attempts += 1;
    const step = script.shift();
    if (step === 'big') return `{"works":{},"pad":"${'x'.repeat(16 * 1024 * 1024)}"}`;
    if (step) throw errno(step);
    return inner(p);
  };
  return { log, script, wrap, sleep: async (ms) => { log.sleeps.push(ms); } };
}
const withBoulder = (t, script) => {
  const b = boulderScript(script);
  const s = setup(t, { readTextWrap: b.wrap, toolOpts: { sleep: b.sleep } });
  realFs.writeFileSync(join(s.proj, '.omo', 'boulder.json'), BOULDER_OK);
  return { b, s };
};

test('row 19 onSettled: boulder discovery retries a first transient error (EPERM) and finds the plan; no plan:boulder error', async (t) => {
  const { b, s } = withBoulder(t, ['EPERM']);
  const out = await s.tool.onSettled();
  assert.deepEqual(b.log.sleeps, [20], 'one retry after the first failure');
  assert.deepEqual(s.meta.errors, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].planId, s.planId);
  assert.ok(s.exists(`plans/${s.planId}/status.json`));
});

test('row 19 onSettled: boulder discovery retries a second transient error (EBUSY) with a longer wait and still finds the plan', async (t) => {
  const { b, s } = withBoulder(t, ['EPERM', 'EBUSY']);
  const out = await s.tool.onSettled();
  assert.deepEqual(b.log.sleeps, [20, 40]);
  assert.deepEqual(s.meta.errors, {});
  assert.equal(out[0].planId, s.planId);
});

test('row 19 onSettled: a persistent EACCES on boulder.json is retried a bounded number of times and reported as plan:boulder; a later clean read clears it', async (t) => {
  const { b, s } = withBoulder(t, Array(50).fill('EACCES'));
  assert.deepEqual(await s.tool.onSettled(), []);
  assert.ok(b.log.attempts > 1 && b.log.attempts <= 5, `attempts: ${b.log.attempts}`);
  assert.equal(b.log.sleeps.length, b.log.attempts - 1);
  assert.match(s.meta.errors['plan:boulder'].message, /EACCES/);
  assert.ok(s.dataJs().includes('오류 있음'), 'shown on the published page');
  b.script.length = 0; // the file is readable again
  const out = await s.tool.onSettled();
  assert.equal(s.meta.errors['plan:boulder'], undefined, 'a clean read clears only this key');
  assert.equal(out[0].planId, s.planId);
});

test('row 19 onSettled: a non-transient error on boulder.json is reported at once, without a retry', async (t) => {
  const { b, s } = withBoulder(t, ['EIO']);
  await s.tool.onSettled();
  assert.equal(b.log.attempts, 1);
  assert.deepEqual(b.log.sleeps, []);
  assert.match(s.meta.errors['plan:boulder'].message, /EIO/);
});

test('row 19 onSettled: an over-limit boulder.json is refused by the size policy (not retried, not read as no work); a normal one clears the error', async (t) => {
  const { b, s } = withBoulder(t, ['big']);
  assert.deepEqual(await s.tool.onSettled(), []);
  assert.equal(b.log.attempts, 1, 'not retried');
  assert.ok(s.meta.errors['plan:boulder'].message.includes(String(16 * 1024 * 1024)), 'the limit is named');
  const out = await s.tool.onSettled();
  assert.equal(s.meta.errors['plan:boulder'], undefined);
  assert.equal(out[0].planId, s.planId);
});

test('row 19 execute: with the default reader a size-only (truncated) over-limit plan file is refused after a stat, before any of it is read', async (t) => {
  const reads = [];
  const fs = { ...realFs, promises: { ...realFs.promises, readFile(p, ...a) { reads.push(norm(String(p))); return realFs.promises.readFile(p, ...a); } } };
  const s = setup(t, { toolOpts: { readText: undefined, fs } });
  realFs.truncateSync(s.planPath, 8 * 1024 * 1024 + 1); // 2M characters x 4 bytes is the plan limit
  const res = await s.tool.execute(s.mk());
  assert.ok(res.details.problems.some((p) => p.includes('TOO_LARGE')), JSON.stringify(res.details.problems));
  assert.equal(reads.filter((p) => p.endsWith('/demo.md')).length, 0, 'the plan file was never read');
});
