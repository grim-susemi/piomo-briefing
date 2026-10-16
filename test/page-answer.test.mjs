// Answering from the board (server page): src/page/page.js 'board answers' with the real src/page/view.js in a small fake
// browser. Time, timers and fetch are fully manual: nothing here waits on the wall clock, every reply is settled by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store.mjs';
import { applyBoardAnswer } from '../src/decide.mjs';
import { buildViewModel } from '../src/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_SRC = fs.readFileSync(path.join(ROOT, 'src/page/page.js'), 'utf8');
const VIEW_SRC = fs.readFileSync(path.join(ROOT, 'src/page/view.js'), 'utf8');
const PLAN_SRC = fs.readFileSync(path.join(ROOT, 'src/page/plan-view.js'), 'utf8');

// http: + token = the page the board server serves (src/render.mjs pageHtml, server mode); file: = the file page.
function makeEnv({ protocol = 'http:', token = 'tok-1', sessionStorage = null, abort = false } = {}) {
  const byId = {};
  const timers = [];
  const fetches = [];
  const errors = [];
  const reloads = [];
  let clock = 1000;
  function el(tag) {
    let html = '';
    const e = {
      tagName: tag, id: '', hidden: false, textContent: '', listeners: {}, attrs: {}, children: [], classes: new Set(),
      classList: { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), toggle() {} },
      addEventListener(t, f) { e.listeners[t] = f; },
      get firstChild() { return e.children[0] || null; },
      appendChild(c) { if (c.id) byId[c.id] = c; e.children.push(c); return c; },
      insertBefore(c, before) { if (c.id) byId[c.id] = c; e.children.splice(Math.max(0, e.children.indexOf(before)), 0, c); return c; },
      setAttribute(k, v) { e.attrs[k] = v; },
      getAttribute(k) { return e.attrs[k] ?? null; },
      getBoundingClientRect() { return { top: 0, bottom: 100 }; },
      querySelector(sel) {
        if (sel !== '.app') return null;
        const m = /data-tab="([^"]*)"/.exec(e.innerHTML);
        return m ? { getAttribute: () => m[1] } : null;
      },
      // the board's cards: page.js looks a conversation's card up by its data-card
      querySelectorAll(sel) {
        if (sel !== '[data-card]') return [];
        return [...html.matchAll(/<article [^>]*\bdata-card="([^"]*)"/g)].map((m) => ({ getAttribute: (k) => (k === 'data-card' ? m[1] : null), getBoundingClientRect: () => ({ top: 0, bottom: 100 }) }));
      },
      contains() { return true; }, remove() {},
    };
    Object.defineProperty(e, 'innerHTML', { get: () => html, set(v) { html = v; } });
    return e;
  }
  const body = el('body');
  const head = el('head');
  head.appendChild = (c) => c; // the file page's data.js polling is not exercised here
  const document = {
    readyState: 'complete', visibilityState: 'visible', body, head, documentElement: { scrollHeight: 0 }, activeElement: null,
    getElementById: (id) => byId[id] || null, createElement: el, addEventListener() {},
    querySelector: (sel) => (token && sel === 'meta[name="omo-board-token"]' ? { getAttribute: (k) => (k === 'content' ? token : null) } : null),
  };
  class FakeEventSource { constructor(url) { this.url = url; } addEventListener() {} }
  const ctx = {
    document, scrollY: 0, innerHeight: 900, scrollTo() {},
    setInterval() { return 0; },
    setTimeout(fn, ms) { const t = { fn, at: clock + ms }; timers.push(t); return t; },
    clearTimeout(t) { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
    addEventListener() {},
    getSelection: () => ({ isCollapsed: true, toString: () => '' }),
    console: { error: (...a) => errors.push(a) },
    location: { protocol, reload() { reloads.push(clock); } },
  };
  if (sessionStorage) ctx.sessionStorage = sessionStorage;
  if (abort) ctx.AbortController = AbortController;
  if (protocol.startsWith('http')) {
    // pending until the test settles it; an aborted signal rejects it like a browser fetch
    ctx.fetch = (url, opts) => new Promise((resolve, reject) => {
      fetches.push({ url, opts, resolve, reject });
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    ctx.EventSource = FakeEventSource;
  }
  vm.runInNewContext(VIEW_SRC, ctx, { filename: 'view.js' });
  vm.runInNewContext(PLAN_SRC, ctx, { filename: 'plan-view.js' });
  vm.runInNewContext(PAGE_SRC, ctx, { filename: 'page.js' });
  const page = ctx.BriefPage;
  page.state.now = () => clock;
  return {
    page, fetches, errors, reloads, app: byId.app,
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
  };
}

const count = (s, re) => (s.match(re) || []).length;
const opt = (text) => ({ text, consequence: text + ' 결과' });
function answerModel(seq, patch = {}) {
  return {
    seq, generatedAt: 0,
    sessions: [{
      id: 's-a1', project: 'p', title: '상황판', tabLabel: '수리', tabNumber: 181, paneId: 'w1:pR2', answerKinds: ['option', 'text'],
      status: 'needs_decision', tab: '나를 기다림',
      decisions: [
        { id: 12, sessionId: 's-a1', question: 'q12', options: { A: opt('가'), B: opt('나'), C: opt('다') }, recommend: 'A', reason: 'r', answered: false, closed: false, ...patch[12] },
        { id: 13, sessionId: 's-a1', question: 'q13', options: { A: opt('가'), B: opt('나') }, recommend: 'B', reason: 'r', answered: false, closed: false, ...patch[13] },
      ],
    }],
  };
}
const decHtml = (e, id) => {
  const html = e.app.innerHTML;
  const start = html.indexOf('data-decision="' + id + '"');
  return start < 0 ? '' : html.slice(start, html.indexOf('</div><!--dcard-->', start));
};
// A button the real view rendered: its attributes come from the HTML, so the page is only ever clicked where the view drew.
function target(e, act, id, extra = {}) {
  const tags = [...e.app.innerHTML.matchAll(/<button [^>]*>/g)].map((m) => m[0])
    .filter((tag) => tag.includes(`data-act="${act}"`) && tag.includes(`data-id="${id}"`) && Object.entries(extra).every(([k, v]) => tag.includes(`${k}="${v}"`)));
  assert.ok(tags.length > 0, `${act} #${id} is on the page`);
  const attrs = Object.fromEntries([...tags[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return { hasAttribute: (n) => n in attrs, getAttribute: (n) => attrs[n] ?? null };
}
const click = (e, t) => e.app.listeners.click({ target: { closest: () => t }, preventDefault() {} });
const press = (e, act, id, extra) => click(e, target(e, act, id, extra));
// a tab button the real view rendered
function clickTab(e, tab) {
  assert.ok(e.app.innerHTML.includes(`data-act="tab" data-tab="${tab}"`), `tab ${tab} is on the page`);
  click(e, { hasAttribute: () => false, getAttribute: (n) => ({ 'data-act': 'tab', 'data-tab': tab })[n] ?? null });
}
function type(e, id, value) {
  const counter = { textContent: '' };
  e.app.listeners.input({ target: { value, getAttribute: (n) => (n === 'data-draft' ? String(id) : null), closest: () => ({ querySelector: () => counter }) } });
  return counter;
}
const reply = (status, json) => ({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(json) });
// every promise the page chained on a settled fake fetch has run before the next macrotask (no I/O involved)
const settle = () => new Promise((resolve) => setImmediate(resolve));
const posts = (e) => e.fetches.filter((f) => f.url === '/answer');
const errText = (e, id) => (/<p class="ans-err" role="alert">([^<]*)<\/p>/.exec(decHtml(e, id)) || [])[1];
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, size: () => m.size };
}

test('B -> the confirm survives a re-render -> 보내기 sends one POST with the exact body and headers; 전달됨 only from the model', async () => {
  const e = makeEnv();
  e.page.receive(answerModel(1));
  assert.equal(e.page.state.ui.live, true);
  press(e, 'ans-pick', 12, { 'data-opt': 'B' });
  assert.match(decHtml(e, 12), /class="ans-confirm"[\s\S]*<b>B<\/b>/);
  e.advance(600);
  e.page.receive(answerModel(2)); // a new model rewrites the whole board
  assert.equal(e.page.state.seq, 2);
  assert.match(decHtml(e, 12), /class="ans-confirm"[\s\S]*<b>B<\/b>/, 'the confirm survived the re-render');
  assert.equal(posts(e).length, 0, 'nothing is sent before 보내기');
  const send = target(e, 'ans-send', 12);
  click(e, send);
  assert.equal(posts(e).length, 1);
  const post = posts(e)[0];
  assert.equal(post.opts.method, 'POST');
  assert.deepEqual({ ...post.opts.headers }, { 'Content-Type': 'application/json', 'X-Board-Token': 'tok-1' });
  assert.deepEqual(JSON.parse(post.opts.body), { id: 12, sessionId: 's-a1', option: 'B' });
  assert.match(decHtml(e, 12), /class="ans-state"/);
  click(e, send); // the old 보내기 pressed again while in flight
  assert.equal(posts(e).length, 1, 'no second POST');
  post.resolve(reply(200, { ok: true, id: 12 }));
  await settle();
  assert.match(decHtml(e, 12), /class="ans-state"/, 'stored; waiting for the model');
  assert.ok(!e.app.innerHTML.includes('chip s-done'), 'no optimistic delivered chip');
  e.advance(600);
  e.page.receive(answerModel(3, { 12: { answered: true, answer: { option: 'B', text: '', at: 1 }, delivery: '대기: 작업이 끝나면 전달', receipt: null } }));
  assert.equal(decHtml(e, 12), '', 'the open card is gone');
  assert.match(e.app.innerHTML, /<p class="dsent">[^]*#12 답 B[^]*chip x-busy/);
  e.advance(600);
  e.page.receive(answerModel(4, { 12: { answered: true, answer: { option: 'B', text: '', at: 1 }, delivery: '전달됨 ⏱12:34', receipt: { kind: 'steered', mode: 'immediate', deliveredAt: 1, proven: true } } }));
  assert.match(e.app.innerHTML, /<p class="dsent">[^]*#12 답 B[^]*chip s-done/, 'delivered: from the receipt in the model');
  assert.equal(posts(e).length, 1);
  assert.deepEqual(e.errors, []);
});

test('a reply keeps its draft across a re-render, counts in place, and goes out trimmed after its own confirm', async () => {
  const e = makeEnv();
  e.page.receive(answerModel(1));
  press(e, 'ans-reply', 13);
  assert.match(decHtml(e, 13), /<textarea class="ans-text" data-draft="13"/);
  assert.equal(type(e, 13, '  설치해 줘  ').textContent, '9/500');
  e.advance(600);
  e.page.receive(answerModel(2));
  assert.ok(decHtml(e, 13).includes('>  설치해 줘  </textarea>'), 'the draft survived the re-render');
  press(e, 'ans-text', 13);
  assert.ok(decHtml(e, 13).includes('<q class="ans-quote">설치해 줘</q>'));
  press(e, 'ans-send', 13);
  assert.deepEqual(JSON.parse(posts(e)[0].opts.body), { id: 13, sessionId: 's-a1', text: '설치해 줘' });
  posts(e)[0].resolve(reply(200, { ok: true, id: 13 }));
  await settle();
  assert.equal(e.page.state.ui.answers['13'].draft, '', 'a sent reply leaves no draft behind');
  press(e, 'ans-reply', 12);
  type(e, 12, '   ');
  press(e, 'ans-text', 12);
  assert.equal(errText(e, 12), e.page.answerText.empty, 'a blank reply never leaves the page');
  assert.equal(posts(e).length, 1);
  assert.deepEqual(e.errors, []);
});

test('each refusal shows its own text on the card; ANSWERED, CLOSED and NOT_FOUND end the decision with no second POST', async () => {
  const cases = [
    { status: 409, code: 'ANSWERED', text: 'closed', ends: true },
    { status: 409, code: 'CLOSED', text: 'closed', ends: true },
    { status: 404, code: 'NOT_FOUND', text: 'gone', ends: true },
    { status: 409, code: 'NO_TEXT_SUPPORT', text: 'noText', reply: true },
    { status: 503, code: 'PAUSED', text: 'paused', retry: true },
    { status: 429, code: 'BUSY', text: 'busy', retry: true },
    { status: 504, code: 'TIMEOUT', text: 'slow', retry: true },
    { status: 0, text: 'network', retry: true },
    { status: 500, code: 'IO_ERROR', text: 'failed', retry: true },
  ];
  for (const c of cases) {
    const e = makeEnv();
    e.page.receive(answerModel(1));
    if (c.reply) { press(e, 'ans-reply', 12); type(e, 12, '답글'); press(e, 'ans-text', 12); } else press(e, 'ans-pick', 12, { 'data-opt': 'B' });
    const send = target(e, 'ans-send', 12);
    click(e, send);
    if (c.status === 0) posts(e)[0].reject(new TypeError('Failed to fetch'));
    else posts(e)[0].resolve(reply(c.status, { ok: false, code: c.code }));
    await settle();
    const label = `${c.status} ${c.code || 'network'}`;
    const shown = errText(e, 12) || '';
    assert.ok(shown.startsWith(e.page.answerText[c.text]), `${label}: ${shown}`);
    if (c.text === 'failed') assert.ok(shown.includes('IO_ERROR'), 'a refusal without its own text names its code');
    assert.equal(count(decHtml(e, 12), /data-act="ans-pick"/g), c.ends ? 0 : 3, label + ' buttons');
    click(e, send); // the old 보내기 once more
    assert.equal(posts(e).length, c.retry ? 2 : 1, label + (c.retry ? ': one more press sends again' : ': no second POST'));
    assert.equal(e.reloads.length, 0);
    if (c.status !== 0) assert.deepEqual(e.errors, [], label + ': nothing logged');
    else assert.ok(e.errors.length >= 1, 'a network failure is logged, not swallowed');
  }
});

test('403: exactly one automatic reload, carrying the reply drafts; a second 403 asks to reopen the board', async () => {
  const storage = memoryStorage();
  const first = makeEnv({ token: 'old', sessionStorage: storage });
  first.page.receive(answerModel(1));
  press(first, 'ans-reply', 13);
  type(first, 13, '이 답글은 남아야 함');
  press(first, 'ans-pick', 12, { 'data-opt': 'B' });
  press(first, 'ans-send', 12);
  posts(first)[0].resolve(reply(403, { ok: false, code: 'FORBIDDEN_TOKEN' }));
  await settle();
  assert.equal(first.reloads.length, 1, 'one reload picks up the new token');
  assert.equal(storage.size(), 1);

  const second = makeEnv({ token: 'new', sessionStorage: storage }); // the reloaded page, same tab storage
  second.page.receive(answerModel(1));
  assert.equal(storage.size(), 0, 'the flag is consumed on load');
  assert.ok(decHtml(second, 13).includes('>이 답글은 남아야 함</textarea>'), 'the draft came back with its box open');
  press(second, 'ans-pick', 12, { 'data-opt': 'B' });
  press(second, 'ans-send', 12);
  assert.equal(posts(second)[0].opts.headers['X-Board-Token'], 'new');
  posts(second)[0].resolve(reply(403, { ok: false, code: 'FORBIDDEN_TOKEN' }));
  await settle();
  assert.equal(second.reloads.length, 0, 'no second reload');
  assert.equal(errText(second, 12), second.page.answerText.reopen);
  assert.deepEqual(second.errors, []);

  const bare = makeEnv(); // no sessionStorage: the reload could not be limited to one, so there is none
  bare.page.receive(answerModel(1));
  press(bare, 'ans-pick', 12, { 'data-opt': 'A' });
  press(bare, 'ans-send', 12);
  posts(bare)[0].resolve(reply(403, { ok: false, code: 'FORBIDDEN_TOKEN' }));
  await settle();
  assert.equal(bare.reloads.length, 0);
  assert.equal(errText(bare, 12), bare.page.answerText.reopen);
  assert.ok(bare.errors.length >= 1, 'the storage failure is logged, not swallowed');
});

test('a POST that never answers is given up at 15 s on the fake clock with the network text; one more press sends again', async () => {
  const e = makeEnv({ abort: true });
  e.page.receive(answerModel(1));
  press(e, 'ans-pick', 12, { 'data-opt': 'C' });
  press(e, 'ans-send', 12);
  e.advance(14999);
  await settle();
  assert.match(decHtml(e, 12), /class="ans-state"/, 'still sending');
  e.advance(1);
  await settle();
  assert.equal(errText(e, 12), e.page.answerText.network);
  press(e, 'ans-send', 12);
  assert.equal(posts(e).length, 2);
});

test('two sends from one page go out one after the other (the server takes one write at a time)', async () => {
  const e = makeEnv();
  e.page.receive(answerModel(1));
  press(e, 'ans-pick', 12, { 'data-opt': 'B' });
  press(e, 'ans-send', 12);
  press(e, 'ans-pick', 13, { 'data-opt': 'A' });
  press(e, 'ans-send', 13);
  assert.equal(posts(e).length, 1, 'the second waits for the first');
  posts(e)[0].resolve(reply(200, { ok: true, id: 12 }));
  await settle();
  assert.equal(posts(e).length, 2);
  assert.deepEqual(JSON.parse(posts(e)[1].opts.body), { id: 13, sessionId: 's-a1', option: 'A' });
});

test('file page: no answer controls even with a token meta; a decision the model already shows answered is never sent', () => {
  const f = makeEnv({ protocol: 'file:' });
  f.page.receive(answerModel(1));
  assert.notEqual(f.page.state.ui.live, true);
  assert.ok(!/data-act="ans-/.test(f.app.innerHTML));
  assert.equal(f.fetches.length, 0);
  const e = makeEnv();
  e.page.receive(answerModel(1));
  press(e, 'ans-pick', 12, { 'data-opt': 'B' });
  const send = target(e, 'ans-send', 12);
  e.advance(600);
  e.page.receive(answerModel(2, { 12: { answered: true, answer: { option: 'A', text: '', at: 1 }, delivery: '전달 중' } }));
  click(e, send);
  assert.equal(posts(e).length, 0);
});

test('malformed clicks and replies never send or claim success; a broken reload flag is reported and dropped', async () => {
  const e = makeEnv();
  e.page.receive(answerModel(1));
  const fake = (attrs) => click(e, { hasAttribute: (n) => n in attrs, getAttribute: (n) => attrs[n] ?? null });
  for (const id of ['abc', '0', '-1', '12.5', '', '1e3', '__proto__', '12 ']) fake({ 'data-act': 'ans-pick', 'data-id': id, 'data-opt': 'B' });
  for (const o of ['D', 'b', '', '__proto__']) fake({ 'data-act': 'ans-pick', 'data-id': '12', 'data-opt': o });
  fake({ 'data-act': 'ans-bogus', 'data-id': '12' });
  assert.ok(!e.app.innerHTML.includes('class="ans-confirm"'), 'nothing was picked');
  assert.deepEqual(Object.keys(e.page.state.ui.answers || {}).filter((k) => k !== '12'), [], 'no state under a bad id');
  press(e, 'ans-pick', 12, { 'data-opt': 'B' });
  press(e, 'ans-send', 12);
  posts(e)[0].resolve({ status: 200, ok: true, json: () => Promise.reject(new SyntaxError('not json')) });
  await settle();
  assert.match(errText(e, 12) || '', /200/, 'a 200 without a JSON body is not a success');
  press(e, 'ans-send', 12);
  posts(e)[1].resolve(reply(200, { ok: false }));
  await settle();
  assert.ok(errText(e, 12), 'ok:false is not a success either');
  assert.equal(posts(e).length, 2);
  assert.deepEqual(e.errors, []);

  const storage = memoryStorage();
  storage.setItem('omo-briefing.answer403', '{broken');
  const r = makeEnv({ sessionStorage: storage });
  r.page.receive(answerModel(1));
  assert.equal(storage.size(), 0, 'the broken flag is consumed');
  assert.ok(r.errors.length >= 1, 'and reported');
  assert.match(r.app.innerHTML, /data-act="ans-pick"/, 'the board still answers');
});

test('answering the last open decision keeps its card on the tab it was answered on: 보내는 중 -> 대기 -> 전달됨 from the real view model, until the owner changes tabs', async (t) => {
  // the HTTP answer before the first new model (as usual), or after both of them (the SSE stream can be faster)
  for (const replyFirst of [true, false]) {
    const label = replyFirst ? '200 first' : 'models first';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-page-answer-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = openStore(dir);
    const at = Date.UTC(2026, 9, 16, 3, 0);
    store.replace('sessions/owner/meta.json', { sessionId: 'owner', cwd: 'C:/w', title: '마지막 결정', tabLabel: '수리', tabNumber: 181, answerKinds: ['option', 'text'], lastActivityAt: at, lastBriefAt: at });
    store.writeNew('sessions/owner/briefs/000001.json', { at, brief: { title: '마지막 결정', status: 'in_progress', headline: 'h', changes: [], done: [], next: '', decisions: [] } });
    const id = store.allocDecisionId({ sessionId: 'owner', question: 'q', options: { A: opt('가'), B: opt('나') }, recommend: 'A', reason: 'r', blocks: true, createdAt: at, source: 'brief' });
    store.replace('sessions/other/meta.json', { sessionId: 'other', cwd: 'C:/w', title: '다른 일', lastActivityAt: at, lastBriefAt: at }); // no decision: 진행 중
    store.writeNew('sessions/other/briefs/000001.json', { at, brief: { title: '다른 일', status: 'in_progress', headline: 'h', changes: [], done: [], next: '', decisions: [] } });
    let seq = 0;
    const model = () => ({ ...buildViewModel(store.readSnapshot(), at + 5, { isAlive: () => false }), seq: ++seq });
    const ownerOf = (m) => m.sessions.find((s) => s.id === 'owner');
    const e = makeEnv();
    const seen = (m, chipClass) => {
      const html = e.app.innerHTML;
      const line = (/<p class="dsent">([^]*?)<\/p>/.exec(html) || [])[1] || '';
      assert.equal(/<div class="app" data-tab="(\w+)"/.exec(html)[1], 'wait', `${label}: the tab the owner is on`);
      assert.ok(html.includes('data-card="owner"'), `${label}: the card is still on the screen`);
      assert.ok(line.includes(ownerOf(m).decisions[0].delivery) && line.includes(`chip ${chipClass}`), `${label}: ${line}`);
    };
    const first = model();
    assert.equal(ownerOf(first).tab, '나를 기다림');
    e.page.receive(first);
    press(e, 'ans-pick', id, { 'data-opt': 'B' });
    press(e, 'ans-send', id);
    assert.match(decHtml(e, id), /class="ans-state"/);
    const post = posts(e)[0];
    assert.equal(applyBoardAnswer(store, JSON.parse(post.opts.body), at + 1).ok, true, 'stored by the real writer');
    const answerHttp = async () => { post.resolve(reply(200, { ok: true, id })); await settle(); };
    if (replyFirst) await answerHttp();
    const waiting = model();
    assert.equal(ownerOf(waiting).tab, '진행 중', 'the real classification files the answered conversation under 진행 중');
    e.advance(600);
    e.page.receive(waiting);
    seen(waiting, 'x-busy');
    store.writeNew(`receipts/${String(id).padStart(6, '0')}.json`, { id, sessionId: 'owner', kind: 'steered', mode: 'immediate', deliveredAt: at + 3, proven: true });
    const delivered = model();
    e.advance(600);
    e.page.receive(delivered);
    seen(delivered, 's-done');
    if (!replyFirst) { await answerHttp(); seen(delivered, 's-done'); }
    // the owner moves on, by the tab bar or by a contents link into 진행 중: the card goes where its model files it
    if (replyFirst) clickTab(e, 'run');
    else {
      const link = /<a class="toclink" href="#[^"]*" data-goto="([^"]*)" data-tab="run">/.exec(e.app.innerHTML);
      assert.ok(link, 'a contents link into 진행 중');
      click(e, { hasAttribute: (n) => n === 'data-goto', getAttribute: (n) => ({ 'data-goto': link[1], 'data-tab': 'run' })[n] ?? null });
    }
    assert.ok(e.app.innerHTML.includes('data-card="owner"'), `${label}: in 진행 중`);
    clickTab(e, 'wait');
    assert.ok(!e.app.innerHTML.includes('data-card="owner"'), `${label}: no longer held`);
    assert.equal(posts(e).length, 1);
    assert.deepEqual(e.errors, []);
  }
});

test('an answer sent from the plan row of another card never pulls the asking conversation into the tab on the screen', async () => {
  const e = makeEnv();
  const m = answerModel(1);
  m.sessions.unshift({ id: 'p', project: 'p', title: '계획', status: 'in_progress', tab: '진행 중', decisions: [],
    plan: { planId: 'pl', rev: 1, at: 0, stage: 'running', goal: 'g', source: { slug: 's' }, questions: [{ id: 'Q1', text: 'q', state: 'open', decisionId: 12, recommend: 'A' }] } });
  e.page.state.ui.expanded['plan:pl'] = true;
  e.page.receive(m);
  clickTab(e, 'run');
  const pulled = () => e.app.innerHTML.includes('data-card="s-a1"');
  press(e, 'ans-pick', 12, { 'data-where': 'plan', 'data-opt': 'B' });
  press(e, 'ans-send', 12, { 'data-where': 'plan' });
  assert.equal(posts(e).length, 1);
  assert.ok(!pulled(), 'sending: the asking conversation stays in 나를 기다림');
  posts(e)[0].resolve(reply(200, { ok: true, id: 12 }));
  await settle();
  assert.ok(!pulled(), 'sent: still not pulled in');
  clickTab(e, 'wait');
  assert.ok(pulled(), 'its card is where it was');
  assert.deepEqual(e.errors, []);
});
