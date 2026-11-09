import './helpers/refuse-live-writes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { pageHtml } from '../src/render.mjs';
import { launch } from '../scripts/cdp.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/readability/view-model.json', import.meta.url)));
const gamma = fixture.sessions.find((s) => s.id === 'fx-sess-gamma-running');
const alpha = fixture.sessions.find((s) => s.id === 'fx-sess-alpha-done');

test('automatic disclosures collapse on completion; only actual user choices persist', async () => {
  const empty = { ...fixture, sessions: [], waiting: [] };
  const server = http.createServer((req, res) => {
    if (req.url === '/data.json') return res.end(JSON.stringify(empty));
    if (req.url === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(pageHtml(empty, 7, { mode: 'server', token: 'fixture' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let page;
  try {
    page = await launch({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.eval(`new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('initial model timeout')), 10000);
      if (BriefPage.state.model) { clearTimeout(timer); resolve(); return; }
      BriefPage.hooks.afterApply.push(() => { clearTimeout(timer); resolve(); });
    })`);
    const inject = async (sessions, expectedEvents) => page.eval(`new Promise((resolve, reject) => {
      const root = document.getElementById('app');
      let left = ${expectedEvents};
      const timer = setTimeout(() => { root.removeEventListener('toggle', onToggle, true); reject(new Error('toggle timeout')); }, 10000);
      function onToggle(e) {
        if (!e.target.matches('.overview details')) return;
        if (--left === 0) { root.removeEventListener('toggle', onToggle, true); clearTimeout(timer); resolve(true); }
      }
      if (left) root.addEventListener('toggle', onToggle, true);
      BriefPage.state.model = ${JSON.stringify({ ...empty, sessions })};
      BriefPage.render();
      if (!left) { clearTimeout(timer); resolve(true); }
    })`);
    const snapshot = () => page.eval(`({
      expanded: {...BriefPage.state.ui.expanded},
      gammaWaitingCard: !!document.querySelector('.sec-wait [data-card="fx-sess-gamma-running"]'),
      gammaFold: document.querySelector('[data-open-key="fold:fx-sess-gamma-running"]')?.open ?? null,
      gammaSession: document.querySelector('[data-card="fx-sess-gamma-running"]')?.closest('details.sess')?.open ?? null,
      staleSection: document.querySelector('[data-open-key="sec:stale"]')?.open ?? null,
      alphaSession: document.querySelector('[data-card="fx-sess-alpha-done"]')?.closest('details.sess')?.open ?? null
    })`);
    const done = { ...gamma, status: 'done', statusKey: 'done', decisions: [], openQuestion: null };
    const alphaStale = { ...alpha, status: 'in_progress', statusKey: 'in_progress', chips: ['오래됨'] };
    await inject([gamma], 0);
    let s = await snapshot();
    assert.equal(s.gammaWaitingCard, true);
    assert.equal(s.gammaFold, false);
    assert.equal(s.gammaSession, null);
    const initialExpanded = s.expanded;
    // Check collapse first so mutation testing reports the user-visible failure directly.
    await inject([done], 0);
    s = await snapshot();
    assert.equal(s.gammaWaitingCard, false, 'completed session leaves the waiting card section');
    assert.equal(s.gammaSession, false, 'completed session row is collapsed by default');
    assert.deepEqual(initialExpanded, {}, 'active render must not record disclosure preferences');
    assert.deepEqual(s.expanded, {}, 'render must not record disclosure preferences');

    await inject([gamma, alphaStale], 0);
    const click = async (selector) => {
      const point = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView(); const r = e.getBoundingClientRect(); return {x:r.left + r.width / 2, y:r.top + r.height / 2}; })()`);
      await page.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await page.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      await page.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    };
    await click('[data-open-key="sec:stale"] > summary');
    await click('[data-open-key="sec:stale"] > summary');
    s = await snapshot();
    assert.equal(s.expanded['sec:stale'], false, 'explicit close must be recorded');
    await click('[data-open-key="sec:stale"] > summary');
    await click('[data-open-key="sess:fx-sess-alpha-done"] > summary');
    await click('[data-open-key="sess:fx-sess-alpha-done"] > summary');
    s = await snapshot();
    assert.equal(s.expanded['sess:fx-sess-alpha-done'], false, 'explicit session close must be recorded');
    await click('[data-open-key="sess:fx-sess-alpha-done"] > summary');
    s = await snapshot();
    assert.deepEqual(s.expanded, { 'sec:stale': true, 'sess:fx-sess-alpha-done': true });
    await inject([done, alphaStale], 2);
    s = await snapshot();
    assert.equal(s.gammaWaitingCard, false);
    assert.equal(s.gammaSession, false);
    assert.equal(s.staleSection, true);
    assert.equal(s.alphaSession, true);
    assert.deepEqual(s.expanded, { 'sec:stale': true, 'sess:fx-sess-alpha-done': true });

    await page.eval(`document.getElementById('app').addEventListener('click', function (event) {
      if (event.target.closest('[data-open-key="sess:fx-sess-gamma-running"] > summary')) event.preventDefault();
    })`);
    await click('[data-open-key="sess:fx-sess-gamma-running"] > summary');
    s = await snapshot();
    assert.equal(s.gammaSession, false, 'a later listener cancels the native default toggle');
    await inject([done, alphaStale], 0);
    s = await snapshot();
    assert.equal(s.gammaSession, false, 'a cancelled native choice must not reopen the session row on refresh');
    assert.deepEqual(s.expanded, { 'sec:stale': true, 'sess:fx-sess-alpha-done': true });
  } finally {
    if (page) await page.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
