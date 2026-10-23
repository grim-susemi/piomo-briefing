// Deterministic DOM for the real classic page scripts. No browser, sockets or wall-clock timers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const VOID = new Set(['BR', 'IMG', 'INPUT', 'HR', 'META', 'LINK', 'WBR']);
const encode = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const decode = s => s.replace(/&(amp|lt|gt|quot|#39|#96);/g, (_, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#96': '`' })[c]);
class Text {
  constructor(data) { this.nodeType = 3; this.data = data; this.parentNode = null; }
  get textContent() { return this.data; }
}
class Comment extends Text {
  constructor(data) { super(data); this.nodeType = 8; }
  get textContent() { return ''; }
}
function matches(el, selector) {
  return selector.split(',').some(alt => {
    const parts = alt.trim().split(/\s+(?![^[]*\])/);
    function one(n, s) {
      if (!n || n.nodeType !== 1) return false;
      const tag = /^[\w-]+/.exec(s);
      if (tag && n.tagName !== tag[0].toUpperCase()) return false;
      return [...s.matchAll(/\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)].every(m =>
        m[1] ? n.classes.has(m[1]) : m[2] ? n.id === m[2] : n.hasAttribute(m[3]) && (m[4] === undefined || n.getAttribute(m[3]) === m[4]));
    }
    if (!one(el, parts.pop())) return false;
    let p = el.parentNode;
    while (parts.length) {
      const part = parts.pop();
      while (p && !one(p, part)) p = p.parentNode;
      if (!p) return false;
      p = p.parentNode;
    }
    return true;
  });
}
class Element {
  constructor(tag, win) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = {}; this.childNodes = [];
    Object.defineProperty(this, 'parentNode', { value: null, writable: true });
    Object.defineProperty(this, 'win', { value: win });
    this.listeners = {}; this.scrollTop = 0; this.value = ''; this.hidden = false; this.writes = 0;
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
    this.classList = {
      add: c => { const s = this.classes; s.add(c); this.attrs.class = [...s].join(' '); },
      remove: c => { const s = this.classes; s.delete(c); this.attrs.class = [...s].join(' '); },
      contains: c => this.classes.has(c),
      toggle: (c, force) => { const on = force ?? !this.classes.has(c); this.classList[on ? 'add' : 'remove'](c); return on; },
    };
  }
  get classes() { return new Set((this.attrs.class || '').split(/\s+/).filter(Boolean)); }
  get ownerDocument() { return this.win.document; }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = v; }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get open() { return this.hasAttribute('open'); }
  set open(v) { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(n) { if (n.parentNode) n.remove ? n.remove() : n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = this.childNodes.indexOf(ref); assert.ok(i >= 0);
    n.parentNode = this; this.childNodes.splice(i, 0, n); return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); assert.ok(i >= 0); this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  matches(s) { return matches(this, s); }
  closest(s) { for (let n = this; n?.nodeType === 1; n = n.parentNode) if (matches(n, s)) return n; return null; }
  querySelectorAll(s) {
    const out = [];
    const walk = n => { for (const c of n.children) { if (matches(c, s)) out.push(c); walk(c); } };
    walk(this); return out;
  }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  addEventListener(type, fn, capture = false) {
    if (!this.listeners[type]) {
      const list = [];
      const fire = ev => list.forEach(x => x.fn(ev));
      fire.list = list; this.listeners[type] = fire;
    }
    this.listeners[type].list.push({ fn, capture: !!capture });
  }
  removeEventListener(type, fn) {
    const l = this.listeners[type]?.list;
    if (l) { const i = l.findIndex(x => x.fn === fn); if (i >= 0) l.splice(i, 1); }
  }
  getBoundingClientRect() {
    const r = this.win.rects.get(this) || { top: 0, left: 0, width: 1100, height: 100 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height };
  }
  get offsetHeight() { return this.hidden ? 0 : this.getBoundingClientRect().height; }
  get offsetWidth() { return this.getBoundingClientRect().width; }
  get clientWidth() { return this.offsetWidth; }
  get clientHeight() { return this.offsetHeight; }
  focus() { this.win.document.activeElement = this; }
  select() {}
  scrollIntoView() { this.win.scrolled.push(this); }
  normalize() {}
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) { this.childNodes.forEach(n => n.parentNode = null); this.childNodes = []; this.appendChild(new Text(String(v))); }
  get innerHTML() {
    return this.childNodes.map(n => {
      if (n.nodeType === 3) return encode(n.data);
      if (n.nodeType === 8) return '<!--' + n.data + '-->';
      const tag = n.tagName.toLowerCase();
      return '<' + tag + Object.entries(n.attrs).map(([k, v]) => ' ' + k + '="' + encode(v) + '"').join('') + '>' +
        (VOID.has(n.tagName) ? '' : n.innerHTML + '</' + tag + '>');
    }).join('');
  }
  set innerHTML(html) {
    this.writes++;
    this.childNodes.forEach(n => n.parentNode = null); this.childNodes = [];
    let cur = this;
    const re = /<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*>|([^<]+)/y;
    for (let at = 0; at < html.length;) {
      re.lastIndex = at; const m = re.exec(html);
      assert.ok(m, 'unparsed markup: ' + html.slice(at, at + 100)); at = re.lastIndex;
      if (m[0].startsWith('<!--')) cur.appendChild(new Comment(m[0].slice(4, -3)));
      else if (m[1]) { assert.equal(cur.tagName, m[1].toUpperCase()); cur = cur.parentNode; }
      else if (m[2]) {
        const n = new Element(m[2], this.win);
        for (const a of m[3].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) n.attrs[a[1]] = decode(a[2] ?? '');
        cur.appendChild(n); if (!VOID.has(n.tagName)) cur = n;
      } else if (m[4]) cur.appendChild(new Text(decode(m[4])));
    }
    assert.equal(cur, this, 'balanced markup');
  }
}
export function memoryStorage() {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), size: () => m.size };
}
export function makeController({ protocol = 'http:', token = 'tok-1', generation = null, sessionStorage = memoryStorage(),
  localStorage = memoryStorage(), abort = false, modules = ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'annotate'], configure } = {}) {
  let clock = 1000;
  let uuid = 0;
  const timers = [], intervals = [], fetches = [], errors = [], reloads = [], sources = [], rendered = [], scrolls = [];
  const ctx = {
    rects: new Map(), scrolled: [], innerWidth: 1440, innerHeight: 900, scrollY: 0,
    localStorage, sessionStorage, crypto: { randomUUID: () => '11111111-1111-4111-8111-' + String(++uuid).padStart(12, '0') },
    console: { error: (...a) => errors.push(a), warn: (...a) => errors.push(a) },
    location: { protocol, reload: () => reloads.push(clock) },
    setTimeout(fn, ms) { const t = { fn, ms, at: clock + ms }; timers.push(t); return t; },
    clearTimeout(t) { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
    addEventListener() {}, matchMedia: () => ({ matches: ctx.innerWidth < 900 }),
    scrollTo(x, y) { ctx.scrollY = y; scrolls.push(y); },
    selection: { isCollapsed: true, toString: () => '', rangeCount: 0, removeAllRanges() { this.isCollapsed = true; } },
    navigator: { clipboard: { writeText: async text => { ctx.copied = text; } } },
  };
  ctx.getSelection = () => ctx.selection;
  const html = new Element('html', ctx), body = new Element('body', ctx), head = new Element('head', ctx);
  html.appendChild(head); html.appendChild(body);
  const document = new Element('document', ctx);
  Object.assign(document, { body, head, documentElement: html, readyState: 'complete', visibilityState: 'visible', activeElement: body, title: 'board' });
  document.getElementById = id => html.querySelector('#' + id);
  document.createElement = tag => new Element(tag, ctx);
  document.createTextNode = s => new Text(s);
  document.querySelector = s => html.querySelector(s);
  document.querySelectorAll = s => html.querySelectorAll(s);
  for (const [name, value] of [['omo-board-token', token], ['omo-briefing-generation', generation]]) {
    if (value == null || !value) continue;
    const meta = new Element('meta', ctx); meta.setAttribute('name', name); meta.setAttribute('content', value); head.appendChild(meta);
  }
  ctx.document = document;
  if (abort) ctx.AbortController = AbortController;
  if (protocol.startsWith('http')) {
    ctx.fetch = (url, opts) => new Promise((resolve, reject) => {
      fetches.push({ url, opts, resolve, reject });
      if (opts?.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    ctx.EventSource = class {
      constructor(url) { this.url = url; this.listeners = {}; this.handlers = this.listeners; sources.push(this); }
      addEventListener(t, f) { this.listeners[t] = f; }
      emit(t, data) { (this.listeners[t] || this['on' + t])?.({ data: JSON.stringify(data) }); }
    };
  }
  vm.createContext(ctx);
  for (const name of modules) vm.runInContext(fs.readFileSync(new URL('../../src/page/' + name + '.js', import.meta.url), 'utf8'), ctx, { filename: name + '.js' });
  configure?.(ctx, rendered);
  vm.runInContext(fs.readFileSync(new URL('../../src/page/page.js', import.meta.url), 'utf8'), ctx, { filename: 'page.js' });
  const page = ctx.BriefPage; page.state.now = () => clock;
  const byId = new Proxy({}, { get: (_, id) => document.getElementById(id) });
  const fire = (target, type, props = {}) => {
    const ev = { target, type, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
    try {
      ev.eventPhase = 1;
      for (const l of document.listeners[type]?.list || []) if (l.capture) l.fn(ev);
      if (!ev.stopped) for (let p = target; p && !ev.stopped; p = p.parentNode) {
        ev.eventPhase = p === target ? 2 : 3;
        p.listeners?.[type]?.(ev);
      }
      ev.eventPhase = 3;
      if (!ev.stopped) for (const l of document.listeners[type]?.list || []) if (!l.capture) l.fn(ev);
    } finally {
      ev.eventPhase = 0;
    }
    return ev;
  };
  return {
    page, ctx, byId, app: byId.app, document, timers, intervals, fetches, errors, reloads, rendered, scrolls, sources,
    selection: ctx.selection, status: byId['live-status'], badge: byId['new-badge'], link: byId['live-link'], fire,
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > until) break;
        const t = timers.shift(); clock = t.at; t.fn();
      }
      clock = until;
    },
  };
}
