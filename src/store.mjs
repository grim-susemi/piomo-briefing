// omo-briefing src/store.mjs - file store under STATE.
//
// - writeNew(rel, data): exclusive create (flag 'wx'), never overwrites; throws EEXIST.
// - replace(rel, data): tmp + rename, retrying EPERM/EBUSY/EACCES (20ms doubling, 8 retries).
// - readText(rel): string, or null if missing. On Windows a reader can briefly get ENOENT/EPERM/EBUSY/EACCES
//   while replace() swaps the target, so those are retried (<=~226ms) when a replace is plausibly in flight.
//   A file that is simply absent (no target, no tmp sibling) is reported missing immediately.
//   readText(rel, {maxBytes}) / readRecord(rel, {maxBytes}): a file over maxBytes is refused with code ETOOBIG (TOO_BIG_CODE) before
//   any of its content is read; absent is still null, unreadable still throws, transient errors are retried the same way.
// - allocDecisionId(record?): global monotonic id = max(decisions/*)+1, created with wx.
// - reclaimStale(rel, staleRecord): atomic recovery of a dead-pid lock/claim via hard-link tombstone.
// - readSnapshot(): the whole layout; broken JSON goes to readErrors, the rest is still read.
// - writePlanRev(planId, record): plans/<planId>/rev-NNNNNN.json, next number by wx (EEXIST -> next number, <=5 times),
//   then only the newest 10 revs are kept; a failed delete is RETURNED (pruneError), never thrown (the rev is saved).
// - readPlans(): per plan the newest rev + status.json (plans/<planId>/); writePlanStatus(): replace-write of status.json.
//
// This module only touches files under its root; it never touches `.omo/senpi-task`.
import * as nodeFs from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const TOO_BIG_CODE = 'ETOOBIG';
function tooBig(rel, bytes, limit) {
  return Object.assign(new Error(`${rel}: ${bytes} bytes exceed the ${limit}-byte limit`), { code: TOO_BIG_CODE, bytes, limit });
}
const FIRST_DELAY_MS = 20;
const MAX_RETRIES = 8;
// Reader backoff (ms) while a replace() may be in flight: 2+4+8+16+32+64+100 = 226ms total, then give up.
const READ_RETRY_DELAYS_MS = [2, 4, 8, 16, 32, 64, 100];
const BRIEFS_KEPT = 20;
const BRIEF_PATH = /^sessions\/([^/]+)\/briefs\/(\d+)\.json$/;
const NUMBERED = /^(\d+)\.json$/;
const PLAN_ID = /^p[0-9a-f]{12}$/;
const REV_FILE = /^rev-(\d{6,})\.json$/;
const REVS_KEPT = 10;
const REV_EEXIST_RETRIES = 5;

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but not ours
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const pad6 = (n) => String(n).padStart(6, '0');

function serialize(data) {
  if (typeof data === 'string' || data instanceof Uint8Array) return data;
  return JSON.stringify(data, null, 2) + '\n';
}

/**
 * @param {string} root store folder (created lazily on first write)
 * @param {{fs?: object, sleep?: (ms:number)=>void, isAlive?: (pid:number)=>boolean}} [opts]
 */
export function openStore(root, opts = {}) {
  const fs = opts.fs ?? nodeFs;
  const sleep = opts.sleep ?? sleepSync;
  const isAlive = opts.isAlive ?? isPidAlive;

  function abs(rel) {
    if (typeof rel !== 'string' || rel === '') throw new Error('invalid store path: ' + rel);
    const parts = rel.split(/[\\/]/);
    if (/^[a-zA-Z]:/.test(parts[0]) || parts.some((p) => p === '' || p === '.' || p === '..' || p === 'senpi-task' || p.includes(':'))) {
      throw new Error('invalid store path: ' + rel);
    }
    return join(root, ...parts);
  }
  const mkParent = (file) => fs.mkdirSync(join(file, '..'), { recursive: true });
  const isMissing = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

  function writeNew(rel, data) {
    const file = abs(rel);
    mkParent(file);
    fs.writeFileSync(file, serialize(data), { flag: 'wx' });
    const m = BRIEF_PATH.exec(rel.replace(/\\/g, '/'));
    if (m) pruneBriefs(join(file, '..'));
  }

  function pruneBriefs(dir) {
    const seqs = listNumbered(dir).sort((x, y) => x.n - y.n);
    for (const old of seqs.slice(0, Math.max(0, seqs.length - BRIEFS_KEPT))) {
      try { fs.unlinkSync(join(dir, old.name)); } catch (err) { if (!isMissing(err)) throw err; }
    }
  }

  function replace(rel, data) {
    const file = abs(rel);
    mkParent(file);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, serialize(data));
      let delay = FIRST_DELAY_MS;
      for (let attempt = 0; ; attempt++) {
        try {
          fs.renameSync(tmp, file);
          return;
        } catch (err) {
          if (!RETRY_CODES.has(err.code) || attempt >= MAX_RETRIES) throw err;
          sleep(delay);
          delay *= 2;
        }
      }
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (e) { if (!isMissing(e)) throw e; }
      throw err;
    }
  }

  // True if the target or a replace() tmp sibling is listed in its folder: a replace may be swapping it right now.
  function replaceMayBeInFlight(file) {
    const base = basename(file);
    try {
      return fs.readdirSync(dirname(file)).some((n) => n === base || (n.startsWith(base + '.') && n.endsWith('.tmp')));
    } catch {
      return false;
    }
  }

  // A bounded read: the size comes from fstat of the opened file and a file over `maxBytes` is refused before any of its content
  // is read. At most size+1 <= maxBytes+1 bytes are requested; the spare byte shows a file that grew since fstat (got > size): that
  // is a torn read, reported as EBUSY so the retry loop below reads it again (and the next fstat applies the limit to the new size).
  function readBounded(file, rel, maxBytes) {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > maxBytes) throw tooBig(rel, size, maxBytes);
      const buffer = Buffer.alloc(size + 1);
      let got = 0;
      while (got < buffer.length) {
        const n = fs.readSync(fd, buffer, got, buffer.length - got, got);
        if (n === 0) break;
        got += n;
      }
      if (got > size) throw Object.assign(new Error(`${rel}: changed while it was read`), { code: 'EBUSY' });
      return buffer.toString('utf8', 0, got);
    } finally {
      fs.closeSync(fd);
    }
  }

  function readText(rel, { maxBytes } = {}) {
    const file = abs(rel);
    for (let attempt = 0; ; attempt++) {
      try {
        return maxBytes === undefined ? fs.readFileSync(file, 'utf8') : readBounded(file, rel, maxBytes);
      } catch (err) {
        const transient = RETRY_CODES.has(err.code) || (err.code === 'ENOENT' && replaceMayBeInFlight(file));
        if (transient && attempt < READ_RETRY_DELAYS_MS.length) {
          sleep(READ_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        if (isMissing(err)) return null;
        throw err;
      }
    }
  }

  function readRecord(rel, limits) {
    try {
      const text = readText(rel, limits);
      if (text === null) return null;
      const rec = JSON.parse(text);
      return rec && typeof rec === 'object' ? rec : null;
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  function reclaimStale(rel, staleRecord) {
    // Unreadable/empty record = maybe still being written = alive. Live pid = never stale.
    if (!staleRecord || typeof staleRecord !== 'object' || !staleRecord.nonce || !Number.isInteger(staleRecord.pid)) return false;
    if (isAlive(staleRecord.pid)) return false;
    const file = abs(rel);
    const tomb = `${file}.stale-${staleRecord.nonce}`;
    try {
      fs.linkSync(file, tomb);
    } catch (err) {
      if (err.code === 'EEXIST' || isMissing(err)) return false; // someone else reclaimed it / it is gone
      const e = new Error(`오래된 선점 - 수동 확인 필요: ${rel} (${err.code || err.message})`);
      e.code = err.code;
      throw e;
    }
    let tombRec = null;
    try { tombRec = JSON.parse(fs.readFileSync(tomb, 'utf8')); } catch { /* unreadable -> mismatch */ }
    const same = tombRec && tombRec.pid === staleRecord.pid && tombRec.at === staleRecord.at && tombRec.nonce === staleRecord.nonce;
    if (!same) {
      try { fs.unlinkSync(tomb); } catch (err) { if (!isMissing(err)) throw err; }
      return false;
    }
    try { fs.unlinkSync(file); } catch (err) { if (!isMissing(err)) throw err; }
    return true; // the matching tombstone stays on purpose
  }

  function listNumbered(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (err) { if (isMissing(err)) return []; throw err; }
    const out = [];
    for (const name of names) {
      const m = NUMBERED.exec(name);
      if (m) out.push({ name, n: Number(m[1]) });
    }
    return out;
  }

  function allocDecisionId(record = {}) {
    const dir = abs('decisions');
    fs.mkdirSync(dir, { recursive: true });
    let id = listNumbered(dir).reduce((max, e) => Math.max(max, e.n), 0) + 1;
    for (;;) {
      try {
        fs.writeFileSync(join(dir, pad6(id) + '.json'), serialize({ ...record, id }), { flag: 'wx' });
        return id;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        id++;
      }
    }
  }

  function planDir(planId) {
    if (typeof planId !== 'string' || !PLAN_ID.test(planId)) throw new Error('invalid planId: ' + planId);
    return `plans/${planId}`;
  }

  function listRevs(planId) {
    let names;
    try { names = fs.readdirSync(abs(planDir(planId))); } catch (err) { if (isMissing(err)) return []; throw err; }
    const out = [];
    for (const name of names) {
      const m = REV_FILE.exec(name);
      if (m) out.push({ name, n: Number(m[1]) });
    }
    return out.sort((x, y) => x.n - y.n);
  }

  // Keeps the newest REVS_KEPT revs. Returns the first delete error (the other deletes are still tried), or null.
  function prunePlanRevs(planId) {
    const revs = listRevs(planId);
    let failure = null;
    for (const old of revs.slice(0, Math.max(0, revs.length - REVS_KEPT))) {
      try { fs.unlinkSync(abs(`${planDir(planId)}/${old.name}`)); } catch (err) { if (!isMissing(err) && failure === null) failure = err; }
    }
    return failure;
  }

  /** @returns {{rev:number, rel:string, pruneError:Error|null}} throws if no number could be taken or the write fails */
  function writePlanRev(planId, record) {
    const dir = planDir(planId);
    let rev = listRevs(planId).reduce((max, e) => Math.max(max, e.n), 0) + 1;
    for (let attempt = 0; ; attempt++) {
      const rel = `${dir}/rev-${pad6(rev)}.json`;
      try {
        writeNew(rel, { ...record, rev });
        return { rev, rel, pruneError: prunePlanRevs(planId) };
      } catch (err) {
        if (err.code !== 'EEXIST' || attempt >= REV_EEXIST_RETRIES) throw err;
        // someone else took this number (another process): look again, never reuse or overwrite
        rev = Math.max(rev + 1, listRevs(planId).reduce((max, e) => Math.max(max, e.n), 0) + 1);
      }
    }
  }

  function writePlanStatus(planId, status) {
    replace(`${planDir(planId)}/status.json`, status);
  }

  function nextBriefSeq(sid) {
    return listNumbered(abs(`sessions/${sid}/briefs`)).reduce((max, e) => Math.max(max, e.n), 0) + 1;
  }

  function readSettings() {
    const rec = readRecord('settings.json');
    return { ...(rec ?? {}), enabled: rec ? rec.enabled !== false : true };
  }

  function writeSettings(settings) {
    replace('settings.json', { ...settings, enabled: settings.enabled !== false });
  }

  function makeReader() {
    const readErrors = [];
    let maxMtime = 0;

    // Reads one JSON file; returns the parsed value, or undefined if missing/broken (broken -> readErrors).
    // countMtime=false for our own published output, so a publish never makes the store look newer.
    function load(rel, countMtime = true) {
      const file = abs(rel);
      const touch = () => {
        if (!countMtime) return;
        try { const mt = fs.statSync(file).mtimeMs; if (mt > maxMtime) maxMtime = mt; } catch { /* gone */ }
      };
      try {
        const text = readText(rel);
        if (text === null) return undefined;
        const value = JSON.parse(text);
        touch();
        return value;
      } catch (err) {
        readErrors.push({ rel, message: String(err && err.message || err) });
        touch();
        return undefined;
      }
    }
    const names = (relDir, re) => {
      try { return fs.readdirSync(abs(relDir)).filter((n) => re.test(n)).sort(); }
      catch (err) { if (isMissing(err)) return []; throw err; }
    };
    const dirs = (relDir) => {
      try { return fs.readdirSync(abs(relDir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
      catch (err) { if (isMissing(err)) return []; throw err; }
    };
    return { readErrors, load, names, dirs, maxMtime: () => maxMtime };
  }

  // Newest rev + status.json per plan folder. A file that cannot be read/parsed is reported in that plan's readErrors
  // (and the reader's), never turned into 'no rev'.
  function collectPlans({ readErrors, load, names, dirs }) {
    return dirs('plans').filter((id) => PLAN_ID.test(id)).map((planId) => {
      const before = readErrors.length;
      const newest = names(`plans/${planId}`, REV_FILE)
        .map((name) => ({ name, n: Number(REV_FILE.exec(name)[1]) }))
        .sort((x, y) => y.n - x.n)[0];
      const rev = newest ? load(`plans/${planId}/${newest.name}`) ?? null : null;
      const status = load(`plans/${planId}/status.json`) ?? null;
      return { planId, rev, status, readErrors: readErrors.slice(before) };
    });
  }

  function readPlans() {
    return collectPlans(makeReader());
  }

  function readSnapshot() {
    const reader = makeReader();
    const { readErrors, load, names, dirs } = reader;
    const byId = (relDir) => names(relDir, NUMBERED)
      .map((name) => ({ n: Number(NUMBERED.exec(name)[1]), v: load(`${relDir}/${name}`) }))
      .filter((e) => e.v !== undefined)
      .sort((x, y) => x.n - y.n)
      .map((e) => e.v);

    const settingsRaw = load('settings.json');
    const settings = { ...(settingsRaw && typeof settingsRaw === 'object' ? settingsRaw : {}), enabled: !(settingsRaw && settingsRaw.enabled === false) };

    const sessions = dirs('sessions').map((sid) => {
      const meta = load(`sessions/${sid}/meta.json`) ?? null;
      const briefs = names(`sessions/${sid}/briefs`, NUMBERED)
        .map((name) => ({ seq: Number(NUMBERED.exec(name)[1]), data: load(`sessions/${sid}/briefs/${name}`) }))
        .filter((b) => b.data !== undefined)
        .sort((x, y) => x.seq - y.seq);
      return { sid, meta, briefs };
    });

    const mirror = names('mirror', /\.json$/)
      .map((n) => ({ sid: n.slice(0, -5), data: load(`mirror/${n}`) }))
      .filter((m) => m.data !== undefined);

    const plans = collectPlans(reader);
    const published = load('published.json', false) ?? null;
    return {
      settings,
      sessions,
      decisions: byId('decisions'),
      closures: byId('decision-closures'),
      answers: byId('answers'),
      claims: byId('claims'),
      receipts: byId('receipts'),
      mirror,
      plans,
      published,
      readErrors,
      maxMtime: reader.maxMtime(),
    };
  }

  return { root, writeNew, replace, readText, readRecord, reclaimStale, allocDecisionId, nextBriefSeq, readSnapshot, readSettings, writeSettings, writePlanRev, writePlanStatus, readPlans };
}
