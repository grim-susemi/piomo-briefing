// Public DOM values and POST protocol survive display-only refactors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeLiveScaleHome, loadProfilesView, renderValueContract, controllerValueContract } from './helpers/profiles-live-scale.mjs';
import { scopedElementIndices } from './helpers/profiles-contract-elements.mjs';

const fixture = new URL('./fixtures/profiles/live-scale/', import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL(name, fixture), 'utf8'));

// Private boundary samples start without native edit buttons; canonical output stays real.
function privateEditButtonFixture(html) {
  return html.replace(/<button\b[^>]*\sdata-pf="edit-profile-card"(?=\s|>)[^>]*>[\s\S]*?<\/button>/g, '');
}

function assertScreenContract(actual, baseline, additions) {
  assert.ok(Array.isArray(additions));
  for (const item of additions) assert.ok(actual.some(surface => surface.name === item.surface), 'addition surface must exist');
  for (const [index, surface] of actual.entries()) {
    const documented = additions.filter(item => item.surface === surface.name);
    const scoped = scopedElementIndices(surface, baseline[index], documented);
    const allowed = documented.filter(item => !Object.hasOwn(item, 'element'));
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
    const retained = surface.items.filter((value, tokenIndex) => !scoped.has(tokenIndex)
      && !allowed.some(item => JSON.stringify(item.value) === JSON.stringify(value)));
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

test('documented new element permits a same-profile button through the real collector', t => {
  const api = loadProfilesView(), state = makeLiveScaleHome(t).store.state();
  // Private output decorator: all original markup comes from the public renderer.
  const decorated = { render: (...args) => privateEditButtonFixture(api.render(...args)).replace('</article>',
    '<button data-pf="edit-profile-card" data-profile="gpt-kimi-deepseek">Edit</button></article>') };
  const actual = renderValueContract(decorated, state)[0];
  const baseline = read('value-contract.json').surfaces[0];
  const addition = { surface: 'top', reason: 'Edit this existing profile card',
    element: { tag: 'button', anchor: { 'data-pf': 'edit-profile-card', 'data-profile': 'gpt-kimi-deepseek' },
      hooks: [{ 'data-pf': 'edit-profile-card' }, { 'data-profile': 'gpt-kimi-deepseek' }] } };
  const allowed = read('value-contract.additions.json').screen.filter(item => item.surface === 'top'
    && !(item.element?.tag === 'button' && item.element.anchor?.['data-pf'] === 'edit-profile-card'));
  assert.doesNotThrow(() => assertScreenContract([actual], [baseline], [...allowed, addition]));
  assert.throws(() => assertScreenContract([actual], [baseline], allowed), /top value contract/);
  assert.equal(baseline.items.filter(item => item['data-profile'] === 'gpt-kimi-deepseek').length, 2);
  assert.equal(actual.items.filter(item => item['data-profile'] === 'gpt-kimi-deepseek').length, 3);
  t.diagnostic('Private real-output decorator adds 2 hooks; original profile multiplicity 2, actual 3.');
});

test('new element scope rejects old mutations, ambiguous metadata and additions outside its tag', t => {
  const api = loadProfilesView(), state = makeLiveScaleHome(t).store.state(), outputs = new Map();
  // Cache only genuine public-renderer output, then privately mutate those bytes.
  const collect = transform => renderValueContract({ render: (...args) => {
    const key = JSON.stringify(args[1]);
    if (!outputs.has(key)) outputs.set(key, privateEditButtonFixture(api.render(...args)));
    return transform(outputs.get(key));
  } }, state)[0];
  const baseline = collect(html => html);
  const button = '<button data-pf="edit-profile-card" data-profile="gpt-kimi-deepseek">Edit</button>';
  const inject = html => html.replace('</article>', button + '</article>');
  const actual = collect(inject);
  const element = { tag: 'button', anchor: { 'data-pf': 'edit-profile-card', 'data-profile': 'gpt-kimi-deepseek' },
    hooks: [{ 'data-pf': 'edit-profile-card' }, { 'data-profile': 'gpt-kimi-deepseek' }] };
  const addition = { surface: 'top', reason: 'Private new edit button', element };
  const check = (surface, declarations) => assertScreenContract([surface], [baseline], declarations);
  const oldCard = /<button\b[^>]*data-pf="select-profile"[^>]*>[\s\S]*?<\/button>/;
  const oldHooks = /data-pf="select-profile" data-profile="gpt-kimi-deepseek"/;
  for (const [name, mutate] of [
    ['original element removal', html => html.replace(oldCard, '')],
    ['original hook removal', html => html.replace(oldHooks, 'data-pf="select-profile"')],
    ['original profile change', html => html.replace(oldHooks, 'data-pf="select-profile" data-profile="changed"')],
    ['original ID removal', html => html.replace(/ id="[^"]*"/, '')],
    ['original ID change', html => html.replace(/ id="([^"]*)"/, ' id="$1-changed"')],
    ['original relative reorder', html => {
      const cards = [...html.matchAll(new RegExp(oldCard.source, 'g'))];
      return html.replace(new RegExp(oldCard.source, 'g'), (match, offset) =>
        offset === cards[0].index ? cards[1][0] : offset === cards[1].index ? cards[0][0] : match);
    }],
    ['old option value', html => html.replace(/(<option\b[^>]*value=")[^"]*/, '$1changed')],
    ['old option selected', html => html.replace(/(<option\b[^>]*)( selected)/, '$1')],
    ['old option disabled', html => html.replace(/(<option\b[^>]*)( disabled)/, '$1')],
    ['outside rogue hook', html => html + '<i data-profile="rogue"></i>'],
    ['outside duplicate hook', html => html + '<i data-pf="edit-profile-card"></i>'],
    ['nested select token', html => html.replace(button, button.replace('</button>', '<select><option value="rogue"></option></select></button>'))],
  ]) {
    assert.throws(() => check(collect(html => mutate(inject(html))), [addition]), /top value contract/, name);
  }
  for (const [name, declarations, pattern] of [
    ['existing anchor', [{ ...addition, element: { ...element, anchor: { ...element.anchor, 'data-pf': 'select-profile' } } }], /new edit anchor/],
    ['duplicate declaration', [addition, addition], /overlapping element declarations/],
    ['unused surface', [{ ...addition, surface: 'absent' }], /addition surface must exist/],
    ['unused anchor', [{ ...addition, element: { ...element, anchor: { ...element.anchor, 'data-profile': 'absent' } } }], /existing profile/],
    ['wrong tag', [{ ...addition, element: { ...element, tag: 'select' } }], /only new edit buttons/],
    ['missing hook', [{ ...addition, element: { ...element, hooks: element.hooks.slice(0, 1) } }], /anchor hooks required/],
    ['extra hook', [{ ...addition, element: { ...element, hooks: [...element.hooks, { id: 'rogue' }] } }], /complete tracked-hook vector/],
    ['wrong profile hook', [{ ...addition, element: { ...element, hooks: [element.hooks[0], { 'data-profile': 'changed' }] } }], /profile hook binds anchor/],
    ['wrong hook order', [{ ...addition, element: { ...element, hooks: [...element.hooks].reverse() } }], /complete tracked-hook vector/],
    ['duplicate hook', [{ ...addition, element: { ...element, hooks: [...element.hooks, element.hooks[0]] } }], /duplicate hook declaration/],
    ['select hook', [{ ...addition, element: { ...element, hooks: [...element.hooks, { select: true, options: [] }] } }], /singleton hook/],
    ['unknown hook', [{ ...addition, element: { ...element, hooks: [...element.hooks, { class: 'rogue' }] } }], /tracked hook only/],
    ['malformed element', [{ ...addition, element: null }], /element record/],
    ['malformed hooks', [{ ...addition, element: { ...element, hooks: null } }], /complete hook vector/],
    ['malformed anchor', [{ ...addition, element: { ...element, anchor: null } }], /anchor record/],
    ['wildcard metadata', [{ ...addition, element: { ...element, wildcard: true } }], /element fields/],
    ['missing reason', [{ ...addition, reason: '' }], /element reason/],
    ['partial anchor', [{ ...addition, element: { ...element, anchor: { 'data-pf': 'edit-profile-card' } } }], /exact edit anchor/],
    ['extra metadata', [{ ...addition, extra: true }], /element declaration fields/],
    ['singleton overlap', [addition, { surface: 'top', reason: 'Rogue waiver', value: element.hooks[0] }], /singleton overlaps element scope/],
  ]) assert.throws(() => check(actual, declarations), pattern, name);
  for (const [name, changed, declaration, pattern] of [
    ['ambiguous anchor', button + button, addition, /match exactly one tag/],
    ['unused declaration', '', addition, /match exactly one tag/],
    ['actual wrong tag', button.replaceAll('button', 'span'), addition, /element tag/],
    ['duplicate actual hook', button.replace('data-pf=', 'data-pf="edit-profile-card" data-pf='), addition, /duplicate actual hook/],
    ['actual extra tracked hook', button.replace('>Edit', ' data-row="rogue">Edit'), addition, /complete tracked-hook vector/],
    ...['id', 'data-flow', 'data-row', 'data-pf'].map(key => {
      const hook = baseline.items.find(item => Object.hasOwn(item, key));
      return ['old ' + key, button, { ...addition, element: { ...element, hooks: [...element.hooks, hook] } }, /old hook cannot be exempted|duplicate hook declaration/];
    }),
  ]) assert.throws(() => check(collect(html => html.replace('</article>', changed + '</article>')), [declaration]), pattern, name);
  const newId = { id: 'private-new-edit-id' };
  const withId = { ...addition, element: { ...element, hooks: [newId, ...element.hooks] } };
  const identified = html => inject(html).replace(button, button.replace('data-pf=', 'id="private-new-edit-id" data-pf='));
  assert.doesNotThrow(() => check(collect(identified), [withId]));
  assert.throws(() => check(collect(html => identified(html) + '<i id="private-new-edit-id"></i>'), [withId]), /new ID must be unique/);
  assert.throws(() => check(collect(html => inject(html) + '<i data-pf="edit-profile-card"></i>'),
    [addition, { surface: 'top', reason: 'Rogue waiver', value: element.hooks[0] }]), /singleton overlaps element scope/);
  assert.throws(() => check(actual, [{ surface: 'top', reason: 'Old singleton exemption',
    value: element.hooks[1] }]), /an addition cannot exempt an existing item/);
  assert.throws(() => check(actual, [{ surface: 'top', reason: 'Unused singleton',
    value: { id: 'absent' } }]), /addition must exist/);
  // Supplemental synthetic metadata case: an already-existing edit anchor is never new.
  assert.throws(() => assertScreenContract([actual], [{ ...baseline, items: [...baseline.items, element.hooks[0]] }],
    [addition]), /anchor must be genuinely new/);
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
