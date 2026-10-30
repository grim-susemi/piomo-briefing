// Office view (src/page/office-view.js): the scene drawn as SVG in the board shell. The real page scripts run in the
// deterministic DOM of fixtures/controller-dom.mjs on fixtures/view-model-office.json (6 floors; the first has a lead, 12
// workers and a 5-wave plan). The browser side (captures, CSP, real clicks, the AX tree) is the CDP run of plan todo 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeController } from './fixtures/controller-dom.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const fixture = (p) => JSON.parse(read('test/fixtures/' + p));
const clone = (v) => JSON.parse(JSON.stringify(v));
const HOSTILE = fixture('hostile-strings.json');
const MODULES = ['icons', 'view', 'plan-view', 'workers-view', 'blocks', 'convo-view', 'shell', 'annotate', 'office-assets', 'office-model', 'office-view'];
// the visible rugs of office-view.js ROOMS, [x0, y0, x1, y1] in tiles
const ROOM = { plan: [5.4, .4, 11.2, 4.6], research: [11.8, .4, 17.6, 4.6], work: [.4, 7.4, 6.9, 13.6], lounge: [7.3, 7.4, 10.4, 13.6], review: [11, 7.4, 17.6, 13.6] };

const SVG_NS = 'http://www.w3.org/2000/svg';

// the fake document has no SVG namespace: an SVG node is a plain element that remembers the namespace it was made in, and
// the page's hidden icon sprite (render.mjs iconSprite) is where office-view.js reads that namespace
function load(configure) {
  return makeController({ modules: MODULES, configure: (ctx) => {
    ctx.document.createElementNS = (ns, tag) => Object.assign(ctx.document.createElement(tag), { namespaceURI: ns });
    const sprite = Object.assign(ctx.document.createElement('svg'), { namespaceURI: SVG_NS });
    sprite.id = 'icon-sprite';
    ctx.document.body.appendChild(sprite);
    configure?.(ctx);
  } });
}
function openOffice(vm, configure) {
  const e = load(configure);
  e.page.receive(vm);
  e.fire(e.byId.rail.querySelector('[data-sh="view"][data-key="office"]'), 'click');
  return { e, office: e.byId.main.querySelector('#office') };
}
// every drawn label as its pill box in scene units
function labelBoxes(office) {
  return office.querySelector('.of-l-top').children.filter((n) => n.querySelector('rect')).map((n) => {
    const [x, y] = /translate\(([-\d.]+),([-\d.]+)\)/.exec(n.getAttribute('transform')).slice(1).map(Number), r = n.querySelector('rect');
    const x0 = x + Number(r.getAttribute('x')), y0 = y + Number(r.getAttribute('y'));
    return { name: n.getAttribute('class') + ':' + n.textContent, x0, y0, x1: x0 + Number(r.getAttribute('width')), y1: y0 + Number(r.getAttribute('height')) };
  });
}
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
// the wall screens' text in scene units, one box per glyph: a line is translate(x,y) skewY(+-30) at its font size, a glyph
// one advance wide (1 em for Hangul, 0.62 em otherwise, as office-view.js estimate()), 0.8 em above the baseline to 0.2 under
function wallGlyphs(office) {
  return office.querySelectorAll('text').filter((t) => /skewY/.test(t.getAttribute('transform') || '') && t.textContent.trim()).flatMap((t) => {
    const [x, y, deg] = /translate\(([-\d.]+),([-\d.]+)\) skewY\((-?[\d.]+)\)/.exec(t.getAttribute('transform')).slice(1).map(Number);
    const fs = Number(t.getAttribute('font-size')), tan = Math.tan(deg * Math.PI / 180);
    let at = 0;
    return [...t.textContent].map((ch) => {
      const adv = ch.charCodeAt(0) > 0x2e80 ? fs : fs * 0.62, ya = y + tan * at, yb = y + tan * (at + adv);
      const box = { name: 'wall:' + t.textContent + '[' + ch + ']', x0: x + at, x1: x + at + adv, y0: Math.min(ya, yb) - fs * 0.8, y1: Math.max(ya, yb) + fs * 0.2 };
      at += adv;
      return box;
    });
  });
}
// a box's area inside another
const inside = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

test('사무실 in the rail draws the first floor; every desk is a named button with the open action of its session', () => {
  const vm = fixture('view-model-office.json');
  const { e, office } = openOffice(vm);
  const floor = clone(e.ctx.BriefOffice.scene(e.page.state.model, e.page.state.ui, vm.generatedAt)).floors[0];
  const desks = office.querySelectorAll('.of-desk');
  assert.deepEqual(desks.map((d) => d.getAttribute('data-desk')).sort(), floor.desks.map((d) => d.id).sort(), 'one desk per scene desk');
  for (const d of desks) {
    const row = floor.desks.find((x) => x.id === d.getAttribute('data-desk'));
    assert.deepEqual([d.getAttribute('data-sh'), d.getAttribute('data-sid'), d.getAttribute('data-sub')], ['open', floor.sid, row.kind === 'lead' ? null : 'wk'], row.id);
    assert.deepEqual([d.getAttribute('role'), d.getAttribute('tabindex')], ['button', '0'], row.id);
    assert.match(d.getAttribute('aria-label'), /^\S.* · 대화 열기$/, row.id);
  }
  assert.equal(office.querySelector('.of-fl[aria-pressed="true"]').getAttribute('data-floor'), floor.sid);
  assert.equal(office.querySelectorAll('.of-fl').length, 6, 'one picker row per floor');
  assert.equal(office.querySelector('.of-scene').namespaceURI, SVG_NS, 'the scene is made in the namespace of the page sprite');
});

test('a desk click is the existing open action: that conversation, at 작업자 for a worker', () => {
  const { e, office } = openOffice(fixture('view-model-office.json'));
  const desk = office.querySelector('.of-desk[data-sub="wk"]'), sid = desk.getAttribute('data-sid');
  e.fire(desk.querySelector('polygon'), 'click');
  assert.equal(e.page.state.ui.view, 'conv');
  assert.equal(e.page.state.ui.sub[sid], 'wk');
  assert.equal(e.byId.main.querySelector('#office'), null, 'the conversation replaced the office');
});

test('the picker shows one floor at a time: a click redraws the scene for that floor and marks it pressed', () => {
  const { e, office } = openOffice(fixture('view-model-office.json'));
  const row = office.querySelectorAll('.of-fl')[1], sid = row.getAttribute('data-floor');
  e.fire(row.querySelector('.of-ft'), 'click');
  assert.deepEqual(office.querySelectorAll('.of-fl[aria-pressed="true"]').map((b) => b.getAttribute('data-floor')), [sid]);
  assert.ok(office.querySelectorAll('.of-desk').length > 0);
  assert.deepEqual([...new Set(office.querySelectorAll('.of-desk').map((d) => d.getAttribute('data-sid')))], [sid]);
  assert.match(office.querySelector('.of-scene').getAttribute('aria-label'), /^5층 · /);
});

test('layout seats every desk inside its room, two desks never on one spot, the same way every time', () => {
  const view = load().ctx.BriefOfficeView;
  for (let n = 1; n <= 12; n++) {
    const rooms = Object.fromEntries(Object.keys(ROOM).map((r) => [r, Array.from({ length: n }, (_, i) => r + i)]));
    const cells = clone(view.layout({ rooms }));
    assert.deepEqual(clone(view.layout({ rooms })), cells, 'pure');
    for (const [room, ids] of Object.entries(rooms)) {
      const [x0, y0, x1, y1] = ROOM[room];
      // a desk is 1.6 x 1 tiles; in the lounge two cats sit on the sofa (a point), the rest stand on .7 x .5
      const feet = ids.map((id, i) => {
        const c = cells[id], [w, d] = room !== 'lounge' ? [1.6, 1] : i < 2 ? [0, 0] : [.7, .5];
        return { name: id, x0: c.x, y0: c.y, x1: c.x + w * c.s, y1: c.y + d * c.s };
      });
      for (const f of feet) assert.ok(f.x0 >= x0 && f.y0 >= y0 && f.x1 <= x1 && f.y1 <= y1, JSON.stringify([n, f]));
      for (let i = 0; i < feet.length; i++) for (let j = i + 1; j < feet.length; j++) assert.ok(!hit(feet[i], feet[j]), feet[i].name + ' / ' + feet[j].name);
    }
  }
});

test('labels settle without overlap and every desk outside the lounge keeps its name', () => {
  const vm = fixture('view-model-office.json');
  const { e, office } = openOffice(vm);
  const boxes = labelBoxes(office);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!hit(boxes[i], boxes[j]), boxes[i].name + ' / ' + boxes[j].name);
  const floor = clone(e.ctx.BriefOffice.scene(e.page.state.model, e.page.state.ui, vm.generatedAt)).floors[0];
  assert.deepEqual(floor.desks.filter((d) => d.room !== 'lounge' && !office.querySelector('.of-tag[data-for="' + d.id + '"]')).map((d) => d.id), []);
  assert.equal(office.querySelectorAll('.of-room').length, 6, 'every room is named');
});

test('a stage resize settles the labels again, clear of the picker, the floor card and the title', () => {
  const observers = [];
  const { e, office } = openOffice(fixture('view-model-office.json'), (ctx) => {
    ctx.ResizeObserver = class { constructor(fn) { observers.push(fn); } observe() {} };
  });
  // scene units = client pixels; the picker over the plan room's back row, the card and the title out of the way
  office.querySelector('.of-scene').getScreenCTM = () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
  const picker = { left: 560, top: 0, width: 500, height: 240 };
  e.ctx.rects.set(office.querySelector('.of-floors'), picker);
  for (const sel of ['.of-card', '.of-head']) e.ctx.rects.set(office.querySelector(sel), { left: 0, top: 0, width: 0, height: 0 });
  const box = { x0: picker.left, y0: picker.top, x1: picker.left + picker.width, y1: picker.top + picker.height };
  assert.ok(labelBoxes(office).some((b) => hit(b, box)), 'before the resize a label sits where the picker now is');
  assert.equal(observers.length, 1, 'the view watches its stage');
  observers[0]();
  const boxes = labelBoxes(office);
  assert.deepEqual(boxes.filter((b) => hit(b, box) && !/^of-room:/.test(b.name)).map((b) => b.name), []);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!hit(boxes[i], boxes[j]), boxes[i].name + ' / ' + boxes[j].name);
});

test('hostile titles, names, steps, kinds and questions render as text, never as markup', () => {
  const vm = fixture('view-model-office.json'), s = vm.sessions[0], w = s.live.workers;
  [s.title, w[0].name, w[0].step, w[4].kind, s.decisions[0].question] = [HOSTILE[1], HOSTILE[2], HOSTILE[3], HOSTILE[0], HOSTILE[4]];
  const { e, office } = openOffice(vm);
  const all = office.querySelectorAll('*');
  assert.deepEqual(all.filter((n) => /^(SCRIPT|IMG|IFRAME|OBJECT|EMBED|FOREIGNOBJECT|TEXTAREA)$/.test(n.tagName)).map((n) => n.tagName), []);
  assert.deepEqual(all.filter((n) => Object.keys(n.attrs).some((k) => /^on/i.test(k))).map((n) => n.tagName), []);
  assert.deepEqual(all.filter((n) => n.tagName === 'B' && n.textContent === 'x').length, 0, 'no <b> from the kind');
  for (const h of HOSTILE) assert.ok(office.textContent.includes(h), h);
  assert.equal(office.querySelector('.of-fl .of-ft').textContent, HOSTILE[1]);
  assert.equal(office.querySelector('.of-scene').getAttribute('aria-label'), '6층 · ' + HOSTILE[1]);
  assert.equal(e.ctx.pwned, undefined);
});

test('no label covers the wall screens\' text: a bubble, a desk name or a belt label takes another place or stays out', () => {
  // Given the fixture board (the plan-reviewer's bubble sits under the back wall's screen), When 사무실 opens, Then no
  // label box lies on a glyph of the back wall's three plan lines or the left wall's three office lines
  const { office } = openOffice(fixture('view-model-office.json'));
  const walls = wallGlyphs(office), boxes = labelBoxes(office);
  assert.ok(walls.length > 40, 'both screens carry their lines');
  assert.deepEqual(boxes.flatMap((b) => walls.filter((w) => hit(b, w)).map((w) => b.name + ' / ' + w.name)), []);
});

test('every lounge cat\'s hit box is at least 61 scene units each way (44 px on a phone), touches no other target and holds most of its own head', () => {
  // Given the fixture floor (two cats side by side on the sofa, one strolling in front of it), When 사무실 opens, Then each
  // lounge cat's hit rect is 61 x 61 or more, no two hit rects of the floor overlap (lounge or desk), and each lounge rect
  // holds its cat's head middle and at least 70 % of its head
  const { office } = openOffice(fixture('view-model-office.json'));
  const num = (n, k) => Number(n.getAttribute(k)), units = office.querySelectorAll('.of-desk');
  const lounge = units.filter((u) => u.querySelector('.of-walk').children[0].classes.has('of-hit')).map((u) => {
    const walk = u.querySelector('.of-walk'), r = walk.children[0], [fx, fy, k] = /translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+)\)/.exec(walk.children[1].getAttribute('transform')).slice(1).map(Number), size = 46 * k;
    return { id: u.getAttribute('data-desk'), box: { x0: num(r, 'x'), y0: num(r, 'y'), x1: num(r, 'x') + num(r, 'width'), y1: num(r, 'y') + num(r, 'height') }, head: { x0: fx - size / 2, x1: fx + size / 2, y0: fy - 1.42 * size, y1: fy - 0.42 * size } };
  });
  // a desk's hit rect drawn in its place group: translate(x,y) scale(s) translate(-470,-120)
  const desks = units.filter((u) => u.querySelector('.of-slide')).map((u) => {
    const g = u.querySelector('.of-slide').children[0], r = g.querySelector('.of-hit'), [ax, ay, s] = /translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+)\)/.exec(g.getAttribute('transform')).slice(1).map(Number);
    const at = (x, y) => [ax + (x - 470) * s, ay + (y - 120) * s], [x0, y0] = at(num(r, 'x'), num(r, 'y')), [x1, y1] = at(num(r, 'x') + num(r, 'width'), num(r, 'y') + num(r, 'height'));
    return { id: u.getAttribute('data-desk'), box: { x0, y0, x1, y1 } };
  });
  assert.equal(lounge.length, 3, 'the fixture floor has three lounge cats');
  const shrink = (b) => ({ x0: b.x0 + 0.05, y0: b.y0 + 0.05, x1: b.x1 - 0.05, y1: b.y1 - 0.05 });
  for (const c of lounge) {
    assert.ok(c.box.x1 - c.box.x0 >= 61 && c.box.y1 - c.box.y0 >= 61, c.id + ' ' + JSON.stringify(c.box));
    const mx = (c.head.x0 + c.head.x1) / 2, my = (c.head.y0 + c.head.y1) / 2;
    assert.ok(mx > c.box.x0 && mx < c.box.x1 && my > c.box.y0 && my < c.box.y1, c.id + ' holds its head middle');
    assert.ok(inside(c.head, c.box) >= 0.7 * (c.head.x1 - c.head.x0) * (c.head.y1 - c.head.y0), c.id + ' holds most of its head');
  }
  const all = lounge.concat(desks);
  for (const c of lounge) for (const d of all) if (d !== c) assert.ok(!hit(shrink(c.box), shrink(d.box)), c.id + ' / ' + d.id);
});

test('the belt\'s done waves take the rest tone and green means working only: a done box and its label carry of-done, never the work green', () => {
  // Given the fixture plan (wave 1 done, wave 2 under way, waves 3-5 to come), When 사무실 opens, Then the done wave's box
  // and label are marked of-done (office.css gives them --c-gray), the others are not, and no belt label is inked green
  const vm = fixture('view-model-office.json');
  const { e, office } = openOffice(vm);
  const conv = clone(e.ctx.BriefOffice.scene(e.page.state.model, e.page.state.ui, vm.generatedAt)).floors[0].conveyor;
  assert.ok(conv.current > 0, 'the fixture has a done wave');
  const boxes = office.querySelector('.of-l-belt').children.filter((n) => n.tagName === 'G');
  assert.deepEqual(boxes.map((b) => b.classes.has('of-done')), conv.waves.map((w, i) => i < conv.current));
  const waves = office.querySelectorAll('.of-wave');
  assert.deepEqual(waves.filter((w) => / ✓$/.test(w.textContent) !== w.classes.has('of-done')).map((w) => w.textContent), []);
  assert.deepEqual(waves.filter((w) => [w.querySelector('rect').getAttribute('stroke'), w.querySelector('text').getAttribute('fill')].includes('#4fd1a5')).map((w) => w.textContent), []);
});

test('the shown floor\'s picker row carries a check glyph besides its wash; no other row does', () => {
  // Given the picker, When 사무실 opens and then another floor is chosen, Then exactly the pressed row has the check
  const { office, e } = openOffice(fixture('view-model-office.json'));
  const marked = () => office.querySelectorAll('.of-fl').filter((b) => b.querySelector('.of-on')).map((b) => b.getAttribute('data-floor'));
  const pressed = () => office.querySelectorAll('.of-fl[aria-pressed="true"]').map((b) => b.getAttribute('data-floor'));
  assert.deepEqual(marked(), pressed());
  assert.equal(marked().length, 1);
  e.fire(office.querySelectorAll('.of-fl')[2].querySelector('.of-ft'), 'click');
  assert.deepEqual(marked(), pressed());
  assert.equal(marked()[0], office.querySelectorAll('.of-fl')[2].getAttribute('data-floor'));
});

test('the art passes an allowlist: a tag or attribute outside it throws instead of drawing', () => {
  for (const bad of ['<g><script>globalThis.pwned=1</script></g>', '<g onload="globalThis.pwned=1"></g>', '<image href="x"/>', '<g>text</g>']) {
    const e = load((ctx) => { ctx.BriefOfficeArt = { symbols: ctx.BriefOfficeArt.symbols, props: { ...ctx.BriefOfficeArt.props, plant: bad } }; });
    assert.throws(() => e.ctx.BriefOfficeView.render(e.document.createElement('section'), fixture('view-model-office.json'), {}), /office art plant: /, bad);
    assert.equal(e.ctx.pwned, undefined, bad);
  }
});
