// Board profiles view visual QA + guarded-write end-to-end (plan todo 13).
//
// One temp home pair (primary + stable-500) seeded from the todo-3 redacted switcher
// goldens, the real board page served by the real src/server.mjs on a temp port
// outside the live board's 47317-47326 range, and ONE headless Chrome:
//   <out>/profiles-<390|1024|1440>-<light|dark>.png         the 6-shot matrix
//   <out>/profiles-<390|1440>-<light|dark>-full.png         full-page companions
//   <out>/state-<pending|preview|conflict|success>-<390|1024|1440>-<light|dark>.png  tray / diff / 409 states
//   <out>/state-<loading|error>-<390|1024|1440>-<light|dark>.png  fetch-pending and fetch-failed frames
//   <out>/state-<state>-<viewport>-<theme>-full.png
//   <out>/captures.json                                    manifest + measured evidence
//   <evidence>/task-13-piomo-primary-agents-e2e.txt        apply proof
//   <evidence>/task-13-piomo-primary-agents-stale.txt      409 proof
//
// The e2e changes one routing row and one agent lane through the real page,
// previews, applies, and compares the temp omo.jsonc bytes with the config the
// todo-7 merge.mjs produces from the same input. Then it edits the temp omo.jsonc
// behind the page and applies again: the store must answer 409 and write nothing.
//
// usage: node scripts/qa-profiles.mjs --out <captures-dir> [--evidence <dir>] [--keep]
// Every wait is an event or a bounded deadline; no polling loop, no fixed sleep.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, isPidAlive, listProfilePids } from './cdp.mjs';
import { createBoardServer } from '../src/server.mjs';
import { pageHtml } from '../src/render.mjs';
import {
  detectStyle, formatJsonText, openProfilesStore, sha256,
} from '../src/profiles/store.mjs';
import {
  clone, getOrCreateCatalogAlias, removeNullModelProfile, setProfileLayerModel,
  stripEngineSectionAlias,
} from '../src/profiles/merge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN = path.join(ROOT, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files');
const PLUGIN = 'C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.38-r1/package/plugin/extensions/omo.js';
const INVENTORY = path.join(ROOT, 'src/profiles/inventory-5.1.38.json');
const VM_FILE = path.join(ROOT, 'test/fixtures/view-model-board.json');
const LIVE_BOARD = [47317, 47326];
const LIVE_FILES = {
  stableOmo: 'C:/Users/USER/.omo-stable-500/home/.omo/omo.jsonc',
  stableSettings: 'C:/Users/USER/.omo-stable-500/home/.omo/agent/settings.json',
  stableModels: 'C:/Users/USER/.omo-stable-500/home/.omo/agent/models.json',
  primaryOmo: 'C:/Users/USER/.omo/omo.jsonc',
  primarySettings: 'C:/Users/USER/.omo/agent/settings.json',
};
const LIVE_SERVER = 'C:/Users/USER/.omo-stable-500/home/.omo/agent/briefing/state/server.json';
const LIVE_OMOTASK = 'C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.38-r1/package/plugin/extensions/omo-task.js';
const FIXED_NOW = Date.parse('2026-10-20T12:00:00Z');
const PS_STYLE = { bom: true, eol: '\r\n', indent: '    ', keySep: ':  ', trailingNewline: true };
const TOKEN = 'piomo-t13-board-token';
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, mobile: true },
  { name: '1024', width: 1024, height: 768, mobile: false },
  { name: '1440', width: 1440, height: 900, mobile: false },
];
const SCHEMES = ['light', 'dark'];
const ROUTE = 'agents/oracle';
const LANE_AGENT = 'atlas';
const LANE = 'geeky-heavy';
const ROUTE_CHANGE = { provider: 'anthropic-subscription', model: 'anthropic-subscription/claude-opus-5-5', thinking: 'medium' };
const CONFLICT_TEXT = '다른 곳에서 바뀌었어요 — 새로고침 후 다시 적용';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};
const OUT = arg('--out') ? path.resolve(arg('--out')) : '';
const EVIDENCE = arg('--evidence') ? path.resolve(arg('--evidence')) : OUT;
const KEEP = argv.includes('--keep');
const PORT_BASE = Number(process.env.OMO_BRIEFING_PORT_BASE || 47480);
if (!OUT) {
  console.error('usage: node scripts/qa-profiles.mjs --out <captures-dir> [--evidence <dir>] [--keep]');
  process.exit(2);
}
if (!Number.isInteger(PORT_BASE) || PORT_BASE < 1024 || PORT_BASE + 4 > 65535
  || (PORT_BASE <= LIVE_BOARD[1] && PORT_BASE + 4 >= LIVE_BOARD[0])) {
  console.error(`OMO_BRIEFING_PORT_BASE=${PORT_BASE}: needs 5 ports outside the live board's ${LIVE_BOARD.join('-')}`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

const run = {
  ok: false,
  startedAt: new Date().toISOString(),
  build: null,
  captures: [],
  checks: {},
  expected: {},
  actual: {},
  stale: {},
  cleanup: {},
  errors: [],
  tempRoot: null,
};
const failures = [];
const fail = (message) => { failures.push(String(message)); throw new Error(message); };
const hashFile = (file) => sha256(fs.readFileSync(file));
const readJsonc = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const stripBom = (text) => text.replace(/^\uFEFF/, '');

function liveState() {
  const hashes = {};
  for (const [key, file] of Object.entries(LIVE_FILES)) {
    try { hashes[file] = hashFile(file); } catch { hashes[file] = null; }
  }
  let server = null;
  try {
    const text = fs.readFileSync(LIVE_SERVER, 'utf8');
    server = { sha256: sha256(Buffer.from(text)), value: JSON.parse(text) };
  } catch { server = { sha256: null, value: null }; }
  let gateMarker = null;
  try {
    gateMarker = fs.readFileSync(LIVE_OMOTASK, 'utf8').includes('piomo-primary-agents:gate-adapter');
  } catch { gateMarker = null; }
  return {
    hashes,
    server: { sha256: server.sha256, pid: server.value?.pid ?? null, port: server.value?.port ?? null },
    gateAdapterMarkerInLiveOmoTask: gateMarker,
    liveAgentDirsWithPrimaryAgents: [
      'C:/Users/USER/.omo-stable-500/home/.omo/agent',
      'C:/Users/USER/.omo/agent',
    ].filter((dir) => fs.existsSync(path.join(dir, 'primary-agents'))),
  };
}

function seedHomes(root) {
  const primary = path.join(root, 'home', 'primary');
  const stable = path.join(root, 'home', 'stable');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(primary, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(stable, 'agent'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const write = (file, value) => fs.writeFileSync(file, formatJsonText(value, PS_STYLE));
  write(path.join(primary, 'omo.jsonc'), JSON.parse(fs.readFileSync(path.join(GOLDEN, 'primary/omo.jsonc.json'), 'utf8')));
  write(path.join(primary, 'agent', 'settings.json'), JSON.parse(fs.readFileSync(path.join(GOLDEN, 'primary/settings.json.json'), 'utf8')));
  write(path.join(primary, 'native-profile-selection.json'), { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' });
  write(path.join(primary, 'agent', 'native-profile-selection.json'), { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' });
  write(path.join(stable, 'omo.jsonc'), JSON.parse(fs.readFileSync(path.join(GOLDEN, 'stable/omo.jsonc.json'), 'utf8')));
  fs.writeFileSync(path.join(stable, 'agent', 'settings.json'), '{"packages":["stable"]}');
  return { primary, stable, stateDir };
}

// Model-authored HTML probe: a catalog alias and an unused routing row carry hostile
// markup. The view must render it as text and create no element.
function addXssProbe(omoFile, style) {
  const config = readJsonc(omoFile);
  const catalog = (config['[senpi]'] ?? config['[native]']).models;
  catalog['qa-xss-probe'] = { model: 'openai/<img src=x onerror=window.__qaXss=1>', variant: 'medium' };
  const layer = config.profiles['native-gpt-kimi-deepseek']['[senpi]']
    ?? config.profiles['native-gpt-kimi-deepseek']['[native]'];
  layer.agents.ouroboros = { model: 'qa-xss-probe' };
  fs.writeFileSync(omoFile, formatJsonText(config, style));
}

function expectedConfigFrom(input, style) {
  const config = clone(input);
  const catalog = (config['[senpi]'] ?? config['[native]']).models;
  const resolved = getOrCreateCatalogAlias({
    catalog, provider: ROUTE_CHANGE.provider, model: ROUTE_CHANGE.model, reasoning: ROUTE_CHANGE.thinking,
  });
  setProfileLayerModel({
    config, profileKey: 'native-gpt-kimi-deepseek', section: 'agents', role: 'oracle',
    alias: resolved.alias, ensureCatalogAlias: true,
    ensureModelId: ROUTE_CHANGE.model, ensureVariant: ROUTE_CHANGE.thinking,
  });
  const saved = removeNullModelProfile(stripEngineSectionAlias(clone(config)));
  return { config: saved, alias: resolved.alias, bytes: Buffer.from(formatJsonText(saved, style), 'utf8') };
}

function request({ port, path: pathname = '/', method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, agent: false,
      headers: { Connection: 'close', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function pngInfo(file) {
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `not a PNG: ${file}`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

const sleepFrame = () => 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))';

async function main() {
  const liveBefore = liveState();
  run.liveBefore = liveBefore;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-t13-'));
  run.tempRoot = root;
  const homes = seedHomes(root);
  const omoPath = path.join(homes.primary, 'omo.jsonc');
  const rosterPath = path.join(homes.stable, 'agent', 'primary-agents', 'roster.json');
  const journalPath = path.join(homes.stable, 'agent', 'primary-agents', 'apply-journal.json');
  const backupDir = path.join(homes.primary, 'runtime', 'native-profile-switcher-backups');
  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  const store = openProfilesStore({
    primaryHome: homes.primary, stableHome: homes.stable, mirrorHomes: [],
    pluginPath: PLUGIN, inventory, now: () => FIXED_NOW,
  });
  const vm = JSON.parse(fs.readFileSync(VM_FILE, 'utf8'));
  const server = createBoardServer({
    portBase: PORT_BASE, portCount: 5, generation: 7, token: TOKEN,
    getPage: () => pageHtml(vm, 7, { mode: 'server', token: TOKEN }),
    getViewModel: () => vm,
    profilesState: () => store.state(),
    onProfiles: (body) => store.handle(body),
  });
  const { port } = await server.start();
  const url = `http://127.0.0.1:${port}/`;
  run.server = { url, port, stateDir: homes.stateDir };
  const pageText = (await request({ port, path: '/' })).body;
  const buildHash = sha256(Buffer.from(pageText.split(TOKEN).join('<board-token>')));
  run.build = { hash: buildHash, pageBytes: Buffer.byteLength(pageText), url };
  run.fixture = {
    goldens: path.relative(ROOT, GOLDEN).replace(/\\/g, '/'),
    omoBefore: hashFile(omoPath),
    rosterPresent: fs.existsSync(rosterPath),
    inventoryPinned: inventory.sources.omo.sha256,
    pluginLoaded: sha256(fs.readFileSync(PLUGIN)),
  };

  let page;
  let chromePids = [];
  let closeError = null;
  try {
    page = await launch({ width: 1440, height: 900 });
    chromePids = [...new Set([page.pid, ...listProfilePids(page.profileDir)])].sort((a, b) => a - b);
    run.chrome = { pid: page.pid, profileDir: page.profileDir, pids: chromePids };
    const consoleErrors = [];
    const listen = (method, fn) => {
      page.client.listeners.set(method, [...(page.client.listeners.get(method) || []), fn]);
    };
    await page.client.send('Log.enable');
    listen('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        const text = `console.error ${(p.args || []).map((a) => a.value ?? a.description).join(' ')}`;
        if (text.includes('qa-offline')) { run.checks.expectedOfflineLog = text; return; }
        consoleErrors.push(text);
      }
    });
    listen('Runtime.exceptionThrown', (p) => consoleErrors.push(`exception ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`));
    listen('Log.entryAdded', (p) => {
      if (p.entry?.level !== 'error') return;
      const text = `${p.entry.text} ${p.entry.url || ''}`.trim();
      if (text.includes('/profiles') && /409/.test(text)) { run.checks.expected409Log = text; return; }
      consoleErrors.push(`log ${text}`);
    });
    const waitFor = (predicate, what, timeout = 10000) => page.eval(`new Promise((resolve, reject) => {
      const check = () => { try { return (${predicate}); } catch (e) { return null; } };
      const hit = check();
      if (hit) return resolve(hit);
      const observer = new MutationObserver(() => { const value = check(); if (value) { done(); resolve(value); } });
      const timer = setTimeout(() => { done(); reject(new Error(${JSON.stringify(`timeout waiting for ` + what)})); }, ${timeout});
      function done() { observer.disconnect(); clearTimeout(timer); }
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    })`);

    const openProfiles = async () => {
      await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
      await waitFor(`document.querySelectorAll('.pf-agent').length === 4 && !document.querySelector('.pf-loading')`, 'profiles view');
    };
    const applyViewport = async (vp) => {
      await page.client.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile,
      });
      await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: vp.mobile, maxTouchPoints: vp.mobile ? 5 : 1 });
    };
    const applyScheme = (scheme) => page.client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    });
    const scrollTop = () => page.eval(`(() => { window.scrollTo(0, 0); const m = document.querySelector('#main'); if (m) m.scrollTop = 0; return true; })()`);
    const closePeek = async () => {
      if (await page.eval(`!!document.querySelector('.sh-shell') && document.querySelector('.sh-shell').getAttribute('data-peek') === 'true'`)) {
        await page.eval(`document.querySelector('.sh-ib').click()`);
        await settle();
      }
    };
    const settle = async () => {
      await page.eval(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
      await page.eval(sleepFrame());
    };
    const capture = async (file, { full = false } = {}) => {
      if (full) {
        const metrics = await page.client.send('Page.getLayoutMetrics');
        const size = metrics.cssContentSize;
        const height = Math.min(Math.ceil(size.height), 16000);
        const shot = await page.client.send('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true, fromSurface: true,
          clip: { x: 0, y: 0, width: Math.ceil(size.width), height, scale: 1 },
        });
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      } else {
        await page.screenshot(file);
      }
      const info = pngInfo(file);
      assert.ok(info.bytes > 8000, `screenshot too small (blank?): ${file} ${info.bytes}`);
      run.captures.push({ file: path.relative(OUT, file).replace(/\\/g, '/'), ...info, full });
      return info;
    };

    // The shell scrolls #main, so a page-level "full page" shot would only repeat the
    // viewport. Capture every section at its scroll stops instead (no layout change).
    const captureSections = async (vp, scheme) => {
      const layout = await page.eval(`(() => {
        const main = document.querySelector('#main');
        const base = main.getBoundingClientRect().top - main.scrollTop;
        return [...document.querySelectorAll('[data-pf-sec]')].map((el) => ({
          key: el.getAttribute('data-pf-sec'),
          top: Math.max(0, Math.round(el.getBoundingClientRect().top - base)),
          height: Math.round(el.getBoundingClientRect().height),
          view: main.clientHeight,
          max: Math.max(0, main.scrollHeight - main.clientHeight),
        }));
      })()`);
      for (const sec of layout) {
        if (!sec.key) continue;
        const stops = [sec.top];
        if (sec.height > sec.view) {
          if (sec.key === 'routing') stops.push(sec.top + Math.floor((sec.height - sec.view) / 2));
          stops.push(sec.top + sec.height - sec.view);
        }
        const unique = [...new Set(stops.map((n) => Math.max(0, Math.min(Math.round(n), sec.max))))];
        for (let i = 0; i < unique.length; i += 1) {
          await page.eval(`document.querySelector('#main').scrollTop = ${unique[i]}`);
          await settle();
          const suffix = unique.length > 1 ? `-${i + 1}` : '';
          await capture(path.join(OUT, `section-${sec.key}-${vp.name}-${scheme}${suffix}.png`));
        }
      }
      run.checks.sectionLayout = run.checks.sectionLayout || {};
      run.checks.sectionLayout[`${vp.name}-${scheme}`] = layout;
      await page.eval(`document.querySelector('#main').scrollTop = 0`);
    };

    const captureState = async (name, vp, theme) => {
      await applyViewport(vp);
      await applyScheme(theme);
      await closePeek();
      await page.eval(`(() => { const tray = document.querySelector('.pf-tray'); if (tray) tray.scrollIntoView({ block: 'start' }); return true; })()`);
      await settle();
      await capture(path.join(OUT, `state-${name}-${vp.name}-${theme}.png`));
      if (name === 'preview' || name === 'success') {
        await page.eval(`(() => { const list = document.querySelectorAll('.pf-diff, .pf-backups'); const last = list[list.length - 1]; if (last) last.scrollIntoView({ block: 'end' }); return true; })()`);
        await settle();
        await capture(path.join(OUT, `state-${name}-${vp.name}-${theme}-end.png`));
      }
    };

    await page.goto(url);
    await waitFor(`!!document.querySelector('[data-shell]')`, 'board shell');
    await openProfiles();

    // ── 6-shot matrix + full-page companions (one browser, one page) ───────────
    for (const vp of VIEWPORTS) {
      await applyViewport(vp);
      await scrollTop();
      await settle();
      for (const scheme of SCHEMES) {
        await applyScheme(scheme);
        await scrollTop();
        await settle();
        await capture(path.join(OUT, `profiles-${vp.name}-${scheme}.png`));
        await captureSections(vp, scheme);
      }
    }

    // ── measured evidence at 1440 and 390 ──────────────────────────────────────
    await applyViewport(VIEWPORTS[2]);
    await applyScheme('light');
    await scrollTop();
    await settle();
    run.checks.layout1440 = await page.eval(`(() => {
      const main = document.querySelector('#main');
      const over = [...document.querySelectorAll('.pf *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
      }).map((el) => el.className || el.tagName).slice(0, 20);
      return { docScrollWidth: document.documentElement.scrollWidth, innerWidth,
        mainScrollWidth: main.scrollWidth, mainClientWidth: main.clientWidth, overflow: over };
    })()`);
    assert.equal(run.checks.layout1440.docScrollWidth <= run.checks.layout1440.innerWidth, true, '1440 horizontal scroll');
    assert.deepEqual(run.checks.layout1440.overflow, [], '1440 elements outside the viewport');

    // Round-3 A7/A8: in every agent row the lane, pin and thinking selects start on one line, and the
    // reset action lives inside the memory field (never under the agent name).
    const agentAlignment = () => page.eval(`(() => {
      const top = (el) => el ? Math.round(el.getBoundingClientRect().top) : null;
      const center = (el) => el ? Math.round((el.getBoundingClientRect().top + el.getBoundingClientRect().bottom) / 2) : null;
      const rows = [...document.querySelectorAll('.pf-agent')].map((row) => {
        const lane = row.querySelector('[data-pf="agent-lane"]');
        const pin = row.querySelector('[data-pf="agent-pin"]');
        const think = row.querySelector('[data-pf="agent-pin-thinking"]');
        const mem = row.querySelector('.pf-mem');
        const reset = row.querySelector('[data-pf="reset-memory"]');
        const tops = [lane, pin, think].filter(Boolean).map(top);
        return { agent: row.getAttribute('data-pf-agent'), laneTop: top(lane), pinTop: top(pin), thinkingTop: top(think),
          delta: tops.length ? Math.max(...tops) - Math.min(...tops) : null,
          resetGap: reset && mem ? Math.abs(center(reset) - center(mem)) : null,
          resetInsideMemory: !!(reset && reset.closest('.pf-mem-field')) };
      });
      return { rows, maxDelta: Math.max(...rows.map((r) => r.delta || 0)),
        maxResetGap: Math.max(...rows.map((r) => r.resetGap || 0)),
        resetOutside: rows.filter((r) => !r.resetInsideMemory).map((r) => r.agent) };
    })()`);
    run.checks.agentAlign1440 = await agentAlignment();
    assert.equal(run.checks.agentAlign1440.maxDelta <= 1, true, 'agent lane/pin/thinking select tops differ at 1440');
    assert.deepEqual(run.checks.agentAlign1440.resetOutside, [], 'reset action outside the memory field at 1440');
    assert.equal(run.checks.agentAlign1440.maxResetGap <= 20, true, 'reset action is not next to the memory value at 1440');

    await applyViewport(VIEWPORTS[1]);
    await applyScheme('light');
    await settle();
    run.checks.agentAlign1024 = await agentAlignment();
    assert.equal(run.checks.agentAlign1024.maxDelta <= 1, true, 'agent lane/pin/thinking select tops differ at 1024');
    assert.deepEqual(run.checks.agentAlign1024.resetOutside, [], 'reset action outside the memory field at 1024');
    assert.equal(run.checks.agentAlign1024.maxResetGap <= 20, true, 'reset action is not next to the memory value at 1024');
    run.checks.layout1024 = await page.eval(`(() => {
      const main = document.querySelector('#main');
      const over = [...document.querySelectorAll('.pf *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
      }).map((el) => ({ cls: String(el.className).slice(0, 80), tag: el.tagName })).slice(0, 20);
      return { docScrollWidth: document.documentElement.scrollWidth, innerWidth,
        mainScrollWidth: main.scrollWidth, mainClientWidth: main.clientWidth, overflow: over };
    })()`);
    assert.equal(run.checks.layout1024.docScrollWidth <= run.checks.layout1024.innerWidth, true, '1024 horizontal scroll');
    assert.equal(run.checks.layout1024.mainScrollWidth <= run.checks.layout1024.mainClientWidth, true, '1024 main horizontal scroll');
    assert.deepEqual(run.checks.layout1024.overflow, [], '1024 elements outside the viewport');

    await applyViewport(VIEWPORTS[0]);
    await applyScheme('light');
    await scrollTop();
    await settle();
    run.checks.layout390 = await page.eval(`(() => {
      const main = document.querySelector('#main');
      const over = [...document.querySelectorAll('.pf *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
      }).map((el) => el.className || el.tagName).slice(0, 20);
      const controls = [...document.querySelectorAll('.pf-btn, .pf select, .pf input')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ tag: el.tagName.toLowerCase(), h: Math.round(el.getBoundingClientRect().height),
          w: Math.round(el.getBoundingClientRect().width) }));
      const clipped = [...document.querySelectorAll('.pf *')].filter((el) => {
        if (['SELECT', 'INPUT', 'TEXTAREA', 'OPTION'].includes(el.tagName)) return false;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        return own && el.scrollWidth > el.clientWidth + 1;
      }).map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80),
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: el.textContent.trim().slice(0, 120) }));
      return { docScrollWidth: document.documentElement.scrollWidth, innerWidth,
        mainScrollWidth: main.scrollWidth, mainClientWidth: main.clientWidth, overflow: over, clipped,
        controls: { count: controls.length, minHeight: Math.min(...controls.map((c) => c.h)),
          minWidth: Math.min(...controls.map((c) => c.w)), sample: controls.slice(0, 8) } };
    })()`);
    assert.equal(run.checks.layout390.docScrollWidth <= run.checks.layout390.innerWidth, true, '390 horizontal scroll');
    assert.deepEqual(run.checks.layout390.overflow, [], '390 elements outside the viewport');

    run.checks.a11y = await page.eval(`(() => {
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const labelFor = new Map();
      for (const label of document.querySelectorAll('.pf label[for]')) {
        const id = label.getAttribute('for');
        if (!id) continue;
        const text = norm((label.querySelector('.pf-sel-t') || label).textContent);
        if (text) labelFor.set(id, text);
      }
      const nameOf = (el) => {
        const aria = norm(el.getAttribute('aria-label'));
        if (aria) return aria;
        const ref = el.getAttribute('aria-labelledby');
        if (ref) {
          const text = norm(ref.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean)
            .map((node) => node.textContent).join(' '));
          if (text) return text;
        }
        if (el.id && labelFor.has(el.id)) return labelFor.get(el.id);
        const wrap = el.closest('label');
        if (wrap) return norm(wrap.querySelector('.pf-sel-t') ? wrap.querySelector('.pf-sel-t').textContent : wrap.textContent);
        if (el.tagName === 'BUTTON') return norm(el.textContent);
        return '';
      };
      const controls = [...document.querySelectorAll('.pf select, .pf input, .pf button, [data-pf-side] button')]
        .filter(visible);
      const expected = {
        'route-provider': '서비스', 'route-model': '모델', 'route-thinking': '추론',
        'memory-mode': '모드', 'memory-model': '모델', 'memory-thinking': '추론',
        'agent-lane': '레인', 'agent-pin': '핀', 'agent-pin-thinking': '추론',
        'main-provider': '서비스', 'main-model': '모델', 'main-thinking': '추론',
        'lane-select': 'model_profile', 'lane-literal': '직접 입력 값', 'summarizer-model': '요약 모델'
      };
      const rows = controls.map((el) => {
        const labelEl = el.id ? document.querySelector('.pf label[for="' + CSS.escape(el.id) + '"] .pf-sel-t') : null;
        return { tag: el.tagName.toLowerCase(), pf: el.getAttribute('data-pf') || '', id: el.id || '',
          name: nameOf(el), label: el.id && labelFor.has(el.id) ? labelFor.get(el.id) : '', labelVisible: visible(labelEl) };
      });
      const selects = rows.filter((r) => r.tag === 'select');
      return {
        controls: rows.length,
        selects: selects.length,
        unnamed: rows.filter((r) => !r.name).map((r) => ({ tag: r.tag, pf: r.pf, id: r.id })),
        selectsWithoutVisibleLabel: selects.filter((r) => !r.label || !r.labelVisible).map((r) => ({ pf: r.pf, id: r.id })),
        wrongLabels: rows.filter((r) => expected[r.pf] && r.label !== expected[r.pf])
          .map((r) => ({ pf: r.pf, expected: expected[r.pf], actual: r.label })),
        sample: rows.filter((r) => expected[r.pf]).slice(0, 12)
      };
    })()`);
    assert.deepEqual(run.checks.a11y.unnamed, [], 'controls without an accessible name');
    assert.deepEqual(run.checks.a11y.selectsWithoutVisibleLabel, [], 'select without a visible label');
    assert.deepEqual(run.checks.a11y.wrongLabels, [], 'per-control label mismatch');
    assert.ok(run.checks.a11y.selects > 0, 'no selects measured');

    run.checks.header390 = await page.eval(`(() => {
      const keep = document.querySelector('.pf-sub .pf-keep');
      if (!keep) return { present: false };
      const range = document.createRange();
      range.selectNodeContents(keep);
      const rects = [...range.getClientRects()].map((r) => ({ top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) }));
      const lines = [...new Set(rects.map((r) => r.top))].length;
      return { present: true, text: keep.textContent, whiteSpace: getComputedStyle(keep).whiteSpace, rects, lines,
        overflow: keep.getBoundingClientRect().right > innerWidth + 1 };
    })()`);
    assert.equal(run.checks.header390.present, true, 'header phrase span missing');
    assert.equal(run.checks.header390.whiteSpace, 'nowrap', 'header phrase is breakable');
    assert.equal(run.checks.header390.lines, 1, 'header phrase split across lines at 390');
    assert.equal(run.checks.header390.overflow, false, 'header phrase overflows at 390');

    // Round-3 C5: every keep-together phrase (header and profile summaries) occupies one line at 390.
    run.checks.copy390 = await page.eval(`(() => {
      const spans = [...document.querySelectorAll('.pf .pf-keep')].map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const tops = [...new Set([...range.getClientRects()].map((r) => Math.round(r.top)))];
        return { text: el.textContent, lines: tops.length, whiteSpace: getComputedStyle(el).whiteSpace };
      });
      const sub = document.querySelector('.pf-sub');
      return { spans, split: spans.filter((s) => s.lines !== 1),
        headerDot: !!(sub && sub.textContent.includes('·')),
        summaries: [...document.querySelectorAll('.pf-card-sum')].map((el) => el.textContent) };
    })()`);
    assert.deepEqual(run.checks.copy390.split, [], 'a keep-together phrase split at 390');
    assert.equal(run.checks.copy390.headerDot, false, 'header still has a dangling middle dot');

    // Round-3 C4/A9: every native select titles its selected label and declares an ellipsis.
    run.checks.selects = await page.eval(`(() => {
      const canvas = document.createElement('canvas').getContext('2d');
      const rows = [...document.querySelectorAll('.pf select')].map((el) => {
        const cs = getComputedStyle(el);
        canvas.font = cs.font || (cs.fontSize + ' ' + cs.fontFamily);
        const chosen = el.options[el.selectedIndex];
        const text = chosen ? chosen.text : '';
        return { pf: el.getAttribute('data-pf'), id: el.id, title: el.title, text, textOverflow: cs.textOverflow,
          width: Math.round(el.getBoundingClientRect().width), textWidth: Math.round(canvas.measureText(text).width) };
      });
      return { count: rows.length, missingTitle: rows.filter((r) => !r.title).map((r) => r.id),
        titleMismatch: rows.filter((r) => r.title !== r.text).map((r) => ({ id: r.id, title: r.title, text: r.text })),
        noEllipsis: rows.filter((r) => r.textOverflow !== 'ellipsis').map((r) => r.id),
        widerThanControl: rows.filter((r) => r.textWidth > r.width).map((r) => ({ id: r.id, textWidth: r.textWidth, width: r.width })),
        rows };
    })()`);
    assert.equal(run.checks.selects.count > 0, true, 'no selects measured');
    assert.deepEqual(run.checks.selects.missingTitle, [], 'select without a full-value title');
    assert.deepEqual(run.checks.selects.titleMismatch, [], 'select title differs from its selected label');
    assert.deepEqual(run.checks.selects.noEllipsis, [], 'select does not declare an ellipsis');

    const contrastProbe = `(() => {
      const parse = (value) => {
        const m = /rgba?\\(([^)]+)\\)/.exec(value || '');
        if (!m) return null;
        const p = m[1].split(',').map((x) => Number(x.trim()));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const composite = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
      });
      const background = (el) => {
        const layers = [];
        for (let node = el; node; node = node.parentElement) {
          const c = parse(getComputedStyle(node).backgroundColor);
          if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
        }
        let bg = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = layers.length - 1; i >= 0; i -= 1) bg = composite(layers[i], bg);
        return bg;
      };
      const lum = (c) => {
        const f = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
      };
      const rows = [];
      const seen = new Set();
      const selectors = ['.pf-title', '.pf-sub', '.pf-agent-n', '.pf-lbl', '.pf-sel-t', '.pf-route-ko', '.pf-route-en',
        '.pf-btn', '.pf-chip', '.pf-ro-val', '.pf-card-sum', '.pf-nav-b'];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const cs = getComputedStyle(el);
          const fg = parse(cs.color);
          if (!fg) continue;
          const bg = background(el);
          const color = composite(fg, bg);
          const size = Number.parseFloat(cs.fontSize);
          const bold = Number.parseInt(cs.fontWeight, 10) >= 600;
          const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
          const key = [selector, cs.color, JSON.stringify(bg), cs.fontSize].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          const opacity = Number.parseFloat(cs.opacity);
          const alpha = Number.isFinite(opacity) ? opacity : 1;
          const pixelColor = alpha === 1 ? color : composite({ ...color, a: alpha }, bg);
          const pixelRatio = ratio(pixelColor, bg);
          rows.push({ selector, size: cs.fontSize, opacity: alpha, ratio: ratio(color, bg), pixelRatio, need,
            pass: ratio(color, bg) >= need && pixelRatio >= need });
        }
      }
      return { rows, pass: rows.every((r) => r.pass) };
    })()`;
    run.checks.contrast = await page.eval(contrastProbe);
    assert.equal(run.checks.contrast.pass, true, 'light contrast rows below their threshold');
    await applyScheme('dark');
    await settle();
    run.checks.contrastDark = await page.eval(contrastProbe);
    assert.equal(run.checks.contrastDark.pass, true, 'dark contrast rows below their threshold');
    await applyScheme('light');
    await settle();

    // ── loading and error frames: a missing view is not a read-only view ──────
    // The fetch override must exist before page.js starts: a reload with a persisted profiles view calls
    // openProfiles() at startup, so overriding after load would race the real request.
    await applyViewport(VIEWPORTS[2]);
    await applyScheme('light');
    const loadingInit = await page.client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.fetch = () => new Promise(() => {});`,
    });
    await page.goto(url);
    await waitFor(`!!window.BriefPage && window.BriefPage.state.ui.live === true`, 'board page bound for loading probe');
    await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
    await waitFor(`!!document.querySelector('.pf-loading')`, 'loading frame');
    run.checks.loading = await page.eval(`(() => ({
      hasLoading: !!document.querySelector('.pf-loading'),
      badge: (document.querySelector('.pf-head-r .pf-chip') || {}).textContent || '',
      readonlyText: ((document.querySelector('.pf') || {}).innerText || '').match(/읽기 전용/g) || [],
      hasReadonlyNote: !!document.querySelector('.pf-ro-note'),
      sections: document.querySelectorAll('[data-pf-sec]').length,
    }))()`);
    assert.equal(run.checks.loading.hasLoading, true, 'loading frame has no loading status');
    assert.deepEqual(run.checks.loading.readonlyText, [], 'loading frame says read-only');
    assert.equal(run.checks.loading.hasReadonlyNote, false, 'loading frame renders the read-only note');
    assert.equal(run.checks.loading.sections, 0, 'loading frame renders loaded sections');
    await capture(path.join(OUT, 'state-loading-1440-light.png'));
    await captureState('loading', VIEWPORTS[2], 'dark');
    await captureState('loading', VIEWPORTS[1], 'light');
    await captureState('loading', VIEWPORTS[0], 'light');
    await captureState('loading', VIEWPORTS[0], 'dark');
    await page.client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: loadingInit.identifier });

    await applyViewport(VIEWPORTS[2]);
    await applyScheme('light');
    const errorInit = await page.client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.fetch = () => Promise.reject(new Error('qa-offline'));`,
    });
    await page.goto(url);
    await waitFor(`!!window.BriefPage && window.BriefPage.state.ui.live === true`, 'board page bound for error probe');
    await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
    await waitFor(`!!document.querySelector('.pf-error')`, 'error frame');
    run.checks.error = await page.eval(`(() => {
      const box = document.querySelector('.pf-error');
      return {
        hasError: !!box,
        errorText: box ? box.innerText : '',
        hasRetry: !!document.querySelector('.pf-error [data-pf="reload"]'),
        retryLabel: (document.querySelector('.pf-error [data-pf="reload"]') || {}).textContent || '',
        hasLoading: !!document.querySelector('.pf-loading'),
        readonlyText: ((document.querySelector('.pf') || {}).innerText || '').match(/읽기 전용/g) || [],
        hasReadonlyNote: !!document.querySelector('.pf-ro-note'),
      };
    })()`);
    assert.equal(run.checks.error.hasError, true, 'error frame has no error box');
    assert.match(run.checks.error.errorText, /qa-offline/, 'error frame does not show the cause');
    assert.equal(run.checks.error.hasRetry, true, 'error frame has no retry affordance');
    assert.match(run.checks.error.retryLabel, /다시 시도/);
    assert.equal(run.checks.error.hasLoading, false, 'error frame still says loading');
    assert.deepEqual(run.checks.error.readonlyText, [], 'error frame says read-only');
    assert.equal(run.checks.error.hasReadonlyNote, false, 'error frame renders the read-only note');
    await capture(path.join(OUT, 'state-error-1440-light.png'));
    await captureState('error', VIEWPORTS[0], 'light');
    await captureState('error', VIEWPORTS[1], 'light');
    await page.client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: errorInit.identifier });

    // ── XSS probe: hostile model markup must stay text ────────────────────────
    addXssProbe(omoPath, PS_STYLE);
    await page.goto(url);
    await waitFor(`!!document.querySelector('[data-shell]')`, 'board shell after probe reload');
    await openProfiles();
    run.checks.xss = await page.eval(`(() => {
      const row = document.querySelector('[data-pf-route="agents/ouroboros"]');
      const model = row && row.querySelector('[data-pf="route-model"]');
      return {
        rowPresent: !!row,
        modelOptionHtml: model ? model.innerHTML.slice(0, 400) : '',
        textHasLiteral: !!(row && row.textContent.includes('<img src=x onerror=window.__qaXss=1>')),
        injectedElements: document.querySelectorAll('.pf img, .pf script, .pf [onerror]').length,
        flag: window.__qaXss === 1,
      };
    })()`);
    assert.equal(run.checks.xss.rowPresent, true, 'XSS probe route row missing');
    assert.equal(run.checks.xss.textHasLiteral, true, 'XSS probe model is not rendered as text');
    assert.equal(run.checks.xss.injectedElements, 0, 'XSS probe created an element');
    assert.equal(run.checks.xss.flag, false, 'XSS probe executed');

    run.checks.unsetRoutes = await page.eval(`(() => [...document.querySelectorAll('.pf-route')]
      .filter((row) => row.querySelector('.pf-st-unset'))
      .map((row) => ({ route: row.getAttribute('data-pf-route'),
        provider: row.querySelector('[data-pf="route-provider"]').value,
        model: row.querySelector('[data-pf="route-model"]').value,
        thinking: row.querySelector('[data-pf="route-thinking"]').value })))()`);
    run.checks.clippedText = await page.eval(`(() => ([...document.querySelectorAll('.pf *')].filter((el) => {
      if (['SELECT', 'INPUT', 'TEXTAREA', 'OPTION'].includes(el.tagName)) return false;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      return own && el.scrollWidth > el.clientWidth + 1;
    }).map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: el.textContent.trim().slice(0, 120) }))))()`);

    // ── guarded write e2e: route + lane, preview, apply ───────────────────────
    await applyViewport(VIEWPORTS[2]);
    await applyScheme('light');
    await scrollTop();
    await settle();
    const beforeOmo = fs.readFileSync(omoPath);
    const beforeParsed = JSON.parse(stripBom(beforeOmo.toString('utf8')));
    const style = detectStyle(beforeOmo.toString('utf8'));
    const expected = expectedConfigFrom(beforeParsed, style);
    run.expected = {
      routeAlias: expected.alias,
      omoBytes: expected.bytes.length,
      omoSha256: sha256(expected.bytes),
      change: ROUTE_CHANGE,
    };

    await page.eval(`window.__qaProfileFetches = []; const realFetch = window.fetch; window.fetch = function (...args) {
      return realFetch.apply(this, args).then((res) => { window.__qaProfileFetches.push({ url: String(args[0]), status: res.status }); return res; });
    };`);

    await page.eval(`(() => {
      const el = document.querySelector('select[data-pf="agent-lane"][data-agent="${LANE_AGENT}"]');
      if (!el) throw new Error('atlas lane select missing');
      el.value = ${JSON.stringify(LANE)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    await waitFor(`document.querySelectorAll('.pf-pending li').length >= 1`, 'lane pending change');
    await page.eval(`(() => {
      const row = document.querySelector('[data-pf-route="${ROUTE}"]');
      if (!row) throw new Error('route row missing');
      const el = row.querySelector('[data-pf="route-provider"]');
      el.value = ${JSON.stringify(ROUTE_CHANGE.provider)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    await page.eval(`(() => {
      const row = document.querySelector('[data-pf-route="${ROUTE}"]');
      const el = row && row.querySelector('[data-pf="route-model"]');
      if (!el) throw new Error('route model select missing');
      el.value = ${JSON.stringify(ROUTE_CHANGE.model)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    await page.eval(`(() => {
      const row = document.querySelector('[data-pf-route="${ROUTE}"]');
      const el = row && row.querySelector('[data-pf="route-thinking"]');
      if (!el) throw new Error('route thinking select missing');
      el.value = ${JSON.stringify(ROUTE_CHANGE.thinking)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    await waitFor(`document.querySelectorAll('.pf-pending li').length === 2`, 'two pending changes');
    run.expected.pending = await page.eval(`([...document.querySelectorAll('.pf-pending li')].map((li) => li.textContent))`);

    await captureState('pending', VIEWPORTS[2], 'light');
    await captureState('pending', VIEWPORTS[2], 'dark');
    await captureState('pending', VIEWPORTS[1], 'light');
    await applyViewport(VIEWPORTS[2]);
    await applyScheme('light');
    await scrollTop();
    await settle();

    await page.eval(`(() => { document.querySelector('[data-pf="preview"]').click(); return true; })()`);
    await waitFor(`!!document.querySelector('.pf-preview') || !!document.querySelector('.pf-err')`, 'preview result');
    run.checks.preview = await page.eval(`(() => ({
      hasPreview: !!document.querySelector('.pf-preview'),
      hasError: !!document.querySelector('.pf-err'),
      writes: [...document.querySelectorAll('.pf-diff summary code')].map((el) => el.textContent),
      diffText: (document.querySelector('.pf-preview') || {}).innerText || '',
      pendingCount: document.querySelectorAll('.pf-pending li').length,
    }))()`);
    assert.equal(run.checks.preview.hasPreview, true, 'preview did not render: ' + JSON.stringify(run.checks.preview));
    assert.deepEqual([...run.checks.preview.writes].sort(), ['agent/primary-agents/roster.json', 'omo.jsonc'], 'preview write set');
    assert.equal(hashFile(omoPath), sha256(beforeOmo), 'preview wrote omo.jsonc');
    run.checks.previewLayout1440 = await page.eval(`(() => {
      const main = document.querySelector('#main');
      const boxes = [...document.querySelectorAll('.pf-diff, .pf-diff li, .pf-diff-a, .pf-diff-b')].map((el) => ({
        cls: String(el.className).slice(0, 80), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        width: Math.round(el.getBoundingClientRect().width), text: el.textContent.trim().slice(0, 120),
        clipped: el.scrollWidth > el.clientWidth + 1,
      }));
      return { mainScrollWidth: main.scrollWidth, mainClientWidth: main.clientWidth,
        docScrollWidth: document.documentElement.scrollWidth, innerWidth, boxes };
    })()`);
    await applyViewport(VIEWPORTS[0]);
    await applyScheme('light');
    await settle();
    const shellState = () => page.eval(`({ innerWidth, peek: document.querySelector('.sh-shell').getAttribute('data-peek'),
      side: document.querySelector('.sh-shell').getAttribute('data-side'),
      sideVisible: getComputedStyle(document.querySelector('#side')).visibility,
      sideLeft: Math.round(document.querySelector('#side').getBoundingClientRect().left),
      mainLeft: Math.round(document.querySelector('#main').getBoundingClientRect().left),
      mainWidth: Math.round(document.querySelector('#main').getBoundingClientRect().width),
      active: String(document.activeElement && document.activeElement.className || '') })`);
    run.checks.shell390BeforeScroll = await shellState();
    if (run.checks.shell390BeforeScroll.peek === 'true') {
      await page.eval(`document.querySelector('.sh-ib').click()`);
      await settle();
    }
    run.checks.shell390AfterClose = await shellState();
    await capture(path.join(OUT, 'state-preview-390-before-scroll.png'));
    await page.eval(`(() => { const tray = document.querySelector('.pf-tray'); if (tray) tray.scrollIntoView({ block: 'start' }); return true; })()`);
    await settle();
    run.checks.shell390AfterScroll = await shellState();
    run.checks.previewLayout390 = await page.eval(`(() => {
      const main = document.querySelector('#main');
      const boxes = [...document.querySelectorAll('.pf-diff, .pf-diff li, .pf-diff-a, .pf-diff-b')].map((el) => ({
        cls: String(el.className).slice(0, 80), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        width: Math.round(el.getBoundingClientRect().width), text: el.textContent.trim().slice(0, 120),
        clipped: el.scrollWidth > el.clientWidth + 1,
      }));
      return { mainScrollWidth: main.scrollWidth, mainClientWidth: main.clientWidth,
        docScrollWidth: document.documentElement.scrollWidth, innerWidth, boxes };
    })()`);
    // Round-3 D1: both pending remove buttons stay 44x44 in the 390 preview state.
    run.checks.preview390Targets = await page.eval(`(() => [...document.querySelectorAll('.pf-pending [data-pf="drop"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), title: el.getAttribute('title') };
    }))()`);
    assert.equal(run.checks.preview390Targets.length, 2, 'pending remove buttons missing in the 390 preview');
    for (const target of run.checks.preview390Targets) {
      assert.equal(target.w >= 44 && target.h >= 44, true, `remove target ${target.w}x${target.h} below 44x44`);
      assert.equal(target.title, '이 변경 지우기', 'remove target has no tooltip');
    }
    await captureState('preview', VIEWPORTS[0], 'light');
    await captureState('preview', VIEWPORTS[0], 'dark');
    await captureState('preview', VIEWPORTS[1], 'light');
    await applyViewport(VIEWPORTS[2]);
    await applyScheme('light');
    await scrollTop();
    await settle();
    await captureState('preview', VIEWPORTS[2], 'light');
    await captureState('preview', VIEWPORTS[2], 'dark');

    await applyScheme('light');
    await page.eval(`(() => { document.querySelector('[data-pf="apply"]').click(); return true; })()`);
    await waitFor(`!!document.querySelector('.pf-done') || !!document.querySelector('.pf-conflict') || !!document.querySelector('.pf-err')`, 'apply result');
    await waitFor(`!document.querySelector('.pf-loading')`, 'state reload after apply');
    run.checks.apply = await page.eval(`(() => ({
      done: !!document.querySelector('.pf-done'),
      conflict: !!document.querySelector('.pf-conflict'),
      error: (document.querySelector('.pf-err') || {}).textContent || '',
      backups: [...document.querySelectorAll('.pf-backups code')].map((el) => el.textContent),
      writes: [...document.querySelectorAll('.pf-writes code')].map((el) => el.textContent),
      fetches: window.__qaProfileFetches.slice(),
    }))()`);
    assert.equal(run.checks.apply.done, true, 'apply did not succeed: ' + JSON.stringify(run.checks.apply));
    assert.deepEqual([...run.checks.apply.writes].sort(), ['agent/primary-agents/roster.json', 'omo.jsonc'], 'apply write set');
    await waitFor(`(() => { const el = document.querySelector('[data-pf-agent="atlas"] .pf-agent-k'); return el && el.textContent.includes('rev 1'); })()`, 'reloaded roster revision');
    await captureState('success', VIEWPORTS[2], 'light');
    await captureState('success', VIEWPORTS[0], 'light');
    await captureState('success', VIEWPORTS[0], 'dark');
    await captureState('success', VIEWPORTS[1], 'light');

    const afterOmo = fs.readFileSync(omoPath);
    const actualParsed = JSON.parse(stripBom(afterOmo.toString('utf8')));
    assert.deepEqual(actualParsed, expected.config, 'applied omo.jsonc JSON differs from merge.mjs expectation');
    assert.deepEqual(afterOmo, expected.bytes, 'applied omo.jsonc bytes differ from the formatted merge.mjs expectation');
    run.actual = {
      omoBytes: afterOmo.length, omoSha256: sha256(afterOmo), matchesExpected: true,
      writes: run.checks.apply.writes, backups: run.checks.apply.backups,
    };

    const roster = readJsonc(rosterPath);
    assert.equal(roster.v, 1, 'roster v');
    assert.equal(roster.revision, 1, 'roster revision');
    assert.equal(roster.agents[LANE_AGENT].lane, LANE, 'roster lane');
    assert.equal(roster.agents[LANE_AGENT].rev, 1, 'roster agent rev');
    assert.equal(roster.agents.sisyphus.rev, 0, 'other agent rev unchanged');
    assert.equal(roster.agents.hephaestus.rev, 0, 'other agent rev unchanged');
    assert.equal(roster.agents.prometheus.rev, 0, 'other agent rev unchanged');
    assert.equal(Number.isFinite(Date.parse(roster.updatedAt)), true, 'roster updatedAt is an ISO timestamp');
    run.actual.roster = roster;

    const journal = readJsonc(journalPath);
    assert.equal(journal.status, 'completed', 'apply journal status');
    const omoBackup = journal.steps.find((step) => step.step === 'backup' && step.target === 'omo.jsonc');
    assert.ok(omoBackup && fs.existsSync(omoBackup.path), 'omo.jsonc backup missing');
    assert.deepEqual(fs.readFileSync(omoBackup.path), beforeOmo, 'backup bytes differ from the pre-apply omo.jsonc');
    run.actual.journal = journal;

    // ── stale 409: edit the temp omo.jsonc behind the page, apply again ───────
    await page.eval(`(() => {
      const el = document.querySelector('select[data-pf="agent-lane"][data-agent="prometheus"]');
      if (!el) throw new Error('prometheus lane select missing');
      el.value = 'geeky-heavy';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    await waitFor(`document.querySelectorAll('.pf-pending li').length === 1`, 'stale pending change');
    const targetFiles = [omoPath, path.join(homes.primary, 'agent', 'settings.json'), rosterPath,
      path.join(homes.stable, 'omo.jsonc')].filter((file) => fs.existsSync(file));
    const beforeStale = Object.fromEntries(targetFiles.map((file) => [path.relative(root, file).replace(/\\/g, '/'), hashFile(file)]));
    const backupsBefore = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [];
    const journalBefore = hashFile(journalPath);
    fs.appendFileSync(omoPath, '\r\n');
    const mutatedHash = hashFile(omoPath);
    assert.notEqual(mutatedHash, beforeStale['home/primary/omo.jsonc'], 'behind-the-page edit did not change the hash');

    await page.eval(`(() => { document.querySelector('[data-pf="apply"]').click(); return true; })()`);
    await waitFor(`!!document.querySelector('.pf-conflict')`, '409 conflict banner');
    run.checks.stale = await page.eval(`(() => ({
      conflictText: document.querySelector('.pf-conflict').innerText,
      pendingCount: document.querySelectorAll('.pf-pending li').length,
      fetches: window.__qaProfileFetches.slice(),
    }))()`);
    assert.ok(run.checks.stale.conflictText.includes(CONFLICT_TEXT), '409 banner text missing: ' + run.checks.stale.conflictText);
    assert.equal(run.checks.stale.pendingCount, 1, '409 dropped the pending edits');
    const staleFetch = run.checks.stale.fetches.filter((f) => f.url.includes('/profiles')).at(-1);
    assert.equal(staleFetch.status, 409, 'stale apply was not a 409');
    await captureState('conflict', VIEWPORTS[2], 'light');
    await captureState('conflict', VIEWPORTS[1], 'light');
    await captureState('conflict', VIEWPORTS[0], 'light');
    await captureState('conflict', VIEWPORTS[2], 'dark');

    const afterStale = Object.fromEntries(targetFiles.map((file) => [path.relative(root, file).replace(/\\/g, '/'), hashFile(file)]));
    for (const [name, hash] of Object.entries(afterStale)) {
      if (name === 'home/primary/omo.jsonc') assert.equal(hash, mutatedHash, '409 rewrote omo.jsonc');
      else assert.equal(hash, beforeStale[name], `409 rewrote ${name}`);
    }
    const backupsAfter = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [];
    assert.deepEqual(backupsAfter, backupsBefore, '409 created a backup');
    assert.equal(hashFile(journalPath), journalBefore, '409 rewrote the apply journal');
    const rosterAfterStale = readJsonc(rosterPath);
    assert.equal(rosterAfterStale.revision, 1, '409 bumped the roster revision');
    assert.equal(rosterAfterStale.agents.prometheus.lane, 'daily-heavy', '409 applied the lane');
    run.stale = {
      before: beforeStale,
      mutatedOmo: mutatedHash,
      after: afterStale,
      backupsUnchanged: true,
      journalUnchanged: true,
      rosterUnchanged: true,
      httpStatus: staleFetch.status,
      conflictText: run.checks.stale.conflictText,
    };

    // ── adversarial HTTP: token 403 and cross-origin write refusal ───────────
    const stateBefore403 = hashFile(omoPath);
    const noToken = await request({
      port, path: '/profiles', method: 'POST',
      headers: { 'content-type': 'application/json', origin: url.replace(/\/$/, ''), 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ action: 'apply', changes: [{ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-normal' }], expected: store.state().targets, rosterRevision: store.state().roster.revision }),
    });
    assert.equal(noToken.status, 403, 'tokenless apply was not 403');
    assert.equal(JSON.parse(noToken.body).code, 'FORBIDDEN_TOKEN', 'tokenless apply code');
    const crossOrigin = await request({
      port, path: '/profiles', method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'x-board-token': TOKEN },
      body: JSON.stringify({ action: 'apply', changes: [{ kind: 'setAgentLane', agentId: 'atlas', lane: 'daily-normal' }], expected: store.state().targets, rosterRevision: store.state().roster.revision }),
    });
    assert.equal(crossOrigin.status, 403, 'cross-origin apply was not 403');
    assert.equal(JSON.parse(crossOrigin.body).code, 'FORBIDDEN_SITE', 'cross-origin apply code');
    const badHost = await request({ port, path: '/profiles/state', headers: { host: 'evil.example' } });
    assert.equal(badHost.status, 403, 'bad Host GET was not 403');
    assert.equal(hashFile(omoPath), stateBefore403, 'adversarial HTTP writes changed omo.jsonc');
    run.checks.http = {
      tokenless: { status: noToken.status, code: JSON.parse(noToken.body).code },
      crossOrigin: { status: crossOrigin.status, code: JSON.parse(crossOrigin.body).code },
      badHost: { status: badHost.status },
    };

    run.checks.consoleErrors = consoleErrors;
    assert.deepEqual(consoleErrors, [], 'page console errors: ' + consoleErrors.join(' | '));
    run.ok = failures.length === 0;
  } catch (error) {
    run.errors.push(String(error && error.stack || error));
    console.error('FAIL', error && error.stack || error);
  } finally {
    if (page) {
      const pid = page.pid;
      const profileDir = page.profileDir;
      try { await page.close(); } catch (error) { closeError = String(error && error.message || error); }
      const pids = chromePids.filter((p) => p !== pid);
      const alive = pids.filter((p) => isPidAlive(p));
      let profileExists = true;
      try { profileExists = fs.existsSync(profileDir); } catch { profileExists = true; }
      let profilePids = [];
      try { profilePids = listProfilePids(profileDir); } catch { profilePids = []; }
      run.cleanup.chrome = {
        pid, aliveAfterClose: alive, profileExists, profilePidsAfterClose: profilePids,
        closed: !closeError && alive.length === 0 && !profileExists && profilePids.length === 0,
      };
      if (closeError) run.errors.push('chrome close: ' + closeError);
    }
    try { await server.close(); } catch (error) { run.errors.push('server close: ' + String(error)); }
    const portClosed = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(3000, () => { socket.destroy(); resolve(false); });
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', (error) => resolve(error.code === 'ECONNREFUSED'));
    });
    run.cleanup.server = { port, closed: portClosed };
    if (!portClosed) run.errors.push(`temp board server still listening on ${port}`);

    run.liveAfter = liveState();
    const serverSame = JSON.stringify(run.liveAfter.server) === JSON.stringify(run.liveBefore.server);
    const invariant = run.liveAfter.liveAgentDirsWithPrimaryAgents.length === 0
      && run.liveAfter.gateAdapterMarkerInLiveOmoTask !== true;
    run.cleanup.live = {
      serverJsonUnchanged: serverSame,
      liveStateInvariantHolds: invariant,
      hashes: run.liveAfter.hashes,
    };
    if (!serverSame) run.errors.push('live board server.json pid/port changed');
    if (!invariant) run.errors.push('live-state invariant breached');

    if (run.tempRoot && !KEEP) {
      try {
        fs.rmSync(run.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        run.cleanup.tempRootRemoved = !fs.existsSync(run.tempRoot);
      } catch (error) {
        run.cleanup.tempRootRemoved = false;
        run.errors.push('temp root removal: ' + String(error));
      }
    } else {
      run.cleanup.tempRootRemoved = false;
      run.cleanup.tempRootKept = run.tempRoot;
    }
    if (!run.cleanup.tempRootRemoved && !KEEP) run.errors.push('temp root still exists: ' + run.tempRoot);
    run.finishedAt = new Date().toISOString();
    run.ok = run.ok && failures.length === 0 && run.errors.length === 0
      && run.cleanup.chrome?.closed === true && run.cleanup.server?.closed === true
      && run.cleanup.live?.serverJsonUnchanged === true && run.cleanup.live?.liveStateInvariantHolds === true
      && run.cleanup.tempRootRemoved === true;
    writeEvidence();
  }
}

function writeEvidence() {
  const byHash = new Map();
  for (const entry of run.captures) {
    try {
      const digest = hashFile(path.join(OUT, entry.file));
      if (!byHash.has(digest)) byHash.set(digest, []);
      byHash.get(digest).push(entry.file);
    } catch { /* a missing capture already fails its own check */ }
  }
  run.checks.duplicateCaptures = [...byHash.values()].filter((group) => group.length > 1);
  const e2e = [];
  const stale = [];
  e2e.push('piomo-primary-agents todo 13 - board profiles guarded write e2e');
  e2e.push(`run: ${run.startedAt} .. ${run.finishedAt}`);
  e2e.push(`build: served page sha256 ${run.build?.hash} (${run.build?.pageBytes} B), BWT HEAD ${gitHead()}`);
  e2e.push(`server: ${run.server?.url} (temp port ${run.server?.port}, state dir ${run.server?.stateDir})`);
  e2e.push(`fixture: ${run.fixture?.goldens}; plugin sha256 ${run.fixture?.pluginLoaded} matches inventory ${run.fixture?.inventoryPinned === run.fixture?.pluginLoaded}`);
  e2e.push(`pending: ${JSON.stringify(run.expected?.pending || [])}`);
  e2e.push(`preview: HTTP 200, writes ${JSON.stringify(run.checks.preview?.writes || [])}; no file bytes changed`);
  e2e.push(`apply: HTTP 200, writes ${JSON.stringify(run.actual?.writes || [])}, backups ${JSON.stringify(run.actual?.backups || [])}`);
  e2e.push(`expected omo.jsonc (merge.mjs) sha256 ${run.expected?.omoSha256} (${run.expected?.omoBytes} B)`);
  e2e.push(`actual   omo.jsonc             sha256 ${run.actual?.omoSha256} (${run.actual?.omoBytes} B)`);
  e2e.push(`omo.jsonc equals merge.mjs output: ${run.actual?.matchesExpected === true ? 'PASS' : 'FAIL'}`);
  e2e.push(`roster: ${JSON.stringify(run.actual?.roster || null)}`);
  e2e.push(`journal: status ${run.actual?.journal?.status}; backup step ${JSON.stringify((run.actual?.journal?.steps || []).find((s) => s.step === 'backup' && s.target === 'omo.jsonc') || null)}`);
  e2e.push(`route alias: ${run.expected?.routeAlias}; change ${JSON.stringify(run.expected?.change)}`);
  e2e.push(`adversarial XSS: ${JSON.stringify(run.checks.xss || null)}`);
  e2e.push(`adversarial HTTP: ${JSON.stringify(run.checks.http || null)}`);
  e2e.push(`contrast: light ${run.checks.contrast?.pass ? 'PASS' : 'FAIL'}; dark ${run.checks.contrastDark?.pass ? 'PASS' : 'FAIL'}; light rows ${JSON.stringify(run.checks.contrast?.rows || [])}`);
  e2e.push(`selects: ${run.checks.selects?.count ?? '?'} measured; titles missing ${JSON.stringify(run.checks.selects?.missingTitle || [])}; title mismatches ${JSON.stringify(run.checks.selects?.titleMismatch || [])}; without ellipsis ${JSON.stringify(run.checks.selects?.noEllipsis || [])}; wider than control ${JSON.stringify(run.checks.selects?.widerThanControl || [])}`);
  e2e.push(`copy 390: ${JSON.stringify(run.checks.copy390 || null)}`);
  e2e.push(`loading frame: ${JSON.stringify(run.checks.loading || null)}`);
  e2e.push(`error frame: ${JSON.stringify(run.checks.error || null)}`);
  e2e.push(`agent alignment 1440: ${JSON.stringify(run.checks.agentAlign1440 || null)}`);
  e2e.push(`agent alignment 1024: ${JSON.stringify(run.checks.agentAlign1024 || null)}`);
  e2e.push(`pending targets 390: ${JSON.stringify(run.checks.preview390Targets || null)}`);
  e2e.push(`layout 1440: ${JSON.stringify(run.checks.layout1440 || null)}`);
  e2e.push(`layout 390: ${JSON.stringify(run.checks.layout390 || null)}`);
  e2e.push(`clipped text at 1440: ${JSON.stringify(run.checks.clippedText || [])}`);
  e2e.push(`unset routes: ${JSON.stringify(run.checks.unsetRoutes || [])}`);
  e2e.push(`preview layout 1440: ${JSON.stringify(run.checks.previewLayout1440 || null)}`);
  e2e.push(`preview layout 390: ${JSON.stringify(run.checks.previewLayout390 || null)}`);
  e2e.push(`shell 390 before scroll: ${JSON.stringify(run.checks.shell390BeforeScroll || null)}`);
  e2e.push(`shell 390 after close: ${JSON.stringify(run.checks.shell390AfterClose || null)}`);
  e2e.push(`shell 390 after scroll: ${JSON.stringify(run.checks.shell390AfterScroll || null)}`);
  e2e.push(`section layout: ${JSON.stringify(run.checks.sectionLayout || null)}`);
  e2e.push(`duplicate captures (same bottom viewport): ${JSON.stringify(run.checks.duplicateCaptures || [])}`);
  e2e.push(`console errors: ${JSON.stringify(run.checks.consoleErrors || [])}`);
  e2e.push(`captures: ${run.captures.length} (${run.captures.map((c) => c.file).join(', ')})`);
  e2e.push(`cleanup: ${JSON.stringify(run.cleanup)}`);
  e2e.push(`live before: ${JSON.stringify(run.liveBefore)}`);
  e2e.push(`live after:  ${JSON.stringify(run.liveAfter)}`);
  e2e.push(`result: ${run.ok ? 'PASS' : 'FAIL'}`);
  if (run.errors.length) e2e.push(...run.errors.map((e) => `ERROR ${e}`));
  fs.writeFileSync(path.join(EVIDENCE, 'task-13-piomo-primary-agents-e2e.txt'), e2e.join('\n') + '\n');

  stale.push('piomo-primary-agents todo 13 - stale apply 409');
  stale.push(`before edit: ${JSON.stringify(run.stale?.before || null)}`);
  stale.push(`mutation: appended CRLF to temp omo.jsonc -> ${run.stale?.mutatedOmo}`);
  stale.push(`apply answer: HTTP ${run.stale?.httpStatus} (${run.stale?.conflictText || ''})`);
  stale.push(`after 409: ${JSON.stringify(run.stale?.after || null)}`);
  stale.push(`backups unchanged: ${run.stale?.backupsUnchanged}; journal unchanged: ${run.stale?.journalUnchanged}; roster unchanged: ${run.stale?.rosterUnchanged}`);
  stale.push(`result: ${run.stale?.httpStatus === 409 && run.stale?.backupsUnchanged && run.stale?.journalUnchanged && run.stale?.rosterUnchanged ? 'PASS' : 'FAIL'}`);
  fs.writeFileSync(path.join(EVIDENCE, 'task-13-piomo-primary-agents-stale.txt'), stale.join('\n') + '\n');

  const a11y = run.checks.a11y || {};
  const a11yLines = [
    'piomo-primary-agents todo 13 - profiles view accessible names (fixed build)',
    `build: served page sha256 ${run.build?.hash} (${run.build?.pageBytes} B)`,
    `source: src/page/profiles-view.js sha256 ${sha256(fs.readFileSync(path.join(ROOT, 'src/page/profiles-view.js')))}`,
    `controls total ${a11y.controls ?? '?'}`,
    `selects total ${a11y.selects ?? '?'}`,
    `controls without accessible name ${a11y.unnamed?.length ?? '?'}`,
    `selects without a visible label ${a11y.selectsWithoutVisibleLabel?.length ?? '?'}`,
    `per-control label mismatches ${a11y.wrongLabels?.length ?? '?'}`,
    `header 390: ${JSON.stringify(run.checks.header390 || null)}`,
    `labels: ${JSON.stringify(a11y.sample || [])}`,
    `result: ${run.checks.a11y && run.checks.a11y.unnamed?.length === 0
      && run.checks.a11y.selectsWithoutVisibleLabel?.length === 0 && run.checks.a11y.wrongLabels?.length === 0
      && run.checks.header390?.lines === 1 ? 'PASS' : 'FAIL'}`,
  ];
  fs.writeFileSync(path.join(EVIDENCE, 'task-13-piomo-primary-agents-a11y.txt'), a11yLines.join('\n') + '\n');

  fs.writeFileSync(path.join(OUT, 'captures.json'), `${JSON.stringify(run, null, 2)}\n`);
}

function gitHead() {
  const out = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 });
  return out.status === 0 ? out.stdout.trim() : 'unknown';
}

await main();
if (!run.ok) process.exit(1);
console.log(`PASS ${run.captures.length} captures; build ${run.build.hash}; e2e ${path.join(EVIDENCE, 'task-13-piomo-primary-agents-e2e.txt')}`);
