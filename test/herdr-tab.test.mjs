import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tempDir } from './helpers/temp.mjs';
import { join } from 'node:path';
import { readTab, herdrBin } from '../src/herdr-tab.mjs';
import { createBriefingExtension } from '../extension.mjs';
import { makeFakePi, makeCtx } from './helpers/fake-pi.mjs';

const OK = JSON.stringify({ id: 'cli:tab:get', result: { tab: { label: '수리', number: 181, tab_id: 'w1:t5N' }, type: 'tab_info' } });
const ENV = { HERDR_TAB_ID: 'w1:t5N', HERDR_BIN_PATH: 'C:/bin/herdr.exe' };

// node's execFile(file, args, options, callback) shape; each call answers with the next scripted reply
function fakeExec(replies) {
  const calls = [];
  const execFile = (file, args, options, cb) => {
    calls.push({ file, args, options });
    const r = replies.shift() ?? { err: new Error('no scripted reply') };
    if (r.throws) throw r.throws;
    queueMicrotask(() => cb(r.err ?? null, r.stdout ?? '', ''));
  };
  return { execFile, calls };
}

test('readTab parses label and number from `herdr tab get <id>` run with an argument array and a 3000 ms timeout', async () => {
  const f = fakeExec([{ stdout: OK }]);
  assert.deepEqual(await readTab({ env: ENV, execFile: f.execFile }), { tabLabel: '수리', tabNumber: 181 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, 'C:/bin/herdr.exe');
  assert.deepEqual(f.calls[0].args, ['tab', 'get', 'w1:t5N']);
  assert.equal(f.calls[0].options.timeout, 3000);
});

test('readTab resolves null on exit 1, bad JSON, wrong shape, timeout and a synchronous spawn throw', async () => {
  const exit1 = Object.assign(new Error('Command failed'), { code: 1 });
  const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null });
  const enoent = Object.assign(new Error('spawn herdr ENOENT'), { code: 'ENOENT' });
  const cases = [
    { err: exit1, stdout: OK },
    { stdout: 'not json{' },
    { stdout: JSON.stringify({ result: { tab: { label: 5, number: 181 } } }) },
    { stdout: JSON.stringify({ result: { tab: { label: '수리', number: '181' } } }) },
    { stdout: 'null' },
    { err: timeout },
    { err: enoent },
    { throws: new TypeError('bad spawn') },
  ];
  for (const c of cases) {
    const f = fakeExec([c]);
    assert.equal(await readTab({ env: ENV, execFile: f.execFile }), null, JSON.stringify(c.stdout ?? c.err?.message ?? 'throw'));
    assert.equal(f.calls.length, 1);
  }
});

test('readTab without HERDR_TAB_ID (not a herdr terminal) resolves null and runs nothing', async () => {
  for (const env of [{}, { HERDR_TAB_ID: '' }, { HERDR_TAB_ID: 7 }]) {
    const f = fakeExec([{ stdout: OK }]);
    assert.equal(await readTab({ env, execFile: f.execFile }), null);
    assert.equal(f.calls.length, 0);
  }
});

test('herdr binary: HERDR_BIN_PATH, else herdr.exe on win32 and herdr elsewhere', () => {
  assert.equal(herdrBin({ HERDR_BIN_PATH: '/x/herdr' }, 'linux'), '/x/herdr');
  assert.equal(herdrBin({}, 'win32'), 'herdr.exe');
  assert.equal(herdrBin({}, 'linux'), 'herdr');
});

// ---------------------------------------------------------------- extension meta

function lead(t, { replies, prior } = {}) {
  const { dir, onDispose } = tempDir(t, 'omo-tab-');
  const stateDir = join(dir, 'state');
  if (prior) {
    mkdirSync(join(stateDir, 'sessions', 'sess-A'), { recursive: true });
    writeFileSync(join(stateDir, 'sessions', 'sess-A', 'meta.json'), JSON.stringify(prior));
  }
  let clock = 1_700_000_000_000;
  const f = fakeExec(replies);
  const host = makeFakePi();
  createBriefingExtension({
    stateDir,
    now: () => (clock += 1000),
    env: { PATH: process.env.PATH, HERDR_TAB_ID: 'w1:t5N', HERDR_PANE_ID: 'w1:pR2' },
    execFile: f.execFile,
    execFileSync: () => { throw new Error('no sync herdr call expected'); },
    openPage: () => ({ launcher: 'chrome', command: 'x', args: [] }),
    renderOpts: { sleep: () => {} },
  })(host.pi);
  const { ctx } = makeCtx({ sid: 'sess-A' });
  onDispose(() => host.emit('session_shutdown', {}, ctx));
  return {
    calls: f.calls,
    start: () => host.emit('session_start', { reason: 'startup' }, ctx),
    brief: (input) => host.tool('brief').execute('call', input, undefined, undefined, ctx),
    meta: () => JSON.parse(readFileSync(join(stateDir, 'sessions', 'sess-A', 'meta.json'), 'utf8')),
  };
}
const goodBrief = { title: '작업 하나', status: 'in_progress', headline: '절반', changes: [], done: [], next: '', decisions: [] };
const drain = () => new Promise((r) => setImmediate(r)); // every queued microtask (the fake reply and its .then) has run

test('session_start and a brief call write tabId, tabLabel and tabNumber into meta', async (t) => {
  const s = lead(t, { replies: [{ stdout: OK }, { stdout: OK.replace('"수리"', '"정비"') }] });
  await s.start();
  await drain();
  assert.equal(s.meta().tabId, 'w1:t5N');
  assert.equal(s.meta().tabLabel, '수리');
  assert.equal(s.meta().tabNumber, 181);
  await s.brief(goodBrief);
  await drain();
  assert.equal(s.calls.length, 2, 'one herdr call per session_start and per brief');
  assert.deepEqual(s.calls.map((c) => c.args), [['tab', 'get', 'w1:t5N'], ['tab', 'get', 'w1:t5N']]);
  assert.equal(s.meta().tabLabel, '정비');
});

test('herdr missing (ENOENT) keeps the prior tab label and number, and the brief still succeeds', async (t) => {
  const enoent = () => ({ err: Object.assign(new Error('spawn herdr.exe ENOENT'), { code: 'ENOENT' }) });
  const s = lead(t, { replies: [enoent(), { throws: new Error('spawn EPERM') }], prior: { sessionId: 'sess-A', tabId: 'w1:old', tabLabel: '수리', tabNumber: 181 } });
  await s.start();
  await drain();
  assert.equal(s.meta().tabLabel, '수리');
  assert.equal(s.meta().tabNumber, 181);
  assert.equal(s.meta().tabId, 'w1:t5N', 'the env tab id wins over the prior one');
  const res = await s.brief(goodBrief);
  await drain();
  assert.equal(res.details.seq, 1, 'the brief was stored');
  assert.equal(s.meta().tabLabel, '수리');
  assert.equal(s.meta().tabNumber, 181);
});
