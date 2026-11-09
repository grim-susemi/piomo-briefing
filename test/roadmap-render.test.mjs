import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildViewModel, projectBoardModel, renderPage } from '../src/render.mjs';
import { openStore } from '../src/store.mjs';
import { tempDir } from './helpers/temp.mjs';

const now = Date.parse('2026-11-05T00:00:00.000Z');
const record = () => ({
  definition: { roadmapId: 'rm1', revision: 1, projectionPath: '/roadmap.json', projection: {
    tracks: [{ id: 'track', stageIds: ['one'] }],
    stages: [{ id: 'one', requirementsKnown: true, requires: [], accepts: [], plans: [] }],
  } },
  status: { schema: 'omo-roadmap-status/1', definitionRevision: 1, checkedAt: new Date(now).toISOString(), error: null,
    stages: [{ id: 'one', plans: [], requires: [], accepts: [] }] },
});

test('global roadmaps survive even without a visible session plan', () => {
  const vm = buildViewModel({ roadmaps: [record()] }, now);
  assert.equal(vm.sessions.length, 0);
  assert.equal(vm.roadmaps[0].stages[0].id, 'one');
  assert.equal(vm.roadmaps[0].stages[0].unknown, true);
  assert.equal(Object.hasOwn(buildViewModel({}, now), 'roadmaps'), false, 'legacy models retain their byte shape when no roadmap is registered');
});

test('oversized roadmap model is rejected rather than dropping its rows', () => {
  const vm = buildViewModel({ roadmaps: [record()] }, now, { full: true });
  vm.roadmaps[0].stages[0].note = 'x'.repeat(2 * 1024 * 1024);
  assert.throws(() => projectBoardModel(vm, now), /roadmap VM exceeds.*roadmap\.json/);
});

test('an oversized update preserves the last published snapshot and returns an error', (t) => {
  const { dir } = tempDir(t, 'roadmap-cap-');
  const store = openStore(dir);
  assert.equal(renderPage(store, now).ok, true);
  const previous = store.readText('data.js');
  const oversized = record();
  oversized.definition.projection.stages[0].note = '<'.repeat(400_000);
  const source = { ...store, readSnapshot: () => ({ ...store.readSnapshot(), roadmaps: [oversized] }) };
  const result = renderPage(source, now + 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /roadmap VM exceeds.*roadmap\.json/);
  assert.equal(store.readText('data.js'), previous);
});

test('older generation publication retains the newer page while updating roadmap data', (t) => {
  const { dir } = tempDir(t, 'roadmap-generation-');
  const store = openStore(dir);
  assert.equal(renderPage(store, now, { generation: 9 }).ok, true);
  const page = store.readText('index.html');
  const source = { ...store, readSnapshot: () => ({ ...store.readSnapshot(), roadmaps: [record()] }) };
  assert.equal(renderPage(source, now + 1, { generation: 8 }).ok, true);
  assert.equal(store.readText('index.html'), page);
  assert.match(store.readText('data.js'), /"roadmaps":\[/);
});
