#!/usr/bin/env node
// omo-briefing installer: generation install, managed shim, initial page, uninstall.
//
//   node REPO/scripts/install.mjs --agent-dir <dir> [--dry-run] [--uninstall]
//
// - Copies built REPO/dist/ to <dir>/briefing/integration/generation-NNNNNN/
//   (never modifies an existing generation; the next number is always new).
// - Writes <dir>/briefing/current.json ({generation, installedAt, sha256}) by replace-write.
// - Writes the managed shim <dir>/extensions/omo-briefing.js (managed marker +
//   re-export). A same-named non-managed file refuses the install (exit 1,
//   nothing written).
// - Renders the initial empty page into <dir>/briefing/state/ ONLY when STATE
//   has neither a published page (published.json/index.html/data.js) nor any
//   stored conversation record (meta/briefs/decisions/...); a fresh
//   initial page is written inside render.lock (wx + nonce, dead-pid locks
//   reclaimed via src/store.mjs reclaimStale); a live-owner lock skips the page
//   but still installs the generation/shim.
// - A STATE that already has a published board or stored records is drawn by the
//   renderer (src/render.mjs renderPage: render.lock, seq = max(published.json,
//   data.js seq) + 1, never a lower seq), so it shows its records through the
//   current page - never an empty board when records exist. A live-owner lock skips that publish and prints the reason; a stale
//   lock that cannot be recovered fails with the manual-check error and exit 1.
// - --dry-run prints what would be written and writes nothing.
// - --uninstall removes only the managed shim; generations and STATE stay.
// - Never reads or writes other files under <dir>/extensions/.
// - Never opens a browser. Requires an already-built dist/ (else exit 1).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, isPidAlive } from '../src/store.mjs';
import { renderPage } from '../src/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const DIST = join(REPO, 'dist');
const SHIM_NAME = 'omo-briefing.js';
const MANAGED_MARK = '// managed by omo-briefing';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const fail = (msg) => { console.error('omo-briefing install: ' + msg); process.exit(1); };
const sha256Bytes = (buf) => createHash('sha256').update(buf).digest('hex');

function replaceWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const bytes = typeof data === 'string' ? data : String(data);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    let delay = 20;
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, file); return; }
      catch (err) {
        if (!RETRY_CODES.has(err.code) || attempt >= 8) throw err;
        sleepSync(delay);
        delay *= 2;
      }
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function listFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function nextGeneration(integrationDir) {
  let max = 0;
  if (existsSync(integrationDir)) {
    for (const e of readdirSync(integrationDir)) {
      const m = /^generation-(\d{6})$/.exec(e);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return 'generation-' + String(max + 1).padStart(6, '0');
}

function isManagedShim(file) {
  let first = '';
  try { first = readFileSync(file, 'utf8').split('\n')[0]; }
  catch { return false; }
  return first.trim() === MANAGED_MARK;
}

function emptyPage(stateDir) {
  const now = new Date().toISOString();
  const html =
    '<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
    '<title>브리핑 상황판</title>\n</head>\n<body>\n' +
    '<h1>브리핑 상황판</h1>\n<p>아직 보고 없음 - 새로 연 OMO 대화부터 표시됨</p>\n' +
    '<p>브리핑이 켜진 대화 N개만 보입니다 - 설치 전부터 열려 있던 대화는 새로 열어야 나타납니다</p>\n' +
    '</body>\n</html>\n';
  const data =
    'window.__briefData && window.__briefData(' +
    JSON.stringify({ seq: 0, at: now, sessions: [], empty: true }) + ');\n';
  const published = JSON.stringify({ seq: 0, dataHash: sha256Bytes(data), at: now }, null, 2) + '\n';
  return [
    [join(stateDir, 'index.html'), html],
    [join(stateDir, 'data.js'), data],
    [join(stateDir, 'published.json'), published],
  ];
}

// A STATE with a published board (index.html/data.js/published.json) or with any
// stored record (session meta/briefs, decisions, answers, ...) is drawn by the
// renderer from those records; only a STATE with neither gets the plain empty page.
function hasStateToRender(stateDir) {
  if (existsSync(join(stateDir, 'published.json'))
    || existsSync(join(stateDir, 'index.html'))
    || existsSync(join(stateDir, 'data.js'))) return true;
  const snap = openStore(stateDir).readSnapshot();
  return snap.readErrors.length > 0 || snap.sessions.length > 0 || snap.mirror.length > 0
    || [snap.decisions, snap.closures, snap.answers, snap.claims, snap.receipts].some((r) => r.length > 0);
}

// Acquire render.lock with wx + nonce; reclaim only dead-pid locks via
// src/store.mjs reclaimStale. Returns 'acquired', 'held-live' or 'reclaimed'.
function acquireRenderLock(stateDir) {
  const store = openStore(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const lockFile = join(stateDir, 'render.lock');
  const fresh = { pid: process.pid, at: new Date().toISOString(), nonce: randomUUID() };
  const tryWx = () => {
    try {
      writeFileSync(lockFile, JSON.stringify(fresh), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') return false;
      throw err;
    }
  };
  if (tryWx()) return 'acquired';
  let stale = null;
  try { stale = JSON.parse(readFileSync(lockFile, 'utf8')); }
  catch { return 'held-live'; } // unreadable = maybe being written = alive
  if (!stale || typeof stale !== 'object') return 'held-live';
  if (isPidAlive(stale.pid)) return 'held-live';
  // A reclaim failure (e.g. hard-link EPERM -> '오래된 선점 - 수동 확인 필요')
  // must surface to the caller, never masquerade as a live-owner lock.
  // Returns false (someone else won) -> live skip; throws -> caller reports.
  const reclaimed = store.reclaimStale('render.lock', stale);
  if (!reclaimed) return 'held-live';
  if (tryWx()) return 'reclaimed';
  return 'held-live';
}

function releaseRenderLock(stateDir) {
  try { unlinkSync(join(stateDir, 'render.lock')); } catch {}
}

function main(argv) {
  let agentDir = null;
  let dryRun = false;
  let uninstall = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent-dir') agentDir = argv[++i];
    else if (a.startsWith('--agent-dir=')) agentDir = a.slice('--agent-dir='.length);
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--uninstall') uninstall = true;
    else fail('unknown argument: ' + a);
  }
  if (!agentDir) fail('missing --agent-dir <dir>');
  if (!existsSync(agentDir) || !statSync(agentDir).isDirectory()) fail('agent dir not found: ' + agentDir);

  const extDir = join(agentDir, 'extensions');
  const shimFile = join(extDir, SHIM_NAME);
  const integrationDir = join(agentDir, 'briefing', 'integration');
  const currentFile = join(agentDir, 'briefing', 'current.json');
  const stateDir = join(agentDir, 'briefing', 'state');

  if (uninstall) {
    if (existsSync(shimFile)) {
      if (!isManagedShim(shimFile)) fail('refusing to remove non-managed ' + SHIM_NAME);
      if (dryRun) { console.log('would remove ' + shimFile); return; }
      unlinkSync(shimFile);
      console.log('removed ' + shimFile + ' (generations and state kept)');
    } else {
      console.log('nothing to remove: ' + shimFile + ' not present');
    }
    return;
  }

  if (!existsSync(join(DIST, 'extension.mjs'))) {
    fail('dist/ not built - run `npm run build` first');
  }
  if (existsSync(shimFile) && !isManagedShim(shimFile)) {
    fail('non-managed ' + SHIM_NAME + ' exists - refusing to overwrite');
  }

  const generation = nextGeneration(integrationDir);
  const genDir = join(integrationDir, generation);
  const shimText =
    MANAGED_MARK + '\n' +
    `export { default } from '../briefing/integration/${generation}/extension.mjs';\n`;
  // Plan todo 13/17: a STATE that already has a board or stored records is handed
  // to the renderer, so the installer only plans its own empty page for a bare STATE.
  const stateHasBoard = hasStateToRender(stateDir);
  const planned = [
    genDir + '/',
    currentFile,
    shimFile,
    ...(stateHasBoard
      ? ['index.html', 'data.js', 'published.json'].map((n) => join(stateDir, n) + ' (re-render via renderer)')
      : emptyPage(stateDir).map(([f]) => f)),
  ];
  const readmeSrc = join(REPO, 'README.ko.md');
  if (existsSync(readmeSrc)) planned.push(join(agentDir, 'briefing', 'README.ko.md'));

  if (dryRun) {
    console.log('dry-run: would write');
    for (const p of planned) console.log('  ' + p);
    return;
  }

  mkdirSync(genDir, { recursive: true });
  cpSync(DIST, genDir, { recursive: true });
  const sha256 = {};
  for (const f of listFiles(genDir)) sha256[relative(genDir, f)] = sha256Bytes(readFileSync(f));
  replaceWrite(currentFile, JSON.stringify({
    generation, installedAt: new Date().toISOString(), sha256,
  }, null, 2) + '\n');
  mkdirSync(extDir, { recursive: true });
  replaceWrite(shimFile, shimText);
  if (stateHasBoard) {
    // Plan todo 17: re-draw the existing board through the renderer
    // (renderPage: render.lock, seq = published.json seq + 1, republication). A
    // live-owner lock makes renderPage skip and report; a stale lock that cannot
    // be recovered reports the manual-check error, which is a failure here.
    let res;
    try {
      // Stamp the page with the generation just installed, so an older-generation
      // publisher leaves this template alone.
      res = renderPage(openStore(stateDir), Date.now(), { generation: Number(/(\d{6})$/.exec(generation)[1]) });
    } catch (err) {
      res = { ok: false, error: String(err && err.message || err) };
    }
    if (res.ok) {
      console.log(`installed ${generation} -> ${shimFile} (board re-rendered seq ${res.seqs.at(-1)})`);
    } else if (/잠금을 얻지 못함/.test(res.error)) {
      console.log(`installed ${generation} -> ${shimFile} (board re-render skipped: ${res.error})`);
    } else {
      console.error('omo-briefing install: ' + res.error);
      process.exit(1);
    }
  } else {
    // Initial page is a publication: write it only inside render.lock. A live
    // owner lock means the page is skipped; shim/generation still install.
    let lock;
    try {
      lock = acquireRenderLock(stateDir);
    } catch (err) {
      // Stale-lock recovery refused (e.g. hard-link EPERM): print the
      // manual-check instruction, write no page, exit non-zero. The
      // generation/shim installed above stay (no rollback per plan).
      console.error('omo-briefing install: ' + (err && err.message ? err.message : err));
      process.exit(1);
    }
    if (lock === 'held-live') {
      console.log(`installed ${generation} -> ${shimFile} (initial page skipped: render.lock held)`);
    } else {
      try {
        if (hasStateToRender(stateDir)) {
          // A board or records landed while we were taking the lock: never overwrite them.
          // The next install re-renders it through the renderer.
          console.log(`installed ${generation} -> ${shimFile} (board appeared during install - kept)`);
        } else {
          for (const [file, data] of emptyPage(stateDir)) replaceWrite(file, data);
          console.log(`installed ${generation} -> ${shimFile}`);
        }
      } finally {
        releaseRenderLock(stateDir);
      }
    }
  }
  if (existsSync(readmeSrc)) replaceWrite(join(agentDir, 'briefing', 'README.ko.md'), readFileSync(readmeSrc, 'utf8'));
}

main(process.argv.slice(2));
