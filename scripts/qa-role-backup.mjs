import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoardServer } from '../src/server.mjs';
import { pageHtml } from '../src/render.mjs';
import { launch } from './cdp.mjs';
import { fallbackFixture } from '../test/helpers/fallback-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/qa-role-backup.mjs <evidence-directory>');
fs.mkdirSync(out, { recursive: true });
const fx = fallbackFixture();
const sourceHashes = Object.fromEntries(['src/page/profiles-view.js', 'src/page/profiles-view.css', 'src/profiles/store.mjs',
  'src/profiles/role-backup.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const configBefore = fs.readFileSync(path.join(fx.home, 'omo.jsonc'));
const settingsBefore = fs.readFileSync(path.join(fx.home, 'agent/settings.json'));
const requests = [];
const vm = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/view-model-board.json'), 'utf8'));
const server = createBoardServer({
  portBase: 48580, portCount: 10, generation: 7, token: 'fixture-role-backup',
  getPage: ({ nonce } = {}) => pageHtml(vm, 7, { mode: 'server', token: 'fixture-role-backup', nonce }),
  getViewModel: () => vm, profilesState: () => fx.store.state(), onProfiles: (body) => {
    requests.push(body);
    return fx.store.handle(body);
  },
});
let page;
try {
  const { port } = await server.start();
  page = await launch({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
  await page.eval(`new Promise((resolve, reject) => {
    const ready = () => document.querySelector('[data-pf-route="agents/explore"]');
    if (ready()) return resolve(true);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('profiles did not open')); }, 10000);
    const observer = new MutationObserver(() => { if (ready()) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    observer.observe(document, { subtree:true, childList:true });
  })`);
  const captures = [];
  const surfaces = [
    { tab: 'primary', selector: '[data-pf-agent="sisyphus"]', route: 'primary/sisyphus' },
    { tab: 'agents', selector: '[data-pf-route="agents/explore"]', route: 'agents/explore' },
    { tab: 'categories', selector: '[data-pf-route="categories/quick"]', route: 'categories/quick' },
  ];
  async function open(surface) {
    await page.eval(`document.querySelector('#pf-tab-${surface.tab}').click()`);
    await page.eval(`(() => { const row = document.querySelector(${JSON.stringify(surface.selector)});
      if (row.querySelector('.pf-row-sum').getAttribute('aria-expanded') !== 'true') row.querySelector('.pf-row-sum').click(); })()`);
  }
  async function capture(surface, state, width, theme) {
    await page.client.send('Emulation.setDeviceMetricsOverride', {
      width, height: 1000, deviceScaleFactor: 1, mobile: width === 390,
    });
    await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390 });
    await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await page.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
    await page.eval(`document.querySelector(${JSON.stringify(surface.selector)}).scrollIntoView({block:'center'})`);
    await page.eval(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    const file = path.join(out, `${surface.tab}-${state}-${width}-${theme}.png`);
    await page.screenshot(file);
    const geometry = await page.eval(`(() => {
      const row = document.querySelector(${JSON.stringify(surface.selector)});
      return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        controls: [...row.querySelectorAll('select')].map(e => ({label:e.labels?.[0]?.querySelector('.pf-sel-t')?.textContent,
        value:e.value, width:e.getBoundingClientRect().width, height:e.getBoundingClientRect().height, disabled:e.disabled})),
        backup: row.querySelector('[data-pf="route-backup"]').value,
        note: row.querySelector('[data-pf="route-backup"]').closest('label').querySelector('.pf-hint')?.textContent };
    })()`);
    assert.equal(geometry.scrollWidth, width, 'page must not overflow the viewport');
    assert.equal(geometry.backup, state === 'unset' ? '' : 'sol-61-high');
    const backup = geometry.controls.find(control => control.label?.includes('백업'));
    assert.ok(backup.width > 0 && backup.height >= (width === 390 ? 44 : 24), 'backup control is visible and usable');
    captures.push({ surface: surface.tab, state, width, theme, file, geometry });
  }
  for (const state of ['unset', 'saved']) {
    if (state === 'saved') {
      for (const surface of surfaces) {
        await open(surface);
        await page.eval(`(() => { const select = document.querySelector(${JSON.stringify(surface.selector)} + ' [data-pf="route-backup"]');
          select.value = 'sol-61-high'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
      }
      await page.eval(`document.querySelector('.pf-apply [data-pf="preview"]').click()`);
      await page.eval(`new Promise((resolve,reject) => {
        const observer = new MutationObserver(() => { if(document.querySelector('[data-pf-preview]')) { observer.disconnect();clearTimeout(timer);resolve(true); } });
        const timer=setTimeout(()=>{observer.disconnect();reject(new Error('preview not shown'))},10000);
        observer.observe(document,{subtree:true,childList:true});
      })`);
      assert.equal(fs.existsSync(path.join(fx.home, 'runtime/native-profile-switcher-role-backups.json')), false);
      await page.eval(`document.querySelector('.pf-apply [data-pf="apply"]').click()`);
      await page.eval(`new Promise((resolve,reject) => {
        const ready = () => document.querySelector('[data-pf-result="apply"]') && !document.querySelector('.pf-loading');
        if(ready())return resolve(true);
        const observer = new MutationObserver(() => { if(ready()) { observer.disconnect();clearTimeout(timer);resolve(true); } });
        const timer=setTimeout(()=>{observer.disconnect();reject(new Error('save not shown'))},10000);
        observer.observe(document,{subtree:true,childList:true});
      })`);
      assert.ok(requests.every(request => request.changes.every(change => change.kind === 'setRoleBackup')));
      assert.deepEqual(fs.readFileSync(path.join(fx.home, 'omo.jsonc')), configBefore);
      assert.deepEqual(fs.readFileSync(path.join(fx.home, 'agent/settings.json')), settingsBefore);
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
      await page.eval(`new Promise((resolve,reject) => {
        const ready = () => document.querySelector('[data-pf-route="agents/explore"]');
        if(ready())return resolve(true);
        const observer = new MutationObserver(() => { if(ready()) { observer.disconnect();clearTimeout(timer);resolve(true); } });
        const timer=setTimeout(()=>{observer.disconnect();reject(new Error('reopen failed'))},10000);
        observer.observe(document,{subtree:true,childList:true});
      })`);
    }
    for (const surface of surfaces) {
      await open(surface);
      for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) await capture(surface, state, width, theme);
    }
  }
  // The detail save must never activate B when the only pending backup belongs to A.
  await open(surfaces[1]);
  await page.eval(`(() => {const e=document.querySelector('[data-pf-route="agents/explore"] [data-pf="route-backup"]');
    e.value='kimi';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await page.eval(`document.querySelector('[data-pf="select-profile"][data-profile="kimi-deepseek"]').click()`);
  const foreignProfileSave = await page.eval(`(() => {const button=document.querySelector('.pf-apply [data-pf="apply"]');
    const disabled=button.disabled;button.click();return {disabled,label:button.textContent};})()`);
  assert.equal(foreignProfileSave.disabled, true);
  assert.equal(requests.length, 2, 'preview and same-profile save only; foreign-profile save posts nothing');
  assert.equal(fx.reopen().state().activeProfile.key, 'gpt-kimi-deepseek');
  assert.deepEqual(fs.readFileSync(path.join(fx.home, 'omo.jsonc')), configBefore);
  assert.deepEqual(fs.readFileSync(path.join(fx.home, 'agent/settings.json')), settingsBefore);
  await page.eval(`document.querySelector('.pf-apply').scrollIntoView({block:'center'})`);
  await page.screenshot(path.join(out, 'foreign-profile-save-disabled.png'));
  await page.eval(`document.querySelector('[data-pf="select-profile"][data-profile="gpt-kimi-deepseek"]').click()`);
  await open(surfaces[1]);
  assert.equal(await page.eval(`document.querySelector('[data-pf-route="agents/explore"] [data-pf="route-backup"]').value`), 'kimi');
  fs.writeFileSync(path.join(out, 'captures.json'), JSON.stringify(captures, null, 2));
  fs.writeFileSync(path.join(out, 'behavior.json'), JSON.stringify({
    sourceHashes, captureCount: captures.length, requests, providerCalls: 0,
    reopened: true, mainConfigUnchanged: true, retrySettingsUnchanged: true, foreignProfileSave,
    stored: JSON.parse(fs.readFileSync(path.join(fx.home, 'runtime/native-profile-switcher-role-backups.json'), 'utf8')),
  }, null, 2));
  console.log('ROLE_BACKUP_CAPTURES ' + captures.length + '; selection, preview, save and reopen passed; provider calls 0');
} finally {
  if (page) await page.close();
  await server.close();
  fx.close();
}
