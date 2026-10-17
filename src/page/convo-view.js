/* omo-briefing conversation page: one full-width page per conversation with the sub-tabs 개요 / 계획 / 작업자 / 결정 /
 * 보고서 (board v6, path details v7). Classic script (file:// safe, no modules), loaded after view.js, plan-view.js and
 * workers-view.js. Pure: no DOM, storage or clock access (the worker rows read Date.now() only without ui.wallNow, as
 * view.js does).
 *   g.BriefConvo.render(session, ui, ctx) -> html   the page header, the sub-tab bar with counts, the annotation tray slot
 *     and the panel of the shown sub-tab.
 *     session = one vm.sessions[] entry. Untrusted model data: every string goes through esc(), attributes too.
 *     ui = the page state view.js renders with: {sub, expanded, answers, live, focus, wallNow}. sub = the shown sub-tab
 *       (ov|plan|wk|dec|rep, anything else = ov), as the key itself or as the C-UI map {<sessionId>: key}.
 *     ctx = {now}: vm.generatedAt, the clock the times are written against.
 *   g.BriefConvo.SUBS = [[key, name], ...] in tab order.
 * Reused, not redrawn: view.js BriefView.kit (decision cards with their answer boxes, the answer box's confirm row, sent
 * lines, change/done rows with their truth/applied chips, copy buttons, the conversation label), plan-view.js
 * BriefPlanView.render (the box plan view, called unchanged inside div.plan-host) and workers-view.js
 * BriefWorkersView.render (its rows unchanged except for one added data-block attribute each). The old card header's
 * chips, the [그 창으로 이동] button and the open-question line keep view.js markup (view.js does not export them;
 * test/convo-view.test.mjs compares both).
 * Blocks (C-BLOCK): every annotatable element carries data-block built from model data only: head, now, flow,
 * card/<plan|wk|dec|rep>, change/<briefSeq>/<i>, done/<briefSeq>/<i>, dec/<id>, plan/todo/<i>, wk/<workerId>,
 * rep/<reportId>[/img/<n>], note/<key>, att/<n> (indexes count from 0 in the model's own arrays). Plan elements keep
 * plan-view's data-anchor. An id whose model part is missing or malformed is left off, never made up.
 * The C-VM fields (alive, briefSeq, todo, attachments, ...) and notes/reports may be missing (an older model): whatever
 * needs them is left out. A <details> takes its open state from ui.expanded['cv:<sessionId>:<part>'] when that is a
 * boolean (data-open-key names it; the controller records toggles there), else from its default.
 * Actions for the controller: data-act="sub" + data-sub (sub-tab buttons, summary cards), view.js's ans-* and focus
 * actions, data-act="ans-pick" + data-dec + data-opt on 보고서 "이걸로 고르기" (server page only), data-copy, and the
 * shell's data-sh="open" on the plan link. annotate.js fills the [data-ann-tray] slot under the sub-tabs and pins
 * annotations on report images (.rimg).
 * 이걸로 고르기 follows the linked decision's answer state ui.answers[id] (shared with its decision card): the picked
 * option shows the answer box's confirm row in place (ans-send/ans-cancel, data-where="rep"), the option it was sent for
 * shows the send state (ui.answers[id].sentOption), and once the model no longer shows the decision open every button is
 * disabled with 이미 답했거나 닫힌 결정 and the option it was answered with is highlighted. The report status (답함)
 * is the model's, never page state.
 * 보류 (C-HOLD 5): view.js's answer box draws the 보류 button; a pending ui.answers[id].confirm = {hold:true} is
 * drawn here as the hold confirm row (ans-send = 보류, ans-cancel), never by view.js's answer-only confirm row. The
 * 보고서 gets its own 보류 button (data-where="rep") under the linked open decision; 결정 lists the 보류됨 ones with
 * 다시 열기 (ans-reopen). */
(function (g) {
  'use strict';

  var SUBS = [['ov', '개요'], ['plan', '계획'], ['wk', '작업자'], ['dec', '결정'], ['rep', '보고서']];
  // = view.js STATUS_LABEL and EXTRA_CHIP: the header chips are the old card header's
  var STATUS_LABEL = {
    blocked: '막힘',
    needs_decision: '결정 대기',
    recheck: '재확인',
    done: '끝남',
    done_no_evidence: '끝(근거 없음)',
    in_progress: '진행 중'
  };
  var STALE_SERVER = 'x-stale x-server-stale';
  var EXTRA_CHIP = {
    '작업 중': 'x-busy',
    '응답 없음': 'x-dead',
    '보고 없음': 'x-norep',
    '오래됨': 'x-stale',
    '이 대화는 예전 세대라 실시간 상황판을 맡지 않음 · 대화를 재시작하면 최신 상황판이 열림': STALE_SERVER,
    '기록 읽기 실패': 'x-err',
    '질문 미러 사용 불가': 'x-err',
    '오류 있음': 'x-err',
    '자동 요약': 'x-info',
    '답 자동 줄임': 'x-info'
  };
  var FLOW_STATE = { done: '끝', doing: '진행 중', todo: '할 일', blocked: '막힘' };
  // native todo statuses (= workers-view.js TODO): class and text of the fallback table's 상태 cell
  var TODO_STATE = {
    completed: ['ok2', '✔ 완료'],
    in_progress: ['doing2', '● 진행 중'],
    pending: ['no2', '○ 남음'],
    abandoned: ['no2', '– 취소'],
    cancelled: ['no2', '– 취소']
  };
  var REPORT_STATUS = { '결정 기다림': 's-needs_decision', '답함': 's-done', '참고': 'x-info' };
  var CLOSED = '이미 답했거나 닫힌 결정'; // = page.js ANSWER_TEXT.closed
  var PIN_HINT = '📍 그림을 누르면 그 자리에 주석이 붙어';
  var ASSET_SRC = /^assets\/[0-9a-f]{64}\.(?:png|jpg|webp)$/; // C-REPORT: the only image source the page draws
  var REPORT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  var SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/; // worker ids and note keys inside block ids
  var HUES = 12; // = shell.js: the tab-number colours .sh-h0 .. .sh-h11 of shell.css
  var MAX_DIM = 8192;

  function str(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  // own-property lookup: model strings like 'constructor' must not hit Object.prototype
  function own(o, k) { return o && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function posId(v) { return typeof v === 'number' && isFinite(v) && v >= 1 && Math.floor(v) === v ? v : null; }
  function whole(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v ? v : null; }
  function safeId(v) { return str(v).replace(/[^A-Za-z0-9_-]/g, '_'); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function kit() { return g.BriefView.kit; }
  function esc(v) { return kit().esc(v); }

  // = view.js toMs / hhmm / when
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

  function chip(cls, label) { return '<span class="chip ' + cls + '">' + esc(label) + '</span>'; }
  function blockAttr(id) { return id ? ' data-block="' + esc(id) + '"' : ''; }
  // kit markup starts with its own element: that element takes the block id
  function withBlock(html, id) { return id ? html.replace(/^<([a-z]+)/, '<$1' + blockAttr(id)) : html; }
  // <details> open state: ui.expanded['cv:<sid>:<part>'] when the owner toggled it (a boolean), else the default
  function openAttr(U, sid, part, dflt) {
    var key = 'cv:' + sid + ':' + part;
    var v = own(U.expanded, key);
    return ' data-open-key="' + esc(key) + '"' + ((typeof v === 'boolean' ? v : dflt) ? ' open' : '');
  }

  // ---- model reads -------------------------------------------------------------------------------------------------
  function byId(a, b) { return (num(a.id) || 0) - (num(b.id) || 0); }
  function decisions(s) { return arr(s.decisions).filter(function (d) { return !!obj(d); }); }
  function isOpen(d) { return !d.answered && !d.closed && !d.held; } // held ones leave the open list (C-HOLD)
  function openDecs(s) { return decisions(s).filter(isOpen).sort(byId); }
  function answeredDecs(s) { return decisions(s).filter(function (d) { return !!d.answered; }).sort(byId); }
  function heldDecs(s) { return decisions(s).filter(function (d) { return !!d.held; }).sort(byId); }
  // ---- 보류 confirm (C-HOLD 5) ----
  function holdPending(d, U) {
    var a = obj(own(U.answers, str(d.id)));
    return !!a && !str(a.phase) && !!obj(a.confirm) && a.confirm.hold === true;
  }
  // U for view.js's answer box: a pending hold confirm is ours to draw, so view.js sees no confirm for that decision
  function answerU(d, U) {
    if (!holdPending(d, U)) return U;
    var answers = Object.assign(Object.create(null), U.answers);
    answers[str(d.id)] = Object.assign({}, U.answers[str(d.id)], { confirm: null });
    return Object.assign({}, U, { answers: answers });
  }
  function holdRow(d, s, U, where) {
    if (!U.live || !holdPending(d, U)) return '';
    var at = ' data-id="' + esc(d.id) + '" data-where="' + esc(where) + '"';
    return '<div class="ans-confirm ans-hold-confirm" role="group" aria-label="보류 확인"><span class="ans-q">' + esc(whereOf(s)) + ' 대화의 #' +
      esc(d.id) + '를 보류할까요? 대화는 다시 묻지 않아요</span><span class="ans-acts"><button type="button" class="ans-go" data-act="ans-send"' + at + '>보류</button>' +
      '<button type="button" class="ans-cancel" data-act="ans-cancel"' + at + '>취소</button></span></div>';
  }
  // = view.js sentDecisions: answers without a delivery proof yet, plus the ones this page is sending or has sent
  function sentDecs(s, U) {
    return answeredDecs(s).filter(function (d) {
      var a = obj(own(U.answers, str(d.id)));
      return !obj(d.receipt) || (!!a && (a.phase === 'sending' || a.phase === 'sent'));
    });
  }
  function findDecision(s, id) {
    var want = posId(id);
    if (want === null) return null;
    var hit = decisions(s).filter(function (d) { return d.id === want; });
    return hit.length ? hit[0] : null;
  }
  // = view.js recOf: the decision's recommend when that option exists, else A when it exists
  function recOf(d) {
    var opts = obj(d.options) || {};
    return own({ A: 1, B: 1, C: 1 }, d.recommend) && obj(own(opts, d.recommend)) ? d.recommend : (obj(own(opts, 'A')) ? 'A' : '');
  }
  function decBlock(d) { var id = posId(d.id); return id === null ? '' : 'dec/' + id; }
  // = workers-view.js workersOf: valid rows, the first of each id
  function workerList(s) {
    var live = obj(s.live), seen = Object.create(null), out = [];
    arr(live && live.workers).forEach(function (w) {
      var id = obj(w) ? str(w.id) : '';
      if (!id || seen[id]) return;
      seen[id] = 1;
      out.push(w);
    });
    return out;
  }
  // = workers-view.js summary '진행': running and not marked unresponsive
  function runningCount(list) { return list.filter(function (w) { return w.state === 'running' && w.stale !== true; }).length; }
  function seqOf(s) { var n = whole(s.briefSeq); return n !== null && n >= 0 ? n : null; }
  function todoOf(s) {
    var t = obj(s.todo);
    if (!t) return null;
    var more = whole(t.more);
    return { items: arr(t.items), more: more !== null && more > 0 ? more : 0 };
  }
  // done/total for the 계획 count and bar: plan tasks, else auto's todo counts, else the native todo items
  function progress(s, withPlan) {
    var plan = withPlan ? obj(s.plan) : null;
    var tasks = plan ? arr(plan.tasks).filter(function (t) { return !!obj(t); }) : [];
    if (tasks.length) return { done: tasks.filter(function (t) { return t.state === 'done'; }).length, total: tasks.length };
    var a = obj(s.auto);
    if (a && num(a.todoDone) !== null && num(a.todoTotal) !== null) return { done: a.todoDone, total: a.todoTotal };
    var t = todoOf(s);
    var items = t ? t.items.filter(function (it) { return !!obj(it); }) : [];
    if (items.length) return { done: items.filter(function (it) { return it.status === 'completed'; }).length, total: items.length + t.more };
    return null;
  }
  function planName(s) {
    var p = obj(s.plan) || {};
    return str(s.workName) || str(obj(p.source) && p.source.slug) || str(p.goal);
  }
  function reportsOf(s) { return arr(s.reports).filter(function (r) { return !!obj(r); }); }

  // ---- header --------------------------------------------------------------------------------------------------------
  function hue(n) { return ((n * 5) % HUES + HUES) % HUES; } // = shell.js hueOf: the tab bar shows the same colour
  // = view.js whereOf: herdr tab label and number, else the pane, else the title
  function whereOf(s) {
    var label = str(s.tabLabel);
    if (label) return '🗂 ' + label + (num(s.tabNumber) == null ? '' : ' #' + s.tabNumber);
    return str(s.paneId) ? '창 ' + str(s.paneId) : (str(s.title) || '(제목 없음)');
  }
  // = view.js focusBtn: [그 창으로 이동] on the server page, for a conversation in a herdr tab
  function focusBtn(s, U) {
    var sid = str(s.id);
    if (!U.live || !str(s.tabId) || !sid) return '';
    var res = U.focus ? own(U.focus, sid) : null;
    return '<button type="button" class="focusbtn" data-act="focus" data-session="' + esc(sid) + '">그 창으로 이동</button>' +
      (res ? ' <span class="focus-res ' + (res.ok ? 'ok' : 'err') + '">' + esc(res.ok ? '이동했어요' : '이동 실패 - herdr에서 직접 열어 주세요') + '</span>' : '');
  }
  // = the chips of view.js card's header line: status first, then the model's chips
  function statusChips(s) {
    var key = str(s.statusKey) || (s.status === 'blocked' ? 'blocked' : s.status === 'done' ? 'done' : 'in_progress');
    if (!own(STATUS_LABEL, key)) key = 'in_progress';
    var extra = arr(s.chips).filter(function (c) { return typeof c === 'string'; });
    if (s.autoSummary) extra.push('자동 요약');
    if (s.answerTrimmed) extra.push('답 자동 줄임');
    return chip('s-' + key, STATUS_LABEL[key]) + extra.map(function (c) {
      if (own(EXTRA_CHIP, c) === STALE_SERVER) return '<span class="chip x-stale x-server-stale" style="white-space:normal;word-break:keep-all;overflow-wrap:anywhere" title="설치된 상황판보다 예전 세대인 대화입니다. 대화를 재시작하면 최신 세대가 실시간 상황판을 맡습니다.">' + esc(c) + '</span>';
      return chip(own(EXTRA_CHIP, c) || 'x-info', c);
    }).join('');
  }
  function header(s, U, now) {
    var K = kit();
    var label = str(s.tabLabel), title = str(s.title) || '(제목 없음)';
    var n = whole(s.tabNumber);
    var topic = label ? title : str(s.paneId) ? '창 ' + str(s.paneId) : '';
    var plan = planName(s);
    var html = '<header class="cv-head" data-block="head"><div class="cv-top">' +
      (n === null ? '<span class="cv-ico" aria-hidden="true">·</span>'
        : '<span class="cv-ico sh-h' + hue(n) + '" role="img" aria-label="탭 ' + esc(n) + '" title="탭 #' + esc(n) + '">' + esc(n) + '</span>') +
      '<div class="cv-names"><h1 class="cv-h1" title="' + esc(K.whereLabel(s)) + '">' + esc(label || title) + '</h1>' +
      (topic || plan ? '<p class="cv-sub">' + (topic ? '<span>' + esc(topic) + '</span>' : '') +
        (plan ? '<span class="cv-plan">🗂 ' + esc(plan) + '</span>' : '') + '</p>' : '') + '</div>' +
      '<span class="time">⏱ ' + esc(when(s.lastActivityAt != null ? s.lastActivityAt : s.lastBriefAt, now)) + '</span>' + focusBtn(s, U) + '</div>' +
      '<div class="ch cv-chips">' + statusChips(s) + '</div>';
    if (str(s.cwd)) html += '<p class="kv path cv-cwd"><span class="sym">📁</span><code>' + esc(s.cwd) + '</code>' + K.copyBtn(s.cwd) + '</p>';
    return html + '</header>';
  }

  // ---- sub-tab bar -----------------------------------------------------------------------------------------------------
  function countsOf(s) {
    var open = openDecs(s).length, answered = answeredDecs(s).length;
    var p = progress(s, true);
    var wk = workerList(s).length, reps = reportsOf(s).length;
    return {
      ov: '', plan: p ? p.done + '/' + p.total : '', wk: wk ? String(wk) : '',
      dec: open ? String(open) : answered ? String(answered) : '', decHot: open > 0, rep: reps ? String(reps) : ''
    };
  }
  function subTabs(s, sub, counts, panelId) {
    var sid = esc(str(s.id));
    return '<div class="stabs" role="tablist" aria-label="대화 페이지 보기">' + SUBS.map(function (t) {
      var on = t[0] === sub, c = counts[t[0]];
      return '<button type="button" role="tab" class="st' + (on ? ' on' : '') + '" data-act="sub" data-sub="' + t[0] + '" data-sid="' + sid +
        '" aria-selected="' + (on ? 'true' : 'false') + '" aria-controls="' + panelId + '">' + t[1] +
        (c ? '<span class="c' + (t[0] === 'dec' && counts.decHot ? ' o' : '') + '">' + esc(c) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }

  // ---- 개요 --------------------------------------------------------------------------------------------------------------
  function nowCallout(s) {
    return '<div class="cv-now" data-block="now"><span class="cv-bulb" aria-hidden="true">💡</span><div class="cv-nowt">' +
      '<p class="cv-hl"><b>지금</b> ' + esc(str(s.headline) || '아직 보고 없음') + '</p>' +
      '<p class="cv-next">다음: ' + esc(str(s.next) || '-') + '</p></div></div>';
  }
  function flowStrip(s) {
    var steps = arr(s.flow).filter(function (f) { return !!obj(f); });
    if (!steps.length) return '';
    return '<div class="cv-flow" data-block="flow" role="list" aria-label="단계 흐름">' + steps.map(function (f) {
      var st = own(FLOW_STATE, f.state) ? f.state : 'todo';
      return '<span class="cv-fs is-' + st + '" role="listitem" title="' + FLOW_STATE[st] + '">' + esc(f.label) + '</span>';
    }).join('<span class="cv-arr" aria-hidden="true">→</span>') + '</div>';
  }
  function summaryCards(s, counts) {
    var sid = esc(str(s.id));
    function card(key, label, value, rest) {
      return '<div class="scard" data-block="card/' + key + '"><button type="button" class="scard-go" data-act="sub" data-sub="' + key + '" data-sid="' + sid + '">' +
        '<span class="scard-l">' + label + '</span><span class="scard-v"><b>' + esc(value) + '</b> ' + esc(rest) + '</span></button></div>';
    }
    var wk = workerList(s), reps = reportsOf(s), name = planName(s);
    return '<div class="grid4">' +
      card('plan', '🗂 계획', counts.plan || '-', '· ' + (name || (counts.plan ? '할 일' : '계획 없음'))) +
      card('wk', '👷 작업자', String(wk.length), '· ' + runningCount(wk) + '명 진행 중') +
      card('dec', '🔔 결정', String(openDecs(s).length), '대기 · ' + answeredDecs(s).length + ' 답함') +
      card('rep', '📑 보고서', String(reps.length), '· ' + (reps.length ? str(reps[0].title) || '(제목 없음)' : '없음')) + '</div>';
  }
  // = view.js card's open-question line (read-only: the question is answered in its own window)
  function openQuestion(s, U, now) {
    var q = obj(s.openQuestion);
    if (!q) return '';
    var qPane = str(q.paneId) || str(s.paneId);
    var tabbed = !!str(s.tabLabel);
    return '<p class="oq"><span class="sym">❓</span>질문 알림 열림 - ' +
      (tabbed ? '답할 창: <code>' + esc(whereOf(s)) + '</code>' : qPane ? '<code>' + esc(qPane) + '</code>에서 답하기' : '질문이 뜬 창에서 답하기') + ' (읽기 전용): ' + esc(q.text) +
      ' <span class="time">⏱ ' + esc(when(q.at, now)) + '</span> ' + focusBtn(s, U) + '</p>' +
      (q.builtin === true ? '<p class="oq-builtin">터미널에서 답하세요 - 이 질문은 하네스 기본 질문창이라 상황판에서 닫을 수 없어요</p>' : '');
  }
  // the decision card's view of its conversation (= view.js card's `view`)
  function cardView(s, now) {
    return { title: str(s.title) || '(제목 없음)', workName: str(s.workName), paneId: str(s.paneId), tabLabel: str(s.tabLabel), tabNumber: num(s.tabNumber),
      tabId: str(s.tabId), sessionId: str(s.id), __now: now };
  }
  // open decision cards with their answer boxes, after the sent lines when withSent (the old card's decision block)
  function decisionBlock(s, U, now, withSent) {
    var K = kit(), view = cardView(s, now);
    var open = openDecs(s), sent = withSent && U.live ? sentDecs(s, U) : [];
    var html = '';
    if (!U.live && open.length) html += '<p class="note ro">이 페이지는 보기 전용입니다 - 답은 아무 대화창에 /decide 로, 또는 실시간 상황판에서</p>';
    if (open.length || sent.length) {
      html += '<div class="decs">' + sent.map(function (d) { return withBlock(K.sentLine(d), decBlock(d)); }).join('') +
        open.map(function (d) { return '<div class="cv-dc"' + blockAttr(decBlock(d)) + '>' + K.decisionCard(d, view, answerU(d, U), s) + holdRow(d, s, U, 'dc') + '</div>'; }).join('') + '</div>';
    }
    if (decisions(s).some(function (d) { return d.questionPrompt; })) html += '<p class="muted">질문창으로 옮김 · 여기서 답할 것 없음</p>';
    return html;
  }
  // a change or done row: kit.row with its truth/applied chips; the evidence path moves into the row's collapsed 상세
  function rowHtml(kind, item, block, U, sid, key) {
    var K = kit(), ev = str(item.evidence);
    var html = withBlock(K.row(kind, ev ? Object.assign({}, item, { evidence: '' }) : item), block);
    if (!ev) return html;
    return html.slice(0, -'</li>'.length) + '<details class="dt"' + openAttr(U, sid, 'dt/' + key, false) + '><summary>상세 · 증거 파일</summary>' +
      '<div class="path"><span class="sym">📄</span><code>' + esc(ev) + '</code>' + K.copyBtn(ev) + '</div></details></li>';
  }
  function rowsSection(s, kind, U) {
    var sid = str(s.id), seq = seqOf(s), chg = kind === 'chg';
    var part = chg ? 'chg' : 'done', prefix = chg ? 'change/' : 'done/';
    var rows = [];
    arr(chg ? s.changes : s.done).forEach(function (item, i) {
      if (!obj(item)) return;
      var block = seq === null ? '' : prefix + seq + '/' + i;
      rows.push(rowHtml(chg ? 'chg' : 'done', item, block, U, sid, block || part + '/' + i));
    });
    if (!rows.length) return '';
    var title = chg ? (s.changesNew ? '✚ 새로 바뀜' : '↻ 최근 변화') : '✔ 한 일';
    return '<details class="cv-sec"' + openAttr(U, sid, part, chg) + '><summary>' + title + ' <span class="cv-n">' + rows.length + '</span></summary>' +
      '<ul class="rows">' + rows.join('') + '</ul></details>';
  }
  function deliveryChip(text, receipt) {
    var t = str(text) || (obj(receipt) ? '전달됨 ⏱' + hhmm(receipt.deliveredAt) : '전달 기다림');
    var cls = /^전달됨/.test(t) ? 's-done' : t === '전달 중' ? 'x-busy' : /^대기|기다림$/.test(t) ? 'x-stale' : 'x-info';
    return chip(cls, t);
  }
  function notesSection(s, U, now) {
    if (!Array.isArray(s.notes)) return '';
    var sid = str(s.id);
    var list = s.notes.filter(function (n) { return !!obj(n); });
    return '<details class="cv-sec cv-notes"' + openAttr(U, sid, 'notes', false) + '><summary>📨 보낸 피드백 <span class="cv-n">' + list.length + '</span></summary>' +
      (list.length ? '<ul class="rows">' + list.map(function (n) {
        var key = str(n.key);
        return '<li class="row cv-note"' + blockAttr(SAFE_ID.test(key) ? 'note/' + key : '') + '><span class="time">⏱ ' + esc(when(n.at, now)) + '</span>' +
          '<span class="rt">' + esc(n.preview) + '</span>' + deliveryChip(n.delivery, null) + '</li>';
      }).join('') + '</ul>' : '<p class="muted cv-empty">아직 보낸 피드백 없음</p>') + '</details>';
  }
  function attachmentsSection(s, U) {
    if (!Array.isArray(s.attachments)) return '';
    var K = kit(), sid = str(s.id), rows = [];
    s.attachments.forEach(function (a, n) {
      if (!obj(a) || !str(a.path)) return;
      rows.push('<div class="path"' + blockAttr('att/' + n) + '><span class="lb">' + esc(str(a.label) || '자료') + '</span><code>' + esc(a.path) + '</code>' + K.copyBtn(a.path) + '</div>');
    });
    if (!rows.length) return '';
    return '<details class="att"' + openAttr(U, sid, 'att', false) + '><summary>📎 이 대화 자료 ' + rows.length + ' (AI에게 "이거 고쳐줘" 할 때 같이 붙음)</summary>' +
      rows.join('') + '</details>';
  }
  function overview(s, U, now, counts) {
    return nowCallout(s) + flowStrip(s) + summaryCards(s, counts) + openQuestion(s, U, now) + decisionBlock(s, U, now, true) +
      rowsSection(s, 'chg', U) + rowsSection(s, 'done', U) + notesSection(s, U, now) + attachmentsSection(s, U);
  }

  // ---- 계획 --------------------------------------------------------------------------------------------------------------
  // no plan_brief: the work name as the goal, the progress bar and the native todo table, from todo or auto; '' when
  // they hold no todo rows or progress (an empty todo list is what every conversation without native todos has)
  function fallback(s) {
    var t = todoOf(s), p = progress(s, false), work = str(s.workName);
    var rows = [];
    if (t) {
      t.items.forEach(function (it, i) {
        if (!obj(it)) return;
        var st = own(TODO_STATE, it.status) ? TODO_STATE[it.status] : TODO_STATE.pending;
        rows.push('<tr' + blockAttr('plan/todo/' + i) + '><td>' + (i + 1) + '</td><td>' + esc(it.text) + '</td><td class="' + st[0] + '">' + st[1] + '</td></tr>');
      });
    }
    if (!rows.length && !p) return ''; // a work name alone is no plan
    var html = '<div class="cv-fb"><h3 class="cv-h3">목표</h3><p class="cv-goal">🎯 ' + esc(work || '(작업 이름 없음)') + '</p>';
    if (p) {
      var pct = p.total > 0 ? Math.max(0, Math.min(100, Math.round(p.done / p.total * 100))) : 0;
      html += '<h3 class="cv-h3">할 일 ' + esc(p.done) + '/' + esc(p.total) + '</h3><div class="prog" role="progressbar" aria-label="할 일 진행" aria-valuemin="0" aria-valuemax="' +
        esc(p.total) + '" aria-valuenow="' + esc(p.done) + '"><i style="width:' + pct + '%"></i></div>';
    }
    if (rows.length) {
      html += '<table class="t cv-todo"><thead><tr><th scope="col">#</th><th scope="col">할 일</th><th scope="col">상태</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
      if (t.more) html += '<p class="muted cv-empty">외 ' + t.more + '개</p>';
    }
    return html + '</div>';
  }
  // = view.js detail's ⚙ 자동 정보 lines
  function autoInfo(s, U) {
    var auto = obj(s.auto);
    if (!auto) return '';
    var w = obj(auto.workers) || {};
    return '<details class="cv-sec cv-auto"' + openAttr(U, str(s.id), 'auto', false) + '><summary>⚙ 자동 정보 <span class="muted">(절차 진행, 목표 달성 아님)</span></summary>' +
      '<p class="kv"><span class="sym">•</span>작업: [' + esc(s.workName || '-') + '] · 단계 ' + esc(auto.stage || '-') + '</p>' +
      '<p class="kv"><span class="sym">•</span>todo 현재: ' + esc(auto.todoCurrent || '-') + ' · 다음: ' + esc(auto.todoNext || '-') +
      ' · ' + esc(num(auto.todoDone) == null ? '-' : auto.todoDone) + '/' + esc(num(auto.todoTotal) == null ? '-' : auto.todoTotal) + '</p>' +
      '<p class="kv"><span class="sym">•</span>작업자 실행 ' + esc(num(w.running) || 0) + ' · 완료 ' + esc(num(w.done) || 0) + ' · 오류 ' + esc(num(w.error) || 0) + '</p></details>';
  }
  function planPanel(s, U, now) {
    var pv = g.BriefPlanView, plan = obj(s.plan), link = obj(s.planLink);
    var html = '';
    if (plan && pv) html += '<div class="plan-host">' + pv.render(plan, now, { esc: kit().esc, expanded: U.expanded,
      answerBox: U.live && U.decision ? function (id) {
        var hit = U.decision(id);
        return hit && isOpen(hit.d) ? kit().answerBox(hit.d, hit.owner, answerU(hit.d, U), 'plan') + holdRow(hit.d, hit.owner, U, 'plan') : '';
      } : null }) + '</div><!--plan-host-->';
    if (link && pv) {
      var owner = str(link.ownerId);
      html += '<p class="cv-plink">' + pv.renderLink(link, { esc: kit().esc }) +
        (owner ? ' <button type="button" class="more" data-sh="open" data-sid="' + esc(owner) + '" data-sub="plan">계획 쪽 대화 열기</button>' : '') + '</p>';
    }
    if (!plan) {
      var fb = fallback(s);
      html += fb || (link ? '' : '<p class="muted cv-empty">이 대화에는 계획이 없어</p>');
    }
    return html + autoInfo(s, U);
  }

  // ---- 작업자 ------------------------------------------------------------------------------------------------------------
  // workers-view.js draws each row as <li class="w-row …" data-worker="<escaped id>" …>: the row gets its C-BLOCK id
  function workerBlocks(html) {
    return html.replace(/<li class="w-row([^"]*)" data-worker="([^"]*)"/g, function (m, cls, id) {
      return SAFE_ID.test(id) ? '<li class="w-row' + cls + '" data-block="wk/' + id + '" data-worker="' + id + '"' : m;
    });
  }
  function workersPanel(s, U) {
    var wv = g.BriefWorkersView;
    if (!wv || !workerList(s).length) return '<p class="muted cv-empty">작업자 없음</p>';
    // the pulse phase and elapsed text follow the wall clock, not the age of the data (= view.js liveBlocks)
    return workerBlocks(wv.render(s.live, typeof U.wallNow === 'number' ? U.wallNow : Date.now(), { esc: kit().esc, expanded: U.expanded }));
  }

  // ---- 결정 --------------------------------------------------------------------------------------------------------------
  // part A's 보류됨 group (view.js card), with block ids
  function heldSection(s, U) {
    var held = heldDecs(s);
    if (!held.length) return '';
    return '<details class="held-decs"' + openAttr(U, str(s.id), 'held', false) + '><summary>보류됨 ' + held.length + '개</summary>' +
      held.map(function (d) {
        var a = obj(own(U.answers, str(d.id))) || {};
        return '<p' + blockAttr(decBlock(d)) + '>#' + esc(d.id) + ' ' + esc(d.question) +
          (U.live ? ' <button type="button" class="ans-write" data-act="ans-reopen" data-id="' + esc(d.id) + '">다시 열기</button>' : '') +
          (str(a.error) ? ' <span role="alert">' + esc(a.error) + '</span>' : '') + '</p>';
      }).join('') + '</details>';
  }
  function historyTable(s) {
    var list = answeredDecs(s);
    var html = '<h3 class="cv-h3">결정 기록</h3>';
    if (!list.length) return html + '<p class="muted cv-empty">아직 답한 결정 없음</p>';
    return html + '<table class="t cv-hist"><thead><tr><th scope="col">#</th><th scope="col">질문</th><th scope="col">내 답</th><th scope="col">결과</th><th scope="col">전달</th></tr></thead><tbody>' +
      list.map(function (d) {
        var a = obj(d.answer) || {}, opt = str(a.option), reply = str(a.text);
        var o = opt ? obj(own(obj(d.options) || {}, opt)) : null;
        var mine = opt ? opt + (o && str(o.text) ? ' · ' + str(o.text) : '') : reply ? '답글 “' + reply + '”' : '답 받음';
        return '<tr' + blockAttr(decBlock(d)) + '><td data-label="#">#' + esc(d.id) + '</td><td data-label="질문">' + esc(d.question) + '</td>' +
          '<td data-label="내 답" class="ok2">' + esc(mine) + '</td><td data-label="결과">' + esc(o && str(o.consequence) ? o.consequence : '-') + '</td>' +
          '<td data-label="전달">' + deliveryChip(d.delivery, d.receipt) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function decisionsPanel(s, U, now) {
    var html = decisionBlock(s, U, now, false);
    if (!openDecs(s).length) html += '<p class="muted cv-empty">답을 기다리는 결정 없음</p>';
    return html + heldSection(s, U) + historyTable(s);
  }

  // ---- 보고서 ------------------------------------------------------------------------------------------------------------
  function dim(v) { var n = whole(v); return n !== null && n >= 1 && n <= MAX_DIM ? n : null; }
  // the option of the linked decision an image stands for ('' when the decision has no such option)
  function optionOf(d, im) {
    var opt = str(im.option);
    return d && own({ A: 1, B: 1, C: 1 }, opt) && obj(own(obj(d.options) || {}, opt)) ? opt : '';
  }
  // 이걸로 고르기 on the server page, from the linked decision's answer state (null elsewhere). open = the buttons work;
  // picked = the option waiting in the confirm row; sent = the option whose cell shows line, the send state; closed = the
  // decision can no longer be answered here (the buttons say why).
  function pickOf(d, U) {
    if (!U.live || !d || posId(d.id) === null) return null;
    if (!isOpen(d)) {
      return { open: false, picked: '', sent: '', conf: null, error: '', closed: true,
        line: '<p class="note rep-closed" role="status">' + esc(CLOSED) + '</p>' };
    }
    var a = obj(own(U.answers, String(d.id))) || {};
    var phase = str(a.phase), conf = obj(a.confirm);
    return {
      open: phase === '',
      picked: phase === '' && conf && typeof conf.option === 'string' ? conf.option : '',
      sent: phase ? str(a.sentOption) : '',
      conf: conf, error: phase === '' ? str(a.error) : '', closed: phase === 'closed',
      // = view.js answerBox's state lines
      line: phase === 'sending' || phase === 'sent'
        ? '<p class="ans-state" role="status">' + (phase === 'sending' ? '보내는 중…' : '보냄 · 전달 상태 기다리는 중…') + '</p>'
        : phase === 'closed' ? '<p class="ans-err" role="alert">' + esc(str(a.error) || CLOSED) + '</p>' : ''
    };
  }
  // the answer control of one option: the confirm row when it is the picked one, its send state when it was sent, else
  // the button
  function pickSlot(s, d, opt, rec, ps) {
    if (ps.picked === opt) {
      return kit().confirmRow(d.id, s, ps.conf, 'rep') + (ps.error ? '<p class="ans-err" role="alert">' + esc(ps.error) + '</p>' : '');
    }
    if (ps.sent === opt && ps.line) return ps.line;
    return '<button type="button" class="cv-pick' + (rec ? ' is-rec' : '') + '" data-act="ans-pick" data-dec="' + d.id + '" data-opt="' + opt + '"' +
      (ps.open ? '' : ' disabled' + (ps.closed ? ' title="' + esc(CLOSED) + '"' : '')) + '>이걸로 고르기</button>';
  }
  // one image of a report: the picture, then the linked decision's option (text, consequence, 추천, 고른 안) and its control
  function imageCell(s, d, im, block, ps, chosen) {
    var src = str(im.src), opt = optionOf(d, im);
    var o = opt ? obj(own(obj(d.options) || {}, opt)) : null;
    var rec = !!o && recOf(d) === opt, mine = !!o && chosen === opt;
    var w = dim(im.w), h = dim(im.h);
    var img = ASSET_SRC.test(src)
      ? '<img src="' + esc(src) + '" alt="' + esc(im.alt) + '" loading="lazy" decoding="async"' + (w && h ? ' width="' + w + '" height="' + h + '"' : '') + '>'
      : '<span class="rimg-x">그림을 보여 줄 수 없음</span>';
    var body = o
      ? '<p class="nm">' + esc(opt) + ' · ' + esc(o.text) + (rec ? ' <span class="chip s-done">추천</span>' : '') +
        (mine ? ' <span class="chip cv-chosen">✔ 고른 안</span>' : '') + '</p>' + (str(o.consequence) ? '<p class="nt">' + esc(o.consequence) + '</p>' : '')
      : (str(im.alt) ? '<p class="nt">' + esc(im.alt) + '</p>' : '');
    var pick = o && ps ? pickSlot(s, d, opt, rec, ps) : '';
    return '<div class="ropt' + (rec ? ' rec' : '') + (mine ? ' chosen' : '') + '"' + blockAttr(block) + '><div class="rimg">' + img + '</div>' +
      (body || pick ? '<div class="rb2">' + body + pick + '</div>' : '') + '</div>';
  }
  function reportHtml(s, r, U, now) {
    var rid = str(r.id), okId = REPORT_ID.test(rid);
    var d = findDecision(s, r.decisionId);
    var ps = pickOf(d, U);
    var chosen = d && d.answered === true && obj(d.answer) ? str(d.answer.option) : '';
    var status = str(r.status) || '참고';
    var images = arr(r.images).filter(function (im) { return !!obj(im); });
    var opts = images.map(function (im) { return optionOf(d, im); });
    var pins = okId && images.some(function (im) { return ASSET_SRC.test(str(im.src)); });
    // the decision's state under the header, unless the option cell it was sent from shows it
    var line = ps && ps.line && !(ps.sent && opts.indexOf(ps.sent) >= 0) ? ps.line : '';
    // 보류 for the linked open decision, with its confirm row in place
    if (ps && ps.open && !ps.picked) {
      line += holdRow(d, s, U, 'rep') || '<p class="rep-hold"><button type="button" class="ans-write" data-act="ans-hold" data-id="' + esc(d.id) +
        '" data-where="rep">보류</button>' + (ps.error ? ' <span class="ans-err" role="alert">' + esc(ps.error) + '</span>' : '') + '</p>';
    }
    var html = '<section class="rep"' + blockAttr(okId ? 'rep/' + rid : '') + '><div class="rep-head"><span class="cv-bulb" aria-hidden="true">📑</span><div class="rep-ht">' +
      '<p class="rep-t"><b>' + esc(str(r.title) || '(제목 없음)') + '</b>' + chip(own(REPORT_STATUS, status) || 'x-info', status) +
      '<span class="time">⏱ ' + esc(when(r.at, now)) + '</span></p>' +
      (d ? '<p class="rep-dq">🔔 #' + esc(d.id) + ' ' + esc(d.question) + '</p>' : '') + line +
      (str(r.summary) ? '<p class="rep-sum">' + esc(r.summary) + '</p>' : '') +
      (pins ? '<p class="rep-hint">' + esc(PIN_HINT) + '</p>' : '') + '</div></div>';
    var cells = [];
    arr(r.images).forEach(function (im, n) {
      if (obj(im)) cells.push(imageCell(s, d, im, okId ? 'rep/' + rid + '/img/' + n : '', ps, chosen));
    });
    if (cells.length) html += '<div class="rgrid">' + cells.join('') + '</div>';
    return html + '</section>';
  }
  function reportsPanel(s, U, now) {
    var list = reportsOf(s);
    if (!list.length) return '<p class="muted cv-empty">보고서 없음</p>';
    return list.map(function (r) { return reportHtml(s, r, U, now); }).join('');
  }

  // ---- page --------------------------------------------------------------------------------------------------------------
  function subOf(u, sid) {
    var v = typeof u.sub === 'string' ? u.sub : own(obj(u.sub), sid);
    for (var i = 0; i < SUBS.length; i++) if (SUBS[i][0] === v) return v;
    return 'ov';
  }

  function render(session, ui, ctx) {
    var s = obj(session) || {};
    var u = obj(ui) || {};
    var now = toMs(obj(ctx) ? ctx.now : null);
    var U = { live: u.live === true, answers: obj(u.answers) || {}, expanded: obj(u.expanded) || {}, focus: obj(u.focus), wallNow: num(u.wallNow),
      decision: ctx && typeof ctx.decision === 'function' ? ctx.decision : null };
    var sid = str(s.id), sub = subOf(u, sid), panelId = 'cvp-' + safeId(sid);
    var counts = countsOf(s);
    var body = sub === 'plan' ? planPanel(s, U, now) : sub === 'wk' ? workersPanel(s, U) : sub === 'dec' ? decisionsPanel(s, U, now)
      : sub === 'rep' ? reportsPanel(s, U, now) : overview(s, U, now, counts);
    var name = SUBS.filter(function (t) { return t[0] === sub; })[0][1];
    return '<div class="cv-page" data-sid="' + esc(sid) + '" data-sub="' + sub + '">' + header(s, U, now) + subTabs(s, sub, counts, panelId) +
      '<div class="ann-tray" data-ann-tray="' + esc(sid) + '"></div>' +
      '<section class="cv-panel" id="' + panelId + '" role="tabpanel" data-sub="' + sub + '" aria-label="' + name + '">' + body + '</section></div>';
  }

  g.BriefConvo = { render: render, SUBS: SUBS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
