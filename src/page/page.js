/* omo-briefing page controller, classic script (file:// safe, no modules).
 * Load order in index.html: view.js, page.js (data.js is pulled in by this file on file://).
 * Transport:
 *  - http(s) origin (live board server): one fetch of /data.json + EventSource('/events').
 *    No polling. A dropped stream shows a banner; the browser reconnects by itself.
 *  - file:// origin: re-insert <script src="data.js?v=n"> every 2 s while the page is visible.
 * A larger seq is applied automatically (normally at most once per 500 ms, latest wins). While the
 * owner is selecting text, typing, or holding the pointer down inside the board the update is held
 * back and a badge says so; release takes priority over that throttle and applies within 300 ms.
 * Applying keeps the tab, the opened cards and the card that was at the top of the screen. */
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
    ui: { tab: null, expanded: Object.create(null), tocOpen: false, legendOpen: false, doneOpen: false }
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
    if (!state.pending || releaseTimer) return;
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

  function connectLive() {
    var loc = g.location;
    var paused = false;
    g.fetch('/data.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('data.json HTTP ' + r.status);
      return r.json();
    }).then(guard('data.json', receive)).catch(function (e) { fail('data.json', e); });
    var es = new g.EventSource('/events');
    state.es = es;
    es.addEventListener('data', guard('sse data', function (ev) { paused = false; setStatus(''); receive(JSON.parse(ev.data)); }));
    es.addEventListener('paused', guard('sse paused', function () { paused = true; setStatus('브리핑 꺼짐 - /brief on 으로 켜기'); }));
    es.onopen = guard('sse open', function () { paused = false; setStatus(''); });
    es.onerror = guard('sse error', function () { if (!paused) setStatus('실시간 연결 끊김 - 다시 연결 중'); });
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
    if (tab && tab !== shownTab()) { state.ui.tab = tab; render(); }
    var el = doc.getElementById(id);
    if (!el) return;
    if (state.ui.tocOpen) { state.ui.tocOpen = false; render(); el = doc.getElementById(id); }
    el.scrollIntoView({ block: 'start' });
    el.classList.add('flash');
    g.setTimeout(function () { el.classList.remove('flash'); }, 900);
    mark(id);
  }

  function onClick(ev) {
    var t = ev.target.closest('[data-copy],[data-act],[data-goto]');
    if (!t || !root.contains(t)) return;
    if (t.hasAttribute('data-copy')) { copy(t.getAttribute('data-copy'), t); return; }
    if (t.hasAttribute('data-goto')) { ev.preventDefault(); goTo(t.getAttribute('data-goto'), t.getAttribute('data-tab')); return; }
    var act = t.getAttribute('data-act');
    if (act === 'tab') {
      var tab = t.getAttribute('data-tab');
      if (tab === 'done') state.ui.doneOpen = true;
      var changed = tab !== shownTab();
      state.ui.tab = tab;
      render();
      if (changed) g.scrollTo(0, 0);
    } else if (act === 'exp') {
      var k = t.getAttribute('data-key');
      state.ui.expanded[k] = !state.ui.expanded[k];
      render();
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

  g.__briefData = receive;
  g.BriefPage = {
    receive: receive, apply: apply, render: render, state: state, hooks: hooks,
    busy: busy, transport: function () { return state.transport; },
    captureAnchor: captureAnchor, restoreAnchor: restoreAnchor
  };

  function start() {
    ensureRoot();
    wireBlocks();
    var loc = g.location;
    var http = !!(loc && /^https?:$/.test(loc.protocol) && g.EventSource && g.fetch);
    state.transport = http ? 'http' : 'file';
    if (!state.model) render();
    if (http) { connectLive(); return; }
    inject();
    g.setInterval(function () { if (doc.visibilityState === 'visible') inject(); }, POLL_MS);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', guard('start', start));
  else guard('start', start)();
})(typeof globalThis !== 'undefined' ? globalThis : this);
