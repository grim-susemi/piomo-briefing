// Board profiles v3 baseline & final layout/order/naming probe (plan todo 12).
//
// Usage:
//   OMO_STABLE_PLUGIN=<pinned plugin dir> node scripts/qa-profiles-v3.mjs --baseline-ref d282b3b --out <dir>
//   OMO_STABLE_PLUGIN=<pinned plugin dir> node scripts/qa-profiles-v3.mjs --final --out <dir>
//
// Under --baseline-ref <sha> (default d282b3b), materialises that commit's tracked files into a temp
// snapshot via `git archive | tar -x` and imports/serves the board from the snapshot so concurrent
// worktree edits cannot contaminate the baseline.
// Under --final, serves the current worktree checkout instead and writes `layout.json` (plus `baseline.json`
// alias if requested) alongside `naming-map.json`, `commands.txt`, and `console.txt`.
// Every wait is an event or bounded deadline; no fixed sleeps.
import '../test/helpers/refuse-live-writes.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launch, listProfilePids, isPidAlive, watchCsp } from './cdp.mjs';
import { measurePurposeGrid, assertPurposeGrid } from './profiles-grid.mjs';

const WORKTREE_ROOT = fileURLToPath(new URL('..', import.meta.url));
if (!process.env.OMO_STABLE_PLUGIN) {
  throw new Error('set OMO_STABLE_PLUGIN to the pinned plugin dir');
}
const LIVE_BOARD = [47317, 47326];
const LIVE_HOMES = [
  'C:/Users/USER/.omo',
  'C:/Users/USER/.omo-stable-500/home/.omo',
  'C:/Users/USER/.omo-original/home/.omo',
  'C:/Users/USER/.somo/home/.omo',
];
const LIVE_READONLY_FILES = {
  stableOmo: 'C:/Users/USER/.omo-stable-500/home/.omo/omo.jsonc',
  stableSelection: 'C:/Users/USER/.omo-stable-500/home/.omo/native-profile-selection.json',
  stableAgentSelection: 'C:/Users/USER/.omo-stable-500/home/.omo/agent/native-profile-selection.json',
  stableSettings: 'C:/Users/USER/.omo-stable-500/home/.omo/agent/settings.json',
  stableRoster: 'C:/Users/USER/.omo-stable-500/home/.omo/agent/primary-agents/roster.json',
  recommendationManifest: 'C:/Users/USER/Desktop/OpenCode_Modes/OMO_Native_Recommendation.json',
};
const FIXED_NOW = Date.parse('2026-10-20T12:00:00Z');
const PS_STYLE = { bom: true, eol: '\r\n', indent: '    ', keySep: ':  ', trailingNewline: true };
const VIEWPORTS = [
  { name: '1180x700', width: 1180, height: 700, mobile: false },
  { name: '1440x900', width: 1440, height: 900, mobile: false },
  { name: '1600x900', width: 1600, height: 900, mobile: false },
  { name: '1000x900', width: 1000, height: 900, mobile: false },
  { name: '900x900', width: 900, height: 900, mobile: false },
];
const REVIEWER_ROLES = [
  'omo-native-code-reviewer',
  'omo-native-gate-reviewer',
  'omo-native-qa-executor',
];

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const IS_FINAL = argv.includes('--final');
const REVIEW_CAPTURE = argv.includes('--review-capture');
const BASELINE_REF = arg('--baseline-ref', 'd282b3b');
const OUT_RAW = arg('--out');
const SHUFFLE_PROBE = argv.includes('--probe-shuffle-order');
const ONE_COL_PROBE = argv.includes('--probe-force-one-col');
if (!OUT_RAW) {
  console.error('usage: node scripts/qa-profiles-v3.mjs [--baseline-ref <sha> | --final] --out <dir>');
  process.exit(2);
}

function resolveOutDir(raw) {
  if (/^E[\\/]/.test(raw) || raw === 'E') {
    const rest = raw.slice(1).replace(/^[\\/]+/, '');
    const evidenceBase = path.resolve(WORKTREE_ROOT, '..', '..', '기타 작업', '.omo', 'evidence', 'profile-agent-switcher-v3');
    if (fs.existsSync(path.resolve(WORKTREE_ROOT, '..', '..', '기타 작업'))) {
      return path.join(evidenceBase, rest);
    }
  }
  return path.resolve(raw);
}

const OUT = resolveOutDir(OUT_RAW);

const PORT_BASE = Number(process.env.OMO_BRIEFING_PORT_BASE || 47620);
if (
  !Number.isInteger(PORT_BASE) ||
  PORT_BASE < 1024 ||
  PORT_BASE + 9 > 65535 ||
  (PORT_BASE <= LIVE_BOARD[1] && PORT_BASE + 9 >= LIVE_BOARD[0])
) {
  console.error(`OMO_BRIEFING_PORT_BASE=${PORT_BASE}: needs 10 ports outside the live board's ${LIVE_BOARD.join('-')}`);
  process.exit(2);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hashFile = (file) => (fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null);
const slash = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
const stripBom = (text) => String(text).replace(/^\uFEFF/, '');
const readJson = (file) => JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));

function assertFixtureRoot(root) {
  const r = slash(root);
  for (const home of LIVE_HOMES.map(slash)) {
    if (r === home || r.startsWith(home + '/') || home.startsWith(r + '/')) {
      throw new Error(`fixture root ${root} touches live home ${home}`);
    }
  }
}

function materialiseSnapshot(repoRoot, ref, destDir, commandLog) {
  fs.mkdirSync(destDir, { recursive: true });
  const revParse = spawnSync('git', ['-C', repoRoot, 'rev-parse', `${ref}^{commit}`], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  commandLog.push(`git -C "${repoRoot}" rev-parse "${ref}^{commit}"`);
  if (revParse.status !== 0) {
    throw new Error(`git rev-parse ${ref} failed: ${revParse.stderr || revParse.stdout}`);
  }
  const commitSha = revParse.stdout.trim();

  // Pipe `git archive <commitSha>` into `tar -x -C <destDir>`
  commandLog.push(`git -C "${repoRoot}" archive "${commitSha}" | tar -x -C "${destDir}"`);
  return new Promise((resolve, reject) => {
    const gitProc = spawn('git', ['-C', repoRoot, 'archive', '--format=tar', commitSha], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const tarProc = spawn('tar', ['-x', '-C', destDir], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let gitErr = '';
    let tarErr = '';
    gitProc.stderr.on('data', (d) => { gitErr += String(d); });
    tarProc.stderr.on('data', (d) => { tarErr += String(d); });
    gitProc.stdout.pipe(tarProc.stdin);
    let gitCode = null;
    let tarCode = null;
    const checkDone = () => {
      if (gitCode === null || tarCode === null) return;
      if (gitCode !== 0) return reject(new Error(`git archive failed (${gitCode}): ${gitErr}`));
      if (tarCode !== 0) return reject(new Error(`tar -x failed (${tarCode}): ${tarErr}`));
      resolve(commitSha);
    };
    gitProc.on('error', reject);
    tarProc.on('error', reject);
    gitProc.on('close', (code) => { gitCode = code; checkDone(); });
    tarProc.on('close', (code) => { tarCode = code; checkDone(); });
  });
}

function verifySnapshotMatchesRef(repoRoot, ref, snapshotDir, relPaths, commandLog) {
  const results = [];
  for (const rel of relPaths) {
    commandLog.push(`git -C "${repoRoot}" show "${ref}:${rel}"`);
    const gitShow = spawnSync('git', ['-C', repoRoot, 'show', `${ref}:${rel}`], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 10000,
      windowsHide: true,
    });
    if (gitShow.status !== 0) {
      throw new Error(`git show ${ref}:${rel} failed: ${String(gitShow.stderr)}`);
    }
    const snapFile = path.join(snapshotDir, rel);
    const snapBytes = fs.readFileSync(snapFile);
    const gitHash = sha256(gitShow.stdout);
    const snapHash = sha256(snapBytes);
    // Also normalize CRLF->LF in case git show vs archive differs by core.autocrlf (git archive honors export/worktree attrs or raw blob; let's compare both raw and LF-normalized).
    const gitLfHash = sha256(Buffer.from(gitShow.stdout.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
    const snapLfHash = sha256(Buffer.from(snapBytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
    assert.equal(snapLfHash, gitLfHash, `stale_state check failed for ${rel}: snapshot ${snapLfHash} !== git show ${gitLfHash}`);
    results.push({
      path: rel,
      gitShowSha256: gitHash,
      snapshotSha256: snapHash,
      lfSha256: snapLfHash,
      exactByteMatch: gitHash === snapHash,
      lfMatch: gitLfHash === snapLfHash,
    });
  }
  return results;
}

function resolvePluginForInventory(serveRoot) {
  const invPath = path.join(serveRoot, 'src/profiles/inventory.json');
  const inv = readJson(invPath);
  const envPlugin = path.join(process.env.OMO_STABLE_PLUGIN, 'extensions', 'omo.js');
  const envHash = hashFile(envPlugin);
  const pinnedHash = inv?.sources?.omo?.sha256 ?? null;
  const pinnedPath = inv?.sources?.omo?.path ?? null;
  // If the environment's OMO_STABLE_PLUGIN matches the inventory's pinned hash, use it directly.
  // If OMO_STABLE_PLUGIN points to a newer rollback (e.g. 5.1.60 while d282b3b inventory pins 5.1.48),
  // check whether the inventory's pinned source path exists on disk so the fixture store opens in editable mode
  // (required to exercise preview/pending in the fixture!).
  if (envHash && pinnedHash && envHash === pinnedHash) {
    return { pluginPath: envPlugin, envPluginPath: envPlugin, envPluginSha256: envHash, pinnedSha256: pinnedHash, matchedVia: 'env' };
  }
  if (pinnedPath && fs.existsSync(pinnedPath) && hashFile(pinnedPath) === pinnedHash) {
    return { pluginPath: pinnedPath, envPluginPath: envPlugin, envPluginSha256: envHash, pinnedSha256: pinnedHash, matchedVia: 'inventory.sources.omo.path' };
  }
  return { pluginPath: envPlugin, envPluginPath: envPlugin, envPluginSha256: envHash, pinnedSha256: pinnedHash, matchedVia: 'env-unmatched' };
}

function seedFixtureHomes(root, serveRoot, formatJsonText) {
  assertFixtureRoot(root);
  const goldenDir = path.join(serveRoot, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files');
  const regDir = path.join(serveRoot, 'test/fixtures/profiles/registry');
  const primary = path.join(root, 'home', 'primary');
  const stable = path.join(root, 'home', 'stable');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(primary, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(stable, 'agent'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const write = (file, value) => fs.writeFileSync(file, formatJsonText(value, PS_STYLE));
  write(path.join(primary, 'omo.jsonc'), readJson(path.join(goldenDir, 'primary/omo.jsonc.json')));
  write(path.join(primary, 'agent', 'settings.json'), readJson(path.join(goldenDir, 'primary/settings.json.json')));
  write(path.join(primary, 'native-profile-selection.json'), { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' });
  write(path.join(primary, 'agent', 'native-profile-selection.json'), { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek' });
  write(path.join(stable, 'omo.jsonc'), readJson(path.join(goldenDir, 'stable/omo.jsonc.json')));
  fs.writeFileSync(path.join(stable, 'agent', 'settings.json'), '{"packages":["stable"]}');

  const regPrimary = path.join(regDir, 'primary/agent/models.json');
  const regStable = path.join(regDir, 'stable/agent/models.json');
  if (fs.existsSync(regPrimary)) fs.copyFileSync(regPrimary, path.join(primary, 'agent', 'models.json'));
  if (fs.existsSync(regStable)) fs.copyFileSync(regStable, path.join(stable, 'agent', 'models.json'));

  const memoryDir = path.join(stable, 'agent', 'primary-agents', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'sisyphus.json'), JSON.stringify({
    v: 1,
    agentId: 'sisyphus',
    model: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    thinking: 'high',
    rosterRev: 0,
    updatedAt: '2026-10-20T12:00:00.000Z',
  }));

  return { primary, stable, stateDir };
}

function readLiveFacts(modules) {
  const { parseJsonc, expandLayerRoles, newRouteRow, compareRecommendation, BUILTIN_ROLE_CATEGORIES, ROLE_DISPLAY_NAMES, ROUTING_GROUPS } = modules;
  const hashes = {};
  for (const [k, f] of Object.entries(LIVE_READONLY_FILES)) {
    hashes[k] = { path: f, sha256: hashFile(f) };
  }
  const omoRaw = fs.existsSync(LIVE_READONLY_FILES.stableOmo) ? fs.readFileSync(LIVE_READONLY_FILES.stableOmo, 'utf8') : null;
  const omoConfig = omoRaw ? parseJsonc(omoRaw) : null;
  const selection = fs.existsSync(LIVE_READONLY_FILES.stableSelection) ? readJson(LIVE_READONLY_FILES.stableSelection) : null;
  const settings = fs.existsSync(LIVE_READONLY_FILES.stableSettings) ? readJson(LIVE_READONLY_FILES.stableSettings) : null;
  const roster = fs.existsSync(LIVE_READONLY_FILES.stableRoster) ? readJson(LIVE_READONLY_FILES.stableRoster) : null;
  const manifest = fs.existsSync(LIVE_READONLY_FILES.recommendationManifest) ? readJson(LIVE_READONLY_FILES.recommendationManifest) : null;

  const activeKey = selection?.key ?? null;
  const activeOmoProfile = selection?.profile ?? null;
  const layer = activeOmoProfile && omoConfig?.profiles?.[activeOmoProfile]
    ? (omoConfig.profiles[activeOmoProfile]['[senpi]'] ?? omoConfig.profiles[activeOmoProfile]['[native]'] ?? null)
    : null;
  const catalog = omoConfig?.['[senpi]']?.models ?? omoConfig?.['[native]']?.models ?? {};

  const rawCategoriesKeyOrder = layer?.categories ? Object.keys(layer.categories) : [];
  const rawAgentsKeyOrder = layer?.agents ? Object.keys(layer.agents) : [];

  const expanded = layer ? expandLayerRoles({ catalog, layer }) : [];
  const routeRows = expanded.map(newRouteRow);
  const recComparison = manifest ? compareRecommendation(routeRows, manifest) : null;
  const recByKey = new Map((recComparison?.Items ?? []).map((item) => [`${item.Section}/${item.Role}`, item]));

  const reviewerFacts = {};
  for (const roleId of REVIEWER_ROLES) {
    const rawEntry = layer?.agents?.[roleId] ?? null;
    const explicitAlias = typeof rawEntry?.model === 'string' ? rawEntry.model : null;
    const catEntry = explicitAlias ? (catalog[explicitAlias] ?? null) : null;
    const recItem = recByKey.get(`agents/${roleId}`) ?? null;
    const covEntry = (manifest?.coverage ?? []).find((c) => c.section === 'agents' && c.role === roleId) ?? null;
    const fallbackCategories = BUILTIN_ROLE_CATEGORIES[roleId] ?? [];
    const categoryTargets = fallbackCategories.map((cat) => {
      const catAlias = layer?.categories?.[cat]?.model ?? null;
      const resolved = catAlias ? (catalog[catAlias] ?? null) : null;
      return {
        category: cat,
        sourcePath: `${LIVE_READONLY_FILES.stableOmo}#/profiles/${activeOmoProfile}/[native]/categories/${cat}/model`,
        alias: catAlias,
        modelId: resolved?.model ?? null,
        variant: resolved?.variant ?? resolved?.reasoning ?? null,
      };
    });
    reviewerFacts[roleId] = {
      roleId,
      section: 'agents',
      group: 'review',
      groupLabel: ROUTING_GROUPS.agents.groups.review.label,
      displayName: ROLE_DISPLAY_NAMES[roleId] ?? { Ko: roleId, En: roleId },
      sourceJsonPath: `${LIVE_READONLY_FILES.stableOmo}#/profiles/${activeOmoProfile}/[native]/agents/${roleId}`,
      explicitAlias,
      resolvedModelId: catEntry?.model ?? null,
      resolvedVariant: catEntry?.variant ?? catEntry?.reasoning ?? null,
      builtinFallbackCategories: fallbackCategories,
      builtinCategoryTargets: categoryTargets,
      effectiveAliasWhenExplicitPresent: recItem?.EffectiveAlias ?? '',
      effectiveCategoryWhenExplicitPresent: recItem?.EffectiveCategory ?? '',
      manifestCoverage: covEntry ? {
        sourceJsonPath: `${LIVE_READONLY_FILES.recommendationManifest}#/coverage[section=agents,role=${roleId}]`,
        expectationRole: covEntry.expectationRole,
        recommendation: covEntry.recommendation,
        provenance: covEntry.provenance,
        note: covEntry.note,
      } : null,
      recommendationComparison: recItem ?? null,
    };
  }

  return {
    hashes,
    activeSelection: {
      sourcePath: LIVE_READONLY_FILES.stableSelection,
      key: activeKey,
      omoProfile: activeOmoProfile,
    },
    rawKeyOrderInSelectedProfile: {
      sourcePath: `${LIVE_READONLY_FILES.stableOmo}#/profiles/${activeOmoProfile}/[native]`,
      agents: rawAgentsKeyOrder,
      categories: rawCategoriesKeyOrder,
      deepHighIndexInCategoriesJson: rawCategoriesKeyOrder.indexOf('deep-high'),
      deepLowIndexInCategoriesJson: rawCategoriesKeyOrder.indexOf('deep-low'),
      ultrabrainIndexInCategoriesJson: rawCategoriesKeyOrder.indexOf('ultrabrain'),
      deepOrderInRawJson: rawCategoriesKeyOrder.filter((k) => ['deep-low', 'deep-high', 'ultrabrain'].includes(k)),
    },
    deepCategoryModelsInSelectedProfile: {
      'deep-low': layer?.categories?.['deep-low']?.model ?? null,
      'deep-high': layer?.categories?.['deep-high']?.model ?? null,
      ultrabrain: layer?.categories?.ultrabrain?.model ?? null,
    },
    summarizerInSettings: {
      sourcePath: `${LIVE_READONLY_FILES.stableSettings}#/compaction/model`,
      compactionModel: settings?.compaction?.model ?? null,
    },
    rosterSummary: {
      sourcePath: LIVE_READONLY_FILES.stableRoster,
      revision: roster?.revision ?? null,
      agents: roster?.agents ?? null,
    },
    reviewerRoles: reviewerFacts,
  };
}

function waitFor(page, predicate, what, timeout = 12000) {
  return page.eval(`new Promise((resolve, reject) => {
    const check = () => { try { return (${predicate}); } catch (e) { return null; } };
    const hit = check();
    if (hit) return resolve(hit);
    const observer = new MutationObserver(() => { const value = check(); if (value) { done(); resolve(value); } });
    const timer = setTimeout(() => { done(); reject(new Error(${JSON.stringify('timeout waiting for ' + what)})); }, ${timeout});
    function done() { observer.disconnect(); clearTimeout(timer); }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  })`);
}

async function settle(page) {
  await page.eval(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
  await page.eval(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  await page.eval(`Promise.all(document.getAnimations().filter((a) => a.playState === 'running' &&
    !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity)).map((a) => a.finished.catch(() => null))).then(() => true)`);
  await page.eval(`new Promise((resolve) => requestAnimationFrame(() => resolve(true)))`);
}

// Stage changes on the fixture page and click preview so all 4 surfaces (role rows, guide, preview, pending)
// are populated and measurable in DOM order.
async function ensureAllFourSurfacesActive(page) {
  // Check if pending already has items and preview is open
  const hasPreviewAndPending = await page.eval(`(() => {
    const pend = document.querySelectorAll('.pf-pending li').length;
    const prev = !!document.querySelector('[data-pf-preview]');
    return pend >= 2 && prev;
  })()`);
  if (hasPreviewAndPending) return;

  // Stage changes for deep-low, deep-high, ultrabrain, and omo-native-gate-reviewer via real DOM events
  // (supporting both baseline open rows and v3 expandable rows) so they appear in pending and preview diff!
  await page.eval(`(() => {
    const findRow = (routeKey) => {
      // Under v3 tabs (todo 8+), switch to the tab owning this section if needed
      const sec = routeKey.split('/')[0];
      const tabBtn = document.querySelector('[role="tab"][data-tab="' + sec + '"], [data-pf="tab"][data-tab="' + sec + '"]');
      if (tabBtn && tabBtn.getAttribute('aria-selected') !== 'true') tabBtn.click();
      return document.querySelector('[data-pf-route="' + routeKey + '"]');
    };

    const stageRole = (routeKey) => {
      let row = findRow(routeKey);
      if (!row) return false;
      // If v3 compact row is collapsed, expand it first
      const sumBtn = row.querySelector('.pf-row-sum[aria-expanded="false"]');
      if (sumBtn) sumBtn.click();
      row = findRow(routeKey);
      if (!row) return false;

      const provSel = row.querySelector('[data-pf="route-provider"]');
      if (!provSel || provSel.disabled) return false;
      const provOpts = [...provSel.options].filter((o) => o.value && !o.disabled);
      if (!provOpts.length) return false;
      const pickProv = (provOpts.find((o) => o.value === 'anthropic-subscription') || provOpts.find((o) => o.value === provSel.value) || provOpts[0]).value;
      provSel.value = pickProv;
      provSel.dispatchEvent(new Event('change', { bubbles: true }));

      row = findRow(routeKey);
      const modSel = row && row.querySelector('[data-pf="route-model"]');
      if (!modSel) return false;
      const modOpts = [...modSel.options].filter((o) => o.value && !o.disabled);
      if (!modOpts.length) return false;
      const pickMod = (modOpts.find((o) => o.value !== modSel.value) || modOpts[0]).value;
      modSel.value = pickMod;
      modSel.dispatchEvent(new Event('change', { bubbles: true }));

      row = findRow(routeKey);
      const thkSel = row && row.querySelector('[data-pf="route-thinking"]');
      if (thkSel) {
        const thkOpts = [...thkSel.options].filter((o) => o.value && !o.disabled);
        if (thkOpts.length) {
          thkSel.value = thkOpts[thkOpts.length - 1].value;
          thkSel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      // If v3 compact row was opened, close it back so closed-row measurements stay clean
      row = findRow(routeKey);
      const openBtn = row && row.querySelector('.pf-row-sum[aria-expanded="true"]');
      if (openBtn) openBtn.click();
      return true;
    };

    stageRole('categories/deep-low');
    stageRole('categories/deep-high');
    stageRole('categories/ultrabrain');
    stageRole('agents/omo-native-gate-reviewer');
    return document.querySelectorAll('.pf-pending li').length;
  })()`);
  await settle(page);

  // Trigger preview via the preview button
  await page.eval(`(() => {
    const btn = document.querySelector('[data-pf="preview"]');
    if (btn && !btn.disabled) { btn.click(); return 'clicked'; }
    return 'none';
  })()`);
  await waitFor(page, `!!document.querySelector('[data-pf-preview]') || !!document.querySelector('.pf-err')`, 'preview diff rendered');
  await settle(page);
  const previewErr = await page.eval(`document.querySelector('.pf-err')?.textContent || ''`);
  if (previewErr) throw new Error('preview failed with error: ' + previewErr);
}

async function measureAtViewport(page, vp) {
  await page.client.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: 1,
    mobile: vp.mobile,
  });
  await settle(page);

  // Ensure sidebar is docked on wide viewports (>= 900px) just like qa-flow-map.mjs
  if (vp.width >= 900) {
    const sidebarOpen = await page.eval(`(() => {
      const shell = document.querySelector('.sh-shell');
      return !!shell && shell.getAttribute('data-side') === 'open' && !matchMedia('(max-width: 899px)').matches;
    })()`);
    if (!sidebarOpen) {
      const hasOpenBtn = await page.eval(`!!document.querySelector('.sh-topen')`);
      if (hasOpenBtn) {
        await page.eval(`document.querySelector('.sh-topen').click()`);
        await waitFor(page, `document.querySelector('.sh-shell')?.getAttribute('data-side') === 'open'`, 'docked sidebar');
        await settle(page);
      }
    }
  }

  await ensureAllFourSurfacesActive(page);

  const metrics = await page.eval(`(() => {
    const round2 = (n) => Math.round(Number(n) * 100) / 100;
    const detailEl = document.querySelector('.pf-detail') || document.querySelector('[data-flow="detail"]');
    const rolesEl = document.querySelector('.pf-roles') || document.querySelector('[data-flow="roles"]');
    if (!detailEl || !rolesEl) {
      throw new Error('missing .pf-detail or .pf-roles');
    }
    const detailRect = detailEl.getBoundingClientRect();
    const rolesRect = rolesEl.getBoundingClientRect();
    const detailCs = getComputedStyle(detailEl);
    const rolesCs = getComputedStyle(rolesEl);

    // Role group grid container: in v3 todo 14 this may be a dedicated grid wrapper or .pf-roles itself.
    // Check for any explicit group grid container inside .pf-roles first, else .pf-roles.
    const groupGridEl = rolesEl.querySelector('.pf-groups:not([hidden]), [data-pf-groups]') || rolesEl;
    const groupGridCs = getComputedStyle(groupGridEl);
    const rawGridTemplateColumns = groupGridCs.gridTemplateColumns || '';
    const groups = [...rolesEl.querySelectorAll('.pf-group')].filter((group) => {
      const rect = group.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const nonFullGroups = groups.filter((g) => {
      const sec = g.getAttribute('data-flow-sec') || '';
      return !sec.startsWith('primary') && !g.querySelector('[aria-expanded="true"]');
    });
    // Measure both CSS grid-template-columns track count and actual rendered x-column positions of purpose groups
    const splitCols = rawGridTemplateColumns && rawGridTemplateColumns !== 'none'
      ? rawGridTemplateColumns.trim().split(/\\s+(?![^()]*\\))/).filter(Boolean).length
      : 1;
    const distinctGroupLefts = new Set(
      (nonFullGroups.length ? nonFullGroups : groups)
        .map((g) => Math.round(g.getBoundingClientRect().left))
    );
    const visualGroupColumns = Math.max(1, distinctGroupLefts.size);
    const computedGroupGridColumnCount = Math.max(splitCols, visualGroupColumns);

    // Role rows: support both baseline (.pf-route, .pf-mem-row) and v3 compact (.pf-row-sum / .pf-route)
    const allRouteRows = [...rolesEl.querySelectorAll('.pf-route')];
    const allSummaryBtns = [...rolesEl.querySelectorAll('.pf-row-sum')];
    const visibleRouteRows = allRouteRows.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    });
    // Closed role row height: if .pf-row-sum exists (compact rows), measure a closed row (.pf-route without [open]/expanded, or .pf-row-sum[aria-expanded="false"]);
    // in baseline (d282b3b) where rows have no expand toggle, measure the first .pf-route height (and also its .pf-route-id header height).
    const closedCompactRow = visibleRouteRows.find((el) => {
      const btn = el.querySelector('.pf-row-sum[aria-expanded="false"]');
      return !!btn;
    });
    const firstRouteEl = closedCompactRow || visibleRouteRows[0];
    if (!firstRouteEl) throw new Error('no visible .pf-route elements found');
    const closedRoleRowHeight = round2(firstRouteEl.getBoundingClientRect().height);
    const routeLabelLineEl = firstRouteEl.querySelector('.pf-route-id, .pf-row-sum');
    const routeLabelLineHeight = routeLabelLineEl ? round2(routeLabelLineEl.getBoundingClientRect().height) : closedRoleRowHeight;

    // Count how many role rows are currently within the visible scrollport of .pf-roles
    const rolesTop = rolesRect.top;
    const rolesBottom = rolesRect.bottom;
    const rowsInScrollport = visibleRouteRows.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > rolesTop + 1 && r.top < rolesBottom - 1;
    }).length;

    // DOM order of the 4 surfaces and of sections
    const guideDlgEl = document.querySelector('#pf-guide-dlg');
    const guideSecEl = document.querySelector('#pf-sec-guide');
    const guideBtnEl = document.querySelector('[data-pf="guide-open"]');
    const previewEl = document.querySelector('[data-pf-preview]');
    const pendingEl = document.querySelector('.pf-pending');
    const trayEl = document.querySelector('#pf-sec-tray');

    const cmpDom = (a, b) => {
      if (!a || !b || a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };

    // For surface DOM order:
    // 1. role rows (#pf-sec-routing / .pf-roles)
    // 2. guide (#pf-sec-guide inside #pf-guide-dlg, or the guide section)
    // 3. preview ([data-pf-preview] inside #pf-sec-tray)
    // 4. pending (.pf-pending inside #pf-sec-tray)
    const surfaceNodes = [
      { id: 'role rows', selector: '#pf-sec-routing', present: !!rolesEl, el: rolesEl },
      { id: 'guide', selector: '#pf-sec-guide', present: !!(guideSecEl || guideDlgEl), el: guideSecEl || guideDlgEl },
      { id: 'preview', selector: '[data-pf-preview]', present: !!previewEl, el: previewEl },
      { id: 'pending', selector: '.pf-pending', present: !!pendingEl, el: pendingEl },
    ];
    const sortedSurfaceNodes = surfaceNodes.slice().filter((s) => s.el).sort((a, b) => cmpDom(a.el, b.el));
    const domSurfaceOrder = sortedSurfaceNodes.map((s) => s.id);

    // Also record the order inside the detail -> tray flow specifically:
    // role rows (.pf-roles) -> guide trigger/dialog -> pending (.pf-pending) -> preview ([data-pf-preview])
    // and the roles within each of the 4 surfaces!
    const roleRowsOrder = allRouteRows.map((el) => el.getAttribute('data-pf-route')).filter(Boolean);
    const deepOrderInRoleRows = roleRowsOrder
      .filter((r) => r && r.startsWith('categories/'))
      .map((r) => r.slice('categories/'.length))
      .filter((r) => ['deep-low', 'deep-high', 'ultrabrain'].includes(r));

    const guideTableRows = [...document.querySelectorAll('#pf-guide-dlg .pf-rec tbody tr')].map((tr) => {
      const tds = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
      return { label: tds[0] || '', current: tds[1] || '', official: tds[2] || '', status: tds[3] || '' };
    });
    const deepOrderInGuide = guideTableRows
      .map((r) => r.label)
      .filter((l) => ['심층 추론(저)', '심층 추론(고)', '초고난도', 'Deep low', 'Deep high', 'Ultrabrain', 'deep-low', 'deep-high', 'ultrabrain'].includes(l));

    const previewDiffPaths = [...document.querySelectorAll('[data-pf-preview] .pf-diff-path')].map((el) => el.textContent.trim());
    const deepOrderInPreview = previewDiffPaths.filter((p) => /deep-low|deep-high|ultrabrain/.test(p));

    const pendingItemsText = [...document.querySelectorAll('.pf-pending .pf-pending-t')].map((el) => el.textContent.trim());
    const deepOrderInPending = pendingItemsText.filter((t) => /deep-low|deep-high|ultrabrain/.test(t));

    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: round2(devicePixelRatio) },
      detailPaneWidth: round2(detailRect.width),
      detailPaneClientWidth: detailEl.clientWidth,
      detailPaneHeight: round2(detailRect.height),
      rolesContainerWidth: round2(rolesRect.width),
      rolesContainerClientWidth: rolesEl.clientWidth,
      rolesContainerContentWidth: round2(
        rolesEl.clientWidth - parseFloat(rolesCs.paddingLeft || '0') - parseFloat(rolesCs.paddingRight || '0')
      ),
      rolesContainerHeight: round2(rolesRect.height),
      roleGroupGridColumns: computedGroupGridColumnCount,
      roleGroupGridCssColumns: splitCols,
      roleGroupVisualColumns: visualGroupColumns,
      roleGroupGridTemplateColumns: rawGridTemplateColumns,
      closedRoleRowHeight,
      roleRowLabelLineHeight: routeLabelLineHeight,
      visibleRoleRowCount: visibleRouteRows.length,
      roleRowsInScrollportCount: rowsInScrollport,
      memoryRowCount: rolesEl.querySelectorAll('.pf-mem-row').length,
      routingTabs: [...rolesEl.querySelectorAll('[role="tab"]')].map((tab) => {
        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        const count = Number(tab.querySelector('.pf-count')?.textContent);
        const renderedRows = panel ? panel.querySelectorAll('.pf-row-sum').length : 0;
        if (count !== renderedRows) throw new Error('tab count differs from rendered rows: ' + tab.dataset.tab);
        return { id: tab.dataset.tab, name: tab.textContent.replace(/\\s+\\d+\\s*$/, '').trim(), count, renderedRows };
      }),
      domOrder: {
        actualDomOrder: domSurfaceOrder,
        targetSpecOrder: ['role rows', 'guide', 'preview', 'pending'],
        matchesTargetSpecOrder: JSON.stringify(domSurfaceOrder) === JSON.stringify(['role rows', 'guide', 'preview', 'pending']),
        notes: 'In d282b3b baseline, #pf-guide-dlg is rendered right after .pf-status before .pf-panes, and inside #pf-sec-tray .pf-pending precedes [data-pf-preview].',
      },
      fourSurfacesRoleOrder: {
        roleRows: {
          allRoutes: roleRowsOrder,
          reasoningGroupOrder: deepOrderInRoleRows,
          matchesPurposeOrder: JSON.stringify(deepOrderInRoleRows) === JSON.stringify(['deep-low', 'deep-high', 'ultrabrain']),
        },
        guide: {
          rowCount: guideTableRows.length,
          reasoningLabelsOrder: deepOrderInGuide,
          rows: guideTableRows,
        },
        preview: {
          diffPaths: previewDiffPaths,
          deepDiffPaths: deepOrderInPreview,
        },
        pending: {
          items: pendingItemsText,
          deepItems: deepOrderInPending,
        },
      },
    };
  })()`);

  // Assert finite numbers > 0 for every claimed measurement
  for (const key of [
    'detailPaneWidth',
    'detailPaneClientWidth',
    'rolesContainerWidth',
    'rolesContainerClientWidth',
    'rolesContainerContentWidth',
    'roleGroupGridColumns',
    'closedRoleRowHeight',
    'visibleRoleRowCount',
  ]) {
    const val = metrics[key];
    assert.equal(typeof val, 'number', `${vp.name} ${key} must be a number, got ${typeof val}`);
    assert.ok(Number.isFinite(val) && val > 0, `${vp.name} ${key} must be a finite number > 0, got ${val}`);
  }

  return metrics;
}

async function extractDomNamingAndReviewers(page, serveRoot, modules, liveFacts) {
  const {
    PROFILE_META,
    ROLE_DISPLAY_NAMES,
    ROLE_INVENTORY,
    ROUTING_GROUPS,
    BUILTIN_ROLE_CATEGORIES,
  } = modules;

  const domData = await page.eval(`(() => {
    const view = window.BriefPage?.state?.ui?.profilesState?.view || null;
    const routes = {};
    for (const el of document.querySelectorAll('.pf-route')) {
      const key = el.getAttribute('data-pf-route');
      const tagText = el.querySelector('.pf-route-id .pf-tag')?.textContent?.trim() || '';
      const koText = el.querySelector('.pf-route-ko')?.textContent?.trim() || '';
      const enText = el.querySelector('.pf-route-en')?.textContent?.trim() || '';
      const chips = [...el.querySelectorAll('.pf-route-id .pf-chip')].map((c) => ({
        text: c.textContent.trim(),
        className: c.className,
        title: c.getAttribute('title') || '',
      }));
      const officialSpan = el.querySelector('.pf-rec-off')?.textContent?.trim() || '';
      const providerSel = el.querySelector('[data-pf="route-provider"]');
      const modelSel = el.querySelector('[data-pf="route-model"]');
      const thinkingSel = el.querySelector('[data-pf="route-thinking"]');
      const roVal = el.querySelector('.pf-ro-val')?.textContent?.trim() || '';
      routes[key] = {
        routeKey: key,
        tagText,
        renderedLabelKo: koText,
        renderedLabelEn: enText,
        chips,
        officialText: officialSpan,
        selectedProvider: providerSel ? providerSel.value : null,
        selectedProviderText: providerSel && providerSel.selectedOptions[0] ? providerSel.selectedOptions[0].textContent.trim() : null,
        selectedModel: modelSel ? modelSel.value : null,
        selectedModelText: modelSel && modelSel.selectedOptions[0] ? modelSel.selectedOptions[0].textContent.trim() : null,
        selectedThinking: thinkingSel ? thinkingSel.value : null,
        selectedThinkingText: thinkingSel && thinkingSel.selectedOptions[0] ? thinkingSel.selectedOptions[0].textContent.trim() : null,
        readOnlyText: roVal || null,
      };
    }

    const guideRows = [...document.querySelectorAll('#pf-guide-dlg .pf-rec tbody tr')].map((tr) => {
      const cell = field => tr.querySelector('[data-guide-field="' + field + '"] > div');
      const chipEl = cell('STATUS')?.querySelector('.pf-chip');
      return {
        roleLabel: tr.querySelector('[data-guide-name]')?.textContent?.trim() || '',
        currentModelText: cell('CURRENT')?.textContent?.trim() || '',
        officialText: cell('RECOMMENDED')?.textContent?.trim() || '',
        statusChipText: chipEl?.textContent?.trim() || '',
        statusChipClass: chipEl?.className || '',
      };
    });

    const profileCards = [...document.querySelectorAll('.pf-card')].map((card) => {
      const btn = card.querySelector('[data-profile]');
      return {
        profileKey: btn?.getAttribute('data-profile') || '',
        numText: card.querySelector('.pf-card-num')?.textContent?.trim() || '',
        nameRendered: card.querySelector('.pf-card-name')?.textContent?.trim() || '',
        enRendered: card.querySelector('.pf-card-en')?.textContent?.trim() || '',
        enDisplayCss: card.querySelector('.pf-card-en') ? getComputedStyle(card.querySelector('.pf-card-en')).display : null,
        tagRendered: card.querySelector('.pf-card-tag')?.textContent?.trim() || '',
        summaryRendered: card.querySelector('.pf-card-sum')?.textContent?.trim() || '',
        mainRendered: card.querySelector('.pf-card-main')?.textContent?.trim() || '',
        serviceRendered: card.querySelector('.pf-card-svc')?.textContent?.trim() || '',
        activeChipRendered: card.querySelector('.pf-current')?.textContent?.trim() || null,
      };
    });

    const groupHeaders = [...document.querySelectorAll('.pf-roles .pf-group')].map((g) => ({
      flowSec: g.getAttribute('data-flow-sec') || '',
      headingText: g.querySelector('.pf-group-h')?.childNodes[0]?.textContent?.trim() || g.querySelector('.pf-group-h')?.textContent?.trim() || '',
      countText: g.querySelector('.pf-group-h .pf-count')?.textContent?.trim() || '',
      routes: [...g.querySelectorAll('.pf-route')].map((r) => r.getAttribute('data-pf-route')),
    }));

    const sectionHeaders = [...document.querySelectorAll('.pf-roles > .pf-rh')].map((h) => h.textContent.trim());

    const agentRows = [...document.querySelectorAll('.pf-agent')].map((a) => ({
      agentId: a.getAttribute('data-pf-agent') || '',
      nameRendered: a.querySelector('.pf-agent-n')?.textContent?.trim() || '',
      revRendered: a.querySelector('.pf-agent-k')?.textContent?.trim() || '',
      laneSelected: a.querySelector('[data-pf="agent-lane"]')?.value || null,
      laneOptions: [...a.querySelectorAll('[data-pf="agent-lane"] option')].map((o) => ({ value: o.value, text: o.textContent.trim() })),
      pinSelected: a.querySelector('[data-pf="agent-pin"]')?.value || null,
      pinThinkingSelected: a.querySelector('[data-pf="agent-pin-thinking"]')?.value || null,
      memoryRendered: a.querySelector('.pf-mem')?.textContent?.trim() || '',
    }));

    const laneControl = {
      selected: document.querySelector('[data-pf="lane-select"]')?.value ?? null,
      options: [...document.querySelectorAll('[data-pf="lane-select"] option')].map((o) => ({ value: o.value, text: o.textContent.trim() })),
      recommendationNote: document.querySelector('.pf-lane-rec')?.textContent?.trim() || '',
    };

    const statusStrip = {
      caption: document.querySelector('.pf-status-c')?.textContent?.trim() || '',
      activeProfileValue: document.querySelector('.pf-status-v')?.textContent?.trim() || '',
      activeBadge: document.querySelector('.pf-status-m .pf-chip')?.textContent?.trim() || '',
      guideButtonText: document.querySelector('[data-pf="guide-open"]')?.textContent?.trim() || '',
    };

    const previewItems = [...document.querySelectorAll('[data-pf-preview] .pf-diff li')].map((li) => ({
      path: li.querySelector('.pf-diff-path')?.textContent?.trim() || '',
      before: li.querySelector('.pf-diff-b')?.textContent?.trim() || '',
      after: li.querySelector('.pf-diff-a')?.textContent?.trim() || '',
    }));

    const pendingItems = [...document.querySelectorAll('.pf-pending li .pf-pending-t')].map((el) => el.textContent.trim());

    return {
      viewRoutingRows: view?.routing?.rows || [],
      viewActiveProfile: view?.activeProfile || null,
      viewModelProfile: view?.modelProfile || null,
      routes,
      guideRows,
      profileCards,
      groupHeaders,
      sectionHeaders,
      agentRows,
      laneControl,
      statusStrip,
      previewItems,
      pendingItems,
    };
  })()`);

  // Build reviewer roles map across both fixture and live, across all 4 surfaces (role rows, guide, preview, pending)
  const goldenOmoPath = 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files/primary/omo.jsonc.json';
  const inventoryJsonPath = 'src/profiles/inventory.json';
  const modelMjsPath = 'src/profiles/model.mjs';
  const viewsJsPath = 'src/page/profiles-view.js';
  const manifestPath = LIVE_READONLY_FILES.recommendationManifest;

  const reviewerRolesReport = {};
  for (const roleId of REVIEWER_ROLES) {
    const routeKey = `agents/${roleId}`;
    const viewRow = domData.viewRoutingRows.find((r) => r.section === 'agents' && r.role === roleId) || null;
    const domRow = domData.routes[routeKey] || null;
    const guideRow = domData.guideRows.find((g) => g.roleLabel === (ROLE_DISPLAY_NAMES[roleId]?.En || roleId) || g.roleLabel === roleId) || null;
    const previewHits = domData.previewItems.filter((p) => p.path.includes(roleId));
    const pendingHits = domData.pendingItems.filter((p) => p.includes(roleId));

    const liveRole = liveFacts.reviewerRoles[roleId] || null;
    const rec = viewRow?.recommendation || {};
    reviewerRolesReport[roleId] = {
      roleid: roleId,
      section: 'agents',
      group: viewRow?.group ?? 'review',
      lane: domData.viewModelProfile?.model_profile || liveFacts.rawKeyOrderInSelectedProfile?.model_profile || 'N/A (role routing row uses profile model_profile or category fallback; see liveSelectedProfile)',
      name: ROLE_DISPLAY_NAMES[roleId]?.Ko ?? roleId,
      labelEn: ROLE_DISPLAY_NAMES[roleId]?.En ?? roleId,
      status: rec.Status ?? 'untracked',
      statusRenderedKo: domRow?.chips?.[0]?.text ?? '추적 안 됨',
      officialRendered: domRow?.officialText || rec.Official || '공식 권장 없음',
      builtinFallbackCategories: BUILTIN_ROLE_CATEGORIES[roleId] ?? [],
      sourcePaths: {
        inventoryJson: `${inventoryJsonPath}#/agents`,
        roleDisplayNames: `${modelMjsPath}#ROLE_DISPLAY_NAMES.${roleId}`,
        builtinRoleCategories: `${modelMjsPath}#BUILTIN_ROLE_CATEGORIES.${roleId}`,
        fixtureOmoJsonc: `${goldenOmoPath}#/profiles/native-gpt-kimi-deepseek/[native]/agents/${roleId}`,
        liveOmoJsonc: liveRole?.sourceJsonPath ?? null,
        recommendationManifest: `${manifestPath}#/coverage[section=agents,role=${roleId}]`,
      },
      fixtureSurfaceState: {
        configuredInFixtureSeedOmoJsonc: viewRow?.config !== null && viewRow?.config !== undefined,
        currentModelInSeed: viewRow?.model ?? '(unset in apply-gpt-kimi-deepseek seed; staged in probe for preview/pending verification)',
        renderedInRoleRows: domRow ? {
          tag: domRow.tagText,
          labelKo: domRow.renderedLabelKo,
          labelEn: domRow.renderedLabelEn,
          chips: domRow.chips,
          officialText: domRow.officialText,
          shownProvider: domRow.selectedProvider,
          shownModel: domRow.selectedModel,
          shownThinking: domRow.selectedThinking,
        } : { status: 'N/A', reason: 'Role row not rendered in DOM' },
        renderedInGuide: guideRow ? {
          roleLabel: guideRow.roleLabel,
          currentModelText: guideRow.currentModelText,
          officialText: guideRow.officialText,
          statusChipText: guideRow.statusChipText,
        } : { status: 'N/A', reason: 'Role not present in guide table' },
        renderedInPreview: previewHits.length
          ? previewHits
          : { status: 'N/A', reason: 'Role has no staged diff in preview unless edited (only omo-native-gate-reviewer was staged in the fixture probe)' },
        renderedInPending: pendingHits.length
          ? pendingHits
          : { status: 'N/A', reason: 'Role has no pending item unless edited (only omo-native-gate-reviewer was staged in the fixture probe)' },
      },
      liveSelectedProfileState: liveRole ? {
        profileKey: liveFacts.activeSelection.key,
        omoProfile: liveFacts.activeSelection.omoProfile,
        sourceJsonPath: liveRole.sourceJsonPath,
        explicitAlias: liveRole.explicitAlias,
        currentModelId: liveRole.resolvedModelId,
        currentVariant: liveRole.resolvedVariant,
        effectiveAlias: liveRole.effectiveAliasWhenExplicitPresent || 'N/A (explicit alias is set on the role in live omo.jsonc, so category fallback is inactive)',
        effectiveCategory: liveRole.effectiveCategoryWhenExplicitPresent || 'N/A (explicit alias is set on the role in live omo.jsonc, so category fallback is inactive)',
        builtinCategoryTargetsIfUnset: liveRole.builtinCategoryTargets,
        manifestProvenance: liveRole.manifestCoverage?.provenance ?? 'untracked',
        manifestRecommendation: liveRole.manifestCoverage?.recommendation ?? null,
        manifestNote: liveRole.manifestCoverage?.note ?? null,
        recommendationStatus: liveRole.recommendationComparison?.Status ?? 'untracked',
        recommendationOfficial: liveRole.recommendationComparison?.Official ?? '공식 권장 없음',
        surfacesInLiveReadOnly: {
          roleRows: 'Available via store state (explicit alias sol-61-high / sol-61-fast, chip untracked / 추적 안 됨 · 공식 권장 없음)',
          guide: 'Available via store state (current alias/variant shown, official=공식 권장 없음, status=추적 안 됨)',
          preview: 'N/A — live state is inspected read-only (POST /profiles preview/apply is forbidden on live)',
          pending: 'N/A — live state is inspected read-only (staging pending edits is fixture-only)',
        },
      } : { status: 'N/A', reason: 'Live omo.jsonc not readable' },
    };
  }

  // Build full naming-map.json for todo 15 (#822 raw identity migration + F6 STATIC_COPY audit)
  const statusLabelsMap = {
    recommended: { raw: 'recommended', renderedKoAtBaseline: '권장', source: `${viewsJsPath}:63` },
    fallback: { raw: 'fallback', renderedKoAtBaseline: '차선', source: `${viewsJsPath}:63` },
    'variant-different': { raw: 'variant-different', renderedKoAtBaseline: '변형 다름', source: `${viewsJsPath}:63` },
    different: { raw: 'different', renderedKoAtBaseline: '다름', source: `${viewsJsPath}:63` },
    unresolved: { raw: 'unresolved', renderedKoAtBaseline: '미해결', source: `${viewsJsPath}:64` },
    unassigned: { raw: 'unassigned', renderedKoAtBaseline: '미지정', source: `${viewsJsPath}:64` },
    untracked: { raw: 'untracked', renderedKoAtBaseline: '추적 안 됨', source: `${viewsJsPath}:64` },
    unknown: { raw: 'unknown', renderedKoAtBaseline: '미확인', source: `${viewsJsPath}:64` },
    unset: { raw: 'unset', renderedKoAtBaseline: '미설정', source: `${viewsJsPath}:64` },
  };

  const profilesMap = PROFILE_META.map((p) => {
    const cardDom = domData.profileCards.find((c) => c.profileKey === p.key) || null;
    return {
      key: p.key,
      omoProfile: p.omoProfile,
      num: p.num,
      sourcePath: `${modelMjsPath}#PROFILE_META[key=${p.key}]`,
      originalFields: {
        key: p.key,
        omoProfile: p.omoProfile,
        name: p.name,
        nameKr: p.nameKr,
        tag: p.tag,
        summary: p.summary,
        mainProvider: p.mainProvider,
        mainModel: p.mainModel,
        mainThinking: p.mainThinking,
      },
      renderedAtBaseline: cardDom ? {
        cardTitleRendered: cardDom.nameRendered,
        cardEnRendered: cardDom.enRendered,
        cardEnHiddenAtDesktopCss: cardDom.enDisplayCss === 'none',
        tagRendered: cardDom.tagRendered,
        summaryRendered: cardDom.summaryRendered,
        mainRendered: cardDom.mainRendered,
        serviceRendered: cardDom.serviceRendered,
        activeChipRendered: cardDom.activeChipRendered,
      } : null,
      v3Rule822Target: {
        keepUntranslatedName: p.name,
        keepUntranslatedKey: p.key,
        translatedSummaryAllowed: p.summary,
      },
    };
  });

  const rolesMap = [];
  for (const section of ['agents', 'categories']) {
    for (const roleId of ROLE_INVENTORY[section]) {
      const routeKey = `${section}/${roleId}`;
      const viewRow = domData.viewRoutingRows.find((r) => r.section === section && r.role === roleId) || null;
      const domRow = domData.routes[routeKey] || null;
      const rec = viewRow?.recommendation || {};
      rolesMap.push({
        section,
        roleid: roleId,
        routeKey,
        sourcePaths: {
          inventory: `${inventoryJsonPath}#/${section}`,
          displayNames: `${modelMjsPath}#ROLE_DISPLAY_NAMES.${roleId}`,
          routingGroups: `${modelMjsPath}#ROUTING_GROUPS.${section}.groups.${viewRow?.group || 'extras'}`,
          fixtureLayer: `${goldenOmoPath}#/profiles/native-gpt-kimi-deepseek/[native]/${section}/${roleId}`,
        },
        originalFields: {
          roleid: roleId,
          section,
          group: viewRow?.group ?? null,
          groupLabel: viewRow?.groupLabel ?? null,
          nameKo: ROLE_DISPLAY_NAMES[roleId]?.Ko ?? roleId,
          labelEn: ROLE_DISPLAY_NAMES[roleId]?.En ?? roleId,
          modelAlias: viewRow?.model ?? null,
          reasoning: viewRow?.reasoning ?? null,
          status: rec.Status ?? 'unset',
          official: rec.Official ?? '공식 권장 없음',
        },
        renderedAtBaseline: domRow ? {
          tagText: domRow.tagText,
          renderedLabelKo: domRow.renderedLabelKo,
          renderedLabelEn: domRow.renderedLabelEn,
          chips: domRow.chips,
          officialText: domRow.officialText,
          selectedProvider: domRow.selectedProvider,
          selectedModel: domRow.selectedModel,
          selectedThinking: domRow.selectedThinking,
        } : null,
      });
    }
  }

  return {
    reviewerRolesReport,
    namingMap: {
      schema: 'qa-profiles-v3-naming-map/1',
      mode: IS_FINAL ? 'final' : 'baseline',
      baselineRef: IS_FINAL ? null : BASELINE_REF,
      generatedAt: new Date().toISOString(),
      rule822Summary: 'Profile names, role names/identifiers, lanes, and status badges stay in their original untranslated strings; only model/profile descriptions may be translated to Korean.',
      sources: {
        modelMjs: modelMjsPath,
        inventoryJson: inventoryJsonPath,
        profilesViewJs: viewsJsPath,
        qaFlowMapMjs: 'scripts/qa-flow-map.mjs',
        fixtureOmoJsonc: goldenOmoPath,
        liveOmoJsonc: LIVE_READONLY_FILES.stableOmo,
        recommendationManifest: LIVE_READONLY_FILES.recommendationManifest,
      },
      profiles: profilesMap,
      roles: rolesMap,
      reviewerRoles: reviewerRolesReport,
      primaryAgents: domData.agentRows.map((a) => ({
        agentId: a.agentId,
        sourcePath: 'src/profiles/refresh.mjs#AGENT_DISPLAY',
        originalFields: {
          agentId: a.agentId,
          displayName: a.nameRendered,
          lane: a.laneSelected,
          laneOptions: a.laneOptions.map((o) => o.value),
        },
        renderedAtBaseline: a,
      })),
      lanes: {
        sourcePath: 'src/profiles/contract/constants.mjs#LANES',
        rawValues: ['daily-normal', 'daily-heavy', 'geeky-normal', 'geeky-heavy'],
        modelProfileControlAtBaseline: domData.laneControl,
      },
      statuses: statusLabelsMap,
      sectionAndGroupHeadingsAtBaseline: {
        sectionHeaders: domData.sectionHeaders,
        groupHeaders: domData.groupHeaders,
        statusStrip: domData.statusStrip,
      },
      f6StaticCopyAudit: {
        sourcePath: 'scripts/qa-flow-map.mjs:48-53',
        staticCopyAtBaseline: [
          '현재 전역 적용', '전역 적용 중', '권장 배치 가이드', '적용 중', '적용', '메인: ', '서비스: ',
          '모델 라우팅 · 전담 에이전트 / 작업 카테고리', '공통 설정 · Kibitzer 회상', '공통 설정 · Reflection 성찰', '전담 에이전트 · Agents',
          '탐색 · 자료 조사', '계획 · 조언', '검토 · QA', '작업 카테고리 · Categories', '빠른 작업 · 일반 작업', '심층 추론', '전문 작업',
          '메인 모델 설정', '요약 담당 모델', '이 프로필 적용하기', '1. 구독 서비스', '2. AI 모델', '3. 추론 강도',
          '공통 / 전체 · Kibitzer 회상', '공통 / 전체 · Reflection 성찰', 'quick 공유 (기본)', '직접 선택', '현재: ', '보류: ',
          '1. 제공사', '원본 기본 컴팩션',
        ],
        conditionalCopyAtBaseline: ['추가 설정', '실패 · 보류 유지: '],
        migrationCandidatesForTodo15: [
          {
            category: 'section_and_group_headings',
            baselineStrings: [
              '전담 에이전트 · Agents',
              '탐색 · 자료 조사',
              '계획 · 조언',
              '검토 · QA',
              '작업 카테고리 · Categories',
              '빠른 작업 · 일반 작업',
              '심층 추론',
              '전문 작업',
            ],
            reason: '#822 + D10/D12: routing tabs (Primary / Agents / Categories / Memory) and purpose group headers migrate to raw English/original inventory names where applicable.',
          },
          {
            category: 'status_badges_and_profile_names',
            baselineStrings: Object.values(statusLabelsMap).map((s) => s.renderedKoAtBaseline),
            reason: '#822: status badges (recommended, fallback, variant-different, different, unresolved, unassigned, untracked, unknown, unset) and profile/role names keep raw original strings.',
          },
          {
            category: 'preserved_controls_and_captions',
            baselineStrings: [
              '1. 구독 서비스', '2. AI 모델', '3. 추론 강도',
              '1. 제공사', '원본 기본 컴팩션', '이 프로필 적용하기',
            ],
            reason: 'D12: control captions, select order, step counts, and equal-width checks in F6 remain preserved.',
          },
        ],
      },
    },
  };
}

// Capture-only extension of the existing fixture/CDP harness. Measurements are data, never review verdicts.
async function captureReviewEvidence(page, { url, homes, pluginInfo, commitSha, commandLog }) {
  const onlyWidth = Number(arg('--review-width', '0'));
  const supplement = argv.includes('--review-supplement');
  const measureOnly = argv.includes('--review-measure-only');
  const viewports = [
    { width: 1440, height: 900 }, { width: 1000, height: 700 }, { width: 900, height: 600 },
    { width: 1600, height: 900 }, { width: 390, height: 844 }, { width: 1024, height: 768 },
  ].filter(v => !onlyWidth || v.width === onlyWidth);
  const previous = (onlyWidth || measureOnly) && fs.existsSync(path.join(OUT, 'layout.json'));
  const previousContrastFailures = measureOnly ? readJson(path.join(OUT, 'contrast.json')).failures : [];
  const layout = previous ? readJson(path.join(OUT, 'layout.json')) : { schema: 'profiles-v3-review-capture/1', generatedAt: new Date().toISOString(),
    commit: commitSha, plugin: pluginInfo, viewports: {}, captures: [], guide: {}, focusReturn: {}, failures: [] };
  const ax = previous && !measureOnly ? readJson(path.join(OUT, 'ax-tree.json')) : { snapshots: [], unnamed: [] };
  const contrast = previous && !measureOnly ? readJson(path.join(OUT, 'contrast.json')) : { method: 'Computed sRGB colours with backgrounds resolved from the nearest non-transparent surface, alpha-composited over ancestor surfaces. WCAG relative luminance. Inputs/selects/toggles and icon-only buttons use the identifying boundary or icon at 3:1. Text-labelled buttons use text contrast at 4.5:1 (3:1 large text); their decorative border/fill is not required to contrast. Disabled controls remain measured.',
    thresholds: { text: 4.5, largeText: 3, controlBoundary: 3 }, snapshots: [], failures: [] };
  if (measureOnly) {
    const rejected = path.join(OUT, 'superseded-measurement-' + Date.now());
    fs.mkdirSync(rejected,{recursive:true});
    for(const file of ['layout.json','contrast.json','failures.md']) fs.copyFileSync(path.join(OUT,file),path.join(rejected,file));
    layout.failures = [];
    layout.measurementRerunAt = new Date().toISOString();
    commandLog.unshift(fs.readFileSync(path.join(OUT,'commands.txt'),'utf8').trim());
  }
  if (previous && !supplement && !measureOnly) {
    const rejected = path.join(OUT, 'rejected-mobile-drawer');
    fs.mkdirSync(rejected, { recursive: true });
    for (const file of ['layout.json', 'ax-tree.json', 'contrast.json', 'failures.md', 'cleanup-receipt.json', 'commands.txt']) {
      fs.copyFileSync(path.join(OUT, file), path.join(rejected, file));
    }
    for (const vp of viewports) for (const theme of ['light', 'dark']) {
      const key = vp.width + 'x' + vp.height + '-' + theme;
      const dir = path.join(OUT, 'captures', key);
      if (fs.existsSync(dir)) fs.renameSync(dir, path.join(rejected, key));
      delete layout.viewports[key];
    }
    const keep = row => !row.state.startsWith(onlyWidth + 'x');
    layout.captures = layout.captures.filter(keep);
    layout.failures = layout.failures.filter(keep);
    ax.snapshots = ax.snapshots.filter(keep);
    ax.unnamed = ax.unnamed.filter(keep);
    contrast.snapshots = contrast.snapshots.filter(keep);
    contrast.failures = contrast.failures.filter(keep);
    commandLog.unshift(fs.readFileSync(path.join(OUT, 'commands.txt'), 'utf8').trim());
    layout.recaptureReason = '390px only: close the navigation drawer before observing the page; first-run evidence preserved in rejected-mobile-drawer.';
  }
  if (previous && supplement) commandLog.unshift(fs.readFileSync(path.join(OUT, 'commands.txt'), 'utf8').trim());
  layout.criteria = { routeSummaryReflow: '#1197 A lossless content reflow; needed height permitted; no fixed 32/56px cap',
    desktopNonRouteClosedHeight: '<=32px (desktop viewports >=600px)',
    touchClosedHeight: '>=44px (touch target at 390px, no added phone nonroute upper cap per #1202)',
    columns: 'always 1 column',
    gap: '20px (other tabs and phone Memory); 12px (Memory at viewportWidth >=900px per #1204)',
    cellOverlaps: '0 direct r/m/b/o overlaps (>1px both axes)',
    clippedCells: '0 clipped role/model/status cells', ownerContainment: 'all cells contained within summary owner',
    selectsTopmostAndMatched: 'Desktop viewports (1440/1600); narrow layouts remain measured without applying topmost.',
    correctedAt: new Date().toISOString() };
  const fail = (state, criterion, actual, expected) => layout.failures.push({ state, criterion, actual, expected });
  const save = () => {
    const classified=contrast.snapshots.flatMap(s=>s.rows.filter(r=>r.controlClass));
    contrast.classificationCounts=Object.fromEntries(['input','select','toggle','iconOnlyButton','textLabelledButton'].map(name=>{
      const rows=classified.filter(r=>r.controlClass===name);
      return [name,{evaluated:rows.length,failures:rows.filter(r=>r.ratio<r.threshold).length}];
    }));
    const rowMap=new Map(contrast.snapshots.flatMap(s=>s.rows.filter(r=>r.controlClass).map(r=>[s.state+'\0'+r.element,r])));
    contrast.previousFailureClassification=previousContrastFailures.map(old=>{
      const now=rowMap.get(old.state+'\0'+old.element);
      return {state:old.state,element:old.element,previousKind:old.kind,previousRatio:old.ratio,
        controlClass:now?.controlClass,currentKind:now?.kind,currentRatio:now?.ratio,currentThreshold:now?.threshold,
        currentFailure:now ? now.ratio<now.threshold : null};
    });
    layout.accessibility = { unnamedFocusableNodes: ax.unnamed.length, textContrastFailures: contrast.failures.filter(r=>r.kind==='text').length,
      controlIndicatorContrastFailures: contrast.failures.filter(r=>r.kind==='controlBoundary').length, snapshotCount: ax.snapshots.length,
      controlClasses:contrast.classificationCounts };
    fs.writeFileSync(path.join(OUT, 'layout.json'), JSON.stringify(layout, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT, 'ax-tree.json'), JSON.stringify(ax, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT, 'contrast.json'), JSON.stringify(contrast, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT, 'commands.txt'), commandLog.join('\n') + '\n');
    const table = [
      '| Viewport / theme | Closed height | Criterion | Columns | Horizontal scroll | Overlaps | Selects topmost (desktop 1440/1600) | Layout measurements |',
      '| --- | ---: | --- | ---: | ---: | ---: | --- | --- |',
      ...Object.entries(layout.viewports).map(([key,m]) => {
        const g=Object.values(m.grid.tabs), height=Math.max(...g.map(t=>t.maxRowHeight));
        const topmost=m.viewport.width>=1440 ? m.grid.expanded.every(r=>r.topmost.every(Boolean)) && m.primarySelects.every(s=>s.topmost) : null;
        const matching=layout.failures.filter(f=>f.state===key || f.state.startsWith(key+'/'));
        const overlaps=g.reduce((sum,t)=>sum+(Array.isArray(t.cellOverlaps)?t.cellOverlaps.length:0), 0);
        const criterion = m.touch ? 'reflow / touch >=44px' : 'reflow / desktop nonroute <=32px';
        return '| '+[key,height+'px',criterion,m.grid.tabs.agents.columns,
          Math.max(...g.map(t=>t.horizontalScroll))+'px',overlaps,topmost===null?'N/A':String(topmost),matching.length?'FAIL ('+matching.length+')':'PASS'].join(' | ')+' |';
      }),
    ];
    fs.writeFileSync(path.join(OUT, 'failures.md'), [
      '# Capture measurements (no independent review verdict)',
      'The table covers layout criteria. AX and colour failures are listed separately below; a layout PASS is not an accessibility or independent-review verdict.',
      'Control classification follows the visual information needed to identify the control. Text-labelled buttons are assessed under text contrast; they do not require a contrasting decorative border or background.',
      '| Control class | Evaluated occurrences | Failures | Rule |',
      '| --- | ---: | ---: | --- |',
      ...Object.entries(contrast.classificationCounts).map(([name,c])=>'| '+[name,c.evaluated,c.failures,name==='textLabelledButton'?'text 4.5:1; large text 3:1':'identifying boundary/icon 3:1'].join(' | ')+' |'),
      'Previous boundary hits are individually reclassified in contrast.json: previousFailureClassification.',
      ...table,
      ...layout.failures.map(f => `- ${f.state}: ${f.criterion}; actual=${JSON.stringify(f.actual)}; required=${JSON.stringify(f.expected)}`),
      ...ax.unnamed.map(f => `- ${f.state}: unnamed focusable AX control ${f.role}; backendDOMNodeId=${f.backendDOMNodeId}`),
      ...contrast.failures.map(f => `- ${f.state}: ${f.kind} ${f.element} ${JSON.stringify(f.text)}; ${f.foreground} against ${f.background}; ${f.ratio.toFixed(3)}:1 < ${f.threshold}:1`),
    ].join('\n') + '\n');
    const groups = new Map();
    for(const node of ax.unnamed) {
      const key=[node.selector,node.role,node.visibleText,node.why].join('\0');
      if(!groups.has(key)) groups.set(key,{...node,states:[]});
      groups.get(key).states.push(node.state);
    }
    const cell = value => String(value || '').replace(/\|/g,'\\|').replace(/\s+/g,' ').trim();
    fs.writeFileSync(path.join(OUT,'ax-unnamed.md'), [
      '# Unnamed focusable AX nodes',
      'These are programmatic focus targets, not buttons or selects. Their descendant text is present in the AX tree, but the focus-target node itself has no AX name. Each occurrence remains in ax-tree.json.',
      '| Selector | AX role | Visible text / icon | Why no accessible name | Occurrences |',
      '| --- | --- | --- | --- | ---: |',
      ...[...groups.values()].map(g=>'| '+[g.selector,g.role,g.visibleText+(g.icon?' / '+g.icon:''),g.why,g.states.length].map(cell).join(' | ')+' |'),
      '',
      '## Naming guidance for a fix round',
      '| Pattern | Is adding aria-label alone semantically safe? | Recommended name and action |',
      '| --- | --- | --- |',
      '| span#pf-focus-status[role=status] | Naming is permitted, but status should not receive focus just because its content changed. | Prefer a separate nameable group focus sink while keeping the existing live announcement. Use the current complete status message, e.g. `conflict: 다른 곳에서 바뀌었습니다. 새로고침 후 다시 적용하십시오.` Keep the label synchronized with the action result. |',
      '| span#pf-focus-status (implicit generic) | No: generic prohibits author-provided names. | Keep the enclosing loading status announcement. Give the programmatic focus sink an explicit nameable group role, then label it `프로필 상태를 불러오는 중…`. Do not create a second live region. |',
      '| p#pf-focus-status (implicit paragraph) | No: paragraph prohibits author-provided names. | Give this programmatic sink a nameable group role (or use a div with role=group), preserve the enclosing alert, and label it with the actual displayed error: `프로필 상태를 불러오지 못했습니다. 서버가 응답하지 않았습니다. 다시 시도해 주십시오.` |',
      '',
      'This is semantics guidance only. This capture phase did not run NVDA/JAWS or change product markup; announcement order and duplication must be checked in the fix round.',
      'References: W3C ARIA in HTML (`https://www.w3.org/TR/html-aria/`), WAI-ARIA status and group roles (`https://www.w3.org/TR/wai-aria-1.2/`), and WCAG 1.4.11 understanding (`https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast`).',
      '',
      ...[...groups.values()].flatMap(g=>['## '+g.selector+' ('+g.role+')',...g.states.map(s=>'- '+s)]),
    ].join('\n')+'\n');
  };
  const click = async selector => {
    await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing control: ' + ${JSON.stringify(selector)}); el.click(); })()`);
    await settle(page);
  };
  const tab = id => click(`[data-pf="tab"][data-tab="${id}"]`);
  const fresh = async () => {
    await page.goto(url);
    await waitFor(page, `document.querySelector('[data-sh="view"][data-key="profiles"]')`, 'profiles rail');
    if (await page.eval(`innerWidth >= 900 && document.querySelector('.sh-shell').dataset.side !== 'open'`)) {
      await click('.sh-topen');
    }
    await click('[data-sh="view"][data-key="profiles"]');
    await waitFor(page, `document.querySelector('[data-pf-root]')?.dataset.pfState === 'view'`, 'loaded profiles');
    if (await page.eval(`innerWidth <= 899 && document.querySelector('.sh-shell').dataset.side === 'open'`)) {
      await click('.sh-topen');
    }
    await settle(page);
  };
  const audit = async state => {
    const tree = await page.client.send('Accessibility.getFullAXTree');
    const controls = tree.nodes.filter(n => !n.ignored && (n.properties || []).some(p => p.name === 'focusable' && p.value?.value === true))
      .map(n => ({ nodeId: n.nodeId, backendDOMNodeId: n.backendDOMNodeId, role: n.role?.value, name: n.name?.value || '',
        disabled: (n.properties || []).find(p => p.name === 'disabled')?.value?.value || false }));
    ax.snapshots.push({ state, focusableControls: controls, tree });
    for (const node of controls.filter(n=>!n.name.trim())) {
      const resolved=await page.client.send('DOM.resolveNode',{backendNodeId:node.backendDOMNodeId});
      const detail=await page.client.send('Runtime.callFunctionOn',{objectId:resolved.object.objectId,returnByValue:true,
        functionDeclaration:`function() {
          const icon=this.querySelector('svg');
          return {selector:this.tagName.toLowerCase()+(this.id?'#'+this.id:'.'+[...this.classList].join('.')),
            visibleText:this.textContent.trim(),icon:icon?(icon.getAttribute('data-icon')||icon.querySelector('title')?.textContent||icon.getAttribute('class')):'',
            ariaLabel:this.getAttribute('aria-label'),ariaLabelledby:this.getAttribute('aria-labelledby'),title:this.getAttribute('title'),
            tabindex:this.getAttribute('tabindex'),tag:this.tagName};
        }`});
      await page.client.send('Runtime.releaseObject',{objectId:resolved.object.objectId});
      ax.unnamed.push({state,...node,...detail.result.value,
        why:'Programmatic tabindex=-1 focus target; no aria-label, aria-labelledby or title. This AX role does not derive its name from descendant text.'});
    }
    const rows = await page.eval(`(() => {
      const parse = s => { const a = (s.match(/[\\d.]+/g) || []).map(Number); return [a[0] || 0, a[1] || 0, a[2] || 0, a.length > 3 ? a[3] : 1]; };
      const over = (a,b) => { const alpha = a[3] + b[3]*(1-a[3]); return [0,1,2].map(i => alpha ? (a[i]*a[3]+b[i]*b[3]*(1-a[3]))/alpha : 0).concat(alpha); };
      const bg = el => {
        const layers=[];
        for(let n=el;n;n=n.parentElement) {
          const color=parse(getComputedStyle(n).backgroundColor);
          if(color[3]>0) layers.push(color);
          if(color[3]>=1) break;
        }
        return layers.reverse().reduce((base,color)=>over(color,base),[255,255,255,1]);
      };
      const css = a => 'rgb(' + a.slice(0,3).map(x=>Math.round(x*1000)/1000).join(', ') + ')';
      const lum = a => a.slice(0,3).map(x => { x/=255; return x<=.04045?x/12.92:((x+.055)/1.055)**2.4; }).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
      const ratio = (a,b) => (Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
      const id = el => el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.classList.length?'.'+[...el.classList].join('.'):'')+
        (el.dataset.pf?'[data-pf="'+el.dataset.pf+'"]':'')+(el.dataset.row?'[data-row="'+el.dataset.row+'"]':'');
      const visible = el => el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && el.getClientRects().length>0 && !el.closest('dialog:not([open])');
      const out=[];
      for(const el of document.querySelectorAll('body *')) {
        if(!visible(el)||['SCRIPT','STYLE','OPTION','SVG','PATH'].includes(el.tagName)) continue;
        const cs=getComputedStyle(el), back=bg(el);
        let opacity=1; for(let n=el;n;n=n.parentElement) opacity*=Number(getComputedStyle(n).opacity);
        const text=el.tagName==='SELECT' ? el.selectedOptions[0]?.textContent || '' : [...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').trim();
        if(text) {
          const fg=parse(cs.color); fg[3]*=opacity;
          const effective=over(fg,back), large=parseFloat(cs.fontSize)>=24 || (parseFloat(cs.fontSize)>=18.6667 && Number(cs.fontWeight)>=700);
          out.push({kind:'text',element:id(el),text,foreground:css(effective),sourceForeground:cs.color,background:css(back),ratio:ratio(effective,back),threshold:large?3:4.5,fontSize:cs.fontSize,fontWeight:cs.fontWeight,opacity});
        }
        if(el.matches('button,select,input,textarea,[role="tab"],summary')) {
          const visibleText=[...el.querySelectorAll('*')].concat(el).filter(n=>visible(n) && !n.closest('svg,[aria-hidden="true"],.sh-n,.sh-tip'))
            .flatMap(n=>[...n.childNodes].filter(c=>c.nodeType===3).map(c=>c.textContent.trim())).filter(Boolean).join(' ');
          const toggle=el.matches('[role="switch"],[role="checkbox"],[role="radio"],[aria-checked],input[type="checkbox"],input[type="radio"]') ||
            (el.hasAttribute('aria-pressed') && !!visibleText);
          const controlClass=toggle?'toggle':el.tagName==='SELECT'?'select':el.tagName==='INPUT'||el.tagName==='TEXTAREA'?'input':
            visibleText?'textLabelledButton':'iconOnlyButton';
          if(controlClass==='textLabelledButton') {
            const ink=parse(cs.color);ink[3]*=opacity;
            const effective=over(ink,back), large=parseFloat(cs.fontSize)>=24 || (parseFloat(cs.fontSize)>=18.6667 && Number(cs.fontWeight)>=700);
            out.push({kind:'text',controlClass,element:id(el),text:visibleText,foreground:css(effective),sourceForeground:cs.color,
              background:css(back),ratio:ratio(effective,back),threshold:large?3:4.5,fontSize:cs.fontSize,fontWeight:cs.fontWeight,
              indicator:'visible label',borderWidth:cs.borderTopWidth,disabled:el.disabled||false,opacity});
            continue;
          }
          const outside=bg(el.parentElement), edge=parse(cs.borderTopColor);
          const paintedBorder=parseFloat(cs.borderTopWidth)>0 && cs.borderTopStyle!=='none' && edge[3]>0;
          edge[3]*=opacity;
          const effective=over(edge,back), edgeRatio=paintedBorder?ratio(effective,outside):0, fillRatio=ratio(back,outside);
          let foreground=effective, background=outside, measuredRatio=Math.max(edgeRatio,fillRatio), indicator='border/fill', source=cs.borderTopColor;
          if(!paintedBorder) {
            const icon=el.querySelector('svg');
            const ic=icon && getComputedStyle(icon);
            const iconColor=ic && ic.stroke!=='none' ? ic.stroke : ic ? ic.color : cs.color;
            const ink=parse(iconColor);ink[3]*=opacity;
            foreground=over(ink,back);background=back;measuredRatio=ratio(foreground,back);
            indicator=icon?'icon':'text';source=iconColor;
          } else if(fillRatio>edgeRatio) { foreground=back;source=cs.backgroundColor; }
          out.push({kind:'controlBoundary',controlClass,element:id(el),text:el.getAttribute('aria-label')||el.textContent.trim().slice(0,100),
            foreground:css(foreground),sourceForeground:source,background:css(background),ratio:measuredRatio,threshold:3,
            iconColour:el.querySelector('svg')?getComputedStyle(el.querySelector('svg')).color:null,
            indicator,paintedBorder,borderWidth:cs.borderTopWidth,disabled:el.disabled||false,opacity});
        }
      }
      return out;
    })()`);
    contrast.snapshots.push({ state, rows });
    contrast.failures.push(...rows.filter(r => r.ratio < r.threshold).map(r => ({ state, ...r })));
  };
  let currentDir = '';
  const shot = async (state, inspect = true) => {
    await settle(page);
    const file = path.join(currentDir, state + '.png');
    if (!measureOnly) await page.screenshot(file);
    const key = path.basename(currentDir) + '/' + state;
    if (supplement) {
      layout.captures = layout.captures.filter(r=>r.state!==key);
      ax.snapshots = ax.snapshots.filter(r=>r.state!==key);
      ax.unnamed = ax.unnamed.filter(r=>r.state!==key);
      contrast.snapshots = contrast.snapshots.filter(r=>r.state!==key);
      contrast.failures = contrast.failures.filter(r=>r.state!==key);
    }
    if (!measureOnly) layout.captures.push({ state: key, file: path.relative(OUT, file).replace(/\\/g, '/') });
    if (inspect) await audit(key);
  };
  try {
    for (const vp of viewports) for (const theme of ['light', 'dark']) {
      const key = vp.width + 'x' + vp.height + '-' + theme;
      currentDir = path.join(OUT, 'captures', key);
      await page.client.send('Emulation.setDeviceMetricsOverride', { ...vp, deviceScaleFactor: 1, mobile: false });
      await page.client.send('Emulation.setTouchEmulationEnabled', { enabled: vp.width === 390 });
      await page.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await fresh();
      if (supplement) {
        const rejected=path.join(OUT,'rejected-mobile-framing',key);
        fs.mkdirSync(rejected,{recursive:true});
        for(const name of ['primary-all-four','agents-purpose-groups','categories-purpose-groups','empty-search-result','guide-closed-focus-return']) {
          const file=path.join(currentDir,name+'.png');
          if(fs.existsSync(file)) fs.copyFileSync(file,path.join(rejected,name+'.png'));
        }
        fs.copyFileSync(path.join(currentDir,'primary-all-four.png'),path.join(currentDir,'overview.png'));
        layout.captures.push({state:key+'/overview',file:'captures/'+key+'/overview.png'});
        for(const [id,name] of [['primary','primary-all-four'],['agents','agents-purpose-groups'],['categories','categories-purpose-groups']]) {
          await tab(id);
          await page.eval(`document.querySelector('.pf-roles').scrollIntoView({block:'start'})`);
          await shot(name);
        }
        await page.eval(`(() => {const q=document.querySelector('#pf-routing-search');q.value='__no_such_role_model_179389__';q.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.pf-roles').scrollIntoView({block:'center'});})()`);
        await shot('empty-search-result');
        await page.eval(`(() => {const q=document.querySelector('#pf-routing-search');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await click('[data-pf="guide-open"]');
        await click('[data-pf="guide-close"]');
        await page.eval(`document.querySelector('[data-pf="guide-open"]').scrollIntoView({block:'center'})`);
        await shot('guide-closed-focus-return');
        layout.focusReturn[key]=await page.eval(`({returned:document.activeElement===document.querySelector('[data-pf="guide-open"]'),active:document.activeElement.outerHTML})`);
        save();
        console.log('SUPPLEMENTED '+key);
        continue;
      }
      await tab('primary');
      await shot('primary-all-four');
      const grid = await measurePurposeGrid(page, { boundary: vp.width === 1440 });
      const m = { viewport: vp, theme, touch: vp.width === 390, grid };
      layout.viewports[key] = m;
      for (const [id, g] of Object.entries(grid.tabs)) {
        const expected = 1;
        if (g.columns !== expected) fail(key + '/' + id, 'role group columns', g.columns, expected);
        if (g.horizontalScroll > 0) fail(key + '/' + id, 'horizontal scroll px', g.horizontalScroll, 0);
        // Under #1204: Memory gap 12px at viewportWidth >= 900px; other tabs and phone Memory remain 20px.
        const expectedGap = (id === 'memory' && vp.width >= 900) ? 12 : 20;
        if (g.gap !== undefined && g.gap !== expectedGap) {
          fail(key + '/' + id, 'group gap px', g.gap, expectedGap);
        }
        // Under #1197 A: route total maxRowHeight is positive finite and may grow as needed for lossless reflow.
        if (!Number.isFinite(g.maxRowHeight) || g.maxRowHeight <= 0) {
          fail(key + '/' + id, 'maxRowHeight positive finite number', typeof g.maxRowHeight, 'positive finite number');
        }
        // Under #1202 A: maxNonRouteRowHeight is finite >= 0 for every tab; desktop viewports (>=600px, e.g. 900/1000/1440/1600)
        // enforce original <=32px based on actual viewport; phone viewports (<600px / 390px) have no added nonroute upper cap and enforce minimum 44px touch targets.
        if (!Number.isFinite(g.maxNonRouteRowHeight) || g.maxNonRouteRowHeight < 0) {
          fail(key + '/' + id, 'maxNonRouteRowHeight finite number >= 0', typeof g.maxNonRouteRowHeight, 'finite number >= 0');
        } else if (vp.width >= 600) {
          if (g.maxNonRouteRowHeight > 32) {
            fail(key + '/' + id, 'desktop nonroute summary height px', g.maxNonRouteRowHeight, '<=32');
          }
        }
        if (vp.width === 390 && g.maxRowHeight < 44) {
          fail(key + '/' + id, 'closed summary touch height px', g.maxRowHeight, '>=44');
        }
        if (!Array.isArray(g.clippedCells)) {
          fail(key + '/' + id, 'clippedCells measurement array', typeof g.clippedCells, 'Array');
        } else if (g.clippedCells.length > 0) {
          fail(key + '/' + id, 'clipped role/model/status cells', g.clippedCells.length, 0);
        }
        if (!Array.isArray(g.cellOverlaps)) {
          fail(key + '/' + id, 'cellOverlaps measurement array', typeof g.cellOverlaps, 'Array');
        } else if (g.cellOverlaps.length > 0) {
          fail(key + '/' + id, 'direct r/m/b/o cell overlaps', g.cellOverlaps.length, 0);
        }
        if (!Array.isArray(g.ownerEscapes)) {
          fail(key + '/' + id, 'ownerEscapes measurement array', typeof g.ownerEscapes, 'Array');
        } else if (g.ownerEscapes.length > 0) {
          fail(key + '/' + id, 'cell summary owner containment escapes', g.ownerEscapes.length, 0);
        }
      }
      for (const e of grid.expanded) {
        if (vp.width >= 1440 && (e.widths.length !== 3 || Math.min(...e.widths) <= 0 || Math.max(...e.widths)-Math.min(...e.widths)>1)) fail(key+'/'+e.row,'three equal select widths',e.widths,'three positive widths within 1px');
        if (vp.width >= 1440 && e.topmost.some(v=>!v)) fail(key+'/'+e.row,'three selects topmost',e.topmost,[true,true,true]);
      }
      for (const b of grid.boundaries) if (b.columns !== 1) fail(key,'612/611 container boundary',b,'both 611 and 612 = 1 column');
      await tab('agents');
      await shot('agents-purpose-groups');
      await tab('categories');
      await shot('categories-purpose-groups');
      await tab('primary');
      m.summaryAndTouchTargets = await page.eval(`(() => {
        const roles = document.querySelector('.pf-roles');
        const rolesWidth = roles ? roles.clientWidth : 0;
        const nodes=[...document.querySelectorAll('.pf-row-sum')].filter(n=>n.checkVisibility());
        const summary=nodes.map(n=>{
          const parent = n.matches('.pf-route[data-pf-route] > .pf-row-sum') ? n.parentElement : n;
          return {
            row:n.dataset.row,
            height:parent.getBoundingClientRect().height,
            contentHeight:Math.max(...[...n.children].map(c=>c.getBoundingClientRect().height)),
            rolesWidth
          };
        });
        const targets=[...document.querySelectorAll('[data-pf-root] button,[data-pf-root] select,[data-pf-root] input')].filter(n=>n.checkVisibility()).map(n=>({
          element:n.id||n.dataset.row||n.dataset.pf||n.tagName,height:n.getBoundingClientRect().height,disabled:n.disabled}));
        return {summary,targets};
      })()`);
      for (const r of m.summaryAndTouchTargets.summary) {
        const isRoute = r.row && r.row.startsWith('route:');
        if (!isRoute && vp.width >= 600) {
          if (r.height > 32) fail(key+'/'+r.row,'closed summary parent height px',r.height,'<=32');
          if (r.contentHeight > 32) fail(key+'/'+r.row,'closed summary content height px',r.contentHeight,'<=32');
        }
      }
      if (vp.width === 390) for (const t of m.summaryAndTouchTargets.targets) if(t.height<44) fail(key+'/'+t.element,'touch target height px',t.height,'>=44');
      await click('[data-row="agent:sisyphus"]');
      await page.eval(`document.querySelector('[data-row="agent:sisyphus"]').parentElement.querySelector('select').scrollIntoView({block:'center'})`);
      await shot('primary-expanded-three-selects');
      m.primarySelects = await page.eval(`(() => {
        const selects=[...document.querySelector('[data-row="agent:sisyphus"]').parentElement.querySelectorAll('select')].slice(0,3);
        return selects.map(s=>{const r=s.getBoundingClientRect();return {name:s.labels[0]?.textContent,width:r.width,height:r.height,
          topmost:s===document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)};});
      })()`);
      if(vp.width >= 1440 && (m.primarySelects.length!==3 || m.primarySelects.some(s=>!s.topmost))) fail(key,'Primary topmost selects',m.primarySelects,'three topmost selects');
      if(vp.width >= 1440 && Math.max(...m.primarySelects.map(s=>s.width))-Math.min(...m.primarySelects.map(s=>s.width))>1) fail(key,'Primary width-matched selects',m.primarySelects,'width difference <=1px');
      if(vp.width===390) for(const s of m.primarySelects) if(s.height<44) fail(key+'/'+s.name,'expanded select touch height px',s.height,'>=44');
      await click('[data-row="agent:sisyphus"]');
      await tab('memory');
      await shot('memory-kibitzer-reflection-summary-location');
      await page.eval(`document.querySelector('#pf-sec-summarizer').scrollIntoView({block:'center'})`);
      await shot('memory-summary-control');
      await click('[data-pf="guide-open"]');
      const guide = await page.eval(`(() => {
        const d=document.querySelector('#pf-guide-dlg');d.scrollTop=0;
        return {rows:[...d.querySelectorAll('tr[data-guide-row-group]')].map(r=>({group:r.dataset.guideRowGroup,text:r.textContent.trim()})),scrollHeight:d.scrollHeight,clientHeight:d.clientHeight};
      })()`);
      layout.guide[key]=guide;
      const counts=Object.fromEntries(['primary','routing','memory','summary'].map(g=>[g,guide.rows.filter(r=>r.group===g).length]));
      if(guide.rows.length!==27) fail(key,'guide row count',{total:guide.rows.length,counts},{total:27,primary:4,routing:20,memory:2,summary:1});
      let scroll=0, index=0;
      while(true) {
        const pos=await page.eval(`(() => { const d=document.querySelector('#pf-guide-dlg');d.scrollTop=${scroll};return {top:d.scrollTop,max:d.scrollHeight-d.clientHeight,height:d.clientHeight};})()`);
        await shot('guide-scroll-'+String(index++).padStart(2,'0'), index===1);
        if(pos.top>=pos.max-1) break;
        scroll=pos.top+Math.max(40,Math.floor(pos.height*.75));
        if(index>100) throw new Error('guide scroll capture exceeded 100 frames');
      }
      await click('[data-pf="guide-close"]');
      layout.focusReturn[key]=await page.eval(`({returned:document.activeElement===document.querySelector('[data-pf="guide-open"]'),active:document.activeElement.outerHTML})`);
      if(!layout.focusReturn[key].returned) fail(key,'guide focus returns',layout.focusReturn[key],true);
      await shot('guide-closed-focus-return');
      await tab('agents');
      await click('[data-row="route:agents/explore"]');
      await page.eval(`(() => {
        const el=document.querySelector('[data-pf="route-provider"][data-role="explore"]') || document.querySelector('[data-pf-route="agents/explore"] [data-pf="route-provider"]');
        const o=[...el.options].find(o=>o.value && !o.disabled && o.value!==el.value);
        if(!o) throw new Error('no alternative served provider');
        el.value=o.value;el.dispatchEvent(new Event('change',{bubbles:true}));
        const model=document.querySelector('[data-pf-route="agents/explore"] [data-pf="route-model"]');
        const pick=[...model.options].find(o=>o.value && !o.disabled);
        if(!pick) throw new Error('no served model for alternative provider');
        model.value=pick.value;model.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await waitFor(page, `document.querySelectorAll('.pf-pending li').length>0`, 'pending row');
      await shot('held-pending-row');
      const omoFile=path.join(homes.primary,'omo.jsonc');
      const before=fs.readFileSync(omoFile);
      fs.appendFileSync(omoFile,'\n');
      try {
        await click('[data-pf="apply"]');
        await waitFor(page, `document.querySelector('[data-pf-root]')?.dataset.pfConflict==='true'`, 'real stale-write conflict');
        await shot('conflict-row');
      } finally { fs.writeFileSync(omoFile,before); }
      await fresh();
      await page.eval(`(() => {const q=document.querySelector('#pf-routing-search');q.value='__no_such_role_model_179389__';q.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await shot('empty-search-result');
      let paused;
      const handler = p => { paused=p.requestId; };
      page.client.listeners.set('Fetch.requestPaused',[handler]);
      await page.client.send('Fetch.enable',{patterns:[{urlPattern:'*/profiles/state',requestStage:'Request'}]});
      try {
        await page.goto(url);
        await waitFor(page, `document.querySelector('[data-sh="view"][data-key="profiles"]')`, 'loading rail');
        await click('[data-sh="view"][data-key="profiles"]');
        if (await page.eval(`innerWidth <= 899 && document.querySelector('.sh-shell').dataset.side === 'open'`)) await click('.sh-topen');
        await waitFor(page, `document.querySelector('[data-pf-root]')?.dataset.pfState==='loading'`, 'held GET loading');
        await shot('loading');
        if(!paused) throw new Error('profiles/state request was not intercepted');
        await page.client.send('Fetch.fulfillRequest',{requestId:paused,responseCode:500,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from('{"error":"TASK10_CAPTURE_FAILURE"}').toString('base64')});
        await waitFor(page, `document.querySelector('[data-pf-root]')?.dataset.pfState==='error'`, 'HTTP 500 error frame');
        await shot('error');
      } finally {
        await page.client.send('Fetch.disable');
        page.client.listeners.delete('Fetch.requestPaused');
      }
      save();
      console.log('CAPTURED '+key+' '+layout.captures.length+' frames; '+layout.failures.length+' measurement failures');
    }
  } finally { save(); }
  return layout;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const commandLog = [];
  const consoleLines = [];
  const consoleErrors = [];
  const pageExceptions = [];

  const invokedCmd = `OMO_STABLE_PLUGIN="${process.env.OMO_STABLE_PLUGIN}" node ${ process.argv.slice(1).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') }`;
  commandLog.push(invokedCmd);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piomo-qa-v3-'));
  assertFixtureRoot(tempRoot);

  const snapshotDir = IS_FINAL && !ONE_COL_PROBE ? WORKTREE_ROOT : path.join(tempRoot, 'snapshot');
  let commitSha = null;
  let staleStateProof = [];
  let server = null;
  let serverPort = null;
  let page = null;
  let chromePids = [];
  let csp = null;

  try {
    if (!IS_FINAL) {
      commitSha = await materialiseSnapshot(WORKTREE_ROOT, BASELINE_REF, snapshotDir, commandLog);
      staleStateProof = verifySnapshotMatchesRef(
        WORKTREE_ROOT,
        BASELINE_REF,
        snapshotDir,
        [
          'src/page/profiles-view.css',
          'src/page/profiles-view.js',
          'src/page/page.css',
          'src/page/cards-view.css',
          'src/page/view.js',
        ],
        commandLog,
      );
    } else if (ONE_COL_PROBE) {
      fs.cpSync(path.join(WORKTREE_ROOT, 'src'), path.join(snapshotDir, 'src'), { recursive: true });
      fs.cpSync(path.join(WORKTREE_ROOT, 'test'), path.join(snapshotDir, 'test'), { recursive: true });
      fs.cpSync(path.join(WORKTREE_ROOT, 'assets'), path.join(snapshotDir, 'assets'), { recursive: true });
      fs.copyFileSync(path.join(WORKTREE_ROOT, 'package.json'), path.join(snapshotDir, 'package.json'));
      commitSha = 'isolated-current-worktree';
    } else {
      const rev = spawnSync('git', ['-C', WORKTREE_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      commitSha = rev.status === 0 ? rev.stdout.trim() : 'unknown';
    }

    // Optional adversarial failure-mode mutations on the isolated snapshot (never on the worktree!)
    if (!IS_FINAL && SHUFFLE_PROBE) {
      const modelFile = path.join(snapshotDir, 'src/profiles/model.mjs');
      const src = fs.readFileSync(modelFile, 'utf8');
      const mutated = src.replace(
        "roles: ['deep-low', 'deep-high', 'ultrabrain']",
        "roles: ['deep-high', 'deep-low', 'ultrabrain']",
      );
      fs.writeFileSync(modelFile, mutated, 'utf8');
    }
    if (ONE_COL_PROBE) {
      const cssFile = path.join(snapshotDir, 'src/page/profiles-view.css');
      fs.appendFileSync(cssFile, '\n.pf-roles, .pf-groups { grid-template-columns: minmax(0, 1fr) !important; }\n', 'utf8');
    }

    // Dynamically import board modules from snapshotDir (or WORKTREE_ROOT under --final)
    const toImportUrl = (rel) => pathToFileURL(path.join(snapshotDir, rel)).href;
    const [
      serverMod,
      renderMod,
      storeMod,
      modelMod,
      recommendMod,
      jsoncMod,
    ] = await Promise.all([
      import(toImportUrl('src/server.mjs')),
      import(toImportUrl('src/render.mjs')),
      import(toImportUrl('src/profiles/store.mjs')),
      import(toImportUrl('src/profiles/model.mjs')),
      import(toImportUrl('src/profiles/recommend.mjs')),
      import(toImportUrl('src/profiles/contract/jsonc.mjs')),
    ]);

    const { createBoardServer } = serverMod;
    const { pageHtml } = renderMod;
    const { openProfilesStore, formatJsonText } = storeMod;

    const pluginInfo = resolvePluginForInventory(snapshotDir);
    const homes = seedFixtureHomes(path.join(tempRoot, 'fixture'), snapshotDir, formatJsonText);
    const inventory = readJson(path.join(snapshotDir, 'src/profiles/inventory.json'));
    const vm = readJson(path.join(snapshotDir, 'test/fixtures/view-model-board.json'));
    const token = 'piomo-qa-v3-token';

    const store = openProfilesStore({
      primaryHome: homes.primary,
      stableHome: homes.stable,
      mirrorHomes: [],
      pluginPath: pluginInfo.pluginPath,
      inventory,
      now: () => FIXED_NOW,
    });

    server = createBoardServer({
      portBase: PORT_BASE,
      portCount: 10,
      generation: 7,
      token,
      getPage: ({ nonce } = {}) => pageHtml(vm, 7, { mode: 'server', token, nonce }),
      getViewModel: () => vm,
      profilesState: () => store.state(),
      onProfiles: (body) => store.handle(body),
      onError: (key, err) => {
        const msg = `[server:error:${key}] ${err?.stack || err?.message || err}`;
        consoleLines.push(msg);
        consoleErrors.push(msg);
      },
    });

    const started = await server.start();
    serverPort = started.port;
    const url = `http://127.0.0.1:${serverPort}/`;
    consoleLines.push(`[info] server listening on ${url} (serveRoot=${snapshotDir})`);

    page = await launch({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
    csp = await watchCsp(page);
    chromePids = [...new Set([page.pid, ...listProfilePids(page.profileDir)])].sort((a, b) => a - b);

    const listen = (method, fn) => {
      page.client.listeners.set(method, [...(page.client.listeners.get(method) || []), fn]);
    };
    listen('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      const line = `[browser:console:${p.type}] ${text}`;
      consoleLines.push(line);
      if (p.type === 'error') consoleErrors.push(line);
    });
    listen('Runtime.exceptionThrown', (p) => {
      const desc = p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown exception';
      const line = `[browser:exception] ${desc}`;
      consoleLines.push(line);
      consoleErrors.push(line);
      pageExceptions.push(line);
    });
    listen('Log.entryAdded', (p) => {
      const entry = p.entry || {};
      const line = `[browser:log:${entry.level}] ${entry.text || ''} ${entry.url || ''}`.trim();
      consoleLines.push(line);
      if (entry.level === 'error') consoleErrors.push(line);
    });

    await page.goto(url);
    await waitFor(page, `document.querySelector('[data-sh="view"][data-key="profiles"]')`, 'board shell profiles button');
    await page.eval(`document.querySelector('[data-sh="view"][data-key="profiles"]').click()`);
    await waitFor(
      page,
      `document.querySelector('[data-pf-root]')?.getAttribute('data-pf-state') === 'view' && document.querySelectorAll('.pf-route').length > 0`,
      'profiles view loaded',
    );
    await settle(page);

    if (REVIEW_CAPTURE) {
      await captureReviewEvidence(page, { url, homes, pluginInfo, commitSha, commandLog });
      return;
    }

    const viewportMeasurements = {};
    for (const vp of VIEWPORTS) {
      viewportMeasurements[vp.name] = await measureAtViewport(page, vp);
      if (IS_FINAL) {
        const grid = await measurePurposeGrid(page, { boundary: vp.width === 1440 && !ONE_COL_PROBE });
        viewportMeasurements[vp.name].purposeGrid = grid;
        fs.writeFileSync(path.join(OUT, `grid-${vp.name}.json`), JSON.stringify(grid, null, 2) + '\n');
        await page.screenshot(path.join(OUT, `groups-${vp.name}.png`));
        assertPurposeGrid(grid, vp.name);
        if (grid.boundaries.length) fs.writeFileSync(path.join(OUT, 'boundary-611-612.txt'), JSON.stringify(grid.boundaries, null, 2) + '\n');
      }
    }

    // Verify purpose order of deep-low -> deep-high -> ultrabrain in role rows
    for (const [vpName, m] of Object.entries(viewportMeasurements)) {
      if (!m.fourSurfacesRoleOrder.roleRows.matchesPurposeOrder) {
        throw new Error(
          `Reasoning group order mismatch at ${vpName}: expected ["deep-low","deep-high","ultrabrain"], got ${JSON.stringify(m.fourSurfacesRoleOrder.roleRows.reasoningGroupOrder)}`,
        );
      }
    }

    const liveFacts = readLiveFacts({
      parseJsonc: jsoncMod.parseJsonc,
      expandLayerRoles: modelMod.expandLayerRoles,
      newRouteRow: modelMod.newRouteRow,
      compareRecommendation: recommendMod.compareRecommendation,
      BUILTIN_ROLE_CATEGORIES: modelMod.BUILTIN_ROLE_CATEGORIES,
      ROLE_DISPLAY_NAMES: modelMod.ROLE_DISPLAY_NAMES,
      ROUTING_GROUPS: modelMod.ROUTING_GROUPS,
    });

    const { reviewerRolesReport, namingMap } = await extractDomNamingAndReviewers(
      page,
      snapshotDir,
      modelMod,
      liveFacts,
    );

    csp.assertNone('profiles-v3');
    assert.equal(pageExceptions.length, 0, `Uncaught page exceptions: ${pageExceptions.join('; ')}`);
    assert.equal(consoleErrors.length, 0, `Console errors: ${consoleErrors.join('; ')}`);

    // Worktree vs snapshot diff proof (proves concurrent worktree edits do not affect --baseline-ref)
    const worktreeVsSnapshot = [
      'src/page/profiles-view.css',
      'src/page/profiles-view.js',
      'src/page/page.css',
      'src/page/cards-view.css',
      'src/page/view.js',
    ].map((rel) => {
      const wtHash = hashFile(path.join(WORKTREE_ROOT, rel));
      const snapHash = hashFile(path.join(snapshotDir, rel));
      return {
        path: rel,
        worktreeSha256: wtHash,
        servedSnapshotSha256: snapHash,
        worktreeDiffersFromSnapshot: wtHash !== snapHash,
      };
    });

    const outputPayload = {
      schema: 'qa-profiles-v3/1',
      mode: IS_FINAL ? 'final' : 'baseline',
      baselineRef: IS_FINAL ? null : BASELINE_REF,
      resolvedCommit: commitSha,
      generatedAt: new Date().toISOString(),
      plugin: pluginInfo,
      server: { port: serverPort, url },
      snapshotIsolation: {
        servedFromSnapshot: !IS_FINAL,
        staleStateVerifiedFiles: staleStateProof,
        worktreeVsSnapshot,
      },
      viewports: viewportMeasurements,
      deepHighInvestigation: {
        summary: 'Role rows and the guide use the existing deep-low, deep-high, ultrabrain metadata order. Raw JSON keys stay unchanged. Todo 14 reproduced alphabetical deep-high before deep-low in preview display, so only that display now follows routing metadata; pending remains in change-time order.',
        boardSourceReasoningOrder: ['deep-low', 'deep-high', 'ultrabrain'],
        fixtureSurfacesOrder: viewportMeasurements['1440x900'].fourSurfacesRoleOrder,
        liveOmoJsoncKeyOrder: liveFacts.rawKeyOrderInSelectedProfile,
        reproducedMisorderInBoardUi: false,
      },
      reviewerRoles: reviewerRolesReport,
      liveReadOnly: liveFacts,
      console: {
        errorCount: consoleErrors.length,
        exceptionCount: pageExceptions.length,
        cspViolationCount: csp.violations.length,
      },
    };

    const primaryFileName = IS_FINAL ? 'layout.json' : 'baseline.json';
    const writeOutputs = (dir) => {
      fs.writeFileSync(path.join(dir, primaryFileName), JSON.stringify(outputPayload, null, 2) + '\n', 'utf8');
      if (IS_FINAL) {
        // Also write baseline.json only if not present, or keep layout.json as primary
      }
      fs.writeFileSync(path.join(dir, 'naming-map.json'), JSON.stringify(namingMap, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'commands.txt'), commandLog.join('\n') + '\n', 'utf8');
      const consoleOut = consoleErrors.length === 0 && pageExceptions.length === 0
        ? `ok: 0 console errors, 0 uncaught page exceptions, 0 CSP violations\n` + consoleLines.join('\n') + '\n'
        : consoleLines.join('\n') + '\n';
      fs.writeFileSync(path.join(dir, 'console.txt'), consoleOut, 'utf8');
    };

    writeOutputs(OUT);

    console.log(JSON.stringify({
      ok: true,
      mode: outputPayload.mode,
      commit: commitSha,
      out: OUT,
      port: serverPort,
      widths: Object.fromEntries(
        Object.entries(viewportMeasurements).map(([k, v]) => [
          k,
          {
            detailPaneWidth: v.detailPaneWidth,
            rolesContainerWidth: v.rolesContainerWidth,
            rolesContainerContentWidth: v.rolesContainerContentWidth,
            roleGroupGridColumns: v.roleGroupGridColumns,
            closedRoleRowHeight: v.closedRoleRowHeight,
            visibleRoleRowCount: v.visibleRoleRowCount,
          },
        ]),
      ),
      consoleErrors: consoleErrors.length,
    }, null, 2));
  } finally {
    fs.writeFileSync(path.join(OUT, 'runtime-console.txt'), consoleLines.join('\n') + '\n');
    if (page) {
      try { await page.close(); } catch (e) { console.error('page.close error:', e); }
    }
    for (const pid of chromePids) {
      if (isPidAlive(pid)) {
        try {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
        } catch {}
      }
    }
    if (server) {
      try { await server.close(); } catch (e) { console.error('server.close error:', e); }
    }
    if (tempRoot && fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (e) {
        console.error('tempRoot rm error:', e);
      }
    }
    const remainingChromePids = [...new Set([
      ...chromePids.filter(isPidAlive),
      ...(page ? listProfilePids(page.profileDir) : []),
    ])];
    let listenerRemains = false;
    if (serverPort) {
      try {
        await fetch(`http://127.0.0.1:${serverPort}/health`, { signal: AbortSignal.timeout(3000) });
        listenerRemains = true;
      } catch (error) {
        // A timeout is a hung listener, not evidence of a closed port.
        if (error.name === 'TimeoutError') listenerRemains = true;
      }
    }
    const cleanup = { remainingChromePids, listenerRemains, port: serverPort, fixtureRootRemoved: !fs.existsSync(tempRoot) };
    fs.writeFileSync(path.join(OUT, 'cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n');
    if (REVIEW_CAPTURE) fs.writeFileSync(path.join(OUT, 'cleanup-receipt.json'), JSON.stringify({
      ...cleanup, started: { chromePids, browserPid: page?.pid, chromeProfile: page?.profileDir, fixtureRoot: tempRoot, serverPort },
      stopped: { chromePids, chromeProfileRemoved: page ? !fs.existsSync(page.profileDir) : true, serverClosed: !listenerRemains },
      completedAt: new Date().toISOString(),
    }, null, 2) + '\n');
    assert.deepEqual(remainingChromePids, [], 'probe leaves no Chrome process');
    assert.equal(listenerRemains, false, 'probe leaves no listener');
    assert.equal(cleanup.fixtureRootRemoved, true, 'probe removes its fixture root');
  }
}

await main();
