import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const CLASSIC_SCRIPTS = ['page.js', 'view.js'];
export const CLASSIC_RECIPE = 'bun-1.4.0-classic-v1';
export const canonical = text => text.replace(/\r\n/g, '\n');
export const scriptHash = text => createHash('sha256').update(canonical(text)).digest('hex');
export function classicArtifact(source, payload) {
  return `/* classic-script recipe=${CLASSIC_RECIPE} source=${scriptHash(source)} payload=${scriptHash(payload)} */\n${canonical(payload)}`;
}
export function readClassicScript(dir, name, fs = nodeFs) {
  const source = fs.readFileSync(join(dir, name), 'utf8');
  const artifact = canonical(fs.readFileSync(join(dir, 'generated', name.replace(/\.js$/, '.min.js')), 'utf8'));
  const header = /^\/\* classic-script recipe=(\S+) source=([a-f0-9]{64}) payload=([a-f0-9]{64}) \*\/\n/.exec(artifact);
  if (!header || header[1] !== CLASSIC_RECIPE) throw new Error('classic script: invalid recipe ' + name);
  if (header[2] !== scriptHash(source)) throw new Error('classic script: stale source ' + name);
  const payload = artifact.slice(header[0].length);
  if (header[3] !== scriptHash(payload)) throw new Error('classic script: corrupt payload ' + name);
  return payload;
}
