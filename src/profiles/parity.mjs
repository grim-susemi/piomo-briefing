// Pure scenario driver for the todo-3 goldens. Composes the ported merge layer exactly in the
// order the switcher CLI runs it, but performs no I/O: inputs are parsed JSON values, outputs are
// the resulting values plus the backup ledger (which file was backed up, under which name).
import {
  clone, deepEqual, ensureOllamaCloudProviderText, getOrCreateCatalogAlias, isPlainObject,
  mergeProfileLayerIntoActiveScopes, readConfig, removeNullModelProfile, resolveMainDefaults,
  selectionState, setCompactionSummarizer, setMainDefaultsInSettings, setMainLayerOverride,
  setModelProfileSelection, setProfileLayerModel, syncStable500RoleModels,
} from './merge.mjs';
import { expandLayerRoles, getModelIdWithoutProvider, getProfile, getProviderFromModelId } from './model.mjs';

const PRIMARY = 'primary/omo.jsonc';
const PRIMARY_SETTINGS = 'primary/settings.json';
const STABLE = 'stable/omo.jsonc';
const STABLE_SETTINGS = 'stable/settings.json';
const SELECTION_KEYS = ['primary/selection.json', 'primary/agent-selection.json', 'primary/runtime-selection.json'];

function stamp(clock, key, fallback) {
  return clock?.[key] ?? fallback;
}

function backupPair(dir, stampValue) {
  return [
    { name: `omo-${stampValue}.jsonc`, preimage: dir === 'primary' ? PRIMARY : STABLE },
    { name: `senpi-settings-${stampValue}.json`, preimage: dir === 'primary' ? PRIMARY_SETTINGS : STABLE_SETTINGS },
  ];
}

function engineOf(config) {
  return config['[senpi]'] ?? config['[native]'];
}

function profileLayer(config, omoProfile) {
  const profile = config.profiles?.[omoProfile];
  return profile?.['[senpi]'] ?? profile?.['[native]'] ?? null;
}

function assertProfileExists(config, profile) {
  assertProfileLayer(config, profile);
}

function assertProfileLayer(config, profile) {
  if (!isPlainObject(config?.profiles) || !isPlainObject(config.profiles[profile.omoProfile])) {
    throw new Error(`프로필 ${profile.omoProfile} 레이어를 찾을 수 없습니다.`);
  }
  if (!isPlainObject(profileLayer(config, profile.omoProfile))) {
    throw new Error(`프로필 ${profile.omoProfile} 레이어를 찾을 수 없습니다.`);
  }
}

function saveConfig(config) {
  const snapshot = clone(config);
  // Write-OmoConfigFile: strip the shared '[senpi]' alias, then drop null model_profile keys.
  const containers = [snapshot, ...Object.values(snapshot.profiles ?? {})];
  for (const container of containers) {
    if (!isPlainObject(container)) continue;
    const native = container['[native]'];
    const senpi = container['[senpi]'];
    if (native !== undefined && senpi !== undefined && (senpi === native || deepEqual(senpi, native))) delete container['[senpi]'];
  }
  removeNullModelProfile(snapshot);
  return snapshot;
}

function sortedBackups(backups) {
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { primary: [...backups.primary].sort(byName), stable: [...backups.stable].sort(byName) };
}

export function runScenario({ files, scenario, intent = null, clock = {}, rawOpenCode = null }) {
  const input = clone(files);
  const output = { files: clone(files), backups: { primary: [], stable: [] }, warnings: [], rawOpenCode: rawOpenCode ?? null };
  const mode = scenario?.mode ?? 'Apply';
  if (mode === 'DumpState' || mode === 'PrintStatus' || mode === 'RecommendationStatus') return output;
  if (mode === 'ApplyIntentPath.DryRun') return output;

  const profile = getProfile(intent?.profileKey ?? scenario?.profileKey);
  if (!profile) throw new Error('unknown profile');

  if (mode === 'ApplyIntentPath.Apply') {
    applyIntent({ input, output, profile, intent, clock });
    output.backups = sortedBackups(output.backups);
    return output;
  }
  if (mode === 'Apply') {
    applyProfile({ input, output, profile, clock });
    output.backups = sortedBackups(output.backups);
    return output;
  }
  throw new Error(`unsupported scenario mode: ${mode}`);
}

function backupPrimary(output, clock) {
  const stampValue = stamp(clock, 'primaryStamp', '20000101-000000-000');
  output.backups.primary.push(...backupPair('primary', stampValue));
  return stampValue;
}

function backupStable(output, clock) {
  const stampValue = stamp(clock, 'stableStamp', '20000101-000000-000');
  output.backups.stable.push(...backupPair('stable', stampValue));
  return stampValue;
}

function applyProfile({ input, output, profile, clock }) {
  const config = readConfig(input[PRIMARY]);
  const settings = clone(input[PRIMARY_SETTINGS]);
  assertProfileExists(config, profile);

  // Preflight (Sync-Stable500RoleModels -ValidateOnly) before any write.
  const stableRaw = clone(input[STABLE]);
  const mainDefaults = resolveMainDefaults(profile, input['primary/main-override.json'] ?? null);
  const stablePreflight = input[STABLE]
    ? syncStableSource(clone(input[PRIMARY]), stableRaw, profile, true)
    : null;
  void stablePreflight;

  backupPrimary(output, clock);
  mergeProfileLayerIntoActiveScopes({ config, profile });
  setMainDefaultsInSettings({ settings, profile, provider: mainDefaults.provider, model: mainDefaults.model, thinking: mainDefaults.thinking });
  output.files[PRIMARY] = saveConfig(config);
  output.files[PRIMARY_SETTINGS] = settings;
  const primarySelection = selectionState(profile, stamp(clock, 'primaryAppliedAt', '2000-01-01T00:00:00.0000000+00:00'));
  for (const key of SELECTION_KEYS) output.files[key] = clone(primarySelection);

  if (input[STABLE]) {
    backupStable(output, clock);
    const synced = syncStableSource(output.files[PRIMARY], stableRaw, profile, true);
    if (synced.changed) {
      const roleStamp = stamp(clock, 'roleMirrorStamp', '20000101-000000-000');
      const roleGuid = stamp(clock, 'roleMirrorGuid', '00000000000000000000000000000000');
      output.backups.stable.push({ name: `omo-role-mirror-${roleStamp}-${roleGuid}.jsonc`, preimage: STABLE });
      output.files[STABLE] = synced.config;
    }
    const stableSettings = clone(input[STABLE_SETTINGS]);
    setMainDefaultsInSettings({ settings: stableSettings, profile, provider: mainDefaults.provider, model: mainDefaults.model, thinking: mainDefaults.thinking });
    output.files[STABLE_SETTINGS] = stableSettings;
    output.files['stable/selection.json'] = selectionState(profile, stamp(clock, 'stableAppliedAt', '2000-01-01T00:00:00.0000000+00:00'));
  }

  const effectiveProvider = mainDefaults.provider;
  if (effectiveProvider === 'ollama' || profile.key.includes('ollama')) {
    // Ensure-OllamaCloudProvider is a text transform; the caller owns the raw file.
    if (typeof output.rawOpenCode === 'string') {
      const result = ensureOllamaCloudProviderText(output.rawOpenCode);
      output.rawOpenCode = result.text;
      output.warnings.push(...result.warnings);
    }
  }
  output.profile = profile.key;
}

function syncStableSource(sourceConfig, targetConfig, profile, switchProfile) {
  return syncStable500RoleModels({
    source: sourceConfig, target: targetConfig, profileKey: profile.omoProfile,
    selectionProfile: null, switchProfile,
  });
}

function applyIntent({ input, output, profile, intent, clock }) {
  const config = readConfig(input[PRIMARY]);
  assertProfileExists(config, profile);
  const catalog = engineOf(config)?.models;
  if (!isPlainObject(catalog)) throw new Error('모델 카탈로그를 찾을 수 없습니다.');
  const layer = profileLayer(config, profile.omoProfile);
  const routeRows = expandLayerRoles({ catalog, layer });

  const pendingRouting = [];
  for (const entry of Array.isArray(intent?.routing) ? intent.routing : []) {
    if (!['agents', 'categories'].includes(entry.section)) throw new Error('Invalid routing section.');
    for (const name of ['role', 'provider', 'model', 'reasoning']) {
      if (!String(entry[name] ?? '').trim()) throw new Error('Incomplete routing entry.');
    }
    const provider = String(entry.model).trim() ? getProviderFromModelId(entry.model) : entry.provider;
    const matches = routeRows.filter((row) => row.Section === entry.section && row.Role === entry.role);
    if (matches.length !== 1) throw new Error('Unknown intent routing row.');
    const route = matches[0];
    const resolution = getOrCreateCatalogAlias({
      catalog, provider, model: entry.model, reasoning: entry.reasoning, preferredAlias: route.ModelKey,
    });
    const alias = resolution.alias;
    if (alias === String(route.ModelKey) && !route.Unresolved) continue;
    pendingRouting.push({ section: entry.section, role: entry.role, alias, provider, model: entry.model, reasoning: entry.reasoning });
    if (!isPlainObject(catalog[alias])) catalog[alias] = { model: entry.model, variant: entry.reasoning };
    route.ModelKey = alias;
    route.Unresolved = false;
  }

  // 1) routing rows -> Set-ProfileLayerModel (each write backs up)
  for (const entry of pendingRouting) {
    backupPrimary(output, clock);
    setProfileLayerModel({
      config, profileKey: profile.omoProfile, section: entry.section, role: entry.role,
      alias: entry.alias, ensureCatalogAlias: true, ensureModelId: entry.model, ensureVariant: entry.reasoning,
    });
    output.files[PRIMARY] = saveConfig(config);
  }

  // 2) main model sidecar -> Set-MainLayerOverride (shape: provider/model/thinking)
  if (isPlainObject(intent?.main)) {
    const model = String(intent.main.model ?? '');
    const thinking = String(intent.main.reasoning ?? intent.main.thinking ?? '');
    const provider = model ? getProviderFromModelId(model) : String(intent.main.provider ?? '');
    const main = provider && model && thinking
      ? { provider, model: getModelIdWithoutProvider(model), thinking }
      : null;
    backupPrimary(output, clock);
    output.files['primary/main-override.json'] = setMainLayerOverride({
      state: input['primary/main-override.json'] ?? {},
      profileKey: profile.omoProfile,
      main,
    });
  }
  for (const field of ['memoryModel', 'reflectionMemoryModel']) {
    if (intent && Object.hasOwn(intent, field)) {
      throw new Error(`${field} is not part of the pure merge port; the board store owns those writes`);
    }
  }

  // 3) model_profile
  if (isPlainObject(intent?.modelProfile)) {
    backupPrimary(output, clock);
    setModelProfileSelection({
      config, omoProfile: profile.omoProfile,
      selection: String(intent.modelProfile.selection ?? ''),
      literal: String(intent.modelProfile.literal ?? ''),
    });
    output.files[PRIMARY] = saveConfig(config);
  }

  // 4) summarizer model (+ stable-500 settings mirror)
  if (Object.hasOwn(intent ?? {}, 'summarizer')) {
    backupPrimary(output, clock);
    const primary = setCompactionSummarizer({ settings: clone(input[PRIMARY_SETTINGS]), modelId: String(intent.summarizer ?? '') });
    output.files[PRIMARY_SETTINGS] = primary.settings;
    output.warnings.push(...primary.warnings.map((item) => item.text));
    if (input[STABLE_SETTINGS]) {
      backupStable(output, clock);
      const stable = setCompactionSummarizer({ settings: clone(input[STABLE_SETTINGS]), modelId: String(intent.summarizer ?? '') });
      output.files[STABLE_SETTINGS] = stable.settings;
    }
  }

  if (intent?.activate) applyProfile({ input: output.files, output, profile, clock });
  output.profile = profile.key;
}
