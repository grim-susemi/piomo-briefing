// Memento board discovery for the briefing board.
// Pure ESM, no imports: the extension publishes the object, the board only reads it.
const KEY = Symbol.for('omo.memento.api.v1');

export function getMementoApi(host = globalThis) {
  if (!host || typeof host !== 'object') return { ok: false, code: 'MEMENTO_UNAVAILABLE' };
  const value = host[KEY];
  if (!value || typeof value !== 'object') return { ok: false, code: 'MEMENTO_UNAVAILABLE' };
  if (value.version !== 1) return { ok: false, code: 'API_VERSION_UNSUPPORTED' };
  if (!Array.isArray(value.features)
    || !value.features.includes('cards.read')
    || !value.features.includes('cards.setStatus')
    || typeof value.state !== 'function'
    || typeof value.handle !== 'function') {
    return { ok: false, code: 'MEMENTO_UNAVAILABLE' };
  }
  return { ok: true, value };
}
