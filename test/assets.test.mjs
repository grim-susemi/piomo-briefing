import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { importImage, gcAssets, sniffImage, pathRefusal, referencedAssets, GC_AGE_MS, MAX_IMAGE_BYTES } from '../src/assets.mjs';
import { tempDir } from './helpers/temp.mjs';

// ---- image bytes written by the tests themselves (no binary fixtures) ----
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + 3 * Math.max(w, 1));
  const raw = Buffer.concat(Array.from({ length: Math.max(h, 1) }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function jpeg(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function riff(fourcc, payload) {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(12 + payload.length, 4); head.write('WEBP', 8, 'latin1');
  head.write(fourcc, 12, 'latin1'); head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload]);
}
function webpLossless(w, h) {
  const p = Buffer.alloc(16); p[0] = 0x2f; p.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1);
  return riff('VP8L', p);
}
function webpLossy(w, h) {
  const p = Buffer.alloc(16); p[3] = 0x9d; p[4] = 0x01; p[5] = 0x2a; p.writeUInt16LE(w, 6); p.writeUInt16LE(h, 8);
  return riff('VP8 ', p);
}
function webpExtended(w, h) {
  const p = Buffer.alloc(16); p.writeUIntLE(w - 1, 4, 3); p.writeUIntLE(h - 1, 7, 3);
  return riff('VP8X', p);
}

function setup(t) {
  const { dir } = tempDir(t, 'omo-assets-');
  const state = join(dir, 'state');
  const file = (name, bytes) => { const p = join(dir, name); fs.writeFileSync(p, bytes); return p; };
  return { dir, state, file };
}
const T0 = Date.UTC(2026, 9, 17, 0, 0, 0);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const listAssets = (state) => { try { return fs.readdirSync(join(state, 'assets')).sort(); } catch { return []; } };

test('(a) 2x2 PNG, JPEG and WebP written here import with the right w/h into assets/<sha256>.<ext>', (t) => {
  const s = setup(t);
  const cases = [
    ['a.png', png(2, 2), 'png', 'image/png'],
    ['b.jpg', jpeg(2, 2), 'jpg', 'image/jpeg'],
    ['c.webp', webpLossless(2, 2), 'webp', 'image/webp'],
    ['d.webp', webpLossy(2, 2), 'webp', 'image/webp'],
    ['e.webp', webpExtended(2, 2), 'webp', 'image/webp'],
  ];
  for (const [name, bytes, ext, mime] of cases) {
    const got = importImage(s.state, s.file(name, bytes), { now: () => T0 });
    assert.deepEqual(got, { sha: sha(bytes), ext, mime, bytes: bytes.length, w: 2, h: 2 }, name);
    const stored = join(s.state, 'assets', `${got.sha}.${ext}`);
    assert.ok(fs.readFileSync(stored).equals(bytes), `${name} copied byte for byte`);
    assert.equal(fs.statSync(stored).mtimeMs, T0, `${name} stamped with the import clock`);
  }
  assert.deepEqual(sniffImage(png(300, 7000)), { ext: 'png', mime: 'image/png', w: 300, h: 7000 });
  assert.deepEqual(sniffImage(jpeg(640, 480)), { ext: 'jpg', mime: 'image/jpeg', w: 640, h: 480 });
  assert.deepEqual(sniffImage(webpExtended(8192, 1)), { ext: 'webp', mime: 'image/webp', w: 8192, h: 1 });
  assert.equal(listAssets(s.state).filter((n) => n.endsWith('.tmp')).length, 0, 'no tmp file left');
});

test('(b) a .png-named text file, an SVG, a 9 MiB file and a UNC path are refused and nothing is stored', (t) => {
  const s = setup(t);
  const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>';
  const big = Buffer.alloc(9 * 1024 * 1024); png(2, 2).copy(big);
  const refused = {
    text: importImage(s.state, s.file('notes.png', 'just text, not an image')),
    svgByName: importImage(s.state, s.file('pic.svg', svgText)),
    svgAsPng: importImage(s.state, s.file('pic-svg.png', svgText)),
    gifAsPng: importImage(s.state, s.file('anim.png', Buffer.from('GIF89a\x02\x00\x02\x00\x00\x00\x00;', 'latin1'))),
    gifByName: importImage(s.state, s.file('anim.gif', png(2, 2))),
    big: importImage(s.state, s.file('big.png', big)),
    unc: importImage(s.state, '\\\\server\\share\\a.png'),
    uncSlash: importImage(s.state, '//server/share/a.png'),
  };
  assert.match(refused.text.error, /PNG·JPEG·WebP 그림 아님/);
  assert.match(refused.svgByName.error, /SVG·GIF/);
  assert.match(refused.svgAsPng.error, /PNG·JPEG·WebP 그림 아님/);
  assert.match(refused.gifAsPng.error, /PNG·JPEG·WebP 그림 아님/);
  assert.match(refused.gifByName.error, /SVG·GIF/);
  assert.match(refused.big.error, /8 MiB 초과\(9437184바이트\)/);
  assert.match(refused.unc.error, /UNC/);
  assert.match(refused.uncSlash.error, /UNC/);
  assert.ok(MAX_IMAGE_BYTES === 8 * 1024 * 1024);
  const exact = Buffer.alloc(MAX_IMAGE_BYTES); png(2, 2).copy(exact);
  assert.equal(importImage(s.state, s.file('exact.png', exact)).w, 2, 'exactly 8 MiB is accepted');
  assert.equal(listAssets(s.state).length, 1, 'only the 8 MiB file was stored');
});

test('malformed input: truncated headers, wrong magic, zero/oversized dimensions, directories and device paths', (t) => {
  const s = setup(t);
  const bad = (name, bytes) => importImage(s.state, s.file(name, bytes)).error;
  assert.match(bad('trunc.png', png(2, 2).subarray(0, 20)), /그림 아님/);
  const wrongChunk = png(2, 2); wrongChunk.write('IDAT', 12, 'latin1');
  assert.match(bad('chunk.png', wrongChunk), /PNG 헤더 손상/);
  assert.match(bad('nosof.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9])), /그림 크기 읽기 실패\(JPEG\)/);
  assert.match(bad('cut.jpg', jpeg(2, 2).subarray(0, 24)), /그림 크기 읽기 실패\(JPEG\)|JPEG 헤더 손상/);
  assert.match(bad('cut.webp', webpLossless(2, 2).subarray(0, 22)), /WebP/);
  assert.match(bad('magic.webp', Buffer.concat([Buffer.from('RIFX'), webpLossless(2, 2).subarray(4)])), /그림 아님/);
  assert.match(bad('zero.png', png(0, 2)), /그림 크기 0/);
  assert.match(bad('wide.png', png(8193, 1)), /8192 초과\(8193x1\)/);
  assert.match(bad('tall.jpg', jpeg(1, 9000)), /8192 초과/);
  assert.match(bad('huge.webp', webpExtended(16384, 2)), /8192 초과/);
  fs.mkdirSync(join(s.dir, 'folder.png'));
  assert.match(importImage(s.state, join(s.dir, 'folder.png')).error, /일반 파일 아님/);
  assert.match(importImage(s.state, join(s.dir, 'missing.png')).error, /읽을 수 없음\(ENOENT\)/);
  assert.match(importImage(s.state, 'C:\\x:stream').error, /대체 데이터 스트림/);
  assert.match(importImage(s.state, `${s.file('ads.png', png(2, 2))}:hidden`).error, /대체 데이터 스트림/);
  assert.match(importImage(s.state, '\\\\?\\C:\\x.png').error, /장치 경로/);
  assert.match(importImage(s.state, '\\\\.\\C:\\x.png').error, /장치 경로/);
  assert.match(importImage(s.state, 'C:\\dir\\nul.png').error, /예약 장치 이름/);
  assert.match(importImage(s.state, 'C:\\dir\\CON').error, /예약 장치 이름/);
  assert.match(importImage(s.state, 'rel/a.png').error, /절대경로 필요/);
  assert.match(importImage(s.state, `C:/${'a'.repeat(1030)}.png`).error, /1024자 초과/);
  assert.equal(pathRefusal(`C:/${'가'.repeat(1015)}.png`), null, '1024 code points (not bytes) is the limit');
  assert.match(pathRefusal('C:/a\u0000b.png'), /제어 문자/);
  assert.deepEqual(listAssets(s.state), [], 'nothing stored by any refusal');
});

test('a junction (or symlink when allowed) is refused, never followed', (t) => {
  const s = setup(t);
  const real = join(s.dir, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(join(real, 'a.png'), png(2, 2));
  const junction = join(s.dir, 'jn');
  fs.symlinkSync(real, junction, 'junction');
  assert.match(importImage(s.state, junction).error, /심볼릭 링크·정션 거절/);
  let linked = true;
  try { fs.symlinkSync(join(real, 'a.png'), join(s.dir, 'link.png'), 'file'); } catch (err) {
    if (err.code !== 'EPERM') throw err;
    linked = false; // file symlinks need a privilege on Windows; the junction above covers the lstat rule
  }
  if (linked) assert.match(importImage(s.state, join(s.dir, 'link.png')).error, /심볼릭 링크·정션 거절/);
  assert.deepEqual(listAssets(s.state), []);
});

test('stale_state: an existing asset is never overwritten; a re-import only refreshes its mtime', (t) => {
  const s = setup(t);
  const bytes = png(2, 2);
  const src = s.file('a.png', bytes);
  const first = importImage(s.state, src, { now: () => T0 });
  const dest = join(s.state, 'assets', `${first.sha}.png`);
  fs.writeFileSync(dest, 'SENTINEL - must survive');
  const again = importImage(s.state, src, { now: () => T0 + 5000 });
  assert.deepEqual(again, first);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'SENTINEL - must survive');
  assert.equal(fs.statSync(dest).mtimeMs, T0 + 5000);
});

function writeReports(state, sid, names) {
  fs.mkdirSync(join(state, 'sessions', sid), { recursive: true });
  const images = names.map((n) => { const [h, e] = n.split('.'); return { sha: h, ext: e, alt: 'x', path: 'C:/x' }; });
  fs.writeFileSync(join(state, 'sessions', sid, 'reports.json'), JSON.stringify([{ id: 'r', title: 't', images }]));
}
function seedAssets(s) {
  const mk = (w, at) => {
    const got = importImage(s.state, s.file(`img${w}.png`, png(w, 1)), { now: () => at });
    return `${got.sha}.png`;
  };
  const old = T0 - GC_AGE_MS - 1000;
  return { refOld: mk(1, old), unrefOld: mk(2, old), unrefNew: mk(3, T0 - 1000), refNew: mk(4, T0) };
}

test('(f) gc removes only unreferenced assets older than 24 h (injected clock) and releases assets.lock', (t) => {
  const s = setup(t);
  const a = seedAssets(s);
  writeReports(s.state, 's1', [a.refOld]);
  writeReports(s.state, 's2', [a.refNew]);
  assert.deepEqual([...referencedAssets(s.state)].sort(), [a.refOld, a.refNew].sort());
  const r = gcAssets(s.state, T0);
  assert.deepEqual(r, { removed: [a.unrefOld] });
  assert.deepEqual(listAssets(s.state), [a.refOld, a.refNew, a.unrefNew].sort());
  assert.equal(fs.existsSync(join(s.state, 'assets.lock')), false);
  // the same files a full day later: the 1 s-old one now ages out, the referenced ones stay
  assert.deepEqual(gcAssets(s.state, T0 + GC_AGE_MS + 1).removed, [a.unrefNew]);
  assert.deepEqual(listAssets(s.state), [a.refOld, a.refNew].sort());
});

test('gc deletes nothing when a reports.json cannot be read', (t) => {
  const s = setup(t);
  const a = seedAssets(s);
  fs.mkdirSync(join(s.state, 'sessions', 'bad'), { recursive: true });
  fs.writeFileSync(join(s.state, 'sessions', 'bad', 'reports.json'), '{broken');
  assert.deepEqual(gcAssets(s.state, T0 + 10 * GC_AGE_MS), { removed: [], skipped: 'unreadable' });
  assert.equal(listAssets(s.state).length, 4);
});

test('concurrency: a live assets.lock skips gc, a dead-owner or expired lock is taken over and released', (t) => {
  const s = setup(t);
  const a = seedAssets(s);
  writeReports(s.state, 's1', [a.refOld, a.refNew]);
  const lock = join(s.state, 'assets.lock');
  const held = JSON.stringify({ pid: process.pid, at: T0, nonce: 'other' });
  fs.writeFileSync(lock, held);
  assert.deepEqual(gcAssets(s.state, T0, { isAlive: () => true }), { removed: [], skipped: 'busy' });
  assert.equal(fs.readFileSync(lock, 'utf8'), held, 'a live lock is never removed');
  assert.equal(listAssets(s.state).length, 4);
  assert.deepEqual(gcAssets(s.state, T0, { isAlive: () => false }).removed, [a.unrefOld], 'dead owner: taken over');
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: T0 - 11 * 60 * 1000, nonce: 'old' }));
  assert.deepEqual(gcAssets(s.state, T0, { isAlive: () => true }), { removed: [] }, 'an expired lock is taken over');
  assert.equal(fs.existsSync(lock), false);
});

// Deterministic interleavings of an import with gc: the fs wrapper runs the import at an exact point inside gc.
function interleaved(at, name, run) {
  let fired = false;
  return new Proxy(fs, {
    get(target, prop) {
      if (prop !== at) return target[prop];
      return (...args) => {
        if (!fired && args.some((x) => String(x).includes(name))) { fired = true; run(); }
        return target[prop](...args);
      };
    },
  });
}

test('concurrency: an import that refreshes an old asset just before gc renames it keeps the asset', (t) => {
  const s = setup(t);
  const a = seedAssets(s);
  writeReports(s.state, 's1', [a.refOld, a.refNew]);
  const src = join(s.dir, 'img2.png'); // the bytes of unrefOld
  const fsx = interleaved('renameSync', a.unrefOld, () => importImage(s.state, src, { now: () => T0 }));
  const r = gcAssets(s.state, T0, { fs: fsx });
  assert.deepEqual(r.removed, [], 'the refreshed asset is put back, not removed');
  assert.ok(listAssets(s.state).includes(a.unrefOld));
  assert.deepEqual(listAssets(s.state).filter((n) => n.includes('.gc-')), [], 'no tombstone left');
});

test('concurrency: an import that runs after gc moved the asset aside stores a fresh copy', (t) => {
  const s = setup(t);
  const a = seedAssets(s);
  writeReports(s.state, 's1', [a.refOld, a.refNew]);
  const src = join(s.dir, 'img2.png');
  let imported;
  const fsx = interleaved('unlinkSync', a.unrefOld, () => { imported = importImage(s.state, src, { now: () => T0 }); });
  const r = gcAssets(s.state, T0, { fs: fsx });
  assert.equal(imported.sha + '.png', a.unrefOld);
  assert.deepEqual(r.removed, [a.unrefOld], 'gc removed its old tombstone');
  assert.ok(fs.readFileSync(join(s.state, 'assets', a.unrefOld)).equals(png(2, 1)), 'the import\'s copy is in place');
});

test('concurrency: two imports of the same bytes both succeed and store one file', (t) => {
  const s = setup(t);
  const src = s.file('a.png', png(2, 2));
  let inner;
  const fsx = interleaved('linkSync', '.png', () => { inner = importImage(s.state, src, { now: () => T0 }); });
  const outer = importImage(s.state, src, { fs: fsx, now: () => T0 });
  assert.deepEqual(outer, inner);
  assert.deepEqual(listAssets(s.state), [`${outer.sha}.png`]);
});
