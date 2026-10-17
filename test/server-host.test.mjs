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
import { createServerHost, readInstalledGeneration, SERVER_LOCK, SERVER_JSON, CHECK_EVERY_MS, POLL_MS } from '../src/server-host.mjs';
import { createBoardServer } from '../src/server.mjs';
import { openStore, isPidAlive } from '../src/store.mjs';

const HELPER = fileURLToPath(new URL('./helpers/server-child.mjs', import.meta.url));
const REGISTRY = Symbol.for('omo.briefing.server');
const DEAD_PID = 2147480000;
const LOCK_FIELDS = ['at', 'generation', 'nonce', 'pid', 'port', 'sessionId'];
if (process.env.OMO_TEST_MUTANT_HOOKS) console.log(`TEST-PID ${process.pid}`);

// Host tests use 47400-48119, disjoint from server.test.mjs even when child pids have the same modulo.
// Tests alternate between two 12-port windows per process and read the bound port back.
let windowNo = 0;
const nextBase = () => 47400 + (process.pid % 30) * 24 + (windowNo++ % 2) * 12;

const tempState = () => mkdtempSync(join(os.tmpdir(), 'omo-server-host-'));
const removeState = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
const lockPath = (dir) => join(dir, SERVER_LOCK);
const jsonPath = (dir) => join(dir, SERVER_JSON);
const portOf = (url) => Number(new URL(url).port);
function released(dir, pid, reason, generation) {
  assert.equal(existsSync(lockPath(dir)), true, 'ENABLED_CLOSE_MUST_KEEP_SERVER_LOCK');
  const rec = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
  assert.equal(rec.pid, pid, 'RELEASED must retain the releaser real pid');
  assert.equal(rec.released, reason);
  if (generation !== undefined) assert.equal(rec.generation, generation);
  assert.ok(Number.isInteger(rec.port));
  return rec;
}
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
  const timeouts = new Map();
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
    setTimeout(fn, ms) {
      const h = setTimeout(() => { timeouts.delete(h); fn(); }, ms);
      timeouts.set(h, { fn, ms });
      return h;
    },
    clearTimeout(h) { timeouts.delete(h); clearTimeout(h); },
    async fireTimeout(ms) {
      for (const [h, v] of [...timeouts]) if (v.ms === ms) { clearTimeout(h); timeouts.delete(h); await v.fn(); }
    },
    timeouts: () => [...timeouts.values()],
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

function startChild(stateDir, sessionId, portBase, generation, installedFile, legacy = false) {
  const helper = legacy ? fileURLToPath(new URL('./helpers/legacy-server-child.mjs', import.meta.url)) : HELPER;
  const args = [stateDir, sessionId, String(portBase)];
  if (generation !== undefined) args.push(String(generation), installedFile ?? '', 'manual');
  const child = fork(helper, args, { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
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
    if (m.type === 'mutation-applied') console.log(`MUTATION-APPLIED ${m.id} pid=${child.pid}`);
    for (const l of [...listeners]) l(m);
  });
  function waitFor(pred, ms, what) {
    const hit = seen.find(pred);
    if (hit) return Promise.resolve(hit);
    let l;
    let onExit;
    return within(new Promise((ok, fail) => {
      l = (m) => { if (pred(m)) ok(m); };
      listeners.add(l);
      onExit = () => fail(new Error(`${sessionId}: exited before ${what}; stderr=${stderr}`));
      child.once('exit', onExit);
      if (child.exitCode !== null || child.signalCode !== null) onExit();
    }), ms, `${sessionId}: ${what}; stderr=${stderr}`).finally(() => { listeners.delete(l); child.off('exit', onExit); });
  }
  let id = 0;
  function call(cmd, ms = 5000) {
    const myId = ++id;
    child.send({ id: myId, ...(typeof cmd === 'string' ? { cmd } : cmd) });
    return waitFor((m) => m.id === myId, ms, String(cmd)).then((m) => { assert.equal(m.failure, undefined); return m; });
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

test('paused start: keeps exactly one settings-only check timer and never takes the lock while paused', async () => {
  const dir = tempState();
  try {
    const t = makeHost(dir);
    t.store.writeSettings({ enabled: false });
    assert.equal(await t.host.ensure(), null);
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(existsSync(jsonPath(dir)), false);
    assert.equal(t.boards(), 0);
    assert.deepEqual(t.timers.active().map((h) => h.ms), [CHECK_EVERY_MS]);
    await t.timers.fire(CHECK_EVERY_MS);
    assert.equal(t.boards(), 0);
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
    released(dir, process.pid, 'quit', 4);
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
    released(dir, process.pid, 'quit', 4);
    assert.equal(registrySize(), 0);
  } finally {
    removeState(dir);
  }
});

test('release replaces only its own lock: a lock whose content changed is left alone', async () => {
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

test('pause lock removal EPERM: the exact lock is kept; enabled recovery releases in place and owns again', async () => {
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
    t.store.writeSettings({ enabled: false });
    await t.host.onPaused();
    assert.deepEqual(t.errors.map((e) => e.key), ['server:lock']);
    assert.match(t.errors[0].message, /EPERM/);
    assert.equal(readFileSync(lockPath(dir), 'utf8'), first, 'lock left exactly as it was');
    failing.on = false;
    t.store.writeSettings({ enabled: true });
    t.recovered.length = 0;
    const again = await t.host.ensure();
    assert.ok(again, 'own leftover (same pid, verified content) removed, ownership taken again');
    assert.notEqual(readFileSync(lockPath(dir), 'utf8'), first);
    assert.ok(t.recovered.includes('server:lock'));
    await t.host.release();
    released(dir, process.pid, 'quit', 4);
  } finally {
    removeState(dir);
  }
});

test('a dead owner is claimed then atomically replaced without unlink; its port is tried first', async () => {
  const dir = tempState();
  try {
    const portBase = nextBase();
    const deadPort = await freePortFrom(portBase + 5);
    const stale = { pid: DEAD_PID, at: 1, nonce: 'dead-nonce', sessionId: 'old', port: deadPort, generation: 4 };
    writeFileSync(lockPath(dir), JSON.stringify(stale));
    const ops = [];
    const io = {
      ...fsp,
      async link(from, to) { await fsp.link(from, to); ops.push('link'); },
      async rename(from, to) { await fsp.rename(from, to); if (to === lockPath(dir)) ops.push('rename'); },
      async unlink(path) {
        if (path === lockPath(dir)) ops.push('unlink-lock');
        await fsp.unlink(path);
        if (String(path).includes('.stale-')) ops.push('unlink-claim');
      },
    };
    const t = makeHost(dir, { portBase, opts: { fs: io } });
    const r = await t.host.ensure();
    assert.equal(portOf(r.url), deadPort);
    assert.deepEqual(ops, ['link', 'rename', 'unlink-claim']);
    assert.equal(existsSync(join(dir, `${SERVER_LOCK}.stale-dead-nonce`)), false);
    assert.equal(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid, process.pid);
    await t.host.release();
  } finally {
    removeState(dir);
  }
});

test('pid alive but /health refused 3 times in a row: no hand-over and a server:lock error on the 3rd; a real death then hands over', async () => {
  const dir = tempState();
  const idle = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(2), 60000); setInterval(() => {}, 1e9)'], { stdio: 'ignore', windowsHide: true });
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

test('pause: the owner sends event: paused, closes, removes its files, keeps exactly one settings-only check timer', async () => {
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
    assert.deepEqual(t.timers.active().map((h) => h.ms), [CHECK_EVERY_MS]);
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
    assert.deepEqual(t.timers.active().map((h) => h.ms), [CHECK_EVERY_MS]);
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
    await t.host.release();
    await Promise.all(clients.map((c) => within(c.closed, 2000, 'client closed')));
    released(dir, process.pid, 'quit', 4);
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

// Generation protocol scenarios use manual ticks, IPC events and real sockets, never settling sleeps.
function protocol(t, installed = 8) {
  const dir = tempState();
  const store = seed(dir);
  const installedFile = join(dir, 'current.json');
  const setInstalled = (g) => store.replace('current.json', { generation: `generation-${String(g).padStart(6, '0')}` });
  setInstalled(installed);
  const members = [];
  const base = nextBase();
  t.after(async () => {
    for (const c of members) {
      if (c.child.connected) {
        try { await c.call('openAll'); } catch {}
        try { await c.call('resumeIdle'); } catch {}
        try { await c.call('resumeClose'); } catch {}
      }
      await stopChild(c);
      t.diagnostic(`PROTOCOL ${c.child.pid} ${JSON.stringify(c.seen)}`);
      assert.equal(isPidAlive(c.child.pid), false);
      t.diagnostic(`CHILD-CLEANUP pid=${c.child.pid} exit=${c.child.exitCode} signal=${c.child.signalCode}`);
    }
    removeState(dir);
  });
  return {
    dir, store, installedFile, setInstalled,
    async child(name, g, legacy = false) {
      const c = startChild(dir, name, base, g, installedFile, legacy);
      members.push(c);
      const ready = await c.ready;
      assert.equal(ready.module, new URL(legacy ? './fixtures/legacy/server-host.b59f5b7.mjs' : '../src/server-host.mjs', import.meta.url).href);
      return c;
    },
  };
}
const lockOps = (c, since = 0) => c.seen.slice(since).filter((m) => m.type === 'fsop' && (m.name === SERVER_LOCK || m.name.startsWith(`${SERVER_LOCK}.stale-`)));
const owns = (c) => c.waitFor((m) => m.type === 'change' && m.status.role === 'owner', 5000, 'owns');

for (const variant of ['death', 'same-tick-0', 'same-tick-1', 'same-tick-2', 'quit']) {
  test(`T1 ${variant}: stale generation never creates or reclaims; newest host keeps the old port`, { timeout: 30000 }, async (t) => {
    const p = protocol(t, 9);
    const a = await p.child('A', 9);
    const port = portOf((await a.call('ensure')).result.url);
    const b = await p.child('B', 8);
    const c = await p.child('C', 9);
    await b.call('ensure');
    await c.call('ensure');
    const before = readFileSync(lockPath(p.dir), 'utf8');
    const offset = b.seen.length;
    if (variant === 'quit') await a.call({ cmd: 'release', reason: 'quit' });
    else { a.child.kill(); await within(a.closed, 5000, 'owner death'); }
    if (variant.startsWith('same-tick')) await Promise.all([b.call('ensure'), c.call('ensure')]);
    else {
      assert.equal((await b.call('ensure')).result, null);
      assert.equal((await b.call('status')).status.role, 'stale');
      if (variant !== 'quit') assert.equal(readFileSync(lockPath(p.dir), 'utf8'), before);
      await c.call('ensure');
    }
    assert.equal((await c.call('status')).status.role, 'owner');
    assert.equal((await c.call('status')).status.port, port);
    assert.deepEqual(lockOps(b, offset), []);
    assert.equal(b.seen.some((m) => m.type === 'listening'), false);
    assert.equal((await b.call('ensure')).result.url, `http://127.0.0.1:${port}/`);
    assert.equal((await b.call('status')).status.role, 'client');
  });
}

test('R1 absent: stale host makes no wx create; R2 fresh higher want blocks create and reclaim', async (t) => {
  const dir = tempState();
  const store = seed(dir);
  let installed = 9;
  const a = makeHost(dir, { opts: { generation: 8, installedGeneration: async () => installed } });
  t.after(async () => { await a.host.release(); removeState(dir); });
  assert.equal(await a.host.ensure(), null);
  assert.equal(a.host.status().stale, true);
  assert.equal(a.boards(), 0);
  installed = 8;
  store.replace('server.want', { pid: process.pid, nonce: 'higher', at: Date.now(), generation: 9 });
  assert.equal(await a.host.ensure(), null);
  assert.equal(a.boards(), 0);
  store.replace(SERVER_LOCK, { pid: DEAD_PID, nonce: 'dead', at: 1, generation: 8, port: nextBase() });
  const before = readFileSync(lockPath(dir), 'utf8');
  assert.equal(await a.host.ensure(), null);
  assert.equal(readFileSync(lockPath(dir), 'utf8'), before);
});

test('T2: owner yields by one atomic rename, closes before swap, adopter reads before listen; writes are BUSY', { timeout: 30000 }, async (t) => {
  const p = protocol(t);
  const b = await p.child('B', 8);
  const port = portOf((await b.call('ensure')).result.url);
  const token = tokenOfPage((await get(port)).body);
  const stream = await sse(port);
  await stream.frame((f) => f.seq === 5, 2000, 'initial frame');
  await b.call('holdIdle');
  const startB = b.seen.length;
  p.setInstalled(9);
  const a = await p.child('A', 9);
  await a.call('ensure');
  const startA = a.seen.length;
  const idleWaiting = b.waitFor((m) => m.type === 'idle-wait', 2000, 'drain begins');
  const yielding = b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
  await idleWaiting;
  assert.deepEqual(await postJson(port, '/answer', { id: 1, sessionId: 's1', option: 'A' }, token),
    { status: 429, json: { ok: false, code: 'BUSY' } });
  const notice = stream.waitFor((s) => /event: closing\ndata: .*"handover"/.test(s.text), 3000, 'handover notice');
  await b.call('resumeIdle');
  await yielding;
  await notice;
  await owns(a);
  await a.call('ensure');
  const ops = [...lockOps(b, startB), ...lockOps(a, startA)];
  assert.deepEqual(ops.map((m) => m.op), ['rename']);
  const closed = b.seen.slice(startB).find((m) => m.type === 'closed');
  assert.ok(closed.seq < lockOps(b, startB)[0].seq);
  assert.ok(lockOps(b, startB)[0].seq < b.seen.slice(startB).find((m) => m.type === 'change' && m.status.role === 'client').seq);
  const listen = a.seen.find((m) => m.type === 'listening');
  assert.ok(a.seen.some((m) => m.type === 'lock-read' && m.rec?.pid === a.child.pid && m.seq < listen.seq));
  assert.ok(listen.seq < a.seen.find((m) => m.type === 'change' && m.status.role === 'owner').seq);
  const health = JSON.parse((await get(port, '/health')).body);
  assert.equal(health.pid, a.child.pid);
  assert.equal(health.generation, 9);
  assert.match((await get(port)).body, /content="9"/);
  assert.equal(existsSync(join(p.dir, 'server.want')), false);
  const nextStream = await sse(port);
  await nextStream.frame((f) => f.gen === 9, 2000, 'new generation');
  nextStream.close();
  await nextStream.closed;
  await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
  assert.equal((await b.call('status')).status.role, 'client');
});

test('T3: an older publisher preserves the newer stamped page and live GET generation', async (t) => {
  const p = protocol(t);
  const b = await p.child('B', 8);
  const port = portOf((await b.call('ensure')).result.url);
  p.setInstalled(9);
  const a = await p.child('A', 9);
  await a.call('ensure');
  await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
  await owns(a);
  await a.call('publish');
  const page = readFileSync(join(p.dir, 'index.html'), 'utf8');
  const seq = JSON.parse(readFileSync(join(p.dir, 'published.json'), 'utf8')).seq;
  p.store.replace('sessions/s1/briefs/1.json', { at: Date.now(), brief: { done: [{ text: 'new record' }] } });
  await b.call('publish');
  assert.equal(readFileSync(join(p.dir, 'index.html'), 'utf8'), page);
  assert.ok(JSON.parse(readFileSync(join(p.dir, 'published.json'), 'utf8')).seq > seq);
  assert.match(readFileSync(join(p.dir, 'data.js'), 'utf8'), /new record/);
  assert.match((await get(port)).body, /content="9"/);
});

test('T4 R1-owner: install without a newer host sends closing stale before ending every SSE stream', async (t) => {
  const p = protocol(t);
  const b = await p.child('B', 8);
  const port = portOf((await b.call('ensure')).result.url);
  const streams = await Promise.all([1, 2, 3].map(() => sse(port)));
  await Promise.all(streams.map((s) => s.frame((f) => f.seq === 5, 2000, 'initial frame')));
  await b.call({ cmd: 'setInstalled', generation: 9 });
  await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
  assert.equal((await b.call('status')).status.role, 'stale');
  await Promise.all(streams.map((s) => within(s.closed, 2000, 'stream closed')));
  for (const stream of streams) {
    const notice = /event: closing\ndata: ([^\n]*)\n\n/.exec(stream.text);
    assert.ok(notice, 'stale close must deliver closing before the stream ends');
    assert.deepEqual(JSON.parse(notice[1]), { reason: 'stale', installed: 9, own: 8 });
  }
  released(p.dir, b.child.pid, 'stale', 8);
  assert.equal(existsSync(jsonPath(p.dir)), false);
  await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
});

test('T5: quit sends closing quit before ending SSE and leaves RELEASED with no server.json', async (t) => {
  const p = protocol(t, 9);
  const a = await p.child('A', 9);
  const port = portOf((await a.call('ensure')).result.url);
  const stream = await sse(port);
  await stream.frame((f) => f.seq === 5, 2000, 'initial frame');
  await a.call({ cmd: 'release', reason: 'quit' });
  await within(stream.closed, 2000, 'stream closed');
  const notice = /event: closing\ndata: ([^\n]*)\n\n/.exec(stream.text);
  assert.ok(notice, 'quit close must deliver closing before the stream ends');
  assert.deepEqual(JSON.parse(notice[1]), { reason: 'quit', installed: 9, own: 9 });
  assert.equal((await a.call('status')).status.role, 'stale');
  released(p.dir, a.child.pid, 'quit', 9);
  assert.equal(existsSync(jsonPath(p.dir)), false);
  await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
});

for (const reason of ['quit', undefined]) {
  test(`T5 late want (${reason ?? 'missing reason'}): quit transfers without unlink when a newer host wants during close`, { timeout: 30000 }, async (t) => {
    const p = protocol(t);
    const b = await p.child('B', 8);
    const port = portOf((await b.call('ensure')).result.url);
    const before = readFileSync(lockPath(p.dir), 'utf8');
    const startB = b.seen.length;
    const stream = await sse(port);
    await stream.frame((f) => f.seq === 5, 2000, 'initial frame');
    p.setInstalled(9);
    const a = await p.child('A', 9);
    await b.call('holdClose');
    const closing = b.waitFor((m) => m.type === 'close-wait', 2000, 'quit close entered');
    const notice = stream.waitFor((s) => /event: closing\ndata: ([^\n]*)\n\n/.exec(s.text), 2000, 'quit notice');
    const releasing = b.call({ cmd: 'release', reason });
    await closing;
    assert.deepEqual(JSON.parse((await notice)[1]), { reason: 'quit', installed: 9, own: 8 });
    assert.equal(existsSync(join(p.dir, 'server.want')), false);
    // The old listener is still real and open: A health-checks it and publishes its own nonce.
    await a.call('ensure');
    const wanted = JSON.parse(readFileSync(join(p.dir, 'server.want'), 'utf8'));
    assert.equal(wanted.pid, a.child.pid);
    assert.equal(wanted.generation, 9);
    assert.equal(readFileSync(lockPath(p.dir), 'utf8'), before);
    await b.call('resumeClose');
    await releasing;
    await owns(a);
    await a.call('ensure');
    await within(stream.closed, 2000, 'quit stream closed');
    assert.deepEqual(lockOps(b, startB).map((m) => m.op), ['rename']);
    assert.deepEqual(lockOps(a), []);
    const closed = b.seen.slice(startB).find((m) => m.type === 'closed');
    assert.ok(closed.seq < lockOps(b, startB)[0].seq);
    const listening = a.seen.find((m) => m.type === 'listening');
    assert.ok(a.seen.some((m) => m.type === 'lock-read' && m.rec?.nonce === wanted.nonce && m.seq < listening.seq));
    assert.deepEqual(JSON.parse(readFileSync(lockPath(p.dir), 'utf8')), { ...wanted, port });
    const health = JSON.parse((await get(port, '/health')).body);
    assert.equal(health.pid, a.child.pid);
    assert.equal(health.generation, 9);
    assert.equal(existsSync(join(p.dir, 'server.want')), false);
  });
}

for (const [name, point] of [['F1', 'before-lock-swap'], ['F2', 'after-lock-swap'], ['F3', 'before-adopt-listen']]) {
  test(`${name}: interruption at ${point} resumes only in the current generation`, { timeout: 30000 }, async (t) => {
    const p = protocol(t);
    const b = await p.child('B', 8);
    const port = portOf((await b.call('ensure')).result.url);
    p.setInstalled(9);
    const a = await p.child('A', 9);
    const crashing = name === 'F3' ? a : b;
    await crashing.call({ cmd: 'crashAt', point });
    await a.call('ensure');
    const staleClient = name === 'F1' ? await p.child('stale-client', 8) : null;
    if (staleClient) await staleClient.call('ensure');
    // This tick intentionally exits before replying in F1/F2.
    const ticking = b.call({ cmd: 'tick', ms: CHECK_EVERY_MS }).catch(() => null);
    await within(crashing.closed, 5000, point);
    if (name === 'F3') {
      await ticking;
      await b.call('ensure');
      assert.equal((await b.call('status')).status.role, 'stale');
      const d = await p.child('D', 9);
      await d.call('ensure');
      assert.equal((await d.call('status')).status.port, port);
      assert.equal((await d.call('status')).status.role, 'owner');
    } else {
      if (staleClient) {
        await staleClient.call('ensure');
        assert.equal(staleClient.seen.some((m) => m.type === 'listening'), false);
        assert.deepEqual(lockOps(staleClient), []);
      }
      await a.call('ensure');
      assert.equal((await a.call('status')).status.role, 'owner');
      assert.equal((await a.call('status')).status.port, port);
      assert.equal(lockOps(a).some((m) => m.name === SERVER_LOCK && /unlink|wx/.test(m.op)), false);
      await ticking;
    }
    assert.equal(crashing.child.exitCode, 1);
  });
}

test('F4: old-mtime live and fresh dead wants do not change the lock', async (t) => {
  const p = protocol(t);
  const b = await p.child('B', 8);
  await b.call('ensure');
  const idle = await p.child('idle', 9);
  const before = readFileSync(lockPath(p.dir), 'utf8');
  for (const pid of [idle.child.pid, DEAD_PID]) {
    p.store.replace('server.want', { pid, nonce: 'ignored', at: Date.now(), generation: 9 });
    if (pid === idle.child.pid) await fsp.utimes(join(p.dir, 'server.want'), new Date(0), new Date(Date.now() - 10000));
    await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
    assert.equal(readFileSync(lockPath(p.dir), 'utf8'), before);
    assert.equal((await b.call('status')).status.role, 'owner');
  }
});

test('F5: two same-generation wanters select exactly one adopter and remove the want', async (t) => {
  const p = protocol(t);
  const b = await p.child('B', 8);
  await b.call('ensure');
  p.setInstalled(9);
  const a = await p.child('A', 9);
  const c = await p.child('C', 9);
  await Promise.all([a.call('ensure'), c.call('ensure')]);
  const chosen = JSON.parse(readFileSync(join(p.dir, 'server.want'), 'utf8')).pid;
  await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
  const winner = chosen === a.child.pid ? a : c;
  const loser = winner === a ? c : a;
  await owns(winner);
  await loser.call('ensure');
  assert.equal((await loser.call('status')).status.role, 'client');
  assert.equal(existsSync(join(p.dir, 'server.want')), false);
  assert.equal(lockOps(b).filter((m) => m.op === 'rename').length, 1);
});

test('F6: pause after want sends paused, performs no swap, and newest resumes', async (t) => {
  const p = protocol(t);
  const b = await p.child('B', 8);
  const port = portOf((await b.call('ensure')).result.url);
  const stream = await sse(port);
  await stream.frame((f) => f.seq === 5, 2000, 'initial frame');
  p.setInstalled(9);
  const a = await p.child('A', 9);
  await a.call('ensure');
  p.store.writeSettings({ enabled: false });
  const notice = stream.waitFor((s) => /event: paused/.test(s.text), 2000, 'pause notice');
  await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
  await notice;
  await a.call('ensure');
  assert.equal(existsSync(lockPath(p.dir)), false);
  assert.equal(lockOps(b).some((m) => m.op === 'rename'), false);
  p.store.writeSettings({ enabled: true });
  await a.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
  assert.equal((await a.call('status')).status.role, 'owner');
});

test('F7: paused settings-only check resumes even when the stale host goes first', async (t) => {
  const dir = tempState();
  const store = seed(dir);
  let reads = 0;
  const opts = { installedGeneration: async () => { reads++; return 9; } };
  const b = makeHost(dir, { opts: { ...opts, generation: 8 } });
  const a = makeHost(dir, { opts: { ...opts, generation: 9 } });
  t.after(async () => { await a.host.release(); await b.host.release(); removeState(dir); });
  store.writeSettings({ enabled: false });
  await b.host.ensure();
  await a.host.ensure();
  await a.timers.fire(CHECK_EVERY_MS);
  assert.equal(reads, 0);
  assert.deepEqual(a.timers.active().map((h) => h.ms), [CHECK_EVERY_MS]);
  store.writeSettings({ enabled: true });
  await b.timers.fire(CHECK_EVERY_MS);
  assert.equal(b.host.status().role, 'stale');
  assert.equal(existsSync(lockPath(dir)), false);
  await a.timers.fire(CHECK_EVERY_MS);
  assert.equal(a.host.status().role, 'owner');
});

test('F8: installed-generation reader retries exactly 20/40/80, rejects malformed/large input, and recovers', async (t) => {
  const waits = [];
  const timers = { setTimeout(fn, ms) { waits.push(ms); queueMicrotask(fn); } };
  let calls = 0;
  const fsp = { readFile: async () => { calls++; throw Object.assign(new Error('busy'), { code: 'EPERM' }); } };
  assert.equal(await readInstalledGeneration('current.json', fsp, timers), 'unknown');
  assert.equal(calls, 4);
  assert.deepEqual(waits, [20, 40, 80]);
  for (const text of ['{}', '{"generation":"generation-9"}', '{"generation":"generation-000009"}' + ' '.repeat(65536)]) {
    assert.equal(await readInstalledGeneration('x', { readFile: async () => text }), 'unknown');
  }
  assert.equal(await readInstalledGeneration('x', { readFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), null);
  const dir = tempState();
  const file = join(dir, 'current.json');
  writeFileSync(file, 'garbage');
  const a = makeHost(dir, { opts: { generation: 9, installedGeneration: () => readInstalledGeneration(file) } });
  t.after(async () => { await a.host.release(); removeState(dir); });
  assert.equal(await a.host.ensure(), null);
  assert.equal(a.errors.length, 1);
  assert.equal(a.boards(), 0);
  writeFileSync(lockPath(dir), JSON.stringify({ pid: DEAD_PID, at: 1, nonce: 'unknown-gate', generation: 9, port: nextBase() }));
  const deadLock = readFileSync(lockPath(dir), 'utf8');
  assert.equal(await a.host.ensure(), null);
  assert.equal(readFileSync(lockPath(dir), 'utf8'), deadLock);
  assert.equal(a.boards(), 0);
  writeFileSync(file, '{"generation":"generation-000009"}');
  assert.ok(await a.host.ensure());
});

test('F9: reload grace keeps the port and lock, writes BUSY, rebuilds generation, rejects lower drivers, and expires', async (t) => {
  const dir = tempState();
  seed(dir);
  const a = makeHost(dir, { opts: { getPage: withToken([]), answer: async () => ({ status: 200, json: { ok: true } }) } });
  const b = makeHost(dir, { opts: { generation: 5, installedGeneration: async () => 5, getPage: (vm, token) => `<meta name="omo-briefing-generation" content="5"><meta name="omo-board-token" content="${token}">` } });
  const old = makeHost(dir, { opts: { generation: 3, getPage: () => 'OLD' } });
  const successor = makeHost(dir, { opts: { generation: 5, installedGeneration: async () => 5 } });
  t.after(async () => { await old.host.release(); await a.host.release(); await b.host.release(); await successor.host.release(); removeState(dir); });
  const port = portOf((await a.host.ensure()).url);
  const token = tokenOfPage((await get(port)).body);
  const before = readFileSync(lockPath(dir), 'utf8');
  await a.host.release('reload');
  assert.equal(readFileSync(lockPath(dir), 'utf8'), before);
  assert.equal((await get(port, '/health')).status, 200);
  assert.equal((await postJson(port, '/answer', { id: 1, sessionId: 's1', option: 'A' }, token)).status, 429);
  assert.equal(portOf((await b.host.ensure()).url), port);
  const adopted = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
  assert.equal(adopted.pid, process.pid);
  assert.equal(adopted.generation, 5);
  assert.notEqual(adopted.nonce, JSON.parse(before).nonce);
  assert.equal(JSON.parse((await get(port, '/health')).body).generation, 5);
  await old.host.ensure();
  // Simulates the unconditional assignment made by the frozen pre-fix module.
  const e = [...globalThis[REGISTRY].servers.values()].find((e) => e.port === port);
  e.driver = { ...e.driver, generation: 3, getPage: () => 'OLD' };
  assert.match((await get(port)).body, /content="5"/);
  await old.host.release();
  await b.host.release('reload');
  await a.timers.fireTimeout(15000); // entry's owner timers belong to its creator, b after the rebuild
  await b.timers.fireTimeout(15000);
  released(dir, process.pid, 'quit', 5);
  assert.equal(existsSync(jsonPath(dir)), false);
  await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
  const retired = readFileSync(lockPath(dir), 'utf8');
  await b.timers.fire(CHECK_EVERY_MS); // the released host's next automatic check, never an explicit ensure
  await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
  await assert.rejects(get(port), { code: 'ECONNREFUSED' });
  assert.equal(readFileSync(lockPath(dir), 'utf8'), retired);
  assert.equal(existsSync(jsonPath(dir)), false);
  assert.equal(portOf((await successor.host.ensure()).url), port);
  assert.equal(JSON.parse((await get(port, '/health')).body).generation, 5);
  assert.notEqual(readFileSync(lockPath(dir), 'utf8'), retired);
});

test('F9: same-generation hosts adopt reload/new/resume/fork without unlinking the retained lock', async (t) => {
  for (const reason of ['reload', 'new', 'resume', 'fork']) {
    const dir = tempState();
    const ops = [];
    const fs = { ...fsp, unlink: async (path) => { if (String(path).endsWith(SERVER_LOCK)) ops.push('unlink'); return fsp.unlink(path); } };
    const a = makeHost(dir, { opts: { fs, installedGeneration: async () => 4 } });
    const b = makeHost(dir, { opts: { fs, installedGeneration: async () => 4 } });
    const successor = makeHost(dir, { opts: { fs, installedGeneration: async () => 4 } });
    t.after(async () => { await a.host.release(); await b.host.release(); await successor.host.release(); removeState(dir); });
    const port = portOf((await a.host.ensure()).url);
    const before = readFileSync(lockPath(dir), 'utf8');
    await a.host.release(reason);
    assert.equal(readFileSync(lockPath(dir), 'utf8'), before);
    assert.equal(portOf((await b.host.ensure()).url), port);
    assert.equal(JSON.parse((await get(port, '/health')).body).generation, 4);
    assert.deepEqual(ops, []);
    await a.host.release();
    assert.equal((await get(port, '/health')).status, 200);
    await b.host.release(reason);
    await b.timers.fireTimeout(15000);
    released(dir, process.pid, 'quit', 4);
    await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
    const retired = readFileSync(lockPath(dir), 'utf8');
    await b.timers.fire(CHECK_EVERY_MS);
    await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
    await assert.rejects(get(port), { code: 'ECONNREFUSED' });
    assert.equal(readFileSync(lockPath(dir), 'utf8'), retired);
    assert.equal(existsSync(jsonPath(dir)), false);
    assert.equal(portOf((await successor.host.ensure()).url), port);
    assert.equal(JSON.parse((await get(port, '/health')).body).generation, 4);
    assert.notEqual(readFileSync(lockPath(dir), 'utf8'), retired);
  }
});

test('F9: reload adoption drains an in-flight answer before rebuilding the board', async (t) => {
  const dir = tempState();
  seed(dir);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const draining = Promise.withResolvers();
  const a = makeHost(dir, { opts: {
    getPage: withToken([]),
    answer: () => { entered.resolve(); return finish.promise; },
    createBoardServer: (opts) => {
      const board = createBoardServer(opts);
      return { ...board, idle() { draining.resolve(); return board.idle(); } };
    },
  } });
  const b = makeHost(dir, { opts: { generation: 5, getPage: () => '<meta name="omo-briefing-generation" content="5">' } });
  t.after(async () => { finish.resolve({ status: 200, json: { ok: true } }); await a.host.release(); await b.host.release(); removeState(dir); });
  const port = portOf((await a.host.ensure()).url);
  const token = tokenOfPage((await get(port)).body);
  const first = postJson(port, '/answer', { id: 1, sessionId: 's1', option: 'A' }, token);
  await within(entered.promise, 2000, 'answer entered');
  await a.host.release('reload');
  const adopting = b.host.ensure();
  await within(draining.promise, 2000, 'adopter draining');
  assert.equal(JSON.parse((await get(port, '/health')).body).generation, 4);
  assert.match((await get(port)).body, /content="4"/);
  finish.resolve({ status: 200, json: { ok: true } });
  assert.equal((await first).status, 200);
  assert.equal(portOf((await adopting).url), port);
  assert.equal(JSON.parse((await get(port, '/health')).body).generation, 5);
});

test('handover aborts a tick at its injected 2s idle deadline without closing or replacing the lock', async (t) => {
  const dir = tempState();
  const store = seed(dir);
  const entered = Promise.withResolvers();
  const idle = Promise.withResolvers();
  const b = makeHost(dir, { opts: {
    generation: 8,
    createBoardServer: (opts) => ({
      ...createBoardServer(opts),
      idle() { entered.resolve(); return idle.promise; },
    }),
  } });
  t.after(async () => { idle.resolve(); store.replace('server.want', {}); await b.host.release(); removeState(dir); });
  const port = portOf((await b.host.ensure()).url);
  const before = readFileSync(lockPath(dir), 'utf8');
  store.replace('server.want', { pid: process.pid, at: Date.now(), nonce: 'draining', generation: 9 });
  const tick = b.timers.fire(CHECK_EVERY_MS);
  await within(entered.promise, 2000, 'idle entered');
  await b.timers.fireTimeout(2000);
  await tick;
  assert.equal(readFileSync(lockPath(dir), 'utf8'), before);
  assert.equal((await get(port, '/health')).status, 200);
});

test('F9: a wanting reload preserves its issued nonce; the next instance adopts or cleans a stale transferred lock', async (t) => {
  for (const installed of [9, 10]) {
    const dir = tempState();
    const store = seed(dir);
    let current = 9;
    const opts = {
      generation: 9,
      installedGeneration: async () => current,
      probeHealth: async () => ({ ok: true, pid: DEAD_PID }),
    };
    const a = makeHost(dir, { opts });
    const b = makeHost(dir, { opts });
    let nonce;
    t.after(async () => {
      await a.host.release();
      await b.host.release();
      if (nonce) globalThis[REGISTRY].wants.delete(nonce);
      removeState(dir);
    });
    store.replace(SERVER_LOCK, { pid: DEAD_PID, at: 1, nonce: 'old-owner', generation: 8, port: nextBase() });
    await a.host.ensure();
    const wanted = JSON.parse(readFileSync(join(dir, 'server.want'), 'utf8'));
    nonce = wanted.nonce;
    await a.host.release('reload');
    assert.equal(globalThis[REGISTRY].wants.has(nonce), true, 'an already checked handover may still arrive after cancellation');
    // The old owner had passed its final want check before the reload cancelled it.
    writeFileSync(lockPath(dir), JSON.stringify({ ...wanted, port: nextBase() }));
    current = installed;
    const adopted = await b.host.ensure();
    if (installed === 9) {
      assert.ok(adopted);
      assert.equal(b.host.status().role, 'owner');
      assert.equal(JSON.parse((await get(portOf(adopted.url), '/health')).body).generation, 9);
    } else {
      assert.equal(adopted, null);
      assert.equal(b.host.status().role, 'stale');
      assert.equal(b.boards(), 0, 'a stale transferred owner must not listen even once');
      released(dir, process.pid, 'stale', 9);
    }
    assert.equal(globalThis[REGISTRY].wants.has(nonce), false);
    await b.host.release();
  }
});

test('F11: a wanter made stale while the old listener is closed cancels, allowing stale-owner step-down', async (t) => {
  const p = protocol(t);
  const b = await p.child('B', 8);
  const port = portOf((await b.call('ensure')).result.url);
  p.setInstalled(9);
  const a = await p.child('A', 9);
  await a.call('ensure');
  await b.call({ cmd: 'failSwap', on: true });
  await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
  p.setInstalled(10);
  await a.call('ensure');
  assert.equal((await a.call('status')).status.role, 'stale');
  assert.equal((await a.call('status')).status.wanting, false);
  assert.equal(existsSync(join(p.dir, 'server.want')), false);
  await b.call({ cmd: 'failSwap', on: false });
  await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
  released(p.dir, b.child.pid, 'stale', 8);
  const d = await p.child('D', 10);
  await d.call('ensure');
  assert.equal((await d.call('status')).status.port, port);
  assert.equal((await d.call('status')).status.role, 'owner');
  assert.equal(a.seen.some((m) => m.type === 'listening'), false);
});

test('F10: legacy client never steals a fixed handover; legacy owner yields only after its exit', async (t) => {
  const p = protocol(t);
  const b = await p.child('B', 8);
  const port = portOf((await b.call('ensure')).result.url);
  const legacy = await p.child('legacy', 7, true);
  await legacy.call('ensure');
  const offset = legacy.seen.length;
  p.setInstalled(9);
  const a = await p.child('A', 9);
  await a.call('ensure');
  await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
  await owns(a);
  await legacy.call('ensure');
  assert.deepEqual(lockOps(legacy, offset), []);
  assert.equal((await legacy.call('status')).status.role, 'client');
  await a.call({ cmd: 'release', reason: 'quit' });
  released(p.dir, a.child.pid, 'quit', 9);
  const before = readFileSync(lockPath(p.dir), 'utf8');
  const retiredOffset = legacy.seen.length;
  for (let n = 0; n < 3; n++) {
    await legacy.call('ensure');
    assert.notEqual((await legacy.call('status')).status.role, 'owner');
    assert.equal(readFileSync(lockPath(p.dir), 'utf8'), before);
  }
  assert.deepEqual(lockOps(legacy, retiredOffset), []);
  a.child.kill();
  await within(a.closed, 5000, 'released real pid exits');
  await legacy.call('ensure');
  assert.equal((await legacy.call('status')).status.role, 'owner');
  const d = await p.child('D', 9);
  const legacyText = readFileSync(lockPath(p.dir), 'utf8');
  await d.call('ensure');
  assert.equal(readFileSync(lockPath(p.dir), 'utf8'), legacyText, 'live unreleased legacy owner is never stolen');
  assert.deepEqual(lockOps(d), []);
  legacy.child.kill();
  await within(legacy.closed, 5000, 'legacy owner exit');
  await d.call('ensure');
  assert.equal((await d.call('status')).status.role, 'owner');
  assert.equal((await d.call('status')).status.port, port);
});

for (const dies of [false, true]) {
  test(`${dies ? 'F11b' : 'F11'}: failed swap keeps the live lock WITHOUT serving; ${dies ? 'dead wanter makes stale owner step down' : 'retry completes atomic handover'}`, async (t) => {
    const p = protocol(t);
    const b = await p.child('B', 8);
    const port = portOf((await b.call('ensure')).result.url);
    const before = readFileSync(lockPath(p.dir), 'utf8');
    const offset = b.seen.length;
    p.setInstalled(9);
    const a = await p.child('A', 9);
    await a.call('ensure');
    await b.call({ cmd: 'failSwap', on: true });
    for (let n = 0; n < 3; n++) {
      await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
      assert.equal(existsSync(lockPath(p.dir)), true, 'failed handover must retain HELD');
      assert.equal(readFileSync(lockPath(p.dir), 'utf8'), before);
      assert.deepEqual(lockOps(b, offset), []);
      assert.equal(b.seen.slice(offset).some((m) => m.type === 'listening'), false);
      await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
      await assert.rejects(get(port, '/'), { code: 'ECONNREFUSED' });
      assert.equal(JSON.parse(readFileSync(join(p.dir, 'server.want'), 'utf8')).pid, a.child.pid);
      await a.call({ cmd: 'tick', ms: POLL_MS }); // heartbeat remains fresh without a real-time wait
    }
    assert.ok(b.seen.some((m) => m.type === 'error' && m.key === 'server:lock'));
    if (dies) {
      a.child.kill();
      await within(a.closed, 5000, 'wanter dies');
      await b.call({ cmd: 'failSwap', on: false });
      await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
      assert.equal((await b.call('status')).status.role, 'stale');
      released(p.dir, b.child.pid, 'stale', 8);
      assert.equal(existsSync(jsonPath(p.dir)), false);
      await assert.rejects(get(port), { code: 'ECONNREFUSED' });
    } else {
      await b.call({ cmd: 'failSwap', on: false });
      await b.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
      await owns(a);
      assert.equal((await a.call('status')).status.port, port);
      assert.equal(lockOps(b, offset).filter((m) => m.op === 'rename').length, 1);
      assert.equal(existsSync(join(p.dir, 'server.want')), false);
    }
  });
}

for (const reason of ['quit', undefined]) {
  test(`RL1 ${reason ?? 'missing'}: enabled close retains RELEASED and equal-generation takeover is gapless`, async (t) => {
    const p = protocol(t, 9);
    const x = await p.child('X', 9);
    const port = portOf((await x.call('ensure')).result.url);
    const offset = x.seen.length;
    await x.call({ cmd: 'release', reason });
    const rec = released(p.dir, x.child.pid, 'quit', 9);
    assert.equal(rec.port, port);
    assert.equal(existsSync(jsonPath(p.dir)), false);
    assert.deepEqual(lockOps(x, offset).map((m) => m.op), ['rename']);
    await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
    const y = await p.child('Y', 9);
    await y.call('ensure');
    assert.equal((await y.call('status')).status.port, port);
    assert.deepEqual(lockOps(y).map((m) => m.op), ['link', 'rename', 'unlink']);
    assert.equal(existsSync(join(p.dir, `${SERVER_LOCK}.stale-${rec.nonce}`)), false);
  });
}

async function gateOrDone(c, id, done) {
  let listener;
  return within(Promise.race([
    new Promise((resolve) => {
      listener = (m) => { if (m.type === 'gate' && m.id === id) resolve(true); };
      c.child.on('message', listener);
    }),
    done.then(() => false),
  ]), 5000, `gate ${id} or completed operation`).finally(() => c.child.off('message', listener));
}

for (const trigger of ['quit', 'missing', 'stale', 'grace']) {
  for (const boundary of [1, 2, 3, 4, 'after']) {
    test(`RL2 ${trigger} boundary ${boundary}: late real want never observes an absent enabled lock`, { timeout: 30000 }, async (t) => {
      const p = protocol(t);
      const b = await p.child('B', 8);
      const port = portOf((await b.call('ensure')).result.url);
      if (trigger === 'grace') await b.call({ cmd: 'release', reason: 'reload' });
      const startB = b.seen.length;
      p.setInstalled(9);
      const a = await p.child('A', 9);
      await a.call({ cmd: 'gate', gateId: 'want', names: ['server.want'], ops: ['rename'] });
      const wanting = a.call('ensure');
      await a.waitFor((m) => m.type === 'gate' && m.id === 'want', 5000, 'health-checked want held');
      assert.equal(existsSync(join(p.dir, 'server.want')), false);
      const startA = a.seen.length;
      if (boundary !== 'after') await b.call({
        cmd: 'gate', gateId: 'close-boundary', after: 'closed',
        names: ['server.lock', 'server.want'], nth: boundary,
      });
      const ending = trigger === 'stale' ? b.call({ cmd: 'tick', ms: CHECK_EVERY_MS }) :
        trigger === 'grace' ? b.call({ cmd: 'fire', ms: 15000 }) :
          b.call({ cmd: 'release', reason: trigger === 'missing' ? undefined : 'quit' });
      const held = boundary === 'after' ? (await ending, false) : await gateOrDone(b, 'close-boundary', ending);
      await a.call({ cmd: 'open', gateId: 'want' });
      await wanting;
      if (held) await b.call({ cmd: 'open', gateId: 'close-boundary' });
      await ending;
      await a.call('ensure');
      const lock = JSON.parse(readFileSync(lockPath(p.dir), 'utf8'));
      assert.equal(lock.pid, a.child.pid);
      assert.equal(lock.generation, 9);
      assert.equal(lock.port, port);
      for (const [c, offset] of [[b, startB], [a, startA]]) {
        assert.equal(lockOps(c, offset).some((m) => m.name === SERVER_LOCK && /unlink|wx/.test(m.op)), false, 'no enabled lock unlink or wx');
        assert.equal(c.seen.slice(offset).some((m) => m.type === 'lock-read' && m.absent), false, 'no absent lock read');
      }
      const bOps = lockOps(b, startB);
      assert.deepEqual(bOps.map((m) => m.op), ['rename']);
      assert.ok(b.seen.slice(startB).find((m) => m.type === 'closed').seq < bOps[0].seq);
      const aOps = lockOps(a, startA);
      const listening = a.seen.find((m) => m.type === 'listening');
      if (aOps.length) {
        assert.deepEqual(aOps.map((m) => m.op), ['link', 'rename', 'unlink']);
        assert.ok(aOps[0].seq < listening.seq && listening.seq < aOps[1].seq && aOps[1].seq < aOps[2].seq);
      } else {
        assert.ok(a.seen.some((m) => m.type === 'lock-read' && m.rec?.pid === a.child.pid && m.seq < listening.seq));
      }
      const health = JSON.parse((await get(port, '/health')).body);
      assert.equal(health.pid, a.child.pid);
      assert.equal(health.generation, 9);
      assert.match((await get(port)).body, /content="9"/);
      assert.equal(existsSync(join(p.dir, 'server.want')), false);
    });
  }
}

for (let round = 0; round < 3; round++) {
  test(`RL3 round ${round}: simultaneous RELEASED takers have exactly one listener and commit`, async (t) => {
    const p = protocol(t, 9);
    const x = await p.child('X', 9);
    await x.call('ensure');
    await x.call({ cmd: 'release', reason: 'quit' });
    const y = await p.child('Y', 9);
    const z = await p.child('Z', 9);
    for (const c of [y, z]) {
      await c.call({ cmd: 'gate', gateId: 'read', lockRead: 'released', ops: ['readFile'] });
      await c.call({ cmd: 'gate', gateId: 'commit', names: [SERVER_LOCK], ops: ['rename'] });
    }
    const tasks = [y, z].map((c) => c.call('ensure'));
    await Promise.all([y, z].map((c) => c.waitFor((m) => m.type === 'gate' && m.id === 'read', 5000, 'released read')));
    const gates = [y, z].map((c, i) => gateOrDone(c, 'commit', tasks[i]));
    await Promise.all([y, z].map((c) => c.call({ cmd: 'open', gateId: 'read' })));
    const reached = await Promise.all(gates);
    assert.equal(reached.filter(Boolean).length, 1, 'exclusive claim permits exactly one commit');
    assert.equal([y, z].filter((c) => c.seen.some((m) => m.type === 'listening')).length, 1, 'only the claim winner listens');
    await Promise.all([y, z].map((c) => c.call({ cmd: 'open', gateId: 'commit' })));
    await Promise.all(tasks);
    await Promise.all([y, z].map((c) => c.call('ensure')));
    const statuses = await Promise.all([y, z].map(async (c) => (await c.call('status')).status));
    assert.deepEqual(statuses.map((s) => s.role).sort(), ['client', 'owner']);
    const winner = [y, z][statuses.findIndex((s) => s.role === 'owner')];
    assert.equal(JSON.parse(readFileSync(lockPath(p.dir), 'utf8')).pid, winner.child.pid);
    assert.equal([...lockOps(y), ...lockOps(z)].filter((m) => m.op === 'rename').length, 1);
  });
}

test('RL4: a stale exact-text reader cannot commit through a freed claim slot', async (t) => {
  const p = protocol(t, 9);
  const x = await p.child('X', 9);
  await x.call('ensure');
  await x.call({ cmd: 'release', reason: 'quit' });
  const y = await p.child('Y', 9);
  await y.call({ cmd: 'gate', gateId: 'read', lockRead: 'released' });
  const stale = y.call('ensure');
  await y.waitFor((m) => m.type === 'gate' && m.id === 'read', 5000, 'stale released read');
  const z = await p.child('Z', 9);
  await z.call('ensure');
  const winner = readFileSync(lockPath(p.dir), 'utf8');
  await y.call({ cmd: 'open', gateId: 'read' });
  await stale;
  assert.deepEqual(lockOps(y).map((m) => m.op), ['link', 'unlink'], 'stale reader drops its claim without replacing');
  assert.equal(y.seen.some((m) => m.type === 'listening'), false, 'exact text must be checked before listening');
  assert.equal(readFileSync(lockPath(p.dir), 'utf8'), winner);
  assert.equal((await y.call('status')).status.role, 'client');
});

test('RL5: six real dead claimers recover through bounded-length slots; legacy never bypasses them', { timeout: 30000 }, async (t) => {
  const p = protocol(t, 9);
  const x = await p.child('X', 9);
  const port = portOf((await x.call('ensure')).result.url);
  await x.call({ cmd: 'release', reason: 'quit' });
  const rec = released(p.dir, x.child.pid, 'quit', 9);
  const base = `${SERVER_LOCK}.stale-${rec.nonce}`;
  let name = base;
  for (let i = 0; i < 6; i++) {
    const c = await p.child(`crash-${i}`, 9);
    await c.call({ cmd: 'crashAt', point: 'after-claim' });
    const crashing = c.call('ensure').then(() => 'returned', async () => { await c.closed; return 'exited'; });
    const outcome = await within(Promise.race([crashing, c.closed.then(() => 'exited')]), 5000, 'claim outcome');
    assert.equal(outcome, 'exited', 'an eligible fixed claimer must reach its after-claim crash gate');
    await crashing;
    assert.equal(c.child.exitCode, 1);
    assert.equal(c.seen.some((m) => m.type === 'listening'), false);
    const claim = JSON.parse(readFileSync(join(p.dir, name), 'utf8'));
    assert.equal(claim.pid, c.child.pid);
    assert.equal(claim.claims, rec.nonce);
    name = `${base}.${claim.nonce}`;
  }
  const legacy = await p.child('legacy', 7, true);
  await legacy.call('ensure');
  assert.deepEqual(lockOps(legacy), []);
  const z = await p.child('Z', 9);
  await z.call('ensure');
  assert.equal((await z.call('status')).status.role, 'owner');
  assert.equal((await z.call('status')).status.port, port);
  assert.equal(lockOps(z)[0].name, name);
  assert.deepEqual(lockOps(z).map((m) => m.op), ['link', 'rename', 'unlink']);
  const leftovers = readdirSync(p.dir).filter((n) => n.startsWith(base));
  assert.equal(leftovers.length, 6);
  assert.ok(leftovers.every((n) => n.length <= base.length + 37), 'claim filenames stay bounded after repeated crashes');
});

for (const point of ['before-lock-swap', 'after-lock-swap']) {
  test(`RL7 ${point}: a crash during release leaves a gapless recoverable record`, async (t) => {
    const p = protocol(t, 9);
    const x = await p.child('X', 9);
    const port = portOf((await x.call('ensure')).result.url);
    const offset = x.seen.length;
    await x.call({ cmd: 'crashAt', point });
    const crashing = x.call({ cmd: 'release', reason: 'quit' }).catch(() => null);
    await within(x.closed, 5000, 'release crash');
    await crashing;
    assert.equal(x.child.exitCode, 1);
    assert.equal(existsSync(lockPath(p.dir)), true);
    const y = await p.child('Y', 9);
    await y.call('ensure');
    assert.equal((await y.call('status')).status.role, 'owner');
    assert.equal((await y.call('status')).status.port, port);
    assert.deepEqual(lockOps(y).map((m) => m.op), ['link', 'rename', 'unlink']);
    assert.equal(lockOps(x, offset).some((m) => m.name === SERVER_LOCK && /unlink|wx/.test(m.op)), false);
  });
}

for (const reason of ['quit', undefined, 'stale']) {
  test(`RL8 ${reason ?? 'missing reason'}: failed release rename retains HELD without serving until release succeeds`, async (t) => {
    const p = protocol(t, 9);
    const x = await p.child('X', 9);
    const port = portOf((await x.call('ensure')).result.url);
    const before = readFileSync(lockPath(p.dir), 'utf8');
    const offset = x.seen.length;
    await x.call({ cmd: 'failSwap', on: true });
    if (reason === 'stale') p.setInstalled(10);
    await x.call(reason === 'stale' ? { cmd: 'tick', ms: CHECK_EVERY_MS } : { cmd: 'release', reason });
    const y = await p.child('Y', reason === 'stale' ? 10 : 9);
    for (let i = 0; i < 3; i++) {
      await x.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
      assert.equal(existsSync(lockPath(p.dir)), true, 'failed release must retain HELD');
      assert.equal(readFileSync(lockPath(p.dir), 'utf8'), before, 'failed rename preserves exact HELD bytes');
      assert.equal((await x.call('status')).status.role, 'unavailable');
      assert.equal(x.seen.slice(offset).some((m) => m.type === 'listening'), false, 'retiring owners never rebind');
      assert.deepEqual(lockOps(x, offset), []);
      await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
      await assert.rejects(get(port), { code: 'ECONNREFUSED' });
      await y.call('ensure');
      assert.notEqual((await y.call('status')).status.role, 'owner');
      assert.deepEqual(lockOps(y), []);
    }
    assert.ok(x.seen.some((m) => m.type === 'error' && m.key === 'server:lock'));
    await x.call({ cmd: 'failSwap', on: false });
    await x.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
    released(p.dir, x.child.pid, reason ?? 'quit', 9);
    const retired = readFileSync(lockPath(p.dir), 'utf8');
    const retiredOffset = x.seen.length;
    await x.call({ cmd: 'tick', ms: CHECK_EVERY_MS });
    await assert.rejects(get(port, '/health'), { code: 'ECONNREFUSED' });
    await assert.rejects(get(port), { code: 'ECONNREFUSED' });
    assert.equal(readFileSync(lockPath(p.dir), 'utf8'), retired);
    assert.equal(existsSync(jsonPath(p.dir)), false);
    assert.equal(x.seen.slice(retiredOffset).some((m) => m.type === 'listening'), false);
    assert.deepEqual(lockOps(x, retiredOffset), []);
    await y.call('ensure');
    assert.equal((await y.call('status')).status.role, 'owner');
    assert.equal((await y.call('status')).status.port, port);
    assert.equal(JSON.parse((await get(port, '/health')).body).pid, y.child.pid);
    assert.notEqual(readFileSync(lockPath(p.dir), 'utf8'), retired);
  });
}

test('RL9: stale/R2 guards apply to RELEASED records before and after exclusive claim', async (t) => {
  const p = protocol(t, 9);
  const x = await p.child('X', 9);
  await x.call('ensure');
  await x.call({ cmd: 'release', reason: 'quit' });
  const rec = released(p.dir, x.child.pid, 'quit', 9);
  const before = readFileSync(lockPath(p.dir), 'utf8');
  const stale = await p.child('stale', 8);
  await stale.call('ensure');
  assert.equal((await stale.call('status')).status.role, 'stale');
  assert.deepEqual(lockOps(stale), []);
  for (const guard of ['installed', 'want']) {
    p.setInstalled(9);
    const y = await p.child(guard, 9);
    const name = `${SERVER_LOCK}.stale-${rec.nonce}`;
    await y.call({ cmd: 'gate', gateId: 'claimed', names: [name], ops: ['link'], phase: 'after' });
    const claiming = y.call('ensure');
    await y.waitFor((m) => m.type === 'gate' && m.id === 'claimed', 5000, 'exclusive claim held');
    if (guard === 'installed') p.setInstalled(10);
    else p.store.replace('server.want', { pid: process.pid, nonce: 'higher-live', at: Date.now(), generation: 10 });
    await y.call({ cmd: 'open', gateId: 'claimed' });
    await claiming;
    assert.equal(readFileSync(lockPath(p.dir), 'utf8'), before);
    if (guard === 'installed') assert.equal((await y.call('status')).status.role, 'stale');
    assert.equal(y.seen.some((m) => m.type === 'listening'), false, 'eligibility must be rechecked under the claim');
    assert.deepEqual(lockOps(y).map((m) => m.op), ['link', 'unlink']);
    if (guard === 'want') {
      const z = await p.child('R2-before', 9);
      await z.call('ensure');
      assert.deepEqual(lockOps(z), [], 'fresh higher want blocks before claiming RELEASED');
      assert.equal(readFileSync(lockPath(p.dir), 'utf8'), before);
    }
  }
});

test('no child process started by this file is left alive', (t) => {
  assert.ok(children.length >= 6);
  for (const c of children) {
    assert.ok(c.exitCode !== null || c.signalCode !== null, `child ${c.pid} still running`);
    assert.equal(isPidAlive(c.pid), false, `pid ${c.pid} alive`);
    t.diagnostic(`CHILD-CLEANUP pid=${c.pid} exit=${c.exitCode} signal=${c.signalCode}`);
  }
});
