// Child process used by test/extension-live.test.mjs (not a test file): holds STATE/render.lock like another conversation
// that is busy publishing. argv: stateDir holdMs. holdMs > 0: release by itself after that long; 0: until told {cmd:'release'}.
// Messages to the parent: {type:'held'} once the lock exists, {type:'released'} once it is removed (own content only).
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../../src/store.mjs';

const [stateDir, holdMs] = process.argv.slice(2);
const store = openStore(stateDir);
const rec = { pid: process.pid, at: Date.now(), nonce: `holder-${process.pid}` };
store.writeNew('render.lock', rec);

function release() {
  const cur = store.readRecord('render.lock');
  if (cur && cur.nonce === rec.nonce) unlinkSync(join(stateDir, 'render.lock'));
  process.send({ type: 'released' }, () => process.exit(0));
}

if (Number(holdMs) > 0) setTimeout(release, Number(holdMs));
process.on('message', (m) => { if (m && m.cmd === 'release') release(); });
process.on('disconnect', () => process.exit(0));
process.send({ type: 'held' });
