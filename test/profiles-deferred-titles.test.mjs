import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openTitleBrowser, titleKey, titleMouse, assertAliasTitles } from './helpers/profiles-title-browser.mjs';

const base = JSON.parse(fs.readFileSync(new URL('./fixtures/profiles-view-state.json', import.meta.url), 'utf8'));
const selector = '#pf-route-agents-explore-backup';
const fixtureState = () => {
  const state = structuredClone(base);
  state.catalog = {
    fable: { model: 'anthropic/claude-opus-5-5', variant: 'medium' },
    unavailable: { model: 'fixture/vendor/disabled:free', variant: 'high', unsupported: true,
      unsupportedReason: 'UNSUPPORTED_MODEL', unsupportedHome: 'stable' },
    unknown: { model: 'fixture/vendor/unknown:v4.1', variant: 'low', unsupported: true,
      unsupportedReason: 'REGISTRY_UNKNOWN', unsupportedHome: 'primary' },
    gpt: { model: 'fixture/gpt-supported', variant: 'high' },
    available: { model: 'fixture/vendor/available:v41', variant: 'high' },
  };
  for (const row of state.routing.rows) row.model = 'fable';
  return state;
};
// Independent expectation: fixture catalog fields, never renderer helpers or observed titles.
const expectedAliases = (state, route = 'agents/explore') => Object.fromEntries(Object.entries(state.catalog)
  .filter(([alias, entry]) => route.startsWith('primary/') ? route !== 'primary/hephaestus'
    || entry.model.split('/').slice(1).join('/').startsWith('gpt-') : alias !== 'fable').map(([alias, entry]) => [alias, {
    title: entry.model + (entry.unsupported
      ? ' · ' + entry.unsupportedReason + (entry.unsupportedHome ? ' · ' + entry.unsupportedHome : '') : ''),
    disabled: entry.unsupported === true, reason: entry.unsupported ? entry.unsupportedReason : '',
    variant: entry.variant || entry.reasoning || '',
  }]));
const eventsOf = (page, type) => page.eval(`titleEvents.filter(event => event.type === ${JSON.stringify(type)})`);
async function prepare(page, tab = 'agents', route = 'agents/explore') {
  await page.eval(`titleController.selectTab(${JSON.stringify(tab)});
    titleController.openRow(${JSON.stringify(route.startsWith('primary/') ? 'agent:' + route.split('/')[1] : 'route:' + route)});
    globalThis.titleEvents = []; true`);
}

// R: native input timing and complete disabled pools cannot be established by a fake DOM or serialized HTML.
test('alias titles contain full ID, reason and home before trusted native mouse, focus and keyboard defaults', { timeout: 60000 }, async (t) => {
  for (const mode of ['mouse', 'focus', 'keyboard']) await t.test(mode, async (t) => {
    const fixture = { state: fixtureState() }, page = await openTitleBrowser(t, fixture);
    await prepare(page);
    const initial = await page.eval(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)});
      return [...select.options].map(option => ({ value: option.value, title: option.getAttribute('title') }));
    })()`);
    assert.deepEqual(initial.map((option) => option.value), ['', ...Object.keys(expectedAliases(fixture.state))]);
    assert.deepEqual(initial.map((option) => option.title), initial.map(() => null), 'serialized aliases defer titles');
    if (mode === 'mouse') await titleMouse(page, selector);
    else {
      // The full-ID line immediately precedes the alias picker in the actual editor.
      await page.eval(`document.querySelector('#pf-route-agents-explore-backup-model-fullid').focus()`);
      await titleKey(page, 'Tab');
      assert.equal(await page.eval('document.activeElement.id'), selector.slice(1));
      if (mode === 'keyboard') {
        await page.eval(`document.querySelector(${JSON.stringify(selector)}).querySelectorAll('option')
          .forEach(option => option.removeAttribute('title')); titleEvents = []; true`);
        await titleKey(page, 'ArrowDown', 1);
      }
    }
    const type = mode === 'mouse' ? 'pointerdown' : mode === 'focus' ? 'focusin' : 'keydown';
    assertAliasTitles(await eventsOf(page, type), expectedAliases(fixture.state));
    await titleKey(page, 'Escape');
  });
});

// R: every rendered alias picker, including disabled options, is covered rather than one representative dictionary.
test('every Primary, Agents and Categories backup picker hydrates its complete real option pool on use', { timeout: 60000 }, async (t) => {
  const fixture = { state: fixtureState() }, page = await openTitleBrowser(t, fixture);
  for (const tab of ['primary', 'agents', 'categories']) {
    const rows = tab === 'primary'
      ? ['sisyphus', 'hephaestus', 'prometheus', 'atlas'].map((role) => ({ section: 'primary', role }))
      : fixture.state.routing.rows.filter((row) => row.section === tab);
    assert.ok(rows.length > 0, tab + ' fixture rows exist');
    for (const row of rows) {
      const route = row.section + '/' + row.role;
      await prepare(page, tab, route);
      const pick = `[data-pf="route-backup"][data-route="${route}"]`;
      await titleMouse(page, pick);
      assertAliasTitles(await eventsOf(page, 'pointerdown'), expectedAliases(fixture.state, route));
      await titleKey(page, 'Escape');
    }
  }
});

// R: current view must win over stale titles both after load and after page.region keeps identical serialized HTML.
test('load replaces titles and touch refreshes retained DOM from current model, reason and home', { timeout: 60000 }, async (t) => {
  const fixture = { state: fixtureState() };
  // Keep ordinary pin pools on their own provider so this alias-only home change genuinely leaves HTML unchanged.
  for (const [agent, item] of Object.entries(fixture.state.roster.agents)) {
    item.pin = agent === 'hephaestus'
      ? { provider: 'fixture', modelId: 'gpt-supported', thinking: 'high' }
      : { provider: 'anthropic', modelId: 'claude-opus-5-5', thinking: 'medium' };
  }
  const page = await openTitleBrowser(t, fixture);
  await prepare(page);
  await titleMouse(page, selector);
  await titleKey(page, 'Escape');
  fixture.state = structuredClone(fixture.state);
  Object.assign(fixture.state.catalog.unavailable, {
    model: 'fixture/vendor/reloaded:v4', unsupportedReason: 'REGISTRY_UNKNOWN', unsupportedHome: 'new-home',
  });
  await page.eval('titleController.load()');
  await page.eval('titleEvents = []; true');
  await titleKey(page, 'ArrowDown', 1);
  assertAliasTitles(await eventsOf(page, 'keydown'), expectedAliases(fixture.state));
  await titleKey(page, 'Escape');
  await page.eval(`globalThis.retainedTitleSelect = document.querySelector(${JSON.stringify(selector)});
    titleController.snapshot().view.catalog.unavailable.unsupportedHome = 'touch-only-home';
    titleController.touch(); true`);
  fixture.state.catalog.unavailable.unsupportedHome = 'touch-only-home';
  assert.equal(await page.eval(`retainedTitleSelect === document.querySelector(${JSON.stringify(selector)})`), true,
    'original page.region must retain the same DOM when only deferred title data changes');
  assert.equal(await page.eval(`retainedTitleSelect.querySelector('option[value="unavailable"]').title`),
    'fixture/vendor/reloaded:v4 · REGISTRY_UNKNOWN · new-home', 'the stale title makes this regression discriminating');
  await page.eval('titleEvents = []; true');
  await titleKey(page, 'ArrowDown', 1);
  assertAliasTitles(await eventsOf(page, 'keydown'), expectedAliases(fixture.state));
  await titleKey(page, 'Escape');
});

// R: a supported transition must remove the old reason/home and disabled state rather than append another title.
test('a reloaded supported alias loses stale unsupported details and becomes selectable', { timeout: 60000 }, async (t) => {
  const fixture = { state: fixtureState() }, page = await openTitleBrowser(t, fixture);
  await prepare(page);
  await titleMouse(page, selector);
  await titleKey(page, 'Escape');
  fixture.state = structuredClone(fixture.state);
  Object.assign(fixture.state.catalog.unavailable, { unsupported: false, unsupportedReason: '', unsupportedHome: '' });
  await page.eval('titleController.load()');
  await page.eval('titleEvents = []; true');
  await titleKey(page, 'ArrowDown', 1);
  assertAliasTitles(await eventsOf(page, 'keydown'), expectedAliases(fixture.state));
  await titleKey(page, 'Escape');
});

// R: native selection must reach the existing alias payload and selected full-ID accessibility description.
test('native alias choice retains payload, selected flag, full-ID title and aria description', { timeout: 60000 }, async (t) => {
  const fixture = { state: fixtureState() }, page = await openTitleBrowser(t, fixture);
  await prepare(page);
  await page.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await titleKey(page, 'ArrowDown');
  const actual = await page.eval(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    return { value: select.value, title: select.title, selected: [...select.options].filter(option => option.selected).map(option => option.value),
      describedBy: select.getAttribute('aria-describedby'),
      descriptionTag: document.getElementById(select.getAttribute('aria-describedby')).tagName,
      code: document.getElementById(select.getAttribute('aria-describedby')).querySelector('code').textContent,
      description: document.getElementById(select.getAttribute('aria-describedby')).textContent,
      pending: titleController.snapshot().pending };
  })()`);
  assert.deepEqual(actual.pending, [{ kind: 'setRoleBackup', profileKey: base.activeProfile.omoProfile,
    section: 'agents', role: 'explore', alias: 'gpt' }]);
  assert.equal(actual.value, 'gpt', 'native ArrowDown skips both disabled aliases');
  assert.deepEqual(actual.selected, ['gpt']);
  assert.equal(actual.title, fixture.state.catalog.gpt.model);
  assert.equal(actual.describedBy, selector.slice(1) + '-fullid');
  assert.equal(actual.descriptionTag, 'P');
  assert.equal(actual.code, fixture.state.catalog.gpt.model + ' · gpt');
  assert.equal(actual.description, fixture.state.catalog.gpt.model + ' · gpt');
  await page.eval('titleEvents = []; true');
  await titleMouse(page, selector);
  assertAliasTitles(await eventsOf(page, 'pointerdown'), expectedAliases(fixture.state), 'gpt');
  await titleKey(page, 'Escape');
});

// R: setAttribute and rendering must preserve malicious-looking fixture data without creating markup.
test('current JIT model and home characters remain exact text without injected elements', { timeout: 60000 }, async (t) => {
  const fixture = { state: fixtureState() };
  const payload = `<img src=x onerror="globalThis.titleInjected=1">&'`;
  fixture.state.catalog.unavailable.model = 'fixture/vendor/' + payload + ':free';
  fixture.state.catalog.unavailable.unsupportedHome = payload;
  const page = await openTitleBrowser(t, fixture);
  await prepare(page);
  await titleMouse(page, selector);
  assertAliasTitles(await eventsOf(page, 'pointerdown'), expectedAliases(fixture.state));
  const escaped = await page.eval(`({
    images: document.querySelectorAll('[data-pf-root] img').length,
    injected: globalThis.titleInjected || 0,
    markup: document.querySelector(${JSON.stringify(selector)}).outerHTML
  })`);
  assert.equal(escaped.images, 0);
  assert.equal(escaped.injected, 0);
  assert.ok(escaped.markup.includes('&lt;img'));
  assert.ok(!escaped.markup.includes('<img'));
  assert.ok(!escaped.markup.includes('&amp;lt;img'), 'input is escaped exactly once');
  await titleKey(page, 'Escape');
});
