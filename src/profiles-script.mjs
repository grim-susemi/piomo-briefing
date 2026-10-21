// Shared Node-only integrity reader for the committed profiles classic script.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const PROFILES_RECIPE = 'bun-1.4.0-profiles-classic-v1';
export const canonicalLf = (text) => text.replace(/\r\n/g, '\n');
export const profilesSha256 = (text) => createHash('sha256').update(canonicalLf(text), 'utf8').digest('hex');
const HEADER = /^\/\* profiles-script recipe=(\S+) source-sha256=([0-9a-f]{64}) payload-sha256=([0-9a-f]{64}) \*\/\n/;

export function profilesArtifact(source, payload) {
  return `/* profiles-script recipe=${PROFILES_RECIPE} source-sha256=${profilesSha256(source)} payload-sha256=${profilesSha256(payload)} */\n` +
    canonicalLf(payload);
}

export function readProfilesScript(pageDir, fs = nodeFs) {
  const source = fs.readFileSync(join(pageDir, 'profiles-view.js'), 'utf8');
  const artifact = canonicalLf(fs.readFileSync(join(pageDir, 'generated', 'profiles-view.min.js'), 'utf8'));
  const header = HEADER.exec(artifact);
  if (!header) throw new Error('profiles script: missing or malformed provenance header');
  if (header[1] !== PROFILES_RECIPE) throw new Error('profiles script: wrong recipe');
  if (header[2] !== profilesSha256(source)) throw new Error('profiles script: stale source');
  const payload = artifact.slice(header[0].length);
  if (header[3] !== profilesSha256(payload)) throw new Error('profiles script: corrupt payload');
  return payload;
}
