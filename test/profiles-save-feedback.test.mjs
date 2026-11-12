import test from 'node:test';
import assert from 'node:assert/strict';
import { makeController } from './fixtures/controller-dom.mjs';
import { fixture, base } from './helpers/profiles-cards-fixture.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function openEditor(t, frames) {
  const fx = fixture(t);
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'],
    configure(ctx) { ctx.requestAnimationFrame = fn => { frames.push(fn); return frames.length; }; } });
  e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
  e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
  e.fetches.find(f => f.url === '/profiles/state').resolve({ status: 200, json: async () => fx.store.state() });
  await tick();
  e.fire(e.byId.main.querySelector('[data-pf="edit-profile-card"][data-profile="' + base + '"]'), 'click');
  return e;
}
test('save acknowledgment disables every busy-gated control in the input task', async t => {
  const frames = [], e = await openEditor(t, frames);
  const gated = () => [...e.byId.main.querySelectorAll('[data-pf="edit-profile-card"], [data-pf="apply-card"], [data-pf="select-profile"], select[data-pf]')];
  assert.ok(gated().length > 3);
  e.fire(e.byId.main.querySelector('[data-pf="save-profile-card"]'), 'click');
  assert.equal(frames.length, 1, 'still the local acknowledgment, before any full render');
  assert.deepEqual(gated().filter(el => el.disabled !== true).map(el => el.getAttribute('data-pf')), []);
  assert.notEqual(e.byId.main.querySelector('[data-pf="cancel-profile-card"]').disabled, true);
});
test('refused save returns focus to Save after the busy render', async t => {
  const frames = [], e = await openEditor(t, frames);
  const save = e.byId.main.querySelector('[data-pf="save-profile-card"]');
  save.focus();
  e.fire(save, 'click');
  // Browser focus fixup: a focused control that becomes disabled leaves focus on the body.
  assert.equal(save.disabled, true);
  e.document.activeElement = e.document.body;
  e.fetches.filter(f => f.url === '/profiles').at(-1).resolve({ status: 400,
    json: async () => ({ ok: false, code: 'BAD_REQUEST', errors: [{ field: 'name', reason: 'EMPTY' }] }) });
  await tick();
  for (let n = 0; frames.length && n < 8; n++) frames.shift()(n * 16);
  const after = e.byId.main.querySelector('[data-pf="save-profile-card"]');
  assert.notEqual(after, save, 'the busy render replaced the button');
  assert.equal(after.hasAttribute('disabled'), false);
  // Identity as a boolean: a failing object assert would inspect the fake DOM (getters, depth 1000) without bound.
  assert.ok(e.document.activeElement === after, 'focus returns to the re-rendered Save');
});
for (const outcome of ['success', 'invalid', 'conflict', 'network', 'invalid-retry', 'network-retry']) {
  test('save acknowledgment retains inputs until paint and resolves fast ' + outcome, async t => {
    const kind = outcome.replace('-retry', '');
    const fx = fixture(t), frames = [];
    const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'],
      configure(ctx) {
        ctx.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
        const controls = Object.getPrototypeOf(ctx.document.createElement('input'));
        const previous = controls.setSelectionRange;
        controls.setSelectionRange = function (start, end, direction = 'none') {
          this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
        };
        t.after(() => { if (previous) controls.setSelectionRange = previous; else delete controls.setSelectionRange; });
      } });
    e.page.receive({ seq: 1, generatedAt: 0, sessions: [] });
    e.fire(e.byId.rail.querySelector('[data-key="profiles"]'), 'click');
    e.fetches.find(f => f.url === '/profiles/state').resolve({ status: 200, json: async () => fx.store.state() });
    await tick();
    e.fire(e.byId.main.querySelector('[data-pf="edit-profile-card"][data-profile="' + base + '"]'), 'click');
    const field = e.byId.main.querySelector('[data-pf="card-name"]');
    field.value = 'G5 retained draft'; e.fire(field, 'input'); field.focus(); field.setSelectionRange(2, 7);
    const writes = e.byId.main.writes;
    e.fire(e.byId.main.querySelector('[data-pf="save-profile-card"]'), 'click');
    assert.equal(e.byId.main.querySelector('[data-pf="card-name"]'), field, 'ack does not replace input DOM');
    assert.equal(e.byId.main.writes, writes);
    assert.ok(e.document.activeElement === field, 'ack keeps focus in the input');
    assert.deepEqual([field.selectionStart, field.selectionEnd], [2, 7]);
    assert.equal(e.byId.main.querySelector('[data-pf="save-profile-card"]').disabled, true);
    assert.equal(e.byId.main.querySelector('.pf-card-msg').textContent, '카드 글을 저장하는 중…');
    const posts = e.fetches.filter(f => f.url === '/profiles'); assert.equal(posts.length, 1);
    if (kind === 'network') posts[0].reject(new Error('fixture offline'));
    else {
      const response = kind === 'success' ? fx.store.handle(JSON.parse(posts[0].opts.body))
        : { status: kind === 'conflict' ? 409 : 400, json: { ok: false,
          code: kind === 'conflict' ? 'STALE' : 'BAD_REQUEST', errors: [{ field: 'name', reason: 'EMPTY' }] } };
      posts[0].resolve({ status: response.status, json: async () => response.json });
    }
    await tick();
    if (kind === 'success') {
      const reads = e.fetches.filter(f => f.url === '/profiles/state'); assert.equal(reads.length, 2);
      reads[1].resolve({ status: 200, json: async () => fx.store.state() }); await tick();
    }
    assert.equal(e.byId.main.querySelector('[data-pf="card-name"]'), field, 'fast response waits for acknowledgment paint');
    assert.equal(e.byId.main.writes, writes);
    assert.equal(frames.length, 1); frames.shift()(0);
    assert.equal(e.byId.main.writes, writes, 'first paint retains the local acknowledgment');
    assert.equal(frames.length, 1); frames.shift()(16);
    assert.equal(e.byId.main.writes, writes + 1);
    assert.equal(e.page.state.ui.profilesState.busy, false);
    if (kind === 'success') {
      assert.ok(e.byId.main.querySelector('[data-pf="card-name"]') === null, 'success closes the editor');
      assert.equal(e.byId.main.querySelector('.pf-card-name').textContent, 'G5 retained draft');
      assert.equal(e.document.activeElement.getAttribute('data-pf'), 'edit-profile-card');
    } else {
      const after = e.byId.main.querySelector('[data-pf="card-name"]');
      assert.equal(after.getAttribute('value'), 'G5 retained draft', 'rendered value initializes the browser input');
      assert.equal(e.page.state.ui.profilesState.cardEdit.name, 'G5 retained draft');
      assert.ok(e.document.activeElement === after, 'failure render keeps focus in the input');
      assert.deepEqual([after.selectionStart, after.selectionEnd], [2, 7]);
      assert.equal(e.byId.main.querySelector('.pf-card-msg').getAttribute('role'), 'alert');
      assert.match(e.byId.main.querySelector('.pf-card-msg').textContent,
        kind === 'conflict' ? /충돌/ : kind === 'network' ? /네트워크/ : /비어/);
      if (outcome.endsWith('-retry')) {
        e.fire(e.byId.main.querySelector('[data-pf="save-profile-card"]'), 'click');
        const retry = e.fetches.filter(f => f.url === '/profiles').at(-1);
        if (kind === 'network') retry.reject(new Error('fixture offline'));
        else retry.resolve({ status: 400, json: async () => ({ ok: false, code: 'BAD_REQUEST', errors: [{ field: 'name', reason: 'EMPTY' }] }) });
        await tick(); frames.shift()(32); frames.shift()(48);
        assert.equal(e.byId.main.querySelector('[data-pf-root]').getAttribute('data-pf-busy'), 'false', 'identical failure restores nonbusy DOM');
        assert.equal(e.byId.main.querySelector('.pf-card-msg').getAttribute('role'), 'alert');
        assert.match(e.byId.main.querySelector('.pf-card-msg').textContent, kind === 'network' ? /네트워크/ : /비어/);
      }

    }
  });
}
