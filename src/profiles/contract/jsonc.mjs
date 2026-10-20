// Minimal JSONC reader for omo.jsonc: strings, line comments, block comments
// and trailing commas. No dependency on any JSON5/JSONC package.
//
// Pure ESM: only node:fs, node:path and node:crypto may be imported.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';

function stripComments(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      if (index < text.length) output += '\n';
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      let closed = false;
      while (index < text.length) {
        if (text[index] === '*' && text[index + 1] === '/') {
          index += 1;
          closed = true;
          break;
        }
        if (text[index] === '\n') output += '\n';
        index += 1;
      }
      if (!closed) throw new SyntaxError('Unterminated block comment');
      continue;
    }
    output += char;
  }
  return output;
}

function stripTrailingCommas(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      if (text[lookahead] === '}' || text[lookahead] === ']') continue;
    }
    output += char;
  }
  return output;
}

export function parseJsonc(text) {
  if (typeof text !== 'string') throw new TypeError('parseJsonc expects a string');
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(stripTrailingCommas(stripComments(body)));
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function laneMap(value) {
  const object = asObject(value);
  if (object === null) return null;
  const lanes = {};
  for (const [lane, entry] of Object.entries(object)) {
    const laneEntry = asObject(entry);
    if (laneEntry !== null) lanes[lane] = { ...laneEntry };
  }
  return lanes;
}

// P8 shape: root `model_profiles` holds complete lanes; the literal "[native]"
// key holds partial lanes that override them per key. Returns
// { overrides, warning } where overrides is {} when nothing usable was found.
export function readLaneOverrides(omoHome, options = {}) {
  const fs = options.fs ?? nodeFs;
  const file = join(omoHome, 'omo.jsonc');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        overrides: {},
        warning: { code: 'OMO_JSONC_MISSING', message: `${file} not found; builtin chains are used` },
      };
    }
    return {
      overrides: {},
      warning: { code: 'OMO_JSONC_UNREADABLE', message: `${file}: ${error.message}` },
    };
  }

  let parsed;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    return {
      overrides: {},
      warning: { code: 'OMO_JSONC_INVALID', message: `${file}: ${error.message}` },
    };
  }

  const root = asObject(parsed) ? parsed : {};
  const nativeSection = asObject(root['[native]']) ?? asObject(root.native) ?? {};
  const overrides = {};

  for (const [lane, entry] of Object.entries(laneMap(root.model_profiles) ?? {})) {
    overrides[lane] = entry;
  }
  for (const [lane, entry] of Object.entries(laneMap(nativeSection.model_profiles) ?? {})) {
    overrides[lane] = { ...(overrides[lane] ?? {}), ...entry };
  }

  return { overrides, warning: null };
}
