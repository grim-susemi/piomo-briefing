import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createBriefingExtension } from '../extension.mjs';
import { createDeliverer } from '../src/deliver.mjs';
import { applyBoardAnswer } from '../src/decide.mjs';
import { createBoardServer } from '../src/server.mjs';
import { buildViewModel } from '../src/render.mjs';
import { openStore } from '../src/store.mjs';
import { makeFakePi, makeCtx } from './helpers/fake-pi.mjs';

console.log(`decision-hold test PID ${process.pid}`);
const decision = (over = {}) => ({
  question: '어느 쪽?', options: { A: { text: '가', consequence: '빠름' }, B: { text: '나', consequence: '안전' } },
  recommend: 'A', reason: '이유', blocks: true, ...over,
});
const brief = (decisions = []) => ({
  title: '작업', headline: '진행 중', status: 'in_progress', next: '', changes: [], done: [], decisions,
});

async function setup(t, { watch = false } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'omo-hold-'));
  const store = openStore(dir);
  const fake = makeFakePi();
  const bus = new Map();
  fake.pi.events = {
    on(name, handler) { bus.set(name, handler); return () => bus.delete(name); },
  };
  const deliveries = [];
  fake.pi.session = {
    admitExternalMessage(msg) { deliveries.push(msg); return { kind: 'queued' }; },
    listAdmittedDeliveries() { return { emitted: [], pending: deliveries.map((d) => d.delivery_id) }; },
  };
  const { ctx } = makeCtx();
  let clock = 1000;
  let hooks, deliverer;
  createBriefingExtension({
    stateDir: dir, server: true, env: { OMO_BRIEFING_PORT_BASE: '48580' }, now: () => ++clock,
    renderOpts: { sleep: () => {} },
    openPage: () => ({}),
    timers: {
      setTimeout: () => ({ unref() {} }), clearTimeout() {},
      setInterval: () => ({ unref() {} }), clearInterval() {},
    },
    createWorkersLive: () => ({ start() {}, stop() {}, snapshot: () => null }),
    createDeliverer: (deps) => (deliverer = createDeliverer({ ...deps, watch })),
    createServerHost: (o) => {
      hooks = o;
      return { ensure: async () => null, status: () => ({ role: 'idle' }), notifyPublished() {}, release: async () => {} };
    },
  })(fake.pi);
  await fake.emit('session_start', { reason: 'startup' }, ctx);
  t.after(async () => {
    await fake.emit('session_shutdown', {}, ctx);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const model = () => buildViewModel(store.readSnapshot(), clock);
  return {
    dir, store, ctx, fake, deliveries, model,
    brief: (ds = []) => fake.tool('brief').execute('id', brief(ds), undefined, undefined, ctx),
    input: () => fake.emit('input', { source: 'interactive' }, ctx),
    asked: () => bus.get('ask-user:asked')({
      ctx, request: { requestId: 'r1', questions: [{ id: 'q1', question: '어느 쪽?', options: [{ label: '가' }, { label: '나' }] }] },
    }),
    closed: () => bus.get('ask-user:closed')({ requestId: 'r1', status: 'answered' }),
    answer: (body) => hooks.answer(body),
    wake: () => deliverer.wake(ctx, 'agent_settled'),
  };
}

test('question open closes only this turn’s open decisions; brief refuses new open questions but accepts answered history', async (t) => {
  const s = await setup(t);
  await s.brief([decision()]);
  await s.input();
  await s.brief([decision(), decision()]);
  s.store.allocDecisionId({ sessionId: 'other', createdAt: 99999, ...decision() });
  await s.answer({ id: 3, sessionId: 'sess-A', option: 'A' });
  s.asked();
  const snap = s.store.readSnapshot();
  assert.deepEqual(snap.closures.map((c) => [c.id, c.reason, c.questionPrompt]), [[2, 'superseded', true]]);
  assert.equal(snap.answers.length, 1);
  await assert.rejects(s.brief([decision()]), /질문창이 열려 있음: 결정은 답을 받은 뒤 answered로 넣기/);
  await s.brief([decision({ id: 1 })]); // existing board question may remain
  await s.brief([decision({ state: 'answered', answer: '가' })]);
  assert.equal(s.store.readSnapshot().decisions.length, 5);
  const recorded = s.model().sessions[0].decisions.find((d) => d.id === 5);
  assert.equal(recorded.answered, true);
  assert.equal(recorded.closed, true);
  assert.equal(s.model().waiting.some((w) => w.key === 'd2' || w.key === 'd5'), false);
  s.closed();
  await s.brief([decision()]);
});

test('guarded hold route removes waiting, records notices for all owners, and reopens', async (t) => {
  const s = await setup(t);
  await s.brief([decision(), decision()]);
  s.store.allocDecisionId({ sessionId: 'closed', createdAt: 1001, ...decision() });
  s.store.replace('sessions/closed/meta.json', { sessionId: 'closed', lastActivityAt: 1001, title: '닫힘' });
  const server = createBoardServer({
    portBase: Number(process.env.OMO_BRIEFING_PORT_BASE || 48580), portCount: 10,
    token: 'hold-token', getPage: () => '', getViewModel: s.model, onAnswer: s.answer,
  });
  const { port } = await server.start();
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${port}`;
  const post = async (body, headers = {}) => {
    const response = await fetch(origin + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: origin, 'X-Board-Token': 'hold-token', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  const hold = { id: 1, sessionId: 'sess-A', action: 'hold' };
  assert.equal((await post(hold, { 'X-Board-Token': '' })).status, 403);
  assert.equal((await post(hold, { Origin: 'http://elsewhere.invalid' })).status, 403);
  assert.equal(s.store.readSnapshot().closures.length, 0);
  assert.equal((await post({ ...hold, option: 'A' })).status, 400);
  const before = s.model().waiting.length;
  assert.equal((await post(hold)).status, 200);
  assert.equal(s.model().waiting.length, before - 1);
  assert.equal(s.model().summary.openDecisions, 2);
  const heldAt = s.store.readRecord('decision-closures/000001.json').at;
  assert.deepEqual(s.model().sessions.find((x) => x.id === 'sess-A').decisions[0].held, { at: heldAt }, 'C-HOLD 4: held = {at}');
  assert.equal(s.model().sessions.find((x) => x.id === 'sess-A').heldCount, 1);
  await s.wake();
  await s.wake();
  assert.equal(s.deliveries.length, 1);
  // todo 12: the one hold message uses the C-HOLD wording (part A's shorter text is replaced)
  assert.equal(s.deliveries[0].text, '[결정 보류] #1 - 소유자가 이 질문에 답하지 않기로 했어요. 다시 묻지 말고, 기본값이나 추천안으로 진행하지도 마세요. 이 결정에 막힌 일은 막힌 채로 두고 다른 일을 하세요.');
  assert.equal((await post(hold)).status, 409);
  await s.wake();
  assert.equal(s.deliveries.length, 1);
  assert.equal((await post({ id: 3, sessionId: 'closed', action: 'hold' })).status, 200);
  assert.equal(fs.readdirSync(join(s.dir, 'hold-notices')).length, 2, 'closed owners retain an owed notice for resume');
  assert.equal((await post({ ...hold, action: 'reopen' })).status, 200);
  assert.equal(s.store.readRecord('decision-closures/000001.json'), null);
  assert.deepEqual(s.store.readRecord('decision-closures/000001.1.released.json'), { id: 1, reason: 'held', at: heldAt, notice: s.store.readRecord('decision-closures/000001.1.released.json').notice }, 'reopen renames the record');
  assert.ok(s.model().waiting.some((w) => w.sessionId === 'sess-A'));
  assert.equal('heldCount' in s.model().sessions.find((x) => x.id === 'sess-A'), false);
  assert.equal((await post({ id: 1, sessionId: 'sess-A', option: 'B' })).status, 200);
  assert.equal((await post({ ...hold, action: 'reopen' })).status, 409);
});

for (const { live, reopen } of [
  { live: false, reopen: false },
  { live: false, reopen: true },
  { live: true, reopen: false },
]) {
  test(`hold writer/deliverer: ${live ? 'live' : 'closed'} owner${reopen ? ', reopened before resume' : ''} receives ${reopen ? 0 : 1} message across restarts`, async (t) => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'omo-hold-resume-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = openStore(dir);
    const sid = 'owner';
    const meta = { sessionId: sid, ...(live ? { hostPid: process.pid } : {}) };
    store.replace(`sessions/${sid}/meta.json`, meta);
    const id = store.allocDecisionId({ sessionId: sid, createdAt: 1000, ...decision() });
    const request = { id, sessionId: sid, action: 'hold' };
    assert.deepEqual(applyBoardAnswer(store, request, 1001), { ok: true, id });
    const names = fs.readdirSync(join(dir, 'hold-notices'));
    assert.equal(names.length, 1, 'every hold persists an owed notice, even with a closed owner');
    const noticeRel = `hold-notices/${names[0]}`;
    assert.equal(store.readRecord(`decision-closures/${String(id).padStart(6, '0')}.json`).notice, names[0].slice(0, -5));
    const deliveries = [];
    const session = {
      admitExternalMessage(msg) { deliveries.push(msg); return { kind: 'queued' }; },
      listAdmittedDeliveries() { return { emitted: [], pending: deliveries.map((msg) => msg.delivery_id) }; },
    };
    const { ctx } = makeCtx({ sid });
    const wake = async (reason) => {
      const deliverer = createDeliverer({
        pi: { session }, store, getSessionId: () => sid,
        getMeta: () => store.readRecord(`sessions/${sid}/meta.json`),
        saveMeta: () => {}, refresh: () => {}, enabled: () => true, now: () => 1004, watch: false,
      });
      try { await deliverer.wake(ctx, reason); } finally { await deliverer.dispose(); }
    };
    if (live) {
      await wake('agent_settled');
      assert.equal(deliveries.length, 1, 'live owners receive the notice immediately');
    }
    if (reopen) assert.deepEqual(applyBoardAnswer(store, { ...request, action: 'reopen' }, 1002), { ok: true, id });
    store.replace(`sessions/${sid}/meta.json`, { ...meta, hostPid: process.pid });
    await wake('session_start');
    await wake('agent_settled');
    assert.equal(deliveries.length, reopen ? 0 : 1, 'resume and restarts cannot duplicate or resurrect a notice');
    if (reopen) {
      assert.equal(store.readRecord(noticeRel).superseded, true);
    } else {
      assert.match(deliveries[0].text, /^\[결정 보류\]/);
      session.listAdmittedDeliveries = () => ({ emitted: [deliveries[0].delivery_id], pending: [] });
      await wake('agent_settled');
      assert.equal(store.readRecord(noticeRel).delivered, true, 'persisted host proof completes delivery');
      session.listAdmittedDeliveries = () => ({ emitted: [], pending: [] });
      await wake('session_start');
      assert.equal(deliveries.length, 1, 'persisted delivery proof survives another restart');
    }
  });
}

test('failure: a board answer on a held decision gets 409 HELD through the real HTTP route and writes no answer', async (t) => {
  const s = await setup(t);
  await s.brief([decision()]);
  const server = createBoardServer({
    // its own 10 ports above the shared base: test/extension.test.mjs runs a real board on the base range in a parallel process
    portBase: Number(process.env.OMO_BRIEFING_PORT_BASE || 48580) + 30, portCount: 10,
    token: 'held-token', getPage: () => '', getViewModel: s.model, onAnswer: s.answer,
  });
  const { port } = await server.start();
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${port}`;
  const post = async (body) => {
    const response = await fetch(origin + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: origin, 'X-Board-Token': 'held-token' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  assert.equal((await post({ id: 1, sessionId: 'sess-A', action: 'hold' })).status, 200);
  const held = await post({ id: 1, sessionId: 'sess-A', option: 'A' });
  console.log(`failure: board answer while held -> ${held.status} ${JSON.stringify(held.json)}, answers/000001.json ${JSON.stringify(s.store.readRecord('answers/000001.json'))}`);
  assert.deepEqual(held, { status: 409, json: { ok: false, code: 'HELD' } });
  assert.equal(s.store.readRecord('answers/000001.json'), null, 'no answer file is written');
  assert.equal((await post({ id: 1, sessionId: 'sess-A', action: 'reopen' })).status, 200);
  assert.deepEqual(await post({ id: 1, sessionId: 'sess-A', option: 'A' }), { status: 200, json: { ok: true, id: 1 } }, 'reopened: the board answer goes through');
});

test('hold uses distinct notice ids after reopen and waits until an idle turn', async (t) => {
  const s = await setup(t);
  await s.brief([decision()]);
  s.ctx.isIdle = () => false;
  assert.equal((await s.answer({ id: 1, sessionId: 'sess-A', action: 'hold' })).status, 200);
  // A regular wake must not splice a hold into a running turn.
  await s.fake.emit('input', { source: 'extension' }, s.ctx);
  assert.equal(s.deliveries.length, 0);
  await s.wake();
  assert.equal(s.deliveries.length, 1);
  await s.answer({ id: 1, sessionId: 'sess-A', action: 'reopen' });
  await s.answer({ id: 1, sessionId: 'sess-A', action: 'hold' });
  await s.wake();
  assert.equal(s.deliveries.length, 2);
  assert.notEqual(s.deliveries[0].delivery_id, s.deliveries[1].delivery_id);
});

test('hold admission retries a failed write, then stops on persisted proof; fallback sends once', async (t) => {
  const s = await setup(t);
  await s.brief([decision(), decision()]);
  await s.answer({ id: 1, sessionId: 'sess-A', action: 'hold' });
  await s.wake();
  const first = s.deliveries[0].delivery_id;
  s.fake.pi.session.listAdmittedDeliveries = () => ({ emitted: [], pending: [], failed: [{ delivery_id: first }] });
  await s.wake();
  assert.equal(s.deliveries.length, 2, 'the failed admission is retried, not silently lost');
  s.fake.pi.session.listAdmittedDeliveries = () => ({ emitted: [first], pending: [] });
  await s.wake();
  await s.wake();
  assert.equal(s.deliveries.length, 2);
  assert.equal(s.store.readRecord(`hold-notices/${first.slice(5)}.json`).delivered, true);
  delete s.fake.pi.session;
  const messages = [];
  s.fake.pi.sendUserMessage = (text) => messages.push(text);
  await s.answer({ id: 2, sessionId: 'sess-A', action: 'hold' });
  await s.wake();
  await s.wake();
  assert.equal(messages.length, 1);
});

test('a live idle owner receives the hold from its notice watcher, with no manual wake', { timeout: 5000 }, async (t) => {
  const s = await setup(t, { watch: true });
  await s.brief([decision()]);
  const admitted = Promise.withResolvers();
  const original = s.fake.pi.session.admitExternalMessage;
  s.fake.pi.session.admitExternalMessage = (msg) => { const result = original(msg); admitted.resolve(msg); return result; };
  await s.answer({ id: 1, sessionId: 'sess-A', action: 'hold' });
  const msg = await admitted.promise;
  assert.match(msg.delivery_id, /^hold-/);
  assert.equal(s.deliveries.length, 1);
});

test('the HTTP view exposes hold and a collapsed held group; file view is read-only', async () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(new URL('../src/page/view.js', import.meta.url), 'utf8'), context);
  const model = { sessions: [{
    id: 's', title: '작업', project: 'p', status: 'in_progress', answerKinds: ['text'],
    decisions: [{ id: 1, ...decision() }, { id: 2, ...decision(), closed: true, held: true }],
  }] };
  const render = (live) => context.BriefView.renderOverview(model, { live, tab: 'wait' });
  const live = render(true);
  assert.match(live, /data-act="ans-hold"/);
  assert.match(live, /<details class="held-decs" data-open-key="cv:s:held"><summary>보류됨 1개/);
  assert.match(live, /data-act="ans-reopen"/);
  assert.doesNotMatch(render(false), /data-act="ans-(?:hold|reopen)"/);
});
