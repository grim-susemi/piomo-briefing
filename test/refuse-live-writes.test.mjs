// The live-home write guard (test/helpers/refuse-live-writes.mjs). npm test loads it with --import; this file does
// not import it, so a run without that preload fails here. Every refused write below would also fail without the
// guard (a parent folder or source that does not exist, a folder that already exists, a path below a file), so the
// test never relies on the guard to keep a live file safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteText, openProfilesStore, PLUGIN_DEFAULT } from '../src/profiles/store.mjs';

const REFUSED = { code: 'LIVE_HOME_WRITE_REFUSED' };
const callbackError = (start) => new Promise((resolve) => start((error) => resolve(error ?? null)));

test('npm test refuses every write under a live home before the disk is touched; reads and temp writes go through', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'row26-live-guard-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, 'src.txt');
  fs.writeFileSync(src, 'src');

  // A bare store is the extension's own call: no homes named, so its roots are the live homes.
  const { roots } = openProfilesStore();
  const homes = [roots.primaryHome, roots.stableHome, ...roots.mirrorHomes];
  const missing = (home) => path.join(home, 'row26-no-such-folder');
  const liveDir = missing(roots.primaryHome);
  const liveFile = path.join(liveDir, 'probe.txt');

  // writeFile, rename and mkdir, in their sync, callback and promise forms.
  assert.throws(() => fs.writeFileSync(liveFile, 'x'), REFUSED);
  assert.throws(() => fs.renameSync(src, liveFile), REFUSED);
  assert.throws(() => fs.mkdirSync(liveDir), REFUSED);
  assert.equal((await callbackError((done) => fs.writeFile(liveFile, 'x', done)))?.code, REFUSED.code);
  assert.equal((await callbackError((done) => fs.rename(src, liveFile, done)))?.code, REFUSED.code);
  assert.equal((await callbackError((done) => fs.mkdir(liveDir, done)))?.code, REFUSED.code);
  await assert.rejects(fsp.writeFile(liveFile, 'x'), REFUSED);
  await assert.rejects(fsp.rename(src, liveFile), REFUSED);
  await assert.rejects(fsp.mkdir(liveDir), REFUSED);

  // The other write forms, in the same three shapes. cp gets a missing source: with a real one it creates the folder
  // before it fails.
  const forms = {
    appendFile: [liveFile, 'x'], truncate: [liveFile], open: [liveFile, 'w'], copyFile: [src, liveFile],
    cp: [path.join(tmp, 'no-such-source'), liveFile], rm: [liveFile], rmdir: [liveDir], unlink: [liveFile],
    mkdtemp: [path.join(liveDir, 'x-')], link: [src, liveFile], symlink: [src, liveFile], utimes: [liveFile, 1, 1],
    chmod: [liveFile, 0o644],
  };
  for (const [name, args] of Object.entries(forms)) {
    assert.throws(() => fs[`${name}Sync`](...args), REFUSED, `${name}Sync`);
    assert.equal((await callbackError((done) => fs[name](...args, done)))?.code, REFUSED.code, name);
    await assert.rejects(fsp[name](...args), REFUSED, `promises.${name}`);
  }
  // A write stream reports a failed open as an event, so one that was not refused rejects with that event's error.
  await assert.rejects(async () => { await once(fs.createWriteStream(liveFile), 'open'); }, REFUSED, 'createWriteStream');
  // A link to a live path is a later way in.
  assert.throws(() => fs.linkSync(liveFile, path.join(tmp, 'hard')), REFUSED, 'hard link to a live path');
  assert.throws(() => fs.symlinkSync(liveFile, path.join(tmp, 'sym')), REFUSED, 'symlink to a live path');
  // Every home a bare store writes, another spelling of a live path, and the folder that holds the live homes.
  for (const home of homes) {
    assert.throws(() => fs.writeFileSync(path.join(missing(home), 'probe.txt'), 'x'), REFUSED, home);
  }
  const respelled = `${liveDir.toUpperCase().replace(/\\/g, '/')}/../row26-no-such-folder/probe.txt`;
  assert.throws(() => fs.writeFileSync(respelled, 'x'), REFUSED, 'case, slashes and ..');
  assert.throws(() => fs.mkdirSync(path.dirname(roots.primaryHome)), REFUSED, 'the folder that holds a live home');

  // The store's own writer, aimed below the live config file: even without the guard its mkdir fails there.
  for (const home of [roots.primaryHome, roots.stableHome]) {
    const config = path.join(home, 'omo.jsonc');
    const bytes = fs.readFileSync(config);
    assert.throws(() => atomicWriteText(path.join(config, 'probe.json'), '{}'), REFUSED, `the store writer under ${home}`);
    assert.deepEqual(fs.readFileSync(config), bytes);
  }
  for (const home of homes) assert.equal(fs.existsSync(missing(home)), false, `nothing was created under ${home}`);

  // A Node child gets the guard through NODE_OPTIONS, with no execArgv and another cwd (the cdp holder's shape).
  const write = `try { require('node:fs').writeFileSync(${JSON.stringify(liveFile)}, 'x'); } catch (error) { process.stdout.write(String(error.code)); }`;
  const child = spawnSync(process.execPath, ['-e', write], { cwd: tmp, encoding: 'utf8' });
  assert.equal(child.stdout, REFUSED.code, child.stderr);

  // Reads of a live file go through every open path.
  assert.ok(fs.readFileSync(PLUGIN_DEFAULT).length > 0);
  assert.ok((await fsp.readFile(PLUGIN_DEFAULT)).length > 0);
  fs.closeSync(fs.openSync(PLUGIN_DEFAULT, 'r'));
  fs.closeSync(await new Promise((resolve, reject) => fs.open(PLUGIN_DEFAULT, (error, fd) => (error ? reject(error) : resolve(fd)))));
  await (await fsp.open(PLUGIN_DEFAULT)).close();
  const reader = fs.createReadStream(PLUGIN_DEFAULT);
  await once(reader, 'open');
  reader.destroy();

  // Writes outside the live homes go through, in the same three forms.
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'a');
  fs.renameSync(path.join(tmp, 'a.txt'), path.join(tmp, 'b.txt'));
  fs.mkdirSync(path.join(tmp, 'sync-dir'));
  assert.equal(await callbackError((done) => fs.writeFile(path.join(tmp, 'c.txt'), 'c', done)), null);
  assert.equal(await callbackError((done) => fs.rename(path.join(tmp, 'c.txt'), path.join(tmp, 'd.txt'), done)), null);
  assert.equal(await callbackError((done) => fs.mkdir(path.join(tmp, 'callback-dir'), done)), null);
  await fsp.writeFile(path.join(tmp, 'e.txt'), 'e');
  await fsp.rename(path.join(tmp, 'e.txt'), path.join(tmp, 'f.txt'));
  await fsp.mkdir(path.join(tmp, 'promise-dir'));
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['b.txt', 'callback-dir', 'd.txt', 'f.txt', 'promise-dir', 'src.txt', 'sync-dir']);
});
