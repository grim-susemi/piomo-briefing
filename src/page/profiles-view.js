/* omo-briefing profiles view: 프로필·에이전트 (board rail view).
 * Classic script (file:// safe, no modules). g.BriefProfiles.render(view, edit) -> html for #main,
 * g.BriefProfiles.side(view, edit) -> html for the sidebar, g.BriefProfiles.createController({fetch, token})
 * -> the preview/apply controller, g.BriefProfiles.bind(root, hooks) -> delegated listeners.
 *
 * The view model is GET /profiles/state (src/profiles/store.mjs state()). Every string is escaped, attributes
 * included; no markup, style or event handler from the model ever reaches the page. Edits are gathered as the
 * store's change objects and only leave the page through POST /profiles; 미리보기 is a non-writing preview and
 * 적용 is the only write. A 409 keeps the pending edits and shows the reload hand-off. The view is read-only
 * without the board write token (ui.live), while the file page or an inventory-stale state says so and offers
 * no controls. No timer or polling loop lives here: state is read when the view opens and after each apply. */
(function (g) {
  'use strict';

  var STALE_BANNER = '인벤토리 갱신 필요';
  var CONFLICT_TEXT = '다른 곳에서 바뀌었어요 — 새로고침 후 다시 적용';
  var REAPPLY_LABEL = '다시 적용';
  var READONLY_LIVE = '실시간 상황판에서만 바꿀 수 있어요';
  var READONLY_FILE = '이 페이지는 보기 전용입니다 - 실시간 상황판에서 열어 주세요';
  var AGENTS = [
    ['sisyphus', 'Sisyphus'],
    ['hephaestus', 'Hephaestus'],
    ['prometheus', 'Prometheus'],
    ['atlas', 'Atlas']
  ];
  var LANES = ['daily-normal', 'daily-heavy', 'geeky-normal', 'geeky-heavy'];
  var THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  var SECTIONS = [
    ['agents', '메인 에이전트', '에이전트별 레인·핀·기억'],
    ['profiles', '프로필', '6개 프로필과 현재 선택'],
    ['routing', '역할 배치', '에이전트·카테고리별 서비스/모델/추론'],
    ['main', '메인 모델', '세션을 여는 기본 모델'],
    ['lanes', '모델 레인', 'model_profile 선택'],
    ['summarizer', '요약 모델', '압축 요약 모델과 경고'],
    ['memory', '메모리 행', 'Kibitzer·Reflection 공통 행'],
    ['guide', '권장 가이드', '경로와 sha256']
  ];
  // Identity marks are shapes as well as colours, so the fixed roster palette is never the only cue.
  var SHAPES = { sisyphus: 'circle', hephaestus: 'square', prometheus: 'triangle', atlas: 'diamond' };
  var SHAPE_KO = { circle: '원형', square: '사각형', triangle: '삼각형', diamond: '마름모' };
  var STATUS_LABEL = {
    recommended: '권장', fallback: '차선', 'variant-different': '변형 다름', different: '다름',
    unresolved: '미해결', unassigned: '미지정', untracked: '추적 안 됨', unknown: '미확인', unset: '미설정'
  };
  var CHANGE_LABEL = {
    selectProfile: '프로필', setRoute: '역할', setMain: '메인 모델', setModelProfile: '모델 레인',
    setSummarizer: '요약 모델', setMemoryRow: '메모리 행', setAgentLane: '에이전트 레인',
    setAgentPin: '에이전트 핀', resetAgentMemory: '기억 초기화', migrateReviewerKeys: '리뷰어 키'
  };

  // ---- small helpers (each string ends in esc() before it reaches markup) -------------------------------------------
  function str(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }
  function esc(v) {
    return str(v).replace(/[&<>"'`]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c];
    });
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function has(o, k) { return o != null && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); }
  function map() { return Object.create(null); }
  function copyMap(m) {
    var out = map();
    for (var k in m) if (has(m, k)) out[k] = m[k];
    return out;
  }
  function ic(name, cls) { return g.BriefIcons ? g.BriefIcons.icon(name, cls) : ''; }
  function cut(v, n) {
    var cps = Array.from(str(v));
    return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('');
  }
  function jsonText(v) {
    try { return cut(JSON.stringify(v), 240); } catch (e) { return str(v); }
  }
  function attr(name, value) { return ' ' + name + '="' + esc(value) + '"'; }
  function boolAttr(name, on) { return on ? ' ' + name : ''; }
  function chip(cls, label, title) {
    return '<span class="pf-chip ' + cls + '"' + (title ? attr('title', title) : '') + '>' + esc(label) + '</span>';
  }
  function tag(label, title) {
    return '<span class="pf-tag"' + (title ? attr('title', title) : '') + '>[' + esc(label) + ']</span>';
  }
  function iconText(name, text, cls) { return ic(name, cls) + ' ' + esc(text); }
  function idOf(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i][0] === id) return list[i][1];
    return id;
  }
  function knownAgent(id) {
    for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i][0] === id) return AGENTS[i][0];
    return '';
  }
  function knownStatus(status) {
    return has(STATUS_LABEL, status) ? status : 'unknown';
  }
  function laneOptions(selected, extra) {
    var out = '';
    var list = LANES.slice();
    arr(extra).forEach(function (lane) { if (typeof lane === 'string' && lane && list.indexOf(lane) < 0) list.push(lane); });
    list.forEach(function (lane) {
      out += '<option value="' + esc(lane) + '"' + (lane === selected ? ' selected' : '') + '>' + esc(lane) + '</option>';
    });
    return out;
  }
  function thinkingOptions(selected, allowEmpty) {
    var out = allowEmpty ? '<option value=""' + (selected ? '' : ' selected') + '>(없음)</option>' : '';
    THINKING.forEach(function (level) {
      out += '<option value="' + esc(level) + '"' + (level === selected ? ' selected' : '') + '>' + esc(level) + '</option>';
    });
    return out;
  }
  function unesc(v) {
    return str(v).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&#96;/g, '`').replace(/&amp;/g, '&');
  }
  function selectedLabel(options) {
    var m = /<option\b[^>]*\bselected[^>]*>([\s\S]*?)<\/option>/.exec(options);
    if (!m) m = /<option\b[^>]*>([\s\S]*?)<\/option>/.exec(options);
    return m ? unesc(m[1]) : '';
  }
  function select(name, attrs, options, disabled, title) {
    var t = typeof title === 'string' ? title : selectedLabel(options);
    return '<select' + attr('data-pf', name) + (attrs || '') + (t ? attr('title', t) : '') +
      boolAttr('disabled', disabled) + '>' + options + '</select>';
  }
  function slug(v) { return str(v).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x'; }
  function withId(id, attrs) { return attr('id', id) + (attrs || ''); }
  function labelled(text, id, control, cls) {
    return '<label class="pf-sel' + (cls ? ' ' + cls : '') + '"' + attr('for', id) + '>' +
      '<span class="pf-sel-t">' + esc(text) + '</span>' + control + '</label>';
  }
  // A field hint lives inside the pin control's own label, after that select and before the
  // thinking control that follows it, so a stacked 1024/390 pair cannot attach it to 추론.
  function labelledHint(text, hint, id, control, cls) {
    return '<label class="pf-sel' + (cls ? ' ' + cls : '') + '"' + attr('for', id) + '>' +
      '<span class="pf-sel-t">' + esc(text) + '</span>' + control +
      (hint ? ' <span class="pf-hint">' + esc(hint) + '</span>' : '') + '</label>';
  }
  function textInput(name, attrs, value, disabled, placeholder) {
    return '<input type="text"' + attr('data-pf', name) + (attrs || '') + attr('value', value) +
      (placeholder ? attr('placeholder', placeholder) : '') + boolAttr('disabled', disabled) + '>';
  }
  function button(name, attrs, text, disabled, cls) {
    return '<button type="button" class="' + (cls || 'pf-btn') + '"' + attr('data-pf', name) + (attrs || '') +
      boolAttr('disabled', disabled) + '>' + text + '</button>';
  }
  function valueOrDash(v) { return str(v) ? esc(v) : '<span class="pf-dash" aria-label="없음">—</span>'; }
  // The model copy is data, not markup: escape it first, then wrap the phrases that must not split across
  // lines. One combined pass keeps product names, interpunct compounds and modifier + noun phrases together;
  // the surrounding text stays selectable and no rendered word is changed.
  var KEEP_PHRASES = /\(max 추론\)|진짜 max 추론|max 추론|(?:GLM|GPT|Kimi|DeepSeek|Flash|딥시크)\s+\d+(?:\.\d+)?(?:\s+(?:Flash|Pro|Max))?(?:\(max 추론\))?|(?:깊은|개인용|빠른|단순|고강도)\s+[가-힣A-Za-z0-9]+(?:·[가-힣A-Za-z0-9]+)*|[가-힣A-Za-z0-9]+(?:·[가-힣A-Za-z0-9]+)+\s*[가-힣A-Za-z0-9]*/g;
  function summaryText(v) {
    return esc(v).replace(KEEP_PHRASES, function (m) { return '<span class="pf-keep">' + m + '</span>'; });
  }
  function currentChip() {
    return '<span class="pf-chip pf-c-green pf-current">' + ic('check', 'ic-sm') + ' ' + esc('현재') + '</span>';
  }

  // ---- model helpers -----------------------------------------------------------------------------------------------
  function catalogEntries(view) {
    var cat = obj(view && view.catalog) || {}, out = [];
    Object.keys(cat).forEach(function (alias) {
      var entry = obj(cat[alias]);
      if (!entry) return;
      out.push({ alias: alias, model: str(entry.model), variant: str(entry.variant) || str(entry.reasoning) });
    });
    // The ChatGPT-subscription picker is completed from the live host registry.
    // Registry-only models are appended; the catalog stays the source of truth for
    // every other provider, and a missing registry degrades to the catalog alone.
    arr(view && view.registryModels).forEach(function (item) {
      var model = str(item && (item.model || item.id));
      if (!model) return;
      if (model.indexOf('/') < 0 && item && str(item.provider)) model = str(item.provider) + '/' + model;
      if (!providerOf(model)) return;
      for (var i = 0; i < out.length; i++) if (out[i].model === model) return;
      out.push({ alias: str(item && item.alias) || bareModel(model), model: model, variant: str(item && item.variant) });
    });
    return out;
  }
  function providerOf(model) {
    var at = str(model).indexOf('/');
    return at > 0 ? str(model).slice(0, at) : '';
  }
  function bareModel(model) {
    var at = str(model).indexOf('/');
    return at > 0 ? str(model).slice(at + 1) : str(model);
  }
  function entryOf(entries, alias, model) {
    for (var i = 0; i < entries.length; i++) {
      if (alias && entries[i].alias === alias) return entries[i];
      if (model && entries[i].model === model) return entries[i];
    }
    return null;
  }
  function providersOf(entries, current) {
    var out = [];
    entries.forEach(function (e) {
      var p = providerOf(e.model);
      if (p && out.indexOf(p) < 0) out.push(p);
    });
    if (current && out.indexOf(current) < 0) out.push(current);
    return out.sort();
  }
  function providerSelect(name, attrs, providers, current, disabled) {
    var opts = providers.map(function (p) {
      return '<option value="' + esc(p) + '"' + (p === current ? ' selected' : '') + '>' + esc(p) + '</option>';
    }).join('');
    if (!opts) opts = '<option value="" selected>(서비스 없음)</option>';
    return select(name, attrs, opts, disabled);
  }
  function modelSelect(name, attrs, entries, provider, fullId, disabled) {
    var opts = '', found = false, seen = map();
    entries.forEach(function (e) {
      if (provider && providerOf(e.model) !== provider) return;
      if (e.model === fullId) found = true;
      if (has(seen, e.model)) return;
      seen[e.model] = true;
      opts += '<option value="' + esc(e.model) + '"' + attr('data-provider', providerOf(e.model)) + (e.model === fullId ? ' selected' : '') + '>' +
        esc(e.alias + ' · ' + e.model) + '</option>';
    });
    if (fullId && !found) opts += '<option value="' + esc(fullId) + '"' + attr('data-provider', providerOf(fullId)) + ' selected>' + esc(fullId) + '</option>';
    if (!opts) opts = '<option value="" selected>(모델 없음)</option>';
    return select(name, attrs, opts, disabled);
  }
  function mainModelSelect(name, attrs, entries, provider, bare, disabled) {
    var opts = '', found = false, seen = map();
    entries.forEach(function (e) {
      if (provider && providerOf(e.model) !== provider) return;
      var id = bareModel(e.model);
      if (id === bare) found = true;
      if (has(seen, id)) return;
      seen[id] = true;
      opts += '<option value="' + esc(id) + '"' + attr('data-provider', providerOf(e.model)) + (id === bare ? ' selected' : '') + '>' +
        esc(e.alias + ' · ' + id) + '</option>';
    });
    if (bare && !found) opts += '<option value="' + esc(bare) + '" selected>' + esc(bare) + '</option>';
    if (!opts) opts = '<option value="" selected>(모델 없음)</option>';
    return select(name, attrs, opts, disabled);
  }
  function summarizerOptions(entries, current) {
    var opts = '<option value=""' + (current ? '' : ' selected') + '>(설정 안 함)</option>', found = false, seen = map();
    entries.forEach(function (e) {
      if (e.model === current) found = true;
      if (has(seen, e.model)) return;
      seen[e.model] = true;
      opts += '<option value="' + esc(e.model) + '"' + (e.model === current ? ' selected' : '') + '>' +
        esc(e.alias + ' · ' + e.model) + '</option>';
    });
    if (current && !found) opts += '<option value="' + esc(current) + '" selected>' + esc(current) + '</option>';
    return opts;
  }
  function recommendationOf(row) {
    var rec = obj(row && row.recommendation) || obj(row && row.recommend) || null;
    var status = str(rec && (rec.Status || rec.status)) || str(row && row.recommendationStatus) || '';
    if (!status) status = str(row && row.model) ? 'unknown' : 'unset';
    return {
      status: knownStatus(status),
      official: str(rec && (rec.Official || rec.official)),
      label: STATUS_LABEL[knownStatus(status)]
    };
  }
  function summarizerWarnings(modelId) {
    var out = [];
    if (modelId && modelId.indexOf('muse-spark') >= 0) out.push({ level: 'warning', text: 'Muse Spark는 요약 품질이 낮습니다. GPT 계열 요약 모델을 권장합니다.' });
    if (providerOf(modelId) === 'commandcode') out.push({ level: 'info', text: '커맨드코드 요약 모델은 유료 구독 할당량을 사용합니다.' });
    return out;
  }

  // ---- pending helpers ---------------------------------------------------------------------------------------------
  function pendingOf(edit) { return arr(edit && edit.pending); }
  function findChange(pending, match) {
    for (var i = 0; i < pending.length; i++) if (match(pending[i], i)) return pending[i];
    return null;
  }
  function draftOf(edit, key) {
    var d = obj(edit && edit.draft);
    return d && has(d, key) && obj(d[key]) ? d[key] : null;
  }
  function agentChange(pending, id, kind) {
    return findChange(pending, function (c) { return c && c.kind === kind && c.agentId === id; });
  }
  function routeChangeOf(pending, section, role) {
    return findChange(pending, function (c) { return c && c.kind === 'setRoute' && c.section === section && c.role === role; });
  }
  function mainChangeOf(pending) {
    return findChange(pending, function (c) { return c && c.kind === 'setMain'; });
  }
  function firstOf(pending, kind) {
    return findChange(pending, function (c) { return c && c.kind === kind; });
  }
  function changeLabel(c) {
    var kind = str(c && c.kind);
    var head = CHANGE_LABEL[kind] || kind || '변경';
    if (kind === 'selectProfile') return head + ' → ' + str(c.profileKey);
    if (kind === 'setRoute') return head + ' ' + str(c.section) + '/' + str(c.role) + ' → ' + str(c.provider) + ' · ' + str(c.model) + ' / ' + str(c.thinking);
    if (kind === 'setMain') return head + ' → ' + str(c.provider) + ' · ' + str(c.model) + ' / ' + str(c.thinking);
    if (kind === 'setModelProfile') return head + ' → ' + (str(c.selection) === 'custom-literal' ? '직접 입력 ' + str(c.literal) : str(c.selection) === 'off' ? '끔' : str(c.selection) || '프로필 기본');
    if (kind === 'setSummarizer') return head + ' → ' + (str(c.modelId) || '설정 안 함');
    if (kind === 'setMemoryRow') return (str(c.row) === 'reflection' ? 'Reflection' : 'Kibitzer') + ' ' + head + ' → ' + str(c.mode) + (str(c.model) ? ' · ' + str(c.model) : '') + (str(c.reasoning) ? ' / ' + str(c.reasoning) : '');
    if (kind === 'setAgentLane') return str(c.agentId) + ' 레인 → ' + str(c.lane);
    if (kind === 'setAgentPin') return str(c.agentId) + ' 핀 → ' + (obj(c.pin) ? str(c.pin.provider) + ' · ' + str(c.pin.modelId) + ' / ' + str(c.pin.thinking) : '없음');
    if (kind === 'resetAgentMemory') return str(c.agentId) + ' 기억 초기화';
    return head;
  }

  // ---- shared fragments --------------------------------------------------------------------------------------------
  function emptyNote(text, cls) { return '<p class="pf-empty ' + (cls || '') + '">' + ic('info', 'ic-sm') + ' ' + esc(text) + '</p>'; }
  function readOnlyNote(edit, view) {
    if (edit && edit.live !== true) return emptyNote(READONLY_FILE, 'pf-ro-note');
    if (view && view.banner === STALE_BANNER) return emptyNote('인벤토리를 갱신할 때까지 수정할 수 없어요', 'pf-ro-note');
    return emptyNote(READONLY_LIVE, 'pf-ro-note');
  }
  function banner(text, cls, role) {
    return '<div class="pf-banner ' + (cls || '') + '"' + (role ? attr('role', role) : '') + '>' + ic('info', 'ic-sm') + ' <b>' + esc(text) + '</b></div>';
  }
  // An interrupted apply is a real state, not a sentence: the owner must be able to trigger
  // the explicit replay. The payload is the journal's recorded changes (never the pending
  // tray), and the click posts them once through the same guarded apply route.
  function journalBanner(view, ro) {
    var journal = obj(view && view.applyJournal);
    if (!journal || journal.status !== 'interrupted') return '';
    var payload = obj(journal.reapply);
    var changes = arr(payload && payload.changes);
    var head = '<div class="pf-banner pf-banner-warn" data-pf-journal="interrupted" role="status">' +
      ic('info', 'ic-sm') + ' <b>' + esc('중단된 적용') + '</b>';
    if (ro) return head + ' <span class="pf-muted">' + esc('읽기 전용') + '</span></div>';
    if (!changes.length) return head + ' <span class="pf-muted">' + esc('다시 적용할 변경 기록이 없어요') + '</span></div>';
    return head + ' ' + button('reapply', ' aria-label="' + esc(REAPPLY_LABEL) + '"',
      ic('refresh-cw', 'ic-sm') + ' ' + esc(REAPPLY_LABEL), false, 'pf-btn') + '</div>';
  }
  // Loading, error and a loaded view are three states. A missing view is never a read-only view: the
  // read-only badge and note may only appear once a state exists and says writes are refused.
  function viewState(view, edit) {
    if (obj(view)) return 'view';
    return edit && str(edit.error) ? 'error' : 'loading';
  }
  // The loading frame uses the loaded view's own row primitives: a homes strip, the compact tray,
  // four full-width agent rows with the same responsive field grid, six profile cards and the routing
  // rows. It is not a separate 4/2/1-column matrix, so the loaded view lands where the skeleton was.
  function loadingBlock() {
    var agents = '';
    for (var i = 0; i < 4; i++) {
      agents += '<div class="pf-skel pf-skel-agent" data-pf-skel="agent">' +
        '<span class="pf-skel-field pf-skel-id"><span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-c"></span></span>' +
        '<span class="pf-skel-field"><span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-c"></span></span>' +
        '<span class="pf-skel-field"><span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-pin"><span class="pf-skel-line pf-skel-line-c"></span><span class="pf-skel-line pf-skel-line-c"></span></span></span>' +
        '<span class="pf-skel-field pf-skel-mem"><span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-c"></span></span>' +
        '</div>';
    }
    var cards = '';
    for (var j = 0; j < 6; j++) {
      cards += '<div class="pf-skel pf-skel-card" data-pf-skel="card">' +
        '<span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-s"></span>' +
        '<span class="pf-skel-line pf-skel-line-s"></span><span class="pf-skel-line pf-skel-line-s"></span>' +
        '<span class="pf-skel-line pf-skel-line-c"></span></div>';
    }
    var routes = '';
    for (var k = 0; k < 20; k++) {
      routes += '<div class="pf-skel pf-skel-route" data-pf-skel="route">' +
        '<span class="pf-skel-field pf-skel-id"><span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-s"></span></span>' +
        '<span class="pf-skel-field pf-skel-route-sels"><span class="pf-skel-line pf-skel-line-c"></span><span class="pf-skel-line pf-skel-line-c"></span><span class="pf-skel-line pf-skel-line-c"></span></span>' +
        '<span class="pf-skel-field pf-skel-rec"><span class="pf-skel-line pf-skel-line-s"></span></span></div>';
    }
    var sec = function (key, body) {
      return '<div class="pf-skel-sec" data-pf-skel="' + key + '" aria-hidden="true"><div class="pf-skel-sec-h">' +
        '<span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-s"></span></div>' +
        '<div class="pf-skel-sec-b">' + body + '</div></div>';
    };
    return '<div class="pf-loading" data-pf-loading role="status">' +
      '<div class="pf-skeleton">' +
      '<div class="pf-skel pf-skel-homes" data-pf-skel="homes" aria-hidden="true"></div>' +
      '<div class="pf-skel pf-skel-tray pf-tray-compact" data-pf-skel="tray"><p class="pf-loading-h"><span class="pf-pulse" aria-hidden="true">' +
      ic('refresh-cw', 'ic-sm') + '</span> 프로필 상태를 불러오는 중…</p></div>' +
      sec('agents', '<div class="pf-skel-agents">' + agents + '</div>') +
      sec('profiles', '<div class="pf-skel-cards">' + cards + '</div>') +
      sec('routing', '<div class="pf-skel-routes">' + routes + '</div>') +
      '</div></div>';
  }
  function errorBlock(edit) {
    return '<div class="pf-error" role="alert"><p class="pf-err">' + esc(edit && edit.error) + '</p>' +
      button('reload', ' aria-label="다시 시도"', ic('refresh-cw', 'ic-sm') + ' 다시 시도', false, 'pf-btn') + '</div>';
  }

  function header(view, edit) {
    var live = edit && edit.live === true;
    var state = viewState(view, edit);
    var ro = state === 'view' && readonly(view, edit);
    var badge = state === 'loading' ? chip('pf-c-gray', '불러오는 중')
      : state === 'error' ? chip('pf-c-red', '불러오지 못함')
      : !live ? chip('pf-c-gray', '파일 보기') : ro ? chip('pf-c-amber', '읽기 전용') : chip('pf-c-green', '편집 가능');
    var active = obj(view && view.activeProfile);
    var activeCard = null;
    if (active) {
      arr(view.profiles).forEach(function (p) { if (obj(p) && p.key === active.key) activeCard = p; });
    }
    return '<header class="pf-head">' +
      '<div class="pf-head-l"><p class="pf-kicker">[프로필·에이전트]</p><h1 class="pf-title">프로필·에이전트</h1>' +
      '<p class="pf-sub">WinForms 스위처의 역할 배치와 모델 레인, <span class="pf-keep">메모리 행을 상황판에서 확인하고</span>, <span class="pf-keep">실시간 상황판</span>에서 미리보기 후 적용합니다.</p></div>' +
      '<div class="pf-head-r">' + badge +
      (activeCard ? '<span class="pf-active">현재 ' + esc(activeCard.nameKr || activeCard.name || active.key) + '</span>' : '') +
      '</div></header>';
  }

  function homes(view) {
    var h = obj(view && view.homes) || {};
    var line = function (tagName, value, cls) {
      return '<span class="pf-home ' + (cls || '') + '">' + tag(tagName) + ' <code title="' + esc(value || '(없음)') + '">' + esc(value || '(없음)') + '</code></span>';
    };
    var mirrors = arr(h.mirrors).map(function (m, i) {
      var label = 'mirror ' + (i + 1);
      return '<span class="pf-home' + (m && m.exists === false ? ' pf-home-off' : '') + '">' + tag(label, m && m.exists === false ? '이 미러의 omo.jsonc가 없음' : str(m && m.label)) +
        ' <code title="' + esc(m && m.root) + '">' + esc(m && m.root) + '</code>' + (m && m.exists === false ? ' <span class="pf-off">[없음]</span>' : '') + '</span>';
    }).join('');
    return '<div class="pf-homes" aria-label="대상 홈">' +
      line('primary', h.primary) + (mirrors || line('mirror', '(설정 없음)')) + line('stable-500', h.stable) + '</div>';
  }

  function readonly(view, edit) {
    if (!obj(view)) return true;
    if (!edit || edit.live !== true) return true;
    if (view.readOnly === true) return true;
    if (view.banner === STALE_BANNER) return true;
    if (obj(view.inventory) && view.inventory.stale === true) return true;
    return false;
  }

  // ---- sections ----------------------------------------------------------------------------------------------------
  function section(key, body, count, extra, subOverride) {
    var meta = null;
    SECTIONS.forEach(function (s) { if (s[0] === key) meta = s; });
    var title = meta ? meta[1] : key, sub = typeof subOverride === 'string' ? subOverride : meta ? meta[2] : '';
    return '<section class="pf-sec" id="pf-sec-' + esc(key) + '"' + attr('data-pf-sec', key) + '>' +
      '<header class="pf-sec-h"><div class="pf-sec-t">' + tag(title) + '<h2>' + esc(title) + '</h2>' +
      (sub ? '<p class="pf-sec-s">' + esc(sub) + '</p>' : '') + '</div>' +
      '<div class="pf-sec-r">' + (count === null ? '' : '<span class="pf-count">' + count + '</span>') + (extra || '') + '</div></header>' +
      '<div class="pf-sec-b">' + body + '</div></section>';
  }

  function memoryChangeOf(pending, row) {
    return findChange(pending, function (c) {
      return c && c.kind === 'setMemoryRow' && (str(c.row) || 'kibitzer') === row;
    });
  }
  function agentRows(view, edit, ro) {
    var roster = obj(view && view.roster) || {};
    var agents = obj(roster.agents) || {};
    var entries = catalogEntries(view);
    var pending = pendingOf(edit);
    var rows = AGENTS.map(function (pair) {
      var id = pair[0], name = idOf(AGENTS, id);
      var agent = obj(agents[id]) || {};
      var laneChange = agentChange(pending, id, 'setAgentLane');
      var pinChange = agentChange(pending, id, 'setAgentPin');
      var reset = agentChange(pending, id, 'resetAgentMemory');
      var lane = laneChange ? str(laneChange.lane) : str(agent.lane) || (id === 'hephaestus' ? 'geeky-normal' : id === 'prometheus' ? 'daily-heavy' : 'daily-normal');
      var pin = pinChange ? pinChange.pin : agent.pin;
      pin = obj(pin) ? pin : null;
      var remembered = obj(agent.remembered) || obj(agent.memory) || null;
      var pinEntry = pin ? entryOf(entries, '', str(pin.modelId)) : null;
      if (pin && !pinEntry) pinEntry = entries.filter(function (e) { return bareModel(e.model) === bareModel(pin.modelId); })[0] || null;
      var pinProvider = pin ? pinEntry ? providerOf(pinEntry.model) : str(pin.provider) : '';
      var pinModel = pin ? pinEntry ? bareModel(pinEntry.model) : bareModel(pin.modelId) : '';
      var pinValue = pin ? pinProvider + '|' + pinModel : '';
      var pinThinking = pin ? str(pin.thinking) : 'medium';
      var pinEntries = id === 'hephaestus' ? entries.filter(function (e) { return bareModel(e.model).indexOf('gpt-') === 0; }) : entries;
      var pinOpts = '<option value=""' + (pin ? '' : ' selected') + '>핀 없음 (레인 사용)</option>';
      var pinSeen = map();
      pinEntries.forEach(function (e) {
        var value = providerOf(e.model) + '|' + bareModel(e.model);
        if (has(pinSeen, value)) return;
        pinSeen[value] = true;
        pinOpts += '<option value="' + esc(value) + '"' + (value === pinValue ? ' selected' : '') + '>' +
          esc(e.alias + ' · ' + e.model) + '</option>';
      });
      if (pinValue && !has(pinSeen, pinValue)) {
        pinOpts += '<option value="' + esc(pinValue) + '" selected>' + esc(pinValue) + '</option>';
      }
      var mem = remembered ? str(remembered.provider) + ' · ' + str(remembered.modelId) + (str(remembered.thinking) ? ' / ' + str(remembered.thinking) : '') : '';
      var laneId = 'pf-agent-lane-' + id;
      var controls = ro
        ? '<span class="pf-lbl">레인</span><span class="pf-ro-val">' + esc(lane) + '</span>'
        : labelled('레인', laneId, select('agent-lane', withId(laneId, ' data-agent="' + esc(id) + '"'), laneOptions(lane)));
      var pinId = 'pf-agent-pin-' + id, pinThinkId = 'pf-agent-pin-thinking-' + id;
      var pinHint = id === 'hephaestus' ? 'GPT 계열만' : '';
      var pinControls = ro
        ? '<span class="pf-lbl">핀</span><span class="pf-ro-val">' + (pin ? esc(pinProvider + ' · ' + pinModel + ' / ' + pinThinking) : '없음') + '</span>'
        : '<div class="pf-pin-sels">' +
          labelledHint('핀', pinHint, pinId, select('agent-pin', withId(pinId, ' data-agent="' + esc(id) + '"'), pinOpts)) +
          labelled('추론', pinThinkId, select('agent-pin-thinking', withId(pinThinkId, ' data-agent="' + esc(id) + '"'), thinkingOptions(pinThinking, false), !pin)) +
          '</div>';
      var resetBtn = ro ? '<span class="pf-muted">기억은 확장이 관리</span>' : button('reset-memory', ' data-agent="' + esc(id) + '"', '기억 초기화', false, 'pf-btn pf-btn-ghost');
      if (reset && !ro) resetBtn = button('reset-memory', ' data-agent="' + esc(id) + '"', '초기화 대기', false, 'pf-btn pf-btn-ghost on');
      return '<article class="pf-agent" data-pf-agent="' + esc(id) + '">' +
        '<div class="pf-agent-id"><span class="pf-dot pf-dot-' + esc(id) + ' pf-shape-' + esc(SHAPES[id]) + '" role="img" aria-label="' +
        esc(name + ' · ' + SHAPE_KO[SHAPES[id]] + ' 표식') + '"></span>' +
        '<span class="pf-agent-n">' + esc(name) + '</span><span class="pf-agent-k">[rev ' + esc(num(agent.rev) === null ? 0 : agent.rev) + ']</span></div>' +
        '<div class="pf-field">' + controls + '</div>' +
        '<div class="pf-field">' + pinControls + '</div>' +
        '<div class="pf-field pf-mem-field"><span class="pf-lbl">기억</span><div class="pf-mem-line">' +
        '<span class="pf-ro-val pf-mem">' + (mem ? esc(mem) : '<span class="pf-dash">—</span>') + '</span>' + resetBtn + '</div></div></article>';
    }).join('');
    return section('agents', '<div class="pf-agents">' + rows + '</div>', AGENTS.length,
      roster.warning ? chip('pf-c-amber', 'roster 경고', str(roster.warning)) : '');
  }

  function profileCards(view, edit, ro) {
    var pending = pendingOf(edit);
    var selected = firstOf(pending, 'selectProfile');
    var current = selected ? str(selected.profileKey) : str(obj(view && view.activeProfile) && view.activeProfile.key);
    var cards = arr(view && view.profiles).map(function (p) {
      if (!obj(p)) return '';
      var on = p.key === current || p.current === true;
      var body = '<span class="pf-card-top"><span class="pf-card-num">' + esc(num(p.num) === null ? '' : p.num) + '</span>' +
        '<span class="pf-card-name">' + esc(p.nameKr || p.name || p.key) + '</span>' + (on ? currentChip() : '') + '</span>' +
        '<span class="pf-card-en">' + esc(p.name || '') + '</span>' +
        '<span class="pf-card-tag">' + tag(p.tag || 'profile') + '</span>' +
        '<span class="pf-card-sum">' + summaryText(p.summary || '') + '</span>' +
        '<span class="pf-card-main">' + esc(str(p.mainProvider) + ' · ' + str(p.mainModel) + ' / ' + str(p.mainThinking)) + '</span>';
      if (ro) return '<article class="pf-card' + (on ? ' on' : '') + '">' + body + '</article>';
      return '<button type="button" class="pf-card' + (on ? ' on' : '') + '"' + attr('data-pf', 'select-profile') +
        attr('data-profile', p.key) + ' aria-pressed="' + on + '">' + body + '</button>';
    }).join('');
    return section('profiles', '<div class="pf-cards">' + cards + '</div>', arr(view && view.profiles).length);
  }

  function routingRows(view, edit, ro) {
    var rows = arr(obj(view && view.routing) && view.routing.rows);
    var entries = catalogEntries(view);
    var groups = [], index = map();
    rows.forEach(function (r) {
      if (!obj(r)) return;
      var key = str(r.section) + '/' + str(r.group);
      if (!has(index, key)) {
        index[key] = { key: key, section: str(r.section), group: str(r.group), label: str(r.groupLabel) || str(r.group), rows: [] };
        groups.push(index[key]);
      }
      index[key].rows.push(r);
    });
    var html = groups.map(function (group) {
      var body = group.rows.map(function (r) {
        var change = routeChangeOf(pendingOf(edit), r.section, r.role);
        var draft = draftOf(edit, 'route:' + str(r.section) + '/' + str(r.role));
        var alias = str(r.model);
        var entry = entryOf(entries, alias);
        var full = change ? str(change.model) : draft && str(draft.model) ? str(draft.model) : entry ? entry.model : alias;
        var provider = change ? str(change.provider) : draft && str(draft.provider) ? str(draft.provider) : entry ? providerOf(entry.model) : providerOf(alias);
        var thinking = change ? str(change.thinking) : draft && str(draft.thinking) ? str(draft.thinking) : str(r.reasoning) || entry && entry.variant || '';
        var providers = providersOf(entries, provider);
        var rec = recommendationOf(r);
        var readonlyRow = ro || r.readOnly === true || !!r.absentIn;
        var rid = 'pf-route-' + slug(r.section + '-' + r.role);
        var fields = readonlyRow
          ? '<span class="pf-ro-val">' + valueOrDash(provider) + ' · ' + valueOrDash(bareModel(full)) + ' / ' + valueOrDash(thinking) + '</span>'
          : '<div class="pf-route-sels">' +
            labelled('서비스', rid + '-provider', providerSelect('route-provider',
              withId(rid + '-provider', ' data-route="' + esc(r.section + '/' + r.role) + '"'), providers, provider, false)) +
            labelled('모델', rid + '-model', modelSelect('route-model',
              withId(rid + '-model', ' data-route="' + esc(r.section + '/' + r.role) + '"'), entries, provider, full, false)) +
            labelled('추론', rid + '-thinking', select('route-thinking',
              withId(rid + '-thinking', ' data-route="' + esc(r.section + '/' + r.role) + '"'), thinkingOptions(thinking, true), false)) +
            '</div>';
        return '<div class="pf-route" data-pf-route="' + esc(r.section + '/' + r.role) + '">' +
          '<div class="pf-route-id">' + tag(r.section === 'agents' ? 'agent' : 'category') +
          '<span class="pf-route-ko">' + esc(r.labelKo || r.role) + '</span>' +
          '<span class="pf-route-en">' + esc(r.labelEn || r.role) + '</span>' +
          (r.stateLabel ? chip('pf-c-amber', r.stateLabel) : '') + '</div>' +
          '<div class="pf-route-val">' + fields + '</div>' +
          '<div class="pf-route-rec">' + chip('pf-st-' + rec.status, rec.label, rec.official) +
          (rec.official ? '<span class="pf-rec-off">' + esc(rec.official) + '</span>' : '') + '</div></div>';
      }).join('');
      return '<div class="pf-group"><h3 class="pf-group-h">' + tag(group.section === 'agents' ? 'agents' : 'categories') +
        esc(group.label) + ' <span class="pf-count">' + group.rows.length + '</span></h3><div class="pf-routes">' + body + '</div></div>';
    }).join('');
    return section('routing', html || emptyNote('배치할 역할이 없어요'), rows.length);
  }

  function mainModel(view, edit, ro) {
    var pending = mainChangeOf(pendingOf(edit));
    var draft = draftOf(edit, 'main');
    var current = obj(view && view.main) || {};
    var effective = obj(current.effective) || {};
    var override = obj(current.override) || null;
    var provider = pending ? str(pending.provider) : draft && str(draft.provider) ? str(draft.provider) : str(override && override.provider) || str(effective.provider);
    var model = pending ? str(pending.model) : draft && str(draft.model) ? str(draft.model) : str(override && override.model) || str(effective.model);
    var thinking = pending ? str(pending.thinking) : draft && str(draft.thinking) ? str(draft.thinking) : str(override && override.thinking) || str(effective.thinking);
    var entries = catalogEntries(view);
    var providers = providersOf(entries, provider);
    var body;
    if (!effective.provider && !override && !pending) {
      body = emptyNote('현재 프로필의 메인 모델 정보가 없어요');
    } else if (ro) {
      body = '<div class="pf-main-ro"><span class="pf-main-v">' + valueOrDash(provider) + ' · ' + valueOrDash(model) + ' / ' + valueOrDash(thinking) + '</span>' +
        (override ? chip('pf-c-green', '직접 지정') : chip('pf-c-gray', '프로필 기본')) + '</div>';
    } else {
      body = '<div class="pf-main" data-pf-main>' +
        '<div class="pf-field">' + labelled('서비스', 'pf-main-provider', providerSelect('main-provider', withId('pf-main-provider', ' data-main="1"'), providers, provider, false)) + '</div>' +
        '<div class="pf-field">' + labelled('모델', 'pf-main-model', mainModelSelect('main-model', withId('pf-main-model', ' data-main="1"'), entries, provider, model, false)) + '</div>' +
        '<div class="pf-field">' + labelled('추론', 'pf-main-thinking', select('main-thinking', withId('pf-main-thinking', ' data-main="1"'), thinkingOptions(thinking, true), false)) + '</div>' +
        '<div class="pf-field pf-field-act">' + (override ? chip('pf-c-green', '직접 지정') : chip('pf-c-gray', '프로필 기본')) + '</div></div>';
    }
    return section('main', body, null);
  }

  function modelLane(view, edit, ro) {
    var pending = firstOf(pendingOf(edit), 'setModelProfile');
    var draft = draftOf(edit, 'lane');
    var current = str(obj(view && view.modelProfile) && view.modelProfile.model_profile);
    var known = obj(view && view.modelProfile) && obj(view.modelProfile.model_profiles) ? Object.keys(view.modelProfile.model_profiles) : [];
    var selection = pending ? str(pending.selection) : draft && typeof draft.selection === 'string' ? str(draft.selection) : current;
    var literal = pending ? str(pending.literal) : draft ? str(draft.literal) : '';
    if (!ro && selection && selection !== 'off' && selection !== 'custom-literal' && LANES.indexOf(selection) < 0 && known.indexOf(selection) < 0) {
      literal = selection;
      selection = 'custom-literal';
    }
    var options = '<option value=""' + (selection ? '' : ' selected') + '>프로필 기본</option>';
    LANES.forEach(function (lane) { options += '<option value="' + esc(lane) + '"' + (lane === selection ? ' selected' : '') + '>' + esc(lane) + '</option>'; });
    known.forEach(function (lane) { if (LANES.indexOf(lane) < 0) options += '<option value="' + esc(lane) + '"' + (lane === selection ? ' selected' : '') + '>' + esc(lane) + '</option>'; });
    options += '<option value="custom-literal"' + (selection === 'custom-literal' ? ' selected' : '') + '>직접 입력 (custom-literal)</option>';
    options += '<option value="off"' + (selection === 'off' ? ' selected' : '') + '>끄기 (off)</option>';
    var body = ro
      ? '<div class="pf-lane-ro"><span class="pf-ro-val">' + valueOrDash(selection === 'custom-literal' ? literal : selection) + '</span>' +
        (selection === 'custom-literal' ? chip('pf-c-amber', '직접 입력') : '') + '</div>'
      : '<div class="pf-lane" data-pf-lane>' +
        '<div class="pf-field">' + labelled('model_profile', 'pf-lane-select', select('lane-select', withId('pf-lane-select', ' data-lane="1"'), options, false)) + '</div>' +
        '<div class="pf-field pf-field-grow">' +
        labelled('직접 입력 값', 'pf-lane-literal', textInput('lane-literal', withId('pf-lane-literal', ' data-lane="1"'), literal, selection !== 'custom-literal', '예: custom-literal-id')) + '</div>' +
        '<div class="pf-field pf-field-act">' + chip('pf-c-gray', 'preview에서 검증') + '</div></div>';
    return section('lanes', body, null);
  }

  function summarizer(view, edit, ro) {
    var pending = firstOf(pendingOf(edit), 'setSummarizer');
    var s = obj(view && view.summarizer) || null;
    var current = pending ? str(pending.modelId) : s ? str(s.provider) + '/' + str(s.model) : '';
    var entries = catalogEntries(view);
    var warnings = summarizerWarnings(current);
    var body = ro
      ? '<div class="pf-sum-ro"><span class="pf-ro-val">' + valueOrDash(current || '설정 안 함') + '</span></div>'
      : '<div class="pf-sum" data-pf-sum><div class="pf-field pf-field-grow">' +
        labelled('요약 모델', 'pf-summarizer-model', select('summarizer-model', withId('pf-summarizer-model', ' data-sum="1"'), summarizerOptions(entries, current), false)) + '</div>' +
        '<div class="pf-field pf-field-act">' + chip('pf-c-gray', 'compaction.model') + '</div></div>' +
        warnings.map(function (w) { return '<p class="pf-warn pf-warn-' + esc(w.level) + '">' + ic('info', 'ic-sm') + ' ' + esc(w.text) + '</p>'; }).join('');
    return section('summarizer', body, null);
  }

  function memoryRows(view, edit, ro) {
    var draft = obj(edit && edit.draft);
    var mem = obj(view && view.memory) || {};
    var rows = ['kibitzer', 'reflection'].map(function (key) {
      var m = obj(mem[key]) || {};
      var pending = memoryChangeOf(pendingOf(edit), key);
      var d = draft && has(draft, 'memory:' + key) && obj(draft['memory:' + key]) ? draft['memory:' + key] : null;
      var mode = pending ? str(pending.mode) : d && str(d.mode) ? str(d.mode) : str(m.mode) || 'quick';
      var model = pending ? str(pending.model) : d && str(d.model) ? str(d.model) : str(m.model);
      var reasoning = pending ? str(pending.reasoning) : d && str(d.reasoning) ? str(d.reasoning) : str(m.reasoning);
      var controls;
      if (ro) {
        controls = '<span class="pf-ro-val">' + valueOrDash(mode) + ' · ' + valueOrDash(model) + (reasoning ? ' / ' + esc(reasoning) : '') + '</span>';
      } else {
        var memId = 'pf-memory-' + slug(key);
        controls = '<div class="pf-mem-sels" data-pf-memory="' + esc(key) + '">' +
          labelled('모드', memId + '-mode', select('memory-mode', withId(memId + '-mode', ' data-memory="' + esc(key) + '"'),
            '<option value="quick"' + (mode === 'quick' ? ' selected' : '') + '>quick</option>' +
            '<option value="custom"' + (mode === 'custom' ? ' selected' : '') + '>custom</option>', false)) +
          labelled('모델', memId + '-model', textInput('memory-model', withId(memId + '-model', ' data-memory="' + esc(key) + '"'), model, mode !== 'custom', '예: opencode-go/deepseek-v4-flash')) +
          labelled('추론', memId + '-thinking', select('memory-thinking', withId(memId + '-thinking', ' data-memory="' + esc(key) + '"'), thinkingOptions(reasoning, true), mode !== 'custom')) +
          '</div>';
      }
      var chips = [];
      if (m.owned) chips.push(chip('pf-c-green', '소유 행'));
      if (m.external) chips.push(chip('pf-c-amber', '외부 행'));
      if (m.unresolved) chips.push(chip('pf-c-red', '미해결'));
      if (m.hasDedicated) chips.push(chip('pf-c-gray', '전용 행'));
      return '<article class="pf-mem-row"><div class="pf-mem-id">' + tag(key) + '<b>' + esc(key === 'kibitzer' ? 'Kibitzer' : 'Reflection') + '</b>' +
        '<span class="pf-mem-cat">' + esc(str(m.category) || '—') + '</span>' + chips.join('') + '</div>' +
        '<div class="pf-mem-val">' + controls + '</div></article>';
    }).join('');
    return section('memory', '<div class="pf-mems">' + rows + '</div>', 2);
  }

  function guideTitle(title, version) {
    // The switcher manifest's title still carries the pre-upgrade edition label. Drop any trailing
    // edition/version phrase, then print the one runtime inventory version the pins came from.
    var base = str(title).replace(/\s*[·\-–—]\s*(?:설치판|패키지)\s*v?\d+(?:\.\d+)+(?:\s*\([^)]*\))?\s*$/, '').trim();
    if (!base) base = 'OMO 모델·역할 권장 가이드';
    return version ? base + ' · ' + version : base;
  }

  function guide(view) {
    var guideData = obj(view && view.guide) || obj(view && view.recommendationGuide) || null;
    var inv = obj(view && view.inventory) || {};
    var sources = guideData && arr(guideData.sources).length ? arr(guideData.sources) : [];
    var rows = sources.map(function (source) {
      return '<div class="pf-guide-row"><code class="pf-path">' + esc(source.path) + '</code><code class="pf-hash">' + esc(source.sha256) + '</code></div>';
    }).join('');
    if (!rows) {
      rows = '<div class="pf-guide-row"><code class="pf-path">' + esc(inv.path || '(omo.js 경로 없음)') + '</code><code class="pf-hash">' +
        esc(inv.pinnedSha256 || '(sha256 없음)') + '</code></div>' +
        '<div class="pf-guide-row"><code class="pf-path">' + esc(inv.manifestPath || '(inventory 경로 없음)') + '</code><code class="pf-hash">' +
        esc(inv.loadedSha256 || '') + '</code></div>';
    }
    // One inventory value drives the heading, the chip and the section subtitle.
    var version = str(inv.version) || str(guideData && guideData.version);
    var title = guideTitle(str(guideData && guideData.title) || 'OMO 모델·역할 권장 가이드', version);
    return section('guide', '<div class="pf-guide"><div class="pf-guide-h">' + tag('guide') + '<b>' + esc(title) + '</b>' +
      (version ? chip('pf-c-gray', version) : '') + (guideData && guideData.snapshotDate ? chip('pf-c-gray', guideData.snapshotDate) : '') + '</div>' + rows +
      (guideData && guideData.guideUrl ? '<p class="pf-guide-url"><code>' + esc(guideData.guideUrl) + '</code></p>' : '') + '</div>', null, '',
      version ? version + ' 기준 경로와 sha256' : '경로와 sha256');
  }

  // ---- pending tray, preview diff and apply result -----------------------------------------------------------------
  function diffRows(preview) {
    var diffs = arr(preview && preview.diffs);
    if (!diffs.length) return emptyNote('바뀌는 파일이 없어요');
    return diffs.map(function (d) {
      var changes = arr(d.changes);
      return '<details class="pf-diff" open><summary><code>' + esc(d.file) + '</code> <span class="pf-count">' + changes.length + '</span></summary><ul>' +
        changes.map(function (c) {
          return '<li><code class="pf-diff-path">' + esc(c.path) + '</code><span class="pf-diff-b">' + esc(jsonText(c.before)) +
            '</span><span class="pf-arrow" aria-hidden="true">→</span><span class="pf-diff-a">' + esc(jsonText(c.after)) + '</span></li>';
        }).join('') + '</ul></details>';
    }).join('');
  }

  function tray(view, edit) {
    if (readonly(view, edit)) return emptyNote(edit && edit.live === true ? '지금은 읽기 전용이라 바꿀 수 없어요' : READONLY_FILE, 'pf-ro-note');
    var pending = pendingOf(edit);
    var busy = edit && edit.busy === true;
    var status = str(edit && edit.status);
    var err = str(edit && edit.error);
    var conflict = !!(edit && edit.conflict);
    var preview = obj(edit && edit.preview);
    var result = obj(edit && edit.result);
    var confirmClear = !!(edit && edit.confirmClear);
    // The empty tray is one quiet line: the editor is what the page exists for. Every state that
    // carries a change, receipt, error, preview or pending recovery keeps the full tray.
    if (!pending.length && !busy && !status && !err && !conflict && !preview && !result && !confirmClear) {
      return '<section class="pf-tray pf-tray-compact" id="pf-sec-tray" data-pf-sec="tray" aria-label="바꿀 값">' +
        '<div class="pf-tray-c" title="바꾼 값이 없어요. 값을 고르면 여기에 모입니다.">' + tag('대기') + ' <b>바꿀 값</b> <span class="pf-count">0</span>' +
        '<span class="pf-muted pf-tray-note">바꾼 값 없음</span></div></section>';
    }
    var list = pending.length
      ? '<ol class="pf-pending">' + pending.map(function (c, i) {
        return '<li><span class="pf-pending-t">' + esc(changeLabel(c)) + '</span>' +
          button('drop', ' data-index="' + i + '" aria-label="이 변경 지우기" title="이 변경 지우기"', ic('x', 'ic-sm'), busy, 'pf-btn pf-btn-icon') + '</li>';
      }).join('') + '</ol>'
      : emptyNote('바꾼 값이 없어요. 아래에서 값을 고르면 여기에 모입니다.');
    return '<section class="pf-tray" id="pf-sec-tray" data-pf-sec="tray">' +
      '<header class="pf-sec-h"><div class="pf-sec-t">' + tag('대기') + '<h2>바꿀 값</h2><p class="pf-sec-s">미리보기는 쓰지 않고, 적용만 파일을 씁니다.</p></div>' +
      '<div class="pf-sec-r"><span class="pf-count">' + pending.length + '</span>' +
      (status ? chip(conflict ? 'pf-c-red' : result ? 'pf-c-green' : 'pf-c-gray', status) : '') + '</div></header>' +
      '<div class="pf-sec-b">' + list +
      '<div class="pf-tray-acts">' +
      button('preview', ' aria-label="미리보기"', ic('search', 'ic-sm') + ' 미리보기', busy || !pending.length || conflict, 'pf-btn') +
      button('apply', ' aria-label="적용"', ic('check', 'ic-sm') + ' 적용', busy || !pending.length || conflict, 'pf-btn pf-btn-primary') +
      button('clear', ' aria-label="모두 버리기"', '모두 버리기', busy || !pending.length, 'pf-btn pf-btn-danger') +
      '</div>' +
      (confirmClear ? '<div class="pf-clear" role="group" aria-label="대기 변경 버리기 확인"><p>대기 중인 변경을 모두 버릴까요?</p>' +
        button('clear-cancel', ' aria-label="계속 보관"', '계속 보관', false, 'pf-btn') + ' ' +
        button('clear-confirm', ' aria-label="모두 버리기 확인"', '모두 버리기', false, 'pf-btn pf-btn-danger') + '</div>' : '') +
      (busy ? '<p class="pf-note" role="status">처리 중…</p>' : '') +
      (conflict ? '<div class="pf-conflict" role="alert"><b>' + esc(CONFLICT_TEXT) + '</b> ' +
        button('reload', ' aria-label="새로고침"', ic('refresh-cw', 'ic-sm') + ' 새로고침', false, 'pf-btn pf-btn-primary') + '</div>' : '') +
      (err && !conflict ? '<p class="pf-err" role="alert">' + esc(err) + '</p>' : '') +
      (preview ? '<div class="pf-preview"><p class="pf-preview-h">' + ic('file-text', 'ic-sm') + ' 파일별 차이 <span class="pf-count">' +
        arr(preview.diffs).length + '</span></p>' + diffRows(preview) +
        arr(preview.warnings).map(function (w) { return '<p class="pf-warn">' + ic('info', 'ic-sm') + ' ' + esc(w) + '</p>'; }).join('') + '</div>' : '') +
      (result ? '<div class="pf-done"><p class="pf-done-h">' + ic('circle-check', 'ic-sm') + ' 적용했어요</p>' +
        '<p class="pf-done-s">백업</p><ul class="pf-backups">' + (arr(result.backups).length ? arr(result.backups).map(function (b) {
          return '<li><code>' + esc(b) + '</code></li>';
        }).join('') : '<li class="pf-muted">없음 (바뀐 파일 없음)</li>') + '</ul>' +
        (arr(result.writes).length ? '<p class="pf-done-s">쓴 파일</p><ul class="pf-writes">' + arr(result.writes).map(function (w) {
          return '<li><code>' + esc(w) + '</code></li>';
        }).join('') + '</ul>' : '') + '</div>' : '') +
      '</div></section>';
  }

  // ---- public renderers --------------------------------------------------------------------------------------------
  function render(view, edit) {
    var v = obj(view), e = obj(edit) || {};
    var state = viewState(v, e);
    var ro = state === 'view' ? readonly(v, e) : true;
    var stale = !!(v && (v.banner === STALE_BANNER || (obj(v.inventory) && v.inventory.stale === true) || v.readOnlyReason === 'INVENTORY_STALE'));
    var html = '<div class="pf" data-pf-root data-readonly="' + ro + '">' + header(v, e) + (v ? homes(v) : '') +
      (stale ? banner(STALE_BANNER, 'pf-banner-warn', 'alert') : '') +
      (state === 'loading' ? loadingBlock() : '') +
      (state === 'error' ? errorBlock(e) : '') +
      (v && arr(v.warnings).length ? '<div class="pf-warnings">' + arr(v.warnings).map(function (w) {
        return '<p class="pf-warn">' + ic('info', 'ic-sm') + ' ' + esc(w) + '</p>';
      }).join('') + '</div>' : '') +
      journalBanner(v, ro) +
      (state === 'view' ? tray(v, e) + agentRows(v, e, ro) + profileCards(v, e, ro) + routingRows(v, e, ro) +
        mainModel(v, e, ro) + modelLane(v, e, ro) + summarizer(v, e, ro) + memoryRows(v, e, ro) + guide(v) : '') +
      '</div>';
    return html;
  }

  function side(view, edit) {
    var v = obj(view), e = obj(edit) || {};
    var ro = readonly(v, e);
    var pending = pendingOf(e).length;
    var nav = SECTIONS.map(function (s) {
      var count = '';
      if (s[0] === 'agents') count = AGENTS.length;
      else if (s[0] === 'profiles') count = arr(v && v.profiles).length;
      else if (s[0] === 'routing') count = arr(obj(v && v.routing) && v.routing.rows).length;
      else if (s[0] === 'memory') count = 2;
      return '<button type="button" class="pf-nav-b" data-pf="jump" data-target="' + esc(s[0]) + '">' +
        '<span class="pf-nav-t">' + esc(s[1]) + '</span>' + (count ? '<span class="pf-count">' + count + '</span>' : '') + '</button>';
    }).join('');
    var loadState = viewState(v, e);
    var state = loadState === 'loading' ? chip('pf-c-gray', '불러오는 중')
      : loadState === 'error' ? chip('pf-c-red', '불러오기 실패')
      : ro ? chip('pf-c-amber', '읽기 전용') : chip('pf-c-green', '편집 가능');
    return '<div class="pf-nav" data-pf-side>' + emptyNote('섹션 이동', 'pf-nav-h') +
      '<div class="pf-nav-state">' + state + (pending ? chip('pf-c-amber', pending + '개 대기') : '') + '</div>' +
      nav +
      (e.conflict ? '<p class="pf-nav-warn">' + esc(CONFLICT_TEXT) + '</p>' : '') +
      (e.error && !e.conflict ? '<p class="pf-nav-warn">' + esc(e.error) + '</p>' : '') +
      '</div>';
  }

  // ---- controller (no DOM, no timers) ------------------------------------------------------------------------------
  function createController(options) {
    var opt = obj(options) || {};
    var fetchFn = opt.fetch;
    var tokenFn = opt.token;
    var notify = typeof opt.onChange === 'function' ? opt.onChange : function () {};
    var s = { view: null, pending: [], draft: map(), preview: null, conflict: false, error: '', status: '', result: null, loading: false, busy: false, confirmClear: false };
    var seq = 0;

    function snapshot() {
      return {
        view: s.view, pending: s.pending.slice(), draft: copyMap(s.draft), preview: s.preview,
        conflict: s.conflict, error: s.error, status: s.status, result: s.result,
        loading: s.loading, busy: s.busy, confirmClear: s.confirmClear
      };
    }
    function changed() { notify(snapshot()); }
    function token() { return typeof tokenFn === 'function' ? str(tokenFn()) : str(tokenFn); }
    function responseJson(res) {
      if (!res || typeof res.json !== 'function') return Promise.resolve(null);
      return Promise.resolve(res.json()).then(null, function () { return null; });
    }
    function statusOf(res) { return res && num(res.status) !== null ? res.status : (res && res.ok ? 200 : 0); }

    function load() {
      if (typeof fetchFn !== 'function') {
        s.error = '상태를 불러올 수 없어요'; s.loading = false; changed(); return Promise.resolve(snapshot());
      }
      s.loading = true; changed();
      var mine = ++seq;
      return Promise.resolve(fetchFn('/profiles/state', { cache: 'no-store', headers: { Accept: 'application/json' } })).then(function (res) {
        var status = statusOf(res);
        if (!res || (status !== 200 && res.ok !== true)) {
          throw new Error('HTTP ' + status);
        }
        return responseJson(res);
      }).then(function (json) {
        if (mine !== seq) return snapshot();
        s.view = obj(json);
        s.loading = false;
        s.error = '';
        // A successful state read is the 409 recovery: the stale conflict and its banner are gone.
        s.conflict = false;
        if (s.status === '다른 곳에서 바뀜') s.status = '';
        changed();
        return snapshot();
      }).catch(function (err) {
        if (mine !== seq) return snapshot();
        s.loading = false;
        s.error = '프로필 상태를 불러오지 못했어요' + (err && err.message ? ' (' + err.message + ')' : '');
        changed();
        return snapshot();
      });
    }

    function sameTarget(a, b) {
      if (!obj(a) || !obj(b) || a.kind !== b.kind) return false;
      if (a.kind === 'setRoute') return a.section === b.section && a.role === b.role;
      if (a.kind === 'setAgentLane' || a.kind === 'setAgentPin' || a.kind === 'resetAgentMemory') return a.agentId === b.agentId;
      if (a.kind === 'setMemoryRow') return (str(a.row) || 'kibitzer') === (str(b.row) || 'kibitzer');
      if (a.kind === 'selectProfile' || a.kind === 'setMain' || a.kind === 'setModelProfile' || a.kind === 'setSummarizer') return true;
      if (a.kind === 'migrateReviewerKeys') return true;
      return false;
    }
    function agentKind(kind) { return kind === 'setAgentLane' || kind === 'setAgentPin' || kind === 'resetAgentMemory'; }

    function add(change) {
      if (!obj(change) || typeof change.kind !== 'string') return snapshot();
      var next = s.pending.filter(function (c) {
        if (!obj(c)) return false;
        if (change.kind === 'selectProfile') return c.kind !== 'selectProfile';
        if (agentKind(change.kind) && agentKind(c.kind) && c.agentId === change.agentId) return false;
        return !sameTarget(c, change);
      });
      if (change.kind === 'selectProfile') next.unshift(change); else next.push(change);
      s.pending = next;
      s.preview = null;
      s.result = null;
      // A 409 is a stale baseline, not a transient error: edits may be added while the conflict is
      // latched, but only a successful load() may make the revision fresh again.
      if (!s.conflict) { s.error = ''; s.status = ''; }
      s.confirmClear = false;
      changed();
      return snapshot();
    }
    function drop(index) {
      var i = typeof index === 'string' && /^\d+$/.test(index) ? Number(index) : num(index);
      if (i === null || i < 0 || i >= s.pending.length) return snapshot();
      s.pending = s.pending.slice(0, i).concat(s.pending.slice(i + 1));
      s.preview = null; s.result = null;
      if (!s.conflict) { s.error = ''; s.status = ''; }
      s.confirmClear = false;
      changed();
      return snapshot();
    }
    function clear() {
      // Discarding removes pending edits but does not make the loaded targets/revision fresh.
      s.pending = []; s.draft = map(); s.preview = null; s.result = null;
      if (!s.conflict) { s.error = ''; s.status = ''; }
      s.confirmClear = false;
      changed();
      return snapshot();
    }
    function askClear() {
      if (!s.pending.length) return snapshot();
      s.confirmClear = true;
      changed();
      return snapshot();
    }
    function cancelClear() {
      s.confirmClear = false;
      changed();
      return snapshot();
    }
    function setDraft(key, patch) {
      var k = str(key);
      if (!k) return snapshot();
      s.draft[k] = Object.assign({}, draftOf({ draft: s.draft }, k) || {}, obj(patch) || {});
      return snapshot();
    }
    function touch() { changed(); return snapshot(); }
    function removeKind(kind) {
      s.pending = s.pending.filter(function (c) { return !obj(c) || c.kind !== kind; });
      s.preview = null; s.result = null;
      if (!s.conflict) { s.error = ''; s.status = ''; }
      s.confirmClear = false;
      changed();
      return snapshot();
    }

    function send(action, changesOverride, options) {
      var opt = obj(options) || {};
      var reapply = opt.reapply === true;
      var list = Array.isArray(changesOverride) ? changesOverride.slice() : s.pending.slice();
      if (s.busy) return Promise.resolve(snapshot());
      // A 409 makes the loaded roster revision stale: neither preview nor apply may post it again
      // until a successful state read. The latch survives add/drop/removeKind/clear; only load() lifts it.
      if (s.conflict) return Promise.resolve(snapshot());
      if (typeof fetchFn !== 'function') {
        s.error = '실시간 상황판에서만 보낼 수 있어요'; changed(); return Promise.resolve(snapshot());
      }
      if (!list.length) {
        s.error = reapply ? '다시 적용할 변경 기록이 없어요' : '바꾼 값을 먼저 골라 주세요';
        changed(); return Promise.resolve(snapshot());
      }
      var body = {
        action: action,
        changes: list,
        expected: obj(s.view && s.view.targets) || {},
        rosterRevision: num(obj(s.view && s.view.roster) && s.view.roster.revision) || 0
      };
      s.busy = true; s.preview = null; s.result = null; s.conflict = false; s.error = ''; s.confirmClear = false;
      s.status = reapply ? '다시 적용 중…' : action === 'preview' ? '미리보기 중…' : '적용 중…';
      changed();
      return Promise.resolve(fetchFn('/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Board-Token': token() },
        body: JSON.stringify(body)
      })).then(function (res) {
        var status = statusOf(res);
        return responseJson(res).then(function (json) {
          return { status: status, json: json };
        });
      }).then(function (res) {
        var json = obj(res.json);
        s.busy = false;
        if (res.status === 200 && json && json.ok === true) {
          if (action === 'preview') {
            s.preview = json; s.status = '미리보기 준비됨'; s.conflict = false; s.error = '';
            changed();
            return snapshot();
          }
          s.result = json; s.preview = null; s.conflict = false; s.error = '';
          if (!reapply) { s.pending = []; s.draft = map(); }
          s.status = reapply ? '다시 적용했어요' : '적용했어요';
          changed();
          return load().then(function () { return snapshot(); });
        }
        if (res.status === 409) {
          s.conflict = true; s.status = '다른 곳에서 바뀜'; s.error = CONFLICT_TEXT;
          changed();
          return snapshot();
        }
        s.status = '실패';
        s.error = (json && (str(json.message) || str(json.code))) || ('HTTP ' + res.status + ' - 다시 시도해 주세요');
        changed();
        return snapshot();
      }).catch(function (err) {
        s.busy = false;
        s.status = '실패';
        s.error = '보내지 못했어요 - 다시 시도해 주세요' + (err && err.message ? ' (' + err.message + ')' : '');
        changed();
        return snapshot();
      });
    }

    return {
      snapshot: snapshot,
      load: load,
      add: add,
      drop: drop,
      clear: clear,
      askClear: askClear,
      cancelClear: cancelClear,
      setDraft: setDraft,
      touch: touch,
      removeKind: removeKind,
      preview: function () { return send('preview'); },
      apply: function () { return send('apply'); },
      reapply: function () {
        var journal = obj(s.view && s.view.applyJournal);
        var payload = obj(journal && journal.reapply);
        var changes = arr(payload && payload.changes);
        if (!changes.length) {
          s.status = '실패'; s.error = '다시 적용할 변경 기록이 없어요'; changed();
          return Promise.resolve(snapshot());
        }
        return send('apply', changes, { reapply: true });
      }
    };
  }

  // ---- delegated listeners -----------------------------------------------------------------------------------------
  function bind(root, hooks) {
    if (!root || typeof root.addEventListener !== 'function') return function () {};
    var h = obj(hooks) || {};
    var controller = function () { return typeof h.controller === 'function' ? h.controller() : null; };
    var actOf = function (target) {
      if (!target || typeof target.closest !== 'function') return null;
      return target.closest('[data-pf]');
    };
    function rowValue(target, rowSel, sel) {
      var row = typeof target.closest === 'function' ? target.closest(rowSel) : null;
      var el = row && typeof row.querySelector === 'function' ? row.querySelector(sel) : null;
      return el ? str(el.value) : '';
    }
    function onClick(ev) {
      var t = actOf(ev && ev.target);
      if (!t || !root.contains(t)) return;
      var act = t.getAttribute('data-pf');
      var c = controller();
      if (!c) return;
      if (act === 'jump') {
        var id = 'pf-sec-' + str(t.getAttribute('data-target'));
        var doc = root.ownerDocument;
        var el = doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null;
        if (!el && doc && typeof doc.querySelector === 'function') el = doc.querySelector('#' + id);
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
      } else if (act === 'select-profile') {
        c.add({ kind: 'selectProfile', profileKey: t.getAttribute('data-profile') });
      } else if (act === 'reset-memory') {
        c.add({ kind: 'resetAgentMemory', agentId: t.getAttribute('data-agent') });
      } else if (act === 'preview') {
        c.preview();
      } else if (act === 'apply') {
        c.apply();
      } else if (act === 'reapply') {
        c.reapply();
      } else if (act === 'clear') {
        c.askClear();
      } else if (act === 'clear-cancel') {
        c.cancelClear();
      } else if (act === 'clear-confirm') {
        c.clear();
      } else if (act === 'drop') {
        c.drop(num(t.getAttribute('data-index')));
      } else if (act === 'reload') {
        if (typeof h.reload === 'function') h.reload();
        else if (g.location && typeof g.location.reload === 'function') g.location.reload();
      }
    }
    function onInput(ev) {
      var t = ev && ev.target;
      if (!t || t.getAttribute('data-pf') !== 'lane-literal') return;
      var c = controller();
      if (!c) return;
      c.setDraft('lane', { literal: str(t.value) });
    }
    function firstOptionFor(selectEl, provider) {
      if (!selectEl || typeof selectEl.querySelectorAll !== 'function') return '';
      var options = selectEl.querySelectorAll('option');
      for (var i = 0; i < options.length; i++) {
        if (options[i].getAttribute('data-provider') === provider) return str(options[i].value);
      }
      return '';
    }
    function onChange(ev) {
      var t = ev && ev.target;
      if (!t || typeof t.getAttribute !== 'function') return;
      var act = t.getAttribute('data-pf');
      var c = controller();
      if (!c) return;
      if (act === 'agent-lane') {
        c.setDraft('agent:' + t.getAttribute('data-agent'), { lane: t.value });
        c.add({ kind: 'setAgentLane', agentId: t.getAttribute('data-agent'), lane: t.value });
      } else if (act === 'agent-pin') {
        var agentId = t.getAttribute('data-agent');
        var value = str(t.value);
        var thinking = rowValue(t, '[data-pf-agent]', '[data-pf="agent-pin-thinking"]') || 'medium';
        c.setDraft('agent:' + agentId, { pin: value, thinking: thinking });
        if (!value) c.add({ kind: 'setAgentPin', agentId: agentId, pin: null });
        else {
          var at = value.indexOf('|');
          if (at > 0 && at < value.length - 1) {
            c.add({ kind: 'setAgentPin', agentId: agentId, pin: { provider: value.slice(0, at), modelId: value.slice(at + 1), thinking: thinking } });
          }
        }
      } else if (act === 'agent-pin-thinking') {
        var agent = t.getAttribute('data-agent');
        var pinValue = rowValue(t, '[data-pf-agent]', '[data-pf="agent-pin"]');
        if (pinValue) {
          var cutAt = pinValue.indexOf('|');
          if (cutAt > 0) c.add({ kind: 'setAgentPin', agentId: agent, pin: { provider: pinValue.slice(0, cutAt), modelId: pinValue.slice(cutAt + 1), thinking: t.value } });
        }
      } else if (act === 'route-provider' || act === 'route-model' || act === 'route-thinking') {
        var route = t.getAttribute('data-route');
        var row = t.closest('[data-pf-route]');
        var provider = row ? str(row.querySelector('[data-pf="route-provider"]').value) : '';
        var model = row ? str(row.querySelector('[data-pf="route-model"]').value) : '';
        var thinking = row ? str(row.querySelector('[data-pf="route-thinking"]').value) : '';
        if (act === 'route-provider' && row) {
          var picked = firstOptionFor(row.querySelector('[data-pf="route-model"]'), provider);
          if (picked) model = picked;
        }
        c.setDraft('route:' + route, { provider: provider, model: model, thinking: thinking });
        var slash = route.indexOf('/');
        if (slash > 0 && provider && model && thinking) {
          c.add({ kind: 'setRoute', section: route.slice(0, slash), role: route.slice(slash + 1), provider: provider, model: model, thinking: thinking });
        } else c.touch();
      } else if (act === 'main-provider' || act === 'main-model' || act === 'main-thinking') {
        var main = t.closest('[data-pf-main]');
        var mp = main ? str(main.querySelector('[data-pf="main-provider"]').value) : '';
        var mm = main ? str(main.querySelector('[data-pf="main-model"]').value) : '';
        var mt = main ? str(main.querySelector('[data-pf="main-thinking"]').value) : '';
        if (act === 'main-provider' && main) {
          var mainPick = firstOptionFor(main.querySelector('[data-pf="main-model"]'), mp);
          if (mainPick) mm = mainPick;
        }
        c.setDraft('main', { provider: mp, model: mm, thinking: mt });
        if (mp && mm) c.add({ kind: 'setMain', provider: mp, model: mm, thinking: mt || 'medium' });
        else c.touch();
      } else if (act === 'lane-select') {
        var lane = str(t.value);
        var literalEl = t.closest('[data-pf-lane]') && t.closest('[data-pf-lane]').querySelector('[data-pf="lane-literal"]');
        var literal = literalEl ? str(literalEl.value) : '';
        c.setDraft('lane', { selection: lane, literal: literal });
        if (lane !== 'custom-literal' || literal) c.add({ kind: 'setModelProfile', selection: lane, literal: lane === 'custom-literal' ? literal : '' });
        else c.touch();
      } else if (act === 'lane-literal') {
        var sel = t.closest('[data-pf-lane]') && t.closest('[data-pf-lane]').querySelector('[data-pf="lane-select"]');
        var selection = sel ? str(sel.value) : '';
        c.setDraft('lane', { selection: selection, literal: str(t.value) });
        if (selection === 'custom-literal' && str(t.value)) c.add({ kind: 'setModelProfile', selection: 'custom-literal', literal: str(t.value) });
        else if (selection === 'custom-literal' && !str(t.value)) c.removeKind('setModelProfile');
      } else if (act === 'summarizer-model') {
        c.add({ kind: 'setSummarizer', modelId: str(t.value) });
      } else if (act === 'memory-mode' || act === 'memory-model' || act === 'memory-thinking') {
        var memRow = t.closest('[data-pf-memory]');
        var key = memRow ? str(memRow.getAttribute('data-pf-memory')) : '';
        var mode = memRow ? str(memRow.querySelector('[data-pf="memory-mode"]').value) : 'quick';
        var modelEl = memRow ? memRow.querySelector('[data-pf="memory-model"]') : null;
        var thinkEl = memRow ? memRow.querySelector('[data-pf="memory-thinking"]') : null;
        var modelValue = modelEl ? str(modelEl.value) : '';
        var thinkValue = thinkEl ? str(thinkEl.value) : '';
        if (!key) return;
        c.setDraft('memory:' + key, { mode: mode, model: modelValue, reasoning: thinkValue });
        if (mode === 'quick') c.add({ kind: 'setMemoryRow', row: key, mode: 'quick' });
        else if (modelValue && thinkValue) c.add({ kind: 'setMemoryRow', row: key, mode: 'custom', model: modelValue, reasoning: thinkValue });
        else c.touch();
      }
    }
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    return function unbind() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      root.removeEventListener('input', onInput);
    };
  }

  g.BriefProfiles = {
    render: render,
    side: side,
    createController: createController,
    bind: bind,
    STALE_BANNER: STALE_BANNER,
    CONFLICT_TEXT: CONFLICT_TEXT,
    escapeHtml: esc
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
