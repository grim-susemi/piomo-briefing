// Bind a question before the owner answers. Agent prose and legacy closures never establish approval.
import { RoadmapError } from './roadmap-schema.mjs';
import { roadmapPathKey, roadmapRoot } from './roadmap-files.mjs';

const decisionRel = (id) => `decisions/${String(id).padStart(6, '0')}.json`;
const rel = (dir, id) => `${dir}/${String(id).padStart(6, '0')}.json`;
const sameRoot = (a, b) => roadmapPathKey(a) === roadmapPathKey(b);
const fields = ['projectRoot', 'roadmapId', 'stageId', 'gateId', 'scope', 'operation'];

export function roadmapGateBinding(definition, stage, gate) {
  return { projectRoot: definition.projectRoot, roadmapId: definition.roadmapId,
    stageId: stage.id, gateId: gate.gateId, scope: gate.scope, operation: gate.operation };
}

export function validateRoadmapDecisions(definition, store) {
  const decisions = [];
  for (const stage of definition.projection.stages) {
    for (const gate of [...stage.requires, ...stage.accepts]) {
      switch (gate.kind) {
        case 'decision': {
          if (gate.decisionId === null) {
            decisions.push({ stageId: stage.id, gateId: gate.gateId, decisionId: null, bindingState: 'unasked' });
            break;
          }
          const decision = store.readRecord(decisionRel(gate.decisionId));
          if (!decision || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decision.sessionId)) {
            throw new RoadmapError('OWNERSHIP', `decision:${gate.decisionId}`, 'decision or owner missing');
          }
          const owner = store.readRecord(`sessions/${decision.sessionId}/meta.json`);
          if (!owner || typeof owner.cwd !== 'string' || !sameRoot(roadmapRoot(owner.cwd), definition.projectRoot)) {
            throw new RoadmapError('OWNERSHIP', `decision:${gate.decisionId}`, 'foreign project decision');
          }
          const expected = roadmapGateBinding(definition, stage, gate);
          const binding = decision.roadmapBinding;
          if (binding !== undefined && (!binding || fields.some((key) => binding[key] !== expected[key])
            || Object.keys(binding).some((key) => !fields.includes(key))
            || decision.source !== 'roadmap' || decision.approvalOption !== 'A' || decision.rejectionOption !== 'B')) {
            throw new RoadmapError('BINDING', `decision:${gate.decisionId}`, 'gate scope or operation binding mismatch');
          }
          decisions.push({ stageId: stage.id, gateId: gate.gateId, decisionId: gate.decisionId,
            bindingState: binding === undefined ? 'unknown' : 'bound', sessionId: decision.sessionId });
          break;
        }
        case 'stage': case 'receipt': break;
        default: throw new RoadmapError('SCHEMA', stage.id, 'unsupported condition');
      }
    }
  }
  return decisions;
}

export function requestRoadmapGate(context, request) {
  const { definition, store, sessionId, at } = context;
  const stage = definition.projection.stages.find((item) => item.id === request.stageId);
  const gate = stage && [...stage.requires, ...stage.accepts]
    .find((item) => item.kind === 'decision' && item.gateId === request.gateId);
  if (!gate || gate.decisionId !== null) throw new RoadmapError('GATE', 'requestGate', 'registered null decision gate required');
  const owner = store.readRecord(`sessions/${sessionId}/meta.json`);
  if (!owner || typeof owner.cwd !== 'string' || !sameRoot(roadmapRoot(owner.cwd), definition.projectRoot)) {
    throw new RoadmapError('OWNERSHIP', 'requestGate', 'requesting session must belong to this project');
  }
  const binding = roadmapGateBinding(definition, stage, gate);
  const snap = store.readSnapshot();
  if (snap.readErrors.some((error) => /^(decisions|decision-closures)\//.test(error.rel))) {
    throw new RoadmapError('READ', 'requestGate', 'decision inventory incomplete');
  }
  const existing = snap.decisions.find((decision) => decision.source === 'roadmap'
    && fields.every((key) => decision.roadmapBinding?.[key] === binding[key])
    && !snap.closures.some((closure) => closure.id === decision.id && closure.reason !== 'held'));
  if (existing) return existing.id;
  return store.allocDecisionId({
    sessionId, source: 'roadmap', createdAt: at, roadmapBinding: binding,
    approvalOption: 'A', rejectionOption: 'B',
    question: `${stage.label}: ${gate.operation} 승인?`,
    options: {
      A: { text: '승인', consequence: '아래 범위와 작업만 승인' },
      B: { text: '거절', consequence: '이 작업의 착수 차단' },
    },
    recommend: 'B', reason: `${gate.operation}: ${gate.scope}`, blocks: true,
  });
}

// Collector API: only an owner answer to a bound immutable question can satisfy a gate.
export function roadmapDecisionEvidence(context, gate) {
  const { definition, stage, store } = context;
  if (gate.decisionId === null) return { state: 'unasked' };
  const evidence = validateRoadmapDecisions({ ...definition, projection: {
    ...definition.projection, stages: [{ ...stage, requires: [gate], accepts: [] }],
  } }, store)[0];
  if (evidence.bindingState !== 'bound') return { state: 'unknown' };
  const id = gate.decisionId;
  const answerText = store.readText(rel('answers', id));
  const closureText = store.readText(rel('decision-closures', id));
  const answer = answerText === null ? null : JSON.parse(answerText);
  const closure = closureText === null ? null : JSON.parse(closureText);
  if (closure?.reason === 'held') return { state: 'held' };
  if (closure && (closure.reason !== 'answered' || !answer)) return { state: 'unknown' };
  if (!answer) return { state: 'open' };
  switch (answer.option) {
    case 'A': return { state: 'approved' };
    case 'B': return { state: 'rejected' };
    default: return { state: 'unknown' };
  }
}
