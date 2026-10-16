// Regression for the briefing/state leak + attribution audit of the plan-view integration run (plan todo 14).
// Runs only against a FIXTURE state directory built in the OS temp folder, never the live profile.
//   node --test test/integration/state-audit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventoryDir, auditState, auditAnswers } from './state-audit.mjs';

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

// ---- auditAnswers (board-answer scenario): exactly N answers and N proven receipts for the owner, none for anyone else
const OWNER = 'sess-owner';
const OTHER = 'sess-other';

function answered(t, ids = [1, 2, 3]) {
  const { dir, put } = fixture(t);
  const pad = (n) => String(n).padStart(6, '0');
  for (const id of ids) {
    put(`decisions/${pad(id)}.json`, JSON.stringify({ id, sessionId: OWNER }));
    put(`answers/${pad(id)}.json`, JSON.stringify({ id, option: 'A', fromSessionId: 'board' }));
    put(`receipts/${pad(id)}.json`, JSON.stringify({ id, sessionId: OWNER, proven: true }));
  }
  return { dir, put, pad };
}
const audit = (dir, expected = 3) => auditAnswers({ stateDir: dir, ownerId: OWNER, otherIds: [OTHER], expected });

test('auditAnswers passes for exactly N answers with N proven receipts of the owner', (t) => {
  const { dir } = answered(t);
  const r = audit(dir);
  assert.deepEqual(r.problems, []);
  assert.equal(r.pass, true);
  assert.deepEqual([r.answers, r.receipts, r.provenForOwner, r.forOthers], [3, 3, 3, 0]);
});

test('auditAnswers fails for a missing receipt, an unproven receipt, and a wrong count', (t) => {
  const { dir, put, pad } = answered(t);
  fs.rmSync(path.join(dir, `receipts/${pad(3)}.json`));
  put(`receipts/${pad(2)}.json`, JSON.stringify({ id: 2, sessionId: OWNER, proven: false }));
  const r = audit(dir);
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.startsWith('000003.json: no receipt')));
  assert.ok(r.problems.some((p) => p.startsWith('000002.json: receipt is not proven')));
  assert.ok(r.problems.some((p) => p.startsWith('expected 3 receipts, found 2')));
  assert.ok(audit(dir, 4).problems.some((p) => p.startsWith('expected 4 answers, found 3')));
});

test('auditAnswers fails when an answered decision belongs to a conversation that is not the owner', (t) => {
  const { dir, put, pad } = answered(t);
  put(`decisions/${pad(1)}.json`, JSON.stringify({ id: 1, sessionId: 'sess-third' }));
  const r = audit(dir);
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.startsWith('000001.json: decision belongs to sess-third')));
});

test('auditAnswers fails when a decision or a receipt of another conversation is involved', (t) => {
  const { dir, put, pad } = answered(t);
  put(`decisions/${pad(2)}.json`, JSON.stringify({ id: 2, sessionId: OTHER }));
  put(`receipts/${pad(3)}.json`, JSON.stringify({ id: 3, sessionId: OTHER, proven: true }));
  const r = audit(dir);
  assert.equal(r.pass, false);
  assert.equal(r.forOthers, 2);
  assert.ok(r.problems.some((p) => p.startsWith('000002.json: answered decision belongs to another conversation')));
  assert.ok(r.problems.some((p) => p.startsWith('000003.json: receipt names another conversation')));
});

test('auditAnswers fails for a stray receipt and for an answer whose decision is missing', (t) => {
  const { dir, put, pad } = answered(t, [1, 2]);
  put(`receipts/${pad(9)}.json`, JSON.stringify({ id: 9, sessionId: OWNER, proven: true }));
  fs.rmSync(path.join(dir, `decisions/${pad(1)}.json`));
  const r = audit(dir, 2);
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.startsWith('000009.json: receipt without an answer')));
  assert.ok(r.problems.some((p) => p.startsWith('000001.json: answer without a decision')));
});
