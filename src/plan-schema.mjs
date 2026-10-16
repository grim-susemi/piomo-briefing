// omo-briefing src/plan-schema.mjs — plan_brief 입력 계약·planId·도구 매개변수 스키마
//
// planId는 계획 파일 경로에서 계산한다: planIdOf(root, slug) = 'p' + sha256(root + '\n' + slug)의 앞 12 hex.
// root는 `.omo`를 담은 폴더, slug는 확장자를 뗀 파일명. 둘 다 소문자·NFC·'/' 구분자로 정규화하고 끝 구분자는
// 떼고 보므로, 같은 파일을 표기만 달리해도(대소문자·NFD·역슬래시·끝 슬래시) 같은 planId가 나온다.
// 검사기 자체는 fs를 쓰지 않고 절대 던지지 않는다 - 존재 확인은 주입된 fileExists로만 한다.
// 못 읽음(주입 함수가 던짐)은 없음과 다르게 '<필드>: 읽기 실패(<코드>)'로 보고해 오류 신원을 지킨다.
import { createHash } from 'node:crypto';
import { checkStr, checkDecisionOptions } from './schema.mjs';

const obj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAbs = (s) => /^[A-Za-z]:[\\/]/.test(s);

export const PLAN_STAGES = ['shaping', 'gate', 'review', 'ready', 'running', 'done', 'dropped'];
export const PLAN_Q_STATES = ['open', 'answered', 'default'];
export const PLAN_Q_BY = ['owner', 'agent'];
export const PLAN_OPEN_LIMIT = 4;

const SLUG_RE = /[\\/]\.omo[\\/](plans|drafts)[\\/]([^\\/]+)\.md$/i;
const TASK_ID_RE = /^F?\d{1,3}[a-z]?$/;
const IS_ID_RE = /^IS-\d{1,2}$/;
const Q_ID_RE = /^Q\d{1,3}$/;

const TOP_KEYS = new Set([
  'planPath', 'draftPath', 'stage', 'stageNote', 'goal',
  'ideal', 'components', 'waves', 'tasks', 'questions', 'outOfScope',
]);
const IS_KEYS = new Set(['id', 'text']);
const COMP_KEYS = new Set(['id', 'label', 'text']);
const WAVE_KEYS = new Set(['n', 'label']);
const TASK_KEYS = new Set(['id', 'wave', 'label', 'what', 'done', 'deps']);
const Q_KEYS = new Set(['id', 'text', 'state', 'answer', 'by', 'options', 'recommend', 'reason', 'blocks', 'decisionId']);

const normPart = (s) => String(s).normalize('NFC').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');

export function planIdOf(root, slug) {
  const key = `${normPart(root)}\n${normPart(slug)}`;
  return 'p' + createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

// 절대경로에서 `.omo` 상위 폴더(root, 소문자·NFC·'/' 구분자로 정규화)와 확장자를 뗀 파일명(slug)을 꺼낸다.
// 계획·초안이 아니면 null. root를 planId와 같은 규칙으로 정규화하므로 표기만 다른 경로가 같은 값을 낸다.
export function rootAndSlugOf(absPath) {
  if (typeof absPath !== 'string' || !isAbs(absPath)) return null;
  const m = SLUG_RE.exec(absPath);
  if (!m) return null;
  const root = normPart(absPath.slice(0, m.index));
  if (!(isAbs(root) || /^[a-z]:$/.test(root))) return null;
  return { root, slug: m[2] };
}

function checkUnknown(errors, path, item, allowed) {
  const prefix = path ? `${path}.` : '';
  for (const k of Object.keys(item)) {
    if (!allowed.has(k)) errors.push(`${prefix}${k}: 알 수 없는 필드`);
  }
}

function checkArray(errors, v, name, max) {
  const arr = v[name];
  if (!Array.isArray(arr)) { errors.push(`${name}: 배열 필요(0..${max})`); return null; }
  if (arr.length > max) errors.push(`${name}: ${max}개 초과(${arr.length})`);
  return arr;
}

// 주입 함수가 던지면 '없음'으로 치지 않는다: 오류의 코드와 메시지를 보존해 호출자가 못 읽음과
// 없음(또는 남의 결정)을 구분할 수 있게 한다. 검사기 자체는 여전히 절대 던지지 않는다.
function probeError(err) {
  const code = (err && typeof err.code === 'string' && err.code) || (err && typeof err.name === 'string' && err.name) || 'Error';
  const msg = err && err.message ? ` - ${String(err.message).slice(0, 80)}` : '';
  return `${code}${msg}`;
}

function probe(fn, arg) {
  if (typeof fn !== 'function') return { skipped: true };
  try { return { value: fn(arg) }; } catch (err) { return { error: probeError(err) }; }
}

/**
 * plan_brief 입력 검사.
 * @param {object} input 에이전트가 보낸 매개변수
 * @param {{fileExists?: (p: string) => boolean, isOwnOpenDecision?: (id: number) => boolean}} fns 주입 함수
 * @returns {{ok: boolean, errors: string[], normalized: object|null, planId: string|null}}
 */
export function validatePlanBrief(input, fns = {}) {
  const errors = [];
  if (!obj(input)) return { ok: false, errors: ['입력: 객체 필요'], normalized: null, planId: null };
  const f = obj(fns) ? fns : {};
  let v;
  try { v = structuredClone(input); } catch { return { ok: false, errors: ['입력: 복사할 수 없는 값 포함'], normalized: null, planId: null }; }
  checkUnknown(errors, '', v, TOP_KEYS);

  // 경로: 둘 중 최소 하나, `.omo/plans|drafts` 안의 .md 절대경로, 있고 읽을 수 있어야 한다.
  let source = null;
  for (const name of ['planPath', 'draftPath']) {
    const value = v[name];
    if (value === undefined) continue;
    const rs = rootAndSlugOf(value);
    if (!rs) { errors.push(`${name}: 절대경로 필요(.omo/plans 또는 .omo/drafts 안의 .md)`); continue; }
    if (source === null) source = rs;
    const read = probe(f.fileExists, value);
    if (read.error !== undefined) errors.push(`${name}: 읽기 실패(${read.error})`);
    else if (!read.skipped && !read.value) errors.push(`${name}: 파일 없음(${value})`);
  }
  if (v.planPath === undefined && v.draftPath === undefined) {
    errors.push('planPath: 계획 파일 또는 초안 경로 필요(최소 하나)');
  }

  if (!PLAN_STAGES.includes(v.stage)) errors.push(`stage: 허용 값 ${PLAN_STAGES.join('|')} 필요`);
  checkStr(errors, 'stageNote', v.stageNote, { min: 0, max: 40 });
  checkStr(errors, 'goal', v.goal, { min: 1, max: 80 });

  const ideal = checkArray(errors, v, 'ideal', 8);
  if (ideal) {
    const seen = new Set();
    ideal.forEach((it, i) => {
      const p = `ideal[${i}]`;
      if (!obj(it)) { errors.push(`${p}: 항목 객체 필요`); return; }
      checkUnknown(errors, p, it, IS_KEYS);
      if (typeof it.id !== 'string' || !IS_ID_RE.test(it.id)) errors.push(`${p}.id: IS-1 형식 필요`);
      else if (seen.has(it.id)) errors.push(`${p}.id: 중복된 id(${it.id})`);
      else seen.add(it.id);
      checkStr(errors, `${p}.text`, it.text, { min: 1, max: 80 });
    });
  }

  const comps = checkArray(errors, v, 'components', 8);
  if (comps) {
    const seen = new Set();
    comps.forEach((it, i) => {
      const p = `components[${i}]`;
      if (!obj(it)) { errors.push(`${p}: 항목 객체 필요`); return; }
      checkUnknown(errors, p, it, COMP_KEYS);
      checkStr(errors, `${p}.id`, it.id, { min: 1, max: 12 });
      if (typeof it.id === 'string') {
        if (seen.has(it.id)) errors.push(`${p}.id: 중복된 id(${it.id})`);
        else seen.add(it.id);
      }
      checkStr(errors, `${p}.label`, it.label, { min: 1, max: 14 });
      checkStr(errors, `${p}.text`, it.text, { min: 0, max: 60 });
    });
  }

  const waves = checkArray(errors, v, 'waves', 10);
  const waveNs = new Set();
  if (waves) {
    const seen = new Set();
    waves.forEach((it, i) => {
      const p = `waves[${i}]`;
      if (!obj(it)) { errors.push(`${p}: 항목 객체 필요`); return; }
      checkUnknown(errors, p, it, WAVE_KEYS);
      if (!Number.isInteger(it.n) || it.n < 1 || it.n > 99) errors.push(`${p}.n: 1..99 정수 필요(${it.n})`);
      else if (seen.has(it.n)) errors.push(`${p}.n: 중복된 wave(${it.n})`);
      else { seen.add(it.n); waveNs.add(it.n); }
      checkStr(errors, `${p}.label`, it.label, { min: 1, max: 14 });
    });
  }

  const tasks = checkArray(errors, v, 'tasks', 40);
  if (tasks) {
    const ids = new Set();
    for (const t of tasks) if (obj(t) && typeof t.id === 'string') ids.add(t.id);
    const seen = new Set();
    tasks.forEach((t, i) => {
      const p = `tasks[${i}]`;
      if (!obj(t)) { errors.push(`${p}: 항목 객체 필요`); return; }
      checkUnknown(errors, p, t, TASK_KEYS);
      if (typeof t.id !== 'string' || !TASK_ID_RE.test(t.id)) errors.push(`${p}.id: F?\\d{1,3}[a-z]? 형식 필요(예: 7, F1)`);
      else if (seen.has(t.id)) errors.push(`${p}.id: 중복된 id(${t.id})`);
      else seen.add(t.id);
      if (!waveNs.has(t.wave)) errors.push(`${p}.wave: waves에 없는 wave(${t.wave})`);
      checkStr(errors, `${p}.label`, t.label, { min: 1, max: 14 });
      checkStr(errors, `${p}.what`, t.what, { min: 1, max: 50 });
      checkStr(errors, `${p}.done`, t.done, { min: 1, max: 50 });
      const deps = t.deps;
      if (!Array.isArray(deps)) { errors.push(`${p}.deps: 배열 필요(0..12)`); return; }
      if (deps.length > 12) errors.push(`${p}.deps: 12개 초과(${deps.length})`);
      deps.forEach((d, j) => {
        if (typeof d !== 'string' || !TASK_ID_RE.test(d)) { errors.push(`${p}.deps[${j}]: 할 일 id 형식 필요`); return; }
        if (d === t.id) errors.push(`${p}.deps[${j}]: 자기 자신을 가리킴(${d})`);
        else if (!ids.has(d)) errors.push(`${p}.deps[${j}]: 같은 입력에 없는 할 일 id(${d})`);
      });
    });
  }

  const questions = checkArray(errors, v, 'questions', 12);
  if (questions) {
    const seen = new Set();
    let open = 0;
    questions.forEach((q, i) => {
      const p = `questions[${i}]`;
      if (!obj(q)) { errors.push(`${p}: 항목 객체 필요`); return; }
      checkUnknown(errors, p, q, Q_KEYS);
      if (typeof q.id !== 'string' || !Q_ID_RE.test(q.id)) errors.push(`${p}.id: Q1 형식 필요`);
      else if (seen.has(q.id)) errors.push(`${p}.id: 중복된 id(${q.id})`);
      else seen.add(q.id);
      checkStr(errors, `${p}.text`, q.text, { min: 1, max: 100 });
      if (!PLAN_Q_STATES.includes(q.state)) { errors.push(`${p}.state: 허용 값 ${PLAN_Q_STATES.join('|')} 필요`); return; }
      if (q.state === 'open') {
        open += 1;
        checkDecisionOptions(errors, p, q); // brief 결정과 같은 규칙(선택지 A·B 필수)
      } else {
        checkStr(errors, `${p}.answer`, q.answer, { min: 1, max: 60 });
        if (!PLAN_Q_BY.includes(q.by)) errors.push(`${p}.by: 허용 값 ${PLAN_Q_BY.join('|')} 필요`);
      }
      if (q.decisionId === undefined) return;
      if (!Number.isInteger(q.decisionId) || q.decisionId <= 0) {
        errors.push(`${p}.decisionId: 양의 정수 필요`);
      } else if (typeof f.isOwnOpenDecision !== 'function') {
        errors.push(`${p}.decisionId: 결정 조회 필요(조회 함수 없음)`);
      } else {
        const own = probe(f.isOwnOpenDecision, q.decisionId);
        if (own.error !== undefined) errors.push(`${p}.decisionId: 결정 조회 실패(${own.error})`);
        else if (!own.value) errors.push(`${p}.decisionId: 이 세션의 열린 결정이 아님(${q.decisionId})`);
      }
    });
    if (open > PLAN_OPEN_LIMIT) errors.push(`questions: 열린 질문 ${PLAN_OPEN_LIMIT}개 초과(${open})`);
  }

  const oos = checkArray(errors, v, 'outOfScope', 6);
  if (oos) oos.forEach((s, i) => checkStr(errors, `outOfScope[${i}]`, s, { min: 1, max: 60 }));

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    normalized: ok ? structuredClone(v) : null,
    planId: ok && source ? planIdOf(source.root, source.slug) : null,
  };
}

const optionSchema = {
  type: 'object',
  properties: { text: { type: 'string' }, consequence: { type: 'string' } },
  required: ['text', 'consequence'],
};

export const PLAN_BRIEF_PARAMETERS = {
  type: 'object',
  properties: {
    planPath: { type: 'string' },
    draftPath: { type: 'string' },
    stage: { type: 'string', enum: [...PLAN_STAGES] },
    stageNote: { type: 'string' },
    goal: { type: 'string' },
    ideal: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
    },
    components: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'label', 'text'],
      },
    },
    waves: {
      type: 'array',
      items: { type: 'object', properties: { n: { type: 'integer' }, label: { type: 'string' } }, required: ['n', 'label'] },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          wave: { type: 'integer' },
          label: { type: 'string' },
          what: { type: 'string' },
          done: { type: 'string' },
          deps: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'wave', 'label', 'what', 'done', 'deps'],
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          state: { type: 'string', enum: [...PLAN_Q_STATES] },
          answer: { type: 'string' },
          by: { type: 'string', enum: [...PLAN_Q_BY] },
          options: { type: 'object', properties: { A: optionSchema, B: optionSchema, C: optionSchema } },
          recommend: { type: 'string', enum: ['A', 'B', 'C'] },
          reason: { type: 'string' },
          blocks: { type: 'boolean' },
          decisionId: { type: 'number' },
        },
        required: ['id', 'text', 'state'],
      },
    },
    outOfScope: { type: 'array', items: { type: 'string' } },
  },
  required: ['stage', 'stageNote', 'goal', 'ideal', 'components', 'waves', 'tasks', 'questions', 'outOfScope'],
};

export const PLAN_BRIEF_DESCRIPTION = [
  '계획(ulw-plan)을 상황판 계획 보기에 올리는 도구. 계획 파일을 쓰거나 고친 뒤, 검토를 반영한 뒤, 승인을 묻기 직전에 한 번 호출한다.',
  '한도(유니코드 글자 수, 넘으면 필드명·한도가 오류로 돌아옴): planPath 또는 draftPath 최소 하나(절대경로, .omo/plans|drafts 안 .md, 존재해야 함),',
  'stage shaping|gate|review|ready|running|done|dropped, stageNote 0..40, goal 1..80, ideal ≤8{id IS-1, text 1..80},',
  'components ≤8{id 1..12, label 1..14, text 0..60}, waves ≤10{n 1..99, label 1..14},',
  'tasks ≤40{id 7|F1 형식, wave(waves 안), label 1..14, what 1..50, done 1..50, deps ≤12(같은 호출의 id만)},',
  'questions ≤12{id Q1, text 1..100, state open|answered|default, answered·default는 answer 1..60과 by owner|agent,',
  'open은 options A·B(·C){text 1..60, consequence 1..80}·recommend·reason·blocks, 한 번에 최대 4개}, outOfScope ≤6(각 1..60).',
  '할 일 id는 계획 파일 번호 그대로 쓰고, 한 번 쓴 id는 다른 뜻으로 다시 쓰지 않는다.',
].join('\n');
