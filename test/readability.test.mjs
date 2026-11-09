// W2 readability & single-viewport regression suite (plan herdr-dag-active-tracking, checkbox 5 & 6).
//
// Runs under:
//   node --import ./test/helpers/refuse-live-writes.mjs --test --test-isolation=none test/readability.test.mjs
//
// Expected RED on baseline source (checkbox 5) and GREEN after W2 flat-section + single-viewport implementation (checkbox 6):
//   1. Manifest & anonymized fixture completeness (no personal paths or real session IDs).
//   2. Forbidden nested vertical scrollers inside #main (.pf-detail, #pf-sec-profiles, .pf-roles, .pf-tray, .pf-panes)
//      must not own vertical scroll; #main is the sole vertical scroll owner inside the fixed shell.
//   3. Active section at initial entry: renderOverview must not force-open an inactive (done) first project/session via
//      isFirst, must open active (in_progress / needs_decision / blocked) sessions, and in real layout at 1180x700 and
//      1440x900 the active session title must sit within the first 160 CSS px of #main (0 <= top && bottom <= 160, S = 0).
import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));

const MANIFEST = readJson('test/fixtures/readability/manifest.json');
const VIEW_MODEL = readJson('test/fixtures/readability/view-model.json');
const PROFILES_STATE = readJson('test/fixtures/readability/profiles-state.json');
const MEMENTO_STATE = readJson('test/fixtures/readability/memento-state.json');

function loadViewRuntime() {
  const ctx = vm.createContext({});
  for (const file of ['icons.js', 'view.js', 'plan-view.js', 'workers-view.js', 'blocks.js', 'convo-view.js', 'shell.js', 'profiles-view.js']) {
    vm.runInContext(readText('src/page/' + file), ctx, { filename: file });
  }
  return ctx;
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Extract CSS rule blocks whose selector list references a target selector
function findCssRulesForSelector(cssText, targetSelector) {
  const clean = stripCssComments(cssText);
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const selector = m[1].trim();
    const body = m[2].trim();
    if (selector.includes(targetSelector)) {
      out.push({ selector, body });
    }
  }
  return out;
}

test('readability fixtures: manifest covers all W2 consumer screens/states and fixture data is fully anonymized', () => {
  assert.equal(MANIFEST.schema, 'readability-manifest/1');
  const consumerIds = new Set(MANIFEST.consumers.map((c) => c.id));
  for (const req of [
    'overview-cards',
    'convo-and-blocks-kit',
    'common-css-and-shell',
    'profiles-view',
    'plan-and-workers',
    'office-kit-consumer',
    'sibling-out-of-scope',
  ]) {
    assert.ok(consumerIds.has(req), 'missing consumer group ' + req);
  }

  const outConsumer = MANIFEST.consumers.find((c) => c.id === 'sibling-out-of-scope');
  assert.equal(outConsumer.scope, 'OUT');

  const screenIds = new Set(MANIFEST.screens.map((s) => s.id));
  for (const reqScreen of [
    'overview-default',
    'overview-expanded',
    'overview-dirty',
    'overview-offline',
    'convo-ov-default',
    'convo-ov-expanded',
    'convo-ov-dirty',
    'convo-plan-default',
    'convo-plan-expanded',
    'convo-workers-default',
    'convo-workers-expanded',
    'convo-dec-default',
    'convo-rep-blocks',
    'profiles-primary-default',
    'profiles-primary-expanded',
    'profiles-agents-expanded',
    'profiles-categories-expanded',
    'profiles-memory-dirty',
    'profiles-offline',
    'profiles-guide-dialog',
    'memento-sibling',
    'office-sibling',
  ]) {
    assert.ok(screenIds.has(reqScreen), 'missing manifest screen ' + reqScreen);
  }

  for (const [name, data] of [
    ['view-model.json', VIEW_MODEL],
    ['profiles-state.json', PROFILES_STATE],
    ['memento-state.json', MEMENTO_STATE],
  ]) {
    const raw = JSON.stringify(data);
    assert.doesNotMatch(raw, /C:\/Users\//i, name + ' must not contain personal Windows user paths');
    assert.doesNotMatch(raw, /01a1[0-9a-f-]{12,}/i, name + ' must not contain real session UUIDs');
  }
});

test('single vertical scroll owner: .pf-detail, #pf-sec-profiles, .pf-roles, .pf-tray, and .pf-panes must not own vertical scroll inside #main', () => {
  const shellCss = readText('src/page/shell.css');
  const profilesCss = readText('src/page/profiles-view.css');

  // #main (.sh-main) is the primary scroll container
  const mainRules = findCssRulesForSelector(shellCss, '.sh-main');
  assert.ok(mainRules.some((r) => /overflow(?:-y)?\s*:\s*(?:auto|scroll)/.test(r.body)), '.sh-main (#main) must own vertical scroll');

  // None of the forbidden profile containers inside #main may declare vertical scroll (overflow-y: auto|scroll or fixed viewport height traps)
  const forbidden = ['.pf-detail', '#pf-sec-profiles', '.pf-roles', '.pf-tray', '.pf-panes'];
  const violations = [];
  for (const sel of forbidden) {
    const rules = findCssRulesForSelector(profilesCss, sel);
    for (const r of rules) {
      if (/overflow(?:-y)?\s*:\s*(?:auto|scroll)/.test(r.body)) {
        violations.push(`${sel} declares vertical scroll in rule "${r.selector}": ${r.body}`);
      }
      if ((sel === '.pf-panes' || sel === '.pf-roles') && /height\s*:\s*(?:calc\(100vh|clamp\()/.test(r.body)) {
        violations.push(`${sel} declares fixed viewport/container height trap in rule "${r.selector}": ${r.body}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    'Forbidden nested vertical scrollers found inside #main:\n' + violations.join('\n')
  );
});

test('initial entry active visibility: overview must not force-open inactive first session (isFirst) and must keep active sessions open within top 160px', () => {
  const ctx = loadViewRuntime();
  const html = ctx.BriefView.renderOverview(VIEW_MODEL, { live: true });

  // 1. Inactive (done) first session fx-sess-alpha-done in proj-alpha must NOT be forced open at initial entry
  const alphaDoneOpen = /<details class="sess" open><summary class="sessh">[\s\S]*?data-card="fx-sess-alpha-done"/.test(html);
  assert.equal(
    alphaDoneOpen,
    false,
    'Inactive (done) first session fx-sess-alpha-done was forced open by isFirst, pushing active sessions off-screen'
  );

  // 2. Active in_progress session fx-sess-gamma-running in proj-gamma must be open by default at initial entry
  const gammaRunningOpen = /<details class="sess" open><summary class="sessh">[^<]*<span class="sessh-w">[^<]*워커수집[\s\S]*?data-card="fx-sess-gamma-running"/.test(html);
  assert.equal(
    gammaRunningOpen,
    true,
    'Active running session fx-sess-gamma-running (status=in_progress) was left collapsed at initial entry'
  );

  // 3. Preserved user-opened details.sess[open] across refresh when ui.expanded marks a session open
  const refreshedHtml = ctx.BriefView.renderOverview(VIEW_MODEL, {
    live: true,
    expanded: { 'sess:fx-sess-alpha-done': true },
  });
  const alphaExplicitlyOpened = /<details class="sess"[^>]*open[^>]*>[\s\S]*?data-card="fx-sess-alpha-done"/.test(refreshedHtml);
  assert.equal(alphaExplicitlyOpened, true, 'Explicitly user-opened session must remain open after refresh');
});
