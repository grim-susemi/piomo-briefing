// Preloaded into a child process (node --import): logs, in call order, the target path of every
// fs.renameSync / fs.writeFileSync to the file named by env OMO_INSTALL_RECORD (one path per line).
import fs from 'node:fs';
import module from 'node:module';

const log = process.env.OMO_INSTALL_RECORD;
if (log) {
  const fd = fs.openSync(log, 'a'); // writeSync, not appendFileSync: that calls the wrapped writeFileSync
  const note = (p) => fs.writeSync(fd, String(p).replaceAll('\\', '/') + '\n');
  const rename = fs.renameSync;
  const write = fs.writeFileSync;
  fs.renameSync = function renameSync(from, to, ...rest) { note(to); return rename.call(this, from, to, ...rest); };
  fs.writeFileSync = function writeFileSync(file, ...rest) { if (typeof file !== 'number') note(file); return write.call(this, file, ...rest); };
  module.syncBuiltinESMExports();
}
