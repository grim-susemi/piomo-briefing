import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { axSnapshot, launch, listProfilePids, unnamedInteractive, watchCsp } from '../scripts/cdp.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ax-tree-sample.json', import.meta.url), 'utf8'));

const EXPECTED_AX_TEXT = [
  'RootWebArea "Board"',
  '  main',
  '    button "확인" [disabled]',
  '    button',
  '  textbox "메모" [value=hello]',
  '  link "열기" [expanded, selected]',
  '  checkbox "알림" [checked=mixed]',
  '  heading "상황판"',
  '    StaticText "본문"',
  '  slider "볼륨" [value=37]',
].join('\n');

function fakePage() {
  const listeners = new Map();
  const sent = [];
  const scripts = [];
  return {
    client: {
      listeners,
      async send(method, params = {}) {
        sent.push([method, params]);
        if (method === 'Accessibility.getFullAXTree') return fixture;
        return {};
      },
    },
    async addInitScript(source) { scripts.push(source); },
    sent,
    scripts,
  };
}

function emit(page, method, params) {
  for (const listener of page.client.listeners.get(method) || []) listener(params);
}

function withDeadline(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${what}`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test('axSnapshot enables Accessibility and formats the fixture in child order without node ids', async () => {
  const page = fakePage();
  const snap = await axSnapshot(page);
  assert.deepEqual(page.sent.map(([method]) => method), ['Accessibility.enable', 'Accessibility.getFullAXTree']);
  assert.equal(snap.raw, fixture);
  assert.equal(snap.text, EXPECTED_AX_TEXT);
  assert.doesNotMatch(snap.text, /nodeId|backendDOMNodeId|parentId|childIds/, 'node structures must not leak into the text tree');
  assert.ok(snap.text.indexOf('checkbox "알림"') < snap.text.indexOf('heading "상황판"'), 'child order is preserved');
  assert.ok(!snap.text.includes('generic'), 'ignored nodes are not rendered');
});

test('unnamedInteractive returns only non-ignored interactive nodes with a blank name', () => {
  const found = unnamedInteractive(fixture.nodes);
  assert.deepEqual(found.map((node) => node.nodeId), ['4']);
  assert.equal(found[0].role.value, 'button');
  assert.equal(found[0].name.value.trim(), '');
});

test('malformed AX nodes are tolerated and never reported as named controls', async () => {
  const malformed = [
    { nodeId: 'x', ignored: false, name: { value: '  ' } },
    { nodeId: 'y', ignored: false, role: { value: 'button' } },
    { nodeId: 'z', ignored: true, role: { value: 'button' }, name: { value: '' } },
    { nodeId: 'p', ignored: false, role: { value: 'link' }, name: { value: null }, childIds: ['missing'] },
  ];
  assert.deepEqual(unnamedInteractive(malformed).map((node) => node.nodeId), ['y', 'p']);
  const page = fakePage();
  page.client.send = async (method) => (method === 'Accessibility.getFullAXTree' ? { nodes: malformed } : {});
  const snap = await axSnapshot(page);
  assert.equal(snap.text, 'button\nlink');
});

test('watchCsp collects binding and Log evidence, routes other logs to notes, and assertNone throws with every violation', async () => {
  const page = fakePage();
  const seen = await watchCsp(page);
  assert.deepEqual(page.sent.map(([method]) => method), ['Runtime.addBinding', 'Log.enable']);
  assert.deepEqual(page.sent[0][1], { name: '__omoCspViolation' });
  assert.equal(page.scripts.length, 1);
  assert.match(page.scripts[0], /securitypolicyviolation/);
  assert.match(page.scripts[0], /__omoCspViolation/);
  assert.match(page.scripts[0], /effectiveDirective/);

  seen.assertNone('clean page');

  emit(page, 'Runtime.bindingCalled', {
    name: '__omoCspViolation',
    payload: JSON.stringify({
      disposition: 'enforce',
      directive: 'script-src-elem',
      blocked: 'inline',
      source: 'http://127.0.0.1:1234/b',
      line: 3,
    }),
  });
  emit(page, 'Runtime.bindingCalled', { name: 'otherBinding', payload: '{"directive":"script-src"}' });
  emit(page, 'Runtime.bindingCalled', { name: '__omoCspViolation', payload: '{not json' });
  emit(page, 'Log.entryAdded', {
    entry: {
      level: 'error',
      source: 'security',
      text: "Refused to execute inline script because it violates the following Content Security Policy directive: \"script-src 'nonce-abc'\".",
      url: 'http://127.0.0.1:1234/b',
      lineNumber: 3,
    },
  });
  emit(page, 'Log.entryAdded', { entry: { level: 'warning', source: 'other', text: 'noise' } });
  emit(page, 'Log.entryAdded', { entry: { level: 'error', source: 'javascript', text: 'Uncaught TypeError' } });

  assert.equal(seen.violations.length, 3, 'one parsed binding, one unparsable binding (fail-closed), one security log');
  assert.equal(seen.violations[0].origin, 'binding');
  assert.equal(seen.violations[0].directive, 'script-src-elem');
  assert.equal(seen.violations[0].blocked, 'inline');
  assert.equal(seen.violations[0].source, 'http://127.0.0.1:1234/b');
  assert.equal(seen.violations[1].origin, 'binding');
  assert.equal(seen.violations[1].parseError, true);
  assert.equal(seen.violations[2].origin, 'log');
  assert.match(seen.violations[2].text, /Content Security Policy/);
  assert.deepEqual(seen.notes.map((note) => note.text), ['noise', 'Uncaught TypeError']);

  assert.throws(() => seen.assertNone('page B'), (err) => {
    assert.match(err.message, /page B: 3 CSP violation/);
    assert.match(err.message, /script-src-elem/);
    assert.match(err.message, /inline/);
    assert.match(err.message, /Content Security Policy/);
    return true;
  });
});

test('real Chrome: nonced page A has zero violations and real AX control values, page B unnonced script is caught by binding and Log', { timeout: 60000 }, async () => {
  const controls = '<input aria-label="Memo" value="gate-value-42"><input type="range" aria-label="Volume" value="37">';
  const pageA = `<!doctype html><meta charset="utf-8"><title>A</title>${controls}<script nonce="abc">window.__ran = (window.__ran || 0) + 1;</script>`;
  const pageB = `<!doctype html><meta charset="utf-8"><title>B</title>${controls}<script nonce="abc">window.__ran = (window.__ran || 0) + 1;</script><script>window.pwned = true;</script>`;
  const server = http.createServer((req, res) => {
    const body = req.url === '/a' ? pageA : req.url === '/b' ? pageB : null;
    if (!body) { res.writeHead(204); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "script-src 'nonce-abc'",
    });
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  let page;
  let profileDir;
  try {
    page = await launch({ width: 800, height: 600 });
    profileDir = page.profileDir;
    const seen = await watchCsp(page);

    await page.goto(`http://127.0.0.1:${port}/a`);
    assert.equal(await page.eval('window.__ran'), 1, 'the nonced page A script ran');
    assert.equal(await page.eval('typeof window.pwned'), 'undefined');
    seen.assertNone('page A');
    assert.equal(seen.violations.length, 0, 'page A has zero CSP violations');

    const sawBinding = new Promise((resolve) => {
      const list = page.client.listeners.get('Runtime.bindingCalled') || [];
      const listener = (params) => {
        if (params.name !== '__omoCspViolation') return;
        page.client.listeners.set('Runtime.bindingCalled', list.filter((fn) => fn !== listener));
        resolve(params);
      };
      list.push(listener);
      page.client.listeners.set('Runtime.bindingCalled', list);
    });
    const sawLog = new Promise((resolve) => {
      const list = page.client.listeners.get('Log.entryAdded') || [];
      const listener = (params) => {
        if (!/Content Security Policy/.test(params.entry?.text || '')) return;
        page.client.listeners.set('Log.entryAdded', list.filter((fn) => fn !== listener));
        resolve(params);
      };
      list.push(listener);
      page.client.listeners.set('Log.entryAdded', list);
    });

    await page.goto(`http://127.0.0.1:${port}/b`);
    await withDeadline(Promise.all([sawBinding, sawLog]), 5000, 'page B CSP binding and Log evidence');
    assert.equal(await page.eval('typeof window.pwned'), 'undefined', 'the unnonced script did not run');
    const bindingRecords = seen.violations.filter((violation) => violation.origin === 'binding');
    assert.ok(bindingRecords.length >= 1, 'a binding record was captured');
    assert.match(bindingRecords[0].directive, /^script-src/);
    assert.equal(bindingRecords[0].blocked, 'inline');
    assert.ok(seen.violations.some((violation) => violation.origin === 'log' && /Content Security Policy/.test(violation.text)), 'a Log record naming CSP was captured');
    assert.throws(() => seen.assertNone('page B'), /page B: \d+ CSP violation/);
    console.log('page A: 0 violations');
    console.log('page B: ' + JSON.stringify(seen.violations));

    const afterB = seen.violations.length;
    await page.goto(`http://127.0.0.1:${port}/a`);
    assert.equal(await page.eval('window.__ran'), 1, 'page A still runs after page B');
    assert.equal(seen.violations.length, afterB, 'a clean navigation adds no stale violation');

    const ax = await axSnapshot(page);
    const textbox = ax.raw.nodes.find((node) => node.role?.value === 'textbox' && node.name?.value === 'Memo');
    const slider = ax.raw.nodes.find((node) => node.role?.value === 'slider' && node.name?.value === 'Volume');
    assert.equal(textbox?.value?.value, 'gate-value-42', 'the raw AX textbox value is present');
    assert.equal(String(slider?.value?.value), '37', 'the raw AX slider value is present');
    assert.match(ax.text, /textbox "Memo" \[value=gate-value-42\]/, 'the textbox value is rendered');
    assert.match(ax.text, /slider "Volume" \[value=37\]/, 'the slider value is rendered');
    console.log('AX values: ' + JSON.stringify({ textbox: textbox.value.value, slider: slider.value.value }));
  } finally {
    if (page) await page.close();
    await new Promise((resolve) => server.close(resolve));
    if (profileDir) console.log(`cleanup profile=${profileDir} pids=${JSON.stringify(listProfilePids(profileDir))} exists=${fs.existsSync(profileDir)}`);
  }
  assert.deepEqual(listProfilePids(profileDir), []);
  assert.equal(fs.existsSync(profileDir), false);
});
