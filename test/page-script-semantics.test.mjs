import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readClassicScript } from '../src/page-script.mjs';
import { makeController, memoryStorage } from './fixtures/controller-dom.mjs';

const dir = fileURLToPath(new URL('../src/page/', import.meta.url));
const read = name => fs.readFileSync(new URL('../src/page/' + name + '.js', import.meta.url), 'utf8');
const bodies = { view: readClassicScript(dir, 'view.js'), page: readClassicScript(dir, 'page.js') };
const board = JSON.parse(fs.readFileSync(new URL('./fixtures/view-model-board.json', import.meta.url), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));

function viewContext(body, setup = '') {
  const ctx = vm.createContext({});
  vm.runInContext(setup, ctx);
  vm.runInContext(read('icons'), ctx);
  vm.runInContext(body, ctx);
  return ctx;
}

for (const [name, setup, expression, reads] of [
  ['ordinary global', '', 'this.BriefView', null],
  ['deleted globalThis', 'delete this.globalThis;', 'this.BriefView', null],
  ['undefined property', 'this.globalThis = undefined;', 'this.BriefView', null],
  ['undefined lexical binding', 'let globalThis;', 'this.BriefView', null],
  ['getter global', 'var reads = 0; Object.defineProperty(this, "globalThis", { get() { reads++; return this; } });', 'this.BriefView', 4],
  ['getter undefined', 'var reads = 0; Object.defineProperty(this, "globalThis", { get() { reads++; } });', 'this.BriefView', 2],
  ['getter alternate', 'var reads = 0; var target = {}; Object.defineProperty(this, "globalThis", { get() { reads++; return target; } });', 'target.BriefView', 4],
]) {
  test('delivered view preserves classic publication and strictness: ' + name, () => {
    const source = viewContext(read('view'), setup);
    const delivered = viewContext(bodies.view, setup);
    const shape = ctx => plain(vm.runInContext('Object.entries(' + expression + ').map(([k,v])=>[k,typeof v])', ctx));
    assert.deepEqual(shape(delivered), shape(source));
    for (const ctx of [source, delivered]) {
      assert.throws(() => vm.runInContext(expression + '.renderOverview.caller', ctx), e => e.name === 'TypeError');
      if (reads !== null) assert.equal(vm.runInContext('reads', ctx), reads);
    }
  });
}

test('delivered view preserves complete overview markup and refuses non-writable publication', () => {
  const source = viewContext(read('view'));
  const delivered = viewContext(bodies.view);
  const ui = { now: () => 1000 };
  const expected = source.BriefView.renderOverview(board, ui);
  assert.ok(expected.includes('data-decision="97"'));
  assert.equal(delivered.BriefView.renderOverview(board, ui), expected);
  for (const body of [read('view'), bodies.view]) {
    assert.throws(() => viewContext(body, 'Object.defineProperty(this, "BriefView", { value: 0, writable: false });'),
      e => e.name === 'TypeError');
  }
});

function model(seq, gen) {
  return {
    seq, gen, generatedAt: 0,
    sessions: [{
      id: 's-a1', project: 'p', title: 'Board', tabLabel: 'Repair', tabNumber: 181, paneId: 'w1:pR2',
      answerKinds: ['option', 'text'], status: 'needs_decision', tab: 'waiting',
      decisions: [{
        id: 13, sessionId: 's-a1', question: 'Keep this draft?',
        options: { A: { text: 'Keep', consequence: 'Keep it' }, B: { text: 'Change', consequence: 'Change it' } },
        recommend: 'A', reason: 'Draft recovery', answered: false, closed: false,
      }],
    }],
  };
}

for (const [form, scriptBodies] of [['source', {}], ['delivered', bodies]]) {
  test(form + ' controller remembers only trusted uncancelled summary choices', () => {
    const e = makeController({ scriptBodies });
    e.page.receive(board);
    const details = e.app.querySelector('details[data-open-key]');
    assert.ok(details);
    details.open = false;
    const key = details.getAttribute('data-open-key');
    const before = e.page.state.ui.expanded[key];
    e.fire(details.querySelector('summary'), 'click', { isTrusted: false });
    details.open = true;
    e.flushMicrotasks();
    e.advance(0);
    assert.equal(e.page.state.ui.expanded[key], before, 'programmatic changes are not user choices');
    details.open = false;
    e.toggleDetails(details);
    assert.equal(details.open, true);
    assert.equal(e.page.state.ui.expanded[key], true);
  });

  test(form + ' controller respects a later cancellation of a trusted summary click', () => {
    const e = makeController({ scriptBodies });
    e.page.receive(board);
    const details = e.app.querySelector('details[data-open-key]');
    assert.ok(details);
    details.open = false;
    const key = details.getAttribute('data-open-key');
    const before = e.page.state.ui.expanded[key];
    e.app.addEventListener('click', event => event.preventDefault());
    const event = e.toggleDetails(details);
    assert.equal(event.defaultPrevented, true);
    assert.equal(details.open, false);
    assert.equal(e.page.state.ui.expanded[key], before);
  });

  test(form + ' controller defers generation reload during input and restores the final draft once', () => {
    const storage = memoryStorage();
    const e = makeController({ generation: 8, sessionStorage: storage, scriptBodies });
    e.page.receive(model(1, 8));
    const reply = e.app.querySelector('[data-act="ans-reply"][data-id="13"]');
    assert.ok(reply, 'the rendered reply control exists');
    e.fire(reply, 'click');
    const input = e.app.querySelector('textarea[data-draft="13"]');
    assert.ok(input, 'opening reply renders a real textarea');
    input.value = 'draft before update';
    e.fire(input, 'input');
    input.focus();
    const held = e.app.innerHTML;
    e.page.receive(model(2, 9));
    assert.equal(e.reloads.length, 0);
    assert.equal(e.app.innerHTML, held);
    input.value = 'final draft during hold';
    e.fire(input, 'input');
    e.document.activeElement = e.document.body;
    e.fire(input, 'focusout', { relatedTarget: e.document.body });
    e.advance(100);
    assert.equal(e.reloads.length, 1);
    assert.equal(storage.getItem('omo-reloaded-for-9'), '1');
    const restored = makeController({ generation: 9, sessionStorage: storage, scriptBodies });
    restored.page.receive(model(3, 9));
    assert.equal(restored.page.state.ui.answers['13'].draft, 'final draft during hold');
    assert.ok(restored.app.innerHTML.includes('>final draft during hold</textarea>'));
    restored.page.receive(model(4, 9));
    assert.equal(restored.reloads.length, 0);
    assert.equal(e.errors.length, 0);
    assert.equal(restored.errors.length, 0);
  });
}
