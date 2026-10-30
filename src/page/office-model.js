/* omo-briefing office scene model: classic script (file:// safe). Pure: board view-model -> scene data.
 * Reads no clock, makes no request and builds no markup; office-view.js draws the scene. It also holds the office's floor
 * plan (desk cells, glass walls, props) and the walk map the boss cat walks on (plan Must have 12). */
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
  function r1(n) { return Math.round(n * 10) / 10; }
  function frozen(v) {
    if (typeof v === 'object' && v !== null) { Object.keys(v).forEach(function (k) { frozen(v[k]); }); Object.freeze(v); }
    return v;
  }

  // ---- the floor plan, in the floor tiles office-view.js draws (18 x 14) ------------------------------------------------
  // desk rooms: rows of 1.6 x 1 desks at the mockup's 2.7 x 1.9 pitch, filled from the back wall (as in the mockup) and
  // centred across, shrunk step by step until all fit, within AREA (clear of props). The lounge: two sofa seats, then a
  // grid of standing cats
  var SCALES = [1, .85, .72, .6, .5, .42, .36];
  var AREA = { plan: [6, 1.3, 10.9, 4.3], research: [12.3, 1.3, 16.8, 4.3], work: [.9, 8.1, 6.6, 13], review: [11.5, 8.1, 16.7, 12.9], lounge: [7.6, 9.5, 10.2, 11.8] };
  var SEATS = [[8.55, 8.6], [9.25, 8.6]];
  // glass: the glass walls between rooms, [x, y0, y1]; a wall's open ends are its doors. props: what stands on the floor,
  // [art, x0, y0, x1, y1] as the art draws it (x0, y0 is also its painter-order key): the boss's desk, the bookshelf, the
  // cat tower, the server rack, the coffee bar, the water cooler, the sofa and the six plants. The belt lies on the floor
  // and is crossed, as the cats' own walks across the hall cross it. spawn: the boss cat's first walk tile, the lounge door
  // (the middle of the lounge's edge to the hall, in front of the sofa)
  var MAP = frozen({
    glass: [[5.1, 1.2, 4.5], [11.5, .5, 4.5], [10.7, 7.5, 13.5], [7.1, 8.4, 13.5]],
    props: [['desk', 1.6, 1.7, 3.2, 2.7], ['shelf', 12.1, .02, 17.3, .44], ['tower', 3.7, .7, 4.7, 1.7], ['rack', 17, 7.6, 17.8, 8.4],
      ['coffee', 7.6, 12, 9.8, 12.7], ['cooler', 9.9, 11.4, 10.35, 11.85], ['sofa', 7.9, 8.2, 9.9, 9], ['plant', 5, .6, 5.5, 1.1],
      ['plant', 17, 2.9, 17.5, 3.4], ['plant', .6, 5.8, 1.1, 6.3], ['plant', 10.2, 7.6, 10.7, 8.1], ['plant', .8, 12.9, 1.3, 13.4], ['plant', 14.4, 12.9, 14.9, 13.4]],
    spawn: { x: 17, y: 15 }
  });
  // the walk map: the floor in walk tiles of half a floor tile (WT), so a glass wall fits between two rooms and the aisles
  // between desks stay open. A tile is blocked when a glass wall runs through it or a prop or desk covers its middle (or
  // comes within PAD of it); a lounge cat has no desk and blocks nothing
  var GX = 18, GY = 14, WT = .5, PAD = .1;
  function grid(area, n, fw, fd, gx, gy) {
    var w = area[2] - area[0], d = area[3] - area[1], s = 1, cols = 1, i;
    for (i = 0; i < SCALES.length; i++) {
      s = SCALES[i];
      cols = Math.max(1, Math.floor((w - fw * s) / ((fw + gx) * s) + 1e-6) + 1);
      if (cols * (Math.floor((d - fd * s) / ((fd + gy) * s) + 1e-6) + 1) >= n) break;
    }
    var used = Math.min(cols, n), px = (fw + gx) * s, py = (fd + gy) * s, ox = area[0] + Math.max(0, (w - (fw * s + (used - 1) * px)) / 2);
    var cells = [];
    for (i = 0; i < n; i++) cells.push({ x: r1(ox + (i % cols) * px), y: r1(area[1] + Math.floor(i / cols) * py), z: 0, s: s });
    return cells;
  }
  // every desk of a floor gets one cell in its room: {deskId: {x, y, z, s}} in floor tiles (office-view.js draws there)
  function layout(floor) {
    var cells = {}, rooms = floor && floor.rooms || {};
    ['plan', 'research', 'work', 'review', 'lounge'].forEach(function (room) {
      var ids = arr(rooms[room]), list;
      if (room === 'lounge') {
        list = SEATS.slice(0, ids.length).map(function (p) { return { x: p[0], y: p[1], z: 10, s: 1 }; });
        list = list.concat(grid(AREA.lounge, Math.max(0, ids.length - SEATS.length), .7, .5, .25, .3));
      } else list = grid(AREA[room], ids.length, 1.6, 1, 1.1, .9);
      ids.forEach(function (id, i) { cells[id] = list[i]; });
    });
    return cells;
  }
  function walkOf(floor) {
    var w = GX / WT, h = GY / WT, cells = layout(floor), off = {};
    function cover(x0, y0, x1, y1) {
      for (var y = Math.max(0, Math.floor((y0 - PAD) / WT)); y < h && (y + .5) * WT <= y1 + PAD; y++) {
        for (var x = Math.max(0, Math.floor((x0 - PAD) / WT)); x < w && (x + .5) * WT <= x1 + PAD; x++) {
          if ((y + .5) * WT >= y0 - PAD && (x + .5) * WT >= x0 - PAD) off[y * w + x] = 1;
        }
      }
      off[Math.floor((y0 + y1) / 2 / WT) * w + Math.floor((x0 + x1) / 2 / WT)] = 1;
    }
    MAP.glass.forEach(function (g) {
      for (var y = 0; y < h; y++) if ((y + .5) * WT >= g[1] && (y + .5) * WT <= g[2]) off[y * w + Math.floor(g[0] / WT)] = 1;
    });
    MAP.props.forEach(function (p) { cover(p[1], p[2], p[3], p[4]); });
    floor.desks.forEach(function (d) {
      var c = cells[d.id];
      if (d.room !== 'lounge') cover(c.x, c.y, c.x + 1.6 * c.s, c.y + c.s);
    });
    return { w: w, h: h, blocked: Object.keys(off).map(Number).sort(function (a, b) { return a - b; }) };
  }
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
    var floor = { sid: str(s.id), label: str(s.title), live: alive, dark: !alive && obj(s.folded), rooms: rooms, desks: desks, walk: null, spawn: { x: MAP.spawn.x, y: MAP.spawn.y } };
    floor.walk = walkOf(floor);
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
  g.BriefOffice = { scene: scene, layout: layout, map: MAP };
})(typeof globalThis !== 'undefined' ? globalThis : this);
