// omo-briefing src/render.mjs - store snapshot -> view model -> index.html + data.js.
//
// - buildViewModel(snapshot, now, opts?): pure-ish (re-hashes evidence files, probes pids).
//   Output shape = test/fixtures/view-model.json (the contract src/page/view.js reads) plus, since generation 4:
//   vm.gen, vm.waiting (src/waiting.mjs), vm.server ({url, generation} | null), sessions[].plan / .planLink / .live.
//   The JSON is capped at 600KB: live/plan details of finished conversations go first, marked by a chip.
// - renderPage(store, now?, opts?): publish under render.lock (wx; dead-pid lock reclaimed with
//   store.reclaimStale, live lock never removed), seq = published.json seq + 1, replace-writes
//   data.js, index.html, published.json, releases the lock and publishes once more if the store
//   changed meanwhile. If the lock cannot be taken the publish is skipped and meta.lastError set.
//   It waits for a contended lock with a synchronous sleep: only the installer and old tests use it.
// - renderPageAsync(store, now?, opts?): the same publish, but the wait for a contended lock is an awaited timer, so the
//   caller's event loop keeps running. Same lock rules, same retry budget (20ms, doubling, 8 retries, ~5.1s).
//   opts.soft: take the lock ONE time, never wait; a busy lock comes back as {ok:false, busy:true} with nothing recorded
//   (the caller retries later and reports a `render` error only after it kept failing).
//
// Brief records (sessions/<sid>/briefs/<seq>.json) are {at, brief:{...validated input}}; a record
// without `brief` is read as the brief itself.
import * as nodeFs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isPidAlive, TOO_BIG_CODE } from './store.mjs';
import { setError, hasErrors } from './errors.mjs';
import { cardStatus, chips as truthChips, tabOf, recheckEvidence } from './truth.mjs';
import { waitingItems } from './waiting.mjs';
import { rootAndSlugOf } from './plan-schema.mjs';

const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'page');
const DAY_MS = 24 * 3600 * 1000;
const RECENT_MS = 30 * DAY_MS;
const LARGE = 10 * 1024 * 1024;
const LOCK = 'render.lock';
const FIRST_DELAY_MS = 20;
const MAX_RETRIES = 8;
export const MAX_VM_BYTES = 600 * 1024;
const PAUSED = Symbol('paused'); // thrown inside the publish when opts.canPublish() turned false: nothing was written
const PAUSED_ERROR = '브리핑이 꺼져 있어 게시하지 않았습니다';
export const OMITTED_CHIP = '용량 때문에 일부 생략';
// render.lock files this process created but could not verify/remove at release (nonce by lock path): a live pid is never
// reclaimed by the stale rule, so the owner itself removes a nonce-verified leftover of its own.
const stranded = new Map();
// Installed generation of this code (AGENT/briefing/integration/generation-NNNNNN/...), or null when run from a checkout.
// It is stamped into index.html; a publisher never replaces the page template written by a NEWER generation.
const GENERATION_RE = /[\\/]generation-(\d{6})[\\/]/;
export const OWN_GENERATION = (() => {
  const m = GENERATION_RE.exec(fileURLToPath(import.meta.url));
  return m ? Number(m[1]) : null;
})();
const STAMP_RE = /<meta name="omo-briefing-generation" content="(\d+)">/;
const CONTENTION = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
const STATUSES = new Set(['in_progress', 'blocked', 'needs_decision', 'done']);
const TABS = ['나를 기다림', '진행 중', '끝남'];
const LEDGER_ACTIVE = new Set(['dispatch', 'verify-failed', 'task-reopened', 'worker-wedged', 'worker-error', 'partial']);
const PRE_RUN_STAGES = new Set(['shaping', 'gate', 'review', 'ready']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const pad2 = (n) => String(n).padStart(2, '0');
const clipCp = (s, n) => [...str(s)].slice(0, n).join('');
const bareSid = (id) => str(id).replace(/^senpi:/, '');

function hhmm(ms) {
  if (!isNum(ms)) return '--:--';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sleepAsync = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function projectOf(cwd) {
  return str(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '(폴더 모름)';
}

function unwrapBrief(rec) {
  if (!isObj(rec)) return { at: null, brief: {} };
  const brief = isObj(rec.brief) ? rec.brief : rec;
  return { at: isNum(rec.at) ? rec.at : null, brief };
}

function evidenceChecker(fs) {
  const cache = new Map();
  return function check(item) {
    if (!isObj(item)) return null;
    const out = {
      text: str(item.text),
      truth: str(item.truth) || 'unverified',
      applied: str(item.applied) || 'candidate',
    };
    if (str(item.evidence)) out.evidence = item.evidence;
    if (item.evidence_missing) out.flag = 'evidence_missing';
    if (out.truth !== 'evidence' || !out.evidence) { out.evidenceState = 'ok'; return out; }
    const path = out.evidence;
    if (!cache.has(path)) {
      let stat = null;
      let hash = null;
      try { stat = fs.statSync(path); } catch { stat = null; }
      if (stat && stat.size <= LARGE) {
        try { hash = createHash('sha256').update(fs.readFileSync(path)).digest('hex'); } catch { hash = undefined; }
      }
      cache.set(path, { stat, hash });
    }
    const { stat, hash } = cache.get(path);
    const r = recheckEvidence(
      { ...item, evidenceHash: item.evidenceHash ?? item.evidenceSha256 ?? null },
      {
        stat,
        sha256: () => { if (hash === undefined) throw new Error('unreadable'); return hash; },
      },
    );
    out.evidenceState = r.evidenceState;
    if (r.flag) out.flag = r.flag;
    return out;
  };
}

function autoInfo(auto) {
  if (!isObj(auto)) return undefined;
  const work = isObj(auto.work) ? auto.work : {};
  const todo = isObj(auto.todo) ? auto.todo : {};
  const w = isObj(auto.workers) ? auto.workers : {};
  const n = (v) => (isNum(v) ? v : null);
  return {
    stage: str(work.phase),
    todoCurrent: str(todo.current) || str(work.current),
    todoNext: str(todo.next),
    todoDone: n(todo.done) ?? n(work.done),
    todoTotal: n(todo.total) ?? n(work.total),
    workers: { running: n(w.running) ?? 0, done: n(w.completed) ?? n(w.done) ?? 0, error: n(w.error) ?? 0 },
  };
}

// meta.auto.live = {workers:[...]} (src/workers-live.mjs rows); the page draws it as the worker lines of the card.
function liveInfo(auto) {
  const live = isObj(auto) ? auto.live : null;
  const workers = isObj(live) ? arr(live.workers).filter(isObj) : [];
  return workers.length > 0 ? { workers } : undefined;
}

// ---- plan view model (summary revision + read-only status overlay -> what plan-view.js draws) ----

function planTaskState(id, status) {
  const boxes = isObj(status) ? status.boxes : null;
  if (has(boxes, id)) {
    if (boxes[id] === 'x') return 'done';
    if (boxes[id] === '~') return 'stopped';
  }
  const ledger = isObj(status) ? status.ledger : null;
  const last = has(ledger, id) && isObj(ledger[id]) ? ledger[id].last : undefined;
  return LEDGER_ACTIVE.has(last) ? 'doing' : 'todo';
}

// A boulder work running the plan decides the stage shown; otherwise the stage the agent reported.
function stageOf(reported, status) {
  const work = isObj(status) && isObj(status.work) ? str(status.work.status).toLowerCase() : '';
  if (!work) return reported;
  if (/abandon|cancel/.test(work)) return 'dropped';
  if (/complete|done|finish/.test(work)) return 'done';
  return PRE_RUN_STAGES.has(reported) ? 'running' : reported;
}

function planChipsOf(ownerMeta, planId) {
  const pc = isObj(ownerMeta) && isObj(ownerMeta.planChips) && has(ownerMeta.planChips, planId) ? ownerMeta.planChips[planId] : null;
  return { chips: arr(pc && pc.chips).filter((c) => typeof c === 'string'), checkedAt: pc && isNum(pc.checkedAt) ? pc.checkedAt : null };
}

function planModel(p, ownerMeta, decisionsOf, answers, closures) {
  const rev = p.rev;
  const status = isObj(p.status) ? p.status : null;
  const plan = isObj(rev.plan) ? rev.plan : {};
  const tasks = arr(plan.tasks).filter(isObj).map((t) => ({ ...t, state: planTaskState(str(t.id), status) }));
  const questions = arr(plan.questions).filter(isObj).map((q) => {
    const out = { ...q };
    // the stored answer / the decision created for this question win over what the agent claims (open OR answered)
    const mine = decisionsOf(p.planId, str(q.id));
    const live = mine.slice().reverse().find((d) => !closures.has(d.id));
    if (live) {
      const ans = answers.get(live.id);
      if (ans) {
        const opt = str(ans.option);
        const text = isObj(live.options) && isObj(live.options[opt]) ? str(live.options[opt].text) : '';
        out.state = 'answered';
        out.by = 'owner';
        out.option = opt;
        out.answer = clipCp(text ? `${opt} ${text}` : opt, 60);
      } else if (q.state === 'open') {
        out.decisionId = live.id;
      }
    }
    return out;
  });
  const { chips, checkedAt } = planChipsOf(ownerMeta, p.planId);
  return {
    ...plan,
    tasks,
    questions,
    stage: stageOf(plan.stage, status),
    planId: p.planId,
    rev: rev.rev,
    at: rev.at,
    checkedAt: checkedAt ?? (status && isNum(status.at) ? status.at : null),
    source: isObj(rev.source) ? rev.source : {},
    ownerSessionId: str(rev.ownerSessionId),
    chips,
  };
}

// No summary yet but the plan file's own structure lines are known (status.skeleton): a labelled skeleton, never a summary.
function skeletonPlan(planId, files, status, ownerMeta) {
  const f = isObj(files) ? files : {};
  const path = str(f.planPath) || str(f.draftPath);
  const rs = path ? rootAndSlugOf(path) : null;
  const rows = arr(status.skeleton && status.skeleton.tasks).filter((t) => isObj(t) && str(t.id) !== '');
  const waveOf = (t) => (Number.isInteger(t.wave) && t.wave >= 1 ? t.wave : 1);
  const waves = [...new Set(rows.map(waveOf))].sort((a, b) => a - b);
  const { chips, checkedAt } = planChipsOf(ownerMeta, planId);
  return {
    planId,
    rev: 0,
    at: isNum(status.at) ? status.at : null,
    checkedAt: checkedAt ?? (isNum(status.at) ? status.at : null),
    source: { root: rs ? rs.root : '', slug: rs ? rs.slug : planId, ...(f.planPath ? { planPath: f.planPath } : {}), ...(f.draftPath ? { draftPath: f.draftPath } : {}) },
    ownerSessionId: '',
    stage: stageOf('shaping', status),
    goal: rs ? rs.slug : planId,
    ideal: [],
    components: [],
    waves: waves.map((n) => ({ n, label: `${n}단계` })),
    tasks: rows.map((t) => ({
      id: str(t.id),
      wave: waveOf(t),
      label: clipCp(t.title, 14) || str(t.id),
      what: clipCp(t.title, 50) || str(t.id),
      done: '(요약 없음)',
      deps: arr(t.deps).map(str).filter(Boolean),
      state: planTaskState(str(t.id), status),
    })),
    questions: [],
    outOfScope: [],
    chips: [...chips, '자동 추출(요약 없음)'],
  };
}

// Keeps the written bytes under MAX_VM_BYTES: finished conversations lose their live/plan details first, oldest first.
// Measured on the escaped data.js text (every '<' is six bytes there), which is never smaller than /data.json.
function capSize(vm) {
  const exact = () => Buffer.byteLength(dataJsText(vm));
  let size = exact();
  if (size <= MAX_VM_BYTES) return;
  const order = vm.sessions
    .filter((s) => s.live !== undefined || s.plan !== undefined)
    .sort((a, b) => ((a.tab === '끝남' ? 0 : 1) - (b.tab === '끝남' ? 0 : 1)) || (a.lastActivityAt - b.lastActivityAt));
  for (const s of order) {
    if (size <= MAX_VM_BYTES) break;
    size -= Buffer.byteLength(scriptJson({ live: s.live, plan: s.plan }));
    delete s.live;
    delete s.plan;
    if (!s.chips.includes(OMITTED_CHIP)) {
      s.chips.push(OMITTED_CHIP);
      size += Buffer.byteLength(scriptJson(OMITTED_CHIP)) + 1;
    }
    if (size <= MAX_VM_BYTES) size = exact(); // the running estimate ignores key overhead: confirm on the real text
  }
}

/**
 * {server: {url, generation} | null, error: boolean}: the live board address from STATE/server.json (no network).
 * A record whose owner pid is dead is not an address. An unreadable file is reported (error), never read as 'no server'.
 */
// The record the board host writes is ~150 bytes. The limit is the installer's (4096 characters of up to 4 bytes): a bigger
// server.json is refused before any of it is read.
export const SERVER_RECORD_MAX_BYTES = 4096 * 4;
export function serverInfoOf(store, isAlive = isPidAlive) {
  let rec;
  try {
    rec = store.readRecord('server.json', { maxBytes: SERVER_RECORD_MAX_BYTES });
  } catch (err) {
    // the caller lists 'server.json' in vm.readErrors and may record `message` as an error of its own
    const why = err && err.code === TOO_BIG_CODE
      ? `너무 큼(${err.bytes}바이트 > 한도 ${err.limit}바이트) - 읽지 않음`
      : `읽지 못함(${(err && err.code) || (err && err.message) || err})`;
    return { server: null, error: true, message: `server.json ${why}` };
  }
  if (!isObj(rec) || !Number.isInteger(rec.port) || !isAlive(rec.pid)) return { server: null, error: false };
  return { server: { url: `http://127.0.0.1:${rec.port}/`, generation: Number.isInteger(rec.generation) ? rec.generation : null }, error: false };
}

/**
 * @param {object} snapshot store.readSnapshot()
 * @param {number} now ms
 * @param {{isAlive?: (pid:number)=>boolean, fs?: object, pendingDeliveries?: Iterable<number>, generation?: number|null,
 *   server?: {url:string, generation:number|null}|null, serverError?: boolean}} [opts]
 */
export function buildViewModel(snapshot, now = Date.now(), opts = {}) {
  const isAlive = opts.isAlive ?? isPidAlive;
  const check = evidenceChecker(opts.fs ?? nodeFs);
  const snap = isObj(snapshot) ? snapshot : {};
  const readErrors = arr(snap.readErrors);
  const errSids = new Set();
  // decision id -> owning session, from any readable source: the decision itself, a receipt's sessionId,
  // or the decisions[] of a stored brief (so a corrupt decisions/N.json is still attributable).
  const ownerOf = new Map();
  const own = (id, sid) => { if (Number.isInteger(id) && typeof sid === 'string' && !ownerOf.has(id)) ownerOf.set(id, sid); };
  for (const d of arr(snap.decisions)) if (isObj(d)) own(d.id, d.sessionId);
  for (const r of arr(snap.receipts)) if (isObj(r)) own(r.id, r.sessionId);
  for (const s of arr(snap.sessions)) {
    if (!isObj(s) || typeof s.sid !== 'string') continue;
    for (const b of arr(s.briefs)) for (const d of arr(unwrapBrief(b && b.data).brief.decisions)) if (isObj(d)) own(d.id, s.sid);
  }
  // Read errors whose owner cannot be determined stay only in the model's readErrors: the plan defines
  // the '기록 읽기 실패' warning per card and no page-level indicator.
  for (const e of readErrors) {
    const rel = str(e && e.rel);
    const m = /^sessions\/([^/]+)\//.exec(rel) || /^mirror\/([^/]+)\.json$/.exec(rel);
    if (m) { errSids.add(m[1]); continue; }
    const f = /^(?:decisions|answers|receipts|decision-closures|claims)\/0*(\d+)\.json$/.exec(rel);
    if (f && ownerOf.has(Number(f[1]))) errSids.add(ownerOf.get(Number(f[1])));
  }
  const pending = new Set(opts.pendingDeliveries ? [...opts.pendingDeliveries] : []); // admitted, receipt not yet written (in-memory list of the delivering session)
  const byIdMap = (list) => {
    const map = new Map();
    for (const r of arr(list)) if (isObj(r) && Number.isInteger(r.id)) map.set(r.id, r);
    return map;
  };
  const answers = byIdMap(snap.answers);
  const receipts = byIdMap(snap.receipts);
  const closures = byIdMap(snap.closures);
  const mirrors = new Map(arr(snap.mirror).filter((m) => isObj(m) && isObj(m.data)).map((m) => [m.sid, m.data]));
  const decisionsBySid = new Map();
  const planDecisions = new Map(); // `${planId}|${qid}` -> decisions of that plan question, ascending id
  for (const d of arr(snap.decisions)) {
    if (!isObj(d) || !Number.isInteger(d.id) || typeof d.sessionId !== 'string') continue;
    if (!decisionsBySid.has(d.sessionId)) decisionsBySid.set(d.sessionId, []);
    decisionsBySid.get(d.sessionId).push(d);
    if (d.source === 'plan' && str(d.planId) && str(d.qid)) {
      const k = `${d.planId}|${d.qid}`;
      if (!planDecisions.has(k)) planDecisions.set(k, []);
      planDecisions.get(k).push(d);
    }
  }
  const decisionsOfQuestion = (planId, qid) => (planDecisions.get(`${planId}|${qid}`) ?? []).slice().sort((a, b) => a.id - b.id);
  const plansById = new Map();
  for (const p of arr(snap.plans)) if (isObj(p) && typeof p.planId === 'string') plansById.set(p.planId, p);
  const metaBySid = new Map(arr(snap.sessions).filter((e) => isObj(e) && typeof e.sid === 'string').map((e) => [e.sid, isObj(e.meta) ? e.meta : {}]));
  const modelOf = new Map();
  const planModelOf = (p) => {
    if (!modelOf.has(p.planId)) modelOf.set(p.planId, planModel(p, metaBySid.get(str(p.rev.ownerSessionId)), decisionsOfQuestion, answers, closures));
    return modelOf.get(p.planId);
  };

  const sessions = [];
  for (const entry of arr(snap.sessions)) {
    if (!isObj(entry) || typeof entry.sid !== 'string') continue;
    const sid = entry.sid;
    const meta = isObj(entry.meta) ? entry.meta : {};
    const briefs = arr(entry.briefs).map((b) => ({ seq: b && b.seq, ...unwrapBrief(b && b.data) }));
    const latest = briefs.at(-1) ?? { at: null, brief: {} };
    const brief = latest.brief;

    const times = [meta.lastActivityAt, meta.lastBriefAt, meta.lastOwnerInputAt, ...briefs.map((b) => b.at)].filter(isNum);
    if (!times.length) continue;
    const last = Math.max(...times);
    if (now - last > RECENT_MS) continue;

    const running = meta.running === true;
    const runningAlive = running && isAlive(meta.pid);
    const admitted = new Set([...pending, ...arr(meta.pendingDeliveries)]);

    const inputAt = isNum(meta.lastOwnerInputAt) ? meta.lastOwnerInputAt : null;
    const newer = inputAt === null ? [] : briefs.filter((b) => isNum(b.at) && b.at > inputAt);
    const changesNew = newer.length > 0;
    const rawChanges = changesNew
      ? newer.slice().reverse().flatMap((b) => arr(b.brief.changes))
      : arr(brief.changes);
    const changes = rawChanges.map(check).filter(Boolean);
    const done = arr(brief.done).map(check).filter(Boolean);

    const decisions = (decisionsBySid.get(sid) ?? []).slice().sort((a, b) => a.id - b.id).map((d) => {
      const ans = answers.get(d.id);
      const rc = receipts.get(d.id);
      const out = {
        id: d.id,
        sessionId: sid,
        question: str(d.question),
        options: isObj(d.options) ? d.options : {},
        recommend: str(d.recommend),
        reason: str(d.reason),
        blocks: d.blocks === true,
        createdAt: isNum(d.createdAt) ? d.createdAt : null,
        source: str(d.source) || 'brief',
        answered: Boolean(ans),
        closed: closures.has(d.id),
        answer: ans ? { option: str(ans.option), at: isNum(ans.at) ? ans.at : null } : null,
        receipt: rc && rc.proven !== false ? { kind: str(rc.kind), mode: str(rc.mode), deliveredAt: isNum(rc.deliveredAt) ? rc.deliveredAt : null, proven: true } : null, // unproven (admitted, not yet confirmed) is not shown as a delivery proof
      };
      if (ans) {
        // 전달됨 only for a real receipt; 전달 중 = admitted, not yet confirmed (pending list, or the
        // proven:false receipt of the no-pi.session fallback); otherwise waiting.
        out.delivery = rc && rc.proven !== false ? `전달됨 ⏱${hhmm(rc.deliveredAt)}`
          : (rc || admitted.has(d.id)) ? '전달 중'
          : (runningAlive ? '대기: 작업이 끝나면 전달' : '대기: 그 대화가 다시 열리면 전달');
      }
      return out;
    });

    const mirror = mirrors.get(sid);
    const qText = mirror && mirror.open !== false ? str(mirror.question) || str(mirror.text) : '';
    const openQuestion = qText
      ? { text: qText, at: isNum(mirror.at) ? mirror.at : null, paneId: str(mirror.paneId) || null }
      : undefined;

    const status = STATUSES.has(brief.status) ? brief.status : 'in_progress';
    const truthView = { status, decisions, changes, done, lastActivityAt: last };
    const autoSummaryText = typeof meta.autoSummary === 'string' ? meta.autoSummary
      : arr(meta.autoSummary).filter((l) => typeof l === 'string').join('\n');
    const chipList = truthChips({
      ...truthView,
      meta: {
        noReport: meta.noReport === true,
        readError: errSids.has(sid),
        mirrorUnavailable: meta.mirrorUnavailable === true || (isObj(mirror) && mirror.unavailable === true),
      },
    }, now);
    // any per-source error in meta.errors (decide, mirror, deliver, settings, render, ...) -> chip; the detail stays out of the page.
    // A record without meta.errors (older format) falls back to its lastError.
    if (isObj(meta.errors) ? hasErrors(meta) : isObj(meta.lastError)) chipList.push('오류 있음');
    if (running) chipList.unshift(runningAlive ? '작업 중' : '응답 없음');

    // the plan this conversation summarised (newest revision), or the chips/skeleton of a plan file without a summary
    const planIds = new Set([...arr(meta.planIds), ...Object.keys(isObj(meta.planChips) ? meta.planChips : {}), ...Object.keys(isObj(meta.planFiles) ? meta.planFiles : {})]);
    for (const p of plansById.values()) if (p.rev && str(p.rev.ownerSessionId) === sid) planIds.add(p.planId);
    let ownPlan;
    for (const planId of planIds) {
      const p = plansById.get(planId);
      if (p && p.rev && str(p.rev.ownerSessionId) === sid) {
        const m = planModelOf(p);
        if (!ownPlan || (m.at ?? 0) > (ownPlan.at ?? 0)) ownPlan = m;
        continue;
      }
      if (p && p.rev) continue; // summarised by another conversation: its chips are theirs
      const { chips: planChips } = planChipsOf(meta, planId);
      for (const c of planChips) if (!chipList.includes(c)) chipList.push(c);
      if (!ownPlan && p && isObj(p.status) && arr(p.status.skeleton && p.status.skeleton.tasks).length > 0) {
        ownPlan = skeletonPlan(planId, isObj(meta.planFiles) ? meta.planFiles[planId] : null, p.status, meta);
      }
    }

    const auto = autoInfo(meta.auto);
    const view = {
      id: sid,
      project: projectOf(meta.cwd),
      cwd: str(meta.cwd),
      title: str(brief.title) || str(meta.title) || sid,
      paneId: str(meta.paneId),
      workName: str(isObj(meta.auto) && isObj(meta.auto.work) ? meta.auto.work.name : '') || str(meta.workName),
      status,
      statusKey: cardStatus(truthView, now),
      tab: tabOf({ status, decisions, mirrorOpen: Boolean(openQuestion) }, now),
      chips: chipList,
      headline: str(brief.headline) || (autoSummaryText.split('\n')[0] ?? ''),
      lastActivityAt: last,
      lastBriefAt: latest.at ?? (isNum(meta.lastBriefAt) ? meta.lastBriefAt : null),
      changesNew,
      changes,
      done,
      next: str(brief.next),
      decisions,
      flow: arr(brief.flow).filter(isObj),
    };
    if (openQuestion) view.openQuestion = openQuestion;
    if (auto) view.auto = auto;
    const live = liveInfo(meta.auto);
    if (live) view.live = live;
    if (ownPlan) view.plan = ownPlan;
    if (autoSummaryText) { view.autoSummary = true; view.autoSummaryText = autoSummaryText; }
    if (meta.replyTrimmed === true) view.answerTrimmed = true; // producer field -> view field
    sessions.push(view);
  }

  // A conversation that runs someone else's plan (boulder work session_ids): a one-line link to the plan card, or the plan
  // itself when the owning conversation is not on the board.
  const onBoard = new Map(sessions.map((s) => [s.id, s]));
  for (const p of plansById.values()) {
    if (!p.rev || !isObj(p.status) || !isObj(p.status.work)) continue;
    const owner = str(p.rev.ownerSessionId);
    const runners = [];
    for (const raw of arr(p.status.work.sessionIds)) {
      const view = onBoard.get(bareSid(raw));
      if (!view || view.id === owner || view.plan || view.planLink || runners.includes(view)) continue;
      runners.push(view);
    }
    if (!runners.length) continue;
    const m = planModelOf(p);
    // No owner on the board: ONE executing conversation carries the plan (most recent activity, then id), so every plan
    // address occurs once on the page; the others link to it.
    const holder = onBoard.has(owner) ? null
      : runners.slice().sort((a, b) => (b.lastActivityAt - a.lastActivityAt) || (a.id < b.id ? -1 : 1))[0];
    if (holder) holder.plan = m;
    const target = holder ? holder.id : owner;
    for (const view of runners) {
      if (view === holder) continue;
      view.planLink = { planId: m.planId, ownerId: target, source: { slug: str(m.source.slug) }, stage: m.stage, goal: str(m.goal) };
    }
  }

  const openOf = (s) => s.decisions.filter((d) => !d.answered && !d.closed);
  const waitKey = (s) => {
    const open = openOf(s);
    return {
      at: open.length ? Math.min(...open.map((d) => d.createdAt ?? Infinity)) : Infinity,
      id: open.length ? Math.min(...open.map((d) => d.id)) : Infinity,
    };
  };
  const ordered = [];
  for (const tab of TABS) {
    const list = sessions.filter((s) => s.tab === tab);
    if (tab === '나를 기다림') {
      list.sort((a, b) => {
        const ka = waitKey(a), kb = waitKey(b);
        return (ka.at - kb.at) || (ka.id - kb.id) || (b.lastActivityAt - a.lastActivityAt) || (a.id < b.id ? -1 : 1);
      });
    } else {
      list.sort((a, b) => (b.lastActivityAt - a.lastActivityAt) || (a.id < b.id ? -1 : 1));
    }
    // group by project, groups ordered by their first (best-ranked) conversation
    const groups = new Map();
    for (const s of list) {
      if (!groups.has(s.project)) groups.set(s.project, []);
      groups.get(s.project).push(s);
    }
    for (const g of groups.values()) ordered.push(...g);
  }

  const shown = new Set(ordered.map((s) => s.id));
  const vm = {
    schema: 1,
    seq: isObj(snap.published) && Number.isInteger(snap.published.seq) ? snap.published.seq : 0,
    gen: Number.isInteger(opts.generation) ? opts.generation : null,
    generatedAt: now,
    summary: {
      openDecisions: ordered.reduce((n, s) => n + openOf(s).length, 0),
      blocked: ordered.filter((s) => s.statusKey === 'blocked').length,
      stale: ordered.filter((s) => s.chips.includes('오래됨')).length,
    },
    readErrors: [...readErrors.map((e) => str(e && e.rel)), ...(opts.serverError ? ['server.json'] : [])],
    server: opts.server ?? null,
    // only conversations that are on the board can be waited for (a session older than 30 days is not drawn)
    waiting: waitingItems(snap).filter((w) => shown.has(w.sessionId)),
    sessions: ordered,
  };
  capSize(vm);
  return vm;
}

// JSON that is safe inside <script> and as a JS expression: no '<' (so no </script>, <!--),
// and no raw U+2028/U+2029.
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Our own page scripts: '<' before script / !-- only appears in comments, strings and regexes,
// where \x3C keeps the same meaning but the HTML parser no longer sees a tag or escape.
function inlineJs(src) {
  return src.replace(/<(\/?script|!--)/gi, '\\x3C$1');
}

function dataJsText(vm) {
  return `/* seq:${vm.seq} */\nwindow.__briefData && window.__briefData(${scriptJson(vm)});\n`;
}

const PAGE_CSS = ['page.css', 'plan-view.css', 'workers-view.css', 'alarm.css'];
// view.js first, then the block renderers it calls into, then alarm.js, then page.js which wires them together.
const PAGE_JS = ['view.js', 'plan-view.js', 'workers-view.js', 'alarm.js', 'page.js'];

/**
 * The whole board page (all scripts and styles inline, first paint from `vm`). mode 'file' = STATE/index.html,
 * 'server' = GET / of the board server; both are built from the same template of this generation.
 */
export function pageHtml(vm, generation, { mode = 'file', fs = nodeFs } = {}) {
  const read = (name) => fs.readFileSync(join(PAGE_DIR, name), 'utf8');
  const css = PAGE_CSS.map((n) => read(n).replace(/<\/style/gi, '<\\/style')).join('\n');
  return '<!doctype html>\n<html lang="ko"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<link rel="icon" href="data:,">' + // inline icon: the board server has no /favicon.ico and its 404 would be a console error on every load
    (Number.isInteger(generation) ? `<meta name="omo-briefing-generation" content="${generation}">` : '') +
    `<meta name="omo-briefing-mode" content="${mode === 'server' ? 'server' : 'file'}">` +
    '<title>OMO 상황판</title>\n<style>\n' + css + '\n</style></head>\n<body>\n<div id="app"></div>\n' +
    PAGE_JS.map((n) => '<script>\n' + inlineJs(read(n)) + '\n</script>\n').join('') +
    // Runs after page.js's own DOMContentLoaded start(): first paint uses the inline data,
    // data.js re-injection then only raises the badge for a larger seq.
    '<script>\ndocument.addEventListener("DOMContentLoaded", function () { window.__briefData && window.__briefData(' +
    scriptJson(vm) + '); });\n</script>\n</body></html>\n';
}

function lastPublishedSeq(store, snap) {
  // Never go below any published artifact: published.json can lag behind data.js
  // (or be missing/broken), so the base is the larger of the two.
  const fromManifest = isObj(snap.published) && Number.isInteger(snap.published.seq) ? snap.published.seq : 0;
  let fromData = 0;
  // readText retries transient errors and returns null only when data.js is absent; an exhausted read
  // error throws, so the publish is skipped (last page kept) and reported instead of restarting lower.
  const text = store.readText('data.js');
  const m = text === null ? null : /^\/\* seq:(\d+) \*\//.exec(text);
  if (m) fromData = Number(m[1]);
  return Math.max(fromManifest, fromData);
}

function makeRenderer(store, now, opts) {
  const fs = opts.fs ?? nodeFs;
  const sleep = opts.sleep ?? sleepSync;
  const isAlive = opts.isAlive ?? isPidAlive;
  const lockPath = join(store.root, LOCK);
  const seqs = [];
  const generation = opts.generation !== undefined ? opts.generation : OWN_GENERATION;
  const soft = opts.soft === true;
  // asked right before anything is written and after every wait: false = the board is paused, so nothing may be published
  const canPublish = typeof opts.canPublish === 'function' ? opts.canPublish : () => true;
  const pausedOut = () => ({ ok: false, paused: true, seqs, error: PAUSED_ERROR });

  // True when index.html on disk was written by a newer generation than ours: only data.js is updated then.
  // readText returns null only when there is no page yet; an exhausted read error throws: the caller must not downgrade blindly.
  function pageIsNewer() {
    if (!Number.isInteger(generation)) return false;
    const text = store.readText('index.html');
    const m = text === null ? null : STAMP_RE.exec(text);
    return m !== null && Number(m[1]) > generation;
  }

  function readLock() {
    try { return store.readRecord(LOCK); } catch { return null; } // unreadable = maybe being written = alive
  }

  // One look at the lock. {rec}: taken. {error[, busy]}: give up. {again}: removed a dead/own leftover, look again now.
  // {wait}: held by a live owner and attempts are left. maxWait = last attempt that may still wait (0 = take it once).
  function step(attempt, maxWait) {
    const rec = { pid: process.pid, at: Date.now(), nonce: randomUUID() };
    try {
      store.writeNew(LOCK, rec);
      return { rec };
    } catch (err) {
      if (!CONTENTION.has(err.code)) throw err;
    }
    const cur = readLock();
    if (cur && cur.nonce && stranded.get(lockPath) === cur.nonce) {
      // our own leftover from a release whose verification read failed: nonce-verified, so safe to remove.
      // The nonce is forgotten only once the file is really gone, so a transient unlink failure stays recoverable.
      try { fs.unlinkSync(lockPath); } catch (err) { if (err.code !== 'ENOENT') return { error: `render.lock 정리 실패: ${err.message || err}` }; }
      stranded.delete(lockPath);
      return { again: true };
    }
    if (cur && Number.isInteger(cur.pid) && cur.nonce && !isAlive(cur.pid)) {
      let reclaimed = false;
      try { reclaimed = store.reclaimStale(LOCK, cur); } catch (err) { return { error: String(err.message || err) }; }
      if (reclaimed && attempt < MAX_RETRIES) return { again: true };
    }
    if (attempt >= maxWait) {
      return { error: `render.lock 잠금을 얻지 못함(잡은 pid ${cur && cur.pid}) - 이번 게시 건너뜀`, busy: true };
    }
    return { wait: true };
  }

  function acquireSync() {
    let delay = FIRST_DELAY_MS;
    for (let attempt = 0; ; attempt++) {
      const s = step(attempt, soft ? 0 : MAX_RETRIES);
      if (s.rec || s.error) return s;
      if (s.again) continue;
      sleep(delay);
      delay *= 2;
    }
  }

  // Looks at the lock without waiting: {s, attempt} where s is {rec} | {error} | {wait}.
  function lookNow() {
    for (let attempt = 0; ; attempt++) {
      const s = step(attempt, soft ? 0 : MAX_RETRIES);
      if (!s.again) return { s, attempt };
    }
  }

  // Waits for a busy lock with awaited timers (the caller's event loop keeps running), same budget as acquireSync().
  async function waitForLock(attempt) {
    // tests inject `sleep` to skip waiting; an injected synchronous sleep is simply awaited
    const wait = opts.sleepAsync ?? (opts.sleep ? async (ms) => opts.sleep(ms) : sleepAsync);
    let delay = FIRST_DELAY_MS;
    for (let a = attempt; ; ) {
      await wait(delay);
      if (!canPublish()) return { paused: true }; // paused while waiting: do not even try for the lock
      delay *= 2;
      a++;
      for (;;) {
        const s = step(a, soft ? 0 : MAX_RETRIES);
        if (s.again) { a++; continue; }
        if (!s.wait) return s;
        break;
      }
    }
  }

  // Returns an error string when the lock could not be released; undefined when released or confirmed not ours.
  function release(rec) {
    let cur;
    try { cur = store.readRecord(LOCK); } catch (err) {
      stranded.set(lockPath, rec.nonce); // unreadable is not 'not ours': remember it so the next acquire can remove it
      return `render.lock 해제 확인 실패(잠금이 남았을 수 있음): ${err && err.message || err}`;
    }
    if (!cur || cur.nonce !== rec.nonce) return undefined; // not ours any more: never delete someone else's lock
    try { fs.unlinkSync(lockPath); } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      stranded.set(lockPath, rec.nonce);
      return `render.lock 해제 실패: ${err.message || err}`;
    }
    return undefined;
  }

  // Everything after the lock was taken: synchronous, shared by the sync and the async driver.
  function publishLocked(lock) {
    let readMtime;
    let failure = null;
    let paused = false;
    let stampError;
    try {
      const snap = store.readSnapshot();
      readMtime = snap.maxMtime;
      const info = serverInfoOf(store, isAlive);
      if (typeof opts.onServerInfo === 'function') opts.onServerInfo(info); // the caller notes a failed record read after the publish
      const vm = buildViewModel(snap, now, {
        isAlive, fs, pendingDeliveries: opts.pendingDeliveries, generation, server: info.server, serverError: info.error,
      });
      vm.seq = lastPublishedSeq(store, snap) + 1;
      capSize(vm); // the seq text is part of data.js: confirm the cap on the final text
      if (!canPublish()) throw PAUSED;
      const data = dataJsText(vm);
      store.replace('data.js', data);
      let keepPage;
      try { keepPage = pageIsNewer(); } catch (err) {
        // generation of the existing page unknown: fail closed - keep it, still publish the data, and report it
        keepPage = true;
        stampError = `게시 실패: 기존 페이지 세대를 확인하지 못해 페이지는 그대로 둠: ${err && err.message || err}`;
      }
      if (!keepPage) store.replace('index.html', pageHtml(vm, Number.isInteger(generation) ? generation : null, { mode: 'file', fs }));
      store.replace('published.json', { seq: vm.seq, dataHash: createHash('sha256').update(data).digest('hex'), at: now });
      seqs.push(vm.seq);
    } catch (err) {
      if (err === PAUSED) paused = true;
      else failure = `게시 실패: ${err && err.message || err}`;
    }
    const releaseError = release(lock.rec);
    if (paused) return { paused: true, releaseError };
    if (failure) return { error: failure };
    if (releaseError) return { releaseError, stampError };
    if (stampError) return { stampError };
    return { changed: store.readSnapshot().maxMtime > readMtime };
  }

  const publishOnceSync = () => {
    const lock = acquireSync();
    return lock.error ? { error: lock.error, busy: lock.busy } : publishLocked(lock);
  };
  // A free lock is taken and the publish finished right away (no await in between, exactly like renderPage); only a
  // busy lock turns this into a promise. Returns the publish result, or a promise of it.
  const publishOnceMaybe = () => {
    const { s, attempt } = lookNow();
    if (s.rec) return publishLocked(s);
    if (s.error) return { error: s.error, busy: s.busy };
    return waitForLock(attempt).then((lock) => (lock.paused ? { paused: true } : lock.error ? { error: lock.error, busy: lock.busy } : publishLocked(lock)));
  };

  function record(error) {
    if (opts.sessionId) {
      const rel = `sessions/${opts.sessionId}/meta.json`;
      try {
        const cur = store.readRecord(rel) ?? { sessionId: opts.sessionId };
        if (setError(cur, 'render', error, now)) store.replace(rel, cur);
      } catch { /* the next event re-renders and retries; the caller still gets the error */ }
    }
  }
  // unshown: the lock was never taken / the data could not be written, so no page carries this error yet
  function fail(error, unshown = false) {
    record(error);
    return unshown ? { ok: false, seqs, error, unshown: true } : { ok: false, seqs, error };
  }

  // The page was kept because its generation could not be read: record the error and publish once more so the data carries the chip.
  function* failStamp(res) {
    record(res.stampError);
    const next = yield;
    if (next.paused) return pausedOut();
    return fail(next.error ?? next.releaseError ?? res.stampError);
  }

  // The publish sequence; every `yield` asks the driver for one more lock-publish and receives its result.
  function* flow() {
    const first = yield;
    if (first.paused) return pausedOut();
    if (first.error) {
      if (first.busy && soft) return { ok: false, busy: true, seqs, error: first.error }; // nothing recorded: the caller retries
      return fail(first.error, true);
    }
    if (first.stampError && !first.releaseError) return yield* failStamp(first);
    if (first.releaseError) {
      // The page is out but its lock may be stranded: surface it (render source) and publish again so the page carries the
      // chip; that acquire removes our own nonce-verified leftover, or fails visibly if it still cannot be read.
      record(first.releaseError);
      const again = yield;
      if (again.paused) return pausedOut();
      return fail(again.error ?? again.releaseError ?? first.releaseError);
    }
    if (first.changed) {
      const again = yield;
      if (again.paused) return { ok: true, seqs }; // the first publication went out; the follow-up is not wanted any more
      if (again.error) {
        if (again.busy && soft) return { ok: true, seqs }; // the first publication went out; the follow-up is best effort
        return fail(again.error);
      }
      if (again.stampError && !again.releaseError) return yield* failStamp(again);
      if (again.releaseError) { // same handling as the first publication: record, publish once more with the chip, never success
        record(again.releaseError);
        const last = yield;
        if (last.paused) return pausedOut();
        return fail(last.error ?? last.releaseError ?? again.releaseError);
      }
    }
    return { ok: true, seqs };
  }

  return { flow, publishOnceSync, publishOnceMaybe };
}

/**
 * @param {ReturnType<import('./store.mjs').openStore>} store
 * @param {number} [now]
 * @param {{sessionId?: string, sleep?: (ms:number)=>void, isAlive?: (pid:number)=>boolean, fs?: object,
 *   pendingDeliveries?: Iterable<number>, generation?: number|null}} [opts]
 * @returns {{ok: boolean, seqs: number[], error?: string}}
 */
export function renderPage(store, now = Date.now(), opts = {}) {
  const r = makeRenderer(store, now, opts);
  const gen = r.flow();
  let step = gen.next();
  while (!step.done) step = gen.next(r.publishOnceSync());
  return step.value;
}

/**
 * Same publish as renderPage, but a contended render.lock is waited for with an awaited timer (opts.sleepAsync, default
 * setTimeout), so the event loop of the caller keeps running. opts.soft = take the lock once, never wait.
 * @returns {Promise<{ok: boolean, seqs: number[], error?: string, busy?: boolean}>}
 */
export function renderPageAsync(store, now = Date.now(), opts = {}) {
  try {
    return Promise.resolve(renderPageMaybe(store, now, opts));
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * renderPageAsync without the promise when none is needed: a free render.lock gives the finished result right away (the
 * publish ran inside this call, like renderPage); a busy lock gives a promise of it. Throws like renderPage does.
 */
export function renderPageMaybe(store, now = Date.now(), opts = {}) {
  const r = makeRenderer(store, now, opts);
  const gen = r.flow();
  const drive = (first) => {
    let step = first;
    while (!step.done) {
      const out = r.publishOnceMaybe();
      if (out && typeof out.then === 'function') return out.then((v) => drive(gen.next(v)));
      step = gen.next(out);
    }
    return step.value;
  };
  return drive(gen.next());
}
