import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrief } from '../src/schema.mjs';
import { BRIEF_SCHEMA } from '../extension.mjs';
import { reportBlocks } from './fixtures/report-blocks.mjs';

const decision = () => ({
  question: '선택', options: { A: { text: '가', consequence: '가' }, B: { text: '나', consequence: '나' } },
  recommend: 'A', reason: '이유', blocks: false,
});
const run = (blocks, extra = {}, fns = {}) => validateBrief({
  title: '블록', status: 'in_progress', headline: '계약', next: '', changes: [], done: [],
  decisions: [decision()], reports: [{ id: 'blocks', title: '보고서', images: [], blocks }], ...extra,
}, { sessionId: 'S', decisionOwner: id => id === 7 ? 'S' : id === 8 ? 'OTHER' : null,
  decisionOpen: () => true, ...fns });
const sample = kind => reportBlocks().find(b => b.kind === kind);
const refuse = (blocks, path, extra, fns) => {
  const result = run(blocks, extra, fns);
  assert.equal(result.ok, false, path);
  assert.equal(result.normalized, null, path + ': never trim');
  assert.ok(result.errors.some(e => e.startsWith(path + ': ') && /[가-힣]/u.test(e)), JSON.stringify(result.errors));
};
const p = 'reports[0].blocks';

test('report blocks: six kinds survive unchanged and the input is not mutated', () => {
  const blocks = reportBlocks(), before = structuredClone(blocks);
  const result = run(blocks);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.normalized.reports[0].blocks, before);
  assert.deepEqual(blocks, before);
  assert.equal(run([]).ok, true);
});

test('report blocks: every string limit accepts N Unicode code points and refuses N+1 at its exact path', () => {
  const fields = [
    ...reportBlocks().map(b => [b.kind, ['title'], 80]),
    ['table', ['columns', 0], 40], ['table', ['rows', 0, 0], 120],
    ['bars', ['unit'], 8], ['bars', ['items', 0, 'label'], 40],
    ['kv', ['items', 0, 'key'], 40], ['kv', ['items', 0, 'value'], 200],
    ['flow', ['steps', 0, 'label'], 40], ['checklist', ['items', 0, 'text'], 120],
    ['compare', ['rows', 0, 'label'], 40], ...['A', 'B', 'C'].map(k => ['compare', ['rows', 0, k], 80]),
  ];
  for (const [kind, keys, max] of fields) {
    const b = sample(kind);
    const obj = keys.slice(0, -1).reduce((o, k) => o[k], b), key = keys.at(-1);
    obj[key] = '😀'.repeat(max);
    assert.equal(run([b]).ok, true, kind + '.' + keys.join('.'));
    obj[key] += '😀';
    const path = keys.reduce((s, k) => s + (typeof k === 'number' ? `[${k}]` : '.' + k), p + '[0]');
    refuse([b], path);
  }
  const b = sample('checklist');
  b.items[0].id = 'a'.repeat(32);
  assert.equal(run([b]).ok, true);
  b.items[0].id += 'a';
  refuse([b], p + '[0].items[0].id');
});

test('report blocks: every collection boundary and table width is refused, never sliced', () => {
  const fields = [['table', 'columns', 1, 8], ['table', 'rows', 1, 30],
    ['bars', 'items', 1, 20], ['kv', 'items', 1, 20], ['flow', 'steps', 2, 10],
    ['checklist', 'items', 1, 20], ['compare', 'rows', 1, 10]];
  for (const [kind, key, min, max] of fields) {
    const b = sample(kind), first = b[key][0];
    for (const n of [min, max, max + 1, min - 1]) {
      b[key] = Array.from({ length: n }, (_, i) => kind === 'checklist' ? { ...first, id: 'id-' + i } : structuredClone(first));
      if (kind === 'table') {
        if (key === 'columns') b.rows = [Array.from({ length: n }, () => 'cell')];
        else b.rows = b.rows.map(() => ['cell', 0]);
      }
      if (n >= min && n <= max) assert.equal(run([b]).ok, true, kind + '.' + key + '=' + n);
      else refuse([b], p + '[0].' + key);
    }
  }
  refuse([...reportBlocks(), sample('kv')], p);
  for (const row of [[], ['x'], ['x', 1, 'extra']]) refuse([{ ...sample('table'), rows: [row] }], p + '[0].rows[0]');
});

test('report blocks: malformed kinds, required keys, nested types and non-finite numbers have exact paths', () => {
  for (const v of [null, {}, 'blocks', 7]) refuse(v, p);
  for (const v of [null, [], 'block', 7]) refuse([v], p + '[0]');
  for (const kind of [undefined, null, 'unknown', '__proto__']) refuse([{ kind }], p + '[0].kind');
  const required = { table: ['columns', 'rows'], bars: ['items'], kv: ['items'], flow: ['steps'],
    checklist: ['items'], compare: ['rows'] };
  for (const [kind, keys] of Object.entries(required)) {
    for (const key of keys) {
      for (const v of [undefined, null, {}, 1, 'array']) {
        const b = sample(kind); b[key] = v;
        refuse([b], p + '[0].' + key);
      }
    }
  }
  const nested = [['bars', 'items', ['label', 'value']], ['kv', 'items', ['key', 'value']],
    ['flow', 'steps', ['label']], ['checklist', 'items', ['id', 'text']],
    ['compare', 'rows', ['label', 'A', 'B']]];
  for (const [kind, key, fields] of nested) {
    for (const v of [null, [], 1, 'object']) {
      const b = sample(kind); b[key][0] = v; refuse([b], `${p}[0].${key}[0]`);
    }
    for (const field of fields) {
      for (const v of [undefined, null, {}, [], true]) {
        const b = sample(kind); b[key][0][field] = v; refuse([b], `${p}[0].${key}[0].${field}`);
      }
    }
  }
  for (const value of [NaN, Infinity, -Infinity, -1, '1']) {
    const b = sample('bars'); b.items[0].value = value; refuse([b], p + '[0].items[0].value');
  }
  for (const value of [NaN, Infinity, -Infinity, null, {}, [], true]) {
    const b = sample('table'); b.rows[0][0] = value; refuse([b], p + '[0].rows[0][0]');
  }
  refuse([{ ...sample('table'), columns: [null] }], p + '[0].columns[0]');
  refuse([{ ...sample('table'), rows: [null] }], p + '[0].rows[0]');
  refuse([{ ...sample('flow'), steps: [{ label: 'a', state: 'bad' }, { label: 'b' }] }], p + '[0].steps[0].state');
  for (const kind of Object.keys(required)) refuse([{ ...sample(kind), title: 1 }], p + '[0].title');
  refuse([{ ...sample('bars'), unit: 1 }], p + '[0].unit');
  refuse([{ ...sample('compare'), rows: [{ label: 'x', A: 'a', B: 'b', C: 1 }] }], p + '[0].rows[0].C');
});

test('report blocks: checklist ids are safe and unique within the report', () => {
  for (const id of ['', 'Bad', 'has space', '<img>']) {
    refuse([{ ...sample('checklist'), items: [{ id, text: 'x' }] }], p + '[0].items[0].id');
  }
  const b = sample('checklist');
  b.items.push({ ...b.items[0] });
  refuse([b], p + '[0].items[1].id');
  refuse([sample('checklist'), sample('checklist')], p + '[1].items[0].id');
});

for (const [shape, kind, keys, size] of [
  ['blocks', null, [], 1],
  ['columns', 'table', ['columns'], 2],
  ['rows', 'table', ['rows'], 1],
  ['cells', 'table', ['rows', 0], 2],
  ['bars', 'bars', ['items'], 1],
  ['kv', 'kv', ['items'], 1],
  ['flow', 'flow', ['steps'], 2],
  ['checklist', 'checklist', ['items'], 1],
  ['compare', 'compare', ['rows'], 1],
]) {
  test(`report blocks: sparse ${shape} refuses every hole like explicit undefined`, () => {
    const blocks = kind ? [sample(kind)] : new Array(size);
    if (kind) {
      const target = keys.slice(0, -1).reduce((obj, key) => obj[key], blocks[0]);
      target[keys.at(-1)] = new Array(size);
    }
    const arrayPath = keys.reduce((path, key) => path + (typeof key === 'number' ? `[${key}]` : '.' + key), p + '[0]');
    const path = kind ? arrayPath : p;
    const explicit = kind ? [sample(kind)] : Array(size).fill(undefined);
    if (kind) {
      const target = keys.slice(0, -1).reduce((obj, key) => obj[key], explicit[0]);
      target[keys.at(-1)] = Array(size).fill(undefined);
    }
    const expected = run(explicit);
    const result = run(blocks);
    assert.equal(result.ok, false, shape);
    assert.equal(result.normalized, null);
    assert.deepEqual(result.errors, expected.errors);
    for (let i = 0; i < size; i++) {
      assert.ok(result.errors.some(error => error.startsWith(`${path}[${i}]: `)), JSON.stringify(result.errors));
    }
  });
}

test('report blocks: compare requires exactly one owned open decision or valid current index', () => {
  const b = sample('compare'); delete b.decisionIndex;
  refuse([b], p + '[0].decision');
  refuse([{ ...b, decision: 7, decisionIndex: 0 }], p + '[0].decisionIndex');
  for (const id of [null, '7', -1, 0, 1.5, 8, 99]) refuse([{ ...b, decision: id }], p + '[0].decision');
  assert.equal(run([{ ...b, decision: 7 }]).ok, true);
  refuse([{ ...b, decision: 7 }], p + '[0].decision', {}, { decisionOpen: () => false });
  for (const index of [null, '0', -1, 0.5, 1, 4]) refuse([{ ...b, decisionIndex: index }], p + '[0].decisionIndex');
  refuse([sample('compare')], p + '[0].decisionIndex', { decisions: [decisionWithAnswer()] });
  refuse([sample('compare')], p + '[0].decisionIndex', { decisions: [{ ...decision(), id: 7 }] }, { decisionOpen: () => false });
  refuse([{ ...b, decision: 7 }], p + '[0].decision', { close_decisions: [{ id: 7, reason: 'withdrawn' }] });
});
test('report blocks: compare preserves row letters absent from a same-brief decision without trimming', () => {
  const two = decision();
  const b = sample('compare');
  for (const C of ['', 'keep-C']) for (const d of [two, { ...two, id: 7 }]) {
    b.rows = [{ label: 'first', A: 'a', B: 'b' }, { label: 'second', A: 'a', B: 'b', C }];
    const result = run([b], { decisions: [d] });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.normalized.reports[0].blocks, [b]);
  }
});
function decisionWithAnswer() { return { ...decision(), state: 'answered', answer: '답함' }; }

test('report blocks: hostile text is preserved as data and unknown executable fields are refused', () => {
  for (const value of ['<img onerror>', '</svg>', '**bold**', 'https://example.test', 'color:red']) {
    const b = sample('kv'); b.items[0].value = value;
    assert.equal(run([b]).normalized.reports[0].blocks[0].items[0].value, value);
    b.items[0].value = value.repeat(201);
    refuse([b], p + '[0].items[0].value');
  }
  for (const key of ['html', 'markdown', 'url', 'style']) {
    refuse([{ ...sample('kv'), [key]: '<img onerror>' }], p + '[0].' + key);
    const b = sample('kv'); b.items[0][key] = 'text'; refuse([b], p + '[0].items[0].' + key);
  }
});

test('brief tool schema exposes all six bounded data-only block variants', () => {
  const blocks = BRIEF_SCHEMA.properties.reports.items.properties.blocks;
  assert.equal(blocks.maxItems, 6);
  assert.deepEqual(blocks.items.oneOf.map(s => s.properties.kind.const), reportBlocks().map(b => b.kind));
  for (const schema of blocks.items.oneOf) {
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes('kind'));
    assert.equal(schema.properties.title.maxLength, 80);
  }
});
