// Structural boundary for roadmap projection v1. No file or owner state is inferred here.
export const ROADMAP_LIMITS = Object.freeze({
  bytes: 256 * 1024, roadmaps: 8, tracks: 6, stages: 40, sources: 16, plans: 4, conditions: 16,
  vmBytes: 2 * 1024 * 1024,
});
export const ROADMAP_OPERATIONS = Object.freeze(['implement', 'install', 'publish', 'accept', 'other']);
const ID = /^[a-zA-Z0-9_-]{1,48}$/;
export const ROADMAP_HASH = /^[a-fA-F0-9]{64}$/;
export const roadmapObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const roadmapTime = (v) => typeof v === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);

export class RoadmapError extends Error {
  constructor(code, field, detail) {
    super(`${field}: ${detail}`);
    this.name = 'RoadmapError';
    this.code = code;
    this.field = field;
  }
}

export function roadmapKeys(value, keys, field) {
  if (!roadmapObject(value)) throw new RoadmapError('SCHEMA', field, 'object required');
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new RoadmapError('SCHEMA', `${field}.${key}`, 'unknown key');
  }
  for (const key of keys) {
    if (!(key in value)) throw new RoadmapError('SCHEMA', `${field}.${key}`, 'required');
  }
}

export function roadmapString(value, field, bounds) {
  if (typeof value !== 'string' || value.normalize('NFC') !== value
    || [...value].length < bounds[0] || [...value].length > bounds[1]
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new RoadmapError('SCHEMA', field, `NFC string of ${bounds.join('..')} characters required`);
  }
}

function id(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw new RoadmapError('SCHEMA', field, 'invalid id');
}
function array(value, field, max) {
  if (!Array.isArray(value) || value.length > max) throw new RoadmapError('SCHEMA', field, `array <= ${max} required`);
}
function unique(items, field) {
  if (new Set(items).size !== items.length) throw new RoadmapError('SCHEMA', field, 'duplicate id');
}
function hash(value, field) {
  if (typeof value !== 'string' || !ROADMAP_HASH.test(value)) throw new RoadmapError('SCHEMA', field, 'SHA256 required');
}
function operation(value, field) {
  if (!ROADMAP_OPERATIONS.includes(value)) throw new RoadmapError('SCHEMA', field, 'unsupported operation');
}

function condition(value, field) {
  if (!roadmapObject(value)) throw new RoadmapError('SCHEMA', field, 'condition object required');
  switch (value.kind) {
    case 'stage':
      roadmapKeys(value, ['kind', 'id'], field);
      id(value.id, `${field}.id`);
      break;
    case 'decision':
      roadmapKeys(value, ['kind', 'gateId', 'decisionId', 'scope', 'operation'], field);
      id(value.gateId, `${field}.gateId`);
      if (value.decisionId !== null && (!Number.isSafeInteger(value.decisionId) || value.decisionId <= 0)) {
        throw new RoadmapError('SCHEMA', `${field}.decisionId`, 'positive integer or null required');
      }
      roadmapString(value.scope, `${field}.scope`, [1, 120]);
      operation(value.operation, `${field}.operation`);
      break;
    case 'receipt':
      roadmapKeys(value, ['kind', 'path', 'sha256', 'subjectHash', 'operation'], field);
      roadmapString(value.path, `${field}.path`, [1, 4096]);
      hash(value.sha256, `${field}.sha256`);
      hash(value.subjectHash, `${field}.subjectHash`);
      operation(value.operation, `${field}.operation`);
      break;
    default:
      throw new RoadmapError('SCHEMA', `${field}.kind`, 'unsupported condition');
  }
}

function parseProjection(value) {
  roadmapKeys(value, ['schemaVersion', 'generatedAt', 'generatedBy', 'sources', 'tracks', 'stages'], 'projection');
  if (value.schemaVersion !== 1) throw new RoadmapError('SCHEMA', 'schemaVersion', 'unsupported version');
  if (!roadmapTime(value.generatedAt)) throw new RoadmapError('SCHEMA', 'generatedAt', 'UTC RFC3339 required');
  roadmapString(value.generatedBy, 'generatedBy', [1, 80]);
  array(value.sources, 'sources', ROADMAP_LIMITS.sources);
  array(value.tracks, 'tracks', ROADMAP_LIMITS.tracks);
  array(value.stages, 'stages', ROADMAP_LIMITS.stages);
  for (const [index, source] of value.sources.entries()) {
    const field = `sources[${index}]`;
    roadmapKeys(source, ['id', 'path', 'headingPath', 'sha256'], field);
    id(source.id, `${field}.id`);
    roadmapString(source.path, `${field}.path`, [1, 4096]);
    array(source.headingPath, `${field}.headingPath`, 6);
    if (!source.headingPath.length) throw new RoadmapError('SCHEMA', field, 'heading path required');
    source.headingPath.forEach((segment) => roadmapString(segment, `${field}.headingPath`, [1, 200]));
    hash(source.sha256, `${field}.sha256`);
  }
  unique(value.sources.map((source) => source.id), 'sources');
  const stages = new Set(value.stages.map((stage) => stage?.id));
  const sources = new Set(value.sources.map((source) => source.id));
  const memberships = [];
  for (const [index, track] of value.tracks.entries()) {
    const field = `tracks[${index}]`;
    roadmapKeys(track, ['id', 'label', 'stageIds'], field);
    id(track.id, `${field}.id`);
    roadmapString(track.label, `${field}.label`, [1, 14]);
    array(track.stageIds, `${field}.stageIds`, ROADMAP_LIMITS.stages);
    for (const stageId of track.stageIds) {
      id(stageId, `${field}.stageIds`);
      if (!stages.has(stageId)) throw new RoadmapError('SCHEMA', field, `unknown stage ${stageId}`);
      memberships.push(stageId);
    }
  }
  unique(value.tracks.map((track) => track.id), 'tracks');
  unique(memberships, 'tracks.stageIds');
  unique(value.stages.map((stage) => stage?.id), 'stages');
  const planStages = new Map();
  const edges = new Map();
  for (const [index, stage] of value.stages.entries()) {
    const field = `stages[${index}]`;
    roadmapKeys(stage, ['id', 'label', 'goal', 'sourceId', 'requires', 'accepts', 'plans', 'requirementsKnown', 'note'], field);
    id(stage.id, `${field}.id`);
    roadmapString(stage.label, `${field}.label`, [1, 14]);
    roadmapString(stage.goal, `${field}.goal`, [1, 80]);
    roadmapString(stage.note, `${field}.note`, [0, 120]);
    if (typeof stage.requirementsKnown !== 'boolean') throw new RoadmapError('SCHEMA', `${field}.requirementsKnown`, 'boolean required');
    if (!sources.has(stage.sourceId)) throw new RoadmapError('SCHEMA', `${field}.sourceId`, 'unknown source');
    if (!memberships.includes(stage.id)) throw new RoadmapError('SCHEMA', field, 'stage has no track');
    const gates = [];
    const refs = [];
    for (const name of ['requires', 'accepts']) {
      array(stage[name], `${field}.${name}`, ROADMAP_LIMITS.conditions);
      stage[name].forEach((item, i) => {
        condition(item, `${field}.${name}[${i}]`);
        switch (item.kind) {
          case 'stage':
            if (!stages.has(item.id)) throw new RoadmapError('SCHEMA', field, `unknown stage ${item.id}`);
            refs.push(item.id);
            break;
          case 'decision': gates.push(item.gateId); break;
          case 'receipt': break;
          default: throw new RoadmapError('SCHEMA', field, 'unsupported condition');
        }
      });
    }
    unique(gates, `${field}.gateId`);
    edges.set(stage.id, refs);
    array(stage.plans, `${field}.plans`, ROADMAP_LIMITS.plans);
    for (const [i, plan] of stage.plans.entries()) {
      const pf = `${field}.plans[${i}]`;
      roadmapKeys(plan, ['path', 'taskIds'], pf);
      roadmapString(plan.path, `${pf}.path`, [1, 4096]);
      if (plan.taskIds !== null) {
        array(plan.taskIds, `${pf}.taskIds`, 400);
        plan.taskIds.forEach((taskId) => {
          if (typeof taskId !== 'string' || !/^F?\d{1,3}[a-z]?$/.test(taskId)) {
            throw new RoadmapError('SCHEMA', `${pf}.taskIds`, 'invalid task id');
          }
        });
      }
      const refsForPath = planStages.get(plan.path) ?? [];
      refsForPath.push({ stageId: stage.id, taskIds: plan.taskIds });
      planStages.set(plan.path, refsForPath);
    }
  }
  for (const [planPath, refs] of planStages) {
    if (new Set(refs.map((ref) => ref.stageId)).size > 1 && refs.some((ref) => ref.taskIds === null)) {
      throw new RoadmapError('SCHEMA', planPath, 'shared plan requires explicit taskIds');
    }
  }
  const visited = new Set();
  const visiting = new Set();
  const visit = (stageId) => {
    if (visiting.has(stageId)) throw new RoadmapError('SCHEMA', 'stages', `cycle at ${stageId}`);
    if (visited.has(stageId)) return;
    visiting.add(stageId);
    for (const ref of edges.get(stageId)) visit(ref);
    visiting.delete(stageId);
    visited.add(stageId);
  };
  for (const stageId of stages) visit(stageId);
  return structuredClone(value);
}

export function validateRoadmapProjection(input) {
  try {
    const normalized = parseProjection(input);
    return { ok: true, errors: [], normalized };
  } catch (error) {
    if (!(error instanceof RoadmapError)) throw error;
    return { ok: false, errors: [{ code: error.code, path: error.field, message: error.message }], normalized: null };
  }
}
