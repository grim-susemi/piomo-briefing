import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  fixture, cardsFile, nativeBase, base, readJson, put, request, apply, add, disk, diagnostic,
} from './helpers/profiles-cards-fixture.mjs';

const maximum = Number.MAX_SAFE_INTEGER;
for (const scenario of [
  { name: 'exhausted sequence', sequence: maximum, num: 7, accepted: false, field: 'nextCustomSeq' },
  { name: 'exhausted number', sequence: 2, num: maximum, accepted: false, field: 'num' },
  { name: 'preceding sequence', sequence: maximum - 1, num: 7, accepted: true, key: `custom-${maximum - 1}`, next: maximum, allocatedNum: 8 },
  { name: 'preceding number', sequence: 2, num: maximum - 1, accepted: true, key: 'custom-2', next: 3, allocatedNum: maximum },
  { name: 'progressing collision', sequence: maximum - 2, num: 7, occupied: maximum - 2,
    accepted: true, key: `custom-${maximum - 1}`, next: maximum, allocatedNum: 8 },
]) {
  test(`allocator boundary ${scenario.name} preserves readable metadata`, t => {
    const fx = fixture(t, { stable: true, mirror: true });
    apply(fx, [add()]);
    const metadataPath = path.join(fx.home, cardsFile), metadata = readJson(metadataPath);
    metadata.nextCustomSeq = scenario.sequence;
    metadata.custom[0].num = scenario.num;
    put(metadataPath, metadata);
    if (scenario.occupied !== undefined) {
      const configPath = path.join(fx.mirrors[0], 'omo.jsonc'), config = readJson(configPath);
      config.profiles[`native-custom-${scenario.occupied}`] = structuredClone(config.profiles[nativeBase]);
      put(configPath, config);
    }
    const before = disk(fx), state = fx.reopen().state();
    assert.equal(state.profileCards.writable, true);
    assert.equal(state.profiles.length, 7);
    const result = fx.store.handle(request(fx.store, [add('boundary')]));
    if (scenario.accepted) {
      assert.equal(result.status, 200, JSON.stringify(result));
      const saved = readJson(metadataPath), reopened = fx.reopen().state();
      assert.equal(saved.custom.at(-1).key, scenario.key);
      assert.equal(saved.custom.at(-1).num, scenario.allocatedNum);
      assert.equal(saved.nextCustomSeq, scenario.next);
      assert.equal(reopened.profileCards.writable, true);
      assert.equal(reopened.profiles.length, 8);
    } else {
      assert.equal(result.status, 400, JSON.stringify(result));
      assert.deepEqual(result.json.errors, [{ field: scenario.field, reason: 'EXHAUSTED' }]);
      assert.deepEqual(disk(fx), before);
      assert.deepEqual(fx.reopen().state(), state);
      apply(fx, [{ kind: 'selectProfile', profileKey: base }]);
      assert.deepEqual(readJson(metadataPath), metadata);
      assert.equal(fx.reopen().state().profiles.length, 7);
    }
    diagnostic(t, 'allocator-boundary', { scenario, result, before, after: disk(fx) });
  });
}

test('allocator collision at exhausted successors terminates without writes', t => {
  const child = spawnSync(process.execPath, [
    '--import', new URL('./helpers/refuse-live-writes.mjs', import.meta.url).href,
    fileURLToPath(new URL('./helpers/profiles-cards-allocation-probe.mjs', import.meta.url)),
  ], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, JSON.stringify({ error: child.error?.message, stderr: child.stderr }));
  diagnostic(t, 'allocator-collision-deadline', { childExit: child.status, output: child.stdout });
});
