import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { fork, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerHost, SERVER_LOCK, SERVER_JSON, CHECK_EVERY_MS, POLL_MS } from '../src/server-host.mjs';
import { createBoardServer } from '../src/server.mjs';
import { openStore, isPidAlive } from '../src/store.mjs';

const HELPER = fileURLToPath(new URL('./helpers/server-child.mjs', import.meta.url));
const REGISTRY = Symbol.for('omo.briefing.server');
const DEAD_PID = 2147480000;
const LOCK_FIELDS = ['at', 'generation', 'nonce', 'pid', 'port', 'sessionId'];

// Ports >= 47390 and below the Windows dynamic range (49152+). Tests alternate between two 12-port windows per process;
// the bound port is always read back, so a collision with a parallel suite only moves the scan.
let windowNo = 0;
const nextBase = () => 47400 + (process.pid % 60) * 24 + (windowNo++ % 2) * 12;

const tempState = () => mkdtempSync(join(os.tmpdir(), 'omo-server-host-'));
const removeState = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
const lockPath = (dir) => join(dir, SERVER_LOCK);
const jsonPath = (dir) => join(dir, SERVER_JSON);
const portOf = (url) => Number(new URL(url).port);
const registrySize = () => (globalThis[REGISTRY] ? globalThis[REGISTRY].servers.size : 0);

// This generation's view model, built from the store (never from a data.js). seq and gen are filled in by the host.
const buildViewModel = (snap) => ({
  sessions: snap.sessions.map((s) => ({ id: s.sid, plan: s.meta?.plan ?? null, live: s.meta?.auto?.live ?? null })),
});
const pageOf = (vm) =>
  `<!doctype html><meta name="omo-briefing-generation" content="4"><script type="application/json" id="vm">${JSON.stringify(vm)}</script>`;

function seed(dir, seq = 5) {
  const store = openStore(dir);
  store.replace('sessions/s1/meta.json', { sessionId: 's1', plan: { goal: '목표' }, auto: { live: { workers: [{ id: 'st_1', state: 'running' }] } } });
  store.replace('published.json', { seq, dataHash: 'x', at: 1 });
  return store;
}

function manualTimers() {
  const intervals = new Map();
  let next = 0;
  return {
    setInterval(fn, ms) {
      const h = { id: ++next, fn, ms, unrefd: false, unref() { h.unrefd = true; return h; } };
      intervals.set(h.id, h);
      return h;
    },
    clearInterval(h) {
      if (h) intervals.delete(h.id);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    active: () => [...intervals.values()],
    async fire(ms) {
      for (const h of [...intervals.values()]) if (h.ms === ms) await h.fn();
    },
  };
}

function makeHost(dir, over = {}) {
  const store = openStore(dir);
  const errors = [];
  const recovered = [];
  const changes = [];
  const timers = manualTimers();
  let boards = 0;
  const host = createServerHost({
    stateDir: dir,
    sessionId: over.sessionId ?? 'lead-1',
    generation: 4,
    isEnabled: () => store.readSettings().enabled !== false,
    readSnapshot: () => store.readSnapshot(),
    buildViewModel,
    getPage: pageOf,
    reclaimStale: (rel, rec) => store.reclaimStale(rel, rec),
    onError: (key, err) => errors.push({ key, code: err.code, message: err.message }),
    onRecover: (key) => recovered.push(key),
    onChange: (s) => changes.push(s),
    env: { OMO_BRIEFING_PORT_BASE: String(over.portBase ?? nextBase()) },
    timers,
    createBoardServer: (o) => {
      boards += 1;
      return createBoardServer(o);
    },
    ...over.opts,
  });
  return { host, store, errors, recovered, changes, timers, boards: () => boards };
}

function get(port, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false, headers: { Connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function sse(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, (res) => {
      let buf = '';
      const waiters = new Set();
      const wake = () => { for (const w of [...waiters]) w(); };
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; wake(); });
      res.on('close', wake);
      res.on('error', wake); // an owner going away aborts the stream; waiters then match or time out with the text so far
      const api = {
        status: res.statusCode,
        get text() { return buf; },
        frames: () => [...buf.matchAll(/event: data\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1])),
        waitFor(check, ms, what) {
          return new Promise((ok, fail) => {
            const w = () => {
              const v = check(api);
              if (v) { done(); ok(v); }
            };
            const timer = setTimeout(() => { done(); fail(new Error(`timeout ${ms}ms waiting for ${what}; got ${JSON.stringify(buf).slice(0, 300)}`)); }, ms);
            const done = () => { clearTimeout(timer); waiters.delete(w); };
            waiters.add(w);
            w();
          });
        },
        frame(pred, ms, what) {
          return api.waitFor(() => api.frames().find(pred), ms, what);
        },
        close: () => req.destroy(),
        closed: new Promise((r) => res.on('close', r)),
      };
      resolve(api);
    });
    req.on('error', reject);
  });
}

function occupy(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => (e.code === 'EADDRINUSE' || e.code === 'EACCES' ? resolve(null) : reject(e)));
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}
const closeNet = (s) => new Promise((r) => (s ? s.close(r) : r()));
async function freePortFrom(base) {
  for (let p = base; p < base + 12; p++) {
    const s = await occupy(p);
    if (s) { await closeNet(s); return p; }
  }
  throw new Error(`no free port in ${base}..${base + 11}`);
}

// ---- real child processes (test/helpers/server-child.mjs) ----
const children = [];

function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`timeout ${ms}ms: ${what}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function startChild(stateDir, sessionId, portBase) {
  const child = fork(HELPER, [stateDir, sessionId, String(portBase)], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  children.push(child);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.resume();
  const closed = new Promise((r) => child.once('close', r));
  const seen = [];
  const listeners = new Set();
  child.on('message', (m) => {
    seen.push(m);
    for (const l of [...listeners]) l(m);
  });
  function waitFor(pred, ms, what) {
    const hit = seen.find(pred);
    if (hit) return Promise.resolve(hit);
    let l;
    return within(new Promise((ok) => {
      l = (m) => { if (pred(m)) ok(m); };
      listeners.add(l);
    }), ms, `${sessionId}: ${what}; stderr=${stderr}`).finally(() => listeners.delete(l));
  }
  let id = 0;
  function call(cmd, ms = 5000) {
    const myId = ++id;
    child.send({ id: myId, cmd });
    return waitFor((m) => m.id === myId, ms, cmd);
  }
  const ready = waitFor((m) => m.type === 'ready', 10000, 'ready');
  return { child, call, waitFor, closed, ready, seen, get stderr() { return stderr; } };
}

async function stopChild(c) {
  if (c.child.exitCode === null && c.child.signalCode === null) {
    c.child.send({ id: -1, cmd: 'exit' });
    try {
      await within(c.closed, 5000, 'child exit');
    } catch (err) {
      c.child.kill();
      await within(c.closed, 5000, 'child kill');
      throw err;
    }
  }
  await c.closed;
}

// ---------------------------------------------------------------------------------------------------------------

test('paused start: ensure makes no lock, opens no port, keeps no timer', async () => {
  const dir = tempState();
  try {
    const t = makeHost(dir);
    t.store.writeSettings({ enabled: false });
    assert.equal(await t.host.ensure(), null);
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(existsSync(jsonPath(dir)), false);
    assert.equal(t.boards(), 0);
    assert.deepEqual(t.timers.active(), []);
    assert.equal(t.host.status().role, 'paused');
    await t.host.release();
  } finally {
    removeState(dir);
  }
});

test('ensure makes this process the owner: lock and server.json carry the reclaimable record; GET / is this generation', async () => {
  const dir = tempState();
  try {
    seed(dir);
    // an older generation left an unstamped page and an old-shape data.js: the server never serves either
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>old</title>');
    writeFileSync(join(dir, 'data.js'), '/* seq:5 */\nwindow.__briefData && window.__briefData({"seq":5,"sessions":[{"id":"s1"}]});\n');
    const t = makeHost(dir, { sessionId: 'lead-A' });
    const r = await t.host.ensure();
    assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const port = portOf(r.url);
    assert.ok(port >= 47390);
    const lockText = readFileSync(lockPath(dir), 'utf8');
    const lock = JSON.parse(lockText);
    assert.deepEqual(Object.keys(lock).sort(), LOCK_FIELDS);
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.port, port);
    assert.equal(lock.sessionId, 'lead-A');
    assert.equal(lock.generation, 4);
    assert.equal(typeof lock.nonce, 'string');
    assert.ok(Number.isFinite(lock.at));
    assert.deepEqual(JSON.parse(readFileSync(jsonPath(dir), 'utf8')), lock);
    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /content="4"/);
    assert.doesNotMatch(page.body, /<title>old/);
    const vm = JSON.parse(/id="vm">(.*)<\/script>/.exec(page.body)[1]);
    assert.equal(vm.seq, 5, 'seq comes from published.json');
    assert.equal(vm.gen, 4);
    assert.equal(vm.sessions[0].plan.goal, '목표');
    const health = JSON.parse((await get(port, '/health')).body);
    assert.equal(health.pid, process.pid);
    assert.equal(t.host.status().role, 'owner');
    assert.ok(t.timers.active().every((h) => h.unrefd), 'every timer is unref()ed');
    assert.equal(t.changes.at(-1).role, 'owner');
    await t.host.release();
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(existsSync(jsonPath(dir)), false);
    assert.equal(registrySize(), 0);
    await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
  } finally {
    removeState(dir);
  }
});

test('a second host in the same process takes over the one server; the displaced host\'s release leaves it running', async () => {
  const dir = tempState();
  try {
    seed(dir);
    const portBase = nextBase();
    const a = makeHost(dir, { sessionId: 'lead-A', portBase });
    const b = makeHost(dir, { sessionId: 'lead-B', portBase });
    const ra = await a.host.ensure();
    const rb = await b.host.ensure();
    assert.equal(rb.url, ra.url);
    assert.equal(a.boards() + b.boards(), 1, 'one board server in this process');
    assert.equal(registrySize(), 1);
    await a.host.release();
    assert.equal((await get(portOf(ra.url), '/')).status, 200, 'still served after the displaced host released');
    assert.ok(existsSync(lockPath(dir)));
    await b.host.release();
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(registrySize(), 0);
  } finally {
    removeState(dir);
  }
});

test('release removes only its own lock: a lock whose content changed is left alone', async () => {
  const dir = tempState();
  try {
    const t = makeHost(dir);
    await t.host.ensure();
    const other = JSON.stringify({ pid: process.pid, at: 1, nonce: 'someone-else', sessionId: 'x', port: 1, generation: 4 });
    writeFileSync(lockPath(dir), other);
    await t.host.release();
    assert.equal(readFileSync(lockPath(dir), 'utf8'), other);
    assert.equal(existsSync(jsonPath(dir)), false, 'server.json still carried our nonce, so it was ours to remove');
  } finally {
    removeState(dir);
  }
});

test('lock removal EPERM: server:lock error, the lock and its nonce are kept, the next ensure removes its own leftover and owns again', async () => {
  const dir = tempState();
  try {
    const failing = { on: true };
    const fs = {
      ...fsp,
      unlink: async (p) => {
        if (failing.on && String(p).endsWith(SERVER_LOCK)) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${p}'`), { code: 'EPERM' });
        return fsp.unlink(p);
      },
    };
    const t = makeHost(dir, { opts: { fs } });
    await t.host.ensure();
    const first = readFileSync(lockPath(dir), 'utf8');
    await t.host.release();
    assert.deepEqual(t.errors.map((e) => e.key), ['server:lock']);
    assert.match(t.errors[0].message, /EPERM/);
    assert.equal(readFileSync(lockPath(dir), 'utf8'), first, 'lock left exactly as it was');
    failing.on = false;
    t.recovered.length = 0;
    const again = await t.host.ensure();
    assert.ok(again, 'own leftover (same pid, verified content) removed, ownership taken again');
    assert.notEqual(readFileSync(lockPath(dir), 'utf8'), first);
    assert.ok(t.recovered.includes('server:lock'));
    await t.host.release();
    assert.equal(existsSync(lockPath(dir)), false);
  } finally {
    removeState(dir);
  }
});

test('a dead owner\'s lock is reclaimed through reclaimStale and its port is tried first', async () => {
  const dir = tempState();
  try {
    const portBase = nextBase();
    const deadPort = await freePortFrom(portBase + 5);
    const stale = { pid: DEAD_PID, at: 1, nonce: 'dead-nonce', sessionId: 'old', port: deadPort, generation: 4 };
    writeFileSync(lockPath(dir), JSON.stringify(stale));
    const t = makeHost(dir, { portBase });
    const r = await t.host.ensure();
    assert.equal(portOf(r.url), deadPort);
    assert.ok(existsSync(join(dir, `${SERVER_LOCK}.stale-dead-nonce`)), 'reclaimed by store.reclaimStale (tombstone)');
    assert.equal(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid, process.pid);
    await t.host.release();
  } finally {
    removeState(dir);
  }
});

test('pid alive but /health refused 3 times in a row: no hand-over and a server:lock error on the 3rd; a real death then hands over', async () => {
  const dir = tempState();
  const idle = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore', windowsHide: true });
  children.push(idle);
  const idleClosed = new Promise((r) => idle.once('close', r));
  try {
    await within(new Promise((r) => idle.once('spawn', r)), 5000, 'idle spawn');
    const portBase = nextBase();
    const port = await freePortFrom(portBase + 3);
    const reused = JSON.stringify({ pid: idle.pid, at: 1, nonce: 'reused', sessionId: 'old', port, generation: 4 });
    writeFileSync(lockPath(dir), reused);
    const t = makeHost(dir, { portBase });
    assert.equal(await t.host.ensure(), null);
    assert.deepEqual(t.errors, []);
    await t.timers.fire(CHECK_EVERY_MS);
    assert.deepEqual(t.errors, [], 'two refusals: no chip yet');
    await t.timers.fire(CHECK_EVERY_MS);
    assert.deepEqual(t.errors.map((e) => e.key), ['server:lock']);
    assert.equal(t.host.status().refused, 3);
    assert.equal(readFileSync(lockPath(dir), 'utf8'), reused, 'never taken while the pid lives');
    assert.equal(t.boards(), 0);
    idle.kill();
    await within(idleClosed, 5000, 'idle exit');
    await t.timers.fire(CHECK_EVERY_MS);
    assert.equal(t.host.status().role, 'owner');
    assert.equal(t.host.status().port, port);
    assert.ok(t.recovered.includes('server:lock'));
    await t.host.release();
  } finally {
    if (idle.exitCode === null && idle.signalCode === null) idle.kill();
    await idleClosed;
    removeState(dir);
  }
});

test('NO_PORT: all 10 ports taken -> ensure null + server:listen error, no lock; a throwing onError never escapes', async () => {
  const dir = tempState();
  const portBase = nextBase();
  const held = [];
  try {
    for (let p = portBase; p < portBase + 10; p++) held.push(await occupy(p));
    const t = makeHost(dir, { portBase });
    assert.equal(await t.host.ensure(), null);
    const listen = t.errors.filter((e) => e.key === 'server:listen');
    assert.equal(listen.length, 1);
    assert.equal(listen[0].code, 'NO_PORT');
    assert.match(listen[0].message, new RegExp(`${portBase}~${portBase + 9}`));
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(registrySize(), 0);
    assert.equal(t.host.status().role, 'unavailable');
    await t.host.release();
    assert.deepEqual(t.timers.active(), []);

    const warnings = [];
    const onWarning = (w) => warnings.push(w);
    process.on('warning', onWarning);
    try {
      const u = makeHost(dir, { portBase, opts: { onError: () => { throw new Error('callback bug'); } } });
      assert.equal(await u.host.ensure(), null);
      await u.host.release();
    } finally {
      process.off('warning', onWarning);
    }
  } finally {
    for (const s of held) await closeNet(s);
    removeState(dir);
  }
});

test('change detection: no browser -> no stat of published.json; one browser -> the poll and our own publish reach it', async () => {
  const dir = tempState();
  try {
    const store = seed(dir, 5);
    let stats = 0;
    const fs = {
      ...fsp,
      stat: async (p, o) => {
        if (String(p).endsWith('published.json')) stats += 1;
        return fsp.stat(p, o);
      },
    };
    const t = makeHost(dir, { opts: { fs } });
    const r = await t.host.ensure();
    t.host.notifyPublished();
    t.host.notifyPublished();
    await t.timers.fire(CHECK_EVERY_MS);
    assert.equal(stats, 0);
    assert.equal(t.timers.active().filter((h) => h.ms === POLL_MS).length, 0, 'no poll timer without a browser');

    const s = await sse(portOf(r.url));
    await s.frame((f) => f.seq === 5, 2000, 'first frame');
    assert.equal(t.timers.active().filter((h) => h.ms === POLL_MS).length, 1);
    store.replace('published.json', { seq: 6, dataHash: 'y', at: 2 }); // another writer's publish
    await t.timers.fire(POLL_MS);
    const six = await s.frame((f) => f.seq === 6, 2000, 'seq 6 via poll');
    assert.equal(six.sessions[0].plan.goal, '목표');
    assert.ok(stats > 0);

    store.replace('published.json', { seq: 7, dataHash: 'z', at: 3 }); // our own publish: no timer needed
    t.host.notifyPublished();
    const seven = await s.frame((f) => f.seq === 7, 1000, 'seq 7 via notifyPublished');
    assert.ok(seven.sessions[0].live.workers.length === 1);
    s.close();
    await s.closed;
    await t.host.release();
  } finally {
    removeState(dir);
  }
});

test('pause: the owner sends event: paused, closes, removes only its own lock and server.json, keeps no timer', async () => {
  const dir = tempState();
  try {
    const store = seed(dir);
    const t = makeHost(dir);
    const r = await t.host.ensure();
    const s = await sse(portOf(r.url));
    await s.frame((f) => f.seq === 5, 2000, 'first frame');
    store.writeSettings({ enabled: false });
    await t.host.onPaused();
    await s.waitFor((x) => /event: paused\n/.test(x.text), 2000, 'paused event');
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(existsSync(jsonPath(dir)), false);
    assert.deepEqual(t.timers.active(), []);
    assert.equal(t.host.status().role, 'paused');
    await assert.rejects(get(portOf(r.url), '/health'), { code: 'ECONNREFUSED' });
    assert.equal(await t.host.ensure(), null, 'still paused: no lock');
    assert.equal(existsSync(lockPath(dir)), false);
    await t.host.release();
  } finally {
    removeState(dir);
  }
});

test('the owner notices a pause made by another session on its own check', async () => {
  const dir = tempState();
  try {
    const store = seed(dir);
    const t = makeHost(dir);
    const r = await t.host.ensure();
    const s = await sse(portOf(r.url));
    await s.frame((f) => f.seq === 5, 2000, 'first frame');
    store.writeSettings({ enabled: false }); // /brief off in another conversation
    await t.timers.fire(CHECK_EVERY_MS);
    await s.waitFor((x) => /event: paused\n/.test(x.text), 2000, 'paused event');
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(t.host.status().role, 'paused');
    assert.deepEqual(t.timers.active(), []);
    await t.host.release();
  } finally {
    removeState(dir);
  }
});

test('release with 3 SSE clients connected finishes within 500ms', async () => {
  const dir = tempState();
  try {
    seed(dir);
    const t = makeHost(dir);
    const r = await t.host.ensure();
    const clients = await Promise.all([1, 2, 3].map(() => sse(portOf(r.url))));
    await Promise.all(clients.map((c) => c.frame((f) => f.seq === 5, 2000, 'first frame')));
    const t0 = performance.now();
    await t.host.release();
    const ms = performance.now() - t0;
    assert.ok(ms <= 500, `release took ${ms}ms`);
    await Promise.all(clients.map((c) => within(c.closed, 2000, 'client closed')));
    assert.equal(existsSync(lockPath(dir)), false);
  } finally {
    removeState(dir);
  }
});

// ---- two real processes ----

test('real processes: A owns, B reuses the same port; killing A hands over to B within 10s on the same port', { timeout: 40000 }, async (t) => {
  const dir = tempState();
  const portBase = nextBase();
  let a;
  let b;
  try {
    seed(dir, 5);
    a = startChild(dir, 'lead-A', portBase);
    await a.ready;
    const ra = (await a.call('ensure')).result;
    assert.ok(ra && ra.url);
    b = startChild(dir, 'lead-B', portBase);
    await b.ready;
    const rb = (await b.call('ensure')).result;
    assert.equal(rb.url, ra.url, 'B reuses A\'s server');
    assert.equal((await b.call('status')).status.role, 'client');
    const oldSse = await sse(portOf(ra.url));
    await oldSse.frame((f) => f.seq === 5, 2000, 'first frame from A');

    const killAt = Date.now();
    a.child.kill();
    await within(a.closed, 5000, 'A exit');
    const owned = await b.waitFor((m) => m.type === 'change' && m.status.role === 'owner', 10000, 'B owns');
    const handoverMs = owned.at - killAt;
    t.diagnostic(`handover ms=${handoverMs} oldPort=${portOf(ra.url)} newPort=${owned.status.port}`);
    assert.ok(handoverMs < 10000, `handover took ${handoverMs}ms`);
    assert.equal(owned.status.port, portOf(ra.url), 'the dead owner\'s port is tried first');
    const lock = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
    assert.equal(lock.pid, b.child.pid);
    assert.equal(lock.sessionId, 'lead-B');
    const page = await get(owned.status.port, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /content="4"/);
    const s = await sse(owned.status.port);
    const f = await s.frame((x) => x.seq === 5, 2000, 'first frame from B');
    assert.equal(f.sessions[0].plan.goal, '목표');
    assert.equal(f.sessions[0].live.workers[0].id, 'st_1');
    s.close();
    await s.closed;
    oldSse.close();
  } finally {
    if (a) await stopChild(a);
    if (b) await stopChild(b);
    removeState(dir);
  }
});

test('real processes: another process\'s publish reaches the owner\'s SSE within 1s with plan and live, despite an old-shape data.js', { timeout: 30000 }, async (t) => {
  const dir = tempState();
  let a;
  try {
    const store = seed(dir, 5);
    a = startChild(dir, 'lead-A', nextBase());
    await a.ready;
    const ra = (await a.call('ensure')).result;
    const s = await sse(portOf(ra.url));
    await s.frame((f) => f.seq === 5, 2000, 'first frame');
    // a generation-3 session publishes: old-shape data.js (no plan, no live) and a new published.json
    const t0 = performance.now();
    store.replace('data.js', '/* seq:6 */\nwindow.__briefData && window.__briefData({"seq":6,"sessions":[{"id":"s1"}]});\n');
    store.replace('published.json', { seq: 6, dataHash: 'old', at: 2 });
    const f = await s.frame((x) => x.seq === 6, 1000, 'seq 6 within 1s');
    t.diagnostic(`broadcast after foreign publish ms=${Math.round(performance.now() - t0)}`);
    assert.equal(f.gen, 4);
    assert.equal(f.sessions[0].plan.goal, '목표');
    assert.equal(f.sessions[0].live.workers[0].id, 'st_1');
    s.close();
    await s.closed;
  } finally {
    if (a) await stopChild(a);
    removeState(dir);
  }
});

test('real processes: pause with A owning and B watching -> SSE gets event: paused, lock and server.json gone, B does not take over', { timeout: 30000 }, async () => {
  const dir = tempState();
  const portBase = nextBase();
  let a;
  let b;
  try {
    const store = seed(dir, 5);
    a = startChild(dir, 'lead-A', portBase);
    await a.ready;
    const ra = (await a.call('ensure')).result;
    b = startChild(dir, 'lead-B', portBase);
    await b.ready;
    assert.equal((await b.call('ensure')).result.url, ra.url);
    const s = await sse(portOf(ra.url));
    await s.frame((f) => f.seq === 5, 2000, 'first frame');
    store.writeSettings({ enabled: false });
    await a.call('pause');
    await s.waitFor((x) => /event: paused\n/.test(x.text), 2000, 'paused event');
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(existsSync(jsonPath(dir)), false);
    const after = (await b.call('tick')).status;
    assert.equal(after.role, 'paused');
    assert.equal(existsSync(lockPath(dir)), false, 'B did not take over while paused');
    await assert.rejects(get(portOf(ra.url), '/health'), { code: 'ECONNREFUSED' });
  } finally {
    if (a) await stopChild(a);
    if (b) await stopChild(b);
    removeState(dir);
  }
});

test('real processes: two processes ensure at the same moment -> exactly one owner, one url, the lock names the owner', { timeout: 60000 }, async (t) => {
  // Both find no lock and both start a server; server.lock is created with 'wx', so the second create fails (EEXIST),
  // that process closes its own server and reuses the winner's. Fresh seeded STATE and fresh processes every round.
  for (let round = 0; round < 3; round++) {
    const dir = tempState();
    const portBase = nextBase();
    let x;
    let y;
    try {
      seed(dir, 5);
      x = startChild(dir, `lead-X${round}`, portBase);
      y = startChild(dir, `lead-Y${round}`, portBase);
      await Promise.all([x.ready, y.ready]);
      // both sends leave in this tick: neither process can see the other's lock before it decides to start a server
      const [rx, ry] = await Promise.all([x.call('ensure'), y.call('ensure')]);
      const sx = (await x.call('status')).status;
      const sy = (await y.call('status')).status;
      const errorsOf = (c) => c.seen.filter((m) => m.type === 'error');
      const errors = JSON.stringify([...errorsOf(x), ...errorsOf(y)]);
      t.diagnostic(`round ${round}: X ${sx.role} ${rx.result && rx.result.url} / Y ${sy.role} ${ry.result && ry.result.url}`);
      const owners = [[x, sx], [y, sy]].filter(([, s]) => s.role === 'owner');
      assert.equal(owners.length, 1, `round ${round}: exactly one owner; got X=${sx.role}:${sx.port} Y=${sy.role}:${sy.port} errors=${errors}`);
      const [ownerChild, ownerRes, other, otherRes, otherStatus] = owners[0][0] === x ? [x, rx, y, ry, sy] : [y, ry, x, rx, sx];
      assert.ok(ownerRes.result, `round ${round}: the owner got a url; errors=${errors}`);
      let otherUrl = otherRes.result && otherRes.result.url;
      if (!otherRes.result) {
        // The loser can read server.lock between the winner's 'wx' create and its write: an unreadable lock counts as held,
        // so it reports server:lock and does not serve. Only that: its next check must find the finished lock.
        assert.equal(otherStatus.role, 'unavailable', `round ${round}: errors=${errors}`);
        assert.deepEqual(errorsOf(other).map((m) => m.key), ['server:lock']);
        const again = (await other.call('ensure')).result;
        otherUrl = again && again.url;
        t.diagnostic(`round ${round}: the non-owner read server.lock mid-write; its next check -> ${otherUrl}`);
      }
      assert.equal(otherUrl, ownerRes.result.url, `round ${round}: both use the one server`);
      assert.equal((await other.call('status')).status.role, 'client');
      const lock = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
      assert.ok([x.child.pid, y.child.pid].includes(lock.pid), `round ${round}: lock pid ${lock.pid} is one of the two`);
      assert.equal(lock.pid, ownerChild.child.pid, `round ${round}: the lock names the owner`);
      assert.equal(lock.port, portOf(ownerRes.result.url));
      assert.equal(JSON.parse((await get(lock.port, '/health')).body).pid, lock.pid);
    } finally {
      if (x) await stopChild(x);
      if (y) await stopChild(y);
      removeState(dir);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// board write token and hooks (POST /answer, POST /focus)

function postJson(port, path, body, token) {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = {
      Connection: 'close',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
      'Sec-Fetch-Site': 'same-origin',
      Origin: `http://127.0.0.1:${port}`,
      'X-Board-Token': token,
    };
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(text);
  });
}

const tokenOfPage = (html) => /<meta name="omo-board-token" content="([^"]+)">/.exec(html)?.[1];
const allFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? allFiles(join(dir, d.name)) : [join(dir, d.name)]));
const withToken = (seen) => (vm, token) => {
  seen.push(token);
  return `${pageOf(vm)}<meta name="omo-board-token" content="${token}">`;
};

test('board write token: new for every serving start, handed only to the served page; a stale token writes nothing', async () => {
  const dir = tempState();
  try {
    seed(dir);
    const handed = [];
    const calls = [];
    const t = makeHost(dir, {
      opts: {
        getPage: withToken(handed),
        answer: async (b) => { calls.push(['answer', b]); return { status: 200, json: { ok: true } }; },
        focus: async (b) => { calls.push(['focus', b]); return { status: 200, json: { ok: true } }; },
      },
    });
    const first = portOf((await t.host.ensure()).url);
    const a = tokenOfPage((await get(first, '/')).body);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/, '32 random bytes as base64url');
    assert.equal(a, handed[0]);
    assert.deepEqual(await postJson(first, '/answer', { id: 1, sessionId: 's1', option: 'A' }, a), { status: 200, json: { ok: true } });
    assert.deepEqual(await postJson(first, '/focus', { sessionId: 's1' }, a), { status: 200, json: { ok: true } });
    assert.deepEqual(calls, [['answer', { id: 1, sessionId: 's1', option: 'A' }], ['focus', { sessionId: 's1' }]]);

    // the token is in the page and nowhere else: not in any file of STATE, /health, /data.json or the SSE feed
    const feed = await sse(first);
    await feed.waitFor((x) => x.text.includes('event: data'), 3000, 'first SSE frame');
    const seen = [(await get(first, '/health')).body, (await get(first, '/data.json')).body, feed.text, ...allFiles(dir).map((f) => readFileSync(f, 'utf8'))];
    feed.close();
    assert.ok(existsSync(lockPath(dir)) && existsSync(jsonPath(dir)), 'lock and server.json were among the files');
    assert.ok(seen.every((text) => !text.includes(a)), 'no copy of the token outside the served page');

    await t.host.release();
    const second = portOf((await t.host.ensure()).url);
    const b = tokenOfPage((await get(second, '/')).body);
    assert.notEqual(b, a, 'a new serving start has a new token');
    assert.deepEqual(await postJson(second, '/answer', { id: 1, sessionId: 's1', option: 'A' }, a), { status: 403, json: { ok: false, code: 'FORBIDDEN_TOKEN' } });
    assert.equal(calls.length, 2, 'the old token reached no hook');
    assert.equal((await postJson(second, '/answer', { id: 1, sessionId: 's1', option: 'A' }, b)).status, 200);
    assert.ok(allFiles(dir).every((f) => !readFileSync(f, 'utf8').includes(b)), 'the second token is not on disk either');
    await t.host.release();
  } finally {
    removeState(dir);
  }
});

test('board write hooks: a paused board answers 503 PAUSED and calls neither hook; a host without hooks answers 501', async () => {
  const dir = tempState();
  try {
    seed(dir);
    const calls = [];
    const t = makeHost(dir, {
      opts: {
        getPage: withToken([]),
        answer: async (b) => { calls.push(['answer', b]); return { status: 200, json: { ok: true } }; },
        focus: async (b) => { calls.push(['focus', b]); return { status: 200, json: { ok: true } }; },
      },
    });
    const port = portOf((await t.host.ensure()).url);
    const token = tokenOfPage((await get(port, '/')).body);
    t.store.writeSettings({ enabled: false }); // /brief off, noticed by the write path itself (the owner's 5s check has not run)
    const paused = { status: 503, json: { ok: false, code: 'PAUSED' } };
    assert.deepEqual(await postJson(port, '/answer', { id: 1, sessionId: 's1', option: 'A' }, token), paused);
    assert.deepEqual(await postJson(port, '/focus', { sessionId: 's1' }, token), paused);
    assert.deepEqual(calls, [], 'nothing was written or focused while paused');
    t.store.writeSettings({ enabled: true });
    assert.equal((await postJson(port, '/answer', { id: 1, sessionId: 's1', option: 'A' }, token)).status, 200);
    await t.host.release();

    const bare = makeHost(dir, { opts: { getPage: withToken([]) } });
    const barePort = portOf((await bare.host.ensure()).url);
    const bareToken = tokenOfPage((await get(barePort, '/')).body);
    const none = { status: 501, json: { ok: false, code: 'NOT_SUPPORTED' } };
    assert.deepEqual(await postJson(barePort, '/answer', { id: 1, sessionId: 's1', option: 'A' }, bareToken), none);
    assert.deepEqual(await postJson(barePort, '/focus', { sessionId: 's1' }, bareToken), none);
    await bare.host.release();
  } finally {
    removeState(dir);
  }
});

test('no child process started by this file is left alive', () => {
  assert.ok(children.length >= 6);
  for (const c of children) {
    assert.ok(c.exitCode !== null || c.signalCode !== null, `child ${c.pid} still running`);
    assert.equal(isPidAlive(c.pid), false, `pid ${c.pid} alive`);
  }
});
