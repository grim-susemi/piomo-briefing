/* omo-briefing office scene model: classic script (file:// safe). Pure: board view-model -> scene data.
 * Reads no clock, makes no request and builds no markup; office-view.js draws the scene. */
(function (g) {
  'use strict';
  var ROOM_OF_KIND = { prometheus: 'plan', 'plan-consultant': 'plan', 'plan-reviewer': 'plan', architect: 'plan', explore: 'research', librarian: 'research', oracle: 'review', sisyphus: 'work', hephaestus: 'work', atlas: 'work' };
  var WORKER = { running: ['working', 'typing', 'on'], waiting: ['waiting', 'idle', 'off'], done: ['done', 'rest', 'off'], cancelled: ['cancelled', 'rest', 'off'], error: ['error', 'alert', 'alert'], lost: ['lost', 'alert', 'alert'] };
  function obj(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  function roomOf(w) {
    if (w.state === 'waiting' || w.state === 'done' || w.state === 'cancelled') return 'lounge';
    var k = str(w.kind).toLowerCase();
    if (has(ROOM_OF_KIND, k)) return ROOM_OF_KIND[k];
    if (/review|qa-executor/.test(k)) return 'review';
    if (/explore|librarian/.test(k)) return 'research';
    if (/prometheus|plan-|architect/.test(k)) return 'plan';
    return 'work';
  }
  function emptyRooms() { return { ceo: [], plan: [], research: [], work: [], review: [], lounge: [] }; }
  function openCount(s) { return arr(s.decisions).filter(function (d) { return obj(d) && !d.answered && !d.closed; }).length; }
  function floorOf(s, ui) {
    var alive = s.alive === true, rooms = emptyRooms(), desks = [];
    var lead = { id: 'lead', room: 'work', kind: 'lead', state: str(s.statusKey) || str(s.status), pose: alive ? 'typing' : 'rest', bubble: '', lamp: openCount(s) > 0 ? 'alert' : 'off' };
    desks.push(lead);
    arr(obj(s.live) && s.live.workers).filter(obj).forEach(function (w) {
      var st = has(WORKER, w.state) ? WORKER[w.state] : WORKER.waiting;
      desks.push({ id: str(w.id), room: roomOf(w), kind: 'worker', agent: str(w.kind), state: st[0], pose: st[1], bubble: ui.publicMode === true ? '' : str(w.step), lamp: st[2] });
    });
    desks.forEach(function (d) { rooms[d.room].push(d.id); });
    var floor = { sid: str(s.id), label: str(s.title), live: alive, dark: !alive && obj(s.folded), rooms: rooms, desks: desks, walk: { w: 0, h: 0, blocked: [] }, spawn: { x: 0, y: 0 } };
    if (obj(s.plan)) {
      var lanes = g.BriefPlanView.lanesOf(s.plan);
      floor.conveyor = { waves: lanes.map(function (l) { return { n: l.wave.n, label: str(l.wave.label), done: l.done, total: l.tasks.length }; }), current: g.BriefPlanView.currentOf(lanes) };
    }
    return floor;
  }
  function byFloor(a, b) {
    return (b.live - a.live) || ((Number(b.at) || 0) - (Number(a.at) || 0)) || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0);
  }
  function scene(vm, ui, now) {
    var sessions = arr(vm.sessions).filter(obj);
    var floors = sessions.map(function (s) { var f = floorOf(s, ui); f.at = Number(s.lastActivityAt) || 0; return f; }).sort(byFloor);
    floors.forEach(function (f) { delete f.at; f.live = f.live === true; });
    var ib = g.BriefShell.inbox(vm, ui);
    var items = ib.wait.concat(ib.done).map(function (it) { return { sid: str(it.s.id), sub: it.sub, kind: str(it.kind), text: str(it.text), at: it.at }; });
    var alerts = [], people = [], log = [];
    sessions.forEach(function (s) {
      var sid = str(s.id);
      arr(obj(s.live) && s.live.workers).filter(obj).forEach(function (w) {
        var row = { sid: sid, id: str(w.id), name: str(w.name), kind: str(w.kind), room: roomOf(w), state: str(w.state) };
        people.push(row);
        if (w.state === 'error' || w.state === 'lost') alerts.push({ sid: sid, worker: row.id, state: row.state, text: row.name });
        if (w.endedAt) log.push({ sid: sid, kind: 'worker', state: row.state, text: row.name, at: str(w.endedAt) });
      });
      arr(s.changes).filter(obj).forEach(function (c) { log.push({ sid: sid, kind: 'change', text: str(c.text), at: Number(s.lastActivityAt) || 0 }); });
      arr(s.done).filter(obj).forEach(function (d) { log.push({ sid: sid, kind: 'done', text: str(d.text), at: Number(s.lastActivityAt) || 0 }); });
    });
    return { floors: floors, ceo: { items: items, count: g.BriefShell.badge(vm, ui) }, alerts: alerts, people: people, log: log };
  }
  g.BriefOffice = { scene: scene };
})(typeof globalThis !== 'undefined' ? globalThis : this);
