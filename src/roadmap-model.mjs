// Derive the rail exclusively from globally collected definitions and evidence.
const TTL = 60_000;
const STATES = new Set(['pass', 'fail', 'approved', 'rejected', 'open', 'unasked', 'held', 'unknown']);
const complete = (task) => task.mark === 'x' && !task.conflict;
const abandoned = (work) => ['abandoned', 'discarded', 'cancelled', 'canceled'].includes(work?.status);
const running = (work) => work?.status === 'running';

function inventory(plans) {
  const tasks = new Map();
  for (const plan of plans) {
    for (const task of plan.tasks) tasks.set(`${plan.path}\0${task.id}`, { ...task, path: plan.path });
  }
  const all = [...tasks.values()];
  const included = all.filter((task) => task.mark !== '~');
  const conflicts = included.filter((task) => task.conflict).length;
  return {
    tasks: all,
    progress: {
      doneConfirmed: included.filter(complete).length,
      denominator: plans.length && plans.every((plan) => plan.coverage) ? included.length : null,
      observedUniqueIds: all.length,
      excluded: all.length - included.length,
      unconfirmed: included.filter((task) => task.mark === 'x' && task.conflict).length,
      conflicts,
    },
  };
}

function conditionStates(conditions, accepted) {
  return conditions.map((condition) => {
    if (condition.kind === 'stage') return accepted.get(condition.id) ?? 'unknown';
    return STATES.has(condition.state) ? condition.state : 'unknown';
  });
}

function acceptance(stage, accepted) {
  if (!stage.accepts.length) return 'unknown';
  const states = conditionStates(stage.accepts, accepted);
  if (states.some((state) => state === 'fail' || state === 'rejected' || state === 'blocked')) return 'blocked';
  if (states.every((state) => state === 'pass' || state === 'approved')) return 'pass';
  return 'unknown';
}

function stageModel(stage, evidence, accepted, stale) {
  const plans = evidence?.plans ?? [];
  const { tasks, progress } = inventory(plans);
  const requirements = conditionStates(evidence?.requires ?? [], accepted);
  const accepts = conditionStates(evidence?.accepts ?? [], accepted);
  const terminal = accepted.get(stage.id) === 'pass'
    || (plans.length > 0 && plans.every((plan) => abandoned(plan.work)));
  const exitDue = progress.denominator !== null && progress.doneConfirmed === progress.denominator;
  const applicable = exitDue ? [...requirements, ...accepts] : requirements;
  const decisionNeeded = applicable.some((state) => state === 'open' || state === 'unasked');
  const held = applicable.some((state) => state === 'held');
  let blocked = applicable.some((state) => state === 'blocked' || state === 'fail' || state === 'rejected')
    || progress.conflicts > 0;
  const incomplete = tasks.filter((task) => task.mark !== '~' && !complete(task));
  let dependencyUnknown = false;
  let runnable = false;
  for (const task of incomplete) {
    if (!task.dependenciesKnown) { dependencyUnknown = true; continue; }
    const plan = plans.find((item) => item.path === task.path);
    const dependencies = task.deps.map((id) => plan.tasks.find((item) => item.id === id)
      ?? plan.dependencyTasks?.find((item) => item.id === id));
    if (dependencies.some((item) => !item)) { dependencyUnknown = true; continue; }
    if (dependencies.some((item) => !complete(item))) { blocked = true; continue; }
    runnable = true;
  }
  const acceptanceUnknown = progress.denominator !== null && progress.doneConfirmed === progress.denominator
    && accepted.get(stage.id) !== 'pass';
  const unknown = stale || !evidence || !stage.requirementsKnown || progress.denominator === null
    || dependencyUnknown || held || requirements.includes('unknown') || acceptanceUnknown;
  const active = plans.some((plan) => running(plan.work)) || tasks.some((task) => task.last === 'dispatch');
  return {
    ...stage, progress, accepted: accepted.get(stage.id), terminal, held, running: active,
    ready: !terminal && !decisionNeeded && !blocked && !unknown && !active && runnable,
    decisionNeeded: !terminal && decisionNeeded, blocked: !terminal && blocked, unknown,
    plans,
  };
}

export function roadmapModels(records, now) {
  return records.map(({ definition, status, readErrors = [] }) => {
    const projection = definition.projection;
    const time = Date.parse(status?.checkedAt);
    const stale = !status || status.schema !== 'omo-roadmap-status/1'
      || status.definitionRevision !== definition.revision || Boolean(status.error)
      || readErrors.length > 0 || !Number.isFinite(time) || now < time || now - time >= TTL;
    const byId = new Map((status?.stages ?? []).filter((evidence) => {
      const stage = projection.stages.find((item) => item.id === evidence.id);
      return stage && Array.isArray(evidence.plans) && Array.isArray(evidence.requires)
        && Array.isArray(evidence.accepts) && evidence.plans.length === stage.plans.length
        && evidence.requires.length === stage.requires.length && evidence.accepts.length === stage.accepts.length;
    }).map((stage) => [stage.id, stage]));
    const accepted = new Map();
    // Stage dependencies are acyclic, but projection order is not necessarily topological.
    for (let i = 0; i < projection.stages.length; i++) {
      for (const stage of projection.stages) {
        const evidence = byId.get(stage.id);
        const result = stale || !evidence ? 'unknown' : acceptance(evidence, accepted);
        const progress = evidence ? inventory(evidence.plans).progress : null;
        accepted.set(stage.id, result === 'unknown' && progress?.denominator !== null
          && progress?.doneConfirmed < progress?.denominator ? 'blocked' : result);
      }
    }
    return {
      roadmapId: definition.roadmapId, projectionPath: definition.projectionPath,
      revision: definition.revision, checkedAt: status?.checkedAt ?? null,
      stale, error: status?.error ?? readErrors[0] ?? null, tracks: projection.tracks,
      stages: projection.stages.map((stage) => stageModel(stage, byId.get(stage.id), accepted, stale)),
    };
  });
}
