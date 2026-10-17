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

// ---------------------------------------------------------------- reports (C-REPORT 1)
const owned = { decisionOwner: (id) => (id === 7 ? 'S' : id === 8 ? 'OTHER' : null), sessionId: 'S' };
const report = (over = {}) => ({ id: 'r-1', title: '시안 비교', summary: '두 안', images: [{ path: 'C:/shots/a.png', alt: '안 A 화면' }], ...over });
const withReports = (reports, extra = {}) => validateBrief({ ...base(), reports }, { fileExists: okExists, sha256: okHash, ...owned, ...extra });
const errs = (r) => r.errors.join('\n');

test('reports: 생략은 필드 없음, []는 그대로, 정상 보고서는 계약 키만 남음', () => {
  assert.equal('reports' in validateBrief(base(), {}).normalized, false);
  assert.deepEqual(withReports([]).normalized.reports, []);
  const r = withReports([report({ decisionIndex: 0, extra: '<b>지어낸 라벨</b>', images: [{ path: 'C:/s/a.png', alt: 'a', option: 'B', label: '추가 라벨' }] })]);
  assert.equal(r.ok, true, errs(r));
  assert.deepEqual(r.normalized.reports, [{ id: 'r-1', title: '시안 비교', summary: '두 안', decisionIndex: 0, images: [{ path: 'C:/s/a.png', alt: 'a', option: 'B' }] }]);
});

test('reports: 개수·id·길이 한도 위반은 필드별 한국어 오류', () => {
  const many = withReports([report({ id: 'a' }), report({ id: 'b' }), report({ id: 'c' }), report({ id: 'd' })]);
  assert.match(errs(many), /reports: 3개 초과\(4\)/);
  const r = withReports([
    report({ id: 'Bad Id', title: '가'.repeat(81), summary: '나'.repeat(1001) }),
    report({ id: 'dup' }), report({ id: 'dup', images: Array.from({ length: 7 }, () => ({ path: 'C:/a.png', alt: 'x' })) }),
  ]);
  const e = errs(r);
  assert.equal(r.ok, false);
  assert.match(e, /reports\[0\]\.id: 형식 필요/);
  assert.match(e, /reports\[0\]\.title: 80자 초과\(81\)/);
  assert.match(e, /reports\[0\]\.summary: 1000자 초과\(1001\)/);
  assert.match(e, /reports\[2\]\.id: 이 호출 안에서 중복\(dup\)/);
  assert.match(e, /reports\[2\]\.images: 6개 초과\(7\)/);
  assert.equal(withReports([report({ id: 'a'.repeat(64), title: '가'.repeat(80), summary: '' })]).ok, true, '64-char id, 80 cp title, empty summary');
  assert.match(errs(withReports([report({ id: 'a'.repeat(65) })])), /reports\[0\]\.id: 형식/);
  assert.match(errs(withReports([report({ title: '' })])), /reports\[0\]\.title: 1자 이상/);
  assert.match(errs(withReports('x')), /reports: 배열 필요/);
  assert.match(errs(withReports([null])), /reports\[0\]: 보고서 객체 필요/);
});

test('reports: 그림 경로는 절대경로·UNC·장치·스트림·SVG·GIF·길이를 필드별로 거절', () => {
  const r = withReports([report({ images: [
    { path: 'shots/a.png', alt: 'x' },
    { path: '\\\\srv\\share\\a.png', alt: 'x' },
    { path: '\\\\?\\C:\\a.png', alt: 'x' },
    { path: 'C:\\a.png:zone', alt: 'x' },
    { path: 'C:/a.svg', alt: 'x' },
    { path: 'C:/a.GIF', alt: '' },
  ] })]);
  const e = errs(r);
  assert.match(e, /reports\[0\]\.images\[0\]\.path: 절대경로 필요/);
  assert.match(e, /reports\[0\]\.images\[1\]\.path: UNC 경로 거절/);
  assert.match(e, /reports\[0\]\.images\[2\]\.path: 장치 경로 거절/);
  assert.match(e, /reports\[0\]\.images\[3\]\.path: 대체 데이터 스트림 거절/);
  assert.match(e, /reports\[0\]\.images\[4\]\.path: SVG·GIF는 받지 않음/);
  assert.match(e, /reports\[0\]\.images\[5\]\.path: SVG·GIF/);
  assert.match(e, /reports\[0\]\.images\[5\]\.alt: 1자 이상/);
  assert.match(errs(withReports([report({ images: [{ path: `C:/${'a'.repeat(1100)}.png`, alt: 'x' }] })])), /images\[0\]\.path: 1024자 초과/);
  assert.match(errs(withReports([report({ images: [{ path: 'C:/a.png', alt: '가'.repeat(201) }] })])), /images\[0\]\.alt: 200자 초과/);
});

test('reports: decision/decisionIndex 연결과 option은 결정에 있는 선택지만', () => {
  const both = withReports([report({ decision: 7, decisionIndex: 0 })]);
  assert.match(errs(both), /reports\[0\]: decision과 decisionIndex 중 하나만/);
  assert.match(errs(withReports([report({ decisionIndex: 1 })])), /reports\[0\]\.decisionIndex: decisions\[1\] 없음/);
  assert.match(errs(withReports([report({ decisionIndex: 4 })])), /decisionIndex: 0\.\.3 정수 필요/);
  assert.match(errs(withReports([report({ decisionIndex: 0, images: [{ path: 'C:/a.png', alt: 'x', option: 'C' }] })])), /images\[0\]\.option: 연결된 결정에 없는 선택지\(C\)/);
  assert.match(errs(withReports([report({ images: [{ path: 'C:/a.png', alt: 'x', option: 'A' }] })])), /images\[0\]\.option: 연결된 결정 없음/);
  assert.match(errs(withReports([report({ decisionIndex: 0, images: [{ path: 'C:/a.png', alt: 'x', option: 'D' }] })])), /option: 허용 값 A\|B\|C/);
  assert.match(errs(withReports([report({ decision: 8 })])), /reports\[0\]\.decision: 다른 세션 소유의 결정\(8\)/);
  assert.match(errs(withReports([report({ decision: 99 })])), /reports\[0\]\.decision: 존재하지 않는 결정\(99\)/);
  assert.match(errs(withReports([report({ decision: 7 })], { decisionOpen: () => false })), /reports\[0\]\.decision: 열린 결정 아님\(7\)/);
  const opts = { decisionOpen: () => true, decisionOptions: () => ['A', 'B', 'C'] };
  assert.equal(withReports([report({ decision: 7, images: [{ path: 'C:/a.png', alt: 'x', option: 'C' }] })], opts).ok, true);
  assert.match(errs(withReports([report({ decision: 7, images: [{ path: 'C:/a.png', alt: 'x', option: 'C' }] })], { decisionOptions: () => ['A', 'B'] })), /연결된 결정에 없는 선택지\(C\)/);
});

test('reports: decisionIndex가 기존 결정(id)을 가리키면 저장된 결정의 선택지로 검사(이번 호출에 덧붙인 C는 무효)', () => {
  const b = base();
  b.decisions[0] = { ...b.decisions[0], id: 7, options: { ...b.decisions[0].options, C: { text: '지어낸 안', consequence: '없음' } } };
  const img = (option) => [{ path: 'C:/a.png', alt: 'x', option }];
  const run = (option, extra) => validateBrief({ ...b, reports: [report({ decisionIndex: 0, images: img(option) })] },
    { fileExists: okExists, sha256: okHash, ...owned, ...extra });
  const stored = { decisionOptions: (id) => (id === 7 ? ['A', 'B'] : null) };
  assert.match(run('C', stored).errors.join('\n'), /reports\[0\]\.images\[0\]\.option: 연결된 결정에 없는 선택지\(C\)/);
  assert.equal(run('B', stored).ok, true);
  assert.match(run('A', { decisionOptions: () => { throw new Error('io'); } }).errors.join('\n'), /reports\[0\]\.decisionIndex: 결정의 선택지를 읽지 못함\(7\)/);
});
