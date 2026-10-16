import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkersLive } from '../src/workers-live.mjs';

const NOW0 = Date.parse('2026-10-15T12:01:00.000Z');
const ROOT = path.join(tmpdir(), 'briefing-workers-live-virtual');
const LEAD = 'lead-session';
const iso = (ms) => new Date(ms).toISOString();
const todoLine = (todos) => JSON.stringify({ type: 'custom', customType: 'senpi.todo-state', data: { todos } }) + '\n';
const todo = (content, status = 'pending') => ({ content, status });
const childDir = (id) => path.join(ROOT, '.omo', 'senpi-task', 'children', id, 'sessions', id);
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Injected clock and timers: advance() runs due timers in order and drains the
// promise queue after each, so no test waits on wall-clock time.
function fakeClock() {
  let at = NOW0;
  let seq = 0;
  const live = new Map();
  const make = (repeat) => (fn, ms) => {
    const handle = { id: ++seq, unref() { return handle; } };
    live.set(handle, { fn, due: at + ms, repeat: repeat ? ms : 0 });
    return handle;
  };
  return {
    now: () => at,
    timers: {
      setTimeout: make(false), setInterval: make(true),
      clearTimeout: (h) => { live.delete(h); }, clearInterval: (h) => { live.delete(h); },
    },
    active: () => live.size,
    async advance(ms) {
      const end = at + ms;
      for (;;) {
        let next;
        for (const [handle, timer] of live) if (timer.due <= end && (!next || timer.due < next[1].due)) next = [handle, timer];
        if (!next) break;
        const [handle, timer] = next;
        at = Math.max(at, timer.due);
        if (timer.repeat) timer.due += timer.repeat; else live.delete(handle);
        timer.fn();
        await settle();
      }
      at = end;
      await settle();
    },
  };
}

function virtualFs() {
  const files = new Map();
  const calls = [];
  let failures = [];
  const fault = (operation) => {
    if (operation === 'open' && failures.length) throw Object.assign(new Error('Injected ' + failures[0]), { code: failures.shift() });
  };
  const missing = (p) => Object.assign(new Error('ENOENT ' + p), { code: 'ENOENT' });
  return {
    calls, files,
    set(file, text) { files.set(file, Buffer.from(text)); },
    append(file, text) { files.set(file, Buffer.concat([files.get(file) ?? Buffer.alloc(0), Buffer.from(text)])); },
    fail(codes) { failures = [...codes]; },
    fs: {
      async readdir(dir) {
        calls.push({ op: 'readdir', path: dir });
        const names = [...files.keys()].filter((f) => path.dirname(f) === dir).map((f) => ({ name: path.basename(f), isFile: () => true }));
        if (!names.length) throw missing(dir);
        return names;
      },
      async stat(p) {
        calls.push({ op: 'stat', path: p });
        if (!files.has(p)) throw missing(p);
        return { size: files.get(p).length, mtimeMs: NOW0 };
      },
      async open(p) {
        calls.push({ op: 'open', path: p }); fault('open');
        return {
          async read(buffer, offset, length, position) {
            calls.push({ op: 'read', path: p, length, position });
            const n = files.get(p).copy(buffer, offset, position, position + length);
            return { bytesRead: n, buffer };
          },
          async close() { calls.push({ op: 'close', path: p }); },
        };
      },
    },
  };
}

function task(id, extra = {}) {
  return { task_id: id, parent_session_id: LEAD, task_summary: id + ' summary', status: 'running',
    created_at: iso(NOW0), updated_at: iso(NOW0), child_session_id: 'child-' + id, ...extra };
}
const snapshot = (tasks, parent = LEAD) => ({ name: 'omo.task.updated', data: { parent_session_id: parent, tasks } });

function setup(options = {}) {
  const clock = fakeClock();
  const disk = virtualFs();
  const log = { saves: [], publishes: 0, errors: [], recovers: [] };
  const state = { enabled: true };
  const hooks = {
    saveLive: options.saveLive ?? ((list) => { log.saves.push(list); }),
    softPublish: options.softPublish ?? (() => { log.publishes++; }),
    onError: (key, error) => log.errors.push({ key, code: error?.code }),
    onRecover: (key) => log.recovers.push(key),
  };
  const live = createWorkersLive({
    sessionId: options.sessionId === undefined ? LEAD : options.sessionId, cwd: ROOT, isEnabled: () => state.enabled,
    fs: disk.fs, now: clock.now, timers: clock.timers, sleep: async () => {}, ...hooks,
  });
  return { clock, disk, log, state, live };
}
const lastSaved = (env) => env.log.saves.at(-1);
const row = (env, id) => lastSaved(env)?.find((worker) => worker.id === id);
const childFile = (id) => path.join(childDir(id), '2026-10-15T12-00-00_child-' + id + '.jsonl');

test('one snapshot event saves the list and soft-publishes once within 2 seconds', async () => {
  const env = setup();
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_a', { live_progress: { current_tool: 'read' } })]));
  assert.equal(env.log.saves.length, 0, 'handler itself performs no save');
  await env.clock.advance(2000);
  assert.equal(env.log.saves.length, 1);
  assert.equal(env.log.publishes, 1);
  assert.deepEqual([row(env, 'st_a').state, row(env, 'st_a').step, row(env, 'st_a').name], ['running', 'read', 'st_a summary']);
  env.live.stop();
});

test('ten status events in quick succession publish at most twice (2s cap)', async () => {
  const env = setup();
  env.live.start();
  const states = ['waiting', 'running'];
  for (let i = 0; i < 10; i++) {
    env.live.onRpcEvent(snapshot([task('st_a', { status: states[i % 2], updated_at: iso(NOW0 + i + 1) })]));
    await env.clock.advance(100);
  }
  await env.clock.advance(1000);
  assert.ok(env.log.publishes <= 2, 'published ' + env.log.publishes);
  assert.equal(env.log.publishes, 2, 'leading publish plus one trailing publish');
  assert.equal(env.log.saves.length, env.log.publishes);
  env.live.stop();
});

test('twenty step-only events over ten seconds publish at most three times (5s cap)', async () => {
  const env = setup();
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_a')]));
  await env.clock.advance(10);
  const first = env.log.publishes;
  assert.equal(first, 1);
  for (let i = 0; i < 20; i++) {
    env.live.onRpcEvent(snapshot([task('st_a', { updated_at: iso(NOW0 + 1000 + i), live_progress: { current_tool: 'tool-' + i } })]));
    await env.clock.advance(500);
  }
  await env.clock.advance(100);
  assert.ok(env.log.publishes <= 3, 'published ' + env.log.publishes);
  assert.ok(env.log.publishes >= 2, 'a trailing publish still shows the latest step');
  assert.equal(row(env, 'st_a').step, 'tool-19');
  env.live.stop();
});

test('events for another session are ignored: no save, publish, or rows', async () => {
  const env = setup();
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_x')], 'some-other-parent'));
  env.live.onRpcEvent({ name: 'omo.task.other', data: {} });
  env.live.onRpcEvent(null);
  await env.clock.advance(20000);
  assert.deepEqual([env.log.saves.length, env.log.publishes, env.disk.calls.length, env.log.errors.length], [0, 0, 0, 0]);
  assert.equal(env.clock.active(), 0, 'nothing to watch means no timers');
  env.live.stop();
});

test('malformed data never throws, reports workers:snapshot outside the handler, and recovers on a valid snapshot', async () => {
  const env = setup();
  env.live.start();
  const hostile = Object.defineProperty({ name: 'omo.task.updated' }, 'data', { get() { throw new Error('getter'); } });
  for (const event of [{ name: 'omo.task.updated', data: { parent_session_id: LEAD, tasks: 'nope' } },
    { name: 'omo.task.updated', data: { parent_session_id: LEAD, tasks: [{ task_id: '../bad' }] } }, hostile]) {
    assert.doesNotThrow(() => env.live.onRpcEvent(event));
  }
  assert.equal(env.log.errors.length, 0, 'onError is never called from inside the bus handler');
  await env.clock.advance(10);
  assert.ok(env.log.errors.length >= 1);
  assert.ok(env.log.errors.every((entry) => entry.key === 'workers:snapshot'));
  env.live.onRpcEvent(snapshot([task('st_a')]));
  await env.clock.advance(10);
  assert.deepEqual(env.log.recovers, ['workers:snapshot']);
  env.live.stop();
});

test('a 256-task snapshot handler stays I/O-free and callback-free', () => {
  const env = setup();
  env.live.start();
  const tasks = Array.from({ length: 256 }, (_, i) => task('st_perf' + i));
  env.live.onRpcEvent(snapshot(tasks));
  assert.deepEqual([env.disk.calls.length, env.log.saves.length, env.log.publishes, env.log.errors.length], [0, 0, 0, 0]);
  env.live.stop();
});

test('noteTaskIds shows a waiting line with the given name, never touches tasks/, and a snapshot replaces it', async () => {
  const env = setup();
  env.live.start();
  env.live.noteTaskIds(['st_n1', 'st_n2'], ['First noted', 'Second noted']);
  await env.clock.advance(2100);
  assert.deepEqual(lastSaved(env).map((w) => [w.id, w.name, w.state]), [['st_n1', 'First noted', 'waiting'], ['st_n2', 'Second noted', 'waiting']]);
  assert.ok(lastSaved(env).every((w) => w.step.length > 0), 'waiting line has a label');
  const waitingStep = row(env, 'st_n1').step;
  assert.ok(env.disk.calls.length > 0, 'child session dir is probed');
  assert.equal(env.disk.calls.filter((c) => /[\\/]tasks([\\/]|$)/.test(c.path)).length, 0);
  env.live.onRpcEvent(snapshot([task('st_n1', { updated_at: iso(NOW0 + 5000) })]));
  await env.clock.advance(2100);
  assert.notEqual(row(env, 'st_n1').step, waitingStep);
  assert.equal(row(env, 'st_n1').name, 'st_n1 summary');
  env.live.stop();
});

test('child todo-state is read through the cursor reader and published', async () => {
  const env = setup();
  env.disk.set(childFile('st_a'), todoLine([todo('Write tests', 'completed'), todo('Ship it', 'in_progress')]));
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_a')]));
  await env.clock.advance(2000);
  assert.deepEqual(row(env, 'st_a').todo.items.map((i) => [i.text, i.status]), [['Write tests', 'completed'], ['Ship it', 'in_progress']]);
  assert.equal(row(env, 'st_a').todo.total, 2);
  const publishes = env.log.publishes;
  env.disk.append(childFile('st_a'), todoLine([todo('Write tests', 'completed'), todo('Ship it', 'completed')]));
  await env.clock.advance(4000);
  assert.equal(row(env, 'st_a').todo.done, 2);
  assert.ok(env.log.publishes > publishes);
  assert.ok(env.disk.calls.every((c) => c.path.startsWith(childDir('st_a'))), 'only the worker session folder is touched');
  env.live.stop();
});

test('after a worker ends it is read one more time, then reads and timers stop', async () => {
  const env = setup();
  env.disk.set(childFile('st_a'), todoLine([todo('Step', 'in_progress')]));
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_a')]));
  await env.clock.advance(2000);
  assert.equal(env.clock.active() > 0, true);
  env.disk.append(childFile('st_a'), todoLine([todo('Step', 'completed')]));
  env.live.onRpcEvent(snapshot([task('st_a', { status: 'completed', updated_at: iso(NOW0 + 3000), terminal_at: iso(NOW0 + 3000) })]));
  const before = env.disk.calls.length;
  await env.clock.advance(2000);
  const afterFinal = env.disk.calls.length;
  assert.ok(afterFinal > before, 'one final read after the terminal transition');
  assert.equal(row(env, 'st_a').todo.items[0].status, 'completed');
  assert.equal(row(env, 'st_a').state, 'done');
  await env.clock.advance(20000);
  assert.equal(env.disk.calls.length, afterFinal, 'no fs calls after the final read');
  assert.equal(env.clock.active(), 0, 'tick timer stops when nothing is left to watch');
  env.live.stop();
});

test('two consecutive EPERM reads raise workers:<id> once and the next success clears it', async () => {
  const env = setup();
  env.disk.set(childFile('st_a'), todoLine([todo('Step', 'in_progress')]));
  env.disk.fail(Array(10).fill('EPERM'));
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_a')]));
  await env.clock.advance(2000);
  assert.deepEqual(env.log.errors, [], 'a single failed read is not yet a chip');
  await env.clock.advance(2000);
  assert.deepEqual(env.log.errors, [{ key: 'workers:st_a', code: 'EPERM' }]);
  assert.deepEqual(env.log.recovers, []);
  await env.clock.advance(2000);
  assert.deepEqual(env.log.recovers, ['workers:st_a']);
  assert.equal(row(env, 'st_a').todo.items[0].text, 'Step');
  await env.clock.advance(6000);
  assert.deepEqual(env.log.recovers, ['workers:st_a'], 'recover is reported once');
  env.live.stop();
});

test('pause keeps memory only: no save, publish, read or error; resume publishes the pending state once', async () => {
  const env = setup();
  env.disk.set(childFile('st_a'), todoLine([todo('Step', 'in_progress')]));
  env.state.enabled = false;
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_a')]));
  env.live.onRpcEvent({ name: 'omo.task.updated', data: { parent_session_id: LEAD, tasks: 'bad' } });
  env.live.noteTaskIds(['st_b'], ['Noted']);
  await env.clock.advance(30000);
  assert.deepEqual([env.log.saves.length, env.log.publishes, env.disk.calls.length, env.log.errors.length, env.log.recovers.length], [0, 0, 0, 0, 0]);
  env.state.enabled = true;
  await env.clock.advance(2100);
  assert.equal(env.log.publishes, 1);
  assert.deepEqual(lastSaved(env).map((w) => w.id).sort(), ['st_a', 'st_b']);
  env.live.stop();
});

test('stop leaves no timers, ignores later events, and still reports an error queued by the handler', async () => {
  const env = setup();
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_a')]));
  env.live.onRpcEvent({ name: 'omo.task.updated', data: { parent_session_id: LEAD, tasks: 'bad' } });
  assert.ok(env.clock.active() > 0);
  env.live.stop();
  assert.equal(env.clock.active(), 0);
  assert.deepEqual(env.log.errors.map((e) => e.key), ['workers:snapshot'], 'queued error flushed, not dropped');
  env.live.onRpcEvent(snapshot([task('st_b')]));
  env.live.noteTaskIds(['st_c'], ['x']);
  assert.equal(env.clock.active(), 0);
  await env.clock.advance(20000);
  assert.deepEqual([env.log.saves.length, env.log.publishes, env.disk.calls.length], [0, 0, 0]);
});

test('a snapshot that arrives before the session id is known is kept (latest only) and applied once it is', async () => {
  let id;
  const env = setup({ sessionId: () => id });
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_old')]));
  env.live.onRpcEvent(snapshot([task('st_new')]));
  await env.clock.advance(4000);
  assert.equal(env.log.saves.length, 0);
  id = LEAD;
  await env.clock.advance(2100);
  assert.deepEqual(lastSaved(env).map((w) => w.id), ['st_new']);
  env.live.stop();
});

test('a failing saveLive is reported, the chip is still published, and the save is retried until it succeeds', async () => {
  let failing = true;
  const saved = [];
  const env = setup({ saveLive: (list) => { if (failing) throw Object.assign(new Error('disk'), { code: 'EIO' }); saved.push(list); } });
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_a')]));
  await env.clock.advance(10);
  assert.deepEqual(env.log.errors, [{ key: 'workers:save', code: 'EIO' }]);
  assert.equal(env.log.publishes, 1, 'the error is shown by a publish in the same action');
  failing = false;
  await env.clock.advance(2100);
  assert.equal(saved.length, 1);
  assert.deepEqual(env.log.recovers, ['workers:save']);
  env.live.stop();
});

test('a nonterminal worker silent for ten minutes is saved as stale', async () => {
  const env = setup();
  env.disk.set(childFile('st_a'), todoLine([todo('Step', 'in_progress')]));
  env.live.start();
  env.live.onRpcEvent(snapshot([task('st_a')]));
  await env.clock.advance(2000);
  assert.notEqual(row(env, 'st_a').stale, true);
  await env.clock.advance(10 * 60 * 1000);
  assert.equal(row(env, 'st_a').stale, true);
  env.live.stop();
});
