import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeController } from './fixtures/controller-dom.mjs';
import { pageHtml } from '../src/render.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/view-model-board.json', import.meta.url), 'utf8'));
const workers = JSON.parse(fs.readFileSync(new URL('./fixtures/view-model-workers.json', import.meta.url), 'utf8'));
const clone = v => JSON.parse(JSON.stringify(v));
const env = () => makeController({ protocol: 'file:', modules: ['icons', 'view', 'plan-view', 'workers-view', 'blocks', 'convo-view', 'shell', 'annotate'] });
const sprite = pageHtml(fixture, 7, { mode: 'file' });
function icon(el, name) {
  assert.ok(el, 'icon slot exists');
  const svg = el.querySelector('svg');
  assert.ok(svg, el.textContent + ' contains a real SVG');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.getAttribute('focusable'), 'false');
  assert.equal(svg.querySelector('use')?.getAttribute('href'), '#i-' + name);
  assert.ok(sprite.includes('<symbol id="i-' + name + '"'), name + ' resolves in the actual sprite');
}
function dom(e, html) { const root = e.document.createElement('div'); root.innerHTML = html; return root; }

test('inline icons: overview more and detail controls keep the exp channel and use stateful SVG chevrons', () => {
  const e = env(), model = clone(fixture), s = model.sessions[0];
  s.changes = Array.from({ length: 6 }, (_, i) => ({ text: 'change → ' + i, truth: 'reported', applied: 'none' }));
  const d = s.decisions.find(d => !d.answered && !d.closed);
  s.decisions.push({ ...clone(d), id: 197 }, { ...clone(d), id: 198 });
  e.page.receive(model);
  for (const prefix of ['more-ch:', 'more-dc:', 'detail:']) {
    const button = () => e.byId.main.querySelector('[data-key="' + prefix + s.id + '"]');
    for (const open of [false, true, false]) {
      const b = button();
      assert.ok(b, prefix);
      assert.equal(b.getAttribute('aria-expanded'), String(open));
      assert.equal(b.getAttribute('data-act'), 'exp');
      icon(b, open ? 'chevron-down' : 'chevron-right');
      e.fire(b, 'click');
    }
  }
  assert.ok(e.byId.main.textContent.includes('change → 0'), 'model arrow is literal');
  assert.deepEqual(e.errors, []);
});

test('inline icons: worker waiting, cancelled, lost, todo states and disclosure slots are Lucide SVGs', () => {
  const e = env();
  for (const open of [false, true]) {
    const expanded = {};
    for (const s of workers.sessions) for (const w of s.live.workers) expanded['worker:' + w.id] = open;
    for (const s of workers.sessions) {
      const root = dom(e, e.ctx.BriefWorkersView.render(s.live, workers.generatedAt, { expanded }));
      for (const [state, name] of [['waiting', 'clock'], ['cancelled', 'x'], ['lost', 'x']]) {
        for (const row of root.querySelectorAll('[data-st="' + state + '"]')) icon(row.querySelector('.w-dot'), name);
      }
      for (const b of root.querySelectorAll('.w-todo-btn')) {
        assert.equal(b.getAttribute('aria-expanded'), String(open));
        icon(b, open ? 'chevron-down' : 'chevron-right');
      }
      for (const [cls, name] of [['done', 'check'], ['doing', 'clock'], ['todo', 'list-todo'], ['dropped', 'x']]) {
        for (const row of root.querySelectorAll('.w-t-' + cls)) icon(row.querySelector('.w-tsym'), name);
      }
    }
  }
});

test('inline icons: change and automatic-metadata symbol slots contain SVGs, not text bullets', () => {
  const e = env(), model = clone(fixture), s = model.sessions[0];
  const overview = e.ctx.BriefView.renderOverview(model, { tab: 'wait', expanded: { ['detail:' + s.id]: true } });
  const plan = e.ctx.BriefConvo.render(model.sessions[1], { sub: 'plan' }, { now: model.generatedAt });
  const slots = dom(e, overview + plan).querySelectorAll('.sym');
  assert.ok(slots.length > 0);
  for (const slot of slots) {
    assert.ok(slot.querySelector('svg'), slot.textContent + ' is an icon slot');
    assert.equal(slot.textContent, '');
    const name = slot.querySelector('use').getAttribute('href').slice(3);
    icon(slot, name);
  }
});

test('inline icons: the new-content badge is a decorative refresh SVG from creation onward', () => {
  const e = env();
  icon(e.badge, 'refresh-cw');
  e.page.receive(fixture);
  icon(e.badge, 'refresh-cw');
  assert.deepEqual(e.errors, []);
});

test('inline icons: realtime-link arrow is an SVG while its loopback URL remains literal escaped text', () => {
  const e = env(), model = clone(fixture);
  const url = 'http://127.0.0.1:49020/<img src=x onerror=bad>→';
  model.server = { url };
  e.page.receive(model);
  assert.equal(e.link.hidden, false);
  assert.equal(e.link.href, url);
  icon(e.link, 'arrow-right');
  assert.ok(e.link.textContent.includes(url));
  assert.equal(e.link.querySelector('img'), null);
  assert.deepEqual(e.errors, []);
});

test('inline icons: inbox answer-preview prefixes are SVGs without rewriting or trusting option text', () => {
  const e = env(), model = clone(fixture), S = e.ctx.BriefShell;
  const d = model.sessions[0].decisions.find(d => d.answered && d.options?.A);
  const label = 'option → <img src=x onerror=bad>';
  d.answer = { option: 'A' }; d.options.A.text = label;
  const state = S.reduce(S.defaults(), { type: 'view', key: 'inbox', box: 'ans' });
  const root = dom(e, S.side(model, state));
  const previews = root.querySelectorAll('.sh-ans');
  assert.ok(previews.length > 0);
  for (const preview of previews) icon(preview, 'arrow-right');
  assert.ok(previews.some(p => p.textContent.includes(label)));
  assert.equal(root.querySelector('img'), null);
});
