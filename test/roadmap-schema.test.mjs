import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { validateRoadmapProjection, ROADMAP_LIMITS } from '../src/roadmap-schema.mjs';
import { loadRoadmapProjection, roadmapSection, roadmapHash, roadmapIdOf } from '../src/roadmap-files.mjs';
import { roadmapFixture, unaskedGate, secondStage } from './helpers/roadmap.mjs';

test('requirementsKnown=false and unasked gates preserve unknown evidence and source mapping', (t) => {
  const s = roadmapFixture(t);
  s.projection.stages[0].requires.push(unaskedGate());
  s.save();
  const definition = loadRoadmapProjection({ projectRoot: s.root, projectionPath: s.projectionPath });
  assert.equal(definition.projection.stages[0].requirementsKnown, false);
  assert.equal(definition.projection.stages[0].requires[0].decisionId, null);
  assert.equal(definition.projection.stages[0].sourceId, 'source');
  assert.equal(definition.evidence.sources[0].sha256, s.projection.sources[0].sha256);
  assert.equal(definition.roadmapId, `rm${roadmapHash(s.projectionPath.toLowerCase()).slice(0, 12)}`);
  assert.equal(roadmapIdOf(s.projectionPath.replaceAll('/', '\\')), definition.roadmapId);
});

const structuralCases = [
  ['unsupported version', (p) => { p.schemaVersion = 2; }, 'schemaVersion'],
  ['top unknown key', (p) => { p.ready = true; }, 'projection.ready'],
  ['source unknown key', (p) => { p.sources[0].bogus = true; }, 'sources[0].bogus'],
  ['track unknown key', (p) => { p.tracks[0].bogus = true; }, 'tracks[0].bogus'],
  ['stage unknown key', (p) => { p.stages[0].done = true; }, 'stages[0].done'],
  ['plan unknown key', (p) => { p.stages[0].plans[0].bogus = true; }, 'plans[0].bogus'],
  ['condition unknown key', (p) => { p.stages[0].requires = [{ ...unaskedGate(), approved: true }]; }, 'approved'],
  ['invalid id', (p) => { p.sources[0].id = 'bad id'; }, 'sources[0].id'],
  ['duplicate source', (p) => { p.sources.push(p.sources[0]); }, 'sources'],
  ['duplicate track', (p) => { p.tracks.push({ ...p.tracks[0], stageIds: [] }); }, 'tracks'],
  ['duplicate stage', (p) => { p.stages.push(p.stages[0]); }, 'stages'],
  ['missing membership', (p) => { p.tracks[0].stageIds = []; }, 'stages[0]'],
  ['duplicate membership', (p) => { p.tracks[0].stageIds.push('one'); }, 'tracks.stageIds'],
  ['missing stage ref', (p) => { p.stages[0].requires.push({ kind: 'stage', id: 'absent' }); }, 'stages[0]'],
  ['missing source ref', (p) => { p.stages[0].sourceId = 'absent'; }, 'sourceId'],
  ['cycle', (p) => { const two = secondStage(p); two.requires = [{ kind: 'stage', id: 'one' }];
    p.stages[0].requires = [{ kind: 'stage', id: 'two' }]; }, 'stages'],
  ['shared full plan', (p) => { secondStage(p).plans = structuredClone(p.stages[0].plans); }, '.omo/plans/plan.md'],
  ['duplicate gate', (p) => { p.stages[0].requires = [unaskedGate()]; p.stages[0].accepts = [unaskedGate()]; }, 'gateId'],
  ['invalid decision id', (p) => { p.stages[0].requires = [{ ...unaskedGate(), decisionId: 0 }]; }, 'decisionId'],
  ['invalid operation', (p) => { p.stages[0].requires = [{ ...unaskedGate(), operation: 'execute' }]; }, 'operation'],
  ['invalid timestamp', (p) => { p.generatedAt = '2026-02-30T00:00:00Z'; }, 'generatedAt'],
  ['timestamp offset', (p) => { p.generatedAt = '2026-11-05T01:00:00+01:00'; }, 'generatedAt'],
  ['non NFC', (p) => { p.generatedBy = 'e\u0301'; }, 'generatedBy'],
  ['Unicode label count', (p) => { p.stages[0].label = '😀'.repeat(15); }, 'label'],
  ['long goal', (p) => { p.stages[0].goal = 'a'.repeat(81); }, 'goal'],
  ['long note', (p) => { p.stages[0].note = 'a'.repeat(121); }, 'note'],
  ['too many tracks', (p) => { p.tracks = Array(7).fill(p.tracks[0]); }, 'tracks'],
  ['too many stages', (p) => { p.stages = Array(41).fill(p.stages[0]); }, 'stages'],
  ['too many sources', (p) => { p.sources = Array(17).fill(p.sources[0]); }, 'sources'],
  ['too many plans', (p) => { p.stages[0].plans = Array(5).fill(p.stages[0].plans[0]); }, 'plans'],
  ['too many conditions', (p) => { p.stages[0].requires = Array(17).fill(unaskedGate()); }, 'requires'],
  ['malformed task id', (p) => { p.stages[0].plans[0].taskIds = ['arbitrary']; }, 'taskIds'],
  ['bad hash', (p) => { p.sources[0].sha256 = 'not a hash'; }, 'sha256'],
  ['wrong boolean', (p) => { p.stages[0].requirementsKnown = 'false'; }, 'requirementsKnown'],
];
for (const [name, change, expectedPath] of structuralCases) {
  test(`projection rejects ${name} at its field`, (t) => {
    const s = roadmapFixture(t);
    change(s.projection);
    const result = validateRoadmapProjection(s.projection);
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].path.includes(expectedPath), JSON.stringify(result.errors));
  });
}

test('explicit shared tasks deduplicate references without losing stage ownership', (t) => {
  const s = roadmapFixture(t);
  s.projection.stages[0].plans[0].taskIds = ['1', '1'];
  secondStage(s.projection).plans = [{ path: s.planPath, taskIds: ['2'] }];
  s.projection.stages[0].plans.push({ path: s.planPath, taskIds: ['2'] });
  s.save();
  const result = loadRoadmapProjection({ projectRoot: s.root, projectionPath: s.projectionPath });
  assert.deepEqual(result.projection.stages.map((stage) => stage.plans), [
    [{ path: s.planPath, taskIds: ['1', '2'] }], [{ path: s.planPath, taskIds: ['2'] }],
  ]);
});

test('heading hashes use exact hierarchy, ignore code fences and reject ambiguous ancestors', () => {
  const text = '\uFEFF# Root\r\n\r\n```md\r\n## Fake\r\n```\r\n## Real\r\nbody\r\n\r\n## Next\r\n';
  assert.equal(roadmapSection(text, ['Root', 'Real']), '## Real\nbody\n\n');
  assert.throws(() => roadmapSection(text, ['Root', 'Fake']), { code: 'HEADING' });
  assert.throws(() => roadmapSection('# Root\n## Real\nx\n# Root\n## Other\n', ['Root', 'Real']), { code: 'HEADING' });
  assert.throws(() => roadmapSection(text, ['Missing']), { code: 'HEADING' });
});

for (const name of ['parent traversal', 'outside root', 'wrong source directory', 'junction escape', 'oversized projection', 'changed source']) {
  test(`file validation refuses ${name}`, (t) => {
    const s = roadmapFixture(t);
    let projectionPath = s.projectionPath;
    let code = 'PATH';
    switch (name) {
      case 'parent traversal': s.projection.sources[0].path = `${s.root}/.omo/drafts/../drafts/source.md`; break;
      case 'outside root': s.projection.sources[0].path = `${s.dir}/private.md`; break;
      case 'wrong source directory': s.projection.sources[0].path = s.planPath; break;
      case 'junction escape': {
        const outside = path.join(s.dir, 'outside');
        fs.renameSync(`${s.root}/.omo/drafts`, outside);
        fs.symlinkSync(outside, `${s.root}/.omo/drafts`, 'junction');
        break;
      }
      case 'oversized projection': code = 'LIMIT'; break;
      case 'changed source': fs.appendFileSync(s.sourcePath, '\n'); s.projection.sources[0].sha256 = '0'.repeat(64); code = 'HASH'; break;
      default: assert.fail(name);
    }
    s.save();
    if (name === 'oversized projection') fs.writeFileSync(projectionPath, ' '.repeat(ROADMAP_LIMITS.bytes + 1));
    assert.throws(() => loadRoadmapProjection({ projectRoot: s.root, projectionPath }), { code });
  });
}

test('receipt operation, hash, subject and unknown keys are checked independently', (t) => {
  const s = roadmapFixture(t);
  const file = `${s.root}/.omo/receipts/accept.json`;
  const receipt = { schemaVersion: 1, result: 'pass', operation: 'accept', subjectHash: 'a'.repeat(64), checkedAt: '2026-11-05T00:00:00Z' };
  const write = () => {
    const raw = JSON.stringify(receipt);
    fs.writeFileSync(file, raw);
    s.projection.stages[0].accepts = [{ kind: 'receipt', path: file, sha256: roadmapHash(raw),
      subjectHash: 'a'.repeat(64), operation: 'accept' }];
    s.save();
  };
  write();
  assert.equal(loadRoadmapProjection({ projectRoot: s.root, projectionPath: s.projectionPath }).evidence.receipts[0].receipt.result, 'pass');
  for (const [key, value, code] of [['operation', 'implement', 'RECEIPT'], ['subjectHash', 'b'.repeat(64), 'RECEIPT'], ['bogus', true, 'SCHEMA']]) {
    const changed = { ...receipt, [key]: value };
    fs.writeFileSync(file, JSON.stringify(changed));
    s.projection.stages[0].accepts[0].sha256 = roadmapHash(JSON.stringify(changed));
    s.save();
    assert.throws(() => loadRoadmapProjection({ projectRoot: s.root, projectionPath: s.projectionPath }), { code });
  }
  write();
  fs.appendFileSync(file, ' ');
  assert.throws(() => loadRoadmapProjection({ projectRoot: s.root, projectionPath: s.projectionPath }), { code: 'HASH' });
});

test('task one projections retain all 25 independently mapped source stages', () => {
  const full = JSON.parse(fs.readFileSync(new URL('./fixtures/roadmap/full.json', import.meta.url), 'utf8'));
  for (const projection of full.projections) {
    assert.equal(validateRoadmapProjection(projection).ok, true);
    for (const source of projection.sources) {
      assert.equal(roadmapHash(roadmapSection(fs.readFileSync(source.path, 'utf8'), source.headingPath)), source.sha256);
    }
  }
  assert.equal(full.projections.flatMap((projection) => projection.stages).length, 25);
});
