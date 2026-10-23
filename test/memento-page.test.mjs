import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeController } from './fixtures/controller-dom.mjs';
import { buildViewModel } from '../src/render.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/memento/board-state.v1.json', import.meta.url)));
const modules = ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'annotate', 'cards-view'];
const flush = () => new Promise(resolve => setImmediate(resolve));
function env(options = {}) { return makeController({ modules, ...options }); }
function open(e) {
  const rail = e.document.querySelector('[data-sh="view"][data-key="memento"]');
  assert.ok(rail, 'memento rail entry exists');
  e.fire(rail, 'click');
}
async function replyState(e, state = fixture) {
  const req = e.fetches.filter(f => f.url === '/memento/state').at(-1);
  assert.ok(req);
  req.resolve({ status: 200, ok: true, json: async () => structuredClone(state) });
  await flush();
}
const posts = e => e.fetches.filter(f => f.url === '/memento');
async function replyPost(req, status, body) {
  req.resolve({ status, json: async () => body });
  await flush();
}
test('one owner change keeps its complete request across BUSY; a later identical change starts a new operation', { timeout: 2000 }, async t => {
  const e = env();
  open(e);
  await replyState(e);
  let select = e.byId.main.querySelector('.mcards-status-select');
  select.value = 'done';
  e.fire(select, 'change');
  const first = JSON.parse(posts(e)[0].opts.body);
  assert.equal(first.id, fixture.cards[0].id);
  assert.equal(first.status, 'done');
  assert.equal(first.rev, fixture.cards[0].rev);
  await replyPost(posts(e)[0], 409, { ok: false, code: 'BUSY' });
  await replyState(e);
  e.advance(1000);
  await flush();
  assert.equal(posts(e).length, 2);
  const retry = JSON.parse(posts(e)[1].opts.body);
  assert.deepEqual(retry, first);
  // Qualified API replays its first handled BUSY reply for this same requestId.
  await replyPost(posts(e)[1], 409, { ok: false, code: 'BUSY' });
  await replyState(e);
  select = e.byId.main.querySelector('.mcards-status-select');
  select.value = 'done';
  e.fire(select, 'change');
  const later = JSON.parse(posts(e)[2].opts.body);
  assert.notEqual(later.requestId, first.requestId);
  assert.deepEqual({ ...later, requestId: first.requestId }, first);
  await replyPost(posts(e)[2], 500, { ok: false, code: 'WRITE_FAILED' });
  e.advance(20000);
  await flush();
  assert.equal(posts(e).length, 3, 'WRITE_FAILED does not schedule another operation');
  t.diagnostic(JSON.stringify({ ownerChangeEventsBeforeRetry: 1, first, retry, laterExplicitChange: later }));
});
test('real annotation consumes a heading drag click without changing the pending operation identity', { timeout: 2000 }, async t => {
  const e = env();
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [{ id: 'lead', headline: 'Existing conversation' }] });
  e.page.open('lead', 'ov');
  open(e);
  await replyState(e);
  let select = e.byId.main.querySelector('.mcards-status-select');
  select.value = 'done';
  e.fire(select, 'change');
  const first = JSON.parse(posts(e)[0].opts.body);
  await replyPost(posts(e)[0], 409, { ok: false, code: 'BUSY' });
  await replyState(e);
  const heading = e.byId.main.querySelector('.mcards-heading');
  e.fire(heading, 'mousedown', { clientX: 20, clientY: 20 });
  e.fire(heading, 'mousemove', { clientX: 40, clientY: 40 });
  const bandCreated = !!e.document.querySelector('.band');
  assert.equal(bandCreated, true, 'the actual annotation drag path is active');
  e.fire(heading, 'mouseup', { clientX: 40, clientY: 40 });
  assert.equal(e.document.querySelector('.band'), null);
  const consumed = e.fire(heading, 'click', { clientX: 40, clientY: 40 });
  assert.equal(consumed.stopped, true, 'the real annotation capture handler consumed the click');
  assert.equal(consumed.eventPhase, 0, 'dispatch ends even though document bubble was skipped');
  e.advance(1000);
  await flush();
  assert.equal(posts(e).length, 2);
  const retry = JSON.parse(posts(e)[1].opts.body);
  assert.deepEqual(retry, first);
  await replyPost(posts(e)[1], 409, { ok: false, code: 'BUSY' });
  await replyState(e);
  select = e.byId.main.querySelector('.mcards-status-select');
  select.value = 'done';
  e.fire(select, 'change');
  const later = JSON.parse(posts(e)[2].opts.body);
  assert.notEqual(later.requestId, first.requestId);
  assert.deepEqual({ ...later, requestId: first.requestId }, first);
  await replyPost(posts(e)[2], 500, { ok: false, code: 'WRITE_FAILED' });
  await replyState(e);
  e.advance(20000);
  await flush();
  assert.equal(posts(e).length, 3);
  assert.deepEqual(e.errors, []);
  t.diagnostic(JSON.stringify({ ownerStatusChangesBeforeRetry: 1, bandCreated, eventStopped: consumed.stopped,
    returnedEventPhase: consumed.eventPhase, first, retry, laterExplicitChange: later, errors: e.errors }));
});
test('queued retry retains its body despite another card, unrelated clicks, and ignored pending input', { timeout: 2000 }, async () => {
  const e = env();
  open(e);
  await replyState(e);
  const selects = e.byId.main.querySelectorAll('.mcards-status-select');
  for (const select of selects.slice(0, 2)) {
    select.value = 'done';
    e.fire(select, 'change');
  }
  assert.equal(posts(e).length, 1);
  const original = JSON.parse(posts(e)[0].opts.body);
  await replyPost(posts(e)[0], 429, { ok: false, code: 'BUSY' });
  await replyState(e);
  assert.equal(posts(e).length, 2, 'other card owns the shared POST slot');
  e.fire(e.byId.main.querySelector('.mcards-expand'), 'click');
  const pending = e.byId.main.querySelector('.mcards-status-select');
  pending.value = 'held';
  e.fire(pending, 'change'); // TASK14 ignores a new action while this card is pending.
  e.advance(1000);
  await flush();
  assert.equal(posts(e).length, 2, 'retry waits behind the other card');
  await replyPost(posts(e)[1], 500, { ok: false, code: 'WRITE_FAILED' });
  assert.equal(posts(e).length, 3);
  assert.deepEqual(JSON.parse(posts(e)[2].opts.body), original);
  await replyPost(posts(e)[2], 500, { ok: false, code: 'WRITE_FAILED' });
  e.advance(20000);
  await flush();
  assert.equal(posts(e).length, 3);
});
test('switching away cancels old retry ownership and remount starts a distinct operation', { timeout: 2000 }, async () => {
  const e = env();
  open(e);
  await replyState(e);
  let select = e.byId.main.querySelector('.mcards-status-select');
  select.value = 'done';
  e.fire(select, 'change');
  const old = JSON.parse(posts(e)[0].opts.body);
  await replyPost(posts(e)[0], 409, { ok: false, code: 'BUSY' });
  await replyState(e);
  e.fire(e.document.querySelector('[data-sh="view"][data-key="conv"]'), 'click');
  open(e);
  await replyState(e);
  select = e.byId.main.querySelector('.mcards-status-select');
  select.value = 'done';
  e.fire(select, 'change');
  const current = JSON.parse(posts(e)[1].opts.body);
  assert.notEqual(current.requestId, old.requestId);
  await replyPost(posts(e)[1], 409, { ok: false, code: 'BUSY' });
  await replyState(e);
  e.advance(1000);
  await flush();
  assert.equal(posts(e).length, 3, 'only the currently mounted operation retries');
  assert.deepEqual(JSON.parse(posts(e)[2].opts.body), current);
  await replyPost(posts(e)[2], 500, { ok: false, code: 'WRITE_FAILED' });
  assert.deepEqual(e.errors, []);
});
test('explicit conflict-button clicks each own an identity while their automatic retries retain it', { timeout: 2000 }, async () => {
  const e = env();
  open(e);
  await replyState(e);
  e.fire(e.byId.main.querySelector('.mcards-pick'), 'click');
  const first = JSON.parse(posts(e)[0].opts.body);
  await replyPost(posts(e)[0], 409, { ok: false, code: 'BUSY' });
  await replyState(e);
  e.advance(1000);
  await flush();
  assert.deepEqual(JSON.parse(posts(e)[1].opts.body), first);
  await replyPost(posts(e)[1], 409, { ok: false, code: 'BUSY' });
  await replyState(e);
  e.fire(e.byId.main.querySelector('.mcards-pick'), 'click');
  const later = JSON.parse(posts(e)[2].opts.body);
  assert.notEqual(later.requestId, first.requestId);
  assert.deepEqual({ ...later, requestId: first.requestId }, first);
  await replyPost(posts(e)[2], 500, { ok: false, code: 'WRITE_FAILED' });
});
test('two agent publications retain the mounted table, filters, and expanded card row', async () => {
  const e = env();
  open(e);
  await replyState(e);
  const main = e.byId.main, table = main.querySelector('.mcards-table');
  const search = main.querySelector('.mcards-search-input');
  search.value = fixture.cards[0].title;
  e.fire(search, 'input');
  const expand = main.querySelector('.mcards-expand');
  e.fire(expand, 'click');
  const detail = main.querySelector('.mcards-detail-row');
  assert.equal(detail.hidden, false);
  const writes = main.writes;
  for (const seq of [1, 2]) {
    e.advance(500);
    e.page.receive({ seq, generatedAt: seq, sessions: [{ id: 'agent', headline: 'publish ' + seq }] });
  }
  assert.equal(main.writes, writes);
  assert.equal(main.querySelector('.mcards-table'), table);
  assert.equal(main.querySelector('.mcards-search-input'), search);
  assert.equal(search.value, fixture.cards[0].title);
  assert.equal(main.querySelector('.mcards-detail-row'), detail);
  assert.equal(detail.hidden, false);
  assert.deepEqual(e.errors, []);
});
test('card status uses shared POST queue, token, stable body, and 016 failure channel without retry', async () => {
  const e = env();
  open(e);
  await replyState(e);
  const select = e.byId.main.querySelector('.mcards-status-select');
  select.value = 'done';
  e.fire(select, 'change');
  const req = e.fetches.filter(f => f.url === '/memento').at(-1);
  assert.ok(req);
  const sent = JSON.parse(req.opts.body);
  assert.deepEqual(Object.keys(sent).sort(), ['action', 'id', 'requestId', 'rev', 'status']);
  assert.equal(sent.action, 'setStatus');
  assert.equal(sent.id, fixture.cards[0].id);
  assert.equal(sent.rev, fixture.cards[0].rev);
  assert.equal(sent.status, 'done');
  assert.ok(sent.requestId);
  assert.equal(req.opts.headers['X-Board-Token'], 'tok-1');
  req.resolve({ status: 500, json: async () => ({ ok: false, code: 'WRITE_FAILED' }) });
  await flush();
  assert.equal(e.byId.main.querySelector('.mcards-reply').hidden, false);
  assert.match(e.byId.main.querySelector('.mcards-reply').className, /danger/);
  assert.equal(e.byId.main.querySelector('.mcards-status-select').value, 'done', 'intent remains selected');
  e.advance(20000);
  assert.equal(e.fetches.filter(f => f.url === '/memento').length, 1);
  assert.equal(e.reloads.length, 0);
});
test('state fetch occurs on opening, visible transition and focus; file mode never fetches or enables writes', async () => {
  const listeners = {};
  const e = env({ configure: ctx => { ctx.addEventListener = (type, fn) => { listeners[type] = fn; }; } });
  open(e);
  await replyState(e);
  e.document.listeners.visibilitychange({ type: 'visibilitychange' });
  assert.equal(e.fetches.filter(f => f.url === '/memento/state').length, 2);
  await replyState(e);
  listeners.focus();
  assert.equal(e.fetches.filter(f => f.url === '/memento/state').length, 3);
  await replyState(e);
  const file = env({ protocol: 'file:' });
  open(file);
  assert.equal(file.fetches.length, 0);
  assert.ok(file.byId.main.querySelector('.mcards-notice'));
  assert.equal(file.byId.main.querySelector('.mcards-notice').hidden, false);
});
test('memento writes serialize with the existing annotation/answer POST path and refresh after each reply', async () => {
  const e = env();
  open(e);
  await replyState(e);
  const selects = e.byId.main.querySelectorAll('.mcards-status-select');
  for (const select of selects.slice(0, 2)) {
    select.value = 'done';
    e.fire(select, 'change');
  }
  assert.equal(e.fetches.filter(f => f.url === '/memento').length, 1);
  const first = e.fetches.filter(f => f.url === '/memento')[0];
  first.resolve({ status: 500, json: async () => ({ ok: false, code: 'WRITE_FAILED' }) });
  await flush();
  assert.equal(e.fetches.filter(f => f.url === '/memento').length, 2);
  assert.equal(e.fetches.filter(f => f.url === '/memento/state').length, 2);
  const second = e.fetches.filter(f => f.url === '/memento')[1];
  assert.notEqual(JSON.parse(first.opts.body).requestId, JSON.parse(second.opts.body).requestId);
  second.resolve({ status: 200, json: async () => ({ ok: true, rev: 2, discord: 'pending' }) });
  await flush();
  assert.equal(e.fetches.filter(f => f.url === '/memento/state').length, 3);
});
test('memento API contents never enter a built view model', () => {
  const key = Symbol.for('omo.memento.api.v1');
  const prev = globalThis[key];
  globalThis[key] = { version: 1, state: () => fixture };
  try {
    const vm = buildViewModel({ sessions: [], cards: fixture.cards, original: 'private', notes: 'private' }, 1);
    const inspect = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        assert.ok(!['cards', 'original', 'notes'].includes(key), key);
        inspect(child);
      }
    };
    inspect(vm);
  } finally { if (prev === undefined) delete globalThis[key]; else globalThis[key] = prev; }
});
