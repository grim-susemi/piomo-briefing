// The extension hands the live session model registry to the profiles store. The
// store-to-render suite proves the registry list becomes picker options; this test
// proves the handoff itself points at the current session's registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createBriefingExtension } from '../extension.mjs';
import { makeFakePi, makeCtx } from './helpers/fake-pi.mjs';
import { tempDir } from './helpers/temp.mjs';

test('the profiles store registry getter resolves to the live session model registry', async (t) => {
  const { dir, onDispose } = tempDir(t, 'omo-ext-registry-');
  let captured = null;
  const fakeStore = { handle: () => ({ status: 200, json: {} }), state: () => ({}) };
  const host = makeFakePi({ sessionKind: 'interactive' });
  createBriefingExtension({
    stateDir: join(dir, 'state'),
    now: () => 1_700_000_000_000,
    env: { PATH: process.env.PATH },
    createProfilesStore: (options) => { captured = options; return fakeStore; },
  })(host.pi);
  const { ctx } = makeCtx({ sid: 'sess-registry', file: 'C:/sessions/sess-registry.jsonl' });
  onDispose(() => host.emit('session_shutdown', {}, ctx));

  assert.equal(typeof captured.registry, 'function', 'the store receives a registry getter');
  assert.equal(captured.registry(), null, 'no session context exists before session_start');
  const registry = { getAvailable: () => [{ provider: 'chatgpt-subscription', id: 'gpt-7-nova' }] };
  ctx.modelRegistry = registry;
  await host.emit('session_start', { reason: 'startup' }, ctx);
  assert.equal(captured.registry(), registry, 'the getter follows the live session registry');
});
