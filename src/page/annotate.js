/* omo-briefing annotations: select blocks or text, collect per-conversation notes, and compose feedback Markdown.
 * Classic script, file:// safe. Model strings are escaped. Draft storage and C-BLOCK/C-NOTE contracts stay unchanged. */
(function (g) {
  'use strict';
  var KEY = 'omo-briefing.notes.';
  var MAX_NOTES = 10, TEXT_MAX = 12000, COMMENT_MAX = 1000, QUOTE_MAX = 2000, QUOTE_HEAD = 1500, QUOTE_TAIL = 400;
  var SNIP_MAX = 90, SHOW_MAX = 200, ROW_MAX = 300;
  var GAP = 8, MARGIN = 8, POP_W = 360, DRAG_MIN = 4;
  var BLOCK_SEL = '[data-block],[data-anchor]';
  var PIN_BLOCK = /^rep\/[a-z0-9][a-z0-9_-]{0,63}\/img\/\d+$/;
  var PIN_R = 11;
  var NO_ALT_DRAG = 'a,button,input,textarea,select,label,summary,[contenteditable],[data-copy],[data-ann-act],.pop,.ann-tray';
  var NO_DRAG = NO_ALT_DRAG + ',[data-act]';
  var NO_TEXT = 'button,input,textarea,select,[contenteditable],.pop,.ann-tray';
  var NO_BUTTON = { TR: 1, TD: 1, TH: 1, SUMMARY: 1, TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, IMG: 1, INPUT: 1, BR: 1, HR: 1, SVG: 1 };
  var NO_CHILD = { TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, IMG: 1, INPUT: 1, BR: 1, HR: 1, SVG: 1 };
  var SKIP_TEXT = { BUTTON: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, SCRIPT: 1, STYLE: 1 };
  var INLINE = { A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, CITE: 1, CODE: 1, DATA: 1, DFN: 1, EM: 1, I: 1, KBD: 1, MARK: 1, Q: 1, S: 1,
    SAMP: 1, SMALL: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1, U: 1, VAR: 1 };
  var INTENTS = ['고쳐줘', '질문'];
  var SUB_NAME = { ov: '개요', plan: '계획', wk: '작업자', dec: '결정', rep: '보고서' };
  var PLAN_KIND = { task: '계획 할 일', comp: '계획 구성', wave: '계획 단계', goal: '계획 목표', q: '계획 질문', is: '계획 이상 상태', out: '계획 범위 밖' };
  var TXT = {
    full: '주석은 한 번에 10개까지 - 먼저 보내세요', long: '너무 길어요 - 주석을 나눠 보내세요', empty: '보낼 주석이 없어요', bad: '이 주석은 만들 수 없어요',
    draft: '쓰던 주석을 먼저 추가하거나 취소하세요',
    hint: ['글자를 드래그하거나, 블록 위 ', ' 주석을 누르거나, 빈 곳에서 끌어 여러 블록을 고르면 그 자리에 주석 창이 떠'],
    gone: '바뀜·사라짐', goneTip: '주석을 단 뒤 이 블록이 바뀌었거나 사라졌어요 - 그때 적어 둔 내용 그대로 보내져요',
    copy: 'Markdown 복사', fileHint: '실시간 상황판에서 보내기', copied: '복사했어요 - 그 대화창에 붙여넣으세요',
    copyFail: '복사하지 못했어요 - 목록 보기의 미리 보기에서 직접 복사하세요', noComment: '(의견 없음)'
  };
  var CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;
  var BREAKS = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/g;
  var FOLD = /[ \t\n\r\u000b\u000c\u0085\u2028\u2029]*[\t\n\r\u000b\u000c\u0085\u2028\u2029][ \t\n\r\u000b\u000c\u0085\u2028\u2029]*/g;
  var doc = g.document;
  var env = { root: null, hooks: {}, mounted: false };
  var cache = Object.create(null), openList = Object.create(null), msgs = Object.create(null), warned = Object.create(null);
  var clearPending = Object.create(null);
  var storageDead = false, pop = null, band = null, swallow = false, wasBusy = false;

  function str(v) { return typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  function own(o, k) { return o && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function cps(v) { return Array.from(str(v)); }
  function isText(v) { return typeof v === 'string' && v !== ''; }
  function uniq(list) { var out = []; list.forEach(function (v) { if (out.indexOf(v) < 0) out.push(v); }); return out; }
  function esc(v) { return str(v).replace(/[&<>"'`]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]; }); }
  function ic(name, cls) { var m = g.BriefIcons; return m ? m.icon(name, cls) : ''; }
  function collapse(v) { return str(v).replace(/\s+/g, ' ').trim(); }
  function first(v, n) { return cps(v).slice(0, n).join(''); }
  function cut(v, n) { var c = cps(v); return c.length > n ? c.slice(0, n).join('') + '…' : c.join(''); }
  function field(v) { return str(v).replace(CONTROL, '').replace(FOLD, ' ').trim(); }
  function tenth(v) { return Math.round(v * 10) / 10; }
  function pinOf(v) { var p = obj(v); var ok = function (c) { return typeof c === 'number' && isFinite(c) && c >= 0 && c <= 100; }; return p && ok(p.x) && ok(p.y) ? { x: tenth(p.x), y: tenth(p.y) } : null; }
  function pinText(p) { return '(' + p.x + '%, ' + p.y + '%)'; }
  function report(where, e) { var c = g.console; if (c && typeof c.error === 'function') c.error('[omo-briefing] annotate ' + where, e); }
  function warnOnce(kind, message, e) { if (warned[kind]) return; warned[kind] = true; var c = g.console; if (c && typeof c.warn === 'function') c.warn('[omo-briefing] ' + message + (e ? ': ' + (e && e.message ? e.message : String(e)) : '')); }
  function guard(where, fn) { return function (ev) { try { return fn(ev); } catch (e) { report(where, e); } }; }
  function call(name, args) { var f = env.hooks[name]; if (typeof f !== 'function') return undefined; try { return f.apply(null, args); } catch (e) { report('hooks.' + name, e); return undefined; } }
  function tabLabel(s) { var label = field(s.tabLabel); return label ? label + (typeof s.tabNumber === 'number' && isFinite(s.tabNumber) ? ' #' + s.tabNumber : '') : ''; }
  function tabName(s) { return tabLabel(s) ? '🗂 ' + tabLabel(s) : field(s.title) || '(제목 없음)'; }
  function tabNameHtml(s) { return tabLabel(s) ? ic('app-window') + ' ' + esc(tabLabel(s)) : esc(field(s.title) || '(제목 없음)'); }
  function subName(key) { return own(SUB_NAME, key) || field(key) || '페이지'; }
  function kindOf(blocks) {
    if (blocks.length > 1) return '블록 ' + blocks.length + '개';
    var p = str(blocks[0]).split('/');
    if (p[0] === 'head') return '머리말'; if (p[0] === 'now') return '지금·다음'; if (p[0] === 'flow') return '흐름';
    if (p[0] === 'card') return '요약 카드'; if (p[0] === 'change') return '최근 변화'; if (p[0] === 'done') return '한 일';
    if (p[0] === 'dec') return '결정 카드'; if (p[0] === 'plan') return p[1] === 'todo' ? '할 일 표' : own(PLAN_KIND, p[2]) || '계획';
    if (p[0] === 'wk') return '작업자'; if (p[0] === 'rep') return p[2] === 'img' ? '보고서 그림' : p[2] === 'blk' ? '보고서 블록' : '보고서';
    if (p[0] === 'note') return '보낸 피드백'; if (p[0] === 'att') return '자료'; return '블록';
  }
  function normNote(n) {
    n = obj(n); if (!n) return null;
    var blocks = uniq(arr(n.blocks).filter(isText)); if (!blocks.length || INTENTS.indexOf(n.intent) < 0) return null;
    var out = { blocks: blocks, sub: str(n.sub), text: str(n.text), snip: str(n.snip), intent: n.intent, comment: str(n.comment), paths: uniq(arr(n.paths).filter(isText)), gone: n.gone === true };
    if (n.pin != null) { var pin = pinOf(n.pin); if (!pin || blocks.length !== 1 || !PIN_BLOCK.test(blocks[0])) return null; out.pin = pin; }
    return out;
  }
  function parseList(raw, sid) {
    var data; try { data = JSON.parse(raw); } catch (e) { warnOnce('parse:' + sid, '저장된 주석을 읽지 못해 빈 목록으로 시작합니다', e); return []; }
    if (!obj(data) || data.v !== 1 || !Array.isArray(data.list)) { warnOnce('parse:' + sid, '저장된 주석의 모양이 달라 빈 목록으로 시작합니다'); return []; }
    var list = data.list.map(normNote).filter(Boolean);
    if (list.length !== data.list.length) warnOnce('drop:' + sid, '저장된 주석 중 읽을 수 없는 ' + (data.list.length - list.length) + '개를 뺐습니다');
    return list.slice(0, MAX_NOTES);
  }
  function load(sid) {
    if (own(cache, sid)) return cache[sid]; var raw = null;
    if (!storageDead) { try { var s = g.sessionStorage; raw = s ? s.getItem(KEY + sid) : null; } catch (e) { storageDead = true; warnOnce('storage', '주석을 브라우저 저장소에서 읽지 못해 이 페이지 메모리에만 둡니다', e); } }
    cache[sid] = typeof raw === 'string' && raw ? parseList(raw, sid) : []; return cache[sid];
  }
  function persist(sid) {
    if (storageDead) return; var list = cache[sid] || [];
    try { var s = g.sessionStorage; if (!s) return; if (list.length) s.setItem(KEY + sid, JSON.stringify({ v: 1, list: list })); else s.removeItem(KEY + sid); }
    catch (e) { warnOnce('save', '주석을 브라우저 저장소에 쓰지 못해 이 페이지 메모리에만 둡니다', e); }
  }
  function list(sid) { return JSON.parse(JSON.stringify(load(str(sid)))); }
  function add(sid, note) {
    sid = str(sid); if (sending(sid)) return { error: '보내는 중…' }; var l = load(sid); if (l.length >= MAX_NOTES) return { error: TXT.full };
    var n = normNote(note); if (!n) return { error: TXT.bad }; var len = cps(n.comment).length;
    if (len > COMMENT_MAX) return { error: '의견은 ' + COMMENT_MAX + '자까지예요 (지금 ' + len + '자)' };
    n.gone = false; l.push(n); delete msgs[sid]; persist(sid); return { ok: true, n: l.length };
  }
  function remove(sid, i) {
    sid = str(sid); if (sending(sid)) return false; var l = load(sid);
    if (typeof i !== 'number' || Math.floor(i) !== i || i < 0 || i >= l.length) return false;
    l.splice(i, 1); delete msgs[sid]; persist(sid); return true;
  }
  function clear(sid) { if (sending(str(sid))) return; sid = str(sid); cache[sid] = []; delete msgs[sid]; delete clearPending[sid]; persist(sid); }
  function quoteLines(text) {
    var t = str(text).replace(CONTROL, '').replace(BREAKS, '\n').trim(); var c = Array.from(t);
    if (c.length > QUOTE_MAX) t = c.slice(0, QUOTE_HEAD).join('') + '… (원문 ' + c.length + '자 중 일부)' + c.slice(c.length - QUOTE_TAIL).join('');
    return t.split('\n').map(function (line) { return '> ' + line; });
  }
  function toMarkdown(session, notes, attachments) {
    var s = obj(session) || {}, sid = field(s.id), items = arr(notes).map(normNote).filter(Boolean), subs = [];
    items.forEach(function (a) { var name = field(subName(a.sub)); if (subs.indexOf(name) < 0) subs.push(name); });
    var out = ['## 상황판 피드백: ' + tabName(s), '', '**대화:** ' + (field(s.title) || '(제목 없음)') + ' · ' + sid, '**보낸 곳:** 상황판 → ' + subs.join(', '), ''];
    items.forEach(function (a, i) {
      out.push('### ' + (i + 1) + '. [' + a.intent + '] ' + field(subName(a.sub)) + ' · ' + field(kindOf(a.blocks)));
      var snip = a.pin ? pinText(a.pin) : field(a.snip); out.push('**위치:** ' + field(a.blocks.join(', ')) + (snip ? ' - ' + snip : ''));
      if (field(a.text)) { out.push('**고른 글:**'); Array.prototype.push.apply(out, quoteLines(a.text)); }
      out.push('**의견:** ' + (field(a.comment) || TXT.noComment)); var paths = a.paths.map(field).filter(Boolean);
      if (paths.length) { out.push('**관련 파일:**'); paths.forEach(function (p) { out.push('- ' + p); }); } out.push('');
    });
    out.push('**이 대화 자료:**', '- 대화 id: ' + sid); var seen = [sid];
    arr(attachments).forEach(function (x) { x = obj(x); var p = x ? field(x.path) : ''; if (!p || seen.indexOf(p) >= 0) return; seen.push(p); out.push('- ' + (field(x.label) || '자료') + ': ' + p); });
    return out.join('\n');
  }
  function compose(session) { var s = obj(session), sid = s ? str(s.id) : '', l = sid ? load(sid) : []; if (!l.length) return { error: TXT.empty }; if (l.length > MAX_NOTES) return { error: TXT.full }; var text = toMarkdown(s, l, s.attachments); return cps(text).length > TEXT_MAX ? { error: TXT.long } : { text: text }; }
  function listRow(a, i) {
    var quote = str(a.text) ? '<q class="ti-q">' + esc(cut(collapse(a.text), ROW_MAX)) + '</q> ' : '';
    return '<div class="ti"><span class="n">' + (i + 1) + '</span><span class="it2 ' + (a.intent === '질문' ? 'q' : 'c') + '">' + esc(a.intent) + '</span>' +
      '<span class="ti-b"><span class="ti-w">' + esc(subName(a.sub) + ' · ' + kindOf(a.blocks) + (a.pin ? ' ' + pinText(a.pin) : '')) + '</span>' +
      (a.gone ? ' <span class="chip x-stale ann-gone" title="' + esc(TXT.goneTip) + '">' + esc(TXT.gone) + '</span>' : '') +
      '<span class="ti-t">' + quote + esc(str(a.comment) || TXT.noComment) + '</span></span>' +
      '<button type="button" class="ti-x" data-ann-act="del" data-ann-i="' + i + '" title="지우기" aria-label="' + (i + 1) + '번 주석 지우기">' + ic('x', 'ic-xs') + '</button></div>';
  }
  function trayInner(s, l, open, mode, msg, expanded) {
    var m = typeof msg === 'string' ? { text: msg, ok: false } : obj(msg);
    var note = m && str(m.text) ? '<p class="ann-msg' + (m.ok ? ' ok' : '') + '" role="' + (m.ok || m.sending ? 'status' : 'alert') + '">' + esc(m.text) + '</p>' : '';
    if (m && m.copy && mode === 'live') note += '<button type="button" class="ann-btn" data-ann-act="copy">Markdown 복사</button>';
    if (m && m.conflict) note += '<button type="button" class="ann-btn" data-act="ann-new" data-sid="' + esc(s.id) + '">새로 보내기</button>';
    if (!l.length) return '<p class="hint">' + esc(TXT.hint[0]) + ic('message-square', 'ic-xs') + esc(TXT.hint[1]) + '</p>' + note;
    var live = mode === 'live';
    var html = '<div class="tray" role="group" aria-label="보낼 주석"><span class="tray-n">' + ic('pin') + ' 이 대화에 보낼 주석 <b>' + l.length + '</b>개</span><span class="sp"></span>' +
      '<button type="button" class="ann-btn" data-ann-act="list" aria-expanded="' + (open ? 'true' : 'false') + '">' + (open ? '목록 접기' : '목록 보기') + '</button>' +
      '<button type="button" class="ann-btn danger" data-ann-act="clear">모두 지우기</button>' +
      (live ? '<button type="button" class="ann-btn go" data-ann-act="send"' + (m && m.sending ? ' disabled' : '') + '>' + tabNameHtml(s) + '로 보내기</button>' : '<button type="button" class="ann-btn go" data-ann-act="copy">' + esc(TXT.copy) + '</button><span class="tray-hint">' + esc(TXT.fileHint) + '</span>') + '</div>';
    if (clearPending[str(s.id)]) html += '<div class="ann-clear" role="group" aria-label="주석 지우기 확인"><p>모아 둔 주석을 모두 지울까요?</p><button type="button" class="ann-btn" data-ann-act="clear-cancel">계속 보관</button> <button type="button" class="ann-btn danger" data-ann-act="clear-confirm">모두 지우기</button></div>';
    if (open) { var md = toMarkdown(s, l, s.attachments), key = 'cv:' + str(s.id) + ':ann-prev'; html += '<div class="tlist">' + l.map(listRow).join('') + '<details class="ann-prev" data-open-key="' + esc(key) + '"' + (own(expanded, key) === true ? ' open' : '') + '><summary>' + (live ? '보낼' : '복사할') + ' 내용 미리 보기 · ' + cps(md).length + '/' + TEXT_MAX + '자</summary><pre class="prev">' + esc(md) + '</pre></details></div>'; }
    return html + note;
  }
  function trayBar(session, notes, open, mode, msg) { var s = obj(session) || {}; return '<div class="ann-tray" data-ann-tray="' + esc(str(s.id)) + '">' + trayInner(s, arr(notes).map(normNote).filter(Boolean), !!open, mode, msg) + '</div>'; }
  function tray(session, mode) { var s = obj(session), sid = s ? str(s.id) : ''; return sid ? trayBar(s, load(sid), !!openList[sid], mode, own(msgs, sid) || null) : ''; }
  function place(rect, size, view) {
    var r = obj(rect) || {}, w = num(size && size.width), h = num(size && size.height), vw = num(view && view.width), vh = num(view && view.height);
    var below = num(r.bottom) + GAP, top = below + h + MARGIN <= vh ? below : num(r.top) - GAP - h;
    top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN)); var left = Math.max(MARGIN, Math.min(num(r.left), vw - w - MARGIN)); return { top: Math.round(top), left: Math.round(left) };
  }
  function upper(el) { return String((el && el.tagName) || '').toUpperCase(); }
  function hasClass(el, c) { return !!(el && el.classList && el.classList.contains(c)); }
  function addClass(el, c) { if (el && el.classList) el.classList.add(c); }
  function dropClass(el, c) { if (el && el.classList) el.classList.remove(c); }
  function all(el, sel) { return el ? Array.prototype.slice.call(el.querySelectorAll(sel)) : []; }
  function elOf(n) { return n && n.nodeType === 3 ? n.parentNode : n; }
  function parentEl(el) { var p = el && el.parentNode; return p && p.nodeType === 1 ? p : null; }
  function detach(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
  function connected(n) { return !!(n && env.root && env.root.contains(n)); }
  function blockId(el) { var b = el.getAttribute('data-block'); if (b) return b; var a = el.getAttribute('data-anchor'); return a ? 'plan/' + a : ''; }
  function ownBlock(el) { return !!el.getAttribute('data-block') || !!el.getAttribute('data-anchor'); }
  function blocksIn(root) { return all(root, BLOCK_SEL).filter(function (el) { return blockId(el) && !(el.closest && el.closest('.pop,.ann-tray')); }); }
  function rep(el) { var id = blockId(el), out = el; for (var p = parentEl(el); p && p !== env.root; p = parentEl(p)) { if (!p.matches(BLOCK_SEL)) continue; if (blockId(p) !== id) break; out = p; } return out; }
  function outermost(list) { return list.filter(function (el) { for (var p = parentEl(el); p; p = parentEl(p)) if (list.indexOf(p) >= 0) return false; return true; }); }
  function skipped(el) { return own(SKIP_TEXT, upper(el)) || hasClass(el, 'bh') || hasClass(el, 'anum') || hasClass(el, 'pin') || el.hasAttribute('hidden'); }
  function textOf(el) {
    var out = ''; (function walk(n) { var closed = upper(n) === 'DETAILS' && !n.hasAttribute('open'), kids = n.childNodes || [];
      for (var i = 0; i < kids.length; i++) { var k = kids[i]; if (k.nodeType === 3) { if (!closed) out += k.data; continue; } if (k.nodeType !== 1 || skipped(k) || (closed && upper(k) !== 'SUMMARY')) continue; var gap = !own(INLINE, upper(k)); if (gap) out += ' '; walk(k); if (gap) out += ' '; }
    })(el); out = collapse(out); if (!out) { var img = upper(el) === 'IMG' ? el : el.querySelector('img'); out = img ? collapse(img.getAttribute('alt')) : ''; } return out;
  }
  function selectable(root) {
    var out = []; (function walk(n, opt) { var closed = upper(n) === 'DETAILS' && !n.hasAttribute('open'), kids = n.childNodes || [];
      for (var i = 0; i < kids.length; i++) { var k = kids[i], tag = upper(k); if (k.nodeType === 3) { if (!closed) out.push({ node: k, opt: opt }); continue; } if (k.nodeType !== 1 || (closed && tag !== 'SUMMARY') || tag === 'SVG' || (own(SKIP_TEXT, tag) && tag !== 'BUTTON')) continue; if (!k.hasAttribute('hidden') && !hasClass(k, 'ann-tray')) walk(k, opt || tag === 'BUTTON'); }
    })(root, false); return out;
  }
  function pathsFor(s, id) { var e = obj(own(obj(s.blockSources), id)); if (e) return arr(e.paths).filter(isText); if (id.indexOf('plan/') !== 0) return []; var src = obj(obj(s.plan) && s.plan.source) || {}; var p = str(src.planPath) || str(src.draftPath); return p ? [p] : []; }
  function context() { var c = obj(call('context', [])), s = c && obj(c.session); if (!s || !str(s.id)) return null; return { session: s, sid: str(s.id), sub: str(c.sub), mode: c.mode === 'live' ? 'live' : 'file', expanded: obj(c.expanded) }; }
  function unwrap(m) { var p = m.parentNode; if (!p) return; p.insertBefore(doc.createTextNode(m.textContent), m); p.removeChild(m); if (typeof p.normalize === 'function') p.normalize(); }
  function undecorate(root) { all(root, '.bh').forEach(detach); all(root, '.anum').forEach(detach); all(root, '.rimg .pin').forEach(detach); all(root, 'mark.am').forEach(unwrap); ['ab', 'bann', 'bsel'].forEach(function (c) { all(root, '.' + c).forEach(function (el) { dropClass(el, c); }); }); }
  function wrapText(node, at, len) { var p = node.parentNode, d = node.data, m = doc.createElement('mark'); m.setAttribute('class', 'am'); m.appendChild(doc.createTextNode(d.slice(at, at + len))); if (at > 0) p.insertBefore(doc.createTextNode(d.slice(0, at)), node); p.insertBefore(m, node); if (at + len < d.length) p.insertBefore(doc.createTextNode(d.slice(at + len)), node); p.removeChild(node); }
  var SPACE = /\s/;
  function markText(els, text) {
    var want = str(text).replace(/\s+/g, ''); if (!want || !els.length) return; var parts = [];
    els.forEach(function (el) { Array.prototype.push.apply(parts, selectable(el)); }); var hay = '', at = [], seg = [];
    parts.forEach(function (p, k) { var d = p.node.data; for (var o = 0; o < d.length; o++) { if (SPACE.test(d.charAt(o))) continue; hay += d.charAt(o); at.push([k, o]); seg.push(p.opt ? k : -1); } });
    var n = hay.length;
    function end(s) { var i = s, j = 0; while (j < want.length) { if (i >= n) return -1; if (seg[i] < 0) { if (hay.charAt(i) !== want.charAt(j)) return -1; i++; j++; continue; } var e = i; while (e < n && seg[e] === seg[i]) e++; if (hay.slice(i, e) === want.slice(j, j + e - i)) j += e - i; i = e; } return i; }
    for (var s = 0; s < n; s++) {
      if (seg[s] < 0 ? hay.charAt(s) !== want.charAt(0) : s > 0 && seg[s - 1] === seg[s]) continue; var e = end(s); if (e < 0) continue;
      var req = []; for (var i = s; i < e; i++) if (seg[i] < 0) req.push(i); if (!req.length) continue;
      var a = at[req[0]], b = at[req[req.length - 1]], hit = parts.slice(a[0], b[0] + 1).filter(function (p) { return !p.opt && /\S/.test(p.node.data); });
      hit.forEach(function (p) { var from = p === parts[a[0]] ? a[1] : 0, to = p === parts[b[0]] ? b[1] + 1 : p.node.data.length; wrapText(p.node, from, to - from); }); return;
    }
  }
  function pinHost(el) { var box = el ? el.querySelector('.rimg') : null; return box && box.querySelector('img') ? box : null; }
  function pinEl(p, n) { var el = doc.createElement('span'); el.setAttribute('class', n ? 'pin' : 'pin pend'); if (n) { el.setAttribute('aria-label', n + '번 주석'); el.textContent = String(n); } else el.setAttribute('aria-hidden', 'true'); el.style.left = p.x + '%'; el.style.top = p.y + '%'; return el; }
  function drawPend() { var host = pop && pop.pin ? pinHost(pop.els[0]) : null; if (host) host.appendChild(pinEl(pop.pin, 0)); }
  function badgeHost(el) { var t = upper(el); if (t === 'TR') { var kids = el.childNodes || []; for (var i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) return kids[i]; return null; } return own(NO_CHILD, t) ? null : el; }
  function decorate() {
    var root = env.root; if (!root || !doc) return; undecorate(root); var c = context(); if (pop && (!c || c.sid !== pop.sid || c.sub !== pop.sub)) closePop(); if (!c) return; var byId = Object.create(null);
    blocksIn(root).forEach(function (el) {
      var id = blockId(el); (byId[id] || (byId[id] = [])).push(el); if (!ownBlock(el)) return; addClass(el, 'ab'); if (own(NO_BUTTON, upper(el))) return;
      var b = doc.createElement('button'); b.setAttribute('type', 'button'); b.setAttribute('class', 'bh'); b.setAttribute('data-ann-act', 'block'); b.setAttribute('title', '이 블록에 주석 달기'); b.innerHTML = ic('message-square', 'ic-xs') + ' 주석'; el.appendChild(b);
    });
    var l = load(c.sid), changed = false, badges = [], pins = [];
    l.forEach(function (a, i) { var missing = false, present = [];
      a.blocks.forEach(function (id, k) { var hits = outermost(byId[id] || []); if (!hits.length) missing = true;
        hits.forEach(function (el) { addClass(el, 'bann'); present.push(el); if (k !== 0) return; var host = a.pin ? pinHost(el) : null; if (host) { pins.push({ host: host, pin: a.pin, n: i + 1 }); return; } var hit = badges.filter(function (b) { return b.el === el; })[0]; if (hit) hit.nums.push(i + 1); else badges.push({ el: el, nums: [i + 1] }); });
      });
      if (a.text && !missing) markText(present, a.text); if (a.sub === c.sub && a.gone !== missing) { a.gone = missing; changed = true; }
    });
    badges.forEach(function (b) { var host = badgeHost(b.el); if (!host) return; var span = doc.createElement('span'); span.setAttribute('class', 'anum'); span.setAttribute('aria-label', b.nums.join(', ') + '번 주석'); span.textContent = b.nums.join('·'); host.appendChild(span); });
    pins.forEach(function (p) { p.host.appendChild(pinEl(p.pin, p.n)); });
    if (pop) { pop.els = pop.ids.map(function (id) { return outermost(byId[id] || []); }).reduce(function (a, b) { return a.concat(b); }, []); pop.els.forEach(function (el) { addClass(el, 'bsel'); }); drawPend(); }
    if (changed) persist(c.sid); refreshTray(c);
  }
  function refreshTray(c) { all(env.root, '[data-ann-tray]').forEach(function (slot) { if (slot.getAttribute('data-ann-tray') === c.sid) slot.innerHTML = trayInner(c.session, load(c.sid), !!openList[c.sid], c.mode, own(msgs, c.sid) || null, c.expanded); }); }
  function sending(sid) { return !!(own(msgs, sid) && msgs[sid].sending); }
  function status(sid, msg) { if (msg) msgs[sid] = msg; else delete msgs[sid]; var c = context(); if (c && c.sid === sid) refreshTray(c); }
  function busy() { return !!pop || !!band; }
  function noteBusy() { var b = busy(); if (wasBusy && !b) call('idle', []); wasBusy = b; }
  function draft() { return !!(pop && pop.ta && str(pop.ta.value).trim()); }
  function popError(text) { var p = pop && pop.el.querySelector('.perr'); if (!p) return; p.textContent = text; p.removeAttribute('hidden'); }
  function popHtml(c, kind, shown, paths) {
    return '<div class="ph">' + ic('message-square') + ' <b>' + tabNameHtml(c.session) + '</b> 대화에 주석 · ' + esc(subName(c.sub)) + ' · ' + esc(kind) + '</div>' +
      (shown ? '<div class="pq">' + esc(shown) + '</div>' : '') + (paths.length ? '<div class="pp" title="' + esc(paths.join('\n')) + '">' + ic('paperclip') + ' ' + esc(paths[0]) + (paths.length > 1 ? ' 외 ' + (paths.length - 1) : '') + '</div>' : '') +
      '<div class="seg" role="group" aria-label="주석 종류"><button type="button" class="on" data-ann-intent="고쳐줘" aria-pressed="true">' + ic('pencil') + ' 고쳐줘</button><button type="button" data-ann-intent="질문" aria-pressed="false">' + ic('circle-question-mark') + ' 질문</button></div>' +
      '<label class="plabel">의견<textarea class="pt" rows="3" placeholder="여기에 대한 의견" aria-label="의견"></textarea></label>' +
      '<div class="pb"><span class="kb">Ctrl+Enter 추가 · Esc 취소</span><span class="pc">0/' + COMMENT_MAX + '</span><span class="sp"></span><button type="button" class="ann-btn" data-ann-act="cancel">취소</button><button type="button" class="ann-btn go" data-ann-act="add">주석 추가</button></div>' +
      '<div class="pconf" role="group" aria-label="초안 버리기 확인" hidden><p>쓰던 주석을 버릴까요?</p><button type="button" class="ann-btn" data-ann-act="keep">계속 쓰기</button> <button type="button" class="ann-btn danger" data-ann-act="discard">초안 버리기</button></div><p class="perr" role="alert" hidden></p>';
  }
  function openPop(c, els, text, anchor, pin) {
    closePop(); var ids = uniq(els.map(blockId)), paths = []; ids.forEach(function (id) { pathsFor(c.session, id).forEach(function (p) { if (paths.indexOf(p) < 0) paths.push(p); }); });
    var snip = first(collapse(els.map(textOf).filter(Boolean).join(' / ')), SNIP_MAX), el = doc.createElement('div');
    el.setAttribute('class', 'pop'); el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', '주석 달기');
    el.innerHTML = popHtml(c, kindOf(ids) + (pin ? ' ' + pinText(pin) : ''), text ? cut(collapse(text), SHOW_MAX) : snip, paths); doc.body.appendChild(el);
    pop = { el: el, ta: el.querySelector('textarea'), sid: c.sid, sub: c.sub, ids: ids, els: els, text: text, snip: snip, paths: paths, intent: INTENTS[0], anchor: anchor, last: null, pin: pin || null };
    els.forEach(function (b) { addClass(b, 'bsel'); }); drawPend(); if (load(c.sid).length >= MAX_NOTES) popError(TXT.full);
    if (pop.ta) { pop.ta.addEventListener('keydown', guard('tray key', onPopKey)); pop.ta.addEventListener('input', guard('tray input', onPopInput)); }
    position(); if (pop.ta && typeof pop.ta.focus === 'function') pop.ta.focus({ preventScroll: true }); noteBusy();
  }
  function closePop() { if (!pop) return; var p = pop; pop = null; detach(p.el); p.els.forEach(function (b) { dropClass(b, 'bsel'); }); if (p.pin) all(env.root, '.rimg .pin.pend').forEach(detach); noteBusy(); }
  function cancelPop() {
    if (!draft()) { closePop(); return; }
    var confirm = pop.el.querySelector('.pconf'); confirm.removeAttribute('hidden'); position();
    confirm.querySelector('[data-ann-act="keep"]').focus();
  }
  function keepPop() { if (!pop) return; pop.el.querySelector('.pconf').setAttribute('hidden', ''); if (pop.ta) pop.ta.focus({ preventScroll: true }); position(); }
  function scrollPos() { return num(env.root && env.root.scrollTop) + num(g.scrollY); }
  function hasBox(r) { return !!r && (num(r.right) - num(r.left) > 0 || num(r.bottom) - num(r.top) > 0); }
  function union(rects) { var out = null; rects.filter(hasBox).forEach(function (r) { out = out ? { left: Math.min(out.left, r.left), top: Math.min(out.top, r.top), right: Math.max(out.right, r.right), bottom: Math.max(out.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }); return out; }
  function anchorRect() {
    var a = pop.anchor || {}, r = null;
    if (a.range && connected(a.range.startContainer)) r = a.range.getBoundingClientRect(); else if (a.rect) { var dy = scrollPos() - a.scroll; r = { left: a.rect.left, right: a.rect.right, top: a.rect.top - dy, bottom: a.rect.bottom - dy }; }
    if (!hasBox(r)) r = union(pop.els.filter(connected).map(function (b) { return b.getBoundingClientRect(); })); if (hasBox(r)) pop.last = r; return pop.last || { left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN };
  }
  function viewport() { var de = doc.documentElement; return { width: num(de && de.clientWidth) || num(g.innerWidth), height: num(de && de.clientHeight) || num(g.innerHeight) }; }
  function position() {
    if (!pop) return;
    if (viewport().width <= 599) { pop.el.style.top = 'auto'; pop.el.style.left = '0px'; return; }
    var p = place(anchorRect(), { width: pop.el.offsetWidth || POP_W, height: pop.el.offsetHeight || 0 }, viewport()); pop.el.style.top = p.top + 'px'; pop.el.style.left = p.left + 'px';
  }
  function setIntent(v) { if (!pop || INTENTS.indexOf(v) < 0) return; pop.intent = v; all(pop.el, '[data-ann-intent]').forEach(function (b) { var on = b.getAttribute('data-ann-intent') === v; if (on) addClass(b, 'on'); else dropClass(b, 'on'); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); }
  function addFromPop() {
    if (!pop) return null; var c = context(); if (!c || c.sid !== pop.sid) { closePop(); return null; }
    var note = { blocks: pop.ids, sub: pop.sub, text: pop.text, snip: pop.snip, intent: pop.intent, comment: str(pop.ta && pop.ta.value).trim(), paths: pop.paths }; if (pop.pin) note.pin = pop.pin;
    var r = add(pop.sid, note); if (r.error) { popError(r.error); return r; } closePop(); var sel = g.getSelection && g.getSelection(); if (sel && typeof sel.removeAllRanges === 'function') sel.removeAllRanges(); decorate(); return r;
  }
  function onPopKey(ev) {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { if (typeof ev.preventDefault === 'function') ev.preventDefault(); addFromPop(); }
    else if (ev.key === 'Escape') { if (typeof ev.preventDefault === 'function') ev.preventDefault(); if (typeof ev.stopPropagation === 'function') ev.stopPropagation(); cancelPop(); }
  }
  function onPopInput() { if (!pop || !pop.ta) return; var n = cps(pop.ta.value).length, pc = pop.el.querySelector('.pc'); if (!pc) return; pc.textContent = n + '/' + COMMENT_MAX; if (n > COMMENT_MAX) addClass(pc, 'over'); else dropClass(pc, 'over'); }
  function sendNow(c) { if (sending(c.sid)) return { error: '보내는 중…' }; var r = compose(c.session); if (r.error) msgs[c.sid] = r.error; else delete msgs[c.sid]; refreshTray(c); if (!r.error) call('send', [c.session, r.text]); return r; }
  function legacyCopy(text) { if (!doc || !doc.body || typeof doc.execCommand !== 'function') return false; var ta = doc.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.setAttribute('style', 'position:fixed;top:0;left:0;opacity:0'); doc.body.appendChild(ta); var ok = false; try { ta.select(); ok = !!doc.execCommand('copy'); } catch (e) { report('copy', e); } detach(ta); return ok; }
  function writeClipboard(text) { var cb = g.navigator && g.navigator.clipboard; if (cb && typeof cb.writeText === 'function') return cb.writeText(text).then(function () { return true; }, function (e) { warnOnce('clipboard', '클립보드에 바로 쓰지 못해 예전 방식으로 복사합니다', e); return legacyCopy(text); }); return Promise.resolve(legacyCopy(text)); }
  function copyNow(c) { var r = compose(c.session); if (r.error) { msgs[c.sid] = r.error; refreshTray(c); return r; } writeClipboard(r.text).then(function (ok) { msgs[c.sid] = { text: ok ? TXT.copied : TXT.copyFail, ok: ok }; var now = context(); if (now && now.sid === c.sid) refreshTray(now); }).then(null, function (e) { report('copy', e); }); return r; }
  function trayAction(act, t) {
    var c = context(); if (!c || sending(c.sid)) return;
    if (act === 'send') { sendNow(c); return; } if (act === 'copy') { copyNow(c); return; } if (act === 'list') { openList[c.sid] = !openList[c.sid]; refreshTray(c); return; }
    if (act === 'clear') { clearPending[c.sid] = true; refreshTray(c); var keep = env.root.querySelector('[data-ann-act="clear-cancel"]'); if (keep) keep.focus(); return; }
    if (act === 'clear-cancel') { delete clearPending[c.sid]; refreshTray(c); return; }
    if (act === 'clear-confirm') { if (!clearPending[c.sid]) return; clear(c.sid); }
    else if (act === 'del') remove(c.sid, Number(t.getAttribute('data-ann-i'))); else return; decorate();
  }
  function onClick(ev) {
    if (swallow) { swallow = false; if (typeof ev.stopPropagation === 'function') ev.stopPropagation(); if (typeof ev.preventDefault === 'function') ev.preventDefault(); return; }
    var t = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-ann-act],[data-ann-intent]') : null; if (!t) { pinClick(ev); return; }
    var inPop = !!pop && pop.el.contains(t); if (!inPop && !connected(t)) return;
    if (typeof ev.stopPropagation === 'function') ev.stopPropagation(); if (typeof ev.preventDefault === 'function') ev.preventDefault();
    if (t.hasAttribute('data-ann-intent')) { if (inPop) setIntent(t.getAttribute('data-ann-intent')); return; }
    var act = t.getAttribute('data-ann-act'); if (inPop) { if (act === 'add') addFromPop(); else if (act === 'cancel') cancelPop(); else if (act === 'keep') keepPop(); else if (act === 'discard') closePop(); return; }
    if (act === 'block') openFromButton(t); else trayAction(act, t);
  }
  function pinClick(ev) {
    var t = ev.target, box = t && typeof t.closest === 'function' ? t.closest('.rimg') : null, b = box && connected(box) ? box.closest(BLOCK_SEL) : null;
    var img = b && PIN_BLOCK.test(blockId(b)) ? box.querySelector('img') : null, c = img ? context() : null; if (!c) return;
    var r = img.getBoundingClientRect(), w = num(r.width), h = num(r.height), cx = num(ev.clientX), cy = num(ev.clientY), x = (cx - num(r.left)) / w * 100, y = (cy - num(r.top)) / h * 100;
    if (!(w > 0 && h > 0 && x >= 0 && x <= 100 && y >= 0 && y <= 100)) return; if (draft()) { popError(TXT.draft); return; }
    var spot = { left: cx - PIN_R, right: cx + PIN_R, top: cy - PIN_R, bottom: cy + PIN_R }; openPop(c, [rep(b)], '', { rect: spot, scroll: scrollPos() }, { x: tenth(x), y: tenth(y) });
  }
  function openFromButton(t) { var b = parentEl(t), c = context(); if (!b || !c || !b.matches(BLOCK_SEL)) return; if (draft()) { popError(TXT.draft); return; } openPop(c, [rep(b)], '', {}); }
  function onScrollbar(ev) { var root = env.root; if (ev.target !== root) return false; var r = root.getBoundingClientRect(), cw = num(root.clientWidth), ch = num(root.clientHeight); return (cw > 0 && ev.clientX >= r.left + cw) || (ch > 0 && ev.clientY >= r.top + ch); }
  function onMouseDown(ev) {
    swallow = false; var root = env.root, t = ev.target; if (!root || ev.button !== 0 || !t || typeof t.closest !== 'function' || !root.contains(t)) return;
    if (t.closest(ev.altKey ? NO_ALT_DRAG : NO_DRAG)) return; var b = t.closest(BLOCK_SEL); if (b && root.contains(b) && !ev.altKey) return;
    if (onScrollbar(ev)) return; var c = context(); if (!c) return; if (pop) { if (draft()) { popError(TXT.draft); return; } closePop(); }
    if (typeof ev.preventDefault === 'function') ev.preventDefault(); var a = doc.activeElement; if (a && a !== doc.body && root.contains(a) && typeof a.blur === 'function') a.blur();
    var sel = g.getSelection && g.getSelection(); if (sel && !sel.isCollapsed && typeof sel.removeAllRanges === 'function') sel.removeAllRanges();
    band = { x0: ev.clientX, y0: ev.clientY, el: null, rect: null, picked: [], sid: c.sid }; noteBusy();
  }
  function meets(q, R) { return !!q && q.right - q.left > 0 && q.bottom - q.top > 0 && q.left < R.right && q.right > R.left && q.top < R.bottom && q.bottom > R.top; }
  function pick(R) { var hits = blocksIn(env.root).filter(function (el) { return meets(el.getBoundingClientRect(), R); }); return uniq(outermost(hits).map(rep)); }
  function onMouseMove(ev) {
    if (!band) return; if (!band.el) { if (Math.max(Math.abs(ev.clientX - band.x0), Math.abs(ev.clientY - band.y0)) < DRAG_MIN) return; band.el = doc.createElement('div'); band.el.setAttribute('class', 'band'); doc.body.appendChild(band.el); addClass(env.root, 'ann-banding'); }
    var R = { left: Math.min(band.x0, ev.clientX), top: Math.min(band.y0, ev.clientY), right: Math.max(band.x0, ev.clientX), bottom: Math.max(band.y0, ev.clientY) }; band.rect = R;
    var st = band.el.style; st.left = R.left + 'px'; st.top = R.top + 'px'; st.width = (R.right - R.left) + 'px'; st.height = (R.bottom - R.top) + 'px';
    var picked = pick(R); band.picked.forEach(function (el) { if (picked.indexOf(el) < 0) dropClass(el, 'bsel'); }); picked.forEach(function (el) { addClass(el, 'bsel'); }); band.picked = picked;
  }
  function endBand(open) { var b = band; band = null; if (b.el) { detach(b.el); dropClass(env.root, 'ann-banding'); swallow = true; } b.picked.forEach(function (el) { dropClass(el, 'bsel'); }); var c = open ? context() : null; if (b.el && b.picked.length && c && c.sid === b.sid) openPop(c, b.picked, '', { rect: b.rect, scroll: scrollPos() }); noteBusy(); }
  function textPick(ev) {
    var root = env.root, t = ev && ev.target; if (!root || (t && typeof t.closest === 'function' && t.closest(NO_TEXT))) return;
    var sel = g.getSelection && g.getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return; var text = String(sel).replace(/\r\n?/g, '\n').trim(); if (cps(text).length < 2) return;
    var range = sel.getRangeAt(0), host = elOf(range.commonAncestorContainer); if (!host || !root.contains(host) || host.closest(NO_TEXT)) return; var c = context(); if (!c) return; if (draft()) { popError(TXT.draft); return; }
    var inner = host.closest(BLOCK_SEL), els = inner && root.contains(inner) ? [rep(inner)] : typeof range.intersectsNode === 'function' ? uniq(outermost(blocksIn(root).filter(function (el) { return range.intersectsNode(el); })).map(rep)) : [];
    if (!els.length) return; openPop(c, els, text, { range: typeof range.cloneRange === 'function' ? range.cloneRange() : range });
  }
  function onMouseUp(ev) { if (band) { endBand(true); return; } textPick(ev); }
  function onKey(ev) {
    swallow = false; if (ev.key !== 'Escape') return; if (band) endBand(false); else if (pop) { var conf = pop.el.querySelector('.pconf'); if (conf && !conf.hasAttribute('hidden')) keepPop(); else cancelPop(); }
    else { var c = context(); if (c && clearPending[c.sid]) { delete clearPending[c.sid]; refreshTray(c); } }
  }
  function mount(root, hooks) {
    env.root = root || null; env.hooks = obj(hooks) || {}; if (env.root) addClass(env.root, 'ann-root'); if (env.mounted || !doc) return; env.mounted = true;
    doc.addEventListener('mousedown', guard('mousedown', onMouseDown)); doc.addEventListener('mousemove', guard('mousemove', onMouseMove)); doc.addEventListener('mouseup', guard('mouseup', onMouseUp));
    doc.addEventListener('click', guard('click', onClick), true); doc.addEventListener('keydown', guard('keydown', onKey)); doc.addEventListener('scroll', guard('scroll', position), true);
    if (typeof g.addEventListener === 'function') g.addEventListener('resize', guard('resize', position));
  }
  g.BriefAnnotate = { mount: mount, decorate: decorate, trayBar: trayBar, tray: tray, toMarkdown: toMarkdown, compose: compose, place: place, busy: busy, list: list, add: add, remove: remove, clear: clear, status: status, sending: sending, text: TXT, limits: { notes: MAX_NOTES, text: TEXT_MAX, comment: COMMENT_MAX } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
