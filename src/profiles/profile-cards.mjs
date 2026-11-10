// User-owned profile metadata. Engine inputs remain in the existing store targets.
import { PROFILE_META } from './model.mjs';
import { isPlainObject, REVIEWER_KEY_MAP } from './merge.mjs';

export const PROFILE_CARDS_FILE = 'runtime/native-profile-switcher-profile-cards.json';
export const SUBSCRIPTION_COPY_LIMITATION = 'CommandCode subscription assignments are keyed by profile and are not copied to a new profile.';
const limits = { name: 40, tag: 24, summary: 160 };
const emptyCards = () => ({ version: 1, nextCustomSeq: 1, cards: {}, custom: [] });

function textReason(value, field) {
  if (typeof value !== 'string') return 'NOT_STRING';
  if (/[\u0000-\u001f\u007f]/u.test(value)) return 'CONTROL_CHAR';
  const length = [...value.trim()].length;
  if (field === 'name' && length === 0) return 'EMPTY';
  if (length > limits[field]) return 'TOO_LONG';
  return null;
}

export function readProfileCards(value) {
  if (value === undefined) return emptyCards();
  const invalid = () => { throw new TypeError('Invalid version 1 profile cards file.'); };
  if (!isPlainObject(value) || value.version !== 1 || !Number.isSafeInteger(value.nextCustomSeq)
    || value.nextCustomSeq < 1 || !isPlainObject(value.cards) || !Array.isArray(value.custom)) invalid();
  const keys = new Set(PROFILE_META.map(p => p.key));
  const nums = new Set(PROFILE_META.map(p => p.num));
  for (const item of value.custom) {
    if (!isPlainObject(item) || !/^custom-[1-9]\d*$/.test(item.key)
      || item.omoProfile !== 'native-' + item.key || keys.has(item.key)
      || !Number.isSafeInteger(item.num) || item.num < 7 || nums.has(item.num)
      || typeof item.basedOn !== 'string' || !item.basedOn.trim()
      || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
      || ['mainProvider', 'mainModel', 'mainThinking'].some(k => typeof item[k] !== 'string' || !item[k].trim())
      || !(item.fallbackChains === null || isPlainObject(item.fallbackChains))) invalid();
    keys.add(item.key);
    nums.add(item.num);
    if (!isPlainObject(value.cards[item.key])
      || Object.keys(limits).some(field => !Object.hasOwn(value.cards[item.key], field))) invalid();
  }
  for (const [key, card] of Object.entries(value.cards)) {
    if (!keys.has(key) || !isPlainObject(card)
      || Object.entries(card).some(([field, text]) => !Object.hasOwn(limits, field)
        || textReason(text, field) || text !== text.trim())) invalid();
  }
  return structuredClone(value);
}

export function effectiveProfiles(cards) {
  return [
    ...PROFILE_META.map(profile => {
      const override = cards.cards[profile.key] ?? {};
      return {
        ...profile, ...override,
        nameKr: Object.hasOwn(override, 'name') ? override.name : profile.nameKr,
        custom: false,
        defaults: { name: profile.name, tag: profile.tag, summary: profile.summary },
      };
    }),
    ...cards.custom.map(profile => ({
      ...profile, ...cards.cards[profile.key], nameKr: cards.cards[profile.key].name,
      custom: true, defaults: null,
    })),
  ];
}

export function getEffectiveProfile(key, cards) {
  return effectiveProfiles(cards).find(profile => profile.key === key) ?? null;
}

export function validateProfileCardInput(change, profile) {
  const creating = change.kind === 'addProfile';
  const errors = [];
  const values = {};
  if (!profile) errors.push({ field: creating ? 'baseProfileKey' : 'profileKey', reason: 'UNKNOWN_PROFILE' });
  for (const field of Object.keys(limits)) {
    if (!Object.hasOwn(change, field)) {
      if (creating) {
        if (field === 'name') errors.push({ field, reason: 'EMPTY' });
        else values[field] = '';
      }
      continue;
    }
    const value = change[field];
    const reason = value === null ? (creating || profile?.custom ? 'NULL_NOT_ALLOWED' : null) : textReason(value, field);
    if (reason) errors.push({ field, reason });
    else values[field] = value === null ? null : value.trim();
  }
  if (!creating && Object.keys(values).length === 0 && errors.length === 0) {
    errors.push({ field: 'name', reason: 'EMPTY' });
  }
  return errors.length ? { ok: false, code: 'BAD_REQUEST', status: 400, errors } : { ok: true, values };
}

export function setProfileCard(cards, change) {
  const profile = getEffectiveProfile(change.profileKey, cards);
  const valid = validateProfileCardInput(change, profile);
  if (!valid.ok) return valid;
  const next = structuredClone(cards);
  const card = { ...next.cards[profile.key] };
  for (const [field, value] of Object.entries(valid.values)) {
    if (value === null || value === profile.defaults?.[field]) delete card[field];
    else card[field] = value;
  }
  if (Object.keys(card).length) next.cards[profile.key] = card;
  else delete next.cards[profile.key];
  return { ok: true, cards: next };
}

function hasLegacyReviewer(value) {
  if (Array.isArray(value)) return value.some(hasLegacyReviewer);
  return isPlainObject(value) && Object.entries(value).some(([key, child]) =>
    Object.hasOwn(REVIEWER_KEY_MAP, key) || hasLegacyReviewer(child));
}

function safeSuccessor(value) {
  const next = value + 1;
  return Number.isSafeInteger(next) && next > value ? next : null;
}

export function addProfile(cards, change, source) {
  const base = getEffectiveProfile(change.baseProfileKey, cards);
  const valid = validateProfileCardInput(change, base);
  if (!valid.ok) return valid;
  const configs = [...source.files].filter(([, file]) => file.exists && file.kind === 'jsonc');
  for (const [id, file] of configs) {
    const block = file.value?.profiles?.[base.omoProfile];
    if (!isPlainObject(block)) return { ok: false, code: 'BASE_MISSING', status: 400, file: id };
    if (hasLegacyReviewer(block)) return { ok: false, code: 'LEGACY_REVIEWER_KEYS', status: 400, file: id };
  }
  const occupied = new Set([...Object.keys(cards.cards), ...cards.custom.map(p => p.key)]);
  for (const [, file] of source.files) {
    if (!file.exists || !isPlainObject(file.value)) continue;
    const entries = file.kind === 'jsonc' || file.id.endsWith('role-backups.json')
      ? file.value.profiles : file.id.endsWith('native-profile-switcher-main.json') ? file.value : {};
    for (const key of Object.keys(entries ?? {})) occupied.add(key.replace(/^native-/, ''));
  }
  let seq = cards.nextCustomSeq;
  const exhausted = field => ({ ok: false, code: 'BAD_REQUEST', status: 400, errors: [{ field, reason: 'EXHAUSTED' }] });
  while (occupied.has('custom-' + seq)) {
    const successor = safeSuccessor(seq);
    if (successor === null) return exhausted('nextCustomSeq');
    seq = successor;
  }
  const nextCustomSeq = safeSuccessor(seq);
  if (nextCustomSeq === null) return exhausted('nextCustomSeq');
  const num = safeSuccessor(Math.max(...effectiveProfiles(cards).map(p => p.num)));
  if (num === null) return exhausted('num');
  const key = 'custom-' + seq;
  const profile = {
    key, num,
    omoProfile: 'native-' + key, basedOn: base.key, createdAt: source.createdAt,
    mainProvider: base.mainProvider, mainModel: base.mainModel, mainThinking: base.mainThinking,
    fallbackChains: structuredClone(base.fallbackChains),
  };
  const next = structuredClone(cards);
  next.nextCustomSeq = nextCustomSeq;
  next.custom.push(profile);
  next.cards[key] = valid.values;
  const updates = new Map();
  for (const [id, file] of configs) {
    const value = structuredClone(file.value);
    value.profiles[profile.omoProfile] = structuredClone(value.profiles[base.omoProfile]);
    updates.set(id, { value, kind: 'jsonc' });
  }
  for (const [id, file] of source.files) {
    const roleBackups = id.endsWith('role-backups.json');
    if (!file.exists || !(roleBackups || id.endsWith('native-profile-switcher-main.json'))) continue;
    const entries = roleBackups ? file.value.profiles : file.value;
    if (!Object.hasOwn(entries, base.omoProfile)) continue;
    const value = structuredClone(file.value);
    const target = roleBackups ? value.profiles : value;
    target[profile.omoProfile] = structuredClone(entries[base.omoProfile]);
    updates.set(id, { value, kind: 'json' });
  }
  return { ok: true, cards: next, profile, updates };
}
