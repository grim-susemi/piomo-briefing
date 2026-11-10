// Real raw classic scripts, real page.js region/focus lifecycle, and the repository's owned CDP browser.
// No generated artifact, extracted function, live home, or production test seam.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createBoardServer } from '../../src/server.mjs';
import { launch } from '../../scripts/cdp.mjs';

const read = (name) => fs.readFileSync(new URL('../../src/page/' + name, import.meta.url), 'utf8');
const modules = ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'];
const styles = ['tokens', 'page', 'shell', 'profiles-view'];
const board = JSON.parse(fs.readFileSync(new URL('../fixtures/view-model-board.json', import.meta.url), 'utf8'));
const captureController = `const create = BriefProfiles.createController;
BriefProfiles.createController = function (options) {
  globalThis.titleController = create(options);
  return globalThis.titleController;
};`;

export async function openTitleBrowser(t, fixture) {
  const token = 'profiles-title-fixture';
  const server = createBoardServer({
    portBase: 51800 + (process.pid % 20) * 8, portCount: 8, generation: 7, token,
    getViewModel: () => board, profilesState: () => fixture.state,
    getPage: ({ nonce }) => {
      const script = (source) => '<script nonce="' + nonce + '">' +
        source.replace(/<(\/?script|!--)/gi, '\\x3C$1') + '</script>';
      return '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="omo-board-token" content="' + token + '">' +
        '<style nonce="' + nonce + '">' + styles.map((name) => read(name + '.css')).join('\n') +
        '</style></head><body><div id="app"></div>' +
        modules.map((name) => script(read(name + '.js'))).join('') +
        script(captureController) + script(read('page.js')) + '</body></html>';
    },
  });
  const { port } = await server.start();
  let page;
  t.after(async () => {
    try { if (page) await page.close(); } finally { await server.close(); }
  });
  page = await launch({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:' + port + '/');
  await page.eval(`new Promise((resolve, reject) => {
    const check = () => {
      const rail = document.querySelector('[data-key="profiles"]');
      if (!rail) return false;
      rail.click(); return true;
    };
    const observer = new MutationObserver(() => { if (check()) finish(); });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('profiles rail deadline')); }, 10000);
    const finish = () => { clearTimeout(timer); observer.disconnect(); resolve(true); };
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (check()) finish();
  })`);
  await page.eval(`new Promise((resolve, reject) => {
    const check = () => document.querySelector('[data-pf-root]')?.dataset.pfState === 'view';
    const observer = new MutationObserver(() => { if (check()) finish(); });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('profiles state deadline')); }, 10000);
    const finish = () => { clearTimeout(timer); observer.disconnect(); resolve(true); };
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (check()) finish();
  })`);
  await page.eval(`globalThis.titleEvents = [];
    for (const type of ['pointerdown', 'mousedown', 'focusin', 'keydown']) {
      document.getElementById('app').addEventListener(type, event => {
        const select = event.target.closest('[data-pf="route-backup"]');
        if (!select) return;
        titleEvents.push({
          type, trusted: event.isTrusted, prevented: event.defaultPrevented, key: event.key || '',
          id: select.id,
          options: [...select.options].map(option => ({
            value: option.value, title: option.getAttribute('title'), text: option.textContent,
            disabled: option.disabled, selected: option.selected
          }))
        });
      });
    }`);
  return page;
}

export async function titleKey(page, key, modifiers = 0) {
  const codes = { Tab: ['Tab', 9], ArrowDown: ['ArrowDown', 40], Escape: ['Escape', 27] };
  const [code, windowsVirtualKeyCode] = codes[key];
  await page.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, modifiers });
  await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}

export async function titleMouse(page, selector) {
  const point = await page.eval(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    select.scrollIntoView({ block: 'center' });
    const rect = select.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
  assert.ok(point.width > 0 && point.height > 0, 'native input target must be visible');
  const { x, y } = point;
  await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

export function assertAliasTitles(events, expected, selectedAlias = '') {
  assert.ok(events.length > 0, 'a trusted before-default observation is required');
  for (const event of events) {
    assert.equal(event.trusted, true, event.type + ' must come from Chrome input');
    assert.equal(event.prevented, false, event.type + ' must precede native default');
    assert.deepEqual(event.options.filter((option) => option.selected).map((option) => option.value),
      [selectedAlias], event.id + ' selected flag survives hydration');
    const actual = event.options.filter((option) => option.value !== '');
    assert.deepEqual(actual.map((option) => option.value), Object.keys(expected), event.id + ' complete alias pool');
    for (const option of actual) {
      const entry = expected[option.value];
      assert.equal(option.title, entry.title, event.id + ' ' + option.value + ' exact current title');
      assert.equal(option.disabled, entry.disabled, event.id + ' ' + option.value + ' disabled');
      if (entry.reason) assert.ok(option.text.endsWith(' · ' + entry.reason + (entry.variant ? ' / ' + entry.variant : '')),
        option.value + ' visible reason and alias effort');
    }
  }
}
