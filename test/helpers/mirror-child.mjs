// Child process for the cross-process mirror test: its own session + its own event bus, same shared STATE.
// On the parent's IPC 'go' it asks and then times out N questions and reports the decision ids it created.
import { createMirror } from '../../src/mirror.mjs';
import { openStore } from '../../src/store.mjs';
import { makeCtx } from './fake-pi.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [stateDir, sid, countArg] = process.argv.slice(2);
const count = Number(countArg);
const store = openStore(stateDir);
const handlers = new Map();
const events = {
  on(channel, fn) { handlers.set(channel, [...(handlers.get(channel) ?? []), fn]); return () => {}; },
  emit(channel, data) { for (const fn of handlers.get(channel) ?? []) fn(data); },
};
let clock = 1_700_000_000_000;
const meta = { sessionId: sid, cwd: 'C:/work/proj', paneId: `pane-${sid}`, lastActivityAt: clock };
const { ctx } = makeCtx({ sid, file: `C:/sessions/${sid}.jsonl` });
const mirror = createMirror({
  pi: { events },
  store,
  stateDir,
  pagePath: join(stateDir, 'index.html'),
  getSessionId: () => sid,
  getMeta: () => meta,
  saveMeta: () => store.replace(`sessions/${sid}/meta.json`, meta),
  refresh: () => ({ ok: true }),
  enabled: () => true,
  now: () => (clock += 1),
  env: {},
});
await mirror.attach(ctx);

process.on('message', (msg) => {
  if (msg !== 'go') return;
  for (let i = 0; i < count; i++) {
    const requestId = `${sid}-req-${i}`;
    events.emit('ask-user:asked', {
      ctx,
      variant: 'claude',
      request: {
        requestId,
        questions: [{
          id: 'q', header: 'h', question: `${sid} 질문 ${i}`, multiSelect: false,
          options: [{ label: 'A안' }, { label: 'B안 (Recommended)' }],
        }],
        waitForAnswer: false,
        timeoutMs: 1000,
      },
    });
    events.emit('ask-user:closed', { requestId, status: 'timed_out' });
  }
  const mine = readdirSync(join(stateDir, 'decisions'))
    .map((n) => JSON.parse(readFileSync(join(stateDir, 'decisions', n), 'utf8')))
    .filter((d) => d.sessionId === sid)
    .map((d) => d.id);
  process.send({ done: true, sid, ids: mine });
});
process.send({ ready: true, sid });
