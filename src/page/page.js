/* omo-briefing page controller, classic script (file:// safe, no modules).
 * Load order: view, plan-view, workers-view, convo-view, shell, alarm, annotate, cards-view, page.
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
    ui: { expanded: Object.create(null), live: false, focus: Object.create(null) }
  };
  var hooks = { beforeApply: [], afterApply: [] };
  var root, badge, statusEl, linkEl, errEl, applyTimer = null, releaseTimer = null, sessionJson = {}, glowTimers = {};
  var heldForBusy = false;
  var shell, main, sideList, rail, tabs, trimEl;
  var regionHtml = Object.create(null), scrollMemory = Object.create(null), renderedKey = null;
  var cardsView = null, cardsEpoch = 0, cardsRead = 0, cardsOwnerAction = null;
  // A constant region keeps TASK14's own DOM, filters and expanded rows outside string-rendered agent updates.
  var CARDS_REGION = '<section aria-label="메멘토"><p id="memento-load" role="status"></p><div id="memento-cards"></div></section>';

  // Fail closed: without view.js, model text still cannot become markup (same mapping as view.js escapeHtml).
  function esc(v) {
    if (g.BriefView && g.BriefView.escapeHtml) return g.BriefView.escapeHtml(v);
    return String(v).replace(/[&<>"'`]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c];
    });
  }
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
    var prefs = g.BriefShell.reduce(null, { type: 'load', json: g.BriefShell.restore() });
    for (var key in state.ui) prefs[key] = state.ui[key];
    state.ui = prefs;
    root.innerHTML = g.BriefShell.skeleton(state.ui);
    shell = root.querySelector('[data-shell]');
    main = doc.getElementById('main');
    rail = doc.getElementById('rail');
    tabs = doc.getElementById('tabs');
    sideList = shell.querySelector('[data-sh-part="list"]');
    badge = doc.getElementById('new-badge');
    if (!badge) {
      badge = doc.createElement('button');
      badge.type = 'button';
      badge.id = 'new-badge';
      badge.className = 'new-badge';
      badge.hidden = true;
      badge.setAttribute('aria-label', '● 새 내용 - 선택·입력이 끝나면 반영');
      badge.innerHTML = (g.BriefIcons ? g.BriefIcons.icon('refresh-cw', 'ic-xs') : '') + ' 새 내용 - 선택·입력이 끝나면 반영';
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
    // These nodes are persistent, above the tabs, never part of a refreshed region.
    var wrap = shell.querySelector('.sh-wrap');
    wrap.insertBefore(statusEl, tabs);
    wrap.insertBefore(linkEl, tabs);
    trimEl = doc.createElement('p');
    trimEl.className = 'trimmed-note';
    trimEl.hidden = true;
    wrap.insertBefore(trimEl, tabs);
    badge.addEventListener('click', guard('badge', apply));
    root.addEventListener('click', guard('click', onClick));
    root.addEventListener('input', guard('input', onInput));
    root.addEventListener('change', guard('checklist', onCheck));
    // TASK14 calls setStatus synchronously from click/change handlers, then again for a BUSY retry.
    // eventPhase becomes NONE after dispatch, including when capture consumes the event.
    ['click', 'change'].forEach(function (type) {
      doc.addEventListener(type, function (ev) {
        cardsOwnerAction = cardsView && main.contains(ev.target) ? ev : null;
      }, true);
    });
    root.addEventListener('toggle', guard('details toggle', function (ev) {
      var t = ev.target, k = t && t.getAttribute && t.getAttribute('data-open-key');
      if (k) state.ui.expanded[k] = t.open === true;
    }), true);
    g.BriefShell.bind(shell, { dispatch: dispatch, now: function () { return state.now(); } });
    g.BriefAnnotate.mount(main, { context: annotationContext, send: sendAnnotation, idle: scheduleRelease });
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
    if (g.BriefAnnotate.busy()) return true;
    if (sel && !sel.isCollapsed && String(sel).length > 0 && (!sel.anchorNode || main.contains(sel.anchorNode))) return true;
    var a = doc.activeElement;
    if (a && main.contains(a)) {
      var tag = String(a.tagName || '').toLowerCase();
      // a checklist box is no typing
      if ((tag === 'input' && a.getAttribute('type') !== 'checkbox') || tag === 'textarea' || a.isContentEditable) return true;
    }
    return false;
  }

  // checklist ticks (blocks.js): this browser only, never sent
  var tickFails = 0;
  function tick(fn) { try { return fn(g.localStorage); } catch (e) { if (!tickFails++) warn('checklist tick', e); } }
  function isChecked(key) { return tick(function (s) { return s.getItem(key) === '1'; }) === true; }
  function onCheck(ev) {
    var t = ev.target, key = t.getAttribute('data-check-key'), list = t.closest('.rbk-chk'), n = 0;
    if (!key || !list) return;
    tick(function (s) { if (t.checked) s.setItem(key, '1'); else s.removeItem(key); });
    var boxes = list.querySelectorAll('input');
    for (var i = 0; i < boxes.length; i++) n += boxes[i].checked ? 1 : 0;
    list.parentNode.querySelector('.rbk-m').textContent = g.BriefBlocks.checkCount(n, boxes.length);
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

  // ---- region scroll: first stable block visible inside #main, never DOM position --------------
  function captureAnchor() {
    if (!main) return null;
    var top = main.getBoundingClientRect().top;
    var cards = main.querySelectorAll('[data-block]');
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].getBoundingClientRect();
      if (r.bottom === undefined || r.bottom > top) {
        return { id: cards[i].getAttribute('data-block'), top: r.top - top };
      }
    }
    return null;
  }
  function restoreAnchor(a, y) {
    main.scrollTop = y;
    if (!a) return;
    var cards = main.querySelectorAll('[data-block]');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-block') === a.id) {
        main.scrollTop += cards[i].getBoundingClientRect().top - main.getBoundingClientRect().top - a.top;
        return;
      }
    }
  }

  function currentSession() {
    var sessions = state.model && Array.isArray(state.model.sessions) ? state.model.sessions : [];
    for (var i = 0; i < sessions.length; i++) if (sessions[i] && sessions[i].id === state.ui.active) return sessions[i];
    return null;
  }
  function mainKey() { return state.ui.view === 'memento' ? 'memento' : state.ui.active ? state.ui.active + '/' + (state.ui.sub[state.ui.active] || 'ov') : 'overview'; }
  function saveScroll() {
    if (renderedKey !== null) scrollMemory[renderedKey] = { y: main.scrollTop, anchor: captureAnchor() };
  }
  function seedPlan() {
    var s = currentSession();
    if (!s || state.ui.sub[s.id] !== 'plan' || !s.plan) return;
    var id = s.plan.planId;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    ['plan:', 'plan-tasks:'].forEach(function (p) {
      var k = p + id;
      if (!Object.prototype.hasOwnProperty.call(state.ui.expanded, k)) state.ui.expanded[k] = true;
    });
  }
  // The narrow sidebar overlay (visual-qa I1/I2): shell.js keeps the column under it inert while it is open. A focus the
  // overlay covered moves into it; once it shuts, a focus it hid goes back to the control that opened it (the rail button,
  // », or the control Ctrl+\ came from; found again by its focusKey if a render replaced it), else to ».
  var overlayOpener = null;
  function overlayOpen() { return !!(g.matchMedia && g.matchMedia('(max-width: 899px)').matches) && state.ui.peek === true; }
  function overlayFocus(open, before) {
    var side = shell.querySelector('.sh-side'), wrap = shell.querySelector('.sh-wrap'), a = doc.activeElement;
    var away = !a || a === doc.body;
    if (open) {
      var from = !away && !side.contains(a) && !wrap.contains(a) ? a
        : before && before !== doc.body && shell.contains(before) && !side.contains(before) ? before : null;
      overlayOpener = from ? { el: from, key: focusKey(from) } : null;
      var into = side.querySelector('.sh-head [data-sh="toggleSide"]');
      if (into && (away || wrap.contains(a))) into.focus({ preventScroll: true });
      return;
    }
    var o = overlayOpener, back = null;
    overlayOpener = null;
    if (!away && !side.contains(a)) return;
    if (o && shell.contains(o.el)) back = o.el;
    else if (o) back = Array.prototype.filter.call(shell.querySelectorAll(CONTROLS), function (el) { return !side.contains(el) && focusKey(el) === o.key; })[0];
    if (!back || side.contains(back)) back = shell.querySelector('.sh-topen');
    if (back) back.focus({ preventScroll: true });
  }
  function dispatch(action) {
    var active = doc.activeElement;
    var sideToggle = active && active.getAttribute && active.getAttribute('data-sh') === 'toggleSide';
    var overlay = overlayOpen();
    if (state.ui.view === 'memento' && (action.type === 'open' || action.type === 'active')) {
      state.ui = g.BriefShell.reduce(state.ui, { type: 'view', key: 'conv' });
    }
    state.ui = g.BriefShell.reduce(state.ui, action);
    g.BriefShell.persist(undefined, state.ui);
    render();
    if (sideToggle && action.type === 'toggleSide') {
      var narrow = g.matchMedia && g.matchMedia('(max-width: 899px)').matches;
      var shown = narrow ? state.ui.peek : state.ui.sideOpen || state.ui.peek;
      var target = shell.querySelector(shown ? '.sh-head [data-sh="toggleSide"]' : '.sh-topen');
      if (target) target.focus({ preventScroll: true });
    }
    if (overlayOpen() !== overlay) overlayFocus(!overlay, active);
  }
  function open(sid, sub) { dispatch({ type: 'open', sid: sid, sub: sub, now: state.now() }); }
  // Match control identity, including the radio value and containing card/block, not just the first field in a group.
  // Values of editable text/number/select controls are state, not identity. Selection survives replacing a text node.
  var CONTROLS = 'button,input,textarea,select,summary,a[href],[tabindex]';
  function focusKey(el) {
    var names = ['id', 'name', 'type', 'data-sh', 'data-act', 'data-key', 'data-sid', 'data-sub', 'data-id', 'data-dec',
      'data-opt', 'data-where', 'data-draft', 'data-field', 'data-session', 'data-copy'];
    var key = [el.tagName];
    names.forEach(function (n) { key.push(el.getAttribute(n)); });
    if (el.getAttribute('type') === 'radio' || el.getAttribute('type') === 'checkbox') key.push(el.getAttribute('value'));
    var group = el.closest('[data-block],[data-card],[data-row],[data-tab],[data-decision]');
    if (group) ['data-block', 'data-card', 'data-row', 'data-tab', 'data-decision'].forEach(function (n) { key.push(group.getAttribute(n)); });
    return JSON.stringify(key);
  }
  function region(name, el, html) {
    if (regionHtml[name] === html) return false;
    var active = doc.activeElement, key = null, ordinal = 0, start, end, direction, group;
    if (active && el.contains(active) && active.matches(CONTROLS)) {
      key = focusKey(active);
      var before = el.querySelectorAll(CONTROLS);
      for (var i = 0; i < before.length && before[i] !== active; i++) if (focusKey(before[i]) === key) ordinal++;
      start = active.selectionStart; end = active.selectionEnd; direction = active.selectionDirection;
      group = active.closest('[data-block],[data-decision]');
      group = group && (group.getAttribute('data-block') || group.getAttribute('data-decision'));
    }
    el.innerHTML = html;
    regionHtml[name] = html;
    if (key !== null) {
      var after = el.querySelectorAll(CONTROLS), target = null;
      for (var j = 0; j < after.length; j++) if (focusKey(after[j]) === key && ordinal-- === 0) { target = after[j]; break; }
      // A report pick is replaced by its confirmation. Keep focus in that exact option, on Cancel, never Send.
      if (!target && group) {
        var groups = el.querySelectorAll('[data-block],[data-decision]');
        for (var k = 0; k < groups.length; k++) if ((groups[k].getAttribute('data-block') || groups[k].getAttribute('data-decision')) === group) {
          target = groups[k].querySelector('[data-act="ans-cancel"]'); break;
        }
      }
      if (target && !target.hasAttribute('disabled')) {
        target.focus({ preventScroll: true });
        if (typeof start === 'number' && typeof target.setSelectionRange === 'function') target.setSelectionRange(start, end, direction);
      }
    }
    return true;
  }
  function render() {
    saveScroll();
    var key = mainKey(), sideY = sideList.scrollTop;
    try {
      var model = state.model || EMPTY;
      (Array.isArray(model.sessions) ? model.sessions : []).forEach(function (session) {
        var key = annotationSent[session.id];
        if (!key || !Array.isArray(session.notes)) return;
        if (session.notes.some(function (note) { return note.key === key && typeof note.delivery === 'string' && note.delivery.indexOf('전달됨') === 0; })) {
          delete annotationSent[session.id];
          g.BriefAnnotate.status(session.id, null);
        }
      });
      seedPlan();
      // one clock per applied model: worker rows draw their pulse phase and elapsed time from the wall clock of the apply,
      // so a render that changes nothing in #main (a rail click, the sidebar) writes the same HTML and region() keeps it
      state.ui.wallNow = state.appliedAt;
      g.BriefShell.sync(shell, state.ui);
      region('rail', rail, g.BriefShell.rail(model, state.ui));
      region('side', sideList, g.BriefShell.side(model, state.ui));
      region('tabs', tabs, g.BriefShell.tabs(model, state.ui));
      var s = currentSession();
      var cards = state.ui.view === 'memento';
      if (!cards && cardsView) { cardsView.destroy(); cardsView = null; cardsEpoch++; }
      var html = cards ? CARDS_REGION : s ? g.BriefConvo.render(s, state.ui, { now: model.generatedAt, decision: findDecision, checked: isChecked })
        : state.ui.active ? '<p class="empty">(지금 안 보임)</p>' : g.BriefView.renderOverview(model, state.ui);
      if (region('main', main, html)) {
        g.BriefAnnotate.decorate();
        // a #main drawn later than the apply shows the current elapsed times at once, not the apply's (the 1 s ticker goes on)
        if (g.BriefWorkersView) g.BriefWorkersView.tick(main, state.now());
      }
      if (cards && !cardsView) {
        var cardBodies = Object.create(null);
        cardsView = g.BriefCards.mount(doc.getElementById('memento-cards'), {
          live: state.ui.live,
          setStatus: function (id, status, rev) {
            var body = cardBodies[id];
            if ((cardsOwnerAction && cardsOwnerAction.eventPhase > 0) || !body) {
              body = { action: 'setStatus', id: id, status: status, rev: rev, requestId: g.crypto.randomUUID() };
              cardBodies[id] = body;
            }
            return postJson('/memento', body).then(function (res) {
              refreshMemento();
              return { status: res.status, body: res.json };
            });
          },
          refresh: refreshMemento
        });
        refreshMemento();
      }
      var trimmed = model.trimmed;
      var n = trimmed && trimmed.cards;
      trimEl.hidden = !(Number.isInteger(n) && n > 0);
      trimEl.textContent = trimEl.hidden ? '' : '오래된 대화 ' + n + '개는 자세한 정보를 줄였어요';
    } catch (e) {
      fail('render', e);
      main.innerHTML = '<p class="fatal">화면을 그리지 못했습니다: ' + esc(e && e.message) + '</p>';
    }
    sideList.scrollTop = sideY;
    var memory = scrollMemory[key];
    if (memory) restoreAnchor(memory.anchor, memory.y); else main.scrollTop = 0;
    renderedKey = key;
  }

  function refreshMemento() {
    if (!cardsView || state.ui.view !== 'memento' || state.transport !== 'http') return Promise.resolve();
    var epoch = cardsEpoch, read = ++cardsRead, view = cardsView;
    var notice = doc.getElementById('memento-load');
    return g.fetch('/memento/state', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('memento unavailable');
      return res.json();
    }).then(function (value) {
      if (epoch !== cardsEpoch || read !== cardsRead || view !== cardsView) return;
      notice.textContent = '';
      view.update(value);
    }, function () {
      if (epoch !== cardsEpoch || read !== cardsRead || view !== cardsView) return;
      notice.textContent = '지금은 메멘토를 쓸 수 없어요';
    });
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
    if (state.ui.active === id) {
      var blocks = main.querySelectorAll('[data-block]');
      for (var b = 0; b < blocks.length; b++) blocks[b].classList[on ? 'add' : 'remove']('flash');
    }
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
    if (ok) {
      linkEl.href = url; linkEl.setAttribute('aria-label', '실시간 보기 열기 → ' + url);
      linkEl.innerHTML = '실시간 보기 열기 ' + (g.BriefIcons ? g.BriefIcons.icon('arrow-right', 'ic-xs') : '') + ' ' + esc(url);
    }
  }

  function show(model) {
    state.model = model; state.seq = seqOf(model); state.appliedAt = state.now();
    state.ui = g.BriefShell.reduce(state.ui, { type: 'known',
      ids: (Array.isArray(model.sessions) ? model.sessions : []).filter(function (s) { return s && typeof s.id === 'string'; }).map(function (s) { return s.id; }), now: state.now() });
    g.BriefShell.persist(undefined, state.ui);
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
      var use = btn.querySelector('use'), label = btn.querySelector('[data-copy-label]');
      // A text-only button (plan-view.js) has neither child: swap its whole text, keeping the original across repeats.
      var plain = !use && !label;
      if (plain && btn.copyText == null) btn.copyText = btn.textContent;
      if (use) use.setAttribute('href', ok ? '#i-check' : '#i-x');
      if (label) label.textContent = ok ? '복사됨' : '복사 실패';
      if (plain) btn.textContent = ok ? '복사됨' : '복사 실패';
      if (btn.copyTimer) g.clearTimeout(btn.copyTimer);
      btn.copyTimer = g.setTimeout(function () {
        if (use) use.setAttribute('href', '#i-copy');
        if (label) label.textContent = '복사';
        if (plain) { btn.textContent = btn.copyText; btn.copyText = null; }
        btn.copyTimer = null;
      }, 1200);
    }
    function legacy() {
      var active = doc.activeElement;
      var ta = doc.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      doc.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (active && typeof active.focus === 'function') active.focus({ preventScroll: true });
      done(ok);
    }
    if (g.navigator && g.navigator.clipboard && g.navigator.clipboard.writeText) {
      g.navigator.clipboard.writeText(text).then(function () { done(true); }, legacy);
    } else legacy();
  }

  function goTo(id) {
    var el = doc.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.classList.add('flash');
    g.setTimeout(function () { el.classList.remove('flash'); }, 900);
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
    if (t.hasAttribute('data-goto')) { ev.preventDefault(); goTo(t.getAttribute('data-goto')); return; }
    var act = t.getAttribute('data-act');
    if (act && act.indexOf('ans-') === 0) { answerClick(act, t); return; }
    if (act === 'sub') {
      open(t.getAttribute('data-sid') || state.ui.active, t.getAttribute('data-sub'));
    } else if (act === 'ann-new') {
      var sid = t.getAttribute('data-sid');
      clearAnnotationRequest(sid);
      g.BriefAnnotate.status(sid, null);
      g.BriefAnnotate.decorate();
    } else if (act === 'exp') {
      var k = t.getAttribute('data-key');
      state.ui.expanded[k] = !state.ui.expanded[k];
      render();
    } else if (act === 'focus') {
      focusTab(t.getAttribute('data-session'));
    }
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
        A.update(model && Array.isArray(model.waiting) ? model.waiting : []);
      });
    }
  }

  // ---- board answers (server page only) ---------------------------------------------------------------------------
  // The page the board server serves carries its per-process write token in a meta tag (the file page, data.js and the SSE
  // model never do). With it the decision cards get A/B/C buttons and a reply box (view.js, ui.live) and every send is one
  // same-origin POST /answer {id, sessionId, option|text} with the token header. Per-decision state, kept across the full
  // re-render: state.ui.answers[id] = {open, draft, confirm: {option}|{text}|null, phase: ''|'sending'|'sent'|'closed', error,
  // sentOption: the option of the send, '' for a reply}. A report's 이걸로 고르기 (data-dec) uses the same state and confirm row,
  // in place on the report (convo-view.js).
  // Conversation and sub-tab identity live in state.ui.active/sub, independently of decision classification.
  // A 200 only means the answer is stored: 전달됨 comes from the next view model (render.mjs delivery text), never from here.
  var REPLY_MAX = 500; // = view.js maxlength; <= 500 UTF-16 units is always within the server's 500 code points
  var POST_TIMEOUT_MS = 15000; // over the server's own bounds (2 s body read, 10 s write: it answers 408/504 first)
  var RELOAD_KEY = 'omo-briefing.answer403'; // sessionStorage: one automatic reload per 403, plus the reply drafts it carries
  var ANSWER_TEXT = {
    closed: '이미 답했거나 닫힌 결정',
    held: '보류한 결정이에요 - 다시 열기를 누른 뒤 답하세요',
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
    if (!Object.prototype.hasOwnProperty.call(all, key)) all[key] = { open: false, draft: '', confirm: null, phase: '', error: '' };
    return all[key];
  }

  function findDecision(id) {
    var list = state.model && Array.isArray(state.model.sessions) ? state.model.sessions : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i], ds = s && Array.isArray(s.decisions) ? s.decisions : [];
      for (var j = 0; j < ds.length; j++) {
        if (ds[j] && ds[j].id === id) return { d: ds[j], owner: s, sessionId: typeof ds[j].sessionId === 'string' && ds[j].sessionId ? ds[j].sessionId : String(s.id), card: String(s.id) };
      }
    }
    return null;
  }

  function answerClick(act, t) {
    var key = t.getAttribute('data-id') || t.getAttribute('data-dec');
    if (!answerToken || !validKey(key)) return;
    var a = answerState(key);
    // 보류 asks first everywhere (the same confirm row as an answer, C-HOLD 5); 보류 in the row and 다시 열기 post at once
    if (act === 'ans-hold' && a.phase === '') {
      a.confirm = { hold: true };
      a.open = false;
      a.error = '';
      render();
      return;
    }
    if (act === 'ans-send' && a.phase === '' && a.confirm && a.confirm.hold === true) act = 'ans-hold-go';
    if (act === 'ans-hold-go' || act === 'ans-reopen') {
      if (a.phase === 'sending') return;
      var found = findDecision(Number(key));
      if (!found) return;
      var action = act === 'ans-hold-go' ? 'hold' : 'reopen';
      a.phase = 'sending';
      a.error = '';
      render();
      postJson('/answer', { id: Number(key), sessionId: found.sessionId, action: action }).then(guard('decision action', function (res) {
        a.phase = '';
        if (res.status === 200 && res.json && res.json.ok) {
          found.d.held = action === 'hold' ? { at: state.now() } : null;
          found.d.closed = action === 'hold';
          a.confirm = null;
        } else {
          a.error = answerFailure(res.status, res.json && res.json.code).text;
          a.confirm = null;
        }
        render();
      }));
      return;
    }
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
    } else if (act === 'ans-fields') {
      var foundFields = findDecision(Number(key));
      if (!foundFields || !Array.isArray(foundFields.d.fields)) return;
      var checked = fieldValues(foundFields.d.fields, a.values || {});
      a.fieldErrors = checked.errors;
      a.confirm = Object.keys(checked.errors).length ? null : { values: checked.values,
        labels: foundFields.d.fields.map(function (f) { return { id: f.id, label: f.label }; }) };
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
    var field = t && t.getAttribute && t.getAttribute('data-field');
    if (field) {
      var fieldKey = t.getAttribute('data-id');
      if (!validKey(fieldKey)) return;
      var fieldAnswer = answerState(fieldKey);
      if (fieldAnswer.phase) return;
      var fieldDecision = findDecision(Number(fieldKey));
      if (!fieldDecision || !Array.isArray(fieldDecision.d.fields) || !fieldDecision.d.fields.some(function (f) { return f.id === field; })) return;
      var draftValues = fieldAnswer.values || (fieldAnswer.values = Object.create(null));
      draftValues[field] = String(t.value == null ? '' : t.value);
      var wasConfirmed = !!fieldAnswer.confirm;
      fieldAnswer.confirm = null;
      fieldAnswer.error = '';
      if (wasConfirmed || fieldAnswer.fieldErrors) fieldAnswer.fieldErrors = fieldValues(fieldDecision.d.fields, draftValues).errors;
      render(); // region() preserves this exact field/radio value and the text selection, never Send.
      return;
    }
    var key = t && typeof t.getAttribute === 'function' ? t.getAttribute('data-draft') : null;
    if (!validKey(key)) return;
    var a = answerState(key);
    a.draft = String(t.value == null ? '' : t.value).slice(0, REPLY_MAX);
    var box = typeof t.closest === 'function' ? t.closest('.ans-reply') : null;
    var count = box ? box.querySelector('.ans-count') : null;
    if (count) count.textContent = a.draft.length + '/' + REPLY_MAX;
  }

  function fieldValues(fields, draft) {
    var values = Object.create(null), errors = Object.create(null);
    fields.forEach(function (f) {
      var raw = Object.prototype.hasOwnProperty.call(draft, f.id) ? draft[f.id] : '';
      var value = String(raw);
      if (f.kind === 'number') {
        value = value.trim() === '' ? NaN : Number(value);
        if (!isFinite(value)) errors[f.id] = '숫자를 입력해 주세요';
        else if (value < f.min || value > f.max) errors[f.id] = f.min + '..' + f.max + ' 범위로 입력해 주세요';
        else {
          var q = (value - f.min) / f.step;
          if (isFinite(q) && Math.abs(q - Math.round(q)) > Math.min(1e-7, Number.EPSILON * Math.max(1, Math.abs(q)) * 4))
            errors[f.id] = f.min + '부터 ' + f.step + ' 간격으로 입력해 주세요';
        }
      } else if (f.kind === 'text') {
        if (!value.trim() || Array.from(value).length > f.maxLen) errors[f.id] = '1..' + f.maxLen + '자로 입력해 주세요';
      } else if (f.options.indexOf(value) < 0) errors[f.id] = '선택지 중 하나를 골라 주세요';
      values[f.id] = value;
    });
    return { values: values, errors: errors };
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
    if (c.values) body.values = c.values;
    else if (typeof c.option === 'string') body.option = c.option; else body.text = c.text;
    a.sentOption = typeof c.option === 'string' ? c.option : '';
    a.phase = 'sending';
    a.error = '';
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
    } else if (res.status === 400 && code === 'BAD_VALUES') {
      a.phase = '';
      a.confirm = null;
      a.fieldErrors = res.json.fieldErrors || {};
      a.error = '입력 값을 확인해 주세요';
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
    if (status === 409 && code === 'HELD') return { text: ANSWER_TEXT.held };
    if (status === 409 && code === 'NO_TEXT_SUPPORT') return { text: ANSWER_TEXT.noText };
    if (status === 404 || (status === 409 && code === 'SESSION_MISMATCH')) return { phase: 'closed', text: ANSWER_TEXT.gone };
    if (status === 503) return { text: ANSWER_TEXT.paused, retry: true };
    if (status === 429) return { text: ANSWER_TEXT.busy, retry: true };
    if (status === 408 || status === 504) return { text: ANSWER_TEXT.slow, retry: true };
    if (status === 0) return { text: ANSWER_TEXT.network, retry: true };
    if (status === 413) return { text: '너무 길어요 - 주석을 나눠 보내세요', retry: true };
    return { text: ANSWER_TEXT.failed + ' (' + status + (code ? ' ' + code : '') + ') - 다시 눌러 주세요', retry: true };
  }

  // An annotation request is immutable until stored successfully or explicitly replaced. Retrying uses the same
  // canonical text and UUID, including after a token/generation reload; never resend on startup.
  var annotationRequests = Object.create(null), annotationUnsupported = Object.create(null), annotationSent = Object.create(null);
  var ANN_REQUEST_KEY = 'omo-briefing.annotation.';
  function annotationContext() {
    var s = currentSession();
    if (!s) return null;
    return { session: s, sub: state.ui.sub[s.id] || 'ov', expanded: state.ui.expanded,
      mode: state.ui.live && !annotationUnsupported[s.id] && Array.isArray(s.answerKinds) && s.answerKinds.indexOf('annotation') >= 0 ? 'live' : 'file' };
  }
  function annotationRequest(sid) {
    if (Object.prototype.hasOwnProperty.call(annotationRequests, sid)) return annotationRequests[sid];
    var r = null;
    try {
      var raw = g.sessionStorage && g.sessionStorage.getItem(ANN_REQUEST_KEY + sid);
      if (raw) {
        var saved = JSON.parse(raw);
        if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.requestId) && typeof saved.text === 'string') r = saved;
      }
    } catch (e) { warn('annotation reload request', e); }
    annotationRequests[sid] = r;
    return r;
  }
  function clearAnnotationRequest(sid) {
    annotationRequests[sid] = null;
    try { if (g.sessionStorage) g.sessionStorage.removeItem(ANN_REQUEST_KEY + sid); }
    catch (e) { warn('annotation reload request', e); }
  }
  function sendAnnotation(s, text) {
    var sid = s.id, A = g.BriefAnnotate;
    if (!state.ui.live || !Array.isArray(s.answerKinds) || s.answerKinds.indexOf('annotation') < 0) return;
    if (A.sending(sid)) return;
    var r = annotationRequest(sid);
    var conflict = '같은 묶음이 이미 다른 내용으로 보내졌어요 - 새로 보내기';
    if (r && r.text !== text) { A.status(sid, { text: conflict, conflict: true }); return; }
    if (!r) {
      r = { requestId: g.crypto.randomUUID(), text: text };
      annotationRequests[sid] = r;
    }
    try { if (g.sessionStorage) g.sessionStorage.setItem(ANN_REQUEST_KEY + sid, JSON.stringify(r)); }
    catch (e) { warn('annotation reload request', e); }
    delete annotationSent[sid];
    A.status(sid, { text: '보내는 중…', sending: true });
    postJson('/answer', { kind: 'annotation', sessionId: sid, requestId: r.requestId, text: r.text }).then(guard('annotation reply', function (res) {
      var code = res.json && res.json.code;
      if (res.status === 200 && res.json && res.json.ok === true) {
        reloadedFor403 = false;
        A.status(sid, null);
        A.clear(sid);
        clearAnnotationRequest(sid);
        annotationSent[sid] = res.json.key;
        A.status(sid, { text: '보냄 · 전달 상태 기다리는 중…', ok: true });
        state.ui.expanded['cv:' + sid + ':notes'] = true;
        if (state.ui.active === sid) open(sid, 'ov');
      } else if (res.status === 403 && !reloadedFor403 && rememberForReload()) {
        A.status(sid, null);
        reloadedFor403 = true;
        g.location.reload();
      } else if (res.status === 409 && code === 'NO_ANNOTATION_SUPPORT') {
        annotationUnsupported[sid] = true;
        A.status(sid, { text: '이 대화는 아직 주석을 못 받아요 - Markdown 복사로 붙여넣기', copy: true });
      } else if (res.status === 409 && code === 'REQUEST_ID_CONFLICT') {
        A.status(sid, { text: conflict, conflict: true });
      } else {
        A.status(sid, { text: res.status === 403 ? ANSWER_TEXT.reopen : answerFailure(res.status, code).text });
      }
    }));
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
    receive: receive, apply: apply, render: render, open: open, state: state, hooks: hooks,
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
    g.addEventListener('focus', guard('memento focus', refreshMemento));
    doc.addEventListener('visibilitychange', guard('memento visible', function () {
      if (doc.visibilityState === 'visible') refreshMemento();
    }));
    if (!state.model) render();
    if (http) { connectLive(); return; }
    inject();
    g.setInterval(function () { if (doc.visibilityState === 'visible') inject(); }, POLL_MS);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', guard('start', start));
  else guard('start', start)();
})(typeof globalThis !== 'undefined' ? globalThis : this);
