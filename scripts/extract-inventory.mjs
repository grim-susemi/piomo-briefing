#!/usr/bin/env node
// Reads the installed omo-ai 5.1.44 plugin bundles and writes the profile inventory.
// Anchor-string search (never a fixed byte offset) for:
//   * builtin agent ids            -> var s$=[...] or var iE=[...] or var dC=[...] (extensions/omo.js)
//   * builtin category ids         -> ,Gb=[...] or ,yb=[...] or ,mb=[...]           (extensions/omo.js)
//   * lane-id array Rde            -> var mce=[...] or var noe=[...] or var Rde=[...] (extensions/omo.js)
//   * strict-schema key sets       -> qu=Jl({...}).strict() or Ru=Kl({...}).strict() (root)
//                                    zu=Jl({...}).strict() or Nu=Kl({...}).strict() ([native]/[senpi] layer)
//                                    Hd=_d(...,Jl({...}).strict()) (agent entry)
// Usage: node scripts/extract-inventory.mjs [--plugin <dir>] [--check]
// Writes src/profiles/inventory-5.1.44.json and src/profiles/inventory-diff.md.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PLUGIN = 'C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.44-r1/package/plugin';
export const INVENTORY_VERSION = '5.1.44';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const inventoryPath = path.join(repoRoot, 'src', 'profiles', 'inventory-5.1.44.json');
const diffPath = path.join(repoRoot, 'src', 'profiles', 'inventory-diff.md');

function fail(message) { throw new Error(`extract-inventory: ${message}`); }

function extractBalanced(source, openIndex, open = '[', close = ']') {
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (char === '\\') { i += 1; continue; }
      if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { inString = true; quote = char; continue; }
    if (char === open) depth += 1;
    else if (char === close) { depth -= 1; if (depth === 0) return source.slice(openIndex, i + 1); }
  }
  fail(`unbalanced ${open}${close} at ${openIndex}`);
}

function objectKeys(body) {
  const inner = body.slice(1, -1);
  const keys = [];
  let depth = 0;
  let inString = false;
  let quote = '';
  let current = '';
  const flush = () => { if (current.trim()) keys.push(current.trim().split(':')[0].replace(/^"|"$/g, '')); current = ''; };
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (inString) {
      if (char === '\\') { current += char + inner[i + 1]; i += 1; continue; }
      if (char === quote) inString = false;
      current += char;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { inString = true; quote = char; current += char; continue; }
    if ('{[('.includes(char)) { depth += 1; current += char; continue; }
    if ('}])'.includes(char)) { depth -= 1; current += char; continue; }
    if (char === ',' && depth === 0) { flush(); continue; }
    current += char;
  }
  flush();
  return keys.filter(Boolean);
}

function findAnchor(source, anchors, file) {
  const list = Array.isArray(anchors) ? anchors : [anchors];
  for (const a of list) {
    const index = source.indexOf(a);
    if (index >= 0) return { index, anchor: a };
  }
  fail(`anchor not found in ${file}: ${list.join(' OR ')}`);
}

export function extractInventory({ omo, omoTask, omoPath, omoTaskPath }) {
  const agentAnchor = findAnchor(omo, ['var s$=[', 'var iE=[', 'var dC=['], 'omo.js');
  const agents = JSON.parse(extractBalanced(omo, omo.indexOf('[', agentAnchor.index)));
  if (!Array.isArray(agents) || agents.length === 0) fail('agent id array is empty');

  const categoryAnchor = findAnchor(omo, [',Gb=[', ',yb=[', ',mb=['], 'omo.js');
  const categoryArray = extractBalanced(omo, omo.indexOf('[', categoryAnchor.index));
  const categories = [...categoryArray.matchAll(/\{name:"([a-z0-9-]+)",config:/g)].map((match) => match[1]);
  if (categories.length === 0) fail('category id array is empty');

  const laneAnchor = findAnchor(omo, ['var mce=[', 'var noe=[', 'var Rde=['], 'omo.js');
  const lanes = JSON.parse(extractBalanced(omo, omo.indexOf('[', laneAnchor.index)));
  if (!Array.isArray(lanes) || lanes.length === 0) fail('lane id array is empty');

  const rootAnchor = findAnchor(omo, ['qu=Jl({', 'Ru=Kl({', 'Mu=Kl({'], 'omo.js');
  const rootKeys = objectKeys(extractBalanced(omo, omo.indexOf('{', rootAnchor.index), '{', '}'));
  const nativeAnchor = findAnchor(omo, ['zu=Jl({', 'Nu=Kl({', 'Cu=Kl({'], 'omo.js');
  const nativeKeys = objectKeys(extractBalanced(omo, omo.indexOf('{', nativeAnchor.index), '{', '}'));
  const agentEntryAnchor = findAnchor(omo, 'Hd=_d(', 'omo.js');
  let agentEntryKl = omo.indexOf('Jl({', agentEntryAnchor.index);
  if (agentEntryKl < 0) agentEntryKl = omo.indexOf('Kl({', agentEntryAnchor.index);
  if (agentEntryKl < 0) fail('agent entry schema not found after Hd=_d(');
  const agentEntryKeys = objectKeys(extractBalanced(omo, omo.indexOf('{', agentEntryKl), '{', '}'));

  if (rootKeys.length === 0 || nativeKeys.length === 0 || agentEntryKeys.length === 0) fail('schema key set is empty');

  return {
    schema: 1,
    version: INVENTORY_VERSION,
    sources: {
      omoTask: { path: omoTaskPath, sha256: createHash('sha256').update(omoTask, 'utf8').digest('hex'), bytes: Buffer.byteLength(omoTask) },
      omo: { path: omoPath, sha256: createHash('sha256').update(omo, 'utf8').digest('hex'), bytes: Buffer.byteLength(omo) },
    },
    agents,
    categories,
    lanes,
    schemaKeys: { root: rootKeys, native: nativeKeys, agentEntry: agentEntryKeys },
  };
}

function diffMarkdown(inventory, roleInventory) {
  const lines = [
    '# omo-ai 5.1.44 role inventory diff',
    '',
    `Generated by \`scripts/extract-inventory.mjs\` from the installed 5.1.44 bundles.`,
    '',
    `- omo.js: \`${inventory.sources.omo.path}\` (sha256 \`${inventory.sources.omo.sha256}\`)`,
    `- omo-task.js: \`${inventory.sources.omoTask.path}\` (sha256 \`${inventory.sources.omoTask.sha256}\`)`,
    '',
    '| section | in ported RoleInventory | in 5.1.44 | new in 5.1.44 | absent from 5.1.44 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const section of ['agents', 'categories']) {
    const ported = roleInventory[section] ?? [];
    const live = inventory[section] ?? [];
    const added = live.filter((role) => !ported.includes(role));
    const absent = ported.filter((role) => !live.includes(role));
    lines.push(`| ${section} | ${ported.length} | ${live.length} | ${added.join(', ') || '-'} | ${absent.join(', ') || '-'} |`);
  }
  lines.push('', '## Lanes', '', inventory.lanes.map((lane) => `- \`${lane}\``).join('\n'), '');
  lines.push('## Strict-schema key sets', '');
  lines.push(`- root: ${inventory.schemaKeys.root.join(', ')}`);
  lines.push(`- [native]/[senpi]: ${inventory.schemaKeys.native.join(', ')}`);
  lines.push(`- agent entry: ${inventory.schemaKeys.agentEntry.join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const pluginIndex = args.indexOf('--plugin');
  const pluginRoot = pluginIndex >= 0 ? args[pluginIndex + 1] : DEFAULT_PLUGIN;
  const omoPath = path.join(pluginRoot, 'extensions', 'omo.js');
  const omoTaskPath = path.join(pluginRoot, 'extensions', 'omo-task.js');
  const [omo, omoTask] = await Promise.all([
    readFile(omoPath, 'utf8').catch(() => fail(`cannot read ${omoPath}`)),
    readFile(omoTaskPath, 'utf8').catch(() => fail(`cannot read ${omoTaskPath}`)),
  ]);
  const inventory = extractInventory({ omo, omoTask, omoPath, omoTaskPath });
  const roleInventory = (await import('../src/profiles/model.mjs')).ROLE_INVENTORY;
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  if (args.includes('--check')) {
    const current = await readFile(inventoryPath, 'utf8').catch(() => '');
    if (current !== json) fail('inventory-5.1.44.json is stale; re-run without --check');
    console.log('inventory current');
    return;
  }
  await writeFile(inventoryPath, json);
  await writeFile(diffPath, diffMarkdown(inventory, roleInventory));
  console.log(`wrote ${inventoryPath}`);
  console.log(`wrote ${diffPath}`);
  console.log(`agents=${inventory.agents.length} categories=${inventory.categories.length} lanes=${inventory.lanes.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
