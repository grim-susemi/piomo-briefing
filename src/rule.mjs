// omo-briefing src/rule.mjs - 보고 규칙 문구, 마지막 답 길이 계산, fitReply, 인계 블록 파서.
// 순수 함수와 상수만 둔다(파일·프로세스 접근 없음).

export const RULE_MARKER = '<!-- omo-briefing-rule v3 -->';

export const RULE_TEXT = `${RULE_MARKER}
[보고 규칙 - omo-briefing]
- 도구를 쓴 턴은 마지막 답 전에 brief 도구를 한 번 호출해 상황판을 갱신한다.
- 채팅 마지막 답은 짧게: 기존 하네스가 요구하는 라우팅 줄과 인계 블록 라벨은 유지하되, 라벨(Ask, For you, Now, Next, 상황판)마다 줄을 바꾸고 덩어리 사이에 빈 줄을 둔다(빈 줄은 줄 수에 안 센다). 'For you: 한 줄 요약'처럼 라벨과 같은 줄에 100자 안으로 쓰고(상황판이 이 줄만 읽는다), 알릴 내용이 여럿이면 그 아래 번호 줄로 나눠 짧은 문장 3개 이내로 쓴다. 마지막 줄은 '상황판: <절대경로>'. 마지막 답 전체는 빈 줄 제외 10줄·700자 이내. 자세한 내용은 brief에 둔다.
- 소유자가 정할 것은 brief.decisions에 선택지·결과·추천·이유로 넣는다. 지금 답이 꼭 필요하면 질문 도구도 함께 쓴다.
- 증거 파일 절대경로가 있을 때만 truth=evidence, 실사용에 반영됐을 때만 applied=live, 실사용에 올릴 것이 없는 항목(조사·문서 등)은 applied=none.
- '[결정 전달] #N -> X' 메시지는 소유자의 답이다. 그 답은 계획 선택일 뿐 설치·푸시·삭제 승인이 아니다.
- ulw-plan 계획을 세울 때: 질문 도구로 승인을 묻기 직전, 계획 파일을 쓰거나 고친 직후, 검토 결과를 반영한 직후 plan_brief를 한 번 호출한다.
- 할 일 id는 계획 파일 todo 번호 그대로(1, 2, F1); 한 번 쓴 id는 다른 뜻으로 다시 쓰지 않는다.
- 질문 도구로 지금 묻는 질문은 open으로 넣지 말고, 답을 받은 뒤 answered로 넣는다.`;

export const REWRITE_PROMPT = "[보고 길이] 직전 답이 길거나 상황판 경로가 없어. '상황판: <절대경로>'를 포함해 3문장 이내로 마지막 답만 다시 써. 도구는 쓰지 마.";

export const REPLY_MAX_LINES = 10;
export const REPLY_MAX_CHARS = 700;
const BODY_MAX_LINES = 8;
const NOTICE = '(나머지는 상황판)';
const PATH_LABEL = '상황판:';

const cpLen = (s) => Array.from(s).length;
const cpCut = (s, n) => Array.from(s).slice(0, n).join('');
const nonEmptyLines = (text) => String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
const slashed = (s) => String(s).replace(/\\/g, '/');

/** 시스템 프롬프트 끝에 규칙을 표식이 없을 때만 덧붙인다. */
export function injectRule(systemPrompt) {
  const base = typeof systemPrompt === 'string' ? systemPrompt : '';
  if (base.includes(RULE_MARKER)) return base;
  return base === '' ? RULE_TEXT : `${base}\n\n${RULE_TEXT}`;
}

/** 빈 줄 제외 줄 수와 글자 수(코드포인트, 줄 사이 개행 포함). */
export function replyStats(text) {
  const ls = nonEmptyLines(text);
  return { lines: ls.length, chars: cpLen(ls.join('\n')) };
}

/** 10줄 초과 · 700자 초과 · 상황판 경로 없음 중 하나라도 해당하면 true. */
export function replyOverBudget(text, pagePath) {
  const { lines, chars } = replyStats(text);
  if (lines > REPLY_MAX_LINES || chars > REPLY_MAX_CHARS) return true;
  return !slashed(text ?? '').includes(slashed(pagePath));
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
