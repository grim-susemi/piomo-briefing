// briefing/state audit of the plan-view integration run (plan todo 14). READ-only.
//   inventoryDir(dir)  -> { '<relative path>': { size, sha256 } } for every regular file under dir
//   auditState({ before, stateDir, ids }) -> { pass, leaks[], concurrentOwnerChanges: { added, removed, changed }, ... }
// `leaks` = a test-created identifier (session/plan/worker ids, temp paths) found in the NAME or CONTENT of any file that
// exists after the run. `concurrentOwnerChanges` = every path that differs between the two snapshots: the owner's own live
// conversations publish into this folder during a run, so these are reported, never hidden, and they do not fail `pass`.
import fs from 'node:fs';
import crypto from 'node:crypto';

export function inventoryDir(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        const bytes = fs.readFileSync(p);
        out[r] = { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      }
    }
  })(dir, '');
  return out;
}

// forward- and backslash spellings of every id (temp paths appear in both forms)
const spellings = (id) => [...new Set([id, id.replace(/\//g, '\\'), id.replace(/\\/g, '/')])];

export function auditState({ before, stateDir, ids }) {
  const after = inventoryDir(stateDir);
  const wanted = [...new Set(ids.filter((i) => typeof i === 'string' && i.length >= 6))];
  const leaks = [];
  for (const rel of Object.keys(after).sort()) {
    const name = rel.toLowerCase();
    let text = null;
    for (const id of wanted) {
      for (const s of spellings(id)) {
        if (name.includes(s.toLowerCase())) { leaks.push({ kind: 'name', id, path: rel }); break; }
      }
      text ??= fs.readFileSync(`${stateDir}/${rel}`).toString('latin1'); // binary-safe; ids are ASCII
      const lower = text.toLowerCase();
      for (const s of spellings(id)) {
        if (lower.includes(s.toLowerCase()) || lower.includes(s.toLowerCase().replace(/\\/g, '\\\\'))) { leaks.push({ kind: 'content', id, path: rel }); break; }
      }
    }
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const added = [];
  const removed = [];
  const changed = [];
  for (const k of [...keys].sort()) {
    if (!(k in before)) added.push(k);
    else if (!(k in after)) removed.push(k);
    else if (before[k].sha256 !== after[k].sha256 || before[k].size !== after[k].size) changed.push(k);
  }
  return { pass: leaks.length === 0, leaks, concurrentOwnerChanges: { added, removed, changed }, filesAfter: Object.keys(after).length, after };
}
