/* omo-briefing memento cards view (TASK14, unwired).
 * Classic script; globalThis.BriefCards = {mount, update}. The host supplies ctx.live and
 * ctx.setStatus(id, status, rev) -> {status, body, retryAfterMs?, headers?}; ctx.wait(ms) and
 * ctx.refresh() are optional. DOM nodes are created and filled with text only; model strings never
 * become markup. Tokens come from tokens.css/page.css; cards-view.css adds only local aliases.
 * allow: SIZE_OK - the TASK14 file fence allows one classic view script and one stylesheet.
 */
(function (g) {
  'use strict';

  var DOC = g.document;
  var STATUSES = [
    ['idea', '메모'],
    ['researching', '조사중'],
    ['planned', '계획됨'],
    ['building', '구현중'],
    ['done', '완료'],
    ['held', '보류'],
    ['dropped', '폐기']
  ];
  var STATUS_LABELS = Object.create(null);
  STATUSES.forEach(function (status) { STATUS_LABELS[status[0]] = status[1]; });
  var SOURCE_LABELS = { paste: '붙여넣기', discord: '디스코드', 'old-wiki': '옛 위키' };
  var DISCORD_LABELS = {
    none: '연결 안 됨', posting: '게시 중', linked: '연결됨', deleted: '글 삭제됨',
    conflict: '충돌', invalid: '태그 이상'
  };
  var ACTOR_LABELS = { owner: '소유자', memento: '메멘토' };
  var VIA_LABELS = { board: '상황판', discord: '디스코드', paste: '붙여넣기', 'old-wiki': '옛 위키', sync: '동기화' };
  var CHANGE_LABELS = {
    create: '생성', status: '상태', original: '원문', link: '연결', conflict: '충돌',
    'remote-deleted': '디스코드 삭제', 'adopted-orphan': '글에서 복구',
    'invalid-remote': '태그 이상', 'skipped-secret': '비밀값 건너뜀'
  };
  var REPLY_LABELS = { pushed: '반영됨', pending: '대기 중', off: '디스코드 꺼짐', conflict: '충돌' };
  var TEXT = {
    empty: '아직 카드가 없어요',
    noMatch: '조건에 맞는 카드가 없어요',
    readOnly: '읽기 전용 화면이에요. 상태는 실시간 상황판에서 바꿀 수 있어요.',
    unavailable: '지금은 메멘토를 쓸 수 없어요',
    retry: '잠시 뒤 다시 해 주세요',
    stale: '다른 곳에서 바뀌어 다시 불러왔어요',
    saveFailed: '저장하지 못했어요. 상태를 다시 선택해 주세요.'
  };

  var mounts = new WeakMap();
  var current = null;

  function str(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && isFinite(value)) return String(value);
    return '';
  }
  function arr(value) { return Array.isArray(value) ? value : []; }
  function hasOwn(object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
  }
  function own(object, key) { return hasOwn(object, key) ? object[key] : undefined; }
  function number(value) { return typeof value === 'number' && isFinite(value); }
  function report(where, error) {
    if (g.console && typeof g.console.error === 'function') g.console.error('[omo-briefing] cards-view ' + where, error);
  }
  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }
  function node(tag, className, text) {
    var element = DOC.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(className, text) {
    var element = node('button', className, text);
    element.type = 'button';
    return element;
  }
  function chip(text, tone) {
    return node('span', 'mcards-chip' + (tone ? ' mcards-chip-' + tone : ''), text);
  }
  function cell(label) {
    var element = node('td', 'mcards-cell');
    element.appendChild(node('span', 'mcards-cell-label', label));
    return element;
  }
  function valueCell(label, text, muted) {
    var element = cell(label);
    element.appendChild(node('span', 'mcards-value' + (muted ? ' mcards-muted' : ''), text));
    return element;
  }
  function statusLabel(key, state) {
    var list = state && Array.isArray(state.statuses) ? state.statuses : null;
    if (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === key && typeof list[i].label === 'string') return list[i].label;
      }
    }
    return own(STATUS_LABELS, key) || str(key) || '—';
  }
  function sourceLabel(source) { return own(SOURCE_LABELS, source) || str(source) || '—'; }
  function discordLabel(state) { return own(DISCORD_LABELS, state) || str(state) || '연결 안 됨'; }
  function dateLabel(value) {
    var text = str(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10).replace(/-/g, '.');
    return text || '—';
  }
  function timeLabel(value) {
    var text = str(value);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
      return text.slice(5, 10).replace('-', '.') + ' ' + text.slice(11, 16);
    }
    return text || '—';
  }
  function logLine(view, entry) {
    if (!entry || typeof entry !== 'object') return '—';
    var bits = [
      own(ACTOR_LABELS, entry.actor) || str(entry.actor) || '—',
      own(VIA_LABELS, entry.via) || str(entry.via) || '—'
    ];
    var change = own(CHANGE_LABELS, entry.change) || str(entry.change) || '변경';
    if (entry.from || entry.to) {
      change += ' ' + statusLabel(entry.from, view.state) + ' → ' + statusLabel(entry.to, view.state);
    }
    bits.push(change);
    if (entry.reason) bits.push(str(entry.reason));
    return bits.join(' · ');
  }
  function discordTone(state) {
    if (state === 'linked') return 'ok';
    if (state === 'posting') return 'info';
    if (state === 'deleted' || state === 'conflict') return 'danger';
    if (state === 'invalid') return 'warn';
    return 'gray';
  }
  function replyTone(discord) {
    if (discord === 'pushed') return 'ok';
    if (discord === 'pending') return 'info';
    if (discord === 'conflict') return 'danger';
    return 'gray';
  }
  function setSelectTone(select, status) {
    var key = hasOwn(STATUS_LABELS, status) ? status : 'idea';
    select.className = 'mcards-status-select mcards-tone-' + key;
  }
  function setExpand(control, open) {
    control.textContent = open ? '원문·메모 접기' : '원문·메모 보기';
    control.ariaExpanded = open ? 'true' : 'false';
  }
  function remember(view, element, key) {
    element.__mcardsFocusKey = key;
    view.focusables.push(element);
    return element;
  }
  function bindTouchPressed(element) {
    element.addEventListener('pointerdown', function (event) {
      if (event && event.pointerType === 'touch' && !element.disabled) element.classList.add('mcards-touch-pressed');
    });
    function clearTouchPressed() { element.classList.remove('mcards-touch-pressed'); }
    element.addEventListener('pointerup', clearTouchPressed);
    element.addEventListener('pointercancel', clearTouchPressed);
    element.addEventListener('pointerleave', clearTouchPressed);
  }
  function focusKeyOf(element) {
    return element && typeof element.__mcardsFocusKey === 'string' ? element.__mcardsFocusKey : null;
  }
  function liveOf(context) {
    return !!context && context.live !== false && typeof context.setStatus === 'function';
  }
  function showNotice(view, text, tone) {
    view.notice.className = 'mcards-notice mcards-notice-' + (tone || 'warn');
    view.notice.textContent = text;
    view.notice.hidden = false;
  }
  function hideNotice(view) {
    view.notice.className = 'mcards-notice';
    view.notice.textContent = '';
    view.notice.hidden = true;
  }
  function syncControls(view) {
    for (var id in view.refs) {
      if (!hasOwn(view.refs, id)) continue;
      var controls = view.refs[id].controls || [];
      for (var i = 0; i < controls.length; i++) controls[i].disabled = view.locked;
    }
  }
  function refresh(view) {
    if (!view.ctx || typeof view.ctx.refresh !== 'function') return;
    try {
      var pending = view.ctx.refresh();
      if (pending && typeof pending.catch === 'function') pending.catch(function (error) { report('refresh', error); });
    } catch (error) {
      report('refresh', error);
    }
  }
  function setReply(element, text, tone) {
    if (!element) return;
    element.className = 'mcards-reply mcards-reply-' + tone;
    element.textContent = text;
    element.hidden = false;
  }
  function fail(view, text, tone) {
    view.failure = true;
    view.locked = true;
    showNotice(view, text, tone);
    syncControls(view);
  }
  function isBusy(reply) {
    if (!reply) return false;
    if (reply.status === 429) return true;
    return reply.status === 409 && reply.body && reply.body.code === 'BUSY';
  }
  function isWriteFailed(reply) {
    return !!reply && reply.status === 500
      && !!reply.body && reply.body.ok === false && reply.body.code === 'WRITE_FAILED';
  }
  function retryDelay(reply) {
    if (number(reply.retryAfterMs) && reply.retryAfterMs >= 0) return reply.retryAfterMs;
    if (reply.body && number(reply.body.retryAfterMs) && reply.body.retryAfterMs >= 0) return reply.body.retryAfterMs;
    var headers = reply.headers;
    var header = headers && (headers['retry-after'] || headers['Retry-After']);
    if (header !== undefined) {
      var seconds = Number(header);
      if (number(seconds) && seconds >= 0) return seconds * 1000;
    }
    return 1000;
  }
  function waitFor(view, milliseconds) {
    if (view.ctx && typeof view.ctx.wait === 'function') return Promise.resolve(view.ctx.wait(milliseconds));
    return new Promise(function (resolve) {
      if (typeof g.setTimeout === 'function') g.setTimeout(resolve, milliseconds);
      else resolve();
    });
  }
  function request(view, card, status, op) {
    try {
      var rev = op && number(op.rev) ? op.rev : (number(card.rev) ? card.rev : 0);
      return Promise.resolve(view.ctx.setStatus(card.id, status, rev));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  function hideReply(element) {
    if (!element) return;
    element.className = 'mcards-reply';
    element.textContent = '';
    element.hidden = true;
  }
  function findCard(cards, id) {
    for (var i = 0; i < cards.length; i++) if (cards[i] && cards[i].id === id) return cards[i];
    return null;
  }
  function cardById(view, id) {
    return findCard(arr(view.state && view.state.cards), id);
  }
  function cardRev(view, id) {
    var card = cardById(view, id);
    return card && number(card.rev) ? card.rev : 0;
  }
  function authoritativeStatus(view, card) {
    var stateCard = card && card.id ? cardById(view, card.id) : null;
    if (stateCard) return stateCard.status;
    return card ? card.status : 'idea';
  }
  function updateCardSnapshot(view, id, status, rev) {
    var state = view.state && typeof view.state === 'object' ? view.state : { cards: [] };
    var cards = arr(state.cards).map(function (card) {
      if (!card || card.id !== id) return card;
      var next = {};
      for (var key in card) if (hasOwn(card, key)) next[key] = card[key];
      next.status = status;
      next.rev = rev;
      return next;
    });
    var nextState = {};
    for (var key in state) if (hasOwn(state, key)) nextState[key] = state[key];
    nextState.cards = cards;
    view.state = nextState;
  }
  function canWrite(view) {
    return view.alive === true
      && current === view
      && view.live === true
      && view.locked !== true
      && view.failure !== true
      && view.ctx
      && typeof view.ctx.setStatus === 'function';
  }
  function ownsOp(view, id, op) {
    return !!op
      && op.pending === true
      && view.alive === true
      && current === view
      && view.ops[id] === op;
  }
  function finishOp(view, id, op) {
    if (op) op.pending = false;
    if (view.ops[id] === op) delete view.ops[id];
  }
  function cancelOps(view) {
    for (var id in view.ops) {
      if (!hasOwn(view.ops, id)) continue;
      view.ops[id].pending = false;
      delete view.ops[id];
    }
  }
  function renderCardFeedback(view, id) {
    var refs = view.refs[id];
    if (!refs) return;
    var op = view.ops[id];
    var feedback = view.feedback[id];
    var card = cardById(view, id);
    var target = (op && op.target) || (feedback && feedback.target) || 'row';
    var reply = target === 'conflict' ? (refs.conflictReply || refs.reply) : refs.reply;
    var other = target === 'conflict' ? refs.reply : refs.conflictReply;
    if (other) hideReply(other);
    if (op && op.pending) {
      if (refs.select) {
        var optimistic = !number(op.rev) || cardRev(view, id) <= op.rev;
        var pendingStatus = optimistic ? op.status : authoritativeStatus(view, card);
        refs.select.value = pendingStatus;
        setSelectTone(refs.select, pendingStatus);
      }
      setReply(reply, '보내는 중…', 'info');
      return;
    }
    if (feedback) {
      if (feedback.kind === 'success' && feedback.status && refs.select
        && number(feedback.rev) && feedback.rev >= cardRev(view, id)) {
        refs.select.value = feedback.status;
        setSelectTone(refs.select, feedback.status);
      } else if (feedback.kind === 'save-failed' && feedback.status && refs.select) {
        refs.select.value = feedback.status;
        setSelectTone(refs.select, feedback.status);
      } else if (refs.select) {
        var currentStatus = authoritativeStatus(view, card);
        refs.select.value = currentStatus;
        setSelectTone(refs.select, currentStatus);
      }
      setReply(reply, feedback.text, feedback.tone);
      return;
    }
    if (refs.select) {
      var status = authoritativeStatus(view, card);
      refs.select.value = status;
      setSelectTone(refs.select, status);
    }
    if (refs.reply) hideReply(refs.reply);
    if (refs.conflictReply) hideReply(refs.conflictReply);
  }
  function settle(view, card, status, op, reply) {
    var id = card.id;
    if (!ownsOp(view, id, op)) return;
    var code = reply && reply.status;
    var body = reply && reply.body;
    if (code === 200 && body && body.ok === true) {
      var currentRev = cardRev(view, id);
      var responseRev = number(body.rev) ? body.rev : currentRev;
      if (responseRev < currentRev) {
        finishOp(view, id, op);
        renderCardFeedback(view, id);
        return;
      }
      updateCardSnapshot(view, id, status, responseRev);
      finishOp(view, id, op);
      view.feedback[id] = {
        kind: 'success', target: op.target, status: status, rev: responseRev,
        text: own(REPLY_LABELS, body.discord) || '반영됨', tone: replyTone(body.discord)
      };
      renderCardFeedback(view, id);
      return;
    }
    if (code === 409 && body && body.code === 'STALE') {
      var staleRev = number(body.rev) ? body.rev : cardRev(view, id);
      finishOp(view, id, op);
      view.feedback[id] = { kind: 'stale', target: op.target, text: TEXT.stale, tone: 'info', rev: staleRev };
      renderCardFeedback(view, id);
      refresh(view);
      return;
    }
    if (isWriteFailed(reply)) {
      finishOp(view, id, op);
      view.feedback[id] = {
        kind: 'save-failed', target: op.target, status: status,
        text: TEXT.saveFailed, tone: 'danger', rev: cardRev(view, id)
      };
      renderCardFeedback(view, id);
      return;
    }
    if (isBusy(reply)) {
      finishOp(view, id, op);
      view.feedback[id] = { kind: 'error', target: op.target, text: TEXT.retry, tone: 'warn', rev: cardRev(view, id) };
      renderCardFeedback(view, id);
      return;
    }
    if (code === 503) {
      fail(view, TEXT.readOnly, 'warn');
      finishOp(view, id, op);
      view.feedback[id] = { kind: 'error', failure: true, target: op.target, text: '읽기 전용', tone: 'warn', rev: cardRev(view, id) };
      renderCardFeedback(view, id);
      return;
    }
    if (code === 501 || code === 504) {
      fail(view, TEXT.unavailable, 'danger');
      finishOp(view, id, op);
      view.feedback[id] = { kind: 'error', failure: true, target: op.target, text: TEXT.unavailable, tone: 'danger', rev: cardRev(view, id) };
      renderCardFeedback(view, id);
      return;
    }
    finishOp(view, id, op);
    view.feedback[id] = { kind: 'error', target: op.target, text: '상태를 바꾸지 못했어요', tone: 'danger', rev: cardRev(view, id) };
    renderCardFeedback(view, id);
  }
  async function applyStatus(view, card, status, target) {
    if (!canWrite(view)) return;
    var id = card.id;
    if (view.ops[id] && view.ops[id].pending) {
      renderCardFeedback(view, id);
      return;
    }
    var snapshot = cardById(view, id) || card;
    var op = {
      status: status,
      target: target === 'conflict' ? 'conflict' : 'row',
      rev: number(snapshot.rev) ? snapshot.rev : (number(card.rev) ? card.rev : 0),
      pending: true
    };
    view.ops[id] = op;
    delete view.feedback[id];
    renderCardFeedback(view, id);
    try {
      var first = await request(view, card, status, op);
      if (!ownsOp(view, id, op)) { finishOp(view, id, op); return; }
      if (!isBusy(first)) { settle(view, card, status, op, first); return; }
      await waitFor(view, retryDelay(first));
      if (!canWrite(view) || !ownsOp(view, id, op)) { finishOp(view, id, op); return; }
      var second = await request(view, card, status, op);
      if (!ownsOp(view, id, op)) { finishOp(view, id, op); return; }
      settle(view, card, status, op, second);
    } catch (error) {
      if (!ownsOp(view, id, op)) { finishOp(view, id, op); return; }
      report('setStatus', error);
      settle(view, card, status, op, { status: 0, body: {} });
    }
  }

  function updateProjects(view) {
    var projects = [];
    arr(view.state && view.state.cards).forEach(function (card) {
      if (card && typeof card.project === 'string' && card.project && projects.indexOf(card.project) < 0) {
        projects.push(card.project);
      }
    });
    projects.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    var selected = view.projectValue;
    clear(view.project);
    var all = node('option', '', '전체 프로젝트');
    all.value = '';
    view.project.appendChild(all);
    projects.forEach(function (project) {
      var option = node('option', '', project);
      option.value = project;
      view.project.appendChild(option);
    });
    if (projects.indexOf(selected) < 0) selected = '';
    view.projectValue = selected;
    view.project.value = selected;
  }
  function syncChips(view) {
    view.allChip.className = 'mcards-chip' + (view.status === 'all' ? ' on' : '');
    view.allChip.ariaPressed = view.status === 'all' ? 'true' : 'false';
    STATUSES.forEach(function (status) {
      var control = view.chipButtons[status[0]];
      var on = view.status === status[0];
      control.className = 'mcards-chip' + (on ? ' on' : '');
      control.ariaPressed = on ? 'true' : 'false';
    });
  }
  function visible(view, card) {
    if (!card || typeof card !== 'object') return false;
    var query = view.searchValue.trim().toLowerCase();
    if (card.unreadable) return view.status === 'all' && !view.projectValue && !query;
    if (view.status !== 'all' && card.status !== view.status) return false;
    if (view.projectValue && card.project !== view.projectValue) return false;
    if (!query) return true;
    return str(card.title).toLowerCase().indexOf(query) >= 0
      || str(card.description).toLowerCase().indexOf(query) >= 0;
  }
  function updateSummary(view, total, shown) {
    var bits = ['카드 ' + total + '장'];
    if (shown !== total) bits.push('보기 ' + shown + '장');
    if (view.state && view.state.lastSync) bits.push('마지막 동기화 ' + dateLabel(view.state.lastSync));
    if (view.state && number(view.state.unpushedCommits) && view.state.unpushedCommits > 0) {
      bits.push('푸시 대기 ' + view.state.unpushedCommits + '건');
    }
    view.summary.textContent = bits.join(' · ');
  }
  function textSection(title, value, truncated) {
    var section = node('section', 'mcards-section');
    section.appendChild(node('h3', 'mcards-section-title', title));
    section.appendChild(node('pre', 'mcards-text', str(value) || '—'));
    if (truncated) section.appendChild(node('p', 'mcards-truncated', '일부만 표시했어요'));
    return section;
  }
  function logSection(view, log) {
    var section = node('section', 'mcards-section');
    section.appendChild(node('h3', 'mcards-section-title', '변경 기록'));
    var entries = arr(log);
    if (!entries.length) {
      section.appendChild(node('p', 'mcards-muted', '변경 기록이 없어요'));
      return section;
    }
    var list = node('ol', 'mcards-log');
    entries.forEach(function (entry) {
      var item = node('li', 'mcards-log-item');
      item.appendChild(node('span', 'mcards-log-when', timeLabel(entry && entry.at)));
      item.appendChild(node('span', 'mcards-log-what', logLine(view, entry)));
      list.appendChild(item);
    });
    section.appendChild(list);
    return section;
  }
  function detailRow(view, card, open) {
    var row = node('tr', 'mcards-detail-row');
    row.__mcardsId = card.id;
    row.hidden = !open;
    var td = node('td', 'mcards-detail-cell');
    td.colSpan = 6;
    var panel = node('div', 'mcards-detail');
    panel.appendChild(textSection('원문', card.original, card.originalTruncated));
    panel.appendChild(textSection('메모', card.notes, card.notesTruncated));
    panel.appendChild(logSection(view, card.log));
    td.appendChild(panel);
    row.appendChild(td);
    return row;
  }
  function conflictValue(side, label) {
    var item = node('span', 'mcards-conflict-value');
    item.appendChild(node('span', 'mcards-conflict-side', side));
    item.appendChild(node('b', 'mcards-conflict-status', label));
    return item;
  }
  function conflictRow(view, card, refs) {
    var conflict = card.conflict;
    if (!conflict || typeof conflict !== 'object') return null;
    var row = node('tr', 'mcards-conflict-row');
    row.__mcardsId = card.id;
    var td = node('td', 'mcards-conflict-cell');
    td.colSpan = 6;
    var box = node('div', 'mcards-conflict');
    box.appendChild(node('p', 'mcards-conflict-title', '상태가 엇갈렸어요'));
    var values = node('div', 'mcards-conflict-values');
    values.appendChild(conflictValue('상황판', statusLabel(conflict.card, view.state)));
    var candidates = arr(conflict.discord);
    candidates.forEach(function (key) {
      values.appendChild(conflictValue('디스코드', statusLabel(key, view.state)));
    });
    box.appendChild(values);
    var actions = node('div', 'mcards-conflict-actions');
    var reply = node('span', 'mcards-reply');
    reply.role = 'status';
    reply.hidden = true;
    var pickCard = button('mcards-pick', '상황판 값 적용');
    remember(view, pickCard, 'conflict-card:' + card.id);
    bindTouchPressed(pickCard);
    pickCard.disabled = view.locked;
    pickCard.addEventListener('click', function () {
      return applyStatus(view, card, conflict.card, 'conflict');
    });
    actions.appendChild(pickCard);
    refs.controls.push(pickCard);
    var seen = Object.create(null);
    candidates.forEach(function (key) {
      if (seen[key]) return;
      seen[key] = true;
      var label = candidates.length > 1 ? '디스코드 값 적용 (' + statusLabel(key, view.state) + ')' : '디스코드 값 적용';
      var pick = button('mcards-pick', label);
      remember(view, pick, 'conflict-discord:' + card.id + ':' + key);
      bindTouchPressed(pick);
      pick.disabled = view.locked;
      pick.addEventListener('click', function () {
        return applyStatus(view, card, key, 'conflict');
      });
      actions.appendChild(pick);
      refs.controls.push(pick);
    });
    box.appendChild(actions);
    box.appendChild(reply);
    refs.conflictReply = reply;
    td.appendChild(box);
    row.appendChild(td);
    return row;
  }
  function unreadableCard(card) {
    var row = node('tr', 'mcards-row mcards-unreadable');
    row.__mcardsId = card.id;
    var title = cell('제목');
    title.appendChild(node('span', 'mcards-id', str(card.id)));
    title.appendChild(node('span', 'mcards-desc', '읽을 수 없는 카드'));
    row.appendChild(title);
    var status = cell('상태');
    status.appendChild(chip('읽을 수 없음', 'danger'));
    status.appendChild(node('span', 'mcards-desc', str(card.unreadable)));
    row.appendChild(status);
    row.appendChild(valueCell('프로젝트', '—', true));
    row.appendChild(valueCell('바뀐 날', '—', true));
    row.appendChild(valueCell('출처', '—', true));
    row.appendChild(valueCell('디스코드', '—', true));
    return { row: row, conflict: null, detail: null };
  }
  function readableCard(view, card) {
    var refs = { controls: [], select: null, conflictReply: null };
    view.refs[card.id] = refs;
    var open = !!own(view.open, card.id);
    var detail = detailRow(view, card, open);
    var row = node('tr', 'mcards-row');
    row.__mcardsId = card.id;

    var title = cell('제목');
    var titleLine = node('div', 'mcards-title-line');
    var expand = button('mcards-expand');
    remember(view, expand, 'expand:' + card.id);
    bindTouchPressed(expand);
    setExpand(expand, open);
    expand.addEventListener('click', function () {
      var next = !own(view.open, card.id);
      if (next) view.open[card.id] = true;
      else delete view.open[card.id];
      detail.hidden = !next;
      setExpand(expand, next);
    });
    titleLine.appendChild(expand);
    titleLine.appendChild(node('span', 'mcards-card-title', str(card.title) || '—'));
    title.appendChild(titleLine);
    title.appendChild(node('span', 'mcards-desc', str(card.description) || '—'));
    row.appendChild(title);

    var status = cell('상태');
    var statusLine = node('div', 'mcards-status-line');
    var select = node('select', 'mcards-status-select');
    select.ariaLabel = '상태 바꾸기: ' + (str(card.title) || str(card.id));
    remember(view, select, 'status:' + card.id);
    STATUSES.forEach(function (entry) {
      var option = node('option', '', entry[1]);
      option.value = entry[0];
      select.appendChild(option);
    });
    select.value = card.status;
    setSelectTone(select, card.status);
    select.disabled = view.locked;
    var reply = node('span', 'mcards-reply');
    reply.role = 'status';
    reply.hidden = true;
    select.addEventListener('change', function () {
      return applyStatus(view, card, select.value, 'row');
    });
    statusLine.appendChild(select);
    statusLine.appendChild(reply);
    status.appendChild(statusLine);
    row.appendChild(status);
    refs.select = select;
    refs.reply = reply;
    refs.controls.push(select);

    row.appendChild(valueCell('프로젝트', card.project ? str(card.project) : '—', !card.project));
    row.appendChild(valueCell('바뀐 날', dateLabel(card.updated)));
    row.appendChild(valueCell('출처', sourceLabel(card.source)));
    var discordCell = cell('디스코드');
    var discordState = card.discord && typeof card.discord === 'object' ? card.discord.state : 'none';
    discordCell.appendChild(chip(discordLabel(discordState), discordTone(discordState)));
    row.appendChild(discordCell);
    return { row: row, conflict: conflictRow(view, card, refs), detail: detail };
  }
  function buildCard(view, card) {
    return card.unreadable ? unreadableCard(card) : readableCard(view, card);
  }
  function renderBody(view) {
    var key = focusKeyOf(DOC.activeElement);
    view.focusables = [];
    view.refs = Object.create(null);
    clear(view.tbody);
    var cards = arr(view.state && view.state.cards);
    var shown = 0;
    cards.forEach(function (card) {
      if (!visible(view, card)) return;
      shown++;
      var built = buildCard(view, card);
      view.tbody.appendChild(built.row);
      if (built.conflict) view.tbody.appendChild(built.conflict);
      if (built.detail) view.tbody.appendChild(built.detail);
    });
    view.tableWrap.hidden = shown === 0;
    view.empty.hidden = shown !== 0;
    view.emptyText.textContent = cards.length ? TEXT.noMatch : TEXT.empty;
    updateSummary(view, cards.length, shown);
    for (var id in view.refs) {
      if (hasOwn(view.refs, id)) renderCardFeedback(view, id);
    }
    syncControls(view);
    if (key && !view.locked) {
      for (var i = 0; i < view.focusables.length; i++) {
        if (focusKeyOf(view.focusables[i]) === key) {
          view.focusables[i].focus();
          break;
        }
      }
    }
  }
  function pruneFeedback(view) {
    for (var id in view.feedback) {
      if (!hasOwn(view.feedback, id)) continue;
      var feedback = view.feedback[id];
      if (!cardById(view, id) && !view.ops[id]) { delete view.feedback[id]; continue; }
      if (feedback.kind !== 'stale' && number(feedback.rev) && cardRev(view, id) > feedback.rev) delete view.feedback[id];
    }
  }
  function applyState(view, state) {
    var incoming = state && typeof state === 'object' ? state : { cards: [] };
    var previous = arr(view.state && view.state.cards);
    var cards = arr(incoming.cards).map(function (card) {
      if (!card || !card.id) return card;
      var old = findCard(previous, card.id);
      if (old && number(old.rev) && number(card.rev) && card.rev < old.rev) return old;
      return card;
    });
    var next = {};
    for (var key in incoming) if (hasOwn(incoming, key)) next[key] = incoming[key];
    next.cards = cards;
    view.state = next;
    var wasFailure = view.failure === true;
    view.failure = false;
    view.live = liveOf(view.ctx);
    view.locked = !view.live;
    if (!view.live) cancelOps(view);
    if (view.live && wasFailure) {
      for (var id in view.feedback) {
        if (hasOwn(view.feedback, id) && view.feedback[id].failure === true) delete view.feedback[id];
      }
    }
    pruneFeedback(view);
    if (view.live) hideNotice(view);
    else showNotice(view, TEXT.readOnly, 'warn');
    updateProjects(view);
    syncChips(view);
    renderBody(view);
  }
  function bindToolbar(view) {
    view.search.addEventListener('input', function () {
      view.searchValue = view.search.value;
      renderBody(view);
    });
    view.project.addEventListener('change', function () {
      view.projectValue = view.project.value;
      renderBody(view);
    });
    view.allChip.addEventListener('click', function () {
      view.status = 'all';
      syncChips(view);
      renderBody(view);
    });
    bindTouchPressed(view.allChip);
    STATUSES.forEach(function (status) {
      view.chipButtons[status[0]].addEventListener('click', function () {
        view.status = status[0];
        syncChips(view);
        renderBody(view);
      });
      bindTouchPressed(view.chipButtons[status[0]]);
    });
  }
  function createView(container, context) {
    container.textContent = '';
    var root = node('section', 'mcards-root');
    root.ariaLabel = '메멘토 카드';
    var head = node('header', 'mcards-head');
    var titleBlock = node('div', 'mcards-titleblock');
    titleBlock.appendChild(node('h2', 'mcards-heading', '메멘토'));
    var summary = node('p', 'mcards-summary', '카드를 불러오는 중이에요');
    titleBlock.appendChild(summary);
    head.appendChild(titleBlock);
    root.appendChild(head);

    var notice = node('p', 'mcards-notice');
    notice.role = 'status';
    notice.ariaLive = 'polite';
    notice.hidden = true;
    root.appendChild(notice);

    var toolbar = node('div', 'mcards-toolbar');
    var searchLabel = node('label', 'mcards-search');
    searchLabel.appendChild(node('span', 'mcards-search-label', '검색'));
    var search = node('input', 'mcards-search-input');
    search.type = 'search';
    search.placeholder = '제목과 설명 검색';
    search.ariaLabel = '제목과 설명 검색';
    searchLabel.appendChild(search);
    toolbar.appendChild(searchLabel);

    var projectLabel = node('label', 'mcards-project');
    projectLabel.appendChild(node('span', 'mcards-field-label', '프로젝트'));
    var project = node('select', 'mcards-project-select');
    project.ariaLabel = '프로젝트로 거르기';
    projectLabel.appendChild(project);
    toolbar.appendChild(projectLabel);

    var chips = node('div', 'mcards-chips');
    chips.role = 'group';
    chips.ariaLabel = '상태로 거르기';
    var allChip = button('mcards-chip', '전체');
    allChip.ariaPressed = 'true';
    chips.appendChild(allChip);
    var chipButtons = Object.create(null);
    STATUSES.forEach(function (status) {
      var control = button('mcards-chip', status[1]);
      control.ariaPressed = 'false';
      chipButtons[status[0]] = control;
      chips.appendChild(control);
    });
    toolbar.appendChild(chips);
    root.appendChild(toolbar);

    var tableWrap = node('div', 'mcards-table-wrap');
    var table = node('table', 'mcards-table');
    table.ariaLabel = '메멘토 카드 목록';
    table.appendChild(node('caption', 'mcards-visually-hidden', '메멘토 카드 목록'));
    var thead = node('thead', 'mcards-thead');
    var headRow = node('tr', 'mcards-head-row');
    ['제목', '상태', '프로젝트', '바뀐 날', '출처', '디스코드'].forEach(function (label) {
      var th = node('th', 'mcards-th', label);
      th.scope = 'col';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = node('tbody', 'mcards-body');
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    root.appendChild(tableWrap);

    var empty = node('div', 'mcards-empty');
    empty.hidden = true;
    var emptyText = node('p', 'mcards-empty-text', TEXT.empty);
    empty.appendChild(emptyText);
    root.appendChild(empty);
    container.appendChild(root);

    var view = {
      container: container,
      ctx: context && typeof context === 'object' ? context : {},
      root: root,
      summary: summary,
      notice: notice,
      search: search,
      project: project,
      allChip: allChip,
      chipButtons: chipButtons,
      tbody: tbody,
      tableWrap: tableWrap,
      empty: empty,
      emptyText: emptyText,
      state: null,
      status: 'all',
      projectValue: '',
      searchValue: '',
      open: Object.create(null),
      focusables: [],
      refs: Object.create(null),
      ops: Object.create(null),
      feedback: Object.create(null),
      alive: true,
      live: false,
      locked: true,
      failure: false,
      api: null
    };
    view.api = {
      update: function (state) { applyState(view, state); },
      destroy: function () { destroyView(view); }
    };
    view.live = liveOf(view.ctx);
    view.locked = !view.live;
    if (view.live) hideNotice(view);
    else showNotice(view, TEXT.readOnly, 'warn');
    bindToolbar(view);
    syncChips(view);
    updateProjects(view);
    tableWrap.hidden = true;
    empty.hidden = true;
    return view;
  }
  function destroyView(view) {
    view.alive = false;
    cancelOps(view);
    if (view.root && view.root.parentNode === view.container) view.container.removeChild(view.root);
    if (mounts.get(view.container) === view) mounts.delete(view.container);
    if (current === view) current = null;
  }
  function mount(container, context) {
    if (!container || typeof container.appendChild !== 'function') return null;
    var existing = mounts.get(container);
    if (existing) {
      if (current && current !== existing) cancelOps(current);
      existing.ctx = context && typeof context === 'object' ? context : {};
      if (existing.state) applyState(existing, existing.state);
      else {
        existing.live = liveOf(existing.ctx);
        existing.locked = !existing.live;
        if (!existing.live) cancelOps(existing);
        if (existing.live) hideNotice(existing);
        else showNotice(existing, TEXT.readOnly, 'warn');
        syncControls(existing);
      }
      current = existing;
      return existing.api;
    }
    if (current) cancelOps(current);
    var view = createView(container, context);
    mounts.set(container, view);
    current = view;
    return view.api;
  }

  g.BriefCards = {
    mount: mount,
    update: function (state) { if (current) applyState(current, state); }
  };
})(globalThis);
