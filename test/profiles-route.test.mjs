// The /profiles/state GET and the guarded POST /profiles route, exercised through
// the real HTTP server. Every fixture lives under a temporary home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createBoardServer } from '../src/server.mjs';
import { formatJsonText, openProfilesStore } from '../src/profiles/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'fixtures', 'profiles', 'goldens', 'apply-gpt-kimi-deepseek', 'files');
const REAL_INVENTORY = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'profiles', 'inventory.json'), 'utf8'));
const STYLE = { bom: false, eol: '\n', indent: '  ', keySep: ': ', trailingNewline: true };
const PLUGIN_BODY = 'route-plugin-body';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

let baseCounter = 0;
const nextBase = () => 49440 + ((process.pid % 25) * 16) + ((baseCounter++) % 2) * 8;

function makeStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-p10-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary');
  const stable = path.join(root, 'stable');
  fs.mkdirSync(path.join(primary, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(stable, 'agent'), { recursive: true });
  const omo = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'primary', 'omo.jsonc.json'), 'utf8'));
  const settings = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'primary', 'settings.json.json'), 'utf8'));
  const stableOmo = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'stable', 'omo.jsonc.json'), 'utf8'));
  fs.writeFileSync(path.join(primary, 'omo.jsonc'), formatJsonText(omo, STYLE));
  fs.writeFileSync(path.join(primary, 'agent', 'settings.json'), formatJsonText(settings, STYLE));
  fs.writeFileSync(path.join(primary, 'native-profile-selection.json'), JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' }));
  fs.writeFileSync(path.join(primary, 'agent', 'native-profile-selection.json'), JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' }));
  fs.writeFileSync(path.join(stable, 'omo.jsonc'), formatJsonText(stableOmo, STYLE));
  fs.writeFileSync(path.join(stable, 'agent', 'settings.json'), '{"packages":["stable"]}');
  const regPrimary = path.join(here, 'fixtures', 'profiles', 'registry', 'primary', 'agent', 'models.json');
  const regStable = path.join(here, 'fixtures', 'profiles', 'registry', 'stable', 'agent', 'models.json');
  if (fs.existsSync(regPrimary)) fs.copyFileSync(regPrimary, path.join(primary, 'agent', 'models.json'));
  if (fs.existsSync(regStable)) fs.copyFileSync(regStable, path.join(stable, 'agent', 'models.json'));
  const plugin = path.join(root, 'omo.js');
  fs.writeFileSync(plugin, PLUGIN_BODY);
  const fakeRegistry = {
    models: [
      { provider: 'antigravity-ocx', modelId: 'antigravity-ocx/google-antigravity/gemini-4-argon', reasoning: true, levels: ['low', 'medium', 'high'] },
      { provider: 'openai', modelId: 'openai/gpt-6-sol', reasoning: true, levels: ['off', 'low', 'medium', 'high'] },
    ],
    errors: [],
  };
  const store = openProfilesStore({
    primaryHome: primary,
    stableHome: stable,
    mirrorHomes: [],
    pluginPath: plugin,
    registries: { primary: fakeRegistry, stable: fakeRegistry },
    inventory: { ...REAL_INVENTORY, sources: { ...REAL_INVENTORY.sources, omo: { ...REAL_INVENTORY.sources.omo, sha256: sha(Buffer.from(PLUGIN_BODY)) } } },
    now: () => Date.parse('2026-10-20T12:00:00Z'),
  });
  return { root, primary, stable, store };
}

function request({ port, path: pathname = '/', method = 'GET', headers = {}, host = '127.0.0.1', body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port, path: pathname, method, agent: false,
      headers: { Connection: 'close', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(t, over = {}) {
  const fx = makeStore(t);
  const server = createBoardServer({
    getPage: () => '<!doctype html>',
    getViewModel: () => ({ seq: 1 }),
    generation: 1,
    portBase: nextBase(),
    token: 'route-token',
    onProfiles: (body) => fx.store.handle(body),
    profilesState: () => fx.store.state(),
    ...over,
  });
  const { port } = await server.start();
  t.after(async () => { await server.close(); });
  return { ...fx, server, port };
}

const JSON_HEADERS = (port) => ({
  'content-type': 'application/json',
  origin: `http://127.0.0.1:${port}`,
  'sec-fetch-site': 'same-origin',
  'x-board-token': 'route-token',
});

function applyBody(store) {
  const expected = store.state().targets;
  return JSON.stringify({
    action: 'apply',
    changes: [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }],
    expected,
    rosterRevision: store.state().roster.revision,
  });
}

test('POST /profiles without X-Board-Token is refused with 403', async (t) => {
  const { port } = await withServer(t);
  const res = await request({
    port, path: '/profiles', method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
    body: '{"action":"preview","changes":[],"expected":{},"rosterRevision":0}',
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).code, 'FORBIDDEN_TOKEN');
});

test('POST /profiles with a wrong Origin is refused with 403', async (t) => {
  const { port } = await withServer(t);
  const headers = JSON_HEADERS(port);
  headers.origin = 'http://evil.example';
  const res = await request({ port, path: '/profiles', method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).code, 'FORBIDDEN_ORIGIN');
});

test('POST /profiles from a cross-site context is refused with 403', async (t) => {
  const { port } = await withServer(t);
  const headers = JSON_HEADERS(port);
  headers['sec-fetch-site'] = 'cross-site';
  const res = await request({ port, path: '/profiles', method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).code, 'FORBIDDEN_SITE');
});

test('POST /profiles with an oversized body is refused with 413', async (t) => {
  const { port } = await withServer(t);
  const body = JSON.stringify({ action: 'preview', changes: [], expected: {}, rosterRevision: 0, pad: 'x'.repeat(70000) });
  const res = await request({ port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port), body });
  assert.equal(res.status, 413);
  assert.equal(JSON.parse(res.body).code, 'TOO_LARGE');
});

test('POST /profiles with an extra key is a 400', async (t) => {
  const { port } = await withServer(t);
  const res = await request({
    port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port),
    body: '{"action":"preview","changes":[],"expected":{},"rosterRevision":0,"extra":1}',
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).code, 'BAD_REQUEST');
});

test('POST /profiles with a duplicate key is a 400', async (t) => {
  const { port } = await withServer(t);
  const res = await request({
    port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port),
    body: '{"action":"preview","action":"apply","changes":[],"expected":{},"rosterRevision":0}',
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).code, 'DUPLICATE_KEY');
});

test('POST /profiles while another write is in flight answers 429', async (t) => {
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { port, store } = await withServer(t, {
    onProfiles: async (body) => {
      calls += 1;
      entered();
      await gate;
      return { status: 200, json: { ok: true, action: body.action, code: 'SLOW_OK' } };
    },
  });
  const first = request({ port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port), body: applyBody(store) });
  await enteredPromise;
  const second = await request({ port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port), body: applyBody(store) });
  assert.equal(second.status, 429);
  assert.equal(JSON.parse(second.body).code, 'BUSY');
  release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(calls, 1);
});

test('preview through the route writes nothing', async (t) => {
  const { port, store, primary } = await withServer(t);
  const beforeOmo = fs.readFileSync(path.join(primary, 'omo.jsonc'));
  const beforeSettings = fs.readFileSync(path.join(primary, 'agent', 'settings.json'));
  const body = JSON.stringify({
    action: 'preview',
    changes: [{ kind: 'selectProfile', profileKey: 'gpt-deepseek' }],
    expected: store.state().targets,
    rosterRevision: 0,
  });
  const res = await request({ port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port), body });
  assert.equal(res.status, 200, res.body);
  const json = JSON.parse(res.body);
  assert.equal(json.ok, true);
  assert.equal(json.action, 'preview');
  assert.ok(json.diffs.length > 0);
  assert.deepEqual(fs.readFileSync(path.join(primary, 'omo.jsonc')), beforeOmo);
  assert.deepEqual(fs.readFileSync(path.join(primary, 'agent', 'settings.json')), beforeSettings);
  assert.equal(store.journal(), null);
});

test('apply through the route returns ok, backups and hashes', async (t) => {
  const { port, store, primary } = await withServer(t);
  const res = await request({ port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port), body: applyBody(store) });
  assert.equal(res.status, 200, res.body);
  const json = JSON.parse(res.body);
  assert.equal(json.ok, true);
  assert.equal(json.action, 'apply');
  assert.ok(json.backups.length > 0);
  assert.ok(json.backups.every((file) => fs.existsSync(file)));
  const settings = JSON.parse(fs.readFileSync(path.join(primary, 'agent', 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'openai');
  assert.equal(settings.defaultModel, 'gpt-6-sol');
  assert.equal(json.hashes['agent/settings.json'], sha(fs.readFileSync(path.join(primary, 'agent', 'settings.json'))));
});

test('a Reflection memory-row apply through the route leaves Kibitzer unchanged', async (t) => {
  const { port, store, primary } = await withServer(t);
  const omoPath = path.join(primary, 'omo.jsonc');
  const read = () => JSON.parse(fs.readFileSync(omoPath, 'utf8').replace(/^\uFEFF/, ''));
  const before = read();
  const kibRecall = JSON.parse(JSON.stringify(before['[native]'].memory?.recall ?? null));
  const kibCategory = JSON.parse(JSON.stringify(before['[native]'].categories?.['desktop-kibitzer'] ?? null));
  const current = store.state();
  const res = await request({
    port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port),
    body: JSON.stringify({
      action: 'apply',
      changes: [{ kind: 'setMemoryRow', row: 'reflection', mode: 'custom', model: 'openai/gpt-6-sol', reasoning: 'high' }],
      expected: current.targets,
      rosterRevision: current.roster.revision,
    }),
  });
  assert.equal(res.status, 200, res.body);
  const after = read();
  assert.equal(after['[native]'].memory.reflection.category, 'desktop-reflection');
  assert.ok(after['[native]'].categories['desktop-reflection']);
  assert.deepEqual(after['[native]'].memory.recall ?? null, kibRecall, 'the route never moves Kibitzer recall');
  assert.deepEqual(after['[native]'].categories?.['desktop-kibitzer'] ?? null, kibCategory,
    'the route never rewrites desktop-kibitzer');
});

test('reapply through the route applies the interrupted journal payload once', async (t) => {
  const { port, stable, primary } = await withServer(t);
  const journalPath = path.join(stable, 'agent', 'primary-agents', 'apply-journal.json');
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const recorded = { changes: [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', thinking: 'high' }], rosterRevision: 0 };
  fs.writeFileSync(journalPath, JSON.stringify({
    v: 1, id: 'crash-route', action: 'apply', status: 'running',
    startedAt: '2026-10-20T11:00:00.000Z', request: recorded, steps: [],
  }, null, 2));
  const stateRes = await request({ port, path: '/profiles/state' });
  assert.equal(stateRes.status, 200, stateRes.body);
  const state = JSON.parse(stateRes.body);
  assert.equal(state.applyJournal.status, 'interrupted');
  assert.equal(state.applyJournal.action, '다시 적용');
  assert.deepEqual(state.applyJournal.reapply.changes, recorded.changes);
  const res = await request({
    port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port),
    body: JSON.stringify({
      action: 'apply', changes: state.applyJournal.reapply.changes,
      expected: state.targets, rosterRevision: state.roster.revision,
    }),
  });
  assert.equal(res.status, 200, res.body);
  const settings = JSON.parse(fs.readFileSync(path.join(primary, 'agent', 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'openai');
  assert.equal(settings.defaultModel, 'gpt-6-sol');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.status, 'completed');
  assert.notEqual(journal.id, 'crash-route');
});

test('reapply is refused on a hash mismatch and leaves the journal running', async (t) => {
  const { port, stable, primary } = await withServer(t);
  const journalPath = path.join(stable, 'agent', 'primary-agents', 'apply-journal.json');
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const recorded = { changes: [{ kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' }], rosterRevision: 0 };
  fs.writeFileSync(journalPath, JSON.stringify({
    v: 1, id: 'crash-stale', action: 'apply', status: 'running',
    startedAt: '2026-10-20T11:00:00.000Z', request: recorded, steps: [],
  }, null, 2));
  const state = JSON.parse((await request({ port, path: '/profiles/state' })).body);
  const settingsPath = path.join(primary, 'agent', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.defaultModel = 'changed-behind-the-page';
  fs.writeFileSync(settingsPath, formatJsonText(settings, STYLE));
  const behind = fs.readFileSync(settingsPath);
  const res = await request({
    port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port),
    body: JSON.stringify({
      action: 'apply', changes: state.applyJournal.reapply.changes,
      expected: state.targets, rosterRevision: state.roster.revision,
    }),
  });
  assert.equal(res.status, 409, res.body);
  assert.equal(JSON.parse(res.body).code, 'STALE');
  assert.deepEqual(fs.readFileSync(settingsPath), behind, 'the refused reapply writes nothing');
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).status, 'running');
});

test('POST /profiles never resolves a request value as a path', async (t) => {
  const { port, store, root } = await withServer(t);
  const expected = { ...store.state().targets, '../../../../escape': null };
  const res = await request({
    port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port),
    body: JSON.stringify({ action: 'apply', changes: [], expected, rosterRevision: 0 }),
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).code, 'BAD_REQUEST');
  assert.equal(fs.existsSync(path.join(root, '..', 'escape')), false);

  const withPath = await request({
    port, path: '/profiles', method: 'POST', headers: JSON_HEADERS(port),
    body: JSON.stringify({
      action: 'apply',
      changes: [{ kind: 'setMain', provider: 'openai', model: 'gpt-6-sol', path: '../../escape' }],
      expected: store.state().targets,
      rosterRevision: 0,
    }),
  });
  assert.equal(withPath.status, 400);
  assert.equal(JSON.parse(withPath.body).code, 'BAD_REQUEST');
});

test('GET /profiles/state refuses a bad Host', async (t) => {
  const { port } = await withServer(t);
  const res = await request({ port, path: '/profiles/state', headers: { host: 'evil.example' } });
  assert.equal(res.status, 403);
  assert.match(res.body, /forbidden host/);
});

test('GET /profiles/state redacts credential-keyed values', async (t) => {
  const { port, primary } = await withServer(t);
  const file = path.join(primary, 'omo.jsonc');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config['[native]'].models.leaky = { model: 'openai/gpt-6-sol', apiKey: 'SECRET-VALUE' };
  fs.writeFileSync(file, formatJsonText(config, STYLE));
  const res = await request({ port, path: '/profiles/state' });
  assert.equal(res.status, 200, res.body);
  assert.ok(!res.body.includes('SECRET-VALUE'));
  const json = JSON.parse(res.body);
  assert.equal(json.catalog.leaky.apiKey, '<redacted>');
});

test('GET /profiles/state is 404 when no profiles store is wired', async (t) => {
  const { port } = await withServer(t, { profilesState: undefined });
  const res = await request({ port, path: '/profiles/state' });
  assert.equal(res.status, 404);
});

test('forged POST /profiles with opencode/gemini-4-argon for memory returns refusal and files unchanged', async (t) => {
  const { port, store, primary, stable } = await withServer(t);
  const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  const files = [
    path.join(primary, 'omo.jsonc'),
    path.join(primary, 'agent', 'settings.json'),
    path.join(primary, 'native-profile-selection.json'),
    path.join(primary, 'agent', 'native-profile-selection.json'),
    path.join(stable, 'omo.jsonc'),
    path.join(stable, 'agent', 'settings.json'),
  ];
  const beforeHashes = files.map(hash);

  const forgedBody = JSON.stringify({
    action: 'apply',
    changes: [
      {
        kind: 'setMemoryRow',
        row: 'kibitzer',
        mode: 'custom',
        model: 'opencode/gemini-4-argon',
        reasoning: 'high',
      },
    ],
    expected: store.state().targets,
    rosterRevision: store.state().roster.revision,
  });

  const res = await request({
    port,
    path: '/profiles',
    method: 'POST',
    headers: JSON_HEADERS(port),
    body: forgedBody,
  });

  assert.equal(res.status, 400, res.body);
  const json = JSON.parse(res.body);
  assert.equal(json.ok, false);
  assert.equal(json.code, 'UNSUPPORTED_MODEL');

  const afterHashes = files.map(hash);
  assert.deepEqual(afterHashes, beforeHashes, 'all fixture homes hashes must remain unchanged');
});

test('the profile controller reapply reaches the real route and completes the journal', async (t) => {
  const { port, stable, primary } = await withServer(t);
  const journalPath = path.join(stable, 'agent', 'primary-agents', 'apply-journal.json');
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const recorded = { changes: [{ kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' }], rosterRevision: 0 };
  fs.writeFileSync(journalPath, JSON.stringify({
    v: 1, id: 'crash-controller', action: 'apply', status: 'running',
    startedAt: '2026-10-20T11:00:00.000Z', request: recorded, steps: [],
  }, null, 2));

  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'src', 'page', 'profiles-view.js'), 'utf8'), ctx,
    { filename: 'profiles-view.js' });
  const fetch = async (url, opts = {}) => {
    const res = await request({
      port, path: url, method: opts.method || 'GET',
      headers: {
        ...(opts.headers || {}),
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
      },
      body: opts.body,
    });
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => JSON.parse(res.body) };
  };
  const controller = ctx.BriefProfiles.createController({ fetch, token: 'route-token' });
  await controller.load();
  assert.equal(controller.snapshot().view.applyJournal.status, 'interrupted');
  const result = await controller.reapply();
  assert.equal(result.status, '다시 적용했습니다', JSON.stringify(result));
  assert.equal(result.result.ok, true);
  assert.equal(result.result.action, 'apply');
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).status, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(primary, 'agent', 'settings.json'), 'utf8')).compaction.model,
    'openai/gpt-6-sol');
});
