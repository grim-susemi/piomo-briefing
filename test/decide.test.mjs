import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store.mjs';
import { parseDecide, applyDecide, applyBoardAnswer, applyAskAnswer, applyBoardAnnotation, formatDecideResult } from '../src/decide.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CHILD = join(HERE, 'helpers', 'decide-child.mjs');
const PAUSED_B = join(HERE, 'helpers', 'decide-paused-b.mjs');
const BOARD_CHILD = join(HERE, 'helpers', 'board-answer-child.mjs');
const DEAD_PID = 2147480000;
const NOTE_ID = '01234567-89ab-4cde-8fab-0123456789ab';

const tmpRoot = () => fs.mkdtempSync(join(tmpdir(), 'omo-decide-test-'));
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const pad6 = (n) => String(n).padStart(6, '0');
const ls = (root, rel) => {
  try { return fs.readdirSync(join(root, rel)); } catch (e) { return e.code === 'ENOENT' ? [] : (() => { throw e; })(); }
};
const read = (root, rel) => JSON.parse(fs.readFileSync(join(root, rel), 'utf8'));

function seed(root, defs) {
  // defs: [{id, recommend?, options?, blocks?, closed?, answered?}]
  const store = openStore(root);
  for (const d of defs) {
    const id = d.id;
    store.writeNew(`decisions/${pad6(id)}.json`, {
      id, sessionId: 's1', question: `q${id}?`,
      options: d.options ?? { A: { text: 'a', consequence: 'ca' }, B: { text: 'b', consequence: 'cb' } },
      recommend: d.recommend ?? 'A', reason: 'r', blocks: d.blocks ?? false, createdAt: 1, source: 'brief',
    });
    if (d.closed) store.writeNew(`decision-closures/${pad6(id)}.json`, { id, reason: 'withdrawn', at: 1 });
    if (d.answered) store.writeNew(`answers/${pad6(id)}.json`, { id, option: d.answered, at: 1, fromSessionId: 's1' });
  }
  return store;
}

test('parse: 12A 13b, bare number, comma separated', () => {
  assert.deepEqual(parseDecide('12A 13b').items.map((i) => [i.id, i.option]), [[12, 'A'], [13, 'B']]);
  assert.deepEqual(parseDecide('12').items, [{ token: '12', id: 12, option: null }]);
  assert.deepEqual(parseDecide('12A,13B').items.map((i) => i.id), [12, 13]);
  assert.equal(parseDecide('12D').items.length, 0);
  assert.equal(parseDecide('12D').invalid.length, 1);
  assert.equal(parseDecide('x').invalid.length, 1);
});

test('ask answer allows only the asking owner and returns the stored winner after a lost claim', (t) => {
  const root = tmpRoot();
  t.after(() => cleanup(root));
  const store = openStore(root);
  const id = store.allocDecisionId({
    sessionId: 's1', source: 'ask', question: 'q', recommend: 'A',
    options: { A: { text: 'a', consequence: 'ca' }, B: { text: 'b', consequence: 'cb' } },
  });
  assert.equal(applyAskAnswer(store, { id, sessionId: 'other', option: 'A' }).code, 'SESSION_MISMATCH');
  assert.equal(applyAskAnswer(store, { id, sessionId: 's1', option: 'C' }).code, 'BAD_OPTION');
  const result = applyAskAnswer(store, { id, sessionId: 's1', option: 'A' }, 1000, {
    hooks: { beforeClaim: () => assert.equal(applyBoardAnswer(store, { id, sessionId: 's1', option: 'B' }, 999).ok, true) },
  });
  assert.equal(result.code, 'ANSWERED');
  assert.equal(result.answer.option, 'B');
  assert.equal(result.answer.fromSessionId, 'board');
  assert.deepEqual(ls(root, 'answers'), ['000001.json']);
});

test('a hold injected between ask validation and claim acquisition excludes the terminal answer', (t) => {
  const root = tmpRoot();
  t.after(() => cleanup(root));
  const store = openStore(root);
  const id = store.allocDecisionId({ sessionId: 's1', source: 'ask', options: { A: { text: 'a' }, B: { text: 'b' } } });
  const result = applyAskAnswer(store, { id, sessionId: 's1', option: 'A' }, 1000, {
    hooks: { beforeClaim: () => assert.equal(applyBoardAnswer(store, { id, sessionId: 's1', action: 'hold' }, 999).ok, true) },
  });
  assert.equal(result.code, 'HELD');
  assert.deepEqual(ls(root, 'answers'), []);
  assert.deepEqual(ls(root, 'claims'), []);
});

// ---- C-HOLD (todo 12): hold, reopen, HELD ----
const askDecision = (store, sessionId = 's1') => store.allocDecisionId({ sessionId, source: 'ask', question: 'q', recommend: 'A', options: { A: { text: 'a' }, B: { text: 'b' } } });
const heldClosure = (root, id) => ls(root, 'decision-closures').includes(`${pad6(id)}.json`);

for (const order of ['hold-first', 'terminal-first']) {
  test(`C-HOLD race (${order}): a terminal board_question answer and a board hold for one id end with exactly one of answers/<id> or holds`, (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const store = openStore(root);
    const id = askDecision(store);
    let hold;
    // forced ordering through the writer's own injection point: the hold runs after the terminal's validation
    // (hold-first: before its claim) or after the terminal's write finished (terminal-first); never timing
    const terminal = applyAskAnswer(store, { id, sessionId: 's1', option: 'A' }, 1000, order === 'hold-first'
      ? { hooks: { beforeClaim: () => { hold = applyBoardAnswer(store, { id, sessionId: 's1', action: 'hold' }, 999); } } } : {});
    if (order === 'terminal-first') hold = applyBoardAnswer(store, { id, sessionId: 's1', action: 'hold' }, 1001);
    const answered = ls(root, 'answers').includes(`${pad6(id)}.json`);
    assert.equal(answered !== heldClosure(root, id), true, `exactly one record (answer ${answered}, hold ${heldClosure(root, id)})`);
    if (order === 'hold-first') {
      assert.deepEqual([hold.ok, terminal.code, answered], [true, 'HELD', false]);
    } else {
      assert.deepEqual([terminal.ok, hold.code, answered], [true, 'ANSWERED', true]);
    }
    // a hold's claim is temporary; an answer keeps its claim for good
    assert.deepEqual(ls(root, 'claims'), answered ? [`${pad6(id)}.json`] : [], 'the hold released its temporary claim');
  });
}

test('C-HOLD reopen renames the held record per cycle, the id is answerable again, and only a held closure reopens', (t) => {
  const root = tmpRoot();
  t.after(() => cleanup(root));
  const store = seed(root, [{ id: 21 }, { id: 22, answered: 'A' }]);
  const act = (id, action) => applyBoardAnswer(store, { id, sessionId: 's1', action }, 2000);
  assert.deepEqual(act(21, 'reopen'), { ok: false, code: 'CLOSED' }, 'nothing to reopen');
  assert.deepEqual(act(21, 'hold'), { ok: true, id: 21 });
  const held = read(root, 'decision-closures/000021.json');
  assert.match(held.notice, /^[0-9a-f-]{36}$/);
  assert.deepEqual(held, { id: 21, reason: 'held', at: 2000, notice: held.notice });
  assert.deepEqual(read(root, `hold-notices/${held.notice}.json`), { id: 21, sessionId: 's1', at: 2000 });
  assert.equal(act(21, 'hold').code, 'CLOSED', 'a second hold is refused');
  assert.deepEqual(act(21, 'reopen'), { ok: true, id: 21 });
  assert.deepEqual(ls(root, 'decision-closures'), ['000021.1.released.json']);
  assert.deepEqual(read(root, 'decision-closures/000021.1.released.json'), held, 'renamed, not rewritten');
  assert.equal(store.readSnapshot().closures.length, 0, 'a released record is not a closure');
  assert.deepEqual(act(21, 'hold'), { ok: true, id: 21 });
  assert.deepEqual(act(21, 'reopen'), { ok: true, id: 21 });
  assert.deepEqual(ls(root, 'decision-closures').sort(), ['000021.1.released.json', '000021.2.released.json'], 'each cycle keeps its own record');
  assert.deepEqual(applyBoardAnswer(store, { id: 21, sessionId: 's1', option: 'B' }, 2001), { ok: true, id: 21 }, 'answerable again after reopen');
  assert.equal(act(21, 'hold').code, 'ANSWERED');
  assert.equal(act(22, 'hold').code, 'ANSWERED', 'holding an answered decision returns ANSWERED');
  assert.equal(heldClosure(root, 22), false);
  assert.deepEqual(ls(root, 'claims'), ['000021.json'], 'only the answer keeps a claim; every hold/reopen claim was released');
});

test('failure: answering a held decision is refused with HELD (terminal and board) and writes no answer', (t) => {
  const root = tmpRoot();
  t.after(() => cleanup(root));
  const store = openStore(root);
  const id = askDecision(store);
  assert.equal(applyBoardAnswer(store, { id, sessionId: 's1', action: 'hold' }, 1000).ok, true);
  const terminal = applyAskAnswer(store, { id, sessionId: 's1', option: 'A' }, 1001);
  assert.equal(terminal.code, 'HELD');
  const board = applyBoardAnswer(store, { id, sessionId: 's1', text: '그래도 답할게' }, 1002);
  assert.equal(board.code, 'HELD');
  assert.deepEqual(ls(root, 'answers'), []);
  console.log(`failure: answer-while-held -> terminal ${JSON.stringify(terminal)}, board ${JSON.stringify(board)}, answers ${JSON.stringify(ls(root, 'answers'))}`);
  assert.deepEqual(applyBoardAnswer(store, { id, sessionId: 's1', action: 'reopen' }, 1003), { ok: true, id });
  assert.equal(applyAskAnswer(store, { id, sessionId: 's1', option: 'A' }, 1004).ok, true, 'reopened: the terminal answer goes through');
});

test('C-HOLD malformed: hold and reopen together, a choice with an action, an unknown id and a foreign session are refused without writes', (t) => {
  const root = tmpRoot();
  t.after(() => cleanup(root));
  const store = seed(root, [{ id: 31 }]);
  for (const [body, code] of [
    [{ id: 31, sessionId: 's1', action: ['hold', 'reopen'] }, 'BAD_REQUEST'],
    [{ id: 31, sessionId: 's1', action: 'hold', option: 'A' }, 'BAD_REQUEST'],
    [{ id: 31, sessionId: 's1', action: 'hold', text: 'x' }, 'BAD_REQUEST'],
    [{ id: 31, sessionId: 's1', action: 'release' }, 'BAD_REQUEST'],
    [{ id: 999, sessionId: 's1', action: 'hold' }, 'NOT_FOUND'],
    [{ id: 31, sessionId: 'other', action: 'hold' }, 'SESSION_MISMATCH'],
  ]) assert.equal(applyBoardAnswer(store, body, 1000).code, code, JSON.stringify(body));
  assert.deepEqual(ls(root, 'decision-closures'), []);
  assert.deepEqual(ls(root, 'claims'), []);
});

test('happy: explicit options and bare number uses recommend', () => {
  const root = tmpRoot();
  try {
    const store = seed(root, [{ id: 12, recommend: 'B' }, { id: 13 }]);
    const r = applyDecide(store, '12 13B', 'sx', 1000);
    assert.deepEqual(r, { applied: [{ id: 12, option: 'B' }, { id: 13, option: 'B' }], errors: [], alreadyAnswered: [] });
    assert.equal(read(root, `answers/${pad6(12)}.json`).option, 'B');
    assert.equal(read(root, `answers/${pad6(13)}.json`).fromSessionId, 'sx');
    assert.equal(formatDecideResult(r), '반영: #12 B, #13 B');
  } finally { cleanup(root); }
});

test('all-or-nothing: 12A 99B writes zero files', () => {
  const root = tmpRoot();
  try {
    const store = seed(root, [{ id: 12 }]);
    const r = applyDecide(store, '12A 99B', 'sx', 1000);
    assert.equal(r.applied.length, 0);
    assert.ok(r.errors.some((e) => e.token === '99B'));
    assert.deepEqual(ls(root, 'answers'), []);
    assert.deepEqual(ls(root, 'claims'), []);
  } finally { cleanup(root); }
});

for (const [name, text, ids] of [
  ['bad letter 12D', '12D', [12]],
  ['garbage token x', 'x', [12]],
  ['closed decision', '12A', [12]],
  ['already answered', '12A 13B', [12, 13]],
  ['duplicate 12A 12B', '12A 12B', [12]],
  ['missing option', '12A', [12]],
]) {
  test(`all-or-nothing rejects: ${name}`, () => {
    const root = tmpRoot();
    try {
      const defs = ids.map((id) => {
        if (name === 'closed decision') return { id, closed: true };
        if (name === 'already answered') return { id, answered: 'A' };
        if (name === 'missing option') {
          return { id, options: { A: { text: 'a', consequence: 'ca' }, B: { text: 'b', consequence: 'cb' } }, recommend: 'C' };
        }
        return { id };
      });
      // 'bad letter'/'garbage' tokens never reach decisions; seed anyway.
      // 'missing option': bare-id path uses recommend C which does not exist.
      const store = seed(root, defs);
      const input = name === 'missing option' ? '12' : text;
      const r = applyDecide(store, input, 'sx', 1000);
      assert.equal(r.applied.length, 0, JSON.stringify(r));
      assert.ok(r.errors.length > 0 || r.alreadyAnswered.length > 0, JSON.stringify(r));
      const answers = name === 'already answered' ? defs.length : 0;
      assert.equal(ls(root, 'answers').length, answers);
      assert.deepEqual(ls(root, 'claims'), []);
    } finally { cleanup(root); }
  });
}

test('live-pid claim conflict: zero answers, own claims rolled back, alreadyAnswered', () => {
  const root = tmpRoot();
  try {
    const store = seed(root, [{ id: 12 }, { id: 13 }]);
    // Another live process holds 13 (use our own pid = alive).
    store.writeNew(`claims/${pad6(13)}.json`, { id: 13, pid: process.pid, at: 1, nonce: 'n-live' });
    const r = applyDecide(store, '12A 13B', 'sx', 1000);
    assert.deepEqual(r.applied, []);
    assert.deepEqual(r.alreadyAnswered, [13]);
    assert.deepEqual(ls(root, 'answers'), []);
    assert.deepEqual(ls(root, 'claims'), [`${pad6(13)}.json`], 'own claim on 12 must be rolled back');
  } finally { cleanup(root); }
});

test('stale claim (dead pid, no answer) is reclaimed and applied', () => {
  const root = tmpRoot();
  try {
    const store = seed(root, [{ id: 12 }]);
    store.writeNew(`claims/${pad6(12)}.json`, { id: 12, pid: DEAD_PID, at: 1, nonce: 'n-stale' });
    const r = applyDecide(store, '12A', 'sx', 1000);
    assert.deepEqual(r.applied, [{ id: 12, option: 'A' }]);
    assert.equal(read(root, `answers/${pad6(12)}.json`).option, 'A');
    // Winner's claim file belongs to this process; exactly one tombstone stays.
    const claims = ls(root, 'claims');
    assert.ok(claims.some((n) => n === `${pad6(12)}.json`));
    assert.equal(claims.filter((n) => n.startsWith(`${pad6(12)}.json.stale-`)).length, 1);
  } finally { cleanup(root); }
});

test('formatDecideResult failure line', () => {
  assert.equal(
    formatDecideResult({ applied: [], errors: [{ token: '99B', reason: '없음' }], alreadyAnswered: [12] }),
    '적용 안 함: #99B 없음, #12 이미 답함',
  );
});

// ---- concurrency helpers (IPC start signal + bounded timeout, no sleeps) ----
function runPair(root, textA, textB, { timeoutMs = 30000 } = {}) {
  return runKids([fork(CHILD, [root, textA, 'sA']), fork(CHILD, [root, textB, 'sB'])], timeoutMs);
}

function runKids(kids, timeoutMs) {
  return new Promise((resolve, reject) => {
    const results = [null, null];
    let done = 0;
    const timer = setTimeout(() => {
      for (const k of kids) try { k.kill(); } catch { /* gone */ }
      reject(new Error('concurrency pair timed out'));
    }, timeoutMs);
    kids.forEach((k, i) => {
      k.on('message', (m) => {
        if (m.type !== 'result' && m.type !== 'error') return;
        results[i] = m;
        if (++done === 2) {
          clearTimeout(timer);
          resolve(results);
        }
      });
      k.on('exit', (code) => {
        if (results[i] === null) {
          clearTimeout(timer);
          for (const k2 of kids) try { k2.kill(); } catch { /* gone */ }
          reject(new Error(`child ${i} exited ${code} without result`));
        }
      });
    });
    for (const k of kids) k.send({ type: 'go' });
  });
}

function checkAllOrNothingPair(root, loneId) {
  // One side applies both answers; the other applies none and keeps no claims.
  const a12 = ls(root, 'answers').sort();
  assert.equal(a12.length, 2, `answers: ${a12}`);
  const loserLone = (() => { try { read(root, `answers/${pad6(loneId)}.json`); return true; } catch { return false; } })();
  assert.equal(loserLone, false, `loser-only answer ${loneId} must not exist`);
}

test('concurrency: 12A 13B vs 13A 14B x20 - one side wins both, answers/13 is single', async () => {
  for (let rep = 0; rep < 20; rep++) {
    const root = tmpRoot();
    try {
      seed(root, [{ id: 12 }, { id: 13 }, { id: 14 }]);
      const [a, b] = await runPair(root, '12A 13B', '13A 14B');
      assert.equal(a.type, 'result', JSON.stringify(a));
      assert.equal(b.type, 'result', JSON.stringify(b));
      const aw = a.result.applied.length === 2 ? a.result : b.result;
      const al = a.result.applied.length === 2 ? b.result : a.result;
      assert.equal(aw.applied.length, 2);
      assert.deepEqual(al.applied, []);
      const ids = aw.applied.map((x) => x.id).sort((x, y) => x - y);
      const lone = ids.includes(12) ? 14 : 12;
      checkAllOrNothingPair(root, lone);
      assert.equal(read(root, `answers/${pad6(13)}.json`).id, 13);
    } finally { cleanup(root); }
  }
});

test('concurrency: same stale claim race x20 - exactly one winner, one tombstone', async () => {
  for (let rep = 0; rep < 20; rep++) {
    const root = tmpRoot();
    try {
      const store = seed(root, [{ id: 12 }, { id: 13 }, { id: 14 }]);
      store.writeNew(`claims/${pad6(12)}.json`, { id: 12, pid: DEAD_PID, at: 1, nonce: `n-${rep}` });
      const [a, b] = await runPair(root, '12A 13B', '12B 14A');
      assert.equal(a.type, 'result', JSON.stringify(a));
      assert.equal(b.type, 'result', JSON.stringify(b));
      const winner = a.result.applied.length === 2 ? a : b;
      const aw = winner.result;
      const al = a.result.applied.length === 2 ? b.result : a.result;
      assert.equal(aw.applied.length, 2, `rep ${rep}: ${JSON.stringify([a.result, b.result])}`);
      assert.deepEqual(al.applied, []);
      assert.equal(ls(root, 'answers').length, 2);
      assert.equal(read(root, `answers/${pad6(12)}.json`).id, 12);
      const claim = read(root, `claims/${pad6(12)}.json`);
      assert.equal(claim.pid, winner.pid, 'winner process holds the claim');
      const tombs = ls(root, 'claims').filter((n) => n.startsWith(`${pad6(12)}.json.stale-`));
      assert.equal(tombs.length, 1, `tombs: ${tombs}`);
      // Loser kept no claims of its own.
      const loserIds = al === a.result ? [13] : [14];
      for (const id of loserIds) {
        assert.equal(ls(root, 'claims').includes(`${pad6(id)}.json`), false);
      }
    } finally { cleanup(root); }
  }
});

test('deterministic interleave: B pauses before reclaim, A wins, B gets alreadyAnswered', () => {
  const root = tmpRoot();
  try {
    const storeA = seed(root, [{ id: 12 }]);
    storeA.writeNew(`claims/${pad6(12)}.json`, { id: 12, pid: DEAD_PID, at: 1, nonce: 'n-x' });
    let hookCalled = false;
    // B reads the stale claim, then A reclaims+answers inside the hook
    // (i.e. before B's reclaimStale call), so B must lose.
    const storeB = openStore(root);
    const hooks = {
      beforeReclaim: () => {
        hookCalled = true;
        const ra = applyDecide(storeA, '12A', 'sA', 1000);
        assert.deepEqual(ra.applied, [{ id: 12, option: 'A' }]);
      },
    };
    const rb = applyDecide(storeB, '12B', 'sB', 2000, { hooks });
    assert.equal(hookCalled, true);
    assert.deepEqual(rb.applied, []);
    assert.deepEqual(rb.alreadyAnswered, [12]);
    assert.equal(read(root, `answers/${pad6(12)}.json`).fromSessionId, 'sA');
    const claimA = read(root, `claims/${pad6(12)}.json`);
    assert.equal(claimA.pid, process.pid);
    assert.notEqual(claimA.nonce, 'n-x');
  } finally { cleanup(root); }
});

test('rollback interleave: B reads A claim, A rolls back, C claims+answers, then B reclaim is false', async () => {
  const root = tmpRoot();
  let worker = null;
  try {
    seed(root, [{ id: 12 }, { id: 13 }]);
    const storeA = openStore(root);
    const storeC = openStore(root);
    storeA.writeNew(`claims/${pad6(13)}.json`, { id: 13, pid: process.pid, at: 1, nonce: 'n-live13' });
    // B runs in a worker so it can stay paused (Atomics) at its reclaim hook while A and C run here.
    const flags = new Int32Array(new SharedArrayBuffer(8));
    worker = new Worker(PAUSED_B, { workerData: { root, text: '12B', from: 'sB', flags: flags.buffer } });
    const bDone = new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`worker exited ${code}`)));
    });
    let aClaim = null;
    // A (dead pid, so B may try to reclaim) claims 12, then conflicts with the live claim on 13.
    // At that hook A's real claim 12 exists: start B, which reads it and pauses before reclaimStale.
    const hooksA = {
      beforeReclaim: (id) => {
        if (id !== 13) return;
        aClaim = storeA.readRecord(`claims/${pad6(12)}.json`);
        worker.postMessage({ type: 'go' });
        assert.notEqual(Atomics.wait(flags, 0, 0, 30000), 'timed-out', 'B never reached its reclaim hook');
      },
    };
    const ra = applyDecide(storeA, '12A 13B', 'sA', 1000, { pid: DEAD_PID, hooks: hooksA });
    assert.deepEqual(ra.applied, []);
    assert.deepEqual(ra.alreadyAnswered, [13]);
    assert.ok(aClaim && aClaim.pid === DEAD_PID && aClaim.nonce, 'B paused with A\'s real claim record');
    assert.equal(ls(root, 'claims').includes(`${pad6(12)}.json`), false, 'A rolled back 12');
    // C claims 12 fresh and answers.
    const rc = applyDecide(storeC, '12A', 'sC', 2000);
    assert.deepEqual(rc.applied, [{ id: 12, option: 'A' }]);
    const claimC = fs.readFileSync(join(root, 'claims', `${pad6(12)}.json`), 'utf8');
    const answerC = fs.readFileSync(join(root, 'answers', `${pad6(12)}.json`), 'utf8');
    assert.notEqual(JSON.parse(claimC).nonce, aClaim.nonce);
    // Resume B: its reclaimStale(old A record) must be false and C's files must stay.
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    const msg = await bDone;
    assert.equal(msg.type, 'result', JSON.stringify(msg));
    assert.deepEqual(msg.staleSeen, aClaim, 'B reclaimed with the record it read before the rollback');
    assert.deepEqual(msg.result.applied, []);
    assert.deepEqual(msg.result.alreadyAnswered, [12]);
    assert.equal(fs.readFileSync(join(root, 'claims', `${pad6(12)}.json`), 'utf8'), claimC);
    assert.equal(fs.readFileSync(join(root, 'answers', `${pad6(12)}.json`), 'utf8'), answerC);
    assert.deepEqual(ls(root, 'claims').sort(), [`${pad6(12)}.json`, `${pad6(13)}.json`], 'no tombstone, no B claim');
    assert.deepEqual(ls(root, 'answers'), [`${pad6(12)}.json`]);
  } finally {
    if (worker) await worker.terminate();
    cleanup(root);
  }
});

test('D2 interleave: B pauses on A\'s unanswered claim, A commits both answers and exits, B must apply nothing', async () => {
  const root = tmpRoot();
  let worker = null;
  try {
    const storeA = seed(root, [{ id: 12 }, { id: 13 }, { id: 14 }]);
    // A = '13A 14B' holds both claims, no answer yet. Its pid is dead, as it will be once it has exited.
    storeA.writeNew(`claims/${pad6(13)}.json`, { id: 13, pid: DEAD_PID, at: 1, nonce: 'n-a13' });
    storeA.writeNew(`claims/${pad6(14)}.json`, { id: 14, pid: DEAD_PID, at: 1, nonce: 'n-a14' });
    const flags = new Int32Array(new SharedArrayBuffer(8));
    worker = new Worker(PAUSED_B, { workerData: { root, text: '12A 13B', from: 'sB', flags: flags.buffer } });
    const bDone = new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`worker exited ${code}`)));
    });
    worker.postMessage({ type: 'go' });
    // B claimed 12, found A's unanswered claim on 13 and paused before its reclaim.
    assert.notEqual(Atomics.wait(flags, 0, 0, 30000), 'timed-out', 'B never reached its reclaim hook');
    assert.deepEqual(ls(root, 'answers'), []);
    // A commits its whole batch and exits.
    storeA.writeNew(`answers/${pad6(13)}.json`, { id: 13, option: 'A', at: 1000, fromSessionId: 'sA' });
    storeA.writeNew(`answers/${pad6(14)}.json`, { id: 14, option: 'B', at: 1000, fromSessionId: 'sA' });
    const claim13 = fs.readFileSync(join(root, 'claims', `${pad6(13)}.json`), 'utf8');
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    const msg = await bDone;
    assert.equal(msg.type, 'result', JSON.stringify(msg));
    assert.deepEqual(msg.result.applied, []);
    assert.deepEqual(msg.result.errors, []);
    assert.deepEqual(msg.result.alreadyAnswered, [13]);
    assert.deepEqual(ls(root, 'answers').sort(), [`${pad6(13)}.json`, `${pad6(14)}.json`], 'B wrote no answer');
    assert.deepEqual(ls(root, 'claims').sort(), [`${pad6(13)}.json`, `${pad6(14)}.json`], 'B kept no claim and left no tombstone');
    assert.equal(fs.readFileSync(join(root, 'claims', `${pad6(13)}.json`), 'utf8'), claim13);
  } finally {
    if (worker) await worker.terminate();
    cleanup(root);
  }
});

// ---- Windows: a just-deleted claim can make wx fail with EPERM/EBUSY/EACCES instead of EEXIST ----
const norm = (p) => String(p).replace(/\\/g, '/');
const injectErr = (code) => Object.assign(new Error(`${code}: injected`), { code });

test('transient EPERM on the claim wx is retried with backoff, then the claim is won', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12 }]);
    let fails = 2;
    const flaky = { ...fs, writeFileSync: (file, data, o) => {
      if (norm(file).endsWith(`claims/${pad6(12)}.json`) && fails-- > 0) throw injectErr('EPERM');
      return fs.writeFileSync(file, data, o);
    } };
    const sleeps = [];
    const r = applyDecide(openStore(root, { fs: flaky }), '12A', 'sx', 1000, { sleep: (ms) => sleeps.push(ms) });
    assert.deepEqual(r.applied, [{ id: 12, option: 'A' }]);
    assert.deepEqual(sleeps, [2, 4]);
  } finally { cleanup(root); }
});

test('transient EPERM then a live competitor claim shows up: lose cleanly, own claims rolled back', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12 }, { id: 13 }]);
    const flaky = { ...fs, writeFileSync: (file, data, o) => {
      if (norm(file).endsWith(`claims/${pad6(13)}.json`)) {
        fs.writeFileSync(file, JSON.stringify({ id: 13, pid: process.pid, at: 1, nonce: 'n-rival' }), o);
        throw injectErr('EACCES');
      }
      return fs.writeFileSync(file, data, o);
    } };
    const r = applyDecide(openStore(root, { fs: flaky }), '12A 13B', 'sx', 1000, { sleep: () => {} });
    assert.deepEqual(r, { applied: [], errors: [], alreadyAnswered: [13] });
    assert.deepEqual(ls(root, 'claims'), [`${pad6(13)}.json`]);
    assert.equal(read(root, `claims/${pad6(13)}.json`).nonce, 'n-rival');
    assert.deepEqual(ls(root, 'answers'), []);
  } finally { cleanup(root); }
});

test('persistent EBUSY on the claim wx and no competitor: bounded retries, permissionError (not 이미 답함), no files', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12 }, { id: 13 }]);
    let attempts = 0;
    const flaky = { ...fs, writeFileSync: (file, data, o) => {
      if (norm(file).endsWith(`claims/${pad6(13)}.json`)) { attempts++; throw injectErr('EBUSY'); }
      return fs.writeFileSync(file, data, o);
    } };
    const sleeps = [];
    const r = applyDecide(openStore(root, { fs: flaky }), '12A 13B', 'sx', 1000, { sleep: (ms) => sleeps.push(ms) });
    assert.deepEqual(r, { applied: [], errors: [], alreadyAnswered: [], permissionError: [13] });
    assert.equal(attempts, 9);
    assert.equal(sleeps.length, 8);
    assert.deepEqual(ls(root, 'claims'), []);
    assert.deepEqual(ls(root, 'answers'), []);
  } finally { cleanup(root); }
});

test('T9-RESULT-ACCURACY repro: persistent EPERM creating claim 13, no competitor -> permission line, empty answers/claims', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12 }, { id: 13 }]);
    const flaky = { ...fs, writeFileSync: (file, data, o) => {
      if (norm(file).endsWith(`claims/${pad6(13)}.json`)) throw injectErr('EPERM');
      return fs.writeFileSync(file, data, o);
    } };
    const r = applyDecide(openStore(root, { fs: flaky }), '12A 13B', 'sx', 1000, { sleep: () => {} });
    assert.deepEqual(r.permissionError, [13]);
    assert.deepEqual(r.alreadyAnswered, []);
    assert.deepEqual(r.applied, []);
    assert.equal(formatDecideResult(r), '적용 안 함: #13 파일 권한 오류 - 다시 시도');
    assert.deepEqual(ls(root, 'claims'), []);
    assert.deepEqual(ls(root, 'answers'), []);
  } finally { cleanup(root); }
});

test('EPERM retries, then a real competitor claim appears mid-retry -> still 이미 답함, no permissionError', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12 }, { id: 13 }]);
    let tries = 0;
    const flaky = { ...fs, writeFileSync: (file, data, o) => {
      if (norm(file).endsWith(`claims/${pad6(13)}.json`)) {
        if (++tries === 3) fs.writeFileSync(file, JSON.stringify({ id: 13, pid: process.pid, at: 1, nonce: 'n-late' }), o);
        throw injectErr('EPERM');
      }
      return fs.writeFileSync(file, data, o);
    } };
    const r = applyDecide(openStore(root, { fs: flaky }), '12A 13B', 'sx', 1000, { sleep: () => {} });
    assert.equal(tries, 3);
    assert.deepEqual(r, { applied: [], errors: [], alreadyAnswered: [13] });
    assert.equal(formatDecideResult(r), '적용 안 함: #13 이미 답함');
    assert.deepEqual(ls(root, 'claims'), [`${pad6(13)}.json`]);
    assert.deepEqual(ls(root, 'answers'), []);
  } finally { cleanup(root); }
});

test('EPERM retries, then a competitor answer file appears -> still 이미 답함', () => {
  const root = tmpRoot();
  try {
    const seeded = seed(root, [{ id: 12 }, { id: 13 }]);
    let tries = 0;
    const flaky = { ...fs, writeFileSync: (file, data, o) => {
      if (norm(file).endsWith(`claims/${pad6(13)}.json`)) {
        if (++tries === 2) seeded.writeNew(`answers/${pad6(13)}.json`, { id: 13, option: 'A', at: 1, fromSessionId: 'sz' });
        throw injectErr('EBUSY');
      }
      return fs.writeFileSync(file, data, o);
    } };
    const r = applyDecide(openStore(root, { fs: flaky }), '12A 13B', 'sx', 1000, { sleep: () => {} });
    assert.deepEqual(r, { applied: [], errors: [], alreadyAnswered: [13] });
    assert.deepEqual(ls(root, 'claims'), []);
  } finally { cleanup(root); }
});

test('formatDecideResult permission line, alone and mixed with errors', () => {
  assert.equal(
    formatDecideResult({ applied: [], errors: [], alreadyAnswered: [], permissionError: [13] }),
    '적용 안 함: #13 파일 권한 오류 - 다시 시도',
  );
  assert.equal(
    formatDecideResult({ applied: [], errors: [], alreadyAnswered: [12], permissionError: [13] }),
    '적용 안 함: #12 이미 답함, #13 파일 권한 오류 - 다시 시도',
  );
});

test('reclaim link fails with EPERM because the claim is being removed by someone else: lose cleanly', () => {
  const root = tmpRoot();
  try {
    const seeded = seed(root, [{ id: 12 }]);
    seeded.writeNew(`claims/${pad6(12)}.json`, { id: 12, pid: DEAD_PID, at: 1, nonce: 'n-stale' });
    const flaky = { ...fs, linkSync: (from, to) => {
      fs.unlinkSync(from); // the other reclaimer finishes deleting just before our link
      throw injectErr('EPERM');
    } };
    const r = applyDecide(openStore(root, { fs: flaky }), '12A', 'sx', 1000, { sleep: () => {} });
    assert.deepEqual(r, { applied: [], errors: [], alreadyAnswered: [12] });
    assert.deepEqual(ls(root, 'answers'), []);
  } finally { cleanup(root); }
});

test('reclaim link fails with EPERM and the claim is unchanged: real failure is thrown, own claims rolled back', () => {
  const root = tmpRoot();
  try {
    const seeded = seed(root, [{ id: 11 }, { id: 12 }]);
    seeded.writeNew(`claims/${pad6(12)}.json`, { id: 12, pid: DEAD_PID, at: 1, nonce: 'n-stale' });
    const noLink = { ...fs, linkSync: () => { throw injectErr('EPERM'); } };
    assert.throws(() => applyDecide(openStore(root, { fs: noLink }), '11A 12A', 'sx', 1000, { sleep: () => {} }), /수동 확인 필요/);
    assert.deepEqual(ls(root, 'claims'), [`${pad6(12)}.json`]);
    assert.deepEqual(ls(root, 'answers'), []);
  } finally { cleanup(root); }
});

// ---- F2 fix: read errors fail closed; the final pre-write re-check is pinned ----
test('T9-CLOSED-REJECT: an unreadable closure (EACCES) is not "not closed": apply nothing, permission line', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12, closed: true }]);
    const flaky = { ...fs, readFileSync: (file, ...a) => {
      if (String(file).replace(/\\/g, '/').endsWith(`decision-closures/${pad6(12)}.json`)) {
        throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
      }
      return fs.readFileSync(file, ...a);
    } };
    const r = applyDecide(openStore(root, { fs: flaky, sleep: () => {} }), '12A', 'sx', 1000);
    assert.deepEqual(r, { applied: [], errors: [], alreadyAnswered: [], permissionError: [12], readErrors: [{ id: 12, message: 'EACCES: injected' }] });
    assert.equal(formatDecideResult(r), '적용 안 함: #12 파일 권한 오류 - 다시 시도');
    assert.deepEqual(ls(root, 'answers'), []);
    assert.deepEqual(ls(root, 'claims'), []);
  } finally { cleanup(root); }
});

// ---- B1: absence (ENOENT) is 없음; an exhausted operational read error is a permission error that is reported ----
const denyReads = (suffix, code = 'EACCES') => ({ ...fs, readFileSync: (file, ...a) => {
  if (String(file).replace(/\\/g, '/').endsWith(suffix)) throw Object.assign(new Error(`${code}: injected`), { code });
  return fs.readFileSync(file, ...a);
} });

test('B1: an existing decision that cannot be read (EACCES, retries exhausted) is a permission error, not 없음; whole batch applies nothing', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12 }, { id: 13 }]);
    const store = openStore(root, { fs: denyReads(`decisions/${pad6(12)}.json`), sleep: () => {} });
    const r = applyDecide(store, '12A 13A', 'sx', 1000);
    assert.deepEqual(r, { applied: [], errors: [], alreadyAnswered: [], permissionError: [12], readErrors: [{ id: 12, message: 'EACCES: injected' }] });
    assert.equal(formatDecideResult(r), '적용 안 함: #12 파일 권한 오류 - 다시 시도');
    assert.deepEqual(ls(root, 'answers'), []);
    assert.deepEqual(ls(root, 'claims'), []);
  } finally { cleanup(root); }
});

test('B1: a decision that is truly absent (ENOENT) is still 없음 with no read error', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12 }]);
    const r = applyDecide(openStore(root, { fs, sleep: () => {} }), '99A', 'sx', 1000);
    assert.deepEqual(r, { applied: [], errors: [{ token: '99A', reason: '없음' }], alreadyAnswered: [] });
  } finally { cleanup(root); }
});

test('B1: an answer file that cannot be read (EACCES) is a permission error, not "no answer yet"; nothing applied, error reported', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12, answered: 'B' }]);
    const store = openStore(root, { fs: denyReads(`answers/${pad6(12)}.json`), sleep: () => {} });
    const r = applyDecide(store, '12A', 'sx', 1000);
    assert.deepEqual(r, { applied: [], errors: [], alreadyAnswered: [], permissionError: [12], readErrors: [{ id: 12, message: 'EACCES: injected' }] });
    assert.deepEqual(ls(root, 'claims'), []);
    assert.equal(read(root, `answers/${pad6(12)}.json`).option, 'B', 'original answer untouched');
  } finally { cleanup(root); }
});

test('final pre-write re-check: an answer that appears once claims are held makes B apply nothing (guard removal fails this)', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12 }, { id: 13 }]);
    // An orphan answer for 13 shows up right after B wins its claim on 13 (answer exists, no claim to lose to).
    const racing = { ...fs, writeFileSync: (file, data, o) => {
      const out = fs.writeFileSync(file, data, o);
      if (String(file).replace(/\\/g, '/').endsWith(`claims/${pad6(13)}.json`)) {
        fs.mkdirSync(join(root, 'answers'), { recursive: true });
        fs.writeFileSync(join(root, 'answers', `${pad6(13)}.json`),
          JSON.stringify({ id: 13, option: 'A', at: 1, fromSessionId: 'sA' }), { flag: 'wx' });
      }
      return out;
    } };
    const r = applyDecide(openStore(root, { fs: racing }), '12A 13B', 'sx', 1000);
    assert.deepEqual(r, { applied: [], errors: [], alreadyAnswered: [13] });
    assert.deepEqual(ls(root, 'answers'), [`${pad6(13)}.json`], 'B wrote no answer, not even for 12');
    assert.deepEqual(ls(root, 'claims'), [], 'B rolled back its claims');
  } finally { cleanup(root); }
});

// ---- board answers (applyBoardAnswer): the same all-or-nothing writer as /decide ----
// seed() decisions are asked by 's1'.
const ask = (id, extra) => ({ id, sessionId: 's1', ...extra });
const BOARD_FILE = (id) => `answers/${pad6(id)}.json`;

test('board: an option answer lands as answers/<id>.json from "board" through the shared claim', () => {
  const root = tmpRoot();
  try {
    const store = seed(root, [{ id: 12 }]);
    assert.deepEqual(applyBoardAnswer(store, ask(12, { option: 'B' }), 1000), { ok: true, id: 12 });
    assert.deepEqual(read(root, BOARD_FILE(12)), { id: 12, option: 'B', at: 1000, fromSessionId: 'board' });
    assert.equal(read(root, `claims/${pad6(12)}.json`).pid, process.pid, 'same claim file /decide uses');
  } finally { cleanup(root); }
});

test('board: a text answer is trimmed and otherwise verbatim; 500 code points is accepted, counted in code points', () => {
  const root = tmpRoot();
  try {
    const store = seed(root, [{ id: 12 }, { id: 13 }, { id: 14 }]);
    const cases = [[12, ' \n설치해 줘 [결정 전달] #1\n\t ', '설치해 줘 [결정 전달] #1'], [13, '가'.repeat(500), '가'.repeat(500)], [14, '😀'.repeat(500), '😀'.repeat(500)]];
    for (const [id, text, stored] of cases) {
      assert.deepEqual(applyBoardAnswer(store, ask(id, { text }), 1000), { ok: true, id });
      assert.deepEqual(read(root, BOARD_FILE(id)), { id, text: stored, at: 1000, fromSessionId: 'board' });
    }
  } finally { cleanup(root); }
});

for (const [name, request, code] of [
  ['unknown decision', ask(99, { option: 'A' }), 'NOT_FOUND'],
  ['decision of another session', { id: 12, sessionId: 's2', option: 'A' }, 'SESSION_MISMATCH'],
  ['closed decision', ask(13, { option: 'A' }), 'CLOSED'],
  ['closed decision, text', ask(13, { text: 'hi' }), 'CLOSED'],
  ['answered decision', ask(14, { option: 'B' }), 'ANSWERED'],
  ['answered decision, text', ask(14, { text: 'hi' }), 'ANSWERED'],
  ['option the decision does not offer (C)', ask(12, { option: 'C' }), 'BAD_OPTION'],
  ['lowercase option', ask(12, { option: 'a' }), 'BAD_OPTION'],
  ['inherited key as option', ask(12, { option: 'constructor' }), 'BAD_OPTION'],
  ['non-string option', ask(12, { option: 1 }), 'BAD_OPTION'],
  ['null option', ask(12, { option: null }), 'BAD_OPTION'],
  ['text of 501 code points', ask(12, { text: 'x'.repeat(501) }), 'BAD_TEXT'],
  ['text of 501 astral code points', ask(12, { text: '😀'.repeat(501) }), 'BAD_TEXT'],
  ['huge text', ask(12, { text: 'x'.repeat(1_000_000) }), 'BAD_TEXT'],
  ['whitespace-only text', ask(12, { text: '  \n\t ' }), 'BAD_TEXT'],
  ['empty text', ask(12, { text: '' }), 'BAD_TEXT'],
  ['non-string text', ask(12, { text: 12 }), 'BAD_TEXT'],
  ['null text', ask(12, { text: null }), 'BAD_TEXT'],
  ['both option and text', ask(12, { option: 'A', text: 'hi' }), 'BAD_REQUEST'],
  ['neither option nor text', ask(12, {}), 'BAD_REQUEST'],
  ['id as a string', { id: '12', sessionId: 's1', option: 'A' }, 'BAD_REQUEST'],
  ['id zero', ask(0, { option: 'A' }), 'BAD_REQUEST'],
  ['negative id', ask(-12, { option: 'A' }), 'BAD_REQUEST'],
  ['fractional id', ask(12.5, { option: 'A' }), 'BAD_REQUEST'],
  ['missing sessionId', { id: 12, option: 'A' }, 'BAD_REQUEST'],
  ['empty sessionId', { id: 12, sessionId: '', option: 'A' }, 'BAD_REQUEST'],
  ['request is null', null, 'BAD_REQUEST'],
  ['request is a string', '12A', 'BAD_REQUEST'],
]) {
  test(`board refuses: ${name} -> ${code}, nothing is written`, () => {
    const root = tmpRoot();
    try {
      const store = seed(root, [{ id: 12 }, { id: 13, closed: true }, { id: 14, answered: 'A' }]);
      const before = fs.readFileSync(join(root, BOARD_FILE(14)), 'utf8');
      assert.deepEqual(applyBoardAnswer(store, request, 1000), { ok: false, code });
      assert.deepEqual(ls(root, 'answers'), [`${pad6(14)}.json`], 'only the seeded answer exists');
      assert.equal(fs.readFileSync(join(root, BOARD_FILE(14)), 'utf8'), before, 'an existing answer is never changed');
      assert.deepEqual(ls(root, 'claims'), []);
    } finally { cleanup(root); }
  });
}

test('board and /decide exclude each other in both orders; the first answer stays', () => {
  const root = tmpRoot();
  try {
    const store = seed(root, [{ id: 12 }, { id: 13 }]);
    assert.deepEqual(applyBoardAnswer(store, ask(12, { option: 'B' }), 1000), { ok: true, id: 12 });
    assert.deepEqual(applyDecide(store, '12A', 'sx', 2000), { applied: [], errors: [], alreadyAnswered: [12] });
    assert.deepEqual(read(root, BOARD_FILE(12)), { id: 12, option: 'B', at: 1000, fromSessionId: 'board' });
    assert.deepEqual(applyDecide(store, '13A', 'sx', 3000).applied, [{ id: 13, option: 'A' }]);
    assert.deepEqual(applyBoardAnswer(store, ask(13, { option: 'B' }), 4000), { ok: false, code: 'ANSWERED' });
    assert.deepEqual(read(root, BOARD_FILE(13)), { id: 13, option: 'A', at: 3000, fromSessionId: 'sx' });
  } finally { cleanup(root); }
});

test('concurrency: /decide 12A vs a board answer for #12 x20 - exactly one answers/000012.json, the loser is refused', async () => {
  for (let rep = 0; rep < 20; rep++) {
    const root = tmpRoot();
    try {
      seed(root, [{ id: 12 }]);
      const [d, b] = await runKids([
        fork(CHILD, [root, '12A', 'sD'], { execArgv: [] }),
        fork(BOARD_CHILD, [root, '12', 's1', 'option', 'B'], { execArgv: [] }),
      ], 30000);
      assert.equal(d.type, 'result', JSON.stringify(d));
      assert.equal(b.type, 'result', JSON.stringify(b));
      const decideWon = d.result.applied.length === 1;
      assert.notEqual(decideWon, b.result.ok === true, `rep ${rep}: exactly one writer wins: ${JSON.stringify([d.result, b.result])}`);
      if (decideWon) {
        assert.deepEqual(b.result, { ok: false, code: 'ANSWERED' });
        assert.deepEqual(read(root, BOARD_FILE(12)), { id: 12, option: 'A', at: read(root, BOARD_FILE(12)).at, fromSessionId: 'sD' });
      } else {
        assert.deepEqual(d.result, { applied: [], errors: [], alreadyAnswered: [12] });
        assert.deepEqual(read(root, BOARD_FILE(12)), { id: 12, option: 'B', at: read(root, BOARD_FILE(12)).at, fromSessionId: 'board' });
      }
      assert.deepEqual(ls(root, 'answers'), [`${pad6(12)}.json`]);
      assert.deepEqual(ls(root, 'claims'), [`${pad6(12)}.json`], 'the winner\'s claim only: no loser claim, no tombstone');
    } finally { cleanup(root); }
  }
});

test('deterministic interleave: the board answer pauses before reclaim, /decide wins, the board answer is ANSWERED', () => {
  const root = tmpRoot();
  try {
    const storeD = seed(root, [{ id: 12 }]);
    storeD.writeNew(`claims/${pad6(12)}.json`, { id: 12, pid: DEAD_PID, at: 1, nonce: 'n-x' });
    let hookCalled = false;
    const hooks = { beforeReclaim: () => {
      hookCalled = true;
      assert.deepEqual(applyDecide(storeD, '12A', 'sD', 1000).applied, [{ id: 12, option: 'A' }]);
    } };
    assert.deepEqual(applyBoardAnswer(openStore(root), ask(12, { option: 'B' }), 2000, { hooks }), { ok: false, code: 'ANSWERED' });
    assert.equal(hookCalled, true);
    assert.deepEqual(read(root, BOARD_FILE(12)), { id: 12, option: 'A', at: 1000, fromSessionId: 'sD' });
  } finally { cleanup(root); }
});

test('deterministic interleave: /decide pauses before reclaim, the board answer wins, /decide gets alreadyAnswered', () => {
  const root = tmpRoot();
  try {
    const storeB = seed(root, [{ id: 12 }]);
    storeB.writeNew(`claims/${pad6(12)}.json`, { id: 12, pid: DEAD_PID, at: 1, nonce: 'n-y' });
    let hookCalled = false;
    const hooks = { beforeReclaim: () => {
      hookCalled = true;
      assert.deepEqual(applyBoardAnswer(storeB, ask(12, { text: '진행해' }), 1000), { ok: true, id: 12 });
    } };
    const rd = applyDecide(openStore(root), '12B', 'sD', 2000, { hooks });
    assert.equal(hookCalled, true);
    assert.deepEqual(rd, { applied: [], errors: [], alreadyAnswered: [12] });
    assert.deepEqual(read(root, BOARD_FILE(12)), { id: 12, text: '진행해', at: 1000, fromSessionId: 'board' });
  } finally { cleanup(root); }
});

test('board: a closure or answer that cannot be read (EACCES) is IO_ERROR, not "open"; nothing is written', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12, closed: true }, { id: 13, answered: 'B' }]);
    for (const [id, suffix] of [[12, `decision-closures/${pad6(12)}.json`], [13, BOARD_FILE(13)]]) {
      const store = openStore(root, { fs: denyReads(suffix), sleep: () => {} });
      assert.deepEqual(applyBoardAnswer(store, ask(id, { option: 'A' }), 1000), { ok: false, code: 'IO_ERROR', detail: 'EACCES: injected' });
    }
    assert.deepEqual(ls(root, 'answers'), [`${pad6(13)}.json`]);
    assert.deepEqual(ls(root, 'claims'), []);
  } finally { cleanup(root); }
});

test('board: a persistent EBUSY on the claim with no competitor is IO_ERROR (not ANSWERED), bounded retries, no files', () => {
  const root = tmpRoot();
  try {
    seed(root, [{ id: 12 }]);
    let attempts = 0;
    const flaky = { ...fs, writeFileSync: (file, data, o) => {
      if (norm(file).endsWith(`claims/${pad6(12)}.json`)) { attempts++; throw injectErr('EBUSY'); }
      return fs.writeFileSync(file, data, o);
    } };
    const sleeps = [];
    const r = applyBoardAnswer(openStore(root, { fs: flaky }), ask(12, { option: 'A' }), 1000, { sleep: (ms) => sleeps.push(ms) });
    assert.deepEqual(r, { ok: false, code: 'IO_ERROR', detail: '파일 권한 오류' });
    assert.equal(attempts, 9);
    assert.equal(sleeps.length, 8);
    assert.deepEqual(ls(root, 'answers'), []);
    assert.deepEqual(ls(root, 'claims'), []);
  } finally { cleanup(root); }
});

test('board: a failed answer write after the claim is IO_ERROR with the cause; a stale-claim manual-check failure is IO_ERROR too', () => {
  const root = tmpRoot();
  try {
    const seeded = seed(root, [{ id: 12 }, { id: 13 }]);
    const failing = { ...fs, writeFileSync: (file, data, o) => {
      if (norm(file).endsWith(BOARD_FILE(12))) throw injectErr('ENOSPC');
      return fs.writeFileSync(file, data, o);
    } };
    const r = applyBoardAnswer(openStore(root, { fs: failing }), ask(12, { option: 'A' }), 1000);
    assert.deepEqual(r, { ok: false, code: 'IO_ERROR', detail: 'ENOSPC: injected' });
    assert.deepEqual(ls(root, 'answers'), []);
    seeded.writeNew(`claims/${pad6(13)}.json`, { id: 13, pid: DEAD_PID, at: 1, nonce: 'n-stale' });
    const noLink = { ...fs, linkSync: () => { throw injectErr('EPERM'); } };
    const r2 = applyBoardAnswer(openStore(root, { fs: noLink }), ask(13, { option: 'A' }), 1000, { sleep: () => {} });
    assert.equal(r2.code, 'IO_ERROR');
    assert.match(r2.detail, /수동 확인 필요/);
    assert.deepEqual(ls(root, 'answers'), []);
  } finally { cleanup(root); }
});

test('annotation: 9 KB Markdown is byte-identical, shares string-key claims, and retries are canonical and write-once', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root);
    const key = `a-${NOTE_ID}`;
    const text = ' \n## [owner]\n- [ ] follow up\t' + 'x\n'.repeat(4608) + '\n ';
    const request = { sessionId: 's1', requestId: NOTE_ID, text };
    assert.ok(Buffer.byteLength(text) >= 9 * 1024);
    assert.deepEqual(applyBoardAnnotation(store, request, 1000), { ok: true, key });
    const saved = store.readRecord(`answers/${key}.json`);
    assert.deepEqual(saved, { key, kind: 'annotation', ...request, at: 1000, fromSessionId: 'board' });
    assert.deepEqual(Buffer.from(saved.text), Buffer.from(text));
    assert.equal(store.readRecord(`claims/${key}.json`).key, key);
    const before = fs.readFileSync(join(root, `answers/${key}.json`), 'utf8');
    assert.deepEqual(applyBoardAnnotation(store, request, 2000), { ok: true, key, duplicate: true });
    assert.deepEqual(applyBoardAnnotation(store, { ...request, requestId: NOTE_ID.toUpperCase() }, 2000), { ok: true, key, duplicate: true });
    for (const changed of [{ text: text.trim() }, { sessionId: 's2' }]) {
      assert.deepEqual(applyBoardAnnotation(store, { ...request, ...changed }, 2000), { ok: false, code: 'REQUEST_ID_CONFLICT' });
    }
    assert.equal(fs.readFileSync(join(root, `answers/${key}.json`), 'utf8'), before);
    assert.deepEqual(ls(root, 'answers'), [`${key}.json`]);
  } finally { cleanup(root); }
});

test('annotation: text bounds count code points and UTF-8 bytes, reject bad UUIDs, and never trim accepted text', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root);
    for (const text of ['', ' \n\t ', null, 5, 'x'.repeat(12001), '😀'.repeat(12001), '😀'.repeat(12289)]) {
      assert.equal(applyBoardAnnotation(store, { sessionId: 's1', requestId: NOTE_ID, text }, 1000).code, 'BAD_TEXT');
    }
    for (const requestId of ['../escape', NOTE_ID.replace('-4cde-', '-1cde-'), NOTE_ID.replace('-8fab-', '-7fab-'), 'not-a-uuid']) {
      assert.equal(applyBoardAnnotation(store, { sessionId: 's1', requestId, text: 'ok' }, 1000).code, 'BAD_REQUEST');
    }
    assert.equal(applyBoardAnnotation(store, null, 1000).code, 'BAD_REQUEST');
    assert.deepEqual(ls(root, 'claims'), []);
    const text = '😀'.repeat(12000);
    assert.equal(Buffer.byteLength(text), 48000);
    assert.equal(applyBoardAnnotation(store, { sessionId: 's1', requestId: NOTE_ID, text }, 1000).ok, true);
    assert.equal(store.readRecord(`answers/a-${NOTE_ID}.json`).text, text);
  } finally { cleanup(root); }
});

test('annotation: crash after claim before answer recovers with the same requestId; a live claim fails closed', () => {
  const root = tmpRoot();
  try {
    const key = `a-${NOTE_ID}`;
    const request = { sessionId: 's1', requestId: NOTE_ID, text: 'retry\n[unchanged]' };
    const failing = { ...fs, writeFileSync(file, ...args) {
      if (norm(file).endsWith(`answers/${key}.json`)) throw injectErr('ENOSPC');
      return fs.writeFileSync(file, ...args);
    } };
    assert.equal(applyBoardAnnotation(openStore(root, { fs: failing }), request, 1000, { pid: DEAD_PID }).code, 'IO_ERROR');
    assert.deepEqual(ls(root, 'answers'), []);
    const store = openStore(root);
    assert.deepEqual(applyBoardAnnotation(store, request, 2000), { ok: true, key });
    assert.deepEqual(applyBoardAnnotation(store, request, 3000), { ok: true, key, duplicate: true });
    assert.equal(ls(root, 'answers').length, 1);
    assert.equal(ls(root, 'claims').filter((n) => n.includes('.stale-')).length, 1);
    const liveId = NOTE_ID.replace('01234567-', '11234567-');
    store.writeNew(`claims/a-${liveId}.json`, { key: `a-${liveId}`, pid: process.pid, at: 1, nonce: 'live' });
    assert.equal(applyBoardAnnotation(store, { ...request, requestId: liveId }, 4000).code, 'IO_ERROR');
    assert.equal(ls(root, 'answers').length, 1);
  } finally { cleanup(root); }
});

test('annotation: a competing commit during stale-claim recovery is duplicate or conflict, never a second answer', () => {
  for (const same of [true, false]) {
    const root = tmpRoot();
    try {
      const store = openStore(root);
      const key = `a-${NOTE_ID}`;
      const request = { sessionId: 's1', requestId: NOTE_ID, text: 'mine' };
      store.writeNew(`claims/${key}.json`, { key, pid: DEAD_PID, at: 1, nonce: 'stale' });
      const result = applyBoardAnnotation(store, request, 2000, { hooks: { beforeReclaim() {
        assert.equal(applyBoardAnnotation(store, { ...request, text: same ? 'mine' : 'winner' }, 1000).ok, true);
      } } });
      assert.deepEqual(result, same ? { ok: true, key, duplicate: true } : { ok: false, code: 'REQUEST_ID_CONFLICT' });
      assert.equal(ls(root, 'answers').length, 1);
      assert.equal(store.readRecord(`answers/${key}.json`).at, 1000);
    } finally { cleanup(root); }
  }
});

test('annotation: unreadable answers fail closed as IO_ERROR without creating a claim', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root, { fs: denyReads(`answers/a-${NOTE_ID}.json`, 'EIO') });
    assert.equal(applyBoardAnnotation(store, { sessionId: 's1', requestId: NOTE_ID, text: 'hi' }, 1000).code, 'IO_ERROR');
    assert.deepEqual(ls(root, 'claims'), []);
  } finally { cleanup(root); }
});
