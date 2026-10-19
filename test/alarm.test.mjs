import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitingItems } from '../src/waiting.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/page/alarm.js'), 'utf8');
const ICONS = fs.readFileSync(path.join(ROOT, 'src/page/icons.js'), 'utf8'); // the page's icon helper, as a prelude
// icons.js markup -> [name]: which icon is drawn where
const marks = (html) => html.replace(/<svg class="ic[^"]*" aria-hidden="true" focusable="false"><use href="#i-([a-z0-9-]+)"><\/use><\/svg>/g, '[$1]');
const CSS = fs.readFileSync(path.join(ROOT, 'src/page/alarm.css'), 'utf8');
const T0 = 1_700_000_000_000;
const DAY = 24 * 3600 * 1000;
const HTTP = 'http://127.0.0.1:47390';
const SEEN = 'omo-briefing.seenWaiting';
const SOUND = 'omo-briefing.sound';
const BLOCKED = '소리를 켜려면 화면을 한 번 누르세요';
const BASE_TITLE = 'OMO 상황판';

// ------------------------------------------------------------------ fakes (no wall clock, no real audio, no real DOM)

/** AudioContext stand-in that records every call. `allow` = the page has user activation (resume() can start it). */
function fakeAudio({ state = 'running', allow = true, throws = false } = {}) {
  const log = { created: 0, contexts: [], oscillators: [], gains: [], resumes: 0, allow, lastResume: null };
  const param = () => {
    const p = {
      value: 0, events: [],
      setValueAtTime(v, t) { p.events.push(['set', v, t]); p.value = v; return p; },
      linearRampToValueAtTime(v, t) { p.events.push(['ramp', v, t]); p.value = v; return p; },
    };
    return p;
  };
  function factory() {
    log.created++;
    if (throws) throw new Error('AudioContext is not available');
    const ctx = {
      state, currentTime: 12.5, destination: { name: 'destination' },
      createOscillator() {
        const o = {
          type: '', frequency: param(), targets: [], startAt: null, stopAt: null,
          connect(n) { o.targets.push(n); return n; }, start(t) { o.startAt = t; }, stop(t) { o.stopAt = t; },
        };
        log.oscillators.push(o);
        return o;
      },
      createGain() {
        const g = { gain: param(), targets: [], connect(n) { g.targets.push(n); return n; } };
        log.gains.push(g);
        return g;
      },
      resume() {
        log.resumes++;
        // like Chrome: without user activation the promise stays pending; with it the state flips, then it resolves
        log.lastResume = log.allow ? Promise.resolve().then(() => { ctx.state = 'running'; }) : new Promise(() => {});
        return log.lastResume;
      },
    };
    log.contexts.push(ctx);
    return ctx;
  }
  // one chime = an 880 Hz tone that was started (followed by 1320 Hz, checked separately)
  const chimes = () => log.oscillators.filter((o) => o.frequency.value === 880 && o.startAt !== null).length;
  return { factory, log, chimes };
}

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

function brokenStorage() {
  const boom = () => { throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' }); };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

function makeDoc() {
  const byId = {};
  const listeners = {};
  const soundButtons = [];
  let cards = [];
  function el(tag) {
    let html = '';
    const e = {
      tagName: String(tag).toUpperCase(), id: '', className: '', hidden: false, textContent: '', attrs: {}, children: [], listeners: {},
      classes: new Set(), scrolled: 0,
      classList: {
        add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), contains: (c) => e.classes.has(c),
        toggle: (c, on) => { if (on === undefined ? !e.classes.has(c) : on) e.classes.add(c); else e.classes.delete(c); },
      },
      get offsetHeight() { return e.hidden ? 0 : 32; },
      setAttribute(k, v) { e.attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(e.attrs, k) ? e.attrs[k] : null; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(e.attrs, k); },
      removeAttribute(k) { delete e.attrs[k]; },
      addEventListener(t, f) { (e.listeners[t] ||= []).push(f); },
      appendChild(c) { e.children.push(c); if (c.id) byId[c.id] = c; return c; },
      insertBefore(c, ref) {
        const i = ref ? e.children.indexOf(ref) : -1;
        if (i < 0) e.children.push(c); else e.children.splice(i, 0, c);
        if (c.id) byId[c.id] = c;
        return c;
      },
      get firstChild() { return e.children[0] || null; },
      scrollIntoView() { e.scrolled++; },
    };
    Object.defineProperty(e, 'innerHTML', { get: () => html, set: (v) => { html = String(v); } });
    return e;
  }
  const body = el('body');
  const docEl = { style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } } };
  const doc = {
    title: BASE_TITLE, body, documentElement: docEl,
    createElement: el,
    getElementById: (id) => byId[id] || null,
    querySelectorAll(sel) {
      if (sel === '[data-alarm-sound]') return soundButtons;
      if (sel === '[data-card]') return cards;
      return [];
    },
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
  };
  return {
    doc, body, docEl, byId, listeners, soundButtons, el,
    setCards(c) { cards = c; },
    fire(type, ev) { for (const f of listeners[type] || []) f(ev); },
  };
}

/** A target as the browser would hand it to a click listener: closest() finds `match` for its selector. */
function targetFor(selector, match) {
  return { closest: (sel) => (sel.split(',').some((s) => s.trim() === selector) ? match : null) };
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#96;/g, '`').replace(/&amp;/g, '&');
function rows(html) {
  return [...html.matchAll(/<p class="(alarm-row[^"]*)" data-alarm-key="([^"]*)"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => {
    const text = /<span class="alarm-text"[^>]*>([\s\S]*?)<\/span><span class="alarm-act">/.exec(m[3]);
    return { cls: m[1], key: decode(m[2]), text: text ? decode(marks(text[1]).replace(/<[^>]+>/g, '')) : null, html: m[3] };
  });
}

function makePage({ storage = memStorage(), audio = fakeAudio(), origin = HTTP, liveUrl, extraCtx = {}, globalStorage = false, prelude = '' } = {}) {
  const d = makeDoc();
  const warns = [];
  const errors = [];
  const timers = [];
  let clock = T0;
  const ctx = {
    console: { warn: (...a) => warns.push(a.map(String).join(' ')), error: (...a) => errors.push(a.map(String).join(' ')), log() {} },
    setTimeout: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  };
  Object.assign(ctx, extraCtx);
  vm.createContext(ctx);
  // accessors on the sandbox object do not show through the vm global: browser-like getters are defined inside
  if (prelude) vm.runInContext(prelude, ctx);
  vm.runInContext(SOURCE, ctx, { filename: 'alarm.js' });
  const alarm = ctx.BriefAlarm;
  let calls = 0;
  const p = {
    alarm, ctx, d, audio, storage, warns, errors,
    update(items, over = {}) {
      const opts = { origin, isFirst: calls === 0, audioFactory: audio.factory, doc: d.doc, liveUrl, now: () => clock, ...over };
      if (!globalStorage) opts.storage = storage;
      calls++;
      return JSON.parse(JSON.stringify(alarm.update(items, opts))); // plain copy: the result's arrays belong to the vm realm
    },
    band: () => d.byId['alarm-band'] || null,
    html: () => (p.band() ? p.band().innerHTML : ''),
    rows: () => rows(p.html()),
    advance(ms) {
      clock += ms;
      timers.sort((a, b) => a.at - b.at);
      while (timers.length && timers[0].at <= clock) timers.shift().fn();
    },
  };
  return p;
}

const item = (key, over = {}) => ({ key, sessionId: 'S1', title: '대화 하나', text: `질문 ${key}?`, blocks: false, at: T0, ...over });
const seenKeys = (storage) => Object.keys(JSON.parse(storage.getItem(SEEN))).sort();

// ------------------------------------------------------------------ acceptance

test('classic script loads without a DOM and only defines BriefAlarm', () => {
  const ctx = {};
  vm.runInNewContext(SOURCE, ctx);
  assert.deepEqual(Object.keys(ctx), ['BriefAlarm']);
  for (const fn of ['update', 'toggleSound', 'soundOn', 'soundButtonHtml']) assert.equal(typeof ctx.BriefAlarm[fn], 'function', fn);
});

test('first load: the two items already waiting show in the band and the title, with no sound', () => {
  const p = makePage();
  const r = p.update([item('d1'), item('d2', { at: T0 + 5 })]);
  assert.deepEqual({ total: r.total, sound: r.sound }, { total: 2, sound: 'first' });
  assert.equal(p.audio.chimes(), 0);
  assert.equal(p.audio.log.created, 0, 'no AudioContext is created on a first load');
  assert.equal(p.band().hidden, false, 'band shows what is waiting');
  assert.deepEqual(p.rows().map((x) => x.key), ['d2', 'd1'], 'newest first');
  assert.ok(p.rows().every((x) => !/\bis-new\b/.test(x.cls)), 'nothing flashes on a first load');
  assert.equal(p.d.doc.title, `(2) ${BASE_TITLE}`);
  assert.deepEqual(seenKeys(p.storage), ['d1', 'd2'], 'what was already there counts as seen');
  assert.deepEqual(p.errors, []);
});

test('a new item rings once and the title counts every waiting item; 4 new at once ring once; the same items again stay quiet', () => {
  const p = makePage();
  p.update([item('d1'), item('d2')]);
  const one = p.update([item('d1'), item('d2'), item('d3', { at: T0 + 9 })]);
  assert.deepEqual({ sound: one.sound, fresh: one.fresh }, { sound: 'played', fresh: ['d3'] });
  assert.equal(p.audio.chimes(), 1);
  assert.equal(p.d.doc.title, `(3) ${BASE_TITLE}`);
  assert.equal(p.rows()[0].key, 'd3');
  assert.match(p.rows()[0].cls, /\bis-new\b/);

  const seven = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((k) => item(k));
  const four = p.update(seven);
  assert.deepEqual(four.fresh, ['d4', 'd5', 'd6', 'd7']);
  assert.equal(p.audio.chimes(), 2, 'four new items: one sound');
  assert.equal(p.d.doc.title, `(7) ${BASE_TITLE}`);

  const again = p.update(seven);
  assert.deepEqual({ sound: again.sound, fresh: again.fresh }, { sound: 'none', fresh: [] });
  assert.equal(p.audio.chimes(), 2, 're-received items do not ring');
  assert.equal(p.audio.log.created, 1, 'one AudioContext for the page');
  assert.deepEqual(p.errors, []);
});

test('a newly arrived item is listed first even if it started waiting earlier, so the item that rang is always in the band', () => {
  const p = makePage();
  const old = [item('d1', { at: T0 + 10 }), item('d2', { at: T0 + 20 }), item('d3', { at: T0 + 30 })];
  p.update(old);
  assert.deepEqual(p.rows().map((x) => x.key), ['d3', 'd2', 'd1']);
  p.advance(1000);
  assert.equal(p.update([...old, item('qS1:early', { at: T0 - DAY })]).sound, 'played');
  assert.deepEqual(p.rows().map((x) => x.key), ['qS1:early', 'd3', 'd2'], 'three rows, the new one on top');
  assert.match(p.html(), /data-more="1"/, 'the fourth is counted, not hidden silently');
  p.advance(1000);
  p.update([...old, item('qS1:early', { at: T0 - DAY })]);
  assert.equal(p.rows()[0].key, 'qS1:early', 'order is stable on the next update (no jump)');
  assert.doesNotMatch(p.rows()[0].cls, /\bis-new\b/, 'the flash is over');
});

test('reload with the same storage: an item seen on the previous load does not ring again', () => {
  const storage = memStorage();
  const p1 = makePage({ storage });
  p1.update([item('d1')]);
  p1.update([item('d1'), item('d2')]);
  assert.equal(p1.audio.chimes(), 1);

  const p2 = makePage({ storage });
  assert.equal(p2.update([item('d1')]).sound, 'none', 'already seen on the previous load (and a first load never rings)');
  const back = p2.update([item('d1'), item('d2')]); // d2 was missing on this load's first update, but seen before
  assert.deepEqual({ sound: back.sound, fresh: back.fresh }, { sound: 'none', fresh: [] });
  assert.equal(p2.audio.chimes(), 0);
  assert.equal(p2.update([item('d1'), item('d2'), item('d3')]).sound, 'played', 'a really new item still rings after reload');
  assert.equal(p2.audio.chimes(), 1);
});

test('a question that times out into a decision card is the same item: no second sound', () => {
  const sessions = [{ sid: 'S1', meta: { title: '대화 하나' }, briefs: [] }];
  const asked = {
    sessions, decisions: [], answers: [], closures: [],
    mirror: [{
      sid: 'S1', data: {
        open: true, question: '어느 쪽으로 갈까요?', at: T0,
        requests: [{ requestId: 'toolu_1', at: T0, required: true, questions: [{ id: 'q', header: '', question: '어느 쪽으로 갈까요?', options: [{ label: '가' }, { label: '나' }] }] }],
      },
    }],
  };
  const timedOut = {
    sessions, mirror: [], answers: [], closures: [],
    decisions: [{
      id: 4, sessionId: 'S1', question: '어느 쪽으로 갈까요?', options: { A: { text: '가', consequence: '선택하면 이 안으로 진행' }, B: { text: '나', consequence: '선택하면 이 안으로 진행' } },
      recommend: 'A', reason: '질문 알림 시간 초과로 옮김', blocks: true, createdAt: T0 + 1_800_000, source: 'question-timeout', requestId: 'toolu_1', questionIndex: 0,
    }],
  };
  const p = makePage();
  p.update([]);
  assert.equal(p.update(waitingItems(asked)).sound, 'played');
  const r = p.update(waitingItems(timedOut));
  assert.deepEqual({ sound: r.sound, fresh: r.fresh, total: r.total }, { sound: 'none', fresh: [], total: 1 });
  assert.equal(p.audio.chimes(), 1);
  assert.equal(p.d.doc.title, `(1) ${BASE_TITLE}`);
});

test('C-HOLD: a decision held before it was ever seen never rings, never shows in the band or the title count; reopening it rings', () => {
  const sessions = [{ sid: 'S1', meta: { title: '대화 하나' }, briefs: [] }];
  const dec = (id) => ({ id, sessionId: 'S1', question: `결정 ${id}?`, options: { A: { text: '가' } }, recommend: 'A', reason: 'r', blocks: true, createdAt: T0 + id });
  const snap = (closures) => ({ sessions, mirror: [], answers: [], decisions: [dec(7), dec(8)], closures });
  const p = makePage();
  p.update([]);
  const held = p.update(waitingItems(snap([{ id: 7, reason: 'held', at: T0 }, { id: 8, reason: 'held', at: T0 }])));
  assert.deepEqual({ sound: held.sound, total: held.total, fresh: held.fresh }, { sound: 'none', total: 0, fresh: [] });
  assert.equal(p.audio.chimes(), 0, 'a held decision never rings the alarm');
  assert.deepEqual(p.rows(), []);
  assert.equal(p.d.doc.title, BASE_TITLE, 'no title count for held decisions');
  const reopened = p.update(waitingItems(snap([{ id: 8, reason: 'held', at: T0 }])));
  assert.deepEqual({ sound: reopened.sound, total: reopened.total, fresh: reopened.fresh }, { sound: 'played', total: 1, fresh: ['d7'] });
  assert.deepEqual(p.rows().map((x) => x.key), ['d7']);
});

test('🔕 silences new items but keeps the band; the choice is stored and survives a reload; 🔔 turns it back on', () => {
  const p = makePage();
  p.update([item('d1')]);
  assert.equal(p.alarm.soundOn(), true, 'sound is on by default');
  assert.equal(p.alarm.toggleSound(), false);
  assert.equal(p.storage.getItem(SOUND), 'off');
  p.advance(1000);
  const muted = p.update([item('d1'), item('d2')]);
  assert.equal(muted.sound, 'muted');
  assert.equal(p.audio.chimes(), 0);
  assert.equal(p.band().hidden, false);
  assert.deepEqual(p.rows().map((x) => x.key), ['d2', 'd1'], 'band shows the new item');

  const p2 = makePage({ storage: p.storage });
  p2.update([item('d1')]);
  assert.equal(p2.alarm.soundOn(), false);
  assert.equal(p2.update([item('d1'), item('d3')]).sound, 'muted');
  assert.equal(p2.audio.chimes(), 0);

  assert.equal(p.alarm.toggleSound(), true);
  assert.equal(p.storage.getItem(SOUND), 'on');
  assert.equal(p.update([item('d1'), item('d2'), item('d4')]).sound, 'played');
  assert.equal(p.audio.chimes(), 1);
});

test('file:// page: a new item shows the band and a live-view link, never a sound', () => {
  const p = makePage({ origin: 'file://', liveUrl: `${HTTP}/` });
  p.update([]);
  const r = p.update([item('d1')]);
  assert.equal(r.sound, 'file');
  assert.equal(p.audio.chimes(), 0);
  assert.equal(p.audio.log.created, 0);
  assert.equal(p.band().hidden, false);
  assert.match(p.html(), /<a class="alarm-live" href="http:\/\/127\.0\.0\.1:47390\/">실시간 보기 열기<\/a>/);

  for (const [origin, liveUrl] of [['null', 'http://evil.example/'], ['file', undefined], ['file://', 'javascript:alert(1)']]) {
    const q = makePage({ origin, liveUrl });
    q.update([]);
    assert.equal(q.update([item('d1')]).sound, 'file', origin);
    assert.doesNotMatch(q.html(), /alarm-live/, `no link for ${liveUrl}`);
    assert.equal(q.audio.chimes(), 0);
  }
  const h = makePage({ liveUrl: `${HTTP}/` });
  h.update([]);
  h.update([item('d1')]);
  assert.doesNotMatch(h.html(), /alarm-live/, 'the live page itself needs no link');
});

test('answered items leave the band and the title count goes down; nothing waiting hides the band', () => {
  const p = makePage();
  p.update([item('d1'), item('d2'), item('d3')]);
  assert.equal(p.d.doc.title, `(3) ${BASE_TITLE}`);
  assert.equal(p.d.docEl.style.props['--alarm-h'], '32px', 'sticky layout knows the band height');
  p.update([item('d1'), item('d3')]);
  assert.deepEqual(p.rows().map((x) => x.key).sort(), ['d1', 'd3']);
  assert.equal(p.d.doc.title, `(2) ${BASE_TITLE}`);
  p.update([]);
  assert.equal(p.band().hidden, true);
  assert.equal(p.rows().length, 0);
  assert.equal(p.d.doc.title, BASE_TITLE);
  assert.equal(p.d.docEl.style.props['--alarm-h'], undefined);
});

test('the band text wraps, so its height follows the band box: a ResizeObserver republishes --alarm-h without a window resize', () => {
  const observers = [];
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
    observe(el) { this.targets.push(el); }
    disconnect() { this.targets = []; }
  }
  const p = makePage({ extraCtx: { ResizeObserver: FakeResizeObserver } });
  p.update([item('d1'), item('d2')]);
  assert.equal(p.d.docEl.style.props['--alarm-h'], '32px');
  const band = p.band();
  const ro = observers.find((o) => o.targets.includes(band));
  assert.ok(ro, 'the band box is observed');
  let h = 70; // the column narrowed (sidebar docked): the row text takes more lines
  Object.defineProperty(band, 'offsetHeight', { get: () => (band.hidden ? 0 : h), configurable: true });
  ro.cb([{ target: band }]);
  assert.equal(p.d.docEl.style.props['--alarm-h'], '70px');
  h = 32;
  ro.cb([{ target: band }]);
  assert.equal(p.d.docEl.style.props['--alarm-h'], '32px');
  p.update([]);
  ro.cb([{ target: band }]);
  assert.equal(p.d.docEl.style.props['--alarm-h'], undefined, 'a hidden band publishes no height');
  assert.equal(observers.length, 1, 'one observer for the one band');
  assert.deepEqual(p.errors, []);
});

test('blocked audio: the band asks for one click; the click resumes the context; a sound owed long ago is not played late', async () => {
  const audio = fakeAudio({ state: 'suspended', allow: false });
  const p = makePage({ audio });
  p.update([]);
  const r = p.update([item('d1')]);
  assert.equal(r.sound, 'blocked');
  assert.equal(audio.chimes(), 0);
  assert.equal(audio.log.resumes, 1, 'tried to start it right away');
  assert.ok(p.html().includes(BLOCKED), 'band says one click turns the sound on');

  p.advance(5000);
  audio.log.allow = true; // a real click gives the page user activation
  p.d.fire('click', { target: p.d.body });
  assert.equal(audio.log.resumes, 2, 'the click resumed the context');
  await audio.log.lastResume;
  assert.equal(audio.log.contexts[0].state, 'running');
  assert.ok(!p.html().includes(BLOCKED), 'notice gone once it runs');
  assert.equal(audio.chimes(), 0, 'the 5 s old alarm is not played on the click');

  assert.equal(p.update([item('d1'), item('d2')]).sound, 'played');
  assert.equal(audio.chimes(), 1, 'later alarms ring');
  p.d.fire('keydown', { target: p.d.body });
  assert.equal(audio.log.resumes, 2, 'a running context is not resumed again');
  assert.deepEqual(p.errors, []);
});

test('a context that starts suspended but may run (autoplay allowed) rings for that same update', async () => {
  const audio = fakeAudio({ state: 'suspended', allow: true });
  const p = makePage({ audio });
  p.update([]);
  assert.equal(p.update([item('d1')]).sound, 'blocked');
  await audio.log.lastResume;
  assert.equal(audio.chimes(), 1, 'played as soon as the context ran');
  assert.ok(!p.html().includes(BLOCKED));
});

test('a first click or key on the page prepares the sound before any alarm (created inside the gesture)', async () => {
  const audio = fakeAudio({ state: 'suspended', allow: true });
  const p = makePage({ audio });
  p.update([item('d1')]);
  assert.equal(audio.log.created, 0);
  p.d.fire('keydown', { target: p.d.body });
  assert.equal(audio.log.created, 1);
  await audio.log.lastResume;
  assert.equal(audio.chimes(), 0, 'preparing does not ring');
  assert.equal(p.update([item('d1'), item('d2')]).sound, 'played');
  assert.equal(audio.chimes(), 1);
  assert.ok(!p.html().includes(BLOCKED));
});

test('localStorage that throws: memory fallback with a single console.warn, and the alarm keeps working', () => {
  const p = makePage({ storage: brokenStorage() });
  p.update([item('d1')]);
  assert.equal(p.update([item('d1'), item('d2')]).sound, 'played');
  assert.equal(p.update([item('d1'), item('d2')]).sound, 'none', 'seen items are remembered in memory');
  assert.equal(p.alarm.toggleSound(), false, 'toggle works without storage');
  assert.equal(p.update([item('d1'), item('d2'), item('d3')]).sound, 'muted');
  assert.equal(p.audio.chimes(), 1);
  assert.equal(p.warns.length, 1, 'warned once');
  assert.match(p.warns[0], /omo-briefing/);
  assert.deepEqual(p.errors, []);

  // window.localStorage itself throws on access (blocked storage): same fallback
  const g = makePage({
    globalStorage: true,
    prelude: 'Object.defineProperty(globalThis, "localStorage", { get() { throw new Error("SecurityError: access denied"); }, configurable: true });',
  });
  g.update([item('d1')]);
  assert.equal(g.update([item('d1'), item('d2')]).sound, 'played');
  assert.equal(g.warns.length, 1);

  // a stored value that is not valid JSON: warned once, treated as empty, rewritten
  const bad = memStorage({ [SEEN]: '{nope' });
  const b = makePage({ storage: bad });
  b.update([item('d1')]);
  assert.deepEqual(seenKeys(bad), ['d1']);
  assert.equal(b.warns.length, 1);
});

test('B1 regression: a saved 🔕 survives storage that reads but cannot write (QuotaExceededError); later toggles work in memory', () => {
  // exact reproduction from EV/task-12-verify.md (B1), with this file's SOURCE instead of a cwd-relative read
  const scope = { console: { warn() {} } };
  vm.runInNewContext(SOURCE, scope);
  const values = new Map([['omo-briefing.sound', 'off']]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem() { throw new Error('QuotaExceededError: full'); },
  };
  let starts = 0;
  const param = () => ({ setValueAtTime() {}, linearRampToValueAtTime() {} });
  const audioFactory = () => ({
    state: 'running', currentTime: 0, destination: {},
    createOscillator: () => ({
      frequency: param(), connect() {}, start() { starts++; }, stop() {},
    }),
    createGain: () => ({ gain: param(), connect() {} }),
  });
  const opts = { origin: 'http', storage, audioFactory };
  const item = (key) => ({ key, sessionId: 'S1', text: 'Choose?' });
  const alarm = scope.BriefAlarm;
  alarm.update([item('d1')], opts);
  const effectiveSoundOn = alarm.soundOn();
  const result = alarm.update([item('d1'), item('d2')], opts);
  assert.deepEqual({ stored: values.get('omo-briefing.sound'), effectiveSoundOn, sound: result.sound, starts },
    { stored: 'off', effectiveSoundOn: false, sound: 'muted', starts: 0 });

  // writes keep failing: the owner's toggles still take effect for this page, in memory
  assert.equal(alarm.toggleSound(), true);
  assert.equal(alarm.soundOn(), true);
  assert.equal(values.get('omo-briefing.sound'), 'off', 'storage itself could not be changed');
  assert.equal(alarm.update([item('d1'), item('d2'), item('d3')], opts).sound, 'played');
  assert.equal(starts, 2, 'one two-tone chime');
  assert.equal(alarm.update([item('d1'), item('d2'), item('d3')], opts).sound, 'none', 'seen keys kept in memory');
  assert.equal(alarm.toggleSound(), false);
  assert.equal(alarm.update([item('d1'), item('d2'), item('d3'), item('d4')], opts).sound, 'muted');
  assert.equal(starts, 2);
});

test('band text is exact: 답 기다림: <대화> · <문구 40자>, and model text is escaped', () => {
  const long = '가나다라마바사아자차카타파하'.repeat(4); // 56 code points
  const p = makePage();
  p.update([item('d1', { title: '<b>대화</b>', text: long, blocks: true })]);
  const [row] = p.rows();
  assert.equal(row.text, `답 기다림: <b>대화</b> · ${[...long].slice(0, 39).join('')}…`);
  assert.ok(!p.html().includes('<b>대화</b>'), 'escaped');
  assert.match(row.html, /class="alarm-tag">막는 결정</);
  assert.match(row.html, /data-alarm-goto="S1"/);

  p.update([item('d1', { text: 'x'.repeat(40) }), item('d2', { title: '', sessionId: 'S9', text: '😀'.repeat(41), at: T0 - 1 })]);
  const texts = Object.fromEntries(p.rows().map((x) => [x.key, x.text]));
  assert.deepEqual(texts, { d1: `답 기다림: 대화 하나 · ${'x'.repeat(40)}`, d2: `답 기다림: S9 · ${'😀'.repeat(39)}…` }, '40 is kept, code points not UTF-16 units');
});

test('band names the herdr tab: <tab icon> <label> #<n> · <title>, else 창 <pane> · <title>, escaped in text and tooltip', () => {
  const p = makePage({ prelude: ICONS });
  p.update([
    item('d1', { title: '작업', tabLabel: '수리', tabNumber: 181, paneId: 'w1:pR2', at: T0 + 3 }),
    item('d2', { title: '작업', tabLabel: '', tabNumber: null, paneId: 'w1:pR2', at: T0 + 2 }),
    item('d3', { title: '<b>대화</b>', tabLabel: '<i>수리</i>', tabNumber: 9, at: T0 + 1 }),
  ]);
  const byKey = Object.fromEntries(p.rows().map((r) => [r.key, r]));
  assert.equal(byKey.d1.text, '답 기다림: [app-window] 수리 #181 · 작업 · 질문 d1?');
  assert.equal(byKey.d2.text, '답 기다림: 창 w1:pR2 · 작업 · 질문 d2?');
  assert.equal(byKey.d3.text, '답 기다림: [app-window] <i>수리</i> #9 · <b>대화</b> · 질문 d3?');
  // the tooltip is text: the label without its icon
  const tip = (r) => decode(/class="alarm-text" title="([^"]*)"/.exec(r.html)[1]);
  assert.equal(tip(byKey.d1), '답 기다림: 수리 #181 · 작업 · 질문 d1?');
  assert.equal(tip(byKey.d2), '답 기다림: 창 w1:pR2 · 작업 · 질문 d2?');
  assert.equal(tip(byKey.d3), '답 기다림: <i>수리</i> #9 · <b>대화</b> · 질문 d3?');
  assert.ok(!p.html().includes('<i>') && !p.html().includes('<b>대화'), 'escaped');
});

test('the chime is 880 Hz then 1320 Hz, 120 ms each, peak gain 0.15, made in WebAudio (no sound file)', () => {
  const p = makePage();
  p.update([]);
  p.update([item('d1')]);
  const [a, b] = p.audio.log.oscillators;
  assert.equal(p.audio.log.oscillators.length, 2);
  assert.deepEqual([a.frequency.value, b.frequency.value], [880, 1320]);
  const near = (x, y) => Math.abs(x - y) < 1e-9;
  assert.ok(near(a.startAt, 12.5) && near(a.stopAt, 12.62), `880 Hz ${a.startAt}-${a.stopAt}`);
  assert.ok(near(b.startAt, 12.62) && near(b.stopAt, 12.74), `1320 Hz ${b.startAt}-${b.stopAt}`);
  const peaks = p.audio.log.gains.map((g) => Math.max(...g.gain.events.map((e) => e[1])));
  assert.deepEqual(peaks, [0.15, 0.15]);
  assert.ok(p.audio.log.gains.every((g) => g.gain.events.at(-1)[1] === 0), 'each tone fades to silence');
  assert.ok(a.targets[0] === p.audio.log.gains[0] && p.audio.log.gains[0].targets[0] === p.audio.log.contexts[0].destination);
  assert.doesNotMatch(SOURCE, /new Audio\(|\.(mp3|wav|ogg)\b/, 'no audio file');
});

test('[보기] opens the conversation 결정 sub-tab, including when its card is not shown', () => {
  const card = { scrolled: 0, classList: { add() {}, remove() {} }, getAttribute: (k) => (k === 'data-card' ? 'S2' : null), scrollIntoView() { card.scrolled++; } };
  const go = { getAttribute: (k) => (k === 'data-alarm-goto' ? 'S2' : null), hasAttribute: (k) => k === 'data-alarm-goto' };
  const p = makePage();
  p.update([item('d1', { sessionId: 'S2' })]);
  p.d.setCards([card]);
  const click = (q) => { for (const f of q.band().listeners.click) f({ target: targetFor('[data-alarm-goto]', go), preventDefault() {} }); };
  click(p);
  assert.equal(card.scrolled, 1);

  const opened = [];
  const q = makePage({ extraCtx: { BriefPage: { open(sid, sub) { opened.push([sid, sub]); } } } });
  q.update([item('d1', { sessionId: 'S2' })]);
  click(q);
  assert.deepEqual(opened, [['S2', 'dec']]);
  assert.equal(card.scrolled, 1, 'opening a page does not cycle old filters or scroll a stale card');
  assert.deepEqual(q.errors, []);
});

test('header sound button: soundButtonHtml shows the state with its bell, a click on [data-alarm-sound] toggles and relabels it in place', () => {
  const p = makePage({ prelude: ICONS });
  p.update([]);
  const html = p.alarm.soundButtonHtml();
  assert.match(marks(html), /^<button type="button" class="alarm-sound" data-alarm-sound aria-pressed="true"[^>]*>\[bell\] 소리 켜짐<\/button>$/);
  const btn = p.d.el('button');
  btn.setAttribute('data-alarm-sound', '');
  p.d.soundButtons.push(btn);
  p.d.fire('click', { target: targetFor('[data-alarm-sound]', btn) });
  assert.equal(p.storage.getItem(SOUND), 'off');
  assert.equal(marks(btn.innerHTML), '[bell-off] 꺼짐');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.match(marks(p.alarm.soundButtonHtml()), /aria-pressed="false"[^>]*>\[bell-off\] 꺼짐</);
  p.d.fire('click', { target: targetFor('[data-alarm-sound]', btn) });
  assert.equal(marks(btn.innerHTML), '[bell] 소리 켜짐');
  assert.equal(p.storage.getItem(SOUND), 'on');
});

test('the title prefix is replaced, never stacked, and keeps a title someone else set', () => {
  const p = makePage();
  p.update([item('d1'), item('d2')]);
  p.update([item('d1'), item('d2'), item('d3')]);
  assert.equal(p.d.doc.title, `(3) ${BASE_TITLE}`);
  p.d.doc.title = '다른 제목';
  p.update([item('d1')]);
  assert.equal(p.d.doc.title, '(1) 다른 제목');
});

test('seen keys: old ones no longer waiting are pruned, recent ones are kept so a returning item stays quiet, size is capped', () => {
  const storage = memStorage({ [SEEN]: JSON.stringify({ old: T0 - 31 * DAY, recent: T0 - DAY }) });
  const p = makePage({ storage });
  p.update([item('cur')]);
  assert.deepEqual(seenKeys(storage), ['cur', 'recent']);
  assert.equal(p.update([item('cur'), item('recent')]).sound, 'none');
  assert.equal(p.update([item('cur'), item('recent'), item('old')]).sound, 'played');

  const many = {};
  for (let i = 0; i < 700; i++) many[`k${i}`] = T0 - i * 1000;
  const big = memStorage({ [SEEN]: JSON.stringify(many) });
  makePage({ storage: big }).update([item('k699')]);
  const kept = seenKeys(big);
  assert.equal(kept.length, 500);
  assert.ok(kept.includes('k699'), 'a waiting key is never dropped');
  assert.ok(kept.includes('k0') && !kept.includes('k698'), 'the oldest go first');
});

test('isFirst defaults to the first update of the page', () => {
  const p = makePage();
  const opts = { origin: HTTP, storage: p.storage, audioFactory: p.audio.factory, doc: p.d.doc, now: () => T0 };
  assert.equal(p.alarm.update([item('d1')], opts).sound, 'first');
  assert.equal(p.alarm.update([item('d1'), item('d2')], opts).sound, 'played');
});

test('no WebAudio: the band still works, one warning, no errors', () => {
  const p = makePage({ audio: fakeAudio({ throws: true }) });
  p.update([]);
  assert.equal(p.update([item('d1')]).sound, 'unavailable');
  assert.equal(p.update([item('d1'), item('d2')]).sound, 'unavailable');
  assert.equal(p.audio.log.created, 1, 'not retried on every update');
  assert.equal(p.band().hidden, false);
  assert.equal(p.warns.length, 1);
  assert.deepEqual(p.errors, []);
});

test('band placement: after the live status, before the live link and the board', () => {
  const d = makePage();
  for (const [tag, id] of [['div', 'live-status'], ['a', 'live-link'], ['div', 'app']]) {
    const e = d.d.el(tag);
    e.id = id;
    d.d.body.appendChild(e);
  }
  d.update([item('d1')]);
  const ids = d.d.body.children.map((c) => c.id);
  assert.deepEqual(ids, ['live-status', 'alarm-band', 'live-link', 'app']);
  assert.equal(d.band().getAttribute('role'), 'region');
});

test('alarm.css uses the page tokens only and turns the flash off for reduced motion', () => {
  assert.doesNotMatch(CSS, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'colors come from page.css variables');
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.alarm-row\.is-new\s*\{[^}]*animation:\s*none/);
  assert.match(CSS, /\.alarm-band\[hidden\]\s*\{\s*display:\s*none/);
});

test('alarm.css wraps the row text instead of clipping it: no nowrap, hidden overflow or ellipsis on .alarm-text', () => {
  const rule = /\.alarm-text\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(rule, '.alarm-text rule');
  assert.doesNotMatch(rule[1], /white-space:\s*nowrap|overflow:\s*hidden|text-overflow/);
  assert.match(rule[1], /min-width:\s*0/);
  assert.match(rule[1], /overflow-wrap:\s*anywhere/);
  const p = makePage();
  p.update([item('d1', { title: 'W'.repeat(120) })]);
  assert.match(p.html(), /<p class="alarm-row" data-alarm-key="d1"><span class="alarm-text" title="[^"]+">답 기다림: <b class="alarm-who">W{120}<\/b>/, 'the rule dresses the row text');
});
