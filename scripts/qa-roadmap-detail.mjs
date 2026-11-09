import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { materializeFixture, computeProvenance } from './qa-roadmap.mjs';
import { pageHtml } from '../src/render.mjs';
import { launch } from './cdp.mjs';

const out = path.resolve(process.argv[2]);
fs.mkdirSync(out, { recursive: true });
const fixture = path.resolve('test/fixtures/roadmap/full.json');
const provenance = computeProvenance(fixture);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-detail-'));
let page;
try {
  const materialized = await materializeFixture(fixture, path.join(tmp, 'fixture'));
  const html = path.join(tmp, 'board.html');
  fs.writeFileSync(html, pageHtml(materialized.vm, 9, { mode: 'file' }));
  page = await launch({ width: 390, height: 844 });
  const captures = [];
  for (const theme of ['dark', 'light']) {
    await page.client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.goto(html);
    const visible = await page.eval(`(async () => {
      document.querySelector('#rail [data-key="plans"]').click();
      const sh = document.querySelector('.sh-shell');
      if (sh.getAttribute('data-peek') === 'true') document.querySelector('.sh-ib[data-sh="toggleSide"]').click();
      document.querySelector('[data-act="exp"][data-key*="R6b"][aria-expanded="false"]').click();
      await document.fonts.ready;
      await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})));
      const detail = document.querySelector('[data-rm-detail="R6b"]');
      detail.scrollIntoView({block:'center', behavior:'instant'});
      await new Promise(requestAnimationFrame);
      const r = detail.getBoundingClientRect(), m = document.getElementById('main').getBoundingClientRect();
      const x = Math.max(m.left, r.left) + 8, y = Math.max(m.top, r.top) + 8;
      return {top:r.top,bottom:r.bottom,mainTop:m.top,mainBottom:m.bottom,
        visible:r.top >= m.top && r.top < m.bottom && r.bottom > m.top,
        hit:detail.contains(document.elementFromPoint(x,y)),
        sidebarClosed:sh.getAttribute('data-peek') === 'false',
        text:detail.innerText, scrollTop:document.getElementById('main').scrollTop};
    })()`);
    if (!visible.visible || !visible.hit || !visible.sidebarClosed) throw new Error(JSON.stringify(visible));
    const name = `390x844-${theme}-detail.png`;
    const full = path.join(out, name);
    await page.screenshot(full);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    captures.push({ path: name, theme, width:390, height:844, sha256, capturedAt:new Date().toISOString(), ...visible });
  }
  fs.writeFileSync(path.join(out, 'detail.json'), JSON.stringify({ pass:true, provenance, captures }, null, 2));
  console.log(JSON.stringify({pass:true,captures:captures.map(c=>({path:c.path,visible:c.visible,hit:c.hit,scrollTop:c.scrollTop}))}));
} finally {
  if (page) await page.close();
  fs.rmSync(tmp, { recursive:true, force:true });
}
