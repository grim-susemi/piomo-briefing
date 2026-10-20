// Profile store: compare-and-swap, allowlist, backups, formatting preservation,
// rollback and the apply journal. Every test runs against temporary homes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  atomicWriteText, detectStyle, formatJsonText, hasComments, openProfilesStore, redact,
} from '../src/profiles/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'fixtures', 'profiles', 'goldens', 'apply-gpt-kimi-deepseek', 'files');
const REAL_INVENTORY = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'profiles', 'inventory-5.1.38.json'), 'utf8'));
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
  fs.writeFileSync(path.join(primary, 'agent', 'models.json'), JSON.stringify({ models: {} }, null, 2));
  fs.writeFileSync(path.join(primary, 'auth.json'), '{"token":"SECRET-DO-NOT-TOUCH"}');
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
    mirrorHomes: options.mirrorHomes ?? [],
    pluginPath: plugin,
    inventory,
    hooks: options.hooks,
    now: options.now ?? (() => Date.parse('2026-10-20T12:00:00Z')),
  });
  return { root, primary, stable, store, settings, style, plugin };
}

function expectedOf(store) {
  return store.state().targets;
}

function body(action, changes, store, expected = expectedOf(store), rosterRevision = store.state().roster.revision) {
  return { action, changes, expected, rosterRevision };
}

test('preview returns path-level diffs and writes nothing', (t) => {
  const fx = makeFixture(t);
  const before = hashFile(path.join(fx.primary, 'agent', 'settings.json'));
  const beforeOmo = hashFile(path.join(fx.primary, 'omo.jsonc'));
  const result = fx.store.preview(body('preview', [{ kind: 'setSummarizer', modelId: 'ollama/glm-5.3' }], fx.store));
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
  const result = store.apply(body('apply', [{ kind: 'setSummarizer', modelId: 'ollama/glm-5.3' }], store));
  assert.equal(result.ok, true);
  assert.deepEqual(observed, { backup: result.backups[0], exists: true });
  const after = readJsonFile(settingsPath);
  assert.equal(after.compaction.model, 'ollama/glm-5.3');
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

test('the 5.1.38 key allowlist rejects an unknown root key without writing', (t) => {
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
    const result = fx.store.apply(body('apply', [{ kind: 'setSummarizer', modelId: 'ollama/glm-5.3' }], fx.store));
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
  const result = fx.store.apply(body('apply', [{ kind: 'setSummarizer', modelId: 'ollama/glm-5.3' }], fx.store));
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
  const result = fx.store.apply(body('apply', [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol' }], fx.store));
  assert.equal(result.ok, true);
  assert.equal(fx.store.journal().status, 'completed');
  assert.notEqual(fx.store.journal().id, 'interrupted-run');
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
