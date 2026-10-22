// The extension's board write hooks (POST /answer, POST /focus): what src/server-host.mjs hands to the board server as
// answer(body) / focus(body). The server host is a stand-in that only captures the options, so these tests drive the hooks
// exactly as the server does after its own guards (see test/server.test.mjs for those) - with real files in a temp STATE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBriefingExtension } from '../extension.mjs';
import { makeFakePi, makeCtx } from './helpers/fake-pi.mjs';

const HERDR = 'C:/bin/herdr.exe';

// node's execFile(file, args, options, callback); each call answers with the next scripted reply
function fakeExec(replies = []) {
  const calls = [];
  const execFile = (file, args, options, cb) => {
    calls.push({ file, args, options });
    const r = replies.shift() ?? {};
    if (r.throws) throw r.throws;
    if (r.hang) return; // never calls back
    queueMicrotask(() => cb(r.err ?? null, '', ''));
  };
  return { execFile, calls };
}

// setTimeout registrations are kept and run only when the test says so
function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(fn) { const h = { fn, unref() {} }; pending.push(h); return h; },
    clearTimeout(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    setInterval() { return { unref() {} }; },
    clearInterval() {},
  };
}

function lead(t, { prior, fs, exec = fakeExec(), timers } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omo-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  const writeMeta = (sid, meta) => {
    mkdirSync(join(stateDir, 'sessions', sid), { recursive: true });
    writeFileSync(join(stateDir, 'sessions', sid, 'meta.json'), JSON.stringify({ sessionId: sid, ...meta }));
  };
  if (prior) writeMeta('sess-A', prior);
  const box = {};
  const stub = { ensure: async () => null, status: () => ({ role: 'idle', url: null }), onPaused: async () => {}, release: async () => {}, notifyPublished() {} };
  let clock = 1_700_000_000_000;
  const pi = makeFakePi();
  createBriefingExtension({
    stateDir,
    server: true,
    now: () => (clock += 1000),
    env: { PATH: process.env.PATH, HERDR_BIN_PATH: HERDR }, // no HERDR_TAB_ID: this conversation makes no herdr call of its own
    execFile: exec.execFile,
    execFileSync: () => { throw new Error('no sync herdr call expected'); },
    openPage: () => ({ launcher: 'chrome', command: 'x', args: [] }),
    renderOpts: { sleep: () => {} },
    createDeliverer: () => ({ wake: async () => {}, pendingIds: () => [], dispose: async () => {} }),
    createServerHost: (o) => { box.options = o; return stub; },
    ...(fs ? { fs } : {}),
    ...(timers ? { timers } : {}),
  })(pi.pi);
  const { ctx } = makeCtx({ sid: 'sess-A' });
  return {
    stateDir,
    calls: exec.calls,
    hooks: () => box.options,
    writeMeta,
    start: () => pi.emit('session_start', { reason: 'startup' }, ctx),
    brief: (input) => pi.tool('brief').execute('call', input, undefined, undefined, ctx),
    seq: () => JSON.parse(readFileSync(join(stateDir, 'published.json'), 'utf8')).seq,
    meta: () => JSON.parse(readFileSync(join(stateDir, 'sessions', 'sess-A', 'meta.json'), 'utf8')),
    publishedText: () => ['index.html', 'data.js'].map((f) => readFileSync(join(stateDir, f), 'utf8')).join('\n'), // what the page is built from
    answerFiles: () => (existsSync(join(stateDir, 'answers')) ? readdirSync(join(stateDir, 'answers')) : []),
    readAnswer: (n) => JSON.parse(readFileSync(join(stateDir, 'answers', `${String(n).padStart(6, '0')}.json`), 'utf8')),
  };
}

const goodBrief = (over = {}) => ({ title: '작업 하나', status: 'in_progress', headline: '절반', changes: [], done: [], next: '', decisions: [], ...over });
const decision = () => ({
  question: '어느 쪽으로 갈까?',
  options: { A: { text: '가', consequence: '빠름' }, B: { text: '나', consequence: '안전' } },
  recommend: 'A',
  reason: '빨라서',
  blocks: false,
});
const fail = (status, code) => ({ status, json: { ok: false, code } });
const OK = { status: 200, json: { ok: true } }; // /focus (and the error shapes below carry no id)
const answerOk = (id) => ({ status: 200, json: { ok: true, id } }); // /answer success names the decision it answered

test('the extension hands the server host its answer and focus hooks, and the page template the token only in server mode', async (t) => {
  const s = lead(t);
  await s.start();
  await s.brief(goodBrief());
  assert.equal(typeof s.hooks().answer, 'function');
  assert.equal(typeof s.hooks().focus, 'function');
  const vm = { schema: 1, seq: 1, gen: 4, sessions: [], waiting: [], server: null };
  const page = s.hooks().getPage(vm, 'tok-123_ABC');
  assert.equal(page.match(/<meta name="omo-board-token"/g).length, 1);
  assert.ok(page.includes('<meta name="omo-board-token" content="tok-123_ABC">'));
  const nonce = 'AbCdEfGhIjKlMnOpQrStUv==';
  const nonced = s.hooks().getPage(vm, 'tok-123_ABC', nonce);
  assert.equal(nonced.match(new RegExp(`<style nonce="${nonce}">`, 'g')).length, 1, 'the combined style carries the nonce');
  assert.equal(nonced.match(new RegExp(`<script nonce="${nonce}">`, 'g')).length, 11, 'every script carries the nonce');
  assert.equal((nonced.match(/<script>/g) ?? []).length, 0, 'no script is left un-nonced');
  for (const file of ['index.html', 'data.js']) {
    assert.ok(!readFileSync(join(s.stateDir, file), 'utf8').includes('omo-board-token'), `${file} (what the file page and data.js carry) has no token`);
  }
});

test('answer: every applyBoardAnswer code maps to its HTTP status; only the first answer writes a file', async (t) => {
  const s = lead(t);
  await s.start();
  await s.brief(goodBrief({ decisions: [decision(), decision(), decision()] }));
  await s.brief(goodBrief({ close_decisions: [{ id: 3, reason: 'superseded' }] }));
  const { answer } = s.hooks();
  const seqBefore = s.seq();
  assert.deepEqual(await answer({ id: 1, sessionId: 'sess-A', option: 'B' }), answerOk(1));
  assert.deepEqual(s.readAnswer(1), { id: 1, option: 'B', at: s.readAnswer(1).at, fromSessionId: 'board' });
  assert.ok(s.seq() > seqBefore, 'a written answer is published, so open pages see its state');

  const rows = [
    ['ANSWERED', { id: 1, sessionId: 'sess-A', option: 'A' }, 409],
    ['NOT_FOUND', { id: 99, sessionId: 'sess-A', option: 'A' }, 404],
    ['SESSION_MISMATCH', { id: 2, sessionId: 'sess-B', option: 'A' }, 409],
    ['CLOSED', { id: 3, sessionId: 'sess-A', option: 'A' }, 409],
    ['BAD_OPTION', { id: 2, sessionId: 'sess-A', option: 'C' }, 400],
    ['BAD_REQUEST', { id: 2, sessionId: 'sess-A' }, 400],
  ];
  for (const [code, body, status] of rows) {
    const seq = s.seq();
    assert.deepEqual(await answer(body), fail(status, code), code);
    assert.equal(s.seq(), seq, `${code}: nothing was published`);
  }
  assert.deepEqual(s.answerFiles(), ['000001.json'], 'the refusals wrote nothing');
  assert.deepEqual(s.meta().errors, {}, 'a refusal is not a failure: nothing is recorded');
});

test('answer: free text needs the owning conversation to advertise answerKinds text; a refusal writes nothing', async (t) => {
  const s = lead(t, { prior: { answerKinds: ['option', 'text'] } });
  await s.start();
  await s.brief(goodBrief({ decisions: [decision(), decision(), decision()] }));
  s.writeMeta('sess-B', { title: 'older generation' }); // a conversation whose meta has no answerKinds
  s.writeMeta('sess-C', { answerKinds: ['option'] });
  const { answer } = s.hooks();
  for (const sessionId of ['sess-B', 'sess-C', 'sess-Z', '../sess-A']) {
    assert.deepEqual(await answer({ id: 1, sessionId, text: '설치해 줘' }), fail(409, 'NO_TEXT_SUPPORT'), sessionId);
  }
  assert.deepEqual(s.answerFiles(), []);

  assert.deepEqual(await answer({ id: 1, sessionId: 'sess-A', text: '  설치해 줘  ' }), answerOk(1));
  const saved = s.readAnswer(1);
  assert.equal(saved.text, '설치해 줘');
  assert.equal(saved.option, undefined);
  assert.equal(saved.fromSessionId, 'board');

  assert.deepEqual(await answer({ id: 2, sessionId: 'sess-A', text: '   ' }), fail(400, 'BAD_TEXT'));
  assert.deepEqual(await answer({ id: 2, sessionId: 'sess-A', text: '가'.repeat(501) }), fail(400, 'BAD_TEXT'));
  assert.deepEqual(await answer({ id: 2, sessionId: 'sess-A', text: 'x', option: 'A' }), fail(400, 'BAD_REQUEST'));
  assert.deepEqual(await answer({ id: 1, sessionId: 'sess-A', text: '또' }), fail(409, 'ANSWERED'));
  assert.deepEqual(s.answerFiles(), ['000001.json']);
});

// a read of `matches` throws EIO (not a retried code) while `ctl.deny` is set; the message carries the path like a real fs error
const faultyFs = (ctl, matches) => ({ ...nodeFs, readFileSync: (p, ...a) => {
  const file = String(p).replace(/\\/g, '/');
  if (ctl.deny && matches.test(file)) throw Object.assign(new Error(`EIO: i/o error, open '${file}'`), { code: 'EIO' });
  return nodeFs.readFileSync(p, ...a);
} });
const CHIP = '오류 있음';

test('answer: a store fault is a 500 with the bare code; the diagnostic is recorded once in meta.errors, the page only gets the chip, a later success clears it', async (t) => {
  const ctl = { deny: false };
  const s = lead(t, { fs: faultyFs(ctl, /\/decisions\/000001\.json$/) });
  await s.start();
  await s.brief(goodBrief({ decisions: [decision()] }));
  ctl.deny = true;
  assert.deepEqual(await s.hooks().answer({ id: 1, sessionId: 'sess-A', option: 'A' }), fail(500, 'IO_ERROR'));
  assert.deepEqual(s.answerFiles(), []);
  const recorded = s.meta().errors.answer;
  assert.match(recorded.message, /^answer: /);
  assert.match(recorded.message, /#1/);
  assert.match(recorded.message, /IO_ERROR/);
  assert.match(recorded.message, /EIO: i\/o error, open '.*decisions\/000001\.json'/, 'the cause is kept for the owner, as other sources keep theirs');
  assert.ok(!s.publishedText().includes('i/o error'), 'the page is built from chips only: no detail in index.html or data.js');
  assert.ok(readFileSync(join(s.stateDir, 'data.js'), 'utf8').includes(CHIP), 'the failure is a chip on the board');
  assert.deepEqual(Object.keys(s.meta().errors), ['answer']);

  const at = recorded.at;
  assert.deepEqual(await s.hooks().answer({ id: 1, sessionId: 'sess-A', option: 'A' }), fail(500, 'IO_ERROR'));
  assert.equal(s.meta().errors.answer.at, at, 'the same failure again is not recorded twice');

  ctl.deny = false;
  assert.deepEqual(await s.hooks().answer({ id: 1, sessionId: 'sess-A', option: 'A' }), answerOk(1), 'the fault was transient');
  assert.equal(s.meta().errors.answer, undefined, 'the source succeeded: its entry is gone');
  assert.ok(!readFileSync(join(s.stateDir, 'data.js'), 'utf8').includes(CHIP), 'and so is the chip');
});

test('answer: a fault reading the owning conversation\'s meta (free-text check) is the same 500 and diagnostic', async (t) => {
  const ctl = { deny: false };
  const s = lead(t, { fs: faultyFs(ctl, /\/sessions\/sess-B\/meta\.json$/) });
  await s.start();
  await s.brief(goodBrief({ decisions: [decision()] }));
  s.writeMeta('sess-B', { answerKinds: ['option', 'text'] });
  ctl.deny = true;
  assert.deepEqual(await s.hooks().answer({ id: 1, sessionId: 'sess-B', text: '설치해 줘' }), fail(500, 'IO_ERROR'));
  assert.match(s.meta().errors.answer.message, /EIO: i\/o error, open '.*sessions\/sess-B\/meta\.json'/);
  assert.deepEqual(s.answerFiles(), []);
});

test('focus: runs herdr tab focus <tabId> as an argument array with a 3000 ms timeout and answers 200', async (t) => {
  const exec = fakeExec([{}]);
  const s = lead(t, { exec });
  await s.start();
  s.writeMeta('sess-B', { tabId: 'w1:t5N' });
  assert.deepEqual(await s.hooks().focus({ sessionId: 'sess-B' }), OK);
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].file, HERDR);
  assert.deepEqual(exec.calls[0].args, ['tab', 'focus', 'w1:t5N']);
  assert.equal(exec.calls[0].options.timeout, 3000);
});

test('focus: a missing meta, a missing or malformed tabId and an unusable session id are 404 and herdr is never called', async (t) => {
  const exec = fakeExec();
  const s = lead(t, { exec });
  await s.start();
  const bad = ['w1:t5N; calc', '--help', '', 'w1:t', 'w1:t5N\n', 'w1:t5N calc', 'W1:t5N', 'w1:t5N&&calc', 'w1:t5N/../x'];
  bad.forEach((tabId, i) => s.writeMeta(`bad-${i}`, { tabId }));
  s.writeMeta('no-tab', {});
  s.writeMeta('num-tab', { tabId: 181 });
  s.writeMeta('sess-B', { tabId: 'w1:t5N' });
  const ids = [...bad.map((_, i) => `bad-${i}`), 'no-tab', 'num-tab', 'sess-Z', '../sess-B', 'sess-B/../sess-B', '..', 'a/b', '', 'sess-B\n'];
  for (const sessionId of ids) {
    assert.deepEqual(await s.hooks().focus({ sessionId }), fail(404, 'NOT_FOUND'), JSON.stringify(sessionId));
  }
  assert.deepEqual(exec.calls, []);
  assert.deepEqual(s.meta().errors, {}, 'a refused target is not a failure: nothing is recorded');
});

test('focus: a failing herdr (exit error, timeout kill, spawn throw, no reply at all) is 502 with the bare code, recorded in meta.errors.focus; a later success clears it', async (t) => {
  const timers = manualTimers();
  const failures = [
    [{ err: Object.assign(new Error('exit 1'), { code: 1 }) }, ['exit 1']],
    [{ err: Object.assign(new Error('Command failed: herdr tab focus'), { killed: true, signal: 'SIGTERM', code: null }) }, ['TIMEOUT']],
    [{ throws: Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }) }, ['EPERM', 'spawn EPERM']],
  ];
  const exec = fakeExec([...failures.map(([reply]) => reply), { hang: true }, {}]);
  const s = lead(t, { exec, timers });
  await s.start();
  s.writeMeta('sess-B', { tabId: 'w1:t5N' });
  for (const [, fragments] of failures) {
    assert.deepEqual(await s.hooks().focus({ sessionId: 'sess-B' }), fail(502, 'HERDR_FAILED'));
    const { message } = s.meta().errors.focus;
    assert.match(message, /^focus: /);
    for (const f of ['sess-B', ...fragments]) assert.ok(message.includes(f), `${f} in ${message}`);
  }
  const armed = timers.pending.length;
  const hung = s.hooks().focus({ sessionId: 'sess-B' });
  assert.equal(exec.calls.length, 4);
  assert.equal(timers.pending.length, armed + 1, 'a guard timer is armed for the call that may never answer');
  timers.pending.at(-1).fn(); // the guard fires: the reply is sent, the server's write slot is freed
  assert.deepEqual(await hung, fail(502, 'HERDR_FAILED'));
  assert.ok(s.meta().errors.focus.message.includes('TIMEOUT'), s.meta().errors.focus.message);
  assert.ok(readFileSync(join(s.stateDir, 'data.js'), 'utf8').includes(CHIP), 'the failure is a chip on the board');
  assert.ok(!s.publishedText().includes('EPERM') && !s.publishedText().includes('exit 1'), 'the page carries the chip, not the detail');

  assert.deepEqual(await s.hooks().focus({ sessionId: 'sess-B' }), OK);
  assert.equal(s.meta().errors.focus, undefined, 'the source succeeded: its entry is gone');
  assert.ok(!readFileSync(join(s.stateDir, 'data.js'), 'utf8').includes(CHIP), 'and so is the chip');
});

test('focus: a fault reading the target\'s meta is 500 IO_ERROR and recorded as the focus source; herdr is not called', async (t) => {
  const ctl = { deny: false };
  const exec = fakeExec();
  const s = lead(t, { exec, fs: faultyFs(ctl, /\/sessions\/sess-B\/meta\.json$/) });
  await s.start();
  s.writeMeta('sess-B', { tabId: 'w1:t5N' });
  ctl.deny = true;
  assert.deepEqual(await s.hooks().focus({ sessionId: 'sess-B' }), fail(500, 'IO_ERROR'));
  assert.match(s.meta().errors.focus.message, /EIO: i\/o error, open '.*sessions\/sess-B\/meta\.json'/);
  assert.deepEqual(exec.calls, []);
});

test('annotation hook: capability refusal is 409; 9 KB Markdown, duplicate and conflict keep one immutable answer', async (t) => {
  const s = lead(t);
  await s.start();
  const requestId = '01234567-89ab-4cde-8fab-0123456789ab';
  const key = `a-${requestId}`;
  const text = ' \n## [owner]\n' + 'x\n'.repeat(4608) + '\tend\n ';
  const request = { kind: 'annotation', sessionId: 'sess-A', requestId, text };
  assert.deepEqual(await s.hooks().answer({ id: 1, sessionId: 'sess-A', text: 'x'.repeat(501) }), fail(400, 'BAD_TEXT'));
  s.writeMeta('old', { answerKinds: ['option', 'text'] });
  s.writeMeta('annotation-only', { answerKinds: ['annotation'] });
  for (const sessionId of ['old', 'missing', '../sess-A']) {
    assert.deepEqual(await s.hooks().answer({ ...request, sessionId }), fail(409, 'NO_ANNOTATION_SUPPORT'));
  }
  assert.deepEqual(s.answerFiles(), []);
  const seq = s.seq();
  assert.deepEqual(await s.hooks().answer(request), { status: 200, json: { ok: true, key } });
  const path = join(s.stateDir, 'answers', `${key}.json`);
  const before = readFileSync(path, 'utf8');
  assert.deepEqual(Buffer.from(JSON.parse(before).text), Buffer.from(text));
  assert.ok(s.seq() > seq, 'the note state is published');
  assert.deepEqual(await s.hooks().answer(request), { status: 200, json: { ok: true, key, duplicate: true } });
  assert.deepEqual(await s.hooks().answer({ ...request, text: text + 'changed' }), fail(409, 'REQUEST_ID_CONFLICT'));
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(s.answerFiles(), [`${key}.json`]);
  for (const text of ['', 'x'.repeat(12001), '😀'.repeat(12289)]) {
    assert.deepEqual(await s.hooks().answer({ ...request, text }), fail(400, 'BAD_TEXT'));
  }
  assert.deepEqual(s.meta().errors, {}, 'validation and conflicts are refusals, not store faults');
  const supported = { ...request, sessionId: 'annotation-only', requestId: requestId.replace('01234567-', '11234567-') };
  assert.equal((await s.hooks().answer(supported)).status, 200, 'annotation does not require legacy text capability');
});

test('annotation hook: a meta read fault is bare IO_ERROR, and a later successful annotation clears its diagnostic', async (t) => {
  const ctl = { deny: false };
  const s = lead(t, { fs: faultyFs(ctl, /\/sessions\/note-owner\/meta\.json$/) });
  await s.start();
  s.writeMeta('note-owner', { answerKinds: ['annotation'] });
  const request = { kind: 'annotation', sessionId: 'note-owner', requestId: '01234567-89ab-4cde-8fab-0123456789ab', text: 'note' };
  ctl.deny = true;
  assert.deepEqual(await s.hooks().answer(request), fail(500, 'IO_ERROR'));
  assert.match(s.meta().errors.answer.message, /a-01234567/);
  assert.deepEqual(s.answerFiles(), []);
  ctl.deny = false;
  assert.equal((await s.hooks().answer(request)).status, 200);
  assert.equal(s.meta().errors.answer, undefined);
});
