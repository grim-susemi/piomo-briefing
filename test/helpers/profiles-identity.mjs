import assert from 'node:assert/strict';

// DOM and AX names share the same source contract; translated labels cannot pass
// merely because an original id happens to be present elsewhere on the page.
export function assertGuideIdentity(actual, expected, axNames) {
  assert.equal(actual.length, expected.length, 'guide exact row count');
  assert.equal(new Set(actual.map(row => row.id)).size, expected.length, 'guide has no duplicate ids');
  assert.deepEqual(actual.map(row => row.id), expected.map(row => row.id), 'guide source order');
  for (const [index, row] of actual.entries()) {
    const source = expected[index];
    assert.equal(row.name, source.name, `${row.id}: role identity`);
    assert.equal(row.role, source.role, `${row.id}: roleid identity`);
    assert.equal(row.status, source.status, `${row.id}: status identity`);
    if (axNames) {
      for (const field of ['name', 'role', 'status']) {
        assert.ok(axNames.includes(source[field]), `${row.id}: AX ${field} identity`);
      }
    }
  }
}
