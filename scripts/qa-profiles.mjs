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
//   <evidence>/task-<N>-piomo-primary-agents-e2e.txt        apply proof (--prefix names the task)
//   <evidence>/task-<N>-piomo-primary-agents-stale.txt      409 proof
//
// The e2e changes one routing row and one agent lane through the real page,
// previews, applies, and compares the temp omo.jsonc bytes with the config the
// todo-7 merge.mjs produces from the same input. Then it edits the temp omo.jsonc
// behind the page and applies again: the store must answer 409 and write nothing.
//
// usage: node scripts/qa-profiles.mjs --out <captures-dir> [--evidence <dir>] [--keep]
// Every wait is an event or a bounded deadline; no polling loop, no fixed sleep.
import '../test/helpers/refuse-live-writes.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, isPidAlive, listProfilePids, watchCsp } from './cdp.mjs';
import { createBoardServer } from '../src/server.mjs';
import { pageHtml } from '../src/render.mjs';
import {
  detectStyle, formatJsonText, openProfilesStore, sha256,
} from '../src/profiles/store.mjs';
import {
  clone, getOrCreateCatalogAlias, removeNullModelProfile, setProfileLayerModel,
  stripEngineSectionAlias,
} from '../src/profiles/merge.mjs';
import { composeHomeRegistry, getServedModelIds } from '../src/profiles/registry.mjs';
import { getModelIdWithoutProvider, getProviderFromModelId } from '../src/profiles/model.mjs';
import { runScenario } from '../src/profiles/parity.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN = path.join(ROOT, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files');
const PLUGIN = 'C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.44-r1/package/plugin/extensions/omo.js';
const INVENTORY = path.join(ROOT, 'src/profiles/inventory-5.1.44.json');
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
const LIVE_OMOTASK = 'C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.44-r1/package/plugin/extensions/omo-task.js';
const FIXED_NOW = Date.parse('2026-10-20T12:00:00Z');
const PS_STYLE = { bom: true, eol: '\r\n', indent: '    ', keySep: ':  ', trailingNewline: true };
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, mobile: true },
  { name: '1024', width: 1024, height: 768, mobile: false },
  { name: '1440', width: 1440, height: 900, mobile: false },
];
const SCHEMES = ['light', 'dark'];
const ROUTE = 'agents/explore';
const LANE_AGENT = 'atlas';
const LANE = 'geeky-heavy';
const ROUTE_CHANGE = { provider: 'anthropic-subscription', model: 'anthropic-subscription/claude-opus-5-5', thinking: 'medium' };
const CONFLICT_TEXT = '다른 곳에서 바뀌었어요 — 새로고침 후 다시 적용';
// Negative-control-only render: the candidate fixes dark disabled controls with opacity:1.
// This temp-only override restores the known UA-style dimming so a reviewer can see the defect.
const NEGATIVE_CSS = '\n/* QA NEGATIVE CONTROL (expected failure): restored dark disabled opacity dimming */\n.pf select:disabled, .pf input:disabled, .pf-btn:disabled { opacity: .7 !important; }\n';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};
const OUT = arg('--out') ? path.resolve(arg('--out')) : '';
const EVIDENCE = arg('--evidence') ? path.resolve(arg('--evidence')) : OUT;
const KEEP = argv.includes('--keep');
const NEGATIVE = argv.includes('--negative-control');
const GATE = argv.includes('--gate');
const FLOW_E2E = argv.includes('--flow-e2e');
const PREFIX = arg('--prefix') || 'task-13-piomo-primary-agents';
const TASK = /^task-(\d+)-piomo-primary-agents(?:-r\d+)?$/.exec(PREFIX)?.[1] || '';
const TOKEN = `piomo-t${TASK}-board-token`;
const PORT_BASE = Number(process.env.OMO_BRIEFING_PORT_BASE || 47480);
if (!TASK) {
  console.error(`--prefix ${PREFIX}: expected task-<N>-piomo-primary-agents`);
  process.exit(2);
}
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
function parseColor(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value || '');
  if (!match) return null;
  const parts = match[1].split(',').map((part) => Number(part.trim()));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}
function contrastRatio(foreground, background) {
  const a = parseColor(foreground), b = parseColor(background);
  if (!a || !b) return null;
  const fg = { r: a.r * a.a + b.r * (1 - a.a), g: a.g * a.a + b.g * (1 - a.a), b: a.b * a.a + b.b * (1 - a.a) };
  const lum = (color) => {
    const channel = (value) => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const l1 = lum(fg), l2 = lum(b);
  return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
}
const SOURCE_FILES = [
  'src/page/profiles-view.js', 'src/page/profiles-view.css', 'src/page/page.js',
  'src/page/generated/profiles-view.min.js', 'src/profiles-script.mjs', 'scripts/minify-profiles.mjs',
  'test/profiles-view.test.mjs', 'test/profiles-generated.test.mjs',
  'test/fixtures/profiles-view-state.json', 'test/fixtures/view-model-board.json', 'scripts/qa-profiles.mjs',
];
function sourceTree() {
  const files = SOURCE_FILES.map((file) => ({
    path: file, bytes: fs.statSync(path.join(ROOT, file)).size, sha256: hashFile(path.join(ROOT, file)),
  }));
  const treeSha256 = sha256(Buffer.from(files.map((file) => file.path + '\0' + file.sha256).join('\n')));
  return { treeSha256, files };
}
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
  const regPrimary = path.join(ROOT, 'test/fixtures/profiles/registry/primary/agent/models.json');
  const regStable = path.join(ROOT, 'test/fixtures/profiles/registry/stable/agent/models.json');
  if (fs.existsSync(regPrimary)) fs.copyFileSync(regPrimary, path.join(primary, 'agent', 'models.json'));
  if (fs.existsSync(regStable)) fs.copyFileSync(regStable, path.join(stable, 'agent', 'models.json'));
  // The board only reads the extension-owned memory sidecars; one valid file makes the
  // remembered-model row visible in the real state-to-render path.
  const memoryDir = path.join(stable, 'agent', 'primary-agents', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'sisyphus.json'), JSON.stringify({
    v: 1, agentId: 'sisyphus', model: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    thinking: 'high', rosterRev: 0, updatedAt: '2026-10-20T12:00:00.000Z',
  }));
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
    config, profileKey: 'native-gpt-kimi-deepseek', section: 'agents', role: 'explore',
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
  if (NEGATIVE) return negativeControl();
  if (GATE) return supportGate();
  if (FLOW_E2E) return flowE2e();
  const liveBefore = liveState();
  run.liveBefore = liveBefore;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `piomo-t${TASK}-`));
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
  let profilesStateOverride = null;
  const server = createBoardServer({
    portBase: PORT_BASE, portCount: 5, generation: 7, token: TOKEN,
    getPage: ({ nonce } = {}) => pageHtml(vm, 7, { mode: 'server', token: TOKEN, nonce }),
    getViewModel: () => vm,
    profilesState: () => profilesStateOverride || store.state(),
    onProfiles: (body) => store.handle(body),
  });
  const { port } = await server.start();
  const url = `http://127.0.0.1:${port}/`;
  run.server = { url, port, stateDir: homes.stateDir };
  const pageText = (await request({ port, path: '/' })).body;
  const buildHash = sha256(Buffer.from(pageText.replace(/ nonce="[^"]*"/g, '').split(TOKEN).join('<board-token>')));
  run.build = { hash: buildHash, pageBytes: Buffer.byteLength(pageText), url };
  run.source = sourceTree();
  run.fixture = {
    goldens: path.relative(ROOT, GOLDEN).replace(/\\/g, '/'),
    omoBefore: hashFile(omoPath),
    rosterPresent: fs.existsSync(rosterPath),
    inventoryPinned: inventory.sources.omo.sha256,
    pluginLoaded: sha256(fs.readFileSync(PLUGIN)),
  };

  let page;
  let csp = null;
  let chromePids = [];
  let closeError = null;
  try {
    page = await launch({ width: 1440, height: 900 });
    csp = await watchCsp(page);
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
      await waitFor(`document.querySelector('[data-pf-root]')?.getAttribute('data-pf-state') === 'view' && document.querySelectorAll('.pf-agent').length === 4`, 'profiles ready');
    };
    const applyViewport = async (vp) => {
      await page.client.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile,
      });
      await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: vp.mobile, maxTouchPoints: vp.mobile ? 5 : 1 });
    };
    const applyScheme = (scheme, reduced = false) => page.client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }]
        .concat(reduced ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : []),
    });
    const scrollTop = () => page.eval(`(() => { window.scrollTo(0, 0); const m = document.querySelector('#main'); if (m) m.scrollTop = 0; return true; })()`);
    const scrollUnderHeader = (selector, block = 'start') => page.eval(`(() => {
      const main = document.querySelector('#main');
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: ${JSON.stringify(block)} });
      const head = document.querySelector('.pf-head');
      if (${JSON.stringify(block)} === 'start' && head && getComputedStyle(head).position === 'sticky') {
        main.scrollTop -= Math.ceil(head.getBoundingClientRect().height) + 8;
      }
      return true;
    })()`);
    const closePeek = async () => {
      if (await page.eval(`!!document.querySelector('.sh-shell') && document.querySelector('.sh-shell').getAttribute('data-peek') === 'true'`)) {
        await page.eval(`document.querySelector('.sh-ib').click()`);
        await settle();
      }
    };
    // A sibling view click at 390 opens the overlay; close it, and if the toggle did not land,
    // record the unpeek fallback rather than capturing the sidebar over the route.
    const closePeekStrong = async () => {
      for (let i = 0; i < 3; i += 1) {
        if (!(await page.eval(`!!document.querySelector('.sh-shell') && document.querySelector('.sh-shell').getAttribute('data-peek') === 'true'`))) return true;
        await page.eval(`document.querySelector('.sh-ib') && document.querySelector('.sh-ib').click()`);
        await settle();
      }
      if (await page.eval(`!!document.querySelector('.sh-shell') && document.querySelector('.sh-shell').getAttribute('data-peek') === 'true'`)) {
        run.checks.peekFallback = (run.checks.peekFallback || 0) + 1;
        await page.eval(`(() => { const p = window.BriefPage; if (!p) return false;
          p.state.ui = window.BriefShell.reduce(p.state.ui, { type: 'unpeek' });
          window.BriefShell.persist(undefined, p.state.ui); p.render(); return true; })()`);
        await settle();
      }
      return !(await page.eval(`!!document.querySelector('.sh-shell') && document.querySelector('.sh-shell').getAttribute('data-peek') === 'true'`));
    };
    const settle = async () => {
      await page.eval(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
      await page.eval(sleepFrame());
      // Theme switches transition colour for 150 ms. A frame pair alone would sample the middle of
      // that transition, so wait for the finite animations/transitions before measuring or capturing.
      await page.eval(`new Promise((resolve, reject) => {
        const pending = document.getAnimations().filter((a) => {
          const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
          return a.playState === 'running' && !(timing && timing.iterations === Infinity);
        });
        if (!pending.length) return resolve(true);
        let left = pending.length, settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('animation settlement timed out with ' + left + ' still running'));
        }, 2000);
        const done = () => {
          if (settled) return;
          if (--left <= 0) { settled = true; clearTimeout(timer); resolve(true); }
        };
        for (const animation of pending) animation.finished.then(done, done);
      })`);
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
      run.captures.push({ file: path.relative(OUT, file).replace(/\\/g, '/'), ...info, sha256: hashFile(file), full });
      return info;
    };

    // Round-3 measurable fit: every 390 state must sit inside the .pf content box, not merely inside
    // the document. The pane box is the main client box minus the profiles page padding.
    const paneBounds = () => page.eval(`(() => {
      const main = document.querySelector('#main');
      const pf = document.querySelector('.pf');
      if (!main || !pf) return null;
      const cs = getComputedStyle(pf);
      const padL = Number.parseFloat(cs.paddingLeft) || 0;
      const padR = Number.parseFloat(cs.paddingRight) || 0;
      const pr = pf.getBoundingClientRect();
      const content = { left: +(pr.left + padL).toFixed(2), right: +(pr.right - padR).toFixed(2),
        width: +(pr.width - padL - padR).toFixed(2) };
      const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect();
        return { left: +r.left.toFixed(2), right: +r.right.toFixed(2), width: +r.width.toFixed(2),
          top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2) }; };
      const overflow = [...document.querySelectorAll('.pf *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > content.right + 0.75 || r.left < content.left - 0.75);
      }).map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80),
        left: +el.getBoundingClientRect().left.toFixed(2), right: +el.getBoundingClientRect().right.toFixed(2) })).slice(0, 12);
      return { innerWidth, docScrollWidth: document.documentElement.scrollWidth,
        main: { left: +main.getBoundingClientRect().left.toFixed(2), right: +main.getBoundingClientRect().right.toFixed(2),
          clientWidth: main.clientWidth },
        pane: { left: +pr.left.toFixed(2), right: +pr.right.toFixed(2), width: +pr.width.toFixed(2),
          scrollWidth: pf.scrollWidth, clientWidth: pf.clientWidth },
        content, header: box('.pf-head'), chip: box('.pf-head-r .pf-chip'), error: box('.pf-error'),
        errorCopy: box('.pf-error .pf-err'), retry: box('.pf-error [data-pf="reload"]'), overflow };
    })()`);
    const assertPaneBounds = (bounds, label) => {
      assert.ok(bounds, `${label}: no .pf content box`);
      const eps = 0.75;
      assert.ok(bounds.header && bounds.header.left >= bounds.content.left - eps
        && bounds.header.right <= bounds.content.right + eps,
      `${label}: header ${JSON.stringify(bounds.header)} escapes content ${JSON.stringify(bounds.content)}`);
      assert.ok(bounds.chip && bounds.chip.left >= bounds.content.left - eps
        && bounds.chip.right <= bounds.content.right + eps,
      `${label}: status chip ${JSON.stringify(bounds.chip)} escapes content ${JSON.stringify(bounds.content)}`);
      if (bounds.error) {
        assert.ok(bounds.error.left >= bounds.content.left - eps && bounds.error.right <= bounds.content.right + eps,
          `${label}: error panel ${JSON.stringify(bounds.error)} escapes content ${JSON.stringify(bounds.content)}`);
      }
      assert.ok(bounds.pane.scrollWidth <= bounds.pane.clientWidth + 1, `${label}: .pf scrolls horizontally`);
      assert.ok(bounds.docScrollWidth <= bounds.innerWidth, `${label}: document scrolls horizontally`);
      assert.deepEqual(bounds.overflow, [], `${label}: profiles elements outside the pane content box`);
    };

    const proseSizes = () => page.eval(`(() => {
      const size = (sel) => { const el = document.querySelector(sel); return el ? Number.parseFloat(getComputedStyle(el).fontSize) : null; };
      return { sub: size('.pf-sub'), section: size('.pf-sec-s'), card: size('.pf-card-sum'),
        remembered: size('.pf-ro-val'), trayNext: size('.pf-tray-next') };
    })()`);

    const hoverCapture = async (file, selector, vp, scheme) => {
      await applyViewport(vp);
      await applyScheme(scheme);
      await settle();
      const found = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`);
      assert.ok(found, `hover target missing: ${selector}`);
      await settle();
      const at = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
        const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, inside: !!hit && (hit === el || el.contains(hit)), width: r.width, height: r.height }; })()`);
      assert.equal(at.inside, true, `pointer is not over ${selector}: ${JSON.stringify(at)}`);
      const read = () => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
        const cs = getComputedStyle(el); return { background: cs.backgroundColor, border: cs.borderTopColor, color: cs.color }; })()`);
      const before = await read();
      await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none' });
      await settle();
      const after = await read();
      assert.notDeepEqual(after, before, `hover did not change the computed paint of ${selector}`);
      await capture(file);
      run.checks.hover = run.checks.hover || {};
      run.checks.hover[path.basename(file, '.png')] = { selector, vp: vp.name, scheme, before, after, inside: at.inside };
      await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'none' });
      await settle();
    };

    const pressEnter = async () => {
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    };
    const focusInfo = () => page.eval(`(() => {
      const a = document.activeElement; const cs = a ? getComputedStyle(a) : null;
      return { id: a ? a.id : '', tag: a ? a.tagName : '', text: ((a && a.textContent) || '').trim().slice(0, 100),
        inside: !!(a && a.closest && a.closest('.pf')), applyDisabled: !!document.querySelector('[data-pf="apply"]')?.disabled,
        previewDisabled: !!document.querySelector('[data-pf="preview"]')?.disabled,
        busy: window.BriefPage.state.ui.profilesState?.busy === true,
        preview: !!window.BriefPage.state.ui.profilesState?.preview,
        result: !!window.BriefPage.state.ui.profilesState?.result,
        outlineWidth: cs ? cs.outlineWidth : '' };
    })()`);

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
      const stickyOffset = await page.eval(`(() => {
        const head = document.querySelector('.pf-head');
        return head && getComputedStyle(head).position === 'sticky' ? Math.ceil(head.getBoundingClientRect().height) + 8 : 0;
      })()`);
      run.checks.sectionCoverage = run.checks.sectionCoverage || {};
      const coverage = {};
      for (const sec of layout) {
        if (!sec.key) continue;
        const sectionEnd = sec.top + sec.height;
        const visible = Math.max(1, sec.view - stickyOffset);
        const overlap = Math.min(Math.max(1, visible - 1), Math.max(80, Math.round(visible * 0.2)));
        const planned = [];
        let from = sec.top;
        while (from < sectionEnd) {
          const to = Math.min(sectionEnd, from + visible);
          planned.push({ from, to, scroll: Math.max(0, Math.min(Math.round(from - stickyOffset), sec.max)) });
          if (to >= sectionEnd) break;
          from = to - overlap;
        }
        const unique = [];
        const seen = new Set();
        for (const item of planned) {
          if (seen.has(item.scroll)) continue;
          seen.add(item.scroll);
          unique.push(item);
        }
        const slices = [];
        for (let i = 0; i < unique.length; i += 1) {
          await page.eval(`document.querySelector('#main').scrollTop = ${unique[i].scroll}`);
          await settle();
          const actual = await page.eval(`(() => {
            const main = document.querySelector('#main');
            const m = main.getBoundingClientRect();
            return { scrollTop: Math.round(main.scrollTop),
              from: Math.max(${sec.top}, Math.round(main.scrollTop + ${stickyOffset})),
              to: Math.min(${sectionEnd}, Math.round(main.scrollTop + m.height)) };
          })()`);
          const suffix = unique.length > 1 ? `-${i + 1}` : '';
          const file = `section-${sec.key}-${vp.name}-${scheme}${suffix}.png`;
          await capture(path.join(OUT, file));
          slices.push({ file, scrollTop: actual.scrollTop, from: actual.from, to: actual.to });
        }
        const gaps = [];
        let coveredTo = sec.top;
        for (const slice of slices) {
          if (slice.from > coveredTo + 1) gaps.push({ from: coveredTo, to: slice.from });
          coveredTo = Math.max(coveredTo, slice.to);
        }
        if (coveredTo < sectionEnd - 1) gaps.push({ from: coveredTo, to: sectionEnd });
        const continuous = gaps.length === 0;
        coverage[sec.key] = {
          sectionTop: sec.top, sectionHeight: sec.height, sectionEnd, viewport: sec.view,
          stickyOffset, visible, overlap, oversized: sec.height > visible,
          sliceCount: slices.length, slices, gaps, continuous,
        };
        assert.ok(slices.length > 0, `section ${sec.key} has no slice at ${vp.name}-${scheme}`);
        assert.equal(continuous, true, `section ${sec.key} coverage has gaps at ${vp.name}-${scheme}: ${JSON.stringify(gaps)}`);
        assert.ok(slices[0].from <= sec.top + 1, `section ${sec.key} first slice does not start at the section at ${vp.name}-${scheme}`);
        assert.ok(slices[slices.length - 1].to >= sectionEnd - 1, `section ${sec.key} last slice does not reach the end at ${vp.name}-${scheme}`);
        if (sec.height > visible) {
          assert.ok(slices.length >= 2, `oversized section ${sec.key} has one slice at ${vp.name}-${scheme}`);
          for (let i = 1; i < slices.length; i += 1) {
            assert.ok(slices[i].from <= slices[i - 1].to, `section ${sec.key} slices do not overlap at ${vp.name}-${scheme}`);
          }
        }
      }
      run.checks.sectionLayout = run.checks.sectionLayout || {};
      run.checks.sectionLayout[`${vp.name}-${scheme}`] = layout;
      run.checks.sectionCoverage[`${vp.name}-${scheme}`] = coverage;
      await page.eval(`document.querySelector('#main').scrollTop = 0`);
    };

    const captureState = async (name, vp, theme) => {
      await applyViewport(vp);
      await applyScheme(theme);
      await closePeek();
      await scrollUnderHeader('.pf-tray');
      await settle();
      if (name === 'loading' || name === 'error') {
        const bounds = await paneBounds();
        run.checks[`${name}Bounds`] = run.checks[`${name}Bounds`] || {};
        run.checks[`${name}Bounds`][`${vp.name}-${theme}`] = bounds;
        assertPaneBounds(bounds, `${name} ${vp.name}-${theme}`);
      }
      await capture(path.join(OUT, `state-${name}-${vp.name}-${theme}.png`));
      if (name === 'preview' || name === 'success') await captureEnd(name, vp, theme);
    };

    const captureStates = async (name) => {
      for (const vp of VIEWPORTS) for (const scheme of SCHEMES) await captureState(name, vp, scheme);
    };
    const captureJournal = async (vp, theme) => {
      await applyViewport(vp);
      await applyScheme(theme);
      await closePeek();
      await scrollUnderHeader('[data-pf-journal="interrupted"]');
      await settle();
      await capture(path.join(OUT, `state-journal-${vp.name}-${theme}.png`));
    };
    // Real-pixel fit of the short enum selects: the native control ellipsizes when the chosen
    // label is wider than the content box (client width minus padding and the 20 px arrow).
    const selectFit = () => page.eval(`(() => {
      const canvas = document.createElement('canvas').getContext('2d');
      const targets = ['agent-lane', 'agent-pin', 'agent-pin-thinking', 'memory-mode', 'memory-thinking'];
      const rows = [...document.querySelectorAll('.pf select')]
        .filter((el) => targets.includes(el.getAttribute('data-pf')))
        .map((el) => {
          const cs = getComputedStyle(el);
          canvas.font = cs.fontSize + ' ' + cs.fontFamily;
          const chosen = el.options[el.selectedIndex];
          const text = chosen ? chosen.text : '';
          const pad = Number.parseFloat(cs.paddingLeft) + Number.parseFloat(cs.paddingRight);
          return { pf: el.getAttribute('data-pf'), id: el.id, text,
            width: Math.round(el.getBoundingClientRect().width), clientWidth: el.clientWidth,
            textWidth: Math.round(canvas.measureText(text).width),
            available: Math.max(0, Math.round(el.clientWidth - pad - 20)) };
        });
      return { rows, truncated: rows.filter((row) => row.textWidth > row.available) };
    })()`);

    // The real scroll owner is .sh-main (#main). A bottom frame is only evidence when that owner
    // is at its maximum scroll and the last section is inside the viewport.
    const mainInfo = () => page.eval(`(() => {
      const main = document.querySelector('#main');
      return { owner: !!main && main.classList.contains('sh-main'), scrollTop: Math.round(main.scrollTop),
        max: Math.round(main.scrollHeight - main.clientHeight),
        atBottom: main.scrollTop >= main.scrollHeight - main.clientHeight - 1 };
    })()`);
    const scrollToBottom = async () => {
      await page.eval(`(() => { const main = document.querySelector('#main'); main.scrollTop = main.scrollHeight; return true; })()`);
      await settle();
    };
    const captureEnd = async (name, vp, theme) => {
      await scrollToBottom();
      const state = await mainInfo();
      assert.equal(state.owner, true, 'bottom frame scroll owner is not .sh-main');
      assert.equal(state.atBottom, true, `${name} ${vp.name} ${theme} did not reach .sh-main bottom: ${JSON.stringify(state)}`);
      const guideVisible = await page.eval(`(() => {
        const guide = document.querySelector('#pf-sec-guide');
        if (!guide) return false;
        const r = guide.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight;
      })()`);
      assert.equal(guideVisible, true, `${name} ${vp.name} ${theme} bottom frame does not show the last section`);
      run.checks.endScroll = run.checks.endScroll || {};
      run.checks.endScroll[`${name}-${vp.name}-${theme}`] = state;
      await capture(path.join(OUT, `state-${name}-${vp.name}-${theme}-end.png`));
    };

    const loadedProbe = () => page.eval(`(() => {
      const parse = (value) => {
        const m = /rgba?\\(([^)]+)\\)/.exec(value || '');
        if (!m) return null;
        const p = m[1].split(',').map((x) => Number(x.trim()));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const composite = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
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
      const contrast = (el) => { const fg = parse(getComputedStyle(el).color); const bg = background(el); return ratio(composite(fg, bg), bg); };
      const main = document.querySelector('#main');
      const base = main.getBoundingClientRect().top - main.scrollTop;
      const rel = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top - base), height: Math.round(r.height), width: Math.round(r.width) }; };
      const sections = {};
      for (const el of document.querySelectorAll('[data-pf-sec]')) sections[el.getAttribute('data-pf-sec')] = rel(el);
      const agents = [...document.querySelectorAll('.pf-agent')].map(rel);
      const title = document.querySelector('.pf-title');
      const tr = title.getBoundingClientRect();
      const hit = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
      const tray = document.querySelector('.pf-tray');
      const firstAgent = document.querySelector('.pf-agent');
      const dots = [...document.querySelectorAll('.pf-dot')].map((el) => ({
        id: (el.className.match(/pf-dot-(\\w+)/) || [])[1], shape: (el.className.match(/pf-shape-(\\w+)/) || [])[1],
        label: el.getAttribute('aria-label'), role: el.getAttribute('role'),
        background: getComputedStyle(el).backgroundColor, clip: getComputedStyle(el).clipPath, radius: getComputedStyle(el).borderRadius,
      }));
      const on = document.querySelector('.pf-card.on');
      const chip = on && on.querySelector('.pf-current');
      const cards = [...document.querySelectorAll('.pf-card')].map((el) => ({ on: el.classList.contains('on'), bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderColor }));
      const hint = document.querySelector('[data-pf-agent="hephaestus"] .pf-hint');
      const hintLabel = hint && hint.closest('label');
      const pinSel = document.querySelector('[data-pf-agent="hephaestus"] [data-pf="agent-pin"]');
      const thinkSel = document.querySelector('[data-pf-agent="hephaestus"] [data-pf="agent-pin-thinking"]');
      const guide = document.querySelector('#pf-sec-guide');
      const guideHead = guide && guide.querySelector('.pf-guide-h');
      const guideSub = guide && guide.querySelector('.pf-sec-s');
      const guideVersion = guideHead && guideHead.querySelector('.pf-chip');
      const rail = document.querySelector('#rail');
      const railBg = rail ? background(rail) : null;
      const railRows = [...document.querySelectorAll('.sh-rb')].map((el) => {
        const fg = parse(getComputedStyle(el).color);
        const bg = background(el);
        return { key: el.getAttribute('data-key'), on: el.classList.contains('on'), ratio: ratio(composite(fg, bg), bg),
          color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor };
      });
      const keeps = [...document.querySelectorAll('.pf-card-sum .pf-keep')].map((el) => {
        const range = document.createRange(); range.selectNodeContents(el);
        const box = el.getBoundingClientRect();
        const parent = el.closest('.pf-card-sum').getBoundingClientRect();
        return { text: el.textContent, lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size,
          overflow: box.right > parent.right + 1 || box.left < parent.left - 1 };
      });
      const summaries = [...document.querySelectorAll('.pf-card-sum')].map((el) => ({ text: el.textContent, overflow: el.scrollWidth > el.clientWidth + 1 }));
      const controls = [...document.querySelectorAll('.pf-btn, .pf select, .pf input')].filter((el) => el.offsetParent !== null)
        .map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) }; });
      const overflow = [...document.querySelectorAll('.pf *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
      }).map((el) => String(el.className).slice(0, 80)).slice(0, 20);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        title: { text: title.textContent, visible: tr.width > 0 && tr.height > 0, top: Math.round(tr.top),
          sticky: getComputedStyle(title.closest('.pf-head')).position, covered: !!(hit && hit !== title && !title.contains(hit)) },
        tray: { compact: tray.classList.contains('pf-tray-compact'), height: Math.round(tray.getBoundingClientRect().height),
          actions: tray.querySelectorAll('.pf-tray-acts button').length,
          firstAgentTop: firstAgent ? Math.round(firstAgent.getBoundingClientRect().top - base) : null },
        sections, agents, dots,
        hint: { text: hint && hint.textContent, labelFor: hintLabel && hintLabel.getAttribute('for'),
          pinId: pinSel && pinSel.id, thinkingId: thinkSel && thinkSel.id,
          hintTop: hint ? Math.round(hint.getBoundingClientRect().top) : null,
          pinBottom: pinSel ? Math.round(pinSel.getBoundingClientRect().bottom) : null,
          thinkTop: thinkSel ? Math.round(thinkSel.getBoundingClientRect().top) : null },
        guide: { head: guideHead && guideHead.textContent, headVersion: guideVersion && guideVersion.textContent,
          sub: guideSub && guideSub.textContent, hasStale: !!(guide && guide.textContent.includes('5.1.33')) },
        rail: { rows: railRows, background: railBg,
          debug: { mediaDark: matchMedia('(prefers-color-scheme: dark)').matches,
            rootScheme: getComputedStyle(document.documentElement).colorScheme,
            rbScheme: getComputedStyle(document.querySelector('.sh-rb')).colorScheme,
            rbToken: getComputedStyle(document.querySelector('.sh-rb')).getPropertyValue('--c-fg-2'),
            railBg: getComputedStyle(rail).backgroundColor, rbOpacity: getComputedStyle(document.querySelector('.sh-rb')).opacity } },
        keeps, summaries,
        selected: { on: !!on, chip: !!chip, chipText: chip && chip.textContent, chipIcon: !!(chip && chip.querySelector('svg')),
          selected: cards.filter((c) => c.on)[0] || null, unselected: cards.filter((c) => !c.on)[0] || null },
        controls: { count: controls.length, minHeight: controls.length ? Math.min(...controls.map((c) => c.h)) : 0,
          minWidth: controls.length ? Math.min(...controls.map((c) => c.w)) : 0 },
        overflow, main: { scrollTop: Math.round(main.scrollTop), max: Math.round(main.scrollHeight - main.clientHeight), owner: main.classList.contains('sh-main') },
      };
    })()`);

    const pressCapture = async (kind, selector, vp, theme) => {
      await applyViewport(vp);
      await applyScheme(theme);
      await closePeek();
      if (kind === 'nav' && vp.width < 900) {
        const peek = await page.eval(`document.querySelector('.sh-shell').getAttribute('data-peek') === 'true'`);
        if (!peek) {
          await page.eval(`document.querySelector('.sh-ib').click()`);
          await waitFor(`document.querySelector('.sh-shell').getAttribute('data-peek') === 'true'`, 'sidebar peek for press capture');
        }
      }
      await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('press target missing'); el.scrollIntoView({ block: 'center' }); return true; })()`);
      await settle();
      const box = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) }; })()`);
      const before = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const cs = getComputedStyle(el); return { background: cs.backgroundColor, color: cs.color, pending: document.querySelectorAll('.pf-pending li').length }; })()`);
      const restFile = path.join(OUT, `press-${kind}-${vp.name}-${theme}-rest.png`);
      const downFile = path.join(OUT, `press-${kind}-${vp.name}-${theme}-down.png`);
      await capture(restFile);
      await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
      await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
      await settle();
      const down = await page.eval(`(() => {
        const parse = (value) => { const m = /rgba?\\(([^)]+)\\)/.exec(value || ''); if (!m) return null; const p = m[1].split(',').map((x) => Number(x.trim())); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
        const composite = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
        const background = (el) => { const layers = []; for (let node = el; node; node = node.parentElement) { const c = parse(getComputedStyle(node).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; } } let bg = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i -= 1) bg = composite(layers[i], bg); return bg; };
        const lum = (c) => { const f = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
        const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100; };
        const el = document.querySelector(${JSON.stringify(selector)});
        const cs = getComputedStyle(el); const bg = background(el); const fg = parse(cs.color);
        return { activeIsTarget: el.matches(':active'), background: cs.backgroundColor, color: cs.color, ratio: ratio(composite(fg, bg), bg), pending: document.querySelectorAll('.pf-pending li').length };
      })()`);
      await capture(downFile);
      await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'none' });
      await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', buttons: 0, clickCount: 1 });
      await settle();
      if (kind === 'nav' && vp.width < 900) await closePeek();
      assert.equal(down.activeIsTarget, true, `${kind} ${vp.name} ${theme} was not in a real :active state`);
      assert.notEqual(down.background, before.background, `${kind} ${vp.name} ${theme} press did not paint a different fill`);
      assert.ok(down.ratio >= 4.5, `${kind} ${vp.name} ${theme} pressed text contrast ${down.ratio}:1`);
      assert.equal(down.pending, before.pending, `${kind} press changed the pending edits`);
      assert.notEqual(hashFile(restFile), hashFile(downFile), `${kind} press frame is byte-identical to rest`);
      run.checks.presses = run.checks.presses || {};
      run.checks.presses[`${kind}-${vp.name}-${theme}`] = { box, rest: before, down,
        restSha256: hashFile(restFile), downSha256: hashFile(downFile) };
    };

    const focusCapture = async (vp, theme) => {
      await applyViewport(vp);
      await applyScheme(theme);
      await closePeek();
      await scrollTop();
      await settle();
      await page.eval(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      let focus = null;
      for (let index = 0; index < 80 && !focus; index += 1) {
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        focus = await page.eval(`(() => {
          const el = document.activeElement;
          if (!el || !el.matches || !el.matches('.pf select, .pf input, .pf button')) return null;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const parse = (value) => { const m = /rgba?\\(([^)]+)\\)/.exec(value || ''); if (!m) return null; const p = m[1].split(',').map((x) => Number(x.trim())); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
          const lum = (c) => { const f = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
          const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100; };
          const layers = [];
          for (let node = el; node; node = node.parentElement) { const c = parse(getComputedStyle(node).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; } }
          let bg = { r: 255, g: 255, b: 255, a: 1 };
          const composite = (fg, base) => ({ r: fg.r * fg.a + base.r * (1 - fg.a), g: fg.g * fg.a + base.g * (1 - fg.a), b: fg.b * fg.a + base.b * (1 - fg.a), a: 1 });
          for (let i = layers.length - 1; i >= 0; i -= 1) bg = composite(layers[i], bg);
          return { tag: el.tagName, pf: el.getAttribute('data-pf'), id: el.id, outlineStyle: cs.outlineStyle,
            outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, outlineRatio: ratio(parse(cs.outlineColor), bg),
            visible: r.width > 0 && r.height > 0, top: Math.round(r.top), bottom: Math.round(r.bottom) };
        })()`);
      }
      assert.ok(focus, `no profiles control received keyboard focus at ${vp.name}-${theme}`);
      assert.equal(focus.visible, true, `focused control is not visible at ${vp.name}-${theme}`);
      assert.equal(focus.outlineStyle, 'solid', `no focus outline at ${vp.name}-${theme}`);
      assert.ok(Number.parseFloat(focus.outlineWidth) >= 2, `focus ring is thinner than 2px at ${vp.name}-${theme}`);
      assert.ok(focus.outlineRatio >= 3, `focus ring contrast ${focus.outlineRatio}:1 at ${vp.name}-${theme}`);
      assert.ok(focus.top >= 0 && focus.bottom <= vp.height, `focused control is outside the viewport at ${vp.name}-${theme}`);
      await capture(path.join(OUT, `focus-${vp.name}-${theme}.png`));
      run.checks.focus = run.checks.focus || {};
      run.checks.focus[`${vp.name}-${theme}`] = focus;
      await page.eval(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    };

    const measureLoaded = async (vp, theme) => {
      await applyViewport(vp);
      await applyScheme(theme);
      await closePeek();
      await scrollTop();
      await settle();
      const probe = await loadedProbe();
      run.checks.byViewport = run.checks.byViewport || {};
      run.checks.byViewport[`${vp.name}-${theme}`] = probe;
      assert.equal(probe.title.text, '프로필·에이전트', 'visible page title');
      assert.equal(probe.title.visible, true, `page title hidden at ${vp.name}-${theme}`);
      assert.equal(probe.title.covered, false, `page title covered at ${vp.name}-${theme}`);
      if (vp.width <= 599) assert.equal(probe.title.sticky, 'sticky', 'compact title is not a sticky plain bar');
      assert.equal(probe.tray.compact, true, `empty tray is not compact at ${vp.name}-${theme}`);
      assert.equal(probe.tray.actions, 0, `empty tray still shows actions at ${vp.name}-${theme}`);
      assert.ok(probe.tray.height <= 64, `empty tray is ${probe.tray.height}px at ${vp.name}-${theme}`);
      assert.ok(probe.tray.firstAgentTop < 500, `first agent starts at ${probe.tray.firstAgentTop}px at ${vp.name}-${theme}`);
      assert.equal(probe.dots.length, 4, 'four identity marks');
      assert.deepEqual(probe.dots.map((d) => d.shape).sort(), ['circle', 'diamond', 'square', 'triangle'], 'identity shapes');
      assert.equal(new Set(probe.dots.map((d) => d.background)).size, 4, 'identity colours are still distinct');
      for (const dot of probe.dots) {
        assert.equal(dot.role, 'img');
        assert.match(dot.label, /· (원형|사각형|삼각형|마름모) 표식/);
      }
      assert.equal(probe.hint.labelFor, probe.hint.pinId, 'GPT hint is not inside the pin label');
      assert.equal(probe.hint.text, 'GPT 계열만');
      assert.ok(probe.hint.hintTop >= probe.hint.pinBottom - 1, 'GPT hint does not sit under the pin select');
      if (vp.width < 1440) assert.ok(probe.hint.hintTop < probe.hint.thinkTop, 'GPT hint is attached to thinking, not pin');
      assert.ok(probe.guide.headVersion, 'guide version chip missing');
      assert.equal(probe.guide.headVersion, (probe.guide.sub || '').split(' ')[0], 'guide heading/chip/subtitle versions differ');
      assert.equal(probe.guide.hasStale, false, 'guide still prints the stale 5.1.33 label');
      assert.ok(probe.rail.rows.length > 0, 'no rail controls measured');
      for (const row of probe.rail.rows) assert.ok(row.ratio >= 3, `rail ${row.key} contrast ${row.ratio}:1 at ${vp.name}-${theme}`);
      assert.deepEqual(probe.keeps.filter((k) => k.lines !== 1), [], `kept phrase split at ${vp.name}-${theme}`);
      assert.deepEqual(probe.keeps.filter((k) => k.overflow), [], `kept phrase overflows at ${vp.name}-${theme}`);
      assert.deepEqual(probe.summaries.filter((s) => s.overflow), [], `profile copy overflows at ${vp.name}-${theme}`);
      assert.equal(probe.selected.on, true);
      assert.equal(probe.selected.chip, true);
      assert.equal(probe.selected.chipIcon, true, 'selected card check glyph missing');
      assert.match(probe.selected.chipText, /현재/);
      assert.notEqual(probe.selected.selected.bg, probe.selected.unselected.bg, 'selected card has no wash');
      assert.deepEqual(probe.overflow, [], `overflow at ${vp.name}-${theme}`);
      if (vp.width <= 599) {
        assert.ok(probe.controls.minHeight >= 44, `phone target ${probe.controls.minHeight}px`);
        await page.eval(`document.querySelector('#main').scrollTop = 600`);
        await settle();
        const sticky = await page.eval(`(() => { const t = document.querySelector('.pf-title'); const r = t.getBoundingClientRect(); return { top: Math.round(r.top), visible: r.top >= 0 && r.bottom <= innerHeight }; })()`);
        assert.equal(sticky.visible, true, 'compact title did not stay visible after scrolling');
        run.checks.byViewport[`${vp.name}-${theme}`].titleScrolled = sticky;
        await page.eval(`document.querySelector('#main').scrollTop = 0`);
        await settle();
      }
      return probe;
    };

    await page.goto(url);
    await waitFor(`!!document.querySelector('[data-shell]')`, 'board shell');
    await openProfiles();

    // ── 6-shot matrix + sections + pressed pixels + targeted rows ─────────────
    for (const vp of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        await measureLoaded(vp, scheme);
        await capture(path.join(OUT, `profiles-${vp.name}-${scheme}.png`));
        await captureSections(vp, scheme);
      }
    }

    // A3/B9: real pointer-down frames. CDP presses the actual element; no class is forced.
    for (const vp of VIEWPORTS) for (const scheme of SCHEMES) {
      await pressCapture('card', '.pf-card[data-profile="gpt-deepseek"]', vp, scheme);
    }
    for (const vp of VIEWPORTS) for (const scheme of SCHEMES) {
      await pressCapture('nav', '.pf-nav-b[data-target="agents"]', vp, scheme);
    }
    for (const vp of VIEWPORTS) for (const scheme of SCHEMES) await focusCapture(vp, scheme);

    // B10/B11: the Oracle absence row and the remembered model row at the widths where the
    // section frames cut them off.
    const captureTargeted = async (vp, theme) => {
      await applyViewport(vp);
      await applyScheme(theme);
      await closePeek();
      await page.eval(`(() => { const row = document.querySelector('[data-pf-route="agents/oracle"]'); if (!row) throw new Error('oracle row missing'); row.scrollIntoView({ block: 'center' }); return true; })()`);
      await settle();
      const oracle = await page.eval(`(() => {
        const main = document.querySelector('#main');
        const row = document.querySelector('[data-pf-route="agents/oracle"]');
        const mr = main.getBoundingClientRect(), r = row.getBoundingClientRect();
        return { text: row.textContent, selects: row.querySelectorAll('select').length,
          visible: r.top >= mr.top - 1 && r.bottom <= mr.bottom + 1 };
      })()`);
      assert.equal(oracle.selects, 0, `Oracle row is editable at ${vp.name}-${theme}`);
      assert.match(oracle.text, /5\.1\.38에 없음/);
      assert.equal(oracle.visible, true, `Oracle row not in frame at ${vp.name}-${theme}`);
      await capture(path.join(OUT, `section-profiles-oracle-${vp.name}-${theme}.png`));
      run.checks.targeted = run.checks.targeted || {};
      run.checks.targeted[`oracle-${vp.name}-${theme}`] = oracle;
      if (vp.name === '390') {
        await page.eval(`(() => { const line = document.querySelector('[data-pf-agent="sisyphus"] .pf-mem-line'); if (!line) throw new Error('memory line missing'); line.scrollIntoView({ block: 'center' }); return true; })()`);
        await settle();
        const memory = await page.eval(`(() => {
          const main = document.querySelector('#main');
          const line = document.querySelector('[data-pf-agent="sisyphus"] .pf-mem-line');
          const value = line.querySelector('.pf-mem');
          const reset = line.querySelector('[data-pf="reset-memory"]');
          const mr = main.getBoundingClientRect(), r = line.getBoundingClientRect();
          return { value: value && value.textContent, reset: reset && reset.textContent,
            visible: r.top >= mr.top - 1 && r.bottom <= mr.bottom + 1,
            target: reset ? { w: Math.round(reset.getBoundingClientRect().width), h: Math.round(reset.getBoundingClientRect().height) } : null };
        })()`);
        assert.match(memory.value, /gpt-6\.1-sol/);
        assert.match(memory.reset, /기억 초기화/);
        assert.equal(memory.visible, true, `remembered model not in frame at 390-${theme}`);
        assert.ok(memory.target.w >= 44 && memory.target.h >= 44, 'memory reset target below 44px at 390');
        await capture(path.join(OUT, `section-agents-memory-390-${theme}.png`));
        run.checks.targeted[`memory-390-${theme}`] = memory;
      }
    };
    for (const vp of [VIEWPORTS[0], VIEWPORTS[1]]) for (const theme of SCHEMES) await captureTargeted(vp, theme);

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
    run.checks.prose1440 = await proseSizes();
    for (const [name, size] of Object.entries(run.checks.prose1440)) {
      assert.ok(size >= 14, `1440 profiles prose ${name} is ${size}px, below the 14px floor`);
    }

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
        const tops = [lane, pin].filter(Boolean).map(top);
        const allTops = [lane, pin, think].filter(Boolean).map(top);
        return { agent: row.getAttribute('data-pf-agent'), laneTop: top(lane), pinTop: top(pin), thinkingTop: top(think),
          delta: tops.length ? Math.max(...tops) - Math.min(...tops) : null,
          allDelta: allTops.length ? Math.max(...allTops) - Math.min(...allTops) : null,
          thinkingBelowPin: !!(pin && think && top(think) > top(pin)),
          resetGap: reset && mem ? Math.abs(center(reset) - center(mem)) : null,
          resetInsideMemory: !!(reset && reset.closest('.pf-mem-field')) };
      });
      return { rows, maxDelta: Math.max(...rows.map((r) => r.delta || 0)),
        maxAllDelta: Math.max(...rows.map((r) => r.allDelta || 0)),
        stacked: rows.every((r) => r.thinkingBelowPin),
        maxResetGap: Math.max(...rows.map((r) => r.resetGap || 0)),
        resetOutside: rows.filter((r) => !r.resetInsideMemory).map((r) => r.agent) };
    })()`);
    run.checks.agentAlign1440 = await agentAlignment();
    assert.equal(run.checks.agentAlign1440.maxDelta <= 1, true, 'agent lane/pin select tops differ at 1440');
    assert.equal(run.checks.agentAlign1440.maxAllDelta <= 1, true, 'agent lane/pin/thinking select tops differ at 1440');
    assert.deepEqual(run.checks.agentAlign1440.resetOutside, [], 'reset action outside the memory field at 1440');
    assert.equal(run.checks.agentAlign1440.maxResetGap <= 20, true, 'reset action is not next to the memory value at 1440');

    await applyViewport(VIEWPORTS[1]);
    await applyScheme('light');
    await settle();
    run.checks.agentAlign1024 = await agentAlignment();
    assert.equal(run.checks.agentAlign1024.maxDelta <= 1, true, 'agent lane/pin select tops differ at 1024');
    assert.equal(run.checks.agentAlign1024.stacked, true, 'agent pin/thinking pair is not stacked at 1024');
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
    run.checks.selectFit1024 = await selectFit();
    assert.deepEqual(run.checks.selectFit1024.truncated, [], 'short select values are ellipsized at 1024');
    run.checks.prose1024 = await proseSizes();
    for (const [name, size] of Object.entries(run.checks.prose1024)) {
      assert.ok(size >= 14, `1024 profiles prose ${name} is ${size}px, below the 14px floor`);
    }

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
    run.checks.selectFit390 = await selectFit();
    assert.deepEqual(run.checks.selectFit390.truncated, [], 'short select values are ellipsized at 390');

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

    // Negative controls: the same contrast/overflow/target probes must flag known-bad synthetic
    // nodes, so the zero-hit results above are not a detector that can never fire.
    run.checks.negativeControls = await page.eval(`(() => {
      const parse = (value) => { const m = /rgba?\\(([^)]+)\\)/.exec(value || ''); if (!m) return null; const p = m[1].split(',').map((x) => Number(x.trim())); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
      const lum = (c) => { const f = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100; };
      const root = document.querySelector('.pf');
      const low = document.createElement('span'); low.style.color = 'rgb(188,188,192)'; low.style.background = 'rgb(236,236,239)'; low.textContent = 'x'; root.appendChild(low);
      const lowRatio = ratio(parse(getComputedStyle(low).color), parse(getComputedStyle(low).backgroundColor)); low.remove();
      const wide = document.createElement('div'); wide.style.width = '2000px'; wide.style.height = '1px'; root.appendChild(wide);
      const overflowDetected = [...document.querySelectorAll('.pf *')].some((el) => el.getBoundingClientRect().right > innerWidth + 1); wide.remove();
      const small = document.createElement('button'); small.className = 'pf-btn'; small.style.width = '10px'; small.style.height = '10px'; root.appendChild(small);
      const smallRect = small.getBoundingClientRect(); const targetDetected = smallRect.width < 44 || smallRect.height < 44; small.remove();
      return { lowRatio, contrastDetected: lowRatio < 3, overflowDetected, targetDetected };
    })()`);
    assert.equal(run.checks.negativeControls.contrastDetected, true, 'contrast probe cannot see a known 1.6:1 pair');
    assert.equal(run.checks.negativeControls.overflowDetected, true, 'overflow probe cannot see a 2000px node');
    assert.equal(run.checks.negativeControls.targetDetected, true, 'target probe cannot see a 10px control');

    // Todo-22 carried states from todos 20/21: absent-in-5.1.44 row, recommendation pins and
    // the extension-owned remembered model, all read through the real store state.
    run.checks.addedStates = await page.eval(`(() => {
      const absent = [...document.querySelectorAll('.pf-route')]
        .filter((row) => row.textContent.includes('5.1.44에 없음'))
        .map((row) => ({ route: row.getAttribute('data-pf-route'), selects: row.querySelectorAll('select').length }));
      const guide = document.querySelector('.pf-guide');
      const remembered = document.querySelector('[data-pf-agent="sisyphus"] .pf-mem');
      return {
        absentRows: absent,
        guide: guide ? { sources: guide.querySelectorAll('.pf-guide-row').length, text: guide.textContent } : null,
        remembered: remembered ? remembered.textContent : ''
      };
    })()`);
    assert.ok(run.checks.addedStates.absentRows.some((row) => row.route === 'agents/oracle' && row.selects === 0),
      'the 5.1.44-absent Oracle row is not read-only');
    assert.equal(run.checks.addedStates.guide?.sources, 2, 'the recommendation guide does not pin both 5.1.44 sources');
    assert.match(run.checks.addedStates.guide.text, /omo-task\.js/, 'the guide omits the omo-task.js pin');
    assert.match(run.checks.addedStates.remembered, /gpt-6\.1-sol/, 'the remembered model is not rendered');

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
        '.pf-btn', '.pf-chip', '.pf-ro-val', '.pf-card-sum', '.pf-nav-b',
        '.pf select:disabled', '.pf input:disabled', '.pf-btn:disabled', '.pf-btn-ghost:disabled'];
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
    const disabledEdgeProbe = `(() => {
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
      const rows = [], seen = new Set();
      for (const el of document.querySelectorAll('.pf select:disabled, .pf input:disabled, .pf-btn:disabled, button.pf-card:disabled')) {
        const cs = getComputedStyle(el);
        const edge = parse(cs.borderTopColor);
        const fill = parse(cs.backgroundColor);
        if (!edge) continue;
        const outer = background(el.parentElement || el);
        const inner = fill ? composite(fill, outer) : outer;
        const edgeRatio = ratio(composite(edge, inner), outer);
        const edgeVsFill = ratio(composite(edge, inner), inner);
        const fillRatio = ratio(inner, outer);
        const key = [cs.borderTopColor, cs.backgroundColor, JSON.stringify(outer)].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ tag: el.tagName.toLowerCase(), pf: el.getAttribute('data-pf') || '',
          edge: cs.borderTopColor, fill: cs.backgroundColor, outer, edgeRatio, edgeVsFill, fillRatio, need: 3, pass: edgeRatio >= 3 && edgeVsFill >= 3 });
      }
      return { rows, count: rows.length, pass: rows.length > 0 && rows.every((row) => row.pass) };
    })()`;
    run.checks.contrastEdges = await page.eval(disabledEdgeProbe);
    assert.ok(run.checks.contrastEdges.count > 0, 'light disabled control edges were not measured');
    assert.equal(run.checks.contrastEdges.pass, true, 'light disabled control edges below 3:1');
    await applyScheme('dark');
    await settle();
    run.checks.contrastDark = await page.eval(contrastProbe);
    assert.equal(run.checks.contrastDark.pass, true, 'dark contrast rows below their threshold');
    run.checks.contrastEdgesDark = await page.eval(disabledEdgeProbe);
    assert.ok(run.checks.contrastEdgesDark.count > 0, 'dark disabled control edges were not measured');
    assert.equal(run.checks.contrastEdgesDark.pass, true, 'dark disabled control edges below 3:1');
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
    await waitFor(`document.querySelector('[data-pf-root]')?.getAttribute('data-pf-state') === 'loading'`, 'loading frame');
    run.checks.loading = await page.eval(`(() => ({
      hasLoading: !!document.querySelector('.pf-loading'),
      state: (document.querySelector('[data-pf-root]') || {}).getAttribute ? document.querySelector('[data-pf-root]').getAttribute('data-pf-state') : '',
      badge: (document.querySelector('.pf-head-r .pf-chip') || {}).textContent || '',
      readonlyText: ((document.querySelector('.pf') || {}).innerText || '').match(/읽기 전용/g) || [],
      hasReadonlyNote: !!document.querySelector('.pf-ro-note'),
      sections: document.querySelectorAll('[data-pf-sec]').length,
      skeleton: document.querySelectorAll('.pf-skeleton .pf-skel').length,
      pulse: !!document.querySelector('.pf-pulse'),
    }))()`);
    assert.equal(run.checks.loading.hasLoading, true, 'loading frame has no loading status');
    assert.equal(run.checks.loading.state, 'loading', 'loading frame has no explicit state signal');
    assert.deepEqual(run.checks.loading.readonlyText, [], 'loading frame says read-only');
    assert.equal(run.checks.loading.hasReadonlyNote, false, 'loading frame renders the read-only note');
    assert.equal(run.checks.loading.sections, 0, 'loading frame renders loaded sections');
    assert.ok(run.checks.loading.skeleton >= 12, 'loading frame does not reserve a skeleton layout');
    assert.equal(run.checks.loading.pulse, true, 'loading frame has no pulsing glyph');
    // A1: the skeleton uses the loaded full-width agent rows. Measure both at each width.
    run.checks.loadingGeometry = {};
    const loadingGeometry = () => page.eval(`(() => {
      const main = document.querySelector('#main');
      const base = main.getBoundingClientRect().top - main.scrollTop;
      const rel = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top - base), height: Math.round(r.height), width: Math.round(r.width) }; };
      const item = (key) => { const el = document.querySelector('[data-pf-skel="' + key + '"]'); return el ? rel(el) : null; };
      return { state: document.querySelector('[data-pf-root]').getAttribute('data-pf-state'),
        firstAgent: rel(document.querySelector('[data-pf-skel="agent"]')),
        agents: item('agents'), profiles: item('profiles'), routing: item('routing'),
        homes: item('homes'), tray: item('tray'), agentRows: [...document.querySelectorAll('[data-pf-skel="agent"]')].map(rel) };
    })()`);
    for (const vp of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        await applyViewport(vp);
        await applyScheme(scheme);
        await settle();
        if (scheme === 'light') run.checks.loadingGeometry[vp.name] = await loadingGeometry();
        await captureState('loading', vp, scheme);
      }
    }
    for (const vp of VIEWPORTS) {
      const skeleton = run.checks.loadingGeometry[vp.name];
      const loaded = run.checks.byViewport[`${vp.name}-light`];
      assert.equal(skeleton.state, 'loading', `loading geometry was not measured in the loading state at ${vp.name}`);
      const firstShift = Math.abs(loaded.tray.firstAgentTop - skeleton.firstAgent.top);
      skeleton.firstAgentTop = skeleton.firstAgent.top;
      skeleton.loadedFirstAgentTop = loaded.tray.firstAgentTop;
      skeleton.firstAgentDelta = firstShift;
      assert.ok(firstShift <= 2, `loading skeleton first agent shifts ${firstShift}px at ${vp.name} (${skeleton.firstAgent.top} -> ${loaded.tray.firstAgentTop})`);
      assert.equal(skeleton.agentRows.length, 4, `loading skeleton agent rows at ${vp.name}`);
      assert.ok(new Set(skeleton.agentRows.map((row) => row.width)).size === 1, `skeleton agents are not one full-width column at ${vp.name}`);
      for (const key of ['agents', 'profiles', 'routing']) {
        const delta = Math.abs(skeleton[key].top - loaded.sections[key].top);
        const ratio = skeleton[key].height / loaded.sections[key].height;
        skeleton[key].loadedTop = loaded.sections[key].top;
        skeleton[key].loadedHeight = loaded.sections[key].height;
        skeleton[key].topDelta = delta;
        skeleton[key].heightRatio = Math.round(ratio * 100) / 100;
        assert.ok(delta <= 2, `loading/loaded ${key} top delta ${delta}px at ${vp.name}`);
      }
      const skeletonFill = skeleton.agentRows[0].width / skeleton.agents.width;
      const loadedFill = loaded.agents[0].width / loaded.sections.agents.width;
      assert.ok(Math.abs(skeletonFill - loadedFill) <= 0.02, `agent row fill ratio differs at ${vp.name}`);
    }
    await page.client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: loadingInit.identifier });
    await applyViewport(VIEWPORTS[0]);
    await applyScheme('light', true);
    await settle();
    run.checks.reducedMotion = await page.eval(`(() => {
      const pulse = document.querySelector('.pf-pulse');
      const cs = pulse ? getComputedStyle(pulse) : null;
      return { animationName: cs ? cs.animationName : '',
        animationDuration: cs ? cs.animationDuration : '',
        transform: cs ? cs.transform : '',
        opacity: cs ? cs.opacity : '',
        loadingText: (document.getElementById('pf-focus-status') || {}).textContent || '' };
    })()`);
    assert.equal(run.checks.reducedMotion.animationName, 'pf-pulse', 'reduced motion freezes the sole loading indicator');
    assert.ok(Number.parseFloat(run.checks.reducedMotion.animationDuration) >= 2, 'reduced motion does not slow the opacity pulse');
    assert.equal(run.checks.reducedMotion.transform, 'none', 'reduced motion introduces positional motion');
    assert.ok(Number(run.checks.reducedMotion.opacity) >= 0.3 && Number(run.checks.reducedMotion.opacity) <= 1, 'reduced motion opacity feedback is out of range');
    assert.ok(run.checks.reducedMotion.loadingText.trim().length > 0, 'loading status text is empty');
    await page.eval(`(() => { const p = document.querySelector('.pf-pulse'); if (p) { p.style.animationPlayState = 'paused'; p.style.animationDelay = '-1.2s'; } return true; })()`);
    await page.eval(sleepFrame());
    run.checks.reducedMotion.capturePausedAt = '50% of 2.4s';
    await capture(path.join(OUT, 'state-loading-390-light-reduced-motion.png'));
    await page.eval(`(() => { const p = document.querySelector('.pf-pulse'); if (p) { p.style.animationPlayState = ''; p.style.animationDelay = ''; } return true; })()`);
    await applyScheme('light');

    // Profiles-only failure: /data.json stays healthy, so an expected state-read refusal must not
    // paint the shared page-error badge. Retry re-reads in place and recovers the loaded view.
    await applyViewport(VIEWPORTS[0]);
    await applyScheme('light');
    await page.eval(`window.localStorage.clear(); window.sessionStorage.clear();`);
    await page.goto(url);
    await waitFor(`!!window.BriefPage && window.BriefPage.state.ui.live === true`, 'board page bound for error probe');
    if (await page.eval(`window.BriefPage.state.ui.view === 'profiles'`)) {
      await page.eval(`document.querySelector('[data-sh="view"][data-key="home"]').click()`);
      await settle();
    }
    await page.eval(`window.__qaProfileFail = true;
      if (!window.__qaRealFetch) {
        window.__qaRealFetch = window.fetch;
        window.fetch = function (url, opts) {
          if (window.__qaProfileFail && String(url).indexOf('/profiles') === 0) return Promise.reject(new Error('qa-offline'));
          return window.__qaRealFetch.apply(this, [url, opts]);
        };
      }`);
    await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
    await waitFor(`document.querySelector('[data-pf-root]')?.getAttribute('data-pf-state') === 'error'`, 'error frame');
    run.checks.error = await page.eval(`(() => {
      const box = document.querySelector('.pf-error');
      const pageError = document.getElementById('page-error');
      return {
        hasError: !!box,
        errorText: box ? box.innerText : '',
        errorKind: window.BriefPage.state.ui.profilesState?.errorKind || '',
        hasRetry: !!document.querySelector('.pf-error [data-pf="reload"]'),
        retryAria: (document.querySelector('.pf-error [data-pf="reload"]') || {}).getAttribute ? (document.querySelector('.pf-error [data-pf="reload"]').getAttribute('aria-label') || '') : '',
        hasLoading: !!document.querySelector('.pf-loading'),
        readonlyText: ((document.querySelector('.pf') || {}).innerText || '').match(/읽기 전용/g) || [],
        hasReadonlyNote: !!document.querySelector('.pf-ro-note'),
        pageErrorVisible: !!pageError && pageError.hidden !== true,
      };
    })()`);
    assert.equal(run.checks.error.hasError, true, 'error frame has no error box');
    assert.equal(run.checks.error.errorKind, 'network', 'the expected network failure is not classified');
    assert.ok(run.checks.error.errorText.trim().length > 0, 'error frame shows no plain cause');
    assert.doesNotMatch(run.checks.error.errorText, /qa-offline/, 'error frame leaks the raw cause token');
    assert.equal(run.checks.error.hasRetry, true, 'error frame has no retry affordance');
    assert.ok(run.checks.error.retryAria.length > 0, 'error retry has no accessible name');
    assert.equal(run.checks.error.hasLoading, false, 'error frame still says loading');
    assert.deepEqual(run.checks.error.readonlyText, [], 'error frame says read-only');
    assert.equal(run.checks.error.hasReadonlyNote, false, 'error frame renders the read-only note');
    assert.equal(run.checks.error.pageErrorVisible, false, 'profiles failure painted the shared page-error badge');
    await captureStates('error');

    await applyViewport(VIEWPORTS[0]);
    await applyScheme('light');
    await page.eval(`window.__qaProfileFail = false`);
    await page.eval(`document.querySelector('.pf-error [data-pf="reload"]').click()`);
    await waitFor(`document.querySelectorAll('.pf-agent').length === 4 && !document.querySelector('.pf-loading')`, 'offline retry loaded profiles');
    run.checks.offlineRetry = await page.eval(`(() => ({
      error: !!document.querySelector('.pf-error'),
      loading: !!document.querySelector('.pf-loading'),
      agents: document.querySelectorAll('.pf-agent').length,
      editable: !!document.querySelector('.pf select') && !document.querySelector('.pf[data-readonly="true"]'),
      pageError: !!document.getElementById('page-error') && document.getElementById('page-error').hidden !== true,
    }))()`);
    assert.equal(run.checks.offlineRetry.error, false, 'retry did not clear the error');
    assert.equal(run.checks.offlineRetry.loading, false, 'retry left the loading state');
    assert.equal(run.checks.offlineRetry.agents, 4, 'retry did not load the four agents');
    assert.equal(run.checks.offlineRetry.editable, true, 'retry did not recover the editable view');
    assert.equal(run.checks.offlineRetry.pageError, false, 'retry painted the shared page-error badge');
    await settle();
    await capture(path.join(OUT, 'state-error-retry-390-light.png'));

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

    // Empty-data profiles response: no cards and no routing rows, but an explicit empty sentence
    // and the compact tray's next action must still be present and the view must not error.
    const emptyProfiles = { ...store.state(), activeProfile: null, profiles: [], routing: { ...store.state().routing, rows: [] } };
    profilesStateOverride = emptyProfiles;
    await page.goto(url);
    await waitFor(`!!document.querySelector('[data-shell]')`, 'board shell for empty-data state');
    await openProfiles();
    run.checks.empty = await page.eval(`(() => ({
      cards: document.querySelectorAll('.pf-card').length,
      routes: document.querySelectorAll('.pf-route').length,
      state: document.querySelector('[data-pf-root]').getAttribute('data-pf-state'),
      profileSub: (document.querySelector('#pf-sec-profiles .pf-sec-s') || {}).textContent || '',
      profileCount: (document.querySelector('#pf-sec-profiles .pf-count') || {}).textContent || '',
      routeCount: (document.querySelector('#pf-sec-routing .pf-count') || {}).textContent || '',
      reloadButtons: document.querySelectorAll('#pf-sec-profiles [data-pf="reload-state"], #pf-sec-routing [data-pf="reload-state"]').length,
      createControls: document.querySelectorAll('[data-pf="create-profile"], [data-pf="create-role"]').length,
      profileNote: [...document.querySelectorAll('.pf-cards .pf-empty')].map((el) => el.textContent.trim()),
      routeNote: [...document.querySelectorAll('.pf-routes .pf-empty, #pf-sec-routing .pf-empty')].map((el) => el.textContent.trim()),
      trayNext: (document.querySelector('.pf-tray-next') || {}).textContent || '',
      compactTray: !!document.querySelector('.pf-tray-compact'),
      error: !!document.querySelector('.pf-error'),
    }))()`);
    assert.equal(run.checks.empty.cards, 0, 'empty data still rendered profile cards');
    assert.equal(run.checks.empty.routes, 0, 'empty data still rendered routing rows');
    assert.equal(run.checks.empty.state, 'view', 'empty data is not a loaded state');
    assert.equal(Number((run.checks.empty.profileSub.match(/\d+/) || [])[0]), Number(run.checks.empty.profileCount), 'the empty subtitle count differs from the real list');
    assert.equal(run.checks.empty.profileCount, '0');
    assert.equal(run.checks.empty.routeCount, '0');
    assert.ok(run.checks.empty.reloadButtons >= 2, 'empty profiles/routing have no supported state reload');
    assert.equal(run.checks.empty.createControls, 0, 'empty data invents profile creation');
    assert.ok(run.checks.empty.profileNote.length > 0, 'empty profiles have no explicit sentence');
    assert.ok(run.checks.empty.routeNote.length > 0, 'empty routing has no explicit sentence');
    assert.ok(run.checks.empty.trayNext.trim().length >= 8, 'empty tray does not name the next action');
    assert.equal(run.checks.empty.compactTray, true, 'empty data did not keep the compact tray');
    assert.equal(run.checks.empty.error, false, 'empty data rendered an error');
    await page.eval(`window.__qaEmptyReads = 0; window.__qaEmptyPosts = 0; window.__qaEmptyFetch = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url) === '/profiles/state') window.__qaEmptyReads += 1;
        if (String(url) === '/profiles') window.__qaEmptyPosts += 1;
        return window.__qaEmptyFetch.apply(this, [url, opts]);
      };`);
    await page.eval(`document.querySelector('#pf-sec-profiles [data-pf="reload-state"]').click()`);
    await waitFor(`window.__qaEmptyReads > 0 && window.BriefPage.state.ui.profilesState.loading === false && document.querySelector('[data-pf-root]')?.getAttribute('data-pf-state') === 'view'`, 'empty-state recovery read');
    run.checks.emptyRecovery = await page.eval(`({ reads: window.__qaEmptyReads, posts: window.__qaEmptyPosts,
      cards: document.querySelectorAll('.pf-card').length, routes: document.querySelectorAll('.pf-route').length })`);
    assert.ok(run.checks.emptyRecovery.reads >= 1, 'the empty-state action did not re-read the real state');
    assert.equal(run.checks.emptyRecovery.posts, 0, 'the empty-state action posted a write');
    assert.equal(run.checks.emptyRecovery.cards, 0);
    assert.equal(run.checks.emptyRecovery.routes, 0);
    run.checks.emptyProse = {};
    for (const vp of VIEWPORTS) {
      for (const theme of SCHEMES) {
        await applyViewport(vp);
        await applyScheme(theme);
        await scrollTop();
        await closePeek();
        await settle();
        run.checks.emptyProse[`${vp.name}-${theme}`] = await page.eval(`(() => {
          const el = document.querySelector('#pf-sec-profiles .pf-empty');
          const cs = getComputedStyle(el);
          return { fontSize: cs.fontSize, lineHeight: cs.lineHeight };
        })()`);
        await capture(path.join(OUT, `state-empty-${vp.name}-${theme}.png`));
        await scrollUnderHeader('#pf-sec-profiles');
        await settle();
        await capture(path.join(OUT, `state-empty-profiles-${vp.name}-${theme}.png`));
        await scrollTop();
      }
    }
    for (const [key, row] of Object.entries(run.checks.emptyProse)) {
      assert.ok(Number.parseFloat(row.fontSize) >= 14, `empty prose is ${row.fontSize} at ${key}`);
    }
    profilesStateOverride = null;
    await page.goto(url);
    await waitFor(`!!document.querySelector('[data-shell]')`, 'board shell after empty-data state');
    await openProfiles();

    // Real pointer hover on a select and on a preview summary; the computed paint must change.
    await hoverCapture(path.join(OUT, 'hover-select-390-light.png'), '[data-pf="agent-lane"][data-agent="sisyphus"]', VIEWPORTS[0], 'light');
    await hoverCapture(path.join(OUT, 'hover-select-1440-dark.png'), '[data-pf="agent-lane"][data-agent="sisyphus"]', VIEWPORTS[2], 'dark');

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

    await page.eval(`window.__qaProfileFetches = []; window.__qaRealFetch = window.fetch;
      window.__qaHoldApply = false; window.__qaReleaseApply = null;
      window.fetch = function (...args) {
        const real = window.__qaRealFetch;
        if (window.__qaHoldApply && String(args[0]) === '/profiles' && args[1] && args[1].method === 'POST') {
          window.__qaHoldApply = false;
          return new Promise((resolve, reject) => { window.__qaReleaseApply = () => real.apply(window, args).then((res) => {
            window.__qaProfileFetches.push({ url: String(args[0]), status: res.status }); resolve(res);
          }, reject); });
        }
        return real.apply(window, args).then((res) => {
          window.__qaProfileFetches.push({ url: String(args[0]), status: res.status }); return res;
        });
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

    // B5: discard is a danger action with an inline confirmation; cancel keeps every value.
    await page.eval(`document.querySelector('[data-pf="clear"]').click()`);
    await waitFor(`!!document.querySelector('.pf-clear')`, 'discard confirmation');
    run.checks.clearConfirm = await page.eval(`(() => ({
      danger: document.querySelector('[data-pf="clear"]').classList.contains('pf-btn-danger'),
      group: document.querySelector('.pf-clear').getAttribute('aria-label'),
      hasCancel: !!document.querySelector('[data-pf="clear-cancel"]'),
      hasConfirm: !!document.querySelector('[data-pf="clear-confirm"]'),
      pending: document.querySelectorAll('.pf-pending li').length,
    }))()`);
    assert.equal(run.checks.clearConfirm.danger, true, 'discard action is not danger-styled');
    assert.equal(run.checks.clearConfirm.group, '대기 변경 버리기 확인');
    assert.equal(run.checks.clearConfirm.hasCancel, true);
    assert.equal(run.checks.clearConfirm.hasConfirm, true);
    assert.equal(run.checks.clearConfirm.pending, 2);
    await page.eval(`document.querySelector('[data-pf="clear-cancel"]').click()`);
    await settle();
    run.checks.clearCancel = await page.eval(`({
      prompt: !!document.querySelector('.pf-clear'),
      pending: document.querySelectorAll('.pf-pending li').length,
      text: (document.querySelector('.pf-pending') || {}).textContent || '',
    })`);
    assert.equal(run.checks.clearCancel.prompt, false);
    assert.equal(run.checks.clearCancel.pending, 2, 'cancel dropped a pending edit');
    assert.match(run.checks.clearCancel.text, /atlas 레인/);
    assert.match(run.checks.clearCancel.text, /agents\/explore/);

    await captureStates('pending');
    const captureDiscard = async (vp, theme) => {
      await applyViewport(vp);
      await applyScheme(theme);
      await closePeek();
      await scrollTop();
      await settle();
      await page.eval(`document.querySelector('[data-pf="clear"]').click()`);
      await waitFor(`!!document.querySelector('[data-pf="clear-confirm"]')`, 'discard confirmation capture');
      await page.eval(`document.querySelector('.pf-clear').scrollIntoView({ block: 'center' })`);
      await settle();
      run.checks.discardConfirm = run.checks.discardConfirm || {};
      run.checks.discardConfirm[`${vp.name}-${theme}`] = await page.eval(`(() => ({
        prompt: !!document.querySelector('.pf-clear'),
        cancel: !!document.querySelector('[data-pf="clear-cancel"]'),
        confirm: !!document.querySelector('[data-pf="clear-confirm"]'),
        pending: document.querySelectorAll('.pf-pending li').length,
      }))()`);
      assert.equal(run.checks.discardConfirm[`${vp.name}-${theme}`].pending, 2, 'discard confirmation lost the pending edits');
      await capture(path.join(OUT, `state-discard-${vp.name}-${theme}.png`));
      await page.eval(`document.querySelector('[data-pf="clear-cancel"]').click()`);
      await settle();
    };
    for (const vp of VIEWPORTS) {
      for (const theme of SCHEMES) await captureDiscard(vp, theme);
    }
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
    await scrollUnderHeader('.pf-tray');
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
    await captureStates('preview');

    // Real hover on a preview summary, then a keyboard preview activation with a held POST so the
    // busy frame and its active element can be read through the real page.
    await hoverCapture(path.join(OUT, 'hover-summary-390-light.png'), '.pf-diff summary', VIEWPORTS[0], 'light');
    await applyViewport(VIEWPORTS[0]);
    await applyScheme('light');
    await closePeek();
    await scrollUnderHeader('.pf-tray');
    await settle();
    await page.eval(`window.__qaHoldApply = true`);
    await page.eval(`document.querySelector('[data-pf="preview"]').focus()`);
    await pressEnter();
    await waitFor(`!!document.querySelector('[data-pf="preview"]')?.disabled && document.activeElement.id === 'pf-focus-status'`, 'preview busy focus');
    run.checks.focusBusyPreview = await focusInfo();
    assert.equal(run.checks.focusBusyPreview.id, 'pf-focus-status', 'busy preview lost keyboard focus');
    assert.equal(run.checks.focusBusyPreview.inside, true, 'busy preview focus left the profiles surface');
    assert.equal(run.checks.focusBusyPreview.busy, true, 'the held preview is not marked busy');
    assert.ok(run.checks.focusBusyPreview.text.length > 0, 'the busy preview status is empty');
    assert.equal(run.checks.focusBusyPreview.previewDisabled, true, 'busy preview control is not disabled');
    run.checks.busyEdges = await page.eval(disabledEdgeProbe);
    assert.ok(run.checks.busyEdges.count > 0, 'busy disabled control edges were not measured');
    assert.equal(run.checks.busyEdges.pass, true, 'busy disabled control edges below 3:1');
    run.checks.busyEdit = await page.eval(`(() => {
      const sel = document.querySelector('[data-pf="agent-lane"][data-agent="sisyphus"]');
      const before = window.BriefPage.state.ui.profilesState.pending.length;
      const draftBefore = Object.keys(window.BriefPage.state.ui.profilesState.draft || {}).length;
      const disabled = sel.disabled;
      sel.value = 'geeky-heavy';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { disabled, before, after: window.BriefPage.state.ui.profilesState.pending.length,
        draftBefore, draftAfter: Object.keys(window.BriefPage.state.ui.profilesState.draft || {}).length };
    })()`);
    assert.equal(run.checks.busyEdit.disabled, true, 'an editor select accepts input during a held preview');
    assert.equal(run.checks.busyEdit.before, run.checks.busyEdit.after, 'a busy-time edit mutated the pending changes');
    assert.equal(run.checks.busyEdit.draftBefore, run.checks.busyEdit.draftAfter, 'a busy-time edit mutated the draft map');
    await capture(path.join(OUT, 'focus-busy-preview-390-light.png'));
    await page.eval(`window.__qaReleaseApply && window.__qaReleaseApply()`);
    await waitFor(`!!document.querySelector('.pf-preview') && document.activeElement.id === 'pf-focus-status'`, 'preview result focus');
    run.checks.focusAfterPreview = await focusInfo();
    assert.equal(run.checks.focusAfterPreview.id, 'pf-focus-status', 'preview result lost keyboard focus');
    assert.equal(run.checks.focusAfterPreview.busy, false, 'the settled preview is still busy');
    assert.equal(run.checks.focusAfterPreview.preview, true, 'the preview payload is missing');
    await capture(path.join(OUT, 'focus-after-preview-390-light.png'));

    await applyViewport(VIEWPORTS[2]);
    await applyScheme('light');
    await scrollTop();
    await settle();

    // The one writing apply is also entered from the keyboard under a held POST; focus must survive
    // the busy render, the success receipt and the state reload that follows it.
    await page.eval(`window.__qaHoldApply = true`);
    await page.eval(`document.querySelector('[data-pf="apply"]').focus()`);
    await pressEnter();
    await waitFor(`!!document.querySelector('[data-pf="apply"]')?.disabled && document.activeElement.id === 'pf-focus-status'`, 'apply busy focus');
    run.checks.focusBusyApply = await focusInfo();
    assert.equal(run.checks.focusBusyApply.id, 'pf-focus-status', 'busy apply lost keyboard focus');
    assert.equal(run.checks.focusBusyApply.inside, true, 'busy apply focus left the profiles surface');
    assert.equal(run.checks.focusBusyApply.busy, true, 'the held apply is not marked busy');
    assert.ok(run.checks.focusBusyApply.text.length > 0, 'the busy apply status is empty');
    assert.equal(run.checks.focusBusyApply.applyDisabled, true, 'busy apply control is not disabled');
    await capture(path.join(OUT, 'focus-busy-apply-1440-light.png'));
    run.checks.busyCards = {};
    for (const vp of VIEWPORTS) for (const theme of SCHEMES) {
      await applyViewport(vp);
      await applyScheme(theme);
      await closePeek();
      await settle();
      const key = `${vp.name}-${theme}`;
      const cards = await page.eval(`(() => {
        const cards = [...document.querySelectorAll('button.pf-card:disabled')];
        const selected = cards.find(card => card.classList.contains('on'));
        const other = cards.find(card => !card.classList.contains('on'));
        if (!selected || !other) return null;
        selected.scrollIntoView({ block: 'center' });
        const style = getComputedStyle(other);
        const r = other.getBoundingClientRect();
        return { count: cards.length, selectedCount: cards.filter(card => card.classList.contains('on')).length,
          x: r.left + r.width / 2, y: r.top + r.height / 2,
          background: style.backgroundColor, border: style.borderTopColor };
      })()`);
      assert.ok(cards, `missing selected or unselected disabled card at ${key}`);
      const edges = await page.eval(disabledEdgeProbe);
      assert.equal(edges.pass, true, `busy control edge contrast at ${key}`);
      await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cards.x, y: cards.y, button: 'none' });
      await settle();
      const hovered = await page.eval(`(() => {
        const card = document.querySelector('button.pf-card:disabled:not(.on)');
        const cs = getComputedStyle(card);
        return { background: cs.backgroundColor, border: cs.borderTopColor };
      })()`);
      assert.equal(hovered.background, cards.background);
      assert.equal(hovered.border, cards.border);
      const file = `state-busy-cards-${key}.png`;
      await capture(path.join(OUT, file));
      run.checks.busyCards[key] = { file, ...cards, edges };
    }
    await applyViewport(VIEWPORTS[2]);
    await applyScheme('light');
    await scrollTop();
    await settle();
    const busyCard = await page.eval(`(() => {
      const card = document.querySelector('button.pf-card:disabled:not(.on)');
      if (!card) return null;
      card.scrollIntoView({ block: 'center' });
      const r = card.getBoundingClientRect();
      const cs = getComputedStyle(card);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2,
        background: cs.backgroundColor, border: cs.borderTopColor, disabled: card.disabled };
    })()`);
    assert.ok(busyCard, 'no disabled profile card exists during the held apply');
    await page.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: busyCard.x, y: busyCard.y, button: 'none' });
    await settle();
    run.checks.busyCardHover = await page.eval(`(() => {
      const card = document.querySelector('button.pf-card:disabled:not(.on)');
      const cs = getComputedStyle(card);
      return { background: cs.backgroundColor, border: cs.borderTopColor, disabled: card.disabled };
    })()`);
    assert.equal(run.checks.busyCardHover.disabled, true, 'the profile card is not disabled during busy');
    assert.equal(run.checks.busyCardHover.background, busyCard.background, 'disabled card hover changed its fill');
    assert.equal(run.checks.busyCardHover.border, busyCard.border, 'disabled card hover changed its border');
    await page.eval(`document.querySelector('#main').scrollTop = 0`);
    await settle();
    await page.eval(`window.__qaReleaseApply && window.__qaReleaseApply()`);
    await waitFor(`!!document.querySelector('.pf-done') || !!document.querySelector('.pf-conflict') || !!document.querySelector('.pf-err')`, 'apply result');
    await waitFor(`!document.querySelector('.pf-loading')`, 'state reload after apply');
    run.checks.focusAfterApply = await focusInfo();
    assert.equal(run.checks.focusAfterApply.id, 'pf-focus-status', 'apply success lost keyboard focus');
    assert.equal(run.checks.focusAfterApply.busy, false, 'the settled apply is still busy');
    assert.equal(run.checks.focusAfterApply.result, true, 'the apply receipt is missing');
    await capture(path.join(OUT, 'focus-after-apply-1440-light.png'));
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
    await captureStates('success');

    // B5 confirm path: only the explicit confirmation clears the pending values.
    await applyViewport(VIEWPORTS[2]);
    await applyScheme('light');
    await scrollTop();
    await settle();
    await page.eval(`(() => {
      const el = document.querySelector('select[data-pf="agent-lane"][data-agent="atlas"]');
      el.value = 'daily-normal';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    await waitFor(`document.querySelectorAll('.pf-pending li').length === 1`, 'confirm-path pending change');
    await page.eval(`document.querySelector('[data-pf="clear"]').click()`);
    await waitFor(`!!document.querySelector('[data-pf="clear-confirm"]')`, 'confirm-path prompt');
    await page.eval(`document.querySelector('[data-pf="clear-confirm"]').click()`);
    await settle();
    run.checks.clearConfirmed = await page.eval(`(() => ({
      pending: document.querySelectorAll('.pf-pending li').length,
      prompt: !!document.querySelector('.pf-clear'),
      trayCompact: !!document.querySelector('.pf-tray-compact'),
      result: !!document.querySelector('.pf-done'),
    }))()`);
    assert.equal(run.checks.clearConfirmed.pending, 0);
    assert.equal(run.checks.clearConfirmed.prompt, false);
    assert.equal(run.checks.clearConfirmed.trayCompact, true);
    assert.equal(run.checks.clearConfirmed.result, false);

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
    await captureStates('conflict');

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
    // A2: the stale primary actions are disabled and 새로고침 is the only promoted recovery.
    run.checks.conflictActions = await page.eval(`(() => ({
      conflict: !!document.querySelector('.pf-conflict'),
      previewDisabled: !!document.querySelector('[data-pf="preview"]')?.disabled,
      applyDisabled: !!document.querySelector('[data-pf="apply"]')?.disabled,
      reloadPrimary: !!document.querySelector('.pf-conflict [data-pf="reload"]')?.classList.contains('pf-btn-primary'),
      reloadLabel: (document.querySelector('.pf-conflict [data-pf="reload"]') || {}).textContent || '',
      pending: document.querySelectorAll('.pf-pending li').length,
    }))()`);
    assert.equal(run.checks.conflictActions.conflict, true);
    assert.equal(run.checks.conflictActions.previewDisabled, true, 'stale preview stayed enabled');
    assert.equal(run.checks.conflictActions.applyDisabled, true, 'stale apply stayed enabled');
    assert.equal(run.checks.conflictActions.reloadPrimary, true, 'refresh is not the promoted primary recovery');
    assert.match(run.checks.conflictActions.reloadLabel, /새로고침/);
    assert.equal(run.checks.conflictActions.pending, 1);
    // The reload is the recovery: a fresh state read clears the banner and the stale actions.
    await page.goto(url);
    await waitFor(`!!document.querySelector('[data-shell]')`, 'board shell after 409 reload');
    await openProfiles();
    run.checks.conflictRecovery = await page.eval(`(() => ({
      conflict: !!document.querySelector('.pf-conflict'),
      pending: document.querySelectorAll('.pf-pending li').length,
      applyPresent: !!document.querySelector('[data-pf="apply"]'),
      previewPresent: !!document.querySelector('[data-pf="preview"]'),
      applyDisabled: !!document.querySelector('[data-pf="apply"]')?.disabled,
      previewDisabled: !!document.querySelector('[data-pf="preview"]')?.disabled,
      trayCompact: !!document.querySelector('.pf-tray-compact'),
    }))()`);
    assert.equal(run.checks.conflictRecovery.conflict, false, '409 banner survived a successful reload');
    assert.equal(run.checks.conflictRecovery.pending, 0, '409 pending edits survived the reload');
    assert.equal(run.checks.conflictRecovery.applyPresent, false, 'stale apply returned after reload');
    assert.equal(run.checks.conflictRecovery.previewPresent, false, 'stale preview returned after reload');
    assert.equal(run.checks.conflictRecovery.trayCompact, true);
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

    // ── interrupted apply (todo 20): a real 다시 적용 control, never auto-replayed ──
    const interruptedJournal = {
      v: 1, id: 'qa-interrupted', status: 'running', action: 'apply',
      request: {
        action: 'apply',
        changes: [{ kind: 'setAgentLane', agentId: 'sisyphus', lane: 'daily-heavy' }],
        rosterRevision: 0,
      },
    };
    fs.writeFileSync(journalPath, JSON.stringify(interruptedJournal, null, 2));
    const journalHashBefore = hashFile(journalPath);
    const omoHashBeforeJournalLoad = hashFile(omoPath);
    await page.goto(url);
    await waitFor(`!!document.querySelector('[data-shell]')`, 'board shell after interrupted journal');
    await openProfiles();
    run.checks.journal = await page.eval(`(() => {
      const box = document.querySelector('[data-pf-journal="interrupted"]');
      const btn = box && box.querySelector('[data-pf="reapply"]');
      return { present: !!box, text: box ? box.textContent : '', hasReapply: !!btn,
        reapplyDisabled: btn ? btn.disabled : null, reapplyLabel: btn ? btn.textContent.trim() : '' };
    })()`);
    assert.equal(run.checks.journal.present, true, 'interrupted journal banner missing');
    assert.equal(run.checks.journal.hasReapply, true, 'interrupted journal has no 다시 적용 control');
    assert.equal(run.checks.journal.reapplyDisabled, false, 'the interrupted reapply is disabled before any conflict');
    assert.ok(run.checks.journal.reapplyLabel.length > 0, 'reapply control has no accessible label');
    assert.equal(hashFile(journalPath), journalHashBefore, 'interrupted journal was replayed on load');
    assert.equal(hashFile(omoPath), omoHashBeforeJournalLoad, 'interrupted journal wrote the config on load');
    for (const vp of VIEWPORTS) for (const scheme of SCHEMES) await captureJournal(vp, scheme);

    // Reapply is a real owner action: a successful replay writes once and clears the interrupted
    // banner; a later stale replay must answer 409 and write nothing.
    await applyViewport(VIEWPORTS[0]);
    await applyScheme('light');
    await scrollUnderHeader('[data-pf-journal="interrupted"]');
    await settle();
    const reapplyOmoBefore = hashFile(omoPath);
    const reapplyRosterBefore = hashFile(rosterPath);
    const reapplyBackupsBefore = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [];
    await page.eval(`document.querySelector('[data-pf="reapply"]').click()`);
    await waitFor(`!!document.querySelector('.pf-done') || !!document.querySelector('.pf-conflict') || !!document.querySelector('.pf-err')`, 'journal reapply result');
    await waitFor(`!document.querySelector('[data-pf-journal="interrupted"]')`, 'journal banner cleared after reapply');
    const reapplyJournal = readJsonc(journalPath);
    run.checks.journalReapplySuccess = await page.eval(`(() => ({
      done: !!document.querySelector('.pf-done'), conflict: !!document.querySelector('.pf-conflict'),
      error: (document.querySelector('.pf-err') || {}).textContent || '',
      banner: !!document.querySelector('[data-pf-journal="interrupted"]'),
      statusChip: (document.querySelector('#pf-focus-status') || {}).textContent || '',
      writes: [...document.querySelectorAll('.pf-writes code')].map((el) => el.textContent),
    }))()`);
    run.checks.journalReapplySuccess.journalStatus = reapplyJournal.status;
    run.checks.journalReapplySuccess.omoChanged = hashFile(omoPath) !== reapplyOmoBefore;
    run.checks.journalReapplySuccess.rosterChanged = hashFile(rosterPath) !== reapplyRosterBefore;
    run.checks.journalReapplySuccess.backupsAdded = (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : []).length > reapplyBackupsBefore.length;
    assert.equal(run.checks.journalReapplySuccess.done, true, 'journal reapply did not succeed: ' + JSON.stringify(run.checks.journalReapplySuccess));
    assert.equal(run.checks.journalReapplySuccess.banner, false, 'journal banner survived a successful reapply');
    assert.equal(run.checks.journalReapplySuccess.journalStatus, 'completed', 'journal did not complete after reapply');
    assert.ok(run.checks.journalReapplySuccess.omoChanged || run.checks.journalReapplySuccess.rosterChanged,
      'successful reapply wrote no protected file');
    assert.ok(run.checks.journalReapplySuccess.writes.includes('agent/primary-agents/roster.json'),
      'successful reapply did not report the roster write');
    assert.equal(run.checks.journalReapplySuccess.backupsAdded, true, 'successful reapply created no backup');
    await capture(path.join(OUT, 'state-journal-success-390-light.png'));
    await applyViewport(VIEWPORTS[1]);
    await applyScheme('light');
    await scrollUnderHeader('.pf-done');
    await settle();
    await capture(path.join(OUT, 'state-journal-success-1024-light.png'));

    const interruptedAgain = {
      v: 1, id: 'qa-interrupted-409', status: 'running', action: 'apply',
      request: { action: 'apply', changes: [{ kind: 'setAgentLane', agentId: 'prometheus', lane: 'geeky-heavy' }], rosterRevision: 1 },
    };
    fs.writeFileSync(journalPath, JSON.stringify(interruptedAgain, null, 2));
    await page.goto(url);
    await waitFor(`!!document.querySelector('[data-shell]')`, 'board shell after second interrupted journal');
    await openProfiles();
    await page.eval(`window.__qaStatuses = []; window.__qaRealStatusFetch = window.fetch;
      window.fetch = function (url, opts) {
        return window.__qaRealStatusFetch.apply(this, [url, opts]).then((res) => {
          if (String(url).indexOf('/profiles') === 0) window.__qaStatuses.push(res.status); return res;
        });
      };`);
    const journalConflictTargets = [omoPath, path.join(homes.primary, 'agent', 'settings.json'), rosterPath,
      path.join(homes.stable, 'omo.jsonc')].filter((file) => fs.existsSync(file));
    const journalConflictBefore = Object.fromEntries(journalConflictTargets.map((file) => [file, hashFile(file)]));
    const journalConflictJournalBefore = hashFile(journalPath);
    const journalConflictBackupsBefore = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [];
    fs.appendFileSync(omoPath, '\r\n');
    const journalConflictMutated = hashFile(omoPath);
    await applyViewport(VIEWPORTS[0]);
    await applyScheme('light');
    await scrollUnderHeader('[data-pf-journal="interrupted"]');
    await settle();
    await page.eval(`document.querySelector('[data-pf="reapply"]').click()`);
    await waitFor(`!!document.querySelector('.pf-conflict')`, 'journal reapply conflict');
    run.checks.journalReapplyConflict = await page.eval(`(() => ({
      conflict: !!document.querySelector('.pf-conflict'),
      conflictText: (document.querySelector('.pf-conflict') || {}).innerText || '',
      banner: !!document.querySelector('[data-pf-journal="interrupted"]'),
      reapplyDisabled: !!document.querySelector('[data-pf-journal="interrupted"] [data-pf="reapply"]')?.disabled,
      reloadPrimary: !!document.querySelector('.pf-conflict [data-pf="reload"].pf-btn-primary'),
      statuses: window.__qaStatuses.slice(),
      writes: [...document.querySelectorAll('.pf-writes code')].map((el) => el.textContent),
    }))()`);
    const journalConflictAfter = Object.fromEntries(journalConflictTargets.map((file) => [file, hashFile(file)]));
    run.checks.journalReapplyConflict.protectedHash = journalConflictAfter;
    run.checks.journalReapplyConflict.journalUnchanged = hashFile(journalPath) === journalConflictJournalBefore;
    run.checks.journalReapplyConflict.backupsUnchanged = JSON.stringify(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : []) === JSON.stringify(journalConflictBackupsBefore);
    assert.equal(run.checks.journalReapplyConflict.conflict, true, 'journal reapply 409 was not shown');
    assert.ok(run.checks.journalReapplyConflict.statuses.includes(409), 'journal reapply did not answer 409');
    assert.equal(run.checks.journalReapplyConflict.reapplyDisabled, true, 'the journal reapply stays enabled under the latched 409');
    assert.equal(run.checks.journalReapplyConflict.reloadPrimary, true, 'the conflict reload is not the primary recovery');
    assert.equal(journalConflictAfter[omoPath], journalConflictMutated, 'journal 409 rewrote the mutated omo.jsonc');
    for (const file of journalConflictTargets) {
      if (file === omoPath) continue;
      assert.equal(journalConflictAfter[file], journalConflictBefore[file], `journal 409 rewrote ${file}`);
    }
    assert.equal(run.checks.journalReapplyConflict.journalUnchanged, true, 'journal reapply 409 rewrote the journal');
    assert.equal(run.checks.journalReapplyConflict.backupsUnchanged, true, 'journal reapply 409 created a backup');
    await capture(path.join(OUT, 'state-journal-conflict-390-light.png'));
    await applyViewport(VIEWPORTS[1]);
    await applyScheme('dark');
    await scrollUnderHeader('[data-pf-journal="interrupted"]');
    await settle();
    await capture(path.join(OUT, 'state-journal-conflict-1024-dark.png'));

    // Sibling routes stay on the shared shell's rail treatment; the A8 repair remains page-scoped.
    const railSample = () => page.eval(`(() => {
      const rail = document.querySelector('#rail');
      const inactive = document.querySelector('.sh-rb:not(.on)');
      const active = document.querySelector('.sh-rb.on');
      return { view: window.BriefPage.state.ui.view,
        railBg: getComputedStyle(rail).backgroundColor,
        inactive: inactive ? getComputedStyle(inactive).color : '',
        active: active ? getComputedStyle(active).color : '' };
    })()`);
    run.checks.railScope = {};
    await applyViewport(VIEWPORTS[0]);
    await applyScheme('light');
    await settle();
    let sample = await railSample();
    run.checks.railScope['profiles-390-light'] = { ...sample, inactiveRatio: contrastRatio(sample.inactive, sample.railBg) };
    await applyScheme('dark');
    await settle();
    sample = await railSample();
    run.checks.railScope['profiles-390-dark'] = { ...sample, inactiveRatio: contrastRatio(sample.inactive, sample.railBg) };
    await applyScheme('light');
    await settle();
    for (const vp of VIEWPORTS) {
      for (const theme of SCHEMES) {
        await applyViewport(vp);
        await applyScheme(theme);
        await settle();
        for (const key of ['home', 'inbox']) {
          await closePeek();
          await page.eval(`document.querySelector('[data-sh="view"][data-key="${key}"]').click()`);
          await waitFor(`window.BriefPage.state.ui.view === '${key}'`, `sibling route ${key}`);
          await closePeekStrong();
          await settle();
          run.checks.siblingShell = run.checks.siblingShell || {};
          const siblingShell = await page.eval(`(() => ({ peek: document.querySelector('.sh-shell').getAttribute('data-peek'),
            side: document.querySelector('.sh-shell').getAttribute('data-side'),
            sideVisible: getComputedStyle(document.querySelector('#side')).visibility,
            sideLeft: Math.round(document.querySelector('#side').getBoundingClientRect().left) }))()`);
          run.checks.siblingShell[`${key}-${vp.name}-${theme}`] = siblingShell;
          assert.equal(siblingShell.peek, 'false', `sibling ${key} ${vp.name}-${theme} still has the sidebar overlay open`);
          await capture(path.join(OUT, `sibling-${key}-${vp.name}-${theme}.png`));
          if (vp.name === '390') {
            sample = await railSample();
            run.checks.railScope[`${key}-390-${theme}`] = { ...sample, inactiveRatio: contrastRatio(sample.inactive, sample.railBg) };
          }
        }
      }
    }
    assert.equal(run.checks.railScope['profiles-390-light'].view, 'profiles', 'profiles rail sample is not on profiles');
    assert.equal(run.checks.railScope['home-390-light'].view, 'home', 'sibling rail sample is not on home');
    assert.equal(run.checks.railScope['profiles-390-light'].inactive, run.checks.railScope['home-390-light'].inactive,
      'the profiles rail color diverges from the shared shell');
    assert.equal(run.checks.railScope['profiles-390-dark'].inactive, run.checks.railScope['home-390-dark'].inactive,
      'the dark profiles rail color diverges from the shared shell');
    for (const [key, sample] of Object.entries(run.checks.railScope)) {
      assert.ok(sample.inactiveRatio >= 3, `rail ${key} inactive glyph is ${sample.inactiveRatio}:1, below the 3:1 non-text floor`);
    }

    // Capture identity: every viewport frame has the emulated viewport size, and the set carries
    // every required state family, pressed/focus frames and the two targeted rows.
    const dimensions = { 390: [390, 844], 1024: [1024, 768], 1440: [1440, 900] };
    const badDimensions = [];
    for (const entry of run.captures) {
      const match = /-(390|1024|1440)-(light|dark)(?:-|\\.|$)/.exec(entry.file);
      if (!match) continue;
      const [width, height] = dimensions[match[1]];
      if (entry.width !== width || entry.height !== height) {
        badDimensions.push({ file: entry.file, width: entry.width, height: entry.height });
      }
    }
    run.checks.captureDimensions = { checked: run.captures.length, bad: badDimensions };
    assert.deepEqual(badDimensions, [], 'capture dimensions do not match the viewport');
    const files = new Set(run.captures.map((entry) => entry.file));
    const required = [];
    for (const vp of VIEWPORTS) for (const theme of SCHEMES) {
      required.push(
        `profiles-${vp.name}-${theme}.png`, `state-loading-${vp.name}-${theme}.png`,
        `state-error-${vp.name}-${theme}.png`, `state-pending-${vp.name}-${theme}.png`,
        `state-conflict-${vp.name}-${theme}.png`, `state-preview-${vp.name}-${theme}.png`,
        `state-preview-${vp.name}-${theme}-end.png`, `state-success-${vp.name}-${theme}.png`,
        `state-success-${vp.name}-${theme}-end.png`, `state-journal-${vp.name}-${theme}.png`,
        `press-card-${vp.name}-${theme}-down.png`, `press-nav-${vp.name}-${theme}-down.png`,
        `focus-${vp.name}-${theme}.png`,
      );
    }
    for (const vp of [VIEWPORTS[0], VIEWPORTS[1]]) for (const theme of SCHEMES) {
      required.push(`section-profiles-oracle-${vp.name}-${theme}.png`);
    }
    for (const theme of SCHEMES) required.push(`section-agents-memory-390-${theme}.png`);
    required.push(
      'state-loading-390-light-reduced-motion.png', 'state-error-retry-390-light.png',
      'hover-select-390-light.png', 'hover-select-1440-dark.png', 'hover-summary-390-light.png',
      'focus-busy-preview-390-light.png', 'focus-after-preview-390-light.png',
      'focus-busy-apply-1440-light.png', 'focus-after-apply-1440-light.png',
      'state-journal-success-390-light.png', 'state-journal-success-1024-light.png',
      'state-journal-conflict-390-light.png', 'state-journal-conflict-1024-dark.png',
    );
    for (const vp of VIEWPORTS) for (const theme of SCHEMES) {
      required.push(`sibling-home-${vp.name}-${theme}.png`, `sibling-inbox-${vp.name}-${theme}.png`);
      required.push(`state-empty-${vp.name}-${theme}.png`, `state-empty-profiles-${vp.name}-${theme}.png`,
        `state-discard-${vp.name}-${theme}.png`, `state-busy-cards-${vp.name}-${theme}.png`);
    }
    const missing = required.filter((file) => !files.has(file));
    run.checks.captureSet = { count: files.size, required: required.length, missing };
    assert.deepEqual(missing, [], 'the round-3 capture set is incomplete');

    let settleTimeout = '';
    try {
      await page.eval(`(() => {
        const el = document.createElement('div');
        el.id = 'qa-slow-settle';
        el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px';
        document.body.appendChild(el);
        el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 60000, iterations: 1, fill: 'forwards' });
        return true;
      })()`);
      try { await settle(); } catch (error) { settleTimeout = String(error && error.message || error); }
    } finally {
      await page.eval(`(() => {
        const el = document.getElementById('qa-slow-settle'); if (el) el.remove();
        return true;
      })()`);
    }
    run.checks.settleTimeoutProbe = { rejected: settleTimeout.length > 0, message: settleTimeout };
    assert.match(settleTimeout, /animation settlement timed out/, 'the forced settlement timeout did not fail');

    run.csp = {
      installedBeforeFirstNavigation: true,
      violations: csp ? csp.violations : [],
      notes: csp ? csp.notes.length : 0,
    };
    run.checks.cspViolations = run.csp.violations;
    csp.assertNone('qa-profiles');
    run.checks.consoleErrors = consoleErrors;
    assert.deepEqual(consoleErrors, [], 'page console errors: ' + consoleErrors.join(' | '));
    run.ok = failures.length === 0 && run.csp.violations.length === 0;
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
    if (!run.csp) {
      run.csp = {
        installedBeforeFirstNavigation: !!csp,
        violations: csp ? csp.violations : [],
        notes: csp ? csp.notes.length : 0,
      };
    }
    run.finishedAt = new Date().toISOString();
    run.ok = run.ok && failures.length === 0 && run.errors.length === 0
      && run.csp.violations.length === 0
      && run.cleanup.chrome?.closed === true && run.cleanup.server?.closed === true
      && run.cleanup.live?.serverJsonUnchanged === true && run.cleanup.live?.liveStateInvariantHolds === true
      && run.cleanup.tempRootRemoved === true;
    writeEvidence();
  }
}

// Bounded expected-failure control. It serves a TEMP-only copy of the candidate page with the
// old dark-disabled opacity dimming restored, measures the candidate first, then the defective
// render, and records one labelled PNG. It is never added to the candidate PASS capture array.
async function negativeControl() {
  const candidatePath = path.join(OUT, 'captures.json');
  if (!fs.existsSync(candidatePath)) {
    console.error(`negative control needs the candidate captures.json: ${candidatePath}`);
    process.exit(2);
  }
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  if (candidate.ok !== true) {
    console.error('candidate captures.json is not a PASS set; refusing to add a negative control');
    process.exit(2);
  }
  const liveBefore = liveState();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `piomo-t${TASK}-neg-`));
  const evidence = {
    expectedFailure: true,
    negativeControl: true,
    outsidePassMatrix: true,
    candidateBuildHash: candidate.build.hash,
    candidateSourceTree: candidate.source.treeSha256,
    candidateCaptures: candidate.captures.length,
    defect: {
      kind: 'dark disabled control opacity dimming',
      location: 'src/page/profiles-view.css:216-221 `.pf select:disabled, .pf input:disabled` and :247-253 `.pf-btn:disabled`; the candidate fix sets opacity: 1 there',
      temporaryOverride: '.pf select:disabled, .pf input:disabled, .pf-btn:disabled { opacity: .7 !important; }',
      scope: 'TEMP-only served-page copy; append-only style override in the temp server response; no source or live file changed',
      sourceMutation: false,
    },
    intendedRejection: 'The reviewer must explicitly flag the labelled negative-control frame as expectedFailure: its dark disabled control contrast is below 4.5:1. Exclude it from the unmodified candidate PASS set; the main verdict must use only the candidate frames.',
    reviewerInstruction: 'Flag the negative control as an intentional defect; do not count it as candidate evidence.',
    before: null,
    defective: null,
    capture: null,
    cleanup: null,
    tempRoot: root,
    startedAt: new Date().toISOString(),
  };
  let page = null;
  let server = null;
  let port = null;
  let chromePids = [];
  let failure = null;
  try {
    const homes = seedHomes(root);
    const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
    const store = openProfilesStore({
      primaryHome: homes.primary, stableHome: homes.stable, mirrorHomes: [],
      pluginPath: PLUGIN, inventory, now: () => FIXED_NOW,
    });
    const vm = JSON.parse(fs.readFileSync(VM_FILE, 'utf8'));
    let defective = false;
    const candidateHtml = pageHtml(vm, 7, { mode: 'server', token: TOKEN });
    const buildHash = sha256(Buffer.from(candidateHtml.split(TOKEN).join('<board-token>')));
    assert.equal(buildHash, candidate.build.hash, 'negative control build does not match the candidate captures.json');
    server = createBoardServer({
      portBase: PORT_BASE, portCount: 5, generation: 7, token: TOKEN,
      getPage: ({ nonce } = {}) => {
        const html = pageHtml(vm, 7, { mode: 'server', token: TOKEN, nonce });
        return defective ? html.replace('</style>', NEGATIVE_CSS + '</style>') : html;
      },
      getViewModel: () => vm,
      profilesState: () => store.state(),
      onProfiles: (body) => store.handle(body),
    });
    ({ port } = await server.start());
    const url = `http://127.0.0.1:${port}/`;
    page = await launch({ width: 1024, height: 768 });
    chromePids = [...new Set([page.pid, ...listProfilePids(page.profileDir)])].sort((a, b) => a - b);
    const waitFor = (predicate, what, timeout = 10000) => page.eval(`new Promise((resolve, reject) => {
      const check = () => { try { return (${predicate}); } catch (e) { return null; } };
      const hit = check();
      if (hit) return resolve(hit);
      const observer = new MutationObserver(() => { const value = check(); if (value) { done(); resolve(value); } });
      const timer = setTimeout(() => { done(); reject(new Error(${JSON.stringify('timeout waiting for ' + what)})); }, ${timeout});
      function done() { observer.disconnect(); clearTimeout(timer); }
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    })`);
    const settle = async () => {
      await page.eval(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
      await page.eval(sleepFrame());
      await page.eval(`new Promise((resolve, reject) => {
        const pending = document.getAnimations().filter((a) => {
          const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
          return a.playState === 'running' && !(timing && timing.iterations === Infinity);
        });
        if (!pending.length) return resolve(true);
        let left = pending.length, settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('animation settlement timed out with ' + left + ' still running'));
        }, 2000);
        const done = () => {
          if (settled) return;
          if (--left <= 0) { settled = true; clearTimeout(timer); resolve(true); }
        };
        for (const animation of pending) animation.finished.then(done, done);
      })`);
      await page.eval(sleepFrame());
    };
    const applyDark1024 = async () => {
      await page.client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
      await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
      await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    };
    const openProfiles = async () => {
      await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
      await waitFor(`document.querySelectorAll('.pf-agent').length === 4 && !document.querySelector('.pf-loading')`, 'profiles view');
      await settle();
    };
    const disabledProbe = () => page.eval(`(() => {
      const parse = (value) => {
        const m = /rgba?\\(([^)]+)\\)/.exec(value || '');
        if (!m) return null;
        const p = m[1].split(',').map((x) => Number(x.trim()));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const composite = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
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
      const rows = [...document.querySelectorAll('.pf select:disabled, .pf input:disabled, .pf-btn:disabled')].map((el) => {
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        const bg = background(el);
        const opacity = Number.parseFloat(cs.opacity);
        const color = composite(fg, bg);
        const pixel = opacity === 1 ? color : composite({ ...color, a: opacity }, bg);
        const need = 4.5;
        return { tag: el.tagName.toLowerCase(), pf: el.getAttribute('data-pf') || '', text: (el.textContent || el.value || '').trim().slice(0, 60),
          color: cs.color, background: cs.backgroundColor, opacity, ratio: ratio(color, bg), pixelRatio: ratio(pixel, bg), need,
          pass: ratio(color, bg) >= need && ratio(pixel, bg) >= need };
      });
      return { rows, minRatio: rows.length ? Math.min(...rows.map((r) => r.pixelRatio)) : null,
        pass: rows.length > 0 && rows.every((r) => r.pass) };
    })()`);
    await page.goto(url);
    await waitFor(`!!document.querySelector('[data-shell]')`, 'board shell');
    await openProfiles();
    await applyDark1024();
    await settle();
    const before = await disabledProbe();
    assert.ok(before.rows.length > 0, 'no disabled controls measured in the candidate');
    assert.equal(before.pass, true, 'candidate disabled controls already fail before the control: ' + JSON.stringify(before));
    evidence.before = before;
    // Restore the known defect only in the temp server's page copy.
    defective = true;
    await page.goto(url);
    await waitFor(`!!document.querySelector('[data-shell]')`, 'board shell after the negative-control render');
    await openProfiles();
    await applyDark1024();
    await settle();
    const after = await disabledProbe();
    assert.equal(after.pass, false, 'the negative control was not detected: ' + JSON.stringify(after));
    assert.ok(after.minRatio < 4.5, `defective disabled minimum ${after.minRatio}:1 is not below 4.5`);
    evidence.defective = after;
    await page.eval(`(() => { const el = document.querySelector('.pf select:disabled'); if (el) el.scrollIntoView({ block: 'center' }); return true; })()`);
    await settle();
    const file = path.join(OUT, 'negative-control-dark-disabled-opacity-1024-dark.png');
    // The frame is unmistakably labelled on-image as well as in the filename and captures.json metadata.
    await page.eval(`(() => {
      const label = document.createElement('div');
      label.id = 'qa-negative-control-label';
      label.textContent = 'NEGATIVE CONTROL · EXPECTED FAILURE · NOT CANDIDATE';
      label.style.position = 'fixed';
      label.style.top = '8px';
      label.style.left = '50%';
      label.style.transform = 'translateX(-50%)';
      label.style.zIndex = '99999';
      label.style.padding = '6px 10px';
      label.style.background = '#b3372e';
      label.style.color = '#ffffff';
      label.style.font = '600 13px sans-serif';
      label.style.borderRadius = '6px';
      label.style.pointerEvents = 'none';
      document.body.appendChild(label);
      return true;
    })()`);
    await settle();
    await page.screenshot(file);
    const info = pngInfo(file);
    assert.equal(info.width, 1024, 'negative-control capture width');
    assert.equal(info.height, 768, 'negative-control capture height');
    assert.ok(info.bytes > 8000, 'negative-control capture is too small');
    evidence.capture = {
      file: path.basename(file), width: info.width, height: info.height, bytes: info.bytes,
      sha256: hashFile(file), expectedFailure: true, negativeControl: true, outsidePassMatrix: true,
    };
  } catch (error) {
    failure = String(error && error.stack || error);
    evidence.error = failure;
  } finally {
    if (page) {
      const pid = page.pid;
      const profileDir = page.profileDir;
      try { await page.close(); } catch (error) { evidence.closeError = String(error && error.message || error); }
      const pids = chromePids.filter((p) => p !== pid);
      const alive = pids.filter((p) => isPidAlive(p));
      let profileExists = true;
      try { profileExists = fs.existsSync(profileDir); } catch { profileExists = true; }
      let profilePids = [];
      try { profilePids = listProfilePids(profileDir); } catch { profilePids = []; }
      evidence.cleanup = { ...(evidence.cleanup || {}), chrome: {
        pid, aliveAfterClose: alive, profileExists, profilePidsAfterClose: profilePids,
        closed: !evidence.closeError && alive.length === 0 && !profileExists && profilePids.length === 0,
      } };
    }
    if (server) {
      try { await server.close(); } catch (error) { evidence.serverCloseError = String(error); }
    }
    let portClosed = false;
    if (port) {
      portClosed = await new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.setTimeout(3000, () => { socket.destroy(); resolve(false); });
        socket.once('connect', () => { socket.destroy(); resolve(false); });
        socket.once('error', (error) => resolve(error.code === 'ECONNREFUSED'));
      });
    }
    const liveAfter = liveState();
    const hashesUnchanged = JSON.stringify(liveAfter.hashes) === JSON.stringify(liveBefore.hashes);
    const serverUnchanged = JSON.stringify(liveAfter.server) === JSON.stringify(liveBefore.server);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      evidence.tempRootRemoved = !fs.existsSync(root);
    } catch (error) {
      evidence.tempRootRemoved = false;
      evidence.tempRemoveError = String(error);
    }
    evidence.cleanup = { ...(evidence.cleanup || {}), server: { port, closed: portClosed },
      tempRootRemoved: evidence.tempRootRemoved,
      live: { hashesUnchanged, serverJsonUnchanged: serverUnchanged,
        liveStateInvariantHolds: liveAfter.liveAgentDirsWithPrimaryAgents.length === 0 && liveAfter.gateAdapterMarkerInLiveOmoTask !== true,
        hashes: liveAfter.hashes } };
    evidence.finishedAt = new Date().toISOString();
    evidence.ok = !failure && evidence.before?.pass === true && evidence.defective?.pass === false
      && !!evidence.capture && evidence.cleanup.chrome?.closed === true && evidence.cleanup.server?.closed === true
      && evidence.cleanup.tempRootRemoved === true && hashesUnchanged && serverUnchanged;
    evidence.result = evidence.ok ? 'PASS (the control was detected as an expected failure)' : 'FAIL';
    candidate.negativeControl = evidence;
    fs.writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
    const lines = [
      'piomo-primary-agents todo 22 - negative control (expected failure)',
      `run: ${evidence.startedAt} .. ${evidence.finishedAt}`,
      `candidate build: ${evidence.candidateBuildHash}; source tree ${evidence.candidateSourceTree}; candidate captures ${evidence.candidateCaptures} (normal PASS matrix)`,
      `control: ${evidence.defect.kind}; ${evidence.defect.scope}`,
      `exact defect location: ${evidence.defect.location}`,
      `temporary override: ${evidence.defect.temporaryOverride}`,
      `before (candidate): pass ${evidence.before?.pass}; min pixelRatio ${evidence.before?.minRatio}; rows ${JSON.stringify(evidence.before?.rows || [])}`,
      `defective (control): pass ${evidence.defective?.pass}; min pixelRatio ${evidence.defective?.minRatio}; rows ${JSON.stringify(evidence.defective?.rows || [])}`,
      `capture: ${evidence.capture?.file || '(missing)'} (expectedFailure=true, negativeControl=true, outsidePassMatrix=true; ${evidence.capture?.width}x${evidence.capture?.height}, ${evidence.capture?.sha256 || ''})`,
      `intended rejection: ${evidence.intendedRejection}`,
      `cleanup: ${JSON.stringify(evidence.cleanup || {})}`,
      `result: ${evidence.result}`,
    ];
    if (failure) lines.push(`ERROR ${failure}`);
    fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}-negative.txt`), lines.join('\n') + '\n');
  }
  if (!evidence.ok) {
    console.error('FAIL negative control: ' + (failure || JSON.stringify(evidence)));
    process.exit(1);
  }
  console.log(`PASS negative control: candidate ${evidence.before.minRatio}:1, defective ${evidence.defective.minRatio}:1, capture ${evidence.capture.file}`);
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
  e2e.push(`piomo-primary-agents todo ${TASK} - board profiles guarded write e2e`);
  e2e.push(`run: ${run.startedAt} .. ${run.finishedAt}`);
  e2e.push(`build: served page sha256 ${run.build?.hash} (${run.build?.pageBytes} B), BWT HEAD ${gitHead()}`);
  e2e.push(`source tree sha256 ${run.source?.treeSha256}; files ${JSON.stringify(run.source?.files || [])}`);
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
  e2e.push(`select fit 1024: ${JSON.stringify(run.checks.selectFit1024 || null)}`);
  e2e.push(`select fit 390: ${JSON.stringify(run.checks.selectFit390 || null)}`);
  e2e.push(`added states: ${JSON.stringify(run.checks.addedStates || null)}`);
  e2e.push(`interrupted journal: ${JSON.stringify(run.checks.journal || null)}`);
  e2e.push(`copy 390: ${JSON.stringify(run.checks.copy390 || null)}`);
  e2e.push(`loading frame: ${JSON.stringify(run.checks.loading || null)}`);
  e2e.push(`loading geometry: ${JSON.stringify(run.checks.loadingGeometry || null)}`);
  e2e.push(`viewport probes: ${JSON.stringify(run.checks.byViewport || null)}`);
  e2e.push(`pressed frames: ${JSON.stringify(run.checks.presses || null)}`);
  e2e.push(`focus frames: ${JSON.stringify(run.checks.focus || null)}`);
  e2e.push(`capture set: ${JSON.stringify(run.checks.captureSet || null)}; dimensions ${JSON.stringify(run.checks.captureDimensions || null)}`);
  e2e.push(`targeted rows: ${JSON.stringify(run.checks.targeted || null)}`);
  e2e.push(`end scroll: ${JSON.stringify(run.checks.endScroll || null)}`);
  e2e.push(`clear confirmation: ${JSON.stringify(run.checks.clearConfirm || null)}; cancel ${JSON.stringify(run.checks.clearCancel || null)}; confirmed ${JSON.stringify(run.checks.clearConfirmed || null)}`);
  e2e.push(`conflict actions: ${JSON.stringify(run.checks.conflictActions || null)}; recovery ${JSON.stringify(run.checks.conflictRecovery || null)}`);
  e2e.push(`negative controls: ${JSON.stringify(run.checks.negativeControls || null)}`);
  e2e.push(`error frame: ${JSON.stringify(run.checks.error || null)}`);
  e2e.push(`390 loading bounds: ${JSON.stringify(run.checks.loadingBounds || null)}`);
  e2e.push(`390 error bounds: ${JSON.stringify(run.checks.errorBounds || null)}`);
  e2e.push(`reduced motion: ${JSON.stringify(run.checks.reducedMotion || null)}`);
  e2e.push(`offline retry: ${JSON.stringify(run.checks.offlineRetry || null)}`);
  e2e.push(`empty data: ${JSON.stringify(run.checks.empty || null)}`);
  e2e.push(`hover: ${JSON.stringify(run.checks.hover || null)}`);
  e2e.push(`desktop prose: 1440 ${JSON.stringify(run.checks.prose1440 || null)}; 1024 ${JSON.stringify(run.checks.prose1024 || null)}`);
  e2e.push(`focus busy preview: ${JSON.stringify(run.checks.focusBusyPreview || null)}; after ${JSON.stringify(run.checks.focusAfterPreview || null)}`);
  e2e.push(`focus busy apply: ${JSON.stringify(run.checks.focusBusyApply || null)}; after ${JSON.stringify(run.checks.focusAfterApply || null)}`);
  e2e.push(`journal reapply success: ${JSON.stringify(run.checks.journalReapplySuccess || null)}`);
  e2e.push(`journal reapply 409: ${JSON.stringify(run.checks.journalReapplyConflict || null)}`);
  e2e.push(`rail scope: ${JSON.stringify(run.checks.railScope || null)}`);
  e2e.push(`sibling shell: ${JSON.stringify(run.checks.siblingShell || null)}; unpeek fallbacks ${run.checks.peekFallback || 0}`);
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
  const coverageSummary = Object.fromEntries(Object.entries(run.checks.sectionCoverage || {}).map(([k, v]) => [
    k, Object.fromEntries(Object.entries(v).map(([sk, sv]) => [sk, { slices: sv.sliceCount, continuous: sv.continuous, gaps: sv.gaps }])),
  ]));
  e2e.push(`section coverage: ${JSON.stringify(coverageSummary)}`);
  e2e.push(`duplicate captures (same bottom viewport): ${JSON.stringify(run.checks.duplicateCaptures || [])}`);
  e2e.push(`console errors: ${JSON.stringify(run.checks.consoleErrors || [])}`);
  e2e.push(`captures: ${run.captures.length} (${run.captures.map((c) => c.file).join(', ')})`);
  e2e.push(`cleanup: ${JSON.stringify(run.cleanup)}`);
  e2e.push(`live before: ${JSON.stringify(run.liveBefore)}`);
  e2e.push(`live after:  ${JSON.stringify(run.liveAfter)}`);
  e2e.push(`result: ${run.ok ? 'PASS' : 'FAIL'}`);
  if (run.errors.length) e2e.push(...run.errors.map((e) => `ERROR ${e}`));
  fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}-e2e.txt`), e2e.join('\n') + '\n');

  stale.push(`piomo-primary-agents todo ${TASK} - stale apply 409`);
  stale.push(`before edit: ${JSON.stringify(run.stale?.before || null)}`);
  stale.push(`mutation: appended CRLF to temp omo.jsonc -> ${run.stale?.mutatedOmo}`);
  stale.push(`apply answer: HTTP ${run.stale?.httpStatus} (${run.stale?.conflictText || ''})`);
  stale.push(`after 409: ${JSON.stringify(run.stale?.after || null)}`);
  stale.push(`backups unchanged: ${run.stale?.backupsUnchanged}; journal unchanged: ${run.stale?.journalUnchanged}; roster unchanged: ${run.stale?.rosterUnchanged}`);
  stale.push(`result: ${run.stale?.httpStatus === 409 && run.stale?.backupsUnchanged && run.stale?.journalUnchanged && run.stale?.rosterUnchanged ? 'PASS' : 'FAIL'}`);
  fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}-stale.txt`), stale.join('\n') + '\n');

  const a11y = run.checks.a11y || {};
  const a11yLines = [
    'piomo-primary-agents todo ' + TASK + ' - profiles view accessible names (fixed build)',
    `build: served page sha256 ${run.build?.hash} (${run.build?.pageBytes} B)`,
    `source: src/page/profiles-view.js sha256 ${sha256(fs.readFileSync(path.join(ROOT, 'src/page/profiles-view.js')))}`,
    `controls total ${a11y.controls ?? '?'}`,
    `selects total ${a11y.selects ?? '?'}`,
    `controls without accessible name ${a11y.unnamed?.length ?? '?'}`,
    `selects without a visible label ${a11y.selectsWithoutVisibleLabel?.length ?? '?'}`,
    `per-control label mismatches ${a11y.wrongLabels?.length ?? '?'}`,
    `header 390: ${JSON.stringify(run.checks.header390 || null)}`,
    `rail contrast: ${JSON.stringify((run.checks.byViewport && run.checks.byViewport['390-light'] && run.checks.byViewport['390-light'].rail) || null)}`,
    `pressed states: ${JSON.stringify(run.checks.presses || null)}`,
    `focus states: ${JSON.stringify(run.checks.focus || null)}`,
    `phone targets: ${JSON.stringify((run.checks.byViewport && run.checks.byViewport['390-light'] && run.checks.byViewport['390-light'].controls) || null)}`,
    `labels: ${JSON.stringify(a11y.sample || [])}`,
    `result: ${run.checks.a11y && run.checks.a11y.unnamed?.length === 0
      && run.checks.a11y.selectsWithoutVisibleLabel?.length === 0 && run.checks.a11y.wrongLabels?.length === 0
      && run.checks.header390?.lines === 1 ? 'PASS' : 'FAIL'}`,
  ];
  fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}-a11y.txt`), a11yLines.join('\n') + '\n');

  const cspPayload = `${JSON.stringify(run.csp || { installedBeforeFirstNavigation: false, violations: [] }, null, 2)}\n`;
  fs.writeFileSync(path.join(OUT, 'csp.json'), cspPayload);
  if (path.resolve(EVIDENCE) !== path.resolve(OUT)) {
    fs.writeFileSync(path.join(EVIDENCE, 'csp.json'), cspPayload);
  }
  fs.writeFileSync(path.join(OUT, 'captures.json'), `${JSON.stringify(run, null, 2)}\n`);
}

// ── todo 9 of plan switcher-flow-restore: the support gate and the three WinForms tasks through the real page ───────
// --gate      <out>/gate.json: role row, main, summarizer, Kibitzer and Reflection against a fixture registry where
//             opencode/gemini-4-argon is served=false; <out>/gate-flip.json: the same pick with it served=true.
// --flow-e2e  <evidence>/e2e.json + e2e.md: the role, profile and memory tasks at 1180x700 and 1600x900 with
//             scripts/qa-flow-map.mjs's picks. The bytes written must equal the store's own output for the posted apply
//             body on an identical seed, the golden where a scenario exists, and a behind-the-page edit must answer 409
//             with no write.
// Homes are seeded under %TEMP%/omo-switcher-tests/ like qa-flow-map.mjs (goldens + the registry fixture). The gate's
// fixture registry is the real composition of test/fixtures/profiles/registry handed to the store's `registries`
// option, so one model can be withheld without a new flag.
const FLOW_REGISTRY = path.join(ROOT, 'test/fixtures/profiles/registry');
const PROFILE_FIXTURES = path.join(ROOT, 'test/fixtures/profiles');
const FIXTURE_PARENT = path.join(os.tmpdir(), 'omo-switcher-tests');
const LIVE_HOMES = ['C:/Users/USER/.omo', 'C:/Users/USER/.omo-stable-500/home/.omo', 'C:/Users/USER/.omo-original/home/.omo', 'C:/Users/USER/.somo/home/.omo'];
const FLOW_TASKS = {
  role: ['card:experimental-custom', 'role:agents/explore:service', 'role:agents/explore:model', 'role:agents/explore:effort', 'apply:detail'],
  profile: ['apply:card:gpt-deepseek'],
  memory: ['memory:kibitzer:mode', 'memory:kibitzer:service', 'memory:kibitzer:model', 'memory:kibitzer:effort', 'apply:detail'],
};
const FLOW_SIZES = [{ name: '1180x700', width: 1180, height: 700 }, { name: '1600x900', width: 1600, height: 900 }];
const ARGON_OPENCODE = 'opencode/gemini-4-argon';
const ARGON_ANTIGRAVITY = 'antigravity-ocx/google-antigravity/gemini-4-argon';
const ARGON_ALIASES = {
  'qa-argon-opencode': { model: ARGON_OPENCODE, variant: 'high' },
  'qa-argon-antigravity': { model: ARGON_ANTIGRAVITY, variant: 'high' },
};
const ARGON_SERVICE = { opencode: 'opencode', antigravity: 'antigravity-ocx' };
// The five editors of the gate. main keeps a provider plus a provider-less model id; the others keep a full model id.
const GATE_EDITORS = {
  role: { row: '[data-pf-route="agents/explore"]', service: '[data-flow="role:agents/explore:service"]',
    model: '[data-flow="role:agents/explore:model"]', effort: '[data-flow="role:agents/explore:effort"]',
    opencode: ARGON_OPENCODE, antigravity: ARGON_ANTIGRAVITY },
  main: { row: '#pf-sec-main', service: '[data-pf="main-provider"]', model: '[data-pf="main-model"]',
    effort: '[data-pf="main-thinking"]', opencode: 'gemini-4-argon', antigravity: 'google-antigravity/gemini-4-argon' },
  summarizer: { row: '#pf-sec-summarizer', service: '[data-pf="summarizer-provider"]', model: '[data-pf="summarizer-model"]',
    effort: null, opencode: ARGON_OPENCODE, antigravity: ARGON_ANTIGRAVITY },
  kibitzer: { row: '[data-flow-sec="kibitzer"]', mode: '[data-flow="memory:kibitzer:mode"]',
    service: '[data-flow="memory:kibitzer:service"]', model: '[data-flow="memory:kibitzer:model"]',
    effort: '[data-flow="memory:kibitzer:effort"]', opencode: ARGON_OPENCODE, antigravity: ARGON_ANTIGRAVITY },
  reflection: { row: '[data-flow-sec="reflection"]', mode: '[data-flow="memory:reflection:mode"]',
    service: '[data-flow="memory:reflection:service"]', model: '[data-flow="memory:reflection:model"]',
    effort: '[data-flow="memory:reflection:effort"]', opencode: ARGON_OPENCODE, antigravity: ARGON_ANTIGRAVITY },
};
// Golden file name -> path under a fixture root (the test/fixtures/profiles/capture.ps1 layout).
const GOLDEN_SEED_FILES = {
  'primary/omo.jsonc': 'primary/omo.jsonc',
  'primary/settings.json': 'primary/agent/settings.json',
  'primary/selection.json': 'primary/native-profile-selection.json',
  'primary/agent-selection.json': 'primary/agent/native-profile-selection.json',
  'primary/main-override.json': 'primary/runtime/native-profile-switcher-main.json',
  'stable/omo.jsonc': 'stable/omo.jsonc',
  'stable/settings.json': 'stable/agent/settings.json',
};
// PS also writes these on apply, but the store does not own them, so the board must leave the seed there:
// settings.defaultThinkingLevel (PS:3540; plan D13, the main effort stays in the sidecar, store.mjs
// SETTINGS_ALLOWED_PATHS) and all of stable-500 agent/settings.json (PS:3773; never a store target,
// piomo-primary-agents plan). test/profiles-store.test.mjs pins both. null = the whole file.
const SEED_KEPT = { 'primary/settings.json': ['defaultThinkingLevel'], 'stable/settings.json': null };
const GOLDEN_RUNS = [
  { task: 'profile', seed: 'goldens/dump-state', golden: 'goldens/apply-gpt-deepseek', steps: [['apply:card:gpt-deepseek', null]] },
  { task: 'memory', seed: 'goldens-r3a/intent-main-dryrun', golden: 'goldens-r3a/intent-memory-custom-apply',
    steps: [['memory:kibitzer:mode', 'custom'], ['memory:kibitzer:service', 'openai'], ['memory:kibitzer:model', 'openai/gpt-6-sol'],
      ['memory:kibitzer:effort', 'high'], ['apply:detail', null]] },
  // IS-7 names main as well, and no PS main golden is drivable through the page: goldens-r3a/intent-main-apply is
  // activate:false on gpt-kimi-deepseek while its seed has experimental-custom active (the page applies an edit with the
  // shown profile activated, IS-10), and its model opencode-go/deepseek-v4-flash is no longer served by the installed
  // engine, so the page keeps it disabled (IS-6). This run's golden is generated instead (mainOnShownProfile).
  { task: 'main', seed: 'goldens-r3a/intent-main-dryrun', golden: 'validated layer (runScenario)', shownProfileMain: true },
];
const ROLE_GOLDEN_GAP = 'every routing golden is activate:false on gpt-kimi-deepseek while its seed (dump-state) has cmd-glm-deepseek '
  + 'active, and the page applies a role edit together with activating the shown profile (IS-10), so no golden scenario matches';
// Config files whose saved values the gate follows byte for byte.
const SAVED_FILES = ['primary/omo.jsonc', 'primary/agent/settings.json', 'primary/runtime/native-profile-switcher-main.json', 'stable/omo.jsonc'];
const APPLY_SETTLED = `(document.querySelector('[data-pf-result="apply"]') || document.querySelector('.pf-tray .pf-err') ||
  document.querySelector('.pf-conflict') || /실패/.test((document.querySelector('[data-flow="message"]') || {}).textContent || ''))
  && document.querySelector('[data-pf-root]').getAttribute('data-pf-busy') === 'false'`;
// Page-side helpers, installed once per document.
const QA9_LIB = `(() => {
  const q = (sel) => document.querySelector(sel);
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const snap = () => window.BriefPage && window.BriefPage.state.ui.profilesState;
  const opt = (o) => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled, title: o.title || '', selected: o.selected });
  window.__qa9 = {
    reach(sel) { const el = q(sel); if (!el) return null; el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); return box(el); },
    options(sel) { const el = q(sel); return el && el.options ? [...el.options].map(opt) : null; },
    value(sel) { const el = q(sel); return el ? el.value : null; },
    selected(sel) {
      const el = q(sel);
      if (!el || !el.options) return null;
      const o = el.options[el.selectedIndex];
      return { value: o ? o.value : '', text: o ? o.textContent.trim() : '', disabled: el.disabled };
    },
    choose(sel, value) { const el = q(sel); if (!el) return null; el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; },
    // A forged pick: a missing option is added, a disabled option or select enabled, then the real change handler runs.
    force(sel, value) {
      const el = q(sel);
      if (!el) return { missing: true };
      let o = [...el.options].find((x) => x.value === value);
      const added = !o;
      if (!o) { o = document.createElement('option'); o.value = value; o.textContent = value; el.appendChild(o); }
      const wasDisabled = o.disabled, selectWasDisabled = el.disabled;
      o.disabled = false;
      el.disabled = false;
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: el.value, added, wasDisabled, selectWasDisabled };
    },
    click(sel) { q(sel).click(); return true; },
    pending() { return (snap() && snap().pending || []).map((c) => JSON.parse(JSON.stringify(c))); },
    text(sel) { const el = q(sel); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null; },
    flagIn(sel) {
      const el = q(sel);
      if (!el) return null;
      const m = /(미지원|지원되지|지원 안|지원 불가|제공되지|unsupported|UNSUPPORTED_MODEL)/i.exec(el.textContent);
      return m ? m[0] : '';
    },
    rowFlag(section, role) {
      const rows = snap() && snap().view && snap().view.routing && snap().view.routing.rows || [];
      const r = rows.find((x) => x.section === section && x.role === role);
      return r ? { unsupported: !!r.unsupported, reason: r.unsupportedReason || null, home: r.unsupportedHome || null } : null;
    },
    // Providers with a catalog model served in every required home (the view's own rule), as qa-flow-map picks them.
    servedProviders() {
      const view = snap() && snap().view || {};
      if (view.registry && Array.isArray(view.registry.unknownHomes) && view.registry.unknownHomes.length) return [];
      const out = [];
      for (const e of Object.values(view.catalog || {})) {
        if (!e || typeof e.model !== 'string' || e.model.indexOf('/') <= 0) continue;
        const s = e.served;
        if (s && !(Object.keys(s).length && Object.values(s).every((v) => v === true))) continue;
        const p = e.model.slice(0, e.model.indexOf('/'));
        if (!out.includes(p)) out.push(p);
      }
      return out;
    },
  };
  return true;
})()`;

const slashPath = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
// The Assert-FixtureRootIsSafe rule (capture.ps1:70): a root that is, contains or sits inside a live home is refused.
function assertFixtureRoot(root) {
  const r = slashPath(root);
  for (const home of LIVE_HOMES.map(slashPath)) {
    if (r === home || r.startsWith(home + '/') || home.startsWith(r + '/')) throw new Error(`fixture root ${root} touches live home ${home}`);
  }
}

// The qa-flow-map.mjs seed: the apply-gpt-kimi-deepseek golden files plus the registry fixture.
function seedFlowHomes(root) {
  assertFixtureRoot(root);
  const primary = path.join(root, 'primary');
  const stable = path.join(root, 'stable');
  fs.mkdirSync(path.join(primary, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(stable, 'agent'), { recursive: true });
  const put = (file, value) => fs.writeFileSync(file, formatJsonText(value, PS_STYLE));
  const golden = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN, name), 'utf8'));
  put(path.join(primary, 'omo.jsonc'), golden('primary/omo.jsonc.json'));
  put(path.join(primary, 'agent', 'settings.json'), golden('primary/settings.json.json'));
  put(path.join(primary, 'native-profile-selection.json'), { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' });
  put(path.join(primary, 'agent', 'native-profile-selection.json'), { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' });
  put(path.join(stable, 'omo.jsonc'), golden('stable/omo.jsonc.json'));
  fs.writeFileSync(path.join(stable, 'agent', 'settings.json'), '{"packages":["stable"]}');
  fs.copyFileSync(path.join(FLOW_REGISTRY, 'primary/agent/models.json'), path.join(primary, 'agent', 'models.json'));
  fs.copyFileSync(path.join(FLOW_REGISTRY, 'stable/agent/models.json'), path.join(stable, 'agent', 'models.json'));
  return { root, primary, stable };
}

// The golden catalog has no Argon alias, so neither Argon could appear in any editor without these two.
function addArgonAliases(homes) {
  const file = path.join(homes.primary, 'omo.jsonc');
  const config = readJsonc(file);
  Object.assign((config['[senpi]'] ?? config['[native]']).models, ARGON_ALIASES);
  fs.writeFileSync(file, formatJsonText(config, PS_STYLE));
}

function goldenFile(scenarioDir, name) {
  const file = path.join(scenarioDir, 'files', name + '.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// The golden as the store's write contract expects it: a seed-kept file is the seed, a seed-kept key keeps the seed's value.
function storeContractGolden(name, seed, golden) {
  if (!Object.hasOwn(SEED_KEPT, name)) return golden;
  if (SEED_KEPT[name] === null) return seed;
  const expected = { ...golden };
  for (const key of SEED_KEPT[name]) {
    if (seed && Object.hasOwn(seed, key)) expected[key] = seed[key];
    else delete expected[key];
  }
  return expected;
}

function seedGoldenHomes(root, scenarioDir) {
  assertFixtureRoot(root);
  for (const [name, rel] of Object.entries(GOLDEN_SEED_FILES)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const value = goldenFile(scenarioDir, name);
    if (value !== null) fs.writeFileSync(file, formatJsonText(value, PS_STYLE));
  }
  for (const home of ['primary', 'stable']) {
    fs.copyFileSync(path.join(FLOW_REGISTRY, home, 'agent', 'models.json'), path.join(root, home, 'agent', 'models.json'));
  }
  return { root, primary: path.join(root, 'primary'), stable: path.join(root, 'stable') };
}

// The real composition of the fixture homes; served=false withholds opencode/gemini-4-argon in every home.
function fixtureRegistries(homes, served) {
  const out = {};
  for (const home of ['primary', 'stable']) {
    const registry = composeHomeRegistry(path.join(homes[home], 'agent'));
    if (registry.unknown) throw new Error(`registry composition failed for the ${home} fixture home`);
    out[home] = served ? registry : { ...registry, models: registry.models.filter((m) => m.modelId !== ARGON_OPENCODE) };
  }
  return out;
}

function registrySummary(registries) {
  return Object.fromEntries(Object.entries(registries).map(([home, registry]) => {
    const served = getServedModelIds(registry);
    return [home, { models: registry.models.length, [ARGON_OPENCODE]: served.has(ARGON_OPENCODE), [ARGON_ANTIGRAVITY]: served.has(ARGON_ANTIGRAVITY) }];
  }));
}

function treeBytes(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else out[path.relative(root, file).replace(/\\/g, '/')] = fs.readFileSync(file);
    }
  };
  walk(root);
  return out;
}

const treeChanges = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  .filter((file) => !before[file] || !after[file] || !before[file].equals(after[file]));

function openFixtureStore(homes, registries = null) {
  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  return openProfilesStore({
    primaryHome: homes.primary, stableHome: homes.stable, mirrorHomes: [], pluginPath: PLUGIN, inventory,
    now: () => FIXED_NOW, ...(registries ? { registries } : {}),
  });
}

// The real board over fixture homes. Every POST /profiles answer is recorded; nextExchange() resolves on the next one
// within a deadline, so a click is followed by the server's answer instead of a sleep.
async function startFixtureBoard(homes, registries = null) {
  const store = openFixtureStore(homes, registries);
  const vm = JSON.parse(fs.readFileSync(VM_FILE, 'utf8'));
  const exchanges = [];
  const waiters = [];
  const server = createBoardServer({
    portBase: PORT_BASE, portCount: 5, generation: 7, token: TOKEN,
    getPage: ({ nonce } = {}) => pageHtml(vm, 7, { mode: 'server', token: TOKEN, nonce }),
    getViewModel: () => vm,
    profilesState: () => store.state(),
    onProfiles: (body) => {
      const answer = store.handle(body);
      const record = { request: JSON.parse(JSON.stringify(body)), status: answer.status, code: answer.json?.code ?? null };
      exchanges.push(record);
      for (const resolve of waiters.splice(0)) resolve(record);
      return answer;
    },
  });
  const { port } = await server.start();
  const nextExchange = (timeout = 12000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for POST /profiles')), timeout);
    waiters.push((record) => { clearTimeout(timer); resolve(record); });
  });
  return { url: `http://127.0.0.1:${port}/`, port, server, store, exchanges, nextExchange };
}

// The page-side deadline stays under scripts/cdp.mjs's 15 s call deadline, so a miss names what was awaited.
function waitIn(page, predicate, what, timeout = 12000) {
  return page.eval(`new Promise((resolve, reject) => {
    const check = () => { try { return (${predicate}); } catch (e) { return null; } };
    const hit = check();
    if (hit) return resolve(hit);
    const observer = new MutationObserver(() => { const value = check(); if (value) { done(); resolve(value); } });
    const timer = setTimeout(() => { done(); reject(new Error(${JSON.stringify('timeout waiting for ' + what)})); }, ${timeout});
    function done() { observer.disconnect(); clearTimeout(timer); }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  })`);
}

async function settleIn(page) {
  await page.eval(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
  await page.eval(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  await page.eval(`Promise.all(document.getAnimations().filter((a) => a.playState === 'running' &&
    !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity)).map((a) => a.finished.catch(() => null))).then(() => true)`);
  await page.eval(`new Promise((resolve) => requestAnimationFrame(() => resolve(true)))`);
}

async function openProfilesScreen(page, url) {
  await page.goto(url);
  await page.eval(QA9_LIB);
  await waitIn(page, `document.querySelector('[data-sh="view"][data-key="profiles"]')`, 'board shell');
  const docked = await page.eval(`(() => { const s = document.querySelector('.sh-shell');
    return !!s && s.getAttribute('data-side') === 'open' && !matchMedia('(max-width: 899px)').matches; })()`);
  if (!docked) {
    await page.eval(`document.querySelector('.sh-topen').click()`);
    await waitIn(page, `document.querySelector('.sh-shell').getAttribute('data-side') === 'open'`, 'docked sidebar');
  }
  await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
  await waitIn(page, `document.querySelector('[data-pf-root]') && document.querySelector('[data-pf-root]').getAttribute('data-pf-state') === 'view'
    && document.querySelector('[data-flow="apply:detail"]')`, 'profiles view');
  await settleIn(page);
}

async function withBoard(page, homes, registries, fn) {
  const board = await startFixtureBoard(homes, registries);
  try {
    await openProfilesScreen(page, board.url);
    return await fn(board);
  } finally {
    await board.server.close();
  }
}

async function chooseIn(page, sel, value) {
  await page.eval(`window.__qa9.reach(${JSON.stringify(sel)})`);
  const picked = await page.eval(`window.__qa9.choose(${JSON.stringify(sel)}, ${JSON.stringify(value)})`);
  await settleIn(page);
  return picked;
}

async function forceIn(page, sel, value) {
  await page.eval(`window.__qa9.reach(${JSON.stringify(sel)})`);
  const forced = await page.eval(`window.__qa9.force(${JSON.stringify(sel)}, ${JSON.stringify(value)})`);
  await settleIn(page);
  return { select: sel, wanted: value, ...forced };
}

async function applyIn(page, board, sel = '[data-flow="apply:detail"]') {
  await page.eval(`window.__qa9.reach(${JSON.stringify(sel)})`);
  await settleIn(page);
  const answered = board.nextExchange();
  await page.eval(`window.__qa9.click(${JSON.stringify(sel)})`);
  const exchange = await answered;
  await waitIn(page, APPLY_SETTLED, 'apply result');
  await waitIn(page, `document.querySelector('[data-flow="apply:detail"]')`, 'reload after apply');
  await settleIn(page);
  const shown = await page.eval(`(() => ({ ok: !!document.querySelector('[data-pf-result="apply"]'), conflict: !!document.querySelector('.pf-conflict'),
    message: ((document.querySelector('[data-flow="message"]') || {}).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400) }))()`);
  return { exchange: { status: exchange.status, code: exchange.code, changes: exchange.request.changes }, page: shown };
}

// One flow step with qa-flow-map.mjs's picks: reach the control, then do what the owner does there.
async function flowStep(page, board, id) {
  const sel = `[data-flow="${id}"]`;
  if (!(await page.eval(`window.__qa9.reach(${JSON.stringify(sel)})`))) return { control: id, missing: true };
  await settleIn(page);
  if (id.startsWith('card:')) {
    await page.eval(`window.__qa9.click(${JSON.stringify(sel)})`);
    await waitIn(page, `document.querySelector(${JSON.stringify(sel)}).getAttribute('aria-pressed') === 'true'`, id + ' shown');
    await settleIn(page);
    return { control: id };
  }
  if (id.startsWith('apply:')) {
    const applied = await applyIn(page, board, sel);
    return { control: id, status: applied.exchange.status, code: applied.exchange.code, ok: applied.page.ok };
  }
  const current = await page.eval(`window.__qa9.value(${JSON.stringify(sel)})`);
  const options = (await page.eval(`window.__qa9.options(${JSON.stringify(sel)})`) || []).filter((o) => o.value);
  let pick;
  if (id.endsWith(':mode')) pick = 'custom';
  else if (id.endsWith(':service')) {
    const served = await page.eval(`window.__qa9.servedProviders()`);
    pick = (options.find((o) => o.value !== current && (id.startsWith('memory:') || served.includes(o.value))) || {}).value;
  } else if (id.endsWith(':model')) pick = (options.find((o) => o.value !== current) || options[0] || {}).value;
  else pick = (options[options.length - 1] || {}).value;
  await chooseIn(page, sel, pick || '');
  return { control: id, from: current, picked: pick };
}

// The apply journal names its run (`<now>-<random>`) and the absolute backup paths, so two fixture roots never share
// its bytes: it is compared with the root replaced by <root> and the run id's random suffix folded. Every other file
// is compared byte for byte.
const JOURNAL_FILE = 'stable/agent/primary-agents/apply-journal.json';
function journalText(bytes, root) {
  const escapedRoot = JSON.stringify(path.resolve(root)).slice(1, -1);
  return bytes.toString('utf8').split(escapedRoot).join('<root>').replace(/("id":\s*"[^"]*-)[0-9a-f]{8}"/, '$1<random>"');
}

// The store's own output: the posted apply body on an identically seeded home, no browser involved.
function replayThroughStore(homes, body, browser) {
  if (!body) return { ok: false, reason: 'the page posted no apply body' };
  const store = openFixtureStore(homes);
  const state = store.state();
  const sameInputs = JSON.stringify(state.targets) === JSON.stringify(body.expected) && state.roster.revision === body.rosterRevision;
  const answer = store.handle(JSON.parse(JSON.stringify(body)));
  const tree = treeBytes(homes.root);
  const differing = treeChanges(browser.tree, tree);
  const journalFolded = differing.includes(JOURNAL_FILE) && !!browser.tree[JOURNAL_FILE] && !!tree[JOURNAL_FILE]
    && journalText(browser.tree[JOURNAL_FILE], browser.root) === journalText(tree[JOURNAL_FILE], homes.root);
  const mismatches = differing.filter((file) => !(file === JOURNAL_FILE && journalFolded));
  return { ok: answer.status === 200 && sameInputs && mismatches.length === 0, status: answer.status, code: answer.json?.code ?? null,
    sameInputs, files: Object.keys(tree).length, byteEqual: Object.keys(tree).length - differing.length, journalFolded, mismatches };
}

// Raw text of every value in a JSON document by path, so "byte for byte" compares bytes on disk, not parsed values.
function jsonSpans(text) {
  const spans = new Map();
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const space = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const string = () => { const start = i++; while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1; i++; return JSON.parse(text.slice(start, i)); };
  const value = (at) => {
    space();
    const start = i;
    if (text[i] === '{') {
      i++; space();
      if (text[i] === '}') i++;
      else for (;;) { space(); const key = string(); space(); i++; value([...at, key]); space(); if (text[i++] === '}') break; }
    } else if (text[i] === '[') {
      i++; space();
      if (text[i] === ']') i++;
      else for (let n = 0; ; n++) { value([...at, n]); space(); if (text[i++] === ']') break; }
    } else if (text[i] === '"') string();
    else while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    spans.set(JSON.stringify(at), text.slice(start, i));
  };
  value([]);
  return spans;
}

function changedJsonPaths(a, b, at = [], out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) changedJsonPaths(a[key], b[key], [...at, key], out);
  } else out.push(at);
  return out;
}

// The parity tests' canonical form: sorted keys, volatile stamps folded.
const VOLATILE_KEYS = new Set(['appliedAt']);
const canonicalJson = (v) => (Array.isArray(v) ? v.map(canonicalJson) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, VOLATILE_KEYS.has(k) ? '<volatile>' : canonicalJson(v[k])])) : v);

function canonicalDiffs(actual, expected, at = '$', out = []) {
  if (JSON.stringify(canonicalJson(actual)) === JSON.stringify(canonicalJson(expected))) return out;
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object' && !Array.isArray(actual) && !Array.isArray(expected)) {
    for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) canonicalDiffs(actual[key], expected[key], at + '.' + key, out);
  } else out.push({ path: at, actual: actual === undefined ? '(absent)' : actual, expected: expected === undefined ? '(absent)' : expected });
  return out;
}

async function closeQaChrome(page, pids) {
  if (!page) return { closed: false, reason: 'Chrome was not launched' };
  let error = null;
  try { await page.close(); } catch (e) { error = String(e && e.message || e); }
  const alive = pids.filter((pid) => isPidAlive(pid));
  return { closed: !error && alive.length === 0 && !fs.existsSync(page.profileDir), error, alive };
}

function removeTempRoot(root) {
  if (KEEP) return { kept: root };
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { removed: !fs.existsSync(root) };
}

// The opencode Argon as offered by one editor: its service, then the model option and any reason shown with it.
async function gateOffer(page, editor, which) {
  if (editor.mode) await chooseIn(page, editor.mode, 'custom');
  const service = ARGON_SERVICE[which];
  const services = await page.eval(`window.__qa9.options(${JSON.stringify(editor.service)})`) || [];
  const serviceOffered = services.some((o) => o.value === service && !o.disabled);
  if (serviceOffered) await chooseIn(page, editor.service, service);
  const models = await page.eval(`window.__qa9.options(${JSON.stringify(editor.model)})`) || [];
  const option = models.find((o) => o.value === editor[which]) || null;
  const reason = option ? option.title || (/(미지원|지원|제공|served|UNSUPPORTED)/i.test(option.text) ? option.text : '') : '';
  return { service, serviceOffered, model: editor[which], option, reason, modelOptions: models.filter((o) => o.value).length,
    stageable: !!option && !option.disabled, disabledWithReason: !!option && option.disabled && reason.length > 0 };
}

// A forced DOM selection of the opencode Argon, then 이 프로필 적용하기: the server must refuse and nothing may be written.
async function gateForced(page, board, homes, editor) {
  const forced = [];
  if (editor.mode) forced.push(await forceIn(page, editor.mode, 'custom'));
  forced.push(await forceIn(page, editor.service, ARGON_SERVICE.opencode));
  forced.push(await forceIn(page, editor.model, editor.opencode));
  if (editor.effort) forced.push(await forceIn(page, editor.effort, 'high'));
  const pending = await page.eval(`window.__qa9.pending()`);
  const staged = pending.some((change) => JSON.stringify(change).includes('gemini-4-argon') && !JSON.stringify(change).includes('google-antigravity'));
  const before = treeBytes(homes.root);
  const applied = staged ? await applyIn(page, board) : null;
  const written = treeChanges(before, treeBytes(homes.root));
  const exchange = applied ? applied.exchange : null;
  return { forced, pending, staged, exchange, page: applied ? applied.page : null, written,
    refusedByServer: !!exchange && exchange.status >= 400 && exchange.code === 'UNSUPPORTED_MODEL', zeroWrites: written.length === 0 };
}

// A normal pick through the offered options, then 이 프로필 적용하기; applied = HTTP 200 and a written file carries the model.
async function gatePick(page, board, homes, editor, which) {
  const out = { service: ARGON_SERVICE[which], model: editor[which], serviceOffered: false, modelOffered: false, effort: null, staged: false,
    exchange: null, written: [], carriedBy: [], applied: false };
  if (editor.mode) await chooseIn(page, editor.mode, 'custom');
  const services = await page.eval(`window.__qa9.options(${JSON.stringify(editor.service)})`) || [];
  out.serviceOffered = services.some((o) => o.value === out.service && !o.disabled);
  if (!out.serviceOffered) return out;
  await chooseIn(page, editor.service, out.service);
  const models = await page.eval(`window.__qa9.options(${JSON.stringify(editor.model)})`) || [];
  out.modelOffered = models.some((o) => o.value === out.model && !o.disabled);
  if (!out.modelOffered) return out;
  await chooseIn(page, editor.model, out.model);
  if (editor.effort) {
    out.effortOptions = (await page.eval(`window.__qa9.options(${JSON.stringify(editor.effort)})`) || []).filter((o) => o.value && !o.disabled).map((o) => o.value);
    out.effort = out.effortOptions.includes('high') ? 'high' : out.effortOptions[out.effortOptions.length - 1] || null;
    if (out.effort) await chooseIn(page, editor.effort, out.effort);
  }
  out.pending = await page.eval(`window.__qa9.pending()`);
  out.staged = out.pending.some((change) => JSON.stringify(change).includes(out.model));
  if (!out.staged) return out;
  const before = treeBytes(homes.root);
  const applied = await applyIn(page, board);
  const after = treeBytes(homes.root);
  out.exchange = applied.exchange;
  out.page = applied.page;
  out.written = treeChanges(before, after);
  out.carriedBy = out.written.filter((file) => after[file] && after[file].toString('utf8').includes(out.model));
  out.applied = applied.exchange.status === 200 && out.carriedBy.length > 0;
  return out;
}

// Saved while it was served, then shown under served=false: every editor keeps the opencode Argon, and an unrelated
// apply must leave the bytes of each saved value as they were.
async function gateSaved(page, homes, registries) {
  const seedTree = treeBytes(homes.root);
  const writer = openFixtureStore(homes, fixtureRegistries(homes, true));
  const state = writer.state();
  const roleRow = state.routing.rows.find((r) => r.section === 'agents' && r.role !== 'explore' && !r.readOnly && !r.absentIn);
  const changes = [
    { kind: 'setRoute', profileKey: 'native-gpt-kimi-deepseek', section: roleRow.section, role: roleRow.role, provider: 'opencode', model: ARGON_OPENCODE, thinking: 'high' },
    { kind: 'setMain', profileKey: 'gpt-kimi-deepseek', provider: 'opencode', model: 'gemini-4-argon', thinking: 'high' },
    { kind: 'setSummarizer', modelId: ARGON_OPENCODE },
    { kind: 'setMemoryRow', row: 'kibitzer', mode: 'custom', model: ARGON_OPENCODE, reasoning: 'high' },
    { kind: 'setMemoryRow', row: 'reflection', mode: 'custom', model: ARGON_OPENCODE, reasoning: 'high' },
  ];
  const seeded = writer.handle({ action: 'apply', changes, expected: state.targets, rosterRevision: state.roster.revision });
  if (seeded.status !== 200) throw new Error('saving the opencode Argon while served failed: ' + JSON.stringify(seeded.json));
  const savedTree = treeBytes(homes.root);
  const saved = [];
  for (const file of SAVED_FILES) {
    if (!savedTree[file]) continue;
    const before = seedTree[file] ? JSON.parse(seedTree[file].toString('utf8').replace(/^\uFEFF/, '')) : {};
    const spans = jsonSpans(savedTree[file].toString('utf8'));
    for (const at of changedJsonPaths(before, JSON.parse(savedTree[file].toString('utf8').replace(/^\uFEFF/, '')))) {
      if (spans.has(JSON.stringify(at))) saved.push({ file, path: at, bytes: spans.get(JSON.stringify(at)) });
    }
  }
  const editors = {};
  const role = `[data-pf-route="${roleRow.section}/${roleRow.role}"]`;
  let unrelated = null;
  await withBoard(page, homes, registries, async (board) => {
    const shown = async (row, selects) => {
      const out = { row, values: {}, text: await page.eval(`window.__qa9.text(${JSON.stringify(row)})`), flag: await page.eval(`window.__qa9.flagIn(${JSON.stringify(row)})`) };
      for (const [name, sel] of Object.entries(selects)) out.values[name] = await page.eval(`window.__qa9.selected(${JSON.stringify(sel)})`);
      return out;
    };
    editors.role = await shown(role, { service: role + ' [data-pf="route-provider"]', model: role + ' [data-pf="route-model"]', effort: role + ' [data-pf="route-thinking"]' });
    editors.role.storeFlag = await page.eval(`window.__qa9.rowFlag(${JSON.stringify(roleRow.section)}, ${JSON.stringify(roleRow.role)})`);
    for (const name of ['main', 'summarizer', 'kibitzer', 'reflection']) {
      const e = GATE_EDITORS[name];
      editors[name] = await shown(e.row, Object.fromEntries(['mode', 'service', 'model', 'effort'].filter((k) => e[k]).map((k) => [k, e[k]])));
    }
    // The unrelated apply: another model_profile lane for the shown profile, which none of the five editors owns.
    const lane = '[data-pf="lane-select"]';
    const current = await page.eval(`window.__qa9.value(${JSON.stringify(lane)})`);
    const lanes = (await page.eval(`window.__qa9.options(${JSON.stringify(lane)})`) || [])
      .filter((o) => o.value && !o.disabled && o.value !== current && o.value !== 'custom-literal').map((o) => o.value);
    const before = treeBytes(homes.root);
    await chooseIn(page, lane, lanes[0]);
    const pending = await page.eval(`window.__qa9.pending()`);
    const applied = await applyIn(page, board);
    unrelated = { lane: { from: current, to: lanes[0] }, pending, exchange: applied.exchange, page: applied.page,
      written: treeChanges(before, treeBytes(homes.root)), staged: pending.some((change) => change.kind === 'setModelProfile') };
  });
  const afterTree = treeBytes(homes.root);
  const spansAfter = Object.fromEntries(SAVED_FILES.filter((f) => afterTree[f]).map((f) => [f, jsonSpans(afterTree[f].toString('utf8'))]));
  const preserved = saved.map((s) => ({ file: s.file, path: s.path, bytes: Buffer.byteLength(s.bytes),
    same: !!spansAfter[s.file] && spansAfter[s.file].get(JSON.stringify(s.path)) === s.bytes }));
  for (const e of Object.values(editors)) {
    const shownText = Object.values(e.values).map((v) => v ? v.value + ' ' + v.text : '').join(' ');
    e.shown = /gemini-4-argon|qa-argon-opencode/.test(shownText) && !/google-antigravity/.test(shownText);
    // A flag is any marker on the shown value (the memory rows prefix 미해결:) or an unsupported reason in the row.
    e.marker = (/(미해결|미지원|지원되지|지원 안|지원 불가|unsupported)/i.exec(e.values.model ? e.values.model.text : '') || [''])[0];
    e.flagged = !!e.flag || !!e.marker;
    e.reasonShown = !!e.flag;
  }
  return { roleRow: roleRow.section + '/' + roleRow.role, seeded: { status: seeded.status, changes }, editors, unrelated, preserved,
    survivesByteForByte: !!unrelated && unrelated.staged && unrelated.exchange.status === 200 && preserved.length > 0 && preserved.every((p) => p.same) };
}

async function supportGate() {
  const liveBefore = liveState();
  const tempRoot = path.join(FIXTURE_PARENT, 'qa9-gate-' + Date.now().toString(36));
  assertFixtureRoot(tempRoot);
  const startedAt = new Date().toISOString();
  const gate = { schema: 'qa9-gate/1', registry: 'served=false', model: ARGON_OPENCODE, startedAt, head: gitHead(), editors: {}, saved: null, errors: [] };
  const flip = { schema: 'qa9-gate/1', registry: 'served=true', model: ARGON_OPENCODE, startedAt, head: gate.head, editors: {}, errors: [] };
  let page = null;
  let csp = null;
  let pids = [];
  let seq = 0;
  const fresh = (label) => {
    seq += 1;
    const homes = seedFlowHomes(path.join(tempRoot, String(seq).padStart(2, '0') + '-' + label));
    addArgonAliases(homes);
    return homes;
  };
  try {
    page = await launch({ width: 1600, height: 900 });
    csp = await watchCsp(page);
    pids = [...new Set([page.pid, ...listProfilePids(page.profileDir)])];
    for (const [name, editor] of Object.entries(GATE_EDITORS)) {
      console.error('gate ' + name);
      const record = gate.editors[name] = {};
      let homes = fresh(name + '-unserved');
      let registries = fixtureRegistries(homes, false);
      record.registry = registrySummary(registries);
      await withBoard(page, homes, registries, async (board) => {
        record.offer = await gateOffer(page, editor, 'opencode');
        record.forced = await gateForced(page, board, homes, editor);
      });
      homes = fresh(name + '-antigravity');
      registries = fixtureRegistries(homes, false);
      await withBoard(page, homes, registries, async (board) => {
        record.antigravity = await gatePick(page, board, homes, editor, 'antigravity');
      });
      homes = fresh(name + '-flip');
      registries = fixtureRegistries(homes, true);
      const flipped = flip.editors[name] = { registry: registrySummary(registries) };
      await withBoard(page, homes, registries, async (board) => {
        flipped.offer = await gateOffer(page, editor, 'opencode');
        flipped.pick = await gatePick(page, board, homes, editor, 'opencode');
      });
    }
    console.error('gate saved');
    const homes = fresh('saved');
    gate.saved = await gateSaved(page, homes, fixtureRegistries(homes, false));
  } catch (error) {
    gate.errors.push(String(error && error.stack || error));
  } finally {
    gate.cleanup = { chrome: await closeQaChrome(page, pids), temp: removeTempRoot(tempRoot) };
  }
  const liveAfter = liveState();
  const live = { unchanged: JSON.stringify(liveAfter.hashes) === JSON.stringify(liveBefore.hashes)
    && JSON.stringify(liveAfter.server) === JSON.stringify(liveBefore.server), hashes: liveAfter.hashes };
  const violations = csp ? csp.violations : [];
  gate.verdicts = Object.fromEntries(Object.entries(gate.editors).map(([name, r]) => [name, {
    optionDisabledWithReason: !!r.offer?.disabledWithReason,
    notStageable: !!r.offer && !r.offer.stageable,
    forcedRefusedByServer: !!r.forced?.refusedByServer,
    forcedZeroWrites: !!r.forced?.zeroWrites,
    antigravityApplies: !!r.antigravity?.applied,
    savedShown: !!gate.saved?.editors?.[name]?.shown,
    savedFlagged: !!gate.saved?.editors?.[name]?.flagged,
  }]));
  gate.verdicts.savedSurvivesUnrelatedApplyByteForByte = !!gate.saved?.survivesByteForByte;
  gate.failing = Object.entries(gate.verdicts).flatMap(([name, v]) => (typeof v === 'boolean' ? (v ? [] : [name])
    : Object.entries(v).filter(([, ok]) => !ok).map(([check]) => name + '.' + check)));
  gate.csp = { violations, count: violations.length };
  gate.live = live;
  gate.finishedAt = new Date().toISOString();
  gate.verdict = gate.failing.length || gate.errors.length || violations.length || !live.unchanged || !gate.cleanup.chrome.closed ? 'FAIL' : 'PASS';
  flip.verdicts = Object.fromEntries(Object.entries(flip.editors).map(([name, r]) => [name, {
    offeredAndEnabled: !!r.offer?.stageable, staged: !!r.pick?.staged, appliedHttp200: r.pick?.exchange?.status === 200 }]));
  flip.failing = Object.entries(flip.verdicts).flatMap(([name, v]) => Object.entries(v).filter(([, ok]) => !ok).map(([check]) => name + '.' + check));
  flip.csp = gate.csp;
  flip.live = live;
  flip.finishedAt = gate.finishedAt;
  flip.verdict = flip.failing.length || gate.errors.length || violations.length || !live.unchanged ? 'FAIL' : 'PASS';
  fs.writeFileSync(path.join(OUT, 'gate.json'), JSON.stringify(gate, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'gate-flip.json'), JSON.stringify(flip, null, 2) + '\n');
  console.log(JSON.stringify({ gate: gate.verdict, gateFailing: gate.failing, flip: flip.verdict, flipFailing: flip.failing, csp: violations.length,
    live: live.unchanged, errors: gate.errors }, null, 2));
  process.exitCode = gate.verdict === 'PASS' && flip.verdict === 'PASS' ? 0 : 1;
}

async function flowTask(page, tempRoot, size, task) {
  const homes = seedFlowHomes(path.join(tempRoot, size.name + '-' + task));
  const record = { size: size.name, task, steps: [], apply: [], previews: 0, written: [], replay: null };
  await withBoard(page, homes, null, async (board) => {
    const before = treeBytes(homes.root);
    for (const id of FLOW_TASKS[task]) record.steps.push(await flowStep(page, board, id));
    const after = treeBytes(homes.root);
    const applies = board.exchanges.filter((e) => e.request.action === 'apply');
    record.previews = board.exchanges.filter((e) => e.request.action === 'preview').length;
    record.apply = applies.map((e) => ({ status: e.status, code: e.code, changes: e.request.changes }));
    record.written = treeChanges(before, after);
    record.replay = replayThroughStore(seedFlowHomes(path.join(tempRoot, size.name + '-' + task + '-replay')), applies[0]?.request, { root: homes.root, tree: after });
  });
  record.ok = record.previews === 0 && record.apply.length === 1 && record.apply[0].status === 200 && record.written.length > 0 && record.replay.ok;
  return record;
}

// A main edit on the profile the page shows: the saved main service's first other served catalog model at its last
// common level, as the store lists the seed's catalog, applied the way the page applies (the shown profile activated).
// Its golden is the validated layer's output for that intent on the same seed files: the merge port the parity tests
// hold to every PS golden (src/profiles/parity.mjs runScenario). No expected file is written by hand.
function mainOnShownProfile(seedDir, homes) {
  const state = openFixtureStore(homes).state();
  const { provider, model: saved } = state.main.effective;
  const served = (entry) => Object.keys(entry.served ?? {}).length > 0 && Object.values(entry.served).every(Boolean);
  const entry = Object.values(state.catalog).find((e) => getProviderFromModelId(e.model) === provider
    && getModelIdWithoutProvider(e.model) !== saved && served(e) && e.levels.length > 0);
  const effort = entry.levels[entry.levels.length - 1];
  const intent = { schema: 1, profileKey: state.activeProfile.key, activate: true, routing: [], main: { provider, model: entry.model, reasoning: effort } };
  const files = {};
  for (const name of Object.keys(GOLDEN_SEED_FILES)) {
    const value = goldenFile(seedDir, name);
    if (value !== null) files[name] = value;
  }
  const result = runScenario({ files, scenario: { mode: 'ApplyIntentPath.Apply' }, intent });
  return {
    intent,
    steps: [['[data-pf="main-model"]', getModelIdWithoutProvider(entry.model)], ['[data-pf="main-thinking"]', effort], ['apply:detail', null]],
    expected: (name) => (Object.hasOwn(result.files, name) ? result.files[name] : null),
  };
}

// A golden scenario through the page: seeded from the scenario's own seed, compared the way the parity tests compare,
// except that the seed is the expectation where the store keeps it (SEED_KEPT).
async function goldenThroughPage(page, tempRoot, spec) {
  const seedDir = path.join(PROFILE_FIXTURES, spec.seed);
  const homes = seedGoldenHomes(path.join(tempRoot, 'golden-' + spec.task), seedDir);
  const run = spec.shownProfileMain ? mainOnShownProfile(seedDir, homes)
    : { intent: null, steps: spec.steps, expected: (name) => goldenFile(path.join(PROFILE_FIXTURES, spec.golden), name) };
  const record = { task: spec.task, seed: spec.seed, golden: spec.golden, intent: run.intent, steps: [], apply: [], written: [], files: [], replay: null };
  await withBoard(page, homes, null, async (board) => {
    const before = treeBytes(homes.root);
    for (const [id, value] of run.steps) {
      if (value === null) { record.steps.push(await flowStep(page, board, id)); continue; }
      const sel = id.startsWith('[') ? id : `[data-flow="${id}"]`;
      const offered = (await page.eval(`window.__qa9.options(${JSON.stringify(sel)})`) || []).filter((o) => o.value && !o.disabled).map((o) => o.value);
      if (!offered.includes(value)) {
        record.steps.push({ control: id, wanted: value, offered });
        record.blocked = `${id} does not offer ${value}`;
        return;
      }
      record.steps.push({ control: id, picked: await chooseIn(page, sel, value) });
    }
    const after = treeBytes(homes.root);
    record.written = treeChanges(before, after);
    const applies = board.exchanges.filter((e) => e.request.action === 'apply');
    record.apply = applies.map((e) => ({ status: e.status, code: e.code, changes: e.request.changes }));
    for (const [name, rel] of Object.entries(GOLDEN_SEED_FILES)) {
      const golden = run.expected(name);
      if (golden === null) continue;
      const seed = goldenFile(seedDir, name);
      const expected = storeContractGolden(name, seed, golden);
      const actual = after[rel] ? JSON.parse(after[rel].toString('utf8').replace(/^\uFEFF/, '')) : null;
      const diffs = canonicalDiffs(actual, expected);
      record.files.push({ golden: name, file: rel, boardWrote: record.written.includes(rel),
        goldenChangedFromSeed: JSON.stringify(canonicalJson(seed)) !== JSON.stringify(canonicalJson(golden)),
        seedKept: canonicalDiffs(expected, golden).map((d) => d.path), equal: diffs.length === 0, diffs: diffs.slice(0, 8) });
    }
    record.replay = replayThroughStore(seedGoldenHomes(path.join(tempRoot, 'golden-' + spec.task + '-replay'), seedDir), applies[0]?.request, { root: homes.root, tree: after });
  });
  record.ok = !record.blocked && record.apply.length === 1 && record.apply[0].status === 200 && record.files.every((f) => f.equal) && !!record.replay?.ok;
  return record;
}

// Stage the role task, edit omo.jsonc behind the page, then apply: the store must answer 409 and write nothing.
async function behindThePageEdit(page, tempRoot) {
  const homes = seedFlowHomes(path.join(tempRoot, 'stale'));
  const record = { steps: [] };
  await withBoard(page, homes, null, async (board) => {
    for (const id of FLOW_TASKS.role.slice(0, -1)) record.steps.push(await flowStep(page, board, id));
    record.pending = await page.eval(`window.__qa9.pending()`);
    fs.appendFileSync(path.join(homes.primary, 'omo.jsonc'), '\r\n');
    const before = treeBytes(homes.root);
    const sel = '[data-flow="apply:detail"]';
    await page.eval(`window.__qa9.reach(${JSON.stringify(sel)})`);
    await settleIn(page);
    const answered = board.nextExchange();
    await page.eval(`window.__qa9.click(${JSON.stringify(sel)})`);
    const exchange = await answered;
    await waitIn(page, `document.querySelector('.pf-conflict')`, 'conflict after the behind-the-page edit');
    await settleIn(page);
    record.exchange = { status: exchange.status, code: exchange.code };
    record.conflictText = await page.eval(`window.__qa9.text('.pf-conflict')`);
    record.pendingAfter = await page.eval(`window.__qa9.pending()`);
    record.written = treeChanges(before, treeBytes(homes.root));
  });
  record.ok = record.exchange?.status === 409 && record.written.length === 0 && record.pendingAfter.length === record.pending.length;
  return record;
}

function e2eSummary(report) {
  const lines = [`# todo 9 e2e - 세 작업을 실제 페이지로 (${report.startedAt} .. ${report.finishedAt})`, '',
    `HEAD ${report.head} · CSP 위반 ${report.csp.violations.length} · 라이브 홈 변화 없음 ${report.live.unchanged} · 결과 ${report.ok ? 'PASS' : 'FAIL'}`, '',
    '| 크기 | 작업 | 단계 | apply | 쓴 파일 | 스토어 재생과 바이트 비교 | 판정 |', '|---|---|---|---|---|---|---|'];
  for (const t of report.tasks) {
    const replay = t.replay?.mismatches ? (t.replay.mismatches.length ? '다름 ' + t.replay.mismatches.join(', ')
      : `같음 (${t.replay.byteEqual}/${t.replay.files}개 파일 바이트 동일${t.replay.journalFolded ? ', journal 은 루트·실행 id 접어 비교' : ''}, 입력 동일 ${t.replay.sameInputs})`) : t.replay?.reason;
    lines.push(`| ${t.size} | ${t.task} | ${t.steps.map((s) => s.control.split(':').pop() + (s.picked ? '=' + s.picked : '')).join(' → ')} | ${t.apply.map((a) => a.status).join(',')} | ${t.written.length} | ${replay} | ${t.ok ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('', '## golden', '');
  for (const g of report.goldens) {
    if (!g.golden) { lines.push(`- ${g.task}: 해당 시나리오 없음 — ${g.reason}`); continue; }
    lines.push(`- ${g.task}: ${g.seed} → ${g.golden}${g.intent ? ` (표시 프로필 ${g.intent.profileKey} 메인 ${g.intent.main.model} / ${g.intent.main.reasoning}, activate)` : ''} · ${g.ok ? 'PASS' : 'FAIL'}${g.blocked ? ' · 막힘: ' + g.blocked : ''} · apply ${g.apply.map((a) => a.status + (a.code ? ' ' + a.code : '')).join(',')} · 스토어 재생 ${g.replay ? (g.replay.ok ? '같음' : '다름 ' + JSON.stringify(g.replay.mismatches || g.replay.reason)) : '-'}`);
    for (const f of g.files) lines.push(`  - ${f.golden}: ${f.equal ? '같음' : '다름'} (보드가 씀 ${f.boardWrote}, golden 이 시드에서 바꿈 ${f.goldenChangedFromSeed}${f.seedKept.length ? ', 스토어 계약상 시드 유지 ' + f.seedKept.join(' ') : ''})${f.equal ? '' : ' ' + JSON.stringify(f.diffs.slice(0, 3))}`);
  }
  const s = report.stale || {};
  lines.push('', '## 페이지 뒤 편집 (409)', '', `- apply 응답 ${s.exchange?.status} ${s.exchange?.code} · 쓴 파일 ${JSON.stringify(s.written)} · 보류 유지 ${s.pendingAfter?.length}/${s.pending?.length} · ${s.ok ? 'PASS' : 'FAIL'}`);
  if (report.errors.length) lines.push('', '## 오류', '', ...report.errors.map((e) => '- ' + e.split('\n')[0]));
  return lines.join('\n') + '\n';
}

async function flowE2e() {
  const liveBefore = liveState();
  const tempRoot = path.join(FIXTURE_PARENT, 'qa9-e2e-' + Date.now().toString(36));
  assertFixtureRoot(tempRoot);
  const report = { schema: 'qa9-e2e/1', startedAt: new Date().toISOString(), head: gitHead(), tempRoot, tasks: [], goldens: [], stale: null, errors: [] };
  let page = null;
  let csp = null;
  let pids = [];
  try {
    page = await launch({ width: FLOW_SIZES[0].width, height: FLOW_SIZES[0].height });
    csp = await watchCsp(page);
    pids = [...new Set([page.pid, ...listProfilePids(page.profileDir)])];
    for (const size of FLOW_SIZES) {
      await page.client.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
      for (const task of Object.keys(FLOW_TASKS)) {
        console.error(`e2e ${size.name} ${task}`);
        report.tasks.push(await flowTask(page, tempRoot, size, task));
      }
    }
    await page.client.send('Emulation.setDeviceMetricsOverride', { width: FLOW_SIZES[0].width, height: FLOW_SIZES[0].height, deviceScaleFactor: 1, mobile: false });
    for (const spec of GOLDEN_RUNS) {
      console.error('golden ' + spec.task);
      report.goldens.push(await goldenThroughPage(page, tempRoot, spec));
    }
    report.goldens.push({ task: 'role', golden: null, reason: ROLE_GOLDEN_GAP });
    console.error('behind-the-page edit');
    report.stale = await behindThePageEdit(page, tempRoot);
  } catch (error) {
    report.errors.push(String(error && error.stack || error));
  } finally {
    report.cleanup = { chrome: await closeQaChrome(page, pids), temp: removeTempRoot(tempRoot) };
  }
  const liveAfter = liveState();
  report.live = { unchanged: JSON.stringify(liveAfter.hashes) === JSON.stringify(liveBefore.hashes)
    && JSON.stringify(liveAfter.server) === JSON.stringify(liveBefore.server), hashes: liveAfter.hashes };
  report.csp = { violations: csp ? csp.violations : [], notes: csp ? csp.notes.length : 0 };
  report.finishedAt = new Date().toISOString();
  report.verdicts = {
    tasksEqualStoreBytes: report.tasks.length === 6 && report.tasks.every((t) => t.ok),
    goldensEqual: report.goldens.filter((g) => g.golden && !g.blocked).every((g) => g.ok),
    goldensDrivableThroughPage: report.goldens.filter((g) => g.golden).every((g) => !g.blocked),
    behindThePageEdit409NoWrite: !!report.stale?.ok,
    csp: report.csp.violations.length === 0,
    chromeClosed: !!report.cleanup.chrome.closed,
    liveUnchanged: report.live.unchanged,
  };
  report.ok = Object.values(report.verdicts).every(Boolean) && report.errors.length === 0;
  fs.writeFileSync(path.join(EVIDENCE, 'e2e.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(EVIDENCE, 'e2e.md'), e2eSummary(report));
  console.log(JSON.stringify({ ok: report.ok, verdicts: report.verdicts, errors: report.errors }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

function gitHead() {
  const out = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 });
  return out.status === 0 ? out.stdout.trim() : 'unknown';
}

await main();
if (!NEGATIVE && !GATE && !FLOW_E2E) {
  if (!run.ok) process.exit(1);
  console.log(`PASS ${run.captures.length} captures; build ${run.build.hash}; e2e ${path.join(EVIDENCE, `${PREFIX}-e2e.txt`)}`);
}
