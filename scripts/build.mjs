#!/usr/bin/env node
// Build: copy sources (with assets/: the page's vendored icons and their licence) to .dist-stage-<pid>, node --check
// every .mjs/.js, then replace dist/ atomically. On failure keep existing dist, remove stage, exit 1.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const STAGE = join(REPO, '.dist-stage-' + process.pid);
const DIST = join(REPO, 'dist');

function listJs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listJs(p, out);
    else if (e.isFile() && (/\.m?js$/.test(e.name))) out.push(p);
  }
  return out;
}

try {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  const sources = ['extension.mjs', 'src', 'assets', join('scripts', 'install.mjs')];
  for (const rel of sources) {
    const src = join(REPO, rel);
    if (!existsSync(src)) throw new Error('missing source: ' + rel);
    const dst = join(STAGE, rel);
    if (statSync(src).isDirectory()) cpSync(src, dst, { recursive: true });
    else { mkdirSync(dirname(dst), { recursive: true }); cpSync(src, dst); }
  }
  for (const f of listJs(STAGE)) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('syntax check failed: ' + f + '\n' + (r.stderr || r.stdout));
  }
  const tmpDist = join(REPO, '.dist-new-' + process.pid);
  rmSync(tmpDist, { recursive: true, force: true });
  cpSync(STAGE, tmpDist, { recursive: true });
  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
  renameSync(tmpDist, DIST);
  rmSync(STAGE, { recursive: true, force: true });
  console.log('build ok -> dist/');
} catch (err) {
  try { rmSync(STAGE, { recursive: true, force: true }); } catch {}
  try { rmSync(join(REPO, '.dist-new-' + process.pid), { recursive: true, force: true }); } catch {}
  console.error('build failed: ' + (err && err.message ? err.message : err));
  process.exit(1);
}
