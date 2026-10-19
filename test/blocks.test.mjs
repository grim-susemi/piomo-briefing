// Report blocks (src/page/blocks.js, board-ui-polish todo 8): each kind drawn natively with escaped text only, the C-BLOCK
// ids rep/<id>/blk/<n>, the checklist's ticks in this browser only (localStorage, never a request), and the compare block's
// 이걸로 고르기 through the decision answer box's own confirm row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportBlocks } from './fixtures/report-blocks.mjs';
import { makeController, memoryStorage } from './fixtures/controller-dom.mjs';
import { pageHtml } from '../src/render.mjs';
import { validateBrief } from '../src/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const clone = (v) => JSON.parse(JSON.stringify(v));
const FIXTURE = JSON.parse(read('test/fixtures/view-model-board.json'));
const NOW = FIXTURE.generatedAt;
const A = FIXTURE.sessions[0]; // open decision #97: options A/B/C, recommend C
const SID = A.id;
const MODULES = ['icons', 'view', 'plan-view', 'workers-view', 'blocks', 'convo-view']; // render.mjs PAGE_JS order
const HOSTILE = '<img src=x onerror="alert(1)"></svg><script>alert(2)</script>javascript:alert(3)\'`&';
const CLOSED = '이미 답했거나 닫힌 결정';
const NBSP = '\u00a0';

function load() {
  const ctx = vm.createContext({});
  for (const m of MODULES) vm.runInContext(read(`src/page/${m}.js`), ctx, { filename: m + '.js' });
  assert.equal(typeof ctx.BriefBlocks?.render, 'function', 'blocks.js defines BriefBlocks');
  return ctx;
}
// one report (id rb) carrying the six kinds of test/fixtures/report-blocks.mjs, its compare linked to #97 (the stored shape:
// decisionIndex resolved to decision)
function session(blocks = reportBlocks(), extra = {}) {
  const s = clone(A);
  const list = blocks.map((b) => {
    if (!b || b.kind !== 'compare' || b.decisionIndex === undefined) return b;
    const { decisionIndex, ...rest } = b;
    return { ...rest, decision: 97 };
  });
  s.reports = [{ id: 'rb', title: '블록 보고서', summary: '', at: NOW, decisionId: null, status: '참고', images: [], blocks: list, ...extra }];
  return s;
}
function render(ctx, s, ui = {}, extra = {}) {
  return ctx.BriefConvo.render(s, { sub: 'rep', live: true, expanded: {}, answers: {}, ...ui }, { now: NOW, ...extra });
}

// ---- a strict parser: double-quoted attributes (SVG camelCase too), escaped text; anything else throws --------------------
const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'wbr', 'source', 'col', 'area']);
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`' };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, (e) => ENT[e]);
function parse(html) {
  const root = { tag: '#root', attrs: {}, kids: [], parent: null };
  const TOKEN = /<!--[\s\S]*?-->|<\/([a-z][a-z0-9]*)>|<([a-z][a-z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9-]*(?:="[^"<>]*")?)*)\s*>|[^<]+/y;
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
      for (const a of m[3].matchAll(/([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/g)) {
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
const tags = (n, t) => els(n, (e) => e.tag === t);
const text = (n) => (n.text !== undefined ? n.text : (n.kids || []).map(text).join(''));
const flat = (n) => text(n).replace(/\s+/g, ' ').trim();
const figures = (html) => cls(parse(html), 'rbk');
const fig = (html, n) => { const hit = figures(html).filter((f) => f.attrs['data-block'] === 'rep/rb/blk/' + n); assert.equal(hit.length, 1, 'block ' + n); return hit[0]; };
const meta = (f) => text(cls(f, 'rbk-m')[0] || { text: '' });

test('six kinds: one <figure> each with its C-BLOCK id rep/<id>/blk/<n>, a caption and its native markup', () => {
  const ctx = load();
  const s = session();
  const html = render(ctx, s);
  assert.deepEqual(figures(html).map((f) => [f.attrs['data-block'], f.attrs.class]), [
    ['rep/rb/blk/0', 'rbk rbk-table'], ['rep/rb/blk/1', 'rbk rbk-bars'], ['rep/rb/blk/2', 'rbk rbk-kv'],
    ['rep/rb/blk/3', 'rbk rbk-flow'], ['rep/rb/blk/4', 'rbk rbk-checklist'], ['rep/rb/blk/5', 'rbk rbk-compare']]);
  for (const f of figures(html)) assert.equal(f.kids[0].tag, 'figcaption', 'the caption comes first');
  // table: <table> with its columns and cells; a column of numbers only is right-aligned (class num)
  const t = fig(html, 0);
  assert.deepEqual([text(cls(t, 'rbk-h')[0]), meta(t)], ['표', '1줄']);
  assert.deepEqual(tags(t, 'th').map((e) => [text(e), e.attrs.class ?? '']), [['항목', ''], ['값', 'num']]);
  assert.deepEqual(tags(t, 'td').map((e) => [text(e), e.attrs.class ?? '', e.attrs['data-label']]), [['문자', '', '항목'], ['12', 'num', '값']]);
  // bars: label, our own SVG bar (a zero value draws only the track) and the value with its unit
  const b = fig(html, 1);
  assert.deepEqual([meta(b), cls(b, 'bar-r').length, text(cls(b, 'bar-l')[0]), text(cls(b, 'bar-n')[0])], ['단위' + NBSP + '개', 1, '완료', '0 개']);
  assert.deepEqual(tags(b, 'rect').map((r) => r.attrs.class), ['bar-bg']);
  // kv: a <dl>
  assert.deepEqual(tags(fig(html, 2), 'dt').map(text).concat(tags(fig(html, 2), 'dd').map(text)), ['상태', '진행']);
  // flow: the SVG (one image, named by every step and its state) and the native step nodes
  const f = fig(html, 3);
  assert.equal(meta(f), '1/2' + NBSP + '끝');
  const box = cls(f, 'flowbox')[0];
  assert.deepEqual([box.attrs.role, box.attrs['aria-label']], ['img', '단계 흐름: 시작, 다음 (1/2 끝)']);
  assert.deepEqual(tags(box, 'rect').map((r) => r.attrs.class), ['f-done', 'f-todo']);
  assert.deepEqual(tags(f, 'li').map((li) => [li.attrs.class, flat(li)]), [['fs-done', '1시작끝'], ['fs-todo', '2다음']]);
  // checklist: a checkbox per item keyed omo-briefing.check.<sessionId>.<reportId>.<itemId>
  const c = fig(html, 4);
  assert.equal(meta(c), '0/1 확인 · 이 브라우저에만' + NBSP + '저장');
  assert.deepEqual(tags(c, 'input').map((i) => [i.attrs.type, i.attrs.value, i.attrs['data-check-key'], Object.hasOwn(i.attrs, 'checked')]),
    [['checkbox', 'check-1', `omo-briefing.check.${SID}.rb.check-1`, false]]);
  // compare: the decision's options side by side, the recommended one (C) highlighted, 이걸로 고르기 per option
  const k = fig(html, 5);
  assert.equal(meta(k), '#97 결정과' + NBSP + '연결');
  const d97 = A.decisions.find((d) => d.id === 97);
  const head = tags(cls(k, 'rbk-cmp')[0], 'th').filter((e) => e.attrs.scope === 'col');
  assert.deepEqual(head.map((e) => [e.attrs.class ?? '', flat(e)]), [['', '항목'], ['opt', 'A' + d97.options.A.text], ['opt', 'B' + d97.options.B.text],
    ['opt rec', 'C' + d97.options.C.text + ' 추천']]);
  assert.deepEqual(tags(cls(k, 'rbk-cmp')[0], 'tbody')[0].kids[0].kids.map((e) => [e.tag, text(e), e.attrs.class ?? '']),
    [['th', '비용', ''], ['td', '낮음', ''], ['td', '높음', ''], ['td', '중간', 'rec']]);
  const picks = els(k, (e) => e.attrs['data-act'] === 'ans-pick');
  assert.equal(picks.length, 6, 'one in the table, one in each phone card');
  for (const p of picks) {
    assert.deepEqual([p.tag, p.attrs['data-dec'], p.attrs['data-where'], p.attrs['aria-pressed'], text(p), Object.hasOwn(p.attrs, 'disabled')], ['button', '97', 'blk', 'false', '이걸로 고르기', false]);
  }
  assert.deepEqual(picks.map((p) => p.attrs['data-opt']), ['A', 'B', 'C', 'A', 'B', 'C']);
  assert.deepEqual(cls(k, 'cmpc').map((e) => [e.attrs.class, flat(cls(e, 'cmpc-h')[0]), tags(e, 'dt').map(text), tags(e, 'dd').map(text)]),
    [['cmpc', 'A' + d97.options.A.text, ['비용'], ['낮음']], ['cmpc', 'B' + d97.options.B.text, ['비용'], ['높음']], ['cmpc rec', 'C' + d97.options.C.text + ' 추천', ['비용'], ['중간']]]);
});

test('hostile strings (<img onerror>, </svg>, javascript:) in every field render as text: no element, attribute, handler or URL comes from the model', () => {
  const ctx = load();
  const H = HOSTILE, SHORT = '</svg><b>'; // short enough for the SVG flow's boxes
  const s = session([
    { kind: 'table', title: H, columns: [H, 'n'], rows: [[H, 1], ['x', 2]] },
    { kind: 'bars', title: H, unit: H, items: [{ label: H, value: 3 }, { label: SHORT, value: 1 }] },
    { kind: 'kv', title: H, items: [{ key: H, value: H }] },
    { kind: 'flow', title: H, steps: [{ label: SHORT, state: 'done' }, { label: 'javascript:' }] },
    { kind: 'flow', steps: [{ label: H }, { label: 'b' }] },
    { kind: 'checklist', title: H, items: [{ id: 'ok-1', text: H }, { id: '"><img src=x onerror=alert(1)>', text: H }] },
    { kind: 'compare', title: H, decision: 97, rows: [{ label: H, A: H, B: SHORT, C: 'javascript:alert(1)' }] },
  ]);
  const d = s.decisions.find((x) => x.id === 97);
  d.options.A.text = H;
  s.tabLabel = H;
  for (const live of [true, false]) {
    for (const answers of [{}, { 97: { confirm: { option: 'A' }, phase: '', error: H } }]) {
      const html = render(ctx, s, { live, answers });
      const start = html.indexOf('<div class="rbks">');
      const blocksHtml = html.slice(start, html.indexOf('</section>', start)); // the blocks end the report's <section>
      assert.ok(!/<(?:img|script)/i.test(blocksHtml) && !blocksHtml.includes('</svg><b>'), 'no raw markup from the model');
      const root = parse(blocksHtml); // throws on any unescaped < > or quote
      for (const e of els(root)) {
        assert.ok(!['img', 'script', 'iframe', 'object', 'embed', 'a', 'textarea', 'style', 'foreignobject', 'image'].includes(e.tag), '<' + e.tag + '>');
        for (const [k, v] of Object.entries(e.attrs)) {
          assert.ok(!/^on/i.test(k), 'attribute ' + k);
          if (k === 'href') assert.match(v, /^#i-[a-z0-9-]+$/, 'only the icon sprite is referenced');
          assert.ok(k !== 'src' && k !== 'style' && k !== 'xlink:href', 'attribute ' + k);
        }
      }
      // the SVGs are ours: one per bar row, the flow with short labels, and the icons of the confirm row
      const svgs = tags(root, 'svg').filter((e) => !hasCls(e, 'ic'));
      assert.deepEqual(svgs.map((e) => e.attrs.class), ['bar-s', 'bar-s', 'flow flow-wide']);
      assert.equal(figures(blocksHtml).length, 7);
      const all = text(root);
      for (const want of [H, SHORT, 'javascript:alert(1)']) assert.ok(all.includes(want), 'shown as text: ' + want);
      assert.equal(tags(root, 'input').length, 1, 'a checklist item id outside a-z0-9_- is not drawn');
      if (live && answers[97]) assert.ok(all.includes(H + ' #185 대화에 A를 보낼까요?'), 'the confirm row names the tab as text');
    }
  }
});

test('flow: view.js flowSvg with bare labels (the approved look) while every label fits a box (14 characters), doing/blocked named in the caption; else native step nodes at every width', () => {
  const ctx = load();
  const steps = [{ label: '조사', state: 'done' }, { label: '구현', state: 'doing' }, { label: '배포', state: 'blocked' }, { label: '검증', state: 'todo' }];
  let f = fig(render(ctx, session([{ kind: 'flow', steps }])), 0);
  assert.deepEqual(tags(cls(f, 'flowbox')[0], 'text').map(text), ['조사', '구현', '배포', '검증']);
  assert.deepEqual(tags(cls(f, 'flowbox')[0], 'rect').map((r) => r.attrs.class), ['f-done', 'f-doing', 'f-blocked', 'f-todo']);
  assert.equal(meta(f), '1/4 끝 · 진행 중: 구현 · 막힘:' + NBSP + '배포', 'the state is never colour alone');
  assert.equal(cls(f, 'flowbox')[0].attrs['aria-label'], '단계 흐름: 조사, 구현, 배포, 검증 (1/4 끝 · 진행 중: 구현 · 막힘: 배포)');
  assert.deepEqual(cls(f, 'fs-s').map(text), ['끝', '진행 중', '막힘'], 'and a word on each step node');
  for (const [label, svgShown] of [['열네 글자인 단계 이름이다', true], ['열다섯 글자인 단계 이름이다', false]]) {
    assert.equal(Array.from(label).length <= 14, svgShown, label);
    f = fig(render(ctx, session([{ kind: 'flow', steps: [{ label, state: 'doing' }, { label: '끝' }] }])), 0);
    assert.equal(cls(f, 'flowbox').length, svgShown ? 1 : 0, label);
    assert.equal(cls(f, 'flow-steps')[0].attrs.class, svgShown ? 'flow-steps' : 'flow-steps fs-all', label);
    assert.equal(meta(f), svgShown ? '0/2 끝 · 진행 중: ' + label : '0/2' + NBSP + '끝', 'native step nodes carry their own words');
    assert.deepEqual(tags(f, 'li').map((li) => text(cls(li, 'fs-t')[0])), [label, '끝']);
  }
  // view.js itself is untouched: its flow draws the bare labels
  assert.match(ctx.BriefView.kit.flowSvg(steps, false), /<rect class="f-done" x="1" y="1" width="72" height="30" rx="6"><\/rect><text x="37" y="20" text-anchor="middle">조사<\/text>/);
});

test('compare: 이걸로 고르기 shows the decision answer box\'s own confirm row; sending, sent, answered and the file page; an unknown decision', () => {
  const ctx = load();
  const kit = ctx.BriefView.kit;
  const s = session();
  const cmp = (html) => fig(html, 5);
  const picks = (f) => els(f, (e) => e.attrs['data-act'] === 'ans-pick');
  // B picked: the confirm row of the decision card under the comparison, B pressed (table and card), nothing else changes
  const answers = { 97: { confirm: { option: 'B' }, phase: '', error: '' } };
  let html = render(ctx, s, { answers });
  assert.ok(html.includes(kit.confirmRow(97, s, { option: 'B' }, 'blk')), 'the answer box\'s own confirm row');
  let f = cmp(html);
  assert.deepEqual(picks(f).map((p) => p.attrs['aria-pressed']), ['false', 'true', 'false', 'false', 'true', 'false']);
  assert.deepEqual(els(f, (e) => e.attrs['data-act'] === 'ans-send').map((e) => [e.attrs['data-id'], e.attrs['data-where']]), [['97', 'blk']]);
  assert.equal(flat(cls(f, 'ans-confirm')[0]).endsWith('B를 보낼까요?보내기취소'), true);
  // a retryable refusal keeps the row with its error under it
  f = cmp(render(ctx, s, { answers: { 97: { confirm: { option: 'B' }, phase: '', error: 'e1' } } }));
  assert.deepEqual([cls(f, 'ans-confirm').length, cls(f, 'ans-err').map(text)], [1, ['e1']]);
  // sending / sent / refused for good: the state under the comparison, every button off, no 보내기
  for (const [a, cl, want] of [
    [{ phase: 'sending', confirm: { option: 'B' }, sentOption: 'B' }, 'ans-state', '보내는 중…'],
    [{ phase: 'sent', confirm: null, sentOption: 'B' }, 'ans-state', '보냄 · 전달 상태 기다리는 중…'],
    [{ phase: 'closed', confirm: null, sentOption: 'B', error: CLOSED }, 'ans-err', CLOSED],
  ]) {
    f = cmp(render(ctx, s, { answers: { 97: a } }));
    assert.deepEqual(cls(f, cl).map(text), [want], a.phase);
    assert.ok(picks(f).every((p) => Object.hasOwn(p.attrs, 'disabled')), a.phase + ': nothing to press twice');
    assert.equal(els(f, (e) => e.attrs['data-act'] === 'ans-send').length, 0);
  }
  // the report's own decision: its state line is the report header's, never drawn twice
  const linked = session(undefined, { decisionId: 97, status: '결정 기다림' });
  html = render(ctx, linked, { answers: { 97: { phase: 'sending', confirm: { option: 'B' }, sentOption: 'B' } } });
  assert.equal((html.match(/보내는 중…/g) || []).length, 1, 'one state line for the decision');
  assert.equal(cls(cmp(html), 'ans-state').length, 0);
  // answered (A): every button off with the note, A marked 고른 안 in the table and its card
  const done = clone(s);
  Object.assign(done.decisions.find((d) => d.id === 97), { answered: true, answer: { option: 'A', text: '', at: NOW } });
  f = cmp(render(ctx, done, { answers }));
  assert.ok(picks(f).every((p) => Object.hasOwn(p.attrs, 'disabled') && p.attrs.title === CLOSED));
  assert.deepEqual(cls(f, 'rep-closed').map(text), [CLOSED]);
  assert.deepEqual(cls(f, 'chosen').map((e) => e.tag), ['th', 'div']);
  assert.deepEqual(cls(f, 'cv-chosen').map(text), [' 고른 안', ' 고른 안']);
  assert.equal(cls(f, 'ans-confirm').length, 0, 'a stale confirm shows nothing');
  // the file page: no buttons and no footer row; the recommendation is still highlighted
  f = cmp(render(ctx, s, { live: false }));
  assert.deepEqual([picks(f).length, tags(f, 'tfoot').length, els(f, (e) => hasCls(e, 'rec')).length > 0], [0, 0, true]);
  // a decision this conversation does not have: the rows' own columns, no buttons, said so
  const lost = session([{ kind: 'compare', decision: 999, rows: [{ label: '비용', A: '1', B: '2' }] }]);
  f = fig(render(ctx, lost), 0);
  assert.deepEqual([meta(f), picks(f).length, tags(cls(f, 'rbk-cmp')[0], 'th').filter((e) => e.attrs.scope === 'col').map(flat)],
    ['연결된 결정' + NBSP + '없음', 0, ['항목', 'A', 'B']]);
});

test('checklist: ticks come from ctx.checked by their exact key; a malformed report id or a missing session id cannot be ticked', () => {
  const ctx = load();
  const asked = [];
  const checked = (key) => { asked.push(key); return key === `omo-briefing.check.${SID}.rb.b`; };
  const s = session([{ kind: 'checklist', items: [{ id: 'a', text: '하나' }, { id: 'b', text: '둘' }] }]);
  let f = fig(render(ctx, s, {}, { checked }), 0);
  assert.deepEqual(asked, [`omo-briefing.check.${SID}.rb.a`, `omo-briefing.check.${SID}.rb.b`]);
  assert.deepEqual(tags(f, 'input').map((i) => Object.hasOwn(i.attrs, 'checked')), [false, true]);
  assert.equal(meta(f), '1/2 확인 · 이 브라우저에만' + NBSP + '저장');
  assert.equal(ctx.BriefBlocks.checkKey(SID, 'rb', 'b'), `omo-briefing.check.${SID}.rb.b`);
  // no report id of the grammar: no block id, nothing to key the tick by
  const bad = session([{ kind: 'checklist', items: [{ id: 'a', text: '하나' }] }], { id: 'Bad id' });
  const html = render(ctx, bad, {}, { checked: () => true });
  f = figures(html)[0];
  assert.equal(Object.hasOwn(f.attrs, 'data-block'), false);
  assert.deepEqual(tags(f, 'input').map((i) => [Object.hasOwn(i.attrs, 'disabled'), i.attrs['data-check-key'], Object.hasOwn(i.attrs, 'checked')]), [[true, undefined, false]]);
  // a session without an id: the same
  const anon = session([{ kind: 'checklist', items: [{ id: 'a', text: '하나' }] }]);
  anon.id = '';
  assert.ok(tags(figures(render(ctx, anon, {}, { checked: () => true }))[0], 'input').every((i) => Object.hasOwn(i.attrs, 'disabled')));
});

test('malformed blocks never throw: unknown kinds and non-objects are left out but keep their index; a report without blocks draws none', () => {
  const ctx = load();
  const s = session([null, { kind: 'chart' }, { kind: 'constructor' }, 'x', { kind: 'kv', items: [null, { key: 1, value: 2 }] },
    { kind: 'table', columns: 'x', rows: [null, ['a']] }, { kind: 'bars', items: [{ label: 'n', value: -1 }, { label: 'm', value: Infinity }] },
    { kind: 'flow', steps: [{ label: 'a', state: 'weird' }, null] }, { kind: 'compare', decision: '97', rows: [null] }]);
  let html;
  assert.doesNotThrow(() => { html = render(ctx, s); });
  assert.deepEqual(figures(html).map((f) => f.attrs['data-block']), ['rep/rb/blk/4', 'rep/rb/blk/5', 'rep/rb/blk/6', 'rep/rb/blk/7', 'rep/rb/blk/8']);
  assert.deepEqual(tags(fig(html, 7), 'li').map((li) => li.attrs.class), ['fs-todo'], 'an unknown state is a todo step');
  assert.equal(cls(fig(html, 6), 'bar-r').length, 0, 'negative and infinite values are not drawn');
  // no float noise (15 significant digits), and a cell that is no text or number is empty
  const n = render(ctx, session([{ kind: 'bars', items: [{ label: 'f', value: 0.1 + 0.2 }] }, { kind: 'table', columns: ['a', 'b'], rows: [[6 * 123.4, {}]] }]));
  assert.equal(text(cls(fig(n, 0), 'bar-n')[0]), '0.3');
  assert.deepEqual(tags(fig(n, 1), 'td').map(text), ['740.4', '']);
  const none = session([]);
  assert.equal(render(ctx, none).includes('class="rbks"'), false);
  delete none.reports[0].blocks;
  assert.equal(render(ctx, none).includes('class="rbks"'), false);
  assert.equal(ctx.BriefBlocks.render(null, null), '');
});

test('numbers the schema accepts show exactly when integers (2^53-1, 1000000000000001, Number.MAX_VALUE, -0) and without float noise otherwise (5e-324, 0.1+0.2, 6*123.4): never Infinity; the column stays right-aligned, every bar width finite', () => {
  const ctx = load();
  const values = [Number.MAX_SAFE_INTEGER, 1000000000000001, Number.MAX_VALUE, Number.MIN_VALUE, -0, 0.1 + 0.2, 6 * 123.4];
  const shown = ['9007199254740991', '1000000000000001', '1.7976931348623157e+308', '5e-324', '0', '0.3', '740.4'];
  const blocks = [{ kind: 'table', columns: ['값'], rows: values.map((v) => [v]) }, { kind: 'bars', items: values.map((value, i) => ({ label: 'v' + i, value })) }];
  const v = validateBrief({ title: '숫자', status: 'in_progress', headline: '숫자', next: '', changes: [], done: [], decisions: [], reports: [{ id: 'rb', title: '숫자', images: [], blocks }] }, { sessionId: SID });
  assert.deepEqual([v.ok, v.errors], [true, []], 'the schema accepts every value');
  const html = render(ctx, session(blocks));
  const t = fig(html, 0), b = fig(html, 1);
  assert.deepEqual(tags(t, 'td').map((td) => [text(td), td.attrs.class]), shown.map((s) => [s, 'num']));
  assert.equal(tags(t, 'th')[0].attrs.class, 'num', 'a column of numbers only is right-aligned');
  assert.deepEqual(cls(b, 'bar-n').map(text), shown);
  // the largest value is the full bar, a positive value too small to scale keeps the 0.5% sliver, -0 draws only the track
  assert.deepEqual(cls(b, 'bar-r').map((li) => (tags(li, 'rect').find((r) => r.attrs.class === 'bar-v') || { attrs: {} }).attrs.width ?? null),
    ['0.5%', '0.5%', '100%', '0.5%', null, '0.5%', '0.5%']);
});

// ---- page.js: the checklist tick in localStorage only -----------------------------------------------------------------

function boardModel(seq, s) { return { seq, gen: null, generatedAt: NOW, sessions: [s] }; }
function openReport(e, s) {
  e.page.receive(boardModel(1, s));
  e.page.open(s.id, 'rep');
  return e.app.querySelector('#main');
}
const box = (main) => main.querySelectorAll('input').find((i) => i.getAttribute('data-check-key'));

test('page.js: a tick is stored under omo-briefing.check.<sessionId>.<reportId>.<itemId> in localStorage only (no request), counts in place, survives a re-render and a reload', () => {
  const store = memoryStorage();
  const s = session([{ kind: 'checklist', items: [{ id: 'one', text: '하나' }, { id: 'two', text: '둘' }] }]);
  const key = `omo-briefing.check.${SID}.rb.one`;
  const e = makeController({ localStorage: store, modules: ['icons', ...MODULES.slice(1), 'shell', 'annotate'] });
  let main = openReport(e, s);
  const requests = e.fetches.length;
  let input = box(main);
  assert.equal(input.getAttribute('data-check-key'), key);
  input.checked = true;
  e.fire(input, 'change');
  assert.equal(store.getItem(key), '1');
  assert.equal(main.querySelector('.rbk-m').textContent, '1/2 확인 · 이 브라우저에만' + NBSP + '저장');
  assert.equal(e.fetches.length, requests, 'nothing is sent');
  // a focused checkbox is no typing: the next model applies at once and the tick is drawn from the browser again
  input.focus();
  e.page.receive(boardModel(2, s));
  e.advance(600);
  assert.equal(e.page.state.seq, 2, 'the update was not held for the focused checkbox');
  assert.equal(e.badge.hidden, true);
  input = box(main);
  assert.equal(input.hasAttribute('checked'), true, 'the re-render keeps the tick');
  // a reload: a new page on the same browser storage
  const again = makeController({ localStorage: store, modules: ['icons', ...MODULES.slice(1), 'shell', 'annotate'] });
  main = openReport(again, s);
  input = box(main);
  assert.equal(input.hasAttribute('checked'), true, 'the reload keeps the tick');
  assert.equal(main.querySelector('.rbk-m').textContent, '1/2 확인 · 이 브라우저에만' + NBSP + '저장');
  input.checked = false;
  again.fire(input, 'change');
  assert.equal(store.getItem(key), null, 'unticked: the key is removed');
  assert.equal(main.querySelector('.rbk-m').textContent, '0/2 확인 · 이 브라우저에만' + NBSP + '저장');
  for (const c of [e, again]) assert.deepEqual(c.errors, []);
  // only keys of the checklist prefix are written
  const other = again.document.createElement('input');
  other.setAttribute('data-check-key', 'omo-briefing.notes.x');
  main.appendChild(other);
  other.checked = true;
  again.fire(other, 'change');
  assert.equal(store.getItem('omo-briefing.notes.x'), null);
});

test('annotations: every block carries its own button and is named 보고서 블록 in the composed feedback', () => {
  const e = makeController({ modules: ['icons', ...MODULES.slice(1), 'shell', 'annotate'] });
  const main = openReport(e, session());
  const figs = main.querySelectorAll('figure');
  assert.equal(figs.length, 6);
  for (const f of figs) assert.ok(f.children.some((c) => c.classList.contains('bh')), f.getAttribute('data-block'));
  const md = e.ctx.BriefAnnotate.toMarkdown(session(), [{ blocks: ['rep/rb/blk/3'], sub: 'rep', text: '', snip: '흐름', intent: '고쳐줘', comment: '의견', paths: [] }], []);
  assert.match(md, /### 1\. \[고쳐줘\] 보고서 · 보고서 블록\n\*\*위치:\*\* rep\/rb\/blk\/3 - 흐름/);
});

// ---- the page's scripts and styles ------------------------------------------------------------------------------------

test('page: blocks.js runs after view.js and before convo-view.js, blocks.css before annotate.css; blocks.css draws with tokens only', () => {
  const html = pageHtml(FIXTURE, 7, { mode: 'file' });
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, s); return i; };
  const view = at('/* omo-briefing view: pure renderer'), blocks = at('/* omo-briefing report blocks (C-REPORT blocks'), convo = at('/* omo-briefing conversation page: one full-width');
  assert.ok(view < blocks && blocks < convo);
  const css = read('src/page/blocks.css');
  const cssAt = at(css.slice(0, 80)), annAt = at('/* omo-briefing annotations (annotate.js)'), convoCss = at('/* omo-briefing conversation page (convo-view.js)');
  assert.ok(convoCss < cssAt && cssAt < annAt);
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, 'colours come from tokens.css');
  assert.doesNotMatch(css, /text-overflow|ellipsis/);
  const code = read('src/page/blocks.js').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /\b(?:fetch|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|innerHTML|eval|Function)\b/, 'a pure renderer');
  // B4: below 600 px the flow is native step nodes at the phone's secondary size, never the SVG
  const phone = css.slice(css.indexOf('@media (max-width: 599px)'));
  assert.match(phone, /\.rbk-flow \.flowbox \{ display: none; \}/);
  assert.match(phone, /\.flow-steps \{ display: grid;/);
  assert.match(css, /\.flow-steps li \{[^}]*font-size: var\(--fs-sm\)/);
  assert.match(read('src/page/tokens.css'), /@media \(max-width: 599px\) \{\s*:root \{[^}]*--fs-sm: 15px;/, 'the phone secondary size (>= 12 px)');
  // B-1: one known button width (56 px at 2 px from the corner); from 600 px block headers keep it and a gap free, below
  // 600 px the button is in the flow at 44 px
  const ann = read('src/page/annotate.css');
  assert.match(ann, /\n\.bh \{[^}]*right: 2px;[^}]*box-sizing: border-box; width: 56px;/);
  assert.match(ann, /@media \(min-width: 600px\) \{ \.ann-root \.ab :is\(\.rbk-t, [^)]*\) \{ padding-right: calc\(58px \+ var\(--sp-2\)\); \} \}/);
  assert.match(ann, /@media \(max-width: 599px\) \{[^@]*\n  \.ann-root \.ab > \.bh \{ position: static;[^}]*min-height: var\(--hit\)/);
});
