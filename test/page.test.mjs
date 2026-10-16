import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_SRC = fs.readFileSync(path.join(ROOT, 'src/page/page.js'), 'utf8');
const VIEW_SRC = fs.readFileSync(path.join(ROOT, 'src/page/view.js'), 'utf8');

// Small fake browser. Time and timers are fully manual: nothing here waits on the wall clock.
function makeEnv({ protocol = 'file:', throwingView = false, realView = false } = {}) {
  const byId = {};
  const docListeners = {};
  const winListeners = {};
  const timers = [];
  const intervals = [];
  const fetches = [];
  const sources = [];
  const errors = [];
  const rendered = [];
  let cards = [];
  let clock = 1000;

  function el(tag) {
    let html = '';
    const e = {
      tagName: tag, id: '', hidden: false, textContent: '', listeners: {}, attrs: {}, children: [],
      classes: new Set(),
      classList: { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), toggle() {} },
      addEventListener(t, f) { e.listeners[t] = f; },
      get firstChild() { return e.children[0] || null; },
      appendChild(c) { if (c.id) byId[c.id] = c; e.children.push(c); return c; },
      insertBefore(c, before) {
        const index = e.children.indexOf(before);
        assert.notEqual(index, -1, 'insertBefore reference belongs to parent');
        if (c.id) byId[c.id] = c;
        e.children.splice(index, 0, c);
        return c;
      },
      setAttribute(k, v) { e.attrs[k] = v; },
      getAttribute(k) { return e.attrs[k] ?? null; },
      getBoundingClientRect() { return { top: 0, bottom: 100 }; },
      querySelector(sel) {
        if (sel !== '.app') return null;
        const m = /data-tab="([^"]*)"/.exec(e.innerHTML);
        return m ? { getAttribute: () => m[1] } : null;
      },
      querySelectorAll(sel) { return sel === '[data-card]' || sel === 'article.card' ? cards : []; },
      contains() { return true; }, remove() {},
    };
    Object.defineProperty(e, 'innerHTML', {
      get: () => html,
      set(value) {
        html = value;
        if (realView && e.id === 'app') {
          for (const card of cards) delete byId[card.id];
          cards = Array.from(value.matchAll(/<article\s+([^>]+)>/g), (match) => {
            const card = el('ARTICLE');
            for (const [, key, val] of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) card.setAttribute(key, val);
            card.id = card.getAttribute('id');
            card.classes = new Set(card.getAttribute('class').split(/\s+/));
            byId[card.id] = card;
            return card;
          });
        }
      },
    });
    return e;
  }
  const body = el('body');
  const head = el('head');
  head.appendChild = (c) => c;
  const document = {
    readyState: 'complete', visibilityState: 'visible', body, head, documentElement: { scrollHeight: 0 },
    activeElement: null,
    getElementById: (id) => byId[id] || null, createElement: el,
    addEventListener(t, f) { (docListeners[t] ||= []).push(f); },
  };
  let selection = { isCollapsed: true, toString: () => '' };
  class FakeEventSource {
    constructor(url) { this.url = url; this.handlers = {}; sources.push(this); }
    addEventListener(t, f) { this.handlers[t] = f; }
  }
  const scrolls = [];
  const ctx = {
    document, scrollY: 0, innerHeight: 900,
    scrollTo(x, y) { scrolls.push(y); ctx.scrollY = y; },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
    setTimeout(fn, ms) { const t = { fn, ms, at: clock + ms }; timers.push(t); return t; },
    clearTimeout(t) { const index = timers.indexOf(t); if (index !== -1) timers.splice(index, 1); },
    addEventListener(t, f) { (winListeners[t] ||= []).push(f); },
    getSelection: () => selection,
    console: { error: (...a) => errors.push(a) },
    BriefView: {
      escapeHtml: (s) => String(s),
      renderApp(model) {
        if (throwingView) throw new Error('boom');
        rendered.push(model.seq);
        return `<div class="app" data-tab="run">seq ${model.seq}</div>`;
      },
    },
    location: { protocol },
  };
  if (protocol.startsWith('http')) {
    ctx.fetch = (url, opts) => { fetches.push({ url, opts }); return new Promise(() => {}); };
    ctx.EventSource = FakeEventSource;
  }
  if (realView) vm.runInNewContext(VIEW_SRC, ctx, { filename: 'view.js' });
  vm.runInNewContext(PAGE_SRC, ctx, { filename: 'page.js' });
  const page = ctx.BriefPage;
  page.state.now = () => clock;
  return {
    page, ctx, byId, timers, intervals, fetches, sources, errors, rendered, scrolls, document,
    badge: byId['new-badge'], status: byId['live-status'], link: byId['live-link'],
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > until) break;
        const t = timers.shift();
        clock = t.at;
        t.fn();
      }
      clock = until;
    },
    setCards(c) { cards = c; },
    setSelection(text) { selection = { isCollapsed: !text, toString: () => text }; },
    fireDoc(t) { (docListeners[t] || []).forEach((f) => f({ target: body })); },
  };
}
const data = (seq, extra = {}) => ({ seq, generatedAt: 0, sessions: [], ...extra });

test('http origin: one /data.json fetch + EventSource, no polling interval', () => {
  const e = makeEnv({ protocol: 'http:' });
  assert.equal(e.page.transport(), 'http');
  assert.equal(e.fetches.length, 1);
  assert.equal(e.fetches[0].url, '/data.json');
  assert.equal(e.sources.length, 1);
  assert.equal(e.sources[0].url, '/events');
  assert.equal(e.intervals.length, 0, 'no http-side polling');
});

test('file origin: no fetch, no EventSource; data.js injected every 2 s', () => {
  const e = makeEnv({ protocol: 'file:' });
  assert.equal(e.page.transport(), 'file');
  assert.equal(e.fetches.length, 0);
  assert.equal(e.sources.length, 0);
  assert.deepEqual(e.intervals.map((i) => i.ms), [2000]);
});

test('larger seq applies, stale seq is ignored, and only changed real-view cards glow for 900 ms', () => {
  const e = makeEnv();
  e.page.receive(data(5));
  assert.deepEqual(e.rendered.slice(-1), [5]);
  assert.equal(e.page.state.appliedAt, 1000);
  e.advance(600);
  e.page.receive(data(6));
  assert.equal(e.page.state.seq, 6);
  assert.equal(e.page.state.appliedAt, 1600);
  const n = e.rendered.length;
  e.advance(600);
  e.page.receive(data(6));
  e.page.receive(data(2));
  assert.equal(e.rendered.length, n, 'stale/duplicate seq did not render');
  assert.equal(e.page.state.seq, 6);

  const v = makeEnv({ realView: true });
  const alpha = { id: 'alpha', status: 'in_progress', headline: 'before' };
  const beta = { id: 'beta', status: 'in_progress', headline: 'unchanged' };
  v.page.receive(data(1, { sessions: [alpha, beta] }));
  assert.equal(v.byId['c-alpha-0'].classes.has('flash'), false, 'no glow on first load');
  v.advance(500);
  v.page.receive(data(2, { sessions: [{ ...alpha, headline: 'after' }, { ...beta }] }));
  const changed = v.byId['c-alpha-0'];
  assert.ok(changed, 'actual renderer assigns a DOM id distinct from the session id');
  assert.equal(v.byId.alpha, undefined);
  assert.equal(changed.classes.has('flash'), true, 'changed session found through data-card');
  assert.equal(v.byId['c-beta-1'].classes.has('flash'), false, 'equal session JSON does not glow');
  v.advance(899);
  assert.equal(changed.classes.has('flash'), true);
  v.advance(1);
  assert.equal(changed.classes.has('flash'), false, 'glow expires at 900 ms');
  v.page.receive(data(3, { sessions: [{ ...alpha, headline: 'after' }, { ...beta }] }));
  assert.equal(v.byId['c-alpha-0'].classes.has('flash'), false, 'seq-only change does not glow');
  assert.deepEqual(v.errors, []);
});

test('a changed card keeps its glow through a later ordinary apply until its own 900 ms expiry', () => {
  const v = makeEnv({ realView: true });
  const alpha = { id: 'alpha', status: 'in_progress', headline: 'before' };
  const beta = { id: 'beta', status: 'in_progress', headline: 'before' };
  v.page.receive(data(1, { sessions: [alpha, beta] }));
  v.advance(500);
  v.page.receive(data(2, { sessions: [{ ...alpha, headline: 'after' }, beta] }));
  assert.equal(v.byId['c-alpha-0'].classes.has('flash'), true);
  v.advance(500);
  v.page.receive(data(3, { sessions: [{ ...alpha, headline: 'after' }, { ...beta, headline: 'after' }] }));
  assert.equal(v.byId['c-alpha-0'].classes.has('flash'), true, 'alpha glow survives the re-render caused by beta');
  assert.equal(v.byId['c-beta-1'].classes.has('flash'), true);
  v.advance(399);
  assert.equal(v.byId['c-alpha-0'].classes.has('flash'), true, 'alpha still inside its own 900 ms');
  v.advance(1);
  assert.equal(v.byId['c-alpha-0'].classes.has('flash'), false, 'alpha expires 900 ms after its own change');
  assert.equal(v.byId['c-beta-1'].classes.has('flash'), true, 'beta keeps its own window');
  v.advance(500);
  assert.equal(v.byId['c-beta-1'].classes.has('flash'), false);
  assert.deepEqual(v.errors, []);
});

test('Windows taskkill teardown is bounded by a finite timeout (no real process)', async () => {
  const { killProcessTree } = await import('../scripts/cdp.mjs');
  const calls = [];
  killProcessTree(4321, { platform: 'win32', run: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return {}; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'taskkill');
  assert.deepEqual(calls[0].args, ['/PID', '4321', '/T', '/F']);
  assert.ok(Number.isFinite(calls[0].opts.timeout) && calls[0].opts.timeout > 0, 'timeout is finite');
  assert.equal(calls[0].opts.killSignal, 'SIGKILL');
  calls.length = 0;
  killProcessTree(4321, { platform: 'linux', run: () => { calls.push(1); return {}; } });
  assert.equal(calls.length, 0, 'taskkill only on win32');
});

test('updates inside 500 ms collapse into one apply of the latest', () => {
  const e = makeEnv();
  e.page.receive(data(1));
  e.advance(600);
  e.page.receive(data(2)); // applies at once
  const before = e.rendered.length;
  e.advance(100);
  e.page.receive(data(3));
  e.page.receive(data(5));
  e.page.receive(data(4)); // older than the held 5: ignored
  assert.equal(e.rendered.length, before, 'held back inside the window');
  assert.equal(e.timers.filter((t) => t.ms === 400).length, 1, 'one timer for the remaining 400 ms');
  e.advance(399);
  assert.equal(e.page.state.seq, 2, 'no early apply');
  e.advance(1);
  assert.equal(e.rendered.length, before + 1, 'exactly one render');
  assert.equal(e.rendered.at(-1), 5, 'latest seq wins');
  assert.equal(e.page.state.pending, null);
});

test('selection holds updates and releases within 300 ms even inside the preceding apply window', () => {
  for (const pendingBeforeBusy of [false, true]) {
    const e = makeEnv();
    e.page.receive(data(1));
    e.advance(50);
    if (pendingBeforeBusy) e.page.receive(data(2));
    e.advance(50);
    e.setSelection('some words');
    assert.equal(e.page.busy(), true);
    e.page.receive(data(3));
    assert.equal(e.page.state.seq, 1, 'held while selecting');
    assert.equal(e.badge.hidden, false);
    assert.match(e.badge.textContent, /새 내용/);
    e.fireDoc('selectionchange');
    e.advance(100);
    assert.equal(e.page.state.seq, 1, 'release callback rechecks ongoing selection');
    e.setSelection('');
    e.fireDoc('selectionchange');
    e.advance(99);
    assert.equal(e.page.state.seq, 1);
    e.advance(1);
    assert.equal(e.page.state.seq, 3, 'busy release bypasses the normal throttle');
    assert.equal(e.page.state.appliedAt, 1300);
    assert.equal(e.badge.hidden, true);
    e.page.receive(data(4));
    e.advance(499);
    assert.equal(e.page.state.seq, 3, 'normal throttle resumes; prior apply timer was cancelled');
    e.advance(1);
    assert.equal(e.page.state.seq, 4);
    assert.deepEqual(e.errors, []);
  }
});

test('input, textarea, contenteditable and pointer holds release within 300 ms of early release', () => {
  for (const active of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }, null]) {
    const e = makeEnv();
    e.page.receive(data(1));
    e.advance(100);
    if (active) e.document.activeElement = active;
    else e.fireDoc('pointerdown');
    assert.equal(e.page.busy(), true);
    e.page.receive(data(2));
    assert.equal(e.page.state.seq, 1);
    e.document.activeElement = null;
    e.fireDoc(active ? 'focusout' : 'pointerup');
    e.advance(99);
    assert.equal(e.page.state.seq, 1);
    e.advance(1);
    assert.equal(e.page.state.seq, 2, 'applied at release +100, not previous apply +500');
    assert.equal(e.page.state.appliedAt, 1200);
    assert.equal(e.badge.hidden, true);
    assert.deepEqual(e.errors, []);
  }
});

test('SSE pause survives connection errors and clears only on a resumed open or data event', () => {
  const e = makeEnv({ protocol: 'http:' });
  const es = e.sources[0];
  es.onerror();
  assert.equal(e.status.hidden, false);
  assert.match(e.status.textContent, /실시간 연결 끊김/);
  es.onopen();
  assert.equal(e.status.hidden, true);
  es.handlers.paused({});
  es.onerror();
  es.onerror();
  assert.equal(e.status.hidden, false);
  assert.equal(e.status.textContent, '브리핑 꺼짐 - /brief on 으로 켜기');
  es.onopen();
  assert.equal(e.status.hidden, true, 'reopened stream clears paused state');
  es.onerror();
  assert.match(e.status.textContent, /실시간 연결 끊김/, 'ordinary errors work after resume');
  es.handlers.paused({});
  es.onerror();
  es.handlers.data({ data: JSON.stringify(data(7)) });
  assert.equal(e.status.hidden, true, 'data clears the banner');
  assert.equal(e.page.state.seq, 7);
  es.onerror();
  assert.match(e.status.textContent, /실시간 연결 끊김/, 'data also clears the pause latch');
});

test('a malformed SSE payload is reported, not swallowed', () => {
  const e = makeEnv({ protocol: 'http:' });
  e.sources[0].handlers.data({ data: '{nope' });
  assert.ok(e.errors.length >= 1, 'console.error called');
  assert.equal(e.byId['page-error'].hidden, false);
  assert.equal(e.byId['page-error'].textContent, '화면 오류');
});

test('a throwing view is reported on console and on screen', () => {
  const e = makeEnv({ throwingView: true });
  e.page.receive(data(1));
  assert.ok(e.errors.length >= 1);
  assert.equal(e.byId['page-error'].textContent, '화면 오류');
  assert.match(e.byId.app.innerHTML, /fatal/);
});

test('scroll anchor: the first card visible at the top keeps its on-screen position', () => {
  const e = makeEnv();
  const card = (id, top, bottom) => ({
    getAttribute: () => id,
    getBoundingClientRect: () => ({ top: card.tops[id] ?? top, bottom }),
  });
  card.tops = {};
  const a = card('A', -300, -10); // scrolled past
  const b = card('B', 40, 400); // first visible
  e.setCards([a, b, card('C', 400, 800)]);
  e.ctx.scrollY = 1000;
  e.page.receive(data(1)); // first model: renders and restores
  const anchor = e.page.captureAnchor();
  assert.deepEqual({ id: anchor.id, top: anchor.top }, { id: 'B', top: 40 });
  // the card above grew: B is now 250 px lower on screen after re-render
  card.tops.B = 290;
  e.scrolls.length = 0;
  e.page.restoreAnchor(anchor, 1000);
  assert.deepEqual(e.scrolls, [1250], 'scrolled by +250 to keep B where it was');
  // anchor card vanished: plain old scroll position
  e.page.restoreAnchor({ id: 'gone', top: 1 }, 777);
  assert.equal(e.scrolls.at(-1), 777);
});

test('hooks run around apply and a throwing hook does not stop the apply', () => {
  const e = makeEnv();
  const seen = [];
  e.page.hooks.beforeApply.push((m) => seen.push('before' + m.seq));
  e.page.hooks.afterApply.push(() => { throw new Error('hook'); });
  e.page.hooks.afterApply.push((m) => seen.push('after' + m.seq));
  e.page.receive(data(1));
  assert.deepEqual(seen, ['before1', 'after1']);
  assert.ok(e.errors.length >= 1, 'hook failure reported');
});

test('file live-server link is before the board and hides when its loopback URL is removed', () => {
  const e = makeEnv();
  const children = e.document.body.children;
  assert.ok(children.indexOf(e.link) < children.indexOf(e.byId.app), 'link is above the board');
  e.page.receive(data(1, { server: { url: 'http://127.0.0.1:47317/' } }));
  assert.equal(e.link.hidden, false);
  assert.match(e.link.textContent, /실시간 보기 열기/);
  assert.equal(e.link.href, 'http://127.0.0.1:47317/');
  assert.match(e.link.attrs.style, /display:block/);
  e.advance(600);
  e.page.receive(data(2));
  assert.equal(e.link.hidden, true);
  assert.match(e.link.attrs.style, /display:none/, 'inline style cannot defeat hidden');
  e.advance(600);
  e.page.receive(data(3, { server: { url: 'http://localhost:47318/' } }));
  assert.equal(e.link.hidden, false);
  assert.equal(e.link.href, 'http://localhost:47318/');
  e.advance(600);
  e.page.receive(data(4, { server: { url: 'http://evil.example/' } }));
  assert.equal(e.link.hidden, true);
  assert.match(e.link.attrs.style, /display:none/);
});
