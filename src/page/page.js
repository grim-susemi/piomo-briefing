/* omo-briefing page controller, classic script (file:// safe, no modules).
 * Load order in index.html: view.js, page.js (data.js is pulled in by this file).
 * Refresh (docs/refresh-decision.md, primary): while the page is visible, re-insert
 * <script src="data.js?v=n"> every 5 s. data.js calls window.__briefData({seq, ...}).
 * A larger seq only raises the '새 내용 있음' badge; clicking it redraws while keeping
 * the tab, scroll position and opened cards. */
(function (g) {
  'use strict';
  var doc = g.document;
  if (!doc) return;
  var DATA_URL = g.BRIEF_DATA_URL || 'data.js';
  var POLL_MS = 5000;
  var EMPTY = { seq: -1, generatedAt: null, sessions: [] };

  var state = {
    model: null,
    real: false,
    seq: -1,
    pending: null,
    n: 0,
    ui: { tab: null, expanded: Object.create(null), tocOpen: false, legendOpen: false, doneOpen: false }
  };
  var root, badge;

  function esc(v) { return g.BriefView && g.BriefView.escapeHtml ? g.BriefView.escapeHtml(v) : String(v); }
  function seqOf(d) { return d && typeof d.seq === 'number' && isFinite(d.seq) ? d.seq : 0; }

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
      badge.textContent = '● 새 내용 있음 - 눌러서 반영';
      doc.body.appendChild(badge);
    }
    badge.addEventListener('click', apply);
    root.addEventListener('click', onClick);
    g.addEventListener('scroll', spy, { passive: true });
    g.addEventListener('resize', spy);
  }

  function render() {
    var y = g.scrollY || 0;
    try {
      root.innerHTML = g.BriefView.renderApp(state.model || EMPTY, state.ui);
    } catch (e) {
      root.innerHTML = '<p class="fatal">화면을 그리지 못했습니다: ' + esc(e && e.message) + '</p>';
    }
    // ui.tab stays null until the owner picks a tab, so the view keeps choosing a
    // sensible default (e.g. after the first real data replaces the empty screen).
    g.scrollTo(0, y);
    spy();
  }

  function receive(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return;
    var s = seqOf(d);
    if (!state.real) {
      state.model = d; state.real = true; state.seq = s;
      render();
      return;
    }
    if (s > state.seq && (!state.pending || s > seqOf(state.pending))) {
      state.pending = d;
      badge.hidden = false;
    }
  }

  function apply() {
    if (!state.pending) { badge.hidden = true; return; }
    // keep the tab the owner is looking at, even one the view picked by default
    state.ui.tab = shownTab() || state.ui.tab;
    state.model = state.pending; state.seq = seqOf(state.pending); state.pending = null;
    badge.hidden = true;
    render();
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

  g.__briefData = receive;
  g.BriefPage = { receive: receive, apply: apply, render: render, state: state };

  function start() {
    ensureRoot();
    if (!state.model) render();
    inject();
    g.setInterval(function () { if (doc.visibilityState === 'visible') inject(); }, POLL_MS);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
