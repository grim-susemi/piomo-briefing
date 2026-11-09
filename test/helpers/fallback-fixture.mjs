import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProfilesStore } from '../../src/profiles/store.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function fallbackFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-role-backup-'));
  const home = path.join(dir, 'primary');
  fs.mkdirSync(path.join(home, 'agent'), { recursive: true });
  const golden = path.join(root, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files/primary');
  fs.copyFileSync(path.join(golden, 'omo.jsonc.json'), path.join(home, 'omo.jsonc'));
  fs.copyFileSync(path.join(golden, 'settings.json.json'), path.join(home, 'agent/settings.json'));
  fs.copyFileSync(path.join(root, 'test/fixtures/profiles/registry/primary/agent/models.json'), path.join(home, 'agent/models.json'));
  fs.writeFileSync(path.join(home, 'native-profile-selection.json'), JSON.stringify({
    key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'fixture',
  }));
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'src/profiles/inventory.json'), 'utf8'));
  const options = {
    primaryHome: home, stableHome: home, mirrorHomes: [], inventory,
    pluginPath: inventory.sources.omo.path, recommendationManifest: null,
  };
  const store = openProfilesStore(options);
  return {
    dir, home, store, reopen: () => openProfilesStore(options),
    body(changes, action = 'apply') {
      const state = store.state();
      return { action, changes, expected: state.targets, rosterRevision: state.roster.revision };
    },
    close() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
