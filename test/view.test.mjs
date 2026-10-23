import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeController } from './fixtures/controller-dom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS_SRC = fs.readFileSync(path.join(ROOT, 'src/page/icons.js'), 'utf8');
const VIEW_SRC = fs.readFileSync(path.join(ROOT, 'src/page/view.js'), 'utf8');
const SHELL_SRC = fs.readFileSync(path.join(ROOT, 'src/page/shell.js'), 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/view-model.json'), 'utf8'));

// the page's icons.js first, as render.mjs inlines it
function loadView() {
  const ctx = vm.createContext({});
  vm.runInContext(ICONS_SRC, ctx, { filename: 'icons.js' });
  vm.runInContext(VIEW_SRC, ctx, { filename: 'view.js' });
  assert.equal(typeof ctx.BriefView?.renderOverview, 'function');
  return ctx.BriefView;
}
const clone = (v) => JSON.parse(JSON.stringify(v));
const count = (s, re) => (s.match(re) || []).length;
function loadShell() {
  const ctx = vm.createContext({});
  vm.runInContext(ICONS_SRC, ctx, { filename: 'icons.js' });
  vm.runInContext(SHELL_SRC, ctx, { filename: 'shell.js' });
  return ctx.BriefShell;
}
// icons.js markup -> [name]: which icon is drawn where
const marks = (html) => html.replace(/<svg class="ic[^"]*" aria-hidden="true" focusable="false"><use href="#i-([a-z0-9-]+)"><\/use><\/svg>/g, '[$1]');

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
function renderAllTabs(view, model, extra = {}) {
  return view.renderOverview(model, extra);
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

test('sidebar holds the status filters; tabs is the only top row and contains only tabs, reopen and add', () => {
  const view = loadView();
  const S = loadShell(), st = S.reduce(S.defaults(), { type: 'open', sid: FIXTURE.sessions[0].id });
  const frame = S.sideFrame(st), bar = S.tabs(FIXTURE, st), overview = view.renderOverview(FIXTURE, {});
  assert.equal(count(frame, /data-sh="filter"/g), 4);
  for (const label of ['전체', '나를 기다림', '진행 중', '끝남']) assert.ok(frame.includes(label));
  assert.deepEqual([...bar.matchAll(/data-sh="([^"]+)"/g)].map(m => m[1]), ['toggleSide', 'active', 'close', 'view']);
  assert.equal(count(S.skeleton(st), /id="tabs"/g), 1);
  assert.doesNotMatch(overview, /nav class="toc"|role="tab"|class="legend"/);
  assert.equal(Object.keys(cards(overview)).length, FIXTURE.sessions.length);
});

test('top summary line and gray note', () => {
  const view = loadView();
  const html = view.renderOverview(FIXTURE, {});
  assert.match(marks(html), /결정 대기 5 · 막힘 1 · 오래됨 1 · \[clock\] 마지막 갱신 \d\d:\d\d/);
  assert.ok(html.includes('브리핑이 켜진 대화 6개만 보입니다 - 설치 전부터 열려 있던 대화는 새로 열어야 나타납니다'));
});

test('decision card has 8 logical lines and a /decide copy value', () => {
  const view = loadView();
  const html = view.renderOverview(FIXTURE, { tab: 'wait' });
  const start = html.indexOf('data-decision="12"');
  assert.ok(start > 0, 'decision 12 rendered');
  const card = html.slice(start, html.indexOf('</div><!--dcard-->', start));
  assert.equal(count(card, /class="dline/g), 8);
  assert.ok(card.includes('#12 '));
  assert.ok(card.includes('[결정 기록기]'));
  assert.ok(card.includes('추천: A - '));
  assert.ok(card.includes('class="dline from">대화: '));
  assert.ok(marks(card).includes('class="dline when">[clock] '));
  assert.ok(card.includes('data-copy="/decide 12A"'));
  assert.ok(card.includes('답: /decide 12A'));
});

test('herdr tab label names the header, decision and sidebar tooltip; no label falls back to the pane on cards', () => {
  const view = loadView();
  const model = clone(FIXTURE);
  const s = model.sessions.find((x) => x.decisions.some((d) => !d.answered && !d.closed));
  const title = (html, id) => /<span class="title">([^<]*)<\/span>/.exec(marks(cards(html)[id]))[1];
  const from = (html, id) => /class="dline from">([^<]*)<\/div>/.exec(marks(cards(html)[id]))[1];
  const S = loadShell(), side = () => S.side(model, S.defaults());

  Object.assign(s, { alive: true, title: '작업', tabLabel: '수리', tabNumber: 181, paneId: 'w1:pR2' });
  let html = view.renderOverview(model, { tab: 'wait' });
  assert.equal(title(html, s.id), '[app-window] 수리 #181 · 작업');
  assert.equal(from(html, s.id), '대화: [app-window] 수리 #181 · 작업');
  assert.ok(side().includes('title="수리 #181 · 작업"'), 'the tooltip is text: the label without its icon');

  Object.assign(s, { tabLabel: '', tabNumber: null });
  html = view.renderOverview(model, { tab: 'wait' });
  assert.equal(title(html, s.id), '창 w1:pR2 · 작업');
  assert.equal(from(html, s.id), '대화: 창 w1:pR2 · 작업');
  assert.ok(side().includes('title="작업"'));

  delete s.paneId;
  assert.equal(title(view.renderOverview(model, { tab: 'wait' }), s.id), '창 모름 · 작업');
});

test('tab label and title markup are escaped in the header, decision line and sidebar', () => {
  const view = loadView();
  const model = clone(FIXTURE);
  const s = model.sessions.find((x) => x.decisions.some((d) => !d.answered && !d.closed));
  Object.assign(s, { alive: true, title: '<b>제목</b>', tabLabel: '<i>수리</i>', tabNumber: 181 });
  const html = view.renderOverview(model, { tab: 'wait' });
  assert.ok(!html.includes('<b>제목</b>') && !html.includes('<i>수리</i>'));
  const want = '&lt;i&gt;수리&lt;/i&gt; #181 · &lt;b&gt;제목&lt;/b&gt;';
  const c = marks(cards(html)[s.id]);
  assert.ok(c.includes('<span class="title">[app-window] ' + want + '</span>'), 'header');
  assert.ok(c.includes('class="dline from">대화: [app-window] ' + want + '</div>'), 'decision line');
  const S = loadShell();
  assert.ok(S.side(model, S.defaults()).includes('title="' + want + '"'), 'sidebar tooltip');
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
  const empty = view.renderOverview({ seq: 1, generatedAt: Date.now(), sessions: [] }, {});
  assert.ok(empty.includes('아직 보고 없음'));
  const m = { seq: 2, generatedAt: Date.now(), sessions: [{ id: 'r1', project: 'p', title: 't', chips: ['기록 읽기 실패'], status: 'in_progress', tab: '진행 중' }] };
  const html = view.renderOverview(m, { tab: 'run' });
  assert.ok(html.includes('기록 읽기 실패'));
});

test('오류 있음 chip renders on the card and the legend explains it', () => {
  const view = loadView();
  const m = { seq: 2, generatedAt: Date.now(), sessions: [{ id: 'e1', project: 'p', title: 't', chips: ['오류 있음'], status: 'in_progress', tab: '진행 중' }] };
  const S = loadShell();
  const html = view.renderOverview(m, {}) + S.side(m, S.reduce(S.defaults(), { type: 'view', key: 'settings' }));
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
    const out = view.renderOverview(b, { tab: 'run', expanded: { 'detail:undefined': true } });
    assert.equal(typeof out, 'string');
  }
  assert.equal(typeof view.renderOverview(FIXTURE, null), 'string');
  assert.equal(typeof view.renderOverview(FIXTURE, { tab: 'bogus', expanded: 'x' }), 'string');
});

test('flow svg draws at most 8 boxes in both layouts', () => {
  const view = loadView();
  const m = clone(FIXTURE);
  const s = m.sessions.find((x) => x.tab === '진행 중');
  s.flow = Array.from({ length: 11 }, (_, k) => ({ label: '단계' + k, state: k < 3 ? 'done' : 'todo' }));
  const html = view.renderOverview(m, { tab: 'run', expanded: { ['detail:' + s.id]: true } });
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
    assert.ok(marks(html).includes('[folder] ' + name), name + ' group heading');
    assert.ok(!html.includes('[native code]'), name + ' leaks prototype');
    assert.ok(!html.includes('/decide 12' + name), name + ' recommend');
    assert.equal(typeof view.renderOverview(m, { tab: name }), 'string');
    assert.match(view.renderOverview(m, { tab: name }), /<div class="overview">/);
  }
});

function loadPage() { return makeController({ protocol: 'file:', token: '' }); }

test('a larger seq applies by itself and keeps the active conversation and sub-tab', () => {
  const e = loadPage();
  e.page.receive({ ...clone(FIXTURE), seq: 1, sessions: clone(FIXTURE).sessions.filter(s => s.tab === '진행 중') });
  const sid = e.page.state.model.sessions[0].id;
  e.page.open(sid, 'wk');
  e.advance(600); e.page.receive({ ...clone(FIXTURE), seq: 2 });
  assert.equal(e.page.state.seq, 2);
  assert.equal(e.badge.hidden, true);
  assert.equal(e.page.state.ui.active, sid);
  assert.equal(e.page.state.ui.sub[sid], 'wk');
  assert.ok(!e.app.innerHTML.includes('class="fatal"'));
});

test('badge apply keeps the chosen sub-tab and opened details', () => {
  const e = loadPage();
  e.page.receive({ ...clone(FIXTURE), seq: 1 });
  const sid = FIXTURE.sessions.find(s => s.tab === '진행 중').id;
  e.page.open(sid, 'ov');
  const detail = e.byId.main.querySelector('details');
  assert.ok(detail); detail.open = true; e.fire(detail, 'toggle');
  const key = detail.getAttribute('data-open-key');
  e.page.receive({ ...clone(FIXTURE), seq: 3 });
  e.badge.listeners.click();
  assert.equal(e.page.state.ui.active, sid);
  assert.equal(e.page.state.ui.sub[sid], 'ov');
  assert.equal(e.page.state.ui.expanded[key], true);
  assert.equal(e.byId.main.querySelector('[data-open-key="' + key + '"]').open, true);
});

test('region navigation preserves per-conversation scroll rather than a TOC scroll spy', () => {
  const e = loadPage();
  e.page.receive({ ...clone(FIXTURE), seq: 1 });
  const [a, b] = FIXTURE.sessions;
  e.page.open(a.id, 'ov'); e.byId.main.scrollTop = 350;
  e.page.open(b.id, 'ov'); assert.equal(e.byId.main.scrollTop, 0);
  e.byId.main.scrollTop = 700;
  e.page.open(a.id, 'ov'); assert.equal(e.byId.main.scrollTop, 350);
  e.page.open(b.id, 'ov'); assert.equal(e.byId.main.scrollTop, 700);
  assert.equal(e.app.querySelector('nav.toc'), null);
  assert.deepEqual(e.scrolls, []);
});

test('sidebar status filter shows only conversations in that group', () => {
  const S = loadShell();
  const m = clone(FIXTURE);
  for (const s of m.sessions) s.alive = true;
  const st = S.reduce(S.defaults(), { type: 'filter', key: 'done' });
  const done = [...S.side(m, st).matchAll(/data-row="([^"]*)"/g)].map(m => m[1]);
  const want = FIXTURE.sessions.filter((s) => s.tab === '끝남').map((s) => s.id).sort();
  assert.deepEqual(done.sort(), want);
});

test('open question with a herdr tab names the tab; focus button only in live mode with a tabId; file mode shows the read-only notice', () => {
  const view = loadView();
  const model = clone(FIXTURE);
  const s = model.sessions.find((x) => x.openQuestion);
  Object.assign(s, { tabLabel: '수리', tabNumber: 181, tabId: 'w1:t5N' });
  const oqOf = (ui) => {
    const html = cards(view.renderOverview(model, { tab: 'wait', ...ui }))[s.id];
    const i = html.indexOf('class="oq"');
    return { html, oq: html.slice(i, html.indexOf('</p>', i)) };
  };
  let r = oqOf({ live: true });
  assert.ok(marks(r.oq).includes('답할 창: <code>[app-window] 수리 #181</code>'));
  assert.ok(r.oq.includes('data-act="focus" data-session="' + s.id + '"'));
  assert.equal(count(r.html, /data-act="focus"/g), 2, 'card header and question line');
  // the tab label is untrusted text on the line this helper feeds: it stays escaped
  const label = s.tabLabel;
  s.tabLabel = '<b>x</b> & "y"';
  s.tabNumber = 7;
  const hostile = oqOf({ live: true });
  assert.ok(marks(hostile.oq).includes('답할 창: <code>[app-window] &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot; #7</code>'), 'escaped tab label on the open-question line');
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
  assert.ok(view.renderOverview(model, { tab: 'wait' }).includes('보기 전용입니다'));
  assert.ok(!view.renderOverview(model, { tab: 'wait', live: true }).includes('보기 전용입니다'));
});

test('page.css dresses the [그 창으로 이동] button like the answer buttons and colors its result text from the page tokens', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/page/page.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }));
  const focus = rules.filter((r) => /(^|, )\.focusbtn(:[a-z-]+)?($|, )/.test(r.sel));
  const base = focus.find((r) => /(^|, )\.focusbtn($|, )/.test(r.sel));
  assert.ok(base, 'the focus button has a base rule of its own, not the browser default');
  assert.match(base.sel, /\.ans-opt, \.ans-write, \.ans-go, \.ans-cancel, \.focusbtn/, 'focus and answer controls share the same rule');
  assert.match(base.body, /padding:/, 'it is padded like the other controls');
  assert.match(base.body, /border: var\(--hair\) solid var\(--ctl-edge\)/, 'the same contrast-bearing control edge as the answer buttons');
  assert.match(base.body, /background: var\(--panel\)/, 'the same surface as the answer buttons');
  assert.ok(focus.some((r) => /:hover/.test(r.sel)), 'hover looks like the other buttons');
  assert.ok(focus.some((r) => /:focus-visible/.test(r.sel)), 'keyboard focus is visible');
  assert.doesNotMatch(focus.map((r) => r.body).join('\n'), /#[0-9a-f]{3,8}\b|rgba?\(/i, 'colors come from the page tokens');
  assert.match(css, /\.focus-res\.ok \{[^}]*var\(--teal\)/, 'a successful jump is green-teal');
  assert.match(css, /\.focus-res\.err \{[^}]*var\(--red\)/, 'a failed jump is red');
});

// top-level rule bodies of a stylesheet by their exact selector text (whitespace folded)
function cssRule(file, sel) {
  const css = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((r) => r[1].replace(/\s+/g, ' ').trim() === sel);
  return m ? m[2] : null;
}

test('a title with no break opportunity wraps in the overview: page.css breaks the card title and its open button anywhere', () => {
  const model = clone(FIXTURE);
  const s = model.sessions[0];
  s.title = 'W'.repeat(300);
  const html = loadView().renderOverview(model, {});
  assert.ok(html.startsWith('<div class="overview">'));
  assert.ok(html.includes('<button type="button" class="more" data-sh="open" data-sid="' + s.id + '">대화 페이지 열기 · '), 'the open button is a .more child of div.overview');
  assert.match(marks(html), new RegExp('대화 페이지 열기 · [^<]*' + s.title + '</button>'), 'it carries the whole title');
  assert.match(marks(cards(html)[s.id]), new RegExp('<span class="title">[^<]*' + s.title + '</span>'), 'so does the card header');
  const title = cssRule('src/page/page.css', '.title');
  assert.match(title, /min-width: 0/, 'a .ch flex item may shrink below its longest word');
  const shared = /\.title,\s*\.overview > \.more,\s*\.cv-page \.cv-h1\s*\{([^}]*)\}/.exec(fs.readFileSync(path.join(ROOT, 'src/page/page.css'), 'utf8'));
  assert.ok(shared, 'card titles, open buttons and conversation headings share diagnostic wrapping');
  assert.match(shared[1], /overflow-wrap: anywhere/);
  const open = cssRule('src/page/page.css', '.overview > .more');
  assert.ok(open, 'the overview open button has a rule of its own');
});

test('an unbroken run wraps in the decision card: page.css breaks the 대화 line and the decision prose anywhere; the prose keeps word-break keep-all, never break-all', () => {
  const model = clone(FIXTURE);
  const s = model.sessions.find((x) => x.tabLabel && (x.decisions || []).some((d) => !d.answered && !d.closed));
  s.tabLabel = 'W'.repeat(120);
  assert.match(marks(loadView().renderOverview(model, {})), new RegExp('<div class="dline from">[^<]*\\[app-window\\] ' + s.tabLabel + ' #' + s.tabNumber + ' · '), 'the decision card names its conversation by the whole tab label');
  const css = fs.readFileSync(path.join(ROOT, 'src/page/page.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((r) => ({ sels: r[1].split(',').map((x) => x.replace(/\s+/g, ' ').trim()), body: r[2] }));
  assert.ok(rules.some((r) => r.sels.includes('.dline.from') && /overflow-wrap: anywhere/.test(r.body)), 'the 대화 line breaks inside an unbroken label instead of widening the .decs grid item');
  assert.ok(rules.some((r) => ['.dline.dq', '.dline.opt', '.dline.rec'].every((sel) => r.sels.includes(sel)) && /word-break: keep-all/.test(r.body) && /overflow-wrap: anywhere/.test(r.body)), 'the question, option and recommendation lines keep keep-all and break only an unbroken run anywhere');
  for (const r of rules.filter((x) => x.sels.some((sel) => ['.decs', '.dcard', '.dline', '.dline.dq', '.dline.opt', '.dline.rec'].includes(sel)))) {
    assert.doesNotMatch(r.body, /break-all|word-break:(?!\s*keep-all)/, r.sels.join(', ') + ': decision prose stays word-based (keep-all, never break-all)');
  }
});

test('an unbroken run wraps in the board answer controls: page.css breaks the confirm question, its quoted reply, the option buttons and the sent line anywhere outside .cv-page too; never break-all', () => {
  const m = clone(FIXTURE);
  const long = 'W'.repeat(120);
  m.sessions.find((x) => x.id === 's-a1').decisions.find((d) => d.id === 12).options.A.text = long;
  Object.assign(m.sessions.find((x) => x.id === 's-b2').decisions.find((d) => d.id === 11), { receipt: null, delivery: '대기: 작업이 끝나면 전달', answer: { option: '', text: long, at: 1 } });
  const html = loadView().renderOverview(m, { tab: 'wait', live: true, answers: { 12: { confirm: { text: long } } } });
  assert.match(html, /<span class="ans-q">(?:(?!<\/span>)[^])*<q class="ans-quote">W{40}…<\/q><\/span>/, 'the board confirm row quotes the reply inside .ans-q');
  assert.match(html, /<button type="button" class="ans-opt[^"]*"[^>]*><b>A<\/b> · W{120}/, 'an .ans-opt button carries the whole option text');
  assert.match(html, /<p class="dsent">(?:(?!<\/p>)[^])*<q class="ans-quote">W{40}…<\/q>/, 'the board sent line quotes the reply');
  const css = fs.readFileSync(path.join(ROOT, 'src/page/page.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((r) => ({ sels: r[1].split(',').map((x) => x.replace(/\s+/g, ' ').trim()), body: r[2] }));
  for (const sel of ['.ans-q', '.ans-quote', '.ans-opt', '.dsent']) {
    assert.ok(rules.some((r) => r.sels.includes(sel) && /overflow-wrap: anywhere/.test(r.body)), sel + ' breaks inside an unbroken run on the board too (the twin of the .cv-page rule in convo.css) instead of widening the decision card');
  }
  for (const file of fs.readdirSync(path.join(ROOT, 'src/page')).filter((f) => f.endsWith('.css'))) {
    const text = fs.readFileSync(path.join(ROOT, 'src/page', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const r of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/\.(?:ans-box|ans-opts|ans-confirm|ans-q|ans-quote|ans-opt|dsent)(?![\w-])/.test(r[1])) assert.doesNotMatch(r[2], /break-all|word-break:(?!\s*keep-all)/, file + ' ' + r[1].replace(/\s+/g, ' ').trim() + ': answer text stays word-based (keep-all, never break-all)');
    }
  }
});

test('page.css gives .sym one icon column and no fixed width; its icons are drawn in span.sym, no emoji left there', () => {
  for (const file of ['src/page/page.css', 'src/page/convo.css']) {
    const css = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/(^|[\s,>])\.sym(?![\w-])/.test(m[1])) assert.doesNotMatch(m[2], /(^|[\s;])width\s*:\s*(?!auto)/, `${file} ${m[1].trim()}: no fixed width`);
    }
  }
  assert.match(cssRule('src/page/page.css', '.sym'), /min-width: var\(--ic-md\)/, 'an ic-sm icon and a narrow • share one column');
  const html = loadView().renderOverview(FIXTURE, {});
  for (const name of ['file-text', 'circle-question-mark']) assert.ok(marks(html).includes('<span class="sym">[' + name + ']</span>'), name + ' is drawn in span.sym');
  assert.doesNotMatch(html, /<span class="sym">[^<]*\p{Extended_Pictographic}/u, 'no emoji in span.sym');
});

test('open question alert names the pane to answer in and stays read-only; old records fall back to the session pane', () => {
  const view = loadView();
  const model = clone(FIXTURE);
  const s = model.sessions.find((x) => x.openQuestion);
  s.openQuestion.paneId = 'pane-F1-original';
  let html = cards(view.renderOverview(model, { tab: 'wait' }))[s.id];
  let oq = html.slice(html.indexOf('class="oq"'), html.indexOf('</p>', html.indexOf('class="oq"')));
  assert.ok(oq.includes('질문 알림 열림 - '), 'alert says a question is open');
  assert.ok(oq.includes('pane-F1-original'), 'originating pane shown');
  assert.ok(oq.includes('에서 답하기'), 'says where to answer');
  assert.ok(oq.includes(s.openQuestion.text), 'question text kept');
  assert.ok(!oq.includes('<button') && !oq.includes('data-act'), 'read-only: no controls');
  // a record written before paneId existed in the model: use the session's own pane
  delete s.openQuestion.paneId;
  html = cards(view.renderOverview(model, { tab: 'wait' }))[s.id];
  oq = html.slice(html.indexOf('class="oq"'), html.indexOf('</p>', html.indexOf('class="oq"')));
  assert.ok(oq.includes(s.paneId) && oq.includes('에서 답하기'));
  // no pane known anywhere: still says to answer where the question was asked, never "undefined"
  delete s.paneId;
  html = cards(view.renderOverview(model, { tab: 'wait' }))[s.id];
  oq = html.slice(html.indexOf('class="oq"'), html.indexOf('</p>', html.indexOf('class="oq"')));
  assert.ok(oq.includes('질문이 뜬 창에서 답하기') && !/undefined|null/.test(oq));
});

// ---- answering from the board (server page: ui.live; page state ui.answers[id]) ----
const dcardOf = (html, id) => {
  const start = html.indexOf('data-decision="' + id + '"');
  return start < 0 ? '' : html.slice(start, html.indexOf('</div><!--dcard-->', start));
};
const liveCard = (view, model, id, answers = {}) => dcardOf(view.renderOverview(model, { tab: 'wait', live: true, answers }), id);

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
  assert.equal(count(dcardOf(view.renderOverview(FIXTURE, { tab: 'wait' }), 12), /class="dline/g), 8, 'the file card is unchanged');
});

test('the pending confirm names the receiving conversation and the choice; a reply confirm shows its first 40 characters', () => {
  const view = loadView();
  let c = liveCard(view, FIXTURE, 12, { 12: { confirm: { option: 'B' } } });
  const confirm = /<div class="ans-confirm"[\s\S]*?<\/div>/.exec(c)[0];
  assert.ok(marks(confirm).includes('[app-window] 수리 #181 '), 'herdr tab label and number');
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
  const lines = (answers) => cards(view.renderOverview(m, { tab: 'wait', live: true, answers }))['s-b2'].match(/<p class="dsent">[\s\S]*?<\/p>/g) || [];
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
  assert.ok(!view.renderOverview(m, { tab: 'wait' }).includes('class="dsent"'), 'never on the file page');
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
  assert.ok(marks(c).includes('[app-window] &lt;script&gt;x&lt;/script&gt; #181 '));
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
  assert.doesNotThrow(() => { html = view.renderOverview(m, { live: true, answers, tab: 'wait', expanded: { 'more-dc:s': true } }); });
  const ids = [...html.matchAll(/data-act="ans-pick"[^>]*data-id="([^"]*)"/g)].map((x) => x[1]);
  assert.deepEqual(ids.sort(), ['10', '9'], 'only object options become buttons, only under positive integer ids');
  for (const bad of ['0', '-3', '1.5', '7']) assert.ok(!html.includes('data-ans="' + bad + '"'), 'no controls for id ' + bad);
  assert.equal(count(html, /data-act="ans-reply"/g), 0, 'answerKinds that is not a list offers no reply box');
  for (const bad of [null, 'x', 5, []]) assert.equal(typeof view.renderOverview(m, { live: true, answers: bad, tab: 'wait' }), 'string');
});

// A6-01 (visual-qa I3): the visible word sits in span[role=status], which Chrome leaves out of the button's name, so the
// button names itself; the status label is feedback only
test('copy buttons name themselves (aria-label 복사), apart from the status label their feedback rewrites (A6-01)', () => {
  const view = loadView();
  assert.equal(view.kit.copyBtn('C:/a "b"'), '<button type="button" class="copy" data-copy="C:/a &quot;b&quot;" aria-label="복사" title="복사">' +
    '<svg class="ic ic-xs" aria-hidden="true" focusable="false"><use href="#i-copy"></use></svg> <span data-copy-label role="status">복사</span></button>');
  const html = view.renderOverview(FIXTURE, { expanded: expandAll(FIXTURE) });
  const buttons = html.match(/<button\b[^>]*\bdata-copy="[^"]*"[^>]*>/g) || [];
  assert.ok(buttons.length > 0, 'the overview draws copy buttons');
  for (const b of buttons) assert.match(b, /\baria-label="복사"/, b);
});

const cssRules = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((r) => ({ sels: r[1].split(',').map((x) => x.replace(/\s+/g, ' ').trim()), body: r[2] }));
const noComments = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// the inside of the one at-rule block that starts with head, and the stylesheet without it
function atBlock(css, head) {
  const i = css.indexOf(head);
  assert.ok(i >= 0, head);
  let depth = 0, j = css.indexOf('{', i);
  const open = j;
  for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}' && --depth === 0) break; }
  return { inside: css.slice(open + 1, j), outside: css.slice(0, i) + css.slice(j + 1) };
}

// B6-01: every text run of the open-question line used to be its own flex item, so at 390 they shrank into narrow columns
test('the open-question line is one sentence beside its icon: the row holds the icon and span.oq-b only; phones flow it inline (B6-01)', () => {
  const view = loadView();
  const model = clone(FIXTURE);
  model.sessions[0].openQuestion = { text: '문서 말투는 존댓말로 할까요?', at: model.generatedAt, paneId: 'p1' };
  const line = /<p class="oq">([\s\S]*?)<\/p>/.exec(view.renderOverview(model, {}));
  assert.ok(line, 'the board card draws the open-question line');
  assert.match(marks(line[1]), /^<span class="sym">\[circle-question-mark\]<\/span><span class="oq-b">질문 알림 열림 - [\s\S]*<span class="oq-t">문서 말투는 존댓말로 할까요\?<\/span> <span class="time">[\s\S]*<\/span>$/);
  const css = noComments('src/page/page.css'), phone = atBlock(css, '@media (max-width: 599px)');
  const wide = cssRules(phone.outside).filter((r) => r.sels.includes('.oq-b'));
  assert.deepEqual(wide.map((r) => r.body.trim()), ['display: contents;'], 'wider screens: no box of its own, the row lays out exactly as before');
  const narrow = cssRules(phone.inside).filter((r) => r.sels.includes('.oq-b'));
  assert.equal(narrow.length, 1);
  assert.match(narrow[0].body, /display: block;/);
  assert.match(narrow[0].body, /min-width: 0;/);
  assert.ok(cssRules(phone.inside).some((r) => r.sels.includes('.oq-b code') && /word-break: keep-all/.test(r.body)), 'the location keeps its Korean words whole');
});

// B6-02 (D1): at <= 599 px every phone control is a 44 px target; the compact boxes stay on wider screens
test('phone targets: card detail and expansion buttons and the annotation tray actions are 44 px below 600 px only (B6-02)', () => {
  const big = (css, sel) => cssRules(css).some((r) => r.sels.includes(sel) && /min-height: (?:44px|var\(--hit\))/.test(r.body) && /min-width: (?:44px|var\(--hit\))/.test(r.body));
  const page = atBlock(noComments('src/page/page.css'), '@media (max-width: 599px)');
  const ann = atBlock(noComments('src/page/annotate.css'), '@media (max-width: 599px)');
  for (const sel of ['.more', '.detail-btn']) assert.ok(big(page.inside, sel), sel + ' is a 44 px phone target');
  assert.ok(big(ann.inside, '.tray .ann-btn'), 'the tray actions (목록 보기, 모두 지우기, Markdown 복사, send) are 44 px phone targets');
  for (const [css, sel] of [[page.outside, '.more'], [page.outside, '.detail-btn'], [ann.outside, '.tray .ann-btn'], [ann.outside, '.ann-btn']]) {
    assert.equal(big(css, sel), false, sel + ' keeps its compact box on wider screens');
  }
});

// todo 2: each of the five reviewed hostile strings is placed in every named overview surface at once, and
// each surface's own element must carry it as text - page-wide membership could let one surface hide another
test('hostile fixture strings stay text per surface: title, headline, decision question/option and input-field label', () => {
  const view = loadView();
  const H = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/hostile-strings.json'), 'utf8'));
  const esc = view.escapeHtml;
  const one = (html, re, what) => {
    const all = [...html.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
    assert.equal(all.length, 1, 'exactly one ' + what);
    return all[0][1];
  };
  const build = (s) => {
    const m = clone(FIXTURE);
    const sess = m.sessions.find((x) => x.decisions.some((d) => !d.answered && !d.closed));
    sess.tab = '나를 기다림';
    sess.title = s;
    sess.headline = s;
    const d = sess.decisions.find((x) => !x.answered && !x.closed);
    d.question = s;
    d.options = { A: { text: s, consequence: '결과' }, B: { text: '다른 안', consequence: '결과' } };
    d.fields = [{ id: 'name', label: s, kind: 'text', maxLen: 200 }];
    return m;
  };
  const ui = (m) => ({ tab: 'wait', live: true, expanded: expandAll(m) });
  const realTags = (html) => count(html, /<(b|script|img|svg|textarea)[\s>\/]/gi);
  // an event attribute counts only outside quoted values: escaped text inside title="..." is text, not an attribute
  const eventAttrs = (html) => count(html.replace(/="[^"]*"/g, '=""'), /<[a-z][^>]*\son[a-z]+\s*=/gi);
  for (const s of H) {
    const model = build(s);
    const sess = model.sessions.find((x) => x.title === s);
    const d = sess.decisions.find((x) => x.question === s);
    const html = view.renderOverview(model, ui(model));
    const want = esc(s);
    const card = one(html, new RegExp('<article class="card[^"]*"[^>]*data-card="' + sess.id + '">([\\s\\S]*?)<\\/article>'),
      'card for ' + sess.id);
    assert.ok(one(card, /<span class="title">([\s\S]*?)<\/span>/, 'title element').includes(want), 'title: ' + s);
    assert.ok(one(card, /<p class="hl">([\s\S]*?)<\/p>/, 'headline element').includes(want), 'headline: ' + s);
    const dcard = one(card, new RegExp('<div class="dcard[^"]*" data-decision="' + d.id + '">([\\s\\S]*?)<\\/div><!--dcard-->'),
      'decision card #' + d.id);
    assert.ok(one(dcard, /<div class="dline dq">([\s\S]*?)<\/div>/, 'decision question line').includes(want),
      'decision question: ' + s);
    // a decision with input fields draws its option text as the card's option line (the answer box is the field grid)
    const optLines = [...dcard.matchAll(/<div class="dline opt[^"]*">([\s\S]*?)<\/div>/g)];
    assert.equal(optLines.length, 2, 'two option lines are drawn');
    assert.ok(optLines[0][1].includes(want), 'option A: ' + s);
    assert.equal(one(dcard, new RegExp('<label for="field-' + d.id + '-dc-name">([^<]*)<\\/label>'), 'input-field label'),
      want, 'input-field label: ' + s);
    const neutralModel = build('NEUTRAL');
    const neutral = view.renderOverview(neutralModel, ui(neutralModel));
    // injected markup would add a real tag or an event attribute; escaped text adds neither
    assert.deepEqual([realTags(html), eventAttrs(html)], [realTags(neutral), eventAttrs(neutral)],
      'structure matches NEUTRAL: ' + s);
  }
});
