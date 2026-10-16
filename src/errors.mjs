// omo-briefing src/errors.mjs - per-source error slots in a session's meta.
//
// meta.errors = { <source>: { at, message } }   e.g. decide, mirror, deliver, settings, render, collect
// meta.lastError = the newest entry of meta.errors, or null (derived compat field; always rewritten here)
//
// A source records its own error and clears only its own entry; no other source's success touches it.
// The page shows '오류 있음' while meta.errors has any entry. Whoever changes an entry saves meta and publishes once.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function errorsOf(meta) {
  return meta && isObj(meta.errors) ? meta.errors : {};
}

export function hasErrors(meta) {
  return Object.keys(errorsOf(meta)).length > 0;
}

function derive(meta) {
  let latest = null;
  for (const e of Object.values(errorsOf(meta))) {
    if (isObj(e) && (latest === null || e.at >= latest.at)) latest = e;
  }
  meta.lastError = latest ? { at: latest.at, message: latest.message } : null;
}

/** Records (or refreshes) one source's error. Returns false when that source already shows this same message. */
export function setError(meta, source, message, at) {
  const cur = errorsOf(meta)[source];
  if (cur && cur.message === message) return false;
  meta.errors = { ...errorsOf(meta), [source]: { at, message } };
  derive(meta);
  return true;
}

/** Clears one source's entry only. Returns whether there was one. */
export function clearError(meta, source) {
  const cur = errorsOf(meta);
  if (!(source in cur)) return false;
  const { [source]: _gone, ...rest } = cur;
  meta.errors = rest;
  derive(meta);
  return true;
}

/** Normalises a meta loaded from disk (an older record only has lastError, which is dropped: errors is the source of truth). */
export function normalizeErrors(meta) {
  meta.errors = { ...errorsOf(meta) };
  derive(meta);
}
