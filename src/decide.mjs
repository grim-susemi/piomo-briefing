// omo-briefing src/decide.mjs - /decide 처리기: 문법·전부 아니면 전무 검사·답 기록.
//
// - parseDecide(text): 공백·쉼표로 토큰 분리, 각 토큰 ^(\d+)([ABCabc])?$.
//   번호만 있으면 추천안(applyDecide에서 결정의 recommend로 해결).
// - applyDecide(store, text, fromSessionId, now?, opts?): 전부 아니면 전무.
//   (1) 검사 단계: 하나라도 틀리면 파일 0개. (2) 선점 단계: 번호 오름차순으로
//   claims/<id>.json을 wx로 만듦. EEXIST + 답 없고 pid가 죽었으면 reclaimStale
//   후 한 번만 재선점. 그 외 EEXIST면 이번에 만든 선점만 되돌리고 answers 0개.
//   Windows에서 방금 지운 선점에 wx를 하면 EEXIST 대신 EPERM/EBUSY/EACCES가 날 수 있다:
//   '아직 못 얻음'으로 보고 다시 읽고 한도 안에서 재시도한 뒤, 끝내 못 얻으면 깔끔하게 진다.
//   (3) 전부 선점한 뒤에만 answers/<id>.json을 wx로 씀.
// - commitAnswers(store, items, fromSessionId, now, opts): 선점·전부 아니면 전무·write-once 답 기록의 공용 몸통(동기).
//   applyDecide(/decide)와 applyBoardAnswer(상황판)가 이것 하나만 써서 같은 선점·같은 answers/<id>.json 규칙을 지킨다.
// - applyBoardAnswer(store, {id, sessionId, option|text}, now?, opts?): 상황판 답 한 건. 검증 뒤 commitAnswers.
//   던지지 않고 { ok:true, id } 또는 { ok:false, code }를 돌려준다. 기록은 { id, option|text, at, fromSessionId:'board' }.
// - formatDecideResult(result): 한 줄 결과 문구.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPidAlive } from './store.mjs';
import { decisionValueErrors } from './schema.mjs';

const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const FIRST_DELAY_MS = 2;
const MAX_RETRIES = 8; // 2ms부터 두 배씩: 최악 약 0.5초 뒤 깔끔하게 진다
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const TOKEN_RE = /^(\d+)([ABCabc])?$/;
const pad6 = (n) => String(n).padStart(6, '0');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDecide(text) {
  const tokens = String(text ?? '').split(/[\s,]+/).filter((t) => t.length > 0);
  const items = [];
  const invalid = [];
  for (const token of tokens) {
    const m = TOKEN_RE.exec(token);
    if (!m) {
      invalid.push({ token, reason: '형식 오류(번호+선택지 A/B/C 필요, 예: 12A)' });
      continue;
    }
    items.push({ token, id: Number(m[1]), option: m[2] ? m[2].toUpperCase() : null });
  }
  return { items, invalid };
}

function claimRel(id) { return `claims/${pad6(id)}.json`; }
function answerRel(id) { return `answers/${pad6(id)}.json`; }
function decisionRel(id) { return `decisions/${pad6(id)}.json`; }
function closureRel(id) { return `decision-closures/${pad6(id)}.json`; }

export function formatDecideResult(result) {
  const applied = result?.applied ?? [];
  const errors = result?.errors ?? [];
  const already = result?.alreadyAnswered ?? [];
  if (applied.length > 0 && errors.length === 0 && already.length === 0) {
    return `반영: ${applied.map((a) => `#${a.id} ${a.option}`).join(', ')}`;
  }
  const parts = [];
  for (const e of errors) parts.push(`#${e.token} ${e.reason}`);
  for (const id of already) parts.push(`#${id} 이미 답함`);
  for (const id of result?.permissionError ?? []) parts.push(`#${id} 파일 권한 오류 - 다시 시도`);
  if (applied.length > 0) parts.unshift(`반영: ${applied.map((a) => `#${a.id} ${a.option}`).join(', ')}`);
  else parts.unshift('적용 안 함:');
  return parts.join(', ').replace('적용 안 함:,', '적용 안 함:');
}

/**
 * @param {object} store openStore() 결과 (root, writeNew, readRecord, reclaimStale 노출)
 * @param {string} text `/decide` 뒤 인자 문자열
 * @param {string} fromSessionId 답을 보낸 세션 id
 * @param {number} [now] Date.now() 기본
 * @param {{fs?, pid?, nonce?, hooks?, sleep?}} [opts] 테스트용 주입
 */
export function applyDecide(store, text, fromSessionId, now = Date.now(), opts = {}) {
  const { items, invalid } = parseDecide(text);
  const errors = invalid.map((e) => ({ token: e.token, reason: e.reason }));
  const alreadyAnswered = [];
  const permissionError = [];
  const readErrors = [];
  // store.readRecord는 없으면(ENOENT) null, 재시도 후에도 못 읽으면(EACCES/EPERM/EBUSY/EIO 등) 던진다.
  // 던진 것은 '없음'이 아니라 권한 오류로 보고하고(아무것도 적용 안 함), 원인은 readErrors로 넘겨 호출측이 lastError로 남긴다.
  const failRead = (id, err) => {
    if (!permissionError.includes(id)) permissionError.push(id);
    readErrors.push({ id, message: String(err?.message ?? err) });
  };

  // 검사 단계: 중복 확인
  const seen = new Set();
  const dupes = new Set();
  for (const it of items) {
    if (seen.has(it.id)) dupes.add(it.id);
    seen.add(it.id);
  }

  // 결정·마감·답 조회 (전부 아니면 전무: 이 단계에서 쓰기 없음)
  const decisions = new Map();
  for (const it of items) {
    if (dupes.has(it.id)) {
      if (!errors.some((e) => e.token === it.token)) {
        errors.push({ token: it.token, reason: '중복된 번호' });
      }
      continue;
    }
    let rec = null;
    try {
      rec = store.readRecord(decisionRel(it.id));
    } catch (err) {
      failRead(it.id, err);
      continue;
    }
    if (!rec) {
      errors.push({ token: it.token, reason: '없음' });
      continue;
    }
    decisions.set(it.id, rec);
    // 마감 확인을 못 하면(권한 오류 등) 닫힌 결정일 수 있으므로 아무것도 적용하지 않음(fail-closed).
    let closed = null;
    try {
      closed = store.readRecord(closureRel(it.id));
    } catch (err) {
      failRead(it.id, err);
      continue;
    }
    if (closed) {
      errors.push({ token: it.token, reason: '닫힘' });
      continue;
    }
    let ans = null;
    try {
      ans = store.readRecord(answerRel(it.id));
    } catch (err) {
      failRead(it.id, err);
      continue;
    }
    if (ans) {
      if (!alreadyAnswered.includes(it.id)) alreadyAnswered.push(it.id);
      continue;
    }
    if (rec.fields !== undefined) {
      errors.push({ token: it.token, code: 'FIELDS_REQUIRED', reason: '입력 결정은 상황판에서 값을 채워 주세요' });
      continue;
    }
    const option = it.option ?? rec.recommend;
    if (!option || !['A', 'B', 'C'].includes(option) || rec.options?.[option] === undefined) {
      errors.push({ token: it.token, reason: '선택지 없음' });
      continue;
    }
  }
  if (invalid.length === 0 && items.length === 0) {
    errors.push({ token: '', reason: '번호 필요(예: /decide 12A)' });
  }
  if (errors.length > 0 || alreadyAnswered.length > 0 || permissionError.length > 0) {
    return permissionError.length > 0
      ? { applied: [], errors, alreadyAnswered, permissionError, readErrors }
      : { applied: [], errors, alreadyAnswered };
  }

  // 선점·기록은 상황판 답과 같은 commitAnswers 하나를 씀(검증을 통과한 번호만 여기까지 옴).
  return commitAnswers(
    store,
    items.map((it) => ({ id: it.id, fields: { option: it.option ?? decisions.get(it.id).recommend } })),
    fromSessionId,
    now,
    opts,
  );
}

/**
 * 공용 몸통: 선점(claims/<id>.json, wx) → 전부 얻은 뒤 재확인 → answers/<id>.json(wx) 기록. 전부 아니면 전무.
 * 검증(결정 존재·마감·이미 답함·선택지)은 호출측 몫. 같은 번호가 두 번 들어오면 안 된다.
 * @param {{id:number|string, fields:object}[]} items Numeric decisions keep {id}; annotations use {key}.
 * @returns {{applied:object[], errors:object[], alreadyAnswered:number[], permissionError?:number[]}} applyDecide 결과와 같은 모양
 */
function commitAnswers(store, items, fromSessionId, now, opts = {}) {
  const fs = opts.fs ?? nodeFs;
  const pid = opts.pid ?? process.pid;
  const makeNonce = opts.nonce ?? (() => randomUUID());
  const hooks = opts.hooks ?? {};
  const sleep = opts.sleep ?? sleepSync;
  const at = now;

  // 선점 단계: 번호 오름차순
  const ordered = [...items].sort((a, b) => typeof a.id === 'number' && typeof b.id === 'number'
    ? a.id - b.id : String(a.id).localeCompare(String(b.id)));
  const identity = (id) => typeof id === 'number' ? { id } : { key: id };
  const mine = [];
  const rollback = () => {
    for (const id of mine) {
      try { fs.unlinkSync(join(store.root, ...claimRel(id).split('/'))); } catch { /* already gone */ }
    }
    mine.length = 0;
  };
  const readOrNull = (rel) => { try { return store.readRecord(rel); } catch { return null; } };
  const fileExists = (rel) => fs.existsSync(join(store.root, ...rel.split('/')));
  const answerExists = (id) => Boolean(readOrNull(answerRel(id)) || fileExists(answerRel(id)));
  // 경쟁자(선점 또는 답)가 실제로 관찰됐는가. 읽을 수 없어도 파일이 있으면 있는 것으로 봄.
  const competitorSeen = (id) =>
    Boolean(readOrNull(claimRel(id)) || readOrNull(answerRel(id)) || fileExists(claimRel(id)) || fileExists(answerRel(id)));

  // 'created' | 'exists' | 'busy'. Windows: 방금 지워진(삭제 대기) 파일에 wx로 만들면
  // EEXIST가 아니라 EPERM/EBUSY/EACCES가 난다 = "아직 못 얻음". 다시 읽어 보고 한도 안에서 재시도.
  const createClaim = (id) => {
    let delay = FIRST_DELAY_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        store.writeNew(claimRel(id), { ...identity(id), pid, at, nonce: makeNonce() });
        return 'created';
      } catch (err) {
        if (err?.code === 'EEXIST') return 'exists';
        if (!TRANSIENT_CODES.has(err?.code)) throw err;
        if (competitorSeen(id)) return 'exists'; // 다른 쪽이 이미 잡음
        if (attempt >= MAX_RETRIES) return 'busy';
        sleep(delay);
        delay *= 2;
      }
    }
  };

  // 'won' | 'lost' | 'busy'(경쟁자 없이 권한 오류로 끝내 못 만듦). 던지는 것은 일시 오류가 아닌 실제 장애뿐.
  const acquire = (id) => {
    let delay = FIRST_DELAY_MS;
    for (let round = 0; round <= MAX_RETRIES; round++) {
      const made = createClaim(id);
      if (made === 'created') return 'won';
      if (made === 'busy') return 'busy';
      // 이미 있음: 답이 있으면 진 것. 답 없고 pid가 죽은 선점만 회수 후 한 번 재선점.
      if (readOrNull(answerRel(id))) return 'lost';
      const stale = readOrNull(claimRel(id));
      if (!stale) {
        if (fs.existsSync(join(store.root, ...claimRel(id).split('/')))) return 'lost'; // 읽을 수 없음 = 살아 있는 것으로 봄
        sleep(delay); // 보는 사이에 선점이 사라짐: 다시 만들기를 시도
        delay *= 2;
        continue;
      }
      if (hooks.beforeReclaim) hooks.beforeReclaim(id, stale);
      // 회수는 '죽은 pid를 본 뒤에도 답이 없을 때'만. 죽은 프로세스는 더 쓰지 못하므로 이 순서가
      // 앞선 답 확인 이후에 커밋하고 종료한 승자의 선점을 오래된 것으로 오인하는 경쟁을 막는다.
      if (isPidAlive(stale.pid)) return 'lost';
      if (answerExists(id)) return 'lost';
      let reclaimed;
      try {
        reclaimed = store.reclaimStale(claimRel(id), stale);
      } catch (err) {
        if (!TRANSIENT_CODES.has(err?.code)) throw err;
        const now = readOrNull(claimRel(id));
        if (now && now.nonce === stale.nonce) throw err; // 그대로인데 못 링크 = 실제 장애(수동 확인)
        return 'lost'; // 다른 프로세스가 지우거나 바꾸는 중
      }
      if (!reclaimed) return 'lost';
      const again = createClaim(id);
      return again === 'created' ? 'won' : again === 'busy' ? 'busy' : 'lost';
    }
    return 'lost';
  };

  for (const it of ordered) {
    let outcome;
    try {
      hooks.beforeClaim?.(it.id);
      outcome = acquire(it.id);
    } catch (err) {
      rollback();
      throw err;
    }
    if (outcome === 'busy') {
      rollback();
      return { applied: [], errors: [], alreadyAnswered: [], permissionError: [it.id] };
    }
    if (outcome !== 'won') {
      rollback();
      return { applied: [], errors: [], alreadyAnswered: [it.id] };
    }
    mine.push(it.id);
  }

  // 답을 쓰기 직전 재확인: 모든 선점을 얻은 뒤에도 어느 번호든 답이 이미 있으면 전부 되돌림(0개 기록).
  const answeredNow = ordered.map((it) => it.id).filter((id) => answerExists(id));
  if (answeredNow.length > 0) {
    rollback();
    return { applied: [], errors: [], alreadyAnswered: answeredNow };
  }
  // A hold can win after the caller's validation but before its claim acquisition.
  // Recheck under our claim so a terminal answer never writes through that closure.
  for (const it of ordered) {
    if (typeof it.id !== 'number') continue;
    let closed;
    try { closed = store.readRecord(closureRel(it.id)); } catch (err) { rollback(); throw err; }
    if (closed) {
      rollback();
      return { applied: [], errors: [{ token: String(it.id), reason: closed.reason === 'held' ? 'HELD' : 'CLOSED' }], alreadyAnswered: [] };
    }
  }

  // 답 단계: 위 재확인 뒤에는 선점한 프로세스만 쓰므로 EEXIST는 생기지 않음
  const applied = [];
  try {
    for (const it of ordered) {
      store.writeNew(answerRel(it.id), { ...identity(it.id), ...it.fields, at, fromSessionId });
      applied.push({ id: it.id, ...it.fields });
    }
  } catch (err) {
    // 이미 쓴 답은 지우지 않음(이미 전달됐을 수 있음)
    return { applied, errors: [{ token: '', reason: String(err?.message ?? err) }], alreadyAnswered: [] };
  }
  return { applied, errors: [], alreadyAnswered: [] };
}

const BOARD_SENDER = 'board';
const BOARD_TEXT_MAX = 500; // 코드포인트
const boardFail = (code, detail) => (detail === undefined ? { ok: false, code } : { ok: false, code, detail });

/** Owner Markdown is stored verbatim; the shared writer alone creates claims and answers. */
export function applyBoardAnnotation(store, request, now = Date.now(), opts = {}) {
  let { sessionId, requestId, text } = request ?? {};
  if (typeof sessionId !== 'string' || !sessionId || typeof requestId !== 'string' || !UUID_V4.test(requestId)) {
    return boardFail('BAD_REQUEST');
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 24000
    || [...text].length > 12000 || Buffer.byteLength(text, 'utf8') > 48 * 1024) return boardFail('BAD_TEXT');
  requestId = requestId.toLowerCase();
  const key = `a-${requestId}`;
  const duplicate = (answer) => answer.kind === 'annotation' && answer.sessionId === sessionId && answer.text === text
    ? { ok: true, key, duplicate: true } : boardFail('REQUEST_ID_CONFLICT');
  try {
    const existing = store.readRecord(answerRel(key));
    if (existing) return duplicate(existing);
    const result = commitAnswers(store, [{ id: key, fields: { kind: 'annotation', sessionId, text, requestId } }], BOARD_SENDER, now, opts);
    if (result.applied.length) return { ok: true, key };
    // A competitor may have committed between our first read and claim acquisition.
    const winner = store.readRecord(answerRel(key));
    if (winner) return duplicate(winner);
    return boardFail('IO_ERROR', result.errors[0]?.reason ?? 'annotation claim not acquired');
  } catch (err) {
    return boardFail('IO_ERROR', String(err?.message ?? err));
  }
}

/**
 * 상황판 답 한 건(옵션 하나 또는 글 하나). 던지지 않는다.
 * 코드: BAD_REQUEST(번호·세션·option/text 모양) BAD_TEXT BAD_OPTION NOT_FOUND SESSION_MISMATCH CLOSED HELD ANSWERED
 *       IO_ERROR(읽기·선점·쓰기 장애: 아무것도 쓰지 않았거나 못 씀. detail은 로그용이며 화면에 내보내지 않는다)
 * 읽기 검사는 쓰기 전에 모두 끝나고, 못 읽으면 닫힌/이미 답한 결정일 수 있으므로 fail-closed(IO_ERROR).
 * @param {object} store openStore() 결과
 * @param {{id:number, sessionId:string, option?:string, text?:string}} request
 * @param {number} [now]
 * @param {{fs?, pid?, nonce?, hooks?, sleep?}} [opts] 테스트용 주입(commitAnswers에 그대로 전달)
 */
export function applyBoardAnswer(store, request, now = Date.now(), opts = {}) {
  if (request?.action !== undefined) return applyBoardAction(store, request, now, opts);
  return applyDecisionAnswer(store, request, BOARD_SENDER, now, opts);
}

/** The asking session uses the same validation and claim writer as the board. */
export function applyAskAnswer(store, request, now = Date.now(), opts = {}) {
  try {
    const rec = store.readRecord(decisionRel(request?.id));
    if (!rec) return boardFail('NOT_FOUND');
    if (rec.source !== 'ask' || rec.sessionId !== request?.sessionId) return boardFail('SESSION_MISMATCH');
    const result = applyDecisionAnswer(store, request, rec.sessionId, now, opts);
    const answer = store.readRecord(answerRel(rec.id));
    if (answer) return { ...result, answer };
    if (store.readRecord(closureRel(rec.id))?.reason === 'held') return boardFail('HELD');
    return result;
  } catch (err) {
    return boardFail('IO_ERROR', String(err?.message ?? err));
  }
}

function applyDecisionAnswer(store, request, sender, now, opts) {
  const { id, sessionId, option, text, values } = request !== null && typeof request === 'object' ? request : {};
  const hasOption = option !== undefined;
  const hasText = text !== undefined;
  const hasValues = values !== undefined;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof sessionId !== 'string' || sessionId === '' || Number(hasOption) + Number(hasText) + Number(hasValues) !== 1) {
    return boardFail('BAD_REQUEST');
  }
  let fields = null;
  if (hasText) {
    const clean = typeof text === 'string' ? text.trim() : '';
    // 코드포인트 500개 = UTF-16 단위로 최대 1000: 그보다 길면 펼쳐 세기 전에 거절
    if (clean === '' || clean.length > BOARD_TEXT_MAX * 2 || [...clean].length > BOARD_TEXT_MAX) return boardFail('BAD_TEXT');
    fields = { text: clean };
  }

  let rec;
  try {
    rec = store.readRecord(decisionRel(id));
    if (!rec) return boardFail('NOT_FOUND');
    if (rec.sessionId !== sessionId) return boardFail('SESSION_MISMATCH');
    const closure = store.readRecord(closureRel(id));
    if (closure) return boardFail(closure.reason === 'held' ? 'HELD' : 'CLOSED'); // C-HOLD 1: held until reopened
    if (store.readRecord(answerRel(id))) return boardFail('ANSWERED');
  } catch (err) {
    return boardFail('IO_ERROR', String(err?.message ?? err));
  }
  if (hasValues || rec.fields !== undefined) {
    const fieldErrors = decisionValueErrors(rec.fields, values);
    if (Object.keys(fieldErrors).length) return { ok: false, code: 'BAD_VALUES', fieldErrors };
    fields = { values: structuredClone(values) };
  }
  if (hasOption) {
    const choices = rec.options;
    const known = typeof option === 'string' && ['A', 'B', 'C'].includes(option)
      && choices !== null && typeof choices === 'object' && choices[option] !== undefined;
    if (!known) return boardFail('BAD_OPTION');
    fields = { option };
  }

  let result;
  try {
    result = commitAnswers(store, [{ id, fields }], sender, now, opts);
  } catch (err) {
    return boardFail('IO_ERROR', String(err?.message ?? err));
  }
  if (result.applied.length > 0) return { ok: true, id };
  if (result.permissionError?.length > 0) return boardFail('IO_ERROR', '파일 권한 오류');
  if (result.alreadyAnswered.length > 0) return boardFail('ANSWERED');
  if (['HELD', 'CLOSED'].includes(result.errors[0]?.reason)) return boardFail(result.errors[0].reason);
  // 기록 단계에서 쓰기가 실패함: 그 사이 답이 생겼으면 ANSWERED, 아니면 장애
  if ((opts.fs ?? nodeFs).existsSync(join(store.root, ...answerRel(id).split('/')))) return boardFail('ANSWERED');
  return boardFail('IO_ERROR', result.errors[0]?.reason);
}

// Hold/reopen use the same exclusive claim as answers. A held closure is not an answer. Reopen renames that
// closure to decision-closures/<id>.<n>.released.json (write-once records are never mutated in place, and the
// snapshot reads only <id>.json), so the question is open again without a fabricated reply or a message.
function applyBoardAction(store, { id, sessionId, action, option, text, values }, at, opts) {
  if (!Number.isSafeInteger(id) || id <= 0 || typeof sessionId !== 'string' || !sessionId
    || !['hold', 'reopen'].includes(action) || option !== undefined || text !== undefined || values !== undefined) return boardFail('BAD_REQUEST');
  const fs = opts.fs ?? nodeFs;
  let claimed = false;
  try {
    const rec = store.readRecord(decisionRel(id));
    if (!rec) return boardFail('NOT_FOUND');
    if (rec.sessionId !== sessionId) return boardFail('SESSION_MISMATCH');
    if (store.readRecord(answerRel(id))) return boardFail('ANSWERED');
    try {
      store.writeNew(claimRel(id), { id, pid: process.pid, at, nonce: randomUUID() });
      claimed = true;
    } catch (err) { if (err.code === 'EEXIST') return boardFail('CLOSED'); throw err; }
    if (store.readRecord(answerRel(id))) return boardFail('ANSWERED');
    const closed = store.readRecord(closureRel(id));
    if (action === 'reopen') {
      if (closed?.reason !== 'held') return boardFail('CLOSED');
      // Under our claim no other writer touches this id, so the first free cycle number is ours.
      let n = 1;
      while (fs.existsSync(join(store.root, 'decision-closures', `${pad6(id)}.${n}.released.json`))) n++;
      fs.renameSync(join(store.root, ...closureRel(id).split('/')), join(store.root, 'decision-closures', `${pad6(id)}.${n}.released.json`));
    } else {
      if (closed) return boardFail('CLOSED');
      const notice = randomUUID();
      store.writeNew(closureRel(id), { id, reason: 'held', at, notice });
      store.writeNew(`hold-notices/${notice}.json`, { id, sessionId, at });
    }
    return { ok: true, id };
  } catch (err) {
    return boardFail('IO_ERROR', String(err?.message ?? err));
  } finally {
    if (claimed) fs.unlinkSync(join(store.root, ...claimRel(id).split('/')));
  }
}

export { isPidAlive };
