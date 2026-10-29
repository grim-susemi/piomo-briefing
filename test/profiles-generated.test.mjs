// Actual committed artifact/seam checks; these run on Node without Bun.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { pageHtml } from '../src/render.mjs';
import { canonicalLf, profilesArtifact, readProfilesScript } from '../src/profiles-script.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE_DIR = path.join(ROOT, 'src', 'page');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const SOURCE = read('src/page/profiles-view.js');
const ARTIFACT = read('src/page/generated/profiles-view.min.js');
const PAYLOAD = readProfilesScript(PAGE_DIR);
const STATE = JSON.parse(read('test/fixtures/profiles-view-state.json'));
const BOARD = JSON.parse(read('test/fixtures/view-model-board.json'));
const plain = (value) => JSON.parse(JSON.stringify(value));

function seam(source = SOURCE, artifact = ARTIFACT) {
  return { ...fs, readFileSync(file, ...args) {
    if (file === path.join(PAGE_DIR, 'profiles-view.js')) return source;
    if (file === path.join(PAGE_DIR, 'generated', 'profiles-view.min.js')) {
      if (artifact === null) throw Object.assign(new Error('missing fixture artifact'), { code: 'ENOENT' });
      return artifact;
    }
    return fs.readFileSync(file, ...args);
  } };
}
function context(script, setup = '') {
  const ctx = vm.createContext({});
  vm.runInContext(read('src/page/icons.js'), ctx);
  vm.runInContext(setup, ctx);
  vm.runInContext(script, ctx);
  return ctx;
}

test('the actual reader accepts the committed pair and canonical CRLF without trimming payload', () => {
  // Given the committed pair in each checkout representation.
  const crlf = seam(SOURCE.replace(/\r?\n/g, '\r\n'), ARTIFACT.replace(/\r?\n/g, '\r\n'));
  // When reading through the same fs seam as pageHtml.
  const value = readProfilesScript(PAGE_DIR, crlf);
  // Then the shipped body (not its provenance comment) is returned byte-for-byte.
  assert.equal(value, canonicalLf(ARTIFACT).slice(canonicalLf(ARTIFACT).indexOf('\n') + 1));
  assert.equal(value, PAYLOAD);
});

const failures = [
  ['stale source', SOURCE + '\n', ARTIFACT, /stale source/],
  ['source trailing spaces', SOURCE + ' ', ARTIFACT, /stale source/],
  ['source lone CR', SOURCE + '\r', ARTIFACT, /stale source/],
  ['corrupt body', SOURCE, ARTIFACT + ' ', /corrupt payload/],
  ['wrong source hash', SOURCE, ARTIFACT.replace(/source-sha256=[a-f0-9]{64}/, 'source-sha256=' + '0'.repeat(64)), /stale source/],
  ['wrong body hash', SOURCE, ARTIFACT.replace(/payload-sha256=[a-f0-9]{64}/, 'payload-sha256=' + '0'.repeat(64)), /corrupt payload/],
  ['wrong recipe', SOURCE, ARTIFACT.replace(/recipe=\S+/, 'recipe=unknown-v0'), /wrong recipe/],
  ['missing header', SOURCE, PAYLOAD, /provenance header/],
  ['malformed header', SOURCE, ARTIFACT.replace('source-sha256=', 'source='), /provenance header/],
  ['missing artifact', SOURCE, null, { code: 'ENOENT' }],
];
for (const [name, source, artifact, error] of failures) {
  test('pageHtml rejects ' + name + ' through its actual fs seam', () => {
    // Given one invalid member of the actual pair.
    const fs = seam(source, artifact);
    // When assembling a page, then integrity failure escapes instead of a fallback.
    assert.throws(() => pageHtml(BOARD, 7, { fs }), error);
  });
}

test('the page ships only the verified body in the old classic-script position and leaves other chunks intact', () => {
  // Given the actual generated page and its readable CSS/other scripts.
  const html = pageHtml(BOARD, 7);
  const names = ['icons', 'view', 'plan-view', 'workers-view', 'blocks', 'convo-view', 'shell', 'profiles-view', 'alarm', 'annotate', 'cards-view', 'office-assets', 'office-model', 'office-view', 'page'];
  // When extracting its ordinary inline scripts.
  const scripts = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((match) => match[1]);
  // Then only the profiles representation differs, at index 7, before page initialization.
  assert.equal(scripts.length, names.length + 1);
  for (const [index, name] of names.entries()) {
    const expected = name === 'profiles-view' ? PAYLOAD : read('src/page/' + name + '.js');
    assert.equal(scripts[index], expected.replace(/<(\/?script|!--)/gi, '\\x3C$1'), name);
  }
  const styles = ['tokens', 'page', 'plan-view', 'workers-view', 'alarm', 'shell', 'profiles-view', 'convo', 'blocks', 'annotate', 'cards-view', 'office'];
  assert.equal(/<style>\n([\s\S]*?)\n<\/style>/.exec(html)[1], styles.map((name) => read('src/page/' + name + '.css').replace(/<\/style/gi, '<\\/style')).join('\n'));
  assert.equal(html.includes(ARTIFACT.split('\n')[0]), false);
});

const boundaries = [
  ['ordinary global', '', 'this.BriefProfiles', null],
  ['deleted globalThis', 'delete this.globalThis;', 'this.BriefProfiles', null],
  ['undefined property', 'this.globalThis = undefined;', 'this.BriefProfiles', null],
  ['undefined lexical binding', 'let globalThis;', 'this.BriefProfiles', null],
  ['getter global object', 'var reads = 0; Object.defineProperty(this, "globalThis", { get() { reads++; return this; } });', 'this.BriefProfiles', 2],
  ['getter undefined', 'var reads = 0; Object.defineProperty(this, "globalThis", { get() { reads++; } });', 'this.BriefProfiles', 1],
  ['getter alternate object', 'var reads = 0; var target = {}; Object.defineProperty(this, "globalThis", { get() { reads++; return target; } });', 'target.BriefProfiles', 2],
];
for (const [name, setup, publication, reads] of boundaries) {
  test('classic strict publication matches the source with ' + name, () => {
    // Given two fresh classic contexts, including the source's fallback boundary.
    const original = context(SOURCE, setup);
    const generated = context(PAYLOAD, setup);
    // When observing the published API and strict function receiver restrictions.
    const shape = (ctx) => plain(vm.runInContext('Object.entries(' + publication + ').map(([key, value]) => [key, typeof value])', ctx));
    // Then no extra global binding read or lost strictness is tolerated.
    assert.deepEqual(shape(generated), shape(original));
    for (const ctx of [original, generated]) {
      assert.throws(() => vm.runInContext(publication + '.render.caller', ctx), (error) => error.name === 'TypeError');
      if (reads !== null) assert.equal(vm.runInContext('reads', ctx), reads);
    }
  });
}

test('non-writable publication throws synchronously for both classic scripts', () => {
  // Given an existing non-writable export slot.
  const setup = 'Object.defineProperty(this, "BriefProfiles", { value: 0, writable: false });';
  // When evaluating either script, then strict assignment throws rather than silently succeeding.
  for (const script of [SOURCE, PAYLOAD]) assert.throws(() => context(script, setup), (error) => error.name === 'TypeError');
});

test('publication and the following classic script precede queued microtasks', async () => {
  for (const script of [SOURCE, PAYLOAD]) {
    // Given a publication observer and an already queued microtask.
    const events = [];
    const ctx = vm.createContext({ events });
    vm.runInContext('Object.defineProperty(this, "BriefProfiles", { set(value) { events.push(typeof value.render); } }); Promise.resolve().then(() => events.push("microtask"));', ctx);
    // When a normal classic script follows this script in the same turn.
    vm.runInContext(script + '\nevents.push("following");', ctx);
    // Then both synchronous effects precede the exact queued signal.
    assert.deepEqual(events, ['function', 'following']);
    await vm.runInContext('Promise.resolve()', ctx);
    assert.deepEqual(events, ['function', 'following', 'microtask']);
  }
});

test('source and artifact retain representative API, render, side and controller behavior', async () => {
  // Given independent APIs loaded as classic scripts with the real icon helper.
  const original = context(SOURCE).BriefProfiles;
  const generated = context(PAYLOAD).BriefProfiles;
  const edits = [
    { live: false },
    { live: true, pending: [], draft: {} },
    { live: true, loading: true },
    { live: true, conflict: true, pending: [{ kind: 'setAgentLane', agentId: 'atlas', lane: 'geeky-heavy' }] },
  ];
  // When exercising the same fixture, empty, stale and deferred controller branches.
  for (const state of [STATE, null, {}, { ...STATE, readOnly: true, inventory: { ...STATE.inventory, stale: true } }]) {
    for (const edit of edits) {
      assert.equal(generated.render(state, edit), original.render(state, edit));
      assert.equal(generated.side(state, edit), original.side(state, edit));
    }
  }
  for (const value of ['<&"\'`>', '\uD55C\uAE00 \u{1F600}', 0, null]) assert.equal(generated.escapeHtml(value), original.escapeHtml(value));
  async function exercise(api) {
    const requests = [], updates = [];
    const controller = api.createController({
      token: () => 'fixture-token',
      onChange: (state) => updates.push(plain(state)),
      fetch: async (url, options) => {
        requests.push([url, plain(options)]);
        return { status: url.endsWith('/state') ? 200 : JSON.parse(options.body).action === 'preview' ? 200 : 409,
          json: async () => url.endsWith('/state') ? plain(STATE) : { ok: true, diff: [] } };
      },
    });
    await controller.load();
    controller.setDraft('lane', { value: 'geeky-heavy' });
    controller.add({ kind: 'setAgentLane', agentId: 'atlas', lane: 'geeky-heavy' });
    await controller.preview();
    await controller.apply();
    controller.clear();
    const conflict = plain(controller.snapshot());
    await controller.load();
    return { requests, updates, conflict, final: plain(controller.snapshot()) };
  }
  // Then complete values and requests match; no editable prose is pinned.
  assert.deepEqual(await exercise(generated), await exercise(original));
  const listeners = (api) => {
    const events = [];
    const root = { addEventListener(type) { events.push(['add', type]); }, removeEventListener(type) { events.push(['remove', type]); } };
    api.bind(root, {})();
    return events;
  };
  assert.deepEqual(listeners(generated), listeners(original));
});

test('provenance formatting round-trips source and body without losing terminal whitespace', () => {
  // Given an independently supplied body with terminal whitespace.
  const payload = PAYLOAD + '\n ';
  // When a producer records that exact body, then the shared reader returns it unchanged.
  assert.equal(readProfilesScript(PAGE_DIR, seam(SOURCE, profilesArtifact(SOURCE, payload))), payload);
});
