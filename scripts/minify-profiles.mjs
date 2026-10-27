#!/usr/bin/env bun
// Regeneration only. Normal Node builds/renders read the committed artifact.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalLf, profilesArtifact, profilesSha256 } from '../src/profiles-script.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, 'src', 'page', 'profiles-view.js');
const OUTPUT = join(ROOT, 'src', 'page', 'generated', 'profiles-view.min.js');
// This recipe was reviewed for this source, not for arbitrary JavaScript.
const REVIEWED_SOURCE = '624b64167070f3dd886254d82daa918a6c0ae2a20bcbe9a635110b47410d4aca';
const REVIEWED_PAYLOAD = '86c881458999458037852006ef8721da61ccc2d60245b8c93cd8d30e0feb7376';

try {
  if (typeof Bun === 'undefined' || Bun.version !== '1.4.0') throw new Error('regeneration requires Bun 1.4.0');
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('usage: bun scripts/minify-profiles.mjs [--check]');
  const source = canonicalLf(readFileSync(SOURCE, 'utf8'));
  if (profilesSha256(source) !== REVIEWED_SOURCE) throw new Error('source changed: review classic semantics and version the recipe before regeneration');
  const result = await Bun.build({
    entrypoints: [SOURCE],
    target: 'browser',
    format: 'iife',
    minify: { whitespace: true, identifiers: false, syntax: false },
    env: 'disable',
    splitting: false,
    plugins: [{
      name: 'profiles-classic',
      setup(build) {
        build.onLoad({ filter: /profiles-view\.js$/ }, () => ({
          contents: '(function () {\n' + source + '\n}).call(globalThis);\n',
          loader: 'js',
        }));
      },
    }],
  });
  if (!result.success || result.outputs.length !== 1) throw new Error('profiles compilation failed: ' + result.logs.join('\n'));
  const emitted = canonicalLf(await result.outputs[0].text());
  const suffix = '.call(globalThis);})();\n';
  if (!emitted.startsWith('(()=>{(function(){(function(g){') ||
      !emitted.endsWith(suffix) || emitted.indexOf(suffix) !== emitted.length - suffix.length) {
    throw new Error('compiler scaffold changed: review classic-script correction');
  }
  // Bun treats the package input as ESM. Correct the emitted CLASSIC Script late:
  // restore inherited strictness, and capture classic top-level this without an extra globalThis read.
  const payload = '"use strict";\n' + emitted.slice(0, -suffix.length) + '.call(this);})();\n';
  if (profilesSha256(payload) !== REVIEWED_PAYLOAD) throw new Error('compiler payload differs from the reviewed recipe (observed ' + profilesSha256(payload) + ')');
  const artifact = profilesArtifact(source, payload);
  if (args[0] === '--check') {
    if (canonicalLf(readFileSync(OUTPUT, 'utf8')) !== artifact) throw new Error('generated profiles artifact differs; regenerate it');
    console.log('profiles artifact check ok (no writes)');
  } else {
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, artifact, 'utf8');
    console.log('profiles artifact generated: ' + Buffer.byteLength(payload) + ' payload bytes');
  }
} catch (err) {
  console.error('profiles generation failed: ' + (err instanceof Error ? err.message : err));
  process.exitCode = 1;
}
