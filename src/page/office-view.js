/* omo-briefing office view (plan todo 5): classic script (file:// safe, no modules). Draws one floor of the scene
 * g.BriefOffice.scene(vm, ui, now) builds as an isometric SVG in the mockup's projection (origin 470,120, 34-unit tiles,
 * office-assets.js art), plus the HTML chrome around it: the floor picker, the floor card and the rail (대표님 할 일, 알림,
 * 사무실 사람들, 활동 로그). Model text only ever goes through textContent or a plain attribute value (set(), this file's one
 * attribute sink); the art strings are parsed through a tag and attribute allowlist, never handed to innerHTML.
 * A desk is the board's existing open action, data-sh="open" + data-sid (+ data-sub="wk" on a worker) that shell.js
 * dispatches; Enter or Space on a focused desk clicks it. Static on purpose: no timer, rAF or animation here (todo 6).
 * The todo-5 probe found SVG transform animations composited on their own layers, so actors stay in this SVG: each cat is
 * an outer <g transform> (position) around a free <g class="of-cat"> (todo 6's motion target).
 *   g.BriefOfficeView.render(root, vm, ui)   draws or patches the office inside root (#office); one floor at a time
 *   g.BriefOfficeView.layout(floor)           -> {deskId: {x, y, z, s}} the grid cell of every desk (pure) */
(function (g) {
  'use strict';
  var doc = g.document;
  // the SVG namespace is read off the page's own hidden icon sprite (src/render.mjs iconSprite, the first thing in <body>),
  // which the HTML parser created: the page then holds no URL-like string (test/render.test.mjs)
  var NS = null;
  function svgNs() { return NS || (NS = doc.getElementById('icon-sprite').namespaceURI); }
  var OX = 470, OY = 120, KX = 34 * 0.866, KY = 17, GX = 18, GY = 14, WALL = 110;
  // [key, name, colour, x0, y0, x1, y1]: the mockup's five rooms; the lounge takes the right of its work room, the coffee
  // corner, and gets the sofa. A room's name sits at its left corner, clear of the desks' names and bubbles
  var ROOMS = [
    ['ceo', '대표 결정석', '#ffcf5a', .4, .4, 4.8, 4.6],
    ['plan', '기획실', '#c792ea', 5.4, .4, 11.2, 4.6],
    ['research', '조사실', '#5ac8fa', 11.8, .4, 17.6, 4.6],
    ['work', '작업실', '#4fd1a5', .4, 7.4, 6.9, 13.6],
    ['lounge', '라운지', '#f4a261', 7.3, 7.4, 10.4, 13.6],
    ['review', '검토실', '#ff8fab', 11, 7.4, 17.6, 13.6]
  ];
  // where desk footprints (1.6 x 1 tiles) may stand, clear of props; the lounge seats cats on the sofa, then on the floor
  var AREA = { plan: [6, 1.3, 10.9, 4.3], research: [12.3, 1.3, 16.8, 4.3], work: [.9, 8.1, 6.6, 13], review: [11.5, 8.1, 16.7, 12.9], lounge: [7.6, 9.5, 10.2, 11.8] };
  var SEATS = [[8.55, 8.6], [9.25, 8.6]];
  var SCALES = [1, .85, .72, .6, .5, .42, .36];
  var SOFA = [7.9, 8.2], BOSS = [1.6, 1.7];
  var PLANTS = [[5, .6], [17, 2.9], [.6, 5.8], [10.2, 7.6], [.8, 12.9], [14.4, 12.9]];
  // props drawn where the mockup drew them: [art name, depth x, depth y, grid move]; the sofa moves from (.6, 3.2)
  var FURN = [['tower', 3.7, .7], ['rack', 17, 7.6], ['coffee', 7.6, 12], ['cooler', 9.9, 11.4], ['sofa', SOFA[0], SOFA[1], SOFA[0] - .6, SOFA[1] - 3.2]]
    .concat(PLANTS.map(function (p) { return ['plant', p[0], p[1], p[0] - 5, p[1] - .6]; }));
  var LEAD_WORD = { in_progress: '진행 중', needs_decision: '결정 대기', blocked: '막힘', recheck: '재확인', done: '끝남', done_no_evidence: '끝(근거 없음)' };
  var WORKER_WORD = { working: '진행 중', running: '진행 중', waiting: '대기', done: '끝', cancelled: '취소', error: '오류', lost: '끊김' };
  var TONE = { working: 'run', running: 'run', in_progress: 'run', waiting: 'wait', needs_decision: 'wait', recheck: 'wait', blocked: 'err', error: 'err', lost: 'err' };
  var ROOM_NAME = {};
  ROOMS.forEach(function (r) { ROOM_NAME[r[0]] = r[1]; });

  function has(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function r1(n) { return Math.round(n * 10) / 10; }
  function iso(x, y, z) { return [OX + (x - y) * KX, OY + (x + y) * KY - (z || 0)]; }
  function pts(list) { return list.map(function (p) { return r1(p[0]) + ',' + r1(p[1]); }).join(' '); }
  function quad(x0, y0, x1, y1) { return pts([iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)]); }
  function move(dx, dy) { return 'translate(' + r1((dx - dy) * KX) + ',' + r1((dx + dy) * KY) + ')'; }
  function word(map, k) { return has(map, k) ? map[k] : str(k); }

  // ---- DOM: one attribute sink, text through textContent -------------------------------------------------------------
  function set(n, k, v) { n.setAttribute(k, v); }
  function el(tag, a, parent, html) {
    var n = html ? doc.createElement(tag) : doc.createElementNS(svgNs(), tag);
    for (var k in a) if (has(a, k) && a[k] !== null && a[k] !== undefined) set(n, k, String(a[k]));
    if (parent) parent.appendChild(n);
    return n;
  }
  function h(tag, cls, parent, txt) {
    var n = el(tag, cls ? { class: cls } : null, parent, true);
    if (txt !== undefined) n.textContent = txt;
    return n;
  }

  // ---- art: office-assets.js strings -> nodes, through an allowlist (anything else throws) ---------------------------
  var TAGS = { symbol: 1, g: 1, path: 1, polygon: 1, circle: 1, ellipse: 1, rect: 1 };
  var ATTRS = /^(?:id|class|viewBox|d|points|fill|fill-rule|stroke|stroke-width|stroke-linecap|stroke-linejoin|opacity|cx|cy|r|rx|ry|x|y|width|height)$/;
  var trees = {};
  function tree(key, src) {
    if (has(trees, key)) return trees[key];
    var top = { kids: [] }, stack = [top], re = /<(\/?)([a-z]+)((?:\s+[a-zA-Z-]+="[^"<>]*")*)\s*(\/?)>/g, m, end = 0;
    var bad = function (why) { throw new Error('office art ' + key + ': ' + why); };
    while ((m = re.exec(src))) {
      if (src.slice(end, m.index).trim()) bad('text outside a tag');
      end = re.lastIndex;
      if (m[1]) { if (stack.length < 2 || stack.pop().tag !== m[2]) bad('unbalanced </' + m[2] + '>'); continue; }
      if (!has(TAGS, m[2])) bad('<' + m[2] + '> is not allowed');
      var node = { tag: m[2], attrs: [], kids: [] };
      m[3].replace(/([a-zA-Z-]+)="([^"]*)"/g, function (all, k, val) {
        if (!ATTRS.test(k)) bad(k + ' is not allowed');
        node.attrs.push([k, k === 'class' ? 'oa-' + val : val]);
        return '';
      });
      stack[stack.length - 1].kids.push(node);
      if (!m[4]) stack.push(node);
    }
    if (stack.length !== 1 || src.slice(end).trim()) bad('unbalanced');
    return (trees[key] = top.kids);
  }
  function build(node, parent) {
    var n = el(node.tag, null, parent);
    node.attrs.forEach(function (a) { set(n, a[0], a[1]); });
    node.kids.forEach(function (k) { build(k, n); });
    return n;
  }
  function art(name, parent, at) {
    var box = el('g', at ? { transform: at } : null, parent);
    tree(name, g.BriefOfficeArt.props[name]).forEach(function (n) { build(n, box); });
    return box;
  }

  // ---- layout: every desk of a floor gets one grid cell in its room (pure) ---------------------------------------------
  // desk rooms: rows of 1.6 x 1 desks at the mockup's 2.7 x 1.9 pitch, filled from the back wall (as in the mockup) and
  // centred across, shrunk step by step until all fit. The lounge: two sofa seats, then a grid of standing cats
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

  // ---- the static floor: sky, walls, windows, floor, rugs, glass, wall props, the belt --------------------------------
  function base(svg) {
    var seed = 7, rnd = function () { return (seed = (seed * 9301 + 49297) % 233280) / 233280; };
    var defs = el('defs', null, svg);
    ['cat', 'body'].forEach(function (k) { tree('sym-' + k, g.BriefOfficeArt.symbols[k]).forEach(function (n) { build(n, defs); }); });
    var glow = el('radialGradient', { id: 'of-glow', gradientUnits: 'userSpaceOnUse', cx: 230, cy: 600, r: 720 }, defs);
    el('stop', { offset: 0, 'stop-color': '#17204a' }, glow);
    el('stop', { offset: 1, 'stop-color': '#0b1020' }, glow);
    var b = el('g', { class: 'of-l-base' }, svg);
    el('rect', { x: -2000, y: -2000, width: 5000, height: 5000, fill: '#0b1020' }, b);
    el('rect', { x: -2000, y: -2000, width: 5000, height: 5000, fill: 'url(#of-glow)' }, b);
    for (var i = 0; i < 70; i++) el('circle', { cx: (30 + rnd() * 1000).toFixed(0), cy: (rnd() * 700).toFixed(0), r: (rnd() * 1.3 + .3).toFixed(1), fill: '#cdd8ff', opacity: (rnd() * .6 + .2).toFixed(2) }, b);
    el('polygon', { points: pts([iso(0, 0), iso(0, GY), iso(0, GY, WALL), iso(0, 0, WALL)]), fill: '#18213f', stroke: '#2a3866' }, b);
    el('polygon', { points: pts([iso(0, 0), iso(GX, 0), iso(GX, 0, WALL), iso(0, 0, WALL)]), fill: '#1f2a50', stroke: '#2a3866' }, b);
    el('polygon', { points: pts([iso(0, GY), iso(GX, GY), iso(GX, GY, -12), iso(0, GY, -12)]), fill: '#5e3b20' }, b);
    el('polygon', { points: pts([iso(GX, 0), iso(GX, GY), iso(GX, GY, -12), iso(GX, 0, -12)]), fill: '#4a2e18' }, b);
    el('polygon', { points: quad(0, 0, GX, GY), fill: '#8a5a35' }, b);
    for (i = 1; i < GX; i++) { var p = iso(i, 0), q = iso(i, GY); el('line', { x1: r1(p[0]), y1: r1(p[1]), x2: r1(q[0]), y2: r1(q[1]), stroke: '#7a4d2c' }, b); }
    var screens = {
      back: [iso(4, 0, 100), iso(10, 0, 100), iso(10, 0, 44), iso(4, 0, 44)],
      left: [iso(0, 4, 100), iso(0, 9, 100), iso(0, 9, 44), iso(0, 4, 44)]
    };
    for (var k in screens) el('polygon', { points: pts(screens[k]), fill: '#0c1430', stroke: '#3d6ef0', 'stroke-width': 1.5 }, b);
    [[iso(.6, 0, 96), iso(3.6, 0, 96), iso(3.6, 0, 50), iso(.6, 0, 50)], [iso(0, 12.8, 96), iso(0, 9.8, 96), iso(0, 9.8, 50), iso(0, 12.8, 50)]].forEach(function (w) {
      el('polygon', { points: pts(w), fill: '#070d24', stroke: '#7d8fc4', 'stroke-width': 3 }, b);
      for (var j = 0; j < 14; j++) {
        var u = rnd(), t = rnd();
        el('circle', { cx: r1(w[0][0] + (w[1][0] - w[0][0]) * u), cy: r1(w[0][1] + (w[1][1] - w[0][1]) * u + (w[3][1] - w[0][1]) * t), r: (rnd() * 1.2 + .4).toFixed(1), fill: '#dfe6ff' }, b);
      }
      el('line', { x1: r1((w[0][0] + w[1][0]) / 2), y1: r1((w[0][1] + w[1][1]) / 2), x2: r1((w[3][0] + w[2][0]) / 2), y2: r1((w[3][1] + w[2][1]) / 2), stroke: '#7d8fc4', 'stroke-width': 2.5 }, b);
    });
    var pl = iso(2.6, 0, 84);
    el('circle', { cx: r1(pl[0]), cy: r1(pl[1]), r: 8, fill: '#e9a35a' }, b);
    el('ellipse', { cx: r1(pl[0]), cy: r1(pl[1]), rx: 14, ry: 3.5, fill: 'none', stroke: '#f4c98a', 'stroke-width': 1.5, transform: 'rotate(-18 ' + r1(pl[0]) + ' ' + r1(pl[1]) + ')' }, b);
    el('polygon', { points: pts([iso(0, 1, 98), iso(0, 3.4, 98), iso(0, 3.4, 44), iso(0, 1, 44)]), fill: '#f2f2ee', stroke: '#c9d1e6', 'stroke-width': 2 }, b);
    var pa = iso(0, 3.4, 98), poster = el('g', { transform: 'translate(' + r1(pa[0] + 14) + ',' + r1(pa[1] + 4) + ') skewY(-30)' }, b);
    el('use', { href: '#cat' }, el('svg', { width: 42, height: 42, viewBox: '0 0 100 100' }, poster));
    el('text', { x: 21, y: 50, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: '#0d1a1a' }, poster).textContent = 'OmO';
    art('whiteboard', b);
    var ck = iso(14.7, 0, 96), clock = el('g', { transform: 'translate(' + r1(ck[0]) + ',' + r1(ck[1]) + ') skewY(30)' }, b);
    el('circle', { r: 9, fill: '#f2f2ee', stroke: '#3d4f86', 'stroke-width': 2 }, clock);
    el('line', { x1: 0, y1: 0, x2: 0, y2: -6, stroke: '#0d1a1a', 'stroke-width': 1.6 }, clock);
    el('line', { x1: 0, y1: 0, x2: 4, y2: 0, stroke: '#0d1a1a', 'stroke-width': 1.6 }, clock);
    art('shelf', b);
    ROOMS.forEach(function (r) { el('polygon', { points: quad(r[3], r[4], r[5], r[6]), fill: r[2], opacity: .32, stroke: r[2], 'stroke-opacity': .7 }, b); });
    [[5.1, 1.2, 4.5], [11.5, .5, 4.5], [10.7, 7.5, 13.5], [7.1, 8.4, 13.5]].forEach(function (s) {
      el('polygon', { points: pts([iso(s[0], s[1]), iso(s[0], s[2]), iso(s[0], s[2], 30), iso(s[0], s[1], 30)]), fill: '#a8dcff', 'fill-opacity': .08, stroke: '#a8dcff', 'stroke-opacity': .45 }, b);
    });
    tree('conveyor', g.BriefOfficeArt.props.conveyor).slice(0, 1).forEach(function (n) {
      var belt = el('g', null, b);
      n.kids.slice(0, 2).forEach(function (k) { build(k, belt); });
    });
    return b;
  }

  // ---- labels: measured once after insertion, then the first that fits wins (no two overlap) -------------------------
  function estimate(t, fs) {
    var w = 0;
    for (var i = 0; i < t.length; i++) w += t.charCodeAt(i) > 0x2e80 ? fs : fs * .62;
    return w;
  }
  function cut(t, fs, max) {
    if (estimate(t, fs) <= max) return t;
    var out = '';
    for (var i = 0; i < t.length && estimate(out + t[i] + '…', fs) <= max; i++) out += t[i];
    return out + '…';
  }
  function pill(list, parent, x, y, label, o) {
    var box = el('g', { class: o.cls, transform: 'translate(' + r1(x) + ',' + r1(y) + ')' }, parent);
    if (o.act) { set(box, 'data-sh', 'open'); set(box, 'data-sid', o.act[0]); if (o.act[1]) set(box, 'data-sub', o.act[1]); }
    if (o.key) set(box, 'data-for', o.key);
    var rect = el('rect', { y: -o.h / 2 - (o.tail ? 2 : 0), height: o.h, rx: o.rx, fill: o.fill, stroke: o.stroke, 'stroke-width': o.tail ? 1.5 : 1 }, box);
    var tail = o.tail ? el('path', { d: 'M-5,' + r1(o.h / 2 - 2) + ' L0,' + r1(o.h / 2 + 4) + ' L5,' + r1(o.h / 2 - 2) + ' Z', fill: o.stroke }, box) : null;
    var t = el('text', { 'text-anchor': 'middle', y: r1(o.fs * .36 - (o.tail ? 2 : 0)), 'font-size': o.fs, 'font-weight': o.fw || null, fill: o.color }, box);
    t.textContent = label;
    list.push({ g: box, parent: parent, rect: rect, tail: tail, text: t, x: x, y: y, label: label, o: o });
  }
  // [dx, dy] tries in order; [0, 4] still ends the tail above the head; sideways tries need a bubble wide enough to keep
  // its tail on the cat
  var BUBBLE_AT = [[0, 0], [0, 4], [0, -24], [-36, 0], [36, 0], [-36, -24], [36, -24], [-54, 0], [54, 0], [-54, -24], [54, -24]];
  // a desk name slides along the desk's front edge (at most to its corners, x the desk scale), so a wide name or font
  // still finds its own desk
  var TAG_AT = [[0, 0], [12, 7], [-12, -7], [24, 14], [-24, -14]];
  var BELT_AT = [[0, 0], [29, 17], [-29, -17], [59, 34], [-59, -34], [0, 50], [29, 67], [-29, 33], [59, 84], [-59, 16]];
  // the stage's overlays (title, floor picker, floor card) as boxes in scene units, read from the live layout
  function shade(v) {
    var m = typeof v.svg.getScreenCTM === 'function' ? v.svg.getScreenCTM() : null;
    if (!m) return [];
    m = m.inverse();
    return [v.head, v.picker, v.card].map(function (n) {
      var r = n.getBoundingClientRect();
      return { x0: m.a * r.left + m.c * r.top + m.e, y0: m.b * r.left + m.d * r.top + m.f, x1: m.a * r.right + m.c * r.bottom + m.e, y1: m.b * r.right + m.d * r.bottom + m.f };
    });
  }
  // labels stay off the overlays and off each other; a stage resize settles the same labels again (mount), so a label
  // dropped at one size can come back at another and the widths are measured once
  function settle(list, shadeBoxes) {
    var placed = shadeBoxes.slice();
    list.forEach(function (p) {
      if (p.w) return;
      var w = (typeof p.text.getComputedTextLength === 'function' ? p.text.getComputedTextLength() : 0) || estimate(p.label, p.o.fs);
      p.w = w + 14;
    });
    list.forEach(function (p) {
      // a label that would cover another tries its other places first: a bubble higher or to a side (its tail stays on
      // the cat), a belt label along the belt or under it
      var tries = p.o.alts || [[0, 0]], pick = null, b = null;
      for (var i = 0; i < tries.length && pick === null; i++) {
        var dx = tries[i][0], dy = tries[i][1];
        if (p.tail && Math.abs(dx) > p.w / 2 - 12) continue;
        var c = { x0: p.x + dx - p.w / 2, x1: p.x + dx + p.w / 2, y0: p.y + dy - p.o.h / 2 - 3, y1: p.y + dy + p.o.h / 2 + (p.o.tail ? 4 : 1) };
        if (p.o.keep || !placed.some(function (q) { return c.x0 < q.x1 && q.x0 < c.x1 && c.y0 < q.y1 && q.y0 < c.y1; })) { pick = tries[i]; b = c; }
      }
      if (pick === null) { if (p.g.parentNode) p.g.parentNode.removeChild(p.g); return; }
      if (!p.g.parentNode) p.parent.appendChild(p.g);
      set(p.g, 'transform', 'translate(' + r1(p.x + pick[0]) + ',' + r1(p.y + pick[1]) + ')');
      if (p.tail) set(p.tail, 'transform', 'translate(' + -pick[0] + ',0)');
      placed.push(b);
      set(p.rect, 'x', r1(-p.w / 2));
      set(p.rect, 'width', r1(p.w));
    });
  }

  // ---- one floor -----------------------------------------------------------------------------------------------------
  function cat(parent, cx, by, size) {
    var hh = size * 1.42, pos = el('g', { transform: 'translate(' + r1(cx - size / 2) + ',' + r1(by - hh) + ')' }, parent);
    var c = el('g', { class: 'of-cat' }, pos);
    el('use', { href: '#body' }, el('svg', { y: r1(size * .82), width: r1(size), height: r1(size * .6), viewBox: '0 0 100 60', overflow: 'visible' }, c));
    el('use', { href: '#cat' }, el('svg', { width: r1(size), height: r1(size), viewBox: '0 0 100 100', overflow: 'visible' }, c));
    return pos;
  }
  function deskLabel(d, people) {
    if (d.kind === 'lead') return '리더';
    var p = people[d.id];
    return d.agent.replace(/^omo-native-/, '') || (p && p.name) || '작업자';
  }
  function deskName(d, p, label) {
    var state = d.kind === 'lead' ? word(LEAD_WORD, d.state) : word(WORKER_WORD, d.state);
    return [label, ROOM_NAME[d.room] || '', state, p && p.name && p.name !== label ? p.name : ''].filter(Boolean).join(' · ');
  }
  function decisionsOf(sc, sid) { return arr(sc.ceo && sc.ceo.items).filter(function (it) { return it.sid === sid && it.sub === 'dec'; }).length; }

  function drawFloor(v, f) {
    var sc = v.scene, pub = v.ui.publicMode === true, people = {}, labels = [];
    arr(sc.people).forEach(function (p) { if (f && p.sid === f.sid) people[p.id] = p; });
    v.depth.textContent = '';
    v.top.textContent = '';
    v.dyn.textContent = '';
    set(v.svg, 'aria-label', f ? floorNo(v, f) + '층 · ' + (f.label || '(제목 없음)') : '빈 사무실');
    if (f && f.dark) el('rect', { x: -2000, y: -2000, width: 5000, height: 5000, fill: '#05070f', opacity: .5 }, v.top);
    // labels in priority order: rooms and the boss's count always, then desk names (alerts first), bubbles, the belt
    ROOMS.forEach(function (r) {
      var n = f ? arr(f.rooms && f.rooms[r[0]]).length : 0, p = iso(r[3] + .5, r[6] - .3);
      pill(labels, v.top, p[0], p[1] - 6, r[1] + (n ? ' ' + n : ''), { cls: 'of-room', h: 20, rx: 5, fs: 13, fw: 700, fill: '#141c36', stroke: r[2], color: r[2], keep: 1 });
    });
    var ceoN = sc.ceo ? sc.ceo.count : 0;
    if (ceoN > 0) {
      var bc = iso(BOSS[0] + .8, BOSS[1] + .1, 32);
      pill(labels, v.top, bc[0], bc[1] - 18, '할 일 ' + ceoN + '건', { cls: 'of-bub', h: 23, rx: 8, fs: 12.5, fill: '#0f1834', stroke: '#ffcf5a', color: '#e6ebf5', tail: 1, keep: 1 });
    }
    // the belt: one box per plan wave (done / current / to come, the mockup's three box colours) and its label
    var conv = f && f.conveyor, waves = conv ? arr(conv.waves) : [];
    var boxes = tree('conveyor', g.BriefOfficeArt.props.conveyor)[0].kids.slice(2, 5);
    var step = waves.length > 1 ? Math.min(3, 15.2 / (waves.length - 1)) : 3, belt = [];
    waves.forEach(function (w, i) {
      var tone = i < conv.current || conv.current < 0 ? 0 : i === conv.current ? 1 : 2, x = 1.8 + i * step;
      var b = el('g', { transform: move(i * step - [0, 3, 6][tone], 0) }, v.dyn);
      build(boxes[tone], b);
      var p = iso(x + step / 2, 5.6, 8);
      belt.push([p[0], p[1] - 26, (w.n || i + 1) + '단계' + (tone === 0 ? ' ✓' : tone === 1 ? ' ●' : ''),
        { cls: 'of-wave', alts: BELT_AT, rank: tone === 1 ? 2 : tone === 0 ? 1 : 0, h: 18, rx: 9, fs: 11.5, fill: '#0e1528', stroke: ['#4fd1a5', '#7aa2ff', '#8b97b3'][tone], color: ['#4fd1a5', '#7aa2ff', '#8b97b3'][tone] }]);
    });
    // the back-wall screen: the plan's progress, when this floor has a plan
    if (conv) {
      var cur = conv.current >= 0 ? waves[conv.current] : null, c0 = iso(4, 0, 100);
      [cur ? '계획 ' + (cur.n || conv.current + 1) + '단계 진행 중' : '계획 단계 모두 끝', cur ? '상자 ' + cur.done + '/' + cur.total + ' 끝' : '상자 ' + waves.length + '단계',
        cur ? cut(str(cur.label), 11, 150) : ''].forEach(function (line, i) {
        if (line) el('text', { transform: 'translate(' + r1(c0[0] + 10) + ',' + r1(c0[1] + 20 + i * 15) + ') skewY(30)', 'font-size': 11, fill: i ? '#8fb0ff' : '#ffcf5a' }, v.dyn).textContent = line;
      });
    }
    // depth-sorted desks, cats and props (the mockup's painter order by x + y)
    var items = FURN.map(function (fu) { return { x: fu[1], y: fu[2], draw: function (p) { art(fu[0], p, fu.length > 3 ? move(fu[3], fu[4]) : null); } }; });
    items.push({ x: BOSS[0], y: BOSS[1], draw: function (p) {
      var at = el('g', { class: 'of-boss', transform: move(BOSS[0], BOSS[1]) }, p);
      art('desk', at);
      lit(art('monitor', at), ceoN > 0);
    } });
    var cells = f ? layout(f) : {};
    var desks = f ? arr(f.desks).filter(function (d) { return has(cells, d.id); }) : [];
    var tags = [], bubbles = [];
    desks.forEach(function (d) {
      var c = cells[d.id];
      items.push({ x: c.x, y: c.y, draw: function (p) { unit(v, f, d, c, p, people, tags, bubbles, pub); } });
    });
    items.sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
    items.forEach(function (it) { it.draw(v.depth); });
    var order = function (list) { return list.sort(function (a, b) { return b.rank - a.rank; }); };
    order(tags).forEach(function (t) { pill(labels, v.top, t.x, t.y, t.label, t.o); });
    if (!pub) order(bubbles).forEach(function (t) { pill(labels, v.top, t.x, t.y, t.label, t.o); });
    belt.sort(function (a, b) { return b[3].rank - a[3].rank; }).forEach(function (b) { pill(labels, v.top, b[0], b[1], b[2], b[3]); });
    v.labels = labels;
    settle(labels, shade(v));
  }
  // a lit monitor: the mockup's on-screen colour on the monitor's one polygon
  function lit(mon, on) {
    var screen = on && mon.querySelector('polygon');
    if (screen) set(screen, 'fill', '#5ac8fa');
  }

  function unit(v, f, d, c, parent, people, tags, bubbles, pub) {
    var p = people[d.id], label = deskLabel(d, people), s = c.s, lounge = d.room === 'lounge';
    var alert = d.state === 'error' || d.state === 'lost', act = [f.sid, d.kind === 'worker' ? 'wk' : ''];
    var u = el('g', { class: 'of-desk is-' + (d.pose || 'idle'), 'data-desk': d.id, 'data-sh': 'open', 'data-sid': f.sid, 'data-sub': act[1] || null,
      role: 'button', tabindex: 0, 'aria-label': deskName(d, p, label) + ' · 대화 열기' }, parent);
    var o = iso(c.x, c.y, c.z * s), size = (lounge ? 34 : 46) * s, cx, by, top;
    if (lounge) {
      cx = o[0]; by = o[1];
      el('rect', { class: 'of-hit', x: r1(cx - size / 2 - 3), y: r1(by - size * 1.42 - 3), width: r1(size + 6), height: r1(size * 1.42 + 6), rx: 6, fill: 'transparent' }, u);
      cat(u, cx, by, size);
      top = by - size * 1.42;
    } else {
      var at = el('g', { transform: 'translate(' + r1(o[0]) + ',' + r1(o[1]) + ') scale(' + s + ') translate(' + -OX + ',' + -OY + ')' }, u);
      var cc = iso(.65, .05, 14);
      el('rect', { class: 'of-hit', x: 438, y: r1(cc[1] + 11 - 46 * 1.42 - 3), width: 82, height: r1(164.2 - (cc[1] + 11 - 46 * 1.42 - 3) + 2), rx: 8, fill: 'transparent' }, at);
      cat(at, cc[0], cc[1] + 11, 46);
      art('desk', at);
      lit(art('monitor', at), d.lamp === 'on');
      if (d.lamp === 'alert') { var a = iso(.2, .8, 14); el('circle', { cx: r1(a[0]), cy: r1(a[1] - 4), r: 4, fill: alert ? '#ff5a7a' : '#ffcf5a' }, at); }
      cx = o[0] + (cc[0] - OX) * s; by = o[1] + (cc[1] + 11 - OY) * s; top = by - 46 * 1.42 * s;
      var n = iso(c.x + .8 * s, c.y + s, 0);
      tags.push({ x: n[0], y: n[1] + 13 * s, label: label + (alert ? ' · ' + word(WORKER_WORD, d.state) : ''), rank: alert ? 3 : d.kind === 'lead' ? 2 : 1,
        o: { cls: 'of-tag', act: act, key: d.id, alts: TAG_AT.map(function (a) { return [r1(a[0] * s), r1(a[1] * s)]; }), h: 19, rx: 8, fs: 12.5, fill: '#0e1528', stroke: alert ? '#ff5a7a' : '#34446e', color: '#e6ebf5' } });
    }
    if (d.pose === 'rest') el('text', { class: 'of-z', x: r1(cx + size * .3), y: r1(top + 4), 'font-size': 13, 'font-weight': 700, fill: '#8fb0ff' }, u).textContent = 'z';
    if (!pub && d.bubble) {
      bubbles.push({ x: cx, y: top - 20 * s, label: cut(d.bubble, 12.5, 176), rank: d.state === 'working' ? 2 : 1,
        o: { cls: 'of-bub', act: act, key: d.id, alts: BUBBLE_AT, h: 23, rx: 8, fs: 12.5, fill: '#0f1834', stroke: alert ? '#ff5a7a' : d.state === 'waiting' ? '#ffcf5a' : '#3d6ef0', color: '#e6ebf5', tail: 1 } });
    }
    return u;
  }

  // ---- HTML chrome -----------------------------------------------------------------------------------------------------
  function floorNo(v, f) { return v.scene.floors.length - v.scene.floors.indexOf(f); }
  function floorWord(f) { return f.live ? '실행 중' : f.dark ? '불 꺼짐' : '쉬는 중'; }
  // a part redrawn under the owner's focus gives it back: to the control with the same attr value, else the same position
  function keepFocus(container, attr, fn) {
    var a = doc.activeElement, inside = !!(a && a !== container && container.contains(a) && a.getAttribute), key = null, at = -1;
    var controls = function () { return Array.prototype.slice.call(container.querySelectorAll('button,[tabindex]')); };
    if (inside) { key = attr ? a.getAttribute(attr) : null; at = controls().indexOf(a); }
    fn();
    if (!inside) return;
    var all = controls(), to = null;
    for (var i = 0; key !== null && i < all.length && !to; i++) if (all[i].getAttribute(attr) === key) to = all[i];
    to = to || all[Math.min(at, all.length - 1)];
    if (to && to.focus) to.focus({ preventScroll: true });
  }
  function drawPicker(v, f) {
    var sc = v.scene;
    keepFocus(v.picker, 'data-floor', function () {
      v.picker.textContent = '';
      h('h3', '', v.picker, '층 고르기 · 대화 1개 = 1층');
      if (!sc.floors.length) { h('p', 'of-empty', v.picker, '아직 층이 없어요'); return; }
      sc.floors.forEach(function (fl) {
        var n = floorNo(v, fl), dec = decisionsOf(sc, fl.sid), title = fl.label || '(제목 없음)';
        var b = el('button', { type: 'button', class: 'of-fl', 'data-floor': fl.sid, 'aria-pressed': fl === f ? 'true' : 'false',
          'aria-label': n + '층 · ' + title + ' · ' + floorWord(fl) + (dec ? ' · 결정 ' + dec + '건' : '') }, v.picker, true);
        h('span', 'of-no', b, n + 'F');
        h('span', 'of-ft', b, title);
        if (dec) h('span', 'of-n', b, String(dec));
        h('span', 'of-fs', b, floorWord(fl));
      });
    });
  }
  function drawCard(v, f) {
    keepFocus(v.card, null, function () {
      v.card.textContent = '';
      if (!f) { h('p', 'of-empty', v.card, '대화를 시작하면 그 대화가 한 층이 돼요'); return; }
      var desks = arr(f.desks), working = desks.filter(function (d) { return d.state === 'working'; }).length, dec = decisionsOf(v.scene, f.sid);
      h('span', 'of-cn', v.card, floorNo(v, f) + 'F');
      var t = h('div', 'of-ct', v.card);
      h('b', '', t, f.label || '(제목 없음)');
      h('small', '', t, [floorWord(f), '작업자 ' + (desks.length - 1) + '명', working ? '일하는 중 ' + working : '', dec ? '결정 ' + dec + '건 대기' : ''].filter(Boolean).join(' · '));
      el('button', { type: 'button', class: 'of-open', 'data-sh': 'open', 'data-sid': f.sid }, v.card, true).textContent = '대화 열기';
    });
  }
  function box(parent, title, count) {
    var s = h('section', 'of-box', parent), t = h('h3', '', s, title);
    if (count !== null) h('small', '', t, count);
    return s;
  }
  function item(list, act, title, meta, tone, state) {
    var b = el('button', { type: 'button', class: 'of-it', 'data-sh': 'open', 'data-sid': act[0], 'data-sub': act[1] || null }, h('li', '', list), true);
    h('span', 'of-it-t', b, title);
    if (state) h('span', 'of-st is-' + tone, b, state);
    if (meta) h('span', 'of-it-m', b, meta);
  }
  function label(sc, sid) {
    for (var i = 0; i < sc.floors.length; i++) if (sc.floors[i].sid === sid) return sc.floors[i].label || '(제목 없음)';
    return '';
  }
  function clock(at) {
    var ms = typeof at === 'number' ? at : Date.parse(str(at));
    if (!isFinite(ms) || ms <= 0) return '';
    var d = new Date(ms), two = function (n) { return (n < 10 ? '0' : '') + n; };
    return two(d.getHours()) + ':' + two(d.getMinutes());
  }
  function drawRail(v, f) {
    var sc = v.scene, pub = v.ui.publicMode === true, ceo = sc.ceo || { items: [], count: 0 };
    keepFocus(v.rail, null, function () {
      v.rail.textContent = '';
      var todo = box(v.rail, '대표님 할 일', ceo.count + '건'), items = arr(ceo.items);
      if (!items.length) h('p', 'of-empty', todo, '지금 대표님을 기다리는 일은 없어요');
      else {
        var list = h('ul', 'of-list', todo);
        items.slice(0, 6).forEach(function (it) { item(list, [it.sid, it.sub], it.text || it.kind, [it.kind, label(sc, it.sid)].filter(Boolean).join(' · ')); });
        if (items.length > 6) h('p', 'of-empty', todo, '나머지 ' + (items.length - 6) + '건은 수신함에 있어요');
      }
      var alerts = arr(sc.alerts), al = box(v.rail, '알림', alerts.length + '건');
      if (!alerts.length) h('p', 'of-empty', al, '오류나 끊긴 작업자가 없어요');
      else {
        var list2 = h('ul', 'of-list', al);
        alerts.forEach(function (a) { item(list2, [a.sid, 'wk'], a.text || '작업자', label(sc, a.sid), 'err', word(WORKER_WORD, a.state)); });
      }
      var desks = f ? arr(f.desks) : [], people = {};
      arr(sc.people).forEach(function (p) { if (f && p.sid === f.sid) people[p.id] = p; });
      var working = desks.filter(function (d) { return d.state === 'working'; }).length;
      var pb = box(v.rail, '사무실 사람들', f ? desks.length + '명' + (working ? ' · 일하는 중 ' + working : '') : null);
      if (!desks.length) h('p', 'of-empty', pb, '이 층에는 아직 아무도 없어요');
      else {
        var list3 = h('ul', 'of-list', pb);
        desks.forEach(function (d) {
          var p = people[d.id], name = deskLabel(d, people), lead = d.kind === 'lead';
          var meta = [lead ? '' : p && p.name !== name ? p.name : '', pub ? '' : d.bubble].filter(Boolean).join(' · ');
          item(list3, [f.sid, lead ? '' : 'wk'], name + ' · ' + (ROOM_NAME[d.room] || ''), meta, TONE[d.state] || 'rest', lead ? word(LEAD_WORD, d.state) : word(WORKER_WORD, d.state));
        });
      }
      var log = f ? arr(sc.log).filter(function (l) { return l.sid === f.sid; }) : [];
      var lb = box(v.rail, '활동 로그', null);
      if (!log.length) h('p', 'of-empty', lb, '이 층의 기록이 아직 없어요');
      else {
        var ms = function (l) { var t = typeof l.at === 'number' ? l.at : Date.parse(str(l.at)); return isFinite(t) ? t : 0; };
        var list4 = h('ol', 'of-log', lb);
        log.map(function (l, i) { return { l: l, i: i }; }).sort(function (a, b) { return (ms(b.l) - ms(a.l)) || (a.i - b.i); }).slice(0, 8).forEach(function (x) {
          var li = h('li', '', list4), t = clock(x.l.at);
          if (t) h('b', '', li, t);
          h('span', '', li, x.l.kind === 'worker' ? (x.l.text || '작업자') + ' · ' + word(WORKER_WORD, x.l.state) : x.l.text);
        });
      }
    });
  }

  // ---- mount and draw --------------------------------------------------------------------------------------------------
  function mount(root) {
    root.textContent = '';
    var v = { root: root, sid: null, keys: {} };
    var body = h('div', 'of-body', root), stage = h('div', 'of-stage', body);
    v.svg = el('svg', { class: 'of-scene', viewBox: '30 0 1000 700', preserveAspectRatio: 'xMidYMid meet', role: 'group' }, stage);
    set(base(v.svg), 'aria-hidden', 'true');
    v.dyn = el('g', { class: 'of-l-belt', 'aria-hidden': 'true' }, v.svg);
    v.depth = el('g', { class: 'of-l-depth' }, v.svg);
    v.top = el('g', { class: 'of-l-top', 'aria-hidden': 'true' }, v.svg);
    v.head = h('h2', 'of-head', stage, '사무실');
    v.picker = el('nav', { class: 'of-floors', 'aria-label': '층 고르기' }, stage, true);
    v.card = h('div', 'of-card', stage);
    v.rail = h('div', 'of-rail', body);
    // the overlays keep their CSS size while the scene scales, so a new stage size settles the labels again
    if (typeof g.ResizeObserver === 'function') new g.ResizeObserver(function () { if (v.labels) settle(v.labels, shade(v)); }).observe(stage);
    root.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-floor]') : null;
      if (!t || !root.contains(t)) return;
      v.sid = t.getAttribute('data-floor');
      draw(v);
    });
    root.addEventListener('keydown', function (ev) {
      var t = ev.target;
      if ((ev.key !== 'Enter' && ev.key !== ' ') || !t || t.namespaceURI !== svgNs() || !t.getAttribute || t.getAttribute('data-sh') !== 'open') return;
      ev.preventDefault();
      if (typeof g.MouseEvent === 'function') t.dispatchEvent(new g.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    return v;
  }
  function part(v, name, key, fn) {
    if (v.keys[name] === key) return;
    v.keys[name] = key;
    fn();
  }
  function draw(v) {
    var sc = v.scene, f = null;
    for (var i = 0; i < sc.floors.length; i++) if (sc.floors[i].sid === v.sid) f = sc.floors[i];
    f = f || sc.floors[0] || null;
    v.sid = f ? f.sid : null;
    var floors = JSON.stringify(sc.floors.map(function (x) { return [x.sid, x.label, x.live, x.dark, decisionsOf(sc, x.sid)]; }));
    var pub = v.ui.publicMode === true;
    part(v, 'picker', floors + '|' + v.sid, function () { drawPicker(v, f); });
    part(v, 'card', JSON.stringify([f, floors]), function () { drawCard(v, f); });
    part(v, 'floor', JSON.stringify([f, sc.people.filter(function (p) { return f && p.sid === f.sid; }), sc.ceo && sc.ceo.count, pub, floors]), function () {
      keepFocus(v.depth, 'data-desk', function () { drawFloor(v, f); });
    });
    part(v, 'rail', JSON.stringify([f, sc.ceo, sc.alerts, sc.people, sc.log, pub, floors]), function () { drawRail(v, f); });
  }
  var views = new WeakMap();
  // a missing region or module throws here, so page.js shows its fatal notice instead of an empty office
  function render(root, vm, ui) {
    var v = views.get(root);
    if (!v) { v = mount(root); views.set(root, v); }
    v.ui = ui || {};
    v.scene = g.BriefOffice.scene(vm || {}, v.ui, vm && vm.generatedAt);
    draw(v);
  }
  g.BriefOfficeView = { render: render, layout: layout };
})(typeof globalThis !== 'undefined' ? globalThis : this);
