import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULE_MARKER, RULE_TEXT, REPLY_MAX_LINES, REPLY_MAX_CHARS,
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

test('rule v8 carries exactly one current marker', () => {
  assert.ok(RULE_TEXT.startsWith(RULE_MARKER));
  assert.equal(RULE_MARKER, '<!-- omo-briefing-rule v8 -->');
  assert.equal((RULE_TEXT.match(/<!-- omo-briefing-rule v\d+ -->/g) ?? []).length, 1);
});

test('replyOverBudget accepts the live url or the file path when given both', () => {
  const URL = 'http://127.0.0.1:47317/';
  assert.equal(replyOverBudget(`끝\n상황판: ${URL}`, [URL, PAGE]), false);
  assert.equal(replyOverBudget(`끝\n상황판: ${PAGE}`, [URL, PAGE]), false);
  assert.equal(replyOverBudget('끝', [URL, PAGE]), true);
  assert.equal(replyOverBudget(`끝\n상황판: ${URL}`, [null, PAGE]), true, 'no server: only the file path counts');
});

test('injectRule appends once and never twice', () => {
  const once = injectRule('base prompt');
  assert.ok(once.startsWith('base prompt'));
  assert.equal(once.split(RULE_MARKER).length - 1, 1);
  assert.equal(injectRule(once), once);
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

test('injectRule migrates v6 and v7 blocks to one v8 block in either order', () => {
  for (const versions of [[6, 7], [7, 6]]) {
    const input = `HEAD\n\n${block(versions[0])}\n\nMID\n\n${block(versions[1])}\n\nTAIL`;
    const out = injectRule(input);
    assert.deepEqual(out.match(/<!-- omo-briefing-rule v\d+ -->/g), ['<!-- omo-briefing-rule v8 -->']);
    for (const kept of ['HEAD', 'MID', 'TAIL']) assert.ok(out.includes(kept));
    assert.equal(injectRule(injectRule(out)), out);
  }
});

test('an older-version rule block in the prompt is replaced by the current block, never duplicated', () => {
  const oldMarker = ['<!-- omo-briefing-rule v', '5 -->'].join('');
  const stale = RULE_TEXT.replace(RULE_MARKER, oldMarker);
  const out = injectRule(`앞머리 지시문\n둘째 줄\n\n${stale}\n\n뒤따르는 지시문`);
  assert.equal(out.includes(oldMarker), false, 'the stale marker is gone');
  assert.equal((out.match(/<!-- omo-briefing-rule v\d+ -->/g) ?? []).length, 1, 'exactly one rule block');
  assert.equal(out.split(RULE_MARKER).length - 1, 1, 'the one block is the current rule');
  for (const kept of ['앞머리 지시문', '둘째 줄', '뒤따르는 지시문']) assert.ok(out.includes(kept), `kept ${kept}`);
  assert.equal(injectRule(out), out, 'reinjection is idempotent');
});

test('a prompt holding both a stale and the current rule block ends with exactly one current block', () => {
  const oldMarker = ['<!-- omo-briefing-rule v', '5 -->'].join('');
  const stale = RULE_TEXT.replace(RULE_MARKER, oldMarker);
  for (const input of [`HEAD\n\n${stale}\n\n${RULE_TEXT}\n\nTAIL`, `HEAD\n\n${RULE_TEXT}\n\n${stale}\n\nTAIL`]) {
    const out = injectRule(input);
    assert.equal(out.split(oldMarker).length - 1, 0, 'no stale marker left');
    assert.equal((out.match(/<!-- omo-briefing-rule v\d+ -->/g) ?? []).length, 1, 'exactly one rule block');
    assert.equal(out.split(RULE_MARKER).length - 1, 1, 'the one block is the current rule');
    assert.ok(out.includes('HEAD') && out.includes('TAIL'), 'unrelated prompt text stays');
    assert.equal(injectRule(out), out, 'reinjection is idempotent');
  }
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

test('rule v2 names plan_brief; an older v1 marker in the prompt is replaced once', () => {
  assert.ok(RULE_TEXT.includes('plan_brief'));
  const oldMarker = ['<!-- omo-briefing-rule v', '1 -->'].join('');
  const withOld = injectRule(`base\n${oldMarker}\nold rule`);
  assert.equal(withOld.includes(oldMarker), false);
  assert.equal(withOld.split(RULE_MARKER).length - 1, 1);
  assert.ok(withOld.includes('old rule'), 'unrelated prompt text stays');
  assert.equal(injectRule(withOld), withOld);
});

const block = (v) => RULE_TEXT.replace(RULE_MARKER, `<!-- omo-briefing-rule v${v} -->`);

test('injectRule replaces a v6 block with exactly one v8 block', () => {
  const out = injectRule(`HEAD\n\n${block(6)}\n\nTAIL`);
  assert.equal((out.match(/<!-- omo-briefing-rule v\d+ -->/g) ?? []).length, 1);
  assert.equal(out.split(RULE_MARKER).length - 1, 1);
  assert.ok(out.startsWith('HEAD') && out.endsWith('TAIL'));
  assert.equal(injectRule(out), out);
});

test('failure: a prompt with both a v5 and a v6 block yields exactly one current block', () => {
  const out = injectRule(`HEAD\n\n${block(5)}\n\nMID\n\n${block(6)}\n\nTAIL`);
  assert.equal((out.match(/<!-- omo-briefing-rule v\d+ -->/g) ?? []).length, 1);
  assert.equal(out.split(RULE_MARKER).length - 1, 1);
  for (const k of ['HEAD', 'MID', 'TAIL']) assert.ok(out.includes(k), k);
  assert.equal(injectRule(out), out);
});
