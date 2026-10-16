// Read-only plan status overlay: what the plan FILE and the execution ledger say right now.
//
// The plan summary (plan_brief) is the agent's claim; this module reads the three structural line
// kinds of the plan file (checkbox, Parallelization, draft front-matter status), the last events of an
// execution ledger and the sha256 of both files, and nothing else. It never writes, never watches and
// never lists folders: the caller injects `readText` and every path read is an exact path.
//
// Contract: computePlanStatus() never throws. Whatever cannot be read or parsed lands in `errors[]`.
// "Missing" (readText -> null) is a normal answer and leaves its fields out; "unreadable" is recorded.
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA = 'omo-plan-status/1';

const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MAX_ATTEMPTS = 5; // first read + 4 retries (20, 40, 80, 160 ms) -> the 5th failure is reported
const FIRST_DELAY_MS = 20;
const LEDGER_TAIL_LINES = 2000;
const MAX_RANGE = 200;
const MAX_SESSION_IDS = 20;
const MAX_CHARS = { plan: 2 * 1024 * 1024, draft: 2 * 1024 * 1024, boulder: 16 * 1024 * 1024, ledger: 32 * 1024 * 1024 };
const LEDGER_EVENTS = new Set([
  'dispatch', 'task-completed', 'verify-failed', 'task-reopened',
  'worker-wedged', 'worker-error', 'partial', 'follow-up-appended',
]);
const TERMINAL_WORK = new Set(['completed', 'done', 'abandoned', 'discarded']);

const CHECKBOX = /^- \[( |x|~)\] (F?\d+[a-z]?)\. (.*)$/;
const PARALLEL = /^\s+Parallelization: Wave (\d+) \| Blocked by: (.*?) \| Blocks: (.*)$/;
const ID = /^F?\d+[a-z]?$/;
const RANGE = /^(F?)(\d{1,3})\s*-\s*(F?)(\d{1,3})$/;
const NO_DEPS = /^(없음|none|-)$/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultSha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function codeOf(err) {
  return typeof err?.code === 'string' && err.code ? err.code : 'READ_ERROR';
}

/** `senpi:<id>` and `<id>` name the same session. Same rule as collect.mjs, kept local on purpose. */
function sessionKey(id) {
  return typeof id === 'string' ? id.replace(/^senpi:/, '') : '';
}

function samePath(a, b) {
  const n = (p) => path.resolve(p).replace(/\\/g, '/').normalize('NFC').toLowerCase();
  return n(a) === n(b);
}

function nowIso(now) {
  let v = typeof now === 'function' ? now() : now;
  if (v === undefined || v === null) v = Date.now();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** All works of a boulder object (object keyed by work_id, or array), in file order. */
function listWorks(boulder) {
  if (!boulder || typeof boulder !== 'object' || Array.isArray(boulder)) return [];
  const raw = boulder.works;
  let entries;
  if (Array.isArray(raw)) entries = raw.map((w, i) => [w?.work_id, w, i]);
  else if (raw && typeof raw === 'object') entries = Object.entries(raw).map(([k, w], i) => [w?.work_id ?? k, w, i]);
  else return [];
  return entries
    .filter(([, w]) => w && typeof w === 'object')
    .map(([id, w, index]) => ({ id: typeof id === 'string' ? id : String(index), w, index }));
}

function timeOf(w) {
  for (const f of [w.updated_at, w.started_at]) {
    const t = typeof f === 'string' ? Date.parse(f) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}

/** updated_at -> started_at -> later position in the file. */
function isNewer(a, b) {
  const ta = timeOf(a.w);
  const tb = timeOf(b.w);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta > tb;
  return a.index > b.index;
}

function newest(items) {
  let best = null;
  for (const it of items) if (!best || isNewer(it, best)) best = it;
  return best;
}

/**
 * The plan file of the work this session belongs to, as an absolute path (or null).
 * A session in several works prefers an unfinished one, then the most recent.
 */
export function findPlanForSession(boulder, sessionId, cwd) {
  const want = sessionKey(sessionId);
  if (!want) return null;
  const mine = listWorks(boulder).filter(({ w }) => (
    typeof w.active_plan === 'string' && w.active_plan
    && Array.isArray(w.session_ids) && w.session_ids.some((s) => sessionKey(s) === want)
  ));
  const open = mine.filter(({ w }) => !TERMINAL_WORK.has(w.status));
  const pick = newest(open.length ? open : mine);
  if (!pick) return null;
  const rel = pick.w.active_plan;
  if (path.isAbsolute(rel)) return path.resolve(rel);
  return typeof cwd === 'string' && cwd ? path.resolve(cwd, rel) : null;
}

/** Comma list with `F1-F4` / `2-5` ranges; `없음|none|-` means no entries. Bad tokens are returned, not guessed. */
function expandIds(field) {
  const s = String(field ?? '').trim();
  const ids = [];
  const bad = [];
  if (!s || NO_DEPS.test(s)) return { ids, bad };
  for (const raw of s.split(',')) {
    const tok = raw.trim();
    if (!tok) continue;
    const range = RANGE.exec(tok);
    if (range) {
      const [, pa, a, pb, b] = range;
      const from = Number(a);
      const to = Number(b);
      if ((pb === '' || pb === pa) && from <= to && to - from <= MAX_RANGE) {
        for (let n = from; n <= to; n++) ids.push(pa + n);
      } else bad.push(tok);
    } else if (ID.test(tok)) ids.push(tok);
    else bad.push(tok);
  }
  return { ids: [...new Set(ids)], bad };
}

function parsePlan(text, file, errors) {
  const boxes = {};
  const titles = new Map();
  const parallel = new Map();
  const dup = [];
  const badTokens = [];
  let current = null;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const box = CHECKBOX.exec(line);
    if (box) {
      const [, mark, id, title] = box;
      if (Object.hasOwn(boxes, id)) {
        dup.push(id);
        current = null; // a repeated id must not take over the first one's Parallelization line
      } else {
        boxes[id] = mark;
        titles.set(id, title.trim());
        current = id;
      }
      continue;
    }
    const par = PARALLEL.exec(line);
    if (par && current !== null && !parallel.has(current)) {
      const { ids, bad } = expandIds(par[2]);
      badTokens.push(...bad);
      parallel.set(current, { wave: Number(par[1]), deps: ids });
    }
  }
  if (dup.length) errors.push({ source: 'plan', path: file, code: 'DUP_ID', ids: [...new Set(dup)] });
  if (badTokens.length) errors.push({ source: 'plan', path: file, code: 'BAD_DEPS', tokens: badTokens });
  const tasks = Object.keys(boxes).map((id) => {
    const p = parallel.get(id);
    return { id, title: [...titles.get(id)].slice(0, 14).join(''), wave: p ? p.wave : null, deps: p ? p.deps : [] };
  });
  return { boxes, tasks };
}

/** `status:` of the first `---` block only (top-level key). Body lines and nested keys never count. */
function parseDraftStatus(text, file, errors) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) {
    errors.push({ source: 'plan', path: file, code: 'FRONTMATTER_UNTERMINATED' });
    return undefined;
  }
  for (const line of lines.slice(1, end)) {
    const m = /^status:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!m) continue;
    const v = m[1].replace(/^(["'])(.*)\1$/, '$2').trim();
    return v || undefined;
  }
  return undefined;
}

function parseLedger(text, file, errors) {
  const lines = text.split(/\r?\n/).slice(-LEDGER_TAIL_LINES).filter((l) => l.trim() !== '');
  const last = {};
  let bad = 0;
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      bad += 1; // counted and reported below as one errors[] line
      continue;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      bad += 1;
      continue;
    }
    const task = typeof o.task === 'string' ? o.task : (typeof o.task === 'number' && Number.isFinite(o.task) ? String(o.task) : '');
    if (task && LEDGER_EVENTS.has(o.event)) last[task] = { last: o.event, at: typeof o.at === 'string' ? o.at : null };
  }
  if (bad) errors.push({ source: 'plan', path: file, code: 'LEDGER_BAD_LINES', count: bad });
  return last;
}

async function fill(status, opts) {
  const { planPath, draftPath, boulderPath, readText, now } = opts;
  const sha256 = typeof opts.sha256 === 'function' ? opts.sha256 : defaultSha256;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const { errors } = status;
  status.at = nowIso(now);
  if (typeof readText !== 'function') {
    errors.push({ source: 'plan', path: '', code: 'BAD_ARGS' });
    return;
  }

  /** -> string, null (missing) or undefined (unreadable; already recorded in errors). */
  const read = async (file, kind) => {
    let delay = FIRST_DELAY_MS;
    for (let attempt = 1; ; attempt++) {
      let value;
      try {
        value = await readText(file);
      } catch (err) {
        const code = codeOf(err);
        if (TRANSIENT.has(code) && attempt < MAX_ATTEMPTS) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        errors.push({ source: 'plan', path: file, code });
        return undefined;
      }
      if (value === null || value === undefined) return null;
      if (typeof value !== 'string') {
        errors.push({ source: 'plan', path: file, code: 'BAD_READ' });
        return undefined;
      }
      if (value.length > MAX_CHARS[kind]) {
        errors.push({ source: 'plan', path: file, code: 'TOO_LARGE' });
        return undefined;
      }
      return value;
    }
  };
  const hash = async (text, file) => {
    try {
      return await sha256(text);
    } catch {
      errors.push({ source: 'plan', path: file, code: 'SHA_FAILED' });
      return undefined;
    }
  };

  if (typeof planPath === 'string' && planPath) {
    const text = await read(planPath, 'plan');
    if (typeof text === 'string') {
      const sha = await hash(text, planPath);
      if (sha !== undefined) status.files.planSha256Now = sha;
      const { boxes, tasks } = parsePlan(text, planPath, errors);
      status.boxes = boxes;
      if (tasks.length) status.skeleton = { tasks };
    }
  }

  if (typeof draftPath === 'string' && draftPath) {
    const text = await read(draftPath, 'draft');
    if (typeof text === 'string') {
      const sha = await hash(text, draftPath);
      if (sha !== undefined) status.files.draftSha256Now = sha;
      const draftStatus = parseDraftStatus(text, draftPath, errors);
      if (draftStatus !== undefined) status.files.draftStatus = draftStatus;
    }
  }

  if (typeof boulderPath === 'string' && boulderPath && typeof planPath === 'string' && planPath) {
    const text = await read(boulderPath, 'boulder');
    if (typeof text !== 'string') return;
    let boulder;
    try {
      boulder = JSON.parse(text);
    } catch {
      errors.push({ source: 'plan', path: boulderPath, code: 'BOULDER_PARSE' });
      return;
    }
    const root = path.dirname(path.dirname(boulderPath)); // <root>/.omo/boulder.json
    const pick = newest(listWorks(boulder).filter(({ w }) => (
      typeof w.active_plan === 'string' && w.active_plan && samePath(path.resolve(root, w.active_plan), planPath)
    )));
    if (!pick) return;
    const { w } = pick;
    status.work = {
      workId: pick.id,
      status: typeof w.status === 'string' ? w.status : null,
      sessionIds: Array.isArray(w.session_ids) ? w.session_ids.filter((s) => typeof s === 'string').slice(0, MAX_SESSION_IDS) : [],
    };
    if (typeof w.ledger === 'string' && w.ledger) {
      const ledgerPath = path.resolve(root, w.ledger);
      const ledgerText = await read(ledgerPath, 'ledger');
      if (typeof ledgerText === 'string') status.ledger = parseLedger(ledgerText, ledgerPath, errors);
    }
  }
}

/**
 * @param {{planPath?:string, draftPath?:string, boulderPath?:string,
 *   readText:(p:string)=>Promise<string|null>|string|null, sha256?:(t:string)=>string|Promise<string>,
 *   now?:number|Date|(()=>number), sleep?:(ms:number)=>Promise<void>}} opts
 *   readText: null when the file does not exist; throws (with .code) when it exists but cannot be read.
 * @returns {Promise<object>} omo-plan-status/1 (without planId / bySessionId, which the caller owns)
 */
export async function computePlanStatus(opts = {}) {
  const status = { schema: SCHEMA, at: nowIso(), files: {}, boxes: {}, ledger: {}, errors: [] };
  try {
    await fill(status, opts ?? {});
  } catch (err) {
    // Backstop for bugs and hostile injected functions: the caller still gets a status, with the reason.
    status.errors.push({ source: 'plan', path: '', code: 'INTERNAL', message: String(err?.message ?? err).slice(0, 200) });
  }
  return status;
}
