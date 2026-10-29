// The pinned host plugin, read from OMO_STABLE_PLUGIN (set from the QA pins; never a literal path).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function pinnedPluginDir() {
  const dir = process.env.OMO_STABLE_PLUGIN;
  assert.ok(dir, 'set OMO_STABLE_PLUGIN to the pinned plugin');
  return dir;
}

export function pinnedOmoPath() {
  return path.join(pinnedPluginDir(), 'extensions', 'omo.js');
}

// <plugin>/../package.json names the omo-ai version of the pinned plugin.
export function pinnedPackageVersion() {
  return JSON.parse(readFileSync(path.join(pinnedPluginDir(), '..', 'package.json'), 'utf8')).version;
}
