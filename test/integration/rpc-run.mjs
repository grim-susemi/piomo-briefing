// Isolated real-host integration run for omo-briefing (plan todo 14). NOT part of `npm test`.
//
// Starts the REAL senpi/pi host (node <senpi>/dist/bundle/cli.js --mode rpc, the file the global `pi` shim points to)
// with an isolated HOME and agent dir. The extension is the one scripts/install.mjs put in <work>/agent (installed shim),
// plus test/integration/scripted-provider.mjs via `-e` for the deterministic model. Nothing under the live profile is
// read, written or started; no auth file is copied.
//
//   node test/integration/rpc-run.mjs --out <EV dir> [--work <dir>] [--state <dir>] [--phase probe|scripted|real] [--keep]
//   real phase only: --real-model <provider/id> [--real-key-env NAME]   (NAME = environment variable NAME handed through)
//
// Protocol: DOCS rpc.md (JSONL on stdin/stdout, LF only, `prompt`, `abort`, `get_state`, `get_commands`, events
// agent_start / agent_settled / message_end / extension_ui_request).
// Waiting is event driven: every wait subscribes (history index + listener, or fs.watch) before the action that
// produces the signal and has a bounded timeout. No fixed sleeps.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SENPI = 'C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi';
const CLI = `${SENPI}/dist/bundle/cli.js`;
const PI_AI_INDEX = 'C:/Users/USER/.bun/install/global/node_modules/@earendil-works/pi-ai/dist/index.js';
const slash = (p) => String(p).replace(/\\/g, '/');
const pad6 = (n) => String(n).padStart(6, '0');

// ---------------------------------------------------------------- args
const args = (() => {
  const a = { phase: 'scripted', keep: false };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i];
    if (k === '--keep') a.keep = true;
    else if (k.startsWith('--')) a[k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v[++i];
  }
  return a;
})();
if (!args.out) throw new Error('--out <evidence dir> is required');
const OUT = slash(path.resolve(args.out));
fs.mkdirSync(OUT, { recursive: true });
const WORK = slash(path.resolve(args.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-rpc14-'))));
fs.mkdirSync(WORK, { recursive: true });
const AGENT = `${WORK}/agent`;
const STATE = slash(path.resolve(args.state ?? `${AGENT}/briefing/state`));
const PAGE = `${STATE}/index.html`;
const EVENTS = `${OUT}/task-14-events.jsonl`;
const SUMMARY = `${OUT}/task-14-summary.json`;
const PIDS = `${WORK}/pids.json`;
const SCRIPT_LOG = `${WORK}/scripted-calls.jsonl`;
const HOLD_FILE = `${WORK}/count3.release`; // the scripted COUNT3 run stays streaming until this file exists (no timed delay)

// ---------------------------------------------------------------- helpers
function readSummary() {
  try { return JSON.parse(fs.readFileSync(SUMMARY, 'utf8')); } catch { return {}; }
}
function mergeSummary(patch) {
  fs.writeFileSync(SUMMARY, `${JSON.stringify({ ...readSummary(), ...patch }, null, 2)}\n`);
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const listDir = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out.sort();
}

/** Wait until check() is truthy. Re-checks on fs.watch events of `watch` dirs and on `extra` subscribe callbacks. */
function waitUntil(check, { watch = [], subscribe = null, timeoutMs, what }) {
  return new Promise((resolve, reject) => {
    const watchers = [];
    let unsub = null;
    let timer = null;
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const w of watchers) w.close();
      if (unsub) unsub();
      err ? reject(err) : resolve(val);
    };
    const test = () => {
      if (done) return;
      let r;
      try { r = check(); } catch (e) { return finish(e); }
      if (r) finish(null, r);
    };
    for (const d of watch) {
      fs.mkdirSync(d, { recursive: true });
      try { watchers.push(fs.watch(d, { recursive: true }, test)); } catch { /* fall back to host-event re-checks */ }
    }
    if (subscribe) unsub = subscribe(test);
    timer = setTimeout(() => finish(new Error(`timeout (${timeoutMs} ms) waiting for: ${what}`)), timeoutMs);
    test();
  });
}

// ---------------------------------------------------------------- isolated environment
const KEEP_ENV = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'WINDIR', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PROCESSOR_IDENTIFIER']);
function isoEnv(extra = {}) {
  const home = `${WORK}/home`;
  const tmp = `${WORK}/tmp`;
  for (const d of [home, tmp, `${home}/AppData/Roaming`, `${home}/AppData/Local`]) fs.mkdirSync(d, { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (KEEP_ENV.has(k.toUpperCase())) env[k] = v;
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: `${home}/AppData/Roaming`, LOCALAPPDATA: `${home}/AppData/Local`,
    TEMP: tmp, TMP: tmp,
    SENPI_CODING_AGENT_DIR: AGENT, PI_CODING_AGENT_DIR: AGENT,
    SENPI_OFFLINE: '1', PI_OFFLINE: '1',
    OMO_BRIEFING_STATE_DIR: STATE,
    SCRIPTED_PI_AI_URL: pathToFileURL(PI_AI_INDEX).href,
    SCRIPTED_PAGE_PATH: PAGE,
    SCRIPTED_LOG: SCRIPT_LOG,
    SCRIPTED_HOLD_FILE: HOLD_FILE,
  }, extra);
  return env;
}

// ---------------------------------------------------------------- RPC host
class Host {
  constructor(label, { sessionDir, cwd, extraArgs = [], env = {} }) {
    this.label = label;
    this.sessionDir = sessionDir;
    this.cwd = cwd;
    this.extraArgs = extraArgs;
    this.extraEnv = env;
    this.history = [];
    this.listeners = new Set();
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.stderr = '';
    this.exited = null;
    this.closed = false; // the child's 'close' event (stdio drained): stop() waits for this, not just for 'exit'
  }

  start() {
    fs.mkdirSync(this.sessionDir, { recursive: true });
    fs.mkdirSync(this.cwd, { recursive: true });
    const argv = [CLI, '--mode', 'rpc', '--session-dir', this.sessionDir, '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', ...this.extraArgs];
    this.proc = spawn(process.execPath, argv, { cwd: this.cwd, env: isoEnv(this.extraEnv), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const pids = readJson(PIDS) ?? {};
    pids[this.label] = this.proc.pid;
    fs.writeFileSync(PIDS, JSON.stringify(pids));
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) { // LF is the only record delimiter (rpc.md 'Framing')
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => { this.stderr += c; });
    this.proc.on('close', () => { this.closed = true; for (const l of [...this.listeners]) l(); });
    this.proc.on('exit', (code, sig) => {
      this.exited = { code, sig };
      for (const l of this.listeners) l();
      for (const p of this.pending.values()) p.reject(new Error(`host ${this.label} exited (${code}/${sig}) before responding`));
    });
    return this;
  }

  onLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { ev = { type: 'unparsed', line }; }
    this.history.push(ev);
    fs.appendFileSync(EVENTS, `${JSON.stringify({ host: this.label, t: Date.now(), ev })}\n`);
    if (ev.type === 'response' && ev.id && this.pending.has(ev.id)) {
      const p = this.pending.get(ev.id);
      this.pending.delete(ev.id);
      p.resolve(ev);
    }
    if (ev.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor', 'question'].includes(ev.method)) {
      // a dialog nobody can answer would hang the run: dismiss it (rpc.md 'Cancellation response') and keep it in the log
      const reply = { type: 'extension_ui_response', id: ev.id, cancelled: true };
      fs.appendFileSync(EVENTS, `${JSON.stringify({ host: this.label, t: Date.now(), cmd: reply, note: 'auto-cancelled dialog' })}\n`);
      this.proc.stdin.write(`${JSON.stringify(reply)}\n`);
    }
    for (const l of [...this.listeners]) l();
  }

  send(cmd, timeoutMs = 30000) {
    const id = `${this.label}-${this.nextId++}`;
    fs.appendFileSync(EVENTS, `${JSON.stringify({ host: this.label, t: Date.now(), cmd: { ...cmd, id } })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`no response to ${cmd.type} within ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.proc.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
    });
  }

  mark() { return this.history.length; }

  /** Resolve with the first event at index >= from matching pred (subscribes before returning, history-first). */
  waitEvent(pred, { from = 0, timeoutMs = 60000, what = 'event' } = {}) {
    let found = null;
    return waitUntil(() => {
      for (let i = from; i < this.history.length; i++) if (pred(this.history[i], i)) { found = { ev: this.history[i], index: i }; return found; }
      if (this.exited) throw new Error(`host ${this.label} exited while waiting for ${what}: ${JSON.stringify(this.exited)} stderr=${this.stderr.slice(-400)}`);
      return null;
    }, { subscribe: (t) => { this.listeners.add(t); return () => this.listeners.delete(t); }, timeoutMs, what: `${this.label}: ${what}` });
  }

  eventsFrom(from) { return this.history.slice(from); }

  async stop() {
    if (!this.proc || this.closed) return;
    if (!this.exited) spawnSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore' });
    await waitUntil(() => this.closed, { subscribe: (t) => { this.listeners.add(t); return () => this.listeners.delete(t); }, timeoutMs: 15000, what: `${this.label} exit` }).catch(() => {});
  }
}

const isDelivery = (id) => (e) => e.type === 'message_end' && e.message && e.message.role === 'custom'
  && e.message.customType === 'session_control_delivery' && e.message.details && e.message.details.delivery_id === id;
const isSettled = (e) => e.type === 'agent_settled';
const isStart = (e) => e.type === 'agent_start';
const notifies = (events) => events.filter((e) => e.type === 'extension_ui_request' && e.method === 'notify').map((e) => String(e.message));

// ---------------------------------------------------------------- session file + reply metrics (IS-4, machine count)
function sessionEntries(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('\n') : '');

/** Final chat answer of the LAST run and how it came to satisfy (or not) the budget. */
function replyMetrics(file, meta) {
  const entries = sessionEntries(file);
  const lastUserIdx = (() => {
    let idx = -1;
    entries.forEach((e, i) => { if (e.type === 'message' && e.message && e.message.role === 'user' && !String(textOf(e.message.content)).startsWith('[보고 길이]')) idx = i; });
    return idx;
  })();
  const run = entries.slice(lastUserIdx + 1);
  const custom = (t) => run.filter((e) => e.type === 'custom_message' && e.customType === t);
  const assistants = run.filter((e) => e.type === 'message' && e.message && e.message.role === 'assistant');
  const lastAssistant = assistants.length ? textOf(assistants[assistants.length - 1].message.content) : '';
  const appended = custom('omo-briefing-reply');
  const rewrite = custom('omo-briefing-rewrite');
  const finalText = appended.length ? textOf(appended[appended.length - 1].content) : lastAssistant;
  const lines = finalText.split('\n').filter((l) => l.trim() !== '');
  const chars = [...finalText].length;
  const hasPath = finalText.includes(PAGE);
  let how = 'model';
  if (appended.length) how = 'appended';
  else if (meta && meta.replyTrimmed) how = 'trimmed';
  else if (rewrite.length) how = 'rewrite';
  return { lines: lines.length, chars, hasPath, pass: lines.length <= 10 && chars <= 700 && hasPath, how, rewriteRequested: rewrite.length > 0, finalText };
}

function stateTree(note) {
  const files = walk(STATE).map((p) => p.slice(STATE.length + 1));
  const lines = [`# STATE ${STATE}`, `# ${note}`, ...files.map((f) => `  ${f}`), ''];
  for (const f of files.filter((x) => /^(receipts|answers|claims|decisions|decision-closures)\//.test(x) && !x.includes('.stale-'))) {
    lines.push(`--- ${f}`, fs.readFileSync(`${STATE}/${f}`, 'utf8').trim(), '');
  }
  return lines.join('\n');
}

const briefJson = (title) => ({
  title,
  status: 'needs_decision',
  headline: '통합 시험용 보고: 결정 두 개가 열려 있다',
  changes: [{ text: '시험용 변화 한 줄', truth: 'reported', applied: 'candidate' }],
  done: [],
  next: '결정 전달 확인',
  decisions: [
    { question: '첫 번째 시험 결정은 어느 쪽으로 갈까?', options: { A: { text: 'A안 진행', consequence: '빠르게 끝난다' }, B: { text: 'B안 진행', consequence: '더 안전하다' } }, recommend: 'A', reason: '시험용이라 빠른 쪽', blocks: true },
    { question: '두 번째 시험 결정은 어느 쪽으로 갈까?', options: { A: { text: 'A안 진행', consequence: '빠르게 끝난다' }, B: { text: 'B안 진행', consequence: '더 안전하다' } }, recommend: 'B', reason: '시험용이라 안전한 쪽', blocks: true },
  ],
  flow: [{ label: '시험', state: 'doing' }],
});

// ---------------------------------------------------------------- phases
async function readyHost(host, what) {
  const r = await host.send({ type: 'get_state' }, 60000);
  if (!r.success) throw new Error(`${what}: get_state failed ${JSON.stringify(r)}`);
  const cmds = await host.send({ type: 'get_commands' });
  const names = (cmds.data && cmds.data.commands ? cmds.data.commands : []).map((c) => c.name);
  return { state: r.data, commandNames: names };
}

async function phaseProbe() {
  const keyEnv = args.realKeyEnv ? { [args.realKeyEnv]: process.env[args.realKeyEnv] } : {};
  const h = new Host('P', { sessionDir: `${WORK}/sessions-P`, cwd: `${WORK}/proj-P`, extraArgs: ['-e', `${HERE}/scripted-provider.mjs`], env: keyEnv }).start();
  try {
    const ready = await readyHost(h, 'probe');
    const models = await h.send({ type: 'get_available_models' });
    const surfaces = await h.send({ type: 'get_loaded_surfaces' });
    const out = {
      commandNames: ready.commandNames,
      model: ready.state.model && `${ready.state.model.provider}/${ready.state.model.id}`,
      sessionFile: ready.state.sessionFile,
      models: ((models.data && models.data.models) || []).map((m) => `${m.provider}/${m.id}`),
      extensions: ((surfaces.data && surfaces.data.extensions) || []).map((x) => x.path),
      stderr: h.stderr.slice(-600),
    };
    fs.writeFileSync(`${OUT}/task-14-probe.json`, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
  } finally { await h.stop(); }
}

// Every required summary flag of plan row 14 (a)-(f). The exit code is derived from ALL of them; a missing flag counts as false.
const REQUIRED_FLAGS = {
  commandsListed: (s) => s.commandsListed === true, // (a)
  toolListed: (s) => s.toolListed === true, // (a)
  briefStored: (s) => s.briefStored === true, // (b)
  decisionsCreated: (s) => s.decisionsCreated === 2, // (b)
  indexHtmlExists: (s) => s.indexHtmlExists === true, // (b)
  scriptedReplyPass: (s) => Boolean(s.scriptedReply && s.scriptedReply.pass === true && s.scriptedReply.how === 'rewrite'), // (b)
  aIdleBeforeDecide: (s) => s.aIdleBeforeDecide === true, // (c)
  idleDelivery: (s) => s.idleDelivery === true, // (c)
  crossProcess: (s) => s.crossProcess === true, // (c)
  firstDecideApplied: (s) => s.firstDecideApplied === true, // (c) B's /decide <id>A reports the real success category (반영: #<id> A)
  wakeWithoutInputToA: (s) => s.wakeWithoutInputToA === true, // (c) A got no prompt/steer/follow_up between B's /decide and the delivery
  repeatNoNewDelivery: (s) => s.repeatNoNewDelivery === true, // (c)
  repeatAnswerRejected: (s) => s.repeatAnswerRejected === true, // (c) repeat is the already-answered rejection naming the decision, with no new answer/delivery/session entry
  runBusyWhenAnswered: (s) => s.runBusyWhenAnswered === true, // (d)
  directAnswerApplied: (s) => s.directAnswerApplied === true, // (d) the direct store-API answer to the second decision was really applied
  deliveriesBeforeSettledZero: (s) => s.deliveriesBeforeSettled === 0, // (d)
  afterTurnDelivered: (s) => s.afterTurnDelivered === true, // (d)
  afterTurnEntryOnce: (s) => s.afterTurnEntryOnce === true, // (d) exactly one persisted d<id2> custom_message in A's session file
  unknownDecideRejected: (s) => s.unknownDecideRejected === true, // (e)
  childGateRpc: (s) => s.childGate === 'rpc', // (f)
};

/** Test hook: RPC_RUN_FORCE_FALSE=flag[,flag] forces those flags false to prove the exit code follows every flag. */
function scriptedVerdict(summary) {
  const forced = (process.env.RPC_RUN_FORCE_FALSE ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const f of forced) if (!(f in REQUIRED_FLAGS)) throw new Error(`RPC_RUN_FORCE_FALSE names unknown flag ${f}`);
  const flags = {};
  for (const [name, test] of Object.entries(REQUIRED_FLAGS)) flags[name] = forced.includes(name) ? false : Boolean(test(summary));
  return { flags, failed: Object.keys(flags).filter((n) => !flags[n]) };
}

async function phaseScripted() {
  const summary = {};
  const notes = [];
  const common = ['-e', `${HERE}/scripted-provider.mjs`, '--model', 'scripted/scripted-1'];
  const A = new Host('A', { sessionDir: `${WORK}/sessions-A`, cwd: `${WORK}/proj-A`, extraArgs: common }).start();
  let B = null;
  let C = null;
  try {
    // ---- (a) tool + commands visible, no model call
    const readyA = await readyHost(A, 'A');
    summary.model = readyA.state.model && `${readyA.state.model.provider}/${readyA.state.model.id}`;
    const commandsOk = readyA.commandNames.includes('brief') && readyA.commandNames.includes('decide');
    const sidA = readyA.state.sessionId;
    const sessionFileA = readyA.state.sessionFile;
    const metaPathA = `${STATE}/sessions/${sidA}/meta.json`;
    summary.commandsListed = commandsOk;

    // ---- (b) prompt 1: scripted brief call with two decisions
    const m1 = A.mark();
    const brief = briefJson('통합 시험 A');
    const p1 = await A.send({ type: 'prompt', message: `다음 JSON으로 brief 도구를 한 번만 호출하고 끝이라고만 답해: BRIEFJSON:${JSON.stringify(brief)}` });
    if (!p1.success) throw new Error(`prompt 1 rejected: ${JSON.stringify(p1)}`);
    await A.waitEvent(isSettled, { from: m1, timeoutMs: 60000, what: 'A agent_settled (prompt 1)' });
    const calls = fs.existsSync(SCRIPT_LOG) ? fs.readFileSync(SCRIPT_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    summary.toolListed = commandsOk && calls.length > 0 && calls[0].tools.includes('brief');
    summary.toolsSeenByScriptedModel = calls.length ? calls[0].tools : [];
    const briefs = listDir(`${STATE}/sessions/${sidA}/briefs`);
    const decisions = listDir(`${STATE}/decisions`).filter((f) => f.endsWith('.json'));
    summary.briefStored = briefs.includes('000001.json');
    summary.decisionsCreated = decisions.length;
    summary.indexHtmlExists = fs.existsSync(PAGE);
    const metaA1 = readJson(metaPathA);
    summary.scriptedReply = replyMetrics(sessionFileA, metaA1);
    delete summary.scriptedReply.finalText;
    summary.scriptedCalls = calls.map((c) => ({ lastRole: c.lastRole, plan: c.plan, lastText: c.lastText.slice(0, 40) }));
    fs.writeFileSync(`${OUT}/task-14-tree-after-prompt1.txt`, stateTree('after prompt 1 (scripted brief with 2 decisions)'));
    const decisionIds = decisions.map((f) => Number(f.replace('.json', ''))).sort((x, y) => x - y);
    if (decisionIds.length !== 2) throw new Error(`prompt 1 should create 2 decisions, found ${decisionIds.length}; see ${OUT}/task-14-tree-after-prompt1.txt`);
    const [id1, id2] = decisionIds;

    // ---- (c) two-process wake: B answers, A (idle) must wake by itself
    B = new Host('B', { sessionDir: `${WORK}/sessions-B`, cwd: `${WORK}/proj-B`, extraArgs: common }).start();
    const readyB = await readyHost(B, 'B');
    if (!readyB.commandNames.includes('decide')) throw new Error('B has no /decide command');
    const stA = await A.send({ type: 'get_state' });
    summary.aIdleBeforeDecide = stA.data.isStreaming === false;
    const answersBefore = listDir(`${STATE}/answers`);
    const mA = A.mark();
    const mB = B.mark();
    const t0 = Date.now();
    const d1 = await B.send({ type: 'prompt', message: `/decide ${id1}A` });
    const startedEv = await A.waitEvent(isStart, { from: mA, timeoutMs: 20000, what: 'A agent_start after B /decide (no input to A)' });
    const deliveredEv = await A.waitEvent(isDelivery(`d${id1}`), { from: mA, timeoutMs: 20000, what: `A message_end session_control_delivery d${id1}` });
    summary.idleWakeMs = Date.now() - t0;
    summary.idleWakeOrder = { startIndex: startedEv.index, deliveryIndex: deliveredEv.index };
    summary.wakeWithoutInputToA = !A.history.slice(mA, deliveredEv.index + 1).some((e) => e.type === 'response' && ['prompt', 'steer', 'follow_up'].includes(e.command));
    const deliveryText = textOf(deliveredEv.ev.message.content);
    await A.send({ type: 'abort' });
    const receiptFile = `${STATE}/receipts/${pad6(id1)}.json`;
    const receipt = await waitUntil(() => readJson(receiptFile), { watch: [`${STATE}/receipts`], subscribe: (t) => { A.listeners.add(t); return () => A.listeners.delete(t); }, timeoutMs: 20000, what: `receipt ${receiptFile}` });
    const entryOk = await waitUntil(() => {
      const found = sessionEntries(sessionFileA).filter((e) => e.type === 'custom_message' && e.customType === 'session_control_delivery' && e.details && e.details.delivery_id === `d${id1}`);
      return found.length ? found : null; // an empty array is truthy: wait for the persisted entry instead of accepting none
    }, { watch: [`${WORK}/sessions-A`], subscribe: (t) => { A.listeners.add(t); return () => A.listeners.delete(t); }, timeoutMs: 20000, what: 'A session file custom_message d' + id1 });
    summary.idleDelivery = Boolean(startedEv && deliveredEv && receipt.proven === true && entryOk.length === 1 && /\[결정 전달\] #\d+ -> A/.test(deliveryText));
    summary.crossProcess = summary.idleDelivery && B.history.some((e) => e.type === 'response' && e.command === 'prompt' && e.success) && d1.success;
    summary.idleReceipt = receipt;
    summary.idleDeliveryText = deliveryText;
    await B.waitEvent((e) => e.type === 'extension_ui_request' && e.method === 'notify', { from: mB, timeoutMs: 20000, what: 'B notify for first /decide' });
    summary.bDecideNotify = notifies(B.eventsFrom(mB));
    summary.firstDecideApplied = summary.bDecideNotify.some((m) => m.includes(`반영: #${id1} A`) && !m.includes('적용 안 함'));
    const answersAfterFirst = listDir(`${STATE}/answers`);
    // same /decide again -> already answered, nothing more is delivered
    const mA2 = A.mark();
    const mB2 = B.mark();
    await B.send({ type: 'prompt', message: `/decide ${id1}A` });
    await B.waitEvent((e) => e.type === 'extension_ui_request' && e.method === 'notify', { from: mB2, timeoutMs: 20000, what: 'B notify for repeated /decide' });
    await A.send({ type: 'get_state' }); // round trip: anything A had queued from the repeat would have surfaced by now
    summary.repeatDecideNotify = notifies(B.eventsFrom(mB2));
    summary.repeatNoNewDelivery = !A.eventsFrom(mA2).some((e) => isStart(e) || (e.type === 'message_end' && e.message && e.message.customType === 'session_control_delivery'))
      && listDir(`${STATE}/answers`).join() === answersAfterFirst.join()
      && sessionEntries(sessionFileA).filter((e) => e.type === 'custom_message' && e.customType === 'session_control_delivery').length === 1;
    // required: the real already-answered rejection ('적용 안 함' ... '#<id> 이미 답함'), never a success text, and nothing new was written/delivered
    summary.repeatAnswerRejected = summary.repeatNoNewDelivery === true
      && summary.repeatDecideNotify.length > 0
      && summary.repeatDecideNotify.every((m) => m.includes('적용 안 함') && m.includes(`#${id1} 이미 답함`) && !m.includes('반영'));
    summary.answersBefore = answersBefore;
    summary.answersAfterFirst = answersAfterFirst;

    // ---- (d) answer lands while A is working -> delivered only after agent_settled (mode after-turn)
    const { openStore } = await import(pathToFileURL(`${REPO}/dist/src/store.mjs`).href);
    const { applyDecide } = await import(pathToFileURL(`${REPO}/dist/src/decide.mjs`).href);
    const store = openStore(STATE);
    fs.rmSync(HOLD_FILE, { force: true });
    const mA3 = A.mark();
    const p3 = await A.send({ type: 'prompt', message: 'COUNT3 1부터 3까지 한 줄씩 세고 끝' });
    if (!p3.success) throw new Error(`prompt 3 rejected: ${JSON.stringify(p3)}`);
    await A.waitEvent((e) => e.type === 'message_update' || (e.type === 'message_start' && e.message && e.message.role === 'assistant'), { from: mA3, timeoutMs: 30000, what: 'A run 3 streaming started' });
    const stRun = await A.send({ type: 'get_state' });
    summary.runBusyWhenAnswered = stRun.data.isStreaming === true;
    const apply = applyDecide(store, `${id2}B`, 'rpc-harness-direct', Date.now());
    summary.directAnswer = { applied: apply.applied, errors: apply.errors };
    summary.directAnswerApplied = Array.isArray(apply.applied) && apply.applied.length === 1 && apply.applied[0].id === id2 && apply.applied[0].option === 'B' && (apply.errors ?? []).length === 0;
    fs.writeFileSync(HOLD_FILE, 'release\n'); // the answer is on disk: now let the scripted run finish
    const settled3 = await A.waitEvent(isSettled, { from: mA3, timeoutMs: 60000, what: 'A agent_settled (run 3)' });
    const deliveredDuring = A.history.slice(mA3, settled3.index + 1).filter(isDelivery(`d${id2}`).bind(null)).length;
    const during = A.history.slice(mA3, settled3.index + 1).filter((e) => e.type === 'message_end' && e.message && e.message.customType === 'session_control_delivery').length;
    const start2 = await A.waitEvent(isStart, { from: settled3.index + 1, timeoutMs: 30000, what: 'A new agent_start after run 3 settled' });
    const deliv2 = await A.waitEvent(isDelivery(`d${id2}`), { from: settled3.index + 1, timeoutMs: 30000, what: `A delivery d${id2} after settle` });
    await A.send({ type: 'abort' });
    const receipt2 = await waitUntil(() => readJson(`${STATE}/receipts/${pad6(id2)}.json`), { watch: [`${STATE}/receipts`], subscribe: (t) => { A.listeners.add(t); return () => A.listeners.delete(t); }, timeoutMs: 20000, what: 'receipt 2' });
    summary.deliveriesBeforeSettled = during;
    summary.afterTurnDelivered = during === 0 && deliveredDuring === 0 && start2.index > settled3.index && deliv2.index > start2.index && receipt2.mode === 'after-turn' && receipt2.proven === true;
    summary.afterTurnReceipt = receipt2;
    summary.afterTurnEntryOnce = sessionEntries(sessionFileA).filter((e) => e.type === 'custom_message' && e.customType === 'session_control_delivery' && e.details && e.details.delivery_id === `d${id2}`).length === 1;

    // ---- (e) unknown number rejected, answers untouched
    const answersE0 = listDir(`${STATE}/answers`).map((f) => `${f}:${fs.readFileSync(`${STATE}/answers/${f}`, 'utf8')}`);
    const mBe = B.mark();
    await B.send({ type: 'prompt', message: '/decide 99A' });
    await B.waitEvent((e) => e.type === 'extension_ui_request' && e.method === 'notify', { from: mBe, timeoutMs: 20000, what: 'B notify for /decide 99A' });
    const answersE1 = listDir(`${STATE}/answers`).map((f) => `${f}:${fs.readFileSync(`${STATE}/answers/${f}`, 'utf8')}`);
    summary.decide99Notify = notifies(B.eventsFrom(mBe));
    summary.answersFolderBeforeE = answersE0;
    summary.answersFolderAfterE = answersE1;
    summary.unknownDecideRejected = answersE0.join('|') === answersE1.join('|') && summary.decide99Notify.some((m) => m.includes('적용 안 함') && m.includes('99'));

    // ---- (f) child gate through the real host: session dir under senpi-task/children
    const childDir = `${WORK}/proj-C/.omo/senpi-task/children/st_rpc14c/sessions`;
    C = new Host('C', { sessionDir: childDir, cwd: `${WORK}/proj-C`, extraArgs: common }).start();
    const stC = await C.send({ type: 'get_state' }, 60000);
    const cmdsC = await C.send({ type: 'get_commands' });
    const namesC = (cmdsC.data.commands || []).map((c) => c.name);
    const sidC = stC.data.sessionId;
    summary.childSessionFile = stC.data.sessionFile;
    summary.childGate = /[/\\]senpi-task[/\\]children[/\\]/.test(String(stC.data.sessionFile)) && !namesC.includes('brief') && !namesC.includes('decide')
      && !fs.existsSync(`${STATE}/sessions/${sidC}`) ? 'rpc' : 'unit-only';
    summary.childCommandNames = namesC;

    fs.writeFileSync(`${OUT}/task-14-state-tree.txt`, stateTree('final scripted state'));
    fs.copyFileSync(`${STATE}/index.html`, `${OUT}/task-14-page-index.html`);
    fs.copyFileSync(`${STATE}/data.js`, `${OUT}/task-14-page-data.js`);
    fs.copyFileSync(SCRIPT_LOG, `${OUT}/task-14-scripted-calls.jsonl`);
    const verdict = scriptedVerdict(summary);
    summary.requiredFlags = verdict.flags;
    summary.failedFlags = verdict.failed;
    summary.scriptedPhaseOk = verdict.failed.length === 0;
    if (!summary.scriptedPhaseOk) throw new Error(`scripted phase required flag(s) false or missing: ${verdict.failed.join(', ')}`);
  } finally {
    mergeSummary({ ...summary, notes });
    for (const h of [C, B, A]) if (h) await h.stop();
  }
}

async function phaseReal() {
  if (!args.realModel) throw new Error('--real-model <provider/id> is required for the real phase');
  const keyEnv = args.realKeyEnv ? { [args.realKeyEnv]: process.env[args.realKeyEnv] } : {};
  const logFile = `${OUT}/task-14-real-prompts.log`;
  const log = (s) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`);
  const R = new Host('R', { sessionDir: `${WORK}/sessions-R`, cwd: `${WORK}/proj-R`, extraArgs: ['--model', args.realModel], env: keyEnv }).start();
  const results = [];
  try {
    const ready = await readyHost(R, 'R');
    if (!ready.commandNames.includes('brief')) throw new Error('R has no brief command');
    const sid = ready.state.sessionId;
    const sessionFile = ready.state.sessionFile;
    const prior = readSummary();
    // --attempt-base N: prompts of earlier attempts (kept in the numbering and in summary.prompts)
    const base = Number(args.attemptBase ?? 0);
    const attemptTag = args.attempt ? `A${args.attempt} ` : '';
    // one cumulative allowance across ALL attempts: prompts already recorded in the summary always count
    let used = Math.max(base, prior.prompts ?? 0);
    const questions = ['1+1은 얼마인지', '한국의 수도가 어디인지', '물이 끓는 섭씨 온도가 몇 도인지'];
    const want = Number(args.count ?? 3);
    for (let n = 0; n < want; n++) {
      if (used >= 4) throw new Error(`real prompt budget (4, cumulative over all attempts) exhausted: ${used} already submitted`);
      const message = `간단한 질문 1개에 답하고 brief를 호출해. 질문: ${questions[n % questions.length]}`;
      used++;
      log(`${attemptTag}REAL PROMPT #${used} model=${args.realModel} message=${JSON.stringify(message)}`);
      mergeSummary({ prompts: used });
      const m = R.mark();
      const r = await R.send({ type: 'prompt', message });
      log(`  response success=${r.success} ${r.success ? '' : JSON.stringify(r)}`);
      if (!r.success) { results.push({ n: used, error: r }); break; }
      await R.waitEvent(isSettled, { from: m, timeoutMs: 240000, what: `R settled (real prompt ${used})` });
      const meta = readJson(`${STATE}/sessions/${sid}/meta.json`);
      const evs = R.eventsFrom(m);
      const toolCalls = evs.filter((e) => e.type === 'tool_execution_start').map((e) => e.toolName);
      const metrics = replyMetrics(sessionFile, meta);
      log(`  tools=${toolCalls.join(',')} lines=${metrics.lines} chars=${metrics.chars} hasPath=${metrics.hasPath} pass=${metrics.pass} how=${metrics.how} rewriteRequested=${metrics.rewriteRequested}`);
      log(`  final reply: ${JSON.stringify(metrics.finalText)}`);
      results.push({ n: used, toolCalls, ...metrics });
    }
    const last3 = results.slice(-3);
    const priorReal = readSummary();
    if (base && priorReal.attempt1Real === undefined) {
      mergeSummary({ attempt1Real: { realModel: priorReal.realModel, lastReplyLines: priorReal.lastReplyLines, replyPath: priorReal.replyPath, replyBudgetPass: priorReal.replyBudgetPass, replyBudgetStatus: priorReal.replyBudgetStatus, promptsNote: priorReal.promptsNote } });
    }
    mergeSummary({
      prompts: used,
      lastReplyLines: last3.map((x) => x.lines),
      lastReplyChars: last3.map((x) => x.chars),
      replyPath: last3.map((x) => x.how),
      replyHasPath: last3.map((x) => x.hasPath),
      realToolCalls: last3.map((x) => x.toolCalls),
      replyBudgetPass: last3.length === 3 && last3.every((x) => x.pass),
      realModel: args.realModel,
    });
    const repliesFile = `${OUT}/task-14-real-replies.json`;
    const earlier = base ? (readJson(repliesFile) ?? []) : [];
    fs.writeFileSync(repliesFile, JSON.stringify([...earlier, ...results.map((x) => (args.attempt ? { attempt: Number(args.attempt), ...x } : x))], null, 2));
  } finally { await R.stop(); }
}

try {
  if (args.scenario === 'plan-view' || args.scenario === 'board-answer') {
    const scenarioCtx = {
      Host, waitUntil, isoEnv, readyHost, readJson, listDir, walk, sessionEntries, textOf, notifies, isSettled, isStart,
      args, OUT, WORK, AGENT, STATE, HERE, REPO, SCRIPT_LOG, PIDS, EVENTS, slash, pad6,
    };
    if (args.scenario === 'plan-view') await (await import('./plan-view-scenario.mjs')).runPlanView(scenarioCtx);
    else await (await import('./answer-scenario.mjs')).runBoardAnswer(scenarioCtx);
  } else if (args.phase === 'probe') await phaseProbe();
  else if (args.phase === 'scripted') await phaseScripted();
  else if (args.phase === 'real') await phaseReal();
  else throw new Error(`unknown --phase ${args.phase}`);
  console.log(`phase ${args.phase} finished; work=${WORK}`);
} catch (err) {
  console.error(`FAILED: ${err.stack || err}`);
  mergeSummary({ [`${args.phase}Error`]: String(err.message || err) });
  process.exitCode = 1;
} finally {
  if (!args.keep && (args.phase === 'cleanup' || args.scenario === 'plan-view' || args.scenario === 'board-answer')) fs.rmSync(WORK, { recursive: true, force: true });
}
