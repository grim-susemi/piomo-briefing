import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roadmapModels } from '../src/roadmap-model.mjs';

const now = Date.parse('2026-11-05T00:00:00.000Z');
const task = (id, mark = ' ', extra = {}) => ({ id, mark, conflict: false, dependenciesKnown: true, deps: [], last: null, ...extra });
const plan = (tasks = [task('1')], extra = {}) => ({ path: '/project/.omo/plans/a.md', tasks, coverage: true, work: null, ...extra });
function input({ plans = [plan()], requires = [], accepts = [], known = true, at = now, error = null } = {}) {
  const stage = { id: 'one', label: 'One', sourceId: 's', requires, accepts, plans, requirementsKnown: known };
  return [{ definition: { roadmapId: 'rm1', revision: 1, projectionPath: '/roadmap.json',
    projection: { tracks: [{ id: 'track', stageIds: ['one'] }], stages: [stage] } },
  status: { schema: 'omo-roadmap-status/1', definitionRevision: 1, checkedAt: new Date(at).toISOString(), error,
    stages: [{ id: 'one', plans, requires, accepts }] } }];
}
const evaluate = (options) => roadmapModels(input(options), now)[0].stages[0];
const decision = (state) => ({ kind: 'decision', state });
const receipt = (state) => ({ kind: 'receipt', state });

test('golden judgment cases hold against the collector evidence vocabulary', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/roadmap/truth-cases.json', import.meta.url), 'utf8')).cases;
  for (const row of cases) {
    const source = row.input;
    const state = source.decision === 'unanswered' ? 'unknown' : source.decision;
    const requires = [decision(state), ...(source.requirements === 'blocked' ? [receipt('fail')] : [])];
    const plans = [plan([task('1', source.unfinished ? ' ' : 'x')], {
      work: source.running ? { status: 'running' } : null,
    })];
    const stage = evaluate({ requires, plans, at: source.evidence === 'stale' ? now - 60_000 : now,
      error: source.evidence === 'missing' ? { code: 'MISSING' } : null });
    assert.deepEqual({ ready: stage.ready, decisionNeeded: stage.decisionNeeded,
      blocked: stage.blocked, unknown: stage.unknown }, row.expected, row.id);
  }
});

test('entry judgments preserve independent decision and blockage with held and stale evidence', () => {
  const cases = [
    [{}, [true, false, false, false]],
    [{ requires: [decision('unasked')] }, [false, true, false, false]],
    [{ requires: [decision('held')] }, [false, false, false, true]],
    [{ requires: [decision('rejected')] }, [false, false, true, false]],
    [{ requires: [decision('open'), receipt('fail')] }, [false, true, true, false]],
    [{ requires: [decision('unknown')] }, [false, false, false, true]],
    [{ at: now - 60_000 }, [false, false, false, true]],
    [{ plans: [plan([task('1')], { work: { status: 'running' } })] }, [false, false, false, false]],
  ];
  for (const [options, expected] of cases) {
    const stage = evaluate(options);
    assert.deepEqual([stage.ready, stage.decisionNeeded, stage.blocked, stage.unknown], expected, JSON.stringify(options));
  }
});

test('exit conditions do not block implementation but all-done is not acceptance', () => {
  assert.equal(evaluate({ accepts: [decision('unasked')] }).ready, true);
  const done = evaluate({ plans: [plan([task('1', 'x')])] });
  assert.equal(done.ready, false);
  assert.equal(done.unknown, true);
  assert.equal(done.accepted, 'unknown');
  const accepted = evaluate({ plans: [plan([task('1', 'x')])], accepts: [receipt('pass')] });
  assert.equal(accepted.terminal, true);
  assert.equal(accepted.decisionNeeded, false);
});

test('progress excludes deferred work and checked tasks with later failures', () => {
  const stage = evaluate({ plans: [plan([task('1', 'x'), task('2', '~'), task('3', 'x', { conflict: true })])] });
  assert.deepEqual(stage.progress, { doneConfirmed: 1, denominator: 2, observedUniqueIds: 3,
    excluded: 1, unconfirmed: 1, conflicts: 1 });
  assert.equal(stage.blocked, true);
  assert.equal(evaluate({ plans: [plan([task('1')], { coverage: false })] }).progress.denominator, null);
  assert.equal(evaluate({ plans: [] }).progress.denominator, null);
  assert.equal(evaluate({ plans: [plan([])] }).progress.denominator, 0);
});

test('unobserved dependency state is unknown rather than invented completion', () => {
  const stage = evaluate({ plans: [plan([task('2', ' ', { deps: ['1'] })])] });
  assert.equal(stage.ready, false);
  assert.equal(stage.unknown, true);
  assert.equal(stage.blocked, false);
});

test('outside dependency evidence affects readiness without changing selected progress', () => {
  for (const mark of ['x', ' ']) {
    const stage = evaluate({ plans: [plan([task('2', ' ', { deps: ['1'] })],
      { dependencyTasks: [task('1', mark)] })] });
    assert.equal(stage.ready, mark === 'x');
    assert.equal(stage.blocked, mark !== 'x');
    assert.equal(stage.unknown, false);
    assert.equal(stage.progress.denominator, 1);
    assert.equal(stage.progress.doneConfirmed, 0);
  }
});

test('a selected dependency must be confirmed complete before its dependent can run', () => {
  const dependency = task('2', ' ', { deps: ['1'] });
  const waiting = evaluate({ plans: [plan([task('1'), dependency])] });
  assert.equal(waiting.blocked, true);
  const ready = evaluate({ plans: [plan([task('1', 'x'), dependency])] });
  assert.equal(ready.ready, true);
  assert.equal(ready.blocked, false);
});

test('unverified receipt and decision evidence never become approval', () => {
  for (const condition of [decision('unknown'), receipt('unknown')]) {
    const stage = evaluate({ requires: [condition] });
    assert.equal(stage.ready, false);
    assert.equal(stage.unknown, true);
  }
});

test('decision, blockage and stale flags combine independently', () => {
  for (const state of ['approved', 'unasked', 'open', 'held', 'rejected', 'unknown']) {
    for (const failure of [false, true]) {
      for (const stale of [false, true]) {
        const stage = evaluate({ requires: [decision(state), ...(failure ? [receipt('fail')] : [])],
          at: stale ? now - 60_000 : now });
        assert.equal(stage.decisionNeeded, state === 'unasked' || state === 'open');
        assert.equal(stage.blocked, failure || state === 'rejected');
        assert.equal(stage.unknown, stale || state === 'held' || state === 'unknown');
        assert.equal(stage.ready, state === 'approved' && !failure && !stale);
      }
    }
  }
});

test('an old or incomplete status cannot supply readiness', () => {
  const records = input();
  records[0].status.schema = 'omo-roadmap-status/0';
  assert.equal(roadmapModels(records, now)[0].stages[0].ready, false);
  records[0].status.schema = 'omo-roadmap-status/1';
  delete records[0].status.stages[0].requires;
  const stage = roadmapModels(records, now)[0].stages[0];
  assert.equal(stage.ready, false);
  assert.equal(stage.unknown, true);
});
