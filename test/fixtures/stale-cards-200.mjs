import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/store.mjs';
import { validateBrief } from '../../src/schema.mjs';
import { applyBoardAnswer } from '../../src/decide.mjs';
import { maxReportBlocks, text } from './report-blocks-max.mjs';
import { decisionFields, decisionValues } from './decision-fields.mjs';

export const SEED = 20261022;
export const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const names = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(2, '0')}`);
export const deadIds = ['big', ...names('dead', 159)];
export const aliveIds = names('alive', 20);
export const decisionIds = names('decision', 4);
export const mirrorIds = names('mirror', 4);
export const blockedIds = names('blocked', 2);
export const planIds = ['plan-owner', 'plan-carrier', 'plan-name', 'plan-stage'];
export const recentIds = names('recent', 4);
export const boundaryIds = ['boundary-exact', 'boundary-plus'];
export const exemptIds = [...decisionIds, ...mirrorIds, ...blockedIds, ...planIds, ...recentIds, ...boundaryIds];
// The +1 ms boundary folds in stage A; exact 48 h and recent reports can fold in stage B.
export const expectedFoldedIds = [...deadIds, 'boundary-plus'];
export const expectedUnfoldedIds = [...aliveIds, ...exemptIds.filter((id) => id !== 'boundary-plus')];
export const isAlive = (pid) => pid === 20261022;
export const renderOptions = { isAlive };

function mulberry32(seed) {
  return () => {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const decision = () => ({
  question: text(100), options: Object.fromEntries(['A', 'B', 'C'].map((k, i) =>
    [k, { text: text(60, i), consequence: text(80, i + 4) }])),
  recommend: 'B', reason: text(100, 7), blocks: false,
});
const brief = (id, status) => ({
  title: id, status, headline: '한국어 < 보고 \u2028 다음 \u2029 끝', changes: [], done: [], next: '', decisions: [],
});
function checked(input, context = {}) {
  const result = validateBrief(input, context);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return input;
}

// Keep schema lengths, ids and enum values. Escaped delimiters deliberately exercise scriptJson's byte budget.
function escapedBlocks(link) {
  const replace = (v, key = '') => {
    if (typeof v === 'string') return ['kind', 'id', 'state'].includes(key) ? v : '<'.repeat([...v].length);
    if (Array.isArray(v)) return v.map((x) => replace(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replace(x, k)]));
    return v;
  };
  return replace(maxReportBlocks(link));
}
const mediumBlocks = (i) => [
  { kind: 'kv', title: '항목', items: Array.from({ length: 3 }, (_, n) => ({ key: `값${n}`, value: text(60, i + n) })) },
  { kind: 'flow', title: '흐름', steps: [{ label: '확인', state: 'done' }, { label: '다음', state: 'todo' }] },
];

export function make(dir) {
  const store = openStore(dir);
  const random = mulberry32(SEED);
  const assetName = '84fecfda2b6702dc6015b4307ae048524399b4d6493664f11ecc3fc124a7ce37.png';
  const assetPath = fileURLToPath(new URL(`./board-assets/${assetName}`, import.meta.url));
  store.writeNew(`assets/${assetName}`, readFileSync(assetPath));
  const reportsById = {};
  const sourceDecisions = {};
  const add = (id, at, status, meta = {}) => {
    store.replace(`sessions/${id}/meta.json`, { sessionId: id, cwd: 'C:/fixture', title: id,
      lastActivityAt: at, lastBriefAt: at, tabId: `tab-${deadIds.indexOf(id) % 20}`, ...meta });
    store.writeNew(`sessions/${id}/briefs/000001.json`, { at, brief: checked(brief(id, status)) });
  };
  const reports = (id, at, big = false) => {
    let link, closedId;
    if (big) {
      const d = decision();
      const n = store.allocDecisionId({ ...d, sessionId: id, source: 'brief', createdAt: at });
      link = { decision: n };
      closedId = n;
    }
    const list = Array.from({ length: big ? 25 : 3 }, (_, i) => ({
      id: `r${i}`, title: `${id} 보고 ${i}`, summary: text(600, i, '< \u2028 \u2029 '), at: at - i,
      images: [{ sha: assetName.slice(0, 64), ext: 'png', path: assetPath, alt: '시험 그림', w: 1, h: 1 }],
      blocks: big ? escapedBlocks(link) : mediumBlocks(i),
    }));
    // Historical report accumulation can exceed the per-brief maximum of three, but each brief remains schema-valid.
    for (let i = 0; i < list.length; i += 3) checked({ ...brief(id, 'done'), reports: list.slice(i, i + 3).map(({ at: _, images, ...r }) =>
      ({ ...r, images: images.map(({ path, alt }) => ({ path, alt })) })) }, {
        sessionId: id, decisionOwner: (n) => store.readRecord(`decisions/${String(n).padStart(6, '0')}.json`)?.sessionId,
        decisionOpen: () => true,
      });
    if (closedId) {
      store.writeNew(`decision-closures/${String(closedId).padStart(6, '0')}.json`, { id: closedId, reason: 'withdrawn', at });
      store.writeNew(`receipts/${String(closedId).padStart(6, '0')}.json`, { id: closedId, deliveredAt: at, proven: true });
    }
    store.replace(`sessions/${id}/reports.json`, list);
    reportsById[id] = structuredClone(list);
  };
  deadIds.forEach((id, i) => {
    const at = NOW - (3 + Math.floor(random() * 18)) * DAY - i;
    add(id, at, i < 80 ? 'done' : 'in_progress');
    reports(id, at, id === 'big');
  });
  const decisionAt = NOW - 22 * DAY;
  const history = [
    { sessionId: 'dead-00', payload: decision(), answer: { option: 'B' } },
    { sessionId: 'dead-01', payload: decision(), answer: { action: 'hold' } },
    { sessionId: 'dead-02', payload: decision(), answer: { text: '오래된 자유 입력 답 <\u2028\u2029 끝' } },
    { sessionId: 'dead-03', payload: { question: '오래된 입력 설정', reason: '저장된 값 보존', blocks: false, fields: decisionFields() },
      answer: { values: decisionValues() } },
  ];
  for (const { sessionId, payload, answer } of history) {
    checked({ ...brief(sessionId, 'done'), decisions: [payload] });
    const id = store.allocDecisionId({ ...payload, sessionId, source: 'brief', createdAt: decisionAt - 1000 });
    const result = applyBoardAnswer(store, { id, sessionId, ...answer }, decisionAt);
    if (!result.ok) throw new Error(`historical decision ${sessionId}: ${result.code}`);
    store.writeNew(`receipts/${String(id).padStart(6, '0')}.json`, {
      id, kind: 'text' in answer ? 'text' : 'values' in answer ? 'values' : 'option',
      mode: 'fixture', deliveredAt: decisionAt, proven: true,
    });
  }
  aliveIds.forEach((id, i) => {
    const at = NOW - 1000 - i;
    const todo = { items: [{ text: '확인', status: 'completed' }, { text: '진행', status: 'pending' }], total: 2, done: 1, more: 0 };
    add(id, at, i % 3 === 0 ? 'done' : 'in_progress', {
      tabId: `tab-${i}`, ...(i % 2 ? { running: true, pid: 20261022 } : { hostPid: 20261022 }),
      auto: { todoItems: todo, live: { workers: [{ id: `st_fixture${i}`, name: '시험 작업자', state: 'running',
        model: 'fixture', step: '검증', startedAt: at, updatedAt: at, todo }] } },
    });
    reports(id, at);
  });
  exemptIds.forEach((id) => {
    const at = id === 'boundary-exact' ? NOW - 2 * DAY : id === 'boundary-plus' ? NOW - 2 * DAY - 1 : NOW - 5 * DAY;
    add(id, at, blockedIds.includes(id) ? 'blocked' : 'done',
      id === 'plan-name' ? { workName: '시험 계획' } : id === 'plan-stage' ? { auto: { work: { phase: 'review' } } } : {});
    if (decisionIds.includes(id)) {
      const d = decision();
      checked({ ...brief(id, 'needs_decision'), decisions: [d] });
      const n = store.allocDecisionId({ ...d, sessionId: id, source: 'brief', createdAt: at });
      sourceDecisions[n] = { ...d, sessionId: id };
    }
    if (mirrorIds.includes(id)) store.replace(`mirror/${id}.json`, { open: true, question: '열린 질문?', at });
    reports(id, recentIds.includes(id) ? NOW - 3600_000 : at);
  });
  const planId = 'p202610220001';
  store.writePlanRev(planId, { schema: 'omo-plan/1', planId, at: NOW - 5 * DAY, ownerSessionId: 'plan-owner',
    source: { root: 'C:/fixture', slug: 'fixture', planPath: 'C:/fixture/.omo/plans/fixture.md' },
    plan: { stage: 'review', goal: '시험 계획', ideal: [], components: [], waves: [], tasks: [], questions: [], outOfScope: [] } });
  store.writePlanStatus(planId, { schema: 'omo-plan-status/1', planId, at: NOW - 5 * DAY,
    bySessionId: 'plan-owner', files: {}, boxes: {}, ledger: {}, work: { status: 'running', sessionIds: ['plan-carrier'] }, errors: [] });
  return { store, reportsById, sourceDecisions, options: renderOptions };
}

export function makeOverCapacity(dir) {
  const fixture = make(dir);
  // Open decisions prevent stage-B folding of the closed recent-report controls.
  for (const id of recentIds) fixture.store.allocDecisionId({ ...decision(), sessionId: id, source: 'brief', createdAt: NOW - DAY });
  for (const id of [...aliveIds, ...recentIds]) {
    // Each card fits by itself, but the twenty live cards do not: this leaves a visible retained suffix after P2.
    const blocks = escapedBlocks({ decision: 1 }); // Only table/KV are retained; neither carries a decision link.
    const list = fixture.reportsById[id].map((r) => ({ ...r, blocks: [{ ...blocks[0], rows: blocks[0].rows.slice(0, 8) }, blocks[2]] }));
    for (const { at: _, ...r } of list) checked({ ...brief(id, 'in_progress'), reports: [{ ...r, images: [] }] });
    fixture.store.replace(`sessions/${id}/reports.json`, list);
    fixture.reportsById[id] = list;
  }
  return fixture;
}

export function makeIrreducible(dir) {
  const fixture = make(dir);
  // Four schema-limited decisions per conversation; 100 added conversations suffice without oversized fields.
  for (let i = 0; i < 100; i++) {
    const id = `irreducible-${i}`;
    const input = checked({ ...brief(id, 'needs_decision'), decisions: Array.from({ length: 4 }, decision) });
    fixture.store.replace(`sessions/${id}/meta.json`, { sessionId: id, cwd: 'C:/fixture', lastActivityAt: NOW - DAY });
    fixture.store.writeNew(`sessions/${id}/briefs/000001.json`, { at: NOW - DAY, brief: input });
    for (const d of input.decisions) fixture.store.allocDecisionId({ ...d, sessionId: id, source: 'brief', createdAt: NOW - DAY });
  }
  return fixture;
}
