// W2 readability & scroll-owner QA runner (plan herdr-dag-active-tracking, checkbox 5 & 7).
//
// Usage:
//   node scripts/qa-readability.mjs --out <dir> --phase baseline|candidate [--sizes 1180x700,1440x900]
//
// Serves the board over anonymized readability fixtures (test/fixtures/readability/) and temporary profile homes
// outside the live board's 47317-47326 port range, opens ONE headless Chrome via scripts/cdp.mjs, and measures at
// 1180x700 and 1440x900:
//   1. The #main scroll owner and every nested vertical/horizontal scroll owner in DOM (with region, direction, open state).
//   2. The first-body-row / active title position within the first 160 CSS px (N=8 * 20px) of #main.
//   3. Card-in-card nested visual containers (double background / border / shadow inside outer session or section containers).
//   4. Scroll budget S = sum ceil(abs(delta)/visibleSize) per named flow (role, profile, memory) and hit-test / occlusion.
//
// Writes to <out>/:
//   - inventory.json
//   - before-1180x700.json / candidate-1180x700.json (plus before-1180x700.json when phase=baseline)
//   - before-1440x900.json / candidate-1440x900.json (plus before-1440x900.json when phase=baseline)
//   - failures.json
// Also mirrors inventory.json, before-1180x700.json, before-1440x900.json, failures.json to the parent directory of <out>
// when <out> ends with /before or /baseline so both --out <dir>/before and <dir>/ receive the canonical artifacts.
import '../test/helpers/refuse-live-writes.mjs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, listProfilePids, isPidAlive, watchCsp, axSnapshot, unnamedInteractive } from './cdp.mjs';
import { FLOW_LIB } from './qa-flow-map.mjs';
import { createBoardServer } from '../src/server.mjs';
import { pageHtml } from '../src/render.mjs';
import { formatJsonText, openProfilesStore } from '../src/profiles/store.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const MANIFEST_FILE = path.join(ROOT, 'test/fixtures/readability/manifest.json');
const VM_FILE = path.join(ROOT, 'test/fixtures/readability/view-model.json');
const PF_STATE_FILE = path.join(ROOT, 'test/fixtures/readability/profiles-state.json');
const MEMENTO_FILE = path.join(ROOT, 'test/fixtures/readability/memento-state.json');
const ASSET_DIR = path.join(ROOT, 'test/fixtures/board-assets');
const GOLDEN = path.join(ROOT, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files');
const REGISTRY = path.join(ROOT, 'test/fixtures/profiles/registry');
const INVENTORY_FILE = path.join(ROOT, 'src/profiles/inventory.json');

const LIVE_HOMES = [
  'C:/Users/USER/.omo',
  'C:/Users/USER/.omo-stable-500/home/.omo',
  'C:/Users/USER/.omo-original/home/.omo',
  'C:/Users/USER/.somo/home/.omo',
];
const LIVE_BOARD = [47317, 47326];
const PS_STYLE = { bom: true, eol: '\r\n', indent: '    ', keySep: ':  ', trailingNewline: true };
const FIXED_NOW = 1792204200000;
const TOKEN = 'piomo-w2-readability-token';

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const OUT = arg('--out') ? path.resolve(arg('--out')) : '';
const PHASE = arg('--phase', 'baseline');
const SIZES = arg('--sizes', '1180x700,1440x900').split(',').map((s) => {
  const m = /^(\d+)x(\d+)$/.exec(s.trim());
  if (!m) throw new Error('bad --sizes entry ' + s);
  return { width: Number(m[1]), height: Number(m[2]), name: m[1] + 'x' + m[2] };
});
const PORT_BASE = Number(process.env.OMO_BRIEFING_PORT_BASE || 47660);

if (!OUT || !['baseline', 'candidate'].includes(PHASE)) {
  console.error('usage: node scripts/qa-readability.mjs --out <dir> --phase baseline|candidate [--sizes 1180x700,1440x900]');
  process.exit(2);
}
if (!Number.isInteger(PORT_BASE) || PORT_BASE < 1024 || PORT_BASE + 10 > 65535 || (PORT_BASE <= LIVE_BOARD[1] && PORT_BASE + 10 >= LIVE_BOARD[0])) {
  console.error(`OMO_BRIEFING_PORT_BASE=${PORT_BASE}: needs 10 ports outside the live board's ${LIVE_BOARD.join('-')}`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const slash = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

function assertFixtureRoot(root) {
  const r = slash(root);
  for (const home of LIVE_HOMES.map(slash)) {
    if (r === home || r.startsWith(home + '/') || home.startsWith(r + '/')) {
      throw new Error(`fixture root ${root} touches live home ${home}`);
    }
  }
}

function resolvePinnedPlugin(inventory) {
  const envDir = process.env.OMO_STABLE_PLUGIN;
  if (envDir) {
    const candidate = path.join(envDir, 'extensions', 'omo.js');
    if (fs.existsSync(candidate) && sha256(fs.readFileSync(candidate)) === inventory.sources?.omo?.sha256) {
      return candidate;
    }
  }
  const pinnedPath = inventory.sources?.omo?.path;
  if (pinnedPath && fs.existsSync(pinnedPath) && sha256(fs.readFileSync(pinnedPath)) === inventory.sources?.omo?.sha256) {
    return pinnedPath;
  }
  if (envDir) return path.join(envDir, 'extensions', 'omo.js');
  throw new Error('Cannot resolve pinned plugin omo.js for profiles store');
}

function seedHomes(root) {
  assertFixtureRoot(root);
  const primary = path.join(root, 'primary');
  const stable = path.join(root, 'stable');
  fs.mkdirSync(path.join(primary, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(stable, 'agent'), { recursive: true });
  const write = (file, value) => fs.writeFileSync(file, formatJsonText(value, PS_STYLE));
  const golden = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN, name), 'utf8'));
  write(path.join(primary, 'omo.jsonc'), golden('primary/omo.jsonc.json'));
  write(path.join(primary, 'agent', 'settings.json'), golden('primary/settings.json.json'));
  write(path.join(primary, 'native-profile-selection.json'), { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' });
  write(path.join(primary, 'agent', 'native-profile-selection.json'), { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' });
  write(path.join(stable, 'omo.jsonc'), golden('stable/omo.jsonc.json'));
  fs.writeFileSync(path.join(stable, 'agent', 'settings.json'), '{"packages":["stable"]}');
  fs.copyFileSync(path.join(REGISTRY, 'primary/agent/models.json'), path.join(primary, 'agent', 'models.json'));
  fs.copyFileSync(path.join(REGISTRY, 'stable/agent/models.json'), path.join(stable, 'agent', 'models.json'));
  return { primary, stable, fixtureHash: sha256(fs.readFileSync(path.join(primary, 'agent', 'models.json'))) };
}

function createPhasePageFs(phase) {
  if (phase !== 'baseline') return fs;
  const pageDir = path.join(ROOT, 'src/page');
  const cache = new Map();
  const readGit = (rel) => {
    const posixRel = rel.replace(/\\/g, '/');
    if (cache.has(posixRel)) return cache.get(posixRel);
    const r = spawnSync('git', ['-C', ROOT, 'show', `HEAD:${posixRel}`], { encoding: null, maxBuffer: 16 * 1024 * 1024 });
    if (r.status === 0 && r.stdout) {
      cache.set(posixRel, r.stdout);
      return r.stdout;
    }
    return null;
  };
  return {
    ...fs,
    readFileSync(filePath, options) {
      const resolved = path.resolve(String(filePath));
      if (resolved.startsWith(pageDir + path.sep)) {
        const rel = path.relative(ROOT, resolved);
        const buf = readGit(rel);
        if (buf) {
          if (typeof options === 'string') return buf.toString(options);
          if (options && typeof options === 'object' && options.encoding) return buf.toString(options.encoding);
          return buf;
        }
      }
      return fs.readFileSync(filePath, options);
    },
  };
}

function computeSourceHashes(pageFs = fs) {
  const pageDir = path.join(ROOT, 'src/page');
  const files = fs.readdirSync(pageDir).filter((f) => /\.(js|css)$/.test(f)).sort()
    .map((f) => 'src/page/' + f)
    .concat(['src/page/generated/profiles-view.min.js', 'src/render.mjs', 'src/server.mjs', 'src/server-host.mjs']);
  const map = {};
  for (const f of files) {
    map[f] = sha256(pageFs.readFileSync(path.join(ROOT, f)));
  }
  let head = 'unknown';
  try {
    const r = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (r.status === 0) head = r.stdout.trim();
  } catch {}
  return {
    head,
    sourceHash: sha256(JSON.stringify(map)),
    files: map,
    qaScriptSha256: sha256(fs.readFileSync(SELF)),
  };
}

const PAGE_CLOCK = `(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} const offset = ${FIXED_NOW} - Date.now(); const wall = Date.now.bind(Date); Date.now = () => wall() + offset; })();`;

const READABILITY_LIB = `(() => {
  const FORBIDDEN_SELECTORS = ['.pf-detail', '#pf-sec-profiles', '.pf-roles', '.pf-tray', '.pf-panes'];
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) });
  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1) return 'unknown';
    if (el === document.documentElement || el === document.body) return 'document';
    if (el.id) return '#' + el.id;
    const flow = el.getAttribute('data-flow');
    if (flow) return el.tagName.toLowerCase() + '[data-flow="' + flow + '"]';
    const pfSec = el.getAttribute('data-pf-sec');
    if (pfSec) return el.tagName.toLowerCase() + '[data-pf-sec="' + pfSec + '"]';
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean);
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.slice(0, 3).join('.') : '');
  };
  const regionOf = (el) => {
    if (!el || el.nodeType !== 1) return 'unknown';
    if (el === document.documentElement || el === document.body) return 'document';
    if (el.id === 'main') return 'main';
    if (el.closest('#side')) return 'sidebar';
    if (el.closest('#rail')) return 'rail';
    if (el.closest('#tabs')) return 'tabs';
    if (el.closest('dialog[open]')) return 'modal';
    if (el.closest('.pop, [data-ann-pop]')) return 'popover';
    if (el.closest('#office')) return 'office';
    if (el.closest('#main')) return 'main-descendant';
    return 'shell';
  };
  const openStateOf = (el) => {
    const dlg = el.closest && el.closest('dialog');
    if (dlg) return dlg.open ? 'dialog-open' : 'dialog-closed';
    const det = el.closest && el.closest('details');
    if (det) return det.open ? 'details-open' : 'details-closed';
    const panel = el.closest && el.closest('[data-pf-panel]');
    if (panel) return panel.hasAttribute('hidden') ? 'panel-hidden' : 'panel-open';
    const side = el.closest && el.closest('.sh-side');
    if (side) {
      const sh = document.querySelector('.sh-shell');
      return sh ? 'side-' + (sh.getAttribute('data-side') || 'open') : 'side-open';
    }
    return 'open';
  };
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

  window.__readability = {
    settle: async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready.catch(() => null);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
      const anims = document.getAnimations().filter((a) => a.playState === 'running' &&
        !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity));
      await Promise.all(anims.map((a) => a.finished.catch(() => null)));
      await new Promise((r) => requestAnimationFrame(() => r(true)));
      return true;
    },
    scanScrollers(viewId) {
      const main = document.getElementById('main');
      const mainCs = main ? getComputedStyle(main) : null;
      const mainRect = main ? box(main.getBoundingClientRect()) : null;
      const mainOwner = main ? {
        selector: '#main',
        region: 'main',
        direction: 'vertical',
        openState: 'open',
        overflowY: mainCs.overflowY,
        overflowX: mainCs.overflowX,
        clientHeight: main.clientHeight,
        scrollHeight: main.scrollHeight,
        clientWidth: main.clientWidth,
        scrollWidth: main.scrollWidth,
        canScrollY: /(auto|scroll)/.test(mainCs.overflowY),
        activelyScrollsY: main.scrollHeight > main.clientHeight + 1,
        sidewaysOverflow: main.scrollWidth > main.clientWidth + 1,
        rect: mainRect,
      } : null;

      const allScrollers = [];
      const nestedVerticalInMain = [];
      const forbiddenVerticalMatches = [];
      const tableHorizontalOverflows = [];

      const se = document.scrollingElement;
      if (se && se !== main) {
        const seCs = getComputedStyle(se);
        const docScrollsY = se.scrollHeight > se.clientHeight + 1 && /(auto|scroll|visible)/.test(seCs.overflowY) && getComputedStyle(document.querySelector('.sh-shell') || document.body).overflow !== 'hidden';
        if (docScrollsY) {
          allScrollers.push({
            selector: 'document',
            region: 'document',
            direction: 'vertical',
            openState: 'open',
            overflowY: seCs.overflowY,
            overflowX: seCs.overflowX,
            clientHeight: se.clientHeight,
            scrollHeight: se.scrollHeight,
            allowed: false,
            reason: 'document must not scroll vertically inside fixed shell',
          });
        }
      }

      for (const el of document.querySelectorAll('*')) {
        if (!isVisible(el)) continue;
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        const ox = cs.overflowX;
        const vRule = /(auto|scroll)/.test(oy);
        const hRule = /(auto|scroll)/.test(ox);
        const vOver = el.scrollHeight > el.clientHeight + 1;
        const hOver = el.scrollWidth > el.clientWidth + 1;
        const matchesForbidden = FORBIDDEN_SELECTORS.some((sel) => el.matches(sel));

        if (el.matches('table, .rbk-scroll, .plan-task-table, .plan-qa-table, .cv-hist') && hOver) {
          tableHorizontalOverflows.push({
            selector: selectorOf(el),
            region: regionOf(el),
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
            overflowX: ox,
          });
        }

        if (!vRule && !hRule && !matchesForbidden) continue;

        const dir = vRule && hRule ? 'both' : vRule ? 'vertical' : hRule ? 'horizontal' : 'none';
        const region = regionOf(el);
        const openState = openStateOf(el);
        const inMain = !!(main && el !== main && main.contains(el));
        const inOpenModal = !!(el.closest('dialog[open], .pop, [data-ann-pop]'));
        const inOffice = !!(el.closest('#office'));
        const isSidebarScroller = el.matches('.sh-scroll') && region === 'sidebar';
        const isHorizontalAllow = !vRule && hRule && el.matches('.flowbox, .plan-lanes, .rbk-scroll, .stabs, .sh-tabs');

        let allowed = false;
        let reason = '';
        if (el === main) {
          allowed = true;
          reason = 'primary #main vertical scroller';
        } else if (isSidebarScroller) {
          allowed = true;
          reason = 'allow-listed sidebar .sh-scroll outside #main';
        } else if (inOpenModal && vRule) {
          allowed = true;
          reason = 'allow-listed open modal/popover scroller';
        } else if (inOffice && (vRule || hRule)) {
          allowed = true;
          reason = 'allow-listed dedicated office canvas scroller';
        } else if (isHorizontalAllow) {
          allowed = true;
          reason = 'allow-listed horizontal-only scroller';
        } else if (vRule && inMain) {
          allowed = false;
          reason = 'forbidden nested vertical scroller inside #main';
        } else if (matchesForbidden && vRule) {
          allowed = false;
          reason = 'forbidden fixed-height profile scroller';
        } else {
          allowed = !vRule;
          reason = vRule ? 'unlisted vertical scroller' : 'horizontal scroller';
        }

        const entry = {
          selector: selectorOf(el),
          matchedForbiddenSelector: FORBIDDEN_SELECTORS.find((sel) => el.matches(sel)) || null,
          region,
          direction: dir,
          openState,
          inMain,
          overflowY: oy,
          overflowX: ox,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          hasVerticalOverflowRule: vRule,
          activelyScrollsY: vRule && vOver,
          activelyScrollsX: hRule && hOver,
          allowed,
          reason,
          rect: box(el.getBoundingClientRect()),
        };

        allScrollers.push(entry);
        if (inMain && vRule && !inOpenModal && !inOffice) {
          nestedVerticalInMain.push(entry);
        }
        if (matchesForbidden && (vRule || vOver)) {
          forbiddenVerticalMatches.push(entry);
        }
      }

      const openDialog = document.querySelector('dialog[open]');
      let dialogLocksBackground = null;
      if (openDialog && main) {
        const mainOy = getComputedStyle(main).overflowY;
        const bodyOy = getComputedStyle(document.body).overflowY;
        dialogLocksBackground = mainOy === 'hidden' || main.hasAttribute('inert') || bodyOy === 'hidden';
      }

      return {
        mainOwner,
        allScrollers,
        nestedVerticalInMain,
        forbiddenVerticalMatches,
        tableHorizontalOverflows,
        dialogOpen: !!openDialog,
        dialogLocksBackground,
      };
    },
    measureFirstTitle(spec) {
      const main = document.getElementById('main');
      if (!main) return { ok: false, reason: 'missing #main' };
      const mr = main.getBoundingClientRect();

      // For overview: check both the first rendered session row AND the expected active session
      if (spec.screen === 'overview') {
        const allSess = [...main.querySelectorAll('details.sess')];
        const openSess = [...main.querySelectorAll('details.sess[open]')];
        const firstOpenCard = main.querySelector('details.sess[open] .card');
        const firstOpenId = firstOpenCard ? firstOpenCard.getAttribute('data-card') : null;
        const inactiveForcedOpen = [...main.querySelectorAll('details.sess[open] .card.st-done')].map((c) => c.getAttribute('data-card'));
        const activeSessionIds = ['fx-sess-beta-active', 'fx-sess-gamma-running'];
        const activeDetails = activeSessionIds.map((id) => {
          const card = main.querySelector('[data-card="' + id + '"]');
          const sess = card ? card.closest('details.sess') : null;
          const proj = card ? card.closest('details.proj') : null;
          const titleEl = card ? card.querySelector('.ch') || card.querySelector('.title') : null;
          const statusEl = card ? card.querySelector('.chip') : null;
          const labelEl = card ? card.querySelector('.title') : null;
          const tr = titleEl && isVisible(titleEl) ? titleEl.getBoundingClientRect() : null;
          const relTop = tr ? Math.round(tr.top - mr.top) : null;
          const relBottom = tr ? Math.round(tr.bottom - mr.top) : null;
          const withinTop160 = tr !== null && relTop >= 0 && relBottom <= 160 && tr.height > 0;
          const hasStatusAndLabel = !!(statusEl && statusEl.textContent.trim() && labelEl && labelEl.textContent.trim());
          return {
            sessionId: id,
            projOpen: !!(proj && proj.open),
            sessOpen: !!(sess && sess.open),
            visible: tr !== null,
            relTop,
            relBottom,
            rect: tr ? box(tr) : null,
            withinTop160,
            hasStatusAndLabel,
            statusText: statusEl ? statusEl.textContent.trim() : '',
            labelText: labelEl ? labelEl.textContent.trim() : '',
          };
        });
        const primaryActive = activeDetails.find((a) => a.sessionId === (spec.expectedActiveSessionId || 'fx-sess-beta-active')) || activeDetails[0];
        const allActiveOpen = activeDetails.every((a) => a.projOpen && a.sessOpen);
        const ok = inactiveForcedOpen.length === 0 && allActiveOpen && primaryActive && primaryActive.withinTop160 && primaryActive.hasStatusAndLabel;
        return {
          ok,
          mainTop: Math.round(mr.top),
          firstOpenId,
          inactiveForcedOpen,
          allActiveOpen,
          primaryActive,
          activeDetails,
          scrollBudgetInitial: primaryActive && primaryActive.withinTop160 ? 0 : (primaryActive && primaryActive.relBottom > 160 ? Math.ceil((primaryActive.relBottom - 160) / Math.max(1, main.clientHeight)) : 1),
        };
      }

      const sel = spec.activeTitleSelector || '#main h1, #main h2, #main .title';
      const el = document.querySelector(sel);
      const isOutSibling = spec.scope === 'OUT-SIBLING' || spec.titleGate === false;
      if (!el || !isVisible(el)) {
        return {
          ok: false,
          selector: sel,
          visible: false,
          relTop: null,
          relBottom: null,
          withinTop160: false,
          titleGate: !isOutSibling,
          judgment: isOutSibling ? (spec.judgment || 'shell-input-regression') : 'n8-title-gate',
        };
      }
      const r = el.getBoundingClientRect();
      const baseTop = el.closest('dialog[open]') ? el.closest('dialog[open]').getBoundingClientRect().top : mr.top;
      const relTop = Math.round(r.top - baseTop);
      const relBottom = Math.round(r.bottom - baseTop);
      const text = el.textContent.trim();
      const withinTop160 = relTop >= 0 && relBottom <= 160 && r.height > 0 && text.length > 0;
      const headingRendered = r.height > 0 && text.length > 0;
      return {
        ok: isOutSibling ? headingRendered : withinTop160,
        selector: selectorOf(el),
        matchedSelector: sel,
        visible: true,
        text: text.slice(0, 80),
        relTop,
        relBottom,
        rect: box(r),
        withinTop160,
        titleGate: !isOutSibling,
        judgment: isOutSibling ? (spec.judgment || 'shell-input-regression') : 'n8-title-gate',
        scrollBudgetInitial: isOutSibling ? 0 : (withinTop160 ? 0 : Math.ceil(Math.max(0, relBottom - 160) / Math.max(1, main.clientHeight))),
      };
    },
    verifyScreenContent(spec) {
      const main = document.getElementById('main');
      if (!main) return { ok: false, marker: 'missing #main', count: 0, sample: '' };
      if (spec.screen === 'overview') {
        const cards = [...main.querySelectorAll('details.sess .card[data-card]')];
        const summaries = [...main.querySelectorAll('details.sess > summary.sessh')];
        const hasAlpha = !!main.querySelector('[data-card="fx-sess-alpha-done"]');
        const hasBeta = !!main.querySelector('[data-card="fx-sess-beta-active"]');
        const hasGamma = !!main.querySelector('[data-card="fx-sess-gamma-running"]');
        const extraOk = spec.state === 'expanded'
          ? !!main.querySelector('[data-card="fx-sess-beta-active"] .detail')
          : spec.state === 'dirty'
            ? (main.querySelector('[data-card="fx-sess-beta-active"] [data-field="layout_note"]')?.value === '더티 상태 입력 보존 테스트')
            : spec.state === 'offline'
              ? !!main.querySelector('.overview .note.ro')
              : true;
        const ok = cards.length === 3 && summaries.length === 3 && hasAlpha && hasBeta && hasGamma && extraOk;
        return {
          ok,
          marker: 'details.sess .card[data-card] (fx-sess-alpha-done, fx-sess-beta-active, fx-sess-gamma-running)',
          count: cards.length,
          sample: cards.map((c) => c.getAttribute('data-card')).join(','),
        };
      }
      if (spec.screen === 'convo') {
        const h1 = main.querySelector('.cv-h1');
        const scards = main.querySelectorAll('.scard');
        const extraOk = spec.state === 'expanded'
          ? main.querySelectorAll('details.dt[open], details.cv-notes[open], details.att[open]').length >= 2
          : spec.state === 'dirty'
            ? (main.querySelector('[data-field="layout_note"]')?.value === '대화 탭 더티 입력값')
            : true;
        const ok = !!(h1 && h1.textContent.includes('뷰포트전환')) && scards.length === 4 && extraOk;
        return {
          ok,
          marker: '#main .cv-h1 ("뷰포트전환") + 4 .scard',
          count: scards.length,
          sample: h1 ? h1.textContent.trim() : '',
        };
      }
      if (spec.screen === 'plan') {
        const boxes = main.querySelectorAll('.plan-box');
        const extraOk = spec.state === 'expanded'
          ? main.querySelectorAll('.plan-toggle[aria-expanded="true"]').length >= 1
          : true;
        const ok = !!main.querySelector('.plan-view') && boxes.length >= 5 && extraOk;
        return {
          ok,
          marker: '#main .plan-view .plan-box',
          count: boxes.length,
          sample: boxes[0] ? boxes[0].textContent.trim().slice(0, 60) : '',
        };
      }
      if (spec.screen === 'workers') {
        const rows = main.querySelectorAll('.w-row[data-worker]');
        const extraOk = spec.state === 'expanded'
          ? main.querySelectorAll('.w-todos').length >= 1
          : true;
        const ok = rows.length === 4 && extraOk;
        return {
          ok,
          marker: '#main .w-row[data-worker]',
          count: rows.length,
          sample: [...rows].map((r) => r.getAttribute('data-worker')).join(','),
        };
      }
      if (spec.screen === 'convo-dec') {
        const dcards = main.querySelectorAll('.dcard[data-decision]');
        const hist = main.querySelectorAll('table.cv-hist tbody tr');
        const ok = dcards.length === 2 && hist.length >= 1;
        return {
          ok,
          marker: '#main .dcard[data-decision] + table.cv-hist',
          count: dcards.length,
          sample: [...dcards].map((d) => d.getAttribute('data-decision')).join(','),
        };
      }
      if (spec.screen === 'blocks') {
        const figs = main.querySelectorAll('figure.rbk');
        const ropts = main.querySelectorAll('.ropt');
        const ok = figs.length === 6 && ropts.length === 3;
        return {
          ok,
          marker: 'figure.rbk (6 block kinds) + .ropt (3 image cards)',
          count: figs.length,
          sample: [...figs].map((f) => f.className).join(','),
        };
      }
      if (spec.screen.startsWith('profiles')) {
        const pfRoot = main.querySelector('[data-pf-root][data-pf-state="view"]');
        const pfCards = main.querySelectorAll('.pf-card');
        let extraOk = true;
        if (spec.state === 'expanded') {
          const rowKey = spec.tab === 'primary' ? 'agent:sisyphus' : spec.tab === 'agents' ? 'route:agents/explore' : 'route:categories/visual-engineering';
          extraOk = !!main.querySelector('.pf-row-sum[data-row="' + rowKey + '"][aria-expanded="true"]');
        } else if (spec.state === 'dirty') {
          extraOk = main.querySelectorAll('.pf-tray [data-pf-pending], .pf-tray .pf-pending-r, .pf-tray .pf-sec-b').length >= 1;
        } else if (spec.state === 'offline') {
          extraOk = pfRoot?.getAttribute('data-readonly') === 'true' && !main.querySelector('[data-flow="apply:detail"]');
        } else if (spec.state === 'dialog-open') {
          extraOk = !!main.querySelector('#pf-guide-dlg[open]');
        }
        const ok = !!pfRoot && pfCards.length === 6 && extraOk;
        return {
          ok,
          marker: '[data-pf-root][data-pf-state="view"] + 6 .pf-card (' + (spec.tab || 'primary') + '/' + spec.state + ')',
          count: pfCards.length,
          sample: pfCards[0] ? pfCards[0].textContent.trim().slice(0, 60) : '',
        };
      }
      if (spec.screen === 'memento') {
        const rows = [...main.querySelectorAll('#memento-cards tr.mcards-row')];
        const titles = [...main.querySelectorAll('#memento-cards .mcards-card-title')].map((n) => n.textContent.trim());
        const loadNotice = (document.getElementById('memento-load')?.textContent || '').trim();
        const ok = loadNotice === '' && rows.length >= 10 && titles.includes('예시 아이디어 12');
        return {
          ok,
          marker: '#memento-cards tr.mcards-row + .mcards-card-title ("예시 아이디어 12")',
          count: rows.length,
          sample: titles.slice(0, 3).join(', '),
        };
      }
      if (spec.screen === 'office') {
        const svg = main.querySelector('#office svg.of-scene');
        const desks = main.querySelectorAll('#office [data-desk]');
        const ok = !!svg && desks.length >= 1;
        return {
          ok,
          marker: '#office svg.of-scene + [data-desk]',
          count: desks.length,
          sample: 'desks:' + desks.length,
        };
      }
      return { ok: false, marker: 'unknown screen ' + spec.screen, count: 0, sample: '' };
    },
    scanNestedCards(scope) {
      const main = document.getElementById('main');
      if (!main || scope === 'OUT-SIBLING') return { count: 0, instances: [] };
      const CANDIDATES = '.card, .dcard, .scard, .rbk, .ropt, .cmpc, .plan-lane, .plan-box, .pf-sec, .pf-card, .pf-tray, .pf-blk, .pf-agent, .pf-route, .pf-mem-row';
      const nodes = [...main.querySelectorAll(CANDIDATES)].filter((el) => isVisible(el) && !el.closest('#office, #memento-cards') && hasVisualBox(el));
      const instances = [];
      for (const el of nodes) {
        const parentBox = el.parentElement ? el.parentElement.closest(CANDIDATES) : null;
        if (parentBox && nodes.includes(parentBox)) {
          const cs = getComputedStyle(el);
          const pcs = getComputedStyle(parentBox);
          instances.push({
            child: selectorOf(el),
            parent: selectorOf(parentBox),
            childStyles: { bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderLeftWidth, shadow: cs.boxShadow !== 'none' },
            parentStyles: { bg: pcs.backgroundColor, border: pcs.borderTopWidth + ' ' + pcs.borderLeftWidth, shadow: pcs.boxShadow !== 'none' },
          });
        }
      }
      return { count: instances.length, instances };
    },
    measureSpaceAndHitTargets() {
      const main = document.getElementById('main');
      const mainCs = main ? getComputedStyle(main) : null;
      const se = document.scrollingElement;
      const seCs = se ? getComputedStyle(se) : null;
      const shellEl = document.querySelector('.sh-shell') || document.body;

      const mainOwnsVertical = !!(main && /(auto|scroll)/.test(mainCs.overflowY));

      const docScrollsVertically = !!(
        se &&
        se !== main &&
        se.scrollHeight > se.clientHeight + 1 &&
        seCs &&
        /(auto|scroll|visible)/.test(seCs.overflowY) &&
        getComputedStyle(shellEl).overflow !== 'hidden'
      );
      const documentDoesNotScrollVertically = !docScrollsVertically;
      const docScrollCount = docScrollsVertically ? 1 : 0;

      const mainHorizontalOverflow = main ? main.scrollWidth > main.clientWidth + 1 : false;
      const docHorizontalOverflow = se ? se.scrollWidth > se.clientWidth + 1 : false;
      const sidewaysOverflow = mainHorizontalOverflow || docHorizontalOverflow;

      const INTERACTIVE_SEL = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="checkbox"], [role="radio"]';
      const hitTargets = [];

      const controlSelector = (el) => {
        if (!el || el.nodeType !== 1) return 'unknown';
        if (el.id) return '#' + el.id;
        const tag = el.tagName.toLowerCase();
        for (const attr of ['data-flow', 'data-field', 'data-act', 'data-sh', 'data-tab', 'data-key', 'data-sid', 'data-sub', 'data-pf', 'name']) {
          const val = el.getAttribute(attr);
          if (val) return tag + '[' + attr + '="' + val + '"]';
        }
        const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean);
        if (cls.length) return tag + '.' + cls.slice(0, 3).join('.');
        return tag;
      };

      for (const el of document.querySelectorAll(INTERACTIVE_SEL)) {
        if (!isVisible(el)) continue;
        if (el.closest('[inert]')) continue;

        const r = el.getBoundingClientRect();
        const width = Math.round(r.width);
        const height = Math.round(r.height);

        let effectiveLabelArea = undefined;
        if (el.matches('input[type="radio"], input[type="checkbox"]')) {
          const label = el.closest('label') || (el.id ? document.querySelector('label[for="' + el.id + '"]') : null);
          if (label && isVisible(label)) {
            const lr = label.getBoundingClientRect();
            effectiveLabelArea = {
              selector: controlSelector(label),
              width: Math.round(lr.width),
              height: Math.round(lr.height),
            };
          }
        }

        const item = {
          selector: controlSelector(el),
          width,
          height,
        };
        if (effectiveLabelArea) {
          item.effectiveLabelArea = effectiveLabelArea;
        }
        hitTargets.push(item);
      }

      return {
        documentDoesNotScrollVertically,
        mainOwnsVertical,
        docScrollCount,
        sidewaysOverflow,
        hitTargets,
      };
    }
  };
})();`;

// Flow measurement helpers: reuses scripts/qa-flow-map.mjs FLOW_LIB for scrolling/hit/interaction semantics.
// A lightweight adapter bridges window.__flow to window.__flowProbe for step execution while sharing the core implementation.
const FLOW_PROBE_LIB = `(() => {
  ${FLOW_LIB}
  window.__flowProbe = {
    reach(id) {
      const r = window.__flow.reach(id);
      if (r.missing) return { control: id, missing: true };
      const h = window.__flow.hit(id);
      return {
        control: id,
        missing: false,
        scrolls: r.scrolls,
        moved: (r.moved || []).map((m) => ({
          container: m.container,
          px: m.px,
          visible: m.visible,
          cost: m.px ? Math.ceil(m.px / Math.max(1, m.visible)) : 0,
        })),
        view: r.view,
        hit: h,
      };
    },
    act(id) {
      const q = (i) => document.querySelector('[data-flow="' + i + '"]');
      const el = q(id);
      if (!el) return { ok: false };
      if (id.startsWith('card:') || id.startsWith('apply:')) {
        window.__flow.click(id);
        return { ok: true, kind: 'click' };
      }
      const opts = [...el.querySelectorAll('option')].filter((o) => o.value);
      const current = el.value;
      let pick = current;
      if (id.endsWith(':mode')) pick = 'custom';
      else {
        const alt = opts.find((o) => o.value !== current) || opts[opts.length - 1];
        if (alt) pick = alt.value;
      }
      window.__flow.choose(id, pick);
      return { ok: true, kind: 'change', from: current, picked: pick };
    }
  };
})();`;

function waitFor(page, predicate, what, timeout = 12000) {
  return page.eval(`new Promise((resolve, reject) => {
    const check = () => { try { return (${predicate}); } catch (e) { return null; } };
    const hit = check();
    if (hit) return resolve(hit);
    const observer = new MutationObserver(() => { const value = check(); if (value) { done(); resolve(value); } });
    const timer = setTimeout(() => { done(); reject(new Error(${JSON.stringify('timeout waiting for ' + what)})); }, ${timeout});
    function done() { observer.disconnect(); clearTimeout(timer); }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  })`);
}

async function startFixtureServer({ root, vm, memento, pluginPath, portBase, pageFs = fs }) {
  const homes = seedHomes(root);
  const inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
  const store = openProfilesStore({
    primaryHome: homes.primary,
    stableHome: homes.stable,
    mirrorHomes: [],
    pluginPath,
    inventory,
    now: () => FIXED_NOW,
  });
  const referenced = new Set(
    vm.sessions.flatMap((s) => (s.reports || []).flatMap((r) => (r.images || []).map((i) => i.src.replace(/^assets\//, ''))))
  );
  const posts = [];
  const server = createBoardServer({
    portBase,
    portCount: 10,
    generation: vm.gen || 9,
    token: TOKEN,
    assetsDir: ASSET_DIR,
    assetAllowed: (name) => referenced.has(name),
    getPage: ({ nonce } = {}) => pageHtml(vm, vm.gen || 9, { mode: 'server', token: TOKEN, nonce, fs: pageFs }),
    getViewModel: () => vm,
    profilesState: () => store.state(),
    onProfiles: (body) => { posts.push(JSON.parse(JSON.stringify(body))); return store.handle(body); },
    onMementoState: () => ({ status: 200, json: memento }),
    onMemento: async () => ({ status: 200, json: { ok: true, state: memento } }),
    onAnswer: async () => ({ status: 200, json: { ok: true } }),
    onFocus: async () => ({ status: 200, json: { ok: true } }),
  });
  const { port } = await server.start();
  return { url: `http://127.0.0.1:${port}/`, port, server, store, posts, fixtureHash: homes.fixtureHash };
}

async function driveScreen(page, baseUrl, offlineHtmlPath, spec, pfFixture) {
  if (spec.state === 'offline' && spec.screen === 'overview') {
    await page.goto(offlineHtmlPath);
  } else {
    await page.goto(baseUrl);
  }
  await page.eval(READABILITY_LIB);
  await page.eval(FLOW_PROBE_LIB);
  await waitFor(page, `document.getElementById('main') && window.BriefPage && window.BriefShell`, 'board shell');

  // Ensure docked sidebar at desktop widths
  await page.eval(`(() => {
    const sh = document.querySelector('.sh-shell');
    if (sh && sh.getAttribute('data-side') !== 'open' && !matchMedia('(max-width: 899px)').matches) {
      const btn = document.querySelector('.sh-topen');
      if (btn) btn.click();
    }
  })()`);
  await page.eval(`window.__readability.settle()`);

  let preFocusTitle = null;
  let dirtyFocusPreserved = null;

  if (spec.screen === 'overview') {
    // Ensure overview is rendered and wait for real session cards in DOM
    await page.eval(`(() => {
      BriefPage.state.ui.view = 'conv';
      BriefPage.state.ui.active = null;
      BriefPage.state.ui.tabs = [];
      BriefPage.render();
    })()`);
    await waitFor(page, `document.querySelectorAll('#main details.sess .card[data-card]').length === 3 && document.querySelector('#main [data-card="fx-sess-beta-active"]')`, 'overview session cards');
    if (spec.state === 'expanded') {
      await page.eval(`(() => {
        const sid = 'fx-sess-beta-active';
        const card = document.querySelector('[data-card="' + sid + '"]');
        const sess = card && card.closest('details.sess');
        const proj = card && card.closest('details.proj');
        if (proj && !proj.open) proj.open = true;
        if (sess && !sess.open) sess.open = true;
        for (const k of ['detail:' + sid, 'more-ch:' + sid, 'more-dc:' + sid, 'plan:herdr-dag-active-tracking-w2', 'worker:st_fx_run_01']) {
          const btn = document.querySelector('[data-act="exp"][data-key="' + k + '"]');
          if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
        }
        const held = card && card.querySelector('details.held-decs');
        if (held) held.open = true;
      })()`);
    } else if (spec.state === 'dirty') {
      await page.eval(`window.__readability.settle()`);
      preFocusTitle = await page.eval(`window.__readability.measureFirstTitle(${JSON.stringify(spec)})`);
      dirtyFocusPreserved = await page.eval(`(() => {
        const main = document.getElementById('main');
        const mainScrollTopBeforeFocus = main ? main.scrollTop : 0;
        const sid = 'fx-sess-beta-active';
        const expectedValue = '더티 상태 입력 보존 테스트';
        const card = document.querySelector('[data-card="' + sid + '"]');
        const input = card && card.querySelector('[data-field="layout_note"]');
        if (input) {
          input.focus();
          input.value = expectedValue;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const afterInput = document.querySelector('[data-card="' + sid + '"] [data-field="layout_note"]');
        const active = document.activeElement;
        const valuePreserved = !!(afterInput && afterInput.value === expectedValue);
        const focusPreserved = !!(afterInput && active === afterInput);
        return {
          ok: valuePreserved && focusPreserved,
          valuePreserved,
          focusPreserved,
          expectedValue,
          actualValue: afterInput ? afterInput.value : null,
          focusedSelector: active ? (active.getAttribute('data-field') ? '[data-field="' + active.getAttribute('data-field') + '"]' : active.tagName.toLowerCase()) : null,
          mainScrollTopBeforeFocus,
          mainScrollTopAfterFocus: main ? main.scrollTop : 0,
        };
      })()`);
    }
  } else if (spec.screen === 'convo' || spec.screen === 'plan' || spec.screen === 'workers' || spec.screen === 'convo-dec' || spec.screen === 'blocks') {
    const sid = spec.sessionId || 'fx-sess-beta-active';
    const sub = spec.sub || 'ov';
    await page.eval(`(BriefPage.open(${JSON.stringify(sid)}, ${JSON.stringify(sub)}), true)`);
    await page.eval(`window.__readability.settle()`);
    if (spec.state === 'expanded') {
      if (sub === 'ov') {
        await page.eval(`(() => {
          for (const d of document.querySelectorAll('#main details.dt, #main details.cv-notes, #main details.att')) d.open = true;
        })()`);
      } else if (sub === 'plan') {
        await page.eval(`(() => {
          for (const b of document.querySelectorAll('#main .plan-toggle[aria-expanded="false"]')) b.click();
        })()`);
      } else if (sub === 'wk') {
        await page.eval(`(() => {
          for (const b of document.querySelectorAll('#main .w-todo-btn[aria-expanded="false"]')) b.click();
        })()`);
      }
    } else if (spec.state === 'dirty') {
      await page.eval(`window.__readability.settle()`);
      preFocusTitle = await page.eval(`window.__readability.measureFirstTitle(${JSON.stringify(spec)})`);
      dirtyFocusPreserved = await page.eval(`(() => {
        const main = document.getElementById('main');
        const mainScrollTopBeforeFocus = main ? main.scrollTop : 0;
        const expectedValue = '대화 탭 더티 입력값';
        const input = document.querySelector('#main [data-field="layout_note"]');
        if (input) {
          input.focus();
          input.value = expectedValue;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const afterInput = document.querySelector('#main [data-field="layout_note"]');
        const active = document.activeElement;
        const valuePreserved = !!(afterInput && afterInput.value === expectedValue);
        const focusPreserved = !!(afterInput && active === afterInput);
        return {
          ok: valuePreserved && focusPreserved,
          valuePreserved,
          focusPreserved,
          expectedValue,
          actualValue: afterInput ? afterInput.value : null,
          focusedSelector: active ? (active.getAttribute('data-field') ? '[data-field="' + active.getAttribute('data-field') + '"]' : active.tagName.toLowerCase()) : null,
          mainScrollTopBeforeFocus,
          mainScrollTopAfterFocus: main ? main.scrollTop : 0,
        };
      })()`);
    }
  } else if (spec.screen.startsWith('profiles')) {
    await page.eval(`document.querySelector('#rail [data-key="profiles"]').click()`);
    await waitFor(page, `document.querySelector('[data-pf-root]') && document.querySelector('[data-pf-root]').getAttribute('data-pf-state') === 'view'`, 'profiles view');
    // At narrow viewports (<900px), switching views via rail opens the sidebar overlay (peek=true),
    // which makes .sh-wrap inert. A real user dismisses the sidebar overlay to view and interact
    // with profile controls in #main. Dismiss the overlay before exercising or capturing.
    await page.eval(`(() => {
      const sh = document.querySelector('.sh-shell');
      if (sh && sh.getAttribute('data-peek') === 'true') {
        const btn = document.querySelector('.sh-side [data-sh="toggleSide"]') || document.querySelector('.sh-topen');
        if (btn) btn.click();
      }
    })()`);
    await page.eval(`window.__readability.settle()`);
    if (spec.tab) {
      await page.eval(`(() => {
        const t = document.querySelector('[role="tab"][data-tab="${spec.tab}"]');
        if (t && t.getAttribute('aria-selected') !== 'true') t.click();
      })()`);
    }
    if (spec.state === 'expanded') {
      const rowKey = spec.tab === 'primary' ? 'agent:sisyphus' : spec.tab === 'agents' ? 'route:agents/explore' : 'route:categories/visual-engineering';
      await page.eval(`(() => {
        const b = document.querySelector('.pf-row-sum[data-row="${rowKey}"]');
        if (b && b.getAttribute('aria-expanded') === 'false') b.click();
      })()`);
    } else if (spec.state === 'dirty') {
      await page.eval(`window.__readability.settle()`);
      preFocusTitle = await page.eval(`window.__readability.measureFirstTitle(${JSON.stringify(spec)})`);
      dirtyFocusPreserved = await page.eval(`(() => {
        const main = document.getElementById('main');
        const mainScrollTopBeforeFocus = main ? main.scrollTop : 0;
        const b = document.querySelector('.pf-row-sum[data-row="memory:kibitzer"]');
        if (b && b.getAttribute('aria-expanded') === 'false') b.click();
        let mode = document.querySelector('[data-flow="memory:kibitzer:mode"]');
        if (mode) {
          mode.focus();
          mode.value = 'custom';
          mode.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const svc = document.querySelector('[data-flow="memory:kibitzer:service"]');
        if (svc) {
          const opt = [...svc.querySelectorAll('option')].find((o) => o.value && o.value !== svc.value) || svc.querySelectorAll('option')[1];
          if (opt) { svc.value = opt.value; svc.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        const mdl = document.querySelector('[data-flow="memory:kibitzer:model"]');
        if (mdl) {
          const opt = [...mdl.querySelectorAll('option')].find((o) => o.value && o.value !== mdl.value) || mdl.querySelectorAll('option')[1];
          if (opt) { mdl.value = opt.value; mdl.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        const eff = document.querySelector('[data-flow="memory:kibitzer:effort"]');
        let pickedEffort = null;
        if (eff) {
          eff.focus();
          const opt = [...eff.querySelectorAll('option')].find((o) => o.value) || eff.querySelectorAll('option')[0];
          if (opt) {
            pickedEffort = opt.value;
            eff.value = opt.value;
            eff.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        const afterMode = document.querySelector('[data-flow="memory:kibitzer:mode"]');
        const afterEff = document.querySelector('[data-flow="memory:kibitzer:effort"]');
        const pendingRows = document.querySelectorAll('.pf-tray [data-pf-pending], .pf-tray .pf-pending-r, .pf-tray .pf-sec-b');
        const active = document.activeElement;
        const valuePreserved = !!(afterMode && afterMode.value === 'custom' && pendingRows.length >= 1 && (!pickedEffort || (afterEff && afterEff.value === pickedEffort)));
        const focusPreserved = !!(active && (active === afterEff || active === afterMode || active.closest('[data-pf-root]')));
        return {
          ok: valuePreserved && focusPreserved,
          valuePreserved,
          focusPreserved,
          expectedValue: 'custom',
          actualValue: afterMode ? afterMode.value : null,
          focusedSelector: active ? (active.getAttribute('data-flow') ? '[data-flow="' + active.getAttribute('data-flow') + '"]' : active.tagName.toLowerCase()) : null,
          mainScrollTopBeforeFocus,
          mainScrollTopAfterFocus: main ? main.scrollTop : 0,
        };
      })()`);
    } else if (spec.state === 'offline') {
      await page.eval(`(() => {
        const ps = BriefPage.state.ui.profilesState;
        if (ps && ps.view) {
          ps.view = Object.assign({}, ps.view, { readOnly: true, readOnlyReason: 'INVENTORY_STALE' });
          ps.error = '프로필 저장소 연결 오프라인 (읽기 전용)';
          BriefPage.render();
        }
      })()`);
    } else if (spec.state === 'dialog-open') {
      await page.eval(`(() => {
        const g = document.querySelector('[data-flow="guide"]');
        if (g) g.click();
      })()`);
      await waitFor(page, `document.querySelector('#pf-guide-dlg') && document.querySelector('#pf-guide-dlg').open`, 'guide dialog open');
    }
  } else if (spec.screen === 'memento') {
    await page.eval(`document.querySelector('#rail [data-key="memento"]').click()`);
    await waitFor(page, `document.querySelectorAll('#memento-cards tr.mcards-row').length >= 10 && [...document.querySelectorAll('#memento-cards .mcards-card-title')].some((el) => el.textContent.trim() === '예시 아이디어 12')`, 'memento fixture cards');
  } else if (spec.screen === 'office') {
    await page.eval(`document.querySelector('#rail [data-key="office"]').click()`);
    await waitFor(page, `document.querySelector('#office svg, #office .of-stage')`, 'office view');
  }

  await page.eval(`window.__readability.settle()`);
  const content = await page.eval(`window.__readability.verifyScreenContent(${JSON.stringify(spec)})`);
  if (!content || !content.ok) {
    throw new Error(`Empty or loading capture on screen "${spec.id}" (theme=${spec._theme || 'unknown'}): expected marker [${content?.marker}], got count=${content?.count} sample=${JSON.stringify(content?.sample)}`);
  }
  const scrollers = await page.eval(`window.__readability.scanScrollers(${JSON.stringify(spec.id)})`);
  const spaceAndTargets = await page.eval(`window.__readability.measureSpaceAndHitTargets()`);
  const postFocusTitle = await page.eval(`window.__readability.measureFirstTitle(${JSON.stringify(spec)})`);
  const title = preFocusTitle
    ? {
        ...preFocusTitle,
        measuredBeforeFocusScroll: true,
        postFocusTitle,
        dirtyFocusPreserved,
      }
    : postFocusTitle;
  const nestedCards = await page.eval(`window.__readability.scanNestedCards(${JSON.stringify(spec.scope)})`);
  let pngBuffer = null;
  if (spec._capturePng) {
    const shot = await page.client.send('Page.captureScreenshot', { format: 'png' });
    pngBuffer = Buffer.from(shot.data, 'base64');
  }

  if (spec.state === 'dialog-open') {
    await page.eval(`(() => {
      const c = document.querySelector('[data-pf="guide-close"]');
      if (c) c.click();
    })()`);
  }

  return {
    id: spec.id,
    screen: spec.screen,
    content,
    sub: spec.sub || null,
    tab: spec.tab || null,
    state: spec.state,
    scope: spec.scope,
    judgment: spec.judgment || (spec.scope === 'OUT-SIBLING' ? 'shell-input-regression' : 'n8-title-gate'),
    titleGate: spec.scope !== 'OUT-SIBLING' && spec.titleGate !== false,
    consumerId: spec.consumerId,
    documentDoesNotScrollVertically: spaceAndTargets.documentDoesNotScrollVertically,
    mainOwnsVertical: spaceAndTargets.mainOwnsVertical,
    docScrollCount: spaceAndTargets.docScrollCount,
    sidewaysOverflow: spaceAndTargets.sidewaysOverflow,
    hitTargets: spaceAndTargets.hitTargets,
    scrollers,
    title,
    ...(dirtyFocusPreserved ? { dirtyFocusPreserved } : {}),
    nestedCards,
    ...(pngBuffer ? { _pngBuffer: pngBuffer } : {}),
  };
}

async function runFlowsForSize(page, size, tempRoot, vm, memento, pluginPath, flows, portOffset, pageFs = fs) {
  const results = {};
  for (let i = 0; i < flows.length; i++) {
    const f = flows[i];
    const srv = await startFixtureServer({
      root: path.join(tempRoot, `${size.name}-flow-${f.task}-${i}`),
      vm,
      memento,
      pluginPath,
      portBase: PORT_BASE + portOffset + i * 2,
      pageFs,
    });
    try {
      await page.goto(srv.url);
      await page.eval(READABILITY_LIB);
      await page.eval(FLOW_PROBE_LIB);
      await waitFor(page, `document.querySelector('#rail [data-key="profiles"]')`, 'rail profiles');
      await page.eval(`document.querySelector('#rail [data-key="profiles"]').click()`);
      await waitFor(page, `document.querySelector('[data-pf-root]') && document.querySelector('[data-pf-root]').getAttribute('data-pf-state') === 'view' && document.querySelector('[data-flow="apply:detail"]')`, 'profiles view');
      await page.eval(`(() => {
        const sh = document.querySelector('.sh-shell');
        if (sh && sh.getAttribute('data-peek') === 'true') {
          const btn = document.querySelector('.sh-side [data-sh="toggleSide"]') || document.querySelector('.sh-topen');
          if (btn) btn.click();
        }
      })()`);
      await page.eval(`window.__readability.settle()`);

      const steps = [];
      for (const ctl of f.steps) {
        const reach = await page.eval(`window.__flowProbe.reach(${JSON.stringify(ctl)})`);
        await page.eval(`window.__readability.settle()`);
        const act = await page.eval(`window.__flowProbe.act(${JSON.stringify(ctl)})`);
        let applyFailed = false;
        let applyError = '';
        if (ctl.startsWith('card:')) {
          await waitFor(page, `document.querySelector('[data-flow="${ctl}"]').getAttribute('aria-pressed') === 'true'`, ctl + ' selected');
        } else if (ctl.startsWith('apply:')) {
          await waitFor(page, `document.querySelector('[data-pf-result="apply"]') || document.querySelector('.pf-tray .pf-err')`, ctl + ' apply result');
          applyFailed = await page.eval(`!!document.querySelector('.pf-tray .pf-err')`);
          if (applyFailed) {
            applyError = await page.eval(`(document.querySelector('.pf-tray .pf-err')?.textContent || '').trim()`);
          }
          await waitFor(page, `document.querySelector('[data-pf-root]').getAttribute('data-pf-busy') === 'false'`, 'profiles idle after apply');
        }
        await page.eval(`window.__readability.settle()`);
        steps.push({
          control: ctl,
          scrolls: reach.scrolls,
          budget: f.budgetPerStep,
          pass: !reach.missing && reach.scrolls <= f.budgetPerStep && !!(reach.hit && reach.hit.onTop) && !applyFailed,
          ...(applyFailed ? { applyFailed: true, applyError } : {}),
          moved: reach.moved,
          view: reach.view,
          hit: reach.hit,
          act,
        });
      }
      const totalScrollCost = steps.reduce((s, st) => s + (st.scrolls || 0), 0);
      const violations = steps.filter((st) => !st.pass);
      results[f.task] = {
        id: f.id,
        task: f.task,
        budgetPerStep: f.budgetPerStep,
        totalScrollCost,
        pass: violations.length === 0,
        steps,
        violations,
      };
    } finally {
      await srv.server.close();
    }
  }
  return results;
}

async function main() {
  const startedAt = new Date().toISOString();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const vm = JSON.parse(fs.readFileSync(VM_FILE, 'utf8'));
  const pfFixture = JSON.parse(fs.readFileSync(PF_STATE_FILE, 'utf8'));
  const memento = JSON.parse(fs.readFileSync(MEMENTO_FILE, 'utf8'));
  const inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
  const pluginPath = resolvePinnedPlugin(inventory);
  const pageFs = createPhasePageFs(PHASE);
  const hashes = computeSourceHashes(pageFs);

  const tempRoot = path.join(os.tmpdir(), 'omo-w2-readability-' + Date.now().toString(36));
  assertFixtureRoot(tempRoot);
  fs.mkdirSync(tempRoot, { recursive: true });

  // Prepare offline file:// HTML for overview-offline
  const offlineDir = path.join(tempRoot, 'offline-page');
  fs.mkdirSync(path.join(offlineDir, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(ASSET_DIR)) {
    fs.copyFileSync(path.join(ASSET_DIR, f), path.join(offlineDir, 'assets', f));
  }
  const offlineHtmlPath = path.join(offlineDir, 'index.html');
  fs.writeFileSync(offlineHtmlPath, pageHtml(vm, vm.gen || 9, { mode: 'file', fs: pageFs }));
  fs.writeFileSync(
    path.join(offlineDir, 'data.js'),
    `/* seq:${vm.seq} */\nwindow.__briefData && window.__briefData(${JSON.stringify(vm).replace(/</g, '\\u003c')});\n`
  );

  const invokedCommand = `node scripts/qa-readability.mjs ${process.argv.slice(2).join(' ')}`.trim();
  const provenance = {
    schema: 'w2-readability-provenance/1',
    plan: 'herdr-dag-active-tracking',
    track: 'W2',
    task: 9,
    phase: PHASE,
    command: invokedCommand,
    exitCode: 0,
    processExitCode: 0,
    pid: process.pid,
    startedAt,
    language: manifest.language || 'ko',
    themes: manifest.themes || ['light', 'dark'],
    fixtureIds: {
      manifest: 'test/fixtures/readability/manifest.json',
      viewModel: 'test/fixtures/readability/view-model.json',
      profilesState: 'test/fixtures/readability/profiles-state.json',
      mementoState: 'test/fixtures/readability/memento-state.json',
    },
    sourceHash: hashes.sourceHash,
    head: hashes.head,
    qaScriptSha256: hashes.qaScriptSha256,
    sourceFiles: hashes.files,
  };

  let page;
  let chromePids = [];
  let csp;
  const sizeReports = {};
  const allFailures = [];
  const captureFiles = [];

  try {
    page = await launch({ width: SIZES[0].width, height: SIZES[0].height });
    csp = await watchCsp(page);
    await page.addInitScript(PAGE_CLOCK);
    chromePids = [...new Set([page.pid, ...listProfilePids(page.profileDir)])];

    for (let si = 0; si < SIZES.length; si++) {
      const size = SIZES[si];
      await page.client.send('Emulation.setDeviceMetricsOverride', {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const srv = await startFixtureServer({
        root: path.join(tempRoot, `${size.name}-screens`),
        vm,
        memento,
        pluginPath,
        portBase: PORT_BASE,
        pageFs,
      });

      const screens = [];
      try {
        for (const spec of manifest.screens) {
          for (const theme of ['light', 'dark']) {
            await page.client.send('Emulation.setEmulatedMedia', {
              features: [{ name: 'prefers-color-scheme', value: theme }],
            });
            const measured = await driveScreen(
              page,
              srv.url,
              offlineHtmlPath,
              { ...spec, _theme: theme, _capturePng: PHASE === 'candidate' },
              pfFixture
            );
            const pngBuffer = measured._pngBuffer || null;
            delete measured._pngBuffer;
            const record = {
              ...measured,
              viewport: size.name,
              theme,
              language: 'ko',
              fixtureId: spec.screen.startsWith('profiles')
                ? 'readability/profiles-state.json'
                : spec.screen === 'memento'
                  ? 'readability/memento-state.json'
                  : 'readability/view-model.json',
            };
            if (pngBuffer) {
              const pngFile = `${spec.id}-${size.name}-${theme}.png`;
              const jsonFile = `${spec.id}-${size.name}-${theme}.json`;
              const pngSha256 = sha256(pngBuffer);
              record.capture = {
                png: `captures/${pngFile}`,
                geometryJson: `captures/${jsonFile}`,
                pngSha256,
                pngBytes: pngBuffer.length,
              };
              captureFiles.push({
                screenId: spec.id,
                viewport: size.name,
                theme,
                pngFile,
                jsonFile,
                pngBuffer,
                pngSha256,
                pngBytes: pngBuffer.length,
                geometry: {
                  schema: 'w2-screen-capture-geometry/1',
                  sourceHash: hashes.sourceHash,
                  head: hashes.head,
                  phase: PHASE,
                  ...record,
                },
              });
            }
            screens.push(record);
          }
        }
      } finally {
        await srv.server.close();
      }

      // Reset to light theme for flow measurements
      await page.client.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      });
      const flows = await runFlowsForSize(page, size, tempRoot, vm, memento, pluginPath, manifest.flows, 2, pageFs);

      // Collect failures for this viewport
      const viewportFailures = [];
      for (const sc of screens) {
        if (sc.theme !== 'light') continue; // deduplicate structural DOM failures across themes while keeping both in before-<size>.json
        if (sc.scrollers.forbiddenVerticalMatches.length > 0) {
          viewportFailures.push({
            kind: 'forbidden-vertical-scroller',
            viewport: size.name,
            screenId: sc.id,
            screen: sc.screen,
            state: sc.state,
            theme: sc.theme,
            scrollers: sc.scrollers.forbiddenVerticalMatches.map((m) => ({
              selector: m.selector,
              matchedForbiddenSelector: m.matchedForbiddenSelector,
              region: m.region,
              direction: m.direction,
              openState: m.openState,
              overflowY: m.overflowY,
              clientHeight: m.clientHeight,
              scrollHeight: m.scrollHeight,
              activelyScrollsY: m.activelyScrollsY,
            })),
          });
        }
        if (sc.scrollers.nestedVerticalInMain.length > 0) {
          viewportFailures.push({
            kind: 'nested-vertical-scroller-in-main',
            viewport: size.name,
            screenId: sc.id,
            screen: sc.screen,
            state: sc.state,
            theme: sc.theme,
            scrollers: sc.scrollers.nestedVerticalInMain.map((m) => ({
              selector: m.selector,
              region: m.region,
              direction: m.direction,
              openState: m.openState,
              overflowY: m.overflowY,
              clientHeight: m.clientHeight,
              scrollHeight: m.scrollHeight,
            })),
          });
        }
        if (sc.state === 'dialog-open' && sc.scrollers.dialogLocksBackground === false) {
          viewportFailures.push({
            kind: 'dialog-background-scroll-unlocked',
            viewport: size.name,
            screenId: sc.id,
            screen: sc.screen,
            state: sc.state,
            theme: sc.theme,
            mainOverflowY: sc.scrollers.mainOwner?.overflowY,
          });
        }
        if (!sc.title.ok) {
          viewportFailures.push({
            kind: 'active-title-offscreen-or-unopened',
            viewport: size.name,
            screenId: sc.id,
            screen: sc.screen,
            state: sc.state,
            theme: sc.theme,
            title: sc.title,
          });
        }
        if (sc.dirtyFocusPreserved && !sc.dirtyFocusPreserved.ok) {
          viewportFailures.push({
            kind: 'dirty-focus-not-preserved',
            viewport: size.name,
            screenId: sc.id,
            screen: sc.screen,
            state: sc.state,
            theme: sc.theme,
            dirtyFocusPreserved: sc.dirtyFocusPreserved,
          });
        }
        if (sc.scope === 'IN' && sc.nestedCards.count > 0) {
          viewportFailures.push({
            kind: 'nested-visual-card-in-card',
            viewport: size.name,
            screenId: sc.id,
            screen: sc.screen,
            state: sc.state,
            theme: sc.theme,
            count: sc.nestedCards.count,
            instances: sc.nestedCards.instances,
          });
        }
      }

      for (const [task, fl] of Object.entries(flows)) {
        if (!fl.pass) {
          viewportFailures.push({
            kind: 'f5-scroll-budget-exceeded',
            viewport: size.name,
            task,
            flowId: fl.id,
            violations: fl.violations.map((v) => ({
              control: v.control,
              expected: '<= ' + v.budget,
              actual: v.scrolls,
              moved: v.moved,
              hit: v.hit,
            })),
          });
        }
      }

      allFailures.push(...viewportFailures);

      sizeReports[size.name] = {
        schema: 'w2-readability-capture/1',
        ...provenance,
        viewport: size.name,
        width: size.width,
        height: size.height,
        summary: {
          screenCaptureCount: screens.length,
          nonEmptyScreenCaptures: screens.filter((s) => s.content && s.content.ok).length,
          uniqueScreens: manifest.screens.length,
          nonEmptyUniqueScreens: new Set(screens.filter((s) => s.content && s.content.ok).map((s) => s.id)).size,
          flowsCount: Object.keys(flows).length,
          failureCount: viewportFailures.length,
          forbiddenVerticalScrollerScreens: viewportFailures.filter((f) => f.kind === 'forbidden-vertical-scroller').length,
          activeTitleFailures: viewportFailures.filter((f) => f.kind === 'active-title-offscreen-or-unopened').length,
          dirtyFocusFailures: viewportFailures.filter((f) => f.kind === 'dirty-focus-not-preserved').length,
          nestedVisualCardScreens: viewportFailures.filter((f) => f.kind === 'nested-visual-card-in-card').length,
          f5Violations: viewportFailures.filter((f) => f.kind === 'f5-scroll-budget-exceeded').length,
        },
        screens,
        flows,
        failures: viewportFailures,
      };
    }
  } finally {
    if (page) {
      await page.close();
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }

  const actualExitCode = PHASE === 'candidate' && allFailures.length > 0 ? 1 : 0;
  provenance.exitCode = actualExitCode;
  provenance.processExitCode = actualExitCode;
  for (const rep of Object.values(sizeReports)) {
    rep.exitCode = actualExitCode;
    rep.processExitCode = actualExitCode;
  }

  const alivePids = chromePids.filter((pid) => isPidAlive(pid));
  const cleanupReceipt = {
    chromePids,
    aliveAfterClose: alivePids,
    tempRootRemoved: !fs.existsSync(tempRoot),
    cspViolations: csp ? csp.violations.length : 0,
  };

  const inventoryOut = {
    schema: 'w2-readability-inventory/1',
    ...provenance,
    consumers: manifest.consumers,
    scrollAllowList: manifest.scrollAllowList,
    forbiddenVerticalScrollers: manifest.forbiddenVerticalScrollers,
    topPinContract: manifest.topPinContract,
    scrollBudgetContract: manifest.scrollBudgetContract,
    screens: manifest.screens,
    flows: manifest.flows,
    cleanup: cleanupReceipt,
  };

  const f2fixBaselinePath = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/profile-agent-switcher-v3/final/f2fix/flow-smoke/flow-diff-1180x700.json';
  const f5Comparison = {
    referenceFile: f2fixBaselinePath,
    knownBaseline: {
      task: 'role',
      control: 'card:experimental-custom',
      expected: '<= 1',
      actual: 2,
      moved: [{ container: '#pf-sec-profiles', px: 601, visible: 412 }],
    },
    currentSource1180x700: sizeReports['1180x700']?.flows?.role?.steps?.find((s) => s.control === 'card:experimental-custom') || null,
    currentSource1440x900: sizeReports['1440x900']?.flows?.role?.steps?.find((s) => s.control === 'card:experimental-custom') || null,
    reproducedOnCurrentSource:
      (sizeReports['1180x700']?.flows?.role?.steps?.find((s) => s.control === 'card:experimental-custom')?.scrolls || 0) === 2,
  };

  const failuresOut = {
    schema: 'w2-readability-failures/1',
    ...provenance,
    f5Comparison,
    totalFailures: allFailures.length,
    byKind: {
      forbiddenVerticalScroller: allFailures.filter((f) => f.kind === 'forbidden-vertical-scroller').length,
      nestedVerticalScrollerInMain: allFailures.filter((f) => f.kind === 'nested-vertical-scroller-in-main').length,
      dialogBackgroundScrollUnlocked: allFailures.filter((f) => f.kind === 'dialog-background-scroll-unlocked').length,
      activeTitleOffscreenOrUnopened: allFailures.filter((f) => f.kind === 'active-title-offscreen-or-unopened').length,
      dirtyFocusNotPreserved: allFailures.filter((f) => f.kind === 'dirty-focus-not-preserved').length,
      nestedVisualCardInCard: allFailures.filter((f) => f.kind === 'nested-visual-card-in-card').length,
      f5ScrollBudgetExceeded: allFailures.filter((f) => f.kind === 'f5-scroll-budget-exceeded').length,
    },
    failures: allFailures,
    cleanup: cleanupReceipt,
  };

  const prefix = PHASE === 'baseline' ? 'before' : 'candidate';
  const writeTargets = [OUT];
  if (['before', 'baseline', 'candidate'].includes(path.basename(OUT).toLowerCase())) {
    writeTargets.push(path.dirname(OUT));
  }

  const recomputedCaptures = captureFiles.map((c) => ({
    screenId: c.screenId,
    viewport: c.viewport,
    theme: c.theme,
    png: `captures/${c.pngFile}`,
    geometryJson: `captures/${c.jsonFile}`,
    pngSha256: sha256(c.pngBuffer),
    pngBytes: c.pngBuffer.length,
  }));

  const buildOut = {
    schema: 'w2-candidate-build/1',
    plan: 'herdr-dag-active-tracking',
    track: 'W2',
    task: 7,
    phase: PHASE,
    generatedAt: new Date().toISOString(),
    head: hashes.head,
    sourceHash: hashes.sourceHash,
    qaScriptSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    sourceFiles: hashes.files,
    viewports: SIZES.map((s) => s.name),
    themes: ['light', 'dark'],
    manifestScreenCount: manifest.screens.length,
    totalCaptures: recomputedCaptures.length,
    captures: recomputedCaptures,
  };

  for (const dir of writeTargets) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'inventory.json'), JSON.stringify(inventoryOut, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'failures.json'), JSON.stringify(failuresOut, null, 2) + '\n');
    for (const [sizeName, rep] of Object.entries(sizeReports)) {
      fs.writeFileSync(path.join(dir, `${prefix}-${sizeName}.json`), JSON.stringify(rep, null, 2) + '\n');
    }
    if (PHASE === 'candidate' && captureFiles.length > 0) {
      fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify(buildOut, null, 2) + '\n');
      fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(buildOut, null, 2) + '\n');
      const capDir = path.join(dir, 'captures');
      fs.mkdirSync(capDir, { recursive: true });
      for (const c of captureFiles) {
        fs.writeFileSync(path.join(capDir, c.pngFile), c.pngBuffer);
        fs.writeFileSync(path.join(capDir, c.jsonFile), JSON.stringify(c.geometry, null, 2) + '\n');
        if (dir !== capDir) {
          fs.writeFileSync(path.join(dir, c.pngFile), c.pngBuffer);
          fs.writeFileSync(path.join(dir, c.jsonFile), JSON.stringify(c.geometry, null, 2) + '\n');
        }
      }
      // Also write per-screen canonical <screenId>.png (1180x700 light) and <screenId>.json (all viewports/themes for that screen)
      for (const spec of manifest.screens) {
        const perScreen = captureFiles.filter((c) => c.screenId === spec.id);
        const primary = perScreen.find((c) => c.viewport === SIZES[0].name && c.theme === 'light') || perScreen[0];
        if (primary) {
          const bundleJson = JSON.stringify(
            {
              schema: 'w2-screen-capture-bundle/1',
              screenId: spec.id,
              sourceHash: hashes.sourceHash,
              head: hashes.head,
              phase: PHASE,
              defaultPng: `captures/${spec.id}.png`,
              variants: perScreen.map((v) => ({
                viewport: v.viewport,
                theme: v.theme,
                png: `captures/${v.pngFile}`,
                geometryJson: `captures/${v.jsonFile}`,
                pngSha256: v.pngSha256,
                pngBytes: v.pngBytes,
                geometry: v.geometry,
              })),
            },
            null,
            2
          ) + '\n';
          fs.writeFileSync(path.join(capDir, `${spec.id}.png`), primary.pngBuffer);
          fs.writeFileSync(path.join(capDir, `${spec.id}.json`), bundleJson);
          if (dir !== capDir) {
            fs.writeFileSync(path.join(dir, `${spec.id}.png`), primary.pngBuffer);
            fs.writeFileSync(path.join(dir, `${spec.id}.json`), bundleJson);
          }
        }
      }
      fs.writeFileSync(path.join(capDir, 'build.json'), JSON.stringify(buildOut, null, 2) + '\n');
      fs.writeFileSync(path.join(capDir, 'index.json'), JSON.stringify(buildOut, null, 2) + '\n');
    }
  }

  console.log(JSON.stringify({
    ok: actualExitCode === 0,
    phase: PHASE,
    exitCode: actualExitCode,
    processExitCode: actualExitCode,
    out: OUT,
    mirroredTo: writeTargets,
    sizes: Object.fromEntries(Object.entries(sizeReports).map(([k, v]) => [k, v.summary])),
    f5Reproduced1180x700: f5Comparison.reproducedOnCurrentSource,
    totalFailures: allFailures.length,
    byKind: failuresOut.byKind,
    cleanup: cleanupReceipt,
  }, null, 2));

  if (actualExitCode !== 0) {
    process.exit(actualExitCode);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
