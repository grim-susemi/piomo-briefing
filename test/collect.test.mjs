import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectAuto, normSessionId, todoPayload, strictTasks } from '../src/collect.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collect');
const NATIVE_TODO = JSON.parse(readFileSync(path.join(FIX, 'todo-native.json'), 'utf8'));
const LEGACY_TODOS = JSON.parse(readFileSync(path.join(FIX, 'todo-legacy.json'), 'utf8')).entries;
const FIXTURE_BOULDER = JSON.parse(readFileSync(path.join(FIX, 'boulder.json'), 'utf8'));
const SENPI_BOULDER = JSON.parse(readFileSync(path.join(FIX, 'boulder-senpi-prefix.json'), 'utf8'));
const S_LEAD = '01a13bd0-ade9-7eb0-a6a7-06bbf047fe6f';
const S_BARE = '01a13b5f-392b-7e43-96aa-82f29d85407a';
const S_TWO_DONE = '01a12466-aa9f-74e8-9f13-887e8c17715c';
const S_DISCARDED = '01a11180-e646-727e-8eb3-af01c09975e1';
const S_STARTED_AT = '01a1262b-06fd-719b-bbfd-7b0152ac693a';
const S_NO_TIME = '01a1aaaa-1111-7000-8000-000000000001';
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

// --- GAP-10: boulder `senpi:<uuid>` vs bare session id -------------------------

function senpiFixture() {
  return memFs({ 'C:/w/.omo/boulder.json': JSON.stringify(SENPI_BOULDER) });
}

function workFor(sessionId) {
  const { readFile } = senpiFixture();
  return collectAuto({ cwd: 'C:/w', sessionId, branchEntries: [], workerIds: [], readFile, now: NOW, cache: {} });
}

test('normSessionId: 앞 senpi:만 제거, 문자열 아니면 빈 값', () => {
  assert.equal(normSessionId('senpi:01a13bd0-ade9'), '01a13bd0-ade9');
  assert.equal(normSessionId('01a13bd0-ade9'), '01a13bd0-ade9');
  assert.equal(normSessionId('senpi:senpi:x'), 'senpi:x');
  assert.equal(normSessionId(''), '');
  assert.equal(normSessionId(undefined), '');
  assert.equal(normSessionId(null), '');
  assert.equal(normSessionId(42), '');
  assert.equal(normSessionId({ id: 'senpi:x' }), '');
});

test('GAP-10: boulder senpi:<uuid> + 입력 맨 uuid -> work 선택 (진행 work)', () => {
  const out = workFor(S_LEAD);
  assert.deepEqual(out.work, { name: 'piomo-briefing-plan-view', phase: 'Wave 1 기초', current: '1', done: 0, total: 16 });
});

test('GAP-10: 입력에도 senpi: 접두가 있으면 같은 work', () => {
  const out = workFor(`senpi:${S_LEAD}`);
  assert.deepEqual(out.work, { name: 'piomo-briefing-plan-view', phase: 'Wave 1 기초', current: '1', done: 0, total: 16 });
});

test('GAP-10: boulder 맨 id + 입력 senpi: 접두 -> 선택', () => {
  const out = workFor(`senpi:${S_BARE}`);
  assert.deepEqual(out.work, { name: 'once-human-structure-study', phase: 'Wave 2', current: '7', done: 6, total: 16 });
});

test('GAP-10: 다른 id -> work 없음', () => {
  const out = workFor('01a1ffff-0000-7000-8000-000000000000');
  assert.ok(!('work' in out), '매칭 없으면 work 키 생략');
});

test('GAP-10: 완료 work와 진행 work에 같은 세션 -> 완료 아닌 work 우선', () => {
  // crimson(completed, 2026-10-12) + pi-routing(discarded, 2026-10-01) 둘 다 이 세션
  const out = workFor(`senpi:${S_DISCARDED}`);
  assert.equal(out.work?.name, 'pi-routing-removable-extension');
  // fixture work has current_task: null (finished, discarded) - passed through verbatim
  assert.deepEqual(out.work, { name: 'pi-routing-removable-extension', phase: 'Discarded; preserved reference only', current: null, done: 6, total: 13 });
});

test('GAP-10: 완료 work 둘 -> 더 최근 updated_at', () => {
  const out = workFor(`senpi:${S_TWO_DONE}`);
  assert.equal(out.work?.name, 'optiscaler-nr-present-addon-options');
});

test('GAP-10: updated_at 없고 started_at만 있으면 더 최근 started_at', () => {
  const out = workFor(`senpi:${S_STARTED_AT}`);
  assert.equal(out.work?.name, 'herdr-start-new');
});

test('GAP-10: 시각이 둘 다 없으면 파일 뒤쪽 work', () => {
  const out = workFor(`senpi:${S_NO_TIME}`);
  assert.equal(out.work?.name, 'no-ts-second');
});

test('GAP-10: works가 배열인 boulder도 지원', () => {
  const arrayWorks = { works: [
    { work_id: 'a', plan_name: 'arr-old', phase: 'p', current_task: '1', completed_tasks: [], task_count: 2, session_ids: ['sess-arr'], status: 'completed', updated_at: '2026-09-01T00:00:00Z' },
    { work_id: 'b', plan_name: 'arr-new', phase: 'p', current_task: '2', completed_tasks: ['1'], task_count: 2, session_ids: ['senpi:sess-arr'], status: 'active', updated_at: '2026-10-01T00:00:00Z' },
  ] };
  const { readFile } = memFs({ 'C:/w/.omo/boulder.json': JSON.stringify(arrayWorks) });
  const out = collectAuto({ cwd: 'C:/w', sessionId: 'sess-arr', branchEntries: [], workerIds: [], readFile, now: NOW, cache: {} });
  assert.deepEqual(out.work, { name: 'arr-new', phase: 'p', current: '2', done: 1, total: 2 });
});

test('GAP-10 악성 입력: session_ids 없음·문자열·비문자 원소, sessionId 없음', () => {
  const weird = { works: {
    'w-no-ids': { plan_name: 'no-ids', status: 'active', session_ids: null, task_count: 1, completed_tasks: [], phase: 'p', current_task: '1' },
    'w-string-ids': { plan_name: 'string-ids', status: 'active', session_ids: 'senpi:sess-W', task_count: 1, completed_tasks: [], phase: 'p', current_task: '1' },
    'w-junk-ids': { plan_name: 'junk-ids', status: 'active', session_ids: [null, 42, {}, 'senpi:sess-W'], task_count: 3, completed_tasks: [], phase: 'p', current_task: '1' },
    'w-null': null,
  } };
  const { readFile } = memFs({ 'C:/w/.omo/boulder.json': JSON.stringify(weird) });
  const hit = collectAuto({ cwd: 'C:/w', sessionId: 'sess-W', branchEntries: [], workerIds: [], readFile, now: NOW, cache: {} });
  assert.deepEqual(hit.work, { name: 'junk-ids', phase: 'p', current: '1', done: 0, total: 3 });
  for (const sessionId of [undefined, null, '', 'senpi:', 42]) {
    const miss = collectAuto({ cwd: 'C:/w', sessionId, branchEntries: [], workerIds: [], readFile, now: NOW, cache: {} });
    assert.ok(!('work' in miss), `sessionId ${String(sessionId)} 는 매칭 없음`);
  }
});

test('todoPayload·strictTasks 내보내기: 기존 동작 그대로', () => {
  const entry = { type: 'custom', customType: 'senpi.todo-state', data: { schema: 'v2', phases: [{ name: 'T', tasks: [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
  ] }] } };
  assert.deepEqual(todoPayload(entry), entry.data);
  assert.deepEqual(strictTasks(entry.data), entry.data.phases[0].tasks);
  assert.equal(todoPayload({ customType: 'other' }), null);
  assert.equal(todoPayload(null), null);
  assert.deepEqual(strictTasks({ todos: [{ content: 'x', status: 'completed' }] }), [{ content: 'x', status: 'completed' }]);
  assert.equal(strictTasks({ phases: [{ name: 'T', tasks: [{ content: 'x' }] }] }), null);
  assert.equal(strictTasks({}), null);
});

// --- malformed work status: ranking must not coerce arbitrary JSON values ------
// The baseline collector never read `status`, so a JSON status object (e.g.
// {toString:null}, which JSON.parse produces verbatim) still produced a work
// summary. Ranking may only read terminal status *strings*.

test('T1-STATUS-NO-THROW: toString 없는 status 객체가 섞여도 예외 없이 요약 반환', () => {
  const boulder = { works: {
    'w-bad': {
      plan_name: 'bad-status-plan', phase: 'p', current_task: '2',
      completed_tasks: ['1'], task_count: 5, session_ids: ['sess-A'],
      status: { toString: null },
    },
    'w-active': {
      plan_name: 'active-plan', phase: 'q', current_task: '4',
      completed_tasks: ['1', '2', '3'], task_count: 8, session_ids: ['sess-A'],
      status: 'active',
    },
  } };
  const { readFile } = memFs({ 'C:/w/.omo/boulder.json': JSON.stringify(boulder) });
  const out = collectAuto({ cwd: 'C:/w', sessionId: 'sess-A', branchEntries: [], workerIds: [], readFile, now: NOW, cache: {} });
  // 둘 다 완료 아님이고 시각도 없으니 삽입 순서 뒤쪽 work가 뽑힌다 (기존 tie-break).
  // 요점은 요약을 돌려준다는 것 - status를 문자열로 바꾸려 들면 여기서 던진다.
  assert.deepEqual(out.work, { name: 'active-plan', phase: 'q', current: '4', done: 3, total: 8 });
});

test('T1-STATUS-RANK: 문자열 아닌 status는 완료로 보지 않는다', () => {
  const boulder = { works: {
    'w-bad': {
      plan_name: 'bad-status-plan', phase: 'p', current_task: '2',
      completed_tasks: [], task_count: 3, session_ids: ['sess-A'],
      status: { toString: null }, updated_at: '2026-09-01T00:00:00Z',
    },
    'w-done': {
      plan_name: 'done-plan', phase: 'p', current_task: '9',
      completed_tasks: ['1'], task_count: 9, session_ids: ['sess-A'],
      status: 'completed', updated_at: '2026-10-01T00:00:00Z',
    },
  } };
  const { readFile } = memFs({ 'C:/w/.omo/boulder.json': JSON.stringify(boulder) });
  const out = collectAuto({ cwd: 'C:/w', sessionId: 'sess-A', branchEntries: [], workerIds: [], readFile, now: NOW, cache: {} });
  assert.equal(out.work?.name, 'bad-status-plan');
});

test('C-VM todoItems: a 45-item native todo keeps 40 items {text, status} and more:5 beside the counts', () => {
  const tasks = Array.from({ length: 45 }, (_, i) => ({ content: `일 ${i}`, status: i === 0 ? 'in_progress' : 'pending' }));
  const out = collectAuto({ cwd: 'C:/p', sessionId: 's', branchEntries: [{ type: 'custom', customType: 'senpi.todo-state', data: { schema: 'v2', phases: [{ name: 'T', tasks }] } }] });
  assert.deepEqual(out.todo, { current: '일 0', next: '일 1', done: 0, total: 45 });
  assert.equal(out.todoItems.items.length, 40);
  assert.equal(out.todoItems.more, 5);
  assert.deepEqual(out.todoItems.items[0], { text: '일 0', status: 'in_progress' });
  assert.deepEqual(out.todoItems.items[39], { text: '일 39', status: 'pending' });
  // a corrupt newest entry omits both keys (no partial list)
  const bad = collectAuto({ cwd: 'C:/p', sessionId: 's', branchEntries: [{ customType: 'senpi.todo-state', phases: [{ name: 'T', tasks: [...tasks, null] }] }] });
  assert.ok(!('todo' in bad) && !('todoItems' in bad));
});

test('C-VM ledgerPath: the picked work ledger, relative joined to cwd, absolute kept, absent omitted', () => {
  const read = (works) => () => JSON.stringify({ works });
  const rel = collectAuto({ cwd: 'C:\\w\\proj\\', sessionId: 's', readFile: read({ a: { session_ids: ['senpi:s'], ledger: './.omo/ledger.jsonl' } }) });
  assert.equal(rel.ledgerPath, 'C:/w/proj/.omo/ledger.jsonl');
  const abs = collectAuto({ cwd: 'C:/w/proj', sessionId: 's', readFile: read({ a: { session_ids: ['s'], ledger: 'D:/x/l.jsonl' } }) });
  assert.equal(abs.ledgerPath, 'D:/x/l.jsonl');
  const none = collectAuto({ cwd: 'C:/w/proj', sessionId: 's', readFile: read({ a: { session_ids: ['s'], ledger: 7 } }) });
  assert.ok(!('ledgerPath' in none) && 'work' in none);
});
