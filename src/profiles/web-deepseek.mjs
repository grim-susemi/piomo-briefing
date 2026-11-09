// Bridge the board to the installed, credential-blind manual provider controller.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const MODULE = 'C:/Users/USER/orca/projects/기타 작업/.omo/research/deepseek-piomo-followup-20261106/diagnosis-r2/deepseek-use/managed-control.cjs';

function controller() {
  return existsSync(MODULE) ? require(MODULE) : null;
}
export function webDeepseekState(home) {
  const api = controller();
  return api ? api.readState({ home }) :
    { enabled: false, revision: 0, installed: false, active: [], mode: 'per-request' };
}
export function webDeepseekDeclaration(home) {
  return controller()?.modelDeclaration({ home }) ?? null;
}
export function setWebDeepseek(home, change) {
  const api = controller();
  if (!api) return { status: 503, json: { ok: false, code: 'WEB_DEEPSEEK_UNAVAILABLE' } };
  if (!change || Object.keys(change).sort().join(',') !== 'enabled,expectedRevision,kind'
    || typeof change.enabled !== 'boolean' || !Number.isInteger(change.expectedRevision)
    || change.expectedRevision < 0) {
    return { status: 400, json: { ok: false, code: 'BAD_WEB_DEEPSEEK_REQUEST' } };
  }
  try {
    const state = api.setEnabled({ home, enabled: change.enabled, expectedRevision: change.expectedRevision });
    return { status: 200, json: { ok: true, webDeepseek: state } };
  } catch (error) {
    const conflict = error.code === 'revision_conflict' || error.code === 'control_busy';
    return { status: conflict ? 409 : 400,
      json: { ok: false, code: conflict ? 'WEB_DEEPSEEK_CONFLICT' : 'WEB_DEEPSEEK_CONTROL_FAILED' } };
  }
}
