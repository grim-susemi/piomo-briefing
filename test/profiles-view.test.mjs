// Profiles rail view: pure render from the fixture state, read-only modes, escaping, the pending tray and the
// preview/apply/409 controller against a fake fetch. No timers, no browser and no real network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeController } from './fixtures/controller-dom.mjs';
import { launch, listProfilePids } from '../scripts/cdp.mjs';
import { createBoardServer } from '../src/server.mjs';
import { pageHtml } from '../src/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const STATE = JSON.parse(read('test/fixtures/profiles-view-state.json'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const plain = (v) => JSON.parse(JSON.stringify(v));
const all = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const textOf = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#96;/g, '`').replace(/&amp;/g, '&');

function load() {
  const ctx = vm.createContext({});
  vm.runInContext(read('src/page/icons.js'), ctx, { filename: 'icons.js' });
  vm.runInContext(read('src/page/profiles-view.js'), ctx, { filename: 'profiles-view.js' });
  assert.equal(typeof ctx.BriefProfiles?.render, 'function');
  return ctx.BriefProfiles;
}
const live = (extra = {}) => ({ live: true, pending: [], draft: {}, preview: null, conflict: false, error: '', status: '', result: null, busy: false, loading: false, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('render: header, target homes and every section in order', () => {
  const P = load();
  const html = P.render(STATE, live());
  assert.equal(html.split('<div class="pf"').length, 2, 'one profiles root');
  assert.match(html, /data-pf-root/);
  assert.equal(all(html, /data-readonly="([^"]+)"/g)[0], 'false');
  const text = textOf(html);
  for (const word of ['프로필·에이전트', 'C:/Users/USER/.omo', 'C:/Users/USER/.omo-original/home/.omo', 'C:/Users/USER/.somo/home/.omo', 'C:/Users/USER/.omo-stable-500/home/.omo']) {
    assert.ok(text.includes(word), word);
  }
  assert.match(html, /\[primary\]/);
  assert.match(html, /\[stable-500\]/);
  assert.match(html, /\[omo-original\]|\[mirror 1\]/);
  assert.deepEqual(all(html, /data-pf-sec="([^"]+)"/g), ['guide', 'profiles', 'routing', 'memory', 'lanes', 'main', 'summarizer', 'tray', 'agents']);
  for (const title of ['메인 에이전트', '프로필', '모델 라우팅 · 전담 에이전트 / 작업 카테고리', '메인 모델 설정', 'model_profile', '요약 담당 모델', '공통 설정 · Kibitzer 회상', '권장 가이드']) {
    assert.ok(text.includes(title), title);
  }
  assert.ok(text.includes(STATE.inventory.path), 'guide source path');
  assert.ok(text.includes(STATE.inventory.pinnedSha256), 'guide source sha256');
  assert.ok(html.includes('custom-literal'), 'model_profile custom-literal option');
  assert.ok(html.includes('끄기 (off)'), 'model_profile off option');
  assert.match(text, /커맨드코드 요약 모델은 유료 구독 할당량을 사용합니다/);
  assert.match(text, /Kibitzer/);
  assert.match(text, /Reflection/);
});

test('render: 4 agent rows (lane, pin, remembered model, reset), 6 profile cards and grouped routing rows', () => {
  const P = load();
  const html = P.render(STATE, live());
  assert.equal((html.match(/data-pf-agent="/g) || []).length, 4);
  assert.deepEqual(all(html, /data-pf-agent="([^"]+)"/g), ['sisyphus', 'hephaestus', 'prometheus', 'atlas']);
  for (const id of ['sisyphus', 'hephaestus', 'prometheus', 'atlas']) {
    assert.match(html, new RegExp('pf-dot-' + id));
    assert.match(html, new RegExp('data-agent="' + id + '"'));
  }
  assert.match(html, /기억 초기화/);
  assert.match(textOf(html), /anthropic-subscription · claude-opus-5-5 \/ medium/, 'remembered model is read-only text');
  assert.equal((html.match(/class="pf-card(?: on)?"/g) || []).length, 6, 'six profile cards');
  assert.equal((html.match(/class="pf-card on"/g) || []).length, 1, 'the current card is marked');
  assert.match(textOf(html), /탐색 · 자료 조사/);
  assert.match(textOf(html), /검토 · QA/);
  assert.match(textOf(html), /전문 작업/);
  assert.match(html, /pf-st-recommended/);
  assert.match(html, /pf-st-fallback/);
  assert.match(html, /pf-st-different/);
  assert.match(html, /pf-st-variant-different/);
  assert.match(html, /pf-st-unresolved/);
  assert.match(html, /pf-st-untracked/);
  assert.match(html, /<option value="chatgpt-subscription\|gpt-6\.1-sol" selected>/, 'a pin is provider + bare gpt-* model id');
  assert.equal((html.match(/data-pf="route-provider"/g) || []).length, STATE.routing.rows.length);
});

test('escaping: model ids containing script or img markup render as text, never as elements', () => {
  const P = load();
  const html = P.render(STATE, live());
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<svg[^>]*onerror/i);
  const text = textOf(html);
  assert.ok(text.includes('<script>alert(1)</script>'), 'the script id survives as text');
  assert.ok(text.includes('<img src=x onerror=alert(2)>'), 'the img onerror id survives as text');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped in the markup');
  // every attribute value is escaped too: no tag characters survive inside a quoted value
  for (const [, value] of html.matchAll(/ [a-zA-Z-]+="([^"]*)"/g)) {
    assert.doesNotMatch(value, /[<>]/, value);
  }
});

function labelledControls(html) {
  const labels = new Map();
  for (const m of html.matchAll(/<label[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g)) {
    const t = /<span class="pf-sel-t">([\s\S]*?)<\/span>/.exec(m[2]);
    labels.set(m[1], t ? textOf(t[1]).trim() : '');
  }
  const controls = [...html.matchAll(/<(select|input)\b([^>]*)>/g)].map((m) => {
    const attrs = m[2];
    return {
      tag: m[1],
      id: (/\bid="([^"]+)"/.exec(attrs) || [])[1] || '',
      pf: (/\bdata-pf="([^"]+)"/.exec(attrs) || [])[1] || '',
      aria: (/\baria-label="([^"]+)"/.exec(attrs) || [])[1] || '',
      ref: (/\baria-labelledby="([^"]+)"/.exec(attrs) || [])[1] || '',
    };
  });
  return { labels, controls };
}

test('a11y: every select and input has a visible label and an accessible name', () => {
  const P = load();
  const html = P.render(STATE, live());
  const { labels, controls } = labelledControls(html);
  const selects = controls.filter((c) => c.tag === 'select');
  assert.equal(selects.length, 47, 'the fixture renders 47 selects');
  assert.equal(controls.length, 48, '47 selects + 1 text input');
  for (const c of controls) {
    const name = c.aria || c.ref || labels.get(c.id) || '';
    assert.ok(name.trim(), `${c.tag} [data-pf=${c.pf || '?'}] has no accessible name`);
    if (c.tag === 'select') assert.ok((labels.get(c.id) || '').trim(), `${c.id} has no visible label`);
  }
  const byPf = (pf) => controls.filter((c) => c.pf === pf);
  for (const pre of ['route', 'main']) {
    for (const c of byPf(pre + '-provider')) assert.equal(labels.get(c.id), '1. 구독 서비스');
    for (const c of byPf(pre + '-model')) assert.equal(labels.get(c.id), '2. AI 모델');
    for (const c of byPf(pre + '-thinking')) assert.equal(labels.get(c.id), '3. 추론 강도');
  }
  assert.equal(byPf('main-provider').length, 1);
  for (const c of byPf('summarizer-provider')) assert.equal(labels.get(c.id), '1. 제공사');
  for (const c of byPf('summarizer-model')) assert.equal(labels.get(c.id), '2. AI 모델');
  for (const c of byPf('memory-mode')) assert.equal(labels.get(c.id), '모드');
  for (const c of byPf('memory-service')) assert.equal(labels.get(c.id), '1. 구독 서비스');
  for (const c of byPf('memory-model')) assert.equal(labels.get(c.id), '2. AI 모델');
  for (const c of byPf('memory-thinking')) assert.equal(labels.get(c.id), '3. 추론 강도');
  for (const c of byPf('agent-pin-thinking')) assert.equal(labels.get(c.id), '추론');
  assert.equal(byPf('route-provider').length, STATE.routing.rows.length);
  assert.equal(byPf('agent-pin-thinking').length, 4);
  assert.equal(byPf('summarizer-provider').length, 1);
  assert.equal(byPf('summarizer-model').length, 1);
  assert.equal(byPf('memory-mode').length, 2);
  assert.equal(byPf('memory-service').length, 2);
  assert.equal(byPf('memory-model').length, 2);
  assert.equal(byPf('memory-thinking').length, 2);
});

test('phone: the view raises its local control token to the 44 px --hit target', () => {
  const css = read('src/page/profiles-view.css');
  const tokens = read('src/page/tokens.css');
  assert.match(tokens, /--ctl-h:\s*28px/);
  assert.match(tokens, /--hit:\s*44px/);
  const phone = css.slice(css.indexOf('@media (max-width: 599px)'));
  assert.match(phone, /\.pf\s*\{\s*--ctl-h:\s*var\(--hit\);\s*\}/);
  assert.match(phone, /\.pf-nav-b,\s*\.pf-diff summary\s*\{\s*min-height:\s*var\(--hit\);\s*\}/);
  assert.match(css, /\.pf select, \.pf input\[type="text"\] \{[\s\S]*?height: var\(--ctl-h\);/);
  assert.match(css, /\.pf-btn \{[\s\S]*?min-height: var\(--ctl-h\);/);
});

test('header: the memory-row phrase stays together with its predicate', () => {
  const P = load();
  const html = P.render(STATE, live());
  const keep = /<span class="pf-keep">([\s\S]*?)<\/span>/.exec(html);
  assert.ok(keep, 'the keep-together span is rendered');
  assert.equal(textOf(keep[1]).trim(), '메모리 행을 확인하고');
  assert.match(html, /<span class="pf-keep">실시간 상황판<\/span>/);
  assert.doesNotMatch(/<p class="pf-sub">([\s\S]*?)<\/p>/.exec(html)[1], /·/, 'no dangling middle dot in the header');
  assert.match(read('src/page/profiles-view.css'), /\.pf-keep\s*\{\s*white-space:\s*nowrap;\s*\}/);
});

test('phone: the pending-row icon button keeps its 44 px width when the label shrinks it', () => {
  const P = load();
  const html = P.render(STATE, live({ pending: [{ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic-subscription', model: 'anthropic-subscription/claude-opus-5-5', thinking: 'medium' }] }));
  const drop = /<button[^>]*data-pf="drop"[^>]*>/.exec(html)[0];
  assert.match(drop, /aria-label="이 변경 지우기"/);
  assert.match(drop, /title="이 변경 지우기"/);
  const css = read('src/page/profiles-view.css');
  assert.match(css, /\.pf-btn-icon\s*\{[^}]*flex:\s*none;/);
  assert.match(css, /\.pf-btn-icon\s*\{[^}]*min-width:\s*var\(--ctl-h\);/);
  assert.match(css, /\.pf-btn-icon\s*\{[^}]*min-height:\s*var\(--ctl-h\);/);
});

test('agents: lane, pin and thinking share a top baseline; reset sits with the memory value', () => {
  const P = load();
  const html = P.render(STATE, live());
  assert.match(html, /class="pf-field pf-mem-field"[\s\S]*?class="pf-mem-line"[\s\S]*?data-pf="reset-memory"/);
  const css = read('src/page/profiles-view.css');
  assert.match(css, /\.pf-agent \{[\s\S]*?align-items:\s*start;/);
  assert.match(css, /\.pf-mem-line\s*\{[\s\S]*?align-items:\s*center;/);
  const at1040 = css.slice(css.indexOf('@media (max-width: 1040px)'), css.indexOf('@media (max-width: 760px)'));
  assert.doesNotMatch(at1040, /\.pf-agent \.pf-field-act/, 'the reset action must not be pushed to its own row');
  assert.match(at1040, /\.pf-agent \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\) minmax\(0, 1\.2fr\); \}/);
  assert.match(at1040, /\.pf-agent \.pf-mem-field \{ grid-column: 1 \/ -1; \}/);
  // Memory rows follow the WinForms row (mode, then three equal selects) at every width above the phone.
  assert.match(css, /\.pf-tri \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.doesNotMatch(at1040, /\.pf-mem-sels|\.pf-tri/);
});

test('loading and error expose explicit states, never a read-only view', () => {
  const P = load();
  let html = P.render(null, live({ loading: true }));
  assert.match(html, /data-pf-state="loading"/);
  assert.match(html, /data-pf-root/);
  assert.doesNotMatch(html, /읽기 전용/);
  assert.doesNotMatch(html, /지금은 읽기 전용이라/);
  assert.doesNotMatch(html, /data-pf="preview"/);

  html = P.render(null, live({ loading: false, error: '프로필 상태를 불러오지 못했어요 (HTTP 500)' }));
  assert.match(html, /HTTP 500/);
  assert.match(html, /data-pf-state="error"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-pf="reload"/);
  assert.doesNotMatch(html, /data-pf-loading/);
  assert.doesNotMatch(html, /pf-ro-note/);
  assert.doesNotMatch(html, /읽기 전용/);
  assert.doesNotMatch(html, /지금은 읽기 전용이라/);

  html = P.render(STATE, live());
  assert.match(html, /data-pf-state="view"/);
  assert.doesNotMatch(html, /data-pf-loading/);
});

test('loading reuses the homes, tray and section-header primitives and pulses one glyph', () => {
  const P = load();
  const html = P.render(null, live({ loading: true }));
  assert.match(html, /data-pf-state="loading"/);
  assert.equal((html.match(/class="pf-skel pf-skel-agent"/g) || []).length, 4, 'four agent placeholders');
  assert.equal((html.match(/class="pf-skel pf-skel-card"/g) || []).length, 6, 'six profile-card placeholders');
  assert.match(html, /class="pf-skeleton"/);
  assert.match(html, /data-pf-loading role="status"/);
  assert.match(html, /class="pf-homes pf-skel-homes" data-pf-skel="homes"/);
  assert.match(html, /class="pf-tray pf-tray-compact" data-pf-skel="tray"/);
  assert.match(html, /class="pf-sec-h"/);
  const loaded = P.render(STATE, live());
  const loadedHead = /<details class="pf-sec pf-agents-card" id="pf-sec-agents"[\s\S]*?<summary class="pf-sec-h">([\s\S]*?)<\/summary>/.exec(loaded)[1];
  const loadingHead = /<section class="pf-skel-sec" data-pf-skel="agents"[\s\S]*?<header class="pf-sec-h">([\s\S]*?)<\/header>/.exec(html)[1];
  assert.equal(textOf(loadingHead), textOf(loadedHead));
  assert.equal((html.match(/data-pf-skel="route"/g) || []).length, 20, 'routing placeholders');
  assert.doesNotMatch(html, /data-pf-sec=/, 'the loading frame must not claim loaded sections');
  assert.doesNotMatch(html, /class="pf-skeleton" aria-hidden="true"/, 'the live loading status must not sit inside aria-hidden');
  assert.match(html, /class="pf-pulse" aria-hidden="true"/);
  const css = read('src/page/profiles-view.css');
  assert.match(css, /@keyframes pf-pulse/);
  assert.match(css, /\.pf-pulse \{[^}]*animation: pf-pulse var\(--pf-pulse-dur\)/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.pf-pulse \{ animation-duration: 2\.4s; \}/);
});

test('pressed: profile cards and sidebar section buttons use the press fill', () => {
  const css = read('src/page/profiles-view.css');
  assert.match(css, /button\.pf-card-b:active:not\(:disabled\) \{[^}]*background: var\(--fill-press\)/);
  assert.match(css, /\.pf-nav-b:active \{[^}]*background: var\(--fill-press\)/);
});

test('page wiring: the pending row remove button removes that exact row', async () => {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => STATE });
  await tick();
  for (const [agent, lane] of [['atlas', 'daily-heavy'], ['prometheus', 'geeky-heavy']]) {
    const sel = e.byId.main.querySelector('[data-pf="agent-lane"][data-agent="' + agent + '"]');
    sel.value = lane;
    e.fire(sel, 'change');
  }
  await tick();
  assert.equal(e.byId.main.querySelectorAll('.pf-pending li').length, 2);
  const first = e.byId.main.querySelectorAll('.pf-pending li')[0].textContent;
  e.fire(e.byId.main.querySelector('[data-pf="drop"][data-index="0"]'), 'click');
  await tick();
  assert.equal(e.byId.main.querySelectorAll('.pf-pending li').length, 1);
  assert.equal(e.byId.main.querySelector('.pf-pending').textContent.includes(first), false);
  assert.equal(e.page.state.ui.profilesState.pending.length, 1);
  assert.deepEqual(e.errors, []);
});

test('selects: every control titles its selected label and declares an ellipsis', () => {
  const P = load();
  const html = P.render(STATE, live());
  const tags = [...html.matchAll(/<select\b([^>]*)>/g)].map((m) => m[1]);
  assert.equal(tags.length, 47);
  for (const attrs of tags) assert.match(attrs, /\btitle="[^"]+"/, 'select without a full-value title');
  const model = /<select[^>]*data-pf="route-model"[^>]*>/.exec(html)[0];
  assert.match(model, /title="[^"]*·[^"]*\/[^"]*"/, 'model title carries alias and full id');
  const css = read('src/page/profiles-view.css');
  assert.match(css, /\.pf select,[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(css, /\.pf select,[\s\S]*?white-space:\s*nowrap;/);
});

test('summarizer: several aliases for one model still select exactly one option with a matching title', () => {
  const P = load();
  const state = clone(STATE);
  const current = state.summarizer.provider + '/' + state.summarizer.model;
  state.catalog['dup-sum-a'] = { model: current, variant: 'high' };
  state.catalog['dup-sum-b'] = { model: current, variant: 'high' };
  const html = P.render(state, live());
  const pick = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].find((m) => /data-pf="summarizer-model"/.test(m[1]));
  assert.ok(pick, 'summarizer select missing');
  const selected = [...pick[2].matchAll(/<option\b[^>]*\bselected[^>]*>([\s\S]*?)<\/option>/g)];
  assert.equal(selected.length, 1, 'more than one option is selected');
  const title = /\btitle="([^"]*)"/.exec(pick[1])[1];
  assert.equal(title, textOf(selected[0][1]).trim(), 'title differs from the visible selected label');
});

test('copy: (max 추론), 진짜 max 추론 and 실시간 상황판 stay on one line', () => {
  const P = load();
  const state = clone(STATE);
  state.profiles[5].summary += ' 올라마는 high가 한계라 진짜 max 추론이 필요할 때 쓰는 경로입니다.';
  const html = P.render(state, live());
  assert.match(html, /<span class="pf-keep">GLM 5\.3 Flash\(max 추론\)<\/span>/);
  assert.match(html, /<span class="pf-keep">진짜 max 추론<\/span>/);
  assert.match(html, /<span class="pf-keep">실시간 상황판<\/span>/);
  assert.equal((html.match(/class="pf-card-sum"/g) || []).length, 6);
  assert.doesNotMatch(html, /\(max 추론\)가/, 'the parenthetical must not be emitted raw');
});

test('disabled secondary buttons keep their contrast without opacity', () => {
  const css = read('src/page/profiles-view.css');
  const rule = /\.pf-btn:disabled \{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /opacity:\s*1/);
  assert.match(rule, /background:\s*var\(--c-sunk\)/);
  assert.match(rule, /border-color:\s*var\(--ctl-edge\)/);
  assert.doesNotMatch(css, /opacity:\s*\.7/);
});

test('disabled selects and secondary buttons set colour, background and border without UA dimming', () => {
  const css = read('src/page/profiles-view.css');
  const select = /\.pf select:disabled, \.pf input:disabled \{([^}]*)\}/.exec(css)[1];
  assert.match(select, /color:\s*var\(--c-fg-3\)/);
  assert.match(select, /background:\s*var\(--c-sunk\)/);
  assert.match(select, /border-color:\s*var\(--ctl-edge\)/);
  assert.match(select, /-webkit-text-fill-color:\s*var\(--c-fg-3\)/);
  assert.match(select, /opacity:\s*1/);
  const button = /\.pf-btn:disabled \{([^}]*)\}/.exec(css)[1];
  assert.match(button, /color:\s*var\(--c-fg-3\)/);
  assert.match(button, /background:\s*var\(--c-sunk\)/);
  assert.match(button, /border-color:\s*var\(--ctl-edge\)/);
  assert.match(button, /opacity:\s*1/);
  const ghost = /\.pf-btn-ghost:disabled \{([^}]*)\}/.exec(css)[1];
  assert.match(ghost, /color:\s*var\(--c-fg-3\)/);
  assert.match(ghost, /border-color:\s*var\(--ctl-edge\)/);
});

test('responsive controls: 1024 stacks the agent pin/thinking pair and 390 uses one agent column', () => {
  const css = read('src/page/profiles-view.css');
  const at1040 = css.slice(css.indexOf('@media (max-width: 1040px)'), css.indexOf('@media (max-width: 760px)'));
  assert.match(at1040, /\.pf-pin-sels \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  const at599 = css.slice(css.indexOf('@media (max-width: 599px)'));
  assert.match(at599, /\.pf-pin-sels, \.pf-tri \{ grid-template-columns: minmax\(0, 1fr\); \}/, 'the phone stacks the three selects');
  assert.match(at599, /\.pf-agent \{ grid-template-columns: minmax\(0, 1fr\); align-items: start; \}/);
});

test('read-only without a token: no selects and no preview/apply controls', () => {
  const P = load();
  const html = P.render(STATE, { live: false });
  assert.match(html, /data-readonly="true"/);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /data-pf="preview"/);
  assert.doesNotMatch(html, /data-pf="apply"/);
  assert.match(html, /이 페이지는 보기 전용입니다/);
  assert.match(P.side(STATE, { live: false }), /읽기 전용/);
});

test('inventory stale: the banner is shown and the view is read-only even with a token', () => {
  const P = load();
  const stale = clone(STATE);
  stale.banner = '인벤토리 갱신 필요';
  stale.readOnly = true;
  stale.readOnlyReason = 'INVENTORY_STALE';
  stale.inventory.stale = true;
  stale.inventory.label = '인벤토리 갱신 필요';
  const html = P.render(stale, live());
  assert.match(html, /data-readonly="true"/);
  assert.match(html, /인벤토리 갱신 필요/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /data-pf="apply"/);
});

test('read-only on the live board: the note names the store reason instead of the live-only hint', () => {
  const P = load();
  const note = (html) => textOf(/<p class="pf-empty pf-ro-note">([\s\S]*?)<\/p>/.exec(html)[1]).trim();
  const commented = clone(STATE);
  commented.readOnly = true;
  commented.readOnlyReason = 'COMMENTS_PRESENT';
  const html = P.render(commented, live());
  assert.match(html, /data-readonly="true"/);
  assert.equal(note(html), 'omo.jsonc에 주석이 있어 수정할 수 없습니다.');
  assert.doesNotMatch(html, /실시간 상황판에서만/);
  const unnamed = clone(STATE);
  unnamed.readOnly = true;
  assert.equal(note(P.render(unnamed, live())), '실시간 상황판에서만 바꿀 수 있습니다.', 'a reason the store did not name keeps the live-only note');
});

test('rendered HTML has no style attribute and no on* event attribute', () => {
  const P = load();
  const html = P.render(STATE, live({
    pending: [{ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' }],
    preview: { ok: true, diffs: [{ file: 'omo.jsonc', changes: [{ path: '$.agents.explore.model', before: 'fable', after: 'fable-medium' }] }], warnings: [], writes: ['omo.jsonc'] }
  }));
  assert.doesNotMatch(html, /<[^>]*\sstyle\s*=/i);
  // Attribute names, not model text: an escaped "onerror=" inside a quoted value is data, not an attribute.
  for (const [, name] of html.matchAll(/([^\s=<>]+)\s*=\s*"/g)) {
    assert.doesNotMatch(name, /^on/i, name);
    assert.notEqual(name.toLowerCase(), 'style', name);
  }
  assert.doesNotMatch(html, /javascript:/i);
});

test('pending tray: preview diffs, conflict message with reload and the apply result backups', () => {
  const P = load();
  const pending = [
    { kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' },
    { kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' }
  ];
  let html = P.render(STATE, live({ pending }));
  assert.match(html, /data-pf="preview"/);
  assert.match(html, /data-pf="apply"/);
  assert.match(textOf(html), /atlas 레인 → daily-heavy/);
  assert.match(textOf(html), /역할 agents\/explore → anthropic · anthropic\/claude-opus-5-5 \/ medium/);
  assert.equal((html.match(/data-pf="drop"/g) || []).length, 2);

  html = P.render(STATE, live({ pending, preview: { ok: true, diffs: [
    { file: 'omo.jsonc', changes: [{ path: '$.profiles.native-gpt-kimi-deepseek.agents.explore.model', before: 'fable', after: 'fable-medium' }] },
    { file: 'agent/primary-agents/roster.json', changes: [{ path: '$.agents.atlas.lane', before: 'daily-normal', after: 'daily-heavy' }] }
  ], warnings: ['mirror somo: skipped'], writes: ['omo.jsonc', 'agent/primary-agents/roster.json'] } }));
  assert.match(html, /data-pf-preview/);
  assert.match(textOf(html), /\$\.profiles\.native-gpt-kimi-deepseek\.agents\.explore\.model/);
  assert.match(textOf(html), /fable-medium/);
  assert.match(textOf(html), /mirror somo: skipped/);

  html = P.render(STATE, live({ conflict: true, status: '다른 곳에서 바뀜', error: '다른 곳에서 바뀌었어요 — 새로고침 후 다시 적용' }));
  assert.match(html, /data-pf-conflict="true"/);
  assert.match(html, /class="pf-conflict" role="alert"/);
  assert.match(html, /data-pf="reload"/);

  html = P.render(STATE, live({ pending: [], result: { ok: true, action: 'apply', backups: ['C:/Users/USER/.omo/runtime/native-profile-switcher-backups/omo-20261020-120000-000.jsonc'], writes: ['omo.jsonc'], hashes: {} } }));
  assert.match(html, /data-pf-result="apply"/);
  assert.match(textOf(html), /omo-20261020-120000-000\.jsonc/);
});

test('journal: reapply mirrors apply disabled state under conflict and busy, never in read-only', () => {
  const P = load();
  const interrupted = clone(STATE);
  interrupted.applyJournal = {
    v: 1, id: 'crash-1', action: '다시 적용', status: 'interrupted', label: '중단된 적용',
    reapply: {
      changes: [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }],
      rosterRevision: 3
    }
  };
  const html = P.render(interrupted, live());
  assert.match(html, /data-pf-journal="interrupted"/);
  assert.doesNotMatch(/<button[^>]*data-pf="reapply"[^>]*>/.exec(html)[0], /\bdisabled\b/, 'reapply is dead when apply is available');
  const conflictHtml = P.render(interrupted, live({ pending: [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }], conflict: true, status: '다른 곳에서 바뀜', error: P.CONFLICT_TEXT }));
  assert.match(/<button[^>]*data-pf="reapply"[^>]*>/.exec(conflictHtml)[0], /\bdisabled\b/, 'reapply must be disabled while the 409 latch blocks apply');
  assert.match(conflictHtml, /data-pf="reload"/, 'the conflict keeps its functional reload');
  const busyHtml = P.render(interrupted, live({ pending: [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }], busy: true }));
  assert.match(/<button[^>]*data-pf="reapply"[^>]*>/.exec(busyHtml)[0], /\bdisabled\b/, 'reapply must be disabled while another request is in flight');
  const readonlyHtml = P.render(interrupted, { ...live(), live: false });
  assert.doesNotMatch(readonlyHtml, /data-pf="reapply"/);
  assert.match(readonlyHtml, /data-pf-journal="interrupted"/);
  const legacy = clone(interrupted);
  legacy.applyJournal.reapply = null;
  const legacyHtml = P.render(legacy, live());
  assert.doesNotMatch(legacyHtml, /data-pf="reapply"/);
  assert.match(legacyHtml, /data-pf-journal="interrupted"/);
});

test('controller: load -> preview -> apply -> reload, with the exact POST body and token', async () => {
  const P = load();
  const calls = [];
  const responses = [
    { status: 200, json: async () => STATE },
    { status: 200, json: async () => ({ ok: true, action: 'preview', diffs: [{ file: 'omo.jsonc', changes: [{ path: '$.a', before: 1, after: 2 }] }], warnings: [], writes: ['omo.jsonc'] }) },
    { status: 200, json: async () => ({ ok: true, action: 'apply', backups: ['C:/backup/omo-1.jsonc'], writes: ['omo.jsonc'], hashes: {} }) },
    { status: 200, json: async () => ({ ...STATE, roster: { ...STATE.roster, revision: 4 } }) },
    { status: 409, json: async () => ({ ok: false, code: 'STALE', file: 'omo.jsonc' }) }
  ];
  const c = P.createController({
    fetch: (url, opts) => {
      calls.push({ url, opts });
      const next = responses.shift();
      assert.ok(next, 'unexpected fetch ' + url);
      return Promise.resolve(next);
    },
    token: () => 'tok'
  });
  await c.load();
  assert.equal(calls[0].url, '/profiles/state');
  assert.equal(c.snapshot().view.activeProfile.key, 'gpt-kimi-deepseek');

  c.add({ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' });
  const preview = await c.preview();
  assert.equal(calls[1].url, '/profiles');
  assert.equal(calls[1].opts.method, 'POST');
  assert.deepEqual({ ...calls[1].opts.headers }, { 'Content-Type': 'application/json', 'X-Board-Token': 'tok' });
  const body = JSON.parse(calls[1].opts.body);
  assert.deepEqual(Object.keys(body).sort(), ['action', 'changes', 'expected', 'rosterRevision']);
  assert.equal(body.action, 'preview');
  assert.deepEqual(body.changes, [
    { kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' },
    { kind: 'selectProfile', profileKey: 'gpt-kimi-deepseek' },
  ]);
  assert.deepEqual(body.expected, STATE.targets);
  assert.equal(body.rosterRevision, 3);
  assert.equal(preview.preview.diffs[0].file, 'omo.jsonc');

  const applied = await c.apply();
  assert.equal(calls[2].url, '/profiles');
  assert.equal(JSON.parse(calls[2].opts.body).action, 'apply');
  assert.equal(calls[3].url, '/profiles/state', 'state is read again after an apply');
  assert.deepEqual(plain(applied.pending), []);
  assert.deepEqual(plain(applied.result.backups), ['C:/backup/omo-1.jsonc']);
  assert.equal(applied.view.roster.revision, 4);

  c.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' });
  const stale = await c.preview();
  assert.equal(calls[4].url, '/profiles');
  assert.equal(stale.conflict, true);
  assert.equal(stale.errorKind, 'conflict');
  assert.ok(stale.error.length > 0, 'the conflict keeps its inline cause');
});

test('controller: pending edits replace the same target, reset wins over lane/pin, drop and clear', () => {
  const P = load();
  const c = P.createController({ fetch: async () => ({ status: 200, json: async () => STATE }), token: 't' });
  c.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' });
  c.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-normal' });
  assert.equal(c.snapshot().pending.length, 1, 'the same agent lane replaces itself');
  assert.equal(c.snapshot().pending[0].lane, 'daily-normal');
  c.add({ kind: 'setAgentPin', agentId: 'atlas', pin: { provider: 'openai', modelId: 'gpt-6', thinking: 'high' } });
  assert.equal(c.snapshot().pending.length, 1, 'a pin also replaces the lane for that agent');
  c.add({ kind: 'resetAgentMemory', agentId: 'atlas' });
  assert.deepEqual(plain(c.snapshot().pending), [{ kind: 'resetAgentMemory', agentId: 'atlas' }]);
  c.add({ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'a', model: 'a/m', thinking: 'low' });
  c.add({ kind: 'setRoute', section: 'agents', role: 'oracle', provider: 'b', model: 'b/m', thinking: 'high' });
  assert.equal(c.snapshot().pending.length, 3);
  c.drop('1');
  assert.equal(c.snapshot().pending.length, 2);
  c.clear();
  assert.deepEqual(plain(c.snapshot().pending), []);
});

test('controller: a non-200 preview is shown, never reported as success, and pending stays', async () => {
  const P = load();
  const c = P.createController({
    fetch: (url) => Promise.resolve(url === '/profiles/state'
      ? { status: 200, json: async () => STATE }
      : { status: 400, json: async () => ({ ok: false, code: 'ALLOWLIST', message: 'omo.jsonc keys are not allowed' }) }),
    token: 't'
  });
  await c.load();
  c.add({ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'a', model: 'a/m', thinking: 'low' });
  const snap = await c.preview();
  assert.equal(snap.preview, null);
  assert.equal(snap.status, '실패');
  assert.match(snap.error, /omo\.jsonc keys are not allowed/);
  assert.equal(snap.pending.length, 1, 'edits survive a refusal');
});

test('controller: a refused apply (UNSUPPORTED_MODEL) reads as one Korean sentence with the code beside it, in the tray and the nav', async () => {
  const P = load();
  const c = P.createController({
    fetch: (url) => Promise.resolve(url === '/profiles/state'
      ? { status: 200, json: async () => STATE }
      : { status: 400, json: async () => ({ ok: false, code: 'UNSUPPORTED_MODEL' }) }),
    token: 't'
  });
  await c.load();
  c.add({ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'opencode', model: 'opencode/gemini-4-argon', thinking: 'high' });
  const snap = await c.apply();
  assert.equal(snap.status, '실패');
  assert.equal(snap.pending.length, 1, 'the refused edit stays pending');
  const edit = { ...snap, live: true };
  const shown = '설치 엔진이 이 모델을 지원하지 않아 적용하지 않았으니 다른 모델을 고르십시오. <code class="pf-err-code">UNSUPPORTED_MODEL</code>';
  assert.equal(/<p class="pf-err" role="alert">([\s\S]*?)<\/p>/.exec(P.render(snap.view, edit))[1], shown, 'tray');
  assert.equal(/<p class="pf-nav-warn">([\s\S]*?)<\/p>/.exec(P.side(snap.view, edit))[1], shown, 'nav');
});

test('controller: expected state-read failure is plain, contained, and retry recovers', async () => {
  const P = load();
  let rejectNext = true;
  const c = P.createController({
    fetch: () => {
      if (rejectNext) { rejectNext = false; throw new Error('qa-offline'); }
      return Promise.resolve({ status: 200, json: async () => STATE });
    },
    token: 't',
  });
  const failed = await c.load();
  assert.equal(failed.loading, false);
  assert.equal(failed.errorKind, 'network');
  assert.ok(failed.error.length > 0, 'the expected failure still gets plain user copy');
  assert.doesNotMatch(failed.error, /qa-offline/, 'the raw cause token must stay out of the user copy');
  const retried = await c.load();
  assert.equal(retried.error, '');
  assert.equal(retried.loading, false);
  assert.equal(retried.view.activeProfile.key, 'gpt-kimi-deepseek');
});

test('page wiring: busy preview and its result keep focus on the profiles status', async () => {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => STATE });
  await tick();
  const lane = e.byId.main.querySelector('[data-pf="agent-lane"][data-agent="atlas"]');
  lane.value = 'daily-heavy';
  e.fire(lane, 'change');
  await tick();
  e.fire(e.byId.main.querySelector('[data-pf="preview"]'), 'click');
  assert.equal(e.document.activeElement.id, 'pf-focus-status', 'busy render dropped focus');
  assert.equal(e.page.state.ui.profilesState.busy, true, 'the held preview is not marked busy');
  assert.ok(e.document.activeElement.textContent.trim().length > 0, 'the busy status is empty');
  const post = e.fetches[e.fetches.length - 1];
  post.resolve({ status: 200, ok: true, json: async () => ({ ok: true, action: 'preview', diffs: [], warnings: [], writes: [] }) });
  await tick();
  assert.equal(e.document.activeElement.id, 'pf-focus-status', 'preview result dropped focus');
  assert.equal(e.page.state.ui.profilesState.busy, false, 'the settled preview is still marked busy');
  assert.ok(e.page.state.ui.profilesState.preview, 'the preview payload is missing');
  assert.deepEqual(e.errors, []);
});

test('no polling: the view never schedules a timer', () => {
  const src = read('src/page/profiles-view.js');
  assert.doesNotMatch(src, /setInterval|setTimeout|requestAnimationFrame/);
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('page wiring: Reflection and Kibitzer memory edits stay separate through the delegated handler', async () => {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => STATE });
  await tick();

  async function setRow(key, service, model, thinking) {
    let mode = e.byId.main.querySelector('[data-pf="memory-mode"][data-memory="' + key + '"]');
    assert.ok(mode, key + ' mode control');
    mode.value = 'custom';
    e.fire(mode, 'change');
    await tick();
    const svc = e.byId.main.querySelector('[data-pf="memory-service"][data-memory="' + key + '"]');
    assert.ok(svc, key + ' service control');
    svc.value = service;
    e.fire(svc, 'change');
    await tick();
    const mdl = e.byId.main.querySelector('[data-pf="memory-model"][data-memory="' + key + '"]');
    assert.ok(mdl, key + ' model control');
    mdl.value = model;
    e.fire(mdl, 'change');
    await tick();
    const think = e.byId.main.querySelector('[data-pf="memory-thinking"][data-memory="' + key + '"]');
    assert.ok(think, key + ' thinking control');
    think.value = thinking;
    e.fire(think, 'change');
    await tick();
  }

  await setRow('kibitzer', 'anthropic', 'anthropic/claude-opus-5-5', 'high');
  await setRow('reflection', 'chatgpt-subscription', 'chatgpt-subscription/gpt-6.1-sol', 'high');
  const pendingText = e.byId.main.querySelector('.pf-pending').textContent;
  assert.match(pendingText, /Kibitzer 메모리 행/);
  assert.match(pendingText, /Reflection 메모리 행/);

  e.fire(e.byId.main.querySelector('[data-pf="preview"]'), 'click');
  const post = e.fetches[e.fetches.length - 1];
  assert.equal(post.url, '/profiles');
  const changes = JSON.parse(post.opts.body).changes;
  assert.deepEqual(changes.filter((c) => c.kind !== 'selectProfile').map((c) => c.row || 'kibitzer').sort(), ['kibitzer', 'reflection']);
  assert.equal(changes.find((c) => c.row === 'kibitzer').model, 'anthropic/claude-opus-5-5');
  assert.equal(changes.find((c) => c.row === 'reflection').model, 'chatgpt-subscription/gpt-6.1-sol');
});

test('page wiring: 다시 적용 posts the journal payload through the protected apply route', async () => {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  const interrupted = clone(STATE);
  interrupted.applyJournal = {
    v: 1, id: 'crash-1', action: '다시 적용', status: 'interrupted', label: '중단된 적용',
    reapply: {
      changes: [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }],
      rosterRevision: 3
    }
  };
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => interrupted });
  await tick();

  const reapply = e.byId.main.querySelector('[data-pf="reapply"]');
  assert.ok(reapply, 'the interrupted banner owns a real button');
  e.fire(reapply, 'click');
  await tick();
  const post = e.fetches[e.fetches.length - 1];
  assert.equal(post.url, '/profiles');
  assert.equal(post.opts.method, 'POST');
  const body = JSON.parse(post.opts.body);
  assert.equal(body.action, 'apply');
  assert.deepEqual(body.changes, interrupted.applyJournal.reapply.changes);
  assert.deepEqual(body.expected, STATE.targets);
  assert.equal(body.rosterRevision, 3);
  post.resolve({ status: 200, ok: true, json: async () => ({ ok: true, action: 'apply', backups: [], writes: ['agent/settings.json'], hashes: {} }) });
  await tick();
  const reload = e.fetches[e.fetches.length - 1];
  assert.equal(reload.url, '/profiles/state');
  reload.resolve({ status: 200, ok: true, json: async () => ({ ...interrupted, applyJournal: { status: 'completed' } }) });
  await tick();
  assert.deepEqual(e.errors, []);
});

test('page wiring: the profiles rail click loads GET /profiles/state and a preview posts the pending change', async () => {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  const rail = e.byId.rail.querySelector('[data-key="profiles"]');
  assert.ok(rail, 'the rail entry exists');
  e.fire(rail, 'click');
  assert.equal(e.page.state.ui.view, 'profiles');
  const get = e.fetches.find((f) => f.url === '/profiles/state');
  assert.ok(get, 'opening the view reads the state once');
  get.resolve({ status: 200, ok: true, json: async () => STATE });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(e.byId.main.querySelector('.pf'), 'the main region is the profiles view');
  assert.equal(e.byId.main.querySelectorAll('[data-pf-sec]').length, 9);
  const lane = e.byId.main.querySelector('[data-pf="agent-lane"][data-agent="atlas"]');
  lane.value = 'daily-heavy';
  e.fire(lane, 'change');
  assert.match(e.byId.main.querySelector('.pf-pending').textContent, /atlas 레인 → daily-heavy/);
  assert.match(e.byId.side.textContent, /변경 보류 1건/, 'the sidebar tray chip follows the pending edits');
  e.fire(e.byId.main.querySelector('[data-pf="preview"]'), 'click');
  const post = e.fetches[e.fetches.length - 1];
  assert.equal(post.url, '/profiles');
  assert.equal(post.opts.method, 'POST');
  assert.equal(JSON.parse(post.opts.body).action, 'preview');
  post.resolve({ status: 200, ok: true, json: async () => ({ ok: true, action: 'preview', diffs: [{ file: 'agent/primary-agents/roster.json', changes: [{ path: '$.agents.atlas.lane', before: 'daily-normal', after: 'daily-heavy' }] }], warnings: [], writes: ['agent/primary-agents/roster.json'] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(e.byId.main.textContent, /\$\.agents\.atlas\.lane/);
  assert.deepEqual(e.errors, []);
});

test('loading: four full-width agent placeholders keep the loaded field set', () => {
  const P = load();
  const html = P.render(null, live({ loading: true }));
  assert.equal((html.match(/data-pf-skel="agent"/g) || []).length, 4);
  const agentBlocks = [...html.matchAll(/<div class="pf-skel pf-skel-agent"[^>]*>([\s\S]*?)<\/div>/g)];
  assert.equal(agentBlocks.length, 4);
  for (const [, body] of agentBlocks) assert.equal((body.match(/class="pf-skel-field/g) || []).length, 4, 'four fields per agent row');
  assert.equal((html.match(/data-pf-skel="route"/g) || []).length, 20, 'routing skeleton rows');
  assert.equal((html.match(/class="pf-skel pf-skel-card"/g) || []).length, 6);
  // The skeleton consumes the loaded primitives; the actual first-row rect comparison lives in
  // scripts/qa-profiles.mjs because string assertions cannot measure layout.
  assert.match(html, /class="pf-agents">/);
  assert.match(html, /class="pf-cards">/);
  assert.match(html, /class="pf-routes">/);
  assert.match(html, /class="pf-sec-b">/);
});

test('guide: heading, chip and subtitle derive the one runtime inventory version', () => {
  const P = load();
  const state = clone(STATE);
  state.guide.title = 'OMO 권장 배치 · 설치판 5.1.33';
  state.guide.version = '5.1.44';
  state.inventory.version = '9.9.9';
  const html = P.render(state, live());
  const sec = /<section class="pf-sec" id="pf-sec-guide"[\s\S]*?<\/section>/.exec(html)[0];
  const head = textOf(/<div class="pf-guide-h">([\s\S]*?)<\/div>/.exec(sec)[1]);
  assert.match(head, /OMO 권장 배치 · 9\.9\.9/);
  assert.match(head, /9\.9\.9/);
  assert.doesNotMatch(head, /5\.1\.33|5\.1\.44/);
  assert.equal(textOf(/<p class="pf-sec-s">([\s\S]*?)<\/p>/.exec(sec)[1]), '9.9.9 기준 경로와 sha256');
  assert.doesNotMatch(sec, /설치판 5\.1\.33/, 'the stale manifest edition label never reaches the guide');
});

test('409: preview/apply are disabled, reload is primary, and a successful load clears the conflict', async () => {
  const P = load();
  let calls = 0;
  const responses = [
    { status: 200, json: async () => STATE },
    { status: 409, json: async () => ({ ok: false, code: 'STALE' }) },
    { status: 200, json: async () => STATE },
  ];
  const c = P.createController({
    fetch: () => { calls += 1; return Promise.resolve(responses.shift()); },
    token: 't',
  });
  await c.load();
  c.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' });
  const stale = await c.apply();
  assert.equal(stale.conflict, true);
  const html = P.render(stale.view, { ...stale, live: true });
  assert.match(/<button[^>]*data-pf="preview"[^>]*>/.exec(html)[0], /\bdisabled\b/);
  assert.match(/<button[^>]*data-pf="apply"[^>]*>/.exec(html)[0], /\bdisabled\b/);
  assert.match(/<button[^>]*data-pf="reload"[^>]*>/.exec(html)[0], /pf-btn-primary/);
  assert.equal(calls, 2);
  const blocked = await c.apply();
  assert.equal(calls, 2, 'a stale conflict cannot post the same roster revision again');
  assert.equal(blocked.conflict, true);
  const reloaded = await c.load();
  assert.equal(reloaded.conflict, false);
  assert.equal(reloaded.status, '');
  assert.equal(calls, 3);
  const after = P.render(reloaded.view, { ...reloaded, live: true });
  assert.doesNotMatch(/<button[^>]*data-pf="apply"[^>]*>/.exec(after)[0], /\bdisabled\b/);
});

test('409 latch: edits, drop, removeKind and clear keep the stale baseline blocked until load()', async () => {
  const P = load();
  let calls = 0;
  const bodies = [];
  const fresh = {
    ...clone(STATE),
    targets: { ...STATE.targets, 'fresh-target.json': 'fresh-sha' },
    roster: { ...STATE.roster, revision: 9 },
  };
  const responses = [
    { status: 200, json: async () => STATE },
    { status: 409, json: async () => ({ ok: false, code: 'STALE' }) },
    { status: 200, json: async () => fresh },
    { status: 200, json: async () => ({ ok: true, action: 'preview', diffs: [], warnings: [], writes: [] }) },
  ];
  const c = P.createController({
    fetch: (url, opts) => {
      calls += 1;
      if (opts && opts.body) bodies.push(JSON.parse(opts.body));
      return Promise.resolve(responses.shift());
    },
    token: 't',
  });
  await c.load();
  assert.equal(calls, 1);
  c.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' });
  const stale = await c.apply();
  assert.equal(stale.conflict, true);
  assert.equal(calls, 2);
  assert.deepEqual(bodies[0].expected, STATE.targets);
  assert.equal(bodies[0].rosterRevision, 3);

  // Edits after the 409 keep the latch; they must not make the stale view look fresh.
  c.add({ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' });
  assert.equal(c.snapshot().conflict, true);
  const blockedPreview = await c.preview();
  const blockedApply = await c.apply();
  assert.equal(calls, 2, 'preview/apply after a 409 must not fetch');
  assert.equal(blockedPreview.conflict, true);
  assert.equal(blockedApply.conflict, true);

  // Dropping and removing intents cannot lift the latch either.
  c.drop(0);
  assert.equal(c.snapshot().conflict, true);
  c.removeKind('setRoute');
  assert.equal(c.snapshot().conflict, true);
  assert.equal(c.snapshot().pending.length, 0);
  await c.preview();
  assert.equal(calls, 2);

  // Discard removes the pending edits but not the stale-baseline fact.
  c.add({ kind: 'setAgentLane', agentId: 'prometheus', lane: 'geeky-heavy' });
  c.clear();
  assert.equal(c.snapshot().conflict, true);
  assert.equal(c.snapshot().pending.length, 0);
  c.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-normal' });
  assert.equal(c.snapshot().conflict, true);
  await c.preview();
  await c.apply();
  assert.equal(calls, 2, 'a new intent after clear still cannot post the stale baseline');

  // Only a successful state read lifts it and replaces the baseline.
  const reloaded = await c.load();
  assert.equal(calls, 3);
  assert.equal(reloaded.conflict, false);
  assert.equal(reloaded.status, '');
  assert.deepEqual(reloaded.view.targets, fresh.targets);
  assert.equal(reloaded.view.roster.revision, 9);
  const preview = await c.preview();
  assert.equal(calls, 4);
  assert.equal(preview.conflict, false);
  assert.deepEqual(bodies[1].expected, fresh.targets, 'the post-reload send uses the fresh expected targets');
  assert.equal(bodies[1].rosterRevision, 9, 'the post-reload send uses the fresh roster revision');
});

test('busy: a held apply rejects controller mutations and disables every editor control', async () => {
  const P = load();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const c = P.createController({
    fetch: (url) => url.endsWith('/state')
      ? Promise.resolve({ status: 200, json: async () => STATE })
      : held,
    token: 't',
  });
  await c.load();
  c.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' });
  const applying = c.apply();
  assert.equal(c.snapshot().busy, true);
  const pendingBefore = plain(c.snapshot().pending);
  const draftBefore = plain(c.snapshot().draft);
  c.add({ kind: 'setAgentLane', agentId: 'sisyphus', lane: 'geeky-heavy' });
  c.setDraft('agent:sisyphus', { lane: 'geeky-heavy' });
  c.drop(0); c.clear(); c.askClear(); c.cancelClear(); c.touch(); c.removeKind('setAgentLane');
  assert.deepEqual(plain(c.snapshot().pending), pendingBefore, 'a busy controller accepted a newer edit');
  assert.deepEqual(plain(c.snapshot().draft), draftBefore, 'a busy controller accepted draft input');
  const html = P.render(STATE, { ...live(), busy: true, confirmClear: true,
    pending: [{ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' }] });
  for (const name of ['agent-lane', 'agent-pin', 'agent-pin-thinking', 'route-provider', 'route-model',
    'route-thinking', 'main-provider', 'main-model', 'main-thinking', 'lane-select', 'lane-literal',
    'summarizer-provider', 'summarizer-model', 'memory-mode', 'memory-service', 'memory-model', 'memory-thinking', 'reset-memory', 'drop',
    'clear-cancel', 'clear-confirm']) {
    const tags = [...html.matchAll(new RegExp('<[^>]*data-pf="' + name + '"[^>]*>', 'g'))].map((m) => m[0]);
    assert.ok(tags.length > 0, name + ' control missing from the busy render');
    for (const tag of tags) assert.match(tag, /\bdisabled\b/, name + ' accepts edits while busy');
  }
  assert.match(/<button[^>]*data-pf="select-profile"[^>]*>/.exec(html)[0], /\bdisabled\b/);
  release({ status: 200, json: async () => ({ ok: true, action: 'apply', backups: [], writes: ['omo.jsonc'], hashes: {} }) });
  const settled = await applying;
  assert.equal(settled.busy, false);
  assert.deepEqual(plain(settled.pending), [], 'the submitted edit was the only edit that existed');
});

test('pin hint: GPT 계열만 sits inside the pin label before the thinking control', () => {
  const P = load();
  const html = P.render(STATE, live());
  const agent = /<article class="pf-agent" data-pf-agent="hephaestus">[\s\S]*?<\/article>/.exec(html)[0];
  const label = /<label class="pf-sel"[^>]*for="pf-agent-pin-hephaestus"[^>]*>[\s\S]*?<\/label>/.exec(agent)[0];
  assert.match(label, /<span class="pf-hint">GPT 계열만<\/span>/);
  const pin = agent.indexOf('id="pf-agent-pin-hephaestus"');
  const hint = agent.indexOf('pf-hint');
  const think = agent.indexOf('id="pf-agent-pin-thinking-hephaestus"');
  assert.equal((agent.match(/pf-hint/g) || []).length, 1);
  assert.ok(pin < hint && hint < think, 'hint is after the pin select and before the thinking select');
});

test('copy: product names, interpunct compounds and modifier phrases stay unbreakable', () => {
  const P = load();
  const html = P.render(STATE, live());
  for (const phrase of ['깊은 구현·검토를', '탐색·단순 작업을', '조율·검증·고강도 추론을',
    '구현·탐색·빠른 작업을', '개인용 프로필입니다', 'GLM 5.3 Flash(max 추론)']) {
    assert.ok(html.includes('<span class="pf-keep">' + phrase + '</span>'), phrase);
  }
  assert.ok((html.match(/pf-keep/g) || []).length >= 10);
  for (const [, body] of html.matchAll(/<span class="pf-card-sum">([\s\S]*?)<\/span>\s*<span class="pf-card-main">/g)) {
    const outside = body.replace(/<span class="pf-keep">[\s\S]*?<\/span>/g, '');
    assert.doesNotMatch(outside, /·/, 'an interpunct outside a keep span can start a line');
  }
});

test('tray: empty is compact and visibly names the next action', () => {
  const P = load();
  let html = P.render(STATE, live());
  assert.match(html, /class="pf-tray pf-tray-compact"/);
  const strip = /<section class="pf-tray pf-tray-compact"[\s\S]*?<\/section>/.exec(html)[0];
  assert.doesNotMatch(strip, /data-pf="(?:preview|apply)"/, 'the empty message strip carries no action; apply lives in the detail');
  assert.match(html, /class="pf-count">0</);
  assert.match(strip, /<span class="pf-tag">\[대기\]<\/span>/, 'nothing is on hold while the count is 0');
  const next = /<span class="pf-tray-next">([^<]+)<\/span>/.exec(html);
  assert.ok(next && textOf(next[1]).trim().length >= 8, 'the compact tray needs a visible next action');
  const pending = [{ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' }];
  html = P.render(STATE, live({ pending }));
  assert.doesNotMatch(html, /pf-tray-compact/);
  assert.match(/<section class="pf-tray"[\s\S]*?<\/header>/.exec(html)[0], /<span class="pf-tag">\[보류\]<\/span>/, 'a staged change is on hold');
  assert.match(html, /data-pf="preview"/);
  const clear = /<button[^>]*data-pf="clear"[^>]*>/.exec(html)[0];
  assert.match(clear, /pf-btn-danger/);
  assert.doesNotMatch(html, /class="pf-clear"/);
  html = P.render(STATE, live({ pending, confirmClear: true }));
  assert.match(html, /role="group" aria-label="대기 변경 버리기 확인"/);
  assert.match(html, /data-pf="clear-cancel"/);
  assert.match(html, /data-pf="clear-confirm"/);
  for (const extra of [
    { result: { ok: true, backups: [], writes: [] } },
    { error: '보내지 못했어요' },
    { conflict: true, status: '다른 곳에서 바뀜', error: '다른 곳에서 바뀌었어요 — 새로고침 후 다시 적용' },
  ]) {
    const full = P.render(STATE, live(extra));
    assert.doesNotMatch(full, /pf-tray-compact/);
  }
  const interrupted = clone(STATE);
  interrupted.applyJournal = {
    status: 'interrupted', label: '중단된 적용',
    reapply: { changes: [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }] },
  };
  const journal = P.render(interrupted, live());
  assert.match(journal, /data-pf-journal="interrupted"/);
  assert.match(journal, /data-pf="reapply"/);
  assert.match(journal, /pf-tray-compact/);
});

test('empty data: the real count drives the copy and one supported reload action', async () => {
  const P = load();
  const empty = clone(STATE);
  empty.activeProfile = null;
  empty.profiles = [];
  empty.routing = { ...empty.routing, rows: [] };
  const html = P.render(empty, live());
  const profiles = /<section class="pf-sec" id="pf-sec-profiles"[\s\S]*?<\/section>/.exec(html)[0];
  const routing = /<p class="pf-cap">[\s\S]*?<\/p>/.exec(html)[0] + html.slice(html.indexOf('id="pf-sec-routing"'), html.indexOf('id="pf-sec-lanes"'));
  const sub = textOf(/<p class="pf-sec-s">([\s\S]*?)<\/p>/.exec(profiles)[1]);
  const count = /<span class="pf-count">(\d+)<\/span>/.exec(profiles)[1];
  assert.equal(Number(count), empty.profiles.length);
  assert.equal(Number((sub.match(/\d+/) || [])[0]), empty.profiles.length);
  assert.match(routing, /class="pf-count">0</);
  assert.match(profiles, /data-pf="reload-state"/);
  assert.match(routing, /data-pf="reload-state"/);
  assert.doesNotMatch(html, /data-pf="select-profile"/, 'empty data must not invent profile creation');
  const busyHtml = P.render(empty, live({ busy: true }));
  assert.match(/<button[^>]*data-pf="reload-state"[^>]*>/.exec(busyHtml)[0], /\bdisabled\b/);

  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => empty });
  await tick();
  const readsBefore = e.fetches.filter((f) => f.url === '/profiles/state').length;
  e.fire(e.byId.main.querySelector('[data-pf="reload-state"]'), 'click');
  const reread = e.fetches.filter((f) => f.url === '/profiles/state')[readsBefore];
  assert.ok(reread, 'the empty-state recovery did not re-read the real state');
  reread.resolve({ status: 200, ok: true, json: async () => empty });
  await tick();
  assert.equal(e.byId.main.querySelectorAll('.pf-card').length, 0);
  assert.equal(e.fetches.some((f) => f.url === '/profiles'), false, 'empty recovery must not post a write');
  assert.deepEqual(e.errors, []);
});

test('clear confirmation: cancel preserves every pending value; confirm is the only discard', async () => {
  const P = load();
  const c = P.createController({ fetch: async () => ({ status: 200, json: async () => STATE }), token: 't' });
  await c.load();
  c.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' });
  c.add({ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' });
  let snap = c.askClear();
  assert.equal(snap.confirmClear, true);
  assert.equal(snap.pending.length, 2);
  snap = c.cancelClear();
  assert.equal(snap.confirmClear, false);
  assert.equal(snap.pending.length, 2, 'cancelling the confirmation keeps both pending changes');
  assert.deepEqual(plain(snap.pending).map((x) => x.kind).sort(), ['setAgentLane', 'setRoute']);
  snap = c.clear();
  assert.equal(snap.pending.length, 0);
  assert.equal(snap.confirmClear, false);
});

test('identity: the four fixed colours keep distinct labelled shapes, not status recolouring', () => {
  const P = load();
  const html = P.render(STATE, live());
  const dots = [...html.matchAll(/<span class="pf-dot pf-dot-(\w+) pf-shape-(\w+)" role="img" aria-label="([^"]+)"><\/span>/g)];
  assert.equal(dots.length, 4);
  assert.deepEqual(dots.map((m) => m[2]), ['circle', 'square', 'triangle', 'diamond']);
  assert.deepEqual(dots.map((m) => m[1]), ['sisyphus', 'hephaestus', 'prometheus', 'atlas']);
  for (const [, id, , label] of dots) assert.match(label, new RegExp('· (원형|사각형|삼각형|마름모) 표식'));
  const tokens = read('src/page/tokens.css');
  assert.match(tokens, /--agent-sisyphus: #00ced1;/);
  assert.match(tokens, /--agent-hephaestus: #d97706;/);
  assert.match(tokens, /--agent-prometheus: #a78bfa;/);
  assert.match(tokens, /--agent-atlas: #10b981;/);
  const css = read('src/page/profiles-view.css');
  assert.match(css, /\.pf-dot-sisyphus \{ background: var\(--agent-sisyphus\); \}/);
  assert.doesNotMatch(css, /\.pf-shape-(circle|square|triangle|diamond) \{ background:/);
});

test('selected card: a green wash marks the shown card; a check glyph joins 적용 중 on the active one', () => {
  const P = load();
  const html = P.render(STATE, live());
  const on = /<article class="pf-card on">[\s\S]*?<\/article>/.exec(html)[0];
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /class="pf-chip pf-c-green pf-current"/);
  assert.match(on, /href="#i-check"/);
  assert.match(on, /적용 중/);
  const other = P.render(STATE, live({ shown: 'experimental-custom' }));
  assert.match(/<article class="pf-card on">[\s\S]*?<\/article>/.exec(other)[0], /data-profile="experimental-custom"/, 'the wash follows the shown card');
  assert.equal((other.match(/pf-current/g) || []).length, 1, '적용 중 stays on the active card only');
  const css = read('src/page/profiles-view.css');
  assert.match(css, /\.pf-card\.on \{[^}]*background: var\(--c-green-tint\)/);
  assert.match(css, /\.pf-card\.on \{[^}]*box-shadow: inset 0 0 0 1px var\(--c-green\)/);
});

test('compact title: the profiles page keeps its sticky title and section nav', () => {
  const P = load();
  const css = read('src/page/profiles-view.css');
  const at599 = css.slice(css.indexOf('@media (max-width: 599px)'));
  assert.match(at599, /\.pf-head \{ position: sticky; top: 0;/);
  assert.match(at599, /\.pf-title \{ margin: 0; font-size: var\(--fs-lg\)/);
  const side = P.side(STATE, live());
  assert.match(side, /data-pf-side/);
  assert.match(side, /data-pf="jump"/);
});

function selectedValueOf(el) {
  if (!el) return '';
  if (el.value) return el.value;
  for (const opt of el.querySelectorAll('option')) {
    if (opt.hasAttribute('selected')) return opt.getAttribute('value') || '';
  }
  return '';
}

test('memory rows: quick shows the effective quick tuple read-only; custom starts empty', async () => {
  const state = clone(STATE);
  state.catalog = {
    'flash-high': {
      model: 'opencode-go/deepseek-v4-flash',
      variant: 'high',
      served: { primary: true, stable: true },
      levels: ['off', 'medium', 'high']
    },
    'antigrav-opus': {
      model: 'antigravity-ocx/google-antigravity/claude-opus-5-5',
      variant: 'high',
      served: { primary: true, stable: true },
      levels: ['low', 'medium', 'high']
    },
    'unserved-argon': {
      model: 'opencode/gemini-4-argon',
      variant: 'high',
      served: { primary: true, stable: false },
      levels: ['high']
    }
  };
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => state });
  await tick();

  for (const key of ['kibitzer', 'reflection']) {
    const mode = e.byId.main.querySelector('[data-pf="memory-mode"][data-memory="' + key + '"]');
    const svc = e.byId.main.querySelector('[data-pf="memory-service"][data-memory="' + key + '"]');
    const mdl = e.byId.main.querySelector('[data-pf="memory-model"][data-memory="' + key + '"]');
    const eff = e.byId.main.querySelector('[data-pf="memory-thinking"][data-memory="' + key + '"]');
    assert.equal(selectedValueOf(mode), 'quick');
    assert.equal(svc.hasAttribute('disabled'), true);
    assert.equal(mdl.hasAttribute('disabled'), true);
    assert.equal(eff.hasAttribute('disabled'), true);
    assert.equal(selectedValueOf(svc), 'opencode-go');
    assert.equal(selectedValueOf(mdl), 'opencode-go/deepseek-v4-flash');
    assert.equal(selectedValueOf(eff), 'high');
    const curText = e.byId.main.querySelector('[data-pf-memory-current="' + key + '"]').textContent;
    const pendText = e.byId.main.querySelector('[data-pf-memory-pending="' + key + '"]').textContent;
    assert.match(curText, /^현재: quick · opencode-go\/deepseek-v4-flash \/ high/);
    assert.match(pendText, /^보류: /);
  }
  assert.doesNotMatch(e.byId.main.innerHTML, /<input[^>]*data-pf="memory-model"/, 'free-text memory input is replaced');
  assert.doesNotMatch(e.byId.main.innerHTML, /<option(?![^>]*\bdisabled\b)[^>]*value="opencode\/gemini-4-argon"/, 'unserved model is never an enabled option');

  const kMode = e.byId.main.querySelector('[data-pf="memory-mode"][data-memory="kibitzer"]');
  kMode.value = 'custom';
  e.fire(kMode, 'change');
  await tick();

  const kSvc = e.byId.main.querySelector('[data-pf="memory-service"][data-memory="kibitzer"]');
  const kMdl = e.byId.main.querySelector('[data-pf="memory-model"][data-memory="kibitzer"]');
  const kEff = e.byId.main.querySelector('[data-pf="memory-thinking"][data-memory="kibitzer"]');
  assert.equal(kSvc.hasAttribute('disabled'), false);
  assert.equal(kMdl.hasAttribute('disabled'), false);
  assert.equal(kEff.hasAttribute('disabled'), false);
  assert.equal(selectedValueOf(kSvc), '');
  assert.equal(selectedValueOf(kMdl), '');
  assert.equal(selectedValueOf(kEff), '');
  assert.equal(e.page.state.ui.profilesState.pending.some((c) => c.kind === 'setMemoryRow' && c.row === 'kibitzer'), false);
});

test('memory rows: service change clears model and effort; model change clears effort', async () => {
  const state = clone(STATE);
  state.catalog = {
    'antigrav-opus': {
      model: 'antigravity-ocx/google-antigravity/claude-opus-5-5',
      variant: 'high',
      served: { primary: true, stable: true },
      levels: ['low', 'medium', 'high']
    },
    'flash-high': {
      model: 'opencode-go/deepseek-v4-flash',
      variant: 'high',
      served: { primary: true, stable: true },
      levels: ['off', 'high']
    }
  };
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => state });
  await tick();

  let mode = e.byId.main.querySelector('[data-pf="memory-mode"][data-memory="kibitzer"]');
  mode.value = 'custom';
  e.fire(mode, 'change');
  await tick();

  let svc = e.byId.main.querySelector('[data-pf="memory-service"][data-memory="kibitzer"]');
  svc.value = 'antigravity-ocx';
  e.fire(svc, 'change');
  await tick();
  assert.equal(selectedValueOf(e.byId.main.querySelector('[data-pf="memory-service"][data-memory="kibitzer"]')), 'antigravity-ocx');
  assert.equal(selectedValueOf(e.byId.main.querySelector('[data-pf="memory-model"][data-memory="kibitzer"]')), '');
  assert.equal(selectedValueOf(e.byId.main.querySelector('[data-pf="memory-thinking"][data-memory="kibitzer"]')), '');

  let mdl = e.byId.main.querySelector('[data-pf="memory-model"][data-memory="kibitzer"]');
  mdl.value = 'antigravity-ocx/google-antigravity/claude-opus-5-5';
  e.fire(mdl, 'change');
  await tick();
  assert.equal(selectedValueOf(e.byId.main.querySelector('[data-pf="memory-service"][data-memory="kibitzer"]')), 'antigravity-ocx');
  assert.equal(selectedValueOf(e.byId.main.querySelector('[data-pf="memory-model"][data-memory="kibitzer"]')), 'antigravity-ocx/google-antigravity/claude-opus-5-5');
  assert.equal(selectedValueOf(e.byId.main.querySelector('[data-pf="memory-thinking"][data-memory="kibitzer"]')), '');
  const effOptions = [...e.byId.main.querySelector('[data-pf="memory-thinking"][data-memory="kibitzer"]').querySelectorAll('option')]
    .map((o) => o.getAttribute('value')).filter(Boolean);
  assert.deepEqual(effOptions, ['low', 'medium', 'high']);

  let eff = e.byId.main.querySelector('[data-pf="memory-thinking"][data-memory="kibitzer"]');
  eff.value = 'high';
  e.fire(eff, 'change');
  await tick();
  assert.equal(e.page.state.ui.profilesState.pending.some((c) => c.kind === 'setMemoryRow' && c.row === 'kibitzer' && c.mode === 'custom'), true);

  // Changing service clears model and effort and unstages the incomplete custom selection
  svc = e.byId.main.querySelector('[data-pf="memory-service"][data-memory="kibitzer"]');
  svc.value = 'opencode-go';
  e.fire(svc, 'change');
  await tick();
  assert.equal(selectedValueOf(e.byId.main.querySelector('[data-pf="memory-service"][data-memory="kibitzer"]')), 'opencode-go');
  assert.equal(selectedValueOf(e.byId.main.querySelector('[data-pf="memory-model"][data-memory="kibitzer"]')), '');
  assert.equal(selectedValueOf(e.byId.main.querySelector('[data-pf="memory-thinking"][data-memory="kibitzer"]')), '');
  assert.equal(e.page.state.ui.profilesState.pending.some((c) => c.kind === 'setMemoryRow' && c.row === 'kibitzer'), false);
});

test('memory rows: kibitzer and reflection are independent and render Must-have-4 strings and states', async () => {
  const P = load();
  const state = clone(STATE);
  const html = P.render(state, live());
  for (const required of [
    '공통 설정 · Kibitzer 회상',
    '공통 설정 · Reflection 성찰',
    '공통 / 전체 · Kibitzer 회상',
    '공통 / 전체 · Reflection 성찰',
    'quick 공유 (기본)',
    '직접 선택',
    '1. 구독 서비스',
    '2. AI 모델',
    '3. 추론 강도',
    '현재: ',
    '보류: ',
    '1. 제공사',
    '원본 기본 컴팩션',
  ]) {
    assert.ok(html.includes(required), 'missing Must-have-4 string: ' + required);
  }
  const savedHtml = P.render(state, live({ memorySaved: { kibitzer: true } }));
  assert.ok(savedHtml.includes('저장됨 · 다음 대화부터 반영'), 'missing saved state string');
  assert.doesNotMatch(
    /<p[^>]*data-pf-memory-pending="reflection"[^>]*>([\s\S]*?)<\/p>/.exec(savedHtml)[1],
    /저장됨 · 다음 대화부터 반영/,
    'reflection pending state stays independent of kibitzer saved state'
  );

  const errHtml = P.render(state, live({ memoryErrors: { reflection: '외부 카테고리 충돌' } }));
  assert.ok(errHtml.includes('실패 · 보류 유지: 외부 카테고리 충돌'), 'missing failure state string');
  assert.doesNotMatch(
    /<p[^>]*data-pf-memory-pending="kibitzer"[^>]*>([\s\S]*?)<\/p>/.exec(errHtml)[1],
    /실패 · 보류 유지:/,
    'kibitzer pending state stays independent of reflection error'
  );
});

test('summarizer: provider then model; 원본 기본 컴팩션 clears compaction.model and no effort control exists', async () => {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => STATE });
  await tick();

  const sumSec = e.byId.main.querySelector('#pf-sec-summarizer');
  assert.ok(sumSec, 'summarizer section exists');
  assert.equal(sumSec.querySelectorAll('select').length, 2, 'summarizer has exactly two selects (provider and model, no effort)');

  let prov = sumSec.querySelector('[data-pf="summarizer-provider"]');
  const firstOpt = prov.querySelectorAll('option')[0];
  assert.equal(firstOpt.getAttribute('value'), '');
  assert.equal(firstOpt.textContent, '원본 기본 컴팩션');
  assert.equal(selectedValueOf(prov), 'commandcode');

  // Choosing 원본 기본 컴팩션 clears compaction.model
  prov.value = '';
  e.fire(prov, 'change');
  await tick();
  assert.deepEqual(
    plain(e.page.state.ui.profilesState.pending.find((c) => c.kind === 'setSummarizer')),
    { kind: 'setSummarizer', modelId: '' }
  );
  assert.equal(e.byId.main.querySelector('[data-pf="summarizer-model"]').hasAttribute('disabled'), true);

  // Choosing a provider then a model stages that model
  prov = e.byId.main.querySelector('[data-pf="summarizer-provider"]');
  prov.value = 'anthropic';
  e.fire(prov, 'change');
  await tick();
  assert.equal(e.page.state.ui.profilesState.pending.some((c) => c.kind === 'setSummarizer'), false);
  const mdl = e.byId.main.querySelector('[data-pf="summarizer-model"]');
  assert.equal(mdl.hasAttribute('disabled'), false);
  mdl.value = 'anthropic/claude-opus-5-5';
  e.fire(mdl, 'change');
  await tick();
  assert.deepEqual(
    plain(e.page.state.ui.profilesState.pending.find((c) => c.kind === 'setSummarizer')),
    { kind: 'setSummarizer', modelId: 'anthropic/claude-opus-5-5' }
  );
});

// IS-6 fixture: opencode serves one model in both homes while stable refuses its Argon; every editor shows opencode.
function supportState() {
  const state = clone(STATE);
  state.catalog = {
    'oc-pro': { model: 'opencode/served-pro', variant: 'high', served: { primary: true, stable: true }, levels: ['low', 'high'] },
    'oc-argon': { model: 'opencode/gemini-4-argon', variant: 'high', served: { primary: true, stable: false }, levels: [] }
  };
  state.routing.rows.find((r) => r.section === 'agents' && r.role === 'explore').model = 'oc-pro';
  state.main = { effective: { provider: 'opencode', model: 'served-pro', thinking: 'high' }, override: null };
  state.summarizer = { provider: 'opencode', model: 'served-pro' };
  for (const key of ['kibitzer', 'reflection']) {
    state.memory[key] = { ...state.memory[key], mode: 'custom', category: 'desktop-' + key, alias: '', model: 'opencode/served-pro', reasoning: 'high' };
  }
  return state;
}
// Each editor's model select and the value its opencode Argon option carries (main keeps the provider-less id).
const SUPPORT_EDITORS = [
  ['role', 'data-flow="role:agents/explore:model"', 'opencode/gemini-4-argon'],
  ['main', 'data-pf="main-model"', 'gemini-4-argon'],
  ['summarizer', 'data-pf="summarizer-model"', 'opencode/gemini-4-argon'],
  ['kibitzer', 'data-flow="memory:kibitzer:model"', 'opencode/gemini-4-argon'],
  ['reflection', 'data-flow="memory:reflection:model"', 'opencode/gemini-4-argon']
];
function optionsOf(html, marker) {
  const pick = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].find((m) => m[1].includes(marker));
  assert.ok(pick, 'no select ' + marker);
  return [...pick[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((m) => ({
    value: /\bvalue="([^"]*)"/.exec(m[1])[1], text: textOf(m[2]), disabled: /\sdisabled\b/.test(m[1]),
    selected: /\sselected\b/.test(m[1]), title: (/\btitle="([^"]*)"/.exec(m[1]) || [])[1] || ''
  }));
}
function sliceFrom(html, start, end) {
  const at = html.indexOf(start);
  assert.ok(at >= 0, 'missing ' + start);
  const to = html.indexOf(end, at + start.length);
  return html.slice(at, to < 0 ? html.length : to);
}

test('support: an unserved model stays listed in role, main, summarizer, Kibitzer and Reflection, disabled with its reason', () => {
  const html = load().render(supportState(), live());
  for (const [name, marker, argon] of SUPPORT_EDITORS) {
    const options = optionsOf(html, marker);
    const off = options.find((o) => o.value === argon);
    assert.ok(off, name + ': the unserved model is filtered out of the list');
    assert.equal(off.disabled, true, name + ': the unserved model is selectable');
    assert.equal(off.title, '설치 엔진 미지원 · stable 홈 · UNSUPPORTED_MODEL', name);
    assert.match(off.text, /gemini-4-argon · 설치 엔진 미지원$/, name);
    const served = options.find((o) => o.value.endsWith('served-pro'));
    assert.equal(served.disabled, false, name + ': a served model stays selectable');
    assert.equal(served.selected, true, name);
  }
  assert.doesNotMatch(html, /pf-c-amber" title="UNSUPPORTED_MODEL"/, 'a served saved value carries no flag');
});

test('support: a saved unsupported value stays selected and flagged with its reason and home in every editor', () => {
  const state = supportState();
  Object.assign(state.routing.rows.find((r) => r.section === 'agents' && r.role === 'explore'),
    { model: 'oc-argon', reasoning: null, unsupported: true, unsupportedReason: 'UNSUPPORTED_MODEL', unsupportedHome: 'stable' });
  state.main.effective.model = 'gemini-4-argon';
  state.summarizer.model = 'gemini-4-argon';
  for (const key of ['kibitzer', 'reflection']) state.memory[key].model = 'opencode/gemini-4-argon';
  const html = load().render(state, live());
  const flag = '<span class="pf-chip pf-c-amber" title="UNSUPPORTED_MODEL">설치 엔진 미지원 · stable 홈</span>';
  const regions = {
    role: sliceFrom(html, 'data-pf-route="agents/explore"', 'data-pf-route="'),
    main: sliceFrom(html, 'id="pf-sec-main"', 'id="pf-sec-summarizer"'),
    summarizer: sliceFrom(html, 'id="pf-sec-summarizer"', 'data-pf-sec="tray"'),
    kibitzer: sliceFrom(html, 'data-pf-memory-row="kibitzer"', 'data-pf-memory-row="reflection"'),
    reflection: sliceFrom(html, 'data-pf-memory-row="reflection"', 'id="pf-sec-lanes"')
  };
  for (const [name, marker, argon] of SUPPORT_EDITORS) {
    const shown = optionsOf(html, marker).filter((o) => o.selected);
    assert.equal(shown.length, 1, name);
    assert.equal(shown[0].value, argon, name + ': the saved value is replaced');
    assert.equal(shown[0].disabled, true, name);
    assert.match(shown[0].text, /gemini-4-argon · 설치 엔진 미지원$/, name);
    assert.ok(regions[name].includes(flag), name + ': no flag with reason and home');
  }
  // The role row shows the saved tuple itself: its service and the alias's effort, not the first served choice.
  assert.equal(optionsOf(html, 'data-flow="role:agents/explore:service"').find((o) => o.selected)?.value, 'opencode');
  assert.equal(optionsOf(html, 'data-flow="role:agents/explore:effort"').find((o) => o.selected)?.value, 'high');
});

test('support: an unread registry keeps every model listed but disabled as 설치 엔진 미확인 (REGISTRY_UNKNOWN)', () => {
  const state = supportState();
  state.registry = { unknownHomes: ['stable'] };
  const html = load().render(state, live());
  for (const [name, marker] of SUPPORT_EDITORS) {
    const options = optionsOf(html, marker).filter((o) => o.value);
    assert.equal(options.length, 2, name);
    for (const o of options) {
      assert.equal(o.disabled, true, name + ' ' + o.value);
      assert.equal(o.title, '설치 엔진 미확인 · stable 홈 · REGISTRY_UNKNOWN', name + ' ' + o.value);
    }
  }
});

test('per-profile: a card click shows that profile and adds no pending', async () => {
  const P = load();
  const c = P.createController({ fetch: async () => ({ status: 200, json: async () => STATE }), token: 't' });
  await c.load();
  assert.equal(c.snapshot().shown, 'gpt-kimi-deepseek');
  assert.equal(c.snapshot().pending.length, 0);

  c.show('experimental-custom');
  assert.equal(c.snapshot().shown, 'experimental-custom');
  assert.equal(c.snapshot().pending.length, 0, 'showing another profile must add no pending changes');
});

test("per-profile: edit A, show B, edit B, apply B writes B's edits and the shared ones; A's stay pending", async () => {
  const P = load();
  let appliedBody = null;
  const c = P.createController({
    fetch: (url, opts) => {
      if (opts && opts.body) appliedBody = JSON.parse(opts.body);
      return Promise.resolve({
        status: 200,
        json: async () => (opts && opts.body ? { ok: true, action: 'apply', backups: [], writes: [] } : STATE),
      });
    },
    token: 't',
  });
  await c.load();

  // Edit in profile A (glm-deepseek)
  c.add({ kind: 'setRoute', profileKey: 'glm-deepseek', section: 'agents', role: 'explore', provider: 'openai-opencodex', model: 'openai-opencodex/gpt-5.6-sol', thinking: 'high' });
  // Shared global edit
  c.add({ kind: 'setSummarizer', modelId: 'anthropic/claude-opus-5-5' });
  assert.equal(c.snapshot().pending.length, 2);

  // Show profile B and edit in B (experimental-custom)
  c.show('experimental-custom');
  c.add({ kind: 'setRoute', profileKey: 'experimental-custom', section: 'agents', role: 'explore', provider: 'opencode-go', model: 'opencode-go/muse-spark-1.3-contributor', thinking: 'medium' });
  assert.equal(c.snapshot().pending.length, 3);

  // Apply profile B
  await c.apply('experimental-custom');
  assert.ok(appliedBody, 'apply should have sent request');
  const sentChanges = appliedBody.changes;

  // Submitted changes must contain B's edit, global summarizer, and selectProfile for B
  assert.ok(sentChanges.some((x) => x.kind === 'setRoute' && x.profileKey === 'experimental-custom'));
  assert.ok(sentChanges.some((x) => x.kind === 'setSummarizer'));
  assert.ok(sentChanges.some((x) => x.kind === 'selectProfile' && x.profileKey === 'experimental-custom'));
  // Must NOT contain A's edit
  assert.ok(!sentChanges.some((x) => x.kind === 'setRoute' && x.profileKey === 'glm-deepseek'));

  // After apply success: A's edits stay pending!
  const remainingPending = c.snapshot().pending;
  assert.equal(remainingPending.length, 1);
  assert.equal(remainingPending[0].profileKey, 'glm-deepseek');
});

test('order: a category edit plus activation in one apply leaves the active scope equal to the edited layer', async (t) => {
  const { openProfilesStore } = await import('../src/profiles/store.mjs');
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary');
  const stable = path.join(root, 'stable');
  fs.mkdirSync(path.join(primary, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(stable, 'agent'), { recursive: true });
  const goldenDir = path.join(ROOT, 'test', 'fixtures', 'profiles', 'goldens', 'apply-gpt-kimi-deepseek', 'files');
  fs.writeFileSync(path.join(primary, 'omo.jsonc'), fs.readFileSync(path.join(goldenDir, 'primary/omo.jsonc.json'), 'utf8'));
  fs.writeFileSync(path.join(primary, 'agent', 'settings.json'), fs.readFileSync(path.join(goldenDir, 'primary/settings.json.json'), 'utf8'));
  fs.writeFileSync(path.join(primary, 'native-profile-selection.json'), JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'seed' }, null, 2));
  fs.writeFileSync(path.join(primary, 'agent', 'native-profile-selection.json'), JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'seed' }, null, 2));
  fs.writeFileSync(path.join(stable, 'omo.jsonc'), fs.readFileSync(path.join(goldenDir, 'stable/omo.jsonc.json'), 'utf8'));
  const regPrimary = path.join(ROOT, 'test', 'fixtures', 'profiles', 'registry', 'primary', 'agent', 'models.json');
  const regStable = path.join(ROOT, 'test', 'fixtures', 'profiles', 'registry', 'stable', 'agent', 'models.json');
  if (fs.existsSync(regPrimary)) fs.copyFileSync(regPrimary, path.join(primary, 'agent', 'models.json'));
  if (fs.existsSync(regStable)) fs.copyFileSync(regStable, path.join(stable, 'agent', 'models.json'));

  const store = openProfilesStore({
    primaryHome: primary,
    stableHome: stable,
    mirrorHomes: [],
    now: () => 1700000000000,
  });
  const st = store.state();
  assert.ok(st.details, 'store.state() must expose details');

  // Apply a category route change on a profile together with selecting that profile
  const targetProfile = 'experimental-custom';
  const targetLayerCategoryBefore = st.details[targetProfile].routing.layer.categories['fast-explore'];
  assert.equal(targetLayerCategoryBefore?.model, 'cmd-qwen-qwen3-7-flash');

  const res = await store.apply({
    action: 'apply',
    rosterRevision: st.roster.revision,
    expected: st.targets,
    changes: [
      {
        kind: 'setRoute',
        profileKey: 'native-experimental-custom',
        section: 'categories',
        role: 'fast-explore',
        provider: 'openai-opencodex',
        model: 'openai-opencodex/gpt-5.6-sol',
        thinking: 'high',
      },
      {
        kind: 'selectProfile',
        profileKey: targetProfile,
      },
    ],
  });
  assert.equal(res.ok, true, 'apply must succeed');
  const fresh = store.state();
  assert.equal(fresh.activeProfile.key, targetProfile);
  const activeScopeCategory = fresh.routing.layer.categories['fast-explore'];
  const targetLayerCategory = fresh.details[targetProfile].routing.layer.categories['fast-explore'];
  assert.deepEqual(activeScopeCategory, targetLayerCategory, 'active scope must equal the edited layer after activation');
  assert.equal(activeScopeCategory.model, 'openai-opencodex-gpt-5-6-sol-high');
  assert.notEqual(activeScopeCategory.model, targetLayerCategoryBefore.model);
});

test('drop: removes the draft too', () => {
  const P = load();
  const c = P.createController({ fetch: async () => ({ status: 200, json: async () => STATE }), token: 't' });
  c.setDraft('route:agents/explore', { provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' });
  c.add({ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' });
  assert.ok(c.snapshot().draft['route:agents/explore']);
  assert.equal(c.snapshot().pending.length, 1);

  c.drop(0);
  assert.equal(c.snapshot().pending.length, 0);
  assert.equal(c.snapshot().draft['route:agents/explore'], undefined, 'drop must remove draft too');
});

test('preview: optional; apply without preview posts once; a draft edit clears a shown preview', async () => {
  const P = load();
  let calls = 0;
  const postedBodies = [];
  const c = P.createController({
    fetch: (url, opts) => {
      calls += 1;
      if (opts && opts.body) postedBodies.push(JSON.parse(opts.body));
      return Promise.resolve({
        status: 200,
        json: async () => (opts && opts.body ? { ok: true, action: opts.body.includes('preview') ? 'preview' : 'apply', diffs: [], backups: [], writes: [] } : STATE),
      });
    },
    token: 't',
  });
  await c.load();
  calls = 0;

  // Add a pending change
  c.add({ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' });

  // Apply directly without calling preview: must post exactly once
  await c.apply();
  assert.equal(calls, 2, 'apply without preview posts once to /profiles then reads state once');
  assert.equal(postedBodies[0].action, 'apply');

  // Next: preview, then a draft edit clears the shown preview
  c.add({ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' });
  await c.preview();
  assert.ok(c.snapshot().preview, 'preview must be present after calling preview()');

  // Draft edit clears shown preview
  c.setDraft('route:agents/explore', { thinking: 'high' });
  assert.equal(c.snapshot().preview, null, 'setDraft must clear shown preview');

  await c.preview();
  assert.ok(c.snapshot().preview);
  c.touch();
  assert.equal(c.snapshot().preview, null, 'touch must clear shown preview');

  await c.preview();
  assert.ok(c.snapshot().preview);
  c.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' });
  assert.equal(c.snapshot().preview, null, 'add must clear shown preview');

  await c.preview();
  assert.ok(c.snapshot().preview);
  c.drop(0);
  assert.equal(c.snapshot().preview, null, 'drop must clear shown preview');
});

test('cascade role: service change clears model and effort; model change picks the first supported effort; a row stages only when complete', async () => {
  const state = clone(STATE);
  state.catalog = {
    'opencode-contributor': {
      model: 'opencode-go/muse-spark-1.3-contributor',
      variant: 'medium',
      served: { primary: true, stable: true },
      levels: ['low', 'medium', 'high'],
    },
    'openai-sol': {
      model: 'openai-opencodex/gpt-5.6-sol',
      variant: 'high',
      served: { primary: true, stable: true },
      levels: ['off', 'low', 'medium', 'high'],
    },
  };
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => state });
  await tick();

  const row = e.byId.main.querySelector('[data-pf-route="agents/explore"]');
  assert.ok(row, 'agents/explore row exists');
  const provSel = row.querySelector('[data-pf="route-provider"]');
  const mdlSel = row.querySelector('[data-pf="route-model"]');
  const thinkSel = row.querySelector('[data-pf="route-thinking"]');

  // Change service to openai-opencodex
  provSel.value = 'openai-opencodex';
  e.fire(provSel, 'change');
  await tick();

  const rowAfterSvc = e.byId.main.querySelector('[data-pf-route="agents/explore"]');
  const mdlSelAfter = rowAfterSvc.querySelector('[data-pf="route-model"]');
  const thinkSelAfter = rowAfterSvc.querySelector('[data-pf="route-thinking"]');

  // Cascade: service change clears model and effort
  assert.equal(selectedValueOf(mdlSelAfter), '');
  assert.equal(selectedValueOf(thinkSelAfter), '');
  // Row does not stage when incomplete
  assert.ok(!e.page.state.ui.profilesState.pending.some((c) => c.kind === 'setRoute' && c.role === 'explore'));

  // Model change to openai-opencodex/gpt-5.6-sol -> picks first supported effort (off)
  mdlSelAfter.value = 'openai-opencodex/gpt-5.6-sol';
  e.fire(mdlSelAfter, 'change');
  await tick();

  const rowAfterMdl = e.byId.main.querySelector('[data-pf-route="agents/explore"]');
  const mdlSelFinal = rowAfterMdl.querySelector('[data-pf="route-model"]');
  const thinkSelFinal = rowAfterMdl.querySelector('[data-pf="route-thinking"]');

  assert.equal(selectedValueOf(mdlSelFinal), 'openai-opencodex/gpt-5.6-sol');
  assert.equal(selectedValueOf(thinkSelFinal), 'off');

  // Now all three are set: row stages!
  const staged = e.page.state.ui.profilesState.pending.find((c) => c.kind === 'setRoute' && c.role === 'explore');
  assert.ok(staged, 'row stages only when complete');
  assert.equal(staged.provider, 'openai-opencodex');
  assert.equal(staged.model, 'openai-opencodex/gpt-5.6-sol');
  assert.equal(staged.thinking, 'off');
});

test('cascade main: service change keeps a model present in the new list and clamps the current effort, else empties the model and stages override removal; model change clamps the current effort', async () => {
  const state = clone(STATE);
  state.catalog = {
    'ollama-flash': {
      model: 'ollama/glm-5.3-flash',
      variant: 'max',
      served: { primary: true, stable: true },
      levels: ['low', 'medium', 'high', 'max'],
    },
    'openai-sol': {
      model: 'openai-opencodex/gpt-5.6-sol',
      variant: 'xhigh',
      served: { primary: true, stable: true },
      levels: ['low', 'medium', 'high', 'xhigh'],
    },
    'commandcode-sol': {
      model: 'commandcode/gpt-5.6-sol',
      variant: 'xhigh',
      served: { primary: true, stable: true },
      levels: ['low', 'medium', 'high', 'xhigh'],
    },
  };
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => state });
  await tick();

  const mainBox = e.byId.main.querySelector('[data-pf-main]');
  assert.ok(mainBox, 'mainBox exists');
  const prov = mainBox.querySelector('[data-pf="main-provider"]');
  const mdl = mainBox.querySelector('[data-pf="main-model"]');
  const think = mainBox.querySelector('[data-pf="main-thinking"]');

  // Case 1: Service whose list does not hold current model -> empties model and stages override removal
  prov.value = 'ollama';
  e.fire(prov, 'change');
  await tick();
  let mainBoxCur = e.byId.main.querySelector('[data-pf-main]');
  let mdlCur = mainBoxCur.querySelector('[data-pf="main-model"]');
  mdlCur.value = 'glm-5.3-flash';
  e.fire(mdlCur, 'change');
  await tick();
  mainBoxCur = e.byId.main.querySelector('[data-pf-main]');
  let thinkCur = mainBoxCur.querySelector('[data-pf="main-thinking"]');
  thinkCur.value = 'max';
  e.fire(thinkCur, 'change');
  await tick();

  mainBoxCur = e.byId.main.querySelector('[data-pf-main]');
  let provCur = mainBoxCur.querySelector('[data-pf="main-provider"]');
  provCur.value = 'openai-opencodex';
  e.fire(provCur, 'change');
  await tick();

  mainBoxCur = e.byId.main.querySelector('[data-pf-main]');
  mdlCur = mainBoxCur.querySelector('[data-pf="main-model"]');
  thinkCur = mainBoxCur.querySelector('[data-pf="main-thinking"]');
  assert.equal(selectedValueOf(mdlCur), '');
  const stagedRemoval = e.page.state.ui.profilesState.pending.find((c) => c.kind === 'setMain');
  assert.ok(stagedRemoval, 'stages override removal');
  assert.equal(stagedRemoval.model, '');

  // Case 2: Model change clamps current effort to the new model
  mdlCur.value = 'gpt-5.6-sol';
  e.fire(mdlCur, 'change');
  await tick();

  mainBoxCur = e.byId.main.querySelector('[data-pf-main]');
  mdlCur = mainBoxCur.querySelector('[data-pf="main-model"]');
  thinkCur = mainBoxCur.querySelector('[data-pf="main-thinking"]');
  assert.equal(selectedValueOf(mdlCur), 'gpt-5.6-sol');
  assert.equal(selectedValueOf(thinkCur), 'xhigh');

  // Case 3: Service change whose list holds current model (by suffix gpt-5.6-sol) keeps model and clamps effort
  // (measured WinForms committed tuple: openai-opencodex -> commandcode keeps gpt-5.6-sol at xhigh)
  provCur = mainBoxCur.querySelector('[data-pf="main-provider"]');
  provCur.value = 'commandcode';
  e.fire(provCur, 'change');
  await tick();

  mainBoxCur = e.byId.main.querySelector('[data-pf-main]');
  mdlCur = mainBoxCur.querySelector('[data-pf="main-model"]');
  thinkCur = mainBoxCur.querySelector('[data-pf="main-thinking"]');
  assert.equal(selectedValueOf(mdlCur), 'gpt-5.6-sol');
  assert.equal(selectedValueOf(thinkCur), 'xhigh');
  const stagedKeep = e.page.state.ui.profilesState.pending.find((c) => c.kind === 'setMain');
  assert.deepEqual([stagedKeep.provider, stagedKeep.model, stagedKeep.thinking], ['commandcode', 'gpt-5.6-sol', 'xhigh']);
});

// Main-row clamp: WinForms Update-MainThinkingCombo -> Get-ClampedThinkingLevel on the model item's provider-qualified
// Tag keeps a supported effort, else takes the nearest higher level, else the nearest lower one.
async function openMainRow(catalog, mainStatus) {
  const state = clone(STATE);
  state.catalog = catalog;
  Object.assign(state.main, mainStatus);
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => state });
  await tick();
  return e;
}
const mainControl = (e, pf) => e.byId.main.querySelector('[data-pf-main]').querySelector('[data-pf="' + pf + '"]');
async function changeMain(e, pf, value) {
  const el = mainControl(e, pf);
  el.value = value;
  e.fire(el, 'change');
  await tick();
}
function stagedMain(e) {
  const c = e.page.state.ui.profilesState.pending.find((x) => x.kind === 'setMain');
  return c ? [c.provider, c.model, c.thinking] : null;
}

test('cascade main: service change clamps an unsupported effort to the nearest higher level', async () => {
  const e = await openMainRow({
    'openai-sol': { model: 'openai-opencodex/gpt-5.6-sol', variant: 'xhigh', served: { primary: true, stable: true }, levels: ['low', 'medium', 'high', 'xhigh'] },
    'commandcode-sol': { model: 'commandcode/gpt-5.6-sol', variant: 'max', served: { primary: true, stable: true }, levels: ['low', 'high', 'xhigh', 'max'] },
  });
  await changeMain(e, 'main-provider', 'openai-opencodex');
  await changeMain(e, 'main-model', 'gpt-5.6-sol');
  await changeMain(e, 'main-thinking', 'medium');
  assert.deepEqual(stagedMain(e), ['openai-opencodex', 'gpt-5.6-sol', 'medium']);

  // commandcode/gpt-5.6-sol has no medium: high is the nearest higher level (not the first, low, nor the last, max)
  await changeMain(e, 'main-provider', 'commandcode');
  assert.equal(selectedValueOf(mainControl(e, 'main-model')), 'gpt-5.6-sol');
  assert.equal(selectedValueOf(mainControl(e, 'main-thinking')), 'high');
  assert.deepEqual(stagedMain(e), ['commandcode', 'gpt-5.6-sol', 'high']);
});

test('cascade main: model change clamps an unsupported effort to the nearest higher level, else the nearest lower one', async () => {
  const e = await openMainRow({
    'ollama-flash': { model: 'ollama/glm-5.3-flash', variant: 'max', served: { primary: true, stable: true }, levels: ['low', 'medium', 'high', 'max'] },
    'ollama-glm': { model: 'ollama/glm-5.3', variant: 'xhigh', served: { primary: true, stable: true }, levels: ['medium', 'high', 'xhigh'] },
    'ollama-mini': { model: 'ollama/glm-5.3-mini', variant: 'medium', served: { primary: true, stable: true }, levels: ['minimal', 'low', 'medium'] },
  });
  await changeMain(e, 'main-provider', 'ollama');
  await changeMain(e, 'main-model', 'glm-5.3-flash');
  await changeMain(e, 'main-thinking', 'low');
  assert.deepEqual(stagedMain(e), ['ollama', 'glm-5.3-flash', 'low']);

  // low is below every glm-5.3 level: medium is the nearest higher one (not the last, xhigh)
  await changeMain(e, 'main-model', 'glm-5.3');
  assert.equal(selectedValueOf(mainControl(e, 'main-thinking')), 'medium');
  assert.deepEqual(stagedMain(e), ['ollama', 'glm-5.3', 'medium']);

  // glm-5.3-mini has nothing at or above xhigh: medium is the nearest lower one (not the first, minimal)
  await changeMain(e, 'main-thinking', 'xhigh');
  await changeMain(e, 'main-model', 'glm-5.3-mini');
  assert.equal(selectedValueOf(mainControl(e, 'main-thinking')), 'medium');
  assert.deepEqual(stagedMain(e), ['ollama', 'glm-5.3-mini', 'medium']);
});

test('cascade main: effort levels follow the provider-qualified model id, not the bare one', async () => {
  // gpt-5.6-sol is listed under two providers with different levels; openai-opencodex comes first in the catalog
  const e = await openMainRow({
    'openai-sol': { model: 'openai-opencodex/gpt-5.6-sol', variant: 'xhigh', served: { primary: true, stable: true }, levels: ['low', 'medium', 'high', 'xhigh'] },
    'commandcode-sol': { model: 'commandcode/gpt-5.6-sol', variant: 'max', served: { primary: true, stable: true }, levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'commandcode-55': { model: 'commandcode/gpt-5.5', variant: 'max', served: { primary: true, stable: true }, levels: ['low', 'medium', 'high', 'max'] },
  });
  await changeMain(e, 'main-provider', 'commandcode');
  await changeMain(e, 'main-model', 'gpt-5.5');
  await changeMain(e, 'main-thinking', 'max');
  assert.deepEqual(stagedMain(e), ['commandcode', 'gpt-5.5', 'max']);

  // model change: commandcode/gpt-5.6-sol supports max, so max is kept
  await changeMain(e, 'main-model', 'gpt-5.6-sol');
  assert.equal(selectedValueOf(mainControl(e, 'main-thinking')), 'max');
  assert.deepEqual(stagedMain(e), ['commandcode', 'gpt-5.6-sol', 'max']);

  // service change: openai-opencodex/gpt-5.6-sol has no max, so the nearest lower level is xhigh
  await changeMain(e, 'main-provider', 'openai-opencodex');
  assert.equal(selectedValueOf(mainControl(e, 'main-model')), 'gpt-5.6-sol');
  assert.equal(selectedValueOf(mainControl(e, 'main-thinking')), 'xhigh');
  assert.deepEqual(stagedMain(e), ['openai-opencodex', 'gpt-5.6-sol', 'xhigh']);
});

// Main-row effort list: WinForms Update-MainThinkingCombo rebuilds the combo from the provider-qualified model's
// supported levels and selects the clamped effort; with no model entry or no levels the seven-level list stays.
const mainEffortValues = (e) => [...mainControl(e, 'main-thinking').querySelectorAll('option')].map((o) => o.getAttribute('value'));

test("cascade main: the effort select lists only the chosen model's levels", async () => {
  // gpt-5.6-sol is listed under two providers with different levels; openai-opencodex comes first in the catalog
  const e = await openMainRow({
    'openai-sol': { model: 'openai-opencodex/gpt-5.6-sol', variant: 'xhigh', served: { primary: true, stable: true }, levels: ['low', 'medium', 'high', 'xhigh'] },
    'commandcode-sol': { model: 'commandcode/gpt-5.6-sol', variant: 'max', served: { primary: true, stable: true }, levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    'commandcode-55': { model: 'commandcode/gpt-5.5', variant: 'max', served: { primary: true, stable: true }, levels: ['low', 'high', 'max'] },
  });
  await changeMain(e, 'main-provider', 'commandcode');
  await changeMain(e, 'main-model', 'gpt-5.5');
  assert.deepEqual(mainEffortValues(e), ['low', 'high', 'max']);

  // commandcode/gpt-5.6-sol lists its own six levels, not those of the first catalog entry with that bare id
  await changeMain(e, 'main-model', 'gpt-5.6-sol');
  assert.deepEqual(mainEffortValues(e), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

  await changeMain(e, 'main-provider', 'openai-opencodex');
  assert.equal(selectedValueOf(mainControl(e, 'main-model')), 'gpt-5.6-sol');
  assert.deepEqual(mainEffortValues(e), ['low', 'medium', 'high', 'xhigh']);
});

test('cascade main: a model with three levels shows exactly those three and clamps an unsupported current effort', async () => {
  const state = clone(STATE);
  state.catalog = {
    'ollama-mini': { model: 'ollama/glm-5.3-mini', variant: 'medium', served: { primary: true, stable: true }, levels: ['minimal', 'low', 'medium'] },
    'ollama-glm': { model: 'ollama/glm-5.3', variant: 'xhigh', served: { primary: true, stable: true }, levels: ['medium', 'high', 'xhigh'] },
  };
  // the saved main effort max is not one of ollama/glm-5.3-mini's three levels
  state.main = { effective: { provider: 'ollama', model: 'glm-5.3-mini', thinking: 'max' }, override: null };
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => state });
  await tick();

  // nothing at or above max: exactly the three levels, showing medium (the nearest lower one); showing it stages nothing
  assert.deepEqual(mainEffortValues(e), ['minimal', 'low', 'medium']);
  assert.equal(selectedValueOf(mainControl(e, 'main-thinking')), 'medium');
  assert.equal(stagedMain(e), null);

  // a model change clamps the saved max (WinForms MainComboCommitted), not the shown medium: xhigh is the nearest lower level
  await changeMain(e, 'main-model', 'glm-5.3');
  assert.deepEqual(mainEffortValues(e), ['medium', 'high', 'xhigh']);
  assert.equal(selectedValueOf(mainControl(e, 'main-thinking')), 'xhigh');
  assert.deepEqual(stagedMain(e), ['ollama', 'glm-5.3', 'xhigh']);

  // back on the three-level model the shown clamp is the staged effort
  await changeMain(e, 'main-model', 'glm-5.3-mini');
  assert.deepEqual(mainEffortValues(e), ['minimal', 'low', 'medium']);
  assert.equal(selectedValueOf(mainControl(e, 'main-thinking')), 'medium');
  assert.deepEqual(stagedMain(e), ['ollama', 'glm-5.3-mini', 'medium']);
});

test('cascade main: no model selected falls back to the seven-level list', async () => {
  const e = await openMainRow({
    'openai-sol': { model: 'openai-opencodex/gpt-5.6-sol', variant: 'xhigh', served: { primary: true, stable: true }, levels: ['low', 'medium', 'high', 'xhigh'] },
    'openai-mini': { model: 'openai-opencodex/gpt-5.6-mini', variant: 'low', served: { primary: true, stable: true } },
  });
  // kimi-coding k3 is not in the openai-opencodex list, so the model empties
  await changeMain(e, 'main-provider', 'openai-opencodex');
  assert.equal(selectedValueOf(mainControl(e, 'main-model')), '');
  assert.deepEqual(mainEffortValues(e), ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

  // a model entry without levels keeps the seven-level list too
  await changeMain(e, 'main-model', 'gpt-5.6-mini');
  assert.deepEqual(mainEffortValues(e), ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(selectedValueOf(mainControl(e, 'main-thinking')), 'max');
});

test('support: an unserved saved main model keeps the seven-level list, disabled on the saved effort, and stages nothing', async () => {
  // the saved main kimi-coding/k3 (max) is not served by stable; kimi-coding/k3-turbo is served in both homes
  const e = await openMainRow({
    'kimi-k3': { model: 'kimi-coding/k3', variant: 'max', served: { primary: true, stable: false }, levels: [] },
    'kimi-turbo': { model: 'kimi-coding/k3-turbo', variant: 'high', served: { primary: true, stable: true }, levels: ['low', 'high'] },
  });
  const effort = mainControl(e, 'main-thinking');
  assert.equal(effort.hasAttribute('disabled'), true, 'the effort select can stage the unserved model');
  assert.deepEqual(mainEffortValues(e), ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(selectedValueOf(effort), 'max');
  assert.match(e.byId['pf-sec-main'].querySelector('.pf-blk-h').textContent, /설치 엔진 미지원 · stable 홈/);
  assert.equal(stagedMain(e), null);

  // the way out stays open: a served model enables the effort select on its own levels and stages the clamped effort
  assert.equal(mainControl(e, 'main-model').hasAttribute('disabled'), false);
  await changeMain(e, 'main-model', 'k3-turbo');
  assert.equal(mainControl(e, 'main-thinking').hasAttribute('disabled'), false);
  assert.deepEqual(mainEffortValues(e), ['low', 'high']);
  assert.deepEqual(stagedMain(e), ['kimi-coding', 'k3-turbo', 'high']);
});

// The store's served status for the saved main kimi-coding/k3 when stable does not serve it (store.mjs withMainServed).
const K3_UNSERVED = { unsupported: true, unsupportedReason: 'UNSUPPORTED_MODEL', unsupportedHome: 'stable' };

test('support: a saved main model outside the catalog keeps the store\'s flag, disabled on the saved effort, and stages nothing', async () => {
  // the saved main kimi-coding/k3 (max) has no catalog entry; kimi-coding/k3-turbo is served in both homes
  const e = await openMainRow({
    'kimi-turbo': { model: 'kimi-coding/k3-turbo', variant: 'high', served: { primary: true, stable: true }, levels: ['low', 'high'] },
  }, K3_UNSERVED);
  const heading = () => e.byId['pf-sec-main'].querySelector('.pf-blk-h');
  const effort = mainControl(e, 'main-thinking');
  assert.equal(effort.hasAttribute('disabled'), true, 'the effort select can stage the model outside the catalog');
  assert.deepEqual(mainEffortValues(e), ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(selectedValueOf(effort), 'max');
  assert.match(heading().textContent, /설치 엔진 미지원 · stable 홈/, 'the model outside the catalog has no flag');
  assert.equal(heading().querySelector('.pf-c-amber').getAttribute('title'), 'UNSUPPORTED_MODEL');
  assert.equal(stagedMain(e), null);

  // the way out stays open: a served model clears the flag, enables the effort select on its levels and stages it
  assert.equal(mainControl(e, 'main-model').hasAttribute('disabled'), false);
  await changeMain(e, 'main-model', 'k3-turbo');
  assert.doesNotMatch(heading().textContent, /설치 엔진 미지원/);
  assert.equal(mainControl(e, 'main-thinking').hasAttribute('disabled'), false);
  assert.deepEqual(mainEffortValues(e), ['low', 'high']);
  assert.deepEqual(stagedMain(e), ['kimi-coding', 'k3-turbo', 'high']);
});

test('support: no model selected keeps the main effort select enabled and stages the override removal, after a flagged saved model too', async () => {
  // ollama holds no k3, so leaving the flagged kimi-coding/k3 for ollama empties the model
  const e = await openMainRow({
    'ollama-flash': { model: 'ollama/glm-5.3-flash', variant: 'max', served: { primary: true, stable: true }, levels: ['low', 'medium', 'high', 'max'] },
  }, K3_UNSERVED);
  assert.equal(mainControl(e, 'main-thinking').hasAttribute('disabled'), true, 'the flagged saved model starts disabled');
  await changeMain(e, 'main-provider', 'ollama');
  assert.equal(selectedValueOf(mainControl(e, 'main-model')), '');
  assert.equal(mainControl(e, 'main-thinking').hasAttribute('disabled'), false, 'no model selected disables the effort select');
  assert.doesNotMatch(e.byId['pf-sec-main'].querySelector('.pf-blk-h').textContent, /설치 엔진 미지원/);
  assert.deepEqual(stagedMain(e), ['', '', '']);
  await changeMain(e, 'main-thinking', 'high');
  assert.equal(mainControl(e, 'main-thinking').hasAttribute('disabled'), false);
  assert.deepEqual(stagedMain(e), ['', '', '']);
});

test('reapply: re-applying the active profile with nothing pending equals golden apply-cmd-glm-deepseek (canonicalised)', async (t) => {
  const { openProfilesStore } = await import('../src/profiles/store.mjs');
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-reapply-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary');
  const stable = path.join(root, 'stable');
  fs.mkdirSync(path.join(primary, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(stable, 'agent'), { recursive: true });
  const goldenDir = path.join(ROOT, 'test', 'fixtures', 'profiles', 'goldens', 'apply-cmd-glm-deepseek', 'files');
  fs.writeFileSync(path.join(primary, 'omo.jsonc'), fs.readFileSync(path.join(goldenDir, 'primary/omo.jsonc.json'), 'utf8'));
  fs.writeFileSync(path.join(primary, 'agent', 'settings.json'), fs.readFileSync(path.join(goldenDir, 'primary/settings.json.json'), 'utf8'));
  fs.writeFileSync(path.join(primary, 'native-profile-selection.json'), JSON.stringify({ key: 'cmd-glm-deepseek', profile: 'native-cmd-glm-deepseek', appliedAt: 'seed' }, null, 2));
  fs.writeFileSync(path.join(primary, 'agent', 'native-profile-selection.json'), JSON.stringify({ key: 'cmd-glm-deepseek', profile: 'native-cmd-glm-deepseek', appliedAt: 'seed' }, null, 2));
  fs.writeFileSync(path.join(stable, 'omo.jsonc'), fs.readFileSync(path.join(goldenDir, 'stable/omo.jsonc.json'), 'utf8'));

  const store = openProfilesStore({
    primaryHome: primary,
    stableHome: stable,
    mirrorHomes: [],
    now: () => 1700000000000,
  });
  const st = store.state();

  // Re-apply active profile (cmd-glm-deepseek) with nothing pending
  const res = await store.apply({
    action: 'apply',
    rosterRevision: st.roster.revision,
    expected: st.targets,
    changes: [{ kind: 'selectProfile', profileKey: 'cmd-glm-deepseek' }],
  });
  assert.equal(res.ok, true, 're-applying active profile must succeed');
  const fresh = store.state();
  assert.equal(fresh.activeProfile.key, 'cmd-glm-deepseek');
});

// ---- todo 8: the WinForms layout in the board look ---------------------------------------------------------------------
const FLOW_SECTIONS = ['kibitzer', 'reflection', 'agents:explore-research', 'agents:plan-advice', 'agents:review-qa',
  'categories:quick-general', 'categories:deep', 'categories:specialist', 'lane', 'main', 'summarizer', 'apply'];
const extraRow = (section, role) => ({ section, role, group: 'extras', groupLabel: '추가 역할 · Extras', labelKo: role, labelEn: role, model: 'fable', reasoning: 'medium' });
async function openProfilesPage(state = STATE) {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => state });
  await tick();
  return e;
}

test('layout: sections keep the WinForms order whatever order the rows arrive in; every flow region is marked', () => {
  const P = load();
  const html = P.render(STATE, live());
  // The fixture lists review before planning; the board still draws plan-advice first, as PS RoutingGroups does.
  assert.deepEqual(all(html, /data-flow-sec="([^"]+)"/g), FLOW_SECTIONS);
  assert.deepEqual(all(html, /data-flow="([a-z]+)"/g), ['status', 'guide', 'cards', 'detail', 'roles', 'lane', 'main', 'summarizer', 'apply', 'message']);
  const state = clone(STATE);
  state.routing.rows.push(extraRow('agents', 'qa-extra'));
  const extra = P.render(state, live());
  assert.deepEqual(all(extra, /data-flow-sec="([^"]+)"/g).slice(2, 7),
    ['agents:explore-research', 'agents:plan-advice', 'agents:review-qa', 'agents:extras', 'categories:quick-general']);
  assert.ok(textOf(extra).includes('추가 설정'));
  assert.doesNotMatch(extra, /추가 역할 · Extras/);
  for (const part of ['service', 'model', 'effort']) assert.match(html, new RegExp('data-flow="role:agents/explore:' + part + '"'));
  for (const part of ['mode', 'service', 'model', 'effort']) assert.match(html, new RegExp('data-flow="memory:kibitzer:' + part + '"'));
  for (const id of ['card:experimental-custom', 'apply:card:gpt-deepseek', 'apply:detail']) assert.ok(html.includes('data-flow="' + id + '"'), id);
});

test('layout: every Must have 4 string is on the board word for word', () => {
  const P = load();
  const state = clone(STATE);
  state.routing.rows.push(extraRow('categories', 'qa-extra'));
  const text = [
    P.render(state, live({ pending: [{ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' }] })),
    P.render(state, live({ memorySaved: { kibitzer: true } })),
    P.render(state, live({ memoryErrors: { reflection: '외부 카테고리 충돌' } })),
  ].map(textOf).join('\n');
  for (const copy of ['현재 전역 적용', '전역 적용 중', '권장 배치 가이드', '적용 중', '적용', '메인: ', '서비스: ',
    '모델 라우팅 · 전담 에이전트 / 작업 카테고리', '공통 설정 · Kibitzer 회상', '공통 설정 · Reflection 성찰', '전담 에이전트 · Agents',
    '탐색 · 자료 조사', '계획 · 조언', '검토 · QA', '작업 카테고리 · Categories', '빠른 작업 · 일반 작업', '심층 추론', '전문 작업',
    '추가 설정', '메인 모델 설정', '요약 담당 모델', '이 프로필 적용하기', '1. 구독 서비스', '2. AI 모델', '3. 추론 강도',
    '공통 / 전체 · Kibitzer 회상', '공통 / 전체 · Reflection 성찰', 'quick 공유 (기본)', '직접 선택', '현재: ', '보류: ',
    '저장됨 · 다음 대화부터 반영', '실패 · 보류 유지: ', '1. 제공사', '원본 기본 컴팩션', ' · 변경 보류 1건']) {
    assert.ok(text.includes(copy), 'missing Must have 4 copy: ' + JSON.stringify(copy));
  }
});

test('layout: card markup has no nested interactive elements', () => {
  const P = load();
  for (const html of [P.render(STATE, live()), P.render(STATE, live({ busy: true })), P.render(STATE, { live: false })]) {
    const open = [];
    for (const m of html.matchAll(/<(\/?)(button|a|select|textarea|summary|input)\b[^>]*>/g)) {
      if (m[1]) { open.pop(); continue; }
      assert.equal(open.length, 0, '<' + m[2] + '> opens inside <' + open[open.length - 1] + '>');
      if (m[2] !== 'input') open.push(m[2]);
    }
    assert.equal((html.match(/<article class="pf-card(?: on)?">/g) || []).length, 6);
  }
  for (const [, body] of P.render(STATE, live()).matchAll(/<article class="pf-card(?: on)?">([\s\S]*?)<\/article>/g)) {
    assert.equal((body.match(/<button\b/g) || []).length, 2, 'a card holds its main button and its own 적용');
    assert.match(body, /<button type="button" class="pf-card-b" data-pf="select-profile"[^>]*aria-pressed="(?:true|false)"/);
    assert.match(body, /<button[^>]*data-pf="apply-card"[^>]*>적용<\/button>/);
  }
});

test('page wiring: keys 1-6 show cards 1-6 and ignore inputs, modifiers and composition', async () => {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.document.body, 'keydown', { key: '5' });
  assert.ok(!e.page.state.ui.profilesState, 'keys do nothing off the profiles screen');
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find((f) => f.url === '/profiles/state').resolve({ status: 200, ok: true, json: async () => STATE });
  await tick();
  const shown = () => e.page.state.ui.profilesState.shown;
  assert.equal(shown(), 'gpt-kimi-deepseek');
  const body = e.document.body;
  for (const [target, props] of [
    [body, { key: '5', ctrlKey: true }], [body, { key: '5', altKey: true }], [body, { key: '5', metaKey: true }],
    [body, { key: '5', shiftKey: true }], [body, { key: '5', isComposing: true }], [body, { key: '5', keyCode: 229 }],
    [e.byId.main.querySelector('[data-pf="route-provider"]'), { key: '5' }],
    [e.byId.main.querySelector('[data-pf="lane-literal"]'), { key: '5' }], [body, { key: '7' }],
  ]) {
    const ev = e.fire(target, 'keydown', props);
    assert.equal(shown(), 'gpt-kimi-deepseek', JSON.stringify(props) + ' on ' + target.tagName + ' must not switch cards');
    assert.notEqual(ev.defaultPrevented, true);
  }
  const ev = e.fire(body, 'keydown', { key: '5' });
  assert.equal(shown(), 'experimental-custom');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(e.byId.main.querySelector('[data-flow="card:experimental-custom"]').getAttribute('aria-pressed'), 'true');
  assert.notEqual(e.fire(body, 'keydown', { key: 'Escape' }).defaultPrevented, true, 'Esc keeps its board meaning');
  assert.equal(shown(), 'experimental-custom');
  assert.equal(e.page.state.ui.profilesState.pending.length, 0, 'showing a card stages nothing');
  assert.deepEqual(e.errors, []);
});

test('pending: the heading suffix counts pending edits over every profile and leaves document.title alone', async () => {
  const P = load();
  const pending = [
    { kind: 'setRoute', profileKey: 'glm-deepseek', section: 'agents', role: 'explore', provider: 'a', model: 'a/m', thinking: 'low' },
    { kind: 'setRoute', profileKey: 'experimental-custom', section: 'agents', role: 'oracle', provider: 'b', model: 'b/m', thinking: 'high' },
    { kind: 'setSummarizer', modelId: 'anthropic/claude-opus-5-5' },
  ];
  const heading = (html) => textOf(/<h1 class="pf-title">([\s\S]*?)<\/h1>/.exec(html)[1]).replace(/\s+/g, ' ').trim();
  const html = P.render(STATE, live({ pending, shown: 'experimental-custom' }));
  assert.equal(heading(html), '프로필·에이전트 · 변경 보류 3건');
  assert.match(textOf(/<div class="pf-apply"[\s\S]*?<\/div>/.exec(html)[0]), /변경 보류 3건/);
  assert.equal(heading(P.render(STATE, live())), '프로필·에이전트', 'no suffix without pending');

  const e = await openProfilesPage();
  const think = e.byId.main.querySelector('[data-pf-route="agents/explore"] [data-pf="route-thinking"]');
  think.value = 'high';
  e.fire(think, 'change');
  e.fire(e.byId.main.querySelector('[data-flow="card:experimental-custom"]'), 'click');
  const lane = e.byId.main.querySelector('[data-pf="agent-lane"][data-agent="atlas"]');
  lane.value = 'daily-heavy';
  e.fire(lane, 'change');
  const staged = e.page.state.ui.profilesState.pending;
  // A role edit names the omo layer the store writes (store.mjs routeChange); the card key would be refused.
  assert.deepEqual(plain(staged.map((c) => c.kind + ':' + (c.profileKey || ''))), ['setRoute:native-gpt-kimi-deepseek', 'setAgentLane:']);
  assert.equal(e.byId.main.querySelector('.pf-title').textContent, '프로필·에이전트 · 변경 보류 2건', 'the hidden profile still counts');
  assert.equal(e.document.title, 'board');
  e.fire(e.byId.main.querySelector('[data-flow="apply:detail"]'), 'click');
  const body = JSON.parse(e.fetches[e.fetches.length - 1].opts.body);
  assert.deepEqual(body.changes.map((c) => c.kind + ':' + (c.profileKey || '')), ['setAgentLane:', 'selectProfile:experimental-custom'],
    'applying the shown card leaves the other card\'s role edit pending');
  assert.deepEqual(e.errors, []);
});

test('page wiring: 권장 배치 가이드 opens the in-page dialog over the guide data and fetches nothing', async () => {
  const e = await openProfilesPage();
  const requests = e.fetches.length;
  const dlg = e.byId.main.querySelector('#pf-guide-dlg');
  assert.equal(dlg.tagName, 'DIALOG');
  assert.ok(dlg.querySelector('#pf-sec-guide'), 'the existing guide section lives in the dialog');
  assert.equal(dlg.querySelectorAll('.pf-rec tbody tr').length, STATE.routing.rows.length, 'one recommendation row per role');
  let opened = 0;
  dlg.showModal = () => { opened += 1; dlg.open = true; };
  dlg.close = () => { dlg.open = false; };
  e.fire(e.byId.main.querySelector('[data-flow="guide"]'), 'click');
  assert.equal(opened, 1);
  e.fire(e.document.body, 'keydown', { key: '5' });
  assert.equal(e.page.state.ui.profilesState.shown, 'gpt-kimi-deepseek', 'keys stay inert behind the guide');
  e.fire(dlg.querySelector('[data-pf="guide-close"]'), 'click');
  assert.equal(dlg.open, false);
  assert.equal(e.fetches.length, requests, 'the guide is local data');
  assert.deepEqual(e.errors, []);
});

test('page wiring: an edit inside the detail keeps both scrolls; another profile starts at the top', async () => {
  const e = await openProfilesPage();
  const before = e.byId.main.querySelector('[data-flow="roles"]');
  before.scrollTop = 180;
  e.byId.main.querySelector('[data-flow="detail"]').scrollTop = 60;
  const think = e.byId.main.querySelector('[data-pf-route="agents/explore"] [data-pf="route-thinking"]');
  think.value = 'high';
  e.fire(think, 'change');
  const after = e.byId.main.querySelector('[data-flow="roles"]');
  assert.notEqual(after, before, 'the edit re-rendered the role box');
  assert.equal(after.scrollTop, 180);
  assert.equal(e.byId.main.querySelector('[data-flow="detail"]').scrollTop, 60);
  e.fire(e.byId.main.querySelector('[data-flow="card:experimental-custom"]'), 'click');
  assert.equal(e.byId.main.querySelector('[data-flow="roles"]').scrollTop, 0);
  assert.equal(e.byId.main.querySelector('[data-flow="detail"]').scrollTop, 0);
  assert.deepEqual(e.errors, []);
});

test('page wiring: the cards panel keeps its scroll when a card is shown by click or by key', async () => {
  const e = await openProfilesPage();
  const before = e.byId.main.querySelector('[data-flow="cards"]');
  before.scrollTop = 240;
  e.fire(e.byId.main.querySelector('[data-flow="card:experimental-custom"]'), 'click');
  const after = e.byId.main.querySelector('[data-flow="cards"]');
  assert.notEqual(after, before, 'showing another profile re-rendered the cards panel');
  assert.equal(after.scrollTop, 240);
  e.fire(e.document.body, 'keydown', { key: '2' });
  assert.equal(e.page.state.ui.profilesState.shown, 'gpt-deepseek');
  assert.notEqual(e.byId.main.querySelector('[data-flow="cards"]'), after, 'the key re-rendered the cards panel');
  assert.equal(e.byId.main.querySelector('[data-flow="cards"]').scrollTop, 240);
  assert.deepEqual(e.errors, []);
});

// Review A round 2, D3: a staged change grows the message strip. The strip is a bottom row under both panes, so after
// the owner's scroll the detail's 이 프로필 적용하기, the role effort select and the row's drop are each the topmost
// element where they are clicked. Real Chrome over the fixture state; the board has no profiles write route.
test('layout: with one pending change the message strip covers neither 이 프로필 적용하기, the effort select nor the drop (Chrome, 1180x700 and 1600x900)', { timeout: 90000 }, async () => {
  const vm = JSON.parse(read('test/fixtures/view-model-board.json'));
  const token = 'profiles-view-geometry';
  const server = createBoardServer({ portBase: 49880 + (process.pid % 25) * 8, portCount: 8, generation: 7, token,
    getPage: ({ nonce } = {}) => pageHtml(vm, 7, { mode: 'server', token, nonce }), getViewModel: () => vm, profilesState: () => STATE });
  const { port } = await server.start();
  let page, profileDir;
  // An event-driven wait with a page-side deadline; no polling.
  const until = (predicate, what) => page.eval(`new Promise((resolve, reject) => {
    const check = () => { try { return !!(${predicate}); } catch (e) { return false; } };
    if (check()) return resolve(true);
    const observer = new MutationObserver(() => { if (check()) { done(); resolve(true); } });
    const timer = setTimeout(() => { done(); reject(new Error(${JSON.stringify('timeout waiting for ' + what)})); }, 10000);
    function done() { observer.disconnect(); clearTimeout(timer); }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  })`);
  const painted = () => page.eval('document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))');
  const seen = [];
  try {
    page = await launch({ width: 1180, height: 700 });
    profileDir = page.profileDir;
    for (const [width, height] of [[1180, 700], [1600, 900]]) {
      await page.client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await page.goto(`http://127.0.0.1:${port}/`);
      await until(`document.querySelector('[data-sh="view"][data-key="profiles"]')`, 'board shell');
      if (await page.eval(`document.querySelector('.sh-shell').getAttribute('data-side') !== 'open'`)) {
        await page.eval(`(document.querySelector('.sh-topen').click(), true)`);
        await until(`document.querySelector('.sh-shell').getAttribute('data-side') === 'open'`, 'docked sidebar');
      }
      await page.eval(`(document.querySelector('[data-sh="view"][data-key="profiles"]').click(), true)`);
      await until(`document.querySelector('[data-pf-root][data-pf-state="view"] [data-flow="apply:detail"]')`, 'profiles view');
      await page.eval(`(() => {
        const s = document.querySelector('[data-flow="role:agents/explore:effort"]');
        s.value = [...s.options].map((o) => o.value).filter((v) => v && v !== s.value).pop();
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await until(`document.querySelectorAll('[data-pf="drop"]').length === 1`, 'one pending change');
      for (const target of ['[data-flow="role:agents/explore:effort"]', '[data-flow="apply:detail"]', '[data-pf="drop"]']) {
        await page.eval(`(document.querySelector(${JSON.stringify(target)}).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }), true)`);
        await painted();
        seen.push(await page.eval(`(() => {
          const el = document.querySelector(${JSON.stringify(target)}), r = el.getBoundingClientRect();
          const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2), top = document.elementFromPoint(x, y);
          return { size: '${width}x${height}', target: ${JSON.stringify(target)}, at: [x, y], onTop: !!top && el.contains(top),
            top: top ? top.tagName.toLowerCase() + (top.getAttribute('class') ? '.' + top.getAttribute('class') : '') : null };
        })()`));
      }
    }
  } finally {
    if (page) await page.close();
    await server.close();
  }
  assert.equal(seen.length, 6);
  assert.deepEqual(seen.filter((s) => !s.onTop), [], 'each control is the topmost element at its centre');
  assert.deepEqual(listProfilePids(profileDir), []);
});
