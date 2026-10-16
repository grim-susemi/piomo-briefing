// briefing/state audit of the plan-view integration run (plan todo 14). READ-only.
//   inventoryDir(dir)  -> { '<relative path>': { size, sha256 } } for every regular file under dir
//   auditState({ before, stateDir, ids }) -> { pass, leaks[], concurrentOwnerChanges: { added, removed, changed }, ... }
//   auditAnswers({ stateDir, ownerId, otherIds, expected }) -> { pass, answers, receipts, provenForOwner, forOthers, problems[] }
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

/**
 * Answer/receipt audit of the board-answer scenario (plan todo 10). `stateDir` is the briefing state of the run.
 * Passes only when there are exactly `expected` answers and `expected` receipts, every answer belongs to a decision of
 * `ownerId` and has a receipt that is proven:true and names `ownerId`, and nothing is answered for or received by `otherIds`.
 */
export function auditAnswers({ stateDir, ownerId, otherIds = [], expected }) {
  const readJson = (rel) => { try { return JSON.parse(fs.readFileSync(`${stateDir}/${rel}`, 'utf8')); } catch { return null; } };
  const names = (dir) => { try { return fs.readdirSync(`${stateDir}/${dir}`).filter((n) => /^\d{6}\.json$/.test(n)).sort(); } catch { return []; } };
  const answers = names('answers');
  const receipts = names('receipts');
  const problems = [];
  let provenForOwner = 0;
  let forOthers = 0;
  if (answers.length !== expected) problems.push(`expected ${expected} answers, found ${answers.length}`);
  if (receipts.length !== expected) problems.push(`expected ${expected} receipts, found ${receipts.length}`);
  for (const name of answers) {
    const decision = readJson(`decisions/${name}`);
    const receipt = readJson(`receipts/${name}`);
    if (!decision) problems.push(`${name}: answer without a decision`);
    else if (otherIds.includes(decision.sessionId)) { forOthers++; problems.push(`${name}: answered decision belongs to another conversation ${decision.sessionId}`); }
    else if (decision.sessionId !== ownerId) problems.push(`${name}: decision belongs to ${decision.sessionId}, not the owner`);
    if (!receipt) problems.push(`${name}: no receipt`);
    else if (receipt.proven !== true) problems.push(`${name}: receipt is not proven`);
    else if (receipt.sessionId !== ownerId) problems.push(`${name}: receipt names ${receipt.sessionId}, not the owner`);
    else if (decision && decision.sessionId === ownerId) provenForOwner++;
  }
  for (const name of receipts) {
    const receipt = readJson(`receipts/${name}`);
    if (!answers.includes(name)) problems.push(`${name}: receipt without an answer`);
    if (receipt && otherIds.includes(receipt.sessionId)) { forOthers++; problems.push(`${name}: receipt names another conversation ${receipt.sessionId}`); }
  }
  return { pass: problems.length === 0, answers: answers.length, receipts: receipts.length, provenForOwner, forOthers, problems };
}
