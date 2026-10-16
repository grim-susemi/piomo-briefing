// Child for test/decide.test.mjs: waits for IPC 'go', applies one board answer, reports.
// argv: <store root> <decision id> <session id> <'option'|'text'> <value>
import { openStore } from '../../src/store.mjs';
import { applyBoardAnswer } from '../../src/decide.mjs';

const [, , root, id, sessionId, field, value] = process.argv;
const store = openStore(root);
process.on('message', (m) => {
  if (!m || m.type !== 'go') return;
  try {
    const result = applyBoardAnswer(store, { id: Number(id), sessionId, [field]: value }, Date.now());
    process.send({ type: 'result', result, pid: process.pid }, () => process.exit(0));
  } catch (err) {
    process.send({ type: 'error', message: String((err && err.stack) || err) }, () => process.exit(1));
  }
});
