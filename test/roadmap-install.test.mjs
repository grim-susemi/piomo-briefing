import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { tempDir } from './helpers/temp.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const payload = process.env.ROADMAP_OLD_PAYLOAD;
const manifestPath = process.env.ROADMAP_OLD_MANIFEST;
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
const entries = (dir, prefix = '') => readdirSync(join(dir, prefix), { withFileTypes: true })
  .flatMap((entry) => {
    const rel = join(prefix, entry.name);
    return entry.isDirectory() ? entries(dir, rel) : [rel.replaceAll('\\', '/')];
  }).sort();
const inventory = (dir) => Object.fromEntries(entries(dir).map((rel) => [rel, digest(join(dir, rel))]));
const expectedInventory = () => Object.fromEntries(
  Object.entries(json(manifestPath).sha256).map(([rel, hash]) => [rel.replaceAll('\\', '/'), hash])
    .sort(([a], [b]) => a.localeCompare(b)),
);
const verifyPayload = (dir) => assert.deepEqual(inventory(dir), expectedInventory(), 'preserved payload SHA-256 mismatch');
const install = (repo, agent) => spawnSync(process.execPath, [join(repo, 'scripts/install.mjs'), '--agent-dir', agent], {
  encoding: 'utf8', timeout: 45_000, env: process.env,
});
const current = (agent) => json(join(agent, 'briefing/current.json'));
const seq = (state) => json(join(state, 'published.json')).seq;
const readData = (state) => {
  let data;
  vm.runInNewContext(readFileSync(join(state, 'data.js'), 'utf8'), {
    window: { __briefData: (value) => { data = value; } },
  });
  return data;
};

test('official old-candidate-old installs preserve records and expose legacy data degradation', async (t) => {
  assert.ok(payload && manifestPath, 'set ROADMAP_OLD_PAYLOAD and ROADMAP_OLD_MANIFEST to the verified baseline');
  verifyPayload(payload);
  const { dir } = tempDir(t, 'roadmap-install-');
  const old = join(dir, 'old');
  const agent = join(dir, 'agent');
  mkdirSync(agent);
  cpSync(payload, join(old, 'dist'), { recursive: true });
  cpSync(join(payload, 'src'), join(old, 'src'), { recursive: true });
  cpSync(join(payload, 'scripts'), join(old, 'scripts'), { recursive: true });
  cpSync(join(payload, 'assets'), join(old, 'assets'), { recursive: true });
  const state = join(agent, 'briefing/state');
  const installOld = () => {
    verifyPayload(join(old, 'dist'));
    const result = install(old, agent);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };

  installOld();
  assert.equal(current(agent).generation, 'generation-000001');
  const fixture = {
    'settings.json': { enabled: true, fixturePref: 'preserve-me' },
    'prefs.json': { theme: 'dark', fixture: 'preserve-me' },
    'decisions/000001.json': { id: 1, question: 'fixture', status: 'open', at: 1 },
    'answers/000001.json': { decisionId: 1, answer: 'fixture', at: 2 },
    'sessions/owner/meta.json': { sessionId: 'owner', cwd: dir, title: 'fixture', lastActivityAt: 1 },
    'sessions/owner/briefs/000001.json': { at: 1, brief: { title: 'fixture', status: 'in_progress', headline: 'history', changes: [] } },
    'roadmaps/rm123456789abc/definition.json': {
      registered: true, roadmapId: 'rm123456789abc', revision: 1, projectionPath: join(dir, 'roadmap.json'),
      projection: { tracks: [{ id: 't', stageIds: ['s'] }], stages: [{ id: 's', requirementsKnown: true, requires: [], accepts: [], plans: [] }] },
    },
    'roadmaps/rm123456789abc/status.json': {
      schema: 'omo-roadmap-status/1', definitionRevision: 1, checkedAt: '2026-11-05T00:00:00.000Z',
      stages: [{ id: 's', plans: [], requires: [], accepts: [] }],
    },
  };
  for (const [rel, value] of Object.entries(fixture)) write(join(state, rel), value);
  const records = Object.fromEntries(Object.keys(fixture).map((rel) => [rel, digest(join(state, rel))]));
  const assertRecords = () => assert.deepEqual(
    Object.fromEntries(Object.keys(fixture).map((rel) => [rel, digest(join(state, rel))])), records,
  );
  const firstSeq = seq(state);
  const candidate = install(root, agent);
  assert.equal(candidate.status, 0, candidate.stdout + candidate.stderr);
  assert.equal(current(agent).generation, 'generation-000002');
  assert.deepEqual(current(agent).sha256, Object.fromEntries(
    Object.entries(inventory(join(root, 'dist'))).map(([rel, hash]) => [rel.replaceAll('/', '\\'), hash]),
  ));
  assert.ok(seq(state) > firstSeq);
  const candidateSeq = seq(state);
  const candidateHashes = current(agent).sha256;
  assert.equal(readData(state).roadmaps.length, 1);
  assertRecords();

  const pageBefore = readFileSync(join(state, 'index.html'), 'utf8');
  const beforeLegacySeq = seq(state);
  const oldGen = join(agent, 'briefing/integration/generation-000001/src');
  const { openStore } = await import(pathToFileURL(join(oldGen, 'store.mjs')));
  const { renderPage } = await import(pathToFileURL(join(oldGen, 'render.mjs')));
  const published = renderPage(openStore(state), Date.now(), { generation: 1 });
  assert.equal(published.ok, true, published.error);
  assert.equal(readFileSync(join(state, 'index.html'), 'utf8'), pageBefore);
  assert.ok(seq(state) > beforeLegacySeq);
  const legacySeq = seq(state);
  const legacy = readData(state);
  assert.equal(Object.hasOwn(legacy, 'roadmaps'), false);
  const context = {};
  vm.runInNewContext(readFileSync(join(root, 'dist/src/page/roadmap-view.js'), 'utf8'), context);
  const html = context.BriefRoadmapView.render(legacy, {});
  assert.match(html, /class="rm-banner rm-legacy" role="status"/);
  assert.doesNotMatch(html, /data-rm-stage=/);
  assertRecords();

  const beforeRecoverySeq = seq(state);
  installOld();
  assert.equal(current(agent).generation, 'generation-000003');
  assert.deepEqual(current(agent).sha256, json(manifestPath).sha256);
  assert.match(readFileSync(join(agent, 'extensions/omo-briefing.js'), 'utf8'), /generation-000003/);
  assert.ok(seq(state) > beforeRecoverySeq);
  assert.equal(Object.hasOwn(readData(state), 'roadmaps'), false);
  assertRecords();
  t.diagnostic(JSON.stringify({
    generations: ['generation-000001', 'generation-000002', 'generation-000003'],
    seqs: [firstSeq, candidateSeq, legacySeq, seq(state)],
    fixtureRevision: 1, recordSha256: records, candidateSha256: candidateHashes,
    oldGeneration: json(manifestPath).generation,
  }));
});

test('payload hash mismatch, foreign shim and live lock do not erase records', (t) => {
  assert.ok(payload && manifestPath, 'set ROADMAP_OLD_PAYLOAD and ROADMAP_OLD_MANIFEST to the verified baseline');
  const { dir } = tempDir(t, 'roadmap-install-negative-');
  const corrupt = join(dir, 'corrupt');
  cpSync(payload, corrupt, { recursive: true });
  writeFileSync(join(corrupt, 'extension.mjs'), 'corrupt');
  assert.throws(() => verifyPayload(corrupt), /preserved payload SHA-256 mismatch/);

  const agent = join(dir, 'agent');
  const state = join(agent, 'briefing/state');
  const record = join(state, 'roadmaps/rm123456789abc/definition.json');
  write(record, { registered: true, fixture: 'preserve-me' });
  const before = digest(record);
  const shim = join(agent, 'extensions/omo-briefing.js');
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(shim, '// foreign extension\n');
  const refused = install(root, agent);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /non-managed/);
  assert.equal(digest(record), before);
  writeFileSync(shim, '// managed by omo-briefing\n');
  write(join(state, 'render.lock'), { pid: process.pid, at: 'fixture', nonce: 'fixture' });
  const locked = install(root, agent);
  assert.equal(locked.status, 0, locked.stdout + locked.stderr);
  assert.match(locked.stdout, /건너뜀|skipped/);
  assert.equal(digest(record), before);
});
