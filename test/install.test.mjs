import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { openStore } from '../src/store.mjs';
import { renderPage } from '../src/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const INSTALL = join(REPO, 'scripts', 'install.mjs');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(f.slice(dir.length + 1));
    }
  };
  walk(dir);
  return out.sort();
}
function makeAgentDir() {
  const dir = mkdtempSync(join(os.tmpdir(), 'briefing-agent-'));
  mkdirSync(join(dir, 'extensions'), { recursive: true });
  writeFileSync(join(dir, 'extensions', 'other-ext.js'), '// third party\n');
  return dir;
}
const run = (args, env) => spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8', ...(env ? { env } : {}) });
// The installer must run without blocking this process while a stub server answers it:
// spawnSync would freeze the event loop that has to reply to the health check.
function runAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INSTALL, ...args], env ? { env } : {});
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// The plan's one closing line of an install, and the extra sentence a failed health
// check adds to it (never an install error).
const GUIDANCE = '실시간 상황판은 새 대화에서 /brief를 치면 켜집니다';
const HEALTH_EXCEPTION = '오류는 아닙니다';
const lastLine = (r) => r.stdout.trimEnd().split('\n').at(-1);

// A port nobody listens on: bind it, read it, release it. Deterministic, no sleep.
async function closedPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// A real /health server, so the announced address is proven by an answer, not by a string. It binds
// inside the port window this task is assigned (47550+), taking the first free port so a concurrent
// harness run cannot collide with it.
async function healthServer() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
    else { res.writeHead(404); res.end(); }
  });
  const stop = () => new Promise((resolve) => { srv.closeAllConnections(); srv.close(resolve); });
  for (let port = 47550; port < 47560; port++) {
    const listening = await new Promise((resolve) => {
      const onErr = () => { srv.removeListener('listening', onOk); resolve(false); };
      const onOk = () => { srv.removeListener('error', onErr); resolve(true); };
      srv.once('error', onErr);
      srv.once('listening', onOk);
      srv.listen(port, '127.0.0.1');
    });
    if (listening) return { port, stop };
  }
  throw new Error('no free health stub port in 47550..47559');
}
const seedServerRecord = (state, port) => {
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'server.json'), JSON.stringify({
    pid: process.pid, at: 'fixture', nonce: 'fixture', sessionId: 'owner', port, generation: 4,
  }));
};

// Injects an fs.linkSync failure at the real filesystem boundary, so a stale
// render.lock must be recovered by the product code and cannot be recovered.
function denyLinkPreload() {
  const dir = mkdtempSync(join(os.tmpdir(), 'briefing-deny-link-'));
  const preload = join(dir, 'deny-link.cjs');
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "fs.linkSync = () => { throw Object.assign(new Error('injected link failure'), { code: 'EPERM' }); };",
    'syncBuiltinESMExports();',
    '',
  ].join('\n'));
  return {
    env: { ...process.env, NODE_OPTIONS: '--require="' + preload.replace(/\\/g, '/') + '"' },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Injects an EPERM on the STATE server.json record only: the first `failures` calls to
// statSync/readFileSync for that path throw, every later call goes through. The call log counts the
// record-path calls the installer actually made, so bounded retries can be counted.
function flakyIoPreload({ failures, log }) {
  const dir = mkdtempSync(join(os.tmpdir(), 'briefing-flaky-io-'));
  const preload = join(dir, 'flaky-io.cjs');
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    'const LIMIT = ' + failures + ';',
    'const LOG = ' + JSON.stringify(log) + ';',
    'const realStat = fs.statSync, realRead = fs.readFileSync;',
    'let used = 0;',
    "const isRecord = (p) => typeof p === 'string' && /server\\.json$/.test(p.replace(/\\\\/g, '/'));",
    'const note = () => { try { fs.appendFileSync(LOG, "x"); } catch {} };',
    'const boom = () => { throw Object.assign(new Error("injected EPERM"), { code: "EPERM" }); };',
    'fs.statSync = function (p, ...rest) { if (!isRecord(p)) return realStat.call(fs, p, ...rest); note(); if (used++ < LIMIT) boom(); return realStat.call(fs, p, ...rest); };',
    'fs.readFileSync = function (p, ...rest) { if (!isRecord(p)) return realRead.call(fs, p, ...rest); note(); if (used++ < LIMIT) boom(); return realRead.call(fs, p, ...rest); };',
    'syncBuiltinESMExports();',
    '',
  ].join('\n'));
  return {
    env: { ...process.env, NODE_OPTIONS: '--require="' + preload.replace(/\\/g, '/') + '"' },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// A published board as the install/extension path leaves it: session meta +
// brief records, index.html/data.js/published.json at a known seq.
function seedBoard(state, seq, title) {
  mkdirSync(join(state, 'sessions', 'owner', 'briefs'), { recursive: true });
  const now = Date.now();
  writeFileSync(join(state, 'sessions', 'owner', 'meta.json'), JSON.stringify({
    sessionId: 'owner', cwd: 'C:/work/owner-project', title: title, lastActivityAt: now,
  }));
  writeFileSync(join(state, 'sessions', 'owner', 'briefs', '000001.json'), JSON.stringify({
    at: now,
    brief: { title: title, status: 'in_progress', headline: title + '-' + seq, changes: [] },
  }));
  const data = '/* seq:' + seq + ' */\nwindow.__briefData && window.__briefData(' +
    JSON.stringify({ seq: seq, at: 'fixture' }) + ');\n';
  writeFileSync(join(state, 'data.js'), data);
  writeFileSync(join(state, 'index.html'), '<article>' + title + '-' + seq + '</article>');
  writeFileSync(join(state, 'published.json'), JSON.stringify({
    seq: seq, at: 'fixture', dataHash: createHash('sha256').update(data).digest('hex'),
  }));
}

const boardBytes = (state) => ({
  html: readFileSync(join(state, 'index.html'), 'utf8'),
  data: readFileSync(join(state, 'data.js'), 'utf8'),
  pub: readFileSync(join(state, 'published.json'), 'utf8'),
});

test('first install creates generation-000001, shim, current.json and empty state page', () => {
  const agent = makeAgentDir();
  const otherBefore = sha256(join(agent, 'extensions', 'other-ext.js'));
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 0, r.stderr);
  const gen = join(agent, 'briefing', 'integration', 'generation-000001');
  assert.ok(statSync(gen).isDirectory());
  assert.equal(
    readFileSync(join(agent, 'extensions', 'omo-briefing.js'), 'utf8'),
    '// managed by omo-briefing\n' +
      "export { default } from '../briefing/integration/generation-000001/extension.mjs';\n",
  );
  const current = JSON.parse(readFileSync(join(agent, 'briefing', 'current.json'), 'utf8'));
  assert.equal(current.generation, 'generation-000001');
  assert.ok(typeof current.installedAt === 'string' && current.installedAt.length > 0);
  assert.ok(current.sha256 && typeof current.sha256 === 'object');
  assert.equal(
    readFileSync(join(agent, 'briefing', 'README.ko.md'), 'utf8'),
    readFileSync(join(REPO, 'README.ko.md'), 'utf8'),
    'README.ko.md copied to AGENT/briefing/',
  );
  const page = readFileSync(join(agent, 'briefing', 'state', 'index.html'), 'utf8');
  assert.ok(page.includes('아직 보고 없음 - 새로 연 OMO 대화부터 표시됨'), 'empty page phrase');
  // The generation is a copy of the built dist: the expected file list is computed
  // independently from the dist listing, so a missing or extra file fails here.
  const distFiles = tree(join(REPO, 'dist'));
  assert.ok(distFiles.length > 10, 'dist listing looks empty: ' + distFiles.length);
  assert.deepEqual(tree(gen), distFiles, 'generation holds exactly the dist listing');
  assert.equal(sha256(join(agent, 'extensions', 'other-ext.js')), otherBefore, 'third-party extension bytes unchanged');
  assert.equal(lastLine(r), GUIDANCE, 'closing guidance line, got: ' + JSON.stringify(r.stdout));
  rmSync(agent, { recursive: true, force: true });
});

test('install prints the live board address when STATE/server.json answers health', async () => {
  const agent = makeAgentDir();
  const health = await healthServer();
  try {
    seedServerRecord(join(agent, 'briefing', 'state'), health.port);
    const r = await runAsync(['--agent-dir', agent]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastLine(r), `실시간 상황판: http://127.0.0.1:${health.port}/`, r.stdout);
    rmSync(agent, { recursive: true, force: true });
  } finally {
    await health.stop();
  }
});

test('install keeps exit 0 and only adds the exception sentence when server.json health fails', async () => {
  const agent = makeAgentDir();
  seedServerRecord(join(agent, 'briefing', 'state'), await closedPort());
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 0, r.stderr);
  const line = lastLine(r);
  assert.ok(line.startsWith(GUIDANCE), 'guidance line, got: ' + line);
  assert.ok(line.includes(HEALTH_EXCEPTION), 'exception sentence, got: ' + line);
  assert.ok(!/http:\/\/127\.0\.0\.1:/.test(r.stdout), 'no address on a failed health check');
  rmSync(agent, { recursive: true, force: true });
});

test('install prints one guidance line when server.json is absent', () => {
  const agent = makeAgentDir();
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastLine(r), GUIDANCE, 'one guidance line, got: ' + JSON.stringify(r.stdout));
  assert.ok(!/http:\/\/127\.0\.0\.1:/.test(r.stdout), 'no address without server.json');
  rmSync(agent, { recursive: true, force: true });
});

test('install rejects an oversized server record without announcing its address', async () => {
  const agent = makeAgentDir();
  const health = await healthServer();
  try {
    // A usable, healthy address hidden behind an over-limit record: the record must be refused on
    // size alone (the size is checked before the content is read), so no address is ever announced.
    mkdirSync(join(agent, 'briefing', 'state'), { recursive: true });
    writeFileSync(join(agent, 'briefing', 'state', 'server.json'), JSON.stringify({
      pid: process.pid, at: 'fixture', nonce: 'fixture', sessionId: 'owner',
      port: health.port, generation: 4, padding: 'x'.repeat(8 * 1024 * 1024),
    }));
    const r = await runAsync(['--agent-dir', agent]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastLine(r), GUIDANCE, 'guidance line, got: ' + lastLine(r));
    assert.ok(!r.stdout.includes(String(health.port)), 'an oversized record must not produce an address');
    assert.equal(r.stderr, '', 'no stack trace on stderr');
    rmSync(agent, { recursive: true, force: true });
  } finally {
    await health.stop();
  }
});

test('install retries a transient EPERM on the record and still announces the live address', async () => {
  const agent = makeAgentDir();
  const health = await healthServer();
  const log = join(agent, 'record-calls.txt');
  try {
    seedServerRecord(join(agent, 'briefing', 'state'), health.port);
    const flaky = flakyIoPreload({ failures: 1, log });
    let r;
    try { r = await runAsync(['--agent-dir', agent], flaky.env); } finally { flaky.cleanup(); }
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastLine(r), `실시간 상황판: http://127.0.0.1:${health.port}/`,
      'one transient read failure must not hide a healthy board: ' + lastLine(r));
    assert.equal(r.stderr, '');
    assert.ok(readFileSync(log, 'utf8').length >= 2, 'the record was read again after the transient failure');
    rmSync(agent, { recursive: true, force: true });
  } finally {
    await health.stop();
  }
});

test('install gives up after bounded retries on a persistent EPERM and calls it unreadable', () => {
  const agent = makeAgentDir();
  const log = join(agent, 'record-calls.txt');
  seedServerRecord(join(agent, 'briefing', 'state'), 47560);
  const flaky = flakyIoPreload({ failures: Number.MAX_SAFE_INTEGER, log });
  let r;
  try { r = run(['--agent-dir', agent], flaky.env); } finally { flaky.cleanup(); }
  assert.equal(r.status, 0, r.stderr);
  const line = lastLine(r);
  assert.ok(line.startsWith(GUIDANCE), 'one closing guidance line, got: ' + line);
  assert.ok(line.includes(HEALTH_EXCEPTION), 'a persistent failure is unreadable, not absent: ' + line);
  assert.equal(r.stderr, '', 'no stack trace');
  const calls = readFileSync(log, 'utf8').length;
  assert.ok(calls > 1, 'the read boundary retried, got ' + calls + ' record calls');
  assert.ok(calls <= 8, 'retries must stay bounded, got ' + calls + ' record calls');
  rmSync(agent, { recursive: true, force: true });
});

test('install tells an unreadable record apart from an absent one', () => {
  const absentAgent = makeAgentDir();
  const absent = run(['--agent-dir', absentAgent]);
  const unreadableAgent = makeAgentDir();
  mkdirSync(join(unreadableAgent, 'briefing', 'state', 'server.json'), { recursive: true }); // a directory in its place
  const unreadable = run(['--agent-dir', unreadableAgent]);
  try {
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(unreadable.status, 0, unreadable.stderr);
    const absentLine = lastLine(absent);
    const unreadableLine = lastLine(unreadable);
    assert.equal(absentLine, GUIDANCE, 'ENOENT: exactly the one guidance line');
    assert.ok(unreadableLine.startsWith(GUIDANCE), 'unreadable keeps the one closing line: ' + unreadableLine);
    assert.ok(unreadableLine.includes(HEALTH_EXCEPTION), 'unreadable adds the exception sentence: ' + unreadableLine);
    assert.notEqual(unreadableLine, absentLine, 'an unreadable record must not look like an absent one');
    assert.equal(unreadable.stderr, '', 'no stack trace');
  } finally {
    rmSync(absentAgent, { recursive: true, force: true });
    rmSync(unreadableAgent, { recursive: true, force: true });
  }
});

test('second install creates generation-000002 and leaves generation-000001 untouched', () => {
  const agent = makeAgentDir();
  assert.equal(run(['--agent-dir', agent]).status, 0);
  const before = tree(join(agent, 'briefing', 'integration', 'generation-000001'))
    .map((f) => sha256(join(agent, 'briefing', 'integration', 'generation-000001', f)));
  assert.equal(run(['--agent-dir', agent]).status, 0);
  const after = tree(join(agent, 'briefing', 'integration', 'generation-000001'))
    .map((f) => sha256(join(agent, 'briefing', 'integration', 'generation-000001', f)));
  assert.deepEqual(after, before);
  assert.ok(statSync(join(agent, 'briefing', 'integration', 'generation-000002')).isDirectory());
  assert.ok(readFileSync(join(agent, 'extensions', 'omo-briefing.js'), 'utf8').includes('generation-000002'));
  const current = JSON.parse(readFileSync(join(agent, 'briefing', 'current.json'), 'utf8'));
  assert.equal(current.generation, 'generation-000002');
  rmSync(agent, { recursive: true, force: true });
});

test('non-managed omo-briefing.js refuses with exit 1 and writes nothing', () => {
  const agent = makeAgentDir();
  writeFileSync(join(agent, 'extensions', 'omo-briefing.js'), '// user file\n');
  const before = tree(agent);
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(tree(agent), before);
  rmSync(agent, { recursive: true, force: true });
});

test('--dry-run writes nothing', () => {
  const agent = makeAgentDir();
  const before = tree(agent);
  const r = run(['--agent-dir', agent, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('generation-000001'), 'dry-run lists the generation');
  assert.deepEqual(tree(agent), before);
  rmSync(agent, { recursive: true, force: true });
});

test('--dry-run on a reinstall lists the re-render and writes nothing', () => {
  const agent = makeAgentDir();
  assert.equal(run(['--agent-dir', agent]).status, 0);
  const state = join(agent, 'briefing', 'state');
  seedBoard(state, 42, 'OWNER-BOARD');
  const before = tree(agent).map((f) => f + ':' + sha256(join(agent, f)));
  const r = run(['--agent-dir', agent, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('generation-000002'), 'dry-run lists the next generation');
  assert.ok(/re-render/.test(r.stdout), 'dry-run lists the re-render, got: ' + r.stdout);
  assert.deepEqual(tree(agent).map((f) => f + ':' + sha256(join(agent, f))), before);
  rmSync(agent, { recursive: true, force: true });
});

test('--uninstall removes only the managed shim', () => {
  const agent = makeAgentDir();
  assert.equal(run(['--agent-dir', agent]).status, 0);
  const before = tree(agent).filter((f) => f.replace(/\\/g, '/') !== 'extensions/omo-briefing.js');
  assert.equal(run(['--agent-dir', agent, '--uninstall']).status, 0);
  assert.deepEqual(tree(agent), before);
  assert.ok(statSync(join(agent, 'briefing', 'integration', 'generation-000001')).isDirectory());
  assert.ok(statSync(join(agent, 'briefing', 'state', 'index.html')).isFile());
  rmSync(agent, { recursive: true, force: true });
});

test('other files in extensions/ keep their bytes', () => {
  const agent = makeAgentDir();
  const hashBefore = sha256(join(agent, 'extensions', 'other-ext.js'));
  assert.equal(run(['--agent-dir', agent]).status, 0);
  assert.equal(run(['--agent-dir', agent]).status, 0);
  assert.equal(run(['--agent-dir', agent, '--uninstall']).status, 0);
  assert.equal(sha256(join(agent, 'extensions', 'other-ext.js')), hashBefore);
  rmSync(agent, { recursive: true, force: true });
});

test('missing agent dir and missing dist fail without writing', () => {
  const missing = join(os.tmpdir(), 'briefing-no-such-dir-xyz');
  const r = run(['--agent-dir', missing]);
  assert.equal(r.status, 1);
});

test('reinstall re-renders a seeded seq-42 board through the renderer at seq 43', () => {
  const agent = makeAgentDir();
  assert.equal(run(['--agent-dir', agent]).status, 0);
  const state = join(agent, 'briefing', 'state');
  seedBoard(state, 42, 'OWNER-BOARD');
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 0, r.stderr);
  const pub = JSON.parse(readFileSync(join(state, 'published.json'), 'utf8'));
  assert.equal(pub.seq, 43, 'renderer publishes published.json seq + 1');
  const data = readFileSync(join(state, 'data.js'), 'utf8');
  assert.match(data, /\/\* seq:43 \*\//, 'data.js carries the new seq');
  assert.equal(pub.dataHash, createHash('sha256').update(data).digest('hex'));
  // The old board was replaced by the renderer shell, but its conversation card is kept.
  const html = readFileSync(join(state, 'index.html'), 'utf8');
  assert.ok(html.includes('<div id="app">'), 'renderer shell, got: ' + html.slice(0, 120));
  assert.ok(data.includes('OWNER-BOARD-42'), 'existing card kept');
  assert.ok(!html.includes('<article>'), 'the old page is not kept verbatim');
  assert.ok(readFileSync(join(agent, 'extensions', 'omo-briefing.js'), 'utf8').includes('generation-000002'));
  assert.ok(!existsSync(join(state, 'render.lock')), 'lock released after publishing');
  rmSync(agent, { recursive: true, force: true });
});

test('reinstall stamps the page with the installed generation and an older generation leaves index.html alone', () => {
  const agent = makeAgentDir();
  assert.equal(run(['--agent-dir', agent]).status, 0);
  const state = join(agent, 'briefing', 'state');
  seedBoard(state, 42, 'OWNER-BOARD');
  const r = run(['--agent-dir', agent]); // installs generation-000002 and re-renders
  assert.equal(r.status, 0, r.stderr);
  const htmlPath = join(state, 'index.html');
  assert.match(readFileSync(htmlPath, 'utf8'), /<meta name="omo-briefing-generation" content="2">/, 'installer page carries generation 2');
  const htmlBefore = readFileSync(htmlPath);
  const seqBefore = JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')).seq;
  // A new record, so the older-generation publish really runs and changes data.js.
  mkdirSync(join(state, 'sessions', 'late', 'briefs'), { recursive: true });
  writeFileSync(join(state, 'sessions', 'late', 'meta.json'), JSON.stringify({
    sessionId: 'late', cwd: 'C:/work/late-project', title: 'LATE', lastActivityAt: Date.now(),
  }));
  writeFileSync(join(state, 'sessions', 'late', 'briefs', '000001.json'), JSON.stringify({
    at: Date.now(), brief: { title: 'LATE', status: 'in_progress', headline: 'LATE-HEAD', changes: [] },
  }));
  const res = renderPage(openStore(state), Date.now(), { generation: 1 });
  assert.equal(res.ok, true, res.error);
  assert.ok(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')).seq > seqBefore, 'older generation still published data');
  assert.ok(readFileSync(join(state, 'data.js'), 'utf8').includes('LATE-HEAD'), 'data.js carries the new record');
  assert.ok(readFileSync(htmlPath).equals(htmlBefore), 'index.html byte-identical after an older-generation render');
  rmSync(agent, { recursive: true, force: true });
});

test('reinstall never publishes a lower seq than a board without published.json', () => {
  const agent = makeAgentDir();
  assert.equal(run(['--agent-dir', agent]).status, 0);
  const state = join(agent, 'briefing', 'state');
  seedBoard(state, 42, 'OWNER-BOARD');
  rmSync(join(state, 'published.json'));
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')).seq, 43);
  rmSync(agent, { recursive: true, force: true });
});

test('installer skips the re-render with a reason while a live-owner render.lock is held', () => {
  const agent = makeAgentDir();
  assert.equal(run(['--agent-dir', agent]).status, 0);
  const state = join(agent, 'briefing', 'state');
  seedBoard(state, 43, 'OWNER-BOARD');
  const lock = JSON.stringify({ pid: process.pid, at: 'fixture', nonce: randomBytes(8).toString('hex') });
  writeFileSync(join(state, 'render.lock'), lock);
  const before = boardBytes(state);
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/건너뜀/.test(r.stdout), 'skip reason printed, got: ' + r.stdout);
  assert.deepEqual(boardBytes(state), before, 'board untouched');
  assert.equal(readFileSync(join(state, 'render.lock'), 'utf8'), lock, 'lock untouched');
  assert.ok(statSync(join(agent, 'briefing', 'integration', 'generation-000002')).isDirectory());
  assert.ok(readFileSync(join(agent, 'extensions', 'omo-briefing.js'), 'utf8').includes('generation-000002'));
  rmSync(agent, { recursive: true, force: true });
});

test('stale-lock reclaim link failure surfaces manual-check error and writes no page', () => {
  const agent = makeAgentDir();
  const state = join(agent, 'briefing', 'state');
  mkdirSync(state, { recursive: true });
  const deadPid = 2147483647;
  const lock = JSON.stringify({ pid: deadPid, at: 'fixture', nonce: randomBytes(8).toString('hex') });
  writeFileSync(join(state, 'render.lock'), lock);
  const deny = denyLinkPreload();
  let r;
  try {
    r = spawnSync(process.execPath, [INSTALL, '--agent-dir', agent], { encoding: 'utf8', env: deny.env });
  } finally {
    deny.cleanup();
  }
  assert.notEqual(r.status, 0, 'reclaim failure must exit non-zero, got: ' + r.stdout + r.stderr);
  assert.ok((r.stdout + r.stderr).includes('수동 확인 필요'), 'manual-check message, got: ' + r.stdout + r.stderr);
  assert.ok(!existsSync(join(state, 'index.html')), 'no page on reclaim failure');
  assert.ok(!existsSync(join(state, 'published.json')), 'no publication on reclaim failure');
  assert.equal(readFileSync(join(state, 'render.lock'), 'utf8'), lock, 'stale lock untouched');
  rmSync(agent, { recursive: true, force: true });
});

test('stale-lock reclaim link failure on an existing board exits non-zero and keeps the board', () => {
  const agent = makeAgentDir();
  const state = join(agent, 'briefing', 'state');
  seedBoard(state, 42, 'OWNER-BOARD');
  const lock = JSON.stringify({ pid: 2147483647, at: 'fixture', nonce: randomBytes(8).toString('hex') });
  writeFileSync(join(state, 'render.lock'), lock);
  const before = boardBytes(state);
  const deny = denyLinkPreload();
  let r;
  try {
    r = spawnSync(process.execPath, [INSTALL, '--agent-dir', agent], { encoding: 'utf8', env: deny.env });
  } finally {
    deny.cleanup();
  }
  assert.notEqual(r.status, 0, 'reclaim failure must exit non-zero, got: ' + r.stdout + r.stderr);
  assert.ok((r.stdout + r.stderr).includes('수동 확인 필요'), 'manual-check message, got: ' + r.stdout + r.stderr);
  assert.deepEqual(boardBytes(state), before, 'board untouched on reclaim failure');
  assert.equal(readFileSync(join(state, 'render.lock'), 'utf8'), lock, 'stale lock untouched');
  rmSync(agent, { recursive: true, force: true });
});

test('fresh install with a stale render.lock reclaims it and writes the empty page', () => {
  const agent = makeAgentDir();
  const state = join(agent, 'briefing', 'state');
  mkdirSync(state, { recursive: true });
  const deadPid = 2147483647;
  const lock = JSON.stringify({ pid: deadPid, at: 'fixture', nonce: randomBytes(8).toString('hex') });
  writeFileSync(join(state, 'render.lock'), lock);
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 0, r.stderr);
  const pub = JSON.parse(readFileSync(join(state, 'published.json'), 'utf8'));
  assert.equal(pub.seq, 0);
  assert.ok(readFileSync(join(state, 'index.html'), 'utf8').includes('아직 보고 없음'));
  rmSync(agent, { recursive: true, force: true });
});

test('reinstall of a STATE with conversation records but no publication files renders them, never an empty board', () => {
  const agent = makeAgentDir();
  const state = join(agent, 'briefing', 'state');
  seedBoard(state, 42, 'OWNER-BOARD');
  for (const n of ['index.html', 'data.js', 'published.json']) rmSync(join(state, n));
  const lock = JSON.stringify({ pid: process.pid, at: 'fixture', nonce: randomBytes(8).toString('hex') });
  writeFileSync(join(state, 'render.lock'), lock);
  const first = run(['--agent-dir', agent]); // live lock: page skipped, generation/shim installed
  assert.equal(first.status, 0, first.stderr);
  assert.ok(!existsSync(join(state, 'data.js')), 'no publication while the lock is held');
  rmSync(join(state, 'render.lock'));
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 0, r.stderr);
  const data = readFileSync(join(state, 'data.js'), 'utf8');
  assert.ok(data.includes('OWNER-BOARD-42'), 'stored card rendered, got: ' + data.slice(0, 200));
  assert.ok(!data.includes('"sessions":[]'), 'not an empty board');
  assert.equal(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')).seq, 1);
  assert.ok(readFileSync(join(state, 'index.html'), 'utf8').includes('<div id="app">'), 'renderer shell');
  assert.ok(!existsSync(join(state, 'render.lock')), 'lock released');
  rmSync(agent, { recursive: true, force: true });
});

test('--dry-run on a STATE with records but no publication files lists the re-render', () => {
  const agent = makeAgentDir();
  const state = join(agent, 'briefing', 'state');
  seedBoard(state, 42, 'OWNER-BOARD');
  for (const n of ['index.html', 'data.js', 'published.json']) rmSync(join(state, n));
  const before = tree(agent);
  const r = run(['--agent-dir', agent, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/re-render/.test(r.stdout), 'dry-run lists the re-render, got: ' + r.stdout);
  assert.deepEqual(tree(agent), before);
  rmSync(agent, { recursive: true, force: true });
});

test('reinstall never publishes below the data.js seq when published.json is older', () => {
  const agent = makeAgentDir();
  assert.equal(run(['--agent-dir', agent]).status, 0);
  const state = join(agent, 'briefing', 'state');
  seedBoard(state, 87, 'OWNER-BOARD');
  writeFileSync(join(state, 'published.json'), JSON.stringify({ seq: 42, at: 'fixture', dataHash: 'x' }));
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')).seq, 88);
  assert.match(readFileSync(join(state, 'data.js'), 'utf8'), /\/\* seq:88 \*\//);
  rmSync(agent, { recursive: true, force: true });
});

test('reinstall with a dead-owner render.lock reclaims it and re-renders the board', () => {
  const agent = makeAgentDir();
  assert.equal(run(['--agent-dir', agent]).status, 0);
  const state = join(agent, 'briefing', 'state');
  seedBoard(state, 42, 'OWNER-BOARD');
  writeFileSync(join(state, 'render.lock'), JSON.stringify({
    pid: 2147483647, at: 'fixture', nonce: randomBytes(8).toString('hex'),
  }));
  const r = run(['--agent-dir', agent]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')).seq, 43);
  assert.ok(readFileSync(join(state, 'data.js'), 'utf8').includes('OWNER-BOARD-42'));
  rmSync(agent, { recursive: true, force: true });
});
