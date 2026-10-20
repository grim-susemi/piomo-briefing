// Atomic JSON writes and the roster compare-and-swap writer.
//
// Adopted from qa/probes/atomic-proto.mjs (P9): exclusive same-directory temp
// file -> write -> fsync -> close -> rename, with the bounded EPERM/EBUSY
// retry ladder 10/20/40/80/160 ms. The destination is never written in place
// and never unlinked.
//
// Pure ESM: only node:fs, node:path and node:crypto may be imported.
import * as nodeFs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { rosterPath, validateRoster } from './schema.mjs';

const RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY']);
const BACKUP_NAME = /^roster-\d{8}-\d{6}-\d{3}\.json$/;
const MAX_BACKUPS = 20;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function unlinkQuietly(fs, file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function exhaustedError(temporary, destination, retries, cause) {
  const error = new Error(
    `ATOMIC_EXHAUSTED: could not rename ${temporary} -> ${destination} after ${retries} retries`,
  );
  error.code = 'ATOMIC_EXHAUSTED';
  error.cause = cause;
  return error;
}

export function atomicWriteJson(file, value, options = {}) {
  const fs = options.fs ?? nodeFs;
  const directory = dirname(file);
  fs.mkdirSync(directory, { recursive: true });

  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = join(
    directory,
    `${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );

  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeSync(fd, body, null, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* the write error is the one to report */ }
    }
    unlinkQuietly(fs, temporary);
    throw error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    unlinkQuietly(fs, temporary);
    throw error;
  }

  let retries = 0;
  for (;;) {
    try {
      fs.renameSync(temporary, file);
      return { destination: file, retries, bytes: Buffer.byteLength(body) };
    } catch (error) {
      if (!RETRYABLE_CODES.has(error?.code)) {
        unlinkQuietly(fs, temporary);
        throw error;
      }
      if (retries >= RETRY_DELAYS_MS.length) {
        unlinkQuietly(fs, temporary);
        throw exhaustedError(temporary, file, retries, error);
      }
      sleepSync(RETRY_DELAYS_MS[retries]);
      retries += 1;
    }
  }
}

function timestamp(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`
    + `-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
    + `-${iso.slice(20, 23)}`;
}

function writeBackup(directory, bytes, fs) {
  fs.mkdirSync(directory, { recursive: true });
  const startedAt = Date.now();
  for (let bump = 0; ; bump += 1) {
    const file = join(directory, `roster-${timestamp(new Date(startedAt + bump))}.json`);
    try {
      fs.writeFileSync(file, bytes, { flag: 'wx' });
      return file;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
}

function pruneBackups(directory, fs) {
  const names = fs.readdirSync(directory).filter(name => BACKUP_NAME.test(name)).sort();
  const excess = names.length - MAX_BACKUPS;
  for (let index = 0; index < excess; index += 1) {
    fs.unlinkSync(join(directory, names[index]));
  }
}

function conflictError(message) {
  const error = new Error(`CONFLICT: ${message}`);
  error.code = 'CONFLICT';
  return error;
}

// Compare-and-swap roster write: read the current revision -> CONFLICT when it
// differs from expectedRevision -> validate the next roster -> back up the
// previous bytes (newest 20 kept) -> revision + 1 -> atomic write.
export function writeRoster(agentDir, next, expectedRevision, options = {}) {
  const fs = options.fs ?? nodeFs;
  const file = rosterPath(agentDir);

  let previous = null;
  try {
    previous = fs.readFileSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw conflictError(`${file}: ${error.message}`);
  }

  let currentRevision = 0;
  if (previous !== null) {
    let parsed;
    try {
      parsed = JSON.parse(previous.toString('utf8'));
    } catch (error) {
      throw conflictError(`${file} is not valid JSON: ${error.message}`);
    }
    if (!Number.isInteger(parsed?.revision) || parsed.revision < 0) {
      throw conflictError(`${file} has no usable revision`);
    }
    currentRevision = parsed.revision;
  }

  if (currentRevision !== expectedRevision) {
    throw conflictError(`expected revision ${expectedRevision} but found ${currentRevision}`);
  }

  const validation = validateRoster(next);
  if (!validation.ok) {
    const first = validation.errors[0];
    const error = new Error(
      `INVALID_ROSTER: ${first.path}: ${first.message}`
      + (validation.errors.length > 1 ? ` (+${validation.errors.length - 1} more)` : ''),
    );
    error.code = 'INVALID_ROSTER';
    error.errors = validation.errors;
    throw error;
  }

  if (previous !== null) {
    const backups = join(agentDir, 'primary-agents', 'backups');
    writeBackup(backups, previous, fs);
    pruneBackups(backups, fs);
  }

  const written = {
    ...next,
    revision: currentRevision + 1,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(file, written, { fs });
  return written;
}
