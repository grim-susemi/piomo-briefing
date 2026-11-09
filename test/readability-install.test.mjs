import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp.mjs';
import { makeController } from './fixtures/controller-dom.mjs';
import { createServerHost } from '../src/server-host.mjs';
import { openStore } from '../src/store.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
function hashes(dir) {
  return Object.fromEntries(files(dir).map(p => [relative(dir, p).replaceAll('\\', '/'), hash(p)]).sort());
}
function exec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  assert.equal(r.status, 0, `${cmd}: ${r.error || ''}\n${r.stdout}\n${r.stderr}`);
  return r;
}
function install(repo, agent) {
  return exec(process.execPath, [join(repo, 'scripts/install.mjs'), '--agent-dir', agent]);
}
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
function publication(agent) {
  const state = join(agent, 'briefing/state');
  const current = readJson(join(agent, 'briefing/current.json'));
  const html = readFileSync(join(state, 'index.html'), 'utf8');
  const data = readFileSync(join(state, 'data.js'), 'utf8');
  const pub = readJson(join(state, 'published.json'));
  assert.match(readFileSync(join(agent, 'extensions/omo-briefing.js'), 'utf8'), new RegExp(current.generation));
  assert.match(html, new RegExp(`<meta name="omo-briefing-generation" content="${Number(current.generation.slice(-6))}">`));
  assert.match(data, new RegExp(`/\\* seq:${pub.seq} \\*/`));
  assert.equal(pub.dataHash, createHash('sha256').update(data).digest('hex'));
  const payload = Object.fromEntries(Object.entries(current.sha256).map(([k, v]) => [k.replaceAll('\\', '/'), v]));
  return { generation: current.generation, seq: pub.seq, payload };
}

function draftPage(generation, storage, seq) {
  const e = makeController({ generation, sessionStorage: storage, modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'annotate'] });
  e.page.receive({ seq, gen: generation, generatedAt: 0, sessions: [{
    id: 'owner', project: 'p', title: 'RECOVERY', status: 'needs_decision', tab: '나를 기다림',
    decisions: [{ id: 13, sessionId: 'owner', question: 'q', options: {}, recommend: '', answered: false, closed: false }],
  }] });
  return e;
}

test('isolated previous -> candidate -> higher previous preserves state and increasing sequence', { timeout: 120000 }, async t => {
  const { dir } = tempDir(t, 'w2-recovery-');
  const previous = join(dir, 'previous');
  const agent = join(dir, 'agent');
  mkdirSync(previous); mkdirSync(agent);
  // Freeze the accepted pre-redesign payload so committing the candidate cannot change the recovery input.
  const previousRef = '5f3a24d7cbe7dcd227ae2feb95a514efee468551';
  const archive = spawnSync('git', ['archive', previousRef], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(archive.status, 0, String(archive.stderr));
  exec('tar', ['-xf', '-', '-C', previous], { input: archive.stdout });
  exec(process.execPath, [join(previous, 'scripts/build.mjs')], { cwd: previous });
  const oldHashes = hashes(join(previous, 'dist'));
  const candidateHashes = hashes(join(root, 'dist'));
  assert.notDeepEqual(oldHashes, candidateHashes, 'previous and candidate payloads must differ');
  install(previous, agent);
  const state = join(agent, 'briefing/state');
  const initialSeq = readJson(join(state, 'published.json')).seq;
  const now = Date.now();
  writeJson(join(state, 'sessions/owner/meta.json'), { sessionId: 'owner', cwd: 'C:/fixture', title: 'RECOVERY', lastActivityAt: now });
  writeJson(join(state, 'sessions/owner/briefs/000001.json'), { at: now, brief: { title: 'RECOVERY', status: 'in_progress', headline: 'RECOVERY-HEAD', changes: [] } });
  writeJson(join(state, 'decisions/000001.json'), { id: 1, sessionId: 'owner', question: 'RECOVERY-QUESTION', options: { A: 'yes' }, recommend: 'A' });
  writeJson(join(state, 'answers/000001.json'), { id: 1, option: 'A', text: 'RECOVERY-ANSWER' });
  const preserved = ['decisions/000001.json', 'answers/000001.json', 'sessions/owner/meta.json', 'sessions/owner/briefs/000001.json'];
  const before = Object.fromEntries(preserved.map(f => [f, hash(join(state, f))]));
  const saved = new Map();
  const storage = { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)), removeItem: k => saved.delete(k) };
  const page = draftPage(1, storage, 1);
  const button = page.document.createElement('button');
  button.setAttribute('data-act', 'ans-reply');
  button.setAttribute('data-id', '13');
  page.byId.main.appendChild(button);
  page.app.listeners.click({ target: button, preventDefault() {} });
  page.app.listeners.input({ target: { value: 'RECOVERY-DRAFT', getAttribute: n => n === 'data-draft' ? '13' : null, closest: () => ({ querySelector: () => ({}) }) } });
  page.document.activeElement = null;
  const candidate = install(root, agent);
  assert.match(candidate.stdout, /board re-rendered seq/);
  const middle = publication(agent);
  page.page.receive({ seq: middle.seq + 1, gen: 2, sessions: [] });
  assert.equal(page.reloads.length, 1);
  const nextPage = draftPage(2, storage, middle.seq + 2);
  assert.equal(nextPage.page.state.ui.answers['13'].draft, 'RECOVERY-DRAFT');
  install(previous, agent);
  const after = publication(agent);
  nextPage.page.receive({ seq: after.seq + 3, gen: 3, sessions: [] });
  assert.equal(nextPage.reloads.length, 1);
  const restoredPage = draftPage(3, storage, after.seq + 4);
  assert.equal(restoredPage.page.state.ui.answers['13'].draft, 'RECOVERY-DRAFT');
  assert.equal(middle.generation, 'generation-000002');
  assert.equal(after.generation, 'generation-000003');
  assert.ok(middle.seq > initialSeq);
  assert.ok(after.seq > middle.seq);
  assert.deepEqual(middle.payload, candidateHashes);
  assert.deepEqual(after.payload, oldHashes);
  assert.deepEqual(Object.fromEntries(preserved.map(f => [f, hash(join(state, f))])), before);
  assert.ok(readFileSync(join(state, 'data.js'), 'utf8').includes('RECOVERY-HEAD'));
  const store = openStore(state);
  const host = createServerHost({
    stateDir: state, sessionId: 'owner', generation: 3,
    installedGeneration: async () => Number(readJson(join(agent, 'briefing/current.json')).generation.slice(-6)),
    isEnabled: () => true, readSnapshot: () => store.readSnapshot(),
    buildViewModel: () => ({ sessions: [] }),
    getPage: () => readFileSync(join(state, 'index.html'), 'utf8'),
    reclaimStale: (rel, rec) => store.reclaimStale(rel, rec),
    env: { OMO_BRIEFING_PORT_BASE: '49600' },
  });
  try {
    const owner = await host.ensure();
    assert.ok(owner?.url, JSON.stringify(host.status()));
    const model = await (await fetch(new URL('/data.json', owner.url))).json();
    assert.equal(model.seq, after.seq);
    const health = await (await fetch(new URL('/health', owner.url))).json();
    const serverRecord = readJson(join(state, 'server.json'));
    assert.equal(serverRecord.generation, 3);
    assert.equal(health.generation, 3);
    assert.equal(health.seq, after.seq);
    const served = await (await fetch(owner.url)).text();
    assert.match(served, /<meta name="omo-briefing-generation" content="3">/);
  } finally {
    await host.release();
  }
  console.log('W2_RECOVERY ' + JSON.stringify({
    before: { generation: 'generation-000001', seq: initialSeq },
    candidate: { generation: middle.generation, seq: middle.seq, pageCssSha256: middle.payload['src/page/page.css'] },
    recovery: { generation: after.generation, seq: after.seq, pageCssSha256: after.payload['src/page/page.css'] },
    preserved: before, draft: 'RECOVERY-DRAFT',
  }));
});

test('foreign shim is refused without changing any existing files', t => {
  const { dir } = tempDir(t, 'w2-foreign-');
  mkdirSync(join(dir, 'extensions'));
  writeFileSync(join(dir, 'extensions/omo-briefing.js'), '// foreign shim\n');
  const before = hashes(dir);
  const r = spawnSync(process.execPath, [join(root, 'scripts/install.mjs'), '--agent-dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /non-managed/);
  assert.deepEqual(hashes(dir), before);
});

test('live render lock permits install but preserves publication and lock', t => {
  const { dir } = tempDir(t, 'w2-lock-');
  install(root, dir);
  const state = join(dir, 'briefing/state');
  writeJson(join(state, 'decisions/000001.json'), { id: 1, question: 'LOCKED-QUESTION' });
  writeJson(join(state, 'answers/000001.json'), { id: 1, text: 'LOCKED-ANSWER' });
  writeJson(join(state, 'render.lock'), { pid: process.pid, at: new Date().toISOString(), nonce: 'live-owner' });
  const names = ['index.html', 'data.js', 'published.json', 'render.lock', 'decisions/000001.json', 'answers/000001.json'];
  const before = Object.fromEntries(names.map(f => [f, hash(join(state, f))]));
  const r = install(root, dir);
  assert.match(r.stdout, /건너뜀|skipped/);
  assert.equal(readJson(join(dir, 'briefing/current.json')).generation, 'generation-000002');
  assert.match(readFileSync(join(dir, 'extensions/omo-briefing.js'), 'utf8'), /generation-000002/);
  assert.deepEqual(hashes(join(dir, 'briefing/integration/generation-000002')), hashes(join(root, 'dist')));
  assert.deepEqual(Object.fromEntries(names.map(f => [f, hash(join(state, f))])), before);
});

test('installer advances past immutable generations after a stale pointer', t => {
  const { dir } = tempDir(t, 'w2-repoint-');
  install(root, dir);
  const currentPath = join(dir, 'briefing/current.json');
  const old = readFileSync(currentPath);
  install(root, dir);
  const previous = publication(dir);
  const retained = hashes(join(dir, 'briefing/integration'));
  // An external write is an input; only the next real install is the outcome.
  writeFileSync(currentPath, old);
  install(root, dir);
  const next = publication(dir);
  assert.equal(next.generation, 'generation-000003');
  assert.ok(next.seq > previous.seq);
  const after = hashes(join(dir, 'briefing/integration'));
  for (const [file, hash] of Object.entries(retained)) assert.equal(after[file], hash);
});
