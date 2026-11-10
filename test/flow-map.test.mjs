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
  // routeRow's primary triple precedes backupFields' direct triple and registered alias.
  const backupWidth = 3 * 160 + 2 * 4;
  const fields = [
    ['route-provider', '1. 구독 서비스', 160],
    ['route-model', '2. AI 모델', 160],
    ['route-thinking', '3. 추론 강도', 160],
    ['backup-provider', '백업 1. 서비스', 160],
    ['backup-model', '백업 2. 모델', 160],
    ['backup-thinking', '백업 3. 추론강도', 160],
    ['route-backup', '기존 등록 별칭', backupWidth],
  ].map(([name, caption, width]) => ({
    name, caption, width, route: 'categories/deep-high', height: 28, topmost: true,
  }));
  const grid = {
    tabs: Object.fromEntries(['primary', 'agents', 'categories', 'memory'].map(tab => [tab, {
      viewportWidth: 1180, containerWidth: 620, columns: 1, tracks: '500px',
      gap: tab === 'memory' ? 12 : 20,
      horizontalScroll: 0, maxRowHeight: 28,
      maxNonRouteRowHeight: (tab === 'primary' || tab === 'memory') ? 28 : 0,
      clippedCells: [],
      cellOverlaps: [],
      ownerEscapes: [],
      groups: [{ id: tab, span: '1 / -1', scroll: 'visible', rows: tab === 'categories' ? order : [] }],
    }])),
    expanded: [{ row: 'route:categories/deep-high', group: 'categories:deep', span: '1 / -1',
      openGroups: ['categories:deep'],
      editor: { order: fields.map(field => field.name), primary: fields.slice(0, 3),
        directBackup: fields.slice(3, 6), alias: fields.slice(6), backupWidth },
      widths: [160, 160, 160], topmost: [true, true, true], horizontalScroll: 0 }],
    navigation: { closed: { dom: order, visual: order, keyboard: order }, search: { dom: order, visual: order, keyboard: order } },
    boundaries: [{ width: 611, columns: 1 }, { width: 612, columns: 1 }],
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
  // Positive wrapped height verification under #1197 A: route summaries allow needed height for lossless content reflow
  const wrappedBoard = structuredClone(board);
  wrappedBoard.purposeGrid.tabs.agents.maxRowHeight = 64;
  wrappedBoard.purposeGrid.tabs.categories.maxRowHeight = 72;
  assert.deepEqual(checkF8(wrappedBoard, reference), [], 'route rows allow wrapped needed height under #1197');
  // Genuine synthetic phone frame 390 under #1202 A & #1204: tab viewportWidth 390, phone Memory gap 20, and nonroute Memory 75.5 acceptance
  const phoneBoard = structuredClone(board);
  phoneBoard.frame = { width: 390 };
  for (const [tabName, tab] of Object.entries(phoneBoard.purposeGrid.tabs)) {
    tab.viewportWidth = 390;
    tab.containerWidth = 358;
    tab.gap = 20; // phone Memory remains 20 per #1204
  }
  phoneBoard.purposeGrid.tabs.memory.maxNonRouteRowHeight = 75.5;
  phoneBoard.purposeGrid.tabs.memory.maxRowHeight = 75.5;
  assert.deepEqual(checkF8(phoneBoard, reference), [], 'phone 390 accepts nonroute Memory 75.5 under #1202');
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
    ['purpose-group-grid-navigation', (b) => { b.purposeGrid.boundaries[1].columns = 2; }],
    ['purpose-group-grid-navigation', (b) => { b.purposeGrid.boundaries[0].columns = 2; }],
    ['purpose-group-grid-navigation', (b) => {
      b.purposeGrid.tabs.agents.clippedCells.push({
        row: 'route:agents/explore', cell: 'model', scrollWidth: 160, clientWidth: 120,
      });
    }],
    // Prior 33/57 fixed route height failures invalidated by #1197 A (lossless content reflow / needed height).
    // Replaced with cell overlap, missing metric, and owner containment escape failures:
    ['purpose-group-grid-navigation', (b) => {
      b.purposeGrid.tabs.agents.cellOverlaps.push({
        row: 'route:agents/explore', pair: ['model', 'status'], xOverlap: 12, yOverlap: 8,
      });
    }],
    ['purpose-group-grid-navigation', (b) => {
      delete b.purposeGrid.tabs.agents.cellOverlaps;
    }],
    ['purpose-group-grid-navigation', (b) => {
      delete b.purposeGrid.tabs.agents.clippedCells;
    }],
    ['purpose-group-grid-navigation', (b) => {
      delete b.purposeGrid.tabs.agents.ownerEscapes;
    }],
    ['purpose-group-grid-navigation', (b) => {
      b.purposeGrid.tabs.agents.ownerEscapes = [{ row: 'route:agents/explore', cell: 'status' }];
    }],
    ['purpose-group-grid-navigation', (b) => {
      delete b.purposeGrid.tabs.primary.viewportWidth;
    }],
    ['purpose-group-grid-navigation', (b) => {
      delete b.purposeGrid.tabs.primary.maxNonRouteRowHeight;
    }],
    ['purpose-group-grid-navigation', (b) => {
      b.purposeGrid.tabs.primary.maxNonRouteRowHeight = 33;
    }],
    // #1204 negative: wrong Memory gap at viewportWidth >= 900 (e.g. 20 instead of 12) fails
    ['purpose-group-grid-navigation', (b) => {
      b.purposeGrid.tabs.memory.gap = 20;
    }],
    // #1204 negative: wrong other tab gap at viewportWidth >= 900 (e.g. 12 instead of 20) fails
    ['purpose-group-grid-navigation', (b) => {
      b.purposeGrid.tabs.primary.gap = 12;
    }],
    ['purpose-group-grid-navigation', (b) => { b.purposeGrid.expanded[0].editor.primary[2].width += 2; }],
    ['purpose-group-grid-navigation', (b) => { b.purposeGrid.expanded[0].editor.directBackup[2].width += 2; }],
    ['purpose-group-grid-navigation', (b) => { b.purposeGrid.expanded[0].editor.alias[0].width -= 2; }],
    ...['primary', 'directBackup', 'alias'].map(group => ['purpose-group-grid-navigation', (b) => {
      const editor = b.purposeGrid.expanded[0].editor;
      const removed = editor[group].pop();
      editor.order = editor.order.filter(name => name !== removed.name);
    }]),
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


test('board: the message tray sits in flat flow below cards/detail and is reachable inside #main as the sole vertical scroller at both fixture sizes (#849 A)', { timeout: 280000 }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, readdirSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { launch } = await import('../scripts/cdp.mjs');
  const { startBoard, settle, openScreen } = await import('../scripts/qa-flow-map.mjs');
  const out = mkdtempSync(join(tmpdir(), 'omo-flow-tray-'));
  let boardServer = null;
  let page = null;
  try {
    try {
      execFileSync(process.execPath, ['scripts/qa-flow-map.mjs', '--out', out], { cwd: process.cwd(), stdio: 'pipe', timeout: 270000 });
    } catch (childError) {
      const status = childError.status;
      const signal = childError.signal;
      const stdout = Buffer.isBuffer(childError.stdout) ? childError.stdout.toString('utf8') : (childError.stdout || '');
      const stderr = Buffer.isBuffer(childError.stderr) ? childError.stderr.toString('utf8') : (childError.stderr || '');
      const reportEntries = [];
      for (const name of readdirSync(out).sort()) {
        if (/^flow-diff-.*\.json$/.test(name) || name === 'flow-map-run.json') {
          reportEntries.push(`--- ${name} ---\n${readFileSync(join(out, name), 'utf8').trim()}`);
        }
      }
      const parts = [
        `scripts/qa-flow-map.mjs child process failed (status=${status}, signal=${signal})`,
        stdout ? `--- stdout ---\n${stdout.trim()}` : '',
        stderr ? `--- stderr ---\n${stderr.trim()}` : '',
        ...reportEntries,
      ].filter(Boolean);
      throw new Error(parts.join('\n\n'), { cause: childError });
    }

    boardServer = await startBoard(join(out, 'verify-board'));
    page = await launch({ width: 1180, height: 700 });

    for (const size of ['1180x700', '1600x900']) {
      const [w, h] = size.split('x').map(Number);
      await page.client.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await openScreen(page, boardServer.url);
      await settle(page);

      const map = JSON.parse(readFileSync(join(out, `flow-map.board-${size}.json`), 'utf8'));
      const access = map.messageAccess;
      assert.deepEqual(access.owners, ['main'], `${size}: only main owns vertical scroll`);
      assert.ok(access.after > access.before, `${size}: main actually scrolls to the tray`);
      assert.equal(access.windowAfter, access.windowBefore, `${size}: document does not scroll`);
      assert.ok(access.visible && access.onTop, `${size}: reached tray is visible and unoccluded`);
      assert.ok(access.top >= access.mainTop && access.top >= 0, `${size}: tray top is inside main`);
      assert.ok(access.bottom <= access.mainBottom + 1 && access.bottom <= map.frame.inner.h + 1, `${size}: tray bottom is inside main and viewport`);
      const cards = map.regions.find((r) => r.id === 'cards').box;
      const detail = map.regions.find((r) => r.id === 'detail').box;
      const msgRegion = map.regions.find((r) => r.id === 'message');
      const box = msgRegion.box;
      const panesBottom = Math.max(cards.y + cards.h, detail.y + detail.h);
      assert.equal(msgRegion.inDetail, false, `${size}: message tray is outside .pf-detail`);
      assert.ok(box.w > 0 && box.h > 0, `${size}: message tray has positive dimensions`);
      assert.ok(box.y >= cards.y + cards.h && box.y >= detail.y + detail.h, `${size}: message top ${box.y} sits below cards (${cards.y + cards.h}) and detail (${detail.y + detail.h})`);
      assert.ok(box.y + box.h <= panesBottom + box.h + 48 && box.y + box.h <= map.frame.inner.h * 2, `${size}: message bottom ${box.y + box.h} is reachable within #main scroll extent`);
      for (const [taskName, steps] of Object.entries(map.tasks)) {
        for (const step of steps) {
          assert.equal(step.box.container, '#main', `${size} ${taskName} ${step.control}: #main is the sole vertical scroll container`);
          assert.ok(step.scrolls <= 1, `${size} ${taskName} ${step.control}: reachable within S <= 1 (got ${step.scrolls})`);
          for (const mv of step.moved || []) {
            assert.equal(mv.container, '#main', `${size} ${taskName} ${step.control}: only #main may scroll vertically`);
          }
          assert.equal(step.hit && step.hit.onTop, true, `${size} ${taskName} ${step.control}: control is not occluded by tray`);
          assert.ok(
            step.live.message.y >= step.live.cards.y + step.live.cards.h &&
            step.live.message.y >= step.live.detail.y + step.live.detail.h,
            `${size} ${taskName} ${step.control}: live message tray stays below cards and detail`
          );
        }
      }
      const roleApply = map.tasks.role.find((s) => s.control === 'apply:detail');
      assert.ok(roleApply, `${size}: apply:detail step exists`);

      // Measure actual reachability of the message tray in #main:
      // Scrolling #main to the tray must place the tray fully inside #main's visible extent,
      // and the tray's bottom in #main's coordinate space must not exceed #main's scrollHeight.
      const trayReach = await page.eval(`(() => {
        const main = document.querySelector('#main');
        const tray = document.querySelector('[data-flow="message"]');
        if (!main || !tray) return { missing: true };

        const mrBefore = main.getBoundingClientRect();
        const trBefore = tray.getBoundingClientRect();
        const trayBottomInMain = (trBefore.bottom - mrBefore.top) + main.scrollTop;

        tray.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });

        const mr = main.getBoundingClientRect();
        const tr = tray.getBoundingClientRect();
        const visibleInMain = tr.top >= mr.top && tr.bottom <= mr.bottom;
        const reachedBottom = trayBottomInMain <= main.scrollHeight;

        return {
          missing: false,
          visibleInMain,
          reachedBottom,
          mainScrollTop: main.scrollTop,
          mainScrollHeight: main.scrollHeight,
          trayBottomInMain,
        };
      })()`);

      assert.equal(trayReach.missing, false, `${size}: #main and message tray must exist in DOM`);
      assert.equal(trayReach.visibleInMain, true, `${size}: message tray becomes visible inside #main viewport when scrolled into view`);
      assert.equal(trayReach.reachedBottom, true, `${size}: message tray bottom (${trayReach.trayBottomInMain}) is reachable within #main scroll extent (${trayReach.mainScrollHeight})`);
    }
  } finally {
    if (page) await page.close().catch(() => {});
    if (boardServer && boardServer.server) await boardServer.server.close().catch(() => {});
    rmSync(out, { recursive: true, force: true });
  }
});
