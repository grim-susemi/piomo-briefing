// omo-briefing src/collect.mjs - read-only auto collection for the render card.
//
// collectAuto({cwd, sessionId, branchEntries, workerIds, metaWorkers,
//   readTaskRecords, readFile, now, cache})
//   -> {work?, todo?, workers?}
//
// Read-only: only exact file paths via the injected readFile, never directory
// listings, never fs.watch. `.omo/senpi-task/tasks/<id>.json` is read only when
// readTaskRecords is true (the `/brief` command path). Results are cached per
// (cwd, sessionId, readTaskRecords) for 60s in the caller-owned `cache` object.

const CACHE_MS = 60_000;
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

function pickWork(boulder, sessionId) {
  if (!boulder || typeof boulder !== 'object' || !boulder.works || typeof boulder.works !== 'object') return undefined;
  for (const work of Object.values(boulder.works)) {
    if (!work || typeof work !== 'object') continue;
    const ids = Array.isArray(work.session_ids) ? work.session_ids : [];
    if (!ids.includes(sessionId)) continue;
    const done = Array.isArray(work.completed_tasks) ? work.completed_tasks.length
      : (typeof work.completed_tasks === 'number' ? work.completed_tasks : undefined);
    return {
      name: work.plan_name,
      phase: work.phase,
      current: work.current_task,
      done,
      total: work.task_count,
    };
  }
  return undefined;
}

function todoPayload(entry) {
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
function strictTasks(payload) {
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
    return todo;
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
  const work = pickWork(boulder, sessionId);
  if (work) out.work = work;

  const todo = pickTodo(branchEntries);
  if (todo) out.todo = todo;

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
