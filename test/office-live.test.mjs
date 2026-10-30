// Office live updates and motion (src/page/office-view.js, office.css; plan omo-office-view todo 6). The real page
// scripts run in the deterministic DOM of fixtures/controller-dom.mjs and fixtures/view-model-office.json is published
// again and again through BriefPage.receive. el.animate() is a recording fake here; the browser side (real walks,
// document.getAnimations(), a hidden tab, reduced motion, the AX tree) is the CDP run of plan todo 6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeController } from './fixtures/controller-dom.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const fixture = (p) => JSON.parse(read('test/fixtures/' + p));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MODULES = ['icons', 'view', 'plan-view', 'workers-view', 'blocks', 'convo-view', 'shell', 'annotate', 'office-assets', 'office-model', 'office-view'];
const OFFICE_JS = ['office-assets.js', 'office-model.js', 'office-view.js'];
const TIMERS = ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback'];
const SVG_NS = 'http://www.w3.org/2000/svg';

// one fake Web Animations handle per el.animate() call: what was asked, and the controls office-view.js uses
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
// the fake document has no SVG namespace: an SVG node remembers the namespace it was made in, and the page's hidden icon
// sprite is where office-view.js reads it; env.reduce answers the prefers-reduced-motion query, and the change listeners
// a query was given are kept in env.heard (reduceMotion() below tells them, as a browser does)
function openOffice({ animate, env = {}, configure } = {}) {
  const vm = fixture('view-model-office.json');
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
      addEventListener: (type, fn) => { if (type === 'change') env.heard.push({ q, fn }); },
      removeEventListener: (type, fn) => { if (type === 'change') env.heard = env.heard.filter((h) => h.fn !== fn); } });
    configure?.(ctx);
  } });
  e.page.receive(vm);
  e.fire(e.byId.rail.querySelector('[data-sh="view"][data-key="office"]'), 'click');
  return { e, vm, office: e.byId.main.querySelector('#office') };
}
// the board's next publish: a larger seq, applied once page.js's 500 ms apply throttle has run
function publish(e, vm, seq) {
  const next = clone(vm);
  next.seq = seq;
  e.page.receive(next);
  e.advance(500);
  assert.equal(e.page.state.seq, seq, 'publish ' + seq + ' applied');
}
const worker = (vm, id) => vm.sessions[0].live.workers.find((w) => w.id === id);
const desk = (office, id) => office.querySelector('.of-desk[data-desk="' + id + '"]');
const toLounge = (vm) => { const next = clone(vm); worker(next, 'st_r3_03').state = 'waiting'; return next; };
// the OS reduced-motion setting changes: the query answers anew and its change listeners hear it, as in a browser
function reduceMotion(env, on) {
  env.reduce = on;
  for (const h of env.heard.filter((l) => /reduce/.test(l.q))) h.fn({ type: 'change', matches: on, media: h.q });
}
// the tab goes to the background or comes back: page.js's visibilitychange hook runs
function tab(e, hidden) {
  e.document.hidden = hidden;
  e.document.visibilityState = hidden ? 'hidden' : 'visible';
  e.document.listeners.visibilitychange({ type: 'visibilitychange' });
}
// a cat's place: the translate and scale of the group inside its .of-walk wrapper
function place(unit) {
  const pos = unit.querySelector('.of-walk').children.find((n) => n.tagName === 'G');
  return /^translate\(([-\d.]+),([-\d.]+)\) scale\(([\d.]+)\)$/.exec(pos.getAttribute('transform')).slice(1).map(Number);
}
const shift = (frame) => /^translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([\d.]+)\) translate\(([-\d.]+)px,([-\d.]+)px\)$/.exec(frame.transform).slice(1).map(Number);

test('20 publishes patch the office in place: desks, cats and unchanged rows keep their nodes; only a new or gone worker adds or removes a desk', () => {
  const { e, vm, office } = openOffice();
  const first = { desks: { ...e.ctx.__office.desks }, cats: { ...e.ctx.__office.cats } };
  const todoRow = office.querySelector('.of-box .of-list li'), floorRow = office.querySelectorAll('.of-fl')[3];
  assert.equal(Object.keys(first.desks).length, 13);
  assert.ok(todoRow && floorRow);
  for (let i = 1; i <= 20; i++) {
    // every 4th publish sends explore (working) to wait in the lounge, the next ones bring it back; 10-15 add a worker
    const next = i % 4 === 1 ? toLounge(vm) : clone(vm);
    if (i >= 10 && i < 16) next.sessions[0].live.workers.push({ ...clone(worker(vm, 'st_r3_03')), id: 'st_r3_new', name: 'new', step: 'new step' });
    publish(e, next, vm.seq + i);
    for (const [id, node] of Object.entries(first.desks)) assert.equal(desk(office, id), node, 'publish ' + i + ': desk ' + id);
    for (const [id, node] of Object.entries(first.cats)) assert.equal(e.ctx.__office.cats[id], node, 'publish ' + i + ': cat ' + id);
    assert.equal(office.querySelector('.of-box .of-list li'), todoRow, 'publish ' + i + ': an unchanged rail row');
    assert.equal(office.querySelectorAll('.of-fl')[3], floorRow, 'publish ' + i + ': an unchanged picker row');
    const moved = desk(office, 'st_r3_03'), waiting = i % 4 === 1;
    assert.equal(moved.classList.contains(waiting ? 'is-idle' : 'is-typing'), true, 'publish ' + i + ': the changed desk is rewritten');
    assert.equal(!!moved.querySelector('.of-slide'), !waiting, 'publish ' + i + ': a waiting cat has no desk of its own');
    assert.equal(!!desk(office, 'st_r3_new'), i >= 10 && i < 16, 'publish ' + i + ': the added worker');
  }
});

test('a cat whose room changed walks there through the hall: one el.animate() from its old place to none; its old neighbour slides', async () => {
  const anims = animations(), { e, vm, office } = openOffice({ animate: anims.animate });
  const unit = desk(office, 'st_r3_03'), before = place(unit);
  assert.equal(anims.made.length, 0, 'the first drawing starts no walk');
  publish(e, toLounge(vm), vm.seq + 1);
  const after = place(unit), walks = anims.made.filter((a) => a.target === unit.querySelector('.of-walk'));
  assert.equal(walks.length, 1);
  const frames = walks[0].frames, start = shift(frames[0]), end = shift(frames.at(-1));
  assert.equal(frames.length, 4, 'out of its room, along the hall, into the lounge');
  assert.deepEqual([frames[0].offset, frames.at(-1).offset], [0, 1]);
  assert.deepEqual([start[0], start[1], start[3], start[4]], [before[0], before[1], -after[0], -after[1]], 'it starts where it sat');
  assert.deepEqual(end, [after[0], after[1], 1, -after[0], -after[1]], 'it ends as none, on its new place');
  assert.equal(start[2], Math.round(before[2] / after[2] * 1000) / 1000, 'at its old size: a desk cat, larger than a lounge cat');
  assert.ok(before[2] > after[2]);
  assert.equal(unit.classList.contains('is-walking'), true);
  const lib = desk(office, 'st_r3_04');
  assert.deepEqual(anims.made.filter((a) => lib.contains(a.target)).map((a) => [a.target.getAttribute('class'), a.frames.length]).sort(),
    [['of-slide', 2], ['of-walk', 2]], 'the librarian has the research room to itself: its desk and cat move to the middle');
  walks[0].finish();
  await walks[0].finished;
  assert.equal(unit.classList.contains('is-walking'), false, 'arrived');
});

test('under reduced motion or in a hidden tab no walk starts: the cat is simply in its new room', () => {
  for (const mode of ['reduce', 'hidden']) {
    const anims = animations(), env = {}, { e, vm, office } = openOffice({ animate: anims.animate, env });
    if (mode === 'reduce') env.reduce = true;
    else e.document.hidden = true;
    publish(e, toLounge(vm), vm.seq + 1);
    const unit = desk(office, 'st_r3_03');
    assert.equal(anims.made.length, 0, mode);
    assert.equal(unit.classList.contains('is-idle') && !unit.querySelector('.of-slide'), true, mode + ': waiting in the lounge');
    assert.equal(office.getAttribute('data-motion'), mode === 'hidden' ? 'paused' : 'run', mode);
  }
});

test('hiding the tab holds the office: the root is marked paused and running walks pause; showing it plays them on', () => {
  const anims = animations(), { e, vm, office } = openOffice({ animate: anims.animate });
  publish(e, toLounge(vm), vm.seq + 1);
  const walks = anims.made.slice();
  assert.ok(walks.length > 0 && walks.every((a) => a.playState === 'running'));
  const turn = (hidden) => {
    e.document.hidden = hidden;
    e.document.visibilityState = hidden ? 'hidden' : 'visible';
    e.document.listeners.visibilitychange({ type: 'visibilitychange' });
  };
  turn(true);
  assert.equal(office.getAttribute('data-motion'), 'paused');
  assert.deepEqual(walks.map((a) => a.playState), walks.map(() => 'paused'));
  turn(false);
  assert.equal(office.getAttribute('data-motion'), 'run');
  assert.deepEqual(walks.map((a) => a.playState), walks.map(() => 'running'));
});

test('reduced motion turned on during a walk ends every walk at that change: nothing of the office runs on and the cat is in its room', { timeout: 10000 }, async () => {
  const unhandled = [], note = (why) => unhandled.push(String(why));
  process.on('unhandledRejection', note);
  try {
    const anims = animations(), env = {}, { e, vm, office } = openOffice({ animate: anims.animate, env });
    publish(e, toLounge(vm), vm.seq + 1);
    const unit = desk(office, 'st_r3_03'), walks = anims.made.slice(), lounge = place(unit);
    assert.ok(walks.length > 1 && walks.every((a) => a.playState === 'running'), 'the cat walks and its old neighbour moves');
    assert.equal(unit.classList.contains('is-walking'), true);
    reduceMotion(env, true);
    assert.deepEqual(walks.map((a) => a.playState), walks.map(() => 'idle'), 'every walk ended at the change: none runs on');
    assert.equal(unit.classList.contains('is-walking'), false, 'the cat no longer walks');
    assert.deepEqual(place(unit), lounge, 'it is in the room the model says: the lounge');
    assert.equal(unit.classList.contains('is-idle') && !unit.querySelector('.of-slide'), true);
    assert.equal(office.getAttribute('data-motion'), 'run', 'as on the reduced path: office.css holds the keyframes');
    await Promise.allSettled(walks.map((a) => a.finished));
    // one turn of the event loop: Node reports a rejection nobody handled before an immediate runs
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'an ended walk leaves no unhandled rejection');
    assert.equal(unit.classList.contains('is-walking'), false, 'the ended walks\' finished handlers leave the cat as it is');
    publish(e, clone(vm), vm.seq + 2);
    assert.equal(anims.made.length, walks.length, 'no walk starts while reduced motion is on');
    assert.equal(unit.classList.contains('is-typing') && !!unit.querySelector('.of-slide'), true, 'back at its desk at once');
  } finally {
    process.off('unhandledRejection', note);
  }
});

test('reduced motion off again: no ended walk comes back, the root runs and the next room change walks', () => {
  const anims = animations(), env = {}, { e, vm, office } = openOffice({ animate: anims.animate, env });
  publish(e, toLounge(vm), vm.seq + 1);
  reduceMotion(env, true);
  reduceMotion(env, false);
  const unit = desk(office, 'st_r3_03'), ended = anims.made.length;
  assert.deepEqual(anims.made.map((a) => a.playState), anims.made.map(() => 'idle'), 'nothing starts again by itself');
  assert.equal(unit.classList.contains('is-walking'), false);
  assert.equal(office.getAttribute('data-motion'), 'run');
  publish(e, clone(vm), vm.seq + 2);
  const back = anims.made.slice(ended).filter((a) => a.target === unit.querySelector('.of-walk'));
  assert.equal(back.length, 1, 'the next room change walks: back to its desk');
  assert.deepEqual([back[0].playState, back[0].frames.length], ['running', 4], 'through the hall');
  assert.equal(unit.classList.contains('is-walking'), true);
});

test('a walk held by a hidden tab ends too under reduced motion, whether the change is heard while hidden or only met when the tab is back', () => {
  for (const heard of [true, false]) {
    const anims = animations(), env = {}, { e, vm, office } = openOffice({ animate: anims.animate, env });
    publish(e, toLounge(vm), vm.seq + 1);
    const unit = desk(office, 'st_r3_03'), walks = anims.made.slice(), states = (s) => walks.map(() => s);
    tab(e, true);
    assert.deepEqual(walks.map((a) => a.playState), states('paused'), 'held while hidden');
    if (heard) {
      reduceMotion(env, true);
      assert.deepEqual(walks.map((a) => a.playState), states('idle'), 'heard while hidden: ended at once');
      assert.equal(office.getAttribute('data-motion'), 'paused', 'still a hidden tab');
    } else env.reduce = true; // a background tab may hear the change only later
    tab(e, false);
    assert.deepEqual(walks.map((a) => a.playState), states('idle'), (heard ? 'heard' : 'not heard') + ': nothing plays on when the tab is back');
    assert.equal(office.getAttribute('data-motion'), 'run');
    assert.equal(unit.classList.contains('is-walking'), false);
  }
});

test('the office owns no timer: publishes, floor switches, the public switch and a hidden tab make no timer or rAF call from office code', () => {
  for (const f of OFFICE_JS) assert.doesNotMatch(read('src/page/' + f), new RegExp('\\b(?:' + TIMERS.join('|') + ')\\b'), f);
  const calls = [], limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 200;
  try {
    const { e, vm, office } = openOffice({ animate: animations().animate, configure: (ctx) => {
      for (const name of TIMERS) {
        const real = ctx[name];
        ctx[name] = function (...args) { calls.push({ name, stack: new Error().stack }); return real ? real.apply(this, args) : 0; };
      }
    } });
    for (let i = 1; i <= 20; i++) publish(e, i % 2 ? toLounge(vm) : vm, vm.seq + i);
    e.fire(office.querySelectorAll('.of-fl')[1], 'click');
    e.fire(office.querySelectorAll('.of-fl')[0], 'click');
    const sw = office.querySelector('[data-act="office-public"]');
    e.fire(sw, 'click');
    e.fire(sw, 'click');
    e.document.hidden = true;
    e.document.listeners.visibilitychange({ type: 'visibilitychange' });
    assert.ok(calls.length > 0, 'the spies see the page\'s own timers');
    assert.deepEqual(calls.filter((c) => /office-(?:assets|model|view)\.js/.test(c.stack)).map((c) => c.name), []);
  } finally {
    Error.stackTraceLimit = limit;
  }
});

// office.css as data: rules with their at-rule and declarations, and every @keyframes step's declarations
function sheet(css) {
  const rules = [], frames = {};
  const decls = (body) => Object.fromEntries(body.split(';').map((d) => d.split(/:(.*)/s)).filter((d) => d.length > 1).map(([k, v]) => [k.trim(), v.trim()]));
  const blocks = (text) => {
    const out = [];
    for (let i = 0; ;) {
      const open = text.indexOf('{', i);
      if (open < 0) return out;
      let depth = 1, j = open + 1;
      for (; depth; j++) depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0;
      out.push([text.slice(i, open).trim(), text.slice(open + 1, j - 1)]);
      i = j;
    }
  };
  const walk = (text, at) => {
    for (const [head, body] of blocks(text)) {
      if (head.startsWith('@keyframes')) frames[head.split(/\s+/)[1]] = blocks(body).map(([, b]) => decls(b));
      else if (head.startsWith('@')) walk(body, head);
      else rules.push({ at, selectors: head.split(',').map((s) => s.trim()), decls: decls(body) });
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), '');
  return { rules, frames };
}

test('office.css: keyframes move only transform and opacity; a paused root holds them; reduced motion turns every animation and transition off', () => {
  const { rules, frames } = sheet(read('src/page/office.css'));
  assert.ok(Object.keys(frames).length > 0);
  for (const [name, steps] of Object.entries(frames)) for (const step of steps) for (const prop of Object.keys(step)) assert.ok(['transform', 'opacity'].includes(prop), name + ': ' + prop);
  const animated = rules.filter((r) => !/reduced-motion/.test(r.at) && Object.keys(r.decls).some((k) => k === 'animation' || k === 'animation-name'));
  assert.ok(animated.length > 0);
  for (const r of animated) {
    assert.ok(r.selectors.every((s) => /^\.of[-\s.[]/.test(s)), 'only office elements move: ' + r.selectors.join(', '));
    assert.ok(Object.hasOwn(frames, r.decls.animation.split(/\s+/)[0]), 'its keyframes are in office.css: ' + r.decls.animation);
  }
  const paused = rules.find((r) => r.selectors.includes('.of[data-motion="paused"] *'));
  assert.equal(paused?.decls['animation-play-state'], 'paused !important');
  const calm = rules.find((r) => /prefers-reduced-motion:\s*reduce/.test(r.at) && r.selectors.includes('.of *'));
  assert.deepEqual([calm?.decls.animation, calm?.decls.transition], ['none !important', 'none !important']);
  assert.ok(['.of *::before', '.of *::after'].every((s) => calm.selectors.includes(s)), 'pseudo-elements too');
});

test('the 공개 모드 switch hides the bubbles, the tab label and the cwd from the office text and attributes, and brings them back', () => {
  const { e, vm, office } = openOffice();
  const s = vm.sessions[0], hidden = [worker(vm, 'st_r3_05').step, s.tabLabel + ' #' + s.tabNumber, s.cwd];
  const sw = office.querySelector('[data-act="office-public"]');
  assert.deepEqual([sw.tagName, sw.getAttribute('role'), sw.getAttribute('aria-checked')], ['BUTTON', 'switch', 'false']);
  assert.ok(sw.textContent.trim(), 'the switch has a name');
  const shown = () => hidden.map((t) => office.textContent.includes(t) || office.querySelectorAll('*').some((n) => Object.values(n.attrs).some((v) => v.includes(t))));
  const desks = office.querySelectorAll('.of-desk').length;
  assert.deepEqual(shown(), [true, true, true], 'off by default: shown');
  e.fire(sw, 'click');
  assert.deepEqual([e.page.state.ui.publicMode, sw.getAttribute('aria-checked')], [true, 'true']);
  assert.deepEqual(shown(), [false, false, false], 'on: in no text and no attribute of the office');
  assert.equal(office.querySelectorAll('.of-desk').length, desks, 'every desk stays');
  assert.equal(office.querySelector('[data-act="office-public"]'), sw, 'the switch is patched, not redrawn');
  e.fire(sw, 'click');
  assert.deepEqual([e.page.state.ui.publicMode, sw.getAttribute('aria-checked')], [false, 'false']);
  assert.deepEqual(shown(), [true, true, true], 'off again: shown');
});
