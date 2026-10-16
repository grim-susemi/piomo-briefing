// Worker for the rollback-interleave test in test/decide.test.mjs.
// Runs one /decide text; at the reclaim hook it publishes the claim record it read,
// signals the parent (flags[0]) and blocks until the parent resumes it (flags[1]).
import { workerData, parentPort } from 'node:worker_threads';
import { openStore } from '../../src/store.mjs';
import { applyDecide } from '../../src/decide.mjs';

const { root, text, from, flags } = workerData;
const f = new Int32Array(flags);
parentPort.once('message', (m) => {
  if (!m || m.type !== 'go') return;
  let staleSeen = null;
  try {
    const hooks = {
      beforeReclaim: (id, stale) => {
        staleSeen = stale;
        Atomics.store(f, 0, 1);
        Atomics.notify(f, 0);
        if (Atomics.wait(f, 1, 0, 30000) === 'timed-out') throw new Error('resume signal never came');
      },
    };
    const result = applyDecide(openStore(root), text, from, 3000, { hooks });
    parentPort.postMessage({ type: 'result', result, staleSeen });
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String((err && err.stack) || err) });
  }
});
