// Child process used by test/render.test.mjs (not a test file itself).
// argv: root sid count. Waits for {type:'go'}, then per round writes a brief for `sid`
// and calls renderPage; reports every published seq back to the parent.
import { openStore } from '../../src/store.mjs';
import { renderPage } from '../../src/render.mjs';

const [root, sid, countArg] = process.argv.slice(2);
const count = Number(countArg);
const store = openStore(root);

process.on('message', (m) => {
  if (m.type !== 'go') return;
  try {
    const rounds = [];
    for (let i = 1; i <= count; i++) {
      const at = Date.now();
      store.writeNew(`sessions/${sid}/briefs/${String(store.nextBriefSeq(sid)).padStart(6, '0')}.json`, {
        at,
        brief: { title: sid, status: 'in_progress', headline: `${sid}-${i}`, changes: [], done: [], next: '', decisions: [] },
      });
      const r = renderPage(store, at, { sessionId: sid });
      rounds.push({ i, ok: r.ok, seqs: r.seqs, error: r.error ?? null });
    }
    process.send({ type: 'done', sid, rounds }, () => process.exit(0));
  } catch (err) {
    process.send({ type: 'error', message: String(err && err.stack || err) }, () => process.exit(1));
  }
});
process.send({ type: 'ready', sid });
