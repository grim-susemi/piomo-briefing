import test from 'node:test';
import assert from 'node:assert/strict';
import { editorFixture, plain, protectedState, route } from './helpers/profiles-card-editor-controller.mjs';

test('opening and closing the existing guide preserves unsaved card text and unrelated pending work', async t => {
  const f = await editorFixture(t);
  f.c.add(route);
  f.c.setDraft('main', { model: 'unsaved-main' });
  f.c.setDraft('memory:reflection', { model: 'unsaved-memory' });
  f.click('edit-profile-card', 'custom-1');
  f.input('card-name', 'unsaved guide regression');
  f.input('card-summary', 'text that must survive the guide');
  const card = plain(f.c.snapshot().cardEdit), before = protectedState(f.c.snapshot());
  const guide = f.root.querySelector('#pf-guide-dlg');
  assert.ok(guide, 'the existing guide coexists with the inline editor');
  // The deterministic DOM fixture delegates native dialog state to the platform adapter.
  guide.showModal = () => { guide.open = true; };
  guide.close = () => { guide.open = false; };

  f.click('guide-open');
  assert.deepEqual(plain(f.c.snapshot().cardEdit), card, 'guide open keeps unsaved card text');
  assert.deepEqual(protectedState(f.c.snapshot()), before);
  assert.equal(guide.open, true);
  f.click('guide-close');

  assert.equal(guide.open, false);
  assert.deepEqual(plain(f.c.snapshot().cardEdit), card, 'guide close keeps unsaved card text');
  assert.deepEqual(protectedState(f.c.snapshot()), before);
  assert.deepEqual(f.posts, [], 'the guide sends no profile or metadata write');
});

test('global busy disables every card edit trigger while an ordinary apply is held', async t => {
  const f = await editorFixture(t);
  const held = f.hold('nextPost'), applying = f.c.apply();
  try {
    await held.started;
    assert.equal(f.c.snapshot().busy, true);
    const before = protectedState(f.c.snapshot()), cardBefore = plain(f.c.snapshot().cardEdit);
    const buttons = f.root.querySelectorAll('[data-pf="edit-profile-card"]').map(el => ({
      profileKey: el.getAttribute('data-profile'), disabled: el.hasAttribute('disabled'),
    }));
    f.click('edit-profile-card', 'custom-1');
    const cardAfter = plain(f.c.snapshot().cardEdit);
    t.diagnostic('BUSY_TRIGGER_PROBE ' + JSON.stringify({
      busy: f.c.snapshot().busy, buttons, cardBefore, cardAfter,
      guardUnchanged: JSON.stringify(protectedState(f.c.snapshot())) === JSON.stringify(before),
      requestCount: f.posts.length, requestKinds: f.posts[0].changes.map(change => change.kind),
    }));
    assert.deepEqual(protectedState(f.c.snapshot()), before, 'busy edit guard preserves existing work');
    assert.deepEqual(cardAfter, cardBefore, 'busy edit guard rejects opening an editor');
    assert.equal(f.posts.length, 1, 'the trigger sends no additional request');
    assert.deepEqual(buttons, f.c.snapshot().view.profiles.map(profile => ({
      profileKey: profile.key, disabled: true,
    })), 'global busy must disable every card edit trigger rather than expose an enabled no-op');
  } finally {
    held.release({ status: 200, json: { ok: true, action: 'apply', backups: [], writes: [] } });
    await applying;
    t.diagnostic('BUSY_TRIGGER_CLEANUP ' + JSON.stringify({ heldReleased: true, busy: f.c.snapshot().busy }));
  }
});
