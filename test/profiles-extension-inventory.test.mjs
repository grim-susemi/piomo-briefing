// Extension inventory resolution tests.
// Proves the extension injects the stable lane plugin path when OMO_STABLE_PLUGIN is present
// and leaves the store to its default otherwise. Also verifies stale/fresh inventory detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createBriefingExtension } from '../extension.mjs';
import { openProfilesStore, PLUGIN_DEFAULT } from '../src/profiles/store.mjs';
import { makeFakePi } from './helpers/fake-pi.mjs';
import { tempDir } from './helpers/temp.mjs';

test('inventory: the extension passes the stable lane plugin from OMO_STABLE_PLUGIN', (t) => {
  const { dir } = tempDir(t, 'omo-ext-inv-');
  let captured = null;
  const fakeStore = { handle: () => ({ status: 200, json: {} }), state: () => ({}) };
  const host = makeFakePi({ sessionKind: 'interactive' });
  const fakePluginRoot = join(dir, 'fake-plugin');
  createBriefingExtension({
    stateDir: join(dir, 'state'),
    now: () => 1_700_000_000_000,
    env: { OMO_STABLE_PLUGIN: fakePluginRoot },
    createProfilesStore: (options) => { captured = options; return fakeStore; },
  })(host.pi);

  assert.ok(captured, 'createProfilesStore was invoked');
  assert.equal(captured.pluginPath, join(fakePluginRoot, 'extensions', 'omo.js'));
});

test('inventory: without OMO_STABLE_PLUGIN the store default is used', (t) => {
  const { dir } = tempDir(t, 'omo-ext-inv-');
  let captured = null;
  const fakeStore = { handle: () => ({ status: 200, json: {} }), state: () => ({}) };
  const host = makeFakePi({ sessionKind: 'interactive' });
  createBriefingExtension({
    stateDir: join(dir, 'state'),
    now: () => 1_700_000_000_000,
    env: {},
    createProfilesStore: (options) => { captured = options; return fakeStore; },
  })(host.pi);

  assert.ok(captured, 'createProfilesStore was invoked');
  assert.equal(captured.pluginPath, undefined, 'no pluginPath override was passed');
  const store = openProfilesStore({ ...captured, primaryHome: dir, stableHome: dir, mirrorHomes: [] });
  assert.equal(store.inventory().path, PLUGIN_DEFAULT, 'store default is used');
});

test('inventory: through extension resolution, installed plugin fixture reports stale: false and readOnly: false', (t) => {
  const { dir } = tempDir(t, 'omo-ext-inv-fresh-');
  const fakePluginRoot = join(dir, 'plugin');
  const extDir = join(fakePluginRoot, 'extensions');
  mkdirSync(extDir, { recursive: true });

  const primary = join(dir, 'primary');
  const stable = join(dir, 'stable');
  mkdirSync(join(primary, 'agent'), { recursive: true });
  mkdirSync(join(stable, 'agent'), { recursive: true });
  writeFileSync(join(primary, 'omo.jsonc'), '{}');
  writeFileSync(join(primary, 'agent', 'settings.json'), '{}');
  writeFileSync(join(stable, 'omo.jsonc'), '{}');
  writeFileSync(join(stable, 'agent', 'settings.json'), '{}');

  // Copy installed 5.1.44 plugin bundle to fixture
  copyFileSync(PLUGIN_DEFAULT, join(extDir, 'omo.js'));

  let store = null;
  const host = makeFakePi({ sessionKind: 'interactive' });
  createBriefingExtension({
    stateDir: join(dir, 'state'),
    now: () => 1_700_000_000_000,
    env: { OMO_STABLE_PLUGIN: fakePluginRoot },
    profilesStoreOptions: {
      primaryHome: primary,
      stableHome: stable,
      mirrorHomes: [],
    },
    createProfilesStore: (options) => {
      store = openProfilesStore(options);
      return store;
    },
  })(host.pi);

  assert.ok(store, 'store was constructed');
  const inv = store.inventory();
  assert.equal(inv.stale, false, 'inventory is not stale');
  assert.equal(inv.version, '5.1.44');
  assert.equal(inv.readOnly, false);

  const state = store.state();
  assert.equal(state.inventory.stale, false);
  assert.equal(state.inventory.readOnly, false);
  assert.equal(state.readOnly, false);
  assert.equal(state.readOnlyReason, null);
});

test('inventory: through extension resolution, single-byte mismatch reports stale: true and INVENTORY_STALE', (t) => {
  const { dir } = tempDir(t, 'omo-ext-inv-stale-');
  const fakePluginRoot = join(dir, 'plugin');
  const extDir = join(fakePluginRoot, 'extensions');
  mkdirSync(extDir, { recursive: true });

  // Copy installed 5.1.44 plugin bundle and mutate 1 byte
  const bytes = readFileSync(PLUGIN_DEFAULT);
  bytes[0] = bytes[0] ^ 1;
  writeFileSync(join(extDir, 'omo.js'), bytes);

  let store = null;
  const host = makeFakePi({ sessionKind: 'interactive' });
  createBriefingExtension({
    stateDir: join(dir, 'state'),
    now: () => 1_700_000_000_000,
    env: { OMO_STABLE_PLUGIN: fakePluginRoot },
    profilesStoreOptions: {
      primaryHome: dir,
      stableHome: dir,
      mirrorHomes: [],
    },
    createProfilesStore: (options) => {
      store = openProfilesStore(options);
      return store;
    },
  })(host.pi);

  assert.ok(store, 'store was constructed');
  const inv = store.inventory();
  assert.equal(inv.stale, true, 'inventory is stale');
  assert.equal(inv.version, '5.1.44');
  assert.equal(inv.readOnly, true);
  assert.equal(inv.label, '인벤토리 갱신 필요');

  const state = store.state();
  assert.equal(state.inventory.stale, true);
  assert.equal(state.readOnly, true);
  assert.equal(state.readOnlyReason, 'INVENTORY_STALE');
  assert.equal(state.banner, '인벤토리 갱신 필요');
});
