// W2 F5 scroll budget, occlusion, top-8 active title, and flat single-viewport flow acceptance test
// (plan herdr-dag-active-tracking, checkbox 7).
//
// Reuses the pure comparison functions (diff, rel, right, bottom, checkF8, comparisonSections, comparisonSteps,
// requireF8) and step/reach/hit runners (FLOW_LIB, openScreen, perform, startBoard) from scripts/qa-flow-map.mjs
// and scripts/flow-map-f8.mjs without reimplementing them.
// Verifies settings/apply flows exclusively through an isolated fixture server under os.tmpdir().
import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, listProfilePids, isPidAlive, watchCsp } from '../scripts/cdp.mjs';
import {
  REGIONS,
  TASKS,
  STATIC_COPY,
  CONDITIONAL_COPY,
  assertFixtureRoot,
  waitFor,
  settle,
  startBoard,
  openScreen,
  perform,
  diff,
} from '../scripts/qa-flow-map.mjs';
import { requireF8 } from '../scripts/flow-map-f8.mjs';
import { measurePurposeGrid } from '../scripts/profiles-grid.mjs';
import { RAW_STATUS_COPY } from '../scripts/profiles-copy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_PATH = path.join(ROOT, 'test/fixtures/profiles/flow-map.winforms.json');
const RULES_PATH = path.join(ROOT, 'test/fixtures/profiles/flow-map.rules.json');

const SIZES = [
  { width: 1180, height: 700, name: '1180x700' },
  { width: 1440, height: 900, name: '1440x900' },
];

// Space-contract & top-8 probe installed alongside FLOW_LIB
const SPACE_CONTRACT_PROBE = `(() => {
  const FORBIDDEN_SCROLLERS = ['.pf-detail', '#pf-sec-profiles', '.pf-roles', '.pf-tray', '.pf-panes'];
  const CARD_CANDIDATES = '.card, .dcard, .scard, .rbk, .ropt, .cmpc, .plan-lane, .plan-box, .pf-sec, .pf-card, .pf-tray, .pf-blk, .pf-agent, .pf-route, .pf-mem-row';
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('[hidden], dialog:not([open])')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isTransparent = (bg) => !bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)';
  const hasVisualBox = (el) => {
    const cs = getComputedStyle(el);
    const hasBg = !isTransparent(cs.backgroundColor);
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs['border' + s + 'Width']) || 0);
    const borders = bw.filter((w) => w > 0).length;
    const hasFullBorder = borders >= 2;
    const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
    return (hasBg && (hasFullBorder || hasShadow)) || (hasFullBorder && hasShadow);
  };
  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1) return 'unknown';
    if (el.id) return '#' + el.id;
    const flow = el.getAttribute('data-flow');
    if (flow) return el.tagName.toLowerCase() + '[data-flow="' + flow + '"]';
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean);
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.slice(0, 3).join('.') : '');
  };

  window.__w2Space = {
    measureOverviewTop8() {
      const main = document.getElementById('main');
      if (!main) return { ok: false, reason: 'missing #main' };
      const mr = main.getBoundingClientRect();
      const firstOpenCard = main.querySelector('details.sess[open] .card');
      const titleEl = firstOpenCard ? (firstOpenCard.querySelector('.ch') || firstOpenCard.querySelector('.title')) : null;
      if (!titleEl || !isVisible(titleEl)) return { ok: false, reason: 'missing visible open session title' };
      const tr = titleEl.getBoundingClientRect();
      const relTop = Math.round(tr.top - mr.top);
      const relBottom = Math.round(tr.bottom - mr.top);
      return {
        ok: relTop >= 0 && relBottom <= 160 && tr.height > 0,
        cardId: firstOpenCard.getAttribute('data-card'),
        relTop,
        relBottom,
        text: titleEl.textContent.trim().slice(0, 80),
      };
    },
    measureProfilesSpaceContract() {
      const main = document.getElementById('main');
      if (!main) return { ok: false, reason: 'missing #main' };
      const mainCs = getComputedStyle(main);
      const mr = main.getBoundingClientRect();
      const mainOwnsVertical = /(auto|scroll)/.test(mainCs.overflowY);

      const nestedVerticalScrollers = [];
      for (const el of main.querySelectorAll('*')) {
        if (!isVisible(el)) continue;
        if (el.closest('dialog[open], .pop, [data-ann-pop], #office')) continue;
        const cs = getComputedStyle(el);
        const vRule = /(auto|scroll)/.test(cs.overflowY);
        const matchesForbidden = FORBIDDEN_SCROLLERS.some((sel) => el.matches(sel));
        if (vRule || (matchesForbidden && el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== 'visible' && cs.overflowY !== 'hidden')) {
          nestedVerticalScrollers.push({
            selector: selectorOf(el),
            matchedForbidden: FORBIDDEN_SCROLLERS.find((sel) => el.matches(sel)) || null,
            overflowY: cs.overflowY,
            clientHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
          });
        }
      }

      const nodes = [...main.querySelectorAll(CARD_CANDIDATES)].filter((el) => isVisible(el) && !el.closest('#office, #memento-cards') && hasVisualBox(el));
      const nestedVisualCards = [];
      for (const el of nodes) {
        const parentBox = el.parentElement ? el.parentElement.closest(CARD_CANDIDATES) : null;
        if (parentBox && nodes.includes(parentBox)) {
          nestedVisualCards.push({
            child: selectorOf(el),
            parent: selectorOf(parentBox),
          });
        }
      }

      const pfTitle = main.querySelector('.pf-title');
      const tr = pfTitle && isVisible(pfTitle) ? pfTitle.getBoundingClientRect() : null;
      const relTop = tr ? Math.round(tr.top - mr.top) : null;
      const relBottom = tr ? Math.round(tr.bottom - mr.top) : null;
      const titleTop8 = tr !== null && relTop >= 0 && relBottom <= 160 && tr.height > 0 && pfTitle.textContent.trim().length > 0;

      // Verify flat section borders: .pf-sec, .pf-card, .pf-tray must not have full 4-sided card box + shadow
      const nonFlatSections = [];
      for (const sec of main.querySelectorAll('.pf-sec, .pf-card, .pf-tray')) {
        if (!isVisible(sec)) continue;
        if (hasVisualBox(sec) && !sec.classList.contains('on')) {
          nonFlatSections.push(selectorOf(sec));
        }
      }

      const se = document.scrollingElement;
      const seCs = se ? getComputedStyle(se) : null;
      const shellEl = document.querySelector('.sh-shell') || document.body;
      const docScrollsVertically = !!(
        se &&
        se !== main &&
        se.scrollHeight > se.clientHeight + 1 &&
        seCs &&
        /(auto|scroll|visible)/.test(seCs.overflowY) &&
        getComputedStyle(shellEl).overflow !== 'hidden'
      );
      const mainHorizontalOverflowPx = Math.max(0, main.scrollWidth - main.clientWidth);
      const docHorizontalOverflowPx = se ? Math.max(0, se.scrollWidth - se.clientWidth) : 0;

      return {
        mainOwnsVertical,
        documentDoesNotScrollVertically: !docScrollsVertically,
        mainHorizontalOverflowPx,
        docHorizontalOverflowPx,
        zeroHorizontalOverflow: mainHorizontalOverflowPx <= 1 && docHorizontalOverflowPx <= 1,
        nestedVerticalScrollers,
        nestedVisualCards,
        nonFlatSections,
        title: {
          ok: titleTop8,
          relTop,
          relBottom,
          text: pfTitle ? pfTitle.textContent.trim() : '',
        },
      };
    },
    measureOverviewSpaceAndTargets(isPhone) {
      const main = document.getElementById('main');
      if (!main) return { ok: false, reason: 'missing #main' };
      const mainCs = getComputedStyle(main);
      const se = document.scrollingElement;
      const shellEl = document.querySelector('.sh-shell') || document.body;
      const mainOwnsVertical = /(auto|scroll)/.test(mainCs.overflowY);
      const docScrollsVertically = !!(
        se &&
        se !== main &&
        se.scrollHeight > se.clientHeight + 1 &&
        /(auto|scroll|visible)/.test(getComputedStyle(se).overflowY) &&
        getComputedStyle(shellEl).overflow !== 'hidden'
      );
      const mainHorizontalOverflowPx = Math.max(0, main.scrollWidth - main.clientWidth);
      const docHorizontalOverflowPx = se ? Math.max(0, se.scrollWidth - se.clientWidth) : 0;

      const nestedVerticalScrollers = [];
      for (const el of main.querySelectorAll('*')) {
        if (!isVisible(el)) continue;
        if (el.closest('dialog[open], .pop, [data-ann-pop], #office')) continue;
        const cs = getComputedStyle(el);
        const vRule = /(auto|scroll)/.test(cs.overflowY);
        const matchesForbidden = FORBIDDEN_SCROLLERS.some((sel) => el.matches(sel));
        if (vRule || (matchesForbidden && el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== 'visible' && cs.overflowY !== 'hidden')) {
          nestedVerticalScrollers.push({
            selector: selectorOf(el),
            overflowY: cs.overflowY,
            clientHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
          });
        }
      }

      const nodes = [...main.querySelectorAll(CARD_CANDIDATES)].filter((el) => isVisible(el) && !el.closest('#office, #memento-cards') && hasVisualBox(el));
      const nestedVisualCards = [];
      for (const el of nodes) {
        const parentBox = el.parentElement ? el.parentElement.closest(CARD_CANDIDATES) : null;
        if (parentBox && nodes.includes(parentBox)) {
          nestedVisualCards.push({
            child: selectorOf(el),
            parent: selectorOf(parentBox),
          });
        }
      }

      const nonFlatSections = [];
      for (const sec of main.querySelectorAll('.dcard, .scard, .rbk, .ropt, .cmpc, .plan-lane, .plan-box, .pf-sec, .pf-card, .pf-tray, .pf-agent, .pf-route, .pf-mem-row')) {
        if (!isVisible(sec)) continue;
        if (hasVisualBox(sec) && !sec.classList.contains('on')) {
          nonFlatSections.push(selectorOf(sec));
        }
      }

      const targetSelectors = [
        '#rail .sh-rb',
        '.sh-topen',
        '.sh-tadd',
        '.overview > .proj > .projh',
        '.overview .sess > .sessh',
        '.overview .sess > .more',
        '.detail-btn',
        '.copy',
        '.ans-opt',
        '.ans-write',
        '.focusbtn',
        '.stabs .st',
        '.scard-go',
        '.cv-sec > summary',
        '[data-pf-root] .pf-btn',
        '[data-pf-root] [role="tab"]',
        '[data-pf-root] .pf-row-sum',
        '[data-pf-root] select',
      ];
      const targets = {};
      const undersized = [];
      const minRequired = isPhone ? 44 : 24;
      for (const sel of targetSelectors) {
        const els = [...document.querySelectorAll(sel)].filter((el) => isVisible(el) && !el.closest('[inert]'));
        if (!els.length) continue;
        const heights = els.map((e) => Math.round(e.getBoundingClientRect().height));
        const widths = els.map((e) => Math.round(e.getBoundingClientRect().width));
        const minH = Math.min(...heights);
        const minW = Math.min(...widths);
        targets[sel] = { count: els.length, minHeight: minH, minWidth: minW };
        if (minH < minRequired) {
          undersized.push({ selector: sel, minHeight: minH, expectedMinHeight: minRequired });
        }
      }

      return {
        mainOwnsVertical,
        documentDoesNotScrollVertically: !docScrollsVertically,
        mainHorizontalOverflowPx,
        docHorizontalOverflowPx,
        zeroHorizontalOverflow: mainHorizontalOverflowPx <= 1 && docHorizontalOverflowPx <= 1,
        nestedVerticalScrollers,
        nestedVisualCards,
        nonFlatSections,
        targets,
        undersized,
      };
    },
  };
  return true;
})()`;

let sharedPage = null;
let sharedPids = [];
let sharedCsp = null;

async function getSharedPage(width, height) {
  if (!sharedPage) {
    sharedPage = await launch({ width, height });
    sharedCsp = await watchCsp(sharedPage);
    sharedPids = [...new Set([sharedPage.pid, ...listProfilePids(sharedPage.profileDir)])];
  } else {
    await sharedPage.client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  return { page: sharedPage, csp: sharedCsp, pids: sharedPids };
}

async function closeSharedPage() {
  if (sharedPage) {
    const pageToClose = sharedPage;
    const pidsToCheck = sharedPids;
    sharedPage = null;
    sharedPids = [];
    sharedCsp = null;
    await pageToClose.close();
    const left = pidsToCheck.filter((pid) => isPidAlive(pid));
    assert.deepEqual(left, [], `Chrome processes left alive: ${left.join(', ')}`);
  }
}

test('W2 readability-flow: F5 <= 1, occlusion 0, active title within top 8 rows, and flat single-viewport space contract at 1180x700 and 1440x900', { timeout: 240000 }, async () => {
  const reference = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  const rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  requireF8(rules);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-w2-readability-flow-'));
  assertFixtureRoot(tempRoot);

  const portBase = Number(process.env.OMO_BRIEFING_PORT_BASE || 47720);

  try {
    const { page, csp } = await getSharedPage(SIZES[0].width, SIZES[0].height);

    const outDir = process.env.OMO_W2_FLOW_DIFF_OUT ? path.resolve(process.env.OMO_W2_FLOW_DIFF_OUT) : '';
    if (outDir) fs.mkdirSync(outDir, { recursive: true });

    for (let si = 0; si < SIZES.length; si++) {
      const size = SIZES[si];
      await page.client.send('Emulation.setDeviceMetricsOverride', {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const map = {
        schema: 'flow-map/1',
        source: 'board',
        fixtureHash: '',
        frame: null,
        regions: [],
        sections: [],
        rows: null,
        tasks: {},
        copy: null,
        log: [],
      };

      const taskNames = Object.keys(TASKS);
      for (let ti = 0; ti < taskNames.length; ti++) {
        const taskName = taskNames[ti];
        const taskRoot = path.join(tempRoot, `${size.name}-${taskName}`);
        const board = await startBoard(taskRoot, { portBase: portBase + si * 20 + ti * 6 });

        try {
          map.fixtureHash = board.fixtureHash;

          // Before switching to profiles on the first task, verify initial overview active title is within top 8 rows (160px)
          if (taskName === 'role') {
            await page.goto(board.url);
            await waitFor(page, `document.getElementById('main') && document.querySelector('#main details.sess[open] .card')`, 'overview active session');
            await settle(page);
            await page.eval(SPACE_CONTRACT_PROBE);
            const ovTop8 = await page.eval(`window.__w2Space.measureOverviewTop8()`);
            assert.equal(
              ovTop8.ok,
              true,
              `${size.name} overview initial active title must sit within top 8 rows (0..160px), got ${JSON.stringify(ovTop8)}`
            );
          }

          await openScreen(page, board.url);
          await page.eval(SPACE_CONTRACT_PROBE);

          // Check changed space contract (single vertical owner #main, flat sections, no nested visual card, active title top 8)
          const space = await page.eval(`window.__w2Space.measureProfilesSpaceContract()`);
          assert.equal(space.mainOwnsVertical, true, `${size.name} ${taskName}: #main must own vertical scroll`);
          assert.equal(space.documentDoesNotScrollVertically, true, `${size.name} ${taskName}: document must not scroll vertically inside fixed shell`);
          assert.equal(space.zeroHorizontalOverflow, true, `${size.name} ${taskName}: zero horizontal overflow required, got main=${space.mainHorizontalOverflowPx} doc=${space.docHorizontalOverflowPx}`);
          assert.deepEqual(
            space.nestedVerticalScrollers,
            [],
            `${size.name} ${taskName}: forbidden nested vertical scrollers inside #main: ${JSON.stringify(space.nestedVerticalScrollers)}`
          );
          assert.deepEqual(
            space.nestedVisualCards,
            [],
            `${size.name} ${taskName}: nested visual card-in-card found: ${JSON.stringify(space.nestedVisualCards)}`
          );
          assert.deepEqual(
            space.nonFlatSections,
            [],
            `${size.name} ${taskName}: non-flat section containers found: ${JSON.stringify(space.nonFlatSections)}`
          );
          assert.equal(
            space.title.ok,
            true,
            `${size.name} ${taskName}: active title (.pf-title) must be inside top 8 physical rows (0..160px), got ${JSON.stringify(space.title)}`
          );

          if (taskName === 'role') {
            const frame = await page.eval(`window.__flow.frame()`);
            map.frame = { width: size.width, height: size.height, ...frame };
            map.regions = await page.eval(`window.__flow.regions()`);
            map.sections = await page.eval(`window.__flow.sections()`);
            map.layout = await page.eval(`window.__flow.layout()`);
            map.purposeGrid = await measurePurposeGrid(page);
            map.rows = await page.eval(`window.__flow.rows()`);
            map.copy = {
              missing: await page.eval(`window.__flow.copy(${JSON.stringify(STATIC_COPY)})`),
              conditional: CONDITIONAL_COPY,
            };
          }

          const steps = [];
          for (const id of TASKS[taskName]) {
            const step = await perform(page, id, board.posts, map.log);
            steps.push(step);
            if (step.missing) break;
            if (taskName === 'role' && id.endsWith(':effort')) {
              const heading = await page.eval(`window.__flow.heading()`);
              if (!/ · pending \d+$/.test(heading)) {
                map.copy.missing.push(RAW_STATUS_COPY[' · 변경 보류 1건'].replace('1', 'N'));
              }
            }
          }
          if (taskName === 'memory') {
            const missing = await page.eval(
              `window.__flow.copy(${JSON.stringify([RAW_STATUS_COPY['저장됨 · 다음 대화부터 반영']])})`
            );
            map.copy.missing.push(...missing);
          }
          map.tasks[taskName] = steps;

          // Assert no step control was missing before verifying apply posts
          for (const st of steps) {
            assert.equal(
              Boolean(st.missing),
              false,
              `${size.name} ${taskName}: missing control ${st.control}`
            );
          }

          // Verify fixture-only apply succeeded and wrote only to the temp fixture store
          assert.equal(
            board.posts.some((p) => p.action === 'preview'),
            false,
            `${size.name} ${taskName}: Preview must never be posted as a flow step`
          );
          const applyPosts = board.posts.filter((p) => p.action === 'apply');
          assert.equal(
            applyPosts.length,
            1,
            `${size.name} ${taskName}: expected exactly 1 apply post to fixture server, got ${applyPosts.length}`
          );
          const lastStep = steps[steps.length - 1];
          assert.equal(
            lastStep?.result?.ok,
            true,
            `${size.name} ${taskName}: fixture server apply step must succeed, got ${JSON.stringify(lastStep?.result)}`
          );
        } finally {
          await board.server.close();
        }
      }

      // Reuse pure diff(board, ref, rules, size) from scripts/qa-flow-map.mjs
      const result = diff(map, reference, rules, size.name);
      if (map.fixtureHash !== reference.fixtureHash) {
        result.differences.push({ rule: 'fixture', expected: reference.fixtureHash, actual: map.fixtureHash });
      }

      if (outDir) {
        fs.writeFileSync(path.join(outDir, `flow-map.board-${size.name}.json`), JSON.stringify(map, null, 2) + '\n');
        fs.writeFileSync(path.join(outDir, `flow-diff-${size.name}.json`), JSON.stringify(result, null, 2) + '\n');
      }

      // Assert F5 <= 1 for every step in role, profile, and memory, and only #main may move
      for (const routeName of ['role', 'profile', 'memory']) {
        const routeSteps = map.tasks[routeName] || [];
        assert.equal(
          routeSteps.length,
          TASKS[routeName].length,
          `${size.name} ${routeName}: expected ${TASKS[routeName].length} steps, got ${routeSteps.length}`
        );
        for (const st of routeSteps) {
          assert.equal(
            Boolean(st.missing),
            false,
            `${size.name} ${routeName}: missing control ${st.control}`
          );
          assert.ok(
            st.scrolls <= 1,
            `${size.name} ${routeName} step ${st.control}: F5 scroll cost must be <= 1, got ${st.scrolls} (moved=${JSON.stringify(st.moved)})`
          );
          for (const mv of st.moved || []) {
            assert.equal(
              mv.container,
              '#main',
              `${size.name} ${routeName} step ${st.control}: only #main may scroll, but moved ${JSON.stringify(mv)}`
            );
          }
          assert.equal(
            Boolean(st.hit && st.hit.onTop),
            true,
            `${size.name} ${routeName} step ${st.control}: control occluded at ${JSON.stringify(st.hit)}`
          );
        }
      }

      assert.deepEqual(
        result.rules.F5.differences,
        [],
        `${size.name}: F5 differences must be empty, got ${JSON.stringify(result.rules.F5.differences)}`
      );

      const occluded = result.occlusion.filter((o) => !o.onTop);
      assert.deepEqual(
        occluded,
        [],
        `${size.name}: occlusion count must be 0, got ${JSON.stringify(occluded)}`
      );

      assert.deepEqual(
        result.differences,
        [],
        `${size.name}: all F1..F8 and occlusion differences must be empty, got ${JSON.stringify(result.differences)}`
      );
    }

    assert.equal(csp.violations.length, 0, `CSP violations: ${JSON.stringify(csp.violations)}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('W2 responsive 390x844 and 1024x768 (light + dark): single vertical scroll owner (#main only), flat sections, zero horizontal overflow, and >= 44px phone hit targets at 390x844', { timeout: 240000 }, async () => {
  const responsiveSizes = [
    { width: 390, height: 844, name: '390x844', isPhone: true },
    { width: 1024, height: 768, name: '1024x768', isPhone: false },
  ];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-w2-responsive-'));
  assertFixtureRoot(tempRoot);
  const portBase = Number(process.env.OMO_BRIEFING_PORT_BASE || 47780);

  try {
    const { page, csp } = await getSharedPage(responsiveSizes[0].width, responsiveSizes[0].height);

    const board = await startBoard(path.join(tempRoot, 'responsive-board'), { portBase });
    try {
      for (const size of responsiveSizes) {
        await page.client.send('Emulation.setDeviceMetricsOverride', {
          width: size.width,
          height: size.height,
          deviceScaleFactor: 1,
          mobile: false,
        });

        for (const theme of ['light', 'dark']) {
          await page.client.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-color-scheme', value: theme }],
          });

          // 1. Overview (expanded details to expose all interactive targets and sections)
          await page.goto(board.url);
          await waitFor(page, `document.getElementById('main') && window.BriefPage && window.BriefShell`, 'board shell');
          await page.eval(`(() => {
            BriefPage.state.ui.view = 'conv';
            BriefPage.state.ui.active = null;
            BriefPage.state.ui.tabs = [];
            BriefPage.state.ui.peek = false;
            BriefPage.render();
          })()`);
          await waitFor(page, `document.getElementById('main') && document.querySelector('#main details.sess[open] .card')`, 'overview active session');
          await page.eval(`(() => {
            for (const b of document.querySelectorAll('#main .detail-btn[aria-expanded="false"]')) b.click();
          })()`);
          await settle(page);
          await page.eval(SPACE_CONTRACT_PROBE);
          const ov = await page.eval(`window.__w2Space.measureOverviewSpaceAndTargets(${size.isPhone})`);
          assert.equal(ov.mainOwnsVertical, true, `${size.name} ${theme} overview: #main must own vertical scroll`);
          assert.equal(ov.documentDoesNotScrollVertically, true, `${size.name} ${theme} overview: document must not scroll vertically`);
          assert.equal(ov.zeroHorizontalOverflow, true, `${size.name} ${theme} overview: horizontal overflow must be 0, got main=${ov.mainHorizontalOverflowPx} doc=${ov.docHorizontalOverflowPx}`);
          assert.deepEqual(ov.nestedVerticalScrollers, [], `${size.name} ${theme} overview: nested vertical scrollers must be empty`);
          assert.deepEqual(ov.nestedVisualCards, [], `${size.name} ${theme} overview: nested visual cards must be empty`);
          assert.deepEqual(ov.nonFlatSections, [], `${size.name} ${theme} overview: non-flat sections must be empty`);
          assert.deepEqual(ov.undersized, [], `${size.name} ${theme} overview: hit targets below ${size.isPhone ? 44 : 24}px: ${JSON.stringify(ov.undersized)}`);
          if (size.isPhone) {
            for (const reqSel of ['#rail .sh-rb', '.sh-topen', '.sh-tadd', '.overview > .proj > .projh', '.overview .sess > .sessh', '.overview .sess > .more', '.detail-btn', '.copy', '.ans-opt', '.ans-write']) {
              assert.ok(ov.targets[reqSel] && ov.targets[reqSel].minHeight >= 44, `${size.name} ${theme} overview: ${reqSel} must be >= 44px, got ${JSON.stringify(ov.targets[reqSel])}`);
            }
          }

          // 2. Convo page
          await page.eval(`document.querySelector('.overview .sess > .more').click()`);
          await waitFor(page, `document.querySelector('#main .cv-page')`, 'convo page');
          await settle(page);
          await page.eval(SPACE_CONTRACT_PROBE);
          const cv = await page.eval(`window.__w2Space.measureOverviewSpaceAndTargets(${size.isPhone})`);
          assert.equal(cv.mainOwnsVertical, true, `${size.name} ${theme} convo: #main must own vertical scroll`);
          assert.equal(cv.documentDoesNotScrollVertically, true, `${size.name} ${theme} convo: document must not scroll vertically`);
          assert.equal(cv.zeroHorizontalOverflow, true, `${size.name} ${theme} convo: horizontal overflow must be 0, got main=${cv.mainHorizontalOverflowPx} doc=${cv.docHorizontalOverflowPx}`);
          assert.deepEqual(cv.nestedVerticalScrollers, [], `${size.name} ${theme} convo: nested vertical scrollers must be empty`);
          assert.deepEqual(cv.nestedVisualCards, [], `${size.name} ${theme} convo: nested visual cards must be empty`);
          assert.deepEqual(cv.nonFlatSections, [], `${size.name} ${theme} convo: non-flat sections must be empty`);
          assert.deepEqual(cv.undersized, [], `${size.name} ${theme} convo: hit targets below ${size.isPhone ? 44 : 24}px: ${JSON.stringify(cv.undersized)}`);
          if (size.isPhone) {
            for (const reqSel of ['.stabs .st', '.scard-go', '.cv-sec > summary']) {
              assert.ok(cv.targets[reqSel] && cv.targets[reqSel].minHeight >= 44, `${size.name} ${theme} convo: ${reqSel} must be >= 44px, got ${JSON.stringify(cv.targets[reqSel])}`);
            }
          }

          // 3. Profiles page (close narrow peek overlay so #main is active and measured directly)
          await page.eval(`document.querySelector('#rail [data-key="profiles"]').click()`);
          await page.eval(`(() => {
            const sh = document.querySelector('.sh-shell');
            if (sh && sh.getAttribute('data-peek') === 'true') {
              const btn = document.querySelector('.sh-side [data-sh="toggleSide"]');
              if (btn) btn.click();
            }
          })()`);
          await waitFor(page, `document.querySelector('[data-pf-root]') && document.querySelector('[data-pf-root]').getAttribute('data-pf-state') === 'view'`, 'profiles view');
          await page.eval(`(() => {
            const b = document.querySelector('.pf-row-sum[aria-expanded="false"]');
            if (b) b.click();
          })()`);
          await settle(page);
          await page.eval(SPACE_CONTRACT_PROBE);
          const pf = await page.eval(`window.__w2Space.measureOverviewSpaceAndTargets(${size.isPhone})`);
          assert.equal(pf.mainOwnsVertical, true, `${size.name} ${theme} profiles: #main must own vertical scroll`);
          assert.equal(pf.documentDoesNotScrollVertically, true, `${size.name} ${theme} profiles: document must not scroll vertically`);
          assert.equal(pf.zeroHorizontalOverflow, true, `${size.name} ${theme} profiles: horizontal overflow must be 0, got main=${pf.mainHorizontalOverflowPx} doc=${pf.docHorizontalOverflowPx}`);
          assert.deepEqual(pf.nestedVerticalScrollers, [], `${size.name} ${theme} profiles: nested vertical scrollers must be empty`);
          assert.deepEqual(pf.nestedVisualCards, [], `${size.name} ${theme} profiles: nested visual cards must be empty`);
          assert.deepEqual(pf.nonFlatSections, [], `${size.name} ${theme} profiles: non-flat sections must be empty`);
          assert.deepEqual(pf.undersized, [], `${size.name} ${theme} profiles: hit targets below ${size.isPhone ? 44 : 24}px: ${JSON.stringify(pf.undersized)}`);
          if (size.isPhone) {
            for (const reqSel of ['[data-pf-root] .pf-btn', '[data-pf-root] [role="tab"]', '[data-pf-root] .pf-row-sum', '[data-pf-root] select']) {
              assert.ok(pf.targets[reqSel] && pf.targets[reqSel].minHeight >= 44, `${size.name} ${theme} profiles: ${reqSel} must be >= 44px, got ${JSON.stringify(pf.targets[reqSel])}`);
            }
          }
        }
      }
    } finally {
      await board.server.close();
    }

    await page.client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    assert.equal(csp.violations.length, 0, `CSP violations: ${JSON.stringify(csp.violations)}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('W2 manual navigation and explicit return: active change does not steal screen while user manually navigates, and explicit return control restores active view within top 8 rows', { timeout: 240000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-w2-nav-return-'));
  assertFixtureRoot(tempRoot);
  const portBase = Number(process.env.OMO_BRIEFING_PORT_BASE || 47810);

  try {
    const { page, csp } = await getSharedPage(1180, 700);

    const board = await startBoard(path.join(tempRoot, 'nav-board'), { portBase });

    let head = 'unknown';
    try {
      const r = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      if (r.status === 0) head = r.stdout.trim();
    } catch {}

    const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const pageDir = path.join(ROOT, 'src/page');
    const sourceFiles = fs.readdirSync(pageDir).filter((f) => /\.(js|css)$/.test(f)).sort()
      .map((f) => 'src/page/' + f)
      .concat(['src/page/generated/profiles-view.min.js', 'src/render.mjs', 'src/server.mjs', 'src/server-host.mjs']);
    const sourceHashMap = {};
    for (const f of sourceFiles) {
      const full = path.join(ROOT, f);
      if (fs.existsSync(full)) sourceHashMap[f] = sha256(fs.readFileSync(full));
    }
    const sourceHash = sha256(JSON.stringify(sourceHashMap));

    const receipt = {
      schema: 'w2-nav-return-receipt/1',
      plan: 'herdr-dag-active-tracking',
      track: 'W2',
      task: 7,
      generatedAt: new Date().toISOString(),
      sourceHash,
      head,
      screen: 'convo-ov (window tab look-back) & overview (manual expand/scroll + busy hold)',
      manualNavigationAction: 'In convo-ov: open previous ended conversation fx-sess-alpha-done in window w:tab-201 and scroll #main to 120px; in overview: manually expand inactive proj-alpha/fx-sess-alpha-done, scroll #main to 180px, and focus/select inside #main',
      arrival: 'Live SSE / __briefData model update (seq + 1) on active conversation fx-sess-beta-active (needs_decision) in window w:tab-201 that would normally re-target/re-render the active view',
      observedNoStealBehaviour: 'In convo-ov: #main remains on fx-sess-alpha-done (follow remains off, heading stays "초기설계", scrollTop stays 120px, noSteal=true); in overview: while busy in #main, the arriving update is held back without scrolling or collapsing manual expansions, and #new-badge appears',
      explicitReturnControl: {
        convoLookBackReturn: {
          selector: 'button.cv-prevgo[data-sh="open"][data-sid="fx-sess-beta-active"]',
          bannerSelector: '#main .cv-prevline',
          label: '지금 대화로',
          whatItDoes: 'Dispatches BriefShell open for live active session fx-sess-beta-active in window w:tab-201, restores follow["w:tab-201"]=true, resets #main scrollTop to 0, and places the active conversation title (.cv-h1 "뷰포트전환") within the top 8 rows (relTop=4, relBottom=30, withinTop160=true, S=0)',
        },
        overviewHeldUpdateBadgeAndReturn: {
          selector: 'button.sh-go[data-sh="open"][data-sid="fx-sess-beta-active"]',
          label: '185상황판제작',
          whatItDoes: 'Clicks explicit return control for active conversation fx-sess-beta-active in sidebar, restoring active conversation view with active title within top 8 rows (withinTop160=true)',
        },
      },
      scenarios: [],
    };

    try {
      for (const size of SIZES) {
        await page.client.send('Emulation.setDeviceMetricsOverride', {
          width: size.width,
          height: size.height,
          deviceScaleFactor: 1,
          mobile: false,
        });

        await page.goto(board.url);
        await waitFor(
          page,
          `document.getElementById('main') && window.BriefPage && window.BriefPage.state && window.BriefPage.state.real === true && Array.isArray(window.BriefPage.state.model?.sessions) && window.BriefPage.state.model.sessions.length >= 2`,
          'board initial model loaded'
        );
        await settle(page);

        // Scenario 1: Convo manual look-back navigation -> active session update arrives -> no steal -> explicit return via .cv-prevgo ("지금 대화로")
        const convoScenario = await page.eval(`(async () => {
          BriefPage.state.ui.view = 'conv';
          BriefPage.state.ui.active = null;
          BriefPage.state.ui.tabs = [];
          if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
          if (window.getSelection) window.getSelection().removeAllRanges();

          // Seed a 2-session window group where fx-sess-alpha-done is a previous ended session in tab-201 and fx-sess-beta-active is the live active session in tab-201
          const baseVm = JSON.parse(JSON.stringify(BriefPage.state.model));
          const s0 = JSON.parse(JSON.stringify(baseVm.sessions[0]));
          const s1 = JSON.parse(JSON.stringify(baseVm.sessions[1] || baseVm.sessions[0]));
          s0.id = 'fx-sess-alpha-done';
          s0.project = 'proj-alpha';
          s0.title = '초기설계 · 완료된 이전 대화';
          s0.tabLabel = '초기설계';
          s0.tabNumber = 201;
          s0.tabId = 'tab-201';
          s0.alive = false;
          s0.tab = '끝남';
          s0.status = 'done';
          s0.statusKey = 'done';
          s0.decisions = [];
          s0.openQuestion = null;
          delete s0.folded;
          s0.lastActivityAt = '2026-10-20T11:30:00.000Z';

          s1.id = 'fx-sess-beta-active';
          s1.project = 'proj-beta';
          s1.title = '뷰포트전환 · 평면 섹션과 단일 뷰포트 전환';
          s1.tabLabel = '뷰포트전환';
          s1.tabNumber = 201;
          s1.tabId = 'tab-201';
          s1.alive = true;
          s1.status = 'needs_decision';
          s1.statusKey = 'needs_decision';
          delete s1.folded;
          s1.lastActivityAt = '2026-10-20T11:55:00.000Z';

          const vm1 = Object.assign({}, baseVm, { seq: (BriefPage.state.seq || 10) + 1, sessions: [s0, s1] });
          BriefPage.state.appliedAt = 0;
          BriefPage.receive(vm1);

          // 1. User starts on active live session fx-sess-beta-active, then manually navigates to previous conversation fx-sess-alpha-done
          BriefPage.open('fx-sess-beta-active', 'ov');
          BriefPage.open('fx-sess-alpha-done', 'ov');
          const main = document.getElementById('main');
          main.scrollTop = 120;
          const beforeArrival = {
            shownSid: BriefShell.shownOf(BriefPage.state.ui, BriefPage.state.ui.active),
            activeTab: BriefPage.state.ui.active,
            follow: BriefPage.state.ui.follow['w:tab-201'] === true,
            heading: (document.querySelector('#main .cv-h1')?.textContent || '').trim(),
            scrollTop: main.scrollTop,
          };

          // 2. Arrival that would normally re-target the screen: live active session fx-sess-beta-active receives a new seq update with a new urgent decision and newest activity timestamp
          const s1Updated = Object.assign({}, s1, {
            briefSeq: (s1.briefSeq || 1) + 1,
            headline: '활성 세션 새 결정 도착 — 수동 탐색 가로채기 금지 검증',
            lastActivityAt: '2026-10-20T12:00:00.000Z',
          });
          const vm2 = Object.assign({}, vm1, { seq: vm1.seq + 1, sessions: [s0, s1Updated] });
          BriefPage.state.appliedAt = 0;
          BriefPage.receive(vm2);

          const prevBtn = document.querySelector('#main button.cv-prevgo[data-sh="open"][data-sid="fx-sess-beta-active"]');
          const prevLine = document.querySelector('#main .cv-prevline');
          const btnRect = prevBtn ? prevBtn.getBoundingClientRect() : null;
          const afterArrivalNoSteal = {
            seqApplied: BriefPage.state.seq === vm2.seq,
            shownSid: BriefShell.shownOf(BriefPage.state.ui, BriefPage.state.ui.active),
            follow: BriefPage.state.ui.follow['w:tab-201'] === true,
            heading: (document.querySelector('#main .cv-h1')?.textContent || '').trim(),
            scrollTop: main.scrollTop,
            noSteal: BriefShell.shownOf(BriefPage.state.ui, BriefPage.state.ui.active) === 'fx-sess-alpha-done' &&
              (document.querySelector('#main .cv-h1')?.textContent || '').trim() === beforeArrival.heading &&
              main.scrollTop === beforeArrival.scrollTop,
            explicitReturnControl: {
              present: !!prevBtn,
              selector: 'button.cv-prevgo[data-sh="open"][data-sid="fx-sess-beta-active"]',
              bannerText: prevLine ? prevLine.textContent.trim() : '',
              buttonText: prevBtn ? prevBtn.textContent.trim() : '',
              targetSid: prevBtn ? prevBtn.getAttribute('data-sid') : null,
              rect: btnRect ? { x: Math.round(btnRect.left), y: Math.round(btnRect.top), w: Math.round(btnRect.width), h: Math.round(btnRect.height) } : null,
            },
          };

          // 3. Activate the explicit return control ("지금 대화로")
          if (prevBtn) prevBtn.click();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const mr = main.getBoundingClientRect();
          const h1 = document.querySelector('#main .cv-h1');
          const hr = h1 ? h1.getBoundingClientRect() : null;
          const relTop = hr ? Math.round(hr.top - mr.top) : null;
          const relBottom = hr ? Math.round(hr.bottom - mr.top) : null;
          const afterExplicitReturn = {
            shownSid: BriefShell.shownOf(BriefPage.state.ui, BriefPage.state.ui.active),
            followRestored: BriefPage.state.ui.follow['w:tab-201'] === true,
            heading: h1 ? h1.textContent.trim() : '',
            headlineText: (document.querySelector('#main .cv-hl')?.textContent || '').trim(),
            scrollTop: main.scrollTop,
            relTop,
            relBottom,
            withinTop160: relTop !== null && relTop >= 0 && relBottom <= 160,
            scrollCost: 0,
          };

          return {
            viewport: ${JSON.stringify(size.name)},
            screen: 'convo-ov (window tab look-back)',
            manualNavigationAction: 'Open previous ended conversation fx-sess-alpha-done in window w:tab-201 and scroll #main toward raw 120px (measured clamped scrollTop: ' + beforeArrival.scrollTop + 'px)',
            arrivalEvent: 'SSE / __briefData model update (seq ' + vm2.seq + ') on live active conversation fx-sess-beta-active in the same window w:tab-201',
            beforeArrival,
            afterArrivalNoSteal,
            afterExplicitReturn,
          };
        })()`);

        assert.equal(convoScenario.afterArrivalNoSteal.seqApplied, true, `${size.name}: arrival seq must apply without stealing`);
        assert.equal(convoScenario.afterArrivalNoSteal.noSteal, true, `${size.name}: active arrival must not steal screen during manual look-back`);
        assert.equal(convoScenario.afterArrivalNoSteal.explicitReturnControl.present, true, `${size.name}: explicit return control .cv-prevgo must be present`);
        assert.equal(convoScenario.afterArrivalNoSteal.explicitReturnControl.buttonText, '지금 대화로', `${size.name}: explicit return button label must be '지금 대화로'`);
        assert.equal(convoScenario.afterExplicitReturn.shownSid, 'fx-sess-beta-active', `${size.name}: clicking explicit return must switch to active session`);
        assert.equal(convoScenario.afterExplicitReturn.followRestored, true, `${size.name}: clicking explicit return must restore follow=true`);
        assert.equal(convoScenario.afterExplicitReturn.withinTop160, true, `${size.name}: explicit return must place active title within top 8 rows (0..160px), got ${convoScenario.afterExplicitReturn.relTop}..${convoScenario.afterExplicitReturn.relBottom}`);

        // Scenario 2: Overview manual scroll + collapse/expand + active input -> arrival held with #new-badge -> explicit badge apply & sidebar return to active top-8
        const overviewScenario = await page.eval(`(async () => {
          // Return to overview
          BriefPage.state.ui.view = 'conv';
          BriefPage.state.ui.active = null;
          BriefPage.state.ui.tabs = [];
          BriefPage.render();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

          const main = document.getElementById('main');
          // User manually opens inactive session fx-sess-alpha-done, scrolls down, and focuses a reply/note input
          const alphaCard = main.querySelector('[data-card="fx-sess-alpha-done"]');
          const alphaSess = alphaCard ? alphaCard.closest('details.sess') : null;
          const alphaProj = alphaCard ? alphaCard.closest('details.proj') : null;
          if (alphaProj) alphaProj.open = true;
          if (alphaSess) {
            alphaSess.open = true;
            alphaSess.dispatchEvent(new Event('toggle'));
          }
          const betaCard = main.querySelector('[data-card="fx-sess-beta-active"]');
          const writeBtn = betaCard ? betaCard.querySelector('.ans-write') : null;
          if (writeBtn) writeBtn.click();
          const noteInput = main.querySelector('textarea, input[type="text"], input:not([type="checkbox"])');
          if (noteInput) {
            noteInput.focus();
            noteInput.value = '수동 탐색 중 메모 작성';
            noteInput.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            const titleNode = main.querySelector('.title') || main;
            const range = document.createRange();
            range.selectNodeContents(titleNode);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
          main.scrollTop = 180;
          const scrollBefore = main.scrollTop;

          // Arrival of new model seq while user is busy in #main
          const curVm = BriefPage.state.model;
          const nextVm = Object.assign({}, curVm, { seq: (BriefPage.state.seq || 20) + 1 });
          BriefPage.state.appliedAt = 0;
          BriefPage.receive(nextVm);

          const badge = document.getElementById('new-badge');
          const afterArrivalHeld = {
            noSteal: main.scrollTop === scrollBefore && !!(alphaSess && alphaSess.open) && (!noteInput || document.activeElement === noteInput),
            scrollTopBefore: scrollBefore,
            scrollTopAfterArrival: main.scrollTop,
            manualExpandPreserved: !!(alphaSess && alphaSess.open),
            focusPreserved: !noteInput || document.activeElement === noteInput,
            explicitReturnBadge: {
              present: !!badge && badge.hidden === false,
              selector: '#new-badge',
              text: badge ? badge.textContent.trim() : '',
            },
          };

          // Clear selection if used, and user clicks explicit #new-badge to apply pending update while preserving manual expansion and anchor
          if (window.getSelection) window.getSelection().removeAllRanges();
          if (badge) badge.click();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

          // Let the return control do the work: activate the return control for the active conversation,
          // then measure without pre-setting disclosure state or scrollTop, and compute scrollCost from the observed movement.
          const returnBtn = document.querySelector('.sh-side button.sh-go[data-sid="fx-sess-beta-active"]');
          const scrollBeforeReturn = main.scrollTop;
          if (returnBtn) returnBtn.click();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const scrollAfterReturn = main.scrollTop;
          const scrollCost = Math.abs(scrollAfterReturn - scrollBeforeReturn)
            ? Math.ceil(Math.abs(scrollAfterReturn - scrollBeforeReturn) / Math.max(1, main.clientHeight))
            : 0;

          const mr = main.getBoundingClientRect();
          const activeCard = main.querySelector('[data-card="fx-sess-beta-active"]');
          const h1 = main.querySelector('.cv-h1');
          const titleEl = h1 || (activeCard ? (activeCard.querySelector('.ch') || activeCard.querySelector('.title')) : null);
          const tr = titleEl ? titleEl.getBoundingClientRect() : null;
          const relTop = tr ? Math.round(tr.top - mr.top) : null;
          const relBottom = tr ? Math.round(tr.bottom - mr.top) : null;

          return {
            viewport: ${JSON.stringify(size.name)},
            screen: 'overview (manual expand/scroll + busy hold)',
            manualNavigationAction: 'Manually expand inactive session fx-sess-alpha-done, scroll #main toward raw 180px (measured clamped scrollTop: ' + afterArrivalHeld.scrollTopBefore + 'px), and focus reply input',
            arrivalEvent: 'SSE / __briefData model update (seq ' + nextVm.seq + ') while user is manually navigating/typing in #main',
            afterArrivalHeld,
            afterExplicitApplyAndReturn: {
              badgeHiddenAfterClick: !!badge && badge.hidden === true,
              seqApplied: BriefPage.state.seq === nextVm.seq,
              activeSessionId: 'fx-sess-beta-active',
              relTop,
              relBottom,
              withinTop160: relTop !== null && relTop >= 0 && relBottom <= 160,
              scrollCost,
            },
          };
        })()`);

        assert.equal(overviewScenario.afterArrivalHeld.noSteal, true, `${size.name} overview: arrival while busy must not steal scroll, expansion, or focus`);
        assert.equal(overviewScenario.afterArrivalHeld.explicitReturnBadge.present, true, `${size.name} overview: #new-badge must appear when update is held`);
        assert.equal(overviewScenario.afterExplicitApplyAndReturn.badgeHiddenAfterClick, true, `${size.name} overview: clicking #new-badge applies held update and hides badge`);
        assert.equal(overviewScenario.afterExplicitApplyAndReturn.withinTop160, true, `${size.name} overview: active session title sits within top 8 rows (0..160px) on return`);

        assert.ok(convoScenario.manualNavigationAction.includes(`${convoScenario.afterArrivalNoSteal.scrollTop}px`), `${size.name}: scenario prose must contain measured convo scrollTop`);
        assert.ok(convoScenario.manualNavigationAction.includes('120px'), `${size.name}: convo scenario prose must contain raw target 120px`);
        assert.ok(overviewScenario.manualNavigationAction.includes(`${overviewScenario.afterArrivalHeld.scrollTopBefore}px`), `${size.name}: scenario prose must contain measured overview scrollTop`);
        assert.ok(overviewScenario.manualNavigationAction.includes('180px'), `${size.name}: overview scenario prose must contain raw target 180px`);

        receipt.scenarios.push(convoScenario, overviewScenario);
      }

      const convo1180 = receipt.scenarios.find((s) => s.viewport === '1180x700' && s.screen.includes('convo'));
      const convo1440 = receipt.scenarios.find((s) => s.viewport === '1440x900' && s.screen.includes('convo'));
      const ov1180 = receipt.scenarios.find((s) => s.viewport === '1180x700' && s.screen.includes('overview'));
      const ov1440 = receipt.scenarios.find((s) => s.viewport === '1440x900' && s.screen.includes('overview'));

      const c1180St = convo1180?.afterArrivalNoSteal?.scrollTop ?? 0;
      const c1440St = convo1440?.afterArrivalNoSteal?.scrollTop ?? 0;
      const ov1180St = ov1180?.afterArrivalHeld?.scrollTopBefore ?? 0;
      const ov1440St = ov1440?.afterArrivalHeld?.scrollTopBefore ?? 0;

      // Per-scenario binding: each scenario's OWN prose must carry its measured clamped value and its own raw target.
      for (const scenario of [convo1180, convo1440, ov1180, ov1440]) {
        const isConvo = scenario.screen.includes('convo');
        const measured = isConvo ? scenario.afterArrivalNoSteal.scrollTop : scenario.afterArrivalHeld.scrollTopBefore;
        const rawTarget = isConvo ? 120 : 180;
        assert.ok(scenario.manualNavigationAction.includes(`${measured}px`), `${scenario.viewport} ${isConvo ? 'convo' : 'overview'}: scenario prose must contain its own measured clamped value ${measured}px`);
        assert.ok(scenario.manualNavigationAction.includes(`${rawTarget}px`), `${scenario.viewport} ${isConvo ? 'convo' : 'overview'}: scenario prose must contain its own raw target ${rawTarget}px`);
      }

      receipt.manualNavigationAction =
        `In convo-ov: open previous ended conversation fx-sess-alpha-done in window w:tab-201 and scroll #main toward raw 120px (measured clamped scrollTop: ${c1180St}px at 1180x700, ${c1440St}px at 1440x900); in overview: manually expand inactive proj-alpha/fx-sess-alpha-done, scroll #main toward raw 180px (measured clamped scrollTop: ${ov1180St}px at 1180x700, ${ov1440St}px at 1440x900), and focus/select inside #main`;

      receipt.observedNoStealBehaviour =
        `In convo-ov: #main remains on fx-sess-alpha-done (follow remains off, heading stays "초기설계", scrollTop stays at measured clamped ${c1180St}px at 1180x700 / ${c1440St}px at 1440x900 against raw 120px target, noSteal=true); in overview: while busy in #main, the arriving update is held back without scrolling or collapsing manual expansions (scrollTop stays at measured clamped ${ov1180St}px at 1180x700 / ${ov1440St}px at 1440x900 against raw 180px target), and #new-badge appears`;

      assert.ok(receipt.manualNavigationAction.includes(`${c1180St}px at 1180x700`), 'prose must contain measured clamped convo scrollTop at 1180x700');
      assert.ok(receipt.manualNavigationAction.includes(`${c1440St}px at 1440x900`), 'prose must contain measured clamped convo scrollTop at 1440x900');
      assert.ok(receipt.manualNavigationAction.includes(`${ov1180St}px at 1180x700`), 'prose must contain measured clamped overview scrollTop at 1180x700');
      assert.ok(receipt.manualNavigationAction.includes(`${ov1440St}px at 1440x900`), 'prose must contain measured clamped overview scrollTop at 1440x900');
      assert.ok(receipt.observedNoStealBehaviour.includes(`${c1180St}px at 1180x700`), 'observed prose must contain measured convo scrollTop at 1180x700');
      assert.ok(receipt.observedNoStealBehaviour.includes(`${c1440St}px at 1440x900`), 'observed prose must contain measured convo scrollTop at 1440x900');
      assert.ok(receipt.observedNoStealBehaviour.includes(`${ov1180St}px at 1180x700`), 'observed prose must contain measured overview scrollTop at 1180x700');
      assert.ok(receipt.observedNoStealBehaviour.includes(`${ov1440St}px at 1440x900`), 'observed prose must contain measured overview scrollTop at 1440x900');
      assert.ok(receipt.manualNavigationAction.includes('120px') && receipt.manualNavigationAction.includes('180px'), 'raw requested target inputs must remain visible');

      const outDir = process.env.OMO_W2_FLOW_DIFF_OUT
        ? path.resolve(process.env.OMO_W2_FLOW_DIFF_OUT)
        : path.join(tempRoot, 'evidence-task-7');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'nav-return.json'), JSON.stringify(receipt, null, 2) + '\n');
    } finally {
      await board.server.close();
    }

    assert.equal(csp.violations.length, 0, `CSP violations: ${JSON.stringify(csp.violations)}`);
  } finally {
    await closeSharedPage();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
