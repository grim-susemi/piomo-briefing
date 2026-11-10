import assert from 'node:assert/strict';
import path from 'node:path';
import {
  fixture, cardsFile, nativeBase, readJson, put, request, apply, add, disk,
} from './profiles-cards-fixture.mjs';

const cleanups = [];
const fx = fixture({ after(cleanup) { cleanups.push(cleanup); } });
try {
  apply(fx, [add()]);
  const metadataPath = path.join(fx.home, cardsFile), metadata = readJson(metadataPath);
  metadata.nextCustomSeq = Number.MAX_SAFE_INTEGER - 1;
  put(metadataPath, metadata);
  const configPath = path.join(fx.home, 'omo.jsonc'), config = readJson(configPath);
  for (const suffix of ['9007199254740990', '9007199254740991', '9007199254740992']) {
    config.profiles['native-custom-' + suffix] = structuredClone(config.profiles[nativeBase]);
  }
  put(configPath, config);
  const before = disk(fx), state = fx.reopen().state();
  const result = fx.store.handle(request(fx.store, [add('collision')]));
  assert.equal(result.status, 400, JSON.stringify(result));
  assert.deepEqual(result.json.errors, [{ field: 'nextCustomSeq', reason: 'EXHAUSTED' }]);
  assert.deepEqual(disk(fx), before);
  assert.deepEqual(fx.reopen().state(), state);
  console.log(JSON.stringify({ result, before, root: fx.root }));
} finally {
  for (const cleanup of cleanups) cleanup();
  console.log(JSON.stringify({ removedOwnedRoot: fx.root }));
}
