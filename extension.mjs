// omo-briefing extension entry: lead-session gate, `brief` tool, /brief and /decide commands,
// rule injection, event bookkeeping and the reply-length budget (IS-4).
//
// API facts used here (field names read from the installed host, not guessed):
//   SENPI/extensions/types.d.ts  (SENPI = @code-yeongyu/senpi/dist/core)
//     - ExtensionAPI: `sessionKind` ("interactive" | "worker"), `on`, `registerTool`, `registerCommand`,
//       `events`, `session` (types.d.ts ~1749-1900, 2040-2045)
//     - ExtensionContext: `hasUI`, `cwd`, `ui.notify(message, type)`, `sessionManager`, `isIdle()` (~353-470)
//       ReadonlySessionManager (session-manager.d.ts): getSessionId(), getSessionFile(), getBranch()
//     - BeforeAgentStartEvent / BeforeAgentStartEventResult {systemPrompt} (~1157, ~1629)
//     - InputEvent {source: "interactive"|"rpc"|"extension"} (~1405)
//     - ToolResultEvent {toolName, content, isError} (~1480-1540)
//     - MessageEndEvent {message} -> MessageEndEventResult {message} (same role) (~1316, ~1625)
//     - AgentBeforeSettleEvent extends BoundaryState {entries, continue, context.contextMessages, outcome};
//       BoundaryResult {entries?, continue?}; CustomMessageEntryDraft {type:'custom_message', customType,
//       content, display, details?} (~1230-1275)
//   SENPI/agent-session.js `_runBeforeSettleBoundary` (~1335-1365): a continuation is honoured only when the
//     projected context can continue, so the rewrite request appends a (hidden) custom_message entry,
//     which the context turns into a user-side message after the final assistant answer.
//   SENPI/extensions/runner.js `emitBoundary` (~1166): handlers see the chained `entries`; a handler that
//     returns `entries` replaces the list, so we always return `[...event.entries, ours]`.
//   DOCS = AGENT/runtime/<id>/docs/extensions.md sections: 'pi.registerTool(definition)' (tool `execute`
//     returns {content, details}; throwing marks an error), 'pi.registerCommand', 'before_agent_start',
//     'agent_start / agent_end / agent_settled', 'turn_start / turn_end' (boundary entries/continue),
//     'message_start / message_update / message_end', 'input', 'tool_result', 'session_start',
//     'session_shutdown', 'Pending-question bus events'.
//   Tool parameters: plain JSON Schema is accepted (pi-ai validateToolArguments handles non-TypeBox schemas);
//     length budgets are enforced by src/schema.mjs so the model gets field names and limits back.
import * as nodeFs from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile as nodeExecFile, execFileSync as nodeExecFileSync } from 'node:child_process';
import { validateBrief, REPORT_BLOCK_SCHEMA, DECISION_FIELDS_SCHEMA } from './src/schema.mjs';
import { openStore } from './src/store.mjs';
import { collectAuto } from './src/collect.mjs';
import { applyDecide, applyBoardAnswer, applyBoardAnnotation, formatDecideResult } from './src/decide.mjs';
import { renderPageMaybe, buildViewModel, pageHtml, serverInfoOf, withReports, OWN_GENERATION } from './src/render.mjs';
import { importImage, gcAssets } from './src/assets.mjs';
import { createServerHost, readInstalledGeneration } from './src/server-host.mjs';
import { openProfilesStore } from './src/profiles/store.mjs';
import { createWorkersLive } from './src/workers-live.mjs';
import { createPlanTool } from './src/plan-tool.mjs';
import { createAskBridge } from './src/ask-bridge.mjs';
import { setError, clearError, errorsOf, normalizeErrors } from './src/errors.mjs';
import {
  injectRule, replyOverBudget, fitReply, assistantText, hasToolCall, parseHandoff,
} from './src/rule.mjs';
import { openPage } from './src/open-page.mjs';
import { readTab, herdrBin } from './src/herdr-tab.mjs';
import * as deliverMod from './src/deliver.mjs';
import * as mirrorMod from './src/mirror.mjs';

const CHILD_SESSION_RE = /[/\\]senpi-task[/\\]children[/\\]/;
const TASK_TOOL_RE = /(^|__)task$/;
const TASK_FOLLOW_RE = /(^|__)task_(output|cancel|send)$/;
const WORKER_ID_RE = /\bst_[0-9a-z]+\b/g;
// Native task statuses (omo-ai plugin/extensions/omo-task.js): pending, running, completed, error, cancelled, interrupted, lost.
const STATUS_WORD = '(pending|running|completed|error|failed|cancelled|canceled|interrupted|lost|timeout)';
const STATUS_RE = new RegExp(`\\b${STATUS_WORD}\\b`, 'i');
const STATUS_FIELD_RE = new RegExp(`\\bstatus\\s*[:=]\\s*${STATUS_WORD}\\b`, 'i');
const STATUS_NOW_RE = new RegExp(`\\bnow\\s+${STATUS_WORD}\\b`, 'i');
const WORKER_ID_ONE_RE = /^st_[0-9a-z]+$/;
const WORKERS_MAX = 200;
const SOFT_RETRY_MS = 1000; // a soft publish that found render.lock busy tries again after this
const SOFT_FAIL_MS = 30_000; // ... and only after failing this long is it a `render` error
const SHUTDOWN_STEP_MS = 1200; // bound of each awaited step of session_shutdown (the host allows 2s)
const RPC_CHANNEL = 'senpi:extension-rpc-event';
const pad6 = (n) => String(n).padStart(6, '0');
const slashed = (p) => String(p).replace(/\\/g, '/');

export function isChildSessionFile(file) {
  return typeof file === 'string' && CHILD_SESSION_RE.test(file);
}

export function defaultStateDir(env = process.env) {
  if (env.OMO_BRIEFING_STATE_DIR) return env.OMO_BRIEFING_STATE_DIR;
  // installed at AGENT/briefing/integration/generation-NNNNNN/extension.mjs -> AGENT/briefing/state
  return fileURLToPath(new URL('../../state', import.meta.url));
}

const rowSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    truth: { type: 'string', enum: ['evidence', 'reported', 'unverified'] },
    applied: { type: 'string', enum: ['candidate', 'live', 'none'] },
    evidence: { type: 'string' },
  },
  required: ['text', 'truth', 'applied'],
};
const optionSchema = {
  type: 'object',
  properties: { text: { type: 'string' }, consequence: { type: 'string' } },
  required: ['text', 'consequence'],
};
export const BOARD_QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 100 },
    options: {
      type: 'object', additionalProperties: false, required: ['A', 'B'],
      properties: Object.fromEntries(['A', 'B', 'C'].map((key) => [key, {
        ...optionSchema, additionalProperties: false,
        properties: { text: { type: 'string', minLength: 1, maxLength: 60 }, consequence: { type: 'string', minLength: 1, maxLength: 80 } },
      }])),
    },
    recommend: { type: 'string', enum: ['A', 'B', 'C'] },
    reason: { type: 'string', minLength: 1, maxLength: 100 },
    blocks: { type: 'boolean' },
    timeoutMinutes: { type: 'number', exclusiveMinimum: 0, maximum: 120, default: 30 },
  },
  required: ['question', 'options', 'recommend', 'reason', 'blocks'],
};
export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    status: { type: 'string', enum: ['in_progress', 'blocked', 'needs_decision', 'done'] },
    headline: { type: 'string' },
    changes: { type: 'array', items: rowSchema },
    done: { type: 'array', items: rowSchema },
    next: { type: 'string' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          state: { type: 'string', enum: ['open', 'answered'] },
          answer: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'object', properties: { A: optionSchema, B: optionSchema, C: optionSchema } },
          recommend: { type: 'string', enum: ['A', 'B', 'C'] },
          reason: { type: 'string' },
          blocks: { type: 'boolean' },
          fields: DECISION_FIELDS_SCHEMA,
        },
        required: ['question', 'reason', 'blocks'],
        oneOf: [{ required: ['options', 'recommend'], not: { required: ['fields'] } },
          { required: ['fields'], not: { anyOf: [{ required: ['options'] }, { required: ['recommend'] }] } }],
      },
    },
    close_decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'number' }, reason: { type: 'string', enum: ['superseded', 'withdrawn'] } },
        required: ['id', 'reason'],
      },
    },
    flow: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          state: { type: 'string', enum: ['done', 'doing', 'todo', 'blocked'] },
        },
        required: ['label', 'state'],
      },
    },
    reports: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          decision: { type: 'number' },
          decisionIndex: { type: 'number' },
          blocks: REPORT_BLOCK_SCHEMA,
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, alt: { type: 'string' }, option: { type: 'string', enum: ['A', 'B', 'C'] } },
              required: ['path', 'alt'],
            },
          },
        },
        required: ['id', 'title', 'images'],
      },
    },
  },
  required: ['title', 'status', 'headline'],
};

const BRIEF_DESCRIPTION = [
  '상황판(브라우저 페이지)을 갱신하는 보고 도구. HTML은 코드가 만든다. 도구를 쓴 턴은 마지막 답 전에 한 번 호출한다.',
  '한도(유니코드 글자 수): title 1..40, headline 1..100(목표 달성 기준 한 문장), next 0..100, changes 0..8개·done 0..12개(text 1..100),',
  'decisions 0..4개(question 1..100, options A·B(·C){text 1..60, consequence 1..80}, recommend, reason 1..100, blocks),',
  '입력 결정은 options·recommend 대신 decisions[].fields를 쓴다. id는 고유하며 숫자는 유한한 min<=max, 양수 step을 쓴다. 값은 상황판에서 확인 후 전송하며 /decide는 상황판 링크를 안내한다.',
  `decisions[].fields: ${JSON.stringify(DECISION_FIELDS_SCHEMA)}`,
  '질문 도구에서 받은 답은 state: answered, answer: 답 내용(1..500)으로 기록한다. state 생략은 open.',
  'close_decisions {id, reason: superseded|withdrawn}, flow 0..8개(label 1..20, state).',
  'reports 0..3개(id a-z0-9_- 1..64, title 1..80, summary 0..1000, decision(열린 결정 번호) 또는 decisionIndex(이번 decisions[] 위치 0..3) 중 하나,',
  '  images 0..6개{path: C:/ 절대경로 PNG·JPEG·WebP ≤8MiB ≤8192px, alt 1..200, option A|B|C(연결된 결정의 선택지)}). 생략하면 이전 보고서 유지, []는 비움.',
  '표·그래프는 brief.reports[].blocks에 다음 JSON Schema로 넣는다. table의 행은 열 수와 같고, checklist id는 보고서 안에서 고유하며, compare는 열린 decision 또는 이번 decisions[]의 decisionIndex로 연결한다.',
  `brief.reports[].blocks: ${JSON.stringify(REPORT_BLOCK_SCHEMA)}`,
  '블록은 데이터만 받음: HTML·마크다운·URL·스타일은 텍스트 값으로만 보존하며 실행·변환하지 않음. 알 수 없는 필드와 한도 초과는 잘라내지 않고 정확한 경로로 거절.',
  '각 changes/done 항목에는 truth(evidence|reported|unverified)와 applied(candidate|live|none)가 반드시 있다.',
  'truth=evidence는 C:/ 로 시작하는 절대경로 evidence가 있을 때만. 기존 열린 결정을 유지하려면 decisions[].id에 번호를 넣는다.',
  '한도를 넘으면 거절되고 필드명과 한도가 돌아오니 줄여서 다시 호출한다.',
].join('\n');

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
};

// Text fallback (used only when the result carries no structured details). Within the window after the id the
// explicit `status:x` field wins, then the `now x` of a cancel notice (its `was x` is the OLD status), then the
// first status word.
function statusAfter(text, id) {
  const at = text.indexOf(id);
  const window = at >= 0 ? text.slice(at, at + 120) : '';
  const m = STATUS_FIELD_RE.exec(window) ?? STATUS_NOW_RE.exec(window) ?? STATUS_RE.exec(window);
  return m ? normalizeStatus(m[1]) : null;
}

/**
 * Current worker statuses from structured tool details: `task` {task_id,status,items[]}, `task_output`
 * {task_id,status}, `task_cancel` {kind,task_id,previous_status?,status?} (previous_status is never the current
 * state), and wake messages whose details nest {details:[{task_id,status}]}. Returns Map id -> status.
 */
function detailStatuses(details, out = new Map(), depth = 0) {
  if (details === null || typeof details !== 'object' || depth > 4) return out;
  if (Array.isArray(details)) {
    for (const d of details) detailStatuses(d, out, depth + 1);
    return out;
  }
  const id = details.task_id;
  if (typeof id === 'string' && WORKER_ID_ONE_RE.test(id)) {
    const raw = typeof details.status === 'string' ? details.status : details.kind === 'cancelled' ? 'cancelled' : undefined;
    const m = raw === undefined ? null : STATUS_RE.exec(raw);
    if (m && m[0].length === raw.length) out.set(id, normalizeStatus(m[1]));
  }
  detailStatuses(details.items, out, depth + 1);
  detailStatuses(details.details, out, depth + 1);
  return out;
}

function normalizeStatus(word) {
  const w = word.toLowerCase();
  if (w === 'failed' || w === 'timeout') return 'error';
  if (w === 'canceled') return 'cancelled';
  return w;
}

function freshRun() {
  return { started: false, toolUsed: false, appended: false, lastAssistantText: '' };
}

/**
 * @param {{
 *   env?: object, now?: () => number, stateDir?: string, fs?: object, readFile?: (p:string)=>string,
 *   execFile?: Function, execFileSync?: Function, openPage?: Function, exists?: (p:string)=>boolean,
 *   createDeliverer?: Function, createMirror?: Function,
 * }} [opts] test seams; the installed shim uses the defaults
 */
export function createBriefingExtension(opts = {}) {
  return function extension(pi) {
    // Only the interactive, lead kind may run at all (DOCS extensions.md, sessionKind). Workers register nothing.
    if (pi.sessionKind !== 'interactive') return;

    const env = opts.env ?? process.env;
    const nowFn = opts.now ?? Date.now;
    const fsImpl = opts.fs ?? nodeFs;
    const readFile = opts.readFile ?? ((p) => fsImpl.readFileSync(p, 'utf8'));
    const exec = opts.execFile ?? nodeExecFile;
    const execSync = opts.execFileSync ?? nodeExecFileSync;
    const exists = opts.exists ?? ((p) => fsImpl.existsSync(p));
    const open = opts.openPage ?? openPage;
    const makeDeliverer = opts.createDeliverer ?? deliverMod.createDeliverer;
    const makeMirror = opts.createMirror ?? mirrorMod.createMirror;
    const generation = opts.generation !== undefined ? opts.generation : OWN_GENERATION;
    const installedGeneration = opts.installedFile || Number.isInteger(OWN_GENERATION)
      ? () => readInstalledGeneration(opts.installedFile ?? fileURLToPath(new URL('../../current.json', import.meta.url)), nodeFs.promises)
      : async () => null;
    const timers = opts.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    const unref = (h) => { if (h && typeof h.unref === 'function') h.unref(); return h; };
    // The installed shim never injects a state folder. A test or QA run that does gets no board server (so unit tests never
    // open ports) unless it asks for one with `server: true`.
    const serverOn = opts.server !== undefined ? opts.server === true : opts.stateDir === undefined;

    let active = false;
    let registered = false;
    let store = null;
    let stateDir = null;
    let pagePath = null;
    let sid = null;
    let meta = null;
    let lastCtx = null;
    let deliverer = null;
    let mirror = null;
    let askBridge = null;
    let run = freshRun();
    const autoCache = {};
    const recordCache = {}; // /brief task-record reads: one cache for the lifetime of this extension instance (60s TTL in collectAuto)
    const notified = new Set();
    let host = null; // board server host (src/server-host.mjs), lead sessions only
    // the address handed to the owner: the live board url when a server is up (owned or another conversation's), else the file page
    const boardLink = () => (host && host.status().url) || pagePath;
    let workersLive = null; // live worker rows from the task bus (src/workers-live.mjs)
    let planTool = null; // plan_brief (src/plan-tool.mjs), rebuilt per session id
    let rpcOff = null; // unsubscribe of the one task-bus subscription
    let earlyRpc = null; // newest task snapshot that arrived before the session existed
    let shuttingDown = false;
    let shutdownDirty = false; // an error was recorded while shutting down: one soft publish shows it
    let ensuring = false; // session_start brings the server up before its first publish: that publish already knows the address
    let softTimer = null;
    let softBusySince = null;
    let inflight = null; // the running publish
    let queued = null; // the one publish waiting behind it
    let queuedSoft = true;
    let renderUnshown = false; // the recorded `render` error is one whose chip no published page has shown yet

    const say = (ctx, text, level = 'info') => {
      const ui = (ctx && ctx.ui) || (lastCtx && lastCtx.ui);
      if (ui && typeof ui.notify === 'function') ui.notify(text, level);
    };

    // The one place the settings file is read for a pause decision. A failed read is recorded as the 'settings' error in the same
    // operation (never silent) and reads as {known:false, on:false}: unreadable = stay paused, never silently enable. A read that
    // works clears that source's own entry and nothing else. `inPublish`: the caller runs inside a publish (render.lock held),
    // which must not start another one, so the outcome is parked in `settingsNote` and finishRefresh records it after the publish.
    let settingsNote = null; // {err} | {ok: true}
    function settingsState(inPublish = false) {
      let on;
      try {
        on = store.readSettings().enabled !== false;
      } catch (err) {
        if (inPublish) settingsNote = { err }; else recordError('settings', err);
        return { known: false, on: false };
      }
      if (inPublish) settingsNote = { ok: true };
      else if (meta && 'settings' in errorsOf(meta)) settle('settings'); // settings read again: this source's own success
      return { known: true, on };
    }
    function flushSettingsNote() {
      const note = settingsNote;
      settingsNote = null;
      if (!note) return;
      if (note.err) recordError('settings', note.err);
      else if (meta && 'settings' in errorsOf(meta)) settle('settings'); // parked success
    }
    const enabled = () => settingsState().on;

    // server.json as the board model reads it (the render publish and the board server's own model). A read that failed (unreadable,
    // or over the size limit) is recorded under its own key; a good read or an absent file clears only that key. Nothing is recorded
    // while the board is off. Inside a publish (render.lock held) the outcome is parked and flushServerNote records it after the
    // publish, like the settings one. Returns whether the error entry changed.
    const SERVER_RECORD_KEY = 'server:record';
    let serverNote = null; // the server info the last publish saw
    function noteServerRecord(info) {
      if (!active || !meta || shuttingDown) return false;
      const had = SERVER_RECORD_KEY in errorsOf(meta);
      if (!info.error && !had) return false;
      if (pausedNow()) return false;
      if (info.error) recordError(SERVER_RECORD_KEY, new Error(info.message));
      else settle(SERVER_RECORD_KEY);
      return had !== (SERVER_RECORD_KEY in errorsOf(meta));
    }
    function flushServerNote() {
      const info = serverNote;
      serverNote = null;
      if (info) noteServerRecord(info);
    }

    function saveMeta() {
      store.replace(`sessions/${sid}/meta.json`, meta);
    }

    // herdr tab label/number for the board's card names (src/herdr-tab.mjs). Fire and forget: a failure (not herdr, herdr
    // missing, timeout) keeps the prior values; a change is saved and shown by one soft publish.
    function refreshTab() {
      const forSid = sid;
      return readTab({ env, execFile: exec }).then((tab) => {
        if (!tab || !active || !meta || sid !== forSid) return;
        if (meta.tabLabel === tab.tabLabel && meta.tabNumber === tab.tabNumber) return;
        meta.tabLabel = tab.tabLabel;
        meta.tabNumber = tab.tabNumber;
        try { saveMeta(); } catch (err) { recordError('meta', err); return; }
        void softPublish();
      });
    }

    // Errors are kept per source in meta.errors (src/errors.mjs). A source records its own error and clears only its own
    // entry; each change is saved and followed by exactly one publish, so the page always matches meta.
    function recordError(source, err) {
      if (!meta) return;
      if (!setError(meta, source, `${source}: ${err && err.message ? err.message : String(err)}`, nowFn())) return; // same message already shown
      try { saveMeta(); } catch { /* the failure above is already kept in memory; nothing more can be written */ }
      if (shuttingDown) shutdownDirty = true;
      refreshSoon(shuttingDown); // never rejects: a failed publish is recorded as the `render` source
    }

    function settle(source) {
      if (!meta || !clearError(meta, source)) return;
      try { saveMeta(); } catch { /* kept in memory */ }
      refreshSoon(shuttingDown);
    }

    // the owner switched the board off (/brief off). An unreadable settings file is NOT a pause here (its error chip still has
    // to go out) but settingsState records it as the 'settings' error, like everywhere else the file is read.
    const pausedNow = (inPublish = false) => {
      const state = settingsState(inPublish);
      return state.known && !state.on;
    };
    const pausedResult = () => ({ ok: false, paused: true, seqs: [], error: '브리핑이 꺼져 있어 게시하지 않았습니다' });
    // error/recover of the server host and workers-live: nothing is written or published while the board is off
    const hostError = (key, err) => { if (!pausedNow()) recordError(key, err); };
    const hostRecover = (key) => { if (!pausedNow()) settle(key); };

    // Publishes wait for a busy render.lock with an awaited timer (never blocks the terminal); `soft` takes the lock once.
    function publish(soft) {
      return renderPageMaybe(store, nowFn(), {
        generation,
        ...(opts.renderOpts ?? {}),
        sessionId: sid,
        canPublish: () => !pausedNow(true),
        onServerInfo: (info) => { serverNote = info; },
        soft: soft === true || shuttingDown,
        pendingDeliveries: deliverer && typeof deliverer.pendingIds === 'function' ? deliverer.pendingIds() : [],
      });
    }

    // One publish. Only the render source's own entry is touched: a previous render failure is cleared BEFORE publishing (so a
    // good page carries no stale chip) and re-recorded if this publish fails too. Errors of other sources stay as they are.
    const failedPublish = (err) => ({ ok: false, seqs: [], error: `게시 실패: ${err && err.message ? err.message : String(err)}` });

    // Bookkeeping after a publish finished: record/clear the `render` source, tell the board server.
    function finishRefresh(res, clearFirst) {
      if (res.busy || res.paused) {
        // soft publish: the lock was busy and nothing was recorded or changed; paused: nothing was written at all
      } else if (!res.ok) {
        // unshown: nothing reached the page (lock never taken), so the chip can only appear on the NEXT publish that gets through
        renderUnshown = res.unshown === true;
        setError(meta, 'render', res.error, nowFn());
        saveMeta();
      } else {
        renderUnshown = false;
        if (!clearFirst && clearError(meta, 'render')) {
          saveMeta();
          void softPublish(); // the page that just went out showed the old chip once; this one is clean
        }
        if (host) host.notifyPublished(); // the board server rebuilds its view and pushes it to open pages
      }
      flushSettingsNote(); // a pause check inside this publish read the settings file: record/clear the 'settings' source now
      flushServerNote(); // the publish read server.json: record a failed read / clear the 'server:record' source now
      return res;
    }

    // One publish at a time; a request that arrives meanwhile shares ONE follow-up publish (hard if any requester was hard).
    // A free render.lock means the publish finishes inside this very call (nothing is "in flight"); only a busy lock makes it
    // wait on an awaited timer. The promise never rejects.
    function refresh(soft = false) {
      if (!inflight) {
        const hadError = Boolean(meta.errors && meta.errors.render);
        // A hard publish clears a previous `render` error first (so a good page carries no stale chip). A soft publish that
        // may find the lock busy keeps it until a publish really got through.
        // ... and a hard publish keeps one that never reached the page, so that the next publish shows it once.
        const clearFirst = !hadError || (!soft && !renderUnshown);
        if (clearFirst && clearError(meta, 'render')) saveMeta();
        let out;
        try { out = publish(soft); } catch (err) { out = failedPublish(err); }
        if (out && typeof out.then === 'function') {
          inflight = out
            .then((r) => r, failedPublish)
            .then((r) => finishRefresh(r, clearFirst))
            .finally(() => { inflight = null; });
          return inflight;
        }
        return Promise.resolve(finishRefresh(out, clearFirst));
      }
      if (!queued) {
        queuedSoft = soft;
        queued = inflight.then(() => {
          queued = null;
          if (pausedNow()) return pausedResult(); // /brief off came while this one waited: it is dropped, not run
          return refresh(queuedSoft);
        });
      } else {
        queuedSoft = queuedSoft && soft;
      }
      return queued;
    }
    // Synchronous contexts do not wait for the publish; its failure is recorded by doRefresh itself.
    function refreshSoon(soft = false) { void refresh(soft); }

    // Worker-driven publishes (rows, todos, status): take render.lock once; retry later; a `render` error only after 30s.
    async function softPublish() {
      if (!active || !meta || shuttingDown || !enabled()) return;
      const res = await refresh(true);
      if (res.ok || !res.busy) { softBusySince = null; return; }
      if (!enabled()) return; // paused during the wait: no retry timer, no error entry
      const t = nowFn();
      if (softBusySince === null) softBusySince = t;
      if (t - softBusySince > SOFT_FAIL_MS && setError(meta, 'render', res.error, t)) saveMeta(); // shown by the next publish that gets through
      if (!softTimer) {
        softTimer = unref(timers.setTimeout(() => { softTimer = null; void softPublish(); }, opts.softRetryMs ?? SOFT_RETRY_MS));
      }
    }

    function ensureServer() {
      if (!host) return Promise.resolve(null);
      return host.ensure().catch((err) => { hostError('server:lock', err); return null; });
    }

    // ---- board write hooks: POST /answer and POST /focus ----
    // src/server.mjs has already checked origin, token and body shape; the host answers 503 while the board is paused. They run
    // in the process that owns the server, so they read other conversations from the store, never from this conversation's meta.
    // Both always settle (the server holds its one write slot until they do), never throw, and the HTTP reply is only ever a
    // bare code. A genuine I/O or herdr failure (not a refusal such as 404/409/400) is recorded like every other source: once,
    // as meta.errors.answer / meta.errors.focus (chip on the board, detail in meta.json only, cleared by that source's next
    // success). The page token never reaches these hooks; the request body carries no secret.
    const BOARD_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
    const TAB_ID = /^w\d+:t[0-9A-Za-z]+$/;
    const ANSWER_STATUS = { NOT_FOUND: 404, SESSION_MISMATCH: 409, CLOSED: 409, HELD: 409, ANSWERED: 409, BAD_OPTION: 400, BAD_TEXT: 400, BAD_VALUES: 400, BAD_REQUEST: 400, NO_ANNOTATION_SUPPORT: 409, REQUEST_ID_CONFLICT: 409, IO_ERROR: 500 };
    const FOCUS_TIMEOUT_MS = 3000;
    const FOCUS_GUARD_MS = 4000; // the reply is sent even if execFile never calls back
    const boardReply = (status, code) => ({ status, json: code ? { ok: false, code } : { ok: true } });
    const clip = (text) => String(text).slice(0, 300);
    // why an execFile call failed: killed by its timeout, else the errno string (ENOENT) or the child's exit code
    const reasonOf = (err) => (err && err.killed ? 'TIMEOUT' : err && err.code !== undefined && err.code !== null ? err.code : 'ERROR');
    const messageOf = (err) => clip(err && err.message ? err.message : err);
    const answerFault = (body, detail) => {
      hostError('answer', new Error(`상황판 답 기록 실패(#${body.id ?? `a-${body.requestId}`}, IO_ERROR)${detail ? `: ${clip(detail)}` : ''}`));
      return boardReply(500, 'IO_ERROR');
    };

    // sessions/<sid>/meta.json of any conversation: null when absent or when the id is not a plain id; throws on a read fault
    const metaOf = (sessionId) => (BOARD_SESSION_ID.test(sessionId) ? store.readRecord(`sessions/${sessionId}/meta.json`) : null);

    function boardAnswer(body) {
      const annotation = body.kind === 'annotation';
      if (annotation || body.text !== undefined) {
        // free text only for a conversation that says it can take it (a meta from before that capability has no answerKinds)
        let target;
        try { target = metaOf(body.sessionId); } catch (err) { return answerFault(body, messageOf(err)); }
        const kind = annotation ? 'annotation' : 'text';
        if (!target || !Array.isArray(target.answerKinds) || !target.answerKinds.includes(kind)) {
          return boardReply(409, annotation ? 'NO_ANNOTATION_SUPPORT' : 'NO_TEXT_SUPPORT');
        }
      }
      const res = annotation ? applyBoardAnnotation(store, body, nowFn()) : applyBoardAnswer(store, body, nowFn());
      if (res.ok) {
        hostRecover('answer');
        if (active && !shuttingDown) refreshSoon(false); // open pages see the answer state through this publish
        return { status: 200, json: annotation ? res : { ok: true, id: body.id } };
      }
      // `detail` (log-only, may hold a file path) goes to the recorded diagnostic, never into the reply
      if (res.code === 'IO_ERROR' || ANSWER_STATUS[res.code] === undefined) return answerFault(body, res.detail);
      if (res.code === 'BAD_VALUES') return { status: 400, json: { ok: false, code: res.code, fieldErrors: res.fieldErrors } };
      return boardReply(ANSWER_STATUS[res.code], res.code);
    }

    function boardFocus(body) {
      let target;
      try {
        target = metaOf(body.sessionId);
      } catch (err) {
        hostError('focus', new Error(`상황판 창 이동 실패(대화 ${body.sessionId}, IO_ERROR): ${messageOf(err)}`));
        return boardReply(500, 'IO_ERROR');
      }
      const tabId = target && typeof target.tabId === 'string' ? target.tabId : '';
      if (!TAB_ID.test(tabId)) return boardReply(404, 'NOT_FOUND'); // nothing reaches herdr with an id of any other shape
      return new Promise((resolve) => {
        let done = false;
        let guard = null;
        // The reply goes out first (the server's write slot is held until it does); the first outcome wins and is recorded once.
        const finish = (err) => {
          if (done) return;
          done = true;
          timers.clearTimeout(guard);
          resolve(err ? boardReply(502, 'HERDR_FAILED') : boardReply(200));
          if (err) hostError('focus', new Error(`herdr tab focus 실패(대화 ${body.sessionId}, ${reasonOf(err)}): ${messageOf(err)}`));
          else hostRecover('focus');
        };
        guard = unref(timers.setTimeout(() => finish(Object.assign(new Error(`${FOCUS_GUARD_MS}ms 안에 응답이 없음`), { code: 'TIMEOUT' })), FOCUS_GUARD_MS));
        try {
          exec(herdrBin(env), ['tab', 'focus', tabId], { timeout: FOCUS_TIMEOUT_MS, windowsHide: true }, (err) => finish(err || null));
        } catch (err) {
          finish(err || new Error('herdr 실행 실패')); // a synchronous spawn failure is the same as herdr missing
        }
      });
    }

    function boardProfiles(body) {
      // The store owns every read/write and resolves target ids itself; this hook only
      // returns the board's {status, json} envelope. It never throws.
      try {
        return profilesStore.handle(body);
      } catch (err) {
        hostError('profiles', err);
        return boardReply(500, 'IO_ERROR');
      }
    }

    function boardProfilesState() {
      return profilesStore.state();
    }

    function collect(ctx, { readTaskRecords = false, cache = autoCache } = {}) {
      let branch = [];
      try { branch = ctx.sessionManager.getBranch(); } catch { branch = []; }
      const next = collectAuto({
        cwd: ctx.cwd,
        sessionId: sid,
        branchEntries: branch,
        workerIds: meta.workerIds,
        metaWorkers: meta.workers,
        readTaskRecords,
        readFile,
        now: nowFn(),
        cache,
      });
      // live worker rows are kept by workers-live in meta.auto.live; a fresh collection must not erase them
      if (meta.auto && meta.auto.live) next.live = meta.auto.live;
      return next;
    }

    const guarded = (where, fn) => async (event, ctx) => {
      if (ctx) lastCtx = ctx;
      try {
        const out = await fn(event, ctx);
        guardedOk(where);
        return out;
      } catch (err) {
        recordError(where, err);
        return undefined;
      }
    };
    // a handler's own later success clears only that handler's entry
    const guardedOk = (where) => { if (meta && where in errorsOf(meta)) settle(where); };

    // ---- workers (from `task` tool results and completion notices) ----
    function noteWorkers(toolName, text, isError, details) {
      const structured = detailStatuses(details);
      const ids = [...new Set([...(text.match(WORKER_ID_RE) ?? []), ...structured.keys()])];
      if (ids.length === 0) return false;
      const starts = TASK_TOOL_RE.test(toolName);
      const noted = [];
      let changed = false;
      for (const id of ids) {
        const known = meta.workers.find((w) => w.id === id);
        if (!known && !starts) continue;
        const status = structured.get(id) ?? (isError ? 'error' : statusAfter(text, id) ?? (starts ? 'running' : null));
        if (status === null) continue;
        if (known) {
          if (known.status !== status) { known.status = status; changed = true; }
        } else {
          meta.workers.push({ id, status });
          changed = true;
        }
        if (!meta.workerIds.includes(id)) { meta.workerIds.push(id); changed = true; }
        noted.push(id);
      }
      // workers without a task-bus snapshot yet show as 'waiting for information' rows
      if (workersLive && noted.length > 0) workersLive.noteTaskIds(noted);
      if (meta.workers.length > WORKERS_MAX) meta.workers.splice(0, meta.workers.length - WORKERS_MAX);
      if (meta.workerIds.length > WORKERS_MAX) meta.workerIds.splice(0, meta.workerIds.length - WORKERS_MAX);
      return changed;
    }

    function noteNotice(text, details) {
      const structured = detailStatuses(details);
      let changed = false;
      for (const w of meta.workers) {
        if (!text.includes(w.id) && !structured.has(w.id)) continue;
        const status = structured.get(w.id) ?? statusAfter(text, w.id);
        if (status && status !== w.status) { w.status = status; changed = true; }
      }
      return changed;
    }

    // ---- blocks=true notification: herdr CLI when usable, else ctx.ui.notify ----
    const HERDR_TIMEOUT_MS = 3000;
    // Every herdr call is asynchronous, gets an argument array (never a shell string) and a 3000 ms bound; the error is
    // resolved, never rejected, so a hung or failing herdr cannot throw into the conversation.
    function herdrCall(herdr, args) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (err) => { if (!done) { done = true; resolve(err || null); } };
        try {
          exec(herdr, args, { timeout: HERDR_TIMEOUT_MS, windowsHide: true }, (err) => finish(err || null));
        } catch (err) {
          finish(err || new Error('herdr 실행 실패')); // a synchronous spawn failure is the same as herdr missing
        }
      });
    }
    function notifyDecision(ctx, d) {
      if (notified.has(d.id)) return;
      notified.add(d.id);
      const title = `결정 #${d.id} 필요: ${d.question}`;
      const body = `상황판 - ${meta.project || ''} /decide ${d.id}${d.recommend}`;
      const herdr = env.HERDR_BIN_PATH;
      const fallback = () => say(ctx, `${title} (${body})`, 'warning');
      if (!herdr || !exists(herdr)) { fallback(); return; }
      // Probe first: an older herdr without `notification` must fall back instead of printing its own error. Both calls
      // stay off the conversation's critical path; whichever of the two fails (or times out) falls back once.
      herdrCall(herdr, ['notification', '--help'])
        .then((err) => (err ? err : herdrCall(herdr, ['notification', 'show', title, '--body', body, '--sound', 'request'])))
        .then((err) => { if (err) fallback(); });
    }

    // ---- brief tool ----
    async function executeBrief(_id, params, _signal, _onUpdate, tctx) {
      const ctx = tctx ?? lastCtx;
      if (!active || !store) throw new Error('브리핑이 이 세션에서 준비되지 않았습니다.');
      if (!enabled()) return { content: [{ type: 'text', text: '브리핑이 꺼져 있습니다(/brief on 으로 켤 수 있음). 이번 보고는 저장하지 않았습니다.' }], details: { disabled: true } };
      const input = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : params;
      if (input && typeof input === 'object') {
        if (input.next === undefined) input.next = '';
        for (const k of ['changes', 'done', 'decisions']) if (input[k] === undefined) input[k] = [];
      }
      const v = validateBrief(input, {
        fileExists: (p) => { try { return fsImpl.statSync(p).isFile(); } catch { return false; } },
        stat: (p) => fsImpl.statSync(p),
        sha256: (p) => createHash('sha256').update(fsImpl.readFileSync(p)).digest('hex'),
        decisionOwner: (id) => {
          const rec = store.readRecord(`decisions/${pad6(id)}.json`);
          return rec && typeof rec.sessionId === 'string' ? rec.sessionId : null;
        },
        decisionOpen: (id) => !store.readRecord(`decision-closures/${pad6(id)}.json`) && !store.readRecord(`answers/${pad6(id)}.json`),
        decisionOptions: (id) => {
          const o = store.readRecord(`decisions/${pad6(id)}.json`)?.options;
          return o && typeof o === 'object' ? ['A', 'B', 'C'].filter((k) => o[k] !== undefined) : null;
        },
        sessionId: sid,
      });
      const refuse = (errors) => new Error(`brief 입력 거절(저장하지 않음) - 아래를 고쳐 다시 호출:\n${errors.map((e) => `- ${e}`).join('\n')}`);
      if (!v.ok) throw refuse(v.errors);
      const t = nowFn();
      const brief = v.normalized;
      // Report images are read and stored before anything else is written: a refused file refuses the whole brief.
      const imported = new Map(); // `${i}.${j}` -> importImage result
      if (brief.reports !== undefined) {
        const imageErrors = [];
        brief.reports.forEach((r, i) => r.images.forEach((img, j) => {
          const got = importImage(stateDir, img.path, { fs: fsImpl, now: () => t });
          if (got.error) imageErrors.push(`reports[${i}].images[${j}].path: ${got.error}`);
          else imported.set(`${i}.${j}`, got);
        }));
        if (imageErrors.length) throw refuse(imageErrors);
      }
      if (brief.decisions.some((d) => d.id === undefined && d.state !== 'answered')
        && (store.readRecord(`mirror/${sid}.json`)?.open === true || meta.askLive.length > 0)) {
        throw new Error('질문창이 열려 있음: 결정은 답을 받은 뒤 answered로 넣기');
      }
      const created = [];
      for (const d of brief.decisions) {
        if (d.id === undefined) {
          d.id = store.allocDecisionId({
            sessionId: sid, question: d.question, options: d.options, recommend: d.recommend,
            reason: d.reason, blocks: d.blocks, createdAt: t, source: 'brief',
            ...(d.fields !== undefined ? { fields: d.fields } : {}),
          });
          if (d.state !== 'answered') created.push(d);
        }
        if (d.state === 'answered') {
          try {
            store.writeNew(`decision-closures/${pad6(d.id)}.json`, { id: d.id, reason: 'answered', answer: d.answer, at: t });
          } catch (err) { if (err.code !== 'EEXIST') throw err; }
        }
      }
      for (const c of brief.close_decisions ?? []) {
        try {
          store.writeNew(`decision-closures/${pad6(c.id)}.json`, { id: c.id, reason: c.reason, at: t });
        } catch (err) {
          if (err.code !== 'EEXIST') throw err; // already closed: nothing to add
        }
      }
      let reportWarning = null;
      if (brief.reports !== undefined) {
        const snapshot = brief.reports.map((r, i) => ({
          id: r.id,
          title: r.title,
          summary: r.summary ?? '',
          decisionId: r.decision ?? (r.decisionIndex !== undefined ? brief.decisions[r.decisionIndex].id : null),
          at: t,
          ...(r.blocks !== undefined ? { blocks: r.blocks.map((b) => {
            if (b.kind !== 'compare' || b.decisionIndex === undefined) return b;
            const { decisionIndex, ...block } = b;
            return { ...block, decision: brief.decisions[decisionIndex].id };
          }) } : {}),
          images: r.images.map((img, j) => {
            const a = imported.get(`${i}.${j}`);
            return { sha: a.sha, ext: a.ext, mime: a.mime, bytes: a.bytes, w: a.w, h: a.h, path: img.path, alt: img.alt, option: img.option ?? null };
          }),
        }));
        store.replace(`sessions/${sid}/reports.json`, snapshot);
        try {
          gcAssets(stateDir, t, { fs: fsImpl });
        } catch (err) {
          reportWarning = `그림 정리 실패(보고서는 저장됨): ${err.code || err.message}`;
        }
      }
      let seq = store.nextBriefSeq(sid);
      for (let attempt = 0; ; attempt++) {
        try {
          store.writeNew(`sessions/${sid}/briefs/${pad6(seq)}.json`, { at: t, seq, brief });
          break;
        } catch (err) {
          if (err.code !== 'EEXIST' || attempt >= 5) throw err;
          seq++;
        }
      }
      meta.lastBriefAt = t;
      meta.lastActivityAt = t;
      meta.turnBriefed = true;
      meta.noReport = false;
      delete meta.autoSummary;
      meta.title = brief.title;
      try { meta.auto = collect(ctx); clearError(meta, 'collect'); } catch (err) { setError(meta, 'collect', `collect: ${err.message}`, t); }
      saveMeta();
      void refreshTab();
      const res = await refresh();
      for (const d of created) if (d.blocks) notifyDecision(ctx, d);

      const newText = created.length ? ` (새 결정 ${created.map((d) => `#${d.id}`).join(', ')})` : '';
      // Success wording only when the page really was published.
      const lines = [res.ok
        ? `상황판 갱신됨: ${boardLink()}${newText}`
        : `보고는 저장됐지만 상황판은 갱신되지 못함${newText}: ${res.error}`];
      for (const w of v.warnings) lines.push(`경고: ${w}`);
      if (reportWarning) lines.push(`경고: ${reportWarning}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { seq, newDecisionIds: created.map((d) => d.id), pagePath } };
    }

    // ---- commands ----
    async function briefCommand(args, cctx) {
      const arg = String(args ?? '').trim();
      if (arg === 'off' || arg === 'on') {
        store.writeSettings({ ...store.readSettings(), enabled: arg === 'on' });
        if (arg === 'on') {
          if (workersLive) workersLive.resume(); // settings.json says on now: the worker timers are armed again
          await refresh();
          await ensureServer();
        } else {
          // pause is global: soft-publish retries stop and the board server tells its pages, closes and lets go of its lock
          if (softTimer) { timers.clearTimeout(softTimer); softTimer = null; }
          softBusySince = null;
          if (workersLive) workersLive.pause(); // no worker timer is kept while the board is off
          if (host) await host.onPaused();
        }
        say(cctx, arg === 'on' ? '브리핑 켜짐: 규칙 주입·자동 갱신·전달 재개' : '브리핑 꺼짐: 규칙 주입·자동 갱신·전달 중지 (/brief on 으로 켜기)');
        return;
      }
      if (arg === 'path') {
        say(cctx, `STATE: ${slashed(stateDir)}\n상황판: ${pagePath}`);
        return;
      }
      if (arg !== '') {
        say(cctx, '사용법: /brief | /brief on | /brief off | /brief path', 'warning');
        return;
      }
      meta.auto = collect(cctx, { readTaskRecords: true, cache: recordCache }); // the only path that reads senpi-task records
      clearError(meta, 'collect');
      saveMeta();
      // The plan overlay (status.json + chips: 60s cache, nothing at all while paused) is recomputed BEFORE the file page and the
      // board server's model are built, so a plain /brief shows the plan as it is now without an agent_settled or plan_brief call.
      if (planTool) await planTool.onSettled(); // plain /brief: the plan overlay first
      const res = await refresh();
      if (!res.ok) say(cctx, `상황판 갱신 실패: ${res.error}`, 'error');
      // the live address when a healthy board server exists (this or another conversation owns it), else the file page
      const served = await ensureServer();
      const target = served && served.url ? served.url : pagePath;
      try {
        open(target, { onError: (e) => say(cctx, `상황판 열기 실패: ${e.message} (직접 여세요: ${target})`, 'error') });
        say(cctx, served && served.url ? `상황판(실시간): ${target}` : `상황판: ${pagePath} (실시간 서버 없음 - 오류 표시를 확인하세요)`);
      } catch (err) {
        say(cctx, err.message, 'warning');
      }
    }

    async function decideCommand(args, cctx) {
      const text = String(args ?? '').trim();
      if (text === '') {
        say(cctx, '사용법: /decide 12A 13B (번호만 쓰면 추천안)', 'warning');
        return;
      }
      const result = applyDecide(store, text, sid, nowFn());
      let line = formatDecideResult(result);
      if (result.errors.some(e => e.code === 'FIELDS_REQUIRED')) {
        const served = await ensureServer();
        line += ` - 상황판: ${served?.url || pagePath}`;
      }
      // the decide source: read errors set its entry, a command without any clears it; saved before the one publish
      const readErrors = result.readErrors ?? [];
      const changed = readErrors.length > 0
        ? setError(meta, 'decide', `decide: ${readErrors.map((e) => `#${e.id} ${e.message}`).join('; ')}`, nowFn())
        : clearError(meta, 'decide');
      if (changed) saveMeta();
      await refresh();
      say(cctx, line, result.applied.length > 0 && result.errors.length === 0 ? 'info' : 'warning');
      if (deliverer && typeof deliverer.wake === 'function') await deliverer.wake(cctx, 'decide');
    }

    // ---- event handlers (registered once the session passed the lead gate) ----
    function registerHandlers() {
      pi.on('before_agent_start', guarded('before_agent_start', (event) => {
        if (!active || !enabled()) return undefined;
        const next = injectRule(event.systemPrompt);
        return next === event.systemPrompt ? undefined : { systemPrompt: next };
      }), { previewSafe: true });

      pi.on('input', guarded('input', async (event, ctx) => {
        if (!active || !enabled()) return undefined;
        if (event.source !== 'extension') {
          meta.lastOwnerInputAt = nowFn();
          saveMeta();
        }
        if (deliverer && typeof deliverer.wake === 'function') await deliverer.wake(ctx, 'input');
        return undefined;
      }));

      pi.on('agent_start', guarded('agent_start', async (_event, ctx) => {
        if (!active || !enabled()) return;
        // agent_start is a low-level run event: the continuation requested by agent_before_settle emits a NEW one
        // (pi-agent-core agent-loop.js:71, scheduled at SENPI agent-session.js:2417-2425) before the rewritten reply.
        // So the activity state (rewrite/budget/noReport bookkeeping) is initialised only by the first start and
        // cleared only at true settlement (agent_settled, agent-session.js:2426-2428).
        const continuing = run.started;
        run.started = true;
        meta.running = true;
        meta.pid = process.pid;
        if (!continuing) {
          meta.turnDidWork = false;
          meta.turnBriefed = false;
          meta.replyTrimmed = false;
        }
        meta.lastActivityAt = nowFn();
        saveMeta();
        await refresh();
        if (deliverer && typeof deliverer.wake === 'function') await deliverer.wake(ctx, 'agent_start');
      }));

      pi.on('tool_result', guarded('tool_result', (event) => {
        if (!active || !enabled()) return undefined;
        run.toolUsed = true;
        let dirty = false;
        if (!meta.turnDidWork) { meta.turnDidWork = true; dirty = true; }
        const toolName = String(event.toolName ?? '');
        if (TASK_TOOL_RE.test(toolName) || TASK_FOLLOW_RE.test(toolName)) {
          if (noteWorkers(toolName, textOf(event.content), event.isError === true, event.details)) dirty = true;
        }
        if (dirty) saveMeta();
        if (planTool) planTool.onToolResult(event); // remembers plan/draft files this session wrote
        return undefined;
      }));

      pi.on('message_end', guarded('message_end', async (event, ctx) => {
        if (!active || !enabled()) return undefined;
        const m = event.message;
        if (!m || typeof m !== 'object') return undefined;
        if (m.role === 'assistant') {
          const text = assistantText(m);
          if (text) run.lastAssistantText = text;
          if (run.toolUsed && !hasToolCall(m) && replyOverBudget(text, [boardLink(), pagePath])) {
            const fitted = fitReply(text, boardLink());
            let placed = false;
            const content = [];
            for (const b of Array.isArray(m.content) ? m.content : []) {
              if (b && b.type === 'text') {
                if (!placed) { content.push({ type: 'text', text: fitted }); placed = true; }
              } else {
                content.push(b);
              }
            }
            if (!placed) content.push({ type: 'text', text: fitted });
            run.lastAssistantText = fitted;
            run.appended = true;
            meta.replyTrimmed = true;
            saveMeta();
            return { message: { ...m, content } };
          }
        } else if (m.role === 'custom' || m.role === 'user') {
          if (noteNotice(textOf(m.content), m.details)) saveMeta();
        }
        if (deliverer && typeof deliverer.wake === 'function') await deliverer.wake(ctx, 'message_end');
        return undefined;
      }));

      pi.on('agent_before_settle', guarded('agent_before_settle', (event) => {
        if (!active || !enabled() || !run.toolUsed || run.appended) return undefined;
        if (event.outcome !== undefined && event.outcome !== 'completed') return undefined;
        const messages = (event.context && event.context.contextMessages) || [];
        const last = [...messages].reverse().find((m) => m && m.role === 'assistant');
        const text = last ? assistantText(last) : '';
        if (!replyOverBudget(text, [boardLink(), pagePath])) return undefined;
        const entries = Array.isArray(event.entries) ? event.entries : [];
        // The final answer is normally trimmed in place at message_end (which sets run.appended).
        // This is only a fallback for an over-budget final reply that never reached message_end as a
        // trimmable text message: append one fitted pointer reply. No rewrite round-trip, no continuation.
        run.appended = true;
        meta.replyTrimmed = true;
        saveMeta();
        return {
          entries: [...entries, { type: 'custom_message', customType: 'omo-briefing-reply', content: fitReply(text, boardLink()), display: true }],
        };
      }));

      pi.on('agent_settled', guarded('agent_settled', async (_event, ctx) => {
        if (!active || !enabled()) { run = freshRun(); return; }
        meta.running = false;
        delete meta.pid;
        meta.lastActivityAt = nowFn();
        if (meta.turnDidWork && !meta.turnBriefed) {
          meta.noReport = true;
          const found = parseHandoff(run.lastAssistantText);
          meta.autoSummary = found.length > 0 ? found.join('\n') : '요약 없음';
        } else if (meta.turnBriefed) {
          meta.noReport = false;
          delete meta.autoSummary;
        }
        meta.turnDidWork = false;
        meta.turnBriefed = false;
        try { meta.auto = collect(ctx); clearError(meta, 'collect'); } catch (err) { setError(meta, 'collect', `collect: ${err.message}`, nowFn()); }
        run = freshRun();
        saveMeta();
        await refresh();
        if (planTool) await planTool.onSettled(); // plan status + chips (60s cache); it publishes by itself when they changed
        if (deliverer && typeof deliverer.wake === 'function') await deliverer.wake(ctx, 'agent_settled');
      }));

      pi.on('session_shutdown', guarded('session_shutdown', async (event) => {
        if (!active) return;
        // the host allows 2s: every awaited step below is bounded, publishes are soft (one lock attempt)
        shuttingDown = true;
        meta.running = false;
        delete meta.hostPid;
        delete meta.pid;
        saveMeta();
        if (rpcOff) { rpcOff(); rpcOff = null; }
        if (softTimer) { timers.clearTimeout(softTimer); softTimer = null; }
        if (workersLive) { workersLive.stop(); workersLive = null; }
        askBridge?.dispose();
        if (deliverer && typeof deliverer.dispose === 'function') await deliverer.dispose();
        if (mirror && typeof mirror.dispose === 'function') await mirror.dispose();
        if (host) {
          const h = host;
          host = null;
          await within(h.release(event?.reason), SHUTDOWN_STEP_MS);
        }
        // an error recorded while shutting down (lock release, server close) is shown by exactly one more publish
        if (shutdownDirty && enabled()) await within(refresh(true), SHUTDOWN_STEP_MS);
        else if (inflight) await within(inflight, SHUTDOWN_STEP_MS);
        deliverer = null;
        mirror = null;
        planTool = null;
        askBridge = null;
        active = false;
      }));
    }

    function registerSurface() {
      pi.registerTool({
        name: 'brief',
        label: 'Brief',
        description: BRIEF_DESCRIPTION,
        promptSnippet: '상황판(브라우저 페이지)에 이 대화의 보고를 기록하는 도구',
        promptGuidelines: ['Use brief once before the final answer of any turn that used tools; keep the final chat answer short and include the 상황판 absolute path.'],
        parameters: BRIEF_SCHEMA,
        execute: executeBrief,
      });
      pi.registerTool({
        name: 'board_question',
        label: 'Board question',
        description: '상황판과 터미널에서 같은 결정 하나를 묻고 항상 기다린다. 어느 쪽에서 답해도 한 번만 저장하고 둘 다 닫힌다. question 1..100자, options A·B(·C) {text 1..60자, consequence 1..80자}, recommend, reason 1..100자, blocks. timeoutMinutes 기본 30, 최대 120. 질문창이 없으면 상황판 답만 기다린다. 보류는 답이나 기본값이 아니다.',
        parameters: BOARD_QUESTION_SCHEMA,
        execute: (id, params, signal, onUpdate, ctx) => {
          if (!active || !askBridge) throw new Error('브리핑이 이 세션에서 준비되지 않았습니다.');
          if (!enabled()) throw new Error('브리핑이 꺼져 있습니다(/brief on 으로 켤 수 있음).');
          return askBridge.execute(id, params, signal, onUpdate, ctx ?? lastCtx);
        },
      });
      pi.registerCommand('brief', { description: '상황판 열기 | on | off | path', argumentHint: '[on|off|path]', handler: briefCommand });
      pi.registerCommand('decide', { description: '결정에 답하기: /decide 12A 13B (번호만 쓰면 추천안)', argumentHint: '12A 13B', handler: decideCommand });
      // plan_brief is registered once; each session id gets its own plan tool, the registered tool delegates to the current one
      const def = planTool.definition;
      pi.registerTool({
        name: def.name,
        label: def.label,
        description: def.description,
        promptSnippet: def.promptSnippet,
        promptGuidelines: def.promptGuidelines,
        parameters: def.parameters,
        execute: (id, params, ...rest) => {
          if (!active || !planTool) throw new Error('브리핑이 이 세션에서 준비되지 않았습니다.');
          return planTool.definition.execute(id, params, ...rest);
        },
      });
    }

    function within(promise, ms) {
      let timer;
      return Promise.race([promise, new Promise((resolve) => { timer = timers.setTimeout(resolve, ms); })])
        .finally(() => timers.clearTimeout(timer));
    }

    // Plan tool, board server host and live worker rows of this session (lead sessions only; never called for workers).
    let hostSid = null;
    // The board store is built before any session context exists, so the host model
    // registry is handed over as a getter and resolves to the current session's
    // registry whenever GET /profiles/state reads the picker list.
    let profilesCtx = null;
    const profilesStoreOptions = { ...(opts.profilesStoreOptions ?? {}) };
    if (!Object.hasOwn(profilesStoreOptions, 'registry')) {
      profilesStoreOptions.registry = () => profilesCtx?.modelRegistry ?? null;
    }
    const profilesStore = (opts.createProfilesStore ?? openProfilesStore)(profilesStoreOptions);
    function setupLive(ctx) {
      profilesCtx = ctx;
      planTool = (opts.createPlanTool ?? createPlanTool)({
        store,
        sessionId: sid,
        cwd: ctx.cwd,
        isEnabled: enabled,
        publish: () => refresh(),
        onError: recordError,
        onRecover: settle,
        getMeta: () => meta,
        saveMeta: () => saveMeta(),
        pageUrl: boardLink,
        now: nowFn,
      });
      if (serverOn && (!host || hostSid !== sid)) {
        hostSid = sid;
        host = (opts.createServerHost ?? createServerHost)({
          stateDir,
          sessionId: sid,
          generation,
          installedGeneration,
          isEnabled: enabled, // never throws: an unreadable settings file is recorded as the 'settings' error and reads as paused
          buildViewModel: (snap, t) => {
            const info = serverInfoOf(store);
            // a failed record read is recorded in this very operation; when that changed the errors the model is built from a fresh snapshot
            const changed = noteServerRecord(info);
            return buildViewModel(changed ? withReports(store, store.readSnapshot()) : snap, t, { generation, server: info.server, serverError: info.error, stateDir: store.root });
          },
          readSnapshot: () => withReports(store, store.readSnapshot()),
          getPage: (vm, token) => pageHtml(vm, generation, { mode: 'server', token }),
          answer: boardAnswer,
          focus: boardFocus,
          profiles: boardProfiles,
          profilesState: boardProfilesState,
          reclaimStale: (rel, rec) => store.reclaimStale(rel, rec),
          onError: hostError,
          onRecover: hostRecover,
          // the file page shows 'open live view' only when it knows the address: publish again when it changes
          onChange: (status) => {
            if (status.role === 'stale' && meta.serverStale !== true) {
              meta.serverStale = true;
              saveMeta();
            } else if ((status.role === 'owner' || status.role === 'client') && meta.serverStale) {
              delete meta.serverStale;
              saveMeta();
            }
            if (active && !shuttingDown && !ensuring && enabled()) refreshSoon(true);
          },
          env,
          timers,
          ...(opts.hostOptions ?? {}),
        });
      }
      if (workersLive) workersLive.stop();
      workersLive = (opts.createWorkersLive ?? createWorkersLive)({
        sessionId: () => sid,
        cwd: ctx.cwd,
        isEnabled: enabled,
        softPublish,
        saveLive: (list) => {
          if (!meta) return;
          meta.auto = { ...(meta.auto && typeof meta.auto === 'object' ? meta.auto : {}), live: { workers: list } };
          saveMeta();
        },
        onError: hostError,
        onRecover: hostRecover,
        ...(opts.timers ? { timers } : {}),
        ...(opts.workersLiveOptions ?? {}),
      });
      workersLive.start();
      if (earlyRpc) {
        const early = earlyRpc;
        earlyRpc = null;
        workersLive.onRpcEvent(early);
      }
    }

    // Only the fields normalizeTaskSnapshot reads (src/workers.mjs), strings clipped: no clone, no other getter is touched.
    const keep = (v, max = 256) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const pick = (o, spec) => { const out = {}; for (const [k, max] of spec) { const v = keep(o[k], max); if (v !== undefined) out[k] = v; } return out; };
    const TASK_FIELDS = ['task_id', 'parent_session_id', 'status', 'task_summary', 'description', 'name', 'agent_type', 'category', 'model_id', 'model', 'created_at', 'updated_at', 'terminal_at'].map((k) => [k]);
    function pickSnapshot(data) {
      const tasks = data && Array.isArray(data.tasks) ? data.tasks.slice(0, 256).map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const out = { ...pick(raw, TASK_FIELDS), ...pick(raw, [['child_session_id', 1024]]) };
        const rm = raw.resolved_model;
        if (rm && typeof rm === 'object') out.resolved_model = pick(rm, [['display'], ['model_id']]);
        const lp = raw.live_progress;
        if (lp && typeof lp === 'object') out.live_progress = pick(lp, [['current_tool'], ['last_assistant_line'], ['started_at']]);
        return out;
      }) : data && data.tasks;
      return { parent_session_id: keep(data && data.parent_session_id), tasks };
    }

    // One subscription to the task engine's snapshots (omo.task.updated), made at load. The handler copies only what it
    // needs, does no I/O and never throws into the emitter. Before the session exists the newest snapshot is kept.
    function onRpcEvent(event) {
      try {
        if (workersLive) workersLive.onRpcEvent(event);
        else if (event && event.name === 'omo.task.updated') earlyRpc = { name: event.name, data: pickSnapshot(event.data) };
      } catch (err) {
        queueMicrotask(() => hostError('workers:snapshot', err));
      }
    }
    if (pi.events && typeof pi.events.on === 'function') {
      const off = pi.events.on(RPC_CHANNEL, onRpcEvent);
      if (typeof off === 'function') rpcOff = off;
    }

    pi.on('session_start', async (_event, ctx) => {
      lastCtx = ctx;
      try {
        // Lead gate: print/json mode (hasUI false) and in-process child sessions never run.
        let file;
        try { file = ctx.sessionManager.getSessionFile(); } catch { file = undefined; }
        if (ctx.hasUI === false || isChildSessionFile(file)) {
          active = false;
          if (rpcOff) { rpcOff(); rpcOff = null; } // not a lead conversation: nothing listens for task snapshots
          return;
        }
        sid = ctx.sessionManager.getSessionId();
        if (!store) {
          stateDir = opts.stateDir ?? defaultStateDir(env);
          store = openStore(stateDir, opts.fs ? { fs: opts.fs } : {});
          pagePath = slashed(resolve(stateDir, 'index.html'));
        }
        const prior = store.readRecord(`sessions/${sid}/meta.json`) ?? {};
        const t = nowFn();
        meta = {
          ...prior,
          sessionId: sid,
          cwd: ctx.cwd,
          project: basename(String(ctx.cwd).replace(/[\\/]+$/, '')),
          title: (typeof pi.getSessionName === 'function' && pi.getSessionName()) || prior.title || basename(String(ctx.cwd)),
          paneId: env.HERDR_PANE_ID ?? prior.paneId ?? '',
          tabId: env.HERDR_TAB_ID ?? prior.tabId ?? '',
          workerIds: Array.isArray(prior.workerIds) ? prior.workerIds : [],
          workers: Array.isArray(prior.workers) ? prior.workers : [],
          answerKinds: ['option', 'text', 'annotation'], // only this generation advertises annotation delivery
          lastActivityAt: typeof prior.lastActivityAt === 'number' ? prior.lastActivityAt : t,
          running: false,
          hostPid: process.pid, // unlike pid (current run), survives idle turns until session_shutdown
          askLive: [], // in-process calls never survive a new session binding
          ...(typeof file === 'string' && file ? { sessionFile: file } : {}), // the board lists it as 세션 파일 (C-VM)
          turnDidWork: false,
          turnBriefed: false,
        };
        delete meta.pid;
        normalizeErrors(meta); // per-source errors survive a restart until their own source succeeds
        active = true;
        shuttingDown = false;
        shutdownDirty = false;
        run = freshRun();
        askBridge?.dispose();
        askBridge = createAskBridge({
          store, getSessionId: () => sid, now: nowFn, timers,
          publish: () => refresh(),
          onLiveChange: (ids) => { meta.askLive = ids; saveMeta(); },
          wake: (c) => deliverer?.wake(c, 'answers'),
        });
        setupLive(ctx);
        if (!registered) {
          registered = true;
          registerHandlers();
          registerSurface();
        }
        saveMeta();
        void refreshTab();
        if (!deliverer && typeof makeDeliverer === 'function') {
          deliverer = makeDeliverer({ pi, store, stateDir, pagePath, getSessionId: () => sid, getMeta: () => meta, saveMeta, refresh, enabled, now: nowFn, env, get askBridge() { return askBridge; } });
        }
        if (!mirror && typeof makeMirror === 'function') {
          mirror = makeMirror({ pi, store, stateDir, pagePath, getSessionId: () => sid, getMeta: () => meta, saveMeta, refresh, enabled, now: nowFn, env, notify: (c, d) => notifyDecision(c ?? lastCtx, d) });
        }
        if (mirror && typeof mirror.attach === 'function') await mirror.attach(ctx);
        if (enabled()) {
          if (host) {
            ensuring = true;
            try { await ensureServer(); } finally { ensuring = false; }
          }
          await refresh();
          if (deliverer && typeof deliverer.wake === 'function') await deliverer.wake(ctx, 'session_start');
        }
      } catch (err) {
        recordError('session_start', err);
      }
    });
  };
}

export default createBriefingExtension();
