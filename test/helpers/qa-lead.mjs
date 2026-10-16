// Child process for scripts/qa-browser.mjs (not a test file): one lead conversation = the real extension on a fake pi, with
// a real board server host. Driven over IPC: {id, cmd, ...} -> {id, result|error}.
// argv: stateDir sessionId cwd portBase
import { createBriefingExtension } from '../../extension.mjs';
import { makeFakePi, makeCtx } from './fake-pi.mjs';

const [stateDir, sid, cwd, base] = process.argv.slice(2);
const RPC = 'senpi:extension-rpc-event';
const listeners = new Set();
const bus = {
  on(channel, fn) { if (channel === RPC) listeners.add(fn); return () => listeners.delete(fn); },
};
const host = makeFakePi({ cwd });
host.pi.events = bus;
const opened = [];
createBriefingExtension({
  stateDir,
  env: { PATH: process.env.PATH, HERDR_BIN_PATH: '', OMO_BRIEFING_PORT_BASE: base },
  server: true,
  generation: 4,
  openPage: (p) => { opened.push(p); return { launcher: 'chrome', command: 'qa', args: [] }; },
})(host.pi);
const { ctx } = makeCtx({ cwd, sid, file: `C:/sessions/${sid}.jsonl` });

const handlers = {
  start: async () => { await host.emit('session_start', { reason: 'startup' }, ctx); return { pid: process.pid }; },
  brief: async (m) => host.tool('brief').execute('qa', m.input, undefined, undefined, ctx).then((r) => r.content.map((b) => b.text).join('\n')),
  plan: async (m) => host.tool('plan_brief').execute('qa', m.input, undefined, undefined, ctx).then((r) => r.content.map((b) => b.text).join('\n')),
  rpc: async (m) => { for (const fn of [...listeners]) fn({ name: 'omo.task.updated', data: m.data }); return true; },
  command: async (m) => { await host.commands.get(m.name).handler(m.args ?? '', ctx); return opened.at(-1) ?? null; },
  shutdown: async () => { await host.emit('session_shutdown', {}, ctx); return true; },
};

process.on('message', async (m) => {
  try {
    const result = await handlers[m.cmd](m);
    process.send({ id: m.id, result });
  } catch (err) {
    process.send({ id: m.id, error: String((err && err.stack) || err) });
  }
});
process.on('disconnect', () => process.exit(0));
process.send({ ready: true, pid: process.pid });
