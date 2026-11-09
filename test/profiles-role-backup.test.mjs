import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { fallbackFixture } from './helpers/fallback-fixture.mjs';
import { ROLE_BACKUP_FILE } from '../src/profiles/role-backup.mjs';
import { ROLE_INVENTORY } from '../src/profiles/model.mjs';
import { AGENT_IDS } from '../src/profiles/contract/constants.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const profileKey = 'native-gpt-kimi-deepseek';
const pick = (role, alias, section = 'agents', profile = profileKey) =>
  ({ kind: 'setRoleBackup', profileKey: profile, section, role, alias });
const file = (fx) => path.join(fx.home, ROLE_BACKUP_FILE);
const chosen = (state, role, card = 'gpt-kimi-deepseek', section = 'agents') =>
  section === 'primary' ? state.details[card].primaryBackups[role].alias :
    state.details[card].routing.rows.find(row => row.section === section && row.role === role).backup.alias;
function fixture(t) { const fx = fallbackFixture(); t.after(() => fx.close()); return fx; }

test('reading unset backups never creates settings or selects a default', (t) => {
  const fx = fixture(t);
  const before = fs.readFileSync(path.join(fx.home, 'omo.jsonc'));
  assert.ok(fx.reopen().state().routing.rows.every(row => row.backup.alias === ''));
  assert.equal(fs.existsSync(file(fx)), false);
  assert.deepEqual(fs.readFileSync(path.join(fx.home, 'omo.jsonc')), before);
});

test('each existing role stores its own choice without changing execution config', (t) => {
  const fx = fixture(t);
  const configBefore = fs.readFileSync(path.join(fx.home, 'omo.jsonc'));
  const settingsBefore = fs.readFileSync(path.join(fx.home, 'agent/settings.json'));
  const changes = [
    ...AGENT_IDS.map(id => pick(id, 'sol-61-high', 'primary')),
    ...Object.entries(ROLE_INVENTORY).flatMap(([section, roles]) => roles.map(role => pick(role, 'sol-high', section))),
  ];
  const result = fx.store.apply(fx.body(changes));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.writes, [ROLE_BACKUP_FILE]);
  const reopened = fx.reopen().state();
  for (const change of changes) assert.equal(chosen(reopened, change.role, 'gpt-kimi-deepseek', change.section), change.alias);
  assert.deepEqual(fs.readFileSync(path.join(fx.home, 'omo.jsonc')), configBefore);
  assert.deepEqual(fs.readFileSync(path.join(fx.home, 'agent/settings.json')), settingsBefore);
});

test('profiles and roles remain independent after replace, clear and profile activation', (t) => {
  const fx = fixture(t);
  const other = 'native-kimi-deepseek';
  assert.equal(fx.store.apply(fx.body([
    pick('explore', 'sol-high'), pick('librarian', 'kimi'), pick('explore', 'sol-medium', 'agents', other),
  ])).ok, true);
  assert.equal(fx.store.apply(fx.body([pick('explore', 'fable')])).ok, true);
  assert.equal(fx.store.apply(fx.body([pick('explore', '')])).ok, true);
  const sidecarBefore = fs.readFileSync(file(fx));
  const result = fx.store.apply(fx.body([{ kind: 'selectProfile', profileKey: 'kimi-deepseek' }]));
  assert.equal(result.ok, true, JSON.stringify(result));
  const state = fx.reopen().state();
  assert.equal(chosen(state, 'explore'), '');
  assert.equal(chosen(state, 'librarian'), 'kimi');
  assert.equal(chosen(state, 'explore', 'kimi-deepseek'), 'sol-medium');
  assert.deepEqual(fs.readFileSync(file(fx)), sidecarBefore);
});

test('preview is read-only and stale revisions cannot overwrite another saved choice', (t) => {
  const fx = fixture(t);
  const stale = fx.body([pick('explore', 'sol-medium')]);
  const preview = fx.store.preview(fx.body([pick('explore', 'sol-high')], 'preview'));
  assert.equal(preview.ok, true);
  assert.equal(fs.existsSync(file(fx)), false);
  assert.equal(fx.store.apply(fx.body([pick('explore', 'kimi')])).ok, true);
  assert.equal(fx.store.apply(stale).code, 'STALE');
  assert.equal(chosen(fx.reopen().state(), 'explore'), 'kimi');
});

test('invalid roles, aliases and forbidden provider choices are refused without writes', (t) => {
  const fx = fixture(t);
  const state = fx.store.state();
  const forbidden = Object.keys(state.catalog).find(alias =>
    state.catalog[alias].model.startsWith('opencode-go/') && !state.catalog[alias].model.includes('/muse-'));
  assert.ok(forbidden);
  for (const change of [
    pick('__proto__', 'sol-high'), pick('explore', 'unknown'), pick('explore', forbidden),
    pick('hephaestus', 'kimi', 'primary'), pick('explore', 'sol-high', 'agents', 'unknown'),
  ]) {
    assert.equal(fx.store.apply(fx.body([change])).ok, false);
    assert.equal(fs.existsSync(file(fx)), false);
  }
});

test('malformed stored selections are preserved and block an overwrite', (t) => {
  const fx = fixture(t);
  fs.mkdirSync(path.dirname(file(fx)), { recursive: true });
  fs.writeFileSync(file(fx), '{"version":2,"profiles":{}}');
  const before = fs.readFileSync(file(fx));
  const result = fx.store.apply(fx.body([pick('explore', 'sol-high')]));
  assert.equal(result.code, 'INVALID_CONFIG');
  assert.deepEqual(fs.readFileSync(file(fx)), before);
});

test('backup-only controller save never activates a profile or changes the main model', async (t) => {
  const fx = fixture(t);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'src/page/profiles-view.js'), 'utf8'), context);
  const bodies = [];
  const controller = context.BriefProfiles.createController({
    token: 'fixture',
    fetch: async (url, options) => {
      if (!options?.body) return { status: 200, json: async () => fx.store.state() };
      const body = JSON.parse(options.body);
      bodies.push(body);
      const result = fx.store.handle(body);
      return { status: result.status, json: async () => result.json };
    },
  });
  await controller.load();
  controller.show('kimi-deepseek');
  controller.add(pick('explore', 'sol-high', 'agents', 'native-kimi-deepseek'));
  const configBefore = fs.readFileSync(path.join(fx.home, 'omo.jsonc'));
  const settingsBefore = fs.readFileSync(path.join(fx.home, 'agent/settings.json'));
  await controller.apply();
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].changes, [pick('explore', 'sol-high', 'agents', 'native-kimi-deepseek')]);
  assert.equal(chosen(fx.reopen().state(), 'explore', 'kimi-deepseek'), 'sol-high');
  assert.equal(fx.reopen().state().activeProfile.key, 'gpt-kimi-deepseek');
  assert.deepEqual(fs.readFileSync(path.join(fx.home, 'omo.jsonc')), configBefore);
  assert.deepEqual(fs.readFileSync(path.join(fx.home, 'agent/settings.json')), settingsBefore);
});

test('a stored alias stays selected when it is unavailable or now matches the primary', (t) => {
  const fx = fixture(t);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'src/page/profiles-view.js'), 'utf8'), context);
  for (const alias of ['flash-high', 'unavailable-saved-alias']) {
    fs.mkdirSync(path.dirname(file(fx)), { recursive: true });
    fs.writeFileSync(file(fx), JSON.stringify({ version: 1, profiles: {
      [profileKey]: { agents: { explore: alias } },
    } }));
    const html = context.BriefProfiles.render(fx.reopen().state(), {
      live: true, shown: 'gpt-kimi-deepseek', tab: 'agents', openRow: 'route:agents/explore',
      pending: [], draft: {}, busy: false,
    });
    const select = /<select[^>]*id="pf-route-agents-explore-backup"[^>]*>([\s\S]*?)<\/select>/.exec(html);
    assert.ok(select);
    const selected = [...select[1].matchAll(/<option\b([^>]*)>/g)].find(m => /\bselected\b/.test(m[1]));
    assert.ok(selected);
    assert.equal(/\bvalue="([^"]*)"/.exec(selected[1])[1], alias);
    assert.equal(chosen(fx.reopen().state(), 'explore'), alias);
  }
});

test('saving while another profile holds the only pending backup cannot activate the shown profile', async (t) => {
  const fx = fixture(t);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'src/page/profiles-view.js'), 'utf8'), context);
  const posted = [];
  const controller = context.BriefProfiles.createController({
    token: 'fixture',
    fetch: async (url, options) => {
      if (!options?.body) return { status: 200, json: async () => fx.store.state() };
      const body = JSON.parse(options.body);
      posted.push(body);
      const result = fx.store.handle(body);
      return { status: result.status, json: async () => result.json };
    },
  });
  await controller.load();
  controller.add(pick('explore', 'sol-high'));
  controller.show('kimi-deepseek');
  const configBefore = fs.readFileSync(path.join(fx.home, 'omo.jsonc'));
  const settingsBefore = fs.readFileSync(path.join(fx.home, 'agent/settings.json'));
  await controller.apply();
  assert.deepEqual(posted, []);
  assert.equal(controller.snapshot().pending.length, 1);
  assert.equal(fx.reopen().state().activeProfile.key, 'gpt-kimi-deepseek');
  assert.deepEqual(fs.readFileSync(path.join(fx.home, 'omo.jsonc')), configBefore);
  assert.deepEqual(fs.readFileSync(path.join(fx.home, 'agent/settings.json')), settingsBefore);
  assert.equal(fs.existsSync(file(fx)), false);
  const html = context.BriefProfiles.render(fx.reopen().state(), { ...controller.snapshot(), live: true });
  assert.match(html, /<button\b(?=[^>]*data-pf="apply")(?=[^>]*disabled)[^>]*>/);
});

test('direct backup service, model and effort reopen for every role without changing main settings', (t) => {
  const fx = fixture(t);
  const before = ['omo.jsonc', 'agent/settings.json', 'native-profile-selection.json']
    .map(name => [name, fs.readFileSync(path.join(fx.home, name))]);
  const direct = { provider: 'chatgpt-subscription', model: 'gpt-6.1-sol', thinking: 'medium' };
  const roles = [
    ...AGENT_IDS.map(role => ({ section: 'primary', role })),
    ...Object.entries(ROLE_INVENTORY).flatMap(([section, list]) => list.map(role => ({ section, role }))),
  ];
  const result = fx.store.apply(fx.body(roles.map(row => ({
    kind: 'setRoleBackup', profileKey, ...row, ...direct,
  }))));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.writes, [ROLE_BACKUP_FILE]);
  const stored = JSON.parse(fs.readFileSync(file(fx), 'utf8'));
  const state = fx.reopen().state();
  for (const { section, role } of roles) {
    assert.deepEqual(stored.profiles[profileKey][section][role], direct);
    const choice = section === 'primary' ? state.details['gpt-kimi-deepseek'].primaryBackups[role]
      : state.details['gpt-kimi-deepseek'].routing.rows.find(row => row.section === section && row.role === role).backup;
    assert.equal(choice.model, 'chatgpt-subscription/gpt-6.1-sol');
    assert.equal(choice.thinking, 'medium');
  }
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(fx.home, name)), bytes);
});

test('saving a direct backup preserves existing legacy aliases and can explicitly clear the direct value', (t) => {
  const fx = fixture(t);
  assert.equal(fx.store.apply(fx.body([pick('librarian', 'sol-high')])).ok, true);
  const direct = { kind: 'setRoleBackup', profileKey, section: 'agents', role: 'explore',
    provider: 'chatgpt-subscription', model: 'gpt-6.1-sol', thinking: 'medium' };
  assert.equal(fx.store.apply(fx.body([direct])).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file(fx))).profiles[profileKey].agents.librarian, 'sol-high');
  assert.equal(chosen(fx.reopen().state(), 'librarian'), 'sol-high');
  assert.equal(fx.store.apply(fx.body([pick('explore', '')])).ok, true);
  const stored = JSON.parse(fs.readFileSync(file(fx)));
  assert.equal(Object.hasOwn(stored.profiles[profileKey].agents, 'explore'), false);
  assert.equal(stored.profiles[profileKey].agents.librarian, 'sol-high');
});

test('incomplete, conflicting, unsupported or forbidden direct backup fields cannot write a selection', (t) => {
  const fx = fixture(t);
  const direct = { kind: 'setRoleBackup', profileKey, section: 'agents', role: 'explore',
    provider: 'chatgpt-subscription', model: 'gpt-6.1-sol', thinking: 'medium' };
  for (const patch of [
    { provider: '' }, { model: '' }, { thinking: '' }, { thinking: 'invented' },
    { alias: 'sol-high' }, { provider: 'ollama' }, { model: 'not-an-existing-model' },
    { section: 'primary', role: 'hephaestus', provider: 'ollama', model: 'deepseek-v4.1-flash' },
    { provider: 'opencode-go', model: 'kimi-k2' },
  ]) {
    const result = fx.store.apply(fx.body([{ ...direct, ...patch }]));
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(fs.existsSync(file(fx)), false);
  }
});

test('saving another profile preserves an unfinished backup draft without saving or activating it', async (t) => {
  const fx = fixture(t);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'src/page/profiles-view.js'), 'utf8'), context);
  const controller = context.BriefProfiles.createController({
    token: 'fixture',
    fetch: async (url, options) => {
      if (!options?.body) return { status: 200, json: async () => fx.store.state() };
      const result = fx.store.handle(JSON.parse(options.body));
      return { status: result.status, json: async () => result.json };
    },
  });
  await controller.load();
  const keyA = 'backup:native-gpt-kimi-deepseek:agents/explore';
  const keyB = 'backup:native-kimi-deepseek:agents/explore';
  const partial = { provider: 'chatgpt-subscription', model: '', thinking: '' };
  const complete = { provider: 'chatgpt-subscription', model: 'gpt-6.1-sol', thinking: 'medium' };
  const before = fs.readFileSync(path.join(fx.home, 'omo.jsonc'));
  controller.setDraft(keyA, partial);
  controller.show('kimi-deepseek');
  controller.setDraft(keyB, complete);
  controller.add({ kind: 'setRoleBackup', profileKey: 'native-kimi-deepseek', section: 'agents', role: 'explore', ...complete });

  await controller.apply();
  controller.show('gpt-kimi-deepseek');

  assert.equal(Object.hasOwn(controller.snapshot().draft, keyA), true, 'unsent A backup draft must survive saving B');
  assert.deepEqual(JSON.parse(JSON.stringify(controller.snapshot().draft[keyA])), partial);
  assert.equal(Object.hasOwn(controller.snapshot().draft, keyB), false);
  const stored = JSON.parse(fs.readFileSync(file(fx)));
  assert.equal(Object.hasOwn(stored.profiles, profileKey), false);
  assert.deepEqual(stored.profiles['native-kimi-deepseek'].agents.explore, complete);
  assert.deepEqual(fs.readFileSync(path.join(fx.home, 'omo.jsonc')), before);
  assert.equal(fx.reopen().state().activeProfile.key, 'gpt-kimi-deepseek');
});
