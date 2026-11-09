import './helpers/refuse-live-writes.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp.mjs';
import { evaluateAudit, materializeFixture, runTransitionCases } from '../scripts/qa-roadmap.mjs';
import { makeController } from './fixtures/controller-dom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL_FIXTURE_PATH = path.join(ROOT, 'test/fixtures/roadmap/full.json');

function baseDomFromStages(stages) {
  return {
    stageIds: stages.map((s) => s.id),
    rows: stages.map((s, idx) => ({
      id: s.id,
      isReadyClass: Boolean(s.ready),
      badges: ['ready', 'decisionNeeded', 'blocked', 'unknown', 'held'].filter((k) => Boolean(s[k])),
      relTop: 60 + idx * 28,
      relBottom: 86 + idx * 28,
      height: 26,
    })),
    titleRelTop: 7,
    titleRelBottom: 29,
    titleWithinTop160: true,
    mainClientHeight: 656,
    mainScrollHeight: 874,
    sidewaysOverflow: false,
    docScrollsY: false,
    lastRowBottom: 782,
    deltaToLastPx: 126,
    scrollBudgetS: 1,
    nestedVerticalScrollers: [],
    occludedControls: [],
  };
}

test('full.json materializes all 25 original stages from source files through collector and model', async (t) => {
  const { dir } = tempDir(t, 'roadmap-qa-mat-');
  const mat = await materializeFixture(FULL_FIXTURE_PATH, dir);
  assert.equal(mat.expectedStages.length, 25);
  assert.equal(new Set(mat.expectedStages.map((s) => s.id)).size, 25);

  const dom = baseDomFromStages(mat.expectedStages);
  const audit = evaluateAudit(dom, mat.expectedStages, { filterKey: 'all', budgetMaxS: 1 });
  assert.equal(audit.pass, true);
  assert.equal(audit.rows, 25);
  assert.equal(audit.expectedStageCount, 25);
  assert.equal(audit.falseReady, 0);
  assert.equal(audit.categoryMismatch, 0);
  assert.equal(audit.forbiddenScroll, 0);
});

test('source-derived transitions and rendered DOM preserve exact readiness, hold, rejection, reopen, stale, reversed snapshot, and source change rules', async (t) => {
  const { dir } = tempDir(t, 'roadmap-qa-trans-');
  const { transitions, truthResults } = await runTransitionCases(dir);
  assert.equal(truthResults.length, 11);
  for (const row of truthResults) {
    assert.equal(row.pass, true, `truth case ${row.id}`);
  }

  const byId = new Map(transitions.map((tr) => [tr.id, tr]));
  assert.equal(byId.get('unasked_gate').stage.decisionNeeded, true);
  assert.equal(byId.get('unasked_gate').stage.ready, false);
  assert.equal(byId.get('open_gate').stage.decisionNeeded, true);
  assert.equal(byId.get('open_gate').stage.ready, false);
  assert.equal(byId.get('held_decision').stage.held, true);
  assert.equal(byId.get('held_decision').stage.decisionNeeded, false);
  assert.equal(byId.get('held_decision').stage.unknown, true);
  assert.equal(byId.get('held_decision').stage.ready, false);
  assert.equal(byId.get('rejected_decision').stage.blocked, true);
  assert.equal(byId.get('rejected_decision').stage.ready, false);
  assert.equal(byId.get('reopen_decision').stage.decisionNeeded, true);
  assert.equal(byId.get('reopen_decision').stage.ready, false);
  assert.equal(byId.get('approved_ready').stage.ready, true);
  assert.equal(byId.get('stale_ttl').stage.ready, false);
  assert.equal(byId.get('stale_ttl').stage.unknown, true);
  assert.equal(byId.get('reversed_snapshot_ignored').reversedWriteAccepted, false);
  assert.equal(byId.get('reversed_snapshot_ignored').stage.ready, true);
  assert.equal(byId.get('source_changed').errorCode, 'SOURCE_HASH');
  assert.equal(byId.get('source_changed').stage.ready, false);
  assert.equal(byId.get('source_changed').stage.unknown, true);

  const env = makeController({
    modules: ['icons', 'view', 'plan-view', 'roadmap-view', 'workers-view', 'convo-view', 'shell', 'annotate'],
  });
  for (let i = 0; i < transitions.length; i++) {
    const tr = transitions[i];
    env.page.state.appliedAt = 0;
    env.page.receive({ ...tr.vm, seq: i + 1, gen: 9 });
    if (i === 0) env.fire(env.document.querySelector('#rail [data-sh="view"][data-key="plans"]'), 'click');
    const stageEl = env.byId.main.querySelector('[data-rm-stage="S1"]');
    assert.ok(stageEl, `S1 rendered for ${tr.id}`);
    const hasReadyBadge = Boolean(stageEl.querySelector('[data-rm-badge="ready"]'));
    assert.equal(hasReadyBadge, tr.expected.ready, `rendered ready badge for ${tr.id}`);
  }
});

test('evaluateAudit self-tests fail on injected nested scroll, occlusion, missing row, and false ready', async (t) => {
  const { dir } = tempDir(t, 'roadmap-qa-detect-');
  const mat = await materializeFixture(FULL_FIXTURE_PATH, dir);

  const nestedDom = baseDomFromStages(mat.expectedStages);
  nestedDom.nestedVerticalScrollers = ['ul.rm-stages'];
  const nestedRes = evaluateAudit(nestedDom, mat.expectedStages, { filterKey: 'all', budgetMaxS: 1 });
  assert.equal(nestedRes.pass, false);
  assert.equal(nestedRes.forbiddenScroll, 1);

  const occludedDom = baseDomFromStages(mat.expectedStages);
  occludedDom.occludedControls = [{ label: '전체 25', cx: 913, cy: 62, hit: 'DIV' }];
  const occludedRes = evaluateAudit(occludedDom, mat.expectedStages, { filterKey: 'all', budgetMaxS: 1 });
  assert.equal(occludedRes.pass, false);
  assert.equal(occludedRes.occludedCount, 1);

  const missingDom = baseDomFromStages(mat.expectedStages);
  missingDom.rows = missingDom.rows.slice(1);
  missingDom.stageIds = missingDom.stageIds.slice(1);
  const missingRes = evaluateAudit(missingDom, mat.expectedStages, { filterKey: 'all', budgetMaxS: 1 });
  assert.equal(missingRes.pass, false);
  assert.equal(missingRes.missingRows, 1);

  const falseReadyDom = baseDomFromStages(mat.expectedStages);
  falseReadyDom.rows[0].isReadyClass = true;
  falseReadyDom.rows[0].badges.push('ready');
  const falseReadyRes = evaluateAudit(falseReadyDom, mat.expectedStages, { filterKey: 'all', budgetMaxS: 1 });
  assert.equal(falseReadyRes.pass, false);
  assert.equal(falseReadyRes.falseReady, 1);
});

test('expanded stage detail copy uses natural Korean without exposing requirementsKnown=false or null literals, and rail body rules use >=14px token floor', async (t) => {
  const { dir } = tempDir(t, 'roadmap-qa-copy-');
  const mat = await materializeFixture(FULL_FIXTURE_PATH, dir);
  const ctx = {};
  for (const file of ['icons.js', 'view.js', 'plan-view.js', 'roadmap-view.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/page', file), 'utf8'), ctx, { filename: file });
  }
  const r6bRoadmap = mat.vm.roadmaps.find((r) => r.stages.some((s) => s.id === 'R6b'));
  const html = ctx.BriefRoadmapView.render(mat.vm, {
    expanded: { [`rm-stage:${r6bRoadmap.roadmapId}:R6b`]: true },
  });
  assert.equal(html.includes('requirementsKnown=false'), false, 'must not expose internal requirementsKnown=false assignment');
  assert.equal(html.includes('미질문(null)'), false, 'must not expose literal null in unasked gate explanation');
  assert.equal(html.includes('요구사항 미확인'), true, 'keeps Korean unconfirmed requirement notice');
  assert.equal(html.includes('아직 질문하지 않음'), true, 'keeps Korean unasked gate notice');

  const css = fs.readFileSync(path.join(ROOT, 'src/page/roadmap-view.css'), 'utf8');

  // Verify approved desktop scale in base declarations
  for (const sel of ['.rm-card-title', '.rm-card-goal', '.rm-sheet-text', '.rm-banner']) {
    const rule = new RegExp(`\\${sel}\\s*\\{[^}]*font-size:\\s*(?:var\\(--fs-lg\\)|16px)`).test(css);
    assert.equal(rule, true, `${sel} uses approved body size (16px desktop)`);
  }
  for (const sel of ['.rm-sum', '.rm-field-lbl', '.rm-clear-btn', '.rm-col-cnt', '.rm-col-empty', '.rm-card-meta', '.rm-card-reason', '.rm-card-foot']) {
    const rule = new RegExp(`(?:^|,)\\s*\\${sel}[^{]*\\{[^}]*font-size:\\s*14px`, 'm').test(css);
    assert.equal(rule, true, `${sel} uses approved supporting/meta size (14px desktop)`);
  }
  assert.match(css, /\.rm-title\s*\{[^}]*font-size:\s*28px/, '.rm-title uses approved screen title size (28px desktop)');
  assert.match(css, /\.rm-title\s*\{[^}]*line-height:\s*34px/, '.rm-title uses approved screen title line-height (34px desktop)');
  for (const sel of ['.rm-col-title', '.rm-sec-title']) {
    assert.match(css, new RegExp(`\\${sel}\\s*\\{[^}]*font-size:\\s*22px`), `${sel} uses approved column/section heading size (22px desktop)`);
    assert.match(css, new RegExp(`\\${sel}\\s*\\{[^}]*line-height:\\s*28px`), `${sel} uses approved column/section heading line-height (28px desktop)`);
  }

  // Verify approved mobile scale under @media (max-width: 600px)
  const mobile600Block = css.match(/@media\s*\(max-width:\s*600px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(mobile600Block, 'has @media (max-width: 600px) block');
  const m600 = mobile600Block[1];

  assert.match(m600, /\.rm-title\s*\{[^}]*font-size:\s*37px/, 'mobile .rm-title uses approved 37px');
  assert.match(m600, /\.rm-title\s*\{[^}]*line-height:\s*44px/, 'mobile .rm-title uses approved 44px line-height');
  assert.match(m600, /\.rm-col-title\s*\{[^}]*font-size:\s*29px/, 'mobile .rm-col-title uses approved 29px');
  assert.match(m600, /\.rm-col-title\s*\{[^}]*line-height:\s*36px/, 'mobile .rm-col-title uses approved 36px line-height');
  assert.match(m600, /\.rm-sec-title[^}]*font-size:\s*29px/, 'mobile .rm-sec-title uses approved 29px');
  assert.match(m600, /\.rm-card-title[^}]*font-size:\s*22\.667px/, 'mobile card title uses approved 22.667px');
  assert.match(m600, /\.rm-card-goal[^}]*font-size:\s*22\.667px/, 'mobile card goal uses approved 22.667px');
  assert.match(m600, /\.rm-card-meta[^}]*font-size:\s*20px/, 'mobile card meta uses approved 20px');

  // Strict floor checks: no font size can ever be smaller than the approved scale floors
  // Screen title >= 28px desktop / >= 37px mobile
  // Column title >= 22px desktop / >= 29px mobile
  // Body text >= 16px desktop / >= 22.667px mobile
  // Supporting text >= 14px desktop / >= 20px mobile
  // Absolute floor: no font size below 12px anywhere in roadmap-view.css
  const declRegex = /font-size:\s*([^;!}]+)/g;
  let declMatch;
  while ((declMatch = declRegex.exec(css)) !== null) {
    const valStr = declMatch[1].trim();
    if (valStr.endsWith('px')) {
      const num = parseFloat(valStr);
      assert.ok(num >= 12, `font-size ${valStr} must be >= 12px absolute floor`);
    } else if (valStr.startsWith('var(--fs-')) {
      assert.ok(!valStr.includes('2xs') && !valStr.includes('xs') && !valStr.includes('sm'), `token ${valStr} must not be below --fs-base`);
    }
  }
  assert.equal(/--fs-2xs|--fs-xs/.test(css), false, 'roadmap-view.css does not assign 11px tokens to rail reading or supporting text');

  // Resolve all matching single-class rules in source order, including every
  // matching media block; do not assume the base value or first media block.
  function effectiveSize(selector, width) {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const stack = [];
    let cursor = 0, value;
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '{') {
        const head = source.slice(cursor, i).trim();
        stack.push({ head, start: i + 1 });
        cursor = i + 1;
      } else if (source[i] === '}') {
        const rule = stack.pop();
        if (!rule) throw new Error('unbalanced CSS');
        const active = stack.every(({ head }) => {
          const max = /max-width:\s*(\d+)px/.exec(head);
          const min = /min-width:\s*(\d+)px/.exec(head);
          return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
        });
        if (active && rule.head.split(',').some(s => s.trim() === selector)) {
          const match = /(?:^|;)\s*font-size:\s*([^;}]+)/.exec(source.slice(rule.start, i));
          if (match) value = match[1].trim();
        }
        cursor = i + 1;
      }
    }
    if (value === 'var(--fs-lg)') {
      const tokens = fs.readFileSync(path.join(ROOT, 'src/page/tokens.css'), 'utf8');
      value = /--fs-lg:\s*([^;]+)/.exec(tokens)?.[1].trim();
    }
    assert.ok(value?.endsWith('px'), `${selector} has a resolvable font-size at ${width}px: ${value}`);
    return parseFloat(value);
  }
  for (const width of [600, 601, 1024, 1440]) {
    const mobile = width <= 600;
    for (const [selector, expected] of [
      ['.rm-title', mobile ? 37 : 28],
      ['.rm-col-title', mobile ? 29 : 22],
      ['.rm-sec-title', mobile ? 29 : 22],
      ['.rm-card-title', mobile ? 22.667 : 16],
      ['.rm-card-goal', mobile ? 22.667 : 16],
      ['.rm-sheet-text', mobile ? 22.667 : 16],
      ['.rm-card-meta', mobile ? 20 : 14],
    ]) assert.equal(effectiveSize(selector, width), expected, `${selector} effective font-size at ${width}px`);
  }

  const navDir = path.join(dir, 'nav');
  const navMat = await materializeFixture(FULL_FIXTURE_PATH, navDir, { bindGate: true });
  assert.equal(typeof navMat.boundDecisionId, 'number');
  const navHtml = ctx.BriefRoadmapView.render(navMat.vm, {
    expanded: Object.fromEntries(navMat.vm.roadmaps.flatMap((r) => [
      [`rm-stage:${r.roadmapId}:R1b`, true],
      [`rm-stage:${r.roadmapId}:R6b`, true],
    ])),
  });
  assert.match(navHtml, /class="more rm-plan-go"/, 'bound plan fixture renders row plan navigation button');
  assert.match(navHtml, /class="more rm-plan-open"/, 'bound plan fixture renders detail plan navigation button');
  assert.match(navHtml, /class="more rm-dec-go"/, 'bound decision fixture renders detail decision navigation button');
});


test('pin: every roadmap interactive selector has >=44px min hit area', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/page/roadmap-view.css'), 'utf8');

  // 1. Search clear button
  assert.match(css, /\.rm-clear-btn\s*\{[^}]*min-height:\s*44px/, 'search clear button has min-height: 44px');
  assert.match(css, /\.rm-clear-btn\s*\{[^}]*min-width:\s*44px/, 'search clear button has min-width: 44px');

  // 2. Condition / session / card-header / copy .more buttons
  assert.match(
    css,
    /\.rm-cond\s+\.more[^}]*min-height:\s*44px/,
    'condition/plan/splan/card-head/copy buttons have min-height: 44px'
  );
  assert.match(
    css,
    /\.rm-cond\s+\.more[^}]*min-width:\s*44px/,
    'condition/plan/splan/card-head/copy buttons have min-width: 44px'
  );

  // 3. Connected-plan and candidate buttons
  assert.match(
    css,
    /\.rm-cplan-open,\s*\.rm-candidate-btn\s*\{[^}]*min-height:\s*44px/,
    'connected-plan and candidate buttons have min-height: 44px'
  );
  assert.match(
    css,
    /\.rm-cplan-open,\s*\.rm-candidate-btn\s*\{[^}]*min-width:\s*44px/,
    'connected-plan and candidate buttons have min-width: 44px'
  );

  // 4. Primary card, input, select, jump, and sheet buttons
  assert.match(css, /\.rm-input,\s*\.rm-select\s*\{[^}]*min-height:\s*var\(--hit\)/, 'inputs have min-height var(--hit)');
  assert.match(css, /\.rm-jump-btn\s*\{[^}]*min-height:\s*var\(--hit\)/, 'jump button has min-height var(--hit)');
  assert.match(css, /\.rm-card-btn\s*\{[^}]*min-height:\s*var\(--hit\)/, 'card button has min-height var(--hit)');
  assert.match(css, /\.rm-sheet-close-btn\s*\{[^}]*min-height:\s*44px/, 'sheet close button has min-height: 44px');
  assert.match(css, /\.rm-sheet-tab\s*\{[^}]*min-height:\s*44px/, 'sheet tab has min-height: 44px');
  assert.match(css, /\.rm-plans-btn,\s*\.rm-return-btn\s*\{[^}]*min-height:\s*var\(--hit\)/, 'plans and return buttons have min-height var(--hit)');
});

test('pin: card border and control boundaries use the >=3:1 token (--ctl-edge)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/page/roadmap-view.css'), 'utf8');

  // Card border must use --ctl-edge
  assert.match(css, /\.rm-card\s*\{[^}]*border:\s*1px\s+solid\s+var\(--ctl-edge\)/, 'card border uses --ctl-edge');

  // Jump button border must use --ctl-edge
  assert.match(css, /\.rm-jump-btn\s*\{[^}]*border:\s*1px\s+solid\s+var\(--ctl-edge\)/, 'jump button border uses --ctl-edge');

  // Plans & return button border must use --ctl-edge
  assert.match(css, /\.rm-plans-btn,\s*\.rm-return-btn\s*\{[^}]*border:\s*1px\s+solid\s+var\(--ctl-edge\)/, 'plans and return button border uses --ctl-edge');

  // Connected plan row border must use --ctl-edge
  assert.match(css, /\.rm-cplan-row\s*\{[^}]*border:\s*1px\s+solid\s+var\(--ctl-edge\)/, 'connected plan row border uses --ctl-edge');
});

test('pin: <=600 single-column rule and responsive breakpoints exist', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/page/roadmap-view.css'), 'utf8');

  // 1. @media (max-width: 600px) block
  const m600 = css.match(/@media\s*\(max-width:\s*600px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m600, 'has @media (max-width: 600px) block');

  // Single column rule
  assert.match(m600[1], /\.rm-board\s*\{[^}]*display:\s*block/, 'mobile .rm-board is display: block');
  assert.match(m600[1], /\.rm-col\s*\{[^}]*display:\s*none/, 'mobile .rm-col is hidden by default');
  assert.match(m600[1], /\.rm-col\.rm-col-active\s*\{[^}]*display:\s*block/, 'active mobile .rm-col is displayed');

  // Status select field is shown on <=600
  assert.match(m600[1], /\.rm-status-field\s*\{[^}]*display:\s*flex/, 'mobile shows status select');

  // Sheet is full width
  assert.match(css, /\.rm-sheet-container\s*\{[^}]*width:\s*100vw/, 'mobile sheet is full width (100vw)');

  // 2. Breakpoints map check
  assert.ok(css.includes('@media (max-width: 1180px)'), 'has 1180px breakpoint');
  assert.ok(css.includes('@media (max-width: 1024px)'), 'has 1024px breakpoint');
  assert.ok(css.includes('@media (max-width: 600px)'), 'has 600px breakpoint');
  assert.ok(css.includes('@media (max-width: 390px)'), 'has 390px breakpoint');
});
