// omo-briefing src/deliver.mjs - decision delivery: the conversation that owns a decision receives the answer.
//
// createDeliverer(deps) -> { wake(ctx, reason), pendingIds(), dispose() }   (hook contract: extension.mjs)
//   deps = { pi, store, stateDir, pagePath, getSessionId, getMeta, saveMeta, refresh, enabled, now, env,
//            watch?: false (test seam: skip fs.watch), fs?: node:fs-like }
//   wake reasons: session_start | input | agent_start | message_end | agent_settled | decide
//   (plus internal 'answers' for the STATE/answers watcher and the onUserActivity/retry wakes)
//
// Rules (plan todo 11 / Scope '결정 전달'):
//  - Only answers to decisions THIS session made are delivered, and only once: answers/<id>.json with no receipt.
//  - An answer is either an option (A/B/C, text = deliveryText) or the owner's own words typed on the board
//    ({ text } and no option, text = replyText). Anything else is malformed: recorded under errors['deliver:invalid:<id>'].
//    A file that does not parse yet may be a write in progress: it is re-read by the bounded timer retries (8, doubling from
//    20 ms) and only a file still unparsable after the last one counts as a finished malformed answer.
//  - Delivery = pi.session.admitExternalMessage({delivery_id:'d<id>', sender:{kind:'command_line'}, text, deliverAs:'followUp'})
//    (SENPI core/extensions/session-control-types.d.ts; external-admission.js turns it into a role:'custom',
//    customType:'session_control_delivery' message with details.delivery_id). Called only while the host is idle:
//    deliverAs is never used to splice into a running turn (a busy answer waits for that run's agent_settled).
//  - started/queued/steered/already_admitted are NOT delivery proof. They put the id into an in-memory
//    "awaiting proof" list that is mirrored in meta.pendingDeliveries (so other processes render 전달 중).
//  - A receipts/<id>.json (proven:true) is written only when pi.session.listAdmittedDeliveries().emitted has the id
//    or the session branch holds a persisted custom_message entry (customType session_control_delivery,
//    details.delivery_id === 'd<id>'). Seeing the message on an event proves nothing: wake() does not even
//    receive the event payload.
//  - failed (the session file refused the entry) -> no receipt; the id becomes a candidate again and is admitted
//    again after that run has settled.
//  - Without pi.session (older host) the fallback is pi.sendUserMessage when idle (or at agent_settled) with a
//    proven:false receipt (kind 'fallback'). The pi.session path never writes proven:false.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { setError, clearError } from './errors.mjs';
import { holdText } from './ask-bridge.mjs';
import { decisionValueErrors } from './schema.mjs';

export const DELIVERY_TYPE = 'session_control_delivery';
const pad6 = (n) => String(n).padStart(6, '0');
const NUMBERED = /^(\d+)\.json$/;
const ANNOTATION_FILE = /^a-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const deliveryId = (id) => typeof id === 'string' ? id : `d${id}`;
const OPTION_KEYS = new Set(['A', 'B', 'C']);
const RETRY_FIRST_MS = 20;
const RETRY_MAX = 8;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

const hhmm = (t) => {
  const d = new Date(Number.isFinite(t) ? t : 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** One line, no control characters, no square brackets (so text can never fake a '[결정 전달]' marker), capped. */
export function cleanInline(value, max) {
  let s = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\[/g, '(').replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = [...s];
  if (cps.length > max) s = cps.slice(0, Math.max(0, max - 1)).join('') + '…';
  return s;
}

export function deliveryText({ id, option, optionText, title, at }) {
  return `[결정 전달] #${id} -> ${option}: ${cleanInline(optionText, 80)} (보낸 대화: ${cleanInline(title, 40)}, ${hhmm(at)}). 이 결정대로 진행해.`;
}

/** A free-text board reply: the owner's own words (the agent rule treats it like a chat message), one line, no brackets. */
export function replyText({ id, text, at }) {
  return `[상황판 답글] #${id} (소유자가 상황판에서 직접 씁, ${hhmm(at)}): ${cleanInline(text, 500)}`;
}

/** The fixed first line identifies the annotation; everything after it is untrusted owner Markdown. */
export function annotationText({ requestId, text, at }) {
  return `[상황판 피드백] a-${requestId.slice(0, 8)} (소유자가 상황판에서 직접 씀, ${hhmm(at)})\n`
    + text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

export function createDeliverer(deps) {
  const { pi, store, getSessionId, getMeta, saveMeta, refresh, enabled } = deps;
  const now = deps.now ?? Date.now;
  const fsImpl = deps.fs ?? nodeFs;

  const awaiting = new Map(); // id -> { kind, mode }   admitted, proof not seen yet
  const done = new Set(); // ids known to have a receipt
  const foreign = new Set(); // ids whose decision belongs to another conversation
  const invalid = new Set(); // ids whose answer/decision is malformed (files are immutable)
  const busySeen = new Set(); // ids first noticed while the conversation was working
  const waited = new Map(); // id -> timer retries an unparsable answer file has survived
  let lastCtx = null;
  let watcher = null;
  let holdWatcher = null;
  let watchOff = false;
  let unsubActivity = null;
  let retryTimer = null;
  let retryDelay = RETRY_FIRST_MS;
  let retryCount = 0;
  let disposed = false;
  let hasHold = false;
  const admittedHolds = new Set();

  const receiptPath = (id) => join(store.root, 'receipts', `${pad6(id)}.json`);
  const safeRead = (rel) => { try { return store.readRecord(rel); } catch { return null; } };
  const messageOf = (err) => (err && err.message ? err.message : String(err));

  function safeIdle(ctx) {
    try { return typeof ctx.isIdle === 'function' ? Boolean(ctx.isIdle()) : false; } catch { return false; }
  }

  // ---- proof sources ----
  function ledger() {
    try {
      if (pi && pi.session && typeof pi.session.listAdmittedDeliveries === 'function') return pi.session.listAdmittedDeliveries();
    } catch { /* unreadable ledger = no proof from it */ }
    return null;
  }
  function branchDeliveryIds(ctx) {
    const ids = new Set();
    let branch = [];
    try { branch = ctx.sessionManager.getBranch(); } catch { return ids; }
    for (const e of Array.isArray(branch) ? branch : []) {
      if (e && e.type === 'custom_message' && e.customType === DELIVERY_TYPE && e.details && typeof e.details.delivery_id === 'string') {
        ids.add(e.details.delivery_id);
      }
    }
    return ids;
  }
  function proofView(ctx) {
    const l = ledger();
    const branchIds = branchDeliveryIds(ctx);
    const emitted = new Set(l ? l.emitted ?? [] : []);
    const pending = new Set(l ? l.pending ?? [] : []);
    const failed = new Set(l ? (l.failed ?? []).map((f) => f && f.delivery_id) : []);
    return {
      known: Boolean(l),
      proven: (did) => emitted.has(did) || branchIds.has(did),
      pending: (did) => pending.has(did),
      failed: (did) => failed.has(did),
    };
  }

  function writeReceipt(id, sid, kind, mode, proven, errors) {
    try {
      store.writeNew(`receipts/${pad6(id)}.json`, { ...(typeof id === 'string' ? { key: id } : { id }), sessionId: sid, deliveredAt: now(), kind, mode, proven });
    } catch (err) {
      if (err && err.code !== 'EEXIST') {
        errors.push(`receipt #${id}: ${messageOf(err)}`);
        return false;
      }
    }
    done.add(id);
    return true;
  }

  // Resolve awaiting items against the ledger / branch. Returns true if anything changed.
  function checkProofs(ctx, sid, errors) {
    if (awaiting.size === 0) return false;
    const view = proofView(ctx);
    let changed = false;
    for (const [id, item] of [...awaiting]) {
      const did = deliveryId(id);
      if (view.proven(did)) {
        if (writeReceipt(id, sid, item.kind, item.mode, true, errors)) { awaiting.delete(id); changed = true; }
      } else if (view.known && view.failed(did)) {
        awaiting.delete(id); // the file refused the entry: candidate again, re-admitted once the run settled
        changed = true;
      } else if (view.known && !view.pending(did)) {
        awaiting.delete(id); // the runtime no longer holds it (e.g. its queue was cleared): deliver again
        changed = true;
      }
    }
    return changed;
  }

  // ---- candidates ----
  // store.readRecord answers null for a missing file, for text that does not parse (a write in progress or a finished
  // non-JSON file) AND for a parsed scalar or null (a finished malformed record); a real read failure (EIO, EPERM on a
  // deleted volume...) throws instead, so it is told apart here and never silently dropped. 'scalar' is final at once (a
  // prefix of an answer object never parses to a scalar), 'unparsed' is final once the bounded retries are spent, and
  // everything else (missing, complete since readRecord looked) keeps waiting. A file that cannot be READ keeps waiting too,
  // but its failure is reported through this source's error slot (deliver/lastError) instead of vanishing.
  function unreadableKind(rel) {
    let text;
    try { text = store.readText(rel); } catch (err) { return { kind: 'io', err }; }
    if (text === null) return { kind: 'unreadable' }; // vanished between the folder listing and this read
    try {
      const value = JSON.parse(text);
      return { kind: value === null || typeof value !== 'object' ? 'scalar' : 'unreadable' };
    } catch { return { kind: 'unparsed' }; }
  }

  function listCandidates(sid, retrying) {
    const dir = join(store.root, 'answers');
    let names;
    try { names = fsImpl.readdirSync(dir); } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { out: [], unreadable: false, bad: [], ioErrors: [] };
      throw err;
    }
    const out = [];
    const bad = []; // ids found malformed in this scan (each reported once per process)
    const ioErrors = []; // messages for answer files that could not be READ this scan (reported by the caller)
    let unreadable = false;
    const ids = [];
    for (const name of names) {
      if (ANNOTATION_FILE.test(name)) { ids.push(name.slice(0, -5)); continue; }
      const m = NUMBERED.exec(name);
      if (!m) continue;
      const n = Number(m[1]);
      if (name !== `${pad6(n)}.json`) continue;
      ids.push(n);
    }
    ids.sort((a, b) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
    for (const n of ids) {
      if (done.has(n) || foreign.has(n) || invalid.has(n) || awaiting.has(n)) continue;
      if (fsImpl.existsSync(receiptPath(n))) { done.add(n); continue; }
      const annotation = typeof n === 'string';
      const decision = annotation ? null : safeRead(`decisions/${pad6(n)}.json`);
      if (!annotation) {
        if (!decision) continue; // missing or unreadable decision: nothing to deliver
        if (decision.sessionId !== sid) { foreign.add(n); continue; }
        if (fsImpl.existsSync(join(store.root, 'decision-closures', `${pad6(n)}.json`))) continue;
      }
      let ans = null;
      let answerReadError = null;
      try { ans = store.readRecord(`answers/${pad6(n)}.json`); } catch (err) { answerReadError = err; }
      if (answerReadError || !ans || typeof ans !== 'object') {
        const info = answerReadError ? { kind: 'io', err: answerReadError } : unreadableKind(`answers/${pad6(n)}.json`);
        if (info.kind === 'io') {
          // An unreadable answer file is not an incomplete write: say so through the delivery error channel (it is cleared
          // by the next scan that reads the file) and keep the id a candidate for the next wake.
          ioErrors.push(`#${n} 답 파일 읽기 실패: ${messageOf(info.err)}`);
          unreadable = true;
          continue;
        }
        const { kind } = info;
        if (kind === 'scalar') { invalid.add(n); bad.push(n); continue; }
        if (kind === 'unparsed') {
          if (!waited.has(n)) { retryCount = 0; retryDelay = RETRY_FIRST_MS; } // a newly seen unparsable file gets its own full round
          const age = (waited.get(n) ?? 0) + (retrying ? 1 : 0); // only timer retries age it: a flurry of wakes must not spend the budget
          if (age >= RETRY_MAX) { waited.delete(n); invalid.add(n); bad.push(n); continue; } // retries spent and still not JSON: finished
          waited.set(n, age);
        }
        unreadable = true; // maybe still being written
        continue;
      }
      if (annotation) {
        if (typeof ans.sessionId === 'string' && ans.sessionId !== sid) { foreign.add(n); continue; }
        if (ans.key !== n || ans.kind !== 'annotation' || ans.sessionId !== sid || ans.requestId !== n.slice(2)
          || ans.fromSessionId !== 'board' || ans.option !== undefined || typeof ans.text !== 'string'
          || !ans.text.trim()) {
          invalid.add(n); bad.push(n); continue;
        }
        out.push({ id: n, kind: 'annotation', text: ans.text, ans });
        continue;
      }
      if (ans.values !== undefined || decision.fields !== undefined) {
        if (ans.id !== n || ans.option !== undefined || ans.text !== undefined
          || Object.keys(decisionValueErrors(decision.fields, ans.values)).length) { invalid.add(n); bad.push(n); continue; }
        out.push({ id: n, kind: 'values', fields: decision.fields, ans });
        continue;
      }
      if (ans.text !== undefined && ans.option === undefined) {
        // the owner's own words: a non-empty string once control characters are gone
        if (ans.id !== n || typeof ans.text !== 'string' || cleanInline(ans.text, 500) === '') { invalid.add(n); bad.push(n); continue; }
        out.push({ id: n, kind: 'text', text: ans.text, ans });
        continue;
      }
      const option = typeof ans.option === 'string' ? ans.option : '';
      const opt = decision.options && typeof decision.options === 'object' ? decision.options[option] : undefined;
      if (ans.id !== n || ans.text !== undefined || !OPTION_KEYS.has(option) || !opt || typeof opt.text !== 'string') { invalid.add(n); bad.push(n); continue; }
      out.push({ id: n, kind: 'option', option, optionText: opt.text, ans });
    }
    return { out, unreadable, bad, ioErrors };
  }

  function senderTitle(from) {
    if (from === 'board') return '상황판'; // never looked up: a sessions/board record must not rename it
    if (typeof from !== 'string' || !SAFE_ID.test(from)) return '알 수 없음';
    const rec = safeRead(`sessions/${from}/meta.json`);
    if (rec && typeof rec.title === 'string' && rec.title.trim()) return rec.title;
    return from;
  }

  // Hold notices are separate from answers: they never imply a choice or survive as an
  // answer after reopen. Each hold gets its own admission id, including later hold cycles.
  function deliverHolds(ctx, sid, idle, errors) {
    const dir = join(store.root, 'hold-notices');
    let names;
    try { names = fsImpl.readdirSync(dir); } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
    let waiting = false;
    const proof = proofView(ctx);
    const notices = [];
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const rel = `hold-notices/${name}`;
      const notice = store.readRecord(rel);
      if (notice?.sessionId !== sid || notice.delivered || notice.superseded) continue;
      // Reopen sends nothing (C-HOLD 3): a notice whose hold was reopened before it was admitted is never delivered.
      // The closure is written before its notice; an unreadable one is retried on the next wake, never read as reopened.
      let closure;
      try { closure = store.readRecord(`decision-closures/${pad6(notice.id)}.json`); } catch (err) {
        waiting = true;
        errors.push(`#${notice.id} 보류: ${messageOf(err)}`);
        continue;
      }
      if (!(notice.admitted || admittedHolds.has(name)) && (closure?.reason !== 'held' || closure.notice !== name.slice(0, -5))) {
        store.replace(rel, { ...notice, superseded: true });
        continue;
      }
      const decision = safeRead(`decisions/${pad6(notice.id)}.json`);
      if (decision?.source === 'ask' && deps.askBridge?.settleHold(notice.id)) {
        store.replace(rel, { ...notice, delivered: true, proven: true, mode: 'tool_result', deliveredAt: now() });
        refresh();
        continue;
      }
      notices.push({ name, rel, notice });
    }
    // Settle every live hold before any normal hold admission consults idleness.
    for (const { name, rel, notice } of notices) {
      const delivery_id = `hold-${name.slice(0, -5)}`;
      if (proof.proven(delivery_id)) {
        store.replace(rel, { ...notice, delivered: true });
        continue;
      }
      if ((notice.admitted || admittedHolds.has(name)) && (!proof.known || proof.pending(delivery_id))) continue;
      if (!idle()) { waiting = true; continue; }
      const text = holdText(notice.id);
      try {
        let fallback = false;
        if (pi.session && typeof pi.session.admitExternalMessage === 'function') {
          const res = pi.session.admitExternalMessage({ delivery_id, sender: { kind: 'command_line' }, text, deliverAs: 'followUp' });
          if (!['started', 'queued', 'steered', 'already_admitted'].includes(res?.kind)) { waiting = true; continue; }
        } else if (typeof pi.sendUserMessage === 'function') {
          pi.sendUserMessage(text, { deliverAs: 'followUp' });
          fallback = true;
        } else throw new Error('host has neither pi.session nor pi.sendUserMessage');
        admittedHolds.add(name);
        store.replace(rel, { ...notice, admitted: true, ...(fallback ? { delivered: true } : {}) });
      } catch (err) { waiting = true; errors.push(`#${notice.id} 보류: ${messageOf(err)}`); }
    }
    return waiting;
  }

  // ---- one scan (synchronous: nothing can interleave) ----
  function run(ctx, reason) {
    if (disposed || !ctx || !enabled()) return;
    const sid = getSessionId();
    const meta = getMeta();
    if (!sid || !meta) return;
    const errors = [];
    const holds = new Map(); // id -> reason
    let changed = false;

    changed = checkProofs(ctx, sid, errors) || changed;

    const { out, unreadable, bad, ioErrors } = listCandidates(sid, reason === 'retry');
    errors.push(...ioErrors);
    const candidates = out.filter((c) => {
      if (typeof c.id !== 'number' || safeRead(`decisions/${pad6(c.id)}.json`)?.source !== 'ask'
        || !deps.askBridge?.settleAnswer(c.id, c.ans)) return true;
      if (writeReceipt(c.id, sid, 'answered', 'tool_result', true, errors)) changed = true;
      return false;
    });
    // Query idleness only on the normal admission path: a live question itself
    // keeps the turn busy, and must settle before that gate is consulted.
    const idleNow = () => reason === 'agent_settled' || safeIdle(ctx);
    const holdsWaiting = deliverHolds(ctx, sid, idleNow, errors);
    const session = pi && pi.session && typeof pi.session.admitExternalMessage === 'function' ? pi.session : null;
    let view = null;

    for (const c of candidates) {
      const did = deliveryId(c.id);
      // A previous incarnation of this conversation may have delivered it already: the entry is in the branch.
      view = view ?? proofView(ctx);
      if (view.proven(did)) {
        if (writeReceipt(c.id, sid, 'already_admitted', reason === 'session_start' ? 'on-resume' : 'immediate', true, errors)) changed = true;
        continue;
      }
      if (!idleNow()) { busySeen.add(c.id); holds.set(c.id, 'busy'); continue; }
      const mode = reason === 'session_start' ? 'on-resume' : busySeen.has(c.id) ? 'after-turn' : 'immediate';
      const text = c.kind === 'values' ? `[결정] #${c.id} 입력: ` + c.fields.map(f =>
        `${cleanInline(f.label, 40)}=${cleanInline(c.ans.values[f.id], 200)}`).join(', ')
        : c.kind === 'annotation' ? annotationText(c.ans) : c.kind === 'text'
        ? replyText({ id: c.id, text: c.text, at: c.ans.at })
        : deliveryText({ id: c.id, option: c.option, optionText: c.optionText, title: senderTitle(c.ans.fromSessionId), at: c.ans.at });
      if (session) {
        let res;
        try {
          res = session.admitExternalMessage({ delivery_id: did, sender: { kind: 'command_line' }, text, deliverAs: 'followUp' });
        } catch (err) {
          errors.push(`#${c.id}: ${messageOf(err)}`);
          continue;
        }
        const kind = res && res.kind;
        if (kind === 'started' || kind === 'queued' || kind === 'steered' || kind === 'already_admitted') {
          awaiting.set(c.id, { kind, mode }); // admitted is not delivered: wait for proof
          changed = true;
        } else if (kind === 'held_draft' || kind === 'turn_conflict') {
          holds.set(c.id, kind);
        } else {
          errors.push(`#${c.id}: unexpected admit result ${JSON.stringify(kind)}`);
        }
      } else if (pi && typeof pi.sendUserMessage === 'function') {
        try {
          pi.sendUserMessage(text, { deliverAs: 'followUp' });
        } catch (err) {
          errors.push(`#${c.id}: ${messageOf(err)}`);
          continue;
        }
        if (c.kind === 'annotation') {
          awaiting.set(c.id, { kind: 'fallback', mode }); // annotations never claim delivery without transcript proof
          changed = true;
        } else if (writeReceipt(c.id, sid, 'fallback', mode, false, errors)) changed = true; // legacy fallback
      } else {
        errors.push(`#${c.id}: host has neither pi.session nor pi.sendUserMessage`);
      }
    }

    scheduleRetry(unreadable);

    // mirror state into meta so other processes render 전달 중 / the wait reason
    let metaDirty = false;
    const ids = pendingIds();
    if (JSON.stringify(meta.pendingDeliveries ?? null) !== JSON.stringify(ids)) { meta.pendingDeliveries = ids; metaDirty = true; }
    const reasonNow = holds.size ? [...holds.values()][0] : null;
    const holdIds = [...holds.keys()];
    const prevHold = meta.deliveryHold;
    if (reasonNow) {
      if (!prevHold || prevHold.reason !== reasonNow || JSON.stringify(prevHold.ids) !== JSON.stringify(holdIds)) {
        meta.deliveryHold = { reason: reasonNow, ids: holdIds, at: now() };
        metaDirty = true;
      }
    } else if (prevHold) {
      delete meta.deliveryHold;
      metaDirty = true;
    }
    hasHold = holdsWaiting || holds.size > 0 || errors.length > 0; // a held or failed admission is retried on user activity

    // This source's own entry only: errors set -> recorded, a clean scan -> cleared. Nothing else touches it, and it is
    // saved BEFORE the one publish below so the published page matches meta.
    let errorChanged = errors.length
      ? setError(meta, 'deliver', `deliver: ${errors.join('; ')}`, now())
      : clearError(meta, 'deliver');
    // A malformed answer file is immutable, so it gets its own per-id entry (never cleared by a clean scan).
    for (const n of bad) {
      if (setError(meta, `deliver:invalid:${n}`, `deliver: #${n} 답 형식 오류(선택지 A/B/C 또는 내용이 있는 답글이 필요)`, now())) errorChanged = true;
    }
    if (metaDirty || errorChanged) saveMeta();
    if (changed || metaDirty || errorChanged) refresh();
  }

  function recordFailure(err) {
    const meta = getMeta();
    if (!meta) return;
    if (!setError(meta, 'deliver', `deliver: ${messageOf(err)}`, now())) return;
    try { saveMeta(); refresh(); } catch { /* kept in memory; refresh records its own failure */ }
  }
  function safeRun(ctx, reason) {
    try { run(ctx, reason); } catch (err) { hasHold = true; recordFailure(err); }
  }

  function scheduleRetry(unreadable) {
    if (!unreadable) { retryCount = 0; retryDelay = RETRY_FIRST_MS; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } return; }
    if (retryTimer || retryCount >= RETRY_MAX || disposed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryCount++;
      retryDelay *= 2;
      safeRun(lastCtx, 'retry');
    }, retryDelay);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  // ---- wake sources ----
  function ensureWatch() {
    if (watcher || watchOff || disposed || deps.watch === false) return;
    try {
      // Only STATE/answers is watched (plan: 'STATE/answers fs.watch(이 폴더만)'): create the folder when /decide
      // has not yet (store.writeNew creates parents, so both sides can race safely).
      const dir = join(store.root, 'answers');
      const onFail = (w) => () => { try { w.close(); } catch { /* already closed */ } if (watcher === w) { watcher = null; watchOff = true; } };
      // On Windows a watcher whose folder gets deleted keeps a pending request that stops the process from exiting:
      // close it as soon as an event shows the folder is gone (a later wake re-arms it).
      const gone = (w, path) => {
        if (fsImpl.existsSync(path)) return false;
        try { w.close(); } catch { /* already closed */ }
        if (watcher === w) watcher = null;
        return true;
      };
      fsImpl.mkdirSync(dir, { recursive: true });
      const w = fsImpl.watch(dir, { persistent: false }, () => {
        if (gone(w, dir)) return;
        safeRun(lastCtx, 'answers');
      });
      w.on('error', onFail(w));
      watcher = w;
      const holdDir = join(store.root, 'hold-notices');
      fsImpl.mkdirSync(holdDir, { recursive: true });
      holdWatcher = fsImpl.watch(holdDir, { persistent: false }, () => {
        if (!fsImpl.existsSync(holdDir)) { holdWatcher?.close(); holdWatcher = null; return; }
        safeRun(lastCtx, 'holds');
      });
      holdWatcher.on('error', recordFailure);
    } catch (err) {
      watchOff = true; // events (session_start/input/agent_settled) still wake us
      recordFailure(err);
    }
  }
  function ensureActivity(ctx) {
    if (unsubActivity || disposed || !ctx || typeof ctx.onUserActivity !== 'function') return;
    try {
      unsubActivity = ctx.onUserActivity(() => { if (hasHold) safeRun(lastCtx, 'user_activity'); });
    } catch { unsubActivity = null; }
  }

  function pendingIds() {
    return [...awaiting.keys()].sort((a, b) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
  }

  async function wake(ctx, reason) {
    if (disposed) return;
    if (ctx) lastCtx = ctx;
    ensureWatch();
    ensureActivity(ctx);
    safeRun(ctx ?? lastCtx, reason);
  }

  async function dispose() {
    if (disposed) return;
    try {
      const sid = getSessionId();
      if (lastCtx && sid && enabled()) checkProofs(lastCtx, sid, []); // an entry written just before shutdown still counts
    } catch { /* best effort */ }
    disposed = true;
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
    if (holdWatcher) { try { holdWatcher.close(); } catch { /* already closed */ } holdWatcher = null; }
    if (unsubActivity) { try { unsubActivity(); } catch { /* ignore */ } unsubActivity = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    awaiting.clear(); // whatever is unproven now is re-checked (branch) or re-admitted on the next session_start
    const meta = getMeta();
    if (meta) {
      meta.pendingDeliveries = [];
      try { saveMeta(); } catch { /* store gone */ }
    }
  }

  return { wake, pendingIds, dispose };
}
