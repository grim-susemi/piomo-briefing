// omo-briefing src/render.mjs - store snapshot -> view model -> index.html + data.js.
//
// - buildViewModel(snapshot, now, opts?): pure-ish (re-hashes evidence files, probes pids).
//   Output shape = test/fixtures/view-model.json (the contract src/page/view.js reads).
// - renderPage(store, now?, opts?): publish under render.lock (wx; dead-pid lock reclaimed with
//   store.reclaimStale, live lock never removed), seq = published.json seq + 1, replace-writes
//   data.js, index.html, published.json, releases the lock and publishes once more if the store
//   changed meanwhile. If the lock cannot be taken the publish is skipped and meta.lastError set.
//
// Brief records (sessions/<sid>/briefs/<seq>.json) are {at, brief:{...validated input}}; a record
// without `brief` is read as the brief itself.
import * as nodeFs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isPidAlive } from './store.mjs';
import { setError, hasErrors } from './errors.mjs';
import { cardStatus, chips as truthChips, tabOf, recheckEvidence } from './truth.mjs';

const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'page');
const DAY_MS = 24 * 3600 * 1000;
const RECENT_MS = 30 * DAY_MS;
const LARGE = 10 * 1024 * 1024;
const LOCK = 'render.lock';
const FIRST_DELAY_MS = 20;
const MAX_RETRIES = 8;
// render.lock files this process created but could not verify/remove at release (nonce by lock path): a live pid is never
// reclaimed by the stale rule, so the owner itself removes a nonce-verified leftover of its own.
const stranded = new Map();
// Installed generation of this code (AGENT/briefing/integration/generation-NNNNNN/...), or null when run from a checkout.
// It is stamped into index.html; a publisher never replaces the page template written by a NEWER generation.
const GENERATION_RE = /[\\/]generation-(\d{6})[\\/]/;
const OWN_GENERATION = (() => {
  const m = GENERATION_RE.exec(fileURLToPath(import.meta.url));
  return m ? Number(m[1]) : null;
})();
const STAMP_RE = /<meta name="omo-briefing-generation" content="(\d+)">/;
const CONTENTION = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
const STATUSES = new Set(['in_progress', 'blocked', 'needs_decision', 'done']);
const TABS = ['나를 기다림', '진행 중', '끝남'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const pad2 = (n) => String(n).padStart(2, '0');

function hhmm(ms) {
  if (!isNum(ms)) return '--:--';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

/**
 * @param {object} snapshot store.readSnapshot()
 * @param {number} now ms
 * @param {{isAlive?: (pid:number)=>boolean, fs?: object, pendingDeliveries?: Iterable<number>}} [opts]
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
  for (const d of arr(snap.decisions)) {
    if (!isObj(d) || !Number.isInteger(d.id) || typeof d.sessionId !== 'string') continue;
    if (!decisionsBySid.has(d.sessionId)) decisionsBySid.set(d.sessionId, []);
    decisionsBySid.get(d.sessionId).push(d);
  }

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
    if (autoSummaryText) { view.autoSummary = true; view.autoSummaryText = autoSummaryText; }
    if (meta.replyTrimmed === true) view.answerTrimmed = true; // producer field -> view field
    sessions.push(view);
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

  return {
    schema: 1,
    seq: isObj(snap.published) && Number.isInteger(snap.published.seq) ? snap.published.seq : 0,
    generatedAt: now,
    summary: {
      openDecisions: ordered.reduce((n, s) => n + openOf(s).length, 0),
      blocked: ordered.filter((s) => s.statusKey === 'blocked').length,
      stale: ordered.filter((s) => s.chips.includes('오래됨')).length,
    },
    readErrors: readErrors.map((e) => str(e && e.rel)),
    sessions: ordered,
  };
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

function indexHtml(vm, fs, generation) {
  const read = (name) => fs.readFileSync(join(PAGE_DIR, name), 'utf8');
  const css = read('page.css').replace(/<\/style/gi, '<\\/style');
  return '<!doctype html>\n<html lang="ko"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    (generation === null ? '' : `<meta name="omo-briefing-generation" content="${generation}">`) +
    '<title>OMO 상황판</title>\n<style>\n' + css + '\n</style></head>\n<body>\n<div id="app"></div>\n' +
    '<script>\n' + inlineJs(read('view.js')) + '\n</script>\n' +
    '<script>\n' + inlineJs(read('page.js')) + '\n</script>\n' +
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

/**
 * @param {ReturnType<import('./store.mjs').openStore>} store
 * @param {number} [now]
 * @param {{sessionId?: string, sleep?: (ms:number)=>void, isAlive?: (pid:number)=>boolean, fs?: object, pendingDeliveries?: Iterable<number>}} [opts]
 * @returns {{ok: boolean, seqs: number[], error?: string}}
 */
export function renderPage(store, now = Date.now(), opts = {}) {
  const fs = opts.fs ?? nodeFs;
  const sleep = opts.sleep ?? sleepSync;
  const isAlive = opts.isAlive ?? isPidAlive;
  const lockPath = join(store.root, LOCK);
  const seqs = [];
  const generation = opts.generation !== undefined ? opts.generation : OWN_GENERATION;

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

  function acquire() {
    let delay = FIRST_DELAY_MS;
    for (let attempt = 0; ; attempt++) {
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
        continue;
      }
      if (cur && Number.isInteger(cur.pid) && cur.nonce && !isAlive(cur.pid)) {
        let reclaimed = false;
        try { reclaimed = store.reclaimStale(LOCK, cur); } catch (err) { return { error: String(err.message || err) }; }
        if (reclaimed && attempt < MAX_RETRIES) continue;
      }
      if (attempt >= MAX_RETRIES) {
        return { error: `render.lock 잠금을 얻지 못함(잡은 pid ${cur && cur.pid}) - 이번 게시 건너뜀` };
      }
      sleep(delay);
      delay *= 2;
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

  function publishOnce() {
    const lock = acquire();
    if (lock.error) return { error: lock.error };
    let readMtime;
    let failure = null;
    let stampError;
    try {
      const snap = store.readSnapshot();
      readMtime = snap.maxMtime;
      const vm = buildViewModel(snap, now, { isAlive, fs, pendingDeliveries: opts.pendingDeliveries });
      vm.seq = lastPublishedSeq(store, snap) + 1;
      const data = dataJsText(vm);
      store.replace('data.js', data);
      let keepPage;
      try { keepPage = pageIsNewer(); } catch (err) {
        // generation of the existing page unknown: fail closed - keep it, still publish the data, and report it
        keepPage = true;
        stampError = `게시 실패: 기존 페이지 세대를 확인하지 못해 페이지는 그대로 둠: ${err && err.message || err}`;
      }
      if (!keepPage) store.replace('index.html', indexHtml(vm, fs, Number.isInteger(generation) ? generation : null));
      store.replace('published.json', { seq: vm.seq, dataHash: createHash('sha256').update(data).digest('hex'), at: now });
      seqs.push(vm.seq);
    } catch (err) {
      failure = `게시 실패: ${err && err.message || err}`;
    }
    const releaseError = release(lock.rec);
    if (failure) return { error: failure };
    if (releaseError) return { releaseError, stampError };
    if (stampError) return { stampError };
    return { changed: store.readSnapshot().maxMtime > readMtime };
  }

  function record(error) {
    if (opts.sessionId) {
      const rel = `sessions/${opts.sessionId}/meta.json`;
      try {
        const cur = store.readRecord(rel) ?? { sessionId: opts.sessionId };
        if (setError(cur, 'render', error, now)) store.replace(rel, cur);
      } catch { /* the next event re-renders and retries; the caller still gets the error */ }
    }
  }
  function fail(error) {
    record(error);
    return { ok: false, seqs, error };
  }

  // The page was kept because its generation could not be read: record the error and publish once more so the data carries the chip.
  function failStamp(res) {
    record(res.stampError);
    const next = publishOnce();
    return fail(next.error ?? next.releaseError ?? res.stampError);
  }

  const first = publishOnce();
  if (first.error) return fail(first.error);
  if (first.stampError && !first.releaseError) return failStamp(first);
  if (first.releaseError) {
    // The page is out but its lock may be stranded: surface it (render source) and publish again so the page carries the
    // chip; that acquire removes our own nonce-verified leftover, or fails visibly if it still cannot be read.
    record(first.releaseError);
    const again = publishOnce();
    return fail(again.error ?? again.releaseError ?? first.releaseError);
  }
  if (first.changed) {
    const again = publishOnce();
    if (again.error) return fail(again.error);
    if (again.stampError && !again.releaseError) return failStamp(again);
    if (again.releaseError) { // same handling as the first publication: record, publish once more with the chip, never success
      record(again.releaseError);
      const last = publishOnce();
      return fail(last.error ?? last.releaseError ?? again.releaseError);
    }
  }
  return { ok: true, seqs };
}
