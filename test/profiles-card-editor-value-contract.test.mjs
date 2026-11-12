import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeLiveScaleHome, loadProfilesView, renderValueContract } from './helpers/profiles-live-scale.mjs';

// R: opened widgets emit public hooks absent from the existing closed-surface contract.
// Missing declarations or reordered, misidentified or extra widget hooks must fail.
function assertEditorSurface(surface, baseline, profile) {
  const expected = surface.name === 'guide' ? [] : [
    ...['name', 'tag', 'summary'].map(field => ({
      tag: field === 'summary' ? 'textarea' : 'input',
      hooks: [{ id: `pf-card-${profile.key}-${field}` }, { 'data-pf': `card-${field}` }],
    })),
    ...['save-profile-card', 'cancel-profile-card', ...(profile.custom ? [] : ['reset-profile-card'])]
      .map(action => ({ tag: 'button', hooks: [{ 'data-pf': action }] })),
  ];
  const oldTokens = new Set(baseline.items.map(token => JSON.stringify(token)));
  const elements = expected.map(target => {
    const matches = surface.elements.filter(element => element.tag === target.tag
      && JSON.stringify(element.hooks) === JSON.stringify(target.hooks));
    assert.equal(matches.length, 1, `${surface.name}/${profile.key}: exact editor control identity`);
    return matches[0];
  });
  const removed = new Set();
  const orderedIndices = [];
  for (const element of elements) {
    assert.equal(element.duplicateHooks, false);
    assert.equal(element.indices.length, element.hooks.length);
    for (const [offset, hook] of element.hooks.entries()) {
      const index = element.indices[offset];
      assert.equal(oldTokens.has(JSON.stringify(hook)), false, 'editor cannot exempt an old value');
      assert.ok(Number.isInteger(index) && index >= 0 && index < surface.items.length);
      assert.equal(removed.has(index), false, 'editor token positions cannot overlap');
      assert.deepEqual(surface.items[index], hook, 'exact editor token position');
      removed.add(index);
      orderedIndices.push(index);
    }
  }
  if (elements.length) {
    const anchor = baseline.elements.find(element => element.tag === 'button'
      && element.hooks.some(hook => hook['data-pf'] === 'apply-card')
      && element.hooks.some(hook => hook['data-profile'] === profile.key));
    assert.ok(anchor, 'existing same-profile apply anchor');
    const anchors = surface.elements.filter(element => element.tag === anchor.tag
      && JSON.stringify(element.hooks) === JSON.stringify(anchor.hooks));
    assert.equal(anchors.length, 1, 'existing apply anchor remains unique');
    const start = anchors[0].indices.at(-1) + 1;
    assert.deepEqual(orderedIndices, orderedIndices.map((_, index) => start + index),
      'editor controls follow their same-profile apply anchor in document order');
  }
  // Remove positions, never matching scalar values or entire pre-existing elements.
  // Select tokens and their complete option records remain in this ordered comparison.
  const retained = surface.items.filter((_, index) => !removed.has(index));
  assert.deepEqual(retained, baseline.items,
    `retained ordered value contract: ${surface.name}/${profile.key} (including selects)`);
  return elements;
}

test('every opened card editor declares its exact public hooks and IDs on each applicable surface', t => {
  const api = loadProfilesView();
  const state = makeLiveScaleHome(t, { future: true, scale: false }).store.state();
  const closed = renderValueContract(api, state);
  const observed = new Map(closed.filter(surface => surface.name !== 'guide')
    .map(surface => [surface.name, new Map()]));
  const manifest = JSON.parse(fs.readFileSync(new URL(
    './fixtures/profiles/live-scale/value-contract.additions.json', import.meta.url), 'utf8'));
  const retainedCoverage = [];

  for (const profile of state.profiles) {
    const cardEdit = { key: profile.key, name: profile.name, tag: profile.tag, summary: profile.summary };
    const opened = renderValueContract({
      render: (view, edit) => api.render(view, { ...edit, cardEdit }),
    }, state);
    for (const [index, surface] of opened.entries()) {
      const elements = assertEditorSurface(surface, closed[index], profile);
      for (const element of elements) {
        for (const hook of element.hooks) {
          observed.get(surface.name).set(JSON.stringify(hook), hook);
        }
      }
      if (surface.name !== 'guide') retainedCoverage.push({
        profile: profile.key, surface: surface.name,
        retainedTokens: surface.items.length - elements.reduce((count, element) => count + element.indices.length, 0),
        closedTokens: closed[index].items.length,
        selectTokens: closed[index].items.filter(token => token.select === true).length,
      });
    }
  }

  assert.ok(Array.isArray(manifest.cardEditor), 'open card editor declarations must exist');
  for (const record of manifest.cardEditor) {
    assert.deepEqual(Object.keys(record).sort(), ['reason', 'surface', 'value']);
    assert.ok(observed.has(record.surface), 'declaration names an applicable current surface');
    assert.ok(typeof record.reason === 'string' && record.reason.trim());
    assert.deepEqual(Object.keys(record.value).length, 1, 'existing scalar hook schema');
    const [[key, value]] = Object.entries(record.value);
    assert.ok(['id', 'data-pf'].includes(key) && typeof value === 'string');
  }
  for (const [surface, tokens] of observed) {
    const declared = manifest.cardEditor.filter(record => record.surface === surface).map(record => record.value);
    assert.deepEqual(declared, [...tokens.values()],
      `${surface}: every actual opened-widget hook is declared exactly once in encounter order`);
  }
  t.diagnostic(JSON.stringify({ profiles: state.profiles.map(profile => profile.key),
    surfaces: [...observed.keys()], declarations: manifest.cardEditor.length, retainedCoverage }));
});

// R: the old unseen-hook filter accepted these open-only changes to existing content.
test('opened editor retention rejects old option changes, deletion, reorder and repeated old profile hooks', t => {
  const api = loadProfilesView();
  const state = makeLiveScaleHome(t, { future: true, scale: false }).store.state();
  const closed = renderValueContract(api, state), profile = state.profiles[0];
  const cardEdit = { key: profile.key, name: profile.name, tag: profile.tag, summary: profile.summary };
  const oldCard = /<button\b[^>]*data-pf="select-profile"[^>]*>[\s\S]*?<\/button>/g;
  const cases = [
    ['old option value changed only while open',
      html => html.replace(/(<option\b[^>]*\bvalue=")[^"]*/, '$1__open_only_changed_option__')],
    ['old element deleted', html => html.replace(new RegExp(oldCard.source), '')],
    ['old elements reordered', html => {
      const cards = [...html.matchAll(oldCard)];
      assert.ok(cards.length >= 2, 'private reorder input has two old cards');
      return html.replace(oldCard, (match, offset) => offset === cards[0].index ? cards[1][0]
        : offset === cards[1].index ? cards[0][0] : match);
    }],
    ['extra element with existing data-profile', html => html + `<i data-profile="${profile.key}"></i>`],
  ];
  const failures = [];
  for (const [name, mutate] of cases) {
    const actual = renderValueContract({
      render: (view, edit) => mutate(api.render(view, { ...edit, cardEdit })),
    }, state);
    for (const [index, surface] of actual.entries()) {
      if (surface.name === 'guide') continue;
      assert.throws(() => assertEditorSurface(surface, closed[index], profile), error => {
        assert.ok(error instanceof assert.AssertionError, name);
        assert.match(error.message, /^retained ordered value contract:/, name);
        failures.push({ name, surface: surface.name, boundary: error.message.split('\n')[0] });
        return true;
      }, name);
    }
  }
  t.diagnostic(JSON.stringify({ counterexamples: failures }));
});
