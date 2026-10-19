// Maximal report blocks and input-decision fields for the QA harness (plan todo 12): every array at its maxItems and every
// string at its maxLength, read from the live schema constants (src/schema.mjs REPORT_BLOCK_SCHEMA, DECISION_FIELDS_SCHEMA),
// so a limit change there moves this fixture with it. Text is Korean with single spaces (CJK line breaking is part of what
// the matrix checks); ids keep to their patterns. One deliberate exception: the fourth field is a choice with RADIO_MAX
// options, the most view.js fieldsBox draws as radio buttons (more become a <select>, the third field), so both choice
// renderings are covered at their widest.
import { REPORT_BLOCK_SCHEMA, DECISION_FIELDS_SCHEMA } from '../../src/schema.mjs';

const KIND = Object.fromEntries(REPORT_BLOCK_SCHEMA.items.oneOf.map((s) => [s.properties.kind.const, s.properties]));
const FIELD = Object.fromEntries(DECISION_FIELDS_SCHEMA.items.oneOf.map((s) => [s.properties.kind.const, s.properties]));
export const BLOCK_KINDS = Object.keys(KIND); // schema order: table, bars, kv, flow, checklist, compare
export const RADIO_MAX = 3; // view.js fieldsBox: a choice with <= 3 options is a radio group
export const MAX_REPORT_ID = 'blocks-max';

const WORDS = ('보고서 블록이 가장 큰 크기일 때에도 표와 막대 그래프와 항목표가 화면 밖으로 넘치지 않고 줄을 바꾸어 끝까지 ' +
  '읽히는지 밝은 화면과 어두운 화면에서 모두 확인합니다 결정에 필요한 값은 입력 칸에 적어 보내고 대화는 그 값을 한 번만 받습니다').split(' ');
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Exactly n code points: `head`, then Korean words from word `at` on, one space apart; never ends in a space. */
export function text(n, at = 0, head = '') {
  let s = head;
  for (let i = at; [...s].length <= n; i++) s += (s ? ' ' : '') + WORDS[i % WORDS.length];
  const cps = [...s].slice(0, n);
  if (cps[cps.length - 1] === ' ') cps[cps.length - 1] = '요';
  return cps.join('');
}
const id = (prefix, n) => {
  let s = prefix;
  for (let i = 0; s.length < n; i++) s += ID_CHARS[i % ID_CHARS.length];
  return s.slice(0, n);
};
const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const STATES = KIND.flow.steps.items.properties.state.enum; // done, doing, todo, blocked

/** The six kinds once each (REPORT_BLOCK_SCHEMA.maxItems blocks), every list and string at its limit. link: the compare's
 * decision link, {decisionIndex} in a brief or {decision: id} in a stored report / view model. */
export function maxReportBlocks(link = { decisionIndex: 0 }) {
  const t = KIND.table, cols = t.columns.maxItems;
  if (t.rows.items.maxItems < cols) throw new Error('a table row must hold one cell per column');
  const cell = t.rows.items.items.anyOf.find((x) => x.type === 'string').maxLength;
  const title = (kind, at, head) => text(KIND[kind].title.maxLength, at, head);
  const b = KIND.bars.items, kv = KIND.kv.items, fl = KIND.flow.steps, ch = KIND.checklist.items, cp = KIND.compare.rows;
  const blocks = {
    table: { kind: 'table', title: title('table', 0, '표:'),
      columns: times(cols, (c) => text(t.columns.items.maxLength, c, `${c + 1}열`)),
      rows: times(t.rows.maxItems, (r) => times(cols, (c) => text(cell, r + c, `${r + 1}행 ${c + 1}열`))) },
    bars: { kind: 'bars', title: title('bars', 3, '막대:'), unit: text(KIND.bars.unit.maxLength, 0, 'KB/일(평균)'),
      items: times(b.maxItems, (i) => ({ label: text(b.items.properties.label.maxLength, i, `${i + 1}번`),
        value: i === 0 ? 0 : Math.round((i * i * 137.5 + i / 8) * 100) / 100 })) },
    kv: { kind: 'kv', title: title('kv', 6, '항목:'),
      items: times(kv.maxItems, (i) => ({ key: text(kv.items.properties.key.maxLength, i, `${i + 1}.`),
        value: text(kv.items.properties.value.maxLength, i + 3, `${i + 1}번 값:`) })) },
    flow: { kind: 'flow', title: title('flow', 9, '흐름:'),
      steps: times(fl.maxItems, (i) => ({ label: text(fl.items.properties.label.maxLength, i, `${i + 1}단계`),
        ...(i < fl.maxItems - 1 ? { state: STATES[[0, 0, 0, 1, 3][i] ?? 2] } : {}) })) }, // the last step: no state (todo)
    checklist: { kind: 'checklist', title: title('checklist', 12, '확인:'),
      items: times(ch.maxItems, (i) => ({ id: id(`check-${String(i + 1).padStart(2, '0')}-`, ch.items.properties.id.maxLength),
        text: text(ch.items.properties.text.maxLength, i, `${i + 1}.`) })) },
    compare: { kind: 'compare', title: title('compare', 15, '비교:'), ...link,
      rows: times(cp.maxItems, (i) => ({ label: text(cp.items.properties.label.maxLength, i, `${i + 1}.`),
        ...Object.fromEntries(['A', 'B', 'C'].map((k, j) => [k, text(cp.items.properties[k].maxLength, i + j * 4, `${k}안`)])) })) },
  };
  return BLOCK_KINDS.slice(0, REPORT_BLOCK_SCHEMA.maxItems).map((k) => blocks[k]);
}

/** A brief report carrying maxReportBlocks(link). */
export const maxReport = (link) => ({ id: MAX_REPORT_ID, title: '보고서 블록 최대 크기: 여섯 종류를 모두 한도까지',
  summary: '표, 막대 그래프, 항목, 단계 흐름, 확인 목록, 선택지 비교를 schema 한도 그대로 채운 보고서입니다.', blocks: maxReportBlocks(link) });

/** The A/B/C decision a compare links to (the C column needs option C). */
export const maxCompareDecision = () => ({
  question: '최대 크기 비교표의 세 안 가운데 무엇으로 갈까요?',
  options: { A: { text: '표 그대로', consequence: '줄이 길어도 모두 보인다' }, B: { text: '요약만', consequence: '짧지만 빠지는 칸이 생긴다' },
    C: { text: '나누어 보이기', consequence: '보고서가 두 개로 나뉜다' } },
  recommend: 'C', reason: '모든 값을 잃지 않는다', blocks: false,
});

/** DECISION_FIELDS_SCHEMA.maxItems fields, every id and label at its limit: text (maxLen at its maximum), number, a choice
 * with the most options (a select) and a choice with RADIO_MAX options (radio buttons), each option at its limit. */
export function maxDecisionFields() {
  const idLen = FIELD.text.id.maxLength, label = (at, head) => text(FIELD.text.label.maxLength, at, head);
  const option = (i, head) => text(FIELD.choice.options.items.maxLength, i * 3, head);
  return [
    { id: id('request_title_', idLen), label: label(0, '요청 제목'), kind: 'text', maxLen: FIELD.text.maxLen.maximum },
    { id: id('panel_width_', idLen), label: label(4, '패널 너비'), kind: 'number', min: -50000, max: 50000, step: 0.5 },
    { id: id('layout_choice_', idLen), label: label(8, '배치'), kind: 'choice',
      options: times(FIELD.choice.options.maxItems, (i) => option(i, `${i + 1}안:`)) },
    { id: id('theme_choice_', idLen), label: label(12, '화면 테마'), kind: 'choice', options: times(RADIO_MAX, (i) => option(i + 7, `${i + 1}번 테마:`)) },
  ].slice(0, DECISION_FIELDS_SCHEMA.maxItems);
}

/** Valid values at the limits: the longest text, the number at max, the last option of each choice. */
export const maxFieldValues = (fields = maxDecisionFields()) => Object.fromEntries(fields.map((f) => [f.id,
  f.kind === 'text' ? text(f.maxLen, 20, '입력값:') : f.kind === 'number' ? f.max : f.options[f.options.length - 1]]));

/** One refusal per field, each as typed on the board: maxLen + 1 characters, a number off the step grid (inside the range),
 * and no choice made. */
export const invalidFieldValues = (fields = maxDecisionFields()) => Object.fromEntries(fields.map((f) => [f.id,
  f.kind === 'text' ? text(f.maxLen + 1, 20, '입력값:') : f.kind === 'number' ? f.min + f.step / 2 : '']));

/** The board's message for each invalid value above (src/page/page.js fieldValues, src/schema.mjs decisionValueErrors). */
export const invalidFieldErrors = (fields = maxDecisionFields()) => Object.fromEntries(fields.map((f) => [f.id,
  f.kind === 'text' ? `1..${f.maxLen}자로 입력해 주세요` : f.kind === 'number' ? `${f.min}부터 ${f.step} 간격으로 입력해 주세요` : '선택지 중 하나를 골라 주세요']));
