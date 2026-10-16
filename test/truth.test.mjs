import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recheckEvidence, cardStatus, chips, tabOf } from '../src/truth.mjs';

const HOUR = 3600 * 1000;
const now = Date.now();
const S = (o) => ({ status: 'in_progress', decisions: [], items: [], lastActivityAt: now, meta: {}, ...o });

describe('recheckEvidence', () => {
  it('missing file -> gone', () => {
    const r = recheckEvidence({ text: 'a', truth: 'evidence', evidence: 'C:/x/y.txt' }, { stat: null });
    assert.equal(r.evidenceState, 'gone');
    assert.equal(r.flag, 'evidence_gone');
  });
  it('same hash -> ok', () => {
    const r = recheckEvidence({ text: 'a', truth: 'evidence', evidenceHash: 'abc' }, { stat: { size: 10, mtimeMs: 1 }, sha256: () => 'abc' });
    assert.equal(r.evidenceState, 'ok');
  });
  it('different hash -> changed', () => {
    const r = recheckEvidence({ text: 'a', truth: 'evidence', evidenceHash: 'abc' }, { stat: { size: 10, mtimeMs: 1 }, sha256: () => 'zzz' });
    assert.equal(r.evidenceState, 'changed');
    assert.equal(r.flag, 'evidence_changed');
  });
  it('large file compares size+mtime', () => {
    const big = { size: 11 * 1024 * 1024, mtimeMs: 5 };
    const ok = recheckEvidence({ text: 'a', truth: 'evidence', evidenceSize: big.size, evidenceMtimeMs: 5 }, { stat: big, sha256: () => { throw new Error('must not hash large'); } });
    assert.equal(ok.evidenceState, 'ok');
    const ch = recheckEvidence({ text: 'a', truth: 'evidence', evidenceSize: big.size, evidenceMtimeMs: 5 }, { stat: { ...big, mtimeMs: 6 }, sha256: () => 'x' });
    assert.equal(ch.evidenceState, 'changed');
  });
  it('non-evidence passes through', () => {
    for (const t of ['reported', 'unverified']) {
      const r = recheckEvidence({ text: 'a', truth: t }, { stat: null });
      assert.equal(r.truth, t);
      assert.equal(r.evidenceState, 'ok');
    }
  });
  it('evidence gone after temp file deleted', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createHash } = await import('node:crypto');
    const { readFileSync, statSync } = await import('node:fs');
    const d = mkdtempSync(join(tmpdir(), 'truth-'));
    try {
      const p = join(d, 'e.txt');
      writeFileSync(p, 'hello');
      const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
      const st = statSync(p);
      const ok = recheckEvidence({ text: 'a', truth: 'evidence', evidence: p, evidenceHash: hash }, { stat: { size: st.size, mtimeMs: st.mtimeMs }, sha256: () => createHash('sha256').update(readFileSync(p)).digest('hex') });
      assert.equal(ok.evidenceState, 'ok');
      rmSync(p);
      let stat = null;
      try { statSync(p); } catch { stat = null; }
      const gone = recheckEvidence({ text: 'a', truth: 'evidence', evidence: p, evidenceHash: hash }, { stat });
      assert.equal(gone.evidenceState, 'gone');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('real file deleted after stat -> gone and card rechecks', async () => {
    const { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createHash } = await import('node:crypto');
    const d = mkdtempSync(join(tmpdir(), 'truth-vanish-'));
    try {
      const p = join(d, 'vanishes.txt');
      writeFileSync(p, 'recorded evidence file for deletion-after-stat probe\n');
      const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
      const st = statSync(p);
      const snap = { size: st.size, mtimeMs: st.mtimeMs };
      const realHash = () => createHash('sha256').update(readFileSync(p)).digest('hex');
      rmSync(p);
      const item = { text: 'a', truth: 'evidence', applied: 'none', evidence: p, evidenceHash: hash };
      const checked = recheckEvidence(item, { stat: snap, sha256: realHash });
      assert.equal(checked.evidenceState, 'gone');
      assert.equal(checked.flag, 'evidence_gone');
      assert.equal(cardStatus(S({ status: 'done', items: [{ ...item, ...checked }] }), now), 'recheck');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('hash reader ENOENT -> gone and card rechecks', () => {
    const item = { text: 'a', truth: 'evidence', applied: 'none', evidence: 'C:/x/evidence.txt', evidenceHash: 'abc' };
    const enoent = () => { throw Object.assign(new Error('gone after stat'), { code: 'ENOENT' }); };
    const checked = recheckEvidence(item, { stat: { size: 3, mtimeMs: 1 }, sha256: enoent });
    assert.equal(checked.evidenceState, 'gone');
    assert.equal(checked.flag, 'evidence_gone');
    assert.equal(cardStatus(S({ status: 'done', items: [{ ...item, ...checked }] }), now), 'recheck');
  });
  it('hash reader non-ENOENT error -> not ok', () => {
    const item = { text: 'a', truth: 'evidence', evidence: 'C:/x/evidence.txt', evidenceHash: 'abc' };
    const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const r = recheckEvidence(item, { stat: { size: 3, mtimeMs: 1 }, sha256: denied });
    assert.notEqual(r.evidenceState, 'ok');
    assert.ok(r.flag);
  });
  it('real file changed after stat -> downgraded', async () => {
    const { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createHash } = await import('node:crypto');
    const d = mkdtempSync(join(tmpdir(), 'truth-change-'));
    try {
      const p = join(d, 'c.txt');
      writeFileSync(p, 'before');
      const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
      const st = statSync(p);
      writeFileSync(p, 'after - different contents');
      const r = recheckEvidence({ text: 'a', truth: 'evidence', evidence: p, evidenceHash: hash },
        { stat: { size: st.size, mtimeMs: st.mtimeMs }, sha256: () => createHash('sha256').update(readFileSync(p)).digest('hex') });
      assert.equal(r.evidenceState, 'changed');
      assert.equal(r.flag, 'evidence_changed');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('cardStatus precedence', () => {
  const openBlocks = [{ id: 1, blocks: true, answered: false, closed: false }];
  const goneItem = [{ text: 'a', truth: 'evidence', evidenceState: 'gone' }];
  const changedItem = [{ text: 'a', truth: 'evidence', evidenceState: 'changed' }];
  const liveItem = [{ text: 'a', truth: 'reported' }];
  it('blocked beats open blocks decision', () => {
    assert.equal(cardStatus(S({ status: 'blocked', decisions: openBlocks }), now), 'blocked');
  });
  it('open blocks beats evidence change', () => {
    assert.equal(cardStatus(S({ status: 'in_progress', decisions: openBlocks, items: changedItem }), now), 'needs_decision');
  });
  it('evidence gone beats done', () => {
    assert.equal(cardStatus(S({ status: 'done', items: goneItem, done: [{ text: 'a', truth: 'evidence' }] }), now), 'recheck');
  });
  it('evidence changed beats done', () => {
    assert.equal(cardStatus(S({ status: 'done', items: changedItem, done: [{ text: 'a', truth: 'evidence' }] }), now), 'recheck');
  });
  it('done beats in_progress', () => {
    assert.equal(cardStatus(S({ status: 'done', done: [{ text: 'a', truth: 'reported' }] }), now), 'done');
    assert.equal(cardStatus(S({ status: 'in_progress', items: liveItem }), now), 'in_progress');
  });
  it('done with no grounds -> done_no_evidence', () => {
    assert.equal(cardStatus(S({ status: 'done', done: [] }), now), 'done_no_evidence');
    assert.equal(cardStatus(S({ status: 'done', done: [{ text: 'a', truth: 'unverified' }] }), now), 'done_no_evidence');
  });
  it('answered/closed decisions do not force needs_decision', () => {
    assert.equal(cardStatus(S({ status: 'in_progress', decisions: [{ id: 1, blocks: true, answered: true }] }), now), 'in_progress');
    assert.equal(cardStatus(S({ status: 'in_progress', decisions: [{ id: 1, blocks: true, closed: true }] }), now), 'in_progress');
    assert.equal(cardStatus(S({ status: 'in_progress', decisions: [{ id: 1, blocks: false }] }), now), 'in_progress');
  });
});

describe('chips and tabOf', () => {
  it('7h stale, 5h fresh', () => {
    assert.ok(chips(S({ lastActivityAt: now - 7 * HOUR }), now).includes('오래됨'));
    assert.ok(!chips(S({ lastActivityAt: now - 5 * HOUR }), now).includes('오래됨'));
  });
  it('noReport -> 보고 없음; read/mirror flags', () => {
    assert.ok(chips(S({ meta: { noReport: true } }), now).includes('보고 없음'));
    assert.ok(chips(S({ meta: { readError: true } }), now).includes('기록 읽기 실패'));
    assert.ok(chips(S({ meta: { mirrorUnavailable: true } }), now).includes('질문 미러 사용 불가'));
  });
  it('tabOf rules', () => {
    assert.equal(tabOf(S({ status: 'blocked' }), now), '나를 기다림');
    assert.equal(tabOf(S({ decisions: [{ id: 1, answered: false, closed: false }] }), now), '나를 기다림');
    assert.equal(tabOf(S({ mirrorOpen: true }), now), '나를 기다림');
    assert.equal(tabOf(S({ status: 'done' }), now), '끝남');
    assert.equal(tabOf(S({ status: 'in_progress' }), now), '진행 중');
  });
  it('no forbidden strings anywhere', () => {
    const all = JSON.stringify([
      cardStatus(S({ status: 'done', done: [{ text: 'a', truth: 'reported' }] }), now),
      chips(S({ lastActivityAt: now - 7 * HOUR, meta: { noReport: true, readError: true, mirrorUnavailable: true } }), now),
      tabOf(S({}), now),
      recheckEvidence({ text: 'a', truth: 'evidence' }, { stat: null }),
    ]);
    assert.ok(!all.includes('검증됨'));
    assert.ok(!all.includes('%'));
  });
});
