import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR } from '../../src/profiles/store.mjs';
import { cardsFile, disk, readJson } from './profiles-cards-fixture.mjs';

function recordAudit(kind, value) {
  const file = process.env.OMO_CARD_EDITOR_AUDIT_LOG;
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ kind, ...value }) + '\n');
}

export function cardAuditSnapshot(fx) {
  const all = disk(fx);
  const journalPath = path.join(fx.stable, 'agent', 'primary-agents', 'apply-journal.json');
  const metadataPath = path.join(fx.home, cardsFile);
  const backupPrefix = path.join(fx.home, ...BACKUP_DIR) + path.sep;
  const journalHash = all[journalPath] ?? null;
  return {
    settings: Object.fromEntries(Object.entries(all).filter(([file]) =>
      file !== journalPath && file !== metadataPath && !file.startsWith(backupPrefix))),
    metadataHash: all[metadataPath] ?? null,
    journal: { path: journalPath, sha256: journalHash, value: journalHash === null ? null : readJson(journalPath) },
  };
}

export function assertCardApplyAudit(before, after, post) {
  recordAudit('completed-apply', { before, after, post });
  assert.deepEqual(after.settings, before.settings, 'all protected settings/config/selection/model hashes stay exact');
  assert.equal(after.journal.path, before.journal.path, 'only the fixture-derived stable journal is separate');
  assert.equal(post.action, 'apply');
  assert.equal(post.changes.length, 1, 'standalone card save has exactly one operation');
  assert.equal(post.changes[0].kind, 'setProfileCard');
  const journal = after.journal.value;
  assert.ok(journal, 'a completed apply has a durable journal');
  assert.equal(journal.action, 'apply');
  assert.equal(journal.status, 'completed');
  assert.deepEqual(journal.changes, ['setProfileCard'], 'no selectProfile or additional operation');
  assert.deepEqual(journal.request, { changes: post.changes, rosterRevision: post.rosterRevision },
    'journal request matches the actual standalone POST');
  assert.ok(Array.isArray(journal.targets));
  const targets = journal.targets.length === 0 ? [] : [cardsFile];
  assert.deepEqual(journal.targets, targets, 'only card metadata may be a completed apply target');
  assert.deepEqual((journal.plan ?? []).map(entry => ({ id: entry.id, kind: entry.kind })),
    targets.map(id => ({ id, kind: 'json' })), 'the durable plan contains no settings write');
  const backups = targets.length === 1 && before.metadataHash !== null ? [cardsFile] : [];
  assert.deepEqual(journal.steps.filter(step => step.step === 'write').map(step => step.target), targets);
  assert.deepEqual(journal.steps.filter(step => step.step === 'backup').map(step => step.target), backups);
  const steps = targets.length === 0 ? ['validate', 'no-op'] :
    ['validate', 'compare-and-swap', ...(backups.length ? ['backup'] : []), 'write', 're-parse'];
  assert.deepEqual(journal.steps.map(step => step.step), steps, 'no extra journal operation or step');
  assert.equal(journal.steps.every(step => step.status === 'ok'), true);
}

export function assertCardNoWriteAudit(before, after) {
  recordAudit('no-write', { before, after });
  assert.deepEqual(after.settings, before.settings, 'refusal/cancel does not change protected settings');
  assert.deepEqual(after.journal, before.journal, 'without a completed apply, journal bytes and operation stay unchanged');
}
