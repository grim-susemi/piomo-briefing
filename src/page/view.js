/* omo-briefing view: pure renderer, classic script (file:// safe, no modules).
 * globalThis.BriefView.renderOverview(viewModel, uiState) -> html string.
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
  // a Lucide icon from the page's sprite (icons.js); '' without icons.js (this file's unit tests)
  function ic(name, cls) { var m = g.BriefIcons; return m ? m.icon(name, cls) : ''; }
  // render.mjs's status text ('전달됨 <stopwatch>09:12'), escaped, with the clock icon for its stopwatch
  function timed(v) { var m = g.BriefIcons; return m ? m.timed(str(v)) : esc(v); }

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

  // Which conversation: herdr tab label and number when known, else the pane. Plain text (tooltips); callers escape it.
  // whereLabelHtml: the same on the page, a tab label behind the tab icon.
  function whereLabel(s) {
    var title = str(s.title) || '(제목 없음)';
    var label = str(s.tabLabel);
    if (label) return label + (num(s.tabNumber) == null ? '' : ' #' + s.tabNumber) + ' · ' + title;
    return '창 ' + (str(s.paneId) || '모름') + ' · ' + title;
  }
  function whereLabelHtml(s, cls) { return (str(s.tabLabel) ? ic('app-window', cls) + ' ' : '') + esc(whereLabel(s)); }

  // [그 창으로 이동]: only in server mode (ui.live) and only when the session has a herdr tab. Result text lives in ui.focus.
  function focusBtn(view, ui) {
    if (!ui.live || !str(view.tabId) || !str(view.sessionId)) return '';
    var res = obj(ui.focus) ? own(ui.focus, view.sessionId) : null;
    return '<button type="button" class="focusbtn" data-act="focus" data-session="' + esc(view.sessionId) + '">그 창으로 이동</button>' +
      (res ? ' <span class="focus-res ' + (res.ok ? 'ok' : 'err') + '">' + esc(res.ok ? '이동했어요' : '이동 실패 - herdr에서 직접 열어 주세요') + '</span>' : '');
  }

  // The button names itself: Chrome leaves the role=status label out of the button's name, and page.js rewrites that
  // label with the copy result (복사됨 / 복사 실패) - feedback, not the name.
  function copyBtn(value) {
    return '<button type="button" class="copy" data-copy="' + esc(value) + '" aria-label="복사" title="복사">' + ic('copy', 'ic-xs') + ' <span data-copy-label role="status">복사</span></button>';
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
    var sym = ic(kind === 'done' ? 'check' : 'plus', 'ic-sm');
    var html = '<li class="row ' + kind + '"><span class="sym">' + sym + '</span><span class="rt">' + esc(it.text) + '</span>' +
      truthChip(it) + appliedChip(it);
    var ev = str(it.evidence);
    if (ev) html += '<span class="path"><span class="sym">' + ic('file-text', 'ic-sm') + '</span><code>' + esc(ev) + '</code>' + copyBtn(ev) + '</span>';
    return html + '</li>';
  }

  function moreBtn(key, hidden, expanded) {
    if (!hidden) return '';
    return '<button type="button" class="more" data-act="exp" data-key="' + esc(key) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
      ic(expanded ? 'chevron-down' : 'chevron-right', 'ic-xs') + ' ' + (expanded ? '접기' : '외 ' + hidden + '개') + '</button>';
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
  // known, else the pane, else the title. One helper for the confirm row and the open-question line: whereOfHtml draws
  // it, a tab label behind the tab icon; whereOf is its plain text.
  function whereOf(s) {
    var label = str(s.tabLabel);
    if (label) return label + (num(s.tabNumber) == null ? '' : ' #' + s.tabNumber);
    return str(s.paneId) ? '창 ' + str(s.paneId) : (str(s.title) || '(제목 없음)');
  }
  function whereOfHtml(s) { return (str(s.tabLabel) ? ic('app-window') + ' ' : '') + esc(whereOf(s)); }
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
    if (Array.isArray(d.fields)) {
      html += fieldsBox(d, a, at, key, where);
      if (conf) html += confirmRow(key, s, conf, where);
      if (str(a.error)) html += '<p class="ans-err" role="alert">' + esc(a.error) + '</p>';
      return html + '</div>';
    }
    html += '<div class="ans-opts" role="group" aria-label="#' + key + ' 답 고르기">';
    ['A', 'B', 'C'].forEach(function (k) {
      var o = obj(own(opts, k));
      if (!o) return;
      html += '<button type="button" class="ans-opt' + (k === rec ? ' is-rec' : '') + '" data-act="ans-pick" data-opt="' + k + '"' + at +
        ' aria-pressed="' + (conf && conf.option === k ? 'true' : 'false') + '"><b>' + k + '</b> · ' + esc(o.text) +
        (k === rec ? ' <span class="ans-rec">추천</span>' : '') + '</button>';
    });
    if (canReply) html += '<button type="button" class="ans-write" data-act="ans-reply"' + at + ' aria-expanded="' + (a.open && !conf ? 'true' : 'false') + '">' + ic('pencil') + ' 답글</button>';
    html += '<button type="button" class="ans-write" data-act="ans-hold"' + at + '>보류</button>';
    html += '</div>';
    if (conf) {
      html += confirmRow(key, s, conf, where);
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

  function fieldsBox(d, a, at, key, where) {
    var values = obj(a.values) || {}, errors = obj(a.fieldErrors) || {};
    var html = '<div class="ans-fields" role="group" aria-label="입력 값"><div class="ans-field-grid">';
    function feedbackText(message) {
      return esc(message).replace(/(범위로 입력해 주세요|간격으로 입력해 주세요|입력해 주세요|골라 주세요|보낼 수 없어요)/g,
        '<span class="ans-error-phrase">$1</span>');
    }
    arr(d.fields).forEach(function (f) {
      var id = 'field-' + key + '-' + where + '-' + f.id, error = str(own(errors, f.id));
      var value = own(values, f.id), text = value == null ? '' : String(value);
      var attrs = at + ' data-field="' + esc(f.id) + '" aria-describedby="' + esc(id) + '-hint' +
        (error ? ' ' + esc(id) + '-error' : '') + '" aria-invalid="' + !!error + '"';
      html += '<div class="ans-field">';
      if (f.kind === 'choice' && arr(f.options).length <= 3) {
        html += '<fieldset><legend>' + esc(f.label) + '</legend><div class="ans-choices">';
        arr(f.options).forEach(function (option, i) {
          html += '<label><input type="radio" name="' + esc(id) + '" id="' + esc(id) + '-' + i + '" value="' + esc(option) + '"' + attrs +
            (text === option ? ' checked' : '') + '><span>' + esc(option) + '</span></label>';
        });
        html += '</div></fieldset>';
      } else {
        html += '<label for="' + esc(id) + '">' + esc(f.label) + '</label>';
        if (f.kind === 'choice') {
          html += '<select id="' + esc(id) + '"' + attrs + '><option value="">선택해 주세요</option>';
          arr(f.options).forEach(function (option) { html += '<option value="' + esc(option) + '"' + (text === option ? ' selected' : '') + '>' + esc(option) + '</option>'; });
          html += '</select>';
        } else html += '<input id="' + esc(id) + '" type="' + (f.kind === 'number' ? 'number' : 'text') + '"' + attrs +
          (f.kind === 'number' ? ' inputmode="decimal" min="' + esc(String(f.min)) + '" max="' + esc(String(f.max)) + '" step="' + esc(String(f.step)) + '"'
            : ' maxlength="' + esc(f.maxLen * 2) + '"') + ' value="' + esc(text) + '" placeholder="' +
          esc(f.kind === 'number' ? String(f.min) + '..' + String(f.max) : f.label + ' 입력') + '">';
      }
      // Reserve the largest wrapped message in this field's current font and width, even before an error exists.
      // Hidden sizing text is not an announcement or a description; the visible hint/error share its grid cell.
      var messages = ['같은 입력 항목을 두 번 보낼 수 없어요'];
      if (f.kind === 'number') messages.push('숫자를 입력해 주세요', f.min + '..' + f.max + ' 범위로 입력해 주세요',
        f.min + '부터 ' + f.step + ' 간격으로 입력해 주세요');
      else messages.push(f.kind === 'text' ? '1..' + f.maxLen + '자로 입력해 주세요' : '선택지 중 하나를 골라 주세요');
      html += '<div class="ans-feedback' + (error ? ' is-invalid' : '') + '">' + messages.map(function (message) {
        return '<span class="ans-feedback-size" aria-hidden="true">' + feedbackText(message) + '</span>';
      }).join('') + '<span class="ans-hint" id="' + esc(id) + '-hint">' +
        esc(f.kind === 'number' ? String(f.min) + '..' + String(f.max) + ' · 간격 ' + String(f.step) : f.kind === 'text' ? '최대 ' + f.maxLen + '자' : '하나를 골라 주세요') + '</span>' +
        (error ? '<p class="ans-err" role="alert" id="' + esc(id) + '-error">' + feedbackText(error) + '</p>' : '') + '</div></div>';
    });
    return html + '</div><div class="ans-acts"><button type="button" class="' + (a.confirm ? 'ans-cancel' : 'ans-go') + '" data-act="ans-fields"' + at + '>입력 확인</button>' +
      '<button type="button" class="ans-write" data-act="ans-hold"' + at + '>보류</button></div></div>';
  }

  // The pending confirm: '<tab> 대화에 <b>B</b>를 보낼까요?' (or the reply's first 40 characters), with 보내기 and 취소 for decision
  // id. answerBox draws it under the A/B/C buttons; convo-view.js draws the same row in a report's picked option (이걸로 고르기).
  function confirmRow(id, s, conf, where) {
    var at = ' data-id="' + esc(id) + '" data-where="' + esc(where) + '"';
    if (conf.hold === true) { // 보류 (C-HOLD 5): the same row, 보류 / 취소
      return '<div class="ans-confirm ans-hold-confirm" role="group" aria-label="보류 확인"><span class="ans-q">' + whereOfHtml(s) + ' 대화의 #' + esc(id) +
        '를 보류할까요? 대화는 다시 묻지 않아요</span><span class="ans-acts"><button type="button" class="ans-go" data-act="ans-send"' + at + '>보류</button>' +
        '<button type="button" class="ans-cancel" data-act="ans-cancel"' + at + '>취소</button></span></div>';
    }
    var reply = typeof conf.text === 'string';
    var values = obj(conf.values);
    return '<div class="ans-confirm" role="group" aria-label="보내기 확인"><span class="ans-q">' + whereOfHtml(s) + ' 대화에 ' +
      (values ? '<span class="ans-prompt">이 값을 보낼까요?</span> <span class="ans-values">' + arr(conf.labels).map(function (f, i) {
        return '<span>' + (i ? ' · ' : '') + '<b>' + esc(f.label) + '</b> = <span class="ans-value">' + esc(String(own(values, f.id))) + '</span></span>';
      }).join('') + '</span>' : reply ? '답글을 보낼까요? <q class="ans-quote">' + esc(cut(conf.text, 40)) + '</q>' : '<b>' + esc(conf.option) + '</b>를 보낼까요?') + '</span>' +
      '<span class="ans-acts"><button type="button" class="ans-go" data-act="ans-send"' + at + '>보내기</button>' +
      '<button type="button" class="ans-cancel" data-act="ans-cancel"' + at + '>' + (values ? '고치기' : '취소') + '</button></span></div>';
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
      : obj(a.values) ? '입력: ' + arr(d.fields).map(function (f) { return esc(f.label) + '=' + esc(String(own(a.values, f.id))); }).join(', ')
      : reply ? '답글 <q class="ans-quote">' + esc(cut(reply, 40)) + '</q>' : '답 받음';
    return '<p class="dsent"><span class="sym">' + ic('circle-check', 'ic-sm') + '</span><span>#' + esc(d.id) + ' ' + what + '</span>' +
      '<span class="chip ' + (obj(d.receipt) ? 's-done' : 'x-busy') + '">' + timed(str(d.delivery) || '전달 기다림') + '</span></p>';
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
    var fields = Array.isArray(d.fields);
    var box = answerBox(d, owner, ui, 'dc');
    var html = '<div class="dcard' + (d.blocks ? ' blocks' : '') + (box ? ' can-answer' : '') + '" data-decision="' + esc(id) + '">' +
      '<div class="dline dq">#' + esc(id) + ' <span class="tag">[' + esc(s.workName || s.title) + ']</span> <b>' + esc(d.question) + '</b>' +
      (d.blocks ? ' <span class="chip x-block">막는 결정</span>' : '') + '</div>';
    ['A', 'B', 'C'].forEach(function (k) {
      var o = obj(own(opts, k));
      if (!o) return;
      html += '<div class="dline opt' + (k === rec ? ' rec-opt' : '') + '"><b>' + k + ':</b> ' + esc(o.text) + ' <span class="arrow">=&gt;</span> ' + esc(o.consequence) + '</div>';
    });
    html += '<div class="dline rec">' + (fields ? '입력 안내: ' : '추천: ' + esc(rec || '-') + ' - ') + esc(d.reason) + '</div>' +
      '<div class="dline from">대화: ' + whereLabelHtml(s, 'ic-xs') + '</div>' +
      '<div class="dline when">' + ic('clock', 'ic-xs') + ' ' + esc(when(d.createdAt, s.__now)) + '</div>' + box +
      (d.askLive === true ? '<p class="ask-live">터미널에도 같은 질문이 열려 있어요 - 어느 쪽에서 답해도 둘 다 닫혀요</p>' : '') +
      (fields ? '<div class="dline ans">입력 값은 실시간 상황판에서 확인\u00a0후\u00a0보내세요</div>' : box ? '<div class="dline ans">답: <code>' + esc(answer) + '</code> ' + copyBtn(answer) + ' <span class="ans-hint">· ' + ANY_CHAT + '</span></div>'
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
    html += '<p class="lbl">' + ic('check') + ' 끝낸 일 ' + done.length + '개</p>';
    html += done.length ? '<ul class="rows">' + done.map(function (d) { return row('done', d); }).join('') + '</ul>' : '<p class="muted">' + ic('info', 'ic-sm') + ' 아직 없음</p>';
    if (str(s.next)) html += '<p class="kv"><span class="sym">' + ic('arrow-right', 'ic-sm') + '</span>다음: ' + esc(s.next) + '</p>';
    var steps = arr(s.flow).filter(obj).slice(0, FLOW_MAX);
    if (steps.length) html += '<p class="lbl">' + ic('arrow-right') + ' 단계 흐름</p><div class="flowbox">' + flowSvg(steps, false) + flowSvg(steps, true) + '</div>';
    var auto = obj(s.auto);
    if (auto) {
      var w = obj(auto.workers) || {};
      html += '<p class="lbl">' + ic('settings') + ' 자동 정보 <span class="muted">(절차 진행, 목표 달성 아님)</span></p>' +
        '<p class="kv"><span class="sym">' + ic('target', 'ic-sm') + '</span>작업: [' + esc(s.workName || '-') + '] · 단계 ' + esc(auto.stage || '-') + '</p>' +
        '<p class="kv"><span class="sym">' + ic('list-todo', 'ic-sm') + '</span>todo 현재: ' + esc(auto.todoCurrent || '-') + ' · 다음: ' + esc(auto.todoNext || '-') +
        ' · ' + esc(num(auto.todoDone) == null ? '-' : auto.todoDone) + '/' + esc(num(auto.todoTotal) == null ? '-' : auto.todoTotal) + '</p>' +
        '<p class="kv"><span class="sym">' + ic('users', 'ic-sm') + '</span>작업자 실행 ' + esc(num(w.running) || 0) + ' · 완료 ' + esc(num(w.done) || 0) + ' · 오류 ' + esc(num(w.error) || 0) + '</p>';
    }
    arr(s.decisions).filter(function (d) { return obj(d) && d.answered; }).forEach(function (d) {
      var rc = obj(d.receipt);
      html += '<p class="kv"><span class="sym">' + ic('circle-check', 'ic-sm') + '</span>#' + esc(d.id) + ' 답 받음' +
        (rc ? ' · 전달됨 ' + ic('clock', 'ic-xs') + ' ' + esc(when(rc.deliveredAt, now)) : ' · ' + timed(str(d.delivery) || '전달 기다림')) + '</p>';
    });
    if (str(s.cwd)) html += '<p class="kv path"><span class="sym">' + ic('folder', 'ic-sm') + '</span><code>' + esc(s.cwd) + '</code>' + copyBtn(s.cwd) + '</p>';
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
      '<span class="title">' + whereLabelHtml(view, 'ic-sm') + '</span>' + focusBtn(fview, { live: live, focus: focus }) +
      '<span class="time">' + ic('clock', 'ic-xs') + ' ' + esc(when(s.lastActivityAt != null ? s.lastActivityAt : s.lastBriefAt, now)) + '</span></div>' +
      '<p class="hl"><span class="sym">' + ic('chevron-right', 'ic-sm') + '</span>' + esc(s.headline || '아직 보고 없음') + '</p>';
    var folded = obj(s.folded);
    if (folded) {
      var fr = num(folded.reports), fd = num(folded.decisions);
      html += '<p class="note cv-fold-counts">보고서 ' + esc(fr === null || fr < 0 ? 0 : Math.floor(fr)) + '개 · 결정 ' +
        esc(fd === null || fd < 0 ? 0 : Math.floor(fd)) + '개</p>';
    }
    html += liveBlocks(s, n, ui, now);

    var q = obj(s.openQuestion);
    if (q) {
      // Read-only alert: say where the question lives. Pane = the mirror's own paneId, else (older records) the session's pane.
      var qPane = str(q.paneId) || str(s.paneId);
      var tabbed = !!str(view.tabLabel);
      // the icon, then the whole sentence in span.oq-b (page.css: one line of flow on a phone, no box of its own wider)
      html += '<p class="oq"><span class="sym">' + ic('circle-question-mark', 'ic-sm') + '</span><span class="oq-b">질문 알림 열림 - ' +
        (tabbed ? '답할 창: <code>' + whereOfHtml(view) + '</code>' : qPane ? '<code>' + esc(qPane) + '</code>에서 답하기' : '질문이 뜬 창에서 답하기') + ' (읽기 전용): <span class="oq-t">' + esc(q.text) + '</span>' +
        ' <span class="time">' + ic('clock', 'ic-xs') + ' ' + esc(when(q.at, now)) + '</span> ' + focusBtn(fview, { live: live, focus: focus }) + '</span></p>' +
        (q.builtin === true ? '<p class="oq-builtin">터미널에서 답하세요 - 이 질문은 하네스 기본 질문창이라 상황판에서 닫을 수 없어요</p>' : '');
    }

    var changes = arr(s.changes);
    if (changes.length) {
      var kc = 'more-ch:' + n.id, oc = !!own(expanded, kc);
      html += '<div class="blk"><p class="lbl">' + (s.changesNew ? ic('plus') + ' 새로 바뀜' : ic('refresh-cw') + ' 최근 변화') + '</p><ul class="rows">' +
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
    var held = arr(s.decisions).filter(function (d) { return obj(d) && d.held; });
    if (held.length) {
      var heldKey = 'cv:' + n.id + ':held';
      html += '<details class="held-decs"' + (ui.detailKeys ? ' data-open-key="' + esc(heldKey) + '"' + (own(expanded, heldKey) === true ? ' open' : '') : '') + '><summary>보류됨 ' + held.length + '개</summary>' +
        held.map(function (d) {
          var a = obj(own(ui.answers, str(d.id))) || {};
          return '<p>#' + esc(d.id) + ' ' + esc(d.question) +
            (live ? ' <button type="button" class="ans-write" data-act="ans-reopen" data-id="' + esc(d.id) + '">다시 열기</button>' : '') +
            (str(a.error) ? ' <span role="alert">' + esc(a.error) + '</span>' : '') + '</p>';
        }).join('') + '</details>';
    }
    if (arr(s.decisions).some(function (d) { return obj(d) && d.questionPrompt; })) {
      html += '<p class="muted">질문창으로 옮김 · 여기서 답할 것 없음</p>';
    }
    var kx = 'detail:' + n.id, ox = !!own(expanded, kx);
    html += '<button type="button" class="detail-btn" data-act="exp" data-key="' + esc(kx) + '" aria-expanded="' + (ox ? 'true' : 'false') + '">' +
      ic(ox ? 'chevron-down' : 'chevron-right', 'ic-xs') + ' ' + (ox ? '자세히 닫기' : '자세히') + '</button>';
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

  // kit: the card list's own building blocks for the conversation page (convo-view.js), the same functions with the same output
  function renderOverview(viewModel, uiState) {
    var vm = obj(viewModel) || {}, ui = obj(uiState) || {};
    var sessions = normSessions(vm, ui), byId = Object.create(null);
    sessions.forEach(function (n) { byId[n.id] = n; });
    var u = { expanded: obj(ui.expanded) || {}, byId: byId, wallNow: num(ui.wallNow), detailKeys: true,
      live: ui.live === true, focus: obj(ui.focus), answers: obj(ui.answers) || {}, decs: decisionIndex(sessions) };
    var open = 0, blocked = 0, stale = 0;
    sessions.forEach(function (n) {
      open += openDecisions(n.raw).length;
      if (n.raw.statusKey === 'blocked' || n.raw.status === 'blocked') blocked++;
      if (arr(n.raw.chips).indexOf('오래됨') >= 0) stale++;
    });
    var html = '<div class="overview"><header class="sum"><p class="sumline">결정 대기 ' + open + ' · 막힘 ' + blocked +
      ' · 오래됨 ' + stale + ' · ' + ic('clock', 'ic-sm') + ' 마지막 갱신 ' + hhmm(vm.generatedAt) + '</p><p class="note">브리핑이 켜진 대화 ' +
      sessions.length + '개만 보입니다 - 설치 전부터 열려 있던 대화는 새로 열어야 나타납니다</p></header>';
    if (!sessions.length) html += '<div class="empty">' + ic('inbox') + '<p class="big">아직 보고 없음</p><p class="muted">브리핑이 켜진 대화가 작업 턴을 끝내면 여기에 카드가 생깁니다</p></div>';
    if (!u.live && open) html += '<p class="note ro">이 페이지는 보기 전용입니다 - 답은 아무 대화창에 /decide 로, 또는 실시간 상황판에서</p>';
    groupByProject(sessions).forEach(function (grp) {
      html += '<h3 class="projh">' + ic('folder') + ' ' + esc(grp.project) + '</h3>';
      grp.items.forEach(function (n) {
        html += '<button type="button" class="more" data-sh="open" data-sid="' + esc(n.id) + '">대화 페이지 열기 · ' +
          whereLabelHtml(n.raw, 'ic-xs') + '</button>' + card(n, u, toMs(vm.generatedAt));
      });
    });
    return html + '</div>';
  }

  g.BriefView = {
    renderOverview: renderOverview, escapeHtml: esc, TABS: TABS, legend: LEGEND,
    kit: {
      decisionCard: decisionCard, answerBox: answerBox, confirmRow: confirmRow, sentLine: sentLine, row: row, truthChip: truthChip,
      appliedChip: appliedChip, copyBtn: copyBtn, flowSvg: flowSvg, whereLabel: whereLabel, esc: esc
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
