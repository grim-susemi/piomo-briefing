# Development

The user guide is in [README.ko.md](README.ko.md).

Node 24 or newer runs the normal build and page renderer:

```sh
npm run build
```

The profiles view remains a synchronous classic inline script, in its
existing position after `shell.js` and before `alarm.js`. Its readable
source is `src/page/profiles-view.js`; the committed representation is
`src/page/generated/profiles-view.min.js`. Do not import that artifact as
an ES module.

`src/profiles-script.mjs` reads both files through the renderer's existing
filesystem seam and verifies recipe, source SHA256 and payload SHA256.
It canonicalizes CRLF to LF only, without trimming. Rendering and building
reject missing, stale, corrupt or wrong-recipe artifacts; neither invokes
a compiler, downloads data, decompresses code, regenerates silently or
falls back to the readable source. The build validates the staged pair
before replacing old `dist`.

Regeneration alone requires the installed **Bun 1.4.0**, with no dependency
installation:

```sh
bun scripts/minify-profiles.mjs
bun scripts/minify-profiles.mjs --check
```

`--check` recomputes and compares canonical LF bytes without writing. Paths are anchored
to the script, not the caller's working directory. The fixed recipe uses
browser/IIFE output, whitespace minification only, disabled environment
substitution, no splitting, and an empty normal-function source wrapper.
After emission it checks the reviewed scaffold, prepends a strict
directive and replaces the unique final `.call(globalThis)` with
`.call(this)`. The late correction preserves classic top-level `this`,
including absent, undefined, lexical or getter-backed `globalThis`,
without adding another global binding read.

The recipe is pinned to the reviewed source and corrected payload hashes.
A readable-source or compiler-output change requires renewed semantic
review and a new recipe, not removal of the guards. The complete source
comparison retained scope/declaration order and all control flow, with
35 equivalent property-shorthand conversions and three local alpha-renames
(`section`, `options`, `opt`). The argument assumes ordinary JavaScript
intrinsics and classic evaluation; it does not promise source reflection
or stack-location equality, or general compiler soundness.

The generated-artifact regressions run on Node without Bun:

```sh
node --test --test-isolation=none test/profiles-generated.test.mjs test/build.test.mjs
```
