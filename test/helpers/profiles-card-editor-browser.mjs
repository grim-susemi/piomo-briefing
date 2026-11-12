import './refuse-live-writes.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBoardServer } from '../../src/server.mjs';
import { pageHtml } from '../../src/render.mjs';
import { launch, watchCsp } from '../../scripts/cdp.mjs';
import { waitFor, settle } from '../../scripts/qa-flow-map.mjs';
import { fixture, base } from './profiles-cards-fixture.mjs';

export { base, waitFor, settle };
export const marker = action => '[data-pf="' + action + '"]';
export const editButton = key => marker('edit-profile-card') + '[data-profile="' + key + '"]';
export const fields = ['card-name', 'card-tag', 'card-summary'];
export const sizes = [
  { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 },
  { width: 1024, height: 768, mobile: false, deviceScaleFactor: 1 },
  { width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 },
  { width: 1920, height: 1080, mobile: false, deviceScaleFactor: 1 },
];
export const inlineText = `(() => {
  let node = document.querySelector('[data-pf="card-name"]');
  while (node && !node.querySelector('[data-pf="save-profile-card"]')) node = node.parentElement;
  return node ? node.textContent : null;
})()`;

export async function openEditorBrowser(t, options = {}) {
  const cleanup = [];
  let page, csp, server, release = () => {};
  t.after(async () => {
    release();
    try { if (page) {
      try { await capture(page, 'final-' + (t.name || 'probe').replace(/[^a-zA-Z0-9]+/g, '-')); }
      finally { await page.close(); }
    } } finally {
      try { if (server) await server.close(); } finally {
        for (const callback of cleanup.reverse()) callback();
      }
    }
    if (csp) assert.deepEqual(csp.violations, [], 'real board CSP');
  });
  const fx = fixture({ after: callback => cleanup.push(callback) });
  if (options.seed) options.seed(fx);
  let model = JSON.parse(fs.readFileSync(new URL('../fixtures/view-model-board.json', import.meta.url)));
  const gate = options.hold ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const posts = [];
  const token = 'card-editor-' + crypto.randomUUID();
  server = createBoardServer({
    portBase: 52600 + process.pid % 100, portCount: 100, generation: model.gen, token,
    getPage: ({ nonce }) => pageHtml(model, model.gen, { mode: 'server', token, nonce }),
    getViewModel: () => model,
    profilesState: () => {
      const state = fx.store.state();
      return { ...state, readOnly: options.readOnly === true || state.readOnly,
        readOnlyReason: options.readOnlyReason ?? state.readOnlyReason,
        profileCards: { ...state.profileCards, writable: options.writable ?? state.profileCards.writable } };
    },
    onProfiles: async body => {
      posts.push(body);
      await gate;
      return fx.store.handle(body);
    },
  });
  const { port } = await server.start();
  page = await launch({ width: 1440, height: 900 });
  await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  if (process.env.OMO_CARD_EDITOR_SCRIPT_ERROR_PROBE)
    await page.addInitScript(fs.readFileSync(process.env.OMO_CARD_EDITOR_SCRIPT_ERROR_PROBE, 'utf8'));
  csp = await watchCsp(page);
  await page.client.send('Network.enable');
  const url = 'http://127.0.0.1:' + port + '/';
  await openProfiles(page, url);
  return { fx, page, url, posts, release, broadcast() {
    model = { ...model, seq: model.seq + 1 };
    server.broadcast(model);
    return model.seq;
  } };
}

export async function openProfiles(page, url) {
  await page.goto(url);
  await waitFor(page, `document.querySelector('#rail [data-key="profiles"]')`, 'profiles rail');
  await page.eval(`document.querySelector('#rail [data-key="profiles"]').click()`);
  await waitFor(page, `document.querySelector('[data-pf-root][data-pf-state="view"]')`, 'real profiles board');
  await page.eval(`(() => {
    if (document.querySelector('.sh-shell[data-peek="true"]')) document.querySelector('.sh-side [data-sh="toggleSide"]').click();
  })()`);
  await settle(page);
}

export async function key(page, name, modifiers = 0) {
  const code = { Tab: 9, Escape: 27, Backspace: 8, Enter: 13, a: 65, '1': 49 }[name];
  assert.ok(code, 'supported native key');
  await page.client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: name, windowsVirtualKeyCode: code, modifiers,
  });
  await page.client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: name, windowsVirtualKeyCode: code, modifiers,
  });
}

export async function click(page, selector) {
  const point = await page.eval(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
    node.scrollIntoView({ block: 'nearest' });
    const r = node.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
}

export async function fill(page, action, text) {
  await click(page, marker(action));
  await key(page, 'a', 2);
  await key(page, 'Backspace');
  if (text) await page.client.send('Input.insertText', { text });
}

export async function openEditor(page, profile = base) {
  await click(page, editButton(profile));
  await waitFor(page, `document.querySelector(${JSON.stringify(marker('card-name'))})`, 'inline editor');
}

export async function profilesResponse(page) {
  for (;;) {
    const event = await page.client.once('Network.responseReceived');
    if (new URL(event.response.url).pathname === '/profiles') return event.response;
  }
}

export async function saved(page) {
  await waitFor(page, `!document.querySelector('[data-pf="card-name"]')`, 'editor closes after successful save');
  await settle(page);
}

export async function card(page, profile = base) {
  return page.eval(`(() => {
    const node = document.querySelector(${JSON.stringify(editButton(profile))}).closest('.pf-card');
    return Object.fromEntries([['name', '.pf-card-name'], ['tag', '.pf-card-tag'], ['summary', '.pf-card-sum']]
      .map(([key, selector]) => [key, node.querySelector(selector).textContent]));
  })()`);
}

export async function focusSnapshot(page) {
  return page.eval(`(() => {
    const node = document.querySelector('[data-pf="card-name"]');
    return { name: node.value, tag: document.querySelector('[data-pf="card-tag"]').value,
      summary: document.querySelector('[data-pf="card-summary"]').value,
      focus: document.activeElement.getAttribute('data-pf'),
      start: node.selectionStart, end: node.selectionEnd };
  })()`);
}

export async function geometry(page, profile = base) {
  return page.eval(`(() => {
    const root = document.querySelector('[data-pf-root]'), main = document.getElementById('main');
    const edit = document.querySelector(${JSON.stringify(editButton(profile))}), article = edit.closest('.pf-card');
    const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const controls = [edit, article.querySelector('[data-pf="apply-card"]'), article.querySelector('.pf-card-b')];
    const boxes = controls.map(rect), overlap = [];
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const x = boxes[a], y = boxes[b];
      if (Math.min(x.x + x.w, y.x + y.w) > Math.max(x.x, y.x) &&
          Math.min(x.y + x.h, y.y + y.h) > Math.max(x.y, y.y)) overlap.push([a, b]);
    }
    const title = document.querySelector('.pf-title').getBoundingClientRect(), mr = main.getBoundingClientRect();
    const visible = e => e.getBoundingClientRect().height > 0;
    const nested = [...main.querySelectorAll('*')].filter(e => visible(e) &&
      !e.matches('textarea,input,select') &&
      /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight);
    const flat = [...root.querySelectorAll('.pf-sec, .pf-card, .pf-tray, .pf-card-editor')].filter(e => {
      const cs = getComputedStyle(e);
      const bg = cs.backgroundColor;
      const hasBg = !!bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
      const bw = ['Top', 'Right', 'Bottom', 'Left'].map(side => parseFloat(cs['border' + side + 'Width']) || 0);
      const borders = bw.filter(width => width > 0).length;
      const hasFullBorder = borders >= 2;
      const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
      return (hasBg && (hasFullBorder || hasShadow)) || (hasFullBorder && hasShadow);
    });
    const editorModality = ['[data-pf-card-editor]', '[data-pf="card-name"]', '[data-pf="card-tag"]',
      '[data-pf="card-summary"]', '[data-pf="save-profile-card"]', '[data-pf="cancel-profile-card"]',
      '[data-pf="reset-profile-card"]'].flatMap(selector => {
      const node = root.querySelector(selector);
      if (!node) return [];
      const dialog = node.closest('dialog');
      return [{ selector, closestDialog: dialog ? dialog.id || 'dialog' : null }];
    });
    return { boxes, overlap, horizontal: main.scrollWidth - main.clientWidth,
      documentHorizontal: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
      mainOwns: /auto|scroll/.test(getComputedStyle(main).overflowY), nested: nested.length, flat: flat.length,
      flatSelectors: flat.map(e => e.id ? '#' + e.id : '.' + e.className.trim().split(/\\s+/).join('.')),
      titleTop: title.top - mr.top, titleBottom: title.bottom - mr.top,
      current: [...document.querySelectorAll('.pf-current')].map(e => e.textContent.trim()),
      // Historical inventory metric: ANY dialog, including the pre-existing closed guide.
      dialog: !!root.querySelector('dialog'), editorModality, mainScrollTop: main.scrollTop, mainHeight: main.clientHeight };
  })()`);
}

export async function capture(page, name) {
  const out = process.env.OMO_CARD_EDITOR_EVIDENCE;
  if (!out) return;
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, name + '.png');
  await settle(page);
  await page.screenshot(file);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  const identity = await page.eval(`({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,
    theme:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light',href:location.href})`);
  const inventory = await page.eval(`(() => {
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
    const main=document.getElementById('main'), title=document.querySelector('.pf-title');
    return {main:rect(main),mainScrollTop:main.scrollTop,mainHorizontal:main.scrollWidth-main.clientWidth,
      title:title?rect(title):null,editCount:document.querySelectorAll('[data-pf="edit-profile-card"]').length,
      cards:[...document.querySelectorAll('.pf-card')].map(e=>({
        current:!!e.querySelector('.pf-current'),controls:[...e.querySelectorAll('[data-pf]')].map(n=>({
          action:n.dataset.pf,profile:n.dataset.profile||null,disabled:n.disabled===true,rect:rect(n),
          maxlength:n.maxLength||null,label:n.id?!!document.querySelector('label[for="'+n.id+'"]'):null
        }))})),
      scrollOwners:[...document.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().height>0 &&
        /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight>e.clientHeight)
        .map(e=>({id:e.id,tag:e.tagName,class:e.className,rect:rect(e)}))};
  })()`);
  assert.equal(bytes.readUInt32BE(16), identity.width * identity.dpr);
  assert.equal(bytes.readUInt32BE(20), identity.height * identity.dpr);
  const sources = Object.fromEntries(['profiles-view.js', 'profiles-view.css', 'page.js',
    'generated/profiles-view.min.js', 'generated/page.min.js'].map(name => {
    const source = new URL('../../src/page/' + name, import.meta.url);
    return [name, { sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
      mtime: fs.statSync(source).mtime.toISOString() }];
  }));
  fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify({
    ...identity, sources, inventory, capturedAt: new Date().toISOString(), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }, null, 2) + '\n');
  const collector = process.env.OMO_CARD_EDITOR_SNAPSHOT_COLLECTOR;
  if (collector) fs.writeFileSync(path.join(out, name + '.snapshot.json'),
    JSON.stringify(await page.eval(fs.readFileSync(collector, 'utf8'))) + '\n');
}
