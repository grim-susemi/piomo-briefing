#!/usr/bin/env node
// Reads the installed omo-ai plugin bundles and writes the profile inventory.
// The plugin is given by --plugin <dir> or OMO_STABLE_PLUGIN (the pinned plugin dir, e.g.
// .../package/plugin). The version comes from <plugin>/../package.json, never from a literal.
// Anchor-string search (never a fixed byte offset). Minified identifiers change per release, so
// every structure lists the anchors of each known release as alternatives; the first one present
// wins and the matched anchor is written to inventory-diff.md:
//   * builtin agent ids            -> var s$=[ / var iE=[ / var dC=[ / var _T=[      (extensions/omo.js)
//   * builtin category ids         -> F_=[...[ (5.1.48) / ,Gb=[ / ,yb=[ / ,mb=[        (extensions/omo.js)
//   * lane-id array                -> var Qoe=[ (5.1.48) / var mce=[ / var noe=[ / var Rde=[
//   * strict-schema key sets       -> root: yf=bd({ (5.1.48) / qu=Jl({ / Ru=Kl({ / Mu=Kl({
//                                     native/senpi layer: mf=bd({ (5.1.48) / zu=Jl({ / Nu=Kl({ / Cu=Kl({
//                                     agent entry: bd({description:jl().optional(),prompt:... (5.1.48) / Hd=_d(
// Usage: node scripts/extract-inventory.mjs [--plugin <dir>] [--check]
// Writes src/profiles/inventory.json and src/profiles/inventory-diff.md.
// Exit codes: 0 ok (or --check current), 1 stale/failed, 2 usage (no plugin, missing package.json).
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const inventoryPath = path.join(repoRoot, 'src', 'profiles', 'inventory.json');
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

// The agent entry schema: 5.1.44 declared it after `Hd=_d(` and opened it with Jl({ / Kl({;
// 5.1.48 opens it as `bd({description:...`, so its object opens at the first `{` after the anchor.
function agentEntryKeys(omo) {
  const entry = findAnchor(omo, ['Hd=_d(', 'bd({description:jl().optional(),prompt:jl().optional()'], 'omo.js');
  let open;
  if (entry.anchor.startsWith('bd({')) {
    open = omo.indexOf('{', entry.index);
  } else {
    let kl = omo.indexOf('Jl({', entry.index);
    if (kl < 0) kl = omo.indexOf('Kl({', entry.index);
    if (kl < 0) fail('agent entry schema not found after Hd=_d(');
    open = omo.indexOf('{', kl);
  }
  return { keys: objectKeys(extractBalanced(omo, open, '{', '}')), anchor: entry.anchor };
}

export function extractInventory({ omo, omoTask, omoPath, omoTaskPath, version }) {
  const anchors = {};
  const agentAnchor = findAnchor(omo, ['var s$=[', 'var iE=[', 'var dC=[', 'var _T=['], 'omo.js');
  anchors.agents = agentAnchor.anchor;
  const agents = JSON.parse(extractBalanced(omo, omo.indexOf('[', agentAnchor.index)));
  if (!Array.isArray(agents) || agents.length === 0) fail('agent id array is empty');

  const categoryAnchor = findAnchor(omo, ['F_=[...[', ',Gb=[', ',yb=[', ',mb=['], 'omo.js');
  anchors.categories = categoryAnchor.anchor;
  const categoryArray = extractBalanced(omo, omo.indexOf('[', categoryAnchor.index));
  const categories = [...categoryArray.matchAll(/\{name:"([a-z0-9-]+)",config:/g)].map((match) => match[1]);
  if (categories.length === 0) fail('category id array is empty');

  const laneAnchor = findAnchor(omo, ['var Qoe=[', 'var mce=[', 'var noe=[', 'var Rde=['], 'omo.js');
  anchors.lanes = laneAnchor.anchor;
  const lanes = JSON.parse(extractBalanced(omo, omo.indexOf('[', laneAnchor.index)));
  if (!Array.isArray(lanes) || lanes.length === 0) fail('lane id array is empty');

  const rootAnchor = findAnchor(omo, ['yf=bd({', 'qu=Jl({', 'Ru=Kl({', 'Mu=Kl({'], 'omo.js');
  anchors.root = rootAnchor.anchor;
  const rootKeys = objectKeys(extractBalanced(omo, omo.indexOf('{', rootAnchor.index), '{', '}'));
  const nativeAnchor = findAnchor(omo, ['mf=bd({', 'zu=Jl({', 'Nu=Kl({', 'Cu=Kl({'], 'omo.js');
  anchors.native = nativeAnchor.anchor;
  const nativeKeys = objectKeys(extractBalanced(omo, omo.indexOf('{', nativeAnchor.index), '{', '}'));
  const entry = agentEntryKeys(omo);
  anchors.agentEntry = entry.anchor;
  const agentEntryKeyList = entry.keys;

  if (rootKeys.length === 0 || nativeKeys.length === 0 || agentEntryKeyList.length === 0) fail('schema key set is empty');

  const inventory = {
    schema: 1,
    version,
    sources: {
      omoTask: { path: omoTaskPath, sha256: createHash('sha256').update(omoTask, 'utf8').digest('hex'), bytes: Buffer.byteLength(omoTask) },
      omo: { path: omoPath, sha256: createHash('sha256').update(omo, 'utf8').digest('hex'), bytes: Buffer.byteLength(omo) },
    },
    agents,
    categories,
    lanes,
    schemaKeys: { root: rootKeys, native: nativeKeys, agentEntry: agentEntryKeyList },
  };
  return { inventory, anchors };
}

function diffMarkdown(inventory, anchors, roleInventory) {
  const v = inventory.version;
  const lines = [
    `# omo-ai ${v} role inventory diff`,
    '',
    `Generated by \`scripts/extract-inventory.mjs\` from the installed ${v} bundles.`,
    '',
    `- omo.js: \`${inventory.sources.omo.path}\` (sha256 \`${inventory.sources.omo.sha256}\`)`,
    `- omo-task.js: \`${inventory.sources.omoTask.path}\` (sha256 \`${inventory.sources.omoTask.sha256}\`)`,
    '',
    '| section | in ported RoleInventory | in ' + v + ' | new in ' + v + ' | absent from ' + v + ' |',
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
  lines.push('', '## Anchors matched', '', 'Minified anchors this release matched (the list in the header of scripts/extract-inventory.mjs holds every known release):', '');
  for (const [structure, anchor] of Object.entries(anchors)) lines.push(`- ${structure}: \`${anchor}\``);
  lines.push('');
  return lines.join('\n');
}

async function readPlugin(pluginRoot) {
  const omoPath = path.join(pluginRoot, 'extensions', 'omo.js');
  const omoTaskPath = path.join(pluginRoot, 'extensions', 'omo-task.js');
  const pkgPath = path.join(pluginRoot, '..', 'package.json');
  const [omo, omoTask, pkg] = await Promise.all([
    readFile(omoPath, 'utf8').catch(() => fail(`cannot read ${omoPath}`)),
    readFile(omoTaskPath, 'utf8').catch(() => fail(`cannot read ${omoTaskPath}`)),
    readFile(pkgPath, 'utf8').catch(() => fail(`cannot read ${pkgPath} (the plugin version comes from it)`)),
  ]);
  const version = JSON.parse(pkg).version;
  if (typeof version !== 'string' || version === '') fail(`${pkgPath} has no version`);
  return { omo, omoTask, omoPath, omoTaskPath, version };
}

// Exit 2 for a usage problem, 1 for stale or failed, 0 otherwise.
async function main() {
  const args = process.argv.slice(2);
  const pluginIndex = args.indexOf('--plugin');
  const pluginRoot = pluginIndex >= 0 ? args[pluginIndex + 1] : process.env.OMO_STABLE_PLUGIN;
  if (!pluginRoot) {
    console.error('extract-inventory: no plugin: pass --plugin <dir> or set OMO_STABLE_PLUGIN');
    return 2;
  }
  let source;
  try {
    source = await readPlugin(pluginRoot);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  const { inventory, anchors } = extractInventory(source);
  const roleInventory = (await import('../src/profiles/model.mjs')).ROLE_INVENTORY;
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  const diff = diffMarkdown(inventory, anchors, roleInventory);
  if (args.includes('--check')) {
    const current = await readFile(inventoryPath, 'utf8').catch(() => '');
    const currentDiff = await readFile(diffPath, 'utf8').catch(() => '');
    if (current !== json || currentDiff !== diff) {
      console.error('extract-inventory: inventory.json is stale; re-run without --check');
      return 1;
    }
    console.log('inventory current');
    return 0;
  }
  await writeFile(inventoryPath, json);
  await writeFile(diffPath, diff);
  console.log(`wrote ${inventoryPath}`);
  console.log(`wrote ${diffPath}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
