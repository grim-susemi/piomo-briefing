// Generator guards: the plugin must be named, and its version file must sit beside plugin/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir } from './helpers/temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'scripts', 'extract-inventory.mjs');

function envWithoutPlugin() {
  const env = { ...process.env };
  delete env.OMO_STABLE_PLUGIN;
  return env;
}

test('extract-inventory: no --plugin and no OMO_STABLE_PLUGIN exits 2 with a message', () => {
  const child = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: envWithoutPlugin() });
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stderr, /OMO_STABLE_PLUGIN/);
});

test('extract-inventory: a plugin whose ../package.json is missing exits 2 naming that file', (t) => {
  const { dir } = tempDir(t, 'extract-inv-');
  const plugin = join(dir, 'package', 'plugin');
  mkdirSync(join(plugin, 'extensions'), { recursive: true });
  writeFileSync(join(plugin, 'extensions', 'omo.js'), 'omo');
  writeFileSync(join(plugin, 'extensions', 'omo-task.js'), 'omo-task');
  const child = spawnSync(process.execPath, [SCRIPT, '--plugin', plugin], { encoding: 'utf8', env: envWithoutPlugin() });
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stderr, /package\.json/);
});
