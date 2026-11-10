// Card, group and row separator contrast, neutral shown-card state, flat section contract,
// and DPR 1.5 physical-pixel raster thickness verification (todo 6 attempt 2).
import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeLiveScaleHome } from './helpers/profiles-live-scale.mjs';
import { SEPARATION_PROBE_SCRIPT, buildRasterMeasureExpression } from './helpers/profiles-separation-probe.mjs';
import { createBoardServer } from '../src/server.mjs';
import { pageHtml } from '../src/render.mjs';
import { launch } from '../scripts/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD_MODEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/view-model-board.json'), 'utf8'));
const VIEWPORTS = [
  { width: 390, height: 844, mobile: true },
  { width: 1024, height: 768, mobile: false },
  { width: 1180, height: 700, mobile: false },
  { width: 1440, height: 900, mobile: false },
  { width: 1920, height: 1080, mobile: false },
];

async function openProfilesSwitcher(page, port) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.eval(`new Promise((resolve, reject) => {
    const check = () => { const rail = document.querySelector('[data-sh="view"][data-key="profiles"]'); if (!rail) return false; rail.click(); return true; };
    if (check()) return resolve(true);
    const obs = new MutationObserver(() => { if (check()) { obs.disconnect(); clearTimeout(timer); resolve(true); } });
    const timer = setTimeout(() => { obs.disconnect(); reject(new Error('profiles rail deadline')); }, 10000);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  })`);
  await page.eval(`new Promise((resolve, reject) => {
    const check = () => document.querySelector('[data-pf-root]')?.dataset.pfState === 'view';
    if (check()) return resolve(true);
    const obs = new MutationObserver(() => { if (check()) { obs.disconnect(); clearTimeout(timer); resolve(true); } });
    const timer = setTimeout(() => { obs.disconnect(); reject(new Error('profiles view deadline')); }, 10000);
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  })`);
}

test('separators, neutral shown-card styling, flatness and actual pane top with delegated Web allowance hold across 390..1920, light/dark and DPR 1.5', { timeout: 90000 }, async (t) => {
  const fx = makeLiveScaleHome(t), state = fx.store.state(), token = 'profiles-separation';
  const server = createBoardServer({
    portBase: 51600 + (process.pid % 20) * 8, portCount: 8, generation: 7, token,
    getPage: ({ nonce } = {}) => pageHtml(BOARD_MODEL, 7, { mode: 'server', token, nonce }),
    getViewModel: () => BOARD_MODEL, profilesState: () => state,
  });
  const { port } = await server.start();
  let page;
  const report = { scaleMechanism: 'Emulation.setDeviceMetricsOverride deviceScaleFactor (density/DPR emulation, not browser zoom)', runs: [] };
  const panesTopFailures = [];
  try {
    page = await launch({ width: 1440, height: 900 });
    await openProfilesSwitcher(page, port);
    await page.eval(`(() => { document.querySelector('[data-flow="card:experimental-custom"]').click(); document.querySelector('[role="tab"][data-tab="agents"]').click(); })()`);

    const cases = [
      ...VIEWPORTS.flatMap((vp) => ['light', 'dark'].map((theme) => ({ ...vp, dpr: 1, theme, label: `${vp.width}x${vp.height}-${theme}` }))),
      { width: 1440, height: 900, mobile: false, dpr: 1.5, theme: 'light', label: '1440x900-light-dpr1.5' },
      { width: 1440, height: 900, mobile: false, dpr: 1.5, theme: 'dark', label: '1440x900-dark-dpr1.5' },
    ];
    for (const c of cases) {
      await page.client.send('Emulation.setDeviceMetricsOverride', { width: c.width, height: c.height, deviceScaleFactor: c.dpr, mobile: c.mobile });
      await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: c.theme }] });
      await page.eval(`(() => { const exp = document.querySelector('.pf-row-sum[aria-expanded="true"]'); if (exp) exp.click(); })()`);
      await page.eval(`document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
      const closedProbe = await page.eval(SEPARATION_PROBE_SCRIPT);
      await page.eval(`document.querySelector('[data-pf="row-toggle"][data-row="route:agents/explore"]').click()`);
      await page.eval(`document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
      const openProbe = await page.eval(SEPARATION_PROBE_SCRIPT);
      // Delegated lead decision #1179 B: keep the real pane target and add only the visible Web panel's height/gap.
      const panesTopLimit = 190 + (closedProbe.webHeight ?? 0) + closedProbe.webGap;
      report.runs.push({ label: c.label, closed: closedProbe, panesTopLimit, openEditor: openProbe.openEditorStyle });

      assert.deepEqual(closedProbe.nonFlat, [], `${c.label}: flat section contract violated by ${JSON.stringify(closedProbe.nonFlat)}`);
      assert.deepEqual(openProbe.nonFlat, [], `${c.label} (expanded): flat section contract violated`);
      assert.equal(closedProbe.horizontalOverflow, false, `${c.label}: horizontal overflow remains zero`);
      assert.ok(closedProbe.titleRelBottom <= 160, `${c.label}: title within top 160px (${closedProbe.titleRelBottom})`);
      assert.equal(closedProbe.cardsBottomBorder.rowGap, 8, `${c.label}: .pf-cards row-gap must be 8px`);
      assert.ok(closedProbe.cardsBottomBorder.width >= 1, `${c.label}: .pf-cards bottom rule >= 1px CSS`);
      assert.ok(closedProbe.cardsBottomBorder.contrast >= 2.0, `${c.label}: .pf-cards bottom rule contrast ${closedProbe.cardsBottomBorder.contrast} >= 2.0`);
      for (const gap of closedProbe.cardGaps) assert.ok(gap >= 8, `${c.label}: card gap ${gap} >= 8px`);
      for (const card of closedProbe.cardTops) {
        assert.ok(card.borderTopWidth >= 1, `${c.label} ${card.profile}: card top border >= 1px CSS`);
        assert.ok(card.contrastVsPage >= 2.0 && card.contrastVsCardSurface >= 2.0, `${c.label} ${card.profile}: card top border contrast >= 2.0`);
      }

      const activeCard = closedProbe.cardTops.find((x) => x.profile === 'gpt-kimi-deepseek');
      const shownCard = closedProbe.cardTops.find((x) => x.profile === 'experimental-custom');
      const unshownCards = closedProbe.cardTops.filter((x) => x.profile !== 'experimental-custom');
      assert.equal(closedProbe.currentCount, 1, `${c.label}: current chip appears once`);
      assert.equal(activeCard.hasCurrent, true, `${c.label}: current chip stays on active profile`);
      assert.equal(activeCard.on, false, `${c.label}: active profile is not marked .on when another card is shown`);
      assert.equal(shownCard.on, true, `${c.label}: shown card carries .on`);
      assert.equal(shownCard.pressed, 'true', `${c.label}: shown card carries aria-pressed=true`);
      assert.equal(shownCard.hasCurrent, false, `${c.label}: shown card does not carry current chip`);
      assert.notEqual(shownCard.backgroundColor, closedProbe.greenTokens.tint, `${c.label}: shown card fill differs from green tint`);
      assert.notEqual(shownCard.borderTopColor, closedProbe.greenTokens.fg, `${c.label}: shown card border differs from green token`);
      assert.equal(shownCard.boxShadow, 'none', `${c.label}: shown card has no box-shadow`);
      assert.equal(shownCard.nameWeight, 600, `${c.label}: shown card name weight is 600`);
      for (const u of unshownCards) assert.ok(shownCard.nameWeight > u.nameWeight, `${c.label}: shown card name heavier than unshown`);

      assert.ok(closedProbe.groupHeaders.length > 0, `${c.label}: group headers measured`);
      for (const gh of closedProbe.groupHeaders) {
        assert.ok(gh.alpha > 0 && gh.contrastVsPage > 1.0, `${c.label} ${gh.group}: group header band is non-transparent`);
        assert.equal(gh.paddingTop, 4, `${c.label} ${gh.group}: group header paddingTop 4px`);
        assert.equal(gh.paddingLeft, 8, `${c.label} ${gh.group}: group header paddingLeft 8px`);
        assert.equal(gh.borderRadius, '6px', `${c.label} ${gh.group}: group header borderRadius 6px`);
      }
      for (const fb of closedProbe.firstAfterHeaderBorders) assert.equal(fb.borderTopWidth, 0, `${c.label} ${fb.group}: first row after header has no top border`);
      assert.ok(closedProbe.neighborRouteDividers.length > 0, `${c.label}: neighboring route dividers measured`);
      for (const div of closedProbe.neighborRouteDividers) {
        assert.ok(div.borderTopWidth >= 1, `${c.label} ${div.group}#${div.index}: route divider >= 1px CSS`);
        assert.ok(div.contrast >= 1.3, `${c.label} ${div.group}#${div.index}: route divider contrast ${div.contrast} >= 1.3`);
      }
      if (c.mobile) assert.ok(Math.min(...closedProbe.collapsedHeights) >= 44, `${c.label}: phone collapsed row height >= 44px`);
      else {
        assert.ok(Math.max(...closedProbe.collapsedHeights) <= 32, `${c.label}: desktop collapsed row height <= 32px`);
        if (closedProbe.webHeight !== null) {
          assert.equal(closedProbe.panesTop, closedProbe.webTop + closedProbe.webHeight + closedProbe.webGap,
            `${c.label}: the allowance contains only the adjacent Web panel and its following gap`);
        }
        if (closedProbe.panesTop > panesTopLimit) {
          panesTopFailures.push(`${c.label}: actual pane ${closedProbe.panesTop} > limit ${panesTopLimit} (190 + Web ${closedProbe.webHeight ?? 0} + gap ${closedProbe.webGap})`);
        }
      }
      assert.ok(openProbe.openEditorStyle, `${c.label}: expanded editor measured`);
      assert.ok(openProbe.openEditorStyle.borderTopWidth >= 1, `${c.label}: expanded editor top border >= 1px CSS`);
      assert.ok(openProbe.openEditorStyle.borderTopContrast >= 1.3, `${c.label}: expanded editor top border contrast >= 1.3`);
      assert.ok(openProbe.openEditorStyle.backgroundAlpha > 0, `${c.label}: expanded editor background is non-transparent`);
    }
    if (process.env.OMO_SEPARATION_OUT) {
      fs.mkdirSync(path.dirname(path.resolve(process.env.OMO_SEPARATION_OUT)), { recursive: true });
      fs.writeFileSync(process.env.OMO_SEPARATION_OUT, JSON.stringify(report, null, 2) + '\n');
    }
    assert.deepEqual(panesTopFailures, [], panesTopFailures[0] || 'actual pane top satisfies delegated lead decision #1179 B');
  } finally { try { if (page) await page.close(); } finally { await server.close(); } }
});

test('S6-SCALE: DPR 1.5 density emulation renders >= 1 physical-pixel thickness in actual screenshot rasters across changed straight border types in light and dark', { timeout: 90000 }, async (t) => {
  const fx = makeLiveScaleHome(t), state = fx.store.state(), token = 'profiles-separation-raster';
  const server = createBoardServer({
    portBase: 51680 + (process.pid % 20) * 8, portCount: 8, generation: 7, token,
    getPage: ({ nonce } = {}) => pageHtml(BOARD_MODEL, 7, { mode: 'server', token, nonce }),
    getViewModel: () => BOARD_MODEL, profilesState: () => state,
  });
  const { port } = await server.start();
  let page;
  const outDir = process.env.OMO_SEPARATION_RASTER_DIR ? path.resolve(process.env.OMO_SEPARATION_RASTER_DIR) : null;
  const rasterReport = {
    scaleMechanism: 'Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false })',
    browserZoomUsed: false,
    themes: {},
  };
  try {
    page = await launch({ width: 1440, height: 900 });
    await openProfilesSwitcher(page, port);
    await page.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false });

    const frameGroups = [
      {
        frameId: 'agents-and-cards',
        prepare: `(() => {
          document.querySelector('[data-flow="card:gpt-deepseek"]').click();
          document.querySelector('[role="tab"][data-tab="agents"]').click();
          const row = document.querySelector('[data-pf="row-toggle"][data-row="route:agents/explore"]');
          if (row.getAttribute('aria-expanded') !== 'true') row.click();
          document.getElementById('main').scrollTop = 0;
        })()`,
        targets: [
          { kind: 'sec-top', selector: '.pf-sec.pf-web', edge: 'top' },
          { kind: 'card-top', selector: 'article.pf-card:has([data-flow="card:kimi-deepseek"])', edge: 'top' },
          { kind: 'card-on-top', selector: 'article.pf-card.on', edge: 'top' },
          { kind: 'route-divider', selector: '[data-pf-route="agents/librarian"]', edge: 'top' },
          { kind: 'route-editor-top', selector: '#pf-route-agents-explore-editor', edge: 'top' },
        ],
      },
      {
        frameId: 'cards-bottom-and-primary',
        prepare: `(() => {
          document.querySelector('[role="tab"][data-tab="primary"]').click();
          const row = document.querySelector('[data-pf="row-toggle"][data-row="agent:sisyphus"]');
          if (row.getAttribute('aria-expanded') !== 'true') row.click();
          document.querySelector('.pf-cards').scrollIntoView({ block: 'end' });
        })()`,
        targets: [
          { kind: 'cards-bottom', selector: '.pf-cards', edge: 'bottom' },
          { kind: 'agent-divider', selector: '[data-pf-agent="hephaestus"]', edge: 'top' },
          { kind: 'agent-editor-top', selector: '#pf-agent-sisyphus-editor', edge: 'top' },
        ],
      },
      {
        frameId: 'memory',
        prepare: `(() => {
          document.querySelector('[role="tab"][data-tab="memory"]').click();
          const row = document.querySelector('[data-pf="row-toggle"][data-row="memory:kibitzer"]');
          if (row.getAttribute('aria-expanded') !== 'true') row.click();
          document.getElementById('main').scrollTop = 0;
        })()`,
        targets: [
          { kind: 'mem-row-top', selector: '[data-pf-memory-row="kibitzer"]', edge: 'top' },
          { kind: 'mem-editor-top', selector: '#pf-memory-kibitzer-editor', edge: 'top' },
        ],
      },
    ];

    for (const theme of ['light', 'dark']) {
      await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      const themeResults = { frames: [], samples: {} };
      for (const fg of frameGroups) {
        await page.eval(fg.prepare);
        await page.eval(`document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
        const shot = await page.client.send('Page.captureScreenshot', { format: 'png' });
        const pngBuf = Buffer.from(shot.data, 'base64');
        const pngWidth = pngBuf.readUInt32BE(16), pngHeight = pngBuf.readUInt32BE(20);
        assert.equal(pngWidth, 2160, `${theme} ${fg.frameId}: PNG physical width must be 2160 at 1440x900 DPR 1.5`);
        assert.equal(pngHeight, 1350, `${theme} ${fg.frameId}: PNG physical height must be 1350 at 1440x900 DPR 1.5`);
        let fullPath = null, fullSha256 = createHash('sha256').update(pngBuf).digest('hex');
        if (outDir) {
          fs.mkdirSync(outDir, { recursive: true });
          fullPath = path.join(outDir, `task-6-dpr1.5-${theme}-${fg.frameId}.png`);
          fs.writeFileSync(fullPath, pngBuf);
        }
        const decoded = await page.eval(buildRasterMeasureExpression(shot.data, fg.targets));
        assert.equal(decoded.rasterWidth, 2160);
        assert.equal(decoded.rasterHeight, 1350);
        for (const item of decoded.results) {
          assert.equal(item.computedCssPx, 1, `${theme} ${item.kind}: computed CSS width is 1px`);
          assert.equal(item.predictedDevicePx, 1.5, `${theme} ${item.kind}: predicted device width is 1.5px`);
          assert.ok(item.observedPhysicalThicknessPx >= 1, `${theme} ${item.kind}: observed physical raster thickness (${item.observedPhysicalThicknessPx}px) must be >= 1 physical pixel`);
          const cropBuf = Buffer.from(item.cropPngBase64, 'base64');
          const cropSha256 = createHash('sha256').update(cropBuf).digest('hex');
          let cropPath = null;
          if (outDir) {
            cropPath = path.join(outDir, `task-6-dpr1.5-${theme}-crop-${item.kind}.png`);
            fs.writeFileSync(cropPath, cropBuf);
          }
          const { cropPngBase64, ...cleanItem } = item;
          themeResults.samples[item.kind] = { ...cleanItem, frameId: fg.frameId, cropPath, cropBytes: cropBuf.length, cropSha256 };
        }
        themeResults.frames.push({ frameId: fg.frameId, width: pngWidth, height: pngHeight, path: fullPath, bytes: pngBuf.length, sha256: fullSha256 });
      }
      assert.equal(Object.keys(themeResults.samples).length, 10, `${theme}: all 10 changed straight border types sampled in DPR 1.5 raster`);
      rasterReport.themes[theme] = themeResults;
    }
    if (outDir) {
      fs.writeFileSync(path.join(outDir, 'task-6-dpr1.5-raster-report.json'), JSON.stringify(rasterReport, null, 2) + '\n');
    }
  } finally { try { if (page) await page.close(); } finally { await server.close(); } }
});
