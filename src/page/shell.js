/* omo-briefing shell: the left icon rail, the one sidebar whose view the rail switches, and the top tab bar (board v5).
 * Classic script (file:// safe, no modules). Everything is pure except sync(), bind(), restore() and persist(); nothing
 * reads the clock: time-dependent actions take `now`. Model text is untrusted: all of it goes through esc(), attributes too.
 *   g.BriefShell.reduce(st, action) -> state   never mutates st and returns st itself when nothing changes. Actions:
 *     {type:'toggleSide', narrow?}   docked open <-> closed; narrow (< 900 px, sidebar = overlay) toggles the overlay
 *     {type:'peek'} / {type:'unpeek'}   the panel a 10 px left-edge hover shows over the content (only while closed)
 *     {type:'resize', px}            width clamped to 200-480 px; anything but a finite number is ignored
 *     {type:'view', key, box?, narrow?}   conv|inbox|plans|home|archive|settings, shown in the one sidebar column;
 *                                    box = the inbox sub-tab (wait|done|ans|held)
 *     {type:'filter', key}           all|wait|run|done, by view.js tabOf
 *     {type:'search', text}          title, tab label, headline and decision questions, case-insensitive
 *     {type:'fav', sid} / {type:'pin', sid} / {type:'expand', sid}   toggles; expand also takes sec:fav|sec:tabs|sec:recent
 *     {type:'open', sid, sub?, now?}  opens (or activates) a tab; sub = ov|plan|wk|dec|rep; now stamps seen[sid]. seen
 *                                    is written only here and by active: it holds what the owner actually opened.
 *                                    open and fav refuse a new id once LIST_MAX (200) tabs / favourites are kept
 *     {type:'active', sid, now?}     activates an open tab
 *     {type:'close', sid}            closing the active tab activates the tab before it (the next one when it was first)
 *     {type:'load', json, known, now}   stored prefs (string) -> state; known = the model's session ids. Every saved id
 *                                    stays until gone for more than 30 days. Unreadable or foreign-shaped prefs give the
 *                                    defaults (prefsError corrupt|shape); a list longer than open/fav can make is cut at
 *                                    the same LIST_MAX (prefsError trimmed). Nothing is marked seen here.
 *     {type:'known', ids, now}       after every model: ids missing from it stay (drawn as (지금 안 보임)), are stamped in
 *                                    absent, and are pruned once gone for more than 30 days (alarm.js prune rule)
 *   g.BriefShell.rail(model, st) / side(model, st) / tabs(model, st) -> html   #rail, the sidebar list region, #tabs. The
 *     rail is home, conv, inbox, plans, archive, a spacer, settings; the sidebar opens and closes from its header (close),
 *     the tab bar (open), Ctrl+\ and the edge peek, never from the rail
 *   g.BriefShell.sideFrame(st) -> html   the persistent sidebar frame: resize handle, header, back link, search label and
 *     input, filter chips and the empty list region [data-sh-part="list"]; rendered once, kept current by sync()
 *   g.BriefShell.skeleton(st) -> html    .sh-shell > #rail + #edge + #side + .sh-wrap > #tabs + #main
 *   g.BriefShell.sync(root, st)          root = .sh-shell: data-side/data-peek/data-view, --sw, frame title/chips/search.
 *     Below 900 px the open overlay makes .sh-wrap (tab bar, banners, #main: the column it covers) inert; never wider.
 *     Under prefers-reduced-motion a flip of data-side/data-peek cross-fades instead of sliding: .sh-wrap fades in when
 *     the docked sidebar opened or closed, the sidebar when it became visible (Web Animations, from the opacity an
 *     interrupted fade had reached)
 *   g.BriefShell.bind(root, hooks) -> unbind   hooks.dispatch(action) for clicks ([data-sh]), double-clicks (pin a tab),
 *     the search input, the edge hover, leaving the peek panel, the resize drag, the resize handle's keys (ArrowLeft /
 *     ArrowRight: 16 px, Home / End: 200 / 480 px, the same resize action as the drag) and Ctrl+\ (preventDefault).
 *     Below 900 px Escape shuts the open overlay (unpeek, preventDefault) unless a dialog is open (the annotation
 *     composer sits above it and takes Escape first); crossing 900 px re-applies sync()'s inert cover.
 *     hooks.narrow() / hooks.now() default to matchMedia('(max-width: 899px)') and Date.now().
 *   g.BriefShell.inbox(model, st) -> {wait, done, ans, held}; badge(model, st) = wait + done items (the inbox count; held
 *     decisions never count, C-HOLD 4). On the server page (st.live) every open decision in 'wait' carries 보류
 *     (data-act="ans-hold", data-where="inbox") and, while st.answers[id].confirm.hold, the hold confirm row; 'held'
 *     items carry 다시 열기 (data-act="ans-reopen"). page.js handles those clicks.
 *   g.BriefShell.restore(storage?) / persist(storage?, st): localStorage['omo-briefing.ui.v1']; never throw
 * Stored (C-UI): {sideOpen, sideWidth, view, filter, favs[], tabs[], pinned[], active, sub:{sid:key}, seen:{sid:ms},
 *   absent:{sid:firstMissingAt}}. peek, search, expanded rows/sections, the inbox sub-tab and prefsError stay in memory.
 * tabOf and the legend mirror view.js, which does not export them (test/shell.test.mjs checks both against view.js). */
(function (g) {
  'use strict';

  var KEY = 'omo-briefing.ui.v1';
  var MIN_W = 200;
  var MAX_W = 480;
  var DEF_W = 260;
  var KEEP_MS = 30 * 24 * 3600 * 1000; // alarm.js: a key gone for more than 30 days is dropped
  // tabs and favourites: open/fav refuse a new id beyond it and load cuts at the same number, so every state the reducer
  // makes survives a reload. sub/seen/absent have no cap: they grow with history and age out by the 30-day absence rule.
  var LIST_MAX = 200;
  var RZ_STEP = 16; // the resize handle's arrow-key step
  var SEARCH_MAX = 200;
  var RECENT_MAX = 5;
  var ANSWERED_MAX = 12;
  var HUES = 12; // tab icon colours: shell.css --tabhue-0..11
  var NARROW = '(max-width: 899px)';
  var CALM = '(prefers-reduced-motion: reduce)';
  var GONE = '(지금 안 보임)';
  var VIEWS = ['conv', 'inbox', 'plans', 'home', 'archive', 'settings', 'memento'];
  var VIEW_TITLE = { conv: '대화', inbox: '수신함', plans: '계획', home: '홈', archive: '닫힌 창', settings: '설정', memento: '메멘토' };
  var RAIL = [['home', 'house', '홈'], ['conv', 'message-square', '대화'], ['inbox', 'inbox', '수신함'], ['plans', 'list-todo', '계획'], ['memento', 'lightbulb', '메멘토'], ['archive', 'archive', '닫힌 창']];
  var FILTERS = [['all', '전체'], ['wait', '나를 기다림'], ['run', '진행 중'], ['done', '끝남']];
  var TAB_BY_LABEL = { '나를 기다림': 'wait', '진행 중': 'run', '끝남': 'done' }; // = view.js
  var BOXES = [['wait', '기다리는 것'], ['done', '끝남 확인'], ['ans', '내가 답함'], ['held', '보류됨']];
  var SUBS = ['ov', 'plan', 'wk', 'dec', 'rep'];
  var SECTIONS = { 'sec:fav': true, 'sec:tabs': true, 'sec:recent': false }; // open by default; v5 folds 최근 항목
  var LEGEND = [ // moved from the old footer (view.js LEGEND), same chips and words
    ['t-evidence', '증거 있음', '적어 둔 파일이 그때와 같은 내용으로 있음(다시 실행해 확인한 것은 아님)'],
    ['t-changed', '증거 바뀜', '적어 둔 파일 내용이 그때와 다름'],
    ['t-gone', '증거 사라짐', '적어 둔 파일이 없어짐'],
    ['t-reported', '보고만 됨', '에이전트가 말했을 뿐'],
    ['t-unverified', '미확인', '확인한 사람도 증거도 없음'],
    ['a-candidate', '후보', '실사용에 안 올림'],
    ['a-none', '적용 해당 없음', '조사·문서처럼 실사용에 올릴 것이 없는 항목'],
    ['a-live', '실사용 적용', '에이전트가 실사용에 올렸다고 기록함'],
    ['x-info', '자동 요약', '보고 도구 없이 마지막 답에서 잘라온 것'],
    ['x-info', '답 자동 줄임', 'AI가 줄여 쓰지 못해 확장이 잘라 맞춘 답(나머지는 상황판)'],
    ['x-err', '오류 있음', '이 대화를 처리하다 오류가 났음(예: 다른 곳이 상황판을 쓰는 중이라 갱신을 건너뜀). 다음에 잘 처리되면 사라짐']
  ];

  // ---- small helpers ----------------------------------------------------------------------------------------------
  function str(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }
  function esc(v) {
    return str(v).replace(/[&<>"'`]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c];
    });
  }
  // a Lucide icon from the page's sprite (icons.js); '' without icons.js (this file's unit tests)
  function ic(name, cls) { var m = g.BriefIcons; return m ? m.icon(name, cls) : ''; }
  // render.mjs's status text ('전달됨 <stopwatch>11:58'), escaped, with the clock icon for its stopwatch
  function timed(v) { var m = g.BriefIcons; return m ? m.timed(str(v)) : esc(v); }
  // own-property lookups: ids like '__proto__' or 'constructor' must not reach Object.prototype
  function has(o, k) { return o != null && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function map() { return Object.create(null); }
  function copy(m) {
    var out = map();
    for (var k in m) if (has(m, k)) out[k] = m[k];
    return out;
  }
  function toMs(t) {
    if (typeof t === 'number' && isFinite(t)) return t;
    if (typeof t === 'string' && t) { var p = Date.parse(t); return isFinite(p) ? p : null; }
    return null;
  }
  // '__proto__' is refused outright: an id must survive being copied into an ordinary object later
  function okId(v) { return typeof v === 'string' && v.length > 0 && v.length <= 256 && v !== '__proto__' && !/[\u0000-\u001f\u007f]/.test(v); }
  function isWindow(key) { return typeof key === 'string' && key.indexOf('w:') === 0; }
  function okBoardKey(v) { return okId(v) || (isWindow(v) && v.length >= 3 && v.length <= 258 && !/[\u0000-\u001f\u007f]/.test(v)); }
  function keyOf(st, sid) {
    var member = has(st.members, sid) ? st.members[sid] : null;
    var tabId = member ? member.tabId : '';
    return typeof tabId === 'string' && tabId && okBoardKey('w:' + tabId) ? 'w:' + tabId : sid;
  }
  function rep(st, key) { return has(st.groups, key) && st.groups[key].length ? st.groups[key][0] : null; }
  function shownOf(st, key) {
    if (!isWindow(key)) return key;
    var sid = st.shown[key];
    if (has(st.members, sid) && st.members[sid].key === key) return sid;
    return rep(st, key) || (st.members === null ? sid || null : null);
  }
  function okKey(v) { return has(SECTIONS, v) || okId(v); }
  function keys(list) { return list.map(function (x) { return x[0]; }); }
  function clampW(px) { return Math.min(MAX_W, Math.max(MIN_W, Math.round(px))); }
  function cut(v, n) {
    var cps = Array.from(str(v));
    return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('');
  }
  function toggled(list, id) { return list.indexOf(id) >= 0 ? list.filter(function (x) { return x !== id; }) : list.concat([id]); }
  var warned = map();
  function warnOnce(key, msg, err) {
    if (warned[key]) return;
    warned[key] = true;
    if (g.console && typeof g.console.warn === 'function') g.console.warn('[상황판] ' + msg, err);
  }

  // ---- state --------------------------------------------------------------------------------------------------------
  function defaults() {
    return {
      sideOpen: true, sideWidth: DEF_W, view: 'conv', filter: 'all', favs: [], tabs: [], pinned: [], active: null,
      sub: map(), seen: map(), absent: map(), shown: map(), follow: map(), members: null, groups: null,
      peek: false, search: '', exp: map(), box: 'wait', prefsError: ''
    };
  }
  function patched(st, p) {
    var same = true, k;
    for (k in p) if (has(p, k) && p[k] !== st[k]) same = false;
    if (same) return st;
    var out = {};
    for (k in st) if (has(st, k)) out[k] = st[k];
    for (k in p) if (has(p, k)) out[k] = p[k];
    return out;
  }
  // display order of the tab bar: pinned tabs first in the order they were pinned, then the others in opening order
  function order(st) {
    var pinned = st.pinned.filter(function (id) { return st.tabs.indexOf(id) >= 0; });
    return pinned.concat(st.tabs.filter(function (id) { return pinned.indexOf(id) < 0; }));
  }
  function expanded(st, key) {
    if (has(st.exp, key)) return st.exp[key] === true;
    return has(SECTIONS, key) ? SECTIONS[key] : false;
  }
  function withSeen(st, sid, now, p) {
    if (typeof now !== 'number' || !isFinite(now)) return p;
    var at = has(st.seen, sid) ? Math.max(st.seen[sid], now) : now;
    if (at !== st.seen[sid]) { p.seen = copy(st.seen); p.seen[sid] = at; }
    return p;
  }

  // Membership is replaced by each model; reuse equal records and groups so repeated publications are no-ops.
  function withMembers(st, list) {
    var members = map(), groups = map();
    list.forEach(function (m) {
      if (!obj(m) || !okId(m.id) || isWindow(m.id) || has(members, m.id)) return;
      var tabId = typeof m.tabId === 'string' ? m.tabId : '';
      var member = { tabId: tabId, key: tabId && okBoardKey('w:' + tabId) ? 'w:' + tabId : m.id, alive: m.alive === true, at: num(m.at) === null ? 0 : m.at };
      var old = has(st.members, m.id) ? st.members[m.id] : null;
      members[m.id] = old && old.tabId === member.tabId && old.key === member.key && old.alive === member.alive && old.at === member.at ? old : member;
      if (!has(groups, member.key)) groups[member.key] = [];
      groups[member.key].push(m.id);
    });
    Object.keys(groups).forEach(function (key) {
      groups[key].sort(function (a, b) {
        return Number(members[b].alive) - Number(members[a].alive) || members[b].at - members[a].at || (a < b ? -1 : a > b ? 1 : 0);
      });
      var old = has(st.groups, key) ? st.groups[key] : null;
      if (old && old.length === groups[key].length && old.every(function (sid, i) { return sid === groups[key][i]; })) groups[key] = old;
    });
    if (st.members && Object.keys(st.members).length === Object.keys(members).length &&
        Object.keys(members).every(function (sid) { return members[sid] === st.members[sid]; })) members = st.members;
    if (st.groups && Object.keys(st.groups).length === Object.keys(groups).length &&
        Object.keys(groups).every(function (key) { return groups[key] === st.groups[key]; })) groups = st.groups;
    var next = patched(st, { members: members, groups: groups });
    var shown = st.shown, follow = st.follow;
    // Commit follow only on known. Reads and tab-bar activation must retain the owner's last selected live pane.
    st.tabs.forEach(function (key) {
      if (!isWindow(key) || !rep(next, key)) return;
      var sid = shown[key], valid = has(members, sid) && members[sid].key === key;
      var first = rep(next, key), live = members[first].alive;
      if (valid && !(follow[key] && !members[sid].alive && live)) return;
      if (shown === st.shown) shown = copy(shown);
      shown[key] = first;
      if (!valid && (follow[key] === true) !== live) {
        if (follow === st.follow) follow = copy(follow);
        if (live) follow[key] = true;
        else delete follow[key];
      }
    });
    return patched(next, { shown: shown, follow: follow });
  }

  function openTab(st, a) {
    var sid = a.sid;
    if (!okId(sid)) return st;
    var key = keyOf(st, sid);
    var p = { active: key, peek: false };
    if (st.tabs.indexOf(key) < 0) {
      if (st.tabs.length >= LIST_MAX) return st; // refused here, so a reload never has to drop a tab
      p.tabs = st.tabs.concat([key]);
    }
    if (isWindow(key)) {
      if (st.shown[key] !== sid) { p.shown = copy(st.shown); p.shown[key] = sid; }
      var live = has(st.members, sid) && st.members[sid].alive;
      if ((st.follow[key] === true) !== live) {
        p.follow = copy(st.follow);
        if (live) p.follow[key] = true;
        else delete p.follow[key];
      }
    }
    if (SUBS.indexOf(a.sub) >= 0 && st.sub[sid] !== a.sub) { p.sub = copy(st.sub); p.sub[sid] = a.sub; }
    if (!expanded(st, sid)) { p.exp = copy(st.exp); p.exp[sid] = true; } // v5: the opened row shows its kids
    return patched(st, withSeen(st, sid, a.now, p));
  }

  function closeTab(st, sid) {
    if (!okBoardKey(sid) || st.tabs.indexOf(sid) < 0) return st;
    var before = order(st);
    var at = before.indexOf(sid);
    var p = {
      tabs: st.tabs.filter(function (x) { return x !== sid; }),
      pinned: st.pinned.filter(function (x) { return x !== sid; })
    };
    if (has(st.shown, sid)) { p.shown = copy(st.shown); delete p.shown[sid]; }
    if (has(st.follow, sid)) { p.follow = copy(st.follow); delete p.follow[sid]; }
    if (st.active === sid) {
      var after = before.filter(function (x) { return x !== sid; });
      p.active = after.length ? after[Math.max(0, at - 1)] : null;
    }
    return patched(st, p);
  }

  // Ids the prefs remember that the model no longer has: kept and stamped with the time they first went missing; once
  // gone for more than KEEP_MS they leave every list and map. Without a list of ids or a clock nothing is judged.
  function reconcile(st, known, now) {
    if (!Array.isArray(known) || typeof now !== 'number' || !isFinite(now)) return st;
    var here = map();
    known.forEach(function (id) { if (okId(id)) here[id] = true; });
    var tracked = map();
    [st.favs, st.tabs, st.pinned, st.active ? [st.active] : [], Object.keys(st.sub), Object.keys(st.seen), Object.keys(st.absent)]
      .forEach(function (list) { list.forEach(function (id) { tracked[id] = true; }); });
    var absent = copy(st.absent), gone = map(), changed = false, pruned = false, id;
    for (id in tracked) {
      if (isWindow(id)) continue; // window absence and expiry belong to the v2 reconciliation
      if (here[id]) {
        if (has(absent, id)) { delete absent[id]; changed = true; }
        continue;
      }
      if (!has(absent, id)) { absent[id] = now; changed = true; }
      if (now - absent[id] > KEEP_MS) { gone[id] = true; pruned = true; }
    }
    if (!changed && !pruned) return st;
    var p = { absent: absent };
    if (pruned) {
      var keep = function (x) { return !gone[x]; };
      for (id in gone) delete absent[id];
      p.favs = st.favs.filter(keep);
      p.tabs = st.tabs.filter(keep);
      p.pinned = st.pinned.filter(keep);
      p.sub = keepMap(st.sub, keep);
      p.seen = keepMap(st.seen, keep);
      p.exp = keepMap(st.exp, function (k) { return has(SECTIONS, k) || keep(k); });
      if (st.active && gone[st.active]) {
        var left = order({ tabs: p.tabs, pinned: p.pinned });
        p.active = left.length ? left[0] : null;
      }
    }
    return patched(st, p);
  }
  function keepMap(m, keep) {
    var out = map();
    for (var k in m) if (has(m, k) && keep(k)) out[k] = m[k];
    return out;
  }

  // valid, distinct ids (within `only` when given); stops at LIST_MAX + 1, one more than open/fav can make, which is
  // how load knows a stored list was longer
  function idList(v, only) {
    var list = arr(v), out = [], got = map(), allowed = null, i, id;
    if (only) { allowed = map(); only.forEach(function (x) { allowed[x] = true; }); }
    for (i = 0; i < list.length && out.length <= LIST_MAX; i++) {
      id = list[i];
      if (okId(id) && !got[id] && (!allowed || allowed[id])) { got[id] = true; out.push(id); }
    }
    return out;
  }
  function idMap(v, ok) {
    var out = map(), m = obj(v);
    if (!m) return out;
    for (var k in m) if (has(m, k) && okId(k) && ok(m[k])) out[k] = m[k];
    return out;
  }
  function stamp(v) { return typeof v === 'number' && isFinite(v) && v >= 0; }

  function load(json, known, now) {
    var st = defaults();
    var raw = null;
    if (typeof json !== 'string' || json === '') {
      st.prefsError = json === null || json === undefined || json === '' ? '' : 'shape';
    } else {
      try { raw = JSON.parse(json); } catch (e) { st.prefsError = 'corrupt'; }
      if (!st.prefsError && !obj(raw)) { st.prefsError = 'shape'; raw = null; }
    }
    if (raw) {
      if (typeof raw.sideOpen === 'boolean') st.sideOpen = raw.sideOpen;
      if (typeof raw.sideWidth === 'number' && isFinite(raw.sideWidth)) st.sideWidth = clampW(raw.sideWidth);
      if (VIEWS.indexOf(raw.view) >= 0) st.view = raw.view;
      if (keys(FILTERS).indexOf(raw.filter) >= 0) st.filter = raw.filter;
      var favList = idList(raw.favs), tabList = idList(raw.tabs);
      if (favList.length > LIST_MAX || tabList.length > LIST_MAX) st.prefsError = 'trimmed'; // longer than open/fav can make
      st.favs = favList.slice(0, LIST_MAX);
      st.tabs = tabList.slice(0, LIST_MAX);
      st.pinned = idList(raw.pinned, st.tabs);
      st.active = okId(raw.active) && st.tabs.indexOf(raw.active) >= 0 ? raw.active : null;
      st.sub = idMap(raw.sub, function (v) { return SUBS.indexOf(v) >= 0; });
      st.seen = idMap(raw.seen, stamp);
      st.absent = idMap(raw.absent, stamp);
    }
    return reconcile(st, known, now);
  }

  function reduce(state, action) {
    var st = obj(state) || defaults();
    var a = obj(action);
    if (!a) return st;
    switch (a.type) {
      case 'toggleSide':
        return a.narrow === true ? patched(st, { peek: !st.peek }) : patched(st, { sideOpen: !st.sideOpen, peek: false });
      case 'peek':
        return st.sideOpen ? st : patched(st, { peek: true });
      case 'unpeek':
        return patched(st, { peek: false });
      case 'resize':
        return typeof a.px === 'number' && isFinite(a.px) ? patched(st, { sideWidth: clampW(a.px) }) : st;
      case 'view': {
        if (VIEWS.indexOf(a.key) < 0) return st;
        var p = { view: a.key };
        if (keys(BOXES).indexOf(a.box) >= 0) p.box = a.box;
        if (a.narrow === true) p.peek = true;
        else { p.sideOpen = true; p.peek = false; }
        return patched(st, p);
      }
      case 'filter':
        return keys(FILTERS).indexOf(a.key) >= 0 ? patched(st, { filter: a.key }) : st;
      case 'search':
        return typeof a.text === 'string' ? patched(st, { search: Array.from(a.text).slice(0, SEARCH_MAX).join('') }) : st;
      case 'fav':
        if (!okId(a.sid) || (st.favs.indexOf(a.sid) < 0 && st.favs.length >= LIST_MAX)) return st;
        return patched(st, { favs: toggled(st.favs, a.sid) });
      case 'expand': {
        if (!okKey(a.sid)) return st;
        var exp = copy(st.exp);
        exp[a.sid] = !expanded(st, a.sid);
        return patched(st, { exp: exp });
      }
      case 'open':
        return openTab(st, a);
      case 'close':
        return closeTab(st, a.sid);
      case 'pin':
        return okBoardKey(a.sid) && st.tabs.indexOf(a.sid) >= 0 ? patched(st, { pinned: toggled(st.pinned, a.sid) }) : st;
      case 'active': {
        if (!okBoardKey(a.sid) || st.tabs.indexOf(a.sid) < 0) return st;
        var sid = shownOf(st, a.sid), active = { active: a.sid };
        return patched(st, sid === null ? active : withSeen(st, sid, a.now, active));
      }
      case 'load':
        return load(a.json, a.known, a.now);
      case 'known':
        return reconcile(Array.isArray(a.members) ? withMembers(st, a.members) : st, a.ids, a.now);
    }
    return st;
  }

  // the stored part (C-UI), exactly these keys
  function serialize(st) {
    return JSON.stringify({
      sideOpen: st.sideOpen, sideWidth: st.sideWidth, view: st.view, filter: st.filter, favs: st.favs, tabs: st.tabs,
      pinned: st.pinned, active: st.active, sub: st.sub, seen: st.seen, absent: st.absent
    });
  }
  // storage: undefined = the page's own localStorage; reading that property can itself throw (blocked storage)
  function restore(storage) {
    try {
      var s = storage !== undefined ? storage : g.localStorage;
      if (!s) return null;
      var v = s.getItem(KEY);
      return typeof v === 'string' ? v : null;
    } catch (e) {
      warnOnce('restore', '저장된 화면 설정을 읽을 수 없어 기본값으로 시작합니다', e);
      return null;
    }
  }
  function persist(storage, st) {
    try {
      var s = storage !== undefined ? storage : g.localStorage;
      if (!s) return false;
      s.setItem(KEY, serialize(st));
      return true;
    } catch (e) {
      warnOnce('persist', '화면 설정을 저장할 수 없음 - 새로 열면 기본값으로 돌아갑니다', e);
      return false;
    }
  }

  // ---- model --------------------------------------------------------------------------------------------------------
  function isAlive(s) { return s.alive === true; }
  // = view.js openDecisions (tabOf parity); open decisions for counts also leave out held ones (C-HOLD)
  function stillOpen(d) { return !!obj(d) && !d.answered && !d.closed; }
  function openDecs(s) { return arr(s.decisions).filter(function (d) { return stillOpen(d) && !d.held; }); }
  function answeredDecs(s) { return arr(s.decisions).filter(function (d) { return !!obj(d) && !!d.answered; }); }
  function heldDecs(s) { return arr(s.decisions).filter(function (d) { return !!obj(d) && !!d.held && !d.answered; }); }
  function isBlocked(s) { return s.statusKey === 'blocked' || s.status === 'blocked'; }
  function tabOf(s) {
    if (has(TAB_BY_LABEL, s.tab)) return TAB_BY_LABEL[s.tab];
    if (s.status === 'blocked' || arr(s.decisions).some(stillOpen) || obj(s.openQuestion)) return 'wait';
    if (s.status === 'done') return 'done';
    return 'run';
  }
  function unseen(s, st) {
    var at = toMs(s.lastActivityAt);
    return tabOf(s) === 'done' && at !== null && at > (has(st.seen, s.id) ? st.seen[s.id] : 0);
  }
  function workers(s) { return arr(obj(s.live) && s.live.workers).filter(obj).length; }
  // 계획: a plan, or auto.work, which reaches the model as workName (work.name) and auto.stage (work.phase).
  // Worker or todo telemetry alone (auto.workers, auto.todo*) is not a plan.
  function hasPlan(s) {
    var a = obj(s.auto);
    return !!obj(s.plan) || !!str(s.workName) || !!(a && (obj(a.work) || str(a.stage)));
  }
  function planCount(s) {
    var tasks = arr(obj(s.plan) && s.plan.tasks).filter(obj);
    if (tasks.length) return tasks.filter(function (t) { return t.state === 'done'; }).length + '/' + tasks.length;
    var a = obj(s.auto);
    return a && num(a.todoDone) !== null && num(a.todoTotal) !== null ? a.todoDone + '/' + a.todoTotal : '';
  }
  function planName(s) {
    var p = obj(s.plan) || {};
    return str(s.workName) || str(obj(p.source) && p.source.slug) || str(p.goal) || '계획';
  }
  function recency(a, b) {
    return ((toMs(b.lastActivityAt) || 0) - (toMs(a.lastActivityAt) || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  function byTabNumber(a, b) {
    var x = num(a.tabNumber), y = num(b.tabNumber);
    if (x === null || y === null) return x === y ? recency(a, b) : x === null ? 1 : -1;
    return (x - y) || recency(a, b);
  }

  function context(model) {
    var vm = obj(model) || {};
    var list = [], byId = map(), hostByTab = map();
    arr(vm.sessions).forEach(function (s) {
      if (!obj(s) || !okId(s.id) || has(byId, s.id)) return;
      byId[s.id] = s;
      list.push(s);
    });
    var alive = list.filter(isAlive).sort(byTabNumber);
    alive.forEach(function (s) { var t = str(s.tabId); if (t && !has(hostByTab, t)) hostByTab[t] = s; });
    var closed = list.filter(function (s) { return !isAlive(s); }).sort(recency);
    // the open conversation whose herdr tab this one lives (or lived) in: itself, or the alive one with its tabId
    function host(s) {
      if (isAlive(s)) return s;
      var t = str(s.tabId);
      return t && has(hostByTab, t) ? hostByTab[t] : null;
    }
    return {
      now: toMs(vm.generatedAt), list: list, byId: byId, alive: alive, closed: closed, host: host,
      isPrev: function (s) { return !isAlive(s) && !!host(s); },
      prevsOf: function (s) {
        var t = str(s.tabId);
        return t ? closed.filter(function (x) { return str(x.tabId) === t; }) : [];
      }
    };
  }

  function query(st) { return str(st.search).trim().toLowerCase(); }
  function found(s, q) {
    if (!q) return true;
    var hay = [s.title, s.tabLabel, s.headline];
    arr(s.decisions).forEach(function (d) { if (obj(d)) hay.push(d.question); });
    for (var i = 0; i < hay.length; i++) if (str(hay[i]).toLowerCase().indexOf(q) >= 0) return true;
    return false;
  }
  function passes(s, st, q) { return (st.filter === 'all' || tabOf(s) === st.filter) && found(s, q); }

  function answerText(d) {
    var a = obj(d.answer) || {};
    var opt = str(a.option), reply = str(a.text);
    if (opt) {
      var o = obj(has(obj(d.options) || {}, opt) ? d.options[opt] : null);
      return '→ ' + opt + (o && str(o.text) ? ' · ' + str(o.text) : '');
    }
    return reply ? '→ 답글 “' + cut(reply, 40) + '”' : '→ 답 받음';
  }

  // 수신함: wait = each open decision, each blocked conversation, each open terminal question; done = finished conversations
  // with activity after the owner last opened them; ans = the 12 newest answered decisions.
  function inboxOf(c, st) {
    var wait = [], done = [], ans = [], held = [];
    c.list.forEach(function (s) {
      openDecs(s).forEach(function (d) {
        wait.push({ s: s, sub: 'dec', at: toMs(d.createdAt), kind: '#' + str(d.id) + ' 결정 기다림' + (d.blocks ? ' · 작업 멈춤' : ''), text: str(d.question), hold: d });
      });
      heldDecs(s).forEach(function (d) {
        held.push({ s: s, sub: 'dec', id: num(d.id) || 0, at: toMs(obj(d.held) ? d.held.at : null), kind: '#' + str(d.id) + ' 보류됨', text: str(d.question), reopen: d });
      });
      if (isBlocked(s)) wait.push({ s: s, sub: 'ov', at: toMs(s.lastActivityAt), kind: '막힘', text: str(s.headline) });
      var q = obj(s.openQuestion);
      if (q) wait.push({ s: s, sub: 'ov', at: toMs(q.at), kind: '질문 열림 · 그 창에서 답하기', text: str(q.text) });
      if (unseen(s, st)) done.push({ s: s, sub: 'ov', at: toMs(s.lastActivityAt), kind: '끝남 — 결과 확인', text: str(s.headline) });
      answeredDecs(s).forEach(function (d) {
        ans.push({ s: s, sub: 'dec', id: num(d.id) || 0, at: toMs(obj(d.answer) ? d.answer.at : null), kind: '#' + str(d.id), text: str(d.question),
          answer: answerText(d), note: str(d.delivery) });
      });
    });
    var newest = function (a, b) { return ((b.at || 0) - (a.at || 0)) || recency(a.s, b.s); };
    wait.sort(newest);
    done.sort(newest);
    ans.sort(function (a, b) { return (b.id - a.id) || recency(a.s, b.s); });
    held.sort(function (a, b) { return (b.id - a.id) || recency(a.s, b.s); });
    return { wait: wait, done: done, ans: ans.slice(0, ANSWERED_MAX), held: held };
  }
  function inbox(model, st) { return inboxOf(context(model), st); }
  function badge(model, st) {
    var ib = inbox(model, st);
    return ib.wait.length + ib.done.length;
  }

  // ---- pieces of markup -------------------------------------------------------------------------------------------
  function hueOf(n) { return ((n * 5) % HUES + HUES) % HUES; } // neighbouring tab numbers land 150 degrees apart
  function tabNo(s, c) {
    var h = c.host(s);
    var n = h ? num(h.tabNumber) : null;
    return n !== null && Math.floor(n) === n ? n : null;
  }
  // coloured tab-number square; a conversation outside an open herdr tab gets the grey dot
  function icon(s, c, inherit) {
    var n = tabNo(s, c);
    if (n === null) return '<span class="sh-ico" aria-hidden="true">·</span>';
    return '<span class="sh-ico sh-ico-n' + (inherit ? '' : ' sh-h' + hueOf(n)) + '" aria-hidden="true">' + n + '</span>';
  }
  function hueClass(s, c) {
    var n = tabNo(s, c);
    return n === null ? '' : ' sh-h' + hueOf(n);
  }
  function nameOf(s) { return isAlive(s) && str(s.tabLabel) ? str(s.tabLabel) : (str(s.title) || '(제목 없음)'); }
  // full name for title tooltips: the same words as view.js whereLabel for a conversation in an open herdr tab
  function fullOf(s) {
    var title = str(s.title) || '(제목 없음)';
    if (!isAlive(s) || !str(s.tabLabel)) return title;
    return str(s.tabLabel) + (num(s.tabNumber) === null ? '' : ' #' + s.tabNumber) + ' · ' + title;
  }
  function ago(t, now) {
    var ms = toMs(t);
    if (ms === null || now === null) return '';
    var m = Math.round((now - ms) / 60000);
    if (m < 1) return '방금';
    return m < 60 ? m + '분 전' : m < 1440 ? Math.round(m / 60) + '시간 전' : Math.round(m / 1440) + '일 전';
  }
  function rowBadge(s, st) {
    var o = openDecs(s).length;
    if (o) return '<span class="sh-bdg" title="답을 기다리는 결정 ' + o + '개">' + ic('bell', 'ic-xs') + o + '</span>';
    if (isBlocked(s)) return '<span class="sh-bdg sh-bdg-r">막힘</span>';
    if (obj(s.openQuestion)) return '<span class="sh-bdg sh-bdg-q">질문</span>';
    if (unseen(s, st)) return '<span class="sh-bdg sh-bdg-g">확인</span>';
    return '';
  }
  function favBtn(sid, st) {
    var on = st.favs.indexOf(sid) >= 0;
    return '<button type="button" class="sh-fav" data-sh="fav" data-sid="' + esc(sid) + '" aria-pressed="' + on + '" aria-label="즐겨찾기" title="즐겨찾기">' +
      ic('star', on ? 'ic-md ic-fill' : 'ic-md') + '</button>';
  }

  function foldMark(s) { return obj(s.folded) ? '<span class="sh-fold">접힘</span>' : ''; }
  // o.flat: no kids toggle; o.sub: the grey text after the name ('' = none)
  function row(s, st, c, o) {
    var id = s.id;
    var kids = !o.flat && isAlive(s);
    var open = kids && expanded(st, id);
    var sub = o.sub !== undefined ? o.sub : (isAlive(s) && str(s.tabLabel) ? str(s.title) : '');
    var html = '<div class="sh-row' + (shownOf(st, st.active) === id ? ' sel' : '') + (c.isPrev(s) ? ' sh-prev' : '') + '" data-row="' + esc(id) + '">' +
      (kids ? '<button type="button" class="sh-tg" data-sh="expand" data-sid="' + esc(id) + '" aria-expanded="' + open + '" aria-label="' +
        (open ? '접기' : '펼치기') + '">' + ic(open ? 'chevron-down' : 'chevron-right', 'ic-xs') + '</button>' : '<span class="sh-tg" aria-hidden="true"></span>') +
      '<button type="button" class="sh-go" data-sh="open" data-sid="' + esc(id) + '">' + icon(s, c) +
      '<span class="sh-t" title="' + esc(fullOf(s)) + '">' + esc(nameOf(s)) + (sub ? '<span class="sh-sub">' + esc(sub) + '</span>' : '') + '</span>' +
      foldMark(s) + rowBadge(s, st) + '</button>' + favBtn(id, st) + '</div>';
    if (open) html += '<div class="sh-kids" role="group" aria-label="' + esc(nameOf(s)) + ' 펼침">' + kidRows(s, c, st) + '</div>';
    return html;
  }
  function kid(sid, sub, icon, text, extra, folded) {
    return '<div class="sh-row sh-kid' + (extra || '') + '"><span class="sh-tg" aria-hidden="true"></span>' +
      '<button type="button" class="sh-go" data-sh="open" data-sid="' + esc(sid) + '"' + (sub ? ' data-sub="' + sub + '"' : '') + '>' +
      '<span class="sh-ki" aria-hidden="true">' + ic(icon, 'ic-sm') + '</span><span class="sh-t" title="' + esc(text) + '">' + esc(text) + '</span>' + (folded ? '<span class="sh-fold">접힘</span>' : '') + '</button></div>';
  }
  function kidRows(s, c, st) {
    var html = '';
    if (hasPlan(s)) { var pc = planCount(s); html += kid(s.id, 'plan', 'list-todo', '계획' + (pc ? ' ' + pc : '')); }
    var w = workers(s);
    if (w) html += kid(s.id, 'wk', 'users', '작업자 ' + w);
    html += kid(s.id, 'dec', 'bell', '결정 ' + openDecs(s).length + ' 대기 · ' + answeredDecs(s).length + ' 답함');
    c.prevsOf(s).forEach(function (p) { html += kid(p.id, '', 'rotate-ccw-clock', '이전 대화 · ' + (str(p.title) || '(제목 없음)'), ' sh-prev' + (st.members !== null && p.id === shownOf(st, st.active) ? ' sel' : ''), !!obj(p.folded)); });
    return html;
  }
  // a remembered id the model does not have now: shown, not openable from here; its star still takes it off the favourites
  function goneRow(id, st) {
    return '<div class="sh-row sh-gone" data-row="' + esc(id) + '"><span class="sh-tg" aria-hidden="true"></span>' +
      '<span class="sh-go"><span class="sh-ico" aria-hidden="true">·</span><span class="sh-t" title="' + esc(GONE + ' · ' + id) + '">' + GONE + '</span></span>' +
      favBtn(id, st) + '</div>';
  }
  function section(key, title, body, n, st, empty) {
    var open = expanded(st, 'sec:' + key);
    return '<div class="sh-sec" data-sec="' + key + '"><button type="button" class="sh-sh" data-sh="expand" data-sid="sec:' + key + '" aria-expanded="' + open + '">' +
      '<span class="sh-sht">' + esc(title) + '</span>' + (n === null ? '' : '<span class="sh-cnt">' + n + '</span>') +
      '<span class="sh-ch" aria-hidden="true">' + ic(open ? 'chevron-down' : 'chevron-right', 'ic-xs') + '</span></button>' +
      (open ? '<div class="sh-nav">' + (body || '<p class="sh-empty">' + esc(empty) + '</p>') + '</div>' : '') + '</div>';
  }
  function item(it, c) {
    var s = it.s;
    var when = ago(it.at, c.now);
    return '<button type="button" class="sh-it' + hueClass(s, c) + '" data-sh="open" data-sid="' + esc(s.id) + '" data-sub="' + it.sub + '">' +
      icon(s, c, true) + '<span class="sh-itb"><span class="sh-k">' + esc(nameOf(s)) + ' · ' + esc(it.kind) + '</span>' +
      '<span class="sh-iq">' + esc(it.text || '(내용 없음)') + (it.answer ? ' <span class="sh-ans">' + ic('arrow-right', 'ic-xs') + ' ' + esc(it.answer.slice(2)) + '</span>' : '') + '</span>' +
      (when || it.note ? '<span class="sh-w">' + timed([when, it.note].filter(Boolean).join(' · ')) + '</span>' : '') + '</span></button>';
  }
  function empty(text) { return '<p class="sh-empty">' + esc(text) + '</p>'; }
  // an inbox item with its 보류 / 다시 열기 controls (server page only): the controls sit beside the item button, never in it
  function inboxItem(it, c, st) {
    var d = it.hold || it.reopen;
    var id = d ? num(d.id) : null;
    if (st.live !== true || id === null || id < 1 || Math.floor(id) !== id) return item(it, c);
    var a = obj(st.answers) && has(st.answers, String(id)) ? obj(st.answers[String(id)]) : null;
    var at = ' data-id="' + id + '" data-where="inbox"';
    var phase = a ? str(a.phase) : '';
    var ctl;
    if (phase === 'sending') ctl = '<span class="sh-w" role="status">보내는 중…</span>';
    else if (it.reopen) ctl = '<button type="button" class="sh-act" data-act="ans-reopen"' + at + '>다시 열기</button>';
    else if (a && !phase && obj(a.confirm) && a.confirm.hold === true) {
      ctl = '<span class="sh-hq">' + holdWhere(it.s) + ' 대화의 #' + id + '를 보류할까요? 대화는 다시 묻지 않아요</span>' +
        '<button type="button" class="sh-act" data-act="ans-send"' + at + '>보류</button><button type="button" class="sh-act" data-act="ans-cancel"' + at + '>취소</button>';
    } else ctl = '<button type="button" class="sh-act" data-act="ans-hold"' + at + '>보류</button>';
    var err = a && str(a.error) ? '<span class="sh-err" role="alert">' + esc(a.error) + '</span>' : '';
    return '<div class="sh-iw">' + item(it, c) + '<div class="sh-acts">' + ctl + err + '</div></div>';
  }
  // = view.js whereHtml: herdr tab label and number, else the pane, else the title (html)
  function holdWhere(s) {
    var label = str(s.tabLabel);
    if (label) return ic('app-window') + ' ' + esc(label + (num(s.tabNumber) === null ? '' : ' #' + s.tabNumber));
    return esc(str(s.paneId) ? '창 ' + str(s.paneId) : (str(s.title) || '(제목 없음)'));
  }

  // ---- sidebar views (list region) ----------------------------------------------------------------------------------
  function convView(c, st) {
    var q = query(st);
    var narrowed = st.filter !== 'all' || !!q;
    var favs = '', favN = 0;
    st.favs.forEach(function (id) {
      var s = has(c.byId, id) ? c.byId[id] : null;
      if (s ? passes(s, st, q) : !narrowed) { favs += s ? row(s, st, c, { flat: true }) : goneRow(id, st); favN++; }
    });
    var open = c.alive.filter(function (s) { return passes(s, st, q); });
    var recent = c.list.filter(function (s) { return !c.isPrev(s) && passes(s, st, q); }).sort(recency).slice(0, RECENT_MAX);
    var closedN = c.closed.filter(function (s) { return found(s, q); }).length;
    return (favN ? section('fav', '즐겨찾기', favs, favN, st, '') : '') +
      section('tabs', '열린 탭', open.map(function (s) { return row(s, st, c, {}); }).join(''), open.length, st, narrowed ? '맞는 대화 없음' : '열린 대화 없음') +
      section('recent', '최근 항목', recent.map(function (s) { return row(s, st, c, { flat: true, sub: '' }); }).join(''), recent.length, st, '없음') +
      '<div class="sh-sec"><button type="button" class="sh-sh" data-sh="view" data-key="archive"><span class="sh-sht">닫힌 창</span>' +
      '<span class="sh-cnt">' + closedN + '</span><span class="sh-ch" aria-hidden="true">' + ic('chevron-right', 'ic-xs') + '</span></button></div>';
  }
  function inboxView(c, st) {
    var ib = inboxOf(c, st);
    var html = '<div class="sh-ptabs" role="group" aria-label="수신함 묶음">' + BOXES.map(function (b) {
      return '<button type="button" class="sh-pt' + (st.box === b[0] ? ' on' : '') + '" data-sh="view" data-key="inbox" data-box="' + b[0] + '" aria-pressed="' +
        (st.box === b[0]) + '">' + b[1] + (b[0] === 'ans' ? '' : ' ' + ib[b[0]].length) + '</button>';
    }).join('') + '</div>';
    var list = ib[st.box] || ib.wait;
    var none = { wait: '기다리는 것 없음', done: '확인할 끝난 대화 없음', ans: '아직 답한 결정 없음', held: '보류한 결정 없음' }[st.box] || '기다리는 것 없음';
    return html + (list.length ? list.map(function (it) { return inboxItem(it, c, st); }).join('') : empty(none));
  }
  function plansView(c) {
    var list = c.list.filter(function (s) { return !c.isPrev(s) && hasPlan(s); }).sort(recency);
    if (!list.length) return empty('계획이 있는 대화 없음');
    return list.map(function (s) {
      var pc = planCount(s);
      return item({ s: s, sub: 'plan', at: toMs(s.lastActivityAt), kind: '계획', text: planName(s) + (pc ? ' · ' + pc : '') }, c);
    }).join('');
  }
  function homeView(c, st) {
    var ib = inboxOf(c, st);
    var line = function (key, box, icon, label, n) {
      return '<button type="button" class="sh-hr" data-sh="view" data-key="' + key + '"' + (box ? ' data-box="' + box + '"' : '') + '>' +
        '<span class="sh-ki" aria-hidden="true">' + ic(icon, 'ic-sm') + '</span><span class="sh-hl">' + label + '</span><b class="sh-num">' + n + '</b></button>';
    };
    return '<div class="sh-nav sh-home">' + line('inbox', 'wait', 'bell', '기다리는 것', ib.wait.length) +
      line('inbox', 'done', 'check', '끝남 확인', ib.done.length) + line('conv', '', 'layout-grid', '열린 탭', c.alive.length) + '</div>' +
      section('tabs', '열린 탭', c.alive.map(function (s) { return row(s, st, c, { flat: true }); }).join(''), c.alive.length, st, '열린 대화 없음');
  }
  function archiveView(c, st) {
    var q = query(st);
    var list = c.closed.filter(function (s) { return found(s, q); });
    if (!list.length) return empty(q ? '검색에 맞는 닫힌 창 없음' : '닫힌 창 없음');
    return '<div class="sh-nav">' + list.map(function (s) { return row(s, st, c, { flat: true, sub: ago(s.lastActivityAt, c.now) }); }).join('') + '</div>';
  }
  function settingsView() {
    var alarm = g.BriefAlarm;
    return '<div class="sh-set"><p class="sh-seth">' + ic('bell') + ' 알림 소리</p><p class="sh-setr">' +
      (alarm && typeof alarm.soundButtonHtml === 'function' ? alarm.soundButtonHtml() : '<span class="sh-empty">알림 모듈이 없어 바꿀 수 없음</span>') +
      ' <span class="sh-hint">답 기다림 알람 소리 켜기/끄기 (이 브라우저에만 저장)</span></p>' +
      '<p class="sh-seth">' + ic('info') + ' 표시 뜻</p><ul class="legend-list sh-legend">' + LEGEND.map(function (l) {
        return '<li><span class="chip ' + l[0] + '">' + esc(l[1]) + '</span> = ' + esc(l[2]) + '</li>';
      }).join('') + '</ul></div>';
  }

  function side(model, st) {
    var c = context(model);
    switch (st.view) {
      case 'inbox': return inboxView(c, st);
      case 'plans': return plansView(c);
      case 'home': return homeView(c, st);
      case 'archive': return archiveView(c, st);
      case 'settings': return settingsView();
      case 'memento': return '<p class="sh-empty">카드는 오른쪽 메멘토 탭에서 볼 수 있어요</p>';
    }
    return convView(c, st);
  }

  function rail(model, st) {
    var n = badge(model, st);
    // the tooltip is the label word for word; a count lives in the badge and in the spoken name only
    var btn = function (key, icon, label, on, extra, spoken) {
      return '<button type="button" class="sh-rb' + (on ? ' on' : '') + '" data-sh="view" data-key="' + key + '"' +
        ' aria-label="' + esc(spoken || label) + '" aria-pressed="' + on + '"><span class="sh-ri" aria-hidden="true">' +
        ic(icon, on ? 'ic-rail ic-sel' : 'ic-rail') + '</span>' + (extra || '') + '<span class="sh-tip" aria-hidden="true">' + esc(label) + '</span></button>';
    };
    var html = '';
    RAIL.forEach(function (r) {
      var count = r[0] === 'inbox' && n ? '<span class="sh-n" aria-hidden="true">' + (n > 99 ? '99+' : n) + '</span>' : '';
      html += btn(r[0], r[1], r[2], st.view === r[0], count, count ? r[2] + ' ' + n + '개' : '');
    });
    return html + '<span class="sh-rsp" aria-hidden="true"></span>' + btn('settings', 'settings', '설정', st.view === 'settings');
  }

  function tabs(model, st) {
    var c = context(model);
    var html = '<button type="button" class="sh-topen" data-sh="toggleSide" title="사이드바 열기 (Ctrl+\\)" aria-label="사이드바 열기">' + ic('panel-left-open', 'ic-md') + '</button>';
    order(st).forEach(function (id) {
      var s = has(c.byId, id) ? c.byId[id] : null;
      var on = st.active === id, pin = st.pinned.indexOf(id) >= 0;
      var name = s ? nameOf(s) : GONE;
      var o = s ? openDecs(s).length : 0;
      html += '<div class="tb' + (on ? ' on' : '') + (pin ? ' pinned' : '') + (s ? '' : ' sh-gone') + '" data-tab="' + esc(id) + '" title="' +
        esc((s ? fullOf(s) : GONE + ' · ' + id) + ' (두 번 누르면 탭 고정' + (pin ? ' 풀기' : '') + ')') + '">' +
        '<button type="button" class="tb-go" data-sh="active" data-sid="' + esc(id) + '" aria-pressed="' + on + '">' +
        (pin ? '<span class="tb-pin" aria-hidden="true">' + ic('pin', 'ic-xs') + '</span>' : '') + (s ? icon(s, c) : '<span class="sh-ico" aria-hidden="true">·</span>') +
        '<span class="tt">' + esc(name) + '</span>' + (o ? '<span class="sh-bdg">' + ic('bell', 'ic-xs') + o + '</span>' : '') + '</button>' +
        '<button type="button" class="tb-x" data-sh="close" data-sid="' + esc(id) + '" aria-label="탭 닫기: ' + esc(name) + '" title="탭 닫기">' + ic('x', 'ic-xs') + '</button></div>';
    });
    return html + '<button type="button" class="sh-tadd" data-sh="view" data-key="home" title="새 탭: 홈" aria-label="홈 보기">' + ic('plus', 'ic-md') + '</button>';
  }

  function searchHint(view) { return view === 'archive' ? '닫힌 창 검색' : '대화·결정 검색'; }
  function chipsHtml(st) {
    return FILTERS.map(function (f) {
      var on = st.filter === f[0];
      return '<button type="button" class="sh-chip' + (on ? ' on' : '') + '" data-sh="filter" data-key="' + f[0] + '" aria-pressed="' + on + '">' + f[1] + '</button>';
    }).join('');
  }
  function width(st) { return typeof st.sideWidth === 'number' && isFinite(st.sideWidth) ? clampW(st.sideWidth) : DEF_W; }
  function viewOf(st) { return VIEWS.indexOf(st.view) >= 0 ? st.view : 'conv'; }

  function sideFrame(state) {
    var st = obj(state) || defaults();
    var hint = searchHint(viewOf(st));
    return '<div class="sh-rz" data-sh="rz" role="separator" tabindex="0" aria-orientation="vertical" aria-label="사이드바 너비" aria-valuemin="' + MIN_W +
      '" aria-valuemax="' + MAX_W + '" aria-valuenow="' + width(st) + '" title="끌거나 왼쪽·오른쪽 화살표로 너비 조절"></div>' +
      '<div class="sh-head"><span class="sh-title" data-sh-part="title">' + VIEW_TITLE[viewOf(st)] + '</span>' +
      '<button type="button" class="sh-ib" data-sh="toggleSide" title="사이드바 닫기 (Ctrl+\\)" aria-label="사이드바 닫기">' + ic('panel-left-close', 'ic-md') + '</button></div>' +
      '<button type="button" class="sh-back" data-sh="view" data-key="conv">' + ic('arrow-left') + ' 사이드바로 돌아가기</button>' +
      '<label class="sh-qlbl" for="sh-q">검색</label>' +
      '<label class="sh-srch">' + ic('search', 'ic-md') + '<input type="search" id="sh-q" class="sh-q" data-sh="search" maxlength="' + SEARCH_MAX +
      '" autocomplete="off" spellcheck="false" placeholder="' + hint + '" aria-label="' + hint + '" value="' + esc(st.search) + '"></label>' +
      '<div class="sh-flt" role="group" aria-label="걸러 보기">' + chipsHtml(st) + '</div>' +
      '<div class="sh-scroll" data-sh-part="list"></div>';
  }

  function skeleton(state) {
    var st = obj(state) || defaults();
    return '<div class="sh-shell" data-shell data-side="' + (st.sideOpen === false ? 'closed' : 'open') + '" data-peek="' + (st.peek === true) +
      '" data-view="' + viewOf(st) + '" style="--sw:' + width(st) + 'px">' +
      '<nav id="rail" class="sh-rail" aria-label="상황판 메뉴"></nav><div id="edge" class="sh-edge" aria-hidden="true"></div>' +
      '<aside id="side" class="sh-side" aria-label="사이드바">' + sideFrame(st) + '</aside>' +
      '<div class="sh-wrap"><div id="tabs" class="sh-tabs"></div><main id="main" class="sh-main"></main></div></div>';
  }

  // ---- DOM: the frame's live bits and the listeners ---------------------------------------------------------------
  // Reduced motion: the sidebar's slide (margin-left) is off in shell.css; instead the part that changed fades in over
  // tokens.css --dur. A fade a new flip interrupts goes on from the opacity it had reached, never from 0 again.
  function crossFade(root, docked, shown) {
    if (typeof g.matchMedia !== 'function' || !g.matchMedia(CALM).matches) return;
    var raw = typeof g.getComputedStyle === 'function' ? String(g.getComputedStyle(root).getPropertyValue('--dur')).trim() : '';
    var dur = /ms$/.test(raw) ? parseFloat(raw) : parseFloat(raw) * 1000;
    var ms = isFinite(dur) && dur > 0 ? dur : 150;
    var kids = root.children || [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i], cls = el.classList;
      var fade = cls && ((docked && cls.contains('sh-wrap')) || (shown && cls.contains('sh-side')));
      if (!fade || typeof el.animate !== 'function') continue;
      var from = 0;
      var running = typeof el.getAnimations === 'function' ? el.getAnimations().filter(function (a) { return a.id === 'sh-xfade'; }) : [];
      if (running.length) {
        from = Number(g.getComputedStyle(el).opacity) || 0;
        running.forEach(function (a) { a.cancel(); });
      }
      if (ms * (1 - from) < 1) continue;
      el.animate([{ opacity: from }, { opacity: 1 }], { duration: ms * (1 - from), easing: 'linear' }).id = 'sh-xfade';
    }
  }

  function sync(root, st) {
    if (!root || typeof root.setAttribute !== 'function') return;
    var view = viewOf(st);
    var side0 = root.getAttribute('data-side'), peek0 = root.getAttribute('data-peek');
    var side = st.sideOpen === false ? 'closed' : 'open', peek = st.peek === true ? 'true' : 'false';
    root.setAttribute('data-side', side);
    root.setAttribute('data-peek', peek);
    root.setAttribute('data-view', view);
    if (side0 !== null && (side0 !== side || peek0 !== peek)) {
      crossFade(root, side0 !== side, (side === 'open' && side0 !== 'open') || (peek === 'true' && peek0 !== 'true'));
    }
    if (root.style && typeof root.style.setProperty === 'function') root.style.setProperty('--sw', width(st) + 'px');
    cover(root, narrowNow());
    var title = root.querySelector('[data-sh-part="title"]');
    if (title) title.textContent = VIEW_TITLE[view];
    var input = root.querySelector('[data-sh="search"]');
    if (input) {
      input.setAttribute('placeholder', searchHint(view));
      input.setAttribute('aria-label', searchHint(view));
      var doc = root.ownerDocument;
      if (input.value !== st.search && (!doc || doc.activeElement !== input)) input.value = st.search;
    }
    var rz = root.querySelector('[data-sh="rz"]');
    if (rz) rz.setAttribute('aria-valuenow', String(width(st)));
    var chips = root.querySelectorAll('[data-sh="filter"]');
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-key') === st.filter;
      if (on) chips[i].classList.add('on');
      else chips[i].classList.remove('on');
      chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function narrowNow() { return !!(typeof g.matchMedia === 'function' && g.matchMedia(NARROW).matches); }
  // visual-qa I1 (task-1 deviations D1 overlay): below 900 px the open sidebar lies over the column beside the rail, and
  // that column is inert while it does - no Tab stop, click or touch reaches what the panel hides. The rail stays usable.
  function cover(root, narrow) {
    var wrap = root.querySelector('.sh-wrap');
    if (!wrap) return;
    if (narrow && root.getAttribute('data-peek') === 'true') wrap.setAttribute('inert', '');
    else wrap.removeAttribute('inert');
  }
  // visual-qa I2: Escape shuts the narrow overlay when it is the top layer. An open dialog (the annotation composer lies
  // above the overlay) takes Escape first; a key another handler took, a modified key or an IME composition's is left.
  function dismissKey(e, root, doc, narrow) {
    if (!e || e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
    if (!narrow || root.getAttribute('data-peek') !== 'true') return false;
    return !(doc && typeof doc.querySelector === 'function' && doc.querySelector('[role="dialog"]'));
  }

  // Ctrl+\ (no other modifier) toggles the sidebar; the browser's own use of the key is suppressed
  function keyAction(e) {
    if (!e || !e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
    if (e.key !== '\\' && e.code !== 'Backslash') return null;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    return e.repeat ? null : { type: 'toggleSide' };
  }

  // the action a [data-sh] element stands for; o = {narrow, now}
  function actionOf(el, o) {
    if (!el || typeof el.getAttribute !== 'function') return null;
    var opt = o || {};
    var act = el.getAttribute('data-sh');
    var sid = el.getAttribute('data-sid');
    var a;
    switch (act) {
      case 'toggleSide': return { type: 'toggleSide', narrow: opt.narrow === true };
      case 'view':
        a = { type: 'view', key: el.getAttribute('data-key'), narrow: opt.narrow === true };
        if (el.getAttribute('data-box')) a.box = el.getAttribute('data-box');
        return a;
      case 'filter': return { type: 'filter', key: el.getAttribute('data-key') };
      case 'open':
        a = { type: 'open', sid: sid, now: num(opt.now) };
        if (el.getAttribute('data-sub')) a.sub = el.getAttribute('data-sub');
        return a;
      case 'active': return { type: 'active', sid: sid, now: num(opt.now) };
      case 'close': case 'pin': case 'fav': case 'expand': return { type: act, sid: sid };
    }
    return null;
  }

  function closest(node, sel) {
    var el = node && node.nodeType === 3 ? node.parentNode : node;
    return el && typeof el.closest === 'function' ? el.closest(sel) : null;
  }

  function bind(root, hooks) {
    var h = hooks || {};
    var doc = h.doc || root.ownerDocument || g.document;
    var narrow = typeof h.narrow === 'function' ? h.narrow : narrowNow;
    var now = typeof h.now === 'function' ? h.now : function () { return Date.now(); };
    var send = function (a) { if (a) h.dispatch(a); };
    var listeners = [];
    var on = function (target, type, fn) { target.addEventListener(type, fn); listeners.push([target, type, fn]); };

    on(root, 'click', function (e) {
      var el = closest(e.target, '[data-sh]');
      if (el) send(actionOf(el, { narrow: narrow(), now: now() }));
    });
    on(root, 'dblclick', function (e) {
      if (closest(e.target, '[data-sh="close"]')) return;
      var tab = closest(e.target, '[data-tab]');
      if (tab) send({ type: 'pin', sid: tab.getAttribute('data-tab') });
    });
    on(root, 'input', function (e) {
      var t = e.target;
      if (t && typeof t.getAttribute === 'function' && t.getAttribute('data-sh') === 'search') send({ type: 'search', text: String(t.value) });
    });
    on(root, 'mouseover', function (e) { if (closest(e.target, '.sh-edge') && !narrow()) send({ type: 'peek' }); });
    on(root, 'mouseout', function (e) {
      var panel = closest(e.target, '.sh-side');
      if (panel && !(e.relatedTarget && typeof panel.contains === 'function' && panel.contains(e.relatedTarget))) send({ type: 'unpeek' });
    });
    on(root, 'mousedown', function (e) {
      var rz = closest(e.target, '[data-sh="rz"]');
      if (!rz || e.button !== 0) return;
      e.preventDefault(); // no text selection while dragging
      var panel = closest(rz, '.sh-side');
      var w0 = panel && typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect().width : DEF_W;
      var x0 = e.clientX;
      var move = function (ev) { send({ type: 'resize', px: w0 + (ev.clientX - x0) }); };
      var up = function () {
        doc.removeEventListener('mousemove', move);
        doc.removeEventListener('mouseup', up);
        if (root.classList) root.classList.remove('is-resizing');
      };
      if (root.classList) root.classList.add('is-resizing');
      doc.addEventListener('mousemove', move);
      doc.addEventListener('mouseup', up);
    });
    // the resize handle from the keyboard: the same resize action as the drag, from the width sync() keeps on it
    on(root, 'keydown', function (e) {
      var rz = closest(e.target, '[data-sh="rz"]');
      if (!rz || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      var w = Number(rz.getAttribute('aria-valuenow'));
      var px = { ArrowLeft: w - RZ_STEP, ArrowRight: w + RZ_STEP, Home: MIN_W, End: MAX_W }[e.key];
      if (typeof px !== 'number' || !isFinite(px)) return;
      if (typeof e.preventDefault === 'function') e.preventDefault(); // no page scroll
      send({ type: 'resize', px: px });
    });
    on(doc, 'keydown', function (e) {
      var a = keyAction(e);
      if (a) { a.narrow = narrow(); send(a); return; }
      if (!dismissKey(e, root, doc, narrow())) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      send({ type: 'unpeek' });
    });
    // a resize or rotation across 900 px turns the open overlay into the docked sidebar and back: the cover follows
    var mq = typeof g.matchMedia === 'function' ? g.matchMedia(NARROW) : null;
    if (mq && typeof mq.addEventListener === 'function') on(mq, 'change', function () { cover(root, narrow()); });
    return function unbind() {
      listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
      listeners = [];
    };
  }

  g.BriefShell = {
    KEY: KEY, MIN_W: MIN_W, MAX_W: MAX_W, DEF_W: DEF_W, KEEP_MS: KEEP_MS, LIST_MAX: LIST_MAX, GONE: GONE,
    defaults: defaults, reduce: reduce, order: order, keyOf: keyOf, shownOf: shownOf, serialize: serialize, restore: restore, persist: persist,
    tabOf: tabOf, inbox: inbox, badge: badge,
    rail: rail, side: side, tabs: tabs, sideFrame: sideFrame, skeleton: skeleton,
    sync: sync, keyAction: keyAction, actionOf: actionOf, bind: bind
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
