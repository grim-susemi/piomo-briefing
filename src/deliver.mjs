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

export const DELIVERY_TYPE = 'session_control_delivery';
const pad6 = (n) => String(n).padStart(6, '0');
const NUMBERED = /^(\d+)\.json$/;
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

export function createDeliverer(deps) {
  const { pi, store, getSessionId, getMeta, saveMeta, refresh, enabled } = deps;
  const now = deps.now ?? Date.now;
  const fsImpl = deps.fs ?? nodeFs;

  const awaiting = new Map(); // id -> { kind, mode }   admitted, proof not seen yet
  const done = new Set(); // ids known to have a receipt
  const foreign = new Set(); // ids whose decision belongs to another conversation
  const invalid = new Set(); // ids whose answer/decision is malformed (files are immutable)
  const busySeen = new Set(); // ids first noticed while the conversation was working
  let lastCtx = null;
  let watcher = null;
  let watchOff = false;
  let unsubActivity = null;
  let retryTimer = null;
  let retryDelay = RETRY_FIRST_MS;
  let retryCount = 0;
  let disposed = false;
  let hasHold = false;

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
      store.writeNew(`receipts/${pad6(id)}.json`, { id, sessionId: sid, deliveredAt: now(), kind, mode, proven });
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
      const did = `d${id}`;
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
  function listCandidates(sid) {
    const dir = join(store.root, 'answers');
    let names;
    try { names = fsImpl.readdirSync(dir); } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { out: [], unreadable: false };
      throw err;
    }
    const out = [];
    let unreadable = false;
    const ids = [];
    for (const name of names) {
      const m = NUMBERED.exec(name);
      if (!m) continue;
      const n = Number(m[1]);
      if (name !== `${pad6(n)}.json`) continue;
      ids.push(n);
    }
    ids.sort((a, b) => a - b);
    for (const n of ids) {
      if (done.has(n) || foreign.has(n) || invalid.has(n) || awaiting.has(n)) continue;
      if (fsImpl.existsSync(receiptPath(n))) { done.add(n); continue; }
      const decision = safeRead(`decisions/${pad6(n)}.json`);
      if (!decision) continue; // missing or unreadable decision: nothing to deliver
      if (decision.sessionId !== sid) { foreign.add(n); continue; }
      if (fsImpl.existsSync(join(store.root, 'decision-closures', `${pad6(n)}.json`))) continue;
      const ans = safeRead(`answers/${pad6(n)}.json`);
      if (!ans || typeof ans !== 'object') { unreadable = true; continue; } // maybe still being written
      const option = typeof ans.option === 'string' ? ans.option : '';
      const opt = decision.options && typeof decision.options === 'object' ? decision.options[option] : undefined;
      if (ans.id !== n || !OPTION_KEYS.has(option) || !opt || typeof opt.text !== 'string') { invalid.add(n); continue; }
      out.push({ id: n, option, optionText: opt.text, ans });
    }
    return { out, unreadable };
  }

  function senderTitle(from) {
    if (typeof from !== 'string' || !SAFE_ID.test(from)) return '알 수 없음';
    const rec = safeRead(`sessions/${from}/meta.json`);
    if (rec && typeof rec.title === 'string' && rec.title.trim()) return rec.title;
    return from;
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

    const { out: candidates, unreadable } = listCandidates(sid);
    const idleNow = reason === 'agent_settled' || safeIdle(ctx);
    const session = pi && pi.session && typeof pi.session.admitExternalMessage === 'function' ? pi.session : null;
    let view = null;

    for (const c of candidates) {
      const did = `d${c.id}`;
      // A previous incarnation of this conversation may have delivered it already: the entry is in the branch.
      view = view ?? proofView(ctx);
      if (view.proven(did)) {
        if (writeReceipt(c.id, sid, 'already_admitted', reason === 'session_start' ? 'on-resume' : 'immediate', true, errors)) changed = true;
        continue;
      }
      if (!idleNow) { busySeen.add(c.id); holds.set(c.id, 'busy'); continue; }
      const mode = reason === 'session_start' ? 'on-resume' : busySeen.has(c.id) ? 'after-turn' : 'immediate';
      const text = deliveryText({ id: c.id, option: c.option, optionText: c.optionText, title: senderTitle(c.ans.fromSessionId), at: c.ans.at });
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
        if (writeReceipt(c.id, sid, 'fallback', mode, false, errors)) changed = true; // cannot be proven on this host
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
    hasHold = holds.size > 0 || errors.length > 0; // a held or failed admission is retried on user activity

    // This source's own entry only: errors set -> recorded, a clean scan -> cleared. Nothing else touches it, and it is
    // saved BEFORE the one publish below so the published page matches meta.
    const errorChanged = errors.length
      ? setError(meta, 'deliver', `deliver: ${errors.join('; ')}`, now())
      : clearError(meta, 'deliver');
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
      safeRun(lastCtx, 'answers');
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
    return [...awaiting.keys()].sort((a, b) => a - b);
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
