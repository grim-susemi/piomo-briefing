// Source-order CSS cascade regression gate for pointer (>=24px) and phone (<=599px, >=44px) hit targets.
import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseTokens(tokensCss) {
  const clean = stripComments(tokensCss);
  const rootMatch = /:root\s*\{([^}]*)\}/.exec(clean);
  const map = new Map();
  if (rootMatch) {
    for (const m of rootMatch[1].matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g)) {
      map.set(m[1].trim(), m[2].trim());
    }
  }
  return map;
}

function resolvePx(rawVal, tokens, isPhone) {
  if (!rawVal) return null;
  let v = rawVal.trim();
  for (let depth = 0; depth < 5; depth++) {
    const varMatch = /^var\((--[a-zA-Z0-9_-]+)(?:,\s*([^)]+))?\)$/.exec(v);
    if (!varMatch) break;
    const name = varMatch[1];
    if (isPhone && name === '--rail-btn') return 44;
    v = tokens.get(name) || varMatch[2] || '';
  }
  const pxMatch = /^(\d+(?:\.\d+)?)px$/.exec(v);
  return pxMatch ? Number(pxMatch[1]) : null;
}

// Parse CSS rules in exact source order, tracking enclosing @media condition (null for top-level).
function parseCssRulesInOrder(cssText) {
  const clean = stripComments(cssText);
  const rules = [];
  let i = 0;
  let order = 0;

  function parseRules( endIdx, mediaCond) {
    while (i < endIdx) {
      while (i < endIdx && /\s/.test(clean[i])) i++;
      if (i >= endIdx) break;
      if (clean[i] === '}') {
        i++;
        break;
      }
      const openBrace = clean.indexOf('{', i);
      if (openBrace < 0 || openBrace >= endIdx) break;
      const prelude = clean.slice(i, openBrace).replace(/\s+/g, ' ').trim();
      i = openBrace + 1;

      if (prelude.startsWith('@media')) {
        let depth = 1;
        let j = i;
        while (j < endIdx && depth > 0) {
          if (clean[j] === '{') depth++;
          else if (clean[j] === '}') depth--;
          j++;
        }
        const blockEnd = j - 1;
        parseRules(blockEnd, prelude);
        i = j;
      } else if (prelude.startsWith('@keyframes')) {
        let depth = 1;
        while (i < endIdx && depth > 0) {
          if (clean[i] === '{') depth++;
          else if (clean[i] === '}') depth--;
          i++;
        }
      } else {
        const closeBrace = clean.indexOf('}', i);
        if (closeBrace < 0) break;
        const body = clean.slice(i, closeBrace);
        i = closeBrace + 1;
        const selectors = prelude.split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
        const decls = {};
        for (const d of body.split(';')) {
          const colon = d.indexOf(':');
          if (colon > 0) {
            const prop = d.slice(0, colon).trim().toLowerCase();
            const val = d.slice(colon + 1).trim();
            decls[prop] = val;
          }
        }
        rules.push({ order: order++, media: mediaCond, selectors, decls });
      }
    }
  }

  parseRules(clean.length, null);
  return rules;
}

function mediaApplies(media, widthPx) {
  if (!media) return true;
  const maxMatch = /max-width\s*:\s*(\d+)px/.exec(media);
  if (maxMatch) return widthPx <= Number(maxMatch[1]);
  const minMatch = /min-width\s*:\s*(\d+)px/.exec(media);
  if (minMatch) return widthPx >= Number(minMatch[1]);
  return false;
}

function computeEffectiveTargetHeight(rules, targetSelector, widthPx, tokens) {
  const isPhone = widthPx <= 599;
  let lastMinHeight = null;
  let lastHeight = null;
  let lastLineHeight = null;
  let lastPadY = 0;
  let lastOrder = -1;

  for (const r of rules) {
    if (!mediaApplies(r.media, widthPx)) continue;
    if (!r.selectors.includes(targetSelector)) continue;
    lastOrder = r.order;
    if (r.decls['min-height']) {
      const px = resolvePx(r.decls['min-height'], tokens, isPhone);
      if (px !== null) lastMinHeight = px;
    }
    if (r.decls['height']) {
      const px = resolvePx(r.decls['height'], tokens, isPhone);
      if (px !== null) lastHeight = px;
    }
    if (r.decls['line-height']) {
      const px = resolvePx(r.decls['line-height'], tokens, isPhone);
      if (px !== null) lastLineHeight = px;
    }
    if (r.decls['padding']) {
      const parts = r.decls['padding'].trim().split(/\s+/);
      const topPx = resolvePx(parts[0], tokens, isPhone);
      const botPx = parts.length >= 3 ? resolvePx(parts[2], tokens, isPhone) : topPx;
      if (topPx !== null && botPx !== null) lastPadY = topPx + botPx;
    }
  }

  const boxHeight = Math.max(
    lastMinHeight ?? 0,
    lastHeight ?? 0,
    (lastLineHeight ?? 0) + lastPadY
  );
  return { boxHeight, lastMinHeight, lastHeight, lastOrder };
}

test('target-size cascade gate: page.css and convo.css interactive disclosure/action targets resolve >=24px on desktop and >=44px at <=599px in source order', () => {
  const tokens = parseTokens(readText('src/page/tokens.css'));
  const pageRules = parseCssRulesInOrder(readText('src/page/page.css'));
  const convoRules = parseCssRulesInOrder(readText('src/page/convo.css'));

  const pageTargets = [
    '.overview .sess > .sessh',
    '.overview > .proj > .projh',
    '.overview > .more',
    '.overview .sess > .more',
    '.more',
    '.detail-btn',
    '.copy',
    '.legend-btn',
    '.ans-opt',
    '.ans-write',
    '.ans-go',
    '.ans-cancel',
    '.focusbtn',
  ];

  for (const sel of pageTargets) {
    const desktop = computeEffectiveTargetHeight(pageRules, sel, 1180, tokens);
    const phone = computeEffectiveTargetHeight(pageRules, sel, 599, tokens);
    assert.ok(desktop.lastOrder >= 0, `page.css missing rule for ${sel}`);
    assert.ok(desktop.boxHeight >= 24, `page.css desktop target ${sel} must be >= 24px, got ${desktop.boxHeight}px`);
    assert.ok(phone.boxHeight >= 44, `page.css phone (<=599px) last matching declaration for ${sel} must be >= 44px, got ${phone.boxHeight}px (min-height=${phone.lastMinHeight})`);
  }

  const convoTargets = [
    '.stabs .st',
    '.scard-go',
    '.cv-sec > summary',
    '.att > summary',
    '.held-decs > summary',
    '.dt > summary',
    '.cv-pick',
    '.cv-prevgo',
  ];

  for (const sel of convoTargets) {
    const desktop = computeEffectiveTargetHeight(convoRules, sel, 1180, tokens);
    const phone = computeEffectiveTargetHeight(convoRules, sel, 599, tokens);
    assert.ok(desktop.lastOrder >= 0, `convo.css missing rule for ${sel}`);
    assert.ok(desktop.boxHeight >= 24, `convo.css desktop target ${sel} must be >= 24px, got ${desktop.boxHeight}px`);
    assert.ok(phone.boxHeight >= 44, `convo.css phone (<=599px) last matching declaration for ${sel} must be >= 44px, got ${phone.boxHeight}px (min-height=${phone.lastMinHeight})`);
  }
});
