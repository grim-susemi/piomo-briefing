// Child for test/decide.test.mjs: waits for IPC 'go', applies one /decide text, reports.
import { openStore } from '../../src/store.mjs';
import { applyDecide } from '../../src/decide.mjs';

const [, , root, text, from] = process.argv;
const store = openStore(root);
process.on('message', (m) => {
  if (!m || m.type !== 'go') return;
  try {
    const result = applyDecide(store, text, from || 'child', Date.now());
    process.send({ type: 'result', result, pid: process.pid }, () => process.exit(0));
  } catch (err) {
    process.send({ type: 'error', message: String((err && err.stack) || err) }, () => process.exit(1));
  }
});
