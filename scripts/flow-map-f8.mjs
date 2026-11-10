// Board navigation prepares a WinForms control; it never becomes a compared task step.
import { assertPurposeGrid } from './profiles-grid.mjs';

export const F8_CHECKS = [
  'row-open-excluded-from-steps',
  'row-open-before-selects',
  'tab-click-excluded-from-steps',
  'primary-excluded-from-F1',
  'memory-document-order',
  'purpose-group-grid-navigation',
];

export function requireF8(rules) {
  const checks = rules.rules?.F8?.checks;
  for (const check of F8_CHECKS) {
    if (!checks?.includes(check)) throw new Error(`F8 check removed: ${check}`);
  }
}

export const comparisonSections = (sections) => {
  const compared = sections.filter((id) => id !== 'primary');
  const memory = compared.filter((id) => id === 'kibitzer' || id === 'reflection');
  const rest = compared.filter((id) => id !== 'kibitzer' && id !== 'reflection');
  // WinForms' frozen map records memory before routing. Keep that comparison
  // convention here; the interface uses tab order for DOM and native focus.
  const routing = rest.findIndex((id) => /^(agents|categories):/.test(id));
  rest.splice(routing < 0 ? 0 : routing, 0, ...memory);
  return rest;
};
export const comparisonSteps = (steps) => steps.filter((step) => !/^(tab:|row-open:)/.test(step.control));

export function checkF8(board, reference) {
  const differences = [];
  const fail = (check, detail) => differences.push({ check, ...detail });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [task, steps] of Object.entries(board.tasks)) {
    for (const step of steps) {
      if (step.control.startsWith('row-open:')) fail(F8_CHECKS[0], { task, control: step.control });
      if (step.control.startsWith('tab:')) fail(F8_CHECKS[2], { task, control: step.control });
      if (/^(role:|memory:)/.test(step.control)) {
        if (!step.preparation?.row?.expanded) fail(F8_CHECKS[1], { task, control: step.control });
        if (!step.preparation?.tab?.selected) fail(F8_CHECKS[2], { task, control: step.control });
      }
    }
  }
  for (const row of ['role', 'memory']) {
    if (!board.rows.preparation?.[row]?.row?.expanded) fail(F8_CHECKS[1], { row });
    if (!board.rows.preparation?.[row]?.tab?.selected) fail(F8_CHECKS[2], { row });
  }
  if (board.sections.filter((id) => id === 'primary').length !== 1 || board.sections[0] !== 'primary') {
    fail(F8_CHECKS[3], { actual: board.sections });
  }
  const memory = (sections) => sections.filter((id) => id === 'kibitzer' || id === 'reflection');
  if (!same(memory(board.sections), memory(reference.sections))) {
    fail(F8_CHECKS[4], { expected: memory(reference.sections), actual: memory(board.sections) });
  }
  try {
    assertPurposeGrid(board.purposeGrid, `${board.frame?.width || 'board'} F8`);
    for (const steps of Object.values(board.tasks)) {
      const controls = steps.filter(step => /^(role:|memory:)/.test(step.control));
      if (new Set(controls.map(step => step.box?.container)).size > 1) {
        throw new Error('a select cascade changed its scroll coordinate frame');
      }
    }
  } catch (error) {
    fail(F8_CHECKS[5], { message: error.message });
  }
  return differences;
}
