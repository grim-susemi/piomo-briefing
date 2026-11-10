import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeController } from './fixtures/controller-dom.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/profiles-view-state.json', import.meta.url), 'utf8'));
fixture.guide.rows = [{
  id: 'agents/explore', group: 'routing', section: 'agents', role: 'explore', labelEn: 'Explore',
  applyScope: 'native-gpt-kimi-deepseek', purposeGroup: 'discovery',
  current: { alias: 'fable', modelId: 'anthropic/claude-opus-5-5', thinking: 'medium', origin: 'profile',
    sourceFile: 'fixture/omo.jsonc', sourcePath: '$.profiles.native.agents.explore', reason: 'explicit route' },
  recommended: { HasRecommendation: true, status: 'recommended', Official: 'anthropic/claude-opus-5-5 / medium' },
  linked: { active: false, effective: false, candidates: ['deep-low', 'deep-high'] },
}];
const edit = () => ({ live: true, pending: [], draft: {}, preview: null, busy: false, loading: false });

function renderGuide(state = structuredClone(fixture), changes = edit()) {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.byId.main.innerHTML = e.ctx.BriefProfiles.render(state, changes);
  return { e, dialog: e.byId.main.querySelector('#pf-guide-dlg'), state };
}

test('guide comparison keeps four main fields and moves held, linked and effective evidence into row details', () => {
  const { dialog, state } = renderGuide();
  const rows = dialog.querySelectorAll('[data-guide-row]');
  assert.equal(rows.length, state.guide.rows.length);
  assert.deepEqual(dialog.querySelectorAll('thead th').map(cell => cell.textContent),
    ['ROLE', 'CURRENT', 'RECOMMENDED', 'STATUS'], 'comparison exposes exactly four column headers');
  for (const row of rows) {
    assert.deepEqual(row.querySelectorAll('[data-guide-field]').map(cell => cell.getAttribute('data-guide-field')),
      ['GROUP / ROLE / SCOPE', 'CURRENT', 'RECOMMENDED', 'STATUS']);
    const toggle = row.querySelector('[data-pf="guide-row-toggle"]');
    assert.ok(toggle, `${row.getAttribute('data-guide-row')}: detail toggle`);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    const detail = dialog.querySelector('#' + toggle.getAttribute('aria-controls'));
    assert.ok(detail, 'toggle controls a real detail row');
    assert.equal(detail.tagName, 'TR');
    assert.equal(row.parentElement.children[row.parentElement.children.indexOf(row) + 1], detail,
      'details immediately follow their owner row');
    assert.equal(detail.hasAttribute('hidden'), true);
    assert.deepEqual(detail.querySelectorAll('[data-guide-field]').map(cell => cell.getAttribute('data-guide-field')),
      ['HELD', 'LINKED', 'EFFECTIVE']);
  }
});

function renderRow(row, state = structuredClone(fixture), changes = edit()) {
  const { e } = renderGuide(state, changes);
  const api = e.ctx.BriefProfiles;
  const body = e.document.createElement('tbody');
  body.innerHTML = api.guideRowHtml(api.guideRowModel(row, state, changes));
  const main = body.querySelector('[data-guide-row]');
  const toggle = main.querySelector('[data-pf="guide-row-toggle"]');
  return { main, detail: body.querySelector('#' + toggle.getAttribute('aria-controls')), api, body };
}

test('guide recommendations split only the literal spaced Official delimiter and honor absent recommendations', () => {
  const row = structuredClone(fixture.guide.rows[0]);
  row.recommended.Official = 'provider/first>variant / low > provider/second / high>suffix';
  const { main } = renderRow(row);
  assert.deepEqual(main.querySelectorAll('[data-guide-field="RECOMMENDED"] ol li').map(li => li.textContent),
    ['provider/first>variant / low', 'provider/second / high>suffix']);
  row.recommended.HasRecommendation = false;
  const absent = renderRow(row).main.querySelector('[data-guide-field="RECOMMENDED"]');
  assert.equal(absent.querySelectorAll('li').length, 0);
  assert.ok(absent.textContent.includes('공식 권장 없음'));
  assert.equal(absent.textContent.includes('provider/first'), false);
});

test('guide preserves lowercase official, uppercase Status and recommendation escaping at the rendered boundary', () => {
  const row = structuredClone(fixture.guide.rows[0]);
  row.recommended = { HasRecommendation: true, Status: 'future-status', official: '<not-a-tag>&model / low > second/model / high' };
  const { main } = renderRow(row);
  const items = main.querySelectorAll('[data-guide-field="RECOMMENDED"] li');
  assert.deepEqual(items.map(item => item.textContent), ['<not-a-tag>&model / low', 'second/model / high']);
  assert.equal(items[0].children.length, 0, 'recommendation input is text rather than markup');
  assert.equal(main.querySelector('[data-guide-field="STATUS"] .pf-chip').textContent, 'future-status');
});

test('guide details retain source, linked metadata and literal no-alias evidence', () => {
  const row = structuredClone(fixture.guide.rows[0]);
  row.linked = { active: false, effective: false, candidates: ['candidate-one', 'candidate-two'],
    EffectiveCategory: 'category-proof', EffectiveAlias: 'alias-proof', reason: 'linked-reason-proof' };
  const { detail } = renderRow(row);
  for (const value of ['fable', 'anthropic/claude-opus-5-5', 'fixture/omo.jsonc',
    '$.profiles.native.agents.explore', 'explicit route', 'candidate-one', 'candidate-two',
    'category-proof', 'alias-proof', 'linked-reason-proof', 'native-gpt-kimi-deepseek', 'discovery',
    'anthropic/claude-opus-5-5 / medium', 'the case when there is no alias']) {
    assert.ok(detail.textContent.includes(value), `detail retains ${value}`);
  }
  for (const field of ['HELD', 'LINKED', 'EFFECTIVE']) {
    const block = detail.querySelector(`[data-guide-field="${field}"]`);
    assert.ok(block.textContent.includes(field), `${field} retains its visible label`);
  }
});

test('guide current distinguishes same, distinct and unresolved linked values without losing the current model', () => {
  for (const [linked, expected, absent] of [
    [{ active: true, effective: true, modelId: 'anthropic/claude-opus-5-5', thinking: 'medium' },
      ['claude-opus-5-5', 'medium'], []],
    [{ active: true, effective: true, modelId: 'kimi-coding/kimi-k3', thinking: 'max' },
      ['claude-opus-5-5', 'medium', 'LINKED', 'kimi-k3', 'max'], []],
    [{ active: true, effective: false, modelId: '', reason: 'missing linked candidate' },
      ['claude-opus-5-5', 'missing linked candidate'], ['kimi-k3']],
  ]) {
    const row = structuredClone(fixture.guide.rows[0]);
    row.linked = linked;
    const text = renderRow(row).main.querySelector('[data-guide-field="CURRENT"]').textContent;
    for (const value of expected) assert.ok(text.includes(value), `${value} stays visible`);
    for (const value of absent) assert.equal(text.includes(value), false);
    if (linked.modelId === row.current.modelId) {
      assert.equal(text.split('claude-opus-5-5').length - 1, 1, 'identical linked model is displayed once');
    }
  }
});

test('guide raw statuses including fallback retain text identity with textless SVG glyphs', () => {
  const glyphs = {};
  for (const status of ['recommended', 'fallback', 'different', 'variant-different', 'untracked', 'unresolved']) {
    const row = structuredClone(fixture.guide.rows[0]);
    row.recommended.status = status;
    const chip = renderRow(row).main.querySelector('[data-guide-field="STATUS"] .pf-chip');
    assert.equal(chip.textContent, status);
    assert.equal(chip.getAttribute('title'), status);
    assert.equal(chip.getAttribute('aria-label'), status);
    const glyph = chip.querySelector('svg');
    assert.ok(glyph, `${status} has an SVG glyph`);
    assert.equal(glyph.textContent, '');
    assert.ok(glyph.children.length > 0, `${status} glyph has drawn geometry`);
    glyphs[status] = glyph.innerHTML;
  }
  assert.notEqual(glyphs.fallback, glyphs.recommended, 'fallback and recommended have distinct status shapes');
});

test('guide HELD preserves the original group, section, role and profile association rules', () => {
  const row = structuredClone(fixture.guide.rows[0]);
  const route = { kind: 'setRoute', section: 'agents', role: 'explore', profileKey: 'native-gpt-kimi-deepseek',
    provider: 'fixture', model: 'fixture/route-owned', thinking: 'high' };
  const changes = { ...edit(), pending: [
    route,
    { ...route, kind: 'setRoleBackup', model: 'fixture/backup-owned' },
    { ...route, profileKey: 'gpt-kimi-deepseek', model: 'fixture/card-key-owned' },
    { ...route, profileKey: 'native-gpt-deepseek', model: 'fixture/wrong-profile' },
    { ...route, profileKey: '', model: 'fixture/no-profile' },
    { ...route, section: 'categories', model: 'fixture/wrong-section' },
    { ...route, role: 'librarian', model: 'fixture/wrong-role' },
    { ...route, agentId: 'atlas', profileKey: 'gpt-deepseek', role: 'elsewhere', model: 'fixture/agent-equality-owned' },
    { kind: 'setMain', profileKey: 'gpt-kimi-deepseek', provider: 'fixture', model: 'fixture/main-owned', thinking: 'low' },
    { kind: 'setMain', profileKey: 'gpt-deepseek', provider: 'fixture', model: 'fixture/main-other', thinking: 'low' },
    { kind: 'setAgentLane', agentId: 'atlas', lane: 'agent-lane-owned', profileKey: 'gpt-deepseek' },
    { kind: 'setMemoryRow', row: 'kibitzer', profileKey: 'gpt-deepseek', mode: 'custom', model: 'fixture/memory-owned', reasoning: 'max' },
    { kind: 'setSummarizer', profileKey: 'gpt-deepseek', modelId: 'fixture/summary-owned' },
  ] };
  for (const [identity, wanted, excluded] of [
    [{ group: 'routing', section: 'agents', role: 'explore' },
      ['route-owned', 'backup-owned', 'card-key-owned'], ['wrong-profile', 'no-profile', 'wrong-section', 'wrong-role', 'main-owned']],
    [{ group: 'primary', role: 'sisyphus' }, ['main-owned'], ['main-other', 'route-owned', 'agent-lane-owned']],
    [{ group: 'primary', role: 'atlas' }, ['agent-equality-owned', 'agent-lane-owned'], ['main-owned', 'memory-owned']],
    [{ group: 'memory', role: 'kibitzer' }, ['memory-owned'], ['summary-owned', 'route-owned']],
    [{ group: 'memory', role: 'reflection' }, [], ['memory-owned', 'summary-owned', 'route-owned']],
    [{ group: 'summary', role: 'summary' }, ['summary-owned'], ['memory-owned', 'route-owned']],
  ]) {
    const { detail } = renderRow({ ...row, ...identity }, structuredClone(fixture), changes);
    const text = detail.querySelector('[data-guide-field="HELD"]').textContent;
    for (const value of wanted) assert.ok(text.includes(value), `${identity.group}/${identity.role} includes ${value}`);
    assert.deepEqual([...wanted].sort((a, b) => text.indexOf(a) - text.indexOf(b)), wanted, 'HELD retains pending order');
    for (const value of excluded) assert.equal(text.includes(value), false, `${identity.group}/${identity.role} excludes ${value}`);
    assert.doesNotMatch(text, /"kind":|"profileKey":/);
  }
});

test('guide keeps source order across repeated group transitions and folds provenance below the table', () => {
  const state = structuredClone(fixture);
  const base = state.guide.rows[0];
  state.guide.rows = [base, { ...base, id: 'primary/atlas', group: 'primary', role: 'atlas', labelEn: 'Atlas' },
    { ...base, id: 'categories/extra', group: 'routing', section: 'categories', role: 'extra', labelEn: 'extra' },
    { ...base, id: 'categories/extra-two', group: 'routing', section: 'categories', role: 'extra-two', labelEn: 'extra-two' }];
  state.guide.guideUrl = 'https://fixture.invalid/guide';
  const { dialog } = renderGuide(state);
  const rows = dialog.querySelectorAll('[data-guide-row]');
  assert.deepEqual(rows.map(row => row.getAttribute('data-guide-row')), ['agents/explore', 'primary/atlas', 'categories/extra', 'categories/extra-two']);
  assert.deepEqual(rows.map(row => row.getAttribute('data-guide-row-group')), ['routing', 'primary', 'routing', 'routing']);
  const detailIds = rows.map(row => row.querySelector('[data-pf="guide-row-toggle"]').getAttribute('aria-controls'));
  const headers = dialog.querySelectorAll('tbody tr').filter(row =>
    !row.hasAttribute('hidden') && !row.hasAttribute('data-guide-row') && !detailIds.includes(row.id));
  assert.equal(headers.length, 3, 'one group header occurs at each source transition');
  const provenance = dialog.querySelector('#pf-sec-guide').closest('details');
  assert.ok(provenance);
  assert.equal(provenance.hasAttribute('open'), false);
  for (const source of state.guide.sources) {
    assert.ok(provenance.textContent.includes(source.path));
    assert.ok(provenance.textContent.includes(source.sha256));
  }
  assert.ok(provenance.textContent.includes('https://fixture.invalid/guide'));
  assert.ok(dialog.innerHTML.indexOf('</table>') < dialog.innerHTML.indexOf('id="pf-sec-guide"'));
});

test('guide pure row functions do not mutate input and interleaved views do not leak held changes', () => {
  const { e } = renderGuide();
  const api = e.ctx.BriefProfiles;
  const row = structuredClone(fixture.guide.rows[0]);
  const state = structuredClone(fixture);
  const changes = { ...edit(), shown: 'gpt-kimi-deepseek', pending: [{ kind: 'setRoute', section: 'agents', role: 'explore',
    profileKey: 'gpt-kimi-deepseek', provider: 'fixture', model: 'fixture/held-first', thinking: 'high' }] };
  const before = JSON.stringify({ row, state, changes });
  const first = api.guideRowModel(row, state, changes);
  const firstBefore = JSON.stringify(first);
  const firstHtml = api.guideRowHtml(first);
  const otherState = structuredClone(fixture);
  const otherChanges = { ...edit(), shown: 'gpt-deepseek', pending: [{ kind: 'setRoute', section: 'agents', role: 'explore',
    profileKey: 'gpt-deepseek', provider: 'fixture', model: 'fixture/held-second', thinking: 'low' }] };
  const otherBefore = JSON.stringify({ otherState, otherChanges });
  const second = api.guideRowModel(row, otherState, otherChanges);
  const secondHtml = api.guideRowHtml(second);
  assert.equal(api.guideRowHtml(first), firstHtml, 'another view does not overwrite the first row model');
  assert.equal(JSON.stringify(first), firstBefore, 'HTML rendering leaves its row model intact');
  assert.equal(JSON.stringify({ row, state, changes }), before);
  assert.ok(firstHtml.includes('held-first'));
  assert.equal(secondHtml.includes('held-first'), false);
  assert.ok(secondHtml.includes('held-second'));
  assert.equal(firstHtml.includes('held-second'), false);
  assert.equal(JSON.stringify({ otherState, otherChanges }), otherBefore);
});
