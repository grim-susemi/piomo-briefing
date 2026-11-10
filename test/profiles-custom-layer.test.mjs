// Storage contract: existing changes retain an unrecognized profile's full value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_META } from '../src/profiles/model.mjs';
import { openProfilesStore } from '../src/profiles/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = path.join(here, 'fixtures', 'profiles', 'goldens', 'apply-gpt-kimi-deepseek', 'files');
const inventory = JSON.parse(fs.readFileSync(path.join(here, '../src/profiles/inventory.json'), 'utf8'));
const customKey = 'native-custom-1';
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function fixture(t, legacyAliases = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-custom-layer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(golden, root, { recursive: true });
  const primary = path.join(root, 'primary');
  const stable = path.join(root, 'stable');
  for (const home of [primary, stable]) {
    fs.mkdirSync(path.join(home, 'agent'), { recursive: true });
    fs.copyFileSync(path.join(home, 'omo.jsonc.json'), path.join(home, 'omo.jsonc'));
    fs.copyFileSync(path.join(home, 'settings.json.json'), path.join(home, 'agent/settings.json'));
    fs.copyFileSync(path.join(home, 'selection.json.json'), path.join(home, 'native-profile-selection.json'));
  }
  fs.copyFileSync(path.join(primary, 'agent-selection.json.json'),
    path.join(primary, 'agent/native-profile-selection.json'));
  for (const [name, home] of [['primary', primary], ['stable', stable]]) {
    fs.copyFileSync(path.join(here, 'fixtures/profiles/registry', name, 'agent/models.json'),
      path.join(home, 'agent/models.json'));
  }
  const config = readJson(path.join(primary, 'omo.jsonc'));
  const expected = structuredClone(config.profiles['native-experimental-custom']);
  config.profiles[customKey] = structuredClone(expected);
  if (legacyAliases) {
    const agents = config.profiles[customKey]['[native]'].agents;
    agents.metis = agents['plan-consultant'];
    agents.momus = agents['plan-reviewer'];
    delete agents['plan-consultant'];
    delete agents['plan-reviewer'];
  }
  fs.writeFileSync(path.join(primary, 'omo.jsonc'), JSON.stringify(config, null, 2));
  // The golden has no advisor routing file; seed the real adapter's minimal table.
  const advisorFile = path.join(primary, 'agent/oracle-advisor/routing.json');
  fs.mkdirSync(path.dirname(advisorFile), { recursive: true });
  fs.writeFileSync(advisorFile, JSON.stringify({
    v: 1,
    profiles: {
      claude: { model: 'commandcode-anthropic/claude-sonnet-5:high', family: 'claude' },
      gpt: { model: 'commandcode/gpt-6-sol:high', family: 'gpt' },
    },
    by_family: {},
    by_agent: {},
    by_nature: {},
  }));
  const plugin = path.join(root, 'omo.js');
  const pluginBody = 'custom-layer-fixture-plugin';
  fs.writeFileSync(plugin, pluginBody);
  const store = openProfilesStore({
    primaryHome: primary,
    stableHome: stable,
    mirrorHomes: [],
    pluginPath: plugin,
    inventory: {
      ...inventory,
      sources: {
        ...inventory.sources,
        omo: { ...inventory.sources.omo, sha256: createHash('sha256').update(pluginBody).digest('hex') },
      },
    },
    recommendationManifest: null,
    now: () => Date.parse('2026-11-10T00:00:00Z'),
  });
  return { store, primary, expected };
}

const route = {
  kind: 'setRoute', profileKey: 'native-gpt-kimi-deepseek', section: 'agents',
  role: 'explore', provider: 'openai', model: 'gpt-6-sol', thinking: 'high',
};
const cases = [
  ...PROFILE_META.map(({ key }) => ({
    name: `selectProfile ${key}`, change: { kind: 'selectProfile', profileKey: key },
  })),
  { name: 'setRoute', change: route },
  {
    name: 'setRoleBackup',
    change: {
      kind: 'setRoleBackup', profileKey: 'native-gpt-kimi-deepseek',
      section: 'agents', role: 'explore', alias: 'sol-61-high',
    },
  },
  {
    name: 'setMain',
    change: { kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
  },
  {
    name: 'setModelProfile off',
    change: { kind: 'setModelProfile', profileKey: 'gpt-kimi-deepseek', selection: 'off' },
  },
  {
    name: 'setModelProfile literal',
    change: {
      kind: 'setModelProfile', profileKey: 'gpt-kimi-deepseek',
      selection: 'custom-literal', literal: 'openai/gpt-6-sol',
    },
  },
  { name: 'setSummarizer', change: { kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' } },
  ...['kibitzer', 'reflection'].flatMap((row) => [
    {
      name: `setMemoryRow ${row} custom`,
      change: { kind: 'setMemoryRow', row, mode: 'custom', model: 'openai/gpt-6-sol', reasoning: 'high' },
    },
    { name: `setMemoryRow ${row} quick`, change: { kind: 'setMemoryRow', row, mode: 'quick' } },
  ]),
  {
    name: 'setAgentLane',
    change: { kind: 'setAgentLane', agentId: 'hephaestus', lane: 'geeky-heavy' },
  },
  {
    name: 'setAgentPin',
    change: {
      kind: 'setAgentPin', agentId: 'hephaestus',
      pin: { provider: 'openai', modelId: 'gpt-6-sol', thinking: 'high' },
    },
  },
  {
    name: 'setAdvisor',
    change: {
      kind: 'setAdvisor', advisor: 'claude', provider: 'commandcode-anthropic',
      model: 'commandcode-anthropic/claude-opus-5', thinking: 'high',
    },
  },
  { name: 'resetAgentMemory', change: { kind: 'resetAgentMemory', agentId: 'hephaestus' } },
  { name: 'migrateReviewerKeys', change: { kind: 'migrateReviewerKeys' } },
  { name: 'setRoute with legacy planner aliases', change: route, legacyAliases: true },
];

for (const scenario of cases) {
  test(`${scenario.name} preserves the complete unknown profile layer`, (t) => {
    // Given: each change gets a fresh golden home and an independently cloned layer.
    const fx = fixture(t, scenario.legacyAliases);
    const state = fx.store.state();

    // When: use the public store with a fresh compare-and-swap surface.
    const result = fx.store.apply({
      action: 'apply',
      changes: [scenario.change],
      expected: state.targets,
      rosterRevision: state.roster.revision,
    });

    // Then: refusal cannot masquerade as preservation; compare the entire saved value.
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(readJson(path.join(fx.primary, 'omo.jsonc')).profiles[customKey], fx.expected);
  });
}
