// Flow-map format validation test for switcher-flow-restore
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkF8, comparisonSections, comparisonSteps, requireF8 } from '../scripts/flow-map-f8.mjs';
import { RAW_NAME_COPY, RAW_STATUS_COPY } from '../scripts/profiles-copy.mjs';

test('F6 copy migrates only raw names and statuses while captions and width/step checks stay intact', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/qa-flow-map.mjs'), 'utf8');
  const baseline = ['현재 전역 적용', '전역 적용 중', '권장 배치 가이드', '적용 중', '적용', '메인: ', '서비스: ',
    '모델 라우팅 · 전담 에이전트 / 작업 카테고리', '공통 설정 · Kibitzer 회상', '공통 설정 · Reflection 성찰', '전담 에이전트 · Agents',
    '탐색 · 자료 조사', '계획 · 조언', '검토 · QA', '작업 카테고리 · Categories', '빠른 작업 · 일반 작업', '심층 추론', '전문 작업',
    '메인 모델 설정', '요약 담당 모델', '이 프로필 적용하기', '1. 구독 서비스', '2. AI 모델', '3. 추론 강도',
    '공통 / 전체 · Kibitzer 회상', '공통 / 전체 · Reflection 성찰', 'quick 공유 (기본)', '직접 선택', '현재: ', '보류: ',
    '1. 제공사', '원본 기본 컴팩션'];
  const expression = /const STATIC_COPY = (\[[\s\S]*?\]\.map\(copy => RAW_NAME_COPY\[copy\] \|\| RAW_STATUS_COPY\[copy\] \|\| copy\));/.exec(source);
  assert.ok(expression, 'F6 uses the raw-name map');
  const after = Function('RAW_NAME_COPY', 'RAW_STATUS_COPY', `return ${expression[1]}`)(RAW_NAME_COPY, RAW_STATUS_COPY);
  assert.equal(after.length, baseline.length);
  assert.deepEqual(after, baseline.map(copy => RAW_NAME_COPY[copy] || RAW_STATUS_COPY[copy] || copy));
  assert.equal(Object.keys(RAW_NAME_COPY).length, 14);
  for (const caption of ['1. 구독 서비스', '2. AI 모델', '3. 추론 강도', '1. 제공사', '원본 기본 컴팩션', '이 프로필 적용하기']) {
    assert.ok(after.includes(caption), caption);
  }
  assert.match(source, /map\.copy = .*__flow\.copy/);
  assert.match(source, /F6/);
});

const REQUIRED_REGIONS = [
  'status', 'guide', 'cards', 'detail', 'roles', 'lane', 'main', 'summarizer', 'apply', 'message'
];

const REQUIRED_SECTIONS = [
  'kibitzer', 'reflection', 'agents:explore-research', 'agents:plan-advice', 'agents:review-qa',
  'categories:quick-general', 'categories:deep', 'categories:specialist', 'lane', 'main', 'summarizer', 'apply'
];

const EXPECTED_ROW_KEYS = ['role', 'memory', 'summarizer', 'main'];

const CONTROL_ID_REGEX = /^(?:card:[a-z0-9_-]+|apply:card:[a-z0-9_-]+|apply:detail|role:[a-z0-9_-]+\/[a-z0-9_-]+:(?:service|model|effort)|memory:(?:kibitzer|reflection):(?:mode|service|model|effort))$/;

function validateFlowMap(map, sourceName) {
  assert.equal(map.schema, 'flow-map/1', `${sourceName}: schema must be flow-map/1`);
  assert.ok(map.source === 'winforms' || map.source === 'board', `${sourceName}: source must be winforms or board`);
  assert.equal(typeof map.fixtureHash, 'string', `${sourceName}: fixtureHash must be string`);
  assert.equal(map.fixtureHash.length, 64, `${sourceName}: fixtureHash must be 64-char sha256`);
  
  // frame validation
  assert.ok(map.frame, `${sourceName}: frame must exist`);
  assert.equal(typeof map.frame.width, 'number', `${sourceName}: frame.width must be number`);
  assert.equal(typeof map.frame.height, 'number', `${sourceName}: frame.height must be number`);
  assert.ok(map.frame.inner, `${sourceName}: frame.inner must exist`);
  assert.equal(typeof map.frame.inner.w, 'number');
  assert.equal(typeof map.frame.inner.h, 'number');
  assert.equal(typeof map.frame.sidebar, 'boolean');

  // regions validation
  assert.ok(Array.isArray(map.regions), `${sourceName}: regions must be array`);
  const regionIds = new Set(map.regions.map(r => r.id));
  for (const req of REQUIRED_REGIONS) {
    assert.ok(regionIds.has(req), `${sourceName}: missing region '${req}'`);
  }
  for (const r of map.regions) {
    assert.ok(r.box, `${sourceName}: region ${r.id} missing box`);
    assert.equal(typeof r.box.x, 'number');
    assert.equal(typeof r.box.y, 'number');
    assert.equal(typeof r.box.w, 'number');
    assert.equal(typeof r.box.h, 'number');
  }

  // sections validation
  assert.ok(Array.isArray(map.sections), `${sourceName}: sections must be array`);
  for (const req of REQUIRED_SECTIONS) {
    assert.ok(map.sections.includes(req), `${sourceName}: sections missing '${req}'`);
  }

  // rows validation
  assert.ok(map.rows, `${sourceName}: rows must exist`);
  const actualRowKeys = Object.keys(map.rows);
  assert.deepEqual(
    actualRowKeys.slice().sort(),
    EXPECTED_ROW_KEYS.slice().sort(),
    `${sourceName}: rows keys must be exactly [${EXPECTED_ROW_KEYS.join(', ')}], got [${actualRowKeys.join(', ')}]`
  );
  assert.ok(map.rows.role, `${sourceName}: rows.role must exist`);
  assert.ok(map.rows.memory, `${sourceName}: rows.memory must exist`);
  assert.ok(map.rows.summarizer, `${sourceName}: rows.summarizer must exist`);
  assert.ok(map.rows.main, `${sourceName}: rows.main must exist`);

  // tasks validation
  assert.ok(map.tasks, `${sourceName}: tasks must exist`);
  assert.ok(Array.isArray(map.tasks.role), `${sourceName}: tasks.role must be array`);
  assert.ok(Array.isArray(map.tasks.profile), `${sourceName}: tasks.profile must be array`);
  assert.ok(Array.isArray(map.tasks.memory), `${sourceName}: tasks.memory must be array`);

  for (const taskName of ['role', 'profile', 'memory']) {
    for (const step of map.tasks[taskName]) {
      assert.equal(typeof step.control, 'string', `${sourceName} ${taskName}: step control must be string`);
      assert.match(
        step.control,
        CONTROL_ID_REGEX,
        `${sourceName} ${taskName}: step control '${step.control}' must match plan control grammar`
      );
      assert.equal(typeof step.region, 'string', `${sourceName} ${taskName}: step region must be string`);
      assert.ok(step.box, `${sourceName} ${taskName}: step box must exist`);
      assert.equal(typeof step.box.x, 'number');
      assert.equal(typeof step.box.y, 'number');
      assert.equal(typeof step.box.w, 'number');
      assert.equal(typeof step.box.h, 'number');
      assert.equal(typeof step.scrolls, 'number');
    }
  }
}

function loadFlowMap() {
  let p = join(process.cwd(), 'test/fixtures/profiles/flow-map.winforms.json');
  if (!existsSync(p)) {
    p = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/switcher-flow-restore/task-3/stage/test/fixtures/profiles/flow-map.winforms.json';
  }
  assert.ok(existsSync(p), `flow-map.winforms.json must exist at ${p}`);
  const raw = readFileSync(p, 'utf8');
  return { map: JSON.parse(raw), path: p };
}

test('flow-map.winforms.json has exact rows keys [role, memory, summarizer, main]', () => {
  const { map } = loadFlowMap();
  const actualRowKeys = Object.keys(map.rows);
  assert.deepEqual(
    actualRowKeys.slice().sort(),
    EXPECTED_ROW_KEYS.slice().sort(),
    `rows keys must be exactly [${EXPECTED_ROW_KEYS.join(', ')}], got [${actualRowKeys.join(', ')}]`
  );
});

test('flow-map.winforms.json task step control IDs match plan grammar', () => {
  const { map } = loadFlowMap();
  for (const taskName of ['role', 'profile', 'memory']) {
    for (const step of map.tasks[taskName]) {
      assert.match(
        step.control,
        CONTROL_ID_REGEX,
        `${taskName} step control '${step.control}' must match plan grammar`
      );
    }
  }
});

test('flow-map.winforms.json conforms to flow-map/1 schema', () => {
  const { map } = loadFlowMap();
  validateFlowMap(map, 'flow-map.winforms.json');
});

test('flow-map.rules.json conforms to rules schema and covers F1-F7', () => {
  let p = join(process.cwd(), 'test/fixtures/profiles/flow-map.rules.json');
  if (!existsSync(p)) {
    p = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/switcher-flow-restore/task-3/stage/test/fixtures/profiles/flow-map.rules.json';
  }
  assert.ok(existsSync(p), `flow-map.rules.json must exist at ${p}`);
  const raw = readFileSync(p, 'utf8');
  const rulesObj = JSON.parse(raw);
  assert.ok(rulesObj.rules, 'rules object must exist');
  for (let i = 1; i <= 7; i++) {
    const key = `F${i}`;
    assert.ok(rulesObj.rules[key], `rules must contain ${key}`);
    assert.equal(typeof rulesObj.rules[key].description, 'string');
  }
});

test('F8 is additive: every navigation check is required and removing any one fails', () => {
  const rules = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/profiles/flow-map.rules.json'), 'utf8'));
  const original = Object.fromEntries(Object.entries(rules.rules).filter(([id]) => id !== 'F8'));
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'),
    'ae9f568beac7a81af50edbdd144b1aa670e574ce62598ff521190107f6ff68a4',
    'F1-F7 stay identical to d282b3b; additions belong in F8');
  requireF8(rules);
  assert.deepEqual(rules.rules.F8.checks, [
    'row-open-excluded-from-steps', 'row-open-before-selects', 'tab-click-excluded-from-steps',
    'primary-excluded-from-F1', 'memory-document-order', 'purpose-group-grid-navigation',
  ]);
  for (const removed of rules.rules.F8.checks) {
    const changed = structuredClone(rules);
    changed.rules.F8.checks = changed.rules.F8.checks.filter((check) => check !== removed);
    assert.throws(() => requireF8(changed), /F8 check removed/);
  }
  const noF8 = structuredClone(rules);
  delete noF8.rules.F8;
  assert.throws(() => requireF8(noF8), /F8 check removed/);
});

test('F8 checks disclosure, tab preparation, memory document order and only additive comparison exclusions', () => {
  const { map: reference } = loadFlowMap();
  const preparation = { row: { expanded: true }, tab: { selected: true } };
  const order = ['route:categories/deep-low', 'route:categories/deep-high', 'route:categories/ultrabrain'];
  const grid = {
    tabs: Object.fromEntries(['primary', 'agents', 'categories', 'memory'].map(tab => [tab, {
      columns: 1, tracks: '500px', gap: 12, horizontalScroll: 0, maxRowHeight: 28,
      groups: [{ id: tab, span: '1 / -1', scroll: 'visible', rows: tab === 'categories' ? order : [] }],
    }])),
    expanded: [{ row: 'route:categories/deep-high', group: 'categories:deep', span: '1 / -1',
      openGroups: ['categories:deep'], widths: [160, 160, 160], topmost: [true, true, true], horizontalScroll: 0 }],
    navigation: { closed: { dom: order, visual: order, keyboard: order }, search: { dom: order, visual: order, keyboard: order } },
    boundaries: [{ width: 611, columns: 1 }, { width: 612, columns: 2 }],
  };
  const board = {
    frame: { width: 1180 },
    purposeGrid: grid,
    sections: ['primary', ...reference.sections],
    tasks: Object.fromEntries(Object.entries(reference.tasks).map(([task, steps]) => [task,
      steps.map((step) => ({ ...step, preparation: structuredClone(preparation) }))])),
    rows: { preparation: { role: structuredClone(preparation), memory: structuredClone(preparation) } },
  };
  assert.deepEqual(checkF8(board, reference), []);
  assert.deepEqual(comparisonSections(board.sections), reference.sections);
  const tabOrder = board.sections.filter(id => id !== 'kibitzer' && id !== 'reflection');
  const tail = tabOrder.findIndex(id => id === 'lanes');
  tabOrder.splice(tail < 0 ? tabOrder.length : tail, 0, 'kibitzer', 'reflection');
  assert.deepEqual(comparisonSections(tabOrder), reference.sections, 'legacy comparison adapts the real tab order');
  assert.deepEqual(comparisonSteps([{ control: 'tab:agents' }, { control: 'row-open:agents/explore' }, ...board.tasks.role]), board.tasks.role);
  assert.deepEqual(comparisonSections(['unexpected', ...board.sections]), ['unexpected', ...reference.sections], 'no other F1 section is excluded');
  const variants = [
    ['row-open-excluded-from-steps', (b) => b.tasks.role.unshift({ control: 'row-open:agents/explore' })],
    ['row-open-before-selects', (b) => { b.rows.preparation.memory.row.expanded = false; }],
    ['row-open-before-selects', (b) => { b.tasks.memory[0].preparation.row.expanded = false; }],
    ['tab-click-excluded-from-steps', (b) => b.tasks.memory.unshift({ control: 'tab:memory' })],
    ['tab-click-excluded-from-steps', (b) => { b.tasks.memory[0].preparation.tab.selected = false; }],
    ['primary-excluded-from-F1', (b) => { b.sections.shift(); }],
    ['memory-document-order', (b) => {
      const k = b.sections.indexOf('kibitzer'), r = b.sections.indexOf('reflection');
      [b.sections[k], b.sections[r]] = [b.sections[r], b.sections[k]];
    }],
    ['purpose-group-grid-navigation', (b) => { b.purposeGrid.boundaries[1].columns = 1; }],
    ['purpose-group-grid-navigation', (b) => { b.purposeGrid.expanded[0].widths[2] += 2; }],
    ['purpose-group-grid-navigation', (b) => { b.purposeGrid.navigation.search.keyboard = order.slice().reverse(); }],
    ['purpose-group-grid-navigation', (b) => { b.purposeGrid.navigation.closed.visual = order.slice().reverse(); }],
    ['purpose-group-grid-navigation', (b) => { b.tasks.role[1].box.container = 'different-frame'; }],
  ];
  for (const [check, mutate] of variants) {
    const changed = structuredClone(board);
    mutate(changed);
    assert.ok(checkF8(changed, reference).some((failure) => failure.check === check), check);
  }
});


test('board: the docked message tray is inside the viewport at both fixture sizes', { timeout: 280000 }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const out = mkdtempSync(join(tmpdir(), 'omo-flow-tray-'));
  try {
    execFileSync(process.execPath, ['scripts/qa-flow-map.mjs', '--out', out], { cwd: process.cwd(), stdio: 'pipe', timeout: 270000 });
    for (const size of ['1180x700', '1600x900']) {
      const map = JSON.parse(readFileSync(join(out, `flow-map.board-${size}.json`), 'utf8'));
      const box = map.regions.find((r) => r.id === 'message').box;
      assert.ok(box.y >= 0, `${size}: message top ${box.y} is on screen`);
      assert.ok(box.y + box.h <= map.frame.inner.h + 1, `${size}: message bottom ${box.y + box.h} is inside ${map.frame.inner.h}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
