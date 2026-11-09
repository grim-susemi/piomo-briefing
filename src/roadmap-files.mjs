// Read-only filesystem boundary. Canonical identity follows real paths and Windows case rules.
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  RoadmapError, ROADMAP_LIMITS, roadmapKeys, roadmapTime, validateRoadmapProjection,
} from './roadmap-schema.mjs';

export const roadmapHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const slash = (p) => p.replace(/\\/g, '/').normalize('NFC');
export const roadmapPathKey = (p) => process.platform === 'win32' ? slash(p).toLowerCase() : slash(p);
export const roadmapIdOf = (p) => `rm${roadmapHash(roadmapPathKey(p)).slice(0, 12)}`;
export const roadmapRoot = (root) => slash(fs.realpathSync(root));
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function roadmapFilePath(root, input, kind) {
  if (typeof input !== 'string' || input.normalize('NFC') !== input || !path.isAbsolute(input)
    || input.split(/[\\/]/).some((part) => part === '..' || part === '.')
    || /[\u0000-\u001f]/.test(input)) {
    throw new RoadmapError('PATH', kind, `normalized absolute path required: ${input}`);
  }
  const resolved = path.resolve(input);
  const relative = slash(path.relative(root, resolved));
  const patterns = {
    projection: /^\.omo\/roadmaps\/[^/:]+\.json$/i,
    source: /^\.omo\/drafts\/[^/:]+\.md$/i,
    plan: /^\.omo\/(?:plans|drafts)\/[^/:]+\.md$/i,
    receipt: /^\.omo\/[^:]+$/i,
  };
  if (!patterns[kind].test(relative) || !inside(root, resolved)) {
    throw new RoadmapError('PATH', kind, `outside allowed project location: ${input}`);
  }
  const real = fs.realpathSync(resolved);
  if (!inside(root, real) || !patterns[kind].test(slash(path.relative(root, real)))) {
    throw new RoadmapError('PATH', kind, `realpath escapes allowed project location: ${input}`);
  }
  if (!fs.statSync(real).isFile()) throw new RoadmapError('PATH', kind, `regular file required: ${input}`);
  return slash(real);
}

// fstat and a bounded read use the same descriptor; growing files cannot bypass the byte cap.
export function readRoadmapFile(file, maxBytes = ROADMAP_LIMITS.bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size > maxBytes) throw new RoadmapError('LIMIT', file, `${size} bytes exceed ${maxBytes}`);
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const got = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (got === 0) break;
      length += got;
    }
    if (length > size) throw new RoadmapError('CHANGED', file, 'file grew during read');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    fs.closeSync(fd);
  }
}

export function roadmapSection(text, headingPath) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const headings = [];
  const stack = [];
  let fence = null;
  for (const [line, content] of lines.entries()) {
    const marker = content.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = content.match(/^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (!match) continue;
    const level = match[1].length;
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    const entry = { level, text: match[2], line };
    stack.push(entry);
    headings.push({ ...entry, path: stack.map((heading) => heading.text), levels: stack.map((heading) => heading.level) });
  }
  let selected;
  for (let depth = 1; depth <= headingPath.length; depth++) {
    const candidates = headings.filter((heading) => heading.path.length === depth
      && heading.levels[0] === 1 && heading.path.every((segment, i) => segment === headingPath[i]));
    if (candidates.length !== 1) throw new RoadmapError('HEADING', 'headingPath', 'missing or ambiguous heading segment');
    selected = candidates[0];
  }
  const next = headings.find((heading) => heading.line > selected.line && heading.level <= selected.level);
  return `${lines.slice(selected.line, next?.line).join('\n')}\n`;
}

export function loadRoadmapProjection(input) {
  const projectRoot = roadmapRoot(input.projectRoot);
  const projectionPath = roadmapFilePath(projectRoot, input.projectionPath, 'projection');
  const text = readRoadmapFile(projectionPath);
  const parsed = validateRoadmapProjection(JSON.parse(text));
  if (!parsed.ok) {
    const first = parsed.errors[0];
    throw new RoadmapError(first.code, first.path, first.message);
  }
  const projection = parsed.normalized;
  const evidence = { sources: [], plans: [], receipts: [] };
  for (const source of projection.sources) {
    const file = roadmapFilePath(projectRoot, source.path, 'source');
    const raw = readRoadmapFile(file, 2 * 1024 * 1024);
    const sha256 = roadmapHash(roadmapSection(raw, source.headingPath));
    if (sha256 !== source.sha256.toLowerCase()) throw new RoadmapError('HASH', source.path, 'source section hash mismatch');
    source.path = file;
    source.sha256 = sha256;
    evidence.sources.push({ id: source.id, path: file, sha256, fileSha256: roadmapHash(raw) });
  }
  for (const stage of projection.stages) {
    const plans = new Map();
    for (const plan of stage.plans) {
      const file = roadmapFilePath(projectRoot, plan.path, 'plan');
      const sha256 = roadmapHash(readRoadmapFile(file, 2 * 1024 * 1024));
      if (!evidence.plans.some((item) => item.path === file)) evidence.plans.push({ path: file, sha256 });
      const key = roadmapPathKey(file);
      const prior = plans.get(key);
      const taskIds = plan.taskIds === null ? null : [...new Set(plan.taskIds)];
      plans.set(key, { path: file, taskIds: prior && (prior.taskIds === null || taskIds === null)
        ? null : [...new Set([...(prior?.taskIds ?? []), ...(taskIds ?? [])])] });
      if (!prior && taskIds === null) plans.set(key, { path: file, taskIds: null });
    }
    stage.plans = [...plans.values()];
    for (const condition of [...stage.requires, ...stage.accepts]) {
      switch (condition.kind) {
        case 'receipt': {
          const file = roadmapFilePath(projectRoot, condition.path, 'receipt');
          const raw = readRoadmapFile(file);
          if (roadmapHash(raw) !== condition.sha256.toLowerCase()) throw new RoadmapError('HASH', file, 'receipt hash mismatch');
          const receipt = JSON.parse(raw);
          roadmapKeys(receipt, ['schemaVersion', 'result', 'operation', 'subjectHash', 'checkedAt'], file);
          if (receipt.schemaVersion !== 1 || !['pass', 'fail'].includes(receipt.result) || !roadmapTime(receipt.checkedAt)
            || receipt.operation !== condition.operation || receipt.subjectHash !== condition.subjectHash) {
            throw new RoadmapError('RECEIPT', file, 'receipt version/result/time/operation/subjectHash mismatch');
          }
          condition.path = file;
          condition.sha256 = roadmapHash(raw);
          evidence.receipts.push({ stageId: stage.id, path: file, sha256: roadmapHash(raw), receipt });
          break;
        }
        case 'stage': case 'decision': break;
        default: throw new RoadmapError('SCHEMA', stage.id, 'unsupported condition');
      }
    }
  }
  // Canonical aliases must not bypass the shared-plan rule.
  const checked = validateRoadmapProjection(projection);
  if (!checked.ok) {
    const first = checked.errors[0];
    throw new RoadmapError(first.code, first.path, first.message);
  }
  return { roadmapId: roadmapIdOf(projectionPath), projectionPath, projectRoot, projection,
    projectionHash: roadmapHash(text), evidence };
}
