import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProfilesStore, sha256 } from '../../src/profiles/store.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
export const cardsFile = 'runtime/native-profile-switcher-profile-cards.json';
export const mainFile = 'runtime/native-profile-switcher-main.json';
export const backupFile = 'runtime/native-profile-switcher-role-backups.json';
export const base = 'gpt-kimi-deepseek';
export const nativeBase = 'native-' + base;
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-cards-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'primary');
  const stable = options.stable ? path.join(root, 'stable') : home;
  const mirrors = options.mirror ? [path.join(root, 'mirror', 'home', 'fixture')] : [];
  const homes = [...new Set([home, stable, ...mirrors])];
  for (const [index, destination] of homes.entries()) {
    fs.mkdirSync(path.join(destination, 'agent'), { recursive: true });
    const golden = path.join(repo, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files/primary');
    for (const [source, target] of [
      ['omo.jsonc.json', 'omo.jsonc'], ['settings.json.json', 'agent/settings.json'],
      ['selection.json.json', 'native-profile-selection.json'],
      ['agent-selection.json.json', 'agent/native-profile-selection.json'],
    ]) fs.copyFileSync(path.join(golden, source), path.join(destination, target));
    fs.copyFileSync(path.join(repo, 'test/fixtures/profiles/registry/primary/agent/models.json'),
      path.join(destination, 'agent/models.json'));
    const config = readJson(path.join(destination, 'omo.jsonc'));
    config.profiles[nativeBase].task = { max_depth: index + 2 };
    put(path.join(destination, 'omo.jsonc'), config);
    if (options.sidecars) {
      put(path.join(destination, mainFile), {
        [nativeBase]: { provider: 'openai', model: 'gpt-6-sol', thinking: 'high' },
      });
    }
  }
  if (options.sidecars) put(path.join(home, backupFile), {
    version: 1, profiles: { [nativeBase]: { agents: { explore: 'sol-61-high' } } },
  });
  const inventory = readJson(path.join(repo, 'src/profiles/inventory.json'));
  const plugin = path.join(root, 'fixture-plugin.mjs');
  fs.writeFileSync(plugin, 'cards-public-store-fixture');
  inventory.sources.omo.sha256 = sha256(fs.readFileSync(plugin));
  const storeOptions = {
    primaryHome: home, stableHome: stable, mirrorHomes: mirrors,
    pluginPath: plugin, inventory, recommendationManifest: null,
    hooks: options.hooks, now: () => Date.parse('2026-11-10T01:00:00Z'),
  };
  const store = openProfilesStore(storeOptions);
  return { root, home, stable, mirrors, homes, store, storeOptions, reopen: () => openProfilesStore(storeOptions) };
}
export function request(store, changes, action = 'apply') {
  const state = store.state();
  return { action, changes, expected: state.targets, rosterRevision: state.roster.revision };
}
export function apply(fx, changes) {
  const result = fx.store.apply(request(fx.store, changes));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
export const add = (name = '내 조합') => ({
  kind: 'addProfile', name, tag: '내 꼬리표', summary: '내 설명', baseProfileKey: base,
});
export function disk(fx) {
  return Object.fromEntries(fx.homes.flatMap(home => fs.readdirSync(home, { recursive: true })
    .map(rel => path.join(home, rel)).filter(file => fs.statSync(file).isFile())
    .map(file => [file, sha256(fs.readFileSync(file))])));
}
export function diagnostic(t, scenario, value) {
  t.diagnostic(JSON.stringify({ scenario, ...value }));
}
