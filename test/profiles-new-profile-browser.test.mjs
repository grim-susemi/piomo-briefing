// Task 16: create a profile by duplicating one, in real Chrome against an isolated server and temporary home.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openEditorBrowser, openProfiles, click, fill, marker, waitFor, settle, base } from './helpers/profiles-card-editor-browser.mjs';
import { apply, add, readJson, cardsFile } from './helpers/profiles-cards-fixture.mjs';

const selections = fx => ['native-profile-selection.json', 'agent/native-profile-selection.json', 'agent/settings.json']
  .map(rel => fs.readFileSync(path.join(fx.home, rel), 'utf8'));
const cardCount = page => page.eval(`document.querySelectorAll('[data-pf="select-profile"]').length`);
const shownKey = page => page.eval(`(document.querySelector('[data-pf="select-profile"][aria-pressed="true"]')||{dataset:{}}).dataset.profile||''`);
const currentKey = page => page.eval(`(() => { const c = document.querySelector('.pf-card .pf-current');
  const b = c && c.closest('.pf-card').querySelector('[data-pf="select-profile"]'); return b ? b.dataset.profile : ''; })()`);

test('S16-create-persist and S16-apply-custom: create only shows the new profile, then its Apply selects it', { timeout: 90000 }, async t => {
  const { fx, page, url } = await openEditorBrowser(t);
  const before = selections(fx), cards = await cardCount(page), current = await currentKey(page);
  assert.ok(current, 'a current chip exists before creating');
  await click(page, marker('new-profile'));
  await waitFor(page, `document.querySelector('[data-pf="new-profile-name"]')`, 'new profile form');
  assert.equal(await page.eval(`document.activeElement.dataset.pf`), 'new-profile-name');
  assert.equal(await page.eval(`document.querySelector('[data-pf="new-profile-base"]').value`), base, 'base starts at the shown profile');
  await fill(page, 'new-profile-name', '내 조합');
  await fill(page, 'new-profile-summary', '복제한 조합 <&> "따옴표" \\ 가·나');
  await click(page, marker('create-profile'));
  await waitFor(page, `document.querySelectorAll('[data-pf="select-profile"]').length === ${cards + 1}`, 'one more card');
  await settle(page);
  assert.equal(await page.eval(`!!document.querySelector('[data-pf="new-profile-name"]')`), false, 'form closes');
  assert.equal(await shownKey(page), 'custom-1', 'the new profile is shown');
  assert.equal(await currentKey(page), current, 'current chip did not move');
  assert.match(await page.eval(`document.querySelector('.pf-new-done').textContent`), /아직 적용하지 않았습니다/);
  assert.deepEqual(selections(fx), before, 'selection files and settings unchanged by create');
  const created = readJson(path.join(fx.home, cardsFile));
  assert.equal(created.custom[0].key, 'custom-1');
  assert.equal(created.cards['custom-1'].summary, '복제한 조합 <&> "따옴표" \\ 가·나');
  await openProfiles(page, url);
  assert.equal(await cardCount(page), cards + 1, 'persists after reload');
  assert.equal(await page.eval(`document.querySelector('[data-pf="select-profile"][data-profile="custom-1"] .pf-card-name').textContent`), '내 조합');
  const baseRows = await page.eval(`(() => { document.querySelector('[data-pf="select-profile"][data-profile="${base}"]').click();
    return [...document.querySelectorAll('[data-pf-agent]')].map(e => e.getAttribute('data-pf-agent') + '=' + (e.querySelector('select[data-pf="agent-lane"]')||{}).value).join('|'); })()`);
  const customRows = await page.eval(`(() => { document.querySelector('[data-pf="select-profile"][data-profile="custom-1"]').click();
    return [...document.querySelectorAll('[data-pf-agent]')].map(e => e.getAttribute('data-pf-agent') + '=' + (e.querySelector('select[data-pf="agent-lane"]')||{}).value).join('|'); })()`);
  assert.equal(customRows, baseRows, 'duplicated agent rows and lanes match the base');
  await click(page, '[data-pf="apply-card"][data-profile="custom-1"]');
  await waitFor(page, `(document.querySelector('.pf-card .pf-current')||{closest(){return null}}).closest('.pf-card')?.querySelector('[data-profile="custom-1"]')`, 'custom-1 becomes current');
  assert.match(fs.readFileSync(path.join(fx.home, 'native-profile-selection.json'), 'utf8'), /native-custom-1/);
});

test('S16-empty-name: an empty name is refused in the form and nothing is added', { timeout: 60000 }, async t => {
  const { fx, page } = await openEditorBrowser(t);
  const cards = await cardCount(page);
  await click(page, marker('new-profile'));
  await waitFor(page, `document.querySelector('[data-pf="new-profile-name"]')`, 'new profile form');
  await click(page, marker('create-profile'));
  await waitFor(page, `document.querySelector('[data-pf-new-profile] .pf-card-msg[role="alert"]')`, 'refusal in the form');
  assert.match(await page.eval(`document.querySelector('[data-pf-new-profile] .pf-card-msg').textContent`), /이름/);
  assert.equal(await cardCount(page), cards);
  assert.equal(fs.existsSync(path.join(fx.home, cardsFile)), false, 'no cards file written');
  await click(page, marker('cancel-new-profile'));
  assert.equal(await page.eval(`!!document.querySelector('[data-pf-new-profile]') || document.activeElement.dataset.pf`), 'new-profile');
});

test('S16-scale: 12 user profiles (18 cards) keep the layout limits at 390 and 1440', { timeout: 90000 }, async t => {
  const { page, url } = await openEditorBrowser(t, { seed: fx => { for (let i = 1; i <= 12; i++) apply(fx, [add('사용자 조합 ' + i)]); } });
  const out = {};
  for (const [width, height, tap] of [[1440, 900, 24], [390, 844, 44]]) {
    await page.client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await openProfiles(page, url);
    const m = await page.eval(`(() => {
      const main = document.getElementById('main'), se = document.scrollingElement, mr = main.getBoundingClientRect();
      const title = document.querySelector('.pf-title').getBoundingClientRect();
      const small = [...document.querySelectorAll('.pf-card [data-pf], [data-pf="new-profile"]')].filter(e => e.getBoundingClientRect().height > 0)
        .map(e => { const r = e.getBoundingClientRect(); return { pf: e.dataset.pf, w: r.width, h: r.height }; })
        .filter(r => Math.min(r.w, r.h) < ${tap});
      return { cards: document.querySelectorAll('[data-pf="select-profile"]').length,
        mainH: Math.max(0, main.scrollWidth - main.clientWidth), docH: Math.max(0, se.scrollWidth - se.clientWidth),
        titleBottom: title.bottom - mr.top, small,
        // Same measure and allowance as profiles-separation (#1179 B): 190 plus the visible Web panel and its gap.
        paneTop: document.querySelector('.pf-panes').getBoundingClientRect().top,
        paneLimit: (() => { const w = document.querySelector('.pf-web'), p = document.querySelector('.pf-panes');
          const r = w && w.checkVisibility() ? w.getBoundingClientRect() : null;
          return 190 + (r ? r.height + parseFloat(getComputedStyle(p.parentElement).rowGap) : 0); })() };
    })()`);
    out[width] = m;
    assert.equal(m.cards, 18);
    assert.equal(m.mainH, 0, width + ' main horizontal overflow');
    assert.equal(m.docH, 0, width + ' document horizontal overflow');
    assert.ok(m.titleBottom <= 160, width + ' title within 160px: ' + m.titleBottom);
    if (width >= 1440) assert.ok(m.paneTop <= m.paneLimit, 'switcher panes top ' + m.paneTop + ' within ' + m.paneLimit);
    assert.deepEqual(m.small, [], width + ' tap targets >= ' + tap + 'px');
  }
  t.diagnostic(JSON.stringify({ scenario: 'S16-scale', out }));
});
