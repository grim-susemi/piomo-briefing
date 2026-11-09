import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';

const readJson = (name) => JSON.parse(readFileSync(new URL(`./fixtures/roadmap/${name}.json`, import.meta.url), 'utf8'));
const hash = (text) => createHash('sha256').update(text).digest('hex');
const full = readJson('full');
const truth = readJson('truth-cases');

test('source section hashes and every stage match the independently recorded inventory', () => {
  const allStages = full.projections.flatMap((projection) => projection.stages);
  assert.equal(allStages.length, 25);
  assert.equal(new Set(allStages.map((stage) => stage.id)).size, 25);
  for (const source of full.sourceInventory) {
    const text = readFileSync(source.path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const heading = `## ${source.headingPath[1]}`;
    const start = lines.indexOf(heading);
    assert.notEqual(start, -1, source.id);
    assert.equal(lines.lastIndexOf(heading), start, source.id);
    const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
    const section = lines.slice(start, end === -1 ? undefined : end).join('\n') + '\n';
    assert.equal(hash(section), source.sha256, source.id);
    const rows = section.split('\n').flatMap((line) => {
      const match = line.match(/^\| ([RTU]\d+[a-z]?)(?:\s*\(선택\))?\s*\|/);
      return match ? [match[1]] : [];
    });
    assert.deepEqual(rows, source.inventory, source.id);
    const projectionStages = allStages.filter((stage) => stage.sourceId === source.id).map((stage) => stage.id);
    assert.deepEqual(projectionStages, source.inventory, source.id);
  }
});

test('truth fixture covers the named judgment cases with consistent predicates', () => {
  assert.deepEqual(truth.cases.map((item) => item.id), [
    'ready', 'unasked', 'open', 'held', 'reject', 'unanswered', 'owner-and-blocked',
    'owner-and-unknown', 'stale', 'running', 'exit-unconfirmed',
  ]);
  for (const { id, input, expected } of truth.cases) {
    const decisionNeeded = input.decision === 'unasked' || input.decision === 'open';
    const blocked = input.requirements === 'blocked' || input.decision === 'rejected';
    const unknown = input.evidence !== 'current' || ['held', 'unanswered'].includes(input.decision);
    const ready = input.unfinished && input.requirements === 'met' && input.decision === 'approved'
      && !input.running && !unknown;
    assert.deepEqual(expected, { ready, decisionNeeded, blocked, unknown }, id);
  }
});

test('structural coverage names the required rejection and unknown outcomes', () => {
  assert.deepEqual(truth.structuralCases.map(({ id, expected }) => [id, expected]), [
    ['malformed', 'reject'], ['duplicate', 'reject'], ['cycle', 'reject'], ['path-escape', 'reject'],
    ['empty', 'no-work'], ['shared-plan', 'reject'], ['truncated', 'unknown-denominator'],
    ['wrong-receipt-operation', 'reject'],
  ]);
});

test('negative inputs actually exhibit the recorded structural failures', () => {
  const cases = new Map(truth.structuralCases.map((item) => [item.id, item.input]));
  assert.deepEqual(cases.get('malformed').keys.filter((key) => key !== 'schemaVersion'), ['bogus']);
  const ids = cases.get('duplicate').stageIds;
  assert.notEqual(new Set(ids).size, ids.length);
  assert.deepEqual(cases.get('cycle').edges, [['a', 'b'], ['b', 'a']]);
  const escaped = cases.get('path-escape');
  assert.equal(win32.relative(escaped.root, win32.resolve(escaped.path)).startsWith('..'), true);
  assert.deepEqual(cases.get('empty'), { inventory: [], complete: true });
  const shared = cases.get('shared-plan').stages;
  assert.equal(shared[0].path, shared[1].path);
  assert.deepEqual(shared.map((stage) => stage.taskIds), [null, null]);
  assert.equal(cases.get('truncated').tailComplete, false);
});

test('receipt fixture rejects a pass for a different operation', () => {
  const scenario = truth.structuralCases.find(({ id }) => id === 'wrong-receipt-operation');
  const { conditionOperation, receipt } = scenario.input;
  const result = receipt.result === 'pass' && receipt.operation === conditionOperation ? 'accept' : 'reject';
  assert.equal(result, scenario.expected);
});

test('unasked approval remains nullable and is not the closed unanswered decision', () => {
  const stage = full.projections.flatMap((projection) => projection.stages).find(({ id }) => id === 'R6b');
  const gate = stage.requires.find((condition) => condition.kind === 'decision');
  assert.equal(gate.decisionId, null);
  assert.equal(gate.gateId, 'first-form');
  assert.equal(gate.operation, 'implement');
});

test('a synthetic decision link preserves gate identity, scope, and operation', () => {
  const { before, after, decision } = truth.decisionTransition;
  assert.equal(before.decisionId, null);
  assert.deepEqual({ ...after, decisionId: null }, before);
  assert.equal(after.decisionId, decision.id);
  assert.equal(after.scope, decision.scope);
  assert.equal(after.operation, decision.operation);
  assert.equal(decision.answer, 'approved');
});
