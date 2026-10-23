// Ported switcher parity + merge unit tests.
// Parity: every manifest scenario's ported-layer output equals the golden after canonical key
// sort. Volatile values (appliedAt, backup file stamps) are canonicalised on both sides; backup
// sha256 values are mapped back to the seed file they back up, using manifest.seed.files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScenario } from '../src/profiles/parity.mjs';
import {
  assertCatalogAlias, assertMemoryProfilePreservation, assertMemoryRouteWritable, commandCodeWarning, ensureOllamaCloudProviderText,
  getModelProfileSettings, getOrCreateCatalogAlias, laneMirrorPlan, memoryFingerprint, migrateReviewerKeys,
  mergeModelProfileSettings, mergeProfileLayerIntoActiveScopes, readCompactionSummarizer,
  readMainOverride, removeNullModelProfile, resolveCatalogRouteAlias, resolveMainDefaults,
  selectionState, setCompactionSummarizer, setMainDefaultsInSettings, setMainLayerOverride,
  setModelProfileSelection, setProfileLayerModel, syncStable500RoleModels, validateCustomLiteral,
} from '../src/profiles/merge.mjs';
import { expandLayerRoles, getProfile, PROFILE_META } from '../src/profiles/model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Test-only hook: the negative QA run copies the goldens, flips one byte, and points here.
const GOLDENS = process.env.PIOMO_GOLDENS_ROOT
  ? path.resolve(process.env.PIOMO_GOLDENS_ROOT)
  : path.join(here, 'fixtures', 'profiles', 'goldens');
const OPENCODE_SEED = `{
    "$schema": "https://opencode.ai/config.json",
    "provider": {
        "ollama-cloud": {
            "npm": "@ai-sdk/openai-compatible",
            "name":  "Ollama Cloud",
            "options": {
                "baseURL":  "https://ollama.com/v1"
            }
        }
    }
}`;

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

async function readGoldenFiles(name) {
  const root = path.join(GOLDENS, name, 'files');
  const result = {};
  const walk = async (dir, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else result[`${prefix}${entry.name.replace(/\.json$/, '')}`] = await readJson(path.join(dir, entry.name));
    }
  };
  await walk(root);
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = key === 'appliedAt' ? '<APPLIED_AT>' : canonical(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalBackupName(name) {
  return name
    .replace(/^omo-role-mirror-\d{8}-\d{6}-\d{3}-[0-9a-f]{32}\.jsonc$/, 'omo-role-mirror-<STAMP>-<GUID>.jsonc')
    .replace(/^omo-\d{8}-\d{6}-\d{3}\.jsonc$/, 'omo-<STAMP>.jsonc')
    .replace(/^senpi-settings-\d{8}-\d{6}-\d{3}\.json$/, 'senpi-settings-<STAMP>.json');
}

function redactText(text) {
  return text
    .replace(/("(?:apiKey|api_key|apikey|accessToken|access_token|refreshToken|refresh_token|token|secret|password|authorization)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2')
    .replace(/"[^"]*(?:sk-|ghp_|gho_|xox|AIza|eyJ|Bearer )[^"]*"/g, '"<redacted>"');
}

function withBomHash(text) {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]))
    .digest('hex');
}

const manifest = await readJson(path.join(GOLDENS, 'manifest.json'));
const seedFiles = Object.fromEntries(Object.entries(manifest.seed.files).map(([key, value]) => [key.replace(/\\/g, '/'), value]));
const seedHash = (suffix) => Object.entries(seedFiles).find(([key]) => key.endsWith(suffix))[1];
const backupPreimages = {
  [seedHash('/.omo/omo.jsonc')]: 'primary/omo.jsonc',
  [seedHash('/.omo/agent/settings.json')]: 'primary/settings.json',
  [seedHash('/.omo-stable-500/home/.omo/omo.jsonc')]: 'stable/omo.jsonc',
  [seedHash('/.omo-stable-500/home/.omo/agent/settings.json')]: 'stable/settings.json',
};

function canonicalBackups(backups) {
  const out = {};
  for (const dir of ['primary', 'stable']) {
    out[dir] = (backups?.[dir] ?? []).map((entry) => ({
      name: canonicalBackupName(entry.name),
      preimage: entry.preimage ?? backupPreimages[entry.sha256] ?? 'UNKNOWN',
    }));
  }
  return out;
}

const dumpFiles = await readGoldenFiles('dump-state');

for (const [name, scenario] of Object.entries(manifest.scenarios)) {
  test(`parity: ${name}`, async () => {
    const goldenOutput = await readJson(path.join(GOLDENS, name, 'output.json'));
    const goldenFiles = await readGoldenFiles(name);
    const intent = goldenOutput.intent;
    const profileKey = intent?.profileKey ?? name.replace(/^apply-/, '');
    const result = runScenario({
      files: dumpFiles,
      scenario: { mode: scenario.mode, profileKey },
      intent,
      rawOpenCode: OPENCODE_SEED,
      clock: {
        primaryStamp: '20261020-000000-000',
        stableStamp: '20261020-000000-001',
        roleMirrorStamp: '20261020-000000-002',
        roleMirrorGuid: '0'.repeat(32),
        primaryAppliedAt: 'canonical',
        stableAppliedAt: 'canonical',
      },
    });
    const expectedFiles = { ...goldenFiles };
    const expectedBackups = expectedFiles.backups;
    delete expectedFiles.backups;
    const actualFiles = { ...result.files };
    delete actualFiles.backups;
    if (result.rawOpenCode !== OPENCODE_SEED) {
      const text = result.rawOpenCode.replace(/\n$/, '');
      actualFiles['opencode/opencode.json'] = { sha256: withBomHash(text), unparsed: redactText(text) };
    }
    assert.deepStrictEqual(canonical(actualFiles), canonical(expectedFiles), `scenario ${name} files`);
    assert.deepStrictEqual(canonicalBackups(result.backups), canonicalBackups(expectedBackups), `scenario ${name} backups`);
  });
}

// ── unit cases ─────────────────────────────────────────────────────────────────
function catalogFixture() {
  return {
    'flash-high': { model: 'opencode-go/deepseek-v4-flash', variant: 'high' },
    'kimi-max': { model: 'kimi-coding/k3', variant: 'max' },
    'sol': { model: 'chatgpt-subscription/gpt-5.6-sol', variant: 'xhigh' },
    'glm-ollama-max': { model: 'ollama/glm-5.2', variant: 'max' },
    'zen-hy3-free': { model: 'opencode/hy3-free', variant: 'medium' },
  };
}

function configFixture() {
  return {
    '[native]': {
      models: catalogFixture(),
      agents: { explore: { model: 'flash-high' } },
      categories: { quick: { model: 'kimi-max' } },
    },
    profiles: {
      'native-gpt-kimi-deepseek': {
        '[native]': {
          agents: { explore: { model: 'flash-high' }, 'plan-reviewer': { model: 'sol' } },
          categories: { quick: { model: 'kimi-max' } },
        },
      },
      'native-experimental-custom': { '[native]': { agents: {}, categories: {} } },
      'native-cmd-glm-deepseek': { '[native]': { agents: {}, categories: {} } },
    },
  };
}

test('migrateReviewerKeys renames the nine allowed legacy keys', () => {
  const config = configFixture();
  for (const container of [
    config['[native]'].agents,
    config.profiles['native-experimental-custom']['[native]'].agents,
    config.profiles['native-cmd-glm-deepseek']['[native]'].agents,
  ]) {
    container['omo-senpi-code-reviewer'] = { model: 'a' };
    container['omo-senpi-gate-reviewer'] = { model: 'b' };
    container['omo-senpi-qa-executor'] = { model: 'c' };
  }
  const result = migrateReviewerKeys({ config });
  assert.equal(result.changed, 9);
  assert.equal(result.oldCount, 9);
  assert.equal(result.newCount, 0);
  assert.deepEqual(config['[native]'].agents['omo-senpi-code-reviewer'], { model: 'a' });
  assert.deepEqual(result.config['[native]'].agents['omo-native-code-reviewer'], { model: 'a' });
  assert.equal(Object.hasOwn(result.config['[native]'].agents, 'omo-senpi-code-reviewer'), false);
});

test('migrateReviewerKeys no-op when canonical keys already exist', () => {
  const config = configFixture();
  config['[native]'].agents['omo-native-code-reviewer'] = { model: 'a' };
  const result = migrateReviewerKeys({ config });
  assert.equal(result.changed, 0);
  assert.equal(result.noop, true);
  assert.equal(result.newCount, 1);
});

test('migrateReviewerKeys refuses conflicts and unexpected containers', () => {
  const conflict = configFixture();
  conflict['[native]'].agents['omo-senpi-code-reviewer'] = { model: 'a' };
  conflict['[native]'].agents['omo-native-code-reviewer'] = { model: 'b' };
  assert.throws(() => migrateReviewerKeys({ config: conflict }), /conflicting/);

  const unexpected = configFixture();
  unexpected['[codex]'] = { agents: { 'omo-senpi-code-reviewer': { model: 'a' } } };
  assert.throws(() => migrateReviewerKeys({ config: unexpected }), /unexpected legacy key/);
});

test('migrateReviewerKeys refuses live drift before writing', () => {
  const config = configFixture();
  for (const container of [
    config['[native]'].agents,
    config.profiles['native-experimental-custom']['[native]'].agents,
    config.profiles['native-cmd-glm-deepseek']['[native]'].agents,
  ]) {
    container['omo-senpi-code-reviewer'] = { model: 'a' };
    container['omo-senpi-gate-reviewer'] = { model: 'b' };
    container['omo-senpi-qa-executor'] = { model: 'c' };
  }
  assert.throws(() => migrateReviewerKeys({ config, live: true, preimageSha256: 'deadbeef' }),
    /owner preimage hash drift/);
  const ok = migrateReviewerKeys({
    config, live: true, preimageSha256: '80392A6A9AFC0C03E7AA289348AFAB0D22469B98B828D24FB9108E40FEC100D5',
  });
  assert.equal(ok.changed, 9);
});

test('setProfileLayerModel validates profile, alias and section in order', () => {
  const config = configFixture();
  assert.throws(() => setProfileLayerModel({
    config, profileKey: 'missing-profile', section: 'agents', role: 'explore', alias: 'nope',
  }), /프로필 missing-profile 레이어를 찾을 수 없습니다/);
  assert.throws(() => setProfileLayerModel({
    config, profileKey: 'native-gpt-kimi-deepseek', section: 'agents', role: 'explore', alias: 'nope',
  }), /알 수 없는 모델 별칭: nope/);
  assert.throws(() => setProfileLayerModel({
    config, profileKey: 'native-gpt-kimi-deepseek', section: 'agents', role: 'explore', alias: 'new-alias',
    ensureCatalogAlias: true,
  }), /생성에 필요한 모델\/강도 정보가 없습니다/);
  assert.throws(() => setProfileLayerModel({
    config, profileKey: 'native-gpt-kimi-deepseek', section: 'agents', role: 'explore', alias: 'new-alias',
    ensureCatalogAlias: true, ensureModelId: 'kimi-coding/k3', ensureVariant: 'xhigh',
  }), /지원하지 않는 추론 강도/);
  assert.equal(Object.hasOwn(config['[native]'].models, 'new-alias'), false);
});

test('setProfileLayerModel creates placeholder rows and canonicalises metis', () => {
  const config = configFixture();
  const result = setProfileLayerModel({
    config, profileKey: 'native-gpt-kimi-deepseek', section: 'categories', role: 'deep-high', alias: 'flash-high',
  });
  assert.equal(result.layer.categories['deep-high'].model, 'flash-high');

  setProfileLayerModel({
    config, profileKey: 'native-experimental-custom', section: 'agents', role: 'metis', alias: 'sol',
  });
  const rows = config.profiles['native-experimental-custom']['[native]'].agents;
  assert.equal(rows['plan-consultant'].model, 'sol');
  assert.equal(Object.hasOwn(rows, 'metis'), false);
});

test('catalog alias get-or-create and resolve rules', () => {
  const catalog = catalogFixture();
  assert.deepEqual(getOrCreateCatalogAlias({
    catalog, provider: 'opencode-go', model: 'opencode-go/deepseek-v4-flash', reasoning: 'high',
  }), { alias: 'flash-high', existed: true });
  assert.deepEqual(getOrCreateCatalogAlias({
    catalog, provider: 'opencode', model: 'opencode/hy3-free', reasoning: 'low',
  }), { alias: 'zen-hy3-free-low', existed: false });
  assert.deepEqual(getOrCreateCatalogAlias({
    catalog, provider: 'commandcode', model: 'commandcode/z-ai/glm-5.3', reasoning: 'max',
  }), { alias: 'cmd-glm-5-3-max', existed: false });
  assert.deepEqual(getOrCreateCatalogAlias({
    catalog, provider: 'kimi-coding', model: 'kimi-coding/k3', reasoning: 'max',
  }), { alias: 'kimi-max', existed: true });
  assert.deepEqual(getOrCreateCatalogAlias({
    catalog, provider: 'kimi-coding', model: 'kimi-coding/k3', reasoning: 'max', preferredAlias: 'not-there',
  }), { alias: 'kimi-max', existed: true });

  assert.equal(resolveCatalogRouteAlias({
    catalog, provider: 'opencode-go', model: 'opencode-go/deepseek-v4-flash', reasoning: 'high',
  }), 'flash-high');
  assert.throws(() => resolveCatalogRouteAlias({
    catalog, provider: 'nope', model: 'nope/x', reasoning: 'low',
  }), /카탈로그 별칭이 없습니다/);
  assert.throws(() => assertCatalogAlias(catalog, 'nope'), /알 수 없는 모델 별칭/);
  assert.throws(() => assertCatalogAlias({ broken: { model: '' } }, 'broken'), /model 값이 비어 있습니다/);
});

test('model_profile merge and null removal cover every scope', () => {
  const config = {
    model_profile: null,
    '[native]': { model_profile: null },
    profiles: {
      p: { model_profile: null, '[native]': { model_profile: null }, model_profiles: { custom: { chain: [] } } },
    },
  };
  const view = getModelProfileSettings(config, 'p');
  assert.deepEqual(view.model_profiles, { custom: { chain: [] } });
  assert.equal(view.model_profile, null);
  removeNullModelProfile(config);
  assert.equal(Object.hasOwn(config, 'model_profile'), false);
  assert.equal(Object.hasOwn(config['[native]'], 'model_profile'), false);
  assert.equal(Object.hasOwn(config.profiles.p, 'model_profile'), false);
  assert.equal(Object.hasOwn(config.profiles.p['[native]'], 'model_profile'), false);

  const active = {};
  mergeModelProfileSettings(active, { model_profile: 'daily-normal', model_profiles: { x: { a: 1 } } });
  assert.deepEqual(active, { model_profile: 'daily-normal', model_profiles: { x: { a: 1 } } });
});

test('custom-literal validation and unknown preset refusal', () => {
  assert.equal(validateCustomLiteral('  opencode-go/deepseek-v4-flash  '), 'opencode-go/deepseek-v4-flash');
  assert.throws(() => validateCustomLiteral('no-slash'), /provider\/model literal/);
  const config = configFixture();
  assert.throws(() => setModelProfileSelection({
    config, omoProfile: 'native-gpt-kimi-deepseek', selection: 'not-a-preset',
  }), /Unknown model profile/);
  setModelProfileSelection({ config, omoProfile: 'native-gpt-kimi-deepseek', selection: 'off' });
  removeNullModelProfile(config);
  assert.equal(Object.hasOwn(config.profiles['native-gpt-kimi-deepseek'], 'model_profile'), false);
});

test('main sidecar shape and defaults resolution', () => {
  let state = setMainLayerOverride({ state: {}, profileKey: 'native-x', main: { provider: 'ollama', model: 'glm-5.3-flash', thinking: 'max' } });
  assert.deepEqual(state, { 'native-x': { provider: 'ollama', model: 'glm-5.3-flash', thinking: 'max' } });
  assert.deepEqual(readMainOverride(state, 'native-x'), { provider: 'ollama', model: 'glm-5.3-flash', thinking: 'max' });
  state = setMainLayerOverride({ state, profileKey: 'native-x', main: null });
  assert.equal(Object.hasOwn(state, 'native-x'), false);
  assert.equal(readMainOverride({ 'native-x': { provider: 'ollama', model: '', thinking: 'max' } }, 'native-x'), null);

  const profile = getProfile('gpt-deepseek');
  assert.deepEqual(resolveMainDefaults(profile, null), { provider: 'opencode-go', model: 'deepseek-v4-flash', thinking: 'max' });
  assert.deepEqual(resolveMainDefaults(profile, { 'native-gpt-deepseek': { provider: 'p', model: 'm', thinking: 'low' } }),
    { provider: 'p', model: 'm', thinking: 'low' });
});

test('settings defaults add and remove only the built-in Kimi chains', () => {
  const settings = { retry: { fallbackChains: { 'kimi-coding/k3': ['ollama/glm-5.3-flash'], 'x/y': ['keep'] } } };
  setMainDefaultsInSettings({
    settings, profile: getProfile('kimi-deepseek'), provider: 'kimi-coding', model: 'k3', thinking: 'max',
  });
  assert.deepEqual(settings.retry.fallbackChains['kimi-coding/k3'],
    ['ollama/glm-5.3-flash', 'ollama/glm-5.3', 'ollama/glm-5.2']);
  assert.deepEqual(settings.retry.fallbackChains['x/y'], ['keep']);

  const builtin = ['ollama/glm-5.3-flash', 'ollama/glm-5.3', 'ollama/glm-5.2'];
  const drop = { retry: { fallbackChains: { 'kimi-coding/k3': builtin } } };
  setMainDefaultsInSettings({
    settings: drop, profile: getProfile('gpt-deepseek'), provider: 'opencode-go', model: 'deepseek-v4-flash', thinking: 'max',
  });
  assert.equal(Object.hasOwn(drop, 'retry'), false);
});

test('summarizer rules, legacy removal and warnings', () => {
  const set = setCompactionSummarizer({
    settings: { compactionSummarizer: { provider: 'old', model: 'x' } }, modelId: 'opencode-go/deepseek-v4-flash',
  });
  assert.equal(set.settings.compaction.model, 'opencode-go/deepseek-v4-flash');
  assert.equal(Object.hasOwn(set.settings, 'compactionSummarizer'), false);
  assert.deepEqual(set.warnings, []);
  assert.deepEqual(readCompactionSummarizer(set.settings), { provider: 'opencode-go', model: 'deepseek-v4-flash' });

  const cleared = setCompactionSummarizer({ settings: { compaction: { model: 'a/b' } }, modelId: '' });
  assert.equal(Object.hasOwn(cleared.settings, 'compaction'), false);

  assert.equal(setCompactionSummarizer({ settings: {}, modelId: 'commandcode/muse-spark-1.3' }).warnings.length, 2);
  assert.match(setCompactionSummarizer({ settings: {}, modelId: 'commandcode/muse-spark-1.3' }).warnings[0].text, /Muse Spark/);
  assert.throws(() => setCompactionSummarizer({ settings: {}, modelId: 'bad' }), /요약 모델 ID가 올바르지 않습니다/);
});

test('CommandCode routing preflight warns only when the profile has no assignment', () => {
  const catalog = {
    'cmd-glm': { model: 'commandcode/z-ai/glm-5.3-flash' },
    'cmd-claude': { model: 'commandcode-anthropic/claude-opus-5' },
    plain: { model: 'openai/gpt-6-sol' },
  };
  const warning = '커맨드코드 모델이지만 구독이 배정되지 않았습니다 (기본 키로 동작)';
  assert.equal(commandCodeWarning({ catalog, alias: 'cmd-glm', registry: null, profileKey: 'native-cmd-glm-deepseek' }), warning);
  assert.equal(commandCodeWarning({ catalog, alias: 'cmd-claude', registry: { profileAssignments: {} }, profileKey: 'p' }), warning);
  assert.equal(commandCodeWarning({
    catalog, alias: 'cmd-glm', registry: { profileAssignments: { 'native-cmd-glm-deepseek': ' sub-1 ' } },
    profileKey: 'native-cmd-glm-deepseek',
  }), null);
  assert.equal(commandCodeWarning({ catalog, alias: 'plain', registry: { profileAssignments: {} }, profileKey: 'p' }), null);
  assert.equal(commandCodeWarning({}), null);
});

test('lane mirror plan is fail-closed for a missing root', () => {
  const plan = laneMirrorPlan([{ root: 'C:/missing', exists: false }, { root: 'C:/lane', exists: true }]);
  assert.equal(plan.contexts.length, 1);
  assert.equal(plan.contexts[0].backupDirectory, 'C:/lane/runtime/native-profile-switcher-backups');
  assert.deepEqual(plan.warnings, ['레인 미러 건너뜀 (레인 루트 없음): C:/missing']);
});

function stableFixture() {
  const models = { 'flash-high': { model: 'opencode-go/deepseek-v4-flash', variant: 'high' } };
  const layer = { agents: { explore: { model: 'flash-high' } }, categories: { quick: { model: 'flash-high' } } };
  return {
    source: {
      '[native]': { models: { ...models }, ...layer },
      profiles: { p: { '[native]': { agents: { ...layer.agents }, categories: { ...layer.categories } } } },
    },
    target: {
      '[native]': { models: {}, agents: {}, categories: {} },
      profiles: { p: { '[native]': { agents: {}, categories: {} } } },
    },
  };
}

test('stable-500 role sync copies aliases and rows, and refuses six drift classes', () => {
  const { source, target } = stableFixture();
  const ok = syncStable500RoleModels({ source, target, profileKey: 'p', switchProfile: true });
  assert.equal(ok.changed, true);
  assert.deepEqual(ok.config['[native]'].models['flash-high'], { model: 'opencode-go/deepseek-v4-flash', variant: 'high' });
  assert.deepEqual(ok.config['[native]'].agents.explore, { model: 'flash-high' });

  assert.throws(() => syncStable500RoleModels({ source, target, profileKey: 'missing', switchProfile: true }),
    /프로필 missing 이\(가\) 없습니다/);

  const both = stableFixture();
  both.source.profiles.p['[senpi]'] = {};
  assert.throws(() => syncStable500RoleModels({ ...both, profileKey: 'p', switchProfile: true }),
    /\[native\]와 \[senpi\] 레이어가 함께 있습니다/);

  const noCatalog = stableFixture();
  delete noCatalog.source['[native]'].models;
  assert.throws(() => syncStable500RoleModels({ ...noCatalog, profileKey: 'p', switchProfile: true }),
    /프로필 레이어 또는 모델 카탈로그가 없습니다/);

  const wrongActive = stableFixture();
  assert.throws(() => syncStable500RoleModels({ ...wrongActive, profileKey: 'p', selectionProfile: 'other' }),
    /현재 활성 프로필이 p 이\(가\) 아닙니다/);

  const noRows = stableFixture();
  delete noRows.source.profiles.p['[native]'].agents;
  assert.throws(() => syncStable500RoleModels({ ...noRows, profileKey: 'p', switchProfile: true }),
    /agents 행이 없습니다/);

  const badAlias = stableFixture();
  badAlias.source['[native]'].models['flash-high'] = { model: 'opencode-go/deepseek-v4-flash' };
  assert.throws(() => syncStable500RoleModels({ ...badAlias, profileKey: 'p', switchProfile: true }),
    /모델 별칭 flash-high 이\(가\) 유효하지 않습니다/);

  const collision = stableFixture();
  collision.target['[native]'].models['flash-high'] = { model: 'other/model', variant: 'high' };
  assert.throws(() => syncStable500RoleModels({ ...collision, profileKey: 'p', switchProfile: true }),
    /모델 별칭 flash-high 이\(가\) 다른 모델을 가리킵니다/);

  const undefinedPreset = stableFixture();
  undefinedPreset.source['[native]'].model_profile = 'custom-preset';
  assert.throws(() => syncStable500RoleModels({ ...undefinedPreset, profileKey: 'p', switchProfile: true }),
    /model_profile custom-preset 이\(가\) stable-500에 정의돼 있지 않습니다/);
});

test('owned memory rows survive the active-scope merge', () => {
  const config = configFixture();
  config['[native]'].models['mem-alias'] = { model: 'p/mem', reasoning: 'high' };
  config['[native]'].categories['quick'] = { model: 'mem-alias' };
  config['[native]'].categories['desktop-kibitzer'] = {
    description: memoryFingerprint('mem-alias', 'p/mem', 'high'), model: 'mem-alias', reasoning: 'high',
  };
  config.profiles['native-gpt-kimi-deepseek']['[native]'].categories['quick'] = { model: 'flash-high' };
  assert.throws(() => assertMemoryProfilePreservation(config, 'native-gpt-kimi-deepseek'),
    /Profile overlay conflicts with common Kibitzer/);

  config.profiles['native-gpt-kimi-deepseek']['[native]'].categories['quick'] = { model: 'mem-alias' };
  const row = assertMemoryProfilePreservation(config, 'native-gpt-kimi-deepseek');
  assert.deepEqual(row.model, 'mem-alias');
  mergeProfileLayerIntoActiveScopes({ config, profile: getProfile('gpt-kimi-deepseek') });
  assert.deepEqual(config['[native]'].categories['desktop-kibitzer'], row);
});

test('intent.main writes the main sidecar with the stored provider/model/thinking shape', () => {
  const result = runScenario({
    files: dumpFiles,
    scenario: { mode: 'ApplyIntentPath.Apply', profileKey: 'gpt-kimi-deepseek' },
    intent: {
      schema: 1, profileKey: 'gpt-kimi-deepseek', activate: false, routing: [],
      main: { provider: 'ignored', model: 'ollama/glm-5.3-flash', reasoning: 'high' },
    },
  });
  assert.deepEqual(result.files['primary/main-override.json']['native-gpt-kimi-deepseek'], {
    provider: 'ollama', model: 'glm-5.3-flash', thinking: 'high',
  });
  assert.equal(result.backups.primary.length, 2);
  assert.throws(() => runScenario({
    files: dumpFiles,
    scenario: { mode: 'ApplyIntentPath.Apply', profileKey: 'gpt-kimi-deepseek' },
    intent: { schema: 1, profileKey: 'gpt-kimi-deepseek', activate: false, routing: [], memoryModel: { mode: 'quick' } },
  }), /not part of the pure merge port/);
});

test('selection state and ollama provider text transform are exact', () => {
  assert.deepEqual(selectionState(getProfile('kimi-deepseek'), '2026-10-20T00:00:00.0000000+00:00'), {
    key: 'kimi-deepseek', profile: 'native-kimi-deepseek', appliedAt: '2026-10-20T00:00:00.0000000+00:00',
  });
  const result = ensureOllamaCloudProviderText(OPENCODE_SEED);
  assert.equal(result.changed, true);
  assert.notEqual(result.text, OPENCODE_SEED);
  assert.match(result.text, /"apiKey":  "\{env:OLLAMA_API_KEY\}"/);
  assert.equal(withBomHash(result.text), '92ff77f3c1e7c4bbf457a4ed4165b86daa69cb669fa6e061279100925bc04cbf');
  const again = ensureOllamaCloudProviderText(result.text);
  assert.equal(again.changed, false);
});

test('expandLayerRoles keeps inherited categories and unresolved aliases visible', () => {
  const catalog = catalogFixture();
  const rows = expandLayerRoles({
    catalog,
    layer: {
      agents: { explore: { model: 'flash-high' }, 'omo-native-code-reviewer': {}, oracle: { model: 'ghost' } },
      categories: { 'unspecified-high': { model: 'kimi-max' } },
    },
  });
  const explore = rows.find((row) => row.Section === 'agents' && row.Role === 'explore');
  assert.equal(explore.ModelKey, 'flash-high');
  assert.equal(explore.Variant, 'high');
  const reviewer = rows.find((row) => row.Role === 'omo-native-code-reviewer');
  assert.equal(reviewer.EffectiveAlias, 'kimi-max');
  assert.equal(reviewer.EffectiveCategory, 'unspecified-high');
  const oracle = rows.find((row) => row.Role === 'oracle');
  assert.equal(oracle.Unresolved, true);
  assert.equal(oracle.ModelEn, '[unknown:ghost]');
  assert.equal(PROFILE_META.length, 6);
});

test('memory: a foreign desktop-kibitzer category is refused before any write', () => {
  const config = configFixture();
  config['[native]'].categories['desktop-kibitzer'] = { model: 'foreign/model' };
  assert.throws(
    () => assertMemoryRouteWritable(config, '', 'kibitzer'),
    /Kibitzer category collision \/ foreign recall route/
  );
  config['[native]'].categories['desktop-reflection'] = { model: 'foreign/model' };
  assert.throws(
    () => assertMemoryRouteWritable(config, '', 'reflection'),
    /Reflection category collision \/ foreign reflection route/
  );
});

test('assertMemoryRouteWritable permits owned memory categories', () => {
  const config = configFixture();
  config['[native]'].models['mem-alias'] = { model: 'openai/gpt-6-sol', reasoning: 'high' };
  config['[native]'].categories['desktop-kibitzer'] = {
    description: memoryFingerprint('mem-alias', 'openai/gpt-6-sol', 'high'),
    model: 'mem-alias',
    reasoning: 'high',
  };
  const state = assertMemoryRouteWritable(config, '', 'kibitzer');
  assert.equal(state.owned, true);
  assert.equal(state.external, false);
});
