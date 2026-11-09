import * as fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './temp.mjs';
import { openStore } from '../../src/store.mjs';
import { createRoadmapTool } from '../../src/roadmap-tool.mjs';
import { roadmapHash, roadmapSection, roadmapRoot } from '../../src/roadmap-files.mjs';

export function roadmapFixture(t) {
  const { dir } = tempDir(t, 'omo-roadmap-');
  const project = path.join(dir, 'project');
  for (const name of ['drafts', 'plans', 'roadmaps', 'receipts']) fs.mkdirSync(path.join(project, '.omo', name), { recursive: true });
  const root = roadmapRoot(project);
  const sourcePath = `${root}/.omo/drafts/source.md`;
  const planPath = `${root}/.omo/plans/plan.md`;
  const projectionPath = `${root}/.omo/roadmaps/demo.json`;
  const sourceText = '# Root\n\n## Stage\n\nEvidence\n\n## Next\nOther\n';
  fs.writeFileSync(sourcePath, sourceText);
  fs.writeFileSync(planPath, '# Plan\n- [ ] 1. Work\n- [ ] 2. More work\n');
  const projection = {
    schemaVersion: 1, generatedAt: '2026-11-05T00:00:00.000Z', generatedBy: 'test',
    sources: [{ id: 'source', path: sourcePath, headingPath: ['Root', 'Stage'],
      sha256: roadmapHash(roadmapSection(sourceText, ['Root', 'Stage'])) }],
    tracks: [{ id: 'track', label: 'Track', stageIds: ['one'] }],
    stages: [{ id: 'one', label: 'One', goal: 'First stage', sourceId: 'source', requires: [], accepts: [],
      plans: [{ path: planPath, taskIds: null }], requirementsKnown: false, note: '' }],
  };
  const store = openStore(path.join(dir, 'state'));
  store.replace('sessions/owner/meta.json', { sessionId: 'owner', cwd: root });
  const tool = createRoadmapTool({ store, sessionId: 'owner', cwd: root, now: () => 1_793_836_800_000 });
  const save = (value = projection, file = projectionPath) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
  save();
  const call = async (overrides = {}) => (await tool.execute({ projectionPath, expectedRevision: null, ...overrides })).details;
  return { dir, root, store, tool, projection, projectionPath, sourcePath, sourceText, planPath, save, call };
}

export const unaskedGate = () => ({
  kind: 'decision', gateId: 'gate', decisionId: null, scope: 'Build the candidate', operation: 'implement',
});
export const secondStage = (projection) => {
  const stage = { ...structuredClone(projection.stages[0]), id: 'two', plans: [] };
  projection.stages.push(stage);
  projection.tracks[0].stageIds.push('two');
  return stage;
};
export function fileTree(root) {
  const output = {};
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else output[file] = fs.readFileSync(file, 'utf8');
    }
  };
  visit(root);
  return output;
}
