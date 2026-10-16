// omo-briefing src/server-host.mjs - which lead conversation runs the board server, and hand-over between them.
//
// createServerHost({stateDir, sessionId, generation, isEnabled, buildViewModel, readSnapshot, getPage, reclaimStale,
//                   onError, onRecover, env, now, timers, onChange?, fs?, isAlive?, probeHealth?, createBoardServer?})
//   -> {ensure(): Promise<{url}|null>, status(), onPaused(): Promise<void>, release(): Promise<void>, notifyPublished()}
//
// Single owner per STATE across all pi processes (the argument, not just the mechanism):
// - Ownership = holding STATE/server.lock. It is created with 'wx' only AFTER this process's server is listening, with
//   content {pid, at, nonce, sessionId, port, generation}; the owner then replace-writes STATE/server.json (same fields).
//   A process that loses the 'wx' race closes its just-started server before anyone learns its port.
// - A lock is removed only (a) by its creator after re-reading it and finding exactly its own content, or (b) by the
//   injected store.reclaimStale, which only takes a lock whose pid is dead and whose pid/at/nonce still match.
//   An unreadable lock counts as held. So a live owner's lock is never taken, and at most one process owns a STATE.
// - Every other active lead session checks the owner every 5s (and on ensure): GET /health with a 1s limit, which must
//   report the lock's pid. Health failure + dead owner pid -> reclaim and become the owner, trying the dead owner's port
//   first so open pages reconnect. A closed terminal (no session_shutdown) takes this dead-pid path. Health refused 3
//   times in a row while the pid looks alive (Windows reuses pids) -> 'server:lock' error and no hand-over.
//   Clients read the port and pid from server.lock (the record reclaimStale needs); server.json carries the same fields.
// - In one process: globalThis[Symbol.for('omo.briefing.server')] keeps one server per STATE and every ensure/release/
//   pause of that STATE runs one at a time, so /reload, new, resume and fork share one server; the newest host drives it.
//   A lock whose removal failed keeps its exact content there until a later removal is confirmed.
// - Pause is global (settings.json, read only through isEnabled): no lock while paused; the owner sends `event: paused`,
//   closes, and removes only its own lock and server.json; non-owners stop checking and never take over while paused.
// - Change detection only while a browser is connected: published.json is stat'ed every 500ms; a change, or this
//   process's notifyPublished(), rebuilds the view model with readSnapshot + buildViewModel (this generation's code) and
//   broadcasts it. A data.js written by any generation is never forwarded.
// - File I/O here is async; every timer and socket is unref'd; nothing here throws into the caller's session.
//
// Error keys: 'server:listen' (bind, NO_PORT), 'server:lock' (lock, server.json, owner health), 'server:sse' (view model,
// change detection, streams). A later success of the same key calls onRecover(key).
import * as nodeFsp from 'node:fs/promises';
import http from 'node:http';
import { join, resolve as resolvePath } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createBoardServer as defaultCreateBoardServer } from './server.mjs';
import { isPidAlive } from './store.mjs';

export const SERVER_LOCK = 'server.lock';
export const SERVER_JSON = 'server.json';
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

export const urlOf = (port) => `http://127.0.0.1:${port}/`;

const unref = (h) => {
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

function registry() {
  // One slot per process; module copies loaded by /reload share it through Symbol.for.
  return (globalThis[REGISTRY] ??= { version: 1, servers: new Map(), stranded: new Map(), chains: new Map() });
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
    isEnabled,
    buildViewModel,
    readSnapshot,
    getPage,
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
  const portBase = portBaseOf(env);

  let role = 'idle'; // idle | client | unavailable | paused (owner is derived from the process registry)
  let owner = null; // {pid, port} of the other process's server this host uses or watches
  let refused = 0;
  let checkTimer = null;
  let pending = null;
  let lastSig = '';

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
    if (e) return { role: 'owner', url: e.url, port: e.port, pid: process.pid, clients: e.clients, refused: 0 };
    return { role, url: role === 'client' && owner ? urlOf(owner.port) : null, port: owner ? owner.port : null, pid: owner ? owner.pid : null, clients: 0, refused };
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
    stopCheck();
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
    getPage: (vm) => getPage(vm),
    report,
    recover,
    isEnabled: enabledNow,
    markPaused,
  };

  // ---- the server this process owns ----

  async function buildVm(e) {
    const d = e.driver;
    const snap = await d.readSnapshot();
    const vm = await d.buildViewModel(snap, d.now());
    if (vm && typeof vm === 'object') {
      if (!Number.isInteger(vm.seq)) vm.seq = snap && snap.published && Number.isInteger(snap.published.seq) ? snap.published.seq : 0;
      if (vm.gen === undefined) vm.gen = d.generation;
    }
    return vm;
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

  // Runs inside serial(key).
  async function closeEntry(e, paused) {
    const reg = registry();
    if (reg.servers.get(key) !== e) return;
    reg.servers.delete(key);
    e.timers.clearInterval(e.ownerTimer);
    if (e.pollTimer) e.timers.clearInterval(e.pollTimer);
    e.ownerTimer = null;
    e.pollTimer = null;
    const d = e.driver;
    if (paused) {
      e.board.sendPaused();
      // http responses cork their writes until the next tick; closeAllConnections() right away would drop the frame.
      // setImmediate runs after that uncork, so the paused frame is handed to the socket before it is closed.
      await new Promise((r) => setImmediate(r));
    }
    await e.board.close(); // closeAllConnections + close, bounded at 500ms by the board server
    const lockGone = await removeOwnLock(e.text, d);
    const jsonGone = await removeOwnJson(e, d);
    if (lockGone && jsonGone) d.recover('server:lock');
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
      if (e.jsonPending && (await writeServerJson(e))) d.recover('server:lock');
    } catch (err) {
      d.report('server:lock', err);
    }
  }

  // Runs inside serial(key). Returns {url}, null (could not serve) or LOST (another process created the lock first).
  async function becomeOwner(preferPort) {
    const e = {
      driver: self,
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
    };
    const board = createBoardServer({
      getPage: async () => e.driver.getPage(await buildVm(e)),
      getViewModel: () => buildVm(e),
      generation,
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
      return null;
    }
    const rec = { pid: process.pid, at: now(), nonce: randomUUID(), sessionId, port, generation };
    const text = JSON.stringify(rec);
    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(lockPath, text, { flag: 'wx' });
    } catch (err) {
      await board.close();
      if (err && err.code === 'EEXIST') return LOST;
      report('server:lock', new Error(`server.lock을 만들지 못함: ${err.code || err.message}`));
      return null;
    }
    Object.assign(e, { port, url: urlOf(port), rec, text });
    registry().servers.set(key, e);
    e.ownerTimer = unref(timers.setInterval(() => serial(key, () => ownerTick(e)), CHECK_EVERY_MS));
    if (await writeServerJson(e)) recover('server:lock');
    stopCheck();
    owner = null;
    refused = 0;
    changed();
    return { url: e.url };
  }

  // ---- ensure: own, reuse, or watch ----

  async function ensureNow() {
    try {
      if (!enabledNow()) {
        const e = entry();
        if (e) await closeEntry(e, true);
        markPaused();
        return null;
      }
      const mine = entry();
      if (mine) {
        mine.driver = self; // the newest host of this process drives the one server
        stopCheck();
        owner = null;
        refused = 0;
        changed();
        return { url: mine.url };
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
            // this process's own lock whose removal failed earlier, content-verified: remove it now
            if (!(await removeOwnLock(lock.text, self))) return notServing(null);
            recover('server:lock');
            continue;
          }
          const rec = lock.rec;
          owner = { pid: rec.pid, port: rec.port };
          const health = await checkHealth(rec);
          if (health.ok) {
            refused = 0;
            recover('server:lock');
            return notServing({ url: urlOf(rec.port) });
          }
          if (isAlive(rec.pid)) {
            // a live pid that does not answer: never take over (Windows can hand a dead owner's pid to another program)
            refused = health.code === 'ECONNREFUSED' ? refused + 1 : 0;
            if (refused >= REFUSED_LIMIT) {
              report('server:lock', new Error(`실시간 서버 주인(pid ${rec.pid}, 포트 ${rec.port})이 살아 있는 것으로 보이지만 ${REFUSED_LIMIT}번 연속 연결을 거부함 - 넘겨받지 않음(server.lock 확인 필요)`));
            }
            return notServing(null);
          }
          refused = 0;
          let reclaimed;
          try {
            reclaimed = reclaimStale(SERVER_LOCK, rec);
          } catch (err) {
            report('server:lock', err);
            return notServing(null);
          }
          if (!reclaimed) {
            const again = await readLock();
            if (again.state === 'held' && again.text === lock.text) {
              report('server:lock', new Error(`죽은 주인(pid ${rec.pid})의 server.lock을 회수하지 못함 - 수동 확인 필요`));
              return notServing(null);
            }
            continue; // another session reclaimed or replaced it first: look again
          }
          preferPort = rec.port;
        } else {
          preferPort = await previousPort();
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
      try {
        const e = entry();
        if (e) await closeEntry(e, true);
      } catch (err) {
        report('server:lock', err);
      }
      markPaused();
    });
  }

  function release() {
    return serial(key, async () => {
      stopCheck();
      try {
        const e = entry();
        if (e && e.driver === self) await closeEntry(e, false);
      } catch (err) {
        report('server:lock', err);
      }
      owner = null;
      refused = 0;
      role = 'idle';
      changed();
    });
  }

  function notifyPublished() {
    const e = entry();
    if (e && e.clients > 0) rebroadcast(e); // never rejects; without a browser there is nobody to tell
  }

  return { ensure, status, onPaused, release, notifyPublished };
}
