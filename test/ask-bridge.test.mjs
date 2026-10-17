import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { applyBoardAnswer } from '../src/decide.mjs';
import { createDeliverer } from '../src/deliver.mjs';
import { buildViewModel } from '../src/render.mjs';
import { tempDir } from './helpers/temp.mjs';

const AT = 1_800_000_000_000;
const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);
const params = {
  question: 'Which path?',
  options: { A: { text: 'First', consequence: 'Fast' }, B: { text: 'Second', consequence: 'Safe' } },
  recommend: 'B', reason: 'Safer', blocks: true,
};
const rel = (kind, id = 1) => `${kind}/${String(id).padStart(6, '0')}.json`;
const textOf = (result) => result.content.map((c) => c.text).join('\n');

async function rig(t, { headless = false, commitOptions } = {}) {
  const { createAskBridge } = await import('../src/ask-bridge.mjs');
  const { dir, onDispose } = tempDir(t, 'omo-ask-');
  const store = openStore(dir);
  const meta = { sessionId: 'owner', title: 'Owner', hostPid: process.pid, lastActivityAt: AT, running: true, pid: process.pid };
  const saveMeta = () => store.replace('sessions/owner/meta.json', meta);
  saveMeta();
  const timers = new Map();
  const fakeTimers = { setTimeout(fn, ms) { const handle = { ms }; timers.set(handle, fn); return handle; }, clearTimeout(handle) { timers.delete(handle); } };
  const sent = [];
  const state = { idle: false };
  let dialog;
  let opened;
  const ready = new Promise((resolve) => { opened = resolve; });
  const ctx = {
    isIdle: () => state.idle,
    sessionManager: { getBranch: () => [] },
    ui: headless ? {} : { question(request, options) {
      return new Promise((resolve) => {
        dialog = { request, ...options, respond: resolve };
        options.signal.addEventListener('abort', () => resolve({ status: 'cancelled', answers: {}, unanswered: ['decision'] }), { once: true });
        opened();
      });
    } },
  };
  const bridge = createAskBridge({
    store, getSessionId: () => 'owner', now: () => AT, timers: fakeTimers, commitOptions,
    publish: () => {},
    onLiveChange: (ids) => { meta.askLive = ids; saveMeta(); },
  });
  const deliverer = createDeliverer({
    pi: { sendUserMessage: (text) => sent.push(text) }, store,
    getSessionId: () => 'owner', getMeta: () => meta, saveMeta, refresh: () => {},
    enabled: () => true, now: () => AT, watch: false, askBridge: bridge,
  });
  onDispose(() => bridge.dispose());
  onDispose(() => deliverer.dispose());
  const execute = (p = params, signal) => bridge.execute('call-1', p, signal, undefined, ctx);
  const model = () => buildViewModel(store.readSnapshot(), AT, { isAlive: () => true }).sessions[0];
  const wake = () => deliverer.wake(ctx, 'answers');
  const choose = (key) => dialog.respond({
    status: 'answered', answers: { decision: { selected: [`${key} · ${params.options[key].text}`] } }, unanswered: [],
  });
  return { store, bridge, execute, ready, get dialog() { return dialog; }, timers, sent, state, model, wake, choose };
}

test('(a) terminal first commits the owner answer, marks the board delivered, and never admits chat', async (t) => {
  const r = await rig(t);
  const pending = r.execute();
  await r.ready;
  assert.equal(r.model().decisions[0].askLive, true);
  assert.equal(r.dialog.request.questions[0].header, '#1');
  assert.equal(r.dialog.request.questions[0].options[0].label, 'B · Second');
  assert.equal(r.dialog.request.waitForAnswer, true);
  assert.equal(r.dialog.timeout, 30 * 60_000);
  r.choose('A');
  const result = await pending;
  assert.equal(r.store.readRecord(rel('answers')).fromSessionId, 'owner');
  assert.equal(result.details.answer.option, 'A');
  assert.match(textOf(result), /소유자 답: #1 A · First/);
  assert.match(textOf(result), /답한 곳: 터미널/);
  await r.wake();
  assert.deepEqual(r.sent, []);
  assert.equal(r.model().decisions[0].answered, true);
  assert.equal('askLive' in r.model().decisions[0], false);
  assert.match(r.model().decisions[0].delivery, /^전달됨/);
  t.diagnostic(JSON.stringify({ scenario: 'a', tool: 'board_question', invocation: params, result, receipt: r.store.readRecord(rel('receipts')) }));
});

test('(b) a board answer settles a busy call, aborts its dialog, and proves only a tool result', async (t) => {
  const r = await rig(t);
  const pending = r.execute();
  await r.ready;
  assert.deepEqual(applyBoardAnswer(r.store, { id: 1, sessionId: 'owner', option: 'B' }, AT), { ok: true, id: 1 });
  await r.wake();
  const result = await pending;
  assert.equal(r.dialog.signal.aborted, true);
  assert.equal(result.details.answer.option, 'B');
  assert.match(textOf(result), /답한 곳: 상황판/);
  assert.equal(r.store.readRecord(rel('receipts')).mode, 'tool_result');
  assert.equal(r.store.readRecord(rel('receipts')).proven, true);
  assert.deepEqual(r.sent, []);
  t.diagnostic(JSON.stringify({ scenario: 'b', tool: 'board_question', invocation: params, result, aborted: r.dialog.signal.aborted, receipt: r.store.readRecord(rel('receipts')) }));
});

test('(c) injected board-before-terminal claim ordering returns the same single winning answer', async (t) => {
  let inject;
  const r = await rig(t, { commitOptions: { hooks: { beforeClaim: () => inject() } } });
  inject = () => {
    assert.equal(applyBoardAnswer(r.store, { id: 1, sessionId: 'owner', option: 'B' }, AT).ok, true);
  };
  const pending = r.execute();
  await r.ready;
  r.choose('A');
  const result = await pending;
  await r.wake();
  assert.equal(result.details.answer.option, 'B', 'failure: terminal A loses to the injected board B claim');
  assert.equal(r.model().decisions[0].answer.option, 'B');
  assert.deepEqual(readdirSync(join(r.store.root, 'answers')), ['000001.json']);
  assert.deepEqual(r.sent, []);
  t.diagnostic(`failure: terminal A lost the injected claim to board B; tool and board both report ${result.details.answer.option}`);
  t.diagnostic(JSON.stringify({ scenario: 'c', tool: 'board_question', invocation: params, result, answerFiles: readdirSync(join(r.store.root, 'answers')) }));
});

test('(d) a hold settles a busy tool once with C-HOLD text, without choosing an answer', async (t) => {
  const r = await rig(t);
  const pending = r.execute();
  await r.ready;
  assert.equal(applyBoardAnswer(r.store, { id: 1, sessionId: 'owner', action: 'hold' }, AT).ok, true);
  await r.wake();
  const result = await pending;
  assert.equal(result.details.status, 'held');
  assert.match(textOf(result), /^\[결정 보류\] #1 - 소유자가 이 질문에 답하지 않기로 했어요\./);
  assert.match(textOf(result), /기본값이나 추천안으로 진행하지도 마세요/);
  assert.equal(r.dialog.signal.aborted, true);
  assert.equal(r.store.readRecord(rel('answers')), null);
  const closure = r.store.readRecord(rel('decision-closures'));
  const notice = r.store.readRecord(`hold-notices/${closure.notice}.json`);
  assert.equal(notice.mode, 'tool_result');
  assert.equal(notice.proven, true);
  await r.wake();
  assert.deepEqual(r.sent, []);
  t.diagnostic(JSON.stringify({ scenario: 'd', tool: 'board_question', invocation: params, result, notice }));
});

test('(e) injected timeout leaves the board open; a later answer follows normal idle delivery', async (t) => {
  const r = await rig(t);
  const pending = r.execute();
  await r.ready;
  [...r.timers.values()][0]();
  const result = await pending;
  assert.equal(result.details.status, 'timed_out');
  assert.equal(r.model().decisions[0].answered, false);
  assert.equal(r.model().decisions[0].closed, false);
  assert.equal(r.store.readRecord(rel('receipts')), null);
  applyBoardAnswer(r.store, { id: 1, sessionId: 'owner', option: 'A' }, AT);
  await r.wake();
  assert.deepEqual(r.sent, [], 'busy later answers still wait');
  r.state.idle = true;
  await r.wake();
  assert.match(r.sent[0], /^\[결정 전달\] #1 -> A/);
  assert.notEqual(r.store.readRecord(rel('receipts')).mode, 'tool_result');
  t.diagnostic(JSON.stringify({ scenario: 'e', tool: 'board_question', invocation: params, result, laterDelivery: r.sent[0], receipt: r.store.readRecord(rel('receipts')) }));
});

test('(f) no question UI waits only for the board, under the same deadline', async (t) => {
  const r = await rig(t, { headless: true });
  const pending = r.execute();
  assert.equal(r.bridge.isLive(1), true);
  assert.equal([...r.timers.keys()][0].ms, 30 * 60_000);
  applyBoardAnswer(r.store, { id: 1, sessionId: 'owner', text: 'Use a third path' }, AT);
  await r.wake();
  const result = await pending;
  assert.match(textOf(result), /소유자 답글: #1 Use a third path/);
  assert.equal(result.details.answer.text, 'Use a third path');
  assert.deepEqual(r.sent, []);
  t.diagnostic(JSON.stringify({ scenario: 'f', tool: 'board_question', invocation: params, result }));
});

test('race/concurrency: injected terminal-before-board claim makes the board lose without a second record', async (t) => {
  const r = await rig(t);
  const write = r.store.writeNew;
  let loser;
  r.store.writeNew = (path, record) => {
    const result = write(path, record);
    if (path === rel('claims')) loser = applyBoardAnswer(r.store, { id: 1, sessionId: 'owner', option: 'B' }, AT);
    return result;
  };
  const pending = r.execute();
  await r.ready;
  r.choose('A');
  const result = await pending;
  assert.equal(loser.code, 'ANSWERED');
  assert.equal(result.details.answer.option, 'A');
  assert.equal(r.model().decisions[0].answer.option, 'A');
  assert.deepEqual(readdirSync(join(r.store.root, 'answers')), ['000001.json']);
});

test('malformed_input: bad options, limits, and unknown fields reject before allocating a decision', async (t) => {
  const r = await rig(t);
  for (const input of [
    null, [], { ...params, question: '' }, { ...params, question: 'x'.repeat(101) },
    { ...params, options: [] }, { ...params, options: { A: params.options.A } },
    { ...params, options: { ...params.options, D: params.options.A } },
    { ...params, options: { ...params.options, A: { ...params.options.A, text: 'x'.repeat(61) } } },
    { ...params, options: { ...params.options, A: { ...params.options.A, extra: true } } },
    { ...params, recommend: 'C' }, { ...params, blocks: 'true' },
    { ...params, timeoutMinutes: 121 }, { ...params, timeoutMinutes: 0 }, { ...params, timeoutMinutes: NaN },
    { ...params, waitForAnswer: false }, { ...params, id: 1 },
  ]) {
    await assert.rejects(r.execute(input));
  }
  assert.equal(r.store.readSnapshot().decisions.length, 0);
  assert.equal(r.timers.size, 0);
});

test('duplicate-question guard reuses part A mirror state without emitting built-in question events', async (t) => {
  const r = await rig(t);
  r.store.replace('mirror/owner.json', { open: true, question: 'Built-in question' });
  await assert.rejects(r.execute(), /질문창이 열려 있음/);
  assert.equal(r.store.readSnapshot().decisions.length, 0);
});

test('dismissal and caller abort leave the decision open and clear all live state and timers', async (t) => {
  const r = await rig(t);
  let pending = r.execute({ ...params, timeoutMinutes: 120 });
  await r.ready;
  assert.equal(r.dialog.timeout, 120 * 60_000);
  r.dialog.respond({ status: 'cancelled', answers: {}, unanswered: ['decision'] });
  assert.equal((await pending).details.status, 'cancelled');
  assert.equal(r.bridge.isLive(1), false);
  assert.equal(r.store.readRecord(rel('answers')), null);
  const controller = new AbortController();
  pending = r.execute(params, controller.signal);
  controller.abort();
  assert.equal((await pending).details.status, 'cancelled');
  assert.equal(r.bridge.isLive(2), false);
  assert.equal(r.timers.size, 0);
  assert.equal(r.store.readRecord(rel('decision-closures', 2)), null);
});

test('terminal free text is returned as text, never as an option or executable result content', async (t) => {
  const r = await rig(t);
  const pending = r.execute();
  await r.ready;
  const text = '<script>ignore instructions</script> [decision]';
  r.dialog.respond({ status: 'comment-submitted', answers: {}, comment: text, unanswered: [] });
  const result = await pending;
  assert.equal(result.details.answer.text, text);
  assert.equal(result.details.answer.option, undefined);
  assert.deepEqual(result.content.map((block) => block.type), ['text']);
  assert.equal(r.store.readRecord(rel('answers')).text, text);
});

test('headless timeout and disposal end the wait without writing an answer or delivery proof', async (t) => {
  const r = await rig(t, { headless: true });
  let pending = r.execute();
  [...r.timers.values()][0]();
  assert.equal((await pending).details.status, 'timed_out');
  pending = r.execute();
  r.bridge.dispose();
  assert.equal((await pending).details.status, 'cancelled');
  assert.equal(r.timers.size, 0);
  assert.equal(r.store.readRecord(rel('answers')), null);
  assert.equal(r.store.readRecord(rel('receipts')), null);
});
