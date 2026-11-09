import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { roadmapHash, roadmapIdOf } from '../src/roadmap-files.mjs';
import { readRoadmaps } from '../src/roadmap-registry.mjs';
import { refreshRoadmapStatuses, writeRoadmapStatus } from '../src/roadmap-status.mjs';
import { roadmapFixture, unaskedGate } from './helpers/roadmap.mjs';
import { applyBoardAnswer } from '../src/decide.mjs';
import { createPlanTool } from '../src/plan-tool.mjs';
import { createRoadmapTool } from '../src/roadmap-tool.mjs';

const start = 1_793_836_800_000;
const refresh = (store, now, options = {}) => refreshRoadmapStatuses(store, { now, ...options });

test('selected stage inventory retains outside task evidence without increasing its denominator', async (t) => {
  const s = roadmapFixture(t);
  fs.writeFileSync(s.planPath, '# Plan\n- [x] 1. Prerequisite\n- [ ] 2. Selected work\n');
  s.projection.stages[0].plans[0].taskIds = ['2'];
  s.save(); await s.call();
  const plan = (await refresh(s.store, start))[0].stages[0].plans[0];
  assert.deepEqual(plan.tasks.map((task) => task.id), ['2']);
  assert.deepEqual(plan.dependencyTasks.map(({ id, mark }) => ({ id, mark })), [{ id: '1', mark: 'x' }]);
});

test('shared cache expires after 60 seconds across store instances and preserves root isolation', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  const other = openStore(s.store.root);
  const isolated = openStore(path.join(s.dir, 'other-state'));
  isolated.replace('sessions/owner/meta.json', { sessionId: 'owner', cwd: s.root });
  const tool = createRoadmapTool({ store: isolated, cwd: s.root, sessionId: 'owner', now: () => start });
  assert.equal((await tool.execute({ projectionPath: s.projectionPath, expectedRevision: null })).details.ok, true);
  const first = (await refresh(s.store, start))[0];
  fs.writeFileSync(s.planPath, '# Plan\n- [x] 1. Work\n- [ ] 2. More work\n');
  const separate = (await refresh(isolated, start + 1))[0];
  const cached = (await refresh(other, start + 59_999))[0];
  const updated = (await refresh(other, start + 60_000))[0];
  assert.equal(cached.revision, first.revision);
  assert.equal(cached.stages[0].plans[0].tasks[0].mark, ' ');
  assert.equal(separate.stages[0].plans[0].tasks[0].mark, 'x');
  assert.equal(updated.stages[0].plans[0].tasks[0].mark, 'x');
  assert.equal(updated.stages[0].plans[0].coverage, false);
});

test('current answers from another session replace an open decision only after refresh', async (t) => {
  const s = roadmapFixture(t);
  s.projection.stages[0].requires.push(unaskedGate());
  s.save();
  await s.call();
  const { decisionId } = await s.call({ expectedRevision: 1, requestGate: { stageId: 'one', gateId: 'gate' } });
  s.projection.stages[0].requires[0].decisionId = decisionId;
  s.save();
  await s.call({ expectedRevision: 1 });
  assert.equal((await refresh(s.store, start))[0].stages[0].requires[0].state, 'open');
  assert.equal(applyBoardAnswer(openStore(s.store.root), { id: decisionId, sessionId: 'owner', option: 'A' }).ok, true);
  const status = (await refresh(openStore(s.store.root), start + 60_000))[0];
  assert.equal(status.definitionRevision, 2);
  assert.equal(status.stages[0].requires[0].state, 'approved');
});

for (const upperCaseDigest of [false, true]) {
test(`a no-plan stage validates a receipt with ${upperCaseDigest ? 'uppercase' : 'lowercase'} digest against its recomputed empty-plan subject`, async (t) => {
  const s = roadmapFixture(t);
  const stage = s.projection.stages[0];
  stage.plans = [];
  const subject = { schemaVersion: 1, roadmapId: roadmapIdOf(s.projectionPath), stageId: stage.id, operation: 'accept',
    sources: [{ id: 'source', sha256: s.projection.sources[0].sha256 }], plans: [] };
  const subjectHash = roadmapHash(JSON.stringify(subject));
  const receipt = JSON.stringify({ schemaVersion: 1, result: 'pass', operation: 'accept', subjectHash,
    checkedAt: '2026-11-05T00:00:00.000Z' });
  const file = `${s.root}/.omo/receipts/accept.json`;
  fs.writeFileSync(file, receipt);
  const digest = roadmapHash(receipt);
  stage.accepts.push({ kind: 'receipt', path: file, operation: 'accept', subjectHash,
    sha256: upperCaseDigest ? digest.toUpperCase() : digest });
  s.save();
  await s.call();
  const status = (await refresh(s.store, start))[0];
  assert.equal(status.stages[0].accepts[0].state, 'pass');
  assert.deepEqual(status.stages[0].plans, []);
  fs.writeFileSync(file, receipt + '\n');
  assert.equal((await refresh(s.store, start + 60_000))[0].stages[0].accepts[0].state, 'unknown');
  const wrongOperation = receipt.replace('"operation":"accept"', '"operation":"implement"');
  fs.writeFileSync(file, wrongOperation);
  const definition = readRoadmaps(s.store)[0];
  definition.projection.stages[0].accepts[0].sha256 = roadmapHash(wrongOperation);
  s.store.replace(`roadmaps/${definition.roadmapId}/definition.json`, definition);
  const changed = (await refresh(s.store, start + 120_000))[0];
  assert.equal(changed.stages[0].accepts[0].state, 'unknown');
});
}

test('a receipt subject expands and sorts the complete plan inventory', async (t) => {
  const s = roadmapFixture(t);
  fs.writeFileSync(s.planPath, '# Plan\n- [ ] 2. More work\n- [ ] 1. Work\n');
  const subject = { schemaVersion: 1, roadmapId: roadmapIdOf(s.projectionPath), stageId: 'one', operation: 'accept',
    sources: [{ id: 'source', sha256: s.projection.sources[0].sha256 }],
    plans: [{ path: s.planPath, sha256: roadmapHash(fs.readFileSync(s.planPath)), taskIds: ['1', '2'] }] };
  const subjectHash = roadmapHash(JSON.stringify(subject));
  const raw = JSON.stringify({ schemaVersion: 1, result: 'pass', operation: 'accept', subjectHash,
    checkedAt: '2026-11-05T00:00:00.000Z' });
  const file = `${s.root}/.omo/receipts/sorted.json`;
  fs.writeFileSync(file, raw);
  s.projection.stages[0].accepts.push({ kind: 'receipt', path: file, operation: 'accept', subjectHash, sha256: roadmapHash(raw) });
  s.save();
  await s.call();
  const stage = (await refresh(s.store, start))[0].stages[0];
  assert.deepEqual(stage.plans[0].taskIds, ['1', '2']);
  assert.equal(stage.accepts[0].state, 'pass');
});

test('changed source and missing plan retain the last successful structure with an error', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  const first = (await refresh(s.store, start))[0];
  fs.writeFileSync(s.sourcePath, s.sourceText.replace('Evidence', 'Changed'));
  const changed = (await refresh(s.store, start + 60_000))[0];
  assert.equal(changed.error.code, 'SOURCE_HASH');
  assert.equal(changed.checkedAt, first.checkedAt);
  assert.deepEqual(changed.stages, first.stages);
  fs.writeFileSync(s.sourcePath, s.sourceText);
  fs.unlinkSync(s.planPath);
  const missing = (await refresh(s.store, start + 120_000))[0];
  assert.equal(missing.error.code, 'ENOENT');
  assert.deepEqual(missing.stages, first.stages);
});

test('a changed projection cannot silently refresh the registered definition', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  const first = (await refresh(s.store, start))[0];
  s.projection.stages[0].note = 'unregistered change';
  s.save();
  const changed = (await refresh(s.store, start + 60_000))[0];
  assert.equal(changed.error.code, 'PROJECTION_HASH');
  assert.equal(changed.checkedAt, first.checkedAt);
  assert.deepEqual(changed.stages, first.stages);
});

test('a newer definition or newer observation prevents an old writer from replacing status', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  const first = (await refresh(s.store, start))[0];
  const newer = { ...first, checkedAt: new Date(start + 10).toISOString() };
  assert.ok(writeRoadmapStatus(s.store, newer));
  assert.equal(writeRoadmapStatus(s.store, first), false);
  s.projection.stages[0].note = 'new definition';
  s.save();
  await s.call({ expectedRevision: 1 });
  assert.equal(writeRoadmapStatus(s.store, newer), false);
  assert.equal(s.store.readRecord(`roadmaps/${first.roadmapId}/status.json`).checkedAt, newer.checkedAt);
});

test('unregistered roadmaps are excluded without removing their stored status', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  const first = (await refresh(s.store, start))[0];
  await s.call({ expectedRevision: 1, unregister: true });
  assert.equal(readRoadmaps(s.store)[0].registered, false);
  assert.deepEqual(await refresh(s.store, start + 60_000), []);
  assert.equal(s.store.readRecord(`roadmaps/${first.roadmapId}/status.json`).revision, first.revision);
});

test('verification failure overrides a checked task and a truncated ledger makes coverage unknown', async (t) => {
  const s = roadmapFixture(t);
  fs.writeFileSync(s.planPath, '# Plan\n- [x] 1. Work\n- [ ] 2. More work\n');
  const dir = path.join(s.root, '.omo', 'ulw-execute', 'plan');
  fs.mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(path.join(s.root, '.omo', 'boulder.json'), JSON.stringify({
    works: { active: { active_plan: s.planPath, ledger: '.omo/ulw-execute/plan/ledger.jsonl', status: 'running' } },
  }));
  fs.writeFileSync(ledger, `${JSON.stringify({ event: 'verify-failed', task: '1' })}\n`);
  await s.call();
  const first = (await refresh(s.store, start))[0].stages[0].plans[0];
  assert.equal(first.tasks[0].conflict, true);
  assert.equal(first.coverage, true);
  fs.appendFileSync(ledger, '{"event":');
  const partial = (await refresh(s.store, start + 60_000))[0].stages[0].plans[0];
  assert.equal(partial.coverage, false);
  assert.equal(partial.tasks[0].conflict, true);
  assert.equal(partial.errors.some((error) => error.code === 'LEDGER_TAIL'), true);
});

test('unparseable task inventory is not treated as a complete empty plan', async (t) => {
  const s = roadmapFixture(t);
  fs.writeFileSync(s.planPath, '# Plan\n- [X] 1. Work\n');
  await s.call();
  const plan = (await refresh(s.store, start))[0].stages[0].plans[0];
  assert.equal(plan.coverage, false);
  assert.deepEqual(plan.taskIds, []);
  assert.equal(plan.errors.some((error) => error.code === 'INVENTORY_PARSE'), true);
});

test('an EPERM in a source inventory read preserves the previous successful status', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  const first = (await refresh(s.store, start))[0];
  const inaccessible = { ...s.store, readPlans() { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } };
  const failed = (await refresh(inaccessible, start + 60_000))[0];
  assert.equal(failed.error.code, 'EPERM');
  assert.equal(failed.checkedAt, first.checkedAt);
  assert.deepEqual(failed.stages, first.stages);
  assert.equal(s.store.readRoadmapStatuses().roadmaps[0].status.error.code, 'EPERM');
});

test('a forced failed refresh cannot be hidden by a younger successful cache entry', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  await refresh(s.store, start);
  fs.unlinkSync(s.planPath);
  assert.equal((await refresh(s.store, start + 1, { force: true }))[0].error.code, 'ENOENT');
  const retry = (await refresh(s.store, start + 2))[0];
  assert.equal(retry.error.code, 'ENOENT');
});

test('settlement refreshes global roadmaps without writing while paused', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  let enabled = true;
  let now = start;
  let publishes = 0;
  const errors = [];
  const meta = { sessionId: 'other-session', planIds: [], planFiles: {} };
  const tool = createPlanTool({ store: s.store, sessionId: meta.sessionId, cwd: s.root,
    isEnabled: () => enabled, now: () => now, publish: () => { publishes++; },
    onError: (key, error) => errors.push({ key, error }), onRecover: () => {},
    getMeta: () => meta, saveMeta: () => {}, readText: async () => null });
  await tool.onSettled();
  const first = s.store.readRoadmapStatuses().roadmaps[0].status;
  assert.equal(first.definitionRevision, 1);
  assert.equal(publishes, 1);
  now += 60_000;
  enabled = false;
  await tool.onSettled();
  assert.equal(s.store.readRoadmapStatuses().roadmaps[0].status.revision, first.revision);
  assert.equal(publishes, 1);
  assert.deepEqual(errors, []);
});

test('pausing during collection prevents both status writes and publication', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  let enabled = true;
  let publishes = 0;
  const tool = createPlanTool({ store: s.store, sessionId: 'other', cwd: s.root,
    isEnabled: () => enabled, now: () => start, publish: () => { publishes++; },
    onError: (key, error) => { throw error; }, onRecover: () => {},
    getMeta: () => ({ planIds: [], planFiles: {} }), saveMeta: () => {}, readText: async () => null });
  const pending = tool.onSettled();
  enabled = false;
  await pending;
  assert.equal(s.store.readRoadmapStatuses().roadmaps[0].status, null);
  assert.equal(publishes, 0);
});
