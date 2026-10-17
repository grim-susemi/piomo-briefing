// omo-briefing src/assets.mjs - report images: path checks, magic-byte sniff, hashed copy into STATE/assets, clean-up.
//
// - pathRefusal(p): the per-field refusal text of an image path (null = acceptable); no file access.
// - sniffImage(buf): {ext, mime, w, h} | {error}. PNG (IHDR), JPEG (SOFn), WebP (VP8 / VP8L / VP8X); SVG and GIF never match.
// - importImage(stateDir, absPath, {fs, now}): reads one regular file of <= 8 MiB (symlinks and directories refused),
//   sniffs it and copies it to STATE/assets/<sha256>.<ext> through a tmp file + link(), so the name appears atomically and an
//   existing asset is never overwritten (EEXIST = the same bytes are already there). Reusing an existing asset refreshes
//   its mtime, so a concurrent clean-up never sees it as old. -> {sha, ext, mime, bytes, w, h} | {error}
// - referencedAssets(stateDir, {fs}): Set of '<sha>.<ext>' named by any sessions/*/reports.json, or null when one of them
//   cannot be read (then nothing may be deleted).
// - gcAssets(stateDir, now, {fs, isAlive}): under STATE/assets.lock (created with 'wx'; a lock of a dead pid or older
//   than LOCK_STALE_MS is taken over) deletes assets that no reports.json references and whose mtime is older than 24 h.
//   A candidate is first renamed to a tombstone and its mtime checked again, so an import that refreshed it meanwhile
//   wins (the tombstone is linked back). -> {removed: string[], skipped?: 'busy'|'unreadable'}
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isPidAlive } from './store.mjs';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_DIM = 8192;
export const MAX_PATH_CP = 1024;
export const GC_AGE_MS = 24 * 3600 * 1000;
export const LOCK_STALE_MS = 10 * 60 * 1000;
export const ASSET_NAME_RE = /^([0-9a-f]{64})\.(png|jpg|webp)$/;
export const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const ABS_RE = /^[A-Za-z]:[\\/]/;
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\.[^\\/]*)?$/i;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LOCK = 'assets.lock';

export function pathRefusal(p) {
  if (typeof p !== 'string') return '문자열 필요';
  const n = [...p].length;
  if (n > MAX_PATH_CP) return `${MAX_PATH_CP}자 초과(${n})`;
  if (/[\x00-\x1f]/.test(p)) return '제어 문자 거절';
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return '장치 경로 거절(\\\\?\\, \\\\.\\)';
  if (/^[\\/]{2}/.test(p)) return 'UNC 경로 거절(\\\\)';
  if (!ABS_RE.test(p)) return '절대경로 필요';
  if (p.slice(2).includes(':')) return '대체 데이터 스트림 거절(드라이브 뒤 :)';
  if (p.split(/[\\/]/).some((part) => DEVICE_NAME_RE.test(part.replace(/[ .]+$/, '')))) return '장치 경로 거절(예약 장치 이름)';
  if (/\.(svg|svgz|gif)$/i.test(p)) return 'SVG·GIF는 받지 않음(PNG·JPEG·WebP만)';
  return null;
}

function dims(ext, w, h) {
  if (!(w > 0 && h > 0)) return { error: `그림 크기 0(${w}x${h})` };
  if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) return { error: `그림 크기 ${MAX_IMAGE_DIM} 초과(${w}x${h})` };
  return { ext, mime: MIME[ext], w, h };
}

function sniffJpeg(buf) {
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return { error: 'JPEG 헤더 손상' };
    let m = buf[pos + 1];
    while (m === 0xff && pos + 2 < buf.length) { pos += 1; m = buf[pos + 1]; } // fill bytes
    pos += 2;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue; // stand-alone markers
    if (m === 0xd9 || m === 0xda) break; // end of image / start of scan before any frame header
    if (pos + 2 > buf.length) break;
    const segLen = buf.readUInt16BE(pos);
    if (segLen < 2) return { error: 'JPEG 헤더 손상' };
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      if (segLen < 7 || pos + 7 > buf.length) return { error: '그림 크기 읽기 실패(JPEG)' };
      return dims('jpg', buf.readUInt16BE(pos + 5), buf.readUInt16BE(pos + 3));
    }
    pos += segLen;
  }
  return { error: '그림 크기 읽기 실패(JPEG)' };
}

function sniffWebp(buf) {
  if (buf.length < 30) return { error: '그림 크기 읽기 실패(WebP)' };
  const kind = buf.toString('latin1', 12, 16);
  if (kind === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return { error: 'WebP 헤더 손상' };
    return dims('webp', buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  }
  if (kind === 'VP8L') {
    if (buf[20] !== 0x2f) return { error: 'WebP 헤더 손상' };
    const b = buf.readUInt32LE(21);
    return dims('webp', (b & 0x3fff) + 1, ((b >>> 14) & 0x3fff) + 1);
  }
  if (kind === 'VP8X') return dims('webp', buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
  return { error: 'WebP 헤더 손상' };
}

export function sniffImage(buf) {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG)) {
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return { error: 'PNG 헤더 손상' };
    return dims('png', buf.readUInt32BE(16), buf.readUInt32BE(20));
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return sniffJpeg(buf);
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return sniffWebp(buf);
  return { error: 'PNG·JPEG·WebP 그림 아님(내용 기준, SVG·GIF 거절)' };
}

// Reads at most MAX_IMAGE_BYTES of a regular file; the size comes from fstat of the opened file.
function readImage(fs, absPath) {
  let st;
  try { st = fs.lstatSync(absPath); } catch (err) { return { error: `읽을 수 없음(${err.code || err.message})` }; }
  if (st.isSymbolicLink()) return { error: '심볼릭 링크·정션 거절' };
  if (!st.isFile()) return { error: '일반 파일 아님' };
  let fd;
  try { fd = fs.openSync(absPath, 'r'); } catch (err) { return { error: `읽을 수 없음(${err.code || err.message})` }; }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return { error: '일반 파일 아님' };
    if (fst.size > MAX_IMAGE_BYTES) return { error: `8 MiB 초과(${fst.size}바이트)` };
    const buf = Buffer.alloc(fst.size + 1);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    if (got > fst.size) return { error: '읽는 중에 파일이 바뀜' };
    return { buf: buf.subarray(0, got) };
  } finally {
    fs.closeSync(fd);
  }
}

export function importImage(stateDir, absPath, { fs = nodeFs, now = Date.now } = {}) {
  const refusal = pathRefusal(absPath);
  if (refusal) return { error: refusal };
  const read = readImage(fs, absPath);
  if (read.error) return read;
  const kind = sniffImage(read.buf);
  if (kind.error) return kind;
  const sha = createHash('sha256').update(read.buf).digest('hex');
  const dir = join(stateDir, 'assets');
  const dest = join(dir, `${sha}.${kind.ext}`);
  const result = { sha, ext: kind.ext, mime: kind.mime, bytes: read.buf.length, w: kind.w, h: kind.h };
  const at = new Date(now());
  try {
    fs.utimesSync(dest, at, at); // already stored: never rewritten, only marked as fresh
    return result;
  } catch (err) {
    if (err.code !== 'ENOENT') return { error: `저장 실패(${err.code || err.message})` };
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, read.buf, { flag: 'wx' });
    fs.utimesSync(tmp, at, at);
    try {
      fs.linkSync(tmp, dest);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err; // EEXIST: a racing import stored the same bytes first
      fs.utimesSync(dest, at, at);
    }
    return result;
  } catch (err) {
    return { error: `저장 실패(${err.code || err.message})` };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* never created or already gone */ }
  }
}

export function referencedAssets(stateDir, { fs = nodeFs } = {}) {
  const refs = new Set();
  let sids;
  try { sids = fs.readdirSync(join(stateDir, 'sessions')); } catch (err) { return err.code === 'ENOENT' ? refs : null; }
  for (const sid of sids) {
    let text;
    try { text = fs.readFileSync(join(stateDir, 'sessions', sid, 'reports.json'), 'utf8'); } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
      return null;
    }
    let reports;
    try { reports = JSON.parse(text); } catch { return null; }
    if (!Array.isArray(reports)) return null;
    for (const r of reports) {
      for (const img of Array.isArray(r?.images) ? r.images : []) {
        const name = `${img?.sha}.${img?.ext}`;
        if (ASSET_NAME_RE.test(name)) refs.add(name);
      }
    }
  }
  return refs;
}

function takeLock(fs, stateDir, now, isAlive) {
  const file = join(stateDir, LOCK);
  const rec = JSON.stringify({ pid: process.pid, at: now, nonce: randomBytes(8).toString('hex') });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, rec, { flag: 'wx' });
      return { file, rec };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cur = null; }
    const stale = cur && Number.isInteger(cur.pid) && typeof cur.at === 'number'
      && (!isAlive(cur.pid) || now - cur.at > LOCK_STALE_MS);
    if (!stale || attempt > 0) return null;
    try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') return null; }
  }
  return null;
}

export function gcAssets(stateDir, now = Date.now(), { fs = nodeFs, isAlive = isPidAlive } = {}) {
  const lock = takeLock(fs, stateDir, now, isAlive);
  if (!lock) return { removed: [], skipped: 'busy' };
  const removed = [];
  try {
    const refs = referencedAssets(stateDir, { fs });
    if (refs === null) return { removed, skipped: 'unreadable' };
    const dir = join(stateDir, 'assets');
    let names;
    try { names = fs.readdirSync(dir); } catch (err) { if (err.code === 'ENOENT') return { removed }; throw err; }
    const old = (file) => {
      try { return now - fs.statSync(file).mtimeMs > GC_AGE_MS; } catch { return false; }
    };
    for (const name of names.sort()) {
      const file = join(dir, name);
      const tmpLeft = name.endsWith('.tmp');
      if (!tmpLeft && (!ASSET_NAME_RE.test(name) || refs.has(name))) continue;
      if (!old(file)) continue;
      if (tmpLeft) {
        try { fs.unlinkSync(file); removed.push(name); } catch { /* in use: next time */ }
        continue;
      }
      const tomb = `${file}.gc-${randomBytes(4).toString('hex')}`;
      try { fs.renameSync(file, tomb); } catch { continue; }
      if (!old(tomb)) {
        // an import refreshed it between the two looks: put it back (EEXIST = the import stored a new copy meanwhile)
        try { fs.linkSync(tomb, file); } catch { /* same bytes already there */ }
      } else {
        removed.push(name);
      }
      try { fs.unlinkSync(tomb); } catch { /* leftover tomb is harmless */ }
    }
    return { removed };
  } finally {
    try {
      if (fs.readFileSync(lock.file, 'utf8') === lock.rec) fs.unlinkSync(lock.file);
    } catch { /* already gone */ }
  }
}
