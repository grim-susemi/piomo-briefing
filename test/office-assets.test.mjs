// Office art (plan todo 2): the cat and body symbols are the mockup's bytes, and every prop is one self-contained SVG element.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCKUP_SHA256 = 'a84af4d9f64e23bd2453bfc2d4a5b65628bb426020b379b8378b9b5901d5ca4b';
const FIXTURE_SHA256 = '0e375357c4e6b0100df475dd9acdf236e94bbfb8e816a9398ad7f9b1ea6dd50b';
const MOCKUP = process.env.OFFICE_MOCKUP || 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/omo-office-view/mockup/office-mockup.html';
const ASSETS = process.env.OFFICE_ASSETS || path.join(ROOT, 'src/page/office-assets.js');
const FIXTURE = path.join(ROOT, 'test/fixtures/office-symbols.svg');
const REQUIRED_PROPS = ['desk', 'monitor', 'sofa', 'plant', 'shelf', 'conveyor', 'whiteboard'];
const FORBIDDEN = [/<image[\s>]/i, /<script[\s>]/i, /href="http/i, /xlink:href="http/i, /data:/i];

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const symbol = (text, id) => {
  const m = text.match(new RegExp('<symbol id="' + id + '"[\\s\\S]*?<\\/symbol>'));
  return m ? m[0] : null;
};

function load(file) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return ctx.BriefOfficeArt;
}

// True when the string is exactly one root element: tags balance and depth reaches zero only at the last tag.
function isSingleElement(svg) {
  const tags = [...svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)];
  if (tags.length === 0) return false;
  let depth = 0;
  for (let i = 0; i < tags.length; i++) {
    const [, close, , , selfClosing] = tags[i];
    if (close) depth -= 1;
    else if (!selfClosing) depth += 1;
    if (depth < 0) return false;
    if (depth === 0 && i < tags.length - 1) return false;
  }
  return depth === 0 && tags[0][1] === '' && svg.trimStart().startsWith('<');
}

test('cat and body symbols are the mockup bytes (fixture oracle, mockup sha256 when present)', (t) => {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(sha256(fixture), FIXTURE_SHA256, 'fixture bytes changed');
  if (!fs.existsSync(MOCKUP)) {
    t.diagnostic('mockup not present at ' + MOCKUP + '; the fixture is the oracle');
    return;
  }
  const mockup = fs.readFileSync(MOCKUP, 'utf8');
  assert.equal(sha256(fs.readFileSync(MOCKUP)), MOCKUP_SHA256, 'mockup changed since the symbols were traced');
  assert.equal(fixture, symbol(mockup, 'cat') + '\n' + symbol(mockup, 'body') + '\n');
});

test('the classic script exports one frozen table whose symbols equal the fixture', () => {
  const art = load(ASSETS);
  assert.ok(Object.isFrozen(art), 'BriefOfficeArt is frozen');
  assert.ok(Object.isFrozen(art.symbols), 'symbols are frozen');
  assert.ok(Object.isFrozen(art.props), 'props are frozen');
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(art.symbols.cat, symbol(fixture, 'cat'));
  assert.equal(art.symbols.body, symbol(fixture, 'body'));
});

test('every prop is exactly one balanced SVG element and all required props exist', () => {
  const art = load(ASSETS);
  for (const name of REQUIRED_PROPS) assert.ok(typeof art.props[name] === 'string', name + ' is present');
  for (const [name, svg] of Object.entries(art.props)) {
    assert.ok(isSingleElement(svg), name + ' is one balanced SVG element');
  }
});

test('no symbol or prop loads third-party or executable content', () => {
  const art = load(ASSETS);
  const all = [...Object.values(art.symbols), ...Object.values(art.props)];
  for (const svg of all) {
    for (const bad of FORBIDDEN) assert.doesNotMatch(svg, bad, 'forbidden pattern ' + bad);
  }
});

test('whiteboard is the mockup panel and its five sticky notes, in mockup order', (t) => {
  const art = load(ASSETS);
  const board = art.props.whiteboard;
  assert.equal((board.match(/<polygon /g) || []).length, 6, 'one panel and five notes');
  const fills = [...board.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1]);
  assert.deepEqual(fills, ['#f4f6fb', '#ffcf5a', '#ff8fab', '#7aa2ff', '#4fd1a5', '#ffcf5a']);
  if (!fs.existsSync(MOCKUP)) {
    t.diagnostic('mockup not present; whiteboard source check skipped');
    return;
  }
  const mockup = fs.readFileSync(MOCKUP, 'utf8');
  assert.ok(mockup.includes('fill="#f4f6fb" stroke="#9aa6c0" stroke-width="2"'), 'panel is drawn in the mockup');
  assert.ok(mockup.includes("[[10.5,86,'#ffcf5a'],[10.95,86,'#ff8fab'],[11.4,86,'#7aa2ff'],[10.5,72,'#4fd1a5'],[10.95,72,'#ffcf5a']]"), 'five notes are drawn in the mockup, in this order');
});

test('art size is reported for the page growth budget', (t) => {
  const art = load(ASSETS);
  const sizes = {
    symbols: Buffer.byteLength(Object.values(art.symbols).join('')),
    props: Buffer.byteLength(Object.values(art.props).join('')),
  };
  sizes.total = sizes.symbols + sizes.props;
  t.diagnostic('art bytes ' + JSON.stringify(sizes));
  assert.ok(sizes.total > 0);
});
