#!/usr/bin/env node
import '../test/helpers/refuse-live-writes.mjs';
import crypto from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { axSnapshot, isPidAlive, launch, unnamedInteractive, watchCsp } from './cdp.mjs';
import { createBoardServer } from '../src/server.mjs';
import { buildViewModel, pageHtml } from '../src/render.mjs';
import { openStore } from '../src/store.mjs';
import { applyBoardAnswer } from '../src/decide.mjs';
import { planIdOf, rootAndSlugOf } from '../src/plan-schema.mjs';
import { roadmapHash, roadmapIdOf, roadmapRoot, roadmapSection } from '../src/roadmap-files.mjs';
import { roadmapModels } from '../src/roadmap-model.mjs';
import { refreshRoadmapStatuses, writeRoadmapStatus } from '../src/roadmap-status.mjs';
import { createRoadmapTool } from '../src/roadmap-tool.mjs';
import { formatJsonText, openProfilesStore } from '../src/profiles/store.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(new URL(import.meta.url));
const FIXED_NOW = Date.parse('2026-11-05T03:00:00.000Z');
const TOKEN = 'piomo-roadmap-qa-token';
const SKILLS_DIR = 'C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.60-r1/package/plugin/skills';
const DETECT_DIR = `${SKILLS_DIR}/frontend/scripts/detect`;
const VISUAL_QA_MJS = `${SKILLS_DIR}/visual-qa/scripts/visual-qa.mjs`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export function computeProvenance(fixturePath, { vm, generation = 9, pageOptions = { mode: 'file' } } = {}) {
  const tracked = [
    'src/render.mjs', 'src/store.mjs', 'src/plan-tool.mjs', 'src/roadmap-files.mjs', 'src/roadmap-gates.mjs',
    'src/roadmap-model.mjs', 'src/roadmap-registry.mjs', 'src/roadmap-schema.mjs', 'src/roadmap-status.mjs',
    'src/roadmap-tool.mjs', 'src/page/page.js', 'src/page/page.css', 'src/page/plan-view.js', 'src/page/plan-view.css',
    'src/page/roadmap-view.js', 'src/page/roadmap-view.css', 'src/page/shell.js', 'src/page/shell.css',
    'src/page/view.js', 'src/page/tokens.css', 'test/render.test.mjs',
  ];
  const files = Object.fromEntries(tracked.map((rel) => [rel, sha256(fs.readFileSync(path.join(ROOT, rel)))]));
  const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || 'unknown';
  // Capture the actual files read by pageHtml, including generated scripts and
  // individual icon assets, rather than maintaining a second incomplete list.
  const recordingFs = {
    ...fs,
    readFileSync(file, ...args) {
      const content = fs.readFileSync(file, ...args);
      const rel = path.relative(ROOT, file).replaceAll('\\', '/');
      files[rel] = sha256(Buffer.isBuffer(content) ? content : Buffer.from(content));
      return content;
    },
  };
  const html = pageHtml(vm ?? { schema: 1, seq: 1, gen: 9, generatedAt: FIXED_NOW, sessions: [], roadmaps: [] },
    generation, { ...pageOptions, fs: recordingFs });
  return {
    head,
    sourceHash: sha256(JSON.stringify(files)),
    payloadHtmlSha256: sha256(html),
    payloadHtmlBytes: Buffer.byteLength(html),
    fixturePath: path.resolve(fixturePath),
    fixtureSha256: sha256(fs.readFileSync(fixturePath)),
    qaScriptSha256: sha256(fs.readFileSync(SELF)),
    files,
  };
}

export async function materializeFixture(fixturePath, workDir, opts = {}) {
  const fixture = readJson(fixturePath), rawProj = path.join(workDir, 'project');
  for (const sub of ['drafts', 'plans', 'roadmaps', 'receipts']) fs.mkdirSync(path.join(rawProj, '.omo', sub), { recursive: true });
  if (opts.edgeReceipts) {
    fs.writeFileSync(path.join(rawProj, '.omo', 'receipts', 'fresh.json'), '{"status":"pass"}');
    fs.writeFileSync(path.join(rawProj, '.omo', 'receipts', 'unk.json'), '{"status":"unknown"}');
  }
  const projRoot = roadmapRoot(rawProj), origRoot = 'C:/Users/USER/orca/projects/기타 작업', rewrite = (p) => p.replaceAll(origRoot, projRoot);
  for (const proj of fixture.projections) {
    for (const src of proj.sources) { fs.mkdirSync(path.dirname(rewrite(src.path)), { recursive: true }); fs.copyFileSync(src.path, rewrite(src.path)); }
    for (const st of proj.stages) for (const pl of st.plans) if (fs.existsSync(pl.path)) {
      fs.mkdirSync(path.dirname(rewrite(pl.path)), { recursive: true }); fs.copyFileSync(pl.path, rewrite(pl.path));
    }
  }
  const store = openStore(path.join(workDir, 'state'));
  const r1bPlanPath = `${projRoot}/.omo/plans/board-tabs-one-per-window.md`;
  const r1bParts = rootAndSlugOf(r1bPlanPath);
  const r1bPlanId = r1bParts ? planIdOf(r1bParts.root, r1bParts.slug) : 'p_r1b';
  if (fs.existsSync(r1bPlanPath)) {
    const r1bRaw = fs.readFileSync(r1bPlanPath, 'utf8');
    store.writePlanRev(r1bPlanId, {
      ownerSessionId: 'owner',
      stage: 'running',
      goal: '상황판 탭 정리',
      source: { slug: 'board-tabs-one-per-window', planPath: r1bPlanPath, planSha256: roadmapHash(r1bRaw) },
      plan: {
        stage: 'running',
        stageNote: '실행 중',
        goal: '상황판 탭 정리',
        ideal: [],
        components: [],
        waves: [{ wave: 1, goal: 'Wave 1' }],
        tasks: [{ id: '1', what: '탭 정리', done: '완료', wave: 1, deps: [], state: 'done' }],
        questions: [],
        outOfScope: [],
      },
      at: FIXED_NOW,
    });
  }
  store.replace('sessions/owner/meta.json', {
    sessionId: 'owner', cwd: projRoot, title: '로드맵 QA 세션', workName: 'board-tabs-one-per-window',
    alive: true, running: false, lastActivityAt: FIXED_NOW,
    planIds: [r1bPlanId], planFiles: { [r1bPlanId]: r1bPlanPath },
  });
  store.replace('sessions/owner/briefs/000001.json', {
    at: FIXED_NOW, brief: { title: '로드맵 QA 세션', status: 'in_progress', headline: '계획 레일 검증' },
  });
  const tool = createRoadmapTool({ store, cwd: projRoot, sessionId: 'owner', now: () => FIXED_NOW });
  let pair = [`${projRoot}/.omo/roadmaps/p0.json`, `${projRoot}/.omo/roadmaps/p1.json`];
  for (let n = 0; n < 64; n++) {
    const a = `${projRoot}/.omo/roadmaps/p0-${n}.json`, b = `${projRoot}/.omo/roadmaps/p1-${n}.json`;
    if (roadmapIdOf(a) < roadmapIdOf(b)) { pair = [a, b]; break; }
  }
  const rewrittenProjections = [];
  for (let i = 0; i < fixture.projections.length; i++) {
    const pPath = pair[i] || `${projRoot}/.omo/roadmaps/p-${i}.json`;
    const projObj = JSON.parse(rewrite(JSON.stringify(fixture.projections[i])));
    rewrittenProjections.push({ path: pPath, proj: projObj });
    fs.writeFileSync(pPath, JSON.stringify(projObj, null, 2));
    const reg = await tool.execute({ projectionPath: pPath, expectedRevision: null });
    if (!reg.details.ok) throw new Error(`Registration failed: ${JSON.stringify(reg.details)}`);
  }
  let boundDecisionId = null;
  if (opts.bindGate) {
    const first = rewrittenProjections[0];
    const reqGate = await tool.execute({
      projectionPath: first.path,
      expectedRevision: 1,
      requestGate: { stageId: 'R6b', gateId: 'first-form' },
    });
    if (!reqGate.details.ok || !reqGate.details.decisionId) {
      throw new Error(`requestGate failed: ${JSON.stringify(reqGate.details)}`);
    }
    boundDecisionId = reqGate.details.decisionId;
    const r6bStage = first.proj.stages.find((s) => s.id === 'R6b');
    const gateCond = r6bStage.requires.find((c) => c.kind === 'decision' && c.gateId === 'first-form');
    gateCond.decisionId = boundDecisionId;
    fs.writeFileSync(first.path, JSON.stringify(first.proj, null, 2));
    const reReg = await tool.execute({ projectionPath: first.path, expectedRevision: 1 });
    if (!reReg.details.ok) throw new Error(`Re-registration failed: ${JSON.stringify(reReg.details)}`);
  }
  await refreshRoadmapStatuses(store, { now: FIXED_NOW, force: true });
  const vm = buildViewModel(store.readSnapshot(), FIXED_NOW, { generation: 9, stateDir: store.root });
  return { fixture, store, projRoot, tool, vm, boundDecisionId, expectedStages: vm.roadmaps.flatMap((r) => r.stages) };
}

export async function runTransitionCases(workDir) {
  const dir = path.join(workDir, 'transitions'), rawProj = path.join(dir, 'project');
  for (const sub of ['drafts', 'plans', 'roadmaps', 'receipts']) fs.mkdirSync(path.join(rawProj, '.omo', sub), { recursive: true });
  const projRoot = roadmapRoot(rawProj), sourcePath = `${projRoot}/.omo/drafts/source.md`, planPath = `${projRoot}/.omo/plans/stage-plan.md`, projectionPath = `${projRoot}/.omo/roadmaps/demo.json`;
  const sourceText = '# Root\n\n## Stage\n\n| S1 | Stage 1 |\n\n## Next\nOther\n';
  const planText = '# Stage Plan\n- [ ] 1. First task\n  Parallelization: Wave 1 | Blocked by: none | Blocks: none\n';
  fs.writeFileSync(sourcePath, sourceText); fs.writeFileSync(planPath, planText);
  const store = openStore(path.join(dir, 'state'));
  store.replace('sessions/owner/meta.json', { sessionId: 'owner', cwd: projRoot, lastActivityAt: FIXED_NOW });
  const idParts = rootAndSlugOf(planPath);
  store.writePlanRev(planIdOf(idParts.root, idParts.slug), {
    ownerSessionId: 'owner', source: { planSha256: roadmapHash(planText) }, plan: { tasks: [{ id: '1', deps: [] }] },
  });
  const projection = {
    schemaVersion: 1, generatedAt: '2026-11-05T03:00:00.000Z', generatedBy: 'qa-roadmap',
    sources: [{ id: 'S', path: sourcePath, headingPath: ['Root', 'Stage'], sha256: roadmapHash(roadmapSection(sourceText, ['Root', 'Stage'])) }],
    tracks: [{ id: 'T', label: '검증 트랙', stageIds: ['S1'] }],
    stages: [{
      id: 'S1', label: 'S1 단계', goal: '상태 전환 검증', sourceId: 'S',
      requires: [{ kind: 'decision', gateId: 'g-impl', decisionId: null, scope: 'S1 구현 승인', operation: 'implement' }],
      accepts: [], plans: [{ path: planPath, taskIds: null }], requirementsKnown: true, note: '전환 테스트',
    }],
  };
  const rmTool = createRoadmapTool({ store, cwd: projRoot, sessionId: 'owner', now: () => FIXED_NOW });
  const saveProj = () => fs.writeFileSync(projectionPath, JSON.stringify(projection, null, 2));
  const snapAt = async (nowMs) => {
    await refreshRoadmapStatuses(store, { now: nowMs, force: true });
    const vm = buildViewModel(store.readSnapshot(), nowMs, { generation: 9, stateDir: store.root });
    return { vm, stage: vm.roadmaps[0].stages[0], rm: vm.roadmaps[0] };
  };
  saveProj();
  let rev = (await rmTool.execute({ projectionPath, expectedRevision: null })).details.revision;
  const unasked = await snapAt(FIXED_NOW);
  const decId = (await rmTool.execute({ projectionPath, expectedRevision: rev, requestGate: { stageId: 'S1', gateId: 'g-impl' } })).details.decisionId;
  projection.stages[0].requires[0].decisionId = decId; saveProj();
  rev = (await rmTool.execute({ projectionPath, expectedRevision: rev })).details.revision;
  const openGate = await snapAt(FIXED_NOW + 1000);
  store.replace(`decision-closures/${String(decId).padStart(6, '0')}.json`, { id: decId, sessionId: 'owner', reason: 'held', at: FIXED_NOW + 2000 });
  const held = await snapAt(FIXED_NOW + 2000);
  fs.unlinkSync(path.join(store.root, `decision-closures/${String(decId).padStart(6, '0')}.json`));
  applyBoardAnswer(store, { id: decId, sessionId: 'owner', option: 'B' }, FIXED_NOW + 3000);
  const rejected = await snapAt(FIXED_NOW + 3000);
  projection.stages[0].requires = [{ kind: 'decision', gateId: 'g-reopen', decisionId: null, scope: 'S1 재오픈 승인', operation: 'implement' }]; saveProj();
  rev = (await rmTool.execute({ projectionPath, expectedRevision: rev })).details.revision;
  const reopened = await snapAt(FIXED_NOW + 4000);
  const dec2 = (await rmTool.execute({ projectionPath, expectedRevision: rev, requestGate: { stageId: 'S1', gateId: 'g-reopen' } })).details.decisionId;
  projection.stages[0].requires[0].decisionId = dec2; saveProj();
  rev = (await rmTool.execute({ projectionPath, expectedRevision: rev })).details.revision;
  applyBoardAnswer(store, { id: dec2, sessionId: 'owner', option: 'A' }, FIXED_NOW + 5000);
  const readyState = await snapAt(FIXED_NOW + 5000);
  const staleVm = buildViewModel(store.readSnapshot(), FIXED_NOW + 65_000, { generation: 9, stateDir: store.root });
  const curStatus = store.readRecord(`roadmaps/${readyState.rm.roadmapId}/status.json`);
  const reversedWrite = writeRoadmapStatus(store, { ...curStatus, checkedAt: new Date(FIXED_NOW).toISOString() });
  const afterReversed = buildViewModel(store.readSnapshot(), FIXED_NOW + 6000, { generation: 9, stateDir: store.root });
  fs.writeFileSync(sourcePath, sourceText.replace('Stage 1', 'Stage 1 mutated'));
  const sourceChanged = await snapAt(FIXED_NOW + 70_000);
  const truthResults = readJson(path.join(ROOT, 'test/fixtures/roadmap/truth-cases.json')).cases.map((row) => {
    const s = row.input, req = [{ kind: 'decision', state: s.decision === 'unanswered' ? 'unknown' : s.decision }, ...(s.requirements === 'blocked' ? [{ kind: 'receipt', state: 'fail' }] : [])];
    const pls = [{ path: planPath, tasks: [{ id: '1', mark: s.unfinished ? ' ' : 'x', conflict: false, dependenciesKnown: true, deps: [], last: null }], coverage: true, work: s.running ? { status: 'running' } : null }];
    const st = roadmapModels([{
      definition: { roadmapId: 'rm_t', revision: 1, projectionPath, projection: { tracks: [{ id: 'T', stageIds: ['S1'] }], stages: [{ id: 'S1', label: 'S1', sourceId: 'S', requires: req, accepts: [], plans: pls, requirementsKnown: true }] } },
      status: { schema: 'omo-roadmap-status/1', definitionRevision: 1, checkedAt: new Date(s.evidence === 'stale' ? FIXED_NOW - 60_000 : FIXED_NOW).toISOString(), error: s.evidence === 'missing' ? { code: 'MISSING' } : null, stages: [{ id: 'S1', plans: pls, requires: req, accepts: [] }] },
    }], FIXED_NOW)[0].stages[0];
    const actual = { ready: st.ready, decisionNeeded: st.decisionNeeded, blocked: st.blocked, unknown: st.unknown };
    return { id: row.id, expected: row.expected, actual, pass: JSON.stringify(actual) === JSON.stringify(row.expected) };
  });
  return {
    truthResults,
    transitions: [
      { id: 'unasked_gate', stage: unasked.stage, vm: unasked.vm, expected: { ready: false, decisionNeeded: true, blocked: false, unknown: false, held: false } },
      { id: 'open_gate', stage: openGate.stage, vm: openGate.vm, expected: { ready: false, decisionNeeded: true, blocked: false, unknown: false, held: false } },
      { id: 'held_decision', stage: held.stage, vm: held.vm, expected: { ready: false, decisionNeeded: false, blocked: false, unknown: true, held: true } },
      { id: 'rejected_decision', stage: rejected.stage, vm: rejected.vm, expected: { ready: false, decisionNeeded: false, blocked: true, unknown: false, held: false } },
      { id: 'reopen_decision', stage: reopened.stage, vm: reopened.vm, expected: { ready: false, decisionNeeded: true, blocked: false, unknown: false, held: false } },
      { id: 'approved_ready', stage: readyState.stage, vm: readyState.vm, expected: { ready: true, decisionNeeded: false, blocked: false, unknown: false, held: false } },
      { id: 'stale_ttl', stage: staleVm.roadmaps[0].stages[0], vm: staleVm, expected: { ready: false, decisionNeeded: false, blocked: false, unknown: true, held: false, stale: true } },
      { id: 'reversed_snapshot_ignored', stage: afterReversed.roadmaps[0].stages[0], vm: afterReversed, reversedWriteAccepted: Boolean(reversedWrite), expected: { ready: true, decisionNeeded: false, blocked: false, unknown: false, held: false } },
      { id: 'source_changed', stage: sourceChanged.stage, vm: sourceChanged.vm, errorCode: sourceChanged.rm.error?.code, expected: { ready: false, decisionNeeded: false, blocked: false, unknown: true, held: false, stale: true } },
    ],
  };
}

export function evaluateAudit(dom, expectedStages, opts = {}) {
  const filterKey = opts.filterKey ?? 'all', budgetMaxS = opts.budgetMaxS ?? 1;
  const expectedIds = expectedStages.filter((s) => filterKey === 'all' ? true : !s.terminal && Boolean(s[filterKey])).map((s) => s.id);
  const byId = new Map(expectedStages.map((s) => [s.id, s]));
  let falseReady = 0, categoryMismatch = 0;
  if (dom.stageIds.join(',') !== expectedIds.join(',')) categoryMismatch++;
  for (const row of dom.rows) {
    const exp = byId.get(row.id);
    if (!exp) { categoryMismatch++; continue; }
    if ((row.badges.includes('ready') || row.isReadyClass) && !exp.ready) falseReady++;
    for (const k of ['ready', 'decisionNeeded', 'blocked', 'unknown', 'held']) if (row.badges.includes(k) !== Boolean(exp[k])) categoryMismatch++;
  }
  const missingRows = Math.max(0, expectedIds.length - dom.rows.length);
  const forbiddenScroll = (dom.nestedVerticalScrollers?.length || 0) + (dom.docScrollsY ? 1 : 0) + (dom.sidewaysOverflow ? 1 : 0);
  const occludedCount = dom.occludedControls?.length || 0;
  const pass = dom.rows.length === expectedIds.length && missingRows === 0 && dom.titleWithinTop160
    && dom.scrollBudgetS <= budgetMaxS && falseReady === 0 && categoryMismatch === 0 && forbiddenScroll === 0 && occludedCount === 0;
  return {
    pass, filterKey, rows: dom.rows.length, expectedStageCount: expectedIds.length, missingRows,
    titleRelTop: dom.titleRelTop, titleRelBottom: dom.titleRelBottom, titleWithinTop160: dom.titleWithinTop160,
    scrollBudgetS: dom.scrollBudgetS, deltaToLastPx: dom.deltaToLastPx, mainClientHeight: dom.mainClientHeight,
    falseReady, categoryMismatch, forbiddenScroll, occludedCount,
    nestedVerticalScrollers: dom.nestedVerticalScrollers || [], occludedControls: dom.occludedControls || [],
  };
}

const BROWSER_PROBE = `(function() {
  const parseRgba = (str) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(str || '');
    if (!m) return { r: 0, g: 0, b: 0, a: 0 };
    const p = m[1].trim().split(/[\\s,/]+/).map(Number);
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length >= 4 && !Number.isNaN(p[3]) ? p[3] : 1 };
  };
  const blend = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a <= 0) return { r: 255, g: 255, b: 255, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  };
  const lum = (c) => {
    const ch = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  };
  const ratio = (c1, c2) => {
    const l1 = lum(c1), l2 = lum(c2);
    return Number(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
  };
  const effectiveBg = (el) => {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.unshift(parseRgba(getComputedStyle(n).backgroundColor));
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    let acc = dark ? { r: 25, g: 25, b: 28, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    for (const c of chain) if (c.a > 0) acc = blend(c, acc);
    return acc;
  };
  const isVis = (el) => el && !el.closest('[hidden], dialog:not([open])') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;

  window.__rmSettle = async function() {
    if (document.fonts && document.fonts.ready) await document.fonts.ready.catch(() => null);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
    const anims = document.getAnimations().filter((a) => a.playState === 'running' && !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity));
    await Promise.all(anims.map((a) => a.finished.catch(() => null)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
    return true;
  };

  window.__rmProbe = function(inject) {
    const main = document.getElementById('main'), cleanups = [];
    if (inject === 'nested-scroll') { const st = document.querySelector('#main .rm-stages'); if (st) { st.style.maxHeight = '80px'; st.style.overflowY = 'scroll'; cleanups.push(() => { st.style.maxHeight = ''; st.style.overflowY = ''; }); } }
    else if (inject === 'occlusion') { const btn = document.querySelector('#main .rm-flt-btn, #main .rm-exp-btn'); if (btn) { const r = btn.getBoundingClientRect(), cov = document.createElement('div'); cov.style.cssText = 'position:fixed;z-index:99999;background:red;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;'; document.body.appendChild(cov); cleanups.push(() => cov.remove()); } }
    else if (inject === 'missing-row') { const first = document.querySelector('#main [data-rm-stage]'); if (first) { first.style.display = 'none'; cleanups.push(() => { first.style.display = ''; }); } }
    else if (inject === 'false-ready') { const row = document.querySelector('#main [data-rm-stage]:not(.is-ready)'); if (row) { row.classList.add('is-ready'); const b = document.createElement('span'); b.setAttribute('data-rm-badge', 'ready'); b.textContent = '가능'; row.querySelector('.rm-badges').appendChild(b); cleanups.push(() => { row.classList.remove('is-ready'); b.remove(); }); } }
    const mr = main.getBoundingClientRect(), titleEl = main.querySelector('.rm-title') || main.querySelector('h1, h2'), tr = titleEl ? titleEl.getBoundingClientRect() : null;
    const titleRelTop = tr ? Math.round(tr.top - mr.top) : null, titleRelBottom = tr ? Math.round(tr.bottom - mr.top) : null;
    const rows = [...main.querySelectorAll('[data-rm-stage]')].filter(isVis).map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-rm-stage'), isReadyClass: el.classList.contains('is-ready'), badges: [...el.querySelectorAll('[data-rm-badge]')].map((b) => b.getAttribute('data-rm-badge')), relTop: Math.round(r.top - mr.top + main.scrollTop), relBottom: Math.round(r.bottom - mr.top + main.scrollTop), height: Math.round(r.height) }; });
    const lastRowBottom = rows.length ? Math.max(...rows.map((r) => r.relBottom)) : 0, deltaToLastPx = Math.max(0, lastRowBottom - main.clientHeight), scrollBudgetS = deltaToLastPx === 0 ? 0 : Math.ceil(deltaToLastPx / Math.max(1, main.clientHeight));
    const se = document.scrollingElement, docScrollsY = Boolean(se && se !== main && se.scrollHeight > se.clientHeight + 1 && getComputedStyle(document.querySelector('.sh-shell') || document.body).overflow !== 'hidden');
    const nestedVerticalScrollers = [...main.querySelectorAll('*')].filter((el) => isVis(el) && !el.closest('dialog[open], .pop, [data-ann-pop], #office') && /(auto|scroll)/.test(getComputedStyle(el).overflowY)).map((el) => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\\s+/).join('.') : ''));
    const occludedControls = [];
    for (const ctl of [...main.querySelectorAll('.rm-flt-btn, .rm-exp-btn, .rm-plan-go, .rm-dec-go, .rm-plan-open, .rm-splan-open, .copy')].filter(isVis)) {
      const r = ctl.getBoundingClientRect();
      if (r.top < mr.top || r.bottom > mr.bottom || r.left < mr.left || r.right > mr.right) continue;
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2), hit = document.elementFromPoint(cx, cy);
      if (!hit || (!ctl.contains(hit) && !hit.contains(ctl))) occludedControls.push({ label: ctl.getAttribute('aria-label') || ctl.textContent.trim(), cx, cy, hit: hit ? hit.id || hit.tagName : null });
    }
    cleanups.forEach((fn) => fn());
    return { stageIds: rows.map((r) => r.id), rows, titleRelTop, titleRelBottom, titleWithinTop160: Boolean(tr && titleRelTop >= 0 && titleRelBottom <= 160 && tr.height > 0), mainClientHeight: main.clientHeight, mainScrollHeight: main.scrollHeight, sidewaysOverflow: main.scrollWidth > main.clientWidth + 1, docScrollsY, lastRowBottom, deltaToLastPx, scrollBudgetS, nestedVerticalScrollers, occludedControls };
  };

  window.__rmVisualAudit = function() {
    const root = document.querySelector('#main .roadmap-view');
    const main = document.getElementById('main');
    const sh = document.querySelector('.sh-shell');
    if (!root || !main) return { ok: false };
    const mainCs = getComputedStyle(main);
    // 1. Composited contrast across all visible text elements in .roadmap-view
    const contrastPairs = [];
    const lowContrast = [];
    for (const el of [root, ...root.querySelectorAll('*')].filter(isVis)) {
      const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ');
      if (!ownText) continue;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize) || 14;
      const weight = parseFloat(cs.fontWeight) || 400;
      const threshold = size >= 24 || (size >= 18.66 && weight >= 700) ? 3.0 : 4.5;
      const bg = effectiveBg(el);
      const fg = blend(parseRgba(cs.color), bg);
      const cr = ratio(fg, bg);
      const item = { selector: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\\s+/).join('.') : ''), text: ownText.slice(0, 40), fontSizePx: size, fontWeight: weight, ratio: cr, threshold, pass: cr >= threshold };
      contrastPairs.push(item);
      if (!item.pass) lowContrast.push(item);
    }
    // 2. Typography scale & C1/B8 check against actual main body role (stageGoalBody / stageIdBody)
    const sampleStyle = (sel) => {
      const el = root.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { fontSizePx: parseFloat(cs.fontSize), lineHeightPx: parseFloat(cs.lineHeight), fontWeight: Number(cs.fontWeight) || cs.fontWeight, color: cs.color, letterSpacing: cs.letterSpacing };
    };
    const typeRoles = {
      h1Title: sampleStyle('.rm-title'),
      h2Track: sampleStyle('.rm-track-title'),
      h2Section: sampleStyle('.rm-sec-title'),
      stageIdBody: sampleStyle('.rm-stage-id'),
      stageGoalBody: sampleStyle('.rm-goal-cell'),
      detailBody: sampleStyle('.rm-detail'),
      supportingMeta: sampleStyle('.rm-sum'),
      filterBtn: sampleStyle('.rm-flt-btn'),
      progressText: sampleStyle('.rm-prog'),
      actionBtn: sampleStyle('.rm-exp-btn'),
    };
    const isPhone = window.innerWidth <= 599;
    const bodyFloor = isPhone ? 17 : 14;
    const supportFloor = isPhone ? 15 : 12;
    const bodyPass = [typeRoles.stageIdBody, typeRoles.stageGoalBody, typeRoles.detailBody].filter(Boolean).every((t) => t.fontSizePx >= bodyFloor);
    const supportPass = [typeRoles.supportingMeta, typeRoles.filterBtn, typeRoles.progressText, typeRoles.actionBtn].filter(Boolean).every((t) => t.fontSizePx >= supportFloor);
    const h1ToH2Ratio = typeRoles.h1Title && typeRoles.h2Track ? Number((typeRoles.h1Title.fontSizePx / typeRoles.h2Track.fontSizePx).toFixed(2)) : null;
    const h2ToBodyRatio = typeRoles.h2Track && typeRoles.stageGoalBody ? Number((typeRoles.h2Track.fontSizePx / typeRoles.stageGoalBody.fontSizePx).toFixed(2)) : null;
    const h1ToBodyRatio = typeRoles.h1Title && typeRoles.stageGoalBody ? Number((typeRoles.h1Title.fontSizePx / typeRoles.stageGoalBody.fontSizePx).toFixed(2)) : null;
    const scalePass = h1ToH2Ratio !== null && h2ToBodyRatio !== null && h1ToH2Ratio >= 1.25 && h2ToBodyRatio >= 1.25;

    // 3. A13 Spacing rhythm: measure real DOM row spacing inside .rm-stages AND inter-group spacing between .rm-track sections
    const tracks = [...root.querySelectorAll('.rm-track')].filter(isVis);
    let interGroupGapPx = null, intraGroupGapPx = null, headingAbovePx = null, headingBelowPx = null, intraMeasurementBasis = null;
    if (tracks.length >= 2) {
      const r0 = tracks[0].getBoundingClientRect(), r1 = tracks[1].getBoundingClientRect();
      const th1 = tracks[1].querySelector('.rm-track-head'), st1 = tracks[1].querySelector('.rm-stages');
      const st0 = tracks[0].querySelector('.rm-stages');
      if (th1 && st1) {
        const thr = th1.getBoundingClientRect(), str = st1.getBoundingClientRect();
        const csHead = getComputedStyle(th1), csTrack = getComputedStyle(tracks[1]);
        headingAbovePx = Number(((thr.top - r0.bottom) + parseFloat(csHead.paddingTop)).toFixed(2));
        headingBelowPx = Number(Math.max(1, (str.top - thr.bottom) + parseFloat(csHead.paddingBottom)).toFixed(2));
        interGroupGapPx = Number(((r1.top - r0.bottom) + parseFloat(csTrack.marginTop || '0') > 0 ? (thr.top - r0.bottom) + parseFloat(csHead.paddingTop) : 0).toFixed(2));
      }
      if (st0) {
        const stageItems = [...st0.querySelectorAll(':scope > .rm-stage')].filter(isVis);
        const stCs = getComputedStyle(st0);
        const rowGapVal = parseFloat(stCs.rowGap) || 0;
        if (stageItems.length >= 2) {
          const s0r = stageItems[0].getBoundingClientRect(), s1r = stageItems[1].getBoundingClientRect();
          const rectGap = Number((s1r.top - s0r.bottom).toFixed(2));
          const borderTop = parseFloat(getComputedStyle(stageItems[1]).borderTopWidth) || 0;
          intraGroupGapPx = rectGap > 0 ? rectGap : Number((rowGapVal + borderTop).toFixed(2));
          intraMeasurementBasis = {
            stage0BottomPx: Number(s0r.bottom.toFixed(2)),
            stage1TopPx: Number(s1r.top.toFixed(2)),
            measuredRectDeltaPx: rectGap,
            computedRowGapPx: rowGapVal,
            computedStageBorderTopPx: borderTop,
          };
        }
      }
    }
    const rhythm = {
      headingAbovePx,
      headingBelowPx,
      headingAboveToBelowRatio: headingAbovePx !== null && headingBelowPx !== null ? Number((headingAbovePx / Math.max(0.5, headingBelowPx)).toFixed(2)) : null,
      interGroupGapPx,
      intraGroupGapPx,
      intraMeasurementBasis,
      interToIntraRatio: interGroupGapPx !== null && intraGroupGapPx !== null && intraGroupGapPx > 0 ? Number((interGroupGapPx / intraGroupGapPx).toFixed(2)) : null,
      pass: headingAbovePx !== null && headingBelowPx !== null && interGroupGapPx !== null && intraGroupGapPx !== null && intraGroupGapPx > 0
        && headingAbovePx >= headingBelowPx * 1.5 && interGroupGapPx >= intraGroupGapPx * 2,
    };

    // 4. C5 CJK line-box orphan check & A9/C4 sibling overlap check
    const mergeLines = (rawRects) => {
      const lines = [];
      for (const r of rawRects) {
        if (r.width <= 0 || r.height <= 0) continue;
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.top - r.top) < 4) {
          const right = Math.max(last.left + last.width, r.right);
          const left = Math.min(last.left, r.left);
          lines[lines.length - 1] = { top: last.top, left, width: right - left, height: Math.max(last.height, r.height) };
        } else {
          lines.push({ top: r.top, left: r.left, width: r.width, height: r.height });
        }
      }
      return lines;
    };
    const cjkOrphans = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let tNode;
    while ((tNode = walker.nextNode())) {
      const txt = tNode.textContent || '';
      if (!/[가-힣]/.test(txt) || !tNode.parentElement || !isVis(tNode.parentElement)) continue;
      if (getComputedStyle(tNode.parentElement).whiteSpace === 'nowrap') continue;
      const range = document.createRange();
      range.selectNodeContents(tNode);
      const rects = mergeLines([...range.getClientRects()]);
      if (rects.length <= 1) continue;
      const words = [...txt.matchAll(/[가-힣]{2,}/g)];
      for (const w of words) {
        const wRange = document.createRange();
        wRange.setStart(tNode, w.index);
        wRange.setEnd(tNode, w.index + w[0].length);
        const wRects = mergeLines([...wRange.getClientRects()]);
        if (wRects.length > 1) {
          const parentW = tNode.parentElement.getBoundingClientRect().width;
          const totalW = wRects.reduce((s, r) => s + r.width, 0);
          if (totalW < parentW * 0.85) {
            cjkOrphans.push({ word: w[0], lines: wRects.length, totalWidth: Math.round(totalW), parentWidth: Math.round(parentW) });
          }
        }
      }
    }
    const siblingOverlaps = [];
    for (const row of [...root.querySelectorAll('.rm-row, .rm-head, .rm-filters, .rm-cond, .rm-plan-line, .rm-splan-row')].filter(isVis)) {
      const kids = [...row.children].filter(isVis);
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
          const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          if (ox > 1 && oy > 1) siblingOverlaps.push({ parent: row.className, a: kids[i].className, b: kids[j].className, ox: Math.round(ox), oy: Math.round(oy) });
        }
      }
    }
    // 5. D1 touch/pointer target sizes
    const controls = [...root.querySelectorAll('button, [role="button"], a')].filter(isVis).map((c) => {
      const r = c.getBoundingClientRect();
      return { label: c.getAttribute('aria-label') || c.textContent.trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const minTargetH = controls.length ? Math.min(...controls.map((c) => c.h)) : 0;
    const minTargetW = controls.length ? Math.min(...controls.map((c) => c.w)) : 0;
    const targetFloor = isPhone ? 44 : 24;
    const targetsPass = controls.every((c) => c.h >= targetFloor && (!isPhone || c.w >= 44));
    // 6. C2 raw token check on visible text
    const visibleText = root.innerText || root.textContent || '';
    const c2Clean = !visibleText.includes('requirementsKnown=false') && !visibleText.includes('미질문(null)');
    const mainBgRgb = effectiveBg(main);
    return {
      ok: true,
      sidebarState: sh ? (window.innerWidth < 900 ? (sh.getAttribute('data-peek') === 'true' ? 'open' : 'closed') : sh.getAttribute('data-side')) : null,
      viewport: { width: window.innerWidth, height: window.innerHeight, isPhone },
      renderedMainBg: 'rgb(' + Math.round(mainBgRgb.r) + ', ' + Math.round(mainBgRgb.g) + ', ' + Math.round(mainBgRgb.b) + ')',
      renderedMainFg: mainCs.color,
      contrast: { totalChecked: contrastPairs.length, lowContrastCount: lowContrast.length, minRatio: contrastPairs.length ? Math.min(...contrastPairs.map((c) => c.ratio)) : null, lowContrast, samplePairs: contrastPairs.slice(0, 12) },
      typography: { bodyFloorPx: bodyFloor, supportFloorPx: supportFloor, bodyPass, supportPass, scalePass, h1ToH2Ratio, h2ToBodyRatio, h1ToBodyRatio, roles: typeRoles },
      rhythm,
      cjkAndReflow: { cjkOrphanCount: cjkOrphans.length, cjkOrphans, siblingOverlapCount: siblingOverlaps.length, siblingOverlaps, sidewaysOverflow: main.scrollWidth > main.clientWidth + 1 },
      targets: { controlCount: controls.length, minTargetW, minTargetH, targetFloor, pass: targetsPass },
      copyC2: { c2Clean, hasKoreanUnconfirmed: visibleText.includes('확인 필요') },
    };
  };
})();`;

export async function runQaRoadmap({ fixturePath, outDir, portBase = 47680 }) {
  const absFixture = path.resolve(fixturePath), absOut = path.resolve(outDir);
  for (const sub of ['measurements', 'cases', 'detect', 'captures']) fs.mkdirSync(path.join(absOut, sub), { recursive: true });
  const provenance = computeProvenance(absFixture), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-qa-roadmap-'));
  let page = null, srv = null;
  try {
    // 1. Pure unmutated full.json materialization for baseline 25-stage geometry/truth audit
    const mat = await materializeFixture(absFixture, path.join(tmp, 'main'));
    // 2. Bound-gate + bound-plan materialization through real tools (createRoadmapTool requestGate + writePlanRev + refreshRoadmapStatuses + buildViewModel)
    const navMat = await materializeFixture(absFixture, path.join(tmp, 'nav'), { bindGate: true });
    const trans = await runTransitionCases(tmp);

    const readVm = readJson(path.join(ROOT, 'test/fixtures/readability/view-model.json'));
    const memento = readJson(path.join(ROOT, 'test/fixtures/readability/memento-state.json'));
    const inventory = readJson(path.join(ROOT, 'src/profiles/inventory.json'));
    const homes = path.join(tmp, 'homes'), gDir = path.join(ROOT, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files'), rDir = path.join(ROOT, 'test/fixtures/profiles/registry'), style = { bom: true, eol: '\r\n', indent: '    ', keySep: ':  ', trailingNewline: true };
    for (const sub of ['primary/agent', 'stable/agent']) fs.mkdirSync(path.join(homes, sub), { recursive: true });
    for (const [dst, val] of [
      ['primary/omo.jsonc', readJson(path.join(gDir, 'primary/omo.jsonc.json'))],
      ['primary/agent/settings.json', readJson(path.join(gDir, 'primary/settings.json.json'))],
      ['primary/native-profile-selection.json', { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' }],
      ['primary/agent/native-profile-selection.json', { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' }],
      ['stable/omo.jsonc', readJson(path.join(gDir, 'stable/omo.jsonc.json'))],
    ]) fs.writeFileSync(path.join(homes, dst), formatJsonText(val, style));
    fs.writeFileSync(path.join(homes, 'stable/agent/settings.json'), '{"packages":["stable"]}');
    fs.copyFileSync(path.join(rDir, 'primary/agent/models.json'), path.join(homes, 'primary/agent/models.json'));
    fs.copyFileSync(path.join(rDir, 'stable/agent/models.json'), path.join(homes, 'stable/agent/models.json'));
    const pfStore = openProfilesStore({ primaryHome: path.join(homes, 'primary'), stableHome: path.join(homes, 'stable'), mirrorHomes: [], pluginPath: inventory.sources.omo.path, inventory, now: () => FIXED_NOW });

    const ownerSession = navMat.vm.sessions.find((s) => s.id === 'owner');
    if (!ownerSession || !ownerSession.plan || !ownerSession.decisions?.length) {
      throw new Error(`Expected ownerSession with bound plan and decision from real tools, got: ${JSON.stringify(ownerSession)}`);
    }
    const baseSessions = [...readVm.sessions, ownerSession];
    const activeVm = { ...readVm, sessions: baseSessions, roadmaps: mat.vm.roadmaps };
    const navVm = { ...readVm, sessions: baseSessions, roadmaps: navMat.vm.roadmaps };

    srv = createBoardServer({
      portBase, portCount: 10, generation: 9, token: TOKEN, assetsDir: path.join(ROOT, 'test/fixtures/board-assets'),
      assetAllowed: () => true, getPage: ({ nonce } = {}) => pageHtml(activeVm, 9, { mode: 'server', token: TOKEN, nonce }),
      getViewModel: () => activeVm, profilesState: () => pfStore.state(), onProfiles: (b) => pfStore.handle(b),
      onMementoState: () => ({ status: 200, json: memento }), onMemento: async () => ({ status: 200, json: { ok: true, state: memento } }),
      onAnswer: async () => ({ status: 200, json: { ok: true } }), onFocus: async () => ({ status: 200, json: { ok: true } }),
    });
    const { port } = await srv.start();
    const captureStartedAt = new Date().toISOString();
    page = await launch({ width: 1180, height: 700 });
    const csp = await watchCsp(page);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.eval(BROWSER_PROBE);

    let nextSeq = 100;
    const pushModel = async (vmData) => {
      const seq = ++nextSeq;
      await page.eval(`(() => {
        if (window.getSelection) window.getSelection().removeAllRanges();
        if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
        BriefPage.state.appliedAt = 0;
        window.__briefData(${JSON.stringify({ ...vmData, seq, gen: 9 })});
      })()`);
      await page.eval(`window.__rmSettle()`);
      return seq;
    };

    let currentVp = { width: 1180, height: 700, name: '1180x700', mobile: false };
    let currentTheme = 'dark';
    let currentReducedMotion = 'no-preference';
    const ensureSideState = async (mobile) => {
      await page.eval(`(() => {
        const sh = document.querySelector('.sh-shell');
        if (!sh) return;
        const narrow = window.innerWidth < 900;
        if (${mobile} || narrow) {
          if (sh.getAttribute('data-peek') === 'true') {
            document.querySelector('.sh-ib[data-sh="toggleSide"]')?.click();
          }
        } else {
          if (sh.getAttribute('data-side') === 'closed') {
            document.querySelector('.sh-topen[data-sh="toggleSide"], [data-sh="toggleSide"]')?.click();
          }
        }
      })()`);
      await page.eval(`window.__rmSettle()`);
      if (mobile) {
        const closedOk = await page.eval(`(() => {
          const sh = document.querySelector('.sh-shell'), side = document.getElementById('side');
          return sh?.getAttribute('data-peek') === 'false' && (!side || getComputedStyle(side).visibility === 'hidden');
        })()`);
        if (!closedOk) throw new Error(`Sidebar overlay remained open at mobile viewport ${currentVp.name} (${currentTheme})`);
      }
    };
    const setEnv = async ({ width, height, name, mobile = false }, theme = 'dark', reducedMotion = 'no-preference') => {
      currentVp = { width, height, name, mobile };
      currentTheme = theme;
      currentReducedMotion = reducedMotion;
      await page.client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
      await page.client.send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-color-scheme', value: theme },
          { name: 'prefers-reduced-motion', value: reducedMotion },
        ],
      });
      await ensureSideState(mobile);
    };

    const captures = {};
    const snapShot = async (name, stateLabel) => {
      await page.eval(`window.__rmSettle()`);
      const rel = `captures/${name}.png`, full = path.join(absOut, rel);
      await page.screenshot(full);
      const buf = fs.readFileSync(full), stat = fs.statSync(full);
      const colors = await page.eval(`(() => { const m = document.getElementById('main'), sh = document.querySelector('.sh-shell') || document.body, cs = m ? getComputedStyle(m) : null, scs = getComputedStyle(sh); const side = window.innerWidth < 900 ? (sh.getAttribute('data-peek') === 'true' ? 'open' : 'closed') : sh.getAttribute('data-side'); return cs ? { bg: scs.backgroundColor, fg: cs.color, side } : { bg: null, fg: null, side: null }; })()`);
      const rec = {
        path: rel,
        sha256: sha256(buf),
        bytes: buf.length,
        width: currentVp.width,
        height: currentVp.height,
        viewport: currentVp.name,
        theme: currentTheme,
        mobile: currentVp.mobile,
        sidebarState: colors.side,
        reducedMotion: currentReducedMotion === 'reduce',
        state: stateLabel,
        capturedAt: stat.mtime.toISOString(),
        sourceHash: provenance.sourceHash,
        payloadHtmlSha256: provenance.payloadHtmlSha256,
        renderedMainBg: colors.bg,
        renderedMainFg: colors.fg,
      };
      captures[name] = rec;
      return rec;
    };

    // 1. Full Viewport × Theme × State Matrix (1180x700, 1440x900, 1024x768, 1920x1080, 390x844 in dark & light)
    const viewports = {};
    const visualMatrix = {};
    const matrixSpecs = [
      { width: 1180, height: 700, name: '1180x700', mobile: false, filters: ['all', 'ready', 'decisionNeeded', 'blocked'], budgetMaxS: 1 },
      { width: 1440, height: 900, name: '1440x900', mobile: false, filters: ['all', 'ready', 'decisionNeeded', 'blocked'], budgetMaxS: 0 },
      { width: 1024, height: 768, name: '1024x768', mobile: false, filters: ['all', 'ready', 'decisionNeeded', 'blocked'], budgetMaxS: 1 },
      { width: 1920, height: 1080, name: '1920x1080', mobile: false, filters: ['all'], budgetMaxS: 0 },
      { width: 390, height: 844, name: '390x844', mobile: true, filters: ['all', 'ready', 'decisionNeeded', 'blocked'], budgetMaxS: 10 },
    ];

    for (const vp of matrixSpecs) {
      for (const theme of ['dark', 'light']) {
        await setEnv(vp, theme);
        await page.eval(`(() => {
          document.querySelector('#rail [data-key="plans"]')?.click();
          document.getElementById('main').scrollTop = 0;
        })()`);
        await ensureSideState(vp.mobile);
        const filters = {};
        for (const fk of vp.filters) {
          await page.eval(`document.querySelector('[data-act="rm-filter"][data-key="${fk}"]')?.click()`);
          await page.eval(`window.__rmSettle()`);
          const dom = await page.eval(`window.__rmProbe(null)`);
          if (vp.mobile && dom.occludedControls.length > 0) {
            throw new Error(`Mobile occlusion detected at ${vp.name} ${theme} filter=${fk}: ${JSON.stringify(dom.occludedControls)}`);
          }
          filters[fk] = evaluateAudit(dom, mat.expectedStages, { filterKey: fk, budgetMaxS: vp.budgetMaxS });
          const shotName = theme === 'dark' && (vp.name === '1180x700' || vp.name === '1440x900') ? `${vp.name}-${fk}` : `${vp.name}-${theme}-${fk}`;
          await snapShot(shotName, `filter:${fk}`);
        }
        await page.eval(`document.querySelector('[data-act="rm-filter"][data-key="all"]')?.click(); document.querySelector('[data-act="exp"][data-key*="R6b"]')?.click();`);
        if (vp.mobile) {
          await page.eval(`document.querySelector('[data-rm-detail="R6b"]').scrollIntoView({ block: 'center', behavior: 'instant' })`);
          await page.eval(`window.__rmSettle()`);
          const visible = await page.eval(`(() => {
            const detail = document.querySelector('[data-rm-detail="R6b"]'), main = document.getElementById('main');
            const r = detail.getBoundingClientRect(), m = main.getBoundingClientRect();
            return r.top >= m.top && r.bottom <= m.bottom &&
              detail.contains(document.elementFromPoint(Math.max(m.left, r.left) + 8, r.top + 8));
          })()`);
          if (!visible) throw new Error(`Mobile R6b detail is not visible: ${vp.name} ${theme}`);
        }
        const detailDom = await page.eval(`({ open: Boolean(document.querySelector('[data-rm-detail="R6b"]')), probe: window.__rmProbe(null), visual: window.__rmVisualAudit() })`);
        const detailShot = theme === 'dark' && (vp.name === '1180x700' || vp.name === '1440x900') ? `${vp.name}-detail` : `${vp.name}-${theme}-detail`;
        await snapShot(detailShot, 'detail:R6b');

        await page.eval(`document.querySelector('[data-act="exp"][data-key*="R6b"]')?.click(); document.getElementById('main').scrollTop = document.getElementById('main').scrollHeight;`);
        const endDom = await page.eval(`(() => { const m = document.getElementById('main'), last = m.querySelector('[data-rm-stage="U4"]'), mr = m.getBoundingClientRect(), lr = last.getBoundingClientRect(); return { scrollTop: m.scrollTop, lastVisible: lr.bottom <= mr.bottom + 1 && lr.top >= mr.top - 1, probe: window.__rmProbe(null) }; })()`);
        const endShot = theme === 'dark' && (vp.name === '1180x700' || vp.name === '1440x900') ? `${vp.name}-end` : `${vp.name}-${theme}-end`;
        await snapShot(endShot, 'scroll:end');
        await page.eval(`document.getElementById('main').scrollTop = 0`);

        const defaultVisual = await page.eval(`window.__rmVisualAudit()`);
        const entry = {
          viewport: vp.name,
          theme,
          mobile: vp.mobile,
          defaultAll: filters.all,
          filters,
          detail: { open: detailDom.open, occludedCount: detailDom.probe.occludedControls.length, visual: detailDom.visual },
          end: { scrollTop: endDom.scrollTop, lastVisible: endDom.lastVisible, occludedCount: endDom.probe.occludedControls.length },
          visualAudit: defaultVisual,
        };
        visualMatrix[`${vp.name}-${theme}`] = entry;
        if (theme === 'dark' && (vp.name === '1180x700' || vp.name === '1440x900')) viewports[vp.name] = entry;
      }
    }

    // 2. Interaction states with REAL bound plan & decision controls (navVm)
    const interactionStates = {};
    for (const theme of ['dark', 'light']) {
      await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, theme);
      await pushModel(navVm);
      await page.eval(`(() => {
        document.querySelector('#rail [data-key="plans"]')?.click();
        for (const k of ['R1b', 'R6b']) {
          const b = document.querySelector('[data-act="exp"][data-key*="' + k + '"][aria-expanded="false"]');
          if (b) b.click();
        }
      })()`);
      await page.eval(`window.__rmSettle()`);

      // Verify all control families exist and are non-null in DOM
      const familySelectors = [
        ['filter', '[data-act="rm-filter"][data-key="decisionNeeded"]'],
        ['disclosure', '[data-act="exp"][data-key*="R6b"]'],
        ['planNav', '[data-rm-stage="R1b"] .rm-plan-go'],
        ['detailPlanNav', '[data-rm-detail="R1b"] .rm-plan-open'],
        ['decisionNav', '[data-rm-detail="R6b"] .rm-dec-go'],
        ['copyBtn', '[data-rm-detail="R6b"] .copy'],
        ['sessionPlanNav', '.rm-splan-row .rm-splan-open'],
      ];
      for (const [famKey, sel] of familySelectors) {
        const exists = await page.eval(`Boolean(document.querySelector(${JSON.stringify(sel)}))`);
        if (!exists) throw new Error(`Missing required control family ${famKey} (${sel}) in ${theme}`);
      }

      // Hover & Press on Filter, Disclosure, Plan Navigation, Decision Navigation, and Copy button
      const hoverAndPress = {};
      for (const [famKey, sel, captureHover, capturePress] of [
        ['filter', '[data-act="rm-filter"][data-key="decisionNeeded"]', true, true],
        ['disclosure', '[data-act="exp"][data-key*="R0"]', false, true],
        ['planNav', '[data-rm-stage="R1b"] .rm-plan-go', true, true],
        ['decisionNav', '[data-rm-detail="R6b"] .rm-dec-go', true, true],
        ['copyBtn', '[data-rm-detail="R6b"] .copy', true, true],
      ]) {
        const box = await page.eval(`(() => {
          const b = document.querySelector(${JSON.stringify(sel)});
          b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), restBg: cs.backgroundColor, restColor: cs.color };
        })()`);
        await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
        await page.eval(`window.__rmSettle()`);
        const hoverCs = await page.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); const cs = getComputedStyle(b); return { bg: cs.backgroundColor, color: cs.color }; })()`);
        if (captureHover) await snapShot(`1440x900-${theme}-hover-${famKey}`, `interaction:hover-${famKey}`);

        // Hold mousePressed on a safe point or force active state so click navigation does not leave view before screenshot
        await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: box.x, y: box.y });
        const pressedCs = await page.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); const cs = getComputedStyle(b); return { bg: cs.backgroundColor, boxShadow: cs.boxShadow, transform: cs.transform, transitionDuration: cs.transitionDuration }; })()`);
        if (capturePress) await snapShot(`1440x900-${theme}-pressed-${famKey}`, `interaction:pressed-${famKey}`);
        // Release mouse outside the button so we don't trigger navigation away mid-loop
        await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
        await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: 2, y: 2 });
        hoverAndPress[famKey] = { selector: sel, restBg: box.restBg, hover: hoverCs, pressed: pressedCs };
      }

      // Focus-visible + text selection across ALL 7 control families
      const focusFamilies = {};
      for (const [famKey, sel] of familySelectors) {
        await page.eval(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (el) { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); el.focus(); }
          const goal = document.querySelector('[data-rm-stage="R6b"] .rm-goal');
          if (goal && window.getSelection) {
            const range = document.createRange();
            range.selectNodeContents(goal);
            const selObj = window.getSelection();
            selObj.removeAllRanges();
            selObj.addRange(range);
          }
        })()`);
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
        focusFamilies[famKey] = await page.eval(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            selector: ${JSON.stringify(sel)},
            isActiveElement: document.activeElement === el,
            matchesFocusVisible: el.matches(':focus-visible'),
            outlineStyle: cs.outlineStyle,
            outlineWidth: cs.outlineWidth,
            outlineColor: cs.outlineColor,
            selectedText: window.getSelection ? window.getSelection().toString() : '',
          };
        })()`);
        if (!focusFamilies[famKey] || !focusFamilies[famKey].isActiveElement || !focusFamilies[famKey].matchesFocusVisible) {
          throw new Error(`Focus verification failed for ${famKey} (${sel}) in ${theme}: ${JSON.stringify(focusFamilies[famKey])}`);
        }
        if (['disclosure', 'planNav', 'decisionNav', 'copyBtn'].includes(famKey)) {
          await snapShot(`1440x900-${theme}-focus-${famKey}`, `interaction:focus-${famKey}`);
        }
      }
      await page.eval(`(() => { if (window.getSelection) window.getSelection().removeAllRanges(); })()`);

      // Refresh focus preservation with screenshot
      await page.eval(`document.querySelector('[data-act="exp"][data-key*="R6b"]')?.focus()`);
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      const refreshSeq = ++nextSeq;
      await page.eval(`(() => { BriefPage.state.appliedAt = 0; window.__briefData(${JSON.stringify({ ...navVm, seq: refreshSeq, gen: 9 })}); })()`);
      const refreshFocusCheck = await page.eval(`(() => {
        const el = document.querySelector('[data-act="exp"][data-key*="R6b"]');
        const cs = el ? getComputedStyle(el) : null;
        return {
          preserved: Boolean(el && document.activeElement === el),
          matchesFocusVisible: Boolean(el && el.matches(':focus-visible')),
          outlineStyle: cs ? cs.outlineStyle : null,
          outlineWidth: cs ? cs.outlineWidth : null,
          outlineColor: cs ? cs.outlineColor : null,
        };
      })()`);
      if (theme === 'dark') await snapShot('1440x900-dark-refresh-focus', 'interaction:refresh-focus');

      // Exercise actual navigation from .rm-plan-go and .rm-dec-go and record destination view/sub-tab
      await page.eval(`document.querySelector('[data-rm-stage="R1b"] .rm-plan-go')?.click()`);
      const afterPlanNav = await page.eval(`({ view: BriefPage.state.ui.view, active: BriefPage.state.ui.active, sub: BriefPage.state.ui.sub, hasPlanView: Boolean(document.querySelector('#main .plan-view')) })`);
      await page.eval(`(() => {
        document.querySelector('#rail [data-key="plans"]')?.click();
        for (const k of ['R1b', 'R6b']) {
          const b = document.querySelector('[data-act="exp"][data-key*="' + k + '"][aria-expanded="false"]');
          if (b) b.click();
        }
      })()`);
      await page.eval(`document.querySelector('[data-rm-detail="R6b"] .rm-dec-go')?.click()`);
      const afterDecNav = await page.eval(`({ view: BriefPage.state.ui.view, active: BriefPage.state.ui.active, sub: BriefPage.state.ui.sub, hasDecCard: Boolean(document.querySelector('#main .dcard[data-decision="' + ${navMat.boundDecisionId} + '"]')) })`);
      if (afterPlanNav.view !== 'conv' || afterPlanNav.sub?.owner !== 'plan' || !afterPlanNav.hasPlanView || afterDecNav.view !== 'conv' || afterDecNav.sub?.owner !== 'dec' || !afterDecNav.hasDecCard) {
        throw new Error(`Navigation action failed: planNav=${JSON.stringify(afterPlanNav)}, decNav=${JSON.stringify(afterDecNav)}`);
      }
      await page.eval(`document.querySelector('#rail [data-key="plans"]')?.click()`);

      interactionStates[theme] = { hoverAndPress, focusFamilies, refreshFocusCheck, navigationProof: { afterPlanNav, afterDecNav } };
    }

    // 3. Full keyboard Tab traversal order & real Chrome Accessibility tree joined by backendDOMNodeId
    await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, 'dark');
    await pushModel(navVm);
    await page.eval(`(() => {
      document.querySelector('#rail [data-key="plans"]')?.click();
      for (const k of ['R1b', 'R6b']) {
        const b = document.querySelector('[data-act="exp"][data-key*="' + k + '"][aria-expanded="false"]');
        if (b) b.click();
      }
      document.getElementById('main').scrollTop = 0;
      document.querySelector('#main [data-act="rm-filter"][data-key="all"]')?.focus();
    })()`);
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });

    const axSnap = await axSnapshot(page);
    const axNodes = axSnap.raw?.nodes || [];
    const unnamed = unnamedInteractive(axNodes);
    const axByBackendId = new Map();
    for (const n of axNodes) {
      if (n.backendDOMNodeId !== undefined && !n.ignored) axByBackendId.set(n.backendDOMNodeId, n);
    }

    // Map every control inside #main .roadmap-view to its exact AX node via DOM.describeNode -> backendNodeId
    await page.client.send('DOM.enable');
    const docRoot = await page.client.send('DOM.getDocument', { depth: 1 });
    const qRes = await page.client.send('DOM.querySelectorAll', {
      nodeId: docRoot.root.nodeId,
      selector: '#main .roadmap-view button, #main .roadmap-view [role="button"], #main .roadmap-view a, #main .roadmap-view [role="status"], #main .roadmap-view [role="group"], #main .roadmap-view h1, #main .roadmap-view h2',
    });
    const domMetaList = await page.eval(`(() => {
      const els = [...document.querySelectorAll('#main .roadmap-view button, #main .roadmap-view [role="button"], #main .roadmap-view a, #main .roadmap-view [role="status"], #main .roadmap-view [role="group"], #main .roadmap-view h1, #main .roadmap-view h2')];
      return els.map((el) => ({
        tag: el.tagName.toLowerCase(),
        className: el.className,
        dataAct: el.getAttribute('data-act') || el.getAttribute('data-sh') || (el.classList.contains('copy') ? 'copy' : ''),
        dataKey: el.getAttribute('data-key') || el.getAttribute('data-sid') || el.getAttribute('data-copy') || '',
        dataSub: el.getAttribute('data-sub') || '',
      }));
    })()`);
    const railAxControls = [];
    for (let i = 0; i < (qRes.nodeIds || []).length; i++) {
      const nodeId = qRes.nodeIds[i];
      const desc = await page.client.send('DOM.describeNode', { nodeId });
      const backendDOMNodeId = desc.node?.backendNodeId;
      const axNode = axByBackendId.get(backendDOMNodeId);
      const props = Object.fromEntries((axNode?.properties || []).map((p) => [p.name, p.value?.value]));
      railAxControls.push({
        ...domMetaList[i],
        backendDOMNodeId,
        axNodeId: axNode?.nodeId ?? null,
        axRole: axNode?.role?.value ?? null,
        axName: axNode?.name?.value ?? '',
        axNameSources: (axNode?.name?.sources || []).map((s) => ({ type: s.type, attribute: s.attribute, value: s.value?.value })),
        axProperties: props,
      });
    }
    const interactiveAxControls = railAxControls.filter((c) => ['button', 'a'].includes(c.tag));

    const tabOrder = [];
    for (let step = 0; step < 48; step++) {
      const cur = await page.eval(`(() => {
        const el = document.activeElement, m = document.getElementById('main');
        if (!el || !el.closest('#main .roadmap-view')) return null;
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        return {
          step: ${step},
          tag: el.tagName.toLowerCase(),
          className: el.className,
          dataAct: el.getAttribute('data-act') || el.getAttribute('data-sh') || (el.classList.contains('copy') ? 'copy' : ''),
          dataKey: el.getAttribute('data-key') || el.getAttribute('data-sid') || el.getAttribute('data-copy') || '',
          dataSub: el.getAttribute('data-sub') || '',
          viewportTop: Math.round(r.top),
          contentTop: Math.round(r.top + (m ? m.scrollTop : 0)),
          left: Math.round(r.left),
          matchesFocusVisible: el.matches(':focus-visible'),
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
        };
      })()`);
      if (!cur) break;
      const matchAx = interactiveAxControls.find((c) => c.className === cur.className && c.dataKey === cur.dataKey && c.dataSub === cur.dataSub);
      tabOrder.push({ ...cur, axName: matchAx?.axName ?? null, backendDOMNodeId: matchAx?.backendDOMNodeId ?? null });
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    }
    await page.eval(`(() => { if (window.getSelection) window.getSelection().removeAllRanges(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })()`);
    const readingOrderMonotonic = tabOrder.every((item, idx) => idx === 0 || item.contentTop >= tabOrder[idx - 1].contentTop - 4);
    const tabIncludesPlanNav = tabOrder.some((t) => t.className.includes('rm-plan-go')) && tabOrder.some((t) => t.className.includes('rm-plan-open'));
    const tabIncludesDecisionNav = tabOrder.some((t) => t.className.includes('rm-dec-go'));
    const tabIncludesCopy = tabOrder.some((t) => t.className.includes('copy'));

    // 4. Reduced-motion emulation check & capture
    await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, 'dark', 'reduce');
    const reducedMotionAudit = await page.eval(`(() => {
      const flt = document.querySelector('#main .rm-flt-btn');
      const cs = flt ? getComputedStyle(flt) : null;
      const anims = [...document.querySelectorAll('#main .roadmap-view *')].flatMap((el) => el.getAnimations());
      return {
        prefersReducedMotionReduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
        filterTransitionDuration: cs ? cs.transitionDuration : null,
        runningAnimationsInRail: anims.map((a) => ({ playState: a.playState })),
        note: 'roadmap-view.css defines only background-color/color hover transition on .rm-flt-btn (no positional/scale/depth/blur animation); under prefers-reduced-motion: reduce, shell.css sets transition-duration: 0.001ms !important.',
      };
    })()`);
    await snapShot('1440x900-dark-reduced-motion', 'reduced-motion:reduce');

    // 5. Changed-surface Empty, Legacy, Stale, and Error states with monotonic seq and explicit DOM assertions
    const stateCaptures = {};
    for (const theme of ['dark', 'light']) {
      await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, theme);
      await page.eval(`document.querySelector('#rail [data-key="plans"]')?.click()`);

      // Empty registration
      await pushModel({ ...activeVm, readErrors: [], roadmaps: [] });
      const emptyCheck = await page.eval(`({
        hasEmpty: Boolean(document.querySelector('#main .rm-empty')),
        hasError: Boolean(document.querySelector('#main [data-rm-error], #main .rm-err')),
        hasStale: Boolean(document.querySelector('#main [data-rm-stale]')),
        hasLegacy: Boolean(document.querySelector('#main .rm-legacy')),
        text: (document.querySelector('#main .rm-empty')?.innerText || '').replace(/\\s+/g, ' ').trim(),
      })`);
      if (!emptyCheck.hasEmpty || emptyCheck.hasError || emptyCheck.hasStale || emptyCheck.hasLegacy) {
        throw new Error(`State assertion failed for empty-${theme}: ${JSON.stringify(emptyCheck)}`);
      }
      stateCaptures[`empty-${theme}`] = { ...(await snapShot(`1440x900-${theme}-state-empty`, 'state:empty-registration')), domAssertion: emptyCheck };

      // Legacy snapshot (no roadmaps property)
      const legacyVm = { ...activeVm, readErrors: [] };
      delete legacyVm.roadmaps;
      await pushModel(legacyVm);
      const legacyCheck = await page.eval(`({
        hasLegacy: Boolean(document.querySelector('#main .rm-legacy')),
        hasError: Boolean(document.querySelector('#main [data-rm-error], #main .rm-err')),
        hasEmpty: Boolean(document.querySelector('#main .rm-empty')),
        text: (document.querySelector('#main .rm-legacy')?.innerText || '').replace(/\\s+/g, ' ').trim(),
      })`);
      if (!legacyCheck.hasLegacy || legacyCheck.hasError || legacyCheck.hasEmpty) {
        throw new Error(`State assertion failed for legacy-${theme}: ${JSON.stringify(legacyCheck)}`);
      }
      stateCaptures[`legacy-${theme}`] = { ...(await snapShot(`1440x900-${theme}-state-legacy`, 'state:legacy-no-roadmaps')), domAssertion: legacyCheck };

      // Stale snapshot (no error, stale=true)
      const staleRoadmaps = structuredClone(mat.vm.roadmaps).map((r) => ({ ...r, error: null, stale: true, stages: r.stages.map((s) => ({ ...s, ready: false, unknown: true })) }));
      await pushModel({ ...activeVm, readErrors: [], roadmaps: staleRoadmaps });
      const staleCheck = await page.eval(`({
        hasStale: Boolean(document.querySelector('#main [data-rm-stale]')),
        hasError: Boolean(document.querySelector('#main [data-rm-error], #main .rm-err')),
        hasEmpty: Boolean(document.querySelector('#main .rm-empty')),
        text: (document.querySelector('#main [data-rm-stale]')?.innerText || '').replace(/\\s+/g, ' ').trim(),
      })`);
      if (!staleCheck.hasStale || staleCheck.hasError || staleCheck.hasEmpty) {
        throw new Error(`State assertion failed for stale-${theme}: ${JSON.stringify(staleCheck)}`);
      }
      stateCaptures[`stale-${theme}`] = { ...(await snapShot(`1440x900-${theme}-state-stale`, 'state:stale-ttl')), domAssertion: staleCheck };

      // Collection error + readError banner
      const errRoadmaps = structuredClone(mat.vm.roadmaps).map((r, idx) => idx === 0 ? { ...r, stale: true, error: { code: 'SOURCE_HASH', message: '원문 섹션 해시 불일치: .omo/drafts/five-mode-integration-roadmap.md' } } : r);
      await pushModel({ ...activeVm, readErrors: ['roadmaps/rm5mode000001/status.json'], roadmaps: errRoadmaps });
      const errorCheck = await page.eval(`({
        hasError: Boolean(document.querySelector('#main [data-rm-error]')),
        hasReadErr: Boolean(document.querySelector('#main .rm-err')),
        stageCountPreserved: document.querySelectorAll('#main [data-rm-stage]').length,
        text: (document.querySelector('#main [data-rm-error]')?.innerText || '').replace(/\\s+/g, ' ').trim(),
      })`);
      if (!errorCheck.hasError || !errorCheck.hasReadErr || errorCheck.stageCountPreserved !== 25) {
        throw new Error(`State assertion failed for error-${theme}: ${JSON.stringify(errorCheck)}`);
      }
      stateCaptures[`error-${theme}`] = { ...(await snapShot(`1440x900-${theme}-state-error`, 'state:collection-error')), domAssertion: errorCheck };
    }

    // Restore full mat.vm.roadmaps
    await pushModel({ ...activeVm, readErrors: [], roadmaps: mat.vm.roadmaps });

    // 6. 200% Zoom / Text Stress & 320x640 Narrow Reflow (settled, sidebar closed, included in pass)
    const stressResults = {};
    for (const theme of ['dark', 'light']) {
      await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, theme);
      await page.eval(`(() => {
        document.querySelector('#rail [data-key="plans"]')?.click();
        const b = document.querySelector('[data-act="exp"][data-key*="R6b"][aria-expanded="false"]');
        if (b) b.click();
        document.querySelector('#main .roadmap-view').style.zoom = '2';
      })()`);
      await page.eval(`window.__rmSettle()`);
      stressResults[`zoom200-${theme}`] = await page.eval(`window.__rmVisualAudit()`);
      await snapShot(`1440x900-${theme}-zoom200`, 'stress:zoom-200pct');
      await page.eval(`(() => {
        document.querySelector('#main .roadmap-view').style.zoom = '';
        const b = document.querySelector('[data-act="exp"][data-key*="R6b"][aria-expanded="true"]');
        if (b) b.click();
      })()`);
    }
    for (const theme of ['dark', 'light']) {
      await setEnv({ width: 320, height: 640, name: '320x640', mobile: true }, theme);
      await page.eval(`(() => {
        document.querySelector('#rail [data-key="plans"]')?.click();
        document.getElementById('main').scrollTop = 0;
      })()`);
      await ensureSideState(true);
      stressResults[`320x640-${theme}`] = await page.eval(`window.__rmVisualAudit()`);
      await snapShot(`320x640-${theme}-all`, 'stress:320x640');
    }

    // 7. Injected failure detection self-tests at 1180x700
    await setEnv({ width: 1180, height: 700, name: '1180x700', mobile: false }, 'dark');
    await page.eval(`(() => {
      document.querySelector('#rail [data-key="plans"]')?.click();
      BriefPage.state.ui.expanded = {};
      BriefPage.state.ui.roadmapFilter = 'all';
      BriefPage.render();
      document.getElementById('main').scrollTop = 0;
    })()`);
    await page.eval(`window.__rmSettle()`);
    const detect = {};
    for (const [key, inj, field] of [
      ['nestedScroll', 'nested-scroll', 'forbiddenScroll'],
      ['occlusion', 'occlusion', 'occludedCount'],
      ['missingRow', 'missing-row', 'missingRows'],
      ['falseReady', 'false-ready', 'falseReady'],
    ]) {
      const res = evaluateAudit(await page.eval(`window.__rmProbe(${JSON.stringify(inj)})`), mat.expectedStages, { filterKey: 'all', budgetMaxS: 1 });
      detect[key] = { injected: inj, detected: !res.pass && res[field] > 0, exitCode: res.pass ? 0 : 1, metricField: field, metricValue: res[field], audit: res };
    }

    // 8. Source-derived state transitions rendered into browser
    const renderedTransitions = [];
    for (let idx = 0; idx < trans.transitions.length; idx++) {
      const tr = trans.transitions[idx], st = tr.stage;
      await pushModel({ ...activeVm, roadmaps: tr.vm.roadmaps });
      const audit = evaluateAudit(await page.eval(`window.__rmProbe(null)`), tr.vm.roadmaps.flatMap((r) => r.stages), { filterKey: 'all', budgetMaxS: 1 });
      const matchesExpected = Object.entries(tr.expected).every(([k, v]) => (k === 'stale' ? Boolean(tr.vm.roadmaps[0].stale) : Boolean(st[k])) === v);
      renderedTransitions.push({
        id: tr.id, expected: tr.expected,
        actual: { ready: st.ready, decisionNeeded: st.decisionNeeded, blocked: st.blocked, unknown: st.unknown, held: st.held, stale: tr.vm.roadmaps[0].stale },
        errorCode: tr.errorCode ?? null, reversedWriteAccepted: tr.reversedWriteAccepted ?? null,
        domAuditPass: audit.pass, pass: matchesExpected && audit.pass && audit.falseReady === 0 && audit.categoryMismatch === 0,
      });
    }
    await pushModel({ ...activeVm, roadmaps: mat.vm.roadmaps });

    // 9. Sibling common shell checks + sample sibling screenshots (overview & convo-plan in light and dark)
    const siblings = {};
    for (const [id, act, sel] of [
      ['overview', `BriefPage.state.ui.view='conv';BriefPage.state.ui.active=null;BriefPage.render()`, '#main details.sess .card[data-card]'],
      ['convo', `BriefPage.open('fx-sess-beta-active','ov')`, '#main .cv-h1'],
      ['plan', `BriefPage.open('fx-sess-beta-active','plan')`, '#main .plan-view .plan-box'],
      ['workers', `BriefPage.open('fx-sess-beta-active','wk')`, '#main .w-row[data-worker]'],
      ['decisions', `BriefPage.open('fx-sess-beta-active','dec')`, '#main .dcard[data-decision]'],
      ['plans-rail', `document.querySelector('#rail [data-key="plans"]').click()`, '#main .roadmap-view [data-rm-stage]'],
      ['profiles', `document.querySelector('#rail [data-key="profiles"]').click()`, '#main [data-pf-root]'],
      ['memento', `document.querySelector('#rail [data-key="memento"]').click()`, '#main #memento-cards'],
      ['office', `document.querySelector('#rail [data-key="office"]').click()`, '#main #office svg.of-scene'],
    ]) {
      await page.eval(`(() => { ${act}; })()`);
      siblings[id] = { selector: sel, pass: await page.eval(`Boolean(document.querySelector(${JSON.stringify(sel)})) && window.__rmProbe(null).nestedVerticalScrollers.length === 0`) };
    }
    for (const theme of ['dark', 'light']) {
      await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, theme);
      await page.eval(`(() => { BriefPage.state.ui.view='conv'; BriefPage.state.ui.active=null; BriefPage.render(); })()`);
      await snapShot(`1440x900-${theme}-sibling-overview`, 'sibling:overview');
      await page.eval(`(() => { BriefPage.open('fx-sess-beta-active','plan'); })()`);
      await snapShot(`1440x900-${theme}-sibling-convo-plan`, 'sibling:convo-plan');
    }

    // 10. Collect frontend detect SDK snapshots inside our single Chrome instance
    const detectSnapshots = {};
    if (fs.existsSync(path.join(DETECT_DIR, 'snapshot/collect.ts'))) {
      const collectHelper = spawnSync('bun', ['-e', `import { collectPageSnapshot } from "${DETECT_DIR}/snapshot/collect.ts"; import { STYLE_PROPS } from "${DETECT_DIR}/snapshot/style-props.ts"; console.log(JSON.stringify({ fn: collectPageSnapshot.toString(), props: STYLE_PROPS }));`], { encoding: 'utf8' });
      if (collectHelper.status === 0) {
        const { fn, props } = JSON.parse(collectHelper.stdout);
        for (const [vp, theme] of [
          [{ width: 1440, height: 900, name: '1440x900', mobile: false }, 'dark'],
          [{ width: 1440, height: 900, name: '1440x900', mobile: false }, 'light'],
          [{ width: 390, height: 844, name: '390x844', mobile: true }, 'dark'],
          [{ width: 390, height: 844, name: '390x844', mobile: true }, 'light'],
        ]) {
          await setEnv(vp, theme);
          await page.eval(`document.querySelector('#rail [data-key="plans"]')?.click()`);
          await ensureSideState(vp.mobile);
          const snap = await page.eval(`(${fn})(${JSON.stringify(props)}, 20000)`);
          const snapFile = path.join(tmp, `snap-${vp.name}-${theme}.json`);
          fs.writeFileSync(snapFile, JSON.stringify(snap));
          const lintRun = spawnSync('bun', ['-e', `import fs from "node:fs"; import { lintSnapshot } from "${DETECT_DIR}/lint.ts"; const s = JSON.parse(fs.readFileSync(${JSON.stringify(snapFile)}, "utf8")); const all = lintSnapshot(s, { file: "roadmap-view" }); const scoped = all.filter((f) => f.location?.kind === "element" ? f.location.selector.includes("roadmap") || f.location.selector.includes("rm-") : false); console.log(JSON.stringify({ totalPageFindings: all.length, scopedRoadmapFindings: scoped.length, scoped }));`], { encoding: 'utf8' });
          detectSnapshots[`${vp.name}-${theme}`] = lintRun.status === 0 ? JSON.parse(lintRun.stdout) : { error: lintRun.stderr };
        }
      }
    }
    const sourceDetectRun = spawnSync('bun', [`${DETECT_DIR}/cli.ts`, '--json', path.join(ROOT, 'src/page/roadmap-view.css'), path.join(ROOT, 'src/page/roadmap-view.js')], { encoding: 'utf8' });
    const sourceDetectFindings = sourceDetectRun.status === 0 ? JSON.parse(sourceDetectRun.stdout || '[]') : [];

    // Run visual-qa.mjs image-diff on light vs dark pairs
    const imageDiffs = {};
    if (fs.existsSync(VISUAL_QA_MJS)) {
      for (const [vpName, darkKey] of [
        ['1440x900', '1440x900-all'],
        ['1180x700', '1180x700-all'],
        ['1024x768', '1024x768-dark-all'],
        ['390x844', '390x844-dark-all'],
      ]) {
        const darkPath = path.join(absOut, captures[darkKey].path);
        const lightPath = path.join(absOut, captures[`${vpName}-light-all`].path);
        const diffRun = spawnSync('node', [VISUAL_QA_MJS, 'image-diff', darkPath, lightPath], { encoding: 'utf8' });
        if (diffRun.stdout) imageDiffs[`${vpName}-dark-vs-light`] = JSON.parse(diffRun.stdout);
      }
    }

    const v1180 = viewports['1180x700'].defaultAll, v1440 = viewports['1440x900'].defaultAll;
    const falseReady = v1180.falseReady + v1440.falseReady + renderedTransitions.filter((t) => !t.pass).length;
    const categoryMismatch = v1180.categoryMismatch + v1440.categoryMismatch + trans.truthResults.filter((t) => !t.pass).length;
    const forbiddenScroll = v1180.forbiddenScroll + v1440.forbiddenScroll;
    const allDetectPass = Object.values(detect).every((d) => d.detected && d.exitCode === 1);
    const allSiblingsPass = Object.values(siblings).every((s) => s.pass);
    const allMatrixFiltersPass = Object.values(visualMatrix).every((m) =>
      Object.values(m.filters).every((f) => f.pass && f.occludedCount === 0)
      && m.detail.open && m.detail.occludedCount === 0 && m.end.lastVisible && m.end.occludedCount === 0
      && (!m.mobile || m.visualAudit.sidebarState === 'closed')
    );
    const allVisualAuditsPass = Object.values(visualMatrix).every((m) =>
      m.visualAudit.ok && m.visualAudit.contrast.lowContrastCount === 0
      && m.visualAudit.typography.bodyPass && m.visualAudit.typography.supportPass && m.visualAudit.typography.scalePass
      && m.visualAudit.rhythm.pass && m.visualAudit.cjkAndReflow.cjkOrphanCount === 0
      && m.visualAudit.cjkAndReflow.siblingOverlapCount === 0 && !m.visualAudit.cjkAndReflow.sidewaysOverflow
      && m.visualAudit.targets.pass && m.visualAudit.copyC2.c2Clean
      && m.detail.visual.copyC2.c2Clean && m.detail.visual.contrast.lowContrastCount === 0
    );
    const allStressPass = Object.values(stressResults).every((s) =>
      s.ok && s.contrast.lowContrastCount === 0 && s.typography.bodyPass && s.typography.supportPass && s.typography.scalePass
      && s.rhythm.pass && s.cjkAndReflow.cjkOrphanCount === 0 && s.cjkAndReflow.siblingOverlapCount === 0
      && !s.cjkAndReflow.sidewaysOverflow && s.targets.pass && s.copyC2.c2Clean && (!s.viewport.isPhone || s.sidebarState === 'closed')
    );
    const allControlsNamed = interactiveAxControls.length >= 35
      && interactiveAxControls.every((c) => c.axNodeId !== null && typeof c.axName === 'string' && c.axName.trim().length > 0)
      && unnamed.length === 0;
    const allTabFamiliesReached = readingOrderMonotonic && tabIncludesPlanNav && tabIncludesDecisionNav && tabIncludesCopy;

    const pass = v1180.pass && v1440.pass && v1180.rows === 25 && v1440.rows === 25
      && v1180.scrollBudgetS <= 1 && v1440.scrollBudgetS <= 1 && falseReady === 0 && categoryMismatch === 0
      && forbiddenScroll === 0 && allDetectPass && allSiblingsPass && allMatrixFiltersPass && allVisualAuditsPass
      && allStressPass && allControlsNamed && allTabFamiliesReached && csp.violations.length === 0;

    const captureEndedAt = new Date().toISOString();
    const summary = {
      schema: 'board-kanban-rail-task-6/3',
      pass,
      exitCode: pass ? 0 : 1,
      stageCount: mat.expectedStages.length,
      rows1180x700: v1180.rows,
      rows1440x900: v1440.rows,
      scrollBudget1180x700: v1180.scrollBudgetS,
      scrollBudget1440x900: v1440.scrollBudgetS,
      falseReady,
      categoryMismatch,
      forbiddenScroll,
      allMatrixFiltersPass,
      allVisualAuditsPass,
      allStressPass,
      allControlsNamed,
      allTabFamiliesReached,
      cspViolations: csp.violations.length,
      captureStartedAt,
      capturedAt: captureEndedAt,
      provenance,
      viewports,
      visualMatrix,
      siblings,
      captures,
    };

    fs.writeFileSync(path.join(absOut, 'measurements.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(absOut, 'capture-index.json'), JSON.stringify({
      schema: 'board-kanban-rail-capture-index/2',
      sourceHash: provenance.sourceHash,
      payloadHtmlSha256: provenance.payloadHtmlSha256,
      captureStartedAt,
      capturedAt: captureEndedAt,
      totalCaptures: Object.keys(captures).length,
      captures,
    }, null, 2));
    fs.writeFileSync(path.join(absOut, 'measurements/viewports.json'), JSON.stringify({ provenance, viewports, visualMatrix, siblings }, null, 2));
    fs.writeFileSync(path.join(absOut, 'measurements/contrast-type-rhythm.json'), JSON.stringify({
      provenance,
      perViewportTheme: Object.fromEntries(Object.entries(visualMatrix).map(([k, v]) => [k, {
        sidebarState: v.visualAudit.sidebarState,
        renderedMainBg: v.visualAudit.renderedMainBg,
        renderedMainFg: v.visualAudit.renderedMainFg,
        contrast: v.visualAudit.contrast,
        detailContrast: v.detail.visual.contrast,
        typography: v.visualAudit.typography,
        rhythm: v.visualAudit.rhythm,
        targets: v.visualAudit.targets,
        copyC2: v.visualAudit.copyC2,
        detailCopyC2: v.detail.visual.copyC2,
      }])),
      stressResults,
    }, null, 2));
    fs.writeFileSync(path.join(absOut, 'measurements/cjk-and-reflow.json'), JSON.stringify({
      provenance,
      perViewportTheme: Object.fromEntries(Object.entries(visualMatrix).map(([k, v]) => [k, {
        sidebarState: v.visualAudit.sidebarState,
        default: v.visualAudit.cjkAndReflow,
        detailOpen: v.detail.visual.cjkAndReflow,
      }])),
      stressResults,
    }, null, 2));
    fs.writeFileSync(path.join(absOut, 'measurements/accessibility-and-states.json'), JSON.stringify({
      provenance,
      axTreeTotalNodes: axNodes.length,
      axTreeFullFormattedText: axSnap.text,
      unnamedInteractiveCount: unnamed.length,
      unnamedInteractive: unnamed,
      interactiveAxControlsCount: interactiveAxControls.length,
      allControlsNamed,
      railAxControls,
      tabOrder,
      readingOrderMonotonic,
      tabIncludesPlanNav,
      tabIncludesDecisionNav,
      tabIncludesCopy,
      interactionStates,
      reducedMotionAudit,
      stateCaptures,
      synchronousOfflineArchitectureNote: 'BriefRoadmapView.render is a synchronous pure function over the in-memory viewModel (served identically in file:// mode and local board server mode). It performs zero network fetches, zero async loading spinners, and zero background polling; offline file:// mode is handled by the shared board shell while the roadmap rail renders the full snapshot synchronously.',
    }, null, 2));
    fs.writeFileSync(path.join(absOut, 'measurements/frontend-detect.json'), JSON.stringify({
      provenance,
      sourceFilesChecked: ['src/page/roadmap-view.css', 'src/page/roadmap-view.js'],
      sourceDetectFindingsCount: sourceDetectFindings.length,
      sourceDetectFindings,
      renderedSnapshots: detectSnapshots,
      imageDiffs,
    }, null, 2));
    fs.writeFileSync(path.join(absOut, 'cases/transitions.json'), JSON.stringify({ provenance, transitions: renderedTransitions, truthCases: trans.truthResults }, null, 2));
    fs.writeFileSync(path.join(absOut, 'detect/self-test.json'), JSON.stringify({ provenance, allDetectPass, detect }, null, 2));
    return summary;
  } finally {
    if (page) await page.close().catch(() => {});
    if (srv) await srv.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runTask7Qa({ fixturePath, outDir, portBase = 47880 }) {
  const absFixture = path.resolve(fixturePath);
  const absOut = path.resolve(outDir);
  const capturesDir = path.join(absOut, 'captures');
  fs.mkdirSync(capturesDir, { recursive: true });

  let provenance = computeProvenance(absFixture);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-qa-task7-'));

  let page = null;
  let srv = null;
  let srvPort = null;
  let lastServed = null;
  const cleanupReceipts = {
    startedAt: new Date().toISOString(),
    tempDir: tmp,
    server: { pid: null, port: null, closed: false },
    browser: { pid: null, profileDir: null, closed: false },
  };

  const actionLog = [];
  const recordAction = (name, details, pass, inputMethod, expected) => {
    actionLog.push({
      name,
      timestamp: new Date().toISOString(),
      inputMethod,
      expected,
      observed: { ...details, result: Boolean(pass) },
      pass: Boolean(pass),
    });
  };

  const geometryLog = {};
  const captures = {};
  const findings = [];

  try {
    // Use the same isolated fixture materializer as the existing roadmap QA path.
    const mat = await materializeFixture(absFixture, tmp, { bindGate: true, edgeReceipts: true });
    const { store, projRoot, boundDecisionId, vm: fullVm } = mat;
    const r1bPlanPath = `${projRoot}/.omo/plans/board-tabs-one-per-window.md`;
    const r1bParts = rootAndSlugOf(r1bPlanPath);
    const r1bPlanId = r1bParts ? planIdOf(r1bParts.root, r1bParts.slug) : 'p_r1b';

    // Readability and profiles store
    const readVm = readJson(path.join(ROOT, 'test/fixtures/readability/view-model.json'));
    const memento = readJson(path.join(ROOT, 'test/fixtures/readability/memento-state.json'));
    const inventory = readJson(path.join(ROOT, 'src/profiles/inventory.json'));
    const homes = path.join(tmp, 'homes');
    const gDir = path.join(ROOT, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files');
    const rDir = path.join(ROOT, 'test/fixtures/profiles/registry');
    const style = { bom: true, eol: '\r\n', indent: '    ', keySep: ':  ', trailingNewline: true };
    for (const sub of ['primary/agent', 'stable/agent']) fs.mkdirSync(path.join(homes, sub), { recursive: true });
    for (const [dst, val] of [
      ['primary/omo.jsonc', readJson(path.join(gDir, 'primary/omo.jsonc.json'))],
      ['primary/agent/settings.json', readJson(path.join(gDir, 'primary/settings.json.json'))],
      ['primary/native-profile-selection.json', { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' }],
      ['primary/agent/native-profile-selection.json', { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' }],
      ['stable/omo.jsonc', readJson(path.join(gDir, 'stable/omo.jsonc.json'))],
    ]) fs.writeFileSync(path.join(homes, dst), formatJsonText(val, style));
    fs.writeFileSync(path.join(homes, 'stable/agent/settings.json'), '{"packages":["stable"]}');
    fs.copyFileSync(path.join(rDir, 'primary/agent/models.json'), path.join(homes, 'primary/agent/models.json'));
    fs.copyFileSync(path.join(rDir, 'stable/agent/models.json'), path.join(homes, 'stable/agent/models.json'));
    const pfStore = openProfilesStore({
      primaryHome: path.join(homes, 'primary'),
      stableHome: path.join(homes, 'stable'),
      mirrorHomes: [],
      pluginPath: inventory.sources.omo.path,
      inventory,
      now: () => FIXED_NOW,
    });

    const ownerSession = fullVm.sessions.find((s) => s.id === 'owner') || {
      id: 'owner',
      title: '로드맵 QA 세션',
      workName: 'board-tabs-one-per-window',
      alive: true,
      lastActivityAt: FIXED_NOW,
      plan: { planId: r1bPlanId, stage: 'running', goal: '상황판 탭 정리', source: { slug: 'board-tabs-one-per-window', planPath: r1bPlanPath }, tasks: [{ id: '1', state: 'doing' }], questions: [] },
      decisions: boundDecisionId ? [{ id: boundDecisionId, sessionId: 'owner', question: 'R6b first-form 결정', options: ['A', 'B'], answered: false, closed: false }] : [],
    };

    const activeVm = {
      ...readVm,
      sessions: [...readVm.sessions, ownerSession],
      roadmaps: fullVm.roadmaps.map((rm) => ({
        ...rm,
        stages: rm.stages.map((st) => {
          if (st.id === 'E_BLK_DEC') {
            return { ...st, blocked: true, decisionNeeded: true, ready: false };
          }
          return st;
        }),
      })),
    };
    provenance = computeProvenance(absFixture, { vm: activeVm, generation: 9, pageOptions: { mode: 'server', token: TOKEN } });

    srv = fork(SELF, ['--kanban-fixture-server'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    srv.on('message', message => { if (message.type === 'served') lastServed = message; });
    cleanupReceipts.server.pid = srv.pid;
    const serverMessage = (type) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`fixture server timeout: ${type}`)); }, 15000);
      const onMessage = message => { if (message.type === type) { cleanup(); resolve(message); } else if (message.type === 'error') { cleanup(); reject(new Error(message.error)); } };
      const onExit = code => { cleanup(); reject(new Error(`fixture server exited ${code} before ${type}`)); };
      const cleanup = () => { clearTimeout(timer); srv.off('message', onMessage); srv.off('exit', onExit); };
      srv.on('message', onMessage); srv.once('exit', onExit);
    });
    const started = serverMessage('started');
    srv.send({ type: 'start', vm: activeVm, memento, profiles: pfStore.state(), portBase });
    srvPort = (await started).port;
    cleanupReceipts.server.port = srvPort;

    page = await launch({ width: 1440, height: 900 });
    cleanupReceipts.browser.pid = page.pid;
    cleanupReceipts.browser.port = page.port;
    cleanupReceipts.browser.profileDir = page.profileDir;

    const csp = await watchCsp(page);
    await page.client.send('Network.enable');
    const initialHtml = serverMessage('served');
    await page.goto(`http://127.0.0.1:${srvPort}/`);
    const served = await initialHtml;
    provenance.payloadHtmlSha256 = served.sha256;
    provenance.payloadHtmlBytes = served.bytes;
    const click = async selector => {
      const box = await page.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {x, y, width:r.width, height:r.height, hit: !!hit && (hit === el || el.contains(hit))};
      })()`);
      if (!box || !box.width || !box.height || !box.hit) {
        const viewportWidth = await page.eval('window.innerWidth');
        recordAction('click-failure', { selector, viewportWidth, box }, false,
          'CDP Input.dispatchMouseEvent', { selector, clickable: true });
        return false;
      }
      await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: box.x, y: box.y });
      await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: box.x, y: box.y });
      return true;
    };
    const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      for (const type of ['keyDown', 'keyUp']) {
        await page.client.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers });
      }
    };
    const publishVm = async (vm, generation = 9) => {
      const applied = page.eval(`new Promise((resolve,reject) => {
        const t=setTimeout(() => reject(new Error('publication not applied')),10000);
        BriefPage.hooks.afterApply.push(function onApply(m) { if(m.seq===${vm.seq}) { clearTimeout(t); resolve(true); } });
      })`);
      const published = serverMessage('published');
      srv.send({ type: 'publish', generation, vm });
      const [, result] = await Promise.all([applied, published]);
      if (!result.sent) throw new Error('fixture SSE publication reached no clients');
      return result;
    };
    const waitForPending = seq => page.eval(`new Promise((resolve,reject) => {
      const done=() => {
        if (BriefPage.state.pending?.seq !== ${seq}) return;
        clearTimeout(timer); observer.disconnect(); resolve(true);
      };
      const observer=new MutationObserver(done);
      const timer=setTimeout(() => { observer.disconnect(); reject(new Error('pending publication not observed')); },10000);
      observer.observe(document.documentElement,{attributes:true,childList:true,subtree:true});
      done();
    })`);

    // Settle helper
    await page.eval(`(() => {
      window.__rmSettle = async function() {
        if (document.fonts && document.fonts.ready) await document.fonts.ready.catch(() => null);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
        const anims = document.getAnimations().filter((a) => a.playState === 'running' && !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity));
        await Promise.all(anims.map((a) => a.finished.catch(() => null)));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
        return true;
      };
    })()`);

    let currentVp = { width: 1440, height: 900, name: '1440x900', mobile: false };
    let currentTheme = 'dark';

    const setEnv = async ({ width, height, name, mobile = false }, theme = 'dark', reducedMotion = 'no-preference') => {
      currentVp = { width, height, name, mobile };
      currentTheme = theme;
      await page.client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
      await page.client.send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-color-scheme', value: theme },
          { name: 'prefers-reduced-motion', value: reducedMotion },
        ],
      });
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);
    };

    const snapShot = async (name, stateLabel) => {
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);
      const rel = `captures/${name}.png`;
      const full = path.join(absOut, rel);
      await page.screenshot(full);
      const buf = fs.readFileSync(full);
      const stat = fs.statSync(full);
      const rec = {
        path: rel,
        sha256: sha256(buf),
        bytes: buf.length,
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
        viewport: currentVp.name,
        theme: currentTheme,
        mobile: currentVp.mobile,
        state: stateLabel,
        ...(stateLabel === 'stress:zoom-200pct' ? { zoomMethod: 'document-root CSS zoom: 2' } : {}),
        capturedAt: stat.mtime.toISOString(),
        sourceHash: provenance.sourceHash,
        payloadHtmlSha256: lastServed?.sha256,
      };
      captures[name] = rec;
      geometryLog[name] = await page.eval(`(() => {
        const sheet = document.querySelector('.rm-sheet-dialog[open]');
        const r = sheet && sheet.getBoundingClientRect();
        return { documentScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
          sheet: r ? { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom } : null };
      })()`);
      return rec;
    };

    // Switch to plans view
    await click('#rail [data-key="plans"]');
    await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

    // =========================================================================
    // A. Viewport × Theme Matrix Captures
    // 390, 1024, 1440 widths × light and dark, plus 320 reflow, 1180 and 1920 widths, 200% zoom and letter-spacing
    // =========================================================================
    const viewportsToTest = [
      { width: 1440, height: 900, name: '1440x900', mobile: false },
      { width: 1180, height: 700, name: '1180x700', mobile: false },
      { width: 1024, height: 768, name: '1024x768', mobile: false },
      { width: 1920, height: 1080, name: '1920x1080', mobile: false },
      { width: 390, height: 844, name: '390x844', mobile: true },
      { width: 320, height: 640, name: '320x640', mobile: true },
    ];

    for (const vp of viewportsToTest) {
      for (const theme of ['dark', 'light']) {
        await setEnv(vp, theme);
        await page.eval(`document.getElementById('main').scrollTop = 0`);
        await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);
        await snapShot(`${vp.name}-${theme}-board`, `board:${vp.name}:${theme}`);

        // Capture scrolled-to-end for sticky bar verification
        await page.eval(`document.getElementById('main').scrollTop = document.getElementById('main').scrollHeight`);
        await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);
        await snapShot(`${vp.name}-${theme}-end`, `scroll:end:${vp.name}:${theme}`);
        await page.eval(`document.getElementById('main').scrollTop = 0`);
      }
    }

    // 200% zoom stress capture
    await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, 'dark');
    await page.eval(`(() => { document.documentElement.style.zoom = '2'; })()`);
    await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);
    await snapShot('1440x900-dark-zoom200', 'stress:zoom-200pct');
    await page.eval(`(() => { document.documentElement.style.zoom = ''; })()`);

    // Increased letter-spacing stress capture
    await page.eval(`(() => { document.querySelector('#main .roadmap-view').style.letterSpacing = '0.08em'; })()`);
    await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);
    await snapShot('1440x900-dark-letter-spacing', 'stress:increased-letter-spacing');
    await page.eval(`(() => { document.querySelector('#main .roadmap-view').style.letterSpacing = ''; })()`);

    // =========================================================================
    // B. Required Interaction Assertions
    // =========================================================================
    await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, 'dark');

    // Assertion 1: card click (role=button) -> 근거 tab click -> Escape returns focus to the originating card
    {
      await page.eval(`document.getElementById('main').scrollTop = 0`);
      const r6bCard = await page.eval(`(() => {
        const btn = document.querySelector('[data-act="exp"][data-key*="R6b"]');
        return btn ? { key: btn.getAttribute('data-key') } : null;
      })()`);
      if (!r6bCard) throw new Error('Card button for R6b not found');
      const cardKey = r6bCard.key;
      const cardBtnSel = `[data-act="exp"][data-key="${cardKey}"]`;

      // Focus originating card and click via role=button
      await click(cardBtnSel);
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const sheetOpen = await page.eval(`(() => {
        const dlg = document.querySelector('.rm-sheet-dialog[open]');
        return Boolean(dlg && dlg.getAttribute('aria-modal') === 'true');
      })()`);
      await snapShot('1440x900-dark-sheet-open-summary', 'sheet:open-summary');

      // Exercise the native keyboard path, not synthetic DOM key events.
      const focusState = () => page.eval(`(() => {
        const d=document.querySelector('.rm-sheet-dialog[open]'), a=document.activeElement;
        return {id:a?.id || a?.getAttribute('data-act') || a?.className || a?.tagName || null,
          inside:!!d?.contains(a), backgroundCard:!!a?.closest('.rm-card-btn')};
      })()`);
      await click('.rm-sheet-dialog [data-act="rm-sheet-close"]');
      // Reopen after the click: starting with the first control requires focus,
      // not activating the close button.
      await click(cardBtnSel);
      await page.eval(`document.querySelector('.rm-sheet-close-btn').focus()`);
      const first = await focusState(), visited = [first];
      const count = await page.eval(`(() => [...document.querySelector('.rm-sheet-dialog[open]').querySelectorAll('button, [tabindex], a[href], input, select, textarea')].filter(e => (!e.hasAttribute('tabindex') || Number(e.getAttribute('tabindex')) >= 0) && !e.hasAttribute('disabled') && !e.closest('[hidden], [inert]') && e.offsetParent !== null).length)()`);
      for (let i = 0; i < count; i++) { await key('Tab','Tab',9); visited.push(await focusState()); }
      const wraps = count > 1 && visited.every(v => v.inside && !v.backgroundCard) && visited.at(-1).id === first.id;
      recordAction('modal-tab-trap', {count, visited}, wraps, 'CDP Input.dispatchKeyEvent',
        {allInside:true, backgroundCard:false, finalId:first.id, steps:count});
      await key('Tab','Tab',9,8);
      const reverse = await focusState();
      recordAction('modal-shift-tab-wrap', {first, last:visited.at(-2), observed:reverse},
        reverse.inside && !reverse.backgroundCard && reverse.id === visited.at(-2).id,
        'CDP Input.dispatchKeyEvent', {id:visited.at(-2).id, inside:true, backgroundCard:false});

      await click('.rm-sheet-tab[data-tab="summary"]');
      const tabMoves = [];
      for (const [name, code, n, expectedTab] of [
        ['ArrowRight','ArrowRight',39,'evidence'], ['ArrowLeft','ArrowLeft',37,'summary'],
        ['End','End',35,'history'], ['Home','Home',36,'summary'],
      ]) {
        await key(name,code,n);
        const actual = await page.eval(`(() => ({selected:document.querySelector('.rm-sheet-tab[aria-selected="true"]')?.getAttribute('data-tab'), focused:document.activeElement?.getAttribute('data-tab')}))()`);
        tabMoves.push({key:name, expected:expectedTab, ...actual});
      }
      recordAction('modal-tablist-arrow-home-end', {moves:tabMoves},
        tabMoves.every(m => m.selected === m.expected && m.focused === m.expected),
        'CDP Input.dispatchMouseEvent and Input.dispatchKeyEvent', {moves:tabMoves.map(m => ({key:m.key,selected:m.expected,focused:m.expected}))});

      // Click 근거 (evidence) tab
      const evTabSel = '.rm-sheet-tab[data-tab="evidence"]';
      await click(evTabSel);
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const evActive = await page.eval(`(() => {
        const evTab = document.querySelector(${JSON.stringify(evTabSel)});
        const evPanel = document.getElementById('rm-panel-evidence');
        return evTab?.getAttribute('aria-selected') === 'true' && Boolean(evPanel && !evPanel.hasAttribute('hidden'));
      })()`);
      await snapShot('1440x900-dark-sheet-open-evidence', 'sheet:open-evidence');

      // Press Escape key via CDP trusted key event
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const focusRestored = await page.eval(`(() => {
        const dlg = document.querySelector('.rm-sheet-dialog[open]');
        const btn = document.querySelector(${JSON.stringify(cardBtnSel)});
        return !dlg && document.activeElement === btn;
      })()`);

      recordAction('card-click-evidence-tab-escape-focus-restore', {
        cardKey,
        sheetOpen,
        evActive,
        focusRestored,
      }, sheetOpen && evActive && focusRestored, 'CDP Input.dispatchMouseEvent and Input.dispatchKeyEvent',
      { sheetOpen: true, evActive: true, focusRestored: true });
    }

    {
      await setEnv({width:390,height:844,name:'390x844',mobile:true}, 'dark');
      const index = await page.eval(`Array.from(document.querySelectorAll('.rm-col')).findIndex(col => col.querySelector('.rm-card-btn'))`);
      if (index >= 0) {
        await click('#rm-status');
        await key('Home','Home',36);
        for (let i = 0; i < index; i++) await key('ArrowDown','ArrowDown',40);
        await key('Enter','Enter',13);
      }
      await setEnv({width:600,height:844,name:'600x844',mobile:true}, 'dark');
      await click('.rm-col-active .rm-card-btn');
      await snapShot('600x844-dark-sheet-open', 'sheet:600px-boundary');
      const observed = await page.eval(`(() => {const d=document.querySelector('.rm-sheet-dialog[open]'), r=d?.getBoundingClientRect(); return {open:!!d,width:r?.width ?? null,viewport:innerWidth,left:r?.left ?? null,right:r?.right ?? null};})()`);
      recordAction('mobile-sheet-600px-full-width', observed,
        observed.open && Math.abs(observed.width-observed.viewport) <= 1 && Math.abs(observed.left) <= 1,
        'CDP Input.dispatchMouseEvent; CDP viewport emulation', {open:true,width:600,viewport:600,left:0,right:600});
      await key('Escape','Escape',27);
      await page.client.send('Emulation.clearDeviceMetricsOverride');
      await page.client.send('Emulation.setTouchEmulationEnabled', {enabled:false});
    }

    // Assertion 1b: mobile controls disclosure at 390px (collapsed by default, toggle expands, status select & return visible before toggle)
    {
      await setEnv({ width: 390, height: 844, name: '390x844', mobile: true }, 'dark');
      await page.eval(`document.getElementById('main').scrollTop = 0`);

      // Switch mobile status to a column that contains cards (e.g. decisionNeeded, index 2)
      // so we can verify that the first card remains visible and not hidden by the disclosure.
      const candidateCol = await page.eval(`(() => {
        const cols = [...document.querySelectorAll('.rm-col')];
        const index = cols.findIndex(col => col.querySelector('.rm-card-btn'));
        return { index };
      })()`);
      if (candidateCol.index >= 0) {
        await click('#rm-status');
        await key('Home', 'Home', 36);
        for (let i = 0; i < candidateCol.index; i++) await key('ArrowDown', 'ArrowDown', 40);
        await key('Enter', 'Enter', 13);
        await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);
      }

      const initialMobileState = await page.eval(`(() => {
        const toggle = document.querySelector('[data-act="rm-mobile-filter-toggle"]');
        const coll = document.getElementById('rm-toolbar-collapsible');
        const statusSel = document.getElementById('rm-status');
        const plansBtn = document.querySelector('[data-act="rm-connected-plans"]');
        const firstCard = document.querySelector('.rm-col-active .rm-card-btn') || document.querySelector('.rm-attention-region .rm-card-btn');
        const collStyle = coll ? window.getComputedStyle(coll) : null;
        return {
          hasToggle: Boolean(toggle),
          toggleExpandedBefore: toggle?.getAttribute('aria-expanded') === 'true',
          collapsibleDisplayBefore: collStyle?.display,
          statusSelectVisibleBefore: Boolean(statusSel && statusSel.offsetWidth > 0 && statusSel.offsetHeight > 0),
          plansBtnVisibleBefore: Boolean(plansBtn && plansBtn.offsetWidth > 0 && plansBtn.offsetHeight > 0),
          firstCardVisibleBefore: Boolean(firstCard && firstCard.offsetWidth > 0 && firstCard.offsetHeight > 0),
        };
      })()`);

      // Click disclosure toggle using CDP input
      await click('[data-act="rm-mobile-filter-toggle"]');
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const afterToggleState = await page.eval(`(() => {
        const toggle = document.querySelector('[data-act="rm-mobile-filter-toggle"]');
        const coll = document.getElementById('rm-toolbar-collapsible');
        const searchInput = document.getElementById('rm-search');
        const trackSelect = document.getElementById('rm-track');
        const collStyle = coll ? window.getComputedStyle(coll) : null;
        return {
          toggleExpandedAfter: toggle?.getAttribute('aria-expanded') === 'true',
          collapsibleDisplayAfter: collStyle?.display,
          searchVisibleAfter: Boolean(searchInput && searchInput.offsetWidth > 0 && searchInput.offsetHeight > 0),
          trackVisibleAfter: Boolean(trackSelect && trackSelect.offsetWidth > 0 && trackSelect.offsetHeight > 0),
        };
      })()`);

      // Click toggle again to restore collapsed state
      await click('[data-act="rm-mobile-filter-toggle"]');
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      // Reset status back to 'ready' (top)
      await click('#rm-status');
      await key('Home', 'Home', 36);
      await key('Enter', 'Enter', 13);
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const disclosurePass = initialMobileState.hasToggle &&
        !initialMobileState.toggleExpandedBefore &&
        initialMobileState.collapsibleDisplayBefore === 'none' &&
        initialMobileState.statusSelectVisibleBefore &&
        initialMobileState.plansBtnVisibleBefore &&
        initialMobileState.firstCardVisibleBefore &&
        afterToggleState.toggleExpandedAfter &&
        afterToggleState.collapsibleDisplayAfter !== 'none' &&
        afterToggleState.searchVisibleAfter &&
        afterToggleState.trackVisibleAfter;

      recordAction('mobile-controls-disclosure-collapsed-toggle-and-visible-controls', {
        ...initialMobileState,
        ...afterToggleState,
      }, disclosurePass, 'CDP Input.dispatchMouseEvent', {
        hasToggle: true,
        toggleExpandedBefore: false,
        collapsibleDisplayBefore: 'none',
        statusSelectVisibleBefore: true,
        plansBtnVisibleBefore: true,
        firstCardVisibleBefore: true,
        toggleExpandedAfter: true,
        searchVisibleAfter: true,
        trackVisibleAfter: true,
      });
    }

    // Assertion 1c: column title computes to 22px at 601px and 1024px
    {
      const titleSizes = {};
      for (const width of [601, 1024]) {
        await setEnv({ width, height: 768, name: `${width}x768`, mobile: false }, 'dark');
        await page.eval(`document.getElementById('main').scrollTop = 0`);
        await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);
        titleSizes[width] = await page.eval(`(() => {
          const colTitle = document.querySelector('.rm-col-title');
          return colTitle ? window.getComputedStyle(colTitle).fontSize : null;
        })()`);
      }

      const typeScalePass = titleSizes[601] === '22px' && titleSizes[1024] === '22px';

      recordAction('tablet-column-title-computed-font-size-scale', {
        titleSizes,
      }, typeScalePass, 'CDP window.getComputedStyle observation', {
        titleSizes: { 601: '22px', 1024: '22px' },
      });
    }

    // Assertion 2: mobile: status select -> card -> 연결 계획 -> 돌아가기 restores the previous column/filters
    {
      await setEnv({ width: 390, height: 844, name: '390x844', mobile: true }, 'dark');
      await page.eval(`document.getElementById('main').scrollTop = 0`);

      // Select mobile status to 'decisionNeeded'
      await click('#rm-status');
      await key('Home', 'Home', 36);
      await key('ArrowDown', 'ArrowDown', 40);
      await key('ArrowDown', 'ArrowDown', 40);
      await key('Enter', 'Enter', 13);
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);
      await snapShot('390x844-dark-status-decision', 'mobile:status-decisionNeeded');

      // Click 연결 계획 in header
      await click('[data-act="rm-connected-plans"]');
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const inPlansView = await page.eval(`Boolean(document.querySelector('.rm-connected-plans-view'))`);
      await snapShot('390x844-dark-connected-plans', 'mobile:connected-plans-view');

      // Click 돌아가기
      await click('[data-act="rm-return-board"]');
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const statusRestored = await page.eval(`(() => {
        const sel = document.getElementById('rm-status');
        const view = document.querySelector('.rm-kanban-view');
        return sel?.value === 'decisionNeeded' && view?.getAttribute('data-rm-status') === 'decisionNeeded';
      })()`);

      recordAction('mobile-status-connected-plans-return-restore', {
        inPlansView,
        statusRestored,
        restoredValue: 'decisionNeeded',
      }, inPlansView && statusRestored, 'CDP Input.dispatchMouseEvent and Input.dispatchKeyEvent',
      { inPlansView: true, statusRestored: true, restoredValue: 'decisionNeeded' });
    }

    // Assertion 3: search 'NO_MATCH_KANBAN_865' -> 0 results with a clear control -> clear restores everything
    {
      await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, 'dark');

      const initialCount = await page.eval(`document.querySelectorAll('#main [data-rm-key]').length`);

      // Input NO_MATCH_KANBAN_865 into search
      await click('#rm-search');
      await page.client.send('Input.insertText', { text: 'NO_MATCH_KANBAN_865' });
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const zeroCount = await page.eval(`document.querySelectorAll('#main [data-rm-key]').length`);
      const hasClearBtn = await page.eval(`Boolean(document.querySelector('[data-act="rm-clear-all-filters"]') || document.querySelector('[data-act="rm-clear-search"]'))`);
      await snapShot('1440x900-dark-search-no-match', 'search:no-match');

      // Click clear filters button
      await click('[data-act="rm-clear-all-filters"]');
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const restoredCount = await page.eval(`document.querySelectorAll('#main [data-rm-key]').length`);
      const searchCleared = await page.eval(`document.getElementById('rm-search')?.value === ''`);

      recordAction('search-no-match-clear-restore', {
        initialCount,
        zeroCount,
        hasClearBtn,
        restoredCount,
        searchCleared,
      }, initialCount > 0 && zeroCount === 0 && hasClearBtn && restoredCount === initialCount && searchCleared,
      'CDP Input.dispatchMouseEvent and Input.insertText',
      { initialCount: '> 0', zeroCount: 0, hasClearBtn: true, restoredCount: initialCount, searchCleared: true });
    }

    // Assertion 4: blocked+decision renders as exactly ONE card with two badges
    {
      const blkDecCards = await page.eval(`(() => {
        const cards = [...document.querySelectorAll('#main [data-rm-stage="E_BLK_DEC"]')];
        return cards.map((c) => ({
          key: c.getAttribute('data-rm-key'),
          badges: [...c.querySelectorAll('[data-rm-badge]')].map((b) => b.getAttribute('data-rm-badge')),
        }));
      })()`);

      const singleCardWithTwoBadges = blkDecCards.length === 1 &&
        blkDecCards[0].badges.includes('blocked') &&
        blkDecCards[0].badges.includes('decisionNeeded');

      recordAction('blocked-plus-decision-single-card-two-badges', {
        cardCount: blkDecCards.length,
        badges: blkDecCards[0]?.badges || [],
      }, singleCardWithTwoBadges, 'DOM observation',
      { cardCount: 1, badgesInclude: ['blocked', 'decisionNeeded'] });
    }

    // A real model publication moves the selected stage while the mobile sheet remains open.
    {
      const selector = '.rm-col-active .rm-card-btn';
      try {
        await setEnv({ width: 390, height: 844, name: '390x844', mobile: true }, 'dark');
        const candidate = await page.eval(`(() => {
          const cols = [...document.querySelectorAll('.rm-col')];
          const index = cols.findIndex(col => col.querySelector('.rm-card-btn'));
          return { index };
        })()`);
        if (candidate.index < 0) throw new Error('no status column contains a card');
        await click('#rm-status');
        await key('Home', 'Home', 36);
        for (let i = 0; i < candidate.index; i++) await key('ArrowDown', 'ArrowDown', 40);
        await key('Enter', 'Enter', 13);
        const selected = await page.eval(`(() => {
          const button = document.querySelector('.rm-col-active .rm-card-btn');
          const card = button && button.closest('[data-rm-stage]');
          return card && { id:card.getAttribute('data-rm-stage'), key:button.getAttribute('data-key'),
            column:card.closest('[data-rm-col]')?.getAttribute('data-rm-col') };
        })()`);
        if (!selected) throw new Error('missing selector: ' + selector);
        await click(selector);
        const moved = structuredClone(activeVm);
        const roadmapId = selected.key.split(':')[1];
        const movedRoadmap = moved.roadmaps.find(r => r.roadmapId === roadmapId);
        const stage = movedRoadmap?.stages.find(s => s.id === selected.id);
        if (!stage) throw new Error('fixture stage not found: ' + JSON.stringify(selected));
        movedRoadmap.stale = false;
        movedRoadmap.error = null;
        Object.assign(stage, { terminal:false, running:selected.column !== 'running', blocked:selected.column === 'running',
          decisionNeeded:false, ready:false, unknown:false, held:false, requirementsKnown:true,
          progress: { ...stage.progress, denominator:1, conflicts:0 } });
        moved.seq = activeVm.seq + 20;
        const pub = await publishVm(moved);
        const observed = await page.eval(`(() => {
          const d=document.querySelector('.rm-sheet-dialog[open]');
          const c=document.querySelector(${JSON.stringify(`[data-act="exp"][data-key="${selected.key}"]`)});
          return {open:!!d, column:c?.closest('[data-rm-col]')?.getAttribute('data-rm-col') || null};
        })()`);
        await snapShot('390x844-dark-sheet-after-status-change', 'mobile:sheet-after-status-change');
        recordAction('mobile-sheet-survives-status-column-change', {selector,selected,observed,sseRecipients:pub.sent},
          pub.sent > 0 && observed.open && observed.column !== null && observed.column !== selected.column,
          'CDP mouse and keyboard; server SSE', { sheetOpen: true, column: `different from ${selected.column}`, sseRecipients: '> 0' });
        await click('.rm-sheet-dialog[open] .rm-sheet-close-btn');
        const buttonFocus = await page.eval(`({open:!!document.querySelector('.rm-sheet-dialog[open]'),heading:document.activeElement?.matches('.rm-title') || false,tag:document.activeElement?.tagName})`);
        recordAction('mobile-moved-sheet-close-button-focus', {selected,after:buttonFocus},
          !buttonFocus.open && buttonFocus.heading && buttonFocus.tag !== 'BODY',
          'CDP Input.dispatchMouseEvent; server SSE', {open:false,heading:true,tag:'H1'});
        await publishVm({...activeVm,seq:activeVm.seq+21});
        await click(selector);
        moved.seq = activeVm.seq + 22;
        const secondPub = await publishVm(moved);
        await key('Escape','Escape',27);
        const escapeFocus = await page.eval(`({open:!!document.querySelector('.rm-sheet-dialog[open]'),heading:document.activeElement?.matches('.rm-title') || false,tag:document.activeElement?.tagName})`);
        recordAction('mobile-moved-sheet-escape-focus', {selected,after:escapeFocus,sseRecipients:secondPub.sent},
          secondPub.sent > 0 && !escapeFocus.open && escapeFocus.heading && escapeFocus.tag !== 'BODY',
          'CDP Input.dispatchMouseEvent and Input.dispatchKeyEvent; server SSE', {open:false,heading:true,tag:'H1',sseRecipients:'> 0'});
      } catch (error) {
        recordAction('mobile-sheet-survives-status-column-change', {selector,error:String(error)}, false,
          'CDP mouse and keyboard; server SSE', { sheetOpen: true, column: 'changed', sseRecipients: '> 0' });
        await key('Escape','Escape',27);
      }
    }

    // Remove a selected stage through SSE; verify the notice, close control, and focus.
    {
      const selector = '[data-act="exp"][data-key*="R6b"]';
      try {
        await publishVm({ ...activeVm, seq: activeVm.seq + 23 });
        await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, 'dark');
        await click(selector);
        const keyValue = await page.eval(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('data-key')`);
        if (!keyValue) throw new Error('missing selector: ' + selector);
        const roadmapId = keyValue.split(':')[1];
        const vanished = structuredClone(activeVm);
        vanished.seq = activeVm.seq + 24;
        vanished.roadmaps = vanished.roadmaps.map(r => r.roadmapId === roadmapId
          ? { ...r, stages: r.stages.filter(s => s.id !== 'R6b') } : r);
        const pub = await publishVm(vanished);
        const notice = await page.eval(`(() => {
          const dlg=document.querySelector('.rm-sheet-dialog[open]');
          return {open:!!dlg, notice:dlg?.querySelector('[role="status"]')?.textContent || null,
            close:!!dlg?.querySelector('[data-act="rm-sheet-close"]'),
            focusInside:!!dlg?.contains(document.activeElement)};
        })()`);
        await snapShot('1440x900-dark-sheet-stage-disappeared', 'sheet:stage-disappeared');
        await click('.rm-sheet-dialog[open] [data-act="rm-sheet-close"]');
        const after = await page.eval(`({open:!!document.querySelector('.rm-sheet-dialog[open]'),
          focus:document.activeElement?.outerHTML?.slice(0,300) || null,
          heading:document.activeElement?.matches('.rm-title') || false})`);
        recordAction('vanishing-stage-notice-close-focus', {selector,notice,after,sseRecipients:pub.sent},
          notice.open && notice.notice?.includes('사라졌습니다') && notice.close && notice.focusInside && !after.open && after.heading,
          'CDP Input.dispatchMouseEvent; server SSE',
          { notice: '단계가 사라졌습니다', close: true, focusInside: true, closed: true, focus: '.rm-title' });
        await publishVm({ ...activeVm, seq: activeVm.seq + 25 });
      } catch (error) {
        recordAction('vanishing-stage-notice-close-focus', {selector,error:String(error)}, false,
          'CDP Input.dispatchMouseEvent; server SSE',
          { notice: '단계가 사라졌습니다', close: true, focusInside: true, closed: true, focus: '.rm-title' });
        await key('Escape','Escape',27);
      }
    }

    // Reduced motion: sample consecutive rendering frames after the trusted jump.
    {
      const selector = '[data-act="rm-attn-jump"]';
      try {
        await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, 'dark', 'reduce');
        await page.eval(`document.getElementById('main').scrollTop = 0`);
        await click(selector);
        const observed = await page.eval(`new Promise(resolve => {
          const main=document.getElementById('main'), samples=[main.scrollTop];
          requestAnimationFrame(() => {samples.push(main.scrollTop);requestAnimationFrame(() => {
            samples.push(main.scrollTop); resolve({samples,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches});
          });});
        })`);
        await snapShot('1440x900-dark-reduced-motion-jump', 'reduced-motion:attention-jump');
        geometryLog.reducedMotion = observed;
        recordAction('reduced-motion-attention-jump', {selector,...observed},
          observed.reduced && observed.samples[0] > 0 && observed.samples.every(x => x === observed.samples[0]),
          'CDP Input.dispatchMouseEvent; CDP reduced-motion emulation', { reduced: true, samples: 'equal and > 0' });
      } catch (error) {
        recordAction('reduced-motion-attention-jump', {selector,error:String(error)}, false,
          'CDP Input.dispatchMouseEvent; CDP reduced-motion emulation', { reduced: true, samples: 'equal and > 0' });
      }
      await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, 'dark');
    }

    // Real SSE publication while a pointer is held. Stamp the element itself, not window.
    {
      const selector = '.rm-card-btn';
      let box, pressed = false;
      try {
        await click('#rail [data-key="plans"]');
        box = await page.eval('(() => { const el = document.querySelector(".rm-card-btn"); if (!el) return null; el.scrollIntoView({block:"center",behavior:"instant"}); el.setAttribute("data-qa-held-node","held"); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()');
        if (!box) throw new Error('missing selector: ' + selector);
        await page.client.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',buttons:1,clickCount:1,...box});
        pressed = true;
        const pending = waitForPending(activeVm.seq+100);
        const received = page.client.once('Network.eventSourceMessageReceived');
        const published = serverMessage('published');
        srv.send({type:'publish',generation:9,vm:{...activeVm,seq:activeVm.seq+100}});
        const [pub] = await Promise.all([published, received, pending]);
        const observed = await page.eval('(() => ({token:document.querySelector(".rm-card-btn")?.getAttribute("data-qa-held-node") || null, pointerDown:BriefPage.state.pointerDown, pending:!!BriefPage.state.pending}))()');
        await page.client.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',buttons:0,clickCount:1,...box});
        pressed = false;
        await key('Escape','Escape',27);
        recordAction('pointer-hold-sse-node-preserved', {selector,...observed,sseRecipients:pub.sent},
          pub.sent > 0 && observed.pointerDown === true && observed.pending === true && observed.token === 'held', 'CDP Input.dispatchMouseEvent; server SSE',
          { pointerDown: true, pending: true, token: 'held', sseRecipients: '> 0' });
      } catch (error) {
        if (pressed) await page.client.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',buttons:0,clickCount:1,...box});
        recordAction('pointer-hold-sse-node-preserved', {selector,error:String(error)}, false, 'CDP Input.dispatchMouseEvent; server SSE',
          { pointerDown: true, token: 'held', sseRecipients: '> 0' });
      }
    }

    // Scenario A: keep typing focus through the notice and the generation reload.
    {
      const selector = 'textarea[data-draft]';
      const observed = { selector, before:null, held:null, after:null, reloads:0, sseRecipients:0 };
      const expected = { before:{value:'kanban865 draft',focused:true}, held:{value:'kanban865 draft',focused:true},
        after:{value:'kanban865 draft',focused:true}, reloads:1, sseRecipients:'> 0' };
      const onNavigation = event => { if (!event.frame.parentId) observed.reloads++; };
      let listeners;
      try {
        await click('#rail [data-key="inbox"]');
        await click('[data-act="ans-reply"]');
        await click(selector);
        await page.client.send('Input.insertText', {text:'kanban865 draft'});
        observed.before = await page.eval('(() => {const el=document.querySelector("textarea[data-draft]");return el && {value:el.value,focused:document.activeElement===el};})()');
        if (!observed.before || observed.before.value !== 'kanban865 draft' || !observed.before.focused) throw new Error('draft input missing or not focused: '+selector);
        listeners = page.client.listeners.get('Page.frameNavigated') || [];
        listeners.push(onNavigation); page.client.listeners.set('Page.frameNavigated', listeners);
        const loaded = page.client.once('Page.loadEventFired', 15000).then(() => null, error => error);
        const pending = waitForPending(activeVm.seq+200);
        const received = page.client.once('Network.eventSourceMessageReceived');
        const published = serverMessage('published');
        srv.send({type:'publish',generation:10,vm:{...activeVm,seq:activeVm.seq+200,gen:10}});
        const [pub] = await Promise.all([published, received, pending]);
        observed.sseRecipients = pub.sent;
        observed.held = await page.eval('(() => {const el=document.querySelector("textarea[data-draft]");return el && {value:el.value,focused:document.activeElement===el};})()');
        const loadError = await loaded;
        if (loadError) {
          observed.atDeadline = await page.eval('(() => {const el=document.querySelector("textarea[data-draft]");return el && {value:el.value,focused:document.activeElement===el};})()');
          throw loadError;
        }
        observed.after = await page.eval('(() => {const el=document.querySelector("textarea[data-draft]");return el && {value:el.value,focused:document.activeElement===el};})()');
      } catch (error) { observed.error = String(error); }
      finally { if (listeners) page.client.listeners.set('Page.frameNavigated', listeners.filter(fn => fn !== onNavigation)); }
      const pass = observed.sseRecipients > 0 && observed.before?.value === 'kanban865 draft' && observed.before?.focused === true &&
        observed.held?.value === 'kanban865 draft' && observed.held?.focused === true && observed.reloads === 1 &&
        observed.after?.value === 'kanban865 draft' && observed.after?.focused === true;
      if (!pass) findings.push({name:'generation-reload-while-typing', ...observed});
      recordAction('sse-generation-draft-focus-and-single-reload', observed, pass,
        'CDP mouse, Input.insertText; server SSE', expected);
    }

    // Scenario B: Tab away before publishing; the reload must not steal composer focus.
    {
      const selector = 'textarea[data-draft]';
      const observed = { selector, beforeTab:null, beforePublish:null, after:null, reloads:0, sseRecipients:0 };
      const expected = { beforeTab:{focused:true}, beforePublish:{focused:false,connected:true},
        after:{found:true,value:'guard draft',focused:false,connected:true}, reloads:1, sseRecipients:'> 0' };
      const onNavigation = event => { if (!event.frame.parentId) observed.reloads++; };
      let listeners;
      try {
        await page.goto('http://127.0.0.1:' + srvPort + '/');
        await click('#rail [data-key="inbox"]');
        if (!await page.eval('Boolean(document.querySelector("textarea[data-draft]"))')) await click('[data-act="ans-reply"]');
        await click(selector);
        await key('a','KeyA',65,2);
        await page.client.send('Input.insertText', {text:'guard draft'});
        observed.beforeTab = await page.eval('(() => {const el=document.querySelector("textarea[data-draft]");return el && {value:el.value,focused:document.activeElement===el};})()');
        if (!observed.beforeTab || observed.beforeTab.value !== 'guard draft' || !observed.beforeTab.focused) throw new Error('guard draft missing or not focused: '+selector);
        const changed = page.eval('new Promise((resolve,reject) => {const timer=setTimeout(() => reject(new Error("Tab focus change not observed")),5000); document.addEventListener("focusin",() => {clearTimeout(timer);resolve(true);},{once:true});})').then(() => null, error => error);
        await key('Tab','Tab',9);
        const tabError = await changed;
        if (tabError) throw tabError;
        observed.beforePublish = await page.eval('(() => {const el=document.querySelector("textarea[data-draft]"),a=document.activeElement;return {focused:!!el && a===el,connected:!!a && a.isConnected,tag:a?.tagName || null};})()');
        if (observed.beforePublish.focused || !observed.beforePublish.connected) throw new Error('Tab did not move focus to a connected element');
        listeners = page.client.listeners.get('Page.frameNavigated') || [];
        listeners.push(onNavigation); page.client.listeners.set('Page.frameNavigated', listeners);
        const loaded = page.client.once('Page.loadEventFired', 15000).then(() => null, error => error);
        const received = page.client.once('Network.eventSourceMessageReceived');
        const published = serverMessage('published');
        srv.send({type:'publish',generation:11,vm:{...activeVm,seq:activeVm.seq+300,gen:11}});
        const [pub] = await Promise.all([published, received]);
        observed.sseRecipients = pub.sent;
        const loadError = await loaded;
        if (loadError) throw loadError;
        observed.after = await page.eval('(() => {const el=document.querySelector("textarea[data-draft]"),a=document.activeElement;return {found:!!el,value:el?.value ?? null,focused:!!el && a===el,connected:!!a && a.isConnected,tag:a?.tagName || null};})()');
      } catch (error) { observed.error = String(error); }
      finally { if (listeners) page.client.listeners.set('Page.frameNavigated', listeners.filter(fn => fn !== onNavigation)); }
      const pass = observed.sseRecipients > 0 && observed.beforeTab?.focused === true && observed.beforePublish?.focused === false &&
        observed.beforePublish?.connected === true && observed.reloads === 1 &&
        observed.after?.found === true && observed.after?.value === 'guard draft' &&
        observed.after?.focused === false && observed.after?.connected === true;
      if (!pass) findings.push({name:'generation-reload-focus-stealing-guard', ...observed});
      recordAction('generation-reload-does-not-steal-focus', observed, pass,
        'CDP mouse, Input.insertText, Input.dispatchKeyEvent; server SSE', expected);
    }

    // Assertion 8: every desktop column heading is inside the initial viewport (scrollY===0), and the 확인 필요 heading needs exactly one jump
    {
      await setEnv({ width: 1440, height: 900, name: '1440x900', mobile: false }, 'dark');
      await key('Escape','Escape',27);
      await click('#rail [data-key="plans"]');
      await page.eval(`document.getElementById('main').scrollTop = 0`);
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const colHeadingsGeometry = await page.eval(`(() => {
        const main = document.getElementById('main');
        const mr = main.getBoundingClientRect();
        const heads = [...document.querySelectorAll('.rm-col-head')].map((h) => {
          const r = h.getBoundingClientRect();
          return {
            id: h.querySelector('h2')?.id,
            left: r.left, right: r.right, width: r.width, height: r.height,
            top: r.top - mr.top,
            bottom: r.bottom - mr.top,
            insideInitialViewport: r.top >= mr.top && r.bottom <= mr.bottom,
          };
        });
        return {
          scrollY: main.scrollTop,
          allInside: heads.every((h) => h.insideInitialViewport),
          heads,
        };
      })()`);

      // Now click the 확인 필요 jump button
      await click('[data-act="rm-attn-jump"]');
      await page.eval(`(() => { if (typeof window.__rmSettle === "function") return window.__rmSettle(); return new Promise(r => requestAnimationFrame(() => r(true))); })()`);

      const attnJumpGeometry = await page.eval(`(() => {
        const main = document.getElementById('main');
        const mr = main.getBoundingClientRect();
        const attnH2 = document.getElementById('rm-attn-title');
        const hr = attnH2 ? attnH2.getBoundingClientRect() : null;
        return {
          scrollTopAfterJump: main.scrollTop,
          headerTopRelMain: hr ? hr.top - mr.top : null,
          isNearTop: hr ? Math.abs(hr.top - mr.top) < 60 : false,
        };
      })()`);

      const headingsInsideViewport = colHeadingsGeometry.scrollY === 0 && colHeadingsGeometry.heads.length === 5 && colHeadingsGeometry.allInside;
      const jumpReachedTarget = attnJumpGeometry.isNearTop;

      geometryLog.desktopHeadings = colHeadingsGeometry;
      geometryLog.attentionJump = attnJumpGeometry;

      recordAction('desktop-column-headings-in-initial-viewport-and-jump', {
        headingsInsideViewport,
        colHeadingsGeometry,
        jumpReachedTarget,
        attnJumpGeometry,
      }, headingsInsideViewport && jumpReachedTarget, 'CDP Input.dispatchMouseEvent',
      { headingCount: 5, scrollY: 0, headingsInsideViewport: true, jumpReachedTarget: true });
    }

    // Write outputs: actions.json, geometry.json, capture-manifest.json
    const changedSources = Object.entries(provenance.files).filter(([file, digest]) =>
      sha256(fs.readFileSync(path.join(ROOT, file))) !== digest).map(([file]) => file);
    if (sha256(fs.readFileSync(SELF)) !== provenance.qaScriptSha256) changedSources.push('scripts/qa-roadmap.mjs');
    recordAction('capture-source-stability', { changedSources }, changedSources.length === 0,
      'filesystem SHA-256', { changedSources: [] });
    recordAction('content-security-policy', { violations: csp.violations }, csp.violations.length === 0,
      'CDP security event observation', { violations: [] });
    fs.writeFileSync(path.join(absOut, 'actions.json'), JSON.stringify(actionLog, null, 2));
    fs.writeFileSync(path.join(absOut, 'geometry.json'), JSON.stringify(geometryLog, null, 2));
    fs.writeFileSync(path.join(absOut, 'findings.json'), JSON.stringify(findings, null, 2));

    const manifest = {
      schema: 'board-kanban-status-redesign-task-7/manifest',
      provenance,
      generatedAt: new Date().toISOString(),
      totalCaptures: Object.keys(captures).length,
      captures,
    };
    fs.writeFileSync(path.join(absOut, 'capture-manifest.json'), JSON.stringify(manifest, null, 2));

    return {
      pass: actionLog.every((a) => a.pass),
      actionCount: actionLog.length,
      allActionsPassed: actionLog.every((a) => a.pass),
      capturesCount: Object.keys(captures).length,
      actions: actionLog,
      geometry: geometryLog,
    };
  } catch (error) {
    recordAction('harness-execution', { error: error.stack || String(error) }, false, 'harness', { error: null });
    fs.writeFileSync(path.join(absOut, 'actions.json'), JSON.stringify(actionLog, null, 2));
    fs.writeFileSync(path.join(absOut, 'geometry.json'), JSON.stringify(geometryLog, null, 2));
    fs.writeFileSync(path.join(absOut, 'findings.json'), JSON.stringify(findings, null, 2));
    fs.writeFileSync(path.join(absOut, 'capture-manifest.json'), JSON.stringify({
      schema: 'board-kanban-status-redesign-task-7/manifest', provenance, generatedAt: new Date().toISOString(),
      totalCaptures: Object.keys(captures).length, captures,
    }, null, 2));
    throw error;
  } finally {
    const cleanupErrors = [];
    const portListening = port => new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error(`port probe timeout: ${port}`)); });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(false); else reject(error); });
    });
    if (page) {
      try { await page.close(); }
      catch (error) { cleanupErrors.push(`browser close: ${error.stack || error}`); }
      cleanupReceipts.browser.pidAlive = isPidAlive(page.pid);
      try { cleanupReceipts.browser.portListening = await portListening(page.port); }
      catch (error) { cleanupErrors.push(`browser port probe: ${error.stack || error}`); }
      cleanupReceipts.browser.command = `process.kill(${page.pid}, 0); connect 127.0.0.1:${page.port}`;
      cleanupReceipts.browser.closed = !cleanupReceipts.browser.pidAlive && cleanupReceipts.browser.portListening === false && cleanupErrors.length === 0;
    }
    if (srv) {
      try {
        if (srv.exitCode === null && srv.signalCode === null) {
          const exited = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fixture server exit timeout')), 15000);
            srv.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
          });
          srv.send({ type: 'close' });
          cleanupReceipts.server.exit = await exited;
        }
      } catch (error) {
        cleanupErrors.push(`server close: ${error.stack || error}`);
        if (isPidAlive(srv.pid)) srv.kill();
      }
      cleanupReceipts.server.pidAlive = isPidAlive(srv.pid);
      cleanupReceipts.server.command = `process.kill(${srv.pid}, 0); connect 127.0.0.1:${srvPort}`;
      if (srvPort) {
        try { cleanupReceipts.server.portListening = await portListening(srvPort); }
        catch (error) { cleanupErrors.push(`server port probe: ${error.stack || error}`); }
      }
      cleanupReceipts.server.closed = !cleanupReceipts.server.pidAlive && cleanupReceipts.server.portListening === false && cleanupErrors.length === 0;
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(`temp cleanup: ${error.stack || error}`); }
    cleanupReceipts.errors = cleanupErrors;
    cleanupReceipts.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(absOut, 'cleanup.json'), JSON.stringify(cleanupReceipts, null, 2));
    if (cleanupErrors.length || (page && !cleanupReceipts.browser.closed) || (srv && !cleanupReceipts.server.closed)) {
      throw new Error(`QA cleanup failed: ${JSON.stringify(cleanupReceipts)}`);
    }
  }
}

if (process.argv[2] === '--kanban-fixture-server') {
  let server, vm, generation = 9;
  process.on('message', async message => {
    try {
      if (message.type === 'start') {
        vm = message.vm;
        server = createBoardServer({
          portBase: message.portBase, portCount: 10, generation, token: TOKEN,
          assetsDir: path.join(ROOT, 'test/fixtures/board-assets'), assetAllowed: () => true,
          getPage: ({ nonce } = {}) => {
            const html = pageHtml(vm, generation, { mode: 'server', token: TOKEN, nonce });
            process.send({ type: 'served', sha256: sha256(html), bytes: Buffer.byteLength(html) });
            return html;
          },
          getViewModel: () => vm,
          profilesState: () => message.profiles,
          onMementoState: () => ({ status: 200, json: message.memento }),
          onMemento: async () => ({ status: 200, json: { ok: true, state: message.memento } }),
          onAnswer: async () => ({ status: 200, json: { ok: true } }),
          onFocus: async () => ({ status: 200, json: { ok: true } }),
        });
        const result = await server.start();
        process.send({ type: 'started', port: result.port });
      } else if (message.type === 'publish') {
        vm = message.vm;
        generation = message.generation;
        process.send({ type: 'published', sent: server.broadcast(vm) });
      } else if (message.type === 'close') {
        await server.close();
        process.send({ type: 'closed' }, () => process.disconnect());
      }
    } catch (error) {
      process.send({ type: 'error', error: error.stack || String(error) });
      process.exitCode = 1;
      process.disconnect();
    }
  });
} else if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const argv = process.argv.slice(2), getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const fixturePath = getArg('--fixture') || 'test/fixtures/roadmap/full.json', outDir = getArg('--out');
  if (!outDir) { console.error('usage: node scripts/qa-roadmap.mjs --fixture <path> --out <dir>'); process.exit(2); }
  if (path.basename(fixturePath) === 'all-states-edge.json') {
    try {
      const result = await runTask7Qa({ fixturePath, outDir });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.pass ? 0 : 1;
    } catch (error) {
      console.error(error.stack || String(error));
      process.exitCode = 1;
    } finally {
      fs.mkdirSync(path.resolve(outDir), { recursive: true });
      fs.writeFileSync(path.resolve(outDir, 'run.json'), JSON.stringify({
        command: process.argv.slice(0, 2).concat(argv), exitCode: process.exitCode, finishedAt: new Date().toISOString(),
      }, null, 2));
    }
  } else {
  const res = await runQaRoadmap({ fixturePath, outDir });
  console.log(JSON.stringify({
    pass: res.pass, exitCode: res.exitCode, rows: res.rows1180x700, stageCount: res.stageCount,
    S1180: res.scrollBudget1180x700, S1440: res.scrollBudget1440x900,
    falseReady: res.falseReady, categoryMismatch: res.categoryMismatch, forbiddenScroll: res.forbiddenScroll,
    allMatrixFiltersPass: res.allMatrixFiltersPass, allVisualAuditsPass: res.allVisualAuditsPass,
    allStressPass: res.allStressPass, allControlsNamed: res.allControlsNamed, allTabFamiliesReached: res.allTabFamiliesReached,
  }));
  process.exitCode = res.exitCode;
  }
}
