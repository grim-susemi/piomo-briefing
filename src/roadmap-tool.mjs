import { RoadmapError, roadmapObject, roadmapKeys } from './roadmap-schema.mjs';
import { loadRoadmapProjection, roadmapRoot, roadmapFilePath, roadmapIdOf } from './roadmap-files.mjs';
import { validateRoadmapDecisions, requestRoadmapGate } from './roadmap-gates.mjs';
import {
  readRoadmaps, withRoadmapLock, writeRoadmapDefinition, unregisterRoadmap, checkRoadmapRevision,
} from './roadmap-registry.mjs';

export const ROADMAP_BRIEF_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    projectionPath: { type: 'string' },
    expectedRevision: { type: ['integer', 'null'], minimum: 1 },
    unregister: { type: 'boolean' },
    requestGate: {
      type: 'object', additionalProperties: false,
      properties: { stageId: { type: 'string' }, gateId: { type: 'string' } },
      required: ['stageId', 'gateId'],
    },
  },
  required: ['projectionPath', 'expectedRevision'],
};
export const ROADMAP_BRIEF_DESCRIPTION = [
  '로드맵 JSON의 경로만 받아 검증하고 전역 등록한다. 원문·투영·기존 결정은 수정하지 않는다.',
  'projectionPath는 현재 프로젝트 .omo/roadmaps/*.json 절대경로다.',
  'expectedRevision은 신규일 때만 null, 그 뒤에는 현재 revision 정수다. 오래된 갱신·해제는 거절한다.',
  'unregister:true는 등록만 해제한다. requestGate:{stageId,gateId}는 등록된 null 승인 조건의 질문을 명시적으로 만든다.',
  '일반 등록은 질문을 만들지 않는다. 질문 응답 전 scope와 operation이 결정에 결속되며 기존 비정형 결정은 unknown이다.',
].join('\n');

export function parseRoadmapRequest(input) {
  if (!roadmapObject(input)) throw new RoadmapError('INPUT', 'input', 'object required');
  const keys = ['projectionPath', 'expectedRevision', 'unregister', 'requestGate'];
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) throw new RoadmapError('INPUT', key, 'unknown key');
  }
  if (typeof input.projectionPath !== 'string') throw new RoadmapError('INPUT', 'projectionPath', 'path required');
  if (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0)) {
    throw new RoadmapError('INPUT', 'expectedRevision', 'current positive revision or initial null required');
  }
  if (input.unregister !== undefined && typeof input.unregister !== 'boolean') {
    throw new RoadmapError('INPUT', 'unregister', 'boolean required');
  }
  if (input.requestGate !== undefined) {
    roadmapKeys(input.requestGate, ['stageId', 'gateId'], 'requestGate');
    for (const value of Object.values(input.requestGate)) {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(value)) {
        throw new RoadmapError('INPUT', 'requestGate', 'valid stage and gate ids required');
      }
    }
    if (input.unregister) throw new RoadmapError('INPUT', 'requestGate', 'cannot request and unregister together');
  }
  return input;
}

const response = (details) => ({
  content: [{ type: 'text', text: JSON.stringify(details) }], details, ...(details.ok === false ? { isError: true } : {}),
});

export function createRoadmapTool(opts) {
  const { store, cwd, sessionId } = opts;
  async function execute(input) {
    if (opts.isEnabled && !opts.isEnabled()) return response({ disabled: true });
    let roadmapId = null;
    let revision = null;
    try {
      const request = parseRoadmapRequest(input);
      const projectRoot = roadmapRoot(cwd);
      const projectionPath = roadmapFilePath(projectRoot, request.projectionPath, 'projection');
      roadmapId = roadmapIdOf(projectionPath);
      const context = { store, expectedRevision: request.expectedRevision, at: (opts.now ?? Date.now)() };
      const saved = withRoadmapLock(store, () => {
        const previous = readRoadmaps(store).find((record) => record.roadmapId === roadmapId);
        revision = previous?.revision ?? null;
        checkRoadmapRevision(previous, request.expectedRevision);
        if (request.unregister) return unregisterRoadmap(context, { roadmapId, projectRoot, projectionPath });
        const definition = loadRoadmapProjection({ projectRoot, projectionPath });
        definition.evidence.decisions = validateRoadmapDecisions(definition, store);
        if (request.requestGate) {
          if (!previous?.registered || previous.projectionHash !== definition.projectionHash) {
            throw new RoadmapError('GATE', 'requestGate', 'register the current projection before requesting a gate');
          }
          const decisionId = requestRoadmapGate({ definition, store, sessionId, at: context.at }, request.requestGate);
          return { ...previous, decisionId };
        }
        return writeRoadmapDefinition(context, definition);
      });
      const publication = opts.publish ? await opts.publish() : null;
      return response({ ok: true, roadmapId, revision: saved.revision, registered: saved.registered,
        ...(saved.decisionId !== undefined ? { decisionId: saved.decisionId } : {}),
        ...(publication?.ok === false ? { publishError: publication.error } : {}),
        errors: [], decisions: saved.evidence.decisions });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const errors = [{ code: error instanceof RoadmapError ? error.code : error.code ?? error.name,
        path: error instanceof RoadmapError ? error.field : input?.projectionPath ?? 'input', message: error.message }];
      return response({ ok: false, roadmapId, revision, errors });
    }
  }
  return { execute, definition: {
    name: 'roadmap_brief', label: 'Roadmap brief', description: ROADMAP_BRIEF_DESCRIPTION,
    parameters: ROADMAP_BRIEF_PARAMETERS,
    execute: (_id, input) => execute(input),
  } };
}
