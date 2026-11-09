import './helpers/refuse-live-writes.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeProvenance } from '../scripts/qa-roadmap.mjs';
import { kanbanEvidenceFailures } from '../scripts/qa-roadmap-gate.mjs';
import { tempDir } from './helpers/temp.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');

test('provenance includes the actual inlined scripts, styles and icon assets', () => {
  const p = computeProvenance(path.join(root, 'test/fixtures/roadmap/full.json'));
  for (const file of [
    'src/page/generated/page.min.js',
    'src/page/generated/view.min.js',
    'src/page/generated/profiles-view.min.js',
    'src/page/office.css',
    'src/page/office-view.js',
    'assets/icons/lucide/LICENSE',
    'assets/icons/lucide/app-window.svg',
  ]) assert.equal(p.files[file], hash(file), file);
  assert.equal(p.qaScriptSha256, hash('scripts/qa-roadmap.mjs'));
});

test('kanban gate fails closed for a missing action and unproven cleanup', t => {
  const { dir } = tempDir(t, 'roadmap-kanban-gate-');
  const p = computeProvenance(path.join(root, 'test/fixtures/roadmap/full.json'));
  for (const [name, value] of Object.entries({
    'capture-manifest.json': { provenance: p, captures: {} },
    'actions.json': [],
    'geometry.json': {},
    'cleanup.json': { browser: { closed: true }, server: { closed: true } },
  })) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  const failures = kanbanEvidenceFailures(dir, p);
  assert.ok(failures.includes('kanban actions missing, failed, or incomplete'));
  assert.ok(failures.includes('kanban action missing: sse-generation-draft-focus-and-single-reload'));
  assert.ok(failures.includes('kanban cleanup not proven'));
  assert.ok(failures.includes('kanban geometry missing'));
});

test('kanban capture gate consumes the runner artifact schema without legacy rail artifacts', t => {
  const { dir } = tempDir(t, 'roadmap-kanban-success-');
  const fixture = path.join(root, 'test/fixtures/roadmap/all-states-edge.json');
  const provenance = computeProvenance(fixture);
  // Structural evidence-validator fixture, not proof of visual quality.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0p8AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(dir, 'fixture.png'), png);
  const captures = {};
  const variants = ['390x844', '1024x768', '1440x900', '320x640', '1180x700', '1920x1080'];
  for (const viewport of variants) for (const theme of ['light', 'dark']) {
    captures[viewport + theme] = { viewport, theme, path: 'fixture.png', width: 1, height: 1, bytes: png.length,
      sha256: crypto.createHash('sha256').update(png).digest('hex') };
  }
  for (const state of ['stress:zoom-200pct', 'stress:increased-letter-spacing', 'mobile:sheet-after-status-change', 'reduced-motion:attention-jump']) {
    captures[state] = { ...captures['390x844light'], state };
  }
  const names = ['sse-generation-draft-focus-and-single-reload', 'pointer-hold-sse-node-preserved',
    'mobile-sheet-survives-status-column-change', 'reduced-motion-attention-jump', 'vanishing-stage-notice-close-focus'];
  const actions = names.map(name => ({ name, pass: true, inputMethod: 'fixture', expected: {}, observed: {} }));
  const records = {
    'capture-manifest.json': { provenance, captures },
    'actions.json': actions,
    'geometry.json': { desktopHeadings: {}, attentionJump: {} },
    'cleanup.json': { browser: { closed: true, pidAlive: false, portListening: false, command: 'fixture' },
      server: { closed: true, pidAlive: false, portListening: false, command: 'fixture' }, errors: [] },
  };
  for (const [name, value] of Object.entries(records)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/qa-roadmap-gate.mjs'),
    '--fixture', fixture, '--out', path.join(dir, 'gate'), '--evidence', dir], { encoding: 'utf8' });
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const verdict = JSON.parse(fs.readFileSync(path.join(dir, 'gate/verdict.json'), 'utf8'));
  assert.equal(verdict.pass, true);
  assert.equal(verdict.scope, 'kanban-capture-evidence');
  actions[0].pass = false;
  fs.writeFileSync(path.join(dir, 'actions.json'), JSON.stringify(actions));
  const refused = run();
  assert.equal(refused.status, 1, 'the same gate must reject a failed required action');
});
