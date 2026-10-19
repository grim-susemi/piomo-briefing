// Shell polish regressions: real classic scripts and the repository's deterministic controller DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { makeController } from './fixtures/controller-dom.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/view-model-board.json', import.meta.url), 'utf8'));
const env = () => makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'annotate'] });
const plain = value => JSON.parse(JSON.stringify(value));
function shell() {
  const g = vm.createContext({});
  for (const name of ['icons', 'shell']) vm.runInContext(fs.readFileSync(new URL('../src/page/' + name + '.js', import.meta.url), 'utf8'), g);
  return g.BriefShell;
}

test('polish: rail starts with home, retains every destination, and toggles only from the header and tab bar', () => {
  const S = shell(), st = S.defaults();
  const rail = S.rail(fixture, st);
  assert.deepEqual([...rail.matchAll(/data-key="([^"]+)"/g)].map(m => m[1]), ['home', 'conv', 'inbox', 'plans', 'archive', 'settings']);
  assert.doesNotMatch(rail, /data-sh="toggleSide"/);
  assert.match(S.sideFrame(st), /class="sh-head"[\s\S]*data-sh="toggleSide"/);
  assert.match(S.tabs(fixture, st), /class="sh-topen" data-sh="toggleSide"/);
});

test('polish: favourites use the same star symbol, filled only when selected', () => {
  const S = shell(), sid = fixture.sessions[0].id;
  const off = S.side(fixture, S.defaults());
  const on = S.side(fixture, S.reduce(S.defaults(), { type: 'fav', sid }));
  assert.match(off, /aria-pressed="false"[^>]*>[\s\S]*?href="#i-star"/);
  assert.match(on, /aria-pressed="true"[^>]*><svg class="ic ic-md ic-fill"/);
  assert.doesNotMatch(off + on, /[\u2605\u2606]/);
});

test('polish: separator keys resize, clamp, update aria and persist through the existing preference key', () => {
  const e = env();
  const rz = e.byId.side.querySelector('[data-sh="rz"]');
  assert.equal(rz.getAttribute('tabindex'), '0');
  rz.focus();
  const press = key => e.fire(rz, 'keydown', { key });
  press('ArrowRight');
  assert.equal(e.page.state.ui.sideWidth, 276);
  assert.equal(rz.getAttribute('aria-valuenow'), '276');
  press('End'); press('ArrowRight');
  assert.equal(e.page.state.ui.sideWidth, 480);
  press('Home'); press('ArrowLeft');
  assert.equal(e.page.state.ui.sideWidth, 200);
  assert.equal(JSON.parse(e.ctx.localStorage.getItem('omo-briefing.ui.v1')).sideWidth, 200);
  assert.equal(e.document.activeElement, rz);
  assert.deepEqual(e.errors, []);
});

test('polish: rerendered rail activation keeps the operated destination focused', () => {
  const e = env();
  e.page.receive(fixture);
  const button = e.byId.rail.querySelector('[data-key="inbox"]');
  button.focus(); e.fire(button, 'click');
  assert.notEqual(e.document.activeElement, button, 'the rail really rerendered');
  assert.equal(e.byId.rail.contains(e.document.activeElement), true);
  assert.equal(e.document.activeElement.getAttribute('data-key'), 'inbox');
  assert.deepEqual(e.errors, []);
});

test('polish: report compare choice moves focus to its own safe confirmation control, never Send', () => {
  const e = env(), s = fixture.sessions[0];
  e.page.receive(fixture); e.page.open(s.id, 'rep');
  const button = e.byId.main.querySelector('[data-act="ans-pick"][data-opt="B"]');
  assert.ok(button);
  const block = button.closest('[data-block]').getAttribute('data-block');
  button.focus(); e.fire(button, 'click');
  assert.equal(e.byId.main.contains(e.document.activeElement), true);
  assert.equal(e.document.activeElement.getAttribute('data-act'), 'ans-cancel');
  assert.equal(e.document.activeElement.closest('[data-block]').getAttribute('data-block'), block);
  assert.deepEqual(e.errors, []);
});

test('polish: empty typed submission retains the operated button and writes no answer', () => {
  const e = env(), s = fixture.sessions[0];
  e.page.receive(fixture); e.page.open(s.id, 'dec');
  const reply = e.byId.main.querySelector('[data-act="ans-reply"]');
  e.fire(reply, 'click');
  const submit = e.byId.main.querySelector('[data-act="ans-text"]');
  submit.focus(); e.fire(submit, 'click');
  assert.equal(e.byId.main.contains(e.document.activeElement), true);
  assert.equal(e.document.activeElement.getAttribute('data-act'), 'ans-text');
  assert.equal(e.fetches.filter(f => f.url === '/answer').length, 0);
  assert.deepEqual(e.errors, []);
});

for (const kind of ['text', 'number', 'radio', 'select']) {
  test('polish: region replacement preserves the operated ' + kind + ' field identity and text selection', () => {
    const e = env();
    const render = e.ctx.BriefView.renderOverview;
    let revision = 0;
    // A renderer-owned form fixture exercises the controller without implementing the future typed-decision feature.
    e.ctx.BriefView.renderOverview = () => '<div data-block="form"><p>' + revision++ + '</p>' +
      '<input type="text" name="title" value="alpha"><input type="number" name="count" value="7">' +
      '<input type="radio" name="theme" value="system"><input type="radio" name="theme" value="light" checked>' +
      '<select name="scope"><option value="one">one</option><option value="two" selected>two</option></select></div>';
    e.page.render();
    const selector = kind === 'select' ? 'select' : kind === 'radio' ? 'input[type="radio"][value="light"]' : 'input[type="' + kind + '"]';
    const field = e.byId.main.querySelector(selector);
    field.focus();
    if (kind === 'text') { field.selectionStart = 1; field.selectionEnd = 3; field.selectionDirection = 'backward'; }
    // The fake DOM exposes selection only for the new text field, as browsers do for selection-capable controls.
    if (kind === 'text') {
      const create = e.document.createElement;
      // region's HTML parser constructs elements directly; install on the shared element prototype for this assertion.
      const proto = Object.getPrototypeOf(field), old = proto.setSelectionRange;
      proto.setSelectionRange = function (a, b, d) { this.selectionStart = a; this.selectionEnd = b; this.selectionDirection = d; };
      try { e.page.render(); } finally { if (old) proto.setSelectionRange = old; else delete proto.setSelectionRange; }
      e.document.createElement = create;
    } else e.page.render();
    const next = e.byId.main.querySelector(selector);
    assert.notEqual(next, field, 'the field really was replaced');
    assert.equal(e.document.activeElement, next);
    if (kind === 'radio') assert.equal(next.getAttribute('value'), 'light', 'not the first radio');
    if (kind === 'text') assert.deepEqual([next.selectionStart, next.selectionEnd, next.selectionDirection], [1, 3, 'backward']);
    e.ctx.BriefView.renderOverview = render;
    assert.deepEqual(e.errors, []);
  });
}

test('polish: copy success, failure, repeat and reset keep the SVG and restore focus after the legacy fallback', async () => {
  const e = env(); e.page.receive(fixture);
  const button = e.byId.main.querySelector('[data-copy]');
  assert.equal(button.querySelector('use')?.getAttribute('href'), '#i-copy');
  button.focus(); e.fire(button, 'click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.querySelector('use')?.getAttribute('href'), '#i-check');
  assert.equal(e.ctx.copied, button.getAttribute('data-copy'));
  e.advance(1000); e.fire(button, 'click');
  await new Promise(resolve => setImmediate(resolve));
  e.advance(200);
  assert.equal(button.querySelector('use')?.getAttribute('href'), '#i-check', 'the first reset cannot clear the second result');
  e.advance(1000);
  assert.equal(button.querySelector('use')?.getAttribute('href'), '#i-copy');
  e.ctx.navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
  e.document.execCommand = () => { e.document.activeElement = e.document.body; return false; };
  e.fire(button, 'click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.querySelector('use')?.getAttribute('href'), '#i-x');
  assert.equal(e.document.activeElement, button);
  e.advance(1200);
  assert.equal(button.querySelector('use')?.getAttribute('href'), '#i-copy');
  assert.deepEqual(e.errors, []);
});

test('polish: plan path and question copy buttons keep their SVG through success, failure, repeat and reset', async () => {
  const e = env(), s = fixture.sessions[0];
  e.page.receive(fixture); e.page.open(s.id, 'plan');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  for (const selector of ['.plan-path [data-copy]', '.plan-question [data-copy]']) {
    const button = e.byId.main.querySelector(selector);
    assert.ok(button, selector);
    const icon = button.querySelector('svg'), use = button.querySelector('use'), label = button.querySelector('[data-copy-label]');
    assert.ok(icon && use && label, selector + ' has an SVG icon and a separate label');
    assert.equal(use.getAttribute('href'), '#i-copy');
    const original = button.textContent;
    e.ctx.navigator.clipboard.writeText = async text => { e.ctx.copied = text; };
    delete e.document.execCommand;
    button.focus(); e.fire(button, 'click');
    await settle();
    assert.equal(e.ctx.copied, button.getAttribute('data-copy'), selector);
    const success = button.textContent;
    assert.match(success, /복사됨/, selector + ' success is visible');
    assert.equal(button.querySelector('svg'), icon, selector + ' preserves the SVG node on success');
    assert.equal(use.getAttribute('href'), '#i-check');
    e.advance(1000); e.fire(button, 'click');
    await settle();
    e.advance(200);
    assert.equal(button.textContent, success, selector + ': the first reset cannot clear the second result');
    assert.equal(use.getAttribute('href'), '#i-check');
    e.advance(1000);
    assert.equal(button.textContent, original, selector + ': a repeat restores the original text, not the feedback');
    assert.equal(use.getAttribute('href'), '#i-copy');
    e.ctx.navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    e.document.execCommand = () => { e.document.activeElement = e.document.body; return false; };
    e.fire(button, 'click');
    await settle();
    assert.match(button.textContent, /복사 실패/, selector + ' failure is visible');
    assert.equal(button.querySelector('svg'), icon, selector + ' preserves the SVG node on failure');
    assert.equal(use.getAttribute('href'), '#i-x');
    assert.notEqual(button.textContent, success, selector + ' failure differs from success');
    assert.equal(e.document.activeElement, button, selector + ' keeps focus after the legacy fallback');
    e.advance(1200);
    assert.equal(button.textContent, original, selector + ' restores after failure');
    assert.equal(button.querySelector('svg'), icon, selector + ' preserves the SVG node after restoration');
    assert.equal(use.getAttribute('href'), '#i-copy');
  }
  assert.deepEqual(e.errors, []);
});

test('polish: copy buttons keep one accessible name through success, failure and reset; only the visible label reports (A6-01)', async () => {
  const e = env(), s = fixture.sessions[0];
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const label = button => (button.querySelector('[data-copy-label]') || button).textContent.trim();
  const names = () => e.byId.main.querySelectorAll('[data-copy]').map(b => b.getAttribute('aria-label'));
  const cycle = async button => {
    const before = label(button);
    assert.equal(button.getAttribute('aria-label'), '복사');
    e.ctx.navigator.clipboard.writeText = async text => { e.ctx.copied = text; };
    e.fire(button, 'click'); await settle();
    assert.deepEqual([label(button), button.getAttribute('aria-label')], ['복사됨', '복사']);
    e.advance(1200);
    e.ctx.navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    e.document.execCommand = () => false;
    e.fire(button, 'click'); await settle();
    assert.deepEqual([label(button), button.getAttribute('aria-label')], ['복사 실패', '복사']);
    e.advance(1200);
    assert.deepEqual([label(button), button.getAttribute('aria-label')], [before, '복사']);
    delete e.document.execCommand;
  };
  e.page.receive(fixture);
  assert.ok(names().length > 0);
  assert.deepEqual([...new Set(names())], ['복사'], 'every copy button on the board overview');
  await cycle(e.byId.main.querySelector('[data-copy]'));
  e.page.open(s.id, 'dec');
  assert.ok(names().length > 0);
  assert.deepEqual([...new Set(names())], ['복사'], 'every copy button on the conversation decision page');
  e.page.open(s.id, 'plan');
  for (const selector of ['.plan-path [data-copy]', '.plan-question [data-copy]']) await cycle(e.byId.main.querySelector(selector));
  assert.deepEqual(e.errors, []);
});

test('polish: the phone sidebar overlay leaves the covered column inert, Escape shuts it and focus lands on a visible control (A6-02)', () => {
  const e = env();
  e.ctx.innerWidth = 390; // controller-dom matchMedia: below 900 px
  e.page.receive(fixture);
  const wrap = e.app.querySelector('.sh-wrap'), side = e.byId.side;
  const topen = () => e.byId.tabs.querySelector('.sh-topen');
  const escape = target => e.fire(target, 'keydown', { key: 'Escape' });
  // » opens the overlay: focus moves into it; the tab bar and #main under it go inert, the rail and the panel do not
  topen().focus(); e.fire(topen(), 'click');
  assert.equal(e.page.state.ui.peek, true);
  assert.equal(wrap.getAttribute('inert'), '');
  assert.deepEqual([e.byId.rail.closest('[inert]'), side.closest('[inert]')], [null, null]);
  assert.equal(side.contains(e.document.activeElement), true, 'focus is inside the overlay');
  // Escape from the panel's last control shuts it; the column is live again and focus is back on »
  const last = side.querySelectorAll('button').at(-1);
  last.focus();
  assert.equal(escape(last).defaultPrevented, true);
  assert.equal(e.page.state.ui.peek, false);
  assert.equal(wrap.hasAttribute('inert'), false);
  assert.equal(e.document.activeElement, topen());
  // a rail button opens it and keeps its focus; opening a conversation from the panel shuts it, focus back on that button
  const conv = e.byId.rail.querySelector('[data-key="conv"]');
  conv.focus(); e.fire(conv, 'click');
  assert.equal(e.page.state.ui.peek, true);
  const railButton = e.document.activeElement;
  assert.equal(railButton.getAttribute('data-key'), 'conv');
  const row = side.querySelector('[data-sh="open"]');
  row.focus(); e.fire(row, 'click');
  assert.equal(e.page.state.ui.peek, false);
  assert.equal(e.document.activeElement, railButton, 'back on the rail button that opened it');
  // Ctrl+\ from a control under the overlay: that control goes inert, so focus moves into the overlay; Escape returns it
  const copy = e.byId.main.querySelector('[data-copy]');
  copy.focus();
  e.fire(copy, 'keydown', { key: '\\', code: 'Backslash', ctrlKey: true });
  assert.equal(e.page.state.ui.peek, true);
  assert.equal(e.document.activeElement.getAttribute('data-sh'), 'toggleSide');
  assert.equal(side.contains(e.document.activeElement), true);
  escape(e.document.activeElement);
  assert.equal(e.document.activeElement, copy, 'back on the control it came from');
  assert.deepEqual(e.errors, []);
});

test('polish: the wide layout keeps its sidebar as it was: nothing goes inert and Escape is not taken (A6-02)', () => {
  const e = env();
  e.page.receive(fixture);
  const wrap = e.app.querySelector('.sh-wrap');
  const close = e.byId.side.querySelector('.sh-head [data-sh="toggleSide"]');
  close.focus(); e.fire(close, 'click');
  assert.equal(e.page.state.ui.sideOpen, false);
  e.fire(e.byId.edge, 'mouseover');
  assert.equal(e.page.state.ui.peek, true, 'the edge hover still peeks');
  assert.equal(wrap.hasAttribute('inert'), false);
  assert.notEqual(e.fire(e.document.activeElement, 'keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(e.page.state.ui.peek, true);
  assert.deepEqual(e.errors, []);
});
