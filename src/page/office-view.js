/* omo-briefing office view (plan todos 5-6): classic script (file:// safe, no modules). Draws one floor of the scene
 * g.BriefOffice.scene(vm, ui, now) builds as an isometric SVG in the mockup's projection (origin 470,120, 34-unit tiles,
 * office-assets.js art), plus the HTML chrome around it: the toolbar (title, 공개 모드 switch), the floor picker, the
 * floor card and the rail (대표님 할 일, 알림, 사무실 사람들, 활동 로그). Model text only ever goes through textContent or
 * a plain attribute value (set(), this file's one attribute sink); the art strings are parsed through a tag and attribute
 * allowlist, never handed to innerHTML.
 * Every render patches what is already drawn. Desks, cats, labels, belt boxes, picker rows and rail rows are keyed (desk
 * id, label key, wave, floor sid, row key): a node stays while its key stays, a changed value is written in place, and
 * only a key that appears or goes away adds or removes nodes. Another floor is drawn anew.
 * Motion is the browser's: CSS keyframes in office.css (typing, lounge strolls, blinking, the belt, z) and one
 * el.animate() per desk or cat that moved (a cat whose room changed walks through the hall). No timer, rAF or polling
 * here. A hidden tab holds it all (the root's data-motion="paused" for the CSS, pause() for the walks; page.js's
 * visibilitychange hook calls visibility()); under reduced motion office.css stops the keyframes and no walk starts, so
 * a cat is simply in its new room, and turning reduced motion on ends the walks under way (the query's change listener
 * calls visibility() too). The todo-5 probe found SVG transform animations composited on their own layers, so the
 * actors stay in this SVG.
 * A desk is the board's existing open action, data-sh="open" + data-sid (+ data-sub="wk" on a worker) that shell.js
 * dispatches; Enter or Space on a focused desk clicks it. The 공개 모드 switch is page.js's data-act="office-public"
 * (ui.publicMode, off by default): it hides the bubbles, the conversation's tab label and its cwd.
 *   g.BriefOfficeView.render(root, vm, ui)   draws or patches the office inside root (#office); one floor at a time
 *   g.BriefOfficeView.layout(floor)           -> {deskId: {x, y, z, s}} the grid cell of every desk (pure)
 *   g.BriefOfficeView.visibility()            holds or resumes the shown office's motion with document.hidden and ends
 *                                             its walks under reduced motion
 *   g.__office                                {sid, desks: {id: node}, cats: {id: node}}: the live desk and cat nodes */
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
  // motion: CAT is a cat's drawn size (its pos transform scales it); a walk between rooms crosses the hall row HALL (tiles,
  // between the belt and the lower rooms) at PACE px/s and lasts WALK[0]..WALK[1] ms
  var CALM = '(prefers-reduced-motion: reduce)', CAT = 46, HALL = 7, PACE = 140, WALK = [400, 3000];
  // the blink's closed eyes in the traced head's 0 0 100 100 box: a face-coloured lid over each eye ring and a lash line
  var LID = 'M18.8,60.1a10.4,11.3 0 1,0 20.8,0a10.4,11.3 0 1,0 -20.8,0ZM60.4,60.1a10.4,11.3 0 1,0 20.8,0a10.4,11.3 0 1,0 -20.8,0Z';
  var LASH = 'M20.6,59.4Q29.2,66.4 37.8,59.4M62.2,59.4Q70.8,66.4 79.4,59.4';

  function has(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function r1(n) { return Math.round(n * 10) / 10; }
  function r3(n) { return Math.round(n * 1000) / 1000; }
  function iso(x, y, z) { return [OX + (x - y) * KX, OY + (x + y) * KY - (z || 0)]; }
  function pts(list) { return list.map(function (p) { return r1(p[0]) + ',' + r1(p[1]); }).join(' '); }
  function quad(x0, y0, x1, y1) { return pts([iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)]); }
  function move(dx, dy) { return 'translate(' + r1((dx - dy) * KX) + ',' + r1((dx + dy) * KY) + ')'; }
  function word(map, k) { return has(map, k) ? map[k] : str(k); }

  // ---- DOM: one attribute sink, text through textContent; a patch writes only what changed --------------------------
  function set(n, k, v) { n.setAttribute(k, v); }
  function put(n, k, v) { if (n.getAttribute(k) !== String(v)) set(n, k, String(v)); }
  function txt(n, t) { if (n.textContent !== t) n.textContent = t; }
  function drop(n) { if (n && n.parentNode) n.parentNode.removeChild(n); }
  function el(tag, a, parent, html) {
    var n = html ? doc.createElement(tag) : doc.createElementNS(svgNs(), tag);
    for (var k in a) if (has(a, k) && a[k] !== null && a[k] !== undefined) set(n, k, String(a[k]));
    if (parent) parent.appendChild(n);
    return n;
  }
  function h(tag, cls, parent, text) {
    var n = el(tag, cls ? { class: cls } : null, parent, true);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  // parent's children become wanted, in that order, with the fewest moves: the longest run already in order stays (a
  // moved node restarts its CSS animations and drops focus, so a node that kept its place is never touched)
  function order(parent, wanted) {
    var kids = Array.prototype.slice.call(parent.children), at = wanted.map(function (n) { return kids.indexOf(n); });
    var len = [], prev = [], best = -1, keep = {}, i, j;
    for (i = 0; i < at.length; i++) {
      len[i] = at[i] < 0 ? 0 : 1;
      prev[i] = -1;
      for (j = 0; j < i && len[i]; j++) if (len[j] && at[j] < at[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
      if (len[i] && (best < 0 || len[i] > len[best])) best = i;
    }
    for (i = best; i >= 0; i = prev[i]) keep[i] = true;
    for (i = wanted.length - 1; i >= 0; i--) if (!keep[i]) parent.insertBefore(wanted[i], wanted[i + 1] || null);
  }
  // keyed rows: a row whose key and content stay keeps its node, a changed row is drawn again in its place, a key that
  // went away is removed; make(it) draws one row
  function rows(v, name, box, items, make) {
    var old = v.rows[name] || {}, next = {};
    var nodes = items.map(function (it) {
      var sig = JSON.stringify(it), r = has(old, it.key) ? old[it.key] : null;
      if (r && r.sig !== sig) { drop(r.n); r = null; }
      next[it.key] = r = r || { n: make(it), sig: sig };
      return r.n;
    });
    for (var k in old) if (!has(next, k)) drop(old[k].n);
    v.rows[name] = next;
    order(box, nodes);
  }
  // row keys from content: the same content twice gets #1, #2
  function keyed(list, keyOf) {
    var seen = {};
    return list.map(function (it) { var k = keyOf(it); seen[k] = (seen[k] || 0) + 1; it.key = k + '#' + seen[k]; return it; });
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

  // ---- labels: measured once per text after insertion, then the first place that fits wins (no two overlap) ----------
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
  // one label per key, kept from patch to patch: a new text is measured again, a new look is a new label
  function pill(v, list, key, x, y, label, o) {
    var look = JSON.stringify([o.cls, o.h, o.rx, o.fs, o.fw, o.fill, o.stroke, o.color, o.tail, o.act, o.key]), p = v.pills[key];
    if (p && p.look !== look) { drop(p.g); p = null; }
    if (!p) {
      var box = el('g', { class: o.cls }, v.top);
      if (o.act) { set(box, 'data-sh', 'open'); set(box, 'data-sid', o.act[0]); if (o.act[1]) set(box, 'data-sub', o.act[1]); }
      if (o.key) set(box, 'data-for', o.key);
      p = v.pills[key] = { g: box, parent: v.top, look: look, label: null,
        rect: el('rect', { y: -o.h / 2 - (o.tail ? 2 : 0), height: o.h, rx: o.rx, fill: o.fill, stroke: o.stroke, 'stroke-width': o.tail ? 1.5 : 1 }, box),
        tail: o.tail ? el('path', { d: 'M-5,' + r1(o.h / 2 - 2) + ' L0,' + r1(o.h / 2 + 4) + ' L5,' + r1(o.h / 2 - 2) + ' Z', fill: o.stroke }, box) : null,
        text: el('text', { 'text-anchor': 'middle', y: r1(o.fs * .36 - (o.tail ? 2 : 0)), 'font-size': o.fs, 'font-weight': o.fw || null, fill: o.color }, box) };
    }
    if (p.label !== label) { p.text.textContent = label; p.label = label; p.w = 0; }
    p.x = x; p.y = y; p.o = o; p.pass = v.pass;
    list.push(p);
  }
  // [dx, dy] tries in order; [0, 4] still ends the tail above the head; sideways tries need a bubble wide enough to keep
  // its tail on the cat
  var BUBBLE_AT = [[0, 0], [0, 4], [0, -24], [-36, 0], [36, 0], [-36, -24], [36, -24], [-54, 0], [54, 0], [-54, -24], [54, -24]];
  // a desk name slides along the desk's front edge (at most to its corners, x the desk scale), so a wide name or font
  // still finds its own desk
  var TAG_AT = [[0, 0], [12, 7], [-12, -7], [24, 14], [-24, -14]];
  var BELT_AT = [[0, 0], [29, 17], [-29, -17], [59, 34], [-59, -34], [0, 50], [29, 67], [-29, 33], [59, 84], [-59, 16]];
  // the stage's overlays (toolbar, floor picker, floor card) as boxes in scene units, read from the live layout
  function shade(v) {
    var m = typeof v.svg.getScreenCTM === 'function' ? v.svg.getScreenCTM() : null;
    if (!m) return [];
    m = m.inverse();
    return [v.head, v.picker, v.card].map(function (n) {
      var r = n.getBoundingClientRect();
      return { x0: m.a * r.left + m.c * r.top + m.e, y0: m.b * r.left + m.d * r.top + m.f, x1: m.a * r.right + m.c * r.bottom + m.e, y1: m.b * r.right + m.d * r.bottom + m.f };
    });
  }
  // labels stay off the overlays and off each other; every patch and every stage resize settles them again, so a label
  // dropped at one size or moment can come back at another; a text is measured once while it is in the page
  function settle(list, shadeBoxes) {
    var placed = shadeBoxes.slice();
    list.forEach(function (p) {
      if (p.w) return;
      var w = (p.g.parentNode && typeof p.text.getComputedTextLength === 'function' ? p.text.getComputedTextLength() : 0) || estimate(p.label, p.o.fs);
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
      if (pick === null) { drop(p.g); return; }
      if (!p.g.parentNode) p.parent.appendChild(p.g);
      put(p.g, 'transform', 'translate(' + r1(p.x + pick[0]) + ',' + r1(p.y + pick[1]) + ')');
      if (p.tail) put(p.tail, 'transform', 'translate(' + -pick[0] + ',0)');
      placed.push(b);
      put(p.rect, 'x', r1(-p.w / 2));
      put(p.rect, 'width', r1(p.w));
    });
  }

  // ---- motion ----------------------------------------------------------------------------------------------------------
  function calm() { return !!(g.matchMedia && g.matchMedia(CALM).matches); }
  function still() { return doc.hidden === true || calm(); }
  // where a moving part shows now: its running transform applied to the place it was heading for
  function shown(n, to) {
    var m = to && typeof g.getComputedStyle === 'function' ? /^matrix\(([^)]+)\)$/.exec(g.getComputedStyle(n).transform) : null;
    if (!m) return null;
    var c = m[1].split(',').map(Number);
    return { x: r1(c[0] * to.x + c[2] * to.y + c[4]), y: r1(c[1] * to.x + c[3] * to.y + c[5]), k: r3(to.k * c[0]) };
  }
  // the hall row straight across from p: the ground under p, at the same depth x
  function onHall(p) {
    var u = (p.x - OX) / KX, w = (p.y - OY) / KY, q = iso((u + w) / 2, HALL);
    return { x: q[0], y: q[1] };
  }
  // a part that moved travels there: its wrapper starts as the old place (translate, then scale about the new anchor) and
  // eases to none, through the hall when the room changed; one still on its way starts from where it shows now. Nothing
  // starts while the tab is hidden or under reduced motion: the part is simply in its new place
  function travel(rec, part, from, to, hall) {
    if (from.x === to.x && from.y === to.y && from.k === to.k) return;
    var n = rec[part], a = rec.anims[part];
    if (a) { from = shown(n, rec.to[part]) || from; delete rec.anims[part]; a.cancel(); }
    if (typeof n.animate !== 'function' || still()) return;
    var path = hall ? [from, onHall(from), onHall(to), to] : [from, to], len = [0], i;
    for (i = 1; i < path.length; i++) len.push(len[i - 1] + Math.sqrt(Math.pow(path[i].x - path[i - 1].x, 2) + Math.pow(path[i].y - path[i - 1].y, 2)));
    var all = len[len.length - 1], at = function (j) { return all ? len[j] / all : j / (path.length - 1); };
    a = rec.anims[part] = n.animate(path.map(function (p, j) {
      var k = (from.k + (to.k - from.k) * at(j)) / to.k;
      return { offset: at(j), transform: 'translate(' + r1(p.x) + 'px,' + r1(p.y) + 'px) scale(' + r3(k) + ') translate(' + -to.x + 'px,' + -to.y + 'px)' };
    }), { duration: Math.round(Math.min(WALK[1], Math.max(WALK[0], all / PACE * 1000))), easing: 'ease-in-out' });
    rec.to[part] = to;
    var end = function () { if (rec.anims[part] === a) { delete rec.anims[part]; look(rec); } };
    a.finished.then(end, end);
  }
  // a hidden tab holds every office animation where it is: the CSS ones by the root's data-motion, the walks by pause().
  // Under reduced motion office.css stops the CSS ones and every walk ends at once, a held one too: its cat or desk is
  // simply in the place its pos or place group already holds
  function motion(v) {
    var hidden = doc.hidden === true, reduce = calm();
    put(v.root, 'data-motion', hidden ? 'paused' : 'run');
    for (var id in v.units) {
      var rec = v.units[id];
      if (reduce) { if (halt(rec)) look(rec); continue; }
      for (var part in rec.anims) {
        var a = rec.anims[part];
        if (hidden && a.playState === 'running') a.pause();
        if (!hidden && a.playState === 'paused') a.play();
      }
    }
  }
  // the reduced-motion query, watched from the first mount on (a test's fake matchMedia is in place by then) and kept
  // here so its listener lives as long as the page: reduced motion turned on ends the walks under way right away
  var calmList = null;
  function watchCalm() {
    if (calmList || !g.matchMedia) return;
    calmList = g.matchMedia(CALM);
    if (typeof calmList.addEventListener === 'function') calmList.addEventListener('change', visibility);
  }

  // ---- desks and cats: one keyed unit per desk -------------------------------------------------------------------------
  // a cat drawn at CAT size with its feet on 0,0: walk (el.animate) > pos (transform: place and scale) > .of-cat (the CSS
  // keyframes) with the body, the head and the head's blink lid
  function cat(parent) {
    var walk = el('g', { class: 'of-walk' }, parent), pos = el('g', null, walk), c = el('g', { class: 'of-cat' }, pos);
    el('use', { href: '#body' }, el('svg', { x: -CAT / 2, y: r1(-CAT * .6), width: CAT, height: r1(CAT * .6), viewBox: '0 0 100 60', overflow: 'visible' }, c));
    var head = el('svg', { x: -CAT / 2, y: r1(-CAT * 1.42), width: CAT, height: CAT, viewBox: '0 0 100 100', overflow: 'visible' }, c);
    el('use', { href: '#cat' }, head);
    var lid = el('g', { class: 'of-lid' }, head);
    el('path', { d: LID, fill: '#0d1a1a' }, lid);
    el('path', { d: LASH, fill: 'none', stroke: '#f2f2ee', 'stroke-width': 2.8, 'stroke-linecap': 'round' }, lid);
    return { walk: walk, pos: pos, cat: c };
  }
  // a desk's beat (0-3, from its id) staggers its keyframes so the cats do not type and blink in step
  function unitOf(v, f, d) {
    var u = el('g', { 'data-desk': d.id, 'data-sh': 'open', 'data-sid': f.sid, 'data-sub': d.kind === 'worker' ? 'wk' : null, role: 'button', tabindex: 0 }, v.depth);
    var rec = cat(u), beat = 0;
    for (var i = 0; i < d.id.length; i++) beat = (beat * 31 + d.id.charCodeAt(i)) % 4;
    rec.g = u; rec.beat = beat; rec.anims = {}; rec.to = {};
    return rec;
  }
  function look(rec) { put(rec.g, 'class', rec.cls + (rec.anims.walk ? ' is-walking' : '')); }
  // a monitor's screen: the mockup's on-screen colour when lit, the art's own when not
  function monitor(rec, parent) {
    rec.screen = art('monitor', parent).querySelector('polygon');
    rec.dark = rec.screen ? rec.screen.getAttribute('fill') : '';
  }
  function lit(rec, on) { if (rec.screen) put(rec.screen, 'fill', on ? '#5ac8fa' : rec.dark); }
  // a unit's walks end where they are heading (pos and place already hold the new spot), and their finished handlers
  // find nothing of theirs left in rec.anims; true when one was under way
  function halt(rec) {
    var a = rec.anims, any = false;
    rec.anims = {};
    for (var part in a) { a[part].cancel(); any = true; }
    return any;
  }
  function gone(rec) {
    halt(rec);
    drop(rec.g);
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

  function deskUnit(v, f, d, c, people, found, pub) {
    var rec = v.units[d.id] || (v.units[d.id] = unitOf(v, f, d));
    var p = people[d.id], label = deskLabel(d, people), s = c.s, lounge = d.room === 'lounge', alert = d.state === 'error' || d.state === 'lost';
    var act = [f.sid, d.kind === 'worker' ? 'wk' : ''], o = iso(c.x, c.y, c.z * s), cc = iso(.65, .05, 14);
    var foot = lounge ? { x: r1(o[0]), y: r1(o[1]), k: r3(34 * s / CAT) } : { x: r1(o[0] + (cc[0] - OX) * s), y: r1(o[1] + (cc[1] + 11 - OY) * s), k: s };
    var size = CAT * foot.k, top = foot.y - size * 1.42;
    rec.pass = v.pass;
    rec.cls = 'of-desk is-' + (d.pose || 'idle') + (lounge && d.pose === 'idle' && !c.z ? ' is-stroll' : '') + ' of-b' + rec.beat;
    put(rec.g, 'aria-label', deskName(d, p, label) + ' · 대화 열기');
    if (rec.foot) travel(rec, 'walk', rec.foot, foot, rec.room !== d.room);
    put(rec.pos, 'transform', 'translate(' + foot.x + ',' + foot.y + ') scale(' + foot.k + ')');
    rec.foot = foot;
    rec.room = d.room;
    look(rec);
    if (lounge) {
      if (rec.anims.slide) { rec.anims.slide.cancel(); delete rec.anims.slide; }
      if (rec.slide) { drop(rec.slide); rec.slide = rec.place = rec.at = rec.lamp = rec.screen = null; }
      if (!rec.hit) rec.hit = rec.walk.insertBefore(el('rect', { class: 'of-hit', rx: 6, fill: 'transparent' }), rec.walk.firstChild);
      put(rec.hit, 'x', r1(foot.x - size / 2 - 3));
      put(rec.hit, 'y', r1(top - 3));
      put(rec.hit, 'width', r1(size + 6));
      put(rec.hit, 'height', r1(size * 1.42 + 6));
    } else {
      drop(rec.hit);
      rec.hit = null;
      if (!rec.slide) {
        rec.slide = el('g', { class: 'of-slide' }, rec.g);
        rec.place = el('g', null, rec.slide);
        el('rect', { class: 'of-hit', x: 438, y: r1(cc[1] + 11 - 46 * 1.42 - 3), width: 82, height: r1(164.2 - (cc[1] + 11 - 46 * 1.42 - 3) + 2), rx: 8, fill: 'transparent' }, rec.place);
        art('desk', rec.place);
        monitor(rec, rec.place);
      }
      var at = { x: r1(o[0]), y: r1(o[1]), k: s };
      if (rec.at) travel(rec, 'slide', rec.at, at, false);
      put(rec.place, 'transform', 'translate(' + at.x + ',' + at.y + ') scale(' + s + ') translate(' + -OX + ',' + -OY + ')');
      rec.at = at;
      lit(rec, d.lamp === 'on');
      if (d.lamp === 'alert' && !rec.lamp) { var a = iso(.2, .8, 14); rec.lamp = el('circle', { cx: r1(a[0]), cy: r1(a[1] - 4), r: 4 }, rec.place); }
      if (d.lamp !== 'alert' && rec.lamp) { drop(rec.lamp); rec.lamp = null; }
      if (rec.lamp) put(rec.lamp, 'fill', alert ? '#ff5a7a' : '#ffcf5a');
      var n = iso(c.x + .8 * s, c.y + s, 0);
      found.tags.push({ id: d.id, x: n[0], y: n[1] + 13 * s, label: label + (alert ? ' · ' + word(WORKER_WORD, d.state) : ''), rank: alert ? 3 : d.kind === 'lead' ? 2 : 1,
        o: { cls: 'of-tag', act: act, key: d.id, alts: TAG_AT.map(function (t) { return [r1(t[0] * s), r1(t[1] * s)]; }), h: 19, rx: 8, fs: 12.5, fill: '#0e1528', stroke: alert ? '#ff5a7a' : '#34446e', color: '#e6ebf5' } });
    }
    if (d.pose === 'rest' && !rec.z) { rec.z = el('text', { class: 'of-z', 'font-size': 13, 'font-weight': 700, fill: '#8fb0ff' }, rec.walk); rec.z.textContent = 'z'; }
    if (d.pose !== 'rest' && rec.z) { drop(rec.z); rec.z = null; }
    if (rec.z) { put(rec.z, 'x', r1(foot.x + size * .3)); put(rec.z, 'y', r1(top + 4)); }
    if (!pub && d.bubble) {
      found.bubbles.push({ id: d.id, x: foot.x, y: top - 20 * s, label: cut(d.bubble, 12.5, 176), rank: d.state === 'working' ? 2 : 1,
        o: { cls: 'of-bub', act: act, key: d.id, alts: BUBBLE_AT, h: 23, rx: 8, fs: 12.5, fill: '#0f1834', stroke: alert ? '#ff5a7a' : d.state === 'waiting' ? '#ffcf5a' : '#3d6ef0', color: '#e6ebf5', tail: 1 } });
    }
  }

  // ---- one floor -----------------------------------------------------------------------------------------------------
  // a dark floor (closed and folded): the whole scene under a night shade, below the labels
  function dim(v, on) {
    if (on && !v.dim) v.dim = v.top.insertBefore(el('rect', { x: -2000, y: -2000, width: 5000, height: 5000, fill: '#05070f', opacity: .5 }), v.top.firstChild);
    if (!on && v.dim) { drop(v.dim); v.dim = null; }
  }
  function clearFloor(v, sid) {
    for (var id in v.units) gone(v.units[id]);
    for (var k in v.pills) drop(v.pills[k].g);
    v.boxes.forEach(function (b) { drop(b.g); });
    v.units = {}; v.pills = {}; v.boxes = []; v.floor = sid;
  }
  // the belt: one box per plan wave (done / current / to come, the mockup's three box colours) that office.css moves along
  // its own slot, and the back-wall screen with the plan's progress
  function drawBelt(v, f) {
    var conv = f && f.conveyor, waves = conv ? arr(conv.waves) : [], belt = [];
    var boxes = tree('conveyor', g.BriefOfficeArt.props.conveyor)[0].kids.slice(2, 5);
    var step = waves.length > 1 ? Math.min(3, 15.2 / (waves.length - 1)) : 3;
    waves.forEach(function (w, i) {
      var tone = i < conv.current || conv.current < 0 ? 0 : i === conv.current ? 1 : 2, x = 1.8 + i * step, ink = ['#4fd1a5', '#7aa2ff', '#8b97b3'][tone];
      var b = v.boxes[i] || (v.boxes[i] = { g: el('g', null, v.dyn), tone: -1 });
      put(b.g, 'transform', move(i * step - [0, 3, 6][tone], 0));
      if (b.tone !== tone) { b.g.textContent = ''; build(boxes[tone], b.g); b.tone = tone; }
      var p = iso(x + step / 2, 5.6, 8);
      belt.push({ id: i, x: p[0], y: p[1] - 26, label: (w.n || i + 1) + '단계' + (tone === 0 ? ' ✓' : tone === 1 ? ' ●' : ''), rank: tone === 1 ? 2 : tone === 0 ? 1 : 0,
        o: { cls: 'of-wave', alts: BELT_AT, h: 18, rx: 9, fs: 11.5, fill: '#0e1528', stroke: ink, color: ink } });
    });
    v.boxes.splice(waves.length).forEach(function (b) { drop(b.g); });
    var cur = conv && conv.current >= 0 ? waves[conv.current] : null;
    var lines = !conv ? [] : [cur ? '계획 ' + (cur.n || conv.current + 1) + '단계 진행 중' : '계획 단계 모두 끝', cur ? '상자 ' + cur.done + '/' + cur.total + ' 끝' : '상자 ' + waves.length + '단계',
      cur ? cut(str(cur.label), 11, 150) : ''];
    v.wall.forEach(function (t, i) { txt(t, lines[i] || ''); });
    return belt;
  }
  function drawFloor(v, f) {
    var sc = v.scene, pub = v.ui.publicMode === true, people = {}, labels = [], sid = f ? f.sid : null;
    if (v.floor !== sid) clearFloor(v, sid);
    v.pass++;
    arr(sc.people).forEach(function (p) { if (f && p.sid === f.sid) people[p.id] = p; });
    put(v.svg, 'aria-label', f ? floorNo(v, f) + '층 · ' + (f.label || '(제목 없음)') : '빈 사무실');
    dim(v, !!(f && f.dark));
    // labels in priority order: rooms and the boss's count always, then desk names (alerts first), bubbles, the belt
    ROOMS.forEach(function (r) {
      var n = f ? arr(f.rooms && f.rooms[r[0]]).length : 0, p = iso(r[3] + .5, r[6] - .3);
      pill(v, labels, 'room:' + r[0], p[0], p[1] - 6, r[1] + (n ? ' ' + n : ''), { cls: 'of-room', h: 20, rx: 5, fs: 13, fw: 700, fill: '#141c36', stroke: r[2], color: r[2], keep: 1 });
    });
    var ceoN = sc.ceo ? sc.ceo.count : 0;
    if (ceoN > 0) {
      var bc = iso(BOSS[0] + .8, BOSS[1] + .1, 32);
      pill(v, labels, 'boss', bc[0], bc[1] - 18, '할 일 ' + ceoN + '건', { cls: 'of-bub', h: 23, rx: 8, fs: 12.5, fill: '#0f1834', stroke: '#ffcf5a', color: '#e6ebf5', tail: 1, keep: 1 });
    }
    lit(v.boss, ceoN > 0);
    var belt = drawBelt(v, f), cells = f ? layout(f) : {}, found = { tags: [], bubbles: [] };
    var desks = f ? arr(f.desks).filter(function (d) { return has(cells, d.id); }) : [];
    desks.forEach(function (d) { deskUnit(v, f, d, cells[d.id], people, found, pub); });
    for (var id in v.units) if (v.units[id].pass !== v.pass) { gone(v.units[id]); delete v.units[id]; }
    // the mockup's painter order by x + y: the props never move, and a desk moves in it only when its place changed
    var items = v.props.concat(desks.map(function (d) { return { x: cells[d.id].x, y: cells[d.id].y, n: v.units[d.id].g }; }));
    items.sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
    order(v.depth, items.map(function (it) { return it.n; }));
    var byRank = function (list) { return list.sort(function (a, b) { return b.rank - a.rank; }); };
    byRank(found.tags).forEach(function (t) { pill(v, labels, 'tag:' + t.id, t.x, t.y, t.label, t.o); });
    if (!pub) byRank(found.bubbles).forEach(function (t) { pill(v, labels, 'bub:' + t.id, t.x, t.y, t.label, t.o); });
    byRank(belt).forEach(function (t) { pill(v, labels, 'wave:' + t.id, t.x, t.y, t.label, t.o); });
    for (var k in v.pills) if (v.pills[k].pass !== v.pass) { drop(v.pills[k].g); delete v.pills[k]; }
    v.labels = labels;
    settle(labels, shade(v));
  }

  // ---- HTML chrome -----------------------------------------------------------------------------------------------------
  function floorNo(v, f) { return v.scene.floors.length - v.scene.floors.indexOf(f); }
  function floorWord(f) { return f.live ? '실행 중' : f.dark ? '불 꺼짐' : '쉬는 중'; }
  // the conversation's place: its tab label (and number) and cwd, straight from the view model (the scene has neither)
  function placeOf(vm, sid) {
    var s = arr(vm && vm.sessions).filter(function (x) { return x && x.id === sid; })[0];
    if (!s) return '';
    var tab = str(s.tabLabel) ? str(s.tabLabel) + (typeof s.tabNumber === 'number' && isFinite(s.tabNumber) ? ' #' + s.tabNumber : '') : '';
    return [tab, str(s.cwd)].filter(Boolean).join(' · ');
  }
  // a part patched under the owner's focus keeps it; a replaced control gives it back to the control with the same attr
  // value, else to the same position
  function keepFocus(container, attr, fn) {
    var a = doc.activeElement, inside = !!(a && a !== container && container.contains(a) && a.getAttribute), key = null, at = -1;
    var controls = function () { return Array.prototype.slice.call(container.querySelectorAll('button,[tabindex]')); };
    if (inside) { key = attr ? a.getAttribute(attr) : null; at = controls().indexOf(a); }
    fn();
    if (!inside || (doc.activeElement === a && container.contains(a))) return;
    var all = controls(), to = null;
    for (var i = 0; key !== null && i < all.length && !to; i++) if (all[i].getAttribute(attr) === key) to = all[i];
    to = to || all[Math.min(at, all.length - 1)];
    if (to && to.focus) to.focus({ preventScroll: true });
  }
  function floorRow(it) {
    var b = el('button', { type: 'button', class: 'of-fl', 'data-floor': it.key, 'aria-pressed': it.on ? 'true' : 'false',
      'aria-label': it.n + '층 · ' + it.title + ' · ' + it.word + (it.dec ? ' · 결정 ' + it.dec + '건' : '') }, null, true);
    h('span', 'of-no', b, it.n + 'F');
    h('span', 'of-ft', b, it.title);
    if (it.dec) h('span', 'of-n', b, String(it.dec));
    h('span', 'of-fs', b, it.word);
    return b;
  }
  function drawPicker(v, f) {
    var sc = v.scene;
    keepFocus(v.picker, 'data-floor', function () {
      if (!sc.floors.length && !v.noFloor) v.noFloor = h('p', 'of-empty', v.picker, '아직 층이 없어요');
      if (sc.floors.length && v.noFloor) { drop(v.noFloor); v.noFloor = null; }
      rows(v, 'floors', v.flist, sc.floors.map(function (fl) {
        return { key: fl.sid, n: floorNo(v, fl), title: fl.label || '(제목 없음)', word: floorWord(fl), dec: decisionsOf(sc, fl.sid), on: fl === f };
      }), floorRow);
    });
  }
  function drawCard(v, f, place) {
    keepFocus(v.card, null, function () {
      var c = v.cardParts;
      if (!c || c.floor !== !!f) {
        v.card.textContent = '';
        c = v.cardParts = { floor: !!f };
        if (!f) { h('p', 'of-empty', v.card, '대화를 시작하면 그 대화가 한 층이 돼요'); return; }
        c.no = h('span', 'of-cn', v.card);
        c.box = h('div', 'of-ct', v.card);
        c.title = h('b', '', c.box);
        c.meta = h('small', '', c.box);
        c.where = null;
        c.open = el('button', { type: 'button', class: 'of-open', 'data-sh': 'open' }, v.card, true);
        c.open.textContent = '대화 열기';
      }
      if (!f) return;
      var desks = arr(f.desks), working = desks.filter(function (d) { return d.state === 'working'; }).length, dec = decisionsOf(v.scene, f.sid);
      txt(c.no, floorNo(v, f) + 'F');
      txt(c.title, f.label || '(제목 없음)');
      txt(c.meta, [floorWord(f), '작업자 ' + (desks.length - 1) + '명', working ? '일하는 중 ' + working : '', dec ? '결정 ' + dec + '건 대기' : ''].filter(Boolean).join(' · '));
      // the tab label and cwd: never drawn in public mode (place is '' then)
      if (place && !c.where) c.where = h('small', 'of-where', c.box);
      if (!place && c.where) { drop(c.where); c.where = null; }
      if (c.where) { txt(c.where, place); put(c.where, 'title', place); }
      put(c.open, 'data-sid', f.sid);
    });
  }
  // a rail box: its title with a count, a one-line note while it has one (empty, or the rest), and its keyed rows
  function section(parent, title, tag, counted) {
    var s = h('section', 'of-box', parent), t = h('h3', '', s, title);
    return { s: s, count: counted ? h('small', '', t, '') : null, list: h(tag, tag === 'ol' ? 'of-log' : 'of-list', s), note: null, more: null };
  }
  function note(b, which, text, after) {
    if (text && !b[which]) b[which] = b.s.insertBefore(h('p', 'of-empty', null, text), after ? null : b.list);
    if (!text && b[which]) { drop(b[which]); b[which] = null; }
    if (b[which]) txt(b[which], text);
  }
  function item(it) {
    var li = h('li', ''), b = el('button', { type: 'button', class: 'of-it', 'data-sh': 'open', 'data-sid': it.act[0], 'data-sub': it.act[1] || null }, li, true);
    h('span', 'of-it-t', b, it.title);
    if (it.state) h('span', 'of-st is-' + it.tone, b, it.state);
    if (it.meta) h('span', 'of-it-m', b, it.meta);
    return li;
  }
  function logRow(it) {
    var li = h('li', '');
    if (it.time) h('b', '', li, it.time);
    h('span', '', li, it.text);
    return li;
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
    var sc = v.scene, pub = v.ui.publicMode === true, ceo = sc.ceo || { items: [], count: 0 }, b = v.box;
    keepFocus(v.rail, null, function () {
      var items = arr(ceo.items), alerts = arr(sc.alerts), desks = f ? arr(f.desks) : [], people = {};
      txt(b.todo.count, ceo.count + '건');
      note(b.todo, 'note', items.length ? '' : '지금 대표님을 기다리는 일은 없어요');
      rows(v, 'todo', b.todo.list, keyed(items.slice(0, 6).map(function (it) {
        return { act: [it.sid, it.sub], title: it.text || it.kind, meta: [it.kind, label(sc, it.sid)].filter(Boolean).join(' · ') };
      }), function (it) { return it.act.join('|') + '|' + it.title; }), item);
      note(b.todo, 'more', items.length > 6 ? '나머지 ' + (items.length - 6) + '건은 수신함에 있어요' : '', true);
      txt(b.alert.count, alerts.length + '건');
      note(b.alert, 'note', alerts.length ? '' : '오류나 끊긴 작업자가 없어요');
      rows(v, 'alert', b.alert.list, keyed(alerts.map(function (a) {
        return { act: [a.sid, 'wk'], title: a.text || '작업자', meta: label(sc, a.sid), tone: 'err', state: word(WORKER_WORD, a.state), id: a.worker };
      }), function (it) { return it.act[0] + '|' + it.id; }), item);
      arr(sc.people).forEach(function (p) { if (f && p.sid === f.sid) people[p.id] = p; });
      var working = desks.filter(function (d) { return d.state === 'working'; }).length;
      txt(b.people.count, f ? desks.length + '명' + (working ? ' · 일하는 중 ' + working : '') : '');
      note(b.people, 'note', desks.length ? '' : '이 층에는 아직 아무도 없어요');
      rows(v, 'people', b.people.list, keyed(desks.map(function (d) {
        var p = people[d.id], name = deskLabel(d, people), lead = d.kind === 'lead';
        return { act: [f.sid, lead ? '' : 'wk'], title: name + ' · ' + (ROOM_NAME[d.room] || ''), meta: [lead ? '' : p && p.name !== name ? p.name : '', pub ? '' : d.bubble].filter(Boolean).join(' · '),
          tone: TONE[d.state] || 'rest', state: lead ? word(LEAD_WORD, d.state) : word(WORKER_WORD, d.state), id: d.id };
      }), function (it) { return it.act[0] + '|' + it.id; }), item);
      var log = f ? arr(sc.log).filter(function (l) { return l.sid === f.sid; }) : [];
      var ms = function (l) { var t = typeof l.at === 'number' ? l.at : Date.parse(str(l.at)); return isFinite(t) ? t : 0; };
      note(b.log, 'note', log.length ? '' : '이 층의 기록이 아직 없어요');
      rows(v, 'log', b.log.list, keyed(log.map(function (l, i) { return { l: l, i: i }; }).sort(function (x, y) { return (ms(y.l) - ms(x.l)) || (x.i - y.i); }).slice(0, 8).map(function (x) {
        return { time: clock(x.l.at), text: x.l.kind === 'worker' ? (x.l.text || '작업자') + ' · ' + word(WORKER_WORD, x.l.state) : x.l.text };
      }), function (it) { return it.time + '|' + it.text; }), logRow);
    });
  }

  // ---- mount and draw --------------------------------------------------------------------------------------------------
  function mount(root) {
    watchCalm();
    root.textContent = '';
    var v = { root: root, sid: null, keys: {}, units: {}, pills: {}, boxes: [], rows: {}, pass: 0, floor: undefined, dim: null, noFloor: null, cardParts: null };
    var body = h('div', 'of-body', root), stage = h('div', 'of-stage', body);
    v.svg = el('svg', { class: 'of-scene', viewBox: '30 0 1000 700', preserveAspectRatio: 'xMidYMid meet', role: 'group' }, stage);
    set(base(v.svg), 'aria-hidden', 'true');
    v.dyn = el('g', { class: 'of-l-belt', 'aria-hidden': 'true' }, v.svg);
    var c0 = iso(4, 0, 100);
    v.wall = [0, 1, 2].map(function (i) { return el('text', { transform: 'translate(' + r1(c0[0] + 10) + ',' + r1(c0[1] + 20 + i * 15) + ') skewY(30)', 'font-size': 11, fill: i ? '#8fb0ff' : '#ffcf5a' }, v.dyn); });
    v.depth = el('g', { class: 'of-l-depth' }, v.svg);
    // the props and the boss's desk are drawn once, where the mockup drew them; the desks are sorted in between
    v.props = FURN.map(function (fu) { return { x: fu[1], y: fu[2], n: art(fu[0], v.depth, fu.length > 3 ? move(fu[3], fu[4]) : null) }; });
    var boss = el('g', { class: 'of-boss', transform: move(BOSS[0], BOSS[1]) }, v.depth);
    art('desk', boss);
    v.boss = {};
    monitor(v.boss, boss);
    v.props.push({ x: BOSS[0], y: BOSS[1], n: boss });
    v.top = el('g', { class: 'of-l-top', 'aria-hidden': 'true' }, v.svg);
    v.head = h('div', 'of-head', stage);
    h('h2', 'of-title', v.head, '사무실');
    v.pub = el('button', { type: 'button', class: 'of-pub', role: 'switch', 'aria-checked': 'false', 'data-act': 'office-public', title: '말풍선, 탭 이름, 작업 폴더를 숨겨요' }, v.head, true);
    el('span', { class: 'of-sw', 'aria-hidden': 'true' }, v.pub, true);
    h('span', '', v.pub, '공개 모드');
    v.picker = el('nav', { class: 'of-floors', 'aria-label': '층 고르기' }, stage, true);
    h('h3', '', v.picker, '층 고르기 · 대화 1개 = 1층');
    v.flist = h('div', 'of-flist', v.picker);
    v.card = h('div', 'of-card', stage);
    v.rail = h('div', 'of-rail', body);
    v.box = { todo: section(v.rail, '대표님 할 일', 'ul', true), alert: section(v.rail, '알림', 'ul', true), people: section(v.rail, '사무실 사람들', 'ul', true), log: section(v.rail, '활동 로그', 'ol', false) };
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
  // the live desk and cat nodes for QA (node identity across publishes)
  function refs(v) {
    var desks = {}, cats = {};
    for (var id in v.units) { desks[id] = v.units[id].g; cats[id] = v.units[id].cat; }
    g.__office = { sid: v.sid, desks: desks, cats: cats };
  }
  function draw(v) {
    var sc = v.scene, f = null;
    for (var i = 0; i < sc.floors.length; i++) if (sc.floors[i].sid === v.sid) f = sc.floors[i];
    f = f || sc.floors[0] || null;
    v.sid = f ? f.sid : null;
    var floors = JSON.stringify(sc.floors.map(function (x) { return [x.sid, x.label, x.live, x.dark, decisionsOf(sc, x.sid)]; }));
    var pub = v.ui.publicMode === true, place = f && !pub ? placeOf(v.vm, f.sid) : '';
    put(v.pub, 'aria-checked', pub ? 'true' : 'false');
    part(v, 'picker', floors + '|' + v.sid, function () { drawPicker(v, f); });
    part(v, 'card', JSON.stringify([f, floors, place]), function () { drawCard(v, f, place); });
    part(v, 'floor', JSON.stringify([f, sc.people.filter(function (p) { return f && p.sid === f.sid; }), sc.ceo && sc.ceo.count, pub, floors]), function () {
      keepFocus(v.depth, 'data-desk', function () { drawFloor(v, f); });
    });
    part(v, 'rail', JSON.stringify([f, sc.ceo, sc.alerts, sc.people, sc.log, pub, floors]), function () { drawRail(v, f); });
    refs(v);
    motion(v);
  }
  var views = new WeakMap();
  // a missing region or module throws here, so page.js shows its fatal notice instead of an empty office
  function render(root, vm, ui) {
    var v = views.get(root);
    if (!v) { v = mount(root); views.set(root, v); }
    v.ui = ui || {};
    v.vm = vm || {};
    v.scene = g.BriefOffice.scene(v.vm, v.ui, v.vm.generatedAt);
    draw(v);
  }
  function visibility() {
    var root = doc.getElementById('office'), v = root && views.get(root);
    if (v) motion(v);
  }
  g.BriefOfficeView = { render: render, layout: layout, visibility: visibility };
})(typeof globalThis !== 'undefined' ? globalThis : this);
