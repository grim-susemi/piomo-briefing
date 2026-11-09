import '../test/helpers/refuse-live-writes.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeProvenance } from './qa-roadmap.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const [outArg, oldPayload, oldManifest] = process.argv.slice(2);
if (!outArg || !oldPayload || !oldManifest) throw new Error('expected output, old payload, old manifest');
const out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = (dir, prefix = '') => fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(dir, path.join(prefix, entry.name)) :
    [path.join(prefix, entry.name).replaceAll('\\', '/')]).sort();
const sourceFiles = ['extension.mjs', 'scripts/install.mjs', ...files(path.join(root, 'src')).map(p => 'src/' + p)];
const inventory = () => Object.fromEntries(sourceFiles.map(file => [file, hash(path.join(root, file))]));
const before = inventory();
const sourceManifest = path.join(out, 'candidate-source-hashes.json');
fs.writeFileSync(sourceManifest, JSON.stringify(before, null, 2));
const build = spawnSync('npm run build', { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
fs.writeFileSync(path.join(out, 'build.log'), (build.stdout || '') + (build.stderr || ''));
if (build.status !== 0) throw new Error('candidate build failed; see build.log');
const environment = { ROADMAP_OLD_PAYLOAD: path.resolve(oldPayload), ROADMAP_OLD_MANIFEST: path.resolve(oldManifest) };
const result = spawnSync(process.execPath, ['--import', './test/helpers/refuse-live-writes.mjs',
  '--test', '--test-reporter=spec', 'test/roadmap-install.test.mjs', 'test/install.test.mjs'],
{ cwd: root, env: { ...process.env, ...environment }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const log = (result.stdout || '') + (result.stderr || '');
fs.writeFileSync(path.join(out, 'acceptance.log'), log);
const count = key => Number(new RegExp('(?:^|\\n).*?\\b' + key + ' (\\d+)').exec(log)?.[1]);
const unchanged = JSON.stringify(before) === JSON.stringify(inventory());
const tests = count('tests'), passed = count('pass'), failed = count('fail');
const provenance = computeProvenance(path.join(root, 'test/fixtures/roadmap/full.json'));
const receipt = {
  status: result.status === 0 && tests > 0 && passed === tests && failed === 0 && unchanged ? 'pass' : 'fail',
  exitCode: result.status, tests, passed, failed, environment,
  sourceHash: provenance.sourceHash, payloadHtmlSha256: provenance.payloadHtmlSha256,
  sourceHashManifest: 'candidate-source-hashes.json', sourceHashManifestSha256: hash(sourceManifest),
  sourceFilesChangedAfterPin: unchanged ? 0 : 1, buildExitCode: build.status,
  acceptanceLogSha256: hash(path.join(out, 'acceptance.log')),
  acceptanceRuns: 1, liveInstall: false, finishedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(out, 'install.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
process.exitCode = receipt.status === 'pass' ? 0 : 1;
