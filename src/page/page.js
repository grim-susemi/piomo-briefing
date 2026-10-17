/* omo-briefing page controller, classic script (file:// safe, no modules).
 * Load order in index.html: view.js, page.js (data.js is pulled in by this file on file://).
 * Transport:
 *  - http(s) origin (live board server): one fetch of /data.json + EventSource('/events').
 *    No polling. A dropped stream shows a banner; the browser reconnects by itself.
 *  - file:// origin: re-insert <script src="data.js?v=n"> every 2 s while the page is visible.
 * A larger seq is applied automatically (normally at most once per 500 ms, latest wins). While the
 * owner is selecting text, typing, or holding the pointer down inside the board the update is held
 * back and a badge says so; release takes priority over that throttle and applies within 300 ms.
 * Applying keeps the tab, the opened cards and the card that was at the top of the screen.
 * Server page only: decision answers (A/B/C buttons, reply box) go out as POST /answer with the page's write token
 * (see 'board answers' below). */
(function (g) {
  'use strict';
  var doc = g.document;
  if (!doc) return;
  var DATA_URL = g.BRIEF_DATA_URL || 'data.js';
  var POLL_MS = 2000;
  var APPLY_MIN_MS = 500;
  var RELEASE_MS = 100;
  var GLOW_MS = 900;
  var EMPTY = { seq: -1, generatedAt: null, sessions: [] };
  var stampEl = doc.querySelector && doc.querySelector('meta[name="omo-briefing' + '-generation"]');
  var stamp = stampEl && stampEl.getAttribute('content');
  var ownGeneration = typeof stamp === 'string' && /^\d+$/.test(stamp) ? generationOf(Number(stamp)) : null;
  var generationFloor = ownGeneration;
  var pendingGeneration = null;
  var reconnectErrors = 0;
  var closedNotice = false;

  function generationOf(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null; }
  function rememberGeneration(v) {
    var n = generationOf(v);
    if (n !== null && (generationFloor === null || n > generationFloor)) generationFloor = n;
  }

  var state = {
    model: null,
    real: false,
    seq: -1,
    pending: null,
    n: 0,
    appliedAt: 0,
    transport: 'file',
    pointerDown: false,
    now: function () { return Date.now(); },
    ui: { tab: null, expanded: Object.create(null), tocOpen: false, legendOpen: false, doneOpen: false, live: false, focus: Object.create(null) }
  };
  var hooks = { beforeApply: [], afterApply: [] };
  var root, badge, statusEl, linkEl, errEl, applyTimer = null, releaseTimer = null, sessionJson = {}, glowTimers = {};
  var heldForBusy = false;

  function esc(v) { return g.BriefView && g.BriefView.escapeHtml ? g.BriefView.escapeHtml(v) : String(v); }
  function seqOf(d) { return d && typeof d.seq === 'number' && isFinite(d.seq) ? d.seq : 0; }

  // Page script errors are never swallowed: console.error + a small 'screen error' mark.
  function fail(where, e) {
    if (g.console && g.console.error) g.console.error('[omo-briefing] ' + where, e);
    if (!errEl && doc.body) {
      errEl = doc.createElement('div');
      errEl.id = 'page-error';
      errEl.setAttribute('style', 'position:fixed;right:8px;bottom:8px;z-index:9999;background:#7a1f1f;color:#fff;font:12px sans-serif;padding:4px 8px;border-radius:4px');
      doc.body.appendChild(errEl);
    }
    if (errEl) { errEl.textContent = '화면 오류'; errEl.hidden = false; }
  }
  function guard(where, fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { fail(where, e); }
    };
  }

  function ensureRoot() {
    root = doc.getElementById('app');
    if (!root) { root = doc.createElement('div'); root.id = 'app'; doc.body.appendChild(root); }
    badge = doc.getElementById('new-badge');
    if (!badge) {
      badge = doc.createElement('button');
      badge.type = 'button';
      badge.id = 'new-badge';
      badge.className = 'new-badge';
      badge.hidden = true;
      badge.textContent = '● 새 내용 - 선택·입력이 끝나면 반영';
      doc.body.appendChild(badge);
    }
    statusEl = doc.getElementById('live-status');
    if (!statusEl) {
      statusEl = doc.createElement('div');
      statusEl.id = 'live-status';
      statusEl.className = 'live-status';
      statusEl.hidden = true;
      statusEl.setAttribute('style', 'position:sticky;top:0;z-index:50;background:#444;color:#fff;font:13px sans-serif;padding:4px 10px;text-align:center');
      if (doc.body.insertBefore && doc.body.firstChild) doc.body.insertBefore(statusEl, doc.body.firstChild);
      else doc.body.appendChild(statusEl);
    }
    linkEl = doc.getElementById('live-link');
    if (!linkEl) {
      linkEl = doc.createElement('a');
      linkEl.id = 'live-link';
      linkEl.className = 'live-link';
      linkEl.hidden = true;
      linkEl.setAttribute('style', 'display:none;text-align:center;font:13px sans-serif;padding:4px');
      if (doc.body.insertBefore) doc.body.insertBefore(linkEl, root);
      else doc.body.appendChild(linkEl);
    }
    badge.addEventListener('click', guard('badge', apply));
    root.addEventListener('click', guard('click', onClick));
    root.addEventListener('input', guard('input', onInput));
    g.addEventListener('scroll', guard('scroll', spy), { passive: true });
    g.addEventListener('resize', guard('resize', spy));
    // "busy" release triggers
    doc.addEventListener('selectionchange', guard('selectionchange', scheduleRelease));
    doc.addEventListener('focusout', guard('focusout', scheduleRelease));
    doc.addEventListener('pointerdown', guard('pointerdown', function (ev) {
      if (ev && ev.target && root.contains(ev.target)) state.pointerDown = true;
    }));
    var up = guard('pointerup', function () { state.pointerDown = false; scheduleRelease(); });
    doc.addEventListener('pointerup', up);
    doc.addEventListener('pointercancel', up);
    g.addEventListener('error', function (ev) { fail('window.onerror', ev && (ev.error || ev.message)); });
  }

  // ---- busy: the owner is selecting, typing or pressing inside the board -------------------------
  function busy() {
    if (state.pointerDown) return true;
    var sel = g.getSelection && g.getSelection();
    if (sel && !sel.isCollapsed && String(sel).length > 0 && (!sel.anchorNode || root.contains(sel.anchorNode))) return true;
    var a = doc.activeElement;
    if (a && root.contains(a)) {
      var tag = String(a.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || a.isContentEditable) return true;
    }
    return false;
  }

  function scheduleRelease() {
    if ((!state.pending && pendingGeneration === null) || releaseTimer) return;
    releaseTimer = g.setTimeout(function () {
      releaseTimer = null;
      // A busy-held update has a 300 ms release deadline, even inside the normal 500 ms window.
      if (heldForBusy && !busy()) apply();
      else consider();
    }, RELEASE_MS);
  }

  // ---- scroll anchor: first [data-card] visible at the top of the screen ------------------------
  function captureAnchor() {
    if (!root) return null;
    var cards = root.querySelectorAll('[data-card]');
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].getBoundingClientRect();
      if (r.bottom === undefined || r.bottom > 0) {
        return { id: cards[i].getAttribute('data-card'), top: r.top };
      }
    }
    return null;
  }
  function restoreAnchor(a, y) {
    if (!a) { g.scrollTo(0, y); return; }
    var cards = root.querySelectorAll('[data-card]');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-card') === a.id) {
        g.scrollTo(0, y + (cards[i].getBoundingClientRect().top - a.top));
        return;
      }
    }
    g.scrollTo(0, y);
  }

  function render() {
    var y = g.scrollY || 0;
    var anchor = captureAnchor();
    try {
      root.innerHTML = g.BriefView.renderApp(state.model || EMPTY, state.ui);
    } catch (e) {
      fail('render', e);
      root.innerHTML = '<p class="fatal">화면을 그리지 못했습니다: ' + esc(e && e.message) + '</p>';
    }
    // ui.tab stays null until the owner picks a tab, so the view keeps choosing a
    // sensible default (e.g. after the first real data replaces the empty screen).
    restoreAnchor(anchor, y);
    spy();
  }

  function runHooks(list, arg) {
    for (var i = 0; i < list.length; i++) {
      try { list[i](arg); } catch (e) { fail('hook', e); }
    }
  }

  function glow(model) {
    var next = {}, sessions = model && Array.isArray(model.sessions) ? model.sessions : [];
    var first = !state.glowReady;
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      if (!s || typeof s.id !== 'string') continue;
      var j = JSON.stringify(s);
      next[s.id] = j;
      if (!first && sessionJson[s.id] !== j) startGlow(s.id);
    }
    sessionJson = next;
    state.glowReady = true;
    // every render replaces the card elements: re-apply glows still inside their own 900 ms
    for (var id in glowTimers) setFlash(id, true);
  }

  function setFlash(id, on) {
    var cards = root.querySelectorAll('[data-card]');
    for (var k = 0; k < cards.length; k++) {
      var el = cards[k];
      if (el.getAttribute('data-card') === id && el.classList) {
        if (on) el.classList.add('flash'); else el.classList.remove('flash');
      }
    }
  }

  function startGlow(id) {
    if (glowTimers[id]) g.clearTimeout(glowTimers[id]);
    glowTimers[id] = g.setTimeout(function () { delete glowTimers[id]; setFlash(id, false); }, GLOW_MS);
  }

  function showLink(model) {
    var url = model && model.server && model.server.url;
    var ok = state.transport === 'file' && typeof url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url);
    linkEl.hidden = !ok;
    linkEl.setAttribute('style', 'display:' + (ok ? 'block' : 'none') + ';text-align:center;font:13px sans-serif;padding:4px');
    if (ok) { linkEl.href = url; linkEl.textContent = '실시간 보기 열기 → ' + url; }
  }

  function show(model) {
    state.model = model; state.seq = seqOf(model); state.appliedAt = state.now();
    runHooks(hooks.beforeApply, model);
    render();
    glow(model);
    showLink(model);
    runHooks(hooks.afterApply, model);
  }

  function receive(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return;
    var gen = generationOf(d.gen);
    rememberGeneration(gen);
    var healthy = gen !== null && gen >= generationFloor;
    if (gen !== null && gen < generationFloor) {
      closedNotice = true;
      updateConnectionStatus();
      return; // an older owner must not replace the visible board or trigger a reload
    }
    if (healthy) {
      closedNotice = false;
      updateConnectionStatus();
      var serverGen = generationOf(d.server && d.server.generation);
      var newer = serverGen !== null ? Math.max(gen, serverGen) : gen;
      if (ownGeneration !== null && newer > ownGeneration) {
        pendingGeneration = pendingGeneration === null ? newer : Math.max(pendingGeneration, newer);
        reloadGeneration();
      }
    }
    var s = seqOf(d);
    if (!state.real) {
      state.real = true;
      show(d);
      return;
    }
    if (s > state.seq && (!state.pending || s > seqOf(state.pending))) {
      state.pending = d;
      consider();
    }
  }

  // Normal streaming applies at most once per APPLY_MIN_MS; busy release takes precedence.
  function consider() {
    reloadGeneration();
    if (!state.pending) { badge.hidden = true; return; }
    if (busy()) { heldForBusy = true; badge.hidden = false; return; }
    if (heldForBusy) { scheduleRelease(); return; }
    var wait = APPLY_MIN_MS - (state.now() - state.appliedAt);
    if (wait > 0) {
      if (!applyTimer) applyTimer = g.setTimeout(function () { applyTimer = null; consider(); }, wait);
      return;
    }
    apply();
  }

  function apply() {
    reloadGeneration();
    if (!state.pending) { badge.hidden = true; return; }
    if (applyTimer) { g.clearTimeout(applyTimer); applyTimer = null; }
    if (releaseTimer) { g.clearTimeout(releaseTimer); releaseTimer = null; }
    heldForBusy = false;
    // keep the tab the owner is looking at, even one the view picked by default
    state.ui.tab = shownTab() || state.ui.tab;
    var m = state.pending;
    state.pending = null;
    badge.hidden = true;
    show(m);
  }

  function inject() {
    var sc = doc.createElement('script');
    sc.src = DATA_URL + '?v=' + (++state.n);
    sc.onload = function () { sc.remove(); };
    sc.onerror = function () {
      sc.remove();
      if (!state.model) { state.model = EMPTY; render(); }
    };
    doc.head.appendChild(sc);
  }

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.hidden = !text;
    statusEl.textContent = text || '';
  }

  function updateConnectionStatus() {
    if (!statusEl) return;
    statusEl.setAttribute('data-state', closedNotice ? 'closed' : '');
    if (closedNotice) setStatus('실시간 상황판이 닫힘 · 최신 세대 대화를 하나 재시작하면 다시 열림');
    else setStatus('');
  }

  function reloadGeneration() {
    if (pendingGeneration === null || busy()) return;
    var gen = pendingGeneration;
    pendingGeneration = null;
    if (gen < generationFloor || closedNotice) return;
    var key = 'omo-reloaded-for-' + gen;
    try {
      if (g.sessionStorage.getItem(key) !== null) return;
      if (!rememberForReload()) return;
      g.sessionStorage.setItem(key, '1');
      g.location.reload();
    } catch (e) { warn('generation reload flag', e); }
  }

  function connectLive() {
    initAnswers(); // the board server's page: its write token, and what a 403 reload carried over
    var loc = g.location;
    var paused = false;
    g.fetch('/data.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('data.json HTTP ' + r.status);
      return r.json();
    }).then(guard('data.json', receive)).catch(function (e) { fail('data.json', e); });
    var es = new g.EventSource('/events');
    state.es = es;
    es.addEventListener('data', guard('sse data', function (ev) {
      var model = JSON.parse(ev.data);
      reconnectErrors = 0;
      paused = false;
      receive(model);
      updateConnectionStatus();
    }));
    es.addEventListener('closing', guard('sse closing', function (ev) {
      var info = JSON.parse(ev.data);
      rememberGeneration(info.installed);
      if (info.reason === 'stale') closedNotice = true;
      updateConnectionStatus();
    }));
    es.addEventListener('paused', guard('sse paused', function () {
      paused = true;
      if (closedNotice) updateConnectionStatus();
      else setStatus('브리핑 꺼짐 - /brief on 으로 켜기');
    }));
    es.onopen = guard('sse open', function () { paused = false; updateConnectionStatus(); });
    es.onerror = guard('sse error', function () {
      if (++reconnectErrors >= 5) closedNotice = true;
      if (closedNotice) updateConnectionStatus();
      else if (!paused) setStatus('실시간 연결 끊김 - 다시 연결 중');
    });
    return loc;
  }

  function copy(text, btn) {
    function done(ok) {
      var old = btn.textContent;
      btn.textContent = ok ? '✔ 복사됨' : '✖ 복사 실패';
      g.setTimeout(function () { btn.textContent = old; }, 1200);
    }
    function legacy() {
      var ta = doc.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      doc.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      done(ok);
    }
    if (g.navigator && g.navigator.clipboard && g.navigator.clipboard.writeText) {
      g.navigator.clipboard.writeText(text).then(function () { done(true); }, legacy);
    } else legacy();
  }

  function shownTab() {
    var app = root.querySelector('.app');
    return app ? app.getAttribute('data-tab') : null;
  }

  function goTo(id, tab) {
    if (tab && tab !== shownTab()) { releaseHeld(); state.ui.tab = tab; render(); }
    var el = doc.getElementById(id);
    if (!el) return;
    if (state.ui.tocOpen) { state.ui.tocOpen = false; render(); el = doc.getElementById(id); }
    el.scrollIntoView({ block: 'start' });
    el.classList.add('flash');
    g.setTimeout(function () { el.classList.remove('flash'); }, 900);
    mark(id);
  }

  // The write token of the page the board server serves: the meta tag only that page carries. The name is split on
  // purpose - page.js is inlined into the file page too, and that page must not carry the literal that marks a
  // server-mode page (see test/board-hooks.test.mjs).
  function boardToken() {
    var m = typeof doc.querySelector === 'function' ? doc.querySelector('meta[name="omo-board' + '-token"]') : null;
    var v = m && typeof m.getAttribute === 'function' ? m.getAttribute('content') : null;
    return typeof v === 'string' ? v : '';
  }

  // POST /focus {sessionId}; the result text is kept in state.ui.focus so re-renders keep it.
  function focusTab(sessionId) {
    function set(ok) { state.ui.focus[sessionId] = { ok: ok }; render(); }
    g.fetch('/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Board-Token': boardToken() },
      body: JSON.stringify({ sessionId: sessionId })
    }).then(function (r) { set(!!r.ok); }, function () { set(false); });
  }

  function onClick(ev) {
    var t = ev.target.closest('[data-copy],[data-act],[data-goto]');
    if (!t || !root.contains(t)) return;
    if (t.hasAttribute('data-copy')) { copy(t.getAttribute('data-copy'), t); return; }
    if (t.hasAttribute('data-goto')) { ev.preventDefault(); goTo(t.getAttribute('data-goto'), t.getAttribute('data-tab')); return; }
    var act = t.getAttribute('data-act');
    if (act && act.indexOf('ans-') === 0) { answerClick(act, t); return; }
    if (act === 'tab') {
      var tab = t.getAttribute('data-tab');
      if (tab === 'done') state.ui.doneOpen = true;
      var changed = tab !== shownTab();
      if (changed) releaseHeld();
      state.ui.tab = tab;
      render();
      if (changed) g.scrollTo(0, 0);
    } else if (act === 'exp') {
      var k = t.getAttribute('data-key');
      state.ui.expanded[k] = !state.ui.expanded[k];
      render();
    } else if (act === 'focus') {
      focusTab(t.getAttribute('data-session'));
    } else if (act === 'toc') {
      state.ui.tocOpen = !state.ui.tocOpen; render();
    } else if (act === 'legend') {
      state.ui.legendOpen = !state.ui.legendOpen; render();
    }
  }

  function mark(id) {
    var links = root.querySelectorAll('.toclink');
    for (var i = 0; i < links.length; i++) {
      var on = links[i].getAttribute('data-goto') === id;
      links[i].classList.toggle('spy', on);
      if (on) links[i].setAttribute('aria-current', 'true'); else links[i].removeAttribute('aria-current');
    }
  }

  // Always derived from the scroll position (runs on every scroll/resize/render), so a TOC
  // click never leaves a sticky highlight: the current section is the last card whose top
  // has passed the line 45% down the viewport; always the first card at the top of the tab
  // and the last at the page end (where it can never climb that high).
  function spy() {
    if (!root) return;
    var cards = root.querySelectorAll('article.card');
    if (!cards.length) return;
    var atEnd = (g.scrollY || 0) > 0 && g.innerHeight + g.scrollY >= doc.documentElement.scrollHeight - 4;
    var cur = atEnd ? cards[cards.length - 1] : cards[0];
    if (!atEnd && (g.scrollY || 0) > 0) {
      var line = g.innerHeight * 0.45;
      for (var i = 1; i < cards.length; i++) {
        if (cards[i].getBoundingClientRect().top <= line) cur = cards[i];
      }
    }
    mark(cur.id);
  }

  // ---- block modules (workers-view.js, alarm.js): FLIP motion around every apply, 1 s elapsed ticker, waiting alarm ----
  function wireBlocks() {
    var W = g.BriefWorkersView, A = g.BriefAlarm;
    if (W) {
      var before = null;
      hooks.beforeApply.push(function () { before = W.measure(root); });
      hooks.afterApply.push(function () { var b = before; before = null; if (b) W.play(root, b); });
      g.setInterval(guard('tick', function () { W.tick(root, Date.now()); }), 1000);
    }
    if (A) {
      hooks.afterApply.push(function (model) {
        // origin and storage come from the page itself (location / localStorage); the first call only marks what is already waiting
        A.update(model && Array.isArray(model.waiting) ? model.waiting : [], { liveUrl: model && model.server && model.server.url });
      });
    }
  }

  // ---- board answers (server page only) ---------------------------------------------------------------------------
  // The page the board server serves carries its per-process write token in a meta tag (the file page, data.js and the SSE
  // model never do). With it the decision cards get A/B/C buttons and a reply box (view.js, ui.live) and every send is one
  // same-origin POST /answer {id, sessionId, option|text} with the token header. Per-decision state, kept across the full
  // re-render: state.ui.answers[id] = {open, draft, confirm: {option}|{text}|null, phase: ''|'sending'|'sent'|'closed', error,
  // tab}; tab = the tab that showed the conversation's card at 보내기 (view.js keeps the card there until the owner changes tabs).
  // A 200 only means the answer is stored: 전달됨 comes from the next view model (render.mjs delivery text), never from here.
  var REPLY_MAX = 500; // = view.js maxlength; <= 500 UTF-16 units is always within the server's 500 code points
  var POST_TIMEOUT_MS = 15000; // over the server's own bounds (2 s body read, 10 s write: it answers 408/504 first)
  var RELOAD_KEY = 'omo-briefing.answer403'; // sessionStorage: one automatic reload per 403, plus the reply drafts it carries
  var ANSWER_TEXT = {
    closed: '이미 답했거나 닫힌 결정',
    noText: '이 대화는 답글을 못 받아요 - 선택지로 답하세요',
    reopen: '상황판을 다시 열어 주세요',
    paused: '상황판이 꺼져 있어요',
    network: '보내지 못했어요 - 다시 눌러 주세요',
    busy: '다른 답을 처리하는 중이에요 - 잠시 뒤 다시 눌러 주세요',
    slow: '응답이 늦어요 - 잠시 뒤 카드를 확인하고 필요하면 다시 눌러 주세요',
    gone: '이 결정을 찾을 수 없어요 - 페이지를 새로 고쳐 주세요',
    empty: '답글을 먼저 써 주세요',
    failed: '보내지 못했어요'
  };
  var answerToken = '';
  var reloadedFor403 = false;
  var postBusy = null; // the board POST in flight (with any queued behind it), null when idle

  function warn(where, e) {
    if (g.console && g.console.error) g.console.error('[omo-briefing] ' + where, e);
  }

  function initAnswers() {
    answerToken = boardToken();
    state.ui.live = answerToken !== '';
    if (state.ui.live) restoreAfterReload();
  }

  function validKey(k) { return typeof k === 'string' && /^[1-9]\d{0,14}$/.test(k); }

  function answerState(key) {
    var all = state.ui.answers || (state.ui.answers = Object.create(null));
    if (!Object.prototype.hasOwnProperty.call(all, key)) all[key] = { open: false, draft: '', confirm: null, phase: '', error: '', tab: '' };
    return all[key];
  }

  function findDecision(id) {
    var list = state.model && Array.isArray(state.model.sessions) ? state.model.sessions : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i], ds = s && Array.isArray(s.decisions) ? s.decisions : [];
      for (var j = 0; j < ds.length; j++) {
        if (ds[j] && ds[j].id === id) return { d: ds[j], sessionId: typeof ds[j].sessionId === 'string' && ds[j].sessionId ? ds[j].sessionId : String(s.id), card: String(s.id) };
      }
    }
    return null;
  }

  // the conversation's card is on the screen, i.e. in the tab being looked at
  function cardShown(id) {
    var cards = root.querySelectorAll('[data-card]');
    for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute('data-card') === id) return true;
    return false;
  }

  // The owner changes tabs: cards held where their answers were sent go to the tabs their models give them (view.js).
  function releaseHeld() {
    var all = state.ui.answers;
    for (var k in all) if (Object.prototype.hasOwnProperty.call(all, k) && all[k]) all[k].tab = '';
  }

  function answerClick(act, t) {
    var key = t.getAttribute('data-id');
    if (!answerToken || !validKey(key)) return;
    var a = answerState(key);
    if (a.phase === 'sending' || a.phase === 'sent' || a.phase === 'closed') return; // one send per decision, never a second POST
    if (act === 'ans-pick') {
      var opt = t.getAttribute('data-opt');
      if (opt !== 'A' && opt !== 'B' && opt !== 'C') return;
      a.confirm = { option: opt };
      a.error = '';
    } else if (act === 'ans-reply') {
      a.open = !a.open;
      a.confirm = null;
      a.error = '';
    } else if (act === 'ans-text') {
      var text = a.draft.trim();
      if (text) { a.confirm = { text: text }; a.error = ''; } else a.error = ANSWER_TEXT.empty;
    } else if (act === 'ans-cancel') {
      a.confirm = null;
    } else if (act === 'ans-send') {
      sendAnswer(key, a);
      return;
    } else return;
    render();
    if (act === 'ans-reply' && a.open) focusDraft(key, t.getAttribute('data-where'));
  }

  // the reply box that was just opened, in the same place (decision card or plan row) as the button
  function focusDraft(key, where) {
    var list = root.querySelectorAll('textarea[data-draft="' + key + '"]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-where') === where && typeof list[i].focus === 'function') { list[i].focus(); return; }
    }
  }

  // typing never re-renders (that would drop the focus): the draft goes to the state, the counter is set in place
  function onInput(ev) {
    var t = ev && ev.target;
    var key = t && typeof t.getAttribute === 'function' ? t.getAttribute('data-draft') : null;
    if (!validKey(key)) return;
    var a = answerState(key);
    a.draft = String(t.value == null ? '' : t.value).slice(0, REPLY_MAX);
    var box = typeof t.closest === 'function' ? t.closest('.ans-reply') : null;
    var count = box ? box.querySelector('.ans-count') : null;
    if (count) count.textContent = a.draft.length + '/' + REPLY_MAX;
  }

  function sendAnswer(key, a) {
    var c = a.confirm;
    if (!c) return;
    var found = findDecision(Number(key));
    if (!found || found.d.answered === true || found.d.closed === true) {
      // the current model already says it cannot be answered: no POST
      if (found) a.phase = 'closed';
      a.error = found ? ANSWER_TEXT.closed : ANSWER_TEXT.gone;
      a.confirm = null;
      render();
      return;
    }
    var body = { id: Number(key), sessionId: found.sessionId };
    if (typeof c.option === 'string') body.option = c.option; else body.text = c.text;
    a.phase = 'sending';
    a.error = '';
    a.tab = cardShown(found.card) ? shownTab() || '' : ''; // that card stays on this screen while its answer is on the way
    render();
    postJson('/answer', body).then(guard('answer reply', function (res) { answerReply(key, res); }));
  }

  // One board POST at a time from this page (the server runs one write at a time and answers 429 to a second one): sent at
  // once when idle, else after the one in flight. Resolves {status, json}; status 0 = no answer (network error, or none
  // within POST_TIMEOUT_MS). Never rejects.
  function postJson(path, body) {
    var next = postBusy ? postBusy.then(function () { return postOnce(path, body); }) : postOnce(path, body);
    postBusy = next;
    next.then(function () { if (postBusy === next) postBusy = null; });
    return next;
  }

  function postOnce(path, body) {
    var ctl = typeof g.AbortController === 'function' ? new g.AbortController() : null;
    var timer = ctl ? g.setTimeout(function () { ctl.abort(); }, POST_TIMEOUT_MS) : null;
    var opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Token': answerToken }, body: JSON.stringify(body) };
    if (ctl) opts.signal = ctl.signal;
    var sent;
    try { sent = g.fetch(path, opts); } catch (e) { sent = Promise.reject(e); }
    return sent.then(function (r) {
      return r.json().then(function (j) { return { status: r.status, json: j }; }, function () { return { status: r.status, json: null }; });
    }).then(null, function (e) {
      warn('POST ' + path, e);
      return { status: 0, json: null };
    }).then(function (res) {
      if (timer) g.clearTimeout(timer);
      return res;
    });
  }

  function answerReply(key, res) {
    var a = answerState(key);
    var code = res.json && typeof res.json.code === 'string' ? res.json.code : '';
    if (res.status === 200 && res.json && res.json.ok === true) {
      reloadedFor403 = false;
      a.phase = 'sent';
      a.confirm = null;
      a.error = '';
      a.draft = '';
      a.open = false;
    } else if (res.status === 403 && !reloadedFor403 && rememberForReload()) {
      reloadedFor403 = true;
      g.location.reload(); // the board moved to another process (new token): the reloaded page carries the new one
      return;
    } else {
      var f = res.status === 403 ? { text: ANSWER_TEXT.reopen } : answerFailure(res.status, code);
      a.phase = f.phase || '';
      a.error = f.text;
      if (!f.retry) a.confirm = null;
    }
    render();
  }

  // HTTP refusal -> card text. phase 'closed' = this decision can no longer be answered here (no buttons, no second POST);
  // retry = the confirm row stays, so one more press sends again.
  function answerFailure(status, code) {
    if (status === 409 && (code === 'ANSWERED' || code === 'CLOSED')) return { phase: 'closed', text: ANSWER_TEXT.closed };
    if (status === 409 && code === 'NO_TEXT_SUPPORT') return { text: ANSWER_TEXT.noText };
    if (status === 404 || (status === 409 && code === 'SESSION_MISMATCH')) return { phase: 'closed', text: ANSWER_TEXT.gone };
    if (status === 503) return { text: ANSWER_TEXT.paused, retry: true };
    if (status === 429) return { text: ANSWER_TEXT.busy, retry: true };
    if (status === 408 || status === 504) return { text: ANSWER_TEXT.slow, retry: true };
    if (status === 0) return { text: ANSWER_TEXT.network, retry: true };
    return { text: ANSWER_TEXT.failed + ' (' + status + (code ? ' ' + code : '') + ') - 다시 눌러 주세요', retry: true };
  }

  // The reload flag and every unsent reply draft ride over the reload in sessionStorage. Without storage there is no
  // automatic reload at all, since it could not be limited to one.
  function rememberForReload() {
    var drafts = {};
    var all = state.ui.answers || {};
    for (var k in all) if (Object.prototype.hasOwnProperty.call(all, k) && all[k] && all[k].draft) drafts[k] = all[k].draft;
    try {
      g.sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ drafts: drafts }));
      return true;
    } catch (e) {
      warn('answer reload flag', e);
      return false;
    }
  }

  function restoreAfterReload() {
    var raw;
    try {
      var store = g.sessionStorage;
      if (!store) return; // nothing can have been saved
      raw = store.getItem(RELOAD_KEY);
      if (raw !== null) store.removeItem(RELOAD_KEY);
    } catch (e) {
      warn('answer reload flag', e);
      return;
    }
    if (typeof raw !== 'string') return;
    reloadedFor403 = true;
    var saved = null;
    try { saved = JSON.parse(raw); } catch (e) { warn('answer reload drafts', e); }
    var drafts = saved && typeof saved === 'object' && saved.drafts && typeof saved.drafts === 'object' ? saved.drafts : {};
    for (var k in drafts) {
      if (Object.prototype.hasOwnProperty.call(drafts, k) && validKey(k) && typeof drafts[k] === 'string' && drafts[k]) {
        var a = answerState(k);
        a.draft = drafts[k].slice(0, REPLY_MAX);
        a.open = true;
      }
    }
  }

  g.__briefData = receive;
  g.BriefPage = {
    receive: receive, apply: apply, render: render, state: state, hooks: hooks,
    busy: busy, transport: function () { return state.transport; },
    captureAnchor: captureAnchor, restoreAnchor: restoreAnchor
  };
  g.BriefPage.answerText = ANSWER_TEXT;

  function start() {
    ensureRoot();
    wireBlocks();
    var loc = g.location;
    var http = !!(loc && /^https?:$/.test(loc.protocol) && g.EventSource && g.fetch);
    state.transport = http ? 'http' : 'file';
    state.ui.live = http && !!boardToken();
    if (!state.model) render();
    if (http) { connectLive(); return; }
    inject();
    g.setInterval(function () { if (doc.visibilityState === 'visible') inject(); }, POLL_MS);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', guard('start', start));
  else guard('start', start)();
})(typeof globalThis !== 'undefined' ? globalThis : this);
