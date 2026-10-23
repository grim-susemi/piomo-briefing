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

const DEFAULT_LIB = 'C:/Users/USER/.bun/install/global/node_modules/omo-ai/bin/lib';
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

let cachedSenpiVersion = null;
function getSenpiVersion(lib) {
  if (cachedSenpiVersion) return cachedSenpiVersion;
  try {
    const pkgPaths = path.join(lib, 'package-paths.js');
    if (fs.existsSync(pkgPaths)) {
      const pathsContent = fs.readFileSync(pkgPaths, 'utf8');
      const match = pathsContent.match(/resolveSenpi\(\)\s*\{[^}]*packageRoot:\s*['"]([^'"]+)['"]/);
      if (match && match[1]) {
        const pkgJson = JSON.parse(fs.readFileSync(path.join(match[1], 'package.json'), 'utf8'));
        cachedSenpiVersion = pkgJson.version ?? '0.0.0';
        return cachedSenpiVersion;
      }
    }
  } catch {}
  return '0.0.0';
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

  const lookupHome = (homeKey) => (registries instanceof Map ? registries.get(homeKey) : registries[homeKey]);

  for (const home of homes) {
    const reg = lookupHome(home);
    if (!reg || reg.unknown) {
      return { ok: false, code: 'REGISTRY_UNKNOWN', home };
    }
    const servedIds = getServedModelIds(reg);
    if (!servedIds.has(targetModel)) {
      return { ok: false, code: 'UNSUPPORTED_MODEL', home };
    }
  }

  if (kind !== 'summarizer' && targetEffort) {
    for (const home of homes) {
      const reg = lookupHome(home);
      const modelDef = reg?.models?.find((m) => m.modelId === targetModel);
      const levels = modelDef?.levels ?? [];
      if (!levels.includes(targetEffort)) {
        return { ok: false, code: 'UNSUPPORTED_EFFORT', home };
      }
    }
  }

  return { ok: true };
}
