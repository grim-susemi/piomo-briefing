// Pure port of the switcher's merge/validation layer (OMO_Native_Profile_Switcher.ps1):
// catalog alias get-or-create / resolve / assert (:1440-1498, :2096),
// Set-ProfileLayerModel validation order (:2217-2232),
// Merge-ProfileLayerIntoActiveScopes with owned memory rows (:2869-2895, :3116-3222),
// Merge-ModelProfileSettings + Remove-NullModelProfile (:1299-1316, :2368),
// custom-literal check (:2405), main sidecar shape (:2296-2342),
// summarizer rules and warnings (:2673-2840), lane-mirror rules (:2061-2094),
// stable-500 role-sync refusals (:2898-2957), reviewer-key migration (:1333).
// No DOM and no file I/O: callers own every read, write, backup and atomic replace.
import { createHash } from 'node:crypto';
import {
  BUILTIN_MODEL_PROFILES, ROLE_INVENTORY, canonicalAgentRole, getMemoryReasoning,
  getProfile, getProviderFromModelId, testReasoningLevelSupported,
} from './model.mjs';

export const ENGINE_SECTIONS = ['[native]', '[senpi]'];

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && deepEqual(a[key], b[key]));
}

// ── engine section alias (Read-JsonFile aliases [native] as [senpi]; save strips it) ──
function configContainers(config) {
  const containers = [config];
  if (isPlainObject(config?.profiles)) containers.push(...Object.values(config.profiles));
  return containers.filter(isPlainObject);
}

export function normalizeEngineSection(config) {
  if (!isPlainObject(config)) return config;
  for (const container of configContainers(config)) {
    const native = container['[native]'];
    const senpi = container['[senpi]'];
    if (native !== undefined && native !== null && senpi === undefined) container['[senpi]'] = native;
  }
  return config;
}

export function stripEngineSectionAlias(config) {
  if (!isPlainObject(config)) return config;
  for (const container of configContainers(config)) {
    const native = container['[native]'];
    const senpi = container['[senpi]'];
    if (native !== undefined && senpi !== undefined && (senpi === native || deepEqual(senpi, native))) {
      delete container['[senpi]'];
    }
  }
  return config;
}

const LEGACY_AGENT_KEYS = [['metis', 'plan-consultant'], ['momus', 'plan-reviewer']];

function syncAgentAliases(layer) {
  if (!isPlainObject(layer?.agents)) return layer;
  for (const [legacy, canonical] of LEGACY_AGENT_KEYS) {
    if (!Object.hasOwn(layer.agents, legacy) && !Object.hasOwn(layer.agents, canonical)) continue;
    const value = Object.hasOwn(layer.agents, canonical) ? layer.agents[canonical] : layer.agents[legacy];
    layer.agents[canonical] = value;
    delete layer.agents[legacy];
  }
  return layer;
}

export function syncSenpiConfigAliases(config) {
  if (!isPlainObject(config)) return config;
  for (const container of configContainers(config)) {
    syncAgentAliases(container);
    if (isPlainObject(container['[senpi]'])) syncAgentAliases(container['[senpi]']);
  }
  return config;
}

// Read-JsonFile: engine alias + legacy role names, in that order.
export function readConfig(config) {
  const value = clone(config);
  normalizeEngineSection(value);
  syncSenpiConfigAliases(value);
  return value;
}

// ── catalog aliases ─────────────────────────────────────────────────────────────
function catalogEntries(catalog) {
  return Object.entries(catalog ?? {}).filter(([, entry]) => isPlainObject(entry) && String(entry.model ?? '').trim());
}

export function assertCatalogAlias(catalog, alias) {
  const entry = catalog?.[alias];
  if (!isPlainObject(entry)) throw new Error(`알 수 없는 모델 별칭: ${alias}`);
  if (!String(entry.model ?? '').trim()) throw new Error(`모델 별칭 ${alias} 의 model 값이 비어 있습니다.`);
  return true;
}

export function testCatalogAlias(catalog, alias) {
  const entry = catalog?.[alias];
  return isPlainObject(entry) && Boolean(String(entry.model ?? '').trim());
}

function matchingAliases(catalog, provider, model, reasoning) {
  return catalogEntries(catalog)
    .filter(([, entry]) => getProviderFromModelId(entry.model) === provider &&
      entry.model === model && getMemoryReasoning(entry) === reasoning)
    .map(([alias]) => alias);
}

export function resolveCatalogRouteAlias({ catalog, provider, model, reasoning, preferredAlias = '' }) {
  const matches = matchingAliases(catalog, provider, model, reasoning);
  if (matches.length === 0) throw new Error('선택한 서비스/모델/추론 조합에 해당하는 카탈로그 별칭이 없습니다.');
  if (preferredAlias && matches.includes(preferredAlias)) return preferredAlias;
  for (const canonical of ['flash-high', 'glm-ollama-max']) if (matches.includes(canonical)) return canonical;
  return [...matches].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0];
}

const LEVEL_SUFFIXES = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function slugifyModel(model) {
  return model.split('/').at(-1).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
}

export function getOrCreateCatalogAlias({ catalog, provider, model, reasoning, preferredAlias = '' }) {
  const matches = matchingAliases(catalog, provider, model, reasoning);
  if (matches.length > 0) {
    return { alias: preferredAlias && matches.includes(preferredAlias) ? preferredAlias : matches[0], existed: true };
  }
  let stem = '';
  for (const [alias, entry] of Object.entries(catalog ?? {})) {
    if (!isPlainObject(entry) || entry.model !== model) continue;
    stem = alias;
    for (const level of LEVEL_SUFFIXES) {
      if (alias.endsWith(`-${level}`)) { stem = alias.slice(0, alias.length - level.length - 1); break; }
    }
    break;
  }
  if (!stem) {
    const prefix = provider === 'opencode' ? 'zen-'
      : provider === 'commandcode' || provider === 'commandcode-anthropic' ? 'cmd-'
        : `${provider.replace(/[^a-z0-9]/g, '-')}-`;
    stem = prefix + slugifyModel(model);
  }
  return { alias: `${stem}-${reasoning}`, existed: false };
}

// ── Set-ProfileLayerModel (:2217-2232) ──────────────────────────────────────────
// Validation order is load-bearing (fail-closed before any backup/write):
// profile -> layer -> catalog -> alias/variant -> section -> role -> model write.
export function setProfileLayerModel({
  config, profileKey, section, role, alias,
  ensureCatalogAlias = false, ensureModelId = '', ensureVariant = '', modelReasoning = {},
}) {
  if (!isPlainObject(config?.profiles)) throw new Error(`프로필 ${profileKey} 레이어를 찾을 수 없습니다.`);
  const profile = config.profiles[profileKey];
  if (!isPlainObject(profile)) throw new Error(`프로필 ${profileKey} 레이어를 찾을 수 없습니다.`);
  const layer = profile['[senpi]'] ?? profile['[native]'];
  if (!isPlainObject(layer)) throw new Error(`프로필 ${profileKey} 레이어를 찾을 수 없습니다.`);
  const catalog = (config['[senpi]'] ?? config['[native]'])?.models;
  if (!isPlainObject(catalog)) throw new Error('모델 카탈로그를 찾을 수 없습니다.');

  let createdAlias = false;
  if (ensureCatalogAlias) {
    const existing = catalog[alias];
    if (isPlainObject(existing)) {
      ensureModelId = String(existing.model ?? '');
      ensureVariant = getMemoryReasoning(existing);
    }
    if (!String(ensureModelId ?? '').trim() || !String(ensureVariant ?? '').trim()) {
      throw new Error(`별칭 ${alias} 생성에 필요한 모델/강도 정보가 없습니다.`);
    }
    const reasoningFlag = Object.hasOwn(modelReasoning, ensureModelId) ? Boolean(modelReasoning[ensureModelId]) : true;
    if (!testReasoningLevelSupported(ensureModelId, ensureVariant, reasoningFlag)) {
      throw new Error(`모델 ${ensureModelId} 이(가) 지원하지 않는 추론 강도입니다: ${ensureVariant}`);
    }
    if (!isPlainObject(existing)) {
      catalog[alias] = { model: ensureModelId, variant: ensureVariant };
      createdAlias = true;
    }
  } else {
    assertCatalogAlias(catalog, alias);
  }

  const rows = layer[section];
  if (!isPlainObject(rows)) throw new Error(`역할 ${role}이(가) ${section}에 없습니다.`);
  if (section === 'agents') role = canonicalAgentRole(role);
  if (!Object.hasOwn(rows, role) && (ROLE_INVENTORY[section] ?? []).includes(role)) rows[role] = { model: alias };
  if (!Object.hasOwn(rows, role)) throw new Error(`역할 ${role}이(가) ${section}에 없습니다.`);
  if (!isPlainObject(rows[role])) rows[role] = {};
  rows[role].model = alias;
  return { config, catalog, layer, createdAlias };
}

// ── model_profile settings ──────────────────────────────────────────────────────
export function mergeModelProfileSettings(active, selected) {
  if (!isPlainObject(active) || !isPlainObject(selected)) return active;
  if (isPlainObject(selected.model_profiles)) {
    if (!isPlainObject(active.model_profiles)) active.model_profiles = {};
    for (const [name, value] of Object.entries(selected.model_profiles)) active.model_profiles[name] = value;
  }
  if (Object.hasOwn(selected, 'model_profile')) active.model_profile = selected.model_profile;
  return active;
}

export function getModelProfileSettings(config, omoProfile = '') {
  const result = { model_profile: null, model_profiles: {} };
  mergeModelProfileSettings(result, config);
  mergeModelProfileSettings(result, config?.['[senpi]'] ?? config?.['[native]']);
  if (omoProfile) {
    const overlay = config?.profiles?.[omoProfile];
    mergeModelProfileSettings(result, overlay);
    mergeModelProfileSettings(result, overlay?.['[senpi]'] ?? overlay?.['[native]']);
  }
  return result;
}

export function removeNullModelProfile(config) {
  if (!isPlainObject(config)) return config;
  const scopes = [config];
  if (isPlainObject(config['[native]'])) scopes.push(config['[native]']);
  for (const profile of Object.values(config.profiles ?? {})) {
    if (!isPlainObject(profile)) continue;
    scopes.push(profile);
    if (isPlainObject(profile['[native]'])) scopes.push(profile['[native]']);
  }
  for (const scope of scopes) if (Object.hasOwn(scope, 'model_profile') && scope.model_profile === null) delete scope.model_profile;
  return config;
}

export function validateCustomLiteral(literal) {
  const value = String(literal ?? '').trim();
  if (!/^[^/\s]+\/[^\s]+$/.test(value)) throw new Error('Use a provider/model literal.');
  return value;
}

export function setModelProfileSelection({ config, omoProfile, selection, literal = '' }) {
  let value = selection;
  if (selection === 'custom-literal') {
    value = validateCustomLiteral(literal);
  } else if (String(selection ?? '').trim() === '' || selection === 'off') {
    value = null;
  } else if (!Object.hasOwn(BUILTIN_MODEL_PROFILES, selection)) {
    const known = getModelProfileSettings(config, omoProfile);
    if (!Object.hasOwn(known.model_profiles, selection)) throw new Error(`Unknown model profile: ${selection}`);
  }
  const profile = config.profiles?.[omoProfile];
  if (!isPlainObject(profile)) throw new Error(`프로필 ${omoProfile} 레이어를 찾을 수 없습니다.`);
  for (const scope of [profile, profile['[senpi]'] ?? profile['[native]']]) {
    if (isPlainObject(scope)) scope.model_profile = value;
  }
  if (value === null) {
    config.model_profile = null;
    const engine = config['[senpi]'] ?? config['[native]'];
    if (isPlainObject(engine)) engine.model_profile = null;
  }
  return config;
}

// ── main model sidecar (:2296-2342) ────────────────────────────────────────────
export function setMainLayerOverride({ state, profileKey, main }) {
  const next = clone(state ?? {});
  if (main === null || main === undefined) delete next[profileKey];
  else next[profileKey] = clone(main);
  return next;
}

export function readMainOverride(state, profileKey) {
  const main = state?.[profileKey];
  if (!isPlainObject(main)) return null;
  const provider = String(main.provider ?? '');
  const model = String(main.model ?? '');
  const thinking = String(main.thinking ?? '');
  if (!provider.trim() || !model.trim() || !thinking.trim()) return null;
  return { provider, model, thinking };
}

export function resolveMainDefaults(profile, mainOverrideState = null) {
  const override = readMainOverride(mainOverrideState, profile.omoProfile);
  if (override) return override;
  return { provider: profile.mainProvider, model: profile.mainModel, thinking: profile.mainThinking };
}

export function setMainDefaultsInSettings({ settings, profile, provider, model, thinking }) {
  settings.defaultProvider = provider;
  settings.defaultModel = model;
  settings.defaultThinkingLevel = thinking;
  if (profile.fallbackChains) {
    if (!isPlainObject(settings.retry)) settings.retry = {};
    if (!isPlainObject(settings.retry.fallbackChains)) settings.retry.fallbackChains = {};
    for (const [key, builtin] of Object.entries(profile.fallbackChains)) {
      const existing = settings.retry.fallbackChains[key];
      const chain = [...builtin];
      if (Array.isArray(existing)) {
        for (const item of existing) if (!chain.includes(item)) chain.push(item);
      }
      settings.retry.fallbackChains[key] = chain;
    }
  } else if (isPlainObject(settings.retry)) {
    if (isPlainObject(settings.retry.fallbackChains)) {
      for (const meta of [getProfile('gpt-kimi-deepseek'), getProfile('kimi-deepseek'), getProfile('kimi-ollama-deepseek')]) {
        for (const [key, builtin] of Object.entries(meta?.fallbackChains ?? {})) {
          const existing = settings.retry.fallbackChains[key];
          if (Array.isArray(existing) && deepEqual(existing, builtin)) delete settings.retry.fallbackChains[key];
        }
      }
      if (Object.keys(settings.retry.fallbackChains).length === 0) delete settings.retry.fallbackChains;
    }
    if (Object.keys(settings.retry).length === 0) delete settings.retry;
  }
  return settings;
}

export function selectionState(profile, appliedAt) {
  return { key: profile.key, profile: profile.omoProfile, appliedAt };
}

// ── owned memory rows (:3116-3222) ─────────────────────────────────────────────
function mergeMemoryObject(target, layer) {
  for (const [key, value] of Object.entries(layer ?? {})) {
    const old = target[key];
    if (isPlainObject(old) && isPlainObject(value)) mergeMemoryObject(old, value);
    else target[key] = clone(value);
  }
  return target;
}

export function getMemoryEffectiveConfig(config, profileKey = '') {
  const view = {};
  const layers = [config];
  const engine = config?.['[native]'];
  if (isPlainObject(engine)) layers.push(engine);
  if (profileKey && isPlainObject(config?.profiles?.[profileKey])) {
    layers.push(config.profiles[profileKey]);
    const overlayEngine = config.profiles[profileKey]['[native]'];
    if (isPlainObject(overlayEngine)) layers.push(overlayEngine);
  }
  for (const layer of layers) {
    for (const field of ['models', 'categories', 'memory']) {
      if (!isPlainObject(layer?.[field])) continue;
      if (!isPlainObject(view[field])) view[field] = {};
      mergeMemoryObject(view[field], layer[field]);
    }
  }
  return view;
}

export function getEffectiveMemoryCatalog(config) {
  const view = getMemoryEffectiveConfig(config);
  const catalog = {};
  for (const [alias, entry] of Object.entries(config?.['[native]']?.models ?? {})) catalog[alias] = clone(entry);
  for (const [alias, entry] of Object.entries(view.models ?? {})) catalog[alias] = clone(entry);
  return catalog;
}

function fingerprint(prefix, alias, model, reasoning) {
  const digest = createHash('sha256').update(JSON.stringify([alias, model, reasoning]), 'utf8').digest('hex');
  return `omo-native-profile-switcher:${prefix}:2:${digest}`;
}

export function memoryFingerprint(alias, model, reasoning) {
  return fingerprint('kibitzer', alias, model, reasoning);
}

export function reflectionMemoryFingerprint(alias, model, reasoning) {
  return fingerprint('reflection', alias, model, reasoning);
}

function memorySelection({ config, profileKey = '', dedicatedName, pointerField, prefix, allowedCategories }) {
  const view = getMemoryEffectiveConfig(config, profileKey);
  let category = 'quick';
  const pointer = view.memory?.[pointerField]?.category;
  if (pointer) category = String(pointer);
  const catalog = getEffectiveMemoryCatalog(config);
  const row = view.categories?.[category];
  const dedicated = view.categories?.[dedicatedName];
  let owned = false;
  if (isPlainObject(dedicated) && Object.keys(dedicated).length === 3 &&
      Object.hasOwn(dedicated, 'description') && Object.hasOwn(dedicated, 'model') &&
      Object.hasOwn(dedicated, 'reasoning')) {
    const alias = String(dedicated.model);
    const entry = catalog[alias];
    if (entry?.model && String(entry.reasoning) === String(dedicated.reasoning)) {
      owned = String(dedicated.description) === fingerprint(prefix, alias, entry.model, entry.reasoning);
    }
  }
  let alias = '';
  let model = '';
  let reasoning = '';
  if (isPlainObject(row) && Object.hasOwn(row, 'model')) {
    alias = String(row.model);
    const entry = catalog[alias];
    model = entry ? String(entry.model ?? '') : (alias.includes('/') ? alias : '');
    reasoning = getMemoryReasoning(row) || (entry ? String(entry.reasoning ?? '') : '');
  }
  const external = !allowedCategories.includes(category) || (dedicated !== undefined && !owned);
  return {
    mode: category === 'quick' ? 'quick' : 'custom', category, alias, model, reasoning, owned,
    external, unresolved: !model, hasDedicated: dedicated !== undefined,
  };
}

export function getMemorySelectionFromConfig(config, profileKey = '') {
  return memorySelection({
    config, profileKey, dedicatedName: 'desktop-kibitzer', pointerField: 'recall',
    prefix: 'kibitzer', allowedCategories: ['quick', 'desktop-kibitzer'],
  });
}

export function getReflectionMemorySelectionFromConfig(config, profileKey = '') {
  return memorySelection({
    config, profileKey, dedicatedName: 'desktop-reflection', pointerField: 'reflection',
    prefix: 'reflection', allowedCategories: ['quick', 'desktop-reflection'],
  });
}

export function assertMemoryRouteWritable(config, profileKey, kind) {
  const state = kind === 'reflection'
    ? getReflectionMemorySelectionFromConfig(config, profileKey)
    : getMemorySelectionFromConfig(config, profileKey);
  if (kind === 'reflection') {
    if (state.external || (state.category === 'desktop-reflection' && !state.owned)) {
      throw new Error(`Reflection category collision / foreign reflection route: ${profileKey}`);
    }
  } else if (state.external || (state.category === 'desktop-kibitzer' && !state.owned)) {
    throw new Error(`Kibitzer category collision / foreign recall route: ${profileKey}`);
  }
  return state;
}

function ownedRow(config, profileKey, kind) {
  const read = kind === 'reflection' ? getReflectionMemorySelectionFromConfig : getMemorySelectionFromConfig;
  const state = read(config);
  const dedicatedName = kind === 'reflection' ? 'desktop-reflection' : 'desktop-kibitzer';
  if (!state.hasDedicated && state.category !== dedicatedName) return null;
  assertMemoryRouteWritable(config, profileKey, kind);
  const selected = read(config, profileKey);
  if (!selected.owned || selected.category !== state.category ||
      selected.model !== state.model || selected.reasoning !== state.reasoning) {
    throw new Error(`Profile overlay conflicts with common ${kind === 'reflection' ? 'Reflection' : 'Kibitzer'}: ${profileKey}`);
  }
  const row = config?.['[native]']?.categories?.[dedicatedName];
  if (row === undefined) throw new Error(`Common ${kind === 'reflection' ? 'Reflection' : 'Kibitzer'} category is not owned in the native layer.`);
  return clone(row);
}

export function assertMemoryProfilePreservation(config, profileKey) {
  return ownedRow(config, profileKey, 'kibitzer');
}

export function assertReflectionMemoryProfilePreservation(config, profileKey) {
  return ownedRow(config, profileKey, 'reflection');
}

// ── Merge-ProfileLayerIntoActiveScopes (:2869-2895) ────────────────────────────
export function mergeProfileLayerIntoActiveScopes({ config, profile }) {
  const owned = assertMemoryProfilePreservation(config, profile.omoProfile);
  const reflectionOwned = assertReflectionMemoryProfilePreservation(config, profile.omoProfile);
  const profileEntry = config.profiles?.[profile.omoProfile];
  const layer = profileEntry?.['[senpi]'] ?? profileEntry?.['[native]'];
  if (!isPlainObject(layer)) throw new Error(`프로필 ${profile.omoProfile} 레이어를 찾을 수 없습니다.`);
  const engine = config['[senpi]'] ?? config['[native]'];
  if (!isPlainObject(engine)) throw new Error('모델 카탈로그를 찾을 수 없습니다.');
  engine.agents = layer.agents;
  engine.categories = clone(layer.categories ?? {});
  if (owned) engine.categories['desktop-kibitzer'] = owned;
  if (reflectionOwned) engine.categories['desktop-reflection'] = reflectionOwned;
  mergeModelProfileSettings(config, profileEntry);
  mergeModelProfileSettings(engine, layer);
  return config;
}

// ── stable-500 role mirror with its refusals (:2898-2957) ──────────────────────
export function syncStable500RoleModels({
  source, target, profileKey, selectionProfile, switchProfile = false, validateOnly = false,
}) {
  const sourceProfile = source?.profiles?.[profileKey];
  const targetProfile = target?.profiles?.[profileKey];
  if (!isPlainObject(sourceProfile) || !isPlainObject(targetProfile)) {
    throw new Error(`stable-500 역할 동기화 거부: 프로필 ${profileKey} 이(가) 없습니다.`);
  }
  for (const container of [source, target, sourceProfile, targetProfile]) {
    if (container && Object.hasOwn(container, '[senpi]')) {
      throw new Error('stable-500 역할 동기화 거부: [native]와 [senpi] 레이어가 함께 있습니다.');
    }
  }
  const sourceLayer = sourceProfile['[native]'];
  const targetLayer = targetProfile['[native]'];
  const sourceEngine = source['[native]'];
  const targetEngine = target['[native]'];
  if (!isPlainObject(sourceLayer) || !isPlainObject(targetLayer) || !isPlainObject(sourceEngine) ||
      !isPlainObject(targetEngine) || !isPlainObject(sourceEngine.models) || !isPlainObject(targetEngine.models)) {
    throw new Error('stable-500 역할 동기화 거부: 프로필 레이어 또는 모델 카탈로그가 없습니다.');
  }
  if (!switchProfile && String(selectionProfile ?? '') !== String(profileKey)) {
    throw new Error(`stable-500 역할 동기화 거부: 현재 활성 프로필이 ${profileKey} 이(가) 아닙니다.`);
  }
  const updates = [];
  for (const section of ['agents', 'categories']) {
    const sourceRows = sourceLayer[section];
    const targetRows = targetLayer[section];
    const activeRows = targetEngine[section];
    if (!isPlainObject(sourceRows) || !isPlainObject(targetRows) || !isPlainObject(activeRows)) {
      throw new Error(`stable-500 역할 동기화 거부: ${section} 행이 없습니다.`);
    }
    for (const [role, row] of Object.entries(sourceRows)) {
      if (section === 'categories' && role === 'desktop-kibitzer' &&
          getMemorySelectionFromConfig(source).owned) continue;
      if (section === 'categories' && role === 'desktop-reflection' &&
          getReflectionMemorySelectionFromConfig(source).owned) continue;
      if (!isPlainObject(row) || !Object.hasOwn(row, 'model')) continue;
      const alias = String(row.model ?? '');
      if (!alias.trim()) continue;
      const definition = sourceEngine.models[alias];
      if (!isPlainObject(definition) || !String(definition.model ?? '').trim() ||
          !getMemoryReasoning(definition).trim()) {
        throw new Error(`stable-500 역할 동기화 거부: 모델 별칭 ${alias} 이(가) 유효하지 않습니다.`);
      }
      const existing = targetEngine.models[alias];
      if (isPlainObject(existing) && (String(existing.model) !== String(definition.model) ||
          getMemoryReasoning(existing) !== getMemoryReasoning(definition))) {
        throw new Error(`stable-500 역할 동기화 거부: 모델 별칭 ${alias} 이(가) 다른 모델을 가리킵니다.`);
      }
      updates.push({ section, role, alias, definition });
    }
  }

  const next = clone(target);
  const nextLayer = next.profiles[profileKey]['[native]'];
  const nextEngine = next['[native]'];
  let changed = false;
  for (const item of updates) {
    if (!isPlainObject(nextEngine.models[item.alias])) {
      nextEngine.models[item.alias] = clone(item.definition);
      changed = true;
    }
    for (const rows of [nextLayer[item.section], nextEngine[item.section]]) {
      const role = rows[item.role];
      if (role === undefined) { rows[item.role] = { model: item.alias }; changed = true; }
      else if (!isPlainObject(role)) { rows[item.role] = { model: item.alias }; changed = true; }
      else if (String(role.model) !== item.alias) { role.model = item.alias; changed = true; }
    }
  }

  for (const pair of [
    { sources: [sourceProfile, sourceLayer], targets: [next.profiles[profileKey], nextLayer] },
    { sources: [source, sourceEngine], targets: [next, nextEngine] },
  ]) {
    let selectionName = '';
    for (const scope of pair.sources) {
      if (scope && Object.hasOwn(scope, 'model_profile')) {
        selectionName = scope.model_profile === null ? '' : String(scope.model_profile);
      }
    }
    if (selectionName.trim() && !selectionName.includes('/') && !Object.hasOwn(BUILTIN_MODEL_PROFILES, selectionName)) {
      let defined = false;
      for (const scope of [next, nextEngine, next.profiles[profileKey], nextLayer]) {
        if (isPlainObject(scope?.model_profiles) && Object.hasOwn(scope.model_profiles, selectionName)) defined = true;
      }
      if (!defined) {
        throw new Error(`stable-500 역할 동기화 거부: model_profile ${selectionName} 이(가) stable-500에 정의돼 있지 않습니다.`);
      }
    }
    for (const scope of pair.targets) {
      if (!selectionName.trim()) {
        if (scope && Object.hasOwn(scope, 'model_profile')) { delete scope.model_profile; changed = true; }
      } else if (!scope || scope.model_profile !== selectionName) {
        scope.model_profile = selectionName; changed = true;
      }
    }
  }
  return { changed, config: next };
}

// ── summarizer (:2673-2840) ────────────────────────────────────────────────────
export function readCompactionSummarizer(settings) {
  const engineModel = settings?.compaction?.model;
  if (typeof engineModel === 'string' && engineModel.trim()) {
    const slash = engineModel.indexOf('/');
    if (slash > 0 && slash < engineModel.length - 1) {
      return { provider: engineModel.slice(0, slash), model: engineModel.slice(slash + 1) };
    }
  }
  const legacy = settings?.compactionSummarizer;
  if (isPlainObject(legacy) && String(legacy.provider ?? '').trim() && String(legacy.model ?? '').trim()) {
    return { provider: String(legacy.provider), model: String(legacy.model) };
  }
  return null;
}

export function setCompactionSummarizer({ settings, modelId }) {
  const next = clone(settings);
  delete next.compactionSummarizer;
  let provider = '';
  let model = '';
  if (!String(modelId ?? '').trim()) {
    if (isPlainObject(next.compaction)) {
      delete next.compaction.model;
      if (Object.keys(next.compaction).length === 0) delete next.compaction;
    }
  } else {
    const segments = String(modelId).split('/');
    if (segments.length < 2 || !segments[0].trim()) throw new Error(`요약 모델 ID가 올바르지 않습니다: ${modelId}`);
    provider = segments[0];
    model = segments.slice(1).join('/');
    if (!model.trim()) throw new Error(`요약 모델 ID가 올바르지 않습니다: ${modelId}`);
    if (!isPlainObject(next.compaction)) next.compaction = {};
    next.compaction.model = `${provider}/${model}`;
  }
  return { settings: next, provider, model, warnings: summarizerWarnings(modelId, provider) };
}

export function summarizerWarnings(modelId, provider) {
  const warnings = [];
  if (modelId && String(modelId).includes('muse-spark')) {
    warnings.push({ level: 'warning', text: 'Muse Spark는 요약 품질이 낮습니다. GPT 계열 요약 모델을 권장합니다.' });
  }
  if (provider === 'commandcode') {
    warnings.push({ level: 'info', text: '커맨드코드 요약 모델은 유료 구독 할당량을 사용합니다.' });
  }
  return warnings;
}

// WinForms Get-CommandCodeWarning (:2135-2185): a cmd-* alias is a preflight
// warning when the profile has no CommandCode subscription assignment. A
// missing registry/assignments member counts as unassigned; nothing throws.
export function commandCodeWarning({ catalog, alias, registry, profileKey } = {}) {
  const entry = isPlainObject(catalog) && isPlainObject(catalog[alias]) ? catalog[alias] : null;
  const modelId = typeof entry?.model === 'string' ? entry.model : '';
  const provider = modelId.split('/')[0];
  if (provider !== 'commandcode' && provider !== 'commandcode-anthropic') return null;
  const assignments = isPlainObject(registry?.profileAssignments) ? registry.profileAssignments : null;
  const assigned = assignments && typeof assignments[profileKey] === 'string'
    ? assignments[profileKey].trim() : '';
  if (assigned) return null;
  return '커맨드코드 모델이지만 구독이 배정되지 않았습니다 (기본 키로 동작)';
}

// ── lane mirrors (:2061-2094) ──────────────────────────────────────────────────
// Pure: the caller resolves existence (no stat here). Fail-closed: a missing root is a
// warning, never a directory creation.
export function laneMirrorPlan(roots = []) {
  const contexts = [];
  const warnings = [];
  for (const item of roots) {
    const root = typeof item === 'string' ? item : item?.root;
    if (!root || !String(root).trim()) continue;
    const exists = typeof item === 'string' ? true : Boolean(item.exists);
    if (!exists) { warnings.push(`레인 미러 건너뜀 (레인 루트 없음): ${root}`); continue; }
    contexts.push({
      root,
      configPath: `${root}/omo.jsonc`,
      settingsPath: `${root}/agent/settings.json`,
      modelsPath: `${root}/agent/models.json`,
      mainOverridePath: `${root}/runtime/native-profile-switcher-main.json`,
      subscriptionsPath: `${root}/commandcode-subscriptions.json`,
      backupDirectory: `${root}/runtime/native-profile-switcher-backups`,
    });
  }
  return { contexts, warnings };
}

// ── ollama-cloud provider guarantee (:3776-3830) ───────────────────────────────
export function ensureOllamaCloudProviderText(raw) {
  let text = raw;
  let changed = false;
  if (!text.includes('{env:OLLAMA_API_KEY}')) {
    const nameLine = '"name":  "Ollama Cloud",';
    if (text.includes(nameLine)) {
      text = text.split(nameLine).join(nameLine + "\r\n" + '                                          "apiKey":  "{env:OLLAMA_API_KEY}",');
      changed = true;
    }
  }
  if (!text.includes('"glm-5.3-flash"')) {
    const optionsClose = '"baseURL":  "https://ollama.com/v1"';
    if (text.includes(optionsClose)) {
      const block = optionsClose + "\r\n                                                      }," + "\r\n" + '                                          "models":  {' + "\r\n" + '                                                          "glm-5.3-flash":  {' + "\r\n" + '                                                                          "name":  "GLM 5.3 Flash (Ollama Cloud)"' + "\r\n" + '                                                                      },' + "\r\n" + '                                                          "glm-5.3":  {' + "\r\n" + '                                                                          "name":  "GLM 5.3 (Ollama Cloud)"' + "\r\n" + '                                                                      },' + "\r\n" + '                                                          "glm-5.2":  {' + "\r\n" + '                                                                          "name":  "GLM 5.2 (Ollama Cloud)"' + "\r\n" + '                                                                      },' + "\r\n" + '                                                          "deepseek-v4-flash:0731":  {' + "\r\n" + '                                                                          "name":  "DeepSeek V4 Flash 0731 (Ollama Cloud)"' + "\r\n" + '                                                                      }' + "\r\n" + '                                                      }';
      text = text.split(optionsClose).join(block);
      changed = true;
    }
  }
  return {
    text, changed,
    warnings: changed ? ['✓ ollama-cloud provider 보장됨 (키는 환경변수 OLLAMA_API_KEY에서 읽음)'] : [],
  };
}

// ── reviewer-key migration (:1333) ─────────────────────────────────────────────
export const REVIEWER_KEY_MAP = {
  'omo-senpi-code-reviewer': 'omo-native-code-reviewer',
  'omo-senpi-gate-reviewer': 'omo-native-gate-reviewer',
  'omo-senpi-qa-executor': 'omo-native-qa-executor',
};
export const REVIEWER_ALLOWED_PATHS = [
  '[native].agents',
  'profiles.native-experimental-custom.[native].agents',
  'profiles.native-cmd-glm-deepseek.[native].agents',
];
const LIVE_REVIEWER_PREIMAGE_SHA256 = '80392A6A9AFC0C03E7AA289348AFAB0D22469B98B828D24FB9108E40FEC100D5';

function inspectReviewerTree(node, at, counts) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const item of node) inspectReviewerTree(item, `${at}[]`, counts); return; }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (Object.hasOwn(REVIEWER_KEY_MAP, key)) {
      if (!REVIEWER_ALLOWED_PATHS.includes(at)) throw new Error(`Reviewer migration: unexpected legacy key ${at}.${key}`);
      counts.old += 1;
    }
    if (Object.values(REVIEWER_KEY_MAP).includes(key) && REVIEWER_ALLOWED_PATHS.includes(at)) counts.new += 1;
    inspectReviewerTree(value, at ? `${at}.${key}` : key, counts);
  }
}

export function migrateReviewerKeys({ config, live = false, preimageSha256 = '' }) {
  if (!isPlainObject(config)) throw new Error('Reviewer migration: root must be an object.');
  const counts = { old: 0, new: 0 };
  inspectReviewerTree(config, '', counts);
  if (live) {
    if (!((counts.old === 9 && counts.new === 0) || (counts.old === 0 && counts.new === 9))) {
      throw new Error(`Reviewer migration: live snapshot drift (old=${counts.old}, new=${counts.new}); expected 9/0 or 0/9.`);
    }
    if (counts.old === 9 && preimageSha256 !== LIVE_REVIEWER_PREIMAGE_SHA256) {
      throw new Error('Reviewer migration: owner preimage hash drift; no backup or write.');
    }
  }
  const next = clone(config);
  let changed = 0;
  for (const at of REVIEWER_ALLOWED_PATHS) {
    let node = next;
    for (const part of at.split('.')) {
      if (!isPlainObject(node)) throw new Error(`Reviewer migration: malformed container ${at}`);
      if (!Object.hasOwn(node, part)) throw new Error(`Reviewer migration: missing container ${at}`);
      node = node[part];
    }
    if (!isPlainObject(node)) throw new Error(`Reviewer migration: malformed agents ${at}`);
    for (const [oldKey, newKey] of Object.entries(REVIEWER_KEY_MAP)) {
      for (const member of [node[oldKey], node[newKey]]) {
        if (member !== undefined && member !== null && !isPlainObject(member)) {
          throw new Error(`Reviewer migration: malformed value for ${at}.${node[oldKey] === member ? oldKey : newKey}`);
        }
      }
      if (!Object.hasOwn(node, oldKey)) continue;
      if (Object.hasOwn(node, newKey)) {
        if (!deepEqual(node[oldKey], node[newKey])) {
          throw new Error(`Reviewer migration: conflicting ${at}.${oldKey} and ${at}.${newKey}`);
        }
      } else {
        node[newKey] = node[oldKey];
      }
      delete node[oldKey];
      changed += 1;
    }
  }
  if (changed === 0) return { config: next, changed, oldCount: counts.old, newCount: counts.new, noop: true };
  return { config: next, changed, oldCount: counts.old, newCount: counts.new, noop: false };
}
