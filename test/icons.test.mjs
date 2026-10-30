// The Lucide icon sprite (src/render.mjs PAGE_ICONS), its licence notice and the icons the page scripts draw (icons.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageHtml } from '../src/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const clone = (v) => JSON.parse(JSON.stringify(v));
const ICON_DIR = 'assets/icons/lucide';
const FIXTURE = JSON.parse(read('test/fixtures/view-model-board.json'));
const EP = /\p{Extended_Pictographic}/u;
// = render.mjs PAGE_JS without page.js (it starts the page on DOMContentLoaded)
const MODULES = ['icons', 'view', 'plan-view', 'workers-view', 'blocks', 'convo-view', 'shell', 'alarm', 'annotate'];
const TEMPLATES = MODULES.filter((m) => m !== 'icons').concat('page');

const PAGE = pageHtml(FIXTURE, 7, { mode: 'file' });
const SPRITE = /<svg id="icon-sprite"[^>]*>([\s\S]*?)<\/svg>\n/.exec(PAGE);
const SYMBOLS = SPRITE ? [...SPRITE[1].matchAll(/<symbol id="i-([a-z0-9-]+)" viewBox="0 0 24 24">/g)].map((m) => m[1]) : [];
const VENDORED = fs.readdirSync(path.join(ROOT, ICON_DIR)).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();
const uses = (html) => [...html.matchAll(/<use href="#i-([^"]*)"><\/use>/g)].map((m) => m[1]);

function loadPage() {
  const ctx = vm.createContext({});
  for (const m of MODULES) vm.runInContext(read(`src/page/${m}.js`), ctx, { filename: m + '.js' });
  return ctx;
}

// Every surface the templates draw for the fixture model (plus a closed earlier conversation in the first tab, for the
// 이전 대화 rows): the rail, the sidebar frame and each of its views and inbox groups, the tab bar, the overview with every
// detail open, each conversation page sub-tab, read-only and on the server page with confirm rows, the alarm's sound
// button and the annotation tray.
function surfaces() {
  const g = loadPage();
  const S = g.BriefShell, V = g.BriefView, C = g.BriefConvo;
  const model = clone(FIXTURE);
  const first = model.sessions[0];
  model.sessions.push({ id: 'prev-of-185', alive: false, tabId: first.tabId, tabNumber: first.tabNumber, tabLabel: first.tabLabel, title: '이전 대화',
    headline: '옛 이야기', tab: '끝남', status: 'done', statusKey: 'done', lastActivityAt: model.generatedAt - 86400e3, decisions: [] });
  const ids = model.sessions.map((s) => s.id);
  const open = model.sessions[0].decisions.filter((d) => !d.answered && !d.closed).map((d) => d.id);
  const answers = { [open[0]]: { confirm: { option: 'A' } }, [open[1]]: { confirm: { hold: true } } };
  const out = { rail: [], side: [], tabs: [], main: [] };
  for (const view of ['conv', 'inbox', 'plans', 'home', 'archive', 'settings']) {
    for (const sideOpen of [true, false]) {
      let st = S.reduce(undefined, { type: 'load', now: model.generatedAt, known: ids,
        json: JSON.stringify({ view, sideOpen, favs: [ids[1], 'gone-1'], tabs: [ids[0], ids[1], 'gone-1'], pinned: [ids[0]], active: ids[0] }) });
      for (const sid of [...ids, 'sec:recent']) st = S.reduce(st, { type: 'expand', sid });
      const boxes = view === 'inbox' ? ['wait', 'done', 'ans', 'held'] : [null];
      for (const box of boxes) {
        const s2 = Object.assign({}, box ? S.reduce(st, { type: 'view', key: 'inbox', box }) : st, { live: true, answers });
        out.rail.push(S.rail(model, s2));
        out.side.push(S.sideFrame(s2) + S.side(model, s2));
        out.tabs.push(S.tabs(model, s2));
      }
    }
  }
  const expanded = {};
  for (const id of ids) for (const k of ['detail:', 'more-ch:', 'more-dc:']) expanded[k + id] = true;
  for (const live of [false, true]) {
    const ui = { live, answers: live ? answers : {}, expanded };
    out.main.push(V.renderOverview(model, ui));
    for (const s of model.sessions) for (const sub of ['ov', 'plan', 'wk', 'dec', 'rep']) out.main.push(C.render(s, Object.assign({ sub }, ui), { now: model.generatedAt }));
  }
  out.main.push(g.BriefAlarm.soundButtonHtml());
  const note = { blocks: ['now'], sub: 'ov', text: '', snip: '지금', intent: '고쳐줘', comment: '의견', paths: [] };
  for (const mode of ['live', 'file']) out.main.push(g.BriefAnnotate.trayBar(first, [note, Object.assign({}, note, { intent: '질문' })], true, mode));
  out.main.push(g.BriefAnnotate.trayBar(first, [], false, 'live'));
  return out;
}

test('icons.js: icon() is a decorative <use> of the sprite with page.css classes; timed() escapes and draws the stopwatch as the clock', () => {
  const g = loadPage();
  assert.equal(g.BriefIcons.icon('x'), '<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-x"></use></svg>');
  assert.equal(g.BriefIcons.icon('star', 'ic-md ic-fill'), '<svg class="ic ic-md ic-fill" aria-hidden="true" focusable="false"><use href="#i-star"></use></svg>');
  assert.equal(g.BriefIcons.timed('전달됨 \u23F111:58 <b>&'), '전달됨 ' + g.BriefIcons.icon('clock', 'ic-xs') + '11:58 &lt;b&gt;&amp;');
});

test('sprite: one hidden 0x0 svg right after the licence notice and before #app, one 24x24 <symbol> per vendored icon, shapes only', () => {
  assert.ok(SPRITE, 'the page carries the sprite');
  assert.equal((PAGE.match(/<svg id="icon-sprite"/g) || []).length, 1);
  const tag = /<svg id="icon-sprite"[^>]*>/.exec(PAGE)[0];
  for (const want of ['width="0"', 'height="0"', 'position:absolute', 'aria-hidden="true"', 'focusable="false"']) assert.ok(tag.includes(want), want);
  assert.ok(PAGE.indexOf('<body>\n<!--\nIcons: Lucide') >= 0 && PAGE.indexOf('<svg id="icon-sprite"') < PAGE.indexOf('<div id="app">'));
  assert.deepEqual([...SYMBOLS].sort(), VENDORED, 'a symbol for each assets/icons/lucide/<name>.svg and nothing else');
  const tags = new Set([...SPRITE[1].matchAll(/<\/?([a-zA-Z]+)/g)].map((m) => m[1]));
  for (const t of tags) assert.ok(['symbol', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'].includes(t), `<${t}> in the sprite`);
  assert.doesNotMatch(SPRITE[1], /\s(?:on[a-z]+|style|class|stroke[a-z-]*|fill|href|xlink:href)=/, 'geometry only: stroke, size and colour are the CSS');
});

test('sprite: a vendored file that is not a plain Lucide shape set is refused, never inlined', () => {
  const hostile = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h2" onload="alert(1)" /></svg>\n';
  const swap = { ...fs, readFileSync: (p, ...a) => (String(p).endsWith(path.join('lucide', 'house.svg')) ? hostile : fs.readFileSync(p, ...a)) };
  assert.throws(() => pageHtml(FIXTURE, 7, { mode: 'file', fs: swap }), /icon house: onload=/);
});

test('licence: assets/icons/lucide/LICENSE is the upstream ISC + MIT text; the one Lucide comment of the page names both licences, the pin, the copyright lines and that file', () => {
  const license = read(`${ICON_DIR}/LICENSE`);
  assert.match(license, /^ISC License\n\nCopyright \(c\) \d{4} Lucide Icons and Contributors\n\nPermission to use, copy, modify/);
  assert.match(license, /\nThe following Lucide icons are derived from the Feather project:\n/);
  assert.match(license, /\nThe MIT License \(MIT\) \(for the icons listed above\)\n\nCopyright \(c\) 2013-present Cole Bemis\n\nPermission is hereby granted/);
  assert.equal(license.includes('\r'), false);
  const notes = [...PAGE.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]).filter((c) => c.includes('Lucide'));
  assert.equal(notes.length, 1, 'a single licence comment');
  const note = notes[0];
  assert.match(note, /^\nIcons: Lucide \(ISC License\b/);
  assert.match(note, /\bMIT License\b/);
  assert.match(note, / at commit [0-9a-f]{40}\b/);
  const rights = license.split('\n').filter((l) => l.startsWith('Copyright (c) '));
  assert.equal(rights.length, 2, 'Lucide and Feather');
  for (const line of rights) assert.ok(note.includes('\n' + line + '\n'), 'verbatim: ' + line);
  assert.ok(note.includes(ICON_DIR + '/LICENSE'), 'where the full text is');
});

test('every icon a template draws has a symbol in the sprite (no dangling <use>), and every vendored icon is drawn somewhere', () => {
  const out = surfaces();
  const drawn = new Set(Object.values(out).flat().flatMap(uses));
  const dangling = [...drawn].filter((n) => !SYMBOLS.includes(n));
  assert.deepEqual(dangling, [], 'drawn without a symbol: ' + dangling.join(', '));
  const literal = new Set();
  for (const m of TEMPLATES) {
    for (const [, name] of read(`src/page/${m}.js`).matchAll(/\bic\('([^']*)'/g)) {
      assert.ok(SYMBOLS.includes(name), `${m}.js ic('${name}') has no symbol`);
      literal.add(name);
    }
  }
  for (const name of VENDORED) assert.ok(drawn.has(name) || literal.has(name), `${name} is vendored but no template draws it`);
  assert.ok(drawn.size >= VENDORED.length - 3, `the surfaces draw ${drawn.size} of ${VENDORED.length} icons`);
});

test('no pictographic emoji left in the rail, the sidebar or the tab bar, in text or in tooltips and labels', () => {
  const out = surfaces();
  for (const [region, list] of [['#rail', out.rail], ['.sh-side', out.side], ['#tabs', out.tabs]]) {
    for (const html of list) {
      const hit = EP.exec(html);
      assert.equal(hit, null, `${region}: ${hit && html.slice(Math.max(0, hit.index - 60), hit.index + 20)}`);
      assert.ok(uses(html).length > 0, `${region} draws icons`);
    }
  }
});

// Scope exception (switcher-flow-restore, todo 2): merging board main 0683a8e4415daa8684776f475a56d47fabfd43ea
// (S1, R1b window-tabs, folded history and memento) with the primary-agents profiles view (84f55c9) produces
// Buffer.byteLength(pageHtml(test/fixtures/view-model-board.json, 7, { mode: 'file' })) = 563709 B
// (branch 84f55c9 baseline was 473662 B; main baseline was 463375 B). Re-baseline once to 563709 B.
// The growth budget was raised from 16384 B to 32768 B by owner decision on 2026-10-23 (plan Must have 11)
// for the todo-8 WinForms layout work; the baseline itself is not moved again.
const BASELINE_TREE = '0683a8e4415daa8684776f475a56d47fabfd43ea';
const BASELINE_PAGE_BYTES = 563709;
// Office allowance (plan omo-office-view Must have 11), owner decision #521 2026-10-29:
// "퀄리티 좋아지는거면 제한 올려도됨 대신에 마지막엔 최적화 렉 안걸리는 정도로 검수해서 마무리만 하자".
// OFFICE_ALLOWANCE_BYTES records the measured bytes of the office files (art, model, view, css) as they sit in this page
// (each script in its 20 B <script>\n...\n</script>\n wrapper, the sheet with its join newline), measured when the office
// files last changed (plan todo 6, live updates and motion); it is taken out of the growth and the 32 KB budget still holds
// for everything else. No further size cap: lag is judged by todo 7 (CPU budget) and F3. The diagnostic prints the
// current office bytes; re-record the constant under the same decision when the office files change.
const OFFICE_ALLOWANCE_BYTES = 86430;
const OFFICE_FILES = ['office-assets.js', 'office-model.js', 'office-view.js', 'office.css'];
function officeChunks() {
  return OFFICE_FILES.map((f) => {
    const text = read('src/page/' + f);
    return f.endsWith('.css') ? '\n' + text.replace(/<\/style/gi, '<\\/style') : '<script>\n' + text.replace(/<(\/?script|!--)/gi, '\\x3C$1') + '\n</script>\n';
  });
}

test('fixture page growth over the accepted tree stays within 32 KB (whole page; icon payload printed too)', (t) => {
  const notice = /<!--\nIcons: Lucide[\s\S]*?-->\n/.exec(PAGE)[0];
  const bytes = { sprite: Buffer.byteLength(SPRITE[0]), notice: Buffer.byteLength(notice), script: Buffer.byteLength(read('src/page/icons.js')) };
  bytes.payload = bytes.sprite + bytes.notice + bytes.script;
  bytes.page = Buffer.byteLength(PAGE);
  t.diagnostic('icon bytes ' + JSON.stringify(bytes));
  bytes.baseline = BASELINE_PAGE_BYTES;
  bytes.growth = bytes.page - BASELINE_PAGE_BYTES;
  const office = officeChunks();
  for (const [i, chunk] of office.entries()) assert.ok(PAGE.includes(chunk), OFFICE_FILES[i] + ' is in the page exactly as measured');
  bytes.office = office.reduce((n, chunk) => n + Buffer.byteLength(chunk), 0);
  bytes.allowance = OFFICE_ALLOWANCE_BYTES;
  bytes.rest = bytes.growth - OFFICE_ALLOWANCE_BYTES;
  t.diagnostic('page growth vs ' + BASELINE_TREE + ': ' + bytes.growth + ' B (office allowance ' + OFFICE_ALLOWANCE_BYTES + ' B, office files now ' + bytes.office + ' B, everything else ' + bytes.rest + ' B)');
  assert.ok(bytes.rest <= 32 * 1024, JSON.stringify(bytes));
});
