// omo-briefing src/schema.mjs — brief 입력 계약·길이 예산 검사기
import { pathRefusal } from './assets.mjs';

const ABS_RE = /^[A-Za-z]:[\\/]/;
const len = (s) => [...s].length;
const TRUTHS = ['evidence', 'reported', 'unverified'];
const APPLIEDS = ['candidate', 'live', 'none'];
const STATUSES = ['in_progress', 'blocked', 'needs_decision', 'done'];
const FLOW_STATES = ['done', 'doing', 'todo', 'blocked'];
const CLOSE_REASONS = ['superseded', 'withdrawn'];
const REPORT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OPTION_KEYS = ['A', 'B', 'C'];
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function strField(errors, obj, path, { min = 1, max }) {
  const v = obj?.[path.split('.').pop()];
  return checkStr(errors, path, v, { min, max });
}
export function checkStr(errors, path, v, { min = 1, max }) {
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

// 선택지·추천·이유·blocks 검사. brief 결정과 plan_brief의 open 질문이 같은 규칙을 쓴다.
export function checkDecisionOptions(errors, path, d) {
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

export function checkDecision(errors, path, d, fns, sessionId) {
  if (typeof d !== 'object' || d === null) { errors.push(`${path}: 결정 객체 필요`); return; }
  if (d.id !== undefined) {
    checkId(errors, `${path}.id`, d.id, fns);
  }
  checkStr(errors, path + '.question', d.question, { min: 1, max: 100 });
  if (d.state !== undefined && !['open', 'answered'].includes(d.state)) errors.push(`${path}.state: 허용 값 open|answered 필요`);
  if (d.state === 'answered') checkStr(errors, path + '.answer', d.answer, { min: 1, max: 500 });
  checkDecisionOptions(errors, path, d);
}

// reports? 0..3 (C-REPORT 1). Only the contract keys are kept; image files are read later by importImage.
// fns.decisionOpen(id) / fns.decisionOptions(id) (optional) say whether a linked existing decision is open and which options it has.
function checkReports(errors, v, fns) {
  if (v.reports === undefined) return;
  if (!Array.isArray(v.reports)) { errors.push('reports: 배열 필요(0..3)'); return; }
  if (v.reports.length > 3) errors.push(`reports: 3개 초과(${v.reports.length})`);
  const ids = new Set();
  v.reports = v.reports.map((r, i) => {
    const p = `reports[${i}]`;
    if (!isObj(r)) { errors.push(`${p}: 보고서 객체 필요`); return r; }
    if (typeof r.id !== 'string' || !REPORT_ID_RE.test(r.id)) errors.push(`${p}.id: 형식 필요(a-z0-9 시작, a-z0-9_- 1..64자)`);
    else if (ids.has(r.id)) errors.push(`${p}.id: 이 호출 안에서 중복(${r.id})`);
    else ids.add(r.id);
    checkStr(errors, `${p}.title`, r.title, { min: 1, max: 80 });
    if (r.summary !== undefined) checkStr(errors, `${p}.summary`, r.summary, { min: 0, max: 1000 });
    let optionKeys = null; // options of the linked decision; null = no decision linked (or it could not be checked)
    const hasDecision = r.decision !== undefined;
    const hasIndex = r.decisionIndex !== undefined;
    if (hasDecision && hasIndex) {
      errors.push(`${p}: decision과 decisionIndex 중 하나만`);
    } else if (hasDecision) {
      const before = errors.length;
      checkId(errors, `${p}.decision`, r.decision, fns);
      if (errors.length === before) {
        let open = true;
        if (typeof fns.decisionOpen === 'function') { try { open = !!fns.decisionOpen(r.decision); } catch { open = false; } }
        if (!open) errors.push(`${p}.decision: 열린 결정 아님(${r.decision})`);
        else if (typeof fns.decisionOptions === 'function') {
          try { optionKeys = fns.decisionOptions(r.decision); } catch { optionKeys = null; }
          if (!Array.isArray(optionKeys)) { errors.push(`${p}.decision: 결정의 선택지를 읽지 못함(${r.decision})`); optionKeys = null; }
        }
      }
    } else if (hasIndex) {
      const k = r.decisionIndex;
      if (!Number.isInteger(k) || k < 0 || k > 3) errors.push(`${p}.decisionIndex: 0..3 정수 필요`);
      else if (!Array.isArray(v.decisions) || k >= v.decisions.length) errors.push(`${p}.decisionIndex: decisions[${k}] 없음`);
      else {
        const d = v.decisions[k];
        if (isObj(d) && d.id !== undefined && typeof fns.decisionOptions === 'function') {
          // an existing decision keeps its stored options (a brief never rewrites them): check against those
          try { optionKeys = fns.decisionOptions(d.id); } catch { optionKeys = null; }
          if (!Array.isArray(optionKeys)) { errors.push(`${p}.decisionIndex: 결정의 선택지를 읽지 못함(${d.id})`); optionKeys = null; }
        } else {
          optionKeys = isObj(d) && isObj(d.options) ? OPTION_KEYS.filter((o) => d.options[o] !== undefined) : [];
        }
      }
    }
    const imgs = r.images === undefined ? [] : r.images;
    if (!Array.isArray(imgs)) errors.push(`${p}.images: 배열 필요(0..6)`);
    else if (imgs.length > 6) errors.push(`${p}.images: 6개 초과(${imgs.length})`);
    const images = (Array.isArray(imgs) ? imgs : []).map((img, j) => {
      const ip = `${p}.images[${j}]`;
      if (!isObj(img)) { errors.push(`${ip}: 그림 객체 필요`); return img; }
      const why = pathRefusal(img.path);
      if (why) errors.push(`${ip}.path: ${why}`);
      checkStr(errors, `${ip}.alt`, img.alt, { min: 1, max: 200 });
      if (img.option !== undefined) {
        if (!OPTION_KEYS.includes(img.option)) errors.push(`${ip}.option: 허용 값 A|B|C 필요`);
        else if (!hasDecision && !hasIndex) errors.push(`${ip}.option: 연결된 결정 없음(decision 또는 decisionIndex 필요)`);
        else if (optionKeys && !optionKeys.includes(img.option)) errors.push(`${ip}.option: 연결된 결정에 없는 선택지(${img.option})`);
      }
      const out = { path: img.path, alt: img.alt };
      if (img.option !== undefined) out.option = img.option;
      return out;
    });
    const out = { id: r.id, title: r.title };
    if (r.summary !== undefined) out.summary = r.summary;
    if (hasDecision) out.decision = r.decision;
    if (hasIndex) out.decisionIndex = r.decisionIndex;
    out.images = images;
    return out;
  });
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
  checkReports(errors, v, fns);
  const ok = errors.length === 0;
  return { ok, errors, warnings, normalized: ok ? structuredClone(v) : null };
}
