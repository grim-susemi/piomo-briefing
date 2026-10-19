import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateBrief } from '../src/schema.mjs';
import { applyBoardAnswer, applyDecide } from '../src/decide.mjs';
import { createBoardServer } from '../src/server.mjs';
import { createDeliverer } from '../src/deliver.mjs';
import { openStore } from '../src/store.mjs';
import { buildViewModel } from '../src/render.mjs';
import { tempDir } from './helpers/temp.mjs';
import { makeFakeSession } from './helpers/fake-session.mjs';
import { decisionFields, decisionValues } from './fixtures/decision-fields.mjs';

const brief = fields => ({ title: '입력', status: 'needs_decision', headline: '값을 정해 주세요',
  changes: [], done: [], next: '', decisions: [{ question: '어떻게 설정할까요?', reason: '보드에 적용', blocks: false, fields }] });
function seed(t, fields = decisionFields()) {
  const { dir } = tempDir(t, 'omo-fields-');
  const store = openStore(dir);
  store.replace('sessions/owner/meta.json', { sessionId: 'owner', title: '입력', lastActivityAt: 1000 });
  const id = store.allocDecisionId({ sessionId: 'owner', question: '입력', fields, source: 'brief', createdAt: 1000 });
  return { store, id, request: values => ({ id, sessionId: 'owner', values }) };
}

test('input fields: all kinds accepted without legacy options, preserving field definitions', () => {
  const r = validateBrief(brief(decisionFields()));
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(r.normalized.decisions[0].fields, decisionFields());
});

test('input fields: inclusive limits preserve Unicode and safe-integer/exponent numbers without rounding', () => {
  const fields = [
    { id: 'a'.repeat(24), label: '한'.repeat(40), kind: 'text', maxLen: 200 },
    { id: 'choice', label: '선택', kind: 'choice', options: Array.from({ length: 6 }, (_, i) => String(i) + '가'.repeat(39)) },
    { id: 'number', label: '정수', kind: 'number', min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, step: 1 },
    { id: 'exponent', label: '지수', kind: 'number', min: -Number.MAX_VALUE, max: Number.MAX_VALUE, step: Number.MAX_VALUE },
  ];
  const r = validateBrief(brief(fields));
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(r.normalized.decisions[0].fields, fields);
});

const badSpecs = [
  ['fields', []], ['fields', Array.from({ length: 5 }, (_, i) => ({ id: 'f' + i, label: 'f', kind: 'text', maxLen: 20 }))],
  ['fields[0]', [null]], ['fields[0]', new Array(1)],
  ['fields[0].id', [{ id: 'UPPER', label: 'x', kind: 'text', maxLen: 20 }]],
  ['fields[0].id', [{ id: 'x'.repeat(25), label: 'x', kind: 'text', maxLen: 20 }]],
  ['fields[1].id', [{ id: 'a', label: 'x', kind: 'text', maxLen: 20 }, { id: 'a', label: 'x', kind: 'text', maxLen: 20 }]],
  ['fields[0].label', [{ id: 'a', label: 'x'.repeat(41), kind: 'text', maxLen: 20 }]],
  ['fields[0].kind', [{ id: 'a', label: 'x', kind: 'html' }]],
  ['fields[0].maxLen', [{ id: 'a', label: 'x', kind: 'text', maxLen: 201 }]],
  ['fields[0].maxLen', [{ id: 'a', label: 'x', kind: 'text', maxLen: 0 }]],
  ['fields[0].maxLen', [{ id: 'a', label: 'x', kind: 'text', maxLen: 1.5 }]],
  ['fields[0].min', [{ id: 'a', label: 'x', kind: 'number', min: Infinity, max: 10, step: 1 }]],
  ['fields[0].max', [{ id: 'a', label: 'x', kind: 'number', min: 5, max: 4, step: 1 }]],
  ['fields[0].step', [{ id: 'a', label: 'x', kind: 'number', min: 0, max: 10, step: 0 }]],
  ['fields[0].options', [{ id: 'a', label: 'x', kind: 'choice', options: ['one'] }]],
  ['fields[0].options', [{ id: 'a', label: 'x', kind: 'choice', options: Array(7).fill('one') }]],
  ['fields[0].options[1]', [{ id: 'a', label: 'x', kind: 'choice', options: ['one', 'x'.repeat(41)] }]],
  ['fields[0].options[1]', [{ id: 'a', label: 'x', kind: 'choice', options: ['one', 'one'] }]],
  ['fields[0].options[1]', [{ id: 'a', label: 'x', kind: 'choice', options: ['one', , 'three'] }]],
  ['fields[0].html', [{ id: 'a', label: 'x', kind: 'text', maxLen: 20, html: '<script>' }]],
];
for (const [path, fields] of badSpecs) test('input fields refusal: ' + path + ' ' + JSON.stringify(fields), () => {
  const r = validateBrief(brief(fields));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.startsWith('decisions[0].' + path + ':')), r.errors.join('\n'));
});

test('input values: one immutable answer; typed decisions reject terminal choices and legacy board answers', t => {
  const { store, id, request } = seed(t);
  assert.equal(applyDecide(store, String(id), 'owner').applied.length, 0);
  assert.equal(applyDecide(store, id + 'A', 'owner').errors[0].code, 'FIELDS_REQUIRED');
  for (const answer of [{ option: 'A' }, { text: 'free form' }]) {
    assert.equal(applyBoardAnswer(store, { id, sessionId: 'owner', ...answer }).ok, false);
  }
  assert.deepEqual(applyBoardAnswer(store, request(decisionValues()), 1001), { ok: true, id });
  assert.deepEqual(store.readRecord('answers/000001.json'), { id, values: decisionValues(), at: 1001, fromSessionId: 'board' });
  assert.equal(applyBoardAnswer(store, request(decisionValues()), 1002).code, 'ANSWERED');
  assert.equal(store.readRecord('answers/000001.json').at, 1001);
});

for (const [field, value] of [['name', ''], ['name', 3], ['name', 'x'.repeat(201)], ['side_width', 999], ['side_width', 420],
  ['side_width', 281], ['side_width', '280'], ['side_width', Infinity], ['theme', 'unknown'], ['layout', null]]) {
  test('input values refuse without writing: ' + field + '=' + value, t => {
    const { store, request } = seed(t);
    const r = applyBoardAnswer(store, request({ ...decisionValues(), [field]: value }));
    assert.equal(r.code, 'BAD_VALUES');
    assert.equal(typeof r.fieldErrors[field], 'string');
    assert.equal(store.readRecord('answers/000001.json'), null);
    assert.equal(store.readRecord('claims/000001.json'), null);
  });
}

test('input values: exact keys only; no values on field-less decisions; decimal steps and numeric extremes', t => {
  const { store, request } = seed(t);
  for (const values of [null, [], {}, { ...decisionValues(), extra: 'x' }, Object.fromEntries(Object.entries(decisionValues()).slice(1))]) {
    assert.equal(applyBoardAnswer(store, request(values)).ok, false);
    assert.equal(store.readRecord('answers/000001.json'), null);
  }
  const old = store.allocDecisionId({ sessionId: 'owner', options: { A: { text: 'yes' }, B: { text: 'no' } } });
  assert.equal(applyBoardAnswer(store, { id: old, sessionId: 'owner', values: { name: 'x' } }).code, 'BAD_VALUES');
  for (const [min, max, step, value] of [[0.1, 1, 0.1, 0.3], [-Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, 0],
    [0, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], [0, 1, 0.1, -0]]) {
    const id = store.allocDecisionId({ sessionId: 'owner', fields: [{ id: 'n', label: '숫자', kind: 'number', min, max, step }] });
    assert.equal(applyBoardAnswer(store, { id, sessionId: 'owner', values: { n: value } }).ok, true, String(value));
  }
});

test('input decision HTTP: all guards retained, range refusal has field reason, one record and one proven delivery', async t => {
  const { store, id, request } = seed(t);
  const session = makeFakeSession();
  const meta = {};
  const d = createDeliverer({ pi: { session }, store, getSessionId: () => 'owner', getMeta: () => meta,
    saveMeta() {}, refresh() {}, enabled: () => true, watch: false });
  const ctx = { isIdle: () => true, sessionManager: { getBranch: () => [] } };
  const server = createBoardServer({ generation: 1, portBase: 48960, portCount: 10, token: 'field-token',
    getPage: () => '', getViewModel: () => buildViewModel(store.readSnapshot(), 1002),
    onAnswer: body => { const r = applyBoardAnswer(store, body, 1001); return { status: r.ok ? 200 : r.code === 'ANSWERED' ? 409 : 400, json: r }; } });
  const { port } = await server.start();
  t.after(async () => { await server.close(); await d.dispose(); });
  const origin = 'http://127.0.0.1:' + port;
  const post = async (body, headers = {}) => {
    const r = await fetch(origin + '/answer', { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json', 'X-Board-Token': 'field-token', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  assert.equal((await post(request(decisionValues()), { Origin: 'http://forged.invalid' })).status, 403);
  assert.equal((await post(request(decisionValues()), { 'X-Board-Token': 'wrong' })).status, 403);
  assert.equal((await post(request(decisionValues()), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(request(decisionValues()), { 'Content-Type': 'text/plain' })).status, 415);
  const bad = await post(request({ ...decisionValues(), side_width: 999 }));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'BAD_VALUES');
  assert.match(bad.json.fieldErrors.side_width, /400/);
  await d.wake(ctx, 'input');
  assert.equal(store.readRecord('answers/000001.json'), null);
  assert.equal(session.calls.length, 0);
  assert.equal((await post({ ...request(decisionValues()), text: 'mixed' })).status, 400);
  assert.equal((await post({ ...request(decisionValues()), action: 'hold' })).status, 400);
  const old = store.allocDecisionId({ sessionId: 'owner', options: { A: { text: 'yes' }, B: { text: 'no' } } });
  assert.equal((await post({ id: old, sessionId: 'owner', values: decisionValues() })).status, 400);
  assert.equal((await post(request({ ...decisionValues(), unknown: 1 }))).status, 400);
  assert.equal((await post(request(decisionValues()))).status, 200);
  assert.equal((await post(request(decisionValues()))).status, 409);
  await d.wake(ctx, 'input');
  await d.wake(ctx, 'message_end');
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0].text, `[결정] #${id} 입력: 작업 이름=보드, 사이드바 너비=280, 화면 테마=밝게, 배치=자동`);
  session.emit('d' + id);
  await d.wake(ctx, 'message_end');
  await d.wake(ctx, 'session_start');
  assert.equal(session.calls.length, 1);
  assert.equal(store.readRecord('receipts/000001.json').proven, true);
  const vm = buildViewModel(store.readSnapshot(), 1002);
  assert.deepEqual(vm.sessions[0].decisions[0].fields, decisionFields());
  assert.deepEqual(vm.sessions[0].decisions[0].answer.values, decisionValues());
});

const rawDuplicates = [
  ['999 then 280', '"values":{"side_width":999,"side_width":280}', 'side_width'],
  ['280 then 999', '"values":{"side_width":280,"side_width":999}', 'side_width'],
  ['top-level id', '"id":1,"values":{"side_width":280}', null],
  ['nested object', '"values":{"side_width":{"n":999,"n":280}}', 'side_width'],
  ['array-nested object', '"values":{"side_width":[{"n":999,"n":280}]}', 'side_width'],
  ['escaped field spelling', '"values":{"side_width":999,"side_\\u0077idth":280}', 'side_width'],
  ['escaped nested spelling', '"values":{"side_width":{"a":1,"\\u0061":2}}', 'side_width'],
  ['escaped punctuation key', '"values":{"side_width":{"a\\\"b":1,"a\\u0022b":2}}', 'side_width'],
];
for (const [label, members, field] of rawDuplicates) {
  test('input decision raw duplicate refusal: ' + label, async t => {
    const { store, id } = seed(t, [{ id: 'side_width', label: 'Width', kind: 'number', min: 200, max: 400, step: 20 }]);
    const session = makeFakeSession(), meta = {};
    const deliver = createDeliverer({ pi: { session }, store, getSessionId: () => 'owner', getMeta: () => meta,
      saveMeta() {}, refresh() {}, enabled: () => true, watch: false });
    let callbacks = 0;
    const server = createBoardServer({ generation: 9, portBase: Number(process.env.OMO_BRIEFING_PORT_BASE || 48960),
      portCount: 10, token: 'raw-field-token', getPage: () => '', getViewModel: () => ({}),
      onAnswer: body => { callbacks++; const r = applyBoardAnswer(store, body); return { status: r.ok ? 200 : 400, json: r }; } });
    t.after(async () => { await server.close(); await deliver.dispose(); });
    const { port } = await server.start();
    const body = `{"id":${id},"sessionId":"owner",${members}}`;
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/answer', method: 'POST', agent: false,
        headers: { Connection: 'close', Origin: 'http://127.0.0.1:' + port, 'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Board-Token': 'raw-field-token' } }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body); // Deliberately raw: JSON.stringify would erase the duplicate under test.
    });
    await deliver.wake({ isIdle: () => true, sessionManager: { getBranch: () => [] } }, 'input');
    // Check side effects even when the status assertion would fail on the old parser.
    const effects = { answer: store.readRecord('answers/000001.json'), deliveries: session.calls.length, callbacks };
    t.diagnostic(JSON.stringify({ pid: process.pid, label, raw: body, ...response, ...effects }));
    assert.equal(response.status, 400);
    assert.equal(response.json.code, 'DUPLICATE_KEY');
    if (field) assert.match(response.json.fieldErrors[field], /중복|두 번/);
    assert.deepEqual(effects, { answer: null, deliveries: 0, callbacks: 0 });
    assert.equal(store.readRecord('claims/000001.json'), null);
  });
}

for (const [label, field, rawValue] of [
  ['key-like string value', 'name', '"문자열 \\"side_width\\": 와 이스케이프 \\\\ 및 괄호 {} []"'],
  ['same key in different objects', 'id', '"보드"'],
]) {
  test('input decision raw duplicate negative control: ' + label, async t => {
    const { store, id } = seed(t, [{ id: field, label: '내용', kind: 'text', maxLen: 200 }]);
    const server = createBoardServer({ generation: 9, portBase: Number(process.env.OMO_BRIEFING_PORT_BASE || 48960),
      portCount: 10, token: 'raw-field-token', getPage: () => '', getViewModel: () => ({}),
      onAnswer: body => { const r = applyBoardAnswer(store, body); return { status: r.ok ? 200 : 400, json: r }; } });
    t.after(() => server.close());
    const { port } = await server.start(), origin = 'http://127.0.0.1:' + port;
    const response = await fetch(origin + '/answer', { method: 'POST',
      headers: { Connection: 'close', Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
        'X-Board-Token': 'raw-field-token' },
      body: `{"id":${id},"sessionId":"owner","values":{"${field}":${rawValue}}}` });
    assert.equal(response.status, 200, await response.text());
    assert.equal(store.readRecord('answers/000001.json').values[field], JSON.parse(rawValue));
  });
}
