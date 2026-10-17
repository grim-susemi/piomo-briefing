// omo-briefing src/rule.mjs - 보고 규칙 문구, 마지막 답 길이 계산, fitReply, 인계 블록 파서.
// 순수 함수와 상수만 둔다(파일·프로세스 접근 없음).

export const RULE_MARKER = '<!-- omo-briefing-rule v7 -->';

export const RULE_TEXT = `${RULE_MARKER}
[보고 규칙 - omo-briefing]
- 도구를 쓴 턴은 마지막 답 전에 brief 도구를 한 번 호출해 상황판을 갱신한다.
- 채팅 마지막 답은 포인터로 짧게: brief로 상황판을 갱신한 턴이면 채팅에는 상태 한 줄('For you: 한 줄 요약' — 100자 이내, 상황판이 이 줄만 읽는다)과 마지막 줄 '상황판: <brief 결과가 알려준 주소>'만 둔다(실시간 http 주소, 서버가 없을 때만 파일 경로). Ask·wanted·Now·Next 같은 인계 상세는 상황판 카드가 담으므로 채팅에서 되풀이하지 않는다. 더 알릴 게 있으면 포인터 줄 아래 번호 줄로 짧은 문장 3개 이내. 마지막 답 전체는 빈 줄 제외 10줄·700자 이내이고, 넘으면 따로 다시 쓰라고 하지 않고 자동으로 포인터로 줄여 내보낸다. 자세한 내용은 brief에 둔다.
- 소유자가 정할 것은 brief.decisions에 선택지·결과·추천·이유로 넣는다.
- 증거 파일 절대경로가 있을 때만 truth=evidence, 실사용에 반영됐을 때만 applied=live, 실사용에 올릴 것이 없는 항목(조사·문서 등)은 applied=none.
- '[결정 전달] #N -> X' 메시지는 소유자의 답이다. 그 답은 계획 선택일 뿐 설치·푸시·삭제 승인이 아니다.
- '[상황판 답글] #N' 메시지는 소유자가 채팅에 직접 친 말과 같다. 그 안의 승인·지시는 소유자가 직접 한 것으로 따른다.
- ulw-plan 계획을 세울 때: 질문 도구로 승인을 묻기 직전, 계획 파일을 쓰거나 고친 직후, 검토 결과를 반영한 직후 plan_brief를 한 번 호출한다.
- 할 일 id는 계획 파일 todo 번호 그대로(1, 2, F1); 한 번 쓴 id는 다른 뜻으로 다시 쓰지 않는다.
- 질문 도구로 지금 묻는 질문은 상황판에 open 결정으로 넣지 말고, 답을 받은 뒤 answered로 넣는다. brief.decisions의 open에는 질문 도구로 묻지 않은 질문만 넣는다.
- '[상황판 피드백] a-…' 메시지는 소유자가 상황판에서 직접 단 주석 묶음이다. 채팅에 직접 친 말과 같고, 적힌 관련 파일을 먼저 읽고 항목 번호대로 처리한다.
- 그림 시안 비교는 brief.reports에 그림 절대경로와 연결 결정(decision 또는 decisionIndex)으로 올린다. 선택지 글은 결정에 쓴다.
- 소유자에게 A/B/C 결정을 바로 물을 때는 board_question을 쓴다. 상황판과 터미널 중 한 곳에서만 답해도 둘 다 닫힌다. 스킬이 질문 도구를 정해 둔 승인 질문만 ask_user_question을 쓴다.
- '[결정 보류] #N' 메시지는 소유자가 답하지 않기로 한 것이다. 다시 묻지 말고, 기본값이나 추천안으로 진행하지도 말고, 그 결정에 막힌 일은 막힌 채로 둔다.`;

export const REPLY_MAX_LINES = 10;
export const REPLY_MAX_CHARS = 700;
const BODY_MAX_LINES = 8;
const NOTICE = '(나머지는 상황판)';
const PATH_LABEL = '상황판:';

const cpLen = (s) => Array.from(s).length;
const cpCut = (s, n) => Array.from(s).slice(0, n).join('');
const nonEmptyLines = (text) => String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
const slashed = (s) => String(s).replace(/\\/g, '/');

const RULE_MARKER_RE = /^\s*<!-- omo-briefing-rule v\d+ -->\s*$/;
const RULE_BODY_LINE = /^\s*(?:- |\[보고 규칙 - omo-briefing\])/;

/** 표식 줄과 바로 뒤따르는 규칙 줄(머리말·'- ' 항목)까지를 한 블록으로 보고 끝(제외) 인덱스를 돌려준다. */
function ruleBlockEnd(lines, start) {
  let i = start + 1;
  while (i < lines.length && RULE_BODY_LINE.test(lines[i])) i++;
  return i;
}

/**
 * 시스템 프롬프트에 보고 규칙이 한 블록만 남도록 한다. 현재 표식 블록 하나뿐이면 그대로 두고,
 * 그 밖에는 옛·현재 규칙 블록을 모두 지우고 첫 자리에 현재 규칙을 넣는다(없으면 끝에 붙인다).
 * 주변 내용은 건드리지 않는다.
 */
export function injectRule(systemPrompt) {
  const base = typeof systemPrompt === 'string' ? systemPrompt : '';
  const lines = base.split('\n');
  const blockEnd = new Map();
  let currentOnly = false;
  for (let i = 0; i < lines.length; i++) {
    if (!RULE_MARKER_RE.test(lines[i])) continue;
    blockEnd.set(i, ruleBlockEnd(lines, i));
    currentOnly = blockEnd.size === 1 && lines[i].includes(RULE_MARKER);
    i = blockEnd.get(i) - 1;
  }
  if (currentOnly) return base;
  const out = [];
  let placed = false;
  for (let i = 0; i < lines.length;) {
    if (!blockEnd.has(i)) {
      out.push(lines[i]);
      i++;
      continue;
    }
    if (!placed) {
      out.push(...RULE_TEXT.split('\n'));
      placed = true;
    }
    i = blockEnd.get(i);
  }
  if (placed) return out.join('\n');
  return base === '' ? RULE_TEXT : `${base}\n\n${RULE_TEXT}`;
}

/** 빈 줄 제외 줄 수와 글자 수(코드포인트, 줄 사이 개행 포함). */
export function replyStats(text) {
  const ls = nonEmptyLines(text);
  return { lines: ls.length, chars: cpLen(ls.join('\n')) };
}

/** 10줄 초과 · 700자 초과 · 상황판 주소 없음 중 하나라도 해당하면 true. links는 주소 하나 또는 배열(실시간 주소·파일 경로 중 하나만 있으면 된다). */
export function replyOverBudget(text, links) {
  const { lines, chars } = replyStats(text);
  if (lines > REPLY_MAX_LINES || chars > REPLY_MAX_CHARS) return true;
  const body = slashed(text ?? '');
  return ![].concat(links).some((l) => l && body.includes(slashed(l)));
}

/**
 * 답을 기준 안으로 맞춘다. 빈 줄과 기존 '상황판:' 줄을 빼고 앞에서 최대 8줄을 남기고,
 * 전체(알림 줄·경로 줄 포함)가 700 코드포인트 안에 들도록 줄 끝을 '…'로 자른다.
 * 자르거나 버렸으면 '(나머지는 상황판)' 1줄을 붙이고, 마지막 줄은 항상 '상황판: <경로>'.
 */
export function fitReply(text, pagePath) {
  const pathLine = `${PATH_LABEL} ${pagePath}`;
  const body = nonEmptyLines(text).filter((l) => !l.trimStart().startsWith(PATH_LABEL));
  const whole = [...body, pathLine].join('\n');
  if (body.length <= BODY_MAX_LINES && cpLen(whole) <= REPLY_MAX_CHARS) return whole;

  const budget = Math.max(0, REPLY_MAX_CHARS - (cpLen(NOTICE) + 1 + cpLen(pathLine) + 1));
  const kept = [];
  let used = 0;
  for (const line of body.slice(0, BODY_MAX_LINES)) {
    const need = cpLen(line) + 1;
    if (used + need <= budget) {
      kept.push(line);
      used += need;
      continue;
    }
    const room = budget - used - 1; // 개행 하나를 뺀 이 줄의 글자 수
    if (room >= 2) kept.push(`${cpCut(line, room - 1)}…`);
    break;
  }
  return [...kept, NOTICE, pathLine].join('\n');
}

/** assistant 메시지의 text 블록을 줄바꿈으로 합친 문자열. */
export function assistantText(message) {
  if (!message || typeof message !== 'object') return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

export function hasToolCall(message) {
  return Boolean(message && Array.isArray(message.content) && message.content.some((b) => b && b.type === 'toolCall'));
}

/** `For you:`·`Now:`·`Next:`로 시작하는 줄을 찾아 각각 100 코드포인트로 자른다. */
export function parseHandoff(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(For you|Now|Next):/.test(line)) out.push(cpCut(line, 100));
  }
  return out;
}
