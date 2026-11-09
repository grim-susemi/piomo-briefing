import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { roadmapPublication, ROADMAP_PAGE_BYTES } from '../src/roadmap-publication.mjs';

function fixture(count = 40) {
  const roadmaps = Array.from({ length: count }, (_, i) => ({
    roadmapId: `rm${String(i).padStart(12, '0')}`, revision: 1, checkedAt: null, stale: true, error: null,
    projectionPath: `/project/${'p'.repeat(4000)}/${i}.json`,
    tracks: [{ id: 'topic', label: i >= count - 3 ? 'Later topic' : 'Earlier topic', stageIds: ['one'] },
      { id: 'title', label: `Roadmap ${i}`, stageIds: [] }],
    stages: [{ id: 'one', label: `Stage ${i}`, goal: 'Detail', plans: [], requires: [], accepts: [] }],
  }));
  return { roadmaps, model: { schema: 1, gen: 36, seq: 1, sessions: [], readErrors: [], roadmaps } };
}

function client(publication) {
  const artifacts = new Map(publication.artifacts), pending = [], timers = new Map(), requests = [];
  const sandbox = { location: { protocol: 'file:' }, TextEncoder, SyntaxError,
    document: { createElement: () => ({ remove() {} }), head: { appendChild: (script) => { pending.push(script); requests.push(script.src); } } },
    setTimeout: (fn) => { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id) };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const name of ['roadmap-index', 'roadmap-search', 'roadmap-data']) {
    vm.runInContext(fs.readFileSync(new URL(`../src/page/${name}.js`, import.meta.url), 'utf8'), sandbox);
  }
  function settle(ui) {
    let model = sandbox.BriefRoadmapData.view(publication.model, ui);
    while (pending.length) {
      const script = pending.shift();
      assert.ok(artifacts.has(script.src), `published script must exist: ${script.src}`);
      vm.runInContext(artifacts.get(script.src), sandbox);
      model = sandbox.BriefRoadmapData.view(publication.model, ui);
    }
    return model;
  }
  return { sandbox, requests, settle };
}

const cases = [
  { name: 'title search finds a roadmap outside the first catalogue page', query: '  rOaDmAp 39  ', topic: 'all', ids: [39] },
  { name: 'topic selection includes every matching roadmap from later catalogue pages', query: '', topic: 'Later topic', ids: [37, 38, 39] },
  { name: 'combined title and topic filters cover all registered roadmaps', query: 'Roadmap 38', topic: 'Later topic', ids: [38] },
  { name: 'global search preserves the existing displayed title and topic whitespace normalization', query: 'Roadmap 39', topic: 'Later topic', ids: [39], normalize: true },
];
for (const row of cases) test(row.name, () => {
  const input = fixture();
  if (row.normalize) {
    input.roadmaps[39].tracks[0].label = ' Later\ntopic ';
    input.roadmaps[39].tracks[1].label = ' Roadmap 39 ';
  }
  const publication = roadmapPublication(input.model), browser = client(publication);
  assert.ok(publication.model.roadmapCatalogue.cataloguePages > 1);
  assert.equal(publication.model.roadmaps.some((rm) => rm.roadmapId === input.roadmaps[39].roadmapId), false);

  const result = browser.settle({ catalogueQuery: row.query, catalogueTopic: row.topic });

  assert.equal(result.roadmapLoad.loading, false);
  assert.deepEqual(Array.from(result.roadmaps, (rm) => rm.roadmapId), row.ids.map((id) => input.roadmaps[id].roadmapId));
  assert.equal(result.roadmapLoad.total, row.ids.length);
  assert.deepEqual(Array.from(result.roadmapTopics), ['Earlier topic', 'Later topic']);
});

test('a global title result renders when its topic option belongs to another topics page', () => {
  const input = fixture(), publication = roadmapPublication(input.model), browser = client(publication);
  const result = browser.settle({ catalogueQuery: 'Roadmap 39', catalogueTopic: 'all' });

  const html = browser.sandbox.BriefRoadmapIndex.render(result.roadmaps, { catalogueQuery: 'Roadmap 39' }, {
    esc: (value) => String(value), topics: ['Earlier topic'], readErrors: [], plansButton: '', total: 40,
  });

  assert.match(html, new RegExp(`data-id="${input.roadmaps[39].roadmapId}"`));
});

test('global search streams every index page and keeps one bounded result page', () => {
  const input = fixture(400);
  for (const rm of input.roadmaps) {
    for (let i = 2; i < 6; i++) rm.tracks.push({ id: `track${i}`, label: 'abcdefghijklmn', stageIds: [] });
  }
  const publication = roadmapPublication(input.model), browser = client(publication);
  const descriptor = publication.model.roadmapCatalogue;
  assert.ok(descriptor.searchPages > 1, 'fixture must exercise index paging too');
  const ui = { catalogueQuery: 'roadmap', catalogueTopic: 'all', roadmapSearchPage: 0 };

  const first = browser.settle(ui), ids = Array.from(first.roadmaps, (rm) => rm.roadmapId);
  assert.ok(Buffer.byteLength(JSON.stringify(first.roadmaps)) <= ROADMAP_PAGE_BYTES);
  assert.ok(first.roadmapLoad.pages > 1, 'fixture must cross the result-page budget');
  for (let page = 1; page < first.roadmapLoad.pages; page++) {
    ui.roadmapSearchPage = page;
    const result = browser.settle(ui);
    assert.ok(Buffer.byteLength(JSON.stringify(result.roadmaps)) <= ROADMAP_PAGE_BYTES);
    ids.push(...Array.from(result.roadmaps, (rm) => rm.roadmapId));
  }

  assert.equal(first.roadmapLoad.total, 400);
  assert.deepEqual(ids, input.roadmaps.map((rm) => rm.roadmapId));
  for (let i = 0; i < descriptor.searchPages; i++) {
    assert.ok(browser.requests.includes(`roadmap-data/${descriptor.key}/search-${i}.js`));
  }
  for (const [name, text] of publication.artifacts.filter(([name]) => /\/(?:search|topics)-/.test(name))) {
    assert.ok(Buffer.byteLength(text) <= ROADMAP_PAGE_BYTES, name);
  }
});

test('a changed query replaces an unfinished scan without retaining the previous matches', () => {
  const input = fixture(), publication = roadmapPublication(input.model), browser = client(publication);
  browser.sandbox.BriefRoadmapData.view(publication.model, { catalogueQuery: 'Roadmap 37', catalogueTopic: 'all' });

  const result = browser.settle({ catalogueQuery: 'Roadmap 39', catalogueTopic: 'all' });

  assert.deepEqual(Array.from(result.roadmaps, (rm) => rm.roadmapId), [input.roadmaps[39].roadmapId]);
});
