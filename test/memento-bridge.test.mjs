import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMementoApi } from '../src/memento-bridge.mjs';

const KEY = Symbol.for('omo.memento.api.v1');
const api = () => ({
  version: 1,
  features: ['cards.read', 'cards.setStatus'],
  state() { return { schema: 'memento.board-state.v1' }; },
  handle() { return { status: 200, body: { ok: true, rev: 2, discord: 'pushed' } }; },
});

test('a missing discovery slot is MEMENTO_UNAVAILABLE', () => {
  assert.deepEqual(getMementoApi({}), { ok: false, code: 'MEMENTO_UNAVAILABLE' });
  assert.deepEqual(getMementoApi(null), { ok: false, code: 'MEMENTO_UNAVAILABLE' });
});

test('a published version other than 1 is API_VERSION_UNSUPPORTED', () => {
  for (const version of [2, '1', null, undefined]) {
    const host = { [KEY]: { ...api(), version } };
    assert.deepEqual(getMementoApi(host), { ok: false, code: 'API_VERSION_UNSUPPORTED' });
  }
});

test('version 1 without the contract surface is MEMENTO_UNAVAILABLE', () => {
  const cases = [
    { ...api(), features: undefined },
    { ...api(), state: undefined },
    { ...api(), handle: undefined },
    { ...api(), features: ['cards.read'] },
  ];
  for (const value of cases) {
    assert.deepEqual(getMementoApi({ [KEY]: value }), { ok: false, code: 'MEMENTO_UNAVAILABLE' });
  }
});

test('a valid contract object is returned by identity', () => {
  const value = api();
  const result = getMementoApi({ [KEY]: value });
  assert.deepEqual(result, { ok: true, value });
  assert.equal(result.value, value);
});

test('the default host is globalThis and the slot uses the contract symbol', () => {
  const value = api();
  globalThis[KEY] = value;
  try {
    const result = getMementoApi();
    assert.equal(result.ok, true);
    assert.equal(result.value, value);
  } finally {
    delete globalThis[KEY];
  }
});
