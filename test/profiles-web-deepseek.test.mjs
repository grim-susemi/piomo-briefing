import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
function profiles() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('src/page/profiles-view.js', root), 'utf8'), context);
  return context.BriefProfiles;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('manual provider state changes preserve every staged assignment and use a separate revision', async () => {
  const view = JSON.parse(fs.readFileSync(new URL('test/fixtures/profiles-view-state.json', root)));
  view.webDeepseek = { installed: true, enabled: false, revision: 3, active: [] };
  const calls = [];
  const controller = profiles().createController({
    token: 'control-test',
    fetch: async (url, options) => {
      if (!options?.method) return { status: 200, json: async () => view };
      calls.push({ url, options });
      return { status: 200, json: async () => ({ ok: true,
        webDeepseek: { ...view.webDeepseek, enabled: true, revision: 4 } }) };
    },
  });
  await controller.load();
  controller.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-normal' });
  controller.setDraft('main', { model: 'unapplied-choice' });
  const before = plain(controller.snapshot());
  await controller.setWebDeepseek(true);
  const after = plain(controller.snapshot());
  assert.deepEqual(after.pending, before.pending);
  assert.deepEqual(after.draft, before.draft);
  assert.equal(after.view.webDeepseek.enabled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/profiles');
  assert.equal(calls[0].options.headers['X-Board-Token'], 'control-test');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    action: 'apply', changes: [{ kind: 'setWebDeepseekEnabled', enabled: true, expectedRevision: 3 }],
    expected: {}, rosterRevision: 0,
  });
});
