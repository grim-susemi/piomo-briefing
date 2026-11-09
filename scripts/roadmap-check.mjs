#!/usr/bin/env node
// Path-only boundary: never accepts a projection object or an approval claim.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store.mjs';
import { RoadmapError } from '../src/roadmap-schema.mjs';
import { loadRoadmapProjection, roadmapFilePath, roadmapRoot, roadmapIdOf } from '../src/roadmap-files.mjs';
import { validateRoadmapDecisions } from '../src/roadmap-gates.mjs';
import { readRoadmaps } from '../src/roadmap-registry.mjs';
import { createRoadmapTool } from '../src/roadmap-tool.mjs';

export async function roadmapCheck(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (['--register', '--unregister', '--inspect'].includes(key)) options[key] = true;
    else if (['--project-root', '--state-dir', '--session-id', '--expected-revision', '--request-stage', '--request-gate'].includes(key)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new RoadmapError('CLI', key, 'value required');
      options[key] = value;
    } else if (!key.startsWith('--') && options.projectionPath === undefined) options.projectionPath = key;
    else throw new RoadmapError('CLI', key, 'unknown argument');
  }
  if (!options.projectionPath) throw new RoadmapError('CLI', 'projectionPath', 'absolute JSON path required');
  const projectRoot = roadmapRoot(options['--project-root'] ?? process.cwd());
  const projectionPath = roadmapFilePath(projectRoot, options.projectionPath, 'projection');
  const store = options['--state-dir'] ? openStore(path.resolve(options['--state-dir'])) : null;
  if (options['--inspect']) {
    if (!store) throw new RoadmapError('CLI', '--state-dir', 'required for inspection');
    const roadmapId = roadmapIdOf(projectionPath);
    const record = readRoadmaps(store).find((item) => item.roadmapId === roadmapId);
    return { ok: true, roadmapId, revision: record?.revision ?? null, registered: record?.registered ?? false };
  }
  const requesting = options['--request-stage'] !== undefined || options['--request-gate'] !== undefined;
  if (options['--register'] || options['--unregister'] || requesting) {
    if (!store) throw new RoadmapError('CLI', '--state-dir', 'required for registration');
    const rawRevision = options['--expected-revision'];
    if (rawRevision === undefined || (rawRevision !== 'null' && !/^[1-9]\d*$/.test(rawRevision))) {
      throw new RoadmapError('CLI', '--expected-revision', 'null or current positive integer required');
    }
    const tool = createRoadmapTool({ store, cwd: projectRoot, sessionId: options['--session-id'] });
    return (await tool.execute({ projectionPath, expectedRevision: rawRevision === 'null' ? null : Number(rawRevision),
      ...(options['--unregister'] ? { unregister: true } : {}),
      ...(requesting ? { requestGate: { stageId: options['--request-stage'], gateId: options['--request-gate'] } } : {}),
    })).details;
  }
  const definition = loadRoadmapProjection({ projectRoot, projectionPath });
  const hasDecision = definition.projection.stages.some((stage) => [...stage.requires, ...stage.accepts]
    .some((condition) => condition.kind === 'decision' && condition.decisionId !== null));
  if (hasDecision && !store) throw new RoadmapError('CLI', '--state-dir', 'required for decision ownership');
  if (store) definition.evidence.decisions = validateRoadmapDecisions(definition, store);
  return { ok: true, ...definition };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await roadmapCheck(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(JSON.stringify({ ok: false, errors: [{
      code: error instanceof RoadmapError ? error.code : error.code ?? error.name,
      path: error instanceof RoadmapError ? error.field : 'projectionPath', message: error.message,
    }] }));
    process.exitCode = 1;
  }
}
