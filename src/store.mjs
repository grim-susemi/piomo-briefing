// omo-briefing src/store.mjs - file store under STATE.
//
// - writeNew(rel, data): exclusive create (flag 'wx'), never overwrites; throws EEXIST.
// - replace(rel, data): tmp + rename, retrying EPERM/EBUSY/EACCES (20ms doubling, 8 retries).
// - readText(rel): string, or null if missing. On Windows a reader can briefly get ENOENT/EPERM/EBUSY/EACCES
//   while replace() swaps the target, so those are retried (<=~226ms) when a replace is plausibly in flight.
//   A file that is simply absent (no target, no tmp sibling) is reported missing immediately.
// - allocDecisionId(record?): global monotonic id = max(decisions/*)+1, created with wx.
// - reclaimStale(rel, staleRecord): atomic recovery of a dead-pid lock/claim via hard-link tombstone.
// - readSnapshot(): the whole layout; broken JSON goes to readErrors, the rest is still read.
//
// This module only touches files under its root; it never touches `.omo/senpi-task`.
import * as nodeFs from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const FIRST_DELAY_MS = 20;
const MAX_RETRIES = 8;
// Reader backoff (ms) while a replace() may be in flight: 2+4+8+16+32+64+100 = 226ms total, then give up.
const READ_RETRY_DELAYS_MS = [2, 4, 8, 16, 32, 64, 100];
const BRIEFS_KEPT = 20;
const BRIEF_PATH = /^sessions\/([^/]+)\/briefs\/(\d+)\.json$/;
const NUMBERED = /^(\d+)\.json$/;

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

  function readText(rel) {
    const file = abs(rel);
    for (let attempt = 0; ; attempt++) {
      try {
        return fs.readFileSync(file, 'utf8');
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

  function readRecord(rel) {
    try {
      const text = readText(rel);
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

  function readSnapshot() {
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
      published,
      readErrors,
      maxMtime,
    };
  }

  return { root, writeNew, replace, readText, readRecord, reclaimStale, allocDecisionId, nextBriefSeq, readSnapshot, readSettings, writeSettings };
}
