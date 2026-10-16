import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answersSnapshot, snapshotDiff, formFieldFor } from '../scripts/qa-answer-lib.mjs';

test('answersSnapshot + snapshotDiff: no folder is empty; add, rewrite and remove each count as a write', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'omo-qa-lib-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const empty = answersSnapshot(dir);
  assert.deepEqual(empty, {});
  mkdirSync(path.join(dir, 'answers'));
  writeFileSync(path.join(dir, 'answers', '000001.json'), '{"id":1,"option":"B"}');
  const one = answersSnapshot(dir);
  assert.deepEqual(snapshotDiff(empty, one), { added: ['000001.json'], removed: [], changed: [], writes: 1 });
  assert.equal(snapshotDiff(one, answersSnapshot(dir)).writes, 0);
  writeFileSync(path.join(dir, 'answers', '000001.json'), '{"id":1,"option":"A"}');
  assert.deepEqual(snapshotDiff(one, answersSnapshot(dir)).changed, ['000001.json']);
  rmSync(path.join(dir, 'answers', '000001.json'));
  assert.deepEqual(snapshotDiff(one, answersSnapshot(dir)).removed, ['000001.json']);
});

test('formFieldFor: the text/plain encoding name=value parses back to exactly the body (no extra key)', () => {
  const body = { id: 3, sessionId: 'qa-ans', text: 'forged=approval' };
  const f = formFieldFor(body);
  assert.deepEqual(JSON.parse(`${f.name}=${f.value}`), body);
  assert.throws(() => formFieldFor({ id: 3, sessionId: 'qa-ans', option: 'A' }));
});
