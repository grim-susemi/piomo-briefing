import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeChromeProcess, isPidAlive, killProcessTree } from '../scripts/cdp.mjs';

const fixture = new URL('./fixtures/cdp/fake-chrome.mjs', import.meta.url);
const bounded = () => ({ signal: AbortSignal.timeout(20_000) });
const exited = (proc) => proc.exitCode !== null || proc.signalCode !== null;

async function stop(proc) {
  if (exited(proc)) return;
  const exit = once(proc, 'exit', bounded());
  killProcessTree(proc.pid);
  proc.kill('SIGKILL');
  proc.stderr?.destroy();
  await exit;
  console.log(`cleanup pid ${proc.pid} alive=${isPidAlive(proc.pid)}`);
}

test('Chrome cleanup waits for exit, not inherited stderr close, and removes the descendant and profile', async (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-cdp-test-'));
  // A second inherited pipe keeps ChildProcess.close pending even when the helper
  // destroys its stderr reader. No event or stream method is mocked.
  const proc = fork(fixture, ['parent', profileDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let grandchild;
  let cleanupStarted = false;
  const order = [];
  proc.once('exit', () => order.push('parent-exit'));
  proc.once('close', () => order.push('stdio-close'));
  const closed = once(proc, 'close', bounded());
  t.after(async () => {
    cleanupStarted = true;
    await stop(proc);
    if (grandchild && isPidAlive(grandchild)) {
      order.push('teardown-kill');
      killProcessTree(grandchild);
    }
    await closed;
    await fs.promises.rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    console.log(`fixture teardown parent=${proc.pid} grandchild=${grandchild} alive=${isPidAlive(grandchild)} profileExists=false order=${order.join('>')}`);
  });
  const [ready] = await once(proc, 'message', bounded());
  grandchild = ready.grandchild;
  console.log(`fixture parent=${proc.pid} grandchild=${grandchild} profile=${profileDir}`);
  const killed = [];
  await closeChromeProcess({
    proc, profileDir,
    deps: {
      async killProcessTree(pid) {
        killed.push(pid);
        // Only the profile-scoped sweep may end the inherited-pipe hold.
        if (pid === proc.pid) proc.send('exit');
        else {
          order.push('profile-kill');
          killProcessTree(pid);
          await closed;
        }
      },
      listProfilePids(dir) {
        assert.equal(dir, profileDir);
        assert.ok(exited(proc), 'parent has exited before the profile sweep');
        assert.ok(proc.stderr.destroyed, 'the inherited pipe is destroyed before the sweep');
        assert.equal(isPidAlive(grandchild), true, 'grandchild outlives parent exit');
        assert.equal(order.includes('stdio-close'), false, 'close must remain unavailable until the profile sweep kills the descendant');
        assert.equal(cleanupStarted, false, 'the test cleanup has not released the inherited pipes');
        order.push('profile-sweep');
        return [grandchild];
      },
      rm(dir, options) {
        assert.deepEqual(options, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        return fs.promises.rm(dir, options);
      },
    },
  });
  order.push('resolved');
  assert.equal(cleanupStarted, false, 'closeChromeProcess resolves before test teardown');
  assert.deepEqual(order, ['parent-exit', 'profile-sweep', 'profile-kill', 'stdio-close', 'resolved']);
  assert.deepEqual(killed, [proc.pid, grandchild]);
  assert.equal(isPidAlive(proc.pid), false);
  assert.equal(isPidAlive(grandchild), false);
  assert.equal(fs.existsSync(profileDir), false);
  console.log(`cleanup parent=${proc.pid} alive=false grandchild=${grandchild} alive=false profileExists=false order=${order.join('>')}`);
});

test('Chrome cleanup rejects with the profile path when an unlisted process holds its cwd', async (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-cdp-test-'));
  // execArgv: [] drops npm test's relative --import of the live-write guard, which does not resolve from the profile
  // folder; the guard still reaches this child through NODE_OPTIONS (test/helpers/refuse-live-writes.mjs).
  const holder = fork(fixture, ['hold', profileDir], {
    cwd: profileDir, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  t.after(async () => {
    await stop(holder);
    await fs.promises.rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    assert.equal(fs.existsSync(profileDir), false);
    console.log(`cleanup held-dir pid=${holder.pid} alive=${isPidAlive(holder.pid)} profileExists=false`);
  });
  await once(holder, 'message', bounded());
  console.log(`held-dir pid=${holder.pid} profile=${profileDir}`);
  const proc = fork(fixture, ['hold', profileDir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  t.after(() => stop(proc));
  await once(proc, 'message', bounded());
  await assert.rejects(closeChromeProcess({
    proc, profileDir,
    deps: { killProcessTree, listProfilePids: () => [], rm: fs.promises.rm },
  }), (err) => {
    assert.ok(err.message.includes(profileDir), err.message);
    console.log(`expected held-dir rejection: ${err.message}`);
    return true;
  });
  assert.equal(isPidAlive(holder.pid), true, 'an unlisted process is not killed');
  assert.equal(fs.existsSync(profileDir), true);
});
