import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { openStore } from '../src/store.mjs';
import { createRoadmapTool } from '../src/roadmap-tool.mjs';
import { readRoadmaps } from '../src/roadmap-registry.mjs';
import { roadmapDecisionEvidence } from '../src/roadmap-gates.mjs';
import { ROADMAP_LIMITS } from '../src/roadmap-schema.mjs';
import { applyBoardAnswer } from '../src/decide.mjs';
import { roadmapFixture, unaskedGate, fileTree } from './helpers/roadmap.mjs';
import { createBriefingExtension } from '../extension.mjs';
import { makeFakePi, makeCtx } from './helpers/fake-pi.mjs';

const request = { requestGate: { stageId: 'one', gateId: 'gate' }, expectedRevision: 1 };
const decisionFile = (id) => `decisions/${String(id).padStart(6, '0')}.json`;
const evidence = (s, id) => {
  const definition = readRoadmaps(s.store)[0];
  const stage = definition.projection.stages[0];
  return roadmapDecisionEvidence({ definition, stage, store: s.store }, { ...unaskedGate(), decisionId: id });
};

test('registration is global, idempotent at current revision and never writes project files or asks questions', async (t) => {
  const s = roadmapFixture(t);
  s.projection.stages[0].requires.push(unaskedGate()); s.save();
  const before = fileTree(s.root);
  const first = await s.call();
  const another = createRoadmapTool({ store: openStore(s.store.root), cwd: s.root, sessionId: 'another' });
  const repeated = (await another.execute({ projectionPath: s.projectionPath, expectedRevision: 1 })).details;
  assert.deepEqual([first.ok, first.revision, repeated.revision], [true, 1, 1]);
  assert.deepEqual(readRoadmaps(openStore(s.store.root)).map((item) => item.registered), [true]);
  assert.equal(s.store.readSnapshot().decisions.length, 0);
  assert.equal(first.decisions[0].bindingState, 'unasked');
  assert.deepEqual(fileTree(s.root), before);
});

test('CAS rejects stale update and unregister; tombstones retain monotonic revision and all evidence', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  s.projection.stages[0].note = 'updated'; s.save();
  assert.equal((await s.call({ expectedRevision: 1 })).revision, 2);
  const previous = fileTree(s.store.root);
  for (const overrides of [{ expectedRevision: 1 }, { expectedRevision: 1, unregister: true }]) {
    const stale = await s.call(overrides);
    assert.equal(stale.ok, false, 'stale writer must be refused');
    assert.equal(stale.errors[0].code, 'REVISION');
    assert.equal(stale.revision, 2);
    assert.deepEqual(fileTree(s.store.root), previous);
  }
  const projectBefore = fileTree(s.root);
  s.store.writeNew('answers/000099.json', { id: 99, option: 'A' });
  s.store.writeNew('roadmaps/' + readRoadmaps(s.store)[0].roadmapId + '/status.json', { retained: true });
  assert.equal((await s.call({ expectedRevision: 2, unregister: true })).revision, 3);
  assert.equal(readRoadmaps(s.store)[0].registered, false);
  assert.equal(s.store.readRecord('answers/000099.json').option, 'A');
  assert.equal(s.store.readRecord('roadmaps/' + readRoadmaps(s.store)[0].roadmapId + '/status.json').retained, true);
  assert.deepEqual(fileTree(s.root), projectBefore);
  assert.equal((await s.call()).errors[0].code, 'REVISION');
  assert.equal((await s.call({ expectedRevision: 3 })).revision, 4);
});

test('explicit request creates an immutable scope bound question before owner approval and never auto links it', async (t) => {
  const s = roadmapFixture(t);
  s.projection.stages[0].requires.push(unaskedGate()); s.save();
  await s.call();
  const original = fs.readFileSync(s.projectionPath, 'utf8');
  const result = await s.call(request);
  const decision = s.store.readRecord(decisionFile(result.decisionId));
  assert.deepEqual(decision.roadmapBinding, { projectRoot: s.root, roadmapId: result.roadmapId,
    stageId: 'one', gateId: 'gate', scope: 'Build the candidate', operation: 'implement' });
  assert.equal(decision.approvalOption, 'A');
  assert.equal((await s.call(request)).decisionId, result.decisionId);
  assert.equal(evidence(s, result.decisionId).state, 'open');
  assert.equal(fs.readFileSync(s.projectionPath, 'utf8'), original);
  assert.equal(s.store.readSnapshot().answers.length, 0);
  assert.equal(applyBoardAnswer(s.store, { id: result.decisionId, sessionId: 'owner', option: 'A' }).ok, true);
  s.projection.stages[0].requires[0].decisionId = result.decisionId; s.save();
  assert.equal((await s.call({ expectedRevision: 1 })).decisions[0].bindingState, 'bound');
  assert.equal(evidence(s, result.decisionId).state, 'approved');
});

for (const changed of ['operation', 'scope', 'gateId']) {
  test(`a new decision cannot approve a different ${changed}`, async (t) => {
    const s = roadmapFixture(t);
    s.projection.stages[0].requires.push(unaskedGate()); s.save(); await s.call();
    const { decisionId } = await s.call(request);
    s.projection.stages[0].requires[0] = { ...unaskedGate(), decisionId, [changed]: changed === 'operation' ? 'install' : 'different' };
    s.save();
    const before = fileTree(s.store.root);
    assert.equal((await s.call({ expectedRevision: 1 })).errors[0].code, 'BINDING');
    assert.deepEqual(fileTree(s.store.root), before);
  });
}

test('an existing unbound owner answer cannot supply approval by prose inference', async (t) => {
  const s = roadmapFixture(t);
  const decisionId = s.store.allocDecisionId({ sessionId: 'owner', source: 'brief', question: 'Build the candidate implement approved?',
    options: { A: { text: 'Approve', consequence: 'Build' }, B: { text: 'Reject', consequence: 'Stop' } }, recommend: 'A' });
  assert.equal(applyBoardAnswer(s.store, { id: decisionId, sessionId: 'owner', option: 'A' }).ok, true);
  s.projection.stages[0].requires.push({ ...unaskedGate(), decisionId }); s.save();
  const result = await s.call();
  assert.equal(result.ok, true);
  assert.equal(result.decisions[0].bindingState, 'unknown');
  assert.equal(evidence(s, decisionId).state, 'unknown');
});

test('held, reopened, rejected and unanswered closed bound gates keep their distinct owner states', async (t) => {
  const s = roadmapFixture(t);
  s.projection.stages[0].requires.push(unaskedGate()); s.save(); await s.call();
  const { decisionId: id } = await s.call(request);
  assert.equal(applyBoardAnswer(s.store, { id, sessionId: 'owner', action: 'hold' }).ok, true);
  assert.equal(evidence(s, id).state, 'held');
  assert.equal((await s.call(request)).decisionId, id);
  assert.equal(applyBoardAnswer(s.store, { id, sessionId: 'owner', action: 'reopen' }).ok, true);
  assert.equal(evidence(s, id).state, 'open');
  assert.equal(applyBoardAnswer(s.store, { id, sessionId: 'owner', option: 'B' }).ok, true);
  assert.equal(evidence(s, id).state, 'rejected');
  s.store.writeNew(`decision-closures/${String(id).padStart(6, '0')}.json`, { id, reason: 'answered', answer: 'approved' });
  assert.equal(evidence(s, id).state, 'rejected');
});

for (const [option, state] of [['A', 'approved'], ['B', 'rejected']]) {
  test(`answered closure preserves the bound owner's ${state} answer`, async (t) => {
    const s = roadmapFixture(t);
    s.projection.stages[0].requires.push(unaskedGate()); s.save(); await s.call();
    const { decisionId: id } = await s.call(request);
    assert.equal(applyBoardAnswer(s.store, { id, sessionId: 'owner', option }).ok, true);
    s.store.writeNew(`decision-closures/${String(id).padStart(6, '0')}.json`, { id, reason: 'answered' });
    assert.equal(evidence(s, id).state, state);
  });
}

test('answered closure without an owner answer cannot establish approval', async (t) => {
  const s = roadmapFixture(t);
  s.projection.stages[0].requires.push(unaskedGate()); s.save(); await s.call();
  const { decisionId: id } = await s.call(request);
  s.store.writeNew(`decision-closures/${String(id).padStart(6, '0')}.json`, { id, reason: 'answered', answer: 'approved' });
  assert.equal(evidence(s, id).state, 'unknown');
});

test('foreign project decisions are refused without changing a valid registration', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  s.store.replace('sessions/foreign/meta.json', { cwd: s.dir });
  const id = s.store.allocDecisionId({ sessionId: 'foreign' });
  s.projection.stages[0].requires.push({ ...unaskedGate(), decisionId: id }); s.save();
  const before = fileTree(s.store.root);
  assert.equal((await s.call({ expectedRevision: 1 })).errors[0].code, 'OWNERSHIP');
  assert.deepEqual(fileTree(s.store.root), before);
});

test('malformed inputs and invalid projection preserve the prior definition and all project bytes', async (t) => {
  const s = roadmapFixture(t);
  await s.call();
  const before = fileTree(s.store.root);
  for (const input of [{ projectionPath: s.projectionPath }, { projectionPath: s.projectionPath, expectedRevision: 1, scope: 'claimed' }]) {
    assert.equal((await s.tool.execute(input)).details.errors[0].code, 'INPUT');
  }
  s.projection.bogus = true; s.save();
  const projectBefore = fileTree(s.root);
  assert.equal((await s.call({ expectedRevision: 1 })).errors[0].code, 'SCHEMA');
  assert.deepEqual(fileTree(s.store.root), before);
  assert.deepEqual(fileTree(s.root), projectBefore);
});

for (const registered of [false, true]) test(`failed atomic replacement preserves ${registered ? 'existing' : 'absent'} registration and permits retry`, async (t) => {
  const s = roadmapFixture(t);
  if (registered) await s.call();
  const before = fileTree(s.store.root);
  s.projection.stages[0].note = 'changed'; s.save();
  const fault = openStore(s.store.root, { fs: { ...fs, renameSync() { throw Object.assign(new Error('injected disk error'), { code: 'EIO' }); } } });
  const tool = createRoadmapTool({ store: fault, sessionId: 'owner', cwd: s.root });
  const result = (await tool.execute({ projectionPath: s.projectionPath, expectedRevision: registered ? 1 : null })).details;
  assert.equal(result.errors[0].code, 'EIO');
  assert.deepEqual(fileTree(s.store.root), before);
  assert.equal((await s.call({ expectedRevision: registered ? 1 : null })).ok, true);
});

test('later registrations preserve the first eight independently of published payload size', async (t) => {
  const s = roadmapFixture(t);
  for (let index = 0; index < 8; index++) {
    const file = `${s.root}/.omo/roadmaps/${index}.json`; s.save(s.projection, file);
    assert.equal((await s.call({ projectionPath: file })).ok, true);
  }
  const before = fileTree(s.store.root);
  s.store.replace('data.js', 'x'.repeat(ROADMAP_LIMITS.vmBytes - 10));
  for (let index = 8; index < 12; index++) {
    const file = `${s.root}/.omo/roadmaps/${index}.json`; s.save(s.projection, file);
    assert.equal((await s.call({ projectionPath: file })).ok, true);
  }
  assert.equal(readRoadmaps(s.store).filter((record) => record.registered).length, 12);
  const after = fileTree(s.store.root);
  for (const [file, text] of Object.entries(before)) assert.equal(after[file], text);
});

test('competing processes cannot both replace the same expected revision', { timeout: 15_000 }, async (t) => {
  const s = roadmapFixture(t);
  await s.call(); s.projection.stages[0].note = 'competing'; s.save();
  const code = `import {openStore} from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
import {createRoadmapTool} from ${JSON.stringify(new URL('../src/roadmap-tool.mjs', import.meta.url).href)};
const cfg=JSON.parse(process.env.ROADMAP_WRITER);
process.stdout.write('READY\\n');
process.stdin.once('data',async()=>{const result=await createRoadmapTool({store:openStore(cfg.state),cwd:cfg.root,sessionId:'owner'}).execute(cfg.request);console.log(JSON.stringify(result.details));process.stdin.destroy();});`;
  const launch = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env,
      ROADMAP_WRITER: JSON.stringify({ state: s.store.root, root: s.root, request: { projectionPath: s.projectionPath, expectedRevision: 1 } }),
    }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    t.after(() => child.kill());
    let output = '', errors = '';
    let start;
    const ready = new Promise((resolve) => { start = resolve; });
    child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('READY')) start(); });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject); child.on('close', (code) => resolve({ code, output, errors }));
    });
    return { child, ready, done };
  };
  const writers = [launch(), launch()]; await Promise.all(writers.map((writer) => writer.ready));
  writers.forEach((writer) => writer.child.stdin.write('go\n'));
  const results = await Promise.all(writers.map((writer) => writer.done));
  results.forEach((result) => assert.equal(result.code, 0, result.errors));
  const details = results.map((result) => JSON.parse(result.output.trim().split('\n').at(-1)));
  assert.equal(details.filter((item) => item.ok).length, 1);
  assert.ok(['BUSY', 'REVISION'].includes(details.find((item) => !item.ok).errors[0].code));
  assert.equal(readRoadmaps(s.store)[0].revision, 2);
});

test('path CLI registers, inspects revision, and rejects stale unregister with exit 1', (t) => {
  const s = roadmapFixture(t);
  const cli = new URL('../scripts/roadmap-check.mjs', import.meta.url);
  const run = (args) => spawnSync(process.execPath, [cli.pathname.replace(/^\/([A-Z]:)/i, '$1'), s.projectionPath,
    '--project-root', s.root, '--state-dir', s.store.root, ...args], { encoding: 'utf8', timeout: 10_000 });
  const registered = run(['--register', '--expected-revision', 'null']);
  assert.equal(registered.status, 0, registered.stderr);
  assert.equal(JSON.parse(registered.stdout).revision, 1);
  const inspected = run(['--inspect']);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).registered, true);
  const stale = run(['--unregister', '--expected-revision', 'null']);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).errors[0].code, 'REVISION');
});

test('extension registers the production tool and uses the current lead project', async (t) => {
  const s = roadmapFixture(t);
  const host = makeFakePi({ cwd: s.root });
  const { ctx } = makeCtx({ cwd: s.root, sid: 'owner' });
  createBriefingExtension({ stateDir: s.store.root, env: {}, server: false, renderOpts: { sleep: () => {} } })(host.pi);
  t.after(() => host.emit('session_shutdown', {}, ctx));
  await host.emit('session_start', {}, ctx);
  const tool = host.tool('roadmap_brief');
  assert.equal(typeof tool.execute, 'function');
  const result = await tool.execute('register', { projectionPath: s.projectionPath, expectedRevision: null });
  assert.equal(result.details.revision, 1);
  assert.equal(readRoadmaps(s.store)[0].projectRoot, s.root);
  s.store.writeSettings({ enabled: false });
  assert.equal((await tool.execute('paused', { projectionPath: s.projectionPath, expectedRevision: 1 })).details.disabled, true);
});
