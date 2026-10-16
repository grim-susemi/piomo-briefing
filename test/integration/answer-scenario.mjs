// Scenario `board-answer` of the isolated real-host run (plan todo 10). NOT part of `npm test`.
//   node test/integration/answer-scenario.mjs [--out <evidence dir>] [--work <dir>] [--keep]
// (that command runs `node test/integration/rpc-run.mjs --scenario board-answer ...`, which owns the RPC host harness.)
//
// Two real `senpi --mode rpc` conversations share one TEMP state dir: B starts first and owns the board server, A makes
// three decisions with one `brief` call. The test then acts as the board PAGE: GET / for the token meta, POST /answer with the
// page's headers. Proven: a board option answer, a board text reply and a `/decide` typed in B all reach ONLY A, once, with a
// proven receipt; B receives nothing; a repeated board answer is refused (409) and writes nothing.
// The agent dir holds only the briefing shim and this repo's dist: nothing of the live profile is read, written or started.
// Model = the deterministic scripted provider: no real model is ever asked anything. Waiting is event driven (host events,
// fs.watch) with bounded timeouts; there are no fixed sleeps. Every identifier below lives in the temp work dir.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventoryDir, auditAnswers } from './state-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT_BASE = 47430; // own range: apart from the live board (47317) and plan-view (47390)
const PORT_COUNT = 10;
const TOKEN_META = /<meta name="omo-board-token" content="([^"]*)">/g;

// ------------------------------------------------------------------ http helpers (what the board page itself does)
function httpRequest(port, method, p, { body, headers = {}, timeoutMs = 5000 } = {}) {
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, agent: false,
      headers: { Connection: 'close', ...(payload ? { 'Content-Length': payload.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON (the page) */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`${method} ${p} timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(payload);
  });
}
const httpGet = (port, p) => httpRequest(port, 'GET', p);
/** The headers the served page sends with fetch('/answer', ...): same-origin, JSON, the page's token. */
const pageHeaders = (port, token) => ({
  'Content-Type': 'application/json', 'X-Board-Token': token, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin',
});
const postAnswer = (port, token, body, headers) => httpRequest(port, 'POST', '/answer', { body, headers: headers ?? pageHeaders(port, token) });

const tcpFree = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(true));
});
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ------------------------------------------------------------------ fixtures
const DECISIONS = ['첫 번째', '두 번째', '세 번째'];
const briefJson = () => ({
  title: '통합 시험 A',
  status: 'needs_decision',
  headline: '통합 시험용 보고: 결정 세 개가 열려 있다',
  changes: [{ text: '시험용 변화 한 줄', truth: 'reported', applied: 'candidate' }],
  done: [],
  next: '결정 전달 확인',
  decisions: DECISIONS.map((n, i) => ({
    question: `${n} 시험 결정은 어느 쪽으로 갈까?`,
    options: { A: { text: 'A안 진행', consequence: '빠르게 끝난다' }, B: { text: 'B안 진행', consequence: '더 안전하다' }, C: { text: 'C안 진행', consequence: '나중에 본다' } },
    recommend: 'ABC'[i],
    reason: '시험용',
    blocks: true,
  })),
  flow: [{ label: '시험', state: 'doing' }],
});

const isDelivery = (id) => (e) => e.type === 'message_end' && e.message && e.message.role === 'custom'
  && e.message.customType === 'session_control_delivery' && e.message.details && e.message.details.delivery_id === id;
const isAnyDelivery = (e) => e.type === 'message_end' && e.message && e.message.customType === 'session_control_delivery';

// ------------------------------------------------------------------ the scenario
export async function runBoardAnswer(ctx) {
  const { Host, waitUntil, readyHost, readJson, listDir, walk, sessionEntries, textOf, notifies, isSettled, OUT, WORK, AGENT, STATE, HERE: harnessDir, REPO, PIDS, slash, pad6 } = ctx;
  const RUN_TXT = `${OUT}/run.txt`;
  fs.writeFileSync(RUN_TXT, '');
  const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); fs.appendFileSync(RUN_TXT, `${line}\n`); };
  const result = { scenario: 'board-answer', startedAt: new Date().toISOString(), portBase: PORT_BASE, checks: {}, details: {}, errors: [] };
  const check = (name, pass, detail) => { result.checks[name] = pass === true; if (detail !== undefined) result.details[name] = detail; log(`${pass === true ? 'PASS' : 'FAIL'} ${name}`); };
  const hosts = [];
  const track = (h) => { hosts.push(h); return h; };
  let token = '';

  // a run that is not under the OS temp folder could touch real state: refuse before anything starts
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  for (const dir of [WORK, STATE, AGENT]) {
    if (!path.resolve(dir).toLowerCase().startsWith(tmp)) throw new Error(`${dir} is not under ${os.tmpdir()}: this scenario only runs in a temp work dir`);
  }

  const toolEnd = (host, from, name, what) => host.waitEvent((e) => e.type === 'tool_execution_end' && e.toolName === name, { from, timeoutMs: 60000, what });
  const prompt = async (host, message) => {
    const m = host.mark();
    const r = await host.send({ type: 'prompt', message });
    if (!r.success) throw new Error(`prompt rejected by ${host.label}: ${JSON.stringify(r)}`);
    return m;
  };
  const readServerJson = () => readJson(`${STATE}/server.json`);
  const answerFiles = () => listDir(`${STATE}/answers`).filter((f) => f.endsWith('.json'));
  const receiptOf = (host, id) => waitUntil(() => { const r = readJson(`${STATE}/receipts/${pad6(id)}.json`); return r && r.proven === true ? r : null; },
    { watch: [`${STATE}/receipts`], subscribe: (t) => { host.listeners.add(t); return () => host.listeners.delete(t); }, timeoutMs: 20000, what: `proven receipt #${id}` });
  /** The delivery of decision `id` reached `host` once, and the run it started has settled. */
  const awaitDelivery = async (host, from, id) => {
    const d = await host.waitEvent(isDelivery(`d${id}`), { from, timeoutMs: 30000, what: `${host.label}: delivery d${id}` });
    await host.waitEvent(isSettled, { from: d.index, timeoutMs: 60000, what: `${host.label} settled after d${id}` });
    await host.send({ type: 'get_state' }); // round trip: anything else the host had queued has surfaced by now
    const receipt = await receiptOf(host, id);
    return { text: textOf(d.ev.message.content), receipt, count: host.eventsFrom(from).filter(isDelivery(`d${id}`)).length };
  };
  const entriesOf = (file, id) => sessionEntries(file).filter((e) => e.type === 'custom_message' && e.customType === 'session_control_delivery' && e.details && e.details.delivery_id === `d${id}`).length;

  try {
    // ---- 0. temp agent folder: only the briefing shim + this repo's dist (no live profile, no auth, no settings)
    const gen = `${AGENT}/briefing/integration/generation-000004`;
    fs.cpSync(`${REPO}/dist`, gen, { recursive: true });
    fs.mkdirSync(`${AGENT}/extensions`, { recursive: true });
    fs.writeFileSync(`${AGENT}/extensions/omo-briefing.js`, [
      '// integration shim: this repo\'s dist, with the browser opener replaced by a logger (no browser is ever started)',
      "import { appendFileSync } from 'node:fs';",
      "import { createBriefingExtension } from '../briefing/integration/generation-000004/extension.mjs';",
      'export default createBriefingExtension({',
      '  openPage: (target) => { appendFileSync(process.env.OMO_FAKE_OPEN_LOG, `${target}\\n`); return { launcher: \'fake\', command: \'fake\', args: [String(target)] }; },',
      '});',
      '',
    ].join('\n'));
    const hostEnv = { OMO_BRIEFING_PORT_BASE: String(PORT_BASE), OMO_FAKE_OPEN_LOG: `${WORK}/fake-open.log` };
    fs.writeFileSync(hostEnv.OMO_FAKE_OPEN_LOG, '');
    const common = ['-e', `${harnessDir}/scripted-provider.mjs`, '--model', 'scripted/scripted-1'];
    const mk = (label) => track(new Host(label, { sessionDir: `${WORK}/sessions-${label}`, cwd: `${WORK}/proj-${label}`, extraArgs: common, env: hostEnv }).start());

    // ---- setup: B first (it owns the board server), then A joins
    const B = mk('B');
    const readyB = await readyHost(B, 'B');
    const sidB = readyB.state.sessionId;
    const serverJson = await waitUntil(() => { const s = readServerJson(); return s && s.pid === B.proc.pid ? s : null; }, { watch: [STATE], timeoutMs: 20000, what: 'B owns the board server (server.json)' });
    const port = serverJson.port;
    const A = mk('A');
    const readyA = await readyHost(A, 'A');
    const sidA = readyA.state.sessionId;
    const stillB = readServerJson();
    check('setup', port >= PORT_BASE && port < PORT_BASE + PORT_COUNT && stillB && stillB.pid === B.proc.pid && stillB.port === port
      && sidA !== sidB && readyA.commandNames.includes('brief') && readyB.commandNames.includes('decide'),
    { owner: 'B', serverPid: stillB && stillB.pid, bPid: B.proc.pid, aPid: A.proc.pid, port, sidA, sidB });

    // ---- A's scripted turn: one brief with three decisions (#1 option, #2 text, #3 /decide from B)
    const mBrief = await prompt(A, `brief 호출 BRIEFJSON:${JSON.stringify(briefJson())}`);
    const briefEnd = await toolEnd(A, mBrief, 'brief', 'A brief tool_execution_end');
    await A.waitEvent(isSettled, { from: mBrief, timeoutMs: 60000, what: 'A settled (brief)' });
    const decisions = listDir(`${STATE}/decisions`).filter((f) => f.endsWith('.json')).map((f) => readJson(`${STATE}/decisions/${f}`));
    const ids = decisions.map((d) => d && d.id);
    const aIdle = (await A.send({ type: 'get_state' })).data.isStreaming === false;
    check('brief', briefEnd.ev.isError !== true && JSON.stringify(ids) === '[1,2,3]' && decisions.every((d) => d && d.sessionId === sidA) && aIdle,
      { isError: briefEnd.ev.isError === true, decisionIds: ids, owners: decisions.map((d) => d && d.sessionId), aIdle });

    // ---- the page: GET / carries exactly one token meta (the test reads it like the page script does)
    const page = await httpGet(port, '/');
    const metas = [...page.body.matchAll(TOKEN_META)];
    token = metas.length === 1 ? metas[0][1] : '';
    check('token', page.status === 200 && metas.length === 1 && token.length >= 32, { status: page.status, metaCount: metas.length, tokenLength: token.length });

    // ---- step 1: option answer from the board -> only A, once, 보낸 대화: 상황판, proven receipt, B receives nothing
    const m1 = A.mark();
    const mB1 = B.mark();
    const r1 = await postAnswer(port, token, { id: 1, sessionId: sidA, option: 'B' });
    const s1 = await awaitDelivery(A, m1, 1);
    check('step1', r1.status === 200 && r1.json && r1.json.ok === true
      && s1.text.includes('[결정 전달] #1 -> B') && s1.text.includes('보낸 대화: 상황판') && s1.count === 1 && entriesOf(readyA.state.sessionFile, 1) === 1
      && s1.receipt.proven === true && s1.receipt.sessionId === sidA
      && !B.eventsFrom(mB1).some(isAnyDelivery) && sessionEntries(readyB.state.sessionFile).every((e) => e.customType !== 'session_control_delivery'),
    { post: { status: r1.status, json: r1.json }, deliveredText: s1.text, deliveriesInA: s1.count, receipt: s1.receipt, bDeliveries: B.eventsFrom(mB1).filter(isAnyDelivery).length });

    // ---- step 2: text reply -> A gets the owner's own words as [상황판 답글]
    const m2 = A.mark();
    const r2 = await postAnswer(port, token, { id: 2, sessionId: sidA, text: '설치해 줘' });
    const s2 = await awaitDelivery(A, m2, 2);
    check('step2', r2.status === 200 && r2.json && r2.json.ok === true
      && /^\[상황판 답글\] #2 \(소유자가 상황판에서 직접 씁, \d\d:\d\d\): 설치해 줘$/.test(s2.text) && s2.count === 1 && entriesOf(readyA.state.sessionFile, 2) === 1
      && s2.receipt.proven === true && s2.receipt.sessionId === sidA,
    { post: { status: r2.status, json: r2.json }, deliveredText: s2.text, deliveriesInA: s2.count, receipt: s2.receipt });

    // ---- guards on the still-open decision #3: every refused write leaves answers/ and receipts/ byte-identical
    const before = { answers: inventoryDir(`${STATE}/answers`), receipts: inventoryDir(`${STATE}/receipts`) };
    const good = pageHeaders(port, token);
    const omit = (h, k) => Object.fromEntries(Object.entries(h).filter(([key]) => key !== k));
    const long = '가'.repeat(501);
    const probes = [
      ['wrong token', 403, 'FORBIDDEN_TOKEN', { id: 3, sessionId: sidA, option: 'A' }, { ...good, 'X-Board-Token': `${token}x` }],
      ['no Sec-Fetch-Site', 403, 'FORBIDDEN_SITE', { id: 3, sessionId: sidA, option: 'A' }, omit(good, 'Sec-Fetch-Site')],
      ['foreign Origin', 403, 'FORBIDDEN_ORIGIN', { id: 3, sessionId: sidA, option: 'A' }, { ...good, Origin: 'http://evil.example' }],
      ['not JSON content type', 415, 'UNSUPPORTED_TYPE', { id: 3, sessionId: sidA, option: 'A' }, { ...good, 'Content-Type': 'text/plain' }],
      ['malformed JSON body', 400, 'BAD_REQUEST', '{"id":3,', undefined],
      ['option outside A/B/C', 400, 'BAD_REQUEST', { id: 3, sessionId: sidA, option: 'D' }, undefined],
      ['other conversation id', 409, 'SESSION_MISMATCH', { id: 3, sessionId: sidB, option: 'A' }, undefined],
      ['501-character reply', 400, 'BAD_TEXT', { id: 3, sessionId: sidA, text: long }, undefined],
      ['unknown decision', 404, 'NOT_FOUND', { id: 999, sessionId: sidA, option: 'A' }, undefined],
      ['path-like conversation id', 409, 'NO_TEXT_SUPPORT', { id: 3, sessionId: '../../x', text: '안녕' }, undefined],
    ];
    const probeResults = [];
    for (const [name, status, code, body, headers] of probes) {
      const r = await postAnswer(port, token, body, headers);
      probeResults.push({ name, want: `${status} ${code}`, got: `${r.status} ${r.json && r.json.code}`, ok: r.status === status && r.json && r.json.ok === false && r.json.code === code });
    }
    const after = { answers: inventoryDir(`${STATE}/answers`), receipts: inventoryDir(`${STATE}/receipts`) };
    check('guards', probeResults.every((p) => p.ok) && JSON.stringify(before) === JSON.stringify(after) && answerFiles().join() === '000001.json,000002.json',
      { probes: probeResults, answerFiles: answerFiles() });

    // ---- step 3: /decide 3A typed in B still delivers to A (the existing path, any conversation)
    const m3 = A.mark();
    const mB3 = B.mark();
    await B.send({ type: 'prompt', message: '/decide 3A' });
    await B.waitEvent((e) => e.type === 'extension_ui_request' && e.method === 'notify', { from: mB3, timeoutMs: 20000, what: 'B notify for /decide 3A' });
    const s3 = await awaitDelivery(A, m3, 3);
    const notifyTexts = notifies(B.eventsFrom(mB3));
    check('step3', notifyTexts.some((m) => m.includes('반영: #3 A'))
      && s3.text.includes('[결정 전달] #3 -> A') && s3.text.includes('보낸 대화: proj-B') && !s3.text.includes('상황판') && s3.count === 1 && entriesOf(readyA.state.sessionFile, 3) === 1
      && s3.receipt.proven === true && s3.receipt.sessionId === sidA && !B.eventsFrom(mB3).some(isAnyDelivery),
    { bNotify: notifyTexts, deliveredText: s3.text, deliveriesInA: s3.count, receipt: s3.receipt });

    // ---- step 4: the same decision #1 again (even with another option) -> 409 ANSWERED, no new file, nothing delivered
    const answersBefore = inventoryDir(`${STATE}/answers`);
    const receiptsBefore = inventoryDir(`${STATE}/receipts`);
    const m4 = A.mark();
    const r4 = await postAnswer(port, token, { id: 1, sessionId: sidA, option: 'A' });
    await A.send({ type: 'get_state' });
    check('step4', r4.status === 409 && r4.json && r4.json.ok === false && r4.json.code === 'ANSWERED'
      && JSON.stringify(inventoryDir(`${STATE}/answers`)) === JSON.stringify(answersBefore)
      && JSON.stringify(inventoryDir(`${STATE}/receipts`)) === JSON.stringify(receiptsBefore)
      && answerFiles().length === 3 && !A.eventsFrom(m4).some(isAnyDelivery) && !A.eventsFrom(m4).some((e) => e.type === 'agent_start'),
    { post: { status: r4.status, json: r4.json }, answerFiles: answerFiles() });

    // ---- audit: exactly 3 answers and 3 proven receipts for A, none for B; B received nothing at all
    const audit = auditAnswers({ stateDir: STATE, ownerId: sidA, otherIds: [sidB], expected: 3 });
    check('audit', audit.pass && audit.provenForOwner === 3 && audit.forOthers === 0
      && !B.history.some(isAnyDelivery) && sessionEntries(readyB.state.sessionFile).every((e) => e.customType !== 'session_control_delivery'),
    { audit, bDeliveries: B.history.filter(isAnyDelivery).length });

    // ---- the page token lives in memory and in the served page only
    const stateFiles = walk(STATE).filter((f) => fs.readFileSync(f).toString('latin1').includes(token));
    const health = await httpGet(port, '/health');
    const data = await httpGet(port, '/data.json');
    check('tokenNotOnDisk', token.length >= 32 && stateFiles.length === 0 && !health.body.includes(token) && !data.body.includes(token), { filesHoldingToken: stateFiles.map(slash) });
  } catch (err) {
    result.errors.push(String(err && err.stack ? err.stack : err));
    log(`ERROR ${err && err.message ? err.message : err}`);
  }

  // ---- teardown: every host awaited by its close event, then the PID and port audit
  for (const h of [...hosts].reverse()) await h.stop();
  const pidMap = readJson(PIDS) ?? {};
  const alive = Object.entries(pidMap).filter(([, pid]) => pidAlive(pid)).map(([label, pid]) => ({ label, pid }));
  const portsStillBound = [];
  for (let p = PORT_BASE; p < PORT_BASE + PORT_COUNT; p++) if (!(await tcpFree(p))) portsStillBound.push(p);
  result.processes = { started: pidMap, alive, portsStillBound };
  check('livePids0', alive.length === 0 && portsStillBound.length === 0, result.processes);
  fs.writeFileSync(`${OUT}/host-stderr.txt`, hosts.map((h) => `--- ${h.label}\n${h.stderr}`).join('\n'));

  const required = ['setup', 'brief', 'token', 'step1', 'step2', 'guards', 'step3', 'step4', 'audit', 'tokenNotOnDisk', 'livePids0'];
  result.failed = required.filter((k) => result.checks[k] !== true);
  if (result.errors.length > 0) result.failed.push('errors');
  result.pass = result.failed.length === 0;
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(`${OUT}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
  log(`RESULT ${result.pass ? 'PASS' : `FAIL (${result.failed.join(', ')})`} - ${OUT}/result.json`);
  if (!result.pass) process.exitCode = 1;
}

// `node test/integration/answer-scenario.mjs ...` = run the harness with this scenario (rpc-run.mjs imports this file for the real run)
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--out')) argv.push('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-answer-ev-')));
  const run = spawnSync(process.execPath, [path.join(HERE, 'rpc-run.mjs'), '--scenario', 'board-answer', ...argv], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
