import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const FIX = join(REPO, 'test', 'fixtures', 'refresh-spike');
const DECISION = join(REPO, 'docs', 'refresh-decision.md');
const EV_JSON = process.env.OMO_BRIEFING_EV_REFRESH_JSON
  || 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/piomo-living-briefing/task-5-refresh.json';

const PRIMARY = '기본안(script 재삽입)';
const FALLBACK = '대체안(iframe+postMessage)';
const KEYS = ['primaryWorks', 'seqObserved', 'scrollKept', 'fallbackWorks', 'fallbackScrollKept', 'clipboard', 'survivesMissingData'];
const BOOLS = ['primaryWorks', 'scrollKept', 'fallbackWorks', 'fallbackScrollKept', 'survivesMissingData'];

// Strict validator: a value like "true" or a missing key must never turn into a decision.
function validateResult(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new TypeError('result must be an object');
  for (const k of KEYS) if (!(k in r)) throw new TypeError('missing key: ' + k);
  for (const k of BOOLS) if (typeof r[k] !== 'boolean') throw new TypeError(k + ' must be boolean');
  if (!Number.isInteger(r.seqObserved) || r.seqObserved < 0) throw new TypeError('seqObserved must be a non-negative integer');
  if (!['api', 'execCommand', 'none'].includes(r.clipboard)) throw new TypeError('clipboard must be api|execCommand|none');
  return r;
}

// Plan rule: primaryWorks && scrollKept -> primary; else fallbackWorks && fallbackScrollKept -> fallback; else fail (IS-6 unmet).
function decide(r) {
  validateResult(r);
  if (r.primaryWorks && r.scrollKept) return PRIMARY;
  if (r.fallbackWorks && r.fallbackScrollKept) return FALLBACK;
  return null;
}

function parseDecisionDoc(text) {
  const choice = /^선택:\s*(.+?)\s*$/m.exec(text);
  assert.ok(choice, 'doc must contain a line "선택: <기본안|대체안>"');
  const block = /```json\s*([\s\S]*?)```/.exec(text);
  assert.ok(block, 'doc must embed the measured result as a ```json block');
  return { choice: choice[1], result: JSON.parse(block[1]), text };
}

test('fixture: data.js is a classic-script callback call with seq 1', () => {
  const p = join(FIX, 'data.js');
  assert.ok(existsSync(p), 'data.js fixture must exist');
  assert.equal(readFileSync(p, 'utf8').trim(), 'window.__briefData && window.__briefData({seq:1})');
});

test('fixture: index.html is a classic-script poller with the counters the QA reads', () => {
  const p = join(FIX, 'index.html');
  assert.ok(existsSync(p), 'index.html fixture must exist');
  const h = readFileSync(p, 'utf8');
  assert.ok(!/type\s*=\s*["']module["']/i.test(h), 'must be classic script (module scripts are CORS-blocked on file://)');
  assert.ok(!/(?:src|href)\s*=\s*["']https?:/i.test(h) && !/\bfetch\(|XMLHttpRequest/.test(h), 'no external requests / fetch');
  for (const needle of ['data.js?v=', '__briefPolls', '__briefData', '__loadMarker', 'navigator.clipboard.writeText', "execCommand('copy')", '1000']) {
    assert.ok(h.includes(needle), 'index.html must contain ' + needle);
  }
});

test('fixture: iframe fallback pages pass data to the parent via postMessage', () => {
  const idx = join(FIX, 'index-iframe.html');
  const dh = join(FIX, 'data.html');
  assert.ok(existsSync(idx) && existsSync(dh), 'index-iframe.html and data.html fixtures must exist');
  assert.ok(readFileSync(dh, 'utf8').includes('parent.postMessage'), 'data.html must call parent.postMessage');
  const h = readFileSync(idx, 'utf8');
  assert.ok(h.includes('event.source === ') && h.includes('contentWindow'), 'parent must accept only messages whose source is the iframe window');
  assert.ok(h.includes('data.html?v='), 'parent must reload data.html with a cache-busting query');
});

test('decide(): rule table and malformed results', () => {
  const base = { primaryWorks: true, seqObserved: 2, scrollKept: true, fallbackWorks: true, fallbackScrollKept: true, clipboard: 'api', survivesMissingData: true };
  assert.equal(decide(base), PRIMARY);
  assert.equal(decide({ ...base, scrollKept: false }), FALLBACK);
  assert.equal(decide({ ...base, primaryWorks: false }), FALLBACK);
  assert.equal(decide({ ...base, primaryWorks: false, fallbackScrollKept: false }), null);
  assert.equal(decide({ ...base, scrollKept: false, fallbackWorks: false }), null);
  assert.throws(() => decide({ ...base, primaryWorks: 'true' }), TypeError);
  assert.throws(() => decide({ ...base, clipboard: 'yes' }), TypeError);
  assert.throws(() => decide({ ...base, seqObserved: '2' }), TypeError);
  const { survivesMissingData, ...missing } = base;
  assert.throws(() => decide(missing), TypeError);
  assert.throws(() => decide(null), TypeError);
  assert.throws(() => decide([]), TypeError);
});

test('docs/refresh-decision.md: choice matches the measured values and cites existing evidence', () => {
  assert.ok(existsSync(DECISION), 'docs/refresh-decision.md must exist');
  const doc = parseDecisionDoc(readFileSync(DECISION, 'utf8'));
  const expected = decide(doc.result);
  assert.notEqual(expected, null, 'neither mechanism works on file:// -> IS-6 unmet, todo 5 fails');
  assert.equal(doc.choice, expected, 'doc choice must follow the decision rule applied to the embedded result');
  assert.ok(doc.result.survivesMissingData, 'page must survive a deleted data.js');
  const cited = [...doc.text.matchAll(/^- (C:\/\S.*)$/gm)].map((m) => m[1]);
  assert.ok(cited.length >= 1, 'doc must list evidence paths');
  if (existsSync(dirname(EV_JSON))) for (const p of cited) assert.ok(existsSync(p), 'cited evidence missing: ' + p);
});

test('docs/refresh-decision.md embedded result equals the EV json (stale_state guard)', (t) => {
  if (!existsSync(EV_JSON)) return t.skip('EV json not present on this machine: ' + EV_JSON);
  const doc = parseDecisionDoc(readFileSync(DECISION, 'utf8'));
  assert.deepEqual(doc.result, JSON.parse(readFileSync(EV_JSON, 'utf8')));
});
