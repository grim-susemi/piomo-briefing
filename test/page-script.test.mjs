import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pageHtml } from '../src/render.mjs';
import { CLASSIC_SCRIPTS, readClassicScript } from '../src/page-script.mjs';

const dir = fileURLToPath(new URL('../src/page/', import.meta.url));
for (const name of CLASSIC_SCRIPTS) {
  test('page includes verified compressed ' + name + ' without requiring a compiler', () => {
    const payload = readClassicScript(dir, name);
    const html = pageHtml({ sessions: [], waiting: [] }, 4);
    assert.ok(html.includes(payload.replace(/<(\/?script|!--)/gi, '\\x3C$1')));
    assert.ok(Buffer.byteLength(payload) < fs.statSync(join(dir, name)).size);
  });
  for (const corrupt of ['source', 'payload']) {
    test('page refuses ' + corrupt + ' drift for ' + name, () => {
      const target = join(dir, corrupt === 'source' ? name : 'generated/' + name.replace(/\.js$/, '.min.js'));
      const seam = { ...fs, readFileSync(path, ...args) {
        const text = fs.readFileSync(path, ...args);
        return path === target ? text + ' ' : text;
      } };
      assert.throws(() => pageHtml({ sessions: [], waiting: [] }, 4, { fs: seam }), /classic script: (stale source|corrupt payload)/);
    });
  }
}
