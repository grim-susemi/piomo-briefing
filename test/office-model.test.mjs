// Scene model (src/page/office-model.js): the board view-model -> office scene. Pure: the scene is data, nothing is
// drawn or fetched here. Input = test/fixtures/view-model.json plus worker rows from view-model-workers.json and hostile
// text from hostile-strings.json, overlaid in the test so every rule is exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeController } from './fixtures/controller-dom.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const fixture = (p) => JSON.parse(read('test/fixtures/' + p));
const clone = (v) => JSON.parse(JSON.stringify(v));
const SRC = read('src/page/office-model.js');
const HOSTILE = fixture('hostile-strings.json');

function load() {
  return makeController({ modules: ['icons', 'view', 'plan-view', 'shell', 'office-model'] }).ctx;
}

// the model runs inside the page's vm context, so its objects come from another realm: copy them to plain data
function sceneOf(ctx, vm, ui) {
  return clone(ctx.BriefOffice.scene(vm, ui, vm.generatedAt));
}

function input() {
  const vm = clone(fixture('view-model.json'));
  const workers = Object.fromEntries(fixture('view-model-workers.json').sessions.map((s) => [s.id, s]));
  const byId = Object.fromEntries(vm.sessions.map((s) => [s.id, s]));
  byId['s-a1'].alive = true;
  byId['s-a2'].alive = true;
  byId['s-b2'].alive = true;
  byId['s-a1'].title = HOSTILE[1];
  byId['s-a1'].plan = {
    goal: '목표', waves: [{ n: 1, label: '하나' }, { n: 2, label: '둘' }],
    tasks: [
      { id: '1', wave: 1, label: 'a', what: 'w', done: 'd', state: 'done', deps: [] },
      { id: '2', wave: 2, label: 'b', what: 'w', done: 'd', state: 'todo', deps: [] },
    ],
  };
  byId['s-a2'].live = { workers: clone(workers['s-w1'].live.workers) };
  byId['s-a2'].live.workers[2].step = HOSTILE[2];
  byId['s-b2'].live = { workers: clone(workers['s-w2'].live.workers) };
  return { vm, ui: { publicMode: false, seen: {} } };
}

const workerRows = (vm) => vm.sessions.flatMap((s) => (s.live && s.live.workers) || []);
const leaves = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out));
  return out;
};

test('each vm session is one floor, exactly once', () => {
  // Given the fixture board, When the scene is built, Then every session id appears once as a floor
  const { vm, ui } = input();
  const scene = sceneOf(load(), vm, ui);
  assert.deepEqual(scene.floors.map((f) => f.sid).sort(), vm.sessions.map((s) => s.id).sort());
});

test('each worker row is one worker desk, exactly once', () => {
  // Given worker rows on two sessions, When the scene is built, Then each worker id is one desk on its own floor
  const { vm, ui } = input();
  const scene = sceneOf(load(), vm, ui);
  const desks = scene.floors.flatMap((f) => f.desks.filter((d) => d.kind === 'worker').map((d) => d.id));
  assert.deepEqual(desks.sort(), workerRows(vm).map((w) => w.id).sort());
});

test('each session has exactly one lead desk in the work room, without an agent field', () => {
  // Given every session, When the scene is built, Then each floor has one kind-lead desk with no agent
  const { vm, ui } = input();
  const scene = sceneOf(load(), vm, ui);
  for (const floor of scene.floors) {
    const leads = floor.desks.filter((d) => d.kind === 'lead');
    assert.equal(leads.length, 1, floor.sid);
    assert.equal(leads[0].room, 'work', floor.sid);
    assert.equal('agent' in leads[0], false, floor.sid);
  }
});

test('a worker bubble is that worker step', () => {
  // Given worker steps (one hostile), When the scene is built in normal mode, Then each worker bubble equals its step
  const { vm, ui } = input();
  const scene = sceneOf(load(), vm, ui);
  const steps = Object.fromEntries(workerRows(vm).map((w) => [w.id, w.step || '']));
  const workers = scene.floors.flatMap((f) => f.desks.filter((d) => d.kind === 'worker'));
  assert.ok(workers.some((d) => d.bubble !== ''), 'at least one bubble carries a step');
  for (const d of workers) assert.equal(d.bubble, steps[d.id], d.id);
});

test('the ceo count equals the inbox badge and matches its items', () => {
  // Given the board, When the scene is built, Then ceo.count is BriefShell.badge and items are the inbox wait + done
  const { vm, ui } = input();
  const ctx = load();
  const scene = sceneOf(ctx, vm, ui);
  assert.equal(scene.ceo.count, ctx.BriefShell.badge(vm, ui));
  const inbox = ctx.BriefShell.inbox(vm, ui);
  assert.equal(scene.ceo.items.length, inbox.wait.length + inbox.done.length);
});

test('hostile text reaches the scene only as the plain string it was', () => {
  // Given hostile titles and steps, When the scene is built, Then every string containing markup is one of the inputs
  const { vm, ui } = input();
  const scene = sceneOf(load(), vm, ui);
  const strings = leaves(scene);
  assert.ok(strings.includes(HOSTILE[1]), 'hostile title kept verbatim');
  assert.ok(strings.includes(HOSTILE[2]), 'hostile step kept verbatim');
  const inputs = new Set(leaves(vm));
  for (const s of strings.filter((x) => /[<>"]/.test(x))) assert.ok(inputs.has(s), 'no string built from markup: ' + s);
});

test('public mode blanks every bubble and keeps the counts', () => {
  // Given a worker with a step, When the scene is built in public mode, Then no bubble carries text
  const { vm, ui } = input();
  const ctx = load();
  const normal = sceneOf(ctx, vm, ui);
  const pub = sceneOf(ctx, vm, { ...ui, publicMode: true });
  const bubbles = pub.floors.flatMap((f) => f.desks.map((d) => d.bubble));
  assert.ok(bubbles.every((b) => b === ''));
  assert.equal(pub.ceo.count, normal.ceo.count);
  assert.equal(pub.floors.flatMap((f) => f.desks).length, normal.floors.flatMap((f) => f.desks).length);
});

test('the same input gives an equal scene and the source reads no clock, random or network', () => {
  // Given one input, When the scene is built twice, Then both results are deep equal; the source has no clock/random/network use
  const { vm, ui } = input();
  const ctx = load();
  assert.deepEqual(sceneOf(ctx, vm, ui), sceneOf(ctx, vm, ui));
  assert.doesNotMatch(SRC, /\bDate\b|Math\.random|setTimeout|setInterval|requestAnimationFrame|document\.|window\.|fetch\(/);
});

test('the scene matches the frozen fixture', () => {
  // Given the input above, When the scene is built, Then it equals test/fixtures/office-scene.json
  const { vm, ui } = input();
  const scene = sceneOf(load(), vm, ui);
  assert.deepEqual(scene, fixture('office-scene.json'));
});

test('roles map to rooms; idle and finished helpers rest in the lounge', () => {
  // Given one session with one worker per role, When the scene is built, Then each desk sits in its role room
  const vm = {
    schema: 1, seq: 1, generatedAt: 1,
    sessions: [{
      id: 'r1', title: 't', lastActivityAt: 1, alive: true, decisions: [], changes: [], done: [],
      live: { workers: [
        { id: 'a', kind: 'explore', state: 'running', step: '' },
        { id: 'b', kind: 'oracle', state: 'waiting', step: '' },
        { id: 'c', kind: 'prometheus', state: 'running', step: '' },
        { id: 'd', kind: 'plan-reviewer', state: 'running', step: '' },
        { id: 'e', kind: 'sisyphus', state: 'running', step: '' },
        { id: 'f', kind: 'quick', state: 'done', step: '', endedAt: '2026-10-14T02:38:30.345Z' },
        { id: 'g', kind: 'explore', state: 'error', step: '' },
        { id: 'h', kind: 'sisyphus', state: 'waiting', step: '' },
      ] },
    }],
  };
  const scene = sceneOf(load(), vm, { publicMode: false, seen: {} });
  const room = Object.fromEntries(scene.floors[0].desks.map((d) => [d.id, d.room]));
  assert.deepEqual(room, { lead: 'work', a: 'research', b: 'lounge', c: 'plan', d: 'plan', e: 'work', f: 'lounge', g: 'research', h: 'lounge' });
});

test('live floors come first', () => {
  // Given live and closed sessions, When the scene is built, Then live floors lead
  const { vm, ui } = input();
  const scene = sceneOf(load(), vm, ui);
  const lives = scene.floors.map((f) => f.live);
  assert.deepEqual(lives, [...lives].sort((a, b) => Number(b) - Number(a)));
});

// ---- the walk map (plan Must have 12): the floor office-view.js draws (18 x 14 floor tiles) in walk tiles of half a floor
// tile; walls, desks and props block, a wall's open end is a door, the boss starts at the lounge door and every desk has a
// free tile next to it that the boss can reach from there
const TILE = 0.5;
const LOUNGE = [7.3, 7.4, 10.4, 13.6]; // the lounge rug as office-view.js ROOMS draws it: x0, y0, x1, y1 in floor tiles
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const mid = (i) => (i + 0.5) * TILE;
function walkGrid(floor) {
  const { w, h, blocked } = floor.walk, off = new Set(blocked);
  return { w, h, off, free: (x, y) => x >= 0 && y >= 0 && x < w && y < h && !off.has(y * w + x) };
}
// every tile the boss can reach from the spawn, stepping to the four sides
function reachable(floor) {
  const g = walkGrid(floor), start = floor.spawn.y * g.w + floor.spawn.x, seen = new Set([start]), queue = [start];
  while (queue.length) {
    const at = queue.shift(), x = at % g.w, y = (at - x) / g.w;
    for (const [dx, dy] of SIDES) {
      const k = (y + dy) * g.w + x + dx;
      if (g.free(x + dx, y + dy) && !seen.has(k)) { seen.add(k); queue.push(k); }
    }
  }
  return seen;
}
// the tiles a rect stands on: every tile whose middle is inside it, and the tile under its own middle
function tilesUnder(g, [x0, y0, x1, y1]) {
  const out = new Set([Math.floor((y0 + y1) / 2 / TILE) * g.w + Math.floor((x0 + x1) / 2 / TILE)]);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (mid(x) > x0 && mid(x) < x1 && mid(y) > y0 && mid(y) < y1) out.add(y * g.w + x);
  return out;
}
// the blocked tiles a desk takes: the tiles under it and the blocked ones its rect touches (the map keeps a margin)
function tilesTaken(g, rect) {
  const out = tilesUnder(g, rect), [x0, y0, x1, y1] = rect;
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    if (x * TILE < x1 && (x + 1) * TILE > x0 && y * TILE < y1 && (y + 1) * TILE > y0 && g.off.has(y * g.w + x)) out.add(y * g.w + x);
  }
  return out;
}
// what a desk stands on: a desk 1.6 x 1 floor tiles at its cell's scale; a lounge cat (no desk) only the tile under its feet
function deskRects(ctx, floor) {
  const cells = ctx.BriefOffice.layout(floor);
  return floor.desks.map((d) => {
    const c = cells[d.id];
    return { id: d.id, lounge: d.room === 'lounge', seated: d.room === 'lounge' && c.z > 0, rect: d.room === 'lounge' ? [c.x, c.y, c.x, c.y] : [c.x, c.y, c.x + 1.6 * c.s, c.y + c.s] };
  });
}
// one live session whose rooms hold n desks each (the work room also holds the session's lead)
function crowd(counts) {
  const kinds = { plan: 'prometheus', research: 'explore', work: 'sisyphus', review: 'oracle', lounge: 'quick' };
  const workers = Object.entries(counts).flatMap(([room, n]) => Array.from({ length: n }, (_, i) => ({
    id: room + i, kind: kinds[room], name: room + i, state: room === 'lounge' ? 'waiting' : 'running', step: '' })));
  return { schema: 1, seq: 1, generatedAt: 1, sessions: [{ id: 'c1', title: 't', lastActivityAt: 1, alive: true, decisions: [], changes: [], done: [], live: { workers } }] };
}

test('each floor has a walk map of the whole floor in half tiles; text and public mode do not change it', () => {
  // Given the fixture board, When the scene is built (normal, public, hostile title), Then every walk map covers 18 x 14
  // floor tiles as 36 x 28 walk tiles, lists each blocked tile once in order, and is the same whatever the text says
  const { vm, ui } = input();
  const ctx = load();
  const scene = sceneOf(ctx, vm, ui);
  const pub = sceneOf(ctx, vm, { ...ui, publicMode: true });
  const renamed = clone(vm);
  renamed.sessions.forEach((s) => { s.title = HOSTILE[0]; });
  const other = sceneOf(ctx, renamed, ui);
  assert.ok(scene.floors.length > 1);
  for (const [i, f] of scene.floors.entries()) {
    assert.deepEqual([f.walk.w * TILE, f.walk.h * TILE], [18, 14], f.sid);
    assert.ok(f.walk.blocked.length > 0, f.sid + ': something blocks');
    assert.ok(f.walk.blocked.every((k, j, all) => Number.isInteger(k) && k >= 0 && k < f.walk.w * f.walk.h && (j === 0 || all[j - 1] < k)), f.sid + ': sorted, unique, on the map');
    assert.deepEqual(pub.floors[i].walk, f.walk, f.sid + ': public mode');
    assert.deepEqual(other.floors.find((x) => x.sid === f.sid).walk, f.walk, f.sid + ': titles');
  }
});

test('the boss starts at the lounge door: a free tile in the middle of the lounge edge that faces the hall', () => {
  // Given every fixture floor, When the scene is built, Then the spawn is free, inside the lounge rug, its back neighbour is
  // the hall (outside the lounge) and it sits in the lounge's middle column
  const { vm, ui } = input();
  const scene = sceneOf(load(), vm, ui);
  for (const f of scene.floors) {
    const g = walkGrid(f), { x, y } = f.spawn;
    assert.ok(g.free(x, y), f.sid + ': free');
    assert.ok(mid(x) > LOUNGE[0] && mid(x) < LOUNGE[2] && mid(y) > LOUNGE[1] && mid(y) < LOUNGE[3], f.sid + ': in the lounge');
    assert.ok(mid(y - 1) < LOUNGE[1] && g.free(x, y - 1), f.sid + ': the tile behind it is the open hall');
    assert.ok(Math.abs(mid(x) - (LOUNGE[0] + LOUNGE[2]) / 2) <= TILE / 2, f.sid + ': the middle of the lounge');
  }
});

test('the glass walls block their tiles and each keeps an open end, its door, that the boss can reach', () => {
  // Given the model's floor plan, When the scene is built, Then every tile along a glass wall is blocked and a tile just
  // past one of its ends is free and reachable from the spawn
  const { vm, ui } = input();
  const ctx = load();
  const glass = clone(ctx.BriefOffice.map.glass);
  assert.equal(glass.length, 4, 'the four glass walls between rooms');
  for (const f of sceneOf(ctx, vm, ui).floors) {
    const g = walkGrid(f), seen = reachable(f);
    for (const [x, y0, y1] of glass) {
      const col = Math.floor(x / TILE), rows = [];
      for (let y = 0; y < g.h; y++) if (mid(y) >= y0 && mid(y) <= y1) rows.push(y);
      assert.ok(rows.length > 0);
      for (const y of rows) assert.equal(g.free(col, y), false, f.sid + ': wall at ' + [x, y0, y1] + ' row ' + y);
      const doors = [rows[0] - 1, rows.at(-1) + 1].filter((y) => g.free(col, y) && seen.has(y * g.w + col));
      assert.ok(doors.length > 0, f.sid + ': wall at ' + [x, y0, y1] + ' has a door');
    }
  }
});

test('props block the floor under them, and the hall between the upper rooms and the lounge is crossed straight', () => {
  // Given the model's floor plan, When the scene is built, Then every tile under a prop is blocked, and the column from the
  // spawn to the upper rooms (the belt lies on the floor of that hall) is free
  const { vm, ui } = input();
  const ctx = load();
  const props = clone(ctx.BriefOffice.map.props);
  assert.deepEqual([...new Set(props.map((p) => p[0]))].sort(), ['coffee', 'cooler', 'desk', 'plant', 'rack', 'shelf', 'sofa', 'tower']);
  for (const f of sceneOf(ctx, vm, ui).floors) {
    const g = walkGrid(f);
    for (const [art, ...rect] of props) for (const k of tilesUnder(g, rect)) assert.ok(g.off.has(k), f.sid + ': ' + art + ' at ' + rect + ' tile ' + k);
    for (let y = Math.floor(4.6 / TILE); y <= f.spawn.y; y++) assert.ok(g.free(f.spawn.x, y), f.sid + ': hall row ' + y);
  }
});

test('desks block the floor under them; lounge cats have no desk and block nothing', () => {
  // Given the fixture floors and crowded floors, When the scene is built, Then the tiles under every desk are blocked and
  // the tile under a standing lounge cat is free
  const ctx = load(), { vm, ui } = input();
  const floors = sceneOf(ctx, vm, ui).floors.concat(sceneOf(ctx, crowd({ plan: 12, research: 12, work: 12, review: 12, lounge: 12 }), ui).floors);
  let standing = 0;
  for (const f of floors) {
    const g = walkGrid(f);
    for (const d of deskRects(ctx, f)) {
      if (d.lounge) { if (!d.seated) { standing++; assert.ok(g.free(Math.floor(d.rect[0] / TILE), Math.floor(d.rect[1] / TILE)), f.sid + ': ' + d.id); } continue; }
      for (const k of tilesUnder(g, d.rect)) assert.ok(g.off.has(k), f.sid + ': desk ' + d.id + ' tile ' + k);
    }
  }
  assert.ok(standing > 0, 'a standing lounge cat was checked');
});

test('every desk has a free tile next to it that the boss can reach from the spawn, in every room holding 0 to 16 desks', () => {
  // Given the fixture floors, each room filled with 0..16 desks (the others with 2) and every room with 12, When the scene
  // is built, Then each desk (or lounge cat) has a free tile beside the tiles it stands on that is reachable from the spawn
  const ctx = load(), { vm, ui } = input();
  const boards = [vm, crowd({ plan: 12, research: 12, work: 12, review: 12, lounge: 12 })];
  for (const room of ['plan', 'research', 'work', 'review', 'lounge']) for (let n = 0; n <= 16; n++) boards.push(crowd({ plan: 2, research: 2, work: 2, review: 2, lounge: 2, [room]: n }));
  let desks = 0;
  for (const board of boards) for (const f of sceneOf(ctx, board, ui).floors) {
    const g = walkGrid(f), seen = reachable(f);
    for (const d of deskRects(ctx, f)) {
      desks++;
      const own = d.lounge ? new Set([Math.floor(d.rect[1] / TILE) * g.w + Math.floor(d.rect[0] / TILE)]) : tilesTaken(g, d.rect);
      const next = [...own].flatMap((k) => SIDES.map(([dx, dy]) => [k % g.w + dx, Math.floor(k / g.w) + dy]))
        .filter(([x, y]) => !own.has(y * g.w + x) && g.free(x, y) && seen.has(y * g.w + x));
      assert.ok(next.length > 0, f.sid + ': ' + d.id + ' (' + JSON.stringify(Object.fromEntries(Object.entries(f.rooms).map(([r, l]) => [r, l.length]))) + ')');
    }
  }
  assert.ok(desks > 1000, 'desks checked: ' + desks);
});

// ---- talking to a cat (plan todo 11, Must have 13): who the boss can talk to from its tile, and the dialog's data --------
// The rule, restated from the reading office-model.js documents: a cat's spot is the walk tiles its floor rectangle
// overlaps (a desk 1.6 x 1 at its cell's scale; a lounge cat the 0.4 x 0.4 square it is painted by); the boss is next to a
// cat when its tile is in that spot or touches it, sides or corners; of several, the fewest steps (a corner counts two),
// then the floor's desk order.
function spotOf(ctx, floor, d) {
  const c = ctx.BriefOffice.layout(floor)[d.id], r = d.room === 'lounge' ? [c.x - 0.2, c.y - 0.2, c.x + 0.2, c.y + 0.2] : [c.x, c.y, c.x + 1.6 * c.s, c.y + c.s];
  const out = [];
  for (let y = 0; y < floor.walk.h; y++) for (let x = 0; x < floor.walk.w; x++) if (x * TILE < r[2] && (x + 1) * TILE > r[0] && y * TILE < r[3] && (y + 1) * TILE > r[1]) out.push([x, y]);
  return out;
}
// spots = [{ id, tiles }] in the floor's desk order
function nearByRule(spots, [x, y]) {
  let best = null, dist = 3;
  for (const s of spots) for (const [sx, sy] of s.tiles) {
    const dx = Math.abs(sx - x), dy = Math.abs(sy - y);
    if (dx <= 1 && dy <= 1 && dx + dy < dist) { dist = dx + dy; best = s.id; }
  }
  return { id: best, dist };
}
const near = (ctx, floor, [x, y]) => ctx.BriefOffice.near(floor, y * floor.walk.w + x);

test('next to a cat: beside, on a corner of or on its spot; one tile further off is not, and an empty spot talks to nobody', () => {
  // Given a floor with only the lead (its desk in the work room) and floors with two cats on the lounge sofa, When the boss
  // stands beside the lead's desk, on its corner, two tiles off, or at the lounge door, Then near() names the lead, the
  // lead, nobody, and the first sofa cat (the door is drawn right beside it); with an empty lounge the door talks to nobody
  const ctx = load(), ui = { publicMode: false };
  const lone = sceneOf(ctx, crowd({}), ui).floors[0], c = clone(ctx.BriefOffice.layout(lone)).lead;
  const x0 = Math.floor(c.x / TILE), y0 = Math.floor(c.y / TILE);
  assert.equal(near(ctx, lone, [x0 - 1, y0]), 'lead', 'the tile left of the desk');
  assert.equal(near(ctx, lone, [x0 - 1, y0 - 1]), 'lead', 'the tile on its corner');
  assert.equal(near(ctx, lone, [x0 - 2, y0]), null, 'two tiles off');
  assert.equal(near(ctx, lone, [lone.spawn.x, lone.spawn.y]), null, 'nobody in the lounge');
  const sofa = sceneOf(ctx, crowd({ lounge: 2 }), ui).floors[0];
  assert.equal(near(ctx, sofa, [sofa.spawn.x, sofa.spawn.y]), 'lounge0', 'the lounge door is next to the first sofa seat');
  const standing = sceneOf(ctx, crowd({ lounge: 4 }), ui).floors[0], cat = clone(ctx.BriefOffice.layout(standing)).lounge3;
  assert.equal(cat.z, 0, 'the fourth lounge cat stands');
  assert.equal(near(ctx, standing, [Math.floor(cat.x / TILE), Math.floor(cat.y / TILE)]), 'lounge3', 'the boss can stand on a standing cat\'s tile');
});

test('near() follows the rule on every tile of every room filling: the nearest cat, ties to the first in desk order', () => {
  // Given the fixture floors and each room filled with 0..16 desks, When near() is asked for every walk tile, Then it
  // names the cat the rule above names (null where none is next to the tile), and some tiles are ties it gives to the
  // first cat in the floor's desk order
  const ctx = load(), { vm, ui } = input();
  const boards = [vm, fixture('view-model-office.json')];
  for (const room of ['plan', 'research', 'work', 'review', 'lounge']) for (let n = 0; n <= 16; n += 4) boards.push(crowd({ plan: 2, research: 2, work: 2, review: 2, lounge: 2, [room]: n }));
  let tiles = 0, named = 0, ties = 0;
  for (const board of boards) for (const f of sceneOf(ctx, board, ui).floors) {
    const spots = f.desks.map((d) => ({ id: d.id, tiles: spotOf(ctx, f, d) }));
    for (let y = 0; y < f.walk.h; y++) for (let x = 0; x < f.walk.w; x++) {
      const want = nearByRule(spots, [x, y]);
      assert.equal(near(ctx, f, [x, y]), want.id, f.sid + ' tile ' + [x, y]);
      tiles++;
      if (want.id) named++;
      const others = spots.filter((s) => s.id !== want.id && s.tiles.some(([sx, sy]) => Math.abs(sx - x) <= 1 && Math.abs(sy - y) <= 1 && Math.abs(sx - x) + Math.abs(sy - y) === want.dist));
      if (want.id && others.length) {
        ties++;
        assert.ok(spots.findIndex((s) => s.id === want.id) < spots.findIndex((s) => s.id === others[0].id), f.sid + ' tile ' + [x, y] + ': a tie goes to the first desk');
      }
    }
  }
  assert.ok(tiles > 20000 && named > 1000 && ties > 50, JSON.stringify({ tiles, named, ties }));
});

// the dialog's data: the fixture board with s-a1 (needs_decision, three open decisions) and s-a2 (live workers)
function talkInput(patch = {}) {
  const { vm, ui } = input();
  Object.assign(ui, { live: true, answers: {} }, patch.ui);
  if (patch.vm) patch.vm(vm);
  return { vm, ui };
}
function talkOf(ctx, vm, ui, sid, id) {
  const scene = ctx.BriefOffice.scene(vm, ui, vm.generatedAt);
  return clone(ctx.BriefOffice.talk(vm, ui, scene, sid, id));
}

test('the lead cat\'s dialog data comes from its session: title, floor, state, current todo, headline, next, progress and decisions', () => {
  // Given s-a1 (statusKey needs_decision, auto todo 3/9, decisions 12, 13, 14 open, no annotation kind), When the dialog
  // data of its lead is built on the live board, Then every field is the session's own, its decisions are to answer here,
  // and there is no note box until the session takes annotations
  const ctx = load(), { vm, ui } = talkInput();
  const s = vm.sessions.find((x) => x.id === 's-a1'), floors = sceneOf(ctx, vm, ui).floors;
  const t = talkOf(ctx, vm, ui, 's-a1', 'lead');
  assert.deepEqual(t, {
    sid: 's-a1', id: 'lead', lead: true, n: floors.length - floors.findIndex((f) => f.sid === 's-a1'), title: HOSTILE[1], role: '리더', room: 'work', name: '',
    state: '입력 기다림', tone: 'wait', step: s.auto.todoCurrent, headline: s.headline, next: s.next, todo: s.auto.todoDone + '/' + s.auto.todoTotal,
    open: 3, asks: [12, 13, 14], note: false, sub: '',
  });
  const kinds = talkInput({ vm: (v) => { v.sessions.find((x) => x.id === 's-a1').answerKinds = ['option', 'text', 'annotation']; } });
  assert.equal(talkOf(ctx, kinds.vm, kinds.ui, 's-a1', 'lead').note, true, 'a session that takes annotations gets the note box');
});

test('a worker cat\'s dialog data is its own row: role, name, state and step; it has nothing to answer or send', () => {
  // Given s-a2's worker rows (one step hostile), When the dialog data of each worker is built, Then the role is its kind
  // (without omo-native-), the state word follows its state, the step is its step, and it answers nothing and sends nothing
  const ctx = load(), { vm, ui } = talkInput({ vm: (v) => { v.sessions.find((x) => x.id === 's-a2').answerKinds = ['option', 'text', 'annotation']; } });
  const s = vm.sessions.find((x) => x.id === 's-a2'), WORD = { running: '일함', waiting: '대기', done: '끝남', cancelled: '끝남', error: '오류', lost: '오류' };
  assert.ok(s.live.workers.length >= 3);
  for (const w of s.live.workers) {
    const t = talkOf(ctx, vm, ui, 's-a2', w.id), role = w.kind.replace(/^omo-native-/, '') || w.name || '작업자';
    assert.deepEqual([t.lead, t.role, t.name, t.state, t.step, t.asks, t.note, t.sub], [false, role, w.name === role ? '' : w.name, WORD[w.state] || '대기', w.step || '', [], false, 'wk'], w.id);
    assert.equal(t.title, s.title);
  }
  assert.ok(s.live.workers.some((w) => w.step === HOSTILE[2]), 'the hostile step is one of them, passed on as the plain string');
});

test('the dialog\'s five state words: 대기, 일함, 입력 기다림, 끝남 and 오류, from the session or the worker row', () => {
  // Given leads in every session status and workers in every row state, When the dialog data is built, Then the state
  // word and its tone are the five of the plan
  const ctx = load();
  const lead = (patch) => {
    const { vm, ui } = talkInput({ vm: (v) => Object.assign(v.sessions.find((x) => x.id === 's-a1'), patch) });
    const t = talkOf(ctx, vm, ui, 's-a1', 'lead');
    return [t.state, t.tone];
  };
  assert.deepEqual(lead({ statusKey: 'in_progress', status: 'in_progress', alive: true }), ['일함', 'run']);
  assert.deepEqual(lead({ statusKey: 'in_progress', status: 'in_progress', alive: false }), ['대기', 'rest']);
  assert.deepEqual(lead({ statusKey: 'needs_decision' }), ['입력 기다림', 'wait']);
  assert.deepEqual(lead({ statusKey: 'blocked', status: 'blocked' }), ['입력 기다림', 'wait']);
  assert.deepEqual(lead({ statusKey: 'in_progress', status: 'in_progress', alive: true, openQuestion: { text: 'q', at: 1 } }), ['입력 기다림', 'wait']);
  assert.deepEqual(lead({ statusKey: 'done', status: 'done' }), ['끝남', 'rest']);
  assert.deepEqual(lead({ statusKey: 'done_no_evidence', status: 'done' }), ['끝남', 'rest']);
  const worker = (state) => {
    const { vm, ui } = talkInput({ vm: (v) => { v.sessions.find((x) => x.id === 's-a2').live.workers[0].state = state; } });
    const t = talkOf(ctx, vm, ui, 's-a2', vm.sessions.find((x) => x.id === 's-a2').live.workers[0].id);
    return [t.state, t.tone];
  };
  assert.deepEqual(['running', 'waiting', 'done', 'cancelled', 'error', 'lost'].map(worker),
    [['일함', 'run'], ['대기', 'rest'], ['끝남', 'rest'], ['끝남', 'rest'], ['오류', 'err'], ['오류', 'err']]);
});

test('the decisions to answer: the open ones, and those this page has an answer under way for until it is delivered', () => {
  // Given s-a1's decisions answered or closed elsewhere and the page's own answer state (ui.answers), When the dialog data
  // is built, Then the open ones are listed, a held, closed or answered one is not, unless this page has a confirm pending
  // for it, is sending it, found it closed, or sent it and no delivery receipt came yet
  const ctx = load();
  const asks = (decisions, answers) => {
    const { vm, ui } = talkInput({ ui: { answers }, vm: (v) => { const s = v.sessions.find((x) => x.id === 's-a1'); s.decisions.forEach((d) => Object.assign(d, decisions[d.id])); } });
    return talkOf(ctx, vm, ui, 's-a1', 'lead');
  };
  assert.deepEqual(asks({}, {}).asks, [12, 13, 14]);
  assert.deepEqual(asks({ 12: { answered: true }, 13: { closed: true }, 14: { held: { at: 1 }, closed: true } }, {}).asks, []);
  const t = asks({ 12: { answered: true }, 13: { answered: true }, 14: { closed: true } }, { 12: { confirm: { option: 'A' }, phase: '' }, 13: { phase: 'closed', error: 'x' }, 14: { phase: 'sending' } });
  assert.deepEqual([t.asks, t.open], [[12, 13, 14], 0], 'confirm pending, found closed, sending; none of them open');
  assert.deepEqual(asks({ 12: { answered: true } }, { 12: { phase: 'sent' } }).asks, [12, 13, 14], 'sent, no receipt yet');
  assert.deepEqual(asks({ 12: { answered: true, receipt: { at: 1 } } }, { 12: { phase: 'sent' } }).asks, [13, 14], 'delivered: it leaves the dialog');
  assert.deepEqual(asks({ 12: { answered: true } }, { 12: { phase: '', confirm: null, open: true, draft: 'x' } }).asks, [13, 14], 'a reply being typed is no answer under way');
});

test('the file:// copy and public mode have nothing to answer or send; public mode blanks the step, headline and next', () => {
  // Given the lead of a session that takes annotations, When the dialog data is built off the live board or in public mode,
  // Then asks is empty and note is false; in public mode the agent-written text is blank and the counts stay
  const ctx = load(), kinds = (v) => { v.sessions.find((x) => x.id === 's-a1').answerKinds = ['option', 'text', 'annotation']; };
  const file = talkInput({ ui: { live: false }, vm: kinds }), pub = talkInput({ ui: { publicMode: true }, vm: kinds });
  const f = talkOf(ctx, file.vm, file.ui, 's-a1', 'lead'), p = talkOf(ctx, pub.vm, pub.ui, 's-a1', 'lead');
  assert.deepEqual([f.asks, f.note], [[], false]);
  assert.deepEqual([p.asks, p.note, p.step, p.headline, p.next], [[], false, '', '', '']);
  assert.deepEqual([p.title, p.state, p.todo, p.open], [f.title, f.state, f.todo, f.open]);
  const w = talkInput({ ui: { publicMode: true } }), id = w.vm.sessions.find((x) => x.id === 's-a2').live.workers[0].id;
  assert.equal(talkOf(ctx, w.vm, w.ui, 's-a2', id).step, '', 'a worker\'s step is its bubble: blank in public mode');
});

test('a session or a cat that is gone has no dialog data', () => {
  // Given the board, When the dialog data is asked for a session or a desk that is not there, Then it is null
  const ctx = load(), { vm, ui } = talkInput();
  assert.equal(talkOf(ctx, vm, ui, 'no-such', 'lead'), null);
  assert.equal(talkOf(ctx, vm, ui, 's-a1', 'no-such-worker'), null);
});

test('the plan view exports the lane helpers the conveyor uses', () => {
  // Given the page scripts, When plan-view loads, Then lanesOf and currentOf are exported
  const ctx = load();
  assert.equal(typeof ctx.BriefPlanView.lanesOf, 'function');
  assert.equal(typeof ctx.BriefPlanView.currentOf, 'function');
});

test('a kind with the omo-native- prefix lands in the room of its bare name', () => {
  // Given a running worker of the office fixture, When its kind is a bare agent name and then the same name with the
  // omo-native- prefix, Then the scene puts its desk in the same room both times
  const ctx = load(), vm = clone(fixture('view-model-office.json'));
  const w = vm.sessions.flatMap((s) => (s.live && s.live.workers) || []).find((x) => x.state === 'running');
  const roomFor = (kind) => { w.kind = kind; for (const f of sceneOf(ctx, vm, {}).floors) for (const d of f.desks) if (d.id === w.id) return d.room; return null; };
  for (const k of ['oracle', 'plan-reviewer', 'plan-consultant', 'prometheus', 'architect', 'explore', 'librarian', 'gate-reviewer', 'qa-executor', 'deep-low']) {
    const bare = roomFor(k);
    assert.ok(bare, k);
    assert.equal(roomFor('omo-native-' + k), bare, 'omo-native-' + k);
  }
});
