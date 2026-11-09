import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const guard = new URL('./helpers/refuse-live-writes.mjs', import.meta.url).href;

test('ledger CLI source identity includes executed delivery bodies and integrity readers', async t => {
  const { dir } = tempDir(t, 'w2-ledger-');
  const ledger = join(dir, 'assertion-ledger.json');
  function stamp(changed) {
    writeFileSync(ledger, '{}');
    const args = ['--import', guard];
    if (changed) {
      const preload = `
        import fs from 'node:fs';
        import path from 'node:path';
        const target = ${JSON.stringify(join(root, changed))};
        const original = fs.readFileSync;
        fs.readFileSync = function (file, ...options) {
          const value = original.call(this, file, ...options);
          if (typeof file !== 'string' || path.resolve(file) !== target) return value;
          return typeof value === 'string' ? value + '\\n' : Buffer.concat([value, Buffer.from('\\n')]);
        };
      `;
      args.push('--import', 'data:text/javascript,' + encodeURIComponent(preload));
    }
    args.push(join(root, 'scripts/stamp-assertion-ledger.mjs'), ledger);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return JSON.parse(readFileSync(ledger, 'utf8')).sourceHash;
  }
  const baseline = stamp();
  assert.match(baseline, /^[a-f0-9]{64}$/);
  for (const changed of [
    'src/page/generated/page.min.js',
    'src/page/generated/view.min.js',
    'src/page-script.mjs',
    'src/profiles-script.mjs',
  ]) {
    await t.test(changed, () => {
      assert.notEqual(stamp(changed), baseline, 'source identity must change with executed input bytes');
    });
  }
});
