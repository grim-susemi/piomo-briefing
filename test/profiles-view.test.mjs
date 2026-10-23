// Profiles rail view: pure render from the fixture state, read-only modes, escaping, the pending tray and the
// preview/apply/409 controller against a fake fetch. No timers, no browser and no real network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeController } from './fixtures/controller-dom.mjs';

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
  assert.deepEqual(all(html, /data-pf-sec="([^"]+)"/g), ['tray', 'agents', 'profiles', 'routing', 'main', 'lanes', 'summarizer', 'memory', 'guide']);
  for (const title of ['메인 에이전트', '프로필', '역할 배치', '메인 모델', '모델 레인', '요약 모델', '메모리 행', '권장 가이드']) {
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
  assert.equal(selects.length, 42, 'the fixture renders 42 selects');
  assert.equal(controls.length, 45, '42 selects + 3 text inputs');
  for (const c of controls) {
    const name = c.aria || c.ref || labels.get(c.id) || '';
    assert.ok(name.trim(), `${c.tag} [data-pf=${c.pf || '?'}] has no accessible name`);
    if (c.tag === 'select') assert.ok((labels.get(c.id) || '').trim(), `${c.id} has no visible label`);
  }
  const byPf = (pf) => controls.filter((c) => c.pf === pf);
  for (const c of byPf('route-provider')) assert.equal(labels.get(c.id), '서비스');
  for (const c of byPf('route-model')) assert.equal(labels.get(c.id), '모델');
  for (const c of byPf('route-thinking')) assert.equal(labels.get(c.id), '추론');
  for (const c of byPf('memory-mode')) assert.equal(labels.get(c.id), '모드');
  for (const c of byPf('memory-model')) assert.equal(labels.get(c.id), '모델');
  for (const c of byPf('memory-thinking')) assert.equal(labels.get(c.id), '추론');
  for (const c of byPf('agent-pin-thinking')) assert.equal(labels.get(c.id), '추론');
  assert.equal(byPf('route-provider').length, STATE.routing.rows.length);
  assert.equal(byPf('agent-pin-thinking').length, 4);
  assert.equal(byPf('memory-mode').length, 2);
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
  assert.equal(textOf(keep[1]).trim(), '메모리 행을 상황판에서 확인하고');
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
  assert.match(at1040, /\.pf-mem-sels \{[\s\S]*?minmax\(0, 1\.4fr\)/);
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
  const loadedHead = /<section class="pf-sec" id="pf-sec-agents"[\s\S]*?<header class="pf-sec-h">([\s\S]*?)<\/header>/.exec(loaded)[1];
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
  assert.match(css, /button\.pf-card:active:not\(:disabled\) \{[^}]*background: var\(--fill-press\)/);
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
  assert.equal(tags.length, 42);
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
  assert.match(at1040, /\.pf-mem-sels \{ grid-template-columns: minmax\(80px/);
  assert.match(at1040, /\.pf-mem-sels \{[^}]*minmax\(92px/);
  const at599 = css.slice(css.indexOf('@media (max-width: 599px)'));
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
  assert.deepEqual(body.changes, [{ kind: 'setRoute', section: 'agents', role: 'explore', provider: 'anthropic', model: 'anthropic/claude-opus-5-5', thinking: 'medium' }]);
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

  async function setRow(key, model, thinking) {
    let mode = e.byId.main.querySelector('[data-pf="memory-mode"][data-memory="' + key + '"]');
    assert.ok(mode, key + ' mode control');
    mode.value = 'custom';
    e.fire(mode, 'change');
    await tick();
    // The deterministic DOM does not carry select values across a re-render, so set every
    // control on the current tree and fire one change; the delegated handler reads the row.
    mode = e.byId.main.querySelector('[data-pf="memory-mode"][data-memory="' + key + '"]');
    const input = e.byId.main.querySelector('[data-pf="memory-model"][data-memory="' + key + '"]');
    assert.ok(input, key + ' model control');
    const think = e.byId.main.querySelector('[data-pf="memory-thinking"][data-memory="' + key + '"]');
    assert.ok(think, key + ' thinking control');
    mode.value = 'custom';
    input.value = model;
    think.value = thinking;
    e.fire(think, 'change');
    await tick();
  }

  await setRow('kibitzer', 'openai/gpt-6-sol', 'high');
  await setRow('reflection', 'chatgpt-subscription/gpt-reflection-sentinel', 'high');
  const pendingText = e.byId.main.querySelector('.pf-pending').textContent;
  assert.match(pendingText, /Kibitzer 메모리 행/);
  assert.match(pendingText, /Reflection 메모리 행/);

  e.fire(e.byId.main.querySelector('[data-pf="preview"]'), 'click');
  const post = e.fetches[e.fetches.length - 1];
  assert.equal(post.url, '/profiles');
  const changes = JSON.parse(post.opts.body).changes;
  assert.deepEqual(changes.map((c) => c.row || 'kibitzer').sort(), ['kibitzer', 'reflection']);
  assert.equal(changes.find((c) => c.row === 'kibitzer').model, 'openai/gpt-6-sol');
  assert.equal(changes.find((c) => c.row === 'reflection').model, 'chatgpt-subscription/gpt-reflection-sentinel');
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
  assert.match(e.byId.side.textContent, /1개 대기/, 'the sidebar tray chip follows the pending edits');
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
  state.guide.version = '5.1.40';
  state.inventory.version = '9.9.9';
  const html = P.render(state, live());
  const sec = /<section class="pf-sec" id="pf-sec-guide"[\s\S]*?<\/section>/.exec(html)[0];
  const head = textOf(/<div class="pf-guide-h">([\s\S]*?)<\/div>/.exec(sec)[1]);
  assert.match(head, /OMO 권장 배치 · 9\.9\.9/);
  assert.match(head, /9\.9\.9/);
  assert.doesNotMatch(head, /5\.1\.33|5\.1\.40/);
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
    'summarizer-model', 'memory-mode', 'memory-model', 'memory-thinking', 'reset-memory', 'drop',
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
  assert.doesNotMatch(html, /data-pf="preview"/);
  assert.match(html, /class="pf-muted pf-tray-note"/);
  assert.match(html, /class="pf-count">0</);
  const next = /<span class="pf-tray-next">([^<]+)<\/span>/.exec(html);
  assert.ok(next && textOf(next[1]).trim().length >= 8, 'the compact tray needs a visible next action');
  const pending = [{ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-heavy' }];
  html = P.render(STATE, live({ pending }));
  assert.doesNotMatch(html, /pf-tray-compact/);
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
  const routing = /<section class="pf-sec" id="pf-sec-routing"[\s\S]*?<\/section>/.exec(html)[0];
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

test('selected card: a green wash and a check glyph join the 현재 text', () => {
  const P = load();
  const html = P.render(STATE, live());
  const on = /<button[^>]*class="pf-card on"[^>]*>[\s\S]*?<\/button>/.exec(html)[0];
  assert.match(on, /class="pf-chip pf-c-green pf-current"/);
  assert.match(on, /href="#i-check"/);
  assert.match(on, /현재/);
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
