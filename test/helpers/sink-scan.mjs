// DOM sink scanner for the board page scripts (test/render-guard.test.mjs keeps the reviewed inventory).
// Node built-ins only: scanSinks([{ file, text }]) -> sorted [{ file, kind, expr }].
// Comments are stripped and whitespace collapsed before scanning; string literals are preserved so bracket
// forms (el['innerHTML']) stay visible, and each literal's decoded value is also checked for HTML-attribute
// fragments (style=", href=", src=", on<event>=) a renderer may hand to innerHTML.
// Equivalent syntax is the same sink: quoted, computed or static-backtick Object.assign keys, a spaced or broken
// `style . cssText` (also reached as el['style'].cssText / el?.['style']?.cssText), bracket method calls
// (el['insertAdjacentHTML'](...)), document['write'], compound assignment (innerHTML += / ??= / ||= / &&=),
// optional-chained calls and assignments (el?.setAttribute, document?.write, el?.['outerHTML']), and JS-escaped
// attribute quotes ("href=\"x\"").
// Every recorded expr is COMPLETE: the whole right-hand side up to its top-level `;`, or the whole call
// argument list. Diagnostics may shorten what they print; the compared identity never is.
const ID = String.raw`[A-Za-z_$][\w$]*`;
// `.` and `?.` are the same member access; a call or an index may be optional too (a?.(x), a?.[k])
const DOT = String.raw`\s*(?:\?\.|\.)\s*`;
const TAIL = String.raw`\s*(?:\?\.)?\s*`;
const RCV = ID + '(?:' + DOT + ID + '|' + TAIL + String.raw`\([^()]*\)|` + TAIL + String.raw`\[[^\]]*\])*`;
// style . cssText (spaces or a line break around the dot) is the same compound property
const PROPS = 'innerHTML|outerHTML|srcdoc|style\\s*(?:\\?\\.|\\.)\\s*cssText|style|href|src|on[a-zA-Z]+';
const SINK_KEY = 'innerHTML|outerHTML|srcdoc|cssText|style|href|src|on[a-z]+';
// a static literal key is one quote style: 'x', "x" or `x` (a backtick literal with no ${} interpolation)
const QUOTE = "'\"`";
const QCAP = '([' + QUOTE + '])';
const QOPT = '(?:[' + QUOTE + ']?)';
// every assignment form is a sink: = += ??= ||= &&= (and the other compound operators); == === => are not
const ASSIGN = String.raw`(?:\+\+|--|\*\*|<<|>>>|>>|&&|\|\||\?\?|[+\-*/%&|^])?=(?![=>])`;
const CALL = String.raw`\s*(?:\?\.)?\s*\(`;
const ATTR_STRING = /\s(?:style|href|src)="|\son[a-z]+=/;
const ESCAPED = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
const KEYWORD_BEFORE_REGEX = /\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else)$/;

function stringEnd(text, start) {
  const q = text[start];
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === q) return i + 1;
    i++;
  }
  return text.length;
}

function regexStart(code, prev) {
  if (prev === '') return true;
  if ('([{=,:;!&|?+-*%^~<>'.includes(prev)) return true;
  return KEYWORD_BEFORE_REGEX.test(code.replace(/\s+$/, ''));
}

function regexEnd(text, start) {
  let i = start + 1, inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') return -1;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < text.length && /[a-z]/.test(text[i])) i++;
      return i;
    }
    i++;
    if (i - start > 400) return -1;
  }
  return -1;
}

// comments out, strings/regexes kept verbatim, and the value of every string/template literal
export function tokenize(text) {
  const literals = [];
  let code = '', prev = '', i = 0;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      code += ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      code += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = stringEnd(text, i);
      literals.push(text.slice(i + 1, end - 1));
      code += text.slice(i, end);
      i = end;
      prev = c;
      continue;
    }
    if (c === '/' && regexStart(code, prev)) {
      const end = regexEnd(text, i);
      if (end > 0) { code += text.slice(i, end); i = end; prev = '/'; continue; }
    }
    code += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code: code.replace(/\s+/g, ' ').trim(), literals };
}

// the complete right-hand side of an assignment: up to its top-level ';' (or its block's closing '}')
function rhs(code, start) {
  let depth = 0, i = start, prev = '=';
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') { i = stringEnd(code, i); prev = c; continue; }
    if (c === '/' && regexStart(code.slice(0, i), prev)) {
      const end = regexEnd(code, i);
      if (end > 0) { i = end; prev = '/'; continue; }
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (c === ';' && depth === 0) break;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return code.slice(start, i).trim();
}

// the complete balanced arguments of one call, starting just after its '(' (no length cap)
function callArgs(code, start) {
  let depth = 1, i = start, prev = '(';
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') { i = stringEnd(code, i); prev = c; continue; }
    if (c === '/' && regexStart(code.slice(0, i), prev)) {
      const end = regexEnd(code, i);
      if (end > 0) { i = end; prev = '/'; continue; }
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return code.slice(start, i);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return code.slice(start);
}

// the run-time value of a JS literal, so "href=\"x\"" is seen as href="x"; the expr keeps the raw literal
function decodeLiteral(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, body) => {
    if (body.length > 1 && (body[0] === 'u' || body[0] === 'x')) {
      const hex = body[0] === 'u' && body[1] === '{' ? body.slice(2, -1) : body.slice(1);
      const n = parseInt(hex, 16);
      if (Number.isFinite(n) && n <= 0x10ffff) return String.fromCodePoint(n);
      return m;
    }
    if (body === '\n' || body === '\r') return '';
    return Object.prototype.hasOwnProperty.call(ESCAPED, body) ? ESCAPED[body] : body;
  });
}

export function scanSinks(sources) {
  const out = [];
  for (const { file, text } of sources) {
    const { code, literals } = tokenize(text);
    const push = (kind, expr) => out.push({ file, kind, expr: expr.replace(/\s+/g, ' ').trim() });
    const each = (re, fn) => { for (const m of code.matchAll(re)) fn(m, m.index); };

    each(new RegExp('(' + RCV + ')' + DOT + '(' + PROPS + ')\\s*(' + ASSIGN + ')', 'g'), (m, at) => {
      const op = m[2].replace(/\s+/g, '').replace(/\?\./g, '.');
      push(op, m[1] + '.' + op + ' ' + m[3] + rhs(code, at + m[0].length));
    });
    each(new RegExp('(' + RCV + ')' + TAIL + '\\[\\s*' + QCAP + '(innerHTML|outerHTML|srcdoc|style|cssText|href|src|on[a-zA-Z]+)\\2\\s*\\]\\s*(' + ASSIGN + ')', 'g'), (m, at) => {
      push('bracket:' + m[3], m[1] + "['" + m[3] + "'] " + m[4] + rhs(code, at + m[0].length));
    });
    // a bracket-style receiver is the same style.cssText sink: el['style'].cssText += raw, el?.['style']?.cssText
    each(new RegExp('(' + RCV + ')' + TAIL + '\\[\\s*' + QCAP + 'style\\2\\s*\\]' + DOT + 'cssText\\s*(' + ASSIGN + ')', 'g'), (m, at) => {
      const eq = m[3];
      const lhs = m[0].slice(0, m[0].length - eq.length).trim();
      push('style.cssText', lhs + ' ' + eq + rhs(code, at + m[0].length));
    });
    each(new RegExp('(' + RCV + ')' + DOT + '(insertAdjacentHTML|setAttributeNS|setAttribute)' + CALL, 'g'), (m, at) => {
      push(m[2], m[1] + '.' + m[2] + '(' + callArgs(code, at + m[0].length) + ')');
    });
    // a bracket method call is the same call: el['insertAdjacentHTML']('beforeend', raw)
    each(new RegExp('(' + RCV + ')' + TAIL + '\\[\\s*' + QCAP + '(insertAdjacentHTML|setAttributeNS|setAttribute)\\2\\s*\\]' + CALL, 'g'), (m, at) => {
      push(m[3], m[1] + '.' + m[3] + '(' + callArgs(code, at + m[0].length) + ')');
    });
    each(new RegExp('\\b(document)' + DOT + '(write|writeln)' + CALL, 'g'), (m, at) => {
      push('document.' + m[2], 'document.' + m[2] + '(' + callArgs(code, at + m[0].length) + ')');
    });
    each(new RegExp('\\b(document)' + TAIL + '\\[\\s*' + QCAP + '(write|writeln)\\2\\s*\\]' + CALL, 'g'), (m, at) => {
      push('document.' + m[3], 'document.' + m[3] + '(' + callArgs(code, at + m[0].length) + ')');
    });
    each(new RegExp('\\bObject' + DOT + 'assign' + CALL, 'g'), (m, at) => {
      const args = callArgs(code, at + m[0].length);
      // quoted, computed or static-backtick keys assign the same property: {'innerHTML': raw} / {['innerHTML']: raw} / {[`innerHTML`]: raw}
      if (new RegExp('(?:^|[\\s,{])(?:\\[\\s*)?' + QOPT + '(' + SINK_KEY + ')' + QOPT + '\\s*(?:\\]\\s*)?:', 'i').test(args)) {
        push('Object.assign', 'Object.assign(' + args + ')');
      }
    });
    for (const value of literals) {
      if (!ATTR_STRING.test(decodeLiteral(value))) continue;
      push('html-attr-string', value);
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1
    : a.kind < b.kind ? -1 : a.kind > b.kind ? 1
      : a.expr < b.expr ? -1 : a.expr > b.expr ? 1 : 0));
}
