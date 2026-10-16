// omo-briefing src/plan-tool.mjs - `plan_brief` tool: plan revisions, plan questions as decisions, plan-file freshness.
//
// createPlanTool({store, sessionId, cwd, isEnabled, publish, onError, onRecover, readText, sha256, ...}) ->
//   { definition, execute(params), onToolResult(event), onSettled() }
//
// Wiring contract (todo 13 connects it; this module never touches extension.mjs):
//   - isEnabled(): same meaning as extension `enabled()` (false = paused, an unreadable settings file also reads as false).
//     Paused: execute answers exactly like executeBrief (nothing validated, nothing saved); onToolResult and onSettled
//     do nothing at all (no status.json, no meta, no publish).
//   - publish(): publishes the page once (extension `refresh`); may be async; `{ok:false, error}` is shown to the agent.
//   - onError(key, err) / onRecover(key): extension `recordError` / `settle`. They record in meta.errors and publish by
//     themselves, so this module does not publish a second time for the failure itself. Keys: `plan:<planId>`
//     (`plan:boulder` / `plan:writes` when no plan is known). Only a clean run of the same key recovers it: `plan:writes`
//     is cleared by a settle pass that read the plan list and saved its meta changes (a failed save is retried first).
//   - getMeta()/saveMeta(meta): the extension's in-memory meta (REQUIRED when wired: a second writer of meta.json would
//     be overwritten by the extension's own saveMeta). Without them (unit tests) meta.json is read/replaced via the store.
//   - pageUrl: string or () => string shown in the result sentence (the extension passes its page path/URL).
// Read-only toward the project: plan files, drafts, boulder and ledger are only read, by exact path, never written.
import * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  validatePlanBrief, planIdOf, rootAndSlugOf, PLAN_BRIEF_PARAMETERS, PLAN_BRIEF_DESCRIPTION,
} from './plan-schema.mjs';
import { computePlanStatus, findPlanForSession } from './plan-status.mjs';

export const PLAN_REV_SCHEMA = 'omo-plan/1';
export const PLAN_CHIP_NO_SUMMARY = '계획 요약 없음';
export const PLAN_CHIP_STALE = '계획 파일이 요약 뒤에 바뀜';
export const planChipMissing = (n) => `요약에 없는 할 일 ${n}개`;

const STATUS_TTL_MS = 60_000;
// tools that can write a plan file (read/grep/find/ls must not count as a write)
const WRITE_TOOL_RE = /edit|write|patch/i;
const PATCH_FILE_RE = /^\*\*\* (?:Update|Add) File: (.+?)\s*$/gm;
const PATH_FIELDS = ['path', 'file_path', 'filePath'];
const PLAN_IDS_MAX = 50;
const DISABLED_TEXT = '브리핑이 꺼져 있습니다(/brief on 으로 켤 수 있음). 이번 보고는 저장하지 않았습니다.';

const pad6 = (n) => String(n).padStart(6, '0');
const decisionRel = (id) => `decisions/${pad6(id)}.json`;
const answerRel = (id) => `answers/${pad6(id)}.json`;
const closureRel = (id) => `decision-closures/${pad6(id)}.json`;
const claimRel = (id) => `claims/${pad6(id)}.json`;
const codeOf = (err) => (err && typeof err.code === 'string' && err.code) || 'ERROR';
const isDraftPath = (p) => /[\\/]\.omo[\\/]drafts[\\/]/i.test(p);
const defaultSha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Chips of one plan. Pure. `planWritten` = this session wrote the plan/draft file (tool_result), `rev` = newest summary,
 * `status` = last computed omo-plan-status/1.
 */
export function planChips({ rev, status, planWritten } = {}) {
  const chips = [];
  if (!rev) {
    if (planWritten) chips.push(PLAN_CHIP_NO_SUMMARY);
    return chips;
  }
  const src = rev.source ?? {};
  const now = status?.files ?? {};
  const changed = (was, cur) => typeof was === 'string' && typeof cur === 'string' && was !== cur;
  if (changed(src.planSha256, now.planSha256Now) || changed(src.draftSha256, now.draftSha256Now)) chips.push(PLAN_CHIP_STALE);
  const known = new Set((rev.plan?.tasks ?? []).map((t) => t.id));
  const missing = (status?.skeleton?.tasks ?? []).filter((t) => !known.has(t.id)).length;
  if (missing > 0) chips.push(planChipMissing(missing));
  return chips;
}

export function createPlanTool(opts) {
  const {
    store, sessionId, cwd, isEnabled, publish, onError, onRecover,
  } = opts;
  const fs = opts.fs ?? nodeFs;
  const nowMs = typeof opts.now === 'function' ? opts.now : Date.now;
  const sha256 = opts.sha256 ?? defaultSha256;
  const readText = opts.readText ?? (async (p) => {
    try {
      return await fs.promises.readFile(p, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null; // absent is an answer; anything else is thrown
      throw err;
    }
  });
  const pageUrl = () => (typeof opts.pageUrl === 'function' ? opts.pageUrl() : opts.pageUrl ?? '(주소 없음)');

  const metaRel = `sessions/${sessionId}/meta.json`;
  let ownMeta = null;
  const getMeta = opts.getMeta ?? (() => (ownMeta ??= store.readRecord(metaRel) ?? { sessionId }));
  const saveMeta = opts.saveMeta ?? ((m) => store.replace(metaRel, m));

  const lastComputed = new Map(); // planId -> ms of the last status computation (60s cache)
  const lastStatusKey = new Map(); // planId -> status without `at` as last written
  let inflight = null;
  let metaUnsaved = false; // settle's meta save failed: the next pass saves again before `plan:writes` may clear

  const fileExists = (p) => {
    try { return fs.statSync(p).isFile(); } catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false; throw err; }
  };
  const exists = (rel) => store.readText(rel) !== null; // text present = exists (even if broken); throws = unreadable
  // This session's decision that nobody answered, claimed or closed. Any read failure throws (validator reports it).
  const isOwnOpenDecision = (id) => {
    const rec = store.readRecord(decisionRel(id));
    if (!rec || rec.sessionId !== sessionId) return false;
    return !exists(answerRel(id)) && !exists(closureRel(id)) && !exists(claimRel(id));
  };
  const boulderPathFor = (planOrDraft) => path.join(path.dirname(path.dirname(planOrDraft)), 'boulder.json'); // <root>/.omo/boulder.json

  // ---- questions as decisions ----
  // Rules: reuse the open decision of the same (planId, qid); never close a decision that has an answer or a claim;
  // a decision whose state cannot be read is neither closed nor duplicated (problem is reported instead).
  function syncQuestions(planId, questions, at, problems) {
    const out = { opened: [], created: [], closed: [] };
    let snap;
    try {
      snap = store.readSnapshot();
    } catch (err) {
      problems.push(`결정 목록 읽기 실패(${codeOf(err)}) - 질문 연결을 건너뜀`);
      return out;
    }
    const unreadable = snap.readErrors.filter((e) => /^decisions[\\/]/.test(String(e.rel)));
    if (unreadable.length > 0) {
      problems.push(`결정 파일 읽기 실패(${unreadable.map((e) => e.rel).join(', ')}) - 질문 연결을 건너뜀`);
      return out;
    }
    const stateOf = (d) => {
      try {
        if (exists(answerRel(d.id))) return 'answered';
        if (exists(closureRel(d.id))) return 'closed';
        if (exists(claimRel(d.id))) return 'claimed';
        return 'open';
      } catch (err) {
        problems.push(`결정 #${d.id} 상태 읽기 실패(${codeOf(err)}) - 닫지 않음`);
        return 'unreadable';
      }
    };
    const mine = snap.decisions
      .filter((d) => d && d.source === 'plan' && d.planId === planId && Number.isInteger(d.id))
      .map((d) => ({ d, st: stateOf(d) }));
    const close = (id) => {
      try {
        store.writeNew(closureRel(id), { id, reason: 'superseded', at });
        out.closed.push(id);
      } catch (err) {
        if (err.code === 'EEXIST') return; // closed by someone else meanwhile: nothing to add
        problems.push(`결정 #${id} 닫기 실패(${codeOf(err)})`);
      }
    };
    const closeOpen = (pred) => {
      for (const { d, st } of mine) if (st === 'open' && pred(d)) close(d.id);
    };

    const inInput = new Set(questions.map((q) => q.id));
    for (const q of questions) {
      const own = mine.filter(({ d }) => d.qid === q.id);
      if (q.state !== 'open') { closeOpen((d) => d.qid === q.id); continue; }
      let keepId = null;
      if (q.decisionId !== undefined) {
        keepId = q.decisionId; // validated as this session's open decision
      } else {
        const reuse = own.find(({ d, st }) => st === 'open' && d.sessionId === sessionId);
        if (reuse) keepId = reuse.d.id;
      }
      // another session's unanswered decision of the same question is replaced (plan taken over)
      closeOpen((d) => d.qid === q.id && d.id !== keepId && d.sessionId !== sessionId);
      if (keepId !== null) { out.opened.push(keepId); continue; }
      // stored answers/claims/unreadable states win over the agent's claim that the question is still open
      if (own.some(({ st }) => st === 'answered' || st === 'claimed' || st === 'unreadable')) continue;
      const id = store.allocDecisionId({
        sessionId, question: q.text, options: q.options, recommend: q.recommend, reason: q.reason,
        blocks: q.blocks, createdAt: at, source: 'plan', planId, qid: q.id,
      });
      out.opened.push(id);
      out.created.push(id);
    }
    // questions dropped from this revision
    closeOpen((d) => !inInput.has(d.qid));
    return out;
  }

  // ---- plan_brief ----
  async function execute(params) {
    if (!isEnabled()) return { content: [{ type: 'text', text: DISABLED_TEXT }], details: { disabled: true } };
    const v = validatePlanBrief(params, { fileExists, isOwnOpenDecision });
    if (!v.ok) {
      throw new Error(`plan_brief 입력 거절(저장하지 않음) - 아래를 고쳐 다시 호출:\n${v.errors.map((e) => `- ${e}`).join('\n')}`);
    }
    const plan = v.normalized;
    const { planId } = v;
    const key = `plan:${planId}`;
    const files = {};
    for (const [field, kind] of [['planPath', 'plan'], ['draftPath', 'draft']]) {
      if (plan[field] === undefined) continue;
      const rs = rootAndSlugOf(plan[field]);
      if (planIdOf(rs.root, rs.slug) !== planId) {
        throw new Error(`plan_brief 입력 거절(저장하지 않음) - ${field}: planPath와 draftPath가 서로 다른 계획(폴더나 파일명이 다름)`);
      }
      files[kind] = plan[field];
    }
    const t = nowMs();
    const problems = [];

    const status = await computePlanStatus({
      planPath: files.plan, draftPath: files.draft, boulderPath: boulderPathFor(files.plan ?? files.draft),
      readText, sha256, now: t,
    });
    if (status.errors.length > 0) problems.push(`계획 파일 읽기 문제(${[...new Set(status.errors.map((e) => e.code))].join(', ')})`);

    const rs = rootAndSlugOf(files.plan ?? files.draft);
    const record = {
      schema: PLAN_REV_SCHEMA,
      planId,
      at: t,
      ownerSessionId: sessionId,
      source: {
        root: rs.root,
        slug: rs.slug,
        ...(files.plan !== undefined ? { planPath: files.plan } : {}),
        ...(files.draft !== undefined ? { draftPath: files.draft } : {}),
        ...(status.files.planSha256Now !== undefined ? { planSha256: status.files.planSha256Now } : {}),
        ...(status.files.draftSha256Now !== undefined ? { draftSha256: status.files.draftSha256Now } : {}),
      },
      plan,
    };
    let saved;
    try {
      saved = store.writePlanRev(planId, record);
    } catch (err) {
      onError(key, new Error(`계획 저장 실패(${codeOf(err)}): ${err.message}`)); // records AND publishes the failure
      throw new Error(`계획을 저장하지 못했습니다(${codeOf(err)}). 다시 호출하세요: ${err.message}`);
    }
    if (saved.pruneError) problems.push(`오래된 계획 판 삭제 실패(${codeOf(saved.pruneError)})`);
    lastComputed.set(planId, t);

    const fullStatus = { ...status, planId, bySessionId: sessionId };
    try {
      store.writePlanStatus(planId, fullStatus);
      lastStatusKey.set(planId, statusKey(fullStatus));
    } catch (err) {
      problems.push(`계획 상태 저장 실패(${codeOf(err)})`);
    }

    const q = syncQuestions(planId, plan.questions, t, problems);

    const meta = getMeta();
    const ids = Array.isArray(meta.planIds) ? meta.planIds : [];
    if (!ids.includes(planId)) ids.push(planId);
    if (ids.length > PLAN_IDS_MAX) ids.splice(0, ids.length - PLAN_IDS_MAX);
    meta.planIds = ids;
    setChips(meta, planId, { rev: { ...record, rev: saved.rev }, status: fullStatus, planWritten: meta.planWrites?.[planId] }, t);
    try {
      saveMeta(meta);
    } catch (err) {
      problems.push(`세션 기록 저장 실패(${codeOf(err)})`);
    }

    if (problems.length > 0) onError(key, new Error(problems.join('; ')));
    else onRecover(key);

    const res = await publish();
    const shown = (list) => (list.length > 0 ? list.map((id) => `#${id}`).join(',') : '없음');
    const head = res && res.ok === false
      ? `계획 r${saved.rev} 저장됐지만 상황판은 갱신되지 못함: ${res.error}`
      : `계획 r${saved.rev} 저장`;
    const lines = [`${head} · 결정 열림 ${shown(q.opened)} / 닫힘 ${shown(q.closed)} · 상황판 ${pageUrl()}`];
    for (const p of problems) lines.push(`경고: ${p}`);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: { planId, rev: saved.rev, opened: q.opened, created: q.created, closed: q.closed, problems },
    };
  }

  const statusKey = (s) => JSON.stringify({ ...s, at: undefined });

  // checkedAt = time of the last check (the board's "마지막 확인"); returns true only when the chips changed, so a check
  // that finds nothing new is not saved or published on its own
  function setChips(meta, planId, input, t) {
    const chips = planChips(input);
    const cur = meta.planChips?.[planId];
    const same = cur && JSON.stringify(cur.chips) === JSON.stringify(chips);
    meta.planChips = { ...(meta.planChips ?? {}), [planId]: { chips, checkedAt: t } };
    return !same;
  }

  // ---- tool_result: remember that this session wrote a plan/draft file ----
  function planFilesIn(input) {
    if (!input || typeof input !== 'object') return [];
    const found = [];
    for (const f of PATH_FIELDS) if (typeof input[f] === 'string') found.push(input[f]);
    for (const val of Object.values(input)) {
      if (typeof val !== 'string') continue;
      for (const m of val.matchAll(PATCH_FILE_RE)) found.push(m[1]);
    }
    const abs = found.map((p) => (path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd ?? '.', p)));
    return [...new Set(abs)].filter((p) => rootAndSlugOf(p) !== null);
  }

  function onToolResult(event) {
    let planId = null;
    try {
      if (!isEnabled()) return;
      if (!event || event.isError === true || !WRITE_TOOL_RE.test(String(event.toolName ?? ''))) return;
      const files = planFilesIn(event.input);
      if (files.length === 0) return;
      const meta = getMeta();
      const at = nowMs();
      const writes = { ...(meta.planWrites ?? {}) };
      const known = { ...(meta.planFiles ?? {}) };
      for (const f of files) {
        const rs = rootAndSlugOf(f);
        planId = planIdOf(rs.root, rs.slug);
        writes[planId] = at;
        known[planId] = { ...(known[planId] ?? {}), [isDraftPath(f) ? 'draftPath' : 'planPath']: f };
      }
      meta.planWrites = writes;
      meta.planFiles = known;
      saveMeta(meta);
    } catch (err) {
      onError(planId ? `plan:${planId}` : 'plan:writes', err);
    }
  }

  // ---- agent_settled: recompute plan status (60s cache) and the chips ----
  async function settle() {
    if (!isEnabled()) return [];
    const t = nowMs();
    const meta = getMeta();
    let plans = [];
    try {
      plans = store.readPlans();
    } catch (err) {
      onError('plan:writes', err);
      return [];
    }
    const targets = new Map(); // planId -> { planPath?, draftPath?, rev }
    const add = (planId, files) => {
      const cur = targets.get(planId) ?? { rev: null };
      targets.set(planId, { ...cur, ...Object.fromEntries(Object.entries(files).filter(([, v]) => v !== undefined)) });
    };
    for (const p of plans) {
      const mineRev = p.rev && p.rev.ownerSessionId === sessionId;
      if (!mineRev && !(meta.planIds ?? []).includes(p.planId)) continue;
      const s = p.rev?.source ?? {};
      add(p.planId, { planPath: s.planPath, draftPath: s.draftPath, rev: p.rev });
    }
    for (const [planId, f] of Object.entries(meta.planFiles ?? {})) {
      add(planId, { planPath: f.planPath, draftPath: f.draftPath });
    }
    try {
      const text = await readText(path.join(cwd ?? '.', '.omo', 'boulder.json'));
      const boulder = typeof text === 'string' ? JSON.parse(text) : null;
      const file = boulder ? findPlanForSession(boulder, sessionId, cwd) : null;
      const rs = file ? rootAndSlugOf(file) : null;
      if (file && rs) add(planIdOf(rs.root, rs.slug), { planPath: file });
      onRecover('plan:boulder');
    } catch (err) {
      onError('plan:boulder', err); // unreadable boulder is not "no work"
    }

    const results = [];
    let dirty = metaUnsaved;
    for (const [planId, tg] of targets) {
      if (!tg.planPath && !tg.draftPath) continue;
      if (lastComputed.has(planId) && t - lastComputed.get(planId) < STATUS_TTL_MS) continue;
      lastComputed.set(planId, t);
      const status = await computePlanStatus({
        planPath: tg.planPath, draftPath: tg.draftPath, boulderPath: boulderPathFor(tg.planPath ?? tg.draftPath),
        readText, sha256, now: t,
      });
      const full = { ...status, planId, bySessionId: sessionId };
      const key = `plan:${planId}`;
      if (statusKey(full) !== lastStatusKey.get(planId)) {
        try {
          store.writePlanStatus(planId, full);
          lastStatusKey.set(planId, statusKey(full));
          dirty = true;
        } catch (err) {
          onError(key, err);
          continue;
        }
      }
      if (setChips(meta, planId, { rev: tg.rev, status: full, planWritten: meta.planWrites?.[planId] }, t)) dirty = true;
      if (status.errors.length > 0) onError(key, new Error(`계획 파일 읽기 문제(${[...new Set(status.errors.map((e) => e.code))].join(', ')})`));
      else onRecover(key);
      results.push({ planId, chips: meta.planChips[planId].chips });
    }
    if (dirty) {
      try {
        saveMeta(meta);
        metaUnsaved = false;
      } catch (err) {
        metaUnsaved = true;
        onError('plan:writes', err);
      }
    }
    // the plan list was read and every meta change of this pass is saved: the same key's success clears its error
    if (!metaUnsaved) onRecover('plan:writes');
    if (dirty) await publish();
    return results;
  }

  function onSettled() {
    if (inflight) return inflight;
    inflight = settle().catch((err) => {
      onError('plan:writes', err);
      return [];
    }).finally(() => { inflight = null; });
    return inflight;
  }

  const definition = {
    name: 'plan_brief',
    label: 'Plan Brief',
    description: PLAN_BRIEF_DESCRIPTION,
    promptSnippet: '상황판 계획 보기에 ulw-plan 계획 요약(목표·단계·할 일·질문)을 올리는 도구',
    promptGuidelines: ['Call plan_brief once when planning with ulw-plan: right before asking for approval, right after writing/editing the plan file, and right after applying review results.'],
    parameters: PLAN_BRIEF_PARAMETERS,
    execute: (_id, params) => execute(params),
  };

  return { definition, execute, onToolResult, onSettled };
}
