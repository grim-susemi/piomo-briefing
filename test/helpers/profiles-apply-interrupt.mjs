// A separate process exits at real publication boundaries, bypassing apply's catch
// and rollback. Every path is a parent-created temporary fixture guarded here.
import './refuse-live-writes.mjs';
import fs from 'node:fs';
import { openProfilesStore } from '../../src/profiles/store.mjs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const published = [];
const targetIds = new Map(Object.entries(input.targetPaths).map(([id, file]) => [file, id]));
function interrupt() {
  fs.writeSync(1, JSON.stringify({ point: input.point, published }) + '\n');
  process.exit(91);
}
const store = openProfilesStore({
  ...input.options,
  now: () => Date.parse('2026-10-20T12:00:00Z'),
  fs: {
    ...fs,
    renameSync(from, to) {
      fs.renameSync(from, to);
      const id = targetIds.get(to);
      if (id) {
        let journal;
        try { journal = JSON.parse(fs.readFileSync(input.journalPath, 'utf8')); } catch { /* asserted below */ }
        if (journal?.status !== 'running' || !journal.preHashes || !journal.targets?.includes(id)) {
          fs.writeSync(2, 'target published without its durable interruption journal: ' + id + '\n');
          process.exit(92);
        }
        published.push(id);
        if (input.point === 'between-targets' && published.length === 1) interrupt();
        if (input.point === 'after-last' && published.length === targetIds.size) interrupt();
      }
      if (to === input.journalPath && input.point === 'before-first' && published.length === 0) interrupt();
    },
  },
});
const result = store.apply(input.request);
fs.writeSync(2, 'apply returned instead of interrupting: ' + JSON.stringify(result) + '\n');
process.exit(93);
