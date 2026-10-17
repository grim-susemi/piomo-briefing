import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './helpers/temp.mjs';

test('tempDir awaits every disposer before removing the directory, using one after hook', async () => {
  const hooks = [];
  const { dir, onDispose } = tempDir({ after: fn => hooks.push(fn) }, 'omo-temp-helper-');
  const order = [];
  onDispose(async () => {
    await Promise.resolve();
    assert.ok(existsSync(dir));
    writeFileSync(join(dir, 'last-write'), 'disposed');
    order.push('first');
  });
  onDispose(() => {
    assert.ok(existsSync(join(dir, 'last-write')));
    order.push('second');
  });
  assert.equal(hooks.length, 1);
  await hooks[0]();
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(existsSync(dir), false);
});

const helper = new URL('./helpers/temp.mjs', import.meta.url).href;
function run(code) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 30_000, env,
  });
  console.log('FIXTURE-CLEANUP', result.pid, result.status, result.signal);
  return result;
}

test('tempDir fails the owning test with a rejected disposer message and still cleans up', () => {
  const result = run(`
    import { test } from 'node:test';
    import { existsSync } from 'node:fs';
    import { tempDir } from ${JSON.stringify(helper)};
    test('rejecting disposer', t => {
      const { dir, onDispose } = tempDir({ after: fn => t.after(async () => {
        try { await fn(); } finally { console.log('ROOT-REMOVED', !existsSync(dir)); }
      }) }, 'omo-temp-helper-reject-');
      console.log('ROOT', dir);
      onDispose(async () => { throw new Error('disposer rejected deliberately'); });
      onDispose(() => { console.log('SECOND-DISPOSER', existsSync(dir)); });
    });
  `);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /disposer rejected deliberately/);
  assert.match(result.stdout, /SECOND-DISPOSER true/);
  assert.match(result.stdout, /ROOT-REMOVED true/);
});

test('tempDir reports the held directory path; its holder exits before final cleanup', () => {
  const result = run(`
    import { test } from 'node:test';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { existsSync, rmSync } from 'node:fs';
    import { tempDir } from ${JSON.stringify(helper)};
    test('held cwd', async t => {
      let child, exited;
      const { dir } = tempDir({ after: fn => t.after(async () => {
        try { await fn(); } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          await exited;
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          console.log('HOLDER-CLEANUP', child.pid, !existsSync(dir));
        }
      }) }, 'omo-temp-helper-held-');
      console.log('ROOT', dir);
      child = spawn(process.execPath, ['-e',
        'setTimeout(()=>process.exit(2),20000);console.log("READY");setInterval(()=>{},1<<30)'
      ], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
      exited = once(child, 'exit');
      await new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('holder did not become ready')), 5000);
        child.once('error', reject);
        child.stdout.once('data', () => { clearTimeout(guard); resolve(); });
      });
      console.log('HOLDER', child.pid);
    });
  `);
  assert.equal(result.error, undefined);
  const output = result.stdout + result.stderr;
  const dir = /^ROOT (.+)$/m.exec(result.stdout)?.[1]?.trim();
  assert.ok(dir, output);
  assert.equal(result.status, process.platform === 'win32' ? 1 : 0, output);
  if (process.platform === 'win32') {
    assert.ok(output.includes(dir), output);
    assert.match(output, /temp directory cleanup failed/);
  }
  assert.match(result.stdout, /HOLDER-CLEANUP \d+ true/);
  assert.equal(existsSync(dir), false);
  console.log(output);
});
