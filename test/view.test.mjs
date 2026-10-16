import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW_SRC = fs.readFileSync(path.join(ROOT, 'src/page/view.js'), 'utf8');
const PAGE_SRC = fs.readFileSync(path.join(ROOT, 'src/page/page.js'), 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/view-model.json'), 'utf8'));

function loadView() {
  const ctx = {};
  vm.runInNewContext(VIEW_SRC, ctx, { filename: 'view.js' });
  assert.equal(typeof ctx.BriefView?.renderApp, 'function');
  return ctx.BriefView;
}
const clone = (v) => JSON.parse(JSON.stringify(v));
const count = (s, re) => (s.match(re) || []).length;

// split rendered html into per-card chunks keyed by data-card id
function cards(html) {
  const out = {};
  const parts = html.split('<article ').slice(1);
  for (const p of parts) {
    const m = /data-card="([^"]*)"/.exec(p);
    if (m) out[m[1]] = p.split('</article>')[0];
  }
  return out;
}
function expandAll(model) {
  const expanded = {};
  for (const s of model.sessions) {
    expanded['more-ch:' + s.id] = true;
    expanded['more-dc:' + s.id] = true;
    expanded['detail:' + s.id] = true;
  }
  return expanded;
}
const allTabs = ['wait', 'run', 'done'];
function renderAllTabs(view, model, extra = {}) {
  return allTabs.map((tab) => view.renderApp(model, { tab, ...extra })).join('\n');
}

test('fixture has the shape todo 7 relies on', () => {
  const s = FIXTURE.sessions;
  assert.equal(s.length, 6);
  assert.equal(new Set(s.map((x) => x.project)).size, 3);
  const open = s.flatMap((x) => x.decisions).filter((d) => !d.answered && !d.closed);
  assert.equal(open.length, 5);
  assert.ok(s.some((x) => x.changes.length === 5));
  assert.equal(s.filter((x) => x.openQuestion).length, 1);
  assert.equal(s.filter((x) => x.chips.includes('오래됨')).length, 1);
  assert.equal(s.filter((x) => x.chips.includes('보고 없음')).length, 1);
});

test('cards cap change rows at 3 and decision cards at 2 with matching "외 n개"', () => {
  const view = loadView();
  const html = renderAllTabs(view, FIXTURE);
  const byId = cards(html);
  assert.equal(Object.keys(byId).length, 6);
  for (const s of FIXTURE.sessions) {
    const c = byId[s.id];
    assert.ok(c, 'card for ' + s.id);
    const chg = count(c, /class="row chg/g);
    const dc = count(c, /class="dcard/g);
    const openDec = s.decisions.filter((d) => !d.answered && !d.closed).length;
    assert.equal(chg, Math.min(3, s.changes.length), s.id + ' change rows');
    assert.equal(dc, Math.min(2, openDec), s.id + ' decision cards');
    if (s.changes.length > 3) assert.ok(c.includes('외 ' + (s.changes.length - 3) + '개'), 'more changes ' + s.id);
    if (openDec > 2) assert.ok(c.includes('외 ' + (openDec - 2) + '개'), 'more decisions ' + s.id);
  }
  // expanding shows everything
  const full = cards(renderAllTabs(view, FIXTURE, { expanded: expandAll(FIXTURE) }));
  for (const s of FIXTURE.sessions) {
    assert.equal(count(full[s.id], /class="row chg/g), s.changes.length);
  }
});

test('left sidebar holds exactly 3 tabs and main has no top button row', () => {
  const view = loadView();
  const html = view.renderApp(FIXTURE, {});
  const nav = html.slice(html.indexOf('<nav class="toc"'), html.indexOf('</nav>'));
  assert.ok(nav.length > 0);
  assert.equal(count(nav, /role="tab"/g), 3);
  for (const label of ['나를 기다림', '진행 중', '끝남']) assert.ok(nav.includes(label));
  assert.equal(count(html, /role="tab"/g), 3);
  const mainStart = html.indexOf('<main');
  const firstSection = html.indexOf('<section', mainStart);
  assert.ok(mainStart >= 0 && firstSection > mainStart);
  assert.ok(!html.slice(mainStart, firstSection).includes('<button'), 'no buttons above the first section');
  assert.ok(!/toolbar|topbar|btn-row/.test(html));
});

test('top summary line and gray note', () => {
  const view = loadView();
  const html = view.renderApp(FIXTURE, {});
  assert.match(html, /결정 대기 5 · 막힘 1 · 오래됨 1 · ⏱ 마지막 갱신 \d\d:\d\d/);
  assert.ok(html.includes('브리핑이 켜진 대화 6개만 보입니다 - 설치 전부터 열려 있던 대화는 새로 열어야 나타납니다'));
});

test('decision card has 8 logical lines and a /decide copy value', () => {
  const view = loadView();
  const html = view.renderApp(FIXTURE, { tab: 'wait' });
  const start = html.indexOf('data-decision="12"');
  assert.ok(start > 0, 'decision 12 rendered');
  const card = html.slice(start, html.indexOf('</div><!--dcard-->', start));
  assert.equal(count(card, /class="dline/g), 8);
  assert.ok(card.includes('#12 '));
  assert.ok(card.includes('[결정 기록기]'));
  assert.ok(card.includes('추천: A - '));
  assert.ok(card.includes('만든 대화: '));
  assert.ok(card.includes('⏱'));
  assert.ok(card.includes('data-copy="/decide 12A"'));
  assert.ok(card.includes('답: /decide 12A'));
});

test('every change and done row carries one truth chip and one applied chip', () => {
  const view = loadView();
  const html = renderAllTabs(view, FIXTURE, { expanded: expandAll(FIXTURE) });
  const rows = html.split(/(?=<li class="row )/).slice(1).map((r) => r.split('</li>')[0]);
  const expected = FIXTURE.sessions.reduce((n, s) => n + s.changes.length + s.done.length, 0);
  assert.equal(rows.length, expected);
  const truthRe = /class="chip t-[a-z]+"/g;
  const appliedRe = /class="chip a-(candidate|live|none)">(후보|실사용 적용|적용 해당 없음)</g;
  for (const r of rows) {
    assert.equal(count(r, truthRe), 1, 'truth chip: ' + r);
    assert.equal(count(r, appliedRe), 1, 'applied chip: ' + r);
  }
  for (const label of ['증거 있음', '보고만 됨', '미확인', '후보', '실사용 적용', '적용 해당 없음']) {
    assert.ok(html.includes(label), label);
  }
});

test('forbidden strings never appear', () => {
  const view = loadView();
  const html = renderAllTabs(view, FIXTURE, { expanded: expandAll(FIXTURE), legendOpen: true });
  for (const bad of ['검증됨', '%', 'http']) assert.ok(!html.includes(bad), bad);
});

test('injected markup in fixture text is escaped', () => {
  const view = loadView();
  const m = clone(FIXTURE);
  const s = m.sessions[0];
  s.headline = '<script>alert(1)</script>';
  s.title = '"><img src=x onerror=alert(2)>';
  s.workName = '</span><b>x</b>';
  s.changes[0].text = '<iframe src=x></iframe>';
  s.changes[0].evidence = 'C:/x/"onmouseover="alert(3).txt';
  s.decisions[0].question = '<svg onload=alert(4)>';
  const html = renderAllTabs(view, m, { expanded: expandAll(m) });
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('<b>x</b>'));
  assert.ok(!html.includes('<svg onload'));
  assert.ok(!html.includes('"onmouseover="'));
});

test('empty model shows "아직 보고 없음" and read-failure chip shows', () => {
  const view = loadView();
  const empty = view.renderApp({ seq: 1, generatedAt: Date.now(), sessions: [] }, {});
  assert.ok(empty.includes('아직 보고 없음'));
  const m = { seq: 2, generatedAt: Date.now(), sessions: [{ id: 'r1', project: 'p', title: 't', chips: ['기록 읽기 실패'], status: 'in_progress', tab: '진행 중' }] };
  const html = view.renderApp(m, { tab: 'run' });
  assert.ok(html.includes('기록 읽기 실패'));
});

test('오류 있음 chip renders on the card and the legend explains it', () => {
  const view = loadView();
  const m = { seq: 2, generatedAt: Date.now(), sessions: [{ id: 'e1', project: 'p', title: 't', chips: ['오류 있음'], status: 'in_progress', tab: '진행 중' }] };
  const html = view.renderApp(m, { tab: 'run', legendOpen: true });
  assert.match(html, /<span class="chip x-err">오류 있음<\/span>\s*<\/div>|<span class="chip x-err">오류 있음<\/span>/);
  assert.equal(count(html, /<li><span class="chip x-err">오류 있음<\/span> = /g), 1, 'legend entry');
  assert.equal(count(html, /<span class="chip x-err">오류 있음<\/span>/g), 2, 'card chip + legend chip');
  for (const bad of ['검증됨', '%', 'http']) assert.ok(!html.includes(bad), bad);
});

test('malformed view models do not throw', () => {
  const view = loadView();
  const bad = [
    undefined, null, 5, 'x', [], {}, { sessions: 'x' }, { sessions: [null, 5, 'y'] },
    { generatedAt: 'nope', sessions: [{ id: {}, decisions: 'x', changes: [null, 3], done: {}, flow: {}, chips: 'a', auto: 7 }] },
    { sessions: [{ decisions: [{ id: 'z', options: null }, { options: { A: null } }], flow: [null, { label: 5 }] }] },
  ];
  for (const b of bad) {
    const out = view.renderApp(b, { tab: 'run', expanded: { 'detail:undefined': true } });
    assert.equal(typeof out, 'string');
  }
  assert.equal(typeof view.renderApp(FIXTURE, null), 'string');
  assert.equal(typeof view.renderApp(FIXTURE, { tab: 'bogus', expanded: 'x' }), 'string');
});

test('flow svg draws at most 8 boxes in both layouts', () => {
  const view = loadView();
  const m = clone(FIXTURE);
  const s = m.sessions.find((x) => x.tab === '진행 중');
  s.flow = Array.from({ length: 11 }, (_, k) => ({ label: '단계' + k, state: k < 3 ? 'done' : 'todo' }));
  const html = view.renderApp(m, { tab: 'run', expanded: { ['detail:' + s.id]: true } });
  const wide = /<svg class="flow flow-wide"[\s\S]*?<\/svg>/.exec(html)[0];
  const narrow = /<svg class="flow flow-narrow"[\s\S]*?<\/svg>/.exec(html)[0];
  assert.equal(count(wide, /<rect /g), 8);
  assert.equal(count(narrow, /<rect /g), 8);
});

test('prototype-like names render as ordinary text', () => {
  const view = loadView();
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const m = clone(FIXTURE);
    m.sessions[0].project = name;
    m.sessions[1].tab = name;
    m.sessions[1].statusKey = name;
    m.sessions[0].changes[0].applied = name;
    m.sessions[0].changes[0].truth = name;
    m.sessions[0].chips = [name];
    for (const d of m.sessions[0].decisions) d.recommend = name;
    let html;
    assert.doesNotThrow(() => { html = renderAllTabs(view, m, { expanded: expandAll(m) }); }, name);
    assert.equal(Object.keys(cards(html)).length, 6, name + ' cards');
    assert.ok(html.includes('📁 ' + name), name + ' group heading');
    assert.ok(!html.includes('[native code]'), name + ' leaks prototype');
    assert.ok(!html.includes('/decide 12' + name), name + ' recommend');
    assert.equal(typeof view.renderApp(m, { tab: name }), 'string');
    assert.match(view.renderApp(m, { tab: name }), /<div class="app" data-tab="(wait|run|done)"/);
  }
});

// minimal fake DOM so page.js runs in vm without a browser
function loadPage() {
  const byId = {};
  function el(tag) {
    return {
      tagName: tag, id: '', hidden: false, innerHTML: '', listeners: {},
      addEventListener(t, f) { this.listeners[t] = f; },
      appendChild(c) { if (c.id) byId[c.id] = c; return c; },
      querySelector(sel) {
        if (sel !== '.app') return null;
        const m = /<div class="app" data-tab="([^"]*)"/.exec(this.innerHTML);
        return m ? { getAttribute: () => m[1] } : null;
      },
      querySelectorAll() { return []; },
      contains() { return true; }, remove() {}, setAttribute() {},
    };
  }
  const head = el('head');
  head.appendChild = (c) => c; // data.js polling is not exercised here
  const document = {
    readyState: 'complete', visibilityState: 'visible', body: el('body'), head,
    documentElement: { scrollHeight: 0 },
    getElementById: (id) => byId[id] || null, createElement: el, addEventListener() {},
  };
  const winListeners = {};
  const ctx = {
    document, scrollY: 0, innerHeight: 900, scrollTo() {}, setInterval() {}, setTimeout() {},
    addEventListener(t, f) { (winListeners[t] ||= []).push(f); },
  };
  vm.runInNewContext(VIEW_SRC, ctx, { filename: 'view.js' });
  vm.runInNewContext(PAGE_SRC, ctx, { filename: 'page.js' });
  const shown = () => byId.app.querySelector('.app')?.getAttribute('data-tab');
  const fire = (t) => (winListeners[t] || []).forEach((f) => f({}));
  return { page: ctx.BriefPage, badge: byId['new-badge'], shown, root: byId.app, ctx, byId, body: document.body, fire };
}

test('a larger seq applies by itself and keeps the tab the owner sees, even an untouched default', () => {
  const { page, badge, shown, root } = loadPage();
  page.receive({ ...clone(FIXTURE), seq: 1, sessions: clone(FIXTURE).sessions.filter((s) => s.tab === '진행 중') });
  assert.equal(shown(), 'run');
  page.state.appliedAt = 0; // the 500 ms apply throttle is covered in page.test.mjs
  page.receive({ ...clone(FIXTURE), seq: 2 });
  assert.equal(page.state.seq, 2, 'applied without a click');
  assert.equal(badge.hidden, true);
  assert.equal(shown(), 'run', 'tab kept after apply');
  assert.ok(!root.innerHTML.includes('class="fatal"'));
});

test('badge apply keeps an explicitly chosen tab and opened details', () => {
  const { page, badge, shown, root } = loadPage();
  page.receive({ ...clone(FIXTURE), seq: 1 });
  const runId = FIXTURE.sessions.find((s) => s.tab === '진행 중').id;
  page.state.ui.tab = 'run';
  page.state.ui.expanded['detail:' + runId] = true;
  page.render(); // what a tab click / '자세히' click does
  assert.equal(shown(), 'run');
  page.receive({ ...clone(FIXTURE), seq: 3 });
  badge.listeners.click();
  assert.equal(shown(), 'run');
  assert.ok(root.innerHTML.includes('class="detail"'));
});

test('scroll spy follows the scroll position; a TOC click leaves no sticky highlight', () => {
  const { page, root, ctx, body, fire } = loadPage();
  // card tops in the document, 900px viewport, 2300px page; B starts above the 45% line at scrollY 0
  const bases = { A: 0, B: 300, C: 1400 };
  ctx.document.documentElement.scrollHeight = 2300;
  const current = {};
  const links = Object.keys(bases).map((id) => {
    const attrs = { 'data-goto': id };
    return {
      getAttribute: (n) => attrs[n] ?? null, setAttribute: (n, v) => { attrs[n] = v; },
      removeAttribute: (n) => { delete attrs[n]; },
      classList: { toggle: (c, on) => { if (c === 'spy') current[id] = !!on; } },
    };
  });
  const cardEls = Object.keys(bases).map((id) => {
    const c = {
      id, classList: { add() {}, remove() {} },
      getBoundingClientRect: () => ({ top: bases[id] - ctx.scrollY }),
      scrollIntoView() { ctx.scrollY = Math.min(bases[id], 2300 - ctx.innerHeight); fire('scroll'); },
    };
    body.appendChild(c);
    return c;
  });
  root.querySelectorAll = (s) => (s === 'article.card' ? cardEls : s === '.toclink' ? links : []);
  page.receive({ ...clone(FIXTURE), seq: 1 });
  const lit = () => Object.keys(current).filter((k) => current[k]).join();
  const scrollTo = (y) => { ctx.scrollY = y; fire('scroll'); };

  scrollTo(0);
  assert.equal(lit(), 'A', 'top of the tab highlights the first section');
  // click B in the TOC (browser scrolls there)
  const t = { hasAttribute: (n) => n === 'data-goto', getAttribute: (n) => (n === 'data-goto' ? 'B' : null) };
  root.listeners.click({ target: { closest: () => t }, preventDefault() {} });
  assert.equal(lit(), 'B', 'clicked section is highlighted');
  scrollTo(0);
  assert.equal(lit(), 'A', 'scrolling back to the top returns to the first section');
  scrollTo(700);
  assert.equal(lit(), 'B');
  scrollTo(2300 - 900);
  assert.equal(lit(), 'C', 'page end highlights the last section');
  scrollTo(0);
  assert.equal(lit(), 'A');
});

test('tab switch shows only that tab cards', () => {
  const view = loadView();
  const done = cards(view.renderApp(FIXTURE, { tab: 'done' }));
  const want = FIXTURE.sessions.filter((s) => s.tab === '끝남').map((s) => s.id).sort();
  assert.deepEqual(Object.keys(done).sort(), want);
});

test('open question alert names the pane to answer in and stays read-only; old records fall back to the session pane', () => {
  const view = loadView();
  const model = clone(FIXTURE);
  const s = model.sessions.find((x) => x.openQuestion);
  s.openQuestion.paneId = 'pane-F1-original';
  let html = cards(view.renderApp(model, { tab: 'wait' }))[s.id];
  let oq = html.slice(html.indexOf('class="oq"'), html.indexOf('</p>', html.indexOf('class="oq"')));
  assert.ok(oq.includes('질문 알림 열림 - '), 'alert says a question is open');
  assert.ok(oq.includes('pane-F1-original'), 'originating pane shown');
  assert.ok(oq.includes('에서 답하기'), 'says where to answer');
  assert.ok(oq.includes(s.openQuestion.text), 'question text kept');
  assert.ok(!oq.includes('<button') && !oq.includes('data-act'), 'read-only: no controls');
  // a record written before paneId existed in the model: use the session's own pane
  delete s.openQuestion.paneId;
  html = cards(view.renderApp(model, { tab: 'wait' }))[s.id];
  oq = html.slice(html.indexOf('class="oq"'), html.indexOf('</p>', html.indexOf('class="oq"')));
  assert.ok(oq.includes(s.paneId) && oq.includes('에서 답하기'));
  // no pane known anywhere: still says to answer where the question was asked, never "undefined"
  delete s.paneId;
  html = cards(view.renderApp(model, { tab: 'wait' }))[s.id];
  oq = html.slice(html.indexOf('class="oq"'), html.indexOf('</p>', html.indexOf('class="oq"')));
  assert.ok(oq.includes('질문이 뜬 창에서 답하기') && !/undefined|null/.test(oq));
});
