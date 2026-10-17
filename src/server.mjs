// Loopback-only board server: GET / (page), /data.json (view model), /events (SSE), /health, and exactly two
// guarded write routes, POST /answer and POST /focus. `node:http` only. No CORS (no Access-Control-* header,
// OPTIONS stays 405), never serves data.js (a cross-site <script> could read it). Every other method/path is 405/404.
//
// A write route runs only when ALL of these hold, checked in this order; the first failure is answered and
// no callback runs (Host is checked first, for every route):
//   Sec-Fetch-Site === 'same-origin' (403) -> Origin === http://<Host> (403, 'null' included)
//   -> Content-Type application/json (415) -> X-Board-Token === token via timingSafeEqual (403)
//   -> at most one write in flight server-wide (429) -> body <= 4096 bytes read within bodyTimeoutMs (413/408)
//   -> a JSON object with exactly the allowed keys (400) -> onAnswer(body) / onFocus(body) -> {status, json}.
// The write slot stays taken until the callback itself settles: writeTimeoutMs only decides when the 504 is sent,
// it never cancels the callback or frees the slot, so at most one callback runs at any time (others get 429).
// /answer body: {id: positive integer, sessionId: string} + exactly one of option ('A'|'B'|'C') / text (string).
// /focus body: {sessionId: string}. Responses are JSON {ok, code?} with the SECURE headers. Without a non-empty
// `token` and the matching callback a write route does not exist (405 like any other non-GET).
//
// createBoardServer({getPage, getViewModel, generation, portBase, portCount=10, preferPort?,
//                    onError, onRecover, pingMs?, onClientCount?, createServer?,
//                    token?, onAnswer?, onFocus?, bodyTimeoutMs=2000, writeTimeoutMs=10000})
//   -> {start(): Promise<{port}>, broadcast(vm), sendPaused(), close(): Promise<void>, clientCount(), address()}
//
// Error keys reported through onError(key, err) / cleared through onRecover(key):
//   'server:listen' - listen/server-level failures and NO_PORT; cleared by a successful listen
//   'server:sse'    - HTTP parser/request/response/socket failures and getPage/getViewModel/onAnswer/onFocus
//                     throwing or returning garbage; cleared by the next successful request, write or broadcast
// The only intentionally ignored errors are EADDRINUSE/EACCES while scanning ports.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const HOST = '127.0.0.1';
const MAX_CLIENTS = 16;
const MAX_SOCKETS = 64;
const PING_MS = 15000;
const CLOSE_BOUND_MS = 500;
const MAX_CLIENT_BACKLOG = 2 * 1024 * 1024; // a stalled SSE reader is dropped instead of buffering forever
const GATED_PATHS = new Set(['/data.json', '/events', '/health']);
const SITE_OK = new Set(['same-origin', 'none']);
const MAX_BODY_BYTES = 4096;
const BODY_TIMEOUT_MS = 2000;
const WRITE_TIMEOUT_MS = 10000; // after this a still-running write callback is answered 504; it keeps the write slot until it settles
const ANSWER_KEYS = new Set(['id', 'sessionId', 'option', 'text']);
const ANSWER_OPTIONS = new Set(['A', 'B', 'C']);
const WRITE_TIMED_OUT = Symbol('write timed out');
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SECURE = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const SOCKET_DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE']);

export function createBoardServer(options) {
  const {
    getPage,
    getViewModel,
    generation,
    portBase,
    portCount = 10,
    preferPort,
    onError = () => {},
    onRecover = () => {},
    onClientCount = () => {},
    token,
    onAnswer,
    onFocus,
    bodyTimeoutMs = BODY_TIMEOUT_MS,
    writeTimeoutMs = WRITE_TIMEOUT_MS,
    pingMs = PING_MS,
    createServer = (handler) => http.createServer(handler),
  } = options;

  let server = null;
  let port = 0;
  let closed = false;
  let closePromise = null;
  let pingTimer = null;
  let lastVm = null;
  let lastSeq = 0;
  let broadcasts = 0;
  let pending = 0;
  const clients = new Set();
  const outstandingSse = { value: false };
  const tokenBytes = typeof token === 'string' && token !== '' ? Buffer.from(token) : null;
  const writeHandlers = new Map();
  if (tokenBytes && typeof onAnswer === 'function') writeHandlers.set('/answer', onAnswer);
  if (tokenBytes && typeof onFocus === 'function') writeHandlers.set('/focus', onFocus);
  let writeInFlight = false;
  const idleWaiters = new Set();

  function releaseWrite() {
    writeInFlight = false;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function idle() {
    return writeInFlight ? new Promise((resolve) => idleWaiters.add(resolve)) : Promise.resolve();
  }

  // A host callback that throws must never take the lead conversation down.
  function safe(fn, ...args) {
    try {
      fn(...args);
    } catch (e) {
      process.emitWarning(`omo-briefing server callback failed: ${e && e.message}`);
    }
  }
  function report(key, err) {
    if (key === 'server:sse') outstandingSse.value = true;
    safe(onError, key, err instanceof Error ? err : new Error(String(err)));
  }
  function recoverSse() {
    if (!outstandingSse.value) return;
    outstandingSse.value = false;
    safe(onRecover, 'server:sse');
  }
  function notifyCount() {
    safe(onClientCount, clients.size);
  }

  function send(res, status, type, body, extra) {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      ...SECURE,
      ...extra,
    });
    res.end(body);
  }
  const plain = (res, status, text, extra) => send(res, status, 'text/plain; charset=utf-8', text, extra);
  function json(res, status, body, extra) {
    if (res.destroyed || res.writableEnded) return; // the client left while a write was in progress
    send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), extra);
  }

  function hostAllowed(host) {
    if (typeof host !== 'string') return false;
    const h = host.toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  }

  const dataFrame = (vm) => `event: data\ndata: ${JSON.stringify(vm)}\n\n`;

  function track(vm) {
    lastVm = vm;
    if (vm && Number.isInteger(vm.seq)) lastSeq = vm.seq;
  }

  function dropClient(client) {
    if (clients.delete(client)) notifyCount();
  }

  function writeClient(client, text) {
    const { res } = client;
    if (res.destroyed || res.writableEnded) return false;
    res.write(text);
    if (res.writableLength > MAX_CLIENT_BACKLOG) {
      res.destroy(new Error('SSE client is not reading (backlog over limit)'));
      return false;
    }
    return true;
  }

  async function serveEvents(req, res) {
    if (clients.size + pending >= MAX_CLIENTS) {
      plain(res, 503, 'too many live connections', { 'Retry-After': '5' });
      return;
    }
    pending += 1;
    const seen = broadcasts;
    let vm;
    try {
      vm = await getViewModel();
    } finally {
      pending -= 1;
    }
    if (res.destroyed || (res.socket && res.socket.destroyed)) return; // client left while we were reading the model
    if (broadcasts !== seen) vm = lastVm; // a broadcast landed meanwhile: never send the stale model
    else track(vm);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...SECURE,
    });
    res.flushHeaders();
    const client = { res };
    clients.add(client);
    res.once('close', () => dropClient(client));
    notifyCount();
    writeClient(client, `retry: 1000\n\n${dataFrame(vm)}`);
    recoverSse();
  }

  function tokenMatches(given) {
    if (typeof given !== 'string') return false;
    const bytes = Buffer.from(given);
    return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
  }

  // First failing header guard as [status, code], or null when every one holds. The Host header was
  // already checked by route(), so it is a string equal to 127.0.0.1:<port> or localhost:<port>.
  function headerRefusal(req) {
    const h = req.headers;
    if (h['sec-fetch-site'] !== 'same-origin') return [403, 'FORBIDDEN_SITE'];
    if (h.origin !== `http://${h.host.toLowerCase()}`) return [403, 'FORBIDDEN_ORIGIN'];
    const type = String(h['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return [415, 'UNSUPPORTED_TYPE'];
    if (!tokenMatches(h['x-board-token'])) return [403, 'FORBIDDEN_TOKEN'];
    return null;
  }

  // Resolves {buf}, {status, code} (413/408) or {aborted: true} (the client went away; nothing to answer).
  function readBody(req) {
    return new Promise((resolve) => {
      if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
        resolve({ status: 413, code: 'TOO_LARGE' });
        return;
      }
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(finish, bodyTimeoutMs, { status: 408, code: 'TIMEOUT' });
      timer.unref();
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) finish({ status: 413, code: 'TOO_LARGE' });
        else if (!done) chunks.push(chunk);
      });
      req.once('end', () => finish({ buf: Buffer.concat(chunks) }));
      req.once('close', () => finish({ aborted: true }));
    });
  }

  function validAnswer(b) {
    if (!Object.keys(b).every((k) => ANSWER_KEYS.has(k))) return false;
    if (!Number.isSafeInteger(b.id) || b.id <= 0 || typeof b.sessionId !== 'string') return false;
    const hasOption = Object.hasOwn(b, 'option');
    const hasText = Object.hasOwn(b, 'text');
    if (hasOption === hasText) return false;
    return hasOption ? ANSWER_OPTIONS.has(b.option) : typeof b.text === 'string';
  }
  function validFocus(b) {
    const keys = Object.keys(b);
    return keys.length === 1 && keys[0] === 'sessionId' && typeof b.sessionId === 'string';
  }
  // The parsed body when it is a JSON object with exactly the keys the route allows, else null.
  function parseWriteBody(buf, pathname) {
    let value;
    try {
      value = JSON.parse(UTF8.decode(buf));
    } catch {
      return null; // malformed JSON / UTF-8 is a 400 for the caller, not a server fault
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return (pathname === '/answer' ? validAnswer(value) : validFocus(value)) ? value : null;
  }

  // Runs the callback and owns the write slot until the callback settles. The deadline only picks the moment the
  // caller answers (WRITE_TIMED_OUT -> 504): Promise.race does not cancel the callback, so the slot is NOT freed
  // there. A rejection that arrives after the deadline has no response left to fail, so it is reported here.
  async function callWriteHandler(handler, body) {
    const call = Promise.resolve().then(() => handler(body));
    let timer;
    let timedOut = false;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(WRITE_TIMED_OUT);
      }, writeTimeoutMs);
      timer.unref();
    });
    call.then(
      () => { releaseWrite(); },
      (err) => {
        releaseWrite();
        if (timedOut) report('server:sse', err);
      },
    );
    try {
      return await Promise.race([call, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function serveWrite(req, res, pathname, handler) {
    const refusal = headerRefusal(req);
    if (refusal) {
      json(res, refusal[0], { ok: false, code: refusal[1] });
      return;
    }
    if (writeInFlight) {
      json(res, 429, { ok: false, code: 'BUSY' }, { 'Retry-After': '1' });
      return;
    }
    writeInFlight = true;
    let slotHandedToCallback = false; // once the callback runs it, not this function, frees the slot
    try {
      const got = await readBody(req);
      if (got.aborted) return;
      if (got.status) {
        json(res, got.status, { ok: false, code: got.code }, { Connection: 'close' });
        return;
      }
      const body = parseWriteBody(got.buf, pathname);
      if (!body) {
        json(res, 400, { ok: false, code: 'BAD_REQUEST' });
        return;
      }
      let result;
      try {
        slotHandedToCallback = true;
        result = await callWriteHandler(handler, body);
      } catch (err) {
        report('server:sse', err);
        json(res, 500, { ok: false, code: 'INTERNAL' });
        return;
      }
      if (result === WRITE_TIMED_OUT) {
        json(res, 504, { ok: false, code: 'TIMEOUT' });
        return;
      }
      if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.json !== 'object' || result.json === null) {
        report('server:sse', new Error(`${pathname} callback returned no {status, json}`));
        json(res, 500, { ok: false, code: 'INTERNAL' });
        return;
      }
      json(res, result.status, result.json);
      recoverSse();
    } finally {
      if (!slotHandedToCallback) releaseWrite();
    }
  }

  async function route(req, res) {
    if (!hostAllowed(req.headers.host)) {
      plain(res, 403, 'forbidden host');
      return;
    }
    const q = req.url.indexOf('?');
    const pathname = q < 0 ? req.url : req.url.slice(0, q);
    const writeHandler = writeHandlers.get(pathname);
    if (req.method === 'POST' && writeHandler) {
      await serveWrite(req, res, pathname, writeHandler);
      return;
    }
    if (req.method !== 'GET') {
      plain(res, 405, 'method not allowed', { Allow: writeHandler ? 'POST' : 'GET' });
      return;
    }
    if (GATED_PATHS.has(pathname)) {
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && !SITE_OK.has(site)) {
        plain(res, 403, 'forbidden origin');
        return;
      }
    }
    switch (pathname) {
      case '/': {
        const page = await getPage();
        send(res, 200, 'text/html; charset=utf-8', String(page));
        recoverSse();
        return;
      }
      case '/data.json': {
        const vm = await getViewModel();
        track(vm);
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(vm));
        recoverSse();
        return;
      }
      case '/health':
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, generation, seq: lastSeq, pid: process.pid }));
        return;
      case '/events':
        await serveEvents(req, res);
        return;
      default:
        plain(res, 404, 'not found');
    }
  }

  function handler(req, res) {
    req.on('error', (err) => report('server:sse', err));
    res.on('error', (err) => report('server:sse', err));
    route(req, res).catch((err) => {
      report('server:sse', err);
      if (!res.headersSent) plain(res, 500, 'internal error');
      else res.destroy();
    });
  }

  function makeServer() {
    const s = createServer(handler);
    s.maxConnections = MAX_SOCKETS;
    if (typeof s.unref === 'function') s.unref();
    s.on('connection', (socket) => {
      socket.unref();
      socket.on('error', (err) => report('server:sse', err));
    });
    s.on('clientError', (err, socket) => {
      report('server:sse', err);
      // Report first; a disconnected socket cannot receive the 400 response.
      if (SOCKET_DISCONNECT_CODES.has(err && err.code) || !socket.writable) {
        socket.destroy();
        return;
      }
      const body = 'bad request';
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nX-Frame-Options: DENY\r\n` +
          `Referrer-Policy: no-referrer\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    return s;
  }

  // Resolves with the bound server, or an error object for EADDRINUSE/EACCES (the only ignored errors).
  function tryListen(candidate, p) {
    return new Promise((resolve, reject) => {
      const onErr = (err) => {
        candidate.removeListener('listening', onUp);
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          // Intentional: a taken or reserved port (Windows excludes ranges) just means "try the next one".
          resolve({ skipped: err });
        } else {
          reject(err);
        }
      };
      const onUp = () => {
        candidate.removeListener('error', onErr);
        resolve({ bound: true });
      };
      candidate.once('error', onErr);
      candidate.once('listening', onUp);
      candidate.listen(p, HOST);
    });
  }

  async function start() {
    if (closed) throw new Error('board server is closed');
    if (server) return { port };
    const candidates = [];
    if (Number.isInteger(preferPort)) candidates.push(preferPort);
    for (let i = 0; i < portCount; i++) {
      const p = portBase + i;
      if (!candidates.includes(p)) candidates.push(p);
    }
    for (const p of candidates) {
      if (closed) throw new Error('board server was closed while starting');
      const candidate = makeServer();
      let result;
      try {
        result = await tryListen(candidate, p);
      } catch (err) {
        candidate.close();
        report('server:listen', err);
        throw err;
      }
      if (result.skipped) {
        candidate.close();
        continue;
      }
      server = candidate;
      // Post-listen server errors only; attached after binding so a skipped port's error is not double-reported.
      server.on('error', (err) => report('server:listen', err));
      port = server.address().port;
      pingTimer = setInterval(() => {
        for (const c of [...clients]) {
          try {
            writeClient(c, ': ping\n\n');
          } catch (err) {
            report('server:sse', err);
            dropClient(c);
          }
        }
      }, pingMs);
      pingTimer.unref();
      safe(onRecover, 'server:listen');
      return { port };
    }
    const last = candidates[candidates.length - 1];
    const err = Object.assign(
      new Error(`NO_PORT: no free port among ${candidates[0]}..${last} on ${HOST}`),
      { code: 'NO_PORT', portBase, portCount },
    );
    report('server:listen', err);
    throw err;
  }

  function broadcast(vm) {
    broadcasts += 1;
    track(vm);
    let frame;
    try {
      frame = dataFrame(vm);
    } catch (err) {
      report('server:sse', err);
      return 0;
    }
    let sent = 0;
    for (const c of [...clients]) {
      try {
        if (writeClient(c, frame)) sent += 1;
      } catch (err) {
        report('server:sse', err);
        c.res.destroy();
        dropClient(c);
      }
    }
    if (sent > 0) recoverSse();
    return sent;
  }

  function sendPaused() {
    sendEvent('paused', { paused: true });
  }

  function broadcastClosing(info) {
    sendEvent('closing', info);
  }

  function sendEvent(name, info) {
    for (const c of [...clients]) {
      try {
        writeClient(c, `event: ${name}\ndata: ${JSON.stringify(info)}\n\n`);
      } catch (err) {
        report('server:sse', err);
        c.res.destroy();
        dropClient(c);
      }
    }
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    clearInterval(pingTimer);
    closePromise = new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        report('server:listen', new Error(`board server did not close within ${CLOSE_BOUND_MS}ms`));
        resolve();
      }, CLOSE_BOUND_MS);
      server.closeAllConnections();
      server.close((err) => {
        clearTimeout(timer);
        // ERR_SERVER_NOT_RUNNING = already closed by someone else: nothing left to close.
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') report('server:listen', err);
        resolve();
      });
    }).then(() => {
      clients.clear();
      notifyCount();
    });
    return closePromise;
  }

  return {
    start,
    broadcast,
    sendPaused,
    broadcastClosing,
    idle,
    close,
    clientCount: () => clients.size,
    address: () => (server ? server.address() : null),
  };
}
