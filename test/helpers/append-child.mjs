import { appendFileSync } from 'node:fs';

// IPC checkpoints guarantee real reader/writer overlap without timing luck.
const file = process.argv[2];
let writes = 0;
let errors = 0;
function resume(expected) {
  process.once('message', (message) => {
    if (message?.kind !== expected) throw new Error('Unexpected stress message');
    setImmediate(append);
  });
}
function append() {
  const entry = { type: 'custom', customType: 'senpi.todo-state', data: {
    todos: [{ content: `append ${writes}`, status: 'completed' }],
  } };
  try { appendFileSync(file, JSON.stringify(entry) + '\n'); }
  catch { errors++; } // The stress protocol reports every write failure to the parent.
  writes++;
  if (writes === 3000) process.send({ kind: 'done', writes, errors }, () => process.disconnect());
  else if (writes % 100 === 0) {
    resume('continue');
    process.send({ kind: 'checkpoint', writes });
  } else setImmediate(append);
}
resume('start');
process.send({ kind: 'ready' });
