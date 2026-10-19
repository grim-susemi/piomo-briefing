import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = process.env.OMO_POLISH_TEST_ROOT || ROOT;
const VIEW_SOURCE = fs.readFileSync(path.join(PRODUCT, 'src/page/view.js'), 'utf8');
const ICONS = fs.readFileSync(path.join(PRODUCT, 'src/page/icons.js'), 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/view-model-workers.json'), 'utf8'));
const NOW = FIXTURE.generatedAt;
const LIVE1 = FIXTURE.sessions[0].live, LIVE2 = FIXTURE.sessions[1].live;
const clone = (v) => JSON.parse(JSON.stringify(v));
const plain = (v) => JSON.parse(JSON.stringify(v));
const iso = (ms) => new Date(ms).toISOString();
const count = (s, re) => (s.match(re) || []).length;
const source = () => fs.readFileSync(path.join(PRODUCT, 'src/page/workers-view.js'), 'utf8');
const css = () => fs.readFileSync(path.join(PRODUCT, 'src/page/workers-view.css'), 'utf8');
const use = (name) => '<use href="#i-' + name + '"></use>';

class FakeEl {
  constructor(tag, attrs, win) {
    this.tagName = tag; this.attrs = attrs; this.children = []; this.parentNode = null; this.win = win;
    this.style = {}; this.animations = []; this.htmlWrites = 0;
    const self = this;
    this.classList = {
      add(c) { const s = self.classSet(); s.add(c); self.attrs.class = [...s].join(' '); },
      remove(c) { const s = self.classSet(); s.delete(c); self.attrs.class = [...s].join(' '); },
      contains(c) { return self.classSet().has(c); },
    };
  }
  classSet() { return new Set(String(this.attrs.class || '').split(/\s+/).filter(Boolean)); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); assert.notEqual(i, -1, 'removeChild of a real child'); this.children.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  matches(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); if (!m) throw new Error('unsupported selector ' + sel); return this.hasAttribute(m[1]); }
  closest(sel) { for (let n = this; n instanceof FakeEl; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; const walk = n => { for (const c of n.children) if (c instanceof FakeEl) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  getBoundingClientRect() { const r = this.win.rects.get(this) || { top: 0, left: 0, width: 0, height: 0 }; return { ...r, bottom: r.top + r.height, right: r.left + r.width }; }
  animate(keyframes, options) { const a = { el: this, keyframes, options, onfinish: null }; this.animations.push(a); this.win.animations.push(a); return a; }
  get textContent() { return this.children.map(c => c instanceof FakeEl ? c.textContent : c.text).join(''); }
  set textContent(v) { this.win.textWrites.push(this); this.children = [{ text: String(v) }]; }
  get innerHTML() { throw new Error('innerHTML read is not part of the contract'); }
  set innerHTML(v) { this.htmlWrites++; this.win.htmlWrites++; }
}
function decode(s) { return s.replace(/&(amp|lt|gt|quot|#39|#96);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#96': '`' })[k]); }
function parse(html, win) {
  const top = new FakeEl('#top', {}, win); let cur = top;
  const re = /<\/([a-z0-9]+)>|<([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>|([^<]+)/y;
  let pos = 0;
  while (pos < html.length) {
    re.lastIndex = pos; const m = re.exec(html); assert.ok(m, 'unparseable markup at ' + pos + ': ' + html.slice(pos, pos + 60)); pos = re.lastIndex;
    if (m[1]) { assert.equal(cur.tagName, m[1], 'closing tag matches its opener'); cur = cur.parentNode; }
    else if (m[2]) { const attrs = {}; for (const a of m[3].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : decode(a[2]); const el = new FakeEl(m[2], attrs, win); cur.appendChild(el); cur = el; }
    else cur.children.push({ text: decode(m[4]) });
  }
  assert.equal(cur, top, 'every tag is closed'); return top.children.filter(c => c instanceof FakeEl);
}
function makeWin({ reduce = false, scrollY = 0 } = {}) {
  const win = {
    innerHeight: 900, innerWidth: 1440, scrollX: 0, scrollY,
    rects: new Map(), animations: [], textWrites: [], htmlWrites: 0, timers: [], mediaQueries: [],
    setTimeout(fn, ms) { const t = { fn, ms }; win.timers.push(t); return t; },
    clearTimeout(t) { const i = win.timers.indexOf(t); if (i >= 0) win.timers.splice(i, 1); },
    matchMedia(q) { win.mediaQueries.push(q); return { matches: reduce && /prefers-reduced-motion:\s*reduce/.test(q) }; },
  };
  vm.createContext(win);
  vm.runInContext(ICONS, win, { filename: 'icons.js' });
  vm.runInContext(VIEW_SOURCE, win, { filename: 'view.js' });
  vm.runInContext(source(), win, { filename: 'workers-view.js' });
  return win;
}
function load() { const win = makeWin(); assert.equal(typeof win.BriefWorkersView?.render, 'function'); return { view: win.BriefWorkersView, esc: win.BriefView.escapeHtml, win }; }
function render(live, now = NOW, expanded = {}) { const { view, esc } = load(); return view.render(live, now, { esc, expanded }); }
function rows(html) { return html.split('<li class="w-row ').slice(1).map(chunk => ({ id: /data-worker="([^"]+)"/.exec(chunk)[1], cls: chunk.slice(0, chunk.indexOf('"')), html: chunk })); }
function makeBoard(win) { const body = new FakeEl('body', {}, win), root = new FakeEl('div', { id: 'app' }, win); body.appendChild(root); return { body, root }; }
function fill(win, root, cards, now = NOW) {
  const { BriefWorkersView: view, BriefView } = win;
  const html = cards.map(c => '<article class="card" id="c-' + c.id + '" data-card="' + c.id + '">' + view.render(c.live, now, { esc: BriefView.escapeHtml, expanded: c.expanded || {} }) + '</article>').join('');
  for (const old of root.children) old.parentNode = null;
  root.children = []; for (const el of parse(html, win)) root.appendChild(el);
}
function layout(win, root, tops) { for (const card of root.querySelectorAll('[data-card]')) { const top = tops[card.getAttribute('data-card')]; win.rects.set(card, { top, left: 270, width: 800, height: 300 }); card.querySelectorAll('[data-worker]').forEach((row, i) => { win.rects.set(row, { top: top + 40 + 30 * i, left: 290, width: 760, height: 28 }); }); } }
const translates = win => win.animations.filter(a => typeof a.keyframes?.[0]?.transform === 'string' && a.keyframes[0].transform.startsWith('translate')).map(a => ({ who: a.el.getAttribute('data-worker') || a.el.getAttribute('data-card'), from: a.keyframes[0].transform, to: a.keyframes[a.keyframes.length - 1].transform, ms: a.options.duration }));
const byWho = (x, y) => x.who < y.who ? -1 : x.who > y.who ? 1 : 0;
const A = { id: 'st_a', name: 'A 작업', state: 'running', startedAt: iso(NOW - 60000), updatedAt: iso(NOW - 1000), todo: { items: [{ text: '첫 일', status: 'completed' }, { text: '둘째 일', status: 'in_progress' }], total: 2, done: 1, more: 0 } };
const B = { id: 'st_b', name: 'B 작업', state: 'running', startedAt: iso(NOW - 30000), updatedAt: iso(NOW - 1000) };
const C = { id: 'st_c', name: 'C 작업', state: 'done', startedAt: iso(NOW - 600000), endedAt: iso(NOW - 300000), updatedAt: iso(NOW - 300000) };
const A_DONE = { ...A, state: 'done', step: '', endedAt: iso(NOW), updatedAt: iso(NOW), todo: { items: [{ text: '첫 일', status: 'completed' }, { text: '둘째 일', status: 'completed' }], total: 2, done: 2, more: 0 } };
const OPEN_A = { 'worker:st_a': true };

test('classic script loads alone (no DOM, no view.js) and degrades to no-ops without a root', () => {
  const context = {}; vm.runInNewContext(source(), context); const v = context.BriefWorkersView;
  for (const fn of ['render', 'summary', 'measure', 'play', 'tick']) assert.equal(typeof v[fn], 'function', fn);
  assert.ok(v.render(LIVE1, NOW).includes('data-worker="st_01a14094"'));
  assert.equal(v.tick(null, NOW), 0); assert.deepEqual(plain(v.play(null, null)), { moved: 0, left: 0, entered: 0, done: 0 });
});
test('three workers (running, done, error): classes, running first, finished below by end time', () => {
  const r = rows(render(LIVE1));
  assert.deepEqual(r.map(x => x.id), ['st_01a14094', 'st_01a14092', 'st_01a14091']); assert.deepEqual(r.map(x => x.cls.split(' ')[0]), ['w-running', 'w-error', 'w-done']);
  assert.ok(r[1].html.includes(use('x')), 'error icon'); assert.ok(r[2].html.includes(use('check')), 'done icon'); assert.ok(!r[0].html.includes(use('check')) && !r[0].html.includes(use('x')));
  assert.match(r[1].html, /오류 \d\d:\d\d/); assert.match(r[2].html, /끝 \d\d:\d\d/);
  assert.doesNotMatch(source(), /\p{Extended_Pictographic}/u);
});
test('rows carry [kind] and [model] tags and clock elapsed: live for running, fixed for finished', () => {
  const r = rows(render(LIVE1)); assert.ok(r[0].html.includes('[visual-engineering]')); assert.ok(r[0].html.includes('[Opus 5.5]')); assert.ok(r[2].html.includes('[Sol 6.1]'));
  assert.ok(r[0].html.includes('data-since="1791946368345"')); for (const [i, time] of [[0, '3분 12초'], [1, '8분 00초'], [2, '12분 30초']]) { assert.ok(r[i].html.includes(use('clock'))); assert.ok(r[i].html.includes(time)); }
  assert.ok(!r[1].html.includes('data-since') && !r[2].html.includes('data-since')); assert.ok(r[0].html.includes('edit · src/page/workers-view.css'));
});
test('second card: stale, info-waiting, queued, cancelled and lost rows in their own order', () => {
  const r = rows(render(LIVE2)); assert.deepEqual(r.map(x => x.id), ['st_01a14096', 'st_01a14080', 'st_01a14095', 'st_01a14097', 'st_01a14081', 'st_01a14082']); assert.deepEqual(r.map(x => x.cls), ['w-running', 'w-running w-stale', 'w-waiting', 'w-waiting', 'w-cancelled', 'w-lost']);
  for (const [i, time] of [[0, '45초'], [1, '1시간 02분'], [3, '8초'], [4, '5분 00초']]) { assert.ok(r[i].html.includes(use('clock'))); assert.ok(r[i].html.includes(time)); }
  assert.ok(r[3].html.includes('대기 중')); assert.ok(!r[5].html.includes(use('clock'))); assert.match(r[4].html, /취소 \d\d:\d\d/); assert.match(r[5].html, /끊김 \d\d:\d\d/);
});
test('stale row says 응답 없음 10분 and stops pulsing even when the step text says otherwise', () => {
  const live = clone(LIVE2); live.workers.find(w => w.id === 'st_01a14080').step = 'read'; const stale = rows(render(live)).find(x => x.id === 'st_01a14080'); assert.ok(stale.cls.includes('w-stale')); assert.ok(stale.html.includes('응답 없음 10분')); assert.ok(!stale.html.includes('>read<')); assert.ok(!stale.html.includes('animation-delay'));
  const fresh = clone(live); fresh.workers.find(w => w.id === 'st_01a14080').stale = false; const back = rows(render(fresh)).find(x => x.id === 'st_01a14080'); assert.equal(back.cls, 'w-running'); assert.ok(back.html.includes('animation-delay'));
});
test('info-waiting row (id + name only, from noteWorkers) shows 정보 대기 without a timer', () => {
  const [r] = rows(render({ workers: [{ id: 'st_new1', name: '방금 띄운 작업자', state: 'waiting' }] })); assert.equal(r.cls, 'w-waiting'); assert.ok(r.html.includes('방금 띄운 작업자')); assert.ok(r.html.includes('정보 대기')); assert.ok(!r.html.includes('data-since')); assert.ok(r.html.includes(use('clock'))); assert.equal(load().view.summary({ workers: [{ id: 'st_new1', state: 'waiting' }] }), '작업자 1 · 진행 0 · 끝 0 · 대기 1');
});
test('summary line numbers', () => {
  const { view } = load(); assert.equal(view.summary(LIVE1), '작업자 3 · 진행 1 · 끝 1 · 오류 1'); assert.equal(view.summary(LIVE2), '작업자 6 · 진행 1 · 끝 0 · 응답 없음 1 · 대기 2 · 취소 1 · 끊김 1'); assert.equal(view.summary(LIVE1.workers), '작업자 3 · 진행 1 · 끝 1 · 오류 1'); assert.equal(view.summary(null), ''); assert.ok(render(LIVE1).includes('<p class="w-sum">작업자 3 · 진행 1 · 끝 1 · 오류 1</p>'));
});
test('pulse animation-delay is -(now % 1200) ms so a redraw continues the beat', () => {
  assert.equal(count(render(LIVE1, NOW), /animation-delay/g), 1); assert.ok(render(LIVE1, NOW).includes('style="animation-delay:-345ms"')); assert.ok(render(LIVE1, NOW + 1000).includes('style="animation-delay:-145ms"')); assert.ok(render(LIVE1, NOW + 855).includes('style="animation-delay:-0ms"')); assert.equal(count(render(LIVE2, NOW), /animation-delay:-345ms/g), 1);
});
test('todo list: collapsed toggle shows done/total; expanded shows check, filled and empty marks with the current item highlighted', () => {
  const collapsed = rows(render(LIVE1))[0].html; assert.ok(collapsed.includes('data-act="exp" data-key="worker:st_01a14094"')); assert.ok(collapsed.includes('aria-expanded="false"')); assert.ok(collapsed.includes('투두 4/7')); assert.ok(!collapsed.includes('class="w-todos"'));
  const open = rows(render(LIVE1, NOW, { 'worker:st_01a14094': true }))[0].html; assert.ok(open.includes('aria-expanded="true"')); const items = open.split('<li class="w-todo ').slice(1); assert.equal(items.length, 7);
  assert.equal(items.filter(i => i.startsWith('w-t-done')).length, 3); assert.equal(items.filter(i => i.startsWith('w-t-doing')).length, 1); assert.equal(items.filter(i => i.startsWith('w-t-todo')).length, 2); assert.equal(items.filter(i => i.startsWith('w-t-dropped')).length, 1);
  assert.equal(count(open, /<use href="#i-check"><\/use>/g), 3); assert.equal(count(open, /class="w-tsym" aria-hidden="true"><svg[^>]*><use href="#i-clock"/g), 1); assert.equal(count(open, /class="w-tsym" aria-hidden="true"><svg[^>]*><use href="#i-list-todo"/g), 2); assert.ok(items.find(i => i.startsWith('w-t-doing')).includes('workers-view.js 작성'));
  assert.ok(!rows(render(LIVE1, NOW, { 'worker:st_01a14094': true }))[1].html.includes('w-todos')); assert.ok(!rows(render(LIVE1))[1].html.includes('투두'));
});
test('todo list keeps at most 30 items and counts the rest; rows stop at 20 workers', () => {
  const big = rows(render(LIVE2, NOW, { 'worker:st_01a14096': true }))[0].html; assert.equal(count(big, /<li class="w-todo /g), 30); assert.ok(big.includes('외 4개')); assert.ok(big.includes('투두 12/34'));
  const many = { workers: Array.from({ length: 25 }, (_, i) => ({ id: 'st_m' + i, name: 'm' + i, state: 'running', startedAt: iso(NOW - 1000), updatedAt: iso(NOW - 1000) })) }; const html = render(many); assert.equal(rows(html).length, 20); assert.ok(html.includes('외 5명')); assert.equal(rows(render({ workers: [B, { ...B, name: '중복' }] })).length, 1);
});
test('empty or malformed live data renders nothing', () => { for (const live of [null, undefined, {}, { workers: [] }, { workers: 'x' }, 'x', [null, 1]]) assert.equal(render(live), ''); });
test('every model string is escaped in text and attributes, using the injected esc', () => {
  const bad = '<script>"&\'`</script>', live = { workers: [{ id: 'st_x' + bad, name: bad, kind: bad, model: bad, state: 'running', step: bad, startedAt: iso(NOW - 1000), updatedAt: iso(NOW - 1000), todo: { items: [{ text: bad, status: 'in_progress' }, { text: bad, status: bad }], total: bad, done: bad, more: bad } }] };
  const { view, esc } = load(), html = view.render(live, NOW, { esc, expanded: { ['worker:st_x' + bad]: true } }); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('"&\'`')); assert.ok(html.includes('&lt;script&gt;')); const seen = []; view.render(live, NOW, { esc(v) { seen.push(v); return esc(v); }, expanded: {} }); assert.ok(seen.includes(bad));
  const { win } = load(), { root } = makeBoard(win); fill(win, root, [{ id: 's', live, expanded: { ['worker:st_x' + bad]: true } }]); assert.equal(root.querySelectorAll('[data-worker]')[0].getAttribute('data-worker'), 'st_x' + bad);
});
test('rendering is deterministic and does not mutate the input', () => { const live = clone(LIVE2), before = JSON.stringify(live); assert.equal(render(live), render(live)); assert.equal(JSON.stringify(live), before); });
test('tick rewrites only [data-since] text, never innerHTML, and keeps finished durations', () => {
  const win = makeWin(), { root } = makeBoard(win); fill(win, root, [{ id: 's-w1', live: LIVE1 }, { id: 's-w2', live: LIVE2 }]); const stepBefore = root.querySelectorAll('[data-worker]').map(r => r.textContent), elements = root.querySelectorAll('[data-worker]'); assert.equal(win.BriefWorkersView.tick(root, NOW + 65000), 4);
  const since = root.querySelectorAll('[data-since]'); assert.deepEqual(since.map(el => el.textContent), ['4분 17초', '1분 50초', '1시간 03분', '1분 13초']); assert.equal(win.htmlWrites, 0); assert.ok(win.textWrites.every(el => el.hasAttribute('data-since'))); assert.ok(root.querySelectorAll('[data-worker]').every((el, i) => el === elements[i]));
  const after = root.querySelectorAll('[data-worker]').map(r => r.textContent); stepBefore.forEach((text, i) => { if (!elements[i].querySelectorAll('[data-since]').length) assert.equal(after[i], text); }); assert.ok(after.some(t => t.includes('12분 30초')) && after.some(t => t.includes('8분 00초')));
  assert.equal(root.querySelectorAll('[href]').filter(e => e.getAttribute('href') === '#i-clock').length, 9, 'tick preserves the elapsed-time and waiting-state clock icons');
  win.textWrites.length = 0; assert.equal(win.BriefWorkersView.tick(root, NOW + 65000), 0); assert.equal(win.textWrites.length, 0); since[0].setAttribute('data-since', 'garbage'); assert.equal(win.BriefWorkersView.tick(root, NOW + 70000), 2); assert.ok(!since[0].textContent.includes('NaN'));
});
test('play: FLIP moves rows by their position difference (running first, finished sinks) and pops the marks', () => {
  const win = makeWin(), view = win.BriefWorkersView, { root } = makeBoard(win); fill(win, root, [{ id: 's-a', live: { workers: [A, B, C] }, expanded: OPEN_A }]); layout(win, root, { 's-a': 100 }); assert.deepEqual(root.querySelectorAll('[data-worker]').map(r => r.getAttribute('data-worker')), ['st_a', 'st_b', 'st_c']); const before = view.measure(root);
  fill(win, root, [{ id: 's-a', live: { workers: [A_DONE, B, C] }, expanded: OPEN_A }]); layout(win, root, { 's-a': 100 }); assert.deepEqual(root.querySelectorAll('[data-worker]').map(r => r.getAttribute('data-worker')), ['st_b', 'st_a', 'st_c']); const result = plain(view.play(root, before, { reducedMotion: false }));
  assert.deepEqual(translates(win).sort(byWho), [{ who: 'st_a', from: 'translate(0px, -30px)', to: 'none', ms: 350 }, { who: 'st_b', from: 'translate(0px, 30px)', to: 'none', ms: 350 }]); const [rowA] = root.querySelectorAll('[data-worker]').filter(r => r.getAttribute('data-worker') === 'st_a'); assert.ok(rowA.classList.contains('w-just-ended')); assert.deepEqual(root.querySelectorAll('[data-todo]').map(t => [t.getAttribute('data-todo'), t.classList.contains('w-just-done')]), [['첫 일', false], ['둘째 일', true]]); assert.equal(result.moved, 2); assert.equal(result.done, 2);
});
test('play: a moved card animates once and its rows are not double-moved (offsets are card-relative)', () => {
  const win = makeWin(), view = win.BriefWorkersView, { root } = makeBoard(win); fill(win, root, [{ id: 's-a', live: { workers: [A, B, C] } }]); layout(win, root, { 's-a': 100 }); const before = view.measure(root); fill(win, root, [{ id: 's-a', live: { workers: [A, B, C] } }]); layout(win, root, { 's-a': 140 }); view.play(root, before, { reducedMotion: false }); assert.deepEqual(translates(win), [{ who: 's-a', from: 'translate(0px, -40px)', to: 'none', ms: 350 }]);
  win.animations.length = 0; const before2 = view.measure(root); fill(win, root, [{ id: 's-a', live: { workers: [A_DONE, B, C] } }]); layout(win, root, { 's-a': 100 }); view.play(root, before2, { reducedMotion: false }); assert.deepEqual(translates(win).sort(byWho), [{ who: 's-a', from: 'translate(0px, 40px)', to: 'none', ms: 350 }, { who: 'st_a', from: 'translate(0px, -30px)', to: 'none', ms: 350 }, { who: 'st_b', from: 'translate(0px, 30px)', to: 'none', ms: 350 }]);
});
test('play: a card leaving the tab fades and folds for 400 ms in its old screen spot, then is removed', () => {
  const win = makeWin(), view = win.BriefWorkersView, { body, root } = makeBoard(win); fill(win, root, [{ id: 's-a', live: { workers: [A, B] } }, { id: 's-b', live: { workers: [C] } }]); layout(win, root, { 's-a': 100, 's-b': 460 }); const before = view.measure(root); fill(win, root, [{ id: 's-a', live: { workers: [A, B] } }]); layout(win, root, { 's-a': 100 }); win.scrollY = 250; const result = plain(view.play(root, before, { reducedMotion: false })); assert.equal(result.left, 1);
  const ghost = body.children.find(c => c !== root); assert.ok(ghost); assert.equal(ghost.getAttribute('data-card'), null); assert.equal(ghost.getAttribute('id'), null); assert.equal(ghost.getAttribute('aria-hidden'), 'true'); assert.equal(ghost.style.position, 'absolute'); assert.equal(ghost.style.top, '710px'); assert.equal(ghost.style.left, '270px'); assert.equal(ghost.style.width, '800px'); assert.equal(ghost.style.height, '300px'); assert.equal(ghost.style.pointerEvents, 'none'); assert.equal(ghost.style.zIndex, '-1');
  const anim = win.animations.find(a => a.el === ghost); assert.equal(anim.options.duration, 400); assert.equal(anim.keyframes[0].opacity, 1); assert.equal(anim.keyframes.at(-1).opacity, 0); assert.match(anim.keyframes.at(-1).transform, /scaleY\(0\)/); assert.equal(root.querySelectorAll('[data-card]').length, 1); anim.onfinish(); assert.equal(body.children.includes(ghost), false); assert.ok(win.timers.some(t => t.ms >= 400)); win.timers.forEach(t => t.fn()); assert.equal(body.children.length, 1);
});
test('play: off-screen moves are skipped and a new card fades in (but not on the first paint)', () => {
  const win = makeWin(), view = win.BriefWorkersView, { root } = makeBoard(win); fill(win, root, [{ id: 's-a', live: { workers: [B] } }, { id: 's-far', live: { workers: [C] } }]); layout(win, root, { 's-a': 100, 's-far': 2000 }); const before = view.measure(root);
  fill(win, root, [{ id: 's-a', live: { workers: [B] } }, { id: 's-new', live: { workers: [A] } }, { id: 's-far', live: { workers: [C] } }]); layout(win, root, { 's-a': 100, 's-new': 420, 's-far': 2320 }); const result = plain(view.play(root, before, { reducedMotion: false })); assert.deepEqual(translates(win), []); assert.deepEqual(win.animations.filter(a => a.keyframes[0].opacity === 0).map(a => a.el.getAttribute('data-card')), ['s-new']); assert.equal(result.entered, 1); win.animations.length = 0; view.play(root, view.measure(new FakeEl('div', {}, win)), { reducedMotion: false }); assert.equal(win.animations.length, 0);
});
test('reduced motion: play sets no transform, no ghost, no pop - by option or by the media query', () => {
  for (const mode of ['option', 'media']) { const win = makeWin({ reduce: mode === 'media' }), view = win.BriefWorkersView, { body, root } = makeBoard(win); fill(win, root, [{ id: 's-a', live: { workers: [A, B, C] }, expanded: OPEN_A }, { id: 's-b', live: { workers: [C] } }]); layout(win, root, { 's-a': 100, 's-b': 460 }); const before = view.measure(root); fill(win, root, [{ id: 's-a', live: { workers: [A_DONE, B, C] }, expanded: OPEN_A }]); layout(win, root, { 's-a': 140 }); const result = plain(mode === 'option' ? view.play(root, before, { reducedMotion: true }) : view.play(root, before)); assert.equal(win.animations.length, 0, mode); assert.deepEqual(result, { moved: 0, left: 0, entered: 0, done: 0 }); assert.equal(body.children.length, 1); assert.equal(root.querySelectorAll('[data-worker]').filter(r => r.classList.contains('w-just-ended')).length, 0); assert.equal(root.querySelectorAll('[data-todo]').filter(r => r.classList.contains('w-just-done')).length, 0); if (mode === 'media') assert.ok(win.mediaQueries.some(q => /prefers-reduced-motion:\s*reduce/.test(q))); }
});
test('css: tokens only, bounded 1200 ms pulse, reduced-motion switches every animation off, 600 px layout', () => {
  const text = css(); assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b/); assert.doesNotMatch(text, /rgba?\(/); const pulse = /\.w-running\s*>\s*\.w-dot\s*\{[^}]*\}/.exec(text); assert.ok(pulse); assert.match(pulse[0], /animation:\s*w-pulse\s+1200ms\s+ease-out\s+3\s*;/); assert.doesNotMatch(pulse[0], /infinite/); assert.match(pulse[0], /var\(--teal\)/); assert.match(text, /@keyframes\s+w-pulse/);
  const reduce = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(text); assert.ok(reduce); assert.match(reduce[1], /\.w-running\s*>\s*\.w-dot/); assert.match(reduce[1], /animation:\s*none/); assert.match(reduce[1], /\.w-just-done/); assert.match(reduce[1], /\.w-just-ended/); assert.match(text, /\.w-error\s*>\s*\.w-dot\s*\{[^}]*var\(--red\)/); assert.match(text, /\.w-done\s*>\s*\.w-dot\s*\{[^}]*var\(--green\)/); assert.match(text, /\.w-stale\s*>\s*\.w-dot\s*\{[^}]*var\(--yellow\)/); assert.match(text, /@media\s*\(max-width:\s*599px\)/);
});
test('css: worker tags wrap instead of clipping: no nowrap, hidden overflow, ellipsis or zero-basis squeeze on .w-tags', () => {
  const rules = [...css().matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(m => m[1].trim() === '.w-tags').map(m => m[2]); assert.equal(rules.length, 2); for (const body of rules) { assert.doesNotMatch(body, /white-space:\s*nowrap|overflow:\s*hidden|text-overflow/); assert.doesNotMatch(body, /flex:\s*\d+\s+\d+\s+0(px)?\s*(;|$)/); } assert.match(rules[0], /overflow-wrap:\s*anywhere/); assert.ok(render(LIVE1, NOW).includes('<span class="w-tags"><span class="w-tag">[visual-engineering]</span><span class="w-tag w-model">[Opus 5.5]</span></span>'));
});
