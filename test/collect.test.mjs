import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectAuto } from '../src/collect.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collect');
const NATIVE_TODO = JSON.parse(readFileSync(path.join(FIX, 'todo-native.json'), 'utf8'));
const LEGACY_TODOS = JSON.parse(readFileSync(path.join(FIX, 'todo-legacy.json'), 'utf8')).entries;
const FIXTURE_BOULDER = JSON.parse(readFileSync(path.join(FIX, 'boulder.json'), 'utf8'));
const TASK_RECORD = JSON.parse(readFileSync(path.join(FIX, 'task-record.json'), 'utf8'));

const NOW = 1_700_000_000_000;

function memFs(files) {
  const calls = [];
  const readFile = (p) => {
    calls.push(p.replace(/\\/g, '/'));
    if (!(p.replace(/\\/g, '/') in files)) {
      const e = new Error('ENOENT ' + p);
      e.code = 'ENOENT';
      throw e;
    }
    return files[p.replace(/\\/g, '/')];
  };
  return { readFile, calls };
}

const BOULDER = {
  works: {
    'w-one': {
      plan_name: 'plan-a', phase: 'phase-2', current_task: '3',
      completed_tasks: ['1', '2'], task_count: 8, session_ids: ['sess-A'],
    },
    'w-other': {
      plan_name: 'plan-b', phase: 'p', current_task: '1',
      completed_tasks: [], task_count: 4, session_ids: ['sess-Z'],
    },
  },
};

const TODO_ENTRY = {
  customType: 'senpi.todo-state',
  phases: [{ name: 'Tasks', tasks: [
    { id: '1', content: '첫 작업', status: 'completed' },
    { id: '2', content: '둘째 작업', status: 'in_progress' },
    { id: '3', content: '셋째 작업', status: 'pending' },
    { id: '4', content: '넷째 작업', status: 'pending' },
  ] }],
};

test('work 매칭: sessionId가 든 work만 골라 요약', () => {
  const { readFile } = memFs({ 'C:/w/.omo/boulder.json': JSON.stringify(BOULDER) });
  const out = collectAuto({ cwd: 'C:/w', sessionId: 'sess-A', branchEntries: [], workerIds: [], readFile, now: NOW, cache: {} });
  assert.deepEqual(out.work, { name: 'plan-a', phase: 'phase-2', current: '3', done: 2, total: 8 });
});

test('todo: 뒤에서 처음 만나는 최신 엔트리 우선', () => {
  const { readFile } = memFs({});
  const oldEntry = { customType: 'senpi.todo-state', phases: [{ tasks: [{ content: '옛일', status: 'in_progress' }] }] };
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's', branchEntries: [oldEntry, TODO_ENTRY],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.deepEqual(out.todo, { current: '둘째 작업', next: '셋째 작업', done: 1, total: 4 });
});

test('todo: legacy todowrite·todo-list 인식', () => {
  const { readFile } = memFs({});
  for (const ct of ['todowrite-v1', 'todo-list']) {
    const out = collectAuto({
      cwd: 'C:/w', sessionId: 's',
      branchEntries: [{ customType: ct, todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ] }],
      workerIds: [], readFile, now: NOW, cache: {},
    });
    assert.deepEqual(out.todo, { current: 'b', next: 'c', done: 1, total: 3 }, ct);
  }
});

test('workers: metaWorkers로 집계 (running/completed/error/cancelled)', () => {
  const { readFile } = memFs({});
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's', branchEntries: [], workerIds: ['st_a', 'st_b'],
    metaWorkers: [{ id: 'st_a', status: 'running' }, { id: 'st_b', status: 'completed' }, { id: 'st_c', status: 'error' }, { id: 'st_d', status: 'cancelled' }],
    readFile, now: NOW, cache: {},
  });
  assert.deepEqual(out.workers, { running: 1, completed: 1, error: 1, other: 1 });
});

test('readTaskRecords 없으면 senpi-task 경로 읽기 0회', () => {
  const { readFile, calls } = memFs({ 'C:/w/.omo/boulder.json': JSON.stringify(BOULDER) });
  collectAuto({ cwd: 'C:/w', sessionId: 'sess-A', branchEntries: [TODO_ENTRY], workerIds: ['st_a'], readFile, now: NOW, cache: {} });
  assert.equal(calls.filter((p) => p.includes('senpi-task')).length, 0);
});

test('readTaskRecords:true면 workerIds 파일만 읽음', () => {
  const files = {
    'C:/w/.omo/senpi-task/tasks/st_a.json': JSON.stringify({ task_id: 'st_a', status: 'completed' }),
    'C:/w/.omo/senpi-task/tasks/st_b.json': JSON.stringify({ task_id: 'st_b', status: 'running' }),
    'C:/w/.omo/senpi-task/tasks/st_other.json': JSON.stringify({ task_id: 'st_other', status: 'completed' }),
  };
  const { readFile, calls } = memFs(files);
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's', branchEntries: [], workerIds: ['st_a', 'st_b'],
    readTaskRecords: true, readFile, now: NOW, cache: {},
  });
  assert.deepEqual(out.workers, { running: 1, completed: 1, error: 0, other: 0 });
  const taskReads = calls.filter((p) => p.includes('senpi-task'));
  assert.deepEqual(taskReads.sort(), ['C:/w/.omo/senpi-task/tasks/st_a.json', 'C:/w/.omo/senpi-task/tasks/st_b.json']);
});

test('60초 안 두 번째 호출은 readFile 0회 (캐시)', () => {
  const { readFile, calls } = memFs({ 'C:/w/.omo/boulder.json': JSON.stringify(BOULDER) });
  const cache = {};
  const first = collectAuto({ cwd: 'C:/w', sessionId: 'sess-A', branchEntries: [TODO_ENTRY], workerIds: [], readFile, now: NOW, cache });
  const n = calls.length;
  assert.ok(n > 0, '첫 호출은 읽어야 함');
  const second = collectAuto({ cwd: 'C:/w', sessionId: 'sess-A', branchEntries: [TODO_ENTRY], workerIds: [], readFile, now: NOW + 59_000, cache });
  assert.equal(calls.length, n);
  assert.deepEqual(second, first);
});

test('60초 지나면 다시 읽음 (stale)', () => {
  const { readFile, calls } = memFs({ 'C:/w/.omo/boulder.json': JSON.stringify(BOULDER) });
  const cache = {};
  collectAuto({ cwd: 'C:/w', sessionId: 'sess-A', branchEntries: [], workerIds: [], readFile, now: NOW, cache });
  const n = calls.length;
  collectAuto({ cwd: 'C:/w', sessionId: 'sess-A', branchEntries: [], workerIds: [], readFile, now: NOW + 61_000, cache });
  assert.ok(calls.length > n, '캐시 만료 후 재읽기');
});

test('깨진 boulder.json -> work 없음, 나머지 정상', () => {
  const { readFile } = memFs({ 'C:/w/.omo/boulder.json': '{깨진' });
  const out = collectAuto({ cwd: 'C:/w', sessionId: 'sess-A', branchEntries: [TODO_ENTRY], workerIds: [], readFile, now: NOW, cache: {} });
  assert.ok(!('work' in out), 'work 키 생략');
  assert.deepEqual(out.todo, { current: '둘째 작업', next: '셋째 작업', done: 1, total: 4 });
});

test('파일 없음·깨진 todo·작업자 없음에서 예외 없이 키 생략', () => {
  const { readFile } = memFs({});
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 'nope',
    branchEntries: [{ customType: 'senpi.todo-state', phases: '깨짐' }, { customType: 'unrelated', x: 1 }],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.ok(!('work' in out) && !('todo' in out) && !('workers' in out));
});

test('native todo envelope: entry.data.phases 파싱', () => {
  const { readFile } = memFs({});
  assert.equal(NATIVE_TODO.type, 'custom');
  assert.equal(NATIVE_TODO.customType, 'senpi.todo-state');
  assert.ok(Array.isArray(NATIVE_TODO.data.phases), 'native data.phases');
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's', branchEntries: [NATIVE_TODO],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.deepEqual(out.todo, { current: 'second job', next: 'third job', done: 1, total: 4 });
});

test('native 최신 엔트리 우선 (구 엔트리 무시)', () => {
  const { readFile } = memFs({});
  const older = { customType: 'senpi.todo-state', payload: { phases: [{ tasks: [{ content: '옛일', status: 'in_progress' }] }] } };
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's', branchEntries: [older, NATIVE_TODO],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.deepEqual(out.todo, { current: 'second job', next: 'third job', done: 1, total: 4 });
});

test('fixture legacy 모양 인식 (todowrite·todo-list)', () => {
  const { readFile } = memFs({});
  const expected = { 'todowrite-v1': { current: 'legacy-b', next: 'legacy-c' }, 'todo-list': { current: 'list-b', next: 'list-c' } };
  for (const entry of LEGACY_TODOS) {
    const out = collectAuto({
      cwd: 'C:/w', sessionId: 's', branchEntries: [entry],
      workerIds: [], readFile, now: NOW, cache: {},
    });
    const e = expected[entry.customType];
    assert.deepEqual(out.todo, { current: e.current, next: e.next, done: 1, total: 3 }, entry.customType);
  }
  // fixture todos variants exercised above; legacy-b/current shape covered
});

test('T8-CORRUPT-OMIT: tasks:[null]은 예외 없이 todo만 생략', () => {
  const { readFile } = memFs({});
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's',
    metaWorkers: [{ id: 'st_a', status: 'running' }],
    branchEntries: [{ customType: 'senpi.todo-state', payload: { phases: [{ tasks: [null] }] } }],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.ok(!('todo' in out), 'todo 키 생략');
  assert.deepEqual(out.workers, { running: 1, completed: 0, error: 0, other: 0 });
});

test('T8-TODO-LATEST: 깨진 최신 엔트리는 이전 요약을 부활시키지 않음', () => {
  const { readFile } = memFs({});
  const older = { customType: 'senpi.todo-state', payload: { phases: [{ tasks: [{ content: '옛일', status: 'in_progress' }] }] } };
  const corruptLatest = { customType: 'senpi.todo-state', phases: 'invalid' };
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's', branchEntries: [older, corruptLatest],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.ok(!('todo' in out), '깨진 최신이면 todo 생략');
});

test('fixture boulder.json·task-record 로드 매칭', () => {
  const files = {
    'C:/w/.omo/boulder.json': JSON.stringify(FIXTURE_BOULDER),
    'C:/w/.omo/senpi-task/tasks/st_sample.json': JSON.stringify(TASK_RECORD),
  };
  const { readFile } = memFs(files);
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 'sess-A', branchEntries: [NATIVE_TODO],
    workerIds: ['st_sample'], readTaskRecords: true, readFile, now: NOW, cache: {},
  });
  assert.deepEqual(out.work, { name: 'alpha-plan', phase: 'phase-2', current: '3', done: 2, total: 8 });
  assert.deepEqual(out.workers, { running: 1, completed: 0, error: 0, other: 0 });
});

test('T8-CORRUPT-OMIT mixed: valid phase + broken-tasks phase -> todo 생략', () => {
  const { readFile } = memFs({});
  const valid = { name: 'Tasks', tasks: [
    { content: 'done', status: 'completed' },
    { content: 'current', status: 'in_progress' },
    { content: 'next', status: 'pending' },
  ] };
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's',
    branchEntries: [{ type: 'custom', customType: 'senpi.todo-state', data: { schema: 'v2', phases: [valid, { name: 'Broken', tasks: 'invalid' }] } }],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.ok(!('todo' in out), '부분 요약 없이 todo 키 생략');
});

test('T8-CORRUPT-OMIT array task: tasks:[[]] -> todo 생략', () => {
  const { readFile } = memFs({});
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's',
    branchEntries: [{ type: 'custom', customType: 'senpi.todo-state', data: { schema: 'v2', phases: [{ name: 'Tasks', tasks: [[]] }] } }],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.ok(!('todo' in out), '배열 task를 세지 않고 생략');
});

test('T8-CORRUPT-OMIT null phase -> todo 생략', () => {
  const { readFile } = memFs({});
  const valid = { name: 'Tasks', tasks: [{ content: 'a', status: 'in_progress' }] };
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's',
    branchEntries: [{ type: 'custom', customType: 'senpi.todo-state', data: { schema: 'v2', phases: [valid, null] } }],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.ok(!('todo' in out), 'null phase는 생략');
});

test('T8-CORRUPT-OMIT content 없는 task -> todo 생략', () => {
  const { readFile } = memFs({});
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's',
    branchEntries: [{ customType: 'senpi.todo-state', phases: [{ name: 'Tasks', tasks: [{ status: 'pending' }] }] }],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.ok(!('todo' in out), 'content 없는 task는 생략');
});

test('T8-CORRUPT-OMIT unknown status task -> todo 생략', () => {
  const { readFile } = memFs({});
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's',
    branchEntries: [{ customType: 'senpi.todo-state', phases: [{ name: 'Tasks', tasks: [{ content: 'x', status: 'weird' }] }] }],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.ok(!('todo' in out), '알 수 없는 status는 생략');
});

test('T8-CORRUPT-OMIT native data.phases가 배열 아님 -> todo 생략', () => {
  const { readFile } = memFs({});
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's',
    branchEntries: [{ type: 'custom', customType: 'senpi.todo-state', data: { schema: 'v2', phases: 'broken' } }],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.ok(!('todo' in out), 'phases 비배열은 생략');
});

test('T8-CORRUPT-OMIT legacy todos 중 하나라도 깨지면 todo 생략', () => {
  const { readFile } = memFs({});
  const out = collectAuto({
    cwd: 'C:/w', sessionId: 's',
    branchEntries: [{ customType: 'todowrite-v1', todos: [
      { content: 'a', status: 'completed' },
      { content: 'b' },
    ] }],
    workerIds: [], readFile, now: NOW, cache: {},
  });
  assert.ok(!('todo' in out), 'legacy도 전체 엄격 검증');
});

test('completed_tasks 숫자 형태와 매칭 없는 세션 처리', () => {
  const { readFile } = memFs({ 'C:/w/.omo/boulder.json': JSON.stringify({ works: { w: {
    plan_name: 'p', phase: 'ph', current_task: '5', completed_tasks: 4, task_count: 10, session_ids: ['s1'],
  } } }) });
  const hit = collectAuto({ cwd: 'C:/w', sessionId: 's1', branchEntries: [], workerIds: [], readFile, now: NOW, cache: {} });
  assert.deepEqual(hit.work, { name: 'p', phase: 'ph', current: '5', done: 4, total: 10 });
  const miss = collectAuto({ cwd: 'C:/w', sessionId: 's9', branchEntries: [], workerIds: [], readFile, now: NOW + 61_000, cache: {} });
  assert.ok(!('work' in miss));
});
