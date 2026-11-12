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
// Primary summaries share main draft values; guide drafts and native focus follow profile/tab scope.
// Full-A (2026-11-09): markup/class-only change (webDeepseek head row + fold); no new top-level bindings, this, eval or strictness-sensitive syntax.
// 2026-11-10: preserve original missing role/main attributes and alias JIT titles; classic scope and strictness-sensitive syntax unchanged.
// 2026-11-10 (todo8): move routeRow backup summary into sibling pf-row-sum-b span; markup-only change, classic semantics unchanged.
// 2026-11-10 (todo9): export pure guideRowModel/guideRowHtml on BriefProfiles and add controller guideFilter/guideOpen state; no top-level bindings, eval or strictness-sensitive syntax.
// 2026-11-10 (todo9 attempt2): restore explicit none empty-value semantics via guideCode/guideDash; classic semantics unchanged.
// 2026-11-10 (todo15): add inline card text editor and standalone setProfileCard lifecycle inside BriefProfiles IIFE; no new top-level bindings, eval or strictness-sensitive syntax.
// 2026-11-11 (todo15 recovery): preserve the inline draft while the existing guide opens; classic semantics unchanged.
// 2026-11-11 (todo15 correction2): remove Alt+Tab interception and disable busy edit triggers; classic scope unchanged.
// 2026-11-11 (todo15 round3): only the rendered edited card's Apply loses primary styling; handlers and classic scope unchanged.
// 2026-11-11 (todo15 round4): add selected-card chevron span inside profileCards; markup-only change, classic scope and strictness-sensitive syntax unchanged.
// 2026-11-12 (G5/1502): optional save-start notification and local DOM ACK inside the IIFE; classic this/strictness unchanged.
// 2026-11-13 (G5/1508): ACK disables every busy-gated control and a refused save refocuses its button; IIFE-local var and closure only, classic this/strictness unchanged.
// 2026-11-13 (task16): new-profile form, controller newProfile state and standalone addProfile send inside the IIFE; no new top-level bindings, classic this/strictness unchanged.
const REVIEWED_SOURCE = '8a7555bddcbd6819febf95c2eec1b0b484226384f195a00b5be605a18ec652b4';
const REVIEWED_PAYLOAD = '4dc32c950596f5b4ae6c70af3628c035161e300b2b83856f4960ca63209fb127';

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
    minify: { whitespace: true, identifiers: true, syntax: false },
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
  if (!/^\(\(\)=>\{\(function\(\)\{\(function\([A-Za-z_$][\w$]*\)\{/.test(emitted) ||
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
