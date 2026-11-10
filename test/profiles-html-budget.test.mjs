// Rendered HTML size budget contract.
// Protects the no-growth requirement (plan line 292):
// actual live-scale HTML bytes must be <= frozen value-contract baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeLiveScaleHome, loadProfilesView, renderValueContract } from './helpers/profiles-live-scale.mjs';

const fixture = new URL('./fixtures/profiles/live-scale/', import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL(name, fixture), 'utf8'));

test('live-scale rendered HTML stays within the frozen pre-readability byte caps', t => {
  const baseline = read('value-contract.json');
  const fx = makeLiveScaleHome(t);
  const actual = renderValueContract(loadProfilesView(), fx.store.state());

  assert.equal(actual.length, baseline.surfaces.length, 'surface count parity');

  for (const surface of actual) {
    const base = baseline.surfaces.find(item => item.name === surface.name);
    assert.ok(base, `surface ${surface.name} must exist in frozen baseline`);

    t.test(`${surface.name} HTML size stays within frozen baseline budget`, () => {
      assert.ok(
        surface.htmlBytes <= base.htmlBytes,
        `${surface.name} HTML bytes ${surface.htmlBytes} exceeded frozen cap ${base.htmlBytes} (${surface.htmlBytes - base.htmlBytes} bytes over)`
      );
    });
  }
});
