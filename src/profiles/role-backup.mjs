// User choices only. This sidecar is deliberately not an engine routing input.
export const ROLE_BACKUP_FILE = 'runtime/native-profile-switcher-role-backups.json';

export function readRoleBackups(value) {
  if (value === null || value === undefined) return { version: 1, profiles: {} };
  if (value.version !== 1 || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) {
    throw new TypeError('Invalid role backup selections file.');
  }
  for (const profile of Object.values(value.profiles)) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new TypeError('Invalid backup profile.');
    for (const [section, rows] of Object.entries(profile)) {
      if (!['primary', 'agents', 'categories'].includes(section) || !rows || typeof rows !== 'object' || Array.isArray(rows)
        || Object.values(rows).some(choice => typeof choice === 'string' ? !choice.trim()
          : !choice || Array.isArray(choice) || typeof choice !== 'object'
            || Object.keys(choice).length !== 3
            || ['provider', 'model', 'thinking'].some(key => typeof choice[key] !== 'string' || !choice[key].trim()))) {
        throw new TypeError('Invalid backup role selections.');
      }
    }
  }
  return structuredClone(value);
}

export function roleBackup(selections, profileKey, section, role, catalog) {
  const choice = selections?.profiles?.[profileKey]?.[section]?.[role] ?? '';
  if (typeof choice === 'object') {
    return {
      alias: '', provider: choice.provider, model: choice.provider + '/' + choice.model,
      thinking: choice.thinking, runtimeEffect: 'selection-only',
    };
  }
  const alias = choice;
  const definition = catalog?.[alias];
  return {
    alias: alias || '', model: definition?.model ?? alias ?? '',
    thinking: definition?.reasoning ?? definition?.variant ?? '',
    runtimeEffect: 'selection-only',
  };
}

export function setRoleBackup({ selections, profileKey, section, role, alias, selection }) {
  const choice = selection ?? alias;
  if (choice === '') {
    const profile = selections.profiles[profileKey];
    if (!profile?.[section]) return;
    delete profile[section][role];
    if (Object.keys(profile[section]).length === 0) delete profile[section];
    if (Object.keys(profile).length === 0) delete selections.profiles[profileKey];
    return;
  }
  if (!Object.hasOwn(selections.profiles, profileKey)) selections.profiles[profileKey] = {};
  const profile = selections.profiles[profileKey];
  if (!Object.hasOwn(profile, section)) profile[section] = {};
  profile[section][role] = structuredClone(choice);
}
