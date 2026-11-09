// Global registry transactions serialize all roadmap writers, including limits and CAS preconditions.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RoadmapError, ROADMAP_LIMITS } from './roadmap-schema.mjs';
import { roadmapPathKey } from './roadmap-files.mjs';

const LOCK = 'roadmaps/registry.lock';
export const roadmapDefinitionRel = (id) => `roadmaps/${id}/definition.json`;

export function readRoadmaps(store) {
  let entries;
  try { entries = fs.readdirSync(join(store.root, 'roadmaps'), { withFileTypes: true }); }
  catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && /^rm[a-f0-9]{12}$/.test(entry.name)).map((entry) => {
    const file = roadmapDefinitionRel(entry.name);
    const text = store.readText(file, { maxBytes: ROADMAP_LIMITS.vmBytes });
    // A failed first replace may leave its empty parent directory; only committed files are registrations.
    if (text === null) return null;
    const record = JSON.parse(text);
    if (record.schema !== 'omo-roadmap/1' || record.roadmapId !== entry.name || !Number.isSafeInteger(record.revision)
      || record.revision <= 0 || typeof record.registered !== 'boolean') {
      throw new RoadmapError('READ', file, 'invalid registry record');
    }
    return record;
  }).filter((record) => record !== null);
}

export function withRoadmapLock(store, action) {
  const record = { pid: process.pid, nonce: randomUUID(), at: Date.now() };
  try { store.writeNew(LOCK, record); }
  catch (error) {
    if (!(error instanceof Error) || error.code !== 'EEXIST') throw error;
    if (!store.reclaimStale(LOCK, store.readRecord(LOCK))) throw new RoadmapError('BUSY', LOCK, 'another registration is in progress');
    store.writeNew(LOCK, record);
  }
  try { return action(); }
  finally { fs.unlinkSync(join(store.root, LOCK)); }
}

export function checkRoadmapRevision(record, expectedRevision) {
  const actual = record?.revision ?? null;
  if (expectedRevision !== actual) throw new RoadmapError('REVISION', 'expectedRevision', `expected ${expectedRevision}, current ${actual}`);
}

export function writeRoadmapDefinition(context, definition) {
  const { store, expectedRevision, at } = context;
  const records = readRoadmaps(store);
  const previous = records.find((record) => record.roadmapId === definition.roadmapId);
  checkRoadmapRevision(previous, expectedRevision);
  if (previous && (roadmapPathKey(previous.projectionPath) !== roadmapPathKey(definition.projectionPath)
    || roadmapPathKey(previous.projectRoot) !== roadmapPathKey(definition.projectRoot))) {
    throw new RoadmapError('IDENTITY', definition.projectionPath, 'roadmap id collision');
  }
  for (const stage of definition.projection.stages) {
    const priorStage = previous?.projection.stages.find((item) => item.id === stage.id);
    for (const gate of [...stage.requires, ...stage.accepts].filter((item) => item.kind === 'decision')) {
      const priorGate = priorStage && [...priorStage.requires, ...priorStage.accepts]
        .find((item) => item.kind === 'decision' && item.gateId === gate.gateId);
      if (priorGate && (priorGate.scope !== gate.scope || priorGate.operation !== gate.operation)) {
        throw new RoadmapError('BINDING', `${stage.id}.${gate.gateId}`, 'stable gate scope and operation cannot change');
      }
    }
  }
  const candidate = { schema: 'omo-roadmap/1', ...definition, revision: (previous?.revision ?? 0) + 1,
    registered: true, checkedAt: new Date(at).toISOString() };
  // Repeating the current content at its current revision is idempotent.
  if (previous?.registered && previous.projectionHash === candidate.projectionHash
    && JSON.stringify(previous.evidence) === JSON.stringify(candidate.evidence)) return previous;
  const active = [...records.filter((record) => record.roadmapId !== candidate.roadmapId && record.registered), candidate];
  if (active.length > ROADMAP_LIMITS.roadmaps) throw new RoadmapError('LIMIT', definition.projectionPath, 'roadmap count exceeds 8');
  const structuralBytes = Buffer.byteLength(JSON.stringify(active));
  // Reserve the current published payload plus all definitions. Task 3 also caps the final joined VM.
  const publishedBytes = Buffer.byteLength(store.readText('data.js', { maxBytes: ROADMAP_LIMITS.vmBytes }) ?? '');
  if (structuralBytes + publishedBytes > ROADMAP_LIMITS.vmBytes) {
    throw new RoadmapError('LIMIT', definition.projectionPath,
      `projected VM ${structuralBytes + publishedBytes} bytes exceeds ${ROADMAP_LIMITS.vmBytes}`);
  }
  store.replace(roadmapDefinitionRel(candidate.roadmapId), candidate);
  return candidate;
}

export function unregisterRoadmap(context, identity) {
  const { store, expectedRevision, at } = context;
  const previous = readRoadmaps(store).find((record) => record.roadmapId === identity.roadmapId);
  checkRoadmapRevision(previous, expectedRevision);
  if (!previous) throw new RoadmapError('REVISION', identity.projectionPath, 'no registration to unregister');
  if (roadmapPathKey(previous.projectRoot) !== roadmapPathKey(identity.projectRoot)
    || roadmapPathKey(previous.projectionPath) !== roadmapPathKey(identity.projectionPath)) {
    throw new RoadmapError('IDENTITY', identity.projectionPath, 'registration belongs to another project');
  }
  if (!previous.registered) return previous;
  const record = { ...previous, registered: false, revision: previous.revision + 1, checkedAt: new Date(at).toISOString() };
  store.replace(roadmapDefinitionRel(record.roadmapId), record);
  return record;
}
