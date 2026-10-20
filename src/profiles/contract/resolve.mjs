// Model resolution for one agent.
//
// Order: memory (only when it was written for the current roster revision) ->
// pin -> first rung of the lane chain. Lane chains come from the P8
// `model_profiles` override when it defines models for the lane, else from
// BUILTIN_CHAINS. Each rung walks its ordered provider list.
//
// Pure ESM: imports only node built-ins via sibling modules (constants has no
// imports at all).
import { AGENT_IDS, BUILTIN_CHAINS, DEFAULT_LANE, LANES, THINKING } from './constants.mjs';

const THINKING_SET = new Set(THINKING);
const PROVIDER_KEYS = ['provider', 'providerId'];
const MODEL_KEYS = ['modelId', 'id'];

function thinkingOf(value) {
  return typeof value === 'string' && THINKING_SET.has(value) ? value : null;
}

function rungThinking(rung) {
  return thinkingOf(rung?.thinking) ?? thinkingOf(rung?.variant);
}

function matchesOf(found) {
  if (found === null || found === undefined || found === false) return [];
  return Array.isArray(found) ? found.filter(Boolean) : [found];
}

function providerOf(match, fallback = null) {
  if (match !== null && typeof match === 'object') {
    for (const key of PROVIDER_KEYS) {
      if (typeof match[key] === 'string' && match[key].length > 0) return match[key];
    }
    if (match.model && typeof match.model === 'object') {
      for (const key of PROVIDER_KEYS) {
        if (typeof match.model[key] === 'string' && match.model[key].length > 0) return match.model[key];
      }
    }
  }
  return fallback;
}

function modelIdOf(match, fallback) {
  if (match !== null && typeof match === 'object') {
    for (const key of MODEL_KEYS) {
      if (typeof match[key] === 'string' && match[key].length > 0) return match[key];
    }
    if (match.model && typeof match.model === 'object') {
      for (const key of MODEL_KEYS) {
        if (typeof match.model[key] === 'string' && match.model[key].length > 0) return match.model[key];
      }
    }
  }
  return fallback;
}

function hasAuth(registry, provider) {
  if (typeof registry.hasAuth !== 'function') return false;
  return registry.hasAuth(provider) === true;
}

function agentOf(roster, agentId) {
  const agent = roster?.agents?.[agentId];
  if (agent === null || typeof agent !== 'object') {
    return { lane: DEFAULT_LANE[agentId], pin: null, rev: 0 };
  }
  return {
    lane: typeof agent.lane === 'string' ? agent.lane : DEFAULT_LANE[agentId],
    pin: agent.pin ?? null,
    rev: Number.isInteger(agent.rev) ? agent.rev : 0,
  };
}

function isHephaestusModel(agentId, modelId) {
  return agentId !== 'hephaestus' || modelId.startsWith('gpt-');
}

// Resolve one candidate. Returns {provider, modelId} or {reason}.
function tryCandidate(candidate, agentId, registry) {
  const modelId = typeof candidate?.modelId === 'string' ? candidate.modelId : '';
  if (modelId.length === 0) return { reason: 'not-found' };
  if (!isHephaestusModel(agentId, modelId)) return { reason: 'non-gpt' };
  const provider = typeof candidate.provider === 'string' && candidate.provider.length > 0
    ? candidate.provider
    : null;

  if (provider !== null) {
    const matches = matchesOf(registry.find(provider, modelId));
    const match = matches.find(item => providerOf(item, provider) === provider);
    if (!match) return { reason: 'not-found' };
    if (!hasAuth(registry, provider)) return { reason: 'unauthenticated' };
    return { provider, modelId: modelIdOf(match, modelId) };
  }

  const matches = matchesOf(registry.find(undefined, modelId));
  if (matches.length === 0) return { reason: 'not-found' };
  const providers = [...new Set(matches.map(item => providerOf(item)))];
  if (providers.length > 1 || providers[0] === null) return { reason: 'ambiguous' };
  if (!hasAuth(registry, providers[0])) return { reason: 'unauthenticated' };
  return { provider: providers[0], modelId: modelIdOf(matches[0], modelId) };
}

function unavailableReason(reasons) {
  if (reasons.includes('non-gpt')) return 'non-gpt';
  if (reasons.includes('ambiguous')) return 'ambiguous';
  if (reasons.includes('unauthenticated')) return 'unauthenticated';
  return 'not-found';
}

export function resolve({ agentId, roster, memory, laneOverrides, registry } = {}) {
  if (!AGENT_IDS.includes(agentId)) return { unavailable: true, reason: 'unknown-agent' };
  if (!registry || typeof registry.find !== 'function') {
    throw new TypeError('resolve requires a registry adapter {find, hasAuth}');
  }

  const agent = agentOf(roster, agentId);
  const reasons = [];

  if (memory && memory.agentId === agentId && memory.rosterRev === agent.rev) {
    const candidate = {
      provider: memory.model?.provider ?? null,
      modelId: memory.model?.modelId,
    };
    const result = tryCandidate(candidate, agentId, registry);
    if (result.provider) {
      return {
        provider: result.provider,
        modelId: result.modelId,
        thinking: thinkingOf(memory.thinking),
        origin: 'memory',
      };
    }
    reasons.push(result.reason);
  }

  if (agent.pin !== null) {
    const result = tryCandidate(agent.pin, agentId, registry);
    if (result.provider) {
      return {
        provider: result.provider,
        modelId: result.modelId,
        thinking: thinkingOf(agent.pin.thinking),
        origin: 'pin',
      };
    }
    reasons.push(result.reason);
  }

  const lane = LANES.includes(agent.lane) ? agent.lane : DEFAULT_LANE[agentId];
  const override = laneOverrides?.[lane];
  const overrideModels = Array.isArray(override?.models) ? override.models : [];
  const useOverride = overrideModels.length > 0;
  const chain = useOverride ? overrideModels : (BUILTIN_CHAINS[lane] ?? []);
  const origin = useOverride ? 'lane' : 'builtin';

  for (const entry of chain) {
    const rung = typeof entry === 'string' ? { model: entry } : entry;
    if (!rung || typeof rung.model !== 'string' || rung.model.length === 0) {
      reasons.push('not-found');
      continue;
    }
    if (!isHephaestusModel(agentId, rung.model)) {
      reasons.push('non-gpt');
      continue;
    }
    const providers = Array.isArray(rung.providers) && rung.providers.length > 0
      ? rung.providers
      : [null];
    let rungReason = null;
    for (const provider of providers) {
      const result = tryCandidate({ provider, modelId: rung.model }, agentId, registry);
      if (result.provider) {
        return {
          provider: result.provider,
          modelId: result.modelId,
          thinking: rungThinking(rung),
          origin,
        };
      }
      rungReason = result.reason;
    }
    reasons.push(rungReason ?? 'not-found');
  }

  return { unavailable: true, reason: unavailableReason(reasons) };
}
