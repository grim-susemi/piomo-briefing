// Public DOM values and POST protocol survive display-only refactors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeLiveScaleHome, loadProfilesView, renderValueContract, controllerValueContract } from './helpers/profiles-live-scale.mjs';

const fixture = new URL('./fixtures/profiles/live-scale/', import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL(name, fixture), 'utf8'));

function assertScreenContract(actual, baseline, additions) {
  assert.ok(Array.isArray(additions));
  for (const [index, surface] of actual.entries()) {
    const allowed = additions.filter(item => item.surface === surface.name);
    for (const item of allowed) {
      assert.ok(typeof item.reason === 'string' && item.reason.trim());
      assert.ok(item.value !== null && typeof item.value === 'object' && !Array.isArray(item.value));
      if (Object.hasOwn(item.value, 'select')) {
        assert.deepEqual(Object.keys(item.value).sort(), ['options', 'select']);
        assert.equal(item.value.select, true);
        assert.ok(Array.isArray(item.value.options));
        for (const option of item.value.options) {
          assert.ok(option !== null && typeof option === 'object' && !Array.isArray(option));
          assert.deepEqual(Object.keys(option).sort(), ['data-provider', 'disabled', 'selected', 'value']);
          assert.equal(typeof option.value, 'string');
          assert.equal(typeof option.disabled, 'boolean');
          assert.equal(typeof option.selected, 'boolean');
          assert.ok(option['data-provider'] === null || typeof option['data-provider'] === 'string');
        }
      } else {
        assert.equal(Object.keys(item.value).length, 1);
        assert.ok(Object.entries(item.value).every(([key, value]) =>
          ['id', 'data-pf', 'data-flow', 'data-row', 'data-profile'].includes(key) && typeof value === 'string'));
      }
      assert.ok(!baseline[index].items.some(value => JSON.stringify(value) === JSON.stringify(item.value)),
        'an addition cannot exempt an existing item');
      assert.ok(surface.items.some(value => JSON.stringify(value) === JSON.stringify(item.value)), 'addition must exist');
    }
    const retained = surface.items.filter(value => !allowed.some(item => JSON.stringify(item.value) === JSON.stringify(value)));
    assert.equal(surface.name, baseline[index].name);
    assert.deepEqual(retained, baseline[index].items, `${surface.name} value contract`);
  }
  assert.equal(actual.length, baseline.length);
}

test('synthetic real-store homes cover long model IDs and future custom profiles', t => {
  const fx = makeLiveScaleHome(t), state = fx.store.state();
  const entries = Object.entries(state.catalog);
  assert.ok(state.guide.rows.length >= 27);
  assert.ok(state.routing.rows.length >= 22);
  assert.ok(new Set(entries.map(([, entry]) => entry.model)).size >= 128);
  assert.ok(new Set(entries.map(([, entry]) => entry.model.split('/')[0])).size >= 14);
  assert.ok(Math.max(...entries.map(([alias, entry]) => `${alias} · ${entry.model}`.length)) >= 93);
  assert.ok(entries.some(([, entry]) => entry.model.split('/').length === 3));
  assert.ok(entries.some(([, entry]) => entry.model.includes(':')));
  assert.ok(entries.some(([, entry]) => entry.model === 'susemi-deepseek-web/deepseek-chat'));
  assert.equal(state.profiles.length, 6);
  const future = makeLiveScaleHome(t, { future: true });
  const cards = JSON.parse(fs.readFileSync(new URL('runtime/native-profile-switcher-profile-cards.json',
    'file:///' + future.primary.replaceAll('\\', '/') + '/'), 'utf8'));
  assert.equal(cards.custom.length, 3);
  assert.equal(cards.cards['gpt-kimi-deepseek'].name, 'Synthetic renamed default');
  for (const home of [future.primary, future.stable]) {
    const config = JSON.parse(fs.readFileSync(home + '/omo.jsonc', 'utf8'));
    for (const item of cards.custom) assert.deepEqual(config.profiles[item.omoProfile], config.profiles['native-experimental-custom']);
  }
  t.diagnostic(JSON.stringify({ guide: state.guide.rows.length, roles: state.routing.rows.length,
    models: entries.length, providers: new Set(entries.map(([, e]) => e.model.split('/')[0])).size,
    longest: Math.max(...entries.map(([alias, e]) => `${alias} · ${e.model}`.length)) }));
});

test('rendered values retain document order and permit only documented additive hooks and selects', t => {
  const baseline = read('value-contract.json'), additions = read('value-contract.additions.json');
  const actual = renderValueContract(loadProfilesView(), makeLiveScaleHome(t).store.state());
  assertScreenContract(actual, baseline.surfaces, additions.screen);
  t.diagnostic('HTML bytes ' + JSON.stringify(actual.map(({ name, htmlBytes }) => ({ name, htmlBytes }))));
});

test('documented new select tokens preserve old selects and reject malformed option records', () => {
  const surface = read('value-contract.json').surfaces[0];
  const oldIndex = surface.items.findIndex(item => item.select === true);
  const oldSelect = surface.items[oldIndex];
  const nextIndex = surface.items.findIndex((item, index) => index > oldIndex && item.select === true
    && JSON.stringify(item) !== JSON.stringify(oldSelect));
  const newSelect = { select: true, options: [
    { ...oldSelect.options[0], value: 'fixture-new-profile-base' },
  ] };
  const addition = { surface: surface.name, reason: 'New profile base selector', value: newSelect };
  const actual = { ...surface, items: [...surface.items, newSelect] };
  assert.doesNotThrow(() => assertScreenContract([actual], [surface], [addition]));
  assert.throws(() => assertScreenContract([actual], [surface], []), assert.AssertionError);
  for (const items of [
    [...surface.items.slice(0, oldIndex), ...surface.items.slice(oldIndex + 1), newSelect],
    surface.items.map((item, index) => index === oldIndex ? newSelect : item),
    surface.items.map((item, index) => index === oldIndex
      ? { ...oldSelect, options: oldSelect.options.map(option => ({ ...option, value: option.value + '-changed' })) } : item).concat(newSelect),
    surface.items.map((item, index) => index === oldIndex ? surface.items[nextIndex]
      : index === nextIndex ? oldSelect : item).concat(newSelect),
  ]) {
    assert.throws(() => assertScreenContract([{ ...surface, items }], [surface], [addition]), assert.AssertionError);
  }
  assert.throws(() => assertScreenContract([surface], [surface], [{ ...addition, value: oldSelect }]), assert.AssertionError);
  const option = newSelect.options[0];
  const missingSelected = { ...option };
  delete missingSelected.selected;
  for (const malformed of [
    null, [], missingSelected, { ...option, extra: true }, { ...option, value: 1 },
    { ...option, disabled: 'false' }, { ...option, selected: 1 }, { ...option, 'data-provider': false },
  ]) {
    const token = { select: true, options: [malformed] };
    assert.throws(() => assertScreenContract([{ ...surface, items: [...surface.items, token] }],
      [surface], [{ ...addition, value: token }]), assert.AssertionError);
  }
  for (const token of [{ ...newSelect, select: false }, { ...newSelect, extra: true }, { select: true, options: {} }]) {
    assert.throws(() => assertScreenContract([{ ...surface, items: [...surface.items, token] }],
      [surface], [{ ...addition, value: token }]), assert.AssertionError);
  }
});

test('real controller preserves changes bytes and expected targets through preview and apply', async t => {
  const baseline = read('value-contract.json'), additions = read('value-contract.additions.json');
  const posts = await controllerValueContract(loadProfilesView(), makeLiveScaleHome(t, { scale: false }).store.state());
  assert.equal(posts.length, 2);
  assert.ok(Array.isArray(additions.expected));
  for (const [index, post] of posts.entries()) {
    assert.deepEqual(post.fields, ['action', 'changes', 'expected', 'rosterRevision']);
    assert.equal(post.action, baseline.posts[index].action);
    assert.equal(post.changes, baseline.posts[index].changes);
    assert.equal(post.rosterRevision, baseline.posts[index].rosterRevision);
    const expected = { ...post.expected };
    for (const addition of additions.expected) {
      assert.ok(typeof addition.reason === 'string' && addition.reason.trim());
      assert.ok(!Object.hasOwn(baseline.posts[index].expected, addition.key));
      assert.ok(Object.hasOwn(expected, addition.key));
      delete expected[addition.key];
    }
    assert.deepEqual(expected, baseline.posts[index].expected);
  }
});
