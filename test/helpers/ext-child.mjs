// Child process for the two-sessions-publishing test: loads the extension with a fake pi, then on the
// parent's IPC 'go' signal calls the brief tool N times and reports each published seq.
import { createBriefingExtension } from '../../extension.mjs';
import { makeFakePi, makeCtx } from './fake-pi.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [stateDir, sid, countArg] = process.argv.slice(2);
const count = Number(countArg);
const host = makeFakePi();
createBriefingExtension({ stateDir, env: { ...process.env, HERDR_BIN_PATH: '' } })(host.pi);
const { ctx } = makeCtx({ sid, file: `C:/sessions/${sid}.jsonl` });
await host.emit('session_start', { reason: 'startup' }, ctx);

process.on('message', async (msg) => {
  if (msg !== 'go') return;
  const seqs = [];
  const errors = [];
  for (let i = 0; i < count; i++) {
    try {
      await host.tool('brief').execute(`c${i}`, {
        title: `${sid} 작업`, status: 'in_progress', headline: `${sid} 번째 ${i}`,
        changes: [], done: [], next: '', decisions: [],
      }, undefined, undefined, ctx);
      seqs.push(JSON.parse(readFileSync(join(stateDir, 'published.json'), 'utf8')).seq);
    } catch (err) {
      errors.push(String(err && err.message || err));
    }
  }
  process.send({ done: true, sid, seqs, errors });
});
process.send({ ready: true, sid });
