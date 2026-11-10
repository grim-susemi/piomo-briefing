import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  fixture, cardsFile, mainFile, backupFile, base, nativeBase, readJson, put,
  request, apply, add, disk, diagnostic,
} from './helpers/profiles-cards-fixture.mjs';

test('custom sequence never reuses deleted blocks or numbers occupied in any stored owner (6)', t => {
  const fx = fixture(t, { stable: true, mirror: true });
  apply(fx, [add()]);
  apply(fx, [add('second')]);
  assert.equal(fx.reopen().state().profiles.at(-1).key, 'custom-2');
  for (const home of fx.homes) {
    const config = readJson(path.join(home, 'omo.jsonc'));
    delete config.profiles['native-custom-1'];
    put(path.join(home, 'omo.jsonc'), config);
  }
  const mirror = fx.mirrors[0], mirrorConfig = readJson(path.join(mirror, 'omo.jsonc'));
  mirrorConfig.profiles['native-custom-3'] = structuredClone(mirrorConfig.profiles[nativeBase]);
  put(path.join(mirror, 'omo.jsonc'), mirrorConfig);
  put(path.join(fx.home, mainFile), { 'native-custom-4': { provider: 'openai', model: 'gpt-6-sol', thinking: 'high' } });
  put(path.join(fx.home, backupFile), { version: 1, profiles: { 'native-custom-5': { agents: { explore: 'sol-61-high' } } } });
  put(path.join(mirror, mainFile), { 'native-custom-6': { provider: 'openai', model: 'gpt-6-sol', thinking: 'high' } });
  apply(fx, [add('seventh')]);
  assert.equal(fx.reopen().state().profiles.at(-1).key, 'custom-7');
});

test('thirteen successive additions have no artificial count cap (7)', t => {
  const fx = fixture(t);
  for (let n = 1; n <= 13; n++) {
    apply(fx, [add('profile ' + n)]);
    assert.equal(fx.reopen().state().profiles.at(-1).key, 'custom-' + n);
  }
  assert.equal(fx.reopen().state().profiles.length, 19);
});

for (const missing of ['primary', 'stable', 'mirror']) {
  test(`a missing ${missing} base refuses creation before every write (7,13)`, t => {
    const fx = fixture(t, { stable: true, mirror: true });
    const home = missing === 'primary' ? fx.home : missing === 'stable' ? fx.stable : fx.mirrors[0];
    const config = readJson(path.join(home, 'omo.jsonc'));
    delete config.profiles[nativeBase];
    put(path.join(home, 'omo.jsonc'), config);
    const before = disk(fx), result = fx.store.apply(request(fx.store, [add()]));
    assert.equal(result.code, 'BASE_MISSING', JSON.stringify(result));
    assert.deepEqual(disk(fx), before);
  });
}

for (const [label, text] of [
  ['absent', null], ['empty', ''], ['bad-json', '{'], ['future-version', '{"version":2}'],
  ['selected-custom-corrupt', '{'],
]) {
  test(`default selection remains usable with ${label} cards (8,12)`, t => {
    const fx = fixture(t);
    if (label === 'selected-custom-corrupt') {
      apply(fx, [add()]);
      apply(fx, [{ kind: 'selectProfile', profileKey: 'custom-1' }]);
    }
    const file = path.join(fx.home, cardsFile);
    if (text !== null) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    const state = fx.reopen().state();
    if (text !== null) {
      assert.equal(state.profileCards.writable, false);
      assert.equal(state.profiles.length, 6);
      assert.ok(state.warnings.some(warning => warning.includes('profile cards')));
      if (label === 'selected-custom-corrupt') assert.equal(state.activeProfile, null);
      const before = disk(fx);
      for (const change of [add(), { kind: 'setProfileCard', profileKey: base, name: 'changed' }]) {
        assert.equal(fx.store.apply(request(fx.store, [change])).code, 'BAD_PROFILE_CARDS');
        assert.deepEqual(disk(fx), before);
      }
    } else assert.equal(state.profileCards.writable, true);
    apply(fx, [{ kind: 'selectProfile', profileKey: base }]);
    if (text !== null) assert.equal(fs.readFileSync(file, 'utf8'), text);
    diagnostic(t, 'corrupt-boundary-' + label, { writable: state.profileCards, warnings: state.warnings });
  });
}

test('incomplete custom default tuples invalidate metadata without blocking old changes (8)', t => {
  const fx = fixture(t);
  apply(fx, [add()]);
  const file = path.join(fx.home, cardsFile), value = readJson(file);
  delete value.custom[0].mainProvider;
  put(file, value);
  assert.equal(fx.reopen().state().profileCards.writable, false);
  assert.equal(fx.store.apply(request(fx.store, [add()])).code, 'BAD_PROFILE_CARDS');
  apply(fx, [{ kind: 'selectProfile', profileKey: base }]);
});

test('card metadata compare-and-swap rejects a stale writer with 409 (10)', t => {
  const fx = fixture(t);
  const stale = request(fx.store, [{ kind: 'setProfileCard', profileKey: base, name: 'stale' }]);
  apply(fx, [{ kind: 'setProfileCard', profileKey: base, name: 'fresh' }]);
  const before = disk(fx), result = fx.store.handle(stale);
  assert.equal(result.status, 409);
  assert.equal(result.json.file, cardsFile);
  assert.deepEqual(disk(fx), before);
  diagnostic(t, 'cas', { result, before });
});

test('interrupted writes roll back, repeated retry recovers, restored metadata skips orphan numbers (14)', t => {
  let failures = 2;
  const fx = fixture(t, { stable: true, mirror: true, hooks: {
    beforeWrite(id) {
      if (id === cardsFile && failures-- > 0) throw new Error('intentional cards boundary interruption');
    },
  } });
  const before = fx.store.state().targets;
  for (let n = 0; n < 2; n++) {
    const result = fx.store.apply(request(fx.store, [add()]));
    assert.equal(result.code, 'ROLLED_BACK', JSON.stringify(result));
    assert.deepEqual(fx.store.state().targets, before);
  }
  apply(fx, [add()]);
  const firstMetadata = fs.readFileSync(path.join(fx.home, cardsFile));
  const second = apply(fx, [add('second')]);
  const metadataBackup = second.backups.find(file => path.basename(file).startsWith('profile-cards-'));
  assert.deepEqual(fs.readFileSync(metadataBackup), firstMetadata);
  fs.copyFileSync(metadataBackup, path.join(fx.home, cardsFile));
  apply(fx, [add('third')]);
  assert.equal(fx.reopen().state().profiles.at(-1).key, 'custom-3');
  diagnostic(t, 'interruption-recovery', { final: fx.store.state().targets, second });
});

test('legacy reviewer keys anywhere in a base reject before creating orphan layers (15)', t => {
  const fx = fixture(t, { stable: true });
  const config = readJson(path.join(fx.stable, 'omo.jsonc'));
  config.profiles[nativeBase]['[native]'].agents['omo-senpi-code-reviewer'] = { model: 'sol-61-high' };
  put(path.join(fx.stable, 'omo.jsonc'), config);
  const before = disk(fx), result = fx.store.apply(request(fx.store, [add()]));
  assert.equal(result.code, 'LEGACY_REVIEWER_KEYS', JSON.stringify(result));
  assert.deepEqual(disk(fx), before);
});

test('a process interrupted before metadata publication resumes the recorded transaction (14)', t => {
  const fx = fixture(t, { stable: true, mirror: true, sidecars: true });
  const child = spawnSync(process.execPath, [
    '--import', new URL('./helpers/refuse-live-writes.mjs', import.meta.url).href,
    fileURLToPath(new URL('./helpers/profiles-cards-crash.mjs', import.meta.url)), JSON.stringify(fx.storeOptions),
  ], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 73, child.stderr);
  const interrupted = fx.reopen().journal();
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(fs.existsSync(path.join(fx.home, cardsFile)), false);
  for (const home of fx.homes) {
    assert.deepEqual(readJson(path.join(home, 'omo.jsonc')).profiles['native-custom-1'],
      readJson(path.join(home, 'omo.jsonc')).profiles[nativeBase]);
  }
  const result = apply(fx, interrupted.reapply.changes);
  assert.equal(result.recoveredFrom, interrupted.id);
  const state = fx.reopen().state();
  assert.equal(state.profiles.at(-1).key, 'custom-1');
  assert.equal(state.profiles.length, 7);
  assert.equal(state.applyJournal.status, 'completed');
  for (const home of fx.homes) assert.equal(Object.hasOwn(readJson(path.join(home, 'omo.jsonc')).profiles, 'native-custom-2'), false);
  diagnostic(t, 'durable-interruption', { childExit: child.status, interrupted, result, hashes: state.targets });
});

test('creation from a custom base keeps persisted defaults and choices after reopen', t => {
  const fx = fixture(t, { sidecars: true });
  apply(fx, [add()]);
  apply(fx, [{ ...add('custom clone'), baseProfileKey: 'custom-1' }]);
  const state = fx.reopen().state();
  assert.equal(state.profiles.at(-1).key, 'custom-2');
  assert.equal(state.profiles.at(-1).mainProvider, 'kimi-coding');
  const config = readJson(path.join(fx.home, 'omo.jsonc'));
  assert.deepEqual(config.profiles['native-custom-2'], config.profiles['native-custom-1']);
  const main = readJson(path.join(fx.home, mainFile));
  assert.deepEqual(main['native-custom-2'], main['native-custom-1']);
  assert.deepEqual(readJson(path.join(fx.home, backupFile)).profiles['native-custom-2'],
    readJson(path.join(fx.home, backupFile)).profiles['native-custom-1']);
});
