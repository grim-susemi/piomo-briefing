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

test('real state(): a 5.1.44-absent role is read-only, labelled and keeps its config', (t) => {
  const fx = makeFixture(t);
  const state = fx.store.state();
  const oracle = rowOf(state, 'agents', 'oracle');
  assert.ok(oracle, 'oracle row stays visible');
  assert.equal(oracle.readOnly, true);
  assert.equal(oracle.absentIn, REAL_INVENTORY.version);
  assert.equal(oracle.stateLabel, `${REAL_INVENTORY.version}에 없음`);
  assert.equal(oracle.model, 'sol', 'the configured alias is kept');
  assert.deepEqual(oracle.config, state.routing.layer.agents.oracle, 'the layer config is preserved');
  assert.equal(rowOf(state, 'agents', 'explore').readOnly, false, 'live role stays editable');
  assert.equal(rowOf(state, 'agents', 'explore').stateLabel, null);

  const html = loadView().render(state, liveEdit());
  assert.ok(textOf(html).includes(`${REAL_INVENTORY.version}에 없음`));
  assert.match(html, /data-pf-route="agents\/oracle"/);
  assert.doesNotMatch(html, /data-route="agents\/oracle"/, 'an absent role renders no edit controls');
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
