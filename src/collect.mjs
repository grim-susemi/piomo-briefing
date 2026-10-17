// omo-briefing src/collect.mjs - read-only auto collection for the render card.
//
// collectAuto({cwd, sessionId, branchEntries, workerIds, metaWorkers,
//   readTaskRecords, readFile, now, cache})
//   -> {work?, todo?, todoItems?, ledgerPath?, workers?}
//   todoItems = {items:[{text, status}] (at most TODO_ITEMS_MAX, newest todo entry, in order), more} - kept beside the
//   counts of `todo` (same strict validation: no todo -> no todoItems). ledgerPath = the boulder work's execution ledger
//   (absolute as written, else resolved against cwd), only when the work names one.
//
// Read-only: only exact file paths via the injected readFile, never directory
// listings, never fs.watch. `.omo/senpi-task/tasks/<id>.json` is read only when
// readTaskRecords is true (the `/brief` command path). Results are cached per
// (cwd, sessionId, readTaskRecords) for 60s in the caller-owned `cache` object.

const CACHE_MS = 60_000;
export const TODO_ITEMS_MAX = 40;
const TERMINAL = new Set(['completed', 'abandoned', 'cancelled']);

function normPath(p) {
  return String(p).replace(/\\/g, '/');
}

function tryReadJson(readFile, path) {
  if (typeof readFile !== 'function') return undefined;
  let raw;
  try {
    raw = readFile(path);
  } catch {
    return undefined; // missing or unreadable -> omit that key
  }
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // broken JSON -> omit that key
  }
}

// Boulder records sessions either bare (`01a13bd0-...`) or prefixed with
// `senpi:` - both sides are normalized before comparing them.
export function normSessionId(id) {
  if (typeof id !== 'string') return '';
  return id.startsWith('senpi:') ? id.slice(6) : id;
}

const WORK_DONE = new Set(['completed', 'done', 'abandoned']);

function workTs(work) {
  for (const k of ['updated_at', 'started_at']) {
    const v = work[k];
    const t = typeof v === 'number' ? v : (typeof v === 'string' ? Date.parse(v) : NaN);
    if (Number.isFinite(t)) return t;
  }
  return -Infinity;
}

// Only a terminal status *string* counts as finished. A boulder status may hold
// any JSON value (e.g. `{"toString":null}`), so it is never coerced here - the
// baseline collector read the same file and returned a summary instead of throwing.
function isDoneWork(work) {
  return typeof work.status === 'string' && WORK_DONE.has(work.status);
}

// negative when `cand` is a better match than `best`: unfinished work first,
// then the most recent timestamp, then the later entry in the file.
function betterWork(cand, candIdx, best, bestIdx) {
  const candDone = isDoneWork(cand) ? 1 : 0;
  const bestDone = isDoneWork(best) ? 1 : 0;
  if (candDone !== bestDone) return candDone - bestDone;
  const candTs = workTs(cand);
  const bestTs = workTs(best);
  if (candTs !== bestTs) return bestTs - candTs;
  return bestIdx - candIdx;
}

// The ledger of the picked work: an absolute path is kept as written, a relative one is joined to the project root (cwd).
function ledgerPathOf(work, base) {
  const l = work && typeof work.ledger === 'string' ? work.ledger : '';
  if (!l) return undefined;
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(l)) return l;
  return base ? `${base}/${normPath(l).replace(/^\.\//, '')}` : undefined;
}

function pickWorkRecord(boulder, sessionId) {
  if (!boulder || typeof boulder !== 'object' || !boulder.works || typeof boulder.works !== 'object') return undefined;
  const want = normSessionId(sessionId);
  if (want === '') return undefined;
  // `works` is keyed by work_id in the real boulder file; the array shape is
  // accepted too because older records were seen written that way.
  const works = Array.isArray(boulder.works) ? boulder.works : Object.values(boulder.works);
  let best;
  let bestIdx = -1;
  for (let i = 0; i < works.length; i++) {
    const work = works[i];
    if (!work || typeof work !== 'object') continue;
    const ids = Array.isArray(work.session_ids) ? work.session_ids : [];
    if (!ids.some((id) => normSessionId(id) === want)) continue;
    if (best === undefined || betterWork(work, i, best, bestIdx) < 0) {
      best = work;
      bestIdx = i;
    }
  }
  return best;
}

function pickWork(best) {
  if (best === undefined) return undefined;
  const done = Array.isArray(best.completed_tasks) ? best.completed_tasks.length
    : (typeof best.completed_tasks === 'number' ? best.completed_tasks : undefined);
  return {
    name: best.plan_name,
    phase: best.phase,
    current: best.current_task,
    done,
    total: best.task_count,
  };
}

export function todoPayload(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const ct = entry.customType;
  if (ct !== 'senpi.todo-state' && !(typeof ct === 'string' && (ct.startsWith('todowrite') || ct === 'todo-list'))) return null;
  // Native session envelope: {type:'custom', customType, data:{schema, phases, ask}, id, parentId, timestamp}
  if (entry.data && typeof entry.data === 'object') return entry.data;
  return entry.payload && typeof entry.payload === 'object' ? entry.payload
    : entry.details && typeof entry.details === 'object' && entry.details.phases ? entry.details
    : entry;
}

const KNOWN_STATUS = new Set(['pending', 'in_progress', 'completed', 'abandoned', 'cancelled']);

function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isValidTask(t) {
  return isPlainObject(t)
    && typeof t.content === 'string' && t.content !== ''
    && typeof t.status === 'string' && KNOWN_STATUS.has(t.status);
}

// Strict whole-entry validation: the newest payload must be fully well-formed.
// Any malformed element -> null (caller omits todo, never partial, never fallback).
export function strictTasks(payload) {
  if (!isPlainObject(payload)) return null;
  if (payload.phases !== undefined) {
    if (!Array.isArray(payload.phases)) return null;
    const out = [];
    for (const ph of payload.phases) {
      if (!isPlainObject(ph) || typeof ph.name !== 'string' || !Array.isArray(ph.tasks)) return null;
      for (const t of ph.tasks) {
        if (!isValidTask(t)) return null;
      }
      out.push(...ph.tasks);
    }
    return out;
  }
  if (payload.todos !== undefined) {
    if (!Array.isArray(payload.todos)) return null;
    for (const t of payload.todos) {
      if (!isValidTask(t)) return null;
    }
    return payload.todos;
  }
  if (payload.tasks !== undefined) {
    if (!Array.isArray(payload.tasks)) return null;
    for (const t of payload.tasks) {
      if (!isValidTask(t)) return null;
    }
    return payload.tasks;
  }
  return null; // no recognizable shape -> omit todo
}

function taskText(t) {
  if (!t || typeof t !== 'object') return '';
  for (const k of ['content', 'text', 'title']) {
    if (typeof t[k] === 'string' && t[k] !== '') return t[k];
  }
  return typeof t.id === 'string' ? t.id : '';
}

function taskStatus(t) {
  if (!t || typeof t !== 'object') return '';
  const s = t.status ?? t.state;
  return typeof s === 'string' ? s : '';
}

function isTodoEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const ct = entry.customType;
  return ct === 'senpi.todo-state' || (typeof ct === 'string' && (ct.startsWith('todowrite') || ct === 'todo-list'));
}

function pickTodo(branchEntries) {
  if (!Array.isArray(branchEntries)) return undefined;
  // The newest matching entry is authoritative: if it is corrupt, omit todo
  // instead of falling back to an older state.
  let latest = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (isTodoEntry(branchEntries[i])) { latest = i; break; }
  }
  if (latest < 0) return undefined;
  try {
    const payload = todoPayload(branchEntries[latest]);
    if (!payload) return undefined;
    const tasks = strictTasks(payload);
    if (!tasks) return undefined; // broken shape -> omit todo
    if (tasks.length === 0) return undefined;
    const current = tasks.find((t) => taskStatus(t) === 'in_progress');
    const after = current ? tasks.slice(tasks.indexOf(current) + 1) : [];
    const next = after.find((t) => taskStatus(t) === 'pending');
    const done = tasks.filter((t) => TERMINAL.has(taskStatus(t))).length;
    const todo = { current: current ? taskText(current) : undefined, next: next ? taskText(next) : undefined, done, total: tasks.length };
    if (todo.current === undefined) delete todo.current;
    if (todo.next === undefined) delete todo.next;
    const items = tasks.slice(0, TODO_ITEMS_MAX).map((t) => ({ text: taskText(t), status: taskStatus(t) }));
    return { todo, items: { items, more: Math.max(0, tasks.length - TODO_ITEMS_MAX) } };
  } catch {
    return undefined; // malformed input omits only the todo key
  }
}

function bucket(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'running' || s === 'started' || s === 'in_progress') return 'running';
  if (s === 'completed' || s === 'done' || s === 'success') return 'completed';
  if (s === 'error' || s === 'failed' || s === 'timeout') return 'error';
  return 'other';
}

function countWorkers(statuses) {
  const workers = { running: 0, completed: 0, error: 0, other: 0 };
  for (const s of statuses) workers[bucket(s)]++;
  return workers;
}

function workerIdList(workerIds) {
  if (!Array.isArray(workerIds)) return [];
  return workerIds.map((w) => (typeof w === 'string' ? w : w && w.id)).filter((id) => typeof id === 'string' && id !== '');
}

function metaStatuses(metaWorkers) {
  if (Array.isArray(metaWorkers)) {
    return metaWorkers.map((w) => (w && typeof w === 'object' ? w.status : w)).filter((s) => s !== undefined);
  }
  if (metaWorkers && typeof metaWorkers === 'object') return Object.values(metaWorkers);
  return null;
}

export function collectAuto(opts = {}) {
  const {
    cwd, sessionId, branchEntries = [], workerIds = [], metaWorkers,
    readTaskRecords = false, readFile, now = Date.now(), cache = {},
  } = opts;

  const key = JSON.stringify({ cwd, sessionId, readTaskRecords });
  if (cache && cache.key === key && typeof cache.at === 'number' && now - cache.at < CACHE_MS && cache.value) {
    return cache.value;
  }

  const out = {};
  const base = normPath(cwd ?? '').replace(/\/$/, '');

  const boulder = tryReadJson(readFile, `${base}/.omo/boulder.json`);
  const record = pickWorkRecord(boulder, sessionId);
  const work = pickWork(record);
  if (work) out.work = work;
  const ledgerPath = ledgerPathOf(record, base);
  if (ledgerPath) out.ledgerPath = ledgerPath;

  const picked = pickTodo(branchEntries);
  if (picked) {
    out.todo = picked.todo;
    out.todoItems = picked.items;
  }

  const ids = workerIdList(workerIds);
  if (readTaskRecords === true && ids.length > 0) {
    const statuses = [];
    for (const id of ids) {
      // Only this session's worker files, never a directory scan.
      const rec = tryReadJson(readFile, `${base}/.omo/senpi-task/tasks/${id}.json`);
      if (rec && rec.status !== undefined) statuses.push(rec.status);
    }
    if (statuses.length > 0) out.workers = countWorkers(statuses);
  } else {
    const fromMeta = metaStatuses(metaWorkers);
    if (fromMeta && fromMeta.length > 0) out.workers = countWorkers(fromMeta);
  }

  if (cache && typeof cache === 'object') {
    cache.key = key;
    cache.sessionId = sessionId;
    cache.at = now;
    cache.value = out;
  }
  return out;
}
