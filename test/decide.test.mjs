import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store.mjs';
import { parseDecide, applyDecide, formatDecideResult } from '../src/decide.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CHILD = join(HERE, 'helpers', 'decide-child.mjs');
const PAUSED_B = join(HERE, 'helpers', 'decide-paused-b.mjs');
const DEAD_PID = 2147480000;

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
  return new Promise((resolve, reject) => {
    const kids = [fork(CHILD, [root, textA, 'sA']), fork(CHILD, [root, textB, 'sB'])];
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
