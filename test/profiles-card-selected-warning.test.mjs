import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { disk } from './helpers/profiles-cards-fixture.mjs';
import {
  openEditorBrowser, openProfiles, click, sizes, capture, settle, waitFor,
} from './helpers/profiles-card-editor-browser.mjs';

// Same computed-color compositing/luminance pattern as profiles-select-colors.test.mjs.
function parseColor(raw) {
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(raw);
  if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255,
    b: Number(srgb[3]) * 255, a: srgb[4] === undefined ? 1 : Number(srgb[4]) };
  const match = /^rgba?\(([^)]+)\)$/.exec(raw);
  assert.ok(match, 'recognized browser-computed color: ' + raw);
  const values = match[1].trim().split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r: values[0], g: values[1], b: values[2], a: values[3] ?? 1 };
}

function over(fg, bg) {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
}

function luminance(color) {
  const channel = value => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

const profile = 'gpt-deepseek';
const body = '[data-pf="select-profile"][data-profile="' + profile + '"]';
const warning = body + ' .pf-card-main.pf-card-off';
const nativeState = `(() => {
  const button = document.querySelector(${JSON.stringify(body)}), article = button.closest('.pf-card');
  const root = document.querySelector('[data-pf-root]');
  const rect = node => { const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return {
    selected: [...document.querySelectorAll('[data-pf="select-profile"][aria-pressed="true"]')]
      .map(node => node.dataset.profile),
    selectedClass: article.className, busy: root.dataset.pfBusy, readOnly: root.dataset.readonly,
    current: [...document.querySelectorAll('.pf-current')].map(node => node.textContent.trim()),
    content: ['.pf-card-name', '.pf-card-tag', '.pf-card-sum', '.pf-card-main', '.pf-card-svc']
      .map(selector => { const node = article.querySelector(selector);
        return { selector, text: node.textContent, title: node.title, rect: rect(node) }; }),
    targets: [...article.querySelectorAll('button[data-pf]')].map(node => ({
      action: node.dataset.pf, profile: node.dataset.profile, text: node.textContent,
      label: node.getAttribute('aria-label'), pressed: node.getAttribute('aria-pressed'),
      disabled: node.disabled, type: node.type, rect: rect(node)
    })),
    values: [...root.querySelectorAll('select,input,textarea')].map(node => ({
      id: node.id, action: node.dataset.pf, value: node.value, disabled: node.disabled
    }))
  };
})()`;

// R: F105/F106 can recur while select/option tests pass. Native hover must preserve
// the selected warning's content/targets/state and meet contrast over both painted fills.
test('selected unsupported card warning stays readable on native body hover without changing native content or state',
  { timeout: 180000 }, async t => {
    const b = await openEditorBrowser(t), beforeDisk = disk(b.fx);
    const active = b.fx.store.state().activeProfile;
    t.diagnostic('SELECTED_WARNING_RESOURCES ' + JSON.stringify({
      chromePid: b.page.pid, chromeProfile: b.page.profileDir, chromePort: b.page.port,
      serverPort: Number(new URL(b.url).port), fixtureRoot: b.fx.root, fixtureHome: b.fx.home,
    }));
    for (const size of sizes) for (const theme of ['light', 'dark']) {
      await t.test(size.width + ' ' + theme, async () => {
        await b.page.client.send('Emulation.setDeviceMetricsOverride', size);
        await b.page.client.send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile });
        await b.page.client.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: theme }],
        });
        await openProfiles(b.page, b.url);
        await click(b.page, body);
        await waitFor(b.page, `document.querySelector(${JSON.stringify(body)}).getAttribute('aria-pressed') === 'true'`,
          'viewed warning card');
        const point = await b.page.eval(`(() => {
          const node = document.querySelector(${JSON.stringify(warning)});
          node.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r = node.getBoundingClientRect();
          window.__selectedWarningHover = null;
          node.closest('button').addEventListener('mousemove', event => {
            window.__selectedWarningHover = { trusted: event.isTrusted };
          }, { once: true });
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`);
        await settle(b.page);
        const before = await b.page.eval(nativeState);
        await b.page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        await settle(b.page);
        const after = await b.page.eval(nativeState);
        const paint = await b.page.eval(`(() => {
          const node = document.querySelector(${JSON.stringify(warning)}), button = node.closest('button');
          const layers = [];
          for (let parent = node; parent; parent = parent.parentElement) {
            const cs = getComputedStyle(parent);
            layers.push({ tag: parent.tagName, id: parent.id, class: parent.className,
              background: cs.backgroundColor, backgroundImage: cs.backgroundImage,
              opacity: cs.opacity, blend: cs.mixBlendMode });
          }
          const cs = getComputedStyle(node);
          return { layers: layers.reverse(), foreground: cs.color, fontSize: cs.fontSize,
            fontFamily: cs.fontFamily, text: node.textContent, title: node.title,
            hovered: button.matches(':hover'), trustedHover: window.__selectedWarningHover,
            hitBody: button.contains(document.elementFromPoint(${point.x}, ${point.y})),
            width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
            theme: matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light' };
        })()`);
        assert.deepEqual(after, before, 'hover preserves native content, values and target rectangles');
        assert.deepEqual(after.selected, [profile]);
        assert.equal(after.selectedClass, 'pf-card on');
        assert.equal(after.busy, 'false');
        assert.equal(after.readOnly, 'false');
        assert.deepEqual(after.targets.map(target => target.action).sort(),
          ['apply-card', 'edit-profile-card', 'select-profile']);
        assert.equal(after.targets.every(target => target.type === 'button' && !target.disabled), true);
        assert.match(paint.title, /^UNSUPPORTED_MODEL\b/);
        assert.equal(paint.hovered && paint.hitBody && paint.trustedHover?.trusted, true, 'real native body hover');
        assert.equal(paint.width, size.width);
        assert.equal(paint.theme, theme);
        for (const layer of paint.layers) {
          assert.equal(layer.opacity, '1', 'unattenuated painted ancestor');
          assert.equal(layer.backgroundImage, 'none', 'solid-color background stack');
          assert.equal(layer.blend, 'normal', 'ordinary source-over paint');
        }
        const colors = paint.layers.map(layer => parseColor(layer.background));
        const opaque = colors.findIndex(color => color.a === 1);
        assert.notEqual(opaque, -1, 'actual opaque painted ancestor; no invented canvas color');
        const background = colors.slice(opaque + 1).reduce((bg, fg) => over(fg, bg), colors[opaque]);
        const foreground = over(parseColor(paint.foreground), background);
        const l1 = luminance(foreground), l2 = luminance(background);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const measurement = { ...paint, point, foregroundComposite: foreground, backgroundComposite: background,
          ratio, threshold: 4.5, nativeBefore: before, nativeAfter: after };
        const name = 'selected-unsupported-hover-' + size.width + '-' + theme;
        await capture(b.page, name);
        if (process.env.OMO_CARD_EDITOR_EVIDENCE) fs.writeFileSync(
          path.join(process.env.OMO_CARD_EDITOR_EVIDENCE, name + '.measurement.json'),
          JSON.stringify(measurement, null, 2) + '\n');
        t.diagnostic('SELECTED_WARNING_MEASUREMENT ' + JSON.stringify({
          width: size.width, theme, foreground: paint.foreground, background, ratio, name,
        }));
        assert.ok(ratio >= 4.5, `${size.width} ${theme}: selected hovered warning contrast ${ratio} < 4.5`);
      });
    }
    assert.deepEqual(disk(b.fx), beforeDisk, 'all native fixture bytes including metadata stay unchanged');
    assert.deepEqual(b.fx.store.state().activeProfile, active, 'viewing never activates the profile');
    assert.equal(b.posts.length, 0, 'hover/viewing sends no native write request');
  });
