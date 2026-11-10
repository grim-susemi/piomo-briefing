// F1-B3/B4: the real store state feeds the real renderer. These tests never build a
// hand-made view model: openProfilesStore().state() reads temp homes and the extension-
// owned memory files, and the same object goes straight into BriefProfiles.render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { formatJsonText, openProfilesStore } from '../src/profiles/store.mjs';
import { defaultRoster } from '../src/profiles/contract/schema.mjs';
import { createBoardServer } from '../src/server.mjs';
import { pageHtml } from '../src/render.mjs';
import { launch, listProfilePids } from '../scripts/cdp.mjs';
import { assertGuideIdentity } from './helpers/profiles-identity.mjs';
import { AGENT_DISPLAY } from '../src/profiles/refresh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const GOLDEN = path.join(here, 'fixtures', 'profiles', 'goldens', 'apply-gpt-kimi-deepseek', 'files');
const REAL_INVENTORY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'profiles', 'inventory.json'), 'utf8'));
const STYLE = { bom: false, eol: '\n', indent: '  ', keySep: ': ', trailingNewline: true };
const PLUGIN_BODY = 'state-render-plugin-body';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const MANIFEST = {
  schemaVersion: 1,
  title: 'OMO 모델·역할 권장 가이드 (fixture)',
  snapshotDate: '2026-10-20',
  sources: [
    { name: 'installed task bundle', kind: 'installed', path: 'plugin/extensions/omo-task.js', blobSha: 'a', webUrl: 'https://www.npmjs.com/package/omo-ai/v/5.1.33' },
    { name: 'installed main bundle', kind: 'installed', path: 'plugin/extensions/omo.js', blobSha: 'b' },
  ],
  coverage: [
    { section: 'agents', role: 'explore', route: true, expectationRole: 'explore', recommendation: { model: 'deepseek-v4-flash', variant: 'high', tier: 'recommended' } },
    { section: 'agents', role: 'librarian', route: true, expectationRole: 'librarian', recommendation: { model: 'kimi-for-coding-highspeed', variant: 'off', tier: 'recommended' } },
    { section: 'categories', role: 'quick', route: true, expectationRole: 'quick', recommendation: { model: 'gpt-6-luna-fast', variant: 'low', tier: 'recommended' } },
  ],
  expectations: [
    { role: 'explore', candidates: [{ model: 'deepseek-v4-flash', variants: ['high'], tier: 'recommended' }] },
    { role: 'librarian', candidates: [{ model: 'kimi-for-coding-highspeed', variants: ['off'], tier: 'recommended' }] },
    { role: 'quick', candidates: [{ model: 'gpt-6-luna-fast', variants: ['low'], tier: 'recommended' }] },
  ],
};

function readGolden(name) {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN, name), 'utf8'));
}

function makeFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-t21-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary');
  const stable = path.join(root, 'stable');
  fs.mkdirSync(path.join(primary, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(stable, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'omo.jsonc'), formatJsonText(readGolden('primary/omo.jsonc.json'), STYLE));
  fs.writeFileSync(path.join(primary, 'agent', 'settings.json'), formatJsonText(readGolden('primary/settings.json.json'), STYLE));
  fs.writeFileSync(path.join(primary, 'native-profile-selection.json'),
    JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'seed' }));
  fs.writeFileSync(path.join(primary, 'agent', 'native-profile-selection.json'),
    JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'seed' }));
  fs.writeFileSync(path.join(stable, 'omo.jsonc'), formatJsonText(readGolden('stable/omo.jsonc.json'), STYLE));
  fs.writeFileSync(path.join(stable, 'agent', 'settings.json'), '{"packages":["stable-package"]}');
  const plugin = path.join(root, 'omo.js');
  fs.writeFileSync(plugin, PLUGIN_BODY);
  const inventory = options.inventory ?? {
    ...REAL_INVENTORY,
    sources: {
      ...REAL_INVENTORY.sources,
      omo: { ...REAL_INVENTORY.sources.omo, sha256: sha(Buffer.from(PLUGIN_BODY)) },
    },
  };
  const store = openProfilesStore({
    primaryHome: primary,
    stableHome: stable,
    mirrorHomes: [],
    pluginPath: plugin,
    inventory,
    recommendationManifest: options.recommendationManifest === undefined ? MANIFEST : options.recommendationManifest,
    registryModels: options.registryModels,
    registry: options.registry,
    fs: options.fs,
    now: () => Date.parse('2026-10-20T12:00:00Z'),
  });
  return { root, primary, stable, store, inventory };
}

function loadView() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'page', 'icons.js'), 'utf8'), context, { filename: 'icons.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'page', 'profiles-view.js'), 'utf8'), context, { filename: 'profiles-view.js' });
  assert.equal(typeof context.BriefProfiles?.render, 'function');
  return context.BriefProfiles;
}

const liveEdit = () => ({
  live: true, pending: [], draft: {}, preview: null, conflict: false, error: '', status: '', result: null, busy: false, loading: false,
});

const textOf = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#96;/g, '`').replace(/&amp;/g, '&');

const rowOf = (state, section, role) => state.routing.rows.find((row) => row.section === section && row.role === role);

test('real state(): selected gate keeps current, recommended and linked evidence together through rendering', (t) => {
  const fx = makeFixture(t);
  const configFile = path.join(fx.primary, 'omo.jsonc');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.profiles['native-gpt-kimi-deepseek']['[native]'].agents['omo-native-gate-reviewer'] = { model: 'sol-61-high' };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const state = fx.store.state();
  const row = rowOf(state, 'agents', 'omo-native-gate-reviewer');
  assert.equal(row.current.alias, 'sol-61-high');
  assert.equal(row.current.modelId, 'chatgpt-subscription/gpt-6.1-sol');
  assert.equal(row.recommended.status, 'untracked');
  assert.equal(row.recommended.provenance.available, true);
  assert.deepEqual(row.recommended.provenance.sources, MANIFEST.sources.map(({ path, blobSha }) => ({ path, blobSha })));
  assert.equal(row.linked.active, false);
  assert.equal(row.linked.effective, false);
  const before = JSON.stringify(state);
  const html = loadView().render(state, liveEdit());
  assert.match(textOf(html), /sol-61-high/);
  assert.equal(JSON.stringify(state), before, 'render does not overwrite any evidence block');
  assert.equal(state.guide.rows.length, 27);
  assert.equal(state.guide.rows.find((item) => item.id === 'agents/omo-native-gate-reviewer').current.alias, 'sol-61-high');
});

test('real state(): closed and expanded linked reviewer agree with guide without promoting unresolved or explicit aliases', (t) => {
  const fx = makeFixture(t);
  const file = path.join(fx.primary, 'omo.jsonc');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const layer = config.profiles['native-gpt-kimi-deepseek']['[native]'];
  delete layer.agents['omo-native-gate-reviewer'];
  fs.writeFileSync(file, JSON.stringify(config));
  const view = loadView();
  const edit = { ...liveEdit(), tab: 'agents', openRow: 'route:agents/omo-native-gate-reviewer' };
  const routeHtml = state => view.render(state, edit)
    .split('data-pf-route="agents/omo-native-gate-reviewer"')[1].split('data-pf-route=')[0];
  let state = fx.store.state();
  let row = rowOf(state, 'agents', 'omo-native-gate-reviewer');
  assert.equal(row.current.alias, '');
  assert.equal(row.current.effective, false);
  assert.equal(row.linked.active, true);
  assert.equal(row.linked.effective, true);
  assert.equal(row.linked.modelId, 'kimi-coding/k3');
  assert.equal(row.linked.thinking, 'max');
  const html = routeHtml(state);
  const linkedPrimary = /class="pf-row-primary" title="([^"]*)">([^<]*)<\/span>/.exec(html);
  assert.ok(linkedPrimary, 'linked primary summary remains separate from the backup summary');
  assert.deepEqual(linkedPrimary.slice(1), [
    row.linked.modelId + ' / ' + row.linked.thinking,
    row.linked.modelId.split('/').slice(1).join('/') + ' / ' + row.linked.thinking,
  ]);
  assert.match(html, /pf-row-sum-o">.*LINKED/);
  assert.equal(row.linked.EffectiveCategory, 'unspecified-high');
  assert.equal(row.linked.EffectiveAlias, 'kimi-max');
  assert.match(html, /title="LINKED" aria-label="LINKED">LINKED/);
  assert.match(html, /value="kimi-coding\/k3"[^>]* selected/);
  assert.match(html, /value="max" selected/);
  assert.equal(state.guide.rows.find(item => item.id === 'agents/omo-native-gate-reviewer').linked.modelId, row.linked.modelId);

  layer.agents['omo-native-gate-reviewer'] = { model: 'sol-61-high' };
  fs.writeFileSync(file, JSON.stringify(config));
  state = fx.store.state();
  row = rowOf(state, 'agents', 'omo-native-gate-reviewer');
  assert.equal(row.linked.active, false);
  const explicitPrimary = /class="pf-row-primary" title="([^"]*)">([^<]*)<\/span>/.exec(routeHtml(state));
  assert.ok(explicitPrimary, 'explicit primary summary remains separate from the backup summary');
  assert.deepEqual(explicitPrimary.slice(1), [
    row.current.modelId + ' / ' + row.current.thinking,
    row.current.modelId.split('/').slice(1).join('/') + ' / ' + row.current.thinking,
  ]);
  assert.doesNotMatch(routeHtml(state), />LINKED</);

  delete layer.agents['omo-native-gate-reviewer'];
  layer.categories['deep-high'] = { model: 'missing-model' };
  layer.categories['unspecified-high'] = { model: 'missing-model' };
  fs.writeFileSync(file, JSON.stringify(config));
  state = fx.store.state();
  row = rowOf(state, 'agents', 'omo-native-gate-reviewer');
  assert.equal(row.linked.active, true);
  assert.equal(row.linked.effective, false);
  assert.equal(row.linked.modelId, '');
  assert.match(routeHtml(state), /Unavailable/);
  assert.doesNotMatch(routeHtml(state), />LINKED</);
});

test('allocation guide: all real rows, raw DOM and AX identity, read-only lifecycle and narrow order (Chrome)', { timeout: 90000 }, async (t) => {
  const writes = [];
  const guardedFs = new Proxy(fs, { get(target, key) {
    if (['writeFileSync', 'renameSync', 'unlinkSync'].includes(key)) return (...args) => {
      writes.push([key, String(args[0])]); return target[key](...args);
    };
    return target[key];
  } });
  const fx = makeFixture(t, { fs: guardedFs });
  const file = path.join(fx.primary, 'omo.jsonc');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.profiles['native-gpt-kimi-deepseek']['[native]'].agents['omo-native-gate-reviewer'] = { model: 'sol-61-high' };
  fs.writeFileSync(file, JSON.stringify(config));
  const state = fx.store.state();
  const expected = state.guide.rows.map(row => ({
    id: row.id, role: row.role,
    name: row.labelEn || AGENT_DISPLAY[row.role] ||
      ({ kibitzer: 'Kibitzer', reflection: 'Reflection' })[row.role] || row.role,
    status: row.recommended.status,
  }));
  assert.equal(expected.length, 27);
  const groups = Object.fromEntries(['primary', 'routing', 'memory', 'summary'].map(group =>
    [group, state.guide.rows.filter(row => row.group === group).length]));
  assert.deepEqual(groups, { primary: 4, routing: 20, memory: 2, summary: 1 });
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/view-model-board.json'), 'utf8'));
  const server = createBoardServer({ portBase: 50500 + (process.pid % 20) * 8, portCount: 8, generation: 7, token: 'guide-fixture',
    getPage: ({ nonce } = {}) => pageHtml(model, 7, { mode: 'server', token: 'guide-fixture', nonce }),
    getViewModel: () => model, profilesState: () => state });
  const { port } = await server.start();
  let page, profileDir;
  const measurements = [];
  const out = process.env.OMO_PROFILE_GUIDE_EVIDENCE;
  const until = predicate => page.eval(`new Promise((resolve, reject) => {
    const check = () => !!(${predicate});
    if (check()) return resolve(true);
    const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); clearTimeout(timer); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('guide fixture deadline')); }, 10000);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  })`);
  try {
    page = await launch({ width: 1600, height: 900 });
    profileDir = page.profileDir;
    await page.goto(`http://127.0.0.1:${port}/`);
    await until(`document.querySelector('[data-sh="view"][data-key="profiles"]')`);
    await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
    await until(`document.querySelector('[data-guide-row="summary"]')`);
    const closedAx = await page.client.send('Accessibility.getFullAXTree');
    const closedNames = closedAx.nodes.filter(node => !node.ignored).map(node => node.name?.value);
    for (const profile of state.profiles) assert.ok(closedNames.includes(profile.name), `${profile.key}: AX profile identity`);
    const tabRowIds = await page.eval(`[
      ...[...document.querySelectorAll('[data-pf-agent]')].map(row => 'primary/' + row.dataset.pfAgent),
      ...[...document.querySelectorAll('[data-pf-route]')].map(row => row.dataset.pfRoute),
      ...[...document.querySelectorAll('[data-pf-memory-row]')].map(row => 'memory/' + row.dataset.pfMemoryRow),
      'summary'
    ]`);
    assert.deepEqual(tabRowIds.slice().sort(), expected.map(row => row.id).sort(), 'guide set equals every real tab row plus summary');
    await page.eval(`(() => {
      window.__guideRequests = [];
      const original = window.fetch;
      window.fetch = (...args) => { window.__guideRequests.push(args[0]); return original(...args); };
      document.querySelector('[data-pf="guide-open"]').focus();
      document.querySelector('[data-pf="guide-open"]').click();
    })()`);
    assert.equal(await page.eval(`document.querySelector('#pf-guide-dlg').open`), true);
    const focusIds = await page.eval(`(() => {
      const controls = [...document.querySelector('#pf-guide-dlg').querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')]
        .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
      controls.forEach((el, index) => { el.dataset.guideFocusProbe = String(index); });
      controls[0].focus();
      return controls.map(el => el.dataset.guideFocusProbe);
    })()`);
    assert.ok(focusIds.length >= 5, 'close, three filters and row toggles are keyboard reachable');
    for (const modifiers of [0, 8]) {
      const order = modifiers === 0 ? [...focusIds.slice(1), focusIds[0]]
        : [...focusIds.slice(1).reverse(), focusIds[0]];
      for (const wanted of order) {
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
        assert.equal(await page.eval(`document.activeElement?.dataset.guideFocusProbe`), wanted,
          'Tab cycles all visible dialog controls in document order and wraps inside the dialog');
      }
    }
    if (process.env.OMO_PROFILE_IDENTITY_FAILURE) {
      const selector = process.env.OMO_PROFILE_IDENTITY_FAILURE === 'status'
        ? '[data-guide-field="STATUS"] .pf-chip' : '[data-guide-name]';
      await page.eval(`document.querySelector(${JSON.stringify(selector)}).textContent = '번역됨'`);
    }
    const actual = await page.eval(`[...document.querySelectorAll('[data-guide-row]')].map(row => ({
      id: row.dataset.guideRow, role: row.querySelector('[data-guide-role]').textContent,
      name: row.querySelector('[data-guide-name]').textContent,
      status: row.querySelector('[data-guide-field="STATUS"] .pf-chip').textContent,
      fields: [...row.querySelectorAll('[data-guide-field]')].map(cell => cell.dataset.guideField),
      detailFields: [...document.getElementById(row.querySelector('[data-pf="guide-row-toggle"]').getAttribute('aria-controls')).querySelectorAll('[data-guide-field]')]
        .map(cell => cell.dataset.guideField),
      text: row.textContent + document.getElementById(row.querySelector('[data-pf="guide-row-toggle"]').getAttribute('aria-controls')).textContent
    }))`);
    const ax = await page.client.send('Accessibility.getFullAXTree');
    const axNames = ax.nodes.filter(node => !node.ignored).map(node => node.name?.value).filter(Boolean);
    assertGuideIdentity(actual, expected, axNames);
    const fields = ['GROUP / ROLE / SCOPE', 'CURRENT', 'RECOMMENDED', 'STATUS'];
    for (const row of actual) {
      assert.deepEqual(row.fields, fields);
      assert.deepEqual(row.detailFields, ['HELD', 'LINKED', 'EFFECTIVE']);
    }
    const gate = actual.find(row => row.id === 'agents/omo-native-gate-reviewer');
    assert.match(gate.text, /sol-61-high/);
    assert.match(gate.text, /the case when there is no alias/);
    assert.equal(await page.eval(`document.querySelectorAll('#pf-guide-dlg [data-pf="apply"]').length`), 0);
    for (const [width, height] of [[1440, 900], [1024, 900], [390, 844]]) {
      await page.client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await page.eval(`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
      const metrics = await page.eval(`(() => {
        const dialog = document.querySelector('#pf-guide-dlg');
        return { width: innerWidth, horizontalScroll: dialog.scrollWidth - dialog.clientWidth,
          scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight,
          maxRowHeight: Math.max(...[...dialog.querySelectorAll('[data-guide-row]')].map(row => row.getBoundingClientRect().height)),
          wrappedRecommendations: [...dialog.querySelectorAll('[data-guide-field="RECOMMENDED"] li')].filter(item => {
            const range = document.createRange(); range.selectNodeContents(item);
            return range.getClientRects().length > 1;
          }).length,
          rows: [...dialog.querySelectorAll('[data-guide-row]')].map(row => ({
            id: row.dataset.guideRow, cells: [...row.children].map(cell => {
              const r = cell.getBoundingClientRect(); return { field: cell.dataset.guideField, x: r.x, y: r.y, w: r.width, h: r.height };
            })
          })) };
      })()`);
      assert.equal(metrics.horizontalScroll, 0);
      assert.equal(metrics.wrappedRecommendations, 0, `${width}: recommendation items never wrap`);
      if (width === 1440) {
        assert.ok(metrics.scrollHeight / metrics.clientHeight <= 2.5, '27 collapsed rows fit within 2.5 dialog heights');
        assert.ok(metrics.maxRowHeight <= 96, 'collapsed rows are at most 96px');
      }
      if (width === 390) assert.ok(metrics.scrollHeight <= 9000, 'phone guide length stays within 9000px');
      if (width < 600) for (const row of metrics.rows) {
        assert.deepEqual(row.cells.map(cell => cell.field), fields);
        assert.equal(new Set(row.cells.map(cell => cell.x)).size, 1);
        for (let i = 1; i < row.cells.length; i++) assert.ok(row.cells[i].y >= row.cells[i - 1].y + row.cells[i - 1].h - 1);
      }
      measurements.push(metrics);
      const sticky = await page.eval(`(() => {
        const dialog = document.querySelector('#pf-guide-dlg');
        dialog.scrollTop = dialog.scrollHeight;
        const box = dialog.getBoundingClientRect(), head = dialog.querySelector('thead th').getBoundingClientRect();
        return { top: head.top, bottom: head.bottom, dialogTop: box.top, dialogBottom: box.bottom };
      })()`);
      assert.ok(sticky.top >= sticky.dialogTop && sticky.bottom <= sticky.dialogBottom,
        `${width}: header stays inside the dialog at the last row`);
      if (out) {
        fs.mkdirSync(out, { recursive: true });
        if (width < 600) await page.eval(`document.querySelector('[data-guide-row="agents/omo-native-gate-reviewer"]').scrollIntoView({ block: 'start' })`);
        await page.screenshot(path.join(out, `guide-${width}.png`));
      }
    }
    const filterCounts = {
      all: state.guide.rows.length,
      different: state.guide.rows.filter(row => !['recommended', 'fallback', 'untracked'].includes(row.recommended.status)).length,
      untracked: state.guide.rows.filter(row => row.recommended.HasRecommendation === false).length,
    };
    for (const filter of ['different', 'untracked', 'all']) {
      await page.eval(`document.querySelector('[data-pf="guide-filter"][data-guide-filter="${filter}"]').click()`);
      const filtered = await page.eval(`(() => {
        const dialog = document.querySelector('#pf-guide-dlg');
        return {
          ids: [...dialog.querySelectorAll('[data-guide-row]')].map(row => row.dataset.guideRow),
          visible: [...dialog.querySelectorAll('[data-guide-row]')].filter(row => !row.hidden).map(row => row.dataset.guideRow),
          focused: document.activeElement?.dataset.guideFilter,
          counts: Object.fromEntries([...dialog.querySelectorAll('[data-pf="guide-filter"]')].map(button =>
            [button.dataset.guideFilter, (button.textContent.match(/\\d+/g) || []).map(Number)]))
        };
      })()`);
      assert.deepEqual(filtered.ids, expected.map(row => row.id), 'filter retains every source row in DOM order');
      const visible = state.guide.rows.filter(row => filter === 'all' ||
        (filter === 'untracked' ? row.recommended.HasRecommendation === false
          : !['recommended', 'fallback', 'untracked'].includes(row.recommended.status))).map(row => row.id);
      assert.deepEqual(filtered.visible, visible);
      assert.equal(filtered.focused, filter, 'rerender restores focus to the active filter');
      for (const [key, count] of Object.entries(filterCounts)) assert.deepEqual(filtered.counts[key], [count],
        `${key}: count always describes the unfiltered source`);
    }
    const details = await page.eval(`(() => {
      const ids = [...document.querySelectorAll('[data-guide-row]')].map(row => row.dataset.guideRow);
      return ids.map(id => {
        const row = document.querySelector('[data-guide-row="' + id + '"]');
        row.querySelector('[data-pf="guide-row-toggle"]').click();
        const toggle = document.querySelector('[data-guide-row="' + id + '"] [data-pf="guide-row-toggle"]');
        const detail = document.getElementById(toggle.getAttribute('aria-controls'));
        return { id, detailId: detail.id, expanded: toggle.getAttribute('aria-expanded'), hidden: detail.hidden,
          focused: document.activeElement === toggle, text: detail.textContent };
      });
    })()`);
    assert.equal(new Set(details.map(row => row.detailId)).size, expected.length, 'every row owns distinct details');
    for (const [index, detail] of details.entries()) {
      assert.equal(detail.expanded, 'true');
      assert.equal(detail.hidden, false);
      assert.equal(detail.focused, true, 'rerender restores focus to the expanded row toggle');
      const source = state.guide.rows[index];
      for (const value of [source.current.alias, source.current.modelId, source.current.sourceFile,
        source.current.sourcePath, source.current.reason, source.applyScope, source.purposeGroup,
        source.recommended.Official, source.linked.EffectiveCategory, source.linked.EffectiveAlias,
        ...(source.linked.candidates || [])].filter(Boolean)) {
        assert.ok(detail.text.includes(value), `${source.id}: details retain ${value}`);
      }
    }
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await page.eval(`document.querySelector('#pf-guide-dlg').open`), false);
    assert.equal(await page.eval(`document.activeElement?.getAttribute('data-pf')`), 'guide-open');
    await page.eval(`document.querySelector('[data-pf="guide-open"]').click()`);
    assert.equal(await page.eval(`document.querySelector('#pf-guide-dlg').open`), true);
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('[data-guide-row]')].map(row => row.dataset.guideRow)`),
      expected.map(row => row.id), 'reopen retains the exact guide rows');
    await page.eval(`document.querySelector('[data-pf="guide-close"]').click()`);
    assert.equal(await page.eval(`document.activeElement?.getAttribute('data-pf')`), 'guide-open');
    // Stage a real edit, open the guide, then complete a second edit while it is
    // open. A page rerender must retain the modal and project the new HELD value.
    await page.eval(`(() => {
      document.querySelector('[role="tab"][data-tab="agents"]').click();
      document.querySelector('[data-pf-route="agents/explore"] .pf-row-sum').click();
      const select = document.querySelector('[data-pf-route="agents/explore"] [data-pf="route-thinking"]');
      select.value = 'high'; select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('[data-pf="guide-open"]').click();
    })()`);
    const pendingBefore = await page.eval(`document.querySelector('.pf-pending').textContent`);
    const heldThinking = await page.eval(`(() => {
      const provider = document.querySelector('[data-pf-route="agents/explore"] [data-pf="route-provider"]');
      provider.value = 'chatgpt-subscription'; provider.dispatchEvent(new Event('change', { bubbles: true }));
      const model = document.querySelector('[data-pf-route="agents/explore"] [data-pf="route-model"]');
      const next = [...model.options].map(option => option.value).find(Boolean);
      if (!next) throw new Error('fixture must expose an explicit model');
      model.value = next; model.dispatchEvent(new Event('change', { bubbles: true }));
      return document.querySelector('[data-pf-route="agents/explore"] [data-pf="route-thinking"]').value;
    })()`);
    assert.equal(await page.eval(`document.querySelector('#pf-guide-dlg').open`), true);
    const heldText = await page.eval(`(() => {
      const row = document.querySelector('[data-guide-row="agents/explore"]');
      const detail = document.getElementById(row.querySelector('[data-pf="guide-row-toggle"]').getAttribute('aria-controls'));
      return detail.querySelector('[data-guide-field="HELD"]').textContent;
    })()`);
    assert.ok(heldText.includes('agents/explore'), 'HELD identifies the staged route');
    assert.ok(heldText.includes(' / ' + heldThinking), 'HELD uses the readable change label');
    assert.doesNotMatch(heldText, /"kind":|"thinking":/, 'HELD does not expose serialized change objects');
    const pendingChanged = await page.eval(`document.querySelector('.pf-pending').textContent`);
    assert.notEqual(pendingChanged, pendingBefore);
    await page.eval(`document.querySelector('[data-pf="guide-close"]').click()`);
    assert.equal(await page.eval(`document.querySelector('.pf-pending').textContent`), pendingChanged);
    assert.equal(await page.eval(`document.activeElement?.getAttribute('data-pf')`), 'guide-open');
    assert.deepEqual(await page.eval(`window.__guideRequests`), []);
    assert.deepEqual(writes, []);
    if (out) fs.writeFileSync(path.join(out, 'guide-dump.json'), JSON.stringify({
      groups, rows: actual, sourceRows: state.guide.rows, tabRowIds, axNames, measurements, writes,
      staleState: { retainedModal: true, heldThinking, pendingUnchangedOnClose: true },
    }, null, 2) + '\n');
  } finally {
    try { if (page) await page.close(); } finally { await server.close(); }
  }
  assert.deepEqual(listProfilePids(profileDir), []);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  if (out) fs.writeFileSync(path.join(out, 'cleanup-receipt.json'), JSON.stringify({
    chromeProfileRemoved: !fs.existsSync(profileDir), chromePids: [], serverPortClosed: port, writes,
  }, null, 2) + '\n');
});

test('allocation guide: extras append dynamically and missing recommendation or unknown status remains literal', t => {
  const inventory = { ...REAL_INVENTORY, agents: [...REAL_INVENTORY.agents, 'guide-inventory-extra'] };
  const fx = makeFixture(t, { inventory });
  const file = path.join(fx.primary, 'omo.jsonc');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.profiles['native-gpt-kimi-deepseek']['[native]'].categories['guide-layer-extra'] = { model: 'sol-61-high' };
  fs.writeFileSync(file, JSON.stringify(config));
  const state = fx.store.state();
  const ids = state.guide.rows.map(row => row.id);
  assert.equal(ids.length, 29);
  assert.equal(new Set(ids).size, 29);
  assert.deepEqual(ids.slice(-2), ['categories/guide-layer-extra', 'agents/guide-inventory-extra']);
  const row = state.details[state.activeProfile.key].guide.rows.find(row => row.id === 'agents/omo-native-gate-reviewer');
  row.recommended = { status: 'future-status' };
  const html = loadView().render(state, liveEdit());
  const rendered = [...html.matchAll(/data-guide-row="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(rendered, ids);
  assert.match(html, /future-status/);
  assert.match(html, /공식 권장 없음/);
});

test('real state(): a manifest change between read and render leaves the snapshot intact and refresh reads the new version', (t) => {
  const fx = makeFixture(t);
  const manifestFile = path.join(fx.root, 'recommendation.json');
  const manifest = structuredClone(MANIFEST);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const store = openProfilesStore({
    primaryHome: fx.primary, stableHome: fx.stable, mirrorHomes: [],
    inventory: fx.inventory, pluginPath: path.join(fx.root, 'omo.js'),
    recommendationManifestPath: manifestFile,
  });
  const snapshot = store.state();
  const beforeTargets = snapshot.targets;
  manifest.title = 'Changed manifest after read';
  manifest.snapshotDate = '2099-01-01';
  manifest.expectations[0].candidates[0].model = 'changed-after-read';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const html = loadView().render(snapshot, liveEdit());
  assert.doesNotMatch(html, /changed-after-read|Changed manifest after read|2099-01-01/);
  assert.equal(rowOf(snapshot, 'agents', 'explore').recommended.provenance.snapshotDate, MANIFEST.snapshotDate);
  assert.match(rowOf(snapshot, 'agents', 'explore').recommended.Official, /deepseek-v4-flash/);
  const fresh = store.state();
  assert.equal(rowOf(fresh, 'agents', 'explore').recommended.provenance.snapshotDate, '2099-01-01');
  assert.match(rowOf(fresh, 'agents', 'explore').recommended.Official, /changed-after-read/);
  assert.deepEqual(fresh.targets, beforeTargets, 'reading and rendering never write store targets');
  fs.writeFileSync(manifestFile, 'null');
  const absent = store.state();
  assert.match(absent.warnings.join('\n'), /recommendation manifest ignored/);
  assert.equal(rowOf(absent, 'agents', 'explore').recommended.status, 'untracked');
  assert.deepEqual(absent.targets, beforeTargets);
});

test('effective models use main, pin, matching memory and lane origins through the host registry', (t) => {
  const models = [
    { provider: 'kimi-coding', id: 'k3' },
    { provider: 'openai', id: 'gpt-pin' },
    { provider: 'anthropic', id: 'memory-model' },
    { provider: 'anthropic', id: 'lane-model' },
  ];
  const fx = makeFixture(t, { registry: () => ({
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    getAvailable: () => models,
  }) });
  const roster = defaultRoster(new Date('2026-10-20T12:00:00Z'));
  roster.agents.hephaestus.pin = { provider: 'openai', modelId: 'gpt-pin', thinking: 'high' };
  roster.agents.prometheus.rev = 3;
  const agents = path.join(fx.stable, 'agent', 'primary-agents');
  fs.mkdirSync(path.join(agents, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(agents, 'roster.json'), JSON.stringify(roster));
  fs.writeFileSync(path.join(agents, 'memory', 'prometheus.json'), JSON.stringify({
    v: 1, agentId: 'prometheus', model: { provider: 'anthropic', modelId: 'memory-model' },
    thinking: 'xhigh', rosterRev: 3, updatedAt: '2026-10-20T12:00:00Z',
  }));
  const stableConfig = readGolden('stable/omo.jsonc.json');
  stableConfig.model_profiles = { 'daily-normal': { models: [{ providers: ['anthropic'], model: 'lane-model', thinking: 'low' }] } };
  if (stableConfig['[native]']) delete stableConfig['[native]'].model_profiles;
  fs.writeFileSync(path.join(fx.stable, 'omo.jsonc'), JSON.stringify(stableConfig));
  const settingsBefore = fs.readFileSync(path.join(fx.primary, 'agent', 'settings.json'));
  const memoryBefore = fs.readFileSync(path.join(agents, 'memory', 'prometheus.json'));
  const state = fx.store.state();
  assert.deepEqual(Object.fromEntries(Object.entries(state.roster.agents).map(([id, agent]) => [id, agent.effective])), {
    sisyphus: { provider: 'kimi-coding', modelId: 'k3', thinking: 'max', origin: 'main', reason: null },
    hephaestus: { provider: 'openai', modelId: 'gpt-pin', thinking: 'high', origin: 'pin', reason: null },
    prometheus: { provider: 'anthropic', modelId: 'memory-model', thinking: 'xhigh', origin: 'memory', reason: null },
    atlas: { provider: 'anthropic', modelId: 'lane-model', thinking: 'low', origin: 'lane', reason: null },
  });
  const html = loadView().render(state, liveEdit());
  assert.deepEqual([...html.matchAll(/data-pf-agent="([^"]+)"/g)].map((m) => m[1]),
    ['sisyphus', 'hephaestus', 'prometheus', 'atlas']);
  for (const [id, origin, model] of [
    ['sisyphus', 'Main', 'k3'], ['hephaestus', 'Pin', 'gpt-pin'],
    ['prometheus', 'Memory', 'memory-model'], ['atlas', 'Lane', 'lane-model'],
  ]) {
    const summary = new RegExp('data-pf-agent="' + id + '"[\\s\\S]*?<\\/button>').exec(html)[0];
    assert.match(summary, new RegExp('>' + origin + '<'));
    assert.ok(textOf(summary).includes(model), summary);
  }
  assert.match(html, /2026-10-20T12:00:00Z/);
  assert.deepEqual(fs.readFileSync(path.join(fx.primary, 'agent', 'settings.json')), settingsBefore);
  assert.deepEqual(fs.readFileSync(path.join(agents, 'memory', 'prometheus.json')), memoryBefore);
});

test('real state and staged main apply: the legacy Sisyphus Pin becomes Main after reload', async (t) => {
  const models = [
    { provider: 'kimi-coding', id: 'k3' },
    { provider: 'openai', id: 'gpt-6-sol' },
  ];
  const fx = makeFixture(t, { registry: { getAvailable: () => models } });
  const roster = defaultRoster(new Date('2026-10-20T12:00:00Z'));
  roster.agents.sisyphus.pin = { provider: 'openai', modelId: 'gpt-6-sol', thinking: 'low' };
  const rosterFile = path.join(fx.stable, 'agent', 'primary-agents', 'roster.json');
  fs.mkdirSync(path.dirname(rosterFile), { recursive: true });
  fs.writeFileSync(rosterFile, JSON.stringify(roster));
  const P = loadView();
  const posted = [];
  const controller = P.createController({
    token: 'fixture-token',
    fetch: async (url, options) => {
      if (url === '/profiles/state') return { status: 200, json: async () => fx.store.state() };
      const body = JSON.parse(options.body);
      posted.push(body);
      const result = fx.store.apply(body);
      return { status: result.status || 200, json: async () => result };
    },
  });
  await controller.load();
  const summary = (snapshot) => /data-pf-agent="sisyphus"[\s\S]*?<\/button>/.exec(P.render(snapshot.view, { ...snapshot, live: true }))[0];
  assert.match(summary(controller.snapshot()), />Pin</);
  controller.add({ kind: 'setMain', profileKey: 'gpt-kimi-deepseek', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' });
  const applied = await controller.apply();
  assert.equal(applied.result?.ok, true, JSON.stringify(applied));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].changes.some((change) => change.kind === 'setAgentPin'), false);
  assert.equal(applied.view.roster.agents.sisyphus.pin, null);
  assert.match(summary(applied), />Main</);
  assert.doesNotMatch(summary(applied), />Pin</);
});

test('real state: raw settings thinking is compared with the sidecar even while Sisyphus uses a pin', (t) => {
  const models = [{ provider: 'openai', id: 'gpt-6-sol' }];
  const fx = makeFixture(t, { registry: { getAvailable: () => models } });
  const settingsFile = path.join(fx.primary, 'agent', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.defaultThinkingLevel = 'low';
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const runtime = path.join(fx.primary, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'native-profile-switcher-main.json'), JSON.stringify({
    'native-gpt-kimi-deepseek': { provider: 'kimi-coding', model: 'k3', thinking: 'max' },
  }));
  const roster = defaultRoster(new Date('2026-10-20T12:00:00Z'));
  roster.agents.sisyphus.pin = { provider: 'openai', modelId: 'gpt-6-sol', thinking: 'high' };
  const rosterFile = path.join(fx.stable, 'agent', 'primary-agents', 'roster.json');
  fs.mkdirSync(path.dirname(rosterFile), { recursive: true });
  fs.writeFileSync(rosterFile, JSON.stringify(roster));
  const state = fx.store.state();
  assert.equal(state.mainSettingsThinking, 'low');
  assert.equal(state.main.effective.thinking, 'max');
  assert.equal(state.roster.agents.sisyphus.effective.origin, 'pin');
  assert.equal(state.roster.agents.sisyphus.effective.thinking, 'high');
  const before = fs.readFileSync(settingsFile);
  const P = loadView();
  const summary = /data-pf-agent="sisyphus"[\s\S]*?<\/button>/.exec(P.render(state, liveEdit()))[0];
  assert.match(summary, />Pin</);
  assert.match(summary, /pf-c-amber"[^>]*>thinking-mismatch · settings: low \/ sidecar: max/);
  assert.deepEqual(fs.readFileSync(settingsFile), before, 'rendering the warning does not write settings');

  settings.defaultThinkingLevel = 'max';
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  assert.doesNotMatch(P.render(fx.store.state(), liveEdit()), /thinking-mismatch/);
  delete settings.defaultThinkingLevel;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  assert.equal(fx.store.state().mainSettingsThinking, null);
  assert.match(P.render(fx.store.state(), liveEdit()), /pf-c-amber"[^>]*>thinking-mismatch · settings: none \/ sidecar: max/);
});

test('effective Sisyphus matching memory wins over main, stale memory yields to main, and a real pin wins over main', (t) => {
  const models = [
    { provider: 'kimi-coding', modelId: 'k3' },
    { provider: 'opencode-go', modelId: 'explicit-non-muse' },
  ];
  const fx = makeFixture(t, { registry: { getAvailable: () => models } });
  const agents = path.join(fx.stable, 'agent', 'primary-agents');
  fs.mkdirSync(path.join(agents, 'memory'), { recursive: true });
  const memoryFile = path.join(agents, 'memory', 'sisyphus.json');
  const memory = {
    v: 1, agentId: 'sisyphus', model: { provider: 'opencode-go', modelId: 'explicit-non-muse' },
    thinking: 'high', rosterRev: 0, updatedAt: '2026-10-20T12:00:00Z',
  };
  fs.writeFileSync(memoryFile, JSON.stringify(memory));
  assert.deepEqual(fx.store.state().roster.agents.sisyphus.effective, {
    ...memory.model, thinking: 'high', origin: 'memory', reason: null,
  });
  fs.writeFileSync(memoryFile, JSON.stringify({ ...memory, rosterRev: 9 }));
  assert.deepEqual(fx.store.state().roster.agents.sisyphus.effective, {
    provider: 'kimi-coding', modelId: 'k3', thinking: 'max', origin: 'main', reason: null,
  });
  const roster = defaultRoster(new Date('2026-10-20T12:00:00Z'));
  roster.agents.sisyphus.pin = { ...memory.model, thinking: 'low' };
  fs.writeFileSync(path.join(agents, 'roster.json'), JSON.stringify(roster));
  assert.deepEqual(fx.store.state().roster.agents.sisyphus.effective, {
    ...memory.model, thinking: 'low', origin: 'pin', reason: null,
  });
});

test('effective lane guard allows Muse and other providers while excluding other opencode-go models', (t) => {
  const models = [
    { provider: 'opencode-go', id: 'blocked-model' },
    { provider: 'opencode-go', id: 'muse-fixture' },
    { provider: 'openai', id: 'gpt-fixture' },
  ];
  const fx = makeFixture(t, { registry: { getAvailable: () => models } });
  const config = {
    model_profiles: {
      'daily-normal': { models: [
        { model: 'blocked-model', providers: ['opencode-go'] },
        { model: 'muse-fixture', providers: ['opencode-go'], variant: 'medium' },
      ] },
      'daily-heavy': { models: [
        { model: 'blocked-model', providers: ['opencode-go'] },
        { model: 'gpt-fixture', providers: ['openai'], thinking: 'high' },
      ] },
      'geeky-normal': { models: [
        { model: 'muse-fixture', providers: ['opencode-go'] },
        { model: 'gpt-fixture', providers: ['openai'], thinking: 'low' },
      ] },
    },
  };
  fs.writeFileSync(path.join(fx.stable, 'omo.jsonc'), JSON.stringify(config));
  const state = fx.store.state();
  assert.deepEqual(state.roster.agents.sisyphus.effective, {
    provider: 'opencode-go', modelId: 'muse-fixture', thinking: 'medium', origin: 'lane', reason: null,
  });
  assert.deepEqual(state.roster.agents.prometheus.effective, {
    provider: 'openai', modelId: 'gpt-fixture', thinking: 'high', origin: 'lane', reason: null,
  });
  assert.deepEqual(state.roster.agents.hephaestus.effective, {
    provider: 'openai', modelId: 'gpt-fixture', thinking: 'low', origin: 'lane', reason: null,
  });
});

test('effective origin is unknown without a host registry, even when the picker has models', (t) => {
  const fx = makeFixture(t, { registryModels: [{ provider: 'kimi-coding', id: 'k3' }] });
  for (const agent of Object.values(fx.store.state().roster.agents)) {
    assert.deepEqual(agent.effective, {
      provider: null, modelId: null, thinking: null, origin: 'unknown', reason: 'no-registry',
    });
  }
});

test('effective unknown providers are unavailable and an unreadable roster is unknown without crashing', (t) => {
  const fx = makeFixture(t, { registry: { getAvailable: () => [] } });
  const settingsFile = path.join(fx.primary, 'agent', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({
    ...settings, defaultProvider: 'unknown-provider', defaultModel: 'unknown-model',
  }));
  assert.deepEqual(fx.store.state().roster.agents.sisyphus.effective, {
    provider: null, modelId: null, thinking: null, origin: 'unavailable', reason: 'not-found',
  });
  const unavailable = /data-pf-agent="sisyphus"[\s\S]*?<\/button>/.exec(loadView().render(fx.store.state(), liveEdit()))[0];
  assert.match(unavailable, />Unavailable</);
  assert.match(unavailable, /pf-row-sum-m">not-found/);
  assert.match(unavailable, />not-found</);
  const deniedFs = new Proxy(fs, {
    get(target, key) {
      if (key !== 'readFileSync') return target[key];
      return (file, ...args) => {
        if (String(file).endsWith('roster.json')) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
        return target.readFileSync(file, ...args);
      };
    },
  });
  const denied = makeFixture(t, { registry: { getAvailable: () => [] }, fs: deniedFs });
  for (const agent of Object.values(denied.store.state().roster.agents)) {
    assert.deepEqual(agent.effective, {
      provider: null, modelId: null, thinking: null, origin: 'unknown', reason: 'ROSTER_UNREADABLE',
    });
  }
});

test('real state(): a 5.1.44-absent role is read-only, labelled and keeps its config', (t) => {
  const fx = makeFixture(t);
  const state = fx.store.state();
  const fast = rowOf(state, 'categories', 'fast-explore');
  assert.ok(fast, 'fast-explore row stays visible');
  assert.equal(fast.readOnly, true);
  assert.equal(fast.absentIn, REAL_INVENTORY.version);
  assert.equal(fast.stateLabel, `${REAL_INVENTORY.version}에 없음`);
  assert.equal(rowOf(state, 'agents', 'explore').readOnly, false, 'live role stays editable');
  assert.equal(rowOf(state, 'agents', 'explore').stateLabel, null);

  const html = loadView().render(state, liveEdit());
  assert.ok(textOf(html).includes(`absent: ${REAL_INVENTORY.version}`));
  assert.match(html, /data-pf-route="categories\/fast-explore"/);
  assert.doesNotMatch(html, /data-route="categories\/fast-explore"/, 'an absent role renders no edit controls');
});

test('real state(): the declared oracle and a file-defined ouroboros render service, model and effort controls', (t) => {
  const fx = makeFixture(t);
  fs.mkdirSync(path.join(fx.primary, 'agent', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(fx.primary, 'agent', 'agents', 'ouroboros.md'), '---\ndescription: fixture\n---\n');
  const state = fx.store.state();
  const oracle = rowOf(state, 'agents', 'oracle');
  assert.equal(oracle.readOnly, false);
  assert.equal(oracle.absentIn, null);
  assert.equal(oracle.model, 'sol', 'the configured alias is kept');
  assert.deepEqual(oracle.config, state.routing.layer.agents.oracle, 'the layer config is preserved');
  assert.equal(rowOf(state, 'agents', 'ouroboros').readOnly, false);

  const html = loadView().render(state, liveEdit());
  for (const role of ['oracle', 'ouroboros']) {
    for (const part of ['provider', 'model', 'thinking']) {
      assert.match(html, new RegExp(`data-pf="route-${part}" id="pf-route-agents-${role}-${part}"`), `${role} ${part}`);
    }
  }
});

test('real state(): each Oracle advisor offers only its own family and shows its saved pin', (t) => {
  const fx = makeFixture(t);
  const file = path.join(fx.primary, 'agent', 'oracle-advisor', 'routing.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    profiles: {
      claude: { model: 'anthropic-subscription/claude-opus-5-5:max', family: 'claude' },
      gpt: { model: 'chatgpt-subscription/gpt-6-astra:high', family: 'gpt' },
    },
    by_family: { claude: { work: 'gpt', completion: 'gpt' }, gpt: { work: 'claude', completion: 'claude' }, other: { work: 'claude', completion: 'gpt' } },
    by_agent: {}, by_nature: { design: 'claude', lowlevel: 'gpt' },
  }));
  const state = fx.store.state();
  assert.deepEqual(state.advisors.rows.map((row) => [row.name, row.family, row.model, row.thinking]), [
    ['claude', 'claude', 'anthropic-subscription/claude-opus-5-5', 'max'],
    ['gpt', 'gpt', 'chatgpt-subscription/gpt-6-astra', 'high'],
  ]);
  const html = loadView().render(state, liveEdit());
  const box = (name) => new RegExp(`data-pf-advisor="${name}"[\\s\\S]*?</select></label></div></div>`).exec(html)[0];
  const claudeModels = [...box('claude').matchAll(/data-pf="advisor-model"[\s\S]*?<\/select>/g)][0][0];
  const gptModels = [...box('gpt').matchAll(/data-pf="advisor-model"[\s\S]*?<\/select>/g)][0][0];
  assert.match(claudeModels, /value="anthropic-subscription\/claude-opus-5-5"[^>]* selected/);
  assert.doesNotMatch(claudeModels, /gpt-/, 'the Claude advisor lists no GPT model');
  assert.match(gptModels, /value="chatgpt-subscription\/gpt-6-astra"[^>]* selected/);
  assert.doesNotMatch(gptModels, /claude/, 'the GPT advisor lists no Claude model');
  assert.match(box('claude'), /data-pf="advisor-thinking"[\s\S]*?value="max" selected/);
});

test('real state(): the guide pins both 5.1.44 sources and rows carry real recommendation statuses', (t) => {
  const fx = makeFixture(t);
  const state = fx.store.state();
  assert.ok(state.guide, 'guide is not null');
  assert.equal(state.guide.version, REAL_INVENTORY.version);
  assert.deepEqual(state.guide.sources, [
    { path: fx.inventory.sources.omo.path, sha256: fx.inventory.sources.omo.sha256 },
    { path: fx.inventory.sources.omoTask.path, sha256: fx.inventory.sources.omoTask.sha256 },
  ]);
  assert.equal(state.guide.sources.length, 2);
  assert.equal(JSON.stringify(state.guide).includes('5.1.33'), false, 'the stale 5.1.33 source URL never reaches the guide');

  const explore = rowOf(state, 'agents', 'explore');
  const librarian = rowOf(state, 'agents', 'librarian');
  assert.equal(explore.recommendation.Status, 'recommended');
  assert.equal(explore.recommendation.Tier, 'recommended');
  assert.equal(librarian.recommendation.Status, 'different');
  assert.ok(state.routing.recommendation.TrackedCount >= 2);
  assert.notEqual(state.routing.recommendation.Summary, 'none');

  const html = loadView().render(state, liveEdit());
  assert.ok(html.includes('omo-task.js'), 'the guide renders the task bundle path');
  assert.ok(html.includes(fx.inventory.sources.omo.path), 'the guide renders the omo.js path');
  assert.ok(html.includes(fx.inventory.sources.omo.sha256), 'the guide renders the omo.js pin');
  assert.ok(html.includes(fx.inventory.sources.omoTask.sha256), 'the guide renders the task bundle pin');
  assert.match(html, /pf-st-recommended/);
  assert.match(html, /pf-st-different/);
});

test('real state(): registry-only ChatGPT models reach the rendered picker, missing registry falls back to the catalog', (t) => {
  const withRegistry = makeFixture(t, {
    registryModels: [
      { provider: 'chatgpt-subscription', id: 'gpt-7-nova' },
      { provider: 'chatgpt-subscription', modelId: 'chatgpt-subscription/gpt-6.1-sol' },
      { provider: 'openai', id: 'gpt-7-sol-openai' },
    ],
  });
  const state = withRegistry.store.state();
  // A registry-only model gets the support verdict its write gets: the installed engine serves gpt-6.1-sol in the
  // fixture homes, not gpt-7-nova (registry.mjs supportStatusFor).
  assert.deepEqual(state.registryModels, [
    {
      provider: 'chatgpt-subscription', model: 'chatgpt-subscription/gpt-7-nova',
      unsupported: true, unsupportedReason: 'UNSUPPORTED_MODEL', unsupportedHome: 'primary',
    },
    { provider: 'chatgpt-subscription', model: 'chatgpt-subscription/gpt-6.1-sol' },
  ]);
  const html = loadView().render(state, liveEdit());
  assert.ok(html.includes('chatgpt-subscription/gpt-7-nova'), 'registry-only model is a rendered option');
  assert.doesNotMatch(html, /gpt-7-sol-openai/, 'models from another provider stay out of the ChatGPT list');

  const bare = makeFixture(t);
  const bareState = bare.store.state();
  assert.deepEqual(bareState.registryModels, []);
  const bareHtml = loadView().render(bareState, liveEdit());
  assert.doesNotMatch(bareHtml, /gpt-7-nova/);
  assert.match(bareHtml, /opencode-go\/deepseek-v4-flash/, 'the config catalog still feeds every picker');
});

test('real state(): a valid extension memory file is projected read-only and rendered', (t) => {
  const fx = makeFixture(t);
  const memoryDir = path.join(fx.stable, 'agent', 'primary-agents', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const memoryPath = path.join(memoryDir, 'hephaestus.json');
  const memory = {
    v: 1,
    agentId: 'hephaestus',
    model: { provider: 'chatgpt-subscription', modelId: 'gpt-6.1-sol-memory' },
    thinking: 'high',
    rosterRev: 0,
    updatedAt: '2026-10-20T12:00:00.000Z',
  };
  fs.writeFileSync(memoryPath, JSON.stringify(memory));
  const before = fs.readFileSync(memoryPath);

  const state = fx.store.state();
  assert.deepEqual(state.roster.agents.hephaestus.remembered, {
    provider: 'chatgpt-subscription',
    modelId: 'gpt-6.1-sol-memory',
    thinking: 'high',
    rosterRev: 0,
    updatedAt: '2026-10-20T12:00:00.000Z',
  });
  const html = loadView().render(state, liveEdit());
  assert.match(textOf(html), /chatgpt-subscription · gpt-6\.1-sol-memory \/ high/);
  assert.deepEqual(fs.readFileSync(memoryPath), before, 'the board never writes extension memory');
});

test('real state(): invalid memory files are ignored with exactly one warning and never crash the state', (t) => {
  const fx = makeFixture(t);
  const memoryDir = path.join(fx.stable, 'agent', 'primary-agents', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const memoryPath = path.join(memoryDir, 'sisyphus.json');
  fs.writeFileSync(memoryPath, JSON.stringify({
    v: 1,
    agentId: 'sisyphus',
    model: { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5' },
    thinking: 'medium',
    rosterRev: 0,
    updatedAt: '2026-10-20T12:00:00.000Z',
    apiKey: 'SECRET-DO-NOT-PROJECT',
  }));

  const state = fx.store.state();
  assert.equal(state.roster.agents.sisyphus.remembered, undefined, 'the invalid file is ignored');
  const warnings = state.warnings.filter((warning) => String(warning).includes('sisyphus.json'));
  assert.equal(warnings.length, 1, 'exactly one warning for the invalid file');
  assert.ok(String(warnings[0]).includes('credential-like') || String(warnings[0]).includes('forbidden key'), 'the validator rejection is named');
  const html = loadView().render(state, liveEdit());
  assert.ok(html.includes('sisyphus.json'), 'the warning reaches the rendered page');
  assert.doesNotMatch(html, /SECRET-DO-NOT-PROJECT/);
});

test('real state(): a malformed memory JSON file is ignored with one warning and the other agents stay intact', (t) => {
  const fx = makeFixture(t);
  const memoryDir = path.join(fx.stable, 'agent', 'primary-agents', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'atlas.json'), '{not json');
  fs.writeFileSync(path.join(memoryDir, 'prometheus.json'), JSON.stringify({
    v: 1,
    agentId: 'prometheus',
    model: { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5' },
    thinking: 'high',
    rosterRev: 0,
    updatedAt: '2026-10-20T12:00:00.000Z',
  }));

  const state = fx.store.state();
  assert.equal(state.roster.agents.atlas.remembered, undefined);
  assert.equal(state.roster.agents.prometheus.remembered.modelId, 'claude-opus-5-5');
  const warnings = state.warnings.filter((warning) => String(warning).includes('atlas.json'));
  assert.equal(warnings.length, 1);
  const html = loadView().render(state, liveEdit());
  assert.match(textOf(html), /anthropic-subscription · claude-opus-5-5 \/ high/);
  assert.ok(html.includes('atlas.json'));
});
