// Loopback-only board server: GET / (page), /data.json (view model), /events (SSE), /health,
// /profiles/state (profile switcher view model + target hashes) and exactly three guarded write
// routes, POST /answer, /focus and /profiles. `node:http` only. No CORS (no Access-Control-* header,
// OPTIONS stays 405), never serves data.js (a cross-site <script> could read it). Every other method/path is 405/404.
//
// A write route runs only when ALL of these hold, checked in this order; the first failure is answered and
// no callback runs (Host is checked first, for every route):
//   Sec-Fetch-Site === 'same-origin' (403) -> Origin === http://<Host> (403, 'null' included)
//   -> Content-Type application/json (415) -> X-Board-Token === token via timingSafeEqual (403)
//   -> at most one write in flight server-wide (429) -> bounded body read within bodyTimeoutMs (413/408)
//   -> a JSON object with exactly the allowed keys (400) -> onAnswer(body) / onFocus(body) -> {status, json}.
// The write slot stays taken until the callback itself settles: writeTimeoutMs only decides when the 504 is sent,
// it never cancels the callback or frees the slot, so at most one callback runs at any time (others get 429).
// /answer body: {id: positive integer, sessionId: string} + exactly one of option ('A'|'B'|'C') / text (string).
// /focus body: {sessionId: string}. /profiles body: {action: 'preview'|'apply', changes: [...],
// expected: {<target id>: sha256|null}, rosterRevision: integer >= 0}; the store validates the change
// kinds and resolves every target id itself, so no request value becomes a filesystem path.
// Responses are JSON {ok, code?} with the SECURE headers. Without a non-empty
// `token` and the matching callback a write route does not exist (405 like any other non-GET).
// GET /profiles/state has the Host check and the same Sec-Fetch-Site gate as /data.json; it is read-only
// and its values are redacted by the profiles store before they reach the wire.
//
// GET /assets/<64 hex>.<png|jpg|webp> (report images) has the Host and Sec-Fetch-Site gate of /data.json and is 404 unless
// assetAllowed(name) says the current model references it; the bytes come only from `assetsDir/<name>` (a regular file of
// <= 8 MiB whose sha256 is the name and whose magic bytes match the extension) with nosniff, a Content-Type from the
// extension and an immutable cache. Without assetsDir it is always 404.
//
// createBoardServer({getPage, getViewModel, generation, portBase, portCount=10, preferPort?, assetsDir?, assetAllowed?,
//                    onError, onRecover, pingMs?, onClientCount?, createServer?,
//                    token?, onAnswer?, onFocus?, onProfiles?, profilesState?, bodyTimeoutMs=2000, writeTimeoutMs=10000})
//   -> {start(): Promise<{port}>, broadcast(vm), sendPaused(), close(): Promise<void>, clientCount(), address()}
//
// Error keys reported through onError(key, err) / cleared through onRecover(key):
//   'server:listen' - listen/server-level failures and NO_PORT; cleared by a successful listen
//   'server:sse'    - HTTP parser/request/response/socket failures and getPage/getViewModel/onAnswer/onFocus
//                     throwing or returning garbage; cleared by the next successful request, write or broadcast
// The only intentionally ignored errors are EADDRINUSE/EACCES while scanning ports.
import http from 'node:http';
import { open as openFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { ASSET_NAME_RE, MIME, MAX_IMAGE_BYTES, sniffImage } from './assets.mjs';

const HOST = '127.0.0.1';
const MAX_CLIENTS = 16;
const MAX_SOCKETS = 64;
const PING_MS = 15000;
const CLOSE_BOUND_MS = 500;
const MAX_CLIENT_BACKLOG = 2 * 1024 * 1024; // a stalled SSE reader is dropped instead of buffering forever
const GATED_PATHS = new Set(['/data.json', '/events', '/health', '/profiles/state']);
const ASSET_PREFIX = '/assets/';
const SITE_OK = new Set(['same-origin', 'none']);
const MAX_BODY_BYTES = 4096;
const MAX_ANSWER_BYTES = 65536;
const MAX_PROFILES_BYTES = 65536;
const BODY_TIMEOUT_MS = 2000;
const WRITE_TIMEOUT_MS = 10000; // after this a still-running write callback is answered 504; it keeps the write slot until it settles
const ANSWER_KEYS = new Set(['id', 'sessionId', 'option', 'text', 'values', 'action']);
const PROFILES_KEYS = new Set(['action', 'changes', 'expected', 'rosterRevision']);
const ANNOTATION_KEYS = new Set(['kind', 'sessionId', 'requestId', 'text']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANSWER_OPTIONS = new Set(['A', 'B', 'C']);
const WRITE_TIMED_OUT = Symbol('write timed out');
const LEGACY_TOO_LARGE = Symbol('legacy body too large');
const DUPLICATE_KEY = Symbol('duplicate JSON key');
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SECURE = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const SOCKET_DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE']);

// JSON.parse checks the grammar first. Walk its raw tokens without recursion so a repeated member cannot be
// hidden by last-wins parsing, string contents, escaped quotes, or alternate Unicode spellings of a key.
// Each object owns its key set; the field context follows containers below the top-level values member.
function duplicateAnswerKey(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i], parent = stack.at(-1);
    if (c === '{' || c === '[') {
      stack.push({ keys: c === '{' ? new Set() : null, key: null,
        inValues: stack.length === 1 && parent.key === 'values',
        field: parent?.field ?? (parent?.inValues ? parent.key : null) });
    } else if (c === '}' || c === ']') {
      stack.pop();
    } else if (c === '"') {
      const start = i++;
      while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      const end = i + 1;
      let next = end;
      while (/\s/.test(text[next] || '')) next++;
      if (text[next] !== ':') continue; // a string value never contributes a member name
      const key = JSON.parse(text.slice(start, end));
      if (parent.keys.has(key)) return { field: parent.field ?? (parent.inValues ? key : null) };
      parent.keys.add(key);
      parent.key = key;
    }
  }
  return null;
}

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
    onProfiles,
    profilesState,
    bodyTimeoutMs = BODY_TIMEOUT_MS,
    writeTimeoutMs = WRITE_TIMEOUT_MS,
    pingMs = PING_MS,
    createServer = (handler) => http.createServer(handler),
    assetsDir,
    assetAllowed,
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
  if (tokenBytes && typeof onProfiles === 'function') writeHandlers.set('/profiles', onProfiles);
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

  // The bytes of a referenced asset, or null (404). Serving is content-addressed: the bytes read must hash (sha256) to the
  // 64-hex name and sniff as the type of its extension, so whatever file a junction, link or race substitutes, only the
  // exact bytes the model references can ever be sent. Defence in depth on the OPENED handle: assetsDir must be a real
  // directory (no link/junction) with the same identity before and after the open, and the regular non-link file now at
  // assetsDir/<name> must be the very file the handle has (same dev+ino).
  const ASSET_MISSING = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES', 'ELOOP', 'EINVAL']);
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const realDir = async () => {
    const st = await lstat(assetsDir, { bigint: true });
    return st.isDirectory() && !st.isSymbolicLink() ? st : null;
  };
  async function readAsset(name, sha, ext) {
    const file = join(assetsDir, name);
    let fh;
    let before;
    try {
      before = await realDir();
      if (!before) return null;
      fh = await openFile(file, 'r');
    } catch (err) {
      if (err && ASSET_MISSING.has(err.code)) return null;
      throw err;
    }
    try {
      const st = await fh.stat({ bigint: true });
      if (!st.isFile() || st.size > BigInt(MAX_IMAGE_BYTES)) return null;
      const after = await realDir();
      if (!after || !sameFile(before, after)) return null;
      const leaf = await lstat(file, { bigint: true });
      if (!leaf.isFile() || leaf.isSymbolicLink() || !sameFile(leaf, st)) return null;
      const buf = await fh.readFile();
      if (buf.length > MAX_IMAGE_BYTES || createHash('sha256').update(buf).digest('hex') !== sha) return null;
      return sniffImage(buf).ext === ext ? buf : null;
    } catch (err) {
      if (err && ASSET_MISSING.has(err.code)) return null;
      throw err;
    } finally {
      await fh.close();
    }
  }

  async function serveAsset(res, pathname) {
    const name = pathname.slice(ASSET_PREFIX.length);
    const m = ASSET_NAME_RE.exec(name);
    if (!m || typeof assetsDir !== 'string' || typeof assetAllowed !== 'function' || !(await assetAllowed(name))) {
      plain(res, 404, 'not found');
      return;
    }
    const body = await readAsset(name, m[1], m[2]);
    if (!body) {
      plain(res, 404, 'not found');
      return;
    }
    send(res, 200, MIME[m[2]], body, { 'Cache-Control': 'max-age=31536000, immutable' });
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
  function readBody(req, pathname) {
    const maxBytes = pathname === '/profiles' ? MAX_PROFILES_BYTES
      : pathname === '/answer' ? MAX_ANSWER_BYTES : MAX_BODY_BYTES;
    return new Promise((resolve) => {
      if (Number(req.headers['content-length']) > maxBytes) {
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
        if (size > maxBytes) finish({ status: 413, code: 'TOO_LARGE' });
        else if (!done) chunks.push(chunk);
      });
      req.once('end', () => finish({ buf: Buffer.concat(chunks) }));
      req.once('close', () => finish({ aborted: true }));
    });
  }

  function validAnswer(b) {
    if (b.kind === 'annotation') {
      const keys = Object.keys(b);
      return keys.length === ANNOTATION_KEYS.size && keys.every((k) => ANNOTATION_KEYS.has(k))
        && typeof b.sessionId === 'string' && typeof b.requestId === 'string' && UUID_V4.test(b.requestId)
        && typeof b.text === 'string';
    }
    if (!Object.keys(b).every((k) => ANSWER_KEYS.has(k))) return false;
    if (!Number.isSafeInteger(b.id) || b.id <= 0 || typeof b.sessionId !== 'string') return false;
    const hasOption = Object.hasOwn(b, 'option');
    const hasText = Object.hasOwn(b, 'text');
    const hasValues = Object.hasOwn(b, 'values');
    if (Object.hasOwn(b, 'action')) return !hasOption && !hasText && !hasValues && (b.action === 'hold' || b.action === 'reopen');
    if (Number(hasOption) + Number(hasText) + Number(hasValues) !== 1) return false;
    // The callback validates these keys and values against the stored decision, never the client's field spec.
    if (hasValues) return b.values !== null && typeof b.values === 'object' && !Array.isArray(b.values);
    return hasOption ? ANSWER_OPTIONS.has(b.option) : typeof b.text === 'string';
  }
  function validFocus(b) {
    const keys = Object.keys(b);
    return keys.length === 1 && keys[0] === 'sessionId' && typeof b.sessionId === 'string';
  }
  // Shape only: the profiles store validates every change kind and target id. Values in the
  // body are never used as paths.
  function validProfiles(b) {
    const keys = Object.keys(b);
    return keys.length === PROFILES_KEYS.size && keys.every((key) => PROFILES_KEYS.has(key))
      && (b.action === 'preview' || b.action === 'apply')
      && Array.isArray(b.changes)
      && typeof b.expected === 'object' && b.expected !== null && !Array.isArray(b.expected)
      && Number.isInteger(b.rosterRevision) && b.rosterRevision >= 0;
  }
  // The parsed body when it is a JSON object with exactly the keys the route allows, else null.
  function parseWriteBody(buf, pathname) {
    let value, text;
    try {
      text = UTF8.decode(buf);
      value = JSON.parse(text);
    } catch {
      if (pathname === '/answer' && buf.length > MAX_BODY_BYTES) return LEGACY_TOO_LARGE;
      return null; // malformed JSON / UTF-8 is a 400 for the caller, not a server fault
    }
    if (pathname === '/answer' && value?.kind !== 'annotation' && buf.length > MAX_BODY_BYTES) return LEGACY_TOO_LARGE;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    if (pathname === '/answer' || pathname === '/profiles') {
      const duplicate = duplicateAnswerKey(text);
      if (duplicate) return { [DUPLICATE_KEY]: duplicate };
    }
    return (pathname === '/answer' ? validAnswer(value)
      : pathname === '/profiles' ? validProfiles(value) : validFocus(value)) ? value : null;
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
      const got = await readBody(req, pathname);
      if (got.aborted) return;
      if (got.status) {
        json(res, got.status, { ok: false, code: got.code }, { Connection: 'close' });
        return;
      }
      const body = parseWriteBody(got.buf, pathname);
      if (body === LEGACY_TOO_LARGE) {
        json(res, 413, { ok: false, code: 'TOO_LARGE' });
        return;
      }
      if (body?.[DUPLICATE_KEY]) {
        const { field } = body[DUPLICATE_KEY];
        json(res, 400, { ok: false, code: 'DUPLICATE_KEY',
          ...(field === null ? {} : { fieldErrors: { [field]: '같은 입력 항목을 두 번 보낼 수 없어요' } }) });
        return;
      }
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
    if (GATED_PATHS.has(pathname) || pathname.startsWith(ASSET_PREFIX)) {
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
      case '/profiles/state': {
        if (typeof profilesState !== 'function') {
          plain(res, 404, 'not found');
          return;
        }
        const state = await profilesState();
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(state));
        recoverSse();
        return;
      }
      case '/events':
        await serveEvents(req, res);
        return;
      default:
        if (pathname.startsWith(ASSET_PREFIX)) {
          await serveAsset(res, pathname);
          return;
        }
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
