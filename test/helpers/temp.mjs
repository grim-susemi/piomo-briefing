import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  const disposers = [];
  t.after(async () => {
    const errors = [];
    for (const dispose of disposers) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (fs.existsSync(dir)) throw new Error('directory still exists');
    } catch (error) {
      errors.push(new Error(`temp directory cleanup failed: ${dir}`, { cause: error }));
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
  });
  return { dir, onDispose: fn => { disposers.push(fn); } };
}
