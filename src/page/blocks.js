/* omo-briefing report blocks (C-REPORT blocks): pure, esc() on every model string; convo-view.js calls render(). */
(function (g) {
  'use strict';

  var KIND = { table: '표', bars: '막대 그래프', kv: '항목', flow: '단계 흐름', checklist: '확인 목록', compare: '선택지 비교' };
  var STATE = { done: '끝', doing: '진행 중', todo: '할 일', blocked: '막힘' };

  // integers exact, the rest 15 digits: |v| < 2^52, so finite
  function str(v) { return typeof v === 'string' ? v : isNum(v) ? String(Number.isInteger(v) ? v : +v.toPrecision(15)) : ''; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function own(o, k) { return o && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function kit() { return g.BriefView.kit; }
  function esc(v) { return kit().esc(v); }
  function each(list, fn) { return list.map(fn).join(''); }
  function checkKey(sid, rid, id) { return 'omo-briefing.check.' + sid + '.' + rid + '.' + id; }
  function checkCount(n, total) { return n + '/' + total + ' 확인 · 이 브라우저에만\u00a0저장'; }

  function table(b) {
    var cols = arr(b.columns).map(str), rows = arr(b.rows).filter(Array.isArray);
    var right = cols.map(function (c, i) { return rows.length > 0 && rows.every(function (r) { return isNum(r[i]); }); });
    return { meta: rows.length + '줄', html: '<div class="rbk-scroll"><table class="t rbk-tbl"><thead><tr>' + each(cols, function (c, i) {
      return '<th scope="col"' + (right[i] ? ' class="num"' : '') + '>' + esc(c) + '</th>';
    }) + '</tr></thead><tbody>' + each(rows, function (r) {
      return '<tr>' + each(cols, function (c, i) { return '<td' + (isNum(r[i]) ? ' class="num"' : '') + ' data-label="' + esc(c) + '">' + esc(str(r[i])) + '</td>'; }) + '</tr>';
    }) + '</tbody></table></div>' };
  }

  function bars(b) {
    var unit = str(b.unit), items = arr(b.items).filter(function (it) { return obj(it) && isNum(it.value) && it.value >= 0; });
    var max = items.reduce(function (m, it) { return Math.max(m, it.value); }, 0);
    return { meta: unit ? '단위 ' + unit : '', html: '<ul class="bars">' + each(items, function (it) {
      var pct = it.value > 0 ? Math.max(0.5, Math.round(it.value / max * 1000) / 10) : 0;
      return '<li class="bar-r' + (it.value > 0 && it.value === max ? ' is-max' : '') + '"><span class="bar-l">' + esc(it.label) + '</span>' +
        '<svg class="bar-s" width="100%" height="10" aria-hidden="true"><rect class="bar-bg" width="100%" height="10" rx="2"></rect>' +
        (pct ? '<rect class="bar-v" width="' + pct + '%" height="10" rx="2"></rect>' : '') + '</svg><span class="bar-n">' + esc(str(it.value) + (unit ? ' ' + unit : '')) + '</span></li>';
    }) + '</ul>' };
  }

  function kv(b) {
    return { meta: '', html: '<dl class="rbk-kvl">' + each(arr(b.items).filter(obj), function (it) { return '<dt>' + esc(it.key) + '</dt><dd>' + esc(it.value) + '</dd>'; }) + '</dl>' };
  }

  // flowSvg while every label fits a box (14 characters), its doing/blocked steps named in the caption; else (and below
  // 600 px) native step nodes, the state a word on each
  function flow(b) {
    var steps = arr(b.steps).filter(obj).map(function (s) { return { label: str(s.label), state: own(STATE, s.state) ? s.state : 'todo' }; });
    var svg = steps.length > 0 && steps.every(function (s) { return Array.from(s.label).length <= 14; });
    function named(k) { return steps.filter(function (s) { return s.state === k; }).map(function (s) { return s.label; }); }
    var meta = named('done').length + '/' + steps.length + ' 끝';
    if (svg) ['doing', 'blocked'].forEach(function (k) { if (named(k).length) meta += ' · ' + STATE[k] + ': ' + named(k).join(', '); });
    return { meta: meta,
      html: (svg ? '<div class="flowbox" role="img" aria-label="' + esc('단계 흐름: ' + steps.map(function (s) { return s.label; }).join(', ') + ' (' + meta + ')') + '">' +
        kit().flowSvg(steps, false) + '</div>' : '') +
        '<ol class="flow-steps' + (svg ? '' : ' fs-all') + '">' + each(steps, function (s, i) {
          return '<li class="fs-' + s.state + '"><span class="fs-n">' + (i + 1) + '</span><span class="fs-t">' + esc(s.label) + '</span>' +
            (s.state === 'todo' ? '' : '<span class="fs-s">' + STATE[s.state] + '</span>') + '</li>';
        }) + '</ol>' };
  }

  function checklist(b, r, c, okId) {
    var sid = str(obj(c.session) && c.session.id), keep = okId && sid !== '', n = 0;
    var items = arr(b.items).filter(function (it) { return obj(it) && /^[a-z0-9_-]{1,32}$/.test(str(it.id)); });
    var html = each(items, function (it) {
      var key = checkKey(sid, r.id, it.id), on = keep && typeof c.checked === 'function' && c.checked(key) === true;
      if (on) n++;
      return '<li><label><input type="checkbox" value="' + it.id + '"' + (keep ? ' data-check-key="' + esc(key) + '"' : ' disabled') + (on ? ' checked' : '') +
        '><span>' + esc(it.text) + '</span></label></li>';
    });
    return { meta: checkCount(n, items.length), html: '<ul class="rbk-chk">' + html + '</ul>' };
  }

  // 이걸로 고르기 shows the decision answer box's own confirm row (view.js confirmRow)
  function compare(b, r, c) {
    var d = typeof c.decision === 'function' ? obj(c.decision(b.decision)) : null, o = d ? obj(d.options) || {} : {}, rows = arr(b.rows).filter(obj);
    var keys = ['A', 'B', 'C'].filter(function (k) { return d ? !!obj(own(o, k)) : rows.some(function (x) { return typeof own(x, k) === 'string'; }); });
    var rec = d ? (obj(own(o, d.recommend)) ? d.recommend : obj(o.A) ? 'A' : '') : ''; // = view.js recOf
    var chosen = d && d.answered === true && obj(d.answer) ? str(d.answer.option) : '', ps = d && c.pick ? c.pick(d) : null;
    function mark(k) { return (k === rec ? ' rec' : '') + (k === chosen ? ' chosen' : ''); }
    function head(k) {
      return '<span class="k">' + k + '</span>' + esc(obj(o[k]) && o[k].text) + (k === rec ? ' <span class="chip s-done">추천</span>' : '') +
        (k === chosen ? ' <span class="chip cv-chosen">' + (g.BriefIcons ? g.BriefIcons.icon('check') : '') + ' 고른 안</span>' : '');
    }
    function pick(k) {
      return ps ? '<button type="button" class="cv-pick' + (k === rec ? ' is-rec' : '') + '" data-act="ans-pick" data-dec="' + d.id + '" data-opt="' + k + '" data-where="blk" aria-pressed="' +
        (ps.picked === k) + '"' + (ps.open ? '' : ' disabled' + (ps.closed ? ' title="이미 답했거나 닫힌 결정"' : '')) + '>이걸로 고르기</button>' : '';
    }
    function td(k, v) { return '<td' + (k === rec ? ' class="rec">' : '>') + v + '</td>'; }
    var html = '<div class="rbk-scroll rbk-cmpw"><table class="t rbk-cmp"><thead><tr><th scope="col">항목</th>' + each(keys, function (k) {
      return '<th scope="col" class="opt' + mark(k) + '">' + head(k) + '</th>';
    }) + '</tr></thead><tbody>' + each(rows, function (x) {
      return '<tr><th scope="row">' + esc(x.label) + '</th>' + each(keys, function (k) { return td(k, esc(own(x, k))); }) + '</tr>';
    }) + '</tbody>' + (ps ? '<tfoot><tr><td></td>' + each(keys, function (k) { return td(k, pick(k)); }) + '</tr></tfoot>' : '') + '</table></div><div class="rbk-cmpc">' +
      each(keys, function (k) {
        return '<div class="cmpc' + mark(k) + '"><p class="cmpc-h">' + head(k) + '</p><dl class="rbk-kvl">' +
          each(rows, function (x) { return '<dt>' + esc(x.label) + '</dt><dd>' + esc(own(x, k)) + '</dd>'; }) + '</dl>' + pick(k) + '</div>';
      }) + '</div>';
    var err = ps && ps.error ? '<p class="ans-err" role="alert">' + esc(ps.error) + '</p>' : '';
    if (ps && ps.picked) html += kit().confirmRow(d.id, c.session, ps.conf, 'blk') + err;
    else if (ps && d !== c.linked) html += ps.line || err;
    return { meta: d ? '#' + d.id + ' 결정과 연결' : '연결된 결정 없음', html: html };
  }

  var DRAW = { table: table, bars: bars, kv: kv, flow: flow, checklist: checklist, compare: compare };

  function render(report, ctx) {
    var r = obj(report), c = obj(ctx) || {}, out = '', okId = !!r && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(str(r.id));
    arr(r && r.blocks).forEach(function (b, n) {
      var kind = str(obj(b) && b.kind), draw = own(DRAW, kind);
      if (!draw) return;
      var part = draw(b, r, c, okId), meta = part.meta.replace(/ ([가-힣]{1,2})$/, '\u00a0$1');
      out += '<figure class="rbk rbk-' + kind + '"' + (okId ? ' data-block="rep/' + r.id + '/blk/' + n + '"' : '') + '><figcaption class="rbk-t"><span class="rbk-h">' +
        esc(str(b.title) || KIND[kind]) + '</span>' + (meta ? '<span class="rbk-m">' + esc(meta) + '</span>' : '') + '</figcaption>' + part.html + '</figure>';
    });
    return out && '<div class="rbks">' + out + '</div>';
  }

  g.BriefBlocks = { render: render, checkKey: checkKey, checkCount: checkCount };
})(typeof globalThis !== 'undefined' ? globalThis : this);
