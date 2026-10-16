// Regression for the briefing/state leak + attribution audit of the plan-view integration run (plan todo 14).
// Runs only against a FIXTURE state directory built in the OS temp folder, never the live profile.
//   node --test test/integration/state-audit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventoryDir, auditState } from './state-audit.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-audit-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  put('data.js', 'window.__briefData({"seq":1});');
  put('published.json', '{"seq":1}');
  put('sessions/owner-1/meta.json', '{"title":"owner conversation"}');
  put('sessions/owner-1/briefs/000001.json', '{"n":1}');
  return { dir, put };
}
const IDS = ['01a140f7-8ea2-7f35-918e-f8a6f6806489', 'pb1a55e516eaa', 'st_pv14w1', 'C:/tmp/piomo-rpc14-XYZ'];

test('inventory records relative path, size and sha256 of every regular file', (t) => {
  const { dir } = fixture(t);
  const inv = inventoryDir(dir);
  assert.deepEqual(Object.keys(inv).sort(), ['data.js', 'published.json', 'sessions/owner-1/briefs/000001.json', 'sessions/owner-1/meta.json']);
  assert.equal(inv['published.json'].size, 9);
  assert.match(inv['published.json'].sha256, /^[0-9a-f]{64}$/);
});

test('concurrent owner changes (changed, added, removed) are reported and do not fail the leak check', (t) => {
  const { dir, put } = fixture(t);
  const before = inventoryDir(dir);
  put('data.js', 'window.__briefData({"seq":2});'); // pre-existing file rewritten by the owner's own conversation
  put('sessions/owner-1/briefs/000002.json', '{"n":2}'); // added by the owner
  fs.rmSync(path.join(dir, 'sessions/owner-1/briefs/000001.json')); // retention removal
  const r = auditState({ before, stateDir: dir, ids: IDS });
  assert.equal(r.pass, true);
  assert.deepEqual(r.leaks, []);
  assert.deepEqual(r.concurrentOwnerChanges.changed, ['data.js']);
  assert.deepEqual(r.concurrentOwnerChanges.added, ['sessions/owner-1/briefs/000002.json']);
  assert.deepEqual(r.concurrentOwnerChanges.removed, ['sessions/owner-1/briefs/000001.json']);
});

test('a planted file whose NAME contains a test id turns the check red', (t) => {
  const { dir, put } = fixture(t);
  const before = inventoryDir(dir);
  put(`sessions/${IDS[0]}/meta.json`, '{}');
  const r = auditState({ before, stateDir: dir, ids: IDS });
  assert.equal(r.pass, false);
  assert.ok(r.leaks.some((l) => l.kind === 'name' && l.id === IDS[0] && l.path === `sessions/${IDS[0]}/meta.json`));
});

test('a planted file whose CONTENT contains a test id turns the check red, even in a pre-existing file', (t) => {
  const { dir, put } = fixture(t);
  const before = inventoryDir(dir);
  put('sessions/owner-1/meta.json', `{"worker":"${IDS[2]}"}`);
  const r = auditState({ before, stateDir: dir, ids: IDS });
  assert.equal(r.pass, false);
  assert.ok(r.leaks.some((l) => l.kind === 'content' && l.id === IDS[2] && l.path === 'sessions/owner-1/meta.json'));
  assert.deepEqual(r.concurrentOwnerChanges.changed, ['sessions/owner-1/meta.json']); // still attributed, not hidden
});

test('a backslash form of a temp path in content is also caught', (t) => {
  const { dir, put } = fixture(t);
  const before = inventoryDir(dir);
  put('data.js', 'x C:\\tmp\\piomo-rpc14-XYZ\\proj-A y');
  const r = auditState({ before, stateDir: dir, ids: IDS });
  assert.equal(r.pass, false);
  assert.ok(r.leaks.some((l) => l.kind === 'content' && l.path === 'data.js'));
});
