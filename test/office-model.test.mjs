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

test('roles map to rooms and finished helpers rest in the lounge', () => {
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
      ] },
    }],
  };
  const scene = sceneOf(load(), vm, { publicMode: false, seen: {} });
  const room = Object.fromEntries(scene.floors[0].desks.map((d) => [d.id, d.room]));
  assert.deepEqual(room, { lead: 'work', a: 'research', b: 'review', c: 'plan', d: 'plan', e: 'work', f: 'lounge' });
});

test('live floors come first, and the walk grid is an empty placeholder', () => {
  // Given live and closed sessions, When the scene is built, Then live floors lead and walk/spawn are placeholders
  const { vm, ui } = input();
  const scene = sceneOf(load(), vm, ui);
  const lives = scene.floors.map((f) => f.live);
  assert.deepEqual(lives, [...lives].sort((a, b) => Number(b) - Number(a)));
  for (const f of scene.floors) {
    assert.deepEqual(f.walk, { w: 0, h: 0, blocked: [] });
    assert.deepEqual(f.spawn, { x: 0, y: 0 });
  }
});

test('the plan view exports the lane helpers the conveyor uses', () => {
  // Given the page scripts, When plan-view loads, Then lanesOf and currentOf are exported
  const ctx = load();
  assert.equal(typeof ctx.BriefPlanView.lanesOf, 'function');
  assert.equal(typeof ctx.BriefPlanView.currentOf, 'function');
});
