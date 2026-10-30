/* omo-briefing office view (plan todos 5-6): classic script (file:// safe, no modules). Draws one floor of the scene
 * g.BriefOffice.scene(vm, ui, now) builds as an isometric SVG in the mockup's projection (origin 470,120, 34-unit tiles,
 * office-assets.js art), plus the HTML chrome around it: the toolbar (title, 공개 모드 switch), the floor picker, the
 * floor card and the rail (대표님 할 일, 알림, 사무실 사람들, 활동 로그). Wide, the toolbar, the picker and the card float
 * over the scene as in the mockup; narrow (office.css), they sit above and below it, and the picker folds into one row (the
 * floor shown) that opens its list. Model text only ever goes through textContent or
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
 * The boss cat (plan todo 10) is the owner's own cat on the shown floor: the arrow keys, W/A/S/D and a click on the floor
 * walk it over the model's walk map (see "the boss cat" below); it is not a desk, a session or a count. Next to a cat, E
 * (or Space, Enter) or a click on the cat opens the talk dialog (plan todo 11, see "the talk dialog" below).
 *   g.BriefOfficeView.render(root, vm, ui)   draws or patches the office inside root (#office); one floor at a time
 *   g.BriefOfficeView.layout(floor)           -> {deskId: {x, y, z, s}} the grid cell of every desk (pure; the model's)
 *   g.BriefOfficeView.visibility()            holds or resumes the shown office's motion with document.hidden and ends
 *                                             its walks under reduced motion
 *   g.BriefOfficeView.status(sid)             annotate.js's status line of sid changed (page.js's status hook): the
 *                                             talk dialog's note line follows it
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
  // the props stand where the model's floor plan puts them (g.BriefOffice.map.props: art, x0, y0, x1, y1); the mockup drew
  // the sofa and the plant art elsewhere (NATIVE: x0, y0 of those drawings), so they are moved there. The boss's desk is
  // drawn with its monitor, the bookshelf with the static floor
  var NATIVE = { sofa: [.6, 3.2], plant: [5, .6] }, FURN = [], BOSS = null;
  g.BriefOffice.map.props.forEach(function (p) {
    var r = p.slice(1), n = has(NATIVE, p[0]) ? NATIVE[p[0]] : null;
    if (p[0] === 'desk') BOSS = r;
    else if (p[0] !== 'shelf') FURN.push({ art: p[0], r: r, at: n ? [r[0] - n[0], r[1] - n[1]] : null });
  });
  var LEAD_WORD = { in_progress: '진행 중', needs_decision: '결정 대기', blocked: '막힘', recheck: '재확인', done: '끝남', done_no_evidence: '끝(근거 없음)' };
  var WORKER_WORD = { working: '진행 중', running: '진행 중', waiting: '대기', done: '끝', cancelled: '취소', error: '오류', lost: '끊김' };
  var TONE = { working: 'run', running: 'run', in_progress: 'run', waiting: 'wait', needs_decision: 'wait', recheck: 'wait', blocked: 'err', error: 'err', lost: 'err' };
  var ROOM_NAME = {};
  ROOMS.forEach(function (r) { ROOM_NAME[r[0]] = r[1]; });
  // motion: CAT is a cat's drawn size (its pos transform scales it); a walk between rooms crosses the hall row HALL (tiles,
  // between the belt and the lower rooms) at PACE px/s and lasts WALK[0]..WALK[1] ms
  var CALM = '(prefers-reduced-motion: reduce)', CAT = 46, HALL = 7, PACE = 140, WALK = [400, 3000];
  // a lounge cat's hit box is at least TAP scene units each way: 44 px where a phone shows the scene (office.css, x 0.72)
  var TAP = 62;
  // the wall screens' text leans 30 degrees (skewY): the back wall's falls to the right, the left wall's rises
  var TAN = Math.tan(Math.PI / 6);
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
  // facts joined by ·, each its own run (office.css .of-seg) with its · kept at its end: a line breaks only after a ·, never
  // inside 결정 1건 대기 or a title (a run longer than the line still wraps inside itself)
  function facts(n, list) {
    if (n.textContent === list.join(' · ')) return;
    n.textContent = '';
    list.forEach(function (s, i) { if (i) n.appendChild(doc.createTextNode(' ')); h('span', 'of-seg', n, i < list.length - 1 ? s + ' ·' : s); });
  }
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

  // ---- layout: every desk of a floor gets one grid cell in its room: the model's floor plan (pure) ----------------------
  var layout = g.BriefOffice.layout;

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
    g.BriefOffice.map.glass.forEach(function (s) {
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
    put(p.g, 'data-ax', r1(x));
    put(p.g, 'data-ay', r1(y));
    list.push(p);
  }
  // [dx, dy] tries in order; [0, 4] still ends the tail above the head; sideways tries need a bubble wide enough to keep
  // its tail on the cat
  var BUBBLE_AT = [[0, 0], [0, 4], [0, -24], [-36, 0], [36, 0], [-36, -24], [36, -24], [-54, 0], [54, 0], [-54, -24], [54, -24]];
  // a desk name slides along the desk's front edge (at most to its corners, x the desk scale), so a wide name or font
  // still finds its own desk
  var TAG_AT = [[0, 0], [12, 7], [-12, -7], [24, 14], [-24, -14]];
  // then, within 48 units of its anchor: further along the desk front first, then a little above or below it
  var TAG_MORE = [[36, 21], [-36, -21], [41, 24], [-41, -24], [0, 20], [0, -20], [12, 27], [-12, -27], [24, -6], [-24, 6]];
  var BELT_AT = [[0, 0], [29, 17], [-29, -17], [59, 34], [-59, -34], [0, 50], [29, 67], [-29, 33], [59, 84], [-59, 16]];
  // then finer places inside the same bounds: along the belt (17 down per 29 across) on the belt, under it in steps and
  // just above it, never farther than 35 up or 84 down
  var BELT_MORE = [0, 15, -15, 29, -29, 40, -40].reduce(function (all, dx) {
    var on = Math.round(dx * 17 / 29);
    [on, on + 33, on + 50, on + 67, on + 84, on - 26, on - 35].forEach(function (dy) { if (dy >= -35 && dy <= 84) all.push([dx, dy]); });
    return all;
  }, []);
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
  // the wall screens' lines glyph by glyph, as boxes in scene units: a line is translate(x,y) skewY(+-30) at font 11; a
  // glyph's cell is the browser's own (getExtentOfChar) once the line is laid out, else estimate() wide from a little above
  // its letters to under its baseline
  function wallBoxes(v) {
    var out = [];
    v.wall.concat(v.wallL).forEach(function (t, i) {
      var s = t.textContent, m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(t.getAttribute('transform')), x = Number(m[1]), y = Number(m[2]), tan = i < 3 ? TAN : -TAN, at = 0;
      var real = s.length > 0 && typeof t.getNumberOfChars === 'function' && t.getNumberOfChars() === s.length;
      for (var k = 0; k < s.length; k++) {
        var e = real ? t.getExtentOfChar(k) : null, a = e && e.width > 0 ? e.x : at, b = e && e.width > 0 ? e.x + e.width : at + estimate(s[k], 11);
        var top = e && e.width > 0 ? e.y : -10, bot = e && e.width > 0 ? e.y + e.height : 3;
        out.push({ x0: x + a - 1, x1: x + b + 1, y0: y + Math.min(tan * a, tan * b) + top, y1: y + Math.max(tan * a, tan * b) + bot });
        at = b;
      }
    });
    return out;
  }
  // the boss cat's drawing (head and body) on the tile it stands on
  function meBox(v) {
    if (!v.walk || !v.me.g.parentNode) return [];
    var f = footOf(v, v.me.tile);
    return [{ face: '@me', lvl: 2, x0: f.x - CAT / 2, x1: f.x + CAT / 2, y0: f.y - CAT * 1.42, y1: f.y + 2 }];
  }
  // where the boss's drawing stands at the spawn: kept clear by the labels wherever the boss is, so the labels the floor
  // shows at the spawn show however far it walks
  function homeBox(v) {
    if (!v.walk || !v.me.g.parentNode || v.me.home == null) return [];
    var f = footOf(v, v.me.home);
    return [{ x0: f.x - CAT / 2, x1: f.x + CAT / 2, y0: f.y - CAT * 1.42, y1: f.y + 2 }];
  }
  // what the labels settle around: the overlays and the wall screens' text (hard), the boss cat and the other cats' faces
  // (soft), and the other desks' and lounge cats' hit rects (soft, kept off longest)
  function obstacles(v) { return shade(v).concat(wallBoxes(v), v.faces || []); }
  // the labels settle once, keeping off the boss's drawing (hard, as the overlays) and, where they can, off the other desks'
  // and cats' hit rects; only when that leaves a label out do they settle again without the hit rects, and the way that
  // places more wins (v.settles: how many settles the last redraw took, 1 when nothing is left out; a round that places no more ends them). A label left over another desk's or cat's hit
  // rect lets the pointer through to it
  function placeLabels(v) {
    var list = v.labels, me = meBox(v).map(function (b) { return { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 }; });
    var base = obstacles(v).concat(homeBox(v), me), hit = v.hitBoxes || [];
    if (!list) return;
    var shown = function () { return list.filter(function (p) { return !!p.g.parentNode; }).length; };
    // once; only when a label is left out: up to 3 more rounds, the labels left out first (each still in its own places),
    // around the hit rects and without them; the order and way that places the most wins
    var ways = [base.concat(hit), base], order = list, best = { n: -1 };
    settle(order, ways[0]);
    v.settles = 1;
    best = { n: shown(), order: order, o: ways[0] };
    for (var round = 0; round < 3 && best.n < list.length; round++) {
      var out = best.order.filter(function (p) { return !p.g.parentNode; });
      order = out.concat(best.order.filter(function (p) { return !!p.g.parentNode; }));
      var before = best.n;
      ways.forEach(function (o) { settle(order, o); v.settles++; var n = shown(); if (n > best.n) best = { n: n, order: order, o: o }; });
      settle(best.order, best.o);
      v.settles++;
      if (best.n === before) break;
    }
    // still one out: the labels left out may cover other labels rather than stay out (never the boss, the overlays or
    // the wall text)
    if (best.n < list.length) { settle(best.order, best.o, true); v.settles++; }
    put(v.root, 'data-settles', v.settles);
    list.forEach(function (p) { if (p.g.parentNode) put(p.g, 'data-pass', hit.some(function (q) { return q.face !== p.o.key && cross(p.box, q); }) ? '1' : '0'); });
  }
  // the labels settle again around the boss where it stopped
  function stopped(v) { placeLabels(v); }
  // labels stay off the overlays, the wall screens' text and each other (a label with no free place stays out); a soft box
  // (face: its desk id, or '@me' for the boss cat; a label's own cat never counts) is kept off where any place allows it:
  // first every soft box, then only the hit rects (lvl 2), then none, so the boss never removes a label; every patch, every stage resize and every stop of the boss settles them again, so a
  // label dropped at one size or moment can come back at another; a text is measured once while in the page
  function settle(list, shadeBoxes, cover) {
    var placed = shadeBoxes.slice(), later = [];
    list.forEach(function (p) {
      if (p.w) return;
      var w = (p.g.parentNode && typeof p.text.getComputedTextLength === 'function' ? p.text.getComputedTextLength() : 0) || estimate(p.label, p.o.fs);
      p.w = w + 14;
    });
    // its own places only: a belt label inside its own wave's slot (span) and one belt row (35 up to 84 down), a bubble
    // where its tail stays on its cat, a tag along or near its desk front
    var own = function (p) { return (p.o.alts || [[0, 0]]).filter(function (c) { return !p.o.span || (Math.abs(c[0]) < p.o.span && c[1] >= -35 && c[1] <= 84); }); };
    var put1 = function (p, c) {
      if (!p.g.parentNode) p.parent.appendChild(p.g);
      p.box = c.b;
      put(p.g, 'transform', 'translate(' + r1(p.x + c.pick[0]) + ',' + r1(p.y + c.pick[1]) + ')');
      if (p.tail) put(p.tail, 'transform', 'translate(' + -c.pick[0] + ',0)');
      c.b.lab = p.o.keep ? 2 : 1;
      placed.push(c.b);
      put(p.rect, 'x', r1(-p.w / 2));
      put(p.rect, 'width', r1(p.w));
    };
    // the fixed labels (the rooms' names, the boss desk's count) first, so no label is placed where one of them lands
    list.filter(function (p) { return p.o.keep; }).concat(list.filter(function (p) { return !p.o.keep; })).forEach(function (p) {
      var c = choose(p, own(p), placed, cover);
      if (c) put1(p, c);
      else if (cover) later.push(p);
      else drop(p.g);
    });
    // a label still out when every other one has its place (the last settle only): a farther place of its own kind
    // (twice its offsets, a row or two higher, a row lower; a belt label still in its slot and row, a bubble still within
    // its tail's reach: 24 up to 4 down), clear of every
    // label already placed, so it never costs another label its place; none free, it stays out
    later.forEach(function (p) {
      var far = [];
      own(p).forEach(function (a) { [[a[0] * 2, a[1] * 2], [a[0], a[1] - 24], [a[0], a[1] + 24], [a[0], a[1] - 48]].forEach(function (f) { if (p.o.span ? Math.abs(f[0]) < p.o.span && f[1] >= -35 && f[1] <= 84 : !p.o.tail || (f[1] >= -24 && f[1] <= 4)) far.push(f); }); });
      var c = choose(p, far, placed, false);
      if (c) put1(p, c); else drop(p.g);
    });
  }
  // the first of tries clear of every box (k 0), of all but the other cats' faces (k 1), else the place clear of the hard
  // boxes that covers the least of the soft ones (k 2); with cover (k 3) also one that covers other labels, weighed four
  // times, rather than none (the overlays, the wall text, the boss and the rooms' names stay hard). null: no place
  function choose(p, tries, placed, cover) {
    var pick = null, b = null, least = Infinity;
    for (var k = 0; k < (cover ? 4 : 3) && pick === null; k++) for (var i = 0; i < tries.length && (k >= 2 || pick === null); i++) {
      var dx = tries[i][0], dy = tries[i][1];
      if (p.tail && Math.abs(dx) > p.w / 2 - 12) continue;
      var c = { x0: p.x + dx - p.w / 2, x1: p.x + dx + p.w / 2, y0: p.y + dy - p.o.h / 2 - 3, y1: p.y + dy + p.o.h / 2 + (p.o.tail ? 4 : 1) };
      if (p.o.keep) { pick = tries[i]; b = c; break; }
      if (k < 2) { if (!placed.some(function (q) { return (!q.face || (k < (q.lvl || 1) && q.face !== p.o.key)) && cross(c, q); })) { pick = tries[i]; b = c; } continue; }
      if (k === 3 && least < Infinity) break;
      if (placed.some(function (q) { return !q.face && (k < 3 || q.lab !== 1) && cross(c, q); })) continue;
      var lap = placed.reduce(function (n, q) { return q.face === p.o.key || !cross(c, q) ? n : n + (q.lab ? 4 : 1) * (Math.min(c.x1, q.x1) - Math.max(c.x0, q.x0)) * (Math.min(c.y1, q.y1) - Math.max(c.y0, q.y0)); }, 0);
      if (lap < least) { least = lap; pick = tries[i]; b = c; }
    }
    return pick === null ? null : { pick: pick, b: b };
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
    // the boss cat: reduced motion puts it at once where its step or walk ends; a hidden tab holds its step
    var me = v.me, step = me.anim;
    if (step && reduce) {
      var end = me.path && me.path.length ? me.path[me.path.length - 1] : me.to;
      hush(me);
      me.tile = end;
      drawMe(v, end);
      paint(v, [end]);
      follow(v, false);
      stopped(v);
    } else if (step && hidden && step.playState === 'running') step.pause();
    else if (step && !hidden && step.playState === 'paused') step.play();
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
    return { walk: walk, pos: pos, cat: c, head: head };
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
      var hw = Math.max(size + 6, TAP), hh = Math.max(size * 1.42 + 6, TAP);
      rec.hitBox = { x0: foot.x - hw / 2, x1: foot.x + hw / 2, y0: foot.y + 3 - hh, y1: foot.y + 3 };
      rec.headBox = { x0: foot.x - size / 2, x1: foot.x + size / 2, y0: top, y1: top + size };
      rec.deskBox = null;
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
      // its hit rect (drawn above in the place group's units) in scene units, for the lounge cats' hit boxes to keep off
      var hy = r1(cc[1] + 11 - 46 * 1.42 - 3), hb = hy + r1(164.2 - (cc[1] + 11 - 46 * 1.42 - 3) + 2);
      rec.deskBox = { x0: at.x + (438 - OX) * s, x1: at.x + (520 - OX) * s, y0: at.y + (hy - OY) * s, y1: at.y + (hb - OY) * s };
      lit(rec, d.lamp === 'on');
      if (d.lamp === 'alert' && !rec.lamp) { var a = iso(.2, .8, 14); rec.lamp = el('circle', { cx: r1(a[0]), cy: r1(a[1] - 4), r: 4 }, rec.place); }
      if (d.lamp !== 'alert' && rec.lamp) { drop(rec.lamp); rec.lamp = null; }
      if (rec.lamp) put(rec.lamp, 'fill', alert ? '#ff5a7a' : '#ffcf5a');
      var n = iso(c.x + .8 * s, c.y + s, 0);
      found.tags.push({ id: d.id, x: n[0], y: n[1] + 13 * s, label: label + (alert ? ' · ' + word(WORKER_WORD, d.state) : ''), rank: alert ? 3 : d.kind === 'lead' ? 2 : 1,
        o: { cls: 'of-tag', act: act, key: d.id, alts: TAG_AT.concat(TAG_MORE).map(function (t) { return [r1(t[0] * s), r1(t[1] * s)]; }), h: 19, rx: 8, fs: 12.5, fill: '#0e1528', stroke: alert ? '#ff5a7a' : '#34446e', color: '#e6ebf5' } });
    }
    // its face, for the labels to keep off (a strolling lounge cat's whole round)
    var roam = lounge && d.pose === 'idle' && !c.z ? 10 : 0;
    found.faces.push({ face: d.id, x0: foot.x - size / 2 - roam, x1: foot.x + size / 2 + roam, y0: top, y1: top + size + (roam ? 12 : 0) });
    if (d.pose === 'rest' && !rec.z) { rec.z = el('text', { class: 'of-z', 'font-size': 13, 'font-weight': 700, fill: '#8fb0ff' }, rec.walk); rec.z.textContent = 'z'; }
    if (d.pose !== 'rest' && rec.z) { drop(rec.z); rec.z = null; }
    if (rec.z) { put(rec.z, 'x', r1(foot.x + size * .3)); put(rec.z, 'y', r1(top + 4)); }
    if (!pub && d.bubble) {
      found.bubbles.push({ id: d.id, x: foot.x, y: top - 20 * s, label: cut(d.bubble, 12.5, 176), rank: d.state === 'working' ? 2 : 1,
        o: { cls: 'of-bub', act: act, key: d.id, alts: BUBBLE_AT, h: 23, rx: 8, fs: 12.5, fill: '#0f1834', stroke: alert ? '#ff5a7a' : d.state === 'waiting' ? '#ffcf5a' : '#3d6ef0', color: '#e6ebf5', tail: 1 } });
    }
  }

  // lounge cats sit close (two side by side on the sofa, more in front of it): their hit boxes never overlap each other or
  // a desk's, and each keeps TAP scene units each way where it can (44 px on a phone). Two lounge boxes that overlap meet
  // halfway between their middles, along x or along y; a box cut on only one side of an axis grows back to TAP from its
  // other side. Of the ways to pick those axes (up to 8 overlapping pairs), the one that keeps every box TAP each way and
  // clear of the others and of the desks wins, the one that keeps most of each cat's own head first; with none (a crowded
  // lounge), each pair meets along the axis the two are farther apart along, so a click on a cat is never its neighbour's
  function hits(v) {
    var ls = [], lid = [], desks = [], pairs = [], best = null, id, n, t;
    for (id in v.units) if (v.units[id].hit) { ls.push(v.units[id]); lid.push(id); } else if (v.units[id].deskBox) desks.push(v.units[id].deskBox);
    ls.forEach(function (a, i) { for (var j = i + 1; j < ls.length; j++) if (cross(a.hitBox, ls[j].hitBox)) pairs.push([i, j]); });
    for (n = 0; pairs.length <= 8 && n < 1 << pairs.length; n++) if ((t = carve(ls, pairs, n, desks)) && (!best || t.score > best.score)) best = t;
    best = best || carve(ls, pairs, -1, null);
    // every hit rect, for the other cats' labels to keep off where they can
    v.hitBoxes = [];
    for (id in v.units) if (v.units[id].deskBox) v.hitBoxes.push(Object.assign({ face: id, lvl: 2 }, v.units[id].deskBox));
    ls.forEach(function (a, i) { var c = best.boxes[i]; v.hitBoxes.push({ face: lid[i], lvl: 2, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 }); put(a.hit, 'x', r1(c.x0)); put(a.hit, 'y', r1(c.y0)); put(a.hit, 'width', r1(c.x1 - c.x0)); put(a.hit, 'height', r1(c.y1 - c.y0)); });
  }
  function cross(p, q) { return p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1; }
  function middleOf(b) { return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; }
  // the lounge boxes with overlapping pair k split along y when bit k of axes is set, else along x (axes -1: along the axis
  // the two are farther apart along); with desks, every box grows back to TAP where it can and is checked: null when one
  // stays under TAP or overlaps another box or a desk, else its score (how much of each cat's head its own box holds)
  function carve(ls, pairs, axes, desks) {
    var boxes = ls.map(function (a) { var b = a.hitBox; return { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, cut: {} }; });
    pairs.forEach(function (p, k) {
      var pa = middleOf(ls[p[0]].hitBox), pb = middleOf(ls[p[1]].hitBox), ax = axes < 0 ? (Math.abs(pb.x - pa.x) >= Math.abs(pb.y - pa.y) ? 'x' : 'y') : axes >> k & 1 ? 'y' : 'x';
      var at = (pa[ax] + pb[ax]) / 2, lo = pb[ax] > pa[ax] ? boxes[p[0]] : boxes[p[1]], hi = lo === boxes[p[0]] ? boxes[p[1]] : boxes[p[0]];
      lo[ax + '1'] = Math.min(lo[ax + '1'], at);
      lo.cut[ax + '1'] = 1;
      hi[ax + '0'] = Math.max(hi[ax + '0'], at);
      hi.cut[ax + '0'] = 1;
    });
    if (!desks) return { boxes: boxes };
    var ok = boxes.every(function (b) {
      return ['x', 'y'].every(function (ax) {
        if (b[ax + '1'] - b[ax + '0'] >= TAP) return true;
        if (!b.cut[ax + '0']) b[ax + '0'] = b[ax + '1'] - TAP;
        else if (!b.cut[ax + '1']) b[ax + '1'] = b[ax + '0'] + TAP;
        else return false;
        return true;
      });
    }) && boxes.every(function (b, i) { return boxes.concat(desks).every(function (c, j) { return j === i || !cross(b, c); }); });
    return ok ? { boxes: boxes, score: boxes.reduce(function (s, b, i) { var h = ls[i].headBox; return s + Math.max(0, Math.min(b.x1, h.x1) - Math.max(b.x0, h.x0)) * Math.max(0, Math.min(b.y1, h.y1) - Math.max(b.y0, h.y0)); }, 0) } : null;
  }

  // ---- the boss cat (plan Must have 12): the owner's own cat, one per office; never a desk, a session or a count ---------
  // It stands on the shown floor's walk map (office-model.js walk: tiles of half a floor tile and the blocked ones) and
  // starts at the floor's spawn, the lounge door; another floor starts it there again. It moves a tile per step: the arrow
  // keys and W/A/S/D step it along the map's axes, and a click on the floor walks it the shortest way there (breadth first
  // over the free tiles). A step is one el.animate() of STEP ms on its .of-walk (FLIP, as travel()), and a walk's next step
  // starts from the last one's finished promise: no timer. me.tile is the last tile it reached, me.to the tile a step is
  // heading for, me.path the rest of a click walk. A new key or click ends a walk where it last arrived (a fresh key on a
  // key step finishes that step first; a held key's repeats wait for it), Escape ends it, and a step into a blocked tile
  // or a click on a tile it cannot reach is refused. Under reduced motion it is at once where it goes. Its place is page
  // state only: never stored, never sent.
  var STEP = 140, DIRS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], KeyD: [1, 0], KeyA: [-1, 0], KeyW: [0, -1], KeyS: [0, 1] };
  // its gold badge: the mockup's crown accessory (its ACC.crown) in the traced head's 0 0 100 100 box
  var CROWN = '38,19 36,7 43,12 50,3 57,12 64,7 62,19';
  function tileSize(v) { return GX / v.walk.w; }
  function free(v, x, y) { return x >= 0 && y >= 0 && x < v.walk.w && y < v.walk.h && !has(v.off, y * v.walk.w + x); }
  // the middle of walk tile t on the scene: where the boss's feet go
  function footOf(v, t) {
    var w = v.walk.w, s = tileSize(v), x = t % w, p = iso((x + .5) * s, ((t - x) / w + .5) * s);
    return { x: r1(p[0]), y: r1(p[1]), k: 1 };
  }
  function drawMe(v, t) {
    var f = footOf(v, t);
    put(v.me.pos, 'transform', 'translate(' + f.x + ',' + f.y + ') scale(1)');
  }
  // a phone's pan frame keeps the boss in view: when its floor is drawn (at once) and whenever it reaches a tile (smoothly,
  // at once under reduced motion) the frame scrolls just enough to hold its drawing a cat's width inside the edge; a hand
  // pan in between is the owner's. The floor drawing and the step's own finish call it: no timer
  function follow(v, first) {
    var pan = v.pan, m = v.walk && pan && pan.scrollWidth > pan.clientWidth + 1 && typeof v.svg.getScreenCTM === 'function' ? v.svg.getScreenCTM() : null;
    if (!m || typeof m.a !== 'number') return;
    var f = footOf(v, v.me.tile), r = pan.getBoundingClientRect(), pad = CAT * m.a;
    var x0 = m.a * (f.x - CAT / 2) + m.c * f.y + m.e, x1 = m.a * (f.x + CAT / 2) + m.c * f.y + m.e;
    var by = x0 < r.left + pad ? x0 - r.left - pad : x1 > r.right - pad ? x1 - r.right + pad : 0;
    if (by) panBy(pan, by, first || calm() ? 'instant' : 'smooth');
  }
  // a desk or cat that takes the focus (Tab) comes whole into a phone's pan frame at once: its hit rect, where its focus
  // ring is drawn, inside the frame's edge; one wholly inside keeps the frame
  function reveal(v, n) {
    var pan = v.pan, hit = n && n.querySelector('.of-hit');
    if (!hit || !(pan.scrollWidth > pan.clientWidth + 1)) return;
    var r = hit.getBoundingClientRect(), f = pan.getBoundingClientRect(), by = r.left < f.left ? r.left - f.left - 8 : r.right > f.right ? r.right - f.right + 8 : 0;
    if (by) panBy(pan, by, 'instant');
  }
  // the pan frame scrolled by `by` px within its range (scrollTo where the browser has it)
  function panBy(pan, by, how) {
    var to = Math.max(0, Math.min(pan.scrollWidth - pan.clientWidth, pan.scrollLeft + by));
    if (typeof pan.scrollTo === 'function') pan.scrollTo({ left: to, behavior: how });
    else pan.scrollLeft = to;
  }
  // its painter place: right after the last prop or desk near it (within NEAR floor tiles) that it stands in front of (its
  // middle beyond that thing's far x or y edge), from any of tiles; a step paints it from both ends, so it is drawn over
  // what it passes. Things farther off never overlap it, and their order says nothing about it
  var NEAR = 2;
  function paint(v, tiles) {
    var me = v.me, s = tileSize(v), w = v.walk.w, last = -1;
    v.order.forEach(function (it, i) {
      tiles.forEach(function (t) {
        var x = (t % w + .5) * s, y = (Math.floor(t / w) + .5) * s, r = it.r;
        if (x > r[0] - NEAR && x < r[2] + NEAR && y > r[1] - NEAR && y < r[3] + NEAR && (x >= r[2] || y >= r[3])) last = i;
      });
    });
    var ref = last + 1 < v.order.length ? v.order[last + 1].n : null, kids = Array.prototype.slice.call(v.depth.children), at = kids.indexOf(me.g);
    if (at < 0 || kids[at + 1] !== (ref || undefined)) v.depth.insertBefore(me.g, ref);
  }
  // ends its step or walk without a trace: the step's finished handler finds nothing of its own left
  function hush(me) {
    var a = me.anim;
    me.anim = null;
    me.to = null;
    me.path = null;
    if (a) a.cancel();
  }
  // ends a step or walk under way: the boss stays on the last tile it reached; -> where it showed (null when it stood)
  function stand(v) {
    var me = v.me, from = me.anim ? shown(me.walk, footOf(v, me.to)) : null, moving = !!me.anim;
    hush(me);
    if (moving) { drawMe(v, me.tile); paint(v, [me.tile]); stopped(v); }
    return from;
  }
  function stepTo(v, to, from) {
    var me = v.me, f0 = from || footOf(v, me.tile), f1 = footOf(v, to);
    paint(v, [me.tile, to]);
    drawMe(v, to);
    me.to = to;
    var a = me.anim = me.walk.animate([{ transform: 'translate(' + r1(f0.x - f1.x) + 'px,' + r1(f0.y - f1.y) + 'px)' }, { transform: 'none' }], { duration: STEP, easing: 'linear' });
    if (doc.hidden === true) a.pause();
    var end = function () { arrive(v, a); };
    a.finished.then(end, end);
  }
  // a step done: the boss is on its tile; a click walk goes on unless the office is no longer shown
  function arrive(v, a) {
    var me = v.me, rest = me.path;
    if (me.anim !== a) return;
    me.anim = null;
    me.tile = me.to;
    me.to = null;
    me.path = null;
    follow(v, false);
    if (rest && rest.length && doc.getElementById('office') === v.root) walk(v, rest, null, true);
    else { paint(v, [me.tile]); stopped(v); }
  }
  // walks path (walk tiles) a step at a time from where it shows (from), or is at its end at once under reduced motion
  function walk(v, path, from, click) {
    var me = v.me;
    if (calm() || typeof me.walk.animate !== 'function') {
      me.tile = path[path.length - 1];
      drawMe(v, me.tile);
      paint(v, [me.tile]);
      follow(v, false);
      stopped(v);
      return;
    }
    stepTo(v, path[0], from);
    me.path = click ? path.slice(1) : null;
  }
  // the shortest way (the four sides) from the boss's tile to tile goal: the tiles to step on, [] when it is there, null
  // when it cannot get there (a blocked tile, or one walled in); it looks at most at as many tiles as the walk map holds
  function way(v, goal) {
    var w = v.walk.w, start = v.me.tile, prev = {}, queue = [start], i, k;
    prev[start] = start;
    // never more tiles than the map holds: a walk map that lost its bounds ends the search instead of looping on
    for (i = 0; i < queue.length && i < w * v.walk.h; i++) {
      var at = queue[i], x = at % w, y = (at - x) / w;
      if (at === goal) {
        var path = [];
        for (k = at; k !== start; k = prev[k]) path.unshift(k);
        return path;
      }
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var n = (y + d[1]) * w + x + d[0];
        if (free(v, x + d[0], y + d[1]) && !has(prev, n)) { prev[n] = at; queue.push(n); }
      });
    }
    return null;
  }
  // the walk tile under the pointer, -1 off the floor
  function tileAt(v, ev) {
    var m = typeof v.svg.getScreenCTM === 'function' ? v.svg.getScreenCTM() : null, s = tileSize(v);
    if (!m || typeof ev.clientX !== 'number') return -1;
    m = m.inverse();
    var sx = m.a * ev.clientX + m.c * ev.clientY + m.e, sy = m.b * ev.clientX + m.d * ev.clientY + m.f;
    var u = (sx - OX) / KX, w = (sy - OY) / KY, x = Math.floor((u + w) / 2 / s), y = Math.floor((w - u) / 2 / s);
    return x >= 0 && y >= 0 && x < v.walk.w && y < v.walk.h ? y * v.walk.w + x : -1;
  }
  // a click on the floor: any walk ends, and the boss walks the shortest way to the clicked tile when it can get there
  function toward(v, ev) {
    var goal = tileAt(v, ev), from = stand(v), path = goal >= 0 ? way(v, goal) : null;
    if (path && path.length) walk(v, path, from, true);
  }
  // one tile toward d: a held key's repeat waits for the step under way, a fresh press finishes it first, a click walk
  // ends where it last arrived; a blocked tile refuses the step
  function keyStep(v, d, repeat) {
    var me = v.me, w = v.walk.w, from = null;
    if (me.anim && !me.path) {
      if (repeat) return;
      var to = me.to;
      from = shown(me.walk, footOf(v, to));
      hush(me);
      me.tile = to;
    } else if (me.anim) from = stand(v);
    var x = me.tile % w + d[0], y = Math.floor(me.tile / w) + d[1];
    if (free(v, x, y)) walk(v, [y * w + x], from, false);
    else if (from) { drawMe(v, me.tile); paint(v, [me.tile]); stopped(v); }
  }
  // the keys are the office's only while it is the view shown (its root in the page, not under the narrow sidebar
  // overlay) and the focus is in no text field (an input, textarea, select or contenteditable keeps its keys: the annotate
  // tray, the answer reply box, the search box, the talk dialog's own fields); never with Ctrl, Alt or Meta, never a key
  // another handler took. Escape closes the talk dialog; E, and Space or Enter while no control has the focus (the page,
  // the office region or the dialog itself has it), talk to the cat next to the boss
  function onKey(ev) {
    var root = doc.getElementById('office'), v = root && views.get(root), a = doc.activeElement, d = null, box = v && v.talk.el;
    if (!v || !v.walk || ev.defaultPrevented || ev.ctrlKey || ev.altKey || ev.metaKey || root.closest('[inert]')) return;
    if (a && (/^(?:input|textarea|select)$/i.test(a.tagName || '') || a.isContentEditable === true)) return;
    if (ev.key === 'Escape') { stand(v); if (box) { ev.preventDefault(); shut(v); } return; }
    if (has(DIRS, ev.key)) d = DIRS[ev.key];
    else if (has(DIRS, ev.code)) d = DIRS[ev.code];
    if (d) { ev.preventDefault(); keyStep(v, d, ev.repeat === true); return; }
    var talkKey = ev.code === 'KeyE' || ev.key === 'e' || ev.key === 'E' || ((ev.key === ' ' || ev.key === 'Enter') && (!a || a === doc.body || a === root || a === box));
    var id = talkKey ? g.BriefOffice.near(v.f, v.me.tile) : null;
    if (id === null) return;
    ev.preventDefault();
    stand(v);
    talkTo(v, id);
  }
  var keysOn = false;
  function watchKeys() {
    if (keysOn) return;
    keysOn = true;
    doc.addEventListener('keydown', onKey);
  }
  // the boss on the floor drawn now: a new floor starts it at its spawn; a changed walk map ends a walk that crosses a
  // tile it blocks now and takes the boss to the spawn if it blocks the boss's own tile; no floor, no boss
  function boss(v, f) {
    var me = v.me;
    if (!f) { hush(me); v.walk = null; drop(me.g); return; }
    var fresh = v.fresh;
    if (!me.g.parentNode) v.depth.appendChild(me.g);
    var key = f.walk.blocked.join(',');
    if (v.fresh || key !== v.walkKey) {
      v.walk = f.walk;
      v.walkKey = key;
      v.off = {};
      f.walk.blocked.forEach(function (k) { v.off[k] = 1; });
      me.home = f.spawn.y * f.walk.w + f.spawn.x;
      if (v.fresh || has(v.off, me.tile)) { hush(me); me.tile = me.home; }
      else if ([me.to].concat(me.path || []).some(function (t) { return t !== null && has(v.off, t); })) hush(me);
      v.fresh = false;
    }
    if (!me.anim) { drawMe(v, me.tile); paint(v, [me.tile]); }
    if (fresh) follow(v, true);
  }

  // ---- the talk dialog (plan Must have 13) ------------------------------------------------------------------------------
  // Talking: the boss on a tile next to a cat (office-model.js near()) plus E, Space or Enter (onKey), or a pointer click
  // on the cat's own drawing: a lounge cat, a desk cat's head (a keyboard click on a desk, the rest of a desk and a label
  // keep the open action). The dialog is the rail's first box, a section of the office region under the page root, so
  // page.js's delegated click handler serves its answer boxes and 새로 보내기, and shell.js its 대화 열기 (the open
  // action). Its data is office-model.js talk(): on the lead cat of the live board it lists the decisions to answer, each
  // with view.js's answer box (kit answerBox(d, s, ui, 'office'): pick, confirm, send and hold are page.js's), and when
  // the session takes annotations a note box whose 보내기 is page.js's ui.sendNote(sid, text). Every render patches it in
  // place and every annotate.js status() patches its note line (status()): a part whose content stays keeps its nodes,
  // so a typed note with its caret and a half-picked answer outlive a publish. Escape or 닫기 closes it and gives the
  // focus back to the office region; another floor and the cat or its conversation going away close it too. A typed note
  // is this page's memory only, per conversation until it went out: never stored, never sent by itself.
  var drafts = Object.create(null), sent = Object.create(null);
  // the kit's markup -> nodes, through a tag and attribute allowlist (kit() throws on anything else; kitBox() then draws
  // that one box as a line pointing to 대화 열기 and reports it, so a kit change never takes the office down): its text and
  // attribute values are decoded from the kit's escapes and go in as text nodes and through set(). An icon (<use
  // href="#i-x">) becomes a copy of the page sprite's own drawing of it, so set() writes no other href than #cat / #body
  var KIT_TAGS = { div: 1, p: 1, span: 1, b: 1, q: 1, button: 1, textarea: 1, label: 1, input: 1, fieldset: 1, legend: 1, select: 1, option: 1, svg: 0, use: 0 };
  var KIT_ATTRS = /^(?:class|role|type|id|name|value|for|rows|maxlength|min|max|step|inputmode|placeholder|checked|selected|focusable|aria-[a-z]+|data-(?:ans|act|opt|id|where|draft|field))$/;
  var ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unesc(t) {
    return t.replace(/&(?:([a-z]+)|#(\d+)|#x([0-9a-f]+));/gi, function (all, name, dec, hex) {
      return name ? (has(ENTITY, name) ? ENTITY[name] : all) : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16));
    });
  }
  function kit(html) {
    var top = { kids: [] }, stack = [top], re = /<(\/?)([a-z]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>|([^<]+)/g, m, end = 0;
    var bad = function (why) { throw new Error('office answer box: ' + why); };
    while ((m = re.exec(html))) {
      if (m.index !== end) bad('stray markup');
      end = re.lastIndex;
      var at = stack[stack.length - 1], tag = m[2];
      if (m[4] !== undefined) { at.kids.push({ text: unesc(m[4]) }); continue; }
      if (m[1]) { if (stack.length < 2 || stack.pop().tag !== tag) bad('unbalanced </' + tag + '>'); continue; }
      if (!has(KIT_TAGS, tag)) bad('<' + tag + '> is not allowed');
      var node = { tag: tag, attrs: [], kids: [] };
      m[3].replace(/([a-z-]+)(?:="([^"]*)")?/g, function (all, k, val) {
        if (!(tag === 'use' && k === 'href') && !KIT_ATTRS.test(k)) bad(k + ' is not allowed');
        node.attrs.push([k, unesc(val || '')]);
        return '';
      });
      at.kids.push(node);
      if (tag !== 'input') stack.push(node);
    }
    if (stack.length !== 1 || end !== html.length) bad('unbalanced');
    return top.kids;
  }
  function kitNode(node, parent) {
    if (has(node, 'text')) { parent.appendChild(doc.createTextNode(node.text)); return; }
    if (node.tag === 'use') { glyph(parent, node.attrs); return; }
    var n = el(node.tag, null, parent, KIT_TAGS[node.tag] === 1);
    node.attrs.forEach(function (a) { set(n, a[0], a[1]); });
    node.kids.forEach(function (k) { kitNode(k, n); });
  }
  function glyph(svg, attrs) {
    var ref = attrs.length === 1 && attrs[0][0] === 'href' ? attrs[0][1] : '', sym = /^#i-[a-z0-9-]+$/.test(ref) ? doc.getElementById(ref.slice(1)) : null;
    if (!sym || sym.parentNode !== doc.getElementById('icon-sprite')) return;
    set(svg, 'viewBox', sym.getAttribute('viewBox'));
    Array.prototype.forEach.call(sym.childNodes, function (k) { svg.appendChild(k.cloneNode(true)); });
  }
  // a control's kind inside one answer box: what keeps the focus when the box is drawn again
  function ctlKey(n) { return [n.tagName, n.getAttribute('data-act'), n.getAttribute('data-opt'), n.getAttribute('data-field'), n.getAttribute('type') === 'radio' ? n.getAttribute('value') : ''].join('|'); }
  // a decision's answer box is drawn again only when the kit's markup for it changed; the control that had the focus gets
  // it back in the new box (the same kind) with its caret, else the box's 취소 (as page.js region() does)
  function kitBox(ask, html) {
    if (ask.html === html) return;
    var a = doc.activeElement, key = a && a !== ask.box && ask.box.contains(a) ? ctlKey(a) : null, sel = key && [a.selectionStart, a.selectionEnd, a.selectionDirection], nodes = null;
    try { nodes = kit(html); } catch (e) { if (g.console && g.console.warn) g.console.warn('[omo-briefing] office answer box', e); }
    ask.html = html;
    ask.box.textContent = '';
    if (!nodes) { h('p', 'of-empty', ask.box, '이 결정은 여기서 답할 수 없어요 · 대화 열기에서 답해 주세요'); return; }
    nodes.forEach(function (n) { kitNode(n, ask.box); });
    if (key === null) return;
    var all = ask.box.querySelectorAll('button,input,select,textarea'), to = null;
    for (var i = 0; i < all.length && !to; i++) if (ctlKey(all[i]) === key) to = all[i];
    to = to || ask.box.querySelector('[data-act="ans-cancel"]');
    if (!to) return;
    to.focus({ preventScroll: true });
    if (typeof sel[0] === 'number' && typeof to.setSelectionRange === 'function') to.setSelectionRange(sel[0], sel[1], sel[2] || undefined);
  }
  function sessionOf(vm, sid) { return arr(vm && vm.sessions).filter(function (x) { return x && str(x.id) === sid; })[0] || null; }
  function talkBox(v, m) {
    var b = el('section', { class: 'of-talk', tabindex: -1 }, null, true), head = h('div', 'of-tk-head', b);
    el('use', { href: '#cat' }, el('svg', { class: 'of-tk-face', viewBox: '0 0 100 100', 'aria-hidden': 'true' }, head));
    var who = h('div', 'of-tk-who', head);
    v.talk.parts = { name: h('h3', 'of-tk-name', who), where: h('p', 'of-tk-where', who), state: h('span', '', head), info: el('dl', { class: 'of-tk-info' }, b, true), asks: null, note: null };
    el('button', { type: 'button', class: 'of-tk-x' }, head, true).textContent = '닫기';
    v.talk.parts.foot = h('div', 'of-tk-foot', b);
    el('button', { type: 'button', class: 'of-tk-open', 'data-sh': 'open', 'data-sid': m.sid, 'data-sub': m.sub || null }, v.talk.parts.foot, true).textContent = '대화 열기';
    return b;
  }
  function infoRow(it) {
    var r = el('div', { 'data-k': it.key }, null, true);
    h('dt', '', r, it.label);
    h('dd', '', r, it.text);
    return r;
  }
  // the decisions to answer, keyed by id: a row keeps its nodes while its decision stays listed
  function drawAsks(v, m, s) {
    var t = v.talk, p = t.parts, old = t.asks, next = {};
    if (m.asks.length && !p.asks) p.asks = t.el.insertBefore(el('div', { class: 'of-tk-asks', role: 'group', 'aria-label': '답할 결정' }, null, true), p.note ? p.note.el : p.foot);
    var list = m.asks.map(function (id) {
      var key = String(id), d = arr(s.decisions).filter(function (x) { return x && x.id === id; })[0], ask = has(old, key) ? old[key] : null, q = str(d.question);
      if (!ask) {
        ask = { row: el('div', { class: 'of-tk-ask', 'data-ask': key }, null, true), q: null, box: null, qt: null, html: null };
        ask.q = h('p', 'of-tk-q', ask.row);
        ask.box = h('div', 'of-tk-kit', ask.row);
      }
      if (ask.qt !== q) { ask.q.textContent = ''; h('b', '', ask.q, '#' + key); ask.q.appendChild(doc.createTextNode(' ' + q)); ask.qt = q; }
      kitBox(ask, g.BriefView.kit.answerBox(d, s, v.ui, 'office'));
      next[key] = ask;
      return ask.row;
    });
    for (var k in old) if (!has(next, k)) drop(old[k].row);
    t.asks = next;
    if (p.asks && list.length) order(p.asks, list);
    if (p.asks && !list.length) { drop(p.asks); p.asks = null; }
  }
  function drawNote(v, m) {
    var p = v.talk.parts, n = p.note;
    if (!m.note) { if (n) drop(n.el); p.note = null; return; }
    if (!n) {
      n = p.note = { el: h('div', 'of-tk-note', null), msg: null, renew: null };
      var lb = el('label', { class: 'of-tk-lb' }, n.el, true);
      h('span', '', lb, '이 대화에 메모 보내기');
      n.ta = el('textarea', { class: 'of-tk-ta', rows: 3, maxlength: g.BriefAnnotate.limits.text }, lb, true);
      n.ta.value = has(drafts, m.sid) ? drafts[m.sid] : '';
      n.acts = h('div', 'of-tk-acts', n.el);
      n.send = el('button', { type: 'button', class: 'of-tk-send' }, n.acts, true);
      n.send.textContent = '보내기';
      v.talk.el.insertBefore(n.el, p.foot);
    }
    noteLine(v);
  }
  // the note line and 보내기 follow annotate.js's status line of the conversation, in the tray's own words: 보내는 중…
  // with 보내기 off, 보냄 · 전달 상태 기다리는 중…, the conflict line beside 새로 보내기 (page.js's data-act="ann-new")
  function noteLine(v) {
    var t = v.talk, n = t.parts.note, A = g.BriefAnnotate, m = A.message(t.sid), text = m && typeof m === 'object' ? str(m.text) : str(m), conflict = !!(m && m.conflict);
    if (text && !n.msg) n.msg = n.acts.insertBefore(h('p', 'of-tk-msg', null), n.acts.firstChild);
    if (!text && n.msg) { drop(n.msg); n.msg = null; }
    if (n.msg) { txt(n.msg, text); put(n.msg, 'role', m.sending || m.ok ? 'status' : 'alert'); }
    if (conflict && !n.renew) { n.renew = n.acts.insertBefore(el('button', { type: 'button', class: 'of-tk-new', 'data-act': 'ann-new', 'data-sid': t.sid }, null, true), n.send); n.renew.textContent = '새로 보내기'; }
    if (!conflict && n.renew) {
      var focused = doc.activeElement === n.renew;
      drop(n.renew);
      n.renew = null;
      if (focused) n.ta.focus({ preventScroll: true });
    }
    n.send.disabled = A.sending(t.sid) || !n.ta.value.trim();
  }
  function sendNote(v) {
    var t = v.talk, n = t.parts.note, text = n ? n.ta.value.trim() : '', A = g.BriefAnnotate;
    if (!text || A.sending(t.sid)) return;
    drafts[t.sid] = n.ta.value;
    v.ui.sendNote(t.sid, text);
    if (A.sending(t.sid)) sent[t.sid] = text;
    noteLine(v);
  }
  // the dialog of the cat talked to, from the scene and view model drawn now; the focus it had stays in it
  function drawTalk(v, f) {
    var t = v.talk;
    if (t.id === null) return;
    var m = f && f.sid === t.sid ? g.BriefOffice.talk(v.vm, v.ui, v.scene, t.sid, t.id) : null;
    if (!m) { shut(v); return; }
    var a = doc.activeElement, had = !!(t.el && a && t.el.contains(a));
    if (!t.el) t.el = v.rail.insertBefore(talkBox(v, m), v.rail.firstChild);
    var p = t.parts;
    put(t.el, 'aria-label', ['말 걸기', m.role, m.name].filter(Boolean).join(' · '));
    txt(p.name, m.role + ' · ' + (ROOM_NAME[m.room] || ''));
    facts(p.where, [m.n + '층', m.title || '(제목 없음)', m.name].filter(Boolean));
    txt(p.state, m.state);
    put(p.state, 'class', 'of-st is-' + m.tone);
    rows(v, 'talk', p.info, [['step', '하는 일', m.step], ['headline', '지금', m.headline], ['next', '다음', m.next], ['todo', '할 일', m.todo], ['open', '결정', m.open ? m.open + '건 기다림' : '없음']]
      .filter(function (r) { return r[2]; }).map(function (r) { return { key: r[0], label: r[1], text: r[2] }; }), infoRow);
    drawAsks(v, m, sessionOf(v.vm, m.sid));
    drawNote(v, m);
    if (had && !t.el.contains(doc.activeElement)) t.el.focus({ preventScroll: true });
  }
  // talks to cat id of the floor shown: its dialog opens (another cat's closes first) and takes the focus
  function talkTo(v, id) {
    var t = v.talk;
    if (!(t.el && t.id === id && t.sid === v.sid)) {
      shut(v);
      t.id = id;
      t.sid = v.sid;
      drawTalk(v, v.f);
      quiet(v);
    }
    if (t.el) t.el.focus();
  }
  // with a dialog open, the floor card's 대화 열기 takes the outline look the dialog's has: one filled 대화 열기 at most
  function quiet(v) { var b = v.cardParts && v.cardParts.open; if (b) put(b, 'class', v.talk.el ? 'of-open is-quiet' : 'of-open'); }
  function shut(v) {
    var t = v.talk, a = doc.activeElement, had = !!(t.el && a && t.el.contains(a));
    drop(t.el);
    t.el = t.parts = t.id = t.sid = null;
    t.asks = {};
    delete v.rows.talk;
    quiet(v);
    if (had) v.root.focus({ preventScroll: true });
  }
  // the cat under a pointer click: a lounge cat's whole drawing, a desk cat's head; null on its desk or anything else
  function catAt(v, ev) {
    var u = ev.target.closest('[data-desk]'), id = u && u.getAttribute('data-desk'), rec = id !== null && has(v.units, id) ? v.units[id] : null;
    if (!rec || rec.g !== u) return null;
    if (!rec.slide) return id;
    // a touch screen talks from a head-centred box of at least 44 px (a phone's scene draws a head at about 33)
    var r = rec.head.getBoundingClientRect(), pad = g.matchMedia && g.matchMedia('(pointer: coarse)').matches ? Math.max(0, (44 - Math.min(r.width, r.height)) / 2) : 0;
    return ev.clientX >= r.left - pad && ev.clientX <= r.right + pad && ev.clientY >= r.top - pad && ev.clientY <= r.bottom + pad ? id : null;
  }
  // annotate.js status() of conversation sid, through page.js's status hook: a note sent from here leaves its box once it
  // went out (the line says 보냄), and an open dialog of sid shows the new line
  function status(sid) {
    var m = g.BriefAnnotate.message(sid), root = doc.getElementById('office'), v = root && views.get(root), t = v && v.talk;
    if (has(sent, sid) && m && !m.sending) {
      if (m.ok === true && has(drafts, sid) && drafts[sid].trim() === sent[sid]) {
        drafts[sid] = '';
        if (t && t.sid === sid && t.parts.note) t.parts.note.ta.value = '';
      }
      delete sent[sid];
    }
    if (t && t.sid === sid && t.parts.note) noteLine(v);
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
    v.units = {}; v.pills = {}; v.boxes = []; v.floor = sid; v.fresh = true;
  }
  // the belt: one box per plan wave (done / current / to come, the mockup's three box colours) that office.css moves along
  // its own slot, and the back-wall screen with the plan's progress
  function drawBelt(v, f) {
    var conv = f && f.conveyor, waves = conv ? arr(conv.waves) : [], belt = [];
    var boxes = tree('conveyor', g.BriefOfficeArt.props.conveyor)[0].kids.slice(2, 5);
    var step = waves.length > 1 ? Math.min(3, 15.2 / (waves.length - 1)) : 3;
    waves.forEach(function (w, i) {
      // a done wave takes the rest tone (office.css .of-done: --c-gray; green is a working cat's), the current one blue
      var tone = i < conv.current || conv.current < 0 ? 0 : i === conv.current ? 1 : 2, x = 1.8 + i * step, ink = ['#8b97b3', '#7aa2ff', '#8b97b3'][tone];
      var b = v.boxes[i] || (v.boxes[i] = { g: el('g', null, v.dyn), tone: -1 });
      put(b.g, 'transform', move(i * step - [0, 3, 6][tone], 0));
      put(b.g, 'class', tone ? 'of-crate' : 'of-crate of-done');
      if (b.tone !== tone) { b.g.textContent = ''; build(boxes[tone], b.g); b.tone = tone; }
      var p = iso(x + step / 2, 5.6, 8);
      belt.push({ id: i, x: p[0], y: p[1] - 26, label: (w.n || i + 1) + '단계' + (tone === 0 ? ' ✓' : tone === 1 ? ' ●' : ''), rank: tone === 1 ? 2 : tone === 0 ? 1 : 0,
        o: { cls: tone ? 'of-wave' : 'of-wave of-done', alts: BELT_AT.concat(BELT_MORE), span: 29.5 * step / 2, h: 18, rx: 9, fs: 11.5, fill: '#0e1528', stroke: ink, color: ink } });
    });
    v.boxes.splice(waves.length).forEach(function (b) { drop(b.g); });
    var cur = conv && conv.current >= 0 ? waves[conv.current] : null;
    var lines = !conv ? [] : [cur ? '계획 ' + (cur.n || conv.current + 1) + '단계 진행 중' : '계획 단계 모두 끝', cur ? '상자 ' + cur.done + '/' + cur.total + ' 끝' : '상자 ' + waves.length + '단계',
      // the label ends 96 units into the screen: left of where the floor picker starts over the narrowest wide stage
      cur ? cut(str(cur.label), 11, 96) : ''];
    v.wall.forEach(function (t, i) { txt(t, lines[i] || ''); });
    return belt;
  }
  // the left wall's screen: the whole office now (the mockup's 오늘의 사무실 screen, with the board's own counts)
  function drawStats(v) {
    var sc = v.scene, dec = arr(sc.ceo && sc.ceo.items).filter(function (it) { return it.sub === 'dec'; }).length;
    var lines = ['사무실 전체', '층 ' + sc.floors.length + '개 · 작업자 ' + arr(sc.people).length + '명', dec ? '결정 대기 ' + dec + '건' : '결정 대기 없음'];
    v.wallL.forEach(function (t, i) { txt(t, cut(lines[i], 11, 128)); });
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
    var belt = drawBelt(v, f), cells = f ? layout(f) : {}, found = { tags: [], bubbles: [], faces: [] };
    var desks = f ? arr(f.desks).filter(function (d) { return has(cells, d.id); }) : [];
    desks.forEach(function (d) { deskUnit(v, f, d, cells[d.id], people, found, pub); });
    for (var id in v.units) if (v.units[id].pass !== v.pass) { gone(v.units[id]); delete v.units[id]; }
    hits(v);
    // the mockup's painter order by x + y: the props never move, and a desk moves in it only when its place changed
    // (r: what each stands on, in floor tiles, for the boss cat's place among them; a lounge cat is about a tile wide)
    var items = v.props.concat(desks.map(function (d) {
      var c = cells[d.id];
      return { x: c.x, y: c.y, r: d.room === 'lounge' ? [c.x - .2, c.y - .2, c.x + .2, c.y + .2] : [c.x, c.y, c.x + 1.6 * c.s, c.y + c.s], n: v.units[d.id].g };
    }));
    items.sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
    order(v.depth, items.map(function (it) { return it.n; }));
    v.order = items;
    boss(v, f);
    var byRank = function (list) { return list.sort(function (a, b) { return b.rank - a.rank; }); };
    byRank(found.tags).forEach(function (t) { pill(v, labels, 'tag:' + t.id, t.x, t.y, t.label, t.o); });
    if (!pub) byRank(found.bubbles).forEach(function (t) { pill(v, labels, 'bub:' + t.id, t.x, t.y, t.label, t.o); });
    byRank(belt).forEach(function (t) { pill(v, labels, 'wave:' + t.id, t.x, t.y, t.label, t.o); });
    for (var k in v.pills) if (v.pills[k].pass !== v.pass) { drop(v.pills[k].g); delete v.pills[k]; }
    v.labels = labels;
    v.faces = found.faces;
    placeLabels(v);
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
    // the floor shown: a check besides the pressed wash, so it never looks like a hovered row
    if (it.on) glyph(el('svg', { class: 'ic of-on', 'aria-hidden': 'true', focusable: 'false' }, b), [['href', '#i-check']]);
    return b;
  }
  // the picker's toggle (shown narrow only, office.css): the floor shown, and whether the folded list is open
  function drawToggle(v, f) {
    var t = v.ftog, p = v.ftogParts, title = f ? f.label || '(제목 없음)' : '층 없음';
    put(t, 'aria-expanded', v.pickOpen ? 'true' : 'false');
    put(t, 'aria-label', '층 고르기 · ' + (f ? floorNo(v, f) + 'F · ' : '') + title);
    put(v.picker, 'class', 'of-floors' + (v.pickOpen ? ' is-open' : ''));
    put(p.no, 'class', f ? 'of-no' : 'of-no is-none');
    txt(p.no, f ? floorNo(v, f) + 'F' : '');
    txt(p.ft, title);
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
        if (!f) { h('p', 'of-empty', v.card, '대화를 시작하면 그 대화가 한\u00a0층이 돼요'); return; }
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
      facts(c.meta, [floorWord(f), '작업자 ' + (desks.length - 1) + '명', working ? '일하는 중 ' + working : '', dec ? '결정 ' + dec + '건 대기' : ''].filter(Boolean));
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
    watchKeys();
    root.textContent = '';
    // the region takes the focus back from a closed talk dialog
    set(root, 'tabindex', '-1');
    var v = { root: root, sid: null, keys: {}, units: {}, pills: {}, boxes: [], rows: {}, pass: 0, floor: undefined, dim: null, noFloor: null, cardParts: null,
      walk: null, walkKey: null, off: {}, order: [], fresh: true, f: null, talk: { id: null, sid: null, el: null, parts: null, asks: {} } };
    // .of-pan: nothing of its own wide (display: contents); narrow, the scene's frame; on a phone, the scene pans sideways
    var body = h('div', 'of-body', root), stage = h('div', 'of-stage', body), pan = h('div', 'of-pan', stage);
    v.pan = pan;
    v.svg = el('svg', { class: 'of-scene', viewBox: '30 0 1000 700', preserveAspectRatio: 'xMidYMid meet', role: 'group' }, pan);
    set(base(v.svg), 'aria-hidden', 'true');
    // on the frame, not the svg: a focus listener on an svg element makes Chrome give the svg a Tab stop of its own
    pan.addEventListener('focusin', function (ev) { reveal(v, ev.target.closest('[data-desk]')); });
    v.dyn = el('g', { class: 'of-l-belt', 'aria-hidden': 'true' }, v.svg);
    var c0 = iso(4, 0, 100);
    v.wall = [0, 1, 2].map(function (i) { return el('text', { transform: 'translate(' + r1(c0[0] + 10) + ',' + r1(c0[1] + 20 + i * 15) + ') skewY(30)', 'font-size': 11, fill: i ? '#8fb0ff' : '#ffcf5a' }, v.dyn); });
    // the left wall's screen leans the other way: its lines start as far under its top edge as the back wall's do
    var c1 = iso(0, 9, 100);
    v.wallL = [0, 1, 2].map(function (i) { return el('text', { transform: 'translate(' + r1(c1[0] + 10) + ',' + r1(c1[1] + 8.5 + i * 15) + ') skewY(-30)', 'font-size': 11, fill: i ? '#8fb0ff' : '#ffcf5a' }, v.dyn); });
    v.depth = el('g', { class: 'of-l-depth' }, v.svg);
    // the props and the boss's desk are drawn once, where the mockup drew them; the desks are sorted in between
    v.props = FURN.map(function (fu) { return { x: fu.r[0], y: fu.r[1], r: fu.r, n: art(fu.art, v.depth, fu.at ? move(fu.at[0], fu.at[1]) : null) }; });
    var desk = el('g', { class: 'of-boss', transform: move(BOSS[0], BOSS[1]) }, v.depth);
    art('desk', desk);
    v.boss = {};
    monitor(v.boss, desk);
    v.props.push({ x: BOSS[0], y: BOSS[1], r: BOSS, n: desk });
    // the boss cat with its crown, placed on the first floor drawn (boss())
    var me = cat(el('g', { class: 'of-me', 'aria-hidden': 'true' }, v.depth));
    el('polygon', { points: CROWN, fill: '#ffcf5a' }, me.head);
    v.me = { g: me.walk.parentNode, walk: me.walk, pos: me.pos, tile: -1, to: null, path: null, anim: null };
    v.top = el('g', { class: 'of-l-top', 'aria-hidden': 'true' }, v.svg);
    v.head = h('div', 'of-head', stage);
    h('h2', 'of-title', v.head, '사무실');
    v.pub = el('button', { type: 'button', class: 'of-pub', role: 'switch', 'aria-checked': 'false', 'data-act': 'office-public', title: '말풍선, 탭 이름, 작업 폴더를 숨겨요' }, v.head, true);
    el('span', { class: 'of-sw', 'aria-hidden': 'true' }, v.pub, true);
    h('span', '', v.pub, '공개 모드');
    v.picker = el('nav', { class: 'of-floors', 'aria-label': '층 고르기' }, stage, true);
    v.ftog = el('button', { type: 'button', class: 'of-ftog', 'aria-expanded': 'false', 'aria-controls': 'of-flist' }, v.picker, true);
    v.ftogParts = { no: h('span', 'of-no', v.ftog), ft: h('span', 'of-ft', v.ftog), fs: h('span', 'of-fs', v.ftog, '층 고르기') };
    glyph(el('svg', { class: 'ic', 'aria-hidden': 'true', focusable: 'false' }, v.ftog), [['href', '#i-chevron-down']]);
    v.pickOpen = false;
    h('h3', '', v.picker, '층 고르기 · 대화 1개 = 1층');
    v.flist = el('div', { class: 'of-flist', id: 'of-flist' }, v.picker, true);
    // in reading order before the scene: narrow, they are the rows above it
    stage.insertBefore(v.head, pan);
    stage.insertBefore(v.picker, pan);
    v.card = h('div', 'of-card', stage);
    v.rail = h('div', 'of-rail', body);
    v.box = { todo: section(v.rail, '대표님 할 일', 'ul', true), alert: section(v.rail, '알림', 'ul', true), people: section(v.rail, '사무실 사람들', 'ul', true), log: section(v.rail, '활동 로그', 'ol', false) };
    // the overlays keep their CSS size while the scene scales, so a new stage size settles the labels again
    if (typeof g.ResizeObserver === 'function') new g.ResizeObserver(function () { stopped(v); }).observe(stage);
    root.addEventListener('click', function (ev) {
      var n = ev.target && ev.target.closest ? ev.target : null, t = n ? n.closest('[data-floor]') : null, id = null;
      if (n && n.closest('.of-ftog')) { v.pickOpen = !v.pickOpen; drawToggle(v, v.f); return; }
      // a floor chosen in the folded list folds it and gives its focus to the toggle; wide, the list stays as it is
      if (t && root.contains(t)) {
        var had = doc.activeElement === t;
        v.sid = t.getAttribute('data-floor');
        v.pickOpen = false;
        draw(v);
        if (had && typeof v.ftog.getClientRects === 'function' && v.ftog.getClientRects().length) v.ftog.focus({ preventScroll: true });
        return;
      }
      // the dialog's own two buttons; its other buttons are page.js's and shell.js's
      if (n && v.talk.el && v.talk.el.contains(n)) {
        if (n.closest('.of-tk-x')) shut(v);
        else if (n.closest('.of-tk-send')) sendNote(v);
        return;
      }
      // a pointer click on a cat talks to it (no open action); the floor walks the boss there; a desk or a label with the
      // open action keeps its own click
      if (n && v.walk && ev.detail > 0 && (id = catAt(v, ev)) !== null) { ev.stopPropagation(); stand(v); talkTo(v, id); return; }
      if (v.walk && n && n.closest('[data-sh],.of-scene') === v.svg) toward(v, ev);
    });
    // the note box: typing goes to the page's memory and turns 보내기 on or off
    root.addEventListener('input', function (ev) {
      var t = v.talk, n = t.parts && t.parts.note;
      if (!n || ev.target !== n.ta) return;
      drafts[t.sid] = n.ta.value;
      n.send.disabled = g.BriefAnnotate.sending(t.sid) || !n.ta.value.trim();
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
    v.f = f;
    var floors = JSON.stringify(sc.floors.map(function (x) { return [x.sid, x.label, x.live, x.dark, decisionsOf(sc, x.sid)]; }));
    var pub = v.ui.publicMode === true, place = f && !pub ? placeOf(v.vm, f.sid) : '';
    put(v.pub, 'aria-checked', pub ? 'true' : 'false');
    drawToggle(v, f);
    drawStats(v);
    part(v, 'picker', floors + '|' + v.sid, function () { drawPicker(v, f); });
    part(v, 'card', JSON.stringify([f, floors, place]), function () { drawCard(v, f, place); });
    part(v, 'floor', JSON.stringify([f, sc.people.filter(function (p) { return f && p.sid === f.sid; }), sc.ceo && sc.ceo.count, pub, floors]), function () {
      keepFocus(v.depth, 'data-desk', function () { drawFloor(v, f); });
    });
    part(v, 'rail', JSON.stringify([f, sc.ceo, sc.alerts, sc.people, sc.log, pub, floors]), function () { drawRail(v, f); });
    drawTalk(v, f);
    quiet(v);
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
  g.BriefOfficeView = { render: render, layout: layout, visibility: visibility, status: status };
})(typeof globalThis !== 'undefined' ? globalThis : this);
