import * as nodeFs from 'node:fs/promises';
import { normalizeTaskSnapshot, createChildTodoReader, createWorkerBook } from './workers.mjs';

const TICK_MS = 2000;
const STATUS_TODO_MIN_MS = 2000;
const STEP_MIN_MS = 5000;
const RECENT_TERMINAL = 3;
const TERMINAL = new Set(['done', 'error', 'cancelled', 'lost']);
const RANK = { step: 1, todo: 2, status: 3 };
const WAITING_LINE = '\uc815\ubcf4 \ub300\uae30';

const keep = (value, max = 256) => (typeof value === 'string' ? value.slice(0, max)
  : typeof value === 'number' && Number.isFinite(value) ? value : undefined);
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
}
// Copies only the fields normalizeTaskSnapshot reads; used for a snapshot that
// arrives before the session id is known, so no payload is retained.
function trimSnapshot(data) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks.slice(0, 256).map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    return compact({
      task_id: keep(raw.task_id), parent_session_id: keep(raw.parent_session_id), status: keep(raw.status),
      task_summary: keep(raw.task_summary), description: keep(raw.description), name: keep(raw.name),
      agent_type: keep(raw.agent_type), category: keep(raw.category), model_id: keep(raw.model_id),
      model: keep(raw.model), created_at: keep(raw.created_at), updated_at: keep(raw.updated_at),
      terminal_at: keep(raw.terminal_at), child_session_id: keep(raw.child_session_id, 1024),
      resolved_model: raw.resolved_model && typeof raw.resolved_model === 'object'
        ? compact({ display: keep(raw.resolved_model.display), model_id: keep(raw.resolved_model.model_id) }) : undefined,
      live_progress: raw.live_progress && typeof raw.live_progress === 'object'
        ? compact({ current_tool: keep(raw.live_progress.current_tool),
          last_assistant_line: keep(raw.live_progress.last_assistant_line),
          started_at: keep(raw.live_progress.started_at) }) : undefined,
    });
  }) : data?.tasks;
  return { parent_session_id: keep(data?.parent_session_id), tasks };
}

function namesFor(ids, names) {
  const at = (id, index) => {
    if (Array.isArray(names)) return names[index];
    if (names instanceof Map) return names.get(id);
    if (names && typeof names === 'object') return names[id];
    return undefined;
  };
  return ids.map((id, index) => ({ id, name: at(id, index) }));
}

// Live worker state for one lead session. Contract:
// - onRpcEvent is synchronous, copies only needed fields, does no I/O, never
//   throws, and defers every onError/onRecover call out of the bus emit.
// - timers = {setInterval, clearInterval, setTimeout, clearTimeout}; every
//   handle is unref'd and stop() leaves none behind.
// - Pause (isEnabled() false) keeps memory current but performs no fs read,
//   saveLive, softPublish, onError or onRecover; the changes stay pending and
//   are published once enabled again.
// - Publish rate: status/todo changes at most every 2s, step-only changes at
//   most every 5s (one leading publish, then a trailing one).
export function createWorkersLive({
  sessionId, cwd, isEnabled = () => true, softPublish = () => {}, saveLive = () => {},
  onError = () => {}, onRecover = () => {}, fs = nodeFs, now = Date.now, sleep,
  timers = { setInterval, clearInterval, setTimeout, clearTimeout },
} = {}) {
  const reported = new Set();
  const book = createWorkerBook({ now });
  const ownerId = () => (typeof sessionId === 'function' ? sessionId() : sessionId);
  let knownId = typeof sessionId === 'string' ? sessionId : undefined;
  let pendingSnapshot = null;
  let started = false;
  let stopped = false;
  let interval = null;
  let flushTimer = null;
  let flushDue = Infinity;
  const deferred = new Map();
  let ticking = false;
  let flushing = false;
  let pendingKind = null;
  let lastFlushAt = null;
  const lastReadAt = new Map();
  const finalDone = new Set();
  const appliedTodo = new Map();
  const invalid = new Set();

  const enabled = () => {
    try { return Boolean(isEnabled()); } catch { return false; } // unreadable pause state means off
  };
  const unref = (handle) => { if (typeof handle?.unref === 'function') handle.unref(); return handle; };
  const warn = (error) => process.emitWarning(error instanceof Error ? error : new Error(String(error)));
  function emit(kind, key, error) {
    if (!enabled()) return;
    try {
      if (kind === 'error') { reported.add(key); onError(key, error); }
      else if (reported.delete(key)) onRecover(key);
    } catch (hookError) { warn(hookError); }
  }
  function later(fn) {
    const handle = unref(timers.setTimeout(() => { deferred.delete(handle); fn(); }, 0));
    deferred.set(handle, fn);
  }
  function resolveId() {
    if (knownId) return knownId;
    try { const id = ownerId(); if (typeof id === 'string' && id) knownId = id; } catch (error) { warn(error); }
    return knownId;
  }
  function absorb() {
    const { changed, kind } = book.changed();
    if (changed && (!pendingKind || RANK[kind] > RANK[pendingKind])) pendingKind = kind;
  }

  function ingest(data) {
    const rows = normalizeTaskSnapshot(data, knownId);
    if (rows.error) { emit('error', 'workers:snapshot', Object.assign(new Error(rows.error.message), { code: rows.error.code })); return; }
    emit('recover', 'workers:snapshot');
    if (rows.length) book.apply(rows);
    absorb();
  }
  function drain() {
    if (!pendingSnapshot || !resolveId()) return;
    const data = pendingSnapshot;
    pendingSnapshot = null;
    try { ingest(data); } catch (error) { emit('error', 'workers:snapshot', error); }
  }

  function targets() {
    const rows = book.list();
    const recent = rows.filter((row) => TERMINAL.has(row.state))
      .sort((a, b) => String(b.endedAt ?? b.updatedAt ?? '').localeCompare(String(a.endedAt ?? a.updatedAt ?? '')))
      .slice(0, RECENT_TERMINAL).filter((row) => !finalDone.has(row.id));
    return [...rows.filter((row) => !TERMINAL.has(row.state)), ...recent];
  }
  function needsTimer() {
    return started && !stopped && (pendingSnapshot !== null || pendingKind !== null || targets().length > 0);
  }
  function syncTimer() {
    if (needsTimer()) {
      if (!interval) interval = unref(timers.setInterval(() => { tick(); }, TICK_MS));
    } else if (interval) { timers.clearInterval(interval); interval = null; }
  }

  function schedule() {
    if (stopped || pendingKind === null) return;
    const min = pendingKind === 'step' ? STEP_MIN_MS : STATUS_TODO_MIN_MS;
    const due = lastFlushAt === null ? 0 : lastFlushAt + min - now();
    const delay = Math.max(0, due);
    const at = now() + delay;
    if (flushTimer && flushDue <= at) return;
    if (flushTimer) timers.clearTimeout(flushTimer);
    flushDue = at;
    flushTimer = unref(timers.setTimeout(() => { flushTimer = null; flushDue = Infinity; flush(); }, delay));
  }
  async function flush() {
    if (stopped || flushing || pendingKind === null || !enabled()) return;
    const min = pendingKind === 'step' ? STEP_MIN_MS : STATUS_TODO_MIN_MS;
    if (lastFlushAt !== null && now() - lastFlushAt < min) { schedule(); return; }
    flushing = true;
    lastFlushAt = now();
    const kind = pendingKind;
    pendingKind = null;
    let saved = true;
    try {
      await saveLive(book.list());
      emit('recover', 'workers:save');
    } catch (error) {
      saved = false;
      emit('error', 'workers:save', error);
    }
    try {
      await softPublish();
      emit('recover', 'workers:publish');
    } catch (error) { emit('error', 'workers:publish', error); }
    flushing = false;
    // A failed save is retried at the normal rate; the error chip is published above.
    if (!saved && (!pendingKind || RANK[kind] > RANK[pendingKind])) pendingKind = kind;
    if (!stopped) { schedule(); syncTimer(); }
  }

  async function readTodos() {
    const updates = [];
    for (const worker of targets()) {
      if (stopped) return updates;
      const last = lastReadAt.get(worker.id);
      // The reader throttles per worker at 2s; never call it early, so a
      // final post-terminal read can never be answered from a stale cache.
      if (last !== undefined && now() - last < TICK_MS) continue;
      lastReadAt.set(worker.id, now());
      const key = 'workers:' + worker.id;
      const result = await reader.read(cwd, worker);
      if (stopped) return updates;
      if (result?.error) {
        if (/^INVALID_/.test(result.error.code) && !invalid.has(worker.id)) {
          invalid.add(worker.id);
          emit('error', key, Object.assign(new Error(result.error.message), { code: result.error.code }));
        }
        continue;
      }
      invalid.delete(worker.id);
      if (TERMINAL.has(worker.state)) finalDone.add(worker.id);
      const json = JSON.stringify(result);
      if (!appliedTodo.has(worker.id) && result === null) { appliedTodo.set(worker.id, json); continue; }
      if (appliedTodo.get(worker.id) === json) continue;
      appliedTodo.set(worker.id, json);
      updates.push({ id: worker.id, todo: result });
    }
    return updates;
  }
  async function tick() {
    if (stopped || ticking || !enabled()) return;
    ticking = true;
    try {
      drain();
      const updates = await readTodos();
      if (stopped) return;
      if (updates.length) book.apply(updates);
      absorb();
      schedule();
    } catch (error) {
      emit('error', 'workers:tick', error);
    } finally {
      ticking = false;
      if (!stopped) syncTimer();
    }
  }

  const reader = createChildTodoReader({
    fs, now, ...(sleep ? { sleep } : {}),
    onError: (key, error) => emit('error', key, error),
    onRecover: (key) => emit('recover', key),
  });

  return {
    onRpcEvent(event) {
      try {
        if (stopped || event?.name !== 'omo.task.updated') return;
        if (!resolveId()) { pendingSnapshot = trimSnapshot(event.data); }
        else {
          pendingSnapshot = null;
          const rows = normalizeTaskSnapshot(event.data, knownId);
          if (rows.error) {
            later(() => emit('error', 'workers:snapshot', Object.assign(new Error(rows.error.message), { code: rows.error.code })));
          } else {
            if (reported.has('workers:snapshot')) later(() => emit('recover', 'workers:snapshot'));
            if (rows.length) book.apply(rows);
            absorb();
          }
        }
        schedule();
        syncTimer();
      } catch (error) {
        later(() => emit('error', 'workers:snapshot', error));
      }
    },
    noteTaskIds(ids, names) {
      try {
        if (stopped || !Array.isArray(ids)) return;
        const known = new Set(book.list().map((row) => row.id));
        const fresh = namesFor(ids, names).filter(({ id }) => !known.has(id)).map(({ id, name }) =>
          ({ id, ...(typeof name === 'string' && name.trim() ? { name } : {}), state: 'waiting', step: WAITING_LINE }));
        if (fresh.length) book.apply(fresh);
        absorb();
        schedule();
        syncTimer();
      } catch (error) {
        later(() => emit('error', 'workers:notes', error));
      }
    },
    setSessionId(id) { if (typeof id === 'string' && id) { knownId = id; drain(); schedule(); syncTimer(); } },
    start() {
      stopped = false;
      started = true;
      drain();
      schedule();
      syncTimer();
    },
    stop() {
      stopped = true;
      started = false;
      if (interval) { timers.clearInterval(interval); interval = null; }
      if (flushTimer) { timers.clearTimeout(flushTimer); flushTimer = null; flushDue = Infinity; }
      const queued = [...deferred];
      deferred.clear();
      for (const [handle, fn] of queued) { timers.clearTimeout(handle); fn(); }
      pendingKind = null;
    },
  };
}
