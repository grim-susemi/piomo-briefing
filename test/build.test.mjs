import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

function snapshotDist(distDir) {
  const out = new Map();
  if (!existsSync(distDir)) return out;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p.slice(distDir.length), readFileSync(p));
    }
  };
  walk(distDir);
  return out;
}
function distEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || !v.equals(w)) return false;
  }
  return true;
}

test('broken .mjs in a temp copy -> build exit 1 and existing dist bytes unchanged', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'briefing-build-'));
  try {
    const copy = join(tmp, 'repo');
    cpSync(REPO, copy, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes('.git\\') && !src.includes('.git/'),
    });
    // Clean build on the copy first to establish a good dist.
    let r = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: copy, encoding: 'utf8' });
    assert.equal(r.status, 0, 'setup build must succeed: ' + r.stderr + r.stdout);
    const distDir = join(copy, 'dist');
    assert.ok(existsSync(join(distDir, 'extension.mjs')), 'dist/extension.mjs must exist after setup build');
    const before = snapshotDist(distDir);
    assert.ok(before.size > 0, 'dist must be non-empty');
    // Inject a broken module into the copy only.
    writeFileSync(join(copy, 'src', 'schema.mjs'), 'export const x = {{{broken;;;');
    r = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: copy, encoding: 'utf8' });
    assert.equal(r.status, 1, 'broken build must exit 1, got ' + r.status + ': ' + r.stdout + r.stderr);
    const after = snapshotDist(distDir);
    assert.ok(distEqual(before, after), 'existing dist bytes must be unchanged after failed build');
    assert.ok(!existsSync(join(copy, '.dist-stage-fail-marker')), 'no stray marker');
    // No leftover stage dirs in the copy.
    const leftovers = readdirSync(copy).filter((n) => n.startsWith('.dist-stage-'));
    assert.deepEqual(leftovers, [], 'failed build must remove its stage dir, found: ' + leftovers);
    // REPO itself untouched by the broken injection.
    const repoSchema = readFileSync(join(REPO, 'src', 'schema.mjs'), 'utf8');
    assert.ok(!repoSchema.includes('broken'), 'REPO src must not contain the injected broken code');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
