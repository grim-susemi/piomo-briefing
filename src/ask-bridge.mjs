// Board-owned questions use the normal decision writer, not the built-in question bus.
import { checkStr, checkDecisionOptions } from './schema.mjs';
import { applyAskAnswer } from './decide.mjs';

const pad6 = (id) => String(id).padStart(6, '0');
const INPUT_KEYS = new Set(['question', 'options', 'recommend', 'reason', 'blocks', 'timeoutMinutes']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function holdText(id) {
  return `[결정 보류] #${id} - 소유자가 이 질문에 답하지 않기로 했어요. 다시 묻지 말고, 기본값이나 추천안으로 진행하지도 마세요. 이 결정에 막힌 일은 막힌 채로 두고 다른 일을 하세요.`;
}

function noAnswerText(status, minutes) {
  return status === 'timed_out'
    ? `The user did not answer within ${Math.round(minutes)} minutes. (사용자가 답변을 안하고 timeout 으로 종료됨)\nContinue the work to completion on your best judgment; do not ask this question again this turn.`
    : 'The user dismissed the question.';
}

export function createAskBridge(deps) {
  const { store, getSessionId, publish, onLiveChange } = deps;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const live = new Map(); // decisionId -> { controller, resolve, startedAt, ... }

  function settle(id, outcome) {
    const entry = live.get(id);
    if (!entry) return false;
    live.delete(id);
    timers.clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.controller.abort(outcome.status);
    onLiveChange?.([...live.keys()]);
    entry.resolve(outcome);
    return true;
  }

  function settleAnswer(id, answer) {
    return settle(id, { status: 'answered', answer });
  }

  function settleHold(id) {
    return settle(id, { status: 'held' });
  }

  async function execute(toolCallId, params, signal, _onUpdate, ctx) {
    const errors = [];
    if (!isObj(params)) throw new Error('board_question: 결정 객체 필요');
    for (const key of Object.keys(params)) if (!INPUT_KEYS.has(key)) errors.push(`board_question.${key}: 허용되지 않은 필드`);
    checkStr(errors, 'board_question.question', params.question, { min: 1, max: 100 });
    checkDecisionOptions(errors, 'board_question', params);
    if (Array.isArray(params.options)) errors.push('board_question.options: 선택지 객체 필요');
    for (const [key, option] of Object.entries(isObj(params.options) ? params.options : {})) {
      if (!isObj(option)) errors.push(`board_question.options.${key}: 선택지 객체 필요`);
      else for (const field of Object.keys(option)) if (!['text', 'consequence'].includes(field)) errors.push(`board_question.options.${key}.${field}: 허용되지 않은 필드`);
    }
    const minutes = params.timeoutMinutes ?? 30;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > 120) errors.push('board_question.timeoutMinutes: 0 초과 120 이하 필요');
    if (errors.length) throw new Error(errors.join('\n'));
    const sid = getSessionId();
    // Reuse part A's guard; do not emit ask-user:asked for our own dialog.
    if (store.readRecord(`mirror/${sid}.json`)?.open === true) throw new Error('질문창이 열려 있음: 결정은 답을 받은 뒤 answered로 넣기');
    const decision = {
      sessionId: sid, question: params.question,
      options: Object.fromEntries(Object.entries(params.options).map(([key, option]) => [key, { text: option.text, consequence: option.consequence }])),
      recommend: params.recommend, reason: params.reason, blocks: params.blocks,
      createdAt: now(), source: 'ask', toolCallId,
    };
    const id = store.allocDecisionId(decision);
    const controller = new AbortController();
    let resolve;
    const completion = new Promise((r) => { resolve = r; });
    const entry = { controller, resolve, startedAt: now(), signal, abort: () => settle(id, { status: 'cancelled' }), timer: null };
    live.set(id, entry);
    entry.timer = timers.setTimeout(() => settle(id, { status: 'timed_out' }), minutes * 60_000);
    signal?.addEventListener('abort', entry.abort, { once: true });

    const accept = (response) => {
      if (!live.has(id)) return;
      if (!['answered', 'comment-submitted'].includes(response?.status)) {
        settle(id, { status: response?.status === 'timed_out' ? 'timed_out' : 'cancelled' });
        return;
      }
      const answer = response.answers?.decision;
      const selected = answer?.selected ?? [];
      const label = selected.length === 1 ? selected[0] : answer?.text?.trim();
      const option = Object.keys(decision.options).find((key) => label === `${key} · ${decision.options[key].text}`);
      const text = option ? undefined : answer?.text?.trim() || response.comment?.trim();
      if (!option && !text) { settle(id, { status: 'cancelled' }); return; }
      const result = applyAskAnswer(store, { id, sessionId: sid, ...(option ? { option } : { text }) }, now(), deps.commitOptions);
      if (result.answer) {
        // A terminal winner (or a stored board winner discovered after a lost claim)
        // returns through this tool. A later watcher must not also admit it as chat.
        try {
          store.writeNew(`receipts/${pad6(id)}.json`, { id, sessionId: sid, deliveredAt: now(), kind: 'answered', mode: 'tool_result', proven: true });
        } catch (err) { if (err.code !== 'EEXIST') throw err; }
        settleAnswer(id, result.answer);
      } else if (result.code === 'HELD') {
        // The hold watcher owns its per-cycle delivery proof.
        deps.wake?.(ctx);
      } else if (result.code !== 'ANSWERED') {
        throw new Error(`board_question answer: ${result.code}${result.detail ? ` (${result.detail})` : ''}`);
      }
      // An occupied claim without a completed record is still pending. The answer /
      // hold watcher supplies the winner when that process finishes its write.
    };

    try {
      onLiveChange?.([...live.keys()]);
      if (signal?.aborted) entry.abort();
      await publish();
      if (live.has(id) && typeof ctx?.ui?.question === 'function') {
        const keys = [decision.recommend, ...Object.keys(decision.options).filter((key) => key !== decision.recommend)];
        const request = {
          requestId: toolCallId, waitForAnswer: true, timeoutMs: minutes * 60_000,
          questions: [{
            id: 'decision', header: `#${id}`, question: decision.question, multiSelect: false,
            options: keys.map((key) => ({ label: `${key} · ${decision.options[key].text}`, description: decision.options[key].consequence })),
          }],
        };
        Promise.resolve(ctx.ui.question(request, { signal: controller.signal, timeout: request.timeoutMs, deliver: 'tool-result' }))
          .then(accept).catch((err) => {
            // A UI/write error must not turn into an unhandled background rejection.
            settle(id, { status: 'error', error: err });
          });
      }
      const outcome = await completion;
      if (outcome.error) throw outcome.error;
      const answer = outcome.answer;
      const text = answer
        ? (answer.option ? `소유자 답: #${id} ${answer.option} · ${decision.options[answer.option].text}` : `소유자 답글: #${id} ${answer.text}`)
          + `\n(답한 곳: ${answer.fromSessionId === 'board' ? '상황판' : '터미널'})`
        : outcome.status === 'held' ? holdText(id) : noAnswerText(outcome.status, minutes);
      return { content: [{ type: 'text', text }], details: { id, status: outcome.status, ...(answer ? { answer } : {}) } };
    } finally {
      if (live.has(id)) settle(id, { status: 'cancelled' });
      await publish();
    }
  }

  function dispose() {
    for (const id of [...live.keys()]) settle(id, { status: 'cancelled' });
  }

  return { execute, isLive: (id) => live.has(id), settleAnswer, settleHold, dispose };
}
