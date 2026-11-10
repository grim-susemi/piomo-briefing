// R: #1207 spatial contract at the existing public diff boundary; no browser or fixture mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diff } from '../scripts/qa-flow-map.mjs';

const reference = JSON.parse(readFileSync(new URL('./fixtures/profiles/flow-map.winforms.json', import.meta.url)));
const rules = JSON.parse(readFileSync(new URL('./fixtures/profiles/flow-map.rules.json', import.meta.url)));
const cases = [
  { name: 'one', width: 473, rem: 16, track: 473, xs: [100, 100, 100], ys: [120, 172, 224], rows: 3, strict: 8 },
  { name: 'two', width: 748, rem: 16, track: 372, xs: [100, 476, 100], ys: [120, 120, 172], rows: 2, strict: 6 },
  { name: 'three', width: 872, rem: 16, track: 288, xs: [100, 392, 684], ys: [120, 120, 120], rows: 1, strict: 0 },
  { name: 'below two fit', width: 579, rem: 16, track: 579, xs: [100, 100, 100], ys: [120, 172, 224], rows: 3, strict: 8 },
  { name: 'two fit', width: 580, rem: 16, track: 288, xs: [100, 392, 100], ys: [120, 120, 172], rows: 2, strict: 6 },
  { name: 'below three fit', width: 871, rem: 16, track: 433.5, xs: [100, 537.5, 100], ys: [120, 120, 172], rows: 2, strict: 6 },
  { name: 'larger root', width: 872, rem: 20, track: 434, xs: [100, 538, 100], ys: [120, 120, 172], rows: 2, strict: 6 },
  { name: 'owner below floor', width: 240, rem: 16, track: 240, xs: [100, 100, 100], ys: [120, 172, 224], rows: 3, strict: 8 },
];

function fixture(c) {
  const board = structuredClone(reference);
  board.source = 'board';
  // A small viewport is deliberately unrelated to protected owner allocation.
  board.frame.width = 390;
  board.copy = { missing: [] };
  board.rows.role.editor = { order: [], primary: [], directBackup: [], alias: [], backupWidth: 0 };
  for (const task of ['role', 'memory']) {
    const memory = task === 'memory', group = memory ? 'memory:kibitzer' : 'role:agents/explore';
    const offset = memory ? 52 : 0, height = c.rows * 48 + (c.rows - 1) * 4;
    const metrics = (y, h) => ({ box: { x: 100, y, w: c.width, h, container: '#main' },
      padding: [0, 0, 0, 0], inset: [0, 0, 0, 0], display: 'grid', rowGap: 4, columnGap: 4 });
    const field = (part, box, parent) => ({
      control: group + ':' + part, group, binding: group.slice(group.indexOf(':') + 1), parent,
      box: { ...box, h: 28, container: '#main' }, labelHeight: 48, captionHeight: 18, labelGap: 2,
      captionScroll: 0, selectedWidth: 100, available: box.w - 40,
    });
    const fields = ['service', 'model', 'effort'].map((part, i) =>
      field(part, { x: c.xs[i], y: c.ys[i] + offset, w: c.track }, 'triplet'));
    if (memory) fields.unshift(field('mode', { x: 100, y: 120, w: c.width }, 'mode'));
    for (const step of board.tasks[task].filter(s => s.control.startsWith(group + ':'))) {
      step.box = structuredClone(fields.find(f => f.control === step.control).box);
      step.responsive = { schema: 'flow-responsive/1', group, row: group,
        selector: memory ? 'memory' : 'route', section: memory ? 'kibitzer' : 'agents:explore-research',
        rootRem: c.rem, owner: metrics(100, height + offset), grid: metrics(100 + offset, height),
        occupancy: [
          ...[0, 1, 2].map(() => ({ kind: 'field', start: 'auto', end: 'auto', binding: null })),
          ...(memory ? [] : [{ kind: 'full-id', start: '1', end: '-1', binding: null },
            { kind: 'backup', start: '1', end: '-1', binding: 'agents/explore' }]),
        ],
        fields: structuredClone(fields) };
    }
  }
  return board;
}

const compare = board => diff(board, reference, rules, 'independent-owner-fixture');
for (const c of cases) {
  test(`F4 accepts independent ${c.name} owner slots and retains native diagnostics`, () => {
    const result = compare(fixture(c));
    assert.deepEqual(result.rules.F4.differences, []);
    assert.equal(result.spatial.strictDifferences.length, c.strict);
  });
}

const variants = [
  ['wrong order', 'field order', m => m.fields.reverse()],
  ['wrong owner', 'owner/group/selector', m => { m.row = 'role:agents/other'; }],
  ['wrong group', 'owner/group/selector', m => { m.group = 'role:categories/deep-high'; }],
  ['wrong section', 'owner/group/selector', m => { m.section = 'agents:plan-advice'; }],
  ['unsupported selector', 'owner/group/selector', m => { m.selector = 'agent-editor'; }],
  ['cross-group field', 'field owner/binding', m => { m.fields[1].group = 'role:agents/other'; }],
  ['wrong binding', 'field owner/binding', m => { m.fields[1].binding = 'agents/other'; }],
  ['wrong parent', 'field owner/binding', m => { m.fields[1].parent = 'mode'; }],
  ['wrong row', 'row/column slot', m => { m.fields[1].box.y += 15; }],
  ['wrong column', 'row/column slot', m => { m.fields[1].box.x += 15; }],
  ['wrong packing', 'row/column slot', m => { m.fields[2].box.x = 476; m.fields[2].box.y = 120; }],
  ['unequal width', 'protected track width', m => { m.fields[1].box.w -= 12; }],
  ['overlap', 'overlap', m => { m.fields[1].box.x = m.fields[0].box.x; }],
  ['owner clipping', 'owner clipping', m => { m.fields[1].box.x += 400; }],
  ['caption clipping', 'text clipping', m => { m.fields[1].captionScroll = 20; }],
  ['selected clipping', 'text clipping', m => { m.fields[1].selectedWidth = 400; }],
  ['false text capacity', 'text clipping', m => { m.fields[1].available = 9999; }],
  ['missing measured width', 'owner dimensions/frame/gap', m => { delete m.grid.box.w; }],
  ['false owner width', 'protected track width', m => { m.grid.box.w += 200; }],
  ['invalid root', 'root rem', m => { m.rootRem = NaN; }],
  ['missing gap', 'owner dimensions/frame/gap', m => { delete m.grid.rowGap; }],
  ['wrong protected gap', 'owner dimensions/frame/gap', m => { m.grid.columnGap = 12; }],
  ['missing occupancy', 'grid occupancy', m => { delete m.occupancy; }],
  ['false full span', 'grid occupancy', m => { m.occupancy[3].end = 'auto'; }],
  ['wrong backup owner', 'grid occupancy', m => { m.occupancy[4].binding = 'agents/other'; }],
  ['missing fields', 'field order', m => { delete m.fields; }],
  ['invalid field', 'field order', m => { m.fields[0] = null; }],
  ['non-grid owner', 'owner dimensions/frame/gap', m => { m.owner.display = 'block'; }],
  ['missing caption', 'field dimensions', m => { delete m.fields[1].captionHeight; }],
  ['false label height', 'field dimensions', m => { m.fields[1].labelHeight += 20; }],
  ['wrong frame', 'owner dimensions/frame/gap', m => { m.grid.box.container = '#other'; }],
];
for (const [name, reason, mutate] of variants) {
  test(`F4 rejects ${name} in supplied current metadata`, () => {
    const board = fixture(cases[1]);
    mutate(board.tasks.role[1].responsive);
    const result = compare(board).rules.F4.differences;
    assert.ok(result.some(d => d.check === 'responsive metadata' && d.errors.includes(reason)), JSON.stringify(result));
  });
}

test('F4 rejects invalid metadata even when all three raw native relations match', () => {
  const board = fixture(cases[2]);
  board.tasks.role[1].responsive.selector = 'unsupported';
  assert.ok(compare(board).rules.F4.differences.some(d => d.errors?.includes('owner/group/selector')));
});

test('F4 keeps reference-only and missing-metadata constrained pairs literal', () => {
  for (const source of ['winforms', 'board']) {
    const board = fixture(cases[0]);
    board.source = source;
    for (const steps of Object.values(board.tasks)) for (const step of steps) delete step.responsive;
    const result = compare(board);
    assert.equal(result.rules.F4.differences.length, 8);
    assert.deepEqual(result.rules.F4.differences, result.spatial.strictDifferences);
  }
});

test('F4 keeps legacy original-fit data literal without requiring new metadata', () => {
  const board = fixture(cases[2]);
  for (const steps of Object.values(board.tasks)) for (const step of steps) delete step.responsive;
  assert.deepEqual(compare(board).rules.F4.differences, []);
});

test('F4 rejects explicit null while truly absent original-fit metadata stays strict', () => {
  const board = fixture(cases[2]);
  for (const steps of Object.values(board.tasks)) for (const step of steps) delete step.responsive;
  assert.deepEqual(compare(board).rules.F4.differences, []);
  board.tasks.role[1].responsive = null;
  const failures = compare(board).rules.F4.differences;
  assert.deepEqual(failures.map(f => f.errors), [['missing responsive metadata']]);
});

test('F4 derives wider role track occupancy from full-span siblings while retaining native three-field relations', () => {
  const c = { width: 1173, rem: 16, track: 290.25, xs: [100, 394.25, 688.5], ys: [120, 120, 120], rows: 1 };
  const board = fixture(c);
  // Memory has exactly three direct items: its empty fourth auto-fit track collapses.
  for (const step of board.tasks.memory.filter(s => s.responsive)) {
    for (const [i, f] of step.responsive.fields.slice(1).entries()) {
      f.box.x = [100, 492.3333333333333, 884.6666666666666][i];
      f.box.w = 388.3333333333333;
    }
    step.box = structuredClone(step.responsive.fields.find(f => f.control === step.control).box);
  }
  const result = compare(board);
  assert.deepEqual(result.rules.F4.differences, []);
  assert.deepEqual(result.spatial.strictDifferences, []);
  assert.equal(result.spatial.responsive.find(s => s.task === 'role').tracks, 4);
  assert.equal(result.spatial.responsive.find(s => s.task === 'memory').tracks, 3);
});

test('F4 rejects a raw step different from its supplied capture', () => {
  const board = fixture(cases[1]);
  board.tasks.role[1].box.x += 20;
  assert.ok(compare(board).rules.F4.differences.some(d => d.errors?.includes('raw step disagreement')));
});

test('F4 rejects a group moving between cascade steps rather than learning its new origin', () => {
  const board = fixture(cases[1]), step = board.tasks.role[2];
  step.box.y += 100;
  for (const box of [step.responsive.owner.box, step.responsive.grid.box,
    ...step.responsive.fields.map(f => f.box)]) box.y += 100;
  assert.ok(compare(board).rules.F4.differences.some(d => d.pair?.includes(step.control)));
});

for (const [name, mutate] of [
  ['mode below triplet', m => { m.grid.box.y -= 30; }],
  ['mode fails full span', m => { m.fields[0].box.w /= 2; }],
  ['mode wrong parent', m => { m.fields[0].parent = 'triplet'; }],
]) {
  test(`F4 rejects Memory ${name}`, () => {
    const board = fixture(cases[1]);
    mutate(board.tasks.memory[0].responsive);
    assert.ok(compare(board).rules.F4.differences.some(d => d.check === 'responsive metadata'));
  });
}

test('F4 preserves unrelated and cross-group pair failures beside responsive groups', () => {
  const board = fixture(cases[1]);
  // A real original role task contains card/apply steps in cards/detail; make their same-region pair explicit.
  const ref = structuredClone(reference);
  const extra = { control: 'unrelated:first', region: 'roles', box: { x: 0, y: 0, w: 20, h: 20 }, scrolls: 0 };
  ref.tasks.role.push(extra);
  board.tasks.role.push({ ...extra, box: { x: 9999, y: 0, w: 20, h: 20 } });
  const result = diff(board, ref, rules, 'cross-group');
  assert.ok(result.rules.F4.differences.some(d => d.pair?.includes('unrelated:first')));
});

test('F4 requires original three-fit relations even if fabricated slots preserve dimensions', () => {
  const board = fixture(cases[2]);
  // Swap the actual service and model, including both raw captures and every full-group snapshot.
  for (const step of board.tasks.role.filter(s => s.responsive)) {
    [step.responsive.fields[0].box.x, step.responsive.fields[1].box.x] =
      [step.responsive.fields[1].box.x, step.responsive.fields[0].box.x];
    step.box = structuredClone(step.responsive.fields.find(f => f.control === step.control).box);
  }
  const failures = compare(board).rules.F4.differences;
  assert.ok(failures.some(d => d.pair?.[0] === 'role:agents/explore:service' &&
    d.pair?.[1] === 'role:agents/explore:model' && d.expected.x === 1 && d.actual.x === -1));
});
