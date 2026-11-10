// Synthetic homes only. Golden files supply structure; invented aliases exercise scale.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openProfilesStore, formatJsonText } from '../../src/profiles/store.mjs';
import { PROFILE_META } from '../../src/profiles/model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GOLDEN = path.join(ROOT, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files');
const STYLE = { bom: false, eol: '\n', indent: '  ', keySep: ': ', trailingNewline: true };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');

export function makeLiveScaleHome(t, { future = false, scale = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-live-scale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary'), stable = path.join(root, 'stable');
  const cards = { version: 1, nextCustomSeq: 4, cards: {}, custom: [] };
  if (future) {
    cards.cards[PROFILE_META[0].key] = { name: 'Synthetic renamed default' };
    for (let n = 1; n <= 3; n++) {
      const base = PROFILE_META[4];
      const { mainProvider, mainModel, mainThinking, fallbackChains } = base;
      cards.custom.push({ key: `custom-${n}`, num: 6 + n, omoProfile: `native-custom-${n}`,
        basedOn: base.key, createdAt: '2026-11-10T00:00:00.000Z',
        mainProvider, mainModel, mainThinking, fallbackChains });
      cards.cards[`custom-${n}`] = { name: `Synthetic custom ${n}`, tag: 'Fixture', summary: `Invented profile ${n}` };
    }
  }
  for (const [home, name] of [[primary, 'primary'], [stable, 'stable']]) {
    fs.mkdirSync(path.join(home, 'agent'), { recursive: true });
    const config = readJson(path.join(GOLDEN, name, 'omo.jsonc.json'));
    if (scale) {
      for (let n = 0; n < 128; n++) {
        const provider = `synthetic-${String(n % 14).padStart(2, '0')}`;
        const alias = n === 0 ? 'synthetic-long-alias-' + 'x'.repeat(70) : `synthetic-alias-${n}`;
        config['[native]'].models[alias] = { model: `${provider}/vendor-${n % 3}/model-${n}:fixture`, variant: 'high' };
      }
      config['[native]'].models['synthetic-web-deepseek'] = { model: 'susemi-deepseek-web/deepseek-chat', variant: 'high' };
      for (const profile of Object.values(config.profiles)) {
        for (const role of ['synthetic-role-alpha', 'synthetic-role-beta']) {
          profile['[native]'].agents[role] = { model: 'synthetic-alias-1' };
        }
      }
    }
    if (future) for (const item of cards.custom) {
      config.profiles[item.omoProfile] = structuredClone(config.profiles['native-experimental-custom']);
    }
    fs.writeFileSync(path.join(home, 'omo.jsonc'), formatJsonText(config, STYLE));
    const settings = name === 'primary' ? readJson(path.join(GOLDEN, name, 'settings.json.json')) : { packages: ['synthetic-package'] };
    fs.writeFileSync(path.join(home, 'agent/settings.json'), formatJsonText(settings, STYLE));
  }
  const selection = JSON.stringify({ key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: 'seed' });
  for (const rel of ['native-profile-selection.json', 'agent/native-profile-selection.json']) {
    fs.writeFileSync(path.join(primary, rel), selection);
  }
  if (future) {
    fs.mkdirSync(path.join(primary, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(primary, 'runtime/native-profile-switcher-profile-cards.json'), JSON.stringify(cards));
  }
  const pluginPath = path.join(root, 'omo.js'), plugin = 'synthetic-value-contract-plugin';
  fs.writeFileSync(pluginPath, plugin);
  const inventory = readJson(path.join(ROOT, 'src/profiles/inventory.json'));
  inventory.sources.omo.sha256 = sha(plugin);
  const store = openProfilesStore({ primaryHome: primary, stableHome: stable, mirrorHomes: [],
    pluginPath, inventory, registryModels: [], now: () => Date.parse('2026-11-10T00:00:00Z') });
  return { root, primary, stable, store, cards };
}

export function loadProfilesView() {
  const context = vm.createContext({});
  for (const file of ['icons.js', 'profiles-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/page', file), 'utf8'), context, { filename: file });
  }
  return context.BriefProfiles;
}

// The renderer emits ordinary quoted attributes. Text nodes are intentionally absent.
export function renderValueContract(api, state) {
  const edit = { live: true, pending: [], draft: {}, preview: null, conflict: false, busy: false };
  const variants = [
    ['top', {}], ['agents', { tab: 'agents' }], ['categories', { tab: 'categories' }],
    ['memory', { tab: 'memory' }], ['expanded', { tab: 'agents', openRow: 'route:agents/explore' }],
    ['guide', { tab: 'agents' }],
  ];
  const decode = value => value.replace(/&(amp|lt|gt|quot|#39|#96);/g,
    (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#96': '`' })[key]);
  const attrsOf = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)]
    .map(match => [match[1], decode(match[2] ?? '')]));
  return variants.map(([name, extra]) => {
    const rendered = api.render(state, { ...edit, ...extra });
    // showModal changes visibility, not values. Capture its real rendered subtree.
    const html = name === 'guide' ? /<dialog\b[^>]*id="pf-guide-dlg"[\s\S]*?<\/dialog>/.exec(rendered)[0] : rendered;
    const items = [], elements = [];
    for (const match of html.matchAll(/<[a-z][^>]*>/g)) {
      const attrs = attrsOf(match[0]);
      const keys = ['id', 'data-pf', 'data-flow', 'data-row', 'data-profile'];
      const values = Object.fromEntries(keys.filter(key => Object.hasOwn(attrs, key)).map(key => [key, attrs[key]]));
      const hooks = Object.entries(values).map(([key, value]) => ({ [key]: value }));
      const indices = hooks.map((_, index) => items.length + index);
      if (hooks.length) elements.push({ tag: /^<([a-z][\w-]*)/.exec(match[0])[1], hooks, indices,
        duplicateHooks: keys.some(key => [...match[0].matchAll(/([\w-]+)(?:="[^"]*")?/g)]
          .filter(attribute => attribute[1] === key).length > 1) });
      items.push(...hooks);
      if (match[0].startsWith('<select')) {
        const end = html.indexOf('</select>', match.index);
        const options = [...html.slice(match.index, end).matchAll(/<option\b[^>]*>/g)].map(option => {
          const a = attrsOf(option[0]);
          return { value: a.value ?? '', disabled: Object.hasOwn(a, 'disabled'),
            selected: Object.hasOwn(a, 'selected'), 'data-provider': a['data-provider'] ?? null };
        });
        items.push({ select: true, options });
      }
    }
    return { name, htmlBytes: Buffer.byteLength(html), items, elements };
  });
}

export async function controllerValueContract(api, state) {
  const posts = [];
  const controller = api.createController({ token: () => 'synthetic-token',
    fetch: async (url, options) => {
      if (url.endsWith('/state')) return { status: 200, json: async () => state };
      const body = JSON.parse(options.body);
      posts.push({ fields: Object.keys(body).sort(), action: body.action, changes: JSON.stringify(body.changes),
        expected: body.expected, rosterRevision: body.rosterRevision });
      return { status: 200, json: async () => ({ ok: true, diffs: [] }) };
    } });
  await controller.load();
  controller.show('experimental-custom');
  controller.add({ kind: 'setRoute', profileKey: 'experimental-custom', section: 'agents', role: 'explore',
    provider: 'kimi-coding', model: 'kimi-coding/k3', thinking: 'high' });
  controller.add({ kind: 'setMain', profileKey: 'experimental-custom',
    provider: 'commandcode', model: 'z-ai/glm-5.3-flash', thinking: 'max' });
  controller.add({ kind: 'setRoleBackup', profileKey: 'experimental-custom', section: 'agents', role: 'explore',
    alias: '', provider: 'kimi-coding', model: 'kimi-coding/k3', thinking: 'max' });
  await controller.preview('experimental-custom');
  await controller.apply('experimental-custom');
  return posts;
}
