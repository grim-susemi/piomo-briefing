// Separate 5.1.40 refresh layer, applied after the ported tables so parity tests can exercise
// the ported layer alone. Pure: no DOM, no file I/O (the board store owns reads/writes).
// Rules: roles new in 5.1.40 become routing rows (group "extras" when no purpose group fits);
// roles absent from 5.1.40 stay visible as read-only rows labelled "5.1.40에 없음" and keep
// their config; the ChatGPT-subscription picker lists every registry-served model for the
// provider; the guide pins the two 5.1.40 bundle files by path + sha256; the four primary
// agents become roster rows (lane select + optional pin) in the todo-4 roster shape.
import {
  BUILTIN_MODEL_PROFILES, CHATGPT_SUBSCRIPTION_PROVIDER_CHOICE, ROLE_DISPLAY_NAMES,
  ROLE_INVENTORY, ROUTING_GROUPS, buildRoutingRows,
} from './model.mjs';

export const INVENTORY_VERSION = '5.1.40';
export const ABSENT_LABEL = '5.1.40에 없음';
export const AGENT_IDS = ['sisyphus', 'hephaestus', 'prometheus', 'atlas'];
export const AGENT_DISPLAY = { sisyphus: 'Sisyphus', hephaestus: 'Hephaestus', prometheus: 'Prometheus', atlas: 'Atlas' };
export const AGENT_COLORS = { sisyphus: '#00CED1', hephaestus: '#D97706', prometheus: '#A78BFA', atlas: '#10B981' };
export const DEFAULT_LANE = {
  sisyphus: 'daily-normal', hephaestus: 'geeky-normal', prometheus: 'daily-heavy', atlas: 'daily-normal',
};
export const DEFAULT_LANES = ['daily-normal', 'daily-heavy', 'geeky-normal', 'geeky-heavy'];

function inventoryIds(inventory, section) {
  const ids = inventory?.[section];
  if (!Array.isArray(ids) || ids.length === 0) throw new Error(`inventory has no ${section} ids`);
  return ids;
}

function purposeGroup(section, role) {
  for (const [groupId, group] of Object.entries(ROUTING_GROUPS[section]?.groups ?? {})) {
    if (group.roles.includes(role)) return groupId;
  }
  return 'extras';
}

// Every 5.1.40 inventory id appears as a row; absent ported roles stay visible and read-only.
export function refreshRoutingRows({ inventory, layer = null }) {
  const live = Object.fromEntries(['agents', 'categories'].map((section) => [section, new Set(inventoryIds(inventory, section))]));
  const rows = buildRoutingRows({ inventory: ROLE_INVENTORY, layer }).map((row) => {
    const absent = !live[row.section].has(row.role);
    return {
      ...row,
      readOnly: absent,
      stateLabel: absent ? ABSENT_LABEL : null,
      absentIn: absent ? INVENTORY_VERSION : null,
      config: layer?.[row.section]?.[row.role] ?? null,
    };
  });
  const seen = new Set(rows.map((row) => `${row.section}/${row.role}`));
  for (const section of ['agents', 'categories']) {
    for (const role of inventoryIds(inventory, section)) {
      if (seen.has(`${section}/${role}`)) continue;
      const group = purposeGroup(section, role);
      rows.push({
        section, role, group,
        groupLabel: ROUTING_GROUPS[section]?.groups?.[group]?.label ?? '추가 역할 · Extras',
        labelKo: ROLE_DISPLAY_NAMES[role]?.Ko ?? role,
        labelEn: ROLE_DISPLAY_NAMES[role]?.En ?? role,
        readOnly: false, stateLabel: null, absentIn: null,
        config: layer?.[section]?.[role] ?? null,
      });
      seen.add(`${section}/${role}`);
    }
  }
  return rows;
}

// Registry adapter for the refresh layer: [{provider, id}] or "provider/id" strings.
export function chatGptPickerModels({ registryModels = [] }) {
  const ids = [];
  for (const model of registryModels) {
    const provider = typeof model === 'string' ? model.split('/')[0] : model?.provider;
    const id = typeof model === 'string' ? model : model?.id;
    if (!id || provider !== CHATGPT_SUBSCRIPTION_PROVIDER_CHOICE) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// The guide pins the two 5.1.40 source files by path + sha256 instead of the 5.1.33 manifest refs.
export function recommendationGuide({ inventory, manifest = null }) {
  const sources = inventory?.sources;
  if (!sources?.omo?.path || !sources?.omo?.sha256 || !sources?.omoTask?.path || !sources?.omoTask?.sha256) {
    throw new Error('inventory sources must carry path and sha256');
  }
  return {
    title: manifest?.title ?? 'OMO 모델·역할 권장 가이드',
    snapshotDate: manifest?.snapshotDate ?? '',
    guideUrl: manifest?.sources?.[0]?.webUrl ?? '',
    version: inventory.version ?? INVENTORY_VERSION,
    pinning: 'path+sha256',
    sources: [
      { path: sources.omo.path, sha256: sources.omo.sha256 },
      { path: sources.omoTask.path, sha256: sources.omoTask.sha256 },
    ],
    chains: BUILTIN_MODEL_PROFILES,
  };
}

export function buildRoster({ now, agents = {} } = {}) {
  if (typeof now !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(now)) throw new Error('buildRoster requires an ISO updatedAt');
  for (const id of Object.keys(agents)) {
    if (!AGENT_IDS.includes(id)) throw new Error(`unknown agent id: ${id}`);
  }
  const rosterAgents = {};
  for (const id of AGENT_IDS) {
    const override = agents[id] ?? {};
    const lane = override.lane ?? DEFAULT_LANE[id];
    if (!DEFAULT_LANES.includes(lane)) throw new Error(`unknown lane for ${id}: ${lane}`);
    const pin = override.pin ?? null;
    if (pin !== null && (!pin.provider || !pin.modelId || !pin.thinking)) throw new Error(`incomplete pin for ${id}`);
    rosterAgents[id] = { lane, pin, rev: Number.isInteger(override.rev) ? override.rev : 0 };
  }
  return { v: 1, revision: 0, updatedAt: now, agents: rosterAgents };
}

// Board rows for the four agents: lane select + optional pin (todo-4 roster shape).
export function agentRosterRows({ roster, lanes = DEFAULT_LANES } = {}) {
  const agents = roster?.agents ?? {};
  return AGENT_IDS.map((id) => {
    const entry = agents[id] ?? {};
    const lane = entry.lane ?? DEFAULT_LANE[id];
    return {
      id,
      label: AGENT_DISPLAY[id],
      color: AGENT_COLORS[id],
      lane,
      laneOptions: lanes.map((value) => ({ value, selected: value === lane })),
      pin: entry.pin ?? null,
      pinEditable: true,
      rev: Number.isInteger(entry.rev) ? entry.rev : 0,
      readOnly: false,
    };
  });
}

export function inventoryStatus({ inventory, live = {} }) {
  const expected = inventory?.sources ?? {};
  const stale = [];
  for (const [key, value] of [['omo', expected.omo], ['omoTask', expected.omoTask]]) {
    if (!value) { stale.push(key); continue; }
    if (live[key] && live[key] !== value.sha256) stale.push(key);
  }
  return { version: inventory?.version ?? INVENTORY_VERSION, stale: stale.length > 0, staleSources: stale };
}
