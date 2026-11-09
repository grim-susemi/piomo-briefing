import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { roadmapPublication, publishRoadmaps, ROADMAP_PAGE_BYTES } from '../src/roadmap-publication.mjs';
import { ROADMAP_LIMITS } from '../src/roadmap-schema.mjs';
import { createBoardServer } from '../src/server.mjs';
import { openStore } from '../src/store.mjs';
import { tempDir } from './helpers/temp.mjs';

const models = (count) => Array.from({ length: count }, (_, i) => ({
  roadmapId: `rm${String(i).padStart(12, '0')}`, revision: i + 1,
  projectionPath: `/project/${'p'.repeat(4000)}/${i}.json`, checkedAt: null, stale: true, error: null,
  tracks: [{ id: 'track', label: `Track ${i}`, stageIds: ['one'] }],
  stages: [{ id: 'one', label: `Stage ${i}`, note: 'detail'.repeat(12000), plans: [
    { path: `/project/${'p'.repeat(4000)}/${i}.md`, taskIds: null, tasks: [] },
  ] }],
}));
const full = (roadmaps) => ({ gen: 36, seq: 1, sessions: [], roadmaps });
// node:http, not fetch: the OS may hand port 0 any port of the dynamic range, and fetch refuses its "bad port" list
const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path, agent: false, headers: { Connection: 'close', ...headers } }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }));
  });
  req.on('error', reject);
});
const bodies = (publication, kind) => publication.artifacts
  .filter(([rel]) => rel.endsWith('.json') && rel.includes(`/${kind}-`))
  .map(([, text]) => JSON.parse(text));

test('catalogue, detail and global connected plans retain all records across bounded pages', () => {
  const input = models(40);
  const publication = roadmapPublication(full(input));
  const catalogue = bodies(publication, 'catalogue'), plans = bodies(publication, 'plans');
  assert.ok(catalogue.length > 1 && plans.length > 1, 'fixture must cross both inventory page budgets');
  assert.deepEqual(catalogue.flatMap((body) => body.items.map((item) => item.roadmapId)), input.map((item) => item.roadmapId));
  assert.deepEqual(bodies(publication, 'detail').map((body) => body.items[0]), input);
  assert.deepEqual(plans.flatMap((body) => body.items.map((item) => item.plan.path)), input.map((item) => item.stages[0].plans[0].path));
  assert.equal(Buffer.byteLength(JSON.stringify(publication.model)) < 2 * ROADMAP_PAGE_BYTES, true);
  for (const [rel, text] of publication.artifacts) {
    assert.ok(Buffer.byteLength(text) <= (rel.includes('/detail-') ? ROADMAP_LIMITS.vmBytes : ROADMAP_PAGE_BYTES), rel);
  }
});

test('oversized individual detail fails publication before replacing the last snapshot', (t) => {
  const { dir } = tempDir(t, 'roadmap-artifact-cap-');
  const store = openStore(dir), input = models(9);
  input[8].stages[0].note = '<'.repeat(ROADMAP_LIMITS.vmBytes / 6);
  store.replace('data.js', 'previous publication');
  assert.throws(() => publishRoadmaps(full(input), store), { code: 'LIMIT' });
  assert.equal(store.readText('data.js'), 'previous publication');
  assert.equal(fs.existsSync(`${dir}/roadmap-data`), false);
});

test('ninth detail has identical offline and gated HTTP delivery', async (t) => {
  const { dir } = tempDir(t, 'roadmap-artifact-http-');
  const store = openStore(dir), input = full(models(9));
  const model = publishRoadmaps(input, store), key = model.roadmapCatalogue.key;
  const stem = `/roadmap-data/${key}/detail-${input.roadmaps[8].roadmapId}`;
  let offline;
  vm.runInNewContext(store.readText(`${stem.slice(1)}.js`), { window: { __briefRoadmap: (body) => { offline = body; } } });
  const board = createBoardServer({ portBase: 0, portCount: 1, generation: 36,
    roadmapStateDir: dir, getViewModel: () => model, getPage: () => '' });
  t.after(() => board.close());
  const { port } = await board.start();
  const response = await get(port, `${stem}.json`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), JSON.parse(JSON.stringify(offline)));
  assert.deepEqual(JSON.parse(JSON.stringify(offline.items[0])), input.roadmaps[8]);
  for (const path of [`${stem}.js`, `/roadmap-data/${key}/../definition.json`]) {
    assert.equal((await get(port, path)).status, 404);
  }
  assert.equal((await get(port, `${stem}.json`, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

test('offline loader discards superseded detail responses and retains only the selected snapshot', () => {
  const first = roadmapPublication(full(models(9))), changed = models(9);
  changed[8].revision++;
  const second = roadmapPublication(full(changed));
  const scripts = [], timers = new Map();
  const sandbox = { location: { protocol: 'file:' }, TextEncoder, SyntaxError,
    document: { createElement: () => ({ remove() {} }), head: { appendChild: (sc) => scripts.push(sc) } },
    setTimeout: (fn) => { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync(new URL('../src/page/roadmap-data.js', import.meta.url), 'utf8'), sandbox);
  const ui = { catalogueSelected: changed[8].roadmapId };
  sandbox.BriefRoadmapData.view(first.model, ui);
  sandbox.BriefRoadmapData.view(second.model, ui);
  sandbox.__briefRoadmap(bodies(first, 'detail')[8]);
  assert.equal(sandbox.BriefRoadmapData.view(second.model, ui).roadmapLoad.loading, true);
  sandbox.__briefRoadmap(bodies(second, 'detail')[8]);
  const selected = sandbox.BriefRoadmapData.view(second.model, ui);
  assert.equal(selected.roadmaps[0].revision, 10);
  assert.equal(selected.roadmapLoad.loading, false);
  assert.equal(scripts.length, 2);
  assert.equal(timers.size, 0);
});
