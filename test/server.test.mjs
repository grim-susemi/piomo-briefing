import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { createBoardServer } from '../src/server.mjs';

// All ports >= 47390. Each test starts its scan at a different base so parallel suites rarely collide;
// the server's own port scan absorbs the collisions that remain (tests read the bound port from start()).
let baseCounter = 0;
function nextBase() {
  return 47390 + ((process.pid % 300) * 20) + ((baseCounter++) % 20) * 10;
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

test('GET / serves the page with the hardening headers and no CORS', async () => {
  await withServer({}, async ({ port }) => {
    const r = await request({ port, path: '/' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html; charset=utf-8/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.match(r.body, /window\.__vm=/);
  });
});

test('/data.json is JSON + nosniff, /health has its fields, /data.js and unknown paths are 404', async () => {
  await withServer({}, async ({ port }) => {
    const h0 = await request({ port, path: '/health' });
    assert.deepEqual(JSON.parse(h0.body), { ok: true, generation: 4, seq: 0, pid: process.pid }, 'no model served yet');
    const d = await request({ port, path: '/data.json' });
    assert.equal(d.status, 200);
    assert.equal(d.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(d.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(JSON.parse(d.body), VM);

    const h = await request({ port, path: '/health' });
    assert.equal(h.status, 200);
    assert.deepEqual(JSON.parse(h.body), { ok: true, generation: 4, seq: 7, pid: process.pid }, 'seq follows the model last served');

    for (const p of ['/data.js', '/nope', '/events/', '//data.json', '/index.html']) {
      const r = await request({ port, path: p });
      assert.equal(r.status, 404, p);
      assert.equal(r.headers['cache-control'], 'no-store', p);
      assert.doesNotMatch(r.body, /__briefData/, p);
    }
    const q = await request({ port, path: '/health?x=1' });
    assert.equal(q.status, 200, 'a query string does not change the route');
  });
});

test('health seq follows the latest broadcast', async () => {
  await withServer({}, async ({ port, server }) => {
    server.broadcast({ ...VM, seq: 12 });
    const h = await request({ port, path: '/health' });
    assert.equal(JSON.parse(h.body).seq, 12);
  });
});

test('Host header: foreign / missing / wrong-port hosts are 403, localhost:<port> is 200', async () => {
  await withServer({}, async ({ port }) => {
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `localhost:${port + 1}`, `127.0.0.1.evil.example:${port}`]) {
      const r = await request({ port, path: '/health', headers: { Host: host } });
      assert.equal(r.status, 403, host);
      const p = await request({ port, path: '/', headers: { Host: host } });
      assert.equal(p.status, 403, `GET / with ${host}`);
    }
    assert.equal((await request({ port, path: '/health', headers: { Host: `localhost:${port}` } })).status, 200);
    assert.equal((await request({ port, path: '/health', headers: { Host: `127.0.0.1:${port}` } })).status, 200);
    // HTTP/1.0 without any Host header
    const noHost = await raw(port, 'GET /health HTTP/1.0\r\n\r\n');
    assert.match(noHost, /^HTTP\/1\.\d 403 /);
  });
});

test('Sec-Fetch-Site gates /data.json, /events, /health but not GET /', async () => {
  await withServer({}, async ({ port }) => {
    for (const p of ['/data.json', '/events', '/health']) {
      for (const bad of ['cross-site', 'same-site', 'bogus', '']) {
        if (p === '/events') {
          const s = await sse(port, { 'Sec-Fetch-Site': bad });
          assert.equal(s.status, 403, `${p} ${JSON.stringify(bad)}`);
          s.req.destroy();
        } else {
          const r = await request({ port, path: p, headers: { 'Sec-Fetch-Site': bad } });
          assert.equal(r.status, 403, `${p} ${JSON.stringify(bad)}`);
        }
      }
      for (const ok of ['same-origin', 'none', null]) {
        const headers = ok === null ? {} : { 'Sec-Fetch-Site': ok };
        if (p === '/events') {
          const s = await sse(port, headers);
          assert.equal(s.status, 200, `${p} ${ok}`);
          s.req.destroy();
        } else {
          const r = await request({ port, path: p, headers });
          assert.equal(r.status, 200, `${p} ${ok}`);
        }
      }
    }
    const top = await request({ port, path: '/', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(top.status, 200, 'top-level navigation stays allowed');
  });
});

test('non-GET methods are 405 except the two guarded writes, and no response ever carries Access-Control-*', async () => {
  await withWriteServer({}, async ({ port, calls }) => {
    const seen = [];
    for (const p of ['/', '/data.json', '/health', '/nope', '/data.js']) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
        const r = await request({ port, path: p, method, headers: { Origin: 'http://evil.example' } });
        assert.equal(r.status, 405, `${method} ${p}`);
        assert.equal(r.headers.allow, 'GET', `${method} ${p}`);
        seen.push(r.headers);
      }
    }
    for (const p of ['/answer', '/focus']) {
      for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
        // even a fully valid write request is refused when it is not a POST
        // (Node's client sends no framing for a DELETE/HEAD/OPTIONS body unless Content-Length is explicit)
        const body = JSON.stringify(BODY_FOR[p]);
        const r = await request({ port, path: p, method, headers: writeHeaders(port, { 'Content-Length': String(Buffer.byteLength(body)) }), body });
        assert.equal(r.status, 405, `${method} ${p}`);
        assert.equal(r.headers.allow, 'POST', `${method} ${p}`);
        seen.push(r.headers);
      }
      const get = await request({ port, path: p });
      assert.equal(get.status, 404, `GET ${p} stays a plain 404`);
      seen.push(get.headers);
    }
    assert.deepEqual(calls, { answer: [], focus: [] });
    for (const p of ['/', '/data.json', '/health', '/nope', '/data.js']) {
      seen.push((await request({ port, path: p, headers: { Origin: 'http://evil.example' } })).headers);
    }
    seen.push((await request({ port, path: '/health', headers: { Host: 'evil.example' } })).headers);
    const s = await sse(port, { Origin: 'http://evil.example' });
    seen.push(s.headers);
    s.req.destroy();
    for (const h of seen) {
      assert.deepEqual(Object.keys(h).filter((k) => k.toLowerCase().startsWith('access-control-')), []);
      assert.equal(h['cache-control'], 'no-store');
      assert.equal(h['x-frame-options'], 'DENY');
      assert.equal(h['referrer-policy'], 'no-referrer');
    }
  });
});

test('without a token and callbacks the write routes do not exist: POST is 405 like any other non-GET', async () => {
  await withServer({}, async ({ port }) => {
    for (const p of ['/answer', '/focus']) {
      const r = await request({ port, path: p, method: 'POST', headers: writeHeaders(port), body: '{}' });
      assert.equal(r.status, 405, p);
      assert.equal(r.headers.allow, 'GET', p);
    }
  });
  await withServer({ token: '' , onAnswer: async () => ({ status: 200, json: { ok: true } }), onFocus: async () => ({ status: 200, json: { ok: true } }) }, async ({ port }) => {
    const r = await request({ port, path: '/answer', method: 'POST', headers: writeHeaders(port, { 'X-Board-Token': '' }), body: '{}' });
    assert.equal(r.status, 405, 'an empty token never enables a write route');
  });
});

test('malformed request line gets 400, reports server:sse and keeps serving', async () => {
  await withServer({}, async ({ port, errors }) => {
    const bad = await raw(port, 'THIS IS NOT HTTP\r\n\r\n');
    assert.match(bad, /^HTTP\/1\.1 400 /);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].key, 'server:sse');
    assert.ok(errors[0].err instanceof Error);
    assert.equal(errors[0].err.code, 'HPE_INVALID_METHOD');
    assert.equal((await request({ port, path: '/health' })).status, 200);
  });
});

test('request, response and non-SSE socket reset errors reach server:sse', async () => {
  const failures = ['ECONNRESET', 'EPIPE', 'ECONNRESET'].map((code) => Object.assign(new Error(code), { code }));
  await withServer({
    createServer: (handler) => http.createServer((req, res) => {
      handler(req, res);
      req.emit('error', failures[0]);
      res.emit('error', failures[1]);
      req.socket.emit('error', failures[2]);
    }),
  }, async ({ port, errors }) => {
    assert.equal((await request({ port, path: '/health' })).status, 200);
    assert.ok(errors.every(({ key }) => key === 'server:sse'));
    // One socket error can also reach clientError; every injected error must still be reported.
    assert.deepEqual([...new Set(errors.map(({ err }) => err))], failures);
  });
});

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

test('SSE: a pending initial snapshot cannot replace a newer broadcast', { timeout: 5000 }, async () => {
  const reading = Promise.withResolvers();
  const snapshot = Promise.withResolvers();
  const latest = { ...VM, seq: 99, sessions: [{ id: 'new', title: 'broadcast' }] };
  await withServer({
    getViewModel: () => { reading.resolve(); return snapshot.promise; },
  }, async ({ port, server }) => {
    const connected = sse(port);
    await reading.promise;
    assert.equal(server.clientCount(), 0, 'the initial model read is still pending');
    assert.equal(server.broadcast(latest), 0, 'the pending client has not received a broadcast frame');
    snapshot.resolve({ ...VM, seq: 98 });
    const stream = await connected;
    try {
      const frame = await stream.waitFor(/event: data\ndata: ([^\n]*)\n\n/);
      assert.deepEqual(JSON.parse(frame[1]), latest);
    } finally {
      stream.req.destroy();
    }
  });
});

test('SSE: sendPaused emits event: paused to connected pages', async () => {
  await withServer({}, async ({ port, server }) => {
    const s = await sse(port);
    await s.waitFor(/event: data/);
    server.sendPaused();
    await s.waitFor(/event: paused\ndata: [^\n]*\n\n/, 500);
    s.req.destroy();
  });
});

test('SSE: keep-alive ping comment is sent on the injected interval', async () => {
  await withServer({ pingMs: 20 }, async ({ port }) => {
    const s = await sse(port);
    await s.waitFor(/\n: ping\n\n/, 2000);
    s.req.destroy();
  });
});

test('SSE: the 17th concurrent client is 503, and a freed slot is reusable', async () => {
  await withServer({}, async ({ port, server }) => {
    const open = [];
    for (let i = 0; i < 16; i++) open.push(await sse(port));
    assert.ok(open.every((s) => s.status === 200));
    assert.equal(server.clientCount(), 16);
    const extra = await sse(port);
    assert.equal(extra.status, 503);
    assert.equal(extra.headers['cache-control'], 'no-store');
    extra.req.destroy();
    assert.equal(server.clientCount(), 16, 'a rejected client is not counted');
    open[0].req.destroy();
    await open[0].closed;
    const again = await Promise.race([
      (async () => { for (;;) { const s = await sse(port); if (s.status === 200) return s; s.req.destroy(); } })(),
      new Promise((_, no) => setTimeout(() => no(new Error('slot never freed')), 3000).unref()),
    ]);
    assert.equal(again.status, 200);
    again.req.destroy();
    for (const s of open.slice(1)) s.req.destroy();
  });
});

test('SSE: a disconnected client is removed from the client list', async () => {
  const waiters = [];
  await withServer({
    onClientCount: (n) => { for (const w of [...waiters]) w(n); },
  }, async ({ port, server }) => {
    const s = await sse(port);
    await s.waitFor(/event: data/);
    assert.equal(server.clientCount(), 1);
    const zero = new Promise((ok, no) => {
      const timer = setTimeout(() => no(new Error('clientCount never dropped')), 3000);
      waiters.push((n) => { if (n === 0) { clearTimeout(timer); ok(); } });
    });
    s.req.destroy();
    await zero;
    assert.equal(server.clientCount(), 0);
  });
});

test('SSE: a socket reset in mid-stream reaches onError and the server survives', async () => {
  const got = Promise.withResolvers();
  await withServer({
    onError: (key, err) => got.resolve({ key, err }),
  }, async ({ port, server }) => {
    const sock = await new Promise((ok, no) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => ok(s));
      s.on('error', () => {}); // the client side also sees the reset
    });
    let buf = '';
    const sawData = new Promise((ok) => sock.on('data', (c) => { buf += c; if (/event: data/.test(buf)) ok(); }));
    sock.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    await sawData;
    assert.equal(server.clientCount(), 1);
    sock.resetAndDestroy();
    const { key, err } = await Promise.race([
      got.promise,
      new Promise((_, no) => setTimeout(() => no(new Error('onError not called after reset')), 3000).unref()),
    ]);
    assert.equal(key, 'server:sse');
    assert.ok(err instanceof Error);
    // The process is alive and still serving; the dead client is gone.
    assert.equal((await request({ port, path: '/health' })).status, 200);
    server.broadcast({ ...VM, seq: 9 });
    assert.equal(server.clientCount(), 0);
  });
});

test('getPage / getViewModel throwing -> 500 + onError, server keeps serving; SSE gets 500 before headers', async () => {
  let fail = true;
  await withServer({
    getPage: () => { if (fail) throw new Error('page boom'); return 'ok'; },
    getViewModel: () => { if (fail) throw new Error('vm boom'); return VM; },
  }, async ({ port, errors }) => {
    const p = await request({ port, path: '/' });
    assert.equal(p.status, 500);
    assert.equal(p.headers['cache-control'], 'no-store');
    assert.doesNotMatch(p.body, /boom/, 'internal error text is not leaked');
    const d = await request({ port, path: '/data.json' });
    assert.equal(d.status, 500);
    const s = await sse(port);
    assert.equal(s.status, 500);
    s.req.destroy();
    assert.equal(errors.length, 3);
    assert.ok(errors.every((e) => e.key === 'server:sse' && e.err instanceof Error));
    fail = false;
    assert.equal((await request({ port, path: '/' })).status, 200);
  });
});

test('async getPage / getViewModel are awaited', async () => {
  await withServer({
    getPage: async () => 'async-page',
    getViewModel: async () => ({ ...VM, seq: 21 }),
  }, async ({ port }) => {
    assert.equal((await request({ port, path: '/' })).body, 'async-page');
    assert.equal(JSON.parse((await request({ port, path: '/data.json' })).body).seq, 21);
    const s = await sse(port);
    await s.waitFor(/"seq":21/);
    s.req.destroy();
  });
});

test('binds 127.0.0.1 only: address check and refusal on a non-loopback IPv4 of this machine', async () => {
  await withServer({}, async ({ port, server }) => {
    assert.equal(server.address().address, '127.0.0.1');
    const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!external) return; // no non-loopback IPv4 on this machine: nothing more to probe
    const code = await new Promise((ok) => {
      const s = net.connect({ host: external.address, port });
      s.once('connect', () => { s.destroy(); ok('connected'); });
      s.once('error', (e) => ok(e.code));
    });
    assert.equal(code, 'ECONNREFUSED');
  });
});

test('port search: preferPort first, then the next free port', async () => {
  const base = nextBase();
  const blocker = await occupy(base + 1);
  try {
    const free = makeServer({ portBase: base, preferPort: base + 5 });
    const a = await free.server.start();
    assert.equal(a.port, base + 5, 'preferPort is tried first');
    await free.server.close();

    const busyPref = makeServer({ portBase: base, preferPort: base + 1 });
    const b = await busyPref.server.start();
    assert.notEqual(b.port, base + 1);
    assert.equal(b.port, base, 'falls back to the scan from portBase');
    await busyPref.server.close();

    const scan = makeServer({ portBase: base + 1 });
    const c = await scan.server.start();
    assert.equal(c.port, base + 2, 'EADDRINUSE skips to the next port');
    assert.deepEqual(scan.errors, [], 'the intentional EADDRINUSE skip is not an error');
    await scan.server.close();
  } finally {
    await closeNet(blocker);
  }
});

test('all ten ports busy -> NO_PORT, reported through onError("server:listen")', async () => {
  const base = nextBase();
  const blockers = [];
  for (let i = 0; i < 10; i++) blockers.push(await occupy(base + i));
  try {
    const ctx = makeServer({ portBase: base });
    await assert.rejects(ctx.server.start(), (e) => e.code === 'NO_PORT' && e.message.includes(String(base)) && e.message.includes(String(base + 9)));
    assert.equal(ctx.errors.length, 1);
    assert.equal(ctx.errors[0].key, 'server:listen');
    assert.equal(ctx.errors[0].err.code, 'NO_PORT');
    assert.equal(ctx.recovered.length, 0);
    await ctx.server.close();
  } finally {
    for (const b of blockers) await closeNet(b);
  }
});

test('listen EACCES (injected) moves on to the next port; other listen errors fail loudly', async () => {
  const base = nextBase();
  const denied = new Set([base]);
  const createServer = (handler) => {
    const s = http.createServer(handler);
    const realListen = s.listen.bind(s);
    s.listen = (port, host, cb) => {
      if (denied.has(port)) {
        process.nextTick(() => s.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })));
        return s;
      }
      return realListen(port, host, cb);
    };
    return s;
  };
  const ctx = makeServer({ portBase: base, createServer });
  const { port } = await ctx.server.start();
  assert.equal(port, base + 1);
  assert.deepEqual(ctx.errors, []);
  await ctx.server.close();

  const boom = makeServer({
    portBase: base,
    createServer: (handler) => {
      const s = http.createServer(handler);
      s.listen = () => { process.nextTick(() => s.emit('error', Object.assign(new Error('listen EINVAL'), { code: 'EINVAL' }))); return s; };
      return s;
    },
  });
  await assert.rejects(boom.server.start(), (e) => e.code === 'EINVAL');
  assert.equal(boom.errors.length, 1);
  assert.equal(boom.errors[0].key, 'server:listen');
  await boom.server.close();
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

test('close() before start() resolves, and start() after close() is refused', async () => {
  const ctx = makeServer({});
  await ctx.server.close();
  await assert.rejects(ctx.server.start(), /closed/i);
});

test('the server and its sockets are unref()-ed: a child process with an open SSE stream still exits', async () => {
  // A live server must not keep the owner session's event loop alive.
  const { spawn } = await import('node:child_process');
  const base = nextBase();
  const code = `
    import http from 'node:http';
    import { createBoardServer } from ${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)};
    const s = createBoardServer({ getPage: () => 'x', getViewModel: () => ({seq:1}), generation: 4, portBase: ${base}, onError() {}, onRecover() {} });
    const { port } = await s.start();
    const hold = setInterval(() => {}, 1000); // ref'd on purpose: keeps the loop alive until the stream is really open
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, (res) => {
      res.once('data', () => { console.log('streaming'); clearInterval(hold); });
    });
    req.on('socket', (sock) => sock.unref()); // the test client must not be what keeps the child alive
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((ok) => child.once('close', (c, sig) => ok({ c, sig })));
  const timer = setTimeout(() => child.kill(), 10000);
  const { c, sig } = await exited;
  clearTimeout(timer);
  assert.equal(sig, null, `child had to be killed (event loop kept alive by the server?)\n${out}${err}`);
  assert.equal(c, 0, err);
  assert.match(out, /streaming/, 'the SSE stream was really open when the loop drained');
});

// ---- guarded write routes: POST /answer and POST /focus ----

const TOKEN = 'board-token-' + 'x'.repeat(31);
const ANSWER = { id: 12, sessionId: 's1', option: 'B' };
const FOCUS = { sessionId: 's1' };
const BODY_FOR = { '/answer': ANSWER, '/focus': FOCUS };

function writeOptions(over = {}) {
  const calls = { answer: [], focus: [] };
  const options = {
    token: TOKEN,
    onAnswer: async (body) => { calls.answer.push(body); return { status: 200, json: { ok: true, id: body.id } }; },
    onFocus: async (body) => { calls.focus.push(body); return { status: 200, json: { ok: true } }; },
    ...over,
  };
  return { options, calls };
}
async function withWriteServer(over, fn) {
  const { options, calls } = writeOptions(over);
  await withServer(options, (ctx) => fn({ ...ctx, calls }));
}

// null removes a header
function writeHeaders(port, over = {}) {
  const headers = {
    'Sec-Fetch-Site': 'same-origin',
    Origin: `http://127.0.0.1:${port}`,
    'Content-Type': 'application/json',
    'X-Board-Token': TOKEN,
    ...over,
  };
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
  return headers;
}
function postWrite(port, path, body, over) {
  const plainObject = body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && !Array.isArray(body);
  return request({ port, path, method: 'POST', body: plainObject ? JSON.stringify(body) : body, headers: writeHeaders(port, over) });
}
function rawPost(port, path, partial, length) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      const head = [`POST ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, ...Object.entries(writeHeaders(port)).map(([k, v]) => `${k}: ${v}`), `Content-Length: ${length}`, '', ''];
      s.write(head.join('\r\n') + partial); // the rest of the declared body never comes
    });
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (c) => { buf += c; });
    s.on('close', () => { seenRaw.push(buf); resolve(buf); });
    s.on('error', reject);
  });
}
const nothingCalled = (calls, label) => assert.deepEqual(calls, { answer: [], focus: [] }, label);
const noCors = (headers, label) =>
  assert.deepEqual(Object.keys(headers).filter((k) => k.toLowerCase().startsWith('access-control-')), [], label);

test('write guards: each failing header guard answers its status and calls nothing', async () => {
  const rows = [
    ['missing Sec-Fetch-Site', () => ({ 'Sec-Fetch-Site': null }), 403, 'FORBIDDEN_SITE'],
    ['Sec-Fetch-Site cross-site', () => ({ 'Sec-Fetch-Site': 'cross-site' }), 403, 'FORBIDDEN_SITE'],
    ['Sec-Fetch-Site same-site', () => ({ 'Sec-Fetch-Site': 'same-site' }), 403, 'FORBIDDEN_SITE'],
    ['Sec-Fetch-Site none', () => ({ 'Sec-Fetch-Site': 'none' }), 403, 'FORBIDDEN_SITE'],
    ['Sec-Fetch-Site empty', () => ({ 'Sec-Fetch-Site': '' }), 403, 'FORBIDDEN_SITE'],
    ['missing Origin', () => ({ Origin: null }), 403, 'FORBIDDEN_ORIGIN'],
    ['foreign Origin', () => ({ Origin: 'http://evil.example' }), 403, 'FORBIDDEN_ORIGIN'],
    ['Origin null', () => ({ Origin: 'null' }), 403, 'FORBIDDEN_ORIGIN'],
    ['Origin of another port', (port) => ({ Origin: `http://127.0.0.1:${port + 1}` }), 403, 'FORBIDDEN_ORIGIN'],
    ['Origin localhost while Host is 127.0.0.1', (port) => ({ Origin: `http://localhost:${port}` }), 403, 'FORBIDDEN_ORIGIN'],
    ['Origin https', (port) => ({ Origin: `https://127.0.0.1:${port}` }), 403, 'FORBIDDEN_ORIGIN'],
    ['Origin with a trailing slash', (port) => ({ Origin: `http://127.0.0.1:${port}/` }), 403, 'FORBIDDEN_ORIGIN'],
    ['Content-Type text/plain', () => ({ 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_TYPE'],
    ['Content-Type form', () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }), 415, 'UNSUPPORTED_TYPE'],
    ['Content-Type multipart', () => ({ 'Content-Type': 'multipart/form-data; boundary=x' }), 415, 'UNSUPPORTED_TYPE'],
    ['Content-Type application/jsonp', () => ({ 'Content-Type': 'application/jsonp' }), 415, 'UNSUPPORTED_TYPE'],
    ['missing Content-Type', () => ({ 'Content-Type': null }), 415, 'UNSUPPORTED_TYPE'],
    ['missing token', () => ({ 'X-Board-Token': null }), 403, 'FORBIDDEN_TOKEN'],
    ['empty token', () => ({ 'X-Board-Token': '' }), 403, 'FORBIDDEN_TOKEN'],
    ['short token', () => ({ 'X-Board-Token': TOKEN.slice(0, -1) }), 403, 'FORBIDDEN_TOKEN'],
    ['longer token', () => ({ 'X-Board-Token': TOKEN + 'x' }), 403, 'FORBIDDEN_TOKEN'],
    ['same-length wrong token', () => ({ 'X-Board-Token': 'y'.repeat(TOKEN.length) }), 403, 'FORBIDDEN_TOKEN'],
    ['token wrong in the last character only', () => ({ 'X-Board-Token': TOKEN.slice(0, -1) + 'y' }), 403, 'FORBIDDEN_TOKEN'],
    ['foreign Host (plain-text 403 from the Host gate)', () => ({ Host: 'evil.example' }), 403, undefined],
  ];
  await withWriteServer({}, async ({ port, calls }) => {
    for (const path of ['/answer', '/focus']) {
      for (const [name, over, status, code] of rows) {
        const label = `${path} ${name}`;
        const r = await postWrite(port, path, BODY_FOR[path], over(port));
        assert.equal(r.status, status, label);
        if (code) assert.equal(JSON.parse(r.body).code, code, label);
        assert.ok(!r.body.includes(TOKEN), `${label}: the token is never echoed`);
        assert.equal(r.headers['cache-control'], 'no-store', label);
        noCors(r.headers, label);
        nothingCalled(calls, label);
      }
    }
  });
});

test('write guards: malformed or over-keyed bodies are 400 and call nothing', async () => {
  const A = (extra) => ({ ...ANSWER, ...extra });
  const rows = [
    ['/answer', 'empty body', ''],
    ['/answer', 'truncated JSON', '{"id":12'],
    ['/answer', 'JSON null', 'null'],
    ['/answer', 'JSON array', '[]'],
    ['/answer', 'JSON string', '"x"'],
    ['/answer', 'JSON number', '12'],
    ['/answer', 'invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
    ['/answer', 'extra key', A({ extra: 1 })],
    ['/answer', '__proto__ key', '{"id":12,"sessionId":"s1","option":"B","__proto__":{"admin":true}}'],
    ['/answer', 'option and text together', A({ text: 'hi' })],
    ['/answer', 'neither option nor text', { id: 12, sessionId: 's1' }],
    ['/answer', 'missing id', { sessionId: 's1', option: 'A' }],
    ['/answer', 'missing sessionId', { id: 12, option: 'A' }],
    ['/answer', 'id 0', A({ id: 0 })],
    ['/answer', 'id -1', A({ id: -1 })],
    ['/answer', 'id 1.5', A({ id: 1.5 })],
    ['/answer', 'id as a string', A({ id: '12' })],
    ['/answer', 'id true', A({ id: true })],
    ['/answer', 'id null', A({ id: null })],
    ['/answer', 'id beyond the safe integers', '{"id":9007199254740993,"sessionId":"s1","option":"A"}'],
    ['/answer', 'sessionId number', A({ sessionId: 5 })],
    ['/answer', 'sessionId null', A({ sessionId: null })],
    ['/answer', 'option D', A({ option: 'D' })],
    ['/answer', 'option lower-case a', A({ option: 'a' })],
    ['/answer', 'option empty', A({ option: '' })],
    ['/answer', 'option number', A({ option: 1 })],
    ['/answer', 'option array', A({ option: ['A'] })],
    ['/answer', 'text number', { id: 12, sessionId: 's1', text: 5 }],
    ['/answer', 'text null', { id: 12, sessionId: 's1', text: null }],
    ['/focus', 'empty body', ''],
    ['/focus', 'extra key', { sessionId: 's1', id: 12 }],
    ['/focus', 'no keys', {}],
    ['/focus', 'sessionId number', { sessionId: 7 }],
    ['/focus', 'sessionId null', { sessionId: null }],
    ['/focus', 'an answer-shaped body', ANSWER],
  ];
  await withWriteServer({}, async ({ port, calls }) => {
    for (const [path, name, body] of rows) {
      const label = `${path} ${name}`;
      const r = await postWrite(port, path, body);
      assert.equal(r.status, 400, label);
      assert.equal(JSON.parse(r.body).code, 'BAD_REQUEST', label);
      nothingCalled(calls, label);
    }
  });
});

test('write body size: 4096 bytes are read, 4097 are 413 whether declared or chunked, nothing is called when refused', async () => {
  const head = '{"id":12,"sessionId":"s1","text":"';
  const sized = (bytes) => head + 'x'.repeat(bytes - head.length - 2) + '"}';
  assert.equal(Buffer.byteLength(sized(4096)), 4096);
  await withWriteServer({}, async ({ port, calls }) => {
    const ok = await postWrite(port, '/answer', sized(4096));
    assert.equal(ok.status, 200, 'the 4096-byte limit itself is allowed');
    assert.equal(calls.answer.length, 1);

    const declared = await postWrite(port, '/answer', sized(4097));
    assert.equal(declared.status, 413);
    assert.equal(JSON.parse(declared.body).code, 'TOO_LARGE');

    const chunked = await postWrite(port, '/answer', [sized(3000), 'x'.repeat(2000)]);
    assert.equal(chunked.status, 413, 'no Content-Length: the bytes are counted as they arrive');

    assert.equal(calls.answer.length, 1, 'refused bodies reach no callback');
    assert.equal(calls.focus.length, 0);
    // the slot is released by a refusal
    assert.equal((await postWrite(port, '/focus', FOCUS)).status, 200);
  });
});

test('write body that stalls is 408 within bodyTimeoutMs and calls nothing', { timeout: 10000 }, async () => {
  await withWriteServer({ bodyTimeoutMs: 40 }, async ({ port, calls }) => {
    for (const path of ['/answer', '/focus']) {
      const text = await rawPost(port, path, '{"id"', 60);
      assert.match(text, /^HTTP\/1\.1 408 /, path);
      assert.match(text, /"code":"TIMEOUT"/, path);
      assert.doesNotMatch(text, /access-control-/i, path);
    }
    nothingCalled(calls, 'stalled bodies');
    assert.equal((await postWrite(port, '/focus', FOCUS)).status, 200, 'the slot is free again');
  });
});

test('write body that stalls past the default 2 s is 408', { timeout: 10000 }, async () => {
  await withWriteServer({}, async ({ port, calls }) => {
    const t0 = performance.now();
    const text = await rawPost(port, '/answer', '{"id"', 60);
    const elapsed = performance.now() - t0;
    assert.match(text, /^HTTP\/1\.1 408 /);
    assert.ok(elapsed >= 1900, `answered after ${elapsed}ms, before the 2000ms default`);
    nothingCalled(calls, 'stalled body');
  });
});

test('a valid write reaches its callback once and the callback result is the response', async () => {
  await withWriteServer({}, async ({ port, calls, server }) => {
    const a = await postWrite(port, '/answer', ANSWER);
    assert.equal(a.status, 200);
    assert.deepEqual(JSON.parse(a.body), { ok: true, id: 12 });
    assert.equal(a.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(a.headers['cache-control'], 'no-store');
    assert.equal(a.headers['x-frame-options'], 'DENY');
    noCors(a.headers, 'valid answer');
    assert.deepEqual(calls.answer, [ANSWER]);
    assert.deepEqual(calls.focus, []);

    const f = await postWrite(port, '/focus', FOCUS);
    assert.equal(f.status, 200);
    assert.deepEqual(JSON.parse(f.body), { ok: true });
    assert.deepEqual(calls.focus, [FOCUS]);

    const text = { id: 3, sessionId: 's2', text: '설치해 줘 [결정 전달]' };
    const t = await postWrite(port, '/answer', text, { 'Content-Type': 'Application/JSON; charset=utf-8' });
    assert.equal(t.status, 200);
    assert.deepEqual(calls.answer[1], text, 'text reaches the callback verbatim');

    // localhost is as good as 127.0.0.1 when Host and Origin agree
    const local = await postWrite(port, '/focus', FOCUS, { Host: `localhost:${port}`, Origin: `http://localhost:${port}` });
    assert.equal(local.status, 200);
    assert.equal(calls.focus.length, 2);

    // the token is a write credential only: no read route ever carries it
    const reads = [(await request({ port, path: '/' })).body, (await request({ port, path: '/data.json' })).body, (await request({ port, path: '/health' })).body];
    const s = await sse(port);
    await s.waitFor(/event: data/);
    server.broadcast({ ...VM, seq: 30 });
    await s.waitFor(/"seq":30/);
    s.req.destroy();
    for (const body of [...reads, s.text]) assert.ok(!body.includes(TOKEN));
  });
  await withWriteServer({
    onAnswer: async () => ({ status: 409, json: { ok: false, code: 'ANSWERED' } }),
    onFocus: async () => ({ status: 404, json: { ok: false, code: 'NO_TAB' } }),
  }, async ({ port }) => {
    const a = await postWrite(port, '/answer', ANSWER);
    assert.equal(a.status, 409);
    assert.deepEqual(JSON.parse(a.body), { ok: false, code: 'ANSWERED' });
    const f = await postWrite(port, '/focus', FOCUS);
    assert.equal(f.status, 404);
    assert.deepEqual(JSON.parse(f.body), { ok: false, code: 'NO_TAB' });
  });
});

test('one write at a time server-wide: a second is 429 and calls nothing, the slot frees when the first ends', async () => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const answers = [];
  const focuses = [];
  await withServer({
    token: TOKEN,
    onAnswer: async (body) => { answers.push(body); entered.resolve(); await gate.promise; return { status: 200, json: { ok: true } }; },
    onFocus: async (body) => { focuses.push(body); return { status: 200, json: { ok: true } }; },
  }, async ({ port }) => {
    const first = postWrite(port, '/answer', ANSWER);
    await entered.promise;
    const second = await postWrite(port, '/answer', { ...ANSWER, id: 13 });
    const otherRoute = await postWrite(port, '/focus', FOCUS);
    for (const r of [second, otherRoute]) {
      assert.equal(r.status, 429);
      assert.equal(JSON.parse(r.body).code, 'BUSY');
      noCors(r.headers, '429');
    }
    assert.deepEqual(answers, [ANSWER], 'the second answer never reached the callback');
    assert.deepEqual(focuses, [], 'a write on the other route is refused too');
    gate.resolve();
    assert.equal((await first).status, 200);
    assert.equal((await postWrite(port, '/focus', FOCUS)).status, 200, 'slot is free after the first write');
    assert.deepEqual(focuses, [FOCUS]);
  });
});

test('a callback that throws or returns garbage is answered 500, reported, and frees the write slot', async () => {
  let mode = 'throw';
  const errors = [];
  await withServer({
    token: TOKEN,
    onError: (key, err) => errors.push({ key, err }),
    onAnswer: async () => {
      if (mode === 'throw') throw new Error('boom');
      if (mode === 'garbage') return 'ok';
      return { status: 200, json: { ok: true } };
    },
    onFocus: async () => ({ status: 200, json: { ok: true } }),
  }, async ({ port }) => {
    for (const name of ['throw', 'garbage']) {
      mode = name;
      const r = await postWrite(port, '/answer', ANSWER);
      assert.equal(r.status, 500, name);
      assert.doesNotMatch(r.body, /boom/, 'internal error text is not leaked');
    }
    assert.equal(errors.length, 2, 'the thrown error and the garbage result are both reported');
    assert.ok(errors.every((e) => e.key === 'server:sse' && e.err instanceof Error));
    mode = 'ok';
    assert.equal((await postWrite(port, '/answer', ANSWER)).status, 200, 'the write path still works');
  });
});

// Promise.race cancels nothing: a callback that outlives writeTimeoutMs is still running after its 504, so it must
// keep the write slot. Every wait is a real signal (deferreds, the HTTP answer); the slot is freed by a microtask
// chain that always drains before the server can read the next request, so no sleeping or polling is needed.
test('a callback that outlives the 504 deadline keeps the write slot: other writes are 429 until it settles', async () => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let active = 0;
  let maxActive = 0;
  const calls = { answer: 0, focus: 0 };
  const enter = () => { active += 1; maxActive = Math.max(maxActive, active); };
  await withServer({
    token: TOKEN,
    writeTimeoutMs: 30,
    onAnswer: async () => {
      calls.answer += 1;
      enter();
      entered.resolve();
      try {
        await gate.promise;
        return { status: 200, json: { ok: true } };
      } finally {
        active -= 1;
        finished.resolve();
      }
    },
    onFocus: async () => {
      calls.focus += 1;
      enter();
      active -= 1;
      return { status: 200, json: { ok: true } };
    },
  }, async ({ port }) => {
    const first = postWrite(port, '/answer', ANSWER);
    await entered.promise;
    const timedOut = await first;
    assert.equal(timedOut.status, 504);
    assert.equal(JSON.parse(timedOut.body).code, 'TIMEOUT');
    assert.equal(active, 1, 'the callback is still running after its 504');

    for (const [path, body] of [['/answer', { ...ANSWER, id: 13 }], ['/focus', FOCUS]]) {
      const r = await postWrite(port, path, body);
      assert.equal(r.status, 429, path);
      assert.equal(JSON.parse(r.body).code, 'BUSY', path);
    }
    assert.deepEqual(calls, { answer: 1, focus: 0 }, 'no second callback starts while the first one is running');

    gate.resolve();
    await finished.promise;
    assert.equal((await postWrite(port, '/focus', FOCUS)).status, 200, 'the slot is free once the callback settled');
    assert.equal((await postWrite(port, '/answer', { ...ANSWER, id: 14 })).status, 200);
    assert.equal(maxActive, 1, 'never two callbacks at once');
  });
});

test('a callback that fails after its 504 is reported once, and only then is the slot free', async () => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const reported = Promise.withResolvers();
  const errors = [];
  let calls = 0;
  await withServer({
    token: TOKEN,
    writeTimeoutMs: 30,
    onError: (key, err) => { errors.push({ key, err }); reported.resolve(); },
    onAnswer: async () => {
      calls += 1;
      if (calls > 1) return { status: 200, json: { ok: true } };
      entered.resolve();
      await gate.promise;
      throw new Error('late failure');
    },
    onFocus: async () => ({ status: 200, json: { ok: true } }),
  }, async ({ port }) => {
    const first = postWrite(port, '/answer', ANSWER);
    await entered.promise;
    assert.equal((await first).status, 504);
    assert.equal((await postWrite(port, '/answer', ANSWER)).status, 429);
    assert.deepEqual(errors, [], 'nothing is reported while the callback is still running');
    gate.resolve();
    await reported.promise;
    assert.equal(errors.length, 1);
    assert.equal(errors[0].key, 'server:sse');
    assert.match(errors[0].err.message, /late failure/);
    assert.equal((await postWrite(port, '/answer', ANSWER)).status, 200);
    assert.equal(errors.length, 1, 'reported once');
  });
});

test('no response anywhere in this file carried Access-Control-*', () => {
  const offenders = seenHeaders.filter((h) => Object.keys(h).some((k) => k.toLowerCase().startsWith('access-control-')));
  assert.deepEqual(offenders, []);
  assert.deepEqual(seenRaw.filter((text) => /^access-control-/im.test(text)), []);
});
