// test/fixtures/controller-dom.mjs loads the page modules as the page does, icons.js first (src/render.mjs PAGE_JS), so the
// controller-level tests see the shipped icon markup. The no-icon fallback (every page module checks g.BriefIcons) keeps
// exactly one explicit test: the last one here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeController } from './fixtures/controller-dom.mjs';

const model = () => ({ seq: 1, generatedAt: 0, sessions: [{ id: 's1', title: 'Test', alive: true, briefSeq: 1, status: 'in_progress',
  changes: [{ text: 'row', truth: 'reported', applied: 'none' }], done: [], notes: [], decisions: [], answerKinds: ['annotation'] }] });
const RAIL = ['home', 'conv', 'inbox', 'plans', 'archive', 'settings'];
const railIcons = (e) => RAIL.map((key) => e.byId.rail.querySelector(`[data-sh="view"][data-key="${key}"] .sh-ri`).innerHTML);

test('controller fixture: the default page modules start with icons.js, as the page does', () => {
  const e = makeController();
  assert.equal(typeof e.ctx.BriefIcons?.icon, 'function', 'icons.js ran before the other page modules');
  e.page.receive(model());
  const icons = railIcons(e);
  assert.ok(icons.every((html) => /^<svg class="ic ic-rail[^"]*" aria-hidden="true" focusable="false"><use href="#i-[a-z-]+"><\/use><\/svg>$/.test(html)), icons.join('\n'));
  assert.ok(e.byId.tabs.querySelector('.sh-topen svg.ic use[href="#i-panel-left-open"]'), 'the tab bar opener carries its icon');
  assert.deepEqual(e.errors, []);
});

test('no-icon fallback (the one explicit test without icons.js): empty icon slots, labels kept, the shell still works', () => {
  const e = makeController({ modules: ['view', 'plan-view', 'convo-view', 'shell', 'annotate'] });
  assert.equal(e.ctx.BriefIcons, undefined);
  e.page.receive(model());
  assert.deepEqual(railIcons(e), RAIL.map(() => ''), 'every rail icon slot is empty');
  assert.equal(e.document.querySelectorAll('svg').length, 0, 'no icon markup anywhere');
  assert.deepEqual(RAIL.map((key) => e.byId.rail.querySelector(`[data-key="${key}"]`).getAttribute('aria-label')), ['홈', '대화', '수신함', '계획', '닫힌 창', '설정']);
  e.fire(e.byId.rail.querySelector('[data-sh="view"][data-key="inbox"]'), 'click');
  assert.equal(e.page.state.ui.view, 'inbox');
  e.page.open('s1', 'ov');
  assert.equal(e.byId.main.querySelector('.cv-page').getAttribute('data-sid'), 's1');
  assert.deepEqual(e.errors, []);
});
