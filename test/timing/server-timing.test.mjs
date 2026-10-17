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
import { createServerHost, SERVER_LOCK, SERVER_JSON, CHECK_EVERY_MS, POLL_MS } from '../../src/server-host.mjs';
import { createBoardServer } from '../../src/server.mjs';
import { openStore, isPidAlive } from '../../src/store.mjs';


// Original test bodies, unchanged; run on a quiet PC.
{
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

function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`timeout ${ms}ms: ${what}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

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
    const released = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
    assert.deepEqual(
      { pid: released.pid, generation: released.generation, released: released.released, port: released.port },
      { pid: process.pid, generation: 4, released: 'quit', port: portOf(r.url) },
    );
  } finally {
    removeState(dir);
  }
});

}
{
// All ports >= 47390. Each test starts its scan at a different base so parallel suites rarely collide;
// the server's own port scan absorbs the collisions that remain (tests read the bound port from start()).
let baseCounter = 0;
function nextBase() {
  return 47400 + ((process.pid % 60) * 24) + ((baseCounter++) % 2) * 12;
}

const VM = { gen: 4, seq: 7, sessions: [{ id: 's1', title: 'a\nb "quoted" \u2028 end' }] };

function makeServer(over = {}) {
  const errors = [];
  const recovered = [];
  const counts = [];
  const opts = {
    getPage: () => '<!doctype html><title>board</title><script>window.__vm=' + JSON.stringify(VM) + '</script>',
    getViewModel: () => VM,
    generation: 4,
    portBase: nextBase(),
    onError: (key, err) => errors.push({ key, err }),
    onRecover: (key) => recovered.push(key),
    onClientCount: (n) => counts.push(n),
    ...over,
  };
  return { server: createBoardServer(opts), errors, recovered, counts, opts };
}

async function withServer(over, fn) {
  const ctx = makeServer(over);
  const { port } = await ctx.server.start();
  try {
    await fn({ ...ctx, port });
  } finally {
    await ctx.server.close();
  }
}

// Every response header set and raw response this file sees, checked for Access-Control-* by the last test.
const seenHeaders = [];
const seenRaw = [];

// body: string | Buffer, or an array of chunks (sent without Content-Length, so chunked)
function request({ port, path = '/', method = 'GET', headers = {}, host = '127.0.0.1', body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method, headers: { Connection: 'close', ...headers }, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { seenHeaders.push(res.headers); resolve({ status: res.statusCode, headers: res.headers, body: text }); });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (Array.isArray(body)) {
      for (const chunk of body) req.write(chunk);
      req.end();
    } else {
      req.end(body);
    }
  });
}

function raw(port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write(text));
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (c) => { buf += c; });
    s.on('end', () => resolve(buf));
    s.on('close', () => { seenRaw.push(buf); resolve(buf); });
    s.on('error', reject);
  });
}

function sse(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers, agent: false }, (res) => {
      seenHeaders.push(res.headers);
      let buf = '';
      const waiters = new Set();
      const check = () => { for (const w of [...waiters]) w.test(); };
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; check(); });
      res.on('close', check);
      res.on('error', () => {}); // server-side teardown surfaces as an aborted response; 'close' is the signal
      const api = {
        req,
        res,
        status: res.statusCode,
        headers: res.headers,
        get text() { return buf; },
        waitFor(re, ms = 2000) {
          return new Promise((ok, fail) => {
            const w = {
              test() {
                const m = re.exec(buf);
                if (m) { clean(); ok(m); } else if (res.destroyed && res.complete !== false && res.readableEnded) { clean(); fail(new Error(`stream ended before ${re}: ${buf}`)); }
              },
            };
            const timer = setTimeout(() => { clean(); fail(new Error(`timeout waiting ${re}; got: ${JSON.stringify(buf)}`)); }, ms);
            const clean = () => { clearTimeout(timer); waiters.delete(w); };
            waiters.add(w);
            w.test();
          });
        },
        closed: new Promise((ok) => res.on('close', ok)),
      };
      resolve(api);
    });
    req.on('error', reject);
  });
}

function occupy(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(e)));
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}
const closeNet = (s) => new Promise((r) => (s ? s.close(r) : r()));

test('SSE: retry + current data on connect, one-line JSON, broadcast arrives within 200ms', async () => {
  await withServer({}, async ({ port, server, recovered }) => {
    const s = await sse(port);
    assert.equal(s.status, 200);
    assert.match(s.headers['content-type'], /^text\/event-stream/);
    assert.equal(s.headers['cache-control'], 'no-store');
    await s.waitFor(/retry: 1000\n\nevent: data\ndata: [^\n]*\n\n/);
    const first = /event: data\ndata: ([^\n]*)\n\n/.exec(s.text)[1];
    assert.deepEqual(JSON.parse(first), VM);
    assert.equal(server.clientCount(), 1);

    const vm2 = { ...VM, seq: 8, note: 'line1\nline2' };
    const t0 = performance.now();
    server.broadcast(vm2);
    const m = await s.waitFor(/event: data\ndata: (\{[^\n]*"seq":8[^\n]*\})\n\n/, 200);
    assert.ok(performance.now() - t0 < 200);
    assert.deepEqual(JSON.parse(m[1]), vm2);
    assert.ok(recovered.includes('server:listen'));
    s.req.destroy();
  });
});

test('close() with three open SSE streams closes connections before the listener within 500ms', async () => {
  const calls = [];
  const ctx = makeServer({
    createServer: (handler) => {
      const s = http.createServer(handler);
      const closeAll = s.closeAllConnections.bind(s);
      const close = s.close.bind(s);
      s.closeAllConnections = () => { calls.push('closeAllConnections'); return closeAll(); };
      s.close = (...args) => { calls.push('close'); return close(...args); };
      return s;
    },
  });
  const { port } = await ctx.server.start();
  const streams = [await sse(port), await sse(port), await sse(port)];
  for (const s of streams) await s.waitFor(/event: data/);
  assert.equal(ctx.server.clientCount(), 3);
  const t0 = performance.now();
  await ctx.server.close();
  assert.ok(performance.now() - t0 <= 500, `close took ${performance.now() - t0}ms`);
  assert.deepEqual(calls, ['closeAllConnections', 'close']);
  for (const s of streams) await s.closed;
  assert.equal(ctx.server.clientCount(), 0);
  await assert.rejects(request({ port, path: '/health' }), (e) => e.code === 'ECONNREFUSED');
  await ctx.server.close(); // idempotent
  // Forced teardown may report stream/socket errors, but must not fail the server close boundary.
  assert.ok(ctx.errors.every(({ key, err }) => key === 'server:sse' && err instanceof Error));
});

}
