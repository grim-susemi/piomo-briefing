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
  assert.match(at1040, /\.pf-agent \{[\s\S]*?minmax\(140px, 1\.2fr\)/);
  assert.match(at1040, /\.pf-mem-sels \{[\s\S]*?minmax\(0, 1\.4fr\)/);
});

test('loading and error render as their own states, never as read-only', () => {
  const P = load();
  let html = P.render(null, live({ loading: true }));
  assert.match(html, /프로필 상태를 불러오는 중…/);
  assert.match(html, /data-pf-root/);
  assert.doesNotMatch(html, /읽기 전용/);
  assert.doesNotMatch(html, /지금은 읽기 전용이라/);
  assert.doesNotMatch(html, /data-pf="preview"/);

  html = P.render(null, live({ loading: false, error: '프로필 상태를 불러오지 못했어요 (HTTP 500)' }));
  assert.match(html, /HTTP 500/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-pf="reload"/);
  assert.match(html, /다시 시도/);
  assert.doesNotMatch(html, /불러오는 중…/);
  assert.doesNotMatch(html, /읽기 전용/);
  assert.doesNotMatch(html, /지금은 읽기 전용이라/);

  html = P.render(STATE, live());
  assert.match(html, /편집 가능/);
  assert.doesNotMatch(html, /불러오는 중/);
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
  assert.match(html, /<span class="pf-keep">\(max 추론\)<\/span>/);
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
  assert.match(rule, /border-color:\s*var\(--c-line\)/);
  assert.doesNotMatch(css, /opacity:\s*\.7/);
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
  assert.match(textOf(html), /파일별 차이/);
  assert.match(textOf(html), /\$\.profiles\.native-gpt-kimi-deepseek\.agents\.explore\.model/);
  assert.match(textOf(html), /fable-medium/);
  assert.match(textOf(html), /mirror somo: skipped/);

  html = P.render(STATE, live({ conflict: true, status: '다른 곳에서 바뀜', error: '다른 곳에서 바뀌었어요 — 새로고침 후 다시 적용' }));
  assert.match(html, /다른 곳에서 바뀌었어요 — 새로고침 후 다시 적용/);
  assert.match(html, /data-pf="reload"/);

  html = P.render(STATE, live({ pending: [], result: { ok: true, action: 'apply', backups: ['C:/Users/USER/.omo/runtime/native-profile-switcher-backups/omo-20261020-120000-000.jsonc'], writes: ['omo.jsonc'], hashes: {} } }));
  assert.match(textOf(html), /적용했어요/);
  assert.match(textOf(html), /omo-20261020-120000-000\.jsonc/);
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
  assert.equal(stale.error, '다른 곳에서 바뀌었어요 — 새로고침 후 다시 적용');
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

test('no polling: the view never schedules a timer', () => {
  const src = read('src/page/profiles-view.js');
  assert.doesNotMatch(src, /setInterval|setTimeout|requestAnimationFrame/);
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
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
