import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { apply, disk } from './helpers/profiles-cards-fixture.mjs';
import {
  openEditorBrowser, openEditor, click, marker, base, settle, capture, waitFor,
} from './helpers/profiles-card-editor-browser.mjs';

const out = process.env.OMO_CARD_EDITOR_EVIDENCE;
const max = { name: '이름'.repeat(20), tag: '꼬리표'.repeat(8), summary: '설명'.repeat(80) };
const select = key => marker('select-profile') + '[data-profile="' + key + '"]';
const fontFamily = '"Segoe UI Variable Text", "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif';
function record(id, value) {
  console.log('FOCUSED_MEASUREMENT ' + JSON.stringify({ id, ...value }));
  if (out) fs.writeFileSync(path.join(out, id + '.measurement.json'), JSON.stringify(value, null, 2) + '\n');
}
async function theme(page, value) {
  await page.client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value }],
  });
  await settle(page);
}
function contrast(actual) {
  const rgb = raw => {
    const match = /^rgba?\(([^)]+)\)$/.exec(raw);
    assert.ok(match, 'computed RGB: ' + raw);
    const [r, g, b, a = 1] = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const layers = actual.backgrounds.map(rgb).reverse(), start = layers.findIndex(c => c.a === 1);
  assert.notEqual(start, -1, 'opaque painted ancestor exists');
  const background = layers.slice(start + 1).reduce((b, f) => over(f, b), layers[start]);
  const inkColor = rgb(actual.color);
  const foreground = over({ ...inkColor, a: inkColor.a * Number(actual.opacity) }, background);
  const luminance = c => {
    const linear = v => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
  };
  const a = luminance(foreground), b = luminance(background);
  return { ...actual, foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
}
async function ink(page, selector, pseudo = null) {
  return page.eval(`(() => {
    const n=document.querySelector(${JSON.stringify(selector)}), s=getComputedStyle(n,${JSON.stringify(pseudo)});
    const backgrounds=[];
    for(let p=n;p;p=p.parentElement) {
      const c=getComputedStyle(p); if(c.opacity!=='1'||c.backgroundImage!=='none'||c.mixBlendMode!=='normal')
        throw new Error('Unsupported paint layer'); backgrounds.push(c.backgroundColor);
    }
    const r=n.getBoundingClientRect();
    return {color:s.color,opacity:s.opacity,backgrounds,fill:s.webkitTextFillColor,
      background:getComputedStyle(n).backgroundColor,active:n.matches(':active'),
      text:n.textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  })()`);
}

// R: round3 C4 escaped the old summary-only geometry gate. Real legal maximum
// metadata, original typography, glyph containment and title bounds own this case.
for (const mode of ['light', 'dark']) {
  test('C4 legal40/tag24/summary160 retains complete readable phone titles ' + mode,
    { timeout: 90000 }, async t => {
      const b = await openEditorBrowser(t, { seed: fx => apply(fx, [
        { kind: 'setProfileCard', profileKey: base, ...max },
      ]) });
      const before = disk(b.fx);
      await theme(b.page, mode);
      // openEditorBrowser enters Profiles at1440; direct phone docking is unsupported.
      await b.page.client.send('Emulation.setDeviceMetricsOverride',
        { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 });
      await b.page.client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await settle(b.page);
      const selectors = [select(base) + ' .pf-card-name', '.pf-status-v', '.pf-dt',
        select(base) + ' .pf-card-tag', select(base) + ' .pf-card-sum', '.pf-detail > .pf-du'];
      const actual = await b.page.eval(`(() => {
        const rect=r=>({x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom});
        const nodes=${JSON.stringify(selectors)}.map(selector=>{
          const n=document.querySelector(selector),s=getComputedStyle(n),box=n.getBoundingClientRect(),glyphs=[];
          const walker=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);
          while(walker.nextNode()) for(let i=0;i<walker.currentNode.length;i++) {
            const range=document.createRange();range.setStart(walker.currentNode,i);range.setEnd(walker.currentNode,i+1);
            for(const r of range.getClientRects()) if(r.width&&r.height) glyphs.push(rect(r));
          }
          const lines=[];for(const r of glyphs) if(!lines.some(y=>Math.abs(y-r.y)<2)) lines.push(r.y);
          const hidden=[];for(let p=n;p&&!p.matches('#main');p=p.parentElement) {
            const c=getComputedStyle(p);
            if(c.display==='none'||c.visibility!=='visible'||c.opacity!=='1'||c.clipPath!=='none'||
              /hidden|clip|scroll|auto/.test(c.overflowX+' '+c.overflowY)) hidden.push(p.className);
          }
          return {selector,text:n.textContent,box:rect(box),glyphs,lines,hidden,
            font:s.fontSize,family:s.fontFamily,weight:s.fontWeight,line:s.lineHeight,clamp:s.webkitLineClamp};
        });
        const main=document.getElementById('main'),title=document.querySelector('.pf-title');
        return {nodes,title:rect(title.getBoundingClientRect()),titleText:title.textContent,
          horizontal:main.scrollWidth-main.clientWidth,
          documentHorizontal:document.scrollingElement.scrollWidth-document.scrollingElement.clientWidth,
          nested:[...main.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().height>0&&
            !n.matches('input,textarea,select')&&/auto|scroll/.test(getComputedStyle(n).overflowY)&&
            n.scrollHeight>n.clientHeight).map(n=>n.className)};
      })()`);
      record('c4-390-' + mode, actual);
      await capture(b.page, 'c4-390-' + mode + '-top');
      for (const [label, selector] of [['card', select(base)], ['detail', '.pf-dt']]) {
        await b.page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`);
        await capture(b.page, 'c4-390-' + mode + '-' + label);
      }
      const errors = [];
      const expected = [max.name, '1. ' + max.name, '1. ' + max.name, '[' + max.tag + ']', max.summary, max.summary];
      for (const [i, n] of actual.nodes.entries()) {
        if (n.text !== expected[i]) errors.push(n.selector + ': exact text lost');
        if (n.font !== ['17px', '18px', '18px', '17px', '15px', '15px'][i] ||
          n.family !== fontFamily || n.weight !== ['600', '600', '600', '400', '400', '400'][i] ||
          n.line !== ['25.5px', '23.4px', '23.4px', '25.5px', '22.5px', '22.5px'][i])
          errors.push(n.selector + ': original font changed');
        if (i < 3 && n.lines.length > 3) errors.push(n.selector + ': title exceeds3lines (' + n.lines.length + ')');
        if (n.hidden.length || !['none', ''].includes(n.clamp)) errors.push(n.selector + ': hidden/clamped ancestor');
        if (n.glyphs.some(g => g.x < n.box.x - 1 || g.right > n.box.right + 1 ||
          g.y < n.box.y - 2 || g.bottom > n.box.bottom + 2)) errors.push(n.selector + ': glyph outside bounds');
      }
      for (const [key, value] of Object.entries({ x: 64, y: 64, width: 318, height: 23.39 }))
        if (Math.abs(actual.title[key] - value) > 0.1) errors.push('original title bound changed: ' + key);
      assert.equal(actual.titleText, '프로필·에이전트');
      assert.equal(actual.horizontal, 0); assert.equal(actual.documentHorizontal, 0);
      assert.deepEqual(actual.nested, [], 'no new nested scroll owner');
      const g = await b.page.eval(`(() => {
        const article=document.querySelector(${JSON.stringify(select(base))}).closest('article');
        return [...article.querySelectorAll('button')].map(n=>{
          const r=n.getBoundingClientRect();return {action:n.dataset.pf,x:r.x,y:r.y,w:r.width,h:r.height};});
      })()`);
      for (const r of g) assert.ok(r.w >= 44 && r.h >= 44, r.action + ': phone touch44');
      for (const [i, a] of g.entries()) for (const c of g.slice(i + 1))
        assert.ok(Math.min(a.x+a.w,c.x+c.w)<=Math.max(a.x,c.x) ||
          Math.min(a.y+a.h,c.y+c.h)<=Math.max(a.y,c.y), 'card controls do not overlap');
      assert.deepEqual(disk(b.fx), before); assert.equal(b.posts.length, 0);
      assert.deepEqual(errors, [], 'C4 complete legal maximum titles');
    });

  // R: E2 old gate covered editor messages, never the actual search placeholder.
  test('E2 actual routing-search placeholder contrast meets4.5 ' + mode, { timeout: 90000 }, async t => {
    const b = await openEditorBrowser(t); await theme(b.page, mode);
    await b.page.eval(`document.querySelector('#pf-routing-search').scrollIntoView({block:'center'})`);
    const actual = contrast(await ink(b.page, '#pf-routing-search', '::placeholder'));
    record('e2-' + mode, actual); await capture(b.page, 'e2-' + mode);
    assert.ok(actual.ratio >= 4.5, 'E2 placeholder contrast=' + actual.ratio);
    assert.equal(b.posts.length, 0);
  });

  // R: F5 public aria state existed, but selection had no independently visible glyph.
  test('F5 shown profile has a glyph distinct from global applied marker ' + mode, { timeout: 90000 }, async t => {
    const b = await openEditorBrowser(t); await theme(b.page, mode);
    const before = disk(b.fx), active = b.fx.store.state().activeProfile, shown = 'gpt-deepseek';
    const visibleGlyphs = `(() => {
      const selected=document.querySelector(${JSON.stringify(select(shown))});
      return [...selected.querySelectorAll('svg')]
        .map(n=>{const r=n.getBoundingClientRect();let visible=true;
          for(let p=n;p;p=p.parentElement) {const s=getComputedStyle(p);
            if(s.visibility!=='visible'||s.opacity==='0'||s.display==='none') visible=false;}
          const href=n.querySelector('use')?.getAttribute('href');
          return {svg:n.outerHTML,symbol:href,w:r.width,h:r.height,display:getComputedStyle(n).display,visible,
          sharedSymbol:!!href&&href.startsWith('#')&&document.getElementById(href.slice(1))?.tagName.toLowerCase()==='symbol',
          label:n.parentElement.getAttribute('aria-label')||
          n.parentElement.getAttribute('title')||n.parentElement.textContent.trim()};})
        .filter(g=>g.w>0&&g.h>0&&g.display!=='none'&&g.visible&&g.sharedSymbol);
    })()`;
    const glyphsBefore = await b.page.eval(visibleGlyphs);
    await click(b.page, select(shown));
    const actual = await b.page.eval(`(() => {
      const applied=document.querySelector('.pf-current'),remaining=new Map();
      for(const g of ${JSON.stringify(glyphsBefore)}) remaining.set(g.symbol,(remaining.get(g.symbol)||0)+1);
      const glyphs=(${visibleGlyphs}).filter(g=>{
        const count=remaining.get(g.symbol)||0;if(!count)return true;
        remaining.set(g.symbol,count-1);return false;});
      return {glyphs,selected:[...document.querySelectorAll('[data-pf="select-profile"][aria-pressed="true"]')]
        .map(n=>n.dataset.profile),applied:applied.closest('article').querySelector('[data-pf="select-profile"]').dataset.profile,
        appliedLabel:applied.getAttribute('aria-label')||applied.textContent.trim(),
        apply:[...document.querySelectorAll('[data-pf="apply-card"]')].map(n=>({key:n.dataset.profile,disabled:n.disabled}))};
    })()`);
    record('f5-' + mode, actual); await capture(b.page, 'f5-' + mode);
    assert.deepEqual(actual.selected, [shown]); assert.equal(actual.applied, base);
    assert.equal(actual.glyphs.length, 1, 'F5 exactly one new visible selection glyph');
    const glyph = actual.glyphs[0];
    assert.ok(glyph.w > 0 && glyph.h > 0 && glyph.display !== 'none' && glyph.visible);
    assert.equal(glyph.sharedSymbol, true, 'selection reuses the existing SVG symbol family');
    assert.notEqual(glyph.label, actual.appliedLabel, 'selection and applied marker are distinguishable');
    assert.deepEqual(actual.apply.map(n => n.key), b.fx.store.state().profiles.map(p => p.key));
    assert.equal(actual.apply.every(n => !n.disabled), true);
    assert.deepEqual(b.fx.store.state().activeProfile, active);
    assert.deepEqual(disk(b.fx), before); assert.equal(b.posts.length, 0);
  });

  // R: H5 source order checks missed hovered native held presses. Capture actual
  // held mouse and Space rasters; keep both input modes at the real Save boundary.
  for (const input of ['mouse', 'keyboard'])
    test('H5 Save held ' + input + ' beats hover with readable stable paint ' + mode, { timeout: 90000 }, async t => {
      const b = await openEditorBrowser(t, { hold: true }); await theme(b.page, mode); await openEditor(b.page);
      const selector = marker('save-profile-card'), id = 'h5-' + input + '-' + mode;
      await b.page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
      const idle = contrast(await ink(b.page, selector)), r = idle.rect;
      const point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      await b.page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await settle(b.page);
      const hover = contrast(await ink(b.page, selector));
      const raster = async state => {
        const result = await b.page.client.send('Page.captureScreenshot', { format: 'png',
          clip: { ...r, scale: 1 }, captureBeyondViewport: false });
        const bytes = Buffer.from(result.data, 'base64');
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        if (out) fs.writeFileSync(path.join(out, id + '-' + state + '-button.png'), bytes);
        await capture(b.page, id + '-' + state);
        return crypto.createHash('sha256').update(bytes).digest('hex');
      };
      const hoverRaster = await raster('hover');
      if (input === 'mouse') await b.page.client.send('Input.dispatchMouseEvent',
        { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
      else {
        await b.page.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
        await b.page.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      }
      try {
        await settle(b.page);
        const pressed = contrast(await ink(b.page, selector)), pressedRaster = await raster('held');
        record(id, { idle, hover, pressed, hoverRaster, pressedRaster });
        assert.equal(pressed.active, true, 'native held :active is reached');
        assert.notEqual(pressed.backgrounds[0], hover.backgrounds[0], 'H5 pressed paint wins hover');
        assert.notEqual(pressedRaster, hoverRaster, 'actual held raster differs from hover');
        for (const state of [idle, hover, pressed]) {
          assert.ok(state.ratio >= 4.5, 'Save label contrast=' + state.ratio);
          assert.equal(state.text, idle.text); assert.equal(state.rect.width, r.width); assert.equal(state.rect.height, r.height);
        }
      } finally {
        if (input === 'mouse') await b.page.client.send('Input.dispatchMouseEvent',
          { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
        else await b.page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      }
      await waitFor(b.page, `document.querySelector(${JSON.stringify(selector)})?.disabled`, 'Save disables during held request');
      const disabled = contrast(await ink(b.page, selector)); record(id + '-disabled', disabled);
      assert.equal(disabled.rect.width, r.width); assert.equal(disabled.rect.height, r.height);
      assert.equal(b.posts.length, 1); assert.equal(b.posts[0].changes[0].kind, 'setProfileCard');
    });
}
