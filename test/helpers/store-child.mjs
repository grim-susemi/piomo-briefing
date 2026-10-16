// Child process used by test/store.test.mjs (not a test file itself).
import * as fs from 'node:fs';
import { openStore } from '../../src/store.mjs';

const [mode, root, a, b] = process.argv.slice(2);
const store = openStore(root);

if (mode === 'alloc') {
  const ids = [];
  for (let i = 0; i < Number(a); i++) ids.push(store.allocDecisionId({ sessionId: 'child-' + process.pid, question: 'q' + i }));
  process.send({ type: 'ids', ids });
  process.exit(0);
}

if (mode === 'writer') {
  const w = Number(a);
  const n = Number(b);
  fs.mkdirSync(root, { recursive: true });
  process.on('message', (m) => {
    if (m.type !== 'go') return;
    try {
      for (let i = 0; i < n; i++) {
        store.replace('stress.json', { w, i, pad: 'x'.repeat(2000) });
        process.send({ type: 'replaced', w, i });
      }
      process.send({ type: 'done', w }, () => process.exit(0));
    } catch (err) {
      process.send({ type: 'error', message: String(err && err.stack || err) }, () => process.exit(1));
    }
  });
}

if (mode === 'reader') {
  fs.mkdirSync(root, { recursive: true });
  let reads = 0;
  let failures = 0;
  const failureSamples = [];
  let last = null;
  function readNow() {
    let text;
    try { text = store.readText('stress.json'); } // the store's own reader: retries transient replace-window errors
    catch (err) { failures++; if (failureSamples.length < 5) failureSamples.push('read ' + err.code); return; }
    if (text === null) {
      if (last === null) return; // before the first replace lands
      failures++; if (failureSamples.length < 5) failureSamples.push('read missing'); return;
    }
    reads++;
    try {
      const v = JSON.parse(text);
      if (![1, 2].includes(v.w) || typeof v.i !== 'number') throw new Error('bad shape');
      last = { w: v.w, i: v.i };
    } catch (err) {
      failures++; if (failureSamples.length < 5) failureSamples.push('parse ' + err.message + ' len=' + text.length);
    }
  }
  const watcher = fs.watch(root, () => readNow());
  process.on('message', (m) => {
    if (m.type === 'check') readNow();
    else if (m.type === 'final') {
      readNow();
      watcher.close();
      process.send({ type: 'final', reads, failures, failureSamples, content: last }, () => process.exit(0));
    }
  });
  process.send({ type: 'ready' });
}
