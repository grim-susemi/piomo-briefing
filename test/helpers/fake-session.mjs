// Fake `pi.session` for deliver tests. Mirrors SENPI core/external-admission.js (ExternalAdmission):
//   admit  -> already_admitted when the id is pending/emitted/failed; otherwise the scripted kind
//   list   -> { pending, emitted, failed? } (failed only when non-empty)
//   emit / fail / settleRun are the test's handles for "entry written", "file refused it", "run settled".
export function makeFakeSession({ script = [] } = {}) {
  const pending = new Set();
  const emitted = new Set();
  const failed = new Map();
  const calls = [];
  const queue = [...script];
  const waiters = [];
  const session = {
    calls,
    admitExternalMessage(input) {
      calls.push(input);
      for (const w of waiters.splice(0)) w(input);
      const id = input.delivery_id;
      if (pending.has(id) || emitted.has(id) || failed.has(id)) return { kind: 'already_admitted', turn_epoch: 1 };
      const next = queue.length ? queue.shift() : 'started';
      if (next instanceof Error) throw next;
      if (next === 'started' || next === 'queued' || next === 'steered') pending.add(id);
      return { kind: next, turn_epoch: 1 };
    },
    listAdmittedDeliveries() {
      const out = { pending: [...pending], emitted: [...emitted] };
      if (failed.size) out.failed = [...failed].map(([delivery_id, error]) => ({ delivery_id, error }));
      return out;
    },
    /** the delivery's transcript entry was written */
    emit(id) { pending.delete(id); emitted.add(id); },
    /** the session file refused the entry */
    fail(id, error = 'EIO') { pending.delete(id); failed.set(id, error); },
    /** the run that refused it settled with a writable file */
    settleRun() { failed.clear(); },
    /** resolves with the next admit input (subscribe BEFORE triggering the action) */
    nextAdmit(timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for admitExternalMessage')), timeoutMs);
        waiters.push((input) => { clearTimeout(timer); resolve(input); });
      });
    },
  };
  return session;
}

/** A persisted delivery entry as getBranch() returns it. */
export const deliveryEntry = (deliveryId, extra = {}) => ({
  type: 'custom_message',
  customType: 'session_control_delivery',
  content: 'x',
  display: true,
  details: { delivery_id: deliveryId, source: 'session_control', deliverAs: 'followUp' },
  ...extra,
});
