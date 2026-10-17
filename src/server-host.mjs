// omo-briefing src/server-host.mjs - which lead conversation runs the board server, and hand-over between them.
//
// createServerHost(options) -> {ensure, status, onPaused, release(reason), notifyPublished}.
// All ownership operations, including installedGeneration(), run under serial(STATE).
// R1: unknown installed generation, or own < installed (null sorts lowest), forbids create/reclaim.
// R1-owner: a known newer install without a fresh higher want closes the owner and releases its lock in place.
// R2: a live, <=2s-old higher-generation server.want also forbids create/reclaim.
// R3: an entry's driver accessor never accepts a lower generation, even from an unfixed module copy.
// A client of a lower healthy owner replace-writes server.want, heartbeats at 500ms, and watches the lock
// with a 250ms fallback. The nonce survives module reload in the process registry.
// Handover drains writes (<=2s), sends closing, closes the listener, then rename-replaces server.lock.
// A live HELD lock is replaced only by its named pid. The target pid adopts after reading its issued nonce.
// A failed swap keeps the old lock byte-identical, with a non-serving entry retrying each owner tick.
// Enabled closes never unlink: after closing, rename to HELD(successor) or RELEASED(real pid, generation, port, reason).
// RELEASED/dead records are taken through an exclusive hard-link claim at the legacy reclaim tombstone name,
// then an exact-text and eligibility check, listen, and atomic replacement. Dead fixed claims are traversed
// through nonce-derived, bounded-length slots; live claims and unfixed tombstones are never removed or bypassed.
// Only pause unlinks an exact owned lock. Absent locks are created with wx. Fixed enabled transitions have no gap.
// Unfixed owners cannot be displaced: wait for their lock to disappear or pid to die. Unfixed clients cannot
// reclaim RELEASED while its real pid lives; an unfixed reclaimer's pre-existing crash tombstone still blocks.
// Reload/new/resume/fork retain the listener with writes BUSY for 15s, until a same/newer host adopts.
// A changed generation rebuilds the board and rewrites its own lock/server.json without unlinking.
// Quit (including a missing reason), stale step-down and grace expiry close then release or hand over.
// Paused clients keep one settings-only 5s check; paused owners send paused and remove their own files.
// - Change detection only while a browser is connected: published.json is stat'ed every 500ms; a change, or this
//   process's notifyPublished(), rebuilds the view model with readSnapshot + buildViewModel (this generation's code) and
//   broadcasts it. A data.js written by any generation is never forwarded.
// - Board writes: every time this process starts serving it makes a new random write token (memory only: not in the lock,
//   server.json, a log or a model) and hands it to the board server and, as getPage(vm, token), to the served page.
//   answer(body) / focus(body) -> Promise|{status, json} are the extension's hooks for POST /answer and /focus; while the
//   board is paused the host answers 503 PAUSED itself and calls neither.
// - File I/O here is async; every timer and socket is unref'd; nothing here throws into the caller's session.
//
// Error keys: 'server:listen' (bind, NO_PORT), 'server:lock' (lock, server.json, owner health), 'server:sse' (view model,
// change detection, streams). A later success of the same key calls onRecover(key).
import * as nodeFsp from 'node:fs/promises';
import { watch } from 'node:fs';
import http from 'node:http';
import { join, resolve as resolvePath } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createBoardServer as defaultCreateBoardServer } from './server.mjs';
import { isPidAlive } from './store.mjs';

export const SERVER_LOCK = 'server.lock';
export const SERVER_JSON = 'server.json';
export const SERVER_WANT = 'server.want';
export const DEFAULT_PORT_BASE = 47317;
export const PORT_COUNT = 10;
export const CHECK_EVERY_MS = 5000;
export const HEALTH_TIMEOUT_MS = 1000;
export const POLL_MS = 500;
export const REFUSED_LIMIT = 3;

const REGISTRY = Symbol.for('omo.briefing.server');
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [20, 40, 80]; // awaited (never blocking); keeps a release well inside the 2s shutdown budget
const MAX_RECORD_CHARS = 4096;
const LOST = Symbol('lost the wx race');
const PAUSED_REPLY = { status: 503, json: { ok: false, code: 'PAUSED' } };
const NOT_SUPPORTED_REPLY = { status: 501, json: { ok: false, code: 'NOT_SUPPORTED' } };
const BUSY_REPLY = { status: 429, json: { ok: false, code: 'BUSY' } };
const rank = (g) => Number.isInteger(g) ? g : -1;

export async function readInstalledGeneration(file, fsp = nodeFsp, timers = { setTimeout }) {
  for (let i = 0; ; i++) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      if (Buffer.byteLength(text) > 64 * 1024) return 'unknown';
      let rec;
      try { rec = JSON.parse(text); } catch { return 'unknown'; }
      const match = /^generation-(\d{6})$/.exec(rec?.generation);
      return match ? Number(match[1]) : 'unknown';
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (!RETRY_CODES.has(err.code) || i >= RETRY_DELAYS_MS.length) return 'unknown';
      await new Promise((resolve) => timers.setTimeout(resolve, RETRY_DELAYS_MS[i]));
    }
  }
}

export const urlOf = (port) => `http://127.0.0.1:${port}/`;

const unref = (h) => {
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

function registry() {
  // One slot per process; module copies loaded by /reload share it through Symbol.for.
  const reg = (globalThis[REGISTRY] ??= { version: 1, servers: new Map(), stranded: new Map(), chains: new Map() });
  reg.wants ??= new Map();
  return reg;
}

function stateKey(dir) {
  const abs = resolvePath(String(dir));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

// Runs fn after every earlier operation on the same STATE in this process has settled. The fns passed here catch their
// own errors; a rejection would still reach the caller through the returned promise.
function serial(key, fn) {
  const chains = registry().chains;
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  chains.set(key, run);
  const forget = () => {
    if (chains.get(key) === run) chains.delete(key);
  };
  run.then(forget, forget);
  return run;
}

function portBaseOf(env) {
  const raw = String((env && env.OMO_BRIEFING_PORT_BASE) ?? '');
  const n = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  return n >= 1 && n + PORT_COUNT - 1 <= 65535 ? n : DEFAULT_PORT_BASE;
}

// Parses a lock/server.json record; returns null when the text is not a record with an integer pid.
function parseRecord(text) {
  let rec;
  try {
    rec = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return null; // not a record: the caller treats it as unreadable (held) / not ours
    throw err;
  }
  return rec && typeof rec === 'object' && Number.isInteger(rec.pid) ? rec : null;
}

/** GET http://127.0.0.1:<port>/health within timeoutMs; resolves the parsed body, rejects with an error carrying `code`. */
export function probeHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/health', agent: false, headers: { Connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > MAX_RECORD_CHARS) req.destroy(Object.assign(new Error('health reply too large'), { code: 'EHEALTH' }));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          finish(reject, Object.assign(new Error(`health status ${res.statusCode}`), { code: 'EHEALTH' }));
          return;
        }
        try {
          finish(resolve, JSON.parse(body));
        } catch (err) {
          finish(reject, Object.assign(err, { code: 'EHEALTH' }));
        }
      });
      res.on('error', (err) => finish(reject, err));
    });
    timer = unref(setTimeout(() => req.destroy(Object.assign(new Error(`health timeout ${timeoutMs}ms`), { code: 'ETIMEDOUT' })), timeoutMs));
    req.on('socket', (s) => s.unref());
    req.on('error', (err) => finish(reject, err));
  });
}

export function createServerHost(options) {
  const {
    stateDir,
    sessionId,
    generation = null,
    installedGeneration = async () => null,
    isEnabled,
    buildViewModel,
    readSnapshot,
    getPage,
    answer,
    focus,
    reclaimStale,
    onError = () => {},
    onRecover = () => {},
    onChange = () => {},
    env = process.env,
    now = Date.now,
    timers = { setInterval, clearInterval, setTimeout, clearTimeout },
    fs = nodeFsp,
    isAlive = isPidAlive,
    probeHealth: probe = probeHealth,
    createBoardServer = defaultCreateBoardServer,
  } = options;

  const key = stateKey(stateDir);
  const lockPath = join(stateDir, SERVER_LOCK);
  const jsonPath = join(stateDir, SERVER_JSON);
  const publishedPath = join(stateDir, 'published.json');
  const wantPath = join(stateDir, SERVER_WANT);
  const portBase = portBaseOf(env);

  let role = 'idle'; // idle | client | unavailable | paused (owner is derived from the process registry)
  let owner = null; // {pid, port} of the other process's server this host uses or watches
  let refused = 0;
  let checkTimer = null;
  let pending = null;
  let lastSig = '';
  let installed = null;
  let want = null;
  let wantTimer = null;
  let fastTimer = null;
  let watcher = null;
  const staleNow = () => installed === 'unknown' || (Number.isInteger(installed) && rank(generation) < installed);

  async function readInstalled() {
    installed = await installedGeneration();
    if (installed === 'unknown') report('server:lock', new Error('installed generation unknown'));
    return installed;
  }

  // A host callback that throws must never take the lead conversation down.
  function safe(fn, ...args) {
    try {
      fn(...args);
    } catch (e) {
      process.emitWarning(`omo-briefing server host callback failed: ${e && e.message}`);
    }
  }
  const report = (k, err) => safe(onError, k, err instanceof Error ? err : new Error(String(err)));
  const recover = (k) => safe(onRecover, k);

  function enabledNow() {
    try {
      return Boolean(isEnabled());
    } catch (err) {
      report('server:lock', err);
      return false; // pause state unknown = paused: never own a server on a guess
    }
  }

  const delay = (ms) => new Promise((r) => unref(timers.setTimeout(r, ms)));

  async function withRetry(op) {
    for (let i = 0; ; i++) {
      try {
        return await op();
      } catch (err) {
        if (!RETRY_CODES.has(err && err.code) || i >= RETRY_DELAYS_MS.length) throw err;
        await delay(RETRY_DELAYS_MS[i]);
      }
    }
  }

  async function readSmall(path) {
    const text = await withRetry(() => fs.readFile(path, 'utf8'));
    if (text.length > MAX_RECORD_CHARS) throw Object.assign(new Error(`${path}: 기록이 너무 큼(${text.length}자)`), { code: 'ETOOBIG' });
    return text;
  }

  // {state:'absent'} | {state:'held', rec, text} | {state:'unreadable', err}
  async function readLock() {
    let text;
    try {
      text = await readSmall(lockPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') return { state: 'absent' };
      return { state: 'unreadable', err: new Error(`server.lock을 읽지 못함(잡혀 있는 것으로 봄): ${err.code || err.message}`) };
    }
    const rec = parseRecord(text);
    if (!rec) return { state: 'unreadable', err: new Error('server.lock 내용을 읽을 수 없음(쓰는 중이거나 깨짐 - 잡혀 있는 것으로 봄)') };
    return { state: 'held', rec, text };
  }

  async function previousPort() {
    let text;
    try {
      text = await readSmall(jsonPath);
    } catch (err) {
      if (err && err.code !== 'ENOENT') report('server:lock', new Error(`server.json을 읽지 못함(이전 포트 대신 처음부터 찾음): ${err.code || err.message}`));
      return undefined;
    }
    const rec = parseRecord(text);
    return rec && Number.isInteger(rec.port) ? rec.port : undefined;
  }

  async function checkHealth(rec) {
    if (!Number.isInteger(rec.port)) return { ok: false, code: 'EBADLOCK' };
    try {
      const h = await probe(rec.port, HEALTH_TIMEOUT_MS);
      return h && h.ok === true && h.pid === rec.pid ? { ok: true } : { ok: false, code: 'EMISMATCH' };
    } catch (err) {
      return { ok: false, code: err && err.code }; // the code decides: ECONNREFUSED counts toward the pid-reuse rule
    }
  }

  const entry = () => registry().servers.get(key);

  function status() {
    const e = entry();
    if (e && e.serving) return { role: 'owner', url: e.url, port: e.port, pid: process.pid, clients: e.clients, refused: 0, stale: staleNow(), wanting: Boolean(want) };
    return { role, url: role === 'client' && owner ? urlOf(owner.port) : null, port: owner ? owner.port : null, pid: owner ? owner.pid : null, clients: 0, refused, stale: role === 'stale' || staleNow(), wanting: Boolean(want) };
  }

  function changed() {
    const s = status();
    const sig = `${s.role}|${s.url}`;
    if (sig === lastSig) return;
    lastSig = sig;
    safe(onChange, s);
  }

  function startCheck() {
    if (!checkTimer) checkTimer = unref(timers.setInterval(() => ensure(), CHECK_EVERY_MS));
  }
  function stopCheck() {
    if (checkTimer) timers.clearInterval(checkTimer);
    checkTimer = null;
  }

  function notServing(result) {
    role = result ? 'client' : 'unavailable';
    startCheck();
    changed();
    return result;
  }

  function markPaused() {
    startCheck();
    owner = null;
    refused = 0;
    role = 'paused';
    changed();
  }

  // What another host of this process needs to drive a server this host started (or the other way round).
  const self = {
    generation,
    now: () => now(),
    readSnapshot: () => readSnapshot(),
    buildViewModel: (snap, t) => buildViewModel(snap, t),
    getPage: (vm, token) => getPage(vm, token),
    report,
    recover,
    isEnabled: enabledNow,
    markPaused,
    readInstalled,
    markStale(recheck = true) { owner = null; role = 'stale'; if (recheck) startCheck(); changed(); },
    // board write hooks (POST /answer, POST /focus): paused = 503 and the hook is never called
    answer: typeof answer === 'function' ? (body) => (enabledNow() ? answer(body) : PAUSED_REPLY) : undefined,
    focus: typeof focus === 'function' ? (body) => (enabledNow() ? focus(body) : PAUSED_REPLY) : undefined,
  };

  async function replaceFile(path, text) {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, text);
      await withRetry(() => fs.rename(tmp, path));
    } finally {
      try { await fs.unlink(tmp); } catch (err) { if (err.code !== 'ENOENT') report('server:lock', err); }
    }
  }

  async function freshWant() {
    try {
      const text = await readSmall(wantPath);
      const rec = parseRecord(text);
      const stat = await fs.stat(wantPath);
      return rec && rec.nonce && now() - stat.mtimeMs <= 2000 && isAlive(rec.pid) ? { rec, text } : null;
    } catch (err) {
      if (err.code !== 'ENOENT') report('server:lock', err);
      return null;
    }
  }

  async function stopWant(forget = false) {
    if (wantTimer) timers.clearInterval(wantTimer);
    if (fastTimer) timers.clearInterval(fastTimer);
    wantTimer = fastTimer = null;
    watcher?.close();
    watcher = null;
    if (!want) return;
    const nonce = want.nonce;
    want = null;
    // The owner may already have passed its final check. Keep proof of this process's issued nonce
    // until a transferred lock is consumed or removed, including across a wanting instance's reload.
    if (forget) registry().wants.delete(nonce);
    try {
      if (parseRecord(await readSmall(wantPath))?.nonce === nonce) await withRetry(() => fs.unlink(wantPath));
    } catch (err) { if (err.code !== 'ENOENT') report('server:lock', err); }
  }

  async function startWant() {
    const other = await freshWant();
    if (other && other.rec.nonce !== want?.nonce && rank(other.rec.generation) >= rank(generation)) return;
    if (!want) {
      want = { pid: process.pid, at: now(), nonce: randomUUID(), sessionId, generation };
      await replaceFile(wantPath, JSON.stringify(want));
      registry().wants.set(want.nonce, { key, rec: want });
    }
    if (!wantTimer) wantTimer = unref(timers.setInterval(() => serial(key, async () => {
      if (!want) return; // an adoption may have cancelled a heartbeat already queued behind its serial operation
      const current = await freshWant();
      if (current?.rec.nonce !== want?.nonce) { await stopWant(); return; }
      const at = new Date(now());
      await withRetry(() => fs.utimes(wantPath, at, at));
    }).catch((err) => report('server:lock', err)), 500));
    if (!fastTimer) fastTimer = unref(timers.setInterval(() => ensure(), 250));
    if (!watcher) {
      watcher = watch(stateDir, (_, name) => { if (String(name) === SERVER_LOCK) ensure(); });
      watcher.on('error', (err) => report('server:lock', err));
      watcher.unref();
    }
  }

  // ---- the server this process owns ----

  async function buildVm(e) {
    const d = e.driver;
    const snap = await d.readSnapshot();
    const vm = await d.buildViewModel(snap, d.now());
    // '<sha>.<ext>' of every report image of this model: the board serves /assets/<name> only for these
    const refs = new Set();
    for (const s of Array.isArray(vm?.sessions) ? vm.sessions : []) {
      for (const r of Array.isArray(s?.reports) ? s.reports : []) {
        for (const img of Array.isArray(r?.images) ? r.images : []) {
          if (typeof img?.src === 'string' && img.src.startsWith('assets/')) refs.add(img.src.slice('assets/'.length));
        }
      }
    }
    e.assetRefs = refs;
    if (vm && typeof vm === 'object') {
      if (!Number.isInteger(vm.seq)) vm.seq = snap && snap.published && Number.isInteger(snap.published.seq) ? snap.published.seq : 0;
      if (vm.gen === undefined) vm.gen = d.generation;
    }
    return vm;
  }

  // /assets/<name> is served only while the CURRENT model references it: the references of the latest built model are
  // reused while published.json is unchanged (stat before build, like the poller), otherwise the model is rebuilt first.
  async function assetAllowed(e, name) {
    const k = await statKey();
    if (!e.assetRefs || e.assetKey !== k) {
      await buildVm(e);
      e.assetKey = k;
    }
    return e.assetRefs.has(name);
  }

  function entryError(e, k, err) {
    let error = err;
    if (err && err.code === 'NO_PORT') {
      error = Object.assign(new Error(`실시간 서버를 열 포트가 없음(${portBase}~${portBase + PORT_COUNT - 1} 사용 중) - 파일 상황판은 계속 됨`), { code: 'NO_PORT' });
    }
    if (k === 'server:listen') e.listenReported = true;
    e.driver.report(k, error);
  }

  async function statKey() {
    try {
      const st = await fs.stat(publishedPath);
      return `${st.size}:${st.mtimeMs}`;
    } catch (err) {
      if (err && err.code === 'ENOENT') return 'none';
      throw err;
    }
  }

  // Rebuilds the view model and sends it to every connected page; overlapping triggers coalesce into one more round.
  function rebroadcast(e, knownKey) {
    if (e.building) {
      e.dirty = true;
      return e.building;
    }
    e.building = (async () => {
      let k = knownKey;
      do {
        e.dirty = false;
        e.pollKey = k !== undefined ? k : await statKey(); // stat before reading: a publish after this stat is seen next poll
        k = undefined;
        const vm = await buildVm(e);
        if (registry().servers.get(key) !== e) return;
        e.board.broadcast(vm);
        e.driver.recover('server:sse');
      } while (e.dirty);
    })()
      .catch((err) => entryError(e, 'server:sse', err))
      .finally(() => {
        e.building = null;
      });
    return e.building;
  }

  async function pollOnce(e) {
    if (e.polling || registry().servers.get(key) !== e) return;
    e.polling = true;
    try {
      const k = await statKey();
      if (k !== e.pollKey) await rebroadcast(e, k); // the first poll after a connect always rebuilds (pollKey unset)
    } catch (err) {
      entryError(e, 'server:sse', err);
    } finally {
      e.polling = false;
    }
  }

  function clientCount(e, n) {
    e.clients = n;
    if (n > 0 && !e.pollTimer && registry().servers.get(key) === e) {
      e.pollKey = undefined;
      e.pollTimer = unref(e.timers.setInterval(() => pollOnce(e), POLL_MS));
    } else if (n === 0 && e.pollTimer) {
      e.timers.clearInterval(e.pollTimer);
      e.pollTimer = null;
    }
  }

  async function writeServerJson(e) {
    const tmp = `${jsonPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, e.text);
      await withRetry(() => fs.rename(tmp, jsonPath));
      e.jsonPending = false;
      return true;
    } catch (err) {
      e.jsonPending = true; // retried on the owner's next check
      try {
        await fs.unlink(tmp);
      } catch (cleanupErr) {
        if (cleanupErr.code !== 'ENOENT') e.driver.report('server:lock', cleanupErr);
      }
      e.driver.report('server:lock', new Error(`server.json 쓰기 실패(다른 대화가 주소를 못 찾을 수 있음): ${err.code || err.message}`));
      return false;
    }
  }

  // Removes the lock only if it still holds exactly `text`. On a failure the text stays in the registry so this process
  // can remove its own leftover later (a live pid is never reclaimed by the dead-owner rule).
  async function removeOwnLock(text, d) {
    const stranded = registry().stranded;
    let cur;
    try {
      cur = await readSmall(lockPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        stranded.delete(key);
        return true;
      }
      stranded.set(key, text);
      d.report('server:lock', new Error(`실시간 서버 잠금 해제 확인 실패(잠금이 남았을 수 있음): ${err.code || err.message}`));
      return false;
    }
    if (cur !== text) {
      stranded.delete(key);
      return true; // not ours any more: never delete someone else's lock
    }
    try {
      await withRetry(() => fs.unlink(lockPath));
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        stranded.delete(key);
        return true;
      }
      stranded.set(key, text);
      d.report('server:lock', new Error(`실시간 서버 잠금 해제 실패(잠금이 남았을 수 있음): ${err.code || err.message}`));
      return false;
    }
    stranded.delete(key);
    return true;
  }

  async function removeOwnJson(e, d) {
    let text;
    try {
      text = await readSmall(jsonPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') return true;
      d.report('server:lock', new Error(`server.json 정리 확인 실패: ${err.code || err.message}`));
      return false;
    }
    const rec = parseRecord(text);
    if (!rec || rec.nonce !== e.rec.nonce) return true; // another owner's record (or none): not ours to remove
    try {
      await withRetry(() => fs.unlink(jsonPath));
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return true;
      d.report('server:lock', new Error(`server.json 정리 실패: ${err.code || err.message}`));
      return false;
    }
  }

  async function retireLock(e, reason, installedValue) {
    const lock = await readLock();
    if (lock.state === 'unreadable') throw lock.err;
    if (lock.text !== e.text) {
      await removeOwnJson(e, e.driver);
      return 'gone';
    }
    const wanted = await freshWant();
    if (wanted && rank(wanted.rec.generation) > rank(e.driver.generation)) {
      await replaceFile(lockPath, JSON.stringify({ ...wanted.rec, port: e.port }));
      owner = { pid: wanted.rec.pid, port: e.port };
      notServing({ url: urlOf(e.port) });
      return 'handed';
    }
    await removeOwnJson(e, e.driver);
    await replaceFile(lockPath, JSON.stringify({
      ...e.rec, pid: process.pid, at: now(), nonce: randomUUID(), released: reason,
      installed: Number.isInteger(installedValue) ? installedValue : null,
    }));
    return 'released';
  }

  // Runs inside serial(key). Failed enabled closes retain a driven entry that can never serve again.
  async function closeEntry(e, paused, reason = 'quit', installedValue = null) {
    const reg = registry();
    if (reg.servers.get(key) !== e) return;
    reg.servers.delete(key);
    e.timers.clearInterval(e.ownerTimer);
    if (e.pollTimer) e.timers.clearInterval(e.pollTimer);
    e.ownerTimer = null;
    e.pollTimer = null;
    if (e.graceTimer) e.timers.clearTimeout(e.graceTimer);
    e.graceTimer = null;
    const d = e.driver;
    if (!paused) {
      e.handingOver = true;
      await drain(e);
    }
    if (e.serving) {
      if (paused) e.board.sendPaused();
      else e.board.broadcastClosing({ reason, installed: Number.isInteger(installedValue) ? installedValue : null, own: d.generation });
      // http responses cork their writes until the next tick; closeAllConnections() right away would drop the frame.
      // setImmediate runs after that uncork, so the paused frame is handed to the socket before it is closed.
      await new Promise((r) => setImmediate(r));
    }
    await e.board?.close(); // a transferred lock can be ours before any listener exists
    e.serving = false;
    e.jsonPending = false;
    if (paused) {
      const lockGone = await removeOwnLock(e.text, d);
      const jsonGone = await removeOwnJson(e, d);
      if (lockGone) reg.wants.delete(e.rec.nonce);
      if (lockGone && jsonGone) d.recover('server:lock');
      return 'removed';
    }
    try {
      const result = await retireLock(e, reason, installedValue);
      reg.wants.delete(e.rec.nonce);
      d.recover('server:lock');
      return result;
    } catch (err) {
      e.retiring = reason;
      reg.servers.set(key, e);
      e.ownerTimer = unref(e.timers.setInterval(() => serial(key, () => ownerTick(e)), CHECK_EVERY_MS));
      owner = null;
      role = 'unavailable';
      d.report('server:lock', new Error(`server.lock release failed: ${err.code || err.message}`));
      changed();
      return 'kept';
    }
  }

  // Runs inside serial(key): the owner's 5s check - a pause made anywhere closes the server; a failed server.json is retried.
  async function ownerTick(e) {
    if (registry().servers.get(key) !== e) return;
    const d = e.driver;
    try {
      if (!d.isEnabled()) {
        await closeEntry(e, true);
        d.markPaused();
        return;
      }
      const current = await d.readInstalled();
      if (e.retiring) {
        const result = await closeEntry(e, false, e.retiring, current);
        if (result === 'released' || result === 'gone') d.markStale(e.retiring === 'stale');
        return;
      }
      if (e.jsonPending && (await writeServerJson(e))) d.recover('server:lock');
      const wanted = await freshWant();
      if (wanted && rank(wanted.rec.generation) > rank(d.generation)) {
        await handover(e, wanted, current);
        return;
      }
      if ((Number.isInteger(current) && current > rank(d.generation)) || (!e.serving && current === 'unknown')) {
        const result = await closeEntry(e, false, 'stale', current);
        if (result === 'released' || result === 'gone') d.markStale();
        return;
      }
      if (!e.serving) {
        const lock = await readLock();
        if (lock.text !== e.text) return;
        if (await listen(e, e.port)) {
          if (e.port !== e.rec.port) {
            e.rec.port = e.port;
            e.text = JSON.stringify(e.rec);
            await replaceFile(lockPath, e.text);
          }
          e.handingOver = false;
          await writeServerJson(e);
          changed();
        }
      }
    } catch (err) {
      d.report('server:lock', err);
    }
  }

  // The newest host of this process drives the one server; a host that has no such hook (an older generation) answers 501.
  function writeVia(e, name, body) {
    if (e.handingOver || e.graceTimer) return BUSY_REPLY;
    const hook = e.driver[name];
    return typeof hook === 'function' ? hook(body) : NOT_SUPPORTED_REPLY;
  }

  // Runs inside serial(key). Returns {url}, null (could not serve) or LOST (another process created the lock first).
  async function drain(e) {
    if (!e.serving) return true;
    let timer;
    return await Promise.race([
      e.board.idle().then(() => true),
      new Promise((resolve) => { timer = unref(timers.setTimeout(() => resolve(false), 2000)); }),
    ]).finally(() => timers.clearTimeout(timer));
  }

  async function handover(e, wanted, current) {
    e.handingOver = true;
    if (!(await drain(e))) { e.handingOver = false; return; }
    const lock = await readLock();
    const latest = await freshWant();
    if (!e.driver.isEnabled() || lock.text !== e.text || latest?.text !== wanted.text) {
      e.handingOver = false;
      return;
    }
    if (e.serving) {
      e.board.broadcastClosing({ reason: 'handover', installed: Number.isInteger(current) ? current : null, own: e.driver.generation });
      await new Promise((resolve) => setImmediate(resolve));
    }
    registry().servers.delete(key);
    e.timers.clearInterval(e.ownerTimer);
    if (e.pollTimer) e.timers.clearInterval(e.pollTimer);
    e.pollTimer = null;
    if (e.graceTimer) e.timers.clearTimeout(e.graceTimer);
    e.graceTimer = null;
    await e.board?.close();
    e.serving = false;
    try {
      await replaceFile(lockPath, JSON.stringify({ ...wanted.rec, port: e.port }));
    } catch (err) {
      // Retain the live owner's lock but NEVER serve the older board after a failed swap.
      registry().servers.set(key, e);
      e.ownerTimer = unref(e.timers.setInterval(() => serial(key, () => ownerTick(e)), CHECK_EVERY_MS));
      role = 'unavailable';
      e.driver.report('server:lock', new Error(`server.lock swap failed: ${err.code || err.message}`));
      changed();
      return;
    }
    owner = { pid: wanted.rec.pid, port: e.port };
    registry().wants.delete(e.rec.nonce);
    notServing({ url: urlOf(e.port) });
  }

  function newEntry() {
    const e = {
      timers,
      board: null,
      port: 0,
      url: null,
      rec: null,
      text: null,
      clients: 0,
      ownerTimer: null,
      pollTimer: null,
      pollKey: undefined,
      polling: false,
      building: null,
      dirty: false,
      jsonPending: false,
      listenReported: false,
      serving: false,
      handingOver: false,
      graceTimer: null,
      // the write token of THIS serving start: it lives in memory only (never in the lock, server.json, a log or a model)
      // and is handed to the page through getPage; a hand-over to another process starts a new one
      token: null,
    };
    let driver = self;
    Object.defineProperty(e, 'driver', {
      get: () => driver,
      set: (next) => { if (rank(next.generation) >= rank(driver.generation)) driver = next; },
    });
    return e;
  }

  async function listen(e, preferPort) {
    e.token = randomBytes(32).toString('base64url');
    const board = createBoardServer({
      getPage: async () => e.driver.getPage(await buildVm(e), e.token),
      getViewModel: () => buildVm(e),
      token: e.token,
      assetsDir: join(stateDir, 'assets'),
      assetAllowed: (name) => assetAllowed(e, name),
      onAnswer: (body) => writeVia(e, 'answer', body),
      onFocus: (body) => writeVia(e, 'focus', body),
      generation: e.driver.generation,
      portBase,
      portCount: PORT_COUNT,
      preferPort: Number.isInteger(preferPort) ? preferPort : undefined,
      onError: (k, err) => entryError(e, k, err),
      onRecover: (k) => e.driver.recover(k),
      onClientCount: (n) => clientCount(e, n),
    });
    e.board = board;
    let port;
    try {
      ({ port } = await board.start());
    } catch (err) {
      // start() reports its listen failures (NO_PORT included) through onError itself; anything else is reported here
      if (!e.listenReported) report('server:listen', err);
      await board.close();
      return false;
    }
    Object.assign(e, { port, url: urlOf(port), serving: true });
    return true;
  }

  async function becomeOwner(preferPort, adopted, replaces = false) {
    const e = newEntry();
    if (!(await listen(e, preferPort))) return null;
    const port = e.port;
    const rec = adopted ? { ...adopted, port, generation, sessionId } : { pid: process.pid, at: now(), nonce: randomUUID(), sessionId, port, generation };
    const text = JSON.stringify(rec);
    try {
      await fs.mkdir(stateDir, { recursive: true });
      if (adopted) {
        if (JSON.stringify(adopted) !== (await readLock()).text) { await e.board.close(); return LOST; }
        if (text !== JSON.stringify(adopted)) await replaceFile(lockPath, text);
      } else if (replaces) await replaceFile(lockPath, text);
      else await fs.writeFile(lockPath, text, { flag: 'wx' });
    } catch (err) {
      await e.board.close();
      if (err && err.code === 'EEXIST') return LOST;
      report('server:lock', new Error(`server.lock을 만들지 못함: ${err.code || err.message}`));
      return null;
    }
    Object.assign(e, { port, url: urlOf(port), rec, text });
    registry().servers.set(key, e);
    e.ownerTimer = unref(timers.setInterval(() => serial(key, () => ownerTick(e)), CHECK_EVERY_MS));
    if (await writeServerJson(e)) recover('server:lock');
    await stopWant(true);
    stopCheck();
    owner = null;
    refused = 0;
    changed();
    return { url: e.url };
  }

  async function claim(target) {
    if (!target) return null;
    const text = JSON.stringify({ pid: process.pid, at: now(), nonce: randomUUID(), sessionId, generation, claims: target });
    const tmp = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const base = `${lockPath}.stale-${target}`;
    let name = base;
    try {
      await fs.writeFile(tmp, text);
      for (;;) {
        try {
          await withRetry(() => fs.link(tmp, name));
          return { name, text };
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
        let other;
        try { other = parseRecord(await readSmall(name)); }
        catch (err) { if (err.code === 'ENOENT') continue; throw err; }
        if (!other || other.claims !== target || !other.nonce || isAlive(other.pid)) return null;
        // Ancestors are immutable and remain in place. Every contender follows the same dead nonces.
        // Reuse the base, not the previous path, so repeated interruptions never exhaust filename length.
        name = `${base}.${other.nonce}`;
      }
    } finally {
      try { await fs.unlink(tmp); } catch (err) { if (err.code !== 'ENOENT') report('server:lock', err); }
    }
  }

  async function dropClaim(c) {
    try {
      if (await readSmall(c.name) === c.text) await withRetry(() => fs.unlink(c.name));
    } catch (err) { if (err.code !== 'ENOENT') report('server:lock', err); }
  }

  async function takeOver(lock) {
    const c = await claim(lock.rec.nonce);
    if (!c) return notServing(null);
    try {
      if ((await readLock()).text !== lock.text) return LOST;
      await readInstalled();
      if (staleNow()) { self.markStale(); return null; }
      if (!enabledNow()) { markPaused(); return null; }
      const wanted = await freshWant();
      if (wanted && rank(wanted.rec.generation) > rank(generation)) return notServing(null);
      const got = await becomeOwner(lock.rec.port, undefined, true);
      return got === LOST ? LOST : got ?? notServing(null);
    } finally {
      await dropClaim(c);
    }
  }

  // ---- ensure: own, reuse, or watch ----

  async function ensureNow() {
    try {
      if (!enabledNow()) {
        await stopWant();
        const e = entry();
        if (e) await closeEntry(e, true);
        markPaused();
        return null;
      }
      await readInstalled();
      if (staleNow()) await stopWant();
      const mine = entry();
      if (mine) {
        if (mine.retiring) { await ownerTick(mine); return null; }
        if (!staleNow() && rank(generation) >= rank(mine.driver.generation) && (mine.graceTimer || mine.rec.generation !== generation)) {
          mine.handingOver = true;
          if (!(await drain(mine))) { mine.handingOver = false; return { url: mine.url }; }
          const lock = await readLock();
          if (lock.text !== mine.text) return notServing(null);
          mine.timers.clearTimeout(mine.graceTimer);
          mine.timers.clearInterval(mine.ownerTimer);
          if (mine.pollTimer) mine.timers.clearInterval(mine.pollTimer);
          if (!mine.graceTimer) {
            mine.board.broadcastClosing({ reason: 'handover', installed: Number.isInteger(installed) ? installed : null, own: mine.rec.generation });
          }
          await new Promise((resolve) => setImmediate(resolve));
          await mine.board.close();
          registry().servers.delete(key);
          const adopted = { ...mine.rec, nonce: randomUUID(), sessionId, generation };
          // Retain an adoptable nonce even if the rebuild's rename or listen fails.
          registry().wants.set(mine.rec.nonce, { key, rec: mine.rec });
          want = mine.rec;
          try { await replaceFile(lockPath, JSON.stringify(adopted)); }
          catch (err) { report('server:lock', err); return notServing(null); }
          registry().wants.delete(mine.rec.nonce);
          registry().wants.set(adopted.nonce, { key, rec: adopted });
          want = adopted;
          return (await becomeOwner(mine.port, adopted)) ?? notServing(null);
        }
        if (!staleNow()) mine.driver = self;
        if (mine.driver === self) await ownerTick(mine);
        if (!entry()) return null;
        stopCheck();
        owner = null;
        refused = 0;
        changed();
        return mine.serving ? { url: mine.url } : null;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const lock = await readLock();
        let preferPort;
        if (lock.state === 'unreadable') {
          report('server:lock', lock.err);
          return notServing(null);
        }
        if (lock.state === 'held') {
          if (registry().stranded.get(key) === lock.text) {
            // Pause cleanup failed. Once enabled again, release the verified closed lock without a gap.
            await replaceFile(lockPath, JSON.stringify({
              ...lock.rec, pid: process.pid, at: now(), nonce: randomUUID(), released: 'quit', installed,
            }));
            registry().stranded.delete(key);
            recover('server:lock');
            continue;
          }
          const rec = lock.rec;
          owner = { pid: rec.pid, port: rec.port };
          if (rec.released) {
            if (staleNow()) { self.markStale(); return null; }
            const wanted = await freshWant();
            if (wanted && rank(wanted.rec.generation) > rank(generation)) return notServing(null);
            const got = await takeOver(lock);
            if (got === LOST) continue;
            return got;
          }
          if (rec.pid === process.pid && registry().wants.get(rec.nonce)?.key === key) {
            want ??= registry().wants.get(rec.nonce).rec;
            if (staleNow()) {
              const e = newEntry();
              Object.assign(e, { rec, text: lock.text, port: rec.port, url: urlOf(rec.port) });
              registry().servers.set(key, e);
              e.ownerTimer = unref(timers.setInterval(() => serial(key, () => ownerTick(e)), CHECK_EVERY_MS));
              await stopWant();
              await ownerTick(e);
              return e.serving ? { url: e.url } : null;
            }
            return (await becomeOwner(rec.port, rec)) ?? notServing(null);
          }
          const health = await checkHealth(rec);
          if (health.ok) {
            refused = 0;
            recover('server:lock');
            if (!staleNow() && rank(rec.generation) < rank(generation)) await startWant();
            else await stopWant();
            return notServing({ url: urlOf(rec.port) });
          }
          if (isAlive(rec.pid)) {
            if (staleNow()) { self.markStale(); return null; }
            // a live pid that does not answer: never take over (Windows can hand a dead owner's pid to another program)
            refused = health.code === 'ECONNREFUSED' ? refused + 1 : 0;
            if (refused >= REFUSED_LIMIT) {
              report('server:lock', new Error(`실시간 서버 주인(pid ${rec.pid}, 포트 ${rec.port})이 살아 있는 것으로 보이지만 ${REFUSED_LIMIT}번 연속 연결을 거부함 - 넘겨받지 않음(server.lock 확인 필요)`));
            }
            return notServing(null);
          }
          refused = 0;
          if (staleNow()) {
            await stopWant();
            self.markStale();
            return null;
          }
          const wanted = await freshWant();
          if (wanted && rank(wanted.rec.generation) > rank(generation)) return notServing(null);
          const got = await takeOver(lock);
          if (got === LOST) continue;
          return got;
        } else {
          if (staleNow()) {
            await stopWant();
            self.markStale();
            return null;
          }
          const wanted = await freshWant();
          if (wanted && rank(wanted.rec.generation) > rank(generation)) return notServing(null);
          preferPort = owner?.port ?? await previousPort();
        }
        const got = await becomeOwner(preferPort);
        if (got === LOST) continue;
        return got ?? notServing(null);
      }
      return notServing(null);
    } catch (err) {
      report('server:lock', err);
      return notServing(null);
    }
  }

  function ensure() {
    if (!pending) {
      pending = serial(key, ensureNow).finally(() => {
        pending = null;
      });
    }
    return pending;
  }

  function onPaused() {
    return serial(key, async () => {
      await stopWant();
      try {
        const e = entry();
        if (e) await closeEntry(e, true);
      } catch (err) {
        report('server:lock', err);
      }
      markPaused();
    });
  }

  function release(reason) {
    return serial(key, async () => {
      stopCheck();
      try {
        const e = entry();
        if (e && e.driver === self) {
          if (['reload', 'new', 'resume', 'fork'].includes(reason)) {
            if (!e.graceTimer) e.graceTimer = unref(e.timers.setTimeout(() => serial(key, async () => {
              if (entry() !== e || !e.graceTimer) return;
              const current = await e.driver.readInstalled();
              const result = await closeEntry(e, false, 'quit', current);
              if (result === 'released' || result === 'gone') e.driver.markStale(false);
            }), 15000));
            return;
          }
          await readInstalled();
          const result = await closeEntry(e, false, e.retiring ?? 'quit', installed);
          if (result === 'handed' || result === 'kept') return;
        }
        await stopWant();
      } catch (err) {
        report('server:lock', err);
      }
      owner = null;
      refused = 0;
      role = 'stale';
      changed();
    });
  }

  function notifyPublished() {
    const e = entry();
    if (e && e.clients > 0) rebroadcast(e); // never rejects; without a browser there is nobody to tell
  }

  return { ensure, status, onPaused, release, notifyPublished };
}
