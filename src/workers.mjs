import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normSessionId, todoPayload, strictTasks } from './collect.mjs';

const WINDOW_BYTES = 256 * 1024;
const READ_INTERVAL = 2000;
const STALE_MS = 10 * 60 * 1000;
const TERMINAL = new Set(['done', 'error', 'cancelled', 'lost']);
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);
const STATES = {
  running: 'running', started: 'running', in_progress: 'running',
  pending: 'waiting', queued: 'waiting', waiting: 'waiting',
  completed: 'done', done: 'done', success: 'done',
  error: 'error', failed: 'error', timeout: 'error',
  cancelled: 'cancelled', interrupted: 'cancelled', lost: 'lost',
};
const taskId = (id) => typeof id === 'string' && /^st_[A-Za-z0-9_-]{1,253}$/.test(id);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : undefined;
const timestamp = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
const errorInfo = (error) => ({ code: typeof error?.code === 'string' ? error.code : 'WORKER_READ',
  message: text(error?.message) ?? 'Worker data could not be read' });

// An array is always returned. Malformed input has length 0 and an .error
// object; consumers must inspect it before applying the array. No payloads or
// unselected/private fields are retained, and no I/O occurs in this boundary.
export function normalizeTaskSnapshot(data, sessionId) {
  try {
    const parent = normSessionId(data?.parent_session_id);
    const own = normSessionId(sessionId);
    if (!parent || !own || !Array.isArray(data?.tasks)) throw new Error('Invalid worker snapshot');
    if (parent !== own) return [];
    const out = [];
    for (const raw of data.tasks.slice(0, 256)) {
      if (raw?.parent_session_id !== undefined && normSessionId(raw.parent_session_id) !== own) continue;
      if (!raw || !taskId(raw.task_id)) throw new Error('Invalid worker task id');
      const status = typeof raw.status === 'string' ? raw.status : '';
      const state = Object.hasOwn(STATES, status) ? STATES[status] : 'waiting';
      const live = raw.live_progress;
      const updatedAt = timestamp(raw.updated_at);
      out.push({
        id: raw.task_id,
        name: text(raw.task_summary) ?? text(raw.description) ?? text(raw.name) ?? text(raw.task_id),
        kind: text(raw.agent_type) ?? text(raw.category) ?? '',
        model: text(raw.resolved_model?.display) ?? text(raw.resolved_model?.model_id) ?? text(raw.model_id) ?? text(raw.model) ?? '',
        state,
        step: TERMINAL.has(state) ? '' : text(live?.current_tool) ?? text(live?.last_assistant_line) ?? '',
        startedAt: timestamp(live?.started_at) ?? timestamp(raw.created_at),
        endedAt: timestamp(raw.terminal_at) ?? (TERMINAL.has(state) ? updatedAt : undefined),
        updatedAt,
        childSessionId: typeof raw.child_session_id === 'string' ? raw.child_session_id : undefined,
      });
    }
    return out;
  } catch (error) {
    const out = [];
    out.error = { code: 'INVALID_SNAPSHOT', message: text(error?.message) ?? 'Invalid worker snapshot' };
    return out;
  }
}

function todoSummary(tasks) {
  if (!tasks?.length) return null;
  return {
    items: tasks.slice(0, 30).map((task) => ({ text: text(task.content) ?? '', status: task.status })),
    more: Math.max(0, tasks.length - 30),
    done: tasks.filter((task) => ['completed', 'abandoned', 'cancelled'].includes(task.status)).length,
    total: tasks.length,
  };
}

function sessionTarget(cwd, worker) {
  if (!taskId(worker?.id)) throw Object.assign(new Error('Invalid worker id'), { code: 'INVALID_WORKER' });
  const directory = path.resolve(cwd, '.omo', 'senpi-task', 'children', worker.id, 'sessions', worker.id);
  const child = normSessionId(worker.childSessionId);
  if (!child) return { directory };
  // Native child_session_id is the UUID in the filename, NOT a directory:
  // manager/runner.ts and runners/rpc/spawn.ts always nest sessions/<taskId>/.
  if (/^[A-Za-z0-9_-]{1,256}$/.test(child)) return { directory, sessionId: child };
  const file = path.resolve(child);
  if (!path.isAbsolute(child) || path.dirname(file) !== directory || !file.endsWith('.jsonl')) {
    throw Object.assign(new Error('Child session is outside its worker folder'), { code: 'INVALID_CHILD_SESSION' });
  }
  return { directory, file };
}

// fs is the node:fs/promises shape (readdir/stat/open; FileHandle.read/close).
// sleep is injectable so retry tests do not depend on wall-clock luck. Read
// errors preserve the last committed value, byte cursor and incomplete suffix.
export function createChildTodoReader({ fs = nodeFs, now = Date.now, sleep = delay, onError, onRecover } = {}) {
  const workers = new Map();

  async function readOnce(target, previous) {
    let file = target.file;
    let stat;
    try {
      if (!file) {
        const names = await fs.readdir(target.directory, { withFileTypes: true });
        let newest;
        for (const entry of names) {
          const name = typeof entry === 'string' ? entry : entry.name;
          if (typeof name !== 'string' || path.basename(name) !== name || !name.endsWith('.jsonl') ||
              (typeof entry !== 'string' && !entry.isFile())) continue;
          if (target.sessionId && name !== target.sessionId + '.jsonl' && !name.endsWith('_' + target.sessionId + '.jsonl')) continue;
          const candidate = path.join(target.directory, name);
          const info = await fs.stat(candidate);
          if (!newest || info.mtimeMs > newest.stat.mtimeMs ||
              (info.mtimeMs === newest.stat.mtimeMs && name > path.basename(newest.file))) {
            newest = { file: candidate, stat: info };
          }
        }
        if (!newest) return { ...previous, value: previous.value };
        ({ file, stat } = newest);
      } else stat = await fs.stat(file);
    } catch (error) {
      if (error.code === 'ENOENT') return { ...previous, value: previous.value };
      throw error;
    }
    const fresh = file !== previous.file || stat.size < previous.cursor;
    const start = fresh ? Math.max(0, stat.size - WINDOW_BYTES) : previous.cursor;
    const length = stat.size - start;
    if (length === 0) return { file, cursor: stat.size, tail: fresh ? Buffer.alloc(0) : previous.tail,
      discardFirst: fresh ? false : previous.discardFirst, value: fresh ? null : previous.value };
    const bytes = Buffer.alloc(length);
    const handle = await fs.open(file, 'r');
    try {
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset);
        if (!bytesRead) throw Object.assign(new Error('Child session changed during read'), { code: 'SHORT_READ' });
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
    let data = fresh ? bytes : Buffer.concat([previous.tail, bytes]);
    let discardFirst = fresh ? start > 0 : previous.discardFirst;
    if (discardFirst) {
      const boundary = data.indexOf(10);
      if (boundary < 0) return { file, cursor: stat.size, tail: Buffer.alloc(0), discardFirst: true, value: fresh ? null : previous.value };
      // At an arbitrary tail-window boundary the first record is unusable;
      // discard it without an extra read beyond the 256KB budget.
      data = data.subarray(boundary + 1);
      discardFirst = false;
    }
    const lastNewline = data.lastIndexOf(10);
    let value = fresh ? null : previous.value;
    if (lastNewline >= 0) {
      const lines = data.subarray(0, lastNewline).toString('utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        // A complete line that is not JSON (a record torn by a crashed writer
        // and joined to the next append) fails on every re-read, so it is
        // dropped like a truncated line instead of pinning the cursor forever.
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.customType !== 'senpi.todo-state') continue;
        value = todoSummary(strictTasks(todoPayload(entry)));
      }
    }
    return { file, cursor: stat.size, tail: Buffer.from(data.subarray(lastNewline + 1)), discardFirst, value };
  }

  return {
    async read(cwd, worker) {
      let target;
      try { target = sessionTarget(cwd, worker); }
      catch (error) { return { error: errorInfo(error) }; }
      const key = path.resolve(cwd) + '\n' + worker.id;
      let state = workers.get(key);
      if (!state) {
        state = { file: undefined, cursor: 0, tail: Buffer.alloc(0), discardFirst: false,
          value: null, result: null, lastRead: -Infinity, failures: 0, pending: null };
        workers.set(key, state);
      }
      if (state.pending) return state.pending;
      const at = now();
      if (at - state.lastRead < READ_INTERVAL) return state.result;
      state.lastRead = at;
      state.pending = (async () => {
        try {
          let next;
          for (let attempt = 0; attempt < 5; attempt++) {
            try { next = await readOnce(target, state); break; }
            catch (error) {
              if (!RETRYABLE.has(error.code) || attempt === 4) throw error;
              await sleep(20 * 2 ** attempt);
            }
          }
          Object.assign(state, next, { failures: 0, result: next.value });
          onRecover?.('workers:' + worker.id);
          return state.result;
        } catch (error) {
          state.failures++;
          state.result = { error: errorInfo(error), previous: state.value };
          if (state.failures >= 2) onError?.('workers:' + worker.id, error);
          return state.result;
        } finally {
          state.pending = null;
        }
      })();
      return state.pending;
    },
  };
}

function boundedTodo(todo) {
  if (!todo || !Array.isArray(todo.items)) return null;
  const items = todo.items.slice(0, 30).map((item) => ({ text: text(item.text) ?? '', status: text(item.status) ?? 'pending' }));
  const total = Math.max(todo.items.length, Number.isSafeInteger(todo.total) ? todo.total : todo.items.length);
  return { items, total, more: Math.max(0, total - items.length),
    done: Math.max(0, Math.min(total, Number.isSafeInteger(todo.done) ? todo.done : 0)) };
}

// changed() consumes {changed, kind}; status has priority over todo, then step.
// Todo-only updates ({id, todo}) do not need a new RPC timestamp. Snapshot
// updates with an existing endpoint require a strictly newer updatedAt.
export function createWorkerBook({ now = Date.now } = {}) {
  const entries = new Map();
  const changes = new Set();
  const priority = ['status', 'todo', 'step'];
  function mark(kind) { changes.add(kind); }
  function stale(entry) {
    const at = Date.parse(entry.worker.updatedAt ?? entry.worker.startedAt);
    const value = !TERMINAL.has(entry.worker.state) && Number.isFinite(at) && now() - at >= STALE_MS;
    if (entry.stale !== value) { entry.stale = value; mark('status'); }
  }
  function list() {
    for (const entry of entries.values()) stale(entry);
    return [...entries.values()].sort((a, b) => Number(TERMINAL.has(a.worker.state)) - Number(TERMINAL.has(b.worker.state)))
      .slice(0, 20).map((entry) => ({ ...entry.worker, stale: entry.stale,
        ...(entry.stale ? { step: '\uc751\ub2f5 \uc5c6\uc74c 10\ubd84' } : {}),
        ...(entry.worker.todo !== undefined ? { todo: boundedTodo(entry.worker.todo) } : {}) }));
  }
  return {
    apply(updates) {
      for (const update of updates) {
        if (!taskId(update?.id)) continue;
        const previous = entries.get(update.id);
        const before = previous?.worker;
        const updatedAt = timestamp(update.updatedAt);
        const todoOnly = Object.keys(update).every((key) => key === 'id' || key === 'todo');
        if (before && !todoOnly && before.updatedAt && (!updatedAt || updatedAt <= before.updatedAt)) continue;
        if (before && TERMINAL.has(before.state) && update.state && !TERMINAL.has(update.state)) continue;
        const worker = { ...before, id: update.id };
        for (const key of ['name', 'kind', 'model', 'step']) {
          if (typeof update[key] === 'string') worker[key] = text(update[key]) ?? '';
        }
        worker.state = before && TERMINAL.has(before.state) ? before.state :
          (['running', 'waiting', ...TERMINAL].includes(update.state) ? update.state : before?.state ?? 'waiting');
        for (const key of ['startedAt', 'endedAt', 'updatedAt']) {
          const value = timestamp(update[key]);
          if (value && !(key === 'endedAt' && before?.endedAt)) worker[key] = value;
        }
        if (typeof update.childSessionId === 'string') worker.childSessionId = update.childSessionId;
        if (Object.hasOwn(update, 'todo')) worker.todo = boundedTodo(update.todo);
        if (!before || ['state', 'name', 'kind', 'model', 'startedAt', 'endedAt', 'childSessionId'].some((key) => before[key] !== worker[key])) mark('status');
        if (JSON.stringify(before?.todo) !== JSON.stringify(worker.todo)) mark('todo');
        if (before && before.step !== worker.step) mark('step');
        const entry = { worker, stale: previous?.stale ?? false };
        stale(entry);
        entries.set(update.id, entry);
      }
      return changes.size > 0;
    },
    list,
    changed() {
      for (const entry of entries.values()) stale(entry);
      const kind = priority.find((kind) => changes.has(kind)) ?? null;
      changes.clear();
      return { changed: kind !== null, kind };
    },
  };
}
