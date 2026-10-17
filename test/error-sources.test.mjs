// Per-source error surfacing, observed at the PUBLISHED boundary (data.js + meta on disk):
// an error from source X survives a success from source Y; X's own success clears only X; the
// '오류 있음' chip is on the page iff at least one source still has an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBriefingExtension } from '../extension.mjs';
import { createDeliverer } from '../src/deliver.mjs';
import { openStore } from '../src/store.mjs';
import { renderPage } from '../src/render.mjs';
import { tempDir } from './helpers/temp.mjs';
import { makeFakePi, makeCtx } from './helpers/fake-pi.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/mirror/ask-user-events.json', import.meta.url), 'utf8'));
const ASKED = 'ask-user:asked';
const CLOSED = 'ask-user:closed';
const ERR = '오류 있음';
const clone = (v) => JSON.parse(JSON.stringify(v));
const norm = (p) => String(p).replace(/\\/g, '/');

function makeBus() {
  const handlers = new Map();
  return {
    on(channel, fn) {
      handlers.set(channel, [...(handlers.get(channel) ?? []), fn]);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((f) => f !== fn));
    },
    emit(channel, data) { for (const fn of [...(handlers.get(channel) ?? [])]) fn(data); },
  };
}

const model = (stateDir) => {
  const text = readFileSync(join(stateDir, 'data.js'), 'utf8');
  return JSON.parse(/__briefData\((.*)\);\s*$/s.exec(text)[1]);
};
const chipsOf = (stateDir, sid = 'sess-A') => (model(stateDir).sessions.find((s) => s.id === sid) ?? { chips: [] }).chips;
const hasChip = (stateDir) => chipsOf(stateDir).includes(ERR);
const metaOf = (stateDir, sid = 'sess-A') => JSON.parse(readFileSync(join(stateDir, 'sessions', sid, 'meta.json'), 'utf8'));
const sources = (stateDir) => Object.keys(metaOf(stateDir).errors ?? {}).sort();

const goodBrief = (over = {}) => ({
  title: '작업 하나', status: 'in_progress', headline: '목표까지 절반', changes: [], done: [], next: '', decisions: [], ...over,
});
const decision = () => ({
  question: '어느 쪽으로 갈까?',
  options: { A: { text: '가', consequence: '빠름' }, B: { text: '나', consequence: '안전' } },
  recommend: 'A', reason: '빨라서', blocks: false,
});
const decisionFiles = (stateDir) => (existsSync(join(stateDir, 'decisions')) ? nodeFs.readdirSync(join(stateDir, 'decisions')).filter((n) => /^\d+\.json$/.test(n)) : []);
const quietDeliverer = () => ({ wake: async () => {}, pendingIds: () => [], dispose: async () => {} });

function rig(t, { fs = nodeFs, createDeliverer: cd = quietDeliverer, session } = {}) {
  const { dir, onDispose } = tempDir(t, 'omo-errsrc-');
  const stateDir = join(dir, 'state');
  let clock = 1_700_000_000_000;
  const host = makeFakePi();
  const bus = makeBus();
  host.pi.events = bus;
  if (session) host.pi.session = session;
  createBriefingExtension({
    stateDir, now: () => (clock += 1000), env: { PATH: process.env.PATH }, fs,
    openPage: () => ({}), renderOpts: { sleep: () => {} }, createDeliverer: cd,
  })(host.pi);
  const { ctx, notes } = makeCtx({ sid: 'sess-A' });
  onDispose(() => host.emit('session_shutdown', {}, ctx));
  const ask = (requestId = 'toolu_ask_001') => {
    const p = clone(FIX.asked);
    p.request.requestId = requestId;
    bus.emit(ASKED, { ...p, ctx });
    return requestId;
  };
  const close = (requestId, status = 'timed_out') => bus.emit(CLOSED, { requestId, status });
  const decide = (text) => host.commands.get('decide').handler(text, ctx);
  return {
    stateDir, host, bus, ctx, notes, ask, close, decide,
    start: () => host.emit('session_start', { reason: 'startup' }, ctx),
    brief: (input) => host.tool('brief').execute('call', input, undefined, undefined, ctx),
    settle: () => host.emit('agent_settled', {}, ctx),
  };
}

// ---------------------------------------------------------------- B1 mirror

test('B1 mirror: a failed timeout conversion keeps its chip through unrelated successes; the mirror\'s own next success clears only it', async (t) => {
  let failDecisionWrite = 0;
  const fs = {
    ...nodeFs,
    writeFileSync(p, d, o) {
      if (failDecisionWrite > 0 && norm(p).includes('/decisions/') && o && o.flag === 'wx') {
        failDecisionWrite--;
        throw Object.assign(new Error('B1 disk full creating timeout decision'), { code: 'ENOSPC' });
      }
      return nodeFs.writeFileSync(p, d, o);
    },
  };
  const r = rig(t, { fs });
  await r.start();
  const id = r.ask();
  assert.equal(hasChip(r.stateDir), false);
  failDecisionWrite = 1;
  r.close(id);
  assert.equal(failDecisionWrite, 0, 'the decision write really failed');
  assert.deepEqual(sources(r.stateDir), ['mirror']);
  assert.match(metaOf(r.stateDir).lastError.message, /disk full/);
  assert.equal(hasChip(r.stateDir), true, 'the page published for the failed operation carries the chip');
  // unrelated successes from other sources do not erase it
  await r.brief(goodBrief());
  assert.equal(hasChip(r.stateDir), true, 'a successful brief publication keeps the mirror error');
  await r.settle();
  assert.equal(hasChip(r.stateDir), true, 'agent_settled publication keeps the mirror error');
  assert.deepEqual(sources(r.stateDir), ['mirror']);
  // the mirror's next activity retries the owed conversion; its success (not an unrelated ask) clears the entry, and the page follows
  r.ask('toolu_ask_002');
  assert.deepEqual(sources(r.stateDir), []);
  assert.equal(metaOf(r.stateDir).lastError, null);
  assert.equal(hasChip(r.stateDir), false);
  assert.equal(decisionFiles(r.stateDir).length, 1, 'the owed decision card was written');
});

test('R3-B1 mirror: an unrelated successful ask does not stand in for a lost timeout conversion; only that conversion clears the error', async (t) => {
  let failDecisionWrite = 0;
  const fs = {
    ...nodeFs,
    writeFileSync(p, d, o) {
      if (failDecisionWrite > 0 && norm(p).includes('/decisions/') && o && o.flag === 'wx') {
        failDecisionWrite--;
        throw Object.assign(new Error('R3B1 disk full creating timeout decision'), { code: 'ENOSPC' });
      }
      return nodeFs.writeFileSync(p, d, o);
    },
  };
  const r = rig(t, { fs });
  await r.start();
  const id = r.ask();
  failDecisionWrite = 2; // the close itself, then the retry made by the next mirror activity
  r.close(id);
  assert.deepEqual(sources(r.stateDir), ['mirror']);
  assert.deepEqual(decisionFiles(r.stateDir), []);
  r.ask('toolu_ask_002'); // an unrelated question opens successfully
  assert.equal(failDecisionWrite, 0, 'the owed conversion was retried');
  assert.deepEqual(sources(r.stateDir), ['mirror'], 'the unrelated ask did not clear the unresolved error');
  assert.equal(hasChip(r.stateDir), true);
  assert.deepEqual(decisionFiles(r.stateDir), []);
  r.close('toolu_ask_002', 'answered'); // storage is healthy again: the next mirror activity converts the original question
  assert.equal(decisionFiles(r.stateDir).length, 1, 'the owed question became a decision card');
  const card = JSON.parse(readFileSync(join(r.stateDir, 'decisions', decisionFiles(r.stateDir)[0]), 'utf8'));
  assert.equal(card.source, 'question-timeout');
  assert.equal(card.requestId, id);
  assert.deepEqual(sources(r.stateDir), []);
  assert.equal(hasChip(r.stateDir), false);
  assert.ok(readFileSync(join(r.stateDir, 'data.js'), 'utf8').includes('question-timeout'), 'the published page carries the decision card');
});

test('R3-B1 mirror: an owed conversion is persisted in the mirror file and converted when the extension attaches again', async (t) => {
  let failDecisionWrite = 0;
  const fs = {
    ...nodeFs,
    writeFileSync(p, d, o) {
      if (failDecisionWrite > 0 && norm(p).includes('/decisions/') && o && o.flag === 'wx') {
        failDecisionWrite--;
        throw Object.assign(new Error('R3B1 disk full creating timeout decision'), { code: 'ENOSPC' });
      }
      return nodeFs.writeFileSync(p, d, o);
    },
  };
  const r = rig(t, { fs });
  await r.start();
  const id = r.ask();
  failDecisionWrite = 1;
  r.close(id);
  assert.deepEqual(sources(r.stateDir), ['mirror']);
  await r.host.emit('session_shutdown', {}, r.ctx);
  const saved = JSON.parse(readFileSync(join(r.stateDir, 'mirror', 'sess-A.json'), 'utf8'));
  assert.deepEqual((saved.unconverted ?? []).map((u) => u.requestId), [id], 'the owed conversion is in the mirror file');
  assert.equal(decisionFiles(r.stateDir).length, 0);
  await r.start();
  assert.equal(decisionFiles(r.stateDir).length, 1, 'attach converted the owed question');
  assert.deepEqual(sources(r.stateDir), []);
  assert.equal(hasChip(r.stateDir), false);
});

test('R3-B4 mirror: an error recorded while closing the mirror at shutdown is published once with the chip', async (t) => {
  let failMirrorRename = false;
  const fs = {
    ...nodeFs,
    renameSync(from, to) {
      if (failMirrorRename && norm(to).endsWith('/mirror/sess-A.json')) {
        throw Object.assign(new Error('R3B4 cannot save closed mirror'), { code: 'ENOSPC' });
      }
      return nodeFs.renameSync(from, to);
    },
  };
  const r = rig(t, { fs });
  await r.start();
  r.ask();
  assert.equal(hasChip(r.stateDir), false);
  const seqBefore = model(r.stateDir).seq;
  failMirrorRename = true;
  await r.host.emit('session_shutdown', {}, r.ctx);
  assert.deepEqual(sources(r.stateDir), ['mirror']);
  assert.equal(hasChip(r.stateDir), true, 'the published page shows the shutdown error');
  assert.equal(model(r.stateDir).seq, seqBefore + 1, 'published exactly once');
});

test('R5-B2 mirror: a healthy shutdown while briefing is paused (/brief off) publishes nothing', async (t) => {
  const r = rig(t);
  await r.start();
  r.ask();
  await r.host.commands.get('brief').handler('off', r.ctx);
  const manifest = () => readFileSync(join(r.stateDir, 'published.json'), 'utf8');
  const dataBefore = readFileSync(join(r.stateDir, 'data.js'), 'utf8');
  const manifestBefore = manifest();
  await r.host.emit('session_shutdown', {}, r.ctx);
  assert.equal(readFileSync(join(r.stateDir, 'data.js'), 'utf8'), dataBefore, 'data.js is untouched while paused');
  assert.equal(manifest(), manifestBefore, 'published.json is untouched while paused');
  assert.deepEqual(sources(r.stateDir), []);
});

test('R5-B2 mirror: an error at a paused shutdown is persisted, not published, and shows on the next enabled publish', async (t) => {
  let failMirrorRename = false;
  const fs = {
    ...nodeFs,
    renameSync(from, to) {
      if (failMirrorRename && norm(to).endsWith('/mirror/sess-A.json')) {
        throw Object.assign(new Error('R5B2 cannot save closed mirror'), { code: 'ENOSPC' });
      }
      return nodeFs.renameSync(from, to);
    },
  };
  const r = rig(t, { fs });
  await r.start();
  r.ask();
  await r.host.commands.get('brief').handler('off', r.ctx);
  const dataBefore = readFileSync(join(r.stateDir, 'data.js'), 'utf8');
  failMirrorRename = true;
  await r.host.emit('session_shutdown', {}, r.ctx);
  assert.equal(readFileSync(join(r.stateDir, 'data.js'), 'utf8'), dataBefore, 'nothing is published while paused');
  assert.deepEqual(sources(r.stateDir), ['mirror'], 'the error is persisted in meta');
  failMirrorRename = false;
  await r.host.commands.get('brief').handler('on', r.ctx);
  assert.equal(hasChip(r.stateDir), true, 'the next enabled publish shows the persisted error');
});

// ---------------------------------------------------------------- B2 delivery

test('B2 delivery: an admission error is published; unrelated success keeps it; the deliverer\'s own clean run clears it', async (t) => {
  let admit = () => { throw new Error('B2 admission storage unavailable'); };
  const session = {
    listAdmittedDeliveries: () => ({ pending: [], emitted: [], failed: [] }),
    admitExternalMessage: (m) => admit(m),
  };
  const r = rig(t, { session, createDeliverer: (deps) => createDeliverer({ ...deps, watch: false }) });
  await r.start();
  await r.brief(goodBrief({ decisions: [decision()] }));
  assert.equal(hasChip(r.stateDir), false);
  await r.decide('1A');
  assert.deepEqual(sources(r.stateDir), ['deliver']);
  assert.match(metaOf(r.stateDir).lastError.message, /^deliver: #1: B2 admission/);
  assert.equal(hasChip(r.stateDir), true, 'the delivery error reaches the published page');
  await r.brief(goodBrief({ headline: '다른 보고' }));
  assert.equal(hasChip(r.stateDir), true, 'a successful brief publication keeps the delivery error');
  assert.deepEqual(sources(r.stateDir), ['deliver']);
  admit = () => ({ kind: 'held_draft' });
  await r.host.emit('input', { source: 'interactive' }, r.ctx);
  assert.deepEqual(sources(r.stateDir), []);
  assert.equal(metaOf(r.stateDir).lastError, null);
  assert.equal(hasChip(r.stateDir), false, 'the deliverer\'s own success clears the published chip');
});

// ---------------------------------------------------------------- decide / settings + chip iff any error

test('chip iff any error: decide + mirror errors are independent; each clears only on its own success', async (t) => {
  let denyDecision = 0;
  let failDecisionWrite = 0;
  const fs = {
    ...nodeFs,
    readFileSync(p, ...a) {
      if (denyDecision > 0 && norm(p).endsWith('/decisions/000001.json')) {
        denyDecision--;
        throw Object.assign(new Error('EACCES: injected decision'), { code: 'EACCES' });
      }
      return nodeFs.readFileSync(p, ...a);
    },
    writeFileSync(p, d, o) {
      if (failDecisionWrite > 0 && norm(p).includes('/decisions/') && o && o.flag === 'wx') {
        failDecisionWrite--;
        throw Object.assign(new Error('disk full creating timeout decision'), { code: 'ENOSPC' });
      }
      return nodeFs.writeFileSync(p, d, o);
    },
  };
  const r = rig(t, { fs });
  await r.start();
  await r.brief(goodBrief({ decisions: [decision()] }));
  assert.equal(hasChip(r.stateDir), false);
  // mirror error
  const id = r.ask();
  failDecisionWrite = 1;
  r.close(id);
  assert.deepEqual(sources(r.stateDir), ['mirror']);
  assert.equal(hasChip(r.stateDir), true);
  // decide error on top
  denyDecision = 8;
  await r.decide('1A');
  assert.equal(denyDecision, 0);
  assert.deepEqual(sources(r.stateDir), ['decide', 'mirror']);
  assert.equal(hasChip(r.stateDir), true);
  // a clean /decide clears decide only; the mirror error keeps the chip
  await r.decide('1A');
  assert.deepEqual(sources(r.stateDir), ['mirror']);
  assert.equal(hasChip(r.stateDir), true, 'the decide success did not erase the mirror error');
  // the mirror's retry of the owed conversion succeeds and clears the rest -> no chip
  r.ask('toolu_ask_002');
  assert.deepEqual(sources(r.stateDir), []);
  assert.equal(hasChip(r.stateDir), false);
});

test('settings: an unreadable settings file is published as an error and cleared when settings read again', async (t) => {
  let deny = true;
  const fs = {
    ...nodeFs,
    readFileSync(p, ...a) {
      if (deny && norm(p).endsWith('/settings.json')) throw Object.assign(new Error('EACCES: injected settings'), { code: 'EACCES' });
      return nodeFs.readFileSync(p, ...a);
    },
  };
  const r = rig(t, { fs });
  await r.start();
  assert.deepEqual(sources(r.stateDir), ['settings']);
  assert.equal(hasChip(r.stateDir), true, 'the settings error is on the published page');
  deny = false;
  await r.host.emit('before_agent_start', { systemPrompt: 'base', prompt: 'x', trigger: 'prompt' }, r.ctx);
  assert.deepEqual(sources(r.stateDir), []);
  assert.equal(hasChip(r.stateDir), false);
});

// ---------------------------------------------------------------- B3 render.lock release

function renderRig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'omo-lockrel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctl = { denyLockReads: 0 };
  const fs = {
    ...nodeFs,
    readFileSync(p, ...a) {
      if (ctl.denyLockReads > 0 && norm(p).endsWith('/render.lock')) {
        if (ctl.denyLockReads !== Infinity) ctl.denyLockReads--;
        throw Object.assign(new Error('EACCES: injected render.lock'), { code: 'EACCES' });
      }
      return nodeFs.readFileSync(p, ...a);
    },
  };
  const store = openStore(dir, { fs, sleep: () => {} });
  const NOW = Date.UTC(2026, 9, 14, 3, 0, 0);
  store.replace('sessions/R/meta.json', { sessionId: 'R', cwd: 'C:/w/r', title: 'R', lastActivityAt: NOW });
  store.writeNew('sessions/R/briefs/000001.json', { at: NOW, brief: { status: 'in_progress', title: 'R', headline: 'r', changes: [], done: [], next: '', decisions: [] } });
  const render = () => renderPage(store, NOW, { sessionId: 'R', sleep: () => {}, fs });
  const pub = () => model(dir).sessions.find((s) => s.id === 'R').chips;
  return { dir, ctl, store, render, pub, lock: join(dir, 'render.lock') };
}

test('B3 render.lock: an exhausted release read is surfaced (render source), the page carries the chip and the lock is gone', (t) => {
  const r = renderRig(t);
  r.ctl.denyLockReads = 8; // the store reader's whole retry bound, consumed by the release read
  const res = r.render();
  assert.equal(r.ctl.denyLockReads, 0);
  assert.equal(res.ok, false, 'a lock that could not be released is not reported as success');
  assert.match(res.error, /render\.lock/);
  assert.equal(existsSync(r.lock), false, 'the stranded lock was reclaimed (nonce verified)');
  assert.match(metaOf(r.dir, 'R').errors.render.message, /render\.lock/);
  assert.ok(r.pub().includes(ERR), 'the published page shows the error');
  assert.equal(r.render().ok, true, 'the next render is not blocked');
});

test('B3 render.lock: a lock stranded while reads keep failing does not block the next render once reads recover', (t) => {
  const r = renderRig(t);
  r.ctl.denyLockReads = Infinity;
  const res = r.render();
  assert.equal(res.ok, false);
  assert.match(res.error, /render\.lock/);
  assert.equal(existsSync(r.lock), true, 'still stranded while the lock cannot be read');
  r.ctl.denyLockReads = 0;
  const next = r.render();
  assert.equal(next.ok, true, next.error);
  assert.equal(existsSync(r.lock), false);
  assert.ok(next.seqs.length >= 1);
});

test('R3-B2 render.lock: a release failure on the follow-up publication is reported, chipped and recovered', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omo-lockrel2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctl = { denyLockReads: 0, publications: 0 };
  const metaFile = join(dir, 'sessions', 'R', 'meta.json');
  const fs = {
    ...nodeFs,
    readFileSync(p, ...a) {
      if (ctl.denyLockReads > 0 && norm(p).endsWith('/render.lock')) {
        ctl.denyLockReads--;
        throw Object.assign(new Error('EACCES: injected render.lock'), { code: 'EACCES' });
      }
      return nodeFs.readFileSync(p, ...a);
    },
    renameSync(from, to) {
      nodeFs.renameSync(from, to);
      if (norm(to).endsWith('/published.json')) {
        ctl.publications++;
        if (ctl.publications === 1) { // the store changes meanwhile -> the bounded follow-up publication
          const future = new Date(Date.now() + 3_600_000);
          nodeFs.utimesSync(metaFile, future, future);
        }
        if (ctl.publications === 2) ctl.denyLockReads = 8; // the follow-up's release read exhausts its retries
      }
    },
  };
  const store = openStore(dir, { fs, sleep: () => {} });
  const NOW = Date.UTC(2026, 9, 14, 3, 0, 0);
  store.replace('sessions/R/meta.json', { sessionId: 'R', cwd: 'C:/w/r', title: 'R', lastActivityAt: NOW });
  store.writeNew('sessions/R/briefs/000001.json', { at: NOW, brief: { status: 'in_progress', title: 'R', headline: 'r', changes: [], done: [], next: '', decisions: [] } });
  const res = renderPage(store, NOW, { sessionId: 'R', sleep: () => {}, fs });
  assert.ok(ctl.publications >= 2, 'the follow-up publication ran');
  assert.equal(ctl.denyLockReads, 0, 'the follow-up release read really failed');
  assert.equal(res.ok, false, 'a follow-up that stranded its lock is not success');
  assert.match(res.error, /render\.lock/);
  assert.match(metaOf(dir, 'R').errors.render.message, /render\.lock/);
  assert.equal(existsSync(join(dir, 'render.lock')), false, 'the stranded lock was reclaimed (nonce verified)');
  assert.ok((model(dir).sessions.find((s) => s.id === 'R').chips).includes(ERR), 'the published page shows the error');
});

test('R3-B3 render.lock: a transient unlink failure while removing our own leftover keeps its nonce; a later healthy publication succeeds', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omo-lockrel3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctl = { denyLockReads: 0, denyUnlink: 0 };
  const fs = {
    ...nodeFs,
    readFileSync(p, ...a) {
      if (ctl.denyLockReads > 0 && norm(p).endsWith('/render.lock')) {
        ctl.denyLockReads--;
        throw Object.assign(new Error('EACCES: injected render.lock'), { code: 'EACCES' });
      }
      return nodeFs.readFileSync(p, ...a);
    },
    unlinkSync(p) {
      if (ctl.denyUnlink > 0 && norm(p).endsWith('/render.lock')) {
        ctl.denyUnlink--;
        throw Object.assign(new Error('EACCES: injected render.lock unlink'), { code: 'EACCES' });
      }
      return nodeFs.unlinkSync(p);
    },
  };
  const store = openStore(dir, { fs, sleep: () => {} });
  const NOW = Date.UTC(2026, 9, 14, 3, 0, 0);
  store.replace('sessions/R/meta.json', { sessionId: 'R', cwd: 'C:/w/r', title: 'R', lastActivityAt: NOW });
  store.writeNew('sessions/R/briefs/000001.json', { at: NOW, brief: { status: 'in_progress', title: 'R', headline: 'r', changes: [], done: [], next: '', decisions: [] } });
  const render = () => renderPage(store, NOW, { sessionId: 'R', sleep: () => {}, fs });
  ctl.denyLockReads = 8; // consumed by the release read
  ctl.denyUnlink = 1; // the immediate recovery reads the nonce fine, but its one unlink fails
  const first = render();
  assert.equal(ctl.denyLockReads, 0);
  assert.equal(ctl.denyUnlink, 0);
  assert.equal(first.ok, false);
  assert.equal(existsSync(join(dir, 'render.lock')), true, 'the leftover is still there');
  const next = render(); // every fault is gone
  assert.equal(next.ok, true, next.error);
  assert.equal(existsSync(join(dir, 'render.lock')), false);
  assert.ok(next.seqs.length >= 1);
});

// ---------------------------------------------------------------- page template generation

const stampOf = (dir) => { const m = /<meta name="omo-briefing-generation" content="(\d+)">/.exec(readFileSync(join(dir, 'index.html'), 'utf8')); return m ? Number(m[1]) : null; };
const dataSeq = (dir) => Number(/^\/\* seq:(\d+) \*\//.exec(readFileSync(join(dir, 'data.js'), 'utf8'))[1]);

test('F3R2-B1 page template: an older-generation publisher never replaces a newer generation\'s index.html but still updates data.js', (t) => {
  const r = renderRig(t);
  const NOW = Date.UTC(2026, 9, 14, 3, 0, 0);
  const as = (generation) => renderPage(r.store, NOW, { sessionId: 'R', sleep: () => {}, fs: nodeFs, generation });
  assert.equal(as(2).ok, true);
  assert.equal(stampOf(r.dir), 2);
  const newerPage = readFileSync(join(r.dir, 'index.html'));
  const seqNewer = dataSeq(r.dir);
  const older = as(1);
  assert.equal(older.ok, true, older.error);
  assert.ok(readFileSync(join(r.dir, 'index.html')).equals(newerPage), 'index.html is byte-identical');
  assert.equal(stampOf(r.dir), 2);
  assert.ok(dataSeq(r.dir) > seqNewer, 'data.js still advanced');
  assert.equal(JSON.parse(readFileSync(join(r.dir, 'published.json'), 'utf8')).seq, dataSeq(r.dir));
  assert.equal(as(2).ok, true); // same generation rewrites
  assert.equal(as(3).ok, true); // a newer generation upgrades the page
  assert.equal(stampOf(r.dir), 3);
  assert.equal(as(1).ok, true);
  assert.equal(stampOf(r.dir), 3);
});

// ---------------------------------------------------------------- renderer chip rule

test('renderer: meta.errors with entries -> chip; empty errors -> no chip even with a stale lastError; legacy lastError alone still -> chip', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omo-chip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  const NOW = Date.UTC(2026, 9, 14, 3, 0, 0);
  const mk = (sid, extra) => store.replace(`sessions/${sid}/meta.json`, { sessionId: sid, cwd: 'C:/w/x', title: sid, lastActivityAt: NOW, ...extra });
  mk('with', { errors: { deliver: { at: NOW, message: 'deliver: x' } }, lastError: { at: NOW, message: 'deliver: x' } });
  mk('empty', { errors: {}, lastError: { at: NOW, message: 'stale' } });
  mk('legacy', { lastError: { at: NOW, message: 'old' } });
  assert.equal(renderPage(store, NOW).ok, true);
  const by = Object.fromEntries(model(dir).sessions.map((s) => [s.id, s.chips]));
  assert.ok(by.with.includes(ERR));
  assert.ok(!by.empty.includes(ERR));
  assert.ok(by.legacy.includes(ERR));
});
