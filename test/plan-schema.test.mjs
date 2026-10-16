import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlanBrief,
  planIdOf,
  rootAndSlugOf,
  PLAN_BRIEF_PARAMETERS,
  PLAN_BRIEF_DESCRIPTION,
} from '../src/plan-schema.mjs';

const PLAN = 'C:/Users/USER/orca/projects/기타 작업/.omo/plans/piomo-briefing-plan-view.md';
const DRAFT = 'C:/Users/USER/orca/projects/기타 작업/.omo/drafts/piomo-briefing-plan-view.md';
const okExists = () => true;
const ownOnly = (id) => id === 1;
const opts = (extra = {}) => ({ fileExists: okExists, isOwnOpenDecision: ownOnly, ...extra });
const err = (r) => r.errors.join('\n');

const base = () => ({
  planPath: PLAN,
  draftPath: DRAFT,
  stage: 'review',
  stageNote: '검토 중',
  goal: '상황판이 스스로 바뀐다',
  ideal: [{ id: 'IS-1', text: '클릭 없이 1.5초 안에 반영' }],
  components: [{ id: 'C1', label: '서버', text: '127.0.0.1 전용' }],
  waves: [{ n: 1, label: '기초' }, { n: 2, label: '화면' }],
  tasks: [
    { id: '1', wave: 1, label: '검사기', what: '입력 검사', done: '테스트 통과', deps: [] },
    { id: '2', wave: 2, label: '화면', what: '계획 화면', done: '레인 4개', deps: ['1'] },
  ],
  questions: [
    {
      id: 'Q1',
      text: '소리를 켤까?',
      state: 'open',
      options: {
        A: { text: '켠다', consequence: '알람이 울린다' },
        B: { text: '안 켠다', consequence: '조용하다' },
      },
      recommend: 'A',
      reason: '답을 기다리는 것을 알아야 함',
      blocks: false,
    },
    { id: 'Q2', text: '포트는?', state: 'answered', answer: '47317', by: 'owner' },
    { id: 'Q3', text: '기본값은?', state: 'default', answer: '켜짐', by: 'agent' },
  ],
  outOfScope: ['버튼으로 답하기'],
});

test('정상 전체 입력 통과 + normalized는 입력 그대로', () => {
  const input = base();
  const r = validatePlanBrief(input, opts());
  assert.equal(r.ok, true, err(r));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.normalized, input);
  assert.deepEqual(Object.keys(r.normalized).sort(), Object.keys(input).sort());
  assert.match(r.planId, /^p[0-9a-f]{12}$/);
  const rs = rootAndSlugOf(PLAN);
  assert.equal(r.planId, planIdOf(rs.root, rs.slug));
});

test('planPath·draftPath 둘 다 없으면 거절', () => {
  const input = base();
  delete input.planPath;
  delete input.draftPath;
  const r = validatePlanBrief(input, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /planPath|draftPath/);
  assert.equal(r.normalized, null);
  assert.equal(r.planId, null);
});

test('상대경로·.omo/plans 밖·없는 파일 거절', () => {
  for (const p of ['plans/a.md', '.omo/plans/a.md', 'C:/Users/USER/x/notes/a.md', 'C:/Users/USER/x/.omo/archive/a.md', 'C:/Users/USER/x/.omo/plans/a.txt']) {
    const input = base();
    input.planPath = p;
    const r = validatePlanBrief(input, opts());
    assert.equal(r.ok, false, p);
    assert.match(err(r), /planPath/, p);
  }
  const input = base();
  const r = validatePlanBrief(input, { fileExists: () => false, isOwnOpenDecision: ownOnly });
  assert.equal(r.ok, false);
  assert.match(err(r), /planPath: 파일 없음/);
  assert.match(err(r), /draftPath: 파일 없음/);
});

test('못 읽는 파일은 없는 파일과 다르게 보고된다 (T2-ERROR)', () => {
  const unreadable = validatePlanBrief(base(), {
    fileExists: () => { throw Object.assign(new Error('verifier access denied'), { code: 'EPERM' }); },
  });
  const absent = validatePlanBrief(base(), { fileExists: () => false });
  assert.equal(unreadable.ok, false);
  assert.notDeepEqual(unreadable, absent);
  assert.match(err(unreadable), /planPath: 읽기 실패\(EPERM - verifier access denied\)/);
  assert.match(err(unreadable), /draftPath: 읽기 실패\(EPERM - verifier access denied\)/);
  assert.doesNotMatch(err(unreadable), /파일 없음/);
  assert.equal(unreadable.normalized, null);
  const plain = validatePlanBrief(base(), { fileExists: () => { throw new Error('boom'); } });
  assert.match(err(plain), /planPath: 읽기 실패\(Error - boom\)/);
});

test('T2-ERROR: unreadable plan differs from absent plan', () => {
  const input = () => ({
    planPath: 'C:/project/.omo/plans/a.md',
    stage: 'ready', stageNote: '', goal: 'goal',
    ideal: [], components: [], waves: [], tasks: [],
    questions: [], outOfScope: [],
  });
  const unreadable = validatePlanBrief(input(), {
    fileExists: () => {
      throw Object.assign(new Error('verifier access denied'), { code: 'EPERM' });
    },
  });
  const absent = validatePlanBrief(input(), { fileExists: () => false });
  assert.equal(unreadable.ok, false);
  assert.notDeepEqual(unreadable, absent);
});

test('복사할 수 없는 값이 있어도 던지지 않는다', () => {
  const input = base();
  input.goal = () => 'x';
  const r = validatePlanBrief(input, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /복사할 수 없는/);
  assert.equal(r.normalized, null);
});

test('fs 접근은 주입 함수로만 (주입 없으면 존재 확인 생략)', () => {
  const r = validatePlanBrief(base(), {});
  assert.equal(r.ok, true, err(r));
});

test('goal 한글 80자 통과·81자 거절, 이모지는 코드포인트로 센다', () => {
  const ok = base();
  ok.goal = '가'.repeat(80);
  assert.equal(validatePlanBrief(ok, opts()).ok, true);
  const bad = base();
  bad.goal = '가'.repeat(81);
  const r = validatePlanBrief(bad, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /goal: 80자 초과\(81\)/);
  const emojiOk = base();
  emojiOk.goal = '😀'.repeat(80);
  assert.equal(validatePlanBrief(emojiOk, opts()).ok, true, err(validatePlanBrief(emojiOk, opts())));
  const emojiBad = base();
  emojiBad.goal = '😀'.repeat(81);
  const r2 = validatePlanBrief(emojiBad, opts());
  assert.equal(r2.ok, false);
  assert.match(err(r2), /goal: 80자 초과\(81\)/);
});

test('다른 한도 경계: stageNote 40, what/done 50, component text 60, outOfScope 60', () => {
  const ok = base();
  ok.stageNote = '가'.repeat(40);
  ok.tasks[0].what = '나'.repeat(50);
  ok.tasks[0].done = '다'.repeat(50);
  ok.components[0].text = '라'.repeat(60);
  ok.outOfScope = ['마'.repeat(60)];
  assert.equal(validatePlanBrief(ok, opts()).ok, true, err(validatePlanBrief(ok, opts())));
  const bad = base();
  bad.stageNote = '가'.repeat(41);
  bad.tasks[0].what = '나'.repeat(51);
  bad.tasks[0].done = '다'.repeat(51);
  bad.components[0].text = '라'.repeat(61);
  bad.outOfScope = ['마'.repeat(61)];
  const r = validatePlanBrief(bad, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /stageNote: 40자 초과\(41\)/);
  assert.match(err(r), /tasks\[0\]\.what: 50자 초과\(51\)/);
  assert.match(err(r), /tasks\[0\]\.done: 50자 초과\(51\)/);
  assert.match(err(r), /components\[0\]\.text: 60자 초과\(61\)/);
  assert.match(err(r), /outOfScope\[0\]: 60자 초과\(61\)/);
});

test('배열 개수 상한 거절 (ideal 8, components 8, waves 10, tasks 40, questions 12, outOfScope 6)', () => {
  const spread = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const cases = [
    ['ideal', spread(9, (i) => ({ id: `IS-${i + 1}`, text: 'x' })), /ideal: 8개 초과\(9\)/],
    ['components', spread(9, (i) => ({ id: `C${i}`, label: 'x', text: '' })), /components: 8개 초과\(9\)/],
    ['waves', spread(11, (i) => ({ n: i + 1, label: 'x' })), /waves: 10개 초과\(11\)/],
    ['tasks', spread(41, (i) => ({ id: String(i + 1), wave: 1, label: 'x', what: 'y', done: 'z', deps: [] })), /tasks: 40개 초과\(41\)/],
    ['questions', spread(13, (i) => ({ id: `Q${i + 1}`, text: 'x', state: 'answered', answer: 'y', by: 'owner' })), /questions: 12개 초과\(13\)/],
    ['outOfScope', spread(7, () => 'x'), /outOfScope: 6개 초과\(7\)/],
  ];
  for (const [name, value, re] of cases) {
    const input = base();
    input[name] = value;
    const r = validatePlanBrief(input, opts());
    assert.equal(r.ok, false, name);
    assert.match(err(r), re, name);
  }
});

test('필수 필드 누락 거절', () => {
  for (const name of ['stage', 'stageNote', 'goal', 'ideal', 'components', 'waves', 'tasks', 'questions', 'outOfScope']) {
    const input = base();
    delete input[name];
    const r = validatePlanBrief(input, opts());
    assert.equal(r.ok, false, name);
    assert.match(err(r), new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name);
  }
});

test('stage·state·by 허용 값 밖 거절', () => {
  const a = base();
  a.stage = 'working';
  assert.match(err(validatePlanBrief(a, opts())), /stage: 허용 값/);
  const b = base();
  b.questions[0].state = 'maybe';
  assert.match(err(validatePlanBrief(b, opts())), /questions\[0\]\.state: 허용 값/);
  const c = base();
  c.questions[1].by = 'robot';
  assert.match(err(validatePlanBrief(c, opts())), /questions\[1\]\.by: 허용 값/);
});

test('알 수 없는 필드 거절 (오타로 데이터가 조용히 버려지지 않는다)', () => {
  const a = base();
  a.idealState = ['x'];
  const r = validatePlanBrief(a, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /idealState: 알 수 없는 필드/);
  const b = base();
  b.tasks[0].owner = 'me';
  assert.match(err(validatePlanBrief(b, opts())), /tasks\[0\]\.owner: 알 수 없는 필드/);
  const c = base();
  c.questions[0].answers = 'x';
  assert.match(err(validatePlanBrief(c, opts())), /questions\[0\]\.answers: 알 수 없는 필드/);
  const d = base();
  d.tasks = [{ id: '1', wave: 1, label: 'x', what: 'y', done: 'z', deps: [], order: 3 }];
  assert.match(err(validatePlanBrief(d, opts())), /tasks\[0\]\.order: 알 수 없는 필드/);
});

test('deps: 없는 id·자기 자신·12개 초과 거절, 앞선 id 참조는 통과', () => {
  const missing = base();
  missing.tasks[0].deps = ['9'];
  assert.match(err(validatePlanBrief(missing, opts())), /tasks\[0\]\.deps\[0\]: 같은 입력에 없는 할 일 id\(9\)/);
  const self = base();
  self.tasks[0].deps = ['1'];
  assert.match(err(validatePlanBrief(self, opts())), /tasks\[0\]\.deps\[0\]: 자기 자신을 가리킴\(1\)/);
  const forward = base();
  forward.tasks[0].deps = ['2'];
  assert.equal(validatePlanBrief(forward, opts()).ok, true, err(validatePlanBrief(forward, opts())));
  const many = base();
  many.tasks = Array.from({ length: 14 }, (_, i) => ({ id: String(i + 1), wave: 1, label: 'x', what: 'y', done: 'z', deps: [] }));
  many.tasks[13].deps = many.tasks.slice(0, 13).map((t) => t.id);
  assert.match(err(validatePlanBrief(many, opts())), /tasks\[13\]\.deps: 12개 초과\(13\)/);
});

test('중복 task id 거절', () => {
  const input = base();
  input.tasks[1].id = '1';
  const r = validatePlanBrief(input, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /tasks\[1\]\.id: 중복된 id\(1\)/);
});

test('waves에 없는 wave 거절', () => {
  const input = base();
  input.tasks[0].wave = 3;
  const r = validatePlanBrief(input, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /tasks\[0\]\.wave: waves에 없는 wave\(3\)/);
});

test('open 질문 5개 거절', () => {
  const input = base();
  input.questions = Array.from({ length: 5 }, (_, i) => ({
    id: `Q${i + 1}`,
    text: 'x',
    state: 'open',
    options: { A: { text: 'a', consequence: 'c' }, B: { text: 'b', consequence: 'd' } },
    recommend: 'A',
    reason: 'r',
    blocks: false,
  }));
  const r = validatePlanBrief(input, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /열린 질문 4개 초과\(5\)/);
});

test('answered 인데 answer 없음 거절', () => {
  const input = base();
  delete input.questions[1].answer;
  const r = validatePlanBrief(input, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /questions\[1\]\.answer: 문자열 필요/);
  const empty = base();
  empty.questions[1].answer = '';
  assert.match(err(validatePlanBrief(empty, opts())), /questions\[1\]\.answer: 1자 이상 필요\(현재 0\)/);
});

test('open 인데 options 없음 거절 (brief 결정과 같은 규칙)', () => {
  const input = base();
  delete input.questions[0].options;
  const r = validatePlanBrief(input, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /questions\[0\]\.options: 선택지 2개 이상 필요/);
  const input2 = base();
  input2.questions[0].options = { A: { text: 'a', consequence: 'c' } };
  assert.match(err(validatePlanBrief(input2, opts())), /questions\[0\]\.options: 선택지 2개 이상 필요\(A·B 필수\)/);
  const input3 = base();
  delete input3.questions[0].blocks;
  assert.match(err(validatePlanBrief(input3, opts())), /questions\[0\]\.blocks: 불리언 필요/);
});

test('decisionId가 남의 결정이면 거절, 내 열린 결정이면 통과, 조회 함수 없으면 거절', () => {
  const own = base();
  own.questions[0].decisionId = 1;
  assert.equal(validatePlanBrief(own, opts()).ok, true, err(validatePlanBrief(own, opts())));
  const foreign = base();
  foreign.questions[0].decisionId = 7;
  const r = validatePlanBrief(foreign, opts());
  assert.equal(r.ok, false);
  assert.match(err(r), /questions\[0\]\.decisionId: 이 세션의 열린 결정이 아님\(7\)/);
  const noFn = base();
  noFn.questions[0].decisionId = 1;
  const r2 = validatePlanBrief(noFn, {});
  assert.equal(r2.ok, false);
  assert.match(err(r2), /questions\[0\]\.decisionId: 결정 조회 필요/);
  const throwing = base();
  throwing.questions[0].decisionId = 1;
  const r3 = validatePlanBrief(throwing, opts({ isOwnOpenDecision: () => { throw Object.assign(new Error('lookup denied'), { code: 'EPERM' }); } }));
  assert.equal(r3.ok, false);
  assert.match(err(r3), /questions\[0\]\.decisionId: 결정 조회 실패\(EPERM - lookup denied\)/);
  assert.doesNotMatch(err(r3), /이 세션의 열린 결정이 아님/);
  const plainThrow = base();
  plainThrow.questions[0].decisionId = 1;
  const r4 = validatePlanBrief(plainThrow, opts({ isOwnOpenDecision: () => { throw new Error('boom'); } }));
  assert.match(err(r4), /questions\[0\]\.decisionId: 결정 조회 실패\(Error - boom\)/);
  assert.equal(r4.ok, false);
});

test('ideal/components/waves id 형식과 중복 거절', () => {
  const a = base();
  a.ideal = [{ id: 'IS-100', text: 'x' }];
  assert.match(err(validatePlanBrief(a, opts())), /ideal\[0\]\.id: IS-1 형식 필요/);
  const b = base();
  b.ideal = [{ id: 'IS-1', text: 'x' }, { id: 'IS-1', text: 'y' }];
  assert.match(err(validatePlanBrief(b, opts())), /ideal\[1\]\.id: 중복된 id\(IS-1\)/);
  const c = base();
  c.components = [{ id: '가'.repeat(13), label: 'x', text: '' }];
  assert.match(err(validatePlanBrief(c, opts())), /components\[0\]\.id: 12자 초과\(13\)/);
  const d = base();
  d.components = [{ id: 'C1', label: 'x', text: '' }, { id: 'C1', label: 'y', text: '' }];
  assert.match(err(validatePlanBrief(d, opts())), /components\[1\]\.id: 중복된 id\(C1\)/);
  const e = base();
  e.waves = [{ n: 1, label: 'x' }, { n: 1, label: 'y' }];
  assert.match(err(validatePlanBrief(e, opts())), /waves\[1\]\.n: 중복된 wave\(1\)/);
  const f = base();
  f.tasks[0].id = 'F9999';
  assert.match(err(validatePlanBrief(f, opts())), /tasks\[0\]\.id: F\?\\d\{1,3\}\[a-z\]\? 형식 필요/);
  const g = base();
  g.waves = [{ n: 0, label: 'x' }];
  g.tasks[0].wave = 1;
  assert.match(err(validatePlanBrief(g, opts())), /waves\[0\]\.n: 1..99 정수 필요\(0\)/);
});

test('입력이 객체가 아니면 거절', () => {
  for (const bad of [null, undefined, 'x', 7, []]) {
    const r = validatePlanBrief(bad, opts());
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.normalized, null);
    assert.equal(r.planId, null);
  }
});

test('planIdOf: 대소문자·NFD/NFC·구분자 차이는 같은 값, 다른 slug는 다른 값', () => {
  const root = 'C:/Users/USER/orca/projects/기타 작업';
  const id = planIdOf(root, 'piomo-briefing-plan-view');
  assert.match(id, /^p[0-9a-f]{12}$/);
  assert.equal(planIdOf('C:/users/user/orca/projects/기타 작업', 'PIOMO-BRIEFING-PLAN-VIEW'), id);
  assert.equal(planIdOf('C:\\Users\\USER\\orca\\projects\\기타 작업', 'piomo-briefing-plan-view'), id);
  assert.equal(planIdOf(root.normalize('NFD'), 'piomo-briefing-plan-view'.normalize('NFD')), id);
  assert.equal(planIdOf(root + '/', 'piomo-briefing-plan-view'), id);
  assert.notEqual(planIdOf(root, 'other-plan'), id);
  assert.notEqual(planIdOf(root + '/x', 'piomo-briefing-plan-view'), id);
});

test('rootAndSlugOf: .omo 상위 폴더(소문자·NFC)와 확장자 없는 파일명', () => {
  assert.deepEqual(rootAndSlugOf(PLAN), { root: 'c:/users/user/orca/projects/기타 작업', slug: 'piomo-briefing-plan-view' });
  assert.deepEqual(rootAndSlugOf('C:\\x\\.omo\\drafts\\a.md'), { root: 'c:/x', slug: 'a' });
  assert.equal(rootAndSlugOf(PLAN).root, rootAndSlugOf(PLAN).root.normalize('NFC').toLowerCase());
  for (const bad of [null, 'plans/a.md', 'C:/x/notes/a.md', 'C:/x/.omo/plans/a.txt', 'C:/x/.omo/plans/a.md.bak']) {
    assert.equal(rootAndSlugOf(bad), null, String(bad));
  }
});

test('T2-ROOT: extracted root is lowercase NFC', () => {
  const result = rootAndSlugOf(
    'C:/PROJECT/가'.normalize('NFD') + '/.omo/plans/a.md',
  );
  assert.equal(result.root, 'c:/project/가');
});

test('초안과 계획이 같은 planId, 다른 파일은 다른 planId', () => {
  const a = rootAndSlugOf(PLAN);
  const b = rootAndSlugOf(DRAFT);
  assert.equal(planIdOf(a.root, a.slug), planIdOf(b.root, b.slug));
  const r = validatePlanBrief({ ...base(), planPath: undefined }, opts());
  assert.equal(r.ok, true, err(r));
  assert.equal(r.planId, planIdOf(b.root, b.slug));
});

test('도구 스키마+설명 직렬화 크기 3072바이트 이하', () => {
  const bytes = Buffer.byteLength(JSON.stringify(PLAN_BRIEF_PARAMETERS) + PLAN_BRIEF_DESCRIPTION, 'utf8');
  assert.ok(bytes <= 3072, `바이트 ${bytes}`);
  assert.equal(typeof PLAN_BRIEF_DESCRIPTION, 'string');
  assert.match(PLAN_BRIEF_DESCRIPTION, /plan_brief|계획/);
  assert.deepEqual(PLAN_BRIEF_PARAMETERS.required, ['stage', 'stageNote', 'goal', 'ideal', 'components', 'waves', 'tasks', 'questions', 'outOfScope']);
  assert.deepEqual(PLAN_BRIEF_PARAMETERS.properties.stage.enum, ['shaping', 'gate', 'review', 'ready', 'running', 'done', 'dropped']);
});

test('성공 응답은 조용히 값을 바꾸지 않는다 (misleading_success_output)', () => {
  const input = base();
  input.questions[0].decisionId = 1;
  const r = validatePlanBrief(input, opts());
  assert.equal(r.ok, true, err(r));
  assert.deepEqual(r.normalized, JSON.parse(JSON.stringify(input)));
  assert.equal(r.normalized.questions[0].decisionId, 1);
  assert.equal(r.errors.length, 0);
  const partial = base();
  partial.outOfScope = ['x'.repeat(61)];
  const r2 = validatePlanBrief(partial, opts());
  assert.equal(r2.ok, false);
  assert.equal(r2.normalized, null);
  assert.equal(r2.planId, null);
});
