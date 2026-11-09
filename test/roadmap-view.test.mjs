import '../test/helpers/refuse-live-writes.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { roadmapModels } from '../src/roadmap-model.mjs';
import { makeController } from './fixtures/controller-dom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FULL_FIXTURE = JSON.parse(read('test/fixtures/roadmap/full.json'));
const NOW = Date.parse('2026-11-05T03:00:00.000Z');

test('sheet stays outside the board when a stage changes columns', () => {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'roadmap-view', 'workers-view', 'convo-view', 'shell', 'annotate'] });
  const roadmaps = buildFullRoadmaps();
  e.page.receive({ seq: 1, gen: 9, generatedAt: NOW, sessions: [], roadmaps });
  e.fire(e.document.querySelector('#rail [data-sh="view"][data-key="plans"]'), 'click');
  const card = e.byId.main.querySelector('[data-rm-stage="R6b"] [data-act="exp"]');
  card.focus(); e.fire(card, 'click');
  const host = e.byId.main.querySelector('#rm-sheet-host');
  assert.ok(host, 'sheet has a stable host');
  assert.equal(host.closest('.rm-board'), null);
  const content = host.querySelector('.rm-sheet-title').textContent;
  const changed = buildFullRoadmaps();
  const stage = changed.flatMap(r => r.stages).find(s => s.id === 'R6b');
  Object.assign(stage, { ready: false, blocked: false, running: false, decisionNeeded: true, held: false, unknown: false, terminal: false });
  e.advance(600);
  e.page.receive({ seq: 2, gen: 9, generatedAt: NOW + 1000, sessions: [], roadmaps: changed });
  assert.equal(e.byId.main.querySelector('#rm-sheet-host'), host);
  assert.equal(host.querySelector('.rm-sheet-title').textContent, content);
  assert.ok(e.byId.main.querySelector('[data-rm-col="decisionNeeded"] [data-rm-stage="R6b"]'));
  const board = e.byId.main.querySelector('.rm-board');
  assert.ok(board.hasAttribute('inert'));
  assert.equal(board.getAttribute('aria-hidden'), 'true');
  const other = e.byId.main.querySelector('[data-rm-stage="R1"] [data-act="exp"]');
  e.fire(other, 'click');
  assert.equal(e.byId.main.querySelector('#rm-sheet-host'), host, 'background card handler does not change the open sheet');
  assert.equal(other.getAttribute('aria-expanded'), 'false');
  e.fire(host.querySelector('[data-act="rm-sheet-close"]'), 'click');
  assert.equal(e.document.activeElement, e.byId.main.querySelector('[data-rm-stage="R6b"] [data-act="exp"]'));
  assert.equal(e.byId.main.querySelector('.rm-board').hasAttribute('inert'), false);
});

test('closing a moved mobile sheet falls back to the heading when the opener cannot receive focus', () => {
  for (const method of ['button', 'Escape']) {
    const e = makeController({ modules: ['icons', 'view', 'plan-view', 'roadmap-view', 'workers-view', 'convo-view', 'shell', 'annotate'] });
    e.page.receive({ seq: 1, gen: 9, generatedAt: NOW, sessions: [], roadmaps: buildFullRoadmaps() });
    e.fire(e.document.querySelector('#rail [data-sh="view"][data-key="plans"]'), 'click');
    const card = e.byId.main.querySelector('[data-rm-stage="R6b"] [data-act="exp"]');
    e.fire(card, 'click');
    const changed = buildFullRoadmaps();
    const stage = changed.flatMap(r => r.stages).find(s => s.id === 'R6b');
    Object.assign(stage, { ready:false, blocked:false, running:false, decisionNeeded:true, held:false, unknown:false, terminal:false });
    e.advance(600);
    e.page.receive({ seq: 2, gen: 9, generatedAt: NOW + 1000, sessions: [], roadmaps: changed });
    const moved = e.byId.main.querySelector('[data-rm-col="decisionNeeded"] [data-rm-stage="R6b"] [data-act="exp"]');
    assert.ok(moved);
    const proto = Object.getPrototypeOf(moved), focus = proto.focus;
    proto.focus = function (...args) {
      if (this.getAttribute('data-act') === 'exp' && this.closest('[data-rm-col="decisionNeeded"]')) return;
      return focus.apply(this, args);
    };
    try {
      const dlg = e.byId.main.querySelector('.rm-sheet-dialog');
      if (method === 'button') e.fire(dlg.querySelector('[data-act="rm-sheet-close"]'), 'click');
      else e.fire(dlg, 'keydown', { key:'Escape' });
      assert.equal(e.document.activeElement, e.byId.main.querySelector('.rm-title'), method);
    } finally {
      proto.focus = focus;
    }
  }
});

function loadRuntime() {
  const ctx = {};
  for (const file of ['icons.js', 'view.js', 'plan-view.js', 'roadmap-view.js']) {
    vm.runInNewContext(read('src/page/' + file), ctx, { filename: file });
  }
  return ctx;
}

function buildFullRoadmaps(now = NOW) {
  const records = FULL_FIXTURE.projections.map((projection, i) => ({
    definition: {
      roadmapId: i === 0 ? 'rm5mode000001' : 'rmunity000002',
      revision: i + 1,
      projectionPath: i === 0
        ? 'C:/Users/USER/orca/projects/기타 작업/.omo/roadmaps/five-mode.json'
        : 'C:/Users/USER/orca/projects/기타 작업/.omo/roadmaps/unity-port.json',
      projection,
    },
    status: {
      schema: 'omo-roadmap-status/1',
      definitionRevision: i + 1,
      checkedAt: new Date(now - 5_000).toISOString(),
      error: null,
      stages: projection.stages.map((st) => ({
        id: st.id,
        plans: st.plans.map((p) => ({
          path: p.path,
          planId: 'p_' + st.id.toLowerCase(),
          taskIds: p.taskIds,
          tasks: [{ id: '1', mark: ' ', conflict: false, dependenciesKnown: true, deps: [], last: null }],
          coverage: false,
          work: null,
          errors: [{ code: 'PLAN_HASH', path: p.path }],
        })),
        requires: st.requires.map((c) => (c.kind === 'decision' ? { ...c, state: c.decisionId === null ? 'unasked' : 'unknown' } : c)),
        accepts: st.accepts,
      })),
    },
  }));
  return roadmapModels(records, now);
}

test('classic script loads standalone in a bare VM context without DOM or sibling globals', () => {
  const ctx = {};
  vm.runInNewContext(read('src/page/roadmap-view.js'), ctx, { filename: 'roadmap-view.js' });
  assert.equal(typeof ctx.BriefRoadmapView?.render, 'function');
  assert.equal(typeof ctx.BriefRoadmapView?.countsOf, 'function');
  assert.equal(typeof ctx.BriefRoadmapView?.filterStages, 'function');
  assert.equal(typeof ctx.BriefRoadmapView?.progressText, 'function');
  const html = ctx.BriefRoadmapView.render({ roadmaps: [] }, {});
  assert.ok(html.includes('등록된 로드맵 없음'));
});

test('full projection renders all 25 stage summary rows expanded by default with details folded and zero percentages', () => {
  const { BriefRoadmapView } = loadRuntime();
  const roadmaps = buildFullRoadmaps();
  const html = BriefRoadmapView.render({ generatedAt: NOW, roadmaps, sessions: [] }, {});

  const stageMatches = [...html.matchAll(/data-rm-stage="([^"]+)"/g)].map((m) => m[1]);
  const expectedIds = FULL_FIXTURE.projections.flatMap((p) => p.stages.map((s) => s.id));
  assert.equal(stageMatches.length, 25, 'all 25 stages render across the 5 columns and attention region');
  assert.deepEqual(new Set(stageMatches), new Set(expectedIds), 'all 25 unique stage ids from R, T, and U are present');

  const renderedKeys = [...html.matchAll(/data-rm-key="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(renderedKeys.length, 25, 'all 25 unique roadmapId:stageId keys rendered');
  assert.equal(new Set(renderedKeys).size, 25, 'no duplicate keys rendered');

  const trackMatches = [...new Set([...html.matchAll(/data-rm-track="([^"]+)"/g)].map((m) => m[1]))];
  assert.deepEqual(trackMatches.sort(), ['R', 'T', 'U'].sort(), 'cards carry track attributes for R, T, and U');

  const expButtons = [...html.matchAll(/class="[^"]*rm-exp-btn[^"]*"[^>]*aria-expanded="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(expButtons.length, 25);
  assert.ok(expButtons.every((v) => v === 'false'), 'all 25 stage detail disclosures start folded');
  assert.equal((html.match(/data-rm-detail="/g) || []).length, 0, 'no detail panel is rendered when folded');
  assert.doesNotMatch(html, /외 \d+개/, 'no stage summary rows are hidden behind a more-count button');
  assert.equal(html.includes('%'), false, 'no global or track percentage is rendered');
});

test('independent today filters count overlapping decisionNeeded+blocked stages separately and exclude terminal stages', () => {
  const { BriefRoadmapView } = loadRuntime();
  const makeStage = (id, flags) => ({
    id,
    label: id,
    goal: id + ' 목표',
    sourceId: 'S',
    requires: flags.requires || [],
    accepts: flags.accepts || [],
    plans: flags.plans || [{ path: '/p/' + id + '.md' }],
    requirementsKnown: flags.requirementsKnown ?? true,
    note: flags.note || '',
    progress: flags.progress || { doneConfirmed: 0, denominator: 2, observedUniqueIds: 2, excluded: 0, unconfirmed: 0, conflicts: 0 },
    accepted: flags.accepted || 'unknown',
    terminal: Boolean(flags.terminal),
    held: Boolean(flags.held),
    running: Boolean(flags.running),
    ready: Boolean(flags.ready),
    decisionNeeded: Boolean(flags.decisionNeeded),
    blocked: Boolean(flags.blocked),
    unknown: Boolean(flags.unknown),
  });

  const roadmaps = [{
    roadmapId: 'rm_test',
    projectionPath: 'C:/proj/.omo/roadmaps/test.json',
    revision: 3,
    checkedAt: new Date(NOW).toISOString(),
    stale: false,
    error: null,
    tracks: [{ id: 'T', label: '트랙', stageIds: ['S_ready', 'S_dec', 'S_blk', 'S_both', 'S_held', 'S_unk', 'S_done'] }],
    stages: [
      makeStage('S_ready', { ready: true }),
      makeStage('S_dec', { decisionNeeded: true, requires: [{ kind: 'decision', gateId: 'g1', decisionId: null, scope: '범위', operation: 'implement' }] }),
      makeStage('S_blk', { blocked: true }),
      makeStage('S_both', { decisionNeeded: true, blocked: true }),
      makeStage('S_held', { held: true, unknown: true, requires: [{ kind: 'decision', gateId: 'g2', decisionId: 395, state: 'held', scope: '보류 범위', operation: 'implement' }] }),
      makeStage('S_unk', { unknown: true, requirementsKnown: false }),
      makeStage('S_done', { terminal: true, accepted: 'pass', decisionNeeded: true, blocked: true, progress: { doneConfirmed: 2, denominator: 2, observedUniqueIds: 2, excluded: 0, unconfirmed: 0, conflicts: 0 } }),
    ],
  }];

  const counts = { ...BriefRoadmapView.countsOf(roadmaps) };
  assert.deepEqual(counts, {
    all: 7,
    ready: 1,
    decisionNeeded: 2, // S_dec and S_both (S_done excluded because terminal; S_held excluded because held)
    blocked: 2,        // S_blk and S_both (S_done excluded because terminal)
    unknown: 2,        // S_held and S_unk
    held: 1,           // S_held
    terminal: 1,       // S_done
  });

  const placement = BriefRoadmapView.placeStages(roadmaps, null);
  assert.deepEqual(Array.from(placement.columns.ready, (e) => e.stage.id), ['S_ready']);
  assert.deepEqual(Array.from(placement.columns.decisionNeeded, (e) => e.stage.id), ['S_dec']);
  assert.deepEqual(Array.from(placement.columns.blocked, (e) => e.stage.id), ['S_blk', 'S_both']);
  assert.deepEqual(Array.from(placement.columns.done, (e) => e.stage.id), ['S_done']);
  assert.deepEqual(Array.from(placement.attention.items, (e) => e.stage.id), ['S_held', 'S_unk']);
  const sBothEntry = placement.columns.blocked.find((e) => e.stage.id === 'S_both');
  assert.ok(sBothEntry.badges.some((b) => b.code === 'decisionNeeded'), 'S_both retains decisionNeeded badge');

  const allRendered = [
    ...BriefRoadmapView.render({ generatedAt: NOW, roadmaps, sessions: [] }, {})
      .matchAll(/data-rm-stage="([^"]+)"/g),
  ].map((m) => m[1]);
  assert.equal(allRendered.length, 7);
  assert.deepEqual(new Set(allRendered), new Set(['S_ready', 'S_dec', 'S_blk', 'S_both', 'S_held', 'S_unk', 'S_done']));

  const allHtml = BriefRoadmapView.render({ generatedAt: NOW, roadmaps, sessions: [] }, { roadmapFilter: 'all' });
  assert.ok(allHtml.includes('보류 #395'), 'held stage preserves 보류 #N badge in all view');
});

test('progressText formats unwritten plans, incomplete coverage, empty work, exclusions, conflicts, and unconfirmed exit without percentages', () => {
  const { BriefRoadmapView } = loadRuntime();

  assert.equal(
    BriefRoadmapView.progressText({
      plans: [],
      progress: { doneConfirmed: 0, denominator: null, observedUniqueIds: 0, excluded: 0, unconfirmed: 0, conflicts: 0 },
    }),
    '계획 미작성'
  );

  assert.equal(
    BriefRoadmapView.progressText({
      plans: [{ path: '/p/a.md' }],
      progress: { doneConfirmed: 1, denominator: null, observedUniqueIds: 4, excluded: 0, unconfirmed: 0, conflicts: 0 },
    }),
    '집계 불완전 · 관측 ID 4개'
  );

  assert.equal(
    BriefRoadmapView.progressText({
      plans: [{ path: '/p/empty.md' }],
      progress: { doneConfirmed: 0, denominator: 0, observedUniqueIds: 1, excluded: 1, unconfirmed: 0, conflicts: 0 },
    }),
    '작업 없음 · 제외 1'
  );

  assert.equal(
    BriefRoadmapView.progressText({
      plans: [{ path: '/p/work.md' }],
      accepted: 'unknown',
      progress: { doneConfirmed: 2, denominator: 3, observedUniqueIds: 5, excluded: 1, unconfirmed: 1, conflicts: 1 },
    }),
    '2/3 · 제외 1 · 충돌 1'
  );

  assert.equal(
    BriefRoadmapView.progressText({
      plans: [{ path: '/p/done.md' }],
      accepted: 'unknown',
      progress: { doneConfirmed: 3, denominator: 3, observedUniqueIds: 3, excluded: 0, unconfirmed: 0, conflicts: 0 },
    }),
    '3/3 · 수용 미확인'
  );

  assert.equal(
    BriefRoadmapView.progressText({
      plans: [{ path: '/p/accepted.md' }],
      accepted: 'pass',
      progress: { doneConfirmed: 3, denominator: 3, observedUniqueIds: 3, excluded: 0, unconfirmed: 0, conflicts: 0 },
    }),
    '3/3'
  );
});

test('expanded stage detail renders conditions, plan links, decision actions, and preserves session plans list below rail', () => {
  const { BriefRoadmapView } = loadRuntime();
  const planPath = 'C:/Users/USER/orca/projects/기타 작업/.omo/plans/board-tabs-one-per-window.md';
  const roadmaps = [{
    roadmapId: 'rm1',
    projectionPath: 'C:/Users/USER/orca/projects/기타 작업/.omo/roadmaps/five-mode.json',
    revision: 2,
    checkedAt: new Date(NOW).toISOString(),
    stale: false,
    error: null,
    tracks: [{ id: 'R', label: '다섯 모드', stageIds: ['R1b'] }],
    stages: [{
      id: 'R1b',
      label: 'R1b 탭 정리',
      goal: '상황판 탭 정리',
      sourceId: 'R',
      requirementsKnown: true,
      note: 'R1 일부 조건 별도 확인',
      requires: [
        { kind: 'stage', id: 'R0' },
        { kind: 'decision', gateId: 'g-open', decisionId: 42, state: 'open', scope: '구현 승인', operation: 'implement' },
      ],
      accepts: [
        { kind: 'receipt', path: 'C:/Users/USER/orca/projects/기타 작업/.omo/receipts/r1b.json', operation: 'accept', state: 'pass' },
      ],
      plans: [{ path: planPath, planId: 'p_r1b', taskIds: ['1', '2'], errors: [] }],
      progress: { doneConfirmed: 1, denominator: 2, observedUniqueIds: 2, excluded: 0, unconfirmed: 0, conflicts: 0 },
      accepted: 'unknown',
      terminal: false,
      held: false,
      running: false,
      ready: false,
      decisionNeeded: true,
      blocked: false,
      unknown: false,
    }],
  }];

  const sessions = [{
    id: 'sess-r1b',
    title: '탭 정리 세션',
    workName: 'board-tabs-one-per-window',
    plan: {
      planId: 'p_r1b',
      stage: 'running',
      goal: '창당 탭 하나 유지',
      source: { slug: 'board-tabs-one-per-window', planPath },
      tasks: [{ id: '1', state: 'done' }, { id: '2', state: 'doing' }],
      questions: [],
    },
    decisions: [{
      id: 42,
      sessionId: 'sess-r1b',
      question: '구현을 시작할까요?',
      recommend: 'A',
      options: { A: { text: '승인' }, B: { text: '보류' } },
      answered: false,
      closed: false,
    }],
  }];

  const html = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps, sessions },
    { expanded: { 'rm-stage:rm1:R1b': true } }
  );

  assert.ok(html.includes('data-rm-detail="R1b"'), 'stage detail opens when its exp key is true');
  assert.ok(html.includes('data-sh="open" data-sid="sess-r1b" data-sub="plan"'), 'stage links to the plan conversation sub-tab');
  assert.ok(html.includes('data-sh="open" data-sid="sess-r1b" data-sub="dec"'), 'open decision condition links to the decision sub-tab');
  assert.ok(html.includes('data-copy="/decide 42A"'), 'open decision condition offers /decide copy');
  assert.ok(html.includes('class="plan-link"'), 'reuses BriefPlanView.renderLink');
  assert.ok(html.includes('class="rm-session-plans"'), 'preserves session plans section below the rail');
});

test('legacy model, empty registration, stale/error banners, malformed stage guard, and XSS escaping', () => {
  const { BriefRoadmapView } = loadRuntime();

  // 1. Legacy model without roadmaps property
  const legacyHtml = BriefRoadmapView.render({ generatedAt: NOW, sessions: [] }, {});
  assert.ok(legacyHtml.includes('rm-legacy'), 'legacy snapshot without roadmaps shows degraded notice');
  assert.ok(legacyHtml.includes('구세대 데이터'));

  // 2. Zero registered roadmaps
  const emptyHtml = BriefRoadmapView.render({ generatedAt: NOW, roadmaps: [], sessions: [] }, {});
  assert.ok(emptyHtml.includes('rm-empty'), 'empty roadmaps array shows empty registration state');
  assert.ok(emptyHtml.includes('등록된 로드맵 없음'));

  // 3. Stale + error + malformed ready=true + XSS strings
  const xss = '<script>globalThis.pwned=1</script>"\'` onclick="alert(1)"';
  const hostileRoadmaps = [{
    roadmapId: xss,
    projectionPath: xss,
    revision: 1,
    checkedAt: new Date(NOW - 120_000).toISOString(),
    stale: true,
    error: { code: xss, message: xss },
    tracks: [{ id: xss, label: xss, stageIds: [xss, 'constructor', '__proto__'] }],
    stages: [
      {
        id: xss,
        label: xss,
        goal: xss,
        sourceId: xss,
        note: xss,
        requirementsKnown: false,
        ready: true, // malformed: claims ready=true despite stale, error, requirementsKnown=false, and missing denominator
        requires: [{ kind: 'decision', gateId: xss, decisionId: null, scope: xss, operation: xss }],
        accepts: [{ kind: 'receipt', path: xss, operation: xss, state: 'fail' }],
        plans: [{ path: xss, taskIds: null, errors: [{ code: xss }] }],
      },
      { id: 'constructor', label: 'proto', ready: true },
    ],
  }];

  const xssHtml = BriefRoadmapView.render(
    { generatedAt: NOW, readErrors: ['roadmaps/' + xss], roadmaps: hostileRoadmaps, sessions: [] },
    { roadmapFilter: '__proto__', expanded: { ['rm-stage:' + xss + ':' + xss]: true } }
  );

  assert.equal(xssHtml.includes('<script>'), false, 'raw script tag never survives');
  assert.ok(xssHtml.includes('&lt;script&gt;'), 'script tag is escaped');
  assert.equal(xssHtml.includes('onclick="alert(1)"'), false, 'injected attribute never survives');
  assert.equal(xssHtml.includes('data-rm-badge="ready"'), false, 'malformed/stale stage never renders as ready');
  assert.ok(xssHtml.includes('이전 유효 구조 보존'), 'error banner notes preserved structure');
});

test('page.js integration: rail plans view, filter switching, detail toggle, refresh focus preservation, and plan conversation navigation', () => {
  const e = makeController({
    modules: ['icons', 'view', 'plan-view', 'roadmap-view', 'workers-view', 'convo-view', 'shell', 'annotate'],
  });

  const roadmaps = buildFullRoadmaps();
  const planPath = 'C:/Users/USER/orca/projects/기타 작업/.omo/plans/board-tabs-one-per-window.md';
  const sessions = [{
    id: 's-plan-1',
    title: '탭 정리 작업',
    alive: true,
    status: 'in_progress',
    workName: 'board-tabs-one-per-window',
    lastActivityAt: NOW,
    decisions: [],
    plan: {
      planId: 'p_r1b',
      stage: 'running',
      goal: '상황판 탭 정리',
      source: { slug: 'board-tabs-one-per-window', planPath },
      tasks: [{ id: '1', state: 'doing', label: '구현' }],
      questions: [],
    },
  }];

  e.page.receive({ seq: 1, gen: 9, generatedAt: NOW, sessions, roadmaps });

  // Switch to plans view via left rail
  const plansRailBtn = e.document.querySelector('#rail [data-sh="view"][data-key="plans"]');
  assert.ok(plansRailBtn);
  e.fire(plansRailBtn, 'click');
  assert.equal(e.page.state.ui.view, 'plans');
  assert.equal(e.byId.main.querySelectorAll('[data-rm-stage]').length, 25, 'all 25 stages rendered in #main');

  // Test track filter: switch to track U
  const trackSelect = e.byId.main.querySelector('#rm-track');
  assert.ok(trackSelect, 'track select exists in toolbar');
  trackSelect.value = 'U';
  e.fire(trackSelect, 'change');
  assert.equal(e.page.state.ui.roadmapTrack, 'U');
  const uStages = [...e.byId.main.querySelectorAll('[data-rm-stage]')].map((el) => el.getAttribute('data-rm-stage'));
  assert.deepEqual(uStages, ['U0', 'U1', 'U2', 'U3', 'U4'], 'only track U stages visible when track=U');

  // Test search: search for 'R6b' after resetting track to all
  const trackSelectReset = e.byId.main.querySelector('#rm-track');
  trackSelectReset.value = 'all';
  e.fire(trackSelectReset, 'change');
  assert.equal(e.page.state.ui.roadmapTrack, 'all');

  const searchInput = e.byId.main.querySelector('#rm-search');
  assert.ok(searchInput, 'search input exists in toolbar');
  searchInput.value = 'R6b';
  e.fire(searchInput, 'input');
  assert.equal(e.page.state.ui.roadmapSearch, 'R6b');
  const searchedStages = [...e.byId.main.querySelectorAll('[data-rm-stage]')].map((el) => el.getAttribute('data-rm-stage'));
  assert.deepEqual(searchedStages, ['R6b']);

  // Expand R6b detail and focus its toggle button
  const expBtn = e.byId.main.querySelector('[data-act="exp"][data-key="rm-stage:rm5mode000001:R6b"]');
  assert.ok(expBtn);
  expBtn.focus();
  e.fire(expBtn, 'click');
  assert.ok(e.byId.main.querySelector('[data-rm-detail="R6b"]'), 'R6b detail is expanded');

  // Simulate background model refresh (seq 2): search, expanded detail, and focus must survive
  const keptBefore = e.byId.main.querySelector('.rm-sheet-tab[aria-selected="true"]');
  keptBefore.focus();
  e.advance(600);
  e.page.receive({ seq: 2, gen: 9, generatedAt: NOW + 1000, sessions, roadmaps: buildFullRoadmaps(NOW + 1000) });
  assert.equal(e.page.state.ui.roadmapSearch, 'R6b', 'search survives refresh');
  assert.ok(e.byId.main.querySelector('[data-rm-detail="R6b"]'), 'expanded detail survives refresh');
  const keptAfter = e.byId.main.querySelector('.rm-sheet-tab[aria-selected="true"]');
  assert.equal(e.document.activeElement, keptAfter, 'focused control inside #main is preserved across refresh');

  // Clear search via clear button
  e.fire(e.byId.main.querySelector('[data-act="rm-sheet-close"]'), 'click');
  const clearBtn = e.byId.main.querySelector('[data-act="rm-clear-search"]');
  assert.ok(clearBtn, 'clear search button appears when search has value');
  e.fire(clearBtn, 'click');
  assert.equal(e.page.state.ui.roadmapSearch, '');
  assert.equal(e.byId.main.querySelectorAll('[data-rm-stage]').length, 25);
  const planGo = e.byId.main.querySelector('[data-rm-stage="R1b"] .rm-plan-go');
  assert.ok(planGo, 'R1b row has quick plan open button for matching board session');
  e.fire(planGo, 'click');
  assert.equal(e.page.state.ui.view, 'conv', 'clicking plan entry routes to conversation view');
  assert.ok(e.byId.main.querySelector('.cv-page[data-sid="s-plan-1"]'), 'opens the plan conversation in #main');
  assert.deepEqual(e.errors, []);
});

// Expose normalization only in the test VM; the shipped classic-script API stays additive.
function placementRuntime() {
  const ctx = {};
  const source = read('src/page/roadmap-view.js').replace(
    'g.BriefRoadmapView = {',
    'g.testNormRoadmaps = normRoadmaps; g.testIndexBoard = indexBoard; g.BriefRoadmapView = {'
  );
  vm.runInNewContext(source, ctx);
  return ctx;
}

function placementFixture(stages, overrides = {}) {
  return {
    roadmapId: 'rm', stale: false, error: null,
    tracks: [{ id: 'T', stageIds: stages.map((s) => s.id) }],
    stages: stages.map((s) => ({
      requirementsKnown: true, requires: [], accepts: [], plans: [],
      progress: { denominator: 2, doneConfirmed: 0, conflicts: 0 },
      ...s,
    })),
    ...overrides,
  };
}

const placementEvidence = [];
function runPlacement(name, raw, board) {
  const ctx = placementRuntime();
  const normalized = ctx.testNormRoadmaps(raw);
  const before = JSON.stringify(normalized);
  const result = ctx.BriefRoadmapView.placeStages(normalized, board && ctx.testIndexBoard(board));
  assert.equal(JSON.stringify(normalized), before, 'placement must not mutate normalized objects or raw projections');
  for (const entry of result.order) {
    assert.ok(normalized.some((rm) => rm.roadmapId === entry.roadmapId && rm.stages.includes(entry.stage)));
  }
  placementEvidence.push({
    case: name,
    input: raw,
    result: Array.from(result.order, (entry) => ({
      key: entry.key,
      bucket: entry.column === 'attention' && result.attention.discarded.includes(entry) ? 'attention.discarded' :
        entry.column === 'attention' ? 'attention.items' : entry.column,
      badges: Array.from(entry.badges, (badge) => ({ ...badge })),
    })),
  });
  return result;
}
after(() => {
  if (process.env.ROADMAP_PLACEMENT_EVIDENCE) {
    fs.writeFileSync(process.env.ROADMAP_PLACEMENT_EVIDENCE, JSON.stringify(placementEvidence, null, 2) + '\n');
  }
});
const codes = (entry) => Array.from(entry.badges, (badge) => badge.code);

test('placement assigns every full fixture stage exactly once in stable order', () => {
  const result = runPlacement('full fixture unique placement', buildFullRoadmaps());
  const buckets = [...Object.values(result.columns).flat(), ...result.attention.items, ...result.attention.discarded];
  assert.equal(result.counts.total, 25);
  assert.equal(buckets.length, 25);
  assert.equal(new Set(buckets.map((entry) => entry.key)).size, 25);
  assert.deepEqual(Array.from(result.order, (entry) => entry.stage.id), FULL_FIXTURE.projections.flatMap((p) => p.stages.map((s) => s.id)));
  assert.equal(Object.values(result.columns).reduce((sum, entries) => sum + entries.length, 0) + result.attention.items.length + result.attention.discarded.length, result.counts.total);
  for (const key of Object.keys(result.counts)) assert.equal(typeof result.counts[key], 'number');
});

test('blocked takes priority while retaining decision and unknown badges', () => {
  const result = runPlacement('blocked decision unknown', [placementFixture([{ id: 'S', blocked: true, decisionNeeded: true, unknown: true }])]);
  assert.equal(result.columns.blocked.length, 1);
  for (const code of ['blocked', 'decisionNeeded', 'unknown']) assert.ok(codes(result.order[0]).includes(code));
  assert.equal(result.counts.conditions, 1);
});

test('held and open decision gate remains decision-needed with both evidence badges', () => {
  const result = runPlacement('held open decision', [placementFixture([{ id: 'S', held: true, decisionNeeded: true,
    requires: [{ kind: 'decision', decisionId: 395, state: 'held' }, { kind: 'decision', decisionId: 396, state: 'open' }] }])]);
  assert.equal(result.columns.decisionNeeded.length, 1);
  assert.ok(codes(result.order[0]).includes('held'));
  assert.ok(codes(result.order[0]).includes('unknown'));
  assert.equal(result.order[0].badges.find((badge) => badge.code === 'held').label, '보류 #395');
});

test('stale accepted stages cannot enter done', () => {
  const result = runPlacement('stale accepted pass', [placementFixture([{ id: 'S', terminal: true, accepted: 'pass' }], { stale: true })]);
  assert.equal(result.columns.done.length, 0);
  assert.equal(result.attention.items.length, 1);
  assert.ok(codes(result.order[0]).includes('stale'));
});

test('terminal without accepted pass is a discarded attention record', () => {
  const result = runPlacement('terminal unknown', [placementFixture([{ id: 'S', terminal: true, accepted: 'unknown' }])]);
  assert.equal(result.attention.discarded.length, 1);
  assert.equal(result.columns.done.length, 0);
  assert.ok(codes(result.order[0]).includes('discarded'));
});

test('fresh accepted stage with unknown denominator is done with progress badge', () => {
  const result = runPlacement('fresh accepted unknown denominator', [placementFixture([{ id: 'S', terminal: true, accepted: 'pass', progress: { denominator: null } }])]);
  assert.equal(result.columns.done.length, 1);
  assert.ok(codes(result.order[0]).includes('progress-unknown'));
});

test('zero denominator cannot be ready', () => {
  const result = runPlacement('zero denominator', [placementFixture([{ id: 'S', ready: true, progress: { denominator: 0 } }])]);
  assert.equal(result.columns.ready.length, 0);
  assert.equal(result.attention.items.length, 1);
  assert.ok(result.order[0].reasons.length);
});

test('same stage id in separate roadmaps has separate keys', () => {
  const result = runPlacement('same stage id across roadmaps', [
    placementFixture([{ id: 'S', ready: true }], { roadmapId: 'first' }),
    placementFixture([{ id: 'S', ready: true }], { roadmapId: 'second' }),
  ]);
  assert.deepEqual(Array.from(result.order, (entry) => entry.key), ['first:S', 'second:S']);
  assert.equal(result.columns.ready.length, 2);
});

test('missing or empty condition and progress data places without throwing', () => {
  const result = runPlacement('missing conditions and progress', [placementFixture([
    { id: 'missing', requires: undefined, accepts: undefined, progress: undefined },
    { id: 'empty', requires: [], accepts: [], progress: null },
  ])]);
  assert.equal(result.attention.items.length, 2);
  assert.ok(result.order.every((entry) => codes(entry).includes('progress-unknown')));
});

test('kanban layout assigns stages to 5 columns and separate 확인 필요 region with discarded subblock', () => {
  const { BriefRoadmapView } = loadRuntime();
  const roadmaps = buildFullRoadmaps();
  const html = BriefRoadmapView.render({ generatedAt: NOW, roadmaps, sessions: [] }, {});

  // 5 columns exist in order
  const colMatches = [...html.matchAll(/data-rm-col="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(colMatches, ['ready', 'running', 'decisionNeeded', 'blocked', 'done']);

  // Separate attention region exists
  assert.ok(html.includes('id="rm-attention"'), 'attention region exists with id rm-attention');
  assert.ok(html.includes('class="rm-attention-region"'), 'attention region has dedicated class');

  // Check unique counts: 25 stages total across columns and attention
  const cardKeys = [...html.matchAll(/data-rm-key="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(cardKeys.length, 25);
  assert.equal(new Set(cardKeys).size, 25, 'every stage has a unique key and appears exactly once');
});

test('search clear control and filter restore when zero results match', () => {
  const { BriefRoadmapView } = loadRuntime();
  const roadmaps = buildFullRoadmaps();

  // No match search
  const noMatchHtml = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps, sessions: [] },
    { roadmapSearch: 'NON_EXISTENT_QUERY_XYZ' }
  );
  assert.ok(noMatchHtml.includes('rm-filter-empty'), 'shows filter empty state');
  assert.ok(noMatchHtml.includes('data-act="rm-clear-all-filters"'), 'provides filter restore button');
  assert.ok(noMatchHtml.includes('지우기'), 'contains clear button text');
  assert.equal((noMatchHtml.match(/data-rm-key=/g) || []).length, 0, 'zero cards rendered on no match');

  // Active search shows clear search button in toolbar
  const searchMatchHtml = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps, sessions: [] },
    { roadmapSearch: 'U0' }
  );
  assert.ok(searchMatchHtml.includes('data-act="rm-clear-search"'), 'toolbar shows clear search button');
  assert.ok(searchMatchHtml.includes('표시 1 / 전체 25단계'), 'shows 표시 N / 전체 M separation');
});

test('track filter restricts cards while preserving total count', () => {
  const { BriefRoadmapView } = loadRuntime();
  const roadmaps = buildFullRoadmaps();

  const trackHtml = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps, sessions: [] },
    { roadmapTrack: 'T' }
  );
  const trackStages = [...trackHtml.matchAll(/data-rm-stage="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(trackStages, ['T1', 'T2', 'T3', 'T4', 'T5']);
  assert.ok(trackHtml.includes('표시 5 / 전체 25단계'));
});

test('duplicate stage id across roadmaps renders as two distinct cards with independent keys', () => {
  const { BriefRoadmapView } = loadRuntime();
  const duplicateRoadmaps = [
    {
      roadmapId: 'rm_alpha',
      projectionPath: '/path/a.json',
      revision: 1,
      checkedAt: new Date(NOW).toISOString(),
      stale: false,
      error: null,
      tracks: [{ id: 'T', label: 'Track Alpha', stageIds: ['SHARED_STAGE'] }],
      stages: [{
        id: 'SHARED_STAGE', label: '공유 단계 Alpha', goal: 'Alpha 목표', sourceId: 'T',
        requirementsKnown: true, requires: [], accepts: [], plans: [],
        progress: { denominator: 2, doneConfirmed: 0, conflicts: 0 },
        ready: true,
      }],
    },
    {
      roadmapId: 'rm_beta',
      projectionPath: '/path/b.json',
      revision: 1,
      checkedAt: new Date(NOW).toISOString(),
      stale: false,
      error: null,
      tracks: [{ id: 'T', label: 'Track Beta', stageIds: ['SHARED_STAGE'] }],
      stages: [{
        id: 'SHARED_STAGE', label: '공유 단계 Beta', goal: 'Beta 목표', sourceId: 'T',
        requirementsKnown: true, requires: [], accepts: [], plans: [],
        progress: { denominator: 2, doneConfirmed: 0, conflicts: 0 },
        ready: true,
      }],
    },
  ];

  const html = BriefRoadmapView.render({ generatedAt: NOW, roadmaps: duplicateRoadmaps, sessions: [] }, {});
  const keys = [...html.matchAll(/data-rm-key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['rm_alpha:SHARED_STAGE', 'rm_beta:SHARED_STAGE']);
  assert.equal(keys.length, 2, 'duplicate stage id across roadmaps produces 2 cards');
});


test('task 4: sheet detail with summary, evidence, and history tabs renders correct data for unique key', () => {
  const { BriefRoadmapView } = loadRuntime();
  const roadmaps = [{
    roadmapId: 'rm_u',
    projectionPath: 'C:/project/roadmap.json',
    revision: 1,
    checkedAt: new Date(NOW).toISOString(),
    stale: false,
    error: null,
    tracks: [{ id: 'U', label: 'Unity Port', stageIds: ['U0'] }],
    stages: [{
      id: 'U0', label: 'U0 경계', goal: '경계와 범위 확정', sourceId: 'U',
      requirementsKnown: true,
      requires: [{ kind: 'decision', gateId: 'g-init', decisionId: 101, state: 'open', scope: '경계 검토', operation: 'scope' }],
      accepts: [{ kind: 'receipt', path: 'C:/receipts/u0.json', operation: 'accept', state: 'pass' }],
      plans: [],
      progress: { denominator: 3, doneConfirmed: 1, conflicts: 0 },
      ready: true,
    }],
  }];

  // 1. When sheet is closed (no exp key), dialog is not rendered
  const closedHtml = BriefRoadmapView.render({ generatedAt: NOW, roadmaps, sessions: [] }, {});
  assert.equal(closedHtml.includes('class="rm-sheet-dialog"'), false, 'no sheet dialog when folded');

  // 2. When opened with default tab (summary)
  const summaryHtml = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps, sessions: [] },
    { expanded: { 'rm-stage:rm_u:U0': true }, roadmapTab: 'summary' }
  );
  assert.ok(summaryHtml.includes('class="rm-sheet-dialog"'), 'renders sheet dialog');
  assert.ok(summaryHtml.includes('role="dialog" aria-modal="true"'), 'has dialog and modal attributes');
  assert.ok(summaryHtml.includes('aria-labelledby="rm-sheet-title"'), 'has aria-labelledby pointing to title');
  assert.ok(summaryHtml.includes('role="tablist"'), 'has tablist for tabs');
  assert.ok(summaryHtml.includes('id="rm-tab-summary"') && summaryHtml.includes('aria-selected="true"'), 'summary tab is active');
  assert.ok(summaryHtml.includes('id="rm-tab-evidence"') && summaryHtml.includes('aria-selected="false"'), 'evidence tab is inactive');
  assert.ok(summaryHtml.includes('id="rm-panel-summary" class="rm-sheet-panel is-active"'), 'summary panel is active');
  assert.ok(summaryHtml.includes('id="rm-panel-evidence" class="rm-sheet-panel" aria-labelledby="rm-tab-evidence" hidden'), 'evidence panel is hidden');
  assert.ok(summaryHtml.includes('경계와 범위 확정'), 'shows stage goal');
  assert.ok(summaryHtml.includes('목표'), 'shows 목표 section');

  // 3. When opened with evidence tab
  const evidenceHtml = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps, sessions: [] },
    { expanded: { 'rm-stage:rm_u:U0': true }, roadmapTab: 'evidence' }
  );
  assert.ok(evidenceHtml.includes('id="rm-tab-evidence"') && evidenceHtml.includes('aria-selected="true"'), 'evidence tab is active');
  assert.ok(evidenceHtml.includes('관측 시각'), 'evidence tab shows observation time');
  assert.ok(evidenceHtml.includes('진입 조건 (1)'), 'shows requires section');
  assert.ok(evidenceHtml.includes('출구 수용 조건 (1)'), 'shows accepts section');
  assert.ok(evidenceHtml.includes('/decide 101A'), 'decision copy button is present');

  // 4. When opened with history tab and no history
  const historyHtml = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps, sessions: [] },
    { expanded: { 'rm-stage:rm_u:U0': true }, roadmapTab: 'history' }
  );
  assert.ok(historyHtml.includes('id="rm-tab-history"') && historyHtml.includes('aria-selected="true"'), 'history tab is active');
  assert.ok(historyHtml.includes('기록 없음'), 'missing history shows 기록 없음 without synthesizing entry');
  assert.ok(historyHtml.includes('연결된 계획 없음 (계획 미작성)'), 'shows unwritten plans placeholder');
});

test('task 4: duplicate stage id across two roadmaps opens the right stage detail', () => {
  const { BriefRoadmapView } = loadRuntime();
  const duplicateRoadmaps = [
    {
      roadmapId: 'rm_alpha',
      projectionPath: '/path/a.json',
      revision: 1,
      checkedAt: new Date(NOW).toISOString(),
      stale: false,
      error: null,
      tracks: [{ id: 'T', label: 'Track Alpha', stageIds: ['SHARED'] }],
      stages: [{
        id: 'SHARED', label: '공유 단계 Alpha', goal: 'Alpha 고유 목표', sourceId: 'T',
        requirementsKnown: true, requires: [], accepts: [], plans: [],
        progress: { denominator: 2, doneConfirmed: 0, conflicts: 0 },
        ready: true,
      }],
    },
    {
      roadmapId: 'rm_beta',
      projectionPath: '/path/b.json',
      revision: 1,
      checkedAt: new Date(NOW).toISOString(),
      stale: false,
      error: null,
      tracks: [{ id: 'T', label: 'Track Beta', stageIds: ['SHARED'] }],
      stages: [{
        id: 'SHARED', label: '공유 단계 Beta', goal: 'Beta 고유 목표', sourceId: 'T',
        requirementsKnown: true, requires: [], accepts: [], plans: [],
        progress: { denominator: 2, doneConfirmed: 0, conflicts: 0 },
        ready: true,
      }],
    },
  ];

  // Open rm_beta:SHARED
  const html = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps: duplicateRoadmaps, sessions: [] },
    { expanded: { 'rm-stage:rm_beta:SHARED': true }, roadmapTab: 'summary' }
  );

  assert.ok(html.includes('data-rm-key="rm_beta:SHARED"'), 'sheet carries the rm_beta key');
  assert.ok(html.includes('Beta 고유 목표'), 'sheet renders Beta goal');
  const sheetMatch = html.match(/<dialog[^>]*class="rm-sheet-dialog"[\s\S]*?<\/dialog>/);
  assert.ok(sheetMatch, 'sheet dialog is rendered');
  assert.ok(sheetMatch[0].includes('Beta 고유 목표'), 'sheet dialog renders Beta goal');
  assert.equal(sheetMatch[0].includes('Alpha 고유 목표'), false, 'sheet dialog does not render Alpha goal');
});

test('task 4: malicious stage title and goals render escaped in sheet header and body', () => {
  const { BriefRoadmapView } = loadRuntime();
  const hostileRoadmaps = [{
    roadmapId: 'rm_hostile',
    projectionPath: '/path/h.json',
    revision: 1,
    checkedAt: new Date(NOW).toISOString(),
    stale: false,
    error: null,
    tracks: [{ id: 'H', label: 'Hostile', stageIds: ['H1'] }],
    stages: [{
      id: 'H1',
      label: '<script>alert("xss-title")</script>',
      goal: '<img src=x onerror=alert("xss-goal")>',
      sourceId: 'H',
      requirementsKnown: true, requires: [], accepts: [], plans: [],
      progress: { denominator: 1, doneConfirmed: 0, conflicts: 0 },
      ready: true,
    }],
  }];

  const html = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps: hostileRoadmaps, sessions: [] },
    { expanded: { 'rm-stage:rm_hostile:H1': true } }
  );

  assert.equal(html.includes('<script>alert'), false, 'script tag is not rendered unescaped');
  assert.ok(html.includes('&lt;script&gt;'), 'script tag is escaped');
  assert.equal(html.includes('<img src=x'), false, 'img onerror is not rendered unescaped');
  assert.ok(html.includes('&lt;img'), 'img tag is escaped');
});

test('task 5: full list preservation measured from fixture without hardcoding 57', () => {
  const { BriefRoadmapView } = loadRuntime();
  const roadmaps = buildFullRoadmaps();

  // Create N dynamic sessions with plans
  const numSessions = 8;
  const sessions = [];
  for (let i = 0; i < numSessions; i++) {
    sessions.push({
      id: 'session-' + i,
      title: '세션 ' + i,
      workName: 'work-' + i,
      plan: {
        planId: 'plan-' + i,
        stage: 'running',
        goal: '목표 ' + i,
        source: { slug: 'work-' + i, planPath: '/plans/work-' + i + '.md' },
        tasks: [{ id: '1', state: 'done' }],
        questions: [],
      },
    });
  }

  // Render Kanban view with session plans
  const kanbanHtml = BriefRoadmapView.render({ generatedAt: NOW, roadmaps, sessions }, {});
  assert.ok(kanbanHtml.includes('class="rm-session-plans"'), 'kanban view preserves session plans section');

  // Count rendered session plans rows in board view
  const splanRows = [...kanbanHtml.matchAll(/data-row="rm-splan:([^"]+)"/g)].map(m => m[1]);
  assert.equal(splanRows.length, numSessions, 'all dynamic session plans rendered in board view');

  // Switch to connected plans view
  const plansScreenHtml = BriefRoadmapView.render({ generatedAt: NOW, roadmaps, sessions }, { roadmapSubView: 'plans' });
  assert.ok(plansScreenHtml.includes('rm-connected-plans-view'), 'renders connected plans dedicated screen');
  assert.ok(plansScreenHtml.includes('data-act="rm-return-board"'), 'renders return to board button');

  // Count rendered items in connected plans view
  const cplanRows = [...plansScreenHtml.matchAll(/data-cplan-key="([^"]+)"/g)].map(m => m[1]);
  // 6 stage plans from full fixture + numSessions = total distinct plans
  const expectedTotalDistinct = numSessions + 6;
  assert.equal(cplanRows.length, expectedTotalDistinct, 'all distinct plans preserved without hardcoding 57');
});

test('task 5: duplicate slug collision renders separate candidate rows and opening one never opens the other', () => {
  const { BriefRoadmapView } = loadRuntime();

  // Two sessions having identical slug but different paths and different session IDs
  const sessions = [
    {
      id: 'sess-worker-1',
      title: '작업자 1 대화',
      workName: 'worker-1-branch',
      plan: {
        planId: 'pid-worker-1',
        stage: 'running',
        goal: '작업자 1 고유 목표',
        source: { slug: 'shared-feature-slug', planPath: '/repo/branch1/shared-feature-slug.md' },
        tasks: [{ id: '1', state: 'doing' }],
        questions: [],
      },
    },
    {
      id: 'sess-worker-2',
      title: '작업자 2 대화',
      workName: 'worker-2-branch',
      plan: {
        planId: 'pid-worker-2',
        stage: 'ready',
        goal: '작업자 2 고유 목표',
        source: { slug: 'shared-feature-slug', planPath: '/repo/branch2/shared-feature-slug.md' },
        tasks: [{ id: '1', state: 'todo' }],
        questions: [],
      },
    }
  ];

  // Stage plan with ambiguous path (only slug 'shared-feature-slug.md')
  const roadmaps = [{
    roadmapId: 'rm_col',
    revision: 1,
    checkedAt: new Date(NOW).toISOString(),
    stale: false,
    error: null,
    tracks: [{ id: 'T', label: 'Track T', stageIds: ['S1'] }],
    stages: [{
      id: 'S1',
      label: '충돌 테스트 단계',
      goal: '동명 슬러그 충돌 확인',
      sourceId: 'T',
      requirementsKnown: true, requires: [], accepts: [],
      plans: [{ path: 'shared-feature-slug.md', planId: '', taskIds: null, errors: [] }],
      progress: { denominator: 1, doneConfirmed: 0, conflicts: 0 },
      ready: true,
    }],
  }];

  // 1. Stage sheet detail with collision: candidate buttons must be rendered separately
  const detailHtml = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps, sessions },
    { expanded: { 'rm-stage:rm_col:S1': true }, roadmapTab: 'history' }
  );
  assert.ok(detailHtml.includes('동명 후보 2개'), 'stage detail flags candidate collision');
  assert.ok(detailHtml.includes('data-sid="sess-worker-1"'), 'candidate 1 links to sess-worker-1');
  assert.ok(detailHtml.includes('data-sid="sess-worker-2"'), 'candidate 2 links to sess-worker-2');
  assert.notEqual(detailHtml.indexOf('data-sid="sess-worker-1"'), detailHtml.indexOf('data-sid="sess-worker-2"'), 'candidate buttons are distinct');

  // 2. Connected plans screen: duplicate slug must show candidate notice and never merge
  const plansHtml = BriefRoadmapView.render(
    { generatedAt: NOW, roadmaps, sessions },
    { roadmapSubView: 'plans' }
  );
  assert.ok(plansHtml.includes('동명 slug 충돌 (2개 후보)'), 'connected plans view displays collision notice');
  assert.ok(plansHtml.includes('후보 1 (worker-1-branch)'), 'candidate 1 labeled with workName context');
  assert.ok(plansHtml.includes('후보 2 (worker-2-branch)'), 'candidate 2 labeled with workName context');
  assert.ok(plansHtml.includes('data-sid="sess-worker-1"'), 'candidate 1 opens sess-worker-1');
  assert.ok(plansHtml.includes('data-sid="sess-worker-2"'), 'candidate 2 opens sess-worker-2');
});

test('task 5: page.js integration: round-trip search/filter/scroll preservation and return from connected plans', () => {
  const e = makeController({
    modules: ['icons', 'view', 'plan-view', 'roadmap-view', 'workers-view', 'convo-view', 'shell', 'annotate'],
  });

  const roadmaps = buildFullRoadmaps();
  const sessions = [{
    id: 's-plan-main',
    title: '메인 계획 대화',
    alive: true,
    status: 'in_progress',
    workName: 'board-tabs-one-per-window',
    lastActivityAt: NOW,
    decisions: [],
    plan: {
      planId: 'p_r1b',
      stage: 'running',
      goal: '상황판 탭 정리',
      source: { slug: 'board-tabs-one-per-window', planPath: 'C:/Users/USER/orca/projects/기타 작업/.omo/plans/board-tabs-one-per-window.md' },
      tasks: [{ id: '1', state: 'doing' }],
      questions: [],
    },
  }];

  e.page.receive({ seq: 1, gen: 9, generatedAt: NOW, sessions, roadmaps });

  // 1. Switch to plans view
  const plansRailBtn = e.document.querySelector('#rail [data-sh="view"][data-key="plans"]');
  assert.ok(plansRailBtn);
  e.fire(plansRailBtn, 'click');
  assert.equal(e.page.state.ui.view, 'plans');
  assert.equal(e.page.state.ui.roadmapSubView, 'board');

  // 2. Set search filter with zero match
  const searchInput = e.byId.main.querySelector('#rm-search');
  assert.ok(searchInput);
  searchInput.value = 'ZERO_MATCH_STRING_12345';
  e.fire(searchInput, 'input');
  assert.equal(e.page.state.ui.roadmapSearch, 'ZERO_MATCH_STRING_12345');
  assert.ok(e.byId.main.querySelector('.rm-filter-empty'), 'zero results filter-empty is shown');

  // Set track filter to 'U'
  const trackSel = e.byId.main.querySelector('#rm-track');
  trackSel.value = 'U';
  e.fire(trackSel, 'change');
  assert.equal(e.page.state.ui.roadmapTrack, 'U');

  // Set simulated scroll position
  e.byId.main.scrollTop = 240;

  // 3. Click "연결 계획" button in header
  const openPlansBtn = e.byId.main.querySelector('[data-act="rm-connected-plans"]');
  assert.ok(openPlansBtn, '연결 계획 button exists in header');
  openPlansBtn.focus();
  e.fire(openPlansBtn, 'click');

  // Verify switched to connected plans subview
  assert.equal(e.page.state.ui.roadmapSubView, 'plans');
  assert.ok(e.byId.main.querySelector('.rm-connected-plans-view'), 'renders connected plans view');
  const returnBtn = e.byId.main.querySelector('[data-act="rm-return-board"]');
  assert.ok(returnBtn, '돌아가기 button exists');

  // 4. Click 돌아가기 button
  returnBtn.focus();
  e.fire(returnBtn, 'click');

  // Verify restored board state
  assert.equal(e.page.state.ui.roadmapSubView, 'board');
  assert.equal(e.page.state.ui.roadmapSearch, 'ZERO_MATCH_STRING_12345', 'search query preserved in memory');
  assert.equal(e.page.state.ui.roadmapTrack, 'U', 'track filter preserved in memory');
  assert.equal(e.byId.main.scrollTop, 240, 'scrollTop restored in memory');
});

test('task 5: opening a held item produces no state write and deleted plan row does not break return', () => {
  const writes = [];
  const storage = { getItem: () => null, setItem: (key, value) => writes.push([key, value]), removeItem() {} };
  const e = makeController({
    localStorage: storage,
    modules: ['icons', 'view', 'plan-view', 'roadmap-view', 'workers-view', 'convo-view', 'shell', 'annotate'],
  });

  const roadmaps = [{
    roadmapId: 'rm_held',
    projectionPath: '/path/held.json',
    revision: 1,
    checkedAt: new Date(NOW).toISOString(),
    stale: false,
    error: null,
    tracks: [{ id: 'H', label: 'Held Track', stageIds: ['H1'] }],
    stages: [{
      id: 'H1',
      label: '보류 단계',
      goal: '보류 계획 안전 탐색',
      sourceId: 'H',
      requirementsKnown: true,
      requires: [{ kind: 'decision', gateId: 'g_held', decisionId: 99, state: 'held', scope: '구현', operation: 'scope' }],
      accepts: [],
      plans: [{ path: '/plans/held-plan.md', planId: 'p_held', taskIds: null, errors: [] }],
      progress: { denominator: 1, doneConfirmed: 0, conflicts: 0 },
      held: true,
    }],
  }];

  const sessions = [{
    id: 's-held',
    title: '보류 대화',
    workName: 'held-task',
    decisions: [{ id: 99, sessionId: 's-held', question: '보류된 결정', held: true, answered: false, closed: false }],
    plan: {
      planId: 'p_held',
      stage: 'shaping',
      goal: '보류 목표',
      source: { slug: 'held-plan', planPath: '/plans/held-plan.md' },
      tasks: [],
      questions: [],
    },
  }];

  e.page.receive({ seq: 1, gen: 9, generatedAt: NOW, sessions, roadmaps });

  // Switch to plans view
  const plansRailBtn = e.document.querySelector('#rail [data-sh="view"][data-key="plans"]');
  e.fire(plansRailBtn, 'click');

  writes.length = 0;
  e.fire(e.byId.main.querySelector('[data-rm-stage="H1"] [data-act="exp"]'), 'click');
  e.fire(e.byId.main.querySelector('.rm-sheet-tab[data-tab="history"]'), 'click');
  e.fire(e.byId.main.querySelector('[data-act="rm-sheet-close"]'), 'click');
  assert.deepEqual(writes, [], 'sheet open, tab and close do not persist state');

  // Open connected plans view
  const openPlansBtn = e.byId.main.querySelector('[data-act="rm-connected-plans"]');
  e.fire(openPlansBtn, 'click');
  assert.equal(e.page.state.ui.roadmapSubView, 'plans');
  assert.deepEqual(writes, [], 'opening connected plans does not persist state');

  // Click to open held plan's conversation
  const heldPlanOpenBtn = e.byId.main.querySelector('.rm-cplan-row[data-cplan-key="pid:p_held"] .rm-cplan-open');
  assert.ok(heldPlanOpenBtn, 'held plan open button exists');
  writes.length = 0;
  e.fire(heldPlanOpenBtn, 'click');
  assert.deepEqual(writes.map(([key]) => key), ['omo-briefing.ui.v2'], 'plan navigation writes only the existing shell preference key');
  assert.equal(Object.keys(JSON.parse(writes[0][1])).some(key => /roadmap/i.test(key)), false);

  // Verify routed to conversation without state write
  assert.equal(e.page.state.ui.view, 'conv');
  assert.equal(e.page.state.ui.active, 's-held');
  assert.equal(e.page.state.decisions, undefined, 'no decisions written or created');
  assert.deepEqual(e.errors, [], 'no errors during held plan navigation');

  // Now delete the session plan from the model and switch back to plans view
  e.page.receive({ seq: 2, gen: 9, generatedAt: NOW + 1000, sessions: [], roadmaps });
  const plansRailBtn2 = e.document.querySelector('#rail [data-sh="view"][data-key="plans"]');
  e.fire(plansRailBtn2, 'click');
  assert.equal(e.page.state.ui.view, 'plans');
  assert.ok(e.byId.main.querySelector('.roadmap-view'), 'renders safely even after session plan row deleted');
});

test('mobile collapsed controls disclosure: toggle button, collapsed by default, preserves status select, first card, return btn', () => {
  const writes = [];
  const storage = { getItem: () => null, setItem: (key, value) => writes.push([key, value]), removeItem() {} };
  const e = makeController({
    localStorage: storage,
    modules: ['icons', 'view', 'plan-view', 'roadmap-view', 'workers-view', 'convo-view', 'shell', 'annotate'],
  });

  const roadmaps = buildFullRoadmaps();
  e.page.receive({ seq: 1, gen: 9, generatedAt: NOW, sessions: [], roadmaps });
  const plansRailBtn = e.document.querySelector('#rail [data-sh="view"][data-key="plans"]');
  e.fire(plansRailBtn, 'click');

  writes.length = 0;

  const main = e.byId.main;
  const toggleBtn = main.querySelector('[data-act="rm-mobile-filter-toggle"]');
  assert.ok(toggleBtn, 'disclosure toggle button exists');
  assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false', 'collapsed by default');
  assert.equal(toggleBtn.getAttribute('aria-controls'), 'rm-toolbar-collapsible', 'aria-controls points to collapsible toolbar container');

  const coll = main.querySelector('#rm-toolbar-collapsible');
  assert.ok(coll, 'collapsible container exists');
  assert.equal(coll.classList.contains('is-open'), false, 'not open by default');

  // Verify status select, first card, and return button remain outside collapsible container
  const statusSelect = main.querySelector('#rm-status');
  assert.ok(statusSelect, 'status select exists');
  assert.equal(coll.contains(statusSelect), false, 'status select is outside the collapsible container');

  const firstCard = main.querySelector('.rm-card-btn');
  assert.ok(firstCard, 'first card exists');
  assert.equal(coll.contains(firstCard), false, 'first card is outside the collapsible container');

  // Toggle open
  e.fire(toggleBtn, 'click');
  assert.equal(coll.classList.contains('is-open'), true, 'opens on click');
  assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true', 'aria-expanded is true when open');

  const search = main.querySelector('#rm-search');
  search.value = 'U';
  e.fire(search, 'input');
  const typedSearch = main.querySelector('#rm-search');
  assert.equal(main.querySelector('[data-act="rm-mobile-filter-toggle"]').getAttribute('aria-expanded'), 'true', 'typing keeps search controls open');
  assert.equal(main.querySelector('#rm-toolbar-collapsible').classList.contains('is-open'), true);
  typedSearch.value = 'U2';
  e.fire(typedSearch, 'input');
  const track = main.querySelector('#rm-track');
  track.value = 'U';
  e.fire(track, 'change');
  assert.equal(main.querySelector('#rm-search').getAttribute('value'), 'U2', 'the replacement input retains the exact typed search value');
  assert.equal(main.querySelector('#rm-toolbar-collapsible').classList.contains('is-open'), true, 'changing a track keeps controls open');
  assert.equal(writes.length, 0, 'opening and filtering do not write storage');
  e.advance(600);
  e.page.receive({ seq: 2, gen: 9, generatedAt: NOW + 1000, sessions: [], roadmaps });
  assert.equal(main.querySelector('#rm-toolbar-collapsible').classList.contains('is-open'), true, 'a data refresh preserves the disclosure choice');
  assert.equal(writes.some(([, value]) => value.includes('roadmapFiltersOpen')), false, 'the ordinary shell save excludes the ephemeral filter choice');
  writes.length = 0;

  // Toggle close
  e.fire(main.querySelector('[data-act="rm-mobile-filter-toggle"]'), 'click');
  assert.equal(main.querySelector('#rm-toolbar-collapsible').classList.contains('is-open'), false, 'closes on second click');
  assert.equal(main.querySelector('[data-act="rm-mobile-filter-toggle"]').getAttribute('aria-expanded'), 'false', 'aria-expanded is false when closed');

  // Verify no new storage key written
  assert.equal(writes.length, 0, 'no state persistence on toggle');
});
