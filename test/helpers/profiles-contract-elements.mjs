import assert from 'node:assert/strict';

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const contains = (items, token) => items.some(item => same(item, token));
const hookKeys = ['id', 'data-pf', 'data-flow', 'data-row', 'data-profile'];

// Declarations describe one actual start tag, never a subtree or a value allowlist.
// Only the new edit button may repeat an old data-profile value.
export function scopedElementIndices(surface, baseline, additions) {
  const removed = new Set();
  const singletons = additions.filter(item => !Object.hasOwn(item, 'element'));
  for (const item of additions.filter(item => Object.hasOwn(item, 'element'))) {
    assert.deepEqual(Object.keys(item).sort(), ['element', 'reason', 'surface'], 'element declaration fields');
    assert.ok(typeof item.reason === 'string' && item.reason.trim(), 'element reason');
    const element = item.element;
    assert.ok(element !== null && typeof element === 'object' && !Array.isArray(element), 'element record');
    assert.deepEqual(Object.keys(element).sort(), ['anchor', 'hooks', 'tag'], 'element fields');
    assert.equal(element.tag, 'button', 'only new edit buttons are in scope');
    assert.ok(element.anchor !== null && typeof element.anchor === 'object' && !Array.isArray(element.anchor), 'anchor record');
    assert.deepEqual(Object.keys(element.anchor).sort(), ['data-pf', 'data-profile'], 'exact edit anchor');
    assert.equal(element.anchor['data-pf'], 'edit-profile-card', 'new edit anchor');
    assert.equal(typeof element.anchor['data-profile'], 'string', 'profile anchor value');
    const anchors = [{ 'data-pf': element.anchor['data-pf'] }, { 'data-profile': element.anchor['data-profile'] }];
    assert.ok(!contains(baseline.items, anchors[0]), 'anchor must be genuinely new');
    assert.ok(contains(baseline.items, anchors[1]), 'edit button binds an existing profile');
    assert.ok(Array.isArray(element.hooks) && element.hooks.length > 0, 'complete hook vector');
    const declaredKeys = new Set();
    for (const hook of element.hooks) {
      assert.ok(hook !== null && typeof hook === 'object' && !Array.isArray(hook), 'hook record');
      assert.equal(Object.keys(hook).length, 1, 'singleton hook');
      const [[key, value]] = Object.entries(hook);
      assert.ok(hookKeys.includes(key) && typeof value === 'string', 'tracked hook only');
      assert.ok(!declaredKeys.has(key), 'duplicate hook declaration');
      declaredKeys.add(key);
      if (key === 'data-profile') {
        assert.equal(value, element.anchor['data-profile'], 'profile hook binds anchor');
      } else {
        assert.ok(!contains(baseline.items, hook), 'old hook cannot be exempted');
      }
      assert.ok(!singletons.some(singleton => same(singleton.value, hook)), 'singleton overlaps element scope');
    }
    assert.ok(anchors.every(anchor => contains(element.hooks, anchor)), 'anchor hooks required');
    assert.ok(Array.isArray(surface.elements), 'collector element metadata required');
    const matches = surface.elements.filter(candidate => anchors.every(anchor => contains(candidate.hooks, anchor)));
    assert.equal(matches.length, 1, 'element anchor must match exactly one tag');
    const [candidate] = matches;
    assert.equal(candidate.tag, element.tag, 'element tag');
    assert.equal(candidate.duplicateHooks, false, 'duplicate actual hook');
    assert.deepEqual(candidate.hooks, element.hooks, 'exact complete tracked-hook vector');
    assert.equal(candidate.indices.length, element.hooks.length, 'hook index count');
    for (const hook of element.hooks.filter(hook => Object.hasOwn(hook, 'id'))) {
      assert.equal(surface.items.filter(token => same(token, hook)).length, 1, 'new ID must be unique');
    }
    for (const [offset, index] of candidate.indices.entries()) {
      assert.ok(Number.isInteger(index) && index >= 0 && index < surface.items.length, 'hook index in surface');
      assert.ok(!removed.has(index), 'overlapping element declarations');
      assert.deepEqual(surface.items[index], element.hooks[offset], 'hook index binding');
      removed.add(index);
    }
  }
  return removed;
}
