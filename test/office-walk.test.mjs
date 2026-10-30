// The boss cat (src/page/office-view.js "the boss cat", office-model.js walk map; plan omo-office-view todo 10, Must have
// 12). The real page scripts run in the deterministic DOM of fixtures/controller-dom.mjs on fixtures/view-model-office.json.
// el.animate() is a recording fake, matchMedia a live fake whose change listeners the tests call, and the scene's screen
// matrix is the identity, so a click's clientX/Y is a point of the scene. The browser side (real keys in the real note box
// and annotate tray, real clicks, a real hidden tab and media change) is the CDP run of plan todo 10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeController } from './fixtures/controller-dom.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const fixture = (p) => JSON.parse(read('test/fixtures/' + p));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MODULES = ['icons', 'view', 'plan-view', 'workers-view', 'blocks', 'convo-view', 'shell', 'annotate', 'office-assets', 'office-model', 'office-view'];
const OFFICE_JS = ['office-assets.js', 'office-model.js', 'office-view.js'];
const SVG_NS = 'http://www.w3.org/2000/svg';
// the scene projection of office-view.js (origin 470,120; 34-unit floor tiles) and a walk tile: half a floor tile
const OX = 470, OY = 120, KX = 34 * 0.866, KY = 17, TILE = 0.5;
const iso = (x, y) => [OX + (x - y) * KX, OY + (x + y) * KY];
const floorPoint = ([sx, sy]) => { const u = (sx - OX) / KX, w = (sy - OY) / KY; return [(u + w) / 2, (w - u) / 2]; };
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// one fake Web Animations handle per el.animate() call, as in office-live.test.mjs
function animations() {
  const made = [];
  const animate = (target, frames, opts) => {
    let done;
    const a = { target, frames, opts, playState: 'running', finished: new Promise((res, rej) => { done = { res, rej }; }),
      pause() { a.playState = 'paused'; }, play() { a.playState = 'running'; },
      cancel() { a.playState = 'idle'; done.rej(new Error('AbortError')); }, finish() { a.playState = 'finished'; done.res(a); } };
    made.push(a);
    return a;
  };
  return { made, animate };
}
function openOffice({ animate, env = {}, configure, vm = fixture('view-model-office.json') } = {}) {
  const e = makeController({ modules: MODULES, configure: (ctx) => {
    ctx.document.createElementNS = (ns, tag) => {
      const n = Object.assign(ctx.document.createElement(tag), { namespaceURI: ns });
      if (animate) n.animate = (frames, opts) => animate(n, frames, opts);
      return n;
    };
    const sprite = Object.assign(ctx.document.createElement('svg'), { namespaceURI: SVG_NS });
    sprite.id = 'icon-sprite';
    ctx.document.body.appendChild(sprite);
    env.heard = [];
    ctx.matchMedia = (q) => ({ get matches() { return /reduce/.test(q) ? env.reduce === true : ctx.innerWidth < 900; },
      addEventListener: (type, fn) => { if (type === 'change') env.heard.push({ q, fn }); }, removeEventListener() {} });
    configure?.(ctx);
  } });
  e.page.receive(vm);
  e.fire(e.byId.rail.querySelector('[data-sh="view"][data-key="office"]'), 'click');
  const office = e.byId.main.querySelector('#office');
  office.querySelector('.of-scene').getScreenCTM = () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
  return { e, vm, office };
}
// the floor shown, as the model builds it (plain data)
function shown(e, office) {
  const sid = office.querySelector('.of-fl[aria-pressed="true"]').getAttribute('data-floor');
  return clone(e.ctx.BriefOffice.scene(e.page.state.model, e.page.state.ui, e.page.state.model.generatedAt)).floors.find((f) => f.sid === sid);
}
const me = (office) => office.querySelector('.of-me');
// the walk tile under the boss's feet, read off its drawn place
function bossAt(office) {
  const pos = office.querySelector('.of-me .of-walk').children[0];
  const p = floorPoint(/^translate\(([-\d.]+),([-\d.]+)\) scale\(1\)$/.exec(pos.getAttribute('transform')).slice(1).map(Number));
  return [Math.round(p[0] / TILE - 0.5), Math.round(p[1] / TILE - 0.5)];
}
const steps = (anims, office) => anims.made.filter((a) => a.target === office.querySelector('.of-me .of-walk'));
const running = (anims) => anims.made.filter((a) => a.playState === 'running');
function press(e, key, code, more = {}) {
  return e.fire(e.document.activeElement || e.document.body, 'keydown', { key, code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...more });
}
// a click on the floor drawing at walk tile x, y
function clickTile(e, office, x, y) {
  const [cx, cy] = iso((x + 0.5) * TILE, (y + 0.5) * TILE);
  return e.fire(office.querySelector('.of-l-base polygon'), 'click', { clientX: cx, clientY: cy });
}
// the boss's step under way, finished: its finished handler (the next step of a walk) has run when this resolves
async function finishStep(anims, office) {
  const a = steps(anims, office).filter((x) => x.playState === 'running').at(-1);
  assert.ok(a, 'a step is under way');
  a.finish();
  await a.finished;
  return a;
}
function free(floor, x, y) { return x >= 0 && y >= 0 && x < floor.walk.w && y < floor.walk.h && !floor.walk.blocked.includes(y * floor.walk.w + x); }
// the fewest steps from one walk tile to another over the free tiles (-1: none)
function shortest(floor, [x0, y0], [x1, y1]) {
  const w = floor.walk.w, dist = new Map([[y0 * w + x0, 0]]), queue = [y0 * w + x0];
  while (queue.length) {
    const at = queue.shift(), x = at % w, y = (at - x) / w;
    if (x === x1 && y === y1) return dist.get(at);
    for (const [dx, dy] of SIDES) if (free(floor, x + dx, y + dy) && !dist.has((y + dy) * w + x + dx)) { dist.set((y + dy) * w + x + dx, dist.get(at) + 1); queue.push((y + dy) * w + x + dx); }
  }
  return -1;
}
function reduceMotion(env, on) {
  env.reduce = on;
  for (const h of env.heard.filter((l) => /reduce/.test(l.q))) h.fn({ type: 'change', matches: on, media: h.q });
}
function tab(e, hidden) {
  e.document.hidden = hidden;
  e.document.visibilityState = hidden ? 'hidden' : 'visible';
  e.document.listeners.visibilitychange({ type: 'visibilitychange' });
}
// a free walk tile `rows` tiles up the hall from the spawn (the column from the lounge door to the upper rooms is free)
const upHall = (floor, rows) => [floor.spawn.x, floor.spawn.y - rows];
// every drawn label as its pill box in scene units, and the boss's drawing on walk tile x, y (head and body: CAT 46 at
// scale 1, its feet on the tile's middle)
function labelBoxes(office) {
  return office.querySelector('.of-l-top').children.filter((n) => n.querySelector('rect')).map((n) => {
    const [x, y] = /translate\(([-\d.]+),([-\d.]+)\)/.exec(n.getAttribute('transform')).slice(1).map(Number), r = n.querySelector('rect');
    const x0 = x + Number(r.getAttribute('x')), y0 = y + Number(r.getAttribute('y'));
    return { name: n.getAttribute('class') + ':' + n.textContent, x0, y0, x1: x0 + Number(r.getAttribute('width')), y1: y0 + Number(r.getAttribute('height')) };
  });
}
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
function bossBox(x, y) { const [fx, fy] = iso((x + 0.5) * TILE, (y + 0.5) * TILE); return { x0: fx - 23, x1: fx + 23, y0: fy - 46 * 1.42, y1: fy }; }
// the walk tiles the boss reaches from the spawn, nearest first
function reachOrder(floor) {
  const w = floor.walk.w, start = floor.spawn.y * w + floor.spawn.x, seen = new Set([start]), queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const x = queue[i] % w, y = (queue[i] - x) / w;
    for (const [dx, dy] of SIDES) if (free(floor, x + dx, y + dy) && !seen.has((y + dy) * w + x + dx)) { seen.add((y + dy) * w + x + dx); queue.push((y + dy) * w + x + dx); }
  }
  return queue.map((t) => [t % w, (t - (t % w)) / w]);
}
// a phone's pan frame: the scene's 720 px at 0.72 px a unit (viewBox x from 30) inside a 310 px frame at (12, 160) that
// scrolls; the scene's screen matrix follows the frame's scrollLeft, its scrollTo calls are recorded, and a hit rect's
// client box comes from its scene box (a desk's through its place group). The shell stays wide: its narrow overlay would
// make the office inert in this DOM
function phonePan({ animate, env = {} } = {}) {
  const k = 0.72, frame = { left: 12, top: 160, width: 310, height: 504 }, calls = [];
  let pan = null;
  const ctm = function () {
    const m = { a: k, b: 0, c: 0, d: k, e: frame.left - 30 * k - (this.parentNode ? this.parentNode.scrollLeft : 0), f: frame.top };
    return { ...m, inverse: () => ({ a: 1 / k, b: 0, c: 0, d: 1 / k, e: -m.e / k, f: -m.f / k }) };
  };
  const sceneBox = (r) => {
    const num = (a) => Number(r.getAttribute(a)), b = { x0: num('x'), y0: num('y'), x1: num('x') + num('width'), y1: num('y') + num('height') };
    const place = /translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+)\) translate/.exec(r.parentNode.getAttribute('transform') || '');
    if (!place) return b;
    const [ax, ay, s] = place.slice(1).map(Number);
    return { x0: ax + (b.x0 - 470) * s, x1: ax + (b.x1 - 470) * s, y0: ay + (b.y0 - 120) * s, y1: ay + (b.y1 - 120) * s };
  };
  const client = (b) => { const left = k * b.x0 + frame.left - 30 * k - pan.scrollLeft, top = k * b.y0 + frame.top; return { left, top, width: k * (b.x1 - b.x0), height: k * (b.y1 - b.y0) }; };
  const has = (n, c) => (n.getAttribute('class') || '').split(' ').includes(c);
  const opened = openOffice({ animate, env, configure: (ctx) => {
    const make = ctx.document.createElement, get = ctx.rects.get.bind(ctx.rects);
    ctx.document.createElement = (tag) => {
      const n = make(tag);
      n.scrollLeft = 0;
      n.getScreenCTM = ctm;
      n.scrollTo = function (o) { calls.push({ left: o.left, behavior: o.behavior }); this.scrollLeft = Math.max(0, Math.min(o.left, 720 - frame.width)); };
      Object.defineProperty(n, 'scrollWidth', { get() { return has(this, 'of-pan') ? 720 : 0; } });
      return n;
    };
    ctx.rects.get = (n) => get(n) || (has(n, 'of-pan') ? frame : has(n, 'of-hit') && pan ? client(sceneBox(n)) : undefined);
  } });
  opened.office.querySelector('.of-scene').getScreenCTM = ctm;
  pan = opened.office.querySelector('.of-pan');
  const hitBox = (u) => { const r = client(sceneBox(u.querySelector('.of-hit'))); return { ...r, right: r.left + r.width }; };
  return { ...opened, k, frame, calls, pan, hitBox };
}

test('the boss cat stands at the lounge door of the shown floor in its gold crown, and it is no desk, session or count', () => {
  // Given the fixture board, When 사무실 opens, Then one boss cat stands on the floor's spawn tile with the crown, and the
  // desks, the desk refs, the floor card and the 사무실 사람들 count are those of the scene alone
  const { e, office } = openOffice();
  const floor = shown(e, office), cats = office.querySelectorAll('.of-me');
  assert.equal(cats.length, 1);
  assert.equal(cats[0].getAttribute('aria-hidden'), 'true');
  assert.equal(cats[0].parentNode, office.querySelector('.of-l-depth'));
  assert.equal(cats[0].closest('[data-desk],[data-sh]'), null, 'not a desk or an action');
  assert.deepEqual(bossAt(office), [floor.spawn.x, floor.spawn.y]);
  const crown = cats[0].querySelectorAll('polygon');
  assert.deepEqual(crown.map((p) => [p.getAttribute('points'), p.getAttribute('fill')]), [['38,19 36,7 43,12 50,3 57,12 64,7 62,19', '#ffcf5a']], 'the mockup crown in gold');
  assert.equal(office.querySelectorAll('.of-desk').length, floor.desks.length);
  assert.deepEqual(Object.keys(e.ctx.__office.desks).sort(), floor.desks.map((d) => d.id).sort());
  assert.match(office.querySelector('.of-card small').textContent, new RegExp('작업자 ' + (floor.desks.length - 1) + '명'));
  assert.match(office.querySelectorAll('.of-box h3 small')[2].textContent, new RegExp('^' + floor.desks.length + '명'));
});

test('arrow keys and W/A/S/D step one walk tile along the map axes, each one el.animate() of 140 ms; a blocked tile refuses the step', async () => {
  // Given the boss at the spawn, When the keys are pressed one by one, Then each moves it one tile (Right +x, Left -x,
  // Up -y, Down +y) with one 140 ms step from its old place to none, and a step into a blocked tile does nothing at all
  const anims = animations(), { e, office } = openOffice({ animate: anims.animate });
  const floor = shown(e, office), [sx, sy] = [floor.spawn.x, floor.spawn.y];
  const moves = [['ArrowUp', 'ArrowUp', [0, -1]], ['w', 'KeyW', [0, -1]], ['ArrowRight', 'ArrowRight', [1, 0]], ['d', 'KeyD', [1, 0]],
    ['ArrowLeft', 'ArrowLeft', [-1, 0]], ['a', 'KeyA', [-1, 0]], ['ArrowDown', 'ArrowDown', [0, 1]], ['s', 'KeyS', [0, 1]]];
  let at = [sx, sy];
  for (const [key, code, [dx, dy]] of moves) {
    const before = steps(anims, office).length, ev = press(e, key, code);
    assert.equal(ev.defaultPrevented, true, key + ' is the office\'s');
    const made = steps(anims, office);
    assert.equal(made.length, before + 1, key + ': one step');
    assert.equal(made.at(-1).opts.duration, 140);
    assert.deepEqual(clone(made.at(-1).frames.at(-1)), { transform: 'none' });
    assert.match(made.at(-1).frames[0].transform, /^translate\([-\d.]+px,[-\d.]+px\)$/);
    at = [at[0] + dx, at[1] + dy];
    assert.deepEqual(bossAt(office), at, key);
    await finishStep(anims, office);
  }
  // to the right of the spawn the lounge plant blocks the way: walk right until refused
  let refusedAt = null;
  for (let i = 0; i < 10 && !refusedAt; i++) {
    const before = steps(anims, office).length, place = bossAt(office), ev = press(e, 'ArrowRight', 'ArrowRight');
    if (steps(anims, office).length === before) { refusedAt = place; assert.equal(ev.defaultPrevented, true); assert.deepEqual(bossAt(office), place); }
    else await finishStep(anims, office);
  }
  assert.ok(refusedAt, 'a blocked tile refused the step');
  assert.equal(free(floor, refusedAt[0] + 1, refusedAt[1]), false, 'the tile it refused is blocked');
  assert.deepEqual(running(anims), [], 'nothing runs after a refusal');
});

test('a fresh key during a key step finishes that step and steps again; a held key\'s repeat waits for the step', async () => {
  // Given a key step under way, When the key is pressed again, Then that step ends at its tile and the next one starts;
  // When a repeat (held key) arrives during a step, Then nothing changes
  const anims = animations(), { e, office } = openOffice({ animate: anims.animate });
  const floor = shown(e, office);
  press(e, 'ArrowUp', 'ArrowUp');
  const first = steps(anims, office)[0];
  press(e, 'ArrowUp', 'ArrowUp');
  assert.equal(first.playState, 'idle', 'the first step ended');
  assert.deepEqual(bossAt(office), [floor.spawn.x, floor.spawn.y - 2], 'two presses, two tiles');
  assert.equal(steps(anims, office).length, 2);
  press(e, 'ArrowUp', 'ArrowUp', { repeat: true });
  assert.equal(steps(anims, office).length, 2, 'the repeat waits');
  assert.deepEqual(bossAt(office), [floor.spawn.x, floor.spawn.y - 2]);
  await finishStep(anims, office);
  press(e, 'ArrowUp', 'ArrowUp', { repeat: true });
  assert.equal(steps(anims, office).length, 3, 'a repeat after the step steps');
  assert.deepEqual(bossAt(office), [floor.spawn.x, floor.spawn.y - 3]);
});

test('the keys stay with text fields, modifiers, other handlers and other views: nothing moves and the key is not taken', () => {
  // Given the office shown, When "wasd" and the arrows are typed with the focus in an input, textarea, select,
  // contenteditable, the sidebar search box or an annotate tray textarea, or with Ctrl/Alt/Meta, or already taken, or
  // under the narrow overlay (inert), or after leaving the office, Then the boss stays and no key is prevented
  const anims = animations(), { e, office } = openOffice({ animate: anims.animate });
  const floor = shown(e, office), home = [floor.spawn.x, floor.spawn.y];
  const keys = [['w', 'KeyW'], ['a', 'KeyA'], ['s', 'KeyS'], ['d', 'KeyD'], ['ArrowUp', 'ArrowUp'], ['ArrowRight', 'ArrowRight'], ['ArrowDown', 'ArrowDown'], ['ArrowLeft', 'ArrowLeft']];
  const quiet = (label, more = {}) => {
    for (const [key, code] of keys) {
      const ev = press(e, key, code, more);
      if (!more.defaultPrevented) assert.notEqual(ev.defaultPrevented, true, label + ': ' + key + ' not taken');
    }
    assert.equal(steps(anims, office).length, 0, label + ': no step');
    assert.deepEqual(bossAt(office), home, label + ': the boss stayed');
  };
  const pop = e.document.createElement('div');
  pop.setAttribute('class', 'pop');
  e.document.body.appendChild(pop);
  const fields = { input: e.document.createElement('input'), textarea: e.document.createElement('textarea'), select: e.document.createElement('select'), editable: e.document.createElement('div') };
  fields.editable.isContentEditable = true;
  fields.tray = pop.appendChild(e.document.createElement('textarea'));
  fields.tray.setAttribute('class', 'pt');
  for (const [name, n] of Object.entries(fields)) { if (!n.parentNode) office.appendChild(n); n.focus(); quiet(name); }
  e.byId['sh-q'].focus();
  quiet('the sidebar search box');
  e.document.body.focus();
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) quiet(mod, { [mod]: true });
  quiet('taken by another handler', { defaultPrevented: true });
  office.parentNode.setAttribute('inert', '');
  quiet('under the narrow overlay');
  office.parentNode.removeAttribute('inert');
  e.fire(e.byId.rail.querySelector('[data-sh="view"][data-key="inbox"]'), 'click');
  assert.equal(e.byId.main.querySelector('#office'), null, 'the office left');
  for (const [key, code] of keys) assert.notEqual(press(e, key, code).defaultPrevented, true, 'another view: ' + key);
  assert.equal(steps(anims, office).length, 0);
  // the positive control: the same key on the shown office steps
  e.fire(e.byId.rail.querySelector('[data-sh="view"][data-key="office"]'), 'click');
  assert.equal(press(e, 'w', 'KeyW').defaultPrevented, true);
});

test('a click on a floor tile walks the shortest way there: one el.animate() per step, each next step from the last one\'s finished promise', async () => {
  // Given the boss at the spawn, When a free tile up the hall and to the right is clicked, Then the boss steps tile by tile
  // to it, one step at a time, as many steps as the shortest way, each step to a free neighbouring tile
  const anims = animations(), { e, office } = openOffice({ animate: anims.animate });
  const floor = shown(e, office), goal = [floor.spawn.x + 6, floor.spawn.y - 4];
  assert.ok(free(floor, ...goal));
  const want = shortest(floor, [floor.spawn.x, floor.spawn.y], goal);
  assert.ok(want >= 10, 'a walk of ' + want + ' steps');
  clickTile(e, office, ...goal);
  const visited = [[floor.spawn.x, floor.spawn.y]];
  for (let i = 0; i < want; i++) {
    assert.equal(running(anims).length, 1, 'one step at a time');
    const now = bossAt(office), last = visited.at(-1);
    assert.equal(Math.abs(now[0] - last[0]) + Math.abs(now[1] - last[1]), 1, 'to a neighbouring tile');
    assert.ok(free(floor, ...now));
    visited.push(now);
    await finishStep(anims, office);
  }
  assert.deepEqual(bossAt(office), goal);
  assert.deepEqual(running(anims), [], 'arrived: nothing runs');
  assert.equal(steps(anims, office).length, want);
});

test('a click on the floor tile next to a desk ends the walk on that tile, beside the desk; a click on the desk is still its open action', async () => {
  // Given the lead's desk, When the free tile in front of it is clicked, Then the walk ends there, next to the desk;
  // When the desk itself is clicked, Then the conversation opens as before
  const anims = animations(), { e, office } = openOffice({ animate: anims.animate });
  const floor = shown(e, office), c = clone(e.ctx.BriefOfficeView.layout(floor)).lead;
  const front = [Math.floor((c.x + 0.8 * c.s) / TILE), Math.ceil((c.y + c.s + 0.1) / TILE - 0.5)];
  assert.ok(free(floor, ...front), 'the tile in front of the desk is free');
  assert.equal(free(floor, front[0], front[1] - 1), false, 'its back neighbour is the desk');
  const n = shortest(floor, [floor.spawn.x, floor.spawn.y], front);
  clickTile(e, office, ...front);
  for (let i = 0; i < n; i++) await finishStep(anims, office);
  assert.deepEqual(bossAt(office), front);
  // the desk's own click starts no walk, even at a point whose floor tile is free: it is the desk's open action only
  const made = steps(anims, office).length, hall = upHall(floor, 3), [cx, cy] = iso((hall[0] + 0.5) * TILE, (hall[1] + 0.5) * TILE);
  assert.ok(free(floor, ...hall));
  e.fire(office.querySelector('.of-desk[data-desk="lead"] polygon'), 'click', { clientX: cx, clientY: cy });
  assert.equal(steps(anims, office).length, made, 'the desk click starts no walk');
  assert.deepEqual(bossAt(office), front, 'the boss stays beside the desk');
  assert.equal(e.page.state.ui.view, 'conv', 'the desk click opened the conversation');
});

test('a click on a blocked tile, a walled-in tile or off the floor is refused: no step, no movement, no exception', () => {
  // Given a fixture floor whose walk tile five rows up the hall is walled in on all four sides, When it, a blocked tile and
  // a point off the floor are clicked, Then the boss does not move and nothing throws
  const anims = animations(), errors = [];
  const { e, office } = openOffice({ animate: anims.animate, configure: (ctx) => {
    const real = ctx.BriefOffice.scene;
    ctx.BriefOffice.scene = (vm, ui, now) => {
      const s = real(vm, ui, now), f = s.floors[0], w = f.walk.w, [x, y] = [f.spawn.x, f.spawn.y - 5];
      f.walk.blocked = [...new Set(f.walk.blocked.concat(SIDES.map(([dx, dy]) => (y + dy) * w + x + dx)))].sort((a, b) => a - b);
      return s;
    };
  } });
  const floor = shown(e, office), home = [floor.spawn.x, floor.spawn.y], walled = [floor.spawn.x, floor.spawn.y - 5];
  assert.ok(free(floor, ...walled) && SIDES.every(([dx, dy]) => !free(floor, walled[0] + dx, walled[1] + dy)), 'the fixture tile is free and walled in');
  const blocked = [floor.walk.blocked[0] % floor.walk.w, Math.floor(floor.walk.blocked[0] / floor.walk.w)];
  for (const [label, target] of [['walled in', walled], ['blocked', blocked], ['off the floor', [-4, -4]]]) {
    try { clickTile(e, office, ...target); } catch (err) { errors.push(label + ': ' + err.message); }
    assert.equal(steps(anims, office).length, 0, label + ': no step');
    assert.deepEqual(bossAt(office), home, label + ': no movement');
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(e.errors, [], 'the page reported nothing');
});

test('a new key or click ends a click walk on the tile it last reached, and Escape does too; the ended step leaves nothing running and no unhandled rejection', { timeout: 10000 }, async () => {
  // Given a click walk two steps in, When a key, a new click or Escape comes, Then the step under way is cancelled, the
  // boss is on the last tile it reached (then the new step or walk starts there), and no rejection goes unhandled
  const unhandled = [], note = (why) => unhandled.push(String(why));
  process.on('unhandledRejection', note);
  try {
    const anims = animations(), { e, office } = openOffice({ animate: anims.animate });
    const floor = shown(e, office), goal = upHall(floor, 8);
    for (const [label, interrupt] of [['a key', () => press(e, 'ArrowLeft', 'ArrowLeft')], ['a click', () => clickTile(e, office, floor.spawn.x, floor.spawn.y)], ['Escape', () => press(e, 'Escape', 'Escape')]]) {
      clickTile(e, office, ...goal);
      await finishStep(anims, office);
      await finishStep(anims, office);
      const last = bossAt(office), pending = running(anims);
      assert.equal(pending.length, 1, label + ': two steps done, the third under way');
      assert.notDeepEqual(last, goal);
      const reached = [last[0], last[1] + 1];
      const ev = interrupt();
      assert.equal(pending[0].playState, 'idle', label + ': the step under way was cancelled');
      if (label === 'Escape') {
        assert.notEqual(ev.defaultPrevented, true, 'Escape is not taken from anyone');
        assert.deepEqual(bossAt(office), reached, 'it stays on the tile it last reached');
        assert.deepEqual(running(anims), []);
      } else if (label === 'a key') {
        assert.deepEqual(bossAt(office), [reached[0] - 1, reached[1]], 'the key steps from the tile it last reached');
        await finishStep(anims, office);
        clickTile(e, office, floor.spawn.x, floor.spawn.y);
        while (running(anims).length) await finishStep(anims, office);
      } else {
        assert.equal(running(anims).length, 1, 'the new walk starts');
        assert.deepEqual(bossAt(office), [reached[0], reached[1] + 1], 'from the tile it last reached, back down the hall');
        while (running(anims).length) await finishStep(anims, office);
        assert.deepEqual(bossAt(office), [floor.spawn.x, floor.spawn.y]);
      }
    }
    await Promise.allSettled(anims.made.map((a) => a.finished));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
  } finally {
    process.off('unhandledRejection', note);
  }
});

test('reduced motion: keys and clicks move the boss at once; turned on during a walk it ends on the walk\'s last tile; turned off nothing comes back', async () => {
  // Given reduced motion, When a key and a click come, Then the boss is there at once with no animation; Given a click walk
  // under way, When reduced motion turns on, Then nothing of the office runs and the boss is on the walk's last tile;
  // When it turns off again, Then nothing restarts and the next click walks step by step
  const anims = animations(), env = {}, { e, office } = openOffice({ animate: anims.animate, env });
  const floor = shown(e, office);
  env.reduce = true;
  press(e, 'ArrowUp', 'ArrowUp');
  assert.deepEqual(bossAt(office), [floor.spawn.x, floor.spawn.y - 1]);
  clickTile(e, office, ...upHall(floor, 6));
  assert.deepEqual(bossAt(office), upHall(floor, 6));
  assert.equal(steps(anims, office).length, 0, 'no step under reduced motion');
  env.reduce = false;
  clickTile(e, office, floor.spawn.x, floor.spawn.y);
  await finishStep(anims, office);
  assert.equal(running(anims).length, 1, 'mid walk');
  reduceMotion(env, true);
  assert.deepEqual(running(anims), [], 'nothing of the office runs');
  assert.deepEqual(anims.made.map((a) => a.playState).filter((s) => s !== 'finished' && s !== 'idle'), []);
  assert.deepEqual(bossAt(office), [floor.spawn.x, floor.spawn.y], 'on the walk\'s last tile');
  const ended = anims.made.length;
  reduceMotion(env, false);
  assert.equal(anims.made.length, ended, 'nothing restarts');
  assert.deepEqual(running(anims), []);
  clickTile(e, office, ...upHall(floor, 2));
  assert.equal(running(anims).length, 1, 'the next click walks again');
});

test('a hidden tab holds the boss\'s step and plays it on when shown; with reduced motion, in either order, the walk ends on its last tile', async () => {
  // Given a click walk under way, When the tab hides and shows, Then its step pauses and plays on; Given a walk held by a
  // hidden tab, When reduced motion is heard while hidden, or only met when the tab is back, Then the boss is on the
  // walk's last tile and nothing runs or waits
  for (const heard of [null, true, false]) {
    const anims = animations(), env = {}, { e, office } = openOffice({ animate: anims.animate, env });
    const floor = shown(e, office), goal = upHall(floor, 5);
    clickTile(e, office, ...goal);
    const step = running(anims)[0];
    tab(e, true);
    assert.equal(step.playState, 'paused', 'held while hidden');
    assert.equal(office.getAttribute('data-motion'), 'paused');
    if (heard === null) {
      tab(e, false);
      assert.equal(step.playState, 'running', 'plays on when shown');
      continue;
    }
    if (heard) reduceMotion(env, true);
    else env.reduce = true;
    tab(e, false);
    assert.equal(step.playState, 'idle', (heard ? 'heard' : 'met') + ': the held step ended');
    assert.deepEqual(running(anims), []);
    assert.deepEqual(bossAt(office), goal, (heard ? 'heard' : 'met') + ': on the last tile');
  }
  // a step that starts while the tab is hidden (a click dispatched by script) is held at once and plays when shown
  const anims = animations(), { e, office } = openOffice({ animate: anims.animate });
  const floor = shown(e, office);
  tab(e, true);
  clickTile(e, office, ...upHall(floor, 2));
  const step = steps(anims, office)[0];
  assert.equal(step && step.playState, 'paused', 'a step started on a hidden tab is held');
  tab(e, false);
  assert.equal(step.playState, 'running', 'and plays when shown');
});

test('another floor starts the boss at that floor\'s lounge door and ends its walk; it is the shown floor\'s only animation of its own', async () => {
  // Given a click walk under way, When another floor is picked, Then the walk's step is cancelled and the one boss stands
  // at the new floor's spawn; back on the first floor it starts at the door again
  const anims = animations(), { e, office } = openOffice({ animate: anims.animate });
  const first = shown(e, office);
  clickTile(e, office, ...upHall(first, 6));
  await finishStep(anims, office);
  const step = running(anims)[0];
  e.fire(office.querySelectorAll('.of-fl')[1], 'click');
  const second = shown(e, office);
  assert.notEqual(second.sid, first.sid);
  assert.equal(step.playState, 'idle', 'the old floor\'s walk ended');
  assert.deepEqual(running(anims).filter((a) => a.target === office.querySelector('.of-me .of-walk')), []);
  assert.equal(office.querySelectorAll('.of-me').length, 1);
  assert.deepEqual(bossAt(office), [second.spawn.x, second.spawn.y]);
  press(e, 'ArrowUp', 'ArrowUp');
  e.fire(office.querySelectorAll('.of-fl')[0], 'click');
  assert.deepEqual(bossAt(office), [first.spawn.x, first.spawn.y]);
});

test('labels step aside from the boss cat once it stops: no bubble, desk name or belt label stays on its drawing', async () => {
  // Given a tile the boss reaches where a label now lies on its drawing, When it walks there and stops (a click walk with
  // motion, then under reduced motion a walk that ends at once), Then no label but the rooms' and the boss desk's own count
  // lies on the boss
  const anims = animations(), env = {}, { e, office } = openOffice({ animate: anims.animate, env }), floor = shown(e, office);
  const fixed = (b) => /^of-room:|^of-bub:할 일 /.test(b.name);
  const covered = ([x, y]) => labelBoxes(office).filter((b) => !fixed(b) && overlap(b, bossBox(x, y))).map((b) => b.name);
  const target = reachOrder(floor).find((t) => covered(t).length);
  assert.ok(target, 'a reachable tile under a label');
  clickTile(e, office, ...target);
  while (steps(anims, office).some((a) => a.playState === 'running')) await finishStep(anims, office);
  assert.deepEqual(bossAt(office), target);
  assert.deepEqual(covered(target), []);
  reduceMotion(env, true);
  const again = reachOrder(floor).find((t) => covered(t).length && shortest(floor, target, t) > 0);
  assert.ok(again, 'another reachable tile under a label');
  clickTile(e, office, ...again);
  assert.deepEqual(bossAt(office), again);
  assert.deepEqual(covered(again), []);
});

test('on a phone the pan frame keeps the boss in view: scrolled to it when its floor is drawn, again when it stops near an edge; a hand pan stays', async () => {
  // Given a phone's pan frame (phonePan: scrolled to 0), When 사무실 opens, Then the frame was scrolled at once (instant)
  // so the boss's drawing is inside it; When the boss steps up the hall towards the frame's right edge, Then after every
  // step it is still inside, scrolled smoothly from the step's own finish (no timer); a hand pan away and a publish do not
  // scroll the frame back; under reduced motion the next step scrolls at once
  const env = {}, anims = animations(), { e, office, vm, k, frame, calls, pan } = phonePan({ animate: anims.animate, env });
  const floor = shown(e, office);
  const inFrame = () => { const b = bossBox(...bossAt(office)), x0 = k * b.x0 + frame.left - 30 * k - pan.scrollLeft, x1 = k * b.x1 + frame.left - 30 * k - pan.scrollLeft; return x0 >= frame.left && x1 <= frame.left + frame.width; };
  assert.deepEqual(bossAt(office), [floor.spawn.x, floor.spawn.y]);
  assert.ok(calls.length >= 1 && calls.every((c) => c.behavior === 'instant'), JSON.stringify(calls));
  assert.ok(pan.scrollLeft > 0 && inFrame(), 'the spawn is in the frame');
  const timers = e.timers.length, first = calls.length;
  for (let i = 1; i <= 6; i++) {
    press(e, 'ArrowUp', 'ArrowUp');
    await finishStep(anims, office);
    assert.deepEqual(bossAt(office), upHall(floor, i));
    assert.ok(inFrame(), 'in the frame after step ' + i);
  }
  assert.ok(calls.length > first && calls.slice(first).every((c) => c.behavior === 'smooth'), JSON.stringify(calls.slice(first)));
  assert.equal(e.timers.length, timers, 'no timer');
  pan.scrollLeft = 0;
  const before = calls.length;
  vm.seq = e.page.state.seq + 1;
  e.advance(600);
  e.page.receive(clone(vm));
  assert.deepEqual([calls.length, pan.scrollLeft], [before, 0], 'a hand pan stays');
  reduceMotion(env, true);
  press(e, 'ArrowUp', 'ArrowUp');
  assert.deepEqual(bossAt(office), upHall(floor, 7));
  assert.ok(inFrame() && calls.length > before && calls.at(-1).behavior === 'instant', JSON.stringify(calls.slice(before)));
});

test('on a phone a desk or cat that takes the focus is brought whole into the pan frame at once; one wholly in it keeps the frame', () => {
  // Given the phone's pan frame with the leftmost desk cut 20 px by the frame's left edge, When that desk takes the focus
  // (Tab), Then the frame scrolls at once (instant, from the focus event: no timer) until the desk's hit rect, where its
  // focus ring is drawn, lies inside; When a desk wholly inside takes the focus, Then the frame stays where it is
  const { e, office, frame, calls, pan, hitBox } = phonePan();
  const units = office.querySelectorAll('.of-desk'), leftmost = units.slice().sort((a, b) => hitBox(a).left - hitBox(b).left)[0];
  pan.scrollLeft += hitBox(leftmost).left - frame.left + 20;
  assert.ok(hitBox(leftmost).left < frame.left, 'the desk is cut by the frame');
  const timers = e.timers.length, before = calls.length;
  e.fire(leftmost, 'focusin');
  const b = hitBox(leftmost);
  assert.ok(b.left >= frame.left && b.right <= frame.left + frame.width, JSON.stringify(b));
  assert.deepEqual([calls.length - before, calls.at(-1).behavior, e.timers.length], [1, 'instant', timers]);
  const inside = units.find((u) => hitBox(u).left > frame.left + 9 && hitBox(u).right < frame.left + frame.width - 9), at = pan.scrollLeft;
  e.fire(inside, 'focusin');
  assert.deepEqual([pan.scrollLeft, calls.length - before], [at, 1]);
});

test('the boss is painted after what it stands in front of and before what it stands behind', () => {
  // Given the lead's desk, When the boss stands on the tile right behind it and then right in front of it, Then its node
  // comes before the desk in the depth layer, then after it
  const env = { reduce: true }, { e, office } = openOffice({ env });
  const floor = shown(e, office), c = clone(e.ctx.BriefOfficeView.layout(floor)).lead;
  const col = Math.floor((c.x + 0.8 * c.s) / TILE), behind = [col, Math.floor((c.y - 0.1) / TILE - 0.5)], front = [col, Math.ceil((c.y + c.s + 0.1) / TILE - 0.5)];
  assert.ok(free(floor, ...behind) && free(floor, ...front));
  const order = () => { const kids = office.querySelector('.of-l-depth').children; return kids.indexOf(me(office)) - kids.indexOf(office.querySelector('.of-desk[data-desk="lead"]')); };
  clickTile(e, office, ...behind);
  assert.deepEqual(bossAt(office), behind);
  assert.ok(order() < 0, 'behind the desk: painted first');
  clickTile(e, office, ...front);
  assert.deepEqual(bossAt(office), front);
  assert.ok(order() > 0, 'in front of the desk: painted after it');
});

test('the walk map is the drawing: the walk tiles under every drawn prop, glass wall and desk are blocked', () => {
  // Given the office drawn, When each prop's, glass wall's and desk's floor footprint is read off its drawing (the art's
  // lowest corners, the glass's floor edge, the desk's place), Then every walk tile whose middle is under it is blocked
  const { e, office } = openOffice();
  const floor = shown(e, office), w = floor.walk.w, off = new Set(floor.walk.blocked);
  const pointsOf = (g) => g.querySelectorAll('polygon').flatMap((p) => p.getAttribute('points').trim().split(/\s+/).map((xy) => xy.split(',').map(Number)));
  const shift = (g) => { const m = /^translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform') || ''); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };
  // a box drawn in the projection stands on the corners at its lowest screen points: the front one and the outermost two
  const footprint = (pts) => {
    const low = (list) => list.sort((a, b) => b[1] - a[1])[0];
    const front = floorPoint(low([...pts])), minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
    const left = floorPoint(low(pts.filter((p) => p[0] === minX))), right = floorPoint(low(pts.filter((p) => p[0] === maxX)));
    return [left[0] - left[1] + front[1], front[0] - (right[0] - right[1]), front[0], front[1]];
  };
  const under = ([x0, y0, x1, y1]) => {
    const out = [[Math.floor((x0 + x1) / 2 / TILE), Math.floor((y0 + y1) / 2 / TILE)]];
    for (let y = 0; y < floor.walk.h; y++) for (let x = 0; x < w; x++) if ((x + 0.5) * TILE > x0 && (x + 0.5) * TILE < x1 && (y + 0.5) * TILE > y0 && (y + 0.5) * TILE < y1) out.push([x, y]);
    return out;
  };
  const check = (label, rect) => { for (const [x, y] of under(rect)) assert.ok(off.has(y * w + x), label + ' ' + rect.map((n) => n.toFixed(2)) + ': tile ' + [x, y]); };
  const depth = office.querySelector('.of-l-depth').children.filter((g) => !g.hasAttribute('data-desk') && !g.classList.contains('of-me'));
  assert.equal(depth.length, 12, 'eleven props and the boss\'s desk');
  for (const g of depth) {
    const [dx, dy] = shift(g);
    check('prop', footprint(pointsOf(g).map(([x, y]) => [x + dx, y + dy])));
  }
  const base = office.querySelector('.of-l-base'), shelf = e.ctx.BriefOfficeArt.props.shelf.match(/points="([^"]+)"/)[1];
  const shelfBox = base.children.find((g) => g.tagName === 'G' && g.querySelector('polygon')?.getAttribute('points') === shelf);
  assert.ok(shelfBox, 'the bookshelf is drawn with the floor');
  check('bookshelf', footprint(pointsOf(shelfBox)));
  const glass = base.children.filter((n) => n.tagName === 'POLYGON' && n.getAttribute('fill') === '#a8dcff');
  assert.equal(glass.length, 4);
  for (const pane of glass) {
    const [p0, p1] = pane.getAttribute('points').split(' ').slice(0, 2).map((xy) => floorPoint(xy.split(',').map(Number)));
    const col = Math.floor(p0[0] / TILE);
    for (let y = 0; y < floor.walk.h; y++) if ((y + 0.5) * TILE >= Math.min(p0[1], p1[1]) + 0.01 && (y + 0.5) * TILE <= Math.max(p0[1], p1[1]) - 0.01) assert.ok(off.has(y * w + col), 'glass ' + [p0, p1] + ': tile ' + [col, y]);
  }
  for (const d of office.querySelectorAll('.of-desk')) {
    const slide = d.querySelector('.of-slide');
    if (!slide) continue;
    const place = slide.children[0];
    const [sx, sy, s] = /^translate\(([-\d.]+),([-\d.]+)\) scale\(([\d.]+)\)/.exec(place.getAttribute('transform')).slice(1).map(Number);
    const [x, y] = floorPoint([sx, sy]);
    check('desk ' + d.getAttribute('data-desk'), [x, y, x + 1.6 * s, y + s]);
  }
});

test('the boss\'s place stays in the page: the office files never store or send anything, and walking calls no timer, storage or request', async () => {
  // Given spies on every timer, storage write and request, When the boss walks by keys and clicks, Then no call comes from
  // the office files, and their source names none of those
  for (const f of OFFICE_JS) assert.doesNotMatch(read('src/page/' + f), /\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB)\b|\.cookie\b/, f);
  const calls = [], limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 200;
  try {
    const anims = animations(), { e, office } = openOffice({ animate: anims.animate, configure: (ctx) => {
      const spy = (owner, name) => { const real = owner[name]; owner[name] = function (...args) { calls.push({ name, stack: new Error().stack }); return real ? real.apply(this, args) : undefined; }; };
      for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'fetch']) spy(ctx, name);
      spy(ctx.localStorage, 'setItem');
      spy(ctx.sessionStorage, 'setItem');
      ctx.navigator.sendBeacon = () => true;
      spy(ctx.navigator, 'sendBeacon');
    } });
    const floor = shown(e, office);
    press(e, 'ArrowUp', 'ArrowUp');
    press(e, 'd', 'KeyD');
    await finishStep(anims, office);
    clickTile(e, office, ...upHall(floor, 6));
    while (running(anims).length) await finishStep(anims, office);
    press(e, 'Escape', 'Escape');
    e.fire(office.querySelectorAll('.of-fl')[1], 'click');
    assert.deepEqual(calls.filter((c) => /office-(?:assets|model|view)\.js/.test(c.stack)).map((c) => c.name), []);
  } finally {
    Error.stackTraceLimit = limit;
  }
});
