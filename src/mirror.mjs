// omo-briefing src/mirror.mjs - read-only mirror of the host's open "ask user" questions.
//
// Path used (see docs/mirror-source.md): the public extension event bus.
//   pi.events.on('ask-user:asked',  ({ ctx, request, variant }) => ...)   one fresh registration of a question
//   pi.events.on('ask-user:closed', ({ requestId, status, resolvedBy? }) => ...)   exactly one terminal outcome
// Payload shapes: SENPI/extensions/builtin/ask-user/tool.js (startQuestion emits asked; emitAskUserClosed in
// notify.js emits closed) and SENPI/extensions/types.d.ts (QuestionRequest, QuestionResponse.status).
//
// - asked  -> STATE/mirror/<sid>.json {open:true, question, paneId, at, pid, requests[]} (display only).
// - closed with an answer (status answered / comment-submitted, or any resolvedBy) -> mirror entry removed.
// - closed without an answer (timed_out, cancelled, orphaned-after-restart, ...) -> mirror entry removed and each
//   question that has >=2 usable options becomes a decisions/<id>.json card (source 'question-timeout'):
//   first 3 options = A/B/C, recommend = first of those whose FULL label (before clipping) has 추천/Recommended else A.
//   Never auto-answered. New blocking cards go through opts.notify (the extension's Herdr-first notifier) when given.
//   A conversion whose decision write fails is NOT dropped: the closed request stays owed (`unconverted`, persisted in the
//   mirror file) and is retried on the next mirror activity (asked / closed / attach). The 'mirror' error entry stays until
//   every owed conversion succeeded; an unrelated question's successful ask does not clear it.
// - no usable pi.events (missing, no on(), on() throws) -> meta.mirrorUnavailable = true (chip) and nothing else;
//   host internals are never imported.
// Question/option text is untrusted model output: it is flattened to one line (no control or bidi characters)
// and clipped to the card limits before it is stored; it is never interpreted.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { isPidAlive } from './store.mjs';
import { setError, clearError } from './errors.mjs';

export const ASKED_EVENT = 'ask-user:asked';
export const CLOSED_EVENT = 'ask-user:closed';

const ANSWERED = new Set(['answered', 'comment-submitted']);
const RECOMMEND_RE = /추천|recommended/i;
// A bracketed marker such as "(Recommended)" / "[추천]" is shown by the recommend flag, not repeated in the option text.
const MARKER_RE = /\s*[(\[（［]\s*(?:추천|recommended)[^)\]）］]*[)\]）］]/gi;
const LETTERS = ['A', 'B', 'C'];
const SAFE_SID = /^[A-Za-z0-9._-]+$/;
const TIMEOUT_REASON = '질문 알림 시간 초과로 옮김';
const OTHER_REASON = '질문 알림이 답 없이 닫혀 옮김';
const NO_DESCRIPTION = '선택하면 이 안으로 진행';
// Card limits (schema.mjs / plan): question 100, option text 60, consequence 80, reason 100.
const CARD = { question: 100, option: 60, consequence: 80 };
// Stored (pre-card) limits: generous, so a restored entry maps exactly like a live one.
const KEEP = { question: 300, label: 200, description: 300, header: 100, qid: 40 };
const MAX_QUESTIONS = 4;
const MAX_REQUEST_ID = 200;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function clean(value, max) {
  if (typeof value !== 'string') return '';
  let s = value.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  const cps = [...s];
  if (cps.length <= max) return s;
  return cps.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…';
}

/** Raw (host or restored) request -> stored entry, or null when it carries nothing displayable. */
function normalizeRequest(req, sid, at, previous) {
  if (!isObj(req)) return null;
  const requestId = req.requestId;
  if (typeof requestId !== 'string' || requestId === '' || requestId.length > MAX_REQUEST_ID) return null;
  if (!Array.isArray(req.questions)) return null;
  const questions = [];
  for (const raw of req.questions.slice(0, MAX_QUESTIONS)) {
    if (!isObj(raw)) continue;
    const question = clean(raw.question, KEEP.question) || clean(raw.header, KEEP.question);
    if (question === '') continue;
    const options = [];
    for (const o of Array.isArray(raw.options) ? raw.options : []) {
      if (!isObj(o)) continue;
      const label = clean(o.label, KEEP.label);
      if (label === '') continue;
      // Decided on the FULL label: clipping above may cut a marker that sits after the clip point.
      const recommended = o.recommended === true || RECOMMEND_RE.test(clean(o.label, Infinity));
      const description = clean(o.description, KEEP.description);
      options.push({ label, ...(description ? { description } : {}), ...(recommended ? { recommended: true } : {}) });
      if (options.length === 3) break; // only the first three can be on a card
    }
    questions.push({ id: clean(raw.id, KEEP.qid), header: clean(raw.header, KEEP.header), question, options });
  }
  if (questions.length === 0) return null;
  return { requestId, sid, at: previous ? previous.at : at, required: req.required === true, questions };
}

/** Stored entry -> decision card inputs, one per question that has at least two options. */
function cardsOf(entry) {
  const cards = [];
  entry.questions.forEach((q, index) => {
    if (q.options.length < 2) return;
    const options = {};
    q.options.slice(0, 3).forEach((o, i) => {
      options[LETTERS[i]] = {
        text: clean(o.label.replace(MARKER_RE, ''), CARD.option) || clean(o.label, CARD.option),
        consequence: clean(o.description, CARD.consequence) || NO_DESCRIPTION,
      };
    });
    const hit = q.options.slice(0, 3).findIndex((o) => o.recommended === true);
    cards.push({ index, question: clean(q.question, CARD.question), options, recommend: LETTERS[hit >= 0 ? hit : 0] });
  });
  return cards;
}

/**
 * @param {{ pi: object, store: object, stateDir: string, getSessionId: ()=>string, getMeta: ()=>object,
 *   saveMeta: ()=>void, refresh: ()=>any, enabled: ()=>boolean, now: ()=>number, env: object, fs?: object }} o
 */
export function createMirror(o) {
  const { pi, store, stateDir, getSessionId, getMeta, saveMeta, refresh, enabled, now } = o;
  const notifyDecision = typeof o.notify === 'function' ? o.notify : null; // shared blocking-decision notifier
  const env = o.env ?? process.env;
  const fs = o.fs ?? nodeFs;
  const pending = new Map(); // requestId -> entry
  const notified = new Set();
  const unconverted = new Map(); // requestId -> { entry, status }: closed unanswered questions still owed a decision card
  let unsubs = [];
  let subscribed = false;
  let lastCtx = null;

  const mirrorRel = (sid) => `mirror/${sid}.json`;

  // Every failure here belongs to the 'mirror' source of meta.errors; only this module's own clean operation clears it.
  // `failures` lets an event handler tell whether ITS operation failed. Callers publish once after recording/clearing.
  let failures = 0;
  function recordError(where, err) {
    failures++;
    const meta = getMeta();
    if (!meta) return;
    if (!setError(meta, 'mirror', `${where}: ${err && err.message ? err.message : String(err)}`, now())) return;
    try { saveMeta(); } catch { /* the error is kept in memory; nothing more can be written */ }
  }

  /** The operation that started at `before` finished without a failure: clear this source's entry (saved here, published by the caller). */
  function settleOk(before) {
    const meta = getMeta();
    if (failures !== before || unconverted.size > 0 || !meta || !clearError(meta, 'mirror')) return false;
    try { saveMeta(); } catch (err) { recordError('mirror', err); }
    return true;
  }

  const safely = (where, fn) => {
    try { return fn(); } catch (err) { recordError(where, err); return undefined; }
  };

  function repaint() {
    try { refresh(); } catch (err) { recordError('mirror refresh', err); }
  }

  function setUnavailable(flag) {
    const meta = getMeta();
    if (!meta || (meta.mirrorUnavailable === true) === flag) return;
    if (flag) meta.mirrorUnavailable = true; else delete meta.mirrorUnavailable;
    saveMeta();
  }

  function removeFile(sid) {
    if (!SAFE_SID.test(sid)) return;
    try { fs.unlinkSync(join(stateDir, 'mirror', `${sid}.json`)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }

  /** Rewrites (or removes) the mirror file of one session from what is pending in memory. */
  function writeMirror(sid, { open = true } = {}) {
    const entries = [...pending.values()].filter((e) => e.sid === sid);
    const owed = [...unconverted.values()].filter((u) => u.entry.sid === sid);
    if (entries.length === 0 && owed.length === 0) { removeFile(sid); return; }
    const total = entries.reduce((n, e) => n + e.questions.length, 0);
    const suffix = total > 1 ? ` 외 ${total - 1}개` : '';
    const first = entries.length > 0 ? entries[0].questions[0].question : '';
    const meta = getMeta() ?? {};
    store.replace(mirrorRel(sid), {
      sessionId: sid,
      open: open && entries.length > 0, // owed conversions alone are not an open question
      question: first === '' ? '' : clean(first, 100 - [...suffix].length) + suffix,
      at: entries.length > 0 ? entries[0].at : owed[0].entry.at,
      paneId: env.HERDR_PANE_ID ?? meta.paneId ?? '',
      pid: process.pid,
      updatedAt: now(),
      requests: entries.map((e) => ({
        requestId: e.requestId, at: e.at, required: e.required,
        questions: e.questions,
      })),
      ...(owed.length > 0 ? {
        unconverted: owed.map(({ entry: e, status }) => ({ requestId: e.requestId, at: e.at, required: e.required, status, questions: e.questions })),
      } : {}),
    });
  }

  function existingCards() {
    const keys = new Set();
    const dir = join(stateDir, 'decisions');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const d = JSON.parse(fs.readFileSync(join(dir, name), 'utf8'));
        if (d && d.source === 'question-timeout' && typeof d.requestId === 'string') keys.add(`${d.sessionId}|${d.requestId}|${d.questionIndex}`);
      } catch { /* unreadable card: the reader shows it as a read failure, not our concern here */ }
    }
    return keys;
  }

  /** Writes the missing decision cards of one closed request. ok=false when any could not be written (retry later). */
  function convert(entry, status) {
    const reason = status === 'timed_out' ? TIMEOUT_REASON : OTHER_REASON;
    const created = [];
    let ok = true;
    let have;
    try { have = existingCards(); } catch (err) { recordError('mirror decision', err); return { created, ok: false }; }
    for (const card of cardsOf(entry)) {
      if (have.has(`${entry.sid}|${entry.requestId}|${card.index}`)) continue;
      try {
        const id = store.allocDecisionId({
          sessionId: entry.sid,
          question: card.question,
          options: card.options,
          recommend: card.recommend,
          reason,
          blocks: entry.required === true,
          createdAt: now(),
          source: 'question-timeout',
          requestId: entry.requestId,
          questionIndex: card.index,
        });
        created.push({ id, question: card.question, recommend: card.recommend, blocks: entry.required === true });
      } catch (err) { ok = false; recordError('mirror decision', err); }
    }
    return { created, ok };
  }

  /** Converts every owed closed request; the ones that succeed leave the owed list. */
  function retryOwed() {
    if (unconverted.size === 0 || !enabled()) return;
    for (const [id, { entry, status }] of [...unconverted]) {
      const { created, ok } = convert(entry, status);
      notifyBlocking(created);
      if (ok) unconverted.delete(id);
    }
  }

  function notifyBlocking(created) {
    const ui = lastCtx && lastCtx.ui;
    const meta = getMeta() ?? {};
    for (const d of created) {
      if (!d.blocks || notified.has(d.id)) continue;
      if (notifyDecision) { // Herdr-first, with its own ctx.ui.notify fallback
        notified.add(d.id);
        try { notifyDecision(lastCtx, d); } catch { /* notification is best effort */ }
        continue;
      }
      if (!ui || typeof ui.notify !== 'function') continue;
      notified.add(d.id);
      try { ui.notify(`결정 #${d.id} 필요: ${d.question} (상황판 - ${meta.project || ''} /decide ${d.id}${d.recommend})`, 'warning'); } catch { /* notification is best effort */ }
    }
  }

  function onAsked(payload) {
    const before = failures;
    try {
      if (!enabled() || !isObj(payload)) return;
      const sid = getSessionId();
      const named = payload.ctx && payload.ctx.sessionManager && typeof payload.ctx.sessionManager.getSessionId === 'function'
        ? payload.ctx.sessionManager.getSessionId() : sid;
      if (named !== sid) return; // another session's question
      retryOwed();
      const entry = normalizeRequest(payload.request, sid, now(), pending.get(isObj(payload.request) ? payload.request.requestId : undefined));
      if (!entry) return;
      pending.set(entry.requestId, entry);
      writeMirror(sid);
      settleOk(before);
      repaint();
    } catch (err) { recordError('mirror asked', err); repaint(); }
  }

  function onClosed(payload) {
    const before = failures;
    try {
      if (!isObj(payload) || typeof payload.requestId !== 'string') return;
      const entry = pending.get(payload.requestId);
      if (!entry) return; // never seen, already closed, or not ours
      pending.delete(payload.requestId);
      const answered = ANSWERED.has(payload.status) || payload.resolvedBy !== undefined;
      if (!answered && enabled()) unconverted.set(entry.requestId, { entry, status: payload.status });
      retryOwed();
      safely('mirror close', () => writeMirror(entry.sid));
      settleOk(before);
      repaint();
    } catch (err) { recordError('mirror closed', err); repaint(); }
  }

  function subscribe() {
    if (subscribed) { setUnavailable(false); return; }
    const added = [];
    try {
      const bus = pi && pi.events;
      if (!bus || typeof bus.on !== 'function') throw new Error('pi.events is not available');
      const keep = (u) => added.push(typeof u === 'function' ? u : () => {});
      keep(bus.on(ASKED_EVENT, onAsked));
      keep(bus.on(CLOSED_EVENT, onClosed));
      unsubs = added;
      subscribed = true;
      setUnavailable(false);
    } catch {
      for (const u of added) { try { u(); } catch { /* already gone */ } }
      setUnavailable(true);
    }
  }

  /** A mirror file from before this attach: same-process reload keeps its questions, a dead process's is stale. */
  function restoreOrClear(sid) {
    if (!SAFE_SID.test(sid) || [...pending.values()].some((e) => e.sid === sid) || [...unconverted.values()].some((u) => u.entry.sid === sid)) return;
    const rec = store.readRecord(mirrorRel(sid));
    if (!rec) return;
    if (rec.pid === process.pid && Array.isArray(rec.requests) && enabled()) {
      for (const r of rec.requests) {
        const entry = normalizeRequest(r, sid, typeof r.at === 'number' ? r.at : now());
        if (entry) pending.set(entry.requestId, entry);
      }
      adoptOwed(rec, sid);
      writeMirror(sid);
      return;
    }
    if (Number.isInteger(rec.pid) && rec.pid !== process.pid && isPidAlive(rec.pid)) return; // someone else's live file
    // A dead process's open questions are stale, but the conversions it still owed are not.
    if (enabled() && adoptOwed(rec, sid)) { writeMirror(sid); return; }
    removeFile(sid);
  }

  /** Takes the owed conversions of a stored mirror file; returns whether there were any. */
  function adoptOwed(rec, sid) {
    let n = 0;
    for (const r of Array.isArray(rec.unconverted) ? rec.unconverted : []) {
      const entry = isObj(r) ? normalizeRequest(r, sid, typeof r.at === 'number' ? r.at : now()) : null;
      if (!entry) continue;
      unconverted.set(entry.requestId, { entry, status: typeof r.status === 'string' ? r.status : 'timed_out' });
      n++;
    }
    return n > 0;
  }

  async function attach(ctx) {
    lastCtx = ctx ?? lastCtx;
    subscribe();
    const before = failures;
    safely('mirror restore', () => restoreOrClear(getSessionId()));
    const owed = unconverted.size > 0;
    if (owed) { // conversions owed from before this attach: retry now, clear the error only when all succeeded
      retryOwed();
      safely('mirror restore', () => writeMirror(getSessionId()));
      settleOk(before);
    }
    if (failures !== before || owed) repaint();
  }

  async function dispose() {
    for (const u of unsubs) { try { u(); } catch { /* already gone */ } }
    unsubs = [];
    subscribed = false;
    const before = failures;
    const sids = new Set([...[...pending.values()].map((e) => e.sid), ...[...unconverted.values()].map((u) => u.entry.sid)]);
    // A closed session must not keep showing an open question; the entries stay in the file so a reload can restore them.
    if (fs.existsSync(stateDir)) for (const sid of sids) safely('mirror dispose', () => writeMirror(sid, { open: false }));
    pending.clear();
    unconverted.clear();
    // The page must show the closed state (and any error recorded above): one publication, no later event will do it.
    // While paused (/brief off) nothing is published automatically; a recorded error stays in meta for the next enabled publish.
    if ((sids.size > 0 || failures !== before) && enabled()) repaint();
  }

  return { attach, dispose };
}
