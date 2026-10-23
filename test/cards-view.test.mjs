import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourceUrl = new URL('../src/page/cards-view.js', import.meta.url);
const cssUrl = new URL('../src/page/cards-view.css', import.meta.url);
const stateUrl = new URL('./fixtures/memento/board-state.v1.json', import.meta.url);
const repliesUrl = new URL('./fixtures/memento/replies.json', import.meta.url);
const source = fs.readFileSync(sourceUrl, 'utf8');
const css = fs.readFileSync(cssUrl, 'utf8');
const STATE = JSON.parse(fs.readFileSync(stateUrl, 'utf8'));
const REPLIES = JSON.parse(fs.readFileSync(repliesUrl, 'utf8'));
const EVIL = '<img src=x ' + 'onerror' + '=alert(1)>';
const clone = value => JSON.parse(JSON.stringify(value));

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

class FakeEl {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = Object.create(null);
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.colSpan = 0;
    this.role = '';
    this.scope = '';
    this.target = '';
    this.rel = '';
    this.placeholder = '';
    this.ariaLabel = '';
    this.ariaPressed = '';
    this.ariaExpanded = '';
    this.ownerDocument = doc;
  }
  get classList() {
    const el = this;
    return {
      add(name) {
        const names = new Set(el.className.split(/\s+/).filter(Boolean));
        names.add(name);
        el.className = [...names].join(' ');
      },
      remove(name) {
        const names = new Set(el.className.split(/\s+/).filter(Boolean));
        names.delete(name);
        el.className = [...names].join(' ');
      },
      contains(name) { return el.className.split(/\s+/).filter(Boolean).includes(name); },
      toggle(name, force) {
        const has = el.className.split(/\s+/).filter(Boolean).includes(name);
        const on = force === undefined ? !has : !!force;
        if (on) this.add(name); else this.remove(name);
        return on;
      },
    };
  }
  get children() { return this.childNodes.filter(node => node instanceof FakeEl); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    const text = value === null || value === undefined ? '' : String(value);
    if (text) this.appendChild(new FakeText(text));
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) {
    for (let cursor = node; cursor; cursor = cursor.parentNode) if (cursor === this) return true;
    return false;
  }
  matches(selector) { return matches(this, selector.split(/\s+/)); }
  closest(selector) {
    const chain = selector.split(/\s+/);
    for (let node = this; node instanceof FakeEl; node = node.parentNode) if (matches(node, chain)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const chain = selector.trim().split(/\s+/);
    const out = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (!(child instanceof FakeEl)) continue;
        if (matches(child, chain)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function one(el, part) {
  if (part === '*') return true;
  const match = /^([a-zA-Z][\w-]*)?(?:\.([\w-]+))?$/.exec(part);
  if (!match) throw new Error('unsupported selector: ' + part);
  if (match[1] && el.tagName !== match[1].toUpperCase()) return false;
  if (match[2] && !el.classList.contains(match[2])) return false;
  return true;
}

function matches(el, chain) {
  if (!one(el, chain[chain.length - 1])) return false;
  let index = chain.length - 2;
  for (let parent = el.parentNode; parent && index >= 0; parent = parent.parentNode) {
    if (one(parent, chain[index])) index--;
  }
  return index < 0;
}

function makeDocument() {
  const doc = { activeElement: null };
  doc.createElement = tag => new FakeEl(tag, doc);
  doc.createTextNode = data => new FakeText(data);
  doc.documentElement = new FakeEl('html', doc);
  doc.body = new FakeEl('body', doc);
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  return doc;
}

function fire(el, type, props = {}) {
  const event = {
    type,
    target: el,
    currentTarget: el,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...props,
  };
  return Promise.all((el.listeners[type] || []).map(handler => handler(event)));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function baseCtx(over = {}) {
  const calls = [];
  return {
    calls,
    live: true,
    setStatus(id, status, rev) {
      calls.push({ id, status, rev });
      return { status: 200, body: { ok: true, rev: rev + 1, discord: 'pushed' } };
    },
    ...over,
  };
}

function harness(state, ctx = baseCtx()) {
  const doc = makeDocument();
  const context = vm.createContext({ document: doc, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'cards-view.js' });
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  context.BriefCards.mount(container, ctx);
  if (state) context.BriefCards.update(state);
  return { doc, context, container, BriefCards: context.BriefCards };
}

const rows = root => root.querySelectorAll('.mcards-row');
const row = (root, id) => rows(root).find(item => item.__mcardsId === id) || null;
const detail = (root, id) => root.querySelectorAll('.mcards-detail-row').find(item => item.__mcardsId === id) || null;
const conflictRow = (root, id) => root.querySelectorAll('.mcards-conflict-row').find(item => item.__mcardsId === id) || null;
const byText = (root, text, tag = 'button') => root.querySelectorAll(tag).find(item => item.textContent === text) || null;
const statusSelect = (root, id) => row(root, id)?.querySelector('.mcards-status-select') || null;
const oneCardState = card => ({ ...clone(STATE), cards: [clone(card)] });
const baseCard = clone(STATE.cards.find(card => card.id === '20261003-cdef'));

test('classic script loads without a DOM and exposes only the two view entry points', () => {
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'cards-view.js' });
  assert.deepEqual(Object.keys(context.BriefCards).sort(), ['mount', 'update']);
  assert.equal(typeof context.BriefCards.mount, 'function');
  assert.equal(typeof context.BriefCards.update, 'function');
});

test('stylesheet stays on board tokens: no colour literals, spacing and surfaces use variables', () => {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /\brgb\(|\bhsl\(/);
  assert.match(css, /var\(--sp-/);
  assert.match(css, /var\(--c-/);
  assert.match(css, /var\(--r-/);
});

test('the six required columns render in order from the contract fixture', () => {
  const h = harness(clone(STATE));
  const headers = h.container.querySelectorAll('th.mcards-th').map(cell => cell.textContent);
  assert.deepEqual(headers, ['제목', '상태', '프로젝트', '바뀐 날', '출처', '디스코드']);
  assert.equal(rows(h.container).length, 12);
  assert.equal(row(h.container, '20261012-d456').querySelector('.mcards-card-title').textContent, '예시 아이디어 12');
});

test('status chips are 전체 plus the seven labels; project options come from the cards', () => {
  const h = harness(clone(STATE));
  const chips = h.container.querySelectorAll('button.mcards-chip').map(chip => chip.textContent);
  assert.deepEqual(chips, ['전체', '메모', '조사중', '계획됨', '구현중', '완료', '보류', '폐기']);
  const projects = h.container.querySelectorAll('select.mcards-project-select option').map(option => option.textContent);
  assert.deepEqual(projects, ['전체 프로젝트', 'example-project']);
});

test('status chips filter rows and expose the active state', async () => {
  const h = harness(clone(STATE));
  await fire(byText(h.container, '완료'), 'click');
  assert.equal(rows(h.container).length, 1);
  assert.equal(rows(h.container)[0].__mcardsId, '20261005-efgh');
  assert.equal(byText(h.container, '완료').ariaPressed, 'true');
  assert.equal(byText(h.container, '전체').ariaPressed, 'false');
});

test('text search covers title and description; project select narrows to one project', async () => {
  const h = harness(clone(STATE));
  const search = h.container.querySelector('input.mcards-search-input');
  search.value = '아이디어 3';
  await fire(search, 'input');
  assert.equal(rows(h.container).length, 1);
  assert.equal(rows(h.container)[0].__mcardsId, '20261003-cdef');
  search.value = '';
  await fire(search, 'input');
  const project = h.container.querySelector('select.mcards-project-select');
  project.value = 'example-project';
  await fire(project, 'change');
  assert.equal(rows(h.container).length, 1);
  assert.equal(rows(h.container)[0].__mcardsId, '20261002-bcde');
});

test('one row expands to 원문, 메모 and the ten newest log entries', async () => {
  const h = harness(clone(STATE));
  const first = row(h.container, '20261012-d456');
  await fire(byText(first, '원문·메모 보기'), 'click');
  const panel = detail(h.container, '20261012-d456');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /원문/);
  assert.match(panel.textContent, /메모/);
  assert.match(panel.textContent, /일부만 표시했어요/);
  assert.equal(panel.querySelectorAll('.mcards-log-item').length, 10);
});

test('two updates keep open rows, filters and focus', async () => {
  const h = harness(clone(STATE));
  const search = h.container.querySelector('input.mcards-search-input');
  search.value = '예시';
  await fire(search, 'input');
  await fire(byText(row(h.container, '20261012-d456'), '원문·메모 보기'), 'click');
  const select = statusSelect(h.container, '20261012-d456');
  select.focus();
  assert.equal(h.doc.activeElement, select);
  const next = clone(STATE);
  next.cards[0].title = '예시 아이디어 12 갱신';
  next.cards[0].rev = 15;
  h.BriefCards.update(clone(STATE));
  assert.equal(search.value, '예시');
  assert.equal(detail(h.container, '20261012-d456').hidden, false);
  h.BriefCards.update(next);
  assert.equal(search.value, '예시');
  assert.equal(byText(h.container, '전체').ariaPressed, 'true');
  assert.equal(detail(h.container, '20261012-d456').hidden, false);
  const after = statusSelect(h.container, '20261012-d456');
  assert.equal(h.doc.activeElement, after);
  assert.match(after.ariaLabel, /갱신/);
  assert.equal(after.value, 'building');
});

test('mounting the same container twice keeps one view root', () => {
  const h = harness(clone(STATE));
  h.BriefCards.mount(h.container, baseCtx());
  assert.equal(h.container.querySelectorAll('.mcards-root').length, 1);
  assert.equal(rows(h.container).length, 12);
});

test('a conflict row shows both values and two pick buttons', async () => {
  const ctx = baseCtx();
  const h = harness(clone(STATE), ctx);
  const conflict = conflictRow(h.container, '20261008-hab2');
  assert.ok(conflict);
  assert.match(conflict.textContent, /상황판/);
  assert.match(conflict.textContent, /디스코드/);
  assert.match(conflict.textContent, /계획됨/);
  assert.match(conflict.textContent, /구현중/);
  assert.equal(conflict.querySelectorAll('button.mcards-pick').length, 2);
  await fire(byText(conflict, '디스코드 값 적용'), 'click');
  assert.deepEqual(ctx.calls[0], { id: '20261008-hab2', status: 'building', rev: 2 });
  assert.equal(conflict.querySelector('.mcards-reply').textContent, '반영됨');
});

test('touch pointer press gives transient pressed state to filter, expand and conflict and clears', async () => {
  const h = harness(clone(STATE));
  const chip = byText(h.container, '구현중');
  const expand = row(h.container, '20261012-d456').querySelector('.mcards-expand');
  const pick = conflictRow(h.container, '20261008-hab2').querySelector('.mcards-pick');
  assert.ok(chip);
  assert.ok(expand);
  assert.ok(pick);
  for (const el of [chip, expand, pick]) {
    await fire(el, 'pointerdown', { pointerType: 'touch' });
    assert.equal(el.classList.contains('mcards-touch-pressed'), true);
    await fire(el, 'pointerup');
    assert.equal(el.classList.contains('mcards-touch-pressed'), false);
    await fire(el, 'pointerdown', { pointerType: 'touch' });
    await fire(el, 'pointercancel');
    assert.equal(el.classList.contains('mcards-touch-pressed'), false);
    await fire(el, 'pointerdown', { pointerType: 'touch' });
    await fire(el, 'pointerleave');
    assert.equal(el.classList.contains('mcards-touch-pressed'), false);
    await fire(el, 'pointerdown', { pointerType: 'mouse' });
    assert.equal(el.classList.contains('mcards-touch-pressed'), false);
  }
  const ro = harness(clone(STATE), { live: false });
  const roPick = conflictRow(ro.container, '20261008-hab2').querySelector('.mcards-pick');
  assert.ok(roPick && roPick.disabled);
  await fire(roPick, 'pointerdown', { pointerType: 'touch' });
  assert.equal(roPick.classList.contains('mcards-touch-pressed'), false);
});

test('unreadable and deleted cards carry their chips', () => {
  const h = harness(clone(STATE));
  const chips = h.container.querySelectorAll('.mcards-chip').map(chip => chip.textContent);
  assert.ok(chips.includes('읽을 수 없음'));
  assert.ok(chips.includes('글 삭제됨'));
  assert.equal(row(h.container, '20261009-ab23').querySelector('select'), null);
});

for (const [discord, text] of [['pushed', '반영됨'], ['pending', '대기 중'], ['off', '디스코드 꺼짐'], ['conflict', '충돌']]) {
  test('a 200 reply with discord=' + discord + ' shows ' + text, async () => {
    const h = harness(oneCardState(baseCard), baseCtx({
      setStatus(id, status, rev) {
        assert.deepEqual({ id, status, rev }, { id: baseCard.id, status: 'done', rev: baseCard.rev });
        return { status: 200, body: { ok: true, rev: rev + 1, discord } };
      },
    }));
    const select = statusSelect(h.container, baseCard.id);
    select.value = 'done';
    await fire(select, 'change');
    const badge = row(h.container, baseCard.id).querySelector('.mcards-reply');
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, text);
  });
}

test('409 STALE reverts the pick, shows the re-read notice and asks for a refresh', async () => {
  let refreshes = 0;
  const h = harness(oneCardState(baseCard), baseCtx({
    setStatus() { return { status: 409, body: { ok: false, code: 'STALE', rev: 9 } }; },
    refresh() { refreshes++; },
  }));
  const select = statusSelect(h.container, baseCard.id);
  select.value = 'done';
  await fire(select, 'change');
  assert.equal(select.value, baseCard.status);
  assert.equal(row(h.container, baseCard.id).querySelector('.mcards-reply').textContent, '다른 곳에서 바뀌어 다시 불러왔어요');
  assert.equal(refreshes, 1);
});

test('canonical replies fixture declares the exact WRITE_FAILED reply', () => {
  const reply = REPLIES.replies.find((item) => item.status === 500);
  assert.ok(reply);
  assert.deepEqual(reply.body, { ok: false, code: 'WRITE_FAILED' });
});

test('500 WRITE_FAILED is an explicit save failure, keeps intent and does not auto retry', async () => {
  const writeFailed = REPLIES.replies.find((item) => item.status === 500);
  const calls = [];
  let waits = 0;
  const h = harness(oneCardState(baseCard), baseCtx({
    wait() { waits++; return Promise.resolve(); },
    setStatus(id, status, rev) {
      calls.push({ id, status, rev });
      return calls.length === 1
        ? { ...writeFailed, body: { ...writeFailed.body } }
        : { status: 200, body: { ok: true, rev: rev + 1, discord: 'pending' } };
    },
  }));
  const select = statusSelect(h.container, baseCard.id);
  select.value = 'done';
  await fire(select, 'change');

  assert.equal(calls.length, 1, 'no immediate or background retry');
  assert.equal(waits, 0, 'WRITE_FAILED never enters the BUSY wait path');
  assert.equal(select.value, 'done', 'the chosen status remains visible');
  assert.equal(select.disabled, false, 'an explicit later action remains possible');
  const badge = row(h.container, baseCard.id).querySelector('.mcards-reply');
  assert.match(badge.textContent, /저장하지 못했어요/);
  assert.notEqual(badge.textContent, '반영됨');
  assert.notEqual(badge.textContent, '대기 중');
  assert.notEqual(badge.textContent, '보내는 중…');

  select.value = 'held';
  await fire(select, 'change');
  assert.equal(calls.length, 2, 'the later explicit action sends one fresh request');
  assert.deepEqual(calls[1], { id: baseCard.id, status: 'held', rev: baseCard.rev });
  assert.equal(badge.textContent, '대기 중');
});

test('only the exact 500 WRITE_FAILED shape is the named save failure', async () => {
  const variants = [
    { status: 500, body: { ok: true, code: 'WRITE_FAILED' } },
    { status: 500, body: { ok: false, code: 'OTHER' } },
    { status: 500, body: { ok: false } },
  ];
  for (const variant of variants) {
    const h = harness(oneCardState(baseCard), baseCtx({ setStatus() { return variant; } }));
    const select = statusSelect(h.container, baseCard.id);
    select.value = 'done';
    await fire(select, 'change');
    assert.equal(select.value, baseCard.status, 'non-exact 500 reverts to authoritative status');
    assert.equal(row(h.container, baseCard.id).querySelector('.mcards-reply').textContent,
      '상태를 바꾸지 못했어요');
  }
});

test('409 BUSY retries once after Retry-After, then shows the success badge', async () => {
  const waits = [];
  let calls = 0;
  const h = harness(oneCardState(baseCard), baseCtx({
    wait(ms) { waits.push(ms); return Promise.resolve(); },
    setStatus(id, status, rev) {
      calls++;
      return calls === 1
        ? { status: 409, body: { ok: false, code: 'BUSY' }, retryAfterMs: 7 }
        : { status: 200, body: { ok: true, rev: rev + 1, discord: 'pending' } };
    },
  }));
  await fire(statusSelect(h.container, baseCard.id), 'change');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [7]);
  assert.equal(row(h.container, baseCard.id).querySelector('.mcards-reply').textContent, '대기 중');
});

test('a second 409 BUSY after the retry shows 잠시 뒤 다시 해 주세요', async () => {  let calls = 0;
  const h = harness(oneCardState(baseCard), baseCtx({
    wait() { return Promise.resolve(); },
    setStatus() { calls++; return { status: 409, body: { ok: false, code: 'BUSY' }, retryAfterMs: 1 }; },
  }));
  await fire(statusSelect(h.container, baseCard.id), 'change');
  assert.equal(calls, 2);
  assert.equal(row(h.container, baseCard.id).querySelector('.mcards-reply').textContent, '잠시 뒤 다시 해 주세요');
});

test('429 retries once after Retry-After, then shows the success badge', async () => {
  const waits = [];
  let calls = 0;
  const h = harness(oneCardState(baseCard), baseCtx({
    wait(ms) { waits.push(ms); return Promise.resolve(); },
    setStatus(id, status, rev) {
      calls++;
      return calls === 1
        ? { status: 429, body: { ok: false, code: 'BUSY' }, retryAfterMs: 11 }
        : { status: 200, body: { ok: true, rev: rev + 1, discord: 'conflict' } };
    },
  }));
  await fire(statusSelect(h.container, baseCard.id), 'change');
  assert.deepEqual(waits, [11]);
  assert.equal(row(h.container, baseCard.id).querySelector('.mcards-reply').textContent, '충돌');
});

test('a second 429 after the retry shows 잠시 뒤 다시 해 주세요', async () => {
  const h = harness(oneCardState(baseCard), baseCtx({
    wait() { return Promise.resolve(); },
    setStatus() { return { status: 429, body: { ok: false, code: 'BUSY' }, retryAfterMs: 1 }; },
  }));
  await fire(statusSelect(h.container, baseCard.id), 'change');
  assert.equal(row(h.container, baseCard.id).querySelector('.mcards-reply').textContent, '잠시 뒤 다시 해 주세요');
});

// Independent-review blockers B1-B3, reproduced with held promises instead of timers.
test('B1 queued retry stops after the same container becomes read-only', { timeout: 5000 }, async () => {
  const waitEntered = deferred();
  const barrier = deferred();
  const calls = [];
  const setStatus = (id, status, rev) => {
    calls.push({ id, status, rev });
    return { status: 429, body: { ok: false, code: 'BUSY' }, retryAfterMs: 1 };
  };
  const h = harness(oneCardState(baseCard), baseCtx({
    setStatus,
    wait() { waitEntered.resolve(); return barrier.promise; },
  }));
  const select = statusSelect(h.container, baseCard.id);
  select.value = 'done';
  const change = fire(select, 'change');
  await waitEntered.promise;
  h.BriefCards.mount(h.container, { live: false, setStatus });
  const callsAtReadonly = calls.length;
  assert.equal(statusSelect(h.container, baseCard.id).disabled, true);
  barrier.resolve();
  await change;
  assert.equal(calls.length, 1);
  assert.equal(calls.length - callsAtReadonly, 0);
});

test('B2 STALE feedback survives the requested re-read', { timeout: 5000 }, async () => {
  let refreshes = 0;
  const h = harness(oneCardState(baseCard), baseCtx({
    setStatus() { return { status: 409, body: { ok: false, code: 'STALE', rev: 9 } }; },
    refresh() {
      refreshes++;
      h.BriefCards.update(oneCardState({ ...baseCard, rev: 9, status: 'building' }));
    },
  }));
  const select = statusSelect(h.container, baseCard.id);
  select.value = 'done';
  await fire(select, 'change');
  const current = row(h.container, baseCard.id);
  const badge = current.querySelector('.mcards-reply');
  assert.equal(refreshes, 1);
  assert.equal(statusSelect(h.container, baseCard.id).value, 'building');
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '다른 곳에서 바뀌어 다시 불러왔어요');
});

test('B3 a live update during a pending write shows its reply in the current row', { timeout: 5000 }, async () => {
  const entered = deferred();
  const held = deferred();
  const calls = [];
  const h = harness(oneCardState(baseCard), baseCtx({
    setStatus(id, status, rev) {
      calls.push({ id, status, rev });
      entered.resolve();
      return held.promise;
    },
  }));
  const select = statusSelect(h.container, baseCard.id);
  select.value = 'done';
  const change = fire(select, 'change');
  await entered.promise;
  h.BriefCards.update(oneCardState({ ...baseCard, description: '설명 갱신' }));
  assert.equal(statusSelect(h.container, baseCard.id).value, 'done');
  const pending = row(h.container, baseCard.id).querySelector('.mcards-reply');
  assert.equal(pending.hidden, false);
  assert.ok(pending.textContent.length > 0);
  held.resolve({ status: 200, body: { ok: true, rev: 3, discord: 'pending' } });
  await change;
  const current = row(h.container, baseCard.id);
  const badge = current.querySelector('.mcards-reply');
  assert.equal(calls.length, 1);
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '대기 중');
  assert.equal(statusSelect(h.container, baseCard.id).value, 'done');
});

test('newer state revision is not overwritten by an older write success', { timeout: 5000 }, async () => {
  const entered = deferred();
  const held = deferred();
  const h = harness(oneCardState(baseCard), baseCtx({
    setStatus() { entered.resolve(); return held.promise; },
  }));
  const select = statusSelect(h.container, baseCard.id);
  select.value = 'done';
  const change = fire(select, 'change');
  await entered.promise;
  h.BriefCards.update(oneCardState({ ...baseCard, rev: 4, status: 'held', description: '새 상태' }));
  held.resolve({ status: 200, body: { ok: true, rev: 3, discord: 'pushed' } });
  await change;
  const current = row(h.container, baseCard.id);
  assert.equal(statusSelect(h.container, baseCard.id).value, 'held');
  assert.equal(current.querySelector('.mcards-reply').hidden, true);
});

test('a failed follow-up returns to the last acknowledged status', { timeout: 5000 }, async () => {
  let calls = 0;
  const h = harness(oneCardState(baseCard), baseCtx({
    setStatus() {
      calls++;
      return calls === 1
        ? { status: 200, body: { ok: true, rev: 3, discord: 'pending' } }
        : { status: 400, body: { ok: false, code: 'BAD_REQUEST' } };
    },
  }));
  const first = statusSelect(h.container, baseCard.id);
  first.value = 'done';
  await fire(first, 'change');
  const second = statusSelect(h.container, baseCard.id);
  second.value = 'held';
  await fire(second, 'change');
  assert.equal(statusSelect(h.container, baseCard.id).value, 'done');
  assert.equal(row(h.container, baseCard.id).querySelector('.mcards-reply').textContent, '상태를 바꾸지 못했어요');
});

test('a second change after a live update cannot create a second in-flight write', { timeout: 5000 }, async () => {
  const entered = deferred();
  const held = deferred();
  let calls = 0;
  const h = harness(oneCardState(baseCard), baseCtx({
    setStatus() { calls++; entered.resolve(); return held.promise; },
  }));
  const firstSelect = statusSelect(h.container, baseCard.id);
  firstSelect.value = 'done';
  const first = fire(firstSelect, 'change');
  await entered.promise;
  h.BriefCards.update(oneCardState({ ...baseCard, description: '동기화' }));
  const secondSelect = statusSelect(h.container, baseCard.id);
  secondSelect.value = 'held';
  const second = fire(secondSelect, 'change');
  await Promise.resolve();
  const callsBeforeRelease = calls;
  held.resolve({ status: 200, body: { ok: true, rev: 3, discord: 'pending' } });
  await Promise.all([first, second]);
  assert.equal(callsBeforeRelease, 1);
  assert.equal(calls, 1);
  assert.equal(statusSelect(h.container, baseCard.id).value, 'done');
  assert.equal(row(h.container, baseCard.id).querySelector('.mcards-reply').textContent, '대기 중');
});

test('mounting a different container stops the old view queued retry', { timeout: 5000 }, async () => {
  const waitEntered = deferred();
  const barrier = deferred();
  let calls = 0;
  const h = harness(oneCardState(baseCard), baseCtx({
    setStatus() { calls++; return { status: 429, body: { ok: false, code: 'BUSY' }, retryAfterMs: 1 }; },
    wait() { waitEntered.resolve(); return barrier.promise; },
  }));
  const select = statusSelect(h.container, baseCard.id);
  select.value = 'done';
  const change = fire(select, 'change');
  await waitEntered.promise;
  const other = h.doc.createElement('div');
  h.doc.body.appendChild(other);
  h.BriefCards.mount(other, baseCtx());
  h.BriefCards.update(oneCardState(baseCard));
  barrier.resolve();
  await change;
  assert.equal(calls, 1);
});

// r2 strict-CAS deltas: status/content/rev stay one snapshot; retries keep their revision;
// an A -> B -> A mount switch durably abandons the old operation.
test('R2-1 displayed snapshot and request revision stay atomic under an out-of-order read', { timeout: 5000 }, async () => {
  const requests = [];
  const remote = { rev: 4, status: 'held' };
  const h = harness(oneCardState(baseCard), baseCtx({
    setStatus(id, status, rev) {
      requests.push({ id, status, rev });
      if (rev !== remote.rev) return { status: 409, body: { ok: false, code: 'STALE', rev: remote.rev } };
      remote.rev += 1;
      remote.status = status;
      return { status: 200, body: { ok: true, rev: remote.rev, discord: 'pushed' } };
    },
  }));
  h.BriefCards.update(oneCardState({ ...baseCard, rev: 4, status: 'held' }));
  h.BriefCards.update(oneCardState({ ...baseCard, rev: 3, status: 'idea' }));
  const select = statusSelect(h.container, baseCard.id);
  const displayed = select.value;
  select.value = 'done';
  await fire(select, 'change');
  const request = requests[0];
  const badge = row(h.container, baseCard.id).querySelector('.mcards-reply').textContent;
  assert.equal(request.status, 'done');
  assert.ok(displayed === 'held' || displayed === 'idea');
  if (displayed === 'idea') {
    assert.equal(request.rev, 3);
    assert.equal(remote.rev, 4);
    assert.equal(remote.status, 'held');
    assert.equal(badge, '다른 곳에서 바뀌어 다시 불러왔어요');
  } else {
    assert.equal(request.rev, 4);
    assert.equal(remote.rev, 5);
    assert.equal(remote.status, 'done');
    assert.equal(badge, '반영됨');
  }
});

test('R2-2 a queued retry keeps the immutable operation revision', { timeout: 5000 }, async () => {
  const requests = [];
  let calls = 0;
  const remote = { rev: 4, status: 'held' };
  const waitEntered = deferred();
  const barrier = deferred();
  const h = harness(oneCardState(baseCard), baseCtx({
    setStatus(id, status, rev) {
      requests.push(rev);
      calls++;
      if (calls === 1) return { status: 429, body: { ok: false, code: 'BUSY' }, retryAfterMs: 1 };
      if (rev !== remote.rev) return { status: 409, body: { ok: false, code: 'STALE', rev: remote.rev } };
      remote.rev += 1;
      remote.status = status;
      return { status: 200, body: { ok: true, rev: remote.rev, discord: 'pushed' } };
    },
    wait() { waitEntered.resolve(); return barrier.promise; },
  }));
  const select = statusSelect(h.container, baseCard.id);
  select.value = 'done';
  const change = fire(select, 'change');
  await waitEntered.promise;
  h.BriefCards.update(oneCardState({ ...baseCard, rev: 4, status: 'held' }));
  barrier.resolve();
  await change;
  assert.deepEqual(requests, [2, 2]);
  assert.equal(remote.rev, 4);
  assert.equal(remote.status, 'held');
  assert.equal(statusSelect(h.container, baseCard.id).value, 'held');
  assert.equal(row(h.container, baseCard.id).querySelector('.mcards-reply').textContent, '다른 곳에서 바뀌어 다시 불러왔어요');
});

test('R2-3 A-to-B-to-A switch does not resurrect an abandoned retry', { timeout: 5000 }, async () => {
  const waitEntered = deferred();
  const barrier = deferred();
  let calls = 0;
  const ctxA = baseCtx({
    setStatus() { calls++; return { status: 429, body: { ok: false, code: 'BUSY' }, retryAfterMs: 1 }; },
    wait() { waitEntered.resolve(); return barrier.promise; },
  });
  const h = harness(oneCardState(baseCard), ctxA);
  const select = statusSelect(h.container, baseCard.id);
  select.value = 'done';
  const change = fire(select, 'change');
  await waitEntered.promise;
  const b = h.doc.createElement('div');
  h.doc.body.appendChild(b);
  h.BriefCards.mount(b, baseCtx());
  h.BriefCards.update(oneCardState(baseCard));
  h.BriefCards.mount(h.container, ctxA);
  barrier.resolve();
  await change;
  assert.equal(calls, 1);
});

test('503 shows the read-only notice and disables status picks', async () => {
  const h = harness(oneCardState(baseCard), baseCtx({ setStatus() { return { status: 503, body: { ok: false } }; } }));
  await fire(statusSelect(h.container, baseCard.id), 'change');
  assert.match(h.container.querySelector('.mcards-notice').textContent, /읽기 전용/);
  assert.equal(statusSelect(h.container, baseCard.id).disabled, true);
});

for (const status of [501, 504]) {
  test(status + ' shows 지금은 메멘토를 쓸 수 없어요 and disables status picks', async () => {
    const h = harness(oneCardState(baseCard), baseCtx({ setStatus() { return { status, body: { ok: false, code: status === 501 ? 'MEMENTO_UNAVAILABLE' : 'BAD_REQUEST' } }; } }));
    await fire(statusSelect(h.container, baseCard.id), 'change');
    assert.equal(h.container.querySelector('.mcards-notice').textContent, '지금은 메멘토를 쓸 수 없어요');
    assert.equal(statusSelect(h.container, baseCard.id).disabled, true);
  });
}

test('ctx.live false is a read-only view and disables status picks', () => {
  const h = harness(oneCardState(baseCard), { live: false });
  assert.match(h.container.querySelector('.mcards-notice').textContent, /읽기 전용/);
  assert.equal(statusSelect(h.container, baseCard.id).disabled, true);
});

test('no cards shows 아직 카드가 없어요', () => {
  const h = harness({ ...clone(STATE), cards: [] });
  assert.equal(h.container.querySelector('.mcards-empty').hidden, false);
  assert.equal(h.container.querySelector('.mcards-empty-text').textContent, '아직 카드가 없어요');
  assert.equal(h.container.querySelector('.mcards-table-wrap').hidden, true);
});

test('a filter with no match shows 조건에 맞는 카드가 없어요', async () => {
  const h = harness(clone(STATE));
  const search = h.container.querySelector('input.mcards-search-input');
  search.value = '없는 검색어';
  await fire(search, 'input');
  assert.equal(h.container.querySelector('.mcards-empty').hidden, false);
  assert.equal(h.container.querySelector('.mcards-empty-text').textContent, '조건에 맞는 카드가 없어요');
});

test('hostile card text stays a text node: zero img and zero script elements', t => {
  const evil = { ...baseCard, title: EVIL, description: '설명 <script>alert(2)</script>' };
  const h = harness(oneCardState(evil));
  const title = row(h.container, baseCard.id).querySelector('.mcards-card-title');
  assert.equal(title.textContent, EVIL);
  assert.equal(h.container.querySelectorAll('img').length, 0);
  assert.equal(h.container.querySelectorAll('script').length, 0);
  t.diagnostic(JSON.stringify({
    hostile: EVIL,
    titleText: title.textContent,
    imgCount: h.container.querySelectorAll('img').length,
    scriptCount: h.container.querySelectorAll('script').length,
  }));
});
