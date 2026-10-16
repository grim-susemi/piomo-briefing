// Scenario `plan-view` of the isolated real-host run (plan todo 14). NOT part of `npm test`.
//   node test/integration/rpc-run.mjs --scenario plan-view --out <EV dir> [--real-calls 0..3]
//
// Real `senpi --mode rpc` hosts (A, B = lead conversations, C = a child session) run against a TEMP agent folder that holds
// only: a copy of the live profile's extensions/ (three shims that point outside the copy are removed and the briefing shim is
// replaced), this repo's dist, a tiny test extension and (real observation only) a models.json without any key. No auth file,
// no settings.json. The browser opener of the briefing extension is replaced by a logger, so no browser is ever started.
// Scripted scenarios (a)-(f) use the deterministic provider of scripted-provider.mjs: ZERO real model questions.
// (g) native `task` child + the real-model observation (at most 3 prompts, counted in real-calls.json BEFORE each prompt).
// Waiting is event driven (host events, fs.watch, SSE) with bounded timeouts; there are no fixed sleeps.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { inventoryDir, auditState } from './state-audit.mjs';

const LIVE_AGENT = 'C:/Users/USER/.omo-stable-500/home/.omo/agent';
const LIVE_STATE = `${LIVE_AGENT}/briefing/state`;
const PORT_BASE = 47390;
const PORT_COUNT = 10;
const REAL_MODEL = 'ollama-local/glm-5.3-flash:cloud';
const REAL_MAX = 3;
const HANDOVER_MS = 10000; // plan IS-8
const SSE_MS = 1500; // plan IS-1 (+ row (d))

// ------------------------------------------------------------------ hashing of the live profile (READ only)
// herdr-dashboard/state, /recovery and herdr-dag/<24 hex>[.json|.pane.json|/] are the live Herdr dashboard's per-conversation runtime state:
// the owner's own running conversation rewrites them every few seconds (their content names the owner's pane and tasks), so they cannot be compared.
const HASH_EXCLUDE_DIRS = ['herdr-dashboard/state', 'herdr-dashboard/recovery', 'briefing/state', 'sessions', 'logs', 'projects', 'tmp', 'cache', 'runtime', 'process-crashes', 'custom-archive', 'gateway', 'tools', 'bin', 'ouroboros'];
const HASH_EXCLUDE_FILES = ['OmO-debug.log', 'state.json', 'credential-pool-state.json', 'harness-detect-cache.json', 'models-store.json'];

function hashLiveAgent(slash) {
  const files = {};
  const skip = new Set(HASH_EXCLUDE_DIRS);
  const skipFiles = new Set(HASH_EXCLUDE_FILES);
  const herdrRuntime = /^herdr-dag\/[0-9a-f]{24}(\.|\/|$)/;
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip.has(r) || herdrRuntime.test(r)) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && !(rel === '' && skipFiles.has(e.name))) {
        files[r] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      }
    }
  })(slash(LIVE_AGENT), '');
  return { root: LIVE_AGENT, excludedDirs: [...HASH_EXCLUDE_DIRS, 'herdr-dag/<24 hex>*'], excludedTopLevelFiles: HASH_EXCLUDE_FILES, count: Object.keys(files).length, files };
}

// ------------------------------------------------------------------ http helpers
function httpGet(port, p, { headers = {}, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false, headers: { Connection: 'close', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`GET ${p} timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

/** Server-sent events client. events[] = {t, event, data}; waitFor subscribes to arrivals. */
function openSse(port, waitUntil) {
  const sse = { events: [], listeners: new Set(), status: null, closed: false, error: null, port };
  let buf = '';
  const notify = () => { for (const l of [...sse.listeners]) l(); };
  sse.req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false, headers: { Accept: 'text/event-stream' } }, (res) => {
    sse.status = res.statusCode;
    sse.contentType = res.headers['content-type'];
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = { t: Date.now() };
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) ev.data = `${ev.data ?? ''}${line.slice(5).trim()}`;
          else if (line.startsWith('retry:')) ev.retry = line.slice(6).trim();
        }
        if (ev.event || ev.data !== undefined || ev.retry !== undefined) sse.events.push(ev);
      }
      notify();
    });
    res.on('close', () => { sse.closed = true; notify(); });
    res.on('error', () => { sse.closed = true; notify(); });
    notify();
  });
  sse.req.on('error', (e) => { sse.error = e; sse.closed = true; notify(); });
  sse.waitFor = (pred, { timeoutMs, what }) => waitUntil(() => sse.events.find(pred) ?? (sse.closed ? (() => { throw new Error(`SSE closed while waiting for ${what}: ${sse.error ? sse.error.message : 'stream ended'}`); })() : null),
    { subscribe: (t) => { sse.listeners.add(t); return () => sse.listeners.delete(t); }, timeoutMs, what });
  sse.close = () => { sse.req.destroy(); };
  return sse;
}

const tcpFree = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(true));
});

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ------------------------------------------------------------------ fixtures
const briefJson = (title, headline) => ({
  title,
  status: 'needs_decision',
  headline,
  changes: [{ text: '시험용 변화 한 줄', truth: 'reported', applied: 'candidate' }],
  done: [],
  next: '결정 전달 확인',
  decisions: [
    { question: '시험 결정은 어느 쪽으로 갈까?', options: { A: { text: 'A안 진행', consequence: '빠르게 끝난다' }, B: { text: 'B안 진행', consequence: '더 안전하다' } }, recommend: 'A', reason: '시험용이라 빠른 쪽', blocks: true },
  ],
  flow: [{ label: '시험', state: 'doing' }],
});

const planInput = (planPath) => ({
  planPath,
  stage: 'review',
  stageNote: '통합 시험',
  goal: '통합 시험용 작은 계획',
  ideal: [{ id: 'IS-1', text: '계획이 상황판에 보인다' }],
  components: [{ id: 'c1', label: '서버', text: '실시간 서버' }],
  waves: [{ n: 1, label: '기초' }, { n: 2, label: '연결' }],
  tasks: [
    { id: '1', wave: 1, label: '뼈대', what: '뼈대를 만든다', done: '뼈대 시험 통과', deps: [] },
    { id: '2', wave: 2, label: '연결', what: '뼈대를 연결한다', done: '연결 시험 통과', deps: ['1'] },
    { id: '3', wave: 2, label: '문서', what: '문서를 쓴다', done: '문서 검토 통과', deps: ['1'] },
  ],
  questions: [{
    id: 'Q1', text: '시험용 질문: 어느 쪽으로 갈까?', state: 'open',
    options: { A: { text: 'A안 진행', consequence: '빠르게 끝난다' }, B: { text: 'B안 진행', consequence: '더 안전하다' } },
    recommend: 'A', reason: '시험용이라 빠른 쪽', blocks: true,
  }],
  outOfScope: ['답하기 버튼'],
});
const PLAN_MD = '# Plan: integration demo\n\n- [ ] 1. Skeleton\n  Parallelization: Wave 1 | Blocked by: none | Blocks: 2, 3\n- [ ] 2. Wiring\n  Parallelization: Wave 2 | Blocked by: 1 | Blocks: none\n- [ ] 3. Docs\n  Parallelization: Wave 2 | Blocked by: 1 | Blocks: none\n';

const taskRow = (id, status, extra = {}) => ({
  task_id: id, parent_session_id: null, status, task_summary: '통합 시험 작업자', agent_type: 'executor', model_id: 'scripted-1',
  created_at: new Date(Date.now() - 5000).toISOString(), updated_at: new Date().toISOString(), ...extra,
});

// ------------------------------------------------------------------ the scenario
export async function runPlanView(ctx) {
  const { Host, waitUntil, readyHost, readJson, listDir, args, OUT, WORK, AGENT, STATE, HERE, REPO, SCRIPT_LOG, PIDS, slash } = ctx;
  const RUN_TXT = `${OUT}/run.txt`;
  fs.writeFileSync(RUN_TXT, '');
  const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); fs.appendFileSync(RUN_TXT, `${line}\n`); };
  const OPEN_LOG = `${WORK}/fake-open.log`;
  const result = {
    scenario: 'plan-view', startedAt: new Date().toISOString(), portBase: PORT_BASE,
    checks: {}, details: {}, notRun: {}, realModel: { model: REAL_MODEL, calls: [] }, errors: [],
  };
  const check = (name, pass, detail) => { result.checks[name] = pass === true; if (detail !== undefined) result.details[name] = detail; log(`${pass === true ? 'PASS' : 'FAIL'} ${name}`); };
  const hosts = [];
  const track = (h) => { hosts.push(h); return h; };
  let sse = null;
  let hashBefore = null;
  let stateBefore = null; // inventory of the LIVE briefing/state (the publish destination), read-only
  const testIds = [WORK, 'st_pv14w1', 'st_pv14c']; // every identifier this run creates; none may appear in the live briefing/state afterwards

  const scriptedCalls = () => (fs.existsSync(SCRIPT_LOG) ? fs.readFileSync(SCRIPT_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const toolsSeen = (host) => scriptedCalls().filter((c) => c.pid === host.proc.pid).map((c) => c.tools);
  const toolEnd = (host, from, name, what) => host.waitEvent((e) => e.type === 'tool_execution_end' && e.toolName === name, { from, timeoutMs: 60000, what });
  const prompt = async (host, message) => {
    const m = host.mark();
    const r = await host.send({ type: 'prompt', message });
    if (!r.success) throw new Error(`prompt rejected by ${host.label}: ${JSON.stringify(r)}`);
    return m;
  };
  const readServerJson = () => readJson(`${STATE}/server.json`);
  const dataVm = () => {
    try {
      const text = fs.readFileSync(`${STATE}/data.js`, 'utf8');
      const m = /__briefData\((\{[\s\S]*\})\);\s*$/.exec(text);
      return m ? JSON.parse(m[1]) : null;
    } catch { return null; }
  };
  const sessionRow = (vm, sid) => (vm && Array.isArray(vm.sessions) ? vm.sessions.find((s) => s && (s.id === sid || s.sessionId === sid)) : undefined);

  try {
    // ---- 0. temp agent folder (nothing from the live profile except extensions/ and this dist)
    hashBefore = hashLiveAgent(slash);
    fs.writeFileSync(`${OUT}/agent-hash-before.json`, `${JSON.stringify(hashBefore, null, 2)}\n`);
    log(`live profile hashed before: ${hashBefore.count} files`);
    stateBefore = inventoryDir(LIVE_STATE);
    fs.writeFileSync(`${OUT}/state-before.json`, `${JSON.stringify({ root: LIVE_STATE, count: Object.keys(stateBefore).length, files: stateBefore }, null, 2)}\n`);
    log(`live briefing/state inventoried before: ${Object.keys(stateBefore).length} files`);
    fs.cpSync(`${LIVE_AGENT}/extensions`, `${AGENT}/extensions`, { recursive: true });
    const removedShims = [];
    for (const f of ['omo-briefing.js', 'omo-herdr-dashboard.js', 'omo-task-record-publish-retry.js']) {
      // their relative targets (../briefing/..., ../herdr-dashboard/..., ../task-record-publish-retry/...) are not part of the copy
      if (fs.existsSync(`${AGENT}/extensions/${f}`)) { fs.rmSync(`${AGENT}/extensions/${f}`); removedShims.push(f); }
    }
    const gen = `${AGENT}/briefing/integration/generation-000004`;
    fs.cpSync(`${REPO}/dist`, gen, { recursive: true });
    fs.writeFileSync(`${AGENT}/extensions/omo-briefing.js`, [
      '// integration shim: this repo\'s dist, with the browser opener replaced by a logger (no browser is ever started)',
      "import { appendFileSync } from 'node:fs';",
      "import { createBriefingExtension } from '../briefing/integration/generation-000004/extension.mjs';",
      'export default createBriefingExtension({',
      '  openPage: (target) => { appendFileSync(process.env.OMO_FAKE_OPEN_LOG, `${target}\\n`); return { launcher: \'fake\', command: \'fake\', args: [String(target)] }; },',
      '});',
      '',
    ].join('\n'));
    fs.writeFileSync(`${AGENT}/extensions/omo-test-emit.js`, [
      '// test extension: /t14-emit {"name":..,"data":..} -> pi.rpc.emit(name, data) through the real extension loader',
      'export default function (pi) {',
      "  pi.registerCommand('t14-emit', { description: 'integration test: pi.rpc.emit', handler: async (args) => { const m = JSON.parse(String(args)); pi.rpc.emit(m.name, m.data); } });",
      '}',
      '',
    ].join('\n'));
    result.setup = {
      agentDir: 'temp (deleted at the end)', copiedFromLive: ['extensions/'], removedShims, dist: 'REPO/dist -> briefing/integration/generation-000004',
      authFiles: false, settingsJson: false, fakeOpener: true, portBase: PORT_BASE,
      extensions: fs.readdirSync(`${AGENT}/extensions`).sort(),
    };
    fs.writeFileSync(OPEN_LOG, '');
    const hostEnv = { OMO_BRIEFING_PORT_BASE: String(PORT_BASE), OMO_FAKE_OPEN_LOG: OPEN_LOG };
    const common = ['-e', `${HERE}/scripted-provider.mjs`, '--model', 'scripted/scripted-1'];
    const mk = (label, dir, sessionsDir) => track(new Host(label, { sessionDir: sessionsDir ?? `${WORK}/sessions-${label}`, cwd: `${WORK}/${dir}`, extraArgs: common, env: hostEnv }).start());

    // ---- (a) two leads + one child; the tool lists the model is offered are recorded by the scripted provider
    const A = mk('A', 'proj-A');
    const readyA = await readyHost(A, 'A');
    const sidA = readyA.state.sessionId;
    testIds.push(sidA);
    const serverAtStart = await waitUntil(() => readServerJson(), { watch: [STATE], timeoutMs: 20000, what: 'A brought the board server up (server.json)' });
    const B = mk('B', 'proj-B');
    const readyB = await readyHost(B, 'B');
    const sidB = readyB.state.sessionId;
    testIds.push(sidB);
    const C = mk('C', 'proj-C', `${WORK}/proj-C/.omo/senpi-task/children/st_pv14c/sessions`);
    const readyC = await readyHost(C, 'C');
    testIds.push(readyC.state.sessionId);
    for (const h of [A, B, C]) { const m = await prompt(h, 'PING 도구 목록 확인'); await h.waitEvent(ctx.isSettled, { from: m, timeoutMs: 60000, what: `${h.label} settled (PING)` }); }
    const toolsA = toolsSeen(A).at(-1) ?? [];
    const toolsB = toolsSeen(B).at(-1) ?? [];
    const toolsC = toolsSeen(C).at(-1) ?? [];
    const childFile = String(readyC.state.sessionFile);
    check('a', toolsA.includes('brief') && toolsA.includes('plan_brief') && toolsB.includes('brief') && toolsB.includes('plan_brief')
      && toolsC.length > 0 && !toolsC.includes('brief') && !toolsC.includes('plan_brief')
      && /[/\\]senpi-task[/\\]children[/\\]/.test(childFile) && !readyC.commandNames.includes('brief') && !fs.existsSync(`${STATE}/sessions/${readyC.state.sessionId}`),
    { toolsA, toolsB, toolsC, childFile, childCommands: readyC.commandNames, leadCommands: readyA.commandNames.filter((n) => ['brief', 'decide'].includes(n)) });

    // ---- (b) plan_brief from A: revision + decision, same input again -> same decision id
    const planFile = slash(`${WORK}/proj-A/.omo/plans/pv-demo.md`);
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, PLAN_MD);
    const input = planInput(planFile);
    const callPlan = async () => {
      const m = await prompt(A, `plan_brief 호출 TOOLCALL:plan_brief:${JSON.stringify(input)}`);
      const end = await toolEnd(A, m, 'plan_brief', 'A plan_brief tool_execution_end');
      await A.waitEvent(ctx.isSettled, { from: m, timeoutMs: 60000, what: 'A settled (plan_brief)' });
      return end.ev;
    };
    const first = await callPlan();
    const d1 = first.result && first.result.details;
    const planId = d1 && d1.planId;
    if (planId) testIds.push(planId);
    testIds.push(planFile);
    const revFile = planId ? `${STATE}/plans/${planId}/rev-000001.json` : null;
    const decisionsOfPlan = () => listDir(`${STATE}/decisions`).filter((f) => f.endsWith('.json')).map((f) => readJson(`${STATE}/decisions/${f}`)).filter((d) => d && d.source === 'plan');
    const decs1 = decisionsOfPlan();
    const second = await callPlan();
    const d2 = second.result && second.result.details;
    const decs2 = decisionsOfPlan();
    check('b', first.isError !== true && Boolean(d1) && d1.rev === 1 && Boolean(revFile) && fs.existsSync(revFile)
      && Array.isArray(d1.created) && d1.created.length === 1 && decs1.length === 1 && decs1[0].planId === planId && decs1[0].qid === 'Q1'
      && second.isError !== true && Boolean(d2) && Array.isArray(d2.created) && d2.created.length === 0
      && JSON.stringify(d2.opened) === JSON.stringify(d1.opened) && decs2.length === 1 && decs2[0].id === decs1[0].id,
    { first: d1, second: d2, firstError: first.isError === true ? first.result : undefined, decisionId: decs1[0] && decs1[0].id, decisionsAfterSecond: decs2.length, revFile });

    // ---- (c) /brief on A: server.json + GET / 200 (fake opener); B reuses the same port
    const mBriefA = await prompt(A, '/brief');
    const opened = await waitUntil(() => { const l = fs.readFileSync(OPEN_LOG, 'utf8').split('\n').filter(Boolean); return l.length >= 1 ? l : null; }, { watch: [WORK], timeoutMs: 20000, what: 'fake opener log line after /brief on A' });
    const srv = readServerJson();
    const port = srv && srv.port;
    const root = await httpGet(port, '/');
    const health = JSON.parse((await httpGet(port, '/health')).body);
    const mBriefB = await prompt(B, '/brief');
    const openedB = await waitUntil(() => { const l = fs.readFileSync(OPEN_LOG, 'utf8').split('\n').filter(Boolean); return l.length >= 2 ? l : null; }, { watch: [WORK], timeoutMs: 20000, what: 'fake opener log line after /brief on B' });
    const srvAfterB = readServerJson();
    const probes = [];
    for (let p = PORT_BASE; p < PORT_BASE + PORT_COUNT; p++) probes.push({ port: p, free: await tcpFree(p) });
    const listening = probes.filter((x) => !x.free).map((x) => x.port);
    check('c', Boolean(srv) && srv.pid === A.proc.pid && port >= PORT_BASE && port < PORT_BASE + PORT_COUNT && root.status === 200
      && /text\/html/.test(String(root.headers['content-type'])) && health.ok === true && health.pid === A.proc.pid
      && opened[0] === `http://127.0.0.1:${port}/` && openedB[1] === opened[0]
      && srvAfterB && srvAfterB.pid === srv.pid && srvAfterB.port === port && listening.length === 1 && listening[0] === port,
    { serverAtStart, serverJson: srv, rootStatus: root.status, health, openedByA: opened[0], openedByB: openedB[1], listeningPorts: listening, aPid: A.proc.pid, bPid: B.proc.pid });
    void mBriefA; void mBriefB;

    // ---- (d) SSE client on the shared server; B publishes a brief -> the owner pushes it within 1.5 s
    sse = openSse(port, waitUntil);
    const initial = await sse.waitFor((e) => e.event === 'data', { timeoutMs: 10000, what: 'initial SSE data event' });
    const headline = '통합 시험 B 보고: 실시간 반영 확인';
    const mD = await prompt(B, `brief 호출 BRIEFJSON:${JSON.stringify(briefJson('통합 시험 B', headline))}`);
    const briefEnd = await toolEnd(B, mD, 'brief', 'B brief tool_execution_end');
    const tEnd = Date.now();
    const pushed = await sse.waitFor((e) => e.event === 'data' && typeof e.data === 'string' && e.data.includes(headline), { timeoutMs: 10000, what: 'SSE data event with the headline B published' });
    const latency = Math.max(0, pushed.t - tEnd);
    await B.waitEvent(ctx.isSettled, { from: mD, timeoutMs: 60000, what: 'B settled (brief)' });
    check('d', sse.status === 200 && /text\/event-stream/.test(String(sse.contentType)) && sse.events.some((e) => e.retry === '1000') && briefEnd.ev.isError !== true && latency <= SSE_MS,
      { sseStatus: sse.status, initialSeq: JSON.parse(initial.data).seq, pushedSeq: JSON.parse(pushed.data).seq, latencyMs: latency, limitMs: SSE_MS, eventCount: sse.events.length });
    sse.close();
    sse = null;

    // ---- (f) a test extension emits the task bus event through the real loader -> worker row in A's published data
    const W1 = 'st_pv14w1';
    const emit = async (status, extra = {}) => {
      const data = { parent_session_id: `senpi:${sidA}`, tasks: [{ ...taskRow(W1, status, extra), parent_session_id: `senpi:${sidA}` }] };
      const m = await prompt(A, `/t14-emit ${JSON.stringify({ name: 'omo.task.updated', data })}`);
      return m;
    };
    const stateOfRow = (r) => String(r.state ?? r.status ?? '');
    const waitWorker = (pred, what) => waitUntil(() => {
      const row = sessionRow(dataVm(), sidA);
      const w = row && row.live && Array.isArray(row.live.workers) ? row.live.workers.find((x) => x && (x.id === W1 || x.taskId === W1)) : null;
      return w && pred(w) ? w : null;
    }, { watch: [STATE], timeoutMs: 20000, what });
    await emit('running', { live_progress: { current_tool: 'bash', started_at: new Date().toISOString() } });
    const running = await waitWorker((w) => stateOfRow(w) === 'running', 'worker row running in A data.js');
    const httpVm = JSON.parse((await httpGet(port, '/data.json')).body);
    const rowHttp = sessionRow(httpVm, sidA);
    await emit('completed', { terminal_at: new Date().toISOString() });
    const done = await waitWorker((w) => stateOfRow(w) === 'done', 'worker row done in A data.js');
    check('f', stateOfRow(running) === 'running' && stateOfRow(done) === 'done'
      && Boolean(rowHttp && rowHttp.live && rowHttp.live.workers.some((w) => w.id === W1)),
    { runningRow: running, doneRow: done, viaHttpDataJson: Boolean(rowHttp) });

    // ---- (g) native `task` child: only possible when this host offers a task tool
    {
      const m = await prompt(A, `자식 작업 시도 TOOLCALL:task:${JSON.stringify({ description: 'plan-view integration child', prompt: 'say done', category: 'quick' })}`);
      const end = await toolEnd(A, m, 'task', 'A task tool_execution_end');
      await A.waitEvent(ctx.isSettled, { from: m, timeoutMs: 60000, what: 'A settled (task)' });
      const offered = toolsSeen(A).at(-1) ?? [];
      const errText = JSON.stringify(end.ev.result ?? end.ev).slice(0, 600);
      const taskOffered = toolsSeen(A).flat().includes('task');
      result.notRun.g = {
        status: 'not run',
        reason: taskOffered
          ? 'the host offers a task tool but this run has no scripted child runner, so no running -> done transition of a native child was observed'
          : 'this isolated host has no native task-engine extension (only the copied builtin extensions): the model is offered no `task` tool',
        taskToolOffered: taskOffered, toolsOfferedToModel: offered, calledTaskIsError: end.ev.isError === true, exactResult: errText,
      };
      log(`(g) not run: ${result.notRun.g.reason}; call result isError=${end.ev.isError} ${errText.slice(0, 200)}`);
    }

    // ---- (e) the port owner A disappears (taskkill, like a closed terminal: no session_shutdown) -> B takes over within 10 s
    const ownerBefore = readServerJson();
    await A.stop();
    const tGone = Date.now();
    const takeover = await waitUntil(() => { const s = readServerJson(); return s && s.pid === B.proc.pid ? s : null; }, { watch: [STATE], timeoutMs: HANDOVER_MS, what: 'B took over server.json within 10 s' }).catch((err) => ({ error: err.message }));
    const tookMs = Date.now() - tGone;
    let healthAfter = null;
    if (takeover && !takeover.error) { try { healthAfter = JSON.parse((await httpGet(takeover.port, '/health')).body); } catch (err) { healthAfter = { error: err.message }; } }
    check('e', Boolean(takeover) && !takeover.error && takeover.pid === B.proc.pid && ownerBefore.pid === A.proc.pid && tookMs <= HANDOVER_MS
      && healthAfter && healthAfter.ok === true && healthAfter.pid === B.proc.pid,
    { ownerBefore, takeover, tookMs, limitMs: HANDOVER_MS, healthAfter, samePort: Boolean(takeover && takeover.port === ownerBefore.port) });
    void sidB;
  } catch (err) {
    result.errors.push(String(err && err.stack ? err.stack : err));
    log(`ERROR ${err && err.message ? err.message : err}`);
  } finally {
    if (sse) sse.close();
  }

  // ---- real model observation (never part of the verdict; at most 3 prompts, counted BEFORE each one is sent)
  const countFile = `${OUT}/real-calls.json`;
  const wantReal = Math.min(REAL_MAX, Number(args.realCalls ?? REAL_MAX));
  // `--real-model scripted/scripted-1` is a dry run of this very code path (counting, hosts, events) that asks no real model anything
  const realModel = args.realModel ?? REAL_MODEL;
  const dry = realModel.startsWith('scripted/');
  result.realModel.model = realModel;
  if (dry) result.realModel.dryRun = true;
  const writeCount = (n) => fs.writeFileSync(countFile, `${JSON.stringify({ model: realModel, dryRun: dry, max: REAL_MAX, promptsSubmitted: n, calls: result.realModel.calls.map((c) => ({ n: c.n, planBriefCalled: c.planBriefCalled })) }, null, 2)}\n`);
  writeCount(0);
  if (wantReal === 0) {
    result.realModel.status = 'not run';
    result.realModel.reason = '--real-calls 0 (the 3-call budget was spent in attempt 1; its evidence is carried by reference)';
    result.realModel.attempt1Evidence = 'task-14/attempt1/real-calls.json';
  } else {
    try {
      const base = 'http://127.0.0.1:11500';
      if (!dry) {
        const tags = await httpGetUrl(`${base}/api/tags`);
        if (!tags.models.some((m) => m.name === 'glm-5.3-flash:cloud')) throw new Error('the local Ollama proxy does not list glm-5.3-flash:cloud');
      }
      if (!dry) fs.writeFileSync(`${AGENT}/models.json`, JSON.stringify({ providers: { 'ollama-local': {
        name: 'Ollama Local (integration)', api: 'openai-completions', baseUrl: `${base}/v1`, apiKey: 'ollama',
        models: [{ id: 'glm-5.3-flash:cloud', name: 'GLM 5.3 flash (cloud)', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens', supportsStrictMode: false, supportsLongCacheRetention: false } }],
      } } }, null, 2));
      for (let n = 1; n <= wantReal; n++) {
        const realPlan = slash(`${WORK}/proj-R${n}/.omo/plans/real-demo.md`);
        fs.mkdirSync(path.dirname(realPlan), { recursive: true });
        if (dry) fs.writeFileSync(realPlan, PLAN_MD);
        const R = new Host(`R${n}`, { sessionDir: `${WORK}/sessions-R${n}`, cwd: `${WORK}/proj-R${n}`, extraArgs: dry ? ['-e', `${HERE}/scripted-provider.mjs`, '--model', realModel] : ['--model', realModel], env: { OMO_BRIEFING_PORT_BASE: String(PORT_BASE), OMO_FAKE_OPEN_LOG: OPEN_LOG } });
        hosts.push(R);
        R.start();
        const call = { n, planFile: realPlan, planBriefCalled: false, toolCalls: [], planBriefResults: [] };
        try {
          const ready = await readyHost(R, `R${n}`);
          testIds.push(ready.state.sessionId, realPlan);
          if (!ready.commandNames.includes('brief')) throw new Error('R has no brief command');
          writeCount(n); // counted before the prompt leaves
          result.realModel.calls.push(call);
          const message = dry ? `dry TOOLCALL:plan_brief:${JSON.stringify(planInput(realPlan))}` : `ulw-plan 방식으로 작은 계획(할 일 3개, 질문 1개)을 세워라. 계획 파일 ${realPlan} 을 써서 저장하고, 그 계획을 plan_brief 도구로 상황판에 올려라 (planPath 는 ${realPlan}).`;
          log(`REAL PROMPT #${n} ${realModel}${dry ? ' (dry run, scripted)' : ''}`);
          const m = R.mark();
          const r = await R.send({ type: 'prompt', message });
          if (!r.success) throw new Error(`real prompt rejected: ${JSON.stringify(r)}`);
          await R.waitEvent(ctx.isSettled, { from: m, timeoutMs: 240000, what: `R${n} settled (real prompt)` });
          for (const e of R.eventsFrom(m)) {
            if (e.type === 'tool_execution_start') call.toolCalls.push(e.toolName);
            if (e.type === 'tool_execution_end' && e.toolName === 'plan_brief') {
              call.planBriefCalled = true;
              call.planBriefResults.push({ isError: e.isError === true, text: JSON.stringify(e.result ?? null).slice(0, 400) });
            }
          }
          call.planBriefValid = call.planBriefResults.some((x) => !x.isError);
        } catch (err) {
          call.error = String(err.message || err);
          log(`real call ${n} error: ${call.error}`);
        }
        writeCount(n);
      }
      result.realModel.status = 'run';
    } catch (err) {
      result.realModel.status = 'not run';
      result.realModel.reason = String(err.message || err);
      log(`real model observation not run: ${result.realModel.reason}`);
    }
  }
  result.realModel.promptsSubmitted = result.realModel.calls.length;

  // ---- teardown: every host awaited by its close event, then the live PID audit and the live-profile hash
  for (const h of [...hosts].reverse()) await h.stop();
  const pidMap = readJson(PIDS) ?? {};
  const alive = Object.entries(pidMap).filter(([, pid]) => pidAlive(pid)).map(([label, pid]) => ({ label, pid }));
  const portsStillBound = [];
  for (let p = PORT_BASE; p < PORT_BASE + PORT_COUNT; p++) if (!(await tcpFree(p))) portsStillBound.push(p);
  result.processes = { started: pidMap, alive, portsStillBound, execArgv: 'spawn(process.execPath, [cli, ...]) with no execArgv inherited; each host awaited via its close event' };
  check('livePids0', alive.length === 0 && portsStillBound.length === 0, result.processes);
  fs.writeFileSync(`${OUT}/host-stderr.txt`, hosts.map((h) => `--- ${h.label}\n${h.stderr}`).join('\n'));
  if (fs.existsSync(`${STATE}/server.json`)) result.details.leftoverServerJson = readJson(`${STATE}/server.json`);
  if (hashBefore) {
    const after = hashLiveAgent(slash);
    fs.writeFileSync(`${OUT}/agent-hash-after.json`, `${JSON.stringify(after, null, 2)}\n`);
    const same = JSON.stringify(after.files) === JSON.stringify(hashBefore.files);
    const changed = Object.keys({ ...hashBefore.files, ...after.files }).filter((k) => hashBefore.files[k] !== after.files[k]);
    // precise name: this proves only the stable configuration/code subset (see excluded*), NOT briefing/state (checked below)
    check('agentStableConfigHashIdentical', same, { scope: 'AGENT minus the documented excluded dirs/files; briefing/state is audited separately', count: after.count, changed });
  } else check('agentStableConfigHashIdentical', false, 'no before-hash');
  if (stateBefore) {
    // the owner's own live conversations publish into briefing/state during the run: byte equality is impossible and is NOT claimed.
    // Instead: (1) no identifier created by this run appears in any file NAME or CONTENT, (2) every change is listed, not hidden.
    const audit = auditState({ before: stateBefore, stateDir: LIVE_STATE, ids: testIds });
    fs.writeFileSync(`${OUT}/state-after.json`, `${JSON.stringify({ root: LIVE_STATE, count: audit.filesAfter, files: audit.after }, null, 2)}\n`);
    result.testIds = [...new Set(testIds)];
    result.concurrentOwnerChanges = audit.concurrentOwnerChanges;
    check('briefingStateNoTestLeak', audit.pass, { idsChecked: result.testIds.length, filesScanned: audit.filesAfter, leaks: audit.leaks, concurrentOwnerChanges: audit.concurrentOwnerChanges });
  } else check('briefingStateNoTestLeak', false, 'no before-inventory');
  if (fs.existsSync(OPEN_LOG)) result.details.fakeOpenLog = fs.readFileSync(OPEN_LOG, 'utf8').split('\n').filter(Boolean);
  if (fs.existsSync(SCRIPT_LOG)) fs.copyFileSync(SCRIPT_LOG, `${OUT}/scripted-calls.jsonl`);

  // ---- verdict
  const required = ['a', 'b', 'c', 'd', 'e', 'f', 'livePids0', 'agentStableConfigHashIdentical', 'briefingStateNoTestLeak'];
  const failed = required.filter((k) => result.checks[k] !== true);
  const gOk = result.notRun.g !== undefined && typeof result.notRun.g.reason === 'string' && result.notRun.g.reason.length > 0;
  if (!gOk) failed.push('g');
  if (result.realModel.promptsSubmitted > REAL_MAX) failed.push('realCalls<=3');
  if (result.errors.length > 0) failed.push('errors');
  result.g = gOk ? { status: 'not run', evidence: result.notRun.g } : { status: 'missing' };
  result.realModelCalls = result.realModel.promptsSubmitted;
  result.failed = failed;
  result.pass = failed.length === 0;
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(`${OUT}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
  log(`RESULT ${result.pass ? 'PASS' : `FAIL (${failed.join(', ')})`} - ${OUT}/result.json`);
  if (!result.pass) process.exitCode = 1;
}

async function httpGetUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}
