import { fork } from 'node:child_process';

// Both processes carry the owned profile path in argv and self-exit if the test fails.
const [, , mode, profileDir] = process.argv;
setTimeout(() => process.exit(1), 60_000);
if (mode === 'grandchild' || mode === 'hold') {
  process.send({ type: 'ready', pid: process.pid });
} else {
  process.on('message', (message) => { if (message === 'exit') process.exit(0); });
  const child = fork(new URL(import.meta.url), ['grandchild', profileDir], {
    stdio: ['ignore', process.stdout, process.stderr, 'ipc'], windowsHide: true, detached: true,
  });
  child.once('message', () => process.send({ type: 'ready', pid: process.pid, grandchild: child.pid }));
}
