import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { disk } from './helpers/profiles-cards-fixture.mjs';
import {
  openEditorBrowser, openEditor, click, fill, marker, base,
  profilesResponse, waitFor, settle, capture,
} from './helpers/profiles-card-editor-browser.mjs';

// The existing select-color test's source-over and WCAG luminance pattern,
// applied only to colors observed on the actual editor paragraph and ancestors.
function color(raw) {
  const match = /^rgba?\(([^)]+)\)$/.exec(raw);
  assert.ok(match, 'browser-computed RGB color: ' + raw);
  const n = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r: n[0], g: n[1], b: n[2], a: n[3] ?? 1 };
}
function over(f, b) {
  return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a), a: 1 };
}
function luminance(c) {
  const channel = v => { const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

async function measure(page, name, role) {
  await page.eval(`document.querySelector('.pf-card-msg').scrollIntoView({block:'center'})`);
  await settle(page);
  const actual = await page.eval(`(() => {
    const p = document.querySelector('.pf-card-msg'), editor = p.closest('[data-pf-card-editor]');
    const article = editor.closest('.pf-card'), root = document.querySelector('[data-pf-root]');
    const rect = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
    const cs = getComputedStyle(p), layers = [];
    for (let n=p;n;n=n.parentElement) {const s=getComputedStyle(n);
      layers.push({tag:n.tagName,class:n.className,background:s.backgroundColor,
        opacity:s.opacity,image:s.backgroundImage,blend:s.mixBlendMode});}
    return {text:p.textContent,role:p.getAttribute('role'),color:cs.color,
      textFill:cs.webkitTextFillColor,fontSize:cs.fontSize,fontFamily:cs.fontFamily,
      fontWeight:cs.fontWeight,lineHeight:cs.lineHeight,paragraph:rect(p),layers:layers.reverse(),
      editorSelected:article.classList.contains('on'),busy:root.dataset.pfBusy,
      conflict:root.dataset.pfConflict,
      selected:[...root.querySelectorAll('[data-pf="select-profile"][aria-pressed="true"]')].map(n=>n.dataset.profile),
      current:[...root.querySelectorAll('.pf-current')].map(n=>n.textContent.trim()),
      fields:[...editor.querySelectorAll('input,textarea')].map(n=>({action:n.dataset.pf,value:n.value,rect:rect(n)})),
      targets:[...editor.querySelectorAll('button')].map(n=>({action:n.dataset.pf,text:n.textContent,
        disabled:n.disabled,type:n.type,rect:rect(n)}))};
  })()`);
  assert.equal(actual.role, role);
  assert.equal(actual.color, actual.textFill, 'actual glyph fill matches measured foreground');
  for (const layer of actual.layers) {
    assert.equal(layer.opacity, '1');
    assert.equal(layer.image, 'none');
    assert.equal(layer.blend, 'normal');
  }
  const colors = actual.layers.map(layer => color(layer.background));
  const opaque = colors.findIndex(c => c.a === 1);
  assert.notEqual(opaque, -1, 'real opaque ancestor, without an invented canvas');
  const background = colors.slice(opaque + 1).reduce((b, f) => over(f, b), colors[opaque]);
  const foreground = over(color(actual.color), background);
  const a = luminance(foreground), b = luminance(background);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const result = { name, ...actual, background, foreground, ratio, threshold: 4.5 };
  await capture(page, name);
  if (process.env.OMO_CARD_EDITOR_EVIDENCE) fs.writeFileSync(
    path.join(process.env.OMO_CARD_EDITOR_EVIDENCE, name + '.measurement.json'),
    JSON.stringify(result, null, 2) + '\n');
  console.log('STATUS_MEASUREMENT ' + JSON.stringify({ name, role, color: actual.color, background, ratio }));
  return result;
}

const sizes = [
  { width: 375, height: 800, mobile: true, deviceScaleFactor: 3 },
  { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 },
  { width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 },
];
// R: the editor's real progress/400/offline paragraphs must remain readable on
// both selected and unselected surfaces; the model-warning and old select tests do not own this boundary.
for (const size of sizes) for (const theme of ['light', 'dark']) for (const selected of [true, false])
test(`editor status contrast ${size.width} ${theme} ${selected ? 'selected' : 'unselected'}`,
  { timeout: 90000 }, async t => {
    const b = await openEditorBrowser(t, { hold: true });
    const beforeDisk = disk(b.fx), active = b.fx.store.state().activeProfile;
    console.log('STATUS_RESOURCES ' + JSON.stringify({
      chromePid: b.page.pid, chromeProfile: b.page.profileDir, chromePort: b.page.port,
      serverPort: Number(new URL(b.url).port), fixtureRoot: b.fx.root,
    }));
    await b.page.client.send('Emulation.setDeviceMetricsOverride', size);
    await b.page.client.send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile });
    await b.page.client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: theme }],
    });
    const shown = selected ? base : 'gpt-deepseek';
    await click(b.page, marker('select-profile') + '[data-profile="' + shown + '"]');
    await openEditor(b.page);
    await fill(b.page, 'card-name', '   ');
    const response = profilesResponse(b.page);
    await click(b.page, marker('save-profile-card'));
    await waitFor(b.page, `document.querySelector('.pf-card-msg[role="status"]')`, 'real pending request');
    const id = size.width + '-' + theme + '-' + (selected ? 'selected' : 'unselected');
    const progress = await measure(b.page, id + '-saving', 'status');
    assert.equal(progress.busy, 'true');
    assert.equal(progress.targets.find(n => n.action === 'save-profile-card').disabled, true);
    b.release();
    assert.equal((await response).status, 400, 'real blank-refusal HTTP boundary');
    await waitFor(b.page, `document.querySelector('.pf-card-msg[role="alert"]')`, 'actual blank refusal');
    const error = await measure(b.page, id + '-blank', 'alert');
    assert.match(error.text, /이름이 비어/);
    assert.equal(error.busy, 'false');
    assert.equal(error.targets.find(n => n.action === 'save-profile-card').disabled, false);
    const measurements = [progress, error];
    if (size.width === 375) {
      await fill(b.page, 'card-name', 'offline draft');
      await b.page.client.send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      });
      try {
        await click(b.page, marker('save-profile-card'));
        await waitFor(b.page, `document.querySelector('.pf-card-msg')?.textContent.includes('네트워크 연결')`,
          'real browser offline refusal');
        const offline = await measure(b.page, id + '-offline', 'alert');
        assert.match(offline.text, /네트워크 연결/);
        assert.equal(offline.busy, 'false');
        measurements.push(offline);
      } finally {
        await b.page.client.send('Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        });
      }
    }
    for (const m of measurements) {
      assert.equal(m.editorSelected, selected);
      assert.deepEqual(m.selected, [shown]);
      assert.equal(m.conflict, 'false');
      assert.equal(m.targets.every(n => n.type === 'button'), true);
    }
    assert.deepEqual(disk(b.fx), beforeDisk, 'refusals preserve every native file including metadata');
    assert.deepEqual(b.fx.store.state().activeProfile, active);
    assert.equal(b.posts.length, 1, 'only the invalid local request reaches the server');
    assert.deepEqual(measurements.filter(m => m.ratio < 4.5).map(m => ({ name: m.name, ratio: m.ratio })), [],
      'all actual editor status/error paragraphs meet 4.5:1');
  });
