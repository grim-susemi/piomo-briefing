// Bounded, immutable snapshot artifacts. The descriptor never grows with registry size.
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readRoadmapFile } from './roadmap-files.mjs';
import { ROADMAP_LIMITS, RoadmapError } from './roadmap-schema.mjs';

export const ROADMAP_PAGE_BYTES = 128 * 1024;
export const ROADMAP_ARTIFACT_PATH = /^\/roadmap-data\/[a-f0-9]{64}\/(?:(?:catalogue|plans|search|topics)-\d+|detail-rm[a-f0-9]{12})\.json$/;
const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const script = (text) => `window.__briefRoadmap&&window.__briefRoadmap(${text});`;

function bounded(envelope, maxBytes) {
  const text = json(envelope);
  if (Buffer.byteLength(script(text)) > maxBytes) {
    throw new RoadmapError('LIMIT', envelope.items[0]?.projectionPath ?? envelope.kind,
      `roadmap VM exceeds ${maxBytes} bytes: ${envelope.items[0]?.projectionPath ?? envelope.kind}`);
  }
  return text;
}

function pages(items, context) {
  const result = [];
  let batch = [];
  const envelope = (rows) => ({ ...context, id: String(result.length), items: rows });
  for (const item of items) {
    if (batch.length && Buffer.byteLength(script(json(envelope([...batch, item])))) > ROADMAP_PAGE_BYTES) {
      result.push(bounded(envelope(batch), ROADMAP_PAGE_BYTES));
      batch = [];
    }
    bounded(envelope([item]), ROADMAP_PAGE_BYTES);
    batch.push(item);
  }
  result.push(bounded(envelope(batch), ROADMAP_PAGE_BYTES));
  return result;
}

// Deduplicate globally, before paging. Very widely shared plans continue on the next page.
function connectedPlans(roadmaps) {
  const plans = new Map();
  for (const rm of roadmaps) {
    for (const stage of rm.stages) {
      for (const plan of stage.plans) {
        const key = plan.planId || plan.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const item = plans.get(key) ?? { plan: { path: plan.path, planId: plan.planId,
          taskIds: plan.taskIds, errors: plan.errors }, refs: [] };
        item.refs.push({ roadmapId: rm.roadmapId, stageId: stage.id, stageLabel: stage.label,
          taskIds: plan.taskIds, errors: plan.errors });
        plans.set(key, item);
      }
    }
  }
  return [...plans.values()].flatMap((item) => {
    const chunks = [];
    let refs = [];
    for (const ref of item.refs) {
      if (refs.length && Buffer.byteLength(json({ plan: item.plan, refs: [...refs, ref] })) > ROADMAP_PAGE_BYTES / 2) {
        chunks.push({ plan: item.plan, refs });
        refs = [];
      }
      refs.push(ref);
    }
    chunks.push({ plan: item.plan, refs });
    return chunks;
  });
}

export function roadmapPublication(vm) {
  if (!vm.roadmaps?.length) return { model: vm, artifacts: [] };
  const key = createHash('sha256').update(json({ gen: vm.gen, roadmaps: vm.roadmaps })).digest('hex');
  const context = { schema: 1, key, gen: vm.gen };
  const summaries = vm.roadmaps.map((rm) => ({
    roadmapId: rm.roadmapId, projectionPath: rm.projectionPath, revision: rm.revision,
    checkedAt: rm.checkedAt, stale: rm.stale, error: rm.error,
    tracks: rm.tracks.map((track) => ({ id: track.id, label: track.label, stageIds: [] })), stages: [],
  }));
  const catalogue = pages(summaries, { ...context, kind: 'catalogue' });
  const plans = pages(connectedPlans(vm.roadmaps), { ...context, kind: 'plans' });
  const searchRows = summaries.map((rm) => ({
    roadmapId: rm.roadmapId, revision: rm.revision, stale: rm.stale, error: Boolean(rm.error),
    tracks: rm.tracks.map((track) => ({ ...track,
      label: (typeof track.label === 'string' ? track.label : '').replace(/[\r\n]+/g, ' ').trim() || track.id })), stages: [],
  }));
  const search = pages(searchRows, { ...context, kind: 'search' });
  const topics = pages([...new Set(searchRows.map((rm) => rm.tracks.length ? rm.tracks[0].label : '미분류'))],
    { ...context, kind: 'topics' });
  const artifacts = [];
  const add = (kind, id, text) => {
    const rel = `roadmap-data/${key}/${kind}-${id}`;
    artifacts.push([`${rel}.json`, text], [`${rel}.js`, script(text)]);
  };
  catalogue.forEach((text, i) => add('catalogue', i, text));
  plans.forEach((text, i) => add('plans', i, text));
  search.forEach((text, i) => add('search', i, text));
  topics.forEach((text, i) => add('topics', i, text));
  for (const rm of vm.roadmaps) {
    add('detail', rm.roadmapId, bounded({ ...context, kind: 'detail', id: rm.roadmapId, items: [rm] }, ROADMAP_LIMITS.vmBytes));
  }
  return { model: { ...vm, roadmaps: JSON.parse(catalogue[0]).items,
    roadmapCatalogue: { key, total: vm.roadmaps.length, cataloguePages: catalogue.length, planPages: plans.length,
      searchPages: search.length, topicPages: topics.length } }, artifacts };
}

export function publishRoadmaps(vm, store) {
  const publication = roadmapPublication(vm);
  // Finish and validate every artifact before publishing a descriptor that can reference it.
  for (const [rel, text] of publication.artifacts) {
    if (store.readText(rel, { maxBytes: ROADMAP_LIMITS.vmBytes }) === null) store.replace(rel, text);
  }
  return publication.model;
}

export function readRoadmapArtifact(stateDir, pathname) {
  if (!ROADMAP_ARTIFACT_PATH.test(pathname)) return null;
  try { return readRoadmapFile(join(stateDir, pathname.slice(1)), ROADMAP_LIMITS.vmBytes); }
  catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return null;
    throw error;
  }
}
