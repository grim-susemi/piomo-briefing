/* omo-briefing live worker rows: classic script (file:// safe, no modules), loaded after view.js.
 * globalThis.BriefWorkersView:
 *  render(live, now, {esc, expanded}) -> html, '' when there is no worker. live = sessions[].live
 *    ({workers:[...]}) or the bare array of workers.mjs WorkerBook.list() rows.
 *  summary(live) -> '작업자 3 · 진행 2 · 끝 1' (plain text; also the first line of render()).
 *  measure(root) -> positions and states of [data-card], [data-worker] and [data-todo] (call before an apply).
 *  play(root, before, {reducedMotion}) -> FLIP after the apply: cards and worker rows slide 350 ms from
 *    where they were, a card that left the shown tab fades and folds for 400 ms in its old spot, a worker
 *    that just ended and a todo that just turned ✔ pop their mark. Returns {moved, left, entered, done}.
 *  tick(root, now) -> rewrites only the text of [data-since] elements (1 s ticker, never a redraw).
 * `now` is a wall clock, not vm.generatedAt: page.js passes the one of the model's apply (ui.wallNow; Date.now()
 * when absent). The running pulse is the 1200 ms w-pulse animation in workers-view.css started at
 * -(now % 1200) ms, so the redraw of an apply keeps the beat instead of restarting it, and every render of
 * the same model writes the same HTML. Model strings are untrusted and always go through esc().
 * Expansion key worker:<taskId> rides the existing data-act="exp" channel. */
(function (g) {
  'use strict';

  var PULSE_MS = 1200; // = w-pulse duration in workers-view.css
  var MOVE_MS = 350;
  var LEAVE_MS = 400;
  var EASE = 'cubic-bezier(.2, .8, .2, 1)';
  var MAX_ROWS = 20;
  var MAX_TODOS = 30;
  var MAX_GHOSTS = 4;
  var MAX_ANIMS = 120;
  var STALE_TEXT = '응답 없음 10분';
  var STATES = {
    running: { cls: 'w-running', mark: '', label: '진행 중' },
    waiting: { cls: 'w-waiting', mark: '○', label: '대기' },
    done: { cls: 'w-done', mark: '✔', label: '끝' },
    error: { cls: 'w-error', mark: '✖', label: '오류' },
    cancelled: { cls: 'w-cancelled', mark: '⊘', label: '취소' },
    lost: { cls: 'w-lost', mark: '⊘', label: '끊김' }
  };
  var TERMINAL = { done: 1, error: 1, cancelled: 1, lost: 1 };
  var TODO = {
    completed: ['w-t-done', '✔'],
    in_progress: ['w-t-doing', '●'],
    pending: ['w-t-todo', '○'],
    abandoned: ['w-t-dropped', '–'],
    cancelled: ['w-t-dropped', '–']
  };
  var CLOSED = { completed: 1, abandoned: 1, cancelled: 1 };

  function str(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  // own-property lookup: model strings like 'constructor' must not hit Object.prototype
  function own(o, k) { return o && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function toMs(t) {
    if (typeof t === 'number' && isFinite(t)) return t;
    if (typeof t === 'string' && t) { var p = Date.parse(t); return isFinite(p) ? p : null; }
    return null;
  }
  function escapeHtml(v) {
    return str(v).replace(/[&<>"'`]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function elapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + '초';
    var m = Math.floor(s / 60);
    if (m < 60) return m + '분 ' + pad(s % 60) + '초';
    var h = Math.floor(m / 60);
    if (h < 24) return h + '시간 ' + pad(m % 60) + '분';
    return Math.floor(h / 24) + '일 ' + (h % 24) + '시간';
  }
  function r1(n) { return Math.round(n * 10) / 10; }
  function phase(now) { return Math.floor(((now % PULSE_MS) + PULSE_MS) % PULSE_MS); }

  // Valid rows only, first occurrence of each id (ids are the FLIP and expansion keys).
  function workersOf(live) {
    var list = Array.isArray(live) ? live : obj(live) ? live.workers : null;
    var seen = Object.create(null), out = [];
    arr(list).forEach(function (w) {
      var id = obj(w) ? str(w.id) : '';
      if (!id || seen[id]) return;
      seen[id] = 1;
      out.push(w);
    });
    return out;
  }
  function stateOf(w) { return own(STATES, w.state) ? w.state : 'waiting'; }
  function isStale(w) { return !TERMINAL[stateOf(w)] && w.stale === true; }
  // running first, then no-response, then waiting, then finished (latest end first)
  function rank(w) {
    var s = stateOf(w);
    if (TERMINAL[s]) return 3;
    if (w.stale === true) return 1;
    return s === 'running' ? 0 : 2;
  }
  function sorted(list) {
    return list.map(function (w, i) { return { w: w, i: i, r: rank(w), end: toMs(w.endedAt) }; })
      .sort(function (a, b) {
        if (a.r !== b.r) return a.r - b.r;
        if (a.r === 3 && a.end !== b.end) {
          if (a.end == null) return 1;
          if (b.end == null) return -1;
          return b.end - a.end;
        }
        return a.i - b.i;
      })
      .map(function (x) { return x.w; });
  }

  function summary(live) {
    var list = workersOf(live);
    if (!list.length) return '';
    var c = { running: 0, stale: 0, waiting: 0, done: 0, error: 0, cancelled: 0, lost: 0 };
    list.forEach(function (w) { c[isStale(w) ? 'stale' : stateOf(w)]++; });
    var parts = ['작업자 ' + list.length, '진행 ' + c.running, '끝 ' + c.done];
    [['error', '오류'], ['stale', '응답 없음'], ['waiting', '대기'], ['cancelled', '취소'], ['lost', '끊김']].forEach(function (p) {
      if (c[p[0]]) parts.push(p[1] + ' ' + c[p[0]]);
    });
    return parts.join(' · ');
  }

  function stepOf(w, s, stale) {
    if (stale) return STALE_TEXT;
    if (TERMINAL[s]) {
      var end = toMs(w.endedAt);
      return STATES[s].label + (end == null ? '' : ' ' + hhmm(end));
    }
    // no RPC snapshot yet (only the id and name from the task tool): say so
    if (s === 'waiting') return toMs(w.updatedAt) == null ? '정보 대기' : str(w.step) || '대기 중';
    return str(w.step);
  }

  function todoOf(w) {
    var t = obj(w.todo);
    var items = t ? arr(t.items).filter(function (it) { return !!obj(it); }) : [];
    if (!items.length) return null;
    var total = num(t.total);
    if (total == null || total < items.length) total = items.length + Math.max(0, Math.floor(num(t.more) || 0));
    var done = num(t.done);
    if (done == null || done < 0 || done > total) {
      done = 0;
      items.forEach(function (it) { if (own(CLOSED, it.status)) done++; });
    }
    var shown = items.slice(0, MAX_TODOS);
    return { items: shown, total: Math.floor(total), done: Math.floor(done), hidden: Math.max(0, Math.floor(total) - shown.length) };
  }
  // Stable per-worker todo identity for the ✔ transition: the text (#n for repeats), not the index.
  function todoKeys(items) {
    var seen = Object.create(null);
    return items.map(function (it) {
      var t = str(it.text);
      seen[t] = (seen[t] || 0) + 1;
      return seen[t] > 1 ? t + '#' + seen[t] : t;
    });
  }
  function todoList(todo, e) {
    var keys = todoKeys(todo.items);
    var html = '<ul class="w-todos">';
    todo.items.forEach(function (it, i) {
      var st = own(TODO, it.status) ? it.status : 'pending';
      html += '<li class="w-todo ' + TODO[st][0] + '" data-todo="' + e(keys[i]) + '" data-st="' + st + '">' +
        '<span class="w-tsym" aria-hidden="true">' + TODO[st][1] + '</span><span class="w-ttext">' + e(it.text) + '</span></li>';
    });
    if (todo.hidden) html += '<li class="w-todo-more">외 ' + todo.hidden + '개</li>';
    return html + '</ul>';
  }

  function row(w, now, expanded, e) {
    var s = stateOf(w), info = STATES[s], stale = isStale(w);
    var id = str(w.id), start = toMs(w.startedAt), end = toMs(w.endedAt);
    var html = '<li class="w-row ' + info.cls + (stale ? ' w-stale' : '') + '" data-worker="' + e(id) + '" data-st="' + s + '">';
    if (stale) html += '<span class="w-dot" role="img" aria-label="' + STALE_TEXT + '" title="' + STALE_TEXT + '"></span>';
    else if (s === 'running') {
      html += '<span class="w-dot" style="animation-delay:-' + phase(now) + 'ms" role="img" aria-label="' + info.label + '" title="' + info.label + '"></span>';
    } else html += '<span class="w-dot" role="img" aria-label="' + info.label + '" title="' + info.label + '">' + info.mark + '</span>';
    html += '<span class="w-name" title="' + e(id) + '">' + e(str(w.name) || id) + '</span>';
    var tags = (str(w.kind) ? '<span class="w-tag">[' + e(w.kind) + ']</span>' : '') +
      (str(w.model) ? '<span class="w-tag w-model">[' + e(w.model) + ']</span>' : '');
    if (tags) html += '<span class="w-tags">' + tags + '</span>';
    if (TERMINAL[s]) {
      if (start != null && end != null) html += '<span class="w-time">⏱ ' + elapsed(end - start) + '</span>';
    } else if (start != null) {
      html += '<span class="w-time" data-since="' + start + '">⏱ ' + elapsed(now - start) + '</span>';
    }
    var step = stepOf(w, s, stale);
    if (step) html += '<span class="w-step" title="' + e(step) + '">' + e(step) + '</span>';
    var todo = todoOf(w);
    if (todo) {
      var key = 'worker:' + id, open = !!own(expanded, key);
      html += '<button type="button" class="more w-todo-btn" data-act="exp" data-key="' + e(key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        (open ? '▴' : '▾') + ' 투두 ' + todo.done + '/' + todo.total + '</button>';
      if (open) html += todoList(todo, e);
    }
    return html + '</li>';
  }

  function render(live, now, ui) {
    var list = workersOf(live);
    if (!list.length) return '';
    var opts = obj(ui) || {};
    var e = typeof opts.esc === 'function' ? opts.esc : escapeHtml;
    var expanded = obj(opts.expanded) || {};
    var t = toMs(now);
    if (t == null) t = Date.now();
    var rows = sorted(list);
    var html = '<div class="w-block"><p class="w-sum">' + e(summary(list)) + '</p><ul class="w-rows">';
    rows.slice(0, MAX_ROWS).forEach(function (w) { html += row(w, t, expanded, e); });
    html += '</ul>';
    if (rows.length > MAX_ROWS) html += '<p class="w-more">외 ' + (rows.length - MAX_ROWS) + '명</p>';
    return html + '</div>';
  }

  // ---- motion ----------------------------------------------------------------------------------
  function each(list, fn) { for (var i = 0; list && i < list.length; i++) fn(list[i]); }
  function attr(el, k) { var v = el.getAttribute(k); return v == null ? '' : String(v); }
  function box(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.top + r.height };
  }
  function cardOf(el) { var c = el.closest('[data-card]') || el.closest('[data-sid]'); return c ? attr(c, 'data-card') || attr(c, 'data-sid') : ''; }
  function rowKey(el) { return cardOf(el) + '\n' + (attr(el, 'data-block') || 'wk/' + attr(el, 'data-worker')); }
  function onScreen(r, vh) { return r.height > 0 && r.bottom > 0 && r.top < vh; }

  function measure(root) {
    var snap = { cards: Object.create(null), rows: Object.create(null), todos: Object.create(null), cardCount: 0 };
    if (!root || typeof root.querySelectorAll !== 'function') return snap;
    var cards = Array.prototype.slice.call(root.querySelectorAll('[data-card]'));
    each(root.querySelectorAll('[data-block]'), function (el) { if (attr(el, 'data-block') === 'head') cards.push(el); });
    each(cards, function (el) {
      var k = attr(el, 'data-card') || cardOf(el);
      if (snap.cards[k]) return;
      snap.cards[k] = { el: el, rect: box(el) };
      snap.cardCount++;
    });
    each(root.querySelectorAll('[data-worker]'), function (el) {
      var k = rowKey(el);
      if (!snap.rows[k]) snap.rows[k] = { el: el, rect: box(el), card: cardOf(el), st: attr(el, 'data-st') };
    });
    each(root.querySelectorAll('[data-todo]'), function (el) {
      var w = el.closest('[data-worker]');
      snap.todos[(w ? rowKey(w) : '') + '\n' + attr(el, 'data-todo')] = { el: el, st: attr(el, 'data-st') };
    });
    return snap;
  }

  function reduced(opts) {
    if (opts && typeof opts.reducedMotion === 'boolean') return opts.reducedMotion;
    return !!(g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // The old card element (detached by the redraw) is shown again at its old screen spot, outside
  // #app and without data-card, then fades and folds away. It sits behind the board (z-index -1) so
  // the opaque card sliding up into that spot covers it instead of mixing the two cards' text.
  function ghost(root, card) {
    var host = root.parentNode, el = card.el, r = card.rect;
    if (!host || typeof el.animate !== 'function') return false;
    el.removeAttribute('id');
    el.removeAttribute('data-card');
    el.setAttribute('aria-hidden', 'true');
    el.classList.add('w-ghost');
    var s = el.style;
    s.position = 'absolute';
    s.left = r1(r.left + (num(g.scrollX) || 0)) + 'px';
    s.top = r1(r.top + (num(g.scrollY) || 0)) + 'px';
    s.width = r1(r.width) + 'px';
    s.height = r1(r.height) + 'px';
    s.margin = '0';
    s.boxSizing = 'border-box';
    s.pointerEvents = 'none';
    s.transformOrigin = '50% 0';
    s.zIndex = '-1';
    host.appendChild(el);
    var gone = false;
    function remove() {
      if (gone) return;
      gone = true;
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    var a = el.animate([{ opacity: 1, transform: 'scaleY(1)' }, { opacity: 0, transform: 'scaleY(0)' }],
      { duration: LEAVE_MS, easing: 'ease-in', fill: 'forwards' });
    a.onfinish = remove;
    g.setTimeout(remove, LEAVE_MS + 100);
    return true;
  }

  function play(root, before, opts) {
    var out = { moved: 0, left: 0, entered: 0, done: 0 };
    if (!root || typeof root.querySelectorAll !== 'function' || !obj(before) || !before.cards || reduced(opts)) return out;
    var vh = num(g.innerHeight) || 0;
    var after = measure(root); // every "last" rect is read before any animation starts
    var budget = MAX_ANIMS;
    function animate(el, frames, ms, easing) {
      if (budget <= 0 || typeof el.animate !== 'function') return false;
      budget--;
      el.animate(frames, { duration: ms, easing: easing });
      return true;
    }
    function slide(el, dx, dy) {
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      if (animate(el, [{ transform: 'translate(' + r1(dx) + 'px, ' + r1(dy) + 'px)' }, { transform: 'none' }], MOVE_MS, EASE)) out.moved++;
    }
    function fadeIn(el) {
      if (animate(el, [{ opacity: 0 }, { opacity: 1 }], MOVE_MS, 'ease-out')) out.entered++;
    }
    var k, a, b;
    for (k in after.cards) {
      a = after.cards[k];
      b = before.cards[k];
      if (b) {
        if (onScreen(a.rect, vh) || onScreen(b.rect, vh)) slide(a.el, b.rect.left - a.rect.left, b.rect.top - a.rect.top);
      } else if (before.cardCount > 0 && onScreen(a.rect, vh)) fadeIn(a.el); // never on the first paint
    }
    for (k in after.rows) {
      a = after.rows[k];
      b = before.rows[k];
      var ac = after.cards[a.card], bc = before.cards[a.card];
      if (!b) {
        if (bc && onScreen(a.rect, vh)) fadeIn(a.el);
        continue;
      }
      if (!TERMINAL[b.st] && TERMINAL[a.st]) { a.el.classList.add('w-just-ended'); out.done++; }
      if (!onScreen(a.rect, vh) && !onScreen(b.rect, vh)) continue;
      // offsets inside the card: the card's own slide already carries the rows with it
      var dx = b.rect.left - a.rect.left, dy = b.rect.top - a.rect.top;
      if (ac && bc) { dx -= bc.rect.left - ac.rect.left; dy -= bc.rect.top - ac.rect.top; }
      slide(a.el, dx, dy);
    }
    for (k in after.todos) {
      a = after.todos[k];
      b = before.todos[k];
      if (b && a.st === 'completed' && b.st !== 'completed') { a.el.classList.add('w-just-done'); out.done++; }
    }
    var ghosts = 0;
    for (k in before.cards) {
      if (after.cards[k] || ghosts >= MAX_GHOSTS || !onScreen(before.cards[k].rect, vh)) continue;
      if (ghost(root, before.cards[k])) { ghosts++; out.left++; }
    }
    return out;
  }

  function tick(root, now) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    var t = toMs(now);
    if (t == null) return 0;
    var n = 0;
    each(root.querySelectorAll('[data-since]'), function (el) {
      var raw = el.getAttribute('data-since');
      var since = raw ? Number(raw) : NaN;
      if (!isFinite(since)) return;
      var text = '⏱ ' + elapsed(t - since);
      if (el.textContent !== text) { el.textContent = text; n++; }
    });
    return n;
  }

  g.BriefWorkersView = { render: render, summary: summary, measure: measure, play: play, tick: tick };
})(typeof globalThis !== 'undefined' ? globalThis : this);
