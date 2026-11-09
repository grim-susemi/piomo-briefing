// Regeneration only; installed Node loads committed, integrity-checked artifacts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CLASSIC_SCRIPTS, canonical, classicArtifact } from '../src/page-script.mjs';

if (Bun.version !== '1.4.0') throw new Error('requires Bun 1.4.0');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('usage: bun scripts/minify-page.mjs [--check]');
const dir = fileURLToPath(new URL('../src/page/', import.meta.url));
mkdirSync(join(dir, 'generated'), { recursive: true });
for (const name of CLASSIC_SCRIPTS) {
  const source = canonical(readFileSync(join(dir, name), 'utf8'));
  const built = await Bun.build({
    entrypoints: [join(dir, name)], target: 'browser', format: 'iife',
    minify: { whitespace: true, identifiers: true, syntax: false },
    env: 'disable', splitting: false,
    plugins: [{ name: 'classic-source', setup(build) {
      build.onLoad({ filter: /\.js$/ }, () => ({
        contents: '(function () {\n' + source + '\n}).call(globalThis);\n', loader: 'js',
      }));
    } }],
  });
  if (!built.success || built.outputs.length !== 1) throw new Error(String(built.logs));
  const emitted = canonical(await built.outputs[0].text());
  const suffix = '.call(globalThis);})();\n';
  if (!/^\(\(\)=>\{\(function\(\)\{/.test(emitted) ||
      !emitted.endsWith(suffix) || emitted.indexOf(suffix) !== emitted.length - suffix.length) {
    throw new Error('classic scaffold changed: ' + name);
  }
  const payload = '"use strict";\n' + emitted.slice(0, -suffix.length) + '.call(this);})();\n';
  const output = join(dir, 'generated', name.replace(/\.js$/, '.min.js'));
  const artifact = classicArtifact(source, payload);
  if (args[0] === '--check') {
    if (canonical(readFileSync(output, 'utf8')) !== artifact) throw new Error('stale generated script: ' + name);
  } else {
    writeFileSync(output, artifact);
  }
  console.log(name + ': ' + Buffer.byteLength(source) + ' -> ' + Buffer.byteLength(payload));
}
