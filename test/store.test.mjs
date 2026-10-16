import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, isPidAlive } from '../src/store.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CHILD = join(HERE, 'helpers', 'store-child.mjs');
const DEAD_PID = 2147480000;

function tmpRoot() {
  return realFs.mkdtempSync(join(tmpdir(), 'omo-store-test-'));
}
function cleanup(root) {
  realFs.rmSync(root, { recursive: true, force: true });
}
function errnoErr(code) {
  const e = new Error(code + ': injected');
  e.code = code;
  return e;
}
const deadPidOnly = (pid) => pid !== DEAD_PID && isPidAlive(pid);

test('writeNew refuses to overwrite (wx) and creates parent folders lazily', () => {
  const root = tmpRoot();
  try {
    const store = openStore(join(root, 'state'));
    assert.equal(realFs.existsSync(join(root, 'state')), false, 'open must not create folders');
    store.writeNew('decisions/000001.json', { id: 1 });
    assert.deepEqual(JSON.parse(realFs.readFileSync(join(root, 'state/decisions/000001.json'), 'utf8')), { id: 1 });
    assert.throws(() => store.writeNew('decisions/000001.json', { id: 99 }), { code: 'EEXIST' });
    assert.equal(JSON.parse(realFs.readFileSync(join(root, 'state/decisions/000001.json'), 'utf8')).id, 1);
  } finally { cleanup(root); }
});

test('paths that escape the root or touch senpi-task are rejected', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root);
    for (const bad of ['../x.json', 'a/../../x.json', '/abs.json', 'C:/abs.json', '', '.omo/senpi-task/tasks/x.json']) {
      assert.throws(() => store.writeNew(bad, {}), /invalid store path/, bad);
      assert.throws(() => store.replace(bad, {}), /invalid store path/, bad);
    }
  } finally { cleanup(root); }
});

test('replace writes via tmp+rename and leaves no tmp files', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root);
    store.replace('settings.json', { enabled: false });
    store.replace('settings.json', { enabled: true });
    store.replace('index.html', '<html></html>');
    assert.deepEqual(JSON.parse(realFs.readFileSync(join(root, 'settings.json'), 'utf8')), { enabled: true });
    assert.equal(realFs.readFileSync(join(root, 'index.html'), 'utf8'), '<html></html>');
    assert.deepEqual(realFs.readdirSync(root).sort(), ['index.html', 'settings.json']);
  } finally { cleanup(root); }
});

test('replace: 3 EPERM renames then success (20/40/80ms backoff)', () => {
  const root = tmpRoot();
  try {
    let calls = 0;
    const sleeps = [];
    const fs = { ...realFs, renameSync(a, b) { calls++; if (calls <= 3) throw errnoErr('EPERM'); return realFs.renameSync(a, b); } };
    const store = openStore(root, { fs, sleep: (ms) => sleeps.push(ms) });
    store.replace('meta.json', { ok: 1 });
    assert.equal(calls, 4);
    assert.deepEqual(sleeps, [20, 40, 80]);
    assert.deepEqual(realFs.readdirSync(root), ['meta.json']);
    assert.deepEqual(JSON.parse(realFs.readFileSync(join(root, 'meta.json'), 'utf8')), { ok: 1 });
  } finally { cleanup(root); }
});

test('replace: 9 consecutive EPERM -> throw, tmp 남지 않음', () => {
  const root = tmpRoot();
  try {
    let calls = 0;
    const sleeps = [];
    const fs = { ...realFs, renameSync() { calls++; throw errnoErr('EPERM'); } };
    const store = openStore(root, { fs, sleep: (ms) => sleeps.push(ms) });
    assert.throws(() => store.replace('meta.json', { ok: 1 }), { code: 'EPERM' });
    assert.equal(calls, 9);
    assert.deepEqual(sleeps, [20, 40, 80, 160, 320, 640, 1280, 2560]);
    assert.deepEqual(realFs.readdirSync(root), [], 'no tmp or target left');
  } finally { cleanup(root); }
});

test('replace: EBUSY and EACCES are retried, other errors are not', () => {
  const root = tmpRoot();
  try {
    for (const code of ['EBUSY', 'EACCES']) {
      let calls = 0;
      const fs = { ...realFs, renameSync(a, b) { calls++; if (calls === 1) throw errnoErr(code); return realFs.renameSync(a, b); } };
      openStore(root, { fs, sleep() {} }).replace('m.json', { code });
      assert.equal(calls, 2, code);
    }
    let calls = 0;
    const sleeps = [];
    const fs = { ...realFs, renameSync() { calls++; throw errnoErr('ENOSPC'); } };
    assert.throws(() => openStore(root, { fs, sleep: (ms) => sleeps.push(ms) }).replace('n.json', {}), { code: 'ENOSPC' });
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
    assert.deepEqual(realFs.readdirSync(root), ['m.json']);
  } finally { cleanup(root); }
});

// ---- reclaimStale -------------------------------------------------------

function staleSetup(root, pid = DEAD_PID) {
  const store = openStore(root, { isAlive: deadPidOnly });
  const R = { id: 12, pid, at: '2026-10-15T00:00:00.000Z', nonce: 'nonce-A' };
  store.writeNew('claims/000012.json', R);
  return { store, R };
}
const tombstones = (root, dir) => realFs.readdirSync(join(root, dir)).filter((n) => n.includes('.stale-'));

test('reclaimStale: dead pid is reclaimed once; second reclaimer with the same record gets false (deterministic interleave)', () => {
  const root = tmpRoot();
  try {
    const { store, R } = staleSetup(root);
    const readA = store.readRecord('claims/000012.json');
    const readB = store.readRecord('claims/000012.json');
    assert.deepEqual(readA, R);
    assert.deepEqual(readB, R);
    assert.equal(store.reclaimStale('claims/000012.json', readA), true);
    assert.equal(realFs.existsSync(join(root, 'claims/000012.json')), false);
    const fresh = { id: 12, pid: process.pid, at: '2026-10-15T00:00:01.000Z', nonce: 'nonce-A2' };
    store.writeNew('claims/000012.json', fresh);
    assert.equal(store.reclaimStale('claims/000012.json', readB), false);
    assert.deepEqual(JSON.parse(realFs.readFileSync(join(root, 'claims/000012.json'), 'utf8')), fresh);
    const t = tombstones(root, 'claims');
    assert.deepEqual(t, ['000012.json.stale-nonce-A']);
  } finally { cleanup(root); }
});

test('reclaimStale: normal release interleave leaves C\'s new file untouched and no tombstone', () => {
  const root = tmpRoot();
  try {
    const { store, R } = staleSetup(root);
    const readB = store.readRecord('claims/000012.json'); // B reads A's file
    realFs.unlinkSync(join(root, 'claims/000012.json'));  // A releases normally (no tombstone)
    const C = { id: 12, pid: process.pid, at: '2026-10-15T00:00:02.000Z', nonce: 'nonce-C' };
    store.writeNew('claims/000012.json', C);              // C creates a fresh file
    assert.equal(store.reclaimStale('claims/000012.json', readB), false);
    assert.deepEqual(JSON.parse(realFs.readFileSync(join(root, 'claims/000012.json'), 'utf8')), C);
    assert.deepEqual(tombstones(root, 'claims'), []);
    assert.equal(R.nonce, readB.nonce);
  } finally { cleanup(root); }
});

test('reclaimStale: same-nonce file that changed content (at differs) is not removed', () => {
  const root = tmpRoot();
  try {
    const { store, R } = staleSetup(root);
    const rewritten = { ...R, at: '2026-10-15T09:00:00.000Z' };
    realFs.writeFileSync(join(root, 'claims/000012.json'), JSON.stringify(rewritten));
    assert.equal(store.reclaimStale('claims/000012.json', R), false);
    assert.deepEqual(JSON.parse(realFs.readFileSync(join(root, 'claims/000012.json'), 'utf8')), rewritten);
    assert.deepEqual(tombstones(root, 'claims'), []);
  } finally { cleanup(root); }
});

test('reclaimStale: empty/unreadable file is treated as alive, never reclaimed', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root, { isAlive: deadPidOnly });
    realFs.mkdirSync(join(root, 'claims'));
    realFs.writeFileSync(join(root, 'claims/000013.json'), '');
    assert.equal(store.readRecord('claims/000013.json'), null);
    assert.equal(store.reclaimStale('claims/000013.json', null), false);
    assert.equal(store.reclaimStale('claims/000013.json', {}), false);
    assert.equal(realFs.existsSync(join(root, 'claims/000013.json')), true);
    // A record read earlier whose file has since become empty: content mismatch -> false, tombstone removed.
    const R = { id: 13, pid: DEAD_PID, at: 'x', nonce: 'n13' };
    assert.equal(store.reclaimStale('claims/000013.json', R), false);
    assert.equal(realFs.existsSync(join(root, 'claims/000013.json')), true);
    assert.deepEqual(tombstones(root, 'claims'), []);
    realFs.writeFileSync(join(root, 'claims/000014.json'), '{ not json');
    assert.equal(store.readRecord('claims/000014.json'), null);
  } finally { cleanup(root); }
});

test('reclaimStale: live pid is never reclaimed, however old', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root);
    const R = { id: 5, pid: process.pid, at: '2000-01-01T00:00:00.000Z', nonce: 'old' };
    store.writeNew('render.lock', R);
    assert.equal(store.reclaimStale('render.lock', store.readRecord('render.lock')), false);
    assert.deepEqual(JSON.parse(realFs.readFileSync(join(root, 'render.lock'), 'utf8')), R);
    assert.deepEqual(realFs.readdirSync(root), ['render.lock']);
  } finally { cleanup(root); }
});

test('reclaimStale: missing file -> false, no tombstone', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root, { isAlive: deadPidOnly });
    realFs.mkdirSync(join(root, 'claims'));
    assert.equal(store.reclaimStale('claims/000020.json', { pid: DEAD_PID, at: 'x', nonce: 'n' }), false);
    assert.deepEqual(realFs.readdirSync(join(root, 'claims')), []);
  } finally { cleanup(root); }
});

test('reclaimStale: linkSync EPERM -> error, file not deleted', () => {
  const root = tmpRoot();
  try {
    const fs = { ...realFs, linkSync() { throw errnoErr('EPERM'); } };
    const store = openStore(root, { fs, isAlive: deadPidOnly });
    const R = { id: 7, pid: DEAD_PID, at: 'x', nonce: 'n7' };
    store.writeNew('claims/000007.json', R);
    assert.throws(() => store.reclaimStale('claims/000007.json', R), /수동 확인 필요/);
    assert.deepEqual(JSON.parse(realFs.readFileSync(join(root, 'claims/000007.json'), 'utf8')), R);
    assert.deepEqual(tombstones(root, 'claims'), []);
  } finally { cleanup(root); }
});

// ---- decision ids -------------------------------------------------------

test('allocDecisionId: max+1, never reuses, EEXIST bumps to next', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root);
    assert.equal(store.allocDecisionId({ question: 'q1' }), 1);
    assert.equal(store.allocDecisionId({ question: 'q2' }), 2);
    realFs.writeFileSync(join(root, 'decisions/000010.json'), '{}');
    assert.equal(store.allocDecisionId(), 11);
    assert.deepEqual(JSON.parse(realFs.readFileSync(join(root, 'decisions/000001.json'), 'utf8')), { question: 'q1', id: 1 });
    // race: another process takes max+1 between our scan and our wx
    let first = true;
    const fs = { ...realFs, writeFileSync(p, d, o) {
      if (first && /000012\.json$/.test(p)) { first = false; realFs.writeFileSync(p, '{"id":12,"other":true}', o); }
      return realFs.writeFileSync(p, d, o);
    } };
    const racer = openStore(root, { fs });
    assert.equal(racer.allocDecisionId({ question: 'raced' }), 13);
    assert.equal(JSON.parse(realFs.readFileSync(join(root, 'decisions/000012.json'), 'utf8')).other, true);
  } finally { cleanup(root); }
});

function runChild(args, onMessage) {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD, args, { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('child timeout')); }, 60000);
    child.on('message', (m) => onMessage?.(m, child));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('child exit ' + code)); });
  });
}

test('allocDecisionId: 4 processes x 25 ids -> 100 distinct', async () => {
  const root = tmpRoot();
  try {
    const ids = [];
    await Promise.all([0, 1, 2, 3].map((n) => runChild(['alloc', root, '25'], (m) => { if (m.type === 'ids') ids.push(...m.ids); })));
    assert.equal(ids.length, 100);
    assert.equal(new Set(ids).size, 100);
    assert.equal(Math.min(...ids), 1);
    assert.equal(Math.max(...ids), 100);
    assert.equal(realFs.readdirSync(join(root, 'decisions')).length, 100);
  } finally { cleanup(root); }
});

// ---- snapshot -----------------------------------------------------------

test('readSnapshot: reads the whole layout, broken JSON goes to readErrors, others still read', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root);
    store.writeSettings({ enabled: false });
    store.replace('sessions/s1/meta.json', { sessionId: 's1', title: 'T' });
    store.writeNew('sessions/s1/briefs/000001.json', { title: 'b1' });
    store.writeNew('sessions/s1/briefs/000002.json', { title: 'b2' });
    const id = store.allocDecisionId({ sessionId: 's1', question: 'q' });
    store.writeNew('decision-closures/000009.json', { id: 9, reason: 'withdrawn', at: 'x' });
    store.writeNew(`answers/${String(id).padStart(6, '0')}.json`, { id, option: 'A', at: 'x', fromSessionId: 's2' });
    store.writeNew('claims/000001.json', { id: 1, pid: 1, at: 'x', nonce: 'n' });
    store.writeNew('receipts/000001.json', { id: 1, sessionId: 's1', kind: 'started' });
    store.replace('mirror/s1.json', { q: 'open' });
    store.replace('published.json', { seq: 3, dataHash: 'h', at: 'x' });
    store.writeNew('render.lock', { pid: 1, at: 'x', nonce: 'n' });
    realFs.writeFileSync(join(root, 'decisions/000007.json'), '{ broken');
    realFs.writeFileSync(join(root, 'sessions/s1/briefs/000003.json'), '');
    realFs.writeFileSync(join(root, 'decisions/000001.json.stale-abc'), '{"id":1}');
    realFs.writeFileSync(join(root, 'decisions/000001.json.123.abc.tmp'), '{"id":1}');
    const snap = store.readSnapshot();
    assert.deepEqual(snap.settings, { enabled: false });
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0].sid, 's1');
    assert.equal(snap.sessions[0].meta.title, 'T');
    assert.deepEqual(snap.sessions[0].briefs.map((b) => [b.seq, b.data.title]), [[1, 'b1'], [2, 'b2']]);
    assert.deepEqual(snap.decisions.map((d) => d.id), [1]);
    assert.equal(snap.closures.length, 1);
    assert.equal(snap.answers[0].option, 'A');
    assert.equal(snap.claims.length, 1);
    assert.equal(snap.receipts.length, 1);
    assert.deepEqual(snap.mirror, [{ sid: 's1', data: { q: 'open' } }]);
    assert.equal(snap.published.seq, 3);
    assert.deepEqual(snap.readErrors.map((e) => e.rel).sort(), ['decisions/000007.json', 'sessions/s1/briefs/000003.json']);
    assert.ok(snap.maxMtime > 0);
  } finally { cleanup(root); }
});

test('readSnapshot: empty/missing root is fine; maxMtime ignores published output and lock', () => {
  const root = tmpRoot();
  try {
    const store = openStore(join(root, 'nope'));
    const snap = store.readSnapshot();
    assert.deepEqual(snap.decisions, []);
    assert.deepEqual(snap.readErrors, []);
    assert.deepEqual(snap.settings, { enabled: true });
    assert.equal(snap.maxMtime, 0);
    const s2 = openStore(join(root, 'real'));
    s2.replace('sessions/a/meta.json', { sessionId: 'a' });
    const m1 = s2.readSnapshot().maxMtime;
    const old = new Date(Date.now() - 3600_000);
    realFs.utimesSync(join(root, 'real/sessions/a/meta.json'), old, old);
    const m0 = s2.readSnapshot().maxMtime;
    assert.ok(m0 < m1);
    s2.replace('data.js', 'x'); s2.replace('index.html', 'x'); s2.replace('published.json', { seq: 1 });
    s2.writeNew('render.lock', { pid: 1, at: 'x', nonce: 'n' });
    assert.equal(s2.readSnapshot().maxMtime, m0);
  } finally { cleanup(root); }
});

test('settings: default enabled, round trip, broken file falls back to enabled', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root);
    assert.deepEqual(store.readSettings(), { enabled: true });
    store.writeSettings({ enabled: false });
    assert.deepEqual(store.readSettings(), { enabled: false });
    realFs.writeFileSync(join(root, 'settings.json'), '{ nope');
    assert.deepEqual(store.readSettings(), { enabled: true });
  } finally { cleanup(root); }
});

test('briefs: writing the 21st brief of a session deletes the oldest one only', () => {
  const root = tmpRoot();
  try {
    const store = openStore(root);
    for (let i = 1; i <= 20; i++) store.writeNew(`sessions/s1/briefs/${String(i).padStart(6, '0')}.json`, { i });
    store.writeNew('sessions/s2/briefs/000001.json', { other: true });
    store.writeNew('decisions/000001.json', { id: 1 });
    assert.equal(realFs.readdirSync(join(root, 'sessions/s1/briefs')).length, 20);
    assert.equal(store.nextBriefSeq('s1'), 21);
    store.writeNew('sessions/s1/briefs/000021.json', { i: 21 });
    const names = realFs.readdirSync(join(root, 'sessions/s1/briefs')).sort();
    assert.equal(names.length, 20);
    assert.equal(names[0], '000002.json');
    assert.equal(names[19], '000021.json');
    assert.equal(realFs.readdirSync(join(root, 'sessions/s2/briefs')).length, 1);
    assert.equal(store.nextBriefSeq('s-new'), 1);
  } finally { cleanup(root); }
});

// ---- readers vs. the Windows replace window ----------------------------

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test('readText: transient ENOENT while a replace is in flight is retried, then succeeds', () => {
  const root = tmpRoot();
  try {
    openStore(root).replace('meta.json', { ok: 1 });
    realFs.writeFileSync(join(root, 'meta.json.123.deadbeef.tmp'), '{}'); // a concurrent replace()'s tmp
    let calls = 0;
    const sleeps = [];
    const fs = { ...realFs, readFileSync(...a) { if (++calls <= 3) throw errnoErr('ENOENT'); return realFs.readFileSync(...a); } };
    const store = openStore(root, { fs, sleep: (ms) => sleeps.push(ms) });
    assert.deepEqual(JSON.parse(store.readText('meta.json')), { ok: 1 });
    assert.equal(calls, 4);
    assert.deepEqual(sleeps, [2, 4, 8]);
  } finally { cleanup(root); }
});

test('readText: ENOENT with the target existing but never readable gives up as missing within 250ms of backoff', () => {
  const root = tmpRoot();
  try {
    openStore(root).replace('meta.json', { ok: 1 });
    const sleeps = [];
    const fs = { ...realFs, readFileSync() { throw errnoErr('ENOENT'); } };
    const store = openStore(root, { fs, sleep: (ms) => sleeps.push(ms) });
    assert.equal(store.readText('meta.json'), null);
    assert.ok(sleeps.length > 0 && sum(sleeps) <= 250, 'bounded backoff: ' + sum(sleeps));
    sleeps.length = 0;
    assert.equal(store.readRecord('meta.json'), null);
    assert.ok(sleeps.length > 0 && sum(sleeps) <= 250, 'bounded backoff: ' + sum(sleeps));
  } finally { cleanup(root); }
});

test('readText: a genuinely absent file is missing at once (no backoff), readSnapshot too', () => {
  const root = tmpRoot();
  try {
    const sleeps = [];
    const store = openStore(root, { sleep: (ms) => sleeps.push(ms) });
    assert.equal(store.readText('settings.json'), null);
    assert.equal(store.readRecord('sessions/s1/meta.json'), null);
    assert.equal(store.readSettings().enabled, true);
    const snap = store.readSnapshot();
    assert.deepEqual(snap.readErrors, []);
    assert.equal(snap.published, null);
    assert.deepEqual(sleeps, []);
  } finally { cleanup(root); }
});

test('readText/readSnapshot: transient EPERM and EBUSY are retried; a persistent one throws / lands in readErrors after the bound', () => {
  const root = tmpRoot();
  try {
    openStore(root).replace('settings.json', { enabled: false });
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      let calls = 0;
      const fs = { ...realFs, readFileSync(...a) { if (++calls <= 2) throw errnoErr(code); return realFs.readFileSync(...a); } };
      const store = openStore(root, { fs, sleep() {} });
      assert.equal(store.readSettings().enabled, false, code);
      assert.equal(calls, 3, code);
    }
    const sleeps = [];
    const fs = { ...realFs, readFileSync(f, ...a) { if (String(f).endsWith('settings.json')) throw errnoErr('EPERM'); return realFs.readFileSync(f, ...a); } };
    const store = openStore(root, { fs, sleep: (ms) => sleeps.push(ms) });
    assert.throws(() => store.readText('settings.json'), { code: 'EPERM' });
    assert.ok(sum(sleeps) <= 250, 'bounded backoff: ' + sum(sleeps));
    sleeps.length = 0;
    const snap = store.readSnapshot();
    assert.ok(sum(sleeps) <= 250, 'bounded backoff: ' + sum(sleeps));
    assert.equal(snap.readErrors.length, 1);
    assert.equal(snap.readErrors[0].rel, 'settings.json');
  } finally { cleanup(root); }
});

// ---- concurrency stress -------------------------------------------------

const STRESS_REPLACES = 1000; // per writer

function stress(execPath) {
  return new Promise((resolve, reject) => {
    const root = tmpRoot();
    const opts = { execPath, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] };
    const reader = fork(CHILD, ['reader', root], opts);
    const writers = [1, 2].map((w) => fork(CHILD, ['writer', root, String(w), String(STRESS_REPLACES)], opts));
    const all = [reader, ...writers];
    let done = 0;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const c of all) { try { c.kill(); } catch {} }
      cleanup(root);
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('stress timeout 120s')), 120000);
    for (const c of all) c.on('error', finish);
    reader.on('message', (m) => {
      if (m.type === 'ready') for (const w of writers) w.send({ type: 'go' }); // reader watches before writers start
      else if (m.type === 'final') finish(null, m);
    });
    reader.on('exit', (code) => { if (!settled && code !== 0) finish(new Error('reader exit ' + code)); });
    for (const w of writers) {
      w.on('message', (m) => {
        if (m.type === 'replaced') reader.send({ type: 'check' });
        else if (m.type === 'done' && ++done === 2) reader.send({ type: 'final' });
        else if (m.type === 'error') finish(new Error('writer failed: ' + m.message));
      });
      w.on('exit', (code) => { if (!settled && code !== 0) finish(new Error('writer exit ' + code)); });
    }
  });
}

function assertStress(r) {
  assert.equal(r.failures, 0, 'reader failures: ' + JSON.stringify(r.failureSamples));
  assert.ok(r.reads >= 2 * STRESS_REPLACES, 'reader performed at least one read per replace, got ' + r.reads);
  assert.ok([1, 2].some((w) => r.content.w === w && r.content.i === STRESS_REPLACES - 1), 'final content is one writer\'s last value: ' + JSON.stringify(r.content));
}

test('stress (node): 2 writers x 1000 replace + immediate reader on IPC/fs.watch, 0 failures', { timeout: 130000 }, async () => {
  assertStress(await stress(process.execPath));
});

test('stress (bun, if installed): same scenario', { timeout: 130000, skip: !realFs.existsSync('C:/Users/USER/.bun/bin/bun.exe') }, async () => {
  assertStress(await stress('C:/Users/USER/.bun/bin/bun.exe'));
});
