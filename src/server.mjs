// Loopback-only board server: GET / (page), /data.json (view model), /events (SSE), /health.
// `node:http` only. No write routes, no CORS, never serves data.js (a cross-site <script> could read it).
//
// createBoardServer({getPage, getViewModel, generation, portBase, portCount=10, preferPort?,
//                    onError, onRecover, pingMs?, onClientCount?, createServer?})
//   -> {start(): Promise<{port}>, broadcast(vm), sendPaused(), close(): Promise<void>, clientCount(), address()}
//
// Error keys reported through onError(key, err) / cleared through onRecover(key):
//   'server:listen' - listen/server-level failures and NO_PORT; cleared by a successful listen
//   'server:sse'    - HTTP parser/request/response/socket failures and getPage/getViewModel throwing;
//                     cleared by the next successful request or broadcast after such an error
// The only intentionally ignored errors are EADDRINUSE/EACCES while scanning ports.
import http from 'node:http';

const HOST = '127.0.0.1';
const MAX_CLIENTS = 16;
const MAX_SOCKETS = 64;
const PING_MS = 15000;
const CLOSE_BOUND_MS = 500;
const MAX_CLIENT_BACKLOG = 2 * 1024 * 1024; // a stalled SSE reader is dropped instead of buffering forever
const GATED_PATHS = new Set(['/data.json', '/events', '/health']);
const SITE_OK = new Set(['same-origin', 'none']);
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

  async function route(req, res) {
    if (!hostAllowed(req.headers.host)) {
      plain(res, 403, 'forbidden host');
      return;
    }
    if (req.method !== 'GET') {
      plain(res, 405, 'method not allowed', { Allow: 'GET' });
      return;
    }
    const q = req.url.indexOf('?');
    const pathname = q < 0 ? req.url : req.url.slice(0, q);
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
    for (const c of [...clients]) {
      try {
        writeClient(c, 'event: paused\ndata: {"paused":true}\n\n');
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
    close,
    clientCount: () => clients.size,
    address: () => (server ? server.address() : null),
  };
}
