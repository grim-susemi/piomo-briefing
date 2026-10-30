// The talk dialog (src/page/office-view.js "the talk dialog", office-model.js near() and talk(); plan omo-office-view todo
// 11, Must have 13). The real page scripts run in the deterministic DOM of fixtures/controller-dom.mjs on
// fixtures/view-model-office.json; nothing animates here (no el.animate), so a click walk puts the boss on its tile at once,
// and the scene's screen matrix is the identity, so a click's clientX/Y is a point of the scene. The browser side (real
// keys and clicks, the real server's POST /answer over a temp state dir) is the CDP run of plan todo 11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeController, memoryStorage } from './fixtures/controller-dom.mjs';
import { decisionFields, decisionValues } from './fixtures/decision-fields.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const fixture = (p) => JSON.parse(read('test/fixtures/' + p));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MODULES = ['icons', 'view', 'plan-view', 'workers-view', 'blocks', 'convo-view', 'shell', 'annotate', 'office-assets', 'office-model', 'office-view'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const OX = 470, OY = 120, KX = 34 * 0.866, KY = 17, TILE = 0.5;
const iso = (x, y) => [OX + (x - y) * KX, OY + (x + y) * KY];
const floorPoint = ([sx, sy]) => { const u = (sx - OX) / KX, w = (sy - OY) / KY; return [(u + w) / 2, (w - u) / 2]; };
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const HOSTILE = fixture('hostile-strings.json');
const SID = 'o-r3', DEC = 516;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const reply = (status, json) => ({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(json) });

function openOffice({ protocol = 'http:', vm = fixture('view-model-office.json'), configure } = {}) {
  const e = makeController({ protocol, modules: MODULES, sessionStorage: memoryStorage(), configure: (ctx) => {
    ctx.document.createElementNS = (ns, tag) => Object.assign(ctx.document.createElement(tag), { namespaceURI: ns });
    const sprite = Object.assign(ctx.document.createElement('svg'), { namespaceURI: SVG_NS });
    sprite.id = 'icon-sprite';
    ctx.document.body.appendChild(sprite);
    ctx.matchMedia = (q) => ({ get matches() { return /reduce/.test(q) ? false : ctx.innerWidth < 900; }, addEventListener() {}, removeEventListener() {} });
    configure?.(ctx);
  } });
  e.page.receive(vm);
  e.fire(e.byId.rail.querySelector('[data-sh="view"][data-key="office"]'), 'click');
  const office = e.byId.main.querySelector('#office');
  office.querySelector('.of-scene').getScreenCTM = () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
  return { e, vm, office };
}
function shown(e, office) {
  const sid = office.querySelector('.of-fl[aria-pressed="true"]').getAttribute('data-floor');
  return clone(e.ctx.BriefOffice.scene(e.page.state.model, e.page.state.ui, e.page.state.model.generatedAt)).floors.find((f) => f.sid === sid);
}
function bossAt(office) {
  const pos = office.querySelector('.of-me .of-walk').children[0];
  const p = floorPoint(/^translate\(([-\d.]+),([-\d.]+)\) scale\(1\)$/.exec(pos.getAttribute('transform')).slice(1).map(Number));
  return [Math.round(p[0] / TILE - 0.5), Math.round(p[1] / TILE - 0.5)];
}
function press(e, key, code, more = {}) {
  return e.fire(e.document.activeElement || e.document.body, 'keydown', { key, code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...more });
}
function clickTile(e, office, [x, y]) {
  const [cx, cy] = iso((x + 0.5) * TILE, (y + 0.5) * TILE);
  return e.fire(office.querySelector('.of-l-base polygon'), 'click', { clientX: cx, clientY: cy });
}
const dialog = (office) => office.querySelector('.of-talk');
const rowText = (box, k) => { const r = box.querySelector('.of-tk-info [data-k="' + k + '"] dd'); return r ? r.textContent : null; };
const answerPosts = (e) => e.fetches.filter((f) => f.url === '/answer');
// the rule the plan reading documents (office-model.js near()): a cat's spot is the walk tiles its floor rectangle overlaps;
// the boss is next to it when its tile is in the spot or touches it, sides or corners
function spots(e, floor) {
  const cells = clone(e.ctx.BriefOffice.layout(floor));
  return floor.desks.map((d) => {
    const c = cells[d.id], r = d.room === 'lounge' ? [c.x - 0.2, c.y - 0.2, c.x + 0.2, c.y + 0.2] : [c.x, c.y, c.x + 1.6 * c.s, c.y + c.s], tiles = [];
    for (let y = 0; y < floor.walk.h; y++) for (let x = 0; x < floor.walk.w; x++) if (x * TILE < r[2] && (x + 1) * TILE > r[0] && y * TILE < r[3] && (y + 1) * TILE > r[1]) tiles.push([x, y]);
    return { id: d.id, tiles };
  });
}
const touches = (tiles, [x, y]) => tiles.some(([sx, sy]) => Math.abs(sx - x) <= 1 && Math.abs(sy - y) <= 1);
function reachable(floor) {
  const w = floor.walk.w, off = new Set(floor.walk.blocked), free = (x, y) => x >= 0 && y >= 0 && x < w && y < floor.walk.h && !off.has(y * w + x);
  const start = floor.spawn.y * w + floor.spawn.x, seen = new Set([start]), queue = [start];
  while (queue.length) {
    const at = queue.shift(), x = at % w, y = (at - x) / w;
    for (const [dx, dy] of SIDES) if (free(x + dx, y + dy) && !seen.has((y + dy) * w + x + dx)) { seen.add((y + dy) * w + x + dx); queue.push((y + dy) * w + x + dx); }
  }
  return [...seen].map((t) => [t % w, (t - (t % w)) / w]);
}
// a tile the boss can reach that is beside cat id (one side of its spot) and next to no other cat
function besideOnly(e, floor, id) {
  const all = spots(e, floor), mine = all.find((s) => s.id === id).tiles, others = all.filter((s) => s.id !== id);
  const tile = reachable(floor).find(([x, y]) => mine.some(([sx, sy]) => Math.abs(sx - x) + Math.abs(sy - y) === 1) && !others.some((s) => touches(s.tiles, [x, y])));
  assert.ok(tile, 'a tile beside ' + id + ' alone');
  return tile;
}
// a tile the boss can reach that is next to no cat
function nextToNobody(e, floor) {
  const all = spots(e, floor), tile = reachable(floor).find((t) => !all.some((s) => touches(s.tiles, t)));
  assert.ok(tile);
  return tile;
}
function walkTo(e, office, tile) {
  clickTile(e, office, tile);
  assert.deepEqual(bossAt(office), tile, 'the boss stands on ' + tile);
}
// the lead's dialog, opened with E from beside its desk
function talkToLead(e, office) {
  walkTo(e, office, besideOnly(e, shown(e, office), 'lead'));
  const ev = press(e, 'e', 'KeyE');
  assert.equal(ev.defaultPrevented, true);
  const box = dialog(office);
  assert.ok(box, 'the lead\'s dialog is open');
  return box;
}
function publish(e, vm) {
  vm.seq = e.page.state.seq + 1;
  e.advance(600);
  e.page.receive(vm);
}

test('E, Space or Enter beside a cat opens its dialog at the top of the rail; with no cat beside the boss they open nothing', () => {
  // Given the boss beside the lead's desk, When E is pressed, Then the dialog opens for the lead as the rail's first box and
  // takes the focus; Escape closes it and gives the focus to the office, Space (focus on the office) and Enter (focus on
  // the page) open it again; When the boss stands next to no cat, Then E is not taken and nothing opens
  const { e, office, vm } = openOffice();
  const s = vm.sessions.find((x) => x.id === SID), floor = shown(e, office);
  assert.equal(floor.sid, SID);
  const box = talkToLead(e, office);
  assert.equal(box.parentNode, office.querySelector('.of-rail'));
  assert.equal(office.querySelector('.of-rail').children[0], box);
  assert.match(box.getAttribute('aria-label'), /리더/);
  assert.equal(e.document.activeElement, box, 'the dialog takes the focus');
  assert.match(box.querySelector('.of-tk-where').textContent, new RegExp('^6층 · ' + s.title));
  const esc = press(e, 'Escape', 'Escape');
  assert.equal(esc.defaultPrevented, true, 'Escape is the dialog\'s while it is open');
  assert.equal(dialog(office), null);
  assert.equal(e.document.activeElement, office, 'the focus is back on the office');
  assert.equal(press(e, ' ', 'Space').defaultPrevented, true);
  assert.ok(dialog(office), 'Space from the office talks');
  press(e, 'Escape', 'Escape');
  e.document.activeElement = e.document.body;
  assert.equal(press(e, 'Enter', 'Enter').defaultPrevented, true);
  assert.ok(dialog(office), 'Enter from the page talks');
  press(e, 'Escape', 'Escape');
  assert.equal(press(e, 'Escape', 'Escape').defaultPrevented, undefined, 'with no dialog Escape is not taken');
  walkTo(e, office, nextToNobody(e, floor));
  for (const [key, code] of [['e', 'KeyE'], [' ', 'Space'], ['Enter', 'Enter']]) assert.equal(press(e, key, code).defaultPrevented, undefined, key + ' with no cat beside');
  assert.equal(dialog(office), null);
  assert.deepEqual(e.errors, []);
});

test('Space and Enter on a focused control keep their own action: a focused desk keeps its open action, a dialog button is not taken', () => {
  // Given the boss beside the lead, When Enter or Space is pressed with the lead's desk focused, Then the desk takes it (its
  // open action) and no dialog opens; When the dialog's 닫기 button has the focus, Then the office leaves Space and Enter
  // to the button and the dialog stays
  const { e, office } = openOffice();
  walkTo(e, office, besideOnly(e, shown(e, office), 'lead'));
  const desk = office.querySelector('.of-desk[data-desk="lead"]');
  for (const [key, code] of [['Enter', 'Enter'], [' ', 'Space']]) {
    desk.focus();
    assert.equal(press(e, key, code).defaultPrevented, true, key + ': the desk took it');
    assert.equal(dialog(office), null, key + ' on a focused desk opens no dialog');
  }
  e.document.activeElement = e.document.body;
  press(e, 'e', 'KeyE');
  const close = dialog(office).querySelector('.of-tk-x');
  close.focus();
  for (const [key, code] of [['Enter', 'Enter'], [' ', 'Space']]) assert.equal(press(e, key, code).defaultPrevented, undefined, key + ' stays with the button');
  assert.ok(dialog(office));
  e.fire(close, 'click');
  assert.equal(dialog(office), null, '닫기 closes it');
  assert.equal(e.document.activeElement, office);
});

test('a pointer click on a cat\'s own drawing talks to it; the desk under it, a keyboard click, a label and the floor keep their click', () => {
  // Given the first floor, When a lounge cat or a desk cat's head is clicked with the pointer, Then its dialog opens and the
  // office stays; When the desk itself is clicked, Then its conversation opens as before; a click without a pointer
  // (keyboard or script) on a lounge cat is its open action too, and a click on the floor walks the boss and opens nothing
  let { e, office } = openOffice();
  const lounge = office.querySelector('.of-desk[data-desk="st_r3_12"]');
  e.fire(lounge.querySelector('.of-cat'), 'click', { detail: 1, clientX: 5, clientY: 5 });
  assert.ok(dialog(office), 'the lounge cat\'s dialog');
  assert.match(dialog(office).getAttribute('aria-label'), /gate-reviewer/);
  assert.equal(e.page.state.ui.view, 'office');
  const unit = office.querySelector('.of-desk[data-desk="st_r3_03"]'), head = unit.querySelector('.of-cat').children[1];
  e.ctx.rects.set(head, { left: 300, top: 300, width: 40, height: 40 });
  e.fire(head, 'click', { detail: 1, clientX: 320, clientY: 320 });
  assert.match(dialog(office).getAttribute('aria-label'), /explore/, 'a desk cat\'s head talks to it');
  const tile = nextToNobody(e, shown(e, office));
  clickTile(e, office, tile);
  assert.deepEqual(bossAt(office), tile, 'the floor still walks the boss');
  assert.match(dialog(office).getAttribute('aria-label'), /explore/, 'a floor click opens no other dialog');
  e.fire(unit.querySelector('.of-slide polygon'), 'click', { detail: 1, clientX: 10, clientY: 10 });
  assert.equal(e.page.state.ui.view, 'conv', 'the desk under the cat is the open action');
  assert.equal(e.page.state.ui.sub[SID], 'wk');
  ({ e, office } = openOffice());
  e.fire(office.querySelector('.of-desk[data-desk="st_r3_12"] .of-cat'), 'click');
  assert.equal(e.page.state.ui.view, 'conv', 'a click with no pointer (Enter or Space on the focused desk) keeps the open action');
  ({ e, office } = openOffice());
  e.fire(office.querySelector('.of-tag[data-sh="open"] text'), 'click', { detail: 1 });
  assert.equal(e.page.state.ui.view, 'conv', 'a desk name label keeps the open action');
  assert.deepEqual(e.errors, []);
});

test('the lead cat\'s dialog shows its session from the view model, the kit\'s answer box for each open decision and the note box', () => {
  // Given o-r3 (in progress, live, decision 516 open, notes taken), When the lead is talked to on the live board, Then the
  // dialog names the floor, the title, the state and the headline, lists #516 with view.js's answer box (data-where office)
  // and has the note box; 대화 열기 is the lead's open action
  const { e, office, vm } = openOffice();
  const s = vm.sessions.find((x) => x.id === SID), d = s.decisions.find((x) => x.id === DEC), box = talkToLead(e, office);
  assert.equal(box.querySelector('.of-tk-name').textContent, '리더 · 작업실');
  assert.equal(box.querySelector('.of-tk-where').textContent, '6층 · ' + s.title);
  assert.equal(box.querySelector('.of-tk-head .of-st').textContent, '일함');
  assert.equal(rowText(box, 'headline'), s.headline);
  assert.equal(rowText(box, 'next'), null, 'an empty next is no row');
  assert.equal(rowText(box, 'open'), '1건 기다림');
  const ask = box.querySelector('.of-tk-ask[data-ask="' + DEC + '"]');
  assert.ok(ask.querySelector('.of-tk-q').textContent.includes(d.question));
  const opts = ask.querySelectorAll('.ans-box[data-ans="' + DEC + '"] [data-act="ans-pick"]');
  assert.deepEqual(opts.map((b) => [b.getAttribute('data-opt'), b.getAttribute('data-id'), b.getAttribute('data-where')]), [['A', '516', 'office'], ['B', '516', 'office']]);
  assert.ok(opts[0].textContent.includes(d.options.A.text));
  assert.ok(box.querySelector('.of-tk-note textarea.of-tk-ta'), 'the note box');
  const open = box.querySelector('.of-tk-foot [data-sh="open"]');
  assert.deepEqual([open.getAttribute('data-sid'), open.getAttribute('data-sub')], [SID, null]);
  e.fire(open, 'click');
  assert.deepEqual([e.page.state.ui.view, e.ctx.BriefShell.shownOf(e.page.state.ui, e.page.state.ui.active)], ['conv', SID], '대화 열기 opens the conversation');
  assert.deepEqual(e.errors, []);
});

test('pick A -> 보내기 in the dialog posts {id, sessionId, option} once through page.js; 보내는 중… and 보냄 show in place', async () => {
  // Given the lead's dialog, When A is picked (focused) and 보내기 pressed, Then the confirm row shows with the focus kept on
  // A, one POST /answer carries {id: 516, sessionId: o-r3, option: A}, the box shows 보내는 중… then 보냄 · 전달 상태 기다리는
  // 중…, and it stays until the decision's delivery receipt arrives
  const { e, office, vm } = openOffice();
  let box = talkToLead(e, office);
  const pickA = box.querySelector('[data-act="ans-pick"][data-opt="A"]');
  pickA.focus();
  e.fire(pickA, 'click', { detail: 1 });
  box = dialog(office);
  assert.ok(box.querySelector('.ans-box .ans-confirm'), 'the confirm row');
  assert.equal(e.document.activeElement, box.querySelector('[data-act="ans-pick"][data-opt="A"]'), 'the focus stays on A');
  assert.equal(box.querySelector('[data-act="ans-pick"][data-opt="A"]').getAttribute('aria-pressed'), 'true');
  e.fire(box.querySelector('[data-act="ans-send"]'), 'click', { detail: 1 });
  assert.equal(answerPosts(e).length, 1);
  const post = answerPosts(e)[0];
  assert.deepEqual(JSON.parse(post.opts.body), { id: DEC, sessionId: SID, option: 'A' });
  assert.equal(post.opts.headers['X-Board-Token'], 'tok-1');
  assert.equal(box.querySelector('.ans-box .ans-state').textContent, '보내는 중…');
  assert.equal(e.document.activeElement, box, 'the pressed button went: the focus is the dialog\'s');
  e.fire(box, 'click', { detail: 1 });
  assert.equal(answerPosts(e).length, 1, 'no second POST');
  post.resolve(reply(200, { ok: true, id: DEC }));
  await settle();
  assert.equal(box.querySelector('.ans-box .ans-state').textContent, '보냄 · 전달 상태 기다리는 중…');
  const answered = clone(vm), d = answered.sessions.find((x) => x.id === SID).decisions.find((x) => x.id === DEC);
  Object.assign(d, { answered: true, answer: { option: 'A', text: '', at: 1 }, receipt: null });
  publish(e, answered);
  assert.equal(dialog(office), box, 'the same dialog');
  assert.equal(box.querySelector('.ans-box .ans-state').textContent, '보냄 · 전달 상태 기다리는 중…', 'sent stays until delivered');
  assert.equal(rowText(box, 'open'), '없음');
  const delivered = clone(answered);
  delivered.sessions.find((x) => x.id === SID).decisions.find((x) => x.id === DEC).receipt = { kind: 'steered', deliveredAt: 1, proven: true };
  publish(e, delivered);
  assert.equal(box.querySelector('.of-tk-ask'), null, 'delivered: it leaves the dialog');
  assert.equal(answerPosts(e).length, 1);
  assert.deepEqual(e.errors, []);
});

test('a worker cat\'s dialog is info only: its step and state, no answer box, no note box; 대화 열기 opens the worker', () => {
  // Given a working explore cat (its step a hostile string), When it is talked to, Then the dialog shows its role, name,
  // state and step as text, has no .ans-box and no note box, and 대화 열기 is the worker's open action
  const vm = fixture('view-model-office.json'), w = vm.sessions.find((x) => x.id === SID).live.workers.find((x) => x.id === 'st_r3_03');
  w.step = HOSTILE[3];
  const { e, office } = openOffice({ vm });
  walkTo(e, office, besideOnly(e, shown(e, office), 'st_r3_03'));
  press(e, 'e', 'KeyE');
  const box = dialog(office);
  assert.equal(box.querySelector('.of-tk-name').textContent, 'explore · 조사실');
  assert.ok(box.querySelector('.of-tk-where').textContent.endsWith(' · ' + w.name));
  assert.equal(box.querySelector('.of-tk-head .of-st').textContent, '일함');
  assert.equal(rowText(box, 'step'), HOSTILE[3]);
  assert.deepEqual([box.querySelectorAll('.ans-box').length, box.querySelectorAll('.of-tk-note').length, box.querySelectorAll('textarea').length], [0, 0, 0]);
  assert.equal(box.querySelectorAll('svg[onload],img,script').length, 0);
  const open = box.querySelector('.of-tk-foot [data-sh="open"]');
  assert.deepEqual([open.getAttribute('data-sid'), open.getAttribute('data-sub')], [SID, 'wk']);
  e.fire(open, 'click');
  assert.deepEqual([e.page.state.ui.view, e.page.state.ui.sub[SID]], ['conv', 'wk']);
});

test('the note box: 보내기 goes out through ui.sendNote; 보내기 is off while it sends; on success the tray notes stay and the office stays', async () => {
  // Given a tray note waiting for o-r3 and the lead's dialog, When a note is typed and 보내기 pressed, Then one annotation
  // POST carries {kind, sessionId, requestId, text}, the line says 보내는 중… with 보내기 off, and after the 200 the line says
  // 보냄, the typed text is gone, the tray note is still there and 사무실 is still the view
  const { e, office } = openOffice(), A = e.ctx.BriefAnnotate;
  assert.equal(A.add(SID, { blocks: ['now'], sub: 'ov', text: '', snip: '지금', intent: '고쳐줘', comment: '트레이 주석', paths: [] }).ok, true);
  const box = talkToLead(e, office), ta = box.querySelector('.of-tk-ta'), send = box.querySelector('.of-tk-send');
  assert.equal(send.disabled, true, 'nothing to send yet');
  ta.value = '  사무실에서 보낸 글  ';
  e.fire(ta, 'input');
  assert.equal(send.disabled, false);
  e.fire(send, 'click', { detail: 1 });
  assert.equal(answerPosts(e).length, 1);
  assert.deepEqual(JSON.parse(answerPosts(e)[0].opts.body), { kind: 'annotation', sessionId: SID, requestId: '11111111-1111-4111-8111-000000000001', text: '사무실에서 보낸 글' });
  assert.equal(box.querySelector('.of-tk-msg').textContent, '보내는 중…');
  assert.equal(box.querySelector('.of-tk-msg').getAttribute('role'), 'status');
  assert.equal(send.disabled, true, '보내기 is off while it sends');
  e.fire(send, 'click', { detail: 1 });
  assert.equal(answerPosts(e).length, 1);
  answerPosts(e)[0].resolve(reply(200, { ok: true, key: 'a-11111111-1111-4111-8111-000000000001' }));
  await settle();
  assert.equal(box.querySelector('.of-tk-msg').textContent, '보냄 · 전달 상태 기다리는 중…');
  assert.equal(ta.value, '', 'the sent note left the box');
  assert.deepEqual(clone(A.list(SID)).map((n) => n.comment), ['트레이 주석'], 'the tray note is still there');
  assert.equal(e.page.state.ui.view, 'office');
  assert.equal(dialog(office), box);
  assert.deepEqual(e.errors, []);
});

test('a pending tray request of other text: the dialog shows the conflict line and sends nothing; 새로 보내기 then sends anew', async () => {
  // Given the tray's send for o-r3 refused with 503 (its request stays pending), When a different note is sent from the
  // office dialog, Then the conflict line with 새로 보내기 shows and no POST goes out; after 새로 보내기, 보내기 posts a new
  // request id
  const { e, office } = openOffice(), A = e.ctx.BriefAnnotate;
  A.add(SID, { blocks: ['now'], sub: 'ov', text: '', snip: '지금', intent: '고쳐줘', comment: '트레이 주석', paths: [] });
  e.page.open(SID, 'ov');
  e.fire(e.byId.main.querySelector('[data-ann-act="send"]'), 'click');
  const trayPost = answerPosts(e)[0];
  assert.match(JSON.parse(trayPost.opts.body).text, /상황판 피드백/);
  trayPost.resolve(reply(503, { ok: false, code: 'PAUSED' }));
  await settle();
  e.fire(e.byId.rail.querySelector('[data-sh="view"][data-key="office"]'), 'click');
  const again = e.byId.main.querySelector('#office');
  again.querySelector('.of-scene').getScreenCTM = () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
  const box = talkToLead(e, again), ta = box.querySelector('.of-tk-ta');
  ta.value = '다른 글';
  e.fire(ta, 'input');
  e.fire(box.querySelector('.of-tk-send'), 'click', { detail: 1 });
  assert.equal(answerPosts(e).length, 1, 'nothing sent');
  assert.equal(box.querySelector('.of-tk-msg').textContent, '같은 묶음이 이미 다른 내용으로 보내졌어요 - 새로 보내기');
  assert.equal(box.querySelector('.of-tk-msg').getAttribute('role'), 'alert');
  const renew = box.querySelector('[data-act="ann-new"]');
  assert.equal(renew.getAttribute('data-sid'), SID);
  e.fire(renew, 'click', { detail: 1 });
  assert.equal(box.querySelector('.of-tk-msg'), null, '새로 보내기 clears the line');
  assert.equal(ta.value, '다른 글', 'the typed note stayed');
  e.fire(box.querySelector('.of-tk-send'), 'click', { detail: 1 });
  assert.equal(answerPosts(e).length, 2);
  const body = JSON.parse(answerPosts(e)[1].opts.body);
  assert.deepEqual([body.text, body.requestId === JSON.parse(trayPost.opts.body).requestId], ['다른 글', false]);
  assert.deepEqual(e.errors, []);
});

test('the dialog is patched in place: a publish keeps its nodes, the typed note with its focus and caret, and a picked answer', () => {
  // Given the lead's dialog with A picked and a note typed (focus and caret in the note box), When a vm update is held for
  // the typing and then applied, Then the dialog, the note box, the text, the focus, the caret and the confirm row are the
  // same nodes and values; When an untouched decision closes elsewhere, Then it leaves the list without an exception
  const vm = fixture('view-model-office.json');
  vm.sessions.find((x) => x.id === SID).decisions.push({ id: 901, sessionId: SID, question: '두 번째 질문', options: { A: { text: '예', consequence: '-' }, B: { text: '아니요', consequence: '-' } }, recommend: 'A', reason: '', blocks: false, createdAt: 1, answered: false, closed: false });
  const { e, office } = openOffice({ vm });
  const box = talkToLead(e, office);
  e.fire(box.querySelector('[data-ask="516"] [data-act="ans-pick"][data-opt="A"]'), 'click', { detail: 1 });
  const confirm = box.querySelector('[data-ask="516"] .ans-confirm'), pickA = box.querySelector('[data-ask="516"] [data-act="ans-pick"][data-opt="A"]');
  const ta = box.querySelector('.of-tk-ta');
  ta.value = '쓰는 중인 글';
  e.fire(ta, 'input');
  ta.focus();
  Object.assign(ta, { selectionStart: 2, selectionEnd: 4 });
  const next = clone(vm);
  next.sessions.find((x) => x.id === 'o-adv').headline = '다른 층의 새 소식';
  publish(e, next);
  assert.equal(e.page.state.seq, vm.seq, 'held while the note is being typed');
  e.page.apply();
  assert.equal(e.page.state.seq, next.seq, 'then applied');
  assert.equal(dialog(office), box);
  assert.equal(box.querySelector('.of-tk-ta'), ta);
  assert.deepEqual([ta.value, e.document.activeElement === ta, ta.selectionStart, ta.selectionEnd], ['쓰는 중인 글', true, 2, 4]);
  assert.equal(box.querySelector('[data-ask="516"] .ans-confirm'), confirm, 'the half-picked answer is the same node');
  assert.equal(box.querySelector('[data-ask="516"] [data-act="ans-pick"][data-opt="A"]'), pickA);
  const closed = clone(next);
  closed.sessions.find((x) => x.id === SID).decisions.find((x) => x.id === 901).answered = true;
  e.document.activeElement = e.document.body;
  publish(e, closed);
  assert.equal(box.querySelector('[data-ask="901"]'), null, 'closed elsewhere: gone from the list');
  assert.ok(box.querySelector('[data-ask="516"] .ans-confirm'), 'the picked one stays');
  assert.deepEqual(e.errors, []);
});

test('the closed state: a decision answered elsewhere after the pick shows 이미 답했거나 닫힌 결정 on 보내기 and sends nothing', () => {
  // Given A picked in the dialog, When the decision comes back answered (republished) and 보내기 is pressed, Then the box
  // shows the closed state and no POST goes out (page.js sendAnswer's own check)
  const { e, office, vm } = openOffice();
  const box = talkToLead(e, office);
  e.fire(box.querySelector('[data-act="ans-pick"][data-opt="A"]'), 'click', { detail: 1 });
  const answered = clone(vm);
  answered.sessions.find((x) => x.id === SID).decisions.find((x) => x.id === DEC).answered = true;
  publish(e, answered);
  assert.ok(box.querySelector('[data-ask="516"] .ans-confirm'), 'the confirm row is still there to press');
  e.fire(box.querySelector('[data-ask="516"] [data-act="ans-send"]'), 'click', { detail: 1 });
  assert.equal(answerPosts(e).length, 0);
  assert.equal(box.querySelector('[data-ask="516"] .ans-err').textContent, e.page.answerText.closed);
  assert.deepEqual(e.errors, []);
});

test('보류 in the dialog asks first, then posts {id, sessionId, action: hold} once; the held decision leaves the dialog', async () => {
  // Given the lead's dialog, When 보류 is pressed, Then the kit's hold confirm row shows and nothing is sent; When its 보류
  // is pressed, Then one POST /answer carries {id: 516, sessionId: o-r3, action: hold}, and after the 200 the decision is
  // no longer listed and the open count is 없음
  const { e, office } = openOffice(), box = talkToLead(e, office);
  e.fire(box.querySelector('[data-ask="516"] [data-act="ans-hold"]'), 'click', { detail: 1 });
  assert.ok(box.querySelector('[data-ask="516"] .ans-hold-confirm'), 'the hold confirm row');
  assert.equal(answerPosts(e).length, 0, 'it asks first');
  e.fire(box.querySelector('[data-ask="516"] [data-act="ans-send"]'), 'click', { detail: 1 });
  assert.equal(answerPosts(e).length, 1);
  assert.deepEqual(JSON.parse(answerPosts(e)[0].opts.body), { id: DEC, sessionId: SID, action: 'hold' });
  answerPosts(e)[0].resolve(reply(200, { ok: true }));
  await settle();
  assert.equal(box.querySelector('[data-ask="516"]'), null, 'held: nothing to answer here');
  assert.equal(rowText(box, 'open'), '없음');
  assert.equal(answerPosts(e).length, 1);
  assert.deepEqual(e.errors, []);
});

test('a decision with typed fields gets the kit\'s field box; a field page.js draws again keeps the focus; 입력 확인 -> 보내기 posts the values', () => {
  // Given decision 516 asking for typed values (the decision-fields fixture: text, number, radio and select), When the
  // lead is talked to, Then its answer box is the kit's field box; When each field is typed in (page.js renders on every
  // input), Then the focus is on that field of the box drawn again; When 입력 확인 and 보내기 are pressed, Then one POST
  // carries {id, sessionId, values}
  const vm = fixture('view-model-office.json');
  Object.assign(vm.sessions.find((x) => x.id === SID).decisions.find((x) => x.id === DEC), { fields: decisionFields(), options: {}, recommend: '' });
  const { e, office } = openOffice({ vm }), box = talkToLead(e, office);
  assert.deepEqual(['text', 'number', 'radio'].map((type) => box.querySelectorAll('.ans-fields input[type="' + type + '"][data-where="office"]').length), [1, 1, 3]);
  assert.equal(box.querySelectorAll('.ans-fields select[data-field="layout"] option').length, 5);
  for (const [id, value] of Object.entries(decisionValues())) {
    const input = box.querySelector('[data-field="' + id + '"]' + (id === 'theme' ? '[value="' + value + '"]' : ''));
    input.value = String(value);
    input.focus();
    e.fire(input, 'input');
    const now = e.document.activeElement;
    assert.ok(box.contains(now), id + ': the focus is in the dialog');
    assert.deepEqual([now.getAttribute('data-field'), now.getAttribute('data-where')], [id, 'office'], id + ': on its field');
  }
  e.fire(box.querySelector('[data-act="ans-fields"]'), 'click', { detail: 1 });
  e.fire(box.querySelector('[data-ask="516"] [data-act="ans-send"]'), 'click', { detail: 1 });
  assert.equal(answerPosts(e).length, 1);
  assert.deepEqual(JSON.parse(answerPosts(e)[0].opts.body), { id: DEC, sessionId: SID, values: decisionValues() });
  assert.deepEqual(e.errors, []);
});

test('the file:// copy and public mode have no answer box and no note box; public mode blanks the step, headline and next at once', () => {
  // Given the lead's dialog, When it is open on the file:// copy, Then it has the info and no .ans-box or note box; When
  // 공개 모드 is switched on with the dialog open on the live board, Then the boxes and the agent-written rows go at once, and
  // switched off they come back
  const file = openOffice({ protocol: 'file:' }), fbox = talkToLead(file.e, file.office);
  assert.ok(rowText(fbox, 'headline'));
  assert.deepEqual([fbox.querySelectorAll('.ans-box').length, fbox.querySelectorAll('.of-tk-note').length, fbox.querySelectorAll('textarea').length], [0, 0, 0]);
  const vm = fixture('view-model-office.json'), s = vm.sessions.find((x) => x.id === SID);
  s.next = '다음 할 일';
  const { e, office } = openOffice({ vm }), box = talkToLead(e, office);
  assert.deepEqual([box.querySelectorAll('.ans-box').length, box.querySelectorAll('.of-tk-note').length, rowText(box, 'headline'), rowText(box, 'next')], [1, 1, s.headline, '다음 할 일']);
  e.fire(office.querySelector('[data-act="office-public"]'), 'click');
  assert.equal(e.page.state.ui.publicMode, true);
  assert.equal(dialog(office), box);
  assert.deepEqual([box.querySelectorAll('.ans-box').length, box.querySelectorAll('.of-tk-note').length, rowText(box, 'headline'), rowText(box, 'next'), rowText(box, 'step')], [0, 0, null, null, null]);
  assert.equal(box.querySelector('.of-tk-where').textContent, '6층 · ' + s.title, 'the title and floor stay');
  e.fire(office.querySelector('[data-act="office-public"]'), 'click');
  assert.deepEqual([box.querySelectorAll('.ans-box').length, box.querySelectorAll('.of-tk-note').length, rowText(box, 'headline')], [1, 1, s.headline]);
  assert.deepEqual([file.e.errors, e.errors], [[], []]);
});

test('hostile decision text renders as text: no element, attribute or handler comes from it', () => {
  // Given decision 516 with the hostile fixture strings as its question and options, When the lead is talked to, Then the
  // dialog holds those strings as text, and no img, script or handler attribute exists in it
  const vm = fixture('view-model-office.json'), d = vm.sessions.find((x) => x.id === SID).decisions.find((x) => x.id === DEC);
  d.question = HOSTILE[1];
  d.options = { A: { text: HOSTILE[2], consequence: HOSTILE[4] }, B: { text: HOSTILE[3], consequence: '-' } };
  const { e, office } = openOffice({ vm }), box = talkToLead(e, office);
  assert.ok(box.querySelector('.of-tk-q').textContent.includes(HOSTILE[1]));
  const opts = box.querySelectorAll('[data-act="ans-pick"]');
  assert.ok(opts[0].textContent.includes(HOSTILE[2]) && opts[1].textContent.includes(HOSTILE[3]));
  const all = box.querySelectorAll('*');
  assert.deepEqual(all.filter((n) => /^(?:IMG|SCRIPT|IFRAME|OBJECT|EMBED|LINK|STYLE)$/.test(n.tagName)).map((n) => n.tagName), []);
  assert.deepEqual(all.flatMap((n) => Object.keys(n.attrs).filter((k) => /^on|^style$|^src$/i.test(k) || (k === 'href' && !/^#/.test(n.attrs[k])))), []);
  assert.equal(e.ctx.pwned, undefined);
  assert.deepEqual(e.errors, []);
});

test('an answer box whose markup the office parser does not take leaves the office up: that box points to the conversation', () => {
  // Given the lead's dialog while view.js's kit answer box carries markup outside the office allowlist (a title attribute
  // and a <br>, what a later kit change could add), When the lead is talked to, Then nothing throws: the office and its
  // desks stay, the decision keeps its question, its box shows the line that points to 대화 열기 and no control from that
  // markup, and the failure is reported once; When the kit's markup is back to what the office takes, Then the next
  // publish draws the answer box again
  const { e, office, vm } = openOffice(), kit = e.ctx.BriefView.kit, real = kit.answerBox;
  kit.answerBox = (...a) => real(...a).replace('<button', '<button title="새 속성"').replace('</div>', '<br></div>');
  const box = talkToLead(e, office);
  assert.equal(e.byId.main.querySelector('#office'), office, 'the office region stays');
  assert.equal(office.querySelectorAll('.of-desk').length, 13);
  const ask = box.querySelector('.of-tk-ask[data-ask="' + DEC + '"]');
  assert.ok(ask.querySelector('.of-tk-q').textContent.includes(vm.sessions.find((x) => x.id === SID).decisions.find((x) => x.id === DEC).question));
  assert.deepEqual([ask.querySelector('.ans-box'), ask.querySelector('button'), ask.querySelector('br')], [null, null, null]);
  assert.match(ask.querySelector('.of-tk-kit').textContent, /대화 열기/);
  assert.ok(box.querySelector('.of-tk-foot [data-sh="open"]'), '대화 열기 stays');
  assert.equal(e.errors.length, 1, 'reported once');
  assert.match(String(e.errors[0][0]), /office answer box/);
  kit.answerBox = real;
  publish(e, clone(vm));
  assert.deepEqual(box.querySelectorAll('.ans-box[data-ans="' + DEC + '"] [data-act="ans-pick"]').map((b) => b.getAttribute('data-opt')), ['A', 'B']);
  assert.equal(e.errors.length, 1);
});

test('the dialog follows the status hook: 보내는 중… with 보내기 off, the conflict line with 새로 보내기, then no line', () => {
  // Given the lead's dialog, When annotate.js status() sets o-r3's line to sending, to the conflict and back to nothing,
  // Then the dialog's line and its 보내기 follow each step at once
  const { e, office } = openOffice(), A = e.ctx.BriefAnnotate, box = talkToLead(e, office), ta = box.querySelector('.of-tk-ta');
  ta.value = '글';
  e.fire(ta, 'input');
  A.status(SID, { text: '보내는 중…', sending: true });
  assert.deepEqual([box.querySelector('.of-tk-msg').textContent, box.querySelector('.of-tk-send').disabled], ['보내는 중…', true]);
  A.status(SID, { text: '같은 묶음이 이미 다른 내용으로 보내졌어요 - 새로 보내기', conflict: true });
  assert.deepEqual([box.querySelector('.of-tk-msg').textContent, box.querySelector('.of-tk-send').disabled, !!box.querySelector('[data-act="ann-new"]')], ['같은 묶음이 이미 다른 내용으로 보내졌어요 - 새로 보내기', false, true]);
  A.status(SID, null);
  assert.deepEqual([box.querySelector('.of-tk-msg'), box.querySelector('[data-act="ann-new"]'), box.querySelector('.of-tk-send').disabled], [null, null, false]);
  A.status('o-adv', { text: '보내는 중…', sending: true });
  assert.equal(box.querySelector('.of-tk-msg'), null, 'another conversation\'s line is not this dialog\'s');
  assert.deepEqual(e.errors, []);
});

test('keys typed in the dialog\'s text fields stay there: the boss stays, the dialog stays, nothing is taken, Escape included', () => {
  // Given the lead's dialog, When w, a, s, d, the arrows, E, Space, Enter and Escape are pressed in the note box and in the
  // answer reply box, Then no key is prevented, the boss does not move and the dialog stays (plan Must NOT: no key capture
  // while the focus is in a text field); Escape with the focus on the dialog closes it, and the next arrow steps the boss
  const { e, office } = openOffice(), box = talkToLead(e, office), at = bossAt(office);
  e.fire(box.querySelector('[data-act="ans-reply"]'), 'click', { detail: 1 });
  const reply = box.querySelector('textarea[data-draft="516"][data-where="office"]');
  assert.equal(e.document.activeElement, reply, 'page.js focused the office reply box');
  for (const field of [box.querySelector('.of-tk-ta'), reply]) {
    field.focus();
    for (const [key, code] of [['w', 'KeyW'], ['a', 'KeyA'], ['s', 'KeyS'], ['d', 'KeyD'], ['ArrowUp', 'ArrowUp'], ['ArrowRight', 'ArrowRight'], ['ArrowDown', 'ArrowDown'], ['ArrowLeft', 'ArrowLeft'], ['e', 'KeyE'], [' ', 'Space'], ['Enter', 'Enter'], ['Escape', 'Escape']]) {
      assert.equal(press(e, key, code).defaultPrevented, undefined, key + ' stays in ' + field.getAttribute('class'));
    }
    assert.deepEqual(bossAt(office), at);
    assert.equal(dialog(office), box);
  }
  box.focus();
  assert.equal(press(e, 'Escape', 'Escape').defaultPrevented, true);
  assert.equal(dialog(office), null);
  assert.equal(e.document.activeElement, office);
  const floor = shown(e, office), off = new Set(floor.walk.blocked);
  const [key, dx, dy] = [['ArrowUp', 0, -1], ['ArrowDown', 0, 1], ['ArrowLeft', -1, 0], ['ArrowRight', 1, 0]].find(([, x, y]) => !off.has((at[1] + y) * floor.walk.w + at[0] + x));
  assert.equal(press(e, key, key).defaultPrevented, true);
  assert.deepEqual(bossAt(office), [at[0] + dx, at[1] + dy], 'the keys are the boss\'s again');
});

test('another floor, a cat that leaves or another view closes the dialog cleanly', () => {
  // Given a worker's dialog with the focus in it, When a publish drops that worker, Then the dialog goes and the focus is
  // the office's; When the lead's dialog is open and another floor is picked, Then it goes; leaving 사무실 leaves no error
  const { e, office, vm } = openOffice();
  walkTo(e, office, besideOnly(e, shown(e, office), 'st_r3_03'));
  press(e, 'e', 'KeyE');
  assert.match(dialog(office).getAttribute('aria-label'), /explore/);
  const gone = clone(vm);
  gone.sessions.find((x) => x.id === SID).live.workers = gone.sessions.find((x) => x.id === SID).live.workers.filter((w) => w.id !== 'st_r3_03');
  publish(e, gone);
  assert.equal(dialog(office), null);
  assert.equal(e.document.activeElement, office);
  talkToLead(e, office);
  e.fire(office.querySelectorAll('.of-fl')[1], 'click');
  assert.notEqual(shown(e, office).sid, SID);
  assert.equal(dialog(office), null);
  assert.equal(office.querySelectorAll('.of-talk').length, 0);
  e.fire(office.querySelectorAll('.of-fl')[0], 'click');
  talkToLead(e, office);
  e.fire(e.byId.rail.querySelector('[data-sh="view"][data-key="home"]'), 'click');
  assert.equal(e.byId.main.querySelector('#office'), null);
  assert.deepEqual(e.errors, []);
});

test('talking calls no timer, storage or request of the office\'s own: the only POSTs are page.js\'s /answer', async () => {
  // Given spies on every timer, storage write and request, When the boss talks, picks, sends an answer and a note and closes
  // the dialog, Then none of them is called from the office files (page.js's own calls on the office's behalf are its own:
  // the caller is the frame right under the spy)
  const calls = [], limit = Error.stackTraceLimit, caller = (stack) => stack.split('\n')[2] || '';
  Error.stackTraceLimit = 200;
  try {
    const { e, office } = openOffice({ configure: (ctx) => {
      const spy = (owner, name) => { const real = owner[name]; owner[name] = function (...args) { calls.push({ name, stack: new Error().stack }); return real ? real.apply(this, args) : undefined; }; };
      for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'fetch']) spy(ctx, name);
      spy(ctx.localStorage, 'setItem');
      spy(ctx.sessionStorage, 'setItem');
    } });
    const box = talkToLead(e, office);
    e.fire(box.querySelector('[data-act="ans-pick"][data-opt="B"]'), 'click', { detail: 1 });
    e.fire(box.querySelector('[data-act="ans-send"]'), 'click', { detail: 1 });
    const ta = box.querySelector('.of-tk-ta');
    ta.value = '글';
    e.fire(ta, 'input');
    e.fire(box.querySelector('.of-tk-send'), 'click', { detail: 1 });
    answerPosts(e).forEach((p) => p.resolve(reply(200, { ok: true })));
    await settle();
    press(e, 'Escape', 'Escape');
    assert.deepEqual(answerPosts(e).map((p) => Object.keys(JSON.parse(p.opts.body)).sort().join(',')), ['id,option,sessionId', 'kind,requestId,sessionId,text']);
    assert.deepEqual(calls.filter((c) => /office-(?:assets|model|view)\.js/.test(caller(c.stack))).map((c) => c.name), []);
    assert.ok(calls.some((c) => c.name === 'fetch' && /page\.js/.test(caller(c.stack))), 'the spy sees page.js\'s POSTs');
    assert.ok(calls.some((c) => c.name === 'setItem' && /page\.js/.test(caller(c.stack)) && /office-view\.js/.test(c.stack)), 'and page.js\'s own storage write for the note');
    assert.deepEqual(e.errors, []);
  } finally {
    Error.stackTraceLimit = limit;
  }
});
