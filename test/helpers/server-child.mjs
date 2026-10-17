// IPC-driven real host. argv: stateDir sessionId portBase generation installedFile manual.
// Hook registration precedes every product import, including in the frozen legacy variant.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const send = (m) => { if (process.connected) process.send(m); };
if (process.env.OMO_TEST_MUTANT_HOOKS) await import(pathToFileURL(process.env.OMO_TEST_MUTANT_HOOKS));
const { openStore } = await import('../../src/store.mjs');
const product = process.env.OMO_TEST_LEGACY ? '../fixtures/legacy/server-host.b59f5b7.mjs' : '../../src/server-host.mjs';
const { createServerHost, readInstalledGeneration } = await import(product);
const { createBoardServer } = await import('../../src/server.mjs');
const { renderPage } = await import('../../src/render.mjs');
const [stateDir, sessionId, portBase, generationArg = '4', installedFile, manual] = process.argv.slice(2);
const generation = Number(generationArg);
let seq = 0;
const event = (m) => send({ ...m, seq: ++seq });
let crashAt = null;
let failSwap = false;
let idleGate = null;
let closeGate = null;
let hasClosed = false;
const gates = new Map();
async function gateFs(op, path, rec, phase = 'before') {
  const name = basename(String(path));
  for (const gate of gates.values()) {
    if (gate.reached || (gate.after === 'closed' && !hasClosed)) continue;
    if (gate.names && !gate.names.includes(name)) continue;
    if (gate.ops && !gate.ops.includes(op)) continue;
    if (gate.lockRead === 'released') {
      if (phase !== 'after' || name !== 'server.lock' || !rec?.released) continue;
    } else if (phase !== (gate.phase ?? 'before')) continue;
    if (++gate.count !== (gate.nth ?? 1)) continue;
    gate.reached = true;
    event({ type: 'gate', id: gate.id, op, name });
    await gate.promise;
  }
}
const record = (op, path) => {
  const name = basename(String(path));
  if (/^server\.(lock|want)(?:$|\.stale-)/.test(name)) event({ type: 'fsop', op, name });
};
const recordingSyncFs = { ...fs };
for (const op of ['linkSync', 'unlinkSync', 'renameSync']) {
  recordingSyncFs[op] = (...args) => {
    const result = fs[op](...args);
    record(op, op === 'unlinkSync' ? args[0] : args[1]);
    return result;
  };
}
const recordingFs = {
  ...fsp,
  async readFile(path, ...args) {
    await gateFs('readFile', path);
    let result;
    try { result = await fsp.readFile(path, ...args); }
    catch (err) {
      if (basename(String(path)) === 'server.lock' && err.code === 'ENOENT') event({ type: 'lock-read', absent: true });
      throw err;
    }
    let rec;
    if (basename(String(path)) === 'server.lock') {
      try { rec = JSON.parse(result); } catch {}
      event({ type: 'lock-read', rec });
    }
    await gateFs('readFile', path, rec, 'after');
    return result;
  },
  async stat(path, ...args) {
    await gateFs('stat', path);
    return fsp.stat(path, ...args);
  },
  async writeFile(path, text, opts) {
    if (opts?.flag === 'wx') await gateFs('wx', path);
    const result = await fsp.writeFile(path, text, opts);
    if (opts?.flag === 'wx') record('wx', path);
    return result;
  },
  async unlink(path) {
    await gateFs('unlink', path);
    const result = await fsp.unlink(path);
    record('unlink', path);
    return result;
  },
  async rename(from, to) {
    await gateFs('rename', to);
    if (basename(String(to)) === 'server.lock') {
      if (crashAt === 'before-lock-swap') process.exit(1);
      if (failSwap) throw Object.assign(new Error('injected swap EPERM'), { code: 'EPERM' });
    }
    const result = await fsp.rename(from, to);
    record('rename', to);
    if (basename(String(to)) === 'server.lock' && crashAt === 'after-lock-swap') process.exit(1);
    return result;
  },
  async link(from, to) {
    await gateFs('link', to);
    const result = await fsp.link(from, to);
    record('link', to);
    if (basename(String(to)).startsWith('server.lock.stale-') && crashAt === 'after-claim') process.exit(1);
    await gateFs('link', to, undefined, 'after');
    return result;
  },
};
const store = openStore(stateDir, { fs: recordingSyncFs });
const intervals = new Map();
const graceTimeouts = new Map();
const timers = {
  setInterval(fn, ms) {
    const h = manual ? { unref() { return this; } } : setInterval(fn, ms);
    intervals.set(h, { fn, ms });
    return h;
  },
  clearInterval(h) { intervals.delete(h); if (!manual) clearInterval(h); },
  setTimeout(fn, ms) {
    if (manual && ms === 15000) {
      const h = { unref() { return this; } };
      graceTimeouts.set(h, { fn, ms });
      return h;
    }
    return setTimeout(fn, ms);
  },
  clearTimeout(h) { if (!graceTimeouts.delete(h)) clearTimeout(h); },
};
const host = createServerHost({
  stateDir, sessionId, generation,
  installedGeneration: () => installedFile ? readInstalledGeneration(installedFile) : Promise.resolve(null),
  isEnabled: () => store.readSettings().enabled !== false,
  readSnapshot: () => store.readSnapshot(),
  buildViewModel: (snap) => ({
    sessions: snap.sessions.map((s) => ({ id: s.sid, plan: s.meta?.plan ?? null, live: s.meta?.auto?.live ?? null })),
  }),
  getPage: (vm, token) => `<!doctype html><meta name="omo-briefing-generation" content="${generation}"><meta name="omo-board-token" content="${token}"><script type="application/json" id="vm">${JSON.stringify(vm)}</script>`,
  answer: async () => ({ status: 200, json: { ok: true } }),
  reclaimStale: (rel, rec) => store.reclaimStale(rel, rec),
  onError: (key, err) => event({ type: 'error', key, code: err?.code, message: String(err?.message) }),
  onRecover: (key) => event({ type: 'recover', key }),
  onChange: (status) => event({ type: 'change', status, at: Date.now() }),
  env: { OMO_BRIEFING_PORT_BASE: portBase },
  timers, fs: recordingFs,
  createBoardServer(opts) {
    const board = createBoardServer(opts);
    return {
      ...board,
      async start() {
        if (crashAt === 'before-adopt-listen') process.exit(1);
        const result = await board.start();
        event({ type: 'listening', port: result.port, generation });
        return result;
      },
      async close() {
        if (closeGate) { event({ type: 'close-wait' }); await closeGate.promise; }
        await board.close();
        hasClosed = true;
        event({ type: 'closed' });
      },
      async idle() {
        if (idleGate) { event({ type: 'idle-wait' }); await idleGate.promise; }
        return board.idle();
      },
    };
  },
});
process.on('message', async (m) => {
  const reply = (extra) => send({ id: m.id, ...extra });
  try {
    if (m.cmd === 'ensure') reply({ result: await host.ensure() });
    else if (m.cmd === 'tick') {
      for (const { fn, ms } of [...intervals.values()]) if (!m.ms || m.ms === ms) await fn();
      reply({ status: host.status() });
    } else if (m.cmd === 'pause') { await host.onPaused(); reply({ status: host.status() }); }
    else if (m.cmd === 'gate') {
      const gate = { ...m, count: 0, reached: false, ...Promise.withResolvers() };
      gates.set(m.gateId, { ...gate, id: m.gateId });
      reply({});
    } else if (m.cmd === 'open') {
      gates.get(m.gateId)?.resolve();
      gates.delete(m.gateId);
      reply({});
    } else if (m.cmd === 'openAll') {
      for (const gate of gates.values()) gate.resolve();
      gates.clear();
      reply({});
    } else if (m.cmd === 'fire') {
      for (const [h, v] of [...graceTimeouts]) if (v.ms === m.ms) { graceTimeouts.delete(h); await v.fn(); }
      reply({ status: host.status() });
    }
    else if (m.cmd === 'status') reply({ status: host.status() });
    else if (m.cmd === 'crashAt') { crashAt = m.point; reply({}); }
    else if (m.cmd === 'failSwap') { failSwap = m.on; reply({}); }
    else if (m.cmd === 'holdIdle') { idleGate = Promise.withResolvers(); reply({}); }
    else if (m.cmd === 'resumeIdle') { idleGate?.resolve(); idleGate = null; reply({}); }
    else if (m.cmd === 'holdClose') { closeGate = Promise.withResolvers(); reply({}); }
    else if (m.cmd === 'resumeClose') { closeGate?.resolve(); closeGate = null; reply({}); }
    else if (m.cmd === 'publish') {
      const result = renderPage(store, Date.now(), { generation });
      reply({ result });
    } else if (m.cmd === 'setInstalled') {
      store.replace('current.json', { generation: `generation-${String(m.generation).padStart(6, '0')}` });
      reply({});
    } else if (m.cmd === 'release') { await host.release(m.reason); reply({ status: host.status() }); }
    else if (m.cmd === 'exit') {
      await host.release();
      process.send({ id: m.id }, () => process.exit(0));
    }
  } catch (err) { reply({ failure: String(err.stack) }); }
});
process.on('disconnect', () => process.exit(0));
setTimeout(() => process.exit(2), 120000).unref();
event({ type: 'ready', pid: process.pid, module: new URL(product, import.meta.url).href });
