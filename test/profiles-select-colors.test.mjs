// Computed select and option colour contract across themes and pseudo-states (todo 5).
// Proves computed CSS opacity and WCAG contrast on the live-scale synthetic fixture;
// OS-native popup window pixels are verified separately in todo 2 and todo 11.
import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeLiveScaleHome } from './helpers/profiles-live-scale.mjs';
import { createBoardServer } from '../src/server.mjs';
import { pageHtml } from '../src/render.mjs';
import { launch } from '../scripts/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD_MODEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/view-model-board.json'), 'utf8'));

function parseCssColor(raw) {
  const text = String(raw || '').trim();
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(text);
  if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] === undefined ? 1 : Number(srgb[4]) };
  const rgba = /^rgba?\(([^)]+)\)$/.exec(text);
  if (!rgba) throw new Error(`unrecognized CSS color: ${text}`);
  const p = rgba[1].trim().split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

function compositeOver(fg, bg) {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
}

function relativeLuminance(c) {
  const ch = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function contrastRatio(fgRaw, bgRaw) {
  const fg = parseCssColor(fgRaw), bg = parseCssColor(bgRaw);
  const eff = fg.a < 1 ? compositeOver(fg, bg) : fg;
  const l1 = relativeLuminance(eff), l2 = relativeLuminance(bg);
  return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 10000) / 10000;
}

function rgbKey(fgRaw, bgRaw) {
  const fg = parseCssColor(fgRaw), bg = parseCssColor(bgRaw);
  const c = fg.a < 1 ? compositeOver(fg, bg) : fg;
  return [c.r, c.g, c.b].map((v) => Math.round(v)).join(',');
}

const STEP_SCRIPTS = {
  primary: `(() => {
    const setVal = (sel, val) => { const el = document.querySelector(sel); el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); };
    document.querySelector('[role="tab"][data-tab="primary"]').click();
    const row = document.querySelector('[data-pf="row-toggle"][data-row="agent:prometheus"]');
    if (row.getAttribute('aria-expanded') !== 'true') row.click();
    setVal('#pf-agent-provider-prometheus', 'opencode');
    setVal('#pf-agent-pin-prometheus', 'opencode|claude-fable-5');
    setVal('#pf-primary-backup-prometheus-provider', 'opencode');
    setVal('#pf-primary-backup-prometheus-model', 'opencode/claude-fable-5');
  })()`,
  agents: `(() => {
    const setVal = (sel, val) => { const el = document.querySelector(sel); el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); };
    document.querySelector('[role="tab"][data-tab="agents"]').click();
    const row = document.querySelector('[data-pf="row-toggle"][data-row="route:agents/explore"]');
    if (row.getAttribute('aria-expanded') !== 'true') row.click();
    setVal('#pf-route-agents-explore-provider', 'opencode');
    setVal('#pf-route-agents-explore-model', 'opencode/claude-fable-5');
  })()`,
  memory: `(() => {
    const setVal = (sel, val) => { const el = document.querySelector(sel); el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); };
    document.querySelector('[role="tab"][data-tab="memory"]').click();
    const row = document.querySelector('[data-pf="row-toggle"][data-row="memory:kibitzer"]');
    if (row.getAttribute('aria-expanded') !== 'true') row.click();
    setVal('#pf-memory-kibitzer-mode', 'custom');
    setVal('#pf-memory-kibitzer-service', 'opencode');
    setVal('#pf-memory-kibitzer-model', 'opencode/claude-fable-5');
  })()`,
};

async function readSelectState(page, selector) {
  const doc = await page.client.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await page.client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  assert.ok(nodeId, `missing DOM node for ${selector}`);
  await page.eval(`document.activeElement?.blur?.()`);
  await page.client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  const rest = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}), cs = getComputedStyle(el);
    const opt = el.querySelector('option:not(:disabled)'), disOpt = el.querySelector('option:disabled');
    const ocs = opt ? getComputedStyle(opt) : null, dcs = disOpt ? getComputedStyle(disOpt) : null;
    return { id: el.id, pf: el.dataset.pf, colorScheme: cs.colorScheme, backgroundColor: cs.backgroundColor, color: cs.color,
      borderColor: cs.borderTopColor, option: ocs ? { backgroundColor: ocs.backgroundColor, color: ocs.color } : null,
      disabledOption: dcs ? { backgroundColor: dcs.backgroundColor, color: dcs.color } : null };
  })()`);
  await page.client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  const hover = await page.eval(`(() => { const cs = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return { backgroundColor: cs.backgroundColor, color: cs.color, borderColor: cs.borderTopColor }; })()`);
  await page.client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
  const focus = await page.eval(`(() => { const cs = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return { backgroundColor: cs.backgroundColor, color: cs.color, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor }; })()`);
  await page.client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  return { ...rest, hover, focus };
}

test('select and option computed colours stay opaque and meet contrast across every data-pf select kind in light and dark', { timeout: 90000 }, async (t) => {
  const fx = makeLiveScaleHome(t), state = fx.store.state(), token = 'profiles-select-colors';
  const server = createBoardServer({
    portBase: 51400 + (process.pid % 20) * 8, portCount: 8, generation: 7, token,
    getPage: ({ nonce } = {}) => pageHtml(BOARD_MODEL, 7, { mode: 'server', token, nonce }),
    getViewModel: () => BOARD_MODEL, profilesState: () => state,
  });
  const { port } = await server.start();
  let page;
  const report = { viewport: '1440x900', note: 'Computed CSS styles via CDP CSS.forcePseudoState; OS-native popup window pixels are verified in todo 2 and todo 11.', themes: {} };
  try {
    page = await launch({ width: 1440, height: 900 });
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
    await page.client.send('DOM.enable');
    await page.client.send('CSS.enable');

    const allDomPfs = await page.eval(`[...new Set([...document.querySelectorAll('.pf select[data-pf]')].map(s => s.dataset.pf))].sort()`);
    assert.equal(allDomPfs.length, 21, 'all 21 switcher select data-pf kinds are present in the live-scale DOM');

    for (const theme of ['light', 'dark']) {
      await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await page.eval(`document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
      const disabledSelectSample = await page.eval(`(() => {
        document.querySelector('[role="tab"][data-tab="primary"]').click();
        const row = document.querySelector('[data-pf="row-toggle"][data-row="agent:sisyphus"]');
        if (row.getAttribute('aria-expanded') !== 'true') row.click();
        const el = document.querySelector('#pf-primary-backup-sisyphus-model'), cs = getComputedStyle(el);
        return { id: el.id, pf: el.dataset.pf, disabled: el.disabled, backgroundColor: cs.backgroundColor, color: cs.color };
      })()`);
      assert.equal(disabledSelectSample.disabled, true);
      assert.equal(parseCssColor(disabledSelectSample.backgroundColor).a, 1, `${theme}: disabled select background alpha`);

      const controls = {};
      for (const step of ['primary', 'agents', 'memory']) {
        await page.eval(STEP_SCRIPTS[step]);
        await page.eval(`document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
        const visibleTargets = await page.eval(`(() => {
          const out = [], seen = new Set();
          for (const el of document.querySelectorAll('.pf select[data-pf]')) {
            if (el.disabled || !el.checkVisibility() || el.getBoundingClientRect().width <= 0 || seen.has(el.dataset.pf)) continue;
            seen.add(el.dataset.pf);
            out.push({ pf: el.dataset.pf, id: el.id, selector: '#' + CSS.escape(el.id) });
          }
          return out;
        })()`);
        for (const target of visibleTargets) {
          if (Object.hasOwn(controls, target.pf)) continue;
          const m = await readSelectState(page, target.selector);
          const defaultAlpha = parseCssColor(m.backgroundColor).a, hoverAlpha = parseCssColor(m.hover.backgroundColor).a, focusAlpha = parseCssColor(m.focus.backgroundColor).a;
          assert.ok(m.option, `${theme} ${target.pf}: enabled option present`);
          const optionBgAlpha = parseCssColor(m.option.backgroundColor).a;
          const normalOptionContrast = contrastRatio(m.option.color, m.option.backgroundColor), normalRgb = rgbKey(m.option.color, m.option.backgroundColor);
          let disabledOptionContrast = null, disabledRgb = null;
          if (m.disabledOption) {
            assert.equal(parseCssColor(m.disabledOption.backgroundColor).a, 1, `${theme} ${target.pf}: disabled option background alpha must be 1`);
            disabledOptionContrast = contrastRatio(m.disabledOption.color, m.disabledOption.backgroundColor);
            disabledRgb = rgbKey(m.disabledOption.color, m.disabledOption.backgroundColor);
          }
          assert.equal(m.colorScheme, 'light dark', `${theme} ${target.pf}: explicit color-scheme`);
          assert.equal(defaultAlpha, 1, `${theme} ${target.pf}: default select background alpha must be 1 (got ${m.backgroundColor})`);
          assert.equal(hoverAlpha, 1, `${theme} ${target.pf}: hover select background alpha must be 1 (got ${m.hover.backgroundColor})`);
          assert.equal(focusAlpha, 1, `${theme} ${target.pf}: focus select background alpha must be 1 (got ${m.focus.backgroundColor})`);
          assert.notEqual(m.hover.backgroundColor, m.backgroundColor, `${theme} ${target.pf}: hover background changes`);
          assert.equal(optionBgAlpha, 1, `${theme} ${target.pf}: option background alpha must be 1 (got ${m.option.backgroundColor})`);
          assert.ok(normalOptionContrast >= 4.5, `${theme} ${target.pf}: normal option contrast ${normalOptionContrast} < 4.5`);
          if (m.disabledOption) {
            assert.ok(disabledOptionContrast >= 3, `${theme} ${target.pf}: disabled option contrast ${disabledOptionContrast} < 3.0`);
            assert.notEqual(disabledRgb, normalRgb, `${theme} ${target.pf}: disabled option foreground must differ from normal option foreground`);
          }
          controls[target.pf] = { step, id: m.id, pf: m.pf, colorScheme: m.colorScheme,
            default: { backgroundColor: m.backgroundColor, color: m.color, alpha: defaultAlpha },
            hover: { backgroundColor: m.hover.backgroundColor, color: m.hover.color, borderColor: m.hover.borderColor, alpha: hoverAlpha },
            focus: { backgroundColor: m.focus.backgroundColor, color: m.focus.color, outlineStyle: m.focus.outlineStyle, outlineColor: m.focus.outlineColor, alpha: focusAlpha },
            option: { backgroundColor: m.option.backgroundColor, color: m.option.color, backgroundAlpha: optionBgAlpha, contrast: normalOptionContrast, effectiveRgb: normalRgb },
            disabledOption: m.disabledOption ? { backgroundColor: m.disabledOption.backgroundColor, color: m.disabledOption.color, backgroundAlpha: parseCssColor(m.disabledOption.backgroundColor).a, contrast: disabledOptionContrast, effectiveRgb: disabledRgb } : null };
        }
      }
      await page.eval(`(() => { document.querySelector('[role="tab"][data-tab="primary"]').click(); const sel = document.querySelector('#pf-lane-select'); sel.value = 'custom-literal'; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      const doc = await page.client.send('DOM.getDocument', { depth: 1 });
      const { nodeId } = await page.client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#pf-lane-literal' });
      await page.client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      const bg = await page.eval(`getComputedStyle(document.querySelector('#pf-lane-literal')).backgroundColor`);
      await page.client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
      const textInputHover = { id: 'pf-lane-literal', backgroundColor: bg, alpha: parseCssColor(bg).a };
      assert.ok(textInputHover.alpha < 1, `${theme}: text input hover keeps translucent var(--fill-hover)`);

      assert.deepEqual(Object.keys(controls).sort(), allDomPfs, `${theme}: every select data-pf kind was measured`);
      const withDisabledOpts = Object.values(controls).filter((c) => c.disabledOption !== null).map((c) => c.pf).sort();
      assert.deepEqual(withDisabledOpts, ['agent-pin', 'backup-model', 'memory-model', 'route-backup', 'route-model', 'summarizer-model'],
        `${theme}: model/backup/pin selects expose disabled options and pass >=3:1 distinct contrast`);
      report.themes[theme] = { disabledSelectSample, textInputHover, controls };
    }
    t.diagnostic(JSON.stringify(report));
    if (process.env.OMO_SELECT_COLORS_OUT) {
      fs.mkdirSync(path.dirname(path.resolve(process.env.OMO_SELECT_COLORS_OUT)), { recursive: true });
      fs.writeFileSync(process.env.OMO_SELECT_COLORS_OUT, JSON.stringify(report, null, 2) + '\n');
    }
  } finally { try { if (page) await page.close(); } finally { await server.close(); } }
});
