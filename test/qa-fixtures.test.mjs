// The QA harness's maximal fixture (test/fixtures/report-blocks-max.mjs, used by scripts/qa-board-matrix.mjs and
// scripts/qa-browser.mjs) sits exactly at the live validator's limits: accepted as is, and refused at the exact path as
// soon as any list gets one more item or any string one more character.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBrief, decisionValueErrors, REPORT_BLOCK_SCHEMA, DECISION_FIELDS_SCHEMA } from '../src/schema.mjs';
import { RADIO_MAX, maxReport, maxReportBlocks, maxCompareDecision, maxDecisionFields, maxFieldValues, invalidFieldValues,
  invalidFieldErrors } from './fixtures/report-blocks-max.mjs';

const brief = () => ({ title: '최대 크기', status: 'needs_decision', headline: '보고서 블록 최대 크기', changes: [], done: [], next: '',
  decisions: [maxCompareDecision(), { question: '최대 입력 값을 정해 주세요', reason: '한도까지 채운 입력', blocks: false, fields: maxDecisionFields() }],
  reports: [maxReport({ decisionIndex: 0 })] });
const kindOf = (oneOf, kind) => oneOf.find((s) => s.properties.kind.const === kind);

// Every array and limited string under `value` with its schema node: [path, schemaPath, node, value]
function leaves(node, value, path, out = [], key = path) {
  if (node.anyOf) node = node.anyOf.find((n) => n.type === (typeof value === 'number' ? 'number' : 'string'));
  if (node.oneOf && !node.type) node = kindOf(node.oneOf, value.kind); // a block or field kind (compare's own oneOf is its link)
  if (node.type === 'array') {
    out.push([path, key, node, value]);
    value.forEach((v, i) => leaves(node.items, v, `${path}[${i}]`, out, `${key}[*]`));
  } else if (node.type === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(node.properties[k], v, `${path}.${k}`, out, `${key}.${k}`);
  } else if (node.type === 'string' && node.maxLength !== undefined) out.push([path, key, node, value]);
  return out;
}
const blockLeaves = () => maxReportBlocks().flatMap((b, n) => leaves(REPORT_BLOCK_SCHEMA.items, b, `reports[0].blocks[${n}]`));
const fieldLeaves = () => leaves(DECISION_FIELDS_SCHEMA, maxDecisionFields(), 'decisions[1].fields');
const at = (root, path) => path.match(/[^.[\]]+/g).reduce((o, k) => o[k], root);
const firstAndLast = (list) => [...new Map(list.map((l) => [l[1], []])).keys()].flatMap((k) => {
  const same = list.filter((l) => l[1] === k);
  return same.length > 1 ? [same[0], same.at(-1)] : same;
});

test('maximal fixture: accepted as is; six kinds in schema order; every list at maxItems and every string at maxLength', () => {
  const v = validateBrief(brief());
  assert.equal(v.ok, true, v.errors.join('\n'));
  assert.deepEqual(maxReportBlocks().map((b) => b.kind), REPORT_BLOCK_SCHEMA.items.oneOf.map((s) => s.properties.kind.const));
  assert.equal(maxReportBlocks().length, REPORT_BLOCK_SCHEMA.maxItems);
  const short = [...blockLeaves(), ...fieldLeaves()].filter(([path, , node, value]) => {
    if (node.type === 'array') return value.length !== node.maxItems && !(path.endsWith('.options') && value.length === RADIO_MAX);
    return [...value].length !== node.maxLength;
  }).map(([path, , node, value]) => `${path}: ${node.type === 'array' ? value.length : [...value].length}`);
  assert.deepEqual(short, [], 'below its limit');
  const fields = maxDecisionFields();
  assert.equal(fields.length, DECISION_FIELDS_SCHEMA.maxItems);
  assert.deepEqual(fields.map((f) => f.kind), ['text', 'number', 'choice', 'choice']);
  assert.equal(fields[0].maxLen, kindOf(DECISION_FIELDS_SCHEMA.items.oneOf, 'text').properties.maxLen.maximum);
  assert.deepEqual(fields.slice(2).map((f) => f.options.length), [kindOf(DECISION_FIELDS_SCHEMA.items.oneOf, 'choice').properties.options.maxItems, RADIO_MAX]);
});

test('maximal fixture: one more item or character anywhere is refused at that exact path', () => {
  const cases = firstAndLast([...blockLeaves(), ...fieldLeaves()]).filter(([path, , , value]) => !(path.endsWith('.options') && value.length === RADIO_MAX));
  assert.ok(cases.length >= 40, `cases: ${cases.length}`);
  const missed = [];
  for (const [path, , node] of cases) {
    const b = brief();
    const parent = at(b, path.replace(/(\.[^.[\]]+|\[\d+\])$/, '')), key = path.match(/([^.[\]]+)\]?$/)[1];
    const value = parent[key];
    if (node.type === 'array') value.push(structuredClone(value.at(-1)));
    else parent[key] = value + (path.endsWith('.id') ? 'a' : '가');
    const v = validateBrief(b);
    if (v.ok || !v.errors.some((e) => e.startsWith(`${path}: `))) missed.push(`${path}: ${v.ok ? 'accepted' : v.errors.slice(0, 2).join(' | ')}`);
  }
  assert.deepEqual(missed, []);
  const b = brief();
  b.decisions[1].fields[0].maxLen += 1;
  assert.ok(validateBrief(b).errors.includes('decisions[1].fields[0].maxLen: 1..200 정수 필요'));
});

test('maximal field values are valid; the invalid ones are refused per field with the board message', () => {
  const fields = maxDecisionFields();
  assert.deepEqual({ ...decisionValueErrors(fields, maxFieldValues(fields)) }, {});
  assert.equal([...maxFieldValues(fields)[fields[0].id]].length, fields[0].maxLen);
  assert.deepEqual({ ...decisionValueErrors(fields, invalidFieldValues(fields)) }, invalidFieldErrors(fields));
  assert.equal([...invalidFieldValues(fields)[fields[0].id]].length, fields[0].maxLen + 1);
});
