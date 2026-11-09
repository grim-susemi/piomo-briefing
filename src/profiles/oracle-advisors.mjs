// The Oracle advisor routing table (agent/oracle-advisor/routing.json) is owned by the oracle-advisor
// extension; the switcher only reads it and rewrites one field, profiles.<advisor>.model, when the owner
// picks a model and effort for an advisor that already exists. The grammar and the family rule below mirror
// that extension's validateRouting (piomo-oracle-advisor-mod src/seams.mjs): a pin is provider/model[:level]
// with one slash, and the model's family must stay the profile's declared family, so a Claude advisor
// cannot be turned into a GPT one from here.
export const ADVISOR_FILE = 'agent/oracle-advisor/routing.json';

const PIN_GRAMMAR = /^[a-z0-9_.-]+\/([a-z0-9_.-]+)(?::[a-z0-9_.-]+)?$/i;

export function advisorFamilyOf(bareModelId) {
  const lower = String(bareModelId).toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.startsWith('gpt-')) return 'gpt';
  return 'other';
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function splitPin(pin) {
  const cut = pin.lastIndexOf(':');
  return cut > pin.indexOf('/') ? { model: pin.slice(0, cut), thinking: pin.slice(cut + 1) } : { model: pin, thinking: '' };
}

// View rows, one per advisor profile in file order. A missing file is no advisor surface, not an error.
export function readAdvisors(value) {
  if (value === null || value === undefined) return [];
  if (!isObject(value) || !isObject(value.profiles)) throw new TypeError('Invalid oracle advisor routing file.');
  return Object.entries(value.profiles).map(([name, profile]) => {
    const pin = isObject(profile) && typeof profile.model === 'string' ? profile.model : '';
    const { model, thinking } = pin ? splitPin(pin) : { model: '', thinking: '' };
    return {
      name, family: isObject(profile) && typeof profile.family === 'string' ? profile.family : '',
      pin, model, provider: model ? model.split('/')[0] : '', thinking,
    };
  });
}

// Returns a copy with only profiles[advisor].model changed; every other byte of meaning is kept.
export function setAdvisorModel(value, { advisor, model, thinking }) {
  if (!isObject(value) || !isObject(value.profiles)) throw new Error('The oracle advisor routing file is missing.');
  const profile = value.profiles[advisor];
  if (!isObject(profile)) throw new Error(`Unknown oracle advisor ${advisor}.`);
  const pin = `${model}:${thinking}`;
  const match = PIN_GRAMMAR.exec(pin);
  if (!match) throw new Error(`${pin} does not match provider/model:level.`);
  const family = advisorFamilyOf(match[1]);
  if (family !== profile.family) {
    throw Object.assign(new Error(`The ${advisor} advisor is a ${profile.family} advisor; ${match[1]} is ${family}.`),
      { code: 'ADVISOR_FAMILY' });
  }
  const next = structuredClone(value);
  next.profiles[advisor].model = pin;
  return next;
}
