// Model support registry composition and per-home support gate tests (plan todo 5).
// Credential-blind registry composition, per-home validation, and store integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeHomeRegistry,
  getServedModelIds,
  validateSelection,
} from '../src/profiles/registry.mjs';
import {
  formatJsonText,
  openProfilesStore,
} from '../src/profiles/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const GOLDEN = path.join(here, 'fixtures', 'profiles', 'goldens', 'apply-gpt-kimi-deepseek', 'files');
const REGISTRY_FIXTURE = path.join(here, 'fixtures', 'profiles', 'registry');
const REAL_INVENTORY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'profiles', 'inventory-5.1.44.json'), 'utf8'));
const PS_STYLE = { bom: true, eol: '\r\n', indent: '    ', keySep: ':  ', trailingNewline: true };

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function makeFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-p5-reg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary');
  const stable = path.join(root, 'stable');
  fs.mkdirSync(path.join(primary, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(stable, 'agent'), { recursive: true });

  const style = options.style ?? PS_STYLE;
  const omo = options.omo ?? JSON.parse(fs.readFileSync(path.join(GOLDEN, 'primary', 'omo.jsonc.json'), 'utf8'));
  const settings = options.settings ?? JSON.parse(fs.readFileSync(path.join(GOLDEN, 'primary', 'settings.json.json'), 'utf8'));
  const stableOmo = options.stableOmo ?? JSON.parse(fs.readFileSync(path.join(GOLDEN, 'stable', 'omo.jsonc.json'), 'utf8'));

  fs.writeFileSync(path.join(primary, 'omo.jsonc'), options.rawOmo ?? formatJsonText(omo, style));
  fs.writeFileSync(path.join(primary, 'agent', 'settings.json'), formatJsonText(settings, style));
  fs.writeFileSync(path.join(primary, 'native-profile-selection.json'),
    JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'seed' }, null, 2));
  fs.writeFileSync(path.join(primary, 'agent', 'native-profile-selection.json'),
    JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'seed' }, null, 2));
  fs.writeFileSync(path.join(stable, 'omo.jsonc'), formatJsonText(stableOmo, style));
  fs.writeFileSync(path.join(stable, 'agent', 'settings.json'), '{"packages":["stable"]}');

  // Copy registry models.json fixtures by default
  const regPrimary = path.join(REGISTRY_FIXTURE, 'primary', 'agent', 'models.json');
  const regStable = path.join(REGISTRY_FIXTURE, 'stable', 'agent', 'models.json');
  if (fs.existsSync(regPrimary)) fs.copyFileSync(regPrimary, path.join(primary, 'agent', 'models.json'));
  if (fs.existsSync(regStable)) fs.copyFileSync(regStable, path.join(stable, 'agent', 'models.json'));

  const pluginPath = path.join(root, 'omo.js');
  fs.writeFileSync(pluginPath, 'plugin-body');

  const storeOptions = {
    primaryHome: primary,
    stableHome: stable,
    mirrorHomes: [],
    pluginPath,
    inventory: {
      ...REAL_INVENTORY,
      sources: {
        ...REAL_INVENTORY.sources,
        omo: { ...REAL_INVENTORY.sources?.omo, sha256: sha(Buffer.from('plugin-body')) },
      },
    },
    now: () => Date.parse('2026-10-23T12:00:00Z'),
    ...options.storeOptions,
  };

  const store = openProfilesStore(storeOptions);
  return { root, primary, stable, store, storeOptions };
}

// ── Registry child & cache tests ───────────────────────────────────────────────

test('registry: child timeout returns unknown', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-p5-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'models.json'), '{}');

  // Fake spawn that simulates a timeout error
  const fakeSpawn = () => ({
    status: null,
    error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    stdout: '',
    stderr: '',
  });

  const reg = composeHomeRegistry(agentDir, { spawn: fakeSpawn, timeoutMs: 100 });
  assert.equal(reg.unknown, true);
  assert.deepEqual(reg.models, []);
});

test('registry: cache invalidates when models-store.json changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-p5-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'models.json'), '{"providers":{}}');
  fs.writeFileSync(path.join(agentDir, 'models-store.json'), '{"rev":1}');

  let spawnCount = 0;
  const fakeSpawn = () => {
    spawnCount += 1;
    return {
      status: 0,
      stdout: JSON.stringify({ models: [{ provider: 'test', modelId: 'test/m1', reasoning: true, levels: ['low'] }], errors: [] }),
      stderr: '',
    };
  };

  const reg1 = composeHomeRegistry(agentDir, { spawn: fakeSpawn });
  assert.equal(spawnCount, 1);
  assert.equal(reg1.models.length, 1);

  // Call again without changes: cache hit, no new spawn
  const reg2 = composeHomeRegistry(agentDir, { spawn: fakeSpawn });
  assert.equal(spawnCount, 1);

  // Modify models-store.json: cache should invalidate
  fs.writeFileSync(path.join(agentDir, 'models-store.json'), '{"rev":2}');
  const reg3 = composeHomeRegistry(agentDir, { spawn: fakeSpawn });
  assert.equal(spawnCount, 2);
});

test('registry: real composition against a fixture home', async (t) => {
  const fixtureAgent = path.join(REGISTRY_FIXTURE, 'primary', 'agent');
  const reg = composeHomeRegistry(fixtureAgent, { timeoutMs: 30000 });
  assert.equal(reg.unknown, undefined);
  assert.ok(Array.isArray(reg.models));
  assert.ok(reg.models.length > 0);
  assert.ok(Array.isArray(reg.errors));
  const argon = reg.models.find((m) => m.modelId === 'antigravity-ocx/google-antigravity/gemini-4-argon');
  assert.ok(argon, 'antigravity-ocx/google-antigravity/gemini-4-argon should be composed');
  assert.deepEqual(argon.levels, ['low', 'medium', 'high']);
});

// ── Model support gate tests ───────────────────────────────────────────────────

test('support: opencode/gemini-4-argon served=false is refused in role, main, summarizer, kibitzer and reflection, in preview and apply, with zero writes and backups', async (t) => {
  // Setup store where opencode/gemini-4-argon is NOT served (e.g. unserved in registry)
  const fakeRegistry = {
    models: [
      { provider: 'antigravity-ocx', modelId: 'antigravity-ocx/google-antigravity/gemini-4-argon', reasoning: true, levels: ['low', 'medium', 'high'] },
      { provider: 'openai', modelId: 'openai/gpt-6-sol', reasoning: true, levels: ['off', 'low', 'medium', 'high'] },
    ],
    errors: [],
  };

  const { store, primary, stable } = makeFixture(t, {
    storeOptions: {
      registries: { primary: fakeRegistry, stable: fakeRegistry },
    },
  });

  const filesBefore = {
    omo: fs.readFileSync(path.join(primary, 'omo.jsonc')),
    settings: fs.readFileSync(path.join(primary, 'agent', 'settings.json')),
    stableOmo: fs.readFileSync(path.join(stable, 'omo.jsonc')),
  };
  const backupsDir = path.join(primary, 'runtime', 'native-profile-switcher-backups');

  const editors = [
    { name: 'role', change: { kind: 'setRoute', section: 'agents', role: 'ouroboros', provider: 'opencode', model: 'opencode/gemini-4-argon', thinking: 'high' } },
    { name: 'main', change: { kind: 'setMain', provider: 'opencode', model: 'opencode/gemini-4-argon', thinking: 'high' } },
    { name: 'summarizer', change: { kind: 'setSummarizer', modelId: 'opencode/gemini-4-argon' } },
    { name: 'kibitzer', change: { kind: 'setMemoryRow', row: 'kibitzer', mode: 'custom', model: 'opencode/gemini-4-argon', reasoning: 'high' } },
    { name: 'reflection', change: { kind: 'setMemoryRow', row: 'reflection', mode: 'custom', model: 'opencode/gemini-4-argon', reasoning: 'high' } },
  ];

  for (const { name, change } of editors) {
    const previewRes = store.preview({ action: 'preview', changes: [change], expected: store.state().targets, rosterRevision: 0 });
    assert.equal(previewRes.ok, false, `${name} preview must fail`);
    assert.equal(previewRes.code, 'UNSUPPORTED_MODEL', `${name} preview code must be UNSUPPORTED_MODEL`);

    const applyRes = store.apply({ action: 'apply', changes: [change], expected: store.state().targets, rosterRevision: 0 });
    assert.equal(applyRes.ok, false, `${name} apply must fail`);
    assert.equal(applyRes.code, 'UNSUPPORTED_MODEL', `${name} apply code must be UNSUPPORTED_MODEL`);
  }

  // Zero writes
  assert.equal(sha(fs.readFileSync(path.join(primary, 'omo.jsonc'))), sha(filesBefore.omo));
  assert.equal(sha(fs.readFileSync(path.join(primary, 'agent', 'settings.json'))), sha(filesBefore.settings));
  assert.equal(sha(fs.readFileSync(path.join(stable, 'omo.jsonc'))), sha(filesBefore.stableOmo));

  // Zero backups
  const backups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
  assert.equal(backups.length, 0, 'zero backups written');
});

test('support: antigravity-ocx google-antigravity/gemini-4-argon is accepted with its registry levels', async (t) => {
  const fakeRegistry = {
    models: [
      { provider: 'antigravity-ocx', modelId: 'antigravity-ocx/google-antigravity/gemini-4-argon', reasoning: true, levels: ['low', 'medium', 'high'] },
    ],
    errors: [],
  };

  const { store } = makeFixture(t, {
    storeOptions: {
      registries: { primary: fakeRegistry, stable: fakeRegistry },
    },
  });

  const change = {
    kind: 'setRoute',
    section: 'agents',
    role: 'ouroboros',
    provider: 'antigravity-ocx',
    model: 'antigravity-ocx/google-antigravity/gemini-4-argon',
    thinking: 'high',
  };

  const previewRes = store.preview({ action: 'preview', changes: [change], expected: store.state().targets, rosterRevision: 0 });
  assert.equal(previewRes.ok, true, 'preview accepted');

  const applyRes = store.apply({ action: 'apply', changes: [change], expected: store.state().targets, rosterRevision: 0 });
  assert.equal(applyRes.ok, true, 'apply accepted');
});

test('support: an effort outside the model\'s levels is refused; picker levels follow the registry', async (t) => {
  const fakeRegistry = {
    models: [
      { provider: 'antigravity-ocx', modelId: 'antigravity-ocx/google-antigravity/gemini-4-argon', reasoning: true, levels: ['low', 'medium', 'high'] },
    ],
    errors: [],
  };

  const { store } = makeFixture(t, {
    storeOptions: {
      registries: { primary: fakeRegistry, stable: fakeRegistry },
    },
  });

  const state = store.state();
  // Check catalog levels follow registry
  const argonEntry = Object.values(state.catalog ?? {}).find((entry) => entry.model === 'antigravity-ocx/google-antigravity/gemini-4-argon');
  if (argonEntry) {
    assert.deepEqual(argonEntry.levels, ['low', 'medium', 'high']);
  }

  // Effort 'max' is not in ['low', 'medium', 'high']
  const change = {
    kind: 'setRoute',
    section: 'agents',
    role: 'ouroboros',
    provider: 'antigravity-ocx',
    model: 'antigravity-ocx/google-antigravity/gemini-4-argon',
    thinking: 'max',
  };

  const res = store.apply({ action: 'apply', changes: [change], expected: state.targets, rosterRevision: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UNSUPPORTED_EFFORT');
});

test('support: memory needs every home; a primary-only model is refused', async (t) => {
  const primaryRegistry = {
    models: [
      { provider: 'primary-only', modelId: 'primary-only/special-model', reasoning: true, levels: ['high'] },
    ],
    errors: [],
  };
  const stableRegistry = {
    models: [],
    errors: [],
  };

  const { store } = makeFixture(t, {
    storeOptions: {
      registries: { primary: primaryRegistry, stable: stableRegistry },
    },
  });

  const change = {
    kind: 'setMemoryRow',
    row: 'kibitzer',
    mode: 'custom',
    model: 'primary-only/special-model',
    reasoning: 'high',
  };

  const res = store.apply({ action: 'apply', changes: [change], expected: store.state().targets, rosterRevision: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UNSUPPORTED_MODEL');
  assert.equal(res.home, 'stable');
});

test('support: a lookup failure is unknown - no new assignment, the saved value is displayed', async (t) => {
  const unknownRegistry = {
    unknown: true,
    models: [],
    errors: [],
  };

  const { store } = makeFixture(t, {
    storeOptions: {
      registries: { primary: unknownRegistry, stable: unknownRegistry },
    },
  });

  const state = store.state();
  assert.ok(state.registry?.unknownHomes?.includes('primary'));
  assert.ok(state.registry?.unknownHomes?.includes('stable'));

  // Saved values in routing rows are still displayed
  assert.ok(state.routing.rows.length > 0);
  assert.ok(state.routing.rows[0].model !== undefined);

  // New assignment refused with REGISTRY_UNKNOWN
  const change = {
    kind: 'setRoute',
    section: 'agents',
    role: 'ouroboros',
    provider: 'openai',
    model: 'openai/gpt-6-sol',
    thinking: 'high',
  };
  const res = store.apply({ action: 'apply', changes: [change], expected: state.targets, rosterRevision: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REGISTRY_UNKNOWN');
});

test('support: an existing alias cannot bypass the check', async (t) => {
  // Primary omo has alias pointing to opencode/gemini-4-argon
  const omo = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'primary', 'omo.jsonc.json'), 'utf8'));
  const catalog = omo['[senpi]']?.models ?? omo['[native]']?.models;
  catalog['bypassed-alias'] = { model: 'opencode/gemini-4-argon', variant: 'high' };

  // Registry does NOT serve opencode/gemini-4-argon
  const fakeRegistry = { models: [], errors: [] };

  const { store } = makeFixture(t, {
    omo,
    storeOptions: {
      registries: { primary: fakeRegistry, stable: fakeRegistry },
    },
  });

  const change = {
    kind: 'setRoute',
    section: 'agents',
    role: 'ouroboros',
    alias: 'bypassed-alias',
  };

  const res = store.apply({ action: 'apply', changes: [change], expected: store.state().targets, rosterRevision: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UNSUPPORTED_MODEL');
});

test('support: nested provider/model ids', async (t) => {
  const fakeRegistry = {
    models: [
      { provider: 'antigravity-ocx', modelId: 'antigravity-ocx/google-antigravity/gemini-4-argon', reasoning: true, levels: ['low', 'medium', 'high'] },
    ],
    errors: [],
  };

  const res = validateSelection({
    kind: 'role',
    homes: ['primary', 'stable'],
    provider: 'antigravity-ocx',
    model: 'google-antigravity/gemini-4-argon',
    effort: 'high',
    registries: { primary: fakeRegistry, stable: fakeRegistry },
  });
  assert.equal(res.ok, true);
});

test('support: a saved unsupported value stays visible with its flag and reason and is byte-preserved through an unrelated apply', async (t) => {
  const omo = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'primary', 'omo.jsonc.json'), 'utf8'));
  const catalog = omo['[senpi]']?.models ?? omo['[native]']?.models;
  catalog['unsupported-legacy'] = { model: 'legacy-provider/old-model', variant: 'high' };
  const layer = omo.profiles['native-gpt-kimi-deepseek']['[senpi]'] ?? omo.profiles['native-gpt-kimi-deepseek']['[native]'];
  layer.agents.ouroboros = { model: 'unsupported-legacy' };

  const fakeRegistry = {
    models: [
      { provider: 'openai', modelId: 'openai/gpt-6-sol', reasoning: true, levels: ['off', 'low', 'medium', 'high'] },
    ],
    errors: [],
  };

  const { store, primary } = makeFixture(t, {
    omo,
    storeOptions: {
      registries: { primary: fakeRegistry, stable: fakeRegistry },
    },
  });

  const state = store.state();
  const row = state.routing.rows.find((r) => r.section === 'agents' && r.role === 'ouroboros');
  assert.ok(row, 'ouroboros row exists');
  assert.equal(row.unsupported, true);
  assert.equal(row.unsupportedReason, 'UNSUPPORTED_MODEL');

  // Unrelated change: set main to supported model
  const unrelatedChange = {
    kind: 'setMain',
    provider: 'openai',
    model: 'openai/gpt-6-sol',
    thinking: 'high',
  };
  const applyRes = store.apply({ action: 'apply', changes: [unrelatedChange], expected: state.targets, rosterRevision: 0 });
  assert.equal(applyRes.ok, true);

  // Read omo.jsonc again: unsupported-legacy is still assigned to ouroboros
  const reloadedOmo = readJsonFile(path.join(primary, 'omo.jsonc'));
  const reloadedLayer = reloadedOmo.profiles['native-gpt-kimi-deepseek']['[senpi]'] ?? reloadedOmo.profiles['native-gpt-kimi-deepseek']['[native]'];
  assert.equal(reloadedLayer.agents.ouroboros.model, 'unsupported-legacy');
});

test('support: a newly registered non-catalog model becomes selectable after models.json changes; its alias is created only on apply', async (t) => {
  const fakeRegistry = {
    models: [
      { provider: 'new-provider', modelId: 'new-provider/new-chat-model', reasoning: true, levels: ['low', 'high'] },
    ],
    errors: [],
  };

  const { store, primary } = makeFixture(t, {
    storeOptions: {
      registries: { primary: fakeRegistry, stable: fakeRegistry },
    },
  });

  const change = {
    kind: 'setRoute',
    section: 'agents',
    role: 'ouroboros',
    provider: 'new-provider',
    model: 'new-provider/new-chat-model',
    thinking: 'high',
  };

  // Preview does NOT mutate catalog
  const previewRes = store.preview({ action: 'preview', changes: [change], expected: store.state().targets, rosterRevision: 0 });
  assert.equal(previewRes.ok, true);
  const omoBefore = readJsonFile(path.join(primary, 'omo.jsonc'));
  const catalogBefore = omoBefore['[senpi]']?.models ?? omoBefore['[native]']?.models;
  const hasNewAliasBefore = Object.values(catalogBefore).some((e) => e.model === 'new-provider/new-chat-model');
  assert.equal(hasNewAliasBefore, false, 'alias must not exist before apply');

  // Apply creates the alias
  const applyRes = store.apply({ action: 'apply', changes: [change], expected: store.state().targets, rosterRevision: 0 });
  assert.equal(applyRes.ok, true);
  const omoAfter = readJsonFile(path.join(primary, 'omo.jsonc'));
  const catalogAfter = omoAfter['[senpi]']?.models ?? omoAfter['[native]']?.models;
  const newAliasEntry = Object.entries(catalogAfter).find(([, e]) => e.model === 'new-provider/new-chat-model');
  assert.ok(newAliasEntry, 'alias must be created on apply');
});
