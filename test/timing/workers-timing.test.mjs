// Original normalization timing limit; only check:timing runs this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { normalizeTaskSnapshot } from '../../src/workers.mjs';

const SNAPSHOT = JSON.parse(readFileSync(new URL('../fixtures/workers/snapshot.json', import.meta.url), 'utf8'));

test('256-snapshot normalization: max of 10 warm runs <= 5ms in one of up to 10 rounds', (t) => {
  const snapshot = { parent_session_id: 'lead-session', tasks: Array.from({ length: 256 }, (_, i) => ({
    ...SNAPSHOT.tasks[0], task_id: 'st_perf' + i,
  })) };
  const roundMaxMs = [];
  const best = () => Math.min(...roundMaxMs);
  while (roundMaxMs.length < 10 && !(best() <= 5)) {
    for (let i = 0; i < 3; i++) assert.equal(normalizeTaskSnapshot(snapshot, 'lead-session').length, 256);
    let maxMs = 0;
    for (let i = 0; i < 10; i++) {
      const before = performance.now();
      const rows = normalizeTaskSnapshot(snapshot, 'lead-session');
      maxMs = Math.max(maxMs, performance.now() - before);
      assert.equal(rows.length, 256);
    }
    roundMaxMs.push(maxMs);
  }
  t.diagnostic(JSON.stringify({ snapshotTasks: 256, warmupRunsPerRound: 3, runsPerRound: 10, roundMaxMs }));
  assert.ok(best() <= 5, `normalize max exceeded 5ms in all ${roundMaxMs.length} rounds: ${roundMaxMs.join(', ')}ms`);
});
