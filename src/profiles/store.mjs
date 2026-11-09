// Profile switcher store: every filesystem access the /profiles route and the CLI need.
//
// The root paths are injected (never taken from a request body). A request names a
// target *id* from TARGET_SPECS; the id is resolved here to a path under one of the
// injected homes, so no request value can reach the filesystem as a path.
//
// Write pipeline (preview performs only the first four steps):
//   parse body -> read targets -> apply the change kinds to parsed values ->
//   validate (todo-7 merge layer + 5.1.44 key allowlist + protected settings) ->
//   compare-and-swap every read target's sha256 against `expected` -> durable
//   interruption journal with pre-hashes and before-images -> roster CAS ->
//   backups under <primaryHome>/runtime/native-profile-switcher-backups -> atomic text
//   write (same-directory wx tmp -> fsync -> rename with the contract's retry ladder)
//   -> re-parse and re-validate -> on any failure restore the backups and report
//   ROLLED_BACK.
//
// The journal (<stableHome>/agent/primary-agents/apply-journal.json) is written as
// `running` before the first write and as `completed`/`rolled-back` afterwards. A
// process that dies leaves `running` behind; callers show it as 중단된 적용. Explicit
// reapply resumes the recorded plan and skips published targets; reads never replay it.
import * as nodeFs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonc, readLaneOverrides } from './contract/jsonc.mjs';
import { atomicWriteJson, writeRoster as contractWriteRoster } from './contract/atomic.mjs';
import { readMemory, readRoster, validateRoster } from './contract/schema.mjs';
import { resolve } from './contract/resolve.mjs';
import { AGENT_IDS, LANES, THINKING } from './contract/constants.mjs';
import {
  assertMemoryRouteWritable, clone, commandCodeWarning, deepEqual, getEffectiveMemoryCatalog, getMemorySelectionFromConfig,
  getModelProfileSettings, getOrCreateCatalogAlias, getReflectionMemorySelectionFromConfig,
  isPlainObject, memoryFingerprint, mergeProfileLayerIntoActiveScopes, migrateReviewerKeys,
  readConfig, readCompactionSummarizer, readMainOverride, reflectionMemoryFingerprint, removeNullModelProfile,
  resolveMainDefaults, selectionState, setCompactionSummarizer, setMainLayerOverride,
  setModelProfileSelection, setProfileLayerModel, stripEngineSectionAlias,
  syncStable500RoleModels,
} from './merge.mjs';
import {
  BUILTIN_ROLE_CATEGORIES, CHATGPT_SUBSCRIPTION_PROVIDER_CHOICE, ENGINE_SURFACED_MODELS, PROFILE_META, ROLE_INVENTORY, buildRoutingRows,
  expandLayerRoles, getFullModelId, getMemoryReasoning, getModelIdWithoutProvider, getProfile,
  getProviderChoiceForModel, newRouteRow,
} from './model.mjs';
import { composeHomeRegistry, getCommonServedModels, supportStatusFor, validateSelection } from './registry.mjs';
import { allocationGuideRows, chatGptPickerModels, recommendationGuide, refreshRoutingRows } from './refresh.mjs';
import { compareRecommendation, getRecommendationManifestShape } from './recommend.mjs';
import { webDeepseekState, webDeepseekDeclaration, setWebDeepseek } from './web-deepseek.mjs';
import { ROLE_BACKUP_FILE, readRoleBackups, roleBackup, setRoleBackup } from './role-backup.mjs';
import { ADVISOR_FILE, readAdvisors, setAdvisorModel } from './oracle-advisors.mjs';

export const PRIMARY_HOME_DEFAULT = 'C:/Users/USER/.omo-stable-500/home/.omo';
// Both mirror homes are absent on disk (2026-10-30), so the board has no mirror default.
export const MIRROR_HOME_DEFAULTS = [];
export const STABLE_HOME_DEFAULT = 'C:/Users/USER/.omo-stable-500/home/.omo';
// The app home. The board never writes it: openProfilesStore refuses any home that resolves here.
export const APP_HOME_NEVER_WRITE = 'C:/Users/USER/.omo';
// The switcher's recommendation table is read-only reference data; the board never
// writes it and tests inject their own object instead of touching the desktop app.
export const RECOMMENDATION_MANIFEST_DEFAULT = 'C:/Users/USER/Desktop/OpenCode_Modes/OMO_Native_Recommendation.json';
export const INVENTORY_PATH = fileURLToPath(new URL('./inventory.json', import.meta.url));
export const BACKUP_DIR = ['runtime', 'native-profile-switcher-backups'];
export const REDACTED = '<redacted>';
export const INVENTORY_STALE_LABEL = '인벤토리 갱신 필요';
export const INTERRUPTED_LABEL = '중단된 적용';
export const REAPPLY_LABEL = '다시 적용';

// The todo-3 capture's credential-key anchor. Values under these keys are never
// sent to the board.
export const CREDENTIAL_KEY = /^(apiKey|api_key|apikey|accessToken|access_token|refreshToken|refresh_token|token|secret|password|authorization)$/i;

const ROOT_KEYS = new Set(['$schema', 'formatOnMutation', 'gateway', 'categories', 'agents', 'git_master',
  'task', 'teams', 'models', 'model_profiles', 'model_profile', 'memory', 'telemetry', 'side_panel',
  'computer', 'disabled_skills', 'exclude_models', '[opencode]', '[native]', '[senpi]', '[codex]', 'profiles',
  '_migrations', 'legacy_migrations']);
const NATIVE_KEYS = new Set(['formatOnMutation', 'gateway', 'categories', 'agents', 'git_master', 'task',
  'teams', 'models', 'model_profiles', 'model_profile', 'memory', 'telemetry', 'side_panel',
  'computer', 'disabled_skills', 'exclude_models']);
const AGENT_ENTRY_KEYS = new Set(['description', 'prompt', 'model', 'models', 'reasoning', 'variant',
  'reasoningEffort', 'tools', 'execution_mode', 'background', 'max_depth', 'allowed_subagents',
  'disallowed_tools', 'max_turns', 'temperature', 'disable', 'permission', 'prompt_append']);
const PRIMARY_AGENT_KEYS = new Set(AGENT_IDS);
const CHANGE_KINDS = new Set(['selectProfile', 'setRoute', 'setRoleBackup', 'setMain', 'setModelProfile',
  'setSummarizer', 'setMemoryRow', 'setAgentLane', 'setAgentPin', 'resetAgentMemory',
  'migrateReviewerKeys', 'setAdvisor']);
const BODY_KEYS = ['action', 'changes', 'expected', 'rosterRevision'];
const SHA256 = /^[0-9a-f]{64}$/;
const RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY']);
const MAX_CHANGES = 64;
const MAX_DIFF_ENTRIES = 400;
const UTF8 = 'utf8';

function refusal(code, message = '', extra = {}) {
  const status = extra.status ?? (code === 'STALE' || code === 'COMMENTS_PRESENT' || code === 'INVENTORY_STALE'
    || code === 'MISSING_CONFIG' ? 409 : 400);
  return { ok: false, code, status, message, ...extra };
}

// Resolves without touching the filesystem, so every spelling of one home compares equal.
function homeKey(home) {
  return win32.resolve(String(home)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = CREDENTIAL_KEY.test(key) && item !== null ? REDACTED : redact(item);
  }
  return out;
}

// ── text format ────────────────────────────────────────────────────────────────
// Windows PowerShell 5.1 emits 4-space indents, `":  "` separators and CRLF;
// JSON.stringify emits 2-space indents, `": "` and LF. Both are preserved, as are a
// UTF-8 BOM and the presence of a trailing newline.
export function detectStyle(text) {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  let indent = '  ';
  for (const line of body.split(/\r?\n/)) {
    const match = /^([ \t]+)"/.exec(line);
    if (match) { indent = match[1]; break; }
  }
  let keySep = ': ';
  const sep = /"[^"\r\n]*"(:[ \t]*)/.exec(body);
  if (sep) keySep = sep[1];
  const trailingNewline = /\r?\n$/.test(body);
  return { bom, eol, indent, keySep, trailingNewline };
}

function serializeValue(value, style, depth) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const inner = style.indent.repeat(depth + 1);
  const outer = style.indent.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => inner + serializeValue(item, style, depth + 1));
    return `[${style.eol}${items.join(`,${style.eol}`)}${style.eol}${outer}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const items = entries.map(([key, item]) =>
    `${inner}${JSON.stringify(key)}${style.keySep}${serializeValue(item, style, depth + 1)}`);
  return `{${style.eol}${items.join(`,${style.eol}`)}${style.eol}${outer}}`;
}

export function formatJsonText(value, style) {
  const body = serializeValue(value, style, 0);
  return `${style.bom ? '\uFEFF' : ''}${body}${style.trailingNewline ? style.eol : ''}`;
}

const DEFAULT_STYLE = { bom: false, eol: '\n', indent: '  ', keySep: ': ', trailingNewline: true };

export function hasComments(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '/' && (body[i + 1] === '/' || body[i + 1] === '*')) return true;
  }
  return false;
}

// ── atomic text write (the contract's algorithm, byte payloads) ────────────────
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function atomicWriteText(file, data, options = {}) {
  const fs = options.fs ?? nodeFs;
  const directory = dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), UTF8);
  const temporary = join(directory, `${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* the write error wins */ } }
    try { fs.unlinkSync(temporary); } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
    throw error;
  }
  let retries = 0;
  for (;;) {
    try {
      fs.renameSync(temporary, file);
      return { destination: file, retries, bytes: bytes.length };
    } catch (error) {
      if (!RETRYABLE_CODES.has(error?.code)) {
        try { fs.unlinkSync(temporary); } catch { /* keep the rename error */ }
        throw error;
      }
      if (retries >= RETRY_DELAYS_MS.length) {
        try { fs.unlinkSync(temporary); } catch { /* keep the rename error */ }
        const exhausted = new Error(`ATOMIC_EXHAUSTED: could not rename ${temporary} -> ${file}`);
        exhausted.code = 'ATOMIC_EXHAUSTED';
        throw exhausted;
      }
      sleepSync(RETRY_DELAYS_MS[retries]);
      retries += 1;
    }
  }
}

function stampOf(nowMs) {
  const date = new Date(nowMs);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${pad(date.getMilliseconds(), 3)}`;
}

function mirrorLabel(root, index) {
  const parent = basename(dirname(dirname(root)));
  const cleaned = parent.replace(/^[.]/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  return cleaned || `mirror-${index + 1}`;
}

// ── target specs ───────────────────────────────────────────────────────────────
function targetSpecs(roots, fs) {
  let specs = [
    { id: 'omo.jsonc', root: 'primary', rel: 'omo.jsonc', kind: 'jsonc', backup: 'omo', optional: false },
    { id: 'agent/settings.json', root: 'primary', rel: 'agent/settings.json', kind: 'json', backup: 'senpi-settings', optional: false },
    { id: 'agent/models.json', root: 'primary', rel: 'agent/models.json', kind: 'json', backup: 'models', optional: true, neverWrite: true },
    { id: 'runtime/native-profile-switcher-main.json', root: 'primary', rel: 'runtime/native-profile-switcher-main.json', kind: 'json', backup: 'main', optional: true },
    { id: ROLE_BACKUP_FILE, root: 'primary', rel: ROLE_BACKUP_FILE, kind: 'json', backup: 'role-backups', optional: true },
    { id: 'native-profile-selection.json', root: 'primary', rel: 'native-profile-selection.json', kind: 'json', backup: 'selection', optional: true },
    { id: 'agent/native-profile-selection.json', root: 'primary', rel: 'agent/native-profile-selection.json', kind: 'json', backup: 'agent-selection', optional: true },
    { id: 'stable/omo.jsonc', root: 'stable', rel: 'omo.jsonc', kind: 'jsonc', backup: 'stable-omo', optional: true },
    { id: 'stable/agent/models.json', root: 'stable', rel: 'agent/models.json', kind: 'json', backup: 'stable-models', optional: true, neverWrite: true },
    { id: 'agent/primary-agents/roster.json', root: 'stable', rel: 'agent/primary-agents/roster.json', kind: 'roster', backup: 'roster', optional: true },
    { id: ADVISOR_FILE, root: 'primary', rel: ADVISOR_FILE, kind: 'json', backup: 'oracle-advisor-routing', optional: true },
  ];
  // One home for both roles: its omo.jsonc is already the primary target, so a stable copy would write the same file twice.
  if (homeKey(roots.primaryHome) === homeKey(roots.stableHome)) {
    specs = specs.filter((spec) => spec.id !== 'stable/omo.jsonc' && spec.id !== 'stable/agent/models.json');
  }
  for (const [index, root] of roots.mirrorHomes.entries()) {
    const label = mirrorLabel(root, index);
    let exists = false;
    try { exists = fs.statSync(join(root, 'omo.jsonc')).isFile(); } catch { exists = false; }
    if (!exists) continue;
    const prefix = `mirror/${label}`;
    specs.push(
      { id: `${prefix}/omo.jsonc`, root: 'mirror', rel: `${label}/omo.jsonc`, kind: 'jsonc', backup: `${label}-omo`, optional: false, mirrorRoot: root },
      { id: `${prefix}/agent/settings.json`, root: 'mirror', rel: `${label}/agent/settings.json`, kind: 'json', backup: `${label}-senpi-settings`, optional: true, mirrorRoot: root },
      { id: `${prefix}/agent/models.json`, root: 'mirror', rel: `${label}/agent/models.json`, kind: 'json', backup: `${label}-models`, optional: true, neverWrite: true, mirrorRoot: root },
      { id: `${prefix}/runtime/native-profile-switcher-main.json`, root: 'mirror', rel: `${label}/runtime/native-profile-switcher-main.json`, kind: 'json', backup: `${label}-main`, optional: true, mirrorRoot: root },
      { id: `${prefix}/native-profile-selection.json`, root: 'mirror', rel: `${label}/native-profile-selection.json`, kind: 'json', backup: `${label}-selection`, optional: true, mirrorRoot: root },
      { id: `${prefix}/agent/native-profile-selection.json`, root: 'mirror', rel: `${label}/agent/native-profile-selection.json`, kind: 'json', backup: `${label}-agent-selection`, optional: true, mirrorRoot: root },
      { id: `${prefix}/commandcode-subscriptions.json`, root: 'mirror', rel: `${label}/commandcode-subscriptions.json`, kind: 'json', backup: `${label}-subscriptions`, optional: true, mirrorRoot: root },
    );
  }
  return specs;
}

function pathOf(spec, roots) {
  if (spec.root === 'primary') return join(roots.primaryHome, spec.rel);
  if (spec.root === 'stable') return join(roots.stableHome, spec.rel);
  return join(spec.mirrorRoot, spec.rel.slice(spec.rel.indexOf('/') + 1));
}

function readTarget(spec, file, fs, kind) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, bytes: null, text: null, value: null, style: null, error: null };
    throw error;
  }
  const text = bytes.toString(UTF8);
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let value;
  let error = null;
  try {
    value = kind === 'jsonc' ? parseJsonc(text) : JSON.parse(body);
  } catch (parseError) {
    error = parseError;
  }
  return { exists: true, bytes, text, value, error, style: detectStyle(text), comments: kind === 'jsonc' && hasComments(text) };
}

// ── validation ────────────────────────────────────────────────────────────────
function checkKeys(object, allowed, at, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${at}.${key}: not allowed by inventory.json`);
  }
}

function assertAllowedConfig(config, inventory) {
  const errors = [];
  const rootKeys = new Set(inventory?.schemaKeys?.root ?? ROOT_KEYS);
  const nativeKeys = new Set(inventory?.schemaKeys?.native ?? NATIVE_KEYS);
  const agentKeys = new Set(inventory?.schemaKeys?.agentEntry ?? AGENT_ENTRY_KEYS);
  if (!isPlainObject(config)) return { ok: false, code: 'ALLOWLIST', errors: ['$: config must be an object'] };
  checkKeys(config, rootKeys, '$', errors);
  for (const key of Object.keys(config)) {
    if (PRIMARY_AGENT_KEYS.has(key)) errors.push(`$.${key}: primary-agent keys are forbidden in omo.jsonc`);
  }
  const containers = [{ at: '$', value: config }];
  for (const [key, value] of Object.entries(config.profiles ?? {})) {
    if (!isPlainObject(value)) continue;
    containers.push({ at: `$.profiles.${key}`, value });
  }
  for (const container of containers) {
    for (const section of ['[native]', '[senpi]']) {
      const value = container.value[section];
      if (value === undefined) continue;
      if (!isPlainObject(value)) { errors.push(`${container.at}.${section}: must be an object`); continue; }
      checkKeys(value, nativeKeys, `${container.at}.${section}`, errors);
      if (isPlainObject(value.agents)) {
        for (const [role, entry] of Object.entries(value.agents)) {
          if (PRIMARY_AGENT_KEYS.has(role)) errors.push(`${container.at}.${section}.agents.${role}: primary agents are forbidden in omo.jsonc`);
          if (!isPlainObject(entry)) { errors.push(`${container.at}.${section}.agents.${role}: must be an object`); continue; }
          checkKeys(entry, agentKeys, `${container.at}.${section}.agents.${role}`, errors);
        }
      }
    }
    if (container.value !== config) {
      checkKeys(container.value, new Set([...rootKeys, '[native]', '[senpi]']), container.at, errors);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, code: 'ALLOWLIST', status: 400, errors };
}

function diffJson(before, after, at = '$', output = []) {
  if (output.length >= MAX_DIFF_ENTRIES) return output;
  if (deepEqual(before, after)) return output;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) diffJson(before[key], after[key], `${at}.${key}`, output);
    return output;
  }
  output.push({ path: at, before: before === undefined ? null : before, after: after === undefined ? null : after });
  return output;
}

function settingsDelta(before, after, at = '$', output = []) {
  if (deepEqual(before, after)) return output;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) settingsDelta(before[key], after[key], `${at}.${key}`, output);
    return output;
  }
  output.push(at);
  return output;
}

const SETTINGS_ALLOWED_PATHS = new Set(['$.defaultProvider', '$.defaultModel', '$.compaction.model', '$.compaction']);

function assertSettingsDelta(before, after) {
  const changed = settingsDelta(before, after);
  const bad = changed.filter((path) => !SETTINGS_ALLOWED_PATHS.has(path));
  if (bad.length > 0) return { ok: false, code: 'PROTECTED_SETTING', status: 400, errors: bad };
  if (changed.includes('$.compaction') && isPlainObject(after?.compaction)
    && Object.keys(after.compaction).some((key) => key !== 'model')) {
    return { ok: false, code: 'PROTECTED_SETTING', status: 400, errors: ['$.compaction'] };
  }
  if (!deepEqual(before?.extensions, after?.extensions)) {
    return { ok: false, code: 'PROTECTED_SETTING', status: 400, errors: ['$.extensions'] };
  }
  if (!deepEqual(before?.packages, after?.packages)) {
    return { ok: false, code: 'PROTECTED_SETTING', status: 400, errors: ['$.packages'] };
  }
  return { ok: true };
}

function validatePinForAgent(agentId, pin) {
  if (pin === null) return { ok: true };
  if (!isPlainObject(pin)) return { ok: false, code: 'INVALID_PIN', status: 400, message: 'pin must be null or an object' };
  const keys = Object.keys(pin).sort();
  if (keys.join(',') !== 'modelId,provider,thinking') {
    return { ok: false, code: 'INVALID_PIN', status: 400, message: 'pin must have exactly provider, modelId, thinking' };
  }
  if (typeof pin.provider !== 'string' || typeof pin.modelId !== 'string' || typeof pin.thinking !== 'string') {
    return { ok: false, code: 'INVALID_PIN', status: 400, message: 'pin fields must be strings' };
  }
  if (!THINKING.includes(pin.thinking)) {
    return { ok: false, code: 'INVALID_PIN', status: 400, message: `unknown thinking level ${pin.thinking}` };
  }
  if (agentId === 'hephaestus' && !pin.modelId.startsWith('gpt-')) {
    return { ok: false, code: 'INVALID_PIN', status: 400, message: 'Hephaestus accepts only gpt-* model ids' };
  }
  return { ok: true };
}

function exactKeys(object, keys, label) {
  if (!isPlainObject(object)) return `${label} must be an object`;
  const actual = Object.keys(object).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    return `${label} must have exactly ${wanted.join(', ')}`;
  }
  return null;
}

function changeError(change, index) {
  const at = `changes[${index}]`;
  if (!isPlainObject(change)) return `${at} must be an object`;
  if (!CHANGE_KINDS.has(change.kind)) return `${at}.kind is unknown`;
  const allowed = {
    selectProfile: ['kind', 'profileKey'],
    setRoute: ['kind', 'profileKey', 'section', 'role', 'provider', 'model', 'thinking', 'alias'],
    setRoleBackup: ['kind', 'profileKey', 'section', 'role', 'alias', 'provider', 'model', 'thinking'],
    setMain: ['kind', 'provider', 'model', 'thinking', 'profileKey'],
    setModelProfile: ['kind', 'selection', 'literal', 'profileKey'],
    setSummarizer: ['kind', 'modelId'],
    setMemoryRow: ['kind', 'row', 'mode', 'model', 'reasoning', 'profileKey'],
    setAgentLane: ['kind', 'agentId', 'lane'],
    setAgentPin: ['kind', 'agentId', 'pin'],
    resetAgentMemory: ['kind', 'agentId'],
    migrateReviewerKeys: ['kind', 'preimageSha256'],
    setAdvisor: ['kind', 'advisor', 'provider', 'model', 'thinking'],
  }[change.kind];
  const unknown = Object.keys(change).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) return `${at}.${unknown[0]} is not allowed`;
  if (change.kind === 'setMemoryRow' && change.row !== undefined
    && change.row !== 'kibitzer' && change.row !== 'reflection') {
    return `${at}.row must be kibitzer or reflection`;
  }
  return null;
}

function validateBody(body, allowedTargets) {
  if (!isPlainObject(body)) return refusal('BAD_REQUEST', 'body must be a JSON object');
  const exact = exactKeys(body, BODY_KEYS, 'body');
  if (exact) return refusal('BAD_REQUEST', exact);
  if (body.action !== 'preview' && body.action !== 'apply') return refusal('BAD_REQUEST', 'action must be preview or apply');
  if (!Array.isArray(body.changes) || body.changes.length > MAX_CHANGES) return refusal('BAD_REQUEST', 'changes must be an array');
  for (const [index, change] of body.changes.entries()) {
    const error = changeError(change, index);
    if (error) return refusal('BAD_REQUEST', error);
  }
  if (!isPlainObject(body.expected)) return refusal('BAD_REQUEST', 'expected must be an object');
  for (const [id, value] of Object.entries(body.expected)) {
    if (!allowedTargets.has(id)) return refusal('BAD_REQUEST', `expected.${id} is not a target`);
    if (value !== null && !(typeof value === 'string' && SHA256.test(value))) {
      return refusal('BAD_REQUEST', `expected.${id} must be a sha256 or null`);
    }
  }
  if (!Number.isInteger(body.rosterRevision) || body.rosterRevision < 0) {
    return refusal('BAD_REQUEST', 'rosterRevision must be an integer >= 0');
  }
  return { ok: true };
}

// ── store ──────────────────────────────────────────────────────────────────────
// Every option openProfilesStore reads. A key outside this list used to be dropped
// silently: a test that passed `roots:` got the live default homes and applied to them.
// The three homes are named together or not at all. None named is the extension's call
// on the live homes; a home left out of a fixture would fall back to a live one.
const STORE_OPTION_KEYS = new Set(['primaryHome', 'stableHome', 'mirrorHomes', 'pluginPath', 'inventoryPath',
  'inventory', 'recommendationManifestPath', 'recommendationManifest', 'registry', 'registryModels', 'registries',
  'composer', 'lib', 'timeoutMs', 'hooks', 'journal', 'now', 'fs']);
const HOME_OPTION_KEYS = ['primaryHome', 'stableHome', 'mirrorHomes'];

export function openProfilesStore(options = {}) {
  // Both checks run before any file is read or written.
  const unknownKeys = Object.keys(options).filter((key) => !STORE_OPTION_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw Object.assign(new Error(`openProfilesStore does not read ${unknownKeys.join(', ')}; `
      + `its options are ${[...STORE_OPTION_KEYS].join(', ')}`), { code: 'UNKNOWN_OPTION', keys: unknownKeys });
  }
  // The app home is never a root, however it is spelled or nested. Pure: this runs before any file is touched.
  const guardedRoots = [options.primaryHome ?? PRIMARY_HOME_DEFAULT, options.stableHome ?? STABLE_HOME_DEFAULT,
    ...(options.mirrorHomes ?? MIRROR_HOME_DEFAULTS)];
  const appKey = homeKey(APP_HOME_NEVER_WRITE);
  if (guardedRoots.some((home) => {
    const key = homeKey(home);
    return key === appKey || key.startsWith(`${appKey}/`);
  })) {
    throw Object.assign(new Error(`openProfilesStore refuses ${APP_HOME_NEVER_WRITE}: the board never writes the app home`),
      { code: 'APP_HOME_REFUSED' });
  }
  const missingHomes = HOME_OPTION_KEYS.filter((key) => options[key] === undefined || options[key] === null);
  if (missingHomes.length > 0 && missingHomes.length < HOME_OPTION_KEYS.length) {
    throw Object.assign(new Error(`openProfilesStore: ${missingHomes.join(', ')} missing; name every home or none `
      + '(none = the live homes)'), { code: 'PARTIAL_HOMES', missing: missingHomes });
  }
  const fs = options.fs ?? nodeFs;
  const nowFn = options.now ?? Date.now;
  const roots = {
    primaryHome: options.primaryHome ?? PRIMARY_HOME_DEFAULT,
    mirrorHomes: options.mirrorHomes ?? MIRROR_HOME_DEFAULTS,
    stableHome: options.stableHome ?? STABLE_HOME_DEFAULT,
  };
  // No plugin given: the inventory cannot be checked, so it is stale and read-only (fail closed).
  const pluginPath = options.pluginPath ?? null;
  const inventoryPath = options.inventoryPath ?? INVENTORY_PATH;
  const hooks = options.hooks ?? {};
  const journalEnabled = options.journal !== false;
  const recommendationManifestPath = options.recommendationManifestPath ?? RECOMMENDATION_MANIFEST_DEFAULT;
  const agentDir = join(roots.stableHome, 'agent');
  const journalPath = join(agentDir, 'primary-agents', 'apply-journal.json');
  const backupDir = join(roots.primaryHome, ...BACKUP_DIR);

  function loadInventory() {
    if (options.inventory) return options.inventory;
    try { return JSON.parse(fs.readFileSync(inventoryPath, UTF8)); } catch { return null; }
  }

  function readRecommendationManifest() {
    if (Object.hasOwn(options, 'recommendationManifest')) {
      return { manifest: isPlainObject(options.recommendationManifest) ? clone(options.recommendationManifest) : null, warning: null };
    }
    let text;
    try {
      text = fs.readFileSync(recommendationManifestPath, UTF8);
    } catch (error) {
      if (error?.code === 'ENOENT') return { manifest: null, warning: null };
      return { manifest: null, warning: `recommendation manifest unreadable: ${error.message}` };
    }
    try {
      const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''));
      getRecommendationManifestShape(parsed);
      return { manifest: parsed, warning: null };
    } catch (error) {
      return { manifest: null, warning: `recommendation manifest ignored: ${error.message}` };
    }
  }

  function readExternalMemorySelector() {
    const sourceFile = join(roots.primaryHome, 'memory-model-selection.json');
    const view = {
      sourceFile, sourcePath: '$.modelAlias', storedValue: null,
      runtimeEffect: 'unproven', label: '별도 저장값 · runtime 효력 미입증',
    };
    try {
      const value = JSON.parse(String(fs.readFileSync(sourceFile, UTF8)).replace(/^\uFEFF/, ''));
      return typeof value?.modelAlias === 'string'
        ? { ...view, storedValue: value.modelAlias, reason: null }
        : { ...view, reason: 'invalid-selector' };
    } catch (error) {
      return { ...view, reason: error?.code === 'ENOENT' ? 'missing-selector' : 'unreadable-selector' };
    }
  }

  function agentDirOf(homeKey) {
    if (homeKey === 'primary') return join(roots.primaryHome, 'agent');
    if (homeKey === 'stable') return join(roots.stableHome, 'agent');
    for (const [index, root] of roots.mirrorHomes.entries()) {
      if (mirrorLabel(root, index) === homeKey) return join(root, 'agent');
    }
    return join(roots.primaryHome, 'agent');
  }

  function baseHomeRegistry(homeKey) {
    if (options.registries) {
      const reg = options.registries[homeKey] ?? (options.registries.get ? options.registries.get(homeKey) : null);
      if (reg) return reg;
    }
    if (typeof options.composer === 'function') {
      return options.composer(agentDirOf(homeKey));
    }
    return composeHomeRegistry(agentDirOf(homeKey), { lib: options.lib, timeoutMs: options.timeoutMs });
  }
  function getHomeRegistry(homeKey) {
    const registry = baseHomeRegistry(homeKey);
    const model = webDeepseekDeclaration(join(agentDirOf(homeKey), 'web-deepseek'));
    if (!model || registry.unknown) return registry;
    const modelId = `${model.provider}/${model.id}`;
    return { ...registry, models: [...registry.models.filter((item) => item.modelId !== modelId),
      { provider: model.provider, modelId, friendlyName: model.name,
        reasoning: model.reasoning, levels: ['off'] }] };
  }

  function getRequiredHomes() {
    const list = ['primary', 'stable'];
    for (const [index, root] of roots.mirrorHomes.entries()) {
      let exists = false;
      try { exists = fs.statSync(join(root, 'omo.jsonc')).isFile(); } catch { exists = false; }
      if (exists) list.push(mirrorLabel(root, index));
    }
    return list;
  }

  // The host registry is handed over as a getter: extension.mjs points it at the live
  // session context, while tests pass an array. Only the ChatGPT-subscription models
  // are added to the picker, so the catalog stays the source of every other provider.
  function registryPickerModels() {
    const source = options.registry ?? options.registryModels ?? [];
    let available;
    try { available = typeof source === 'function' ? source() : source; } catch { available = []; }
    if (available && typeof available.getAvailable === 'function') {
      try { available = available.getAvailable(); } catch { available = []; }
    }
    const models = [];
    if (Array.isArray(available)) {
      for (const item of available) {
        if (typeof item === 'string') {
          const at = item.indexOf('/');
          models.push(at > 0 ? { provider: item.slice(0, at), id: item.slice(at + 1) } : { provider: null, id: item });
          continue;
        }
        if (!isPlainObject(item)) continue;
        const raw = typeof item.id === 'string' ? item.id
          : typeof item.modelId === 'string' ? item.modelId
            : typeof item.model === 'string' ? item.model : '';
        if (!raw) continue;
        let provider = typeof item.provider === 'string' ? item.provider : null;
        let id = raw;
        const at = raw.indexOf('/');
        if (at > 0) {
          const prefix = raw.slice(0, at);
          if (!provider || provider === prefix) {
            provider = provider ?? prefix;
            id = raw.slice(at + 1);
          }
        }
        models.push({ provider, id });
      }
    }
    const picks = chatGptPickerModels({ registryModels: models }).map((id) => ({
      provider: CHATGPT_SUBSCRIPTION_PROVIDER_CHOICE,
      model: `${CHATGPT_SUBSCRIPTION_PROVIDER_CHOICE}/${id}`,
    }));
    const webModel = webDeepseekDeclaration(join(agentDir, 'web-deepseek'));
    if (webModel) picks.push({ provider: webModel.provider, model: `${webModel.provider}/${webModel.id}`, levels: ['off'] });
    return picks;
  }

  // Agent definition files the engine serves besides its builtins (agents/<id>.md, e.g. ouroboros).
  function agentFiles() {
    try {
      return fs.readdirSync(join(roots.primaryHome, 'agent', 'agents'))
        .filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  function routingRowsFor(inventory, layer) {
    if (!inventory) return buildRoutingRows({ inventory: ROLE_INVENTORY, layer });
    try {
      return refreshRoutingRows({ inventory, layer, agentFiles: agentFiles() });
    } catch {
      return buildRoutingRows({ inventory: ROLE_INVENTORY, layer });
    }
  }

  function attachRecommendations(rows, catalog, layer, manifest, sourcePath) {
    // expandLayerRoles resolves inherited category routes exactly like the switcher's
    // comparison; compareRecommendation then reports the real status per route.
    const expanded = expandLayerRoles({ catalog, layer }).map(newRouteRow);
    const routes = new Map(expanded.map((row) => [`${row.Section}/${row.Role}`, row]));
    const comparison = compareRecommendation(expanded, manifest);
    const byKey = new Map(comparison.Items.map((item) => [`${item.Section}/${item.Role}`, item]));
    for (const row of rows) {
      const key = `${row.section}/${row.role}`;
      let item = byKey.get(key);
      if (!item) {
        // A role that exists only in the 5.1.44 inventory is not in expandLayerRoles;
        // compare its own row so it still carries a real status, never 'unknown'.
        const alias = typeof row.model === 'string' ? row.model : '';
        const entry = alias && isPlainObject(catalog) ? catalog[alias] : null;
        const unresolved = Boolean(alias)
          && !(isPlainObject(entry) && typeof entry.model === 'string' && entry.model.trim());
        item = compareRecommendation([{
          Section: row.section,
          Role: row.role,
          ModelKey: alias,
          ModelId: unresolved ? '' : String(entry?.model ?? ''),
          Variant: entry ? getMemoryReasoning(entry) : String(row.reasoning ?? ''),
          Unresolved: unresolved,
          EffectiveAlias: '',
          EffectiveCategory: '',
          BadgeEn: String(row.BadgeEn ?? ''),
        }], manifest).Items[0];
      }
      row.recommendation = item;
      const route = routes.get(key);
      const alias = route?.ModelKey ?? '';
      const entry = alias ? catalog?.[alias] : null;
      const effectiveAlias = route?.EffectiveAlias ?? '';
      const effectiveCategory = route?.EffectiveCategory ?? '';
      row.current = {
        sourceFile: join(roots.primaryHome, 'omo.jsonc'),
        sourcePath: `${sourcePath}.${row.section}[${JSON.stringify(row.role)}].model`,
        alias,
        modelId: route?.ModelId ?? '',
        thinking: route?.Variant ?? '',
        effective: Boolean(route?.ModelId),
        unresolved: Boolean(route?.Unresolved),
        reason: route?.Unresolved ? `unresolved-alias: ${alias}` : alias ? null : 'no-explicit-alias',
        ...(typeof entry?.description === 'string' ? { description: entry.description } : {}),
      };
      const coverage = manifest?.coverage?.find((entry) => entry?.route
        && entry.section === row.section && entry.role === row.role);
      row.recommended = {
        ...item, status: item.Status,
        provenance: {
          manifestPath: recommendationManifestPath,
          available: manifest !== null,
          snapshotDate: manifest?.snapshotDate ?? null,
          // Its web URLs can name an older release; provenance identifies the
          // comparison input while guide.sources keeps the installed pins.
          sources: (manifest?.sources ?? []).map(({ path, blobSha }) => ({ path, blobSha })),
          expectationRole: coverage?.expectationRole ?? null,
        },
      };
      const linkedEntry = effectiveAlias ? catalog?.[effectiveAlias] : null;
      const candidates = row.section === 'agents' ? [...(BUILTIN_ROLE_CATEGORIES[row.role] ?? [])] : [];
      row.linked = {
        candidates,
        active: !alias && candidates.length > 0,
        EffectiveCategory: effectiveCategory,
        EffectiveAlias: effectiveAlias,
        effective: Boolean(effectiveCategory && effectiveAlias),
        modelId: linkedEntry?.model ?? '',
        thinking: linkedEntry ? getMemoryReasoning(linkedEntry) : '',
        reason: alias ? 'explicit-alias' : candidates.length === 0 ? 'no-linked-category'
          : effectiveAlias ? null : 'no-registered-category-model',
        ...(typeof linkedEntry?.description === 'string' ? { description: linkedEntry.description } : {}),
      };
    }
    return comparison;
  }

  function specs() {
    return targetSpecs(roots, fs);
  }

  function targets() {
    const map = new Map();
    for (const spec of specs()) map.set(spec.id, { ...spec, path: pathOf(spec, roots) });
    return map;
  }

  function inventoryStatus() {
    const inventory = loadInventory();
    const pinned = inventory?.sources?.omo?.sha256 ?? null;
    if (!pluginPath) {
      return {
        version: inventory?.version ?? null, path: null, manifestPath: inventoryPath, pinnedSha256: pinned,
        loadedSha256: null, stale: true, reason: 'plugin_unknown', label: INVENTORY_STALE_LABEL, readOnly: true,
      };
    }
    let loaded = null;
    try { loaded = sha256(fs.readFileSync(pluginPath)); } catch { loaded = null; }
    const stale = !pinned || !loaded || pinned !== loaded;
    return {
      version: inventory?.version ?? null,
      path: pluginPath,
      manifestPath: inventoryPath,
      pinnedSha256: pinned,
      loadedSha256: loaded,
      stale,
      label: stale ? INVENTORY_STALE_LABEL : null,
      readOnly: stale,
    };
  }

  function readAll({ tolerateUnreadableRoster = false } = {}) {
    const files = new Map();
    for (const [id, spec] of targets()) {
      try {
        files.set(id, { ...spec, ...readTarget(spec, spec.path, fs, spec.kind) });
      } catch (error) {
        if (!tolerateUnreadableRoster || spec.kind !== 'roster') throw error;
        files.set(id, { ...spec, exists: true, bytes: null, value: null, error });
      }
    }
    return files;
  }

  function readJournal() {
    try {
      const value = JSON.parse(fs.readFileSync(journalPath, UTF8));
      if (!isPlainObject(value)) return { raw: null, warning: 'journal is not an object' };
      return { raw: value, warning: null };
    } catch (error) {
      if (error?.code === 'ENOENT') return { raw: null, warning: null };
      return { raw: null, warning: `journal unreadable: ${error.message}` };
    }
  }

  function journalView() {
    const { raw, warning } = readJournal();
    if (!raw) return warning ? { status: 'unknown', label: warning, action: null } : null;
    const visible = { ...raw };
    // Before-images stay on disk; the page needs only status, hashes and the request.
    delete visible.plan;
    if (raw.status === 'running') {
      const request = isPlainObject(raw.request) ? raw.request : null;
      const changes = Array.isArray(request?.changes) ? clone(request.changes) : null;
      return {
        ...visible, status: 'interrupted', sourceStatus: 'running', label: INTERRUPTED_LABEL, action: REAPPLY_LABEL,
        // The explicit 다시 적용 control resubmits exactly these changes through the same
        // protected apply path with fresh expected hashes, resuming its recorded plan.
        // Neither state() nor startup submits it.
        reapply: changes ? {
          changes,
          rosterRevision: Number.isInteger(request.rosterRevision) ? request.rosterRevision : 0,
        } : null,
      };
    }
    return visible;
  }

  function activeProfile(files) {
    for (const id of ['native-profile-selection.json', 'agent/native-profile-selection.json']) {
      const value = files.get(id)?.value;
      if (!isPlainObject(value)) continue;
      const key = typeof value.key === 'string'
        ? value.key
        : PROFILE_META.find((profile) => profile.omoProfile === value.profile)?.key;
      const profile = key ? getProfile(key) : null;
      if (profile) return profile;
    }
    return null;
  }

  function layerOf(config, profile) {
    const entry = profile ? config?.profiles?.[profile.omoProfile] : null;
    return entry?.['[senpi]'] ?? entry?.['[native]'] ?? null;
  }

  function layerPath(config, profile) {
    const entry = profile ? config?.profiles?.[profile.omoProfile] : null;
    const section = entry?.['[senpi]'] ? '[senpi]' : '[native]';
    return `$.profiles[${JSON.stringify(profile?.omoProfile ?? '')}][${JSON.stringify(section)}]`;
  }

  function state() {
    const files = readAll({ tolerateUnreadableRoster: true });
    const inventoryView = inventoryStatus();
    const inventoryRaw = loadInventory();
    const configFile = files.get('omo.jsonc');
    const settingsFile = files.get('agent/settings.json');
    const sidecarFile = files.get('runtime/native-profile-switcher-main.json');
    const profile = activeProfile(files);
    const config = configFile?.value ?? null;
    const settings = settingsFile?.value ?? null;
    const sidecar = sidecarFile?.value ?? null;
    const roleBackupsFile = files.get(ROLE_BACKUP_FILE);
    let roleBackups = { version: 1, profiles: {} };
    let roleBackupsError = roleBackupsFile?.error?.message ?? null;
    try { roleBackups = readRoleBackups(roleBackupsFile?.value); }
    catch (error) { roleBackupsError = error.message; }
    const rosterRead = readRoster(agentDir, { fs });
    const layer = layerOf(config, profile);
    const catalog = config?.['[native]']?.models ?? config?.['[senpi]']?.models ?? null;
    const warnings = [];
    if (roleBackupsError) warnings.push(`role backups: ${roleBackupsError}`);
    if (rosterRead.warning) warnings.push(rosterRead.warning.message ?? rosterRead.warning);
    if (configFile?.error) warnings.push(`omo.jsonc: ${configFile.error.message}`);
    if (settingsFile?.error) warnings.push(`agent/settings.json: ${settingsFile.error.message}`);
    const requiredHomes = getRequiredHomes();
    const homeRegistries = {};
    const unknownHomes = [];
    for (const h of requiredHomes) {
      const reg = getHomeRegistry(h);
      homeRegistries[h] = reg;
      if (!reg || reg.unknown) unknownHomes.push(h);
    }

    // Every model the state shows gets its verdict from the one support decision (registry.mjs supportStatusFor), the
    // one its write is validated with, so the view only words the code and home it is given.
    const supportOf = supportStatusFor(homeRegistries, requiredHomes);
    const homeSupport = requiredHomes.map((h) => [h, supportStatusFor(homeRegistries, [h])]);
    // A shown value the engine refuses carries that refusal: its code and the first home that refuses it (IS-6).
    const withSupport = (target, modelId) => {
      const status = modelId ? supportOf(modelId) : { ok: true };
      if (!status.ok) {
        target.unsupported = true;
        target.unsupportedReason = status.code;
        target.unsupportedHome = status.home;
      }
      return target;
    };

    if (catalog) {
      for (const [, entry] of Object.entries(catalog)) {
        if (!isPlainObject(entry)) continue;
        const status = supportOf(entry.model);
        entry.served = Object.fromEntries(homeSupport.map(([h, supportIn]) => [h, supportIn(entry.model).ok]));
        entry.levels = status.ok ? status.levels : [];
        withSupport(entry, entry.model);
      }
    }

    // The main row gets a role row's verdict, on the id the main write validates: the model qualified by its
    // provider (registry.mjs validateSelection). The view flags a saved main model outside the catalog with it.
    const withMainServed = (main) => withSupport(main, getFullModelId(main.effective.provider, main.effective.model));

    const advisorFile = files.get(ADVISOR_FILE);
    let advisorRows = [];
    let advisorError = advisorFile?.error?.message ?? null;
    if (!advisorError) {
      try { advisorRows = readAdvisors(advisorFile?.value).map((row) => withSupport(row, row.model)); }
      catch (error) { advisorError = error.message; }
    }
    if (advisorError) warnings.push(`oracle advisors: ${advisorError}`);

    const rows = routingRowsFor(inventoryRaw, layer).map((row) => {
      const entry = layer?.[row.section]?.[row.role];
      const model = isPlainObject(entry) ? entry.model ?? null : null;
      const reasoning = isPlainObject(entry) ? entry.reasoning ?? entry.variant ?? null : null;
      const canonical = model && catalog?.[model]?.model ? catalog[model].model : model;
      return withSupport({
        ...row,
        model,
        reasoning,
        backup: roleBackup(roleBackups, profile?.omoProfile, row.section, row.role, catalog),
      }, canonical);
    });
    const manifestRead = readRecommendationManifest();
    if (manifestRead.warning) warnings.push(manifestRead.warning);
    const recommendation = attachRecommendations(rows, catalog, layer, manifestRead.manifest, layerPath(config, profile));
    let guide = null;
    if (inventoryRaw) {
      try {
        // The switcher's manifest still names 5.1.33 in its source URLs; only its
        // descriptive fields belong in the 5.1.44 guide, whose pins come from inventory.
        guide = recommendationGuide({
          inventory: inventoryRaw,
          manifest: manifestRead.manifest
            ? { title: manifestRead.manifest.title, snapshotDate: manifestRead.manifest.snapshotDate }
            : null,
        });
      } catch (error) {
        warnings.push(`recommendation guide: ${error.message}`);
      }
    }
    // Use the host's find/getAvailable semantics, just as the extension adapter
    // does. A catalog or composed home registry cannot prove host availability.
    let hostRegistry;
    let registryReason = 'no-registry';
    let available = [];
    try {
      hostRegistry = typeof options.registry === 'function' ? options.registry() : options.registry;
      if (hostRegistry) {
        available = typeof hostRegistry.getAvailable === 'function' ? hostRegistry.getAvailable() : [];
      }
    } catch {
      hostRegistry = null;
      registryReason = 'registry-unreadable';
    }
    const providerOf = (model) => model?.provider ?? model?.providerId ?? null;
    const modelIdOf = (model) => model?.id ?? model?.modelId ?? null;
    const adapter = {
      find(provider, modelId) {
        if (typeof provider === 'string' && provider.length > 0) {
          if (typeof hostRegistry?.find === 'function') return hostRegistry.find(provider, modelId);
          return available.find((model) => providerOf(model) === provider && modelIdOf(model) === modelId);
        }
        return available.filter((model) => modelIdOf(model) === modelId);
      },
      hasAuth(provider) {
        return available.some((model) => providerOf(model) === provider);
      },
    };
    const lanes = readLaneOverrides(roots.stableHome, { fs });
    // The extension owns these files; the board only projects them for display.
    const rosterAgents = {};
    for (const id of AGENT_IDS) {
      const memoryRead = readMemory(agentDir, id, { fs });
      if (memoryRead.warning) warnings.push(memoryRead.warning.message);
      const agent = rosterRead.roster.agents[id];
      let effective = {
        provider: null, modelId: null, thinking: null, origin: 'unknown',
        reason: rosterRead.warning?.code ?? registryReason,
      };
      if (hostRegistry && !rosterRead.warning) {
        const rawMain = id === 'sisyphus' && !agent.pin && typeof settings?.defaultModel === 'string'
          && settings.defaultModel.length > 0 ? settings.defaultModel : null;
        const slash = rawMain?.indexOf('/') ?? -1;
        const mainPin = rawMain === null ? null : {
          provider: slash > 0 ? rawMain.slice(0, slash) : settings.defaultProvider ?? null,
          modelId: slash > 0 ? rawMain.slice(slash + 1) : rawMain,
          thinking: settings.defaultThinkingLevel ?? null,
        };
        const roster = rosterRead.roster;
        const withPin = (pin) => ({
          ...roster, agents: { ...roster.agents, [id]: { ...agent, pin } },
        });
        try {
          // Suppress lanes on the first pass, so the lane policy never filters
          // an explicit pin, a matching memory or the settings main.
          let result = resolve({
            agentId: id, roster: mainPin ? withPin(mainPin) : roster, memory: memoryRead.memory,
            laneOverrides: { [agent.lane]: { models: [{ model: '\0piomo-no-lane' }] } }, registry: adapter,
          });
          if (mainPin && result.origin === 'pin') result = { ...result, origin: 'main' };
          if (result.unavailable) {
            result = resolve({
              agentId: id, roster: withPin(null), memory: null, laneOverrides: lanes.overrides,
              registry: {
                ...adapter,
                find(provider, modelId) {
                  const found = adapter.find(provider, modelId);
                  const allowed = (model) => providerOf(model) !== 'opencode-go' || /^muse(?:-|$)/i.test(modelId);
                  return Array.isArray(found) ? found.filter(allowed) : found && allowed(found) ? found : null;
                },
              },
            });
          }
          effective = result.unavailable
            ? { provider: null, modelId: null, thinking: null, origin: 'unavailable', reason: result.reason }
            : { ...result, reason: null };
        } catch {
          effective.reason = 'registry-unreadable';
        }
      }
      rosterAgents[id] = { ...agent, effective };
      if (memoryRead.memory) {
        rosterAgents[id].remembered = {
          provider: memoryRead.memory.model.provider,
          modelId: memoryRead.memory.model.modelId,
          thinking: memoryRead.memory.thinking,
          rosterRev: memoryRead.memory.rosterRev,
          updatedAt: memoryRead.memory.updatedAt,
        };
      }
    }
    const mainOverride = profile ? readMainOverride(sidecar, profile.omoProfile) : null;
    const main = profile ? withMainServed({
      effective: resolveMainDefaults(profile, sidecar),
      override: mainOverride,
    }) : { effective: null, override: null };
    const summarizer = settings ? readCompactionSummarizer(settings) : null;
    const externalSelector = readExternalMemorySelector();
    const guideFact = (section, role, current) => ({
      role, current,
      recommended: {
        ...compareRecommendation([{
          Section: section, Role: role, ModelKey: current.alias,
          ModelId: current.modelId, Variant: current.thinking, Unresolved: current.unresolved,
        }], null).Items[0],
        status: current.unresolved ? 'unresolved' : 'untracked',
        provenance: null,
      },
      linked: {
        candidates: [], active: false, effective: false,
        EffectiveCategory: '', EffectiveAlias: '', reason: 'not-applicable',
      },
    });
    const primaryGuide = AGENT_IDS.map((id) => {
      const agent = rosterAgents[id];
      const effective = agent.effective;
      const origin = effective.origin;
      const sourceFile = origin === 'main' ? join(roots.primaryHome, 'agent/settings.json')
        : origin === 'memory' ? join(agentDir, 'primary-agents', 'memory', `${id}.json`)
          : origin === 'pin' ? join(agentDir, 'primary-agents', 'roster.json')
            : origin === 'lane' && lanes.overrides[agent.lane] ? join(roots.stableHome, 'omo.jsonc') : null;
      const stableConfig = files.get('stable/omo.jsonc')?.value ?? config;
      const laneSection = stableConfig?.['[native]']?.model_profiles?.[agent.lane] ? '["[native]"]'
        : stableConfig?.native?.model_profiles?.[agent.lane] ? '.native' : '';
      const sourcePath = origin === 'main' ? '$.defaultModel' : origin === 'memory' ? '$.model'
        : origin === 'pin' ? `$.agents[${JSON.stringify(id)}].pin`
          : sourceFile ? `$${laneSection}.model_profiles[${JSON.stringify(agent.lane)}]` : null;
      return guideFact('primary', id, {
        ...effective, sourceFile, sourcePath, alias: '',
        modelId: effective.modelId ? getFullModelId(effective.provider, effective.modelId) : '',
        effective: Boolean(effective.modelId), unresolved: false,
      });
    });
    const summaryGuide = guideFact('summary', 'summary', {
      sourceFile: join(roots.primaryHome, 'agent/settings.json'),
      sourcePath: settings?.compaction?.model ? '$.compaction.model' : '$.compactionSummarizer',
      alias: '', modelId: summarizer ? getFullModelId(summarizer.provider, summarizer.model) : '',
      thinking: null, effective: Boolean(summarizer), unresolved: false,
      reason: summarizer ? null : 'no-summary-model',
    });
    function memoryFor(pProfile) {
      return config ? {
        kibitzer: getMemorySelectionFromConfig(config, pProfile?.omoProfile ?? ''),
        reflection: getReflectionMemorySelectionFromConfig(config, pProfile?.omoProfile ?? ''),
        externalSelector,
        candidates: getCommonServedModels(homeRegistries, requiredHomes),
      } : null;
    }
    function guideFor(pRows, pProfile, memory) {
      const memoryRows = ['kibitzer', 'reflection'].map((role) => {
        const selection = memory?.[role];
        const pointer = role === 'reflection' ? 'reflection' : 'recall';
        const scopes = [
          ['$', config], ['$["[native]"]', config?.['[native]']],
          [`$.profiles[${JSON.stringify(pProfile?.omoProfile ?? '')}]`, config?.profiles?.[pProfile?.omoProfile]],
          [layerPath(config, pProfile), layerOf(config, pProfile)],
        ];
        const source = scopes.findLast(([, value]) => value?.memory?.[pointer]?.category !== undefined);
        const categorySource = scopes.findLast(([, value]) => value?.categories?.[selection?.category]?.model !== undefined);
        const entry = selection?.alias ? getEffectiveMemoryCatalog(config)[selection.alias] : null;
        return guideFact('memory', role, {
          sourceFile: join(roots.primaryHome, 'omo.jsonc'),
          sourcePath: source ? `${source[0]}.memory.${pointer}.category` : null,
          categorySourcePath: categorySource ? `${categorySource[0]}.categories[${JSON.stringify(selection.category)}].model` : null,
          category: selection?.category ?? '', alias: selection?.alias ?? '',
          modelId: selection?.model ?? '', thinking: selection?.reasoning ?? '',
          effective: Boolean(selection?.model), unresolved: Boolean(selection?.alias && selection?.unresolved),
          reason: selection?.unresolved ? 'unresolved-memory-model' : null,
          ...(typeof entry?.description === 'string' ? { description: entry.description } : {}),
        });
      });
      return {
        ...guide,
        rows: allocationGuideRows({ primary: primaryGuide, routing: pRows, memory: memoryRows, summary: summaryGuide }),
      };
    }
    const memory = memoryFor(profile);
    const buildProfileDetail = (pMeta) => {
      const pProfile = getProfile(pMeta.key);
      const pLayer = layerOf(config, pProfile);
      const pRows = routingRowsFor(inventoryRaw, pLayer).map((row) => {
        const entry = pLayer?.[row.section]?.[row.role];
        const model = isPlainObject(entry) ? entry.model ?? null : null;
        const reasoning = isPlainObject(entry) ? entry.reasoning ?? entry.variant ?? null : null;
        const canonical = model && catalog?.[model]?.model ? catalog[model].model : model;
        return withSupport({ ...row, model, reasoning,
          backup: roleBackup(roleBackups, pProfile?.omoProfile, row.section, row.role, catalog) }, canonical);
      });
      const pRec = attachRecommendations(pRows, catalog, pLayer, manifestRead.manifest, layerPath(config, pProfile));
      const pMainOverride = pProfile ? readMainOverride(sidecar, pProfile.omoProfile) : null;
      const pMain = pProfile ? withMainServed({
        effective: resolveMainDefaults(pProfile, sidecar),
        override: pMainOverride,
      }) : { effective: null, override: null };
      const pModelProfile = settings ? getModelProfileSettings(config ?? {}, pProfile?.omoProfile ?? '') : null;
      const pMemory = memoryFor(pProfile);
      return {
        primaryBackups: Object.fromEntries(AGENT_IDS.map((id) =>
          [id, roleBackup(roleBackups, pProfile?.omoProfile, 'primary', id, catalog)])),
        routing: { rows: pRows, layer: pLayer, recommendation: pRec },
        main: pMain,
        modelProfile: pModelProfile,
        memory: pMemory,
        guide: guideFor(pRows, pProfile, pMemory),
        summarizer,
      };
    };

    const details = {};
    for (const item of PROFILE_META) {
      details[item.key] = buildProfileDetail(item);
    }

    const comments = Boolean(configFile?.comments);
    const readOnly = inventoryView.stale || comments || !configFile?.exists || !settingsFile?.exists
      || Boolean(configFile?.error) || Boolean(settingsFile?.error);
    const reason = inventoryView.stale ? 'INVENTORY_STALE'
      : comments ? 'COMMENTS_PRESENT'
        : !configFile?.exists || !settingsFile?.exists ? 'MISSING_CONFIG'
          : configFile?.error || settingsFile?.error ? 'INVALID_CONFIG' : null;
    const targetsView = {};
    for (const [id, file] of files) targetsView[id] = file.bytes ? sha256(file.bytes) : null;
    const surfacedModels = [];
    for (const [provider, surfacedIds] of Object.entries(ENGINE_SURFACED_MODELS)) {
      for (const surfacedId of surfacedIds) {
        const surfacedModelId = `${provider}/${surfacedId}`;
        if (supportOf(surfacedModelId).ok) {
          surfacedModels.push({ provider, model: surfacedModelId });
        }
      }
    }

    const view = {
      v: 1,
      generatedAt: new Date(nowFn()).toISOString(),
      readOnly,
      readOnlyReason: reason,
      banner: inventoryView.stale ? INVENTORY_STALE_LABEL : null,
      inventory: inventoryView,
      homes: {
        primary: roots.primaryHome,
        stable: roots.stableHome,
        mirrors: roots.mirrorHomes.map((root, index) => {
          let exists = false;
          try { exists = fs.statSync(join(root, 'omo.jsonc')).isFile(); } catch { exists = false; }
          return { root, label: mirrorLabel(root, index), exists };
        }),
      },
      activeProfile: profile ? { key: profile.key, omoProfile: profile.omoProfile } : null,
      profiles: PROFILE_META.map((item) => ({
        key: item.key, num: item.num, name: item.name, nameKr: item.nameKr, tag: item.tag,
        omoProfile: item.omoProfile, mainProvider: item.mainProvider, mainModel: item.mainModel,
        mainThinking: item.mainThinking, summary: item.summary,
        current: profile?.key === item.key,
      })),
      routing: { rows, layer, recommendation },
      details,
      guide: guideFor(rows, profile, memory),
      main,
      mainSettingsThinking: settings?.defaultThinkingLevel ?? null,
      modelProfile: settings ? getModelProfileSettings(config ?? {}, profile?.omoProfile ?? '') : null,
      summarizer,
      memory,
      catalog,
      registry: { unknownHomes, surfacedModels },
      registryModels: registryPickerModels().map((item) => withSupport(item, item.model)),
      roster: { revision: rosterRead.roster.revision, agents: rosterAgents, warning: rosterRead.warning },
      targets: targetsView,
      applyJournal: journalView(),
      warnings,
      webDeepseek: webDeepseekState(join(agentDir, 'web-deepseek')),
      advisors: { file: ADVISOR_FILE, exists: Boolean(advisorFile?.exists), rows: advisorRows, error: advisorError },
    };
    return redact(view);
  }

  // ── changes ────────────────────────────────────────────────────────────────
  // ── change helpers (also used for the lane mirrors) ──────────────────────
  function routeChange(config, change, fallbackProfile) {
    const profileKey = change.profileKey ?? fallbackProfile?.omoProfile;
    if (!profileKey) throw new Error('profileKey is required');
    if (change.section !== 'agents' && change.section !== 'categories') {
      throw new Error('section must be agents or categories');
    }
    for (const field of ['role', 'provider', 'model', 'thinking']) {
      if (typeof change[field] !== 'string' || !change[field].trim()) throw new Error(`${field} is required`);
    }
    let alias = change.alias;
    if (alias !== undefined) {
      if (typeof alias !== 'string' || !alias.trim()) throw new Error('alias must be a string');
    } else {
      const catalog = (config['[senpi]'] ?? config['[native]'])?.models;
      if (!isPlainObject(catalog)) throw new Error('model catalog is missing');
      alias = getOrCreateCatalogAlias({
        catalog, provider: change.provider, model: change.model, reasoning: change.thinking,
      }).alias;
    }
    setProfileLayerModel({
      config, profileKey, section: change.section, role: change.role, alias,
      ensureCatalogAlias: change.alias === undefined,
      ensureModelId: change.model, ensureVariant: change.thinking,
    });
    return { profileKey, alias };
  }

  // Read-only companion of the WinForms -SubscriptionsPath preflight. Missing or
  // malformed means "no assignment" for the warning, never a refused write.
  function readSubscriptions() {
    try {
      const text = fs.readFileSync(join(roots.primaryHome, 'commandcode-subscriptions.json'), 'utf8');
      const value = JSON.parse(String(text).replace(/^\uFEFF/, ''));
      return isPlainObject(value) ? value : {};
    } catch {
      return {};
    }
  }

  function primarySubscriptions() {
    try {
      const text = fs.readFileSync(join(roots.primaryHome, 'commandcode-subscriptions.json'), 'utf8');
      const value = JSON.parse(String(text).replace(/^\uFEFF/, ''));
      return isPlainObject(value) ? value : null;
    } catch {
      return null;
    }
  }

  function modelProfileChange(config, change, fallbackProfile) {
    const profile = change.profileKey ? getProfile(change.profileKey) : fallbackProfile;
    if (!profile) throw new Error('an active profile is required');
    if (typeof change.selection !== 'string') throw new Error('selection is required');
    setModelProfileSelection({
      config, omoProfile: profile.omoProfile,
      selection: change.selection, literal: change.literal ?? '',
    });
  }

  function summarizerChange(settings, change) {
    const modelId = change.modelId ?? '';
    if (typeof modelId !== 'string') throw new Error('modelId must be a string');
    return setCompactionSummarizer({ settings, modelId });
  }

  function memoryRowChange(config, change, fallbackProfile) {
    if (change.mode !== 'quick' && change.mode !== 'custom') throw new Error('mode must be quick or custom');
    if (change.row === 'reflection') {
      setReflectionMemorySelection(config, change.mode, change.model ?? '', change.reasoning ?? '', fallbackProfile);
      return;
    }
    setMemorySelection(config, change.mode, change.model ?? '', change.reasoning ?? '', fallbackProfile);
  }

  function checkMemoryOwnershipInAllHomes(targetFiles, change) {
    const kind = change.row === 'reflection' ? 'reflection' : 'kibitzer';
    for (const [id, file] of targetFiles) {
      if (!file?.exists) continue;
      if (id === 'omo.jsonc' || id === 'stable/omo.jsonc' || (id.startsWith('mirror/') && id.endsWith('/omo.jsonc'))) {
        if (file.error) return refusal('INVALID_CONFIG', `${id}: ${file.error.message}`);
        const homeConfig = readConfig(file.value);
        try {
          assertMemoryRouteWritable(homeConfig, '', kind);
          for (const profileKey of Object.keys(homeConfig.profiles ?? {})) {
            assertMemoryRouteWritable(homeConfig, profileKey, kind);
          }
        } catch (error) {
          return refusal('BAD_REQUEST', error.message);
        }
      }
    }
    return { ok: true };
  }

  function applyChange(context, change) {
    const { config, settings, sidecar, selections, roster, warnings } = context;
    switch (change.kind) {
      case 'selectProfile': {
        const profile = getProfile(change.profileKey);
        if (!profile) return refusal('BAD_REQUEST', `unknown profile ${change.profileKey}`);
        if (!config) return refusal('MISSING_CONFIG', 'omo.jsonc is missing');
        if (!isPlainObject(config.profiles?.[profile.omoProfile])) {
          return refusal('BAD_REQUEST', `profile layer ${profile.omoProfile} is missing`);
        }
        mergeProfileLayerIntoActiveScopes({ config, profile });
        const main = resolveMainDefaults(profile, sidecar.value);
        settings.value.defaultProvider = main.provider;
        settings.value.defaultModel = main.model;
        const selection = selectionState(profile, new Date(nowFn()).toISOString());
        for (const id of ['native-profile-selection.json', 'agent/native-profile-selection.json']) {
          selections.set(id, selection);
        }
        for (const id of context.files.keys()) {
          if (id.startsWith('mirror/') && id.endsWith('/native-profile-selection.json')) selections.set(id, selection);
        }
        context.selectedProfile = profile;
        context.main = main;
        break;
      }
      case 'setRoute': {
        if (!config) return refusal('MISSING_CONFIG', 'omo.jsonc is missing');
        const catalog = (config['[senpi]'] ?? config['[native]'])?.models;
        const requiredHomes = getRequiredHomes();
        const homeRegistries = {};
        for (const h of requiredHomes) homeRegistries[h] = getHomeRegistry(h);

        let resolvedModel = change.model;
        let resolvedEffort = change.thinking;
        let resolvedProvider = change.provider;
        if (change.alias && catalog && catalog[change.alias]) {
          const aliasEntry = catalog[change.alias];
          resolvedModel = aliasEntry.model ?? resolvedModel;
          resolvedEffort = aliasEntry.reasoning ?? aliasEntry.variant ?? resolvedEffort;
          resolvedProvider = resolvedProvider ?? getProviderChoiceForModel(resolvedModel);
        }

        const valid = validateSelection({
          kind: 'role',
          homes: requiredHomes,
          provider: resolvedProvider,
          model: resolvedModel,
          effort: resolvedEffort,
          registries: homeRegistries,
          catalog,
        });
        if (!valid.ok) {
          return refusal(valid.code, valid.message ?? `${valid.code} in home ${valid.home}`, { home: valid.home });
        }

        let route;
        try {
          route = routeChange(config, change, context.selectedProfile ?? activeProfile(context.files));
        } catch (error) {
          return refusal('BAD_REQUEST', error.message);
        }
        const preflight = commandCodeWarning({
          catalog, alias: route.alias, registry: readSubscriptions(), profileKey: route.profileKey,
        });
        if (preflight && !warnings.includes(preflight)) warnings.push(preflight);
        context.configTouched = true;
        break;
      }
      case 'setRoleBackup': {
        if (!config) return refusal('MISSING_CONFIG', 'omo.jsonc is missing');
        const profileKey = change.profileKey ?? activeProfile(context.files)?.omoProfile;
        if (!PROFILE_META.some((p) => p.omoProfile === profileKey)
          || !isPlainObject(config.profiles?.[profileKey])) return refusal('BAD_REQUEST', 'Unknown backup profile.');
        if (!['primary', 'agents', 'categories'].includes(change.section)
          || !(change.section === 'primary' ? AGENT_IDS : ROLE_INVENTORY[change.section] ?? []).includes(change.role)) {
          return refusal('BAD_REQUEST', 'Invalid role backup selection.');
        }
        const catalog = (config['[senpi]'] ?? config['[native]'])?.models;
        const direct = ['provider', 'model', 'thinking'].some(key => Object.hasOwn(change, key));
        let selection;
        let definition;
        if (direct) {
          if (Object.hasOwn(change, 'alias')
            || ['provider', 'model', 'thinking'].some(key => typeof change[key] !== 'string' || !change[key].trim())) {
            return refusal('BAD_REQUEST', 'Choose backup service, model and reasoning explicitly.');
          }
          const fullModel = getFullModelId(change.provider, change.model);
          definition = { model: fullModel, reasoning: change.thinking };
          selection = { provider: change.provider, model: getModelIdWithoutProvider(fullModel), thinking: change.thinking };
        } else {
          if (typeof change.alias !== 'string') return refusal('BAD_REQUEST', 'Invalid backup alias.');
          definition = change.alias ? catalog?.[change.alias] : null;
        }
        if (direct || change.alias) {
          if (!isPlainObject(definition)) return refusal('BAD_REQUEST', 'Choose a registered model alias.');
          if (change.section === 'primary' && change.role === 'hephaestus'
            && !getModelIdWithoutProvider(definition.model).startsWith('gpt-')) {
            return refusal('BAD_REQUEST', 'Hephaestus accepts GPT models only.');
          }
          if (definition.model?.startsWith('opencode-go/') && !/\/(?:ocg-)?muse-/i.test(definition.model)) {
            return refusal('BAD_REQUEST', 'opencode-go supports Muse backup selections only.');
          }
          const homes = getRequiredHomes();
          const valid = validateSelection({
            kind: 'role', homes, model: direct ? definition.model : change.alias,
            provider: direct ? change.provider : undefined,
            effort: definition.reasoning ?? definition.variant ?? '',
            registries: Object.fromEntries(homes.map((home) => [home, getHomeRegistry(home)])), catalog,
          });
          if (!valid.ok) return refusal(valid.code, 'This backup is not served by every required home.');
        }
        setRoleBackup({ selections: context.roleBackups, profileKey, section: change.section, role: change.role, alias: change.alias, selection });
        break;
      }
      case 'setMain': {
        if (!settings) return refusal('MISSING_CONFIG', 'agent/settings.json is missing');
        const profile = change.profileKey ? getProfile(change.profileKey)
          : context.selectedProfile ?? activeProfile(context.files);
        if (!profile) return refusal('BAD_REQUEST', 'an active profile is required');

        if (!change.provider || !change.model || !change.thinking) {
          // Removal of main override -> fall back to profile default
          sidecar.value = setMainLayerOverride({
            state: sidecar.value,
            profileKey: profile.omoProfile,
            main: null,
          });
          const defMain = resolveMainDefaults(profile, sidecar.value);
          settings.value.defaultProvider = defMain.provider;
          settings.value.defaultModel = defMain.model;
          context.main = defMain;
          context.mainOverrides.push({ profileKey: profile.omoProfile, main: null });
          break;
        }

        const thinking = typeof change.thinking === 'string' && change.thinking.trim()
          ? change.thinking : profile.mainThinking;
        if (!THINKING.includes(thinking)) return refusal('BAD_REQUEST', `unknown thinking level ${thinking}`);

        const requiredHomes = getRequiredHomes();
        const homeRegistries = {};
        for (const h of requiredHomes) homeRegistries[h] = getHomeRegistry(h);
        const valid = validateSelection({
          kind: 'main',
          homes: requiredHomes,
          provider: change.provider,
          model: change.model,
          effort: thinking,
          registries: homeRegistries,
        });
        if (!valid.ok) {
          return refusal(valid.code, valid.message ?? `${valid.code} in home ${valid.home}`, { home: valid.home });
        }

        const main = { provider: change.provider, model: change.model, thinking };
        sidecar.value = setMainLayerOverride({
          state: sidecar.value,
          profileKey: profile.omoProfile,
          main,
        });
        settings.value.defaultProvider = change.provider;
        settings.value.defaultModel = change.model;
        context.main = main;
        // The switcher's Set-MainLayerOverride writes the same override into every
        // lane's runtime sidecar after the primary write (PS :2296-2338).
        context.mainOverrides.push({ profileKey: profile.omoProfile, main: clone(main) });
        break;
      }
      case 'setModelProfile': {
        if (!config) return refusal('MISSING_CONFIG', 'omo.jsonc is missing');
        const profile = change.profileKey ? getProfile(change.profileKey)
          : context.selectedProfile ?? activeProfile(context.files);
        if (!profile) return refusal('BAD_REQUEST', 'an active profile is required');
        try {
          modelProfileChange(config, change, profile);
        } catch (error) {
          return refusal('BAD_REQUEST', error.message);
        }
        context.configTouched = true;
        break;
      }
      case 'setSummarizer': {
        if (!settings) return refusal('MISSING_CONFIG', 'agent/settings.json is missing');
        const modelId = change.modelId ?? change.model ?? '';
        if (modelId) {
          const requiredHomes = getRequiredHomes();
          const homeRegistries = {};
          for (const h of requiredHomes) homeRegistries[h] = getHomeRegistry(h);
          const provider = change.provider ?? modelId.split('/')[0];
          const valid = validateSelection({
            kind: 'summarizer',
            homes: requiredHomes,
            provider,
            model: modelId,
            registries: homeRegistries,
          });
          if (!valid.ok) {
            return refusal(valid.code, valid.message ?? `${valid.code} in home ${valid.home}`, { home: valid.home });
          }
        }
        let result;
        try { result = summarizerChange(settings.value, change); }
        catch (error) { return refusal('BAD_REQUEST', error.message); }
        settings.value = result.settings;
        warnings.push(...result.warnings);
        break;
      }
      case 'setMemoryRow': {
        if (!config) return refusal('MISSING_CONFIG', 'omo.jsonc is missing');
        const ownership = checkMemoryOwnershipInAllHomes(context.files, change);
        if (!ownership.ok) return ownership;
        if (change.mode === 'custom') {
          const memoryHomes = getRequiredHomes();
          const homeRegistries = {};
          for (const h of memoryHomes) homeRegistries[h] = getHomeRegistry(h);
          const catalog = (config['[senpi]'] ?? config['[native]'])?.models;
          const provider = change.provider ?? (change.model?.includes('/') ? change.model.split('/')[0] : '');
          const valid = validateSelection({
            kind: change.row ?? 'memory',
            homes: memoryHomes,
            provider,
            model: change.model,
            effort: change.reasoning ?? change.thinking,
            registries: homeRegistries,
            catalog,
          });
          if (!valid.ok) {
            return refusal(valid.code, valid.message ?? `${valid.code} in home ${valid.home}`, { home: valid.home });
          }
        }
        try {
          memoryRowChange(config, change, context.selectedProfile ?? activeProfile(context.files));
        } catch (error) {
          return refusal('BAD_REQUEST', error.message);
        }
        context.configTouched = true;
        break;
      }
      case 'setAgentLane': {
        if (!AGENT_IDS.includes(change.agentId)) return refusal('BAD_REQUEST', 'unknown agentId');
        if (!LANES.includes(change.lane)) return refusal('BAD_REQUEST', 'unknown lane');
        const agent = roster.value.agents[change.agentId];
        roster.value = {
          ...roster.value,
          updatedAt: new Date(nowFn()).toISOString(),
          agents: { ...roster.value.agents, [change.agentId]: { ...agent, lane: change.lane, rev: agent.rev + 1 } },
        };
        roster.touched = true;
        break;
      }
      case 'setAgentPin': {
        if (!AGENT_IDS.includes(change.agentId)) return refusal('BAD_REQUEST', 'unknown agentId');
        const pinCheck = validatePinForAgent(change.agentId, change.pin);
        if (!pinCheck.ok) return pinCheck;
        const agent = roster.value.agents[change.agentId];
        roster.value = {
          ...roster.value,
          updatedAt: new Date(nowFn()).toISOString(),
          agents: { ...roster.value.agents, [change.agentId]: { ...agent, pin: clone(change.pin), rev: agent.rev + 1 } },
        };
        roster.touched = true;
        break;
      }
      case 'resetAgentMemory': {
        if (!AGENT_IDS.includes(change.agentId)) return refusal('BAD_REQUEST', 'unknown agentId');
        const agent = roster.value.agents[change.agentId];
        roster.value = {
          ...roster.value,
          updatedAt: new Date(nowFn()).toISOString(),
          agents: { ...roster.value.agents, [change.agentId]: { ...agent, rev: agent.rev + 1 } },
        };
        roster.touched = true;
        break;
      }
      case 'setAdvisor': {
        if (!isPlainObject(context.advisors.value)) return refusal('MISSING_CONFIG', `${ADVISOR_FILE} is missing`);
        const model = change.model.includes('/') ? change.model : `${change.provider}/${change.model}`;
        const homes = getRequiredHomes();
        const valid = validateSelection({
          kind: 'role', homes, provider: change.provider, model, effort: change.thinking,
          registries: Object.fromEntries(homes.map((home) => [home, getHomeRegistry(home)])),
        });
        if (!valid.ok) return refusal(valid.code, 'This advisor model is not served by every required home.', { home: valid.home });
        try {
          context.advisors.value = setAdvisorModel(context.advisors.value, { advisor: change.advisor, model, thinking: change.thinking });
        } catch (error) {
          return refusal(error.code === 'ADVISOR_FAMILY' ? 'ADVISOR_FAMILY' : 'BAD_REQUEST', error.message);
        }
        break;
      }
      case 'migrateReviewerKeys': {
        if (!config) return refusal('MISSING_CONFIG', 'omo.jsonc is missing');
        try {
          const raw = stripEngineSectionAlias(clone(config));
          const result = migrateReviewerKeys({
            config: raw, live: false, preimageSha256: change.preimageSha256 ?? '',
          });
          const normalized = readConfig(result.config);
          for (const key of Object.keys(config)) delete config[key];
          Object.assign(config, normalized);
        } catch (error) {
          return refusal('BAD_REQUEST', error.message);
        }
        context.configTouched = true;
        break;
      }
      default:
        return refusal('BAD_REQUEST', `unknown change kind ${change.kind}`);
    }
    return { ok: true };
  }

  function setMemorySelection(config, mode, model, reasoning, profile) {
    const engine = config['[senpi]'] ?? config['[native]'];
    if (!isPlainObject(engine)) throw new Error('model catalog is missing');
    assertMemoryRouteWritable(config, '', 'kibitzer');
    for (const key of Object.keys(config.profiles ?? {})) {
      assertMemoryRouteWritable(config, key, 'kibitzer');
    }
    if (mode === 'custom') {
      if (!model.trim() || !reasoning.trim()) throw new Error('Choose service, model and thinking explicitly.');
      if (!THINKING.includes(reasoning)) throw new Error(`unsupported thinking level ${reasoning}`);
      const catalog = getEffectiveMemoryCatalog(config);
      const alias = getOrCreateCatalogAlias({
        catalog, provider: model.split('/')[0], model, reasoning,
      }).alias;
      if (!isPlainObject(engine.models)) engine.models = {};
      if (!isPlainObject(engine.categories)) engine.categories = {};
      if (!isPlainObject(engine.memory)) engine.memory = {};
      if (!isPlainObject(engine.memory.recall)) engine.memory.recall = {};
      if (!isPlainObject(engine.models[alias])) engine.models[alias] = { model, reasoning };
      const entry = engine.models[alias];
      const entryReasoning = getMemoryReasoning(entry) || reasoning;
      // The ported owned-row check reads entry.reasoning directly, so an alias that
      // only carries `variant` is normalized here before the row points at it.
      if (typeof entry.reasoning !== 'string' || !entry.reasoning) entry.reasoning = entryReasoning;
      const expectedModel = String(entry.model ?? model);
      engine.categories['desktop-kibitzer'] = {
        description: memoryFingerprint(alias, expectedModel, entryReasoning),
        model: alias,
        reasoning: entryReasoning,
      };
      engine.memory.recall.category = 'desktop-kibitzer';
      for (const [key, entry] of Object.entries(config.profiles ?? {})) {
        if (!isPlainObject(entry)) continue;
        const state = getMemorySelectionFromConfig(config, key);
        if (state.external || state.category !== 'desktop-kibitzer' || !state.owned
          || state.model !== expectedModel || state.reasoning !== entryReasoning) {
          throw new Error(`profile ${key} defeats the common Kibitzer route (${JSON.stringify({ category: state.category, owned: state.owned, external: state.external, model: state.model, reasoning: state.reasoning, expectedModel, entryReasoning })})`);
        }
      }
      return;
    }
    const state = getMemorySelectionFromConfig(config);
    if (state.owned && isPlainObject(engine.categories)) delete engine.categories['desktop-kibitzer'];
    if (isPlainObject(engine.memory?.recall) && engine.memory.recall.category === 'desktop-kibitzer') {
      delete engine.memory.recall.category;
    }
    if (profile) {
      const planned = getMemorySelectionFromConfig(config, profile.omoProfile);
      if (planned.category !== 'quick' || planned.hasDedicated) {
        throw new Error(`profile ${profile.omoProfile} defeats the common Kibitzer route`);
      }
    }
  }

  // The original switcher's Set-ReflectionMemoryModelSelection (:3406-3468): a separate
  // owned category and the `memory.reflection.category` pointer, never `memory.recall` and
  // never `desktop-kibitzer`. Keeping this as its own function is what makes the two rows
  // independent at the store boundary.
  function setReflectionMemorySelection(config, mode, model, reasoning, profile) {
    const engine = config['[senpi]'] ?? config['[native]'];
    if (!isPlainObject(engine)) throw new Error('model catalog is missing');
    assertMemoryRouteWritable(config, '', 'reflection');
    for (const key of Object.keys(config.profiles ?? {})) {
      assertMemoryRouteWritable(config, key, 'reflection');
    }
    if (mode === 'custom') {
      if (!model.trim() || !reasoning.trim()) throw new Error('Choose service, model and thinking explicitly.');
      if (!THINKING.includes(reasoning)) throw new Error(`unsupported thinking level ${reasoning}`);
      const catalog = getEffectiveMemoryCatalog(config);
      const alias = getOrCreateCatalogAlias({
        catalog, provider: model.split('/')[0], model, reasoning,
      }).alias;
      if (!isPlainObject(engine.models)) engine.models = {};
      if (!isPlainObject(engine.categories)) engine.categories = {};
      if (!isPlainObject(engine.memory)) engine.memory = {};
      if (!isPlainObject(engine.memory.reflection)) engine.memory.reflection = {};
      if (!isPlainObject(engine.models[alias])) engine.models[alias] = { model, reasoning };
      const entry = engine.models[alias];
      const entryReasoning = getMemoryReasoning(entry) || reasoning;
      if (typeof entry.reasoning !== 'string' || !entry.reasoning) entry.reasoning = entryReasoning;
      const expectedModel = String(entry.model ?? model);
      engine.categories['desktop-reflection'] = {
        description: reflectionMemoryFingerprint(alias, expectedModel, entryReasoning),
        model: alias,
        reasoning: entryReasoning,
      };
      engine.memory.reflection.category = 'desktop-reflection';
      for (const [key, entry2] of Object.entries(config.profiles ?? {})) {
        if (!isPlainObject(entry2)) continue;
        const state = getReflectionMemorySelectionFromConfig(config, key);
        if (state.external || state.category !== 'desktop-reflection' || !state.owned
          || state.model !== expectedModel || state.reasoning !== entryReasoning) {
          throw new Error(`profile ${key} defeats the common Reflection route (${JSON.stringify({ category: state.category, owned: state.owned, external: state.external, model: state.model, reasoning: state.reasoning, expectedModel, entryReasoning })})`);
        }
      }
      return;
    }
    const state = getReflectionMemorySelectionFromConfig(config);
    if (state.owned && isPlainObject(engine.categories)) delete engine.categories['desktop-reflection'];
    if (isPlainObject(engine.memory?.reflection) && engine.memory.reflection.category === 'desktop-reflection') {
      delete engine.memory.reflection.category;
    }
    if (profile) {
      const planned = getReflectionMemorySelectionFromConfig(config, profile.omoProfile);
      if (planned.category !== 'quick' || planned.hasDedicated) {
        throw new Error(`profile ${profile.omoProfile} defeats the common Reflection route`);
      }
    }
  }

  function saveConfig(config) {
    const snapshot = stripEngineSectionAlias(clone(config));
    removeNullModelProfile(snapshot);
    return snapshot;
  }

  // ── preview/apply ──────────────────────────────────────────────────────────
  function prepare(body) {
    const validated = validateBody(body, new Set(targets().keys()));
    if (!validated.ok) return validated;
    const files = readAll();
    const inventory = inventoryStatus();
    if (inventory.stale) {
      return refusal('INVENTORY_STALE', INVENTORY_STALE_LABEL, { inventory });
    }
    const configFile = files.get('omo.jsonc');
    if (!configFile.exists) return refusal('MISSING_CONFIG', 'omo.jsonc is missing');
    if (configFile.error) return refusal('INVALID_CONFIG', `omo.jsonc: ${configFile.error.message}`);
    if (configFile.comments) return refusal('COMMENTS_PRESENT', 'omo.jsonc contains comments; refusing writes');
    const settingsFile = files.get('agent/settings.json');
    if (!settingsFile.exists) return refusal('MISSING_CONFIG', 'agent/settings.json is missing');
    if (settingsFile.error) return refusal('INVALID_CONFIG', `agent/settings.json: ${settingsFile.error.message}`);
    for (const id of ['stable/omo.jsonc', ...files.keys().filter((key) => key.startsWith('mirror/'))]) {
      const file = files.get(id);
      if (!file || !file.exists) continue;
      if (file.error) return refusal('INVALID_CONFIG', `${id}: ${file.error.message}`);
      if (file.kind === 'jsonc' && file.comments) return refusal('COMMENTS_PRESENT', `${id} contains comments`);
    }

    const config = readConfig(configFile.value);
    const settings = { value: clone(settingsFile.value) };
    const sidecarFile = files.get('runtime/native-profile-switcher-main.json');
    const sidecar = { value: sidecarFile?.exists ? clone(sidecarFile.value) : {} };
    const roleBackupsFile = files.get(ROLE_BACKUP_FILE);
    if (roleBackupsFile?.error) return refusal('INVALID_CONFIG', 'The backup selections file cannot be read.');
    let roleBackups;
    try { roleBackups = readRoleBackups(roleBackupsFile?.value); }
    catch (error) { return refusal('INVALID_CONFIG', error.message); }
    const advisorFile = files.get(ADVISOR_FILE);
    if (advisorFile?.error && body.changes.some((change) => change.kind === 'setAdvisor')) {
      return refusal('INVALID_CONFIG', `${ADVISOR_FILE}: ${advisorFile.error.message}`);
    }
    const advisors = { value: advisorFile?.exists && !advisorFile.error ? clone(advisorFile.value) : null };
    const selections = new Map();
    for (const id of ['native-profile-selection.json', 'agent/native-profile-selection.json']) {
      const file = files.get(id);
      if (file?.exists) selections.set(id, clone(file.value));
    }
    const rosterRead = readRoster(agentDir, { fs });
    const context = {
      files, config, settings, sidecar, roleBackups, advisors, selections, warnings: [],
      roster: { value: clone(rosterRead.roster), touched: false, warning: rosterRead.warning },
      configTouched: false, configReplaced: false, nextConfig: null,
      selectedProfile: null, main: null, mainOverrides: [],
    };

    for (const change of body.changes) {
      if (change.kind === 'setMemoryRow') {
        const ownership = checkMemoryOwnershipInAllHomes(files, change);
        if (!ownership.ok) return ownership;
      }
    }

    const selectProfileChanges = body.changes.filter((c) => c.kind === 'selectProfile');
    const otherChanges = body.changes.filter((c) => c.kind !== 'selectProfile');
    const orderedChanges = [...otherChanges, ...selectProfileChanges];

    for (const change of orderedChanges) {
      const result = applyChange(context, change);
      if (!result.ok) return result;
    }
    const mainApplied = body.changes.some((change) => change.kind === 'setMain' || change.kind === 'selectProfile')
      || settings.value.defaultProvider !== settingsFile.value.defaultProvider
      || settings.value.defaultModel !== settingsFile.value.defaultModel;
    if (mainApplied) {
      const agent = context.roster.value.agents.sisyphus;
      context.roster.value = {
        ...context.roster.value,
        updatedAt: new Date(nowFn()).toISOString(),
        agents: {
          ...context.roster.value.agents,
          sisyphus: { ...agent, pin: null, rev: rosterRead.roster.agents.sisyphus.rev + 1 },
        },
      };
      context.roster.touched = true;
      context.warnings.push('The main model apply clears the Sisyphus pin and resets its memory revision '
        + '(rev + 1 once), so the next start uses the applied main instead of the legacy pin or remembered model.');
    }
    const finalConfig = context.config;
    const savedConfig = saveConfig(finalConfig);
    const allow = assertAllowedConfig(savedConfig, loadInventory());
    if (!allow.ok) return refusal('ALLOWLIST', 'omo.jsonc keys are not allowed', { errors: allow.errors });
    const settingsCheck = assertSettingsDelta(settingsFile.value, settings.value);
    if (!settingsCheck.ok) {
      return refusal('PROTECTED_SETTING', 'settings.json would change a protected key', { errors: settingsCheck.errors });
    }
    if (context.roster.touched) {
      const rosterCheck = validateRoster(context.roster.value);
      if (!rosterCheck.ok) {
        return refusal('INVALID_ROSTER', 'roster validation failed', { errors: rosterCheck.errors });
      }
    }

    // Build the intended target values.
    const next = new Map();
    const configChanged = context.configTouched || !deepEqual(savedConfig, saveConfig(readConfig(configFile.value)));
    if (configChanged) {
      next.set('omo.jsonc', { value: savedConfig, kind: 'jsonc' });
    }
    if (!deepEqual(settingsFile.value, settings.value)) {
      next.set('agent/settings.json', { value: settings.value, kind: 'json' });
    }
    // WinForms lane mirror (:3755-3757): when the primary registry exists, every
    // lane receives a copy, with the lane's own pre-write backup.
    const subscriptions = primarySubscriptions();
    if (subscriptions !== null) {
      for (const [id, file] of files) {
        if (!id.startsWith('mirror/') || !id.endsWith('/commandcode-subscriptions.json')) continue;
        const current = file.exists ? file.value : null;
        if (!deepEqual(current, subscriptions)) {
          next.set(id, { value: subscriptions, kind: 'json' });
        }
      }
    }
    if (!deepEqual(sidecarFile?.value ?? {}, sidecar.value)) {
      next.set('runtime/native-profile-switcher-main.json', { value: sidecar.value, kind: 'json' });
    }
    if (!deepEqual(readRoleBackups(roleBackupsFile?.value), roleBackups)) {
      next.set(ROLE_BACKUP_FILE, { value: roleBackups, kind: 'json' });
    }
    if (advisors.value && !deepEqual(advisorFile.value, advisors.value)) {
      next.set(ADVISOR_FILE, { value: advisors.value, kind: 'json' });
    }
    for (const [id, value] of selections) {
      if (!deepEqual(files.get(id)?.value, value)) {
        next.set(id, { value, kind: 'json' });
      }
    }
    // Stable-500 role models and memory rows.
    const stableFile = files.get('stable/omo.jsonc');
    if (stableFile?.exists) {
      let stableConfig = null;
      let stableTouched = false;
      const selected = context.selectedProfile;
      if (selected) {
        let source = savedConfig;
        let selectionProfile = '';
        try {
          const selectionValue = files.get('native-profile-selection.json')?.value;
          selectionProfile = typeof selectionValue?.profile === 'string' ? selectionValue.profile : '';
        } catch { selectionProfile = ''; }
        try {
          const synced = syncStable500RoleModels({
            source, target: clone(stableFile.value), profileKey: selected.omoProfile,
            selectionProfile, switchProfile: true,
          });
          stableConfig = synced.config;
          if (synced.changed) stableTouched = true;
        } catch (error) {
          return refusal('STABLE_REFUSED', error.message);
        }
      }

      const memoryChanges = body.changes.filter((c) => c.kind === 'setMemoryRow');
      if (memoryChanges.length > 0) {
        if (!stableConfig) stableConfig = readConfig(stableFile.value);
        for (const change of memoryChanges) {
          try {
            memoryRowChange(stableConfig, change, selected ?? activeProfile(files));
            stableTouched = true;
          } catch (error) {
            return refusal('BAD_REQUEST', `stable/omo.jsonc: ${error.message}`);
          }
        }
      }

      if (stableConfig && stableTouched) {
        const savedStable = saveConfig(stableConfig);
        const stableAllow = assertAllowedConfig(savedStable, loadInventory());
        if (!stableAllow.ok) {
          return refusal('ALLOWLIST', `stable/omo.jsonc: ${stableAllow.errors[0]}`);
        }
        if (!deepEqual(savedStable, stableFile.value)) {
          next.set('stable/omo.jsonc', { value: savedStable, kind: 'jsonc' });
        }
      }
    }
    // Lane mirrors (only roots that already have omo.jsonc). The switcher treats a
    // failed mirror as one warning and continues; the primary write is unaffected.
    const mirrorParts = new Map();
    for (const [id, file] of files) {
      const match = /^mirror\/([^/]+)\/(.+)$/.exec(id);
      if (!match) continue;
      if (!mirrorParts.has(match[1])) mirrorParts.set(match[1], new Map());
      mirrorParts.get(match[1]).set(match[2], { id, file });
    }
    const mirrorProfile = context.selectedProfile ?? activeProfile(files);
    for (const [label, parts] of mirrorParts) {
      const configPart = parts.get('omo.jsonc');
      const settingsPart = parts.get('agent/settings.json');
      const mainPart = parts.get('runtime/native-profile-switcher-main.json');
      if (!configPart?.file.exists) continue;
      const mirrorConfig = readConfig(configPart.file.value);
      let mirrorSettings = settingsPart?.file.exists && isPlainObject(settingsPart.file.value)
        ? clone(settingsPart.file.value) : null;
      let mirrorMain = mainPart?.file.exists ? clone(mainPart.file.value) : {};
      for (const override of context.mainOverrides) {
        mirrorMain = setMainLayerOverride({
          state: mirrorMain, profileKey: override.profileKey, main: override.main,
        });
      }
      let configTouched = false;
      let settingsTouched = false;
      let profileSelection = null;
      const warn = (message) => context.warnings.push(`mirror ${label}: ${message}`);
      for (const change of body.changes) {
        try {
          if (change.kind === 'selectProfile') {
            const profile = getProfile(change.profileKey);
            if (!profile || !isPlainObject(mirrorConfig.profiles?.[profile.omoProfile])) {
              warn(`profile ${change.profileKey} is missing; selectProfile skipped`);
              continue;
            }
            mergeProfileLayerIntoActiveScopes({ config: mirrorConfig, profile });
            configTouched = true;
            profileSelection = selectionState(profile, new Date(nowFn()).toISOString());
            if (mirrorSettings) {
              mirrorSettings.defaultProvider = settings.value.defaultProvider;
              mirrorSettings.defaultModel = settings.value.defaultModel;
              settingsTouched = true;
            }
          } else if (change.kind === 'setRoute') {
            routeChange(mirrorConfig, change, mirrorProfile);
            configTouched = true;
          } else if (change.kind === 'setModelProfile') {
            modelProfileChange(mirrorConfig, change, mirrorProfile);
            configTouched = true;
          } else if (change.kind === 'setMemoryRow') {
            memoryRowChange(mirrorConfig, change, mirrorProfile);
            configTouched = true;
          } else if (change.kind === 'setSummarizer' && mirrorSettings) {
            const result = summarizerChange(mirrorSettings, change);
            mirrorSettings = result.settings;
            settingsTouched = true;
          }
        } catch (error) {
          warn(`${change.kind}: ${error.message}`);
        }
      }
      if (configTouched) {
        const saved = saveConfig(mirrorConfig);
        const mirrorAllow = assertAllowedConfig(saved, loadInventory());
        if (!mirrorAllow.ok) {
          warn(`allowlist: ${mirrorAllow.errors[0]}`);
        } else if (!deepEqual(saved, configPart.file.value)) {
          next.set(configPart.id, { value: saved, kind: 'jsonc' });
        }
      }
      if (settingsTouched && mirrorSettings) {
        const mirrorCheck = assertSettingsDelta(settingsPart.file.value, mirrorSettings);
        if (!mirrorCheck.ok) {
          warn(`protected settings: ${mirrorCheck.errors[0]}`);
        } else if (!deepEqual(settingsPart.file.value, mirrorSettings)) {
          next.set(settingsPart.id, { value: mirrorSettings, kind: 'json' });
        }
      }
      if (context.mainOverrides.length > 0 && mainPart) {
        const beforeMain = mainPart.file.exists ? mainPart.file.value : {};
        if (!mainPart.file.exists || !deepEqual(beforeMain, mirrorMain)) {
          next.set(mainPart.id, { value: mirrorMain, kind: 'json' });
        }
      }
      if (profileSelection) {
        for (const name of ['native-profile-selection.json', 'agent/native-profile-selection.json']) {
          const part = parts.get(name);
          if (!part) continue;
          if (!deepEqual(part.file.value, profileSelection)) {
            next.set(part.id, { value: profileSelection, kind: 'json' });
          }
        }
      }
    }
    if (context.roster.touched) {
      if (body.rosterRevision !== rosterRead.roster.revision) {
        return refusal('STALE', `roster revision ${body.rosterRevision} but current is ${rosterRead.roster.revision}`);
      }
      next.set('agent/primary-agents/roster.json', { value: context.roster.value, kind: 'roster' });
    }

    // Compare-and-swap every target this pipeline read against the page's expected
    // hashes, not only the ones the request would change: the page sends
    // state.targets (null for an absent file), so a concurrent write to an
    // untouched primary file or lane mirror is refused before any write.
    for (const [id, expectedHash] of Object.entries(body.expected)) {
      const file = files.get(id);
      const currentHash = file?.exists ? sha256(file.bytes) : null;
      if (expectedHash !== currentHash) {
        return refusal('STALE', `${id} changed elsewhere`, { file: id, current: currentHash });
      }
    }
    for (const id of files.keys()) {
      if (!Object.hasOwn(body.expected, id)) {
        return refusal('BAD_REQUEST', `expected.${id} is required`);
      }
    }

    // Serialize changed values and compute the diff on JSON paths.
    const writes = [];
    const diffs = [];
    for (const [id, item] of next) {
      const spec = files.get(id);
      if (!spec) return refusal('BAD_REQUEST', `unknown target ${id}`);
      if (spec.neverWrite) return refusal('BAD_REQUEST', `${id} is not written by this store`);
      const bytes = Buffer.from(formatJsonText(item.value, spec.exists ? spec.style : DEFAULT_STYLE), UTF8);
      if (spec.exists && bytes.equals(spec.bytes)) continue;
      writes.push({ id, spec, bytes, value: item.value, kind: item.kind });
      diffs.push({
        file: id,
        beforeSha256: spec.exists ? sha256(spec.bytes) : null,
        afterSha256: sha256(bytes),
        changes: diffJson(spec.exists ? spec.value : null, item.value),
      });
    }

    return {
      ok: true, body, files, writes, diffs, warnings: context.warnings,
      hashes: Object.fromEntries([...files].filter(([, file]) => file.exists).map(([id, file]) => [id, sha256(file.bytes)])),
    };
  }

  function preview(body) {
    const result = prepare(body);
    if (!result.ok) return result;
    return {
      ok: true,
      action: 'preview',
      diffs: result.diffs,
      warnings: result.warnings,
      hashes: result.hashes,
      writes: result.writes.map((write) => write.id),
    };
  }

  function backupName(spec, stamp, attempt) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    if (spec.kind === 'jsonc') return `${spec.backup}-${stamp}${suffix}.jsonc`;
    if (spec.backup === 'senpi-settings') return `senpi-settings-${stamp}${suffix}.json`;
    return `${spec.backup}-${stamp}${suffix}.json`;
  }

  function writeBackup(spec, bytes, stamp) {
    fs.mkdirSync(backupDir, { recursive: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const file = join(backupDir, backupName(spec, stamp, attempt));
      try {
        fs.writeFileSync(file, bytes, { flag: 'wx' });
        if (sha256(fs.readFileSync(file)) !== sha256(bytes)) {
          throw Object.assign(new Error(`backup verification failed: ${file}`), { code: 'BACKUP_MISMATCH' });
        }
        return file;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    throw Object.assign(new Error(`backup name exhausted for ${spec.id}`), { code: 'BACKUP_EXHAUSTED' });
  }

  function writeJournal(value) {
    if (!journalEnabled) return;
    atomicWriteJson(journalPath, value, { fs });
  }

  function apply(body) {
    const result = prepare(body);
    if (!result.ok) return result;
    const prior = readJournal().raw;
    const interrupted = prior?.status === 'running' && Array.isArray(prior.plan) ? prior : null;
    const alreadyWritten = [];
    if (interrupted) {
      if (!deepEqual(interrupted.request?.changes, result.body.changes)) {
        return refusal('STALE', 'An interrupted apply must be recovered before submitting different changes', { writes: [] });
      }
      const planned = [];
      for (const entry of interrupted.plan) {
        const disk = result.files.get(entry.id);
        if (!disk || disk.neverWrite || typeof entry.after !== 'string'
          || !(entry.before === null || typeof entry.before === 'string')
          || !Object.hasOwn(interrupted.preHashes ?? {}, entry.id)) {
          return refusal('STALE', 'The interrupted apply plan is not usable', { writes: [] });
        }
        const before = entry.before === null ? null : Buffer.from(entry.before, 'base64');
        if ((before === null ? null : sha256(before)) !== interrupted.preHashes[entry.id]) {
          return refusal('STALE', `The interrupted before-image for ${entry.id} is not usable`, { writes: [] });
        }
        const write = {
          id: entry.id, kind: entry.kind, value: entry.value, bytes: Buffer.from(entry.after, 'base64'),
          spec: { ...disk, exists: before !== null, bytes: before },
        };
        const published = disk.exists && !disk.error && (entry.kind === 'roster'
          ? deepEqual(disk.value, {
            ...entry.value, revision: interrupted.request.rosterRevision + 1, updatedAt: disk.value.updatedAt,
          })
          : disk.bytes.equals(write.bytes));
        if (published) alreadyWritten.push({ ...write, value: entry.kind === 'roster' ? disk.value : write.value });
        else if ((disk.exists ? sha256(disk.bytes) : null) !== interrupted.preHashes[entry.id]) {
          return refusal('STALE', `${entry.id} changed after the interrupted apply`, { writes: [] });
        }
        planned.push(write);
      }
      result.writes = planned;
    }
    if (result.writes.length === 0) {
      const at = new Date(nowFn()).toISOString();
      writeJournal({
        v: 1, id: `${at}-${randomBytes(4).toString('hex')}`, action: 'apply', status: 'completed',
        startedAt: at, finishedAt: at, changes: result.body.changes.map((change) => change.kind), targets: [],
        request: { changes: clone(result.body.changes), rosterRevision: result.body.rosterRevision },
        steps: [{ step: 'validate', status: 'ok', at }, { step: 'no-op', status: 'ok', at }],
      });
      return { ok: true, action: 'apply', backups: [], hashes: result.hashes, warnings: result.warnings, writes: [] };
    }
    const startedAt = new Date(nowFn()).toISOString();
    const stamp = stampOf(nowFn());
    const journalId = `${startedAt}-${randomBytes(4).toString('hex')}`;
    const journal = interrupted ?? {
      v: 1,
      id: journalId,
      action: 'apply',
      status: 'running',
      startedAt,
      steps: [
        { step: 'validate', status: 'ok', at: startedAt },
        { step: 'compare-and-swap', status: 'ok', at: startedAt },
      ],
      changes: result.body.changes.map((change) => change.kind),
      targets: result.writes.map((write) => write.id),
      preHashes: Object.fromEntries([...result.files].map(([id, file]) => [id, file.exists ? sha256(file.bytes) : null])),
      // Durable before-images and intended values let explicit reapply resume this
      // exact transaction, including a target published just before an interruption.
      plan: result.writes.map((write) => ({
        id: write.id, kind: write.kind, value: clone(write.value),
        before: write.spec.exists ? write.spec.bytes.toString('base64') : null,
        after: write.bytes.toString('base64'),
      })),
      // A process that dies before `completed` leaves this behind; the view exposes it as
      // the explicit 다시 적용 payload. Storing the payload (not a server-side replay
      // hook) keeps the reapply owner-triggered and CAS-checked like every other write.
      request: { changes: clone(result.body.changes), rosterRevision: result.body.rosterRevision },
    };
    let journalWritten = false;
    let priorJournalBytes = null;
    const backups = new Map();
    const written = [...alreadyWritten];
    const published = [];
    const pendingWrites = result.writes.filter((write) => !alreadyWritten.some((done) => done.id === write.id));
    const rosterWrite = pendingWrites.find((write) => write.kind === 'roster');
    let appliedRoster = alreadyWritten.find((write) => write.kind === 'roster')?.value ?? null;
    try {
      // Run the roster admission hook and recheck every target before creating any
      // artifact. The actual CAS still runs first among targets, after the journal.
      if (rosterWrite && typeof hooks.beforeWrite === 'function') hooks.beforeWrite(rosterWrite.id, { backup: null });
      for (const [id, file] of result.files) {
        let current = null;
        try { current = sha256(fs.readFileSync(file.path)); } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (current !== result.body.expected[id]) return refusal('STALE', `${id} changed before publication`, { writes: [], backups: [] });
      }
      try { priorJournalBytes = fs.readFileSync(journalPath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      writeJournal(journal);
      journalWritten = journalEnabled;
      if (rosterWrite) {
        appliedRoster = contractWriteRoster(agentDir, rosterWrite.value,
          interrupted?.request.rosterRevision ?? result.body.rosterRevision, { fs });
        written.push({ ...rosterWrite, value: appliedRoster });
        published.push(rosterWrite);
        journal.steps.push({ step: 'write', target: rosterWrite.id, status: 'ok', at: new Date(nowFn()).toISOString() });
        writeJournal(journal);
      }
      for (const write of pendingWrites) {
        if (write.spec.exists) {
          const file = writeBackup(write.spec, write.spec.bytes, stamp);
          backups.set(write.id, file);
          journal.steps.push({ step: 'backup', target: write.id, status: 'ok', path: file, at: new Date(nowFn()).toISOString() });
        }
      }
      writeJournal(journal);
      for (const write of pendingWrites) {
        if (write.kind === 'roster') continue;
        if (typeof hooks.beforeWrite === 'function') hooks.beforeWrite(write.id, { backup: backups.get(write.id) ?? null });
        atomicWriteText(write.spec.path, write.bytes, { fs });
        written.push(write);
        published.push(write);
        journal.steps.push({ step: 'write', target: write.id, status: 'ok', at: new Date(nowFn()).toISOString() });
        writeJournal(journal);
      }
      // Re-parse and re-validate every target this apply wrote.
      for (const write of written) {
        const disk = readTarget(write.spec, write.spec.path, fs, write.spec.kind);
        if (!disk.exists || disk.error) {
          throw Object.assign(new Error(`re-parse failed for ${write.id}${disk.error ? `: ${disk.error.message}` : ''}`), { code: 'REPARSE_FAILED' });
        }
        if (write.kind === 'jsonc') {
          if (disk.comments) throw Object.assign(new Error(`comments appeared in ${write.id}`), { code: 'REPARSE_FAILED' });
          const allowed = assertAllowedConfig(disk.value, loadInventory());
          if (!allowed.ok) throw Object.assign(new Error(`${write.id} failed the allowlist after write`), { code: 'REPARSE_FAILED' });
        }
        if (write.id === 'agent/settings.json') {
          const check = assertSettingsDelta(result.files.get(write.id)?.value, disk.value);
          if (!check.ok) throw Object.assign(new Error(`${write.id} changed a protected key after write`), { code: 'REPARSE_FAILED' });
        }
        if (write.kind === 'roster') {
          const check = validateRoster(disk.value);
          if (!check.ok) throw Object.assign(new Error(`${write.id} failed roster validation`), { code: 'REPARSE_FAILED' });
          if (disk.value.revision !== write.value.revision) {
            throw Object.assign(new Error(`${write.id} revision mismatch`), { code: 'REPARSE_FAILED' });
          }
        }
        if (typeof hooks.reparse === 'function') hooks.reparse(write.id);
      }
      journal.status = 'completed';
      journal.finishedAt = new Date(nowFn()).toISOString();
      journal.steps.push({ step: 're-parse', status: 'ok', at: journal.finishedAt });
      writeJournal(journal);
      const hashes = {};
      for (const [id, spec] of targets()) {
        try { hashes[id] = sha256(fs.readFileSync(spec.path)); } catch { hashes[id] = null; }
      }
      return {
        ok: true,
        action: 'apply',
        backups: [...backups.values()].sort(),
        hashes,
        warnings: result.warnings,
        writes: result.writes.filter((write) => published.some((done) => done.id === write.id)).map((write) => write.id),
        rosterRevision: appliedRoster?.revision ?? contextRevision(result),
        ...(interrupted ? { recoveredFrom: interrupted.id } : {}),
      };
    } catch (error) {
      if (published.length === 0 && error.code === 'CONFLICT') {
        if (journalWritten) {
          if (priorJournalBytes !== null) atomicWriteText(journalPath, priorJournalBytes, { fs });
          else fs.unlinkSync(journalPath);
        }
        return refusal('STALE', error.message, { writes: [], backups: [] });
      }
      const rollbackFailures = [];
      for (const write of [...written].reverse()) {
        try {
          const backup = backups.get(write.id);
          if (write.spec.exists) {
            const original = backup ? fs.readFileSync(backup) : write.spec.bytes;
            atomicWriteText(write.spec.path, original, { fs });
            if (sha256(fs.readFileSync(write.spec.path)) !== sha256(original)) {
              rollbackFailures.push(`${write.id}: restore hash mismatch`);
            }
          } else {
            try { fs.unlinkSync(write.spec.path); } catch (unlinkError) {
              if (unlinkError?.code !== 'ENOENT') rollbackFailures.push(`${write.id}: ${unlinkError.message}`);
            }
          }
        } catch (rollbackError) {
          rollbackFailures.push(`${write.id}: ${rollbackError.message}`);
        }
      }
      if (journalWritten) {
        journal.status = 'rolled-back';
        journal.finishedAt = new Date(nowFn()).toISOString();
        journal.error = { code: error.code ?? 'ERROR', message: error.message };
        journal.steps.push({ step: 'rollback', status: rollbackFailures.length === 0 ? 'ok' : 'failed', errors: rollbackFailures, at: journal.finishedAt });
        try { writeJournal(journal); } catch { /* the rollback result is still the answer */ }
      }
      return {
        ok: false,
        code: rollbackFailures.length === 0 ? 'ROLLED_BACK' : 'ROLLBACK_FAILED',
        status: 500,
        message: error.message,
        rollbackFailures,
        backups: [...backups.values()].sort(),
      };
    }
  }

  function contextRevision(result) {
    try {
      return JSON.parse(fs.readFileSync(join(agentDir, 'primary-agents', 'roster.json'), UTF8)).revision;
    } catch {
      return result.files.get('agent/primary-agents/roster.json')?.value?.revision ?? 0;
    }
  }

  const api = {
    roots: { ...roots, mirrorHomes: [...roots.mirrorHomes] },
    pluginPath,
    inventoryPath,
    backupDir,
    journalPath,
    agentDir,
    state,
    preview,
    apply,
    // A single entry point for the HTTP handler: expected refusals are returned,
    // never thrown, so the board's write slot always settles. The envelope is the
    // board's {status, json} contract.
    handle(body) {
      if (body?.action === 'apply' && Array.isArray(body.changes) && body.changes.length === 1
        && body.changes[0]?.kind === 'setWebDeepseekEnabled') {
        if (!isPlainObject(body.expected) || Object.keys(body.expected).length !== 0 || body.rosterRevision !== 0) {
          return { status: 400, json: { ok: false, code: 'BAD_WEB_DEEPSEEK_REQUEST' } };
        }
        return setWebDeepseek(join(agentDir, 'web-deepseek'), body.changes[0]);
      }
      try {
        const result = body?.action === 'preview' ? preview(body) : apply(body);
        if (result.ok) return { status: 200, json: result };
        return {
          status: result.status ?? 400,
          json: {
            ok: false,
            code: result.code ?? 'BAD_REQUEST',
            ...(result.file ? { file: result.file } : {}),
            ...(Array.isArray(result.errors) ? { errors: result.errors } : {}),
          },
        };
      } catch (error) {
        return { status: 500, json: { ok: false, code: 'IO_ERROR' } };
      }
    },
    targetIds: () => [...targets().keys()],
    journal: journalView,
    inventory: inventoryStatus,
    redact,
  };
  return api;
}
