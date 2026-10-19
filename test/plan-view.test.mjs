import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = process.env.OMO_POLISH_TEST_ROOT || ROOT;
const SOURCE = fs.readFileSync(path.join(PRODUCT, 'src/page/plan-view.js'), 'utf8');
const VIEW_SOURCE = fs.readFileSync(path.join(PRODUCT, 'src/page/view.js'), 'utf8');
const ICONS = fs.readFileSync(path.join(PRODUCT, 'src/page/icons.js'), 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/view-model-plan.json'), 'utf8'));
const NOW = Date.parse('2026-10-15T13:05:00+09:00');
const clone = v => JSON.parse(JSON.stringify(v));
const count = (s, re) => (s.match(re) || []).length;
function load() {
  const context = {};
  vm.runInNewContext(ICONS, context, { filename: 'icons.js' });
  vm.runInNewContext(VIEW_SOURCE, context, { filename: 'view.js' });
  vm.runInNewContext(SOURCE, context, { filename: 'plan-view.js' });
  assert.equal(typeof context.BriefPlanView?.render, 'function'); assert.equal(typeof context.BriefPlanView?.renderLink, 'function');
  return { view: context.BriefPlanView, esc: context.BriefView.escapeHtml, icon: context.BriefIcons.icon };
}
function expanded(plan = FIXTURE, all = false) { const state = { ['plan:' + plan.planId]: true }; if (all) { state['plan-tasks:' + plan.planId] = true; state['plan-out:' + plan.planId] = true; } return state; }
function render(plan = FIXTURE, state = expanded(plan)) { const { view, esc } = load(); return view.render(plan, NOW, { expanded: state, esc }); }
function anchors(html) { return [...html.matchAll(/data-anchor="([^"]+)"/g)].map(m => m[1]); }
function expectedAnchors(plan) {
  const p = plan.planId, out = [p + '/goal/main'];
  for (const i of plan.ideal) out.push(p + '/is/' + i.id, p + '/is/' + i.id + '/text');
  for (const c of plan.components) out.push(p + '/comp/' + c.id, p + '/comp/' + c.id + '/label', p + '/comp/' + c.id + '/text');
  for (const w of plan.waves) out.push(p + '/wave/' + w.n, p + '/wave/' + w.n + '/label');
  for (const t of plan.tasks) out.push(p + '/task/' + t.id, ...['label', 'what', 'done'].map(f => p + '/task/' + t.id + '/' + f));
  for (const q of plan.questions) out.push(p + '/q/' + q.id, p + '/q/' + q.id + '/text', p + '/q/' + q.id + '/answer');
  for (let i = 0; i < plan.outOfScope.length; i++) out.push(p + '/out/' + (i + 1), p + '/out/' + (i + 1) + '/text');
  return out;
}
test('fixture supplies four waves, twelve tasks, three question states and one stopped task', () => { assert.equal(FIXTURE.waves.length, 4); assert.equal(FIXTURE.tasks.length, 12); assert.deepEqual(FIXTURE.questions.map(q => q.state).sort(), ['answered', 'default', 'open']); assert.equal(FIXTURE.tasks.filter(t => t.state === 'stopped').length, 1); });
test('classic script loads by itself and does not need a DOM', () => { const context = {}; vm.runInNewContext(SOURCE, context); const link = context.BriefPlanView.renderLink(FIXTURE); assert.equal(typeof link, 'string'); assert.ok(link.length > 0); });
test('four lanes show their own tasks and only the first unfinished lane is current', () => {
  const html = render(); assert.equal(count(html, /data-plan-wave="/g), 4); assert.equal(count(html, /class="plan-now"/g), 1); const lanes = html.split('<section class="plan-lane').slice(1); assert.equal(lanes.length, 4); assert.ok(!lanes[0].includes('class="plan-now"')); assert.ok(lanes[1].includes('data-plan-wave="2"')); assert.ok(lanes[1].includes('class="plan-now"')); for (const lane of lanes) assert.equal(count(lane.split('</section>')[0], /class="plan-box /g), 3); assert.ok(html.includes('←2·3'));
});
test('all-done plans have no current lane and changing progress advances the lane', () => { const plan = clone(FIXTURE); plan.tasks.forEach(t => { if (t.wave === 2) t.state = 'done'; }); let html = render(plan); assert.ok(html.split('data-plan-wave="3"')[1].split('</section>')[0].includes('class="plan-now"')); plan.tasks.forEach(t => { t.state = 'done'; }); html = render(plan); assert.equal(count(html, /class="plan-now"/g), 0); });
test('fully expanded HTML has every element and field anchor exactly once with the public format', () => {
  const html = render(FIXTURE, expanded(FIXTURE, true)), actual = anchors(html); assert.equal(actual.length, new Set(actual).size); assert.deepEqual(actual.slice().sort(), expectedAnchors(FIXTURE).sort()); for (const a of actual) assert.match(a, /^p[0-9a-f]{12}\/(goal|is|comp|wave|task|q|out)\/[^/]+(?:\/(label|what|done|text|answer))?$/); assert.ok(!html.includes('class="plan-other-tasks" hidden')); assert.ok(!html.includes('class="plan-out-list" hidden'));
});
test('collapsed HTML is exactly two summary lines, has no duplicate anchors, and uses the exp channel', () => {
  const html = render(FIXTURE, {}); assert.equal(html.split('\n').length, 2); assert.equal(count(html, /class="plan-summary-line"/g), 2); assert.equal(count(html, /<br\b/g), 0); assert.equal(anchors(html).length, new Set(anchors(html)).size); assert.equal(anchors(html).length, 0); assert.ok(html.includes('data-act="exp" data-key="plan:' + FIXTURE.planId + '"')); assert.ok(html.includes('aria-expanded="false"')); assert.ok(html.includes('1' + load().icon('check', 'ic-xs') + ' 2● 3○ 4○')); assert.ok(html.includes('4/12')); assert.ok(!html.includes('plan-lanes')); assert.doesNotMatch(SOURCE, /\p{Extended_Pictographic}/u);
});
test('execution-session link is one line, navigates to the owner and has no anchors', () => { const { view } = load(), html = view.renderLink({ ...clone(FIXTURE), target: 'c-owner-0', tab: 'run' }); assert.equal(html.split('\n').length, 1); assert.equal(count(html, /data-anchor/g), 0); assert.ok(html.includes('data-goto="c-owner-0"')); assert.ok(html.includes('data-tab="run"')); assert.ok(!html.includes('data-act="exp"')); });
test('open Q&A row sorts first and copies the decision id and recommendation', () => { const html = render(), rows = html.split('<tr class="plan-question ').slice(1); assert.equal(rows.length, 3); assert.ok(rows[0].startsWith('is-open"')); assert.ok(rows[0].includes('data-decision="15"')); assert.ok(rows[0].includes('data-copy="/decide 15A"')); assert.ok(rows.some(row => row.includes('소유자 A'))); assert.ok(rows.some(row => row.includes('class="chip x-info plan-default"'))); const plan = clone(FIXTURE); plan.questions.find(q => q.state === 'open').recommend = 'B'; assert.ok(render(plan).includes('data-copy="/decide 15B"')); });
test('only current-wave task rows are initially visible; the remainder uses a separate exp key', () => { const html = render(), current = html.split('<tbody class="plan-current-tasks">')[1].split('</tbody>')[0]; assert.deepEqual([...current.matchAll(/data-plan-task-row="([^"]+)"/g)].map(m => m[1]), ['4', '5', '6']); assert.ok(html.includes('class="plan-other-tasks" hidden')); assert.ok(html.includes('data-key="plan-tasks:' + FIXTURE.planId + '"')); assert.ok(html.includes('외 9개')); assert.ok(html.includes('data-key="plan-out:' + FIXTURE.planId + '"')); assert.ok(html.includes('class="plan-out-list" hidden')); });
test('stopped boxes are distinct from blocked dependents and use the dashed CSS rule', () => { const html = render(), stopped = html.split('class="plan-box p-stopped"')[1].split('</li>')[0], blocked = html.split('class="plan-box p-blocked"')[1].split('</li>')[0]; assert.ok(stopped.includes('/task/5"')); assert.ok(blocked.includes('/task/7"')); assert.ok(blocked.includes('막힘')); const css = fs.readFileSync(path.join(ROOT, 'src/page/plan-view.css'), 'utf8'); assert.match(css, /\.plan-box\.p-stopped\s*\{[^}]*border-style:\s*dashed/); assert.match(css, /\.plan-box\.p-stopped\s*\{[^}]*var\(--gray\)/); });
test('tasks-empty components render as one large-parts lane with complete anchors', () => { const plan = clone(FIXTURE); plan.tasks = []; plan.waves = []; plan.stage = 'gate'; const html = render(plan, expanded(plan, true)); assert.equal(count(html, /class="plan-lane/g), 2); assert.equal(count(html, /data-plan-components/g), 1); assert.ok(html.includes('큰 덩어리')); assert.equal(count(html, /class="plan-box p-todo"/g), 2); assert.deepEqual(anchors(html).sort(), expectedAnchors(plan).sort()); assert.ok(!html.includes('class="plan-task-table"')); });
test('dynamic fields and attributes, including link data, are escaped', () => {
  const plan = clone(FIXTURE), bad = '<script>"&\'`</script>\nnext'; plan.goal = bad; plan.stageNote = bad; plan.source.slug = bad; plan.source.planPath = bad; plan.chips = [bad]; plan.ideal[0].text = bad; plan.components[0].label = bad; plan.components[0].text = bad; plan.waves[0].label = bad; plan.tasks[0].label = bad; plan.tasks[0].what = bad; plan.tasks[0].done = bad; plan.questions.forEach(q => { q.text = bad; }); plan.questions.find(q => q.state === 'answered').answer = bad; plan.outOfScope = [bad]; const { view, esc } = load();
  for (const html of [render(plan, expanded(plan, true)), render(plan, {}), view.renderLink({ ...plan, target: bad, tab: bad })]) { assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('"&\'`')); } const seen = []; view.render(plan, NOW, { expanded: expanded(plan, true), esc(value) { seen.push(value); return esc(value); } }); assert.ok(seen.includes(bad)); for (const html of [render(plan, {}), view.renderLink(plan)]) assert.ok(html.split('\n').length <= 2);
});
test('stage mapping handles all seven stages and prototype names are not used as labels', () => { const { view, esc } = load(), labels = { shaping: '구상', gate: '승인 대기', review: '검토 중', ready: '실행 준비', running: '실행 중', done: '끝남', dropped: '중단' }; for (const [stage, label] of Object.entries(labels)) assert.ok(view.render({ ...FIXTURE, stage }, NOW, { expanded: {}, esc }).includes(label), stage); assert.ok(!view.render({ ...FIXTURE, stage: 'constructor' }, NOW, { expanded: {}, esc }).includes('function Object')); });
test('revision time, checked time, unchanged chips and path copy are present without percentages', () => { const html = render(); assert.match(html, /<use href="#i-clock"><\/use><\/svg> r3 \d\d:\d\d/); assert.ok(html.includes('data-copy="' + FIXTURE.source.planPath + '"')); assert.ok(html.includes('class="plan-checked"')); for (const chip of FIXTURE.chips) assert.ok(html.includes(chip)); for (const output of [html, render(FIXTURE, {}), load().view.renderLink(FIXTURE)]) assert.ok(!output.includes('%')); });
test('rendering is deterministic and does not mutate the input or expansion state', () => { const plan = clone(FIXTURE), state = expanded(plan, true), before = JSON.stringify({ plan, state }); assert.equal(render(plan, state), render(plan, state)); assert.equal(JSON.stringify({ plan, state }), before); });
test('server page: the open Q&A row asks ui.answerBox for its decision and keeps the /decide copy line; a blank box leaves the row as it was', () => {
  const { view, esc } = load(), seen = [], html = view.render(FIXTURE, NOW, { expanded: expanded(FIXTURE), esc, answerBox: id => { seen.push(id); return '<i data-box="' + id + '"></i>'; } }); assert.deepEqual(seen, [15]); const rows = html.split('<tr class="plan-question ').slice(1); assert.ok(rows[0].includes('<i data-box="15"></i>')); assert.ok(rows[0].includes('data-copy="/decide 15A"')); assert.ok(rows.slice(1).every(row => !row.includes('data-box'))); assert.equal(view.render(FIXTURE, NOW, { expanded: expanded(FIXTURE), esc, answerBox: () => '' }), render());
});
test('server page: view.js gives the plan row the same controls as the decision card; none once answered or on the file page', () => {
  const context = {}; vm.runInNewContext(VIEW_SOURCE, context, { filename: 'view.js' }); vm.runInNewContext(SOURCE, context, { filename: 'plan-view.js' }); const open = FIXTURE.questions.find(q => q.state === 'open'), model = { generatedAt: NOW, sessions: [{ id: 's1', title: '계획', tabLabel: '수리', tabNumber: 181, answerKinds: ['option', 'text'], status: 'needs_decision', plan: clone(FIXTURE), decisions: [{ id: 15, sessionId: 's1', question: open.text, options: open.options, recommend: 'A', reason: 'r', blocks: true, answered: false, closed: false }] }] };
  const row = ui => context.BriefView.renderOverview(model, { expanded: { ['plan:' + FIXTURE.planId]: true }, ...ui }).split('<tr class="plan-question is-open"')[1].split('</tr>')[0], live = row({ live: true }); assert.equal(count(live, /data-act="ans-pick" data-opt="[AB]" data-id="15" data-where="plan"/g), 2); assert.equal(count(live, /data-act="ans-reply" data-id="15" data-where="plan"/g), 1); assert.ok(row({ live: true, answers: { 15: { confirm: { option: 'B' } } } }).includes('class="ans-confirm"')); assert.equal(count(row({}), /data-act="ans-/g), 0); model.sessions[0].decisions[0].answered = true; assert.equal(count(row({ live: true }), /data-act="ans-/g), 0);
});
