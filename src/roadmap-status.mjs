// Evidence overlay for globally registered roadmaps. Definitions remain the structural authority.
import * as fs from 'node:fs';
import path from 'node:path';
import { computePlanStatus } from './plan-status.mjs';
import { planIdOf, rootAndSlugOf } from './plan-schema.mjs';
import { readRoadmaps, withRoadmapLock } from './roadmap-registry.mjs';
import { roadmapDecisionEvidence } from './roadmap-gates.mjs';
import { roadmapFilePath, roadmapHash, roadmapPathKey, roadmapSection, readRoadmapFile } from './roadmap-files.mjs';
import { roadmapKeys, roadmapTime } from './roadmap-schema.mjs';

const TTL = 60_000;
const caches = new Map();
const statusRel = (id) => `roadmaps/${id}/status.json`;
const sorted = (values) => [...values].sort();
const errorOf = (error) => ({ code: error?.code ?? 'READ', message: String(error?.message ?? error) });

function cacheFor(root) {
  const key = roadmapPathKey(path.resolve(root));
  if (!caches.has(key)) caches.set(key, new Map());
  return caches.get(key);
}

function readProjectFile(root, file, kind, limit) {
  return readRoadmapFile(roadmapFilePath(root, file, kind), limit);
}

function planReader(root) {
  const base = path.resolve(root, '.omo');
  return (file, { maxBytes } = {}) => {
    const target = path.resolve(file);
    const relative = path.relative(base, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw Object.assign(new Error(`outside project: ${file}`), { code: 'PATH' });
    }
    try {
      const real = fs.realpathSync(target);
      const realRelative = path.relative(base, real);
      if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        throw Object.assign(new Error(`outside project: ${file}`), { code: 'PATH' });
      }
      return readRoadmapFile(real, maxBytes);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
}

async function collectPlan(definition, reference, context) {
  const { summaries, now, sleep } = context;
  const file = roadmapFilePath(definition.projectRoot, reference.path, 'plan');
  const raw = readProjectFile(definition.projectRoot, file, 'plan', 2 * 1024 * 1024);
  const readText = planReader(definition.projectRoot);
  let ledgerTailIncomplete = false;
  let missingLedger = false;
  const status = await computePlanStatus({
    planPath: file, boulderPath: path.join(definition.projectRoot, '.omo', 'boulder.json'),
    readText: (name, limits) => {
      const text = readText(name, limits);
      if (text === null && name !== file && path.basename(name) !== 'boulder.json') missingLedger = true;
      if (typeof text === 'string' && name !== file && path.basename(name) !== 'boulder.json'
        && (text.split(/\r?\n/).length > 2001 || (text.length > 0 && !text.endsWith('\n')))) ledgerTailIncomplete = true;
      return text;
    }, now, sleep,
  });
  const idParts = rootAndSlugOf(file);
  const planId = idParts ? planIdOf(idParts.root, idParts.slug) : null;
  const summary = summaries.find((item) => item.planId === planId)?.rev ?? null;
  const inventory = Object.keys(status.boxes).filter((id) => !id.startsWith('F'));
  const taskIds = reference.taskIds === null ? inventory : reference.taskIds;
  const uniqueIds = sorted(new Set(taskIds.filter((id) => !id.startsWith('F'))));
  const missingIds = uniqueIds.filter((id) => !Object.hasOwn(status.boxes, id));
  const currentHash = roadmapHash(raw);
  const registered = definition.evidence.plans.find((item) => roadmapPathKey(item.path) === roadmapPathKey(file));
  const errors = [...status.errors];
  const parseErrors = new Set(['DUP_ID', 'BAD_DEPS', 'LEDGER_BAD_LINES', 'BOULDER_PARSE', 'FRONTMATTER_UNTERMINATED']);
  const readError = errors.find((item) => !parseErrors.has(item.code));
  if (readError) throw Object.assign(new Error(`plan evidence read failed: ${readError.path}`), { code: readError.code });
  if (missingLedger) throw Object.assign(new Error(`ledger missing for ${file}`), { code: 'ENOENT' });
  if (raw.split(/\r?\n/).some((line) => /^- \[[^\]]*\] F?\d/.test(line)
    && !/^- \[(?: |x|~)\] F?\d+[a-z]?\. /.test(line))) errors.push({ code: 'INVENTORY_PARSE', path: file });
  if (status.files.planSha256Now !== currentHash) errors.push({ code: 'CHANGED', path: file });
  if (!registered || registered.sha256 !== currentHash) errors.push({ code: 'PLAN_HASH', path: file });
  if (ledgerTailIncomplete) errors.push({ code: 'LEDGER_TAIL', path: file });
  if (missingIds.length) errors.push({ code: 'MISSING_IDS', path: file, ids: missingIds });
  const summaryCurrent = summary?.source?.planSha256 === currentHash;
  const allTasks = inventory.map((id) => {
    const skeleton = status.skeleton?.tasks.find((item) => item.id === id);
    const model = summaryCurrent ? summary.plan?.tasks?.find((item) => item.id === id) : null;
    const dependenciesKnown = Boolean(skeleton && skeleton.wave !== null && model
      && JSON.stringify(sorted(skeleton.deps)) === JSON.stringify(sorted(model.deps ?? [])));
    const last = status.ledger[id]?.last ?? null;
    return { id, mark: status.boxes[id], last, dependenciesKnown, deps: skeleton?.deps ?? [],
      conflict: status.boxes[id] === 'x' && last === 'verify-failed' };
  });
  const tasks = allTasks.filter((task) => uniqueIds.includes(task.id));
  const dependencyTasks = allTasks.filter((task) => !uniqueIds.includes(task.id));
  return { path: file, planId, sha256: currentHash, taskIds: uniqueIds, tasks, work: status.work ?? null,
    dependencyTasks, coverage: errors.length === 0, errors };
}

function receiptEvidence(context, condition) {
  const { definition, stage, sources, plans } = context;
  const raw = readProjectFile(definition.projectRoot, condition.path, 'receipt', 256 * 1024);
  const receipt = JSON.parse(raw);
  roadmapKeys(receipt, ['schemaVersion', 'result', 'operation', 'subjectHash', 'checkedAt'], condition.path);
  const subject = { schemaVersion: 1, roadmapId: definition.roadmapId, stageId: stage.id,
    operation: condition.operation, sources, plans: plans.map(({ path: file, sha256, taskIds }) => ({ path: file, sha256, taskIds })) };
  const expected = roadmapHash(JSON.stringify(subject));
  const valid = receipt.schemaVersion === 1 && ['pass', 'fail'].includes(receipt.result)
    && roadmapTime(receipt.checkedAt) && receipt.operation === condition.operation
    && roadmapHash(raw) === condition.sha256 && receipt.subjectHash === condition.subjectHash
    && receipt.subjectHash === expected && plans.every((plan) => plan.coverage);
  return { kind: 'receipt', path: condition.path, state: valid ? receipt.result : 'unknown', expectedSubjectHash: expected };
}

async function collectDefinition(definition, store, options) {
  const { now, sleep } = options;
  const projectionText = readProjectFile(definition.projectRoot, definition.projectionPath, 'projection', 256 * 1024);
  if (roadmapHash(projectionText) !== definition.projectionHash) {
    throw Object.assign(new Error(`projection changed: ${definition.projectionPath}`), { code: 'PROJECTION_HASH' });
  }
  const sourceMap = new Map();
  for (const source of definition.projection.sources) {
    const raw = readProjectFile(definition.projectRoot, source.path, 'source', 2 * 1024 * 1024);
    const sha256 = roadmapHash(roadmapSection(raw, source.headingPath));
    if (sha256 !== source.sha256) throw Object.assign(new Error(`source section changed: ${source.path}`), { code: 'SOURCE_HASH' });
    sourceMap.set(source.id, { id: source.id, sha256 });
  }
  const summaries = store.readPlans();
  const stages = [];
  for (const stage of definition.projection.stages) {
    const plans = [];
    for (const reference of stage.plans) plans.push(await collectPlan(definition, reference, { summaries, now, sleep }));
    plans.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const sourceIds = new Set([stage.sourceId]);
    for (const condition of [...stage.requires, ...stage.accepts]) {
      if (condition.kind === 'stage') {
        const linked = definition.projection.stages.find((item) => item.id === condition.id);
        if (linked) sourceIds.add(linked.sourceId);
      }
    }
    const sources = sorted(sourceIds).map((id) => sourceMap.get(id));
    const conditionEvidence = (condition) => {
      switch (condition.kind) {
        case 'stage': return { kind: 'stage', id: condition.id };
        case 'decision': return { ...condition, ...roadmapDecisionEvidence({ definition, stage, store }, condition) };
        case 'receipt': return receiptEvidence({ definition, stage, sources, plans }, condition);
        default: throw new Error(`unsupported condition ${condition.kind}`);
      }
    };
    stages.push({ id: stage.id, requirementsKnown: stage.requirementsKnown, sources, plans,
      requires: stage.requires.map(conditionEvidence), accepts: stage.accepts.map(conditionEvidence) });
  }
  return { schema: 'omo-roadmap-status/1', roadmapId: definition.roadmapId,
    definitionRevision: definition.revision, checkedAt: new Date(now).toISOString(), stages, error: null };
}

// Serialize the compare-and-write with registration; a late collection cannot overwrite newer evidence.
export function writeRoadmapStatus(store, snapshot, expectedStatusRevision) {
  return withRoadmapLock(store, () => {
    const definition = readRoadmaps(store).find((item) => item.roadmapId === snapshot.roadmapId);
    if (!definition?.registered || definition.revision !== snapshot.definitionRevision) return false;
    const previous = store.readRecord(statusRel(snapshot.roadmapId));
    if (expectedStatusRevision !== undefined && (previous?.revision ?? 0) !== expectedStatusRevision) return false;
    if (previous && (previous.definitionRevision > snapshot.definitionRevision
      || (previous.definitionRevision === snapshot.definitionRevision && previous.checkedAt > snapshot.checkedAt)
      || (expectedStatusRevision === undefined && previous.definitionRevision === snapshot.definitionRevision
        && previous.checkedAt === snapshot.checkedAt))) return false;
    const revision = (previous?.revision ?? 0) + 1;
    const written = { ...snapshot, revision };
    store.replace(statusRel(snapshot.roadmapId), written);
    return written;
  });
}

// Cache is shared by all store instances for the same root, never across state roots.
export async function refreshRoadmapStatuses(store, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  const cache = cacheFor(store.root);
  const definitions = readRoadmaps(store).filter((item) => item.registered);
  const output = [];
  Object.defineProperty(output, 'changed', { value: false, writable: true });
  for (const definition of definitions) {
    const cached = cache.get(definition.roadmapId);
    if (!options.force && cached && cached.definitionRevision === definition.revision && now >= cached.at && now - cached.at < TTL) {
      output.push(cached.snapshot);
      continue;
    }
    let snapshot;
    const baseRevision = store.readRecord(statusRel(definition.roadmapId))?.revision ?? 0;
    try {
      snapshot = await collectDefinition(definition, store, { now, sleep: options.sleep });
    } catch (error) {
      cache.delete(definition.roadmapId);
      const previous = store.readRecord(statusRel(definition.roadmapId));
      snapshot = { ...(previous ?? { schema: 'omo-roadmap-status/1', roadmapId: definition.roadmapId,
        checkedAt: null, stages: [] }), definitionRevision: definition.revision, error: errorOf(error) };
      if (options.canWrite && !options.canWrite()) return output;
      const written = writeRoadmapStatus(store, snapshot, baseRevision);
      if (written) { output.changed = true; output.push(written); }
      continue;
    }
    if (options.canWrite && !options.canWrite()) return output;
    const written = writeRoadmapStatus(store, snapshot, baseRevision);
    if (written) {
      output.changed = true;
      cache.set(definition.roadmapId, { at: now, definitionRevision: definition.revision, snapshot: written });
      output.push(written);
    }
  }
  return output;
}
