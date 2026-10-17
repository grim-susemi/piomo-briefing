// Child process for the two-sessions-publishing test: loads the extension with a fake pi, then on the
// parent's IPC 'go' signal calls the brief tool N times and reports each published seq.
import { makeFakePi, makeCtx } from './fake-pi.mjs';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.OMO_TEST_MUTANT_HOOKS) await import(pathToFileURL(process.env.OMO_TEST_MUTANT_HOOKS));
const { createBriefingExtension } = await import('../../extension.mjs');
const { createServerHost } = await import('../../src/server-host.mjs');

const [stateDir, sid, countArg] = process.argv.slice(2);
const count = Number(countArg);
const host = makeFakePi();
const options = process.env.OMO_TEST_EXT ? JSON.parse(process.env.OMO_TEST_EXT) : {};
if (options.portBase !== undefined && (!Number.isInteger(options.portBase) || options.portBase < 47400 || options.portBase > 49151)) throw new Error('invalid test portBase');
let server;
// Blank binary paths select Herdr's fallback. Clear the reader's tab identity,
// and keep server fixtures behind a fake execution seam even if that gate regresses.
const fixtureEnv = { ...process.env, HERDR_TAB_ID: '', HERDR_PANE_ID: '', HERDR_BIN_PATH: '', ...(options.portBase !== undefined ? { OMO_BRIEFING_PORT_BASE: String(options.portBase) } : {}) };
const execCalls = [];
const fixture = () => ({
  identity: Object.fromEntries(['HERDR_TAB_ID', 'HERDR_PANE_ID', 'HERDR_BIN_PATH'].map(name => [name, {
    present: Object.hasOwn(fixtureEnv, name), empty: !fixtureEnv[name],
  }])),
  execCalls: [...execCalls],
});
createBriefingExtension({
  stateDir, ...options,
  env: fixtureEnv,
  ...(options.server ? { execFile: (file, args, _opts, callback) => {
    execCalls.push({ executable: basename(file), verb: args[0], action: args[1], argc: args.length });
    queueMicrotask(() => callback(Object.assign(new Error('fixture external execution disabled'), { code: 'OMO_TEST_NO_EXEC' }), '', ''));
  } } : {}),
  createServerHost: (opts) => {
    // Server-mode tests advance host checks explicitly through IPC tick, never by timing luck.
    const timers = options.server ? {
      ...opts.timers,
      setInterval: () => ({ unref() { return this; } }),
      clearInterval() {},
    } : opts.timers;
    server = createServerHost({ ...opts, timers });
    return server;
  },
})(host.pi);
const { ctx } = makeCtx({ sid, file: `C:/sessions/${sid}.jsonl` });

let commands = Promise.resolve();
const deadline = options.server ? setTimeout(() => { void exit(); }, 120000) : null;
async function exit() {
  if (deadline) clearTimeout(deadline);
  await host.emit('session_shutdown', { reason: 'quit' }, ctx);
  // A reload deliberately detached the extension from its host. End that owned grace entry too.
  if (server) await server.release('quit');
  if (process.connected) process.disconnect();
}
process.on('message', async (msg) => {
  if (options.server && msg && typeof msg === 'object') {
    commands = commands.then(async () => {
      if (msg.command === 'exit') { await exit(); return; }
      if (msg.command === 'shutdown') await host.emit('session_shutdown', { reason: msg.reason }, ctx);
      if (msg.command === 'tick') await server.ensure();
      if (msg.command === 'brief') await host.tool('brief').execute('test', {
        title: sid, status: 'in_progress', headline: sid, changes: [], done: [], next: '', decisions: [],
        ...(msg.params ?? {}),
      }, undefined, undefined, ctx);
      const meta = JSON.parse(readFileSync(join(stateDir, 'sessions', sid, 'meta.json'), 'utf8'));
      process.send({ id: msg.id, status: server.status(), meta, fixture: fixture() });
    }).catch(err => { process.send({ id: msg.id, error: String(err.stack || err) }); });
    return;
  }
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
  await host.emit('session_shutdown', {}, ctx);
  process.send({ done: true, sid, seqs, errors }, () => process.disconnect());
});
await host.emit('session_start', { reason: 'startup' }, ctx);
process.send({ ready: true, sid });
