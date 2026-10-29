#!/usr/bin/env node
// Profile switcher CLI parity for the WinForms modes -PrintStatus, -DumpState,
// -Apply, -ApplyIntentPath and -DryRun. It reuses src/profiles/store.mjs, so every
// guard (inventory pin, key allowlist, CAS, backup, atomic write, rollback) is the
// same one the board route uses.
//
//   node scripts/profiles-cli.mjs status --primary-home <dir> --stable-home <dir>
//   node scripts/profiles-cli.mjs dump   --primary-home <dir> --stable-home <dir>
//   node scripts/profiles-cli.mjs apply <intent.json> [--dry-run] --primary-home <dir> --stable-home <dir>
//
// Optional: --mirror-home <dir> (repeatable), --plugin <omo.js>, --inventory <json>.
// The intent file is either the board body {action, changes, expected, rosterRevision}
// or {changes, expected, rosterRevision}; --dry-run forces action=preview.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { openProfilesStore } from '../src/profiles/store.mjs';

function usage() {
  return [
    'usage:',
    '  profiles-cli.mjs status|dump --primary-home <dir> --stable-home <dir> [--mirror-home <dir>]...',
    '  profiles-cli.mjs apply <intent.json> [--dry-run] --primary-home <dir> --stable-home <dir> [--mirror-home <dir>]...',
    'options: --plugin <omo.js>  --inventory <inventory.json>',
  ].join('\n');
}

function parse() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'primary-home': { type: 'string' },
      'stable-home': { type: 'string' },
      'mirror-home': { type: 'string', multiple: true },
      plugin: { type: 'string' },
      inventory: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  return { values, positionals };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const { values, positionals } = parse();
  if (values.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const command = positionals[0];
  if (!['status', 'dump', 'apply'].includes(command)) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  if (!values['primary-home'] || !values['stable-home']) {
    process.stderr.write('profiles-cli: --primary-home and --stable-home are required (no live default)\n');
    return 2;
  }
  const mirrorHomes = (values['mirror-home'] ?? []).flatMap((item) => item.split(',')).filter(Boolean);
  const options = {
    primaryHome: values['primary-home'],
    stableHome: values['stable-home'],
    mirrorHomes,
    ...(values.plugin ? { pluginPath: values.plugin } : {}),
    ...(values.inventory ? { inventoryPath: values.inventory } : {}),
  };
  const store = openProfilesStore(options);

  if (command === 'status') {
    const state = store.state();
    writeJson({
      primaryHome: store.roots.primaryHome,
      stableHome: store.roots.stableHome,
      mirrors: state.homes.mirrors,
      readOnly: state.readOnly,
      readOnlyReason: state.readOnlyReason,
      banner: state.banner,
      inventory: state.inventory,
      activeProfile: state.activeProfile,
      main: state.main,
      summarizer: state.summarizer,
      rosterRevision: state.roster.revision,
      applyJournal: state.applyJournal,
      targets: state.targets,
    });
    return 0;
  }

  if (command === 'dump') {
    writeJson(store.state());
    return 0;
  }

  const intentPath = positionals[1];
  if (!intentPath) {
    process.stderr.write('profiles-cli: apply needs an intent JSON path\n');
    return 2;
  }
  let intent;
  try {
    intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`profiles-cli: cannot read intent: ${error.message}\n`);
    return 2;
  }
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) || !Array.isArray(intent.changes)) {
    process.stderr.write('profiles-cli: intent must be an object with a changes array\n');
    return 2;
  }
  const state = store.state();
  const body = {
    action: values['dry-run'] ? 'preview' : 'apply',
    changes: intent.changes,
    expected: intent.expected ?? state.targets,
    rosterRevision: intent.rosterRevision ?? state.roster.revision,
  };
  const before = state.targets;
  const result = body.action === 'preview' ? store.preview(body) : store.apply(body);
  const output = { ...result, before };
  writeJson(output);
  if (!result.ok) {
    process.stderr.write(`profiles-cli: ${result.code ?? 'ERROR'} (${result.status ?? 1}) ${result.message ?? ''}\n`.trimEnd() + '\n');
    return 1;
  }
  return 0;
}

process.exitCode = main();
