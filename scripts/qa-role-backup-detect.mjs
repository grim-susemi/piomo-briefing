// Run with Bun to consume the installed frontend-detect TypeScript SDK.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createBoardServer } from '../src/server.mjs';
import { pageHtml } from '../src/render.mjs';
import { launch } from './cdp.mjs';
import { fallbackFixture } from '../test/helpers/fallback-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = process.argv[2], out = process.argv[3];
if (!sdk || !out) throw new Error('usage: bun scripts/qa-role-backup-detect.mjs <detect/index.ts> <output.json>');
const { collectPageSnapshot, STYLE_PROPS, lintSnapshot } = await import(sdk);
const fx = fallbackFixture();
const model = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/view-model-board.json'), 'utf8'));
const server = createBoardServer({
  portBase: 48591, portCount: 8, generation: 7, token: 'fixture-detect',
  getPage: ({ nonce } = {}) => pageHtml(model, 7, { mode: 'server', token: 'fixture-detect', nonce }),
  getViewModel: () => model, profilesState: () => fx.store.state(), onProfiles: (body) => fx.store.handle(body),
});
let page;
try {
  const { port } = await server.start();
  page = await launch({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
  await page.eval(`new Promise((resolve,reject) => {
    if(document.querySelector('#pf-tab-agents')) return resolve(true);
    const observer = new MutationObserver(() => { if(document.querySelector('#pf-tab-agents')) {clearTimeout(timer);observer.disconnect();resolve(true)} });
    const timer=setTimeout(()=>{observer.disconnect();reject(new Error('profiles unavailable'))},10000);
    observer.observe(document,{subtree:true,childList:true});
  })`);
  const results = [];
  for (const tab of ['primary', 'agents', 'categories']) {
    const selector = tab === 'primary' ? '[data-pf-agent="sisyphus"]'
      : `[data-pf-route="${tab}/${tab === 'agents' ? 'explore' : 'quick'}"]`;
    await page.eval(`document.querySelector('#pf-tab-${tab}').click()`);
    await page.eval(`document.querySelector(${JSON.stringify(selector)}+' .pf-row-sum').click()`);
    // Real keyboard traversal: the main thinking control precedes direct backup service.
    await page.eval(`(() => { const row=document.querySelector(${JSON.stringify(selector)});
      row.querySelector('[data-pf="${tab === 'primary' ? 'main-thinking' : 'route-thinking'}"]').focus(); })()`);
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const focus = await page.eval(`(() => {const e=document.activeElement,s=getComputedStyle(e);
      return {name:e.getAttribute('data-pf'), outline:s.outlineStyle, width:s.outlineWidth};})()`);
    assert.equal(focus.name, 'backup-provider');
    assert.notEqual(focus.outline, 'none');
    for (const width of [320, 390, 1024, 1440]) for (const theme of ['light', 'dark']) {
      await page.client.send('Emulation.setDeviceMetricsOverride', { width, height:1000, deviceScaleFactor:1, mobile:width<=390 });
      await page.client.send('Emulation.setEmulatedMedia', { features:[{name:'prefers-color-scheme',value:theme}] });
      await page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
      const snapshot = await page.eval(`(${collectPageSnapshot.toString()})(${JSON.stringify(STYLE_PROPS)}, 5000)`);
      const findings = lintSnapshot(snapshot);
      const changedSelectors = await page.eval(`(() => {
        const snapshotSelectors = ${JSON.stringify(snapshot.elements.map(e => e.selector))};
        return snapshotSelectors.filter(selector => { const e=document.querySelector(selector);
          return e && (e.matches('.pf-backup,.pf-backup *,.pf-backup-summary') || e.closest('.pf-backup')); });
      })()`);
      const changed = findings.filter(f => changedSelectors.includes(f.location?.selector));
      results.push({ tab, width, theme, focus, changed, inheritedOrPage: findings.filter(f => !changed.includes(f)) });
      assert.equal(snapshot.document.scrollWidth, width);
    }
  }
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  const blocking = results.flatMap(r => r.changed).filter(f => f.severity !== 'advisory');
  console.log(`ROLE_BACKUP_DETECT ${results.length} surfaces; changed warnings/errors ${blocking.length}; keyboard focus passed`);
  if (blocking.length) process.exitCode = 1;
} finally {
  if (page) await page.close();
  await server.close();
  fx.close();
}
