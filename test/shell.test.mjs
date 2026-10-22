import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v)); // vm-realm objects -> this realm
const esc = (v) => String(v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]);
const DAY = 24 * 3600 * 1000;
const NOW = 1792170000000; // injected clock; nothing in shell.js reads the real one
const HOSTILE = '<img src=x onerror="alert(1)">\'`&';
const GONE = '(지금 안 보임)';

// Each test gets its own realm; extra = globals such as BriefAlarm or a console that records warnings. icons.js comes
// first, as render.mjs inlines it.
function load(extra = {}, files = ['src/page/icons.js', 'src/page/shell.js']) {
  const ctx = vm.createContext({ ...extra });
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  assert.equal(typeof ctx.BriefShell?.reduce, 'function');
  return ctx;
}

function fixture() {
  return {
    generatedAt: NOW,
    sessions: [
      {
        id: 'a185', alive: true, tabId: 'tab-185', tabNumber: 185, tabLabel: '상황판제작', title: '상황판 v5 셸', headline: '레일과 탭 바를 만드는 중',
        tab: '나를 기다림', status: 'in_progress', statusKey: 'needs_decision', lastActivityAt: NOW - 60e3,
        decisions: [
          { id: 101, question: '색은 어떻게 할까?', options: { A: { text: '기존 토큰' }, B: { text: '새 팔레트' } }, recommend: 'A', blocks: true, createdAt: NOW - 120e3, answered: false, closed: false },
          { id: 102, question: '탭 고정은?', options: { A: { text: '두 번 누르기' } }, createdAt: NOW - 90e3, answered: false, closed: false },
          { id: 90, question: '사이드바 기본 폭?', options: { A: { text: '260px' }, B: { text: '300px' } }, answered: true, closed: true, answer: { option: 'A', at: NOW - 5 * 60e3 }, delivery: '전달됨 ⏱11:58' },
          { id: 95, question: '보류한 질문', options: { A: { text: 'x' } }, answered: false, closed: true, held: true },
          'garbage', null,
        ],
        plan: { goal: '보드 다시 짜기', source: { slug: 'briefing-board-redesign' }, tasks: [{ id: '1', state: 'done' }, { id: '2', state: 'done' }, { id: '3', state: 'doing' }] },
        live: { workers: [{ id: 'w1', state: 'running' }, { id: 'w2', state: 'done' }] },
      },
      {
        id: 'p185', alive: false, tabId: 'tab-185', tabNumber: 185, tabLabel: '상황판제작', title: HOSTILE + ' 옛 대화', headline: '옛 대화',
        tab: '끝남', status: 'done', statusKey: 'done', lastActivityAt: NOW - 3 * 3600e3, decisions: [],
      },
      {
        id: 'c184', alive: true, tabId: 'tab-184', tabNumber: 184, tabLabel: HOSTILE, title: HOSTILE + ' 제목', headline: HOSTILE + ' 헤드라인',
        tab: '나를 기다림', status: 'blocked', statusKey: 'blocked', lastActivityAt: NOW - 30 * 60e3, decisions: [],
      },
      {
        id: 'd012', alive: true, tabId: 'tab-12', tabNumber: 12, tabLabel: 'Docs', title: 'Docs pass', headline: 'README 손보는 중',
        tab: '진행 중', status: 'in_progress', statusKey: 'in_progress', lastActivityAt: NOW - 10 * 60e3, decisions: [],
        workName: 'docs-plan', auto: { stage: 'running', todoDone: 1, todoTotal: 4 },
      },
      {
        id: 'e-done', alive: false, tabId: '', tabNumber: null, tabLabel: '', title: '끝난 설치 작업', headline: '설치 끝, 결과 확인 필요',
        tab: '끝남', status: 'done', statusKey: 'recheck', lastActivityAt: NOW - 2 * 3600e3,
        decisions: [{ id: 80, question: '설치할까?', options: { A: { text: '지금' } }, answered: true, closed: true, answer: { text: '내일 해 줘' }, delivery: '전달 중' }],
      },
      {
        id: 'f-q', alive: false, tabId: 'tab-99', tabNumber: 99, title: '질문 기다리는 대화', headline: '파일을 골라야 함',
        tab: '나를 기다림', status: 'in_progress', statusKey: 'in_progress', lastActivityAt: NOW - 45 * 60e3, decisions: [],
        openQuestion: { text: '어느 파일?', at: NOW - 40 * 60e3 },
      },
      { id: 'g-old', alive: false, tabId: '', title: '오래전 끝난 일', headline: '정리 완료', tab: '끝남', status: 'done', statusKey: 'done', lastActivityAt: NOW - 5 * DAY, decisions: [] },
      'not a session', { id: '' }, { title: 'no id' },
    ],
  };
}
const IDS = ['a185', 'p185', 'c184', 'd012', 'e-done', 'f-q', 'g-old'];
const PREFS = { favs: ['d012', 'gone-1'], tabs: ['a185', 'c184', 'gone-1'], active: 'a185', seen: { 'e-done': NOW - DAY, 'g-old': NOW - 3600e3 } };
const base = (S, prefs = PREFS) => S.reduce(undefined, { type: 'load', json: JSON.stringify(prefs), known: IDS, now: NOW });
const saved = (S, st) => JSON.parse(S.serialize(st));
const DEFAULT_SAVED = { sideOpen: true, sideWidth: 260, view: 'conv', filter: 'all', favs: [], tabs: [], pinned: [], active: null, sub: {}, seen: {}, absent: {} };

// html probes
const all = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
// icons.js markup -> [name]: which icon is drawn where
const marks = (html) => html.replace(/<svg class="ic[^"]*" aria-hidden="true" focusable="false"><use href="#i-([a-z0-9-]+)"><\/use><\/svg>/g, '[$1]');
const headings = (html) => all(html, /class="sh-sht">([^<]*)</g);
function sections(html) {
  const out = {};
  for (const chunk of html.split('<div class="sh-sec"').slice(1)) {
    const key = /^ data-sec="([^"]+)"/.exec(chunk)?.[1] ?? 'archive-link';
    out[key] = all(chunk, /data-row="([^"]*)"/g);
  }
  return out;
}
const tabOrder = (html) => all(html, /class="tb[^"]*" data-tab="([^"]*)"/g);
const activeTab = (html) => /class="tb on[^"]*" data-tab="([^"]*)"/.exec(html)?.[1] ?? null;
const items = (html) => all(html, /class="sh-it[^"]*" data-sh="open" data-sid="([^"]*)"/g);
const kinds = (html) => all(html, /class="sh-k">([^<]*)</g);

// ---- reducer ------------------------------------------------------------------------------------------------------

test('reduce: toggleSide flips the docked sidebar, and the overlay when narrow', () => {
  const S = load().BriefShell;
  const st = S.defaults();
  const closed = S.reduce(st, { type: 'toggleSide' });
  assert.equal(closed.sideOpen, false);
  assert.equal(S.reduce(closed, { type: 'toggleSide' }).sideOpen, true);
  const peeked = S.reduce(S.reduce(closed, { type: 'peek' }), { type: 'toggleSide' });
  assert.equal(peeked.peek, false, 'toggling from the peek panel docks it and drops the peek');
  const overlay = S.reduce(st, { type: 'toggleSide', narrow: true });
  assert.deepEqual([overlay.sideOpen, overlay.peek], [true, true]);
  assert.equal(S.reduce(overlay, { type: 'toggleSide', narrow: true }).peek, false);
});

test('reduce: peek only over a closed sidebar, unpeek closes it, no-ops keep the same state object', () => {
  const S = load().BriefShell;
  const open = S.defaults();
  assert.equal(S.reduce(open, { type: 'peek' }), open);
  const closed = S.reduce(open, { type: 'toggleSide' });
  const peek = S.reduce(closed, { type: 'peek' });
  assert.equal(peek.peek, true);
  assert.equal(S.reduce(peek, { type: 'peek' }), peek);
  const unpeek = S.reduce(peek, { type: 'unpeek' });
  assert.equal(unpeek.peek, false);
  assert.equal(S.reduce(unpeek, { type: 'unpeek' }), unpeek);
});

test('reduce: resize clamps 199 -> 200 and 481 -> 480 and ignores NaN or non-numbers', () => {
  const S = load().BriefShell;
  const st = S.defaults();
  assert.equal(S.reduce(st, { type: 'resize', px: 199 }).sideWidth, 200);
  assert.equal(S.reduce(st, { type: 'resize', px: 481 }).sideWidth, 480);
  assert.equal(S.reduce(st, { type: 'resize', px: 333.4 }).sideWidth, 333);
  for (const px of [NaN, Infinity, -Infinity, '300', null, undefined, {}]) assert.equal(S.reduce(st, { type: 'resize', px }), st, String(px));
});

test('reduce: view switches the one sidebar column, opens it, and refuses unknown keys', () => {
  const S = load().BriefShell;
  const closed = S.reduce(S.defaults(), { type: 'toggleSide' });
  const inbox = S.reduce(closed, { type: 'view', key: 'inbox', box: 'done' });
  assert.deepEqual([inbox.view, inbox.box, inbox.sideOpen, inbox.peek], ['inbox', 'done', true, false]);
  assert.equal(S.reduce(inbox, { type: 'view', key: 'home', box: 'nope' }).box, 'done', 'unknown inbox sub-tab ignored');
  for (const key of ['nope', '__proto__', 'constructor', '', 7]) assert.equal(S.reduce(closed, { type: 'view', key }), closed, String(key));
  const narrow = S.reduce(closed, { type: 'view', key: 'archive', narrow: true });
  assert.deepEqual([narrow.view, narrow.sideOpen, narrow.peek], ['archive', false, true], 'narrow: the overlay opens, the docked state stays');
  for (const key of ['conv', 'inbox', 'plans', 'home', 'archive', 'settings']) assert.equal(S.reduce(closed, { type: 'view', key }).view, key);
});

test('reduce: filter, search, fav and expand', () => {
  const S = load().BriefShell;
  const st = S.defaults();
  assert.equal(S.reduce(st, { type: 'filter', key: 'wait' }).filter, 'wait');
  assert.equal(S.reduce(st, { type: 'filter', key: 'bogus' }), st);
  assert.equal(S.reduce(st, { type: 'search', text: 'Docs' }).search, 'Docs');
  assert.equal(S.reduce(st, { type: 'search', text: 42 }), st);
  assert.equal(Array.from(S.reduce(st, { type: 'search', text: '가'.repeat(300) }).search).length, 200);
  const fav = S.reduce(st, { type: 'fav', sid: 'a185' });
  assert.deepEqual(plain(fav.favs), ['a185']);
  assert.deepEqual(plain(S.reduce(fav, { type: 'fav', sid: 'a185' }).favs), []);
  for (const sid of ['', 5, 'a\nb', 'x'.repeat(257), null]) assert.equal(S.reduce(st, { type: 'fav', sid }), st, JSON.stringify(sid));
  const ex = S.reduce(st, { type: 'expand', sid: 'a185' });
  assert.equal(ex.exp.a185, true);
  assert.equal(S.reduce(ex, { type: 'expand', sid: 'a185' }).exp.a185, false);
  assert.equal(S.reduce(st, { type: 'expand', sid: 'sec:recent' }).exp['sec:recent'], true, '최근 항목 starts folded');
  assert.equal(S.reduce(st, { type: 'expand', sid: 'sec:tabs' }).exp['sec:tabs'], false, '열린 탭 starts open');
  assert.equal(S.reduce(st, { type: 'expand', sid: '' }), st);
});

test('reduce: open adds and activates a tab once, keeps its sub-tab, stamps seen and drops the peek', () => {
  const S = load().BriefShell;
  let st = S.reduce(S.reduce(S.defaults(), { type: 'toggleSide' }), { type: 'peek' });
  st = S.reduce(st, { type: 'open', sid: 'a185', sub: 'dec', now: NOW });
  assert.deepEqual(plain(st.tabs), ['a185']);
  assert.equal(st.active, 'a185');
  assert.equal(st.sub.a185, 'dec');
  assert.equal(st.seen.a185, NOW);
  assert.equal(st.exp.a185, true);
  assert.equal(st.peek, false);
  st = S.reduce(st, { type: 'open', sid: 'd012', sub: 'zzz' });
  assert.equal(st.sub.d012, undefined, 'unknown sub-tab is not stored');
  st = S.reduce(st, { type: 'open', sid: 'a185', now: NOW + 5 });
  assert.deepEqual(plain(st.tabs), ['a185', 'd012'], 'no duplicate tab');
  assert.deepEqual([st.active, st.sub.a185, st.seen.a185], ['a185', 'dec', NOW + 5]);
  assert.equal(S.reduce(st, { type: 'open', sid: '' }), st);
});

test('reduce: closing the active tab activates the previous one; other closes keep the active tab', () => {
  const S = load().BriefShell;
  let st = S.defaults();
  for (const sid of ['a', 'b', 'c', 'd']) st = S.reduce(st, { type: 'open', sid });
  st = S.reduce(st, { type: 'active', sid: 'c' });
  const closedC = S.reduce(st, { type: 'close', sid: 'c' });
  assert.deepEqual([plain(closedC.tabs), closedC.active], [['a', 'b', 'd'], 'b']);
  const closedA = S.reduce(st, { type: 'close', sid: 'a' });
  assert.deepEqual([plain(closedA.tabs), closedA.active], [['b', 'c', 'd'], 'c']);
  const first = S.reduce(S.reduce(st, { type: 'active', sid: 'a' }), { type: 'close', sid: 'a' });
  assert.equal(first.active, 'b', 'the first tab has no previous: the next one takes over');
  let one = S.reduce(S.defaults(), { type: 'open', sid: 'solo' });
  one = S.reduce(one, { type: 'close', sid: 'solo' });
  assert.deepEqual([plain(one.tabs), one.active], [[], null]);
  assert.equal(S.reduce(st, { type: 'close', sid: 'zz' }), st);
  // by display order: pinned d sits first, so closing active a (now second) activates d
  const pinned = S.reduce(S.reduce(S.reduce(st, { type: 'pin', sid: 'd' }), { type: 'active', sid: 'a' }), { type: 'close', sid: 'a' });
  assert.equal(pinned.active, 'd');
  const unpinned = S.reduce(S.reduce(st, { type: 'pin', sid: 'b' }), { type: 'close', sid: 'b' });
  assert.deepEqual(plain(unpinned.pinned), [], 'a closed tab is no longer pinned');
  const html = S.tabs(fixture(), closedC);
  assert.equal(activeTab(html), 'b');
});

test('reduce: pin toggles, pinned tabs sort first in pin order, and only open tabs pin', () => {
  const S = load().BriefShell;
  let st = S.defaults();
  for (const sid of ['a185', 'c184', 'd012']) st = S.reduce(st, { type: 'open', sid });
  assert.deepEqual(tabOrder(S.tabs(fixture(), st)), ['a185', 'c184', 'd012']);
  st = S.reduce(st, { type: 'pin', sid: 'd012' });
  assert.deepEqual(plain(S.order(st)), ['d012', 'a185', 'c184']);
  const html = S.tabs(fixture(), st);
  assert.deepEqual(tabOrder(html), ['d012', 'a185', 'c184'], 'the pin re-sorts the tab bar');
  assert.match(marks(html), /class="tb[^"]* pinned" data-tab="d012"[^>]*><button[^>]*><span class="tb-pin"[^>]*>\[pin\]<\/span>/);
  st = S.reduce(st, { type: 'pin', sid: 'a185' });
  assert.deepEqual(tabOrder(S.tabs(fixture(), st)), ['d012', 'a185', 'c184']);
  st = S.reduce(st, { type: 'pin', sid: 'd012' });
  assert.deepEqual(tabOrder(S.tabs(fixture(), st)), ['a185', 'c184', 'd012'], 'unpinning puts the tab back in opening order');
  assert.equal(S.reduce(st, { type: 'pin', sid: 'not-open' }), st);
});

test('reduce: active only switches to open tabs; unknown actions and junk return the same state', () => {
  const S = load().BriefShell;
  let st = S.reduce(S.reduce(S.defaults(), { type: 'open', sid: 'a' }), { type: 'open', sid: 'b' });
  const act = S.reduce(st, { type: 'active', sid: 'a', now: NOW });
  assert.deepEqual([act.active, act.seen.a], ['a', NOW]);
  assert.equal(S.reduce(st, { type: 'active', sid: 'zzz' }), st);
  for (const a of [null, undefined, 5, 'toggleSide', {}, { type: 'nope' }, { type: '__proto__' }]) assert.equal(S.reduce(st, a), st, JSON.stringify(a));
  assert.deepEqual(saved(S, S.reduce(null, { type: 'nope' })), DEFAULT_SAVED, 'a missing state means the defaults');
});

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

test('reduce is pure: a deep-frozen state survives every action unchanged', () => {
  const S = load().BriefShell;
  let st = base(S);
  st = S.reduce(st, { type: 'pin', sid: 'c184' });
  const before = plain(st);
  deepFreeze(st);
  const actions = [
    { type: 'toggleSide' }, { type: 'toggleSide', narrow: true }, { type: 'peek' }, { type: 'unpeek' }, { type: 'resize', px: 300 },
    { type: 'view', key: 'inbox', box: 'ans' }, { type: 'filter', key: 'run' }, { type: 'search', text: 'x' }, { type: 'fav', sid: 'a185' },
    { type: 'expand', sid: 'a185' }, { type: 'open', sid: 'e-done', sub: 'plan', now: NOW }, { type: 'close', sid: 'a185' },
    { type: 'pin', sid: 'a185' }, { type: 'active', sid: 'c184', now: NOW }, { type: 'known', ids: ['a185'], now: NOW + 40 * DAY },
    { type: 'load', json: '{}', known: IDS, now: NOW },
  ];
  for (const a of actions) assert.doesNotThrow(() => S.reduce(st, a), a.type);
  assert.deepEqual(plain(st), before);
});

// ---- prefs (C-UI) ---------------------------------------------------------------------------------------------------

test('load reads every C-UI field and serialize writes exactly the C-UI keys', () => {
  const S = load().BriefShell;
  const prefs = {
    sideOpen: false, sideWidth: 333, view: 'plans', filter: 'done', favs: ['d012'], tabs: ['a185', 'c184'], pinned: ['c184'],
    active: 'c184', sub: { a185: 'wk' }, seen: { 'g-old': NOW - 3600e3 }, absent: {},
  };
  const st = S.reduce(undefined, { type: 'load', json: JSON.stringify(prefs), known: IDS, now: NOW });
  assert.equal(st.prefsError, '');
  assert.deepEqual(saved(S, st), prefs);
  assert.deepEqual(Object.keys(saved(S, st)), ['sideOpen', 'sideWidth', 'view', 'filter', 'favs', 'tabs', 'pinned', 'active', 'sub', 'seen', 'absent']);
  const again = S.reduce(undefined, { type: 'load', json: S.serialize(st), known: IDS, now: NOW });
  assert.deepEqual(saved(S, again), prefs, 'round trip');
  assert.equal(S.KEY, 'omo-briefing.ui.v1');
});

test('load keeps ids missing from the model as (지금 안 보임) and prunes them only after 30 days of absence', () => {
  const S = load().BriefShell;
  const model = fixture();
  let st = S.reduce(undefined, {
    type: 'load', known: IDS, now: NOW,
    json: JSON.stringify({ tabs: ['a185', 'gone-1'], pinned: ['gone-1'], favs: ['gone-1'], active: 'gone-1', sub: { 'gone-1': 'dec' }, seen: { 'gone-1': NOW - 40 * DAY } }),
  });
  assert.equal(st.absent['gone-1'], NOW, 'first missing now');
  assert.deepEqual(plain(st.tabs), ['a185', 'gone-1']);
  const bar = S.tabs(model, st);
  assert.match(bar, /class="tb on pinned sh-gone" data-tab="gone-1" title="\(지금 안 보임\) · gone-1 \(두 번 누르면 탭 고정 풀기\)">/);
  assert.match(bar, /<span class="tt">\(지금 안 보임\)<\/span>/);
  assert.match(S.side(model, st), /<span class="sh-t" title="\(지금 안 보임\) · gone-1">\(지금 안 보임\)<\/span>/);

  const day30 = S.reduce(st, { type: 'known', ids: IDS, now: NOW + 30 * DAY });
  assert.equal(day30, st, 'exactly 30 days: still kept, nothing changes');
  const back = S.reduce(st, { type: 'known', ids: [...IDS, 'gone-1'], now: NOW + 10 * DAY });
  assert.deepEqual(plain(back.absent), {}, 'it came back: no longer absent');
  assert.equal(S.reduce(back, { type: 'known', ids: IDS, now: NOW + 40 * DAY }).absent['gone-1'], NOW + 40 * DAY, 'a new absence starts a new clock');

  const pruned = S.reduce(st, { type: 'known', ids: IDS, now: NOW + 30 * DAY + 1 });
  assert.deepEqual(saved(S, pruned), { ...DEFAULT_SAVED, tabs: ['a185'], active: 'a185' });
  assert.doesNotMatch(S.tabs(model, pruned) + S.side(model, pruned), /지금 안 보임/);

  const stale = S.reduce(undefined, { type: 'load', known: IDS, now: NOW, json: JSON.stringify({ favs: ['gone-2'], absent: { 'gone-2': NOW - 31 * DAY } }) });
  assert.deepEqual(plain(stale.favs), [], 'a stored absence older than 30 days is pruned at load');
  assert.equal(S.reduce(st, { type: 'known', ids: 'nope', now: NOW + 99 * DAY }), st, 'no id list: nothing is judged');
  assert.equal(S.reduce(st, { type: 'known', ids: IDS }), st, 'no clock: nothing is judged');
});

test('regression R1: first start and unusable prefs mark nothing seen; unopened finished conversations stay in 끝남 확인', () => {
  const S = load().BriefShell;
  const one = { generatedAt: NOW, sessions: [{ id: 'done', title: 'Unread result', tab: '끝남', status: 'done', lastActivityAt: NOW - 1, decisions: [] }] };
  for (const json of [null, '', '{bad', '[]', '{}']) {
    const st = S.reduce(undefined, { type: 'load', json, known: ['done'], now: NOW });
    assert.deepEqual(plain(st.seen), {}, JSON.stringify(json));
    assert.deepEqual(plain(S.inbox(one, st).done.map((x) => x.s.id)), ['done'], JSON.stringify(json));
    assert.equal(S.badge(one, st), 1, JSON.stringify(json));
  }
  const fresh = S.reduce(undefined, { type: 'load', json: null, known: IDS, now: NOW });
  assert.deepEqual(plain(S.inbox(fixture(), fresh).done.map((x) => x.s.id)), ['e-done', 'p185', 'g-old'], 'every finished conversation counts until opened');
  assert.equal(S.badge(fixture(), fresh), 7);
  const opened = S.reduce(fresh, { type: 'open', sid: 'e-done', now: NOW + 1 });
  assert.deepEqual(plain(opened.seen), { 'e-done': NOW + 1 }, 'seen holds only what the owner opened');
  assert.equal(S.badge(fixture(), opened), 6);
  assert.deepEqual(plain(S.reduce(opened, { type: 'active', sid: 'e-done', now: NOW + 2 }).seen), { 'e-done': NOW + 2 });
});

test('regression R2: everything the reducer can create survives a reload; lists stop at the same cap in both places', () => {
  const S = load().BriefShell;
  let st = S.defaults();
  for (let i = 0; i < 201; i++) {
    st = S.reduce(st, { type: 'open', sid: 's' + i, sub: 'dec', now: NOW });
    st = S.reduce(st, { type: 'fav', sid: 's' + i });
  }
  st = S.reduce(st, { type: 'known', ids: [], now: NOW }); // every id missing from the model from now on
  const again = S.reduce(undefined, { type: 'load', json: S.serialize(st), known: [], now: NOW + 1 });
  assert.deepEqual(saved(S, again), saved(S, st), 'a reload 1 ms later keeps every tab, favourite, sub, seen and absent stamp and the active tab');
  assert.deepEqual([st.tabs.length, st.favs.length, st.active, again.active], [200, 200, 's199', 's199'], 'the 201st tab and favourite are refused when made');
  assert.equal(S.LIST_MAX, 200);
  assert.equal(S.reduce(st, { type: 'open', sid: 'one-more', now: NOW }), st, 'a refused open changes nothing');
  assert.equal(S.reduce(st, { type: 'open', sid: 's5', now: NOW }).active, 's5', 'switching to an open tab still works at the cap');
  assert.equal(S.reduce(st, { type: 'fav', sid: 's5' }).favs.length, 199, 'un-starring still works at the cap');
  // maps grow with history (one entry per conversation ever opened), not with one screen: no cap, exact round trip
  let big = S.defaults();
  for (let i = 0; i < 600; i++) big = S.reduce(S.reduce(big, { type: 'open', sid: 'h' + i, sub: 'plan', now: NOW + i }), { type: 'close', sid: 'h' + i });
  big = S.reduce(big, { type: 'known', ids: [], now: NOW + 1000 });
  const big2 = S.reduce(undefined, { type: 'load', json: S.serialize(big), known: [], now: NOW + 2000 });
  assert.deepEqual(saved(S, big2), saved(S, big));
  assert.equal(Object.keys(plain(big2.seen)).length, 600);
  // a stored list longer than the reducer can make is cut at the same cap, and the load says so
  const tabs = Array.from({ length: 30000 }, (_, i) => 'id-' + i);
  const cut = S.reduce(undefined, { type: 'load', json: JSON.stringify({ tabs, favs: tabs, pinned: ['id-0', 'id-29999'], active: 'id-29999' }), known: [], now: NOW });
  assert.deepEqual([cut.tabs.length, cut.tabs[199], cut.favs.length, plain(cut.pinned), cut.active, cut.prefsError], [200, 'id-199', 200, ['id-0'], null, 'trimmed']);
});

test('failure: a corrupted omo-briefing.ui.v1 falls back to the defaults without throwing', () => {
  const S = load().BriefShell;
  const cases = [
    ['{"sideOpen": fal', 'corrupt'],
    ['\u0000\u0001 not json', 'corrupt'],
    ['[1,2,3]', 'shape'],
    ['"a string"', 'shape'],
    ['null', 'shape'],
    ['5', 'shape'],
  ];
  for (const [json, why] of cases) {
    let st;
    assert.doesNotThrow(() => { st = S.reduce(undefined, { type: 'load', json, known: IDS, now: NOW }); }, why);
    assert.equal(st.prefsError, why, json.slice(0, 20));
    assert.deepEqual(saved(S, st), DEFAULT_SAVED, json.slice(0, 20));
    assert.doesNotThrow(() => S.rail(fixture(), st) + S.side(fixture(), st) + S.tabs(fixture(), st) + S.sideFrame(st));
  }
  // foreign-typed fields fall back one by one; the valid ones survive
  const foreign = {
    sideOpen: 'yes', sideWidth: 'wide', view: 'main', filter: ['wait'], favs: 'a185', tabs: [1, {}, 'a185', 'a185', '', 'x\ny', 'c184'],
    pinned: ['zzz', 'c184'], active: 'zzz', sub: { a185: 'dec', c184: 'bogus', constructor: 'plan' },
    seen: { a185: 'yesterday', c184: -5, d012: NOW }, absent: [], extra: { deep: true },
  };
  const json = JSON.stringify(foreign).replace('"sub":{', '"sub":{"__proto__":"dec",');
  assert.match(json, /"sub":\{"__proto__":"dec","a185"/);
  const st = S.reduce(undefined, { type: 'load', json, known: IDS, now: NOW });
  assert.equal(st.prefsError, '');
  assert.deepEqual(saved(S, st), {
    ...DEFAULT_SAVED, tabs: ['a185', 'c184'], pinned: ['c184'], sub: { a185: 'dec', constructor: 'plan' }, seen: { d012: NOW },
    absent: { constructor: NOW }, // a remembered key the model does not have: kept and stamped like any missing id
  });
  assert.equal(Object.getPrototypeOf(st.sub), null, 'id maps have no prototype to pollute');
  assert.equal(Object.hasOwn(JSON.parse(S.serialize(st)).sub, '__proto__'), false, '__proto__ is never taken as an id');
});

test('persist and restore use only omo-briefing.ui.v1 and never throw on blocked storage', () => {
  const warns = [];
  const ctx = load({ console: { warn: (...a) => warns.push(a.map(String).join(' ')) } });
  const S = ctx.BriefShell;
  const writes = [];
  const store = { getItem: (k) => (k === 'omo-briefing.ui.v1' ? '{"view":"home"}' : null), setItem: (k, v) => writes.push([k, v]) };
  assert.equal(S.restore(store), '{"view":"home"}');
  assert.equal(S.persist(store, S.defaults()), true);
  assert.deepEqual(writes.map((w) => w[0]), ['omo-briefing.ui.v1']);
  assert.deepEqual(JSON.parse(writes[0][1]), DEFAULT_SAVED);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.equal(S.restore(blocked), null);
  assert.equal(S.persist(blocked, S.defaults()), false);
  assert.equal(S.restore(null), null);
  assert.equal(warns.length, 2, warns.join('\n'));
  const src = read('src/page/shell.js');
  assert.equal((src.match(/\.(?:setItem|getItem|removeItem)\(/g) || []).length, 2);
  assert.equal((src.match(/\.(?:setItem|getItem)\(KEY\b/g) || []).length, 2, 'every storage call uses KEY');
  assert.match(S.KEY, /^omo-briefing\./);
});

// ---- rail, sidebar views, tab bar ---------------------------------------------------------------------------------

test('rail: home first, then every destination, a spacer and settings; sidebar controls stay in its header and the tab bar', () => {
  const S = load().BriefShell;
  const st = base(S);
  const html = S.rail(fixture(), st);
  assert.equal(all(marks(html), /class="sh-ri"[^>]*>([^<]*)</g).join(' '),
    '[house] [message-square] [inbox] [list-todo] [lightbulb] [archive] [settings]');
  assert.equal((html.match(/class="ic ic-rail"/g) || []).length, 6, 'rail-sized icons');
  assert.match(html, /data-key="conv"[^>]*><span class="sh-ri" aria-hidden="true"><svg class="ic ic-rail ic-sel"/, 'the selected view: a heavier stroke');
  assert.equal((html.match(/ic-sel/g) || []).length, 1);
  assert.doesNotMatch(html, /data-sh="toggleSide"/);
  assert.match(marks(S.sideFrame(st)), /data-sh="toggleSide"[^>]*>\[panel-left-close\]/, 'the header control closes');
  assert.match(marks(S.tabs(fixture(), S.reduce(st, { type: 'toggleSide' }))), /^<button[^>]*class="sh-topen"[^>]*>\[panel-left-open\]/, 'the tab-bar control opens');
  assert.deepEqual(all(html, /class="sh-tip"[^>]*>([^<]*)</g), ['홈', '대화', '수신함', '계획', '메멘토', '닫힌 창', '설정']);
  assert.match(html, /data-key="inbox" aria-label="수신함 6개"/, 'the count is spoken, not shown in the tooltip');
  assert.match(marks(html), /\[archive\]<\/span><span class="sh-tip"[^>]*>닫힌 창<\/span><\/button><span class="sh-rsp" aria-hidden="true"><\/span><button[^>]*data-key="settings"/);
  assert.match(html, /<span class="sh-n" aria-hidden="true">6<\/span>/);
  assert.match(html, /class="sh-rb on" data-sh="view" data-key="conv"/);
  assert.equal((html.match(/<button /g) || []).length, 7, 'every destination, no rail toggle or second panel');
});

test('regression R4: the inbox tooltip is exactly 수신함 while its badge carries the count', () => {
  const S = load().BriefShell;
  const vm = { sessions: [{ id: 'one', decisions: [{ id: 1, answered: false, closed: false }] }] };
  const html = S.rail(vm, S.defaults());
  assert.deepEqual(all(html, /class="sh-tip"[^>]*>([^<]*)</g), ['홈', '대화', '수신함', '계획', '메멘토', '닫힌 창', '설정']);
  assert.match(marks(html), /\[inbox\]<\/span><span class="sh-n" aria-hidden="true">1<\/span><span class="sh-tip" aria-hidden="true">수신함<\/span>/);
  assert.doesNotMatch(S.rail({ sessions: [] }, S.defaults()), /sh-n|수신함 0/, 'nothing waiting: no badge, plain label');
});

test('inbox badge = open decisions + blocked + open questions + unseen finished, never held or answered ones', () => {
  const S = load().BriefShell;
  const model = fixture();
  let st = base(S);
  const ib = S.inbox(model, st);
  assert.deepEqual(plain(ib.wait.map((x) => [x.s.id, x.kind])), [
    ['a185', '#102 결정 기다림'], ['a185', '#101 결정 기다림 · 작업 멈춤'], ['c184', '막힘'], ['f-q', '질문 열림 · 그 창에서 답하기'],
  ]);
  assert.deepEqual(plain(ib.done.map((x) => x.s.id)), ['e-done', 'p185'], 'g-old was seen after it finished');
  assert.deepEqual(plain(ib.ans.map((x) => x.kind)), ['#90', '#80']);
  assert.equal(S.badge(model, st), 6);
  st = S.reduce(st, { type: 'open', sid: 'e-done', now: NOW + 1 });
  assert.equal(S.badge(model, st), 5, 'opening a finished conversation marks it seen');
  assert.match(S.rail(model, st), /<span class="sh-n" aria-hidden="true">5<\/span>/);
  const quiet = { generatedAt: NOW, sessions: [{ id: 'q', alive: true, tab: '진행 중', decisions: [{ id: 1, held: true, closed: true }, { id: 2, answered: true }] }] };
  assert.equal(S.badge(quiet, st), 0);
  assert.doesNotMatch(S.rail(quiet, st), /sh-n/);
});

test('💬 대화 view: 즐겨찾기, 열린 탭 with kids, 최근 항목 and the 닫힌 창 row', () => {
  const S = load().BriefShell;
  const model = fixture();
  let st = base(S);
  let html = S.side(model, st);
  assert.deepEqual(headings(html), ['즐겨찾기', '열린 탭', '최근 항목', '닫힌 창']);
  assert.deepEqual(all(html, /class="sh-cnt">([^<]*)</g), ['2', '3', '5', '4']);
  assert.deepEqual(sections(html), { fav: ['d012', 'gone-1'], tabs: ['d012', 'c184', 'a185'], recent: [], 'archive-link': [] }, '최근 항목 starts folded');
  assert.match(html, /<div class="sh-row sel" data-row="a185">/, 'the active tab is the selected row');
  assert.match(html, /data-sh="view" data-key="archive"><span class="sh-sht">닫힌 창<\/span><span class="sh-cnt">4<\/span>/);
  st = S.reduce(S.reduce(st, { type: 'expand', sid: 'sec:recent' }), { type: 'expand', sid: 'a185' });
  html = S.side(model, st);
  assert.deepEqual(sections(html).recent, ['a185', 'd012', 'c184', 'f-q', 'e-done'], 'top 5 by lastActivityAt, older conversations of an open tab left out');
  const kids = all(html.split('<div class="sh-kids"')[1].split('</div></div>')[0] + '</div>', /class="sh-t" title="[^"]*">([^<]*)</g);
  assert.deepEqual(kids, ['계획 2/3', '작업자 2', '결정 2 대기 · 1 답함', '이전 대화 · ' + esc(HOSTILE) + ' 옛 대화']);
  assert.match(html, /data-sid="a185" data-sub="plan">/);
  assert.match(html, /data-sid="a185" data-sub="wk">/);
  assert.match(html, /data-sid="a185" data-sub="dec">/);
  assert.match(html, /<div class="sh-row sh-kid sh-prev">.*?data-sid="p185">/);
  assert.match(html, /<span class="sh-ico sh-ico-n sh-h1" aria-hidden="true">185<\/span>/, 'hue from the tab number (185 * 5 mod 12 = 1)');
});

test('수신함 on the server page: 보류 with its confirm row on open decisions, 다시 열기 in 보류됨, badge never counts held', () => {
  const S = load().BriefShell;
  const model = fixture();
  const st = Object.assign(S.reduce(base(S), { type: 'view', key: 'inbox' }), { live: true, answers: {} });
  let html = S.side(model, st);
  assert.deepEqual(all(html, /data-act="ans-hold" data-id="(\d+)" data-where="inbox"/g), ['102', '101'], '보류 on every open decision item only');
  assert.doesNotMatch(html, /<button[^>]*class="sh-it[^"]*"[^>]*>(?:(?!<\/button>).)*data-act=/s, 'controls sit beside the item button, never inside it');
  html = S.side(model, Object.assign({}, st, { answers: { 101: { confirm: { hold: true }, phase: '' } } }));
  assert.match(marks(html), /\[app-window\] 상황판제작 #185 대화의 #101를 보류할까요\? 대화는 다시 묻지 않아요/);
  assert.match(html, /data-act="ans-send" data-id="101" data-where="inbox">보류<\/button><button type="button" class="sh-act" data-act="ans-cancel" data-id="101"/);
  html = S.side(model, Object.assign({}, st, { box: 'held' }));
  assert.deepEqual(all(html, /data-act="ans-reopen" data-id="(\d+)"/g), ['95']);
  const before = S.badge(model, st);
  const heldMore = plain(model);
  heldMore.sessions[0].decisions[0] = Object.assign({}, heldMore.sessions[0].decisions[0], { held: { at: NOW }, closed: true });
  assert.equal(S.badge(heldMore, st), before - 1, 'holding an open decision takes it off the badge');
  assert.deepEqual(plain(S.inbox(heldMore, st).held.map((x) => x.kind)), ['#101 보류됨', '#95 보류됨']);
});

test('the other sidebar views: 수신함 groups, 계획, 홈 counts, 닫힌 창 and 설정', () => {
  const S = load({ BriefAlarm: { soundButtonHtml: () => '<button type="button" class="alarm-sound" data-alarm-sound>🔔</button>' } }).BriefShell;
  const model = fixture();
  const st = base(S);
  const view = (key, box) => S.side(model, S.reduce(st, { type: 'view', key, box }));
  let html = view('inbox');
  assert.deepEqual(all(html, /class="sh-pt(?: on)?"[^>]*>([^<]*)</g), ['기다리는 것 4', '끝남 확인 2', '내가 답함', '보류됨 1']);
  assert.deepEqual(items(html), ['a185', 'a185', 'c184', 'f-q']);
  assert.doesNotMatch(html, /data-act="ans-/, 'the file page draws no 보류 controls');
  html = view('inbox', 'held');
  assert.deepEqual(kinds(html), ['상황판제작 · #95 보류됨'], 'the 4th group lists the held decision');
  assert.match(html, /data-sid="a185" data-sub="dec">/);
  assert.match(html, /data-sid="a185" data-sub="dec">/);
  assert.deepEqual(items(view('inbox', 'done')), ['e-done', 'p185']);
  html = view('inbox', 'ans');
  assert.deepEqual(kinds(html), ['상황판제작 · #90', '끝난 설치 작업 · #80']);
  assert.match(html, /사이드바 기본 폭\? <span class="sh-ans"><svg[^>]*><use href="#i-arrow-right"><\/use><\/svg> A · 260px<\/span>/);
  assert.deepEqual(all(marks(html), /class="sh-w">([^<]*)</g), ['5분 전 · 전달됨 [clock]11:58', '전달 중'], 'the delivery text\'s stopwatch is the clock icon');
  assert.match(html, /설치할까\? <span class="sh-ans"><svg[^>]*><use href="#i-arrow-right"><\/use><\/svg> 답글 “내일 해 줘”<\/span>/);
  html = view('plans');
  assert.deepEqual(items(html), ['a185', 'd012']);
  assert.deepEqual(all(html, /class="sh-iq">([^<]*)</g), ['briefing-board-redesign · 2/3', 'docs-plan · 1/4']);
  html = view('home');
  assert.deepEqual(all(html, /class="sh-hl">([^<]*)<\/span><b class="sh-num">/g), ['기다리는 것', '끝남 확인', '열린 탭']);
  assert.deepEqual(all(marks(html), /class="sh-ki" aria-hidden="true">([^<]*)</g), ['[bell]', '[check]', '[layout-grid]']);
  assert.deepEqual(all(html, /class="sh-num">([^<]*)</g), ['4', '2', '3']);
  assert.deepEqual(headings(html), ['열린 탭']);
  html = view('archive');
  assert.deepEqual(all(html, /data-row="([^"]*)"/g), ['f-q', 'e-done', 'p185', 'g-old']);
  assert.deepEqual(all(html, /class="sh-sub">([^<]*)</g), ['45분 전', '2시간 전', '3시간 전', '5일 전']);
  html = view('settings');
  assert.deepEqual(all(marks(html), /class="sh-seth">([^<]*)</g), ['[bell] 알림 소리', '[info] 표시 뜻']);
  assert.match(html, /data-alarm-sound>🔔<\/button>/, 'the sound toggle is BriefAlarm\'s own button');
  assert.match(load().BriefShell.side(model, S.reduce(st, { type: 'view', key: 'settings' })), /알림 모듈이 없어 바꿀 수 없음/);
});

test('regression R3: 🗂 계획 lists only conversations with a plan or auto.work, never worker or todo telemetry alone', () => {
  const S = load().BriefShell;
  // render.mjs autoInfo shape; stage = auto.work.phase and workName = auto.work.name are the work evidence
  const auto = (extra) => ({ stage: '', todoCurrent: '', todoNext: '', todoDone: null, todoTotal: null, workers: { running: 1, done: 0, error: 0 }, ...extra });
  const vm = {
    generatedAt: NOW,
    sessions: [
      { id: 'worker-only', title: 'Only worker telemetry', alive: true, tabId: 't1', tabNumber: 1, workName: '', auto: auto() },
      { id: 'todo-only', title: 'Only todo counts', alive: true, tabId: 't2', tabNumber: 2, workName: '', auto: auto({ todoDone: 1, todoTotal: 3, todoCurrent: 'x' }) },
      { id: 'with-plan', title: 'Plan', alive: true, tabId: 't3', tabNumber: 3, plan: { goal: 'g', source: { slug: 'p' }, tasks: [] } },
      { id: 'with-work', title: 'Work', alive: true, tabId: 't4', tabNumber: 4, workName: 'w', auto: auto({ stage: 'running' }) },
      { id: 'work-phase', title: 'Phase only', alive: true, tabId: 't5', tabNumber: 5, workName: '', auto: auto({ stage: 'gate' }) },
    ],
  };
  const plans = S.reduce(S.defaults(), { type: 'view', key: 'plans' });
  assert.deepEqual(items(S.side(vm, plans)).sort(), ['with-plan', 'with-work', 'work-phase']);
  let conv = S.defaults();
  for (const s of vm.sessions) conv = S.reduce(conv, { type: 'expand', sid: s.id });
  assert.deepEqual(all(S.side(vm, conv), /data-sid="([^"]*)" data-sub="plan"/g).sort(), ['with-plan', 'with-work', 'work-phase'], 'the 🗂 계획 kid row too');
  assert.equal(items(S.side({ sessions: [vm.sessions[0]] }, plans)).length, 0);
  assert.match(S.side({ sessions: [vm.sessions[0]] }, plans), /계획이 있는 대화 없음/);
});

test('search filters by title, tab label, headline and decision questions, case-insensitive', () => {
  const S = load().BriefShell;
  const model = fixture();
  const st = S.reduce(base(S), { type: 'expand', sid: 'sec:recent' });
  const conv = (text) => sections(S.side(model, S.reduce(st, { type: 'search', text })));
  assert.deepEqual(conv('docs'), { fav: ['d012'], tabs: ['d012'], recent: ['d012'], 'archive-link': [] });
  assert.deepEqual(conv('DOCS'), conv('docs'));
  assert.deepEqual(conv('readme').tabs, ['d012'], 'headline');
  assert.deepEqual(conv('색은').tabs, ['a185'], 'decision question');
  assert.deepEqual(conv('상황판제작').tabs, ['a185'], 'tab label');
  assert.equal(conv('색은').fav, undefined, 'no favourite matches: the section goes, the remembered (지금 안 보임) row too');
  assert.deepEqual(conv('zzz'), { tabs: [], recent: [], 'archive-link': [] });
  assert.match(S.side(model, S.reduce(st, { type: 'search', text: 'zzz' })), /맞는 대화 없음/);
  const arch = S.reduce(S.reduce(st, { type: 'view', key: 'archive' }), { type: 'search', text: '설치' });
  assert.deepEqual(all(S.side(model, arch), /data-row="([^"]*)"/g), ['e-done']);
  assert.match(S.side(model, S.reduce(st, { type: 'search', text: '설치' })), /<span class="sh-sht">닫힌 창<\/span><span class="sh-cnt">1<\/span>/);
});

test('filter chips use the same 나를 기다림 / 진행 중 / 끝남 split as view.js tabOf', () => {
  const ctx = load({}, ['src/page/view.js', 'src/page/plan-view.js', 'src/page/shell.js']);
  const S = ctx.BriefShell;
  const model = fixture();
  model.sessions.push(
    { id: 'x1', status: 'blocked' }, { id: 'x2', status: 'done' }, { id: 'x3', openQuestion: { text: 'q' } },
    { id: 'x4', decisions: [{ id: 1, answered: false, closed: false }] }, { id: 'x5', decisions: [{ id: 2, held: true }] },
    { id: 'x6', tab: 'constructor' }, { id: 'x7', tab: '끝남', status: 'blocked' },
  );
  const ids = new Set(model.sessions.filter((s) => s && typeof s.id === 'string' && s.id).map((s) => s.id));
  for (const s of model.sessions) {
    if (!s || !ids.has(s.id)) continue;
    delete s.plan;
    s.planLink = { ownerId: s.id, planId: 'p123456789abc' };
  }
  const overview = ctx.BriefView.renderOverview(model, {});
  for (const key of ['wait', 'run', 'done']) {
    const theirs = overview.split('<article ').slice(1).filter((card) => card.includes(`data-tab="${key}"`))
      .map((card) => /data-card="([^"]*)"/.exec(card)[1]).filter((id) => ids.has(id)).sort();
    const mine = [...ids].filter((id) => S.tabOf(model.sessions.find((s) => s && s.id === id)) === key).sort();
    assert.deepEqual(mine, theirs, key);
  }
  assert.deepEqual(plain(ctx.BriefView.TABS.map((t) => t.label)), ['나를 기다림', '진행 중', '끝남']);
  const st = S.reduce(base(S), { type: 'expand', sid: 'sec:recent' });
  const conv = (key) => sections(S.side(fixture(), S.reduce(st, { type: 'filter', key })));
  assert.deepEqual(conv('wait'), { tabs: ['c184', 'a185'], recent: ['a185', 'c184', 'f-q'], 'archive-link': [] });
  assert.deepEqual(conv('run'), { fav: ['d012'], tabs: ['d012'], recent: ['d012'], 'archive-link': [] });
  assert.deepEqual(conv('done'), { tabs: [], recent: ['e-done', 'g-old'], 'archive-link': [] });
  assert.deepEqual(all(S.sideFrame(st), /data-sh="filter" data-key="[^"]*" aria-pressed="[^"]*">([^<]*)</g), ['전체', '나를 기다림', '진행 중', '끝남']);
});

test('⚙ legend preserves every legacy legend entry after the overview footer is removed', () => {
  const ctx = load({}, ['src/page/view.js', 'src/page/shell.js']);
  const old = ctx.BriefView.legend.map(([cls, label, meaning]) => '<li><span class="chip ' + cls + '">' +
    ctx.BriefView.escapeHtml(label) + '</span> = ' + ctx.BriefView.escapeHtml(meaning) + '</li>').join('');
  const st = ctx.BriefShell.reduce(ctx.BriefShell.defaults(), { type: 'view', key: 'settings' });
  const moved = /<ul class="legend-list sh-legend">(.*?)<\/ul>/s.exec(ctx.BriefShell.side(fixture(), st))[1];
  assert.equal(moved, old);
  assert.equal((moved.match(/<li>/g) || []).length, 11);
  assert.doesNotMatch(ctx.BriefView.renderOverview(fixture(), {}), /legend-list/);
});

test('tab bar: the open-sidebar button, the tabs with icon, full title tooltip and bell count, then plus (홈 in the sidebar)', () => {
  const S = load().BriefShell;
  const html = S.tabs(fixture(), base(S));
  assert.match(marks(html), /^<button type="button" class="sh-topen" data-sh="toggleSide" title="사이드바 열기 \(Ctrl\+\\\)" aria-label="사이드바 열기">\[panel-left-open\]<\/button>/);
  assert.match(marks(html), /<button type="button" class="sh-tadd" data-sh="view" data-key="home" title="새 탭: 홈" aria-label="홈 보기">\[plus\]<\/button>$/);
  assert.deepEqual(tabOrder(html), ['a185', 'c184', 'gone-1']);
  assert.match(html, /class="tb on" data-tab="a185" title="상황판제작 #185 · 상황판 v5 셸 \(두 번 누르면 탭 고정\)">/);
  assert.match(marks(html), /<span class="tt">상황판제작<\/span><span class="sh-bdg">\[bell\]2<\/span>/);
  assert.equal((marks(html).match(/aria-label="탭 닫기: [^"]*" title="탭 닫기">\[x\]<\/button>/g) || []).length, 3);
  assert.match(html, /<span class="sh-ico sh-ico-n sh-h1" aria-hidden="true">185<\/span>/);
  assert.equal((html.match(/data-sh="close"/g) || []).length, 3);
  assert.equal((html.match(/<button /g) || []).length, 2 + 3 * 2, '», ＋ and each tab\'s own two buttons only');
  const st = S.reduce(base(S), { type: 'view', key: 'inbox' });
  assert.equal(S.tabs(fixture(), st), html, 'a rail view switch does not touch the tab bar');
});

test('hostile titles, labels, headlines and ids are escaped everywhere, title attributes included', () => {
  const S = load().BriefShell;
  const model = fixture();
  const evil = 'x"><svg onload=alert(2)>';
  model.sessions.push({ id: evil, alive: true, tabId: 'tab-7', tabNumber: 7, tabLabel: HOSTILE, title: HOSTILE, headline: HOSTILE, tab: '나를 기다림',
    lastActivityAt: NOW, decisions: [{ id: 7, question: HOSTILE, createdAt: NOW, answered: false, closed: false }], openQuestion: { text: HOSTILE } });
  let st = S.reduce(base(S), { type: 'open', sid: evil, now: NOW - 1 });
  st = S.reduce(S.reduce(st, { type: 'expand', sid: 'a185' }), { type: 'expand', sid: 'sec:recent' });
  st = S.reduce(st, { type: 'search', text: HOSTILE });
  const html = [
    S.rail(model, st), S.tabs(model, st), S.sideFrame(st), S.skeleton(st),
    ...['conv', 'inbox', 'plans', 'home', 'archive'].map((key) => S.side(model, { ...st, view: key, search: '' })),
    S.side(model, st), S.side(model, { ...st, view: 'archive' }), S.side(model, { ...st, view: 'inbox', box: 'wait' }),
  ].join('\n');
  assert.doesNotMatch(marks(html), /<img|<svg|onerror="|onload=alert\(2\)>/, 'past the page\'s own icons, no element comes from the data');
  assert.ok(html.includes(esc(HOSTILE)), 'the hostile text is shown, escaped');
  for (const [, value] of html.matchAll(/ (?:title|aria-label|data-sid|data-tab|data-row|value)="([^"]*)"/g)) assert.doesNotMatch(value, /[<>"`']/, value);
  assert.match(html, new RegExp('data-tab="' + esc(evil).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'));
  assert.match(html, /value="&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&#39;&#96;&amp;"/, 'the search box value is escaped too');
});

// ---- frame, keyboard and listeners ----------------------------------------------------------------------------------

class El {
  constructor(attrs = {}, parent = null, rect = null) {
    this.attrs = { ...attrs };
    this.cls = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
    this.parentNode = parent;
    this.children = [];
    this.listeners = {};
    this.value = attrs.value ?? '';
    this.textContent = '';
    this.rect = rect;
    const props = {};
    this.style = { props, setProperty: (k, v) => { props[k] = v; } };
    if (parent) parent.children.push(this);
    const cls = this.cls;
    this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) };
  }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  matches(sel) {
    let m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (m) return m[2] === undefined ? this.getAttribute(m[1]) !== null : this.getAttribute(m[1]) === m[2];
    m = /^\.([\w-]+)$/.exec(sel);
    if (m) return this.cls.has(m[1]);
    throw new Error('unsupported selector ' + sel);
  }
  closest(sel) {
    for (let n = this; n; n = n.parentNode) if (n.matches(sel)) return n;
    return null;
  }
  contains(o) {
    for (let n = o; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  getBoundingClientRect() { return this.rect; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  fire(t, ev) { for (const f of [...(this.listeners[t] || [])]) f(ev); }
}

function bound(S, start = S.defaults(), narrow = false) {
  const doc = new El();
  const root = new El({ class: 'sh-shell' });
  root.ownerDocument = doc;
  const seen = [];
  const box = { st: start };
  const unbind = S.bind(root, {
    doc, narrow: () => narrow, now: () => NOW,
    dispatch: (a) => { seen.push(plain(a)); box.st = S.reduce(box.st, a); },
  });
  return { doc, root, seen, box, unbind };
}
const key = (extra) => {
  const ev = { ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, key: '\\', code: 'Backslash', prevented: 0, ...extra };
  ev.preventDefault = () => { ev.prevented++; };
  return ev;
};

test('Ctrl+\\ toggles the sidebar twice, each time with preventDefault; other keys pass through', () => {
  const S = load().BriefShell;
  const k = key();
  assert.deepEqual(plain(S.keyAction(k)), { type: 'toggleSide' });
  assert.equal(k.prevented, 1);
  const { doc, seen, box } = bound(S);
  const first = key();
  doc.fire('keydown', first);
  assert.equal(box.st.sideOpen, false);
  const second = key({ key: '₩' }); // Korean layouts: the same physical key
  doc.fire('keydown', second);
  assert.equal(box.st.sideOpen, true);
  assert.deepEqual([first.prevented, second.prevented], [1, 1]);
  assert.deepEqual(seen, [{ type: 'toggleSide', narrow: false }, { type: 'toggleSide', narrow: false }]);
  const others = [key({ ctrlKey: false }), key({ key: 'a', code: 'KeyA' }), key({ shiftKey: true }), key({ altKey: true }), key({ metaKey: true })];
  for (const ev of others) doc.fire('keydown', ev);
  assert.equal(seen.length, 2);
  assert.deepEqual(others.map((e) => e.prevented), [0, 0, 0, 0, 0]);
  const held = key({ repeat: true });
  assert.equal(S.keyAction(held), null, 'a held key does not flicker the sidebar');
  assert.equal(held.prevented, 1);
  const narrow = bound(S, S.defaults(), true);
  narrow.doc.fire('keydown', key());
  assert.deepEqual([narrow.box.st.sideOpen, narrow.box.st.peek], [true, true], 'narrow: Ctrl+\\ opens the overlay');
});

test('bind: clicks, double-click pin, search input, edge peek, leaving the peek panel and the resize drag', () => {
  const S = load().BriefShell;
  const { root, doc, seen, box, unbind } = bound(S);
  const click = (attrs) => root.fire('click', { target: new El(attrs, root) });
  click({ 'data-sh': 'open', 'data-sid': 'a185', 'data-sub': 'dec' });
  click({ 'data-sh': 'open', 'data-sid': 'c184' });
  click({ 'data-sh': 'view', 'data-key': 'inbox', 'data-box': 'ans' });
  click({ 'data-sh': 'filter', 'data-key': 'run' });
  click({ 'data-sh': 'fav', 'data-sid': 'c184' });
  click({ 'data-sh': 'expand', 'data-sid': 'sec:recent' });
  click({ 'data-sh': 'active', 'data-sid': 'a185' });
  click({ 'data-sh': 'close', 'data-sid': 'c184' });
  click({ 'data-sh': 'rz' });
  click({ class: 'plain' });
  assert.deepEqual(seen, [
    { type: 'open', sid: 'a185', now: NOW, sub: 'dec' }, { type: 'open', sid: 'c184', now: NOW },
    { type: 'view', key: 'inbox', narrow: false, box: 'ans' }, { type: 'filter', key: 'run' }, { type: 'fav', sid: 'c184' },
    { type: 'expand', sid: 'sec:recent' }, { type: 'active', sid: 'a185', now: NOW }, { type: 'close', sid: 'c184' },
  ]);
  assert.deepEqual([plain(box.st.tabs), box.st.active, box.st.view, box.st.box, box.st.filter], [['a185'], 'a185', 'inbox', 'ans', 'run']);
  seen.length = 0;
  const tab = new El({ class: 'tb', 'data-tab': 'a185' }, root);
  const go = new El({ 'data-sh': 'active', 'data-sid': 'a185' }, tab);
  const x = new El({ 'data-sh': 'close', 'data-sid': 'a185' }, tab);
  root.fire('dblclick', { target: go });
  root.fire('dblclick', { target: x });
  assert.deepEqual(seen, [{ type: 'pin', sid: 'a185' }], 'double-click pins; not on ✕');
  assert.deepEqual(plain(box.st.pinned), ['a185']);
  seen.length = 0;
  root.fire('input', { target: new El({ 'data-sh': 'search', value: 'docs' }, root) });
  assert.equal(box.st.search, 'docs');
  box.st = S.reduce(box.st, { type: 'toggleSide' });
  const edge = new El({ class: 'sh-edge' }, root);
  const side = new El({ class: 'sh-side' }, root, { width: 260 });
  const inside = new El({ class: 'sh-row' }, side);
  root.fire('mouseover', { target: edge });
  assert.equal(box.st.peek, true);
  root.fire('mouseout', { target: inside, relatedTarget: side });
  assert.equal(box.st.peek, true, 'moving inside the panel keeps it');
  root.fire('mouseout', { target: inside, relatedTarget: root });
  assert.equal(box.st.peek, false, 'leaving the panel closes the peek');
  const rz = new El({ 'data-sh': 'rz' }, side);
  let prevented = 0;
  root.fire('mousedown', { target: rz, button: 0, clientX: 300, preventDefault: () => { prevented++; } });
  assert.equal(root.classList.contains('is-resizing'), true);
  doc.fire('mousemove', { clientX: 300 - 61 });
  assert.equal(box.st.sideWidth, 200, '260 - 61 = 199 -> 200');
  doc.fire('mousemove', { clientX: 300 + 221 });
  assert.equal(box.st.sideWidth, 480, '260 + 221 = 481 -> 480');
  doc.fire('mouseup', {});
  assert.equal(root.classList.contains('is-resizing'), false);
  assert.equal((doc.listeners.mousemove || []).length, 0, 'the drag listeners go on mouseup');
  assert.equal(prevented, 1);
  unbind();
  for (const t of ['click', 'dblclick', 'input', 'mouseover', 'mouseout', 'mousedown']) assert.equal((root.listeners[t] || []).length, 0, t);
  assert.equal((doc.listeners.keydown || []).length, 0);
});

test('sideFrame is rendered once from state alone; sync keeps its title, chips, search hint and width current', () => {
  const S = load().BriefShell;
  const st = S.reduce(S.reduce(S.defaults(), { type: 'search', text: 'abc' }), { type: 'resize', px: 300 });
  const frame = S.sideFrame(st);
  assert.match(frame, /^<div class="sh-rz" data-sh="rz" role="separator"[^>]*aria-valuenow="300"/);
  assert.match(frame, /<span class="sh-title" data-sh-part="title">대화<\/span>/);
  assert.match(frame, /<label class="sh-qlbl" for="sh-q">검색<\/label>/);
  assert.match(frame, /<input type="search" id="sh-q" class="sh-q" data-sh="search" maxlength="200"[^>]*placeholder="대화·결정 검색"[^>]*value="abc">/);
  assert.match(marks(frame), /<button type="button" class="sh-back" data-sh="view" data-key="conv">\[arrow-left\] 사이드바로 돌아가기<\/button>/);
  assert.match(marks(frame), /aria-label="사이드바 닫기">\[panel-left-close\]<\/button>/);
  assert.match(marks(frame), /<label class="sh-srch">\[search\]<input type="search"/);
  assert.match(frame, /<div class="sh-scroll" data-sh-part="list"><\/div>$/);
  const sk = S.skeleton(st);
  assert.deepEqual(all(sk, / id="([^"]+)"/g), ['rail', 'edge', 'side', 'sh-q', 'tabs', 'main']);
  assert.equal((sk.match(/<aside/g) || []).length, 1, 'one sidebar column, no second panel');
  assert.match(sk, /^<div class="sh-shell" data-shell data-side="open" data-peek="false" data-view="conv" style="--sw:300px">/);

  const root = new El({ class: 'sh-shell' });
  root.ownerDocument = { activeElement: null };
  const title = new El({ 'data-sh-part': 'title' }, root);
  const input = new El({ 'data-sh': 'search', value: 'stale' }, root);
  const rz = new El({ 'data-sh': 'rz' }, root);
  const chips = ['all', 'wait', 'run', 'done'].map((k) => new El({ class: 'sh-chip' + (k === 'all' ? ' on' : ''), 'data-sh': 'filter', 'data-key': k }, root));
  let next = S.reduce(S.reduce(st, { type: 'view', key: 'archive' }), { type: 'filter', key: 'wait' });
  next = S.reduce(next, { type: 'toggleSide' });
  S.sync(root, next);
  assert.deepEqual([root.attrs['data-side'], root.attrs['data-peek'], root.attrs['data-view'], root.style.props['--sw']], ['closed', 'false', 'archive', '300px']);
  assert.equal(title.textContent, '닫힌 창');
  assert.deepEqual([input.attrs.placeholder, input.value], ['닫힌 창 검색', 'abc']);
  assert.equal(rz.attrs['aria-valuenow'], '300');
  assert.deepEqual(chips.map((c) => [c.cls.has('on'), c.attrs['aria-pressed']]), [[false, 'false'], [true, 'true'], [false, 'false'], [false, 'false']]);
  input.value = 'typing';
  root.ownerDocument.activeElement = input;
  S.sync(root, next);
  assert.equal(input.value, 'typing', 'a focused search box is never overwritten');
});

test('shell.css: mockup tokens mapped onto tokens.css, colour literals only in the token block, ellipsis only on titles', () => {
  const css = read('src/page/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /:root\s*\{[^}]*\}/.exec(css)[0];
  for (const t of ['--rail', '--side', '--hov', '--sel', '--tx', '--tx2', '--tx3', '--acc', '--sw']) assert.match(root, new RegExp('\\s' + t + ':'), t);
  for (const t of ['--rail', '--side', '--hov', '--sel', '--tx', '--tx2', '--tx3', '--acc']) {
    const value = new RegExp('^' + t + ':\\s*([^;]*);').exec(root.slice(root.indexOf(t + ':')))[1];
    assert.match(value, /var\(--(?:c-rail|c-side|fill-hover|fill-sel|c-fg|c-fg-2|c-fg-4|c-accent)\)/, t + ' maps onto tokens.css');
    assert.doesNotMatch(value, /#[0-9a-f]|\brgba?\(|\bhsla?\(/i, t);
  }
  const rest = css.replace(root, '');
  assert.doesNotMatch(rest, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  assert.deepEqual(all(rest, /([^{}]+)\{[^}]*text-overflow:\s*ellipsis/g).map((s) => s.trim()), ['.sh-t', '.tt']);
  for (let i = 0; i < 12; i++) assert.match(css, new RegExp('\\.sh-h' + i + ' \\{ --sh-hue: var\\(--tabhue-' + i + '\\); --sh-hue-bg: var\\(--tabhue-' + i + '-bg\\); \\}'));
  assert.match(css, /@media \(max-width: 899px\)/);
});

// ---- A6-02 (visual-qa I1/I2): the narrow sidebar overlay ------------------------------------------------------------
const NARROW_Q = '(max-width: 899px)';
function mediaList(matches) {
  return {
    matches, listeners: [],
    addEventListener(t, f) { this.listeners.push([t, f]); },
    removeEventListener(t, f) { this.listeners = this.listeners.filter((l) => l[0] !== t || l[1] !== f); },
  };
}

test('sync: below 900 px the open overlay makes the column it covers inert; shut, or on the wide layout, nothing is inert', () => {
  const mq = mediaList(true);
  const S = load({ matchMedia: (q) => (q === NARROW_Q ? mq : { matches: false }) }).BriefShell;
  const root = new El({ class: 'sh-shell' });
  root.ownerDocument = { activeElement: null };
  const rail = new El({ class: 'sh-rail' }, root);
  const side = new El({ class: 'sh-side' }, root);
  const wrap = new El({ class: 'sh-wrap' }, root);
  const open = S.reduce(S.defaults(), { type: 'toggleSide', narrow: true });
  S.sync(root, open);
  assert.deepEqual([wrap.getAttribute('inert'), rail.getAttribute('inert'), side.getAttribute('inert')], ['', null, null],
    'the tab bar and #main under the overlay go inert; the rail and the panel stay usable');
  S.sync(root, S.reduce(open, { type: 'unpeek' }));
  assert.equal(wrap.getAttribute('inert'), null, 'shutting the overlay gives the column back');
  mq.matches = false;
  S.sync(root, open);
  assert.equal(wrap.getAttribute('inert'), null, 'the wide layout docks the sidebar: no overlay, nothing inert');
});

test('bind: crossing the 900 px line re-applies the cover without a render, and unbind drops that listener', () => {
  const mq = mediaList(true);
  const S = load({ matchMedia: (q) => (q === NARROW_Q ? mq : { matches: false }) }).BriefShell;
  const doc = new El();
  const root = new El({ class: 'sh-shell', 'data-peek': 'true' });
  root.ownerDocument = doc;
  const wrap = new El({ class: 'sh-wrap' }, root);
  const unbind = S.bind(root, { doc, dispatch: () => {} });
  const change = () => mq.listeners.filter((l) => l[0] === 'change').forEach((l) => l[1]({ matches: mq.matches }));
  mq.matches = false;
  change();
  assert.equal(wrap.getAttribute('inert'), null, 'widened past 900 px: the open overlay is the docked sidebar now');
  mq.matches = true;
  change();
  assert.equal(wrap.getAttribute('inert'), '', 'narrowed again with the overlay open: covered again');
  unbind();
  assert.equal(mq.listeners.length, 0);
});

test('Escape shuts the narrow overlay with preventDefault; wide, shut, modified, composing, handled or under a dialog it passes', () => {
  const S = load().BriefShell;
  const esc = (extra) => {
    const ev = { key: 'Escape', code: 'Escape', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, prevented: 0, ...extra };
    ev.preventDefault = () => { ev.prevented++; };
    return ev;
  };
  const open = S.reduce(S.defaults(), { type: 'toggleSide', narrow: true });
  const narrow = bound(S, open, true);
  narrow.root.setAttribute('data-peek', 'true'); // what sync() keeps on .sh-shell
  const first = esc();
  narrow.doc.fire('keydown', first);
  assert.deepEqual(narrow.seen, [{ type: 'unpeek' }]);
  assert.deepEqual([narrow.box.st.peek, first.prevented], [false, 1]);
  const pass = [esc({ shiftKey: true }), esc({ ctrlKey: true }), esc({ altKey: true }), esc({ metaKey: true }), esc({ isComposing: true }),
    esc({ defaultPrevented: true }), esc({ key: 'Enter', code: 'Enter' })];
  for (const ev of pass) narrow.doc.fire('keydown', ev);
  const shut = bound(S, S.defaults(), true);
  shut.root.setAttribute('data-peek', 'false');
  const shutEv = esc();
  shut.doc.fire('keydown', shutEv);
  const wide = bound(S, open, false);
  wide.root.setAttribute('data-peek', 'true');
  const wideEv = esc();
  wide.doc.fire('keydown', wideEv);
  const layered = bound(S, open, true);
  layered.root.setAttribute('data-peek', 'true');
  new El({ class: 'pop', role: 'dialog' }, layered.doc); // the annotation composer sits above the overlay and takes Escape first
  const layeredEv = esc();
  layered.doc.fire('keydown', layeredEv);
  assert.equal(narrow.seen.length, 1, 'only the plain Escape acted');
  assert.deepEqual([shut.seen, wide.seen, layered.seen], [[], [], []]);
  assert.deepEqual([...pass, shutEv, wideEv, layeredEv].map((ev) => ev.prevented), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('fold parity: side, rail, tabs, search and inbox render identically with folding on and off apart from the 접힘 marker', () => {
  const S = load().BriefShell;
  const baseModel = fixture(), markedModel = fixture();
  const basePrev = baseModel.sessions.find((s) => s.id === 'p185');
  const prev = markedModel.sessions.find((s) => s.id === 'p185');
  const decision = { id: 501, question: 'fold parity decision', options: { A: { text: 'yes' } }, answered: false, closed: false, createdAt: NOW - 3600e3 };
  basePrev.decisions = [decision];
  prev.decisions = [decision];
  prev.folded = { reports: 2, decisions: 1, key: 'a'.repeat(20) };
  const st = S.reduce(base(S), { type: 'expand', sid: 'a185' });
  const strip = (html) => html.replace(/<span class="sh-fold">접힘<\/span>/g, '');
  const normalize = (html) => strip(html).replace(/<span class="sh-sub"><\/span>/g, '');
  const parity = (a, b, label, markedRow = false) => {
    if (markedRow) assert.ok(b.includes('<span class="sh-fold">접힘</span>'), label + ' carries the marker');
    assert.equal(normalize(b), a, label);
  };
  parity(S.side(baseModel, S.reduce(st, { type: 'view', key: 'archive' })), S.side(markedModel, S.reduce(st, { type: 'view', key: 'archive' })), '닫힌 창', true);
  parity(S.side(baseModel, st), S.side(markedModel, st), '대화 side', true);
  parity(S.rail(baseModel, st), S.rail(markedModel, st), 'rail');
  parity(S.tabs(baseModel, st), S.tabs(markedModel, st), 'tabs');
  parity(S.side(baseModel, S.reduce(st, { type: 'search', text: '설치' })), S.side(markedModel, S.reduce(st, { type: 'search', text: '설치' })), 'search');
  parity(S.side(baseModel, S.reduce(st, { type: 'view', key: 'inbox' })), S.side(markedModel, S.reduce(st, { type: 'view', key: 'inbox' })), 'inbox');
  const recent = { id: 'recent-fold', alive: false, status: 'done', statusKey: 'done', tab: '끝남', title: '최근 접힘', headline: '최근', lastActivityAt: NOW - 2 * DAY, decisions: [] };
  const recentFolded = Object.assign({}, recent, { folded: { reports: 1, decisions: 0, key: 'b'.repeat(20) }, chips: ['접어 둠'] });
  const stRecent = S.reduce(undefined, { type: 'load', json: JSON.stringify({ view: 'conv', favs: ['recent-fold'] }), known: ['recent-fold'], now: NOW });
  const openRecent = S.reduce(stRecent, { type: 'expand', sid: 'sec:recent' });
  const plainRecent = S.side({ generatedAt: NOW, sessions: [recent] }, openRecent);
  const markedRecent = S.side({ generatedAt: NOW, sessions: [recentFolded] }, openRecent);
  assert.equal((markedRecent.match(/<span class="sh-fold">접힘<\/span>/g) || []).length, 2, 'favourite and recent rows each carry the marker');
  assert.equal(normalize(markedRecent), plainRecent, 'empty grey subtext containers differ only by the marker');
});
