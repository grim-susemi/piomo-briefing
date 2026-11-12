import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { editorFixture, plain, protectedState, route } from './helpers/profiles-card-editor-controller.mjs';

test('writable cards each expose an edit action; global readonly exposes none', async t => {
  const f = await editorFixture(t);
  const cards = f.c.snapshot().view.profiles;
  const edits = f.root.querySelectorAll('[data-pf="edit-profile-card"]');
  assert.deepEqual(edits.map(el => el.getAttribute('data-profile')), cards.map(p => p.key));
  for (const [i, el] of edits.entries()) {
    assert.equal(el.hasAttribute('disabled'), false);
    assert.ok(el.getAttribute('aria-label').includes(cards[i].name));
    assert.match(el.getAttribute('aria-label'), /글 편집/);
  }
  f.draw(f.c.snapshot(), { live: false });
  assert.equal(f.root.querySelectorAll('[data-pf="edit-profile-card"]').length, 0);
  fs.appendFileSync(path.join(path.dirname(f.primary), 'omo.js'), '\nchanged inventory');
  await f.c.load();
  assert.equal(f.c.snapshot().view.readOnly, true);
  assert.equal(f.root.querySelectorAll('[data-pf="edit-profile-card"]').length, 0);
});

test('an unreadable card file disables metadata editing with a visible reason', async t => {
  const f = await editorFixture(t);
  fs.writeFileSync(path.join(f.primary, 'runtime/native-profile-switcher-profile-cards.json'), '{broken');
  await f.c.load();
  const view = f.c.snapshot().view;
  assert.equal(view.readOnly, false);
  assert.equal(view.profileCards.writable, false);
  const edits = f.root.querySelectorAll('[data-pf="edit-profile-card"]');
  assert.equal(edits.length, view.profiles.length);
  for (const el of edits) {
    assert.equal(el.hasAttribute('disabled'), true);
  }
  const reason = edits.map(el => el.getAttribute('title') || '').join(' ') + f.root.textContent;
  assert.ok(reason.includes(view.profileCards.reason) ||
    /읽기 전용|손상|카드.{0,40}(오류|불러|저장할 수 없)/.test(reason), 'metadata refusal has an accessible reason');
  f.click('edit-profile-card', view.profiles[0].key);
  assert.equal(f.c.snapshot().cardEdit, null);
  assert.equal(f.posts.length, 0);
});

test('inline fields are labelled, bounded, escaped, and retain drafts without input rendering', async t => {
  const f = await editorFixture(t);
  const before = protectedState(f.c.snapshot());
  f.click('edit-profile-card', 'custom-1');
  const original = f.c.snapshot().view.profiles.find(p => p.key === 'custom-1');
  assert.equal(f.c.snapshot().cardEdit.key, 'custom-1');
  for (const field of ['name', 'tag', 'summary']) assert.equal(f.c.snapshot().cardEdit[field], original[field]);
  assert.deepEqual(protectedState(f.c.snapshot()), before);
  const text = '<&"\\ · 한글';
  for (const [marker, max] of [['card-name', 40], ['card-tag', 24], ['card-summary', 160]]) {
    const el = f.one(marker), id = el.getAttribute('id');
    assert.equal(el.getAttribute('maxlength'), String(max));
    assert.ok(id);
    assert.ok(f.root.querySelector(`label[for="${id}"]`));
    const writes = f.root.writes;
    f.input(marker, text);
    assert.equal(f.root.writes, writes, marker + ' input must not render');
  }
  assert.deepEqual(plain(f.c.snapshot().cardEdit),
    { key: 'custom-1', name: text, tag: text, summary: text });
  f.c.selectTab('agents');
  assert.equal(f.one('card-name').getAttribute('value'), text);
  assert.equal(f.one('card-tag').getAttribute('value'), text);
  assert.equal(f.one('card-summary').textContent, text);
  assert.equal(f.root.querySelectorAll('dialog input[data-pf="card-name"]').length, 0);
  assert.equal(f.root.querySelector('[data-pf="reset-profile-card"]'), null);
  f.click('cancel-profile-card');
  assert.equal(f.c.snapshot().cardEdit, null);
  assert.deepEqual(protectedState(f.c.snapshot()), before);
  f.click('edit-profile-card', 'custom-2');
  const other = f.c.snapshot().view.profiles.find(p => p.key === 'custom-2');
  for (const field of ['name', 'tag', 'summary']) assert.equal(f.c.snapshot().cardEdit[field], other[field]);
  assert.deepEqual(protectedState(f.c.snapshot()), before);
});

test('saving another card changes only its text and preserves pending drafts and preview through refresh', async t => {
  const f = await editorFixture(t);
  f.c.show('experimental-custom');
  f.c.add(route);
  f.c.setDraft('main', { provider: 'openai', model: 'gpt-6-sol', thinking: 'high' });
  f.c.setDraft('route:agents/explore', { provider: 'kimi-coding', model: 'kimi-coding/k3' });
  f.c.setDraft('memory:kibitzer', { mode: 'custom', model: 'pending-memory' });
  await f.c.preview();
  assert.ok(f.c.snapshot().preview, 'real preview must be open before card save');
  const before = protectedState(f.c.snapshot()), state = f.store.state(), reads = f.reads.length;
  f.click('edit-profile-card', 'custom-1');
  f.input('card-name', '<&"\\ · 내 조합');
  f.input('card-tag', '꼬리 & "');
  f.input('card-summary', '첫줄\r\n둘째\n셋째\r끝');
  const count = f.posts.length;
  await f.save();
  assert.deepEqual(f.posts.slice(count).map(p => [p.action, p.changes]), [['apply', [{
    kind: 'setProfileCard', profileKey: 'custom-1', name: '<&"\\ · 내 조합',
    tag: '꼬리 & "', summary: '첫줄 둘째 셋째 끝',
  }]]]);
  assert.deepEqual(protectedState(f.c.snapshot()), before);
  assert.equal(f.reads.length, reads + 1);
  assert.equal(f.c.snapshot().cardEdit, null);
  const saved = f.c.snapshot().view.profiles.find(p => p.key === 'custom-1');
  assert.equal(saved.name, '<&"\\ · 내 조합');
  assert.equal(saved.summary, '첫줄 둘째 셋째 끝');
  assert.equal(f.store.state().activeProfile.key, state.activeProfile.key);
  for (const [key, hash] of Object.entries(state.targets)) {
    if (!key.endsWith('profile-cards.json')) assert.equal(f.store.state().targets[key], hash, key);
  }
  assert.equal(f.root.querySelector('[data-pf="edit-profile-card"][data-profile="custom-1"]'),
    f.dom.document.activeElement, 'successful save requests focus on its own edit action');
});

test('a standalone refresh preserves unrelated drafts made after its request began', async t => {
  const f = await editorFixture(t);
  f.click('edit-profile-card', 'custom-1');
  f.input('card-name', '저장 중');
  const held = f.hold('nextGet');
  const done = f.save();
  await held.started;
  f.c.setDraft('memory:reflection', { model: 'later-model', reasoning: 'high' });
  const during = plain(f.c.snapshot().draft);
  assert.equal(during['memory:reflection'].model, 'later-model');
  held.release({ status: 200, json: async () => f.store.state() });
  await done;
  assert.deepEqual(plain(f.c.snapshot().draft), during);
});

for (const feedback of ['saved', 'error']) test(`card save preserves existing memory ${feedback} feedback`, async t => {
  const f = await editorFixture(t);
  f.c.add({ kind: 'setMemoryRow', row: 'kibitzer', mode: 'quick' });
  if (feedback === 'error') f.wire.nextPost = async () =>
    ({ status: 400, json: { ok: false, code: 'BAD_REQUEST', row: 'kibitzer', message: '기존 메모리 오류' } });
  await f.c.apply();
  const before = protectedState(f.c.snapshot());
  if (feedback === 'saved') {
    assert.equal(before.memorySaved.kibitzer, true);
    assert.equal(before.result.ok, true);
  } else assert.equal(before.memoryErrors.kibitzer, '기존 메모리 오류');
  f.click('edit-profile-card', 'custom-1');
  f.input('card-name', '별도 저장');
  await f.save();
  assert.deepEqual(protectedState(f.c.snapshot()), before);
});

test('saving while busy does not post and explains the reason inside the editor', async t => {
  const f = await editorFixture(t);
  f.click('edit-profile-card', 'custom-1');
  const held = f.hold('nextPost'), applying = f.c.preview();
  await held.started;
  const count = f.posts.length, draft = plain(f.c.snapshot().cardEdit);
  assert.equal(f.one('save-profile-card').hasAttribute('disabled'), true);
  f.click('save-profile-card');
  assert.equal(f.posts.length, count);
  assert.deepEqual(plain(f.c.snapshot().cardEdit), draft);
  assert.match(f.one('card-name').closest('article').textContent, /진행|처리 중|기다/);
  held.release({ status: 200, json: { ok: true, action: 'preview', diffs: [] } });
  await applying;
});

for (const [status, reason, message] of [
  [400, 'EMPTY', /비어|입력|빈 이름/],
  [400, 'TOO_LONG', /길|초과|넘|40/],
  [400, 'CONTROL_CHAR', /제어|허용하지|사용할 수 없/],
  [400, 'NOT_STRING', /문자열|문자로/],
  [400, 'NULL_NOT_ALLOWED', /기본 글|되돌|사용자 프로필/],
  [400, 'UNKNOWN_PROFILE', /없는 프로필|찾을 수 없|알 수 없/],
  [409, 'STALE', /새로|충돌|바뀌|갱신|변경되/],
]) test(`HTTP ${status} ${reason} retains the editor draft with a local Korean reason`, async t => {
  const f = await editorFixture(t);
  f.click('edit-profile-card', 'custom-1');
  f.input('card-name', '남아야 하는 초안');
  const draft = plain(f.c.snapshot().cardEdit), before = protectedState(f.c.snapshot());
  f.wire.nextPost = async () => ({ status, json: { ok: false, code: status === 409 ? 'STALE' : 'BAD_REQUEST',
    errors: [{ field: 'name', reason }] } });
  await f.save();
  assert.deepEqual(plain(f.c.snapshot().cardEdit), draft);
  assert.deepEqual(protectedState(f.c.snapshot()), before);
  assert.match(f.one('card-name').closest('article').textContent, message);
  if (status === 409) {
    const count = f.posts.length;
    assert.equal(f.one('save-profile-card').hasAttribute('disabled'), true);
    f.click('save-profile-card');
    assert.equal(f.posts.length, count);
    assert.match(f.one('card-name').closest('article').textContent, /[가-힣]/);
  }
});

test('built-in reset sends all three nulls and restores default text without selecting the card', async t => {
  const f = await editorFixture(t);
  const card = f.c.snapshot().view.profiles[0], before = protectedState(f.c.snapshot());
  f.click('edit-profile-card', card.key);
  await f.save('reset-profile-card');
  assert.deepEqual(f.posts.map(p => p.changes), [[{
    kind: 'setProfileCard', profileKey: card.key, name: null, tag: null, summary: null,
  }]]);
  const actual = f.c.snapshot().view.profiles.find(p => p.key === card.key);
  for (const field of ['name', 'tag', 'summary']) assert.equal(actual[field], card.defaults[field]);
  assert.deepEqual(protectedState(f.c.snapshot()), before);
});

test('digit one leaves the shown profile alone and Escape only cancels the editor', async t => {
  const f = await editorFixture(t);
  f.c.show('custom-2');
  f.c.openRow('agent:sisyphus');
  f.c.search('sisyphus');
  const before = protectedState(f.c.snapshot()), row = f.c.snapshot().openRow;
  f.click('edit-profile-card', 'custom-1');
  const field = f.one('card-name');
  field.focus();
  f.dom.fire(field, 'keydown', { key: '1' });
  assert.equal(f.c.snapshot().shown, 'custom-2');
  f.dom.fire(field, 'keydown', { key: 'Escape' });
  assert.equal(f.c.snapshot().cardEdit, null);
  assert.equal(f.c.snapshot().openRow, row);
  assert.equal(f.c.snapshot().query, 'sisyphus');
  assert.deepEqual(protectedState(f.c.snapshot()), before);
  assert.equal(f.posts.length, 0);
});

test('ordinary preview and apply retain their activation and draft-clearing behavior', async t => {
  const f = await editorFixture(t);
  f.c.show('experimental-custom');
  f.c.add(route);
  f.c.setDraft('main', { model: 'pending-main' });
  f.c.setDraft('route:agents/explore', { model: 'pending-route' });
  f.c.setDraft('memory:kibitzer', { model: 'pending-memory' });
  const preview = await f.c.preview();
  assert.equal(preview.preview.ok, true);
  assert.equal(preview.pending.length, 1);
  const after = await f.c.apply();
  assert.deepEqual(f.posts.map(p => p.action), ['preview', 'apply']);
  for (const post of f.posts) assert.deepEqual(post.changes, [
    route, { kind: 'selectProfile', profileKey: 'experimental-custom' },
  ]);
  assert.deepEqual(plain(after.pending), []);
  assert.deepEqual(plain(after.draft), {});
  assert.equal(after.preview, null);
  assert.equal(after.result.ok, true);
  assert.equal(after.view.activeProfile.key, 'experimental-custom');
});
