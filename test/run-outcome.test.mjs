// The rpc-run closing line and cleanup rule (test/integration/run-outcome.mjs): a run that failed without
// throwing must never print a success-looking line, and only a work dir this run created itself may be
// removed automatically. The exit code is the verdict; the reporters are injected spies here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outcomeLine, reportOutcome, shouldRemoveWork } from './integration/run-outcome.mjs';

const spies = () => {
  const logs = [];
  const errors = [];
  return { logs, errors, log: (line) => logs.push(line), error: (line) => errors.push(line) };
};

// Runs the real rpc-run CLI as a child. TEMP/TMP are pinned to a private root; the rest of the env (including
// NODE_OPTIONS, which carries a mutant preload in the mutation runs) is inherited so an in-memory mutant
// reaches this child exactly as it reaches any other test child.
function runRpcRun(args, { cwd, tmp }) {
  const rpcRun = fileURLToPath(new URL('./integration/rpc-run.mjs', import.meta.url));
  return spawnSync(process.execPath, [rpcRun, ...args], {
    cwd, env: { ...process.env, TEMP: tmp, TMP: tmp }, encoding: 'utf8', timeout: 30000,
  });
}

// The unknown phase must fail, and that failure must be the ONLY thing on stderr: a second failure - a cleanup
// error, an EPERM from rmSync, a removal the run should not have attempted - is exactly the caller-work
// ownership bug, and it cannot hide behind the exit code (which the unknown phase already makes 1).
// A mutant preload writes its MUTATION-APPLIED sentinel to this child's stderr, so those lines are dropped
// first: a mutant must never be caught (or hidden) merely by the presence of its own sentinel.
function assertOnlyTheUnknownPhaseFailed(res) {
  const stderr = res.stderr.split('\n').filter((line) => !/^MUTATION-APPLIED/.test(line)).join('\n');
  assert.equal(res.status, 1, `the unknown phase is a failure\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.equal(res.stdout, '', 'nothing is printed on stdout for a failed run');
  assert.match(stderr, /^FAILED: Error: unknown --phase no-such-phase/);
  assert.ok(!/EPERM|EACCES|EBUSY|ENOTEMPTY|rmSync/.test(stderr), `no cleanup error may be added to stderr:\n${res.stderr}`);
  const unexpected = stderr.split('\n').filter((line) => line.trim() !== ''
    && !line.startsWith('FAILED: ') && !line.startsWith('    at ')
    && !line.startsWith('(node:') && !line.startsWith('Warning:'));
  assert.deepEqual(unexpected, [], 'only the expected FAILED block is on stderr');
}

test('outcomeLine: a non-zero exit code is a failure; 0 and undefined are passes', () => {
  assert.equal(outcomeLine({ mode: 'scenario', name: 'board-answer', exitCode: 1, work: 'W' }), 'scenario board-answer FAILED (exit 1); work=W');
  assert.equal(outcomeLine({ mode: 'scenario', name: 'board-answer', exitCode: undefined, work: 'W' }), 'scenario board-answer passed; work=W');
  assert.equal(outcomeLine({ mode: 'phase', name: 'scripted', exitCode: 0, work: 'W' }), 'phase scripted passed; work=W');
});

test('reportOutcome: exit 1, scenario board-answer -> exactly one error line and no log line', () => {
  const s = spies();
  reportOutcome({ mode: 'scenario', name: 'board-answer', work: 'W', exitCode: 1, log: s.log, error: s.error });
  assert.deepEqual(s.logs, [], 'a failed run prints nothing on stdout');
  assert.deepEqual(s.errors, ['scenario board-answer FAILED (exit 1); work=W']);
});

test('reportOutcome: exit undefined, scenario board-answer -> exactly one log line and no error line', () => {
  const s = spies();
  reportOutcome({ mode: 'scenario', name: 'board-answer', work: 'W', exitCode: undefined, log: s.log, error: s.error });
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.logs, ['scenario board-answer passed; work=W']);
});

test('reportOutcome: exit 0, phase scripted -> exactly one log line and no error line', () => {
  const s = spies();
  reportOutcome({ mode: 'phase', name: 'scripted', work: 'W', exitCode: 0, log: s.log, error: s.error });
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.logs, ['phase scripted passed; work=W']);
});

test('reportOutcome: the default reporters are stdout for a pass and stderr for a failure', () => {
  const logs = [];
  const errors = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (line) => logs.push(line);
  console.error = (line) => errors.push(line);
  try {
    reportOutcome({ mode: 'phase', name: 'scripted', work: 'W', exitCode: 0 });
    reportOutcome({ mode: 'phase', name: 'scripted', work: 'W', exitCode: 1 });
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  assert.deepEqual(logs, ['phase scripted passed; work=W']);
  assert.deepEqual(errors, ['phase scripted FAILED (exit 1); work=W']);
});

test('shouldRemoveWork: a caller-given --work is never treated as run-owned', () => {
  // --work "" resolves to the caller's cwd: the run created nothing, so it must not remove it (nor any other
  // explicitly given dir) on an ordinary phase or scenario.
  for (const phase of ['probe', 'scripted', 'real', 'no-such-phase']) {
    assert.equal(shouldRemoveWork({ workGiven: true, keep: false, phase }), false, phase);
  }
  // today's exceptions for a caller-given dir are preserved verbatim
  assert.equal(shouldRemoveWork({ workGiven: true, keep: false, phase: 'cleanup' }), true);
  assert.equal(shouldRemoveWork({ workGiven: true, keep: false, scenario: 'plan-view' }), true);
  assert.equal(shouldRemoveWork({ workGiven: true, keep: false, scenario: 'board-answer' }), true);
  // --keep always wins, for a caller-given and for a run-owned dir
  assert.equal(shouldRemoveWork({ workGiven: true, keep: true, phase: 'cleanup' }), false);
  assert.equal(shouldRemoveWork({ workGiven: false, keep: true, phase: 'scripted' }), false);
});

test('shouldRemoveWork: a dir this run created itself is removed for every phase and scenario', () => {
  for (const phase of ['probe', 'scripted', 'real', 'cleanup', 'no-such-phase']) {
    assert.equal(shouldRemoveWork({ workGiven: false, keep: false, phase }), true, phase);
  }
  for (const scenario of ['plan-view', 'board-answer']) {
    assert.equal(shouldRemoveWork({ workGiven: false, keep: false, scenario }), true, scenario);
  }
});

test('rpc-run cleanup: an explicit --work "" (the caller cwd) is never removed and adds no cleanup error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-trk-4-workarg-cwd-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-trk-4-workarg-out-'));
  const marker = path.join(root, 'caller-content.txt');
  fs.writeFileSync(marker, 'caller content\n');
  const res = runRpcRun(['--out', out, '--work', '', '--phase', 'no-such-phase'], { cwd: root, tmp: root });
  const survived = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'caller content\n';
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  assertOnlyTheUnknownPhaseFailed(res);
  assert.ok(survived, 'an explicitly given --work "" (the caller cwd) must not be removed');
});

test('rpc-run cleanup: an explicit non-cwd --work dir survives an ordinary phase (removal there would succeed)', () => {
  // The work dir is not the cwd, so a wrong removal would really delete it - the OS cannot mask the bug here.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-trk-4-workarg-cwd2-'));
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-trk-4-workarg-caller-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-trk-4-workarg-out2-'));
  const marker = path.join(caller, 'caller-content.txt');
  fs.writeFileSync(marker, 'caller content\n');
  const res = runRpcRun(['--out', out, '--work', caller, '--phase', 'no-such-phase'], { cwd, tmp: cwd });
  const survived = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'caller content\n';
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(caller, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  assertOnlyTheUnknownPhaseFailed(res);
  assert.ok(survived, 'a caller-given --work dir must survive a phase that never removed it');
});
