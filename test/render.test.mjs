import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { openStore } from '../src/store.mjs';
import { buildViewModel, renderPage } from '../src/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'helpers', 'render-child.mjs');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 14, 3, 0, 0);

function tempRoot(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'omo-render-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const p6 = (n) => String(n).padStart(6, '0');
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid; // exited child: its pid is gone
const opt = (text, consequence) => ({ text, consequence });

function brief(store, sid, seq, at, b) {
  store.writeNew(`sessions/${sid}/briefs/${p6(seq)}.json`, {
    at,
    brief: { status: 'in_progress', changes: [], done: [], next: '', decisions: [], ...b },
  });
}
function meta(store, sid, m) {
  store.replace(`sessions/${sid}/meta.json`, { sessionId: sid, ...m });
}
function decision(store, d) {
  store.writeNew(`decisions/${p6(d.id)}.json`, {
    options: { A: opt('가', '결과 가'), B: opt('나', '결과 나') }, recommend: 'A', reason: '이유', blocks: false, source: 'brief', ...d,
  });
}

// 3 projects, 6 shown conversations + 1 conversation last active 31 days ago.
function fixtureStore(root) {
  const store = openStore(root);
  const A = 'C:/w/alpha', B = 'C:\\w\\beta', C = 'C:/w/gamma/';
  meta(store, 's-a1', { cwd: A, title: '알파 하나', paneId: 'w1-p1', lastActivityAt: NOW - 30 * MIN, lastOwnerInputAt: NOW - 45 * MIN, auto: { work: { name: '결정 기록기', phase: '실행' }, todo: { current: '4. 전달', next: '5. 실측', done: 3, total: 9 }, workers: { running: 1, completed: 4, error: 0, other: 0 } } });
  brief(store, 's-a1', 1, NOW - 60 * MIN, { title: '알파 하나', status: 'needs_decision', headline: '옛 줄', changes: [{ text: 'x1', truth: 'reported', applied: 'none' }] });
  brief(store, 's-a1', 2, NOW - 30 * MIN, { title: '알파 하나', status: 'needs_decision', headline: '결정만 남음', changes: [{ text: 'x2', truth: 'reported', applied: 'none' }] });
  decision(store, { id: 12, sessionId: 's-a1', question: '전달 방식?', blocks: true, createdAt: NOW - 40 * MIN });
  decision(store, { id: 13, sessionId: 's-a1', question: '보관?', createdAt: NOW - 35 * MIN });

  meta(store, 's-a2', { cwd: A, title: '알파 둘', lastActivityAt: NOW - 20 * MIN, lastOwnerInputAt: NOW - 20 * MIN });
  brief(store, 's-a2', 1, NOW - 50 * MIN, { title: '알파 둘', headline: '설치 중', changes: [{ text: 'y1', truth: 'reported', applied: 'candidate' }] });

  meta(store, 's-b1', { cwd: B, title: '베타 하나', lastActivityAt: NOW - 60 * MIN });
  brief(store, 's-b1', 1, NOW - 60 * MIN, { title: '베타 하나', status: 'blocked', headline: '막힘' });

  meta(store, 's-b2', { cwd: B, title: '베타 둘', lastActivityAt: NOW - 10 * MIN, running: true, pid: process.pid });
  brief(store, 's-b2', 1, NOW - 10 * MIN, { title: '베타 둘', headline: '진행' });
  decision(store, { id: 9, sessionId: 's-b2', question: '답만 있음', createdAt: NOW - 200 * MIN });
  decision(store, { id: 10, sessionId: 's-b2', question: '답+영수증', createdAt: NOW - 190 * MIN });
  decision(store, { id: 11, sessionId: 's-b2', question: '열린 결정', createdAt: NOW - 90 * MIN });
  decision(store, { id: 14, sessionId: 's-b2', question: '닫힌 결정', createdAt: NOW - 80 * MIN });
  store.writeNew('answers/000009.json', { id: 9, option: 'B', at: NOW - 100 * MIN, fromSessionId: 's-a1' });
  store.writeNew('answers/000010.json', { id: 10, option: 'A', at: NOW - 100 * MIN, fromSessionId: 's-a1' });
  store.writeNew('receipts/000010.json', { id: 10, sessionId: 's-b2', deliveredAt: NOW - 99 * MIN, kind: 'started', mode: 'immediate', proven: true });
  store.writeNew('decision-closures/000014.json', { id: 14, reason: 'withdrawn', at: NOW - 70 * MIN });

  meta(store, 's-c1', { cwd: C, title: '감마 하나', lastActivityAt: NOW - 100 * MIN });
  brief(store, 's-c1', 1, NOW - 100 * MIN, { title: '감마 하나', status: 'done', headline: '끝', done: [{ text: 'd', truth: 'reported', applied: 'none' }] });

  meta(store, 's-c2', { cwd: C, title: '감마 둘', lastActivityAt: NOW - 5 * MIN, running: true, pid: deadPid() });
  brief(store, 's-c2', 1, NOW - 5 * MIN, { title: '감마 둘', headline: '최근' });

  meta(store, 's-old', { cwd: C, title: '오래된 대화', lastActivityAt: NOW - 31 * DAY });
  brief(store, 's-old', 1, NOW - 31 * DAY, { title: '오래된 대화', headline: '옛날' });
  return store;
}

const byId = (model) => Object.fromEntries(model.sessions.map((s) => [s.id, s]));

function runDataJs(text) {
  const got = [];
  vm.runInNewContext(text, { window: { __briefData: (d) => got.push(d) } }, { timeout: 1000 });
  assert.equal(got.length, 1, 'data.js must call __briefData exactly once');
  return got[0];
}

describe('buildViewModel', () => {
  test('tabs, ordering, project groups; 31-day-old conversation excluded', (t) => {
    const store = fixtureStore(tempRoot(t));
    const model = buildViewModel(store.readSnapshot(), NOW);
    assert.equal(model.generatedAt, NOW);
    assert.deepEqual(model.sessions.map((s) => [s.id, s.tab, s.project]), [
      ['s-b2', '나를 기다림', 'beta'],
      ['s-b1', '나를 기다림', 'beta'],
      ['s-a1', '나를 기다림', 'alpha'],
      ['s-c2', '진행 중', 'gamma'],
      ['s-a2', '진행 중', 'alpha'],
      ['s-c1', '끝남', 'gamma'],
    ]);
    const s = byId(model);
    assert.equal(s['s-old'], undefined);
    assert.equal(s['s-a1'].statusKey, 'needs_decision');
    assert.equal(s['s-b1'].statusKey, 'blocked');
    assert.equal(s['s-c1'].statusKey, 'done');
    assert.equal(s['s-a1'].workName, '결정 기록기');
    assert.deepEqual(s['s-a1'].auto, { stage: '실행', todoCurrent: '4. 전달', todoNext: '5. 실측', todoDone: 3, todoTotal: 9, workers: { running: 1, done: 4, error: 0 } });
    assert.deepEqual(model.summary, { openDecisions: 3, blocked: 1, stale: 0 });
  });

  test('changes after lastOwnerInputAt are "새로 바뀜", otherwise latest brief changes', (t) => {
    const s = byId(buildViewModel(fixtureStore(tempRoot(t)).readSnapshot(), NOW));
    assert.equal(s['s-a1'].changesNew, true);
    assert.deepEqual(s['s-a1'].changes.map((c) => c.text), ['x2']);
    assert.equal(s['s-a1'].headline, '결정만 남음');
    assert.equal(s['s-a2'].changesNew, false);
    assert.deepEqual(s['s-a2'].changes.map((c) => c.text), ['y1']);
  });

  test('decisions: open/closed/answered and delivery state', (t) => {
    const s = byId(buildViewModel(fixtureStore(tempRoot(t)).readSnapshot(), NOW));
    const d = Object.fromEntries(s['s-b2'].decisions.map((x) => [x.id, x]));
    assert.deepEqual(Object.keys(d).map(Number).sort((a, b) => a - b), [9, 10, 11, 14]);
    assert.equal(d[11].answered, false);
    assert.equal(d[11].closed, false);
    assert.equal(d[14].closed, true);
    assert.equal(d[10].answered, true);
    assert.match(d[10].delivery, /^전달됨 ⏱\d\d:\d\d$/);
    assert.equal(d[10].receipt.deliveredAt, NOW - 99 * MIN);
    assert.equal(d[9].answered, true);
    assert.equal(d[9].receipt, null);
    assert.equal(d[9].delivery, '대기: 작업이 끝나면 전달'); // s-b2 is running
    // the same answer for an idle conversation waits for it to reopen
    const store = openStore(tempRoot(t));
    meta(store, 'idle', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN });
    decision(store, { id: 1, sessionId: 'idle', question: 'q', createdAt: NOW - 2 * MIN });
    decision(store, { id: 2, sessionId: 'idle', question: 'q2', createdAt: NOW - 2 * MIN });
    store.writeNew('answers/000001.json', { id: 1, option: 'A', at: NOW - MIN });
    store.writeNew('answers/000002.json', { id: 2, option: 'A', at: NOW - MIN });
    store.writeNew('receipts/000002.json', { id: 2, sessionId: 'idle', deliveredAt: NOW - MIN, kind: 'queued', mode: 'after-turn', proven: false });
    const i = Object.fromEntries(buildViewModel(store.readSnapshot(), NOW).sessions[0].decisions.map((x) => [x.id, x]));
    assert.equal(i[1].delivery, '대기: 그 대화가 다시 열리면 전달');
    assert.equal(i[2].delivery, '전달 중');
  });

  test('chips: 작업 중 / 응답 없음 / 오래됨 / 보고 없음 and open question mirror', (t) => {
    const store = fixtureStore(tempRoot(t));
    meta(store, 'quiet', { cwd: 'C:/w/alpha', title: '조용함', lastActivityAt: NOW - 7 * 60 * MIN, noReport: true });
    brief(store, 'quiet', 1, NOW - 7 * 60 * MIN, { title: '조용함', headline: 'h' });
    store.replace('mirror/s-c2.json', { open: true, question: '몇 줄?', at: NOW - MIN, paneId: 'w9' });
    const s = byId(buildViewModel(store.readSnapshot(), NOW));
    assert.ok(s['s-b2'].chips.includes('작업 중'));
    assert.ok(s['s-c2'].chips.includes('응답 없음'));
    assert.ok(s.quiet.chips.includes('오래됨'));
    assert.ok(s.quiet.chips.includes('보고 없음'));
    assert.ok(!s['s-a2'].chips.includes('오래됨'));
    assert.deepEqual(s['s-c2'].openQuestion, { text: '몇 줄?', at: NOW - MIN, paneId: 'w9' });
    assert.equal(s['s-c2'].tab, '나를 기다림');
  });

  test('evidence is re-hashed at render time: same / changed / gone', (t) => {
    const root = tempRoot(t);
    const store = openStore(join(root, 'state'));
    const ev = (n) => join(root, n).replace(/\\/g, '/');
    fs.writeFileSync(ev('same.txt'), 'one');
    fs.writeFileSync(ev('chg.txt'), 'one');
    const sha = (s) => import('node:crypto').then((c) => c.createHash('sha256').update(s).digest('hex'));
    return sha('one').then((h) => {
      meta(store, 'e', { cwd: 'C:/w/e', lastActivityAt: NOW });
      brief(store, 'e', 1, NOW, {
        status: 'done', title: 'e', headline: 'h',
        done: [
          { text: 'same', truth: 'evidence', applied: 'none', evidence: ev('same.txt'), evidenceSha256: h },
          { text: 'chg', truth: 'evidence', applied: 'none', evidence: ev('chg.txt'), evidenceSha256: h },
          { text: 'gone', truth: 'evidence', applied: 'none', evidence: ev('gone.txt'), evidenceSha256: h },
        ],
      });
      fs.writeFileSync(ev('chg.txt'), 'two');
      const s = buildViewModel(store.readSnapshot(), NOW).sessions[0];
      assert.deepEqual(s.done.map((d) => d.evidenceState), ['ok', 'changed', 'gone']);
      assert.equal(s.statusKey, 'recheck');
    });
  });
});

describe('view-model contract (test/fixtures/view-model.json + src/page/view.js)', () => {
  const CONTRACT = JSON.parse(fs.readFileSync(join(HERE, 'fixtures', 'view-model.json'), 'utf8'));
  const OPTIONAL = new Set(['auto', 'autoSummary', 'openQuestion', 'answerTrimmed']);
  const NULLABLE = new Set(['tabNumber']); // null when the session's herdr tab is unknown
  const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

  test('every contract session key is present with the same JSON type; only contract keys are emitted', (t) => {
    const model = buildViewModel(fixtureStore(tempRoot(t)).readSnapshot(), NOW);
    assert.equal(model.schema, CONTRACT.schema);
    const contractKeys = new Set(CONTRACT.sessions.flatMap((s) => Object.keys(s)));
    const sample = Object.fromEntries([...contractKeys].map((k) => [k, kind(CONTRACT.sessions.find((s) => k in s)[k])]));
    for (const s of model.sessions) {
      for (const k of contractKeys) {
        if (OPTIONAL.has(k) && !(k in s)) continue;
        assert.ok(k in s, `${s.id} lacks ${k}`);
        if (sample[k] !== 'null' && !(NULLABLE.has(k) && s[k] === null)) assert.equal(kind(s[k]), sample[k], `${s.id}.${k} type`);
      }
      for (const k of Object.keys(s)) {
        assert.ok(contractKeys.has(k), `${s.id} emits non-contract key ${k}`);
      }
    }
    const decKeys = new Set(CONTRACT.sessions.flatMap((s) => s.decisions.flatMap((d) => Object.keys(d))));
    for (const d of model.sessions.flatMap((s) => s.decisions)) {
      for (const k of ['id', 'sessionId', 'question', 'options', 'recommend', 'reason', 'blocks', 'createdAt', 'answered', 'closed']) {
        assert.ok(decKeys.has(k) && k in d, `decision ${d.id} lacks ${k}`);
      }
    }
  });

  test('view.js renders every card of the built model (and the page never claims 전달됨 for an unproven receipt)', (t) => {
    const store = fixtureStore(tempRoot(t));
    meta(store, 'idle', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN });
    decision(store, { id: 2, sessionId: 'idle', question: 'q2', createdAt: NOW - 2 * MIN });
    store.writeNew('answers/000002.json', { id: 2, option: 'A', at: NOW - MIN });
    store.writeNew('receipts/000002.json', { id: 2, sessionId: 'idle', deliveredAt: NOW - MIN, kind: 'queued', mode: 'after-turn', proven: false });
    const model = buildViewModel(store.readSnapshot(), NOW);
    const ctx = {};
    vm.runInNewContext(fs.readFileSync(join(HERE, '..', 'src', 'page', 'view.js'), 'utf8'), ctx);
    const expanded = {};
    for (const s of model.sessions) { expanded['detail:' + s.id] = true; expanded['more-dc:' + s.id] = true; expanded['more-ch:' + s.id] = true; }
    const html = ctx.BriefView.renderApp(model, { expanded, tab: '나를 기다림' });
    for (const s of model.sessions) assert.ok(html.includes(`data-card="${s.id}"`) || s.tab !== '나를 기다림', `${s.id} card rendered`);
    const idle = model.sessions.find((s) => s.id === 'idle').decisions[0];
    assert.equal(idle.delivery, '전달 중');
    assert.equal(idle.receipt, null, 'unproven receipt is not exposed as a delivery proof');
  });
});

describe('gate repros: delivery rows, replyTrimmed chip, owned read failure', () => {
  const pageHtml = (model) => {
    const ctx = {};
    vm.runInNewContext(fs.readFileSync(join(HERE, '..', 'src', 'page', 'view.js'), 'utf8'), ctx);
    const expanded = {};
    for (const s of model.sessions) expanded['detail:' + s.id] = true;
    return ctx.BriefView.renderApp(model, { expanded, tab: '나를 기다림' }); // every card is in the HTML; the tab only hides
  };
  const rows = (html) => [...html.matchAll(/<p class="kv"><span class="sym">✅<\/span>([^<]*)<\/p>/g)].map((m) => m[1]);

  test('page shows each pending delivery state with its own planned text', (t) => {
    const store = openStore(tempRoot(t));
    meta(store, 'idle', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN });
    meta(store, 'busy', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN, running: true, pid: process.pid });
    for (const [id, sid] of [[1, 'idle'], [2, 'idle'], [4, 'idle'], [3, 'busy']]) {
      decision(store, { id, sessionId: sid, question: `q${id}`, createdAt: NOW - 5 * MIN });
      store.writeNew(`answers/${p6(id)}.json`, { id, option: 'A', at: NOW - 4 * MIN });
    }
    store.writeNew('receipts/000002.json', { id: 2, sessionId: 'idle', deliveredAt: NOW - MIN, kind: 'fallback', mode: 'immediate', proven: false });
    store.writeNew('receipts/000004.json', { id: 4, sessionId: 'idle', deliveredAt: NOW - MIN, kind: 'started', mode: 'immediate', proven: true });
    const got = rows(pageHtml(buildViewModel(store.readSnapshot(), NOW)));
    assert.equal(got.filter((r) => r === '#1 답 받음 · 대기: 그 대화가 다시 열리면 전달').length, 1, JSON.stringify(got));
    assert.equal(got.filter((r) => r === '#2 답 받음 · 전달 중').length, 1, JSON.stringify(got));
    assert.equal(got.filter((r) => r === '#3 답 받음 · 대기: 작업이 끝나면 전달').length, 1, JSON.stringify(got));
    assert.equal(got.filter((r) => /^#4 답 받음 · 전달됨 ⏱ \d\d:\d\d$/.test(r)).length, 1, JSON.stringify(got));
  });

  test('meta.replyTrimmed (the producer field) shows the 답 자동 줄임 chip on the card', (t) => {
    const store = openStore(tempRoot(t));
    meta(store, 'tr', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN, replyTrimmed: true });
    brief(store, 'tr', 1, NOW - MIN, { title: 'tr', headline: 'h' });
    meta(store, 'plain', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN });
    brief(store, 'plain', 1, NOW - MIN, { title: 'plain', headline: 'h' });
    const model = buildViewModel(store.readSnapshot(), NOW);
    const s = byId(model);
    assert.equal(s.tr.answerTrimmed, true);
    assert.equal(s.plain.answerTrimmed, undefined);
    const cards = pageHtml(model).split('<article ').filter((c) => c.includes('data-card="tr"') || c.includes('data-card="plain"'));
    assert.equal(cards.filter((c) => c.includes('답 자동 줄임')).length, 1);
    assert.ok(cards.find((c) => c.includes('data-card="tr"')).includes('답 자동 줄임'));
  });

  test('corrupt answer/receipt/closure of a known decision puts 기록 읽기 실패 on the owning card only', (t) => {
    const store = openStore(tempRoot(t));
    meta(store, 'own', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN });
    brief(store, 'own', 1, NOW - MIN, { title: 'own', headline: 'h' });
    decision(store, { id: 1, sessionId: 'own', question: 'q', createdAt: NOW - 2 * MIN });
    decision(store, { id: 2, sessionId: 'own2', question: 'q', createdAt: NOW - 2 * MIN });
    meta(store, 'own2', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN });
    brief(store, 'own2', 1, NOW - MIN, { title: 'own2', headline: 'h' });
    meta(store, 'other', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN });
    brief(store, 'other', 1, NOW - MIN, { title: 'other', headline: 'h' });
    fs.mkdirSync(join(store.root, 'answers'), { recursive: true });
    fs.writeFileSync(join(store.root, 'answers/000001.json'), '{');
    fs.mkdirSync(join(store.root, 'receipts'), { recursive: true });
    fs.writeFileSync(join(store.root, 'receipts/000002.json'), '{');
    const model = buildViewModel(store.readSnapshot(), NOW);
    const s = byId(model);
    assert.deepEqual(model.readErrors.sort(), ['answers/000001.json', 'receipts/000002.json']);
    assert.ok(s.own.chips.includes('기록 읽기 실패'));
    assert.ok(s.own2.chips.includes('기록 읽기 실패'));
    assert.ok(!s.other.chips.includes('기록 읽기 실패'));
    assert.ok(pageHtml(model).split('<article ').find((c) => c.includes('data-card="own"')).includes('기록 읽기 실패'));
  });

  const cardOf = (html, id) => html.split('<article ').find((c) => c.includes(`data-card="${id}"`)) ?? '';
  const corrupt = (store, rel) => {
    fs.mkdirSync(join(store.root, dirname(rel)), { recursive: true });
    fs.writeFileSync(join(store.root, rel), '{');
  };

  test('corrupt mirror/<sid>.json (owner = filename) and corrupt decision whose owner is knowable put 기록 읽기 실패 on that card', (t) => {
    const store = openStore(tempRoot(t));
    for (const sid of ['clean', 'mir', 'bydec', 'byrec', 'nowner']) {
      meta(store, sid, { cwd: 'C:/w/x', lastActivityAt: NOW - MIN });
    }
    brief(store, 'clean', 1, NOW - MIN, { title: 'clean', headline: 'h' });
    brief(store, 'mir', 1, NOW - MIN, { title: 'mir', headline: 'h' });
    brief(store, 'bydec', 1, NOW - MIN, { title: 'bydec', headline: 'h', decisions: [{ id: 15, question: 'q', options: { A: opt('가', '가') }, recommend: 'A' }] });
    brief(store, 'byrec', 1, NOW - MIN, { title: 'byrec', headline: 'h' });
    brief(store, 'nowner', 1, NOW - MIN, { title: 'nowner', headline: 'h' });
    store.writeNew('receipts/000016.json', { id: 16, sessionId: 'byrec', deliveredAt: NOW - MIN, kind: 'started', mode: 'immediate', proven: true });
    corrupt(store, 'mirror/mir.json');
    corrupt(store, 'decisions/000015.json'); // owner only in bydec's brief
    corrupt(store, 'decisions/000016.json'); // owner only in byrec's readable receipt
    corrupt(store, 'decisions/000099.json'); // owner nowhere
    const model = buildViewModel(store.readSnapshot(), NOW);
    assert.deepEqual(model.readErrors.sort(), ['decisions/000015.json', 'decisions/000016.json', 'decisions/000099.json', 'mirror/mir.json']);
    const html = pageHtml(model);
    for (const id of ['mir', 'bydec', 'byrec']) assert.ok(cardOf(html, id).includes('기록 읽기 실패'), `${id} card warns`);
    for (const id of ['clean', 'nowner']) assert.ok(!cardOf(html, id).includes('기록 읽기 실패'), `${id} card stays clean`);
  });

  test('answer admitted for delivery (pending list, no receipt) shows 전달 중; 전달됨 only for a proven receipt', (t) => {
    const store = openStore(tempRoot(t));
    meta(store, 'idle', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN, pendingDeliveries: [22] });
    meta(store, 'busy', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN, running: true, pid: process.pid });
    for (const [id, sid] of [[21, 'busy'], [22, 'idle'], [23, 'idle'], [24, 'idle']]) {
      decision(store, { id, sessionId: sid, question: `q${id}`, createdAt: NOW - 5 * MIN });
      store.writeNew(`answers/${p6(id)}.json`, { id, option: 'A', at: NOW - 4 * MIN });
    }
    store.writeNew('receipts/000024.json', { id: 24, sessionId: 'idle', deliveredAt: NOW - MIN, kind: 'started', mode: 'immediate', proven: true });
    const none = rows(pageHtml(buildViewModel(store.readSnapshot(), NOW)));
    assert.ok(none.includes('#21 답 받음 · 대기: 작업이 끝나면 전달'), JSON.stringify(none)); // not admitted -> still waiting
    assert.ok(none.includes('#22 답 받음 · 전달 중'), 'meta.pendingDeliveries admission shows 전달 중: ' + JSON.stringify(none));
    const model = buildViewModel(store.readSnapshot(), NOW, { pendingDeliveries: new Set([21, 24]) });
    const got = rows(pageHtml(model));
    assert.ok(got.includes('#21 답 받음 · 전달 중'), JSON.stringify(got)); // in-memory list, no receipt written
    assert.ok(got.includes('#23 답 받음 · 대기: 그 대화가 다시 열리면 전달'), JSON.stringify(got));
    assert.ok(got.some((r) => /^#24 답 받음 · 전달됨 ⏱ \d\d:\d\d$/.test(r)), 'a real receipt wins over the pending list: ' + JSON.stringify(got));
    const d21 = byId(model).busy.decisions[0];
    assert.equal(d21.receipt, null);
    assert.equal(fs.existsSync(join(store.root, 'receipts/000021.json')), false, 'no receipt is created for an admission');
  });

  test('renderPage hands the in-memory pending list to the published page', (t) => {
    const store = openStore(tempRoot(t));
    meta(store, 'busy', { cwd: 'C:/w/x', lastActivityAt: NOW - MIN, running: true, pid: process.pid });
    brief(store, 'busy', 1, NOW - MIN, { title: 'busy', headline: 'h' });
    decision(store, { id: 21, sessionId: 'busy', question: 'q', createdAt: NOW - 5 * MIN });
    store.writeNew('answers/000021.json', { id: 21, option: 'A', at: NOW - 4 * MIN });
    const r = renderPage(store, NOW, { pendingDeliveries: [21] });
    assert.equal(r.ok, true);
    const data = runDataJs(fs.readFileSync(join(store.root, 'data.js'), 'utf8'));
    assert.equal(data.sessions[0].decisions[0].delivery, '전달 중');
  });
});

describe('renderPage', () => {
  test('writes index.html + data.js + published.json; data.js runs in vm and seq increases', (t) => {
    const store = fixtureStore(tempRoot(t));
    const r1 = renderPage(store, NOW);
    assert.equal(r1.ok, true);
    assert.deepEqual(r1.seqs, [1]);
    const d1 = runDataJs(fs.readFileSync(join(store.root, 'data.js'), 'utf8'));
    assert.equal(d1.seq, 1);
    assert.equal(d1.sessions.length, 6);
    const r2 = renderPage(store, NOW + MIN);
    assert.deepEqual(r2.seqs, [2]);
    const d2 = runDataJs(fs.readFileSync(join(store.root, 'data.js'), 'utf8'));
    assert.equal(d2.seq, 2);
    const pub = JSON.parse(fs.readFileSync(join(store.root, 'published.json'), 'utf8'));
    assert.equal(pub.seq, 2);
    assert.match(pub.dataHash, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(join(store.root, 'render.lock')), false);
    const html = fs.readFileSync(join(store.root, 'index.html'), 'utf8');
    assert.match(html, /BriefView/); // view.js inlined
    assert.match(html, /__briefData/); // page.js inlined
    // no external requests; the one <link> is the inline data: icon that keeps the board server's 404 for /favicon.ico out of the console
    assert.doesNotMatch(html, /<script[^>]+src=|<link(?![^>]+href="data:,")[^>]+href=|https?:\/\//);
    assert.equal((html.match(/<link[^>]+href=/g) ?? []).length, 1);
  });

  test('seq is max(published.json, data.js) + 1: an older valid manifest never rolls the board back', (t) => {
    const store = openStore(tempRoot(t));
    meta(store, 'x', { cwd: 'C:/w/x', lastActivityAt: NOW });
    brief(store, 'x', 1, NOW, { title: 't', headline: 'h' });
    store.replace('published.json', { seq: 86 });
    assert.deepEqual(renderPage(store, NOW).seqs, [87]);
    store.replace('published.json', { seq: 42 }); // manifest lags behind the board data.js shows
    const r = renderPage(store, NOW + MIN);
    assert.equal(r.ok, true);
    assert.deepEqual(r.seqs, [88]);
    assert.equal(runDataJs(fs.readFileSync(join(store.root, 'data.js'), 'utf8')).seq, 88);
    assert.equal(JSON.parse(fs.readFileSync(join(store.root, 'published.json'), 'utf8')).seq, 88);
    // and the other direction: a manifest ahead of data.js still wins
    store.replace('published.json', { seq: 200 });
    assert.deepEqual(renderPage(store, NOW + 2 * MIN).seqs, [201]);
  });

  test('T17-SEQ-NONREGRESSION: an unreadable data.js is retried; a persistent failure publishes nothing and is reported', (t) => {
    const root = tempRoot(t);
    const plain = openStore(root);
    meta(plain, 'x', { cwd: 'C:/w/x', lastActivityAt: NOW });
    brief(plain, 'x', 1, NOW, { title: 't', headline: 'h' });
    plain.replace('published.json', { seq: 86 });
    assert.deepEqual(renderPage(plain, NOW).seqs, [87]);
    plain.replace('published.json', { seq: 42 }); // manifest lags behind the board data.js shows
    const dataBefore = fs.readFileSync(join(root, 'data.js'), 'utf8');
    const denyData = (failures) => {
      let n = 0;
      return { ...fs, readFileSync: (file, ...a) => {
        if (String(file).replace(/\\/g, '/').endsWith('/data.js') && n++ < failures) {
          throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
        }
        return fs.readFileSync(file, ...a);
      } };
    };
    // transient: the bounded retry read gets through, so the seq continues from 87
    const transient = renderPage(openStore(root, { fs: denyData(2), sleep: () => {} }), NOW + MIN);
    assert.equal(transient.ok, true);
    assert.deepEqual(transient.seqs, [88]);
    plain.replace('published.json', { seq: 42 });
    const dataMid = fs.readFileSync(join(root, 'data.js'), 'utf8');
    // persistent: skip publishing, keep the last page, surface the error
    const bad = renderPage(openStore(root, { fs: denyData(Infinity), sleep: () => {} }), NOW + 2 * MIN, { sessionId: 'x' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /게시 실패/);
    assert.deepEqual(bad.seqs, []);
    assert.equal(fs.readFileSync(join(root, 'data.js'), 'utf8'), dataMid);
    assert.equal(JSON.parse(fs.readFileSync(join(root, 'published.json'), 'utf8')).seq, 42);
    assert.match(plain.readRecord('sessions/x/meta.json').lastError.message, /게시 실패/);
    assert.notEqual(dataBefore, dataMid);
  });

  test('R5-B1: an exhausted index.html generation read keeps the page, publishes data, reports the error with a chip and fails', (t) => {
    const root = tempRoot(t);
    const plain = openStore(root);
    meta(plain, 'x', { cwd: 'C:/w/x', lastActivityAt: NOW });
    brief(plain, 'x', 1, NOW, { title: 't', headline: 'h' });
    assert.equal(renderPage(plain, NOW, { generation: 2 }).ok, true);
    const pageBefore = fs.readFileSync(join(root, 'index.html'), 'utf8');
    assert.match(pageBefore, /omo-briefing-generation" content="2"/);
    let denied = 0;
    const denyIndex = { ...fs, readFileSync: (file, ...a) => {
      if (String(file).replace(/\\/g, '/').endsWith('/index.html')) {
        denied++;
        throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
      }
      return fs.readFileSync(file, ...a);
    } };
    const bad = renderPage(openStore(root, { fs: denyIndex, sleep: () => {} }), NOW + MIN, { sessionId: 'x', generation: 1 });
    assert.ok(denied >= 8, 'the whole read retry bound was consumed');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /EACCES/);
    assert.equal(fs.readFileSync(join(root, 'index.html'), 'utf8'), pageBefore, 'the newer page is not replaced');
    assert.match(plain.readRecord('sessions/x/meta.json').errors.render.message, /EACCES/);
    const data = fs.readFileSync(join(root, 'data.js'), 'utf8');
    assert.ok(runDataJs(data).seq > 1, 'data.js still advanced');
    assert.ok(data.includes('오류 있음'), 'the published data carries the error chip');
    assert.equal(JSON.parse(fs.readFileSync(join(root, 'published.json'), 'utf8')).seq, runDataJs(data).seq);
  });

  test('R5-B1: a missing index.html (no page yet) is not an error: the page is written', (t) => {
    const store = openStore(tempRoot(t));
    meta(store, 'x', { cwd: 'C:/w/x', lastActivityAt: NOW });
    brief(store, 'x', 1, NOW, { title: 't', headline: 'h' });
    assert.equal(renderPage(store, NOW, { generation: 1 }).ok, true);
    assert.match(fs.readFileSync(join(store.root, 'index.html'), 'utf8'), /omo-briefing-generation" content="1"/);
  });

  test('HTML/script injection in brief text cannot add script tags', (t) => {
    const count = (h) => (h.match(/<script/gi) || []).length;
    const plain = openStore(tempRoot(t));
    meta(plain, 'x', { cwd: 'C:/w/x', lastActivityAt: NOW });
    brief(plain, 'x', 1, NOW, { title: 't', headline: 'plain' });
    renderPage(plain, NOW);
    const evil = openStore(tempRoot(t));
    const payload = '</script><script>alert(1)</script><!--';
    meta(evil, 'x', { cwd: 'C:/w/x', lastActivityAt: NOW, title: payload });
    brief(evil, 'x', 1, NOW, { title: payload, headline: payload, changes: [{ text: '</SCRIPT >\u2028', truth: 'reported', applied: 'none' }] });
    renderPage(evil, NOW);
    const html = fs.readFileSync(join(evil.root, 'index.html'), 'utf8');
    assert.equal(count(html), count(fs.readFileSync(join(plain.root, 'index.html'), 'utf8')));
    assert.doesNotMatch(html, /<\/script><script>alert/i);
    const data = runDataJs(fs.readFileSync(join(evil.root, 'data.js'), 'utf8'));
    assert.equal(data.sessions[0].headline, payload); // text survives intact as data
  });

  test('broken brief JSON: render succeeds and that card shows 기록 읽기 실패', (t) => {
    const store = openStore(tempRoot(t));
    meta(store, 'ok', { cwd: 'C:/w/x', lastActivityAt: NOW });
    brief(store, 'ok', 1, NOW, { title: 'ok', headline: 'fine' });
    meta(store, 'bad', { cwd: 'C:/w/x', lastActivityAt: NOW });
    brief(store, 'bad', 1, NOW - MIN, { title: 'bad', headline: 'older but valid' });
    fs.writeFileSync(join(store.root, 'sessions/bad/briefs/000002.json'), '{"at": 1, "brief": {');
    fs.mkdirSync(join(store.root, 'sessions/badmeta'), { recursive: true });
    fs.writeFileSync(join(store.root, 'sessions/badmeta/meta.json'), 'not json');
    brief(store, 'badmeta', 1, NOW, { title: 'bm', headline: 'meta broken' });
    const r = renderPage(store, NOW);
    assert.equal(r.ok, true);
    const s = byId(runDataJs(fs.readFileSync(join(store.root, 'data.js'), 'utf8')));
    assert.ok(s.bad.chips.includes('기록 읽기 실패'));
    assert.equal(s.bad.headline, 'older but valid');
    assert.ok(s.badmeta.chips.includes('기록 읽기 실패'));
    assert.ok(!s.ok.chips.includes('기록 읽기 실패'));
  });

  test('meta.lastError puts the 오류 있음 chip on that card only; cleared lastError shows no chip', (t) => {
    const store = openStore(tempRoot(t));
    meta(store, 'err', { cwd: 'C:/w/x', lastActivityAt: NOW, lastError: { at: NOW, message: 'render.lock 잠금을 얻지 못함' } });
    brief(store, 'err', 1, NOW, { title: 'err', headline: 'e' });
    meta(store, 'cleared', { cwd: 'C:/w/x', lastActivityAt: NOW, lastError: null });
    brief(store, 'cleared', 1, NOW, { title: 'cleared', headline: 'c' });
    meta(store, 'never', { cwd: 'C:/w/x', lastActivityAt: NOW });
    brief(store, 'never', 1, NOW, { title: 'never', headline: 'n' });
    const r = renderPage(store, NOW);
    assert.equal(r.ok, true);
    const s = byId(runDataJs(fs.readFileSync(join(store.root, 'data.js'), 'utf8')));
    assert.ok(s.err.chips.includes('오류 있음'), JSON.stringify(s.err.chips));
    assert.ok(!s.cleared.chips.includes('오류 있음'));
    assert.ok(!s.never.chips.includes('오류 있음'));
    const html = fs.readFileSync(join(store.root, 'index.html'), 'utf8');
    assert.ok(html.includes('오류 있음'));
    assert.ok(!JSON.stringify(s.err).includes('잠금을 얻지'), 'error detail stays out of the page model');
  });

  test('a skipped publish under a live render.lock leaves lastError that the next publish shows as a chip', (t) => {
    const store = fixtureStore(tempRoot(t));
    store.writeNew('render.lock', { pid: process.pid, at: NOW, nonce: 'live-nonce' });
    assert.equal(renderPage(store, NOW, { sessionId: 's-a1', sleep: () => {} }).ok, false);
    fs.unlinkSync(join(store.root, 'render.lock'));
    assert.equal(renderPage(store, NOW).ok, true);
    const s = byId(runDataJs(fs.readFileSync(join(store.root, 'data.js'), 'utf8')));
    assert.ok(s['s-a1'].chips.includes('오류 있음'));
    assert.ok(!s['s-a2'].chips.includes('오류 있음'));
  });

  test('dead-pid render.lock is reclaimed via reclaimStale and the publish succeeds', (t) => {
    const store = fixtureStore(tempRoot(t));
    const stale = { pid: deadPid(), at: NOW - DAY, nonce: 'dead-nonce' };
    store.writeNew('render.lock', stale);
    const r = renderPage(store, NOW);
    assert.equal(r.ok, true);
    assert.deepEqual(r.seqs, [1]);
    assert.equal(fs.existsSync(join(store.root, 'render.lock')), false);
    assert.ok(fs.existsSync(join(store.root, 'render.lock.stale-dead-nonce')), 'matching tombstone stays');
  });

  test('live-pid render.lock is never removed; publish is skipped after retries and lastError recorded', (t) => {
    const store = fixtureStore(tempRoot(t));
    const live = { pid: process.pid, at: NOW - 30 * DAY, nonce: 'live-nonce' };
    store.writeNew('render.lock', live);
    const delays = [];
    const r = renderPage(store, NOW, { sessionId: 's-a1', sleep: (ms) => delays.push(ms) });
    assert.equal(r.ok, false);
    assert.deepEqual(r.seqs, []);
    assert.deepEqual(delays, [20, 40, 80, 160, 320, 640, 1280, 2560]);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(store.root, 'render.lock'), 'utf8')), live);
    assert.equal(fs.existsSync(join(store.root, 'data.js')), false);
    const m = JSON.parse(fs.readFileSync(join(store.root, 'sessions/s-a1/meta.json'), 'utf8'));
    assert.match(m.lastError.message, /render\.lock/);
    assert.equal(m.lastError.at, NOW);
    assert.equal(m.title, '알파 하나', 'other meta fields kept');
  });

  test('late reclaim with a stale record never deletes a lock re-acquired by another process', (t) => {
    const root = tempRoot(t);
    fixtureStore(root);
    const lockFile = join(root, 'render.lock');
    const dead = { pid: deadPid(), at: NOW - DAY, nonce: 'old' };
    const fresh = { pid: process.pid, at: NOW, nonce: 'fresh' };
    let swapped = false;
    // Between the renderer reading the dead record and linking the tombstone, the dead lock is
    // released normally and another (live) process takes render.lock.
    const racyFs = {
      ...fs,
      linkSync(src, dst) {
        if (!swapped && src === lockFile) {
          swapped = true;
          fs.unlinkSync(lockFile);
          fs.writeFileSync(lockFile, JSON.stringify(fresh), { flag: 'wx' });
        }
        return fs.linkSync(src, dst);
      },
    };
    const store = openStore(root, { fs: racyFs });
    fs.writeFileSync(lockFile, JSON.stringify(dead), { flag: 'wx' });
    const r = renderPage(store, NOW, { sleep: () => {} });
    assert.equal(swapped, true);
    assert.equal(r.ok, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), fresh);
    assert.equal(fs.existsSync(`${lockFile}.stale-old`), false, 'mismatching tombstone removed');
  });

  test('two processes x 50 renders race on render.lock: seqs unique and increasing, both latest briefs published', async (t) => {
    const root = tempRoot(t);
    fs.mkdirSync(root, { recursive: true });
    const N = 50;
    const kids = ['race-a', 'race-b'].map((sid) => fork(CHILD, [root, sid, String(N)], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
    t.after(() => kids.forEach((k) => { if (k.exitCode === null) k.kill(); }));
    const waitFor = (k, type) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 60_000);
      k.on('message', (m) => {
        if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.message)); }
        if (m.type === type) { clearTimeout(timer); resolve(m); }
      });
      k.on('exit', (code) => { if (code) { clearTimeout(timer); reject(new Error(`child exit ${code}`)); } });
    });
    await Promise.all(kids.map((k) => waitFor(k, 'ready')));
    const done = kids.map((k) => waitFor(k, 'done'));
    kids.forEach((k) => k.send({ type: 'go' }));
    const results = await Promise.all(done);
    const all = [];
    for (const res of results) {
      const mine = res.rounds.flatMap((r) => r.seqs);
      t.diagnostic(`${res.sid} published seqs: ${mine.join(',')}`);
      const skipped = res.rounds.filter((r) => !r.ok);
      t.diagnostic(`${res.sid} skipped publishes: ${skipped.length}${skipped.length ? ' ' + JSON.stringify(skipped[0].error) : ''}`);
      for (let i = 1; i < mine.length; i++) assert.ok(mine[i] > mine[i - 1], `${res.sid} seq must increase`);
      all.push(...mine);
    }
    const sorted = [...all].sort((a, b) => a - b);
    assert.equal(new Set(all).size, all.length, 'no duplicate seq');
    assert.deepEqual(sorted, sorted.map((_, i) => i + 1), 'seqs are 1..n with no gap');
    const pub = JSON.parse(fs.readFileSync(join(root, 'published.json'), 'utf8'));
    assert.equal(pub.seq, sorted.at(-1));
    const data = runDataJs(fs.readFileSync(join(root, 'data.js'), 'utf8'));
    assert.equal(data.seq, pub.seq);
    const heads = Object.fromEntries(data.sessions.map((s) => [s.id, s.headline]));
    assert.equal(heads['race-a'], `race-a-${N}`);
    assert.equal(heads['race-b'], `race-b-${N}`);
    assert.equal(fs.existsSync(join(root, 'render.lock')), false);
  });
});
