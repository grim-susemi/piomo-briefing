/* omo-briefing view: pure renderer, classic script (file:// safe, no modules).
 * globalThis.BriefView.renderApp(viewModel, uiState) -> html string.
 * Every piece of model text goes through esc(); the model is untrusted input. */
(function (g) {
  'use strict';

  var TABS = [
    { key: 'wait', label: '나를 기다림' },
    { key: 'run', label: '진행 중' },
    { key: 'done', label: '끝남' }
  ];
  var TAB_BY_LABEL = { '나를 기다림': 'wait', '진행 중': 'run', '끝남': 'done' };
  var STATUS_LABEL = {
    blocked: '막힘',
    needs_decision: '결정 대기',
    recheck: '재확인',
    done: '끝남',
    done_no_evidence: '끝(근거 없음)',
    in_progress: '진행 중'
  };
  var TRUTH = {
    evidence: ['t-evidence', '증거 있음'],
    changed: ['t-changed', '증거 바뀜'],
    gone: ['t-gone', '증거 사라짐'],
    reported: ['t-reported', '보고만 됨'],
    unverified: ['t-unverified', '미확인']
  };
  var APPLIED = { candidate: '후보', live: '실사용 적용', none: '적용 해당 없음' };
  var EXTRA_CHIP = {
    '작업 중': 'x-busy',
    '응답 없음': 'x-dead',
    '보고 없음': 'x-norep',
    '오래됨': 'x-stale',
    '이 대화는 예전 세대라 실시간 상황판을 맡지 않음 · 대화를 재시작하면 최신 상황판이 열림': 'x-stale x-server-stale',
    '기록 읽기 실패': 'x-err',
    '질문 미러 사용 불가': 'x-err',
    '오류 있음': 'x-err',
    '자동 요약': 'x-info',
    '답 자동 줄임': 'x-info'
  };
  var FLOW_MAX = 8;

  function esc(v) {
    return str(v).replace(/[&<>"'`]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c];
    });
  }
  function str(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }
  // own-property lookup: model strings like 'constructor' must not hit Object.prototype
  function own(o, k) { return o && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function safeId(v) { return str(v).replace(/[^A-Za-z0-9_-]/g, '_'); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function toMs(t) {
    if (typeof t === 'number' && isFinite(t)) return t;
    if (typeof t === 'string' && t) { var p = Date.parse(t); return isFinite(p) ? p : null; }
    return null;
  }
  function hhmm(t) {
    var ms = toMs(t);
    if (ms == null) return '--:--';
    var d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function when(t, now) {
    var ms = toMs(t);
    if (ms == null) return '-';
    var d = new Date(ms);
    var n = new Date(toMs(now) == null ? ms : toMs(now));
    var sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return (sameDay ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + hhmm(ms);
  }

  function openDecisions(s) {
    return arr(s.decisions).filter(function (d) { return obj(d) && !d.answered && !d.closed; })
      .sort(function (a, b) { return (num(a.id) || 0) - (num(b.id) || 0); });
  }

  function tabOf(s) {
    if (own(TAB_BY_LABEL, s.tab)) return TAB_BY_LABEL[s.tab];
    if (s.status === 'blocked' || openDecisions(s).length || obj(s.openQuestion)) return 'wait';
    if (s.status === 'done') return 'done';
    return 'run';
  }

  // Server page: the conversation of a decision this page is sending or has sent stays in the tab whose screen showed its
  // card at 보내기 (page.js keeps that tab in ui.answers[id].tab and clears it when the owner changes tabs). Answering its last
  // open decision files it under another tab in the next model; its 보내는 중 -> 전달 대기/전달 중 -> 전달됨 line must stay
  // in front of the owner.
  function heldTab(s, ui) {
    if (ui.live !== true) return '';
    var ds = arr(s.decisions);
    for (var i = 0; i < ds.length; i++) {
      var a = obj(ds[i]) ? obj(own(obj(ui.answers), str(ds[i].id))) : null;
      if (a && (a.phase === 'sending' || a.phase === 'sent') && (a.tab === 'wait' || a.tab === 'run' || a.tab === 'done')) return a.tab;
    }
    return '';
  }

  function normSessions(vm, ui) {
    var list = arr(vm && vm.sessions);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = obj(list[i]);
      if (!s) continue;
      var id = str(s.id) || 'session-' + i;
      out.push({ raw: s, id: id, dom: 'c-' + safeId(id) + '-' + i, tab: heldTab(s, ui) || tabOf(s), project: str(s.project) || '(폴더 모름)' });
    }
    return out;
  }

  // Which conversation: herdr tab label and number when known, else the pane. Plain text; callers escape it.
  function whereLabel(s) {
    var title = str(s.title) || '(제목 없음)';
    var label = str(s.tabLabel);
    if (label) return '🗂 ' + label + (num(s.tabNumber) == null ? '' : ' #' + s.tabNumber) + ' · ' + title;
    return '창 ' + (str(s.paneId) || '모름') + ' · ' + title;
  }

  // [그 창으로 이동]: only in server mode (ui.live) and only when the session has a herdr tab. Result text lives in ui.focus.
  function focusBtn(view, ui) {
    if (!ui.live || !str(view.tabId) || !str(view.sessionId)) return '';
    var res = obj(ui.focus) ? own(ui.focus, view.sessionId) : null;
    return '<button type="button" class="focusbtn" data-act="focus" data-session="' + esc(view.sessionId) + '">그 창으로 이동</button>' +
      (res ? ' <span class="focus-res ' + (res.ok ? 'ok' : 'err') + '">' + esc(res.ok ? '이동했어요' : '이동 실패 - herdr에서 직접 열어 주세요') + '</span>' : '');
  }

  function copyBtn(value) {
    return '<button type="button" class="copy" data-copy="' + esc(value) + '" title="복사">⧉ 복사</button>';
  }

  function chip(cls, label) { return '<span class="chip ' + cls + '">' + esc(label) + '</span>'; }

  function truthChip(item) {
    var t = str(item.truth);
    var state = str(item.evidenceState);
    var key = t === 'evidence' ? (state === 'changed' || state === 'gone' ? state : 'evidence') : (own(TRUTH, t) && t !== 'changed' && t !== 'gone' ? t : 'unverified');
    return chip(TRUTH[key][0], TRUTH[key][1]);
  }
  function appliedChip(item) {
    var a = own(APPLIED, item.applied) ? item.applied : 'candidate';
    return chip('a-' + a, APPLIED[a]);
  }

  function row(kind, item) {
    var it = obj(item) || {};
    var sym = kind === 'done' ? '✔' : '•';
    var html = '<li class="row ' + kind + '"><span class="sym">' + sym + '</span><span class="rt">' + esc(it.text) + '</span>' +
      truthChip(it) + appliedChip(it);
    var ev = str(it.evidence);
    if (ev) html += '<span class="path"><span class="sym">📄</span><code>' + esc(ev) + '</code>' + copyBtn(ev) + '</span>';
    return html + '</li>';
  }

  function moreBtn(key, hidden, expanded) {
    if (!hidden) return '';
    return '<button type="button" class="more" data-act="exp" data-key="' + esc(key) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
      (expanded ? '▴ 접기' : '▾ 외 ' + hidden + '개') + '</button>';
  }

  // recommended option: the decision's recommend when that option exists, else A when it exists
  function recOf(d) {
    var opts = obj(d.options) || {};
    return own({ A: 1, B: 1, C: 1 }, d.recommend) && obj(own(opts, d.recommend)) ? d.recommend : (obj(own(opts, 'A')) ? 'A' : '');
  }

  // ---- answer controls: server page only (ui.live, set by page.js when the served page carries its write token) ----
  // Per-decision page state is ui.answers[id] = {open, draft, confirm: {option}|{text}|null, phase: ''|'sending'|'sent'|'closed',
  // error, tab} (page.js), so a full re-render keeps a pending confirm, the reply draft and the in-flight state. Buttons carry
  // data-act="ans-*" + data-id (decision id) + data-where (dc = decision card, plan = plan Q&A row) for page.js.
  var REPLY_MAX = 500; // page.js uses the same limit; <= 500 UTF-16 units is always within the server's 500 code points
  var ANY_CHAT = '아무 대화창에 붙여넣어도 됩니다';

  // Which conversation an answer goes to, and which window answers an open question: herdr tab label and number when
  // known, else the pane, else the title. One helper for the confirm row and the open-question line. Plain text;
  // callers escape it.
  function whereOf(s) {
    var label = str(s.tabLabel);
    if (label) return '🗂 ' + label + (num(s.tabNumber) == null ? '' : ' #' + s.tabNumber);
    return str(s.paneId) ? '창 ' + str(s.paneId) : (str(s.title) || '(제목 없음)');
  }
  function cut(v, n) {
    var cps = Array.from(str(v));
    return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('');
  }
  function posId(v) { return typeof v === 'number' && isFinite(v) && v >= 1 && Math.floor(v) === v ? v : null; }

  // A/B/C buttons (the recommended one primary), the reply box when the conversation takes free text (answerKinds), the
  // confirm row naming the receiving tab, and the send state / error. '' outside the server page.
  function answerBox(d, s, ui, where) {
    var id = posId(d.id);
    if (!ui || ui.live !== true || id === null || !obj(s)) return '';
    var key = String(id);
    var a = obj(own(ui.answers, key)) || {};
    var phase = str(a.phase);
    var html = '<div class="ans-box" data-ans="' + key + '">';
    if (phase === 'sending' || phase === 'sent') {
      return html + '<p class="ans-state" role="status">' + (phase === 'sending' ? '보내는 중…' : '보냄 · 전달 상태 기다리는 중…') + '</p></div>';
    }
    if (phase === 'closed') return html + '<p class="ans-err" role="alert">' + esc(a.error) + '</p></div>';
    var opts = obj(d.options) || {};
    var rec = recOf(d);
    var conf = obj(a.confirm);
    var canReply = arr(s.answerKinds).indexOf('text') >= 0;
    var at = ' data-id="' + key + '" data-where="' + esc(where) + '"';
    html += '<div class="ans-opts" role="group" aria-label="#' + key + ' 답 고르기">';
    ['A', 'B', 'C'].forEach(function (k) {
      var o = obj(own(opts, k));
      if (!o) return;
      html += '<button type="button" class="ans-opt' + (k === rec ? ' is-rec' : '') + '" data-act="ans-pick" data-opt="' + k + '"' + at +
        ' aria-pressed="' + (conf && conf.option === k ? 'true' : 'false') + '"><b>' + k + '</b> · ' + esc(o.text) +
        (k === rec ? ' <span class="ans-rec">추천</span>' : '') + '</button>';
    });
    if (canReply) html += '<button type="button" class="ans-write" data-act="ans-reply"' + at + ' aria-expanded="' + (a.open && !conf ? 'true' : 'false') + '">✍ 답글</button>';
    html += '</div>';
    if (conf) {
      var reply = typeof conf.text === 'string';
      html += '<div class="ans-confirm" role="group" aria-label="보내기 확인"><span class="ans-q">' + esc(whereOf(s)) + ' 대화에 ' +
        (reply ? '답글을 보낼까요? <q class="ans-quote">' + esc(cut(conf.text, 40)) + '</q>' : '<b>' + esc(conf.option) + '</b>를 보낼까요?') + '</span>' +
        '<span class="ans-acts"><button type="button" class="ans-go" data-act="ans-send"' + at + '>보내기</button>' +
        '<button type="button" class="ans-cancel" data-act="ans-cancel"' + at + '>취소</button></span></div>';
    } else if (canReply && a.open) {
      var draft = str(a.draft);
      html += '<div class="ans-reply"><textarea class="ans-text" data-draft="' + key + '" data-where="' + esc(where) + '" maxlength="' + REPLY_MAX +
        '" rows="3" aria-label="#' + key + ' 답글">' + esc(draft) + '</textarea><div class="ans-foot">' +
        '<span class="ans-hint">채팅에 직접 친 말과 같아요 (승인 포함)</span><span class="ans-count">' + draft.length + '/' + REPLY_MAX + '</span>' +
        '<button type="button" class="ans-go" data-act="ans-text"' + at + '>보내기</button></div></div>';
    }
    if (str(a.error)) html += '<p class="ans-err" role="alert">' + esc(a.error) + '</p>';
    return html + '</div>';
  }

  // Answered decisions the server page keeps on the card: every answer without a delivery proof yet, plus the ones this page
  // is sending or has sent itself, 전달됨 included, so a board answer is followed from 보내는 중 to the delivery text of
  // render.mjs on the card (which heldTab keeps on the owner's screen meanwhile).
  function sentDecisions(s, ui) {
    return arr(s.decisions).filter(function (d) {
      if (!obj(d) || !d.answered) return false;
      var a = obj(own(ui.answers, str(d.id)));
      return !obj(d.receipt) || (!!a && (a.phase === 'sending' || a.phase === 'sent'));
    }).sort(function (a, b) { return (num(a.id) || 0) - (num(b.id) || 0); });
  }
  function sentLine(d) {
    var a = obj(d.answer) || {};
    var opt = str(a.option), reply = str(a.text);
    var o = opt ? obj(own(obj(d.options) || {}, opt)) : null;
    var what = opt ? '답 ' + esc(opt) + (o && str(o.text) ? ' · ' + esc(o.text) : '')
      : reply ? '답글 <q class="ans-quote">' + esc(cut(reply, 40)) + '</q>' : '답 받음';
    return '<p class="dsent"><span class="sym">✅</span><span>#' + esc(d.id) + ' ' + what + '</span>' +
      chip(obj(d.receipt) ? 's-done' : 'x-busy', str(d.delivery) || '전달 기다림') + '</p>';
  }

  // plan Q&A rows (plan-view.js) draw the same controls for their open decision, wherever that decision's conversation is
  function planAnswerBox(ui) {
    if (ui.live !== true) return null;
    return function (decisionId) {
      var hit = own(ui.decs, str(decisionId));
      return hit && !hit.d.answered && !hit.d.closed ? answerBox(hit.d, hit.s, ui, 'plan') : '';
    };
  }
  function decisionIndex(sessions) {
    var out = Object.create(null);
    sessions.forEach(function (n) {
      arr(n.raw.decisions).forEach(function (d) {
        if (obj(d) && posId(d.id) !== null) out[String(d.id)] = { d: d, s: n.raw };
      });
    });
    return out;
  }

  function decisionCard(d, s, ui, owner) {
    var id = str(d.id) || '?';
    var opts = obj(d.options) || {};
    var rec = recOf(d);
    var answer = '/decide ' + id + rec;
    var box = answerBox(d, owner, ui, 'dc');
    var html = '<div class="dcard' + (d.blocks ? ' blocks' : '') + (box ? ' can-answer' : '') + '" data-decision="' + esc(id) + '">' +
      '<div class="dline dq">#' + esc(id) + ' <span class="tag">[' + esc(s.workName || s.title) + ']</span> <b>' + esc(d.question) + '</b>' +
      (d.blocks ? ' <span class="chip x-block">막는 결정</span>' : '') + '</div>';
    ['A', 'B', 'C'].forEach(function (k) {
      var o = obj(own(opts, k));
      if (!o) return;
      html += '<div class="dline opt' + (k === rec ? ' rec-opt' : '') + '"><b>' + k + ':</b> ' + esc(o.text) + ' <span class="arrow">=&gt;</span> ' + esc(o.consequence) + '</div>';
    });
    html += '<div class="dline rec">추천: ' + esc(rec || '-') + ' - ' + esc(d.reason) + '</div>' +
      '<div class="dline from">대화: ' + esc(whereLabel(s)) + '</div>' +
      '<div class="dline when">⏱ ' + esc(when(d.createdAt, s.__now)) + '</div>' + box +
      (box ? '<div class="dline ans">답: <code>' + esc(answer) + '</code> ' + copyBtn(answer) + ' <span class="ans-hint">· ' + ANY_CHAT + '</span></div>'
        : '<div class="dline ans">답: ' + esc(answer) + ' ' + copyBtn(answer) + '</div>') +
      '</div><!--dcard-->';
    return html;
  }

  function flowSvg(steps, narrow) {
    var n = steps.length;
    if (!n) return '';
    var maxLen = 0;
    steps.forEach(function (st) { maxLen = Math.max(maxLen, Array.from(str(st.label)).length); });
    var w = Math.max(72, Math.min(200, maxLen * 13 + 18));
    var h = 30, gap = 26, rowGap = 22;
    var perRow = narrow ? Math.ceil(n / 2) : n;
    var rows = Math.ceil(n / perRow);
    var W = perRow * w + (perRow - 1) * gap + 2;
    var H = rows * h + (rows - 1) * rowGap + 2;
    var out = '<svg class="flow ' + (narrow ? 'flow-narrow' : 'flow-wide') + '" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="단계 흐름">';
    for (var i = 0; i < n; i++) {
      var r = Math.floor(i / perRow), c = i % perRow;
      var x = 1 + c * (w + gap), y = 1 + r * (h + rowGap);
      var state = own({ done: 1, doing: 1, todo: 1, blocked: 1 }, steps[i].state) ? steps[i].state : 'todo';
      out += '<rect class="f-' + state + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="6"></rect>';
      out += '<text x="' + (x + w / 2) + '" y="' + (y + h / 2 + 4) + '" text-anchor="middle">' + esc(steps[i].label) + '</text>';
      if (i < n - 1) {
        if (c < perRow - 1) {
          var ax = x + w + 2, ay = y + h / 2;
          out += '<path class="f-arrow" d="M' + ax + ' ' + ay + ' H' + (ax + gap - 8) + '"></path>' +
            '<path class="f-head" d="M' + (ax + gap - 9) + ' ' + (ay - 4) + ' L' + (ax + gap - 3) + ' ' + ay + ' L' + (ax + gap - 9) + ' ' + (ay + 4) + ' Z"></path>';
        } else {
          var bx = x + w / 2, by = y + h + 1, ex = 1 + w / 2, ey = y + h + rowGap - 2;
          out += '<path class="f-arrow" d="M' + bx + ' ' + by + ' V' + (by + rowGap / 2 - 1) + ' H' + ex + ' V' + (ey - 5) + '"></path>' +
            '<path class="f-head" d="M' + (ex - 4) + ' ' + (ey - 6) + ' L' + ex + ' ' + ey + ' L' + (ex + 4) + ' ' + (ey - 6) + ' Z"></path>';
        }
      }
    }
    return out + '</svg>';
  }

  function detail(s, now) {
    var html = '<div class="detail">';
    var done = arr(s.done);
    html += '<p class="lbl">✔ 끝낸 일 ' + done.length + '개</p>';
    html += done.length ? '<ul class="rows">' + done.map(function (d) { return row('done', d); }).join('') + '</ul>' : '<p class="muted">• 아직 없음</p>';
    if (str(s.next)) html += '<p class="kv"><span class="sym">➜</span>다음: ' + esc(s.next) + '</p>';
    var steps = arr(s.flow).filter(obj).slice(0, FLOW_MAX);
    if (steps.length) html += '<p class="lbl">➜ 단계 흐름</p><div class="flowbox">' + flowSvg(steps, false) + flowSvg(steps, true) + '</div>';
    var auto = obj(s.auto);
    if (auto) {
      var w = obj(auto.workers) || {};
      html += '<p class="lbl">⚙ 자동 정보 <span class="muted">(절차 진행, 목표 달성 아님)</span></p>' +
        '<p class="kv"><span class="sym">•</span>작업: [' + esc(s.workName || '-') + '] · 단계 ' + esc(auto.stage || '-') + '</p>' +
        '<p class="kv"><span class="sym">•</span>todo 현재: ' + esc(auto.todoCurrent || '-') + ' · 다음: ' + esc(auto.todoNext || '-') +
        ' · ' + esc(num(auto.todoDone) == null ? '-' : auto.todoDone) + '/' + esc(num(auto.todoTotal) == null ? '-' : auto.todoTotal) + '</p>' +
        '<p class="kv"><span class="sym">•</span>작업자 실행 ' + esc(num(w.running) || 0) + ' · 완료 ' + esc(num(w.done) || 0) + ' · 오류 ' + esc(num(w.error) || 0) + '</p>';
    }
    arr(s.decisions).filter(function (d) { return obj(d) && d.answered; }).forEach(function (d) {
      var rc = obj(d.receipt);
      html += '<p class="kv"><span class="sym">✅</span>#' + esc(d.id) + ' 답 받음' + (rc ? ' · 전달됨 ⏱ ' + esc(when(rc.deliveredAt, now)) : ' · ' + esc(str(d.delivery) || '전달 기다림')) + '</p>';
    });
    if (str(s.cwd)) html += '<p class="kv path"><span class="sym">📁</span><code>' + esc(s.cwd) + '</code>' + copyBtn(s.cwd) + '</p>';
    return html + '</div>';
  }

  // Worker lines and plan block of a card. The block renderers are separate classic scripts (workers-view.js, plan-view.js);
  // a page without them (older generation, unit tests of this file) simply draws the card without these blocks.
  function liveBlocks(s, n, ui, now) {
    var html = '';
    var wv = g.BriefWorkersView, pv = g.BriefPlanView;
    var live = obj(s.live);
    if (wv && live && arr(live.workers).length) {
      // the pulse phase and elapsed text follow the wall clock, not the age of the data (workers-view.js)
      html += wv.render(live, typeof ui.wallNow === 'number' ? ui.wallNow : Date.now(), { esc: esc, expanded: ui.expanded });
    }
    if (pv) {
      var plan = obj(s.plan), link = obj(s.planLink);
      if (plan) html += '<div class="plan-slot">' + pv.render(plan, now, { esc: esc, expanded: ui.expanded, answerBox: planAnswerBox(ui) }) + '</div>';
      else if (link) {
        var owner = ui.byId ? own(ui.byId, str(link.ownerId)) : null;
        var target = owner ? { target: owner.dom, tab: owner.tab } : {};
        html += '<div class="plan-slot">' + pv.renderLink(Object.assign({}, link, target), { esc: esc }) + '</div>';
      }
    }
    return html;
  }

  function card(n, ui, now) {
    var live = !!ui.live, focus = ui.focus;
    var s = n.raw;
    var expanded = ui.expanded;
    var key = str(s.statusKey) || (s.status === 'blocked' ? 'blocked' : s.status === 'done' ? 'done' : 'in_progress');
    if (!own(STATUS_LABEL, key)) key = 'in_progress';
    var extra = arr(s.chips).filter(function (c) { return typeof c === 'string'; });
    if (s.autoSummary) extra.push('자동 요약');
    if (s.answerTrimmed) extra.push('답 자동 줄임');
    var view = { title: str(s.title) || '(제목 없음)', workName: str(s.workName), paneId: str(s.paneId), tabLabel: str(s.tabLabel), tabNumber: num(s.tabNumber), tabId: str(s.tabId), sessionId: str(s.id), __now: now };
    var fview = view;

    var html = '<article class="card st-' + key + '" id="' + n.dom + '" data-card="' + esc(n.id) + '">' +
      '<div class="ch">' + chip('s-' + key, STATUS_LABEL[key]) +
      extra.map(function (c) {
        if (own(EXTRA_CHIP, c) === 'x-stale x-server-stale') return '<span class="chip x-stale x-server-stale" style="white-space:normal;word-break:keep-all;overflow-wrap:anywhere" title="설치된 상황판보다 예전 세대인 대화입니다. 대화를 재시작하면 최신 세대가 실시간 상황판을 맡습니다.">' + esc(c) + '</span>';
        return chip(own(EXTRA_CHIP, c) || 'x-info', c);
      }).join('') +
      (view.workName ? '<span class="tag">[' + esc(view.workName) + ']</span>' : '') +
      '<span class="title">' + esc(whereLabel(view)) + '</span>' + focusBtn(fview, { live: live, focus: focus }) +
      '<span class="time">⏱ ' + esc(when(s.lastActivityAt != null ? s.lastActivityAt : s.lastBriefAt, now)) + '</span></div>' +
      '<p class="hl"><span class="sym">▸</span>' + esc(s.headline || '아직 보고 없음') + '</p>';
    html += liveBlocks(s, n, ui, now);

    var q = obj(s.openQuestion);
    if (q) {
      // Read-only alert: say where the question lives. Pane = the mirror's own paneId, else (older records) the session's pane.
      var qPane = str(q.paneId) || str(s.paneId);
      var tabbed = !!str(view.tabLabel);
      html += '<p class="oq"><span class="sym">❓</span>질문 알림 열림 - ' +
        (tabbed ? '답할 창: <code>' + esc(whereOf(view)) + '</code>' : qPane ? '<code>' + esc(qPane) + '</code>에서 답하기' : '질문이 뜬 창에서 답하기') + ' (읽기 전용): ' + esc(q.text) +
        ' <span class="time">⏱ ' + esc(when(q.at, now)) + '</span> ' + focusBtn(fview, { live: live, focus: focus }) + '</p>';
    }

    var changes = arr(s.changes);
    if (changes.length) {
      var kc = 'more-ch:' + n.id, oc = !!own(expanded, kc);
      html += '<div class="blk"><p class="lbl">' + (s.changesNew ? '✚ 새로 바뀜' : '↻ 최근 변화') + '</p><ul class="rows">' +
        changes.slice(0, oc ? changes.length : 3).map(function (c) { return row('chg', c); }).join('') + '</ul>' +
        moreBtn(kc, Math.max(0, changes.length - 3), oc) + '</div>';
    }
    var decs = openDecisions(s);
    var sent = ui.live === true ? sentDecisions(s, ui) : [];
    if (decs.length || sent.length) {
      var kd = 'more-dc:' + n.id, od = !!own(expanded, kd);
      html += '<div class="decs">' + sent.map(sentLine).join('') +
        decs.slice(0, od ? decs.length : 2).map(function (d) { return decisionCard(d, view, ui, s); }).join('') +
        moreBtn(kd, Math.max(0, decs.length - 2), od) + '</div>';
    }
    var kx = 'detail:' + n.id, ox = !!own(expanded, kx);
    html += '<button type="button" class="detail-btn" data-act="exp" data-key="' + esc(kx) + '" aria-expanded="' + (ox ? 'true' : 'false') + '">' +
      (ox ? '▴ 자세히 닫기' : '▾ 자세히') + '</button>';
    if (ox) html += detail(s, now);
    return html + '</article>';
  }

  function groupByProject(list) {
    var order = [], map = new Map();
    list.forEach(function (n) {
      if (!map.has(n.project)) { map.set(n.project, []); order.push(n.project); }
      map.get(n.project).push(n);
    });
    return order.map(function (p) { return { project: p, items: map.get(p) }; });
  }

  var LEGEND = [
    ['t-evidence', '증거 있음', '적어 둔 파일이 그때와 같은 내용으로 있음(다시 실행해 확인한 것은 아님)'],
    ['t-changed', '증거 바뀜', '적어 둔 파일 내용이 그때와 다름'],
    ['t-gone', '증거 사라짐', '적어 둔 파일이 없어짐'],
    ['t-reported', '보고만 됨', '에이전트가 말했을 뿐'],
    ['t-unverified', '미확인', '확인한 사람도 증거도 없음'],
    ['a-candidate', '후보', '실사용에 안 올림'],
    ['a-none', '적용 해당 없음', '조사·문서처럼 실사용에 올릴 것이 없는 항목'],
    ['a-live', '실사용 적용', '에이전트가 실사용에 올렸다고 기록함'],
    ['x-info', '자동 요약', '보고 도구 없이 마지막 답에서 잘라온 것'],
    ['x-info', '답 자동 줄임', 'AI가 줄여 쓰지 못해 확장이 잘라 맞춘 답(나머지는 상황판)'],
    ['x-err', '오류 있음', '이 대화를 처리하다 오류가 났음(예: 다른 곳이 상황판을 쓰는 중이라 갱신을 건너뜀). 다음에 잘 처리되면 사라짐']
  ];

  function renderApp(viewModel, uiState) {
    var vm = obj(viewModel) || {};
    var ui = obj(uiState) || {};
    var expanded = obj(ui.expanded) || {};
    var now = toMs(vm.generatedAt);
    var sessions = normSessions(vm, ui);
    var byTab = { wait: [], run: [], done: [] };
    sessions.forEach(function (n) { byTab[n.tab].push(n); });
    var tab = own(byTab, ui.tab) ? ui.tab : (byTab.wait.length ? 'wait' : byTab.run.length ? 'run' : sessions.length ? 'done' : 'wait');
    var byId = Object.create(null);
    sessions.forEach(function (n) { byId[n.id] = n; });
    var uiN = { expanded: expanded, byId: byId, wallNow: num(ui.wallNow), live: !!ui.live, focus: obj(ui.focus) };

    var openCount = 0, blocked = 0, stale = 0;
    sessions.forEach(function (n) {
      openCount += openDecisions(n.raw).length;
      if (n.raw.statusKey === 'blocked' || n.raw.status === 'blocked') blocked++;
      if (arr(n.raw.chips).indexOf('오래됨') >= 0) stale++;
    });
    // answer controls (server page): page state per decision (page.js) and decision id -> {d, s} for the plan Q&A rows
    uiN.live = ui.live === true;
    uiN.answers = obj(ui.answers) || {};
    uiN.decs = decisionIndex(sessions);

    // left sidebar: 3 tabs, each with project -> conversation links
    var nav = '<nav class="toc' + (ui.tocOpen ? ' open' : '') + '" aria-label="목차">' +
      '<button type="button" class="toc-toggle" data-act="toc" aria-expanded="' + (ui.tocOpen ? 'true' : 'false') + '">☰ 목차</button>' +
      '<div class="toc-body"><div role="tablist" aria-orientation="vertical">';
    TABS.forEach(function (t) {
      var list = byTab[t.key];
      var active = t.key === tab;
      var open = active || t.key !== 'done' || !!ui.doneOpen;
      nav += '<div class="tabgrp' + (active ? ' active' : '') + '">' +
        '<button type="button" role="tab" class="tab" id="tab-' + t.key + '" data-act="tab" data-tab="' + t.key + '" aria-selected="' + (active ? 'true' : 'false') + '">' +
        esc(t.label) + ' <span class="n">' + list.length + '</span></button>';
      if (open && list.length) {
        nav += '<ul class="toclist">';
        groupByProject(list).forEach(function (grp) {
          nav += '<li class="proj">📁 ' + esc(grp.project) + '</li>';
          grp.items.forEach(function (n) {
            nav += '<li><a class="toclink" href="#' + n.dom + '" data-goto="' + n.dom + '" data-tab="' + t.key + '">' +
              (str(n.raw.workName) ? '<span class="tag">[' + esc(n.raw.workName) + ']</span> ' : '') + esc(whereLabel(n.raw)) + '</a></li>';
          });
        });
        nav += '</ul>';
      }
      nav += '</div>';
    });
    nav += '</div></div></nav>';

    var main = '<main class="main"><header class="sum">' +
      '<p class="sumline">결정 대기 ' + openCount + ' · 막힘 ' + blocked + ' · 오래됨 ' + stale + ' · ⏱ 마지막 갱신 ' + hhmm(now) + '</p>' +
      '<p class="note">브리핑이 켜진 대화 ' + sessions.length + '개만 보입니다 - 설치 전부터 열려 있던 대화는 새로 열어야 나타납니다</p>' +
      (g.BriefAlarm ? '<p class="sum-tools">' + g.BriefAlarm.soundButtonHtml() + '</p>' : '') + '</header>';

    var label = TABS.filter(function (t) { return t.key === tab; })[0].label;
    main += '<section class="tabpanel" role="tabpanel" aria-labelledby="tab-' + tab + '" data-tab="' + tab + '"><h2>' + esc(label) + '</h2>';
    if (!sessions.length) {
      main += '<div class="empty"><p class="big">아직 보고 없음</p><p class="muted">• 브리핑이 켜진 대화가 작업 턴을 끝내면 여기에 카드가 생깁니다</p></div>';
    } else if (!byTab[tab].length) {
      main += '<p class="empty muted">• 이 탭에 해당하는 대화가 없습니다</p>';
    } else {
      if (!ui.live && openCount) main += '<p class="note ro">이 페이지는 보기 전용입니다 - 답은 아무 대화창에 /decide 로, 또는 실시간 상황판에서</p>';
      groupByProject(byTab[tab]).forEach(function (grp) {
        main += '<h3 class="projh">📁 ' + esc(grp.project) + '</h3>';
        grp.items.forEach(function (n) { main += card(n, uiN, now); });
      });
    }
    main += '</section>';

    main += '<section class="legend"><button type="button" class="legend-btn" data-act="legend" aria-expanded="' + (ui.legendOpen ? 'true' : 'false') + '">ℹ 표시 뜻 ' + (ui.legendOpen ? '▴' : '▾') + '</button>' +
      '<ul class="legend-list"' + (ui.legendOpen ? '' : ' hidden') + '>' +
      LEGEND.map(function (l) { return '<li>' + chip(l[0], l[1]) + ' = ' + esc(l[2]) + '</li>'; }).join('') + '</ul></section></main>';

    return '<div class="app" data-tab="' + tab + '">' + nav + main + '</div>';
  }

  g.BriefView = { renderApp: renderApp, escapeHtml: esc, TABS: TABS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
