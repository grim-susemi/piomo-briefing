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

test('the art passes an allowlist: a tag or attribute outside it throws instead of drawing', () => {
  for (const bad of ['<g><script>globalThis.pwned=1</script></g>', '<g onload="globalThis.pwned=1"></g>', '<image href="x"/>', '<g>text</g>']) {
    const e = load((ctx) => { ctx.BriefOfficeArt = { symbols: ctx.BriefOfficeArt.symbols, props: { ...ctx.BriefOfficeArt.props, plant: bad } }; });
    assert.throws(() => e.ctx.BriefOfficeView.render(e.document.createElement('section'), fixture('view-model-office.json'), {}), /office art plant: /, bad);
    assert.equal(e.ctx.pwned, undefined, bad);
  }
});
