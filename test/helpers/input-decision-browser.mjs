// Owned, bounded real-browser proof for todo 9. No live state, one Chrome, every wait tied to DOM or CDP.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launch, isPidAlive, listProfilePids } from '../../scripts/cdp.mjs';
import { createBoardServer } from '../../src/server.mjs';
import { openStore } from '../../src/store.mjs';
import { buildViewModel, pageHtml } from '../../src/render.mjs';
import { applyBoardAnswer } from '../../src/decide.mjs';
import { createDeliverer } from '../../src/deliver.mjs';
import { makeFakeSession } from './fake-session.mjs';
import { decisionFields, decisionValues } from '../fixtures/decision-fields.mjs';
import { validateBrief } from '../../src/schema.mjs';

const out = process.argv[2];
if (!out) throw new Error('evidence directory required');
fs.mkdirSync(out, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-fields-browser-'));
const store = openStore(dir), session = makeFakeSession(), meta = {};
const now = Date.now();
store.replace('sessions/owner/meta.json', { sessionId: 'owner', title: '보드 설정', lastActivityAt: now });
const deliver = createDeliverer({ pi: { session }, store, getSessionId: () => 'owner', getMeta: () => meta,
  saveMeta() {}, refresh() {}, enabled: () => true, watch: false });
const ctx = { isIdle: () => true, sessionManager: { getBranch: () => [] } };
let id, vm, page, browserPids = [], fatal = null;
const layoutOnly = process.env.OMO_INPUT_LAYOUT_ONLY === '1';
const results = { pid: process.pid, captures: [], keyboard: [], layout: [], geometry: [], refusals: [], cleanup: {} };
const server = createBoardServer({ portBase: Number(process.env.OMO_BRIEFING_PORT_BASE || 47400), portCount: 10, generation: 9, token: 'owned-field-test',
  getPage: ({ nonce } = {}) => pageHtml(vm, 9, { mode: 'server', token: 'owned-field-test', nonce }), getViewModel: () => vm,
  onAnswer: async body => {
    const r = applyBoardAnswer(store, body, now);
    if (r.ok) { await deliver.wake(ctx, 'input'); session.emit('d' + body.id); await deliver.wake(ctx, 'message_end'); }
    return { status: r.ok ? 200 : r.code === 'ANSWERED' ? 409 : 400, json: r };
  } });
const frame = () => page.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
const key = async (key, code, vk, modifiers = 0) => {
  await page.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
  await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
};
const selector = f => `[data-ans="${id}"] [data-field="${f}"]`;
const focus = s => page.eval(`(document.querySelector(${JSON.stringify(s)}).focus(),true)`);
async function type(f, value) {
  await focus(selector(f)); await key('a', 'KeyA', 65, 2);
  await page.client.send('Input.insertText', { text: String(value) });
}
const click = act => page.eval(`(document.querySelector('[data-ans="${id}"] [data-act="${act}"]').click(),true)`);
async function fill() {
  await type('name', '보드'); await type('side_width', '280');
  await focus(selector('theme') + '[value="시스템 따라감"]');
  await key('ArrowRight', 'ArrowRight', 39);
  await focus(selector('layout')); await key('End', 'End', 35); await key('Enter', 'Enter', 13);
}
async function capture(width, theme, surface, state, end = false) {
  await page.eval(`(() => {const m=document.getElementById('main');${end ? 'm.scrollTop=m.scrollHeight' : `(document.querySelector('[data-ans="${id}"]')?.closest('.dcard')||document.querySelector('.cv-hist')).scrollIntoView({block:'start'});m.scrollBy(0,-110)`};return true;})()`);
  await frame();
  const name = `${surface}-${theme}-${width}-${state}${end ? '-end' : ''}.png`;
  const file = path.join(out, name);
  await page.screenshot(file);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), width);
  assert.equal(bytes.readUInt32BE(20), 1000);
  results.captures.push({ file: name, width, height: 1000, theme, surface, state, end, png: true });
}
async function ready(url, fields = decisionFields()) {
  id = store.allocDecisionId({ sessionId: 'owner', question: '보드 설정 값을 입력해 주세요', reason: '값을 확인하고 대화에 보내요', blocks: false, fields, source: 'brief', createdAt: now });
  vm = buildViewModel(store.readSnapshot(), now, { generation: 9 });
  vm.seq = id; vm.sessions[0].decisions = vm.sessions[0].decisions.filter(d => d.id === id);
  await page.goto(url + '?decision=' + id);
  await page.eval(`new Promise((resolve,reject)=>{const t=setTimeout(()=>{m.disconnect();reject(new Error('page not ready'))},12000);const check=()=>{if(window.BriefPage&&BriefPage.state.model){clearTimeout(t);m.disconnect();resolve(true)}};const m=new MutationObserver(check);m.observe(document.documentElement,{subtree:true,childList:true});check()})`);
  await page.eval(`(BriefPage.open('owner','ov'),true)`);
}
async function layout(label) {
  const r = await page.eval(`(() => {const m=document.getElementById('main'),box=document.querySelector('[data-ans="${id}"]');
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
    const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data]};
    const lum=rgb=>rgb.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
    const contrasts=[...box.querySelectorAll('input:not([type="radio"])')].map(input=>{
      const bg=rgba(getComputedStyle(input).backgroundColor),fg=rgba(getComputedStyle(input,'::placeholder').color);
      const text=fg.slice(0,3).map((v,i)=>(v*fg[3]+bg[i]*(255-fg[3]))/255);
      const a=lum(text),b=lum(bg.slice(0,3));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    });
    return {
    main:m.scrollWidth-m.clientWidth,doc:document.documentElement.scrollWidth-innerWidth,
    viewport:innerWidth,columns:new Set([...box.querySelectorAll('.ans-field')].map(e=>Math.round(e.getBoundingClientRect().left))).size,
    widths:[...box.querySelectorAll('.ans-field')].map(e=>e.getBoundingClientRect().width),
    placeholderContrast:contrasts.length?Math.min(...contrasts):null,
    unused:box.querySelector('.ans-field-grid')?box.querySelector('.ans-field-grid').getBoundingClientRect().right-Math.max(...[...box.querySelectorAll('.ans-field')].map(e=>e.getBoundingClientRect().right)):null,
    shortTargets:innerWidth>600?[]:[...box.querySelectorAll('button,select,input:not([type="radio"]),.ans-choices label')].filter(e=>e.getBoundingClientRect().height<44).map(e=>e.outerHTML.slice(0,120)),
    over:[...box.querySelectorAll('input,select,label,fieldset,.ans-confirm')].filter(e=>e.getBoundingClientRect().right>m.getBoundingClientRect().right+1).map(e=>e.outerHTML.slice(0,120)),
    errors:[...document.querySelectorAll('#page-error')].map(e=>e.textContent)}})()`);
  assert.ok(r.main <= 1 && r.doc <= 1 && !r.over.length && !r.errors.length, label + ': ' + JSON.stringify(r));
  assert.equal(r.shortTargets.length, 0, label + ': every phone control has a 44 px target');
  if (r.widths.length) {
    assert.ok(r.widths.every(w => w >= 190), label + ': no starved field column');
    assert.ok(r.placeholderContrast >= 4.5, label + ': placeholder contrast is AA');
    assert.ok(Math.abs(r.unused) <= 1, label + ': no empty trailing grid track');
    if (r.viewport <= 390) assert.equal(r.columns, 1);
    if (r.viewport >= 1024) assert.ok(r.columns >= 2, label + ': compact approved desktop grid');
  }
  results.layout.push({ label, ...r });
}
async function geometry() {
  return page.eval(`(() => {
    const box=document.querySelector('[data-ans="${id}"]'),origin=box.getBoundingClientRect();
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x-origin.x,y:r.y-origin.y,width:r.width,height:r.height}};
    return {
      controls:[...box.querySelectorAll('input,select,button')].map(e=>({key:e.dataset.field?e.dataset.field+':'+(e.type==='radio'?e.value:''):e.dataset.act,...rect(e)})),
      actions:[...box.querySelectorAll('.ans-acts,.ans-confirm')].map(rect),
      gate:(()=>{const grid=box.querySelector('.ans-field-grid').getBoundingClientRect();return {
        fields:[...box.querySelectorAll('.ans-field')].map(f=>({id:f.querySelector('[data-field]').dataset.field,top:f.querySelector('[data-field]').getBoundingClientRect().top-grid.top})),
        action:box.querySelector('[data-act="ans-fields"]').getBoundingClientRect().top-grid.top,
        scroll:document.getElementById('main').scrollTop}})()
    };
  })()`);
}
async function geometryChecks(url) {
  const issues = [];
  for (const [width, extreme] of [[390, false], [1024, false], [1440, false], [390, true], [320, true]]) for (const theme of ['light', 'dark']) {
    await page.client.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 390 });
    await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: width <= 390 });
    await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    // The long finite decimal spellings are longer than MAX_VALUE's exponent spelling.
    const fields = decisionFields();
    if (extreme) {
      const label = ('보안 검토와 운영 정책 및 유지 보수 계획 확인 ').repeat(2).slice(0, 40);
      fields.forEach(f => { f.label = label; });
      fields[1] = { ...fields[1], min: -0.0000012345678901234567, max: -0.0000012345678901234565, step: 0.0000012345678901234567 };
      assert.equal(String(fields[1].min).length, 25);
      assert.equal(String(fields[1].max).length, 25);
      fields[2].options = ['기존 운영 절차 유지와 보안 검토 후 안전한 배포를 선택하고 내용을 확인합니다', '새로운 운영 절차 작성과 보안 검토 후 배포를 선택하고 모든 내용을 확인합니다'].map(s => s.slice(0, 40));
      fields[3].options = ['기본', '넓은', '좁은', '자동', '두 칸', '한 칸'].map(s => (s + ' 배치로 자료를 차례대로 보여 주고 운영 정책 요구사항을 확인합니다').slice(0, 40));
    }
    assert.equal(validateBrief({ title: '검사', status: 'needs_decision', headline: '입력', changes: [], done: [], next: '',
      decisions: [{ question: '확인', reason: '확인', blocks: false, fields }] }).ok, true);
    await ready(url, fields);
    const surface = extreme ? 'geometry-extremes' : 'geometry';
    await capture(width, theme, surface, 'before');
    const before = await geometry(), states = [];
    const check = async state => {
      await frame();
      const after = await geometry();
      let maxMovement = 0;
      for (const kind of ['controls', 'actions']) for (let i = 0; i < before[kind].length; i++) {
        const a = before[kind][i], b = after[kind][i];
        if (!b || a.key !== b.key) { issues.push(`${width}/${theme}/${state}: changed ${kind}`); continue; }
        maxMovement = Math.max(maxMovement, Math.abs(a.x-b.x), Math.abs(a.y-b.y));
      }
      states.push({ state, after, maxMovement });
      if (maxMovement > .5) issues.push(`${width}/${theme}/${state}: moved ${maxMovement}px`);
    };
    await click('ans-fields');
    await check('client-invalid');
    await capture(width, theme, surface, 'invalid');
    const f = fields[1];
    const longest = {
      name: '1..200자로 입력해 주세요',
      side_width: f.min + '..' + f.max + ' 범위로 입력해 주세요',
      theme: '선택지 중 하나를 골라 주세요',
      layout: '선택지 중 하나를 골라 주세요',
    };
    const errors = async value => page.eval(`(BriefPage.state.ui.answers['${id}'].fieldErrors=${JSON.stringify(value)},BriefPage.render(),true)`);
    await errors(longest); await check('range-errors');
    await capture(width, theme, surface, 'longest-error');
    const visibility = await page.eval(`(() => {
      const box=document.querySelector('[data-ans="${id}"]'),m=document.getElementById('main');
      const rgba=s=>{const c=s.match(/[\\d.]+/g).map(Number);return [c[0],c[1],c[2],c[3]??1]};
      const over=(a,b)=>a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3]));
      const lum=c=>c.map(x=>(x/=255)<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
      return {overflow:Math.max(m.scrollWidth-m.clientWidth,document.documentElement.scrollWidth-innerWidth),
        errors:[...box.querySelectorAll('.ans-err[role="alert"]')].map(e=>{
          const r=e.getBoundingClientRect(),style=getComputedStyle(e);
          const layers=[];for(let bg=e;bg;bg=bg.parentElement)layers.push(rgba(getComputedStyle(bg).backgroundColor));
          const background=layers.reverse().reduce((b,a)=>over(a,b),[255,255,255]);
          const a=lum(over(rgba(style.color),background)),b=lum(background),lines=[];
          const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);
          for(let text=walker.nextNode();text;text=walker.nextNode()){const range=document.createRange();range.selectNodeContents(text);lines.push(...range.getClientRects())}
          const control=box.querySelector('[aria-describedby~="'+e.id+'"]');
          return {text:e.textContent,lines:new Set(lines.map(l=>Math.round(l.top))).size,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),
            tied:!!control&&control.getAttribute('aria-invalid')==='true',
            clipped:e.scrollHeight>e.clientHeight+1||e.scrollWidth>e.clientWidth+1||lines.some(l=>l.bottom>r.bottom+1||l.right>r.right+1),
            hidden:style.visibility!=='visible'||style.display==='none'};
        })};
    })()`);
    if (visibility.overflow > 1 || visibility.errors.length !== 4 || visibility.errors.some(e => e.clipped || e.hidden || !e.tied || e.contrast < 4.5))
      issues.push(`${width}/${theme}: invalid error visibility ${JSON.stringify(visibility)}`);
    if (width === 390 && extreme && !visibility.errors.some(e => e.lines >= 2)) issues.push(`${width}/${theme}: missing multiline error case`);
    await errors({ ...longest, side_width: f.min + '부터 ' + f.step + ' 간격으로 입력해 주세요' });
    await check('step-error');
    await errors({ ...longest, name: '같은 입력 항목을 두 번 보낼 수 없어요' }); await check('duplicate-error');
    const twoLineError = await page.eval(`(() => {
      const e=document.querySelector('[data-ans="${id}"] .ans-err[role="alert"]'),tops=new Set(),walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);
      for(let text=walker.nextNode();text;text=walker.nextNode()){const r=document.createRange();r.selectNodeContents(text);for(const l of r.getClientRects())tops.add(Math.round(l.top))}
      return tops.size;
    })()`);
    if (width === 390 && twoLineError !== 2) issues.push(`${width}/${theme}: expected an explicit two-line error, saw ${twoLineError}`);
    await capture(width, theme, surface, 'duplicate-error');
    await errors({}); await check('cleared');
    const values = { name: '보드', side_width: f.min, theme: fields[2].options[0], layout: fields[3].options[0] };
    await page.eval(`(BriefPage.state.ui.answers['${id}'].values=${JSON.stringify(values)},BriefPage.render(),true)`);
    await click('ans-fields');
    const confirmed = await geometry();
    await errors(longest); await frame();
    const confirmedErrors = await geometry();
    const confirmMovement = Math.max(...confirmed.controls.map((a,i)=>Math.max(Math.abs(a.x-confirmedErrors.controls[i].x),Math.abs(a.y-confirmedErrors.controls[i].y))),
      ...confirmed.actions.map((a,i)=>Math.abs(a.y-confirmedErrors.actions[i].y)));
    if (confirmMovement > .5) issues.push(`${width}/${theme}/confirmed-errors: moved ${confirmMovement}px`);
    await capture(width, theme, surface, 'confirm-error', true);
    await errors({});
    await capture(width, theme, surface, 'cleared');
    results.geometry.push({ width, theme, extreme, fields, before, states, visibility, twoLineError, confirmed, confirmedErrors, confirmMovement });
  }
  results.geometryIssues = issues;
  assert.deepEqual(issues, [], 'inline errors must not move any control or action row');
}
const timer = setTimeout(() => { console.error('SELF_EXIT_TIMEOUT'); process.exit(124); }, 180000);
try {
  const { port } = await server.start(), url = `http://127.0.0.1:${port}/`;
  results.port = port;
  page = await launch({ width: 1440, height: 1000 });
  browserPids = [...new Set([page.pid, ...listProfilePids(page.profileDir)])];
  await geometryChecks(url);
  if (!layoutOnly) {
  for (const width of [1440, 1024, 390]) for (const theme of ['light', 'dark']) for (const surface of ['conversation', 'decisions', 'overview']) {
    await page.client.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
    await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390 });
    await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await ready(url);
    if (surface === 'decisions') await page.eval(`(BriefPage.open('owner','dec'),true)`);
    if (surface === 'overview') await page.eval('(BriefPage.state.ui.active=null,BriefPage.render(),true)');
    await capture(width, theme, surface, 'empty');
    await capture(width, theme, surface, 'empty', true);
    await type('name', '보드'); await capture(width, theme, surface, 'typing'); await capture(width, theme, surface, 'typing', true);
    await click('ans-fields'); await capture(width, theme, surface, 'invalid'); await capture(width, theme, surface, 'invalid', true); await layout(`${width}/${theme}/${surface}/invalid`);
    await fill(); await click('ans-fields');
    await capture(width, theme, surface, 'confirm'); await capture(width, theme, surface, 'confirm', true);
    for (const [field, change] of [['name', async () => {
      await type('name', '보드'); await key('Home', 'Home', 36); await key('ArrowRight', 'ArrowRight', 39);
      await page.client.send('Input.insertText', { text: '새' });
    }], ['side_width', () => type('side_width', 300)], ['theme', async () => {
      await focus(selector('theme') + '[value="밝게"]'); await key('ArrowRight', 'ArrowRight', 39);
    }], ['layout', async () => { await focus(selector('layout')); await key('Home', 'Home', 36); await key('ArrowDown', 'ArrowDown', 40); await key('Enter', 'Enter', 13); }]]) {
      await change();
      const focusProof = await page.eval(`({field:document.activeElement.getAttribute('data-field'),value:document.activeElement.value,caret:document.activeElement.selectionStart,
        confirmed:!!BriefPage.state.ui.answers['${id}'].confirm,send:!!document.querySelector('[data-ans="${id}"] [data-act="ans-send"]')})`);
      assert.equal(focusProof.field, field); assert.equal(focusProof.confirmed, false); assert.equal(focusProof.send, false);
      if (field === 'name') assert.equal(focusProof.caret, 2);
      if (field === 'theme') assert.equal(focusProof.value, '어둡게');
      results.keyboard.push({ width, theme, surface, ...focusProof });
      await fill(); await click('ans-fields');
    }
    await type('side_width', 999);
    assert.equal(await page.eval(`!!BriefPage.state.ui.answers['${id}'].confirm`), false);
    const refusal = await page.eval(`fetch('/answer',{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':'owned-field-test'},body:JSON.stringify({id:${id},sessionId:'owner',values:${JSON.stringify({ ...decisionValues(), side_width: 999 })}})}).then(async r=>({status:r.status,json:await r.json()}))`);
    assert.equal(refusal.status, 400); assert.equal(store.readRecord(`answers/${String(id).padStart(6, '0')}.json`), null);
    results.refusals.push({ id, ...refusal, answer: null, delivery: session.calls.filter(c => c.delivery_id === 'd' + id).length });
    await fill(); await click('ans-fields');
    await page.eval(`(() => {window.__fieldSent=new Promise((resolve,reject)=>{const t=setTimeout(()=>{m.disconnect();reject(new Error('send not settled'))},12000);const check=()=>{if(BriefPage.state.ui.answers['${id}'].phase==='sent'){clearTimeout(t);m.disconnect();resolve(true)}};const m=new MutationObserver(check);m.observe(document.documentElement,{subtree:true,childList:true});check()});return true})()`);
    await click('ans-send');
    await page.eval('window.__fieldSent');
    await capture(width, theme, surface, 'sent'); await capture(width, theme, surface, 'sent', true); await layout(`${width}/${theme}/${surface}/sent`);
    assert.deepEqual(store.readRecord(`answers/${String(id).padStart(6, '0')}.json`).values, decisionValues());
    assert.equal(session.calls.filter(c => c.delivery_id === 'd' + id).length, 1);
    if (surface === 'decisions') {
      vm = buildViewModel(store.readSnapshot(), now, { generation: 9 });
      vm.seq = id; vm.sessions[0].decisions = vm.sessions[0].decisions.filter(d => d.id === id);
      await page.goto(url + '?history=' + id);
      await page.eval(`(BriefPage.open('owner','dec'),true)`);
      const history = await page.eval(`document.querySelector('.cv-hist [data-label="내 답"]').textContent`);
      for (const value of Object.values(decisionValues())) assert.ok(history.includes(String(value)));
      await capture(width, theme, surface, 'history'); await capture(width, theme, surface, 'history', true);
    }
  }
  for (const width of [390, 320]) for (const theme of ['light', 'dark']) {
    await page.client.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: true });
    await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    const fields = decisionFields();
    fields.forEach(f => { f.label = '보안 검토와 운영 정책 및 유지 보수 계획의 요구사항 충족 여부'; });
    fields[0].maxLen = 200;
    fields[1] = { id: 'side_width', label: fields[1].label, kind: 'number', min: -Number.MAX_VALUE, max: Number.MAX_VALUE, step: Number.MAX_VALUE };
    fields[2].options = ['기존 운영 절차를 유지하고 보안 검토 후 안전하게 배포합니다.', '새 운영 절차를 작성해야 합니다.'];
    fields[3].options = ['기본', '넓은', '좁은', '자동', '두 칸', '한 칸'].map(prefix => prefix + ' 배치로 자료를 차례대로 보여 주세요');
    const valid = validateBrief({ title: '입력', status: 'needs_decision', headline: '확인', changes: [], done: [], next: '',
      decisions: [{ question: '범위', reason: '확인', blocks: false, fields }] });
    assert.equal(valid.ok, true, valid.errors.join('\n'));
    await ready(url, fields);
    await capture(width, theme, 'extremes', 'empty'); await layout(`${width}/${theme}/extremes`);
    await type('name', '아주긴경로'.repeat(40));
    await type('side_width', String(Number.MAX_VALUE));
    await focus(selector('theme')); await key(' ', 'Space', 32);
    await focus(selector('layout')); await key('End', 'End', 35); await key('Enter', 'Enter', 13);
    await click('ans-fields');
    assert.equal(await page.eval(`!!BriefPage.state.ui.answers['${id}'].confirm`), true);
    await capture(width, theme, 'extremes', 'confirm'); await capture(width, theme, 'extremes', 'confirm', true);
    await layout(`${width}/${theme}/extremes/confirm`);
  }
  }
} catch (err) { fatal = String(err.stack || err); console.error(err); }
finally {
  clearTimeout(timer);
  if (page) await page.close();
  await server.close(); await deliver.dispose();
  for (const pid of browserPids) results.cleanup[pid] = isPidAlive(pid) ? 'ALIVE' : 'gone';
  fs.rmSync(dir, { recursive: true, force: true });
  results.cleanup.tempRemoved = !fs.existsSync(dir);
  results.fatal = fatal;
  results.pass = !fatal && Object.values(results.cleanup).every(v => v === 'gone' || v === true);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(out, '..', 'refuse.json'), JSON.stringify(results.refusals, null, 2));
}
console.log(JSON.stringify({ pass: results.pass, captures: results.captures.length, keyboard: results.keyboard.length, cleanup: results.cleanup, fatal }));
process.exitCode = results.pass ? 0 : 1;
