/* omo-briefing plan block: pure renderer, classic script (file:// safe).
 * View model: plan_brief fields plus planId, rev, at, source, chips, checkedAt;
 * tasks[].state = done|doing|todo|stopped|blocked. No file or DOM access.
 * Expansion keys: plan:<planId>, plan-tasks:<planId>, plan-out:<planId>.
 * Link view models also provide target (owner card DOM id) and tab.
 * ui.answerBox(decisionId) (optional; view.js passes it on the server page) returns the answer controls of an open
 * question's decision, '' when that decision cannot be answered from this page.
 */
(function (g) {
  'use strict';

  var STAGES = { shaping: '구상', gate: '승인 대기', review: '검토 중', ready: '실행 준비', running: '실행 중', done: '끝남', dropped: '중단' };
  var STATES = { done: ['✔', '끝'], doing: ['●', '진행 중'], todo: ['○', '할 일'], stopped: ['○', '멈춤'], blocked: ['○', '막힘'] };

  function str(v) { return typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function own(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function flat(v) { return str(v).replace(/[\r\n]+/g, ' '); }
  function escapeHtml(v) {
    return str(v).replace(/[&<>"'`]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c];
    });
  }
  function hhmm(t) {
    var ms = typeof t === 'number' ? t : Date.parse(t);
    if (!isFinite(ms)) return '--:--';
    var d = new Date(ms);
    return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }
  function stage(plan) { return own(STAGES, plan.stage) || '구상'; }
  function state(task, tasks) {
    if (task.state === 'done' || task.state === 'stopped') return task.state;
    var blocked = arr(task.deps).some(function (id) {
      return tasks.some(function (t) { return str(t.id) === str(id) && t.state === 'stopped'; });
    });
    return blocked ? 'blocked' : own(STATES, task.state) ? task.state : 'todo';
  }
  function lanesOf(plan) {
    var tasks = arr(plan.tasks);
    return arr(plan.waves).map(function (w) {
      var items = tasks.filter(function (t) { return t.wave === w.n; });
      var done = items.filter(function (t) { return state(t, tasks) === 'done'; }).length;
      return { wave: w, tasks: items, done: done };
    });
  }
  function currentOf(lanes) {
    for (var i = 0; i < lanes.length; i++) if (lanes[i].done < lanes[i].tasks.length) return i;
    return -1;
  }
  function summary(plan, e) {
    return '📋 [' + e(flat((plan.source || {}).slug)) + '] ' + e(stage(plan)) + ' · 🎯 ' + e(flat(plan.goal));
  }
  function copyBtn(value, e) {
    return '<button type="button" class="copy" data-copy="' + e(value) + '" title="복사">⧉ 복사</button>';
  }
  function toggle(key, open, label, e) {
    return '<button type="button" class="more plan-toggle" data-act="exp" data-key="' + e(key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' + label + '</button>';
  }

  function render(plan, now, ui) {
    var e = ui.esc, expanded = ui.expanded || {};
    var id = str(plan.planId), key = 'plan:' + id;
    var open = !!own(expanded, key);
    var tasks = arr(plan.tasks), components = arr(plan.components), waves = lanesOf(plan);
    var current = currentOf(waves);
    var done = tasks.filter(function (t) { return state(t, tasks) === 'done'; }).length;
    var waiting = arr(plan.questions).filter(function (q) { return q.state === 'open'; }).length;
    function anchor(kind, itemId, field) {
      return ' data-anchor="' + e(id + '/' + kind + '/' + str(itemId) + (field ? '/' + field : '')) + '"';
    }
    function component(c) {
      return '<li class="plan-box p-todo"' + anchor('comp', c.id) + '><b class="plan-box-label"' + anchor('comp', c.id, 'label') + '>' + e(c.label) + '</b>' +
        '<span class="plan-component-text"' + anchor('comp', c.id, 'text') + '>' + e(c.text) + '</span></li>';
    }
    function taskBox(t) {
      var st = state(t, tasks), info = STATES[st];
      return '<li class="plan-box p-' + e(st) + '"' + anchor('task', t.id) + '><span class="plan-box-id">#' + e(t.id) + ' ' + e(info[0]) +
        (st === 'blocked' || st === 'stopped' ? ' <span class="plan-state-text">' + e(info[1]) + '</span>' : '') + '</span>' +
        '<b class="plan-box-label"' + anchor('task', t.id, 'label') + '>' + e(t.label) + '</b>' +
        (arr(t.deps).length ? '<span class="plan-deps">←' + e(t.deps.map(str).join('·')) + '</span>' : '') + '</li>';
    }
    function taskRow(t) {
      var st = state(t, tasks), info = STATES[st];
      return '<tr class="plan-task p-' + e(st) + '" data-plan-task-row="' + e(t.id) + '"><td class="plan-task-state">' + e(info[0]) +
        ' <span class="plan-state-text">' + e(info[1]) + '</span></td><td class="plan-task-id">#' + e(t.id) + '</td>' +
        '<td class="plan-task-what"' + anchor('task', t.id, 'what') + '>' + e(t.what) + '</td>' +
        '<td class="plan-task-done"' + anchor('task', t.id, 'done') + '><span class="plan-mobile-arrow" aria-hidden="true">⇒ </span>' + e(t.done) + '</td></tr>';
    }

    if (!open) {
      var mini = waves.map(function (w) {
        var st = w.tasks.some(function (t) { return state(t, tasks) === 'doing'; }) ? 'doing' : 'todo';
        if (w.tasks.length && w.done === w.tasks.length) st = 'done';
        return str(w.wave.n) + STATES[st][0];
      }).join(' ');
      return '<div class="plan-view plan-collapsed" data-plan="' + e(id) + '"><div class="plan-summary-line">' + summary(plan, e) + '</div>\n' +
        '<div class="plan-summary-line">' + (mini ? e(mini) + ' · ' : '') + '할 일 ' + e(done) + '/' + e(tasks.length) + ' 끝 · 정할 것 ' + e(waiting) + ' · ' +
        toggle(key, false, '▾ 계획 보기', e) + '</div></div>';
    }

    var source = plan.source || {};
    var path = source.planPath || source.draftPath || plan.planPath || plan.draftPath;
    var html = '<section class="plan-view plan-expanded" data-plan="' + e(id) + '"><div class="plan-head">' +
      '<span class="chip p-stage">' + e(stage(plan)) + '</span>' + arr(plan.chips).map(function (c) { return '<span class="chip x-info">' + e(c) + '</span>'; }).join('') +
      '<span class="time">⏱ r' + e(plan.rev) + ' ' + e(hhmm(plan.at)) + '</span>' +
      toggle(key, true, '▴ 계획 닫기', e) + '</div>';
    if (path) html += '<div class="plan-path"><code>' + e(path) + '</code>' + copyBtn(path, e) + '</div>';
    if (plan.stageNote) html += '<p class="plan-stage-note">' + e(plan.stageNote) + '</p>';
    if (plan.checkedAt != null) html += '<p class="plan-checked">마지막 확인 ⏱ ' + e(hhmm(plan.checkedAt)) + '</p>';
    html += '<p class="plan-goal">🎯 <b' + anchor('goal', 'main') + '>' + e(plan.goal) + '</b></p>';

    // Components remain addressable after tasks exist, without duplicating their boxes.
    if (tasks.length && components.length) html += '<ul class="plan-components">' + components.map(component).join('') + '</ul>';
    html += '<div class="plan-lanes">';
    if (!tasks.length) {
      html += '<section class="plan-lane" data-plan-components><h4 class="plan-wave-head">큰 덩어리</h4><ul class="plan-boxes">' + components.map(component).join('') + '</ul>';
      // Keep preassigned wave anchors inside the one component lane.
      waves.forEach(function (w) {
        html += '<span class="plan-empty-wave"' + anchor('wave', w.wave.n) + '>#' + e(w.wave.n) + ' <span' + anchor('wave', w.wave.n, 'label') + '>' + e(w.wave.label) + '</span></span>';
      });
      html += '</section>';
    } else {
      waves.forEach(function (w, i) {
        html += '<section class="plan-lane' + (i === current ? ' is-current' : '') + '" data-plan-wave="' + e(w.wave.n) + '"' + anchor('wave', w.wave.n) + '>' +
          '<h4 class="plan-wave-head">' + e(w.wave.n) + '단계 · <span' + anchor('wave', w.wave.n, 'label') + '>' + e(w.wave.label) + '</span> · ' + e(w.done) + '/' + e(w.tasks.length) + ' 끝' +
          (i === current ? ' <span class="plan-now">지금</span>' : '') + '</h4><ul class="plan-boxes">' + w.tasks.map(taskBox).join('') + '</ul></section>';
      });
    }
    html += '</div>';

    if (tasks.length) {
      var currentTasks = current < 0 ? [] : waves[current].tasks;
      var others = tasks.filter(function (t) { return currentTasks.indexOf(t) < 0; });
      var moreKey = 'plan-tasks:' + id, more = !!own(expanded, moreKey);
      html += '<h4 class="plan-label">할 일</h4><table class="plan-task-table"><thead><tr><th scope="col">상태</th><th scope="col">#</th><th scope="col">할 일</th><th scope="col">끝 기준</th></tr></thead>' +
        '<tbody class="plan-current-tasks">' + currentTasks.map(taskRow).join('') + '</tbody>';
      if (others.length) html += '<tbody class="plan-other-tasks"' + (more ? '' : ' hidden') + '>' + others.map(taskRow).join('') + '</tbody>';
      html += '</table>';
      if (others.length) html += toggle(moreKey, more, more ? '▴ 나머지 접기' : '▾ 외 ' + e(others.length) + '개', e);
    }

    var questions = arr(plan.questions).filter(function (q) { return q.state === 'open'; }).concat(arr(plan.questions).filter(function (q) { return q.state !== 'open'; }));
    if (questions.length) {
      html += '<h4 class="plan-label">질의응답</h4><table class="plan-qa-table"><thead><tr><th scope="col">#</th><th scope="col">질문</th><th scope="col">답</th><th scope="col">상태</th></tr></thead><tbody>';
      questions.forEach(function (q) {
        var isOpen = q.state === 'open';
        var command = '/decide ' + str(q.decisionId) + str(q.recommend);
        var box = isOpen && typeof ui.answerBox === 'function' ? ui.answerBox(q.decisionId) : '';
        var answer = !isOpen ? e(q.answer)
          : box ? box + '<span class="plan-answer-copy">답: <code>' + e(command) + '</code> ' + copyBtn(command, e) + ' <span class="ans-hint">· 아무 대화창에 붙여넣어도 됩니다</span></span>'
          : '답 기다림 · <code>' + e(command) + '</code> ' + copyBtn(command, e);
        var status = isOpen ? (q.blocks ? '<span class="chip x-block">막는 결정</span>' : '답 기다림') : q.state === 'default' ? '<span class="chip x-info plan-default">기본값</span>' : e((q.by === 'owner' ? '소유자 ' : '에이전트 ') + str(q.option || q.answer));
        html += '<tr class="plan-question is-' + e(q.state) + '"' + anchor('q', q.id) + (isOpen ? ' data-decision="' + e(q.decisionId) + '"' : '') + '><td class="plan-question-id">' + e(q.id) + '</td>' +
          '<td class="plan-question-text"' + anchor('q', q.id, 'text') + '>' + e(q.text) + '</td><td class="plan-question-answer"' + anchor('q', q.id, 'answer') + '>' + answer + '</td><td class="plan-question-state">' + status + '</td></tr>';
      });
      html += '</tbody></table>';
    }

    html += '<h4 class="plan-label">✔ 성공하면</h4><ul class="plan-ideal">' + arr(plan.ideal).map(function (item) {
      return '<li' + anchor('is', item.id) + '><b>' + e(item.id) + '</b> <span' + anchor('is', item.id, 'text') + '>' + e(item.text) + '</span></li>';
    }).join('') + '</ul>';
    var outKey = 'plan-out:' + id, out = !!own(expanded, outKey);
    html += '<div class="plan-out">' + toggle(outKey, out, '🚫 안 하는 것 ' + (out ? '▴' : '▾'), e) + '<ul class="plan-out-list"' + (out ? '' : ' hidden') + '>' + arr(plan.outOfScope).map(function (text, i) {
      return '<li' + anchor('out', i + 1) + '><span' + anchor('out', i + 1, 'text') + '>' + e(text) + '</span></li>';
    }).join('') + '</ul></div>';
    html += '<p class="plan-legend">초록 ✔ 끝 · 청록 ● 진행 · 회색 ○ 할 일 · 회색 점선 멈춤 · 빨강 막힘</p>';
    return html + '</section>';
  }

  // Standalone calls need no BriefView dependency; callers may pass their esc too.
  function renderLink(plan, ui) {
    var esc = ui && ui.esc || escapeHtml;
    function e(value) { return esc(flat(value)); }
    var text = summary(plan, e);
    return plan.target ? '<a class="plan-link" href="#' + e(plan.target) + '" data-goto="' + e(plan.target) + '"' + (plan.tab ? ' data-tab="' + e(plan.tab) + '"' : '') + '>' + text + '</a>' : '<span class="plan-link">' + text + '</span>';
  }

  g.BriefPlanView = { render: render, renderLink: renderLink };
})(typeof globalThis !== 'undefined' ? globalThis : this);
