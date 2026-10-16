/* omo-briefing alarm: the "waiting for my answer" band, the tab title count and a one-shot chime.
 * Classic script (file:// safe, no modules). Nothing runs at load; page.js calls it after every apply (wiring: todo 13):
 *   g.BriefAlarm.update(vm.waiting, {origin, isFirst, storage, audioFactory, doc, liveUrl, now}) -> {total, fresh, sound}
 *   waiting = src/waiting.mjs items [{key, sessionId, title, text, blocks, at}]; origin = 'http' | 'file' or a URL/origin;
 *   isFirst defaults to "first call on this page"; storage defaults to window.localStorage; liveUrl = vm.server.url.
 * - Band #alarm-band (red, sticky top; inserted before #live-link / #app): one row per item, most recently noticed first,
 *   at most 3 rows + '외 n개'. Row text is exactly '답 기다림: <대화> · <문구 40자>' (40 code points; a longer text keeps 39
 *   and ends in '…') + [보기], which scrolls to the conversation card. An answered or closed item leaves the band.
 * - Tab title: '(N) ' in front while N items wait (replaced, never stacked).
 * - An update that brings at least one key never seen on this origin rings once: http(s) page only, 🔔 on, WebAudio
 *   880 Hz 120 ms then 1320 Hz 120 ms at gain 0.15 (no sound file). The first update after load marks what is already
 *   there as seen: band only, no sound.
 * - localStorage['omo-briefing.seenWaiting'] = {key: first seen ms} (each origin has its own; a key gone for 30 days is
 *   dropped, at most 500 kept). localStorage['omo-briefing.sound'] = 'on' | 'off' (default on).
 * - file:// page: band + '실시간 보기 열기' link to liveUrl (loopback http only), never a sound.
 * - Audio the browser has not allowed yet (context not running): the band says '소리를 켜려면 화면을 한 번 누르세요' and the
 *   first click or key resumes the AudioContext. A sound owed for more than 2 s is dropped, never played late.
 * - Storage that throws: in-memory fallback + one console.warn. No WebAudio: one console.warn, the band still works.
 * g.BriefAlarm.toggleSound() flips 🔔/🔕 and returns the new state; soundOn() reads it; soundButtonHtml() is the header
 * button ([data-alarm-sound]; its clicks are handled here at document level, so view.js only places it). */
(function (g) {
  'use strict';

  var SEEN_KEY = 'omo-briefing.seenWaiting';
  var SOUND_KEY = 'omo-briefing.sound';
  var TEXT_MAX = 40;
  var MAX_ROWS = 3;
  var KEEP_MS = 30 * 24 * 3600 * 1000;
  var MAX_SEEN = 500;
  var FLASH_MS = 900;
  var OWED_MS = 2000;
  var VOLUME = 0.15;
  var TONE_S = 0.12;
  var FADE_S = 0.01;
  var TONES = [880, 1320];
  var TABS = ['wait', 'run', 'done'];
  var LIVE_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d+\//;
  var TITLE_PREFIX = /^\(\d+\) /;
  var BLOCKED_TEXT = '소리를 켜려면 화면을 한 번 누르세요';
  var SOUND_ON = '🔔 소리 켜짐';
  var SOUND_OFF = '🔕 꺼짐';

  var env = { doc: null, storage: undefined, audioFactory: null, http: false, liveUrl: '', now: null };
  var calls = 0;
  var mem = Object.create(null); // last known storage values; the only copy once storage failed
  var storageBroken = false; // reading failed: memory only from then on
  var unsaved = Object.create(null); // keys whose newest value could not be written: memory wins over storage for them
  var warned = Object.create(null);
  var audio = null;
  var audioDead = false;
  var blocked = false; // a sound was due but the context does not run
  var owedAt = null;
  var flashUntil = Object.create(null);
  var lastItems = [];
  var lastHtml = null;
  var hookedDoc = null;

  function str(v) { return typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function flat(v) { return str(v).replace(/\s+/g, ' ').trim(); }
  function esc(v) {
    return str(v).replace(/[&<>"'`]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c];
    });
  }
  function clip(s, max) {
    var cps = Array.from(s);
    return cps.length <= max ? s : cps.slice(0, max - 1).join('') + '…';
  }
  function now() {
    var t = env.now ? env.now() : Date.now();
    return typeof t === 'number' && isFinite(t) ? t : Date.now();
  }

  function warnOnce(kind, message, err) {
    if (warned[kind]) return;
    warned[kind] = true;
    var c = g.console;
    if (c && typeof c.warn === 'function') c.warn('[omo-briefing] ' + message + (err ? ': ' + (err && err.message ? err.message : String(err)) : ''));
  }
  // Listener failures are reported, never swallowed (update() itself throws to page.js, which reports hook errors).
  function guard(where, fn) {
    return function (ev) {
      try { return fn(ev); } catch (e) {
        var c = g.console;
        if (c && typeof c.error === 'function') c.error('[omo-briefing] alarm ' + where, e);
      }
    };
  }

  // ---- storage: localStorage with an in-memory fallback ----------------------------------------------------------
  function backing() {
    // undefined = the page's own localStorage; reading that property can itself throw (blocked storage)
    return env.storage !== undefined ? env.storage : g.localStorage;
  }
  function storageFailed(err) {
    warnOnce('storage', '알람 기록을 브라우저 저장소에 쓸 수 없어 이 페이지 메모리에만 둡니다', err);
  }
  function load(key) {
    if (!storageBroken && !unsaved[key]) {
      try {
        var s = backing();
        if (s) { var v = s.getItem(key); mem[key] = typeof v === 'string' ? v : null; }
      } catch (e) { storageBroken = true; storageFailed(e); }
    }
    return own(mem, key) ? mem[key] : null;
  }
  // A failed write (quota full, blocked) makes only that key memory-only: values that can still be read, such as a
  // saved 🔕, stay in force.
  function save(key, value) {
    mem[key] = value;
    if (storageBroken) return;
    try {
      var s = backing();
      if (s) { s.setItem(key, value); delete unsaved[key]; }
    } catch (e) { unsaved[key] = true; storageFailed(e); }
  }

  function readSeen() {
    var out = Object.create(null);
    var raw = load(SEEN_KEY);
    if (raw === null || raw === '') return out;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      warnOnce('seen', '저장된 본 항목 목록을 읽지 못해 새로 시작합니다', e);
      return out;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnOnce('seen', '저장된 본 항목 목록의 모양이 달라 새로 시작합니다');
      return out;
    }
    for (var k in parsed) if (own(parsed, k) && typeof parsed[k] === 'number' && isFinite(parsed[k])) out[k] = parsed[k];
    return out;
  }

  // Keys no longer waiting for 30 days go; above 500 the oldest not-waiting keys go. Returns whether anything went.
  function prune(seen, current, t) {
    var changed = false;
    var k;
    for (k in seen) if (!current[k] && t - seen[k] > KEEP_MS) { delete seen[k]; changed = true; }
    var keys = Object.keys(seen);
    if (keys.length > MAX_SEEN) {
      var old = keys.filter(function (x) { return !current[x]; }).sort(function (a, b) { return seen[a] - seen[b]; });
      old.slice(0, keys.length - MAX_SEEN).forEach(function (x) { delete seen[x]; });
      changed = true;
    }
    return changed;
  }

  function soundOn() { return load(SOUND_KEY) !== 'off'; }

  // ---- sound --------------------------------------------------------------------------------------------------------
  function defaultAudio() {
    var Ctor = g.AudioContext || g.webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext 없음');
    return new Ctor();
  }
  function context() {
    if (audio || audioDead) return audio;
    try {
      audio = (env.audioFactory || defaultAudio)();
    } catch (e) {
      audioDead = true;
      warnOnce('audio', '알람 소리를 낼 수 없음(WebAudio)', e);
      return null;
    }
    if (!audio || typeof audio.createOscillator !== 'function') {
      audio = null;
      audioDead = true;
      warnOnce('audio', '알람 소리를 낼 수 없음(WebAudio 없음)');
    }
    return audio;
  }
  function tone(c, hz, at) {
    var osc = c.createOscillator();
    var amp = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(hz, at);
    // 10 ms fade in and out: no click at the edges
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(VOLUME, at + FADE_S);
    amp.gain.setValueAtTime(VOLUME, at + TONE_S - FADE_S);
    amp.gain.linearRampToValueAtTime(0, at + TONE_S);
    osc.connect(amp);
    amp.connect(c.destination);
    osc.start(at);
    osc.stop(at + TONE_S);
  }
  function chime(c) {
    var t0 = typeof c.currentTime === 'number' && isFinite(c.currentTime) ? c.currentTime : 0;
    try {
      for (var i = 0; i < TONES.length; i++) tone(c, TONES[i], t0 + i * TONE_S);
      return true;
    } catch (e) {
      warnOnce('play', '알람 소리를 내지 못함', e);
      return false;
    }
  }
  function resume(c) {
    var p;
    try { p = c.resume(); } catch (e) {
      warnOnce('resume', '알람 소리를 켜지 못함', e);
      return;
    }
    if (p && typeof p.then === 'function') {
      p.then(guard('audio resume', function () { resumed(c); }), function (e) { warnOnce('resume', '알람 소리를 켜지 못함', e); });
    } else resumed(c);
  }
  function resumed(c) {
    if (c !== audio || c.state !== 'running') return;
    var owed = owedAt !== null && now() - owedAt <= OWED_MS;
    var wasBlocked = blocked;
    owedAt = null;
    blocked = false;
    if (owed && env.http && soundOn()) chime(c);
    if (wasBlocked) draw();
  }
  function ring(t) {
    var c = context();
    if (!c) return 'unavailable';
    if (c.state === 'running') {
      blocked = false;
      return chime(c) ? 'played' : 'unavailable';
    }
    // not allowed yet (no user gesture on this page) or still starting: ask, show the hint until it runs
    blocked = true;
    owedAt = t;
    resume(c);
    return 'blocked';
  }
  // A click or key is a user gesture: the context created or resumed here is allowed to run.
  function unlock() {
    if (!env.http || !soundOn()) return;
    var c = context();
    if (c && c.state !== 'running') resume(c);
  }

  // ---- page ---------------------------------------------------------------------------------------------------------
  function order(items, seen) {
    var atOf = function (i) { return i.at === null ? -Infinity : i.at; };
    return items.slice().sort(function (a, b) {
      return ((seen[b.key] || 0) - (seen[a.key] || 0)) || (atOf(b) - atOf(a)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
  }

  function normalize(waiting) {
    var out = [];
    var have = Object.create(null);
    var list = Array.isArray(waiting) ? waiting : [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (!w || typeof w !== 'object' || typeof w.key !== 'string' || w.key === '' || have[w.key]) continue;
      have[w.key] = true;
      out.push({
        key: w.key,
        sessionId: str(w.sessionId),
        title: flat(w.title) || str(w.sessionId) || '(대화 모름)',
        tabLabel: flat(w.tabLabel),
        tabNumber: typeof w.tabNumber === 'number' && Math.floor(w.tabNumber) === w.tabNumber && isFinite(w.tabNumber) ? w.tabNumber : null,
        paneId: flat(w.paneId),
        text: flat(w.text),
        blocks: w.blocks === true,
        at: typeof w.at === 'number' && isFinite(w.at) ? w.at : null
      });
    }
    return out;
  }

  function noteHtml() {
    if (!env.http) {
      if (!LIVE_URL.test(env.liveUrl)) return '';
      return '<a class="alarm-live" href="' + esc(env.liveUrl) + '">실시간 보기 열기</a>' +
        '<span class="alarm-hint"> - 소리 알림은 실시간 보기에서만 울립니다</span>';
    }
    return blocked && soundOn() ? '<button type="button" class="alarm-unlock" data-alarm-unlock>' + BLOCKED_TEXT + '</button>' : '';
  }

  // who: herdr tab label and number when known, else the pane, else the title alone (plain text; escaped by the caller)
  function whoOf(it) {
    if (it.tabLabel) return '🗂 ' + it.tabLabel + (it.tabNumber === null ? '' : ' #' + it.tabNumber) + ' · ' + it.title;
    if (it.paneId) return '창 ' + it.paneId + ' · ' + it.title;
    return it.title;
  }

  function bandHtml(items, t) {
    var shown = items.slice(0, MAX_ROWS);
    var html = shown.map(function (it) {
      var text = clip(it.text, TEXT_MAX);
      var who = whoOf(it);
      return '<p class="alarm-row' + (flashUntil[it.key] > t ? ' is-new' : '') + '" data-alarm-key="' + esc(it.key) + '">' +
        '<span class="alarm-text" title="' + esc('답 기다림: ' + who + ' · ' + it.text) + '">답 기다림: <b class="alarm-who">' + esc(who) +
        '</b> · <span class="alarm-what">' + esc(text) + '</span></span>' +
        '<span class="alarm-act">' + (it.blocks ? '<span class="alarm-tag">막는 결정</span>' : '') +
        '<button type="button" class="alarm-go" data-alarm-goto="' + esc(it.sessionId) + '">보기</button></span></p>';
    }).join('');
    var more = items.length - shown.length;
    if (more > 0) html += '<p class="alarm-more" data-more="' + more + '">외 ' + more + '개 - 나를 기다림 탭</p>';
    var note = noteHtml();
    if (note) html += '<p class="alarm-note">' + note + '</p>';
    return html;
  }

  function ensureBand(d) {
    var el = d.getElementById ? d.getElementById('alarm-band') : null;
    if (el) return el;
    if (!d.createElement || !d.body) return null;
    el = d.createElement('section');
    el.id = 'alarm-band';
    el.className = 'alarm-band';
    el.hidden = true;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', '답 기다림 알람');
    el.setAttribute('aria-live', 'polite');
    el.addEventListener('click', guard('band click', onBandClick));
    // after page.js's live status, before its live link and the board
    var ref = d.getElementById('live-link') || d.getElementById('app') || d.body.firstChild || null;
    if (ref && ref.parentNode && ref.parentNode !== d.body) ref = null;
    d.body.insertBefore(el, ref);
    return el;
  }

  // The sticky band's height, for page layout (alarm.css offsets the sidebar, the badge and scroll targets by it).
  function publishHeight(d, el) {
    var st = d.documentElement && d.documentElement.style;
    if (!st || typeof st.setProperty !== 'function') return;
    var h = el.hidden ? 0 : el.offsetHeight || 0;
    if (h > 0) st.setProperty('--alarm-h', h + 'px');
    else if (typeof st.removeProperty === 'function') st.removeProperty('--alarm-h');
  }

  function setTitle(d, n) {
    if (typeof d.title !== 'string') return;
    var base = d.title.replace(TITLE_PREFIX, '');
    var next = n > 0 ? '(' + n + ') ' + base : base;
    if (next !== d.title) d.title = next;
  }

  function syncButtons(d) {
    if (typeof d.querySelectorAll !== 'function') return;
    var on = soundOn();
    var list = d.querySelectorAll('[data-alarm-sound]');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var label = on ? SOUND_ON : SOUND_OFF;
      if (b.textContent !== label) b.textContent = label;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (b.classList) { if (on) b.classList.remove('is-off'); else b.classList.add('is-off'); }
    }
  }

  function draw() {
    var d = env.doc;
    if (!d) return;
    hookDoc(d);
    var el = ensureBand(d);
    if (el) {
      if (!lastItems.length) {
        if (lastHtml !== '') { el.innerHTML = ''; lastHtml = ''; }
        el.hidden = true;
      } else {
        var html = bandHtml(lastItems, now());
        if (html !== lastHtml) { el.innerHTML = html; lastHtml = html; }
        el.hidden = false;
      }
      publishHeight(d, el);
    }
    setTitle(d, lastItems.length);
    syncButtons(d);
  }

  function findCard(d, sid) {
    var cards = typeof d.querySelectorAll === 'function' ? d.querySelectorAll('[data-card]') : [];
    for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute('data-card') === sid) return cards[i];
    return null;
  }

  // [보기]: scroll to the conversation card; when it is not on screen, let page.js show the tab that has it.
  function goTo(sid) {
    var d = env.doc;
    if (!d || !sid) return false;
    var el = findCard(d, sid);
    var page = g.BriefPage;
    if (!el && page && page.state && page.state.ui && typeof page.render === 'function') {
      var before = page.state.ui.tab;
      for (var i = 0; i < TABS.length && !el; i++) {
        page.state.ui.tab = TABS[i];
        page.render();
        el = findCard(d, sid);
      }
      if (!el) { page.state.ui.tab = before; page.render(); }
    }
    if (!el) return false;
    el.scrollIntoView({ block: 'start' });
    if (el.classList && typeof g.setTimeout === 'function') {
      el.classList.add('flash');
      g.setTimeout(function () { el.classList.remove('flash'); }, FLASH_MS);
    }
    return true;
  }

  function onBandClick(ev) {
    var t = ev && ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-alarm-goto]') : null;
    if (!t) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    goTo(t.getAttribute('data-alarm-goto'));
  }

  function onDocClick(ev) {
    var t = ev && ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-alarm-sound]') : null;
    if (t) { toggleSound(); return; }
    unlock();
  }

  function hookDoc(d) {
    if (hookedDoc === d || typeof d.addEventListener !== 'function') return;
    hookedDoc = d;
    d.addEventListener('click', guard('click', onDocClick), true);
    d.addEventListener('keydown', guard('keydown', unlock), true);
    if (typeof g.addEventListener === 'function') {
      g.addEventListener('resize', guard('resize', function () {
        var el = d.getElementById('alarm-band');
        if (el) publishHeight(d, el);
      }));
    }
  }

  function isHttp(origin) {
    var s = str(origin);
    return s === 'http' || s === 'https' || /^https?:/i.test(s);
  }

  function configure(o) {
    if (o.doc !== undefined) env.doc = o.doc;
    else if (!env.doc && g.document) env.doc = g.document;
    if (o.storage !== undefined) env.storage = o.storage;
    if (typeof o.audioFactory === 'function') env.audioFactory = o.audioFactory;
    if (typeof o.now === 'function') env.now = o.now;
    env.http = isHttp(o.origin !== undefined ? o.origin : g.location && g.location.protocol);
    env.liveUrl = typeof o.liveUrl === 'string' ? o.liveUrl : '';
  }

  function update(waiting, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    configure(o);
    var first = o.isFirst !== undefined ? o.isFirst === true : calls === 0;
    calls++;
    var items = normalize(waiting);
    var t = now();
    var current = Object.create(null);
    items.forEach(function (it) { current[it.key] = true; });
    var seen = readSeen();
    var fresh = [];
    items.forEach(function (it) {
      if (!own(seen, it.key)) { fresh.push(it.key); seen[it.key] = t; }
    });
    var pruned = prune(seen, current, t);
    if (fresh.length || pruned) save(SEEN_KEY, JSON.stringify(seen));
    for (var k in flashUntil) if (flashUntil[k] <= t) delete flashUntil[k];

    var sound = 'none';
    if (fresh.length && first) sound = 'first';
    else if (fresh.length) {
      fresh.forEach(function (key) { flashUntil[key] = t + FLASH_MS; });
      if (!env.http) sound = 'file';
      else if (!soundOn()) sound = 'muted';
      else sound = ring(t);
    }
    lastItems = order(items, seen);
    draw();
    return { total: items.length, fresh: fresh, sound: sound };
  }

  function toggleSound() {
    var on = !soundOn();
    save(SOUND_KEY, on ? 'on' : 'off');
    if (on) unlock(); // the click that turned it on is a user gesture: the context may start now
    draw();
    return on;
  }

  function soundButtonHtml() {
    var on = soundOn();
    return '<button type="button" class="alarm-sound' + (on ? '' : ' is-off') + '" data-alarm-sound aria-pressed="' + (on ? 'true' : 'false') +
      '" title="답 기다림 알람 소리 켜기/끄기">' + (on ? SOUND_ON : SOUND_OFF) + '</button>';
  }

  g.BriefAlarm = { update: update, toggleSound: toggleSound, soundOn: soundOn, soundButtonHtml: soundButtonHtml };
})(typeof globalThis !== 'undefined' ? globalThis : this);
