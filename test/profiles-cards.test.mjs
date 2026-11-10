// Public store storage contracts; the imported lifecycle suite shares the planned invocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_META } from '../src/profiles/model.mjs';
import {
  fixture, cardsFile, mainFile, backupFile, base, nativeBase, readJson, put,
  request, apply, add, disk, diagnostic,
} from './helpers/profiles-cards-fixture.mjs';
import './profiles-cards-lifecycle.test.mjs';
import './profiles-cards-allocation.test.mjs';

test('card save previews and persists only metadata, reopens, resets, and backs up subsequent saves (1,2,3,16,17)', t => {
  const fx = fixture(t), initial = fx.store.state(), before = disk(fx);
  const text = ' <&"\\ · 한글 😀 ';
  const change = { kind: 'setProfileCard', profileKey: base, name: text, tag: text, summary: text };
  const preview = fx.store.preview(request(fx.store, [change], 'preview'));
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(disk(fx), before);
  const first = apply(fx, [change]);
  assert.deepEqual(first.writes, [cardsFile]);
  assert.deepEqual(first.backups, []);
  const state = fx.reopen().state(), card = state.profiles.find(p => p.key === base);
  for (const field of ['name', 'tag', 'summary']) assert.equal(card[field], text.trim());
  assert.equal(card.nameKr, text.trim());
  assert.equal(card.custom, false);
  assert.deepEqual(card.defaults, Object.fromEntries(['name', 'tag', 'summary'].map(k => [k, PROFILE_META[0][k]])));
  for (const [id, hash] of Object.entries(initial.targets)) {
    if (id !== cardsFile) assert.equal(state.targets[id], hash, id);
  }
  const second = apply(fx, [{ kind: 'setProfileCard', profileKey: base, name: null, tag: null, summary: null }]);
  assert.equal(second.backups.length, 1);
  assert.match(second.backups[0], /profile-cards-/);
  const reset = fx.reopen().state().profiles[0];
  for (const field of ['name', 'tag', 'summary']) {
    assert.equal(reset[field], PROFILE_META[0][field]);
    assert.equal(Object.hasOwn(readJson(path.join(fx.home, cardsFile)).cards[base] ?? {}, field), false);
  }
  apply(fx, [{ kind: 'setProfileCard', profileKey: base, name: PROFILE_META[0].name }]);
  assert.equal(Object.hasOwn(readJson(path.join(fx.home, cardsFile)).cards[base] ?? {}, 'name'), false);
  diagnostic(t, 'save-reopen-reset', { before, after: disk(fx), preview, first, second });
});

test('field errors identify unknown profile and invalid text without writes (4)', t => {
  const fx = fixture(t);
  apply(fx, [add()]);
  const cases = [
    [{ kind: 'setProfileCard', profileKey: 'unknown', name: 'x' }, 'profileKey', 'UNKNOWN_PROFILE'],
    [{ kind: 'setProfileCard', profileKey: base, name: '😀'.repeat(41) }, 'name', 'TOO_LONG'],
    [{ kind: 'setProfileCard', profileKey: base, tag: '\u007f' }, 'tag', 'CONTROL_CHAR'],
    [{ kind: 'setProfileCard', profileKey: base, summary: false }, 'summary', 'NOT_STRING'],
    [{ kind: 'setProfileCard', profileKey: 'custom-1', name: '  ' }, 'name', 'EMPTY'],
    [{ kind: 'setProfileCard', profileKey: 'custom-1', tag: null }, 'tag', 'NULL_NOT_ALLOWED'],
    [add(' '), 'name', 'EMPTY'],
    [{ ...add(), name: null }, 'name', 'NULL_NOT_ALLOWED'],
    [{ ...add(), baseProfileKey: 'unknown' }, 'baseProfileKey', 'UNKNOWN_PROFILE'],
    [{ ...add(), tag: 'x'.repeat(25) }, 'tag', 'TOO_LONG'],
    [{ ...add(), summary: 'x'.repeat(161) }, 'summary', 'TOO_LONG'],
    [{ kind: 'setProfileCard', profileKey: base, name: '\nx' }, 'name', 'CONTROL_CHAR'],
  ];
  const before = disk(fx);
  for (const [change, field, reason] of cases) {
    const result = fx.store.handle(request(fx.store, [change]));
    assert.equal(result.status, 400);
    assert.ok(result.json.errors.some(error => error.field === field && error.reason === reason), JSON.stringify(result));
    assert.deepEqual(disk(fx), before);
  }
  apply(fx, [{ kind: 'setProfileCard', profileKey: base, name: '😀'.repeat(40), tag: '', summary: '' }]);
  assert.equal(fx.reopen().state().profiles[0].name, '😀'.repeat(40));
});

test('creation clones own blocks and sidecar choices but leaves activation and protected files unchanged (5,13)', t => {
  const fx = fixture(t, { stable: true, mirror: true, sidecars: true });
  const initial = fx.store.state(), before = disk(fx);
  const blocks = fx.homes.map(home => readJson(path.join(home, 'omo.jsonc')));
  const result = apply(fx, [add()]);
  for (const [index, home] of fx.homes.entries()) {
    const config = readJson(path.join(home, 'omo.jsonc'));
    assert.deepEqual(config.profiles['native-custom-1'], blocks[index].profiles[nativeBase]);
    delete config.profiles['native-custom-1'];
    assert.deepEqual(config, blocks[index]);
  }
  for (const home of [fx.home, ...fx.mirrors]) {
    const main = readJson(path.join(home, mainFile));
    assert.deepEqual(main['native-custom-1'], main[nativeBase]);
  }
  const backups = readJson(path.join(fx.home, backupFile));
  assert.deepEqual(backups.profiles['native-custom-1'], backups.profiles[nativeBase]);
  const state = fx.reopen().state(), custom = state.profiles.at(-1);
  assert.equal(custom.key, 'custom-1');
  assert.equal(custom.custom, true);
  assert.equal(custom.defaults, null);
  assert.equal(custom.num, 7);
  assert.deepEqual(state.activeProfile, initial.activeProfile);
  assert.equal(typeof state.profileCards.subscriptionCopyLimitation, 'string');
  assert.ok(state.profileCards.subscriptionCopyLimitation.length);
  const after = disk(fx);
  for (const [file, hash] of Object.entries(before)) {
    if (!file.endsWith('omo.jsonc') && !file.endsWith(mainFile.replaceAll('/', path.sep))
      && !file.endsWith(backupFile.replaceAll('/', path.sep))) assert.equal(after[file], hash, file);
  }
  assert.equal(result.writes.at(-1), cardsFile);
  diagnostic(t, 'clone-all-homes', { before, after, result });
});

test('custom selection and route editing persist through the native profile layer only (9)', t => {
  const fx = fixture(t);
  apply(fx, [add()]);
  apply(fx, [{ kind: 'selectProfile', profileKey: 'custom-1' }]);
  for (const rel of ['native-profile-selection.json', 'agent/native-profile-selection.json']) {
    assert.equal(readJson(path.join(fx.home, rel)).profile, 'native-custom-1');
  }
  const before = readJson(path.join(fx.home, 'omo.jsonc'));
  apply(fx, [{
    kind: 'setRoute', profileKey: 'custom-1', section: 'agents', role: 'explore',
    provider: 'chatgpt-subscription', model: 'chatgpt-subscription/gpt-6.1-sol', thinking: 'high', alias: 'sol-61-high',
  }]);
  const after = readJson(path.join(fx.home, 'omo.jsonc'));
  assert.equal(after.profiles['native-custom-1']['[native]'].agents.explore.model, 'sol-61-high');
  assert.notDeepEqual(after.profiles['native-custom-1'], before.profiles['native-custom-1']);
  delete before.profiles['native-custom-1'];
  delete after.profiles['native-custom-1'];
  assert.deepEqual(after, before);
  diagnostic(t, 'select-and-route', { selected: fx.reopen().state().activeProfile });
});

test('custom main defaults survive absent main entry, selection, and blank-provider reset (11,18)', t => {
  const fx = fixture(t);
  apply(fx, [{ kind: 'selectProfile', profileKey: base }]);
  const original = readJson(path.join(fx.home, 'agent/settings.json'));
  apply(fx, [add()]);
  const metadata = readJson(path.join(fx.home, cardsFile)).custom[0];
  for (const field of ['mainProvider', 'mainModel', 'mainThinking', 'fallbackChains']) {
    assert.deepEqual(metadata[field], PROFILE_META[0][field]);
  }
  apply(fx, [{ kind: 'selectProfile', profileKey: 'custom-1' }]);
  apply(fx, [{ kind: 'setMain', profileKey: 'custom-1', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }]);
  assert.equal(readJson(path.join(fx.home, mainFile))['native-custom-1'].model, 'gpt-6-sol');
  apply(fx, [{ kind: 'setMain', profileKey: 'custom-1', provider: '', model: '', thinking: '' }]);
  const settings = readJson(path.join(fx.home, 'agent/settings.json'));
  assert.equal(settings.defaultProvider, original.defaultProvider);
  assert.equal(settings.defaultModel, original.defaultModel);
  apply(fx, [{ kind: 'setModelProfile', profileKey: 'custom-1', selection: 'custom-literal', literal: 'openai/gpt-6-sol' }]);
  assert.equal(fx.reopen().state().details['custom-1'].modelProfile.model_profile, 'openai/gpt-6-sol');
});
