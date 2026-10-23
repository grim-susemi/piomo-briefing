#!/usr/bin/env node
// Real-browser acceptance for the folded-conversation board (plan todo 9).
//
// One owned headless Chrome through scripts/cdp.mjs. A real store written by
// test/fixtures/stale-cards-200.mjs into an owned temp folder, a real
// createServerHost board (port window OMO_BRIEFING_PORT_BASE default 49120,
// refused unless the ten-port window is inside 49100-49129), and one legacy
// createBoardServer without getConvo for the restart-hint case. No live board,
// no live state and no owner profile is touched.
//
// usage: node scripts/qa-fold.mjs --out <dir>
//        node scripts/qa-fold.mjs --out <dir> --no-cache
//
//   <dir>/result.json                 positive run: every scenario pass/fail with its measurements
//   <dir>/capture-index.json         the 42-cell matrix (7 views x 3 viewports x 2 themes) plus extras
//   <dir>/matrix-proof.json          required/captured keys, file hashes and PNG dimensions
//   <dir>/sweep.json                 programmatic overflow/target/contrast/focus/CJK sweep
//   <dir>/cleanup.json               process/profile/port/temp receipts
//   <dir>/*.png                      the 42 required captures and interaction extras
//
// --no-cache is the intended negative run: it disables the page's full-card
// cache in this owned page harness only (never product code) and writes
// negative-result.json instead of result.json. fold-live must FAIL there.
//
// Every wait is subscribed before its trigger and bounded; there are no fixed
// sleeps or polling loops. A failed check is recorded as a failed scenario,
// never swallowed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import netModule from 'node:net';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { launch, isPidAlive, listProfilePids, watchCsp, axSnapshot, unnamedInteractive } from './cdp.mjs';
import { openStore } from '../src/store.mjs';
import { buildViewModel, projectBoardModel, renderPage, pageHtml, withReports, MAX_VM_BYTES } from '../src/render.mjs';
import { createServerHost } from '../src/server-host.mjs';
import { createBoardServer } from '../src/server.mjs';
import { make, NOW, renderOptions, expectedFoldedIds } from '../test/fixtures/stale-cards-200.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const J = JSON.stringify;
const DAY = 86_400_000;
const PORTS = 10;
const PORT_MIN = 49100;
const PORT_MAX = 49129;
const GENERATION = 8;
const REQUIRED_VIEWS = ['overview', 'folded-before-load', 'folded-after-load', 'closedwindow', 'previousconvo', 'filepage', 'restarthint'];
const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900, dpr: 1, mobile: false },
  { name: '1024x768', width: 1024, height: 768, dpr: 1, mobile: false },
  { name: '390x844', width: 390, height: 844, dpr: 3, mobile: true },
];
const THEMES = ['light', 'dark'];
const RESTART_HINT = '이 상황판 서버는 접은 대화 펼치기를 모르는 이전 세대입니다. 대화를 재시작하면 최신 상황판이 열립니다.';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};
const OUT = path.resolve(arg('--out') || '');
const NEGATIVE = argv.includes('--no-cache');
const PROBE_ONLY = argv.includes('--probe-only');
const ATTEMPT3_PROBE = argv.includes('--attempt3-probe');
const REUSE_DIR = arg('--reuse-captures') ? path.resolve(arg('--reuse-captures')) : '';
if (REUSE_DIR && (NEGATIVE || PROBE_ONLY)) {
  console.error('--reuse-captures is a full positive-run option; the negative and probe-only runs never reuse captures');
  process.exit(2);
}
if (NEGATIVE && PROBE_ONLY) {
  console.error('--no-cache and --probe-only are separate runs');
  process.exit(2);
}
if (!OUT) {
  console.error('usage: node scripts/qa-fold.mjs --out <dir> [--no-cache]');
  process.exit(2);
}
const BASE = Number(process.env.OMO_BRIEFING_PORT_BASE || 49120);
if (!Number.isInteger(BASE) || BASE < PORT_MIN || BASE + PORTS - 1 > PORT_MAX) {
  console.error(`OMO_BRIEFING_PORT_BASE=${process.env.OMO_BRIEFING_PORT_BASE}: needs a ten-port window inside ${PORT_MIN}-${PORT_MAX}`);
  process.exit(2);
}
const LEGACY_BASE = [49100, 49110, 49120].find((b) => b + PORTS - 1 <= PORT_MAX && (b + PORTS - 1 < BASE || b > BASE + PORTS - 1));
if (LEGACY_BASE === undefined) {
  console.error(`no free ten-port window for the legacy host inside ${PORT_MIN}-${PORT_MAX} next to ${BASE}`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const OUT_NEG = path.join(OUT, 'negative');
if (NEGATIVE) fs.mkdirSync(OUT_NEG, { recursive: true });

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const pending = (promise) => { promise.catch(() => {}); return promise; };
const nowIso = () => new Date().toISOString();
const writeJson = (name, value) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n');
const writeNegJson = (name, value) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n');

function httpRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      agent: false,
      headers: { Connection: 'close', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: bytes.toString('utf8'), bytes });
      });
      res.on('error', reject);
    });
    req.setTimeout(8000, () => req.destroy(new Error(`HTTP ${method} ${url} had no answer in 8s`)));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const results = {};
const scenarioOrder = [];
const captures = [];
const extras = [];
const matrixFailures = [];
const consoleErrors = [];
const pageExceptions = [];
const hostErrors = [];
const legacyErrors = [];
const chromeRuns = [];
const owned = { tempDirs: [], profiles: [], pids: [] };
let phase = 'setup';
let page = null;
let csp = null;
let host = null;
let legacy = null;
let store = null;
let fixture = null;
let projected = null;
let fullModel = null;
let TMP = null;
let STATE = null;
let SERVER_URL = '';
let LEGACY_URL = '';
let FILE_URL = '';
let convoLog = [];
let convoWaiters = [];
// One-shot fault injection for the round-2 evidence states. It never mutates a store or a product file: the wrapper
// substitutes a failed getConvo response or throws a marked error that the host turns into an HTTP 500.
const failControl = { mode: '', sid: '' };
let probeDebug = null;
let holds = [];
let hostChanges = [];
let hostWaiters = [];
let net = { requests: [], waiters: [] };
let build = null;
let fixtureStats = null;
let integration = null;
let baseEvidence = null;
let cleanup = null;
let startedAt = 0;

function scenarioResult(id, title, durationMs, value, error) {
  results[id] = error
    ? { id, title, pass: false, durationMs, error: String((error && error.stack) || error) }
    : { id, title, pass: true, durationMs, ...(value && typeof value === 'object' ? value : {}) };
  scenarioOrder.push(id);
}

async function scenario(id, title, fn) {
  const begin = Date.now();
  try {
    const value = await fn();
    scenarioResult(id, title, Date.now() - begin, value, null);
    console.log(`PASS ${id}`);
  } catch (error) {
    scenarioResult(id, title, Date.now() - begin, null, error);
    console.error(`FAIL ${id}: ${(error && error.message) || error}`);
  }
}

function eventOn(target, method, fn) {
  const list = target.listeners.get(method) || [];
  list.push(fn);
  target.listeners.set(method, list);
}

function addNet(rec) {
  net.requests.push(rec);
  for (const waiter of [...net.waiters]) {
    let hit = false;
    try { hit = waiter.pred(rec); } catch (error) { hit = false; waiter.reject(error); }
    if (!hit) continue;
    net.waiters = net.waiters.filter((x) => x !== waiter);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(rec);
  }
}

function waitNetAfter(start, pred, label, ms = 20000) {
  const found = net.requests.slice(start).find(pred);
  if (found) return Promise.resolve(found);
  return pending(new Promise((resolve, reject) => {
    const waiter = { pred, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      net.waiters = net.waiters.filter((x) => x !== waiter);
      reject(new Error(`timeout ${ms}ms waiting for ${label}`));
    }, ms);
    net.waiters.push(waiter);
  }));
}

function addConvo(rec) {
  convoLog.push(rec);
  for (const waiter of [...convoWaiters]) {
    let hit = false;
    try { hit = waiter.pred(rec); } catch (error) { hit = false; waiter.reject(error); }
    if (!hit) continue;
    convoWaiters = convoWaiters.filter((x) => x !== waiter);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(rec);
  }
}

function waitConvoAfter(start, pred, label, ms = 30000) {
  const found = convoLog.slice(start).find(pred);
  if (found) return Promise.resolve(found);
  return pending(new Promise((resolve, reject) => {
    const waiter = { pred, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      convoWaiters = convoWaiters.filter((x) => x !== waiter);
      reject(new Error(`timeout ${ms}ms waiting for ${label}`));
    }, ms);
    convoWaiters.push(waiter);
  }));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function armConvoHold() {
  const hold = deferred();
  holds.push(hold);
  return hold;
}

function releaseHolds() {
  for (const hold of holds) {
    try { hold.resolve(); } catch { /* already settled */ }
  }
  holds = [];
}

function addHostChange(status) {
  hostChanges.push(status);
  for (const waiter of [...hostWaiters]) {
    let hit = false;
    try { hit = waiter.pred(status); } catch (error) { hit = false; waiter.reject(error); }
    if (!hit) continue;
    hostWaiters = hostWaiters.filter((x) => x !== waiter);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(status);
  }
}

function waitHostAfter(start, pred, label, ms = 15000) {
  const found = hostChanges.slice(start).find(pred);
  if (found) return Promise.resolve(found);
  return pending(new Promise((resolve, reject) => {
    const waiter = { pred, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      hostWaiters = hostWaiters.filter((x) => x !== waiter);
      reject(new Error(`timeout ${ms}ms waiting for ${label}`));
    }, ms);
    hostWaiters.push(waiter);
  }));
}

async function pageEval(expression) {
  return page.eval(expression);
}

async function click(selector, label = selector) {
  const ok = await pageEval(`(() => { const el = document.querySelector(${J(selector)}); if (!el) return false; el.click(); return true; })()`);
  assert.equal(ok, true, `missing click target: ${label}`);
}

async function focusClick(selector, label = selector) {
  const ok = await pageEval(`(() => { const el = document.querySelector(${J(selector)}); if (!el) return false; el.focus(); el.click(); return true; })()`);
  assert.equal(ok, true, `missing focus target: ${label}`);
}

async function setSearch(text) {
  const ok = await pageEval(`(() => { const el = document.querySelector('#sh-q'); if (!el) return false; el.value = ${J(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  assert.equal(ok, true, 'missing sidebar search input');
}

async function waitDom(expression, label, ms = 20000) {
  const source = `new Promise((resolve, reject) => {
    let obs = null, timer = null, done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (obs) obs.disconnect();
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const check = () => {
      let value;
      try { value = (${expression}); } catch (err) { finish(reject, err); return; }
      if (value) finish(resolve, true);
    };
    obs = new MutationObserver(check);
    obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(() => finish(reject, new Error(${J(`timeout waiting for ${label}`)})), ${ms});
    check();
  })`;
  return pageEval(source);
}

async function waitFrames(count = 2) {
  return pageEval(`new Promise((resolve) => {
    let left = ${count};
    const tick = () => { if (--left <= 0) resolve(true); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })`);
}

async function waitFonts() {
  return pageEval('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true');
}

async function applyViewport(vp) {
  await page.client.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile,
    screenWidth: vp.width, screenHeight: vp.height,
  });
  await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: vp.mobile, maxTouchPoints: vp.mobile ? 5 : 1 });
  await page.client.send('Emulation.setEmitTouchEventsForMouse', { enabled: vp.mobile, configuration: 'mobile' });
  const measured = await pageEval('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints })');
  assert.equal(measured.w, vp.width, 'viewport width');
  assert.equal(measured.h, vp.height, 'viewport height');
  assert.equal(measured.dpr, vp.dpr, 'device pixel ratio');
  if (vp.mobile) assert.ok(measured.maxTouchPoints > 0, 'mobile touch emulation');
  return measured;
}

async function setTheme(theme, motion = 'no-preference') {
  await page.client.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: motion },
    ],
  });
}

async function loadUrl(url, vp, theme, { motion = 'no-preference', clear = true } = {}) {
  await applyViewport(vp);
  await setTheme(theme, motion);
  if (clear) {
    await page.goto(url);
    await pageEval('try { localStorage.clear(); sessionStorage.clear(); } catch (err) { /* file origin can refuse */ } true');
  }
  const start = net.requests.length;
  const hostStart = hostChanges.length;
  await page.goto(url);
  await waitFonts();
  const ready = await pageEval('!!(window.BriefPage && BriefPage.state && BriefPage.state.model && Array.isArray(BriefPage.state.model.sessions))');
  assert.equal(ready, true, `page not started: ${url}`);
  const media = await pageEval('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, dark: matchMedia("(prefers-color-scheme: dark)").matches, reduce: matchMedia("(prefers-reduced-motion: reduce)").matches })');
  assert.equal(media.w, vp.width, 'page width after load');
  assert.equal(media.h, vp.height, 'page height after load');
  assert.equal(media.dpr, vp.dpr, 'page dpr after load');
  assert.equal(media.dark, theme === 'dark', 'theme emulation');
  assert.equal(media.reduce, motion === 'reduce', 'reduced-motion emulation');
  if (url.startsWith('http')) {
    const origin = new URL(url).origin;
    await waitNetAfter(start, (r) => r.url.startsWith(origin) && new URL(r.url).pathname === '/events', 'SSE /events');
  }
  return media;
}

async function scrollTo(selector, label = selector) {
  const ok = await pageEval(`(() => { const el = document.querySelector(${J(selector)}); if (!el) return false; el.scrollIntoView({ block: 'center', inline: 'nearest' }); return true; })()`);
  assert.equal(ok, true, `missing scroll target: ${label}`);
  await waitFrames(2);
}

async function scrollFirstFoldCard() {
  const ok = await pageEval(`(() => { const el = document.querySelector('#main .cv-fold-counts'); if (!el) return false; (el.closest('[data-card]') || el).scrollIntoView({ block: 'center' }); return true; })()`);
  assert.equal(ok, true, 'missing folded overview card');
  await waitFrames(2);
}

async function scrollFirstSideFold() {
  const ok = await pageEval(`(() => { const el = document.querySelector('#side .sh-fold'); if (!el) return false; (el.closest('.sh-row') || el).scrollIntoView({ block: 'center' }); return true; })()`);
  assert.equal(ok, true, 'missing folded sidebar row');
  await waitFrames(2);
}

async function parkPointer(vp) {
  await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.max(1, vp.width - 2), y: 2, button: 'none' });
}

function modeOf(view) {
  if (view === 'filepage') return 'file';
  if (view === 'restarthint') return 'legacy';
  return 'server';
}

function pngInfo(buffer) {
  if (buffer.length < 33 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(off);
    const type = buffer.toString('ascii', off + 4, off + 8);
    const data = buffer.subarray(off + 8, off + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + length;
  }
  assert.equal(bitDepth, 8, 'PNG bit depth');
  assert.equal(interlace, 0, 'PNG interlace');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  assert.ok(channels, `PNG color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value = (value + a) & 255;
      else if (filter === 2) value = (value + b) & 255;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else assert.equal(filter, 0, `PNG filter ${filter}`);
      cur[x] = value;
    }
  }
  const pixel = (x, y) => {
    const i = (y * width + x) * channels;
    return channels === 1 ? [out[i], out[i], out[i], 255] : [out[i], out[i + 1], out[i + 2], channels === 4 ? out[i + 3] : 255];
  };
  const step = Math.max(1, Math.floor(Math.min(width, height) / 80));
  const colors = new Map();
  let samples = 0, alphaMin = 255;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const [r, g, b, a] = pixel(x, y);
      const key = `${r},${g},${b}`;
      colors.set(key, (colors.get(key) || 0) + 1);
      samples++;
      if (a < alphaMin) alphaMin = a;
    }
  }
  const maxCount = Math.max(...colors.values());
  const bg = pixel(2, height - 2);
  const center = pixel(Math.floor(width / 2), Math.floor(height / 2));
  return {
    width, height, bitDepth, colorType,
    uniqueColors: colors.size,
    dominantRatio: maxCount / samples,
    alphaMin,
    bg: { r: bg[0], g: bg[1], b: bg[2], a: bg[3] },
    center: { r: center[0], g: center[1], b: center[2], a: center[3] },
    nonBlank: colors.size >= 8 && maxCount / samples < 0.98,
  };
}

// A second, small PNG decoder for actual-pixel colour evidence. pngInfo stays serializable and unchanged; this one
// exposes every pixel for the marker-contrast probe (the round-1 review measured 3.1992:1 from solid glyph interiors).
function decodePng(buffer) {
  if (buffer.length < 33 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(off);
    const type = buffer.toString('ascii', off + 4, off + 8);
    const data = buffer.subarray(off + 8, off + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + length;
  }
  assert.equal(bitDepth, 8, 'PNG bit depth');
  assert.equal(interlace, 0, 'PNG interlace');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  assert.ok(channels, `PNG color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value = (value + a) & 255;
      else if (filter === 2) value = (value + b) & 255;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else assert.equal(filter, 0, `PNG filter ${filter}`);
      cur[x] = value;
    }
  }
  return { width, height, channels, bitDepth, colorType, data: out };
}
function pngPixels(buffer) {
  const img = decodePng(buffer);
  const { width, height, channels, data } = img;
  const pixel = (x, y) => {
    const i = (y * width + x) * channels;
    return channels === 1 ? { r: data[i], g: data[i], b: data[i], a: 255 } : { r: data[i], g: data[i + 1], b: data[i + 2], a: channels === 4 ? data[i + 3] : 255 };
  };
  return { width, height, channels, pixel };
}
function pixelContrast(buffer, region) {
  const img = pngPixels(buffer);
  const x0 = region ? Math.max(0, Math.min(img.width - 1, Math.round(region.x))) : 0;
  const y0 = region ? Math.max(0, Math.min(img.height - 1, Math.round(region.y))) : 0;
  const width = region ? Math.max(1, Math.min(img.width - x0, Math.round(region.width))) : img.width;
  const height = region ? Math.max(1, Math.min(img.height - y0, Math.round(region.height))) : img.height;
  const colors = new Map();
  for (let y = y0; y < y0 + height; y++) for (let x = x0; x < x0 + width; x++) {
    const p = img.pixel(x, y);
    const key = `${p.r},${p.g},${p.b}`;
    const item = colors.get(key) || { r: p.r, g: p.g, b: p.b, count: 0 };
    item.count++;
    colors.set(key, item);
  }
  const list = [...colors.values()].sort((a, b) => b.count - a.count);
  const background = list[0];
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  let foreground = null;
  for (const item of list) {
    if (item.count < 3) continue;
    const value = ratio(item, background);
    if (!foreground || value > foreground.ratio) foreground = { ...item, ratio: value };
  }
  return {
    width, height, x: x0, y: y0, colors: list.length,
    background: { r: background.r, g: background.g, b: background.b, count: background.count },
    foreground: foreground ? { r: foreground.r, g: foreground.g, b: foreground.b, count: foreground.count } : null,
    ratio: foreground ? foreground.ratio : 1,
  };
}
async function clippedPng(rect, dpr, name) {
  // The CDP clip is unreliable under the 390 mobile emulation (it returned an all-background region even at
  // scale 1). Capture the real viewport and sample the marker's CSS rect multiplied by the emulated DPR, the
  // same method the independent reviewer used on the 390 PNGs.
  const file = path.join(OUT, name);
  await page.screenshot(file);
  const buffer = fs.readFileSync(file);
  return { buffer, file, info: pngInfo(buffer), region: { x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr), width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) } };
}
// Shared by the round-2 probe and the full marker scenario: geometry, title budget and typography of one caller row.
async function measureFoldRow(selector) {
  return pageEval(`(() => {
    const fold = document.querySelector(${J(selector)});
    if (!fold) return { selector: ${J(selector)}, missing: true };
    const row = fold.closest('.sh-row');
    const go = fold.closest('.sh-go') || row;
    const title = go ? go.querySelector('.sh-t') : null;
    const fr = fold.getBoundingClientRect();
    const rr = row ? row.getBoundingClientRect() : null;
    const gr = go ? go.getBoundingClientRect() : null;
    const tr = title ? title.getBoundingClientRect() : null;
    const hit = document.elementFromPoint(Math.round(fr.x + fr.width / 2), Math.round(fr.y + fr.height / 2));
    const inside = (r) => !!r && fr.width > 0 && fr.height > 0 && fr.x >= r.x - 1 && fr.x + fr.width <= r.x + r.width + 1 && fr.y >= r.y - 1 && fr.y + fr.height <= r.y + r.height + 1;
    const fcs = getComputedStyle(fold);
    const tcs = title ? getComputedStyle(title) : null;
    return {
      selector: ${J(selector)}, text: fold.textContent,
      row: row ? row.getAttribute('data-row') : null,
      foldRect: { x: Math.round(fr.x), y: Math.round(fr.y), width: Math.round(fr.width), height: Math.round(fr.height) },
      rowRect: rr ? { x: Math.round(rr.x), y: Math.round(rr.y), width: Math.round(rr.width), height: Math.round(rr.height) } : null,
      goRect: gr ? { x: Math.round(gr.x), y: Math.round(gr.y), width: Math.round(gr.width), height: Math.round(gr.height) } : null,
      rowVisible: inside(rr), goVisible: inside(gr),
      hit: !!hit && (hit === fold || fold.contains(hit)),
      insideTitle: !!fold.closest('.sh-t'), insideSub: !!fold.closest('.sh-sub'),
      foldFont: parseFloat(fcs.fontSize), foldColor: fcs.color, foldOpacity: fcs.opacity,
      rowOpacity: row ? getComputedStyle(row).opacity : null,
      title: title ? {
        text: title.textContent.slice(0, 80), full: title.getAttribute('title'),
        width: Math.round(tr.width * 10) / 10, clientWidth: title.clientWidth, scrollWidth: title.scrollWidth,
        font: parseFloat(tcs.fontSize), opacity: tcs.opacity,
      } : null,
    };
  })()`);
}

async function capture(view, vp, theme, prep, options = {}) {
  const required = options.required !== false;
  const name = options.file || `${modeOf(view)}-${view}-${vp.name}-${theme}.png`;
  await setTheme(theme, options.motion || 'no-preference');
  await waitFrames(2);
  if (options.park !== false) await parkPointer(vp);
  await waitFrames(1);
  await page.screenshot(path.join(OUT, name));
  const buffer = fs.readFileSync(path.join(OUT, name));
  const info = pngInfo(buffer);
  const expected = { width: vp.width, height: vp.height, dpr: vp.dpr, pixelWidth: vp.width * vp.dpr, pixelHeight: vp.height * vp.dpr };
  assert.equal(info.width, expected.pixelWidth, `${name}: PNG width ${info.width}, expected ${expected.pixelWidth}`);
  assert.equal(info.height, expected.pixelHeight, `${name}: PNG height ${info.height}, expected ${expected.pixelHeight}`);
  assert.equal(info.nonBlank, true, `${name}: screenshot is blank or uncomposited`);
  const record = {
    view,
    kind: options.kind || 'matrix',
    required,
    mode: modeOf(view),
    viewport: { name: vp.name, width: vp.width, height: vp.height, dpr: vp.dpr, mobile: vp.mobile },
    theme,
    file: name,
    sha256: sha256(buffer),
    bytes: buffer.length,
    expected,
    png: info,
    stateCheck: prep.stateCheck,
    scroll: prep.scroll || 'default',
    captureApi: 'Page.captureScreenshot',
    buildId: build && build.buildId,
    at: nowIso(),
  };
  if (required) captures.push(record); else extras.push(record);
  return record;
}

// ------------------------------------------------------------------ fixture, host and page setup

function createMainHost() {
  const errors = [];
  const main = createServerHost({
    stateDir: STATE,
    sessionId: 'qa-fold',
    generation: GENERATION,
    installedGeneration: async () => null,
    isEnabled: () => true,
    readSnapshot: () => withReports(store, store.readSnapshot()),
    buildViewModel: (snap, now) => buildViewModel(snap, now, { ...renderOptions, stateDir: STATE }),
    buildFull: (snap, now) => buildViewModel(snap, now, { ...renderOptions, stateDir: STATE, full: true }),
    project: (full, now) => projectBoardModel(full, now),
    getPage: (vm, token, nonce) => pageHtml(vm, GENERATION, { mode: 'server', token, nonce }),
    answer: () => ({ status: 500, json: { ok: false, code: 'QA_NO_WRITE' } }),
    focus: () => ({ status: 500, json: { ok: false, code: 'QA_NO_WRITE' } }),
    reclaimStale: (rel, rec) => store.reclaimStale(rel, rec),
    onError: (key, error) => { const message = String((error && error.message) || error); const expected = /QA_FORCE_HTTP_500/.test(message); errors.push({ key, message, expected }); hostErrors.push({ key, message, expected }); },
    onChange: addHostChange,
    env: { OMO_BRIEFING_PORT_BASE: String(BASE) },
    now: () => NOW,
    timers: { setInterval, clearInterval, setTimeout, clearTimeout },
    createBoardServer: (options) => {
      const real = options.getConvo;
      options.getConvo = async (sid) => {
        addConvo({ sid, at: Date.now() });
        if (failControl.mode && (!failControl.sid || failControl.sid === sid)) {
          const mode = failControl.mode;
          failControl.mode = '';
          failControl.sid = '';
          if (mode === 'http500') {
            const error = new Error('QA_FORCE_HTTP_500');
            error.expected = true;
            throw error;
          }
          if (mode === 'payload') return { schema: 1, gen: GENERATION, key: 'qa-bad-payload', session: { id: sid } };
        }
        const card = await real(sid);
        const hold = holds.shift();
        if (hold) await hold.promise;
        return card;
      };
      return createBoardServer(options);
    },
  });
  return { host: main, errors };
}

async function startLegacy() {
  const vm = buildViewModel(withReports(store, store.readSnapshot()), NOW, { ...renderOptions, stateDir: STATE });
  const server = createBoardServer({
    getPage: async ({ nonce }) => pageHtml(vm, GENERATION, { mode: 'server', nonce }),
    getViewModel: async () => vm,
    generation: GENERATION,
    portBase: LEGACY_BASE,
    portCount: PORTS,
    onError: (key, error) => { legacyErrors.push({ key, message: String((error && error.message) || error) }); },
  });
  const address = await server.start();
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function setup({ withLegacy }) {
  startedAt = Date.now();
  phase = 'setup';
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-qa-fold-'));
  owned.tempDirs.push(TMP);
  STATE = path.join(TMP, 'state');
  fs.mkdirSync(STATE, { recursive: true });
  fixture = make(STATE);
  store = openStore(STATE);
  const options = { ...renderOptions, stateDir: STATE };
  const snapshot = () => withReports(store, store.readSnapshot());
  fullModel = buildViewModel(snapshot(), NOW, { ...options, full: true });
  projected = projectBoardModel(fullModel, NOW, {});
  const published = renderPage(store, NOW, { ...options, generation: GENERATION });
  assert.equal(published.ok, true, `initial renderPage failed: ${published.error}`);
  const dataBytes = fs.statSync(path.join(STATE, 'data.js')).size;
  const foldedBytes = fs.statSync(path.join(STATE, 'folded.js')).size;
  assert.ok(dataBytes <= MAX_VM_BYTES, `data.js ${dataBytes} > ${MAX_VM_BYTES}`);
  assert.ok(foldedBytes > MAX_VM_BYTES, `folded.js ${foldedBytes} does not carry the over-cap big card`);
  assert.equal(projected.sessions.length, 200);
  assert.equal(projected.sessions.filter((s) => s.folded).length, expectedFoldedIds.length);
  assert.deepEqual(projected.sessions.filter((s) => s.folded).map((s) => s.id).sort(), [...expectedFoldedIds].sort());
  const gitHead = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const integrationPath = process.env.QA_INTEGRATION || path.resolve(OUT, '..', 'task-1', 'integration.json');
  integration = fs.existsSync(integrationPath) ? JSON.parse(fs.readFileSync(integrationPath, 'utf8')) : null;
  const productFiles = ['src/page/page.js', 'src/page/convo-view.js', 'src/page/shell.js', 'src/page/shell.css', 'src/page/page.css'];
  const productSource = Object.fromEntries(productFiles.map((file) => [file, sha256(fs.readFileSync(path.join(ROOT, file)))]));
  const qaScriptSha256 = sha256(fs.readFileSync(SELF));
  const contentHash = sha256(fs.readFileSync(path.join(STATE, 'data.js')));
  build = {
    gitHead, base: integration && integration.base, qaScriptSha256, contentHash,
    buildId: sha256(`${gitHead}\n${qaScriptSha256}\n${contentHash}`).slice(0, 20),
    generation: GENERATION,
    dataJsBytes: dataBytes,
    foldedJsBytes: foldedBytes,
    foldedKey: projected.foldedKey,
    productSource,
    productSourceHash: sha256(JSON.stringify(productSource)),
    trackedDirty: spawnSync('git', ['-C', ROOT, 'status', '--short', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim(),
  };
  fixtureStats = {
    sessions: projected.sessions.length,
    folded: projected.sessions.filter((s) => s.folded).length,
    expectedFolded: expectedFoldedIds.length,
    bigStoredReports: JSON.parse(store.readText('sessions/big/reports.json') || '[]').length,
    bigFullBuilderReports: Array.isArray(fullModel.sessions.find((s) => s.id === 'big').reports) ? fullModel.sessions.find((s) => s.id === 'big').reports.length : 0,
  };

  const startedHost = createMainHost();
  host = startedHost.host;
  const address = await host.ensure();
  assert.ok(address && address.url, `board host did not start: ${JSON.stringify(startedHost.errors)}`);
  SERVER_URL = address.url;
  FILE_URL = pathToFileURL(path.join(STATE, 'index.html')).href;
  if (withLegacy) {
    const started = await startLegacy();
    legacy = started;
    LEGACY_URL = started.url;
  }

  page = await launch({ width: 1440, height: 900 });
  owned.profiles.push(page.profileDir);
  owned.pids.push(page.pid);
  const run = { label: 'qa-fold', browserPid: page.pid, profileDir: page.profileDir, pids: [page.pid], aliveAfterClose: null, profileExistsAfterClose: null, closeError: null, cspViolations: null };
  chromeRuns.push(run);
  eventOn(page.client, 'Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error') return;
    const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
    consoleErrors.push({ source: 'console', text, at: nowIso(), phase });
  });
  eventOn(page.client, 'Runtime.exceptionThrown', (params) => {
    const detail = params.exceptionDetails || {};
    pageExceptions.push({ text: detail.exception?.description || detail.text || 'page exception', url: detail.url, line: detail.lineNumber, at: nowIso() });
  });
  eventOn(page.client, 'Log.entryAdded', (params) => {
    const entry = params.entry || {};
    if (entry.level !== 'error') return;
    consoleErrors.push({ source: 'log', text: entry.text, url: entry.url, at: nowIso(), phase });
  });
  eventOn(page.client, 'Network.requestWillBeSent', (params) => {
    addNet({ url: params.request.url, method: params.request.method, at: Date.now() });
  });
  await page.client.send('Network.enable');
  csp = await watchCsp(page);
  await page.addInitScript(`(() => {
    window.__qaFetch = 0;
    window.__qaXhr = 0;
    const f = window.fetch;
    if (typeof f === 'function') window.fetch = function () { window.__qaFetch++; return f.apply(this, arguments); };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () { window.__qaXhr++; return open.apply(this, arguments); };
  })()`);
  phase = 'ready';
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = netModule.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (value) => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

async function teardown() {
  phase = 'teardown';
  const receipt = { at: nowIso(), chrome: null, host: null, legacy: null, temp: null, ports: null, failures: [] };
  if (page) {
    const run = chromeRuns[0];
    try {
      run.pids = [...new Set([...run.pids, ...listProfilePids(page.profileDir)])].sort((a, b) => a - b);
    } catch (error) {
      run.listError = String((error && error.message) || error);
      receipt.failures.push(`listProfilePids before close: ${run.listError}`);
    }
    try {
      await page.close();
    } catch (error) {
      run.closeError = String((error && error.message) || error);
      receipt.failures.push(`chrome close: ${run.closeError}`);
    }
    run.aliveAfterClose = run.pids.filter((pid) => isPidAlive(pid));
    run.profileExistsAfterClose = fs.existsSync(page.profileDir);
    run.cspViolations = csp ? csp.violations.length : null;
    if (run.aliveAfterClose.length) receipt.failures.push(`Chrome pids still alive: ${run.aliveAfterClose.join(',')}`);
    if (run.profileExistsAfterClose) receipt.failures.push(`Chrome profile still exists: ${page.profileDir}`);
    receipt.chrome = { browserPid: run.browserPid, profileDir: run.profileDir, pids: run.pids, aliveAfterClose: run.aliveAfterClose, profileExistsAfterClose: run.profileExistsAfterClose, closeError: run.closeError, listError: run.listError || null };
    page = null;
  }
  if (legacy) {
    try { await legacy.server.close(); receipt.legacy = { url: legacy.url, closed: true }; }
    catch (error) { receipt.legacy = { url: legacy.url, closed: false, error: String((error && error.message) || error) }; receipt.failures.push(`legacy close: ${receipt.legacy.error}`); }
    legacy = null;
  }
  if (host) {
    try { await host.release(); receipt.host = { released: true, status: host.status() }; }
    catch (error) { receipt.host = { released: false, error: String((error && error.message) || error) }; receipt.failures.push(`host release: ${receipt.host.error}`); }
    host = null;
  }
  releaseHolds();
  const portChecks = {};
  for (const port of [...Array(PORTS).keys()].map((n) => BASE + n).concat([...Array(PORTS).keys()].map((n) => LEGACY_BASE + n))) {
    portChecks[port] = await portOpen(port);
  }
  receipt.ports = { checked: Object.keys(portChecks).map(Number), open: Object.entries(portChecks).filter(([, open]) => open).map(([port]) => Number(port)) };
  if (receipt.ports.open.length) receipt.failures.push(`owned server ports still open: ${receipt.ports.open.join(',')}`);
  receipt.temp = { dir: TMP, existedBeforeRemoval: fs.existsSync(TMP), removed: false };
  if (TMP && fs.existsSync(TMP)) {
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { receipt.failures.push(`temp removal: ${String((error && error.message) || error)}`); }
  }
  receipt.temp.removed = !(TMP && fs.existsSync(TMP));
  if (!receipt.temp.removed) receipt.failures.push(`temp folder still exists: ${TMP}`);
  receipt.failures.push(...hostErrors.filter((e) => !e.expected && !/aborted|ECONNRESET|EPIPE/.test(e.message)).map((e) => `host ${e.key}: ${e.message}`));
  receipt.failures.push(...legacyErrors.filter((e) => !/aborted|ECONNRESET|EPIPE/.test(e.message)).map((e) => `legacy ${e.key}: ${e.message}`));
  const expectedSse = (e) => /aborted|ECONNRESET|EPIPE/.test(e.message);
  const summarize = (list) => {
    const counts = new Map();
    for (const e of list) {
      const key = `${e.key}: ${e.message}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  };
  receipt.expectedSseDisconnects = summarize([...hostErrors, ...legacyErrors].filter(expectedSse));
  const expectedHost = (e) => e.expected || expectedSse(e);
  receipt.unexpectedHostErrors = [...hostErrors, ...legacyErrors].filter((e) => !expectedHost(e));
  if (receipt.unexpectedHostErrors.length) receipt.failures.push(`${receipt.unexpectedHostErrors.length} unexpected host/legacy error(s)`);
  receipt.pass = receipt.failures.length === 0;
  // A released server.lock (inside TMP) is expected; the temp removal receipt above is the owned-state check.
  cleanup = receipt;
  return receipt;
}

// ------------------------------------------------------------------ entry points

async function openFromArchive(sid) {
  await click('[data-sh="view"][data-key="archive"]', 'rail archive');
  await waitDom(`document.querySelector('.sh-shell').getAttribute('data-view') === 'archive'`, 'archive view');
  await waitDom(`document.querySelector('#side .sh-row[data-row="${sid}"] .sh-go') !== null`, `archive row ${sid}`);
  await click(`#side .sh-row[data-row="${sid}"] .sh-go`, `archive row ${sid}`);
}

async function openFromSidebar(sid) {
  await click('[data-sh="view"][data-key="conv"]', 'rail conversations');
  await setSearch(sid);
  await click('[data-sec="recent"] [data-sh="expand"]', 'expand recent section');
  await waitDom(`document.querySelector('#side .sh-row[data-row="${sid}"] .sh-go') !== null`, `sidebar row ${sid}`);
  await click(`#side .sh-row[data-row="${sid}"] .sh-go`, `sidebar row ${sid}`);
}

async function openFromPrevious(sid, hostSid = 'alive-00') {
  await click('[data-sh="view"][data-key="conv"]', 'rail conversations');
  await click(`[data-sh="expand"][data-sid="${hostSid}"]`, `expand ${hostSid}`);
  await waitDom(`document.querySelector('#side .sh-prev .sh-go[data-sid="${sid}"]') !== null`, `previous kid ${sid}`);
  await click(`#side .sh-prev .sh-go[data-sid="${sid}"]`, `previous kid ${sid}`);
}

async function openFromInbox(sid) {
  await click('[data-sh="view"][data-key="inbox"]', 'rail inbox');
  await click('[data-sh="view"][data-key="inbox"][data-box="done"]', 'inbox done box');
  await waitDom(`document.querySelector('#side .sh-it[data-sid="${sid}"]') !== null`, `inbox item ${sid}`);
  await click(`#side .sh-it[data-sid="${sid}"]`, `inbox item ${sid}`);
}

async function openFromFavourite(sid) {
  await click('[data-sh="view"][data-key="archive"]', 'rail archive');
  await waitDom(`document.querySelector('#side .sh-row[data-row="${sid}"] .sh-fav') !== null`, `favourite button ${sid}`);
  await click(`#side .sh-row[data-row="${sid}"] .sh-fav`, `favourite button ${sid}`);
  await click('[data-sh="view"][data-key="conv"]', 'rail conversations');
  await waitDom(`document.querySelector('#side [data-sec="fav"] .sh-row[data-row="${sid}"] .sh-go') !== null`, `favourite row ${sid}`);
  await click(`#side [data-sec="fav"] .sh-row[data-row="${sid}"] .sh-go`, `favourite row ${sid}`);
}

async function openFromTabbar(sid) {
  await openFromArchive(sid);
  await waitDom(`document.querySelector('#main .cv-page[data-sid="${sid}"]') !== null`, `opened ${sid}`);
  await click('[data-sh="view"][data-key="conv"]', 'rail conversations');
  await click('#side .sh-row[data-row="alive-00"] .sh-go', 'alive-00 row');
  await waitDom(`document.querySelector('#main .cv-page[data-sid="alive-00"]') !== null`, 'opened alive-00');
  const row = fullModel.sessions.find((s) => s.id === sid);
  await click(`#tabs .tb[data-tab="${row.tabId ? 'w:' + row.tabId : row.id}"] .tb-go`, `tab ${sid}`);
}

async function showReports(sid, expected) {
  await waitDom(`document.querySelector('#main .cv-page[data-sid="${sid}"]') !== null`, `conversation page ${sid}`);
  await click(`#main [data-act="sub"][data-sub="rep"]`, `reports tab ${sid}`);
  await waitDom(`document.querySelectorAll('#main .rep').length === ${expected}`, `report count ${expected}`);
  await pageEval('document.getElementById("main").scrollTop = 0; true');
  await waitFrames(2);
}

function expectedReportsFor(sid) {
  const row = fullModel.sessions.find((s) => s.id === sid);
  return Array.isArray(row && row.reports) ? row.reports.length : 0;
}

async function assertEntry(name, sid, opener) {
  const expected = expectedReportsFor(sid);
  assert.ok(expected > 0, `${sid} has no full-builder reports`);
  await loadUrl(SERVER_URL, VIEWPORTS[0], 'light');
  const before = await pageEval(`(() => { const row = BriefPage.state.model.sessions.find((s) => s.id === ${J(sid)}); return { folded: !!(row && row.folded), reports: row && row.folded ? row.folded.reports : null, key: row && row.folded ? row.folded.key : null }; })()`);
  assert.equal(before.folded, true, `${sid} must be folded before ${name}`);
  assert.equal(before.reports, expected, `${sid} folded count uses the full builder`);
  await opener();
  await showReports(sid, expected);
  const after = await pageEval(`(() => {
    const row = BriefPage.state.model.sessions.find((s) => s.id === ${J(sid)});
    const hit = [...BriefPage.state.full.values()].find((v) => v.sid === ${J(sid)});
    return {
      active: BriefPage.state.ui.active,
      sub: BriefPage.state.ui.sub[${J(sid)}],
      rendered: document.querySelectorAll('#main .rep').length,
      cacheKey: hit ? hit.key : null,
      rowKey: row && row.folded ? row.folded.key : null,
      cacheReports: hit && hit.card && Array.isArray(hit.card.reports) ? hit.card.reports.length : null,
      falseEmpty: document.getElementById('main').textContent.includes('보고서 0'),
    };
  })()`);
  const row = fullModel.sessions.find((s) => s.id === sid);
  assert.equal(after.active, row.tabId ? 'w:' + row.tabId : row.id, `${name}: active board key`);
  assert.equal(after.sub, 'rep', `${name}: reports sub-tab`);
  assert.equal(after.rendered, expected, `${name}: rendered report blocks`);
  assert.equal(after.cacheReports, expected, `${name}: cached full card reports`);
  assert.equal(after.cacheKey, before.key, `${name}: full card key`);
  assert.equal(after.rowKey, before.key, `${name}: row key`);
  assert.equal(after.falseEmpty, false, `${name}: no 보고서 0`);
  return { entry: name, sid, expected, foldedReports: before.reports, rendered: after.rendered, cacheReports: after.cacheReports, key: before.key };
}

// ------------------------------------------------------------------ capture states

async function prepareOverview(vp, theme) {
  await loadUrl(SERVER_URL, vp, theme);
  await waitDom(`document.querySelectorAll('#main .cv-fold-counts').length > 0`, 'overview fold counts');
  const active = await pageEval('BriefPage.state.ui.active');
  assert.equal(active, null, 'overview has no active conversation');
  await scrollFirstFoldCard();
  const check = await pageEval(`(() => ({
    active: BriefPage.state.ui.active,
    view: document.querySelector('.sh-shell').getAttribute('data-view'),
    counts: document.querySelectorAll('#main .cv-fold-counts').length,
    cards: document.querySelectorAll('#main [data-card]').length,
    firstCount: document.querySelector('#main .cv-fold-counts') ? document.querySelector('#main .cv-fold-counts').textContent : null,
    foldCards: document.querySelectorAll('#main [data-card] .cv-fold-counts').length,
    mainScroll: document.getElementById('main').scrollTop,
  }))()`);
  assert.equal(check.view, 'conv');
  assert.equal(check.cards, 200);
  assert.equal(check.counts, expectedFoldedIds.length);
  assert.match(check.firstCount || '', /보고서 \d+개 · 결정 \d+개/);
  return { stateCheck: check, scroll: 'first-folded-card' };
}

async function prepareClosedWindow(vp, theme) {
  await loadUrl(SERVER_URL, vp, theme);
  await click('[data-sh="view"][data-key="archive"]', 'rail archive');
  await waitDom(`document.querySelector('.sh-shell').getAttribute('data-view') === 'archive'`, 'archive view');
  await scrollFirstSideFold();
  const check = await pageEval(`(() => {
    const shell = document.querySelector('.sh-shell');
    return {
      view: shell.getAttribute('data-view'),
      side: shell.getAttribute('data-side'),
      peek: shell.getAttribute('data-peek'),
      wrapInert: document.querySelector('.sh-wrap').hasAttribute('inert'),
      rows: document.querySelectorAll('#side .sh-row[data-row]').length,
      foldMarkers: document.querySelectorAll('#side .sh-fold').length,
    };
  })()`);
  assert.equal(check.view, 'archive');
  assert.equal(check.rows, 180);
  assert.equal(check.foldMarkers, expectedFoldedIds.length);
  if (vp.mobile) assert.equal(check.peek, 'true'); else assert.equal(check.peek, 'false');
  return { stateCheck: check, scroll: 'first-folded-sidebar-row' };
}

async function preparePrevious(vp, theme) {
  await loadUrl(SERVER_URL, vp, theme);
  await click('[data-sh="view"][data-key="conv"]', 'rail conversations');
  await click('[data-sh="expand"][data-sid="alive-00"]', 'expand alive-00');
  await waitDom(`document.querySelectorAll('#side .sh-prev').length > 0`, 'previous conversation kids');
  await scrollTo('#side .sh-prev .sh-go[data-sid="dead-19"]', 'previous kid dead-19');
  const check = await pageEval(`(() => {
    const shell = document.querySelector('.sh-shell');
    return {
      view: shell.getAttribute('data-view'),
      peek: shell.getAttribute('data-peek'),
      prevRows: document.querySelectorAll('#side .sh-prev').length,
      foldedPrev: document.querySelectorAll('#side .sh-prev .sh-fold').length,
      dead19: !!document.querySelector('#side .sh-prev .sh-go[data-sid="dead-19"]'),
    };
  })()`);
  assert.ok(check.prevRows > 0);
  assert.ok(check.foldedPrev > 0);
  assert.equal(check.dead19, true);
  if (vp.mobile) assert.equal(check.peek, 'true');
  return { stateCheck: check, scroll: 'previous-kid' };
}

async function prepareFilePage(vp, theme) {
  const netStart = net.requests.length;
  await loadUrl(FILE_URL, vp, theme);
  await openFromArchive('big');
  await waitDom(`document.querySelector('#main .cv-fold') === null`, 'file folded.js loaded', 30000);
  await showReports('big', expectedReportsFor('big'));
  const pageRequests = net.requests.slice(netStart);
  const check = await pageEval(`(() => {
    const hit = [...BriefPage.state.full.values()].find((v) => v.sid === 'big');
    return {
      transport: BriefPage.transport(),
      token: !!document.querySelector('meta[name="omo-board-token"]'),
      foldedFunction: typeof window.__briefFolded,
      fetchCount: window.__qaFetch,
      xhrCount: window.__qaXhr,
      reps: document.querySelectorAll('#main .rep').length,
      fold: !!document.querySelector('#main .cv-fold'),
      cacheKey: hit ? hit.key : null,
      cacheReports: hit && hit.card && Array.isArray(hit.card.reports) ? hit.card.reports.length : null,
    };
  })()`);
  check.httpRequests = pageRequests.filter((r) => /^https?:/i.test(r.url)).length;
  check.posts = pageRequests.filter((r) => r.method === 'POST').length;
  check.fileRequests = pageRequests.filter((r) => r.url.startsWith('file:')).length;
  assert.equal(check.transport, 'file');
  assert.equal(check.token, false);
  assert.equal(check.foldedFunction, 'function');
  assert.equal(check.fetchCount, 0);
  assert.equal(check.xhrCount, 0);
  assert.equal(check.httpRequests, 0);
  assert.equal(check.posts, 0);
  assert.equal(check.reps, expectedReportsFor('big'));
  assert.equal(check.fold, false);
  assert.equal(check.cacheReports, expectedReportsFor('big'));
  return { stateCheck: check, scroll: 'reports-top' };
}

async function prepareRestartHint(vp, theme) {
  await loadUrl(LEGACY_URL, vp, theme);
  await openFromArchive('big');
  await waitDom(`document.querySelector('#main .cv-fold[data-fold="restart"]') !== null`, 'restart hint', 30000);
  const check = await pageEval(`(() => ({
    fold: document.querySelector('#main .cv-fold') ? document.querySelector('#main .cv-fold').getAttribute('data-fold') : null,
    text: document.querySelector('#main .cv-fold') ? document.querySelector('#main .cv-fold').textContent : null,
    retry: !!document.querySelector('#main [data-act="fold-retry"]'),
    reps: document.querySelectorAll('#main .rep').length,
    token: !!document.querySelector('meta[name="omo-board-token"]'),
  }))()`);
  assert.equal(check.fold, 'restart');
  assert.ok(String(check.text || '').includes(RESTART_HINT));
  assert.equal(check.retry, false);
  assert.equal(check.reps, 0);
  return { stateCheck: check, scroll: 'fold-panel-top' };
}

async function beginFoldLoad(vp, theme, sid = 'big') {
  const expected = expectedReportsFor(sid);
  assert.ok(expected > 0, `${sid} has no full-builder reports`);
  await loadUrl(SERVER_URL, vp, theme);
  const hold = armConvoHold();
  const convoStart = convoLog.length;
  const request = pending(waitConvoAfter(convoStart, (r) => r.sid === sid, `GET /convo/${sid}.json`));
  try {
    await openFromArchive(sid);
    await request;
    await waitDom(`document.querySelector('#main .cv-fold[data-fold="loading"]') !== null`, 'fold loading panel');
    await pageEval('document.getElementById("main").scrollTop = 0; true');
    const check = await pageEval(`(() => {
      const fold = document.querySelector('#main .cv-fold');
      const row = BriefPage.state.model.sessions.find((s) => s.id === ${J(sid)});
      return {
        fold: fold ? fold.getAttribute('data-fold') : null,
        text: fold ? fold.textContent : null,
        foldedReports: row && row.folded ? row.folded.reports : null,
        foldedDecisions: row && row.folded ? row.folded.decisions : null,
        reports: document.querySelectorAll('#main .rep').length,
      };
    })()`);
    assert.equal(check.fold, 'loading');
    assert.equal(check.reports, 0);
    assert.equal(check.foldedReports, expected);
    return { hold, sid, expected, before: { stateCheck: check, scroll: 'fold-panel-top' } };
  } catch (error) {
    hold.resolve();
    throw error;
  }
}

async function finishFoldLoad(ctx) {
  ctx.hold.resolve();
  await waitDom(`document.querySelector('#main .cv-fold') === null`, 'fold panel gone', 30000);
  await click(`#main [data-act="sub"][data-sub="rep"]`, 'reports tab');
  await waitDom(`document.querySelectorAll('#main .rep').length === ${ctx.expected}`, `report count ${ctx.expected}`, 30000);
  await pageEval('document.getElementById("main").scrollTop = 0; true');
  await waitFrames(2);
  const check = await pageEval(`(() => {
    const row = BriefPage.state.model.sessions.find((s) => s.id === ${J(ctx.sid)});
    const hit = [...BriefPage.state.full.values()].find((v) => v.sid === ${J(ctx.sid)});
    return {
      foldPanel: !!document.querySelector('#main .cv-fold'),
      reports: document.querySelectorAll('#main .rep').length,
      sub: BriefPage.state.ui.sub[${J(ctx.sid)}],
      cacheKey: hit ? hit.key : null,
      rowKey: row && row.folded ? row.folded.key : null,
      cacheReports: hit && hit.card && Array.isArray(hit.card.reports) ? hit.card.reports.length : null,
      falseEmpty: document.getElementById('main').textContent.includes('보고서 0'),
    };
  })()`);
  assert.equal(check.foldPanel, false);
  assert.equal(check.reports, ctx.expected);
  assert.equal(check.sub, 'rep');
  assert.equal(check.cacheKey, check.rowKey);
  assert.equal(check.cacheReports, ctx.expected);
  assert.equal(check.falseEmpty, false);
  return { stateCheck: check, scroll: 'reports-top' };
}

// ------------------------------------------------------------------ programmatic sweep

const SWEEP_NEW_SELECTORS = ['.cv-fold', '.cv-fold-t', '.cv-fold-note', '.cv-fold-counts', '.sh-fold', '.sh-meta'];

async function sweepProbe({ viewport, theme, checkTargets, checkCjk, checkFocus }) {
  return pageEval(`(() => {
    const root = document.querySelector('.sh-shell') || document;
    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
    };
    const ownText = (el) => {
      let text = '';
      for (const node of el.childNodes) if (node.nodeType === 3) text += node.textContent;
      return text.replace(/\\s+/g, ' ').trim();
    };
    const classOf = (el) => {
      const cls = typeof el.className === 'string' ? el.className : '';
      return el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\\s+/).slice(0, 3).join('.') : '');
    };
    // The changed surface: fold panels/counts, report panels and the shell entries that open them.
    const scopeRoots = [...document.querySelectorAll('#main .cv-fold, #main .cv-fold-counts, #main .rep, #main .cv-page, #main .card, #side .sh-row, #side .sh-fold, #side .sh-sec, #side .sh-it, #side .sh-kids, #side .sh-prev, #rail .sh-rb, #tabs .tb')];
    const scopeSet = new Set();
    for (const root of scopeRoots) {
      scopeSet.add(root);
      for (const el of root.querySelectorAll('*')) scopeSet.add(el);
    }
    const scope = [...scopeSet];
    const textOverflow = [];
    for (const el of scope) {
      if (!visible(el) || !ownText(el)) continue;
      if (el.closest('input, textarea, select')) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
      if (el.matches('.tt, .plan-summary-line, .plan-link, .sh-t[title]')) continue;
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        textOverflow.push({ selector: classOf(el), text: ownText(el).slice(0, 60), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
        if (textOverflow.length >= 20) break;
      }
    }
    const doc = document.documentElement;
    const main = document.getElementById('main');
    const sideList = document.querySelector('#side .sh-scroll');
    const overflow = {
      doc: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, ok: doc.scrollWidth <= innerWidth + 1 },
      main: main ? { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth, ok: main.scrollWidth <= main.clientWidth + 1 } : null,
      side: sideList ? { scrollWidth: sideList.scrollWidth, clientWidth: sideList.clientWidth, ok: sideList.scrollWidth <= sideList.clientWidth + 1 } : null,
      text: textOverflow,
    };
    const targets = [];
    if (${checkTargets ? 'true' : 'false'}) {
      for (const el of document.querySelectorAll('#main button, #main a[href], #main input, #main textarea, #main select, #main [tabindex], #side button, #side a[href], #side input, #side [tabindex], #rail button, #tabs button')) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 44 || r.height < 44) {
          targets.push({ selector: classOf(el), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 50), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 });
          if (targets.length >= 20) break;
        }
      }
    }
    const color = (value) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(value || '');
      if (!m) return { r: 0, g: 0, b: 0, a: 1 };
      const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
      return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 };
    };
    const over = (fg, bg) => ({
      r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
      g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
      b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
      a: 1,
    });
    const bgOf = (el) => {
      const chain = [];
      for (let node = el; node; node = node.parentElement) chain.unshift(node);
      let bg = { r: 255, g: 255, b: 255, a: 1 };
      for (const node of chain) {
        const cs = getComputedStyle(node);
        const layer = color(cs.backgroundColor);
        if (layer.a > 0) bg = over(layer, bg);
      }
      return bg;
    };
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => {
      const l1 = lum(a), l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const contrast = [];
    for (const el of scope) {
      if (!visible(el)) continue;
      const text = ownText(el);
      if (!text) continue;
      const cs = getComputedStyle(el);
      const fg = color(cs.color);
      const bg = bgOf(el);
      const size = parseFloat(cs.fontSize) || 0;
      const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      // Ancestor opacity is part of the rendered text colour: .sh-prev used to attenuate its whole subtree,
      // and a descendant cannot override that. Composite every ancestor opacity, then compare actual pixels.
      let opacity = 1;
      for (let node = el; node; node = node.parentElement) {
        const value = parseFloat(getComputedStyle(node).opacity);
        if (Number.isFinite(value)) opacity *= value;
      }
      const value = ratio(over({ ...fg, a: fg.a * opacity }, bg), bg);
      const need = large ? 3 : 4.5;
      if (value + 0.01 < need) {
        contrast.push({ selector: classOf(el), text: text.slice(0, 60), ratio: Math.round(value * 100) / 100, need, fontSize: size, color: cs.color, background: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')' });
        if (contrast.length >= 30) break;
      }
    }
    const cjk = [];
    if (${checkCjk ? 'true' : 'false'}) {
      const cjkRoots = [...document.querySelectorAll('#main .cv-fold, #main .cv-fold-counts, #main .rep, #main .card, #side .sh-row, #side .sh-prev')];
      for (const root of cjkRoots) {
        if (cjk.length >= 20) break;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode()) && cjk.length < 20) {
          const text = node.textContent || '';
          if (!/[가-힣]/.test(text)) continue;
          const el = node.parentElement;
          if (!visible(el)) continue;
          const words = [];
          const re = /\\S+/g;
          let match;
          while ((match = re.exec(text)) && words.length < 200) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
            if (rects.length) words.push({ text: match[0], top: Math.round(rects[0].top), left: rects[0].left });
          }
          if (words.length < 2) continue;
          const lines = new Map();
          for (const word of words) {
            const key = word.top;
            const line = lines.get(key) || [];
            line.push(word);
            lines.set(key, line);
          }
          const tops = [...lines.keys()].sort((a, b) => a - b);
          if (tops.length < 2) continue;
          const last = lines.get(tops[tops.length - 1]);
          const prev = lines.get(tops[tops.length - 2]);
          const hangul = [...last.map((w) => w.text).join(' ')].filter((c) => /[가-힣]/.test(c)).length;
          if (last.length === 1 && hangul <= 2 && prev.length > 1) {
            cjk.push({ selector: classOf(el), text: text.slice(0, 80), lastWord: last[0].text, lastTop: tops[tops.length - 1], prevTop: tops[tops.length - 2], prevWords: prev.length });
          }
        }
      }
    }
    const focus = [];
    if (${checkFocus ? 'true' : 'false'}) {
      for (const el of document.querySelectorAll('#main button, #main [tabindex], #side button, #side input, #rail button, #tabs button')) {
        if (!visible(el)) continue;
        el.focus({ preventScroll: true });
        const cs = getComputedStyle(el);
        const ring = (cs.outlineStyle && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
        if (!ring) {
          focus.push({ selector: classOf(el), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 50) });
          if (focus.length >= 20) break;
        }
      }
    }
    const unnamed = [];
    for (const el of document.querySelectorAll('#main button, #main [tabindex], #side button, #side input, #rail button, #tabs button')) {
      if (!visible(el)) continue;
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
      if (!name) unnamed.push({ selector: classOf(el) });
    }
    return {
      at: new Date().toISOString(),
      viewport: ${J(viewport)},
      theme: ${J(theme)},
      media: { dark: matchMedia('(prefers-color-scheme: dark)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches },
      overflow,
      targets,
      contrast,
      cjk,
      focus,
      unnamed,
      newFoldSelectors: ${J(SWEEP_NEW_SELECTORS)},
      foldSurface: {
        foldPanels: document.querySelectorAll('#main .cv-fold').length,
        foldMarkers: document.querySelectorAll('#main .cv-fold-counts, #side .sh-fold').length,
        reportSections: document.querySelectorAll('#main .rep').length,
      },
    };
  })()`);
}

async function runSweep(label, prepare, { targets = false, cjk = true, focus = true, themes = ['light', 'dark'], inheritedMainOverflow = false } = {}) {
  await prepare();
  const light = await sweepProbe({ viewport: label, theme: 'light', checkTargets: targets, checkCjk: cjk, checkFocus: focus });
  let dark = null;
  if (themes.includes('dark')) {
    await setTheme('dark', 'no-preference');
    await waitFrames(1);
    dark = await sweepProbe({ viewport: label, theme: 'dark', checkTargets: targets, checkCjk: cjk, checkFocus: focus });
  }
  await setTheme('light', 'no-preference');
  await waitFrames(1);
  let ax = null;
  try {
    const snap = await axSnapshot(page);
    const unnamed = unnamedInteractive(snap.raw && snap.raw.nodes);
    ax = { nodes: snap.raw && Array.isArray(snap.raw.nodes) ? snap.raw.nodes.length : 0, unnamed: unnamed.map((n) => ({ role: n.role && n.role.value, name: n.name && n.name.value })) };
  } catch (error) {
    ax = { error: String((error && error.message) || error) };
  }
  const introduced = [];
  const inherited = [];
  const classify = (finding) => {
    const selector = String(finding.selector || '');
    (SWEEP_NEW_SELECTORS.some((s) => selector.includes(s.slice(1))) ? introduced : inherited).push(finding);
  };
  for (const item of light.overflow.text) classify(item);
  for (const item of dark ? dark.overflow.text : []) classify(item);
  for (const item of light.contrast) classify(item);
  for (const item of dark ? dark.contrast : []) classify(item);
  for (const item of light.cjk) classify(item);
  for (const item of dark ? dark.cjk : []) classify(item);
  for (const item of light.targets) classify(item);
  for (const item of light.focus) classify(item);
  const failures = [];
  const inheritedLayout = [];
  if (!light.overflow.doc.ok) failures.push('document horizontal overflow at light');
  if (dark && !dark.overflow.doc.ok) failures.push('document horizontal overflow at dark');
  if (light.overflow.main && !light.overflow.main.ok) {
    const finding = { viewport: light.viewport, theme: 'light', kind: 'main-horizontal-overflow', measured: light.overflow.main, reason: 'report block renderer / table content; blocks.js, blocks.css and convo.css are byte-identical to the base' };
    if (inheritedMainOverflow) inheritedLayout.push(finding); else failures.push('#main horizontal overflow at light');
  }
  if (dark && dark.overflow.main && !dark.overflow.main.ok) {
    const finding = { viewport: dark.viewport, theme: 'dark', kind: 'main-horizontal-overflow', measured: dark.overflow.main, reason: 'report block renderer / table content; blocks.js, blocks.css and convo.css are byte-identical to the base' };
    if (inheritedMainOverflow) inheritedLayout.push(finding); else failures.push('#main horizontal overflow at dark');
  }
  if (light.overflow.side && !light.overflow.side.ok) failures.push('#side horizontal overflow at light');
  if (dark && dark.overflow.side && !dark.overflow.side.ok) failures.push('#side horizontal overflow at dark');
  if (introduced.length) failures.push(`${introduced.length} introduced fold-surface finding(s)`);
  const record = {
    label, light, dark, ax,
    attribution: { introduced, inherited },
    inheritedLayout,
    inheritedAccepted: inherited.length + inheritedLayout.length,
    inheritedRule: 'Threshold findings whose selector is not a new fold selector are recorded here as inherited page chrome; the base page CSS is byte-identical (base-evidence.json). A #main horizontal overflow on a report view is the unchanged block/table renderer and is recorded under inheritedLayout. They are not silently waived: sweep.json and report.md list every one.',
    failures,
  };
  return record;
}

// Round-2 focused acceptance, run unchanged against the old and new product. It measures the title budget in the
// actual 390 rows, the marker size and real-pixel contrast (including the previous-row ancestor opacity), the fold
// note font at 1440, and the known HTTP-500 cause plus retry recovery. No fixed sleep: every wait is DOM/request based.
async function round2Probe() {
  const checks = [];
  const measurements = {};
  probeDebug = { checks, measurements };
  const mark = (name) => {
    if (!measurements.steps) measurements.steps = [];
    measurements.steps.push({ name, at: nowIso() });
    console.log(`PROBE STEP ${name}`);
  };
  mark('start');
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); };
  const vp390 = VIEWPORTS[2], vp1440 = VIEWPORTS[0];
  // Establish the page's viewport meta before the first mobile emulation; about:blank has no meta, so a direct
  // 390 mobile override would expose the 980 px layout viewport. The round-1 matrix always started at 1440.
  await loadUrl(SERVER_URL, vp1440, 'light');
  const rowSteps = async (vp, theme) => {
    await loadUrl(SERVER_URL, vp, theme);
    await click('[data-sh="view"][data-key="archive"]', 'rail archive');
    await waitDom(`document.querySelector('#side .sh-row[data-row="boundary-plus"] .sh-fold') !== null`, 'archive boundary-plus marker');
    const archive = await measureFoldRow('#side .sh-row[data-row="boundary-plus"] .sh-fold');
    const rows = { archive };
    if (vp.mobile) {
      await click('#side .sh-row[data-row="boundary-plus"] .sh-fav', 'favourite boundary-plus');
      await click('[data-sh="view"][data-key="conv"]', 'rail conversations');
      await waitDom(`document.querySelector('#side [data-sec="fav"] .sh-row[data-row="boundary-plus"] .sh-fold') !== null`, 'favourite marker');
      rows.favourite = await measureFoldRow('#side [data-sec="fav"] .sh-row[data-row="boundary-plus"] .sh-fold');
      await click('[data-sh="expand"][data-sid="alive-00"]', 'expand alive-00');
      await waitDom(`document.querySelector('#side .sh-prev .sh-fold') !== null`, 'previous kid marker');
      rows.previousKid = await measureFoldRow('#side .sh-prev .sh-fold');
      const previousShot = await clippedPng(rows.previousKid.foldRect, vp.dpr, `probe-marker-prev-${vp.name}-${theme}.png`);
      rows.previousKid.pixels = pixelContrast(previousShot.buffer, previousShot.region);
      rows.previousKid.shot = { file: previousShot.file, info: previousShot.info, region: previousShot.region, sha256: sha256(previousShot.buffer), bytes: previousShot.buffer.length };
      await setSearch('boundary-plus');
      await click('[data-sec="recent"] [data-sh="expand"]', 'expand recent section');
      await waitDom(`document.querySelector('#side [data-sec="recent"] .sh-row[data-row="boundary-plus"] .sh-fold') !== null`, 'recent marker');
      rows.recent = await measureFoldRow('#side [data-sec="recent"] .sh-row[data-row="boundary-plus"] .sh-fold');
    } else {
      await click('[data-sh="view"][data-key="conv"]', 'rail conversations');
      await waitDom(`document.querySelector('#side .sh-row[data-row="alive-00"]') !== null`, 'conversation alive-00 row');
      await click('[data-sh="expand"][data-sid="alive-00"]', 'expand alive-00');
      await waitDom(`document.querySelector('#side .sh-prev .sh-fold') !== null`, 'previous kid marker');
      rows.previousKid = await measureFoldRow('#side .sh-prev .sh-fold');
      const previousShot = await clippedPng(rows.previousKid.foldRect, vp.dpr, `probe-marker-prev-${vp.name}-${theme}.png`);
      rows.previousKid.pixels = pixelContrast(previousShot.buffer, previousShot.region);
      rows.previousKid.shot = { file: previousShot.file, info: previousShot.info, region: previousShot.region, sha256: sha256(previousShot.buffer), bytes: previousShot.buffer.length };
    }
    return rows;
  };
  for (const theme of THEMES) {
    mark(`rows-390-${theme}`);
    const mobile = await rowSteps(vp390, theme);
    for (const caller of ['archive', 'favourite', 'recent', 'previousKid']) {
      const value = mobile[caller];
      check(`title-390-${caller}-${theme}`, !!value && value.title && value.title.clientWidth >= 60, value && value.title);
      check(`marker-font-390-${caller}-${theme}`, !!value && value.foldFont >= 14, value && { foldFont: value.foldFont });
    }
    const mobileContrast = mobile.previousKid.pixels;
    measurements[`previous-marker-390-${theme}`] = { row: mobile.previousKid, pixels: mobileContrast };
    check(`marker-contrast-prev-390-${theme}`, mobileContrast.ratio >= 4.5, mobileContrast);
    const desktop = await rowSteps(vp1440, theme);
    mark(`rows-1440-${theme}`);
    check(`marker-font-1440-${theme}`, desktop.archive.foldFont >= 14, { foldFont: desktop.archive.foldFont });
    const desktopContrast = desktop.previousKid.pixels;
    measurements[`previous-marker-1440-${theme}`] = { row: desktop.previousKid, pixels: desktopContrast };
    check(`marker-contrast-prev-1440-${theme}`, desktopContrast.ratio >= 4.5, desktopContrast);
  }

  const loadingCtx = await beginFoldLoad(vp1440, 'light', 'big');
  mark('loading-held');
  const loading = await pageEval(`(() => {
    const note = document.querySelector('#main .cv-fold-note');
    return note ? { text: note.textContent, font: parseFloat(getComputedStyle(note).fontSize) } : null;
  })()`);
  measurements.loading = loading;
  check('fold-note-loading-font-1440', !!loading && loading.font >= 14, loading);
  await finishFoldLoad(loadingCtx);
  mark('loading-finished');

  await loadUrl(SERVER_URL, vp390, 'light');
  await click('[data-sh="view"][data-key="archive"]', 'rail archive');
  await waitDom(`document.querySelector('#side .sh-row[data-row="big"] .sh-go') !== null`, 'archive big row');
  // Arm after the page's SSE has started: otherwise the SSE's getConvo can consume the one-shot failure
  // before the big row's /convo request and the fold panel would succeed instead of showing the error.
  failControl.mode = 'http500';
  failControl.sid = 'big';
  await click('#side .sh-row[data-row="big"] .sh-go', 'archive big row');
  await waitDom(`document.querySelector('#main .cv-fold[data-fold="error"]') !== null`, 'big HTTP-500 error', 30000);
  mark('error-http500-opened');
  const error = await pageEval(`(() => {
    const fold = document.querySelector('#main .cv-fold');
    const note = fold ? fold.querySelector('.cv-fold-note') : null;
    const retry = fold ? fold.querySelector('[data-act="fold-retry"]') : null;
    const rr = retry ? retry.getBoundingClientRect() : null;
    const cs = note ? getComputedStyle(note) : null;
    return {
      fold: fold ? fold.getAttribute('data-fold') : null,
      text: note ? note.textContent : '', noteFont: cs ? parseFloat(cs.fontSize) : null,
      retry: !!retry, retryWidth: rr ? Math.round(rr.width * 10) / 10 : null, retryHeight: rr ? Math.round(rr.height * 10) / 10 : null,
    };
  })()`);
  measurements.error = error;
  check('error-http500-known-cause', /서버 응답 오류/.test(error.text) && /500/.test(error.text), error);
  check('error-http500-note-font-390', error.noteFont >= 14, error);
  check('error-http500-retry-target', error.retry && error.retryWidth >= 44 && error.retryHeight >= 44, error);
  const screenshotName = 'probe-error-500-390-light.png';
  await page.screenshot(path.join(OUT, screenshotName));
  const screenshot = pngInfo(fs.readFileSync(path.join(OUT, screenshotName)));
  measurements.errorScreenshot = { file: screenshotName, ...screenshot };
  check('error-http500-capture', screenshot.width === vp390.width * vp390.dpr && screenshot.height === vp390.height * vp390.dpr && screenshot.nonBlank, measurements.errorScreenshot);
  // Switch the input modality to keyboard before moving focus, so :focus-visible is the actual keyboard ring.
  await page.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const focus = await pageEval(`(() => {
    const el = document.querySelector('#main [data-act="fold-retry"]');
    if (!el) return { missing: true };
    el.focus();
    const cs = getComputedStyle(el);
    return { active: document.activeElement === el, outline: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0, shadow: cs.boxShadow };
  })()`);
  measurements.errorFocus = focus;
  check('error-http500-retry-focus', focus.active && ((focus.outline !== 'none' && focus.width > 0) || (focus.shadow && focus.shadow !== 'none')), focus);
  await page.screenshot(path.join(OUT, 'probe-error-500-retry-focus-390-light.png'));
  failControl.mode = '';
  failControl.sid = '';
  await click('#main [data-act="fold-retry"]', 'fold retry');
  mark('error-http500-retry-clicked');
  await waitDom(`document.querySelector('#main .cv-fold') === null`, `fold panel gone after retry`, 30000);
  mark('error-http500-fold-gone');
  await showReports('big', 3);
  mark('error-http500-recovered');
  const recovered = await pageEval(`({ reports: document.querySelectorAll('#main .rep').length, fold: document.querySelector('#main .cv-fold') ? document.querySelector('#main .cv-fold').getAttribute('data-fold') : null })`);
  measurements.recovered = recovered;
  check('error-http500-retry-recovers', recovered.reports === 3 && recovered.fold === null, recovered);

  await loadUrl(LEGACY_URL, vp1440, 'light');
  await click('[data-sh="view"][data-key="archive"]', 'legacy rail archive');
  await waitDom(`document.querySelector('#side .sh-row[data-row="big"] .sh-go') !== null`, 'legacy big row');
  await click('#side .sh-row[data-row="big"] .sh-go', 'legacy big row');
  await waitDom(`document.querySelector('#main .cv-fold[data-fold="restart"]') !== null`, 'legacy restart hint', 30000);
  mark('restart-opened');
  const restart = await pageEval(`(() => {
    const note = document.querySelector('#main .cv-fold[data-fold="restart"] .cv-fold-note');
    return note ? { text: note.textContent, font: parseFloat(getComputedStyle(note).fontSize) } : null;
  })()`);
  measurements.restart = restart;
  check('fold-note-restart-font-1440', !!restart && restart.font >= 14, restart);
  check('fold-note-restart-text', !!restart && restart.text.includes(RESTART_HINT), restart);

  const pass = checks.length > 0 && checks.every((c) => c.ok);
  mark('done');
  return { pass, checks, measurements, failed: checks.filter((c) => !c.ok) };
}

function readIntegration() {
  const source = fs.readFileSync(path.join(ROOT, 'test/fixtures/stale-cards-200.mjs'), 'utf8');
  return { sourceLength: source.length };
}

// ------------------------------------------------------------------ main run

// Reuse the 42 captures and 3 extras from an immutable attempt when the product/git/content hash is unchanged.
// The root authorized this after a QA-only fold-live stimulus fix: no re-capture of the unchanged product.
function loadReusedCaptures(dir) {
  const indexPath = path.join(dir, 'capture-index.json');
  const proofPath = path.join(dir, 'matrix-proof.json');
  assert.ok(fs.existsSync(indexPath), `reuse source missing: ${indexPath}`);
  assert.ok(fs.existsSync(proofPath), `reuse source missing: ${proofPath}`);
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  assert.equal(proof.pass, true, 'reuse source matrix proof did not pass');
  assert.equal(index.build.gitHead, build.gitHead, 'reuse source git head changed');
  assert.equal(index.build.base, build.base, 'reuse source base changed');
  const productScopePath = path.join(dir, 'product-scope.json');
  assert.ok(fs.existsSync(productScopePath), `reuse source product scope missing: ${productScopePath}`);
  const productScope = JSON.parse(fs.readFileSync(productScopePath, 'utf8'));
  assert.equal(productScope.head, build.gitHead, 'product scope git head');
  assert.equal(productScope.base, build.base, 'product scope base');
  for (const [file, expected] of Object.entries(productScope.files)) {
    assert.equal(sha256(fs.readFileSync(path.join(ROOT, file))), expected, `capture-affecting product source changed: ${file}`);
  }
  assert.equal(sha256(JSON.stringify(productScope.files)), build.productSourceHash, 'current product source hash');
  const contentHashSame = index.build.contentHash === build.contentHash;
  const contentHashNote = contentHashSame
    ? 'data.js content hash is identical'
    : 'data.js hashes differ across fresh stores because briefPath/sessionFile contain the per-run temp state path and the derived folded keys include that path; capture-affecting product source and UI content are unchanged (product-scope.json).';
  assert.equal(index.captures.length, 42, 'reuse source required capture count');
  const expectedKeys = [];
  for (const view of REQUIRED_VIEWS) for (const vp of VIEWPORTS) for (const theme of THEMES) expectedKeys.push(`${view}|${vp.name}|${theme}`);
  const seen = index.captures.map((c) => `${c.view}|${c.viewport.name}|${c.theme}`);
  assert.deepEqual(seen.slice().sort(), expectedKeys.slice().sort(), 'reuse source matrix keys');
  const records = [...index.captures, ...index.extras].map((record) => {
    const sourceFile = path.join(dir, record.file);
    const rootFile = path.join(OUT, record.file);
    assert.ok(fs.existsSync(sourceFile), `reuse source image missing: ${sourceFile}`);
    const sourceBytes = fs.readFileSync(sourceFile);
    assert.equal(sha256(sourceBytes), record.sha256, `reuse source hash: ${record.file}`);
    if (!fs.existsSync(rootFile)) fs.copyFileSync(sourceFile, rootFile);
    const rootBytes = fs.readFileSync(rootFile);
    assert.equal(sha256(rootBytes), record.sha256, `task-9 root image hash: ${record.file}`);
    const info = pngInfo(rootBytes);
    assert.equal(info.width, record.expected.pixelWidth, `reuse width: ${record.file}`);
    assert.equal(info.height, record.expected.pixelHeight, `reuse height: ${record.file}`);
    assert.equal(info.nonBlank, true, `reuse compositing: ${record.file}`);
    return { ...record, reusedFrom: dir, capturedBuildId: record.buildId, reusedForBuildId: build.buildId };
  });
  return {
    required: records.filter((r) => r.required !== false),
    extras: records.filter((r) => r.required === false),
    sourceBuild: index.build,
    sourceProof: { pass: proof.pass, captured: proof.captured, missing: proof.missing, duplicates: proof.duplicates },
    productScope,
    productSourceSame: true,
    contentHashSame,
    contentHashNote,
  };
}

async function runPositive() {
  await setup({ withLegacy: true });
  const vpDefault = VIEWPORTS[0];
  const reused = REUSE_DIR ? loadReusedCaptures(REUSE_DIR) : null;
  if (reused) {
    captures.push(...reused.required);
    extras.push(...reused.extras);
  }

  await scenario('integration', 'task-1 integration flags are present and the factual smokes are selected', async () => {
    assert.ok(integration, 'task-1/integration.json is missing');
    assert.equal(integration.s1, true, 'S1 must be on the base');
    assert.equal(integration.base, build.base, 'base sha');
    return { integration, smokes: integration.m1 || integration.rail ? ['m1', 'rail'] : [], smokesSkipped: { m1: !integration.m1, rail: !integration.rail } };
  });

  await scenario('fold-overview', '접힘 markers and card counts are present on the overview', async () => {
    await loadUrl(SERVER_URL, vpDefault, 'light');
    const data = await pageEval(`(() => ({
      sessions: BriefPage.state.model.sessions.length,
      folded: BriefPage.state.model.sessions.filter((s) => s.folded).length,
      counts: document.querySelectorAll('#main .cv-fold-counts').length,
      cards: document.querySelectorAll('#main [data-card]').length,
      firstCount: document.querySelector('#main .cv-fold-counts') ? document.querySelector('#main .cv-fold-counts').textContent : null,
      view: document.querySelector('.sh-shell').getAttribute('data-view'),
    }))()`);
    assert.equal(data.sessions, 200);
    assert.equal(data.folded, expectedFoldedIds.length);
    assert.equal(data.counts, expectedFoldedIds.length);
    assert.equal(data.cards, 200);
    assert.equal(data.view, 'conv');
    assert.match(data.firstCount || '', /보고서 \d+개 · 결정 \d+개/);
    await click('[data-sh="view"][data-key="archive"]', 'rail archive');
    const sidebar = await pageEval(`({ view: document.querySelector('.sh-shell').getAttribute('data-view'), markers: document.querySelectorAll('#side .sh-fold').length, rows: document.querySelectorAll('#side .sh-row[data-row]').length })`);
    assert.equal(sidebar.view, 'archive');
    assert.equal(sidebar.markers, expectedFoldedIds.length);
    return { ...data, sidebarMarkers: sidebar.markers, sidebarRows: sidebar.rows };
  });

  await scenario('fold-marker-visibility', '접힘 is a visible shrink-0 sibling outside .sh-t for archive, favourite, recent and previous-kid rows', async () => {
    const samples = [];
    const measure = (selector) => pageEval(`(() => {
      const fold = document.querySelector(${J(selector)});
      if (!fold) return { selector: ${J(selector)}, missing: true };
      const row = fold.closest('.sh-row');
      const go = fold.closest('.sh-go') || row;
      const fr = fold.getBoundingClientRect();
      const rr = row ? row.getBoundingClientRect() : null;
      const gr = go ? go.getBoundingClientRect() : null;
      const hit = document.elementFromPoint(Math.round(fr.x + fr.width / 2), Math.round(fr.y + fr.height / 2));
      const inside = (r) => !!r && fr.width > 0 && fr.height > 0 && fr.x >= r.x - 1 && fr.x + fr.width <= r.x + r.width + 1 && fr.y >= r.y - 1 && fr.y + fr.height <= r.y + r.height + 1;
      return {
        selector: ${J(selector)}, text: fold.textContent,
        row: row ? row.getAttribute('data-row') : null,
        foldRect: { x: Math.round(fr.x), y: Math.round(fr.y), width: Math.round(fr.width), height: Math.round(fr.height) },
        rowRect: rr ? { x: Math.round(rr.x), y: Math.round(rr.y), width: Math.round(rr.width), height: Math.round(rr.height) } : null,
        goRect: gr ? { x: Math.round(gr.x), y: Math.round(gr.y), width: Math.round(gr.width), height: Math.round(gr.height) } : null,
        rowVisible: inside(rr), goVisible: inside(gr),
        hit: !!hit && (hit === fold || fold.contains(hit)),
        insideTitle: !!fold.closest('.sh-t'), insideSub: !!fold.closest('.sh-sub'),
      };
    })()`);
    for (const vp of VIEWPORTS) {
      for (const theme of THEMES) {
        await loadUrl(SERVER_URL, vp, theme);
        const rowSamples = {};
        await click('[data-sh="view"][data-key="archive"]', 'rail archive');
        await waitDom(`document.querySelector('#side .sh-row[data-row="boundary-plus"] .sh-fold') !== null`, 'archive boundary-plus marker');
        rowSamples.archive = await measureFoldRow('#side .sh-row[data-row="boundary-plus"] .sh-fold');
        await click('#side .sh-row[data-row="boundary-plus"] .sh-fav', 'favourite boundary-plus');
        await click('[data-sh="view"][data-key="conv"]', 'rail conversations');
        await waitDom(`document.querySelector('#side [data-sec="fav"] .sh-row[data-row="boundary-plus"] .sh-fold') !== null`, 'favourite marker');
        rowSamples.favourite = await measureFoldRow('#side [data-sec="fav"] .sh-row[data-row="boundary-plus"] .sh-fold');
        await click('[data-sh="expand"][data-sid="alive-00"]', 'expand alive-00');
        await waitDom(`document.querySelector('#side .sh-prev .sh-fold') !== null`, 'previous kid marker');
        rowSamples.previousKid = await measureFoldRow('#side .sh-prev .sh-fold');
        const previousShot = await clippedPng(rowSamples.previousKid.foldRect, vp.dpr, `marker-prev-${vp.name}-${theme}.png`);
        rowSamples.previousKid.pixels = pixelContrast(previousShot.buffer, previousShot.region);
        rowSamples.previousKid.shot = { file: previousShot.file, info: previousShot.info, region: previousShot.region, sha256: sha256(previousShot.buffer), bytes: previousShot.buffer.length };
        await setSearch('boundary-plus');
        await click('[data-sec="recent"] [data-sh="expand"]', 'expand recent section');
        await waitDom(`document.querySelector('#side [data-sec="recent"] .sh-row[data-row="boundary-plus"] .sh-fold') !== null`, 'recent marker');
        rowSamples.recent = await measureFoldRow('#side [data-sec="recent"] .sh-row[data-row="boundary-plus"] .sh-fold');
        rowSamples.tabBar = { applicable: false, reason: 'tabs() renders no foldMark; the fold-open-tabbar scenario covers the tab-bar entry' };
        samples.push({ viewport: vp.name, theme, dpr: vp.dpr, width: vp.width, height: vp.height, ...rowSamples });
      }
    }
    const failures = [];
    const pixelChecks = [];
    for (const sample of samples) {
      for (const [caller, value] of Object.entries(sample)) {
        if (caller === 'viewport' || caller === 'theme' || caller === 'dpr' || caller === 'width' || caller === 'height' || caller === 'tabBar') continue;
        if (!value || value.missing || !value.rowVisible || !value.goVisible || !value.hit || value.insideTitle || value.insideSub) {
          failures.push({ kind: 'marker-visible', viewport: sample.viewport, theme: sample.theme, caller, value });
          continue;
        }
        const minTitle = sample.viewport === '390x844' ? 60 : 40;
        if (!value.title || value.title.clientWidth < minTitle) {
          failures.push({ kind: 'title-budget', viewport: sample.viewport, theme: sample.theme, caller, minTitle, title: value.title });
        }
        if (value.foldFont < 14) {
          failures.push({ kind: 'marker-font', viewport: sample.viewport, theme: sample.theme, caller, foldFont: value.foldFont });
        }
        if (caller === 'previousKid') {
          const pixels = value.pixels;
          const shot = value.shot;
          const name = shot.file;
          const expected = { width: sample.width, height: sample.height, dpr: sample.dpr, pixelWidth: sample.width * sample.dpr, pixelHeight: sample.height * sample.dpr };
          extras.push({
            view: 'marker-pixels', kind: 'pixel', required: false, mode: 'server',
            viewport: { name: sample.viewport, width: sample.width, height: sample.height, dpr: sample.dpr, mobile: sample.viewport === '390x844' },
            theme: sample.theme, file: shot.file, sha256: shot.sha256, bytes: shot.bytes, expected, png: shot.info,
            stateCheck: { caller, foldRect: value.foldRect, region: shot.region, pixels }, scroll: 'marker-pixels', captureApi: 'Page.captureScreenshot(full viewport) + DPR ROI',
            buildId: build && build.buildId, at: nowIso(),
          });
          pixelChecks.push({ viewport: sample.viewport, theme: sample.theme, file: name, ratio: pixels.ratio, region: shot.region, background: pixels.background, foreground: pixels.foreground });
          if (pixels.ratio < 4.5) failures.push({ kind: 'marker-contrast', viewport: sample.viewport, theme: sample.theme, caller, pixels });
        }
      }
    }
    writeJson('marker-pixels.json', { at: nowIso(), samples, pixelChecks, failures });
    assert.deepEqual(failures, [], `fold marker/title/contrast failures: ${JSON.stringify(failures)}`);
    return { samples, pixelChecks };
  });

  await scenario('fold-type', 'loading and restart fold instructions meet the 14 px text floor at every viewport', async () => {
    const samples = [];
    for (const vp of VIEWPORTS) {
      const ctx = await beginFoldLoad(vp, 'light', 'big');
      const loading = await pageEval(`(() => {
        const note = document.querySelector('#main .cv-fold-note');
        return note ? { text: note.textContent, font: parseFloat(getComputedStyle(note).fontSize), color: getComputedStyle(note).color } : null;
      })()`);
      assert.ok(loading && loading.font >= 14, `loading fold note ${vp.name}: ${JSON.stringify(loading)}`);
      samples.push({ viewport: vp.name, kind: 'loading', ...loading });
      await finishFoldLoad(ctx);
      await loadUrl(LEGACY_URL, vp, 'light');
      await click('[data-sh="view"][data-key="archive"]', 'legacy rail archive');
      await waitDom(`document.querySelector('#side .sh-row[data-row="big"] .sh-go') !== null`, 'legacy big row');
      await click('#side .sh-row[data-row="big"] .sh-go', 'legacy big row');
      await waitDom(`document.querySelector('#main .cv-fold[data-fold="restart"]') !== null`, 'legacy restart hint');
      const restart = await pageEval(`(() => {
        const note = document.querySelector('#main .cv-fold[data-fold="restart"] .cv-fold-note');
        return note ? { text: note.textContent, font: parseFloat(getComputedStyle(note).fontSize), color: getComputedStyle(note).color } : null;
      })()`);
      assert.ok(restart && restart.font >= 14, `restart fold note ${vp.name}: ${JSON.stringify(restart)}`);
      assert.ok(restart.text.includes(RESTART_HINT), `restart fold text ${vp.name}`);
      samples.push({ viewport: vp.name, kind: 'restart', ...restart });
    }
    return { samples };
  });

  await scenario('fold-open-sidebar', 'a sidebar recent row opens a folded conversation with every full report', async () =>
    assertEntry('sidebar', 'boundary-plus', () => openFromSidebar('boundary-plus')));

  await scenario('fold-open-previous', "an '이전 대화' kid opens a folded conversation with every full report", async () =>
    assertEntry('previous', 'dead-19', () => openFromPrevious('dead-19')));

  await scenario('fold-open-closedwindow', 'a 닫힌 창 row opens a folded conversation with every full report', async () =>
    assertEntry('closedwindow', 'dead-00', () => openFromArchive('dead-00')));

  await scenario('fold-open-inbox', 'an inbox item opens a folded conversation with every full report', async () =>
    assertEntry('inbox', 'dead-00', () => openFromInbox('dead-00')));

  await scenario('fold-open-favourite', 'a favourite row opens a folded conversation with every full report', async () =>
    assertEntry('favourite', 'dead-00', () => openFromFavourite('dead-00')));

  await scenario('fold-open-tabbar', 'a tab-bar entry opens a folded conversation with every full report', async () =>
    assertEntry('tabbar', 'dead-00', () => openFromTabbar('dead-00')));

  await scenario('fold-open-big', 'the folded big conversation opens all three full-builder reports in server mode', async () => {
    const entry = await assertEntry('big-server', 'big', () => openFromArchive('big'));
    const stored = JSON.parse(store.readText('sessions/big/reports.json') || '[]');
    assert.equal(stored.length, 25, 'big stored reports');
    assert.equal(entry.expected, 3, 'big full-builder reports');
    assert.equal(entry.rendered, 3, 'big rendered report blocks');
    await pageEval('document.getElementById("main").scrollTop = 0; true');
    const text = await pageEval('document.querySelector("#main").textContent');
    assert.ok(text.includes('big 보고 0'), 'the full builder first report is rendered');
    return { ...entry, storedReports: stored.length, fullBuilderReports: entry.expected, renderedReports: entry.rendered };
  });

  await scenario('fold-image', 'a folded report image is 200 and an unknown asset is 404', async () => {
    const big = fullModel.sessions.find((s) => s.id === 'big');
    const src = big.reports[0].images[0].src;
    const name = src.slice('assets/'.length);
    const asset = await httpRequest(SERVER_URL + src);
    assert.equal(asset.status, 200);
    assert.match(String(asset.headers['content-type']), /^image\/png/);
    assert.equal(asset.headers['x-content-type-options'], 'nosniff');
    const fixtureAsset = fs.readFileSync(path.join(ROOT, 'test/fixtures/board-assets', name));
    assert.deepEqual(asset.bytes, fixtureAsset, 'served image bytes');
    const unknown = '0'.repeat(64) + '.png';
    const missing = await httpRequest(SERVER_URL + 'assets/' + unknown);
    assert.equal(missing.status, 404);
    return { src, name, bytes: asset.bytes.length, status: asset.status, unknownStatus: missing.status, contentType: asset.headers['content-type'], nosniff: asset.headers['x-content-type-options'] };
  });

  await scenario('gates', 'foreign Host 403, cross-site 403, unknown sid 404, data.js/folded.js 404', async () => {
    const foreign = await httpRequest(SERVER_URL + 'convo/big.json', { headers: { Host: 'evil.example' } });
    const cross = await httpRequest(SERVER_URL + 'convo/big.json', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    const crossData = await httpRequest(SERVER_URL + 'data.json', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    const unknown = await httpRequest(SERVER_URL + 'convo/nope.json');
    const dataJs = await httpRequest(SERVER_URL + 'data.js');
    const foldedJs = await httpRequest(SERVER_URL + 'folded.js');
    const traversal = await httpRequest(SERVER_URL + 'convo/..%2Fmeta.json');
    const good = await httpRequest(SERVER_URL + 'convo/big.json');
    assert.equal(foreign.status, 403); assert.equal(cross.status, 403); assert.equal(crossData.status, 403);
    assert.equal(unknown.status, 404); assert.equal(dataJs.status, 404); assert.equal(foldedJs.status, 404); assert.equal(traversal.status, 404);
    assert.equal(good.status, 200);
    const body = JSON.parse(good.body);
    assert.equal(body.schema, 1);
    assert.equal(body.session.reports.length, 3);
    assert.equal(body.key, projected.sessions.find((s) => s.id === 'big').folded.key);
    assert.equal(good.headers['cache-control'], 'no-store');
    assert.equal(good.headers['x-frame-options'], 'DENY');
    assert.equal(good.headers['referrer-policy'], 'no-referrer');
    assert.equal(good.headers['x-content-type-options'], 'nosniff');
    return {
      foreignHost: foreign.status, crossSite: cross.status, crossSiteData: crossData.status, unknownSid: unknown.status,
      dataJs: dataJs.status, foldedJs: foldedJs.status, traversal: traversal.status, good: { status: good.status, reports: body.session.reports.length, key: body.key, cacheControl: good.headers['cache-control'], frame: good.headers['x-frame-options'], referrer: good.headers['referrer-policy'], nosniff: good.headers['x-content-type-options'] },
    };
  });

  await scenario('fold-hint', 'a host without getConvo makes the page show the restart hint', async () => {
    await loadUrl(LEGACY_URL, vpDefault, 'light');
    await openFromArchive('big');
    await waitDom(`document.querySelector('#main .cv-fold[data-fold="restart"]') !== null`, 'restart hint', 30000);
    const data = await pageEval(`(() => ({
      fold: document.querySelector('#main .cv-fold').getAttribute('data-fold'),
      text: document.querySelector('#main .cv-fold').textContent,
      retry: !!document.querySelector('#main [data-act="fold-retry"]'),
      reports: document.querySelectorAll('#main .rep').length,
      token: !!document.querySelector('meta[name="omo-board-token"]'),
    }))()`);
    assert.equal(data.fold, 'restart');
    assert.ok(data.text.includes(RESTART_HINT));
    assert.equal(data.retry, false);
    assert.equal(data.reports, 0);
    assert.equal(data.token, false);
    return data;
  });

  await scenario('file-fold', 'the file:// page opens a folded conversation with no fetch, POST or token', async () => {
    const prep = await prepareFilePage(vpDefault, 'light');
    const data = prep.stateCheck;
    const foldedText = fs.readFileSync(path.join(STATE, 'folded.js'), 'utf8');
    assert.ok(foldedText.startsWith('window.__briefFolded&&window.__briefFolded('));
    const payload = foldedText.slice(foldedText.indexOf('(') + 1, -2);
    const parsed = JSON.parse(payload);
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.key, projected.foldedKey);
    assert.equal(parsed.sessions.big.reports.length, 3);
    assert.ok(foldedText.length > MAX_VM_BYTES, 'folded.js carries the over-cap big card');
    return { ...data, foldedJsBytes: foldedText.length, foldedBigReports: parsed.sessions.big.reports.length, foldedKey: parsed.key };
  });

  await scenario('error-states', 'known HTTP, payload, network and file failures name the cause and retry recovers', async () => {
    const vp = VIEWPORTS[2];
    const priorPhase = phase;
    phase = 'round2-errors';
    const samples = {};
    const foldState = () => pageEval(`(() => {
      const fold = document.querySelector('#main .cv-fold');
      const note = fold ? fold.querySelector('.cv-fold-note') : null;
      const retry = fold ? fold.querySelector('[data-act="fold-retry"]') : null;
      const rr = retry ? retry.getBoundingClientRect() : null;
      const cs = note ? getComputedStyle(note) : null;
      return {
        fold: fold ? fold.getAttribute('data-fold') : null,
        cause: fold ? fold.getAttribute('data-cause') : null,
        code: fold ? fold.getAttribute('data-code') : null,
        text: note ? note.textContent : '',
        noteFont: cs ? parseFloat(cs.fontSize) : null,
        retry: !!retry,
        retryWidth: rr ? Math.round(rr.width * 10) / 10 : null,
        retryHeight: rr ? Math.round(rr.height * 10) / 10 : null,
      };
    })()`);
    const assertState = (label, state, cause, code) => {
      assert.equal(state.fold, 'error', `${label}: fold state ${JSON.stringify(state)}`);
      assert.equal(state.cause, cause, `${label}: finite cause ${JSON.stringify(state)}`);
      if (code !== undefined) assert.equal(state.code, String(code), `${label}: HTTP code ${JSON.stringify(state)}`);
      assert.ok(state.text.length > 0, `${label}: visible explanation`);
      assert.doesNotMatch(state.text, /https?:|QA_FORCE|\.json|token/i, `${label}: no raw URL/token/stack`);
      assert.ok(state.noteFont >= 14, `${label}: note font ${state.noteFont}`);
      assert.ok(state.retry && state.retryWidth >= 44 && state.retryHeight >= 44, `${label}: retry target ${JSON.stringify(state)}`);
      samples[label] = state;
    };
    const captureError = (label, state) => capture(label, vp, 'light', { stateCheck: state, scroll: 'fold-panel-top' }, { required: false, kind: 'interaction', file: `extra-${label}-390-light.png` });
    const recover = async (label) => {
      await click('#main [data-act="fold-retry"]', `${label}: fold retry`);
      await waitDom(`document.querySelector('#main .cv-fold') === null`, `${label}: fold panel gone`, 30000);
      await showReports('big', 3);
      const state = await pageEval(`({ reports: document.querySelectorAll('#main .rep').length, fold: document.querySelector('#main .cv-fold') ? document.querySelector('#main .cv-fold').getAttribute('data-fold') : null })`);
      assert.equal(state.reports, 3, `${label}: recovered reports`);
      assert.equal(state.fold, null, `${label}: recovered without fold panel`);
      samples[`${label}-recovered`] = state;
      await capture(`${label}-recovered`, vp, 'light', { stateCheck: state, scroll: 'reports' }, { required: false, kind: 'interaction', file: `extra-${label}-recovered-390-light.png` });
      return state;
    };
    const openBig = async () => {
      await click('[data-sh="view"][data-key="archive"]', 'rail archive');
      await waitDom(`document.querySelector('#side .sh-row[data-row="big"] .sh-go') !== null`, 'archive big row');
      await click('#side .sh-row[data-row="big"] .sh-go', 'archive big row');
      await waitDom(`document.querySelector('#main .cv-fold[data-fold="error"]') !== null`, 'fold error panel', 30000);
      return foldState();
    };
    try {
      await loadUrl(SERVER_URL, vp, 'light');
      failControl.mode = 'http500';
      failControl.sid = 'big';
      const http = await openBig();
      assertState('error-http500', http, 'http', 500);
      await captureError('error-http500', http);
      await page.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      const focus = await pageEval(`(() => {
        const el = document.querySelector('#main [data-act="fold-retry"]');
        el.focus();
        const cs = getComputedStyle(el);
        return { active: document.activeElement === el, outline: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0, shadow: cs.boxShadow };
      })()`);
      assert.equal(focus.active, true, 'retry focus');
      assert.ok((focus.outline !== 'none' && focus.width > 0) || (focus.shadow && focus.shadow !== 'none'), `retry focus ring ${JSON.stringify(focus)}`);
      samples['error-http500-focus'] = focus;
      await capture('error-http500-focus', vp, 'light', { stateCheck: focus, scroll: 'fold-panel-top' }, { required: false, kind: 'interaction', file: 'extra-error-http500-focus-390-light.png', park: false });
      failControl.mode = '';
      failControl.sid = '';
      await recover('error-http500');

      await loadUrl(SERVER_URL, vp, 'light');
      failControl.mode = 'payload';
      failControl.sid = 'big';
      const payload = await openBig();
      assertState('error-payload', payload, 'payload');
      await captureError('error-payload', payload);
      await recover('error-payload');

      await page.client.send('Network.setBlockedURLs', { urls: ['*convo/big.json*'] });
      await loadUrl(SERVER_URL, vp, 'light');
      const network = await openBig();
      assertState('error-network', network, 'network');
      await captureError('error-network', network);
      await page.client.send('Network.setBlockedURLs', { urls: [] });
      await recover('error-network');

      const foldedPath = path.join(STATE, 'folded.js'), missingPath = path.join(STATE, 'folded.js.qa-missing');
      await loadUrl(FILE_URL, vp, 'light');
      fs.renameSync(foldedPath, missingPath);
      try {
        const file = await openBig();
        assertState('error-file-load', file, 'file-load');
        await captureError('error-file-load', file);
      } finally {
        fs.renameSync(missingPath, foldedPath);
      }
      await recover('error-file-load');
    } finally {
      failControl.mode = '';
      failControl.sid = '';
      await page.client.send('Network.setBlockedURLs', { urls: [] }).catch(() => {});
      phase = priorPhase;
    }
    return samples;
  });

  await scenario('overlay-escape', 'at 390 the sidebar overlay is inert, traps Tab and closes on Escape with focus returned', async () => {
    const vp = VIEWPORTS[2];
    await loadUrl(SERVER_URL, vp, 'light');
    await focusClick('[data-sh="view"][data-key="archive"]', 'rail archive');
    await waitDom(`document.querySelector('.sh-shell').getAttribute('data-peek') === 'true'`, 'archive overlay open');
    const opened = await pageEval(`(() => ({
      peek: document.querySelector('.sh-shell').getAttribute('data-peek'),
      inert: document.querySelector('.sh-wrap').hasAttribute('inert'),
      activeInSide: document.querySelector('#side').contains(document.activeElement),
      activeInShell: document.querySelector('.sh-shell').contains(document.activeElement),
      activeInWrap: document.querySelector('.sh-wrap').contains(document.activeElement),
      active: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent,
    }))()`);
    assert.equal(opened.peek, 'true');
    assert.equal(opened.inert, true);
    assert.equal(opened.activeInWrap, false);
    assert.equal(opened.activeInShell, true);
    let inSide = opened.activeInSide;
    const tabStates = [];
    for (let i = 0; i < 8 && !inSide; i++) {
      await page.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      const state = await pageEval(`(() => ({ inSide: document.querySelector('#side').contains(document.activeElement), inWrap: document.querySelector('.sh-wrap').contains(document.activeElement), active: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent }))()`);
      tabStates.push(state);
      inSide = state.inSide;
    }
    assert.equal(inSide, true, `Tab never entered the overlay: ${JSON.stringify(tabStates)}`);
    const afterTabs = tabStates[tabStates.length - 1] || { inSide: true, inWrap: false };
    assert.equal(afterTabs.inWrap, false);
    await page.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitDom(`document.querySelector('.sh-shell').getAttribute('data-peek') === 'false'`, 'overlay closed', 10000);
    const closed = await pageEval(`(() => ({ peek: document.querySelector('.sh-shell').getAttribute('data-peek'), inert: document.querySelector('.sh-wrap').hasAttribute('inert'), active: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent, activeKey: document.activeElement.getAttribute('data-key'), activeInSide: document.querySelector('#side').contains(document.activeElement), activeInRail: document.querySelector('#rail').contains(document.activeElement) }))()`);
    assert.equal(closed.peek, 'false');
    assert.equal(closed.inert, false);
    assert.equal(closed.activeInRail, true, `focus did not return to the rail: ${JSON.stringify(closed)}`);
    assert.equal(closed.activeKey, 'archive', `focus returned to the wrong rail control: ${JSON.stringify(closed)}`);
    return { vp: vp.name, opened, tabStates, afterTabs, closed };
  });

  // The 42-cell capture matrix. Each cell is prepared fresh; a failed cell is recorded and the run continues.
  await scenario('capture-matrix', '42 required captures: 7 views x 3 viewports x 2 themes', async () => {
    if (reused) {
      const expectedKeys = [];
      for (const view of REQUIRED_VIEWS) for (const vp of VIEWPORTS) for (const theme of THEMES) expectedKeys.push(`${view}|${vp.name}|${theme}`);
      const seen = captures.filter((c) => c.required !== false).map((c) => `${c.view}|${c.viewport.name}|${c.theme}`);
      assert.equal(seen.length, 42, `reused required captures: ${seen.length}`);
      assert.deepEqual(seen.slice().sort(), expectedKeys.slice().sort(), 'reused matrix keys');
      assert.equal(reused.required.length, 42, 'reused required count');
      assert.equal(reused.extras.length, 3, 'reused extras count');
      return {
        reused: true, reusedFrom: REUSE_DIR, captured: 42, extras: reused.extras.length,
        contentHashSame: reused.contentHashSame, productSourceSame: true, productScope: reused.productScope,
        contentHashNote: reused.contentHashNote, sourceBuild: reused.sourceBuild, sourceProof: reused.sourceProof, noRecapture: true,
      };
    }
    for (const vp of VIEWPORTS) {
      for (const theme of THEMES) {
        const single = [
          ['overview', prepareOverview],
          ['closedwindow', prepareClosedWindow],
          ['previousconvo', preparePrevious],
          ['filepage', prepareFilePage],
          ['restarthint', prepareRestartHint],
        ];
        for (const [view, prepare] of single) {
          try {
            const prep = await prepare(vp, theme);
            await capture(view, vp, theme, prep);
          } catch (error) {
            matrixFailures.push({ view, viewport: vp.name, theme, error: String((error && error.message) || error) });
            console.error(`FAIL capture ${view} ${vp.name} ${theme}: ${(error && error.message) || error}`);
          }
        }
        try {
          const ctx = await beginFoldLoad(vp, theme, 'big');
          await capture('folded-before-load', vp, theme, ctx.before);
          const after = await finishFoldLoad(ctx);
          await capture('folded-after-load', vp, theme, after);
        } catch (error) {
          matrixFailures.push({ view: 'folded-before-load/afterload', viewport: vp.name, theme, error: String((error && error.message) || error) });
          console.error(`FAIL capture folded load ${vp.name} ${theme}: ${(error && error.message) || error}`);
        }
      }
    }
    const expectedKeys = [];
    for (const view of REQUIRED_VIEWS) for (const vp of VIEWPORTS) for (const theme of THEMES) expectedKeys.push(`${view}|${vp.name}|${theme}`);
    const seen = captures.filter((c) => c.required).map((c) => `${c.view}|${c.viewport.name}|${c.theme}`);
    const missing = expectedKeys.filter((key) => !seen.includes(key));
    const duplicates = seen.filter((key, index) => seen.indexOf(key) !== index);
    assert.equal(captures.filter((c) => c.required).length, 42, `captured ${captures.filter((c) => c.required).length}/42`);
    assert.deepEqual(missing, [], `missing matrix cells: ${missing.join(', ')}`);
    assert.deepEqual(duplicates, [], `duplicate matrix cells: ${duplicates.join(', ')}`);
    assert.deepEqual(matrixFailures, [], `${matrixFailures.length} matrix cell failure(s)`);
    return { required: 42, captured: 42, views: REQUIRED_VIEWS, viewports: VIEWPORTS.map((v) => v.name), themes: THEMES };
  });

  // Interaction extras named by the visual-qa skill; not part of the exact 42-cell plan matrix.
  await scenario('extra-focus', 'a keyboard-focus ring is visible on the folded sidebar row', async () => {
    if (reused) return { reused: true, file: 'extra-focus-1440-light.png', from: REUSE_DIR };
    await loadUrl(SERVER_URL, vpDefault, 'light');
    await click('[data-sh="view"][data-key="archive"]', 'rail archive');
    await waitDom(`document.querySelector('#side .sh-row[data-row="dead-00"] .sh-go') !== null`, 'archive row dead-00');
    const selector = '#side .sh-row[data-row="dead-00"] .sh-go';
    const focused = await pageEval(`(() => { const el = document.querySelector(${J(selector)}); el.focus(); const cs = getComputedStyle(el); return { active: document.activeElement === el, outline: cs.outlineStyle, width: cs.outlineWidth, shadow: cs.boxShadow }; })()`);
    assert.equal(focused.active, true);
    assert.ok((focused.outline !== 'none' && parseFloat(focused.width) > 0) || focused.shadow !== 'none', 'focus ring');
    await capture('focus', vpDefault, 'light', { stateCheck: focused, scroll: 'focused-sidebar-row' }, { required: false, kind: 'interaction', file: 'extra-focus-1440-light.png' });
    return focused;
  });

  await scenario('extra-hover', 'a pointer hover is visible on the folded sidebar row', async () => {
    if (reused) return { reused: true, file: 'extra-hover-1440-light.png', from: REUSE_DIR };
    await loadUrl(SERVER_URL, vpDefault, 'light');
    await click('[data-sh="view"][data-key="archive"]', 'rail archive');
    await waitDom(`document.querySelector('#side .sh-row[data-row="dead-00"] .sh-go') !== null`, 'archive row dead-00');
    await scrollTo('#side .sh-row[data-row="dead-00"] .sh-go', 'archive row dead-00');
    const selector = '#side .sh-row[data-row="dead-00"]';
    const rect = await pageEval(`(() => { const r = document.querySelector(${J(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + Math.min(120, rect.width / 2), y: rect.y + rect.height / 2, button: 'none' });
    await waitFrames(2);
    const hovered = await pageEval(`(() => { const el = document.querySelector(${J(selector)}); const cs = getComputedStyle(el); return { hover: el.matches(':hover'), background: cs.backgroundColor }; })()`);
    assert.equal(hovered.hover, true);
    await capture('hover', vpDefault, 'light', { stateCheck: hovered, scroll: 'hovered-sidebar-row' }, { required: false, kind: 'interaction', file: 'extra-hover-1440-light.png', park: false });
    return hovered;
  });

  await scenario('extra-reduced-motion', 'the 390 overlay cross-fade is captured mid, settled, and after an interruption under reduce', async () => {
    if (reused) return { reused: true, file: 'extra-reduced-motion-390-light.png', from: REUSE_DIR };
    const vp = VIEWPORTS[2];
    await loadUrl(SERVER_URL, vp, 'light', { motion: 'reduce' });
    const reduceBefore = await pageEval(`({ reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, peek: document.querySelector('.sh-shell').getAttribute('data-peek') })`);
    assert.equal(reduceBefore.reduce, true);
    await click('[data-sh="view"][data-key="archive"]', 'rail archive');
    await waitDom(`document.querySelector('.sh-shell').getAttribute('data-peek') === 'true'`, 'archive overlay open');
    const mid = await pageEval(`(async () => {
      for (let i = 0; i < 3; i++) {
        const anims = document.getAnimations().filter((a) => a.playState === 'running');
        if (anims.length) {
          const state = anims.map((a) => ({ currentTime: Math.round(a.currentTime || 0), duration: a.effect && a.effect.getTiming().duration, playState: a.playState, target: a.effect && a.effect.target && String(a.effect.target.className) }));
          for (const a of anims) a.pause();
          return { count: anims.length, state, paused: true };
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { count: 0, state: [], paused: false };
    })()`);
    assert.ok(mid.count > 0 && mid.paused, `no running reduced-motion cross-fade to capture: ${JSON.stringify(mid)}`);
    const midCheck = { ...reduceBefore, peek: 'true', visible: await pageEval('getComputedStyle(document.querySelector("#side")).visibility'), animation: mid };
    await capture('reduced-motion-mid', vp, 'light', { stateCheck: midCheck, scroll: 'archive-overlay' }, { required: false, kind: 'interaction', motion: 'reduce', file: 'extra-reduced-motion-mid-390-light.png' });
    const resumed = await pageEval(`(() => { const paused = document.getAnimations().filter((a) => a.playState === 'paused'); for (const a of paused) a.play(); return paused.length; })()`);
    const settled = await pageEval(`(async () => {
      const anims = document.getAnimations().filter((a) => a.playState === 'running');
      const started = anims.map((a) => ({ currentTime: Math.round(a.currentTime || 0), duration: a.effect && a.effect.getTiming().duration }));
      await Promise.all(anims.map((a) => a.finished.catch(() => {})));
      return { resumed: ${resumed}, started, running: document.getAnimations().filter((a) => a.playState === 'running').length, peek: document.querySelector('.sh-shell').getAttribute('data-peek'), visible: getComputedStyle(document.querySelector('#side')).visibility };
    })()`);
    assert.equal(settled.running, 0, `cross-fade did not settle: ${JSON.stringify(settled)}`);
    assert.equal(settled.peek, 'true');
    await capture('reduced-motion-settled', vp, 'light', { stateCheck: { ...reduceBefore, ...settled }, scroll: 'archive-overlay' }, { required: false, kind: 'interaction', motion: 'reduce', file: 'extra-reduced-motion-settled-390-light.png' });
    const closed = await pageEval(`(() => { const close = document.querySelector('.sh-side [data-sh="toggleSide"]'); if (!close) return false; close.click(); return true; })()`);
    assert.equal(closed, true, 'overlay close control');
    const closing = await pageEval(`(() => {
      const anims = document.getAnimations().filter((a) => a.playState === 'running');
      return { count: anims.length, state: anims.map((a) => ({ currentTime: Math.round(a.currentTime || 0), duration: a.effect && a.effect.getTiming().duration, target: a.effect && a.effect.target && String(a.effect.target.className) })) };
    })()`);
    await click('[data-sh="view"][data-key="archive"]', 'rail archive reopen during close');
    const interrupted = await pageEval(`(async () => {
      const started = document.getAnimations().filter((a) => a.playState === 'running').map((a) => ({ currentTime: Math.round(a.currentTime || 0), duration: a.effect && a.effect.getTiming().duration, target: a.effect && a.effect.target && String(a.effect.target.className) }));
      await Promise.all(document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.finished.catch(() => {})));
      return { started, running: document.getAnimations().filter((a) => a.playState === 'running').length, peek: document.querySelector('.sh-shell').getAttribute('data-peek'), visible: getComputedStyle(document.querySelector('#side')).visibility };
    })()`);
    assert.equal(interrupted.peek, 'true');
    await capture('reduced-motion-interrupt', vp, 'light', { stateCheck: { ...reduceBefore, closing, interrupted }, scroll: 'archive-overlay' }, { required: false, kind: 'interaction', motion: 'reduce', file: 'extra-reduced-motion-interrupt-390-light.png' });
    return { mid, settled, closing, interrupted };
  });

  // Programmatic whole-surface sweep; attribution separates introduced fold elements from inherited page chrome.
  const sweeps = [];
  await scenario('sweep', 'programmatic overflow, targets, contrast, focus, accessible names and CJK sweep', async () => {
    sweeps.push(await runSweep('overview-1440-light', async () => { await loadUrl(SERVER_URL, VIEWPORTS[0], 'light'); await waitDom(`document.querySelectorAll('#main .cv-fold-counts').length > 0`, 'overview fold counts'); }, { targets: false, cjk: true, focus: true }));
    sweeps.push(await runSweep('overview-390-light', async () => { await loadUrl(SERVER_URL, VIEWPORTS[2], 'light'); await waitDom(`document.querySelectorAll('#main .cv-fold-counts').length > 0`, 'overview fold counts'); }, { targets: true, cjk: true, focus: true }));
    sweeps.push(await runSweep('archive-390-light', async () => { await loadUrl(SERVER_URL, VIEWPORTS[2], 'light'); await click('[data-sh="view"][data-key="archive"]', 'rail archive'); await waitDom(`document.querySelector('.sh-shell').getAttribute('data-peek') === 'true'`, 'archive overlay'); }, { targets: true, cjk: true, focus: true }));
    sweeps.push(await runSweep('foldpanel-390-light', async () => { await beginFoldLoad(VIEWPORTS[2], 'light', 'big'); }, { targets: true, cjk: true, focus: true }));
    // The foldpanel sweep holds a request; release it before the next sweep.
    releaseHolds();
    sweeps.push(await runSweep('convo-1440-light', async () => { await loadUrl(SERVER_URL, VIEWPORTS[0], 'light'); await openFromArchive('big'); await waitDom(`document.querySelector('#main .cv-fold') === null`, 'big loaded', 30000); await showReports('big', 3); }, { targets: false, cjk: true, focus: true, inheritedMainOverflow: true }));
    sweeps.push(await runSweep('file-390-light', async () => { await prepareFilePage(VIEWPORTS[2], 'light'); }, { targets: true, cjk: true, focus: true, inheritedMainOverflow: true }));
    sweeps.push(await runSweep('restart-390-light', async () => { await loadUrl(LEGACY_URL, VIEWPORTS[2], 'light'); await openFromArchive('big'); await waitDom(`document.querySelector('#main .cv-fold[data-fold="restart"]') !== null`, 'restart hint'); }, { targets: true, cjk: true, focus: true }));
    phase = 'round2-errors';
    sweeps.push(await runSweep('error-390-light', async () => {
      await loadUrl(SERVER_URL, VIEWPORTS[2], 'light');
      await click('[data-sh="view"][data-key="archive"]', 'rail archive');
      await waitDom(`document.querySelector('#side .sh-row[data-row="big"] .sh-go') !== null`, 'archive big row');
      failControl.mode = 'http500';
      failControl.sid = 'big';
      await click('#side .sh-row[data-row="big"] .sh-go', 'archive big row');
      await waitDom(`document.querySelector('#main .cv-fold[data-fold="error"]') !== null`, 'fold error panel');
    }, { targets: true, cjk: true, focus: true }));
    failControl.mode = '';
    failControl.sid = '';
    phase = 'ready';
    const failures = sweeps.flatMap((s) => s.failures.map((message) => `${s.label}: ${message}`));
    const introduced = sweeps.flatMap((s) => s.attribution.introduced.map((f) => ({ sweep: s.label, finding: f })));
    const inherited = sweeps.flatMap((s) => s.attribution.inherited.map((f) => ({ sweep: s.label, finding: f })));
    const inheritedLayout = sweeps.flatMap((s) => (s.inheritedLayout || []).map((f) => ({ sweep: s.label, finding: f })));
    const rendererFiles = ['page.css', 'shell.css', 'convo.css', 'blocks.css', 'blocks.js', 'convo-view.js'];
    const base = integration && integration.base;
    const rendererEvidence = {};
    for (const name of rendererFiles) {
      const current = fs.readFileSync(path.join(ROOT, 'src/page', name));
      const old = base ? spawnSync('git', ['-C', ROOT, 'show', `${base}:src/page/${name}`], { encoding: null }).stdout : null;
      rendererEvidence[name] = { currentSha256: sha256(current), baseSha256: old ? sha256(old) : null, sameAsBase: old ? sha256(current) === sha256(old) : null };
    }
    baseEvidence = {
      base,
      rendererEvidence,
      newFoldSelectors: SWEEP_NEW_SELECTORS,
      changedRendererFiles: Object.entries(rendererEvidence).filter(([, v]) => v.sameAsBase === false).map(([k]) => k),
      convoViewReportPathUnchanged: 'src/page/convo-view.js changes only foldPanel and its cause helper; reportHtml/reportsPanel and src/page/blocks.js are unchanged.',
      round2Note: 'page.css changes only the targeted .cv-fold-note font-size rule; convo.css and blocks.css/blocks.js remain byte-identical to the base, so the inherited report overflow and old search/sub-tab thresholds are unchanged, not waived.',
      attributionRule: 'A finding is introduced only when it names a new fold selector; everything else is inherited page chrome whose renderer files are byte-identical to the base. A #main horizontal overflow on a report view is the unchanged block/table renderer and is recorded under inheritedLayout.',
    };
    writeJson('base-evidence.json', baseEvidence);
    writeJson('sweep.json', { at: nowIso(), sweeps, failures, introduced, inherited, inheritedLayout, baseEvidence });
    assert.deepEqual(failures, [], `sweep failures: ${failures.join(' | ')}`);
    assert.deepEqual(introduced, [], `introduced fold-surface findings: ${JSON.stringify(introduced).slice(0, 1000)}`);
    return { failures, introduced: introduced.length, inherited: inherited.length, inheritedLayout: inheritedLayout.length, sweeps: sweeps.map((s) => ({ label: s.label, failures: s.failures, inheritedLayout: (s.inheritedLayout || []).length })) };
  });

  // Live cache and exact request counts. This mutates the owned fixture only, after the capture matrix.
  await scenario('fold-live', '3 unchanged publications make 0 /convo requests and leave #main unchanged; a changed conversation makes exactly 1', async () => {
    await loadUrl(SERVER_URL, vpDefault, 'light');
    await openFromArchive('dead-00');
    await waitDom(`document.querySelector('#main .cv-fold') === null`, 'dead-00 loaded', 30000);
    await showReports('dead-00', 3);
    const beforeMain = await pageEval('document.getElementById("main").innerHTML');
    const beforeHash = sha256(beforeMain);
    await pageEval('window.__qaApplied = []; BriefPage.hooks.afterApply.push((m) => window.__qaApplied.push(m.seq)); true');
    const convoStart = convoLog.length;
    const netStart = net.requests.length;
    const unchangedHashes = [];
    const seqs = [];
    for (let i = 0; i < 3; i++) {
      const meta = store.readRecord('sessions/alive-00/meta.json');
      store.replace('sessions/alive-00/meta.json', { ...meta, lastActivityAt: NOW - 1000 - i });
      const published = renderPage(store, NOW, { ...renderOptions, stateDir: STATE, generation: GENERATION });
      assert.equal(published.ok, true, `unchanged publication ${i + 1}: ${published.error}`);
      const seq = Math.max(...published.seqs);
      seqs.push(seq);
      const applied = pending(waitDom(`BriefPage.state.seq >= ${seq} && !BriefPage.state.pending`, `applied seq ${seq}`, 30000));
      host.notifyPublished();
      await applied;
      const html = await pageEval('document.getElementById("main").innerHTML');
      const hash = sha256(html);
      unchangedHashes.push(hash);
      assert.equal(hash, beforeHash, `#main changed on unchanged publication ${i + 1}`);
    }
    const convoUnchanged = convoLog.length - convoStart;
    const netUnchanged = net.requests.slice(netStart).filter((r) => /\/convo\//.test(r.url)).length;
    assert.equal(convoUnchanged, 0, 'unchanged publications requested /convo');
    assert.equal(netUnchanged, 0, 'unchanged publications made a /convo request');
    const beforeChangeKeys = projected.sessions.find((s) => s.id === 'dead-00').folded.key;
    // Subscribe before the write: the host poll can publish the changed model while renderPage is still running.
    const netChangeStart = net.requests.length;
    const convoChangeStart = convoLog.length;
    const request = pending(waitNetAfter(netChangeStart, (r) => r.url.endsWith('/convo/dead-00.json'), 'changed /convo/dead-00.json', 30000));
    const meta = store.readRecord('sessions/dead-00/meta.json');
    // `paneId` is a field of the full card (the renderer test uses it to prove the folded key follows content).
    // Changing only meta.title/lastActivityAt does not move this fixture's card: the latest brief owns those values.
    store.replace('sessions/dead-00/meta.json', { ...meta, paneId: 'qa-fold-changed' });
    const changed = renderPage(store, NOW, { ...renderOptions, stateDir: STATE, generation: GENERATION });
    assert.equal(changed.ok, true, `changed publication: ${changed.error}`);
    const changedSeq = Math.max(...changed.seqs);
    const applied = pending(waitDom(`BriefPage.state.seq >= ${changedSeq} && !BriefPage.state.pending`, `applied changed seq ${changedSeq}`, 30000));
    host.notifyPublished();
    await request;
    await applied;
    await waitDom(`document.querySelectorAll('#main .rep').length === 3`, 'changed conversation reports', 30000);
    const convoChanged = convoLog.length - convoChangeStart;
    const netChanged = net.requests.slice(netChangeStart).filter((r) => /\/convo\//.test(r.url)).length;
    assert.equal(convoChanged, 1, `changed conversation getConvo calls: ${convoChanged}`);
    assert.equal(netChanged, 1, `changed conversation /convo requests: ${netChanged}`);
    const after = await pageEval(`(() => { const row = BriefPage.state.model.sessions.find((s) => s.id === 'dead-00'); const hit = [...BriefPage.state.full.values()].find((v) => v.sid === 'dead-00'); return { rowKey: row && row.folded ? row.folded.key : null, cacheKey: hit ? hit.key : null, reports: document.querySelectorAll('#main .rep').length, cacheReports: hit && hit.card && Array.isArray(hit.card.reports) ? hit.card.reports.length : null, main: document.getElementById('main').innerHTML }; })()`);
    assert.equal(after.rowKey, after.cacheKey);
    assert.equal(after.reports, 3);
    assert.equal(after.cacheReports, 3);
    assert.notEqual(after.cacheKey, beforeChangeKeys);
    const live = {
      unchangedPublications: seqs,
      unchangedMainHashes: unchangedHashes,
      unchangedMainStable: unchangedHashes.every((h) => h === beforeHash),
      convoRequestsForUnchanged: convoUnchanged,
      netConvoRequestsForUnchanged: netUnchanged,
      changedPublication: changedSeq,
      changedConvoRequests: convoChanged,
      changedNetConvoRequests: netChanged,
      beforeKey: beforeChangeKeys,
      afterKey: after.cacheKey,
      changedMainHash: sha256(after.main),
      changedMainDiffers: sha256(after.main) !== beforeHash,
    };
    writeJson('live-requests.json', live);
    return live;
  });

  await scenario('attempt3-nine-findings', 'owner #444 scoped pressed, hydration, empty, keyboard, zoom and theme evidence', async () => {
    const code = await runAttempt3Probe({ standalone: false });
    assert.equal(code, 0, 'attempt3-probe.json must contain no failing scoped check');
    return { evidence: 'attempt3-probe.json' };
  });

  await scenario('csp', '0 CSP violations across every server and legacy page', async () => {
    assert.equal(csp.violations.length, 0, JSON.stringify(csp.violations));
    const root = await httpRequest(SERVER_URL);
    assert.equal(root.status, 200);
    const header = root.headers['content-security-policy'];
    assert.ok(header, 'CSP header');
    const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(header);
    assert.ok(nonce, 'CSP nonce');
    const nonceCount = (root.body.match(new RegExp(`nonce="${nonce[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')) || []).length;
    assert.ok(nonceCount > 0, 'page scripts carry the response nonce');
    const doc = { violations: csp.violations, notes: csp.notes.length, header: header.slice(0, 300), nonce, nonceCount, servers: [SERVER_URL, LEGACY_URL] };
    writeJson('csp.json', doc);
    return doc;
  });

  await scenario('console-clean', 'no page exception and no unexpected console error', async () => {
    assert.deepEqual(pageExceptions, [], 'page exceptions');
    const expectedForced = (e) => {
      if (e.phase !== 'round2-errors') return false;
      if (e.source === 'console') return /Failed to fetch|NetworkError|network/i.test(e.text || '');
      if (e.source === 'log') {
        if (e.url && /\/convo\/big\.json/.test(e.url)) return true;
        if (e.url && /folded\.js\?v=/.test(e.url)) return true;
        if (/ERR_BLOCKED_BY_CLIENT|Failed to load resource|ERR_FILE_NOT_FOUND/i.test(e.text || '')) return true;
      }
      return false;
    };
    const unexpected = consoleErrors.filter((e) => {
      if (expectedForced(e)) return false;
      if (e.source !== 'log') return true;
      if (!e.url) return false;
      try {
        const url = new URL(e.url);
        return !(url.origin === new URL(LEGACY_URL).origin && url.pathname === '/convo/big.json' && /404/.test(e.text || ''));
      } catch { return true; }
    });
    assert.deepEqual(unexpected, [], `unexpected console errors: ${JSON.stringify(unexpected).slice(0, 1000)}`);
    return { consoleErrors, pageExceptions, expectedForced: consoleErrors.filter(expectedForced).length, expectedLegacy404: consoleErrors.length - unexpected.length - consoleErrors.filter(expectedForced).length };
  });

  // The capture matrix is only complete after the last scenario; verify theme pairs and write the objective proof.
  await scenario('theme-binding', 'light and dark captures are a real pair for every view and viewport', async () => {
    const pairs = [];
    const failures = [];
    for (const view of REQUIRED_VIEWS) {
      for (const vp of VIEWPORTS) {
        const light = captures.find((c) => c.required && c.view === view && c.viewport.name === vp.name && c.theme === 'light');
        const dark = captures.find((c) => c.required && c.view === view && c.viewport.name === vp.name && c.theme === 'dark');
        if (!light || !dark) { failures.push(`${view} ${vp.name}: missing theme pair`); continue; }
        const lightBg = `${light.png.bg.r},${light.png.bg.g},${light.png.bg.b}`;
        const darkBg = `${dark.png.bg.r},${dark.png.bg.g},${dark.png.bg.b}`;
        const lightCenter = `${light.png.center.r},${light.png.center.g},${light.png.center.b}`;
        const darkCenter = `${dark.png.center.r},${dark.png.center.g},${dark.png.center.b}`;
        const differs = lightBg !== darkBg || lightCenter !== darkCenter;
        pairs.push({ view, viewport: vp.name, lightBg, darkBg, lightCenter, darkCenter, differs });
        if (!differs) failures.push(`${view} ${vp.name}: light and dark pixels are identical`);
      }
    }
    assert.deepEqual(failures, [], failures.join(' | '));
    return { pairs: pairs.length, failures };
  });

  const required = captures.filter((c) => c.required);
  const expectedKeys = [];
  for (const view of REQUIRED_VIEWS) for (const vp of VIEWPORTS) for (const theme of THEMES) expectedKeys.push(`${view}|${vp.name}|${theme}`);
  const seen = required.map((c) => `${c.view}|${c.viewport.name}|${c.theme}`);
  const missing = expectedKeys.filter((key) => !seen.includes(key));
  const duplicates = seen.filter((key, index) => seen.indexOf(key) !== index);
  const matrixProof = {
    at: nowIso(),
    buildId: build.buildId,
    required: 42,
    captured: required.length,
    views: REQUIRED_VIEWS,
    viewports: VIEWPORTS.map((v) => v.name),
    themes: THEMES,
    expectedKeys,
    capturedKeys: seen,
    missing,
    duplicates,
    pass: missing.length === 0 && duplicates.length === 0 && required.length === 42 && matrixFailures.length === 0,
    reusedFrom: REUSE_DIR || null,
    contentHashSame: reused ? reused.contentHashSame : null,
    productSourceSame: reused ? true : null,
    productScope: reused ? reused.productScope : null,
    contentHashNote: reused ? reused.contentHashNote : null,
    sourceProof: reused ? reused.sourceProof : null,
    noRecapture: !!reused,
    cells: required.map((c) => ({ view: c.view, viewport: c.viewport.name, theme: c.theme, file: c.file, sha256: c.sha256, width: c.png.width, height: c.png.height, expectedWidth: c.expected.pixelWidth, expectedHeight: c.expected.pixelHeight, nonBlank: c.png.nonBlank, reused: !!c.reusedFrom, stateCheck: c.stateCheck })),
    failures: matrixFailures,
  };
  writeJson('matrix-proof.json', matrixProof);
  writeJson('capture-index.json', {
    schema: 1, buildId: build.buildId, build,
    capturedBuild: reused ? reused.sourceBuild : null,
    reuse: reused ? {
      from: REUSE_DIR,
      reason: 'QA-only fold-live stimulus fix; the frozen product git/content hash is unchanged, so the 42 captures and 3 extras are reused without re-capture (root direction).',
      contentHashSame: reused.contentHashSame, productSourceSame: true, productScope: reused.productScope,
      contentHashNote: reused.contentHashNote, gitHeadSame: true, required: 42, extras: reused.extras.length, noRecapture: true,
    } : null,
    matrix: { required: 42, captured: required.length, views: REQUIRED_VIEWS, viewports: VIEWPORTS.map((v) => v.name), themes: THEMES },
    captures: required, extras,
  });

  cleanup = await teardown();

  const summary = {
    total: scenarioOrder.length,
    passed: scenarioOrder.filter((id) => results[id].pass).length,
    failed: scenarioOrder.filter((id) => !results[id].pass).length,
    failedIds: scenarioOrder.filter((id) => !results[id].pass),
    matrix: { pass: matrixProof.pass, captured: required.length, missing, duplicates, failures: matrixFailures },
    cspViolations: csp.violations.length,
    foldLive: results['fold-live'] || null,
    cleanup: cleanup && cleanup.pass,
  };
  const result = {
    schema: 1,
    task: 'board-stale-cards-recurrence task 9',
    mode: 'positive',
    plan: 'C:/Users/USER/orca/projects/기타 작업/.omo/plans/board-stale-cards-recurrence.md',
    out: OUT,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: nowIso(),
    durationMs: Date.now() - startedAt,
    build,
    capturedBuild: reused ? reused.sourceBuild : null,
    integration,
    fixtures: {
      sessions: fixtureStats.sessions,
      folded: fixtureStats.folded,
      expectedFolded: fixtureStats.expectedFolded,
      dataJsBytes: build.dataJsBytes,
      foldedJsBytes: build.foldedJsBytes,
      foldedKey: projected.foldedKey,
      bigStoredReports: fixtureStats.bigStoredReports,
      bigFullBuilderReports: fixtureStats.bigFullBuilderReports,
    },
    scenarios: results,
    scenarioOrder,
    summary,
    captures: { required: required.length, extras: extras.length, index: 'capture-index.json', proof: 'matrix-proof.json', reusedFrom: REUSE_DIR || null, noRecapture: !!reused, contentHashSame: reused ? reused.contentHashSame : null, productSourceSame: reused ? true : null, contentHashNote: reused ? reused.contentHashNote : null },
    artifacts: {
      result: 'result.json', captureIndex: 'capture-index.json', matrixProof: 'matrix-proof.json',
      sweep: 'sweep.json', cleanup: 'cleanup.json', baseEvidence: 'base-evidence.json',
      csp: 'csp.json', liveRequests: 'live-requests.json', integrationFlags: 'integration-flags.json',
      entryCounts: 'entry-counts.json', assets: 'assets.json',
    },
    cleanup,
    console: { errors: consoleErrors, exceptions: pageExceptions },
  };
  const entryIds = ['fold-open-sidebar', 'fold-open-previous', 'fold-open-closedwindow', 'fold-open-inbox', 'fold-open-favourite', 'fold-open-tabbar', 'fold-open-big'];
  const entryCounts = Object.fromEntries(entryIds.map((id) => [id, results[id] || null]));
  writeJson('entry-counts.json', entryCounts);
  writeJson('assets.json', { foldImage: results['fold-image'] || null, gates: results.gates || null });
  writeJson('integration-flags.json', { integration, smokes: (results.integration && results.integration.smokes) || [], skipped: results.integration && results.integration.smokesSkipped });
  writeJson('cleanup.json', cleanup);
  writeJson('result.json', result);
  const exitCode = summary.failed === 0 && matrixProof.pass && cleanup.pass && csp.violations.length === 0 ? 0 : 1;
  console.log(`SUMMARY ${JSON.stringify({ passed: summary.passed, failed: summary.failed, captured: required.length, matrix: matrixProof.pass, cleanup: cleanup.pass, exitCode })}`);
  return exitCode;
}

async function runNegative() {
  await setup({ withLegacy: false });
  const vp = VIEWPORTS[0];
  try {
    await loadUrl(SERVER_URL, vp, 'light');
    await openFromArchive('dead-00');
    await waitDom(`document.querySelector('#main .cv-fold') === null`, 'dead-00 loaded', 30000);
    await showReports('dead-00', 3);
    const beforeMain = await pageEval('document.getElementById("main").innerHTML');
    const beforeHash = sha256(beforeMain);
    const convoStart = convoLog.length;
    await pageEval('window.__qaApplied = []; BriefPage.hooks.afterApply.push((m) => window.__qaApplied.push(m.seq)); true');
    const observed = [];
    for (let i = 0; i < 3; i++) {
      // --no-cache: disable the page's own full-card cache before the publication lands.
      await pageEval('BriefPage.state.full.clear(); BriefPage.state.foldedFor = null; true');
      const netStart = net.requests.length;
      const request = pending(waitNetAfter(netStart, (r) => /\/convo\/dead-00\.json$/.test(r.url), `negative /convo request ${i + 1}`, 30000));
      const meta = store.readRecord('sessions/alive-00/meta.json');
      store.replace('sessions/alive-00/meta.json', { ...meta, lastActivityAt: NOW - 1000 - i });
      const published = renderPage(store, NOW, { ...renderOptions, stateDir: STATE, generation: GENERATION });
      assert.equal(published.ok, true, `negative publication ${i + 1}: ${published.error}`);
      const seq = Math.max(...published.seqs);
      const applied = pending(waitDom(`BriefPage.state.seq >= ${seq} && !BriefPage.state.pending`, `negative applied seq ${seq}`, 30000));
      host.notifyPublished();
      await request;
      await applied;
      observed.push({ publication: i + 1, seq, convoRequests: net.requests.slice(netStart).filter((r) => /\/convo\//.test(r.url)).length, mainHash: sha256(await pageEval('document.getElementById("main").innerHTML')) });
    }
    const convoRequests = convoLog.length - convoStart;
    const mainHashes = observed.map((o) => o.mainHash);
    const mainSame = mainHashes.every((h) => h === beforeHash);
    const foldLive = {
      pass: convoRequests === 0 && mainSame,
      expected: 'FAIL: the page cache is disabled, so each unchanged publication requests the folded card again',
      beforeHash,
      convoRequests,
      mainSame,
      mainHashes,
      publications: observed,
    };
    const result = {
      schema: 1,
      task: 'board-stale-cards-recurrence task 9',
      mode: 'negative',
      intended: true,
      flag: '--no-cache',
      reason: 'Disables the page full-card cache in this owned harness only; fold-live must fail. Production code is untouched.',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      build,
      precondition: { folded: projected.sessions.filter((s) => s.folded).length, bigReports: expectedReportsFor('big'), dead00Loaded: true },
      foldLive,
      positiveResultExists: fs.existsSync(path.join(OUT, 'result.json')),
      positiveCaptureCount: (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'capture-index.json'), 'utf8')).captures.filter((c) => c.required).length; } catch { return null; } })(),
      cleanup: null,
    };
    cleanup = await teardown();
    result.cleanup = cleanup;
    writeNegJson('negative-result.json', result);
    // A negative run that accidentally passes is itself a QA failure.
    const exitCode = foldLive.pass ? 2 : 1;
    console.log(`NEGATIVE ${JSON.stringify({ foldLivePass: foldLive.pass, convoRequests, mainSame, exitCode })}`);
    return exitCode;
  } catch (error) {
    const result = {
      schema: 1, task: 'board-stale-cards-recurrence task 9', mode: 'negative', intended: true, flag: '--no-cache',
      error: String((error && error.stack) || error), startedAt: new Date(startedAt).toISOString(), finishedAt: nowIso(), build,
      positiveResultExists: fs.existsSync(path.join(OUT, 'result.json')),
    };
    cleanup = await teardown();
    result.cleanup = cleanup;
    writeNegJson('negative-result.json', result);
    console.error(`NEGATIVE SETUP FAILURE: ${(error && error.message) || error}`);
    return 2;
  }
}

async function runProbeOnly() {
  await setup({ withLegacy: true });
  phase = 'round2-probe';
  let probe = null, error = null;
  try { probe = await round2Probe(); }
  catch (caught) {
    error = String((caught && caught.stack) || caught);
    if (probeDebug) probe = { pass: false, checks: probeDebug.checks, measurements: probeDebug.measurements, failed: probeDebug.checks.filter((c) => !c.ok), error };
  }
  const receipt = await teardown();
  const doc = {
    schema: 1, task: 'board-stale-cards-recurrence task 9', mode: 'round2-probe',
    startedAt: new Date(startedAt).toISOString(), finishedAt: nowIso(), out: OUT, build,
    probe, error, cleanup: receipt, console: { errors: consoleErrors, exceptions: pageExceptions }, hostErrors,
  };
  writeJson('round2-probe.json', doc);
  const pass = !!(probe && probe.pass) && !!receipt.pass;
  console.log(`PROBE ${JSON.stringify({ pass, error: error ? error.split('\n')[0] : null, failed: probe ? probe.failed.map((c) => c.name) : null, out: OUT })}`);
  return pass ? 0 : 1;
}

// Owner #444 A: focused attempt-3 measurements. The same checks run before and after the local CSS repair.
// Natural keyboard traversal never calls focus(), changes tabindex, or injects a synthetic click.
async function runAttempt3Probe({ standalone = true } = {}) {
  if (standalone) await setup({ withLegacy: false });
  phase = 'round2-errors'; // the existing known-fault console classifier covers these same HTTP-500 injections
  const checks = [], measurements = { counts: [], rows: [], retry: [], keyboard: null };
  const check = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });
  const key = async (name, code, virtual) => {
    await page.client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: virtual });
    await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: virtual });
  };
  const active = () => pageEval(`(() => {
    const el = document.activeElement, cs = getComputedStyle(el);
    return { tag: el.tagName, act: el.getAttribute('data-act'), sh: el.getAttribute('data-sh'),
      sid: el.getAttribute('data-sid'), text: el.textContent.trim().slice(0, 100),
      focusVisible: el.matches(':focus-visible'), outline: cs.outlineStyle, outlineWidth: cs.outlineWidth,
      connected: el.isConnected, body: el === document.body };
  })()`);
  try {
    await loadUrl(SERVER_URL, VIEWPORTS[0], 'light');
    for (const vp of VIEWPORTS.slice(0, 2)) for (const theme of THEMES) {
      await loadUrl(SERVER_URL, vp, theme);
      const value = await pageEval(`(() => { const el = document.querySelector('#main .cv-fold-counts'); return { font: parseFloat(getComputedStyle(el).fontSize), text: el.textContent }; })()`);
      measurements.counts.push({ viewport: vp.name, theme, ...value });
      check(`B-C1-${vp.name}-${theme}`, value.font >= 14, value);
    }
    for (const theme of THEMES) {
      const vp = VIEWPORTS[2];
      await loadUrl(SERVER_URL, vp, theme);
      await click('[data-sh="view"][data-key="archive"]');
      const value = await pageEval(`(() => {
        const row = document.querySelector('#side .sh-row[data-row="boundary-plus"]');
        const go = row.querySelector('.sh-go'), fav = row.querySelector('.sh-fav');
        const a = go.getBoundingClientRect(), b = fav.getBoundingClientRect();
        const marker = row.querySelector('.sh-fold'), title = row.querySelector('.sh-t');
        return { gap: b.left - a.right, open: { x:a.x, width:a.width, height:a.height },
          favourite: { x:b.x, width:b.width, height:b.height }, titleWidth:title.clientWidth,
          markerWidth:marker.getBoundingClientRect().width, markerFont:parseFloat(getComputedStyle(marker).fontSize) };
      })()`);
      measurements.rows.push({ theme, ...value });
      check(`B-D1-gap-${theme}`, value.gap >= 8 && value.gap <= 12, value);
      check(`B-D1-title-marker-${theme}`, value.titleWidth >= 60 && value.markerWidth > 0 && value.markerFont >= 14 && value.open.height >= 44 && value.favourite.height >= 44, value);
      failControl.mode = 'http500'; failControl.sid = 'big';
      await click('#side .sh-row[data-row="big"] .sh-go');
      await waitDom(`document.querySelector('#main .cv-fold[data-fold="error"]') !== null`, 'attempt3 error');
      await scrollTo('#main [data-act="fold-retry"]');
      const retry = await pageEval(`(() => {
        const el = document.querySelector('#main [data-act="fold-retry"]'), cs = getComputedStyle(el), r = el.getBoundingClientRect();
        const bg = getComputedStyle(document.querySelector('#main')).backgroundColor;
        return { border:cs.borderBottomColor, background:bg, x:r.x,y:r.y,width:r.width,height:r.height };
      })()`);
      const shot = await clippedPng({ x:retry.x + 8, y:retry.y + retry.height - 1, width:retry.width - 16, height:2 }, vp.dpr, `attempt3-retry-${theme}.png`);
      const edgePixels = pixelContrast(shot.buffer, shot.region);
      measurements.retry.push({ theme, ...retry, edgePixels, file:shot.file, sha256:sha256(shot.buffer), png:shot.info });
      extras.push({ view:'attempt3-error', kind:'attempt3', required:false, mode:'server', viewport:vp, theme, file:shot.file, sha256:sha256(shot.buffer), bytes:shot.buffer.length, expected:{pixelWidth:vp.width*vp.dpr,pixelHeight:vp.height*vp.dpr}, png:shot.info, stateCheck:{edgePixels}, buildId:build.buildId, at:nowIso() });
      check(`B-E2-${theme}`, edgePixels.ratio >= 3, edgePixels);
      if (theme === 'light') {
        const traversal = [];
        let reached = false;
        for (let i = 0; i < 1200; i++) {
          await key('Tab','Tab',9);
          const step = await active();
          traversal.push({ step:i+1, ...step });
          if (step.act === 'fold-retry') { reached = true; break; }
        }
        check('A-R2-04-natural-retry-reachable', reached, { steps:traversal.length });
        if (!reached) throw new Error('Natural Tab traversal did not reach retry within the bounded DOM control count');
        const before = await active();
        measurements.keyboard = { traversal, before, method:'CDP natural Tab and Space activation; no programmatic focus or tabindex edits' };
        const hold = armConvoHold();
        const request = pending(waitConvoAfter(convoLog.length, rec => rec.sid === 'big', 'attempt3 keyboard retry request'));
        // Subscribe to the DOM transition and the next painted frame before keyboard activation.
        await pageEval(`(() => {
          window.__attempt3Focus = [];
          const sample = phase => { const e=document.activeElement; window.__attempt3Focus.push({ phase, at:performance.now(), tag:e.tagName, act:e.getAttribute('data-act'), body:e===document.body, connected:e.isConnected, focusVisible:e.matches(':focus-visible'), fold:document.querySelector('.cv-fold')?.getAttribute('data-fold') ?? null }); };
          window.__attempt3FocusObserver = new MutationObserver(() => sample('mutation'));
          __attempt3FocusObserver.observe(document.querySelector('#main'), {subtree:true,childList:true,attributes:true});
          document.addEventListener('keydown', () => { sample('keydown-capture'); requestAnimationFrame(() => sample('first-painted-frame')); }, {once:true,capture:true});
          document.addEventListener('click', () => sample('native-click-capture'), {once:true,capture:true});
          return true;
        })()`);
        const loading = pending(waitDom(`document.querySelector('#main .cv-fold[data-fold="loading"]') !== null`, 'attempt3 keyboard retry loading'));
        await key(' ','Space',32);
        await request;
        await loading;
        await waitFrames(1);
        const during = await active();
        await capture('attempt3-keyboard-loading',vp,theme,{stateCheck:during},{required:false,file:'attempt3-keyboard-loading.png',park:false});
        hold.resolve();
        await waitDom(`document.querySelector('#main .cv-fold') === null`, 'attempt3 keyboard retry recovery', 30000);
        await waitFrames(1);
        const after = await active();
        const trace = await pageEval('window.__attempt3FocusObserver.disconnect(); window.__attempt3Focus');
        await capture('attempt3-keyboard-recovered',vp,theme,{stateCheck:after},{required:false,file:'attempt3-keyboard-recovered.png',park:false});
        Object.assign(measurements.keyboard, { during, after, trace });
        check('A-R2-04-focus-continuity', !before.body && !during.body && !after.body && during.connected && after.connected, { before, during, after, trace });
        check('A-R2-04-visible-loading-anchor', during.tag === 'SECTION' && during.focusVisible && parseFloat(during.outlineWidth) >= 2, during);
      }
    }
    measurements.additional = await attempt3ExtraEvidence(check);
  } catch (error) {
    if (measurements.keyboard) {
      measurements.keyboard.atError = await active();
      measurements.keyboard.trace = await pageEval('window.__attempt3FocusObserver?.disconnect(); window.__attempt3Focus || []');
    }
    check('probe-execution', false, { error:String(error.stack || error) });
  } finally {
    releaseHolds();
    const receipt = standalone ? await teardown() : null;
    const doc = { schema:1, ownerAmendment:'#444 A', build, checks, measurements, failed:checks.filter(c => !c.ok), pass:checks.length > 0 && checks.every(c => c.ok), captures:extras.filter(c=>c.kind==='attempt3'||c.view.startsWith('attempt3')), cleanup:receipt, cleanupOwnedBy:standalone?'this probe':'outer positive run' };
    writeJson('attempt3-probe.json',doc);
    console.log(`ATTEMPT3_PROBE ${J({pass:doc.pass,failed:doc.failed.map(c=>c.id),cleanup:receipt && receipt.pass})}`);
    return doc.pass && (!standalone || receipt.pass) ? 0 : 1;
  }
}

async function attempt3ExtraEvidence(check) {
  const out = { pressed:[], hydration:[], empty:[], zoom:[], noSteal:null,
    siblings:'Archive, favourite, recent and previous child share the measured sh-go/sh-fav pressed selectors; the existing marker/caller scenarios separately measure all four. Tabs/inbox open history but do not render a fold marker. Retry has no disabled instance: loading replaces it.' };
  const vp = VIEWPORTS[2], desktop = VIEWPORTS[0];
  const shot = (label,v,t,state,park=true) => capture(label,v,t,{stateCheck:state},{required:false,kind:'attempt3',file:`${label}-${v.name}-${t}.png`,park});
  const identity = () => pageEval(`(() => { const e=document.activeElement; return {tag:e.tagName,act:e.getAttribute('data-act'),sh:e.getAttribute('data-sh'),sid:e.getAttribute('data-sid'),id:e.id,text:e.textContent.trim().slice(0,80),body:e===document.body,focusVisible:e.matches(':focus-visible')}; })()`);
  const key = async (name,code,n) => { await page.client.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:name,code,windowsVirtualKeyCode:n}); await page.client.send('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,windowsVirtualKeyCode:n}); };
  const errorPage = async (v,t) => {
    await loadUrl(SERVER_URL,v,t);
    await click('[data-sh="view"][data-key="archive"]');
    failControl.mode='http500'; failControl.sid='big';
    await click('#side .sh-row[data-row="big"] .sh-go');
    await waitDom(`document.querySelector('.cv-fold[data-fold="error"]') !== null`,'attempt3 error pair');
    await scrollTo('[data-act="fold-retry"]');
  };
  const geometry = () => pageEval(`(() => {
    const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    return {sub:document.querySelector('.cv-page').getAttribute('data-sub'),header:rect('.cv-top'),tabs:rect('.stabs'),panel:rect('.cv-panel'),fold:document.querySelector('.cv-fold')?.getAttribute('data-fold')??null,
      paints:performance.getEntriesByType('paint').map(e=>({name:e.name,startTime:e.startTime})),mainScroll:document.querySelector('#main').scrollTop};
  })()`);
  const press = async (selector,label,v,t) => {
    await page.client.send('Emulation.setEmitTouchEventsForMouse',{enabled:false,configuration:'mobile'});
    const base = await pageEval(`(() => {const e=document.querySelector(${J(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {x:r.x+r.width/2,y:r.y+r.height/2,bg:c.backgroundColor,shadow:c.boxShadow};})()`);
    await page.client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:base.x,y:base.y,button:'none'});
    await shot(`${label}-hover`,v,t,{selector},false);
    await pageEval(`(() => {const e=document.querySelector(${J(selector)});window.__a3PressFrame=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No first-frame pointer feedback within 5s')),5000);e.addEventListener('mousedown',ev=>{const inputAt=performance.now();requestAnimationFrame(frame=>{clearTimeout(timer);const c=getComputedStyle(e);resolve({inputAt,frameAt:performance.now(),rafTimestamp:frame,active:e.matches(':active'),bg:c.backgroundColor,shadow:c.boxShadow,transition:c.transitionDuration});});},{once:true});});window.__a3PressFrame.catch(()=>{});return true;})()`);
    await page.client.send('Input.dispatchMouseEvent',{type:'mousePressed',x:base.x,y:base.y,button:'left',clickCount:1});
    const first = await pageEval('window.__a3PressFrame');
    check(`${label}-A-R2-01-first-frame`,first.active && (first.bg!==base.bg || first.shadow!==base.shadow),{base,first});
    await shot(`${label}-pressed`,v,t,{base,first},false);
    return {base,first,release:()=>page.client.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:base.x,y:base.y,button:'left',clickCount:1})};
  };
  for (const kind of ['open','favourite']) {
    await loadUrl(SERVER_URL,vp,'light');
    await click('[data-sh="view"][data-key="archive"]');
    const selector=`#side .sh-row[data-row="boundary-plus"] .${kind==='open'?'sh-go':'sh-fav'}`;
    const p=await press(selector,`attempt3-row-${kind}`,vp,'light');
    await p.release();
    await waitFrames(1);
    const released=await pageEval(`({pressed:!!document.querySelector(${J(selector+':active')})})`);
    check(`attempt3-row-${kind}-released`,!released.pressed,released);
    await shot(`attempt3-row-${kind}-released`,vp,'light',released,false);
    out.pressed.push({kind,base:p.base,first:p.first,released});
  }
  for (const theme of THEMES) {
    await errorPage(vp,theme);
    const before=await geometry();
    await shot('attempt3-hydration-before',vp,theme,before);
    await pageEval(`(() => {window.__a3Shifts=[];window.__a3ShiftObserver=new PerformanceObserver(list=>{for(const e of list.getEntries())window.__a3Shifts.push({value:e.value,hadRecentInput:e.hadRecentInput,sources:(e.sources||[]).map(s=>({node:s.node?.className,previous:s.previousRect.toJSON(),current:s.currentRect.toJSON()}))});});__a3ShiftObserver.observe({type:'layout-shift',buffered:false});return true;})()`);
    const hold=armConvoHold(), start=convoLog.length;
    const request=pending(waitConvoAfter(start,r=>r.sid==='big','attempt3 held pointer retry'));
    const p=await press('[data-act="fold-retry"]','attempt3-retry',vp,theme);
    const loading=pending(waitDom(`document.querySelector('.cv-fold[data-fold="loading"]')!==null`,'attempt3 same-subview loading'));
    await p.release();await request;await loading;await waitFrames(1);
    const during=await geometry();
    await shot('attempt3-hydration-during',vp,theme,during);
    hold.resolve();
    await waitDom(`document.querySelector('.cv-fold')===null`,'attempt3 same-subview recovery');
    await waitFrames(1);
    const after=await geometry();
    const shifts=await pageEval('window.__a3ShiftObserver.disconnect(); window.__a3Shifts');
    await shot('attempt3-hydration-after',vp,theme,after);
    const stable=['header','tabs'].every(k=>[during,after].every(s=>s[k]&&before[k]&&Math.abs(s[k].x-before[k].x)<=1&&Math.abs(s[k].y-before[k].y)<=1&&Math.abs(s[k].width-before[k].width)<=1));
    check(`A-R2-02-same-subview-${theme}`,before.sub===during.sub&&before.sub===after.sub&&stable,{before,during,after,shifts});
    out.hydration.push({theme,before,during,after,shifts,intentional:'Panel contents/height change from error to loading to full overview; stable header and tab geometry are checked. Paint timestamps are native first-paint/FCP, not inferred from screenshots.'});
  }
  // Natural Tab away during the held request must remain authoritative after hydration.
  await errorPage(vp,'light');
  let reached=false;
  for(let i=0;i<1200;i++){await key('Tab','Tab',9);if((await identity()).act==='fold-retry'){reached=true;break;}}
  assert.ok(reached,'natural Tab reaches retry for no-steal check');
  const hold=armConvoHold(), request=pending(waitConvoAfter(convoLog.length,r=>r.sid==='big','attempt3 no-steal request'));
  await key(' ','Space',32);await request;
  await waitDom(`document.querySelector('.cv-fold[data-fold="loading"]')!==null`,'attempt3 no-steal loading');
  let away=null;
  for(let i=0;i<4;i++){await key('Tab','Tab',9);away=await identity();if(!away.body&&away.tag!=='SECTION')break;}
  hold.resolve();await waitDom(`document.querySelector('.cv-fold')===null`,'attempt3 no-steal complete');
  const settled=await identity();
  check('A-R2-04-no-focus-steal',!away.body&&away.tag!=='SECTION'&&JSON.stringify(away)===JSON.stringify(settled),{away,settled});
  out.noSteal={away,settled};
  await shot('attempt3-user-tab-kept',vp,'light',out.noSteal,false);
  // Real root CSS zoom, not a renamed normal-size viewport. Chrome performs layout and rasterization at 200%.
  await loadUrl(SERVER_URL,desktop,'light');
  await click('[data-sh="view"][data-key="archive"]');
  await pageEval('document.documentElement.style.zoom="2";true');
  await waitFrames(1);
  const rowZoom=await measureFoldRow('#side .sh-row[data-row="boundary-plus"] .sh-fold');
  const actualZoom=await pageEval('getComputedStyle(document.documentElement).zoom');
  check('B-C4-row-200-percent',Number(actualZoom)===2&&rowZoom.goVisible&&rowZoom.title.clientWidth>0&&!rowZoom.insideTitle,{actualZoom,rowZoom});
  await shot('attempt3-zoom-row',desktop,'light',{actualZoom,rowZoom});
  await pageEval('document.documentElement.style.zoom="1";true');
  for(const theme of THEMES){
    await errorPage(desktop,theme);
    const baseline=await pageEval('document.querySelector(".cv-fold-note").getBoundingClientRect().height');
    await pageEval('document.documentElement.style.zoom="2";true');await waitFrames(1);
    const zoom=await pageEval(`(() => {const note=document.querySelector('.cv-fold-note'),button=document.querySelector('[data-act="fold-retry"]'),r=note.getBoundingClientRect(),b=button.getBoundingClientRect(),panel=document.querySelector('.cv-panel').getBoundingClientRect();return {zoom:getComputedStyle(document.documentElement).zoom,noteHeight:r.height,button:{x:b.x,y:b.y,width:b.width,height:b.height},panel:{x:panel.x,width:panel.width},overlap:r.bottom>b.top,documentWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth};})()`);
    check(`B-C4-panel-200-percent-${theme}`,Number(zoom.zoom)===2&&zoom.noteHeight>=baseline*1.9&&!zoom.overlap&&zoom.button.width>0,zoom);
    await shot('attempt3-zoom-panel',desktop,theme,zoom);
    out.zoom.push({theme,baseline,...zoom});
    await pageEval('document.documentElement.style.zoom="1";true');
  }
  // A zero-report, zero-decision closed conversation is a supported fold, built by the real builder/store path.
  const rel='sessions/boundary-plus/reports.json', original=JSON.parse(store.readText(rel));
  try {
    store.replace(rel,[]);
    const published=renderPage(store,NOW,{...renderOptions,stateDir:STATE,generation:GENERATION});
    assert.ok(published.ok,'empty fixture publication');
    host.notifyPublished();
    for(const mode of ['server','file']){
      await loadUrl(mode==='server'?SERVER_URL:FILE_URL,vp,'light');
      const row=await pageEval('BriefPage.state.model.sessions.find(s=>s.id==="boundary-plus")');
      assert.ok(row.folded&&row.folded.reports===0,'real empty source remains eligible for folding');
      await openFromArchive('boundary-plus');
      await waitDom(`document.querySelector('.cv-fold')===null`,'empty history hydrated');
      await showReports('boundary-plus',0);
      const state=await pageEval(`({empty:!!document.querySelector('.cv-empty'),reports:document.querySelectorAll('.rep').length,nextAction:!!document.querySelector('[data-act="sub"][data-sub="ov"]'),fetches:window.__qaFetch,xhr:window.__qaXhr,token:!!document.querySelector('meta[name="omo-board-token"]'),sub:document.querySelector('.cv-page').getAttribute('data-sub')})`);
      check(`A-R2-03-empty-${mode}`,state.empty&&state.reports===0&&state.nextAction&&(mode!=='file'||state.fetches===0&&state.xhr===0&&!state.token),state);
      await shot(`attempt3-empty-${mode}`,vp,'light',state);
      await click('[data-act="sub"][data-sub="ov"]');
      await waitDom(`document.querySelector('.cv-page[data-sub="ov"]')!==null`,'empty history next action');
      out.empty.push({mode,row:row.folded,...state,nextActionWorks:true});
    }
  } finally {
    store.replace(rel,original);
    const restored=renderPage(store,NOW,{...renderOptions,stateDir:STATE,generation:GENERATION});
    assert.ok(restored.ok,'restore ordinary acceptance fixture');
    host.notifyPublished();
  }
  return out;
}

async function main() {
  let exitCode = 1;
  try {
    exitCode = ATTEMPT3_PROBE ? await runAttempt3Probe() : PROBE_ONLY ? await runProbeOnly() : NEGATIVE ? await runNegative() : await runPositive();
  } catch (error) {
    const failure = { schema: 1, task: 'board-stale-cards-recurrence task 9', mode: NEGATIVE ? 'negative' : 'positive', setupError: String((error && error.stack) || error), at: nowIso() };
    try { if (NEGATIVE) writeNegJson('negative-result.json', failure); else writeJson('result.json', failure); } catch { /* evidence path failure is reported on stderr */ }
    console.error(`SETUP FAILURE: ${(error && error.stack) || error}`);
    try { if (!cleanup) cleanup = await teardown(); } catch (teardownError) { console.error(`TEARDOWN FAILURE: ${(teardownError && teardownError.stack) || teardownError}`); }
    exitCode = 1;
  }
  process.exit(exitCode);
}

await main();
