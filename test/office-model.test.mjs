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

test('the plan view exports the lane helpers the conveyor uses', () => {
  // Given the page scripts, When plan-view loads, Then lanesOf and currentOf are exported
  const ctx = load();
  assert.equal(typeof ctx.BriefPlanView.lanesOf, 'function');
  assert.equal(typeof ctx.BriefPlanView.currentOf, 'function');
});
