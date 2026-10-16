import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { computePlanStatus, findPlanForSession } from '../src/plan-status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures', 'plan');
const fx = (name) => readFileSync(path.join(FX, name), 'utf8');
const PLAN_TEXT = fx('piomo-living-briefing.md');
const DRAFT_TEXT = fx('draft-piomo-briefing-plan-view.md');
const BOULDER_TEXT = fx('boulder.json');
const LEDGER_TEXT = fx('ledger.jsonl');

// Virtual project root: nothing here is ever touched on disk, readText below serves it from a map.
const ROOT = path.join(os.tmpdir(), 'omo-plan-status-virtual');
const P = (rel) => path.join(ROOT, rel);
const key = (p) => String(p).replace(/\\/g, '/');
const PLAN = P('.omo/plans/piomo-living-briefing.md');
const DRAFT = P('.omo/drafts/piomo-briefing-plan-view.md');
const BOULDER = P('.omo/boulder.json');
const LEDGER = P('.omo/ulw-execute/piomo-living-briefing-e1-01a13bd0/ledger.jsonl');
const NOW = Date.parse('2026-10-15T13:00:00.000Z');

/** In-memory readText with call log, injected faults and a sleep recorder (no real waiting). */
function env(files, { faults = {}, always = {} } = {}) {
  const calls = [];
  const sleeps = [];
  const queue = Object.fromEntries(Object.entries(faults).map(([p, codes]) => [key(p), [...codes]]));
  const readText = async (p) => {
    const k = key(p);
    calls.push(k);
    if (always[k]) throw Object.assign(new Error(always[k] + ' ' + k), { code: always[k] });
    const q = queue[k];
    if (q && q.length) {
      const code = q.shift();
      throw Object.assign(new Error(code + ' ' + k), { code });
    }
    const v = files[k];
    return v === undefined ? null : v;
  };
  const sleep = async (ms) => { sleeps.push(ms); };
  const sha256 = (text) => 'sha:' + text.length;
  return { readText, sleep, sha256, calls, sleeps };
}
const filesOf = (o) => Object.fromEntries(Object.entries(o).map(([p, v]) => [key(p), v]));
const run = (e, extra = {}) => computePlanStatus({
  planPath: PLAN, draftPath: DRAFT, boulderPath: BOULDER,
  readText: e.readText, sha256: e.sha256, sleep: e.sleep, now: NOW, ...extra,
});
const realFiles = () => filesOf({ [PLAN]: PLAN_TEXT, [DRAFT]: DRAFT_TEXT, [BOULDER]: BOULDER_TEXT, [LEDGER]: LEDGER_TEXT });
const planOnly = (text) => filesOf({ [PLAN]: text });

test('real plan copy: 21 boxes, 14 and F2 are paused, the rest done', async () => {
  const s = await run(env(realFiles()));
  assert.equal(s.schema, 'omo-plan-status/1');
  assert.equal(Object.keys(s.boxes).length, 21);
  assert.equal(s.boxes['14'], '~');
  assert.equal(s.boxes.F2, '~');
  assert.equal(Object.values(s.boxes).filter((v) => v === 'x').length, 19);
  assert.equal(s.boxes['1'], 'x');
  assert.equal(s.boxes.F4, 'x');
  assert.equal(s.at, '2026-10-15T13:00:00.000Z');
  assert.deepEqual(s.errors, []);
});

test('skeleton comes from checkbox title (14 chars) and Parallelization wave/deps', async () => {
  const s = await run(env(realFiles()));
  const byId = Object.fromEntries(s.skeleton.tasks.map((t) => [t.id, t]));
  assert.equal(s.skeleton.tasks.length, 21);
  assert.deepEqual(byId['1'], { id: '1', title: '새 소스 저장소 뼈대와 빌', wave: 1, deps: [] });
  assert.equal(byId['14'].wave, 4);
  assert.deepEqual(byId['14'].deps, ['10', '11', '12']);
  assert.deepEqual(byId['15'].deps, ['13', '14']);
  assert.equal(byId.F1.wave, null); // F rows have no Parallelization line in the real plan
  assert.deepEqual(byId.F1.deps, []);
});

test('ranges expand (F1-F4, 2-5) and 없음/none/- mean no deps', async () => {
  const plan = [
    '- [ ] 1. a', '  Parallelization: Wave 1 | Blocked by: 없음 | Blocks: 2',
    '- [ ] 2. b', '  Parallelization: Wave 1 | Blocked by: NONE | Blocks: 3',
    '- [ ] 3. c', '  Parallelization: Wave 1 | Blocked by: - | Blocks: 4',
    '- [ ] 4. d', '  Parallelization: Wave 2 | Blocked by: F1-F4 | Blocks: 5',
    '- [ ] 5. e', '  Parallelization: Wave 2 | Blocked by: 2-5, 1 , 3a | Blocks: 5',
    '- [ ] F1. f', '- [ ] F2. g', '- [ ] F3. h', '- [ ] F4. i', '',
  ].join('\n');
  const s = await run(env(planOnly(plan)));
  const d = Object.fromEntries(s.skeleton.tasks.map((t) => [t.id, t.deps]));
  assert.deepEqual(d['1'], []);
  assert.deepEqual(d['2'], []);
  assert.deepEqual(d['3'], []);
  assert.deepEqual(d['4'], ['F1', 'F2', 'F3', 'F4']);
  assert.deepEqual(d['5'], ['2', '3', '4', '5', '1', '3a']);
  assert.deepEqual(s.errors, []);
});

test('bad deps tokens are dropped and reported once; huge or reversed ranges are not expanded', async () => {
  const plan = '- [ ] 1. a\n  Parallelization: Wave 1 | Blocked by: 2, x9, 5-2, 1-99999 | Blocks: 3\n- [ ] 2. b\n';
  const s = await run(env(planOnly(plan)));
  assert.deepEqual(s.skeleton.tasks[0].deps, ['2']);
  const bad = s.errors.filter((e) => e.code === 'BAD_DEPS');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].source, 'plan');
  assert.equal(key(bad[0].path), key(PLAN));
  assert.deepEqual(bad[0].tokens, ['x9', '5-2', '1-99999']);
});

test('draftStatus is the front-matter value, not a body line', async () => {
  const real = await run(env(realFiles()));
  assert.equal(real.files.draftStatus, 'approved'); // body line 100 reads 'approved (owner ...)'
  const draft = ['---', 'slug: x', 'review:', '  plan_reviewer:', '    status: passed', 'status: "drafting"', '---', '', 'status: approved', ''].join('\n');
  const e = env(filesOf({ [PLAN]: '- [ ] 1. a\n', [DRAFT]: draft }));
  const s = await run(e);
  assert.equal(s.files.draftStatus, 'drafting');
  const noFm = await run(env(filesOf({ [PLAN]: '- [ ] 1. a\n', [DRAFT]: 'status: approved\n# t\n' })));
  assert.equal(noFm.files.draftStatus, undefined);
  assert.equal('draftStatus' in noFm.files, false);
});

test('unterminated front matter is reported, never guessed', async () => {
  const s = await run(env(filesOf({ [PLAN]: '- [ ] 1. a\n', [DRAFT]: '---\nstatus: approved\nno end\n' })));
  assert.equal(s.files.draftStatus, undefined);
  assert.ok(s.errors.some((e) => e.code === 'FRONTMATTER_UNTERMINATED'));
});

test('ledger: last in-vocabulary event per task, including task-reopened', async () => {
  const full = await run(env(realFiles()));
  assert.equal(full.ledger['4'].last, 'task-completed'); // reopened at line 42, completed again later
  assert.equal(full.ledger['4'].at, '2026-10-15T02:47:37.788Z');
  assert.equal(full.ledger['9'].last, 'task-completed');
  assert.equal(full.ledger.session, undefined); // 'goal' is not in the vocabulary
  const cut = LEDGER_TEXT.split('\n').slice(0, 70).join('\n'); // line 70 = task-reopened of task 9
  const files = realFiles();
  files[key(LEDGER)] = cut;
  const part = await run(env(files));
  assert.equal(part.ledger['9'].last, 'task-reopened');
  assert.equal(typeof part.ledger['9'].at, 'string');
});

test('ledger: events outside the vocabulary never override, file order decides ties', async () => {
  const led = [
    { event: 'dispatch', task: '1', at: 'A' },
    { event: 'done-claim', task: '1', at: 'B' },
    { event: 'verified', task: '1', at: 'C' },
    { event: 'dispatch', task: '2', at: 'D' },
    { event: 'worker-wedged', task: '2', at: 'E' },
    { event: 'dispatch', task: 3, at: 'F' },
    { event: 'partial', at: 'G' },
  ].map((o) => JSON.stringify(o)).join('\n');
  const files = realFiles();
  files[key(LEDGER)] = led;
  const s = await run(env(files));
  assert.deepEqual(s.ledger, { 1: { last: 'dispatch', at: 'A' }, 2: { last: 'worker-wedged', at: 'E' }, 3: { last: 'dispatch', at: 'F' } });
});

test('ledger: only the last 2000 raw lines are used, including blank lines', async () => {
  const old = JSON.stringify({ event: 'dispatch', task: 'old', at: 't0' });
  const current = JSON.stringify({ event: 'partial', task: '1', at: 'current' });
  const lines = [old];
  for (let i = 0; i < 2000; i++) lines.push(JSON.stringify({ event: 'partial', task: '1', at: 't' + i }));
  const files = realFiles();
  files[key(LEDGER)] = lines.join('\n');
  const s = await run(env(files));
  assert.equal(s.ledger.old, undefined);
  assert.equal(s.ledger['1'].at, 't1999');

  for (const outside of [old, 'not-json']) {
    files[key(LEDGER)] = [outside, ...Array(2001).fill(''), current].join('\n');
    const tail = await run(env(files));
    assert.deepEqual(tail.ledger, { 1: { last: 'partial', at: 'current' } });
    assert.deepEqual(tail.errors, []);
  }

  const boundary = JSON.stringify({ event: 'dispatch', task: 'boundary', at: 'first-in-window' });
  files[key(LEDGER)] = [old, boundary, ...Array(1998).fill(''), current].join('\r\n');
  const tail = await run(env(files));
  assert.deepEqual(tail.ledger, {
    1: { last: 'partial', at: 'current' },
    boundary: { last: 'dispatch', at: 'first-in-window' },
  });
  assert.deepEqual(tail.errors, []);
});

test('two works on the same plan: the most recent work supplies the ledger', async () => {
  const slug = '.omo/plans/optiscaler-nr-present-addon-options.md';
  const plan = P(slug);
  const ledgerOf = (w) => P(JSON.parse(BOULDER_TEXT).works[w].ledger ?? 'none');
  const ledPath = ledgerOf('optiscaler-nr-present-addon-options-01a0fbd1');
  const common = { [plan]: '- [ ] 1. x\n', [BOULDER]: BOULDER_TEXT, [ledPath]: '{"event":"dispatch","task":"1","at":"T"}\n' };
  // Neither fixture work has a timestamp -> insertion order, so the later one (with the ledger) wins.
  const byOrder = await computePlanStatus({ planPath: plan, boulderPath: BOULDER, ...env(filesOf(common)), now: NOW });
  assert.equal(byOrder.work.workId, 'optiscaler-nr-present-addon-options-01a0fbd1');
  assert.equal(byOrder.work.status, 'paused');
  assert.equal(byOrder.ledger['1'].last, 'dispatch');
  // Timestamps beat order: make the earlier-inserted work the newer one.
  const b = JSON.parse(BOULDER_TEXT);
  b.works['optiscaler-nr-all29-resume-01a12466'].updated_at = '2026-10-10T00:00:00Z';
  b.works['optiscaler-nr-all29-resume-01a12466'].ledger = 'other/ledger.jsonl';
  b.works['optiscaler-nr-present-addon-options-01a0fbd1'].updated_at = '2026-10-01T00:00:00Z';
  const e = env(filesOf({ ...common, [BOULDER]: JSON.stringify(b), [P('other/ledger.jsonl')]: '{"event":"partial","task":"1","at":"U"}\n' }));
  const byTime = await computePlanStatus({ planPath: plan, boulderPath: BOULDER, ...e, now: NOW });
  assert.equal(byTime.work.workId, 'optiscaler-nr-all29-resume-01a12466');
  assert.equal(byTime.ledger['1'].last, 'partial');
});

test('work and ledger are absent when no work owns the plan, and that is not an error', async () => {
  const files = realFiles();
  const s = await computePlanStatus({ planPath: P('.omo/plans/unknown.md'), boulderPath: BOULDER, ...env({ ...files, [key(P('.omo/plans/unknown.md'))]: '- [ ] 1. a\n' }), now: NOW });
  assert.equal(s.work, undefined);
  assert.deepEqual(s.ledger, {});
  assert.deepEqual(s.errors, []);
});

test('sha256 of what was read is recorded; a changed file gives a different sha', async () => {
  const e = env(realFiles());
  const s1 = await run(e);
  assert.equal(s1.files.planSha256Now, 'sha:' + PLAN_TEXT.length);
  assert.equal(s1.files.draftSha256Now, 'sha:' + DRAFT_TEXT.length);
  const files = realFiles();
  files[key(PLAN)] = PLAN_TEXT + '\n- [ ] 99. added later\n';
  const s2 = await run(env(files));
  assert.notEqual(s2.files.planSha256Now, s1.files.planSha256Now);
  assert.equal(s2.boxes['99'], ' ');
});

test('missing files leave their fields out and raise no error', async () => {
  const s = await run(env({}));
  assert.deepEqual(s.boxes, {});
  assert.deepEqual(s.files, {});
  assert.deepEqual(s.ledger, {});
  assert.equal(s.skeleton, undefined);
  assert.equal(s.work, undefined);
  assert.deepEqual(s.errors, []);
});

test('EPERM five times: error recorded for that path, everything else stays', async () => {
  const e = env(realFiles(), { faults: { [PLAN]: ['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM'] } });
  const s = await run(e);
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].source, 'plan');
  assert.equal(s.errors[0].code, 'EPERM');
  assert.equal(key(s.errors[0].path), key(PLAN));
  assert.deepEqual(s.boxes, {}); // unreadable is not the same as empty: no invented state
  assert.equal(s.files.planSha256Now, undefined);
  assert.equal(s.files.draftStatus, 'approved');
  assert.equal(s.work.workId, 'piomo-living-briefing-e1-01a13bd0'); // work lookup needs only the plan path, not its text
  assert.deepEqual(e.sleeps, [20, 40, 80, 160]);
  assert.equal(e.calls.filter((c) => c === key(PLAN)).length, 5);
});

test('EPERM twice then success: no error, normal result', async () => {
  const e = env(realFiles(), { faults: { [PLAN]: ['EPERM', 'EBUSY'] } });
  const s = await run(e);
  assert.deepEqual(s.errors, []);
  assert.equal(Object.keys(s.boxes).length, 21);
  assert.deepEqual(e.sleeps, [20, 40]);
});

test('EACCES on the ledger: ledger entries absent, error names the ledger, work and boxes intact', async () => {
  const e = env(realFiles(), { always: { [key(LEDGER)]: 'EACCES' } });
  const s = await run(e);
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].code, 'EACCES');
  assert.equal(key(s.errors[0].path), key(LEDGER));
  assert.deepEqual(s.ledger, {});
  assert.equal(s.work.workId, 'piomo-living-briefing-e1-01a13bd0');
  assert.equal(Object.keys(s.boxes).length, 21);
});

test('non-transient read errors are reported once without retry', async () => {
  const e = env(realFiles(), { always: { [key(BOULDER)]: 'EISDIR' } });
  const s = await run(e);
  assert.deepEqual(e.sleeps, []);
  assert.equal(e.calls.filter((c) => c === key(BOULDER)).length, 1);
  assert.equal(s.errors[0].code, 'EISDIR');
  assert.equal(s.work, undefined);
});

test('three broken ledger lines are skipped and reported on one errors line', async () => {
  const good = JSON.stringify({ event: 'dispatch', task: '1', at: 'A' });
  const led = [good, '{"event":"dispatch","task":"2"', 'not json', '', '123', '[]', JSON.stringify({ event: 'partial', task: '2', at: 'B' })].join('\n');
  const files = realFiles();
  files[key(LEDGER)] = led;
  const s = await run(env(files));
  assert.equal(s.ledger['1'].last, 'dispatch');
  assert.equal(s.ledger['2'].last, 'partial');
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].code, 'LEDGER_BAD_LINES');
  assert.equal(s.errors[0].count, 4); // truncated JSON, 'not json', 123 and [] ; the blank line is not counted
  assert.equal(key(s.errors[0].path), key(LEDGER));
});

test('malformed boulder.json is an error, not an empty answer', async () => {
  const files = realFiles();
  files[key(BOULDER)] = '{"works": {';
  const s = await run(env(files));
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].code, 'BOULDER_PARSE');
  assert.equal(s.work, undefined);
  assert.equal(Object.keys(s.boxes).length, 21);
});

test('odd checkbox lines: only the exact top-level grammar counts', async () => {
  const plan = [
    '- [x] 1. ok',
    '- [X] 2. capital X',
    '* [x] 3. star bullet',
    '  - [x] 4. indented',
    '- [x]5. no space',
    '- [x] 6 no dot',
    '- [ ] 7.',
    '- [ ] 8. ',
    '- [~] 9. paused with [x] inside title',
    '- [ ] F10. suffix a',
    '- [ ] 11a. letter suffix',
    '- [-] 12. dash',
    '- [x] 1. duplicate id',
    '- [ ] 13. 한글 제목입니다 한글 제목입니다 한글',
    '',
  ].join('\n');
  const s = await run(env(planOnly(plan)));
  assert.deepEqual(s.boxes, { 1: 'x', 8: ' ', 9: '~', F10: ' ', '11a': ' ', 13: ' ' });
  assert.equal(s.errors.filter((e) => e.code === 'DUP_ID').length, 1);
  assert.deepEqual(s.errors.find((e) => e.code === 'DUP_ID').ids, ['1']);
  const t = Object.fromEntries(s.skeleton.tasks.map((x) => [x.id, x.title]));
  assert.equal(t['1'], 'ok'); // first occurrence wins
  assert.equal([...t['13']].length, 14);
});

test('odd Parallelization lines are ignored; CRLF and BOM do not break parsing', async () => {
  const plan = '\uFEFF' + [
    '  Parallelization: Wave 9 | Blocked by: 1 | Blocks: 2', // orphan before any checkbox
    '- [ ] 1. a',
    'Parallelization: Wave 1 | Blocked by: 2 | Blocks: 3', // not indented
    '  parallelization: Wave 1 | Blocked by: 2 | Blocks: 3', // wrong case
    '  Parallelization: Wave 1 | Blocked by: 2', // missing Blocks
    '  Parallelization: Wave x | Blocked by: 2 | Blocks: 3', // non numeric wave
    '- [x] 2. b',
    '  Parallelization: Wave 3 | Blocked by: 1 | Blocks: 4',
    '  Parallelization: Wave 7 | Blocked by: 9 | Blocks: 4', // second line for same todo ignored
    '',
  ].join('\r\n');
  const s = await run(env(planOnly(plan)));
  assert.deepEqual(s.boxes, { 1: ' ', 2: 'x' });
  const t = Object.fromEntries(s.skeleton.tasks.map((x) => [x.id, x]));
  assert.deepEqual(t['1'], { id: '1', title: 'a', wave: null, deps: [] });
  assert.deepEqual(t['2'], { id: '2', title: 'b', wave: 3, deps: ['1'] });
});

test('misleading success text: statuses stay separate and nothing is inferred from prose', async () => {
  const plan = '- [ ] 5. fix [x] done and task-completed\n  Parallelization: Wave 1 | Blocked by: 없음 | Blocks: 6\n';
  const draft = '---\nstatus: done\n---\nstatus: approved\n- [x] 5. fix\n'; // draft checkboxes are never read
  const b = { works: { w: { work_id: 'w', active_plan: '.omo/plans/piomo-living-briefing.md', status: 'completed', session_ids: ['senpi:s1'], ledger: 'l.jsonl' } } };
  const led = [
    { event: 'dispatch', task: '5', at: '1', note: 'task-completed task-completed' },
    { event: 'verify-failed', task: '5', at: '2', verdict: 'completed' },
  ].map((o) => JSON.stringify(o)).join('\n');
  const s = await run(env(filesOf({ [PLAN]: plan, [DRAFT]: draft, [BOULDER]: JSON.stringify(b), [P('l.jsonl')]: led })));
  assert.equal(s.boxes['5'], ' ');
  assert.equal(s.files.draftStatus, 'done');
  assert.equal(s.work.status, 'completed');
  assert.equal(s.ledger['5'].last, 'verify-failed');
});

test('findPlanForSession: senpi: prefix on either side, absolute path against cwd', () => {
  const boulder = JSON.parse(BOULDER_TEXT);
  const want = path.resolve(ROOT, '.omo/plans/piomo-briefing-plan-view.md');
  const bare = '01a13bd0-ade9-7eb0-a6a7-06bbf047fe6f';
  // the session sits in a completed and an active work: the active one wins
  assert.equal(findPlanForSession(boulder, bare, ROOT), want);
  assert.equal(findPlanForSession(boulder, 'senpi:' + bare, ROOT), want);
  const bareBoulder = { works: { w: { active_plan: '.omo/plans/a.md', session_ids: [bare], status: 'active' } } };
  assert.equal(findPlanForSession(bareBoulder, 'senpi:' + bare, ROOT), path.resolve(ROOT, '.omo/plans/a.md'));
  assert.equal(findPlanForSession(boulder, 'other-session', ROOT), null);
  assert.equal(findPlanForSession(boulder, '', ROOT), null);
  assert.equal(findPlanForSession(boulder, 'senpi:', ROOT), null);
});

test('findPlanForSession: array works, recency among finished works, unusable input', () => {
  const abs = path.join(ROOT, 'abs', 'p.md');
  const arr = { works: [
    { active_plan: '.omo/plans/old.md', session_ids: ['senpi:s'], status: 'completed', updated_at: '2026-01-01T00:00:00Z' },
    { active_plan: '.omo/plans/new.md', session_ids: ['senpi:s'], status: 'completed', updated_at: '2026-02-01T00:00:00Z' },
  ] };
  assert.equal(findPlanForSession(arr, 's', ROOT), path.resolve(ROOT, '.omo/plans/new.md'));
  assert.equal(findPlanForSession({ works: { a: { active_plan: abs, session_ids: ['s'], status: 'paused' } } }, 's', ROOT), abs);
  assert.equal(findPlanForSession({ works: { a: { active_plan: '.omo/plans/x.md', session_ids: ['s'] } } }, 's', undefined), null); // relative without cwd
  for (const bad of [null, undefined, 'x', 7, [], {}, { works: 3 }, { works: { a: null } }, { works: { a: { session_ids: ['s'] } } }]) {
    assert.equal(findPlanForSession(bad, 's', ROOT), null);
  }
});

test('read-only: only the four exact paths are asked of readText, and the module imports no fs', async () => {
  const e = env(realFiles());
  await run(e);
  assert.deepEqual([...new Set(e.calls)].sort(), [key(PLAN), key(DRAFT), key(BOULDER), key(LEDGER)].sort());
  const src = readFileSync(path.join(HERE, '..', 'src', 'plan-status.mjs'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports.every((m) => m === 'node:path' || m === 'node:crypto'), 'unexpected imports: ' + imports.join(','));
  assert.doesNotMatch(src, /\b(watch|readdir|readdirSync|writeFile|appendFile|rename|unlink|rm)\s*\(/);
});

test('never throws on hostile inputs and says what happened', async () => {
  const e = env(realFiles());
  const boom = async () => { throw 'string, not an Error'; };
  const s1 = await computePlanStatus({ planPath: PLAN, boulderPath: BOULDER, readText: boom, sha256: e.sha256, sleep: e.sleep, now: NOW });
  assert.equal(s1.errors[0].code, 'READ_ERROR');
  const s2 = await computePlanStatus({ planPath: PLAN, readText: e.readText, sha256: () => { throw new Error('no hash'); }, sleep: e.sleep, now: NOW });
  assert.ok(s2.errors.some((x) => x.code === 'SHA_FAILED'));
  assert.equal(s2.files.planSha256Now, undefined);
  assert.equal(Object.keys(s2.boxes).length, 21);
  const s3 = await computePlanStatus({});
  assert.ok(s3.errors.some((x) => x.code === 'BAD_ARGS'));
  const s4 = await computePlanStatus();
  assert.equal(s4.schema, 'omo-plan-status/1');
  const s5 = await computePlanStatus({ planPath: PLAN, readText: async () => 42, sleep: e.sleep });
  assert.equal(s5.errors[0].code, 'BAD_READ');
});

test('oversized text is refused instead of parsed', async () => {
  const files = planOnly('- [ ] 1. a\n' + 'x'.repeat(3 * 1024 * 1024));
  const s = await run(env(files));
  assert.equal(s.errors[0].code, 'TOO_LARGE');
  assert.deepEqual(s.boxes, {});
});
