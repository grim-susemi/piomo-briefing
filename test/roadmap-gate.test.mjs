import './helpers/refuse-live-writes.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp.mjs';
import { captureMatrixFailures, reviewFailures } from '../scripts/qa-roadmap-gate.mjs';

test('capture matrix rejects a missing phone state and false mobile metadata', () => {
  const identity = { sourceHash: 'source', payloadHtmlSha256: 'payload' };
  const captures = {};
  for (const viewport of ['390x844', '1024x768', '1180x700', '1440x900', '1920x1080']) {
    for (const theme of ['light', 'dark']) {
      for (const state of ['filter:all', 'filter:ready', 'filter:decisionNeeded', 'filter:blocked', 'detail:R6b', 'scroll:end']) {
        captures[`${viewport}-${theme}-${state}`] = { viewport, theme, state, mobile: viewport === '390x844' };
      }
    }
  }
  const index = { ...identity, captures };
  assert.deepEqual(captureMatrixFailures(index, identity), []);
  delete captures['390x844-light-filter:ready'];
  assert.deepEqual(captureMatrixFailures(index, identity), ['matrix missing: 390x844 light filter:ready']);
  captures['390x844-light-filter:ready'] = { viewport: '390x844', theme: 'light', state: 'filter:ready', mobile: false };
  assert.deepEqual(captureMatrixFailures(index, identity), ['matrix missing: 390x844 light filter:ready']);
  assert.ok(captureMatrixFailures(index, { ...identity, sourceHash: 'different' }).includes('matrix identity: sourceHash'));
});

test('visual gate rejects missing, stale, mismatched and altered evidence', (t) => {
  const { dir } = tempDir(t, 'roadmap-gate-');
  const capture = path.join(dir, 'capture.png').replaceAll('\\', '/');
  fs.writeFileSync(capture, 'capture');
  const digest = crypto.createHash('sha256').update('capture').digest('hex');
  const expected = { sourceHash: 'source', payloadHtmlSha256: 'payload', capturedAt: '2026-11-05T04:00:00.000Z', captures: { [capture]: digest } };
  const make = (reviewer, scope) => ({ reviewer, scope, pass: true, findings: [], ...expected, reviewedAt: '2026-11-05T04:01:00.000Z' });
  const a = make('alice', ['G', 'H', 'I', 'J']);
  const b = make('bob', ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(reviewFailures([a, b], expected), []);
  const supplementalExpected = { ...expected, supplementalCaptures: { [capture]: digest }, supplementalCapturedAt: expected.capturedAt };
  const supplemented = [a, b].map(review => ({ ...review, supplementalCaptures: supplementalExpected.supplementalCaptures, supplementalCapturedAt: expected.capturedAt }));
  assert.deepEqual(reviewFailures(supplemented, supplementalExpected), []);
  assert.ok(reviewFailures([a, b], supplementalExpected).some(f => f.includes('supplemental inventory')));
  assert.ok(reviewFailures([{ ...supplemented[0], supplementalCaptures: { [capture]: 'wrong' } }, supplemented[1]], supplementalExpected).some(f => f.includes('supplemental hash')));
  assert.ok(reviewFailures([{ ...supplemented[0], supplementalCapturedAt: '2026-11-04T00:00:00.000Z' }, supplemented[1]], supplementalExpected).some(f => f.includes('supplemental time')));
  for (const [bad, reason] of [
    [null, 'missing'],
    [{ ...a, reviewedAt: '2026-11-05T03:59:00.000Z' }, 'time'],
    [{ ...a, payloadHtmlSha256: 'other' }, 'build identity'],
    [{ ...a, captures: { [capture]: 'wrong' } }, 'capture hash'],
    [{ ...a, scope: ['G'] }, 'scope'],
    [{ ...a, findings: ['blocker'] }, 'verdict or findings'],
  ]) assert.ok(reviewFailures([bad, b], expected).some((failure) => failure.includes(reason)), reason);
  assert.ok(reviewFailures([a, { ...b, reviewer: 'alice' }], expected).some((failure) => failure.includes('reviewer identity')));
  fs.writeFileSync(capture, 'modified');
  assert.ok(reviewFailures([a, b], expected).some((failure) => failure.includes('capture hash')));
});

test('CLI writes a failed verdict when selected capture evidence is missing', (t) => {
  const { dir } = tempDir(t, 'roadmap-gate-missing-');
  const script = fileURLToPath(new URL('../scripts/qa-roadmap-gate.mjs', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/roadmap/full.json', import.meta.url));
  const out = path.join(dir, 'out');
  const result = spawnSync(process.execPath, [script, '--fixture', fixture, '--out', out, '--evidence', path.join(dir, 'missing')], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const verdict = JSON.parse(fs.readFileSync(path.join(out, 'verdict.json')));
  assert.equal(verdict.pass, false);
  assert.equal(verdict.failures, 1);
});
