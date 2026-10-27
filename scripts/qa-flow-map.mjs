// Board flow-map extractor (plan switcher-flow-restore, todo 8).
//
// Serves this tree's board over fixture homes under %TEMP%/omo-switcher-tests/ (seeded like scripts/qa-profiles.mjs
// from the redacted goldens and the registry fixture) on ports outside the live board's 47317-47326, opens ONE
// headless Chrome (scripts/cdp.mjs) and, per size, performs the three WinForms tasks by their data-flow controls:
//   <out>/flow-map.board-<w>x<h>.json   flow-map/1, source 'board'
//   <out>/flow-diff-<w>x<h>.json        F1..F7 of test/fixtures/profiles/flow-map.rules.json against the reference
//   <out>/csp.json, <out>/ax.txt        CSP violations (listener armed before the first navigation), unnamed AX controls
// Each task starts from freshly seeded homes and a fresh page; apply really writes, but only the fixture homes.
// usage: node scripts/qa-flow-map.mjs --out <dir> [--sizes 1180x700,1600x900] [--reference <flow-map.json>] [--keep]
// Exit 1 when a diff is not empty, a step is missing, a CSP violation happened or an unnamed control appeared.
// Every wait is an event or a bounded deadline; no fixed sleep and no polling loop.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, listProfilePids, isPidAlive, watchCsp, axSnapshot, unnamedInteractive } from './cdp.mjs';
import { createBoardServer } from '../src/server.mjs';
import { pageHtml } from '../src/render.mjs';
import { formatJsonText, openProfilesStore } from '../src/profiles/store.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN = path.join(ROOT, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files');
const REGISTRY = path.join(ROOT, 'test/fixtures/profiles/registry');
const RULES = path.join(ROOT, 'test/fixtures/profiles/flow-map.rules.json');
const AX_ALLOWLIST = path.join(ROOT, 'scripts/qa-ax-allowlist.json');
const INVENTORY = path.join(ROOT, 'src/profiles/inventory-5.1.44.json');
const PLUGIN = 'C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.44-r1/package/plugin/extensions/omo.js';
const VM_FILE = path.join(ROOT, 'test/fixtures/view-model-board.json');
const LIVE_HOMES = ['C:/Users/USER/.omo', 'C:/Users/USER/.omo-stable-500/home/.omo', 'C:/Users/USER/.omo-original/home/.omo', 'C:/Users/USER/.somo/home/.omo'];
const LIVE_BOARD = [47317, 47326];
const PS_STYLE = { bom: true, eol: '\r\n', indent: '    ', keySep: ':  ', trailingNewline: true };
const FIXED_NOW = Date.parse('2026-10-20T12:00:00Z');
const TOKEN = 'piomo-t8-flow-map-token';
const REGIONS = ['status', 'guide', 'cards', 'detail', 'roles', 'lane', 'main', 'summarizer', 'apply', 'message'];
const TASKS = {
  role: ['card:experimental-custom', 'role:agents/explore:service', 'role:agents/explore:model', 'role:agents/explore:effort', 'apply:detail'],
  profile: ['apply:card:gpt-deepseek'],
  memory: ['memory:kibitzer:mode', 'memory:kibitzer:service', 'memory:kibitzer:model', 'memory:kibitzer:effort', 'apply:detail'],
};
// Must have 4 copy seen in the screen's text right after load, after a staged edit and after a memory apply.
const STATIC_COPY = ['현재 전역 적용', '전역 적용 중', '권장 배치 가이드', '적용 중', '적용', '메인: ', '서비스: ',
  '모델 라우팅 · 전담 에이전트 / 작업 카테고리', '공통 설정 · Kibitzer 회상', '공통 설정 · Reflection 성찰', '전담 에이전트 · Agents',
  '탐색 · 자료 조사', '계획 · 조언', '검토 · QA', '작업 카테고리 · Categories', '빠른 작업 · 일반 작업', '심층 추론', '전문 작업',
  '메인 모델 설정', '요약 담당 모델', '이 프로필 적용하기', '1. 구독 서비스', '2. AI 모델', '3. 추론 강도',
  '공통 / 전체 · Kibitzer 회상', '공통 / 전체 · Reflection 성찰', 'quick 공유 (기본)', '직접 선택', '현재: ', '보류: ',
  '1. 제공사', '원본 기본 컴팩션'];
// Shown only in states the three tasks do not reach (no extra roles in the shared fixture, no refused memory apply);
// the node test 'layout: every Must have 4 string is on the board word for word' renders them.
const CONDITIONAL_COPY = ['추가 설정', '실패 · 보류 유지: '];

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const OUT = arg('--out') ? path.resolve(arg('--out')) : '';
const REFERENCE = path.resolve(arg('--reference', path.join(ROOT, 'test/fixtures/profiles/flow-map.winforms.json')));
const SIZES = arg('--sizes', '1180x700,1600x900').split(',').map((s) => {
  const m = /^(\d+)x(\d+)$/.exec(s.trim());
  if (!m) throw new Error('bad --sizes entry ' + s);
  return { width: Number(m[1]), height: Number(m[2]), name: m[1] + 'x' + m[2] };
});
const KEEP = argv.includes('--keep');
const PORT_BASE = Number(process.env.OMO_BRIEFING_PORT_BASE || 47540);
if (!OUT) {
  console.error('usage: node scripts/qa-flow-map.mjs --out <dir> [--sizes 1180x700,1600x900] [--reference <flow-map.json>] [--keep]');
  process.exit(2);
}
if (!Number.isInteger(PORT_BASE) || PORT_BASE < 1024 || PORT_BASE + 4 > 65535 || (PORT_BASE <= LIVE_BOARD[1] && PORT_BASE + 4 >= LIVE_BOARD[0])) {
  console.error(`OMO_BRIEFING_PORT_BASE=${PORT_BASE}: needs 5 ports outside the live board's ${LIVE_BOARD.join('-')}`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const slash = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
// The Assert-FixtureRootIsSafe rule (capture.ps1:70): a root that is, contains or sits inside a live home is refused.
function assertFixtureRoot(root) {
  const r = slash(root);
  for (const home of LIVE_HOMES.map(slash)) {
    if (r === home || r.startsWith(home + '/') || home.startsWith(r + '/')) throw new Error(`fixture root ${root} touches live home ${home}`);
  }
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

// Page-side helpers, installed once per document. Boxes of step controls are content coordinates inside their nearest
// scroll container (the WinForms map records them the same way); region boxes are viewport boxes at scroll 0.
const FLOW_LIB = `(() => {
  const REGIONS = ${JSON.stringify(REGIONS)};
  const box = (r, ox, oy) => ({ x: Math.round(r.left + ox), y: Math.round(r.top + oy), w: Math.round(r.width), h: Math.round(r.height) });
  const q = (id) => document.querySelector('[data-flow="' + id + '"]');
  const scrollers = (el) => {
    const out = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) out.push(n);
    }
    const se = document.scrollingElement;
    if (se && se.scrollHeight > se.clientHeight + 1 && !out.includes(se)) out.push(se);
    return out;
  };
  const nameOf = (n) => n === document.scrollingElement ? 'document' : n.id ? '#' + n.id : n.getAttribute('data-flow') ? 'flow:' + n.getAttribute('data-flow') : n.className;
  const regionOf = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const f = n.getAttribute && n.getAttribute('data-flow');
      if (f && REGIONS.includes(f)) return f;
    }
    return null;
  };
  const contentBox = (el) => {
    const sc = scrollers(el)[0];
    const r = el.getBoundingClientRect();
    if (!sc || sc === document.scrollingElement) return box(r, window.scrollX, window.scrollY);
    const c = sc.getBoundingClientRect();
    return { ...box(r, sc.scrollLeft - c.left, sc.scrollTop - c.top), container: nameOf(sc) };
  };
  const text = () => (document.querySelector('[data-pf-root]') || document.body).textContent;
  const captions = (scope) => [...scope.querySelectorAll('select')].map((s) => {
    const t = s.closest('label') && s.closest('label').querySelector('.pf-sel-t');
    return t ? t.textContent : '';
  });
  const options = (el) => [...el.querySelectorAll('option')].map((o) => ({ value: o.value, text: o.textContent }));
  const snap = () => window.BriefPage && window.BriefPage.state.ui.profilesState;
  window.__flow = {
    frame() {
      const side = document.querySelector('.sh-side'), rail = document.querySelector('.sh-rail'), shell = document.querySelector('.sh-shell');
      return { inner: { w: innerWidth, h: innerHeight }, dpr: devicePixelRatio, zoom: visualViewport ? visualViewport.scale : 1,
        sidebar: !!shell && shell.getAttribute('data-side') === 'open' && !matchMedia('(max-width: 899px)').matches,
        sidebarWidth: side ? Math.round(side.getBoundingClientRect().width) : 0, railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0 };
    },
    regions() {
      const detail = q('detail');
      return REGIONS.map((id) => { const el = q(id); return { id, box: el ? box(el.getBoundingClientRect(), 0, 0) : null, inDetail: !!(el && detail && detail !== el && detail.contains(el)) }; });
    },
    sections() { return [...document.querySelectorAll('[data-flow-sec]')].map((el) => el.getAttribute('data-flow-sec')); },
    // Diagnostic heights behind the scroll counts: the head, the status strip, each card and each role-box section.
    layout() {
      const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
      return { head: h(document.querySelector('.pf-head')), status: h(q('status')),
        cards: [...document.querySelectorAll('.pf-card')].map(h),
        cardParts: [...document.querySelectorAll('.pf-card-b')].slice(0, 2).map((b) => [...b.children].map((c) => c.className + ':' + h(c))),
        offsets: { panes: Math.round(q('cards').getBoundingClientRect().top), cardsBody: Math.round(document.querySelector('.pf-cards').getBoundingClientRect().top) },
        sections: [...document.querySelectorAll('[data-flow="roles"] [data-flow-sec]')].map((el) => [el.getAttribute('data-flow-sec'), h(el)]) };
    },
    rows() {
      const route = document.querySelector('[data-pf-route="agents/explore"]');
      const mem = document.querySelector('[data-pf-memory="kibitzer"]');
      const sum = document.querySelector('[data-pf-sum]');
      const main = document.querySelector('[data-pf-main]');
      const widths = route ? [...route.querySelectorAll('select')].map((s) => Math.round(s.getBoundingClientRect().width)) : [];
      return {
        role: { captions: route ? captions(route) : [], selects: widths.length, widths, recommendationOnLabelLine: !!(route && route.querySelector('.pf-route-id [class*="pf-st-"]')) },
        memory: { modes: mem ? options(mem.querySelector('[data-pf="memory-mode"]')).map((o) => o.text) : [], captions: mem ? captions(mem).slice(1) : [],
          lines: ['current', 'pending'].map((k) => { const p = document.querySelector('[data-pf-memory-' + k + '="kibitzer"]'); return p ? p.textContent.slice(0, 4) : ''; }) },
        summarizer: { firstItem: sum ? options(sum.querySelector('[data-pf="summarizer-provider"]'))[0].text : '', captions: sum ? captions(sum) : [], effort: sum ? sum.querySelectorAll('select').length > 2 : null },
        main: { captions: main ? captions(main) : [] },
      };
    },
    copy(list) { const t = text(); return list.filter((s) => !t.includes(s)); },
    heading() { const h = document.querySelector('.pf-title'); return h ? h.textContent : ''; },
    reach(id) {
      const el = q(id);
      if (!el) return { missing: true };
      const list = scrollers(el);
      const before = list.map((n) => n.scrollTop);
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      const moved = list.map((n, i) => ({ container: nameOf(n), px: Math.abs(n.scrollTop - before[i]), visible: n.clientHeight }));
      const r = el.getBoundingClientRect();
      return { region: regionOf(el), box: contentBox(el), view: box(r, 0, 0), disabled: !!el.disabled,
        scrolls: moved.reduce((s, m) => s + (m.px ? Math.ceil(m.px / m.visible) : 0), 0), moved: moved.filter((m) => m.px) };
    },
    visible(id) {
      const el = q(id);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    },
    options(id) { const el = q(id); return el ? options(el) : []; },
    choose(id, value) {
      const el = q(id);
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    },
    click(id) { q(id).click(); return true; },
    levels(model) {
      const cat = snap() && snap().view && snap().view.catalog || {};
      for (const k of Object.keys(cat)) if (cat[k] && cat[k].model === model && Array.isArray(cat[k].levels)) return cat[k].levels;
      return null;
    },
    // Providers with a catalog model served in every required home (the view's own rule), so a role service pick
    // always leaves models to choose from.
    servedProviders() {
      const view = snap() && snap().view || {};
      if (view.registry && Array.isArray(view.registry.unknownHomes) && view.registry.unknownHomes.length) return [];
      const out = [];
      for (const e of Object.values(view.catalog || {})) {
        if (!e || typeof e.model !== 'string' || e.model.indexOf('/') <= 0) continue;
        const s = e.served;
        if (s && !(Object.keys(s).length && Object.values(s).every((v) => v === true))) continue;
        const p = e.model.slice(0, e.model.indexOf('/'));
        if (!out.includes(p)) out.push(p);
      }
      return out;
    },
    pending() { return (snap() && snap().pending || []).map((c) => JSON.parse(JSON.stringify(c))); },
    shown() { return snap() && snap().shown; },
  };
  return true;
})()`;

// The page-side deadline stays under scripts/cdp.mjs's 15 s call deadline, so a miss names what was awaited.
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
async function settle(page) {
  await page.eval(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
  await page.eval(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  // Theme and fade transitions run up to tokens.css --dur; wait for every finite animation before measuring.
  await page.eval(`Promise.all(document.getAnimations().filter((a) => a.playState === 'running' &&
    !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity)).map((a) => a.finished.catch(() => null))).then(() => true)`);
  await page.eval(`new Promise((resolve) => requestAnimationFrame(() => resolve(true)))`);
}

async function startBoard(root) {
  const homes = seedHomes(root);
  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  const store = openProfilesStore({ primaryHome: homes.primary, stableHome: homes.stable, mirrorHomes: [], pluginPath: PLUGIN, inventory, now: () => FIXED_NOW });
  const vm = JSON.parse(fs.readFileSync(VM_FILE, 'utf8'));
  const posts = [];
  const server = createBoardServer({
    portBase: PORT_BASE, portCount: 5, generation: 7, token: TOKEN,
    getPage: ({ nonce } = {}) => pageHtml(vm, 7, { mode: 'server', token: TOKEN, nonce }),
    getViewModel: () => vm,
    profilesState: () => store.state(),
    onProfiles: (body) => { posts.push(JSON.parse(JSON.stringify(body))); return store.handle(body); },
  });
  const { port } = await server.start();
  return { url: `http://127.0.0.1:${port}/`, server, posts, fixtureHash: homes.fixtureHash };
}

async function openScreen(page, url) {
  await page.goto(url);
  await page.eval(FLOW_LIB);
  await waitFor(page, `document.querySelector('[data-sh="view"][data-key="profiles"]')`, 'board shell');
  if (!(await page.eval(`window.__flow.frame().sidebar`))) {
    await page.eval(`document.querySelector('.sh-topen').click()`);
    await waitFor(page, `window.__flow.frame().sidebar`, 'docked sidebar');
  }
  await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
  await waitFor(page, `document.querySelector('[data-pf-root]') && document.querySelector('[data-pf-root]').getAttribute('data-pf-state') === 'view' && document.querySelector('[data-flow="apply:detail"]')`, 'profiles view');
  await settle(page);
}

// One step = reach the control (scrolls counted), then do what the owner does there and wait for the screen to answer.
async function perform(page, id, posts, log) {
  console.error('step ' + id);
  const step = await page.eval(`window.__flow.reach(${JSON.stringify(id)})`);
  if (step.missing) return { control: id, missing: true };
  await settle(page);
  const value = async (pick) => {
    const opts = (await page.eval(`window.__flow.options(${JSON.stringify(id)})`)).filter((o) => o.value);
    return pick(opts);
  };
  let done = null;
  if (id.startsWith('card:')) {
    await page.eval(`window.__flow.click(${JSON.stringify(id)})`);
    await waitFor(page, `document.querySelector('[data-flow="${id}"]').getAttribute('aria-pressed') === 'true'`, id + ' shown');
    done = { shown: await page.eval(`window.__flow.shown()`) };
  } else if (/^(apply:|apply$)/.test(id)) {
    const before = posts.length;
    await page.eval(`window.__flow.click(${JSON.stringify(id)})`);
    await waitFor(page, `document.querySelector('[data-pf-result="apply"]') || document.querySelector('.pf-tray .pf-err') || document.querySelector('.pf-conflict')`, id + ' result');
    const ok = await page.eval(`!!document.querySelector('[data-pf-result="apply"]')`);
    const error = ok ? '' : await page.eval(`((document.querySelector('.pf-tray .pf-err') || document.querySelector('.pf-conflict') || {}).textContent || '').trim()`);
    await waitFor(page, `document.querySelector('[data-pf-root]').getAttribute('data-pf-busy') === 'false' && document.querySelector('[data-flow="apply:detail"]')`, 'reload after apply');
    done = { ok, error, posts: posts.slice(before).map((p) => ({ action: p.action, changes: p.changes })) };
  } else {
    const current = await page.eval(`document.querySelector('[data-flow="${id}"]').value`);
    let pick;
    if (id.endsWith(':mode')) pick = 'custom';
    else if (id.endsWith(':service')) {
      const served = await page.eval(`window.__flow.servedProviders()`);
      pick = await value((opts) => (opts.find((o) => o.value !== current && (id.startsWith('memory:') || served.includes(o.value))) || {}).value);
    }
    else if (id.endsWith(':model')) pick = await value((opts) => (opts.find((o) => o.value !== current) || opts[0] || {}).value);
    else pick = await value((opts) => (opts[opts.length - 1] || {}).value);
    await page.eval(`window.__flow.choose(${JSON.stringify(id)}, ${JSON.stringify(pick || '')})`);
    await settle(page);
    const effortId = id.replace(/:(service|model|effort|mode)$/, ':effort');
    const effort = await page.eval(`window.__flow.options(${JSON.stringify(effortId)})`);
    const modelId = id.replace(/:(service|model|effort|mode)$/, ':model');
    const model = await page.eval(`(document.querySelector('[data-flow="${modelId}"]') || {}).value || ''`);
    done = { from: current, picked: pick, model, effort: effort.map((o) => o.value).filter(Boolean),
      levels: model ? await page.eval(`window.__flow.levels(${JSON.stringify(model)})`) : null };
  }
  log.push({ control: id, ...done });
  return { control: id, region: step.region, box: step.box, scrolls: step.scrolls, view: step.view, moved: step.moved, disabled: step.disabled, result: done };
}

const rel = (a, b, tol) => {
  const d = (b.x + b.w / 2) - (a.x + a.w / 2), e = (b.y + b.h / 2) - (a.y + a.h / 2);
  return { x: Math.abs(d) < tol ? 0 : Math.sign(d), y: Math.abs(e) < tol ? 0 : Math.sign(e) };
};
const right = (b) => b.x + b.w, bottom = (b) => b.y + b.h;

function diff(board, ref, rules, size) {
  const out = {};
  const add = (rule, detail) => { (out[rule].differences ||= []).push(detail); };
  for (const id of Object.keys(rules.rules)) out[id] = { name: rules.rules[id].name, differences: [] };
  if (JSON.stringify(board.sections) !== JSON.stringify(ref.sections)) add('F1', { expected: ref.sections, actual: board.sections });
  for (const task of Object.keys(ref.tasks)) {
    const want = ref.tasks[task], got = board.tasks[task] || [];
    const ids = (list) => list.filter((s) => !s.missing).map((s) => s.control);
    // A step counts only when it worked: present, enabled, and an apply that the store accepted.
    const failed = (s) => s.missing || s.disabled || (s.result && s.result.ok === false);
    if (JSON.stringify(ids(got)) !== JSON.stringify(want.map((s) => s.control)) || got.some(failed)) {
      add('F2', { task, expected: want.map((s) => s.control), actual: got.map((s) => s.control + (s.missing ? ' (missing)' : s.disabled ? ' (disabled)' : '') +
        (s.result && s.result.ok === false ? ' (refused: ' + s.result.error + ')' : '')) });
    }
    want.forEach((w, i) => {
      const g = got[i];
      if (!g || g.missing) return;
      if (g.region !== w.region) add('F3', { task, control: w.control, expected: w.region, actual: g.region });
      if (g.scrolls > w.scrolls) add('F5', { task, control: w.control, expected: '<= ' + w.scrolls, actual: g.scrolls, moved: g.moved });
    });
    // F4 compares step pairs that share one region (one container) on both sides: the reference boxes are container
    // coordinates, so only same-container pairs have comparable relations; cross-region order is F7's.
    const tol = rules.rules.F4.tolerancePx || 8;
    for (let i = 0; i < want.length; i++) {
      for (let j = i + 1; j < want.length; j++) {
        const gi = got[i], gj = got[j];
        if (!gi || !gj || gi.missing || gj.missing || want[i].region !== want[j].region || gi.region !== gj.region) continue;
        const a = rel(want[i].box, want[j].box, tol), b = rel(gi.box, gj.box, tol);
        if (a.x !== b.x || a.y !== b.y) add('F4', { task, pair: [want[i].control, want[j].control], expected: a, actual: b });
      }
    }
  }
  const rows = board.rows;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(rows.role.captions, ref.rows.role.captions)) add('F6', { row: 'role', expected: ref.rows.role.captions, actual: rows.role.captions });
  if (rows.role.selects !== 3 || Math.max(...rows.role.widths) - Math.min(...rows.role.widths) > 1) add('F6', { row: 'role', expected: 'three equal-width selects', actual: rows.role.widths });
  if (!rows.role.recommendationOnLabelLine) add('F6', { row: 'role', expected: 'recommendation chip on the label line', actual: false });
  if (!same(rows.main.captions, ref.rows.role.captions)) add('F6', { row: 'main', expected: ref.rows.role.captions, actual: rows.main.captions });
  if (!same(rows.memory.modes, ref.rows.memory.modes)) add('F6', { row: 'memory', expected: ref.rows.memory.modes, actual: rows.memory.modes });
  if (!same(rows.memory.captions, ref.rows.role.captions)) add('F6', { row: 'memory', expected: ref.rows.role.captions, actual: rows.memory.captions });
  if (!same(rows.memory.lines, ['현재: ', '보류: '])) add('F6', { row: 'memory', expected: ['현재: ', '보류: '], actual: rows.memory.lines });
  if (rows.summarizer.firstItem !== ref.rows.summarizer.firstItem) add('F6', { row: 'summarizer', expected: ref.rows.summarizer.firstItem, actual: rows.summarizer.firstItem });
  if (!same(rows.summarizer.captions, ['1. 제공사', '2. AI 모델']) || rows.summarizer.effort) add('F6', { row: 'summarizer', expected: ['1. 제공사', '2. AI 모델'], actual: rows.summarizer });
  for (const miss of board.copy.missing) add('F6', { copy: miss, expected: 'present word for word', actual: 'missing' });
  for (const t of ['role', 'memory']) {
    for (const s of board.tasks[t] || []) {
      const r = s.result || {};
      if (!s.control.endsWith(':model') || !r.levels) continue;
      if (!same(r.effort, r.levels)) add('F6', { task: t, control: s.control.replace(/:model$/, ':effort'), expected: r.levels, actual: r.effort });
    }
  }
  const box = Object.fromEntries(board.regions.map((r) => [r.id, r.box]));
  const missing = REGIONS.filter((id) => !box[id]);
  if (missing.length) add('F7', { expected: REGIONS, actual: 'missing ' + missing.join(', ') });
  else {
    const rule = (ok, what) => { if (!ok) add('F7', { relation: what, size, boxes: box }); };
    rule(bottom(box.status) <= box.cards.y && bottom(box.status) <= box.detail.y, 'status above cards and detail');
    rule(right(box.cards) <= box.detail.x, 'cards left of detail' + (board.frame.sidebar ? ' (sidebar docked)' : ''));
    rule(box.guide.x >= box.status.x + box.status.w / 2 && right(box.status) - right(box.guide) <= 48 &&
      box.guide.y >= box.status.y && bottom(box.guide) <= bottom(box.status), 'guide at the right end of status');
    // Inside = inside the detail pane's content (it scrolls on its own, like the WinForms pane whose apply row sits
    // below its 448 px fold): DOM containment plus the pane's column, not its visible rect.
    const inside = Object.fromEntries(board.regions.map((r) => [r.id, r.inDetail]));
    rule(box.apply.y >= bottom(box.roles) && inside.apply && inside.roles && box.apply.x >= box.detail.x &&
      right(box.apply) <= right(box.detail), 'apply below the role box inside detail');
    // The tray is docked to the bottom of the screen (sticky), so it sits over the cards column's tail: it must
    // clear the detail pane and be fully inside the viewport (1 px for box rounding).
    rule(box.message.y >= bottom(box.detail) && bottom(box.message) <= board.frame.inner.h + 1, 'message below detail and inside the viewport');
  }
  const differences = Object.entries(out).flatMap(([id, r]) => r.differences.map((d) => ({ rule: id, ...d })));
  return { schema: 'flow-diff/1', size, reference: path.relative(ROOT, REFERENCE).replace(/\\/g, '/'), rules: out, differences };
}

async function main() {
  const reference = JSON.parse(fs.readFileSync(REFERENCE, 'utf8'));
  const rules = JSON.parse(fs.readFileSync(RULES, 'utf8'));
  const allow = JSON.parse(fs.readFileSync(AX_ALLOWLIST, 'utf8'));
  const tempRoot = path.join(os.tmpdir(), 'omo-switcher-tests', 'flow-map-' + Date.now().toString(36));
  assertFixtureRoot(tempRoot);
  const report = { ok: false, startedAt: new Date().toISOString(), tempRoot, sizes: {}, ax: [], errors: [] };
  let page, csp, pids = [];
  let failed = false;
  try {
    page = await launch({ width: SIZES[0].width, height: SIZES[0].height });
    csp = await watchCsp(page);
    pids = [...new Set([page.pid, ...listProfilePids(page.profileDir)])];
    for (const size of SIZES) {
      await page.client.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
      const map = { schema: 'flow-map/1', source: 'board', fixtureHash: '', frame: null, regions: [], sections: [], rows: null, tasks: {}, copy: null, log: [] };
      for (const task of Object.keys(TASKS)) {
        console.error('task ' + size.name + ' ' + task);
        const board = await startBoard(path.join(tempRoot, size.name + '-' + task));
        try {
          map.fixtureHash = board.fixtureHash;
          await openScreen(page, board.url);
          if (task === 'role') {
            const frame = await page.eval(`window.__flow.frame()`);
            map.frame = { width: size.width, height: size.height, ...frame };
            map.regions = await page.eval(`window.__flow.regions()`);
            map.sections = await page.eval(`window.__flow.sections()`);
            map.layout = await page.eval(`window.__flow.layout()`);
            await page.screenshot(path.join(OUT, `screen-${size.name}.png`));
            map.rows = await page.eval(`window.__flow.rows()`);
            map.copy = { missing: await page.eval(`window.__flow.copy(${JSON.stringify(STATIC_COPY)})`), conditional: CONDITIONAL_COPY };
            const snap = await axSnapshot(page);
            await page.eval(`window.__flow.click('guide')`);
            await waitFor(page, `document.querySelector('#pf-guide-dlg').open`, 'guide dialog');
            const open = await axSnapshot(page);
            await page.eval(`document.querySelector('[data-pf="guide-close"]').click()`);
            for (const [state, s] of [['screen', snap], ['guide-open', open]]) {
              const unnamed = unnamedInteractive(s.raw && s.raw.nodes).filter((n) => !Object.hasOwn(allow.entries || {}, String(n.role?.value) + '|' + String(n.name?.value ?? '')));
              report.ax.push({ size: size.name, state, unnamed: unnamed.map((n) => ({ role: n.role?.value, nodeId: n.nodeId })) });
            }
          }
          const steps = [];
          for (const id of TASKS[task]) {
            const step = await perform(page, id, board.posts, map.log);
            steps.push(step);
            if (step.missing) break;
            if (task === 'role' && id.endsWith(':effort')) {
              const heading = await page.eval(`window.__flow.heading()`);
              if (!/ · 변경 보류 \d+건$/.test(heading)) map.copy.missing.push(' · 변경 보류 N건');
            }
          }
          if (task === 'memory') {
            const missing = await page.eval(`window.__flow.copy(['저장됨 · 다음 대화부터 반영'])`);
            map.copy.missing.push(...missing);
          }
          map.tasks[task] = steps;
          if (board.posts.some((p) => p.action === 'preview')) report.errors.push(`${size.name} ${task}: a preview was posted; Preview is never a step`);
        } finally {
          await board.server.close();
        }
      }
      const result = diff(map, reference, rules, size.name);
      if (map.fixtureHash !== reference.fixtureHash) result.differences.push({ rule: 'fixture', expected: reference.fixtureHash, actual: map.fixtureHash });
      fs.writeFileSync(path.join(OUT, `flow-map.board-${size.name}.json`), JSON.stringify(map, null, 2) + '\n');
      fs.writeFileSync(path.join(OUT, `flow-diff-${size.name}.json`), JSON.stringify(result, null, 2) + '\n');
      report.sizes[size.name] = { differences: result.differences.length, rules: Object.fromEntries(Object.entries(result.rules).map(([k, v]) => [k, v.differences.length ? 'FAIL' : 'PASS'])) };
      if (result.differences.length) failed = true;
    }
  } catch (error) {
    failed = true;
    report.errors.push(String(error && error.stack || error));
  } finally {
    if (page) {
      try { await page.close(); } catch (error) { failed = true; report.errors.push('chrome close: ' + String(error)); }
      report.chromeLeft = pids.filter((pid) => isPidAlive(pid));
      if (report.chromeLeft.length) failed = true;
    }
    if (!KEEP) fs.rmSync(tempRoot, { recursive: true, force: true });
    report.tempRemoved = !fs.existsSync(tempRoot);
  }
  const violations = csp ? csp.violations : [];
  fs.writeFileSync(path.join(OUT, 'csp.json'), JSON.stringify({ violations, count: violations.length, notes: csp ? csp.notes.length : 0 }, null, 2) + '\n');
  const unnamed = report.ax.reduce((n, a) => n + a.unnamed.length, 0);
  fs.writeFileSync(path.join(OUT, 'ax.txt'), [`allowlist ${path.relative(ROOT, AX_ALLOWLIST).replace(/\\/g, '/')} entries: ${Object.keys(allow.entries || {}).length}`,
    ...report.ax.map((a) => `${a.size} ${a.state}: unnamed interactive nodes outside the allowlist: ${a.unnamed.length}${a.unnamed.length ? ' ' + JSON.stringify(a.unnamed) : ''}`),
    `result: ${unnamed ? 'FAIL' : 'PASS'}`].join('\n') + '\n');
  if (violations.length || unnamed || report.errors.length) failed = true;
  report.ok = !failed;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'flow-map-run.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: report.ok, sizes: report.sizes, csp: violations.length, axUnnamed: unnamed, errors: report.errors }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

await main();
