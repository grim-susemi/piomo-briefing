// 5.1.38 refresh layer tests: inventory rows, absent read-only rows, registry-driven ChatGPT
// picker, guide hashes, roster rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ABSENT_LABEL, AGENT_IDS, DEFAULT_LANE, agentRosterRows, buildRoster, chatGptPickerModels,
  inventoryStatus, recommendationGuide, refreshRoutingRows,
} from '../src/profiles/refresh-5.1.38.mjs';
import { ROLE_INVENTORY } from '../src/profiles/model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const inventoryPath = path.join(here, '..', 'src', 'profiles', 'inventory-5.1.38.json');
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('inventory sha256 values equal the current 5.1.38 bundle files', async () => {
  for (const key of ['omo', 'omoTask']) {
    const source = inventory.sources[key];
    const bytes = await readFile(source.path);
    assert.equal(sha256(bytes), source.sha256, `${key} source hash`);
  }
  assert.equal(inventory.version, '5.1.38');
});

test('every 5.1.38 inventory id appears as a routing row', () => {
  const layer = {
    agents: { oracle: { model: 'sol' }, ouroboros: { model: 'flash-high' } },
    categories: { 'fast-explore': { model: 'flash-high' } },
  };
  const rows = refreshRoutingRows({ inventory, layer });
  const keys = new Set(rows.map((row) => `${row.section}/${row.role}`));
  for (const section of ['agents', 'categories']) {
    for (const role of inventory[section]) assert.ok(keys.has(`${section}/${role}`), `missing row ${section}/${role}`);
  }
});

test('roles absent from 5.1.38 are read-only, labelled, and keep their config', () => {
  const layer = {
    agents: { oracle: { model: 'sol' }, ouroboros: { model: 'flash-high' } },
    categories: { 'fast-explore': { model: 'kimi-max' } },
  };
  const rows = refreshRoutingRows({ inventory, layer });
  for (const [section, role] of [['agents', 'oracle'], ['agents', 'ouroboros'], ['categories', 'fast-explore']]) {
    const row = rows.find((entry) => entry.section === section && entry.role === role);
    assert.equal(row.readOnly, true, `${section}/${role} read-only`);
    assert.equal(row.absentIn, '5.1.38');
    assert.equal(row.stateLabel, ABSENT_LABEL);
    assert.deepEqual(row.config, layer[section][role]);
  }
  const live = refreshRoutingRows({ inventory }).find((row) => row.section === 'agents' && row.role === 'explore');
  assert.equal(live.readOnly, false);
  assert.equal(live.stateLabel, null);
});

test('a role new in 5.1.38 becomes a row, group extras when no purpose group fits', () => {
  const extended = {
    ...inventory,
    agents: [...inventory.agents, 'sentinel-agent'],
    categories: [...inventory.categories, 'sentinel-category'],
  };
  const rows = refreshRoutingRows({ inventory: extended });
  const agent = rows.find((row) => row.section === 'agents' && row.role === 'sentinel-agent');
  const category = rows.find((row) => row.section === 'categories' && row.role === 'sentinel-category');
  assert.equal(agent.group, 'extras');
  assert.equal(category.group, 'extras');
  assert.equal(agent.readOnly, false);
  assert.equal(category.readOnly, false);
});

test('ChatGPT picker lists every registry-served model for the provider', () => {
  const registryModels = [
    { provider: 'chatgpt-subscription', id: 'chatgpt-subscription/gpt-6.1-sol' },
    { provider: 'chatgpt-subscription', id: 'chatgpt-subscription/gpt-6-astra' },
    { provider: 'chatgpt-subscription', id: 'chatgpt-subscription/gpt-7-nova' },
    { provider: 'anthropic-subscription', id: 'anthropic-subscription/claude-opus-5-5' },
    'chatgpt-subscription/gpt-6-sol',
    { provider: 'chatgpt-subscription', id: 'chatgpt-subscription/gpt-6.1-sol' },
  ];
  assert.deepEqual(chatGptPickerModels({ registryModels }), [
    'chatgpt-subscription/gpt-6.1-sol',
    'chatgpt-subscription/gpt-6-astra',
    'chatgpt-subscription/gpt-7-nova',
    'chatgpt-subscription/gpt-6-sol',
  ]);
  assert.deepEqual(chatGptPickerModels({ registryModels: [] }), []);
});

test('the guide pins the two 5.1.38 files by path and sha256, never 5.1.33', () => {
  const guide = recommendationGuide({
    inventory,
    manifest: { title: 'guide', snapshotDate: '2026-10-14', sources: [{ webUrl: 'https://example', ref: 'v5.1.33' }] },
  });
  assert.equal(guide.version, '5.1.38');
  assert.deepEqual(guide.sources, [
    { path: inventory.sources.omo.path, sha256: inventory.sources.omo.sha256 },
    { path: inventory.sources.omoTask.path, sha256: inventory.sources.omoTask.sha256 },
  ]);
  assert.equal(inventory.sources.omo.sha256, '4a8aef923825ccd5fbb5ab6d4b3b72e0ae145b670309f1db3ead53827c029476');
  assert.equal(inventory.sources.omoTask.sha256, '2b559bb11f0285072722cffbb7f322756c81aec867f6fb4a683278f075d7f783');
  assert.equal(JSON.stringify(guide).includes('5.1.33'), false);
  assert.throws(() => recommendationGuide({ inventory: { sources: {} } }), /path and sha256/);
});

test('the four primary agents become roster rows with lane select and optional pin', () => {
  const roster = buildRoster({ now: '2026-10-20T00:00:00.000Z' });
  assert.deepEqual(Object.keys(roster.agents), AGENT_IDS);
  assert.equal(roster.v, 1);
  assert.equal(roster.revision, 0);
  assert.equal(roster.updatedAt, '2026-10-20T00:00:00.000Z');
  for (const id of AGENT_IDS) {
    assert.deepEqual(roster.agents[id], { lane: DEFAULT_LANE[id], pin: null, rev: 0 });
  }
  const rows = agentRosterRows({ roster });
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.ok(AGENT_IDS.includes(row.id));
    assert.equal(row.laneOptions.length, 4);
    assert.equal(row.laneOptions.find((option) => option.selected).value, DEFAULT_LANE[row.id]);
    assert.equal(row.pin, null);
    assert.equal(row.pinEditable, true);
    assert.equal(row.readOnly, false);
  }
  const pinned = buildRoster({
    now: '2026-10-20T00:00:00.000Z',
    agents: { atlas: { pin: { provider: 'chatgpt-subscription', modelId: 'gpt-6.1-sol', thinking: 'high' }, rev: 3 } },
  });
  assert.deepEqual(pinned.agents.atlas.pin, { provider: 'chatgpt-subscription', modelId: 'gpt-6.1-sol', thinking: 'high' });
  assert.equal(pinned.agents.atlas.rev, 3);
  assert.throws(() => buildRoster({ now: '2026-10-20T00:00:00.000Z', agents: { extra: {} } }), /unknown agent id/);
  assert.throws(() => buildRoster({ now: '2026-10-20T00:00:00.000Z', agents: { atlas: { lane: 'nope' } } }), /unknown lane/);
  assert.throws(() => buildRoster({ now: 'not-a-date' }), /ISO/);
});

test('inventoryStatus flags a stale bundle hash', () => {
  assert.deepEqual(inventoryStatus({ inventory }), { version: '5.1.38', stale: false, staleSources: [] });
  const stale = inventoryStatus({ inventory, live: { omo: 'deadbeef' } });
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.staleSources, ['omo']);
});

test('the ported RoleInventory stays the parity baseline (21 display rows)', () => {
  const rows = refreshRoutingRows({ inventory });
  assert.equal(rows.filter((row) => !row.readOnly).length, inventory.agents.length + inventory.categories.length);
  assert.equal(ROLE_INVENTORY.agents.length + ROLE_INVENTORY.categories.length, 20);
  assert.equal(rows.length, 20);
});
