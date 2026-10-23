// Task-owned real-browser acceptance for one board tab per Herdr window.
// usage: node scripts/qa-tabs.mjs --out <dir> [--legacy-open]
// No live state/profile; one Chrome per pass, disposed before the next pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageHtml } from '../src/render.mjs';
import { createServerHost } from '../src/server-host.mjs';
import { createBoardServer } from '../src/server.mjs';
import { launch, watchCsp, axSnapshot, unnamedInteractive, listProfilePids, isPidAlive } from './cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2), oi = argv.indexOf('--out');
assert.ok(oi >= 0 && argv[oi + 1], 'usage: node scripts/qa-tabs.mjs --out <dir> [--legacy-open]');
const OUT = path.resolve(argv[oi + 1]);
const NEGATIVE = argv.includes('--legacy-open');
const VISUAL_PROBE = argv.includes('--visual-probe');
const VISUAL_MUTATION = argv.includes('--visual-mutation');
const STATE_PROBE = argv.includes('--state-probe');
const R3_PROBE = argv.includes('--r3-probe');
const R3_EVIDENCE_PROBE = argv.includes('--r3-evidence-probe');
const R3_FOCUS_PROBE = argv.includes('--r3-focus-probe');
const historyIndex = argv.indexOf('--history-evidence');
const HISTORY_EVIDENCE = historyIndex >= 0;
const HISTORY_NEGATIVE = argv.includes('--history-negative');
const historyBaseline = HISTORY_EVIDENCE ? JSON.parse(fs.readFileSync(argv[historyIndex + 1], 'utf8')) : null;
const cssIndex = argv.indexOf('--r3-css');
const REVERT_CSS = cssIndex >= 0 ? fs.readFileSync(argv[cssIndex + 1], 'utf8') : '';
const CURRENT_SHELL_CSS = fs.readFileSync(path.join(ROOT, 'src/page/shell.css'), 'utf8');
const J = JSON.stringify;
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const GEN = 9, A = 'w:w4:t185', B = 'w:w4:t186', C = 'w:w4:t187';
const NOW = Date.parse('2026-10-23T04:00:00Z');
const PREFS = J({ tabs: ['a185', 'p185', 'b186', 'c187', 'standalone'], pinned: ['p185', 'c187'],
  active: 'p185', sub: { a185: 'plan', q185: 'plan', p185: 'dec' }, favs: ['q185'], seen: { p185: NOW - 1000 } });
const EXPECTED = [A, B, C, 'standalone'];
const results = {}, captures = [], sweeps = [], cleanup = [], exceptions = [];
const extras = [];
const started = new Date().toISOString();
const writeJson = (name, data) => fs.writeFileSync(path.join(OUT, name), J(data, null, 2) + '\n');
fs.mkdirSync(OUT, { recursive: true });
const productFiles = fs.readdirSync(path.join(ROOT, 'src/page')).filter(f => /\.(js|css)$/.test(f))
  .map(f => 'src/page/' + f).concat(['src/render.mjs', 'src/server-host.mjs', 'src/server.mjs']);
const sourceHashes = () => Object.fromEntries(productFiles.map(f => [f, sha(fs.readFileSync(path.join(ROOT, f)))]));
const frozen = sourceHashes();
const git = args => {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', env: { ...process.env, GIT_MASTER: '1' } });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const build = { head: git(['rev-parse', 'HEAD']), sourceHashes: frozen, sourceHash: sha(J(frozen)),
  qaScriptSha256: sha(fs.readFileSync(SELF)), generation: GEN, started };
build.buildId = sha(J(build)).slice(0, 24);
if (HISTORY_EVIDENCE) {
  assert.deepEqual(frozen, historyBaseline.build.sourceHashes, 'history supplement must use the frozen product');
  Object.assign(build, historyBaseline.build, { originalQaScriptSha256: historyBaseline.build.qaScriptSha256,
    qaScriptSha256: sha(fs.readFileSync(SELF)), evidenceStarted: started });
}

function historyFrameFailures(record) {
  const failures = [], surface = record.surface;
  const samples = [...surface.pairs, ...surface.icons, ...surface.edges].filter(s => s.selectedHistory);
  for (const kind of ['text', 'icon', 'control-edge']) {
    if (!samples.some(s => s.kind === kind)) failures.push('missing selected-history ' + kind);
  }
  if (samples.some(s => s.ratio + .01 < s.required)) failures.push('selected-history contrast');
  if (!record.state.geometry.wrapInert) failures.push('compact history must cover inert main');
  const native = record.state.native;
  if (!native?.visible || !native?.hit || !native?.peek) failures.push('visible hit-tested selected history required');
  if (native && record.state.phase !== 'native-tab-focus' && native.hover !== (record.state.phase !== 'rest-unfocused')) failures.push('actual hover state');
  if (native && native.active !== (record.state.phase === 'real-mouse-down')) failures.push('actual active state');
  return failures;
}

function session(patch) {
  return { id: 's', title: '대화', project: '탭 시험', cwd: 'C:/qa-tabs', alive: true, briefSeq: 1,
    status: 'in_progress', statusKey: 'in_progress', lastActivityAt: NOW - 1000,
    headline: '창마다 대화가 탭 하나에 모입니다', changes: [], done: [], notes: [], decisions: [], reports: [],
    answerKinds: ['annotation'], ...patch };
}
const plan = { planId: 'wp', rev: 1, goal: '같은 창의 대화를 한 탭에서 보기', stage: 'running',
  tasks: [{ id: '1', state: 'doing', label: '대화 연결 확인' }], questions: [] };
function fixture(seq = 1) {
  return { seq, gen: GEN, generatedAt: NOW, foldedKey: 'tabs-fold-1', sessions: [
    session({ id: 'a185', title: '현재 대화', tabId: 'w4:t185', tabLabel: '작업 창', tabNumber: 185,
      lastActivityAt: NOW, plan }),
    session({ id: 'q185', title: '두 번째 대화', tabId: 'w4:t185', tabLabel: '작업 창', tabNumber: 185,
      lastActivityAt: NOW - 2000, plan: { ...plan, planId: 'qp', ownerSessionId: 'a185' },
      planLink: { ownerId: 'a185', goal: plan.goal } }),
    session({ id: 'p185', title: '이전 결정 대화', tabId: 'w4:t185', tabLabel: '작업 창', tabNumber: 185,
      alive: false, status: 'done', statusKey: 'done', lastActivityAt: NOW - 4000,
      decisions: [{ id: 501, question: '다음 작업을 진행할까요?', createdAt: NOW - 4000,
        options: { A: { text: '진행', consequence: '다음 단계로 이동' }, B: { text: '보류', consequence: '여기서 기다림' } } }] }),
    session({ id: 'fold185', title: '접힌 이전 기록', tabId: 'w4:t185', alive: false, status: 'done', statusKey: 'done', reports: undefined,
      lastActivityAt: NOW - 5000, folded: { key: 'fold-card-1', reports: 3, decisions: 0 } }),
    session({ id: 'b186', title: '다른 창 대화', tabId: 'w4:t186', tabLabel: '다른 창', tabNumber: 186 }),
    session({ id: 'c187', title: '끝난 창 대화', tabId: 'w4:t187', alive: false, status: 'done', statusKey: 'done' }),
    session({ id: 'standalone', title: '독립 대화', alive: false, status: 'done', statusKey: 'done' }),
  ] };
}
function full(vm) {
  const m = structuredClone(vm), s = m.sessions.find(s => s.id === 'fold185');
  delete s.folded;
  s.reports = [1, 2, 3].map(id => ({ id, title: '기록 ' + id, at: NOW - 5000,
    summary: '접힌 기록의 전체 보고서 ' + id, blocks: [{ type: 'text', text: '전체 기록 ' + id }] }));
  return m;
}
function processIdentity(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
function gate() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.Name -match '^(node|chrome|bun)\\.exe$' -and $_.CommandLine -match 'piomo-briefing' -and $_.CommandLine -match '--test|qa-|remote-debugging' } | Select ProcessId,CommandLine | ConvertTo-Json -Compress`],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '', 'foreign heavy board QA: ' + r.stdout);
}
async function scenario(mode, name, fn) {
  const key = mode + '/' + name;
  try { const evidence = await fn(); results[key] = { pass: true, ...evidence }; console.log('PASS ' + key); }
  catch (error) { results[key] = { pass: false, error: error.stack }; console.error('FAIL ' + key + ': ' + error.message); }
}
async function settled(page) {
  return page.eval(`(async () => {
    await document.fonts.ready;
    const receipt=[];
    let timer;
    const completion=(async()=>{
      for(let round=0;round<8;round++){
        void document.documentElement.offsetWidth;
        const live=document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getComputedTiming().iterations!==Infinity);
        if(!live.length)return {rounds:round,animations:receipt,remaining:0,sideOpacity:getComputedStyle(document.querySelector('.sh-side')).opacity};
        for(const a of live)receipt.push({id:a.id,type:a.constructor.name,target:a.effect?.target?.className,duration:a.effect?.getComputedTiming().duration});
        await Promise.all(live.map(a=>a.finished.catch(()=>({cancelled:true}))));
      }
      throw new Error('animations did not settle after 8 completion waves');
    })();
    try{return await Promise.race([completion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('animation completion timeout')),12000)})])}
    finally{clearTimeout(timer)}
  })()`);
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' did not signal within 12s')), 12000);
    })]);
  } finally { clearTimeout(timer); }
}
async function setViewport(page, width, height, theme, motion = 'reduce') {
  const mobile = width === 390;
  await page.client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  await page.client.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: motion }] });
  return settled(page);
}
async function visualMeasure(page) {
  await settled(page);
  const geometry = await page.eval(`(() => {
    const b=document.querySelector('.cv-prevgo'),line=document.querySelector('.cv-prevline'),t=document.querySelector('#tabs [data-tab="${A}"]'),title=t.querySelector('.tt');
    const r=b.getBoundingClientRect(),tr=title.getBoundingClientRect();
    return {target:{width:r.width,height:r.height},point:{x:r.x+r.width/2,y:r.y+r.height/2},
      lineFont:parseFloat(getComputedStyle(line).fontSize),buttonFont:parseFloat(getComputedStyle(b).fontSize),
      title:{width:tr.width,text:title.textContent,pin:!!t.querySelector('.tb-pin'),bell:t.querySelector('.sh-bdg')?.textContent}};
  })()`);
  const state = () => page.eval(`(() => {const e=document.querySelector('.cv-prevgo'),s=getComputedStyle(e);return {background:s.backgroundColor,shadow:s.boxShadow,color:s.color,active:e.matches(':active')}})()`);
  await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'none' });
  await settled(page);
  geometry.rest = await state();
  await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...geometry.point, button: 'none' });
  await settled(page);
  geometry.hover = await state();
  await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...geometry.point, button: 'left', clickCount: 1 });
  geometry.pressed = await state();
  await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'left', buttons: 1 });
  await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 });
  await settled(page);
  return geometry;
}
async function tabGeometry(page) {
  return page.eval(`(() => {
    const tab=document.querySelector('#tabs .tb.on'),title=tab.querySelector('.tt'),rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,width:r.width,height:r.height}};
    const box=rect(tab),t=rect(title),range=document.createRange();range.selectNodeContents(title);
    const glyph=range.getBoundingClientRect(),children=[...tab.querySelector('.tb-go').children,tab.querySelector('.tb-x')].filter(Boolean).map(e=>({classes:e.className,...rect(e)}));
    const overlap=[];for(let i=0;i<children.length;i++)for(let j=i+1;j<children.length;j++){const a=children[i],b=children[j];if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>1)overlap.push([a.classes,b.classes])}
    return {box,title:t,text:title.textContent,glyphWidth:glyph.width,children,overlap,
      contained:children.every(r=>r.x>=box.x-1&&r.right<=box.right+1),readable:t.width>=100&&glyph.width<=t.width+1};
  })()`);
}
const paintInit = '(' + function () {
  const p = window.__r3Paint = { timeOrigin: performance.timeOrigin, frames: [], paints: [], shifts: [], stop: false };
  const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
  new PerformanceObserver(list => { for (const e of list.getEntries()) p.paints.push({ name:e.name,time:e.startTime }); }).observe({ type:'paint',buffered:true });
  new PerformanceObserver(list => { for (const e of list.getEntries()) p.shifts.push({ time:e.startTime,value:e.value,hadRecentInput:e.hadRecentInput,
    changedSurface:e.sources.some(s => { const n=s.node?.nodeType===1?s.node:s.node?.parentElement; return !!n?.closest('#tabs,.cv-prevline'); }) }); }).observe({ type:'layout-shift',buffered:true });
  p.done = new Promise(resolve => {
    function frame(time) {
      const tab=document.querySelector('#tabs .tb.on'),notice=document.querySelector('.cv-prevline'),main=document.querySelector('#main .cv-page');
      if(tab&&main)p.frames.push({time,tabs:[...document.querySelectorAll('#tabs .tb')].map(e=>e.dataset.tab),tab:box(tab),notice:box(notice),noticeText:notice?.textContent});
      if(p.stop&&p.paints.some(e=>e.name==='first-contentful-paint'))resolve(true);else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}.toString() + ')()';
const init = `(() => {
  if (!/^(file:|https?:)$/.test(location.protocol)) return;
  const old = localStorage.getItem('omo-briefing.ui.v1');
  window.__seed = { v2Existed: localStorage.getItem('omo-briefing.ui.v2') !== null, v1Before: old };
  if (old === null) localStorage.setItem('omo-briefing.ui.v1', ${J(PREFS)});
  window.__applied = {}; window.__waiters = [];
  document.addEventListener('DOMContentLoaded', () => {
    BriefPage.hooks.afterApply.push(model => {
      window.__applied[model.seq] = Date.now();
      const keep = [];
      for (const w of window.__waiters) { if (model.seq >= w.seq) w.resolve(model.seq); else keep.push(w); }
      window.__waiters = keep;
    });
    ${NEGATIVE ? `const reduce = BriefShell.reduce;
    BriefShell.reduce = function(st, action) {
      const next = reduce(st, action);
      if (action.type !== 'open' || action.sid !== 'p185') return next;
      return Object.assign({}, next, { tabs: next.tabs.includes(action.sid) ? next.tabs : next.tabs.concat(action.sid), active: action.sid });
    };` : ''}
  });
})();`;

async function pass(mode) {
  gate();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-qa-tabs-'));
  let model = fixture(), host, page, csp, url;
  /** @type {{mode:string, hold:Promise<void>|null, requested:(()=>void)|null, release:(()=>void)|null}} */
  const fault = { mode: '', hold: null, requested: null, release: null };
  const receipt = { mode, cwd: ROOT, started: new Date().toISOString(), tmp, executor: processIdentity(process.pid) };
  try {
    const publishFile = () => fs.writeFileSync(path.join(tmp, 'data.js'),
      'window.__briefData && window.__briefData(' + J(model).replace(/</g, '\\u003c') + ');');
    fs.writeFileSync(path.join(tmp, 'folded.js'), 'window.__briefFolded && window.__briefFolded(' +
      J({ schema: 1, gen: GEN, key: model.foldedKey, sessions: { fold185: full(model).sessions.find(s => s.id === 'fold185') } }) + ');');
    if (mode === 'file') {
      fs.writeFileSync(path.join(tmp, 'index.html'), pageHtml(model, GEN, { mode: 'file' }));
      publishFile();
      url = pathToFileURL(path.join(tmp, 'index.html')).href;
      if (HISTORY_EVIDENCE) assert.equal(sha(fs.readFileSync(path.join(tmp, 'index.html'))), build.fileHtmlSha256,
        'targeted history fixture must match the original rendered product bytes');
      build.fileHtmlSha256 = sha(fs.readFileSync(path.join(tmp, 'index.html')));
    } else {
      host = createServerHost({ stateDir: tmp, sessionId: 'qa-tabs', generation: GEN,
        installedGeneration: async () => null, isEnabled: () => true,
        readSnapshot: () => ({ published: { seq: model.seq } }),
        buildViewModel: () => structuredClone(model), buildFull: () => full(model),
        project: () => structuredClone(model),
        getPage: (vm, token, nonce) => pageHtml(vm, GEN, { mode: 'server', token, nonce }),
        answer: () => ({ status: 500, json: { ok: false, code: 'QA_NO_WRITE' } }),
        focus: () => ({ status: 500, json: { ok: false, code: 'QA_NO_WRITE' } }),
        env: { OMO_BRIEFING_PORT_BASE: '49130' }, now: () => NOW,
        createBoardServer: asyncBoardFactory,
        onError: (key, e) => { if (!/aborted|ECONNRESET|EPIPE/.test(e.message)) exceptions.push({ mode, key, error: e.message }); } });
      const address = await host.ensure();
      assert.ok(address?.url, 'host must bind a free port in 49130-49139');
      url = address.url;
      assert.ok(new URL(url).port >= 49130 && new URL(url).port <= 49139);
      build.serverUrl = url;
    }
    page = await launch({ width: 1440, height: 900 });
    receipt.chrome = { pid: page.pid, profileDir: page.profileDir, identity: processIdentity(page.pid) };
    csp = await watchCsp(page); // Before any navigation, including the seeded document.
    await page.addInitScript(init);
    if (!HISTORY_EVIDENCE) await page.addInitScript(paintInit);
    page.client.listeners.set('Runtime.exceptionThrown', [p => exceptions.push({ mode, exception: p.exceptionDetails })]);
    const ev = expr => page.eval(expr);
    const click = async selector => assert.equal(await ev(`(() => { const e=document.querySelector(${J(selector)}); if(!e)return false; e.click(); return true; })()`), true, 'missing click target ' + selector);
    const realClick = async selector => {
      const p = await ev(`(()=>{const e=document.querySelector(${J(selector)});if(!e)throw new Error('missing input target');e.scrollIntoView({block:'nearest',inline:'nearest'});
        const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,inside:h===e||e.contains(h)}})()`);
      assert.equal(p.inside, true, selector + ': real pointer hit');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await page.client.send('Input.dispatchMouseEvent', { type, x:p.x, y:p.y, button:type==='mouseMoved'?'none':'left', clickCount:type==='mouseMoved'?0:1 });
      return p;
    };
    const midpointOpen = async (normal = false) => {
      await ev(`(() => {document.addEventListener('click',function hit(){
        void document.documentElement.offsetWidth;const a=document.getAnimations().find(a=>${normal ? "a.transitionProperty==='margin-left'" : "a.id==='sh-xfade'"}&&a.effect?.target?.classList.contains('sh-side'));
        if(!a)throw new Error('missing input-triggered native sidebar animation');a.pause();a.currentTime=Number(a.effect.getTiming().duration)/2;window.__r3Animation=a;
        window.__r3Mid={time:a.currentTime,duration:a.effect.getTiming().duration,playState:a.playState,opacity:getComputedStyle(a.effect.target).opacity};
      },{once:true});return true})()`);
      await realClick('#tabs .sh-topen');
      return ev('window.__r3Mid');
    };
    const key = async (name, modifiers = 0) => {
      const vk=name==='Tab'?9:name==='Escape'?27:13;
      for(const type of ['keyDown','keyUp'])await page.client.send('Input.dispatchKeyEvent',{type,key:name,code:name,windowsVirtualKeyCode:vk,modifiers});
    };
    const finishPaint = async label => {
      await settled(page);
      const p = await ev(`(async()=>{__r3Paint.stop=true;let timer;try{await Promise.race([__r3Paint.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('first paint timeout')),12000)})])}finally{clearTimeout(timer)}
        return {timeOrigin:__r3Paint.timeOrigin,frames:__r3Paint.frames,paints:__r3Paint.paints,shifts:__r3Paint.shifts}})()`);
      writeJson(`${mode}-${label}-paint.json`,p);
      assert.ok(p.paints.some(e=>e.name==='first-contentful-paint')&&p.frames.length>0,label+': observed FCP and meaningful frame');
      const first=p.frames[0],last=p.frames.at(-1);
      assert.ok(p.frames.every(f=>J(f.tabs)===J(first.tabs)&&!!f.notice===!!first.notice&&
        ['x','y','width','height'].every(k=>Math.abs(f.tab[k]-last.tab[k])<1)),label+': changed tab geometry/notice stable from first meaningful frame');
      assert.deepEqual(p.shifts.filter(s=>s.changedSurface&&!s.hadRecentInput),[],label+': changed-surface layout shift');
      return p;
    };
    const waitDom = expr => ev(`new Promise((resolve,reject) => {
      let timer; const obs=new MutationObserver(check);
      function end(fn,x){obs.disconnect();clearTimeout(timer);fn(x)}
      function check(){try{if((${expr}))end(resolve,true)}catch(e){end(reject,e)}}
      obs.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
      timer=setTimeout(()=>end(reject,new Error('DOM condition timeout: '+${J(expr)})),12000);check();
    })`);
    const armApplied = seq => ev(`(() => { window.__nextApplied = new Promise((resolve,reject) => {
      const hit=Object.keys(__applied).map(Number).find(n=>n>=${seq});
      if(hit!==undefined)return resolve(hit);
      const w={seq:${seq},resolve:n=>{clearTimeout(timer);resolve(n)}};
      const timer=setTimeout(()=>{__waiters=__waiters.filter(x=>x!==w);reject(new Error('applied ${seq} timeout'))},12000);
      __waiters.push(w);
    }); window.__nextApplied.catch(()=>{}); return true; })()`);
    const applied = () => ev('window.__nextApplied');
    const info = () => ev(`(() => { const u=BriefPage.state.ui; return {
      tabs:u.tabs,pinned:u.pinned,active:u.active,shown:BriefShell.shownOf(u,u.active),sub:u.sub,
      page:document.querySelector('#main .cv-page')?.getAttribute('data-sid'),
      rows:[...document.querySelectorAll('#side .sh-row')].map(e=>({sid:e.getAttribute('data-row')||e.querySelector('[data-sh="open"]')?.getAttribute('data-sid'),
      kid:e.classList.contains('sh-kid'),prev:e.classList.contains('sh-prev'),selected:e.classList.contains('sel')})) }; })()`);
    const verify = async (sid, sub) => {
      await waitDom(`document.querySelector('#main .cv-page[data-sid="${sid}"]') !== null`);
      const v = await info();
      assert.deepEqual(v.tabs, EXPECTED, 'tab count and opening order');
      assert.equal(v.active, sid === 'standalone' ? sid : sid === 'b186' ? B : sid === 'c187' ? C : A);
      assert.equal(v.shown, sid); assert.equal(v.page, sid);
      if (sub) assert.equal(v.sub[sid], sub, 'selected sub page');
      for (const row of v.rows) {
        const should = row.sid === sid && (!row.kid || row.prev);
        assert.equal(row.selected, should, 'only shown rows carry sel: ' + J(row));
      }
      return v;
    };
    const view = key => click(`#rail [data-sh="view"][data-key="${key}"]`);
    const expand = async sid => {
      const sel = `#side [data-sh="expand"][data-sid="${sid}"]`;
      if (await ev(`document.querySelector(${J(sel)})?.getAttribute('aria-expanded') !== 'true'`)) await click(sel);
    };
    const previous = async sid => {
      await view('conv'); await expand('a185');
      await click(`#side .sh-prev [data-sh="open"][data-sid="${sid}"]`);
    };
    const open = (sid, sub = 'ov') => ev(`BriefPage.open(${J(sid)},${J(sub)}); true`);
    const publish = async next => {
      await armApplied(next.seq); model = next;
      if (mode === 'file') publishFile(); else await host.notifyPublished();
      await applied();
    };
    const reload = async () => {
      if (mode === 'file') fs.writeFileSync(path.join(tmp, 'index.html'), pageHtml(model, GEN, { mode: 'file' }));
      await page.goto(url); await waitDom(`BriefPage.state.model?.seq === ${model.seq}`);
    };
    function asyncBoardFactory(options) {
      const get = options.getConvo;
      options.getConvo = async sid => {
        if (fault.requested) { fault.requested(); fault.requested = null; }
        if (fault.hold) await fault.hold;
        if (fault.mode === 'error') return { schema: 2 };
        if (fault.mode === 'restart') return null;
        return get(sid);
      };
      return createBoardServer(options);
    }
    const screenshotState = async (name, width, height, theme, state = {}, finish = true) => {
      const animation = finish ? await settled(page) : await ev(`({phase:'controlled-midpoint',animations:document.getAnimations().map(a=>({id:a.id,currentTime:a.currentTime,timing:a.effect?.getComputedTiming()}))})`);
      const measured = await info();
      const surface = await surfaceSweep(page, width, theme);
      assert.ok(Object.values(surface.negativeControls).every(Boolean), name + ': class negative controls must detect injected defects');
      const ax = await axSnapshot(page);
      assert.deepEqual(unnamedInteractive(ax.raw.nodes), [], name + ': unnamed AX control');
      const file = path.join(OUT, name + '.png');
      await page.screenshot(file);
      const bytes = fs.readFileSync(file), dpr = width === 390 ? 3 : 1;
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), width * dpr); assert.equal(bytes.readUInt32BE(20), height * dpr);
      assert.ok(bytes.length > 10000, name + ': fully rendered frame');
      const geometry = await ev(`(() => {const r=e=>{if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom}};
        const main=document.querySelector('#main'),list=document.querySelector('.sh-scroll');
        return {main:{top:main.scrollTop,max:main.scrollHeight-main.clientHeight},sidebar:{top:list.scrollTop,max:list.scrollHeight-list.clientHeight},
          sideOpacity:getComputedStyle(document.querySelector('.sh-side')).opacity,wrapInert:document.querySelector('.sh-wrap').inert,
          tabs:r(document.querySelector('#tabs')),side:r(document.querySelector('#side')),line:r(document.querySelector('.cv-prevline')),zoom:getComputedStyle(document.documentElement).zoom,
          focus:document.activeElement?{tag:document.activeElement.tagName,id:document.activeElement.id,classes:document.activeElement.className,action:document.activeElement.getAttribute('data-sh'),sid:document.activeElement.getAttribute('data-sid')}:null,documentOverflow:document.documentElement.scrollWidth>innerWidth}})()`);
      const record = { page: 'board', mode, view: name, viewport: { width, height, dpr, mobile: width === 390 },
        theme, state: { ...state, measured, geometry, animation }, file, bytes: bytes.length, sha256: sha(bytes),
        buildId: build.buildId, servedUrl: url, fixtureSha256: sha(J(model)), ax: { unnamed: 0,
          returnName: ax.raw.nodes.filter(n => !n.ignored && n.role?.value === 'button' && n.name?.value === '지금 대화로').length },
        surface };
      extras.push(record);
      if (finish) assert.deepEqual(surface.changedContrastFailures, [], name + ': changed-surface contrast');
      assert.deepEqual(surface.changedContrastFailures.filter(m=>m.selectedHistory), [], name + ': selected history contrast at every phase');
      if (state.control === 'history' && width === 390) assert.deepEqual(historyFrameFailures(record), [], name + ': visible history state');
      return record;
    };
    const historySelector = '#side .sh-prev.sel [data-sh="open"][data-sid="p185"]';
    const historyNative = () => ev(`(() => {
      const e=document.querySelector(${J(historySelector)}),r=e.getBoundingClientRect(),s=getComputedStyle(e),row=e.closest('.sh-row'),rs=getComputedStyle(row);
      const x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);
      return {visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!e.closest('[inert]')&&r.top>=0&&r.bottom<=innerHeight,
        hit:h===e||e.contains(h),hitTarget:{tag:h?.tagName,classes:h?.getAttribute('class'),sid:h?.closest('[data-sid]')?.getAttribute('data-sid')},
        peek:BriefPage.state.ui.peek,hover:e.matches(':hover'),active:e.matches(':active'),focused:document.activeElement===e,focusVisible:e.matches(':focus-visible'),
        point:{x,y},rect:{x:r.x,y:r.y,width:r.width,height:r.height},
        style:{background:s.backgroundColor,shadow:s.boxShadow,outline:s.outline,transitionDuration:s.transitionDuration,rowBackground:rs.backgroundColor,rowShadow:rs.boxShadow}};
    })()`);
    const historyRest = async () => {
      if (!await ev('BriefPage.state.ui.peek')) { await realClick('#tabs .sh-topen'); await settled(page); }
      await ev(`document.activeElement?.blur();getSelection()?.removeAllRanges();document.querySelector(${J(historySelector)}).scrollIntoView({block:'nearest'});true`);
      // Leaving the panel invokes the product's inherited mouseout/unpeek path.
      // A neutral point inside its header keeps the real rest state visible.
      const neutral = await ev(`(()=>{const r=document.querySelector('#side .sh-head').getBoundingClientRect();return{x:r.x+8,y:r.y+8}})()`);
      await page.client.send('Input.dispatchMouseEvent', { type:'mouseMoved', ...neutral, button:'none' });
      await settled(page);
      const native = await historyNative();
      assert.ok(native.visible && native.hit && native.peek && !native.hover && !native.active, 'visible unfocused history rest');
      return native;
    };
    async function historyEvidence() {
      for (const theme of ['light', 'dark']) {
        await setViewport(page,390,844,theme); await previous('p185'); await settled(page);
        const rest = await historyRest();
        await screenshotState(`file-history-rest-390-${theme}`,390,844,theme,
          {kind:'changed-control-feedback',control:'history',phase:'rest-unfocused',native:rest});
        await page.client.send('Input.dispatchMouseEvent',{type:'mouseMoved',...rest.point,button:'none'});
        const hover = await historyNative();
        await screenshotState(`file-history-hover-390-${theme}`,390,844,theme,
          {kind:'changed-control-feedback',control:'history',phase:'hover-unfocused',native:hover});
        // Observe the exact trusted target event and its first animation-frame
        // style before dispatching pointer-down. The following frame bounds
        // that first frame's paint opportunity; no timer or settled-state proxy.
        await ev(`(()=>{const e=document.querySelector(${J(historySelector)}),style=()=>{const s=getComputedStyle(e);return{background:s.backgroundColor,shadow:s.boxShadow,transitionDuration:s.transitionDuration,active:e.matches(':active'),hover:e.matches(':hover')}};
          window.__historyAck=new Promise(resolve=>e.addEventListener('pointerdown',event=>{
            const input={trusted:event.isTrusted,timeStamp:event.timeStamp,now:performance.now(),target:event.target.closest('[data-sid]')?.getAttribute('data-sid'),button:event.button};
            const duringEvent=style();
            requestAnimationFrame(time=>{const first={time,now:performance.now(),...style()};
              requestAnimationFrame(next=>resolve({input,duringEvent,first,nextFrame:next,frameCountToAcknowledgement:1}))});
          },{once:true}));return true})()`);
        await page.client.send('Input.dispatchMouseEvent',{type:'mousePressed',...hover.point,button:'left',clickCount:1});
        const ack = await bounded(ev('__historyAck'),'history pointer first frame');
        const pressed = await historyNative();
        assert.equal(ack.input.trusted,true); assert.equal(ack.input.target,'p185'); assert.equal(ack.input.button,0);
        assert.equal(ack.duringEvent.active,true); assert.equal(ack.first.active,true);
        assert.ok(ack.first.background !== hover.style.background || ack.first.shadow !== hover.style.shadow, 'first frame acknowledges press versus hover');
        assert.ok(ack.first.background !== rest.style.background || ack.first.shadow !== rest.style.shadow, 'first frame acknowledges press versus rest');
        assert.equal(ack.first.background,pressed.style.background); assert.equal(ack.first.shadow,pressed.style.shadow);
        await screenshotState(`file-history-pressed-390-${theme}`,390,844,theme,
          {kind:'changed-control-feedback',control:'history',phase:'real-mouse-down',native:pressed,ack,restStyle:rest.style,hoverStyle:hover.style});
        await page.client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...pressed.point,button:'left',clickCount:1});
        await settled(page);
        if(await ev('BriefPage.state.ui.peek')) { await key('Escape'); await settled(page); }
      }
      assert.equal(extras.length,6);
      writeJson('history-state-index.json',{build,count:extras.length,records:extras,manifestHash:sha(J(extras)),
        supersedesViews:extras.map(r=>r.view),originalIndexSha256:sha(fs.readFileSync(argv[historyIndex+1]))});
      return {frames:extras.length};
    }
    async function additionalStates() {
      const records = [];
      const snap = async (...args) => { const r = await screenshotState(...args); records.push(r.view); return r; };
      for (const theme of ['light', 'dark']) {
        await setViewport(page, 1440, 900, theme);
        for (const sub of ['ov', 'plan', 'wk', 'dec', 'rep']) {
          await open('p185', sub);
          await snap(`${mode}-panel-${sub}-1440-${theme}`, 1440, 900, theme, { kind: 'previous-line-sibling', sub });
        }
        if (mode === 'server') {
          await setViewport(page, 390, 844, theme); await open('p185', 'dec');
          await snap(`server-prevline-390-${theme}`, 390, 844, theme, { kind: 'server-visual' });
        }
      }
      if (mode === 'file') {
        for (const theme of ['light', 'dark']) {
          await setViewport(page, 1920, 1080, theme); await open('p185', 'dec');
          await snap(`wide-1920-${theme}`, 1920, 1080, theme, { kind: '1920' });
          for (const width of [1440, 390]) {
            const height = width === 390 ? 844 : 900;
            await setViewport(page, width, height, theme);
            for (const [kind, label] of [['empty', ''], ['long', '여러 작업을 이어서 확인하는 아주 긴 작업 창 이름'], ['unbroken', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(5)]]) {
              const next = fixture(model.seq + 1);
              next.sessions[0].tabLabel = label; next.sessions[0].title = label;
              await publish(next); await open('p185', 'dec'); await settled(page);
              const shot = await snap(`label-${kind}-${width}-${theme}`, width, height, theme, { kind: 'adversarial-label', labelKind: kind });
              assert.equal(shot.state.geometry.documentOverflow, false);
            }
            await publish(fixture(model.seq + 1)); await open('p185', 'dec');
            await ev('document.documentElement.style.zoom="2";true');
            await snap(`zoom-200-${width}-${theme}`, width, height, theme, { kind: 'actual-css-zoom', zoom: 2 });
            if (width === 390) {
              await ev(`(() => {const bar=document.querySelector('#tabs'),title=document.querySelector('#tabs [data-tab="${A}"] .tt'),
                toggle=document.querySelector('#tabs .sh-topen'),t=title.getBoundingClientRect(),edge=toggle.getBoundingClientRect().right;
                bar.scrollLeft+=(t.x-edge-8)/2;return true})()`);
              await snap(`zoom-200-title-pan-390-${theme}`, width, height, theme, { kind: 'actual-css-zoom-document-pan', zoom: 2,
                explanation: 'The inherited document strip scrolls horizontally; pan exposes the real unchanged-width title, not a clipped-glyph substitute.' });
              await ev('document.querySelector("#tabs").scrollLeft=0;true');
            }
            await ev('document.documentElement.style.zoom="1";document.documentElement.style.setProperty("--fs-base","24px");true');
            await snap(`large-text-${width}-${theme}`, width, height, theme, { kind: 'large-text', baseFont: 24 });
            await ev('document.documentElement.style.removeProperty("--fs-base");true');
          }
          await setViewport(page, 390, 844, theme);
          await page.client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 24, right: 0, bottom: 34, left: 0 } });
          await open('p185', 'dec');
          const safeMain = await snap(`safe-area-main-390-${theme}`, 390, 844, theme, { kind: 'nonzero-safe-area', insets: { top: 24, bottom: 34 } });
          assert.ok(safeMain.state.geometry.tabs.y >= 24 && safeMain.state.geometry.line.y >= 24);
          await view('conv'); await expand('a185');
          if (!await ev('BriefPage.state.ui.peek')) await click('#tabs .sh-topen');
          const safeSide = await snap(`safe-area-sidebar-390-${theme}`, 390, 844, theme, { kind: 'nonzero-safe-area-sidebar', insets: { top: 24, bottom: 34 } });
          assert.ok(safeSide.state.geometry.side.y >= 24 && safeSide.state.geometry.side.bottom <= 810);
          assert.equal(safeSide.state.geometry.sideOpacity, '1');
          await page.client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, right: 0, bottom: 0, left: 0 } });
          if (await ev('BriefPage.state.ui.peek')) await click('#side .sh-head [data-sh="toggleSide"]');
          const long = fixture(model.seq + 1), p = long.sessions.find(s => s.id === 'p185');
          p.reports = Array.from({ length: 16 }, (_, i) => ({ id: 'r' + i, title: '이전 대화 전체 기록 ' + (i + 1), summary: '스크롤 끝에서도 탭과 내용의 경계를 확인합니다.', at: NOW }));
          for (let i = 0; i < 12; i++) long.sessions.push(session({ id: 'history-' + i, tabId: 'w4:t185',
            alive: false, title: '이어지는 이전 대화 ' + i, lastActivityAt: NOW - 10000 - i }));
          await publish(long); await open('p185', 'rep');
          await ev('document.querySelector("#main").scrollTop=document.querySelector("#main").scrollHeight;true');
          const mainEnd = await snap(`scroll-end-main-390-${theme}`, 390, 844, theme, { kind: 'main-scroll-end' });
          assert.ok(mainEnd.state.geometry.main.max > 0 && Math.abs(mainEnd.state.geometry.main.top - mainEnd.state.geometry.main.max) <= 1);
          await view('conv'); await expand('a185');
          if (!await ev('BriefPage.state.ui.peek')) await click('#tabs .sh-topen');
          await ev('document.querySelector(".sh-scroll").scrollTop=document.querySelector(".sh-scroll").scrollHeight;true');
          const sideEnd = await snap(`scroll-end-sidebar-390-${theme}`, 390, 844, theme, { kind: 'sidebar-scroll-end' });
          assert.ok(sideEnd.state.geometry.sidebar.max > 0 && Math.abs(sideEnd.state.geometry.sidebar.top - sideEnd.state.geometry.sidebar.max) <= 1);
          if (await ev('BriefPage.state.ui.peek')) await click('#side .sh-head [data-sh="toggleSide"]');
          await publish(fixture(model.seq + 1)); await open('p185', 'dec');
        }
        for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
          const height = width === 390 ? 844 : 900;
          await setViewport(page, width, height, theme); await open('p185', 'dec'); await settled(page);
          await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'none' });
          await snap(`return-rest-${width}-${theme}`, width, height, theme, { kind: 'return-feedback', phase: 'rest' });
          const point = await ev('(()=>{const r=document.querySelector(".cv-prevgo").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
          await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' });
          const hoverShot = await snap(`return-hover-${width}-${theme}`, width, height, theme, { kind: 'return-feedback', phase: 'hover' });
          await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
          const pressShot = await snap(`return-pressed-${width}-${theme}`, width, height, theme, { kind: 'return-feedback', phase: 'pressed' });
          assert.notEqual(pressShot.sha256, hoverShot.sha256, 'pressed must visibly differ');
          await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'left', buttons: 1 });
          await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 });
          await ev('document.querySelector(".cv-prevgo").focus();true');
          for (const modifiers of [8, 0]) {
            await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
            await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
          }
          assert.equal(await ev('document.querySelector(".cv-prevgo").matches(":focus-visible")'), true);
          await ev('document.querySelector("#tabs").scrollLeft=0;true');
          await snap(`return-focus-${width}-${theme}`, width, height, theme, { kind: 'return-feedback', phase: 'focus-visible' });
        }
        for (const theme of ['light', 'dark']) {
          await setViewport(page, 390, 844, theme); await open('p185', 'dec'); await view('conv'); await expand('a185');
          if (await ev('BriefPage.state.ui.peek')) await click('#side .sh-head [data-sh="toggleSide"]');
          await snap(`drawer-before-390-${theme}`, 390, 844, theme, { kind: 'reduced-motion-transition', phase: 'before' });
          await click('#tabs .sh-topen');
          const mid = await ev(`(() => {const a=document.getAnimations().find(a=>a.id==='sh-xfade'&&a.effect?.target?.classList.contains('sh-side'));
            if(!a)throw new Error('native reduced-motion drawer animation missing');a.pause();a.currentTime=Number(a.effect.getTiming().duration)/2;window.__qaMidAnimation=a;
            return {time:a.currentTime,duration:a.effect.getTiming().duration,opacity:getComputedStyle(a.effect.target).opacity}})()`);
          await snap(`drawer-mid-390-${theme}`, 390, 844, theme, { kind: 'reduced-motion-transition', phase: 'native-animation-midpoint', mid }, false);
          await ev('window.__qaMidAnimation.play();true');
          const after = await snap(`drawer-settled-390-${theme}`, 390, 844, theme, { kind: 'reduced-motion-transition', phase: 'settled' });
          assert.equal(after.state.geometry.sideOpacity, '1'); assert.equal(after.state.geometry.wrapInert, true);
          await click('#side .sh-head [data-sh="toggleSide"]'); await settled(page);
          await click('#tabs .sh-topen');
          await ev(`(() => {const a=document.getAnimations().find(a=>a.id==='sh-xfade'&&a.effect?.target?.classList.contains('sh-side'));a.pause();a.currentTime=Number(a.effect.getTiming().duration)/2;a.play();return true})()`);
          await click('#side .sh-head [data-sh="toggleSide"]');
          await snap(`drawer-interrupted-390-${theme}`, 390, 844, theme, { kind: 'reduced-motion-interruption', phase: 'closed-after-midpoint-input' });
        }
        for (const theme of ['light', 'dark']) {
          await setViewport(page, 1440, 900, theme, 'no-preference');
          await view('conv'); await open('p185', 'dec');
          if (await ev('BriefPage.state.ui.sideOpen')) await click('#side .sh-head [data-sh="toggleSide"]');
          await snap(`drawer-normal-before-1440-${theme}`, 1440, 900, theme, { kind: 'normal-motion-transition', phase: 'closed' });
          await click('#tabs .sh-topen');
          const mid = await ev(`(() => {void document.documentElement.offsetWidth;const a=document.getAnimations().find(a=>a.transitionProperty==='margin-left'&&a.effect?.target?.classList.contains('sh-side'));
            if(!a)throw new Error('native margin-left transition missing');a.pause();a.currentTime=Number(a.effect.getTiming().duration)/2;window.__qaNormalAnimation=a;
            return {time:a.currentTime,duration:a.effect.getTiming().duration,margin:getComputedStyle(a.effect.target).marginLeft}})()`);
          await snap(`drawer-normal-mid-1440-${theme}`, 1440, 900, theme, { kind: 'normal-motion-transition', phase: 'native-animation-midpoint', mid }, false);
          await ev('__qaNormalAnimation.play();true');
          await snap(`drawer-normal-settled-1440-${theme}`, 1440, 900, theme, { kind: 'normal-motion-transition', phase: 'settled' });
          await click('#side .sh-head [data-sh="toggleSide"]'); await settled(page);
          await click('#tabs .sh-topen');
          await ev(`(() => {void document.documentElement.offsetWidth;const a=document.getAnimations().find(a=>a.transitionProperty==='margin-left');a.pause();a.currentTime=Number(a.effect.getTiming().duration)/2;a.play();return true})()`);
          await click('#side .sh-head [data-sh="toggleSide"]');
          await snap(`drawer-normal-interrupted-1440-${theme}`, 1440, 900, theme, { kind: 'normal-motion-interruption', phase: 'closed-after-midpoint-input' });
          await click('#tabs .sh-topen'); await settled(page);
        }
      }
      // Fold states use the real loader. The file loading fixture holds only the
      // insertion until its state is recorded, then releases the actual script.
      for (const theme of ['light', 'dark']) {
        await setViewport(page, 390, 844, theme); await open('a185', 'ov'); await reload();
        await waitDom('!!window.BriefPage?.state.model'); await open('a185', 'ov');
        if (mode === 'file') {
          await ev(`(() => {const append=Node.prototype.appendChild;window.__heldFold=[];Node.prototype.appendChild=function(n){
            if(n.tagName==='SCRIPT'&&n.src.includes('folded.js')){__heldFold.push([this,n]);return n}return append.call(this,n)};
            window.__releaseFold=()=>{Node.prototype.appendChild=append;for(const [p,n] of __heldFold)append.call(p,n)};return true})()`);
          await open('fold185', 'rep');
          await snap(`file-fold-loading-390-${theme}`, 390, 844, theme, { kind: 'folded-previous', phase: 'loading' });
          await ev('__releaseFold();true'); await waitDom('document.querySelectorAll("#main .rep").length===3');
          await snap(`file-fold-loaded-390-${theme}`, 390, 844, theme, { kind: 'folded-previous', phase: 'loaded' });
          await open('a185', 'ov'); await reload();
          fs.renameSync(path.join(tmp, 'folded.js'), path.join(tmp, 'folded.held'));
          try {
            await open('fold185', 'rep'); await waitDom('!!document.querySelector(".cv-fold[data-fold=error]")');
            await snap(`file-fold-error-390-${theme}`, 390, 844, theme, { kind: 'folded-previous', phase: 'file-load-error' });
          } finally { fs.renameSync(path.join(tmp, 'folded.held'), path.join(tmp, 'folded.js')); }
        } else {
          let release, requested;
          fault.hold = new Promise(r => { release = r; fault.release = r; });
          const request = new Promise(r => { requested = r; }); fault.requested = requested;
          await open('fold185', 'rep'); await bounded(request, 'server folded request');
          await snap(`server-fold-loading-390-${theme}`, 390, 844, theme, { kind: 'folded-previous', phase: 'loading' });
          release(); fault.hold = null; await waitDom('document.querySelectorAll("#main .rep").length===3');
          await snap(`server-fold-loaded-390-${theme}`, 390, 844, theme, { kind: 'folded-previous', phase: 'loaded' });
          for (const phase of ['error', 'restart']) {
            await open('a185', 'ov'); await reload();
            fault.mode = phase; await open('fold185', 'rep');
            await waitDom(`!!document.querySelector('.cv-fold[data-fold="${phase}"]')`);
            await snap(`server-fold-${phase}-390-${theme}`, 390, 844, theme, { kind: 'folded-previous', phase });
            fault.mode = '';
          }
        }
      }
      writeJson('additional-state-index.json', { build, count: extras.length, addedThisPass: records.length, records: extras });
      return { count: records.length, records };
    }
    async function round3Evidence() {
      const names=[];
      const snap=async(name,width,theme,state={},finish=true)=>{
        const viewName=`${mode}-${name}`;
        await scenario(mode,'frame-'+name,async()=>{
          const r=await screenshotState(viewName,width,width===390?844:900,theme,state,finish);return {file:r.file};
        });
        names.push(viewName);
      };
      const traceTabs=async(drawer)=>{
        await ev('document.activeElement?.blur();true');
        const trace=[];let first;
        for(let i=0;i<90;i++){
          await key('Tab');
          const f=await ev(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),all=[...document.querySelectorAll('button,a,input,[tabindex]')];
            return {tag:e.tagName,classes:e.className,action:e.getAttribute('data-sh'),sid:e.getAttribute('data-sid'),tab:e.closest('[data-tab]')?.getAttribute('data-tab'),
              selectedHistory:!!e.closest('.sh-prev.sel'),covered:!!e.closest('[inert]'),inWrap:!!e.closest('.sh-wrap'),ordinal:all.indexOf(e),
              visible:r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight,focusVisible:e.matches(':focus-visible')}})()`);
          if(f.tag==='BODY')continue;
          const identity=J([f.ordinal,f.action,f.sid,f.tab]);
          if(identity===first)break;if(!first)first=identity;
          trace.push(f);assert.equal(f.covered,false,'native Tab must not enter inert content');
          assert.equal(f.visible,true,'native focus stays on visible content');
          if(drawer)assert.equal(f.inWrap,false,'drawer Tab must not reach covered main/tabs');
        }
        assert.ok(trace.length>3,'real keyboard traversal observed');
        if(drawer)assert.ok(trace.some(f=>f.selectedHistory),'history reached by actual Tab');
        else assert.ok(trace.some(f=>f.classes.includes('tb-go'))&&trace.some(f=>f.classes.includes('tb-x')),'window and close reached by actual Tab');
        let wraps=0;for(let i=1;i<trace.length;i++)if(trace[i].ordinal<trace[i-1].ordinal)wraps++;
        assert.ok(wraps<=1,'native reading order has at most one document wrap');
        return {drawer,trace,wraps};
      };
      if(mode==='file')for(const width of [1440,390])for(const theme of ['light','dark']){
        await publish(fixture(model.seq+1));await setViewport(page,width,width===390?844:900,theme);await open('p185','dec');await view('conv');await expand('a185');
        if(await ev('BriefPage.state.ui.peek'))await key('Escape');
        await settled(page);
        const targets=[['tab','#tabs .tb.on .tb-go'],['tab-close','#tabs .tb.on .tb-x'],['history','#side .sh-prev.sel [data-sh="open"][data-sid="p185"]']];
        for(const [label,selector]of targets){
          if(label==='history'&&width===390&&!await ev('BriefPage.state.ui.peek')){await realClick('#tabs .sh-topen');await settled(page);}
          await ev('document.activeElement?.blur();getSelection()?.removeAllRanges();true');
          if(label==='history'&&width===390)await historyRest();
          else await page.client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1,button:'none'});
          await snap(`${label}-rest-${width}-${theme}`,width,theme,{kind:'changed-control-feedback',control:label,phase:'rest-unfocused',...(label==='history'&&width===390?{native:await historyNative()}:{})});
          const p=await ev(`(()=>{const e=document.querySelector(${J(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
          await page.client.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p,button:'none'});
          await snap(`${label}-hover-${width}-${theme}`,width,theme,{kind:'changed-control-feedback',control:label,phase:'hover-unfocused',...(label==='history'&&width===390?{native:await historyNative()}:{})});
          await page.client.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});
          await snap(`${label}-pressed-${width}-${theme}`,width,theme,{kind:'changed-control-feedback',control:label,phase:'real-mouse-down',...(label==='history'&&width===390?{native:await historyNative()}:{})});
          await page.client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1,button:'left',buttons:1});
          await page.client.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:1,y:1,button:'left',clickCount:1});
          await ev('getSelection()?.removeAllRanges();true');
          if(label==='history'&&width===390&&!await ev('BriefPage.state.ui.peek')){
            await realClick('#tabs .sh-topen');await settled(page);
          }
          await ev(`document.querySelector(${J(selector)}).focus();true`);await key('Tab',8);await key('Tab');
          assert.equal(await ev(`document.querySelector(${J(selector)}).matches(':focus-visible')`),true,label+': actual Tab focus-visible');
          await snap(`${label}-focus-${width}-${theme}`,width,theme,{kind:'changed-control-feedback',control:label,phase:'native-tab-focus',...(label==='history'&&width===390?{native:await historyNative()}:{})});
        }
        if(width===390){const t=await traceTabs(true);writeJson(`keyboard-drawer-${theme}.json`,t);await key('Escape');await settled(page);}
        writeJson(`keyboard-main-${width}-${theme}.json`,await traceTabs(false));
        await open('p185','dec');await reload();await verify('p185','dec');
        const paint=await finishPaint(`lookback-${width}-${theme}`);
        await snap(`first-paint-lookback-${width}-${theme}`,width,theme,{kind:'observed-first-paint',paint});
      }
      if(mode==='file')for(const normal of [false,true])for(const theme of ['light','dark']){
        const width=normal?1440:390;
        await setViewport(page,width,width===390?844:900,theme,normal?'no-preference':'reduce');await open('p185','dec');await view('conv');await expand('a185');
        if(normal&&await ev('BriefPage.state.ui.sideOpen')){await realClick('#side .sh-head [data-sh="toggleSide"]');await settled(page);}
        if(!normal&&await ev('BriefPage.state.ui.peek')){await key('Escape');await settled(page);}
        await snap(`input-before-${width}-${theme}`,width,theme,{kind:'native-input-interruption',phase:'before'});
        const mid=await midpointOpen(normal);
        await snap(`input-mid-${width}-${theme}`,width,theme,{kind:'native-input-interruption',phase:'active-midpoint',mid},false);
        if(!normal)await ev(`(()=>{window.__r3InputDone=new Promise(resolve=>{
          document.addEventListener('keydown',function input(e){if(e.key!=='Escape')return;__r3Animation.play();
            const side=document.querySelector('.sh-side'),r=side.getBoundingClientRect();window.__r3InputBefore={time:__r3Animation.currentTime,playState:__r3Animation.playState,x:r.x,opacity:getComputedStyle(side).opacity,trusted:e.isTrusted};
          },{capture:true,once:true});
          document.addEventListener('keydown',e=>{const side=document.querySelector('.sh-side');void side.offsetWidth;const a=document.getAnimations().find(a=>a.effect?.target===side&&(a.id==='sh-xfade'||a.transitionProperty==='margin-left'));
              if(a)a.pause();const b=side.getBoundingClientRect();window.__r3RetargetAnimation=a;
              resolve({before:__r3InputBefore,after:{x:b.x,opacity:getComputedStyle(side).opacity,time:a?.currentTime,playState:a?.playState,peek:BriefPage.state.ui.peek,sideOpen:BriefPage.state.ui.sideOpen,inert:document.querySelector('.sh-wrap').inert},input:e.key});
          },{once:true})});return true})()`);
        if(normal){
          // Escape is reserved for the compact overlay. The docked panel uses
          // its actual close pointer; sample both input time and retarget time.
          await ev(`(()=>{document.addEventListener('pointerdown',function input(e){__r3Animation.play();const side=document.querySelector('.sh-side'),r=side.getBoundingClientRect();
            window.__r3PointerBefore={time:__r3Animation.currentTime,playState:__r3Animation.playState,x:r.x,opacity:getComputedStyle(side).opacity,trusted:e.isTrusted}}, {capture:true,once:true});
            document.addEventListener('click',()=>{window.__r3ClickBefore={x:document.querySelector('.sh-side').getBoundingClientRect().x}},{capture:true,once:true});
            document.addEventListener('click',()=>{void document.documentElement.offsetWidth;const side=document.querySelector('.sh-side'),a=document.getAnimations().find(a=>a.transitionProperty==='margin-left'&&a.effect?.target===side);if(a)a.pause();window.__r3RetargetAnimation=a;
              const r=side.getBoundingClientRect();window.__r3PointerResult={before:__r3PointerBefore,retargetBefore:__r3ClickBefore,after:{x:r.x,opacity:getComputedStyle(side).opacity,time:a?.currentTime,playState:a?.playState,sideOpen:BriefPage.state.ui.sideOpen},input:'real-pointer-close'}},{once:true});return true})()`);
          await realClick('#side .sh-head [data-sh="toggleSide"]');
        }else await key('Escape');
        const input=await ev(normal?'__r3PointerResult':'__r3InputDone');
        assert.equal(input.before.trusted,true);assert.equal(input.before.playState,'running');
        assert.ok(input.before.time>0&&input.before.time<150);
        if(normal)assert.ok(Math.abs(input.retargetBefore.x-input.after.x)<=2,'real retarget begins at the current visual position');
        assert.equal(normal?input.after.sideOpen:input.after.peek,false,'real input changes the drawer state');
        await snap(`input-retarget-${width}-${theme}`,width,theme,{kind:'native-input-interruption',phase:'immediate-retarget',input},false);
        await ev('window.__r3RetargetAnimation?.play();true');
        await snap(`input-settled-${width}-${theme}`,width,theme,{kind:'native-input-interruption',phase:'settled-after-real-input',input});
        if(normal){await realClick('#tabs .sh-topen');await settled(page);}
      }
      if(mode==='server')for(const theme of ['light','dark']){
        await publish(fixture(model.seq+1));await setViewport(page,390,844,theme);await open('a185','ov');await reload();await view('conv');await expand('a185');
        if(!await ev('BriefPage.state.ui.peek')){await realClick('#tabs .sh-topen');await settled(page);}
        await page.client.send('Network.enable');
        const requests=new Map();let fail;
        const failedRequest=new Promise(resolve=>{fail=resolve});
        const onRequest=p=>requests.set(p.requestId,p.request.url);
        const onFailure=p=>{const requestUrl=requests.get(p.requestId);if(requestUrl&&/\/convo(?:[/?]|$)/.test(requestUrl))fail({...p,url:requestUrl})};
        for(const [event,listener]of [['Network.requestWillBeSent',onRequest],['Network.loadingFailed',onFailure]])
          page.client.listeners.set(event,[...(page.client.listeners.get(event)||[]),listener]);
        await page.client.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
        try{
          await realClick('#side .sh-prev [data-sh="open"][data-sid="fold185"]');
          const network=await bounded(failedRequest,'genuine offline network failure');
          await waitDom('!!document.querySelector(".cv-fold[data-fold=error]")');
          const identity=await info();assert.equal(identity.active,A);assert.equal(identity.shown,'fold185');
          const cause=await ev('document.querySelector(".cv-fold").textContent');
          assert.ok(/연결|네트워크/.test(cause),'rendered network cause, not malformed response');
          await snap(`offline-history-390-${theme}`,390,theme,{kind:'genuine-server-offline',network,cause,identity});
          await realClick('.cv-prevgo');await verify('a185','ov');
          await snap(`offline-return-390-${theme}`,390,theme,{kind:'genuine-server-offline-return',network});
        }finally{
          await page.client.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
          for(const [event,listener]of [['Network.requestWillBeSent',onRequest],['Network.loadingFailed',onFailure]])
            page.client.listeners.set(event,(page.client.listeners.get(event)||[]).filter(f=>f!==listener));
        }
      }
      writeJson('additional-state-index.json',{build,count:extras.length,records:extras});
      return {count:names.length,records:names};
    }
    await page.goto(url);
    await waitDom('BriefPage.state.model && BriefPage.state.model.seq === 1 && BriefPage.state.ui.tabs.length > 0');
    if (HISTORY_EVIDENCE) { await scenario(mode,'history-six-visible-states',historyEvidence); return; }
    if (!NEGATIVE && !R3_PROBE && !VISUAL_PROBE) await scenario(mode,'r3-first-paint-v1',()=>finishPaint('first-v1'));
    await scenario(mode, 'merge', async () => {
      const v = await info();
      assert.deepEqual(v.tabs, EXPECTED); assert.deepEqual(v.pinned, [A, C]); assert.equal(v.active, A);
      assert.equal(v.shown, 'a185', 'the migrated ended active source follows its live host'); assert.equal(v.sub.p185, 'dec');
      const seed = await ev('__seed'); assert.equal(seed.v2Existed, false);
      assert.equal(await ev(`localStorage.getItem('omo-briefing.ui.v1')`), PREFS);
      assert.equal(await ev(`JSON.parse(localStorage.getItem('omo-briefing.ui.v2')).tabSchema`), 2);
      return { ...v, seed };
    });
    await scenario(mode, 'open-이전 대화', async () => { await previous('p185'); return verify('p185', 'dec'); });
    if (NEGATIVE) return;
    if (REVERT_CSS) assert.equal(await ev(`(()=>{let n=0;for(const s of document.querySelectorAll('style'))if(s.textContent.includes(${J(CURRENT_SHELL_CSS)})){
      s.textContent=s.textContent.replace(${J(CURRENT_SHELL_CSS)},${J(REVERT_CSS)});n++}return n})()`),1,'actual complete shell stylesheet reverted');
    if(R3_FOCUS_PROBE){
      await scenario(mode,'r3-close-focus',async()=>{
        await setViewport(page,1440,900,'light');await open('p185','dec');
        await ev('document.querySelector("#tabs .tb.on .tb-x").focus();true');await key('Tab',8);await key('Tab');
        const surface=await surfaceSweep(page,1440,'light');writeJson('close-focus-surface.json',surface);
        await page.screenshot(path.join(OUT,'close-focus.png'));
        assert.deepEqual(surface.changedContrastFailures,[],'actual close focus contrast');return {surface};
      });return;
    }
    async function round3Products() {
      await scenario(mode, 'r3-zoom-title', async () => {
        const measurements=[];
        for(const theme of ['light','dark']){
          await setViewport(page,1440,900,theme);await open('p185','dec');
          await ev('document.documentElement.style.zoom="2";document.querySelector("#tabs").scrollLeft=0;true');await settled(page);
          measurements.push({theme,...await tabGeometry(page)});
          await page.screenshot(path.join(OUT,`${mode}-r3-zoom-1440-${theme}.png`));
          await ev('document.documentElement.style.zoom="1";true');
        }
        writeJson(`${mode}-r3-zoom-measurements.json`,measurements);
        assert.ok(measurements.every(m=>m.readable&&m.contained&&m.overlap.length===0),J(measurements));
        return {measurements};
      });
      await scenario(mode, 'r3-midpoint-contrast', async () => {
        const measurements=[];
        for(const theme of ['light','dark']){
          await setViewport(page,390,844,theme);await open('p185','dec');await view('conv');await expand('a185');
          if(await ev('BriefPage.state.ui.peek'))await realClick('#side .sh-head [data-sh="toggleSide"]');
          await settled(page);const mid=await midpointOpen();
          const surface=await surfaceSweep(page,390,theme);
          const samples=[...surface.pairs,...surface.icons,...surface.edges].filter(m=>m.selectedHistory);
          measurements.push({theme,mid,samples,failures:samples.filter(m=>m.ratio+.01<m.required)});
          await page.screenshot(path.join(OUT,`${mode}-r3-mid-390-${theme}.png`));
          await ev('__r3Animation.play();true');await settled(page);
          await page.client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
          await page.client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await settled(page);
        }
        writeJson(`${mode}-r3-midpoint-measurements.json`,measurements);
        assert.ok(measurements.every(m=>m.samples.some(s=>s.kind==='text')&&m.samples.some(s=>s.kind==='icon')&&m.samples.some(s=>s.kind==='control-edge')&&m.failures.length===0),J(measurements));
        return {measurements};
      });
    }
    await round3Products();
    if (R3_PROBE) return;
    if (R3_EVIDENCE_PROBE) { await scenario(mode,'r3-evidence',round3Evidence); return; }
    if (VISUAL_MUTATION) await ev(`(() => { const s=document.createElement('style');s.textContent=
      '.cv-prevline,.cv-prevgo{font-size:var(--cv-fs-s)!important}.cv-prevgo{min-height:0!important;min-width:0!important}.cv-prevgo:active{background:var(--fill-hover)!important;box-shadow:none!important}@media(max-width:599px){.tb{max-width:168px!important}.tb .tt{min-width:0!important}}';document.head.appendChild(s);return true})()`);
    for (const criterion of ['target', 'type', 'pressed', 'title']) await scenario(mode, 'visual-' + criterion, async () => {
      const measurements = [];
      for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
        await setViewport(page, width, width === 390 ? 844 : 900, theme);
        await open('p185', 'dec');
        const m = await visualMeasure(page); measurements.push({ width, theme, ...m });
      }
      writeJson('visual-' + criterion + '.json', measurements);
      if (criterion === 'target') for (const m of measurements) assert.ok(m.target.width >= 44 && m.target.height >= 44, J(m));
      if (criterion === 'type') for (const m of measurements) assert.ok(m.lineFont >= (m.width === 390 ? 15 : 14) && m.buttonFont >= (m.width === 390 ? 15 : 14), J(m));
      if (criterion === 'pressed') for (const m of measurements) assert.ok(m.pressed.background !== m.hover.background || m.pressed.shadow !== m.hover.shadow, J(m));
      if (criterion === 'title') for (const m of measurements.filter(m => m.width === 390)) assert.ok(m.title.width >= 50 && m.title.pin && m.title.bell === '1', J(m));
      return { measurements };
    });
    if (VISUAL_PROBE) {
      for (const theme of ['light', 'dark']) {
        await setViewport(page, 390, 844, theme); await open('p185', 'dec');
        await ev('document.documentElement.style.zoom="2";document.querySelector("#tabs").scrollLeft=0;true');
        await settled(page);
        await page.screenshot(path.join(OUT, 'probe-zoom-390-' + theme + '.png'));
        await ev('document.documentElement.style.zoom="1";true');
      }
      return;
    }
    await setViewport(page, 1440, 900, 'light');
    if (STATE_PROBE) { await scenario(mode, 'additional-states', additionalStates); await scenario(mode,'r3-evidence',round3Evidence); return; }
    if (mode === 'file') {
      await scenario(mode, 'open-sidebar', async () => { await view('conv'); await click('#side [data-row="a185"] .sh-go'); return verify('a185', 'plan'); });
      await scenario(mode, 'open-inbox', async () => { await view('inbox'); await click('#side .sh-it[data-sid="p185"]'); return verify('p185', 'dec'); });
      await scenario(mode, 'open-favourite', async () => { await view('conv'); await click('#side [data-sec="fav"] .sh-go[data-sid="q185"]'); return verify('q185', 'plan'); });
      await scenario(mode, 'open-search', async () => {
        await view('conv');
        await ev(`(() => {const input=document.querySelector('#sh-q');input.value='두 번째';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
        await click('#side [data-row="q185"] .sh-go');
        const v = await verify('q185', 'plan');
        await ev(`(() => {const input=document.querySelector('#sh-q');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
        return v;
      });
      await scenario(mode, 'open-plans', async () => { await view('plans'); await click('#side .sh-it[data-sid="q185"]'); return verify('q185', 'plan'); });
      await scenario(mode, 'open-plan-owner', async () => { await click('#main [data-sh="open"][data-sid="a185"]'); return verify('a185', 'plan'); });
      await scenario(mode, 'open-닫힌 창', async () => { await view('archive'); await click('#side [data-row="p185"] .sh-go'); return verify('p185', 'dec'); });
      await scenario(mode, 'open-overview', async () => {
        // Prepare the overview without closing tabs: the actual overview control
        // must still route through the unmodified production click dispatcher.
        await ev(`BriefPage.state.ui={...BriefPage.state.ui,active:null};BriefPage.render();true`);
        await click('#main [data-sh="open"][data-sid="a185"]');
        return verify('a185', 'plan');
      });
    }
    await scenario(mode, 'prev-line', async () => {
      await open('a185', 'plan'); assert.equal(await ev('!!document.querySelector(".cv-prevline")'), false);
      await open('q185', 'plan'); assert.equal(await ev('!!document.querySelector(".cv-prevline")'), false);
      await previous('p185'); await verify('p185', 'dec');
      const line = await ev(`(() => {const e=document.querySelector('.cv-prevline');return {first:e.parentElement.firstElementChild===e,
        block:!!e.closest('[data-block]'),role:e.getAttribute('role'),text:e.textContent}})()`);
      assert.equal(line.first, true); assert.equal(line.block, false); assert.equal(line.role, null);
      assert.match(line.text, /이전 대화 보는 중 · 지금 대화로/);
      await ev(`document.querySelector('.cv-prevgo').focus();true`); await click('.cv-prevgo');
      const v = await verify('a185', 'plan');
      assert.equal(await ev('document.activeElement === document.querySelector(".stabs [aria-selected=true]")'), true);
      assert.equal(await ev('!!document.querySelector(".cv-prevline")'), false);
      return { ...v, line, focus: await ev('document.activeElement.outerHTML') };
    });
    await scenario(mode, 'fold', async () => {
      await previous('fold185'); await click('#main [data-act="sub"][data-sub="rep"]');
      await waitDom('document.querySelectorAll("#main .rep").length === 3');
      return { ...await verify('fold185', 'rep'), reports: await ev('document.querySelectorAll("#main .rep").length') };
    });
    await scenario(mode, 'ax', async () => {
      await previous('p185');
      const ax = await axSnapshot(page), unnamed = unnamedInteractive(ax.raw.nodes);
      fs.writeFileSync(path.join(OUT, mode + '-ax.txt'), ax.text);
      writeJson(mode + '-ax.json', ax.raw);
      assert.ok(ax.raw.nodes.some(n => !n.ignored && n.role?.value === 'button' && n.name?.value === '지금 대화로'));
      assert.deepEqual(unnamed, []);
      return { returnName: '지금 대화로', unnamed };
    });
    if (mode === 'file') {
      await scenario(mode, 'adversarial-controls', async () => {
        const evidence = await ev(`(() => {
          const probe=(mutate,test)=>{const saved=BriefPage.state.ui;try{BriefPage.state.ui=mutate(saved);return test(BriefPage.state.ui)}finally{BriefPage.state.ui=saved}};
          const wrongShown=probe(u=>({...u,shown:{...u.shown,${J(A)}:'q185'}}),u=>BriefShell.shownOf(u,u.active)!=='p185');
          const duplicateTab=probe(u=>({...u,tabs:u.tabs.concat('p185')}),u=>u.tabs.length!==4);
          const values={};const writes=[];const fake={getItem:k=>values[k]??null,setItem:(k,v)=>{writes.push(k);values[k]=v}};
          BriefShell.persist(fake,BriefPage.state.ui);
          const v1WriteGuard=!writes.includes('omo-briefing.ui.v1')&&writes.includes('omo-briefing.ui.v2');
          const mutantWrites=writes.concat('omo-briefing.ui.v1');const v1WriteNegative=mutantWrites.includes('omo-briefing.ui.v1');
          const priorityStorage={getItem:k=>k.endsWith('.v2')?'corrupt-v2':${J(PREFS)}};
          const v2Priority=BriefShell.restore(priorityStorage)==='corrupt-v2';
          const wrongLiveLine=BriefShell.windowLiveOf(BriefPage.state.model,{...BriefPage.state.ui,shown:{...BriefPage.state.ui.shown,${J(A)}:'q185'}})===null;
          const card=BriefPage.state.full.get('fold185|fold-card-1');const foldGuard=card?.card?.reports?.length===3;
          const foldNegative=({...card,card:{...card?.card,reports:[]}}).card.reports.length!==3;
          return {wrongShown,duplicateTab,v1WriteGuard,v1WriteNegative,v2Priority,wrongLiveLine,foldGuard,foldNegative};
        })()`);
        for (const [key, value] of Object.entries(evidence)) assert.equal(value, true, key);
        await ev(`(() => {const b=document.createElement('button');b.id='qa-unnamed-negative';document.body.appendChild(b);return true})()`);
        const negativeAx = await axSnapshot(page);
        evidence.unnamedNegative = unnamedInteractive(negativeAx.raw.nodes).length > 0;
        await ev(`document.querySelector('#qa-unnamed-negative').remove();true`);
        assert.equal(evidence.unnamedNegative, true);
        const positiveAx = await axSnapshot(page); assert.deepEqual(unnamedInteractive(positiveAx.raw.nodes), []);
        return evidence;
      });
      await scenario(mode, 'interaction-states', async () => {
        await previous('p185');
        const rect = await ev(`(() => {const r=document.querySelector('.cv-prevgo').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        const style = () => ev(`(() => {const e=document.querySelector('.cv-prevgo'),s=getComputedStyle(e);return {hover:e.matches(':hover'),active:e.matches(':active'),focusVisible:e.matches(':focus-visible'),background:s.backgroundColor,color:s.color,outline:s.outline,transition:s.transition}})()`);
        await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect, button: 'none' });
        const hover = await style(); assert.equal(hover.hover, true);
        await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
        const pressed = await style(); assert.equal(pressed.active, true);
        await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'left', buttons: 1 });
        await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 });
        await ev(`document.querySelector('.cv-prevgo').focus();true`);
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const keyboard = await style(); assert.equal(keyboard.focusVisible, true); assert.notEqual(keyboard.outline, 'none');
        await page.client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
        await click('#tabs .sh-topen');
        const covered = await ev(`({peek:BriefPage.state.ui.peek,inert:document.querySelector('.sh-wrap').inert})`);
        assert.equal(covered.peek, true); assert.equal(covered.inert, true);
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        const escaped = await ev(`({peek:BriefPage.state.ui.peek,inert:document.querySelector('.sh-wrap').inert,focus:document.activeElement.outerHTML})`);
        assert.equal(escaped.peek, false); assert.equal(escaped.inert, false);
        await page.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        return { hover, pressed, keyboard, covered, escaped };
      });
      await scenario(mode, 'two-pane', async () => {
        for (const sid of ['a185', 'q185']) { await open(sid, 'plan'); await verify(sid, 'plan');
          assert.equal(await ev('!!document.querySelector(".cv-prevline")'), false); }
        return { panes: ['a185', 'q185'], lineCount: 0 };
      });
      await scenario(mode, 'tab-roundtrip', async () => {
        await view('conv'); await open('q185', 'plan');
        await click(`#tabs [data-tab="${B}"] .tb-go`); await verify('b186');
        await click(`#tabs [data-tab="${A}"] .tb-go`); return verify('q185', 'plan');
      });
      await scenario(mode, 'bell', async () => {
        const v = await ev(`(() => {const t=document.querySelector('#tabs [data-tab="${A}"]');
          return {count:t.querySelector('.sh-bdg').textContent,title:t.querySelector('.sh-bdg').title,
          name:t.querySelector('.tb-go').getAttribute('aria-label')}})()`);
        assert.equal(v.count, '1'); assert.equal(v.title, '창 전체'); assert.match(v.name, /기다리는 결정 1개\(창 전체\)/); return v;
      });
      await scenario(mode, 'reload', async () => {
        await open('q185', 'plan'); const before = await info();
        await page.goto(url); await waitDom('BriefPage.state.ui.active !== null');
        const after = await verify('q185', 'plan');
        for (const key of ['tabs', 'pinned', 'active', 'shown', 'sub']) assert.deepEqual(after[key], before[key]);
        return { before, after };
      });
      await scenario(mode, 'standalone', async () => { await open('standalone', 'ov'); return verify('standalone', 'ov'); });
      await scenario(mode, 'restart', async () => {
        await open('a185', 'plan');
        const next = fixture(2); next.sessions = next.sessions.map(s => s.id === 'a185' ? { ...s, alive: false } : s);
        // The other alive pane also ends: the replacement is now the newest alive conversation.
        next.sessions = next.sessions.map(s => s.id === 'q185' ? { ...s, alive: false } : s);
        next.sessions.push(session({ id: 'new185', tabId: 'w4:t185', tabLabel: '작업 창', tabNumber: 185, lastActivityAt: NOW + 1000 }));
        await publish(next); await verify('new185');
        await open('p185', 'dec');
        const back = structuredClone(next); back.seq = 3;
        back.sessions = back.sessions.map(s => s.id === 'new185' ? { ...s, alive: false } : s);
        back.sessions.push(session({ id: 'newer185', tabId: 'w4:t185', tabLabel: '작업 창', tabNumber: 185, lastActivityAt: NOW + 2000 }));
        await publish(back); await verify('p185', 'dec');
        // Prove the live-follow record also follows when the first newer model arrives after a closed page.
        await open('newer185', 'ov');
        await page.goto('about:blank');
        const closed = structuredClone(back); closed.seq = 4;
        closed.sessions = closed.sessions.map(s => s.id === 'newer185' ? { ...s, alive: false } : s);
        closed.sessions.push(session({ id: 'overnight185', tabId: 'w4:t185', tabLabel: '작업 창', tabNumber: 185, lastActivityAt: NOW + 3000 }));
        model = closed; publishFile(); fs.writeFileSync(path.join(tmp, 'index.html'), pageHtml(model, GEN, { mode: 'file' }));
        await page.goto(url); await verify('overnight185');
        // Return to the identical initial fixture for every frozen capture.
        const reset = fixture(5); await publish(reset); await open('p185', 'dec');
        return { liveFollow: 'new185', lookBack: 'p185', closedPageFollow: 'overnight185', appliedSeq: 5 };
      });
      await scenario(mode, 'capture-matrix', async () => {
        for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) for (const theme of ['light', 'dark']) {
          const mobile = width === 390, dpr = mobile ? 3 : 1;
          await page.client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
          await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
          await page.client.send('Emulation.setEmulatedMedia', { features: [
            { name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
          for (const viewName of ['tabbar', 'prevline', 'sidebarprevious']) {
            await view('conv'); await expand('a185');
            await open(viewName === 'tabbar' ? 'q185' : 'p185', viewName === 'tabbar' ? 'plan' : 'dec');
            // Open only the requested sidebar view on compact widths; otherwise it covers the main line.
            const peek = await ev('BriefPage.state.ui.peek === true');
            if (mobile && ((viewName === 'sidebarprevious') !== peek)) await click('#tabs .sh-topen');
            if (viewName === 'sidebarprevious') await ev(`document.querySelector('#side .sh-prev [data-sid="p185"]').scrollIntoView({block:'nearest'});true`);
            await ev(`document.getElementById('main').scrollTop=0;document.querySelector('#tabs').scrollLeft=0;document.activeElement?.blur();true`);
            const animation = await settled(page);
            const state = await info();
            const surface = await surfaceSweep(page, width, theme);
            assert.deepEqual(surface.changedContrastFailures, [], 'base matrix changed-surface contrast');
            assert.ok(Object.values(surface.negativeControls).every(Boolean), 'base matrix class negative controls');
            sweeps.push({ view: viewName, width, theme, ...surface });
            await ev(`document.getElementById('main').scrollTop=0;true`);
            await settled(page);
            const file = `${viewName}-${width}-${theme}.png`;
            await page.screenshot(path.join(OUT, file));
            const png = fs.readFileSync(path.join(OUT, file));
            assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
            assert.equal(png.readUInt32BE(16), width * dpr); assert.equal(png.readUInt32BE(20), height * dpr);
            assert.ok(png.length > 10000, 'nonblank composited capture');
            captures.push({ page: 'board', view: viewName, viewport: { width, height, dpr, mobile }, theme,
              state: { ...state, reducedMotion: true, sidebar: viewName === 'sidebarprevious', focus: 'rest', animation },
              file: path.join(OUT, file), sha256: sha(png), bytes: png.length, buildId: build.buildId, servedUrl: url });
          }
        }
        assert.equal(captures.length, 18);
        writeJson('surface-sweep.json', sweeps);
        const manifestHash = sha(J(captures));
        writeJson('capture-index.json', { build, manifestHash, count: captures.length, captures });
        return { count: captures.length, manifestHash };
      });
    }
    await scenario(mode, 'additional-states', additionalStates);
    await scenario(mode, 'r3-evidence', round3Evidence);
    await scenario(mode, 'v1-unchanged', async () => {
      assert.equal(await ev(`localStorage.getItem('omo-briefing.ui.v1')`), PREFS);
      return { bytes: Buffer.byteLength(PREFS), sha256: sha(PREFS) };
    });
    await scenario(mode, 'csp', async () => { csp.assertNone(mode); return { violations: csp.violations, notes: csp.notes }; });
  } finally {
    fault.release?.(); fault.hold = null;
    if (page) {
      receipt.chrome.rawPids = [...new Set([page.pid, ...listProfilePids(page.profileDir)])];
      receipt.chrome.beforeClose = receipt.chrome.rawPids.map(processIdentity);
      try { await page.close(); receipt.chrome.closeReturned = true; }
      catch (e) { receipt.chrome.closeError = e.stack; }
      receipt.chrome.remainingPids = receipt.chrome.rawPids.filter(isPidAlive);
      receipt.chrome.profileRemoved = !fs.existsSync(page.profileDir);
      receipt.cspViolations = csp?.violations || [];
    }
    if (host) { await host.release(); receipt.host = host.status(); }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    receipt.tempRemoved = !fs.existsSync(tmp);
    receipt.ended = new Date().toISOString();
    receipt.pass = receipt.tempRemoved && (!receipt.chrome ||
      receipt.chrome.closeReturned && receipt.chrome.profileRemoved && receipt.chrome.remainingPids.length === 0);
    cleanup.push(receipt);
    writeJson(NEGATIVE ? 'negative-cleanup.json' : 'cleanup.json', cleanup);
  }
}

// Measured DOM evidence is not visual acceptance. Preserve every measured miss for
// the independent reviewers; prove each zero-hit class with a browser-only mutant.
async function surfaceSweep(page, width, theme) {
  return page.eval(`(() => {
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);let opacity=1;for(let p=e;p;p=p.parentElement)opacity*=Number(getComputedStyle(p).opacity);
      return r.width>0&&r.height>0&&s.visibility!=='hidden'&&opacity>0&&!e.closest('[inert]')&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth};
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const rgb=s=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=s;ctx.fillRect(0,0,1,1);const p=[...ctx.getImageData(0,0,1,1).data];p[3]/=255;return p};
    const blend=(a,b)=>a.slice(0,3).map((v,i)=>v*(a[3]??1)+b[i]*(1-(a[3]??1)));
    const lum=c=>{const a=c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return .2126*a[0]+.7152*a[1]+.0722*a[2]};
    const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
    const identify=e=>({tag:e.tagName,classes:typeof e.className==='string'?e.className:e.className.baseVal,text:e.textContent.trim().slice(0,70),selectedHistory:!!e.closest('.sh-prev.sel'),
      scope:e.closest('.cv-prevline,#tabs .tb,#side .sh-prev')?'changed-or-immediate-window-surface':'inherited-context'});
    const composite=(e,ink)=>{
      const chain=[];for(let p=e;p;p=p.parentElement)chain.unshift(p);
      let natural=${theme === 'dark' ? '[0,0,0]' : '[255,255,255]'};const layers=[];
      for(const p of chain){const s=getComputedStyle(p),under=natural;natural=blend(rgb(s.backgroundColor),natural);
        layers.push({classes:typeof p.className==='string'?p.className:p.className.baseVal,opacity:Number(s.opacity),under,local:natural,image:s.backgroundImage})}
      let background=natural,foreground=blend(rgb(ink),natural);
      for(let i=layers.length-1;i>=0;i--){const l=layers[i];background=blend([...background,l.opacity],l.under);foreground=blend([...foreground,l.opacity],l.under)}
      return {ratio:ratio(foreground,background),foreground,background,ancestorOpacity:layers.map(l=>({classes:l.classes,opacity:l.opacity})),
        gradientLayers:layers.filter(l=>l.image!=='none').map(l=>({classes:l.classes,image:l.image}))};
    };
    const measure=(e,kind='text',ink=null)=>{
      const s=getComputedStyle(e),large=parseFloat(s.fontSize)>=24||parseFloat(s.fontSize)>=18.66&&Number(s.fontWeight)>=700;
      return {...identify(e),kind,...composite(e,ink||s.color),required:kind==='text'?(large?3:4.5):3,font:s.fontSize};
    };
    const controls=[...document.querySelectorAll('button,a,input,[tabindex]')].filter(visible);
    const targets=controls.map(e=>{const r=e.getBoundingClientRect();return {...identify(e),w:r.width,h:r.height}}).filter(e=>e.w<44||e.h<44);
    const texts=[...document.querySelectorAll('body *')].filter(e=>visible(e)&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));
    const pairs=texts.map(e=>measure(e));
    const icons=[...document.querySelectorAll('svg.ic')].filter(visible).map(e=>measure(e,'icon',getComputedStyle(e).stroke==='none'?getComputedStyle(e).color:getComputedStyle(e).stroke));
    const edges=[...document.querySelectorAll('.cv-prevgo,.tb.on,.sh-row.sel')].filter(visible).map(e=>{
      const s=getComputedStyle(e);const ink=parseFloat(s.borderTopWidth)>0?s.borderTopColor:(s.boxShadow.match(/rgba?\\([^)]+\\)|color\\([^)]+\\)/)||[])[0];
      return ink?measure(e,'control-edge',ink):{...identify(e),kind:'control-edge',missing:true,ratio:0,required:3};
    }).concat(controls.filter(e=>e.matches(':focus-visible')&&getComputedStyle(e).outlineStyle!=='none').map(e=>measure(e,'focus-ring',getComputedStyle(e).outlineColor)));
    const contrast=pairs.filter(e=>e.ratio+.01<e.required);
    const overflow=[...document.querySelectorAll('#main,.cv-page,.cv-prevline,#side,.sh-row')].filter(visible).filter(e=>e.scrollWidth>e.clientWidth+1).map(identify);
    const focus=controls.filter(e=>e.matches(':focus-visible')).map(e=>({...identify(e),outline:getComputedStyle(e).outline,focused:document.activeElement===e}));
    const overlaps=rows=>{const out=[];for(const row of rows){if(!visible(row))continue;const boxes=[];
      for(const n of row.childNodes){if(n.nodeType===1&&visible(n))boxes.push(n.getBoundingClientRect());
        else if(n.nodeType===3&&n.textContent.trim()){const range=document.createRange();range.selectNodeContents(n);boxes.push(...range.getClientRects())}}
      for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];
        if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)out.push(identify(row))}}
      return out};
    const orphans=elements=>{const out=[];for(const el of elements)for(const n of el.childNodes){if(n.nodeType!==3)continue;
      for(const m of n.textContent.matchAll(/[가-힣]{3,}/g)){const lines=new Map();for(let i=m.index;i<m.index+m[0].length;i++){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+1);const box=r.getBoundingClientRect(),k=Math.round(box.y);lines.set(k,(lines.get(k)||'')+n.textContent[i])}
        const values=[...lines.values()];if(values.length>1&&values.at(-1).length<=2)out.push({...identify(el),word:m[0],lines:values})}}
      return out};
    const overlap=overlaps(document.querySelectorAll('.sh-row,.cv-prevline')),cjk=orphans(texts);
    const group=document.createElement('div');group.style.cssText='position:fixed;left:0;top:0;background:white;opacity:.1';
    const probe=document.createElement('button');probe.textContent='검사';probe.style.cssText='color:black;background:white;border:1px solid black;width:1px;height:1px;padding:0;overflow:visible';
    group.appendChild(probe);document.body.appendChild(group);
    const negativeControls={ancestorOpacityText:measure(probe).ratio<4.5,ancestorOpacityEdge:measure(probe,'control-edge','black').ratio<3,
      targets:probe.getBoundingClientRect().width<44,overflow:probe.scrollWidth>probe.clientWidth};
    const split=document.createElement('span');split.textContent='가나다';split.style.cssText='display:block;width:28px;font:14px sans-serif;word-break:break-all;white-space:normal';
    group.appendChild(split);negativeControls.cjk=orphans([split]).length>0;
    const row=document.createElement('div');row.style.cssText='display:flex;width:100px';
    row.innerHTML='<span>first</span><span>second</span>';row.lastChild.style.transform='translateX(-20px)';
    group.appendChild(row);negativeControls.overlap=overlaps([row]).length>0;
    negativeControls.ancestorOpacityIcon=measure(probe,'icon','black').ratio<3;
    group.remove();
    const failures=[...contrast,...icons.filter(e=>e.ratio+.01<3),...edges.filter(e=>e.ratio+.01<3)];
    return {width:${width},theme:${J(theme)},textPairs:texts.length,pairs,icons,edges,controls:controls.length,contrast,targets,overflow,overlap,cjk,focus,negativeControls,
      changedContrastFailures:failures.filter(e=>e.scope==='changed-or-immediate-window-surface'),
      inheritedContrastCandidates:failures.filter(e=>e.scope==='inherited-context'),
      documentOverflow:document.documentElement.scrollWidth>innerWidth,
      scope:'Settled DOM colours with alpha backgrounds and nested ancestor opacity composited from leaf to root; icons and control edges use 3:1, text 4.5:1 or 3:1 large. Gradient layers are disclosed per sample; no independent visual acceptance claimed.'};
  })()`);
}

if (HISTORY_NEGATIVE) {
  const records = historyBaseline.extras.filter(r => r.state.control === 'history' && r.viewport.width === 390 &&
    ['rest-unfocused', 'hover-unfocused', 'real-mouse-down'].includes(r.state.phase));
  assert.equal(records.length, 6);
  const rejected = records.map(r => {
    const failures = historyFrameFailures(r);
    assert.ok(failures.includes('missing selected-history text') && failures.includes('missing selected-history icon') &&
      failures.includes('missing selected-history control-edge'), r.view + ': original missing samples must fail');
    return { view: r.view, originalSha256: r.sha256, failures, rejected: true };
  });
  writeJson('history-negative.json', { pass: true, rejected, browserLaunched: false });
  console.log('PASS original six hidden history frames rejected');
} else try {
  await pass('file');
  if (!NEGATIVE && !VISUAL_PROBE && !R3_PROBE && !R3_FOCUS_PROBE && !HISTORY_EVIDENCE) await pass('server');
} catch (error) { results.fatal = { pass: false, error: error.stack }; console.error(error.stack); }
const after = sourceHashes();
results['source-freeze'] = { pass: J(after) === J(frozen), before: build.sourceHash, after: sha(J(after)) };
results.cleanup = { pass: cleanup.length === (HISTORY_NEGATIVE ? 0 : NEGATIVE || VISUAL_PROBE || R3_PROBE || R3_FOCUS_PROBE || HISTORY_EVIDENCE ? 1 : 2) && cleanup.every(r => r.pass), receipts: cleanup.length };
results.exceptions = { pass: exceptions.length === 0, exceptions };
const failed = Object.entries(results).filter(([, r]) => !r.pass).map(([key]) => key);
const report = { executionDoneClaim: false, overallAdmission: 'PENDING_DUAL_REVIEW', build, started,
  ended: new Date().toISOString(), negative: NEGATIVE, scenarios: results, passed: Object.keys(results).length - failed.length,
  failed: failed.length, failures: failed, captures: captures.length, additionalCaptures: extras.length, cleanup,
  adversarialClasses: ['legacy-open-sid', 'v1-write', 'storage-v2-priority', 'wrong-shown-selection', 'live-pane-prevline',
    'follow-vs-lookback', 'fold-card-hydration', 'AX-empty-name', 'surface-contrast-overflow-targets-focus'] };
writeJson(NEGATIVE ? 'negative-result.json' : 'result.json', report);
writeJson(NEGATIVE ? 'negative-build.json' : 'build.json', build);
if (captures.length) writeJson('capture-index.json', { build, manifestHash: sha(J(captures)), count: captures.length, captures,
  additionalCount: extras.length, extras, extrasManifestHash: sha(J(extras)),
  inheritedException: { id: 'B-06', criterion: 'D2 literal 49px stacked/all-visible phone navigation', disposition: 'Inherited preserved document-tab design; NOT PASS' } });
console.log(J({ passed: report.passed, failed: report.failed, failures: failed, captures: captures.length, cleanup: results.cleanup.pass }));
// The mutation is expected to fail specifically at the actual previous-entry check.
process.exitCode = NEGATIVE ? (failed.includes('file/open-이전 대화') ? 1 : 2) : failed.length ? 1 : 0;
