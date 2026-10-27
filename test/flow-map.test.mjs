// Flow-map format validation test for switcher-flow-restore
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
