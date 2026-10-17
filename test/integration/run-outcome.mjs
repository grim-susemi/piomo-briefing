// The closing line of one test/integration/rpc-run.mjs phase or scenario. The run's verdict is its exit code:
// a scenario or phase can fail without throwing (it sets process.exitCode = 1), so the old unconditional
// `phase <p> finished` line read like a success after a failure. This line names the verdict and the work dir,
// and a failure goes to stderr, where a caller watching for a bad run already looks.

/** `<mode> <name> passed; work=<work>` for exit code 0/undefined, else `<mode> <name> FAILED (exit <code>); work=<work>`. */
export function outcomeLine({ mode, name, exitCode, work }) {
  const failed = exitCode !== undefined && exitCode !== null && exitCode !== 0;
  return failed
    ? `${mode} ${name} FAILED (exit ${exitCode}); work=${work}`
    : `${mode} ${name} passed; work=${work}`;
}

/** Print the outcome line: stderr when the run failed, stdout otherwise. */
export function reportOutcome({ mode, name, work, exitCode, log = console.log, error = console.error }) {
  const line = outcomeLine({ mode, name, exitCode, work });
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) error(line);
  else log(line);
  return line;
}

/**
 * Whether rpc-run's `finally` may remove the work dir. `workGiven` is the same absence test that decides who
 * creates the dir (args.work !== undefined, i.e. the condition that selects mkdtemp): only a dir this run
 * created itself is removed automatically, for every phase and scenario. A caller-given `--work` keeps today's
 * rule - removed only for the phases/scenarios that always cleaned up - so `--work ""` (which resolves to the
 * caller's cwd) and any other explicit dir are never treated as run-owned. `--keep` always wins.
 */
export function shouldRemoveWork({ workGiven, keep, phase, scenario }) {
  if (keep) return false;
  if (!workGiven) return true; // this run created it with mkdtemp
  return phase === 'cleanup' || scenario === 'plan-view' || scenario === 'board-answer';
}
