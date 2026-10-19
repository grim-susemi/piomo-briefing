import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const FIXTURE = JSON.parse(read('test/fixtures/view-model-board.json'));
const ASSET_DIR = path.join(ROOT, 'test/fixtures/board-assets');
const NOW = FIXTURE.generatedAt; // injected clock: the model's own generatedAt
const WALL = NOW + 30000; // wall clock for the worker rows; nothing here reads the real one
const [A, B, C] = FIXTURE.sessions;
const SUB_KEYS = ['ov', 'plan', 'wk', 'dec', 'rep'];
const MODULES = ['src/page/icons.js', 'src/page/view.js', 'src/page/plan-view.js', 'src/page/workers-view.js', 'src/page/convo-view.js'];
const clone = (v) => JSON.parse(JSON.stringify(v));
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
// C-BLOCK grammar of data-block values (plan elements are plan-view data-anchors, never data-block)
const BLOCK = /^(?:head|now|flow|card\/(?:plan|wk|dec|rep)|change\/\d+\/\d+|done\/\d+\/\d+|dec\/[1-9]\d*|plan\/todo\/\d+|wk\/[A-Za-z0-9_-]+|rep\/[a-z0-9][a-z0-9_-]{0,63}(?:\/img\/\d+)?|note\/[^/\s]+|att\/\d+)$/;
const ASSET = /^assets\/[0-9a-f]{64}\.(?:png|jpg|webp)$/;
const HOSTILE = '<img src=x onerror="alert(1)">\'`&</textarea><script>alert(2)</script>';

// Each test gets its own realm with the page modules in PAGE_JS order.
function load(files = MODULES) {
  const ctx = vm.createContext({});
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  assert.equal(typeof ctx.BriefConvo?.render, 'function');
  return ctx;
}
function render(ctx, s, sub, extra = {}) {
  return ctx.BriefConvo.render(s, { sub, live: true, expanded: {}, answers: {}, wallNow: WALL, ...extra }, { now: NOW });
}

// ---- a strict parser for the renderer's own HTML: double-quoted attributes, escaped text; anything else throws ----------
const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'wbr', 'source', 'col', 'area']);
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`' };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, (e) => ENT[e]);
function parse(html) {
  const root = { tag: '#root', attrs: {}, kids: [], parent: null };
  const TOKEN = /<!--[\s\S]*?-->|<\/([a-z][a-z0-9]*)>|<([a-z][a-z0-9]*)((?:\s+[a-z][a-z0-9-]*(?:="[^"<>]*")?)*)\s*>|[^<]+/y;
  let cur = root, i = 0;
  while (i < html.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(html);
    if (!m) throw new Error('unparsable html at ' + i + ': ' + html.slice(i, i + 80));
    i = TOKEN.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      if (cur.tag !== m[1]) throw new Error(`</${m[1]}> closes <${cur.tag}> at ${i}`);
      cur = cur.parent;
    } else if (m[2]) {
      const el = { tag: m[2], attrs: {}, kids: [], parent: cur };
      for (const a of m[3].matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/g)) {
        if (Object.hasOwn(el.attrs, a[1])) throw new Error('duplicate attribute ' + a[1] + ' on <' + m[2] + '>');
        el.attrs[a[1]] = a[2] === undefined ? '' : decode(a[2]);
      }
      cur.kids.push(el);
      if (!VOID.has(m[2])) cur = el;
    } else cur.kids.push({ text: decode(m[0]), parent: cur });
  }
  if (cur !== root) throw new Error('unclosed <' + cur.tag + '>');
  return root;
}
function* walk(n) { for (const k of n.kids || []) if (k.tag) { yield k; yield* walk(k); } }
const els = (n, pred = () => true) => [...walk(n)].filter(pred);
const hasCls = (el, c) => String(el.attrs.class || '').split(/\s+/).includes(c);
const cls = (n, c) => els(n, (e) => hasCls(e, c));
const attrs = (n, k, v) => els(n, (e) => Object.hasOwn(e.attrs, k) && (v === undefined || e.attrs[k] === v));
const text = (n) => (n.text !== undefined ? n.text : (n.kids || []).map(text).join(''));
const flat = (n) => text(n).replace(/\s+/g, ' ').trim();
// text with each icons.js icon read as [name] (an icon has no text of its own)
const shown = (n) => (n.text !== undefined ? n.text : n.tag === 'svg' ? '[' + ((n.kids.find((k) => k.tag === 'use') || { attrs: {} }).attrs.href || '').replace('#i-', '') + ']'
  : (n.kids || []).map(shown).join(''));
const flatShown = (n) => shown(n).replace(/\s+/g, ' ').trim();
const marks = (html) => html.replace(/<svg class="ic[^"]*" aria-hidden="true" focusable="false"><use href="#i-([a-z0-9-]+)"><\/use><\/svg>/g, '[$1]');
const block = (root, id) => { const hit = attrs(root, 'data-block', id); assert.equal(hit.length, 1, 'one element for block ' + id); return hit[0]; };
const blocks = (root) => attrs(root, 'data-block').map((e) => e.attrs['data-block']);
const panel = (root) => { const p = cls(root, 'cv-panel'); assert.equal(p.length, 1, 'exactly one panel'); return p[0]; };
// the old card list (renderOverview) for one conversation, live
function oldCard(ctx, s, ui = {}) {
  const tab = { '나를 기다림': 'wait', '진행 중': 'run', '끝남': 'done' }[s.tab];
  return ctx.BriefView.renderOverview({ generatedAt: NOW, sessions: [s] }, { tab, live: true, answers: {}, expanded: {}, wallNow: WALL, ...ui });
}

// ---- fixture -----------------------------------------------------------------------------------------------------------

test('fixture: every C-VM, C-NOTE and C-REPORT field, and one PNG, JPEG and WebP named by their sha256', () => {
  for (const s of FIXTURE.sessions) {
    assert.equal(typeof s.alive, 'boolean', s.id + ' alive');
    assert.ok(Number.isInteger(s.briefSeq), s.id + ' briefSeq');
    for (const k of ['briefPath', 'sessionFile']) assert.ok(typeof s[k] === 'string' && /^[A-Z]:\//.test(s[k]), s.id + ' ' + k);
    assert.ok(Array.isArray(s.todo.items) && Number.isInteger(s.todo.more), s.id + ' todo');
    assert.ok(s.attachments.length > 0 && s.attachments.every((a) => typeof a.label === 'string' && typeof a.path === 'string'), s.id + ' attachments');
    assert.deepEqual(s.attachments[0], { label: '대화 id', path: s.id });
    for (const [k, v] of Object.entries(s.blockSources)) {
      assert.match(k, BLOCK);
      assert.ok(v.paths.length > 0 && new Set(v.paths).size === v.paths.length, k + ' paths');
    }
    assert.ok(Array.isArray(s.notes) && Array.isArray(s.reports), s.id + ' notes/reports');
  }
  assert.deepEqual(new Set(FIXTURE.sessions.map((s) => s.alive)), new Set([true, false]));
  assert.ok(A.answerKinds.includes('annotation'));
  assert.deepEqual(A.notes.map((n) => n.delivery.replace(/\d\d:\d\d$/, 'hh:mm')).sort(),
    ['대기: 그 대화가 다시 열리면 전달', '대기: 작업이 끝나면 전달', '전달 중', '전달됨 ⏱hh:mm'].sort());
  for (const n of A.notes) assert.deepEqual(Object.keys(n).sort(), ['at', 'delivery', 'key', 'preview']);
  assert.deepEqual(A.reports.map((r) => r.status).sort(), ['결정 기다림', '답함', '참고'].sort());
  for (const r of A.reports) {
    assert.deepEqual(Object.keys(r).sort(), ['at', 'decisionId', 'id', 'images', 'status', 'summary', 'title']);
    for (const im of r.images) assert.deepEqual(Object.keys(im).sort(), ['alt', 'h', 'option', 'path', 'src', 'w']);
  }
  const files = fs.readdirSync(ASSET_DIR).sort();
  assert.deepEqual(files.map((f) => f.split('.')[1]).sort(), ['jpg', 'png', 'webp']);
  const MAGIC = { png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, webp: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' };
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(ASSET_DIR, f));
    const [sha, ext] = f.split('.');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha, f + ' is named by its sha256');
    assert.ok(bytes.length <= 4096, f + ' <= 4 KiB');
    assert.ok(MAGIC[ext](bytes), f + ' magic bytes');
  }
  const srcs = FIXTURE.sessions.flatMap((s) => s.reports.flatMap((r) => r.images.map((im) => im.src)));
  assert.deepEqual([...new Set(srcs)].sort(), files.map((f) => 'assets/' + f).sort(), 'every image src is one of the committed files');
});

// ---- the view.js kit ---------------------------------------------------------------------------------------------------

test('BriefView.kit hands out the card list\'s own building blocks: same functions, same markup as renderOverview', () => {
  const ctx = load();
  const kit = ctx.BriefView.kit;
  assert.deepEqual(Object.keys(kit).sort(), ['answerBox', 'appliedChip', 'confirmRow', 'copyBtn', 'decisionCard', 'esc', 'flowSvg', 'row', 'sentLine', 'truthChip', 'whereLabel']);
  assert.equal(kit.esc, ctx.BriefView.escapeHtml);
  const old = oldCard(ctx, A, { expanded: { ['detail:' + A.id]: true } });
  const view = { title: A.title, workName: A.workName, paneId: A.paneId, tabLabel: A.tabLabel, tabNumber: A.tabNumber, tabId: A.tabId, sessionId: A.id, __now: NOW };
  const ui = { live: true, answers: {} };
  for (const id of [97, 98]) {
    const d = A.decisions.find((x) => x.id === id);
    const card = kit.decisionCard(d, view, ui, A);
    assert.ok(card.startsWith(`<div class="dcard`) && old.includes(card), 'decision card #' + id + ' is the one renderOverview draws');
  }
  for (const c of A.changes) assert.ok(old.includes(kit.row('chg', c)), 'change row ' + c.text);
  for (const id of [91, 94]) assert.ok(old.includes(kit.sentLine(A.decisions.find((x) => x.id === id))), 'sent line #' + id);
  assert.ok(old.includes(kit.copyBtn(A.cwd)));
  assert.ok(old.includes(kit.whereLabel(A)));
});

// ---- sub-tab bar -------------------------------------------------------------------------------------------------------

test('sub-tab bar: 개요 계획 작업자 결정 보고서 in order with counts from the data; the shown one is selected and drawn alone', () => {
  const ctx = load();
  const expected = {
    [A.id]: { ov: '', plan: '4/8', wk: '3', dec: '2', rep: '3' }, // 4 of 8 plan tasks done, 3 workers, 2 open decisions, 3 reports
    [B.id]: { ov: '', plan: '2/7', wk: '', dec: '', rep: '' }, // no plan: auto's todo counts
    [C.id]: { ov: '', plan: '', wk: '', dec: '', rep: '' },
  };
  for (const s of FIXTURE.sessions) {
    for (const sub of SUB_KEYS) {
      const root = parse(render(ctx, s, sub));
      const tabs = cls(root, 'stabs');
      assert.equal(tabs.length, 1);
      assert.equal(tabs[0].attrs.role, 'tablist');
      const btns = els(tabs[0], (e) => e.tag === 'button');
      assert.deepEqual(btns.map((b) => b.attrs['data-sub']), SUB_KEYS);
      assert.deepEqual(btns.map((b) => b.kids[0].text), ['개요', '계획', '작업자', '결정', '보고서']);
      for (const b of btns) {
        assert.deepEqual([b.attrs.role, b.attrs['data-act'], b.attrs['data-sid']], ['tab', 'sub', s.id]);
        assert.equal(b.attrs['aria-selected'], b.attrs['data-sub'] === sub ? 'true' : 'false');
        assert.equal(hasCls(b, 'on'), b.attrs['data-sub'] === sub);
      }
      const counts = Object.fromEntries(btns.map((b) => [b.attrs['data-sub'], cls(b, 'c').map(text).join('')]));
      assert.deepEqual(counts, expected[s.id], s.id + ' counts');
      const p = panel(root);
      assert.equal(p.attrs['data-sub'], sub);
      assert.equal(p.attrs.role, 'tabpanel');
      assert.equal(btns.find((b) => b.attrs['data-sub'] === 'dec').kids.some((k) => k.tag && hasCls(k, 'o')), s.id === A.id, 'open decisions mark the 결정 count');
      assert.equal(attrs(root, 'data-ann-tray', s.id).length, 1, 'annotate.js tray slot under the sub-tabs');
    }
  }
  // the C-UI shape {sid: key} works too; an unknown key falls back to 개요
  assert.equal(panel(parse(ctx.BriefConvo.render(A, { sub: { [A.id]: 'dec' } }, { now: NOW }))).attrs['data-sub'], 'dec');
  assert.equal(panel(parse(ctx.BriefConvo.render(A, { sub: 'nope' }, { now: NOW }))).attrs['data-sub'], 'ov');
  assert.equal(panel(parse(ctx.BriefConvo.render(A, { sub: { other: 'dec' } }, { now: NOW }))).attrs['data-sub'], 'ov');
});

// ---- header ------------------------------------------------------------------------------------------------------------

test('page header: tab-number icon, label, topic, plan name, time, focus button, the old card header chips and the cwd row', () => {
  const ctx = load();
  const s = clone(A);
  s.chips = ['작업 중', '오래됨', '이 대화는 예전 세대라 실시간 상황판을 맡지 않음 · 대화를 재시작하면 최신 상황판이 열림', '새 칩'];
  s.autoSummary = true;
  s.answerTrimmed = true;
  const root = parse(render(ctx, s, 'ov'));
  const head = block(root, 'head');
  assert.equal(head.tag, 'header');
  const ico = cls(head, 'cv-ico')[0];
  assert.equal(text(ico), '185');
  assert.ok(hasCls(ico, 'sh-h' + ((185 * 5) % 12)), 'the tab bar colour (shell.js hueOf)');
  const h1 = els(head, (e) => e.tag === 'h1')[0];
  assert.equal(text(h1), '상황판제작');
  assert.equal(h1.attrs.title, '상황판제작 #185 · 상황판 v6 대화 페이지');
  assert.equal(flatShown(cls(head, 'cv-sub')[0]), '상황판 v6 대화 페이지[list-todo] briefing-board-redesign');
  assert.equal(shown(cls(head, 'time')[0]), '[clock] ' + hhmm(A.lastActivityAt));
  assert.ok(shown(cls(head, 'cv-cwd')[0]).startsWith('[folder]'), 'the cwd row');
  assert.deepEqual(attrs(head, 'data-act', 'focus').map((b) => b.attrs['data-session']), [A.id]);
  // the chips are the old card header's, stale-generation chip markup included
  const chipsOf = (el) => cls(el, 'chip').map((c) => [c.attrs.class, text(c), c.attrs.style || '', c.attrs.title || '']);
  const oldRoot = parse(oldCard(ctx, s));
  const oldHead = els(oldRoot, (e) => e.tag === 'article')[0].kids.find((k) => k.tag && hasCls(k, 'ch'));
  assert.deepEqual(chipsOf(cls(head, 'cv-chips')[0]), chipsOf(oldHead));
  assert.equal(chipsOf(head).length, 7);
  const cwd = cls(head, 'cv-cwd')[0];
  assert.equal(text(els(cwd, (e) => e.tag === 'code')[0]), A.cwd);
  assert.equal(attrs(cwd, 'data-copy', A.cwd).length, 1);
  // a conversation outside a herdr tab: grey dot, the pane, no focus button
  const loose = parse(render(ctx, { ...clone(C), tabNumber: null, tabId: '' }, 'ov'));
  assert.equal(text(cls(loose, 'cv-ico')[0]), '·');
  assert.equal(text(els(loose, (e) => e.tag === 'h1')[0]), '옛 설치 점검');
  assert.equal(flat(cls(loose, 'cv-sub')[0]), '창 w2-p3');
  assert.equal(attrs(loose, 'data-act', 'focus').length, 0);
});

// ---- 개요 --------------------------------------------------------------------------------------------------------------

test('개요: 지금/다음 callout, flow chips with →, four summary cards with counts that open their sub-tab, then the decisions', () => {
  const ctx = load();
  const root = parse(render(ctx, A, 'ov'));
  const p = panel(root);
  const now = block(p, 'now');
  assert.equal(flat(cls(now, 'cv-hl')[0]), '지금 ' + A.headline);
  assert.equal(flat(cls(now, 'cv-next')[0]), '다음: ' + A.next);
  const flow = block(p, 'flow');
  assert.deepEqual(cls(flow, 'cv-fs').map((f) => [text(f), f.attrs.class]), A.flow.map((f) => [f.label, 'cv-fs is-' + f.state]));
  assert.deepEqual(cls(flow, 'cv-arr').map(text), Array(A.flow.length - 1).fill('→'));
  const card = (k) => {
    const el = block(p, 'card/' + k);
    const go = els(el, (e) => e.tag === 'button')[0];
    assert.deepEqual([go.attrs['data-act'], go.attrs['data-sub'], go.attrs['data-sid']], ['sub', k, A.id]);
    return [flatShown(cls(el, 'scard-l')[0]), flat(cls(el, 'scard-v')[0])];
  };
  // counts from the model's rows: tasks, live workers, decisions and reports
  const running = A.live.workers.filter((w) => w.state === 'running' && !w.stale).length;
  assert.deepEqual(card('plan'), ['[list-todo] 계획', '4/8 · briefing-board-redesign']);
  assert.deepEqual(card('wk'), ['[users] 작업자', `${A.live.workers.length} · ${running}명 진행 중`]);
  assert.deepEqual(card('dec'), ['[bell] 결정', '2 대기 · 3 답함']);
  assert.deepEqual(card('rep'), ['[file-text] 보고서', '3 · ' + A.reports[0].title]);
  assert.equal(cls(p, 'grid4').length, 1);
  // open decision cards with answer boxes (dec/<id>), after the sent lines of answers not yet delivered
  const kit = ctx.BriefView.kit;
  for (const id of [97, 98]) {
    const el = block(p, 'dec/' + id);
    assert.equal(cls(el, 'dcard').length, 1);
    assert.equal(attrs(el, 'data-ans', String(id)).length, 1, 'answer box #' + id);
  }
  assert.deepEqual(cls(p, 'dsent').map((e) => e.attrs['data-block']), ['dec/91', 'dec/94']);
  const html = render(ctx, A, 'ov');
  assert.ok(html.includes(kit.sentLine(A.decisions.find((d) => d.id === 91)).replace(/^<p/, '<p data-block="dec/91"')));
  // #90 was delivered: it shows again only while this page follows its own send
  assert.deepEqual(cls(parse(render(ctx, A, 'ov', { answers: { 90: { phase: 'sent' } } })), 'dsent').map((e) => e.attrs['data-block']), ['dec/90', 'dec/91', 'dec/94']);
  assert.ok(flat(p).includes('질문창으로 옮김 · 여기서 답할 것 없음'));
  // the open-question line is the old card's markup
  const oq = (h) => /<p class="oq">[\s\S]*?<\/p>/.exec(h)[0];
  assert.equal(oq(render(ctx, B, 'ov')), oq(oldCard(ctx, B)));
  assert.ok(marks(oq(render(ctx, B, 'ov'))).includes('답할 창: <code>[app-window] 문서 #184</code> (읽기 전용): 문서 말투는 존댓말로 할까요?'));
});

test('개요: 최근 변화 open and 한 일 closed; kit rows keep their chips and every row with evidence has its path and copy in a collapsed .dt', () => {
  const ctx = load();
  const kit = ctx.BriefView.kit;
  const html = render(ctx, A, 'ov');
  const p = panel(parse(html));
  const secs = cls(p, 'cv-sec');
  const sec = (title) => secs.find((d) => shown(d.kids[0]).startsWith(title));
  assert.ok(Object.hasOwn(sec('[plus] 새로 바뀜').attrs, 'open'), '최근 변화 is open');
  assert.ok(!Object.hasOwn(sec('[check] 한 일').attrs, 'open'), '한 일 is closed');
  assert.equal(flatShown(sec('[plus] 새로 바뀜').kids[0]), '[plus] 새로 바뀜 3');
  assert.equal(flatShown(sec('[check] 한 일').kids[0]), '[check] 한 일 2');
  const rows = [...A.changes.map((c, i) => ['chg', 'change/12/' + i, c]), ...A.done.map((c, i) => ['done', 'done/12/' + i, c])];
  for (const [kind, id, item] of rows) {
    const li = block(p, id);
    assert.ok(hasCls(li, 'row') && hasCls(li, kind), id);
    const base = kit.row(kind, { ...item, evidence: '' }).replace(/^<li/, '<li data-block="' + id + '"');
    const dts = cls(li, 'dt');
    if (item.evidence) {
      assert.ok(html.includes(base.slice(0, -'</li>'.length) + '<details class="dt"'), id + ' is kit.row, then its 상세');
      assert.equal(dts.length, 1, id);
      assert.equal(dts[0].tag, 'details');
      assert.ok(!Object.hasOwn(dts[0].attrs, 'open'), id + ' 상세 starts collapsed');
      assert.equal(text(dts[0].kids[0]), '상세 · 증거 파일');
      const pathEl = cls(dts[0], 'path')[0];
      assert.equal(text(els(pathEl, (e) => e.tag === 'code')[0]), item.evidence);
      assert.equal(attrs(pathEl, 'data-copy', item.evidence).filter((b) => hasCls(b, 'copy')).length, 1, id + ' copy button');
      assert.equal(cls(li, 'path').length, 1, id + ' path only inside the 상세');
    } else {
      assert.ok(html.includes(base), id + ' is kit.row');
      assert.equal(dts.length, 0, id);
    }
  }
  const chip = (id, c) => cls(block(p, id), c).length;
  assert.deepEqual([chip('change/12/0', 't-evidence'), chip('change/12/1', 't-changed'), chip('change/12/2', 't-reported'), chip('done/12/1', 't-unverified')], [1, 1, 1, 1]);
  assert.deepEqual([chip('change/12/0', 'a-candidate'), chip('change/12/2', 'a-none')], [1, 1]);
});

test('개요: 보낸 피드백 lists notes[] with their delivery strings; 이 대화 자료 lists the attachments in C-VM order with copy', () => {
  const ctx = load();
  const p = panel(parse(render(ctx, A, 'ov')));
  const notes = cls(p, 'cv-notes')[0];
  assert.ok(!Object.hasOwn(notes.attrs, 'open'));
  assert.equal(flatShown(notes.kids[0]), '[send] 보낸 피드백 4');
  const CLASS = { '전달됨': 's-done', '전달 중': 'x-busy', '대기: 작업이 끝나면 전달': 'x-stale', '대기: 그 대화가 다시 열리면 전달': 'x-stale' };
  for (const n of A.notes) {
    const li = block(notes, 'note/' + n.key);
    assert.equal(text(cls(li, 'rt')[0]), n.preview);
    assert.equal(shown(cls(li, 'time')[0]), '[clock] ' + hhmm(n.at));
    const chip = cls(li, 'chip')[0];
    assert.equal(shown(chip), n.delivery.replace('⏱', '[clock]'), 'the delivery string, its stopwatch drawn as the clock icon');
    assert.ok(hasCls(chip, CLASS[n.delivery.replace(/ ⏱\d\d:\d\d$/, '')]), n.delivery);
  }
  const none = cls(parse(render(ctx, B, 'ov')), 'cv-notes')[0];
  assert.deepEqual([flatShown(none.kids[0]), text(cls(none, 'cv-empty')[0])], ['[send] 보낸 피드백 0', '아직 보낸 피드백 없음']);
  const att = cls(p, 'att')[0];
  assert.equal(att.tag, 'details');
  assert.ok(!Object.hasOwn(att.attrs, 'open'));
  assert.equal(shown(att.kids[0]), `[paperclip] 이 대화 자료 ${A.attachments.length} (AI에게 "이거 고쳐줘" 할 때 같이 붙음)`);
  const rows = cls(att, 'path');
  assert.deepEqual(rows.map((r) => r.attrs['data-block']), A.attachments.map((_, n) => 'att/' + n), 'C-VM order');
  rows.forEach((r, n) => {
    assert.equal(text(cls(r, 'lb')[0]), A.attachments[n].label);
    assert.equal(text(els(r, (e) => e.tag === 'code')[0]), A.attachments[n].path);
    assert.equal(attrs(r, 'data-copy', A.attachments[n].path).length, 1);
  });
});

// ---- 계획 --------------------------------------------------------------------------------------------------------------

test('계획: the box plan view is BriefPlanView.render output byte for byte inside div.plan-host; no fallback table with a plan', () => {
  const ctx = load();
  const id = A.plan.planId;
  for (const expanded of [{}, { ['plan:' + id]: true }, { ['plan:' + id]: true, ['plan-tasks:' + id]: true, ['plan-out:' + id]: true }]) {
    const html = render(ctx, A, 'plan', { expanded });
    const open = '<div class="plan-host">', close = '</div><!--plan-host-->';
    const inner = html.slice(html.indexOf(open) + open.length, html.indexOf(close));
    assert.ok(html.indexOf(open) > 0 && html.indexOf(close) > 0);
    assert.equal(inner, ctx.BriefPlanView.render(A.plan, NOW, { esc: ctx.BriefView.escapeHtml, expanded }), JSON.stringify(expanded));
    const p = panel(parse(html));
    assert.equal(cls(p, 'cv-fb').length, 0, 'A has todo items but a plan: no fallback');
    assert.ok(!blocks(p).some((b) => b.startsWith('plan/')), 'plan elements keep data-anchor only');
    if (Object.keys(expanded).length) assert.ok(attrs(p, 'data-anchor').length > 0, 'the box view keeps its anchors');
    assert.equal(cls(p, Object.keys(expanded).length ? 'plan-expanded' : 'plan-collapsed').length, 1);
    assert.ok(flat(cls(p, 'cv-auto')[0]).includes('todo 현재: 5. 대화 페이지 모듈 · 다음: 7. 컨트롤러 통합 · 4/12'), 'the old ⚙ 자동 정보 lines');
  }
});

test('계획 without a plan: work name as goal, progress bar and the todo table (#/할 일/상태), rows plan/todo/<i>', () => {
  const ctx = load();
  const p = panel(parse(render(ctx, B, 'plan')));
  const fb = cls(p, 'cv-fb');
  assert.equal(fb.length, 1);
  assert.equal(shown(cls(fb[0], 'cv-goal')[0]), '[target] readme-pass');
  assert.ok(els(fb[0], (e) => e.tag === 'h3').some((h) => text(h) === '할 일 2/7'));
  const bar = cls(fb[0], 'prog')[0];
  assert.deepEqual([bar.attrs.role, bar.attrs['aria-valuenow'], bar.attrs['aria-valuemax']], ['progressbar', '2', '7']);
  assert.equal(bar.kids[0].attrs.style, 'width:29%');
  const table = els(fb[0], (e) => e.tag === 'table')[0];
  assert.deepEqual(els(table, (e) => e.tag === 'th').map(text), ['#', '할 일', '상태']);
  const rows = els(table, (e) => e.tag === 'tr' && e.attrs['data-block']);
  assert.deepEqual(rows.map((r) => r.attrs['data-block']), B.todo.items.map((_, i) => 'plan/todo/' + i));
  assert.deepEqual(rows.map((r) => r.kids.map(shown)), [
    ['1', '열기 절', '[check] 완료'], ['2', '화면 구성 표', '[check] 완료'], ['3', '화면 구성 절', '● 진행 중'], ['4', '주석 보내기 절', '○ 남음'], ['5', '옛 목차 지우기', '– 취소'],
  ]);
  assert.ok(flat(p).includes('외 2개'));
  assert.equal(cls(p, 'plan-host').length, 0);
  // the same conversation with a plan: the plan view, no fallback
  const withPlan = panel(parse(render(ctx, { ...clone(B), plan: clone(A.plan) }, 'plan')));
  assert.deepEqual([cls(withPlan, 'plan-host').length, cls(withPlan, 'cv-fb').length], [1, 0]);
});

test('failure: plan null and no todo shows 이 대화에는 계획이 없어 and does not throw', () => {
  const ctx = load();
  const none = [clone(C), { ...clone(C), plan: null, todo: undefined }, { id: 'bare', plan: null }, { ...clone(B), todo: { items: [], more: 0 }, auto: undefined, workName: '' }, { id: 'named', plan: null, workName: 'named' }];
  for (const s of none) {
    let html;
    assert.doesNotThrow(() => { html = render(ctx, s, 'plan'); });
    const p = panel(parse(html));
    assert.equal(flat(p), '이 대화에는 계획이 없어', s.id);
    assert.equal(cls(p, 'cv-fb').length, 0);
  }
});

test('계획: a conversation running another one\'s plan shows the plan link line and opens the owner', () => {
  const ctx = load();
  const s = { ...clone(C), planLink: { planId: A.plan.planId, ownerId: A.id, source: { slug: 'briefing-board-redesign' }, stage: 'running', goal: A.plan.goal } };
  const html = render(ctx, s, 'plan');
  assert.ok(html.includes(ctx.BriefPlanView.renderLink(s.planLink, { esc: ctx.BriefView.escapeHtml })));
  const p = panel(parse(html));
  assert.deepEqual(attrs(p, 'data-sh', 'open').map((b) => [b.attrs['data-sid'], b.attrs['data-sub']]), [[A.id, 'plan']]);
  assert.ok(!flat(p).includes('이 대화에는 계획이 없어'));
});

// ---- 작업자 ------------------------------------------------------------------------------------------------------------

test('작업자: BriefWorkersView.render output unchanged except one data-block="wk/<id>" per row', () => {
  const ctx = load();
  const expanded = { 'worker:st_01a14958': true };
  const html = render(ctx, A, 'wk', { expanded });
  const p = panel(parse(html));
  const rows = cls(p, 'w-row');
  assert.equal(rows.length, A.live.workers.length);
  for (const r of rows) assert.equal(r.attrs['data-block'], 'wk/' + r.attrs['data-worker']);
  const inner = /<section class="cv-panel"[^>]*>([\s\S]*)<\/section><\/div>$/.exec(html)[1];
  assert.equal(inner.replace(/ data-block="wk\/[^"]*"/g, ''), ctx.BriefWorkersView.render(A.live, WALL, { esc: ctx.BriefView.escapeHtml, expanded }));
  assert.equal(cls(p, 'w-todos').length, 1, 'the todo toggle still expands');
  assert.equal(flat(panel(parse(render(ctx, B, 'wk')))), '작업자 없음');
});

// ---- 결정 --------------------------------------------------------------------------------------------------------------

test('결정: open cards, 보류됨 with 다시 열기, and the 결정 기록 table (# / 질문 / 내 답 / 결과 / 전달)', () => {
  const ctx = load();
  const p = panel(parse(render(ctx, A, 'dec')));
  for (const id of [97, 98]) assert.equal(cls(block(p, 'dec/' + id), 'dcard').length, 1);
  assert.equal(cls(p, 'dsent').length, 0, 'the table carries the delivery here');
  const held = cls(p, 'held-decs')[0];
  assert.equal(flat(held.kids[0]), '보류됨 1개');
  assert.deepEqual(attrs(block(held, 'dec/92'), 'data-act', 'ans-reopen').map((b) => b.attrs['data-id']), ['92']);
  const table = cls(p, 'cv-hist')[0];
  assert.deepEqual(els(table, (e) => e.tag === 'th').map(text), ['#', '질문', '내 답', '결과', '전달']);
  const rows = els(table, (e) => e.tag === 'tr' && e.attrs['data-block']);
  assert.deepEqual(rows.map((r) => r.attrs['data-block']), ['dec/90', 'dec/91', 'dec/94']);
  assert.deepEqual(rows.map((r) => r.kids.map(shown)), [
    ['#90', '알림 띠는 어디에 둘까요?', 'A · 탭 바 위', '레일과 사이드바를 가리지 않음', A.decisions[0].delivery.replace('⏱', '[clock]')],
    ['#91', '사이드바 기본 폭은?', '답글 “260으로 하되 끌어서 바꿀 수 있게 해 줘”', '-', '대기: 작업이 끝나면 전달'],
    ['#94', '시안 v7 주석 창 위치', '답글 “고른 곳 아래, 넘치면 위로”', '-', '질문창에서 답 받음'],
  ]);
  assert.deepEqual(rows.map((r) => cls(r, 'chip')[0].attrs.class), ['chip s-done', 'chip x-stale', 'chip x-info']);
  assert.ok(flat(p).includes('질문창으로 옮김 · 여기서 답할 것 없음'));
  // a delivery proof without a delivery string, an answer without one
  const s = clone(A);
  delete s.decisions[0].delivery;
  s.decisions[1].delivery = '';
  const rows2 = els(cls(panel(parse(render(ctx, s, 'dec'))), 'cv-hist')[0], (e) => e.tag === 'tr' && e.attrs['data-block']);
  assert.deepEqual(rows2.slice(0, 2).map((r) => shown(r.kids[4])), ['전달됨 [clock]' + hhmm(A.decisions[0].receipt.deliveredAt), '전달 기다림']);
  const empty = panel(parse(render(ctx, B, 'dec')));
  assert.deepEqual(empty.kids.map(text), ['답을 기다리는 결정 없음', '결정 기록', '아직 답한 결정 없음']);
});

// ---- 보고서 ------------------------------------------------------------------------------------------------------------

test('보고서: callout header, side-by-side .ropt images with the decision\'s options, 추천 and 이걸로 고르기 (data-dec/data-opt)', () => {
  const ctx = load();
  const p = panel(parse(render(ctx, A, 'rep')));
  assert.deepEqual(cls(p, 'rep').map((r) => r.attrs['data-block']), ['rep/r1', 'rep/r2', 'rep/r3']);
  const r1 = block(p, 'rep/r1');
  assert.equal(flatShown(cls(r1, 'rep-t')[0]), A.reports[0].title + '결정 기다림[clock] ' + hhmm(A.reports[0].at));
  assert.equal(cls(r1, 'chip')[0].attrs.class, 'chip s-needs_decision');
  assert.equal(text(cls(r1, 'rep-sum')[0]), A.reports[0].summary);
  assert.equal(shown(cls(r1, 'rep-dq')[0]), '[bell] #97 상황판 대화 구분은 어느 시안으로 갈까요?');
  assert.equal(shown(cls(r1, 'rep-hint')[0]), '[map-pin] 그림을 누르면 그 자리에 주석이 붙어');
  const d97 = A.decisions.find((d) => d.id === 97);
  const cells = cls(cls(r1, 'rgrid')[0], 'ropt');
  assert.deepEqual(cells.map((c) => c.attrs['data-block']), ['rep/r1/img/0', 'rep/r1/img/1', 'rep/r1/img/2']);
  cells.forEach((c, n) => {
    const im = A.reports[0].images[n];
    const img = els(c, (e) => e.tag === 'img')[0];
    assert.deepEqual([img.attrs.src, img.attrs.alt, img.attrs.loading, img.attrs.width, img.attrs.height], [im.src, im.alt, 'lazy', '200', '125']);
    assert.equal(text(cls(c, 'nm')[0]), im.option + ' · ' + d97.options[im.option].text + (im.option === 'C' ? ' 추천' : ''));
    assert.equal(text(cls(c, 'nt')[0]), d97.options[im.option].consequence);
    assert.equal(hasCls(c, 'rec'), im.option === 'C', 'recommendation C');
    const pick = attrs(c, 'data-act', 'ans-pick');
    assert.equal(pick.length, 1);
    assert.deepEqual([pick[0].tag, pick[0].attrs['data-dec'], pick[0].attrs['data-opt'], text(pick[0])], ['button', '97', im.option, '이걸로 고르기']);
    assert.equal(Object.hasOwn(pick[0].attrs, 'disabled'), false, 'an open decision: the button works');
  });
  // text-only report: one callout and no pin hint; a report of an answered decision (#90, answered A): its button is off
  // with 이미 답했거나 닫힌 결정 and the chosen option is highlighted
  const r2 = block(p, 'rep/r2');
  assert.deepEqual([cls(r2, 'rgrid').length, cls(r2, 'rep-head').length, cls(r2, 'chip')[0].attrs.class, cls(r2, 'rep-hint').length], [0, 1, 'chip x-info', 0]);
  assert.equal(text(cls(r2, 'rep-sum')[0]), A.reports[1].summary);
  const r3 = block(p, 'rep/r3');
  const off = attrs(r3, 'data-act', 'ans-pick');
  assert.deepEqual([cls(r3, 'chip')[0].attrs.class, off.length, Object.hasOwn(off[0].attrs, 'disabled'), off[0].attrs.title, cls(r3, 'ropt').length],
    ['chip s-done', 1, true, '이미 답했거나 닫힌 결정', 1]);
  assert.deepEqual(cls(r3, 'rep-closed').map(text), ['이미 답했거나 닫힌 결정']);
  assert.ok(hasCls(cls(r3, 'ropt')[0], 'chosen'));
  assert.equal(flat(panel(parse(render(ctx, B, 'rep')))), '보고서 없음');
});

test('보고서 이걸로 고르기: the picked option shows the decision answer box\'s own confirm row in place; the send state stays on that option; an answered or closed decision turns every button off with 이미 답했거나 닫힌 결정 and the chosen option is highlighted', () => {
  const ctx = load();
  const kit = ctx.BriefView.kit;
  const CLOSED = '이미 답했거나 닫힌 결정';
  const report = (html) => block(panel(parse(html)), 'rep/r1');
  const cells = (r) => cls(r, 'ropt');
  const picks = (c) => attrs(c, 'data-act', 'ans-pick');
  const off = (r) => cells(r).map((c) => picks(c).map((b) => Object.hasOwn(b.attrs, 'disabled')));
  let r = report(render(ctx, A, 'rep'));
  assert.deepEqual(off(r), [[false], [false], [false]], 'nothing picked: every option can be picked');
  assert.equal(cls(r, 'rep-closed').length, 0);
  // B picked: its button gives way to the confirm row the decision card draws; A and C can still be picked instead
  const answers = { 97: { confirm: { option: 'B' }, phase: '', error: '' } };
  const html = render(ctx, A, 'rep', { answers });
  const row = kit.confirmRow(97, A, { option: 'B' }, 'rep');
  assert.ok(html.includes(row), 'the answer box\'s own confirm row');
  const dc = /<div class="ans-confirm"[\s\S]*?<\/div>/.exec(render(ctx, A, 'dec', { answers }))[0];
  assert.equal(dc.replaceAll('data-where="dc"', 'data-where="rep"'), row, 'the very row of the decision card');
  r = report(html);
  const [ca, cb, cc] = cells(r);
  assert.equal(flatShown(cls(cb, 'ans-confirm')[0]), '[app-window] 상황판제작 #185 대화에 B를 보낼까요?보내기취소');
  assert.deepEqual(attrs(cb, 'data-act', 'ans-send').map((b) => [b.attrs['data-id'], b.attrs['data-where']]), [['97', 'rep']]);
  assert.deepEqual([picks(ca).length, picks(cb).length, picks(cc).length, cls(ca, 'ans-confirm').length], [1, 0, 1, 0]);
  assert.deepEqual(off(r), [[false], [], [false]]);
  // a refusal that can be retried keeps the row, with its error under it
  r = report(render(ctx, A, 'rep', { answers: { 97: { confirm: { option: 'B' }, phase: '', error: 'e1' } } }));
  assert.deepEqual([cls(cells(r)[1], 'ans-confirm').length, cls(cells(r)[1], 'ans-err').map(text)], [1, ['e1']]);
  // sending, sent, refused for good: the state shows on B where 보내기 was pressed, every other button is off, no 보내기 anywhere
  for (const [a, cl, want] of [
    [{ phase: 'sending', confirm: { option: 'B' }, sentOption: 'B' }, 'ans-state', '보내는 중…'],
    [{ phase: 'sent', confirm: null, sentOption: 'B' }, 'ans-state', '보냄 · 전달 상태 기다리는 중…'],
    [{ phase: 'closed', confirm: null, sentOption: 'B', error: CLOSED }, 'ans-err', CLOSED],
  ]) {
    r = report(render(ctx, A, 'rep', { answers: { 97: a } }));
    assert.deepEqual(cls(cells(r)[1], cl).map(text), [want], a.phase);
    assert.deepEqual(off(r), [[true], [], [true]], a.phase + ': nothing to press twice');
    assert.equal(attrs(r, 'data-act', 'ans-send').length, 0, a.phase);
    assert.deepEqual([cls(r, 'chip')[0].attrs.class, cls(r, 'chosen').length], ['chip s-needs_decision', 0], a.phase + ': status and choice stay the model\'s');
  }
  // a reply sent from the decision card (no option of this report): its state shows once, under the header
  r = report(render(ctx, A, 'rep', { answers: { 97: { phase: 'sending', confirm: { text: '답글' }, sentOption: '' } } }));
  assert.deepEqual(cls(r, 'ans-state').map(text), ['보내는 중…']);
  assert.deepEqual(off(r), [[true], [true], [true]]);
  // answered (here or elsewhere): every button off with the note, the chosen option highlighted; a stale confirm shows nothing
  const s = clone(A);
  Object.assign(s.decisions.find((d) => d.id === 97), { answered: true, answer: { option: 'A', text: '', at: NOW } });
  s.reports[0].status = '답함';
  r = report(render(ctx, s, 'rep', { answers }));
  assert.deepEqual(off(r), [[true], [true], [true]]);
  assert.deepEqual(cells(r).map((c) => picks(c)[0].attrs.title), [CLOSED, CLOSED, CLOSED]);
  assert.deepEqual(cls(r, 'rep-closed').map(text), [CLOSED]);
  assert.deepEqual([attrs(r, 'data-act', 'ans-send').length, cls(r, 'ans-confirm').length], [0, 0]);
  assert.deepEqual(cells(r).map((c) => hasCls(c, 'chosen')), [true, false, false]);
  assert.deepEqual(cls(cells(r)[0], 'cv-chosen').map(shown), ['[check] 고른 안']);
  assert.equal(cls(r, 'chip')[0].attrs.class, 'chip s-done');
  // closed without an answer (held, timed out): off with the note, nothing highlighted
  const h = clone(A);
  Object.assign(h.decisions.find((d) => d.id === 97), { closed: true, held: true });
  h.reports[0].status = '참고';
  r = report(render(ctx, h, 'rep'));
  assert.deepEqual([off(r), cls(r, 'rep-closed').map(text), cls(r, 'chosen').length], [[[true], [true], [true]], [CLOSED], 0]);
  // the file page: no buttons and no note; the chosen option is still highlighted
  r = report(render(ctx, s, 'rep', { live: false }));
  assert.deepEqual([attrs(r, 'data-act', 'ans-pick').length, cls(r, 'rep-closed').length, cells(r).map((c) => hasCls(c, 'chosen'))], [0, 0, [true, false, false]]);
  // a hostile tab label and option text stay text in the confirm row and the option card
  const evil = clone(A);
  evil.tabLabel = HOSTILE;
  evil.decisions.find((d) => d.id === 97).options.B.text = HOSTILE;
  r = report(render(ctx, evil, 'rep', { answers }));
  assert.ok(flatShown(cls(r, 'ans-confirm')[0]).includes('[app-window] ' + HOSTILE + ' #185 대화에 B를 보낼까요?'));
  assert.ok(text(cls(cells(r)[1], 'nm')[0]).includes(HOSTILE));
  for (const e of els(r)) for (const k of Object.keys(e.attrs)) assert.ok(!/^on/i.test(k), k);
});

// ---- contracts over every page ---------------------------------------------------------------------------------------

test('every data-block follows the C-BLOCK grammar, is unique on its page, and the pages cover every blockSources key', () => {
  const ctx = load();
  for (const s of FIXTURE.sessions) {
    const drawn = new Set();
    for (const sub of SUB_KEYS) {
      for (const live of [true, false]) {
        const ids = blocks(parse(render(ctx, s, sub, { live })));
        for (const id of ids) assert.match(id, BLOCK, `${s.id} ${sub}: ${id}`);
        assert.equal(new Set(ids).size, ids.length, `${s.id} ${sub}: unique block ids`);
        ids.forEach((id) => drawn.add(id));
      }
    }
    for (const k of Object.keys(s.blockSources)) assert.ok(drawn.has(k), `${s.id}: blockSources ${k} is on a page`);
  }
  const ov = blocks(parse(render(ctx, A, 'ov')));
  assert.deepEqual(ov.slice(0, 7), ['head', 'now', 'flow', 'card/plan', 'card/wk', 'card/dec', 'card/rep']);
});

test('hostile model strings are escaped in text and attributes; images only from assets/<64 hex>.<png|jpg|webp>', () => {
  const ctx = load();
  const s = clone(A);
  const H = HOSTILE;
  Object.assign(s, { title: H, tabLabel: H, headline: H, next: H, workName: H, cwd: 'C:/' + H, chips: [H], paneId: H });
  s.changes[0].text = H; s.changes[0].evidence = 'C:/ev/' + H; s.done[1].text = H;
  s.flow[0].label = H;
  const d = s.decisions.find((x) => x.id === 97);
  d.question = H; d.reason = H; d.options.A.text = H; d.options.B.consequence = H;
  s.decisions.find((x) => x.id === 91).answer.text = H;
  s.notes[0].preview = H; s.notes[1].key = H;
  s.attachments[1] = { label: H, path: 'C:/' + H };
  s.reports[0].title = H; s.reports[0].summary = H; s.reports[0].id = 'r1"><b>';
  const ok = s.reports[0].images[0].src;
  s.reports[0].images[0].alt = H;
  s.reports[0].images[1].src = 'javascript:alert(1)';
  s.reports[0].images[2].src = ok.replace(/\.png$/, '.svg');
  s.reports[2].images[0].src = 'https://evil.example/' + ok;
  s.reports[1].images = [{ src: ok + '" onerror="alert(3)', alt: 'x' }, { src: '../../' + ok, alt: 'y' }, { src: 'assets/' + 'g'.repeat(64) + '.png', alt: 'z' }];
  s.live.workers[0].name = H; s.live.workers[1].id = 'st_1" onclick="alert(4)';
  s.plan.goal = H;
  s.openQuestion = { text: H, at: NOW };
  for (const sub of SUB_KEYS) {
    for (const live of [true, false]) {
      const html = render(ctx, s, sub, { live, expanded: { ['plan:' + s.plan.planId]: true } });
      const root = parse(html); // throws on any unescaped < > or quote
      assert.ok(!/<(?:script|img src=x|textarea)/i.test(html), sub);
      for (const e of els(root)) {
        assert.ok(!['script', 'iframe', 'object', 'embed', 'textarea'].includes(e.tag), sub + ' <' + e.tag + '>');
        for (const k of Object.keys(e.attrs)) assert.ok(!/^on/i.test(k), `${sub}: attribute ${k}`);
        if (e.tag === 'img') assert.match(e.attrs.src, ASSET, sub);
      }
      assert.ok(text(root).includes(H), sub + ': shown as text');
      for (const id of blocks(root)) assert.match(id, BLOCK, sub);
    }
  }
  const ov = parse(render(ctx, s, 'ov'));
  assert.equal(attrs(ov, 'data-copy', 'C:/' + H).length, 2, 'cwd and attachment copy values round-trip');
  assert.equal(els(ov, (e) => e.tag === 'h1')[0].attrs.title, H + ' #185 · ' + H);
  const rep = parse(render(ctx, s, 'rep'));
  assert.deepEqual(els(rep, (e) => e.tag === 'img').map((e) => [e.attrs.src, e.attrs.alt]), [[ok, H]], 'only the valid source is drawn');
  assert.ok(!blocks(rep).some((b) => b.startsWith('rep/r1')), 'a malformed report id gets no block id');
  assert.equal(cls(rep, 'rimg-x').length, 6, 'each refused source leaves a placeholder');
  const rows = cls(parse(render(ctx, s, 'wk')), 'w-row');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.filter((r) => r.attrs['data-worker'] === 'st_1" onclick="alert(4)').map((r) => r.attrs['data-block']), [undefined], 'a worker id outside the grammar gets no block id');
});

test('no element carries an inline text-overflow; convo.css clips nothing with an ellipsis and uses only design tokens', () => {
  const ctx = load();
  for (const s of FIXTURE.sessions) {
    for (const sub of SUB_KEYS) {
      for (const e of attrs(parse(render(ctx, s, sub, { expanded: { ['plan:' + A.plan.planId]: true } })), 'style')) {
        assert.ok(!/text-overflow|ellipsis/i.test(e.attrs.style), `${s.id} ${sub}: ${e.attrs.style}`);
      }
    }
  }
  const css = read('src/page/convo.css');
  assert.ok(!/text-overflow|ellipsis/i.test(css));
  assert.ok(!/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(css), 'colours come from page.css tokens');
  assert.match(css, /--stabs-h:\s*\d+px/, 'annotate.css sticks its tray under --stabs-h');
  assert.match(css, /\.cv-page \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /--cv-fs: var\(--fs-base\)/);
  assert.ok(!/(?<!\()max-width:\s*\d+px/.test(css), 'no fixed max-width (media queries aside): the page takes the full width');
});

test('a model without the C-VM fields (or notes and reports) renders every sub-tab and leaves out only what needs them', () => {
  const ctx = load();
  const strip = (s) => {
    const x = clone(s);
    for (const k of ['alive', 'briefSeq', 'briefPath', 'sessionFile', 'todo', 'attachments', 'blockSources']) delete x[k];
    return x;
  };
  const a = strip(A);
  const ov = panel(parse(render(ctx, a, 'ov')));
  assert.equal(cls(ov, 'att').length, 0, 'no attachments list');
  assert.ok(!blocks(ov).some((b) => /^(?:change|done|att)\//.test(b)), 'no row ids without briefSeq');
  assert.equal(cls(ov, 'row').filter((r) => hasCls(r, 'chg')).length, 3, 'the rows themselves stay');
  assert.equal(cls(ov, 'dt').length, 3, 'with their 상세 paths');
  assert.equal(cls(ov, 'cv-notes').length, 1);
  delete a.notes;
  delete a.reports;
  for (const sub of SUB_KEYS) assert.doesNotThrow(() => parse(render(ctx, a, sub)), sub);
  assert.equal(cls(parse(render(ctx, a, 'ov')), 'cv-notes').length, 0, 'no 보낸 피드백 without notes[]');
  assert.equal(flat(panel(parse(render(ctx, a, 'rep')))), '보고서 없음');
  assert.equal(cls(parse(render(ctx, a, 'rep')), 'c').map(text).join(','), '4/8,3,2', 'no 보고서 count');
  // no todo: the fallback still has the work name and auto's progress, without a table
  const b = panel(parse(render(ctx, strip(B), 'plan')));
  assert.deepEqual([flatShown(cls(b, 'cv-goal')[0]), cls(b, 'prog').length, els(b, (e) => e.tag === 'table').length], ['[target] readme-pass', 1, 0]);
  // the older fixtures (before C-VM, C-NOTE and C-REPORT) render on every sub-tab
  for (const f of ['test/fixtures/view-model.json', 'test/fixtures/view-model-workers.json']) {
    for (const s of JSON.parse(read(f)).sessions) {
      for (const sub of SUB_KEYS) {
        const root = parse(render(ctx, s, sub));
        assert.equal(cls(root, 'att').length, 0);
        for (const id of blocks(root)) assert.match(id, BLOCK, `${f} ${s.id} ${sub}`);
      }
    }
  }
});

test('malformed sessions, decisions, options, reports and rows never throw and never make up a block id', () => {
  const ctx = load();
  const bad = {
    id: 'm1', tabNumber: 'x', briefSeq: 1.5, title: 7, chips: 'no', flow: [null, { label: 3, state: 'weird' }], changes: [null, 5, { text: 'ok' }],
    decisions: [null, 'x', { id: 'NaN', question: 'q' }, { id: 7, options: null, question: 'no options' }, { id: 8, options: { Z: { text: 'z' } }, recommend: 'Z' }],
    reports: [null, { id: 'ok', decisionId: 999, images: [null, { option: 'Z', src: 'assets/' + 'a'.repeat(64) + '.png', w: -1, h: 1e9 }] }, { id: 'ok2', decisionId: 8, images: [{ option: 'Z', src: 'nope' }] }],
    attachments: [null, { path: '' }, { label: 'x', path: 'C:/x' }], notes: [null, { key: 'bad key/' }, { key: 'k1' }],
    todo: { items: 'x', more: -3 }, live: { workers: [null, { id: '' }, { id: 'a b', state: 'running' }] }, plan: 'nope', auto: [], openQuestion: 'x',
  };
  for (const s of [null, undefined, 'x', 5, {}, bad, { ...bad, briefSeq: -1 }, { ...bad, briefSeq: '12' }]) {
    for (const sub of SUB_KEYS) {
      for (const live of [true, false]) {
        let html;
        assert.doesNotThrow(() => { html = ctx.BriefConvo.render(s, { sub, live, wallNow: WALL }, { now: NOW }); }, `${JSON.stringify(s)?.slice(0, 40)} ${sub}`);
        for (const id of blocks(parse(html))) assert.match(id, BLOCK);
      }
    }
  }
  assert.doesNotThrow(() => ctx.BriefConvo.render(A));
  const ov = parse(render(ctx, bad, 'ov'));
  assert.deepEqual(blocks(ov).filter((b) => !/^(?:head|now|flow|card\/)/.test(b)), ['dec/7', 'dec/8', 'note/k1', 'att/2']);
  const rep = parse(render(ctx, bad, 'rep'));
  assert.deepEqual(blocks(rep), ['head', 'rep/ok', 'rep/ok/img/1', 'rep/ok2', 'rep/ok2/img/0']);
  assert.equal(attrs(rep, 'data-act', 'ans-pick').length, 0, 'no option to pick from an unknown decision or option');
  assert.ok(!Object.hasOwn(els(rep, (e) => e.tag === 'img')[0].attrs, 'width'), 'out-of-range sizes are dropped');
});

test('file page: no answer box, pick, focus or reopen control; /decide copy lines and the read-only note instead', () => {
  const ctx = load();
  for (const sub of SUB_KEYS) {
    const html = render(ctx, A, sub, { live: false });
    assert.ok(!/data-act="(?:ans-[a-z]+|focus)"|class="ans-box"/.test(html), sub);
  }
  const ov = render(ctx, A, 'ov', { live: false });
  assert.ok(ov.includes('data-copy="/decide 97C"') && ov.includes('data-copy="/decide 98A"'));
  assert.ok(ov.includes('이 페이지는 보기 전용입니다 - 답은 아무 대화창에 /decide 로, 또는 실시간 상황판에서'));
  assert.equal(cls(parse(ov), 'dsent').length, 0, 'sent lines follow this page\'s own sends: live only');
  assert.ok(!render(ctx, A, 'ov').includes('이 페이지는 보기 전용입니다'));
});

test('sections take the owner\'s open/closed toggles from ui.expanded (cv:<sid>:<part>), else their defaults', () => {
  const ctx = load();
  const key = (part) => 'cv:' + A.id + ':' + part;
  const opened = (root) => Object.fromEntries(attrs(root, 'data-open-key').map((e) => [e.attrs['data-open-key'], Object.hasOwn(e.attrs, 'open')]));
  const def = opened(parse(render(ctx, A, 'ov')));
  assert.deepEqual([def[key('chg')], def[key('done')], def[key('notes')], def[key('att')], def[key('dt/change/12/0')]], [true, false, false, false, false]);
  const ui = { expanded: { [key('chg')]: false, [key('done')]: true, [key('att')]: true, [key('dt/change/12/0')]: true, [key('notes')]: 'yes' } };
  const got = opened(parse(render(ctx, A, 'ov', ui)));
  assert.deepEqual([got[key('chg')], got[key('done')], got[key('notes')], got[key('att')], got[key('dt/change/12/0')]], [false, true, false, true, true]);
});

test('counts come from the rows themselves, not from summary fields', () => {
  const ctx = load();
  const s = clone(A);
  s.auto.workers = { running: 99, done: 99, error: 99 };
  s.auto.todoDone = 11; // a plan exists: its tasks count
  s.plan.stageNote = '12개 중 12개 끝';
  const p = panel(parse(render(ctx, s, 'ov')));
  assert.equal(flat(cls(block(p, 'card/wk'), 'scard-v')[0]), '3 · 1명 진행 중');
  assert.equal(flat(cls(block(p, 'card/plan'), 'scard-v')[0]), '4/8 · briefing-board-redesign');
  s.live.workers[0].stale = true; // unresponsive is not 진행 중 (workers-view.js summary)
  assert.equal(flat(cls(block(panel(parse(render(ctx, s, 'ov'))), 'card/wk'), 'scard-v')[0]), '3 · 0명 진행 중');
});

test('mobile page padding stays within 12-16 px (convo.css max-width 599px --cv-pad-x)', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/page/convo.css', import.meta.url), 'utf8');
  const m = /@media \(max-width: 599px\) \{[^}]*--cv-pad-x:\s*(\d+)px/.exec(css);
  assert.ok(m, 'mobile --cv-pad-x rule');
  const px = Number(m[1]);
  assert.ok(px >= 12 && px <= 16, 'mobile padding ' + px + 'px');
});

test('C-HOLD: 보류 on every open decision in 개요, 결정 and 보고서, its confirm row in place, held ones only under 보류됨; none on the file page', () => {
  const ctx = load();
  const holdIds = (html, where) => [...html.matchAll(new RegExp('data-act="ans-hold" data-id="(\\d+)" data-where="' + where + '"', 'g'))].map((m) => Number(m[1]));
  for (const sub of ['ov', 'dec']) assert.deepEqual(holdIds(render(ctx, A, sub), 'dc'), [97, 98], sub + ': every open decision card, never the held #92');
  assert.deepEqual(holdIds(render(ctx, A, 'rep'), 'rep'), [97], '보고서: the report linked to open #97');
  const Q = '[app-window] 상황판제작 #185 대화의 #97를 보류할까요? 대화는 다시 묻지 않아요';
  const answers = { 97: { open: false, draft: '', confirm: { hold: true }, phase: '', error: '' } };
  for (const [sub, where] of [['ov', 'dc'], ['dec', 'dc'], ['rep', 'rep']]) {
    const html = render(ctx, A, sub, { answers });
    assert.ok(marks(html).includes(Q), sub + ': the hold confirm row');
    assert.ok(html.includes('data-act="ans-send" data-id="97" data-where="' + where + '">보류</button>'), sub + ': 보류 sends');
    assert.ok(html.includes('data-act="ans-cancel" data-id="97" data-where="' + where + '">취소</button>'), sub + ': 취소');
    assert.ok(!/를 보낼까요\?/.test(html), sub + ': the answer-only confirm row is not drawn for a hold');
    assert.ok(!html.includes('undefined'));
  }
  for (const sub of ['ov', 'dec', 'rep']) assert.ok(!render(ctx, A, sub, { live: false }).includes('data-act="ans-hold"'), sub + ': file page has no 보류');
  const dec = render(ctx, A, 'dec');
  assert.equal((dec.match(/data-act="ans-reopen" data-id="92"/g) || []).length, 1, '#92 sits under 보류됨 with 다시 열기');
});
