// view.js wiring of the generation-4 blocks: plan block / link, worker lines, header sound button. The block renderers are
// separate classic scripts; a page without them draws exactly the old card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (n) => readFileSync(new URL(`../src/page/${n}`, import.meta.url), 'utf8');
const load = (names) => {
  const g = { console: { warn() {}, error() {} } };
  vm.createContext(g);
  for (const n of names) vm.runInContext(read(n), g, { filename: n });
  return g;
};
const plan = JSON.parse(readFileSync(new URL('./fixtures/view-model-plan.json', import.meta.url), 'utf8'));
const live = { workers: [
  { id: 'st_a', name: '조사', kind: 'explore', model: 'Sol', state: 'running', step: '읽는 중', startedAt: 1_700_000_000_000, updatedAt: 1_700_000_050_000 },
  { id: 'st_b', name: '구현', kind: 'impl', model: 'Sol', state: 'done', step: '', startedAt: 1_700_000_000_000, endedAt: 1_700_000_040_000, updatedAt: 1_700_000_040_000 },
] };
const card = (id, extra) => ({ id, project: 'p', title: id, status: 'in_progress', statusKey: 'in_progress', tab: '진행 중', chips: [], headline: 'h', decisions: [], changes: [], done: [], flow: [], lastActivityAt: 1_700_000_000_000, ...extra });
const model = (sessions) => ({ schema: 1, seq: 1, generatedAt: 1_700_000_060_000, summary: {}, readErrors: [], sessions });
const ALL = ['view.js', 'plan-view.js', 'workers-view.js', 'alarm.js'];

test('a card with live workers and a plan draws both blocks under its headline; the header carries the sound button', () => {
  const g = load(ALL);
  const html = g.BriefView.renderApp(model([card('owner', { live, plan })]), { wallNow: 1_700_000_060_000, expanded: {} });
  assert.ok(html.includes('data-worker="st_a"') && html.includes('data-worker="st_b"'));
  assert.ok(html.includes('data-plan="p123456789abc"'));
  assert.ok(html.indexOf('class="hl"') < html.indexOf('data-worker=') && html.indexOf('data-worker=') < html.indexOf('data-plan='), 'headline, workers, plan');
  assert.ok(html.includes('data-alarm-sound'));
  assert.ok(html.includes('data-act="exp"') && html.includes('data-key="plan:p123456789abc"'), 'plan expansion rides the existing exp channel');
});

test('the worker block follows the wall clock given by the page, not the age of the data', () => {
  const g = load(ALL);
  const a = g.BriefView.renderApp(model([card('c', { live })]), { wallNow: 1_700_000_060_000, expanded: {} });
  const b = g.BriefView.renderApp(model([card('c', { live })]), { wallNow: 1_700_000_060_600, expanded: {} });
  const delay = (h) => /animation-delay:\s*(-?\d+)ms/.exec(h)[1];
  assert.notEqual(delay(a), delay(b));
});

test('an execution conversation shows a one-line link to the owner card (its DOM id and tab), not the plan', () => {
  const g = load(ALL);
  const link = { planId: 'p123456789abc', ownerId: 'owner', source: { slug: 'living-board' }, stage: 'running', goal: '목표' };
  const html = g.BriefView.renderApp(model([card('owner', { plan }), card('runner', { planLink: link })]), { expanded: {} });
  const dom = /id="(c-owner-0)"/.exec(html)[1];
  assert.ok(html.includes(`data-goto="${dom}"`));
  assert.equal((html.match(/data-plan="/g) ?? []).length, 1, 'the plan is drawn once');
  assert.equal((html.match(/class="plan-link"/g) ?? []).length, 1);
});

test('without the block scripts the card is drawn as before (no blocks, no button, no error)', () => {
  const g = load(['view.js']);
  const html = g.BriefView.renderApp(model([card('owner', { live, plan, planLink: { ownerId: 'x' } })]), { expanded: {} });
  assert.ok(!html.includes('data-worker') && !html.includes('data-plan') && !html.includes('data-alarm-sound') && !html.includes('plan-link'));
  assert.ok(html.includes('data-card="owner"'));
});

test('hostile text in live rows and the plan stays escaped through the view', () => {
  const g = load(ALL);
  const evil = '<img src=x onerror=alert(1)>';
  const html = g.BriefView.renderApp(model([card('o', { live: { workers: [{ ...live.workers[0], name: evil, step: evil }] }, plan: { ...plan, goal: evil } })]), { expanded: {} });
  assert.ok(!html.includes('<img src=x'));
});
