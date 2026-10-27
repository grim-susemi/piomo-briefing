// Credential-blind native model registry composition and selection validation (plan todo 5).
// Ported from WinForms OMO_Native_Profile_Switcher.ps1:614-689, 3246-3285.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  getFullModelId,
  getProviderChoiceForModel,
  getProviderFromModelId,
} from './model.mjs';

export const DEFAULT_LIB = 'C:/Users/USER/.bun/install/global/node_modules/omo-ai/bin/lib';
const registryCache = new Map();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resolveAgentPaths(agentDir) {
  const isAgent = path.basename(agentDir).toLowerCase() === 'agent';
  const resolved = isAgent ? agentDir : (fs.existsSync(path.join(agentDir, 'agent')) ? path.join(agentDir, 'agent') : agentDir);
  return {
    modelsPath: path.join(resolved, 'models.json'),
    storePath: path.join(resolved, 'models-store.json'),
  };
}

function readSafeBytes(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return Buffer.alloc(0);
  }
}

// The installed senpi version, part of the registry cache key so an engine upgrade recomposes every home. It is the
// package the child imports: package-paths.js resolveSenpi() resolves the bare `@code-yeongyu/senpi` from its own
// directory (`lib`) and takes the folder above the entry's `dist/` as the package root. Node finds a bare specifier
// in the first `node_modules/<name>` folder going up from that directory, so the same walk reaches the same
// package.json. It is read on every call, so an upgrade while the board runs is noticed. '0.0.0' = not found.
export function getSenpiVersion(lib) {
  let dir = path.resolve(lib);
  for (;;) {
    const packageDir = path.join(dir, 'node_modules', '@code-yeongyu', 'senpi');
    if (fs.existsSync(packageDir)) {
      try {
        return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version ?? '0.0.0';
      } catch {
        return '0.0.0';
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '0.0.0';
    dir = parent;
  }
}

function buildChildScript(lib) {
  return `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = ${JSON.stringify(lib)};
const { resolveSenpi } = await import(pathToFileURL(path.join(lib, 'package-paths.js')));
const { engineDependencyDir } = await import(pathToFileURL(path.join(lib, 'engine-dependency.js')));
const senpi = resolveSenpi().packageRoot;
const ai = engineDependencyDir(senpi, '@earendil-works/pi-ai');
if (!ai) throw new Error('Native model catalog is missing');
const { builtinProviders } = await import(pathToFileURL(path.join(ai, 'dist/providers/all.js')));
const { getSupportedThinkingLevels } = await import(pathToFileURL(path.join(ai, 'dist/models.js')));
const { ModelConfig } = await import(pathToFileURL(path.join(senpi, 'dist/core/model-config.js')));
const { composeModelProvider } = await import(pathToFileURL(path.join(senpi, 'dist/core/provider-composer.js')));

const modelsPath = process.argv[2];
const cfg = ModelConfig.parse(fs.existsSync(modelsPath) ? fs.readFileSync(modelsPath, 'utf8') : '{"providers":{}}', modelsPath);
if (cfg.getError()) throw new Error(cfg.getError());
const storePath = path.join(path.dirname(modelsPath), 'models-store.json');
const store = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf8').replace(/^\\uFEFF/, '')) : {};
const bases = new Map(builtinProviders().map((p) => [p.id, p]));
const anthropic = bases.get('anthropic');
if (anthropic) {
  bases.set('anthropic-subscription', {
    ...anthropic,
    id: 'anthropic-subscription',
    getModels: () => anthropic.getModels().map((m) => ({ ...m, provider: 'anthropic-subscription' })),
  });
}
const models = [];
const errors = [];
for (const id of new Set([...bases.keys(), ...cfg.getProviderIds()])) {
  if (cfg.isProviderDisabled(id)) continue;
  const base = bases.get(id);
  try {
    const p = cfg.getProvider(id) ? composeModelProvider(id, base, cfg) : base;
    if (!p) continue;
    if (p.refreshModels) {
      await p.refreshModels({
        stored: store[id],
        allowNetwork: false,
        signal: new AbortController().signal,
        publish: async ({ update }) => { update?.(); return true; },
      });
    }
    for (const m of p.getModels()) {
      models.push({
        provider: id,
        modelId: id + '/' + m.id,
        friendlyName: m.name,
        reasoning: Boolean(m.reasoning),
        levels: getSupportedThinkingLevels(m),
      });
    }
  } catch (error) {
    errors.push({ provider: id, message: error.message });
  }
}
console.log(JSON.stringify({ models, errors }));
`;
}

export function composeHomeRegistry(agentDir, options = {}) {
  const lib = options.lib ?? DEFAULT_LIB;
  const timeoutMs = options.timeoutMs ?? 30000;
  const runner = options.spawn ?? spawnSync;
  const { modelsPath, storePath } = resolveAgentPaths(agentDir);

  const modelsBytes = readSafeBytes(modelsPath);
  const storeBytes = readSafeBytes(storePath);
  const senpiVersion = getSenpiVersion(lib);
  const cacheKey = sha256(Buffer.concat([modelsBytes, storeBytes, Buffer.from(senpiVersion)]));

  if (registryCache.has(cacheKey)) {
    return registryCache.get(cacheKey);
  }

  const childScript = buildChildScript(lib);
  try {
    const res = runner(process.execPath, ['--input-type=module', '-', modelsPath], {
      input: childScript,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (res.error || res.status !== 0) {
      return { unknown: true, models: [], errors: [] };
    }
    const data = JSON.parse(res.stdout);
    const result = { models: data.models ?? [], errors: data.errors ?? [] };
    registryCache.set(cacheKey, result);
    return result;
  } catch {
    return { unknown: true, models: [], errors: [] };
  }
}

export function getServedModelIds(registry) {
  if (!registry || registry.unknown || !Array.isArray(registry.models)) return new Set();
  const failedProviders = new Set((registry.errors ?? []).map((e) => e.provider));
  const served = new Set();
  for (const item of registry.models) {
    if (!item || failedProviders.has(item.provider)) continue;
    served.add(item.modelId);
  }
  return served;
}

function homeRegistryOf(registries, home) {
  return registries instanceof Map ? registries.get(home) : registries?.[home];
}

// The one support decision (plan row 19). Every model check asks it: the write validator, the state's catalog flags
// and levels, the saved role and main flags, the engine-surfaced models and the memory candidates, so a model gets
// the same verdict wherever it is shown or written. The homes are checked in order: the first whose registry is
// missing or unknown gives REGISTRY_UNKNOWN, the first that does not serve the model (getServedModelIds)
// UNSUPPORTED_MODEL and, when an effort is given, the first after which the common levels lack it
// UNSUPPORTED_EFFORT. A served model's `levels` follow WinForms Get-MemoryCandidates (PS:3264-3279), which offers and
// validates (PS:3317, 3418) with the same list: the first home's own entry for the model, kept to the levels every
// home's index lists, in that first entry's order. An index keeps an id's last entry, which matters only for an id a
// registry lists twice. Each home's registry is indexed once, so a caller checking many models builds one checker
// and asks it per model.
export function supportStatusFor(registries, homes) {
  const indexed = homes.map((home) => {
    const reg = homeRegistryOf(registries, home);
    if (!reg || reg.unknown) return { home, unknown: true };
    const firstLevels = new Map();
    const indexLevels = new Map();
    for (const item of Array.isArray(reg.models) ? reg.models : []) {
      if (!item) continue;
      if (!firstLevels.has(item.modelId)) firstLevels.set(item.modelId, item.levels ?? []);
      indexLevels.set(item.modelId, item.levels ?? []);
    }
    return { home, served: getServedModelIds(reg), firstLevels, indexLevels };
  });
  return function supportStatus(modelId, effort = '') {
    for (const entry of indexed) {
      if (entry.unknown) return { ok: false, code: 'REGISTRY_UNKNOWN', home: entry.home };
      if (!entry.served.has(modelId)) return { ok: false, code: 'UNSUPPORTED_MODEL', home: entry.home };
    }
    let levels = indexed.length ? indexed[0].firstLevels.get(modelId) : [];
    for (const entry of indexed) {
      const homeLevels = entry.indexLevels.get(modelId);
      levels = levels.filter((level) => homeLevels.includes(level));
      if (effort && !levels.includes(effort)) return { ok: false, code: 'UNSUPPORTED_EFFORT', home: entry.home };
    }
    return { ok: true, levels };
  };
}

// The models every listed home serves, each with the thinking levels all of them support (PS Get-MemoryCandidates,
// PS:3246-3285): the first home's models sorted by id, kept when the support decision serves them and their common
// levels are not empty. A home whose registry is unknown serves nothing.
export function getCommonServedModels(registries, homes) {
  const first = homes.length ? homeRegistryOf(registries, homes[0]) : null;
  if (!first || first.unknown || !Array.isArray(first.models)) return [];
  const supportOf = supportStatusFor(registries, homes);
  const common = new Map();
  for (const item of first.models) {
    if (!item || common.has(item.modelId)) continue;
    const status = supportOf(item.modelId);
    if (status.ok && status.levels.length) common.set(item.modelId, { model: item.modelId, levels: status.levels });
  }
  return [...common.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

export function validateSelection({
  kind,
  homes = ['primary', 'stable'],
  provider = '',
  model = '',
  effort = '',
  registries = {},
  catalog = null,
}) {
  let targetModel = model;
  let targetEffort = effort;
  let targetProvider = provider;

  if (catalog && Object.hasOwn(catalog, targetModel)) {
    const aliasEntry = catalog[targetModel];
    targetModel = aliasEntry.model ?? targetModel;
    targetEffort = targetEffort || aliasEntry.reasoning || aliasEntry.variant || '';
  }

  if (targetProvider) {
    targetModel = getFullModelId(targetProvider, targetModel);
  } else if (targetModel.includes('/')) {
    targetProvider = getProviderFromModelId(targetModel);
  }

  if (targetProvider) {
    const raw = getProviderFromModelId(targetModel);
    const choice = getProviderChoiceForModel(targetModel);
    if (kind === 'summarizer') {
      if (targetProvider !== raw && targetProvider !== choice) {
        return { ok: false, code: 'SERVICE_MISMATCH', home: homes[0] ?? 'primary' };
      }
    } else if (targetProvider !== choice && targetProvider !== raw) {
      return { ok: false, code: 'SERVICE_MISMATCH', home: homes[0] ?? 'primary' };
    }
  }

  // A summarizer names no effort, so only its model is checked.
  const status = supportStatusFor(registries, homes)(targetModel, kind === 'summarizer' ? '' : targetEffort);
  return status.ok ? { ok: true } : { ok: false, code: status.code, home: status.home };
}
