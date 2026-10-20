// Roster and memory schema v1 for the shared single-writer sidecars.
//
//   <agentDir>/primary-agents/roster.json            (board server only)
//   <agentDir>/primary-agents/memory/<agentId>.json  (extension only)
//
// Pure ESM: only node:fs, node:path and node:crypto may be imported.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { AGENT_IDS, DEFAULT_LANE, LANES, THINKING } from './constants.mjs';

const SECRET_KEY = /key|token|secret|password|authorization/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ROSTER_KEYS = ['v', 'revision', 'updatedAt', 'agents'];
const AGENT_KEYS = ['lane', 'pin', 'rev'];
const PIN_KEYS = ['provider', 'modelId', 'thinking'];
const MEMORY_KEYS = ['v', 'agentId', 'model', 'thinking', 'rosterRev', 'updatedAt'];
const MEMORY_MODEL_KEYS = ['provider', 'modelId'];
const THINKING_SET = new Set(THINKING);

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

function checkKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (SECRET_KEY.test(key)) {
      errors.push({ path: `${path}.${key}`, message: `forbidden key "${key}" (credential-like keys are never stored)` });
    } else if (!allowed.includes(key)) {
      errors.push({ path: `${path}.${key}`, message: `unknown key "${key}"` });
    }
  }
}

function checkThinking(value, path, errors) {
  if (value !== null && !(typeof value === 'string' && THINKING_SET.has(value))) {
    errors.push({ path, message: `thinking must be null or one of ${THINKING.join(', ')}` });
  }
}

function checkProvider(value, path, errors) {
  if (value !== null && !(typeof value === 'string' && value.length > 0)) {
    errors.push({ path, message: 'provider must be null or a non-empty string' });
  }
}

function checkModelId(value, path, errors) {
  if (!(typeof value === 'string' && value.length > 0)) {
    errors.push({ path, message: 'modelId must be a non-empty string' });
  }
}

function validatePin(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push({ path, message: 'pin must be null or an object {provider, modelId, thinking}' });
    return;
  }
  checkKeys(value, PIN_KEYS, path, errors);
  if (!('provider' in value)) errors.push({ path: `${path}.provider`, message: 'missing key "provider"' });
  else checkProvider(value.provider, `${path}.provider`, errors);
  if (!('modelId' in value)) errors.push({ path: `${path}.modelId`, message: 'missing key "modelId"' });
  else checkModelId(value.modelId, `${path}.modelId`, errors);
  if (!('thinking' in value)) errors.push({ path: `${path}.thinking`, message: 'missing key "thinking"' });
  else checkThinking(value.thinking, `${path}.thinking`, errors);
}

function validateAgent(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push({ path, message: 'agent entry must be an object {lane, pin, rev}' });
    return;
  }
  checkKeys(value, AGENT_KEYS, path, errors);
  if (!('lane' in value)) errors.push({ path: `${path}.lane`, message: 'missing key "lane"' });
  else if (!LANES.includes(value.lane)) {
    errors.push({ path: `${path}.lane`, message: `lane must be one of ${LANES.join(', ')}` });
  }
  if (!('pin' in value)) errors.push({ path: `${path}.pin`, message: 'missing key "pin"' });
  else if (value.pin !== null) validatePin(value.pin, `${path}.pin`, errors);
  if (!('rev' in value)) errors.push({ path: `${path}.rev`, message: 'missing key "rev"' });
  else if (!Number.isInteger(value.rev) || value.rev < 0) {
    errors.push({ path: `${path}.rev`, message: 'rev must be an integer >= 0' });
  }
}

export function validateRoster(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: [{ path: '$', message: 'roster must be a JSON object' }] };
  }
  checkKeys(value, ROSTER_KEYS, '$', errors);
  if (value.v !== 1) errors.push({ path: '$.v', message: 'v must be 1' });
  if (!Number.isInteger(value.revision) || value.revision < 0) {
    errors.push({ path: '$.revision', message: 'revision must be an integer >= 0' });
  }
  if (!isIsoDate(value.updatedAt)) {
    errors.push({ path: '$.updatedAt', message: 'updatedAt must be an ISO-8601 date-time string' });
  }
  if (!isPlainObject(value.agents)) {
    errors.push({ path: '$.agents', message: 'agents must be an object keyed by agent id' });
  } else {
    for (const key of Object.keys(value.agents)) {
      if (SECRET_KEY.test(key)) {
        errors.push({ path: `$.agents.${key}`, message: `forbidden key "${key}" (credential-like keys are never stored)` });
      } else if (!AGENT_IDS.includes(key)) {
        errors.push({ path: `$.agents.${key}`, message: `unknown agent id "${key}"` });
      }
    }
    for (const agentId of AGENT_IDS) {
      if (!Object.prototype.hasOwnProperty.call(value.agents, agentId)) {
        errors.push({ path: `$.agents.${agentId}`, message: `missing agent "${agentId}"` });
      } else {
        validateAgent(value.agents[agentId], `$.agents.${agentId}`, errors);
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateMemory(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: [{ path: '$', message: 'memory must be a JSON object' }] };
  }
  checkKeys(value, MEMORY_KEYS, '$', errors);
  if (value.v !== 1) errors.push({ path: '$.v', message: 'v must be 1' });
  if (!AGENT_IDS.includes(value.agentId)) {
    errors.push({ path: '$.agentId', message: `agentId must be one of ${AGENT_IDS.join(', ')}` });
  }
  if (!isPlainObject(value.model)) {
    errors.push({ path: '$.model', message: 'model must be an object {provider, modelId}' });
  } else {
    checkKeys(value.model, MEMORY_MODEL_KEYS, '$.model', errors);
    if (!('provider' in value.model)) errors.push({ path: '$.model.provider', message: 'missing key "provider"' });
    else checkProvider(value.model.provider, '$.model.provider', errors);
    if (!('modelId' in value.model)) errors.push({ path: '$.model.modelId', message: 'missing key "modelId"' });
    else checkModelId(value.model.modelId, '$.model.modelId', errors);
  }
  if (!('thinking' in value)) errors.push({ path: '$.thinking', message: 'missing key "thinking"' });
  else checkThinking(value.thinking, '$.thinking', errors);
  if (!Number.isInteger(value.rosterRev) || value.rosterRev < 0) {
    errors.push({ path: '$.rosterRev', message: 'rosterRev must be an integer >= 0' });
  }
  if (!isIsoDate(value.updatedAt)) {
    errors.push({ path: '$.updatedAt', message: 'updatedAt must be an ISO-8601 date-time string' });
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function defaultRoster(now = new Date()) {
  const agents = {};
  for (const agentId of AGENT_IDS) {
    agents[agentId] = { lane: DEFAULT_LANE[agentId], pin: null, rev: 0 };
  }
  return { v: 1, revision: 0, updatedAt: new Date(now).toISOString(), agents };
}

export const PRIMARY_AGENTS_DIR = 'primary-agents';

export function primaryAgentsDir(agentDir) {
  return join(agentDir, PRIMARY_AGENTS_DIR);
}

export function rosterPath(agentDir) {
  return join(primaryAgentsDir(agentDir), 'roster.json');
}

export function memoryDir(agentDir) {
  return join(primaryAgentsDir(agentDir), 'memory');
}

export function memoryPath(agentDir, agentId) {
  return join(memoryDir(agentDir), `${agentId}.json`);
}

function warning(code, message) {
  return { code, message };
}

function summarizeErrors(errors) {
  const first = errors[0];
  const rest = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
  return `${first.path}: ${first.message}${rest}`;
}

// Missing roster file = defaults with every rev 0 and no warning. Invalid JSON,
// an invalid roster or v != 1 = defaults plus exactly one warning.
export function readRoster(agentDir, options = {}) {
  const fs = options.fs ?? nodeFs;
  const file = rosterPath(agentDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { roster: defaultRoster(), warning: null };
    return {
      roster: defaultRoster(),
      warning: warning('ROSTER_UNREADABLE', `${file}: ${error.message}`),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      roster: defaultRoster(),
      warning: warning('ROSTER_INVALID', `${file}: ${error.message}`),
    };
  }
  const result = validateRoster(parsed);
  if (!result.ok) {
    return {
      roster: defaultRoster(),
      warning: warning('ROSTER_INVALID', `${file}: ${summarizeErrors(result.errors)}`),
    };
  }
  return { roster: parsed, warning: null };
}

// A missing memory file is a normal first run. An invalid file is ignored with
// exactly one warning.
export function readMemory(agentDir, agentId, options = {}) {
  const fs = options.fs ?? nodeFs;
  const file = memoryPath(agentDir, agentId);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { memory: null, warning: null };
    return { memory: null, warning: warning('MEMORY_UNREADABLE', `${file}: ${error.message}`) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { memory: null, warning: warning('MEMORY_INVALID', `${file}: ${error.message}`) };
  }
  const result = validateMemory(parsed);
  if (!result.ok) {
    return { memory: null, warning: warning('MEMORY_INVALID', `${file}: ${summarizeErrors(result.errors)}`) };
  }
  if (parsed.agentId !== agentId) {
    return {
      memory: null,
      warning: warning('MEMORY_AGENT_MISMATCH', `${file}: agentId "${parsed.agentId}" does not match "${agentId}"`),
    };
  }
  return { memory: parsed, warning: null };
}

function assertAgent(roster, agentId) {
  if (!isPlainObject(roster) || !isPlainObject(roster.agents)) {
    throw new TypeError('roster must be an object with an agents map');
  }
  if (!AGENT_IDS.includes(agentId)) {
    throw new RangeError(`unknown agent id "${agentId}"`);
  }
  if (!isPlainObject(roster.agents[agentId])) {
    throw new TypeError(`roster.agents.${agentId} is missing`);
  }
}

function updateAgent(roster, agentId, update) {
  return {
    ...roster,
    updatedAt: new Date().toISOString(),
    agents: {
      ...roster.agents,
      [agentId]: update(roster.agents[agentId]),
    },
  };
}

// Every explicit lane change bumps the agent's rev so memory written for the
// previous rev can no longer win.
export function setAgentLane(roster, agentId, lane) {
  assertAgent(roster, agentId);
  if (!LANES.includes(lane)) throw new RangeError(`unknown lane "${lane}"`);
  return updateAgent(roster, agentId, agent => ({ ...agent, lane, rev: agent.rev + 1 }));
}

export function setAgentPin(roster, agentId, pin) {
  assertAgent(roster, agentId);
  if (pin !== null) {
    const errors = [];
    validatePin(pin, `$.agents.${agentId}.pin`, errors);
    if (errors.length > 0) {
      const error = new Error(`invalid pin: ${summarizeErrors(errors)}`);
      error.code = 'INVALID_PIN';
      throw error;
    }
  }
  return updateAgent(roster, agentId, agent => ({ ...agent, pin, rev: agent.rev + 1 }));
}

// Resetting memory is a roster write: bump rev so the old memory file stops
// matching the roster revision and the pin/lane wins again.
export function resetAgentMemory(roster, agentId) {
  assertAgent(roster, agentId);
  return updateAgent(roster, agentId, agent => ({ ...agent, rev: agent.rev + 1 }));
}
