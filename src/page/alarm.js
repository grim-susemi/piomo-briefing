/* omo-briefing waiting alarms: seen-key storage, tab title count and one-shot WebAudio chimes.
 * Classic script; page.js calls BriefAlarm.update(waiting, {origin, isFirst, storage, audioFactory, doc, now}).
 * First load records existing keys without sound; later unseen keys ring once per update on HTTP pages.
 * Seen keys persist per origin, expire after 30 days when absent, and are capped at 500.
 * Sound preference persists separately. File pages record keys and title counts but never play sound.
 * A click or key unlocks native audio; an owed chime older than 2 seconds is not replayed.
 * soundButtonHtml()/toggleSound()/soundOn() serve the existing Settings bell control. */
(function (g) {
  'use strict';

  var SEEN_KEY = 'omo-briefing.seenWaiting';
  var SOUND_KEY = 'omo-briefing.sound';
  var KEEP_MS = 30 * 24 * 3600 * 1000;
  var MAX_SEEN = 500;
  var OWED_MS = 2000;
  var VOLUME = 0.15;
  var TONE_S = 0.12;
  var FADE_S = 0.01;
  var TONES = [880, 1320];
  var TITLE_PREFIX = /^\(\d+\) /;
  var SOUND_ON = '소리 켜짐';
  var SOUND_OFF = '꺼짐';

  var env = { doc: null, storage: undefined, audioFactory: null, http: false, now: null };
  var calls = 0;
  var mem = Object.create(null); // last known storage values; the only copy once storage failed
  var storageBroken = false; // reading failed: memory only from then on
  var unsaved = Object.create(null); // keys whose newest value could not be written: memory wins over storage for them
  var warned = Object.create(null);
  var audio = null;
  var audioDead = false;
  var owedAt = null;
  var lastTotal = 0;
  var hookedDoc = null;

  function str(v) { return typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  // a Lucide icon from the page's sprite (icons.js); '' without icons.js (this file's unit tests)
  function ic(name, cls) { var m = g.BriefIcons; return m ? m.icon(name, cls) : ''; }
  function soundLabel(on) { return on ? ic('bell') + ' ' + SOUND_ON : ic('bell-off') + ' ' + SOUND_OFF; } // our own words only
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
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
  // saved off, stay in force.
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
    owedAt = null;
    if (owed && env.http && soundOn()) chime(c);
  }
  function ring(t) {
    var c = context();
    if (!c) return 'unavailable';
    if (c.state === 'running') {
      return chime(c) ? 'played' : 'unavailable';
    }
    // Native autoplay policy may defer this chime until a user gesture.
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
  function normalize(waiting) {
    var out = [];
    var have = Object.create(null);
    var list = Array.isArray(waiting) ? waiting : [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (!w || typeof w !== 'object' || typeof w.key !== 'string' || w.key === '' || have[w.key]) continue;
      have[w.key] = true;
      out.push({ key: w.key });
    }
    return out;
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
      if (b.getAttribute('aria-pressed') !== (on ? 'true' : 'false')) b.innerHTML = soundLabel(on); // the label goes with the state
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (b.classList) { if (on) b.classList.remove('is-off'); else b.classList.add('is-off'); }
    }
  }

  function sync() {
    var d = env.doc;
    if (!d) return;
    hookDoc(d);
    setTitle(d, lastTotal);
    syncButtons(d);
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

    var sound = 'none';
    if (fresh.length && first) sound = 'first';
    else if (fresh.length) {
      if (!env.http) sound = 'file';
      else if (!soundOn()) sound = 'muted';
      else sound = ring(t);
    }
    lastTotal = items.length;
    sync();
    return { total: items.length, fresh: fresh, sound: sound };
  }

  function toggleSound() {
    var on = !soundOn();
    save(SOUND_KEY, on ? 'on' : 'off');
    if (on) unlock(); // the click that turned it on is a user gesture: the context may start now
    sync();
    return on;
  }

  function soundButtonHtml() {
    var on = soundOn();
    return '<button type="button" class="alarm-sound' + (on ? '' : ' is-off') + '" data-alarm-sound aria-pressed="' + (on ? 'true' : 'false') +
      '" title="답 기다림 알람 소리 켜기/끄기">' + soundLabel(on) + '</button>';
  }

  g.BriefAlarm = { update: update, toggleSound: toggleSound, soundOn: soundOn, soundButtonHtml: soundButtonHtml };
})(typeof globalThis !== 'undefined' ? globalThis : this);
