// Fixture screenshot matrix of the board shell against the approved mockups (plan todo 9). No dependencies: one headless
// Chrome through scripts/cdp.mjs, the file:// page that src/render.mjs pageHtml() writes for test/fixtures/view-model-board.json
// with its committed report images, every state driven through the real page (BriefPage/BriefShell/BriefAnnotate, CDP mouse
// and keyboard input), and the mockups v5/v6/v7 opened read-only at the same sizes.
//
// usage: node scripts/qa-board-matrix.mjs --out <dir> [--inject-overflow] [--inject-csp-violation] [--mockups <dir>]
//   <dir>/shots/build-<w>x<h>-<nn>-<state>.png   every state at 1440x900, 1024x768 and 390x844
//   <dir>/shots/mock-<w>x<h>-<mockup>.png         v5 (default, #inbox, #closed), v6 (#sub=ov|plan|wk|dec, #sub=rep&pins) and
//                                                 v7 (#demo, #demo&pop, #demo&sent, #demo&path, #plan195) at the same sizes
//   <dir>/result.json   per build shot: check id -> {result: 'pass'|'fail', measured values, culprits}; self-tests, the run
//                       summary, the Chrome pids with their state after close, the temp folder, the fixture additions
//   <dir>/contact.html  build next to mockup, per viewport
// States: each rail view (#h each click), sidebar closed, the peek (below 900 px: the overlay), 2 pinned tabs, each sub-tab
// (plus 개요 with its path details and with 보낸 피드백 open), the tray on a text selection, the tray on a box selection, the
// tray list after 3 annotations, the 보고서 tab with a pin.
// Checks (plan todo 9):
//   (a) no sideways scroll: document.documentElement.scrollWidth <= innerWidth, and the same for the shell's own scrollers
//       (#main, the sidebar list): the shell never lets the document scroll, so their sideways scroll is the page's
//   (b) no box with own text where scrollWidth > clientWidth + 1 (a text node counts for the nearest box that is not
//       display:inline/contents), except .tb .tt, sidebar row titles with a title attribute (#side .sh-t[title]) and
//       plan-view.css's own ellipsis rules .plan-summary-line and .plan-link - nothing else
//   (c) #main reaches the right edge and starts at the docked sidebar's right edge (>= 900 px, open), else at the rail's
//   (d) the in-place tray is within 24 px below or above the selection rect and not in the bottom-right corner
//   (e) sidebar header close + tab-bar reopen, tab-bar open, Ctrl+\ and the left-edge peek each show the sidebar
//       (no peek below 900 px: the sidebar is an overlay there)
//   (f) no console error, page exception or failed load since the previous shot, and no 화면 오류 mark
//   (g) 계획 holds the box plan view (.plan-expanded or .plan-collapsed)
//   (h) a rail click changes #side only: #main and #tabs HTML are identical before and after the click
//   (i) no alarm band; tabs precede main while waiting keys/title remain recorded
//   (j) the selected rail destination stays filled, with the sidebar open, closed or overlaying at every viewport
//   (k) blocks page only: the maximal report is drawn in full (the six kinds in order, every table row and cell, bar, key,
//       step, checklist box, compare row and pick; no omission chip, no trimmed model) and the input decision's form is in
//       the state the shot claims (empty; one refusal message per field; confirmed with the maximal values); its target on screen
//   (l) blocks page, the table shot only: no word (a run of non-space characters) of a report-table or comparison cell or
//       comparison card (the page also carries SHORT_CMP, a schema-valid comparison of ten-letter Korean words) is split across
//       line boxes unless it is wider than the widest line its cell can have: a table column can widen up to the table's
//       scroll box, a record's text column below 600 px cannot (Range client rects per word; B-F3-01, visual-qa C5: a
//       Korean particle never ends up on a line of its own)
// Blocks page (todo 12): the same fixture plus test/fixtures/report-blocks-max.mjs, served in server mode by the real board
//   server (src/server.mjs, ports OMO_BRIEFING_PORT_BASE (47400) .. +9, never the live board's 47317-47326) because only a
//   live page draws the input form and the compare's picks. Conversation A gains the report blocks-max (all six kinds at
//   their schema limits; its compare links the open A/B/C decision #97) and the open input decision #101 (four fields at
//   their limits); #98 is closed on that page only (superseded by #101), so check (i) keeps its two waiting alarms. Its
//   data.js text must stay <= MAX_VM_BYTES (the renderer's cap never runs on it). States, each in light and in dark
//   (prefers-color-scheme): every block at the top of #main, the table's last row, then on 결정 the input decision empty,
//   after one invalid value per field (201 characters, off the step grid, no choice made) and confirmed with the maximal
//   valid values (the field grid's top, its end, and the confirm row). Nothing is ever sent: an /answer POST to that
//   server fails the run.
// Self-tests (every viewport): each of (a), (b), (c), (i) and (f) is made to fail on purpose once (a block wider than #main,
//   a clipped headline, a shifted #main, a reintroduced band, a console.error) and must recover, and (k) and (l) once on the
//   blocks page (the table's last row taken out; the first table cell set to word-break: break-all); a check that cannot fail
//   fails the run.
// --inject-overflow: the negative run (never part of the normal one). Before every 개요 shot the first visible text span of a
//   개요 row gets width:120px; white-space:nowrap; overflow:hidden (plus flex:0 0 120px: that span is a flex item whose
//   flex-basis would otherwise override the width). Check (b) must name it; the run exits 1.
// --inject-csp-violation: the CSP negative run (never part of the normal one). The served blocks page's getPage appends one
//   un-nonced <script>; watchCsp, installed before the first navigation, must record it. Every violation is routed to
//   noteError('csp ' + JSON), so the run exits 1 with a csp entry; a negative run that sees no violation also fails, naming csp.
// AX: for every VIEWPORTS entry the served blocks page and the file page each get ax-<viewport>-board|file.json (the raw
//   Accessibility.getFullAXTree answer) and .txt (the readable tree). Unnamed interactive nodes are compared with
//   scripts/qa-ax-allowlist.json: a missing file is written once (first full run); an existing file is never appended to.
//   Allowlisted nodes are listed in result.json under axBaselineFailures (S3 follow-up); any other unnamed node fails.
// Fixture: used as committed plus two additions the checks need (result.json fixture.additions): vm.waiting = the 2 items of
//   its open decisions #97/#98 as src/waiting.mjs computes them (the committed fixture has none, check (i) needs 2), and one
//   finished conversation whose title is 300 characters without a space (it must wrap or carry a title-attribute ellipsis).
//   Every document's clock starts at the fixture's own generatedAt (PAGE_CLOCK, result.json fixture.pageClock).
// Exit 0 only when every check passes, every self-test flips and recovers, every mockup was captured, and Chrome (every pid
// of its profile), its profile and the temp folder are gone.
import '../test/helpers/refuse-live-writes.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { launch, isPidAlive, listProfilePids, watchCsp, axSnapshot, unnamedInteractive } from './cdp.mjs';
import { MAX_VM_BYTES, pageHtml } from '../src/render.mjs';
import { createBoardServer } from '../src/server.mjs';
import { waitingItems } from '../src/waiting.mjs';
import { BLOCK_KINDS, MAX_REPORT_ID, maxReport, maxDecisionFields, maxFieldValues, invalidFieldValues, invalidFieldErrors } from '../test/fixtures/report-blocks-max.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_FILE = path.join(ROOT, 'test/fixtures/view-model-board.json');
const ASSET_DIR = path.join(ROOT, 'test/fixtures/board-assets');
const DEFAULT_MOCKUPS = 'C:/Users/USER/orca/projects/기타 작업/.senpi/html-pages';
const J = JSON.stringify;

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};
const OUT = arg('--out') ? path.resolve(arg('--out')) : '';
const INJECT = argv.includes('--inject-overflow');
const INJECT_CSP = argv.includes('--inject-csp-violation');
const MOCKUP_DIR = path.resolve(arg('--mockups') || process.env.OMO_MOCKUP_DIR || DEFAULT_MOCKUPS);
if (!OUT) {
  console.error('usage: node scripts/qa-board-matrix.mjs --out <dir> [--inject-overflow] [--inject-csp-violation] [--mockups <dir>]');
  process.exit(2);
}
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '390x844', width: 390, height: 844 },
];
const MOCKUPS = [
  { file: 'board-rail-tabs-v5.html', shots: [['v5', ''], ['v5-inbox', '#inbox'], ['v5-closed', '#closed']] },
  { file: 'board-structure-v6.html', shots: [['v6-sub-ov', '#sub=ov'], ['v6-sub-plan', '#sub=plan'], ['v6-sub-wk', '#sub=wk'], ['v6-sub-dec', '#sub=dec'], ['v6-sub-rep-pins', '#sub=rep&pins']] },
  { file: 'board-annotate-v7.html', shots: [['v7-demo', '#demo'], ['v7-demo-pop', '#demo&pop'], ['v7-demo-sent', '#demo&sent'], ['v7-demo-path', '#demo&path'], ['v7-plan195', '#plan195']] },
];
// check (b): the only boxes that may clip their text (follow-up plan row 9: nothing else)
const ALLOW = [
  { name: '.tb .tt (tab title; the tab carries the full title)', sel: '.tb .tt' },
  { name: '#side .sh-t[title] (sidebar row title with a title attribute)', sel: '#side .sh-t[title]' },
  { name: '.plan-summary-line (plan-view.css, unchanged by plan rule)', sel: '.plan-summary-line' },
  { name: '.plan-link (plan-view.css, unchanged by plan rule)', sel: '.plan-link' },
];
// build state -> the mockup shots it is compared with on the contact sheet
const PAIRS = {
  'rail-inbox': ['v5-inbox'], 'rail-plans': ['v5'], 'rail-home': ['v5'], 'rail-archive': ['v5'], 'rail-settings': ['v5'], 'rail-conv': ['v5'],
  'side-closed': ['v5-closed'], 'side-peek': ['v5-closed'], 'tabs-pinned': ['v5'],
  'sub-ov': ['v6-sub-ov'], 'sub-plan': ['v6-sub-plan', 'v7-plan195'], 'sub-wk': ['v6-sub-wk'], 'sub-dec': ['v6-sub-dec'], 'sub-rep': ['v6-sub-rep-pins'],
  'ov-paths': ['v7-demo-path'], 'ov-notes': ['v7-demo-sent'], 'tray-text': ['v7-demo-pop'], 'tray-box': ['v7-demo-pop'], 'tray-list': ['v7-demo'],
  'rep-pin': ['v6-sub-rep-pins'],
};
const INJECT_CSS = 'width:120px;white-space:nowrap;overflow:hidden;flex:0 0 120px';
// the blocks page (todo 12)
const SCHEMES = ['light', 'dark'];
const BLK_STATES = [...BLOCK_KINDS, 'table-end', 'input', 'input-invalid', 'input-invalid-end', 'input-confirm'];
const BLK_DECISION = 101; // the next id after the committed fixture's #100
const BLK_LINKED = 97; // the open A/B/C decision the compare links
const BLK_SUPERSEDED = 98; // closed on the blocks page only
const BLK_TOKEN = 'qa-board-matrix-blocks';
const LIVE_BOARD = [47317, 47326];
const PORT_BASE = Number(process.env.OMO_BRIEFING_PORT_BASE || 47400);
if (!Number.isInteger(PORT_BASE) || PORT_BASE < 1024 || PORT_BASE + 9 > 65535 || (PORT_BASE <= LIVE_BOARD[1] && PORT_BASE + 9 >= LIVE_BOARD[0])) {
  console.error(`OMO_BRIEFING_PORT_BASE=${process.env.OMO_BRIEFING_PORT_BASE}: needs 10 ports in 1024-65535 outside the live board's ${LIVE_BOARD.join('-')}`);
  process.exit(2);
}
// check (l): the gate's B-18-01 comparison (ten-letter Korean words ending in a particle), linked to the open #97
const SHORT_CMP = { id: 'short-korean', title: '검증 비교', summary: '시스템 구성을 비교합니다.', status: '참고', images: [], decisionId: null,
  blocks: [{ kind: 'compare', title: '시스템 구성 비교', decision: 97, rows: [
    { label: '데이터베이스검증표와', A: '보고서자동화시스템과', B: '사용자입력처리기준과', C: '보고서자료검증결과와' },
    { label: '보고서자동화시스템과', A: '데이터베이스검증표와', B: '보고서자료검증결과와', C: '사용자입력처리기준과' }] },
    // B-18B-01: the original long-sentence phone fixture (its card values strand 와/과 if the phone cards go two-column)
    { kind: 'compare', title: '보고서 검증 방식 비교', decision: 97, rows: [
      { label: '자료검증', A: '보고서자료검증결과와 추가 안내', B: '사용자입력처리기준과 추가 안내', C: '표시자료정합성검증과 추가 안내' },
      { label: '연결검증', A: '성능측정결과비교와 추가 안내', B: '변경사항검토기준과 추가 안내', C: '요청자료처리결과와 추가 안내' },
      { label: '결과정리', A: '자료처리완료결과와 추가 안내', B: '보고서자료검증결과와 추가 안내', C: '사용자입력처리기준과 추가 안내' }] }] };
const blkSel = (n) => `#main [data-block="rep/${MAX_REPORT_ID}/blk/${n}"]`;

// ------------------------------------------------------------------ accessibility baseline

const AX_ALLOWLIST = path.join(ROOT, 'scripts/qa-ax-allowlist.json');

function axKeyOf(view, viewport, role, ancestors) {
  return JSON.stringify([view, viewport, role, ...ancestors]);
}

// The named-control rule: view + viewport + role + the nearest three non-empty ancestor names (nearest first).
function axFindings(raw, { view, viewport }) {
  const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
  const byId = new Map(nodes.map((node) => [String(node.nodeId), node]));
  const instances = [];
  for (const node of unnamedInteractive(nodes)) {
    const ancestors = [];
    for (let p = byId.get(String(node.parentId)); p && ancestors.length < 3; p = byId.get(String(p.parentId))) {
      const name = String(p.name?.value ?? '').replace(/\s+/g, ' ').trim();
      if (name) ancestors.push(name);
    }
    const role = String(node.role?.value ?? '');
    instances.push({ key: axKeyOf(view, viewport, role, ancestors), view, viewport, role, ancestors });
  }
  const byKey = new Map();
  for (const e of instances) byKey.set(e.key, (byKey.get(e.key) || 0) + 1);
  return { nodes: nodes.length, instances, byKey };
}

function readAxAllowlist() {
  if (!fs.existsSync(AX_ALLOWLIST)) return { exists: false, doc: null, entries: {}, sha256: null };
  const text = fs.readFileSync(AX_ALLOWLIST, 'utf8');
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== 'object' || !doc.entries || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) {
    throw new Error(`${AX_ALLOWLIST}: expected an object with an "entries" object`);
  }
  return { exists: true, doc, entries: doc.entries, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

// First full run only: write every unnamed interactive node once. Never called when the file exists.
function writeAxAllowlist(captures) {
  const entries = {};
  for (const cap of captures) {
    for (const [key, count] of cap.findings.byKey) {
      const first = cap.findings.instances.find((x) => x.key === key);
      entries[key] = { view: first.view, viewport: first.viewport, role: first.role, ancestors: first.ancestors, count };
    }
  }
  const sorted = Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key]]));
  const doc = {
    version: 1,
    comment: 'Baseline of unnamed interactive accessibility nodes at the start sha. The QA scripts never append to this file; a new unnamed control must fail and be reviewed here.',
    provenance: {
      startSha: process.env.OMO_QA_START_SHA || null,
      capturedAt: new Date().toISOString(),
      method: 'axSnapshot + unnamedInteractive from scripts/cdp.mjs',
      markup: 'src/page/*.js equals the start sha except the fail-closed esc() fallback in page.js',
    },
    entries: sorted,
  };
  const text = JSON.stringify(doc, null, 2) + '\n';
  fs.writeFileSync(AX_ALLOWLIST, text);
  return { doc, entries: sorted, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function compareAx(captures, entries) {
  const baseline = [];
  const unexpected = [];
  for (const cap of captures) {
    const seen = new Map();
    for (const e of cap.findings.instances) {
      const instance = (seen.get(e.key) || 0) + 1;
      seen.set(e.key, instance);
      const allowed = Number(entries[e.key]?.count || 0);
      (instance <= allowed ? baseline : unexpected).push({ ...e, instance, allowed });
    }
  }
  return { baseline, unexpected };
}

// ------------------------------------------------------------------ the fixture the page shows

const fixtureText = fs.readFileSync(FIXTURE_FILE, 'utf8');
const FIXTURE = JSON.parse(fixtureText);
// The page reads the wall clock (page.js state.now and the 1 s worker ticker are Date.now()) while the fixture's times are
// fixed, so unpinned shots drift with the day of the run: from 10 days 10 hours after the running worker's start, its
// 390x844 row clock '10일 10시간' left span.w-name 126 px for 128 px of text (check b), on any commit. Every document of
// the run therefore starts its clock at the fixture's own generatedAt and lets it run on from there; a frozen clock would
// stall page.js's apply throttle (consider() waits for APPLY_MIN_MS to pass).
if (!Number.isFinite(FIXTURE.generatedAt)) throw new Error('test/fixtures/view-model-board.json: generatedAt must be epoch ms');
const PAGE_CLOCK = `(() => { const offset = ${FIXTURE.generatedAt} - Date.now(); const wall = Date.now.bind(Date); Date.now = () => wall() + offset; })();`;
const LONG_ID = '01a14f00-0300-7c00-8d00-000000000300';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LONG_TITLE = Array.from({ length: 300 }, (_, i) => ALNUM[i % ALNUM.length]).join(''); // no space, no break opportunity
// The five hostile fixtures the board must draw as text (todo 2's fixture, served here over http with the CSP header).
const HOSTILE_STRINGS = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/hostile-strings.json'), 'utf8'));
if (!Array.isArray(HOSTILE_STRINGS) || HOSTILE_STRINGS.length !== 5) throw new Error('test/fixtures/hostile-strings.json: expected five strings');
const HOSTILE_SID = 'qa-hostile';
const HOSTILE_REPORT = 'hostile-report';
const HOSTILE_DECISION = 102; // after the committed fixture's #100 and the blocks page's #101
const HOSTILE_INPUT = 103;

function matrixModel() {
  const vm = structuredClone(FIXTURE);
  const C = vm.sessions[2];
  const swap = (v) => String(v).split(C.id).join(LONG_ID);
  const D = structuredClone(C);
  Object.assign(D, {
    id: LONG_ID, title: LONG_TITLE, paneId: 'w9-p300', tabId: '',
    headline: '공백 없는 300자 제목: 줄을 바꾸거나, 제목 칸에서만 title 툴팁과 함께 말줄임',
    lastActivityAt: C.lastActivityAt + 60_000, lastBriefAt: C.lastBriefAt + 60_000,
    briefPath: swap(C.briefPath), sessionFile: swap(C.sessionFile),
    attachments: C.attachments.map((a) => ({ label: a.label, path: swap(a.path) })),
    blockSources: Object.fromEntries(Object.entries(C.blockSources).map(([k, v]) => [k, { paths: v.paths.map(swap) }])),
  });
  vm.sessions.push(D);
  vm.waiting = waitingOf(vm);
  if (vm.waiting.length !== 2) throw new Error(`expected the 2 open decisions in vm.waiting, got ${J(vm.waiting)}`);
  return {
    vm,
    additions: {
      waiting: { why: 'check (i) proves no band while 2 real waiting alarms remain recorded; the committed fixture has waiting: []', items: vm.waiting },
      longTitleSession: { why: 'the plan\'s 300-character title without spaces (check (b) and (a))', id: LONG_ID, clonedFrom: C.id, title: LONG_TITLE, titleLength: [...LONG_TITLE].length },
    },
  };
}

// waiting alarms, computed by the renderer's module (answered/closed ones excluded); no band is rendered
function waitingOf(vm) {
  const decisions = vm.sessions.flatMap((s) => s.decisions.map((d) => ({ ...d, sessionId: d.sessionId || s.id })));
  return waitingItems({
    sessions: vm.sessions.map((s) => ({ sid: s.id, meta: { title: s.title, tabLabel: s.tabLabel, tabNumber: s.tabNumber, paneId: s.paneId }, briefs: [{ data: { brief: { title: s.title } } }] })),
    decisions,
    answers: decisions.filter((d) => d.answered).map((d) => ({ id: d.id })),
    closures: decisions.filter((d) => d.closed).map((d) => ({ id: d.id })),
  });
}

// The blocks page's model: the matrix model with conversation A's report blocks-max (newest of its three reports, as
// render.mjs reportsView keeps three) and the open input decision #101; #98 closed (superseded by #101) on this page only.
function blocksModel(base) {
  const vm = structuredClone(base);
  vm.seq = base.seq + 1;
  const A = vm.sessions[0];
  const linked = A.decisions.find((d) => d.id === BLK_LINKED);
  const superseded = A.decisions.find((d) => d.id === BLK_SUPERSEDED);
  if (!linked || linked.answered || linked.closed || !linked.options.C || !superseded || superseded.answered || superseded.closed
    || vm.sessions.some((s) => s.decisions.some((d) => d.id === BLK_DECISION))) throw new Error('the committed fixture no longer has open #97 (A/B/C) and #98, or already has #101');
  superseded.closed = true;
  const fields = maxDecisionFields();
  A.decisions.push({ id: BLK_DECISION, sessionId: A.id, question: '최대 크기 입력 결정: 네 칸을 모두 한도까지 채워 주세요', options: {}, recommend: '',
    reason: '값을 확인하고 대화에 한 번만 보내요', blocks: false, fields, createdAt: A.lastBriefAt, source: 'brief', answered: false, closed: false,
    questionPrompt: false, answer: null, receipt: null });
  const report = maxReport({ decision: BLK_LINKED });
  A.reports = [{ id: report.id, title: report.title, summary: report.summary, at: A.lastBriefAt, decisionId: null, status: '참고', images: [], blocks: report.blocks },
    { ...SHORT_CMP, at: A.lastBriefAt }, ...A.reports.slice(0, 1)];
  vm.waiting = waitingOf(vm);
  if (vm.waiting.map((w) => w.key).join() !== `d${BLK_LINKED},d${BLK_DECISION}`) throw new Error(`blocks page waiting: ${J(vm.waiting)}`);
  if (vm.sessions.some((s) => s.decisions.some((d) => d.id === HOSTILE_DECISION || d.id === HOSTILE_INPUT))) throw new Error('the committed fixture already uses a hostile decision id');
  // One hostile session: title, report table cell, kv value, decision option and input-field label. Its two open decisions
  // are deliberately not in vm.waiting: they are a DOM fixture, not alarm fixtures, so check (i) keeps exactly #97 and #101.
  const hostileAt = A.lastBriefAt + 1;
  const hostile = structuredClone(A);
  Object.assign(hostile, {
    id: HOSTILE_SID, title: HOSTILE_STRINGS[0], paneId: '', tabId: '', tabLabel: '', tabNumber: 0,
    project: 'qa-hostile', cwd: 'C:/work/qa-hostile', workName: 'hostile', status: 'in_progress', statusKey: 'in_progress', tab: '진행 중', chips: [],
    headline: 'hostile fixture', changesNew: false, changes: [], done: [], next: '', heldCount: 0, notes: [], flow: [],
    lastActivityAt: hostileAt, lastBriefAt: hostileAt, alive: true, briefSeq: 1, briefPath: '', sessionFile: '', todo: null, attachments: [], blockSources: {},
    auto: {}, live: {}, plan: null,
    decisions: [
      { id: HOSTILE_DECISION, sessionId: HOSTILE_SID, question: '호스트 결정', options: { A: { text: HOSTILE_STRINGS[3], consequence: '안전' }, B: { text: '중립', consequence: '중립' } },
        recommend: 'B', reason: '호스트 문자열을 A에 둔다', blocks: false, createdAt: hostileAt, source: 'brief', answered: false, closed: false,
        questionPrompt: false, answer: null, receipt: null },
      { id: HOSTILE_INPUT, sessionId: HOSTILE_SID, question: '호스트 입력', options: {}, recommend: '', reason: '호스트 문자열을 라벨에 둔다', blocks: false,
        fields: [{ id: 'hostile_label', label: HOSTILE_STRINGS[4], kind: 'text', maxLen: 200 }], createdAt: hostileAt, source: 'brief', answered: false, closed: false,
        questionPrompt: false, answer: null, receipt: null },
    ],
    reports: [{ id: HOSTILE_REPORT, title: '호스트 보고서', summary: 'hostile fixture', at: hostileAt, decisionId: null, status: '참고', images: [], blocks: [
      { kind: 'table', title: '호스트 표', columns: ['열'], rows: [[HOSTILE_STRINGS[1]]] },
      { kind: 'kv', title: '호스트 항목', items: [{ key: '값', value: HOSTILE_STRINGS[2] }] },
      { kind: 'compare', title: '호스트 비교', decision: HOSTILE_DECISION, rows: [{ label: '행', A: 'A값', B: 'B값' }] },
    ] }],
  });
  vm.sessions.push(hostile);
  const b = report.blocks;
  const expect = {
    report: { report: report.id, drawn: { kinds: BLOCK_KINDS, tableHead: b[0].columns.length, tableRows: b[0].rows.length, tableCells: b[0].rows.length * b[0].columns.length,
      bars: b[1].items.length, barRects: b[1].items.filter((i) => i.value > 0).length, kv: [b[2].items.length, b[2].items.length],
      steps: b[3].steps.length, flowSvg: 0, checks: b[4].items.length, compareRows: b[5].rows.length, compareOptions: 3, cards: 3,
      recommended: [linked.recommend], picks: 3 } },
    input: { decision: BLK_DECISION, fields: fields.map((f) => ({ id: f.id, ...(f.kind === 'text' ? { tag: 'input:text', controls: 1, attrs: f.maxLen * 2 }
      : f.kind === 'number' ? { tag: 'input:number', controls: 1, attrs: [f.min, f.max, f.step].join('|') }
        : f.options.length > 3 ? { tag: 'select:select-one', controls: 1, attrs: f.options.length + 1 } : { tag: 'input:radio', controls: f.options.length, attrs: null }) })),
    errors: invalidFieldErrors(fields), values: maxFieldValues(fields) },
  };
  return {
    vm, fields, expect,
    additions: { why: 'todo 12: a report with all six block kinds at their schema limits and an input decision at its field limits',
      report: { session: A.id, id: report.id, kinds: b.map((x) => x.kind), compareLinks: BLK_LINKED, drawn: expect.report.drawn },
      inputDecision: { id: BLK_DECISION, fields }, superseded: { id: BLK_SUPERSEDED, closed: true, why: 'check (i) needs exactly 2 waiting alarms: #97 and #101' },
      reportsKept: A.reports.map((r) => r.id), waiting: vm.waiting.map((w) => w.key),
      hostileSession: { why: 'the five hostile strings from test/fixtures/hostile-strings.json, served over http, are drawn as text', id: HOSTILE_SID,
        report: HOSTILE_REPORT, decision: HOSTILE_DECISION, input: HOSTILE_INPUT, strings: HOSTILE_STRINGS, waitingExcluded: true } },
  };
}

// ------------------------------------------------------------------ in-page helpers (installed before every document)

// Runs in the page: its source is injected verbatim (Function.prototype.toString), so it may use nothing from this module.
function pageLib() {
  if (window.__qa) return;
  const qa = (window.__qa = { errors: [], lastSel: null });
  window.addEventListener('error', (e) => qa.errors.push('error: ' + (e && e.message ? e.message : String(e))));
  window.addEventListener('unhandledrejection', (e) => qa.errors.push('rejection: ' + (e && e.reason && e.reason.message ? e.reason.message : String(e && e.reason))));
  // short timers (<= 1 s) in flight: a mockup applies its #hash state from setTimeout callbacks, awaited instead of slept on
  const ST = window.setTimeout.bind(window);
  const CT = window.clearTimeout.bind(window);
  const live = new Set();
  let idle = [];
  const flush = () => { if (!live.size) { const w = idle; idle = []; w.forEach((f) => f(true)); } };
  window.setTimeout = function (fn, ms, ...args) {
    if (typeof fn !== 'function' || (Number(ms) || 0) > 1000) return ST(fn, ms, ...args);
    const id = ST(function () { live.delete(id); try { return fn.apply(this, args); } finally { flush(); } }, ms);
    live.add(id);
    return id;
  };
  window.clearTimeout = function (id) { const had = live.delete(id); CT(id); if (had) flush(); };
  const bound = (p, ms) => Promise.race([p, new Promise((r) => ST(() => r('timeout'), ms))]);
  qa.timersIdle = (ms) => bound(new Promise((resolve) => { if (!live.size) resolve(true); else idle.push(resolve); }), ms || 5000);
  qa.frames = (n) => new Promise((resolve) => { const step = (k) => (k <= 0 ? resolve(true) : requestAnimationFrame(() => step(k - 1))); step(n || 2); });
  // two frames, every finite animation/transition finished (infinite pulses excluded), fonts and images ready, two frames
  qa.settle = async () => {
    await qa.frames(2);
    const finite = document.getAnimations().filter((a) => a.playState === 'running' && a.effect && Number.isFinite(a.effect.getComputedTiming().endTime));
    await bound(Promise.all(finite.map((a) => a.finished.catch(() => null))), 3000);
    if (document.fonts && document.fonts.ready) await bound(document.fonts.ready, 3000);
    const imgs = [...document.images].filter((i) => !i.complete);
    await bound(Promise.all(imgs.map((i) => i.decode().catch(() => null))), 3000);
    await qa.frames(2);
    return true;
  };
  // capture phase on the document: this runs before annotate.js's own mouseup listener opens the tray and moves the focus
  document.addEventListener('mouseup', () => {
    const s = getSelection();
    qa.lastSel = s && s.rangeCount && !s.isCollapsed ? { text: String(s), rect: box(s.getRangeAt(0).getBoundingClientRect()) } : null;
  }, true);

  const TRANSIENT = new Set(['ab', 'bann', 'bsel', 'flash', 'is-new']);
  function box(r) { return { left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10, right: Math.round(r.right * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 }; }
  function simple(el) {
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].filter((c) => !TRANSIENT.has(c)).map((c) => '.' + c).join('');
  }
  function cssPath(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e.id) { parts.unshift(e.tagName.toLowerCase() + '#' + e.id); break; }
      let s = e.tagName.toLowerCase() + [...e.classList].filter((c) => !TRANSIENT.has(c)).slice(0, 3).map((c) => '.' + c).join('');
      const p = e.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === e.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  }
  function snippet(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90); }
  function visible(el) {
    return typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : !!el.getClientRects().length;
  }
  qa.box = box;
  qa.cssPath = cssPath;
  qa.rect = (sel) => { const el = document.querySelector(sel); return el ? box(el.getBoundingClientRect()) : null; };

  // (a) innermost descendants of `root` whose box reaches past `edge`, looked for only through ancestors that do not clip
  function overhang(root, edge) {
    const out = [];
    const walk = (el) => {
      for (const k of el.children) {
        if (out.length >= 8) return;
        const cs = getComputedStyle(k);
        if (cs.display === 'none') continue;
        const before = out.length;
        if (cs.overflowX === 'visible') walk(k);
        const r = k.getBoundingClientRect();
        if (out.length === before && r.width > 0 && r.right > edge + 1) out.push({ selector: cssPath(k), simple: simple(k), right: Math.round(r.right), edge: Math.round(edge), whiteSpace: cs.whiteSpace, text: snippet(k) });
      }
    };
    walk(root);
    return out;
  }
  qa.checkA = () => {
    const de = document.documentElement;
    const doc = { scrollWidth: de.scrollWidth, innerWidth, pass: de.scrollWidth <= innerWidth };
    const regions = [];
    for (const [name, sel] of [['#main', '#main'], ['sidebar list', '#side .sh-scroll']]) {
      const el = document.querySelector(sel);
      if (!el || !visible(el)) { regions.push({ name, skipped: 'not shown' }); continue; }
      const r = el.getBoundingClientRect();
      const pass = el.scrollWidth <= el.clientWidth + 1;
      regions.push({ name, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, pass, culprits: pass ? [] : overhang(el, r.left + el.clientLeft + el.clientWidth) });
    }
    const pass = doc.pass && regions.every((x) => x.skipped || x.pass);
    return { result: pass ? 'pass' : 'fail', pass, document: doc, regions, culprits: doc.pass ? [] : overhang(document.body, innerWidth) };
  };
  // (b)
  qa.checkB = (allow) => {
    const boxes = new Set();
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (!/\S/.test(n.data)) continue;
      let el = n.parentElement;
      if (!el || el.closest('script,style,noscript,template')) continue;
      while (el && el !== document.body && /^(inline|contents)$/.test(getComputedStyle(el).display)) el = el.parentElement;
      if (el && el !== document.body) boxes.add(el);
    }
    const failures = [];
    const allowlisted = [];
    let measured = 0;
    for (const el of boxes) {
      if (!visible(el)) continue;
      measured++;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const cs = getComputedStyle(el);
      const entry = { selector: cssPath(el), simple: simple(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, title: el.getAttribute('title'),
        whiteSpace: cs.whiteSpace, overflowX: cs.overflowX, textOverflow: cs.textOverflow, text: snippet(el) };
      const rule = allow.find((a) => el.matches(a.sel));
      if (rule) allowlisted.push({ ...entry, allowedBy: rule.name }); else failures.push(entry);
    }
    return { result: failures.length ? 'fail' : 'pass', pass: !failures.length, measured, failures, allowlisted };
  };
  // (c)
  qa.checkC = () => {
    const main = document.getElementById('main').getBoundingClientRect();
    const rail = document.getElementById('rail').getBoundingClientRect();
    const side = document.getElementById('side').getBoundingClientRect();
    const shell = document.querySelector('[data-shell]');
    const narrow = matchMedia('(max-width: 899px)').matches;
    const peek = shell.getAttribute('data-peek') === 'true';
    const docked = !narrow && shell.getAttribute('data-side') === 'open';
    const mode = docked ? 'docked open' : narrow ? (peek ? 'overlay (< 900 px) shown' : 'overlay (< 900 px) hidden') : peek ? 'closed, peeking' : 'closed';
    const expectLeft = docked ? side.right : rail.right;
    const pass = Math.abs(main.right - innerWidth) <= 1 && Math.abs(main.left - expectLeft) <= 1;
    return { result: pass ? 'pass' : 'fail', pass, mode, mainLeft: main.left, mainRight: main.right, innerWidth, expectLeft, railRight: rail.right, sideRight: side.right };
  };
  // (d)
  qa.checkD = (sel, probe = true) => {
    const pop = document.querySelector('.pop');
    if (!pop || !sel) return { result: 'fail', pass: false, error: !pop ? 'no tray open' : 'no selection rect' };
    const r = pop.getBoundingClientRect();
    const gapBelow = Math.round((r.top - sel.bottom) * 10) / 10;
    const gapAbove = Math.round((sel.top - r.bottom) * 10) / 10;
    const near = Math.abs(gapBelow) <= 24 || Math.abs(gapAbove) <= 24;
    const corner = innerWidth - r.right <= 24 && innerHeight - r.bottom <= 24;
    if (matchMedia('(max-width: 599px)').matches) {
      const position = getComputedStyle(pop).position;
      const pass = position === 'fixed' && Math.abs(r.left) <= 1 && Math.abs(r.right - innerWidth) <= 1 &&
        Math.abs(r.bottom - innerHeight) <= 1 && r.top >= 0 && r.height > 0;
      const measured = { result: pass ? 'pass' : 'fail', pass, compactSheet: true, tray: box(r), selection: sel, position };
      if (!probe) return measured;
      const old = pop.getAttribute('style');
      let broken;
      try {
        pop.style.cssText += ';top:0!important;bottom:auto!important';
        broken = qa.checkD(sel, false);
      } finally {
        if (old === null) pop.removeAttribute('style'); else pop.setAttribute('style', old);
      }
      const recovered = qa.checkD(sel, false);
      const flipped = pass && broken.pass === false && recovered.pass;
      return { ...recovered, result: flipped ? 'pass' : 'fail', pass: flipped,
        positionProbe: { flipped, before: measured, broken, after: recovered } };
    }
    const pass = near && !corner;
    return { result: pass ? 'pass' : 'fail', pass, tray: box(r), selection: sel, gapBelow, gapAbove, bottomRightCorner: corner, position: getComputedStyle(pop).position };
  };
  // (e)
  qa.sideState = () => {
    const shell = document.querySelector('[data-shell]');
    const side = document.getElementById('side');
    const r = side.getBoundingClientRect();
    const rail = document.getElementById('rail').getBoundingClientRect();
    const head = side.querySelector('.sh-head').getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(head.left + head.width / 2), Math.round(head.top + head.height / 2));
    const vis = getComputedStyle(side).visibility;
    const shown = vis === 'visible' && r.width >= 150 && Math.abs(r.left - rail.right) <= 1 && r.right <= innerWidth + 1 && !!hit && side.contains(hit);
    return { shown, visibility: vis, rect: box(r), railRight: rail.right, headerHit: hit ? simple(hit) : null, side: shell.getAttribute('data-side'), peek: shell.getAttribute('data-peek') === 'true' };
  };
  // (g)
  qa.checkG = () => {
    const panel = document.querySelector('#main .cv-panel[data-sub="plan"]');
    const view = panel ? panel.querySelector('.plan-expanded, .plan-collapsed') : null;
    return { result: view ? 'pass' : 'fail', pass: !!view, panel: !!panel, view: view ? simple(view) : null, inPlanHost: !!(view && view.closest('.plan-host')), anchors: panel ? panel.querySelectorAll('[data-anchor]').length : 0 };
  };
  // (h) the click runs synchronously here, so nothing else (the 1 s worker ticker) can change #main in between
  qa.railClick = (key) => {
    const btn = document.querySelector('#rail [data-sh="view"][data-key="' + key + '"]');
    const main = document.getElementById('main');
    const tabs = document.getElementById('tabs');
    const side = document.getElementById('side');
    const shell = document.querySelector('[data-shell]');
    const m0 = main.innerHTML, t0 = tabs.innerHTML, s0 = side.innerHTML;
    const nodes0 = main.querySelectorAll('*').length;
    const first0 = main.firstElementChild;
    btn.click();
    const m1 = main.innerHTML, t1 = tabs.innerHTML, s1 = side.innerHTML;
    const view = shell.getAttribute('data-view');
    const pass = m0 === m1 && t0 === t1 && s0 !== s1 && view === key;
    // where #main differs first, and whether its nodes were replaced (a re-render) or only edited
    const diff = (a, b) => {
      if (a === b) return null;
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return { at: i, before: a.slice(Math.max(0, i - 80), i + 80), after: b.slice(Math.max(0, i - 80), i + 80) };
    };
    return { result: pass ? 'pass' : 'fail', pass, key, view, mainUnchanged: m0 === m1, tabsUnchanged: t0 === t1, sideChanged: s0 !== s1,
      mainReplaced: main.firstElementChild !== first0, mainNodes: [nodes0, main.querySelectorAll('*').length], mainDiff: diff(m0, m1), tabsDiff: diff(t0, t1) };
  };
  // (i)
  qa.checkI = () => {
    const bandPresent = !!document.querySelector('#alarm-band,.alarm-band,.alarm-row');
    const tabs = document.getElementById('tabs'), main = document.getElementById('main');
    const adjacent = !!tabs && !!main && tabs.nextElementSibling === main;
    const gap = tabs && main ? main.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom : null;
    const waiting = BriefPage.state.model.waiting || [];
    const seen = JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}');
    const recorded = waiting.every(w => Number.isFinite(seen[w.key]));
    const counted = !waiting.length || document.title.startsWith('(' + waiting.length + ') ');
    const pass = !bandPresent && adjacent && Math.abs(gap) <= 1 && waiting.length === 2 && recorded && counted;
    return { result: pass ? 'pass' : 'fail', pass, bandPresent, adjacent, gap, waitingKeys: waiting.map(w => w.key), recorded, title: document.title, counted };
  };
  qa.checkJ = () => {
    const selected = [...document.querySelectorAll('#rail .sh-rb.on')].map(el => {
      const background = getComputedStyle(el).backgroundColor;
      const alpha = background === 'transparent' ? 0 : background.startsWith('rgba(') ? Number(background.slice(5, -1).split(',')[3]) : 1;
      return { key: el.getAttribute('data-key'), background, alpha };
    });
    const pass = selected.length === 1 && selected[0].alpha > 0;
    return { result: pass ? 'pass' : 'fail', pass, selected };
  };
  // (k) the blocks page: x = {part: 'report', report, drawn, target} | {part: 'input', state, decision, fields, errors, values, target}
  qa.checkK = (x) => {
    const main = document.getElementById('main');
    const mr = main.getBoundingClientRect();
    const problems = [];
    const t = main.querySelector(x.target);
    const tr = t ? t.getBoundingClientRect() : null;
    if (!tr || !(tr.height > 0 && tr.bottom > mr.top + 1 && tr.top < mr.bottom - 1)) problems.push('target not on screen: ' + x.target);
    const omitted = ['표·그래프 생략', '용량 때문에 일부 생략'].filter((s) => main.textContent.includes(s));
    const trimmed = BriefPage.state.model.trimmed;
    if (omitted.length || trimmed !== undefined) problems.push('trimmed: ' + JSON.stringify({ omitted, trimmed }));
    let drawn;
    if (x.part === 'report') {
      const rep = main.querySelector('[data-block="rep/' + x.report + '"]');
      const figs = rep ? [...rep.querySelectorAll('figure.rbk')] : [];
      const n = (i, s) => (figs[i] ? figs[i].querySelectorAll(s).length : -1);
      drawn = {
        kinds: figs.map((f) => ([...f.classList].find((c) => /^rbk-(table|bars|kv|flow|checklist|compare)$/.test(c)) || '').slice(4)),
        tableHead: n(0, 'thead th'), tableRows: n(0, 'tbody tr'), tableCells: n(0, 'tbody td'), bars: n(1, 'li.bar-r'), barRects: n(1, 'rect.bar-v'),
        kv: [n(2, 'dl.rbk-kvl > dt'), n(2, 'dl.rbk-kvl > dd')], steps: n(3, 'ol.flow-steps > li'), flowSvg: n(3, '.flowbox svg'),
        checks: n(4, 'input[type="checkbox"][data-check-key]'), compareRows: n(5, 'table.rbk-cmp tbody tr'), compareOptions: n(5, 'table.rbk-cmp thead th.opt'),
        cards: n(5, '.cmpc'), recommended: figs[5] ? [...figs[5].querySelectorAll('table.rbk-cmp th.opt.rec .k')].map((k) => k.textContent) : null,
        picks: n(5, 'table.rbk-cmp tfoot .cv-pick'),
      };
      for (const k of Object.keys(x.drawn)) if (JSON.stringify(drawn[k]) !== JSON.stringify(x.drawn[k])) problems.push(k + ': ' + JSON.stringify(drawn[k]) + ' != ' + JSON.stringify(x.drawn[k]));
    } else {
      const box = main.querySelector('[data-ans="' + x.decision + '"]');
      const fields = !box ? [] : x.fields.map((f) => {
        const ctl = [...box.querySelectorAll('[data-field="' + f.id + '"]')], c = ctl[0], err = box.querySelector('[id$="-' + f.id + '-error"]');
        return { id: f.id, tag: c ? c.tagName.toLowerCase() + ':' + c.type : null, controls: ctl.length,
          attrs: !c ? null : c.tagName === 'SELECT' ? c.options.length : c.type === 'number' ? [c.min, c.max, c.step].join('|') : c.type === 'text' ? c.maxLength : null,
          invalid: ctl.length > 0 && ctl.every((e) => e.getAttribute('aria-invalid') === 'true'), error: err ? err.textContent : null };
      });
      const st = BriefPage.state.ui.answers && BriefPage.state.ui.answers[String(x.decision)];
      drawn = { fields, confirm: !!(box && box.querySelector('.ans-confirm')), send: !!(box && box.querySelector('.ans-confirm [data-act="ans-send"]')),
        values: st && st.confirm && st.confirm.values ? JSON.parse(JSON.stringify(st.confirm.values)) : null };
      if (!box) problems.push('no answer box for #' + x.decision);
      x.fields.forEach((f, i) => {
        const d = fields[i] || {};
        for (const k of ['tag', 'controls', 'attrs']) if (d[k] !== f[k]) problems.push(f.id + ' ' + k + ': ' + JSON.stringify(d[k]) + ' != ' + JSON.stringify(f[k]));
        const want = x.state === 'input-invalid' ? x.errors[f.id] : null;
        if (d.error !== want || d.invalid !== (want !== null)) problems.push(f.id + ' refusal: ' + JSON.stringify([d.error, d.invalid]) + ' != ' + JSON.stringify(want));
      });
      const confirmed = x.state === 'input-confirm';
      if (drawn.confirm !== confirmed || drawn.send !== confirmed) problems.push('confirm row: ' + JSON.stringify([drawn.confirm, drawn.send]));
      if (confirmed && JSON.stringify(Object.keys(x.values).map((k) => drawn.values && drawn.values[k])) !== JSON.stringify(Object.values(x.values))) problems.push('confirmed values: ' + JSON.stringify(drawn.values));
    }
    return { result: problems.length ? 'fail' : 'pass', pass: !problems.length, part: x.part, state: x.state || null, target: x.target, problems, drawn, omitted, trimmed: trimmed === undefined ? null : trimmed };
  };
  // (k) made to fail once: the table's last row taken out, measured, put back
  qa.selfTestK = (x) => {
    const before = qa.checkK(x);
    const row = document.querySelector('#main [data-block="rep/' + x.report + '/blk/0"] tbody tr:last-child');
    let broken = null;
    if (row) {
      const parent = row.parentNode, next = row.nextSibling;
      try { row.remove(); broken = qa.checkK(x); } finally { parent.insertBefore(row, next); }
    }
    const after = qa.checkK(x);
    return { flipped: before.pass && !!broken && broken.pass === false && after.pass, before: before.pass, broken: broken ? broken.pass : null, after: after.pass,
      brokenProblems: broken ? broken.problems : null };
  };
  // (l) every word (a run of non-space characters) of a report-table cell stays on one line unless it is wider than the
  // widest line its cell can have. A table column can widen up to the table's scroll box (.rbk-scroll), so a squeezed column
  // is no excuse (B-F3-01 split 그래프|와 in a 52 px column); below 600 px a record's text sits in a grid column that cannot
  // widen: the room its lines have. A word's Range client rects are its line fragments.
  qa.checkL = () => {
    const r1 = (v) => Math.round(v * 10) / 10;
    const cells = [...document.querySelectorAll('#main :is(table.rbk-tbl, table.rbk-cmp) :is(th, td), #main .rbk-cmpc :is(.cmpc-h, dt, dd)')].filter(visible);
    const failures = [];
    let words = 0, wider = 0;
    for (const cell of cells) {
      const cs = getComputedStyle(cell);
      const px = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
      const right = cell.getBoundingClientRect().left + cell.clientLeft + cell.clientWidth - px('padding-right');
      const tw = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        const starts = [...range.getClientRects()].filter((x) => x.width > 0).map((x) => x.left);
        if (!starts.length) continue;
        // a comparison card's line is the card's content box, never the grid column its own layout squeezed (B-18B-01)
        const card = cell.closest('.cmpc'), ccs = card && getComputedStyle(card);
        const room = cs.display === 'table-cell'
          ? cell.closest('.rbk-scroll').clientWidth - px('padding-left') - px('padding-right') - px('border-left-width') - px('border-right-width')
          : card ? card.clientWidth - parseFloat(ccs.paddingLeft) - parseFloat(ccs.paddingRight)
          : right - Math.min(...starts);
        for (const m of n.data.matchAll(/\S+/g)) {
          words++;
          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);
          const rects = [...range.getClientRects()].filter((x) => x.width > 0).sort((a, b) => a.top - b.top);
          let lines = rects.length ? 1 : 0;
          for (let i = 1; i < rects.length; i++) if (rects[i].top - rects[i - 1].top > Math.min(rects[i].height, rects[i - 1].height) / 2) lines++;
          const width = rects.reduce((s, x) => s + x.width, 0);
          if (width > room + 0.5) { wider++; continue; }
          if (lines > 1) failures.push({ cell: cssPath(cell), word: m[0], lines, width: r1(width), room: r1(room), overflowWrap: cs.overflowWrap, wordBreak: cs.wordBreak });
        }
      }
    }
    const pass = cells.length > 0 && words > 0 && !failures.length;
    return { result: pass ? 'pass' : 'fail', pass, cells: cells.length, words, wider, split: failures.length, failures: failures.slice(0, 40) };
  };
  // (l) made to fail once: the first table cell may break between any two letters (word-break: break-all), measured, put back
  qa.selfTestL = () => {
    const before = qa.checkL();
    const cell = document.querySelector('#main table.rbk-tbl tbody td');
    let broken = null;
    if (cell) {
      const old = cell.getAttribute('style');
      try { cell.style.cssText += ';word-break:break-all'; broken = qa.checkL(); } finally { if (old === null) cell.removeAttribute('style'); else cell.setAttribute('style', old); }
    }
    const after = qa.checkL();
    return { flipped: !!broken && broken.pass === false && broken.split > before.split && after.pass === before.pass && after.split === before.split,
      before: before.pass, broken: broken ? broken.pass : null, after: after.pass, split: [before.split, broken ? broken.split : null, after.split] };
  };
  // scrolls #main so the element (or its `up` ancestor) sits just under the sticky sub-tab bar ('top') or at the bottom
  qa.showBlock = (sel, edge, up) => {
    const main = document.getElementById('main');
    let el = document.querySelector(sel);
    if (el && up && el.closest(up)) el = el.closest(up);
    if (!el) return null;
    const m = main.getBoundingClientRect(), bar = main.querySelector('.stabs');
    const r = el.getBoundingClientRect();
    main.scrollTop += edge === 'bottom' ? r.bottom - (m.bottom - 12) : r.top - (m.top + (bar ? bar.getBoundingClientRect().height : 0) + 12);
    const a = el.getBoundingClientRect();
    return { scrollTop: Math.round(main.scrollTop), top: Math.round(a.top), bottom: Math.round(a.bottom), maxScroll: main.scrollHeight - main.clientHeight };
  };
  qa.measure = (allow) => ({ a: qa.checkA(), b: qa.checkB(allow), c: qa.checkC(), i: qa.checkI(), j: qa.checkJ(), pageError: !!document.getElementById('page-error'), errors: qa.errors.splice(0) });
  // --inject-overflow: the first visible text span of a 개요 row
  qa.inject = (css) => {
    const panel = document.querySelector('#main .cv-panel[data-sub="ov"]');
    const span = panel ? [...panel.querySelectorAll('li > .rt')].find(visible) : null;
    if (!span) return null;
    span.style.cssText += ';' + css;
    return { selector: cssPath(span), simple: simple(span), css, text: snippet(span) };
  };
  // each check is broken on purpose, measured, restored and measured again
  qa.selfTest = (allow) => {
    const out = {};
    const run = (name, check, breakIt, flipped) => {
      const before = check();
      let undo = null;
      let broken = null;
      try { undo = breakIt(); broken = check(); } finally { if (undo) undo(); }
      const after = check();
      const ok = !!broken && broken.pass === false && after.pass === before.pass && flipped(before, broken, after);
      out[name] = { flipped: ok, before: before.pass, broken: broken ? broken.pass : null, after: after.pass };
    };
    const restyle = (el, css) => { const old = el.getAttribute('style'); el.style.cssText += ';' + css; return () => (old === null ? el.removeAttribute('style') : el.setAttribute('style', old)); };
    const mainOf = (r) => r.regions.find((x) => x.name === '#main') || {};
    run('a', qa.checkA, () => {
      const d = document.createElement('div');
      d.style.cssText = 'width:' + (innerWidth + 400) + 'px;height:4px';
      (document.querySelector('#main .cv-panel') || document.getElementById('main')).appendChild(d);
      return () => d.remove();
    }, (b, x, a) => mainOf(x).pass === false && mainOf(x).scrollWidth >= mainOf(b).scrollWidth + 300 && mainOf(a).scrollWidth === mainOf(b).scrollWidth);
    let hl = null;
    run('b', () => qa.checkB(allow), () => { const el = document.querySelector('#main .cv-hl'); hl = cssPath(el); return restyle(el, 'width:60px;white-space:nowrap;overflow:hidden'); },
      (b, x, a) => x.failures.some((f) => f.selector === hl) && a.failures.length === b.failures.length);
    run('c', qa.checkC, () => restyle(document.getElementById('main'), 'margin-left:9px'), (b, x) => Math.abs(x.mainLeft - b.mainLeft - 9) <= 1);
    run('i', qa.checkI, () => {
      const band = document.createElement('section');
      band.id = 'alarm-band';
      document.getElementById('main').before(band);
      return () => band.remove();
    }, (b, x, a) => !b.bandPresent && x.bandPresent && !a.bandPresent);
    run('j', qa.checkJ, () => {
      const el = document.querySelector('#rail .sh-rb.on');
      const undo = restyle(el, 'background:transparent;transition:none');
      return () => {
        undo();
        // The recovery is a settled-state assertion. Finish its exact finite transition rather than waiting on time.
        for (const a of el.getAnimations()) if (a.transitionProperty === 'background-color') a.finish();
      };
    }, (b, x, a) => b.pass && !x.pass && a.pass);
    return out;
  };
}

// ------------------------------------------------------------------ run state

const startedAt = new Date().toISOString();
const results = { shots: [], mockups: [], sequences: { e: {}, h: {} }, selfTests: {}, fatal: [] };
const owned = { tempDirs: [] };
const chrome = { browserPid: null, profileDir: null, pids: [], aliveAfterClose: null, profileRemoved: null, closeError: null };
const errLog = []; // CDP console/exception/log errors: {phase, url, text}
const mockupErrors = [];
let errCursor = 0;
let phase = 'build';
let page = null;
let model = null;
let blk = null; // the blocks page: {vm, fields, expect, additions, url, port, dataJsBytes}
let boardServer = null;
let csp = null;
const cspViolations = [];
const axCaptures = [];
const blkAnswers = []; // /answer bodies that reached the blocks page's server (must stay empty)

const send = (method, params) => page.client.send(method, params);
const ev = (expr) => page.eval(expr);
const settle = () => ev('__qa.settle()');

function listen(method, fn) {
  const list = page.client.listeners.get(method) || [];
  list.push(fn);
  page.client.listeners.set(method, list);
}
function noteError(text) {
  if (phase === 'mockup') mockupErrors.push(text);
  else errLog.push(text);
}

// watchCsp collects into its own array; route every violation into the normal error path (and the result) once per drain.
function drainCsp() {
  if (!csp) return;
  for (const violation of csp.violations.splice(0)) {
    cspViolations.push(violation);
    noteError('csp ' + JSON.stringify(violation));
  }
}

async function captureAx({ view, name, viewport }) {
  const snap = await axSnapshot(page);
  const rawFile = `ax-${viewport}-${name}.json`;
  const textFile = `ax-${viewport}-${name}.txt`;
  fs.writeFileSync(path.join(OUT, rawFile), JSON.stringify(snap.raw, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, textFile), snap.text + '\n');
  const findings = axFindings(snap.raw, { view, viewport });
  axCaptures.push({ view, name, viewport, rawFile, textFile, findings });
  console.log(`ax ${rawFile}: ${findings.nodes} nodes, ${findings.instances.length} unnamed interactive`);
  return { raw: rawFile, text: textFile, nodes: findings.nodes, unnamed: findings.instances.length };
}

// The five hostile strings of test/fixtures/hostile-strings.json, served over http, must be text: each target keeps its
// exact text, creates no b/script/img/svg/textarea descendant and carries no on* attribute; no script may have run.
async function assertHostileFixtures() {
  const H = HOSTILE_STRINGS;
  await ev(`(BriefPage.open(${J(HOSTILE_SID)}, 'rep'), true)`);
  await settle();
  const repSel = `#main [data-block="rep/${HOSTILE_REPORT}"]`;
  const targets = await ev(`(() => {
    const checks = [
      { name: 'title', sel: '#main .cv-h1', expected: ${J(H[0])} },
      { name: 'table-cell', sel: ${J(`${repSel} [data-block="rep/${HOSTILE_REPORT}/blk/0"] tbody td`)}, expected: ${J(H[1])} },
      { name: 'kv-value', sel: ${J(`${repSel} [data-block="rep/${HOSTILE_REPORT}/blk/1"] dd`)}, expected: ${J(H[2])} },
      { name: 'decision-option', sel: ${J(`${repSel} [data-block="rep/${HOSTILE_REPORT}/blk/2"] th.opt`)}, expected: 'A' + ${J(H[3])} },
    ];
    return checks.map((x) => {
      const el = document.querySelector(x.sel);
      if (!el) return { ...x, found: false };
      return { ...x, found: true, actual: el.textContent,
        descendants: [...el.querySelectorAll('b,script,img,svg,textarea')].map((d) => d.tagName.toLowerCase()),
        eventAttrs: [el, ...el.querySelectorAll('*')].flatMap((e) => [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name)) };
    });
  })()`);
  await ev(`(BriefPage.open(${J(HOSTILE_SID)}, 'dec'), true)`);
  await settle();
  const label = await ev(`(() => {
    const el = document.querySelector('#main [data-ans="${HOSTILE_INPUT}"] label[for$="-hostile_label"]');
    if (!el) return { name: 'input-label', found: false, expected: ${J(H[4])} };
    return { name: 'input-label', found: true, expected: ${J(H[4])}, actual: el.textContent,
      descendants: [...el.querySelectorAll('b,script,img,svg,textarea')].map((d) => d.tagName.toLowerCase()),
      eventAttrs: [el, ...el.querySelectorAll('*')].flatMap((e) => [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name)) };
  })()`);
  const pwned = await ev('globalThis.pwned === undefined');
  const problems = [];
  for (const t of [...targets, label]) {
    if (!t.found) problems.push(`${t.name}: not found`);
    else {
      if (t.actual !== t.expected) problems.push(`${t.name}: text ${J(t.actual)} != ${J(t.expected)}`);
      if (t.descendants.length) problems.push(`${t.name}: injected descendants ${J(t.descendants)}`);
      if (t.eventAttrs.length) problems.push(`${t.name}: event attributes ${J(t.eventAttrs)}`);
    }
  }
  if (!pwned) problems.push('globalThis.pwned is defined');
  if (problems.length) throw new Error('hostile fixture failed: ' + J(problems));
  return { session: HOSTILE_SID, report: HOSTILE_REPORT, decision: HOSTILE_DECISION, input: HOSTILE_INPUT, pwnedUndefined: pwned,
    targets: [...targets, label].map(({ expected, ...t }) => t) };
}

async function mouse(type, x, y, o = {}) {
  await send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: o.button || (type === 'mouseMoved' ? 'none' : 'left'),
    buttons: o.buttons || 0, clickCount: o.clickCount || 0, modifiers: o.modifiers || 0,
  });
}
async function clickAt(x, y) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
}
async function dblclickAt(x, y) {
  await clickAt(x, y);
  await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 2 });
  await mouse('mouseReleased', x, y, { button: 'left', clickCount: 2 });
}
async function dragFrom(x0, y0, x1, y1, steps = 10) {
  await mouse('mouseMoved', x0, y0);
  await mouse('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1 });
  for (let k = 1; k <= steps; k++) await mouse('mouseMoved', x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', x1, y1, { button: 'left', clickCount: 1 });
}
// a point inside the first element matching sel, after scrolling it to the middle of its scroller (clear of the sticky
// sub-tab bar and tray); hit = what the mouse would really land on there
async function point(sel, { fx = 0.5, fy = 0.5, scroll = true } = {}) {
  const p = await ev(`(() => {
    const el = document.querySelector(${J(sel)});
    if (!el) return null;
    ${scroll ? "el.scrollIntoView({ block: 'center', inline: 'nearest' });" : ''}
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * ${fx}, y = r.top + r.height * ${fy};
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: r.width, h: r.height, inside: !!hit && (hit === el || el.contains(hit)), hit: hit ? hit.tagName.toLowerCase() + '.' + [...hit.classList].join('.') : null };
  })()`);
  if (!p || !(p.w > 0 && p.h > 0)) throw new Error(`nothing visible matches ${sel}`);
  return p;
}
async function click(sel, o) {
  const p = await point(sel, o);
  if (!p.inside) throw new Error(`a click on ${sel} would land on ${p.hit}`);
  await clickAt(p.x, p.y);
  await settle();
}
async function dblclick(sel) {
  const p = await point(sel);
  if (!p.inside) throw new Error(`a double-click on ${sel} would land on ${p.hit}`);
  await dblclickAt(p.x, p.y);
  await settle();
}
async function key(name, code, vk, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}
const ctrlBackslash = () => key('\\', 'Backslash', 220, 2);
const ctrlEnter = () => key('Enter', 'Enter', 13, 2);
// the mouse rests in the rail's empty middle: no hover style, no tooltip, outside the sidebar panel
async function park() {
  const p = await ev(`(() => {
    const rail = document.getElementById('rail').getBoundingClientRect();
    const btns = [...document.querySelectorAll('#rail .sh-rb')].map((b) => b.getBoundingClientRect());
    const last = btns[btns.length - 1], prev = btns[btns.length - 2];
    return { x: rail.left + 4, y: (prev.bottom + last.top) / 2 };
  })()`);
  await mouse('mouseMoved', p.x, p.y);
  await settle();
}
const scrollMainTop = () => ev("(document.getElementById('main').scrollTop = 0, true)");

// ------------------------------------------------------------------ shots

async function shot(vp, n, state, o = {}) {
  await settle();
  const injected = INJECT ? await ev(`__qa.inject(${J(INJECT_CSS)})`) : null;
  const m = await ev(`__qa.measure(${J(ALLOW)})`);
  const extra = {};
  if (o.d !== undefined) extra.d = await ev(`__qa.checkD(${J(o.d)})`);
  if (o.g) extra.g = await ev('__qa.checkG()');
  if (o.k) extra.k = await ev(`__qa.checkK(${J(o.k)})`);
  if (o.l) extra.l = await ev('__qa.checkL()');
  await ev('1'); // every CDP event sent before this reply is in errLog now
  drainCsp();
  const fresh = errLog.slice(errCursor);
  errCursor = errLog.length;
  const fPass = !fresh.length && !m.errors.length && !m.pageError;
  const checks = {
    a: m.a, b: m.b, c: m.c, ...extra, ...(o.pre || {}),
    f: { result: fPass ? 'pass' : 'fail', pass: fPass, console: fresh, page: m.errors, pageErrorMark: m.pageError },
    i: m.i, j: m.j,
  };
  const name = `build-${vp.name}-${String(n).padStart(2, '0')}-${state}`;
  const file = `shots/${name}.png`;
  await page.screenshot(path.join(OUT, file));
  const ids = Object.keys(checks).sort();
  const failed = ids.filter((k) => checks[k].result !== 'pass');
  results.shots.push({ name, file, kind: 'build', viewport: vp.name, state, pass: !failed.length, failed, checks, ...(injected ? { injected } : {}), ...(o.note ? { note: o.note } : {}) });
  console.log(`${failed.length ? 'FAIL' : 'pass'} ${name} [${ids.map((k) => k + (checks[k].result === 'pass' ? '' : '!')).join(' ')}]`);
  for (const k of failed) console.log(`     (${k}) ${J(culpritsOf(k, checks[k])).slice(0, 600)}`);
}

function culpritsOf(k, c) {
  if (k === 'a') return { document: c.document, regions: (c.regions || []).filter((r) => r.pass === false).map((r) => ({ name: r.name, scrollWidth: r.scrollWidth, clientWidth: r.clientWidth, culprits: r.culprits })), culprits: c.culprits };
  if (k === 'b') return c.failures.map((f) => ({ selector: f.selector, simple: f.simple, scrollWidth: f.scrollWidth, clientWidth: f.clientWidth, text: f.text }));
  if (k === 'f') return { console: c.console, page: c.page, pageErrorMark: c.pageErrorMark };
  if (k === 'l') return { split: c.split, wider: c.wider, words: c.failures.slice(0, 8).map((f) => `${f.word} ${f.width}/${f.room}px ${f.cell.split(' > ').slice(-2).join(' > ')}`) };
  return c;
}

// ------------------------------------------------------------------ the states of one viewport

async function sidebarClose() {
  let st = await ev('__qa.sideState()');
  if (st.peek && (await ev("matchMedia('(max-width: 899px)').matches")) === false) {
    // the peek panel closes when the mouse leaves it: enter it, then leave to the rail
    const p = await point('#side .sh-head', { scroll: false });
    await mouse('mouseMoved', p.x, p.y);
    await park();
    st = await ev('__qa.sideState()');
  }
  if (st.shown) {
    await click('#side .sh-head [data-sh="toggleSide"]'); // « (below 900 px: hides the overlay)
    await park();
    st = await ev('__qa.sideState()');
  }
  if (st.shown) throw new Error('the sidebar did not close: ' + J(st));
  return st;
}

// Ends in the state of the last path, still shown: the peek panel (>= 900 px) or the overlay (< 900 px).
async function reopenPaths(vp) {
  const narrow = vp.width < 900;
  const paths = {};
  const tryPath = async (name, act) => {
    await sidebarClose();
    await act();
    await settle();
    const st = await ev('__qa.sideState()');
    paths[name] = { ...st, pass: st.shown };
  };
  await tryPath('sidebar header close + tab-bar reopen', async () => {
    await click('#tabs .sh-topen');
    await click('#side .sh-head [data-sh="toggleSide"]');
    await park();
    if ((await ev('__qa.sideState()')).shown) throw new Error('the sidebar header close button did not close the sidebar');
    await click('#tabs .sh-topen');
  });
  await tryPath('» (tab bar)', () => click('#tabs .sh-topen'));
  await tryPath('Ctrl+\\', async () => { await park(); await ctrlBackslash(); });
  if (!narrow) {
    await tryPath('left-edge peek', async () => {
      const p = await point('#edge', { scroll: false });
      await mouse('mouseMoved', p.x, p.y);
    });
  } else {
    paths['left-edge peek'] = { applicable: false, reason: 'below 900 px the sidebar is the overlay that the rail / tab-bar opener / Ctrl+\\ open; shell.css hides the left-edge zone (.sh-edge) there' };
  }
  const applicable = Object.values(paths).filter((p) => p.applicable !== false);
  const pass = applicable.length >= 3 && applicable.every((p) => p.pass);
  return { result: pass ? 'pass' : 'fail', pass, paths };
}

async function runViewport(vp, A, B, D) {
  phase = 'build';
  await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false });
  errCursor = errLog.length;
  const indexUrl = pathToFileURL(path.join(STATE, 'index.html')).href;
  await page.goto(indexUrl);
  await ev('(localStorage.clear(), sessionStorage.clear(), true)'); // a fresh page: default prefs, no drafts
  await page.goto('about:blank');
  await page.goto(indexUrl);
  drainCsp();
  const info = await ev('({ seq: BriefPage.state.seq, transport: BriefPage.transport(), live: BriefPage.state.ui.live, innerWidth, innerHeight, title: document.title, now: Date.now() })');
  // the page clock runs from the fixture's generatedAt (PAGE_CLOCK), not from the wall clock
  const pinned = info.now >= FIXTURE.generatedAt && info.now < FIXTURE.generatedAt + 3600000;
  if (info.seq !== model.seq || info.transport !== 'file' || info.innerWidth !== vp.width || info.innerHeight !== vp.height || !pinned) throw new Error('unexpected first paint: ' + J(info));
  await park();
  const axFile = await captureAx({ view: 'matrix-file', name: 'file', viewport: vp.name });
  results.axFile = results.axFile || {};
  results.axFile[vp.name] = axFile;
  let n = 0;
  const next = (state, o) => shot(vp, ++n, state, o);

  // each rail view: the click is (h)
  for (const k of ['inbox', 'plans', 'home', 'archive', 'settings', 'conv']) {
    const h = await ev(`__qa.railClick(${J(k)})`);
    results.sequences.h[`${vp.name}/${k}`] = h;
    await next('rail-' + k, { pre: { h } });
  }

  // sidebar closed, then the four ways back (e); the last one is the peek (overlay below 900 px)
  await sidebarClose();
  await next('side-closed');
  const e = await reopenPaths(vp);
  results.sequences.e[vp.name] = e;
  await next('side-peek', { pre: { e } }); // the last path's state, still shown; the shot carries the sequence result
  await sidebarClose();
  if (vp.width >= 900) { await click('#tabs .sh-topen'); await park(); } // docked open again for the pages

  // three tabs, A and B pinned (double-click), the 300-character conversation active
  for (const sid of [A.id, B.id, D.id]) await ev(`(BriefPage.open(${J(sid)}), true)`);
  await settle();
  await dblclick(`#tabs .tb[data-tab="${A.tabId ? 'w:' + A.tabId : A.id}"] .tb-go`);
  await dblclick(`#tabs .tb[data-tab="${B.tabId ? 'w:' + B.tabId : B.id}"] .tb-go`);
  await click(`#tabs .tb[data-tab="${D.id}"] .tb-go`);
  await park();
  const tabs = await ev("({ order: [...document.querySelectorAll('#tabs .tb')].map((t) => t.getAttribute('data-tab')), pinned: [...document.querySelectorAll('#tabs .tb.pinned')].map((t) => t.getAttribute('data-tab')), active: BriefPage.state.ui.active })");
  if (tabs.pinned.length !== 2 || tabs.active !== D.id) throw new Error('pinning failed: ' + J(tabs));
  await next('tabs-pinned', { note: { tabs } });

  // A's page, each sub-tab
  await click(`#tabs .tb[data-tab="${A.tabId ? 'w:' + A.tabId : A.id}"] .tb-go`);
  await park();
  await scrollMainTop();
  await next('sub-ov');
  await ev("console.error('__qa_selftest_f__')");
  await ev('1');
  const fSeen = errLog.slice(errCursor).some((t) => t.includes('__qa_selftest_f__'));
  for (let i = errLog.length - 1; i >= errCursor; i--) if (errLog[i].includes('__qa_selftest_f__')) errLog.splice(i, 1); // the self-test's own
  results.selfTests[vp.name] = { ...(await ev(`__qa.selfTest(${J(ALLOW)})`)), f: { flipped: fSeen } };
  for (const [sub, state] of [['plan', 'sub-plan'], ['wk', 'sub-wk'], ['dec', 'sub-dec'], ['rep', 'sub-rep']]) {
    await click(`#main .stabs [data-sub="${sub}"]`);
    await park();
    await scrollMainTop();
    await next(state, sub === 'plan' ? { g: true } : {});
  }
  await click('#main .stabs [data-sub="ov"]');
  await click('#main details.att > summary');
  await click('#main details.dt > summary');
  await ev("(document.querySelector('#main details.att').scrollIntoView({ block: 'center' }), true)");
  await park();
  await next('ov-paths');
  await click('#main details.cv-notes > summary');
  await ev("(document.querySelector('#main details.cv-notes').scrollIntoView({ block: 'center' }), true)");
  await park();
  await next('ov-notes');

  // the tray on a text selection: a drag over the first line of the 지금 headline, ending clear of the block's own 💬 주석
  // hover button (top-right corner of the block; a release on that button is no text selection)
  await scrollMainTop();
  await settle();
  const drag = await ev(`(() => {
    const p = document.querySelector('#main .cv-hl');
    const limit = p.closest('[data-block]').getBoundingClientRect().right - 90;
    const t = [...p.childNodes].find((x) => x.nodeType === 3 && x.data.trim().length > 4);
    const r = document.createRange();
    const at = (i) => { r.setStart(t, i); r.setEnd(t, i + 1); return r.getBoundingClientRect(); };
    const s0 = at(1);
    let end = 1;
    for (let i = 2; i < Math.min(t.data.length - 1, 26); i++) { const ri = at(i); if (Math.abs(ri.top - s0.top) > 2 || ri.right > limit) break; end = i; }
    const e0 = at(end);
    return { x0: s0.left + 1, y0: s0.top + s0.height / 2, x1: e0.right - 1, y1: e0.top + e0.height / 2, text: t.data.slice(1, end + 1) };
  })()`);
  await dragFrom(drag.x0, drag.y0, drag.x1, drag.y1);
  await settle();
  const sel = await ev('__qa.lastSel');
  if (!sel || !(await ev("!!document.querySelector('.pop')"))) throw new Error('no tray after the text drag: ' + J({ drag, sel }));
  await next('tray-text', { d: sel.rect, note: { selected: sel.text } });
  await send('Input.insertText', { text: '제목 줄을 조금 더 짧게' });
  await ctrlEnter();
  await settle();

  // the tray on a box selection: a drag from the page's empty left margin over the 지금 and flow blocks
  await scrollMainTop();
  await settle();
  const band = await ev(`(() => {
    const m = document.getElementById('main').getBoundingClientRect();
    const now = document.querySelector('#main [data-block="now"]').getBoundingClientRect();
    const flow = document.querySelector('#main [data-block="flow"]').getBoundingClientRect();
    const x0 = m.left + 4, y0 = now.top + 6;
    const start = document.elementFromPoint(x0, y0);
    return { x0, y0, x1: Math.min(m.left + 260, m.right - 24), y1: flow.bottom - 3, start: start ? start.className : null, startIsBlock: !!(start && start.closest('[data-block],[data-anchor]')) };
  })()`);
  if (band.startIsBlock) throw new Error('the box drag would start on a block: ' + J(band));
  await dragFrom(band.x0, band.y0, band.x1, band.y1);
  await settle();
  const picked = await ev("[...document.querySelectorAll('#main .bsel')].map((e) => e.getAttribute('data-block'))");
  if (!(await ev("!!document.querySelector('.pop')"))) throw new Error('no tray after the box drag: ' + J(band));
  const bandRect = { left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1), right: Math.max(band.x0, band.x1), bottom: Math.max(band.y0, band.y1) };
  await next('tray-box', { d: bandRect, note: { picked, band: bandRect } });
  await send('Input.insertText', { text: '이 두 블록을 한 줄로 합쳐 줘' });
  await ctrlEnter();
  await settle();

  // a third one through a block's 💬 button, then the tray list
  const row = '#main [data-block^="change/"]';
  const rp = await point(row, { fx: 0.3 });
  await mouse('mouseMoved', rp.x, rp.y);
  await settle();
  await click(`${row} > .bh`, { scroll: false });
  if (!(await ev("!!document.querySelector('.pop')"))) throw new Error('no tray after the 💬 button');
  await send('Input.insertText', { text: '이 변화의 증거 파일을 다시 확인해 줘' });
  await ctrlEnter();
  await settle();
  await click('#main [data-ann-act="list"]');
  await park();
  await scrollMainTop();
  const count = await ev(`BriefAnnotate.list(${J(A.id)}).length`);
  if (count !== 3) throw new Error(`expected 3 annotations, have ${count}`);
  await next('tray-list', { note: { annotations: count } });

  // the 보고서 tab with a pin: a click at 25% / 40% of the first report image
  await click('#main .stabs [data-sub="rep"]');
  await park();
  const ip = await point('#main .rimg img', { fx: 0.25, fy: 0.4 });
  if (!ip.inside) throw new Error('the report image is covered at the pin spot by ' + ip.hit);
  await clickAt(ip.x, ip.y);
  await settle();
  if (!(await ev("!!document.querySelector('.pop')"))) throw new Error('no tray after the image click');
  await send('Input.insertText', { text: '이 부분 색을 더 진하게' });
  await ctrlEnter();
  await park();
  const pin = await ev("(() => { const p = document.querySelector('#main .rimg .pin:not(.pend)'); return p ? { n: p.textContent, left: p.style.left, top: p.style.top } : null; })()");
  if (!pin) throw new Error('no pin drawn on the report image');
  await next('rep-pin', { note: { pin } });
}

// real typing into a board field: focus, Ctrl+A, the text inserted as one input event; the field must then hold it
async function typeInto(sel, value) {
  if (!(await ev(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.focus(); return document.activeElement === el; })()`))) throw new Error('cannot focus ' + sel);
  await key('a', 'KeyA', 65, 2);
  await send('Input.insertText', { text: String(value) });
  await settle();
  const v = await ev(`(document.querySelector(${J(sel)}) || {}).value`);
  if (v !== String(value)) throw new Error(`typed into ${sel}: ${J(v)} instead of ${J(String(value))}`);
}

// The blocks page in light and dark: each block of blocks-max at the top of #main, the table's last row, then on 결정 the
// input decision empty, after one invalid value per field, and confirmed with the maximal values (never sent).
async function runBlocks(vp) {
  phase = 'build';
  const A = blk.vm.sessions[0];
  const box = `#main [data-ans="${BLK_DECISION}"]`;
  const field = (f) => `${box} [data-field="${f.id}"]`;
  const [textF, numberF, selectF, radioF] = blk.fields;
  const kRep = (target) => ({ ...blk.expect.report, part: 'report', target });
  const kIn = (state, target = box) => ({ ...blk.expect.input, part: 'input', state, target });
  let n = 20; // after the viewport's 20 shell states
  const next = (state, o) => shot(vp, ++n, state, o);
  const showCard = async () => { await park(); return ev(`__qa.showBlock(${J(box)}, 'top', '.dcard')`); };
  try {
    for (const scheme of SCHEMES) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      errCursor = errLog.length;
      await page.goto(blk.url);
      await ev('(localStorage.clear(), sessionStorage.clear(), true)'); // a fresh page: default prefs, no drafts
      await page.goto('about:blank');
      await page.goto(blk.url);
      drainCsp();
      const info = await ev("({ seq: BriefPage.state.seq, transport: BriefPage.transport(), live: BriefPage.state.ui.live, dark: matchMedia('(prefers-color-scheme: dark)').matches, innerWidth })");
      if (info.seq !== blk.vm.seq || info.transport !== 'http' || info.dark !== (scheme === 'dark') || info.innerWidth !== vp.width) throw new Error('unexpected blocks page: ' + J(info));
      if (scheme === SCHEMES[0]) {
        const axBoard = await captureAx({ view: 'matrix-board', name: 'board', viewport: vp.name });
        results.axFile = results.axFile || {};
        results.axFile[vp.name] = { ...(results.axFile[vp.name] || {}), board: axBoard };
        results.hostile = results.hostile || {};
        results.hostile[vp.name] = await assertHostileFixtures();
      }
      await ev(`(BriefPage.open(${J(A.id)}, 'rep'), true)`);
      await park();
      if (scheme === SCHEMES[0]) {
        const st = results.selfTests[vp.name] || (results.selfTests[vp.name] = { shell: { flipped: false, note: 'the shell states never reached their self-test' } });
        st.k = await ev(`__qa.selfTestK(${J(kRep(blkSel(0)))})`);
        st.l = await ev('__qa.selfTestL()');
      }
      for (const [i, kind] of BLOCK_KINDS.entries()) {
        const at = await ev(`__qa.showBlock(${J(blkSel(i))}, 'top')`);
        await next(`blk-${scheme}-${kind}`, { k: kRep(blkSel(i)), l: kind === 'table', note: { at } });
      }
      const lastRow = `${blkSel(0)} tbody tr:last-child`;
      const end = await ev(`__qa.showBlock(${J(lastRow)}, 'bottom')`);
      await next(`blk-${scheme}-table-end`, { k: kRep(lastRow), note: { at: end } });

      await click('#main .stabs [data-sub="dec"]');
      await next(`blk-${scheme}-input`, { k: kIn('input'), note: { at: await showCard() } });
      const bad = invalidFieldValues(blk.fields);
      await typeInto(field(textF), bad[textF.id]);
      await typeInto(field(numberF), bad[numberF.id]); // the two choices stay unchosen
      await click(`${box} [data-act="ans-fields"]`);
      await next(`blk-${scheme}-input-invalid`, { k: kIn('input-invalid'), note: { typed: bad, at: await showCard() } });
      const lastError = `${box} [id$="-${radioF.id}-error"]`; // the end of the field grid: the radio group's message
      await next(`blk-${scheme}-input-invalid-end`, { k: kIn('input-invalid', lastError), note: { at: await ev(`__qa.showBlock(${J(lastError)}, 'bottom')`) } });
      const good = maxFieldValues(blk.fields);
      await typeInto(field(textF), good[textF.id]);
      await typeInto(field(numberF), good[numberF.id]);
      if (!(await ev(`(document.querySelector(${J(field(selectF))}).focus(), true)`))) throw new Error('no select');
      await key('End', 'End', 35);
      await key('Enter', 'Enter', 13);
      await settle();
      if (!(await ev(`(() => { const r = [...document.querySelectorAll(${J(field(radioF))})].pop(); r.focus(); return document.activeElement === r; })()`))) throw new Error('no radio');
      await key(' ', 'Space', 32);
      await settle();
      const chosen = await ev(`({ select: document.querySelector(${J(field(selectF))}).value, radio: ([...document.querySelectorAll(${J(field(radioF))})].find((r) => r.checked) || {}).value || null })`);
      if (chosen.select !== good[selectF.id] || chosen.radio !== good[radioF.id]) throw new Error('the keyboard did not choose the last options: ' + J(chosen));
      await click(`${box} [data-act="ans-fields"]`);
      await park();
      const row = `${box} .ans-confirm`; // the confirm row with every value and 보내기, at the bottom edge
      await next(`blk-${scheme}-input-confirm`, { k: kIn('input-confirm', row), note: { at: await ev(`__qa.showBlock(${J(row)}, 'bottom')`) } });
    }
  } finally {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] });
  }
}

async function runMockups(vp) {
  phase = 'mockup';
  for (const m of MOCKUPS) {
    const file = path.join(MOCKUP_DIR, m.file);
    for (const [keyName, hash] of m.shots) {
      const name = `mock-${vp.name}-${keyName}`;
      try {
        await page.goto('about:blank');
        await page.goto(pathToFileURL(file).href + hash);
        const idle = await ev('__qa.timersIdle(5000)');
        await settle();
        await page.screenshot(path.join(OUT, `shots/${name}.png`));
        results.mockups.push({ name, file: `shots/${name}.png`, kind: 'mockup', mockup: keyName, source: m.file + hash, viewport: vp.name, timersIdle: idle === true });
      } catch (err) {
        results.mockups.push({ name, kind: 'mockup', mockup: keyName, source: m.file + hash, viewport: vp.name, error: String(err && err.message || err) });
      }
    }
  }
  phase = 'build';
}

// ------------------------------------------------------------------ contact sheet

function contactHtml() {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mock = (vp, k) => results.mockups.find((m) => m.viewport === vp && m.mockup === k && m.file);
  const sections = VIEWPORTS.map((vp) => {
    const rows = results.shots.filter((s) => s.viewport === vp.name).map((s) => {
      const badges = Object.keys(s.checks).sort().map((k) => `<span class="b ${s.checks[k].result === 'pass' ? 'ok' : 'bad'}">${k}</span>`).join('');
      const mocks = (PAIRS[s.state] || []).map((k) => mock(vp.name, k)).filter(Boolean);
      return `<tr><th scope="row"><div class="st">${esc(s.state)}</div><div class="badges">${badges}</div></th>` +
        `<td><figure><a href="${esc(s.file)}"><img src="${esc(s.file)}" alt="${esc(s.name)}" loading="lazy"></a><figcaption>build · ${esc(s.name)}</figcaption></figure></td>` +
        `<td>${mocks.map((m) => `<figure><a href="${esc(m.file)}"><img src="${esc(m.file)}" alt="${esc(m.name)}" loading="lazy"></a><figcaption>mockup · ${esc(m.source)}</figcaption></figure>`).join('') || '<p class="none">no mockup pair</p>'}</td></tr>`;
    }).join('');
    return `<section><h2>${esc(vp.name)}</h2><table><thead><tr><th>state · checks</th><th>build</th><th>mockup</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  }).join('');
  const s = results.summary;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>board matrix: build vs mockup</title><style>
:root { --bg: #f6f7f9; --panel: #fff; --fg: #1d2330; --muted: #6b7280; --line: #e3e6eb; --ok: #1f8a4c; --ok-bg: #e3f5ea; --bad: #c0352b; --bad-bg: #fde6e4;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 20px; --r: 6px; --fs-s: 12px; --fs: 14px; --fs-h: 18px; }
* { box-sizing: border-box; }
body { margin: 0; padding: var(--s4); background: var(--bg); color: var(--fg); font: var(--fs)/1.45 "Malgun Gothic", system-ui, sans-serif; }
h1 { margin: 0 0 var(--s2); font-size: 22px; } h2 { margin: var(--s4) 0 var(--s2); font-size: var(--fs-h); }
p.sum { margin: 0 0 var(--s3); color: var(--muted); }
table { width: 100%; border-collapse: collapse; table-layout: fixed; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); }
th, td { padding: var(--s2); border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; }
thead th { color: var(--muted); font-size: var(--fs-s); } thead th:first-child, tbody th { width: 150px; }
.st { font-weight: 700; overflow-wrap: anywhere; } .badges { display: flex; flex-wrap: wrap; gap: var(--s1); margin-top: var(--s1); }
.b { padding: 0 6px; border-radius: 9px; font-size: var(--fs-s); font-weight: 700; } .b.ok { background: var(--ok-bg); color: var(--ok); } .b.bad { background: var(--bad-bg); color: var(--bad); }
figure { margin: 0 0 var(--s2); } img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: var(--r); }
figcaption { margin-top: var(--s1); color: var(--muted); font-size: var(--fs-s); overflow-wrap: anywhere; } .none { color: var(--muted); }
</style></head><body><h1>Board shell matrix: build vs mockup</h1>
<p class="sum">${esc(`${s.shots.build} build shots, ${s.shots.mockup} mockup shots · checks ${s.checks.pass} pass / ${s.checks.fail} fail · ${INJECT ? 'NEGATIVE RUN (--inject-overflow)' : 'normal run'} · ${results.finishedAt}`)}</p>
${sections}</body></html>
`;
}

// ------------------------------------------------------------------ main

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-qa-matrix-'));
owned.tempDirs.push(TMP);
const STATE = path.join(TMP, 'state');
let fixtureInfo = null;
let fatal = null;
let chromeTempBefore = null;
const TMP_ROOT = os.tmpdir();
const CHROME_TEMP_RE = /^chrome_.*_(\d+)_\d+$/;
const chromeTempNames = () => fs.readdirSync(TMP_ROOT).filter((x) => x.startsWith('chrome_'));

try {
  const built = matrixModel();
  model = built.vm;
  fixtureInfo = { file: path.relative(ROOT, FIXTURE_FILE).replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(fixtureText).digest('hex'), sessions: FIXTURE.sessions.length, additions: built.additions,
    pageClock: { startsAt: new Date(FIXTURE.generatedAt).toISOString(), why: 'the fixture\'s own generatedAt; the page clock runs on from there in every document' } };
  fs.mkdirSync(path.join(STATE, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(ASSET_DIR)) fs.copyFileSync(path.join(ASSET_DIR, f), path.join(STATE, 'assets', f));
  for (const s of model.sessions) {
    for (const r of s.reports) for (const im of r.images) if (!fs.existsSync(path.join(STATE, im.src))) throw new Error('fixture image missing: ' + im.src);
  }
  fs.writeFileSync(path.join(STATE, 'index.html'), pageHtml(model, model.gen, { mode: 'file' }));
  fs.writeFileSync(path.join(STATE, 'data.js'), `/* seq:${model.seq} */\nwindow.__briefData && window.__briefData(${J(model).replace(/</g, '\\u003c')});\n`);
  for (const m of MOCKUPS) if (!fs.existsSync(path.join(MOCKUP_DIR, m.file))) throw new Error('mockup missing: ' + path.join(MOCKUP_DIR, m.file));
  // the blocks page: its model measured as the renderer's data.js text (C-CAP2 never trims it), served live by the board server
  const b = blocksModel(model);
  const blkBytes = Buffer.byteLength(`/* seq:${b.vm.seq} */\nwindow.__briefData && window.__briefData(${J(b.vm).replace(/</g, '\\u003c')});\n`);
  if (blkBytes > MAX_VM_BYTES) throw new Error(`the blocks page model is ${blkBytes} B, over MAX_VM_BYTES ${MAX_VM_BYTES}: the renderer would trim it`);
  const referenced = new Set(b.vm.sessions.flatMap((s) => s.reports.flatMap((r) => r.images.map((i) => i.src.replace(/^assets\//, '')))));
  boardServer = createBoardServer({ portBase: PORT_BASE, portCount: 10, generation: b.vm.gen, token: BLK_TOKEN,
    getPage: ({ nonce } = {}) => pageHtml(b.vm, b.vm.gen, { mode: 'server', token: BLK_TOKEN, nonce })
      + (INJECT_CSP ? '<script>globalThis.__qaInjectedCsp = true;</script>' : ''), getViewModel: () => b.vm,
    assetsDir: path.join(STATE, 'assets'), assetAllowed: (name) => referenced.has(name),
    onAnswer: async (body) => { blkAnswers.push(body); return { status: 409, json: { ok: false, code: 'QA_MATRIX_NEVER_SENDS' } }; } });
  const { port } = await boardServer.start();
  blk = { ...b, url: `http://127.0.0.1:${port}/`, port, dataJsBytes: blkBytes };
  fixtureInfo.additions.blocksPage = { ...b.additions, served: blk.url, mode: 'server', dataJsBytes: blkBytes, maxVmBytes: MAX_VM_BYTES };

  chromeTempBefore = new Set(chromeTempNames());
  page = await launch({ width: 1440, height: 900 });
  csp = await watchCsp(page); // before the first navigation: the binding and init script must exist before any document
  chrome.browserPid = page.pid;
  chrome.profileDir = page.profileDir;
  chrome.pids = [...new Set([page.pid, ...listProfilePids(page.profileDir)])].sort((x, y) => x - y);
  await send('Log.enable');
  listen('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') noteError(`console.error ${(p.args || []).map((a) => a.value ?? a.description).join(' ')}`); });
  listen('Runtime.exceptionThrown', (p) => noteError(`exception ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`));
  listen('Log.entryAdded', (p) => { if (p.entry?.level === 'error') noteError(`log ${p.entry.text} ${p.entry.url || ''}`.trim()); });
  await page.addInitScript(PAGE_CLOCK);
  await page.addInitScript(`(${pageLib.toString()})();`);
  const [A, B] = model.sessions;
  const D = model.sessions.find((s) => s.id === LONG_ID);
  for (const vp of VIEWPORTS) {
    try {
      await runViewport(vp, A, B, D);
    } catch (err) {
      results.fatal.push({ viewport: vp.name, error: String(err && err.stack || err) });
      console.error(`FATAL ${vp.name}: ${err && err.stack || err}`);
    }
    try {
      await runBlocks(vp);
    } catch (err) {
      results.fatal.push({ viewport: vp.name, part: 'blocks page', error: String(err && err.stack || err) });
      console.error(`FATAL blocks page ${vp.name}: ${err && err.stack || err}`);
    }
    await runMockups(vp);
    chrome.pids = [...new Set([...chrome.pids, page.pid, ...listProfilePids(page.profileDir)])].sort((x, y) => x - y); // every process seen
  }
} catch (err) {
  fatal = err;
  console.error('FATAL', err);
}

// ------------------------------------------------------------------ cleanup and verdict

if (page) {
  try {
    await page.close();
  } catch (err) {
    chrome.closeError = String(err && err.message || err);
  }
  chrome.aliveAfterClose = chrome.pids.filter((pid) => isPidAlive(pid));
  chrome.profileRemoved = !fs.existsSync(chrome.profileDir);
}
const boardServerState = { port: blk ? blk.port : null, closed: null, closeError: null, answerPosts: blkAnswers.length };
if (boardServer) {
  try { await boardServer.close(); } catch (err) { boardServerState.closeError = String(err && err.message || err); }
  if (blk) {
    boardServerState.closed = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: blk.port });
      s.setTimeout(3000, () => { s.destroy(); resolve(false); });
      s.once('connect', () => { s.destroy(); resolve(false); });
      s.once('error', (err) => resolve(err.code === 'ECONNREFUSED'));
    });
  }
}
const chromeTemp = { removed: [], left: [] };
if (chromeTempBefore && chrome.browserPid) {
  for (const n of chromeTempNames()) {
    const m = CHROME_TEMP_RE.exec(n);
    if (chromeTempBefore.has(n) || !m || !chrome.pids.includes(Number(m[1]))) continue;
    try { fs.rmSync(path.join(TMP_ROOT, n), { recursive: true, force: true }); } catch { /* reported below */ }
    (fs.existsSync(path.join(TMP_ROOT, n)) ? chromeTemp.left : chromeTemp.removed).push(n);
  }
}
const tempDirs = {};
for (const d of owned.tempDirs) {
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* reported below */ }
  tempDirs[d] = fs.existsSync(d) ? 'EXISTS' : 'removed';
}

const all = results.shots.flatMap((s) => Object.entries(s.checks).map(([k, c]) => ({ shot: s.name, check: k, pass: c.result === 'pass' })));
const byCheck = {};
for (const c of all) {
  byCheck[c.check] = byCheck[c.check] || { pass: 0, fail: 0 };
  byCheck[c.check][c.pass ? 'pass' : 'fail']++;
}
const selfOk = VIEWPORTS.every((vp) => results.selfTests[vp.name] && Object.values(results.selfTests[vp.name]).every((t) => t.flipped === true));
const mockOk = results.mockups.length === VIEWPORTS.length * MOCKUPS.reduce((n, m) => n + m.shots.length, 0) && results.mockups.every((m) => m.file && !m.error);
const cleanupOk = !!page && !chrome.closeError && chrome.aliveAfterClose.length === 0 && chrome.profileRemoved && !chromeTemp.left.length && Object.values(tempDirs).every((v) => v === 'removed')
  && boardServerState.closed === true && !boardServerState.closeError;
const expectedShots = VIEWPORTS.length * (20 + SCHEMES.length * BLK_STATES.length);
const failing = all.filter((c) => !c.pass);
drainCsp();
if (INJECT_CSP && !cspViolations.length) results.fatal.push({ part: 'csp negative', error: 'csp injection was not observed' });
const axAllow = readAxAllowlist();
const axWritten = axAllow.exists ? null : writeAxAllowlist(axCaptures);
const axEntries = axAllow.exists ? axAllow.entries : axWritten.entries;
const axSha = axAllow.exists ? axAllow.sha256 : axWritten.sha256;
const axCmp = compareAx(axCaptures, axEntries);
const axOk = VIEWPORTS.every((vp) => ['board', 'file'].every((name) => axCaptures.some((c) => c.viewport === vp.name && c.name === name)));
const cspOk = cspViolations.length === 0;
results.summary = {
  shots: { build: results.shots.length, buildExpected: expectedShots, mockup: results.mockups.filter((m) => m.file).length, total: results.shots.length + results.mockups.filter((m) => m.file).length },
  checks: { total: all.length, pass: all.length - failing.length, fail: failing.length, byCheck },
  failing: failing.map((c) => `${c.shot} (${c.check})`),
  culprits: [...new Set(results.shots.flatMap((s) => (s.checks.b ? s.checks.b.failures.map((f) => f.simple) : []).concat(s.checks.a ? (s.checks.a.regions || []).flatMap((r) => (r.culprits || []).map((x) => x.simple)) : [])))],
  selfTestsFlipped: selfOk, mockupsComplete: mockOk, cleanupClean: cleanupOk,
  ax: { captures: axCaptures.length, baseline: axCmp.baseline.length, unexpected: axCmp.unexpected.length,
    allowlist: { file: 'scripts/qa-ax-allowlist.json', exists: axAllow.exists, wrote: !!axWritten, sha256: axSha, entries: Object.keys(axEntries).length } },
  csp: { violations: cspViolations.length, notes: csp ? csp.notes.length : 0, injected: INJECT_CSP },
};
results.finishedAt = new Date().toISOString();
const pass = !fatal && !results.fatal.length && results.shots.length === expectedShots && !failing.length && selfOk && mockOk && cleanupOk && !blkAnswers.length && cspOk && axOk && !axCmp.unexpected.length;
const doc = {
  pass,
  mode: [INJECT ? 'inject-overflow (negative run)' : '', INJECT_CSP ? 'inject-csp-violation (negative run)' : ''].filter(Boolean).join(' + ') || 'normal',
  startedAt, finishedAt: results.finishedAt,
  fatal: fatal ? String(fatal.stack || fatal) : null,
  viewportFatal: results.fatal,
  injected: INJECT ? { css: INJECT_CSS, target: 'the first visible text span (li > .rt) of a row in the 개요 panel, before every 개요 shot' } : null,
  allowlist: ALLOW,
  fixture: fixtureInfo,
  viewports: VIEWPORTS.map((v) => v.name),
  summary: results.summary,
  csp: { installedBeforeFirstNavigation: !!csp, injected: INJECT_CSP, violations: cspViolations, notes: csp ? csp.notes.slice(0, 200) : [] },
  ax: { allowlist: { file: 'scripts/qa-ax-allowlist.json', exists: axAllow.exists, wrote: !!axWritten, sha256: axSha, entries: Object.keys(axEntries).length },
    captures: axCaptures.map((c) => ({ view: c.view, name: c.name, viewport: c.viewport, rawFile: c.rawFile, textFile: c.textFile, nodes: c.findings.nodes, unnamed: c.findings.instances.length })),
    axBaselineFailures: axCmp.baseline, axUnexpected: axCmp.unexpected },
  hostile: results.hostile || {},
  chrome: { ...chrome, launched: 1, maxConcurrent: 1, tempFolders: chromeTemp },
  boardServer: { ...boardServerState, portBase: PORT_BASE, url: blk ? blk.url : null, answerBodies: blkAnswers },
  tempDirs,
  mockupDir: MOCKUP_DIR,
  mockupErrors,
  selfTests: results.selfTests,
  sequences: results.sequences,
  shots: results.shots,
  mockups: results.mockups,
};
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(doc, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'contact.html'), contactHtml());
console.log(`${results.summary.shots.build} build + ${results.summary.shots.mockup} mockup shots; checks ${results.summary.checks.pass} pass / ${results.summary.checks.fail} fail; self-tests ${selfOk ? 'flipped' : 'NOT all flipped'}; csp violations ${cspViolations.length}; ax ${axCmp.baseline.length} baseline / ${axCmp.unexpected.length} unexpected; chrome pids ${chrome.pids.join(',')} alive after close: ${J(chrome.aliveAfterClose)}; temp ${J(tempDirs)}; board server ${J(boardServerState)}`);
console.log(pass ? 'ALL PASS' : 'FAILED');
process.exit(pass ? 0 : 1);
