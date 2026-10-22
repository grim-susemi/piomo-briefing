import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { makeController, memoryStorage } from './fixtures/controller-dom.mjs';
import { buildViewModel, pageHtml } from '../src/render.mjs';

const session = patch => ({ id: 's1', title: 'Test', alive: true, briefSeq: 1, status: 'in_progress',
  changes: [{ text: 'same row', truth: 'reported', applied: 'none', evidence: 'C:/project/evidence.txt' }],
  done: [{ text: 'done row', truth: 'reported', applied: 'none' }], notes: [], decisions: [], answerKinds: ['annotation'], ...patch });
const model = (seq, s = session(), extra = {}) => ({ seq, generatedAt: 0, sessions: [s], ...extra });
const note = { blocks: ['change/1/0'], sub: 'ov', text: 'same row', snip: 'same row', intent: '고쳐줘', comment: 'fix', paths: ['C:/project/evidence.txt'] };
const flush = () => new Promise(resolve => setImmediate(resolve));
const posts = e => e.fetches.filter(f => f.url === '/answer');
// a delivery line as the page draws it (icons.js loaded, as the page does): its stopwatch is the clock icon
const delivered = hhmm => new RegExp('전달됨 <svg class="ic ic-xs" aria-hidden="true" focusable="false"><use href="#i-clock"></use></svg>' + hhmm);
const reply = (r, status, json) => r.resolve({ status, json: async () => json });
function click(e, selector) {
  const t = e.document.querySelector(selector);
  assert.ok(t, 'rendered control ' + selector);
  return e.fire(t, 'click');
}
function prepare(e, s = session()) {
  e.page.receive(model(1, s)); e.page.open(s.id, 'ov');
  assert.equal(e.ctx.BriefAnnotate.add(s.id, note).ok, true);
  e.ctx.BriefAnnotate.decorate();
}

test('C-CAP2 integration: trimmed notice is present only with the counter', () => {
  const e = makeController();
  e.page.receive(model(1, session(), { trimmed: { cards: 3 } }));
  assert.match(e.byId.app.textContent, /오래된 대화 3개는 자세한 정보를 줄였어요/);
  e.advance(600); e.page.receive(model(2));
  assert.doesNotMatch(e.byId.app.textContent, /오래된 대화/);
  assert.deepEqual(e.errors, []);
});

test('regions: seq-only refresh and sidebar search keep main, input, resize handle and scroll nodes', () => {
  const e = makeController(); prepare(e);
  const input = e.app.querySelector('[data-sh="search"]');
  const rz = e.app.querySelector('[data-sh="rz"]'), main = e.byId.main, list = e.app.querySelector('[data-sh-part="list"]');
  const content = main.firstChild, writes = [e.byId.rail.writes, e.byId.tabs.writes, main.writes, list.writes];
  list.scrollTop = 230; main.scrollTop = 340;
  input.value = 'Test'; input.focus(); e.fire(input, 'input');
  assert.equal(e.page.busy(), false, 'sidebar search focus cannot hold model updates');
  e.advance(600); e.page.receive(model(2));
  assert.equal(e.page.state.seq, 2);
  assert.equal(e.app.querySelector('[data-sh="search"]'), input);
  assert.equal(e.app.querySelector('[data-sh="rz"]'), rz);
  assert.equal(e.document.activeElement, input);
  assert.equal(input.value, 'Test');
  assert.equal(main.firstChild, content);
  assert.deepEqual([e.byId.rail.writes, e.byId.tabs.writes, main.writes], writes.slice(0, 3));
  assert.equal(main.scrollTop, 340); assert.equal(list.scrollTop, 230);
  assert.equal(e.ctx.BriefAnnotate.list('s1').length, 1);
  assert.deepEqual(e.errors, []);
});

test('conversation refresh glow and worker measurements use stable block and session identities', () => {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'workers-view', 'convo-view', 'shell', 'annotate'] });
  const s = session({ live: { workers: [{ id: 'st_a', name: 'Worker', state: 'running', startedAt: 0, updatedAt: 0 }] } });
  e.page.receive(model(1, s)); e.page.open('s1', 'wk');
  const snap = e.ctx.BriefWorkersView.measure(e.byId.main);
  assert.ok(snap.cards.s1);
  assert.equal(snap.rows['s1\nwk/st_a'].el.getAttribute('data-block'), 'wk/st_a');
  e.advance(600); e.page.receive(model(2, { ...s, title: 'Changed' }));
  assert.equal(e.byId.main.querySelector('[data-block="head"]').classList.contains('flash'), true);
  e.advance(900);
  assert.equal(e.byId.main.querySelector('[data-block="head"]').classList.contains('flash'), false);
  assert.deepEqual(e.errors, []);
});

test('regions: a rail click with running workers keeps #main and #tabs; worker rows use one clock per applied model', () => {
  // the page scripts' own Date.now() moves on every read: a render that reads it draws another pulse phase
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'workers-view', 'convo-view', 'shell', 'annotate'],
    configure: ctx => vm.runInContext('(function () { var t = 1700000000000; Date.now = function () { return t += 137; }; })();', ctx) });
  const s = session({ live: { workers: [{ id: 'st_a', name: 'Worker', state: 'running', startedAt: 0, updatedAt: 0 }] } });
  e.page.receive(model(1, s));
  const main = e.byId.main, tabs = e.byId.tabs;
  assert.match(main.innerHTML, /<span class="w-dot" style="animation-delay:-\d+ms"/, 'the overview card pulses');
  const railClicks = where => {
    for (const key of ['inbox', 'plans', 'home', 'archive', 'settings', 'conv']) {
      const before = { main: main.innerHTML, tabs: tabs.innerHTML, writes: main.writes };
      click(e, `#rail [data-sh="view"][data-key="${key}"]`);
      assert.equal(e.page.state.ui.view, key, `${where} ${key}`);
      assert.equal(main.innerHTML, before.main, `${where} ${key}: #main HTML unchanged`);
      assert.equal(tabs.innerHTML, before.tabs, `${where} ${key}: #tabs HTML unchanged`);
      assert.equal(main.writes, before.writes, `${where} ${key}: #main not rewritten`);
    }
  };
  railClicks('overview');
  // 65 s after the apply the same model's 작업자 sub-tab is drawn: its elapsed time is the current one, not the apply's
  e.advance(65_000);
  e.page.open('s1', 'wk');
  const timer = main.querySelector('[data-since]');
  assert.ok(timer, 'the stable timer node remains available to the ticker');
  assert.equal(timer.textContent, '1분 06초');
  assert.ok(timer.parentNode.querySelector('svg.ic use[href="#i-clock"]'), 'a separate Lucide clock precedes the timer');
  railClicks('작업자');
  assert.equal(main.querySelector('[data-since]'), timer, 'rail navigation preserves the timer node');
  assert.deepEqual(e.errors, []);
});

test('regions: model changes keep an anchor offset and independent scroll for each sub-tab', () => {
  const e = makeController(); prepare(e);
  const main = e.byId.main, old = main.querySelector('[data-block="now"]');
  e.ctx.rects.set(main, { top: 40, left: 0, width: 1000, height: 800 });
  for (const b of main.querySelectorAll('[data-block]')) e.ctx.rects.set(b, { top: -200, left: 0, width: 500, height: 20 });
  e.ctx.rects.set(old, { top: 70, left: 0, width: 500, height: 80 });
  main.scrollTop = 500;
  // Layout is deterministic: the new now block moves 150px below its old offset.
  const original = e.page.restoreAnchor;
  const ctx = e.ctx;
  const decorate = ctx.BriefAnnotate.decorate;
  ctx.BriefAnnotate.decorate = () => {
    decorate();
    ctx.rects.set(main.querySelector('[data-block="now"]'), { top: 220, left: 0, width: 500, height: 80 });
  };
  e.advance(600); e.page.receive(model(2, session({ headline: 'changed' })));
  assert.equal(main.scrollTop, 650);
  ctx.BriefAnnotate.decorate = decorate;
  assert.equal(e.page.restoreAnchor, original);
  for (const b of main.querySelectorAll('[data-block]')) e.ctx.rects.set(b, { top: -200, left: 0, width: 500, height: 20 });
  e.page.open('s1', 'dec'); assert.equal(main.scrollTop, 0);
  main.scrollTop = 90;
  e.page.open('s1', 'ov'); assert.equal(main.scrollTop, 650);
  e.page.open('s1', 'dec'); assert.equal(main.scrollTop, 90);
});

test('anchor restore measures at the saved scroll, not the previous sub-tab scroll', () => {
  const e = makeController(); e.page.receive(model(1)); e.page.open('s1', 'ov');
  const main = e.byId.main, block = main.querySelector('[data-block="head"]');
  block.getBoundingClientRect = () => ({ top: 1000 - main.scrollTop, bottom: 1050 - main.scrollTop });
  main.scrollTop = 50;
  e.page.restoreAnchor({ id: 'head', top: 100 }, 900);
  assert.equal(main.scrollTop, 900);
});

test('known: every applied model records absence and prunes after 30 days without erasing current tabs', () => {
  const storage = memoryStorage();
  const e = makeController({ localStorage: storage });
  e.page.receive(model(1)); e.page.open('s1', 'dec');
  e.advance(600); e.page.receive({ seq: 2, sessions: [] });
  assert.equal(e.page.state.ui.absent.s1, 1600);
  assert.equal(e.page.state.ui.active, 's1');
  assert.match(e.byId.main.textContent, /지금 안 보임/);
  const next = makeController({ localStorage: storage });
  next.advance(31 * 86400000);
  next.page.receive({ seq: 3, sessions: [session({ id: 's2' })] });
  assert.equal(next.page.state.ui.tabs.includes('s1'), false);
  assert.equal(next.page.state.ui.absent.s1, undefined);
  assert.equal(next.page.state.ui.active, null);
});

test('plan first open seeds only unset expansion keys and keeps an explicit collapse on later opens', () => {
  const e = makeController();
  const s = session({ plan: { planId: 'p1', goal: 'Goal', tasks: [{ id: '1', wave: 1, label: 'one', state: 'todo' }], waves: [{ n: 1, label: 'First' }] } });
  e.page.receive(model(1, s));
  assert.equal(e.page.state.ui.expanded['plan:p1'], undefined);
  click(e, '[data-sh="open"][data-sid="s1"]');
  click(e, '[data-act="sub"][data-sub="plan"]');
  assert.equal(e.page.state.ui.expanded['plan:p1'], true);
  assert.equal(e.page.state.ui.expanded['plan-tasks:p1'], true);
  assert.ok(e.byId.main.querySelector('.plan-expanded'));
  click(e, '[data-key="plan:p1"]');
  assert.equal(e.page.state.ui.expanded['plan:p1'], false);
  e.page.open('s1', 'ov'); e.page.open('s1', 'plan');
  assert.ok(e.byId.main.querySelector('.plan-collapsed'));
  e.page.state.ui.expanded['plan-tasks:p1'] = false;
  e.advance(600); e.page.receive(model(2, s));
  assert.equal(e.page.state.ui.expanded['plan-tasks:p1'], false);
});

test('details toggles, including annotation preview, survive main region refresh', () => {
  const e = makeController(); prepare(e);
  click(e, '[data-ann-act="list"]');
  for (const d of e.byId.main.querySelectorAll('details')) {
    assert.match(d.getAttribute('data-open-key'), /^cv:s1:/);
    d.open = !d.open; e.fire(d, 'toggle');
  }
  const before = { ...e.page.state.ui.expanded };
  e.advance(600); e.page.receive(model(2, session({ headline: 'new headline' })));
  for (const d of e.byId.main.querySelectorAll('details')) assert.equal(d.open, before[d.getAttribute('data-open-key')]);
  assert.equal(e.page.state.ui.expanded['cv:s1:ann-prev'], true);
});

test('overview held-details toggles persist through the shipped renderer', () => {
  const e = makeController();
  const s = session({ decisions: [{ id: 1, question: 'Later', held: true, closed: true }] });
  e.page.receive(model(1, s));
  const details = e.byId.main.querySelector('.held-decs');
  assert.equal(details.getAttribute('data-open-key'), 'cv:s1:held');
  details.open = true; e.fire(details, 'toggle');
  e.advance(600); e.page.receive(model(2, { ...s, headline: 'updated' }));
  assert.equal(e.byId.main.querySelector('.held-decs').open, true);
  assert.match(e.ctx.BriefView.renderOverview(model(2, s), {}), /<details class="held-decs" data-open-key="cv:s1:held"><summary>/);
});

test('busy: real annotation editor and main selection hold refresh; sidebar selection and search do not', () => {
  const e = makeController(); e.page.receive(model(1)); e.page.open('s1', 'ov');
  click(e, '[data-block="now"] [data-ann-act="block"]');
  assert.equal(e.ctx.BriefAnnotate.busy(), true);
  e.advance(600); e.page.receive(model(2));
  assert.equal(e.page.state.seq, 1);
  click(e, '[data-ann-act="cancel"]');
  e.document.activeElement = null; e.advance(100);
  assert.equal(e.page.state.seq, 2);
  e.selection.isCollapsed = false; e.selection.toString = () => 'selected'; e.selection.anchorNode = e.byId.main;
  e.page.receive(model(3));
  assert.equal(e.page.state.seq, 2);
  e.selection.anchorNode = e.byId.side;
  e.document.listeners.selectionchange(); e.advance(100);
  assert.equal(e.page.state.seq, 3, 'a selection in the sidebar is not a main hold');
  assert.deepEqual(e.errors, []);
});

test('annotation send success uses token and immutable UUID, clears only after storage success and opens feedback', async () => {
  const e = makeController(); prepare(e);
  const text = e.ctx.BriefAnnotate.compose(e.page.state.model.sessions[0]).text;
  click(e, '[data-ann-act="send"]');
  const request = posts(e)[0];
  assert.deepEqual(JSON.parse(request.opts.body), { kind: 'annotation', sessionId: 's1', requestId: '11111111-1111-4111-8111-000000000001', text });
  assert.equal(request.opts.headers['X-Board-Token'], 'tok-1');
  assert.match(e.byId.main.textContent, /보내는 중/);
  assert.equal(e.ctx.BriefAnnotate.list('s1').length, 1);
  assert.ok(e.ctx.BriefAnnotate.add('s1', note).error, 'in-flight notes cannot be silently lost');
  reply(request, 200, { ok: true, key: 'a-id' }); await flush();
  assert.equal(e.ctx.BriefAnnotate.list('s1').length, 0);
  assert.equal(e.ctx.sessionStorage.getItem('omo-briefing.annotation.s1'), null);
  assert.equal(e.byId.main.querySelector('[data-open-key="cv:s1:notes"]').open, true);
  assert.doesNotMatch(e.byId.main.textContent, /전달됨/);
  e.advance(600); e.page.receive(model(2, session({ notes: [{ key: 'a-id', at: 1, preview: 'stored', delivery: '전달됨 ⏱10:00' }] })));
  assert.match(e.byId.main.innerHTML, delivered('10:00'));
  assert.deepEqual(e.errors, []);
});

test('409 NO_ANNOTATION_SUPPORT keeps notes, shows Korean error and switches to Markdown copy', async () => {
  const e = makeController(); prepare(e); click(e, '[data-ann-act="send"]');
  reply(posts(e)[0], 409, { ok: false, code: 'NO_ANNOTATION_SUPPORT' }); await flush();
  assert.match(e.byId.main.textContent, /이 대화는 아직 주석을 못 받아요 - Markdown 복사로 붙여넣기/);
  assert.equal(e.ctx.BriefAnnotate.list('s1').length, 1);
  assert.equal(e.byId.main.querySelector('[data-ann-act="send"]'), null);
  click(e, '[data-ann-act="copy"]'); await flush();
  assert.match(e.ctx.copied, /상황판 피드백/);
  assert.equal(posts(e).length, 1);
  assert.deepEqual(e.errors, []);
});

test('annotation banner clears only on its matching delivered receipt and stays cleared through decision actions', async () => {
  const e = makeController();
  const s = session({ decisions: [{ id: 1, question: 'Which?', options: { A: { text: 'yes' } } }] });
  prepare(e, s);
  click(e, '[data-ann-act="send"]');
  const request = posts(e)[0], key = 'a-' + JSON.parse(request.opts.body).requestId;
  reply(request, 200, { ok: true, key }); await flush();
  const banner = () => e.byId.main.querySelector('.ann-msg');
  assert.ok(banner(), 'storage success is not delivery proof');
  const receiveNotes = (seq, notes) => {
    e.advance(600);
    e.page.receive(model(seq, { ...s, notes }));
  };
  receiveNotes(2, [{ key: 'a-other', at: 1, preview: 'other', delivery: '전달됨 ⏱10:00' }]);
  assert.ok(banner(), 'an unrelated receipt cannot clear this banner');
  receiveNotes(3, [{ key, at: 1, preview: 'stored', delivery: '전달 중' }]);
  assert.ok(banner(), 'admission without proof still waits');
  receiveNotes(4, [{ key, at: 1, preview: 'stored', delivery: '전달됨 ⏱10:01' }]);
  assert.equal(banner(), null, 'the matching proven receipt clears the banner');
  assert.match(e.byId.main.innerHTML, delivered('10:01'));
  click(e, '[data-act="ans-pick"]');
  assert.equal(banner(), null, 'later decision actions cannot restore a stale banner');
  assert.deepEqual(e.errors, []);
});

test('annotation errors preserve drafts; retries reuse the request; HTTP 200 without ok never claims success', async () => {
  for (const [status, code, message] of [[429, 'BUSY', /다른 답/], [503, 'PAUSED', /꺼져/], [413, 'TOO_LARGE', /너무 길어요/], [403, 'FORBIDDEN_TOKEN', /다시 열어/], [200, null, /200/]]) {
    const e = makeController({ sessionStorage: null }); prepare(e);
    click(e, '[data-ann-act="send"]'); const first = posts(e)[0];
    reply(first, status, { ok: false, code }); await flush();
    assert.match(e.byId.main.textContent, message);
    assert.equal(e.ctx.BriefAnnotate.list('s1').length, 1);
    assert.equal(e.reloads.length, 0);
    click(e, '[data-ann-act="send"]');
    assert.equal(posts(e)[1].opts.body, first.opts.body);
    reply(posts(e)[1], 200, { ok: true }); await flush();
    assert.equal(e.ctx.BriefAnnotate.list('s1').length, 0);
  }
});

test('annotation request conflict requires explicit new group and never discards the captured notes', async () => {
  const e = makeController(); prepare(e); click(e, '[data-ann-act="send"]');
  const first = posts(e)[0];
  reply(first, 409, { ok: false, code: 'REQUEST_ID_CONFLICT' }); await flush();
  assert.match(e.byId.main.textContent, /같은 묶음이 이미 다른 내용으로/);
  assert.equal(e.ctx.BriefAnnotate.list('s1').length, 1);
  click(e, '[data-act="ann-new"]');
  assert.equal(posts(e).length, 1, 'explicit reset does not send');
  click(e, '[data-ann-act="send"]');
  assert.notEqual(JSON.parse(posts(e)[1].opts.body).requestId, JSON.parse(first.opts.body).requestId);
  reply(posts(e)[1], 200, { ok: true }); await flush();
});

test('annotation 403 reload is bounded, carries notes and request ID, and never resends on startup', async () => {
  const storage = memoryStorage(), prefs = memoryStorage();
  const first = makeController({ sessionStorage: storage, localStorage: prefs }); prepare(first);
  click(first, '[data-ann-act="send"]');
  const body = posts(first)[0].opts.body;
  reply(posts(first)[0], 403, { ok: false, code: 'FORBIDDEN_TOKEN' }); await flush();
  assert.equal(first.reloads.length, 1);
  const next = makeController({ sessionStorage: storage, localStorage: prefs, token: 'new-token' });
  next.page.receive(model(1));
  assert.equal(next.ctx.BriefAnnotate.list('s1').length, 1);
  assert.equal(posts(next).length, 0);
  click(next, '[data-ann-act="send"]');
  assert.equal(posts(next)[0].opts.body, body);
  assert.equal(posts(next)[0].opts.headers['X-Board-Token'], 'new-token');
  reply(posts(next)[0], 403, { ok: false, code: 'FORBIDDEN_TOKEN' }); await flush();
  assert.equal(next.reloads.length, 0);
  assert.match(next.byId.main.textContent, /상황판을 다시 열어 주세요/);
});

test('generation reload keeps annotation drafts and the existing request without resending it', async () => {
  const storage = memoryStorage(), prefs = memoryStorage();
  const e = makeController({ generation: 8, sessionStorage: storage, localStorage: prefs });
  prepare(e); click(e, '[data-ann-act="send"]');
  const body = posts(e)[0].opts.body;
  reply(posts(e)[0], 429, { ok: false, code: 'BUSY' }); await flush();
  e.page.receive(model(2, session(), { gen: 9 }));
  assert.equal(e.reloads.length, 1);
  const next = makeController({ generation: 9, sessionStorage: storage, localStorage: prefs });
  next.page.receive(model(3, session(), { gen: 9 }));
  assert.equal(next.ctx.BriefAnnotate.list('s1').length, 1);
  assert.equal(posts(next).length, 0);
  click(next, '[data-ann-act="send"]');
  assert.equal(posts(next)[0].opts.body, body);
  reply(posts(next)[0], 200, { ok: true }); await flush();
});

test('regions: a newer generation requested while busy reloads on release even with no pending model', () => {
  const e = makeController({ generation: 8 });
  e.page.receive(model(1, session(), { gen: 8 }));
  e.page.open('s1', 'ov');
  e.selection.isCollapsed = false;
  e.selection.toString = () => 'held selection';
  e.selection.anchorNode = e.byId.main;
  e.page.receive(model(1, session(), { gen: 9 }));
  assert.equal(e.page.state.seq, 1, 'the model did not change');
  assert.equal(e.reloads.length, 0, 'busy holds the generation reload');
  e.selection.isCollapsed = true;
  e.selection.toString = () => '';
  e.document.listeners.selectionchange();
  e.advance(100);
  assert.equal(e.reloads.length, 1, 'release retries the generation reload');
});

test('fold expand: a model with nothing folded never loads or references folded history', () => {
  const { e, counter } = withFoldCounter({ protocol: 'file:', token: 'ignored' });
  const plain = session({ id: 'plain', alive: false, status: 'done', statusKey: 'done', tab: '끝남', headline: 'plain', lastActivityAt: 0 });
  e.page.receive(model(1, plain, { gen: 9 }));
  e.page.open('plain', 'rep');
  e.advance(600); e.page.receive(model(2, plain, { gen: 9 }));
  assert.equal(counter.inserted, 0, 'cumulative folded.js insertions are zero');
  assert.equal(foldedScripts(e).length, 0, 'no folded.js script node remains');
  assert.equal(e.page.state.full.size, 0, 'no full-card cache');
  assert.equal(e.fetches.length, 0, 'no folded history request');
});

test('decision and annotation sends share the same one-at-a-time POST queue', async () => {
  const e = makeController();
  prepare(e, session({ decisions: [{ id: 1, question: 'Which?', options: { A: { text: 'yes' } } }] }));
  click(e, '[data-act="ans-pick"]'); click(e, '[data-act="ans-send"]');
  click(e, '[data-ann-act="send"]');
  assert.equal(posts(e).length, 1);
  reply(posts(e)[0], 200, { ok: true }); await flush();
  assert.equal(posts(e).length, 2);
  assert.equal(JSON.parse(posts(e)[1].opts.body).kind, 'annotation');
  reply(posts(e)[1], 200, { ok: true }); await flush();
});

test('report pick uses the existing decision confirm and token-bearing answer transport', async () => {
  const e = makeController();
  const s = session({ decisions: [{ id: 1, question: 'Which?', options: { B: { text: 'second', consequence: 'result' } } }],
    reports: [{ id: 'r1', title: 'Report', decisionId: 1, images: [{ src: 'assets/' + 'a'.repeat(64) + '.png', option: 'B', alt: 'second', path: 'C:/project/second.png' }] }] });
  e.page.receive(model(1, s)); e.page.open('s1', 'rep');
  click(e, '[data-act="ans-pick"][data-dec="1"]');
  assert.equal(e.page.state.ui.active, 's1');
  assert.ok(e.byId.main.querySelector('.ans-confirm'));
  assert.equal(posts(e).length, 0);
  click(e, '[data-act="ans-send"]');
  assert.deepEqual(JSON.parse(posts(e)[0].opts.body), { id: 1, sessionId: 's1', option: 'B' });
  reply(posts(e)[0], 200, { ok: true }); await flush();
});

test('file mode and absent annotation capability offer copy before the owner starts composing', () => {
  for (const options of [{ protocol: 'file:', token: 'ignored' }, {}]) {
    const e = makeController(options);
    prepare(e, session({ answerKinds: options.protocol ? ['annotation'] : [] }));
    assert.equal(e.byId.main.querySelector('[data-ann-act="send"]'), null);
    assert.ok(e.byId.main.querySelector('[data-ann-act="copy"]'));
    assert.equal(posts(e).length, 0);
  }
});

test('new regions escape hostile model strings and tolerate absent capped fields', () => {
  const e = makeController();
  const evil = '<script>fake success</script><img src=x onerror=alert(1)>';
  const s = session({ title: evil, headline: evil, alive: undefined, briefSeq: undefined, todo: undefined, attachments: undefined, blockSources: undefined });
  e.page.receive(model(1, s)); e.page.open('s1', 'ov');
  assert.equal(e.app.querySelector('script'), null);
  assert.equal(e.app.querySelector('img'), null);
  assert.match(e.byId.main.innerHTML, /&lt;script&gt;/);
  assert.deepEqual(e.errors, []);
});

test('file-mode index written by the test contains no server token marker with all modules inlined', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-controller-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'index.html'), html = pageHtml(model(1), 9, { mode: 'file', token: 'not-for-file' });
  fs.writeFileSync(file, html);
  assert.equal(fs.readFileSync(file, 'utf8').includes('omo-board-token'), false);
  if (process.env.OMO_TASK7_FILE_PAGE) fs.copyFileSync(file, process.env.OMO_TASK7_FILE_PAGE);
});

test('fixture drift guard: real buildViewModel produces every board fixture key with the same type', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/view-model-board.json', import.meta.url), 'utf8'));
  const snapshot = { sessions: [], decisions: [], answers: [], receipts: [], closures: [], mirror: [], plans: [] };
  for (const s of fixture.sessions) {
    const auto = {
      work: { name: s.workName, phase: s.auto?.stage, done: s.auto?.todoDone, total: s.auto?.todoTotal },
      todo: { current: s.auto?.todoCurrent, next: s.auto?.todoNext, done: s.auto?.todoDone, total: s.auto?.todoTotal },
      workers: s.auto?.workers, live: s.live, todoItems: s.todo,
      ledgerPath: s.attachments.find(a => a.label === '실행 기록')?.path,
    };
    snapshot.sessions.push({
      sid: s.id, meta: { ...s, hostPid: s.alive ? 1 : null, running: s.chips.includes('작업 중'), pid: 1, auto },
      briefs: [{ seq: s.briefSeq, data: { at: s.lastBriefAt, brief: {
        title: s.title, status: s.status, headline: s.headline, changes: s.changes, done: s.done, next: s.next, flow: s.flow,
      } } }],
      reports: s.reports.map(r => ({ ...r, images: r.images.map(i => {
        const [, sha, ext] = /^assets\/([^.]+)\.(.+)$/.exec(i.src);
        return { ...i, sha, ext };
      }) })),
    });
    snapshot.decisions.push(...s.decisions);
    for (const d of s.decisions) {
      if (d.answer) snapshot.answers.push({ id: d.id, sessionId: s.id, ...d.answer });
      if (d.receipt) snapshot.receipts.push({ id: d.id, sessionId: s.id, ...d.receipt });
      if (d.closed) snapshot.closures.push({ id: d.id, reason: d.held ? 'held' : 'closed', questionPrompt: d.questionPrompt });
    }
    for (const n of s.notes) {
      snapshot.answers.push({ key: n.key, kind: 'annotation', sessionId: s.id, at: n.at, text: n.preview });
    }
    if (s.openQuestion) snapshot.mirror.push({ sid: s.id, data: { ...s.openQuestion, question: s.openQuestion.text } });
    if (s.plan) snapshot.plans.push({ planId: s.plan.planId,
      rev: { rev: s.plan.rev, at: s.plan.at, ownerSessionId: s.id, source: s.plan.source, plan: s.plan },
      status: { at: s.plan.checkedAt },
    });
  }
  const actual = buildViewModel(snapshot, fixture.generatedAt, { generation: fixture.gen, stateDir: 'C:/fixture/state',
    fold: false, // U1: this guard checks the full-row fixture; folded rows are covered by render.test.mjs's fold tests
    isAlive: pid => pid === 1, fs: { statSync(p) { if (p.includes('/senpi-task/tasks/')) return { isFile: () => true }; throw new Error('fixture evidence not on disk'); } } });
  function sameType(expected, got, at) {
    if (expected === null) { assert.equal(got, null, at); return; }
    if (Array.isArray(expected)) {
      assert.ok(Array.isArray(got), at + ' is an array');
      for (let i = 0; i < expected.length; i++) sameType(expected[i], got[i], at + '[' + i + ']');
    } else if (typeof expected === 'object') {
      assert.ok(got && typeof got === 'object', at + ' is an object');
      for (const [key, value] of Object.entries(expected)) {
        assert.ok(Object.hasOwn(got, key), at + '.' + key);
        sameType(value, got[key], at + '.' + key);
      }
    } else assert.equal(typeof got, typeof expected, at);
  }
  const { sessions: expectedSessions, ...expectedTop } = fixture;
  sameType(expectedTop, actual, 'vm');
  for (const s of expectedSessions) sameType(s, actual.sessions.find(a => a.id === s.id), 'sessions.' + s.id);
});

test('C-CAP2 integration: refresh without briefSeq keeps replacement rows visible and cannot inherit annotations', () => {
  const e = makeController();
  e.page.receive(model(1));
  e.page.open('s1', 'ov');
  assert.ok(e.byId.side.querySelector('[data-sec="tabs"]').querySelector('[data-row="s1"]'), 'alive card initially appears under open tabs');
  const A = e.ctx.BriefAnnotate;
  assert.equal(A.add('s1', note).ok, true);
  A.decorate();
  assert.equal(e.byId.main.querySelectorAll('mark.am').length, 1);
  const next = session({ alive: undefined, briefSeq: undefined });
  delete next.alive; delete next.briefSeq;
  e.advance(600); e.page.receive(model(2, next));
  const row = e.byId.main.querySelector('.row.chg');
  assert.ok(row, 'replacement row stays visible');
  assert.equal(row.hasAttribute('data-block'), false);
  assert.equal(row.querySelector('mark.am'), null);
  assert.equal(row.querySelector('.anum'), null);
  assert.equal(row.querySelector('[data-ann-act="block"]'), null);
  assert.match(row.textContent, /same row/);
  assert.match(row.textContent, /C:\/project\/evidence.txt/);
  assert.equal(e.byId.main.querySelector('.row.done').hasAttribute('data-block'), false);
  assert.equal(A.list('s1')[0].gone, true);
  assert.equal(A.list('s1')[0].blocks[0], 'change/1/0');
  assert.equal(e.byId.side.querySelector('[data-sec="tabs"]').querySelector('[data-row="s1"]'), null, 'without alive, the card leaves the open-tabs group');
  assert.deepEqual(e.errors, []);
});

test('C-ASK integration: askLive and builtin notes render for true, absent flags mean false', () => {
  const e = makeController();
  const dec = { id: 1, question: 'Which?', options: { A: { text: 'yes' }, B: { text: 'no' } }, askLive: true };
  const s = session({ decisions: [dec], openQuestion: { text: 'native', builtin: true } });
  e.page.receive(model(1, s)); e.page.open('s1', 'ov');
  assert.match(e.byId.main.textContent, /터미널에도 같은 질문이 열려 있어요 - 어느 쪽에서 답해도 둘 다 닫혀요/);
  assert.match(e.byId.main.textContent, /터미널에서 답하세요 - 이 질문은 하네스 기본 질문창이라 상황판에서 닫을 수 없어요/);
  delete dec.askLive; delete s.openQuestion.builtin;
  e.advance(600); e.page.receive(model(2, s));
  assert.doesNotMatch(e.byId.main.textContent, /터미널에도 같은 질문|하네스 기본 질문창/);
  assert.match(e.byId.main.textContent, /native/);
  assert.deepEqual(e.errors, []);
});

const FOLD_KEY = 'a'.repeat(20);
const foldedRow = (patch = {}) => ({
  id: 'f1', title: 'Folded talk', alive: false, status: 'done', statusKey: 'done', tab: '끝남',
  headline: 'old headline', lastActivityAt: 0, briefSeq: 2,
  decisions: [{ id: 7, question: 'BASE QUESTION', options: { A: { text: 'yes' } }, answered: false, closed: false }],
  notes: [{ key: 'base-note', at: 1, preview: 'BASE NOTE' }],
  folded: { reports: 3, decisions: 1, key: FOLD_KEY },
  ...patch,
});
const fullCard = (patch = {}) => ({
  id: 'f1', title: 'Folded talk', alive: false, status: 'done', statusKey: 'done', tab: '끝남',
  headline: 'full headline', lastActivityAt: 1, briefSeq: 2,
  reports: [{ id: 'r1', title: 'Report one' }, { id: 'r2', title: 'Report two' }, { id: 'r3', title: 'Report three' }],
  changes: [{ text: 'full change', truth: 'reported', applied: 'none' }], done: [],
  notes: [{ key: 'server-note', at: 2, preview: 'SERVER NOTE' }],
  decisions: [{ id: 8, question: 'SERVER QUESTION', options: { A: { text: 'yes' } }, answered: false, closed: false }],
  answerKinds: ['annotation'],
  ...patch,
});
const convoCalls = e => e.fetches.filter(f => /^\/convo\//.test(f.url));
const sendConvo = (request, status, body) => request.resolve({ status, json: async () => body });
const flushTwice = async () => { await flush(); await flush(); };
const foldedScripts = e => e.document.head.querySelectorAll('script').map(s => s.src).filter(src => /(?:^|\/)folded\.js(?:\?|$)/.test(src));
const foldedScriptNodes = e => e.document.head.querySelectorAll('script').filter(s => /(?:^|\/)folded\.js(?:\?|$)/.test(s.src || ''));
function withFoldCounter(options = {}) {
  const counter = { inserted: 0 };
  const configure = options.configure;
  const e = makeController(Object.assign({}, options, { configure(ctx, rendered) {
    if (configure) configure(ctx, rendered);
    const head = ctx.document.head, add = head.appendChild.bind(head);
    head.appendChild = function (node) {
      if (node && typeof node.src === 'string' && /(?:^|\/)folded\.js(?:\?|$)/.test(node.src)) counter.inserted++;
      return add(node);
    };
  } }));
  return { e, counter };
}

test('fold expand: opening a folded conversation fetches its card once and renders all its reports', async () => {
  const e = makeController();
  e.page.receive(model(1, foldedRow(), { gen: 9 }));
  e.page.open('f1', 'rep');
  e.page.open('f1', 'rep');
  assert.match(e.byId.main.textContent, /전체 기록 불러오는 중…/);
  assert.equal(convoCalls(e).length, 1, 'one in-flight request for the same (sid, key)');
  assert.equal(convoCalls(e)[0].url, '/convo/f1.json');
  assert.equal(convoCalls(e)[0].opts.cache, 'no-store');
  sendConvo(convoCalls(e)[0], 200, { schema: 1, gen: 9, key: FOLD_KEY, session: fullCard() });
  await flushTwice();
  assert.equal(e.byId.main.querySelectorAll('.rep').length, 3);
  assert.match(e.byId.main.textContent, /Report three/);
  assert.deepEqual(e.errors, []);
});

test('fold expand: three live frames with an unchanged key make no request and leave #main untouched', async () => {
  const e = makeController();
  const row = foldedRow();
  e.page.receive(model(1, row, { gen: 9 })); e.page.open('f1', 'rep');
  sendConvo(convoCalls(e)[0], 200, { schema: 1, gen: 9, key: FOLD_KEY, session: fullCard() });
  await flushTwice();
  const main = e.byId.main, html = main.innerHTML, writes = main.writes;
  for (let seq = 2; seq <= 4; seq++) {
    e.advance(600);
    e.page.receive(model(seq, row, { gen: 9 }));
  }
  assert.equal(convoCalls(e).length, 1, 'the unchanged key never refetches');
  assert.equal(main.writes, writes, '#main is not rewritten');
  assert.equal(main.innerHTML, html);
  assert.deepEqual(e.errors, []);
});

test('fold expand: a changed key refetches the active conversation and a stale reply is discarded', async () => {
  const e = makeController();
  const firstKey = 'a'.repeat(20), secondKey = 'b'.repeat(20);
  e.page.receive(model(1, foldedRow(), { gen: 9 })); e.page.open('f1', 'rep');
  const stale = convoCalls(e)[0];
  e.advance(600);
  e.page.receive(model(2, foldedRow({ folded: { reports: 2, decisions: 1, key: secondKey } }), { gen: 9 }));
  assert.equal(convoCalls(e).length, 2, 'the new key starts its own request');
  const fresh = convoCalls(e)[1];
  sendConvo(stale, 200, { schema: 1, gen: 9, key: firstKey, session: fullCard({ title: 'STALE REPLY' }) });
  await flushTwice();
  assert.doesNotMatch(e.byId.main.textContent, /STALE REPLY/);
  assert.match(e.byId.main.textContent, /전체 기록 불러오는 중…/);
  sendConvo(fresh, 200, { schema: 1, gen: 9, key: secondKey, session: fullCard({
    title: 'FRESH', reports: [{ id: 'r1', title: 'Report one' }, { id: 'r2', title: 'Report two' }],
  }) });
  await flushTwice();
  assert.equal(e.byId.main.querySelectorAll('.rep').length, 2);
  assert.match(e.byId.main.textContent, /Report two/);
  assert.deepEqual(e.errors, []);
});

test('fold expand: file mode inserts folded.js once per key and makes no fetch or POST', async () => {
  const { e, counter } = withFoldCounter({ protocol: 'file:', token: 'ignored' });
  const row = foldedRow();
  e.page.receive(model(1, row, { gen: 9, foldedKey: 'agg-1' }));
  e.page.open('f1', 'rep');
  assert.equal(foldedScripts(e).length, 1);
  assert.equal(foldedScripts(e)[0], 'folded.js?v=agg-1');
  e.ctx.__briefFolded({ schema: 2, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  e.ctx.__briefFolded({ schema: 1, gen: 8, key: 'agg-1', sessions: { f1: fullCard() } });
  e.ctx.__briefFolded({ schema: 1, gen: 9, key: 'other', sessions: { f1: fullCard() } });
  assert.equal(e.byId.main.querySelectorAll('.rep').length, 0, 'schema, generation and key are validated');
  const firstScript = foldedScriptNodes(e)[0];
  e.ctx.__briefFolded({ schema: 1, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  e.fire(firstScript, 'load');
  assert.equal(e.byId.main.querySelectorAll('.rep').length, 3);
  e.advance(600); e.page.receive(model(2, row, { gen: 9, foldedKey: 'agg-1' })); e.page.open('f1', 'rep');
  assert.equal(counter.inserted, 1, 'one script insertion per folded key');
  assert.equal(counter.inserted, 1, 'cumulative insertions stay at one');
  assert.equal(e.fetches.length, 0, 'no fetch in file mode');
  assert.equal(posts(e).length, 0, 'no POST in file mode');
  assert.deepEqual(e.errors, []);
});

test('fold expand: a completed stale file payload clears its flight and exposes retry', () => {
  const { e, counter } = withFoldCounter({ protocol: 'file:', token: 'ignored' });
  e.page.receive(model(1, foldedRow(), { gen: 9, foldedKey: 'agg-1' }));
  e.page.open('f1', 'rep');
  assert.equal(counter.inserted, 1);
  const first = foldedScriptNodes(e)[0];
  e.ctx.__briefFolded({ schema: 2, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  e.fire(first, 'load');
  assert.match(e.byId.main.textContent, /전체 기록 다시 불러오기/);
  assert.doesNotMatch(e.byId.main.textContent, /전체 기록 불러오는 중…/);
  assert.equal(e.page.state.fullFlight['file|agg-1'], undefined, 'the completed load cleared its flight');
  assert.equal(e.page.state.foldedFor, null, 'no success marker for a rejected payload');
  assert.equal(foldedScripts(e).length, 0, 'the completed script is removed');
  click(e, '[data-act="fold-retry"]');
  assert.equal(counter.inserted, 2, 'retry starts a fresh script insertion');
  const second = foldedScriptNodes(e)[0];
  e.ctx.__briefFolded({ schema: 1, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  e.fire(second, 'load');
  assert.equal(e.byId.main.querySelectorAll('.rep').length, 3);
  assert.deepEqual(e.errors, []);
});

test('fold expand: known HTTP, payload and network causes stay finite and retry recovers', async () => {
  const e = makeController();
  e.page.receive(model(1, foldedRow(), { gen: 9 }));
  e.page.open('f1', 'rep');
  const main = e.byId.main;
  const cause = () => {
    const fold = main.querySelector('.cv-fold');
    return fold ? fold.getAttribute('data-cause') : null;
  };
  const code = () => {
    const fold = main.querySelector('.cv-fold');
    return fold ? fold.getAttribute('data-code') : null;
  };
  assert.equal(cause(), null, 'loading has no error cause');
  sendConvo(convoCalls(e)[0], 500, {});
  await flushTwice();
  assert.equal(cause(), 'http');
  assert.equal(code(), '500');
  assert.ok(main.querySelector('.cv-fold-note').textContent.length > 0, 'visible explanation');
  click(e, '[data-act="fold-retry"]');
  convoCalls(e)[1].resolve({ status: 200, json: async () => { throw new Error('bad json'); } });
  await flushTwice();
  assert.equal(cause(), 'payload');
  click(e, '[data-act="fold-retry"]');
  sendConvo(convoCalls(e)[2], 200, { schema: 1, gen: 9, key: 'wrong-key', session: fullCard() });
  await flushTwice();
  assert.equal(cause(), 'payload');
  click(e, '[data-act="fold-retry"]');
  convoCalls(e)[3].reject(new Error('network down'));
  await flushTwice();
  assert.equal(cause(), 'network');
  assert.ok(e.errors.some((x) => /convo load/.test(String((x && x.message) || x))), 'network rejection is logged, not swallowed');
  click(e, '[data-act="fold-retry"]');
  sendConvo(convoCalls(e)[4], 200, { schema: 1, gen: 9, key: FOLD_KEY, session: fullCard() });
  await flushTwice();
  assert.equal(main.querySelector('.cv-fold'), null);
  assert.equal(main.querySelectorAll('.rep').length, 3);
});

test('fold expand: file load, payload and missing causes stay finite and retry loads the restored script', async () => {
  const { e, counter } = withFoldCounter({ protocol: 'file:', token: 'ignored' });
  const row = foldedRow();
  e.page.receive(model(1, row, { gen: 9, foldedKey: 'agg-1' }));
  e.page.open('f1', 'rep');
  const main = e.byId.main;
  const cause = () => {
    const fold = main.querySelector('.cv-fold');
    return fold ? fold.getAttribute('data-cause') : null;
  };
  const first = foldedScriptNodes(e)[0];
  e.fire(first, 'error');
  assert.equal(cause(), 'file-load');
  assert.ok(main.querySelector('[data-act="fold-retry"]'), 'file-load retry');
  click(e, '[data-act="fold-retry"]');
  assert.equal(counter.inserted, 2, 'retry requests a fresh script');
  e.ctx.__briefFolded({ schema: 2, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  e.fire(foldedScriptNodes(e)[0], 'load');
  assert.equal(cause(), 'missing');
  click(e, '[data-act="fold-retry"]');
  assert.equal(counter.inserted, 3);
  e.ctx.__briefFolded({ schema: 1, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  e.fire(foldedScriptNodes(e)[0], 'load');
  assert.equal(main.querySelector('.cv-fold'), null);
  assert.equal(main.querySelectorAll('.rep').length, 3);

  const missing = makeController({ protocol: 'file:' });
  missing.page.receive(model(1, foldedRow(), { gen: 9 }));
  missing.page.open('f1', 'rep');
  const missingFold = missing.byId.main.querySelector('.cv-fold');
  assert.equal(missingFold && missingFold.getAttribute('data-cause'), 'unready');
  assert.ok(missing.byId.main.querySelector('[data-act="fold-retry"]'), 'file-missing retry');
});

test('fold expand: an unfolded frame followed by the same folded key reloads its pruned history', () => {
  const { e, counter } = withFoldCounter({ protocol: 'file:', token: 'ignored' });
  const folded = foldedRow();
  e.page.receive(model(1, folded, { gen: 9, foldedKey: 'agg-1' }));
  e.page.open('f1', 'rep');
  let script = foldedScriptNodes(e)[0];
  e.ctx.__briefFolded({ schema: 1, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  e.fire(script, 'load');
  assert.equal(e.byId.main.querySelectorAll('.rep').length, 3);
  assert.equal(counter.inserted, 1);
  const unfolded = Object.assign({}, folded);
  delete unfolded.folded; delete unfolded.chips;
  e.advance(600); e.page.receive(model(2, unfolded, { gen: 9 }));
  assert.equal(e.page.state.full.size, 0, 'the unfolded frame prunes the cached card');
  e.advance(600); e.page.receive(model(3, folded, { gen: 9, foldedKey: 'agg-1' }));
  e.page.open('f1', 'rep');
  assert.equal(counter.inserted, 2, 'the same key reloads after its usable card was pruned');
  script = foldedScriptNodes(e)[0];
  e.ctx.__briefFolded({ schema: 1, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  e.fire(script, 'load');
  assert.equal(e.byId.main.querySelectorAll('.rep').length, 3);
  e.advance(600); e.page.receive(model(4, folded, { gen: 9, foldedKey: 'agg-1' }));
  assert.equal(counter.inserted, 2, 'an unchanged key with its card does not load again');
  assert.deepEqual(e.errors, []);
});

test('fold expand: a failed load shows 전체 기록 다시 불러오기, never 보고서 0', async () => {
  const e = makeController();
  e.page.receive(model(1, foldedRow(), { gen: 9 })); e.page.open('f1', 'rep');
  const main = e.byId.main;
  sendConvo(convoCalls(e)[0], 500, {});
  await flushTwice();
  assert.match(main.textContent, /전체 기록 다시 불러오기/);
  assert.doesNotMatch(main.textContent, /보고서 0/);
  click(e, '[data-act="fold-retry"]');
  assert.equal(convoCalls(e).length, 2);
  sendConvo(convoCalls(e)[1], 200, { schema: 1, gen: 9, key: FOLD_KEY, session: fullCard() });
  await flushTwice();
  assert.equal(main.querySelectorAll('.rep').length, 3);
  assert.deepEqual(e.errors, []);
});

test('fold expand: a 404 shows the restart hint', async () => {
  const e = makeController();
  e.page.receive(model(1, foldedRow(), { gen: 9 })); e.page.open('f1', 'rep');
  sendConvo(convoCalls(e)[0], 404, {});
  await flushTwice();
  assert.ok(e.byId.main.textContent.includes('이 상황판 서버는 접은 대화 펼치기를 모르는 이전 세대입니다. 대화를 재시작하면 최신 상황판이 열립니다.'));
  assert.equal(e.byId.main.querySelector('[data-act="fold-retry"]'), null);
  assert.deepEqual(e.errors, []);
});

test('fold expand: server causes are named next to the panel and retry recovers', async () => {
  const cases = [
    {
      name: 'HTTP 500',
      cause: /서버 응답 오류 \(500\)/,
      stateCause: 'http',
      stateCode: '500',
      send: (e) => sendConvo(convoCalls(e)[0], 500, {}),
    },
    {
      name: 'bad JSON',
      cause: /서버 응답 형식 오류/,
      stateCause: 'payload',
      send: (e) => convoCalls(e)[0].resolve({ status: 200, json: async () => { throw new Error('bad json'); } }),
    },
    {
      name: 'contract mismatch',
      cause: /서버 응답 형식 오류/,
      stateCause: 'payload',
      send: (e) => sendConvo(convoCalls(e)[0], 200, { schema: 2, gen: 9, key: FOLD_KEY, session: fullCard() }),
    },
    {
      name: 'network reject',
      cause: /서버 연결 오류/,
      stateCause: 'network',
      send: (e) => convoCalls(e)[0].reject(new Error('ECONNREFUSED secret stack at 127.0.0.1')),
      noLeak: true,
    },
  ];
  for (const item of cases) {
    const e = makeController();
    e.page.receive(model(1, foldedRow(), { gen: 9 })); e.page.open('f1', 'rep');
    item.send(e);
    await flushTwice();
    const panel = e.byId.main.querySelector('.cv-fold');
    assert.ok(panel, item.name + ': error panel');
    assert.equal(panel.getAttribute('data-fold'), 'error', item.name + ': panel state');
    assert.equal(panel.getAttribute('data-cause'), item.stateCause, item.name + ': finite cause');
    assert.equal(panel.getAttribute('data-code'), item.stateCode || null, item.name + ': HTTP code only for HTTP');
    assert.match(e.byId.main.textContent, item.cause, item.name + ': known cause');
    assert.match(e.byId.main.textContent, /전체 기록 다시 불러오기/, item.name + ': retry');
    if (item.noLeak) assert.doesNotMatch(e.byId.main.textContent, /ECONNREFUSED|secret|127\.0\.0\.1|stack/i, item.name + ': no raw error leak');
    const before = convoCalls(e).length;
    click(e, '[data-act="fold-retry"]');
    assert.equal(convoCalls(e).length, before + 1, item.name + ': retry request');
    sendConvo(convoCalls(e)[convoCalls(e).length - 1], 200, { schema: 1, gen: 9, key: FOLD_KEY, session: fullCard() });
    await flushTwice();
    assert.equal(e.byId.main.querySelectorAll('.rep').length, 3, item.name + ': recovered reports');
    assert.equal(e.byId.main.querySelector('.cv-fold'), null, item.name + ': panel gone');
  }
});

test('fold expand: file causes are named and retry recovers', () => {
  const { e, counter } = withFoldCounter({ protocol: 'file:', token: 'ignored' });
  e.page.receive(model(1, foldedRow(), { gen: 9, foldedKey: 'agg-1' }));
  e.page.open('f1', 'rep');
  const first = foldedScriptNodes(e)[0];
  e.fire(first, 'error');
  assert.equal(e.byId.main.querySelector('.cv-fold').getAttribute('data-fold'), 'error');
  assert.equal(e.byId.main.querySelector('.cv-fold').getAttribute('data-cause'), 'file-load');
  assert.match(e.byId.main.textContent, /접힌 기록 파일 오류/);
  assert.match(e.byId.main.textContent, /전체 기록 다시 불러오기/);
  click(e, '[data-act="fold-retry"]');
  assert.equal(counter.inserted, 2, 'retry re-inserts the file');
  const second = foldedScriptNodes(e)[0];
  e.ctx.__briefFolded({ schema: 1, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  e.fire(second, 'load');
  assert.equal(e.byId.main.querySelectorAll('.rep').length, 3, 'file retry recovers the full record');

  const missing = withFoldCounter({ protocol: 'file:', token: 'ignored' });
  missing.e.page.receive(model(1, foldedRow(), { gen: 9, foldedKey: 'agg-1' }));
  missing.e.page.open('f1', 'rep');
  missing.e.fire(foldedScriptNodes(missing.e)[0], 'load');
  assert.equal(missing.e.byId.main.querySelector('.cv-fold').getAttribute('data-cause'), 'missing');
  assert.match(missing.e.byId.main.textContent, /접힌 기록에 이 대화가 없어요/);

  const unready = withFoldCounter({ protocol: 'file:', token: 'ignored' });
  unready.e.page.receive(model(1, foldedRow(), { gen: 9 }));
  unready.e.page.open('f1', 'rep');
  assert.equal(unready.e.byId.main.querySelector('.cv-fold').getAttribute('data-cause'), 'unready');
  assert.match(unready.e.byId.main.textContent, /아직 준비되지 않았어요/);
  unready.e.page.receive(model(2, foldedRow(), { gen: 9, foldedKey: 'agg-1' }));
  unready.e.advance(600);
  click(unready.e, '[data-act="fold-retry"]');
  assert.equal(unready.counter.inserted, 1, 'a retry starts once the file key exists');
  unready.e.ctx.__briefFolded({ schema: 1, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  unready.e.fire(foldedScriptNodes(unready.e)[0], 'load');
  assert.equal(unready.e.byId.main.querySelectorAll('.rep').length, 3, 'unready retry recovers');
});

test('fold expand: file retry uses a fresh safe numeric cache-buster', () => {
  const { e, counter } = withFoldCounter({ protocol: 'file:', token: 'ignored' });
  e.page.receive(model(1, foldedRow(), { gen: 9, foldedKey: 'agg-1' }));
  e.page.open('f1', 'rep');
  assert.equal(foldedScripts(e)[0], 'folded.js?v=agg-1', 'the first load has no retry suffix');
  e.fire(foldedScriptNodes(e)[0], 'error');
  click(e, '[data-act="fold-retry"]');
  assert.equal(counter.inserted, 2, 'one fresh script for the first retry');
  const retry1 = foldedScripts(e)[0];
  assert.equal(retry1, 'folded.js?v=agg-1&r=1', 'the retry cache-buster is numeric');
  assert.match(retry1, /^folded\.js\?v=[A-Za-z0-9._~-]+&r=[1-9]\d*$/, 'the retry query is a safe key + positive integer');
  e.fire(foldedScriptNodes(e)[0], 'error');
  click(e, '[data-act="fold-retry"]');
  assert.equal(counter.inserted, 3, 'a second retry is another fresh script');
  assert.equal(foldedScripts(e)[0], 'folded.js?v=agg-1&r=2', 'the counter increments monotonically');
  e.ctx.__briefFolded({ schema: 1, gen: 9, key: 'agg-1', sessions: { f1: fullCard() } });
  e.fire(foldedScriptNodes(e)[0], 'load');
  assert.equal(e.byId.main.querySelectorAll('.rep').length, 3, 'the retried script recovers the full record');
  assert.deepEqual(e.errors, []);

  const unsafe = withFoldCounter({ protocol: 'file:', token: 'ignored' });
  unsafe.e.page.receive(model(1, foldedRow(), { gen: 9, foldedKey: 'agg 1&x' }));
  unsafe.e.page.open('f1', 'rep');
  assert.equal(foldedScripts(unsafe.e)[0], 'folded.js?v=agg%201%26x', 'the aggregate file key is URL-encoded, not concatenated raw');
  unsafe.e.fire(foldedScriptNodes(unsafe.e)[0], 'error');
  click(unsafe.e, '[data-act="fold-retry"]');
  assert.equal(foldedScripts(unsafe.e)[0], 'folded.js?v=agg%201%26x&r=1', 'the numeric suffix cannot be injected by the key');
});

test('fold expand: decisions and notes come from the base row after hydration', async () => {
  const e = makeController();
  e.page.receive(model(1, foldedRow(), { gen: 9 })); e.page.open('f1', 'ov');
  sendConvo(convoCalls(e)[0], 200, { schema: 1, gen: 9, key: FOLD_KEY, session: fullCard() });
  await flushTwice();
  const main = e.byId.main;
  e.page.open('f1', 'rep');
  assert.equal(main.querySelectorAll('.rep').length, 3, 'the full report history is rendered');
  e.page.open('f1', 'ov');
  assert.match(main.textContent, /BASE QUESTION/);
  assert.match(main.textContent, /BASE NOTE/);
  assert.doesNotMatch(main.textContent, /SERVER QUESTION/);
  assert.doesNotMatch(main.textContent, /SERVER NOTE/);
  assert.deepEqual(e.errors, []);
});

test('fold render: overview, convo view, sidebar, search and inbox render a model with folded rows without a thrown error', () => {
  const e = makeController();
  const folded = foldedRow();
  e.page.receive({ seq: 1, generatedAt: 0, gen: 9, foldedKey: 'agg-1', sessions: [session(), folded] });
  assert.match(e.byId.main.textContent, /Folded talk/);
  e.page.open('f1', 'ov');
  assert.match(e.byId.main.textContent, /전체 기록 불러오는 중…/);
  for (const key of ['inbox', 'plans', 'home', 'archive', 'settings', 'conv']) {
    click(e, `#rail [data-sh="view"][data-key="${key}"]`);
  }
  const input = e.app.querySelector('[data-sh="search"]');
  input.value = 'Folded'; e.fire(input, 'input');
  click(e, '#rail [data-sh="view"][data-key="inbox"]');
  assert.deepEqual(e.errors, []);
});

test('fold retry focus: loading and recovery keep a non-approval panel anchor', async () => {
  const e = makeController();
  e.page.receive(model(1, foldedRow(), { gen: 9 })); e.page.open('f1', 'rep');
  sendConvo(convoCalls(e)[0], 500, {});
  await flushTwice();
  const retry = e.byId.main.querySelector('[data-act="fold-retry"]');
  retry.focus();
  click(e, '[data-act="fold-retry"]');
  const loading = e.byId.main.querySelector('.cv-panel[data-fold-focus]');
  assert.ok(loading, 'folded conversation has a persistent panel anchor');
  assert.equal(e.document.activeElement, loading, 'retry hands focus to the loading panel');
  assert.equal(loading.getAttribute('tabindex'), '-1', 'anchor does not enter the natural Tab order');
  assert.equal(loading.querySelector('.cv-fold').getAttribute('data-fold'), 'loading');
  sendConvo(convoCalls(e).at(-1), 200, { schema: 1, gen: 9, key: FOLD_KEY, session: fullCard() });
  await flushTwice();
  const recovered = e.byId.main.querySelector('.cv-panel[data-fold-focus]');
  assert.equal(e.document.activeElement, recovered, 'recovery restores the same logical panel identity');
  assert.equal(recovered.querySelectorAll('.rep').length, 3);
  assert.equal(recovered.querySelector('.cv-fold'), null);
  assert.deepEqual(e.errors, []);
});

test('fold retry focus: pending recovery does not take focus back after the user leaves', async () => {
  const e = makeController();
  e.page.receive({ ...model(1, foldedRow(), { gen: 9 }), sessions: [foldedRow(), session()] });
  e.page.open('f1', 'rep');
  sendConvo(convoCalls(e)[0], 500, {});
  await flushTwice();
  e.byId.main.querySelector('[data-act="fold-retry"]').focus();
  click(e, '[data-act="fold-retry"]');
  const outside = e.byId.rail.querySelector('button');
  outside.focus();
  sendConvo(convoCalls(e).at(-1), 200, { schema: 1, gen: 9, key: FOLD_KEY, session: fullCard() });
  await flushTwice();
  assert.equal(e.document.activeElement, outside, 'an explicit focus move remains authoritative');
  e.page.open('s1', 'ov');
  assert.equal(e.page.state.ui.active, 's1');
  assert.equal(e.byId.main.querySelector('.cv-page').getAttribute('data-sid'), 's1');
  assert.deepEqual(e.errors, []);
});

test('fold retry focus: a completed request cannot reopen the conversation the user left', async () => {
  const e = makeController();
  e.page.receive({ ...model(1, foldedRow(), { gen: 9 }), sessions: [foldedRow(), session()] });
  e.page.open('f1', 'rep');
  sendConvo(convoCalls(e)[0], 500, {});
  await flushTwice();
  e.byId.main.querySelector('[data-act="fold-retry"]').focus();
  click(e, '[data-act="fold-retry"]');
  e.page.open('s1', 'ov');
  const outside = e.byId.rail.querySelector('button');
  outside.focus();
  const content = e.byId.main.innerHTML;
  sendConvo(convoCalls(e).at(-1), 200, { schema: 1, gen: 9, key: FOLD_KEY, session: fullCard() });
  await flushTwice();
  assert.equal(e.page.state.ui.active, 's1');
  assert.equal(e.byId.main.innerHTML, content);
  assert.equal(e.document.activeElement, outside);
  assert.deepEqual(e.errors, []);
});
