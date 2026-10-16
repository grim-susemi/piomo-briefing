import { statSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrief } from '../src/schema.mjs';

const okExists = () => true;
const okHash = () => 'abc123';
const base = () => ({
  title: '오늘 작업',
  status: 'in_progress',
  headline: '목표 한 문장',
  changes: [{ text: '바뀜', truth: 'reported', applied: 'candidate' }],
  done: [{ text: '완료', truth: 'reported', applied: 'live' }],
  next: '다음 일',
  decisions: [{
    question: '어느 안으로 갈까?',
    options: { A: { text: '안 A', consequence: '결과 A' }, B: { text: '안 B', consequence: '결과 B' } },
    recommend: 'A', reason: 'A가 안전함', blocks: false,
  }],
  flow: [{ label: '설계', state: 'done' }],
});

test('정상 전체 입력 통과', () => {
  const r = validateBrief(base(), { fileExists: okExists, sha256: okHash });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('한글 100자 통과·101자 거절', () => {
  const okInput = base(); okInput.title = '가'.repeat(100).slice(0, 40);
  okInput.headline = '가'.repeat(100);
  let r = validateBrief(okInput, { fileExists: okExists, sha256: okHash });
  assert.equal(r.ok, true);
  const bad = base(); bad.headline = '가'.repeat(101);
  r = validateBrief(bad, { fileExists: okExists, sha256: okHash });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /headline.*100자 초과/);
});

test('배열 개수 초과 거절', () => {
  const b = base();
  b.changes = Array.from({ length: 9 }, (_, i) => ({ text: 'c' + i, truth: 'reported', applied: 'candidate' }));
  const r = validateBrief(b, { fileExists: okExists, sha256: okHash });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /changes.*8/);
});

test('evidence 경로 절대/상대 판정', () => {
  for (const p of ['./a.txt', 'a\\b']) {
    const b = base();
    b.changes = [{ text: 'x', truth: 'reported', applied: 'candidate', evidence: p }];
    const r = validateBrief(b, { fileExists: okExists, sha256: okHash });
    assert.equal(r.ok, false, p);
  }
  for (const p of ['C:\\x\\y.txt', 'C:/x/y.txt']) {
    const b = base();
    b.changes = [{ text: 'x', truth: 'reported', applied: 'candidate', evidence: p }];
    const r = validateBrief(b, { fileExists: okExists, sha256: okHash });
    assert.equal(r.ok, true, p);
  }
});

test('truth=evidence인데 경로 없음 거절', () => {
  const b = base();
  b.changes = [{ text: 'x', truth: 'evidence', applied: 'candidate' }];
  const r = validateBrief(b, { fileExists: okExists, sha256: okHash });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /evidence/);
});

test('없는 증거 파일은 경고+reported+evidence_missing', () => {
  const b = base();
  b.changes = [{ text: 'x', truth: 'evidence', applied: 'candidate', evidence: 'C:/x/missing.txt' }];
  const r = validateBrief(b, { fileExists: () => false, sha256: okHash });
  assert.equal(r.ok, true);
  assert.equal(r.normalized.changes[0].truth, 'reported');
  assert.ok(r.normalized.changes[0].evidence_missing);
  assert.ok(r.warnings.length >= 1);
});

test('있는 증거 파일은 sha256 기록', () => {
  const b = base();
  b.changes = [{ text: 'x', truth: 'evidence', applied: 'candidate', evidence: 'C:/x/y.txt' }];
  const r = validateBrief(b, { fileExists: () => true, sha256: () => 'deadbeef' });
  assert.equal(r.ok, true);
  assert.equal(r.normalized.changes[0].evidenceSha256, 'deadbeef');
});

test('선택지 1개 거절', () => {
  const b = base();
  b.decisions = [{ question: 'q'.repeat(5), options: { A: { text: 'a', consequence: 'c' } }, recommend: 'A', reason: 'r', blocks: false }];
  const r = validateBrief(b, { fileExists: okExists, sha256: okHash });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /options/);
});

test("recommend 'C'인데 C 없음 거절", () => {
  const b = base();
  b.decisions[0].recommend = 'C';
  const r = validateBrief(b, { fileExists: okExists, sha256: okHash });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /recommend/);
});

test('applied 없음·허용 밖 값 거절', () => {
  for (const applied of [undefined, 'bogus']) {
    const b = base();
    b.changes = [{ text: 'x', truth: 'reported', applied }];
    const r = validateBrief(b, { fileExists: okExists, sha256: okHash });
    assert.equal(r.ok, false, String(applied));
    const b2 = base();
    b2.done = [{ text: 'x', truth: 'reported', applied }];
    const r2 = validateBrief(b2, { fileExists: okExists, sha256: okHash });
    assert.equal(r2.ok, false, String(applied));
  }
});

test('decisions 없음·null 거절 (T2-S-DECISIONS-ARRAY)', () => {
  for (const v of [undefined, null]) {
    const b = base();
    if (v === undefined) delete b.decisions; else b.decisions = v;
    const r = validateBrief(b, { fileExists: okExists, sha256: okHash });
    assert.equal(r.ok, false, String(v));
    assert.match(r.errors.join('\n'), /decisions/);
    assert.equal(r.normalized, null);
  }
  const b = base(); b.decisions = [];
  assert.equal(validateBrief(b, { fileExists: okExists, sha256: okHash }).ok, true);
});

test('id가 있으면 조회·세션 맥락 없이 통과 금지 (T2-S-DECISION-ID-OWNER)', () => {
  const withId = () => {
    const b = base();
    b.decisions = [{ question: 'q12345', options: { A: { text: 'a', consequence: 'c' }, B: { text: 'b', consequence: 'd' } }, recommend: 'A', reason: 'r', blocks: false, id: 999999 }];
    return b;
  };
  let r = validateBrief(withId(), { fileExists: okExists, sha256: okHash });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /decisions\[0\]\.id/);
  r = validateBrief(withId(), { fileExists: okExists, sha256: okHash, decisionOwner: () => 'foreign' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /decisions\[0\]\.id/);
  const c = base(); c.close_decisions = [{ id: 999999, reason: 'superseded' }];
  r = validateBrief(c, { fileExists: okExists, sha256: okHash });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /close_decisions\[0\]\.id/);
});

test('10MB 초과 증거는 size·mtime 기록, 해시 생략 (T2-S-EVIDENCE-LARGE)', () => {
  const st = statSync(process.execPath);
  assert.ok(st.size > 10 * 1024 * 1024, 'probe용 대용량 파일 필요');
  let hashCalls = 0;
  const b = base();
  b.changes = [{ text: 'x', truth: 'evidence', applied: 'candidate', evidence: process.execPath }];
  const r = validateBrief(b, { fileExists: okExists, stat: statSync, sha256: () => { hashCalls++; return 'h'; } });
  assert.equal(r.ok, true);
  assert.equal(hashCalls, 0);
  assert.equal(r.normalized.changes[0].evidenceSize, st.size);
  assert.equal(r.normalized.changes[0].evidenceMtimeMs, st.mtimeMs);
});

test('fs 접근은 주입 함수로만 (주입 없으면 파일 확인 생략)', () => {
  const b = base();
  b.changes = [{ text: 'x', truth: 'evidence', applied: 'candidate', evidence: 'C:/x/y.txt' }];
  const r = validateBrief(b, {});
  assert.equal(r.ok, true);
});
