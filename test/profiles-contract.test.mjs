// The board vendors the frozen shared contract byte-for-byte. This test is the pin:
// every file equals EXT/contract/<name>, and the aggregate digest (name NUL bytes
// NUL, CONTRACT.sha256 excluded) equals the value recorded in both manifests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BWT_CONTRACT = path.join(here, '..', 'src', 'profiles', 'contract');
const EXT_CONTRACT = 'C:/Users/USER/orca/projects/piomo-primary-agents/contract';
const MANIFEST = 'CONTRACT.sha256';

function contractFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name !== MANIFEST && statSync(path.join(dir, name)).isFile())
    .sort();
}

function aggregate(dir) {
  const hash = createHash('sha256');
  for (const name of contractFiles(dir)) {
    hash.update(name, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(path.join(dir, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function manifestAggregate(dir) {
  const text = readFileSync(path.join(dir, MANIFEST), 'utf8');
  const match = text.match(/^contract-sha256 ([0-9a-f]{64})$/m);
  assert.ok(match, `${dir}/${MANIFEST} has no contract-sha256 line`);
  return match[1];
}

test('vendored contract files are byte-identical to the extension contract', () => {
  const bwtFiles = contractFiles(BWT_CONTRACT);
  const extFiles = contractFiles(EXT_CONTRACT);
  assert.deepEqual(bwtFiles, extFiles);
  for (const name of extFiles) {
    assert.deepEqual(
      readFileSync(path.join(BWT_CONTRACT, name)),
      readFileSync(path.join(EXT_CONTRACT, name)),
      `${name} differs from the frozen contract`,
    );
  }
});

test('vendored contract aggregate equals the EXT manifest', () => {
  const expected = manifestAggregate(EXT_CONTRACT);
  assert.equal(manifestAggregate(BWT_CONTRACT), expected);
  assert.equal(aggregate(BWT_CONTRACT), expected);
});
