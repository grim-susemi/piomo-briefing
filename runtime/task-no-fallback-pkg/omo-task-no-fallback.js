// omo custom layer: task child model fallback off (CANDIDATE - not installed; owner approval required)
// Single .js file on purpose: the extension loader resolves the bare `@code-yeongyu/senpi` import to the running
// engine's own module only for files it loads itself; a re-exported .mjs is imported natively and cannot resolve it.
// Owner: "폴백 기능 끄자 ... 작업자 폴백도 안되게 해야지" (2026-10-17).
// Closes every path that moves a task child to another model, without editing the omo-ai / senpi bundles:
//  1. omo-task record seam: task records are published with fs.writeFileSync (create: st_*.json,
//     replace: st_*.json.<pid>.<hex>.tmp). `fallback_models` is dropped before it reaches disk, so the
//     launch-failure handoff (#ke, model_unavailable) and the run-failure handoff (#re, task_model_fallback)
//     find no next model. Both read the record back from disk.
//  2. in-session seam (the path that actually moved an in-process child in isolation, event retry_fallback_applied): SettingsManager.prototype.getRetryFallbackSettings reports modelFallback=false, so the
//     RetryFallbackController (managedChainKey / nextCandidate) never switches models - this covers the chain
//     omo-task injects into in-process child settings and the `set_retry_fallback` RPC sent to process children.
// Same-model retries (retry.enabled / maxRetries) are untouched.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const MARK = Symbol.for("omo.custom.taskNoFallback.v1");
const RECORD_RE = /[\\/]tasks[\\/]st_[0-9a-z]+\.json(?:\.\d+\.[0-9a-f]{8}\.tmp)?$/i;

export function isTaskRecordPath(file) {
  return typeof file === "string" && RECORD_RE.test(file);
}

export function stripRecordFallback(text) {
  if (typeof text !== "string" || !text.includes('"fallback_models"')) return text;
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return text;
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return text;
  if (typeof record.task_id !== "string" || !Object.hasOwn(record, "fallback_models")) return text;
  delete record.fallback_models;
  return JSON.stringify(record);
}

export function installRecordGuard() {
  if (fs.writeFileSync[MARK] === true) return false;
  const original = fs.writeFileSync;
  const wrapped = function writeFileSync(file, data, options) {
    if (isTaskRecordPath(file) && typeof data === "string") data = stripRecordFallback(data);
    return original.call(fs, file, data, options);
  };
  Object.defineProperty(wrapped, MARK, { value: true });
  fs.writeFileSync = wrapped;
  syncBuiltinESMExports();
  return true;
}

export function installSettingsGuard(SettingsManager) {
  const proto = SettingsManager?.prototype;
  if (proto === undefined || typeof proto.getRetryFallbackSettings !== "function") return false;
  if (proto.getRetryFallbackSettings[MARK] === true) return false;
  const original = proto.getRetryFallbackSettings;
  const wrapped = function getRetryFallbackSettings() {
    return { ...original.call(this), modelFallback: false };
  };
  Object.defineProperty(wrapped, MARK, { value: true });
  proto.getRetryFallbackSettings = wrapped;
  return true;
}

// omo-task does not use the loader's senpi module: it imports its own copy lazily, at the first task spawn, and keeps
// it in a global holder (Symbol.for("omo.senpi-task.senpiBarrel"), created with `??=`). Child sessions get their
// SettingsManager from that copy, so the guard must land there. Pre-creating the holder with a `module` setter patches
// the copy the moment omo-task stores it, before any child session exists; an already-loaded copy is patched at once.
const BARREL = Symbol.for("omo.senpi-task.senpiBarrel");

export function installBarrelGuard(root = globalThis) {
  const holder = root[BARREL];
  if (holder !== undefined && holder !== null) {
    if (holder[MARK] === true) return false;
    if (holder.module !== undefined) installSettingsGuard(holder.module.SettingsManager);
    let current = holder.module;
    Object.defineProperty(holder, "module", {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value) => {
        if (value !== undefined) installSettingsGuard(value?.SettingsManager);
        current = value;
      },
    });
    Object.defineProperty(holder, MARK, { value: true });
    return true;
  }
  let current;
  const created = { promise: undefined, exports: undefined };
  Object.defineProperty(created, "module", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (value) => {
      if (value !== undefined) installSettingsGuard(value?.SettingsManager);
      current = value;
    },
  });
  Object.defineProperty(created, MARK, { value: true });
  root[BARREL] = created;
  return true;
}

export default async function omoTaskNoFallback() {
  installRecordGuard();
  installBarrelGuard();
  const senpi = await import("@code-yeongyu/senpi");
  if (!installSettingsGuard(senpi.SettingsManager) && senpi.SettingsManager?.prototype?.getRetryFallbackSettings?.[MARK] !== true) {
    throw new Error("task-no-fallback: SettingsManager.getRetryFallbackSettings not found; in-session fallback is NOT blocked");
  }
}
