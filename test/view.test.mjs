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
  assert.ok(card.includes('class="dline from">대화: '));
  assert.ok(card.includes('⏱'));
  assert.ok(card.includes('data-copy="/decide 12A"'));
  assert.ok(card.includes('답: /decide 12A'));
});

test('herdr tab label names the conversation in the card header, decision line and TOC; no label falls back to the pane', () => {
  const view = loadView();
  const model = clone(FIXTURE);
  const s = model.sessions.find((x) => x.decisions.some((d) => !d.answered && !d.closed));
  const title = (html, id) => /<span class="title">([^<]*)<\/span>/.exec(cards(html)[id])[1];
  const from = (html, id) => /class="dline from">([^<]*)<\/div>/.exec(cards(html)[id])[1];
  const toc = (html) => [...html.matchAll(/class="toclink"[^>]*>(?:<span class="tag">[^<]*<\/span> )?([^<]*)<\/a>/g)].map((m) => m[1]);

  Object.assign(s, { title: '작업', tabLabel: '수리', tabNumber: 181, paneId: 'w1:pR2' });
  let html = view.renderApp(model, { tab: 'wait' });
  assert.equal(title(html, s.id), '🗂 수리 #181 · 작업');
  assert.equal(from(html, s.id), '대화: 🗂 수리 #181 · 작업');
  assert.ok(toc(html).includes('🗂 수리 #181 · 작업'));

  Object.assign(s, { tabLabel: '', tabNumber: null });
  html = view.renderApp(model, { tab: 'wait' });
  assert.equal(title(html, s.id), '창 w1:pR2 · 작업');
  assert.equal(from(html, s.id), '대화: 창 w1:pR2 · 작업');
  assert.ok(toc(html).includes('창 w1:pR2 · 작업'));

  delete s.paneId;
  assert.equal(title(view.renderApp(model, { tab: 'wait' }), s.id), '창 모름 · 작업');
});

test('tab label and title markup are escaped in the header, decision line and TOC', () => {
  const view = loadView();
  const model = clone(FIXTURE);
  const s = model.sessions.find((x) => x.decisions.some((d) => !d.answered && !d.closed));
  Object.assign(s, { title: '<b>제목</b>', tabLabel: '<i>수리</i>', tabNumber: 181 });
  const html = view.renderApp(model, { tab: 'wait' });
  assert.ok(!html.includes('<b>제목</b>') && !html.includes('<i>수리</i>'));
  const want = '🗂 &lt;i&gt;수리&lt;/i&gt; #181 · &lt;b&gt;제목&lt;/b&gt;';
  const c = cards(html)[s.id];
  assert.ok(c.includes('<span class="title">' + want + '</span>'), 'header');
  assert.ok(c.includes('class="dline from">대화: ' + want + '</div>'), 'decision line');
  assert.ok(html.split('class="toclink"').some((p) => p.includes(want + '</a>')), 'TOC');
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

test('open question with a herdr tab names the tab; focus button only in live mode with a tabId; file mode shows the read-only notice', () => {
  const view = loadView();
  const model = clone(FIXTURE);
  const s = model.sessions.find((x) => x.openQuestion);
  Object.assign(s, { tabLabel: '수리', tabNumber: 181, tabId: 'w1:t5N' });
  const oqOf = (ui) => {
    const html = cards(view.renderApp(model, { tab: 'wait', ...ui }))[s.id];
    const i = html.indexOf('class="oq"');
    return { html, oq: html.slice(i, html.indexOf('</p>', i)) };
  };
  let r = oqOf({ live: true });
  assert.ok(r.oq.includes('답할 창: <code>🗂 수리 #181</code>'));
  assert.ok(r.oq.includes('data-act="focus" data-session="' + s.id + '"'));
  assert.equal(count(r.html, /data-act="focus"/g), 2, 'card header and question line');
  // the tab label is untrusted text on the line this helper feeds: it stays escaped
  const label = s.tabLabel;
  s.tabLabel = '<b>x</b> & "y"';
  s.tabNumber = 7;
  const hostile = oqOf({ live: true });
  assert.ok(hostile.oq.includes('답할 창: <code>🗂 &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot; #7</code>'), 'escaped tab label on the open-question line');
  assert.ok(!hostile.html.includes('<b>x</b>'), 'no raw markup from the label');
  s.tabLabel = label;
  s.tabNumber = 181;
  r = oqOf({ live: true, focus: { [s.id]: { ok: false } } });
  assert.ok(r.oq.includes('이동 실패 - herdr에서 직접 열어 주세요'));
  r = oqOf({ live: true, focus: { [s.id]: { ok: true } } });
  assert.ok(r.oq.includes('이동했어요'));
  r = oqOf({});
  assert.ok(!r.html.includes('data-act="focus"'), 'file mode: no button');
  s.tabId = '';
  assert.ok(!oqOf({ live: true }).html.includes('data-act="focus"'), 'no tabId: no button');
  assert.ok(view.renderApp(model, { tab: 'wait' }).includes('보기 전용입니다'));
  assert.ok(!view.renderApp(model, { tab: 'wait', live: true }).includes('보기 전용입니다'));
});

test('page.css dresses the [그 창으로 이동] button like the answer buttons and colors its result text from the page tokens', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/page/page.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }));
  const focus = rules.filter((r) => /(^|, )\.focusbtn(:[a-z-]+)?($|, )/.test(r.sel));
  const base = focus.find((r) => /(^|, )\.focusbtn($|, )/.test(r.sel));
  assert.ok(base, 'the focus button has a base rule of its own, not the browser default');
  assert.match(base.body, /padding:/, 'it is padded like the other controls');
  assert.match(base.body, /border: 1px solid var\(--line\)/, 'the same border as the answer buttons');
  assert.match(base.body, /background: var\(--panel\)/, 'the same surface as the answer buttons');
  assert.ok(focus.some((r) => /:hover/.test(r.sel)), 'hover looks like the other buttons');
  assert.ok(focus.some((r) => /:focus-visible/.test(r.sel)), 'keyboard focus is visible');
  assert.doesNotMatch(focus.map((r) => r.body).join('\n'), /#[0-9a-f]{3,8}\b|rgba?\(/i, 'colors come from the page tokens');
  assert.match(css, /\.focus-res\.ok \{[^}]*var\(--teal\)/, 'a successful jump is green-teal');
  assert.match(css, /\.focus-res\.err \{[^}]*var\(--red\)/, 'a failed jump is red');
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

// ---- answering from the board (server page: ui.live; page state ui.answers[id]) ----
const dcardOf = (html, id) => {
  const start = html.indexOf('data-decision="' + id + '"');
  return start < 0 ? '' : html.slice(start, html.indexOf('</div><!--dcard-->', start));
};
const liveCard = (view, model, id, answers = {}) => dcardOf(view.renderApp(model, { tab: 'wait', live: true, answers }), id);

test('server page: an open decision gets one button per option (the recommended one primary) and a reply button only when its conversation takes text', () => {
  const view = loadView();
  const c12 = liveCard(view, FIXTURE, 12); // s-a1: answerKinds option+text, A/B/C, recommend A
  assert.deepEqual([...c12.matchAll(/data-act="ans-pick" data-opt="([ABC])" data-id="12"/g)].map((m) => m[1]), ['A', 'B', 'C']);
  assert.equal(count(c12, /class="ans-opt is-rec"/g), 1);
  assert.match(c12, /class="ans-opt is-rec" data-act="ans-pick" data-opt="A"/);
  assert.equal(count(c12, /data-act="ans-reply" data-id="12"/g), 1);
  assert.ok(c12.includes('data-copy="/decide 12A"'), 'the /decide copy line stays under the buttons');
  const c15 = liveCard(view, FIXTURE, 15); // s-b1: answerKinds [] (an older generation)
  assert.equal(count(c15, /data-act="ans-pick"/g), 2);
  assert.equal(count(c15, /data-act="ans-reply"/g), 0, 'no reply box for a conversation that cannot take text');
  const m = clone(FIXTURE);
  delete m.sessions.find((s) => s.id === 's-a1').answerKinds; // a model from before answerKinds existed
  assert.equal(count(liveCard(view, m, 12), /data-act="ans-reply"/g), 0);
  assert.equal(count(liveCard(view, m, 12), /data-act="ans-pick"/g), 3);
});

test('file page (no ui.live): no answer controls and no sent lines anywhere, whatever answer state lies around', () => {
  const view = loadView();
  const html = renderAllTabs(view, FIXTURE, { expanded: expandAll(FIXTURE), answers: { 12: { confirm: { option: 'B' }, open: true, draft: 'x' }, 11: { phase: 'sent' } } });
  assert.ok(!/data-act="ans-|class="ans-box"|class="dsent"|ans-confirm|<textarea/.test(html));
  assert.equal(count(dcardOf(view.renderApp(FIXTURE, { tab: 'wait' }), 12), /class="dline/g), 8, 'the file card is unchanged');
});

test('the pending confirm names the receiving conversation and the choice; a reply confirm shows its first 40 characters', () => {
  const view = loadView();
  let c = liveCard(view, FIXTURE, 12, { 12: { confirm: { option: 'B' } } });
  const confirm = /<div class="ans-confirm"[\s\S]*?<\/div>/.exec(c)[0];
  assert.ok(confirm.includes('🗂 수리 #181 '), 'herdr tab label and number');
  assert.ok(confirm.includes('<b>B</b>'));
  assert.ok(confirm.includes('data-act="ans-send" data-id="12"') && confirm.includes('data-act="ans-cancel" data-id="12"'));
  assert.deepEqual([...c.matchAll(/data-opt="([ABC])"[^>]*aria-pressed="true"/g)].map((x) => x[1]), ['B']);
  c = liveCard(view, FIXTURE, 12, { 12: { confirm: { text: '<b>' + '가'.repeat(60) } } });
  assert.equal(/<q class="ans-quote">([^<]*)<\/q>/.exec(c)[1], '&lt;b&gt;' + '가'.repeat(37) + '…');
  assert.ok(!c.includes('<textarea'), 'the reply box gives way to its confirm');
  // no herdr tab: the pane names the conversation
  assert.ok(liveCard(view, FIXTURE, 15, { 15: { confirm: { option: 'A' } } }).includes('창 w1-p1 '));
});

test('sending / sent / closed replace the buttons; a retryable error keeps them and the confirm', () => {
  const view = loadView();
  const at = (a) => liveCard(view, FIXTURE, 12, { 12: a });
  for (const phase of ['sending', 'sent']) {
    const c = at({ phase, confirm: { option: 'B' } });
    assert.equal(count(c, /data-act="ans-/g), 0, phase + ': nothing to click twice');
    assert.equal(count(c, /class="ans-state"/g), 1, phase);
    assert.ok(!c.includes('s-done'), phase + ': never a delivered chip from page state');
  }
  const closed = at({ phase: 'closed', error: '<i>x</i>' });
  assert.equal(count(closed, /data-act="ans-/g), 0);
  assert.ok(closed.includes('<p class="ans-err" role="alert">&lt;i&gt;x&lt;/i&gt;</p>'));
  const retry = at({ error: 'e1', confirm: { option: 'A' } });
  assert.equal(count(retry, /data-act="ans-pick"/g), 3);
  assert.ok(retry.includes('class="ans-confirm"') && retry.includes('<p class="ans-err" role="alert">e1</p>'));
});

test('the reply box carries the escaped draft, the 500 limit and its counter', () => {
  const view = loadView();
  const c = liveCard(view, FIXTURE, 12, { 12: { open: true, draft: '</textarea><b>x' } });
  assert.ok(c.includes('maxlength="500"'));
  assert.ok(c.includes('>&lt;/textarea&gt;&lt;b&gt;x</textarea>'));
  assert.ok(c.includes('<span class="ans-count">15/500</span>'));
  assert.ok(c.includes('data-act="ans-text" data-id="12"'));
  assert.match(c, /data-act="ans-reply"[^>]*aria-expanded="true"/);
  assert.match(c, /<textarea class="ans-text" data-draft="12" data-where="dc"/);
});

test('server page: an answer still on its way shows its delivery text on the card; a delivered one stays only when this page sent it', () => {
  const view = loadView();
  const m = clone(FIXTURE);
  const d11 = m.sessions.find((s) => s.id === 's-b2').decisions.find((d) => d.id === 11); // answered, with a receipt
  const lines = (answers) => cards(view.renderApp(m, { tab: 'wait', live: true, answers }))['s-b2'].match(/<p class="dsent">[\s\S]*?<\/p>/g) || [];
  assert.deepEqual(lines({}), [], 'delivered and not sent from this page: only under 자세히, as before');
  const mine = lines({ 11: { phase: 'sent' } });
  assert.equal(mine.length, 1);
  assert.ok(mine[0].includes('chip s-done'), 'delivered: the done chip, from the receipt');
  Object.assign(d11, { receipt: null, delivery: '대기: 작업이 끝나면 전달', answer: { option: 'B', text: '', at: 1 } });
  const waiting = lines({});
  assert.equal(waiting.length, 1);
  assert.ok(waiting[0].includes('#11 답 B · 유지') && waiting[0].includes('chip x-busy">대기: 작업이 끝나면 전달<'));
  Object.assign(d11, { answer: { option: '', text: '<b>설치해 줘</b>', at: 1 } });
  assert.ok(lines({})[0].includes('답글 <q class="ans-quote">&lt;b&gt;설치해 줘&lt;/b&gt;</q>'));
  assert.ok(!view.renderApp(m, { tab: 'wait' }).includes('class="dsent"'), 'never on the file page');
});

test('answer controls escape model text in buttons and attributes', () => {
  const view = loadView();
  const m = clone(FIXTURE);
  const s = m.sessions.find((x) => x.id === 's-a1');
  s.decisions[0].options.B.text = '"><img src=x onerror=alert(1)>';
  s.tabLabel = '<script>x</script>';
  const c = liveCard(view, m, 12, { 12: { confirm: { option: 'B' } } });
  assert.ok(!c.includes('<img') && !c.includes('<script>'));
  assert.ok(c.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(c.includes('🗂 &lt;script&gt;x&lt;/script&gt; #181 '));
});

test('server page: malformed decisions and answer state render without throwing; only positive integer ids get controls', () => {
  const view = loadView();
  const a = { text: 'a', consequence: 'c' };
  const m = { generatedAt: 0, sessions: [{ id: 's', title: 't', answerKinds: 'text', status: 'needs_decision', decisions: [
    { id: 0, options: { A: a } }, { id: -3, options: { A: a } }, { id: 1.5, options: { A: a } }, { id: '7', options: { A: a } },
    { id: 8, options: null }, { id: 9, options: { A: null, B: 'x', C: { text: { no: 1 } } } }, { id: 10, options: { A: a, constructor: a } },
    { id: 11, answered: true, answer: 'garbage', receipt: 5 }, null, 5,
  ] }] };
  const answers = { 9: null, 10: { phase: { x: 1 }, confirm: 'B', error: 42, draft: { a: 1 }, open: 'yes' }, constructor: { phase: 'sending' } };
  let html;
  assert.doesNotThrow(() => { html = view.renderApp(m, { live: true, answers, tab: 'wait', expanded: { 'more-dc:s': true } }); });
  const ids = [...html.matchAll(/data-act="ans-pick"[^>]*data-id="([^"]*)"/g)].map((x) => x[1]);
  assert.deepEqual(ids.sort(), ['10', '9'], 'only object options become buttons, only under positive integer ids');
  for (const bad of ['0', '-3', '1.5', '7']) assert.ok(!html.includes('data-ans="' + bad + '"'), 'no controls for id ' + bad);
  assert.equal(count(html, /data-act="ans-reply"/g), 0, 'answerKinds that is not a list offers no reply box');
  for (const bad of [null, 'x', 5, []]) assert.equal(typeof view.renderApp(m, { live: true, answers: bad, tab: 'wait' }), 'string');
});
