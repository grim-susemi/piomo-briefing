// Child process used by test/server-host.test.mjs (not a test file): one server host per process, driven over IPC.
// argv: stateDir sessionId portBase. Timers are the real ones; {cmd:'tick'} additionally runs every live interval
// callback once, now, so a test can see what this process decides on its next check without waiting for the clock.
import { openStore } from '../../src/store.mjs';
import { createServerHost } from '../../src/server-host.mjs';

const [stateDir, sessionId, portBase] = process.argv.slice(2);
const store = openStore(stateDir);
const intervals = new Map();
const timers = {
  setInterval(fn, ms) {
    const h = setInterval(fn, ms);
    intervals.set(h, fn);
    return h;
  },
  clearInterval(h) {
    intervals.delete(h);
    clearInterval(h);
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};
const send = (m) => {
  if (process.connected) process.send(m);
};

const host = createServerHost({
  stateDir,
  sessionId,
  generation: 4,
  isEnabled: () => store.readSettings().enabled !== false,
  readSnapshot: () => store.readSnapshot(),
  // this generation's view model: plan and live come from the store, never from a data.js another generation wrote
  buildViewModel: (snap) => ({
    sessions: snap.sessions.map((s) => ({ id: s.sid, plan: s.meta?.plan ?? null, live: s.meta?.auto?.live ?? null })),
  }),
  getPage: (vm) => `<!doctype html><meta name="omo-briefing-generation" content="4"><script type="application/json" id="vm">${JSON.stringify(vm)}</script>`,
  reclaimStale: (rel, rec) => store.reclaimStale(rel, rec),
  onError: (key, err) => send({ type: 'error', key, code: err && err.code, message: String(err && err.message) }),
  onRecover: (key) => send({ type: 'recover', key }),
  onChange: (status) => send({ type: 'change', status, at: Date.now() }),
  env: { OMO_BRIEFING_PORT_BASE: portBase },
  timers,
});

process.on('message', async (m) => {
  const reply = (extra) => send({ id: m.id, ...extra });
  if (m.cmd === 'ensure') reply({ result: await host.ensure() });
  else if (m.cmd === 'tick') {
    for (const fn of [...intervals.values()]) await fn();
    reply({ status: host.status() });
  } else if (m.cmd === 'pause') {
    await host.onPaused();
    reply({ status: host.status() });
  } else if (m.cmd === 'status') reply({ status: host.status() });
  else if (m.cmd === 'exit') {
    await host.release();
    process.send({ id: m.id }, () => process.exit(0));
  }
});
process.on('disconnect', () => process.exit(0));
send({ type: 'ready', pid: process.pid });
