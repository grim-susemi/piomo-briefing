import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, CHROME_PATH } from '../src/open-page.mjs';

function fakeExec() {
  const calls = [];
  const execFile = (cmd, args, cb) => {
    calls.push({ cmd, args });
    const child = { unref() { child.unrefd = true; } };
    fakeExec.last = { child, cb };
    return child;
  };
  return { calls, execFile };
}

test('chrome present -> execFile(chrome, [file URL])', () => {
  const { calls, execFile } = fakeExec();
  const r = openPage('C:/state/index.html', { platform: 'win32', exists: (p) => p === CHROME_PATH, execFile });
  assert.equal(r.launcher, 'chrome');
  assert.deepEqual(calls, [{ cmd: CHROME_PATH, args: ['file:///C:/state/index.html'] }]);
  assert.equal(fakeExec.last.child.unrefd, true);
});

test('chrome absent -> explorer.exe with the path', () => {
  const { calls, execFile } = fakeExec();
  const r = openPage('C:/state/index.html', { platform: 'win32', exists: () => false, execFile });
  assert.equal(r.launcher, 'explorer');
  assert.deepEqual(calls, [{ cmd: 'explorer.exe', args: ['C:\\state\\index.html'] }]);
});

test('explorer exit code 1 is ignored, other errors are reported', () => {
  const errors = [];
  const { execFile } = fakeExec();
  openPage('C:/state/index.html', { platform: 'win32', exists: () => false, execFile, onError: (e) => errors.push(e) });
  fakeExec.last.cb(Object.assign(new Error('exit 1'), { code: 1 }));
  assert.deepEqual(errors, []);
  fakeExec.last.cb(Object.assign(new Error('boom'), { code: 'ENOENT' }));
  assert.equal(errors.length, 1);
});

test('a chrome non-zero exit is reported', () => {
  const errors = [];
  const { execFile } = fakeExec();
  openPage('C:/state/index.html', { platform: 'win32', exists: () => true, execFile, onError: (e) => errors.push(e) });
  fakeExec.last.cb(Object.assign(new Error('exit 1'), { code: 1 }));
  assert.equal(errors.length, 1);
});

test('non-windows platforms are refused with the path in the message', () => {
  assert.throws(() => openPage('/x/index.html', { platform: 'linux', exists: () => false, execFile: () => ({}) }), /\/x\/index\.html/);
});
