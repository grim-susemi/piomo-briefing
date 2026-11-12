import assert from 'node:assert/strict';
import { makeController } from '../fixtures/controller-dom.mjs';
import { makeLiveScaleHome } from './profiles-live-scale.mjs';

export const plain = value => JSON.parse(JSON.stringify(value));
export const route = {
  kind: 'setRoute', profileKey: 'native-experimental-custom', section: 'agents', role: 'explore',
  provider: 'kimi-coding', model: 'kimi-coding/k3', thinking: 'high',
};
export const protectedState = snapshot => plain(Object.fromEntries(
  ['shown', 'pending', 'draft', 'preview', 'result', 'memoryErrors', 'memorySaved']
    .map(key => [key, snapshot[key]]),
));

// The sole fake is the HTTP boundary. Successful writes use the public, real store.
export async function editorFixture(t, { future = true } = {}) {
  const home = makeLiveScaleHome(t, { future, scale: false });
  const dom = makeController({ protocol: 'file:', modules:
    ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'annotate', 'profiles-view'] });
  const api = dom.ctx.BriefProfiles;
  const root = dom.document.createElement('section');
  dom.document.body.appendChild(root);
  const posts = [], reads = [], waiters = new Set();
  const wire = { nextPost: null, nextGet: null };
  let c;
  function checkWaiters() {
    // A successful send starts load() in the same turn after publishing its result.
    // Observe the final state of that turn rather than the transient pre-load notification.
    queueMicrotask(() => { for (const check of [...waiters]) check(); });
  }
  function draw(snapshot = c.snapshot(), extra = {}) {
    root.innerHTML = api.render(snapshot.view, { ...snapshot, live: true, ...extra });
  }
  c = api.createController({
    token: () => 'card-editor-test',
    onChange(snapshot) { draw(snapshot); checkWaiters(); },
    fetch: async (url, options) => {
      if (url === '/profiles/state') {
        reads.push(url);
        const next = wire.nextGet;
        wire.nextGet = null;
        if (next) return next();
        return { status: 200, json: async () => home.store.state() };
      }
      assert.equal(url, '/profiles');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      posts.push(body);
      checkWaiters();
      const next = wire.nextPost;
      wire.nextPost = null;
      const result = next ? await next(body) : home.store.handle(body);
      return { status: result.status, json: async () => result.json };
    },
  });
  const unbind = api.bind(root, { controller: () => c });
  t.after(() => { unbind(); root.remove(); });
  await c.load();
  function one(marker, key) {
    const selector = `[data-pf="${marker}"]` + (key ? `[data-profile="${key}"]` : '');
    const el = root.querySelector(selector);
    assert.ok(el, 'actual rendered control: ' + selector);
    return el;
  }
  function click(marker, key) { return dom.fire(one(marker, key), 'click'); }
  function input(marker, value) {
    const el = one(marker);
    el.value = value;
    dom.fire(el, 'input');
    return el;
  }
  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error('card editor state transition did not arrive'));
      }, 3000);
      function check() {
        if (!predicate(c.snapshot())) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(c.snapshot());
      }
      t.after(() => { clearTimeout(timer); waiters.delete(check); });
      waiters.add(check);
      check();
    });
  }
  async function save(marker = 'save-profile-card') {
    const count = posts.length;
    const done = waitFor(s => posts.length === count + 1 && !s.busy && !s.loading);
    click(marker);
    return done;
  }
  function hold(kind) {
    const started = Promise.withResolvers();
    const reply = Promise.withResolvers();
    wire[kind] = () => { started.resolve(); return reply.promise; };
    return { started: started.promise, release: reply.resolve };
  }
  return { ...home, dom, api, root, c, posts, reads, wire, draw, one, click, input, waitFor, save, hold };
}
