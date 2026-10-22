import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createBoardServer } from '../src/server.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/memento/board-state.v1.json', import.meta.url)));
const body = { action: 'setStatus', id: '20261022-abcd', status: 'done', rev: 1, requestId: 'pick-1' };
const failed = { status: 500, json: { ok: false, code: 'WRITE_FAILED' } };
function request(port, { path = '/memento', method = 'POST', headers = {}, data = body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false,
      headers: { Connection: 'close', 'Sec-Fetch-Site': 'same-origin', Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'application/json', 'X-Board-Token': 'tok', ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? (typeof data === 'string' ? data : JSON.stringify(data)) : undefined);
  });
}
async function server(t, overrides = {}) {
  const errors = [];
  const board = createBoardServer({ getPage: () => '', getViewModel: () => ({ sessions: [] }),
    generation: 4, portBase: 47700, portCount: 10, token: 'tok',
    onMementoState: () => ({ status: 200, json: fixture }), onMemento: () => failed,
    onError: (key, error) => errors.push({ key, error }), ...overrides });
  const { port } = await board.start();
  t.after(() => board.close());
  return { board, port, errors };
}

test('memento state is separate from data.json and guarded by Host and fetch-site', async t => {
  let calls = 0;
  const { port } = await server(t, { onMementoState: () => { calls++; return { status: 200, json: fixture }; } });
  assert.deepEqual(JSON.parse((await request(port, { path: '/memento/state', method: 'GET' })).text), fixture);
  for (const [path, headers] of [
    ['/memento/state', { Host: 'attacker.invalid' }],
    ['/memento/state', { 'Sec-Fetch-Site': 'cross-site' }],
  ]) assert.equal((await request(port, { path, method: 'GET', headers })).status, 403);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse((await request(port, { path: '/data.json', method: 'GET' })).text), { sessions: [] });
});

for (const [name, headers, data, status] of [
  ['wrong Host', { Host: 'attacker.invalid' }, body, 403],
  ['cross-site', { 'Sec-Fetch-Site': 'cross-site' }, body, 403],
  ['wrong Origin', { Origin: 'http://attacker.invalid' }, body, 403],
  ['wrong Content-Type', { 'Content-Type': 'text/plain' }, body, 415],
  ['bad token', { 'X-Board-Token': 'bad' }, body, 403],
  ['oversize', {}, 'x'.repeat(4097), 413],
  ['unknown key', {}, { ...body, detail: 'not allowed' }, 400],
  ['missing key', {}, { action: 'setStatus' }, 400],
  ['duplicate key', {}, JSON.stringify(body).replace('"rev":1', '"rev":1,"rev":2'), 400],
]) test(`memento ${name} refuses before the API callback`, async t => {
  let calls = 0;
  const { port } = await server(t, { onMemento: () => { calls++; return failed; } });
  assert.equal((await request(port, { headers, data })).status, status);
  assert.equal(calls, 0);
});

test('memento missing state returns 501; missing write callback never registers a route', async t => {
  const { port } = await server(t, { onMementoState: undefined, onMemento: undefined });
  const res = await request(port, { path: '/memento/state', method: 'GET' });
  assert.equal(res.status, 501);
  assert.deepEqual(JSON.parse(res.text), { ok: false, code: 'MEMENTO_UNAVAILABLE' });
  assert.equal((await request(port)).status, 405);
});

test('memento and answer share the same write slot until callback settlement', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { port } = await server(t, { onAnswer: () => ({ status: 200, json: { ok: true } }),
    onMemento: async () => { entered.resolve(); await release.promise; return failed; } });
  const pending = request(port);
  pending.then(res => { if (res.status !== 500) entered.reject(new Error('write callback did not run: HTTP ' + res.status)); });
  t.after(() => release.resolve());
  await entered.promise;
  assert.equal((await request(port, { path: '/answer', data: { id: 1, sessionId: 's', option: 'A' } })).status, 429);
  assert.equal((await request(port)).status, 429);
  release.resolve();
  assert.equal((await pending).status, 500);
  assert.equal((await request(port, { path: '/answer', data: { id: 1, sessionId: 's', option: 'A' } })).status, 200);
});

test('016 WRITE_FAILED survives transport unchanged including repeated requestId', async t => {
  const received = [];
  const { port } = await server(t, { onMemento: b => { received.push(b); return failed; } });
  for (let i = 0; i < 2; i++) {
    const res = await request(port);
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.text), failed.json);
  }
  assert.deepEqual(received, [body, body]);
});

for (const reply of [
  { status: 200, json: { ok: true, rev: 2, discord: 'pending' } },
  { status: 409, json: { ok: false, code: 'STALE', rev: 2 } },
  { status: 409, json: { ok: false, code: 'BUSY' } },
  { status: 400, json: { ok: false, code: 'BAD_STATUS' } },
  { status: 501, json: { ok: false, code: 'API_VERSION_UNSUPPORTED' } },
]) test(`memento preserves strict ${reply.status} ${reply.json.code || 'success'} reply`, async t => {
  const { port } = await server(t, { onMemento: () => reply });
  const res = await request(port);
  assert.equal(res.status, reply.status);
  assert.deepEqual(JSON.parse(res.text), reply.json);
});

for (const reply of [
  { status: 500, json: { ok: false, code: 'WRITE_FAILED', detail: 'private path' } },
  { status: 200, json: { ok: true, code: 'WRITE_FAILED' } },
  { status: 409, json: { ok: false, code: 'WRITE_FAILED' } },
  { status: 500, json: { ok: true, code: 'WRITE_FAILED' } },
  { status: 500, json: { ok: false, code: 'UNKNOWN' } },
]) test(`memento rejects invalid reply ${JSON.stringify(reply)}`, async t => {
  const { port } = await server(t, { onMemento: () => reply });
  const res = await request(port);
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.text), { ok: false, code: 'INTERNAL' });
  assert.ok(!res.text.includes('private path'));
});
