import test from 'node:test';
import assert from 'node:assert/strict';
import { createBriefingExtension } from '../extension.mjs';
import { REPORT_BLOCK_SCHEMA, DECISION_FIELDS_SCHEMA } from '../src/schema.mjs';
import { makeFakePi, makeCtx } from './helpers/fake-pi.mjs';
import { tempDir } from './helpers/temp.mjs';

async function description(t) {
  const { dir, onDispose } = tempDir(t, 'omo-help-');
  const host = makeFakePi({ sessionKind: 'interactive' });
  const { ctx } = makeCtx({ sid: 'description', hasUI: true, file: 'C:/sessions/description.jsonl' });
  createBriefingExtension({ stateDir: dir, env: {}, renderOpts: { sleep: () => {} } })(host.pi);
  onDispose(() => host.emit('session_shutdown', {}, ctx));
  await host.emit('session_start', {}, ctx);
  return host.tool('brief').description;
}

function checkContracts(text) {
  for (const [path, schema] of [
    ['brief.reports[].blocks', REPORT_BLOCK_SCHEMA],
    ['decisions[].fields', DECISION_FIELDS_SCHEMA],
  ]) {
    const line = text.split('\n').find(l => l.startsWith(`${path}: `));
    assert.ok(line, `${path}: schema contract is listed`);
    assert.deepEqual(JSON.parse(line.slice(path.length + 2)), schema, `${path}: every limit and kind matches the live schema`);
  }
}

test('brief description lists every schema-derived block and typed-field limit and kind', async t => {
  checkContracts(await description(t));
});

test('negative: changed numeric limits and kind names cannot pass the description contract', async t => {
  const text = await description(t);
  checkContracts(text);
  for (const [path, schema] of [
    ['brief.reports[].blocks', REPORT_BLOCK_SCHEMA],
    ['decisions[].fields', DECISION_FIELDS_SCHEMA],
  ]) {
    const mutations = [];
    function visit(value, keys = []) {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'number' || key === 'const') mutations.push([...keys, key]);
        else if (item && typeof item === 'object') visit(item, [...keys, key]);
      }
    }
    visit(schema);
    for (const keys of mutations) {
      const changed = structuredClone(schema);
      const parent = keys.slice(0, -1).reduce((v, key) => v[key], changed);
      const key = keys.at(-1);
      parent[key] = typeof parent[key] === 'number' ? parent[key] + 1 : 'unknown-kind';
      const mutated = text.replace(`${path}: ${JSON.stringify(schema)}`, `${path}: ${JSON.stringify(changed)}`);
      assert.throws(() => checkContracts(mutated), { code: 'ERR_ASSERTION' }, `${path}.${keys.join('.')}`);
    }
    assert.ok(mutations.length > 0);
    t.diagnostic(JSON.stringify({ path, limitsAndKinds: mutations.length, rejectedMutations: mutations.length }));
  }
});
