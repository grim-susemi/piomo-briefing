// Render guard (plan todo 2): every DOM sink in src/page/*.js is reviewed here, page.js esc() fails closed,
// and the five hostile fixture strings are asserted to escape. Adding, changing, removing or duplicating a
// sink fails this test until REVIEWED below is updated on purpose.
// Each reviewed identity is the COMPLETE normalized expression - the whole assignment right-hand side or the
// whole call argument list - so a change past any old 60/80/100-character prefix still fails the guard.
// Equivalent syntax is the same sink: quoted, computed or static-backtick Object.assign keys, a spaced or
// broken `style . cssText` (also reached as el['style'].cssText / el?.['style']?.cssText), JS-escaped
// attribute quotes in a literal, bracket method calls (el['insertAdjacentHTML'](...)), compound assignment
// (innerHTML += / ??= / ||= / &&=) and optional-chained calls and assignments (el?.setAttribute,
// document?.write, el?.['outerHTML']).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSinks } from './helpers/sink-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PAGE_FILES = fs.readdirSync(path.join(ROOT, 'src/page')).filter((f) => f.endsWith('.js')).sort();
const SOURCES = PAGE_FILES.map((file) => ({ file, text: read('src/page/' + file) }));
const FIXTURE = JSON.parse(read('test/fixtures/hostile-strings.json'));

// Reviewed at 054543c, entry by entry: [file, kind, normalized expression, why it is safe].
// Why each sink is safe: esc()/escapeHtml() on every model string, an allowlisted source, or a value the
// page computes itself (constant markup, a number, internal UI state, or an event-handler function).
// Reviewed entry by entry: [file, kind, complete normalized expression, why it is safe].
// Why each sink is safe: esc()/escapeHtml() on every model string, an allowlisted source, or a value the
// page computes itself (constant markup, a number, internal UI state, or an event-handler function).
const REVIEWED_ROWS = [
  ["alarm.js", "innerHTML", "b.innerHTML =soundLabel(on)", "soundLabel(): our own icons and words only"],
  ["alarm.js", "setAttribute", "b.setAttribute('aria-pressed', on ? 'true' : 'false')", "boolean, not model text"],
  ["annotate.js", "innerHTML", "b.innerHTML =ic('message-square', 'ic-xs') + ' 주석'", "constant icon + label, no model text"],
  ["annotate.js", "innerHTML", "el.innerHTML =popHtml(c, kindOf(ids) + (pin ? ' ' + pinText(pin) : ''), text ? cut(collapse(text), SHOW_MAX) : snip, paths)", "popHtml() escapes every model string with esc()"],
  ["annotate.js", "innerHTML", "slot.innerHTML =trayInner(c.session, load(c.sid), !!openList[c.sid], c.mode, own(msgs, c.sid) || null, c.expanded)", "trayInner() escapes every model string with esc()"],
  ["annotate.js", "setAttribute", "b.setAttribute('aria-pressed', on ? 'true' : 'false')", "boolean, not model text"],
  ["annotate.js", "setAttribute", "b.setAttribute('class', 'bh')", "constant attribute value"],
  ["annotate.js", "setAttribute", "b.setAttribute('data-ann-act', 'block')", "internal UI state, not model text"],
  ["annotate.js", "setAttribute", "b.setAttribute('title', '이 블록에 주석 달기')", "constant title"],
  ["annotate.js", "setAttribute", "b.setAttribute('type', 'button')", "constant attribute value"],
  ["annotate.js", "setAttribute", "band.el.setAttribute('class', 'band')", "constant attribute value"],
  ["annotate.js", "setAttribute", "el.setAttribute('aria-hidden', 'true')", "constant attribute value"],
  ["annotate.js", "setAttribute", "el.setAttribute('aria-label', '주석 달기')", "constant label"],
  ["annotate.js", "setAttribute", "el.setAttribute('aria-label', n + '번 주석')", "our own pin numbers"],
  ["annotate.js", "setAttribute", "el.setAttribute('class', 'pop')", "constant attribute value"],
  ["annotate.js", "setAttribute", "el.setAttribute('class', n ? 'pin' : 'pin pend')", "constant attribute value"],
  ["annotate.js", "setAttribute", "el.setAttribute('role', 'dialog')", "constant attribute value"],
  ["annotate.js", "setAttribute", "m.setAttribute('class', 'am')", "constant attribute value"],
  ["annotate.js", "setAttribute", "pop.el.querySelector('.pconf').setAttribute('hidden', '')", "constant attribute value"],
  ["annotate.js", "setAttribute", "span.setAttribute('aria-label', b.nums.join(', ') + '번 주석')", "our own pin numbers"],
  ["annotate.js", "setAttribute", "span.setAttribute('class', 'anum')", "constant attribute value"],
  ["annotate.js", "setAttribute", "ta.setAttribute('readonly', '')", "constant attribute value"],
  ["annotate.js", "setAttribute", "ta.setAttribute('style', 'position:fixed;top:0;left:0;opacity:0')", "constant CSS string; no model text"],
  ["convo-view.js", "html-attr-string", "\"><i style=\"width:", "pct is a clamped number"],
  ["convo-view.js", "html-attr-string", "<img src=\"", "esc(src) + esc(alt); src from the assets/ allowlist"],
  ["convo-view.js", "html-attr-string", "<span class=\"chip x-stale x-server-stale\" style=\"white-space:normal;word-break:keep-all;overflow-wrap:anywhere\" title=\"설치된 상황판보다 예전 세대인 대화입니다. 대화를 재시작하면 최신 세대가 실시간 상황판을 맡습니다.\">", "constant style/title markup"],
  ["icons.js", "html-attr-string", "\" aria-hidden=\"true\" focusable=\"false\"><use href=\"#i-", "internal sprite name + constant markup"],
  ["page.js", "href", "linkEl.href =url", "loopback url that passed the origin regex"],
  ["page.js", "innerHTML", "badge.innerHTML =(g.BriefIcons ? g.BriefIcons.icon('refresh-cw', 'ic-xs') : '') + ' 새 내용 - 선택·입력이 끝나면 반영'", "constant icon + copy"],
  ["page.js", "innerHTML", "el.innerHTML =html", "html comes from view/convo renderers, each esc()-guarded"],
  ["page.js", "innerHTML", "linkEl.innerHTML ='실시간 보기 열기 ' + (g.BriefIcons ? g.BriefIcons.icon('arrow-right', 'ic-xs') : '') + ' ' + esc(url)", "loopback url through esc(url)"],
  ["page.js", "innerHTML", "main.innerHTML ='<p class=\"fatal\">화면을 그리지 못했습니다: ' + esc(e && e.message) + '</p>'", "fatal notice: esc(e.message)"],
  ["page.js", "innerHTML", "root.innerHTML =g.BriefShell.skeleton(state.ui)", "skeleton(state.ui): constant markup + internal state"],
  ["page.js", "onerror", "es.onerror =guard('sse error', function () { if (++reconnectErrors >= 5) closedNotice = true; if (closedNotice) updateConnectionStatus(); else if (!paused) setStatus('실시간 연결 끊김 - 다시 연결 중'); })", "event handler function, not a string"],
  ["page.js", "onerror", "sc.onerror =function () { sc.remove(); if (!state.model) { state.model = EMPTY; render(); } }", "event handler function, not a string"],
  ["page.js", "onload", "sc.onload =function () { sc.remove(); }", "event handler function, not a string"],
  ["page.js", "onopen", "es.onopen =guard('sse open', function () { paused = false; updateConnectionStatus(); })", "event handler function, not a string"],
  ["page.js", "setAttribute", "badge.setAttribute('aria-label', '● 새 내용 - 선택·입력이 끝나면 반영')", "constant label"],
  ["page.js", "setAttribute", "errEl.setAttribute('style', 'position:fixed;right:8px;bottom:8px;z-index:9999;background:#7a1f1f;color:#fff;font:12px sans-serif;padding:4px 8px;border-radius:4px')", "constant CSS string; no model text"],
  ["page.js", "setAttribute", "linkEl.setAttribute('aria-label', '실시간 보기 열기 → ' + url)", "loopback-validated url, never model text"],
  ["page.js", "setAttribute", "linkEl.setAttribute('style', 'display:' + (ok ? 'block' : 'none') + ';text-align:center;font:13px sans-serif;padding:4px')", "constant CSS string; no model text"],
  ["page.js", "setAttribute", "linkEl.setAttribute('style', 'display:none;text-align:center;font:13px sans-serif;padding:4px')", "constant CSS string; no model text"],
  ["page.js", "setAttribute", "statusEl.setAttribute('data-state', closedNotice ? 'closed' : '')", "internal UI state, not model text"],
  ["page.js", "setAttribute", "statusEl.setAttribute('style', 'position:sticky;top:0;z-index:50;background:#444;color:#fff;font:13px sans-serif;padding:4px 10px;text-align:center')", "constant CSS string; no model text"],
  ["page.js", "setAttribute", "ta.setAttribute('readonly', '')", "constant attribute value"],
  ["page.js", "setAttribute", "use.setAttribute('href', '#i-copy')", "constant sprite id"],
  ["page.js", "setAttribute", "use.setAttribute('href', ok ? '#i-check' : '#i-x')", "constant sprite id"],
  ["page.js", "src", "sc.src ='folded.js?v=' + encodeURIComponent(key)", "own folded script url; the renderer's foldedKey is a 20-hex hash"],
  ["page.js", "src", "sc.src =DATA_URL + '?v=' + (++state.n)", "own data script url (BRIEF_DATA_URL or data.js)"],
  ["plan-view.js", "html-attr-string", "<a class=\"plan-link\" href=\"#", "href/data-goto go through e() = escaped plan target"],
  ["shell.js", "html-attr-string", "\" style=\"--sw:", "width() is a clamped number"],
  ["shell.js", "setAttribute", "chips[i].setAttribute('aria-pressed', on ? 'true' : 'false')", "boolean, not model text"],
  ["shell.js", "setAttribute", "input.setAttribute('aria-label', searchHint(view))", "searchHint(): our own words"],
  ["shell.js", "setAttribute", "input.setAttribute('placeholder', searchHint(view))", "searchHint(): our own words"],
  ["shell.js", "setAttribute", "root.setAttribute('data-peek', peek)", "internal UI state, not model text"],
  ["shell.js", "setAttribute", "root.setAttribute('data-side', side)", "internal UI state, not model text"],
  ["shell.js", "setAttribute", "root.setAttribute('data-view', view)", "internal UI state, not model text"],
  ["shell.js", "setAttribute", "rz.setAttribute('aria-valuenow', String(width(st)))", "clamped number, not model text"],
  ["shell.js", "setAttribute", "wrap.setAttribute('inert', '')", "constant attribute value"],
  ["view.js", "html-attr-string", "<span class=\"chip x-stale x-server-stale\" style=\"white-space:normal;word-break:keep-all;overflow-wrap:anywhere\" title=\"설치된 상황판보다 예전 세대인 대화입니다. 대화를 재시작하면 최신 세대가 실시간 상황판을 맡습니다.\">", "constant style/title markup"],
  ["workers-view.js", "html-attr-string", "<span class=\"w-dot\" style=\"animation-delay:-", "phase() is a number; info.label is our own words"],
  ["workers-view.js", "onfinish", "a.onfinish =remove", "event handler function, not a string"],
  ["workers-view.js", "setAttribute", "el.setAttribute('aria-hidden', 'true')", "constant attribute value"],
];
const REVIEWED = REVIEWED_ROWS.map(([file, kind, expr]) => ({ file, kind, expr }));
const key = (e) => e.file + '\u0000' + e.kind + '\u0000' + e.expr;

// first difference between the scan and REVIEWED, in the message a maintainer needs
function mismatch(actual, expected) {
  const left = new Map();
  for (const e of expected) left.set(key(e), (left.get(key(e)) || 0) + 1);
  const seen = new Set();
  for (const e of actual) {
    const k = key(e);
    const n = left.get(k) || 0;
    if (n === 0) {
      return 'new or changed DOM sink in ' + e.file + ': ' + e.expr + ' - escape it (esc/escapeHtml or textContent)'
        + ' and add a reviewed entry to REVIEWED in test/render-guard.test.mjs';
    }
    left.set(k, n - 1);
  }
  for (const e of expected) {
    if (seen.has(key(e))) continue;
    seen.add(key(e));
    if ((left.get(key(e)) || 0) > 0) {
      return 'reviewed DOM sink no longer present in ' + e.file + ': ' + e.expr
        + ' - remove its REVIEWED entry in test/render-guard.test.mjs (or restore the sink)';
    }
  }
  return 'REVIEWED is out of scan order - keep the rows sorted by file, kind, expression';
}

test('reviewed DOM sink inventory: every sink in src/page/*.js is known, escaped and listed once', () => {
  const actual = scanSinks(SOURCES);
  assert.deepEqual(actual, REVIEWED, mismatch(actual, REVIEWED));
  assert.ok(REVIEWED_ROWS.every((row) => row.length === 4 && row[3]), 'every reviewed entry says why it is safe');
  assert.ok(REVIEWED_ROWS.every((row) => !/TODO/i.test(row.join(' '))), 'no TODO entries in REVIEWED');
  assert.equal(new Set(REVIEWED.map(key)).size, REVIEWED.length, 'REVIEWED has no duplicate entry');
});

test('scanner self-tests: dot, bracket, multiline, Object.assign, HTML-string and event sinks; textContent is not a sink', () => {
  const hits = scanSinks([{ file: 'sample.js', text: `
    el.innerHTML = raw;
    x['outerHTML'] = raw;
    el
      .innerHTML = raw;
    Object.assign(node, { innerHTML: raw, href: url });
    markup = '<div style="color:red">x</div>';
    document.write(raw);
    document.writeln(raw);
    frame.srcdoc = raw;
    el.insertAdjacentHTML('beforeend', raw);
    el.setAttribute('href', raw);
    el.setAttributeNS('http://www.w3.org/1999/xlink', 'href', raw);
    a.href = url; a.src = url; a.style = s; a.style.cssText = s; a.onclick = fn;
    ok = el.textContent = raw;
    // el.innerHTML = commentedOut;
    /* el.outerHTML = commentedOut; */
    s.replace(/[&<>"'\\\`]/g, fn);
    s.replace(/\\/\\/ not a comment/, fn);
  ` }]);
  const kinds = hits.map((h) => h.kind);
  assert.deepEqual(kinds.sort(), [
    'Object.assign', 'bracket:outerHTML', 'document.write', 'document.writeln', 'href', 'html-attr-string',
    'innerHTML', 'innerHTML', 'insertAdjacentHTML', 'onclick', 'setAttribute', 'setAttributeNS', 'src',
    'srcdoc', 'style', 'style.cssText',
  ].sort());
  assert.ok(!hits.some((h) => /textContent|commentedOut/.test(h.expr)), 'textContent and comments are not sinks');
  const twice = scanSinks([{ file: 'sample.js', text: 'el.innerHTML = a;\nel.innerHTML = a;' }]);
  assert.equal(twice.length, 2, 'a duplicated sink stays visible to the guard');
  assert.match(mismatch(twice, twice.slice(0, 1)), /new or changed DOM sink in sample\.js: el\.innerHTML/);
  // malformed sources are data, not a crash: empty, junk, an open comment/string and an unclosed regex
  const broken = scanSinks([
    { file: 'empty.js', text: '' },
    { file: 'junk.js', text: '}}}{ <div style="x' },
    { file: 'open-comment.js', text: '/* no end\nel.innerHTML = x' },
    { file: 'open-quote.js', text: "el.innerHTML = '" },
    { file: 'open-regex.js', text: 'x = /[a/' },
  ]);
  assert.ok(Array.isArray(broken) && broken.every((h) => h.file && h.kind), 'malformed input still returns entries');
});

// equivalent required forms are the same sink, not invisible syntax
test('scanner self-tests: equivalent required forms are the same sink (quoted keys, spaced cssText, escaped attribute, bracket calls)', () => {
  const hits = scanSinks([{ file: 'equiv.js', text: String.raw`
    Object.assign(one, {"innerHTML": raw});
    Object.assign(two, {'href': url});
    css.style
      .cssText = raw;
    css2.style . cssText = raw2;
    const injected = "<a href=\"javascript:alert(1)\">link</a>";
    html["insertAdjacentHTML"]('beforeend', raw);
    document['write'](raw);
    document["writeln"](raw);
  ` }]);
  assert.deepEqual(hits.map((h) => h.kind).sort(), ['Object.assign', 'Object.assign', 'document.write',
    'document.writeln', 'html-attr-string', 'insertAdjacentHTML', 'style.cssText', 'style.cssText'].sort());
  assert.deepEqual(hits.filter((h) => h.kind === 'Object.assign').map((h) => h.expr).sort(),
    ['Object.assign(one, {"innerHTML": raw})', "Object.assign(two, {'href': url})"]);
  assert.deepEqual(hits.filter((h) => h.kind === 'style.cssText').map((h) => h.expr).sort(),
    ['css.style.cssText =raw', 'css2.style.cssText =raw2']);
  const literal = hits.find((h) => h.kind === 'html-attr-string');
  assert.ok(literal, 'an escaped attribute literal is recorded');
  assert.match(literal.expr, /href=\\"javascript:alert\(1\)\\"/, 'the raw literal is kept; its decoded value is tested');
  assert.deepEqual(hits.filter((h) => /^(?:insertAdjacentHTML|document\.write|document\.writeln)$/.test(h.kind))
    .map((h) => h.expr).sort(),
    ["document.write(raw)", "document.writeln(raw)", "html.insertAdjacentHTML('beforeend', raw)"]);
  assert.ok(!hits.some((h) => h.kind.startsWith('bracket:')), 'a bracket call canonicalizes to its dot kind');
});

// compound assignment, optional chaining and computed Object.assign keys are sinks, not invisible syntax
test('scanner self-tests: compound assignment, optional-chained calls and computed keys are the same sink', () => {
  const hits = scanSinks([{ file: 'modern.js', text: `
    el.innerHTML += raw;
    el.innerHTML ??= raw;
    el.innerHTML ||= raw;
    el.innerHTML &&= raw;
    box['outerHTML'] += raw;
    el?.insertAdjacentHTML('beforeend', raw);
    el?.setAttribute('href', raw);
    document?.write(raw);
    document?.['write'](raw);
    el?.['insertAdjacentHTML']('beforeend', raw);
    el?.['setAttribute']('href', raw);
    el?.['outerHTML'] = raw;
    Object.assign(el, {['innerHTML']: raw});
    Object.assign(el, {["outerHTML"]: raw});
  ` }]);
  assert.deepEqual(hits.map((h) => h.kind).sort(), [
    'Object.assign', 'Object.assign', 'bracket:outerHTML', 'bracket:outerHTML', 'document.write',
    'document.write', 'innerHTML', 'innerHTML', 'innerHTML', 'innerHTML', 'insertAdjacentHTML',
    'insertAdjacentHTML', 'setAttribute', 'setAttribute',
  ].sort());
  assert.deepEqual(hits.map((h) => h.expr).sort(), [
    "Object.assign(el, {['innerHTML']: raw})", 'Object.assign(el, {["outerHTML"]: raw})',
    "box['outerHTML'] +=raw", 'document.write(raw)', 'document.write(raw)',
    'el.innerHTML &&=raw', 'el.innerHTML +=raw', 'el.innerHTML ??=raw', 'el.innerHTML ||=raw',
    "el['outerHTML'] =raw",
    "el.insertAdjacentHTML('beforeend', raw)", "el.insertAdjacentHTML('beforeend', raw)",
    "el.setAttribute('href', raw)", "el.setAttribute('href', raw)",
  ].sort());
  // comparison operators are not assignment sinks and must not be invented as ones
  const comparisons = scanSinks([{ file: 'compare.js', text: 'if (el.innerHTML === raw) {}\nif (el.innerHTML == raw) {}' }]);
  assert.deepEqual(comparisons, [], '=== and == are not sink assignments');
});

// the guard's real-source comparison must change for every added, modified and duplicated sink form
test('scanner mutation: added, modified and duplicated sinks all change the reviewed inventory', () => {
  const base = scanSinks(SOURCES);
  assert.equal(base.length, REVIEWED.length, 'the real sources scan to the reviewed inventory');
  const page = read('src/page/page.js');
  const withPage = (text) => scanSinks(SOURCES.map((s) => (s.file === 'page.js' ? { file: s.file, text } : s)));
  const added = {
    plain: 'el.innerHTML = raw;',
    compound: "el.innerHTML += '<b>x</b>';",
    nullish: "el.innerHTML ??= '<b>x</b>';",
    or: "el.innerHTML ||= '<b>x</b>';",
    and: "el.innerHTML &&= '<b>x</b>';",
    bracketCompound: "el['outerHTML'] += raw;",
    optionalCall: "el?.insertAdjacentHTML('beforeend', raw);",
    optionalSetAttribute: "el?.setAttribute('href', raw);",
    optionalDocumentWrite: 'document?.write(raw);',
    optionalBracketWrite: "document?.['write'](raw);",
    optionalBracketCall: "el?.['insertAdjacentHTML']('beforeend', raw);",
    optionalBracketSetAttribute: "el?.['setAttribute']('href', raw);",
    optionalBracketAssign: "el?.['outerHTML'] = raw;",
    computedKey: "Object.assign(el, {['innerHTML']: raw});",
    computedKeyDouble: 'Object.assign(el, {["outerHTML"]: raw});',
    templateComputedKey: 'Object.assign(el, {[`innerHTML`]: raw});',
    bracketStyleCssText: "el['style'].cssText += raw;",
    optionalBracketStyleCssText: "el?.['style']?.cssText += raw;",
    backtickBracketAssign: 'el[`outerHTML`] += raw;',
    backtickDocumentWrite: 'document[`write`](raw);',
    backtickBracketCall: "el?.[`setAttribute`]('href', raw);",
    duplicate: 'el.innerHTML =html;',
  };
  for (const [name, line] of Object.entries(added)) {
    const after = withPage(page + '\n' + line + '\n');
    assert.notDeepEqual(after, base, 'an added sink must change the inventory: ' + name);
    assert.equal(after.length, base.length + 1, 'exactly one new sink is recorded: ' + name);
    assert.match(mismatch(after, base), /new or changed DOM sink in page\.js: /, name);
  }
  const changed = page.replace("+ ' ' + esc(url);", "+ ' ' + url;");
  assert.notEqual(changed, page, 'the page.js showLink tail is the modification probe');
  const modified = withPage(changed);
  assert.notDeepEqual(modified, base, 'a modified sink must change the inventory');
  assert.match(mismatch(modified, base), /new or changed DOM sink in page\.js: linkEl\.innerHTML =.*\+ url/);
});

// a static backtick key and a bracket-style receiver are the same sink, not invisible syntax
test('scanner self-tests: static backtick keys and bracket-style receivers are the same sink', () => {
  const hits = scanSinks([{ file: 'static.js', text: `
    Object.assign(el, {[\`innerHTML\`]: raw});
    el['style'].cssText += raw;
    el?.['style']?.cssText += raw;
    el[\`outerHTML\`] += raw;
    document[\`write\`](raw);
    el?.[\`setAttribute\`]('href', raw);
  ` }]);
  assert.deepEqual(hits.map((h) => h.kind).sort(), [
    'Object.assign', 'bracket:outerHTML', 'document.write', 'setAttribute', 'style.cssText', 'style.cssText',
  ].sort());
  assert.deepEqual(hits.map((h) => h.expr).sort(), [
    'Object.assign(el, {[`innerHTML`]: raw})',
    "el['style'].cssText +=raw",
    "el?.['style']?.cssText +=raw",
    "el['outerHTML'] +=raw",
    'document.write(raw)',
    "el.setAttribute('href', raw)",
  ].sort());
});

// a changed tail is a changed sink: no prefix may stand in for the compared identity
test('scanner self-tests: a changed tail changes the identity (long-tail esc(url) -> url guard regression)', () => {
  const fragments = Array.from({ length: 20 }, (_, i) => "'f" + i + "'").join(' + ');
  const safe = 'el.innerHTML =' + fragments + ' + esc(raw);';
  const unsafe = 'el.innerHTML =' + fragments + ' + raw;';
  const [a] = scanSinks([{ file: 'tail.js', text: safe }]);
  const [b] = scanSinks([{ file: 'tail.js', text: unsafe }]);
  assert.ok(a && b, 'both tail probes are sinks');
  assert.ok(a.expr.endsWith('+ esc(raw)'), 'the complete tail is part of the identity: ' + a.expr);
  assert.ok(a.expr.length > 100, 'the identity is not a 60/80/100-character prefix');
  assert.notEqual(a.expr, b.expr, 'removing esc() changes the identity');
  assert.match(mismatch([b], [a]), /new or changed DOM sink in tail\.js: /);

  // the actual reviewed showLink sink, changed only in its tail, must be named by the guard's diagnostic
  const page = read('src/page/page.js');
  const changed = page.replace("+ ' ' + esc(url);", "+ ' ' + url;");
  assert.notEqual(changed, page, "page.js showLink ends with + ' ' + esc(url);");
  const before = scanSinks([{ file: 'page.js', text: page }]);
  const after = scanSinks([{ file: 'page.js', text: changed }]);
  const was = before.find((e) => e.kind === 'innerHTML' && e.expr.includes('실시간 보기 열기'));
  const is = after.find((e) => e.kind === 'innerHTML' && e.expr.includes('실시간 보기 열기'));
  assert.ok(was && is, 'the showLink sink is inventoried before and after the change');
  assert.match(was.expr, /\+ esc\(url\)$/, 'the reviewed identity ends with esc(url)');
  assert.match(is.expr, /\+ url$/, 'the changed identity ends with raw url');
  assert.match(mismatch(after, before), /new or changed DOM sink in page\.js: linkEl\.innerHTML =.*\+ url - escape it/);
});

// text, comments, regexes and non-sink properties stay out of the inventory
test('scanner self-tests: textContent, comments, plain regex literals and other properties stay clean', () => {
  const hits = scanSinks([{ file: 'clean.js', text: String.raw`
    ok = el.textContent = raw;
    el.className = 'x';
    // el.innerHTML = commentedOut;
    /* el.outerHTML = commentedOut; */
    s.replace(/[&<>"']/g, fn);
    s.replace(/\/\/ not a comment/, fn);
    el.setAttribute('class', 'x');
  ` }]);
  assert.deepEqual(hits.map((h) => h.kind), ['setAttribute'], 'only the real attribute call is a sink');
  assert.ok(!hits.some((h) => /textContent|commentedOut|className/.test(h.expr)));
});

function extractFunction(text, name) {
  const start = text.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return '';
}

test('page.js esc() fails closed: without BriefView it escapes markup instead of returning raw String(v)', () => {
  const body = extractFunction(read('src/page/page.js'), 'esc');
  assert.ok(body, 'src/page/page.js declares function esc');
  const esc = new Function('g', 'return (' + body + ')')({});
  assert.equal(esc('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(esc('&<>"\'`'), '&amp;&lt;&gt;&quot;&#39;&#96;');
  for (const s of FIXTURE) assert.ok(!esc(s).includes('<'), 'no raw < survives: ' + s);
  const withView = new Function('g', 'return (' + body + ')')({ BriefView: { escapeHtml: (v) => '<' + v + '>' } });
  assert.equal(withView('x'), '<x>', 'BriefView.escapeHtml still wins when it exists');
});

test('hostile fixture: exactly the five reviewed strings, each escaped to text', () => {
  assert.deepEqual(FIXTURE, [
    '안녕 <b>x</b>',
    '결정 </script><script>globalThis.pwned=1</script>',
    '보고서 "><img src=x onerror=globalThis.pwned=2>',
    '선택 </textarea><svg onload=globalThis.pwned=3>',
    '링크 javascript:alert(1) & "따옴표" \'끝\'',
  ]);
  const str = extractFunction(read('src/page/view.js'), 'str');
  assert.ok(str, 'src/page/view.js declares function str');
  const view = new Function('g', str + '; return (' + extractFunction(read('src/page/view.js'), 'esc') + ');')({});
  for (const s of FIXTURE) {
    const escaped = view(s);
    assert.ok(!escaped.includes('<') && !escaped.includes('>'), escaped);
  }
});
