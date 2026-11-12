import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { apply, add, cardsFile, readJson, put } from './helpers/profiles-cards-fixture.mjs';
import { cardAuditSnapshot, assertCardApplyAudit, assertCardNoWriteAudit } from './helpers/profiles-card-editor-audit.mjs';
import {
  openEditorBrowser, openProfiles, openEditor, marker, editButton, fields, base, sizes,
  click, key, fill, profilesResponse, saved, card, focusSnapshot,
  geometry, capture, waitFor, inlineText,
} from './helpers/profiles-card-editor-browser.mjs';

// R: real Chrome transport, persistence, focus and layout are not covered by controller/store unit tests.
test('S15 rename, tag and description persist after reopening without activating or changing selection files',
  { timeout: 90000 }, async t => {
    const b = await openEditorBrowser(t), before = cardAuditSnapshot(b.fx), active = b.fx.store.state().activeProfile;
    const text = { name: '내 조합 <&"\\ · 한글', tag: '꼬리표 <&"\\ · 한글', summary: '새 설명 <&"\\ · 한글\n두 번째 줄' };
    const current = (await geometry(b.page)).current;
    await openEditor(b.page);
    for (const [index, action] of fields.entries()) await fill(b.page, action, Object.values(text)[index]);
    const response = profilesResponse(b.page);
    await click(b.page, marker('save-profile-card'));
    assert.equal((await response).status, 200);
    await saved(b.page);
    assert.equal(await b.page.eval(`document.activeElement.matches(${JSON.stringify(editButton(base))})`), true);
    assert.equal(b.posts.length, 1);
    assert.deepEqual(b.posts[0].changes, [{ kind: 'setProfileCard', profileKey: base,
      ...text, summary: text.summary.replace(/\n/g, ' ') }]);
    await openProfiles(b.page, b.url);
    const actual = await card(b.page);
    assert.equal(actual.name, text.name);
    assert.equal(actual.tag, '[' + text.tag + ']');
    assert.equal(actual.summary, text.summary.replace(/\n/g, ' '));
    assertCardApplyAudit(before, cardAuditSnapshot(b.fx), b.posts[0]);
    const activeAfter = b.fx.reopen().state().activeProfile, currentAfter = (await geometry(b.page)).current;
    assert.deepEqual(activeAfter, active);
    assert.deepEqual(currentAfter, current);
    t.diagnostic(JSON.stringify({ activeBefore: active, activeAfter, currentBefore: current, currentAfter }));
    await capture(b.page, 'persist-reopened-1440-light');
  });

test('S15 default reset restores built-in text through a standalone null metadata write',
  { timeout: 90000 }, async t => {
    const b = await openEditorBrowser(t, { seed: fx => apply(fx, [{
      kind: 'setProfileCard', profileKey: base, name: '고친 이름', tag: '고친 태그', summary: '고친 설명',
    }]) });
    const defaults = b.fx.store.state().profiles.find(p => p.key === base).defaults;
    const before = cardAuditSnapshot(b.fx), active = b.fx.store.state().activeProfile, current = (await geometry(b.page)).current;
    await openEditor(b.page);
    const response = profilesResponse(b.page);
    await click(b.page, marker('reset-profile-card'));
    assert.equal((await response).status, 200);
    await saved(b.page);
    assert.deepEqual(b.posts[0].changes, [{ kind: 'setProfileCard', profileKey: base, name: null, tag: null, summary: null }]);
    await openProfiles(b.page, b.url);
    assert.deepEqual(await card(b.page), { name: defaults.name, tag: '[' + defaults.tag + ']', summary: defaults.summary });
    assertCardApplyAudit(before, cardAuditSnapshot(b.fx), b.posts[0]);
    const activeAfter = b.fx.reopen().state().activeProfile, currentAfter = (await geometry(b.page)).current;
    assert.deepEqual(activeAfter, active);
    assert.deepEqual(currentAfter, current);
    t.diagnostic(JSON.stringify({ activeBefore: active, activeAfter, currentBefore: current, currentAfter }));
  });

test('S15 custom card offers cancellation without a built-in reset',
  { timeout: 90000 }, async t => {
    const b = await openEditorBrowser(t, { seed: fx => apply(fx, [add()]) });
    const before = cardAuditSnapshot(b.fx);
    await openEditor(b.page, 'custom-1');
    assert.equal(await b.page.eval(`document.querySelectorAll('[data-pf="reset-profile-card"]').length`), 0);
    assert.deepEqual(await card(b.page, 'custom-1'), { name: '내 조합', tag: '[내 꼬리표]', summary: '내 설명' });
    await key(b.page, 'Escape');
    await saved(b.page);
    assert.equal(b.posts.length, 0);
    assertCardNoWriteAudit(before, cardAuditSnapshot(b.fx));
  });

for (const mode of ['global-readonly', 'nonwritable']) {
  test('S15 ' + mode + ' prevents every card edit', { timeout: 90000 }, async t => {
    const b = await openEditorBrowser(t, mode === 'global-readonly' ? { readOnly: true } : { writable: false });
    const before = cardAuditSnapshot(b.fx);
    const controls = await b.page.eval(`([...document.querySelectorAll('[data-pf="edit-profile-card"]')]
      .map(e => ({ disabled: e.disabled, name: e.getAttribute('aria-label') })))`);
    if (mode === 'global-readonly') assert.deepEqual(controls, []);
    else {
      assert.equal(controls.length, b.fx.store.state().profiles.length);
      assert.equal(controls.every(e => e.disabled && e.name.endsWith(' 글 편집')), true);
    }
    assert.equal(b.posts.length, 0);
    for (const size of sizes) for (const theme of ['light', 'dark']) {
      await b.page.client.send('Emulation.setDeviceMetricsOverride', size);
      await b.page.client.send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile });
      await b.page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await openProfiles(b.page, b.url);
      await capture(b.page, mode + '-' + size.width + '-' + theme + '-disabled-top');
      await b.page.eval(`document.getElementById('main').scrollTop=document.getElementById('main').scrollHeight`);
      await capture(b.page, mode + '-' + size.width + '-' + theme + '-disabled-end');
    }
    assertCardNoWriteAudit(before, cardAuditSnapshot(b.fx));
  });
}

async function compose(page, text) {
  await page.client.send('Input.imeSetComposition', { text: text.slice(0, 1), selectionStart: 1, selectionEnd: 1 });
  await page.client.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  await page.client.send('Input.insertText', { text });
}

for (const failure of [{ name: 'blank-refusal', status: 400 }, { name: 'actual-http409', status: 409 }]) {
  test('S15 ' + failure.name + ' keeps the editor, composed draft, focus and Korean refusal in place',
    { timeout: 90000 }, async t => {
      const b = await openEditorBrowser(t, { hold: true, seed: fx => apply(fx, [{
        kind: 'setProfileCard', profileKey: base, name: '원래 이름', tag: '태그', summary: '설명',
      }]) });
      const auditBefore = cardAuditSnapshot(b.fx), activeBefore = b.fx.store.state().activeProfile;
      await openEditor(b.page);
      await fill(b.page, 'card-name', failure.status === 400 ? '   ' : '');
      if (failure.status === 409) {
        await compose(b.page, '中文');
        await compose(b.page, '한글');
        const file = path.join(b.fx.home, cardsFile), data = readJson(file);
        data.cards[base].name = '다른 창의 변경';
        put(file, data);
      }
      const draft = await focusSnapshot(b.page), initial = await b.page.eval(inlineText);
      const saveSize = `(() => { const r=document.querySelector('[data-pf="save-profile-card"]').getBoundingClientRect();
        return {width:r.width,height:r.height}; })()`;
      const idleSize = await b.page.eval(saveSize);
      const response = profilesResponse(b.page);
      // DOM activation preserves the already focused native IME input while exercising the real save listener/HTTP route.
      await b.page.eval(`document.querySelector('[data-pf="save-profile-card"]').click()`);
      await waitFor(b.page, `document.querySelector('[data-pf="save-profile-card"]').disabled`, 'standalone in progress');
      assert.deepEqual(await b.page.eval(saveSize), idleSize, 'progress keeps the save target size');
      const progressing = await b.page.eval(inlineText);
      await capture(b.page, failure.name + '-progress-1440-light');
      b.release();
      assert.equal((await response).status, failure.status, 'actual HTTP refusal status');
      await waitFor(b.page, `${inlineText} !== ${JSON.stringify(initial)} && ${inlineText} !== ${JSON.stringify(progressing)}`, 'local refusal replaces progress');
      const error = await b.page.eval(inlineText);
      assert.match(error, /[가-힣]/);
      assert.doesNotMatch(error, /\b(?:BAD_REQUEST|EMPTY|CONFLICT|STALE_TARGETS)\b/);
      assert.deepEqual(await focusSnapshot(b.page), draft, 'refusal retains exact draft, selection and focused input');
      assert.deepEqual(await b.page.eval(saveSize), idleSize, 'refusal keeps the save target size');
      assert.equal(await b.page.eval(`document.querySelector('[data-pf="save-profile-card"]').disabled`), failure.status === 409);
      assertCardNoWriteAudit(auditBefore, cardAuditSnapshot(b.fx));
      assert.deepEqual(b.fx.reopen().state().activeProfile, activeBefore);
      assert.equal(b.posts.length, 1);
      await capture(b.page, failure.name + '-error-focus-1440-light');
    });
}

test('S15 real Chinese and Korean IME survives an actual board host update while focused; digit 1 and Escape stay local',
  { timeout: 90000 }, async t => {
    const b = await openEditorBrowser(t);
    const beforeAudit = cardAuditSnapshot(b.fx);
    const second = b.fx.store.state().profiles[1].key;
    await click(b.page, marker('select-profile') + '[data-profile="' + second + '"]');
    await openEditor(b.page);
    await b.page.eval(`window.__editorComposition = [];
      for (const type of ['compositionstart','compositionupdate','compositionend','input'])
        document.querySelector('[data-pf="card-name"]').addEventListener(type, e =>
          __editorComposition.push({type:e.type,trusted:e.isTrusted,data:e.data,composing:e.isComposing === true}));`);
    for (const text of ['中文', '한글']) {
      await fill(b.page, 'card-name', '');
      await b.page.client.send('Input.imeSetComposition', { text, selectionStart: 1, selectionEnd: 1 });
      const before = await focusSnapshot(b.page);
      const seq = b.broadcast();
      await waitFor(b.page, `!document.getElementById('new-badge').hidden`, 'page.js busy holds host update');
      assert.deepEqual(await focusSnapshot(b.page), before);
      assert.equal(await b.page.eval(`BriefPage.state.pending.seq`), seq, 'actual SSE update is pending');
      await capture(b.page, (text === '中文' ? 'chinese' : 'korean') + '-composition-held-1440-light');
      await b.page.client.send('Input.insertText', { text });
      assert.equal((await focusSnapshot(b.page)).name, text);
    }
    const events = await b.page.eval(`__editorComposition`);
    for (const type of ['compositionstart', 'compositionupdate']) {
      assert.equal(events.some(e => e.type === type && e.trusted), true, 'native ' + type);
    }
    // Proxy1240: Chrome156 CDP emits untrusted completion on a plain input too; physical OS IME trust is unclaimed.
    assert.deepEqual(events.filter(e => e.type === 'compositionend').map(e => e.data), ['中文', '한글'], 'exact completion text');
    t.diagnostic(JSON.stringify({ composition: events, limitation: 'CDP compositionend trust; no physical OS IME claim' }));
    assert.equal(events.some(e => e.type === 'input' && e.composing && e.trusted), true);
    await key(b.page, '1');
    await b.page.client.send('Input.insertText', { text: '1' });
    assert.equal(await b.page.eval(`document.querySelector('[data-pf="select-profile"][aria-pressed="true"]').dataset.profile`), second);
    await key(b.page, 'Escape');
    await saved(b.page);
    assert.equal(await b.page.eval(`document.activeElement.matches(${JSON.stringify(editButton(base))})`), true);
    assert.equal(await b.page.eval(`document.querySelector('[data-pf="select-profile"][aria-pressed="true"]').dataset.profile`), second);
    assert.equal(b.posts.length, 0);
    assertCardNoWriteAudit(beforeAudit, cardAuditSnapshot(b.fx));
  });

for (const size of sizes) for (const theme of ['light', 'dark'])
test('S15 maximum text preserves flat layout, disjoint hit targets, title/scroll budget and keyboard focus across the matrix ' + size.width + ' ' + theme,
  { timeout: 180000 }, async t => {
    const b = await openEditorBrowser(t, { seed: fx => apply(fx, [{
      kind: 'setProfileCard', profileKey: base, name: '이름'.repeat(20), tag: '꼬리표'.repeat(8), summary: '설명'.repeat(80),
    }]) });
    const beforeAudit = cardAuditSnapshot(b.fx);
      await b.page.client.send('Emulation.setDeviceMetricsOverride', size);
      await b.page.client.send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile });
      await b.page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await openProfiles(b.page, b.url);
      const before = await geometry(b.page), id = 'maximum-' + size.width + '-' + theme;
      assert.ok(before.titleTop >= 0 && before.titleBottom <= 160, JSON.stringify(before));
      await capture(b.page, id + '-closed-top');
      const hover = await b.page.eval(`(() => {
        const e=document.querySelector(${JSON.stringify(editButton(base))});
        e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await b.page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hover });
      await capture(b.page, id + '-edit-hover');
      await openEditor(b.page);
      const open = await geometry(b.page), minimum = size.mobile ? 44 : 24;
      assert.deepEqual(open.overlap, [], 'edit/apply/body hit rectangles');
      assert.equal(open.boxes.every(r => r.w >= minimum && r.h >= minimum), true);
      assert.equal(open.horizontal, 0);
      assert.equal(open.documentHorizontal, 0);
      assert.equal(open.mainOwns, true);
      assert.equal(open.nested, 0);
      assert.equal(open.flat, 0);
      assert.equal(open.editorModality.length, 7, 'editor container and all built-in fields/actions are measured');
      assert.deepEqual(open.editorModality.filter(node => node.closestDialog !== null), [], 'editor and every field/action stay outside dialogs');
      assert.deepEqual(open.current, before.current);
      assert.ok(Math.ceil(Math.abs(open.mainScrollTop - before.mainScrollTop) / open.mainHeight) <= 1, 'closed task scroll budget');
      for (const [index, action] of fields.entries()) {
        const field = await b.page.eval(`(() => { const e=document.querySelector(${JSON.stringify(marker(action))});
          return {limit:e.maxLength,label:!!document.querySelector('label[for="'+e.id+'"]')}; })()`);
        assert.deepEqual(field, { limit: [40, 24, 160][index], label: true });
      }
      await capture(b.page, id + '-editor-open');
      await click(b.page, marker('card-name'));
      await key(b.page, 'Tab');
      await key(b.page, 'Tab', 8); // Native CDP Shift modifier; 1 is Alt.
      for (const action of [...fields, 'save-profile-card', 'cancel-profile-card', 'reset-profile-card']) {
        const focus = await b.page.eval(`(() => { const e=document.activeElement,c=getComputedStyle(e);
          return {field:e.dataset.pf,ring:e.matches(':focus-visible') && (parseFloat(c.outlineWidth)>0 || c.boxShadow!=='none')}; })()`);
        assert.deepEqual(focus, { field: action, ring: true });
        await capture(b.page, id + '-keyboard-focus-' + action);
        if (action !== 'reset-profile-card') await key(b.page, 'Tab');
      }
      await b.page.eval(`document.getElementById('main').scrollTop=document.getElementById('main').scrollHeight`);
      await capture(b.page, id + '-editor-end');
      await key(b.page, 'Escape');
    assert.equal(b.posts.length, 0);
    assertCardNoWriteAudit(beforeAudit, cardAuditSnapshot(b.fx));
  });
