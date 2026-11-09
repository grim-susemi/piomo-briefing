/* omo-briefing roadmap rail view: pure renderer, classic script (file:// safe, no modules).
 * Renders vm.roadmaps into flat expanded track/stage summary rows inside the plans main view,
 * with folded stage details, independent today filters (all/ready/decisionNeeded/blocked),
 * bounded per-stage progress (never global/track %), and preserved session plan list below. */
(function (g) {
  'use strict';
  var FILTERS = [['all', '전체'], ['ready', '가능'], ['decisionNeeded', '결정필요'], ['blocked', '막힘']];
  var OP_LABEL = { implement: '구현', install: '설치', publish: '게시', accept: '수용', other: '기타' };
  var DEC_STATE = { approved: ['s-done', '승인됨'], rejected: ['s-blocked', '거절됨'], held: ['x-stale', '보류됨'], open: ['s-needs_decision', '결정 대기'], unasked: ['s-needs_decision', '미질문 승인 요구'], unknown: ['t-unverified', '확인 필요'] };
  var REC_STATE = { pass: ['s-done', '통과'], fail: ['s-blocked', '실패'], unknown: ['t-unverified', '확인 필요'] };
  var STAGE_COND = { pass: ['s-done', '통과'], blocked: ['s-blocked', '막힘'], unknown: ['t-unverified', '확인 필요'] };

  function str(v) { return typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function own(o, k) { return o != null && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function posId(v) { return typeof v === 'number' && isFinite(v) && v >= 1 && Math.floor(v) === v ? v : null; }
  function flat(v) { return str(v).replace(/[\r\n]+/g, ' ').trim(); }
  function escapeHtml(v) { return str(v).replace(/[&<>"'`]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]; }); }
  function ic(name, cls) { var m = g.BriefIcons; return m ? m.icon(name, cls) : ''; }
  function hhmm(t) { var ms = typeof t === 'number' ? t : Date.parse(str(t)); if (!isFinite(ms)) return '--:--'; var d = new Date(ms); return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }
  function normPath(p) { return str(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
  function slugOfPath(p) { return (str(p).replace(/\\/g, '/').split('/').pop() || '').replace(/\.md$/i, ''); }
  function copyBtn(value, e) { return '<button type="button" class="copy" data-copy="' + e(value) + '" aria-label="복사" title="복사">' + ic('copy', 'ic-xs') + ' <span data-copy-label role="status">복사</span></button>'; }

  function isStageReady(stage, stale) {
    var s = obj(stage), p = s ? obj(s.progress) : null;
    if (!s || stale || s.ready !== true || s.terminal === true || s.running === true || s.decisionNeeded === true || s.blocked === true || s.unknown === true || s.held === true || s.requirementsKnown === false) return false;
    return Boolean(p && num(p.denominator) !== null && p.denominator > 0 && (num(p.doneConfirmed) || 0) < p.denominator && (num(p.conflicts) || 0) <= 0);
  }

  function normStage(raw, stale) {
    var s = obj(raw) || {}, id = flat(s.id);
    if (!id || id === '__proto__' || id === 'constructor' || id === 'prototype') return null;
    var p = obj(s.progress), terminal = s.terminal === true, ready = isStageReady(s, stale), held = s.held === true, run = !terminal && s.running === true;
    var dec = !terminal && s.decisionNeeded === true, blk = !terminal && (s.blocked === true || (p !== null && (num(p.conflicts) || 0) > 0));
    var unk = stale || s.unknown === true || s.requirementsKnown === false || !p || num(p.denominator) === null || held || (!terminal && !ready && !dec && !blk && !run);
    return { raw: s, id: id, label: flat(s.label) || id, goal: flat(s.goal), sourceId: flat(s.sourceId), note: flat(s.note), requirementsKnown: s.requirementsKnown === true,
      requires: arr(s.requires).filter(obj), accepts: arr(s.accepts).filter(obj), plans: arr(s.plans).filter(obj), progress: p, accepted: flat(s.accepted) || 'unknown',
      terminal: terminal, held: held, running: run, ready: ready, decisionNeeded: dec, blocked: blk, unknown: unk, stale: stale };
  }

  function progressText(stage) {
    var s = obj(stage) || {}, plans = arr(s.plans), p = obj(s.progress);
    var obs = p && num(p.observedUniqueIds) !== null ? Math.max(0, Math.floor(num(p.observedUniqueIds))) : 0;
    var den = p && num(p.denominator) !== null && p.denominator >= 0 ? Math.floor(num(p.denominator)) : null;
    var done = p && num(p.doneConfirmed) !== null ? Math.max(0, Math.floor(num(p.doneConfirmed))) : 0;
    var exc = p && num(p.excluded) !== null ? Math.max(0, Math.floor(num(p.excluded))) : 0, conf = p && num(p.conflicts) !== null ? Math.max(0, Math.floor(num(p.conflicts))) : 0;
    var parts = [!plans.length && obs === 0 && den === null ? '계획 미작성' : den === null ? '집계 불완전 · 관측 ID ' + obs + '개' : den === 0 ? '작업 없음' : Math.min(done, den) + '/' + den];
    if (exc > 0) parts.push('제외 ' + exc);
    if (conf > 0) parts.push('충돌 ' + conf);
    if (den !== null && den > 0 && done >= den && s.accepted !== 'pass') parts.push('수용 미확인');
    return parts.join(' · ');
  }

  function filterKeyOf(key) { for (var i = 0; i < FILTERS.length; i++) if (FILTERS[i][0] === key) return key; return 'all'; }
  function matchesFilter(stage, filterKey) {
    var fk = filterKeyOf(filterKey);
    if (fk === 'all') return true;
    if (!stage || stage.terminal) return false;
    return fk === 'ready' ? stage.ready === true : fk === 'decisionNeeded' ? stage.decisionNeeded === true : fk === 'blocked' ? stage.blocked === true : true;
  }
  function filterStages(stages, filterKey) { var fk = filterKeyOf(filterKey); return arr(stages).filter(function (s) { return matchesFilter(s, fk); }); }

  function normRoadmaps(rawList) {
    var out = [];
    arr(rawList).forEach(function (item, idx) {
      var r = obj(item);
      if (!r) return;
      var rid = flat(r.roadmapId) || ('rm-' + (idx + 1)), stale = r.stale === true || Boolean(r.error), byId = Object.create(null), stages = [], placed = Object.create(null), tracks = [];
      arr(r.stages).forEach(function (rawStage) { var st = normStage(rawStage, stale); if (st && !own(byId, st.id)) { byId[st.id] = st; stages.push(st); } });
      arr(r.tracks).forEach(function (rawTrack, tIdx) {
        var t = obj(rawTrack);
        if (!t) return;
        var tid = flat(t.id) || ('track-' + (tIdx + 1)), tStages = [];
        arr(t.stageIds).forEach(function (sid) { var key = flat(sid); if (own(byId, key) && !placed[key]) { placed[key] = true; tStages.push(byId[key]); } });
        tracks.push({ id: tid, label: flat(t.label) || tid, stages: tStages });
      });
      var leftover = stages.filter(function (st) { return !placed[st.id]; });
      if (leftover.length) tracks.push({ id: 'unassigned', label: '단계 목록', stages: leftover });
      out.push({ roadmapId: rid, projectionPath: flat(r.projectionPath), revision: num(r.revision), checkedAt: r.checkedAt, stale: stale, error: r.error || null, tracks: tracks, stages: stages, byId: byId });
    });
    return out;
  }

  function countsOf(roadmaps) {
    var norm = Array.isArray(roadmaps) && roadmaps.length && roadmaps[0] && roadmaps[0].byId ? roadmaps : normRoadmaps(roadmaps);
    var c = { all: 0, ready: 0, decisionNeeded: 0, blocked: 0, unknown: 0, held: 0, terminal: 0 };
    norm.forEach(function (rm) {
      rm.stages.forEach(function (s) {
        c.all++;
        if (s.terminal) { c.terminal++; return; }
        if (s.ready) c.ready++;
        if (s.decisionNeeded) c.decisionNeeded++;
        if (s.blocked) c.blocked++;
        if (s.unknown) c.unknown++;
        if (s.held) c.held++;
      });
    });
    return c;
  }

  function indexBoard(vm) {
    var decs = Object.create(null), plansById = Object.create(null), plansByPath = Object.create(null), plansBySlug = Object.create(null), sessionPlans = [];
    arr(vm && vm.sessions).forEach(function (raw) {
      var s = obj(raw), sid = s ? flat(s.id) : '';
      if (!sid) return;
      arr(s.decisions).forEach(function (d) { if (obj(d) && posId(d.id) !== null) decs[String(d.id)] = { d: d, session: s, sid: sid }; });
      var p = obj(s.plan), link = obj(s.planLink), auto = obj(s.auto);
      if (p) {
        var pid = flat(p.planId), src = obj(p.source) || {}, entry = { sid: sid, session: s, plan: p, slug: flat(src.slug) || slugOfPath(src.planPath || src.draftPath) };
        if (pid && !own(plansById, pid)) plansById[pid] = entry;
        [src.planPath, src.draftPath].forEach(function (fp) { var np = normPath(fp); if (np && !own(plansByPath, np)) plansByPath[np] = entry; });
        if (entry.slug) {
          if (!own(plansBySlug, entry.slug)) plansBySlug[entry.slug] = [];
          plansBySlug[entry.slug].push(entry);
        }
      }
      if (p || link || flat(s.workName) || (auto && (obj(auto.work) || flat(auto.stage)))) sessionPlans.push({ sid: sid, session: s, plan: p, link: link });
    });
    return { decs: decs, plansById: plansById, plansByPath: plansByPath, plansBySlug: plansBySlug, sessionPlans: sessionPlans };
  }

  function matchPlan(planRef, board) {
    var pid = flat(planRef.planId), np = normPath(planRef.path), slug = slugOfPath(planRef.path);
    if (pid && own(board.plansById, pid)) return board.plansById[pid];
    if (np && own(board.plansByPath, np)) return board.plansByPath[np];
    if (slug && own(board.plansBySlug, slug)) {
      var candidates = board.plansBySlug[slug];
      if (candidates && candidates.length === 1) return candidates[0];
    }
    return null;
  }

  function matchPlanDetailed(planRef, board) {
    var pid = flat(planRef.planId), np = normPath(planRef.path), slug = slugOfPath(planRef.path);
    if (pid && own(board.plansById, pid)) return { match: board.plansById[pid], candidates: null };
    if (np && own(board.plansByPath, np)) return { match: board.plansByPath[np], candidates: null };
    if (slug && own(board.plansBySlug, slug)) {
      var candidates = board.plansBySlug[slug];
      if (candidates && candidates.length === 1) return { match: candidates[0], candidates: null };
      if (candidates && candidates.length > 1) return { match: null, candidates: candidates };
    }
    return { match: null, candidates: null };
  }

  function heldIdsOf(stage, board) {
    var ids = [], allDecIds = [];
    stage.requires.concat(stage.accepts).forEach(function (c) {
      if (c.kind !== 'decision') return;
      var id = posId(c.decisionId), hit = id !== null ? own(board.decs, String(id)) : null;
      if (id !== null && allDecIds.indexOf(id) < 0) allDecIds.push(id);
      if ((c.state === 'held' || (hit && hit.d && hit.d.held)) && id !== null && ids.indexOf(id) < 0) ids.push(id);
    });
    return ids.length ? ids : (stage.held ? allDecIds : []);
  }

  function placeStages(roadmaps, board) {
    var result = { columns: { ready: [], running: [], decisionNeeded: [], blocked: [], done: [] },
      attention: { items: [], discarded: [] }, order: [],
      counts: { ready: 0, running: 0, decisionNeeded: 0, blocked: 0, done: 0, attention: 0, discarded: 0, conditions: 0, total: 0 } };
    var decisionBoard = board && board.decs ? board : { decs: Object.create(null) };
    var normalizedList = arr(roadmaps).map(function (rm) {
      if (rm && Array.isArray(rm.tracks) && rm.tracks.length && Array.isArray(rm.tracks[0].stages)) return rm;
      var normed = normRoadmaps([rm]);
      return normed.length ? normed[0] : rm;
    });
    normalizedList.forEach(function (rm) {
      if (!rm || !Array.isArray(rm.tracks)) return;
      rm.tracks.forEach(function (track) {
        if (!track || !Array.isArray(track.stages)) return;
        track.stages.forEach(function (stage) {
          var stale = rm.stale === true || Boolean(rm.error), freshDone = stage.terminal && stage.accepted === 'pass' && !stale;
          var discarded = stage.terminal && stage.accepted !== 'pass', heldIds = heldIdsOf(stage, decisionBoard);
          var progressUnknown = !stage.progress || stage.progress.denominator === null;
          var badges = [], reasons = [], column, bucket;
          function badge(code, label) { badges.push({ code: code, label: label }); }
          function reason(code, text) { reasons.push({ code: code, text: text }); }
          if (stage.blocked) badge('blocked', '막힘');
          if (stage.decisionNeeded) badge('decisionNeeded', '결정 대기');
          if (stage.running) badge('running', '진행 중');
          if (stage.ready) badge('ready', '준비');
          if (freshDone) badge('done', '완료');
          if (discarded) badge('discarded', '폐기·취소');
          if (stage.unknown) badge('unknown', '확인 필요');
          if (stage.held || heldIds.length) badge('held', '보류' + (heldIds.length ? ' #' + heldIds.join(', #') : ''));
          if (stale) badge('stale', '오래됨');
          if (progressUnknown) badge('progress-unknown', '집계 확인 필요');
          if (stage.blocked) { column = 'blocked'; reason('blocked', '차단된 조건이 있습니다.'); }
          else if (stage.decisionNeeded) { column = 'decisionNeeded'; reason('decisionNeeded', '결정을 기다리고 있습니다.'); }
          else if (freshDone) { column = 'done'; reason('done', '현재 수용 근거가 통과했습니다.'); }
          else if (discarded) { column = 'attention'; reason('discarded', '수용되지 않은 종료 기록입니다.'); }
          else if (stage.unknown || stage.held || stale) {
            column = 'attention';
            if (stage.unknown) reason('unknown', '단계 상태를 확인할 근거가 부족합니다.');
            if (stage.held) reason('held', '보류된 조건이 있습니다.');
            if (stale) reason('stale', '로드맵 근거가 오래되었거나 수집 오류가 있습니다.');
          } else if (stage.running) { column = 'running'; reason('running', '진행 신호가 관측되었습니다.'); }
          else if (stage.ready) { column = 'ready'; reason('ready', '준비 조건을 충족했습니다.'); }
          else { column = 'attention'; reason('insufficient-evidence', '배치할 상태 근거가 부족합니다.'); }
          var entry = { key: rm.roadmapId + ':' + stage.id, roadmapId: rm.roadmapId, trackId: track.id,
            stage: stage, column: column, badges: badges, reasons: reasons };
          bucket = column === 'attention' ? (discarded ? result.attention.discarded : result.attention.items) : result.columns[column];
          bucket.push(entry);
          result.order.push(entry);
          result.counts[column]++;
          if (discarded && column === 'attention') result.counts.discarded++;
          if (stage.unknown || stage.held || heldIds.length || stale || progressUnknown || discarded || column === 'attention') result.counts.conditions++;
          result.counts.total++;
        });
      });
    });
    return result;
  }

  function renderCondition(c, rm, ctx) {
    var e = ctx.esc, board = ctx.board, kind = flat(c.kind);
    if (kind === 'stage') {
      var sid = flat(c.id), target = own(rm.byId, sid), stKey = target ? (target.accepted === 'pass' ? 'pass' : target.blocked ? 'blocked' : 'unknown') : 'unknown';
      var stInfo = own(STAGE_COND, stKey) || STAGE_COND.unknown;
      return '<li class="rm-cond"><span class="chip ' + stInfo[0] + '">' + e(stInfo[1]) + '</span> <span>선행 단계 <b>' + e(sid) + '</b>' + (target && target.goal ? ' · ' + e(target.goal) : '') + '</span></li>';
    }
    if (kind === 'decision') {
      var id = posId(c.decisionId), hit = id !== null ? own(board.decs, String(id)) : null;
      var rawState = flat(c.state) || (id === null ? 'unasked' : hit ? (hit.d.held ? 'held' : hit.d.answered ? 'approved' : hit.d.closed ? 'unknown' : 'open') : 'unknown');
      var dInfo = own(DEC_STATE, rawState) || DEC_STATE.unknown, op = own(OP_LABEL, flat(c.operation)) || flat(c.operation) || '기타';
      var cmd = id !== null ? '/decide ' + id + (hit && flat(hit.d.recommend) ? flat(hit.d.recommend) : 'A') : '';
      return '<li class="rm-cond"><span class="chip ' + dInfo[0] + '">' + e(dInfo[1]) + '</span> <span>게이트 <b>' + e(flat(c.gateId) || '-') + '</b> (' + e(op) + ')' +
        (id !== null ? ' · #' + e(id) : ' · 아직 질문하지 않음') + (flat(c.scope) ? ' · ' + e(flat(c.scope)) : '') + '</span>' +
        (cmd && rawState === 'open' ? ' <code>' + e(cmd) + '</code> ' + copyBtn(cmd, e) : '') +
        (hit ? ' <button type="button" class="more rm-dec-go" data-sh="open" data-sid="' + e(hit.sid) + '" data-sub="dec">결정 대화 열기</button>' : '') + '</li>';
    }
    if (kind === 'receipt') {
      var rState = flat(c.state) || 'unknown', rInfo = own(REC_STATE, rState) || REC_STATE.unknown, rOp = own(OP_LABEL, flat(c.operation)) || flat(c.operation) || '기타', rPath = flat(c.path);
      return '<li class="rm-cond"><span class="chip ' + rInfo[0] + '">' + e(rInfo[1]) + '</span> <span>영수증 (' + e(rOp) + ') <code>' + e(rPath) + '</code></span> ' + (rPath ? copyBtn(rPath, e) : '') + '</li>';
    }
    return '<li class="rm-cond"><span class="chip t-unverified">확인 필요</span> <span>알 수 없는 조건</span></li>';
  }

  function renderPlanItem(planRef, ctx) {
    var e = ctx.esc, board = ctx.board, path = flat(planRef.path), detailed = matchPlanDetailed(planRef, board), pv = g.BriefPlanView;
    var hit = detailed.match, candidates = detailed.candidates;
    var slug = slugOfPath(path) || flat(planRef.planId) || '계획', linkModel = hit && hit.plan ? hit.plan : { source: { slug: slug }, stage: 'shaping', goal: slug };
    var linkHtml = pv && typeof pv.renderLink === 'function' ? pv.renderLink(linkModel, { esc: e }) : '<span class="plan-link">' + e(slug) + '</span>';
    var errs = arr(planRef.errors).map(function (er) { return flat(obj(er) ? er.code : er); }).filter(Boolean);
    var taskNote = Array.isArray(planRef.taskIds) ? '선택 작업 ' + planRef.taskIds.length + '개' : '전체 작업';
    var openBtn = '';
    if (hit) {
      openBtn = ' <button type="button" class="more rm-plan-open" data-sh="open" data-sid="' + e(hit.sid) + '" data-sub="plan">' + ic('list-todo', 'ic-xs') + ' 계획 대화 열기</button>';
    } else if (candidates && candidates.length > 1) {
      openBtn = ' <span class="rm-plan-candidates-wrap"><span class="chip t-unverified">동명 후보 ' + candidates.length + '개</span> ' +
        candidates.map(function (c, ci) {
          var cSid = c.sid, cLabel = flat(c.session && c.session.workName) || ('대화 ' + cSid);
          return '<button type="button" class="more rm-candidate-btn" data-sh="open" data-sid="' + e(cSid) + '" data-sub="plan" title="' + e(c.slug + ' · ' + cLabel) + '">' +
            ic('list-todo', 'ic-xs') + ' 후보 ' + (ci + 1) + ' (' + e(cLabel) + ')</button>';
        }).join(' ') + '</span>';
    } else {
      openBtn = ' <span class="chip t-unverified">미해결 참조</span>';
    }

    return '<li class="rm-plan-item"><div class="rm-plan-line">' + linkHtml + openBtn +
      '<span class="rm-plan-meta">' + e(taskNote) + (errs.length ? ' · 오류: ' + e(errs.join(', ')) : '') + '</span></div>' +
      (path ? '<div class="path"><span class="sym">' + ic('file-text', 'ic-sm') + '</span><code>' + e(path) + '</code>' + copyBtn(path, e) + '</div>' : '') + '</li>';
  }

  function renderStageDetail(stage, rm, expKey, isOpen, ctx, activeTab) {
    var e = ctx.esc, board = ctx.board;
    if (!isOpen) return '';
    var tab = activeTab || 'summary';
    var entryKey = rm.roadmapId + ':' + stage.id;
    var dlgId = 'rm-sheet-dlg';
    var titleText = stage.label.indexOf(stage.id) === 0 ? stage.label : stage.id + ' ' + stage.label;
    var trackLabel = ctx.trackLabels && ctx.trackLabels[stage.sourceId] ? ctx.trackLabels[stage.sourceId] : (stage.sourceId || '');

    var tabsHtml = '<div class="rm-sheet-tabs" role="tablist" aria-label="카드 상세 탭">' + [['summary', '요약'], ['evidence', '근거'], ['history', '계획·이력']].map(function (t) {
      var k = t[0], active = tab === k;
      return '<button type="button" role="tab" id="rm-tab-' + k + '" class="rm-sheet-tab' + (active ? ' is-active' : '') + '" data-act="rm-sheet-tab" data-tab="' + k + '" aria-selected="' + (active ? 'true' : 'false') + '" aria-controls="rm-panel-' + k + '" tabindex="' + (active ? '0' : '-1') + '">' + t[1] + '</button>';
    }).join('') + '</div>';

    // Panel 1: 요약
    var summaryPanel = '<div role="tabpanel" id="rm-panel-summary" class="rm-sheet-panel' + (tab === 'summary' ? ' is-active' : '') + '" aria-labelledby="rm-tab-summary"' + (tab === 'summary' ? '' : ' hidden') + '>' +
      '<div class="rm-sheet-section"><h3 class="rm-sheet-sec-title">목표</h3><p class="rm-sheet-text">' + e(stage.goal || '-') + '</p></div>' +
      (stage.sourceId ? '<div class="rm-sheet-section"><h3 class="rm-sheet-sec-title">원문 섹션</h3><p class="rm-sheet-text">' + e(stage.sourceId) + '</p></div>' : '') +
      (!stage.requirementsKnown ? '<div class="rm-sheet-section"><p class="rm-warn-text">요구사항 미확인</p></div>' : '') +
      (stage.note ? '<div class="rm-sheet-section"><h3 class="rm-sheet-sec-title">비고</h3><p class="rm-sheet-text">' + e(stage.note) + '</p></div>' : '') +
      '<div class="rm-sheet-section"><h3 class="rm-sheet-sec-title">작업 집계</h3><p class="rm-sheet-text">' + e(progressText(stage)) + '</p></div>' +
      '</div>';

    // Panel 2: 근거
    var evidencePanel = '<div role="tabpanel" id="rm-panel-evidence" class="rm-sheet-panel' + (tab === 'evidence' ? ' is-active' : '') + '" aria-labelledby="rm-tab-evidence"' + (tab === 'evidence' ? '' : ' hidden') + '>' +
      '<div class="rm-sheet-meta-grid">' +
      '<div class="rm-sheet-meta-item"><span class="rm-sheet-meta-lbl">관측 시각</span><span class="rm-sheet-meta-val">' + e(rm.checkedAt ? hhmm(rm.checkedAt) : '-') + '</span></div>' +
      '<div class="rm-sheet-meta-item"><span class="rm-sheet-meta-lbl">상태 신호</span><span class="rm-sheet-meta-val">' + (rm.stale ? '<span class="chip x-stale">오래됨 (60초 초과)</span>' : rm.error ? '<span class="chip t-unverified">오류</span>' : '<span class="chip s-done">정상</span>') + '</span></div>' +
      '</div>' +
      (stage.requires.length ? '<div class="rm-sheet-section"><h3 class="rm-sheet-sec-title">진입 조건 (' + stage.requires.length + ')</h3><ul class="rm-conds">' + stage.requires.map(function (c) { return renderCondition(c, rm, ctx); }).join('') + '</ul></div>' : '') +
      (stage.accepts.length ? '<div class="rm-sheet-section"><h3 class="rm-sheet-sec-title">출구 수용 조건 (' + stage.accepts.length + ')</h3><ul class="rm-conds">' + stage.accepts.map(function (c) { return renderCondition(c, rm, ctx); }).join('') + '</ul></div>' : '') +
      (rm.projectionPath ? '<div class="path rm-proj-path"><span class="sym">' + ic('folder', 'ic-sm') + '</span><code>' + e(rm.projectionPath) + '</code>' + copyBtn(rm.projectionPath, e) + '</div>' : '') +
      '</div>';

    // Panel 3: 계획·이력
    var historyPanel = '<div role="tabpanel" id="rm-panel-history" class="rm-sheet-panel' + (tab === 'history' ? ' is-active' : '') + '" aria-labelledby="rm-tab-history"' + (tab === 'history' ? '' : ' hidden') + '>' +
      '<div class="rm-sheet-section"><h3 class="rm-sheet-sec-title">연결된 계획 (' + stage.plans.length + ')</h3>' +
      (stage.plans.length ? '<ul class="rm-plan-list">' + stage.plans.map(function (p) { return renderPlanItem(p, ctx); }).join('') + '</ul>' : '<p class="rm-detail-empty">연결된 계획 없음 (계획 미작성)</p>') +
      '</div>' +
      '<div class="rm-sheet-section"><h3 class="rm-sheet-sec-title">실행 이력</h3><p class="rm-sheet-empty-history">기록 없음</p></div>' +
      '</div>';

    var backdropHtml = '<div class="rm-sheet-backdrop" data-act="rm-sheet-close" aria-hidden="true"></div>';

    return '<dialog class="rm-sheet-dialog" id="' + dlgId + '" role="dialog" aria-modal="true" aria-labelledby="rm-sheet-title" data-rm-detail="' + e(stage.id) + '" data-rm-key="' + e(entryKey) + '" open>' +
      backdropHtml +
      '<div class="rm-sheet-container" role="document">' +
      '<header class="rm-sheet-header">' +
      '<div class="rm-sheet-title-wrap">' +
      '<span class="rm-sheet-meta">' + e(stage.id) + (trackLabel ? ' · ' + e(trackLabel) : '') + '</span>' +
      '<h2 id="rm-sheet-title" class="rm-sheet-title">' + e(titleText) + '</h2>' +
      '</div>' +
      '<button type="button" class="rm-sheet-close-btn" data-act="rm-sheet-close" aria-label="상세 닫기">' + ic('x', 'ic-sm') + ' 닫기</button>' +
      '</header>' +
      tabsHtml +
      '<div class="rm-sheet-body" id="rm-sheet-body">' +
      summaryPanel + evidencePanel + historyPanel +
      '</div>' +
      '</div>' +
      '</dialog>';
  }

  function renderCard(entry, rm, ctx) {
    var e = ctx.esc, board = ctx.board, expanded = ctx.expanded;
    var stage = entry.stage, expKey = 'rm-stage:' + entry.key, isOpen = own(expanded, expKey) === true;
    var prog = progressText(stage), firstPlanHit = null;
    for (var i = 0; i < stage.plans.length && !firstPlanHit; i++) firstPlanHit = matchPlan(stage.plans[i], board);
    var titleText = stage.label.indexOf(stage.id) === 0 ? stage.label : stage.id + ' ' + stage.label;
    var reasonText = entry.reasons.length ? entry.reasons.map(function (r) { return r.text; }).join(' · ') : '';
    var trackLabel = ctx.trackLabels && ctx.trackLabels[entry.trackId] ? ctx.trackLabels[entry.trackId] : entry.trackId;
    if (isOpen) ctx.sheetHtml = (ctx.sheetHtml || '') + renderStageDetail(stage, rm, expKey, isOpen, ctx, ctx.activeTab);

    var badgesHtml = '';
    if (entry.badges && entry.badges.length) {
      badgesHtml = '<div class="rm-card-badges">' + entry.badges.map(function (b) {
        var chipCls = b.code === 'done' ? 's-done' : b.code === 'blocked' ? 's-blocked' : b.code === 'decisionNeeded' ? 's-needs_decision' :
          b.code === 'running' ? 's-in_progress' : b.code === 'ready' ? 's-done' : b.code === 'held' || b.code === 'stale' ? 'x-stale' : 't-unverified';
        return '<span class="chip ' + chipCls + '" data-rm-badge="' + e(b.code) + '">' + e(b.label) + '</span>';
      }).join('') + '</div>';
    }

    var html = '<li class="rm-card-wrap" data-rm-stage="' + e(stage.id) + '" data-rm-key="' + e(entry.key) + '" data-rm-roadmap="' + e(entry.roadmapId) + '" data-rm-track="' + e(entry.trackId) + '">' +
      '<article class="rm-card' + (isOpen ? ' is-open' : '') + '">' +
      '<div class="rm-card-head"><span class="rm-card-meta"><span class="rm-card-track-id">' + e(stage.id) + ' · ' + e(trackLabel) + '</span></span>' +
      (firstPlanHit ? '<button type="button" class="more rm-plan-go" data-sh="open" data-sid="' + e(firstPlanHit.sid) + '" data-sub="plan" title="계획 대화 열기">' + ic('list-todo', 'ic-xs') + ' 계획</button>' : '') +
      '</div>' +
      '<button type="button" class="more rm-card-btn rm-exp-btn" data-act="exp" data-key="' + e(expKey) + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '" aria-label="' + e(titleText + ' 상세') + '">' +
      '<strong class="rm-card-title">' + e(titleText) + '</strong>' +
      '<span class="rm-card-goal">' + e(stage.goal || stage.label) + '</span>' +
      badgesHtml +
      (reasonText ? '<span class="rm-card-reason' + (entry.column === 'blocked' ? ' is-blocked' : entry.column === 'decisionNeeded' ? ' is-decision' : '') + '">' + e(reasonText) + '</span>' : '') +
      '<span class="rm-card-foot"><span class="rm-prog" data-rm-progress="' + e(stage.id) + '">' + e(prog) + '</span>' +
      '<span class="rm-card-toggle">' + ic(isOpen ? 'chevron-down' : 'chevron-right', 'ic-xs') + ' ' + (isOpen ? '상세 닫기' : '상세') + '</span></span>' +
      '</button>' +
      '</article></li>';
    return html;
  }

  function collectConnectedPlans(vm, board, roadmaps) {
    var items = [];
    var seenKeys = Object.create(null); // idKey -> index in items

    // 1. Every sessionPlan from board
    arr(board && board.sessionPlans).forEach(function (item) {
      var s = item.session, p = item.plan, link = item.link;
      var pid = flat(p && p.planId || link && link.planId);
      var src = obj(p && p.source) || obj(link && link.source) || {};
      var rawPath = src.planPath || src.draftPath || (p && p.planPath) || (link && link.planPath) || '';
      var np = normPath(rawPath);
      var slug = flat(src.slug) || slugOfPath(rawPath);

      var idKey = pid ? 'pid:' + pid : (np ? 'path:' + np : 'sid:' + item.sid);
      seenKeys[idKey] = items.length;
      items.push({
        idKey: idKey,
        kind: 'session',
        sid: item.sid,
        session: s,
        plan: p,
        link: link,
        planId: pid,
        path: rawPath,
        normPath: np,
        slug: slug,
        stages: []
      });
    });

    // 2. Stage plans from roadmaps
    var connected = Array.isArray(vm.roadmapPlans) ? vm.roadmapPlans.flatMap(function (item) {
      return item.refs.map(function (ref) { return { roadmapId: ref.roadmapId,
        stages: [{ id: ref.stageId, label: ref.stageLabel, plans: [Object.assign({}, item.plan, { taskIds: ref.taskIds, errors: ref.errors })] }] }; });
    }) : roadmaps;
    arr(connected).forEach(function (rm) {
      arr(rm.stages).forEach(function (st) {
        arr(st.plans).forEach(function (pref) {
          var pid = flat(pref.planId), rawPath = flat(pref.path), np = normPath(rawPath), slug = slugOfPath(rawPath);
          var stageRef = {
            roadmapId: rm.roadmapId,
            stageId: st.id,
            stageLabel: st.label,
            taskIds: pref.taskIds,
            errors: pref.errors
          };

          // Find if already exists in items by exact planId or exact normalized path
          var existingIdx = -1;
          if (pid && own(seenKeys, 'pid:' + pid) !== undefined) {
            existingIdx = seenKeys['pid:' + pid];
          } else if (np && own(seenKeys, 'path:' + np) !== undefined) {
            existingIdx = seenKeys['path:' + np];
          }

          if (existingIdx >= 0) {
            items[existingIdx].stages.push(stageRef);
          } else {
            // Check candidate collisions
            var slugCandidates = slug && own(board.plansBySlug, slug) ? board.plansBySlug[slug] : [];
            var hit = matchPlan(pref, board);
            var idKey = pid ? 'pid:' + pid : (np ? 'path:' + np : 'unresolved:' + (slug || 'plan') + ':' + items.length);
            seenKeys[idKey] = items.length;
            items.push({
              idKey: idKey,
              kind: hit ? 'stage-matched' : (slugCandidates.length > 1 ? 'collision' : 'unresolved'),
              sid: hit ? hit.sid : '',
              session: hit ? hit.session : null,
              plan: hit ? hit.plan : null,
              link: null,
              planId: pid,
              path: rawPath,
              normPath: np,
              slug: slug,
              slugCandidates: slugCandidates.length > 1 ? slugCandidates : null,
              stages: [stageRef]
            });
          }
        });
      });
    });

    return items;
  }

  function renderConnectedPlansScreen(vm, board, roadmaps, ui, e) {
    var allPlans = collectConnectedPlans(vm, board, roadmaps);
    var pv = g.BriefPlanView;

    var html = '<div class="roadmap-view rm-connected-plans-view" data-rm-subview="plans">';
    html += '<header class="rm-head rm-plans-head">' +
      '<div class="rm-head-left">' +
      '<button type="button" class="more rm-return-btn" data-act="rm-return-board" aria-label="로드맵 보드로 돌아가기">' +
      ic('chevron-left', 'ic-xs') + ' 로드맵 보드로 돌아가기</button>' +
      '<h1 class="rm-title">' + ic('list-todo', 'ic-sm') + ' 연결 계획</h1>' +
      '<span class="rm-sum" role="status">전체 ' + allPlans.length + '개 계획</span>' +
      '</div></header>';

    html += '<p class="rm-plans-intro">이 상황판에 연결된 모든 계획 목록입니다. 보드 단계와 대화별 계획을 통합하여 보여주며, 동명 계획 충돌은 분리 후보로 표시합니다.</p>';

    if (!allPlans.length) {
      html += '<div class="rm-empty" role="status">' + ic('list-todo') +
        '<p class="rm-empty-title">연결된 계획 없음</p>' +
        '<p class="rm-empty-sub">등록된 로드맵 단계나 세션에 계획이 없습니다.</p></div></div>';
      return html;
    }

    html += '<ul class="rm-connected-plans-list" aria-label="연결 계획 전체 목록">';
    allPlans.forEach(function (item, idx) {
      var s = item.session, p = item.plan, link = item.link;
      var targetSid = p ? item.sid : (flat(link && link.ownerId) || item.sid);
      var label = flat(s && s.workName) || flat(p && p.source && p.source.slug) || flat(p && p.goal) || flat(link && link.goal) || flat(s && s.title) || item.slug || (item.planId ? '계획 ' + item.planId : '계획 ' + (idx + 1));
      var summaryHtml = pv && (p || link) ? pv.renderLink(p || link, { esc: e }) : '<span class="plan-link">' + e(label) + '</span>';

      var stagesNote = '';
      if (item.stages && item.stages.length) {
        var stageTags = item.stages.map(function (st) {
          return '<span class="chip x-info">' + e(st.stageId + ' ' + st.stageLabel) + '</span>';
        }).join(' ');
        stagesNote = '<div class="rm-cplan-stages"><span class="rm-cplan-stages-lbl">연결된 단계:</span> ' + stageTags + '</div>';
      }

      var actionPart = '';
      if (item.kind === 'collision' && item.slugCandidates && item.slugCandidates.length > 1) {
        actionPart = '<div class="rm-collision-notice"><span class="chip t-unverified">동명 slug 충돌 (' + item.slugCandidates.length + '개 후보)</span> ' +
          '<span class="rm-collision-desc">동일한 파일 이름의 계획이 서로 다른 대화에서 발견되었습니다. 자동 결합하지 않고 각각 표시합니다:</span>' +
          '<div class="rm-collision-candidates">' +
          item.slugCandidates.map(function (c, ci) {
            var cSid = c.sid, cWork = flat(c.session && c.session.workName) || ('대화 ' + cSid), cPath = (c.plan && c.plan.source && c.plan.source.planPath) || '';
            return '<div class="rm-collision-row">' +
              '<button type="button" class="more rm-cplan-open" data-sh="open" data-sid="' + e(cSid) + '" data-sub="plan">' +
              ic('list-todo', 'ic-xs') + ' 후보 ' + (ci + 1) + ' (' + e(cWork) + ') 열기</button>' +
              (cPath ? '<span class="path"><span class="sym">' + ic('file-text', 'ic-sm') + '</span><code>' + e(cPath) + '</code>' + copyBtn(cPath, e) + '</span>' : '') +
              '</div>';
          }).join('') +
          '</div></div>';
      } else if (item.kind === 'unresolved') {
        actionPart = '<div class="rm-unresolved-notice"><span class="chip t-unverified">미해결 참조</span> ' +
          '<span class="rm-unresolved-desc">대화 세션과 직접 연결되지 않은 계획 참조입니다.</span></div>';
      } else {
        actionPart = '<div class="rm-cplan-actions">' +
          (targetSid ? '<button type="button" class="more rm-cplan-open" data-sh="open" data-sid="' + e(targetSid) + '" data-sub="plan">' + ic('list-todo', 'ic-xs') + ' ' + e(label) + ' 열기</button>' : '') +
          '</div>';
      }

      var pathLine = '';
      if (item.path) {
        pathLine = '<div class="path"><span class="sym">' + ic('file-text', 'ic-sm') + '</span><code>' + e(item.path) + '</code>' + copyBtn(item.path, e) + '</div>';
      }

      html += '<li class="rm-cplan-row" data-cplan-key="' + e(item.idKey) + '">' +
        '<div class="rm-cplan-header">' + summaryHtml + '</div>' +
        pathLine + stagesNote + actionPart +
        '</li>';
    });
    html += '</ul></div>';
    return html;
  }

  function renderSessionPlans(board, e) {
    var list = board.sessionPlans, pv = g.BriefPlanView;
    var html = '<section class="rm-session-plans" aria-label="대화별 계획 목록"><h2 class="rm-sec-title">' + ic('list-todo', 'ic-sm') + ' 대화별 계획 목록 <span class="rm-track-cnt">' + list.length + '</span></h2>';
    if (!list.length) return html + '<p class="rm-muted">계획이 있는 대화가 없습니다.</p></section>';
    return html + '<ul class="rm-splan-list">' + list.map(function (item) {
      var s = item.session, p = item.plan, link = item.link, targetSid = p ? item.sid : (flat(link && link.ownerId) || item.sid);
      var label = flat(s.workName) || flat(p && p.source && p.source.slug) || flat(p && p.goal) || flat(link && link.goal) || flat(s.title) || item.sid;
      var summaryHtml = pv && (p || link) ? pv.renderLink(p || link, { esc: e }) : '<span class="plan-link">' + e(label) + '</span>';
      return '<li class="rm-splan-row" data-row="rm-splan:' + e(item.sid) + '">' + summaryHtml +
        '<button type="button" class="more rm-splan-open" data-sh="open" data-sid="' + e(targetSid) + '" data-sub="plan">' + ic('list-todo', 'ic-xs') + ' ' + e(label) + ' 열기</button></li>';
    }).join('') + '</ul></section>';
  }

  var COLUMNS = [
    ['ready', '준비'],
    ['running', '진행'],
    ['decisionNeeded', '결정 대기'],
    ['blocked', '막힘'],
    ['done', '완료']
  ];

  function render(viewModel, uiState) {
    var vm = obj(viewModel) || {}, ui = obj(uiState) || {}, e = g.BriefView && typeof g.BriefView.escapeHtml === 'function' ? g.BriefView.escapeHtml : escapeHtml;
    var expanded = obj(ui.expanded) || {}, activeFilter = filterKeyOf(ui.roadmapFilter), board = indexBoard(vm);
    var searchQuery = flat(ui.roadmapSearch || '').toLowerCase();
    var selectedTrack = flat(ui.roadmapTrack || 'all');
    var mobileStatus = flat(ui.roadmapStatus || 'ready');
    if (!COLUMNS.some(function (col) { return col[0] === mobileStatus; })) mobileStatus = 'ready';

    var hasRoadmapsProp = Object.prototype.hasOwnProperty.call(vm, 'roadmaps');
    var roadmaps = normRoadmaps(hasRoadmapsProp && Array.isArray(vm.roadmaps) ? vm.roadmaps : []);
    var rmReadErrors = arr(vm.readErrors).map(flat).filter(function (rel) { return rel.indexOf('roadmaps') >= 0; });

    // Subview: dedicated connected plans screen
    if (ui.roadmapSubView === 'plans') {
      return renderConnectedPlansScreen(vm, board, roadmaps, ui, e);
    }
    if (g.BriefRoadmapIndex) {
      var indexCtx = { esc: e, board: board, expanded: expanded, trackLabels: {}, activeTab: flat(ui.roadmapTab || 'summary') };
      roadmaps.forEach(function (rm) { rm.tracks.forEach(function (t) { indexCtx.trackLabels[t.id] = t.label; }); });
      var placed = placeStages(roadmaps, board);
      var entries = placed.order;
      return g.BriefRoadmapIndex.render(roadmaps, ui, {
        esc: e, entries: entries, readErrors: rmReadErrors, legacy: !hasRoadmapsProp || !Array.isArray(vm.roadmaps), progress: progressText,
        topics: vm.roadmapTopics, total: vm.roadmapCatalogue && vm.roadmapCatalogue.total,
        loading: vm.roadmapLoad && vm.roadmapLoad.loading, loadError: vm.roadmapLoad && vm.roadmapLoad.error, matchedCount: vm.roadmapLoad && vm.roadmapLoad.total,
        matchPlan: function (p) { return matchPlan(p, board); },
        condition: function (c, rm) { return renderCondition(c, rm, indexCtx); },
        planItem: function (p) { return renderPlanItem(p, indexCtx); },
        plansButton: '<button type="button" class="more rm-plans-btn" data-act="rm-connected-plans">연결 계획</button>',
        sheets: function (rm) { return rm.stages.map(function (s) {
          var key = 'rm-stage:' + rm.roadmapId + ':' + s.id;
          return renderStageDetail(s, rm, key, own(expanded, key) === true, indexCtx, indexCtx.activeTab);
        }).join(''); }
      });
    }

    // Track map for track filter and card labels
    var trackMap = Object.create(null);
    var roadmapsById = Object.create(null);
    roadmaps.forEach(function (rm) {
      roadmapsById[rm.roadmapId] = rm;
      rm.tracks.forEach(function (t) {
        if (!trackMap[t.id]) trackMap[t.id] = t.label;
      });
    });

    var placement = placeStages(roadmaps, board);
    var totalUniqueStages = placement.counts.total;

    // Filter matching function: track + search query
    function matchEntry(entry) {
      if (selectedTrack !== 'all' && entry.trackId !== selectedTrack) return false;
      if (searchQuery) {
        var st = entry.stage;
        var hay = (st.id + ' ' + st.label + ' ' + st.goal + ' ' + (entry.reasons.map(function (r) { return r.text; }).join(' '))).toLowerCase();
        if (hay.indexOf(searchQuery) < 0) return false;
      }
      return true;
    }

    var filteredColumns = { ready: [], running: [], decisionNeeded: [], blocked: [], done: [] };
    var filteredAttention = { items: [], discarded: [] };
    var filteredTotal = 0;

    COLUMNS.forEach(function (col) {
      var k = col[0];
      filteredColumns[k] = placement.columns[k].filter(matchEntry);
      filteredTotal += filteredColumns[k].length;
    });
    filteredAttention.items = placement.attention.items.filter(matchEntry);
    filteredAttention.discarded = placement.attention.discarded.filter(matchEntry);
    var filteredAttentionTotal = filteredAttention.items.length + filteredAttention.discarded.length;
    filteredTotal += filteredAttentionTotal;

    var isFiltered = (selectedTrack !== 'all' || searchQuery !== '');
    var ctx = { esc: e, board: board, expanded: expanded, trackLabels: trackMap, activeTab: flat(ui.roadmapTab || 'summary') };

    // Header HTML
    var countSummaryText = isFiltered
      ? '표시 ' + filteredTotal + ' / 전체 ' + totalUniqueStages + '단계'
      : '전체 ' + totalUniqueStages + '단계';

    var allConnectedPlans = collectConnectedPlans(vm, board, roadmaps);

    var html = '<div class="roadmap-view rm-kanban-view" data-rm-filter="' + e(activeFilter) + '" data-rm-status="' + e(mobileStatus) + '">';
    html += '<header class="rm-head"><div class="rm-head-left"><h1 class="rm-title">' +
      ic('list-todo', 'ic-sm') + ' 로드맵 보드</h1><span class="rm-sum" role="status">' + e(countSummaryText) + '</span></div>' +
      '<div class="rm-head-actions">' +
      '<button type="button" class="more rm-plans-btn" data-act="rm-connected-plans" aria-label="연결 계획 화면 열기">' +
      ic('list-todo', 'ic-xs') + ' 연결 계획 <span class="rm-plans-cnt">' + allConnectedPlans.length + '</span></button>' +
      '</div></header>';

    // Toolbar: search, track select, narrow-status select, jump-to-attention
    html += '<div class="rm-toolbar" role="search" aria-label="단계 검색 및 필터">' +
      '<button type="button" class="rm-mobile-filter-toggle" data-act="rm-mobile-filter-toggle" aria-expanded="' + (ui.roadmapFiltersOpen ? 'true' : 'false') + '" aria-controls="rm-toolbar-collapsible" aria-label="' + (ui.roadmapFiltersOpen ? '검색 및 필터 닫기' : '검색 및 필터 열기') + '">' +
      ic('settings', 'ic-xs') + ' <span class="rm-filter-toggle-text">검색 및 필터</span></button>' +
      '<div id="rm-toolbar-collapsible" class="rm-toolbar-collapsible' + (ui.roadmapFiltersOpen ? ' is-open' : '') + '">' +
      '<div class="rm-field rm-search-field"><label for="rm-search" class="rm-field-lbl">단계 검색</label>' +
      '<div class="rm-search-wrap"><input type="search" id="rm-search" class="rm-input rm-search-input" placeholder="제목·목적·기다리는 이유" value="' + e(ui.roadmapSearch || '') + '" autocomplete="off" data-act="rm-search">' +
      (searchQuery ? '<button type="button" class="rm-clear-btn" data-act="rm-clear-search" aria-label="검색어 지우기">지우기</button>' : '') +
      '</div></div>' +
      '<div class="rm-field rm-track-field"><label for="rm-track" class="rm-field-lbl">트랙</label>' +
      '<select id="rm-track" class="rm-select rm-track-select" data-act="rm-track" aria-label="트랙 필터">' +
      '<option value="all"' + (selectedTrack === 'all' ? ' selected' : '') + '>전체 트랙</option>' +
      Object.keys(trackMap).map(function (tid) {
        return '<option value="' + e(tid) + '"' + (selectedTrack === tid ? ' selected' : '') + '>' + e(tid + ' · ' + trackMap[tid]) + '</option>';
      }).join('') +
      '</select></div>' +
      '<button type="button" class="rm-jump-btn" data-act="rm-attn-jump" aria-label="확인 필요 구역으로 이동">확인 필요 <span class="rm-attn-cnt">' + placement.counts.conditions + '</span></button>' +
      '</div>' +
      '<div class="rm-field rm-status-field"><label for="rm-status" class="rm-field-lbl">상태</label>' +
      '<select id="rm-status" class="rm-select rm-status-select" data-act="rm-status" aria-label="모바일 상태 열 선택">' +
      COLUMNS.map(function (col) {
        var k = col[0], lbl = col[1], cnt = filteredColumns[k].length;
        return '<option value="' + e(k) + '"' + (mobileStatus === k ? ' selected' : '') + '>' + e(lbl + ' · ' + cnt) + '</option>';
      }).join('') +
      '</select></div>' +
      '</div>';

    if (rmReadErrors.length) html += '<p class="rm-banner rm-err" role="alert">' + ic('info', 'ic-sm') + ' 로드맵 저장소 읽기 오류: ' + e(rmReadErrors.join(', ')) + '</p>';
    if (!hasRoadmapsProp || !Array.isArray(vm.roadmaps)) return html + '<p class="rm-banner rm-legacy" role="status">' + ic('info', 'ic-sm') + ' 구세대 데이터 · 이 스냅샷에는 로드맵 레일 필드가 없어 대화별 계획만 표시합니다.</p>' + renderSessionPlans(board, e) + '</div>';
    if (!roadmaps.length) return html + '<div class="rm-empty" role="status">' + ic('list-todo') + '<p class="rm-empty-title">등록된 로드맵 없음</p><p class="rm-empty-sub">roadmap_brief 도구로 로드맵 투영 JSON을 등록하면 트랙과 단계가 여기에 펼쳐집니다.</p></div>' + renderSessionPlans(board, e) + '</div>';

    roadmaps.forEach(function (rm) {
      if (rm.error) {
        var errObj = obj(rm.error), errText = errObj ? (flat(errObj.code) ? '[' + flat(errObj.code) + '] ' : '') + flat(errObj.message) : flat(rm.error);
        html += '<p class="rm-banner rm-err" role="alert" data-rm-error="' + e(rm.roadmapId) + '">' + ic('info', 'ic-sm') + ' 로드맵 오류: ' + e(errText || '상태 수집 실패') + (rm.stages.length ? ' · 이전 유효 구조 보존' : '') + '</p>';
      } else if (rm.stale) {
        html += '<p class="rm-banner rm-stale" role="status" data-rm-stale="' + e(rm.roadmapId) + '">' + ic('clock', 'ic-xs') + ' <span class="chip x-stale">오래됨</span> 마지막 확인 ' + e(hhmm(rm.checkedAt)) + ' · 60초 초과 또는 근거 미갱신으로 착수 가능에서 제외됨</p>';
      }
    });

    if (filteredTotal === 0) {
      html += '<div class="rm-filter-empty" role="status"><p class="rm-filter-empty-title">선택한 조건에 일치하는 단계가 없습니다.</p>' +
        '<p class="rm-filter-empty-desc">검색어 "' + e(searchQuery) + '" 또는 선택한 필터를 지우면 전체 단계를 다시 볼 수 있습니다.</p>' +
        '<button type="button" class="rm-clear-filters-btn" data-act="rm-clear-all-filters">필터 지우기</button></div>';
      return html + renderSessionPlans(board, e) + '</div>';
    }

    // Five kanban columns
    html += '<div class="rm-board" role="region" aria-label="로드맵 단계 상태별 칸반 보드">';
    COLUMNS.forEach(function (col) {
      var k = col[0], lbl = col[1], entries = filteredColumns[k], totalInCol = placement.counts[k];
      var isMobileActive = (k === mobileStatus);
      var colCountText = isFiltered ? '표시 ' + entries.length + ' / 전체 ' + totalInCol : String(entries.length);

      html += '<section class="rm-col rm-col-' + e(k) + (isMobileActive ? ' rm-col-active' : '') + '" data-rm-col="' + e(k) + '" aria-labelledby="rm-col-head-' + e(k) + '">' +
        '<div class="rm-col-head"><h2 id="rm-col-head-' + e(k) + '" class="rm-col-title"><span class="rm-dot rm-dot-' + e(k) + '" aria-hidden="true"></span>' + e(lbl) + '</h2>' +
        '<span class="rm-col-cnt" aria-label="' + e(lbl + ' ' + colCountText) + '">' + e(colCountText) + '</span></div>';

      if (!entries.length) {
        html += '<p class="rm-col-empty">' + (isFiltered ? '이 조건의 단계가 없습니다.' : '이 상태로 확인된 단계가 없습니다.') + '</p>';
      } else {
        html += '<ul class="rm-col-cards">' + entries.map(function (entry) {
          return renderCard(entry, roadmapsById[entry.roadmapId], ctx);
        }).join('') + '</ul>';
      }
      html += '</section>';
    });
    html += '</div>';

    // Separate 확인 필요 region
    var attnItems = filteredAttention.items, attnDiscarded = filteredAttention.discarded;
    var attnCountText = isFiltered
      ? '표시 ' + (attnItems.length + attnDiscarded.length) + ' / 전체 ' + (placement.attention.items.length + placement.attention.discarded.length)
      : String(placement.attention.items.length + placement.attention.discarded.length);

    html += '<section class="rm-attention-region" id="rm-attention" aria-labelledby="rm-attn-title">' +
      '<div class="rm-attn-head"><h2 id="rm-attn-title" class="rm-attn-title"><span class="rm-dot rm-dot-attention" aria-hidden="true"></span>확인 필요</h2>' +
      '<span class="rm-attn-meta" role="status">이 구역 ' + e(attnCountText) + '개 · 상태 근거 부족' +
      (placement.counts.conditions ? ' (전체 확인 필요 조건: ' + placement.counts.conditions + '개)' : '') + '</span></div>';

    if (!attnItems.length && !attnDiscarded.length) {
      html += '<p class="rm-attn-empty">' + (isFiltered ? '이 조건의 확인 필요 단계가 없습니다.' : '확인 필요 단계가 없습니다.') + '</p>';
    } else {
      if (attnItems.length) {
        html += '<ul class="rm-attn-cards">' + attnItems.map(function (entry) {
          return renderCard(entry, roadmapsById[entry.roadmapId], ctx);
        }).join('') + '</ul>';
      }
      if (attnDiscarded.length) {
        html += '<div class="rm-discarded-subblock" aria-labelledby="rm-discarded-title">' +
          '<h3 id="rm-discarded-title" class="rm-discarded-title">폐기·취소 기록 <span class="rm-discarded-cnt">' + attnDiscarded.length + '</span></h3>' +
          '<p class="rm-discarded-note">수용되지 않은 종료 단계 기록입니다.</p>' +
          '<ul class="rm-discarded-cards">' + attnDiscarded.map(function (entry) {
            return renderCard(entry, roadmapsById[entry.roadmapId], ctx);
          }).join('') + '</ul></div>';
      }
    }
    html += '</section>';

    html += renderSessionPlans(board, e) + '<div id="rm-sheet-host">' + (ctx.sheetHtml || '') + '</div></div>';
    return html;
  }

  g.BriefRoadmapView = { FILTERS: FILTERS, COLUMNS: COLUMNS, render: function (model, ui) {
    var paged = g.BriefRoadmapData ? g.BriefRoadmapData.view(model, ui) : model;
    var nav = g.BriefRoadmapData ? g.BriefRoadmapData.controls(paged) : '', body = render(paged, ui);
    // Paging belongs inside the catalogue, after the search/topic tools; detail status follows its heading.
    var footer = body.indexOf('<footer class="rmi-footer">'), heading = body.indexOf('</h1>');
    if (nav && footer >= 0) return body.slice(0, footer) + nav + body.slice(footer);
    if (nav && ui.catalogueSelected && heading >= 0) return body.slice(0, heading + 5) + nav + body.slice(heading + 5);
    return nav + body;
  }, countsOf: countsOf, filterStages: filterStages, progressText: progressText, placeStages: placeStages };
})(typeof globalThis !== 'undefined' ? globalThis : this);
