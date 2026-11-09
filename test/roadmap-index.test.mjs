import './helpers/refuse-live-writes.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeController } from './fixtures/controller-dom.mjs';

const modules = ['icons', 'view', 'plan-view', 'roadmap-view', 'roadmap-index', 'roadmap-navigation', 'workers-view', 'convo-view', 'shell', 'annotate'];
const stage = (id) => ({
  id, label: id, goal: `${id} goal`, sourceId: 'source', requirementsKnown: true,
  requires: [], accepts: [], plans: [], progress: null, unknown: true,
});
const roadmaps = [
  { roadmapId: 'one', tracks: [{ id: 'A', label: '첫 주제', stageIds: ['A1', 'A2'] }], stages: [stage('A1'), stage('A2')] },
  { roadmapId: 'two', tracks: [{ id: 'B', label: '다른 주제', stageIds: ['B1'] }], stages: [stage('B1')] },
];
function setup(width = 1440) {
  const events = new Map();
  const e = makeController({ modules, configure(ctx) {
    ctx.innerWidth = width;
    const stack = [{}];
    ctx.history = {
      get state() { return stack.at(-1); },
      replaceState(value) { stack[stack.length - 1] = value; },
      pushState(value) { stack.push(value); },
      back() { stack.pop(); for (const fn of events.get('popstate') || []) fn({ state: stack.at(-1) }); },
    };
    ctx.addEventListener = (name, fn) => { const list = events.get(name) || []; list.push(fn); events.set(name, list); };
  } });
  e.page.receive({ seq: 1, gen: 30, sessions: [], roadmaps });
  e.fire(e.document.querySelector('#rail [data-key="plans"]'), 'click');
  return e;
}

test('hidden catalogue sidebar leaves mobile main interactive without changing sidebar preference', () => {
  const e = setup(390);
  assert.equal(e.app.querySelector('.sh-wrap').hasAttribute('inert'), false);
  assert.equal(e.app.querySelector('[data-shell]').getAttribute('data-peek'), 'false');
  assert.equal(e.page.state.ui.peek, true, 'stored overlay preference remains available on other views');
});

test('catalogue opens only the selected roadmap and restores list focus and scroll', () => {
  const e = setup();
  assert.equal(e.byId.main.querySelectorAll('.rmi-card').length, 2);
  assert.equal(e.byId.main.querySelectorAll('.rmi-stage').length, 0);
  const card = e.byId.main.querySelector('[data-id="one"]');
  e.byId.main.scrollTop = 144;
  e.fire(card, 'click');
  assert.deepEqual(e.byId.main.querySelectorAll('.rmi-stage').map(el => el.getAttribute('data-rm-stage')), ['A1', 'A2']);
  e.fire(e.byId.main.querySelector('[data-act="rmi-back"]'), 'click');
  assert.equal(e.byId.main.scrollTop, 144);
  assert.equal(e.document.activeElement.getAttribute('data-id'), 'one');
  assert.equal(e.errors.length, 0);
});

test('composition never selects a suggestion and completed search uses real titles', () => {
  const e = setup();
  e.fire(e.byId.main.querySelector('[data-act="rmi-find"]'), 'click');
  let input = e.byId['rmi-query'];
  e.fire(input, 'compositionstart');
  input.value = '다른';
  e.fire(input, 'input', { isComposing: true });
  e.fire(input, 'keydown', { key: 'Enter', isComposing: true });
  assert.equal(e.byId.main.querySelectorAll('.rmi-stage').length, 0);
  e.fire(input, 'compositionend');
  assert.equal(e.byId.main.querySelectorAll('.rmi-card').length, 1);
  input = e.byId['rmi-query'];
  e.fire(input, 'keydown', { key: 'ArrowDown' });
  e.fire(e.byId['rmi-query'], 'keydown', { key: 'Enter' });
  assert.deepEqual(e.byId.main.querySelectorAll('.rmi-stage').map(el => el.getAttribute('data-rm-stage')), ['B1']);
});

test('connected plans return to the selected roadmap without merging unrelated stages', () => {
  const e = setup();
  e.fire(e.byId.main.querySelector('[data-id="one"]'), 'click');
  e.fire(e.byId.main.querySelector('[data-act="rm-connected-plans"]'), 'click');
  assert.equal(e.byId.main.querySelectorAll('.rmi-stage').length, 0);
  e.fire(e.byId.main.querySelector('[data-act="rm-return-board"]'), 'click');
  assert.deepEqual(e.byId.main.querySelectorAll('.rmi-stage').map(el => el.getAttribute('data-rm-stage')), ['A1', 'A2']);
});

test('legacy snapshots report missing roadmap information rather than an empty registration', () => {
  const e = setup();
  e.page.receive({ seq: 2, gen: 30, sessions: [] });
  e.advance(600);
  assert.ok(e.byId.main.querySelector('.rm-legacy'));
  assert.equal(e.byId.main.querySelectorAll('.rmi-empty').length, 0);
  assert.ok(e.byId.main.querySelector('[data-act="rm-connected-plans"]'));
});

test('browser Back from an open stage sheet restores the catalogue without a vanished-stage alert', () => {
  const e = setup();
  e.byId.main.scrollTop = 144;
  e.fire(e.byId.main.querySelector('[data-id="one"]'), 'click');
  e.fire(e.byId.main.querySelector('[data-act="exp"]'), 'click');
  assert.ok(e.byId.main.querySelector('.rm-sheet-dialog[open]'));
  e.ctx.history.back();
  assert.equal(e.byId.main.querySelector('.rm-sheet-dialog[open]'), null);
  assert.equal(e.page.state.ui.roadmapSheetVanished, false);
  assert.equal(e.byId.main.querySelectorAll('.rmi-card').length, 2);
  assert.equal(e.document.activeElement.getAttribute('data-id'), 'one');
  assert.equal(e.byId.main.scrollTop, 144);
  assert.equal(e.byId.main.querySelector('.rm-catalogue').hasAttribute('inert'), false);
});
