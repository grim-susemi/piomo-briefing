// Stamp provenance into an assertion-ledger.json from the live worktree.
// Usage: node scripts/stamp-assertion-ledger.mjs <path-to/assertion-ledger.json>
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function computeSourceHash() {
  const pageDir = path.join(ROOT, 'src/page');
  const files = fs.readdirSync(pageDir).filter((f) => /\.(js|css)$/.test(f)).sort()
    .map((f) => 'src/page/' + f)
    .concat(['src/page/generated/page.min.js', 'src/page/generated/view.min.js', 'src/page/generated/profiles-view.min.js', 'src/page-script.mjs', 'src/profiles-script.mjs', 'src/render.mjs', 'src/server.mjs', 'src/server-host.mjs']);
  const map = {};
  for (const f of files) map[f] = sha256(fs.readFileSync(path.join(ROOT, f)));
  return sha256(JSON.stringify(map));
}

function computeHead() {
  return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

const ledgerPath = process.argv[2];
if (!ledgerPath) {
  console.error('usage: node scripts/stamp-assertion-ledger.mjs <assertion-ledger.json>');
  process.exit(2);
}
const abs = path.resolve(ledgerPath);
const ledger = JSON.parse(fs.readFileSync(abs, 'utf8'));
ledger.sourceHash = computeSourceHash();
ledger.head = computeHead();
ledger.generatedAt = new Date().toISOString();
fs.writeFileSync(abs, JSON.stringify(ledger, null, 2) + '\n');
console.log(JSON.stringify({ sourceHash: ledger.sourceHash, head: ledger.head, generatedAt: ledger.generatedAt }, null, 2));
