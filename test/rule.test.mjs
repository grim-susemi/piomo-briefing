import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULE_MARKER, RULE_TEXT, REWRITE_PROMPT, REPLY_MAX_LINES, REPLY_MAX_CHARS,
  injectRule, replyStats, replyOverBudget, fitReply, assistantText, hasToolCall, parseHandoff,
} from '../src/rule.mjs';

const PAGE = 'C:/state/index.html';
const cp = (s) => [...s].length;
const lines = (s) => s.split('\n').filter((l) => l.trim() !== '');

function assertFits(out, page = PAGE) {
  const ls = lines(out);
  assert.ok(ls.length <= 10, `lines ${ls.length}`);
  assert.ok(cp(ls.join('\n')) <= 700, `chars ${cp(ls.join('\n'))}`);
  assert.equal(ls.at(-1), `상황판: ${page}`);
}

test('rule text carries the marker and the owner-decision caveat', () => {
  assert.ok(RULE_TEXT.startsWith(RULE_MARKER));
  assert.equal(RULE_MARKER, '<!-- omo-briefing-rule v2 -->');
  assert.ok(RULE_TEXT.includes('[결정 전달] #N -> X'));
  assert.ok(RULE_TEXT.includes('10줄·700자'));
});

test('injectRule appends once and never twice', () => {
  const once = injectRule('base prompt');
  assert.ok(once.startsWith('base prompt'));
  assert.equal(once.split(RULE_MARKER).length - 1, 1);
  assert.equal(injectRule(once), once);
});

test('REWRITE_PROMPT is the exact plan sentence', () => {
  assert.equal(REWRITE_PROMPT, "[보고 길이] 직전 답이 길거나 상황판 경로가 없어. '상황판: <절대경로>'를 포함해 3문장 이내로 마지막 답만 다시 써. 도구는 쓰지 마.");
});

test('replyStats ignores blank lines and counts code points', () => {
  assert.deepEqual(replyStats('가나\n\n  \n다'), { lines: 2, chars: cp('가나\n다') });
  assert.deepEqual(replyStats(''), { lines: 0, chars: 0 });
});

test('replyOverBudget: within, too many lines, too many chars, missing path', () => {
  const ok = ['a', 'b', `상황판: ${PAGE}`].join('\n');
  assert.equal(replyOverBudget(ok, PAGE), false);
  const eight = [...Array(7).fill('x'), `상황판: ${PAGE}`].join('\n');
  assert.equal(replyOverBudget(eight, PAGE), false);
  assert.equal(replyOverBudget('8줄이지만 경로 없음\n' + Array(7).fill('x').join('\n'), PAGE), true);
  const fifteen = [...Array(14).fill('x'), `상황판: ${PAGE}`].join('\n');
  assert.equal(replyOverBudget(fifteen, PAGE), true);
  const long = `${'가'.repeat(701)}\n상황판: ${PAGE}`;
  assert.equal(replyOverBudget(long, PAGE), true);
  const exactly700 = '가'.repeat(700 - cp(`\n상황판: ${PAGE}`)) + `\n상황판: ${PAGE}`;
  assert.equal(cp(exactly700), 700);
  assert.equal(replyOverBudget(exactly700, PAGE), false);
  assert.equal(REPLY_MAX_LINES, 10);
  assert.equal(REPLY_MAX_CHARS, 700);
});

test('replyOverBudget accepts a backslash spelling of the page path', () => {
  assert.equal(replyOverBudget('요약\n상황판: C:\\state\\index.html', PAGE), false);
});

test('fitReply: 30 lines / 2000 chars / no path -> within budget, last line is the path', () => {
  const text = Array.from({ length: 30 }, (_, i) => `줄 ${i} ${'가'.repeat(60)}`).join('\n');
  assert.ok(cp(text) > 1500);
  const out = fitReply(text, PAGE);
  assertFits(out);
  assert.ok(lines(out).includes('(나머지는 상황판)'));
});

test('fitReply: one 900-char line is cut to fit and keeps the path', () => {
  const out = fitReply('가'.repeat(900), PAGE);
  assertFits(out);
  assert.ok(out.includes('…'));
});

test('fitReply: already fine input with a final path line is returned unchanged', () => {
  const text = `끝났어\n두 번째 줄\n상황판: ${PAGE}`;
  assert.equal(fitReply(text, PAGE), text);
});

test('fitReply drops an existing 상황판 line and puts exactly one at the end', () => {
  const out = fitReply(`상황판: D:/elsewhere/x.html\n본문\n상황판: ${PAGE}\n뒷줄`, PAGE);
  assertFits(out);
  assert.equal(lines(out).filter((l) => l.startsWith('상황판:')).length, 1);
  assert.ok(!out.includes('D:/elsewhere'));
});

test('fitReply keeps at most 8 body lines and says the rest is on the board', () => {
  const out = fitReply(Array.from({ length: 9 }, (_, i) => `줄${i}`).join('\n'), PAGE);
  assertFits(out);
  const ls = lines(out);
  assert.equal(ls.length, 10);
  assert.equal(ls[8], '(나머지는 상황판)');
});

test('fitReply handles empty text', () => {
  const out = fitReply('', PAGE);
  assert.equal(out, `상황판: ${PAGE}`);
});

test('fitReply handles code points beyond the BMP without splitting them', () => {
  const out = fitReply('😀'.repeat(900), PAGE);
  assertFits(out);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(out));
});

test('assistantText joins text blocks; hasToolCall sees toolCall blocks', () => {
  const m = { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'A' }, { type: 'text', text: 'B' }] };
  assert.equal(assistantText(m), 'A\nB');
  assert.equal(hasToolCall(m), false);
  assert.equal(hasToolCall({ role: 'assistant', content: [{ type: 'toolCall', name: 'x' }] }), true);
  assert.equal(assistantText({ role: 'assistant', content: 'plain' }), 'plain');
  assert.equal(assistantText(null), '');
});

test('parseHandoff picks For you/Now/Next lines, each cut at 100 code points', () => {
  const long = 'For you: ' + '가'.repeat(150);
  const out = parseHandoff(`Ask: 무엇\n${long}\n  Now: 쓰는 중\nnoise\nNext: 다음`);
  assert.equal(out.length, 3);
  assert.equal(cp(out[0]), 100);
  assert.equal(out[1], 'Now: 쓰는 중');
  assert.equal(out[2], 'Next: 다음');
  assert.deepEqual(parseHandoff('그냥 글'), []);
});

test('rule v2 names plan_brief; an older v1 rule in the prompt does not stop v2 from being added once', () => {
  assert.ok(RULE_TEXT.includes('plan_brief'));
  const withOld = injectRule('base\n<!-- omo-briefing-rule v1 -->\nold rule');
  assert.equal(withOld.split(RULE_MARKER).length - 1, 1);
  assert.equal(injectRule(withOld), withOld);
});
