#!/usr/bin/env node
import '../test/helpers/refuse-live-writes.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeProvenance } from './qa-roadmap.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function kanbanEvidenceFailures(dir, provenance) {
  const failures = [];
  let manifest, actions, geometry, cleanup;
  try {
    manifest = json(path.join(dir, 'capture-manifest.json'));
    actions = json(path.join(dir, 'actions.json'));
    geometry = json(path.join(dir, 'geometry.json'));
    cleanup = json(path.join(dir, 'cleanup.json'));
  } catch (error) {
    return [`kanban evidence missing or unreadable: ${error.message}`];
  }
  const recorded = manifest.provenance || {};
  for (const key of ['fixtureSha256', 'qaScriptSha256', 'sourceHash']) {
    if (recorded[key] !== provenance[key]) failures.push(`kanban provenance mismatch: ${key}`);
  }
  if (JSON.stringify(recorded.files) !== JSON.stringify(provenance.files)) failures.push('kanban inline source inventory mismatch');
  if (!/^[a-f0-9]{64}$/.test(recorded.payloadHtmlSha256 || '') || !(recorded.payloadHtmlBytes > 0)) failures.push('kanban served HTML identity missing');
  for (const [file, digest] of Object.entries(recorded.files || {})) {
    if (!fs.existsSync(path.join(root, file)) || hash(path.join(root, file)) !== digest) failures.push(`kanban source mismatch: ${file}`);
  }
  if (!Array.isArray(actions) || !actions.length || actions.some(action =>
    action.pass !== true || !action.name || !action.inputMethod || action.expected === undefined || action.observed === undefined)) {
    failures.push('kanban actions missing, failed, or incomplete');
  }
  for (const name of ['sse-generation-draft-focus-and-single-reload', 'pointer-hold-sse-node-preserved',
    'mobile-sheet-survives-status-column-change', 'reduced-motion-attention-jump', 'vanishing-stage-notice-close-focus']) {
    if (!Array.isArray(actions) || !actions.some(action => action.name === name && action.pass === true)) failures.push(`kanban action missing: ${name}`);
  }
  const captures = Object.values(manifest.captures || {});
  for (const viewport of ['390x844', '1024x768', '1440x900']) for (const theme of ['light', 'dark']) {
    if (!captures.some(c => c.viewport === viewport && c.theme === theme)) failures.push(`kanban capture missing: ${viewport} ${theme}`);
  }
  for (const viewport of ['320x640', '1180x700', '1920x1080']) {
    if (!captures.some(c => c.viewport === viewport)) failures.push(`kanban capture missing: ${viewport}`);
  }
  for (const state of ['stress:zoom-200pct', 'stress:increased-letter-spacing', 'mobile:sheet-after-status-change', 'reduced-motion:attention-jump']) {
    if (!captures.some(c => c.state === state)) failures.push(`kanban capture missing: ${state}`);
  }
  for (const shot of captures) {
    const file = path.resolve(dir, shot.path);
    if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) { failures.push(`kanban PNG missing: ${shot.path}`); continue; }
    const data = fs.readFileSync(file);
    if (data.length !== shot.bytes || data.length < 24 || data.readUInt32BE(16) !== shot.width ||
        data.readUInt32BE(20) !== shot.height || hash(file) !== shot.sha256) failures.push(`kanban PNG mismatch: ${shot.path}`);
  }
  if (!geometry.desktopHeadings || !geometry.attentionJump) failures.push('kanban geometry missing');
  if (cleanup.browser?.closed !== true || cleanup.browser?.pidAlive !== false || cleanup.browser?.portListening !== false ||
      cleanup.server?.closed !== true || cleanup.server?.pidAlive !== false || cleanup.server?.portListening !== false ||
      !cleanup.browser?.command || !cleanup.server?.command || cleanup.errors?.length) failures.push('kanban cleanup not proven');
  return failures;
}

export function reviewFailures(receipts, expected) {
  const failures = [];
  const names = new Set();
  for (const [index, review] of receipts.entries()) {
    const label = `visual-${index ? 'b' : 'a'}`;
    if (!review || typeof review !== 'object') { failures.push(`${label}: missing`); continue; }
    if (typeof review.reviewer !== 'string' || !review.reviewer.trim() || names.has(review.reviewer)) failures.push(`${label}: reviewer identity`);
    names.add(review.reviewer);
    if (review.pass !== true || !Array.isArray(review.findings) || review.findings.length) failures.push(`${label}: verdict or findings`);
    const scope = index ? ['A', 'B', 'C', 'D', 'E', 'F'] : ['G', 'H', 'I', 'J'];
    const scopeMatches = JSON.stringify(review.scope) === JSON.stringify(scope) || (typeof review.scope === 'string' && new RegExp(`^${index ? 'A-F' : 'G-J'}\\b`).test(review.scope));
    if (!scopeMatches) failures.push(`${label}: scope`);
    if (expected.supplementalCaptures) {
      const supplement = review.supplementalCaptures;
      if (!supplement || JSON.stringify(Object.keys(supplement).sort()) !== JSON.stringify(Object.keys(expected.supplementalCaptures).sort())) {
        failures.push(`${label}: supplemental inventory`);
      } else {
        for (const [file, digest] of Object.entries(expected.supplementalCaptures)) {
          const item = supplement[file];
          const actualDigest = typeof item === 'string' ? item : item?.sha256;
          if (actualDigest !== digest || !fs.existsSync(file) || hash(file) !== digest) failures.push(`${label}: supplemental hash ${file}`);
          if (typeof item === 'object' && item?.capturedAt !== expected.supplementalCaptureTimes?.[file]) failures.push(`${label}: supplemental time ${file}`);
        }
      }
      const supplementTime = review.supplementalCapturedAt ?? (supplement && Object.values(supplement).every(item => typeof item === 'object') ? Object.values(supplement).map(item => item.capturedAt).sort().at(-1) : undefined);
      if (supplementTime !== expected.supplementalCapturedAt || Date.parse(review.reviewedAt) < Date.parse(expected.supplementalCapturedAt)) failures.push(`${label}: supplemental time`);
    }
    if (review.sourceHash !== expected.sourceHash || review.payloadHtmlSha256 !== expected.payloadHtmlSha256) failures.push(`${label}: build identity`);
    const captured = Date.parse(review.capturedAt), reviewed = Date.parse(review.reviewedAt);
    if ((review.capturedAt !== expected.capturedAt && review.capturedAt !== expected.supplementalCapturedAt) || !Number.isFinite(reviewed) || reviewed < captured) failures.push(`${label}: capture or review time`);
    const captures = review.captures;
    if (!captures || typeof captures !== 'object' || Array.isArray(captures) || JSON.stringify(Object.keys(captures).sort()) !== JSON.stringify(Object.keys(expected.captures).sort())) {
      failures.push(`${label}: capture inventory`);
    } else {
      for (const [file, digest] of Object.entries(expected.captures)) {
        if (captures[file] !== digest || !fs.existsSync(file) || hash(file) !== digest) failures.push(`${label}: capture hash ${file}`);
      }
    }
  }
  return failures;
}

export function captureMatrixFailures(index, provenance) {
  const failures = [];
  for (const key of ['sourceHash', 'payloadHtmlSha256']) {
    if (index[key] !== provenance[key]) failures.push(`matrix identity: ${key}`);
  }
  const shots = Object.values(index.captures);
  for (const viewport of ['390x844', '1024x768', '1180x700', '1440x900', '1920x1080']) {
    for (const theme of ['light', 'dark']) {
      const states = viewport === '1920x1080' ? ['filter:all', 'detail:R6b', 'scroll:end'] : ['filter:all', 'filter:ready', 'filter:decisionNeeded', 'filter:blocked', 'detail:R6b', 'scroll:end'];
      for (const state of states) {
        if (!shots.some((shot) => shot.viewport === viewport && shot.theme === theme && shot.state === state && (viewport !== '390x844' || shot.mobile === true))) {
          failures.push(`matrix missing: ${viewport} ${theme} ${state}`);
        }
      }
    }
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);
  if ((args.length !== 4 && args.length !== 6) || args[0] !== '--fixture' || args[2] !== '--out' || (args.length === 6 && args[4] !== '--evidence')) throw new Error('Usage: node scripts/qa-roadmap-gate.mjs --fixture <path> --out <directory> [--evidence <capture-directory>]');
  const fixture = path.resolve(args[1]), out = path.resolve(args[3]);
  const previous = args[5] ? path.resolve(args[5]) : path.resolve(out, '../task-6-r9');
  const installEvidence = path.resolve(previous, '../task-8-r9');
  fs.mkdirSync(out, { recursive: true });
  const provenance = computeProvenance(fixture);
  if (path.basename(fixture) === 'all-states-edge.json') {
    const failures = kanbanEvidenceFailures(previous, provenance);
    // The kanban runner produces capture evidence, not the legacy rail's
    // install/review/full-suite package. Never report this as those approvals.
    const verdict = { scope: 'kanban-capture-evidence', pass: failures.length === 0, failures: failures.length, details: failures };
    fs.writeFileSync(path.join(out, 'verdict.json'), JSON.stringify(verdict, null, 2));
    console.log(JSON.stringify(verdict));
    process.exitCode = verdict.pass ? 0 : 1;
    return;
  }
  const captureIndex = json(path.join(previous, 'capture-index.json'));
  const measurements = json(path.join(previous, 'measurements.json'));
  const captures = Object.fromEntries(Object.values(captureIndex.captures).map(({ path: rel, sha256 }) => [path.resolve(previous, rel).replaceAll('\\', '/'), sha256]));
  const capturedAt = measurements.capturedAt;
  const detailDir = path.resolve(previous, '../task-6-detail-r9');
  const detail = json(path.join(detailDir, 'detail.json'));
  const supplementalCaptures = Object.fromEntries(detail.captures.map(shot => [path.resolve(detailDir, shot.path).replaceAll('\\', '/'), shot.sha256]));
  const supplementalCapturedAt = detail.captures.map(shot => shot.capturedAt).sort().at(-1);
  const supplementalCaptureTimes = Object.fromEntries(detail.captures.map(shot => [path.resolve(detailDir, shot.path).replaceAll('\\', '/'), shot.capturedAt]));
  const expected = { ...provenance, capturedAt, captures, supplementalCaptures, supplementalCapturedAt, supplementalCaptureTimes };
  const failures = [];
  if (detail.pass !== true || detail.provenance.sourceHash !== provenance.sourceHash || detail.provenance.payloadHtmlSha256 !== provenance.payloadHtmlSha256 ||
      detail.captures.length !== 2 || !['dark', 'light'].every(theme => detail.captures.some(shot => shot.theme === theme &&
        shot.visible === true && shot.hit === true && shot.sidebarClosed === true && shot.width === 390 && shot.height === 844 &&
        shot.top >= shot.mainTop && shot.top < shot.mainBottom && shot.bottom > shot.mainTop))) failures.push('supplemental detail visibility or identity');
  failures.push(...captureMatrixFailures(json(path.join(previous, 'capture-index.json')), provenance));
  for (const key of ['pass', 'allMatrixFiltersPass', 'allVisualAuditsPass', 'allStressPass', 'allControlsNamed', 'allTabFamiliesReached']) {
    if (measurements[key] !== true) failures.push(`browser acceptance: ${key}`);
  }
  if (measurements.exitCode !== 0 || measurements.rows1180x700 !== measurements.stageCount || measurements.rows1440x900 !== measurements.stageCount ||
      measurements.scrollBudget1180x700 > 1 || measurements.scrollBudget1440x900 > 1 ||
      measurements.falseReady !== 0 || measurements.categoryMismatch !== 0 || measurements.forbiddenScroll !== 0) failures.push('browser geometry or truth');
  const install = json(path.join(installEvidence, 'install.json'));
  const sourceManifest = path.join(installEvidence, 'candidate-source-hashes.json');
  if (install.status !== 'pass' || install.exitCode !== 0 || hash(sourceManifest) !== install.sourceHashManifestSha256) failures.push('isolated install receipt');
  for (const [file, digest] of Object.entries(json(sourceManifest))) {
    if (!fs.existsSync(path.join(root, file)) || hash(path.join(root, file)) !== digest) failures.push(`isolated install source mismatch: ${file}`);
  }
  for (const key of ['sourceHash', 'payloadHtmlSha256', 'fixtureSha256', 'qaScriptSha256']) {
    if (measurements.provenance[key] !== provenance[key]) failures.push(`capture provenance mismatch: ${key}`);
  }
  const receipts = ['visual-a-r9.json', 'visual-b-r9.json'].map((name) => {
    try { return json(path.resolve(previous, '../final', name)); } catch (error) {
      if (error instanceof Error) { failures.push(`${name}: ${error.message}`); return null; }
      throw error;
    }
  });
  failures.push(...reviewFailures(receipts, expected));
  if (failures.length) {
    const verdict = { pass: false, failures: failures.length, details: failures };
    fs.writeFileSync(path.join(out, 'verdict.json'), JSON.stringify(verdict, null, 2));
    console.log(JSON.stringify(verdict));
    process.exitCode = 1;
    return;
  }
  const commands = [
    ['build', 'npm run build'],
    ['test', 'npm test'],
    ['timing', 'npm run check:timing'],
  ].map(([name, command]) => {
    const env = { ...process.env, ...install.environment };
    const result = spawnSync(command, { cwd: root, shell: true, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const log = path.join(out, `${name}.log`);
    fs.writeFileSync(log, `${result.stdout || ''}${result.stderr || ''}${result.error ? `\n${result.error.message}\n` : ''}`);
    const exitCode = result.status;
    if (exitCode !== 0) failures.push(`${name}: exit ${exitCode}${result.signal ? ` signal ${result.signal}` : ''}`);
    return { name, command, exitCode, signal: result.signal, log, logSha256: hash(log) };
  });
  try {
    const browser = measurements;
    for (const key of ['sourceHash', 'payloadHtmlSha256', 'fixtureSha256', 'qaScriptSha256']) {
      if (browser.provenance[key] !== provenance[key]) failures.push(`browser provenance mismatch: ${key}`);
    }
    if (browser.pass !== true || browser.exitCode !== 0 || Object.values(browser.siblings).some((item) => item.pass !== true)) failures.push('browser acceptance or sibling regressions');
  } catch (error) {
    if (error instanceof Error) failures.push(`browser evidence: ${error.message}`);
    else throw error;
  }
  const result = { pass: failures.length === 0, failures: failures.length, details: failures };
  fs.writeFileSync(path.join(out, 'commands.json'), JSON.stringify(commands, null, 2));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ provenance, captureManifest: path.join(previous, 'capture-index.json'), captureManifestSha256: hash(path.join(previous, 'capture-index.json')), installReceipt: path.join(installEvidence, 'install.json'), installReceiptSha256: hash(path.join(installEvidence, 'install.json')), ...expected }, null, 2));
  fs.writeFileSync(path.join(out, 'verdict.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exitCode = result.pass ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outIndex = process.argv.indexOf('--out');
    if (outIndex >= 0 && process.argv[outIndex + 1]) {
      const out = path.resolve(process.argv[outIndex + 1]);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'verdict.json'), JSON.stringify({ pass: false, failures: 1, details: [message] }, null, 2));
    }
    console.error(message);
    process.exitCode = 1;
  }
}
