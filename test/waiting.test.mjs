import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitingItems } from '../src/waiting.mjs';
import { createMirror } from '../src/mirror.mjs';
import { openStore } from '../src/store.mjs';
import { createPlanTool } from '../src/plan-tool.mjs';
import { planIdOf, rootAndSlugOf } from '../src/plan-schema.mjs';
import { makeCtx } from './helpers/fake-pi.mjs';

const T0 = 1_700_000_000_000;
const DAY = 24 * 3600 * 1000;
const FIX = JSON.parse(realFs.readFileSync(new URL('./fixtures/mirror/ask-user-events.json', import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const pad6 = (n) => String(n).padStart(6, '0');
const norm = (p) => p.replace(/\\/g, '/');
const OPTS = { A: { text: '가', consequence: '빠름' }, B: { text: '나', consequence: '안전' } };

// ------------------------------------------------------------------ hand-built snapshots (store.readSnapshot shape)

function sess(sid, { title, metaTitle } = {}) {
  return {
    sid,
    meta: { sessionId: sid, cwd: `C:/work/${sid}`, lastActivityAt: T0, ...(metaTitle !== undefined ? { title: metaTitle } : {}) },
    briefs: title === undefined ? [] : [
      { seq: 1, data: { at: T0, brief: { title: '예전 제목' } } },
      { seq: 2, data: { at: T0 + 1, brief: { title } } },
    ],
  };
}
const dec = (id, sid, extra = {}) => ({
  id, sessionId: sid, question: `결정 ${id}?`, options: OPTS, recommend: 'A', reason: '이유', blocks: false, createdAt: T0 + id, ...extra,
});
const req = (requestId, questions, extra = {}) => ({
  requestId, at: T0 + 50, required: false,
  questions: questions.map((q, i) => ({ id: `q${i}`, header: '', question: q, options: [{ label: '예' }, { label: '아니오' }] })),
  ...extra,
});
const mirrorOf = (sid, data) => ({ sid, data: { sessionId: sid, open: true, question: '', at: T0, paneId: 'pane-1', pid: 1, updatedAt: T0, ...data } });
const snap = (over = {}) => ({
  settings: { enabled: true }, sessions: [], decisions: [], closures: [], answers: [], claims: [], receipts: [], mirror: [],
  plans: [], published: null, readErrors: [], maxMtime: 0, ...over,
});
const keys = (items) => items.map((i) => i.key);

test('open decision, plan question and mirror question get the d / p / q keys with session, title, text, blocks and at', () => {
  const planId = 'p0123456789ab';
  const items = waitingItems(snap({
    sessions: [sess('S1', { title: '첫 대화' }), sess('S2', { metaTitle: '메타 제목' }), sess('S3')],
    decisions: [
      dec(1, 'S1', { blocks: true }),
      dec(2, 'S2', { source: 'plan', planId, qid: 'Q3', question: '계획 질문?' }),
    ],
    mirror: [mirrorOf('S3', { question: '미러 질문?', requests: [req('toolu_x', ['미러 질문?'], { required: true })] })],
  }));
  assert.deepEqual(items, [
    { key: 'd1', sessionId: 'S1', title: '첫 대화', text: '결정 1?', blocks: true, at: T0 + 1 },
    { key: `p${planId}:Q3`, sessionId: 'S2', title: '메타 제목', text: '계획 질문?', blocks: false, at: T0 + 2 },
    { key: 'qS3:toolu_x', sessionId: 'S3', title: 'S3', text: '미러 질문?', blocks: true, at: T0 + 50 },
  ]);
});

test('a question that timed out into decision cards keeps its mirror key: one item for the whole request', () => {
  const base = { sessions: [sess('S1', { title: '대화' })] };
  const open = waitingItems(snap({
    ...base,
    mirror: [mirrorOf('S1', { requests: [req('toolu_r', ['첫 질문?', '둘째 질문?'], { required: true })] })],
  }));
  assert.deepEqual(keys(open), ['qS1:toolu_r']);
  assert.equal(open[0].text, '첫 질문?');

  // closed unanswered, decision cards still owed (mirror unconverted[]): the same item
  const owed = waitingItems(snap({
    ...base,
    mirror: [mirrorOf('S1', { open: false, requests: [], unconverted: [{ ...req('toolu_r', ['첫 질문?', '둘째 질문?'], { required: true }), status: 'timed_out' }] })],
  }));
  assert.deepEqual(keys(owed), ['qS1:toolu_r']);

  // converted: two question-timeout decisions of that request -> still one item with the mirror key, never d<id>
  const cards = [
    dec(7, 'S1', { source: 'question-timeout', requestId: 'toolu_r', questionIndex: 0, question: '첫 질문?', blocks: true }),
    dec(8, 'S1', { source: 'question-timeout', requestId: 'toolu_r', questionIndex: 1, question: '둘째 질문?', blocks: true }),
  ];
  const converted = waitingItems(snap({ ...base, decisions: cards }));
  assert.deepEqual(converted, [{ key: 'qS1:toolu_r', sessionId: 'S1', title: '대화', text: '첫 질문?', blocks: true, at: T0 + 7 }]);

  // one card answered, the other still open: still waiting; both answered: gone
  assert.deepEqual(keys(waitingItems(snap({ ...base, decisions: cards, answers: [{ id: 7, option: 'A', at: T0 }] }))), ['qS1:toolu_r']);
  assert.deepEqual(waitingItems(snap({ ...base, decisions: cards, answers: [{ id: 7, option: 'A', at: T0 }, { id: 8, option: 'B', at: T0 }] })), []);
});

test('answered or closed decisions are not waiting; a claim alone does not hide one (same rule as the board)', () => {
  const items = waitingItems(snap({
    sessions: [sess('S1')],
    decisions: [dec(1, 'S1'), dec(2, 'S1'), dec(3, 'S1'), dec(4, 'S1')],
    answers: [{ id: 1, option: 'A', at: T0 }],
    closures: [{ id: 2, reason: 'superseded', at: T0 }],
    claims: [{ id: 3, pid: 1, at: T0 }],
  }));
  assert.deepEqual(keys(items), ['d3', 'd4']);
});

test('a closed session (mirror open:false) hides its open requests but keeps conversions it still owes', () => {
  const items = waitingItems(snap({
    sessions: [sess('S1')],
    mirror: [mirrorOf('S1', {
      open: false,
      requests: [req('toolu_open', ['아직 열린 질문?'])],
      unconverted: [{ ...req('toolu_owed', ['옮겨야 할 질문?']), status: 'cancelled' }],
    })],
  }));
  assert.deepEqual(keys(items), ['qS1:toolu_owed']);
  assert.equal(items[0].text, '옮겨야 할 질문?');
});

test('older mirror records without requests[] still give one item keyed by their asked time', () => {
  const items = waitingItems(snap({
    sessions: [sess('S1')],
    mirror: [{ sid: 'S1', data: { open: true, text: '옛 모양 질문?', at: T0 + 5 } }, { sid: 'S2', data: { open: true, question: '세션 없음' } }],
  }));
  assert.deepEqual(items, [{ key: `qS1:${T0 + 5}`, sessionId: 'S1', title: 'S1', text: '옛 모양 질문?', blocks: false, at: T0 + 5 }]);
});

test('only sessions present in the snapshot; malformed input is skipped and never throws; nothing is mutated', () => {
  assert.deepEqual(waitingItems(undefined), []);
  assert.deepEqual(waitingItems(null), []);
  assert.deepEqual(waitingItems({ sessions: 'x', decisions: {}, mirror: 7 }), []);
  const input = snap({
    sessions: [sess('S1'), null, { sid: 5 }, 'S9'],
    decisions: [null, { id: 'x', sessionId: 'S1' }, { id: 9 }, dec(10, 'gone'), dec(11, 'S1', { question: '  여러\n줄\t질문  ', createdAt: 'x' }),
      dec(12, 'S1', { source: 'plan', planId: '', qid: 'Q1' }), dec(13, 'S1', { source: 'question-timeout' })],
    answers: [null, { id: 'nope' }],
    closures: [7],
    mirror: [null, { sid: 'S1' }, { sid: 'S1', data: { open: true, requests: [null, { requestId: '' }, { requestId: 'r', questions: 'x' }] } }],
  });
  const before = clone(input);
  const items = waitingItems(input);
  assert.deepEqual(keys(items), ['d12', 'd13', 'd11', 'qS1:r']);
  assert.equal(items.find((i) => i.key === 'd11').text, '여러 줄 질문');
  assert.equal(items.find((i) => i.key === 'd11').at, null);
  assert.deepEqual(input, before, 'input left as it was');
});

test('items are ordered by when they started waiting (unknown last), ties by key', () => {
  const items = waitingItems(snap({
    sessions: [sess('S1')],
    decisions: [dec(3, 'S1', { createdAt: T0 + 30 }), dec(2, 'S1', { createdAt: null }), dec(1, 'S1', { createdAt: T0 + 30 }), dec(4, 'S1', { createdAt: T0 - DAY })],
  }));
  assert.deepEqual(keys(items), ['d4', 'd1', 'd3', 'd2']);
});

// ------------------------------------------------------------------ the real producers: mirror.mjs and plan-tool.mjs

function makeBus() {
  const handlers = new Map();
  return {
    on(channel, fn) {
      handlers.set(channel, [...(handlers.get(channel) ?? []), fn]);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((f) => f !== fn));
    },
    emit(channel, data) { for (const fn of [...(handlers.get(channel) ?? [])]) fn(data); },
  };
}

function tempState(t, prefix) {
  const dir = realFs.mkdtempSync(join(tmpdir(), prefix));
  t.after(() => realFs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mirrorSetup(t, { sid = 'sess-A' } = {}) {
  const root = join(tempState(t, 'omo-waiting-mirror-'), 'state');
  const faults = { decisions: false };
  const fs = {
    ...realFs,
    writeFileSync(f, d, o) {
      if (faults.decisions && /[\\/]decisions[\\/]\d+\.json$/.test(String(f))) throw Object.assign(new Error('EPERM: injected'), { code: 'EPERM' });
      return realFs.writeFileSync(f, d, o);
    },
  };
  const store = openStore(root, { fs, sleep: () => {} });
  let clock = T0;
  const meta = { sessionId: sid, cwd: 'C:/work/proj', title: '미러 대화', lastActivityAt: T0 };
  store.replace(`sessions/${sid}/meta.json`, meta);
  const bus = makeBus();
  const mirror = createMirror({
    pi: { events: bus }, store, stateDir: root, getSessionId: () => sid, getMeta: () => meta,
    saveMeta: () => store.replace(`sessions/${sid}/meta.json`, meta), refresh: () => ({ ok: true }),
    enabled: () => store.readSettings().enabled !== false, now: () => (clock += 1000), env: { HERDR_PANE_ID: 'pane-7' }, fs,
  });
  t.after(() => mirror.dispose());
  const { ctx } = makeCtx({ sid, file: `C:/sessions/${sid}.jsonl` });
  const ask = (request) => bus.emit('ask-user:asked', { ...clone(FIX.asked), ctx, request });
  const close = (requestId, status) => bus.emit('ask-user:closed', { requestId, status });
  return { root, store, mirror, ctx, ask, close, faults, items: () => waitingItems(store.readSnapshot()) };
}

const twoQuestions = (requestId) => ({
  ...clone(FIX.asked.request), requestId, required: true,
  questions: [clone(FIX.asked.request.questions[0]), { ...clone(FIX.asked.request.questions[0]), id: 'q2', question: '둘째로 무엇을 할까요?' }],
});

test('real mirror: an open question, its timeout into two decision cards and their answers keep one q<sid>:<requestId> item', async (t) => {
  const s = mirrorSetup(t);
  await s.mirror.attach(s.ctx);
  s.ask(twoQuestions('toolu_live'));
  const asked = s.items();
  assert.deepEqual(asked.map(({ key, sessionId, title, text, blocks }) => ({ key, sessionId, title, text, blocks })), [
    { key: 'qsess-A:toolu_live', sessionId: 'sess-A', title: '미러 대화', text: '어느 방향으로 진행할까요?', blocks: true },
  ]);

  s.close('toolu_live', 'timed_out');
  const snapshot = s.store.readSnapshot();
  assert.equal(snapshot.decisions.length, 2, 'mirror.mjs turned both questions into decision cards');
  assert.ok(snapshot.decisions.every((d) => d.source === 'question-timeout' && d.requestId === 'toolu_live'));
  const converted = waitingItems(snapshot);
  assert.deepEqual(keys(converted), ['qsess-A:toolu_live'], 'same identity: the alarm does not ring again');
  assert.equal(converted[0].blocks, true);

  for (const d of snapshot.decisions) s.store.writeNew(`answers/${pad6(d.id)}.json`, { id: d.id, option: 'A', at: T0 });
  assert.deepEqual(s.items(), [], 'answered cards leave the waiting list');
});

test('real mirror: a conversion that could not be written yet (unconverted) and its later retry keep the same key', async (t) => {
  const s = mirrorSetup(t);
  await s.mirror.attach(s.ctx);
  s.ask({ ...clone(FIX.asked.request), requestId: 'toolu_owed' });
  assert.deepEqual(keys(s.items()), ['qsess-A:toolu_owed']);

  s.faults.decisions = true;
  s.close('toolu_owed', 'timed_out');
  const owedSnap = s.store.readSnapshot();
  assert.equal(owedSnap.decisions.length, 0, 'decision write failed');
  assert.equal(owedSnap.mirror[0].data.unconverted.length, 1, 'mirror keeps the owed conversion');
  assert.deepEqual(keys(waitingItems(owedSnap)), ['qsess-A:toolu_owed']);

  s.faults.decisions = false;
  s.ask({ ...clone(FIX.asked.request), requestId: 'toolu_next' }); // any mirror activity retries what is owed
  const after = s.store.readSnapshot();
  assert.equal(after.decisions.length, 1, 'retry wrote the card');
  assert.deepEqual(keys(waitingItems(after)).sort(), ['qsess-A:toolu_next', 'qsess-A:toolu_owed']);
});

const PLAN_TEXT = ['# plan', '- [ ] 1. 첫째', '  Parallelization: Wave 1 | Blocked by: 없음 | Blocks: 없음', ''].join('\n');

function planSetup(t) {
  const dir = tempState(t, 'omo-waiting-plan-');
  const proj = join(dir, 'proj');
  const stateDir = join(dir, 'state');
  realFs.mkdirSync(join(proj, '.omo', 'plans'), { recursive: true });
  const planPath = norm(join(proj, '.omo', 'plans', 'demo.md'));
  realFs.writeFileSync(planPath, PLAN_TEXT);
  const store = openStore(stateDir, { sleep: () => {} });
  let clock = T0;
  const tool = (sid, title) => {
    const meta = { sessionId: sid, cwd: proj, title, errors: {}, lastActivityAt: T0 };
    store.replace(`sessions/${sid}/meta.json`, meta);
    const problems = [];
    t.after(() => assert.deepEqual(problems, [], `no plan-tool errors for ${sid}`));
    return createPlanTool({
      store, sessionId: sid, cwd: proj, isEnabled: () => true, publish: async () => ({ ok: true, seqs: [] }),
      onError: (key, err) => problems.push(`${key}: ${err.message}`), onRecover: () => {}, now: () => (clock += 1000),
      getMeta: () => meta, saveMeta: (m) => store.replace(`sessions/${sid}/meta.json`, m), pageUrl: 'C:/state/index.html',
    });
  };
  const plan = (questions) => ({
    planPath, stage: 'gate', stageNote: '', goal: '목표', ideal: [{ id: 'IS-1', text: '이상' }], components: [], waves: [{ n: 1, label: '기초' }],
    tasks: [{ id: '1', wave: 1, label: '첫째', what: '무엇', done: '끝', deps: [] }], questions, outOfScope: [],
  });
  return { store, tool, plan, planId: planIdOf(rootAndSlugOf(planPath).root, 'demo'), items: () => waitingItems(store.readSnapshot()) };
}

const openQ = (id, over = {}) => ({ id, text: `질문 ${id}?`, state: 'open', options: OPTS, recommend: 'A', reason: '이유', blocks: false, ...over });

test('real plan_brief: an open plan question is p<planId>:<qid> and keeps that key when another session takes the plan over', async (t) => {
  const s = planSetup(t);
  const a = s.tool('sess-A', '계획 세우는 대화');
  const res = await a.execute(s.plan([openQ('Q1', { blocks: true })]));
  assert.equal(res.details.created.length, 1);
  const key = `p${s.planId}:Q1`;
  assert.deepEqual(s.items().map(({ key: k, sessionId, title, text, blocks }) => ({ key: k, sessionId, title, text, blocks })), [
    { key, sessionId: 'sess-A', title: '계획 세우는 대화', text: '질문 Q1?', blocks: true },
  ]);

  const b = s.tool('sess-B', '이어받은 대화');
  const taken = await b.execute(s.plan([openQ('Q1', { blocks: true })]));
  assert.deepEqual(taken.details.closed, res.details.created, 'old decision closed as superseded');
  assert.equal(taken.details.created.length, 1, 'a new decision for the new owner');
  assert.deepEqual(s.items().map((i) => [i.key, i.sessionId]), [[key, 'sess-B']], 'same key: no second alarm');

  await b.execute(s.plan([{ id: 'Q1', text: '질문 Q1?', state: 'answered', answer: 'A안', by: 'owner' }]));
  assert.deepEqual(s.items(), [], 'answered in the plan: closed and gone');
});
