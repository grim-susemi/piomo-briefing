// Profile store: compare-and-swap, allowlist, backups, formatting preservation,
// rollback and the apply journal. Every test runs against temporary homes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  atomicWriteText, detectStyle, formatJsonText, hasComments, openProfilesStore, redact,
} from '../src/profiles/store.mjs';
import { pinnedOmoPath } from './helpers/pinned-plugin.mjs';
import { defaultRoster } from '../src/profiles/contract/schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'fixtures', 'profiles', 'goldens', 'apply-gpt-kimi-deepseek', 'files');
const REAL_INVENTORY = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'profiles', 'inventory.json'), 'utf8'));
const PS_STYLE = { bom: true, eol: '\r\n', indent: '    ', keySep: ':  ', trailingNewline: true };
const LF_STYLE = { bom: false, eol: '\n', indent: '  ', keySep: ': ', trailingNewline: true };

const readGolden = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN, name), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hashFile = (file) => sha(fs.readFileSync(file));

function makeFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-p10-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary');
  const stable = path.join(root, 'stable');
  fs.mkdirSync(path.join(primary, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(stable, 'agent'), { recursive: true });

  const style = options.style ?? PS_STYLE;
  const omo = options.omo ?? readGolden('primary/omo.jsonc.json');
  const settings = options.settings ?? readGolden('primary/settings.json.json');
  if (options.mutateSettings) options.mutateSettings(settings);
  const stableOmo = options.stableOmo ?? readGolden('stable/omo.jsonc.json');

  fs.writeFileSync(path.join(primary, 'omo.jsonc'), options.rawOmo ?? formatJsonText(omo, style));
  fs.writeFileSync(path.join(primary, 'agent', 'settings.json'), formatJsonText(settings, style));
  fs.writeFileSync(path.join(primary, 'native-profile-selection.json'),
    JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'seed' }, null, 2));
  fs.writeFileSync(path.join(primary, 'agent', 'native-profile-selection.json'),
    JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'seed' }, null, 2));
  const regPrimary = path.join(here, 'fixtures', 'profiles', 'registry', 'primary', 'agent', 'models.json');
  const regStable = path.join(here, 'fixtures', 'profiles', 'registry', 'stable', 'agent', 'models.json');
  if (fs.existsSync(regPrimary)) fs.copyFileSync(regPrimary, path.join(primary, 'agent', 'models.json'));
  if (fs.existsSync(regStable)) fs.copyFileSync(regStable, path.join(stable, 'agent', 'models.json'));
  fs.writeFileSync(path.join(primary, 'auth.json'), '{"token":"SECRET-DO-NOT-TOUCH"}');
  if (options.mainOverride !== undefined) {
    fs.mkdirSync(path.join(primary, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(primary, 'runtime', 'native-profile-switcher-main.json'),
      JSON.stringify(options.mainOverride, null, 2));
  }
  const mirrorHomes = [...(options.mirrorHomes ?? [])];
  const mirrors = {};
  for (const name of options.mirrors ?? []) {
    const home = path.join(root, name, 'home', '.omo');
    fs.mkdirSync(path.join(home, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(home, 'omo.jsonc'), formatJsonText(omo, style));
    fs.writeFileSync(path.join(home, 'agent', 'settings.json'), formatJsonText(settings, style));
    if (fs.existsSync(regPrimary)) fs.copyFileSync(regPrimary, path.join(home, 'agent', 'models.json'));
    if (options.mirrorMain !== undefined) {
      fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
      fs.writeFileSync(path.join(home, 'runtime', 'native-profile-switcher-main.json'),
        JSON.stringify(options.mirrorMain, null, 2));
    }
    mirrorHomes.push(home);
    mirrors[name] = home;
  }
  fs.writeFileSync(path.join(stable, 'omo.jsonc'), formatJsonText(stableOmo, style));
  fs.writeFileSync(path.join(stable, 'agent', 'settings.json'), '{"packages":["stable-package"],"defaultProvider":"stable"}');

  const plugin = path.join(root, 'omo.js');
  fs.writeFileSync(plugin, options.pluginBody ?? 'plugin-body');
  const inventory = options.inventory ?? {
    ...REAL_INVENTORY,
    sources: { ...REAL_INVENTORY.sources, omo: { ...REAL_INVENTORY.sources.omo, sha256: sha(Buffer.from(options.pluginBody ?? 'plugin-body')) } },
  };
  const store = openProfilesStore({
    primaryHome: primary,
    stableHome: stable,
    mirrorHomes,
    pluginPath: plugin,
    inventory,
    hooks: options.hooks,
    fs: options.fs,
    registry: options.registry,
    recommendationManifest: options.recommendationManifest ?? null,
    ...(options.recommendationManifestPath ? { recommendationManifestPath: options.recommendationManifestPath } : {}),
    now: options.now ?? (() => Date.parse('2026-10-20T12:00:00Z')),
  });
  return { root, primary, stable, store, settings, style, plugin, mirrors, mirrorHomes, inventory };
}

test('selected gate current, untracked recommendation and inactive link coexist without inventing a description', (t) => {
  const omo = readGolden('primary/omo.jsonc.json');
  const profileKey = 'native-gpt-kimi-deepseek';
  omo.profiles[profileKey]['[native]'].agents['omo-native-gate-reviewer'] = { model: 'sol-61-high' };
  const fx = makeFixture(t, { omo });
  const state = fx.store.state();
  const row = state.routing.rows.find((row) => row.role === 'omo-native-gate-reviewer');
  assert.deepEqual(row.current, {
    sourceFile: path.join(fx.primary, 'omo.jsonc'),
    sourcePath: '$.profiles["native-gpt-kimi-deepseek"]["[native]"].agents["omo-native-gate-reviewer"].model',
    alias: 'sol-61-high', modelId: 'chatgpt-subscription/gpt-6.1-sol', thinking: 'high',
    effective: true, unresolved: false, reason: null,
  });
  assert.equal(row.recommended.status, 'untracked');
  assert.equal(row.recommended.HasRecommendation, false);
  assert.equal(row.recommended.provenance.available, false);
  assert.equal(row.linked.active, false);
  assert.equal(row.linked.reason, 'explicit-alias');
  assert.deepEqual(row.linked.candidates, ['deep-high', 'unspecified-high']);
  assert.equal(row.linked.EffectiveCategory, '');
  assert.equal(Object.hasOwn(row.current, 'description'), false);
  const detail = state.details['gpt-kimi-deepseek'].routing.rows.find((row) => row.role === 'omo-native-gate-reviewer');
  assert.deepEqual(detail.current, row.current);
  assert.deepEqual(detail.recommended, row.recommended);
  assert.deepEqual(detail.linked, row.linked);
});

test('alias-less gate uses registered deep-high but never treats an unregistered category as effective', (t) => {
  for (const category of [undefined, { model: 'not-registered' }, { model: 'empty' }, { model: 'numeric' }, { model: 'sol-61-high' }]) {
    const omo = readGolden('primary/omo.jsonc.json');
    const layer = omo.profiles['native-gpt-kimi-deepseek']['[native]'];
    delete layer.agents['omo-native-gate-reviewer'];
    delete layer.categories['unspecified-high'];
    if (category) layer.categories['deep-high'] = category;
    else delete layer.categories['deep-high'];
    omo['[native]'].models.empty = { model: '   ' };
    omo['[native]'].models.numeric = { model: 7 };
    const fx = makeFixture(t, { omo });
    const row = fx.store.state().routing.rows.find((row) => row.role === 'omo-native-gate-reviewer');
    const registered = category?.model === 'sol-61-high';
    assert.equal(row.current.alias, '');
    assert.equal(row.current.effective, false);
    assert.equal(row.linked.active, true);
    assert.equal(row.linked.effective, registered);
    assert.equal(row.linked.EffectiveCategory, registered ? 'deep-high' : '');
    assert.equal(row.linked.EffectiveAlias, registered ? 'sol-61-high' : '');
    assert.equal(row.linked.reason, registered ? null : 'no-registered-category-model');
  }
});

test('an unresolved explicit alias stays unresolved even with a registered linked category', (t) => {
  const omo = readGolden('primary/omo.jsonc.json');
  const layer = omo.profiles['native-gpt-kimi-deepseek']['[native]'];
  layer.agents['omo-native-gate-reviewer'] = { model: 'unknown-explicit' };
  layer.categories['deep-high'] = { model: 'sol-61-high' };
  const row = makeFixture(t, { omo }).store.state().routing.rows.find((row) => row.role === 'omo-native-gate-reviewer');
  assert.equal(row.current.alias, 'unknown-explicit');
  assert.equal(row.current.modelId, '');
  assert.equal(row.current.effective, false);
  assert.equal(row.current.unresolved, true);
  assert.match(row.current.reason, /unresolved-alias: unknown-explicit/);
  assert.equal(row.recommended.status, 'unresolved');
  assert.equal(row.linked.active, false);
  assert.equal(row.linked.effective, false);
  assert.equal(row.linked.EffectiveCategory, '');
});

test('guide base set has 27 unique ids and summary; inventory and layer extras append once by id', (t) => {
  const fx = makeFixture(t);
  const base = fx.store.state().guide.rows;
  assert.equal(base.length, 27);
  assert.equal(new Set(base.map((row) => row.id)).size, base.length);
  assert.deepEqual(Object.fromEntries(['primary', 'routing', 'memory', 'summary']
    .map((group) => [group, base.filter((row) => row.group === group).length])),
  { primary: 4, routing: 20, memory: 2, summary: 1 });
  assert.equal(base.at(-1).id, 'summary');
  assert.ok(base.every((row) => row.applyScope && row.current && row.recommended && row.linked));
  const omo = readGolden('primary/omo.jsonc.json');
  const layer = omo.profiles['native-gpt-kimi-deepseek']['[native]'];
  layer.agents.extra = { model: 'sol' };
  layer.categories.extra = { model: 'flash' };
  const inventory = { ...REAL_INVENTORY, agents: [...REAL_INVENTORY.agents, 'extra', 'new-agent', 'new-agent'] };
  const extra = makeFixture(t, { omo, inventory }).store.state().guide.rows;
  assert.deepEqual(extra.slice(0, base.length).map((row) => row.id), base.map((row) => row.id));
  assert.deepEqual(extra.slice(base.length).map((row) => row.id), ['agents/extra', 'categories/extra', 'agents/new-agent']);
  assert.equal(new Set(extra.map((row) => row.id)).size, extra.length);
});

test('a missing summary keeps an explained guide row and previews preserve current bytes', (t) => {
  const fx = makeFixture(t, { mutateSettings(settings) {
    delete settings.compaction;
    delete settings.compactionSummarizer;
  } });
  const before = fx.store.state();
  const summary = before.guide.rows.find((row) => row.id === 'summary');
  assert.equal(summary.current.modelId, '');
  assert.equal(summary.current.reason, 'no-summary-model');
  assert.equal(summary.current.effective, false);
  const result = fx.store.preview(body('preview', [{ kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' }], fx.store));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(fx.store.state().targets, before.targets);
  assert.equal(fx.store.journal(), null);
});

test('model descriptions pass through only when present in the source catalog', (t) => {
  const omo = readGolden('primary/omo.jsonc.json');
  omo['[native]'].models['sol-61-high'].description = 'Source description, unchanged.';
  const layer = omo.profiles['native-gpt-kimi-deepseek']['[native]'];
  layer.agents['omo-native-code-reviewer'] = { model: 'sol-61-high' };
  layer.categories['deep-high'] = { model: 'sol-61-high' };
  const rows = makeFixture(t, { omo }).store.state().routing.rows;
  assert.equal(rows.find((row) => row.role === 'omo-native-code-reviewer').current.description, 'Source description, unchanged.');
  assert.equal(rows.find((row) => row.role === 'omo-native-gate-reviewer').linked.description, 'Source description, unchanged.');
  assert.equal(Object.hasOwn(rows.find((row) => row.role === 'explore').current, 'description'), false);
});

function expectedOf(store) {
  return store.state().targets;
}

function body(action, changes, store, expected = expectedOf(store), rosterRevision = store.state().roster.revision) {
  return { action, changes, expected, rosterRevision };
}

function seedLegacyRoster(fx, rev = 0) {
  const roster = defaultRoster(new Date('2026-10-20T12:00:00Z'));
  roster.revision = 7;
  roster.agents.sisyphus = {
    ...roster.agents.sisyphus, rev,
    pin: { provider: 'legacy', modelId: 'legacy-model', thinking: 'low' },
  };
  roster.agents.atlas.rev = 9;
  const file = path.join(fx.stable, 'agent', 'primary-agents', 'roster.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(roster));
  return { file, roster };
}

test('main apply replaces matching Sisyphus memory with main without changing memory bytes', (t) => {
  const models = [
    { provider: 'anthropic', id: 'remembered-model' },
    { provider: 'openai', id: 'gpt-6-sol' },
  ];
  const fx = makeFixture(t, { registry: { getAvailable: () => models } });
  const { file, roster } = seedLegacyRoster(fx, 4);
  const memoryFile = path.join(fx.stable, 'agent', 'primary-agents', 'memory', 'sisyphus.json');
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(memoryFile, JSON.stringify({
    v: 1, agentId: 'sisyphus', model: { provider: 'anthropic', modelId: 'remembered-model' },
    thinking: 'high', rosterRev: roster.agents.sisyphus.rev, updatedAt: '2026-10-20T12:00:00Z',
  }, null, 2));
  const memoryBefore = fs.readFileSync(memoryFile);
  assert.deepEqual(fx.store.state().roster.agents.sisyphus.effective, {
    provider: 'anthropic', modelId: 'remembered-model', thinking: 'high', origin: 'memory', reason: null,
  });

  const result = fx.store.apply(body('apply', [
    { kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
  ], fx.store));
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = fx.store.state().roster.agents.sisyphus;
  assert.deepEqual(after.effective, {
    provider: 'openai', modelId: 'gpt-6-sol', thinking: fx.settings.defaultThinkingLevel, origin: 'main', reason: null,
  });
  assert.equal(after.pin, null);
  assert.equal(after.rev, 5);
  assert.equal(readJsonFile(file).revision, roster.revision + 1);
  assert.deepEqual(fs.readFileSync(memoryFile), memoryBefore);
});

test('final settings difference alone clears the Sisyphus pin and bumps its revision once', (t) => {
  const fx = makeFixture(t);
  const { file, roster } = seedLegacyRoster(fx, 4);
  const settingsFile = path.join(fx.primary, 'agent', 'settings.json');
  const settingsBefore = readJsonFile(settingsFile);
  const changes = [
    { kind: 'setAgentPin', agentId: 'hephaestus', pin: { provider: 'openai', modelId: 'gpt-6-sol', thinking: 'high' } },
    { kind: 'setAgentLane', agentId: 'hephaestus', lane: 'geeky-heavy' },
  ];
  const request = body('apply', changes, fx.store);
  assert.equal(changes.some((change) => change.kind === 'setMain' || change.kind === 'selectProfile'), false);

  // Only explicit main changes currently alter these fields. Inject a prepared
  // settings difference at the clone boundary to exercise the defensive branch
  // without introducing another public change kind or changing store code.
  const clone = globalThis.structuredClone;
  let injectSettings = true;
  const cloneMock = t.mock.method(globalThis, 'structuredClone', (value, ...args) => {
    const next = clone(value, ...args);
    if (injectSettings && value?.defaultProvider === settingsBefore.defaultProvider
      && value?.defaultModel === settingsBefore.defaultModel) {
      injectSettings = false;
      next.defaultProvider = 'openai';
      next.defaultModel = 'gpt-6-sol';
    }
    return next;
  });
  let result;
  try {
    result = fx.store.apply(request);
  } finally {
    cloneMock.mock.restore();
  }

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(readJsonFile(settingsFile), {
    ...settingsBefore, defaultProvider: 'openai', defaultModel: 'gpt-6-sol',
  });
  const after = readJsonFile(file);
  assert.equal(after.agents.sisyphus.pin, null);
  assert.equal(after.agents.sisyphus.rev, roster.agents.sisyphus.rev + 1);
  assert.equal(after.revision, roster.revision + 1);
  assert.equal(after.agents.hephaestus.rev, 2);
  assert.deepEqual(after.agents.atlas, roster.agents.atlas);
});

test('equal final settings with only another role changed leave Sisyphus untouched', (t) => {
  const fx = makeFixture(t);
  const { file, roster } = seedLegacyRoster(fx, 4);
  const settingsFile = path.join(fx.primary, 'agent', 'settings.json');
  const settingsBefore = fs.readFileSync(settingsFile);
  const result = fx.store.apply(body('apply', [
    { kind: 'setAgentPin', agentId: 'hephaestus', pin: { provider: 'openai', modelId: 'gpt-6-sol', thinking: 'high' } },
    { kind: 'setAgentLane', agentId: 'hephaestus', lane: 'geeky-heavy' },
  ], fx.store));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(settingsFile), settingsBefore);
  const after = readJsonFile(file);
  assert.deepEqual(after.agents.sisyphus, roster.agents.sisyphus);
  assert.equal(after.agents.hephaestus.rev, 2);
  assert.equal(after.agents.hephaestus.lane, 'geeky-heavy');
  assert.deepEqual(after.agents.hephaestus.pin, {
    provider: 'openai', modelId: 'gpt-6-sol', thinking: 'high',
  });
  assert.equal(after.revision, roster.revision + 1);
  assert.deepEqual(result.writes, ['agent/primary-agents/roster.json']);
});

test('setMain and selectProfile clear the legacy pin and invalidate memory in one roster CAS', (t) => {
  for (const change of [
    { kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
    { kind: 'selectProfile', profileKey: 'gpt-deepseek' },
  ]) {
    const fx = makeFixture(t);
    const { file, roster } = seedLegacyRoster(fx);
    const request = body('apply', [change], fx.store);
    const before = fx.store.state().targets;
    const preview = fx.store.preview({ ...request, action: 'preview' });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.match(preview.warnings.join('\n'), /clears the Sisyphus pin.*resets its memory revision/);
    assert.match(preview.warnings.join('\n'), /next start uses the applied main/);
    assert.deepEqual(fx.store.state().targets, before, 'preview performs zero writes');
    assert.equal(fx.store.journal(), null);
    const result = fx.store.apply(request);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.writes.filter((id) => id === 'agent/primary-agents/roster.json').length, 1);
    const after = readJsonFile(file);
    assert.equal(after.revision, roster.revision + 1, 'one CAS advances the roster once');
    assert.equal(after.agents.sisyphus.pin, null);
    assert.equal(after.agents.sisyphus.rev, 1);
    assert.deepEqual(after.agents.atlas, roster.agents.atlas);
  }
});

test('identical main re-apply still clears the pin and advances the memory revision once', (t) => {
  const fx = makeFixture(t, { mutateSettings(settings) {
    settings.defaultProvider = 'openai';
    settings.defaultModel = 'gpt-6-sol';
  } });
  const { file } = seedLegacyRoster(fx, 4);
  const settingsFile = path.join(fx.primary, 'agent', 'settings.json');
  const settingsBefore = fs.readFileSync(settingsFile);
  const result = fx.store.apply(body('apply', [
    { kind: 'resetAgentMemory', agentId: 'sisyphus' },
    { kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
    { kind: 'resetAgentMemory', agentId: 'sisyphus' },
    { kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
  ], fx.store));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(settingsFile), settingsBefore);
  assert.equal(readJsonFile(file).agents.sisyphus.pin, null);
  assert.equal(readJsonFile(file).agents.sisyphus.rev, 5, 'duplicate resets invalidate one revision, never revive revision 1');
  assert.equal(readJsonFile(file).revision, 8);
});

test('a batch without main apply leaves every unedited role revision and pin untouched', (t) => {
  const fx = makeFixture(t);
  const { file, roster } = seedLegacyRoster(fx, 4);
  const result = fx.store.apply(body('apply', [
    { kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' },
    { kind: 'setAgentPin', agentId: 'hephaestus', pin: { provider: 'openai', modelId: 'gpt-6-sol', thinking: 'high' } },
  ], fx.store));
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = readJsonFile(file);
  assert.deepEqual(after.agents.sisyphus, roster.agents.sisyphus);
  assert.deepEqual(after.agents.atlas, roster.agents.atlas);
  assert.equal(after.agents.hephaestus.rev, 1);
  assert.equal(after.revision, 8);
});

test('a concurrent roster or config edit after state makes main apply STALE with zero writes', (t) => {
  for (const target of ['roster', 'omo.jsonc']) {
    const fx = makeFixture(t);
    const { file } = seedLegacyRoster(fx);
    const request = body('apply', [
      { kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
    ], fx.store);
    if (target === 'roster') {
      const concurrent = readJsonFile(file);
      concurrent.revision += 1;
      fs.writeFileSync(file, JSON.stringify(concurrent));
    } else {
      fs.appendFileSync(path.join(fx.primary, 'omo.jsonc'), '\n');
    }
    const beforeApply = fx.store.state().targets;
    const result = fx.store.apply(request);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STALE');
    assert.deepEqual(fx.store.state().targets, beforeApply, 'zero target bytes written after the concurrent change');
    assert.equal(fx.store.journal(), null, 'STALE creates no journal');
    assert.equal(fs.existsSync(fx.store.backupDir), false, 'STALE creates no backups');
  }
});

test('late roster CAS conflict is STALE 409 before any target write or transaction artifact', (t) => {
  const writes = [];
  let rosterFile;
  let concurrentBytes;
  const fx = makeFixture(t, {
    fs: {
      ...fs,
      renameSync(from, to) {
        writes.push(to);
        return fs.renameSync(from, to);
      },
    },
    hooks: {
      beforeWrite(id) {
        if (id !== 'agent/primary-agents/roster.json') return;
        const concurrent = readJsonFile(rosterFile);
        concurrent.revision += 1;
        concurrentBytes = Buffer.from(JSON.stringify(concurrent));
        fs.writeFileSync(rosterFile, concurrentBytes);
      },
    },
  });
  rosterFile = seedLegacyRoster(fx).file;
  const files = () => Object.fromEntries(fs.readdirSync(fx.root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(fx.root, file), hashFile(file)];
    }));
  const before = files();
  const result = fx.store.apply(body('apply', [
    { kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
  ], fx.store));
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'STALE');
  assert.deepEqual(result.writes, []);
  assert.deepEqual(writes, [], 'no target, backup, or journal rename occurred');
  assert.deepEqual(files(), { ...before, [path.relative(fx.root, rosterFile)]: sha(concurrentBytes) },
    'only the external roster edit survives; the file set is unchanged');
  assert.equal(fx.store.journal(), null);
  assert.equal(fs.existsSync(fx.store.backupDir), false);
  assert.equal(fs.existsSync(path.join(path.dirname(rosterFile), 'backups')), false);
});

for (const point of ['before-first', 'between-targets', 'after-last']) {
  test(`durable apply interruption ${point} is reported and explicitly resumes without double revisions`, (t) => {
    const fx = makeFixture(t);
    const { file: rosterFile, roster } = seedLegacyRoster(fx, 4);
    const request = body('apply', [
      { kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
    ], fx.store);
    const intended = fx.store.preview({ ...request, action: 'preview' }).writes;
    assert.deepEqual(intended, ['agent/settings.json', 'runtime/native-profile-switcher-main.json', 'agent/primary-agents/roster.json']);
    const targetPaths = {
      'agent/settings.json': path.join(fx.primary, 'agent', 'settings.json'),
      'runtime/native-profile-switcher-main.json': path.join(fx.primary, 'runtime', 'native-profile-switcher-main.json'),
      'agent/primary-agents/roster.json': rosterFile,
    };
    const child = spawnSync(process.execPath, [path.join(here, 'helpers', 'profiles-apply-interrupt.mjs')], {
      input: JSON.stringify({
        point, request, targetPaths, journalPath: fx.store.journalPath,
        options: {
          primaryHome: fx.primary, stableHome: fx.stable, mirrorHomes: [],
          pluginPath: fx.plugin, inventory: fx.inventory, recommendationManifest: null,
        },
      }),
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 91, child.stdout + child.stderr);
    const stopped = JSON.parse(child.stdout);
    assert.equal(stopped.point, point);
    assert.equal(stopped.published.length, point === 'before-first' ? 0 : point === 'between-targets' ? 1 : 3);
    const raw = readJsonFile(fx.store.journalPath);
    assert.equal(raw.status, 'running');
    assert.deepEqual(raw.targets, intended);
    assert.deepEqual(raw.preHashes, request.expected);
    const left = fx.store.state().targets;
    const leftRoster = readJsonFile(rosterFile);
    assert.equal(leftRoster.revision, roster.revision + (point === 'before-first' ? 0 : 1));
    assert.equal(left['agent/settings.json'] !== request.expected['agent/settings.json'], point === 'after-last');
    const recoveredWrites = [];
    const reopened = openProfilesStore({
      primaryHome: fx.primary, stableHome: fx.stable, mirrorHomes: [],
      pluginPath: fx.plugin, inventory: fx.inventory, recommendationManifest: null,
      now: () => Date.parse('2026-10-20T12:00:00Z'),
      fs: {
        ...fs,
        renameSync(from, to) {
          if (Object.values(targetPaths).includes(to)) recoveredWrites.push(to);
          return fs.renameSync(from, to);
        },
      },
    });
    const journalHash = hashFile(reopened.journalPath);
    const state = reopened.state();
    assert.equal(state.applyJournal.status, 'interrupted');
    assert.equal(state.applyJournal.action, '다시 적용');
    assert.equal(Object.hasOwn(state.applyJournal, 'plan'), false, 'before-images are not exposed to the page');
    assert.deepEqual(reopened.state().targets, left, 'reporting the interruption never replays it');
    assert.equal(hashFile(reopened.journalPath), journalHash);
    const recovered = reopened.apply(body('apply', state.applyJournal.reapply.changes, reopened));
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.recoveredFrom, raw.id);
    assert.equal(reopened.journal().id, raw.id);
    assert.equal(reopened.journal().status, 'completed');
    const after = readJsonFile(rosterFile);
    assert.equal(after.revision, roster.revision + 1);
    assert.equal(after.agents.sisyphus.rev, roster.agents.sisyphus.rev + 1);
    assert.equal(after.agents.sisyphus.pin, null);
    assert.equal(readJsonFile(targetPaths['agent/settings.json']).defaultModel, 'gpt-6-sol');
    if (point === 'after-last') {
      assert.deepEqual(recovered.writes, []);
      assert.deepEqual(recoveredWrites, [], 'completion of fully published targets only completes the journal');
      assert.deepEqual(reopened.state().targets, left);
    }
    t.diagnostic(JSON.stringify({
      point, left: { journal: raw.status, published: stopped.published, rosterRevision: leftRoster.revision },
      recovery: { status: reopened.journal().status, writes: recovered.writes, rosterRevision: after.revision },
    }));
  });
}

test('a roster conflict after durable journal admission is STALE with no target writes or leftover artifacts', (t) => {
  let rosterFile;
  let journalFile;
  let bumped = false;
  const targetWrites = [];
  const fx = makeFixture(t, {
    fs: {
      ...fs,
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (to === journalFile && !bumped) {
          bumped = true;
          const concurrent = readJsonFile(rosterFile);
          concurrent.revision += 1;
          fs.writeFileSync(rosterFile, JSON.stringify(concurrent));
        } else if (to !== journalFile) targetWrites.push(to);
      },
    },
  });
  rosterFile = seedLegacyRoster(fx).file;
  journalFile = fx.store.journalPath;
  const result = fx.store.apply(body('apply', [
    { kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
  ], fx.store));
  assert.equal(result.code, 'STALE', JSON.stringify(result));
  assert.equal(result.status, 409);
  assert.deepEqual(result.writes, []);
  assert.deepEqual(targetWrites, []);
  assert.equal(fx.store.journal(), null);
  assert.equal(fs.existsSync(fx.store.backupDir), false);
  assert.equal(fs.existsSync(path.join(path.dirname(rosterFile), 'backups')), false);
});

test('preview returns path-level diffs and writes nothing', (t) => {
  const fx = makeFixture(t);
  const before = hashFile(path.join(fx.primary, 'agent', 'settings.json'));
  const beforeOmo = hashFile(path.join(fx.primary, 'omo.jsonc'));
  const result = fx.store.preview(body('preview', [{ kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' }], fx.store));
  assert.equal(result.ok, true);
  assert.deepEqual(result.writes, ['agent/settings.json']);
  assert.ok(result.diffs[0].changes.some((entry) => entry.path === '$.compaction.model'));
  assert.equal(hashFile(path.join(fx.primary, 'agent', 'settings.json')), before);
  assert.equal(hashFile(path.join(fx.primary, 'omo.jsonc')), beforeOmo);
  assert.equal(fx.store.journal(), null);
});

test('apply backs up before the write and changes only compaction.model', (t) => {
  const fx = makeFixture(t);
  const settingsPath = path.join(fx.primary, 'agent', 'settings.json');
  const original = fs.readFileSync(settingsPath);
  let observed = null;
  const store = openProfilesStore({
    primaryHome: fx.primary, stableHome: fx.stable, mirrorHomes: [], pluginPath: fx.plugin,
    inventory: { ...REAL_INVENTORY, sources: { ...REAL_INVENTORY.sources, omo: { ...REAL_INVENTORY.sources.omo, sha256: sha(Buffer.from('plugin-body')) } } },
    hooks: {
      beforeWrite(id, info) {
        if (id !== 'agent/settings.json') return;
        observed = { backup: info.backup, exists: info.backup ? fs.existsSync(info.backup) : false };
        assert.ok(info.backup);
        assert.deepEqual(fs.readFileSync(info.backup), original);
      },
    },
    now: () => Date.parse('2026-10-20T12:00:00Z'),
  });
  const result = store.apply(body('apply', [{ kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' }], store));
  assert.equal(result.ok, true);
  assert.deepEqual(observed, { backup: result.backups[0], exists: true });
  const after = readJsonFile(settingsPath);
  assert.equal(after.compaction.model, 'openai/gpt-6-sol');
  assert.equal(store.journal().status, 'completed');
});

test('a stale expected hash is a 409 and leaves every file byte-identical', (t) => {
  const fx = makeFixture(t);
  const before = Object.fromEntries(fx.store.targetIds().map((id) => [id, fx.store.state().targets[id]]));
  const expected = expectedOf(fx.store);
  expected['omo.jsonc'] = '0'.repeat(64);
  const result = fx.store.apply(body('apply', [{ kind: 'selectProfile', profileKey: 'gpt-deepseek' }], fx.store, expected));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
  assert.equal(result.status, 409);
  assert.deepEqual(fx.store.state().targets, before);
  assert.equal(fx.store.journal(), null);
});

test('a stale expected hash for an untouched target is a 409 for setMain too', (t) => {
  const fx = makeFixture(t);
  const before = Object.fromEntries(fx.store.targetIds().map((id) => [id, fx.store.state().targets[id]]));
  const authHash = hashFile(path.join(fx.primary, 'auth.json'));
  const expected = expectedOf(fx.store);
  expected['omo.jsonc'] = '0'.repeat(64);
  const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }], fx.store, expected));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
  assert.equal(result.status, 409);
  assert.deepEqual(fx.store.state().targets, before);
  assert.equal(hashFile(path.join(fx.primary, 'auth.json')), authHash);
  assert.equal(fx.store.journal(), null);
});

test('setMain refuses a stale expected hash for an untouched lane mirror target', (t) => {
  const fx = makeFixture(t, { mirrors: ['mirror1'] });
  const settings = path.join(fx.primary, 'agent', 'settings.json');
  const settingsBefore = fs.readFileSync(settings);
  const mirrorOmo = path.join(fx.mirrors.mirror1, 'omo.jsonc');
  const mirrorOmoBefore = fs.readFileSync(mirrorOmo);
  const expected = expectedOf(fx.store);
  expected['mirror/mirror1/omo.jsonc'] = '0'.repeat(64);
  const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }], fx.store, expected));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
  assert.equal(result.status, 409);
  assert.deepEqual(fs.readFileSync(settings), settingsBefore);
  assert.deepEqual(fs.readFileSync(mirrorOmo), mirrorOmoBefore);
  assert.equal(fs.existsSync(path.join(fx.primary, 'runtime', 'native-profile-switcher-main.json')), false);
  assert.equal(fs.existsSync(path.join(fx.mirrors.mirror1, 'runtime', 'native-profile-switcher-main.json')), false);
  assert.equal(fx.store.journal(), null);
});

test('setMain mirrors the main sidecar identically to every lane', (t) => {
  const seedMain = {
    'native-gpt-kimi-deepseek': { provider: 'legacy', model: 'legacy-model', thinking: 'low' },
    'native-experimental-custom': { provider: 'x', model: 'y', thinking: 'medium' },
  };
  const fx = makeFixture(t, { mirrors: ['mirror1', 'mirror2'], mainOverride: seedMain, mirrorMain: seedMain });
  const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }], fx.store));
  assert.equal(result.ok, true);
  const expectedMain = {
    ...seedMain,
    'native-gpt-kimi-deepseek': { provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
  };
  const primaryMain = path.join(fx.primary, 'runtime', 'native-profile-switcher-main.json');
  const primaryBytes = fs.readFileSync(primaryMain);
  assert.deepEqual(readJsonFile(primaryMain), expectedMain);
  for (const [name, home] of Object.entries(fx.mirrors)) {
    const mirrorMain = path.join(home, 'runtime', 'native-profile-switcher-main.json');
    assert.ok(fs.existsSync(mirrorMain), `${name} main sidecar missing`);
    assert.deepEqual(readJsonFile(mirrorMain), expectedMain);
    assert.deepEqual(fs.readFileSync(mirrorMain), primaryBytes, `${name} main sidecar differs from the primary`);
    assert.ok(result.writes.includes(`mirror/${name}/runtime/native-profile-switcher-main.json`));
  }
});

test('lane mirrors receive the CommandCode subscription registry when the primary has one', (t) => {
  const fx = makeFixture(t, { mirrors: ['mirror1'] });
  const subscriptions = {
    profileAssignments: { 'native-cmd-glm-deepseek': 'sub-1' },
    apiKey: 'SECRET-SUBSCRIPTION-KEY',
  };
  fs.writeFileSync(path.join(fx.primary, 'commandcode-subscriptions.json'),
    JSON.stringify(subscriptions, null, 2));
  const mirrorSubscriptions = path.join(fx.mirrors.mirror1, 'commandcode-subscriptions.json');
  const oldMirror = { profileAssignments: { 'native-gpt-kimi-deepseek': 'old' } };
  fs.writeFileSync(mirrorSubscriptions, JSON.stringify(oldMirror, null, 2));
  const result = fx.store.apply(body('apply', [
    { kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
  ], fx.store));
  assert.equal(result.ok, true);
  assert.deepEqual(readJsonFile(mirrorSubscriptions), subscriptions);
  assert.ok(result.writes.includes('mirror/mirror1/commandcode-subscriptions.json'));
  const backup = result.backups.find((file) => /mirror1-subscriptions-.*\.json$/.test(file));
  assert.ok(backup, JSON.stringify(result.backups));
  assert.deepEqual(readJsonFile(backup), oldMirror);
});

test('a rollback restores the lane main sidecars too', (t) => {
  const seedMain = {
    'native-gpt-kimi-deepseek': { provider: 'legacy', model: 'legacy-model', thinking: 'low' },
  };
  const fx = makeFixture(t, {
    mirrors: ['mirror1', 'mirror2'], mainOverride: seedMain, mirrorMain: seedMain,
    hooks: { reparse() { throw Object.assign(new Error('injected re-parse failure'), { code: 'INJECTED' }); } },
  });
  const primaryMain = path.join(fx.primary, 'runtime', 'native-profile-switcher-main.json');
  const primaryBefore = fs.readFileSync(primaryMain);
  const mirror1Main = path.join(fx.mirrors.mirror1, 'runtime', 'native-profile-switcher-main.json');
  const mirror1Before = fs.readFileSync(mirror1Main);
  // mirror2 starts without a sidecar: rollback must remove the file the apply created.
  const mirror2Main = path.join(fx.mirrors.mirror2, 'runtime', 'native-profile-switcher-main.json');
  fs.rmSync(mirror2Main);
  const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }], fx.store));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ROLLED_BACK');
  assert.equal(result.status, 500);
  assert.deepEqual(fs.readFileSync(primaryMain), primaryBefore);
  assert.deepEqual(fs.readFileSync(mirror1Main), mirror1Before);
  assert.equal(fs.existsSync(mirror2Main), false);
  assert.equal(fx.store.journal().status, 'rolled-back');
});

test('inventory: no pluginPath reports plugin_unknown, stale and read-only', (t) => {
  const fx = makeFixture(t);
  const store = openProfilesStore({
    primaryHome: fx.primary, stableHome: fx.stable, mirrorHomes: [], inventory: REAL_INVENTORY,
  });
  const inv = store.inventory();
  assert.equal(inv.stale, true);
  assert.equal(inv.reason, 'plugin_unknown');
  assert.equal(inv.readOnly, true);
  assert.equal(inv.path, null);
});

test('inventory: a plugin copy with one byte changed is stale, the pinned copy is not', (t) => {
  const fx = makeFixture(t);
  const copy = path.join(fx.root, 'omo-copy.js');
  fs.copyFileSync(pinnedOmoPath(), copy);
  const open = () => openProfilesStore({
    primaryHome: fx.primary, stableHome: fx.stable, mirrorHomes: [], pluginPath: copy, inventory: REAL_INVENTORY,
  });
  assert.equal(open().inventory().stale, false);
  const bytes = fs.readFileSync(copy);
  bytes[0] ^= 1;
  fs.writeFileSync(copy, bytes);
  const changed = open().inventory();
  assert.equal(changed.stale, true);
  assert.equal(changed.readOnly, true);
});

test('inventory: inventoryStatus returns the inventory version', (t) => {
  const fx = makeFixture(t);
  const store = openProfilesStore({
    primaryHome: fx.primary, stableHome: fx.stable, mirrorHomes: [], pluginPath: fx.plugin, inventory: REAL_INVENTORY,
  });
  assert.equal(store.inventory().version, REAL_INVENTORY.version);
});

test('the 5.1.44 key allowlist rejects an unknown root key without writing', (t) => {
  const fx = makeFixture(t);
  const config = readJsonFile(path.join(fx.primary, 'omo.jsonc'));
  config.bogusKey = true;
  fs.writeFileSync(path.join(fx.primary, 'omo.jsonc'), formatJsonText(config, fx.style));
  const before = hashFile(path.join(fx.primary, 'omo.jsonc'));
  const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol' }], fx.store));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ALLOWLIST');
  assert.equal(hashFile(path.join(fx.primary, 'omo.jsonc')), before);
});

test('the allowlist rejects an unknown agent-entry key and a forbidden primary-agent key', (t) => {
  for (const mutate of [
    (config) => { config['[native]'].agents.explore.bogusEntryKey = true; },
    (config) => { config['[native]'].agents.sisyphus = { model: 'x' }; },
  ]) {
    const fx = makeFixture(t);
    const config = readJsonFile(path.join(fx.primary, 'omo.jsonc'));
    mutate(config);
    fs.writeFileSync(path.join(fx.primary, 'omo.jsonc'), formatJsonText(config, fx.style));
    const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol' }], fx.store));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ALLOWLIST');
  }
});

test('a stale roster revision is a 409 and writes no roster', (t) => {
  const fx = makeFixture(t);
  const result = fx.store.apply(body('apply', [{ kind: 'setAgentLane', agentId: 'sisyphus', lane: 'daily-heavy' }], fx.store, expectedOf(fx.store), 99));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
  assert.equal(result.status, 409);
  assert.equal(fs.existsSync(path.join(fx.stable, 'agent', 'primary-agents', 'roster.json')), false);
  assert.equal(fx.store.journal(), null);
});

test('a non-GPT Hephaestus pin is rejected; a GPT pin and rev bumps are written', (t) => {
  const fx = makeFixture(t);
  const bad = fx.store.apply(body('apply', [{ kind: 'setAgentPin', agentId: 'hephaestus', pin: { provider: 'anthropic', modelId: 'claude-opus-5-5', thinking: 'high' } }], fx.store));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_PIN');
  assert.equal(fs.existsSync(path.join(fx.stable, 'agent', 'primary-agents', 'roster.json')), false);

  const good = fx.store.apply(body('apply', [{ kind: 'setAgentPin', agentId: 'hephaestus', pin: { provider: 'openai', modelId: 'gpt-6-sol', thinking: 'medium' } }], fx.store));
  assert.equal(good.ok, true);
  let roster = readJsonFile(path.join(fx.stable, 'agent', 'primary-agents', 'roster.json'));
  assert.equal(roster.revision, 1);
  assert.equal(roster.agents.hephaestus.rev, 1);
  assert.equal(roster.agents.hephaestus.pin.modelId, 'gpt-6-sol');

  const reset = fx.store.apply(body('apply', [{ kind: 'resetAgentMemory', agentId: 'hephaestus' }], fx.store));
  assert.equal(reset.ok, true);
  roster = readJsonFile(path.join(fx.stable, 'agent', 'primary-agents', 'roster.json'));
  assert.equal(roster.agents.hephaestus.rev, 2);

  const lane = fx.store.apply(body('apply', [{ kind: 'setAgentLane', agentId: 'atlas', lane: 'geeky-heavy' }], fx.store));
  assert.equal(lane.ok, true);
  roster = readJsonFile(path.join(fx.stable, 'agent', 'primary-agents', 'roster.json'));
  assert.equal(roster.agents.atlas.rev, 1);
  assert.equal(roster.agents.atlas.lane, 'geeky-heavy');
  assert.equal(roster.revision, 3);
});

test('setMain changes exactly defaultProvider/defaultModel and only the primary home', (t) => {
  const fx = makeFixture(t);
  const settingsPath = path.join(fx.primary, 'agent', 'settings.json');
  const before = readJsonFile(settingsPath);
  const stableSettingsHash = hashFile(path.join(fx.stable, 'agent', 'settings.json'));
  const stableOmoHash = hashFile(path.join(fx.stable, 'omo.jsonc'));
  const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }], fx.store));
  assert.equal(result.ok, true);
  const after = readJsonFile(settingsPath);
  const changed = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  assert.deepEqual(changed.sort(), ['defaultModel', 'defaultProvider']);
  assert.deepEqual(after.extensions, before.extensions);
  assert.deepEqual(after.packages, before.packages);
  assert.equal(after.defaultThinkingLevel, before.defaultThinkingLevel);
  assert.equal(hashFile(path.join(fx.stable, 'agent', 'settings.json')), stableSettingsHash);
  assert.equal(hashFile(path.join(fx.stable, 'omo.jsonc')), stableOmoHash);
  const sidecar = readJsonFile(path.join(fx.primary, 'runtime', 'native-profile-switcher-main.json'));
  assert.deepEqual(sidecar['native-gpt-kimi-deepseek'], { provider: 'openai', model: 'gpt-6-sol', thinking: 'high' });
});

test('CRLF/LF, BOM and the `:  ` separator survive a write; an unchanged round-trip is byte-identical', (t) => {
  for (const style of [PS_STYLE, LF_STYLE]) {
    const fx = makeFixture(t, { style });
    const file = path.join(fx.primary, 'agent', 'settings.json');
    const raw = fs.readFileSync(file);
    const text = raw.toString('utf8');
    assert.equal(formatJsonText(JSON.parse(text.replace(/^\uFEFF/, '')), detectStyle(text)), text);
    const result = fx.store.apply(body('apply', [{ kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' }], fx.store));
    assert.equal(result.ok, true);
    const rewritten = fs.readFileSync(file, 'utf8');
    assert.equal(rewritten.charCodeAt(0) === 0xfeff, style.bom);
    if (style.eol === '\r\n') assert.ok(rewritten.includes('\r\n'));
    else assert.ok(!rewritten.includes('\r\n'));
    if (style.keySep === ':  ') assert.ok(rewritten.includes('":  '));
    else assert.ok(rewritten.includes('": '));
  }
});

test('an unchanged target is never rewritten (byte-identical)', (t) => {
  const fx = makeFixture(t);
  const omo = path.join(fx.primary, 'omo.jsonc');
  const before = fs.readFileSync(omo);
  const result = fx.store.apply(body('apply', [{ kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' }], fx.store));
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readFileSync(omo), before);
});

test('an injected re-parse failure rolls back every written target byte-identically', (t) => {
  const fx = makeFixture(t, { hooks: { reparse() { throw Object.assign(new Error('injected re-parse failure'), { code: 'INJECTED' }); } } });
  const settings = path.join(fx.primary, 'agent', 'settings.json');
  const omo = path.join(fx.primary, 'omo.jsonc');
  const settingsBefore = fs.readFileSync(settings);
  const omoBefore = fs.readFileSync(omo);
  const result = fx.store.apply(body('apply', [{ kind: 'selectProfile', profileKey: 'gpt-deepseek' }], fx.store));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ROLLED_BACK');
  assert.equal(result.status, 500);
  assert.deepEqual(fs.readFileSync(settings), settingsBefore);
  assert.deepEqual(fs.readFileSync(omo), omoBefore);
  assert.equal(fx.store.journal().status, 'rolled-back');
  assert.ok(result.backups.length >= 2);
});

test('a stale inventory hash makes the state read-only and refuses apply', (t) => {
  const fx = makeFixture(t, { inventory: { ...REAL_INVENTORY, sources: { ...REAL_INVENTORY.sources, omo: { ...REAL_INVENTORY.sources.omo, sha256: '0'.repeat(64) } } } });
  const state = fx.store.state();
  assert.equal(state.readOnly, true);
  assert.equal(state.readOnlyReason, 'INVENTORY_STALE');
  assert.equal(state.banner, '인벤토리 갱신 필요');
  assert.equal(state.inventory.label, '인벤토리 갱신 필요');
  const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol' }], fx.store));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVENTORY_STALE');
  assert.equal(result.status, 409);
});

test('comments in omo.jsonc refuse writes with COMMENTS_PRESENT', (t) => {
  const fx = makeFixture(t);
  const file = path.join(fx.primary, 'omo.jsonc');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, `${text.slice(0, text.indexOf('\r\n'))}\r\n    // owner note\r\n${text.slice(text.indexOf('\r\n') + 2)}`);
  const before = fs.readFileSync(file);
  assert.equal(hasComments(before.toString('utf8')), true);
  const state = fx.store.state();
  assert.equal(state.readOnly, true);
  assert.equal(state.readOnlyReason, 'COMMENTS_PRESENT');
  const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol' }], fx.store));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COMMENTS_PRESENT');
  assert.deepEqual(fs.readFileSync(file), before);
});

test('an unfinished journal is shown as 중단된 적용 and is never replayed automatically', (t) => {
  const fx = makeFixture(t);
  const journalPath = path.join(fx.stable, 'agent', 'primary-agents', 'apply-journal.json');
  const interrupted = {
    v: 1, id: 'interrupted-run', action: 'apply', status: 'running',
    startedAt: '2026-10-20T11:00:00.000Z',
    steps: [{ step: 'write', target: 'agent/settings.json', status: 'ok' }],
  };
  atomicWriteText(journalPath, JSON.stringify(interrupted, null, 2));
  const view = fx.store.state().applyJournal;
  assert.equal(view.status, 'interrupted');
  assert.equal(view.label, '중단된 적용');
  assert.equal(view.action, '다시 적용');
  assert.equal(view.reapply, null, 'a journal without a recorded request offers no replay payload');
  const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol' }], fx.store));
  assert.equal(result.ok, true);
  assert.equal(fx.store.journal().status, 'completed');
  assert.notEqual(fx.store.journal().id, 'interrupted-run');
});

test('setMemoryRow.row keeps the Reflection and Kibitzer routes independent', (t) => {
  const fx = makeFixture(t);
  const configPath = path.join(fx.primary, 'omo.jsonc');
  const before = readJsonFile(configPath);
  const kibBefore = JSON.parse(JSON.stringify(before['[native]'].memory.recall ?? null));
  const kibCategoryBefore = JSON.parse(JSON.stringify(before['[native]'].categories['desktop-kibitzer'] ?? null));

  const reflection = fx.store.apply(body('apply', [{
    kind: 'setMemoryRow', row: 'reflection', mode: 'custom',
    model: 'openai/gpt-6-sol', reasoning: 'high',
  }], fx.store));
  assert.equal(reflection.ok, true, JSON.stringify(reflection));

  const afterReflection = readJsonFile(configPath);
  assert.equal(afterReflection['[native]'].memory.reflection.category, 'desktop-reflection');
  assert.ok(afterReflection['[native]'].categories['desktop-reflection']);
  assert.deepEqual(afterReflection['[native]'].memory.recall ?? null, kibBefore, 'Reflection never moves Kibitzer recall');
  assert.deepEqual(afterReflection['[native]'].categories['desktop-kibitzer'] ?? null, kibCategoryBefore,
    'Reflection never rewrites desktop-kibitzer');
  const reflectionRow = JSON.parse(JSON.stringify(afterReflection['[native]'].categories['desktop-reflection']));

  const kibitzer = fx.store.apply(body('apply', [{
    kind: 'setMemoryRow', row: 'kibitzer', mode: 'custom',
    model: 'openai/gpt-6-sol', reasoning: 'low',
  }], fx.store));
  assert.equal(kibitzer.ok, true, JSON.stringify(kibitzer));
  const afterKibitzer = readJsonFile(configPath);
  assert.equal(afterKibitzer['[native]'].memory.recall.category, 'desktop-kibitzer');
  assert.deepEqual(afterKibitzer['[native]'].categories['desktop-reflection'], reflectionRow,
    'Kibitzer never rewrites desktop-reflection');
  assert.equal(afterKibitzer['[native]'].memory.reflection.category, 'desktop-reflection');

  const cleared = fx.store.apply(body('apply', [{ kind: 'setMemoryRow', row: 'reflection', mode: 'quick' }], fx.store));
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  const afterClear = readJsonFile(configPath);
  assert.equal(afterClear['[native]'].categories['desktop-reflection'], undefined);
  assert.equal(afterClear['[native]'].memory.reflection?.category, undefined);
  assert.equal(afterClear['[native]'].memory.recall.category, 'desktop-kibitzer', 'Reflection quick leaves Kibitzer alone');
  assert.ok(afterClear['[native]'].categories['desktop-kibitzer']);
});

test('setMemoryRow rejects an unknown row without a write and keeps the historical default', (t) => {
  const fx = makeFixture(t);
  const configPath = path.join(fx.primary, 'omo.jsonc');
  const before = fs.readFileSync(configPath);
  const rejected = fx.store.preview(body('preview', [{ kind: 'setMemoryRow', row: 'desktop-kibitzer', mode: 'quick' }], fx.store));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'BAD_REQUEST');
  assert.match(rejected.message, /row must be kibitzer or reflection/);
  assert.deepEqual(fs.readFileSync(configPath), before);
  const legacy = fx.store.apply(body('apply', [{ kind: 'setMemoryRow', mode: 'quick' }], fx.store));
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  assert.equal(readJsonFile(configPath)['[native]'].memory.reflection, undefined, 'no row still means Kibitzer');
});

test('a completed apply records its request; reapply is explicit and CAS-checked', (t) => {
  const fx = makeFixture(t);
  const journalPath = path.join(fx.stable, 'agent', 'primary-agents', 'apply-journal.json');
  const settingsPath = path.join(fx.primary, 'agent', 'settings.json');
  const changes = [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }];
  const applied = fx.store.apply(body('apply', changes, fx.store));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const completed = fx.store.journal();
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.request.changes, changes, 'the journal stores the payload the owner can replay');

  const interrupted = {
    v: 1, id: 'crash-1', action: 'apply', status: 'running',
    startedAt: '2026-10-20T11:00:00.000Z',
    request: { changes: [{ kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' }], rosterRevision: 0 },
    steps: [{ step: 'write', target: 'agent/settings.json', status: 'ok' }],
  };
  atomicWriteText(journalPath, JSON.stringify(interrupted, null, 2));
  const beforeJournal = fs.readFileSync(journalPath);
  const beforeSettings = fs.readFileSync(settingsPath);
  const state = fx.store.state();
  assert.equal(state.applyJournal.status, 'interrupted');
  assert.equal(state.applyJournal.action, '다시 적용');
  assert.deepEqual(state.applyJournal.reapply.changes, interrupted.request.changes);
  assert.equal(state.applyJournal.reapply.rosterRevision, 0);
  assert.deepEqual(fs.readFileSync(journalPath), beforeJournal, 'state() never replays the journal');
  assert.deepEqual(fs.readFileSync(settingsPath), beforeSettings, 'state() writes nothing');

  const replayed = fx.store.apply(body('apply', state.applyJournal.reapply.changes, fx.store));
  assert.equal(replayed.ok, true, JSON.stringify(replayed));
  assert.equal(readJsonFile(settingsPath).compaction.model, 'openai/gpt-6-sol');
  assert.equal(fx.store.journal().status, 'completed');
  assert.notEqual(fx.store.journal().id, 'crash-1');
});

test('auth.json and stable-500 agent/settings.json are never targets and never change', (t) => {
  const fx = makeFixture(t);
  const auth = path.join(fx.primary, 'auth.json');
  const stableSettings = path.join(fx.stable, 'agent', 'settings.json');
  const authHash = hashFile(auth);
  const stableHash = hashFile(stableSettings);
  assert.ok(!fx.store.targetIds().some((id) => id.endsWith('auth.json')));
  assert.ok(!fx.store.targetIds().includes('stable/agent/settings.json'));
  const result = fx.store.apply(body('apply', [{ kind: 'selectProfile', profileKey: 'gpt-deepseek' }], fx.store));
  assert.equal(result.ok, true);
  assert.equal(hashFile(auth), authHash);
  assert.equal(hashFile(stableSettings), stableHash);
});

test('goldens: apply-gpt-deepseek through the store equals the golden; defaultThinkingLevel and stable settings stay at the seed', (t) => {
  // PS also writes settings.defaultThinkingLevel (PS:3540) and stable-500 agent/settings.json (PS:3773); the store owns
  // neither (plan D13: the main effort stays in the sidecar; stable-500 settings are never a target), so both keep the seed.
  const scenarioFile = (scenario, name) => JSON.parse(fs.readFileSync(
    path.join(here, 'fixtures', 'profiles', 'goldens', scenario, 'files', `${name}.json`), 'utf8'));
  const seedSettings = scenarioFile('dump-state', 'primary/settings.json');
  const fx = makeFixture(t, {
    omo: scenarioFile('dump-state', 'primary/omo.jsonc'),
    settings: seedSettings,
    stableOmo: scenarioFile('dump-state', 'stable/omo.jsonc'),
    mainOverride: scenarioFile('dump-state', 'primary/main-override.json'),
  });
  const stableSettings = path.join(fx.stable, 'agent', 'settings.json');
  const stableHash = hashFile(stableSettings);
  const result = fx.store.apply(body('apply', [{ kind: 'selectProfile', profileKey: 'gpt-deepseek' }], fx.store));
  assert.equal(result.ok, true);
  const folded = (value) => JSON.parse(JSON.stringify(value, (key, item) => (key === 'appliedAt' ? '<APPLIED_AT>' : item)));
  const written = {
    'primary/omo.jsonc': path.join(fx.primary, 'omo.jsonc'),
    'primary/selection.json': path.join(fx.primary, 'native-profile-selection.json'),
    'primary/agent-selection.json': path.join(fx.primary, 'agent', 'native-profile-selection.json'),
    'primary/main-override.json': path.join(fx.primary, 'runtime', 'native-profile-switcher-main.json'),
    'stable/omo.jsonc': path.join(fx.stable, 'omo.jsonc'),
  };
  for (const [name, file] of Object.entries(written)) {
    assert.deepEqual(folded(readJsonFile(file)), folded(scenarioFile('apply-gpt-deepseek', name)), name);
  }
  const golden = scenarioFile('apply-gpt-deepseek', 'primary/settings.json');
  assert.notEqual(golden.defaultThinkingLevel, seedSettings.defaultThinkingLevel, 'the golden moves the level, so keeping it is observable');
  assert.deepEqual(readJsonFile(path.join(fx.primary, 'agent', 'settings.json')),
    { ...golden, defaultThinkingLevel: seedSettings.defaultThinkingLevel });
  assert.equal(hashFile(stableSettings), stableHash);
});

test('setRoute, setModelProfile and setMemoryRow are applied through the same pipeline', (t) => {
  const fx = makeFixture(t);
  const route = fx.store.apply(body('apply', [{
    kind: 'setRoute', profileKey: 'native-gpt-kimi-deepseek', section: 'agents', role: 'explore',
    provider: 'openai', model: 'gpt-6-sol', thinking: 'high',
  }], fx.store));
  assert.equal(route.ok, true);
  const config = readJsonFile(path.join(fx.primary, 'omo.jsonc'));
  const layer = config.profiles['native-gpt-kimi-deepseek']['[native]'] ?? config.profiles['native-gpt-kimi-deepseek']['[senpi]'];
  const alias = layer.agents.explore.model;
  assert.ok(config['[native]'].models[alias]);
  assert.equal(config['[native]'].models[alias].model, 'gpt-6-sol');

  const profile = fx.store.apply(body('apply', [{ kind: 'setModelProfile', profileKey: 'gpt-kimi-deepseek', selection: 'off' }], fx.store));
  assert.equal(profile.ok, true);
  const afterProfile = readJsonFile(path.join(fx.primary, 'omo.jsonc'));
  assert.equal(afterProfile.profiles['native-gpt-kimi-deepseek'].model_profile, undefined);

  const memory = fx.store.apply(body('apply', [{ kind: 'setMemoryRow', mode: 'custom', model: 'openai/gpt-6-sol', reasoning: 'high' }], fx.store));
  assert.equal(memory.ok, true);
  const afterMemory = readJsonFile(path.join(fx.primary, 'omo.jsonc'));
  assert.ok(afterMemory['[native]'].categories['desktop-kibitzer']);
  assert.equal(afterMemory['[native]'].memory.recall.category, 'desktop-kibitzer');

  const quick = fx.store.apply(body('apply', [{ kind: 'setMemoryRow', mode: 'quick' }], fx.store));
  assert.equal(quick.ok, true);
  const afterQuick = readJsonFile(path.join(fx.primary, 'omo.jsonc'));
  assert.equal(afterQuick['[native]'].categories['desktop-kibitzer'], undefined);
});

test('setRoute to a CommandCode model surfaces the subscription preflight warning', (t) => {
  const fx = makeFixture(t);
  const subscriptionsPath = path.join(fx.primary, 'commandcode-subscriptions.json');
  const change = {
    kind: 'setRoute', profileKey: 'native-cmd-glm-deepseek', section: 'agents', role: 'explore',
    provider: 'commandcode', model: 'z-ai/glm-5.3-flash', thinking: 'max',
  };
  const warning = '커맨드코드 모델이지만 구독이 배정되지 않았습니다 (기본 키로 동작)';
  fs.writeFileSync(subscriptionsPath, JSON.stringify({ profileAssignments: {} }));
  const unassigned = fx.store.preview(body('preview', [change], fx.store));
  assert.equal(unassigned.ok, true);
  assert.ok(unassigned.warnings.includes(warning), JSON.stringify(unassigned.warnings));
  assert.deepEqual(unassigned.writes, ['omo.jsonc']);

  fs.writeFileSync(subscriptionsPath,
    JSON.stringify({ profileAssignments: { 'native-cmd-glm-deepseek': 'sub-123' } }));
  const assigned = fx.store.preview(body('preview', [change], fx.store));
  assert.equal(assigned.ok, true);
  assert.equal(assigned.warnings.includes(warning), false);
});

test('migrateReviewerKeys rewrites the legacy reviewer names in the allowed paths', (t) => {
  const fx = makeFixture(t);
  const file = path.join(fx.primary, 'omo.jsonc');
  const config = readJsonFile(file);
  config['[native]'].agents['omo-senpi-code-reviewer'] = { model: 'flash-high' };
  delete config.profiles['native-experimental-custom']['[native]'].agents['omo-native-qa-executor'];
  config.profiles['native-experimental-custom']['[native]'].agents['omo-senpi-qa-executor'] = { model: 'flash-low' };
  delete config.profiles['native-cmd-glm-deepseek']['[native]'].agents['omo-native-gate-reviewer'];
  config.profiles['native-cmd-glm-deepseek']['[native]'].agents['omo-senpi-gate-reviewer'] = { model: 'glm-high' };
  fs.writeFileSync(file, formatJsonText(config, fx.style));
  const result = fx.store.apply(body('apply', [{ kind: 'migrateReviewerKeys' }], fx.store));
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = readJsonFile(file);
  assert.equal(after['[native]'].agents['omo-senpi-code-reviewer'], undefined);
  assert.deepEqual(after['[native]'].agents['omo-native-code-reviewer'], { model: 'flash-high' });
  assert.equal(after.profiles['native-experimental-custom']['[native]'].agents['omo-native-qa-executor'].model, 'flash-low');
  assert.equal(after.profiles['native-cmd-glm-deepseek']['[native]'].agents['omo-native-gate-reviewer'].model, 'glm-high');
});

test('redaction hides the todo-3 credential key set', () => {
  const value = { apiKey: 'x', nested: { token: 'y', keep: 'z' }, list: [{ password: 'p' }] };
  assert.deepEqual(redact(value), { apiKey: '<redacted>', nested: { token: '<redacted>', keep: 'z' }, list: [{ password: '<redacted>' }] });
});

test('memory: a memory-only apply writes stable omo.jsonc, quick and the other row byte-preserved', (t) => {
  const fx = makeFixture(t, { mirrors: ['mirror1', 'mirror2'] });
  const stableOmo = path.join(fx.stable, 'omo.jsonc');
  const beforeStable = readJsonFile(stableOmo);
  const beforeQuick = structuredClone(beforeStable['[native]'].categories.quick);

  const customChange = { kind: 'setMemoryRow', mode: 'custom', model: 'openai/gpt-6-sol', reasoning: 'high' };
  const customResult = fx.store.apply(body('apply', [customChange], fx.store));
  assert.equal(customResult.ok, true, JSON.stringify(customResult));
  assert.ok(customResult.writes.includes('stable/omo.jsonc'), 'stable/omo.jsonc must be in writes');
  assert.ok(customResult.writes.includes('omo.jsonc'), 'omo.jsonc must be in writes');
  assert.ok(customResult.writes.includes('mirror/mirror1/omo.jsonc'), 'mirror1 must be in writes');
  assert.ok(customResult.writes.includes('mirror/mirror2/omo.jsonc'), 'mirror2 must be in writes');

  const afterStable = readJsonFile(stableOmo);
  assert.ok(afterStable['[native]'].categories['desktop-kibitzer']);
  assert.equal(afterStable['[native]'].memory.recall.category, 'desktop-kibitzer');
  assert.deepEqual(afterStable['[native]'].categories.quick, beforeQuick, 'quick category is byte-preserved');
  assert.equal(afterStable['[native]'].categories['desktop-reflection'], undefined, 'reflection row is preserved');

  // Changing reflection preserves kibitzer and quick
  const refChange = { kind: 'setMemoryRow', row: 'reflection', mode: 'custom', model: 'openai/gpt-6-sol', reasoning: 'high' };
  const refResult = fx.store.apply(body('apply', [refChange], fx.store));
  assert.equal(refResult.ok, true, JSON.stringify(refResult));

  const afterRefStable = readJsonFile(stableOmo);
  assert.ok(afterRefStable['[native]'].categories['desktop-reflection']);
  assert.equal(afterRefStable['[native]'].memory.reflection.category, 'desktop-reflection');
  assert.ok(afterRefStable['[native]'].categories['desktop-kibitzer'], 'kibitzer is preserved');
  assert.equal(afterRefStable['[native]'].memory.recall.category, 'desktop-kibitzer');
  assert.deepEqual(afterRefStable['[native]'].categories.quick, beforeQuick, 'quick category is byte-preserved');

  // Changing kibitzer back to quick preserves reflection and quick
  const quickChange = { kind: 'setMemoryRow', mode: 'quick' };
  const quickResult = fx.store.apply(body('apply', [quickChange], fx.store));
  assert.equal(quickResult.ok, true, JSON.stringify(quickResult));

  const afterQuickStable = readJsonFile(stableOmo);
  assert.equal(afterQuickStable['[native]'].categories['desktop-kibitzer'], undefined);
  assert.equal(afterQuickStable['[native]'].memory?.recall?.category, undefined);
  assert.ok(afterQuickStable['[native]'].categories['desktop-reflection'], 'reflection row is preserved');
  assert.equal(afterQuickStable['[native]'].memory.reflection.category, 'desktop-reflection');
  assert.deepEqual(afterQuickStable['[native]'].categories.quick, beforeQuick, 'quick category is byte-preserved');
});

test('memory: a foreign desktop-kibitzer category is refused before any write', (t) => {
  const fx = makeFixture(t, { mirrors: ['mirror1', 'mirror2'] });
  const primaryOmo = path.join(fx.primary, 'omo.jsonc');
  const stableOmo = path.join(fx.stable, 'omo.jsonc');
  const mirror1Omo = path.join(fx.mirrors.mirror1, 'omo.jsonc');
  const mirror2Omo = path.join(fx.mirrors.mirror2, 'omo.jsonc');

  // Inject a foreign desktop-kibitzer category into stable home
  const stableConfig = readJsonFile(stableOmo);
  stableConfig['[native]'].categories['desktop-kibitzer'] = {
    model: 'foreign-kibitzer-model',
  };
  fs.writeFileSync(stableOmo, formatJsonText(stableConfig, fx.style));

  const primaryHashBefore = hashFile(primaryOmo);
  const stableHashBefore = hashFile(stableOmo);
  const mirror1HashBefore = hashFile(mirror1Omo);
  const mirror2HashBefore = hashFile(mirror2Omo);

  const change = { kind: 'setMemoryRow', mode: 'custom', model: 'openai/gpt-6-sol', reasoning: 'high' };
  const result = fx.store.apply(body('apply', [change], fx.store));

  assert.equal(result.ok, false, 'apply must be refused');
  assert.match(result.message, /foreign recall route|collision/i);

  // All four fixture homes unchanged
  assert.equal(hashFile(primaryOmo), primaryHashBefore, 'primary home unchanged');
  assert.equal(hashFile(stableOmo), stableHashBefore, 'stable home unchanged');
  assert.equal(hashFile(mirror1Omo), mirror1HashBefore, 'mirror1 home unchanged');
  assert.equal(hashFile(mirror2Omo), mirror2HashBefore, 'mirror2 home unchanged');
});

test('options: an option the store does not read is refused before any file is read or written', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-p10-options-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roots = { primaryHome: path.join(root, 'primary'), stableHome: path.join(root, 'stable'), mirrorHomes: [] };
  const used = [];
  const watchedFs = new Proxy(fs, { get: (target, name) => { used.push(name); return target[name]; } });

  // The call shape of the 7f22588 order: test. The store does not read roots:, so it used to open the live homes.
  assert.throws(() => openProfilesStore({ roots, fs: watchedFs }), { code: 'UNKNOWN_OPTION', keys: ['roots'] });
  assert.deepEqual(used, [], 'no file call was made');
  assert.deepEqual(fs.readdirSync(root), [], 'nothing was created');
});

test('options: naming some homes but not all is refused, so a home left out cannot fall back to a live one', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-p10-options-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homes = { primaryHome: path.join(root, 'primary'), stableHome: path.join(root, 'stable') };

  assert.throws(() => openProfilesStore(homes), { code: 'PARTIAL_HOMES', missing: ['mirrorHomes'] });
  assert.throws(() => openProfilesStore({ ...homes, mirrorHomes: null }), { code: 'PARTIAL_HOMES', missing: ['mirrorHomes'] });
  assert.deepEqual(fs.readdirSync(root), [], 'nothing was created');
  assert.deepEqual(openProfilesStore({ ...homes, mirrorHomes: [] }).roots, { ...homes, mirrorHomes: [] });
});

// The Oracle advisor table belongs to the oracle-advisor extension; the switcher rewrites one field of it.
function seedAdvisors(fx) {
  const file = path.join(fx.primary, 'agent', 'oracle-advisor', 'routing.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = {
    v: 1,
    profiles: {
      claude: { model: 'commandcode-anthropic/claude-sonnet-5:high', family: 'claude' },
      gpt: { model: 'commandcode/gpt-6-sol:high', family: 'gpt' },
    },
    by_family: { claude: { work: 'gpt', completion: 'gpt' }, gpt: { work: 'claude', completion: 'claude' }, other: { work: 'claude', completion: 'gpt' } },
    by_agent: {},
    by_nature: { design: 'claude', lowlevel: 'gpt' },
  };
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return { file, value };
}

const claudeAdvisor = { kind: 'setAdvisor', advisor: 'claude', provider: 'commandcode-anthropic', model: 'commandcode-anthropic/claude-opus-5', thinking: 'high' };

test('setAdvisor rewrites only that advisor model and the reopened state shows the saved pin', (t) => {
  const fx = makeFixture(t);
  const { file, value } = seedAdvisors(fx);
  const untouched = ['omo.jsonc', 'agent/settings.json', 'native-profile-selection.json', 'agent/native-profile-selection.json']
    .map((rel) => [rel, hashFile(path.join(fx.primary, rel))]);
  assert.deepEqual(fx.store.state().advisors.rows.map((row) => [row.name, row.family, row.model, row.thinking]), [
    ['claude', 'claude', 'commandcode-anthropic/claude-sonnet-5', 'high'],
    ['gpt', 'gpt', 'commandcode/gpt-6-sol', 'high'],
  ]);
  const result = fx.store.apply(body('apply', [claudeAdvisor], fx.store));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.writes, ['agent/oracle-advisor/routing.json']);
  assert.deepEqual(readJsonFile(file), {
    ...value, profiles: { ...value.profiles, claude: { model: 'commandcode-anthropic/claude-opus-5:high', family: 'claude' } },
  });
  for (const [rel, hash] of untouched) assert.equal(hashFile(path.join(fx.primary, rel)), hash, rel + ' unchanged');
  const reopened = fx.store.state().advisors.rows[0];
  assert.deepEqual([reopened.model, reopened.thinking], ['commandcode-anthropic/claude-opus-5', 'high']);
  const backups = fs.readdirSync(path.join(fx.primary, 'runtime', 'native-profile-switcher-backups'));
  assert.ok(backups.some((name) => name.includes('oracle-advisor-routing')), backups.join(','));
});

test('setAdvisor refuses a missing table, another family and an unknown advisor without writing', (t) => {
  const fx = makeFixture(t);
  const missing = fx.store.preview(body('preview', [claudeAdvisor], fx.store));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'MISSING_CONFIG');
  const { file } = seedAdvisors(fx);
  const before = hashFile(file);
  const cross = fx.store.apply(body('apply', [{ ...claudeAdvisor, provider: 'commandcode', model: 'commandcode/gpt-6-sol' }], fx.store));
  assert.equal(cross.ok, false);
  assert.equal(cross.code, 'ADVISOR_FAMILY');
  assert.match(cross.message, /claude advisor/);
  const unknown = fx.store.apply(body('apply', [{ ...claudeAdvisor, advisor: 'gemini' }], fx.store));
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /Unknown oracle advisor gemini/);
  assert.equal(hashFile(file), before);
});

test('setRoute on the declared oracle keeps its tools; an agent file makes ouroboros a writable route', (t) => {
  const omo = readGolden('primary/omo.jsonc.json');
  const profileKey = 'native-gpt-kimi-deepseek';
  omo.profiles[profileKey]['[native]'].agents.oracle = { tools: { read: true, grep: true }, model: 'sol' };
  const fx = makeFixture(t, { omo });
  fs.mkdirSync(path.join(fx.primary, 'agent', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(fx.primary, 'agent', 'agents', 'ouroboros.md'), '---\ndescription: fixture\n---\n');
  const rows = fx.store.state().routing.rows;
  for (const role of ['oracle', 'ouroboros']) {
    assert.equal(rows.find((row) => row.section === 'agents' && row.role === role).readOnly, false, role);
  }
  const route = (role) => ({ kind: 'setRoute', profileKey, section: 'agents', role, provider: 'openai', model: 'gpt-6-sol', thinking: 'high' });
  const result = fx.store.apply(body('apply', [route('oracle'), route('ouroboros')], fx.store));
  assert.equal(result.ok, true, JSON.stringify(result));
  const config = readJsonFile(path.join(fx.primary, 'omo.jsonc'));
  const agents = config.profiles[profileKey]['[native]'].agents;
  assert.deepEqual(agents.oracle.tools, { read: true, grep: true });
  for (const role of ['oracle', 'ouroboros']) {
    assert.equal(config['[native]'].models[agents[role].model].model, 'gpt-6-sol', role);
  }
});
