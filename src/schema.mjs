// omo-briefing src/schema.mjs — brief 입력 계약·길이 예산 검사기
const ABS_RE = /^[A-Za-z]:[\\/]/;
const len = (s) => [...s].length;
const TRUTHS = ['evidence', 'reported', 'unverified'];
const APPLIEDS = ['candidate', 'live', 'none'];
const STATUSES = ['in_progress', 'blocked', 'needs_decision', 'done'];
const FLOW_STATES = ['done', 'doing', 'todo', 'blocked'];
const CLOSE_REASONS = ['superseded', 'withdrawn'];

function strField(errors, obj, path, { min = 1, max }) {
  const v = obj?.[path.split('.').pop()];
  return checkStr(errors, path, v, { min, max });
}
function checkStr(errors, path, v, { min = 1, max }) {
  if (typeof v !== 'string') { errors.push(`${path}: 문자열 필요`); return null; }
  const n = len(v);
  if (n < min) { errors.push(`${path}: ${min}자 이상 필요(현재 ${n})`); return null; }
  if (max !== undefined && n > max) { errors.push(`${path}: ${max}자 초과(${n})`); return null; }
  return v;
}

const LARGE_EVIDENCE_BYTES = 10 * 1024 * 1024;

function checkId(errors, path, id, fns) {
  if (!Number.isInteger(id) || id <= 0) { errors.push(`${path}: 양의 정수 필요`); return; }
  if (typeof fns.decisionOwner !== 'function' || fns.sessionId === undefined) {
    errors.push(`${path}: 결정 조회 필요(조회·세션 맥락 없음)`);
    return;
  }
  let owner = null;
  try { owner = fns.decisionOwner(id); } catch { owner = null; }
  if (owner === null || owner === undefined) errors.push(`${path}: 존재하지 않는 결정(${id})`);
  else if (owner !== fns.sessionId) errors.push(`${path}: 다른 세션 소유의 결정(${id})`);
}

function checkEvidence(errors, warnings, path, item, fns) {
  const ev = item.evidence;
  if (ev === undefined) return { sha: undefined, missing: false };
  if (typeof ev !== 'string' || !ABS_RE.test(ev)) {
    errors.push(`${path}.evidence: 절대경로 필요(예: C:/x/y.txt)`);
    return { sha: undefined, missing: false, bad: true };
  }
  if (item.truth !== 'evidence') return { sha: undefined, missing: false };
  // truth=evidence + 절대경로: 존재 확인
  if (typeof fns.fileExists === 'function') {
    let exists = false;
    try { exists = !!fns.fileExists(ev); } catch { exists = false; }
    if (!exists) {
      item.truth = 'reported';
      item.evidence_missing = true;
      warnings.push(`${path}: 증거 파일 없음 -> 보고만 됨으로 저장`);
      return { sha: undefined, missing: true };
    }
  }
  let sha;
  if (typeof fns.stat === 'function') {
    let st;
    try { st = fns.stat(ev); } catch { st = undefined; }
    if (st && typeof st.size === 'number' && st.size > LARGE_EVIDENCE_BYTES) {
      item.evidenceSize = st.size;
      const mtime = st.mtimeMs ?? (st.mtime instanceof Date ? st.mtime.getTime() : undefined);
      if (mtime !== undefined) item.evidenceMtimeMs = mtime;
      return { sha: undefined, missing: false, large: true };
    }
  }
  if (typeof fns.sha256 === 'function') {
    try { sha = fns.sha256(ev); } catch { sha = undefined; }
  }
  return { sha, missing: false };
}

function checkRow(errors, warnings, path, item, fns) {
  if (typeof item !== 'object' || item === null) { errors.push(`${path}: 항목 객체 필요`); return; }
  checkStr(errors, path + '.text', item.text, { min: 1, max: 100 });
  if (!TRUTHS.includes(item.truth)) errors.push(`${path}.truth: 허용 값 evidence|reported|unverified 필요`);
  if (!APPLIEDS.includes(item.applied)) errors.push(`${path}.applied: 허용 값 candidate|live|none 필요`);
  if (item.truth === 'evidence' && item.evidence === undefined) {
    errors.push(`${path}.evidence: truth=evidence인데 evidence 없음`);
    return;
  }
  const { sha } = checkEvidence(errors, warnings, path, item, fns);
  if (sha !== undefined) item.evidenceSha256 = sha;
}

function checkDecision(errors, path, d, fns, sessionId) {
  if (typeof d !== 'object' || d === null) { errors.push(`${path}: 결정 객체 필요`); return; }
  if (d.id !== undefined) {
    checkId(errors, `${path}.id`, d.id, fns);
  }
  checkStr(errors, path + '.question', d.question, { min: 1, max: 100 });
  const opts = d.options;
  if (typeof opts !== 'object' || opts === null) { errors.push(`${path}.options: 선택지 2개 이상 필요`); return; }
  const keys = ['A', 'B', 'C'].filter((k) => opts[k] !== undefined);
  if (!(opts.A !== undefined && opts.B !== undefined) || keys.length < 2) {
    errors.push(`${path}.options: 선택지 2개 이상 필요(A·B 필수)`);
  }
  for (const k of keys) {
    const o = opts[k];
    if (typeof o !== 'object' || o === null) { errors.push(`${path}.options.${k}: 선택지 객체 필요`); continue; }
    checkStr(errors, `${path}.options.${k}.text`, o.text, { min: 1, max: 60 });
    checkStr(errors, `${path}.options.${k}.consequence`, o.consequence, { min: 1, max: 80 });
  }
  for (const k of Object.keys(opts)) {
    if (!['A', 'B', 'C'].includes(k)) errors.push(`${path}.options.${k}: 허용 선택지 A|B|C 아님`);
  }
  if (!['A', 'B', 'C'].includes(d.recommend)) {
    errors.push(`${path}.recommend: 허용 값 A|B|C 필요`);
  } else if (opts[d.recommend] === undefined) {
    errors.push(`${path}.recommend: 없는 선택지를 가리킴(${d.recommend})`);
  }
  checkStr(errors, path + '.reason', d.reason, { min: 1, max: 100 });
  if (typeof d.blocks !== 'boolean') errors.push(`${path}.blocks: 불리언 필요`);
}

export function validateBrief(input, fns = {}) {
  const errors = [];
  const warnings = [];
  const raw = (typeof input === 'object' && input !== null) ? input : null;
  if (!raw) return { ok: false, errors: ['입력: 객체 필요'], warnings, normalized: null };
  const v = structuredClone(raw);
  checkStr(errors, 'title', v.title, { min: 1, max: 40 });
  if (!STATUSES.includes(v.status)) errors.push('status: 허용 값 in_progress|blocked|needs_decision|done 필요');
  checkStr(errors, 'headline', v.headline, { min: 1, max: 100 });
  // next: 0..100 (빈 문자열 허용)
  if (typeof v.next !== 'string') errors.push('next: 문자열 필요');
  else if (len(v.next) > 100) errors.push(`next: 100자 초과(${len(v.next)})`);
  // changes 0..8, done 0..12
  for (const [name, max] of [['changes', 8], ['done', 12]]) {
    const arr = v[name];
    if (!Array.isArray(arr)) { errors.push(`${name}: 배열 필요(0..${max})`); continue; }
    if (arr.length > max) errors.push(`${name}: ${max}개 초과(${arr.length})`);
    arr.forEach((it, i) => checkRow(errors, warnings, `${name}[${i}]`, it, fns));
  }
  // decisions 0..4 (필수 배열; 누락·null 거절, []는 유효)
  {
    const arr = v.decisions;
    if (!Array.isArray(arr)) errors.push('decisions: 배열 필요(0..4)');
    else {
      if (arr.length > 4) errors.push(`decisions: 4개 초과(${arr.length})`);
      arr.forEach((d, i) => checkDecision(errors, `decisions[${i}]`, d, fns, fns.sessionId));
    }
  }
  // close_decisions?
  if (v.close_decisions !== undefined) {
    if (!Array.isArray(v.close_decisions)) errors.push('close_decisions: 배열 필요');
    else v.close_decisions.forEach((c, i) => {
      if (typeof c !== 'object' || c === null) { errors.push(`close_decisions[${i}]: 객체 필요`); return; }
      checkId(errors, `close_decisions[${i}].id`, c.id, fns);
      if (!CLOSE_REASONS.includes(c.reason)) errors.push(`close_decisions[${i}].reason: 허용 값 superseded|withdrawn 필요`);
    });
  }
  // flow? 0..8
  if (v.flow !== undefined) {
    if (!Array.isArray(v.flow)) errors.push('flow: 배열 필요(0..8)');
    else {
      if (v.flow.length > 8) errors.push(`flow: 8개 초과(${v.flow.length})`);
      v.flow.forEach((f, i) => {
        if (typeof f !== 'object' || f === null) { errors.push(`flow[${i}]: 객체 필요`); return; }
        checkStr(errors, `flow[${i}].label`, f.label, { min: 1, max: 20 });
        if (!FLOW_STATES.includes(f.state)) errors.push(`flow[${i}].state: 허용 값 done|doing|todo|blocked 필요`);
      });
    }
  }
  const ok = errors.length === 0;
  return { ok, errors, warnings, normalized: ok ? structuredClone(v) : null };
}
