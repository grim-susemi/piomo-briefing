// Board profile store, terminal home only: the default home, the single-home target
// list, and the refusal of the app home. Every test runs against temporary homes.
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

const readGolden = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN, name), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashFile = (file) => sha(fs.readFileSync(file));

// One home that is both the primary and the stable root (the terminal lane).
function makeSameHome(t) {
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
    primaryHome: home, stableHome: home, mirrorHomes: [], pluginPath: plugin, inventory,
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

test('an app-home primary is refused before any file is read', () => {
  const calls = [];
  const countingFs = new Proxy(fs, {
    get(target, key) { calls.push(key); return target[key]; },
  });
  assert.throws(() => openProfilesStore({
    primaryHome: APP_HOME, stableHome: 'C:/Users/USER/.omo-stable-500/home/.omo', mirrorHomes: [], fs: countingFs,
  }), (error) => error.code === 'APP_HOME_REFUSED');
  assert.equal(calls.length, 0);
});

test('an app-home stable root is refused too, with the separator and case normalized', () => {
  assert.throws(() => openProfilesStore({
    primaryHome: 'C:/Users/USER/.omo-stable-500/home/.omo', stableHome: 'c:\\users\\user\\.omo\\', mirrorHomes: [],
  }), (error) => error.code === 'APP_HOME_REFUSED');
});
