// Real-Chrome run of answering from the board (plan todo 11). No dependencies: Chrome DevTools Protocol through
// scripts/cdp.mjs, one lead conversation = the real extension with its real board server host (test/helpers/qa-lead.mjs; the
// stub page of test/helpers/server-child.mjs has no token and no answer hooks), the real store, all in an owned temp folder.
//
// usage: node scripts/qa-answer.mjs --out <dir> [--prefix task-11-]
//   <dir>/<prefix>*.png        desktop 1280x900 (choice B) and mobile 390x844 (reply), before / confirm / after, file page
//   --summary <file> (default <dir>/<prefix>result.json)  per check pass/fail with the measured values; forgery = { attempts: 3, writes }
// Checks: tab label + window SVG on card and confirmation; click B -> confirm -> 보내기 -> answers/<id>.json + live state on the card; reply typed
// and sent; a page on another origin (no-cors fetch + form POST), and a file:// copy of the page (no-cors fetch + CORS fetch with
// the leaked token) leave answers/ unchanged; the file page has no answer buttons and shows the read-only notice; then the
// conversation's last open decision is answered and its card + delivery line must stay on the tab the owner is looking at.
// Every wait is an event with a bound (MutationObserver in the page, fs.watch, IPC reply). The focus button is never clicked:
// it would run the real herdr on this machine.
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, copyFileSync, watch } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, isPidAlive } from './cdp.mjs';
import { openStore } from '../src/store.mjs';
import { answersSnapshot, snapshotDiff, attackScript, formHtml, evilPageHtml } from './qa-answer-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LEAD = path.join(ROOT, 'test/helpers/qa-lead.mjs');
const BASE = 47490;
const SID = 'qa-ans';
const TAB = { tabLabel: '수리', tabNumber: 181, tabId: 'w1:t5N', paneId: 'w1:pR2' };
const REPLY = '설치 진행해 줘 <b>굵게</b>';
const J = JSON.stringify;

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const OUT = arg('--out', '') ? path.resolve(arg('--out', '')) : '';
const PREFIX = arg('--prefix', 'task-11-');
const SUMMARY = path.resolve(arg('--summary', path.join(OUT || '.', `${PREFIX}result.json`)));
if (!OUT) { console.error('usage: node scripts/qa-answer.mjs --out <dir> [--prefix task-11-]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'omo-qa-answer-'));
const STATE = path.join(TMP, 'state');
const CWD = path.join(TMP, 'work');
mkdirSync(CWD, { recursive: true });
const results = {};
const shots = {};
const owned = { pids: [], servers: [], pages: [] };

const check = async (id, title, fn) => {
  try {
    results[id] = { title, pass: true, ...(await fn()) };
    console.log(`PASS (${id}) ${title}`);
  } catch (err) {
    results[id] = { title, pass: false, error: String((err && err.message) || err) };
    console.error(`FAIL (${id}) ${title}: ${(err && err.message) || err}`);
  }
};

// resolves pred()'s first truthy value, re-checked on every change under dir (recursive), bounded by ms
function until(dir, pred, label, ms = 15_000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); watcher.close(); fn(v); };
    const test = () => { let v = null; try { v = pred(); } catch (err) { if (!(err instanceof SyntaxError) && err.code !== 'ENOENT' && err.code !== 'EBUSY' && err.code !== 'EPERM') { finish(reject, err); return; } } if (v) finish(resolve, v); };
    const timer = setTimeout(() => finish(reject, new Error(`timeout waiting for ${label}`)), ms);
    const watcher = watch(dir, { recursive: true }, test);
    watcher.on('error', (err) => finish(reject, err));
    test();
  });
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(8000, () => req.destroy(new Error(`GET ${url}: no answer in 8s`)));
    req.on('error', reject);
  });
}

function spawnLead() {
  const child = fork(LEAD, [STATE, SID, CWD, String(BASE)], { execArgv: [], windowsHide: true });
  owned.pids.push(child.pid);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    child.once('message', (m) => (m.ready ? resolve(m) : reject(new Error('unexpected first message'))));
    child.once('error', reject);
  });
  child.on('message', (m) => {
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  child.on('exit', () => { for (const p of pending.values()) p.reject(new Error('lead exited')); pending.clear(); });
  const call = (cmd, extra = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`lead ${cmd}: no reply in 60s`)); }, 60_000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.send({ id, cmd, ...extra });
  });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, ready, call, closed, pid: child.pid };
}

const decisionOf = (question, withC = false) => ({
  question,
  options: { A: { text: '진행', consequence: '계속한다' }, B: { text: '보류', consequence: '멈춘다' }, ...(withC ? { C: { text: '다른 길', consequence: '새로 짠다' } } : {}) },
  recommend: 'A', reason: '빠르게 끝난다', blocks: true,
});

// ------------------------------------------------------------------ in-page helpers

// resolves the first truthy JSON value of `expr`, re-evaluated on every DOM change, bounded by ms
const waitFor = (page, expr, label, ms = 10_000) => page.eval(`new Promise((resolve, reject) => {
  const test = () => { try { return (${expr}); } catch (e) { return null; } };
  const v0 = test(); if (v0) return resolve(v0);
  const mo = new MutationObserver(() => { const v = test(); if (v) { mo.disconnect(); clearTimeout(t); resolve(v); } });
  mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  const t = setTimeout(() => { mo.disconnect(); reject(new Error('timeout: ' + ${J(label)} + ' | cards=' + [...document.querySelectorAll('[data-card]')].map((c) => c.getAttribute('data-card') + ':' + c.querySelectorAll('.dcard').length + '/' + c.querySelectorAll('.ans-box').length).join(',') + ' band=' + document.querySelectorAll('.alarm-who').length + ' live=' + !!document.querySelector('meta[name="omo-board-token"]'))); }, ${ms});
})`);

async function click(page, selector) {
  const pt = await page.eval(`(() => {
    const el = document.querySelector(${J(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pt) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.client.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  }
}

// viewport capture (selector = null, scrolled to the top) or the element's box
async function shot(page, name, selector = null) {
  let clip = null;
  if (selector) {
    clip = await page.eval(`(() => {
      const el = document.querySelector(${J(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'start' });
      const b = el.getBoundingClientRect();
      return { x: b.left + scrollX, y: b.top + scrollY, width: Math.ceil(b.width), height: Math.ceil(b.height), scale: 1 };
    })()`);
    if (!clip) throw new Error(`screenshot: nothing matches ${selector}`);
  } else {
    await page.eval('window.scrollTo(0, 0)');
  }
  const r = await page.client.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
  const file = path.join(OUT, `${PREFIX}${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  const size = statSync(file).size;
  if (size < 2000) throw new Error(`screenshot ${file} is only ${size} bytes`);
  shots[name] = { file, bytes: size };
  return file;
}

const card = `[data-card="${SID}"]`;
const dcard = (id) => `${card} .dcard[data-decision="${id}"]`;

// texts the decision's answer area shows over time (ans-state / ans-err / sent line chip), recorded by a MutationObserver that
// is installed before the click
const recordStates = (page, id) => page.eval(`(() => {
  window.__seen = [];
  const push = (t) => { if (t && window.__seen[window.__seen.length - 1] !== t) window.__seen.push(t); };
  const look = () => {
    const c = document.querySelector(${J(card)});
    if (!c) return;
    c.querySelectorAll('.ans-state, .ans-err').forEach((el) => push(el.textContent.trim()));
    c.querySelectorAll('.dsent').forEach((el) => { if (el.textContent.includes('#${id} ')) push('sent-line: ' + el.textContent.trim()); });
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
  return true;
})()`);

async function openLive(page, url, openDecisions) {
  await page.goto(url);
  return waitFor(page, `document.querySelectorAll(${J(card + ' .dcard .ans-box')}).length === ${openDecisions} && Object.keys(JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}')).length >= 1 && !document.querySelector('#alarm-band,.alarm-row') ? innerWidth + 'x' + innerHeight : null`, 'live page with answer buttons and recorded alarms, no band');
}

const identity = (page) => page.eval(`(() => {
  const c = document.querySelector(${J(card)});
  const title = c && c.querySelector('.ch .title');
  return {
    cardText: c ? c.textContent.replace(/\\s+/g, ' ').slice(0, 300) : null,
    titleText: title ? title.textContent.trim() : null,
    windowIcon: !!(title && title.querySelector('svg use[href="#i-app-window"]')),
    bandPresent: !!document.querySelector('#alarm-band,.alarm-row'),
    seenKeys: Object.keys(JSON.parse(localStorage.getItem('omo-briefing.seenWaiting') || '{}')),
    focusButtons: [...document.querySelectorAll(${J(card + ' .focusbtn')})].length,
    tokenMetas: document.querySelectorAll('meta[name="omo-board-token"]').length,
  };
})()`);

// one click on choice / reply -> confirm -> 보내기; returns what the card showed and the new answer file
async function answerFlow(page, id, how, label) {
  const before = answersSnapshot(STATE);
  if (how.option) {
    await click(page, `${dcard(id)} .ans-opt[data-opt="${how.option}"]`);
  } else {
    await click(page, `${dcard(id)} .ans-write[data-where="dc"]`);
    await waitFor(page, `document.activeElement && document.activeElement.matches('textarea[data-draft="${id}"]')`, 'reply box focused');
    await page.client.send('Input.insertText', { text: how.text });
    const counter = await waitFor(page, `(() => { const el = document.querySelector(${J(dcard(id) + ' .ans-count')}); return el && el.textContent !== '0/500' ? el.textContent : null; })()`, 'reply counter');
    how.counter = counter;
    await click(page, `${dcard(id)} .ans-go[data-act="ans-text"]`);
  }
  const confirmText = await waitFor(page, `(() => { const el = document.querySelector(${J(dcard(id) + ' .ans-confirm')}); return el ? el.textContent : null; })()`, 'confirm row');
  const confirmWindowIcon = await page.eval(`!!document.querySelector(${J(dcard(id) + ' .ans-confirm .ans-q svg use[href="#i-app-window"]')})`);
  await shot(page, `${label}-confirm`, card);
  await recordStates(page, id);
  const sentAt = Date.now();
  await click(page, `${dcard(id)} .ans-go[data-act="ans-send"]`);
  const file = await until(STATE, () => { const d = snapshotDiff(before, answersSnapshot(STATE)); return d.added.length ? d.added : null; }, `answers file for #${id}`);
  const answer = readJson(path.join(STATE, 'answers', file[0]));
  const sentLine = await waitFor(page, `(() => { const el = [...document.querySelectorAll(${J(card + ' .dsent')})].find((x) => x.textContent.includes('#${id} ')); return el ? { text: el.textContent, chip: el.querySelector('.chip') ? el.querySelector('.chip').textContent : '' } : null; })()`, `sent line for #${id}`);
  const seen = await page.eval('window.__seen');
  await shot(page, `${label}-after`, card);
  return { confirmText, confirmWindowIcon, answerFiles: file, answer, msToFile: Date.now() - sentAt, sentLine, seen, counter: how.counter ?? null };
}

// ------------------------------------------------------------------ main

let lead = null;
let page = null;
let evil = null;
let fatal = null;
try {
  const store = openStore(STATE);
  const now = Date.now();
  // the lead conversation's herdr identity (as todo 1's tab reader would have saved it), plus one conversation without it
  store.replace(`sessions/${SID}/meta.json`, { sessionId: SID, title: '상황판 답하기 점검', ...TAB, lastActivityAt: now });
  store.replace('sessions/qa-plain/meta.json', { sessionId: 'qa-plain', cwd: 'C:/work/plain', title: '탭 정보 없는 대화', paneId: 'w1:pR9', lastActivityAt: now - 60_000, lastBriefAt: now - 60_000, workerIds: [], workers: [] });
  store.writeNew('sessions/qa-plain/briefs/000001.json', { at: now - 60_000, brief: { title: '탭 정보 없는 대화', status: 'needs_decision', headline: '결정을 기다립니다', changes: [], done: [], next: '', decisions: [] } });
  store.allocDecisionId({ sessionId: 'qa-plain', ...decisionOf('탭 없는 대화의 질문'), createdAt: now - 60_000, source: 'brief' });

  lead = spawnLead();
  await lead.ready;
  await lead.call('start');
  const server = await until(STATE, () => { const r = readJson(path.join(STATE, 'server.json')); return r.pid === lead.pid && r.port ? r : null; }, 'server.json names the lead');
  const url = `http://127.0.0.1:${server.port}/`;
  await lead.call('brief', { input: {
    title: '상황판 답하기 점검', status: 'needs_decision', headline: '세 가지 결정을 기다립니다', changes: [], done: [], next: '',
    decisions: [decisionOf('첫 질문: 선택지로 답하기', true), decisionOf('두 번째 질문: 답글로 답하기'), decisionOf('세 번째 질문: 위조 시도의 표적')],
  } });
  const meta = readJson(path.join(STATE, 'sessions', SID, 'meta.json'));
  assert.equal(meta.tabLabel, TAB.tabLabel, 'lead kept the seeded tab label');
  assert.ok(meta.answerKinds.includes('text'), 'lead advertises text answers');

  page = await launch({ width: 1280, height: 900 });
  owned.pages.push(page);
  const consoleErrors = [];
  page.client.listeners.set('Runtime.exceptionThrown', [(p) => consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)]);

  // ---- desktop 1280x900: identity, then choice B
  // a card shows its first two open decisions (the third behind [▾ 외 1개]): #idOpt and #idText now, #idForge once idOpt is answered
  const shownIds = () => page.eval(`[...document.querySelectorAll(${J(card + ' .dcard')})].map((el) => Number(el.getAttribute('data-decision')))`);
  const desktopSize = await openLive(page, url, 2);
  const [idOpt, idText] = await shownIds();
  let idForge = null;

  await check('identity-desktop', 'card/focus retain herdr identity and alarms are recorded without a band (desktop 1280x900)', async () => {
    const id = await identity(page);
    assert.equal(desktopSize, '1280x900');
    assert.ok(id.titleText.startsWith('수리 #181 · ') && id.windowIcon, `card identity: ${J(id)}`);
    assert.equal(id.bandPresent, false);
    const plain = await page.eval(`document.querySelector('[data-card="qa-plain"]').textContent`);
    assert.ok(plain.includes('창 w1:pR9 · 탭 정보 없는 대화'), 'card without a herdr tab falls back to the pane');
    assert.ok(id.seenKeys.includes('d' + idOpt) && id.seenKeys.includes('d' + idText), 'waiting alarms are recorded');
    assert.equal(id.tokenMetas, 1);
    assert.ok(id.focusButtons >= 1, 'focus button on the card with a tabId');
    await shot(page, 'desktop-alarm-state');
    await shot(page, 'desktop-card-before', card);
    return { viewport: desktopSize, ...id };
  });

  await check('click-option-desktop', 'click B -> confirm names the tab -> 보내기 -> answers file + live state on the card (desktop)', async () => {
    const r = await answerFlow(page, idOpt, { option: 'B' }, 'desktop');
    assert.ok(r.confirmText.includes('수리 #181') && r.confirmWindowIcon && r.confirmText.includes('B'), `confirm: ${J(r)}`);
    assert.deepEqual({ id: r.answer.id, option: r.answer.option, from: r.answer.fromSessionId }, { id: idOpt, option: 'B', from: 'board' });
    assert.equal(r.seen[0], '보내는 중…', `first state ${J(r.seen)}`);
    assert.match(r.sentLine.chip, /전달|대기/, 'delivery state on the card');
    return { decision: idOpt, ...r };
  });

  // ---- mobile 390x844: identity, then a typed reply
  await page.client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobileSize = await openLive(page, url, 2);
  idForge = (await shownIds()).find((n) => n !== idText && n !== idOpt);
  assert.ok(Number.isInteger(idForge), 'third decision shown once the first is answered');
  await check('identity-mobile', 'card retains herdr identity and alarms remain recorded without a band (mobile 390x844)', async () => {
    const id = await identity(page);
    assert.equal(mobileSize, '390x844');
    assert.ok(id.titleText.startsWith('수리 #181 · ') && id.windowIcon, `card identity: ${J(id)}`);
    assert.equal(id.bandPresent, false);
    assert.ok(id.seenKeys.includes('d' + idText));
    const overflow = await page.eval('document.documentElement.scrollWidth - innerWidth');
    assert.ok(overflow <= 0, `page wider than the viewport by ${overflow}px`);
    await shot(page, 'mobile-alarm-state');
    await shot(page, 'mobile-card-before', card);
    return { viewport: mobileSize, ...id };
  });

  await check('reply-mobile', 'type a reply -> 보내기 -> confirm -> 보내기 -> answers file holds the text verbatim (mobile)', async () => {
    const r = await answerFlow(page, idText, { text: REPLY }, 'mobile');
    assert.ok(r.confirmText.includes('수리 #181') && r.confirmWindowIcon && r.confirmText.includes('답글'), `confirm: ${J(r)}`);
    assert.deepEqual({ id: r.answer.id, text: r.answer.text, from: r.answer.fromSessionId }, { id: idText, text: REPLY, from: 'board' });
    assert.equal(r.seen[0], '보내는 중…', `first state ${J(r.seen)}`);
    assert.ok(r.sentLine.text.includes('<b>굵게</b>'), 'reply shown as text, not markup');
    assert.match(r.sentLine.chip, /전달|대기/);
    return { decision: idText, ...r };
  });
  await page.client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // ---- forgery: another origin, and a file:// copy of the page
  const target = `${url}answer`;
  const body = { id: idForge, sessionId: SID, option: 'A' };
  // the form's body is a complete valid /answer object (a text answer carries the '=' of the name=value encoding), so only
  // the header guards stand between it and a write
  const formBody = { id: idForge, sessionId: SID, text: 'forged=approval' };
  const forgery = [];
  const baseline = answersSnapshot(STATE);
  evil = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(evilPageHtml(target, body, formBody)); });
  owned.servers.push(evil);
  await new Promise((resolve, reject) => { evil.once('error', reject); evil.listen(0, '127.0.0.1', resolve); });
  const evilUrl = `http://127.0.0.1:${evil.address().port}/`;

  await check('forge-other-origin', 'page on another port: no-cors fetch and form POST write nothing', async () => {
    await page.goto(evilUrl);
    const r = await page.eval('window.__attack()');
    forgery.push({ attempt: 'other-origin no-cors fetch', origin: evilUrl, result: r.noCorsFetch });
    forgery.push({ attempt: 'other-origin form POST (text/plain, valid answer JSON)', origin: evilUrl, result: r.formPost, body: formBody });
    // the requests left the browser and the board answered them (opaque response / iframe load), so "nothing written" is a refusal
    assert.equal(r.noCorsFetch, 'resolved:opaque');
    assert.equal(r.formPost, 'iframe-loaded');
    const d = snapshotDiff(baseline, answersSnapshot(STATE));
    assert.equal(d.writes, 0, `answers changed: ${J(d)}`);
    return { origin: evilUrl, ...r, writes: d.writes };
  });

  await check('forge-file-copy', 'file:// copy of the page (with the leaked token): fetches write nothing', async () => {
    const served = (await httpGet(url)).body;
    const token = /<meta name="omo-board-token" content="([^"]+)">/.exec(served)?.[1] ?? '';
    assert.ok(token.length >= 40, 'served page carries the token');
    const forgeDir = path.join(TMP, 'forge');
    mkdirSync(forgeDir, { recursive: true });
    const copy = path.join(forgeDir, 'index.html');
    copyFileSync(path.join(STATE, 'index.html'), copy);
    const html = readFileSync(copy, 'utf8');
    assert.ok(!html.includes(token), 'the file page itself has no token');
    writeFileSync(copy, html.replace('</body>', `${formHtml(target, formBody)}<script>${attackScript(target, body, { token })}</script></body>`));
    await page.goto(pathToFileURL(copy).href);
    const r = await page.eval('window.__attack()');
    forgery.push({ attempt: 'file:// copy no-cors fetch + CORS fetch with leaked X-Board-Token + form POST', origin: 'file://', result: r });
    const d = snapshotDiff(baseline, answersSnapshot(STATE));
    assert.equal(d.writes, 0, `answers changed: ${J(d)}`);
    assert.match(r.corsTokenFetch, /^rejected:/, 'the token-carrying CORS request is blocked (OPTIONS 405, no CORS headers)');
    return { ...r, writes: d.writes };
  });

  await check('file-page-readonly', 'file:// page: no answer buttons, read-only notice', async () => {
    await page.goto(pathToFileURL(path.join(STATE, 'index.html')).href);
    const r = await waitFor(page, `(() => { const n = document.querySelector('.note.ro'); return n ? { notice: n.textContent, buttons: document.querySelectorAll('.ans-opt, .ans-write, .ans-go, .focusbtn').length, tokenMetas: document.querySelectorAll('meta[name="omo-board-token"]').length } : null; })()`, 'read-only notice');
    assert.equal(r.buttons, 0);
    assert.equal(r.tokenMetas, 0);
    assert.ok(r.notice.includes('/decide'));
    await shot(page, 'file-readonly');
    return r;
  });

  const after = answersSnapshot(STATE);
  results.forgery = { attempts: 3, writes: snapshotDiff(baseline, after).writes, requests: forgery, decisionStillOpen: !Object.keys(after).some((n) => Number(n.slice(0, 6)) === idForge) };

  // ---- the forgery target is the conversation's LAST open decision: answering it files the conversation under 진행 중 in the
  // next model; the owner, still looking at the overview, must keep seeing the card and its live delivery line (IS-6)
  await check('last-decision-desktop', 'answer the last open decision: after the model moves the conversation, its card and delivery line stay on the overview (desktop)', async () => {
    assert.equal(results.forgery.decisionStillOpen, true, 'forgery target still open before the real answer');
    await openLive(page, url, 1);
    const modelTab = `(window.BriefPage.state.model.sessions.find((s) => s.id === ${J(SID)}) || {}).tab`;
    const tabBefore = await page.eval(modelTab);
    const r = await answerFlow(page, idForge, { option: 'A' }, 'desktop-last');
    assert.deepEqual({ id: r.answer.id, option: r.answer.option, from: r.answer.fromSessionId }, { id: idForge, option: 'A', from: 'board' });
    // wait for the SSE model that answered it and moved the conversation; then look, with no reload and no tab click
    const tabAfter = await waitFor(page, `(() => { const m = window.BriefPage.state.model; const s = m && m.sessions.find((x) => x.id === ${J(SID)}); const d = s && (s.decisions || []).find((x) => x.id === ${idForge}); return d && d.answered === true && s.tab !== ${J(tabBefore)} ? s.tab : null; })()`, 'model with the last decision answered');
    const surface = await page.eval(`(() => {
      const c = document.querySelector(${J(card)});
      const line = c && [...c.querySelectorAll('.dsent')].find((x) => x.textContent.includes('#${idForge} '));
      return { shownView: document.querySelector('[data-shell]').getAttribute('data-view'), activeSession: window.BriefPage.state.ui.active, overviewShown: !!document.querySelector('#main > .overview'), cardShown: !!c, line: line ? line.textContent.replace(/\\s+/g, ' ').trim() : '', chip: line && line.querySelector('.chip') ? line.querySelector('.chip').textContent : '' };
    })()`);
    await shot(page, 'desktop-last-model', card);
    assert.equal(surface.shownView, 'conv', 'the owner stays in the conversation view');
    assert.equal(surface.activeSession, null, 'no conversation was opened on the owner');
    assert.equal(surface.overviewShown, true, 'the owner stays on the overview');
    assert.equal(surface.cardShown, true, `answered card still on the screen after the model moved it to ${tabAfter}`);
    assert.match(surface.chip, /전달|대기/, `delivery state on the card: ${J(surface)}`);
    assert.equal(r.seen[0], '보내는 중…', `first state ${J(r.seen)}`);
    return { decision: idForge, modelTabBefore: tabBefore, modelTabAfter: tabAfter, surface, ...r };
  });
  results.pageExceptions = consoleErrors;
  // what the card's 오류 있음 chip (if any) is about: the lead's own per-source errors (src/errors.mjs)
  results.leadErrors = readJson(path.join(STATE, 'sessions', SID, 'meta.json')).errors ?? null;
} catch (err) {
  fatal = err;
  console.error('FATAL', err);
}

// ------------------------------------------------------------------ cleanup: every page, server, process and folder this run made
const cleanup = { errors: [] };
for (const p of owned.pages) {
  try {
    await p.close();
  } catch (err) {
    cleanup.closeWarnings = [...(cleanup.closeWarnings ?? []), `chrome ${p.pid}: ${err.message}`];
  }
  cleanup[`chrome ${p.pid}`] = isPidAlive(p.pid) ? 'ALIVE' : 'gone';
  cleanup[`profile ${p.profileDir}`] = existsSync(p.profileDir) ? 'EXISTS' : 'removed';
}
for (const s of owned.servers) await new Promise((resolve) => s.close(() => resolve()));
if (lead) {
  try { await lead.call('shutdown', { disconnectAfterReply: true }); } catch (err) {
    cleanup.errors.push(`lead shutdown: ${err.message}`);
    try { if (lead.child.connected) lead.child.disconnect(); } catch (err) { cleanup.errors.push(`lead disconnect: ${err.message}`); }
  }
  let timer;
  try {
    const { code, signal } = await Promise.race([lead.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('lead close: no original close in 10s')), 10_000);
    })]);
    assert.equal(code, 0, 'lead close code');
    assert.equal(signal, null, 'lead close signal');
  } catch (err) {
    cleanup.errors.push(`lead close: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
for (const pid of owned.pids) cleanup[`lead ${pid}`] = isPidAlive(pid) ? 'ALIVE' : 'gone';
try { rmSync(TMP, { recursive: true, force: true }); } catch (err) { cleanup.errors.push(`rm ${TMP}: ${err.message}`); }
cleanup[`temp ${TMP}`] = existsSync(TMP) ? 'EXISTS' : 'removed';
cleanup.clean = cleanup.errors.length === 0 && Object.entries(cleanup).every(([k, v]) => k === 'errors' || k === 'closeWarnings' || v === 'gone' || v === 'removed');

const checkIds = ['identity-desktop', 'click-option-desktop', 'identity-mobile', 'reply-mobile', 'forge-other-origin', 'forge-file-copy', 'file-page-readonly', 'last-decision-desktop'];
const pass = !fatal && checkIds.every((id) => results[id]?.pass) && results.forgery?.attempts === 3 && results.forgery?.writes === 0
  && results.pageExceptions?.length === 0 && Object.keys(shots).length >= 4 && cleanup.clean;
const doc = {
  pass, finishedAt: new Date().toISOString(), fatal: fatal ? String(fatal.stack || fatal) : null,
  viewports: { desktop: '1280x900', mobile: '390x844' }, checks: results, screenshots: shots, cleanup,
};
writeFileSync(SUMMARY, JSON.stringify(doc, null, 2));
console.log(pass ? 'ALL PASS' : 'FAILED');
process.exit(pass ? 0 : 1);
