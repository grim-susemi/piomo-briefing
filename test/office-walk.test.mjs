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
