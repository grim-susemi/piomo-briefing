// Fold parity: a folded finished-plan row must give the same scene floor data as the unfolded row (only dark differs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeController } from './fixtures/controller-dom.mjs';
import { projectBoardModel } from '../src/render.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const fixture = (p) => JSON.parse(read('test/fixtures/' + p));
const clone = (v) => JSON.parse(JSON.stringify(v));
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

test('a folded finished-plan row gives the same floor and conveyor data as the unfolded row', () => {
  // Given one idle card on 끝남 whose plan tasks are all done or stopped, When the view model is projected with and without
  // folding, Then the card is folded in one and whole in the other, and its scene floor matches apart from dark
  const { vm, ui } = input();
  const now = vm.generatedAt;
  const s = vm.sessions[vm.sessions.length - 1];
  const sid = s.id;
  Object.assign(s, {
    alive: false, tab: '끝남', status: 'done', lastActivityAt: now - 3 * 24 * 60 * 60 * 1000,
    decisions: [], notes: [], reports: [], chips: [], live: undefined, auto: undefined, workName: undefined,
    plan: {
      goal: '목표', waves: [{ n: 1, label: '하나' }],
      tasks: [
        { id: '1', wave: 1, label: 'a', what: 'w', done: 'd', state: 'done', deps: [] },
        { id: '2', wave: 1, label: 'b', what: 'w', done: 'd', state: 'stopped', deps: [] },
      ],
      questions: [],
    },
  });
  vm.waiting = (vm.waiting ?? []).filter((w) => w.sessionId !== sid);
  const folded = projectBoardModel(vm, now);
  const whole = projectBoardModel(vm, now, { fold: false });
  assert.ok(folded.sessions.find((x) => x.id === sid).folded, 'precondition: the finished-plan card folds');
  assert.equal(whole.sessions.find((x) => x.id === sid).folded, undefined, 'precondition: the unfolded card is whole');
  const ctx = load();
  const a = sceneOf(ctx, folded, ui).floors.find((f) => f.sid === sid);
  const b = sceneOf(ctx, whole, ui).floors.find((f) => f.sid === sid);
  assert.equal(a.dark, true, 'the folded floor is dark');
  assert.equal(b.dark, false, 'the whole floor is not dark');
  const { dark: _folded, ...restFolded } = a;
  const { dark: _whole, ...restWhole } = b;
  assert.deepEqual(restFolded, restWhole);
});
