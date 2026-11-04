// Board profile store, terminal home only: the default home, the single-home target
// list, and the refusal of the app home in every spelling. Every test runs against
// temporary homes or against an fs stand-in that fails on any access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIRROR_HOME_DEFAULTS, PRIMARY_HOME_DEFAULT, STABLE_HOME_DEFAULT, formatJsonText, openProfilesStore,
} from '../src/profiles/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'fixtures', 'profiles', 'goldens', 'apply-gpt-kimi-deepseek', 'files');
const REAL_INVENTORY = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'profiles', 'inventory.json'), 'utf8'));
const PS_STYLE = { bom: true, eol: '\r\n', indent: '    ', keySep: ':  ', trailingNewline: true };
const APP_HOME = 'C:/Users/USER/.omo';
const TERMINAL_HOME = 'C:/Users/USER/.omo-stable-500/home/.omo';

// Every spelling of the app home, as the board could receive it from a command line.
const APP_HOME_SPELLINGS = [
  APP_HOME,
  'C://Users//USER//.omo',
  'C:/Users/USER/.omo/../.omo',
  'C:/Users/USER/./.omo',
  'C:/Users/USER/.omo/.',
  'c:\\users\\user\\.omo\\',
  'C:/Users/USER/.omo/runtime',
];

const readGolden = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN, name), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashFile = (file) => sha(fs.readFileSync(file));

// An fs stand-in: any access is counted, and throws, so a path that reads the disk fails.
function failingFs() {
  const calls = [];
  const stub = new Proxy({}, {
    get(_, key) {
      calls.push(String(key));
      throw new Error(`fs touched: ${String(key)}`);
    },
  });
  return { stub, calls };
}

// What openProfilesStore does with these options: the error code (or NO_THROW) and the fs accesses.
function openOutcome(options) {
  const { stub, calls } = failingFs();
  try {
    openProfilesStore({ ...options, fs: stub });
    return { code: 'NO_THROW', fsCalls: calls.length };
  } catch (error) {
    return { code: error.code ?? error.message, fsCalls: calls.length };
  }
}

// One home that is both the primary and the stable root (the terminal lane).
function makeSameHome(t, stableSpelling = (home) => home) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-terminal-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home', '.omo');
  fs.mkdirSync(path.join(home, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, 'omo.jsonc'), formatJsonText(readGolden('primary/omo.jsonc.json'), PS_STYLE));
  fs.writeFileSync(path.join(home, 'agent', 'settings.json'),
    formatJsonText(readGolden('primary/settings.json.json'), PS_STYLE));
  const selection = JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'seed' }, null, 2);
  fs.writeFileSync(path.join(home, 'native-profile-selection.json'), selection);
  fs.writeFileSync(path.join(home, 'agent', 'native-profile-selection.json'), selection);
  const sentinel = path.join(root, 'outside-home.txt');
  fs.writeFileSync(sentinel, 'not part of the terminal home');
  const plugin = path.join(root, 'omo.js');
  fs.writeFileSync(plugin, 'plugin-body');
  const inventory = {
    ...REAL_INVENTORY,
    sources: { ...REAL_INVENTORY.sources, omo: { ...REAL_INVENTORY.sources.omo, sha256: sha(Buffer.from('plugin-body')) } },
  };
  const store = openProfilesStore({
    primaryHome: home, stableHome: stableSpelling(home), mirrorHomes: [], pluginPath: plugin, inventory,
    now: () => Date.parse('2026-10-20T12:00:00Z'),
  });
  return { root, home, sentinel, store };
}

const body = (action, changes, store) => ({
  action, changes, expected: store.state().targets, rosterRevision: store.state().roster.revision,
});

test('the board defaults are the terminal home and no mirror', () => {
  assert.equal(PRIMARY_HOME_DEFAULT, STABLE_HOME_DEFAULT);
  assert.deepEqual(MIRROR_HOME_DEFAULTS, []);
});

test('one home for both roles: the target list has no stable copy of omo.jsonc', (t) => {
  const fx = makeSameHome(t);
  const ids = Object.keys(fx.store.state().targets);
  assert.ok(ids.includes('omo.jsonc'));
  assert.ok(ids.includes('agent/primary-agents/roster.json'));
  assert.ok(!ids.includes('stable/omo.jsonc'));
  assert.ok(!ids.includes('stable/agent/models.json'));
});

test('one home spelled two ways (stable with ./ and a trailing slash) is still one home', (t) => {
  const fx = makeSameHome(t, (home) => `${home}${path.sep}.${path.sep}`);
  const ids = Object.keys(fx.store.state().targets);
  assert.ok(ids.includes('omo.jsonc'));
  assert.ok(!ids.includes('stable/omo.jsonc'));
  assert.ok(!ids.includes('stable/agent/models.json'));
});

test('select on one home writes only inside that home', (t) => {
  const fx = makeSameHome(t);
  const sentinelBefore = hashFile(fx.sentinel);
  const omoBefore = hashFile(path.join(fx.home, 'omo.jsonc'));
  const result = fx.store.apply(body('apply', [{ kind: 'selectProfile', profileKey: 'gpt-deepseek' }], fx.store));
  assert.equal(result.ok, true);
  assert.ok(result.writes.length > 0);
  assert.ok(result.writes.every((id) => !id.startsWith('stable/')));
  assert.notEqual(hashFile(path.join(fx.home, 'omo.jsonc')), omoBefore);
  assert.equal(hashFile(fx.sentinel), sentinelBefore);
  const roster = JSON.parse(fs.readFileSync(path.join(fx.home, 'agent', 'primary-agents', 'roster.json'), 'utf8'));
  assert.equal(roster.revision, 1);
  assert.equal(roster.agents.sisyphus.rev, 1);
  assert.equal(roster.agents.sisyphus.pin, null);
  assert.equal(roster.agents.hephaestus.rev, 0);
});

test('a memory row change lands in the primary omo.jsonc and never in a stable copy', (t) => {
  const fx = makeSameHome(t);
  const omoBefore = hashFile(path.join(fx.home, 'omo.jsonc'));
  const result = fx.store.apply(body('apply', [
    { kind: 'setMemoryRow', row: 'kibitzer', mode: 'custom', model: 'alibaba-token-plan/MiniMax-M2.5', reasoning: 'low', profileKey: 'gpt-deepseek' },
  ], fx.store));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.writes, ['omo.jsonc']);
  assert.notEqual(hashFile(path.join(fx.home, 'omo.jsonc')), omoBefore);
});

test('external memory selector is a separate unproven stored value and never a write target', (t) => {
  const fx = makeSameHome(t);
  const selector = path.join(fx.home, 'memory-model-selection.json');
  fs.writeFileSync(selector, '{"modelAlias":"selector-only-alias","note":"keep these bytes"}\n');
  const before = hashFile(selector);
  const targetIds = fx.store.targetIds();
  assert.deepEqual(targetIds, [
    'omo.jsonc', 'agent/settings.json', 'agent/models.json',
    'runtime/native-profile-switcher-main.json', 'native-profile-selection.json',
    'agent/native-profile-selection.json', 'agent/primary-agents/roster.json',
  ]);
  const state = fx.store.state();
  assert.equal(state.memory.externalSelector.storedValue, 'selector-only-alias');
  assert.equal(state.memory.externalSelector.runtimeEffect, 'unproven');
  assert.match(state.memory.externalSelector.label, /별도 저장값.*미입증/);
  assert.notEqual(state.memory.kibitzer.category, state.memory.externalSelector.storedValue);
  assert.equal(Object.hasOwn(state.memory.externalSelector, 'category'), false);
  const result = fx.store.apply(body('apply', [
    { kind: 'setMemoryRow', row: 'kibitzer', mode: 'custom', model: 'alibaba-token-plan/MiniMax-M2.5', reasoning: 'low', profileKey: 'gpt-deepseek' },
    { kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' },
  ], fx.store));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.writes.sort(), ['agent/settings.json', 'omo.jsonc']);
  assert.deepEqual(fx.store.targetIds(), targetIds);
  assert.equal(hashFile(selector), before);
  assert.equal(fx.store.state().memory.externalSelector.storedValue, 'selector-only-alias');
  assert.equal(fx.store.state().memory.externalSelector.runtimeEffect, 'unproven');
});

test('a missing or malformed external selector remains explained and never changes the category', (t) => {
  const fx = makeSameHome(t);
  const before = fx.store.state().memory.kibitzer;
  assert.equal(fx.store.state().memory.externalSelector.reason, 'missing-selector');
  const selector = path.join(fx.home, 'memory-model-selection.json');
  for (const text of ['null', '{"modelAlias":42}', '{broken']) {
    fs.writeFileSync(selector, text);
    const state = fx.store.state();
    assert.equal(state.memory.externalSelector.storedValue, null);
    assert.equal(state.memory.externalSelector.runtimeEffect, 'unproven');
    assert.match(state.memory.externalSelector.reason, /invalid-selector|unreadable-selector/);
    assert.deepEqual(state.memory.kibitzer, before);
    assert.equal(fs.readFileSync(selector, 'utf8'), text);
  }
});

test('every spelling of the app home is refused as the primary root, before any fs access', () => {
  for (const spelling of APP_HOME_SPELLINGS) {
    const outcome = openOutcome({ primaryHome: spelling, stableHome: TERMINAL_HOME, mirrorHomes: [] });
    assert.deepEqual({ spelling, ...outcome }, { spelling, code: 'APP_HOME_REFUSED', fsCalls: 0 });
  }
});

test('every spelling of the app home is refused as the stable root, before any fs access', () => {
  for (const spelling of APP_HOME_SPELLINGS) {
    const outcome = openOutcome({ primaryHome: TERMINAL_HOME, stableHome: spelling, mirrorHomes: [] });
    assert.deepEqual({ spelling, ...outcome }, { spelling, code: 'APP_HOME_REFUSED', fsCalls: 0 });
  }
});

test('the app home as a mirror root is refused before any fs access', () => {
  const outcome = openOutcome({ primaryHome: TERMINAL_HOME, stableHome: TERMINAL_HOME, mirrorHomes: [APP_HOME] });
  assert.deepEqual(outcome, { code: 'APP_HOME_REFUSED', fsCalls: 0 });
});

test('a stable root at the app home is refused even when the primary is omitted', () => {
  const outcome = openOutcome({ stableHome: APP_HOME });
  assert.deepEqual(outcome, { code: 'APP_HOME_REFUSED', fsCalls: 0 });
});

test('a relative spelling that resolves to the app home from its parent is refused', (t) => {
  const before = process.cwd();
  process.chdir('C:/Users/USER');
  t.after(() => process.chdir(before));
  const outcome = openOutcome({ primaryHome: '.omo', stableHome: TERMINAL_HOME, mirrorHomes: [] });
  assert.deepEqual(outcome, { code: 'APP_HOME_REFUSED', fsCalls: 0 });
});

test('homes that only share the app home prefix are not refused', () => {
  for (const home of [TERMINAL_HOME, 'C:/Users/USER/.omo-stable-500/home', 'C:/Users/USER/.omo2']) {
    const outcome = openOutcome({ primaryHome: home, stableHome: home, mirrorHomes: [] });
    assert.deepEqual({ home, ...outcome }, { home, code: 'NO_THROW', fsCalls: 0 });
  }
});
