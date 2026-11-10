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
  var CONFLICT_TEXT = '다른 곳에서 바뀌었습니다. 새로고침 후 다시 적용하십시오.';
  var REAPPLY_LABEL = '다시 적용';
  var READONLY_LIVE = '실시간 상황판에서만 바꿀 수 있습니다.';
  var READONLY_FILE = '이 페이지는 보기 전용입니다. 실시간 상황판에서 열어 주십시오.';
  // Why the store refuses writes on the live board (state().readOnlyReason), in the owner's words.
  var READONLY_REASON = {
    COMMENTS_PRESENT: 'omo.jsonc에 주석이 있어 수정할 수 없습니다.',
    MISSING_CONFIG: 'omo.jsonc나 settings.json이 없어 수정할 수 없습니다.',
    INVALID_CONFIG: 'omo.jsonc나 settings.json을 읽지 못해 수정할 수 없습니다.'
  };
  // store.handle answers a refusal with its bare code; the ones the owner can act on read as one sentence.
  var REFUSAL_TEXT = {
    UNSUPPORTED_MODEL: '설치 엔진이 이 모델을 지원하지 않아 적용하지 않았으니 다른 모델을 고르십시오.',
    ADVISOR_FAMILY: '자문가는 자기 계열(Claude 또는 GPT) 모델만 쓸 수 있어 저장하지 않았으니 같은 계열 모델을 고르십시오.'
  };
  var AGENTS = [
    ['sisyphus', 'Sisyphus'],
    ['hephaestus', 'Hephaestus'],
    ['prometheus', 'Prometheus'],
    ['atlas', 'Atlas']
  ];
  var ROUTING_TABS = [['primary', 'Primary'], ['agents', 'Agents'], ['categories', 'Categories'], ['memory', 'Memory']];
  function searchMatch(edit, fields) {
    var query = str(edit && edit.query).trim().toLowerCase();
    return !query || fields.map(str).join(' ').toLowerCase().indexOf(query) >= 0;
  }
  var LANES = ['daily-normal', 'daily-heavy', 'geeky-normal', 'geeky-heavy'];
  var THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  // The sidebar jumps follow the screen: the cards, the detail from top to bottom, then the board-only extras.
  var SECTIONS = [
    ['profiles', '프로필', '프로필과 현재 선택'],
    ['routing', '모델 라우팅', '전담 에이전트 / 작업 카테고리'],
    ['memory', '메모리 행', 'Kibitzer·Reflection 공통 행'],
    ['lanes', '모델 레인', 'model_profile 선택'],
    ['main', '메인 모델', '세션을 여는 기본 모델'],
    ['summarizer', '요약 모델', '압축 요약 모델과 경고'],
    ['guide', '권장 가이드', '경로와 sha256'],
    ['agents', idOf(ROUTING_TABS, 'primary'), '에이전트별 레인·핀·기억']
  ];
  // WinForms copy (Must have 4) and the purpose groups of PS RoutingGroups (PS:346-358) in their order. A board
  // group id maps to the WinForms section id of the flow map; unknown groups follow and 추가 설정 closes a section.
  var CAPTIONS = ['1. 구독 서비스', '2. AI 모델', '3. 추론 강도'];
  // WinForms Format-ModelChoice (PS:566, 1569) labels a model the installed engine does not serve.
  var UNSERVED = 'UNSUPPORTED_MODEL';
  var ROLE_SECTIONS = [
    ['agents', 'Agents', ['discovery', 'planning', 'review']],
    ['categories', 'Categories', ['general', 'reasoning', 'specialism']]
  ];
  var FLOW_GROUP = { discovery: 'explore-research', planning: 'plan-advice', review: 'review-qa', general: 'quick-general', reasoning: 'deep', specialism: 'specialist' };
  // Identity marks are shapes as well as colours, so the fixed roster palette is never the only cue.
  var SHAPES = { sisyphus: 'circle', hephaestus: 'square', prometheus: 'triangle', atlas: 'diamond' };
  var SHAPE_KO = { circle: '원형', square: '사각형', triangle: '삼각형', diamond: '마름모' };
  var STATUS_LABEL = {
    recommended: 'recommended', fallback: 'fallback', 'variant-different': 'variant-different', different: 'different',
    unresolved: 'unresolved', unassigned: 'unassigned', untracked: 'untracked', unknown: 'unknown', unset: 'unset'
  };
  var MEMORY_STATUS_LABEL = {
    unresolved: STATUS_LABEL.unresolved, skippedUnresolved: 'skipped · unresolved'
  };
  var STATUS_TEXT = {
    current: 'current', pending: 'pending', saved: 'saved', failure: 'failure', none: 'none',
    external: 'external', owned: 'owned', dedicated: 'dedicated', loading: 'loading', error: 'error',
    file: 'file', readOnly: 'read-only', editable: 'editable', processing: 'processing',
    applied: 'applied', idle: 'idle', override: 'override', profile: 'profile',
    customLiteral: 'custom-literal', thinkingMismatch: 'thinking-mismatch', rosterWarning: 'roster.warning',
    absent: 'absent', failurePendingRetained: 'failure · pending retained',
    applying: 'applying', previewing: 'previewing', reapplying: 'reapplying',
    previewReady: 'preview ready', reapplied: 'reapplied', conflict: 'conflict'
  };
  var CHANGE_LABEL = {
    selectProfile: '프로필', setRoute: '역할', setRoleBackup: '역할 백업', setMain: '메인 모델', setModelProfile: '모델 레인',
    setSummarizer: '요약 모델', setMemoryRow: '메모리 행', setAgentLane: '에이전트 레인',
    setAgentPin: '에이전트 핀', resetAgentMemory: '기억 초기화', migrateReviewerKeys: '리뷰어 키', setAdvisor: '오라클 자문가'
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
  function chip(cls, label) {
    return '<span class="pf-chip ' + cls + '"' + attr('title', label) + attr('aria-label', label) + '>' + esc(label) + '</span>';
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
  function thinkingOptions(selected, allowEmpty, levels) {
    var out = allowEmpty ? '<option value=""' + (selected ? '' : ' selected') + '>(없음)</option>' : '';
    (levels || THINKING).forEach(function (level) {
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
  function valueOrDash(v) { return str(v) ? esc(v) : '<span class="pf-dash" aria-label="none" title="none">—</span>'; }
  // The model copy is data, not markup: escape it first, then wrap the phrases that must not split across
  // lines. One combined pass keeps product names, interpunct compounds and modifier + noun phrases together;
  // the surrounding text stays selectable and no rendered word is changed.
  var KEEP_PHRASES = /\(max 추론\)|진짜 max 추론|max 추론|(?:GLM|GPT|Kimi|DeepSeek|Flash|딥시크)\s+\d+(?:\.\d+)?(?:\s+(?:Flash|Pro|Max))?(?:\(max 추론\))?|(?:깊은|개인용|빠른|단순|고강도)\s+[가-힣A-Za-z0-9]+(?:·[가-힣A-Za-z0-9]+)*|[가-힣A-Za-z0-9]+(?:·[가-힣A-Za-z0-9]+)+\s*[가-힣A-Za-z0-9]*/g;
  function summaryText(v) {
    return esc(v).replace(KEEP_PHRASES, function (m) { return '<span class="pf-keep">' + m + '</span>'; });
  }
  function currentChip() {
    return '<span class="pf-chip pf-c-green pf-current" title="current" aria-label="current">' + ic('check', 'ic-sm') + ' current</span>';
  }

  // ---- model helpers -----------------------------------------------------------------------------------------------
  // Every catalog model with `off` = unservedOf (null when served). Model lists show them all; only served ones are
  // enabled, offered as a service, given effort levels or kept by a cascade.
  function catalogEntries(view) {
    var cat = obj(view && view.catalog) || {}, out = [];
    Object.keys(cat).forEach(function (alias) {
      var entry = obj(cat[alias]);
      if (!entry) return;
      out.push({
        alias: alias,
        registered: true,
        model: str(entry.model),
        variant: str(entry.variant) || str(entry.reasoning),
        off: unservedOf(entry),
        levels: Array.isArray(entry.levels) ? entry.levels.slice() : null
      });
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
      out.push({
        alias: str(item && item.alias) || bareModel(model),
        model: model,
        variant: str(item && item.variant),
        off: unservedOf(item),
        levels: item && Array.isArray(item.levels) ? item.levels.slice() : null
      });
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
  // Pure option descriptors: model is the full ID even when value is an alias or bare ID.
  // missing keeps a stored ID literal; placeholder keeps its text outside the model pool.
  // Only text changes. Callers escape it at the HTML boundary after completing the pool.
  function displayModelLabels(options) {
    var models = [], parts = map(), labels = map(), pending = [], used = map();
    options.forEach(function (option) {
      if (option.placeholder || has(parts, option.model)) return;
      models.push(option.model);
      parts[option.model] = bareModel(option.model).split('/');
    });
    models.forEach(function (model) {
      var path = parts[model], label = '';
      var annotated = options.filter(function (option) {
        return !option.placeholder && !option.missing && option.off && option.model === model;
      });
      for (var depth = 1; depth <= path.length; depth++) {
        var suffix = path.slice(-depth).join('/');
        var collision = models.some(function (other) {
          return other !== model && parts[other].slice(-depth).join('/').toLowerCase() === suffix.toLowerCase();
        }) || options.some(function (option) {
          return !option.placeholder && option.missing && option.model !== model &&
            option.model.toLowerCase() === suffix.toLowerCase();
        }) || annotated.length && options.some(function (other) {
          if (other.placeholder || other.model === model) return false;
          var endings = other.missing ? [other.model] : parts[other.model].map(function (_, index) {
            return parts[other.model].slice(index).join('/');
          });
          return endings.some(function (ending) {
            var text = ending + (other.off ? ' · ' + other.off.label : '');
            return annotated.some(function (own) {
              return (suffix + ' · ' + own.off.label).toLowerCase() === text.toLowerCase();
            });
          });
        });
        if (!collision) { label = suffix; break; }
      }
      if (label) labels[model] = label;
    });
    // Reserve literal stored IDs and all resolved text before allocating any ID numbers.
    options.forEach(function (option) {
      if (option.placeholder) return;
      var label = option.missing ? option.model : labels[option.model];
      if (label) {
        used[(label + (option.off ? ' · ' + option.off.label : '')).toLowerCase()] = true;
      } else if (pending.indexOf(option.model) < 0) {
        pending.push(option.model);
      }
    });
    pending.sort();
    var next = 1;
    pending.forEach(function (model) {
      var label;
      do {
        label = bareModel(model) + ' [ID ' + next++ + ']';
      } while (options.some(function (option) {
        return !option.placeholder && !option.missing && option.model === model &&
          has(used, (label + (option.off ? ' · ' + option.off.label : '')).toLowerCase());
      }));
      labels[model] = label;
      options.forEach(function (option) {
        if (!option.placeholder && !option.missing && option.model === model) {
          used[(label + (option.off ? ' · ' + option.off.label : '')).toLowerCase()] = true;
        }
      });
    });
    return options.map(function (option) {
      var copy = Object.assign({}, option);
      if (!option.placeholder) {
        copy.text = (option.missing ? option.model : labels[option.model]) +
          (option.off ? ' · ' + option.off.label : '');
      }
      return copy;
    });
  }
  function entryOf(entries, alias, model) {
    for (var i = 0; i < entries.length; i++) {
      if (alias && entries[i].alias === alias) return entries[i];
      if (model && entries[i].model === model) return entries[i];
    }
    return null;
  }
  // WinForms Get-ClampedThinkingLevel (board: model.mjs getClampedThinkingLevel) over one catalog entry's levels:
  // keep a supported level, else the nearest higher one, else the nearest lower one.
  function clampedThinking(entry, level) {
    var available = entry && Array.isArray(entry.levels) && entry.levels.length ? entry.levels : THINKING;
    if (available.indexOf(level) >= 0) return level;
    var requested = THINKING.indexOf(level);
    if (requested < 0) return available[0] || 'off';
    for (var i = requested; i < THINKING.length; i++) {
      if (available.indexOf(THINKING[i]) >= 0) return THINKING[i];
    }
    for (var j = requested - 1; j >= 0; j--) {
      if (available.indexOf(THINKING[j]) >= 0) return THINKING[j];
    }
    return available[0] || 'off';
  }
  // A service is offered when it has a served model; the current one always stays.
  function providersOf(entries, current) {
    var out = [];
    entries.forEach(function (e) {
      var p = providerOf(e.model);
      if (p && !e.off && out.indexOf(p) < 0) out.push(p);
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
  // One model choice. A model the engine does not serve stays listed but disabled, its reason in the label and the
  // title (IS-6); a forced pick of it is still the server's to refuse.
  function modelOption(option) {
    var text = (option.prefix || '') + option.text;
    if (option.aliasLabel) text = option.alias + ' · ' + text + (option.variant ? ' / ' + option.variant : '');
    var title = !option.placeholder && text !== bareModel(option.model) ? option.model : '';
    if (title && option.off) title += ' · ' + offTitle(option.off);
    if (option.aliasLabel) title = '';
    return '<option value="' + esc(option.value) + '"' +
      (has(option, 'provider') ? attr('data-provider', option.provider) : '') +
      (option.selected ? ' selected' : '') + (option.off ? ' disabled' : '') +
      (title ? attr('title', title) : '') + '>' + esc(text) + '</option>';
  }
  function modelOptions(options) {
    return displayModelLabels(options).map(modelOption).join('');
  }
  function modelPool(entries, provider, current) {
    var pool = [], seen = map(), model = current;
    entries.forEach(function (entry) {
      if (provider && providerOf(entry.model) !== provider || has(seen, entry.model)) return;
      seen[entry.model] = true;
      pool.push({ value: entry.model, model: entry.model, provider: providerOf(entry.model),
        selected: entry.model === model, off: entry.off });
    });
    if (model && !has(seen, model)) pool.push({
      value: model, model: model, provider: providerOf(model), selected: true, missing: true
    });
    return pool;
  }
  function modelText(entries, model) {
    var pool = modelPool(entries, providerOf(model), model);
    var labels = displayModelLabels(pool);
    for (var i = 0; i < labels.length; i++) if (labels[i].model === model) return labels[i].text;
    return '';
  }
  function fullIdLine(id, model, alias) {
    return '<p class="pf-fullid"' + attr('id', id + '-fullid') + ' tabindex="0"><code>' +
      esc(model || STATUS_TEXT.none) + (alias ? ' · ' + esc(alias) : '') + '</code></p>';
  }
  function modelDescription(id) {
    return attr('aria-describedby', id + '-fullid');
  }
  function modelSelect(name, attrs, entries, provider, fullId, disabled) {
    var pool = modelPool(entries, provider, fullId);
    pool.unshift({ value: '', placeholder: true, selected: !fullId, text: '(선택)' });
    var entry = entryOf(entries, '', fullId);
    return select(name, attrs, modelOptions(pool), disabled,
      fullId ? (entry ? entry.alias + ' · ' : '') + fullId : '(선택)');
  }
  function backupSelect(entries, alias, primary, attrs, busy, direct) {
    var options = [{ value: '', placeholder: true, selected: !alias && !direct, text: '백업 없음' }];
    if (direct) options.push({ value: '__direct__', placeholder: true, selected: true, text: '직접 선택한 백업' });
    var found = !alias;
    entries.forEach(function (entry) {
      if (entry.alias !== alias && (!entry.registered || entry.alias === primary ||
        providerOf(entry.model) === 'opencode-go' && !/^(?:ocg-)?muse-/i.test(bareModel(entry.model)))) return;
      if (entry.alias === alias) found = true;
      options.push({ value: entry.alias, alias: entry.alias, aliasLabel: true, variant: entry.variant,
        model: entry.model, provider: providerOf(entry.model), selected: entry.alias === alias, off: entry.off });
    });
    if (!found) options.push({ value: alias, placeholder: true, selected: true, text: alias + ' · 저장된 백업' });
    var selected = entryOf(entries, alias);
    return select('route-backup', attrs, modelOptions(options), busy,
      selected ? selected.model : alias || (direct ? '직접 선택한 백업' : '백업 없음'));
  }
  function backupFields(edit, profile, section, role, saved, entries, id, primary) {
    var route = section + '/' + role;
    var choice = backupChangeOf(pendingOf(edit), profile, section, role) || saved || {};
    var alias = str(choice.alias), definition = alias ? entryOf(entries, alias) : null;
    var model = alias ? str(definition && definition.model) : str(choice.model);
    var provider = str(choice.provider) || providerOf(model);
    if (model && model.indexOf('/') < 0 && provider) model = provider + '/' + model;
    var thinking = str(choice.thinking) || str(definition && definition.variant);
    var summary = alias || (model ? modelText(entries, model) + (thinking ? ' / ' + thinking : '') : '');
    var draft = draftOf(edit, 'backup:' + str(profile && profile.omoProfile) + ':' + route);
    if (draft) { provider = str(draft.provider); model = str(draft.model); thinking = str(draft.thinking); }
    var candidates = entries.filter(function (e) {
      return providerOf(e.model) !== 'opencode-go' || /^(?:ocg-)?muse-/i.test(bareModel(e.model));
    }).map(function (e) { return { alias: e.alias, provider: providerOf(e.model), model: e.model, levels: e.levels || THINKING, off: e.off }; });
    var busy = !!(edit && edit.busy);
    var on = function (part) { return withId(id + '-' + part, attr('data-route', route)); };
    return {
      summary: summary,
      html: '<div class="pf-backup" data-backup-route="' + esc(route) + '">' +
        '<div class="pf-backup-direct">' +
        labelled('백업 1. 서비스', id + '-provider', select('backup-provider', on('provider'), memoryServiceOptions(candidates, provider), busy)) +
        labelled('백업 2. 모델', id + '-model', select('backup-model', on('model') + modelDescription(id + '-model'), memoryModelOptions(candidates, provider, model), busy || !provider, model || '(선택)')) +
        labelled('백업 3. 추론강도', id + '-thinking', select('backup-thinking', on('thinking'), memoryThinkingOptions(candidates, model, thinking), busy || !model)) +
        '</div>' + fullIdLine(id + '-model', model, alias) +
        labelledHint('기존 등록 별칭', '선택값만 저장합니다. 자동 전환하지 않습니다.', id,
          backupSelect(entries, alias, primary, withId(id, attr('data-route', route)) + modelDescription(id), busy, !alias && !!str(choice.model))) +
        fullIdLine(id, model, alias) +
        '</div>'
    };
  }
  function mainModelSelect(name, attrs, entries, provider, bare, disabled) {
    var pool = [{ value: '', placeholder: true, selected: !bare, text: '(선택)' }], found = false, seen = map();
    entries.forEach(function (e) {
      if (provider && providerOf(e.model) !== provider) return;
      var id = bareModel(e.model);
      if (id === bare) found = true;
      if (has(seen, id)) return;
      seen[id] = true;
      pool.push({ value: id, model: e.model, provider: providerOf(e.model), selected: id === bare, off: e.off });
    });
    var full = bare ? (provider ? provider + '/' : '') + bare : '';
    if (bare && !found) pool.push({ value: bare, model: full, selected: true, missing: true });
    return select(name, attrs, modelOptions(pool), disabled, full || '(선택)');
  }
  // The store's verdict on a shown model, worded: the store decides it once for every model (registry.mjs
  // supportStatusFor) and sends the refusal code and the first home that refuses it, which a forced pick is refused
  // with too. An unread registry (REGISTRY_UNKNOWN) reads 미확인, any other refusal 미지원. null = served.
  function unservedOf(item) {
    if (!obj(item) || item.unsupported !== true) return null;
    var code = str(item.unsupportedReason);
    return { label: code || UNSERVED, code: code, home: str(item.unsupportedHome) };
  }
  function offText(off) { return off.label + (off.home ? ' · ' + off.home : ''); }
  function offTitle(off) { return offText(off); }
  // The flag on a shown value the engine refuses: reason and home, with the refusal code as its title. It is a lasting
  // configuration state, so it takes the warning colour; red stays for failures.
  function offChip(off) { return off ? chip('pf-c-amber', offText(off)) : ''; }
  function servedEntries(view) {
    return catalogEntries(view).filter(function (e) { return !e.off; });
  }
  function memoryCandidates(view, withUnserved) {
    var list = withUnserved ? catalogEntries(view) : servedEntries(view), out = [], seen = map();
    list.forEach(function (e) {
      if (!e.model || has(seen, e.model)) return;
      seen[e.model] = true;
      var levels = Array.isArray(e.levels) ? e.levels.slice() : THINKING.slice();
      out.push({ alias: e.alias, model: e.model, provider: providerOf(e.model), levels: levels, off: e.off });
    });
    return out;
  }
  // A memory row also offers the served models no catalog alias names: WinForms Get-MemoryCandidates (PS:3246-3285)
  // lists every model all required homes serve, which the store sends as memory.candidates with their common levels.
  // Catalog entries come first with their alias, and an unserved one stays listed, disabled with its reason.
  function memoryRowCandidates(view, withUnserved) {
    var out = memoryCandidates(view, withUnserved), seen = map();
    out.forEach(function (c) { seen[c.model] = true; });
    arr(obj(view && view.memory) && view.memory.candidates).forEach(function (item) {
      var model = str(item && item.model);
      if (!providerOf(model) || has(seen, model)) return;
      seen[model] = true;
      out.push({ alias: bareModel(model), model: model, provider: providerOf(model), levels: arr(item.levels).slice(), off: null });
    });
    return out;
  }
  function quickTupleOf(view, m, entries) {
    var q = obj(m && m.quick);
    if (q && str(q.model)) {
      return { provider: providerOf(q.model), model: str(q.model), reasoning: str(q.reasoning) };
    }
    var rows = arr(obj(view && view.routing) && view.routing.rows);
    for (var i = 0; i < rows.length; i++) {
      var r = obj(rows[i]);
      if (r && r.section === 'categories' && r.role === 'quick' && str(r.model)) {
        var entry = entryOf(entries, str(r.model), str(r.model));
        var full = entry ? entry.model : str(r.model);
        var reas = str(r.reasoning) || (entry ? entry.variant : '');
        return { provider: providerOf(full), model: full, reasoning: reas };
      }
    }
    if (m && str(m.mode) !== 'custom' && str(m.model)) {
      return { provider: providerOf(m.model), model: str(m.model), reasoning: str(m.reasoning) };
    }
    return { provider: '', model: '', reasoning: '' };
  }
  function summarizerProviderOptions(entries, currentProvider) {
    var opts = '<option value=""' + (currentProvider ? '' : ' selected') + '>원본 기본 컴팩션</option>';
    var providers = providersOf(entries, currentProvider);
    providers.forEach(function (p) {
      opts += '<option value="' + esc(p) + '"' + (p === currentProvider ? ' selected' : '') + '>' + esc(p) + '</option>';
    });
    return opts;
  }
  function summarizerModelOptions(entries, provider, currentModel) {
    var pool = modelPool(provider ? entries : [], provider, currentModel);
    pool.unshift({ value: '', placeholder: true, selected: !currentModel, text: '(선택)' });
    return modelOptions(pool);
  }
  function memoryServiceOptions(candidates, provider) {
    var opts = '<option value=""' + (provider ? '' : ' selected') + '>(선택)</option>';
    var providers = [];
    candidates.forEach(function (c) {
      if (c.provider && providers.indexOf(c.provider) < 0) providers.push(c.provider);
    });
    if (provider && providers.indexOf(provider) < 0) providers.push(provider);
    providers.sort().forEach(function (p) {
      opts += '<option value="' + esc(p) + '"' + (p === provider ? ' selected' : '') + '>' + esc(p) + '</option>';
    });
    return opts;
  }
  function memoryModelOptions(candidates, provider, model) {
    var pool = [{ value: '', placeholder: true, selected: !model, text: '(선택)' }], found = false;
    candidates.forEach(function (c) {
      if (!provider || c.provider !== provider) return;
      if (c.model === model) found = true;
      pool.push({ value: c.model, model: c.model, provider: providerOf(c.model), selected: c.model === model, off: c.off });
    });
    if (model && !found) {
      pool.push({ value: model, model: model, provider: providerOf(model), selected: true,
        missing: true, prefix: STATUS_LABEL.unresolved + ': ' });
    }
    return modelOptions(pool);
  }
  function memoryThinkingOptions(candidates, model, reasoning) {
    var opts = '<option value=""' + (reasoning ? '' : ' selected') + '>(선택)</option>', found = false;
    var cand = null;
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].model === model) { cand = candidates[i]; break; }
    }
    var levels = cand ? cand.levels : [];
    levels.forEach(function (level) {
      if (level === reasoning) found = true;
      opts += '<option value="' + esc(level) + '"' + (level === reasoning ? ' selected' : '') + '>' + esc(level) + '</option>';
    });
    if (reasoning && !found) {
      opts += '<option value="' + esc(reasoning) + '" selected>' + esc(cand ? STATUS_LABEL.unresolved + ': ' + reasoning : reasoning) + '</option>';
    }
    return opts;
  }
  function recommendationOf(row) {
    var rec = obj(row && row.recommendation) || obj(row && row.recommend) || null;
    var status = str(rec && (rec.Status || rec.status)) || str(row && row.recommendationStatus) || '';
    if (!status) status = str(row && row.model) ? 'unknown' : 'unset';
    return {
      status: status,
      official: str(rec && (rec.Official || rec.official)),
      label: status
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
  // A role, main or lane edit belongs to one profile: setMain and setModelProfile name it by the card key (store
  // getProfile), setRoute by the omo layer the store writes (store routeChange), and all mean that card. The card line
  // and the detail pane read edits through this one filter, so the detail shows only the shown profile's edits (IS-10)
  // and agrees with its card.
  function ofProfile(c, p) {
    var key = str(c.profileKey);
    return !!key && !!p && (key === p.key || key === str(p.omoProfile));
  }
  function routeChangeOf(pending, p, section, role) {
    return findChange(pending, function (c) { return c && c.kind === 'setRoute' && c.section === section && c.role === role && ofProfile(c, p); });
  }
  function backupChangeOf(pending, p, section, role) {
    return findChange(pending, function (c) { return c && c.kind === 'setRoleBackup' && c.section === section && c.role === role && ofProfile(c, p); });
  }
  function mainChangeOf(pending, p) {
    return findChange(pending, function (c) { return c && c.kind === 'setMain' && ofProfile(c, p); });
  }
  function laneChangeOf(pending, p) {
    return findChange(pending, function (c) { return c && c.kind === 'setModelProfile' && ofProfile(c, p); });
  }
  function firstOf(pending, kind) {
    return findChange(pending, function (c) { return c && c.kind === kind; });
  }
  function changeLabel(c) {
    var kind = str(c && c.kind);
    var head = CHANGE_LABEL[kind] || kind || '변경';
    if (kind === 'selectProfile') return head + ' → ' + str(c.profileKey);
    if (kind === 'setRoleBackup') return head + ' ' + str(c.section) + '/' + str(c.role) + ' → ' +
      (str(c.alias) || (str(c.model) ? str(c.provider) + '/' + bareModel(c.model) + ' / ' + str(c.thinking) : '백업 없음'));
    if (kind === 'setRoute') return head + ' ' + str(c.section) + '/' + str(c.role) + ' → ' + str(c.provider) + ' · ' + str(c.model) + ' / ' + str(c.thinking);
    if (kind === 'setAdvisor') return head + ' ' + str(c.advisor) + ' → ' + str(c.provider) + ' · ' + str(c.model) + ' / ' + str(c.thinking);
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
  // Empty data is a read-only fact, not a missing create feature: the one supported recovery is
  // re-reading the store's real state through the same GET the view already uses.
  function emptyState(text, edit, cls) {
    var live = edit && edit.live === true;
    var busy = !!(edit && edit.busy === true);
    return '<div class="pf-empty-state ' + (cls || '') + '">' + emptyNote(text) +
      (live ? button('reload-state', ' aria-label="상태 다시 불러오기"',
        ic('refresh-cw', 'ic-sm') + ' 상태 다시 불러오기', busy) : '') + '</div>';
  }
  function readOnlyNote(edit, view) {
    if (edit && edit.live !== true) return emptyNote(READONLY_FILE, 'pf-ro-note');
    if (view && view.banner === STALE_BANNER) return emptyNote('인벤토리를 갱신할 때까지 수정할 수 없습니다.', 'pf-ro-note');
    var reason = str(view && view.readOnlyReason);
    return emptyNote(has(READONLY_REASON, reason) ? READONLY_REASON[reason] : READONLY_LIVE, 'pf-ro-note');
  }
  // A refusal code the owner can act on reads as its sentence, with the code beside it as the detail.
  function errorHtml(err) {
    return has(REFUSAL_TEXT, err) ? esc(REFUSAL_TEXT[err]) + ' <code class="pf-err-code">' + esc(err) + '</code>' : esc(err);
  }
  function banner(text, cls, role) {
    return '<div class="pf-banner ' + (cls || '') + '"' + (role ? attr('role', role) : '') + '>' + ic('info', 'ic-sm') + ' <b>' + esc(text) + '</b></div>';
  }
  // An interrupted apply is a real state, not a sentence: the owner must be able to trigger
  // the explicit replay. The payload is the journal's recorded changes (never the pending
  // tray), and the click posts them once through the same guarded apply route.
  function journalBanner(view, edit, ro) {
    var journal = obj(view && view.applyJournal);
    if (!journal || journal.status !== 'interrupted') return '';
    var payload = obj(journal.reapply);
    var changes = arr(payload && payload.changes);
    var busy = !!(edit && edit.busy === true);
    var conflict = !!(edit && edit.conflict === true);
    var head = '<div class="pf-banner pf-banner-warn" data-pf-journal="interrupted" role="status">' +
      ic('info', 'ic-sm') + ' <b>' + esc(journal.status) + '</b>';
    if (ro) return head + ' <span class="pf-muted">' + esc(STATUS_TEXT.readOnly) + '</span></div>';
    if (!changes.length) return head + ' <span class="pf-muted">' + esc('다시 적용할 변경 기록이 없습니다.') + '</span></div>';
    // The reapply button is a real apply: it must mirror apply's disabled state. A latched 409
    // needs the reload hand-off first; an in-flight request must settle before another write.
    var why = conflict ? '새로고침 후 다시 적용할 수 있습니다.' : busy ? '처리 중…' : '';
    return head + ' ' + button('reapply', ' aria-label="' + esc(REAPPLY_LABEL) + '"' + (why ? attr('title', why) : ''),
      ic('refresh-cw', 'ic-sm') + ' ' + esc(REAPPLY_LABEL), busy || conflict, 'pf-btn') +
      (why ? ' <span class="pf-muted">' + esc(why) + '</span>' : '') + '</div>';
  }
  // Loading, error and a loaded view are three states. A missing view is never a read-only view: the
  // read-only badge and note may only appear once a state exists and says writes are refused.
  function viewState(view, edit) {
    if (obj(view)) return 'view';
    return edit && str(edit.error) ? 'error' : 'loading';
  }
  // The loading frame reuses the loaded view's own top-level primitives: the homes strip, the
  // compact tray, the real section header (tag, title, subtitle), four full-width agent rows with
  // the same responsive field grid, six cards and the routing rows. The browser QA measures the
  // actual first skeleton row against the loaded first agent row after fonts are ready.
  function loadingBlock() {
    var agents = '';
    for (var i = 0; i < 4; i++) {
      agents += '<div class="pf-skel pf-skel-agent" data-pf-skel="agent" aria-hidden="true">' +
        '<span class="pf-skel-field pf-skel-id"><span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-c"></span></span>' +
        '<span class="pf-skel-field"><span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-c"></span></span>' +
        '<span class="pf-skel-field"><span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-pin"><span class="pf-skel-line pf-skel-line-c"></span><span class="pf-skel-line pf-skel-line-c"></span></span></span>' +
        '<span class="pf-skel-field pf-skel-mem"><span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-c"></span></span>' +
        '</div>';
    }
    var cards = '';
    for (var j = 0; j < 6; j++) {
      cards += '<div class="pf-skel pf-skel-card" data-pf-skel="card" aria-hidden="true">' +
        '<span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-s"></span>' +
        '<span class="pf-skel-line pf-skel-line-s"></span><span class="pf-skel-line pf-skel-line-s"></span>' +
        '<span class="pf-skel-line pf-skel-line-c"></span></div>';
    }
    var routes = '';
    for (var k = 0; k < 20; k++) {
      routes += '<div class="pf-skel pf-skel-route" data-pf-skel="route" aria-hidden="true">' +
        '<span class="pf-skel-field pf-skel-id"><span class="pf-skel-line pf-skel-line-t"></span><span class="pf-skel-line pf-skel-line-s"></span></span>' +
        '<span class="pf-skel-field pf-skel-route-sels"><span class="pf-skel-line pf-skel-line-c"></span><span class="pf-skel-line pf-skel-line-c"></span><span class="pf-skel-line pf-skel-line-c"></span></span>' +
        '<span class="pf-skel-field pf-skel-rec"><span class="pf-skel-line pf-skel-line-s"></span></span></div>';
    }
    var loadingSection = function (key, body, count, extra) {
      var meta = null;
      SECTIONS.forEach(function (s) { if (s[0] === key) meta = s; });
      var title = meta ? meta[1] : key, sub = meta ? meta[2] : '';
      return '<section class="pf-skel-sec" data-pf-skel="' + key + '" aria-hidden="true">' +
        '<header class="pf-sec-h"><div class="pf-sec-t">' + tag(title) + '<h2>' + esc(title) + '</h2>' +
        '<p class="pf-sec-s">' + esc(sub) + '</p></div><div class="pf-sec-r">' +
        (count === null ? '' : '<span class="pf-count">' + count + '</span>') + (extra || '') + '</div></header>' +
        '<div class="pf-sec-b">' + body + '</div></section>';
    };
    var home = function (label) {
      return '<span class="pf-home pf-skel-home" aria-hidden="true">' + tag(label) +
        ' <code><span class="pf-skel-line pf-skel-home-line"></span></code></span>';
    };
    return '<div class="pf-loading" data-pf-loading role="status">' +
      '<div class="pf-skeleton">' +
      '<section class="pf-tray pf-tray-compact" data-pf-skel="tray" aria-label="바꿀 값"><div class="pf-tray-c">' +
      tag(STATUS_TEXT.idle) + ' <b>바꿀 값</b> <span class="pf-count">0</span>' +
      '<span class="pf-muted pf-tray-note">바꾼 값 없음</span>' +
      '<span class="pf-tray-next" id="pf-focus-status" tabindex="-1" role="group" aria-labelledby="pf-focus-status"><span class="pf-pulse" aria-hidden="true">' +
      ic('refresh-cw', 'ic-sm') + '</span> 프로필 상태를 불러오는 중…</span></div></section>' +
      '<div class="pf-panes">' + loadingSection('profiles', '<div class="pf-cards">' + cards + '</div>', null) +
      loadingSection('routing', '<div class="pf-routes">' + routes + '</div>', null) + '</div>' +
      loadingSection('agents', '<div class="pf-agents">' + agents + '</div>', AGENTS.length, ic('chevron-down', 'ic-sm pf-chev')) +
      '<div class="pf-homes pf-skel-homes" data-pf-skel="homes" aria-hidden="true">' +
      home('primary') + home('mirror') + home('stable-500') + '</div>' +
      '</div></div>';
  }
  function errorBlock(edit) {
    return '<div class="pf-error" role="alert"><p class="pf-err" id="pf-focus-status" tabindex="-1" role="group" aria-labelledby="pf-focus-status">' + esc(edit && edit.error) + '</p>' +
      button('reload', ' aria-label="다시 시도"', ic('refresh-cw', 'ic-sm') + ' 다시 시도', false, 'pf-btn') + '</div>';
  }

  function header(view, edit) {
    var live = edit && edit.live === true;
    var state = viewState(view, edit);
    var ro = state === 'view' && readonly(view, edit);
    var badge = state === 'loading' ? chip('pf-c-gray', state)
      : state === 'error' ? chip('pf-c-red', state)
      : !live ? chip('pf-c-gray', STATUS_TEXT.file) : ro ? chip('pf-c-amber', STATUS_TEXT.readOnly) : chip('pf-c-green', STATUS_TEXT.editable);
    // WinForms Update-PendingIndicator (PS:4529-4535): the heading carries the pending count over every profile;
    // document.title stays the board's own.
    var n = state === 'view' ? pendingOf(edit).length : 0;
    return '<header class="pf-head">' +
      '<div class="pf-head-l"><p class="pf-kicker">[프로필·에이전트]</p><h1 class="pf-title">프로필·에이전트' +
      (n ? '<span class="pf-title-n">' + esc(' · ' + STATUS_TEXT.pending + ' ' + n) + '</span>' : '') + '</h1>' +
      '<p class="pf-sub">WinForms 스위처의 역할 배치와 모델 레인, <span class="pf-keep">메모리 행을 확인하고</span>, <span class="pf-keep">실시간 상황판</span>에서 바로 적용합니다.</p></div>' +
      '<div class="pf-head-r">' + badge + '</div></header>';
  }

  // WinForms status panel (PS:4069-4140): 현재 전역 적용 and the active profile, 전역 적용 중, the read-only banner when
  // writes are refused, and 권장 배치 가이드 at the right end.
  function statusStrip(view, edit, ro, stale) {
    var p = profileOf(view, str(obj(view.activeProfile) && view.activeProfile.key));
    return '<section class="pf-status" data-flow="status" aria-label="현재 전역 적용">' +
      '<div class="pf-status-l"><span class="pf-status-c">현재 전역 적용</span><b class="pf-status-v">' + esc(p ? cardTitle(p) : '선택 없음') + '</b></div>' +
      '<div class="pf-status-m">' + (p ? chip('pf-c-green', 'current') : '') +
      (stale ? banner(STALE_BANNER, 'pf-banner-warn', 'alert') : ro ? readOnlyNote(edit, view) : '') + '</div>' +
      '<div class="pf-status-r"><span class="pf-status-c">공식 권장 기준</span>' +
      button('guide-open', attr('data-flow', 'guide') + ' aria-haspopup="dialog" aria-label="OMO 공식 권장 배치 가이드 열기"', '권장 배치 가이드', false, 'pf-btn') +
      '</div></section>';
  }
  function shownKeyOf(view, edit) {
    return str(edit && edit.shown) || str(obj(view && view.activeProfile) && view.activeProfile.key);
  }
  function profileOf(view, key) {
    var found = null;
    arr(view && view.profiles).forEach(function (p) { if (obj(p) && p.key === key) found = p; });
    return found;
  }
  function cardTitle(p) { return (num(p.num) === null ? '' : p.num + '. ') + str(p.name || p.key); }

  function homes(view) {
    var h = obj(view && view.homes) || {};
    var line = function (tagName, value, cls) {
      return '<span class="pf-home ' + (cls || '') + '">' + tag(tagName) + ' <code title="' + esc(value || STATUS_TEXT.none) + '">' + esc(value || STATUS_TEXT.none) + '</code></span>';
    };
    var mirrors = arr(h.mirrors).map(function (m, i) {
      var label = 'mirror ' + (i + 1);
      return '<span class="pf-home' + (m && m.exists === false ? ' pf-home-off' : '') + '">' + tag(label, m && m.exists === false ? '이 미러의 omo.jsonc가 없음' : str(m && m.label)) +
        ' <code title="' + esc(m && m.root) + '">' + esc(m && m.root) + '</code>' + (m && m.exists === false ? ' <span class="pf-off">[' + esc(STATUS_TEXT.none) + ']</span>' : '') + '</span>';
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
  function secHead(key, count, extra, subOverride, tagName) {
    var meta = null;
    SECTIONS.forEach(function (s) { if (s[0] === key) meta = s; });
    var title = meta ? meta[1] : key, sub = typeof subOverride === 'string' ? subOverride : meta ? meta[2] : '';
    var t = tagName || 'header';
    return '<' + t + ' class="pf-sec-h"><div class="pf-sec-t">' + tag(title) + '<h2>' + esc(title) + '</h2>' +
      (sub ? '<p class="pf-sec-s">' + esc(sub) + '</p>' : '') + '</div>' +
      '<div class="pf-sec-r">' + (count === null ? '' : '<span class="pf-count">' + count + '</span>') + (extra || '') + '</div></' + t + '>';
  }
  function section(key, body, count, extra, subOverride, attrs) {
    return '<section class="pf-sec" id="pf-sec-' + esc(key) + '"' + attr('data-pf-sec', key) + (attrs || '') + '>' +
      secHead(key, count, extra, subOverride) + '<div class="pf-sec-b">' + body + '</div></section>';
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
    var busy = !!(edit && edit.busy === true);
    var rows = AGENTS.map(function (pair) {
      var id = pair[0], name = idOf(AGENTS, id);
      var agent = obj(agents[id]) || {};
      var backupProfile = profileOf(view, shownKeyOf(view, edit));
      var backupId = 'pf-primary-backup-' + id;
      var backupEntries = id === 'hephaestus' ? entries.filter(function (e) { return bareModel(e.model).indexOf('gpt-') === 0; }) : entries;
      var backup = backupFields(edit, backupProfile, 'primary', id, view.primaryBackups && view.primaryBackups[id], backupEntries, backupId, '');
      var backupAlias = backup.summary;
      var backupControl = ro ? '<p class="pf-note">백업: ' + esc(backupAlias || '없음') + '</p>' :
        backup.html;
      var laneChange = agentChange(pending, id, 'setAgentLane');
      var pinChange = agentChange(pending, id, 'setAgentPin');
      var reset = agentChange(pending, id, 'resetAgentMemory');
      var draft = draftOf(edit, 'agent:' + id);
      var lane = laneChange ? str(laneChange.lane) : str(agent.lane) || (id === 'hephaestus' ? 'geeky-normal' : id === 'prometheus' ? 'daily-heavy' : 'daily-normal');
      var pin = pinChange ? pinChange.pin : agent.pin;
      pin = obj(pin) ? pin : null;
      var remembered = obj(agent.remembered) || obj(agent.memory) || null;
      var pinEntry = pin ? entryOf(entries, '', str(pin.provider) + '/' + bareModel(pin.modelId)) : null;
      var pinProvider = draft && has(draft, 'provider') ? str(draft.provider) : pin ? pinEntry ? providerOf(pinEntry.model) : str(pin.provider) : '';
      var pinModel = pin ? pinEntry ? bareModel(pinEntry.model) : bareModel(pin.modelId) : '';
      var pinValue = draft && has(draft, 'pin') ? str(draft.pin) : pin ? pinProvider + '|' + pinModel : '';
      var pinThinking = draft && has(draft, 'thinking') ? str(draft.thinking) : pin ? str(pin.thinking) : 'medium';
      var pinEntries = id === 'hephaestus' ? entries.filter(function (e) { return bareModel(e.model).indexOf('gpt-') === 0; }) : entries;
      var pinPool = [{ value: '', placeholder: true, selected: !pinValue, text: '핀 없음 (레인 사용)' }];
      var pinSeen = map();
      pinEntries.forEach(function (e) {
        if (pinProvider && providerOf(e.model) !== pinProvider) return;
        var value = providerOf(e.model) + '|' + bareModel(e.model);
        if (has(pinSeen, value)) return;
        pinSeen[value] = true;
        pinPool.push({ value: value, model: e.model, provider: providerOf(e.model), selected: value === pinValue, off: e.off });
      });
      if (pinValue && !has(pinSeen, pinValue)) {
        pinPool.push({ value: pinValue, model: pinValue.replace('|', '/'), selected: true, missing: true });
      }
      var mem = remembered ? str(remembered.provider) + ' · ' + str(remembered.modelId) + (str(remembered.thinking) ? ' / ' + str(remembered.thinking) : '') : '';
      var laneId = 'pf-agent-lane-' + id;
      var controls = ro
        ? '<span class="pf-lbl">레인</span><span class="pf-ro-val">' + esc(lane) + '</span>'
        : labelled('레인', laneId, select('agent-lane', withId(laneId, ' data-agent="' + esc(id) + '"'), laneOptions(lane), busy));
      var pinId = 'pf-agent-pin-' + id, pinThinkId = 'pf-agent-pin-thinking-' + id;
      var pinFull = pinValue.replace('|', '/');
      var pinHint = id === 'hephaestus' ? 'GPT 계열만' : '';
      var pinControls = ro
        ? '<span class="pf-lbl">핀</span><span class="pf-ro-val">' + (pin ? esc(pinProvider + ' · ' + pinModel + ' / ' + pinThinking) : '없음') + '</span>'
        : '<div class="pf-tri">' +
          labelled(CAPTIONS[0], 'pf-agent-provider-' + id, providerSelect('agent-provider', withId('pf-agent-provider-' + id, attr('data-agent', id)), providersOf(pinEntries, pinProvider), pinProvider, busy)) +
          labelledHint(CAPTIONS[1], pinHint, pinId, select('agent-pin', withId(pinId, ' data-agent="' + esc(id) + '"') + modelDescription(pinId), modelOptions(pinPool), busy, pinFull || '핀 없음 (레인 사용)')) +
          labelled(CAPTIONS[2], pinThinkId, select('agent-pin-thinking', withId(pinThinkId, ' data-agent="' + esc(id) + '"'), memoryThinkingOptions(memoryCandidates(view), pinValue.replace('|', '/'), pinThinking), busy || !pinValue)) +
          '</div>' + fullIdLine(pinId, pinFull, (entryOf(entries, '', pinFull) || {}).alias);
      var resetBtn = ro ? '<span class="pf-muted">기억은 확장이 관리</span>' : button('reset-memory', ' data-agent="' + esc(id) + '"', '기억 초기화', busy, 'pf-btn pf-btn-ghost');
      if (reset && !ro) resetBtn = button('reset-memory', ' data-agent="' + esc(id) + '"', STATUS_TEXT.pending, busy, 'pf-btn pf-btn-ghost on');
      var effective = obj(agent.effective) || {};
      var effectiveEntry = entryOf(entries, '', str(effective.provider) + '/' + str(effective.modelId));
      if (!searchMatch(edit, [id, name, effective.provider, effective.modelId, effectiveEntry && effectiveEntry.alias,
        pinProvider, pinModel, pinEntry && pinEntry.alias])) return '';
      var origin = str(effective.origin) || 'unknown';
      var originLabel = { main: 'Main', pin: 'Pin', memory: 'Memory', lane: 'Lane', unavailable: 'Unavailable', unknown: 'Unknown' }[origin] || origin;
      var reason = str(effective.reason);
      var savedText = str(effective.modelId) ? modelText(entries, str(effective.provider) + '/' + effective.modelId) +
        (str(effective.thinking) ? ' / ' + effective.thinking : '') : reason || STATUS_LABEL.unknown;
      var mainValues = id === 'sisyphus' ? mainValuesOf(view, edit) : null;
      var staged = !!(laneChange || pinChange || reset || draft || (mainValues && (mainValues.pending || mainValues.draft)));
      var summaryText = savedText;
      if (mainValues && (mainValues.pending || mainValues.draft)) {
        summaryText = modelText(entries, mainValues.provider + '/' + mainValues.model) + ' / ' + (mainValues.thinking || STATUS_TEXT.none);
      } else if (id !== 'sisyphus' && (pinChange || draft)) {
        summaryText = pinValue ? modelText(pinEntries, pinFull) + ' / ' + pinThinking : '핀 없음 (레인 사용) · ' + lane;
      }
      if (laneChange) summaryText += ' · ' + lane;
      if (reset) summaryText += ' · 기억 초기화';
      var editorId = 'pf-agent-' + id + '-editor';
      var open = str(edit && edit.openRow) === 'agent:' + id;
      var main = obj(view.main) || {};
      var mainThinking = str(obj(main.effective) && main.effective.thinking);
      var settingsThinking = str(view.mainSettingsThinking);
      var mismatch = id === 'sisyphus' && has(view, 'mainSettingsThinking') && mainThinking && settingsThinking !== mainThinking
        ? chip('pf-c-amber', STATUS_TEXT.thinkingMismatch + ' · settings: ' + (settingsThinking || STATUS_TEXT.none) + ' / sidecar: ' + mainThinking) : '';
      return '<article class="pf-agent pf-route" data-pf-agent="' + esc(id) + '">' +
        '<button type="button" class="pf-row-sum" data-pf="row-toggle"' + attr('data-row', 'agent:' + id) +
        ' aria-expanded="' + open + '"' + attr('aria-controls', editorId) + '>' +
        '<span class="pf-row-sum-r"><span class="pf-dot pf-dot-' + esc(id) + ' pf-shape-' + esc(SHAPES[id]) + '" role="img" aria-label="' +
        esc(name + ' · ' + SHAPE_KO[SHAPES[id]] + ' 표식') + '"></span>' +
        ' <span class="pf-agent-n">' + esc(name) + '</span></span>' +
        '<span class="pf-row-sum-m">' + esc(summaryText) + '<span class="pf-backup-summary">백업: ' + esc(backupAlias || '없음') + '</span>' +
        (staged ? '<span data-pf-saved> · effective: ' + esc(savedText + ' · ' + originLabel) + '</span>' : '') + '</span>' +
        '<span class="pf-row-sum-o">' + chip(reason ? 'pf-c-amber' : 'pf-c-gray', originLabel) +
        (staged ? chip('pf-c-amber', STATUS_TEXT.pending) : '') +
        (id === 'sisyphus' && obj(agent.pin) && origin !== 'pin' ? chip('pf-c-amber', 'Pin') : '') +
        (reason ? chip('pf-c-amber', reason) : '') + mismatch + '</span></button>' +
        '<div class="pf-agent-editor"' + withId(editorId, boolAttr('hidden', !open)) + '>' +
        '<p class="pf-note">공통 설정 · 모든 프로필에 적용됩니다.' + (id === 'sisyphus' ? ' 메인 모델과 같은 설정을 편집합니다.' : '') + '</p>' +
        (id === 'sisyphus' ? mainModel(view, edit, ro, 'pf-sisyphus') : pinControls) +
        backupControl +
        '<div class="pf-agent-fields">' +
        '<div class="pf-field">' + controls + '</div>' +
        '<div class="pf-field pf-mem-field"><span class="pf-lbl">기억</span><div class="pf-mem-line">' +
        '<span class="pf-ro-val pf-mem">' + valueOrDash(mem) + '</span>' + resetBtn + '</div>' +
        '<span class="pf-muted">' + esc(remembered && remembered.updatedAt || '기억 시각 없음') + '</span></div></div></div></article>';
    }).join('');
    return '<section class="pf-group" id="pf-sec-agents" data-pf-sec="agents" data-flow-sec="primary">' +
      '<h3 class="pf-group-h">' + esc(idOf(ROUTING_TABS, 'primary')) + ' <span class="pf-count">' + (rows.match(/data-pf-agent=/g) || []).length + '</span>' +
      (roster.warning ? chip('pf-c-amber', STATUS_TEXT.rosterWarning) : '') + '</h3>' + rows + '</section>';
  }

  // A card's main model as WinForms builds it for every card (Get-MainComboCurrentValues, PS:2489-2518, PS:6086-6094):
  // the profile default, replaced by the saved override, replaced by that profile's pending main change, and a pending
  // removal (the store's empty setMain) shows the default again. A value the engine refuses keeps the store's verdict
  // as a flag, decided as the detail's main heading decides it (IS-6).
  function cardMainOf(view, edit, p, entries) {
    var detail = obj(view && view.details) ? obj(view.details[p.key]) : null;
    var saved = obj(detail && detail.main) || {};
    var pending = mainChangeOf(pendingOf(edit), p);
    var profileDefault = { provider: p.mainProvider, model: p.mainModel, thinking: p.mainThinking };
    var value = pending ? (str(pending.provider) && str(pending.model) && str(pending.thinking) ? pending : profileDefault)
      : obj(saved.override) || profileDefault;
    var shown = { provider: str(value.provider), model: str(value.model), thinking: str(value.thinking) };
    var entry = entryOf(entries, '', shown.provider + '/' + shown.model);
    shown.off = entry ? entry.off : !pending ? unservedOf(saved) : null;
    return shown;
  }

  // WinForms New-ProfileCard (PS:7067-7205), one card per row: the main button only shows the profile (aria-pressed =
  // shown), 적용 is a separate button beside it (never nested) and 적용 중 marks the globally active profile.
  function profileCards(view, edit, ro) {
    var busy = !!(edit && edit.busy === true);
    var conflict = !!(edit && edit.conflict === true);
    var activeKey = str(obj(view && view.activeProfile) && view.activeProfile.key);
    var shown = shownKeyOf(view, edit);
    var list = arr(view && view.profiles);
    var entries = catalogEntries(view);
    var cards = list.map(function (p) {
      if (!obj(p)) return '';
      var on = p.key === shown;
      var cardMain = cardMainOf(view, edit, p, entries);
      var body = '<span class="pf-card-top"><span class="pf-card-num">' + esc(num(p.num) === null ? '' : p.num) + '</span>' +
        '<span class="pf-card-name">' + esc(p.name || p.key) + '</span></span>' +
        '<span class="pf-card-en">' + esc(p.name || '') + '</span>' +
        '<span class="pf-card-tag">' + tag(p.tag || 'profile') + '</span>' +
        '<span class="pf-card-sum">' + summaryText(p.summary || '') + '</span>' +
        // A refused value is flagged inside its own line (warning glyph and colour, the reason as title and name): the
        // detail's chip does not fit a card line at 1180x700, and an extra line would push the cards below it down.
        '<span class="pf-card-main' + (cardMain.off ? ' pf-card-off"' + attr('title', offTitle(cardMain.off)) : '"') + '>' +
        (cardMain.off ? '<span class="pf-card-flag" role="img"' + attr('aria-label', offText(cardMain.off)) + '>' + ic('info', 'ic-sm') + '</span> ' : '') +
        esc('메인: ' + cardMain.model + ' / ' + cardMain.thinking) + '</span>' +
        '<span class="pf-card-svc">' + esc('서비스: ' + cardMain.provider) + '</span>';
      var main = ro ? '<div class="pf-card-b">' + body + '</div>'
        : '<button type="button" class="pf-card-b"' + attr('data-pf', 'select-profile') + attr('data-profile', p.key) +
          attr('data-flow', 'card:' + p.key) + ' aria-pressed="' + on + '"' + boolAttr('disabled', busy) + '>' + body + '</button>';
      return '<article class="pf-card' + (on ? ' on' : '') + '">' + main + (p.key === activeKey ? currentChip() : '') +
        (ro ? '' : button('apply-card', attr('data-profile', p.key) + attr('data-flow', 'apply:card:' + p.key) +
          attr('aria-label', cardTitle(p) + ' 적용'), '적용', busy || conflict, 'pf-btn pf-btn-primary pf-card-apply')) + '</article>';
    }).join('');
    return section('profiles', '<div class="pf-cards">' +
      (cards || emptyState('프로필이 없습니다. omo.jsonc의 프로필을 확인한 뒤 상태를 다시 불러와 주십시오.', edit)) + '</div>', list.length, '',
    list.length + '개 프로필 · ' + (shown ? '현재 선택' : '선택 없음'), attr('data-flow', 'cards'));
  }

  // One WinForms New-RoutingRow (PS:5595-5785): the label line keeps the recommendation chip, then the three captions
  // over three equal-width selects. The effort list holds only the chosen model's served levels.
  function routeRow(r, profile, entries, candidates, edit, ro) {
    var key = str(r.section) + '/' + str(r.role);
    var busy = !!(edit && edit.busy === true);
    var change = routeChangeOf(pendingOf(edit), profile, r.section, r.role);
    var draft = draftOf(edit, 'route:' + key);
    var alias = str(r.model);
    var entry = entryOf(entries, alias);
    // The guide and the row show the same resolved category assignment. Selecting
    // an override still creates an explicit alias; unresolved links remain empty.
    var linked = !change && !draft && !alias && obj(r.linked) && r.linked.active && r.linked.effective && str(r.linked.modelId) ? r.linked : null;
    var full = change ? str(change.model) : draft ? str(draft.model) : entry ? entry.model : linked ? str(linked.modelId) : alias;
    var provider = change ? str(change.provider) : draft ? str(draft.provider) : providerOf(full);
    var thinking = change ? str(change.thinking) : draft ? str(draft.thinking) : linked ? str(linked.thinking) : str(r.reasoning) || entry && entry.variant || '';
    var searchEntry = entryOf(entries, '', full);
    if (!searchMatch(edit, [r.role, r.labelEn, r.labelKo, provider, full, alias, searchEntry && searchEntry.alias])) return '';
    // The shown model's reason; a saved value outside the catalog keeps the row's own verdict from the store.
    var shownEntry = entryOf(entries, '', full);
    var off = shownEntry ? shownEntry.off : !change && !draft ? unservedOf(r) : null;
    var rec = recommendationOf(r);
    var rid = 'pf-route-' + slug(r.section + '-' + r.role);
    var backup = backupFields(edit, profile, r.section, r.role, r.backup, entries, rid + '-backup', alias);
    var backupAlias = backup.summary;
    var editId = rid + '-editor';
    var open = str(edit && edit.openRow) === 'route:' + key;
    var on = function (part) { return attr('data-route', key) + attr('data-flow', 'role:' + key + ':' + part); };
    var fields = ro || r.readOnly === true || !!r.absentIn
      ? '<span class="pf-ro-val"' + withId(editId, boolAttr('hidden', !open)) + '>' + valueOrDash(provider) + ' · ' + valueOrDash(bareModel(full)) + ' / ' + valueOrDash(thinking) + '</span>'
      : '<div class="pf-tri"' + withId(editId, boolAttr('hidden', !open)) + '>' +
        labelled(CAPTIONS[0], rid + '-provider', providerSelect('route-provider', withId(rid + '-provider', on('service')), providersOf(entries, provider), provider, busy)) +
        labelled(CAPTIONS[1], rid + '-model', modelSelect('route-model', withId(rid + '-model', on('model')) + modelDescription(rid + '-model'), entries, provider, full, busy)) +
        labelled(CAPTIONS[2], rid + '-thinking', select('route-thinking', withId(rid + '-thinking', on('effort')), memoryThinkingOptions(candidates, full, thinking), busy)) +
        fullIdLine(rid + '-model', full, alias) + backup.html +
        '</div>';
    var sumModel = '<span class="pf-row-primary"' + attr('title', full + (thinking ? ' / ' + thinking : '')) + '>' +
      valueOrDash(modelText(entries, full)) + (str(thinking) ? ' / ' + esc(thinking) : '') + '</span>' +
      '<span class="pf-backup-summary"' + attr('title', '백업: ' + (backupAlias || '없음')) + '>백업: ' + esc(backupAlias || '없음') + '</span>';
    var stateLabel = r.absentIn ? STATUS_TEXT.absent + ': ' + str(r.absentIn) : str(r.stateLabel);
    var sumOrigin = !change && !draft && (rec.status === 'unresolved' || (alias && !entry))
      ? chip('pf-c-amber', MEMORY_STATUS_LABEL.skippedUnresolved)
      : (stateLabel ? chip('pf-c-amber', stateLabel) : linked ? chip('pf-c-gray', 'LINKED')
        : !change && !draft && !alias && obj(r.linked) && r.linked.active
          ? chip('pf-c-amber', 'Unavailable')
          : chip('pf-c-gray', change || draft ? STATUS_TEXT.override : STATUS_TEXT.profile)) + offChip(off);
    var sumBtn = '<button type="button" class="pf-row-sum" data-pf="row-toggle"' + attr('data-row', 'route:' + key) +
        ' aria-expanded="' + (open ? 'true' : 'false') + '"' + attr('aria-controls', editId) + '>' +
        '<span class="pf-row-sum-r">' + esc(r.role) + (r.labelEn && r.labelEn !== r.role ? ' · ' + esc(r.labelEn) : '') + '</span>' +
        '<span class="pf-row-sum-m">' + sumModel + '</span>' +
        '<span class="pf-row-sum-o">' + sumOrigin + '</span></button>';
    return '<div class="pf-route" data-pf-route="' + esc(key) + '">' + sumBtn +
      '<div class="pf-route-id">' + tag(r.section === 'agents' ? 'agent' : 'category') +
      '<span class="pf-route-ko">' + esc(r.labelEn || r.role) + '</span>' +
      '<span class="pf-route-en">' + esc(r.labelEn || r.role) + '</span>' +
      (linked ? chip('pf-c-gray', 'LINKED') : '') +
      (stateLabel ? chip('pf-c-amber', stateLabel) : '') + offChip(off) + chip('pf-st-' + knownStatus(rec.status), rec.label) +
      (rec.official ? '<span class="pf-rec-off">' + esc(rec.official) + '</span>' : '') + '</div>' + fields + '</div>';
  }
  // The role sections of the WinForms routing box (PS:6213-6260) in their fixed order, whatever order the rows arrive in.
  function routingRows(view, edit, ro, sectionId) {
    var rows = arr(obj(view && view.routing) && view.routing.rows).filter(obj);
    var profile = profileOf(view, shownKeyOf(view, edit));
    var entries = catalogEntries(view);
    var candidates = memoryCandidates(view);
    var html = '';
    ROLE_SECTIONS.forEach(function (sec) {
      if (sectionId && sec[0] !== sectionId) return;
      var mine = rows.filter(function (r) { return r.section === sec[0]; });
      if (!mine.length) return;
      var order = sec[2].slice();
      mine.forEach(function (r) { if (str(r.group) !== 'extras' && order.indexOf(str(r.group)) < 0) order.push(str(r.group)); });
      order.push('extras');
      html += '<h3 class="pf-rh">' + esc(sec[1]) + '</h3>';
      order.forEach(function (group) {
        var list = mine.filter(function (r) { return str(r.group) === group; });
        if (!list.length) return;
        var rendered = list.map(function (r) { return routeRow(r, profile, entries, candidates, edit, ro); }).join('');
        var count = (rendered.match(/data-pf-route=/g) || []).length;
        if (!count) return;
        html += '<section class="pf-group"' + attr('data-flow-sec', sec[0] + ':' + (has(FLOW_GROUP, group) ? FLOW_GROUP[group] : group)) + '>' +
          '<h4 class="pf-group-h">' + esc(group) +
          ' <span class="pf-count">' + count + '</span></h4>' + rendered + '</section>';
      });
    });
    return html || emptyState('배치할 역할이 없습니다. 프로필 설정을 확인한 뒤 상태를 다시 불러와 주십시오.', edit);
  }
  // The Oracle advisors of agent/oracle-advisor/routing.json, shared by every profile. A consult runs on the advisor
  // the main agent names or the routing table resolves; with neither, it runs on the oracle row above. Each advisor
  // is offered only its own family's models, so a Claude advisor stays Claude and a GPT advisor stays GPT.
  function advisorFamily(model) {
    var bare = bareModel(model).toLowerCase();
    return bare.indexOf('claude') >= 0 ? 'claude' : bare.indexOf('gpt-') === 0 ? 'gpt' : 'other';
  }
  function advisorRows(view, edit, ro) {
    var adv = obj(view && view.advisors);
    var rows = arr(adv && adv.rows).filter(obj);
    if (!rows.length) return '';
    var busy = !!(edit && edit.busy === true);
    var all = memoryRowCandidates(view, true);
    var rendered = rows.map(function (r) {
      var name = str(r.name);
      var change = findChange(pendingOf(edit), function (c) { return c && c.kind === 'setAdvisor' && c.advisor === name; });
      var draft = draftOf(edit, 'advisor:' + name);
      var model = change ? str(change.model) : draft ? str(draft.model) : str(r.model);
      var provider = change ? str(change.provider) : draft ? str(draft.provider) : providerOf(model);
      var thinking = change ? str(change.thinking) : draft ? str(draft.thinking) : str(r.thinking);
      if (!searchMatch(edit, ['oracle', 'advisor', name, r.family, provider, model])) return '';
      var candidates = all.filter(function (c) { return advisorFamily(c.model) === str(r.family); });
      var off = !change && !draft ? unservedOf(r) : null;
      var rid = 'pf-advisor-' + slug(name);
      var editId = rid + '-editor';
      var open = str(edit && edit.openRow) === 'advisor:' + name;
      var on = function (part) { return attr('data-advisor', name) + attr('data-flow', 'advisor:' + name + ':' + part); };
      var fields = ro
        ? '<span class="pf-ro-val"' + withId(editId, boolAttr('hidden', !open)) + '>' + valueOrDash(provider) + ' · ' + valueOrDash(bareModel(model)) + ' / ' + valueOrDash(thinking) + '</span>'
        : '<div class="pf-tri"' + withId(editId, boolAttr('hidden', !open)) + '>' +
          labelled(CAPTIONS[0], rid + '-provider', select('advisor-provider', withId(rid + '-provider', on('service')), memoryServiceOptions(candidates, provider), busy)) +
          labelled(CAPTIONS[1], rid + '-model', select('advisor-model', withId(rid + '-model', on('model')) + modelDescription(rid + '-model'), memoryModelOptions(candidates, provider, model), busy, model || '(선택)')) +
          labelled(CAPTIONS[2], rid + '-thinking', select('advisor-thinking', withId(rid + '-thinking', on('effort')), memoryThinkingOptions(candidates, model, thinking), busy)) +
          fullIdLine(rid + '-model', model, '') + '</div>';
      var familyLabel = str(r.family) === 'claude' ? 'Claude 계열만' : str(r.family) === 'gpt' ? 'GPT 계열만' : str(r.family);
      var sumBtn = '<button type="button" class="pf-row-sum" data-pf="row-toggle"' + attr('data-row', 'advisor:' + name) +
        ' aria-expanded="' + (open ? 'true' : 'false') + '"' + attr('aria-controls', editId) + '>' +
        '<span class="pf-row-sum-r">' + esc('oracle · ' + name) + '</span>' +
        '<span class="pf-row-sum-m"><span class="pf-row-primary"' + attr('title', model + (thinking ? ' / ' + thinking : '')) + '>' +
        valueOrDash(modelText(candidates, model)) + (thinking ? ' / ' + esc(thinking) : '') + '</span></span>' +
        '<span class="pf-row-sum-o">' + chip('pf-c-gray', change || draft ? STATUS_TEXT.override : familyLabel) + offChip(off) + '</span></button>';
      return '<div class="pf-route"' + attr('data-pf-advisor', name) + '>' + sumBtn +
        '<div class="pf-route-id">' + tag('advisor') + '<span class="pf-route-ko">' + esc('Oracle 자문가 · ' + name) + '</span>' +
        '<span class="pf-route-en">' + esc(familyLabel) + '</span>' + offChip(off) + '</div>' + fields + '</div>';
    }).join('');
    if (!rendered) return '';
    return '<section class="pf-group" data-flow-sec="agents:advisors"><h4 class="pf-group-h">오라클 자문가 · 모든 프로필 공통 <span class="pf-count">' +
      (rendered.match(/data-pf-advisor=/g) || []).length + '</span></h4>' +
      '<p class="pf-note"><span class="pf-keep">메인이 자문가를 지정하거나</span> <span class="pf-keep">자문 배분표가 고르면</span> <span class="pf-keep">이 모델로 자문합니다.</span> ' +
      '<span class="pf-keep">둘 다 없으면</span> <span class="pf-keep">위 oracle 역할 모델을 씁니다.</span></p>' +
      rendered + '</section>';
  }
  function mainValuesOf(view, edit) {
    var pending = mainChangeOf(pendingOf(edit), profileOf(view, shownKeyOf(view, edit)));
    var draft = draftOf(edit, 'main');
    var current = obj(view && view.main) || {};
    var effective = obj(current.effective) || {};
    var override = obj(current.override) || null;
    return {
      pending: pending, draft: draft, current: current, effective: effective, override: override,
      provider: draft ? str(draft.provider) : pending ? str(pending.provider) : str(override && override.provider) || str(effective.provider),
      model: draft ? str(draft.model) : pending ? str(pending.model) : str(override && override.model) || str(effective.model),
      thinking: draft ? str(draft.thinking) : pending ? str(pending.thinking) : str(override && override.thinking) || str(effective.thinking)
    };
  }
  function mainModel(view, edit, ro, inlineId) {
    var values = mainValuesOf(view, edit);
    var pending = values.pending, draft = values.draft, current = values.current, effective = values.effective, override = values.override;
    var provider = values.provider, model = values.model, thinking = values.thinking;
    var busy = !!(edit && edit.busy === true);
    var prefix = inlineId || 'pf-main';
    var entries = catalogEntries(view);
    var providers = providersOf(entries, provider);
    // WinForms Update-MainThinkingCombo: the effort list holds only the provider-qualified model's levels and shows
    // the clamped effort; without such an entry the seven-level list stays. The box keeps the saved-or-pending
    // effort the cascade clamps from (WinForms MainComboCommitted), which the shown clamp may differ from.
    // An unserved model (the heading's flag) keeps that list, but disabled on the saved effort: the select cannot
    // stage that model (IS-6), and a role row offers no other effort for it either. A saved model outside the catalog
    // keeps the main's own verdict from the store, as a role row's does.
    var entry = entryOf(entries, '', provider + '/' + model);
    var off = entry ? entry.off : !pending && !draft ? unservedOf(current) : null;
    var levels = entry && !entry.off && Array.isArray(entry.levels) && entry.levels.length ? entry.levels : null;
    var body;
    if (!effective.provider && !override && !pending) {
      body = emptyNote('현재 프로필의 메인 모델 정보가 없습니다.');
    } else if (ro) {
      body = '<span class="pf-main-v">' + valueOrDash(provider) + ' · ' + valueOrDash(model) + ' / ' + valueOrDash(thinking) + '</span>';
    } else {
      body = '<div class="pf-tri" data-pf-main' + attr('data-thinking', thinking) + '>' +
        labelled(CAPTIONS[0], prefix + '-provider', providerSelect('main-provider', withId(prefix + '-provider', ' data-main="1"'), providers, provider, busy)) +
        labelled(CAPTIONS[1], prefix + '-model', mainModelSelect('main-model', withId(prefix + '-model', ' data-main="1"') + modelDescription(prefix + '-model'), entries, provider, model, busy)) +
        labelled(CAPTIONS[2], prefix + '-thinking', select('main-thinking', withId(prefix + '-thinking', ' data-main="1"'),
          levels ? thinkingOptions(clampedThinking(entry, thinking), false, levels) : thinkingOptions(thinking, true),
          busy || !!off)) +
        fullIdLine(prefix + '-model', model ? provider + '/' + model : '', entry && entry.alias) + '</div>';
    }
    if (inlineId) return body;
    return '<div class="pf-blk" id="pf-sec-main" data-pf-sec="main" data-flow="main" data-flow-sec="main"><h3 class="pf-blk-h">메인 모델 설정 ' +
      (override ? chip('pf-c-green', STATUS_TEXT.override) : chip('pf-c-gray', STATUS_TEXT.profile)) + offChip(off) + '</h3>' + body + '</div>';
  }

  function modelLane(view, edit, ro) {
    var pending = laneChangeOf(pendingOf(edit), profileOf(view, shownKeyOf(view, edit)));
    var busy = !!(edit && edit.busy === true);
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
        (selection === 'custom-literal' ? chip('pf-c-amber', selection) : '') + '</div>'
      : '<div class="pf-lane" data-pf-lane>' +
        labelled('model_profile', 'pf-lane-select', select('lane-select', withId('pf-lane-select', ' data-lane="1"'), options, busy)) +
        labelled('직접 입력 값', 'pf-lane-literal', textInput('lane-literal', withId('pf-lane-literal', ' data-lane="1"'), literal, busy || selection !== 'custom-literal', '예: custom-literal-id'), 'pf-field-grow') + '</div>';
    var rec = laneRecommendation(view, selection === 'custom-literal' ? literal : selection);
    return '<div class="pf-blk" id="pf-sec-lanes" data-pf-sec="lanes" data-flow="lane" data-flow-sec="lane">' + body +
      (rec ? '<p class="pf-note pf-lane-rec">' + esc(rec) + '</p>' : '') + '</div>';
  }
  // WinForms Get-ModelProfileRecommendation (PS:2466-2487) from the model_profile data the state already carries.
  function laneRecommendation(view, active) {
    var mp = obj(view && view.modelProfile) || {};
    var custom = obj(mp.model_profiles) && has(mp.model_profiles, active) ? obj(mp.model_profiles[active]) : null;
    var main = obj(obj(view && view.main) && view.main.effective);
    if (!active || active === 'off') return main ? 'off: ' + str(main.provider) + '/' + str(main.model) + ' / ' + str(main.thinking) : '';
    if (active.indexOf('/') >= 0) return active;
    return custom ? active + ' : ' + jsonText(custom) : active;
  }

  function summarizer(view, edit, ro) {
    var pending = firstOf(pendingOf(edit), 'setSummarizer');
    var d = draftOf(edit, 'summarizer');
    var busy = !!(edit && edit.busy === true);
    var s = obj(view && view.summarizer) || null;
    var savedModel = s && str(s.provider) && str(s.model) ? str(s.provider) + '/' + str(s.model) : '';
    var savedProvider = s && str(s.provider) ? str(s.provider) : providerOf(savedModel);
    var current = pending ? str(pending.modelId) : d && has(d, 'model') ? str(d.model) : savedModel;
    var provider = pending ? providerOf(str(pending.modelId)) : d && has(d, 'provider') ? str(d.provider) : (current ? providerOf(current) : savedProvider);
    var entries = catalogEntries(view);
    var shownEntry = entryOf(entries, '', current);
    var warnings = summarizerWarnings(current);
    var body = ro
      ? '<span class="pf-ro-val">' + valueOrDash(current || '원본 기본 컴팩션') + '</span>'
      : '<div class="pf-sum" data-pf-sum>' +
        labelled('1. 제공사', 'pf-summarizer-provider', select('summarizer-provider', withId('pf-summarizer-provider', ' data-sum="1"'), summarizerProviderOptions(entries, provider), busy)) +
        labelled('2. AI 모델', 'pf-summarizer-model', select('summarizer-model', withId('pf-summarizer-model', ' data-sum="1"') + modelDescription('pf-summarizer-model'), summarizerModelOptions(entries, provider, current), busy || !provider, current || '(선택)'), 'pf-field-grow') + '</div>' +
        fullIdLine('pf-summarizer-model', current, shownEntry && shownEntry.alias) +
        warnings.map(function (w) { return '<p class="pf-warn pf-warn-' + esc(w.level) + '">' + ic('info', 'ic-sm') + ' ' + esc(w.text) + '</p>'; }).join('');
    return '<div class="pf-blk" id="pf-sec-summarizer" data-pf-sec="summarizer" data-flow="summarizer" data-flow-sec="summarizer">' +
      '<h3 class="pf-blk-h">요약 담당 모델 ' + chip('pf-c-gray', 'compaction.model') + offChip(shownEntry && shownEntry.off) + '</h3>' + body + '</div>';
  }

  function memoryRows(view, edit, ro) {
    var busy = !!(edit && edit.busy === true);
    var mem = obj(view && view.memory) || {};
    var allEntries = catalogEntries(view);
    var candidates = memoryRowCandidates(view);
    var choices = memoryRowCandidates(view, true);
    var memErrors = obj(edit && edit.memoryErrors) || {};
    var memSaved = obj(edit && edit.memorySaved) || {};
    var rows = ['kibitzer', 'reflection'].map(function (key) {
      var m = obj(mem[key]) || {};
      var pending = memoryChangeOf(pendingOf(edit), key);
      var d = draftOf(edit, 'memory:' + key);
      var hasDraft = d !== null;
      var savedMode = str(m.mode) === 'custom' ? 'custom' : 'quick';
      var mode = pending ? str(pending.mode) : hasDraft && str(d.mode) ? str(d.mode) : savedMode;
      var quick = quickTupleOf(view, m, allEntries);
      var provider = '', model = '', reasoning = '';
      if (mode === 'quick') {
        provider = quick.provider;
        model = quick.model;
        reasoning = quick.reasoning;
      } else if (hasDraft) {
        provider = str(d.service) || (str(d.model) ? providerOf(d.model) : '');
        model = str(d.model);
        reasoning = str(d.reasoning);
      } else if (pending) {
        model = str(pending.model);
        provider = str(pending.provider) || providerOf(model);
        reasoning = str(pending.reasoning);
      } else if (savedMode === 'custom') {
        model = str(m.model);
        provider = providerOf(model);
        reasoning = str(m.reasoning);
      }
      var rowTitle = 'shared-memory · ' + (key === 'kibitzer' ? 'Kibitzer' : 'Reflection');
      var searchChoice = entryOf(choices, '', model);
      if (!searchMatch(edit, [key, rowTitle, provider, model, searchChoice && searchChoice.alias])) return '';
      var secTitle = rowTitle;
      var curCat = str(m.category) || 'quick';
      var curModel = str(m.model) || quick.model;
      var curReasoning = str(m.reasoning) || quick.reasoning;
      var currentFlags = [];
      if (m.external) currentFlags.push(STATUS_TEXT.external);
      if (m.unresolved) currentFlags.push(MEMORY_STATUS_LABEL.unresolved);
      var curLine = STATUS_TEXT.current + ': ' + curCat + ' · ' + curModel + ' / ' + curReasoning +
        (currentFlags.length ? ' (' + currentFlags.join(' / ') + ')' : '');
      var rowErr = str(memErrors[key]) || str(m.error);
      var rowSaved = !!(memSaved[key] || m.saved);
      var stateTag = rowErr ? 'failure' : (pending || hasDraft) ? 'pending' : rowSaved ? 'saved' : 'current';
      var pendLine;
      if (rowErr) {
        pendLine = STATUS_TEXT.failurePendingRetained + ': ' + rowErr;
      } else if (pending || hasDraft) {
        pendLine = STATUS_TEXT.pending + ': ' + (mode === 'quick' ? mode : (model && reasoning ? model + ' / ' + reasoning : '서비스 / 모델 / 추론 강도를 직접 선택하십시오'));
      } else if (rowSaved) {
        pendLine = STATUS_TEXT.pending + ': ' + STATUS_TEXT.none + ' · ' + STATUS_TEXT.saved + ' · 다음 대화부터 반영 (실행 중 대화는 그대로)';
      } else {
        pendLine = STATUS_TEXT.pending + ': ' + STATUS_TEXT.none + ' · ' + (key === 'kibitzer'
          ? 'Kibitzer 회상만 변경 · 다른 역할 / 성찰 / Dream / 사실 추출은 그대로'
          : 'Reflection 성찰만 변경 · 다른 역할 / Kibitzer 회상 / Dream / 사실 추출은 그대로');
      }
      var memId = 'pf-memory-' + slug(key);
      var memEditId = memId + '-editor';
      var memOpen = str(edit && edit.openRow) === 'memory:' + key;
      var controls;
      if (ro) {
        controls = '<span class="pf-ro-val"' + withId(memEditId, boolAttr('hidden', !memOpen)) + '>' + valueOrDash(mode === 'quick' ? 'quick 공유 (기본)' : '직접 선택') + ' · ' +
          valueOrDash(provider) + ' · ' + valueOrDash(model) + (reasoning ? ' / ' + esc(reasoning) : '') + '</span>';
      } else {
        var dis = busy || mode !== 'custom';
        var on = function (part) { return ' data-memory="' + esc(key) + '"' + attr('data-flow', 'memory:' + key + ':' + part); };
        // WinForms memory row: the mode spans the row, then the three captions over three equal-width selects.
        controls = '<div class="pf-mem-sels"' + withId(memEditId, ' data-pf-memory="' + esc(key) + '"' + boolAttr('hidden', !memOpen)) + '>' +
          labelled('모드', memId + '-mode', select('memory-mode', withId(memId + '-mode', on('mode')),
            '<option value="quick"' + (mode === 'quick' ? ' selected' : '') + '>quick 공유 (기본)</option>' +
            '<option value="custom"' + (mode === 'custom' ? ' selected' : '') + '>직접 선택</option>', busy)) +
          '<div class="pf-tri">' +
          labelled(CAPTIONS[0], memId + '-service', select('memory-service', withId(memId + '-service', on('service')),
            memoryServiceOptions(candidates, provider), dis)) +
          labelled(CAPTIONS[1], memId + '-model', select('memory-model', withId(memId + '-model', on('model')) + modelDescription(memId + '-model'),
            memoryModelOptions(choices, provider, model), dis, model || '(선택)')) +
          labelled(CAPTIONS[2], memId + '-thinking', select('memory-thinking', withId(memId + '-thinking', on('effort')),
            memoryThinkingOptions(candidates, model, reasoning), dis)) +
          '</div>' + fullIdLine(memId + '-model', model, searchChoice && searchChoice.alias) + '</div>';
      }
      var chips = [];
      if (m.owned) chips.push(chip('pf-c-green', STATUS_TEXT.owned));
      if (m.external) chips.push(chip('pf-c-amber', STATUS_TEXT.external));
      if (m.unresolved) chips.push(chip('pf-c-red', MEMORY_STATUS_LABEL.unresolved));
      var shownChoice = entryOf(choices, '', model);
      if (shownChoice && shownChoice.off) chips.push(offChip(shownChoice.off));
      if (m.hasDedicated) chips.push(chip('pf-c-gray', STATUS_TEXT.dedicated));
      var memSumOrigin = m.unresolved ? chip('pf-c-amber', MEMORY_STATUS_LABEL.skippedUnresolved)
        : chips.length ? chips.join('') : chip('pf-c-gray', mode);
      var memSumBtn = '<button type="button" class="pf-row-sum" data-pf="row-toggle"' + attr('data-row', 'memory:' + key) +
          ' aria-expanded="' + (memOpen ? 'true' : 'false') + '"' + attr('aria-controls', memEditId) + '>' +
          '<span class="pf-row-sum-r">' + esc(key) + ' · ' + esc(rowTitle) + '</span>' +
          '<span class="pf-row-sum-m">' + valueOrDash(modelText(choices, model)) + (str(reasoning) ? ' / ' + esc(reasoning) : '') + '</span>' +
          '<span class="pf-row-sum-o">' + memSumOrigin + '</span></button>';
      return '<section class="pf-group"' + attr('data-flow-sec', key) + '><h3 class="pf-rh">' + esc(secTitle) + '</h3>' +
        '<article class="pf-mem-row" data-pf-memory-row="' + esc(key) + '">' + memSumBtn +
        '<div class="pf-mem-id"><b>' + esc(rowTitle) + '</b>' +
        '<span class="pf-mem-cat">' + esc(curCat) + '</span>' + chips.join('') + '</div>' + controls +
        '<p class="pf-note pf-mem-cur" data-pf-memory-current="' + esc(key) + '">' + esc(curLine) + '</p>' +
        '<p class="pf-note pf-mem-pend' + (rowErr ? ' pf-err' : '') + '" data-pf-memory-pending="' + esc(key) + '"' +
        attr('data-state', stateTag) + '>' + esc(pendLine) + '</p></article></section>';
    }).join('');
    return '<div class="pf-mems" id="pf-sec-memory" data-pf-sec="memory">' + rows + '</div>';
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

  // 권장 배치 가이드 (PS Show-RecommendationGuide :6380) as an in-page dialog over data the state already carries: the
  // guide sources and each shown role's official recommendation. Nothing is fetched.
  function guideDialog(view, edit) {
    var profile = profileOf(view, shownKeyOf(view, edit));
    var headers = ['GROUP / ROLE / SCOPE', 'CURRENT', 'HELD', 'RECOMMENDED', 'LINKED', 'EFFECTIVE', 'STATUS'];
    var rows = arr(obj(view && view.guide) && view.guide.rows).filter(obj).map(function (r) {
      var current = obj(r.current) || {}, rec = obj(r.recommended) || {}, linked = obj(r.linked) || {};
      var status = str(rec.status || rec.Status) || 'untracked';
      var held = pendingOf(edit).filter(function (c) {
        if (r.group === 'routing') return (c.kind === 'setRoute' || c.kind === 'setRoleBackup') && c.section === r.section && c.role === r.role && ofProfile(c, profile);
        if (r.group === 'primary') return c.agentId === r.role ||
          (r.role === 'sisyphus' && c.kind === 'setMain' && ofProfile(c, profile));
        if (r.group === 'memory') return c.kind === 'setMemoryRow' && c.row === r.role;
        return r.group === 'summary' && c.kind === 'setSummarizer';
      });
      var name = r.labelEn || (r.group === 'primary' ? idOf(AGENTS, r.role) :
        r.group === 'memory' ? (r.role === 'kibitzer' ? 'Kibitzer' : 'Reflection') : r.role);
      var model = str(current.modelId);
      var effective = linked.active && linked.effective ? linked : current;
      var linkedText = arr(linked.candidates).join(' → ');
      var cells = [
        '<span data-guide-name>' + esc(name) + '</span><code data-guide-role>' + esc(r.role) + '</code>' +
          '<span data-guide-group>' + esc(r.group) + (r.purposeGroup ? ' / ' + esc(r.purposeGroup) : '') +
          '</span><code data-guide-scope>' + esc(r.applyScope) + '</code>',
        '<code>' + valueOrDash(current.alias) + '</code><code>' + valueOrDash(model) + '</code>' +
          '<span>' + valueOrDash(current.thinking) + '</span>' +
          (current.origin ? '<span>' + esc(current.origin) + '</span>' : '') +
          (current.sourceFile ? '<code>' + esc(current.sourceFile) + '</code>' : '') +
          (current.sourcePath ? '<code>' + esc(current.sourcePath) + '</code>' : '') +
          (current.reason ? '<span>' + esc(current.reason) + '</span>' : ''),
        held.length ? held.map(function (c) { return '<code>' + esc(JSON.stringify(c)) + '</code>'; }).join('') : '—',
        esc(rec.Official || rec.official || '공식 권장 없음'),
        linkedText ? '<span>' + esc(linkedText) + '</span><span>' +
          (linked.active ? 'active' : '별칭이 없는 경우 (the case when there is no alias)') + '</span>' +
          (linked.active ? '<code>' + esc(linked.EffectiveCategory) + ' / ' + esc(linked.EffectiveAlias) + '</code>' : '') : '—',
        '<code>' + valueOrDash(effective.modelId) + '</code><span>' + valueOrDash(effective.thinking) + '</span>' +
          '<span>' + esc(effective === linked ? 'LINKED' : current.origin || 'CURRENT') + '</span>',
        chip('pf-st-' + knownStatus(status), status)
      ];
      return '<tr' + attr('data-guide-row', r.id) + attr('data-guide-row-group', r.group) + '>' +
        cells.map(function (cell, i) {
          return '<td' + attr('data-guide-field', headers[i]) + '><span class="pf-guide-label" aria-hidden="true">' +
            headers[i] + '</span><div>' + cell + '</div></td>';
        }).join('') + '</tr>';
    }).join('');
    return '<dialog class="pf-dlg" id="pf-guide-dlg" aria-labelledby="pf-guide-t"><div class="pf-dlg-h"><b id="pf-guide-t">권장 배치 가이드</b>' +
      button('guide-close', '', ic('x', 'ic-sm') + ' 닫기', false, 'pf-btn') + '</div>' + guide(view) +
      (rows ? '<table class="pf-rec"><thead><tr>' + headers.map(function (h) { return '<th scope="col">' + h + '</th>'; }).join('') +
        '</tr></thead><tbody>' + rows + '</tbody></table>' : '') +
      '</dialog>';
  }

  // ---- pending tray, preview diff and apply result -----------------------------------------------------------------
  function diffRows(preview, view) {
    var diffs = arr(preview && preview.diffs);
    if (!diffs.length) return emptyNote('바뀌는 파일이 없습니다.');
    return diffs.map(function (d) {
      // The preview alone reproduced lexical role order. Reorder its display slots by the
      // existing routing metadata, within each JSON scope; leave the source diff and pending list intact.
      var changes = arr(d.changes).slice();
      var roles = arr(obj(view && view.routing) && view.routing.rows);
      var buckets = Object.create(null);
      changes.forEach(function (c, i) {
        var match = /^(.*)\.(agents|categories)\.([^.]+)(?:\.|$)/.exec(str(c.path));
        if (!match) return;
        var rank = roles.findIndex(function (r) { return r.section === match[2] && r.role === match[3]; });
        if (rank < 0) return;
        var key = match[1] + '.' + match[2];
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push({ change: c, index: i, rank: rank });
      });
      Object.keys(buckets).forEach(function (key) {
        var slots = buckets[key].map(function (item) { return item.index; });
        buckets[key].sort(function (a, b) { return a.rank - b.rank; }).forEach(function (item, i) {
          changes[slots[i]] = item.change;
        });
      });
      return '<details class="pf-diff" open><summary><code>' + esc(d.file) + '</code> <span class="pf-count">' + changes.length + '</span></summary><ul>' +
        changes.map(function (c) {
          return '<li><code class="pf-diff-path">' + esc(c.path) + '</code><span class="pf-diff-b">' + esc(jsonText(c.before)) +
            '</span><span class="pf-arrow" aria-hidden="true">→</span><span class="pf-diff-a">' + esc(jsonText(c.after)) + '</span></li>';
        }).join('') + '</ul></details>';
    }).join('');
  }

  // The WinForms message box (PS:4438) at the bottom: results, warnings, the preview diff, backup paths, the pending list
  // with per-row drop, the 409 block and the interrupted-apply banner. Apply and preview live at the end of the detail.
  function tray(view, edit, ro) {
    var pending = pendingOf(edit);
    var busy = edit && edit.busy === true;
    var status = str(edit && edit.status);
    var err = str(edit && edit.error);
    var conflict = !!(edit && edit.conflict);
    var preview = obj(edit && edit.preview);
    var result = obj(edit && edit.result);
    // The strip's label follows its state: pending, applied or failed, and a neutral 대기 while nothing is pending.
    var label = result ? STATUS_TEXT.applied : err || conflict ? STATUS_TEXT.failure : pending.length ? STATUS_TEXT.pending : STATUS_TEXT.idle;
    var head = ' id="pf-sec-tray" data-pf-sec="tray" data-flow="message" aria-label="메시지">';
    var tail = journalBanner(view, edit, ro) + arr(view && view.warnings).map(function (w) {
      return '<p class="pf-warn">' + ic('info', 'ic-sm') + ' ' + esc(w) + '</p>';
    }).join('');
    if (ro || (!pending.length && !busy && !status && !err && !conflict && !preview && !result)) {
      return '<section class="pf-tray pf-tray-compact"' + head + (ro ? '' :
        '<div class="pf-tray-c">' + tag(label) + ' <b>바꿀 값</b> <span class="pf-count">0</span>' +
        '<span class="pf-tray-next">위에서 값을 고르면 여기에 모입니다.</span></div>') + tail + '</section>';
    }
    var list = pending.length
      ? '<ol class="pf-pending">' + pending.map(function (c, i) {
        return '<li><span class="pf-pending-t">' + esc(changeLabel(c)) + '</span>' +
          button('drop', ' data-index="' + i + '" aria-label="이 변경 지우기" title="이 변경 지우기"', ic('x', 'ic-sm'), busy, 'pf-btn pf-btn-icon') + '</li>';
      }).join('') + '</ol>'
      : result || err ? '' : emptyNote('위에서 값을 고르면 여기에 모입니다.');
    return '<section class="pf-tray"' + head +
      '<header class="pf-sec-h"><div class="pf-sec-t">' + tag(label) + '<h2>바꿀 값</h2><p class="pf-sec-s">미리보기는 쓰지 않고, 적용만 파일을 씁니다.</p></div>' +
      '<div class="pf-sec-r"><span class="pf-count">' + pending.length + '</span>' +
      (status ? '<span class="pf-chip ' + (conflict ? 'pf-c-red' : result ? 'pf-c-green' : 'pf-c-gray') +
        '"' + attr('title', status) + attr('aria-label', status) + ' id="pf-focus-status" tabindex="-1" role="status" aria-labelledby="pf-focus-status">' + esc(status) + '</span>' : '') + '</div></header>' +
      '<div class="pf-sec-b">' + list +
      (busy ? '<p class="pf-note" role="status">' + esc(STATUS_TEXT.processing) + '</p>' : '') +
      (conflict ? '<div class="pf-conflict" role="alert"><b>' + esc(CONFLICT_TEXT) + '</b> ' +
        button('reload', ' aria-label="새로고침"', ic('refresh-cw', 'ic-sm') + ' 새로고침', false, 'pf-btn pf-btn-primary') + '</div>' : '') +
      (err && !conflict ? '<p class="pf-err" role="alert">' + errorHtml(err) + '</p>' : '') +
      (preview ? '<div class="pf-preview" data-pf-preview><p class="pf-preview-h">' + ic('file-text', 'ic-sm') + ' 파일별 차이 <span class="pf-count">' +
        arr(preview.diffs).length + '</span></p>' + diffRows(preview, detailView(view, edit)) +
        arr(preview.warnings).map(function (w) { return '<p class="pf-warn">' + ic('info', 'ic-sm') + ' ' + esc(w) + '</p>'; }).join('') + '</div>' : '') +
      (result ? '<div class="pf-done" data-pf-result="apply"><p class="pf-done-s">백업</p><ul class="pf-backups">' + (arr(result.backups).length ? arr(result.backups).map(function (b) {
          return '<li><code>' + esc(b) + '</code></li>';
        }).join('') : '<li class="pf-muted">없음 (바뀐 파일 없음)</li>') + '</ul>' +
        (arr(result.writes).length ? '<p class="pf-done-s">쓴 파일</p><ul class="pf-writes">' + arr(result.writes).map(function (w) {
          return '<li><code>' + esc(w) + '</code></li>';
        }).join('') + '</ul>' : '') + '</div>' : '') +
      '</div>' + tail + '</section>';
  }

  // WinForms 이 프로필 적용하기 (PS:4200-4211, 7517-7545): the shown profile's edits plus the shared ones, then activation.
  // 미리보기 is optional and never a step; 모두 버리기 asks first.
  function applyBar(view, edit, ro) {
    if (ro) return '';
    var n = pendingOf(edit).length;
    var busy = !!(edit && edit.busy === true);
    var conflict = !!(edit && edit.conflict);
    var backupsOnly = n > 0 && pendingOf(edit).every(function (change) { return change.kind === 'setRoleBackup'; });
    var advisorsOnly = n > 0 && pendingOf(edit).every(function (change) { return change.kind === 'setAdvisor'; });
    var savesOnly = n > 0 && pendingOf(edit).every(function (change) { return change.kind === 'setRoleBackup' || change.kind === 'setAdvisor'; });
    var shownProfile = profileOf(view, shownKeyOf(view, edit));
    var backupCount = pendingOf(edit).filter(function (change) { return change.kind === 'setRoleBackup' && ofProfile(change, shownProfile); }).length;
    var drafts = obj(edit && edit.draft) || {};
    var hasBackupDraft = Object.keys(drafts).some(function (key) { return key.indexOf('backup:') === 0; });
    var incompleteBackup = Object.keys(drafts).some(function (key) {
      if (key.indexOf('backup:' + str(shownProfile && shownProfile.omoProfile) + ':') !== 0) return false;
      var d = drafts[key];
      return (d.provider || d.model || d.thinking) && !(d.provider && d.model && d.thinking);
    });
    return '<div class="pf-apply" data-flow="apply" data-flow-sec="apply">' +
      button('apply', attr('data-flow', 'apply:detail'), ic('check', 'ic-sm') + (advisorsOnly ? ' 자문가 선택 저장' : backupsOnly || !n && hasBackupDraft ? ' 백업 선택 저장' : savesOnly ? ' 선택 저장' : ' 이 프로필 적용하기'), busy || conflict || incompleteBackup || !n && hasBackupDraft || backupsOnly && !backupCount, 'pf-btn pf-btn-primary') +
      button('preview', '', ic('search', 'ic-sm') + ' 미리보기', busy || conflict || incompleteBackup, 'pf-btn') +
      chip(n ? 'pf-c-amber' : 'pf-c-gray', STATUS_TEXT.pending + ' ' + n) +
      button('clear', '', '모두 버리기', busy || !n && !hasBackupDraft, 'pf-btn pf-btn-danger') +
      (edit && edit.confirmClear ? '<div class="pf-clear" role="group" aria-label="대기 변경 버리기 확인"><p>대기 중인 변경을 모두 버릴까요?</p>' +
        button('clear-cancel', ' aria-label="계속 보관"', '계속 보관', busy, 'pf-btn') + ' ' +
        button('clear-confirm', ' aria-label="모두 버리기 확인"', '모두 버리기', busy, 'pf-btn pf-btn-danger') + '</div>' : '') + '</div>';
  }

  // WinForms detail pane (PS:7211-7290) for the shown profile: title, usage, the caption, the role box (its own scroll,
  // like the routing box PS:6172, 7251), then the lane, main, summarizer and apply rows.
  function routingEditor(v, dv, edit, ro) {
    var selected = str(edit && edit.tab) || 'primary';
    var searching = !!str(edit && edit.query).trim();
    var bodies = {
      primary: agentRows(dv, edit, ro),
      agents: routingRows(dv, edit, ro, 'agents') + advisorRows(v, edit, ro),
      categories: routingRows(dv, edit, ro, 'categories'),
      memory: memoryRows(v, edit, ro) + '<p class="pf-note" data-pf-memory-placement>Kibitzer와 Reflection은 Memory 탭에서 설정하며, 모든 프로필에 적용됩니다. ' +
        'Summary는 탭 밖의 요약 담당 모델(compaction.model)에서 설정합니다. model_profile과 메인 모델 설정 아래에 있는 요약 담당 모델을 고른 뒤 적용하십시오.</p>'
    };
    var counts = {};
    ROUTING_TABS.forEach(function (tab) {
      counts[tab[0]] = (bodies[tab[0]].match(/data-pf-(?:agent|route|memory-row)=/g) || []).length;
    });
    var tabs = ROUTING_TABS.map(function (tab) {
      var on = tab[0] === selected;
      return '<button type="button" role="tab" data-pf="tab"' + attr('data-tab', tab[0]) +
        attr('id', 'pf-tab-' + tab[0]) + attr('aria-controls', 'pf-panel-' + tab[0]) +
        ' aria-selected="' + on + '" tabindex="' + (on ? '0' : '-1') + '">' +
        tab[1] + ' <span class="pf-count">' + counts[tab[0]] + '</span></button>';
    }).join('');
    // Native Tab follows the same panel order as the rendered tabs and search results.
    var panels = ROUTING_TABS.map(function (tab) {
      var id = tab[0];
      return '<div class="pf-tab-panel pf-groups" role="tabpanel"' + attr('id', 'pf-panel-' + id) +
        attr('data-pf-panel', id) + attr('aria-labelledby', 'pf-tab-' + id) +
        boolAttr('hidden', searching ? !counts[id] : id !== selected) + '>' +
        '<h3 class="pf-search-group"' + boolAttr('hidden', !searching) + '>' + idOf(ROUTING_TABS, id) + '</h3>' +
        bodies[id] + '</div>';
    }).join('');
    return '<div class="pf-routing-tools"><label for="pf-routing-search"><span class="pf-sel-t">역할·모델 검색</span></label>' +
      '<input type="search" id="pf-routing-search" data-pf="routing-search"' + attr('value', str(edit && edit.query)) +
      ' placeholder="role / provider / model / alias">' +
      '<div class="pf-routing-tabs" role="tablist" aria-label="Routing">' + tabs + '</div></div>' +
      '<div class="pf-tab-panels">' + panels + '</div>' +
      (searching && !Object.keys(counts).some(function (id) { return counts[id]; }) ? '<p role="status">검색 결과 없음</p>' : '');
  }
  function detailView(v, edit) {
    var detail = obj(v.details && v.details[shownKeyOf(v, edit)]);
    return Object.assign({}, v, {
      routing: obj(detail && detail.routing) || obj(v.routing),
      main: obj(detail && detail.main) || obj(v.main),
      modelProfile: obj(detail && detail.modelProfile) || obj(v.modelProfile),
      guide: obj(detail && detail.guide) || obj(v.guide),
      primaryBackups: obj(detail && detail.primaryBackups) || obj(v.primaryBackups)
    });
  }
  function detailPane(v, dv, edit, ro) {
    var key = shownKeyOf(v, edit), p = profileOf(v, key);
    var title = p ? cardTitle(p) : key;
    return '<section class="pf-sec pf-detail" data-flow="detail"><h2 class="pf-dt">' + esc(title) + '</h2>' +
      (p && p.summary ? '<p class="pf-du">' + summaryText(p.summary) + '</p>' : '') +
      '<p class="pf-cap">모델 라우팅 · 전담 에이전트 / 작업 카테고리 <span class="pf-count">' + arr(obj(dv.routing) && dv.routing.rows).length + '</span></p>' +
      '<div class="pf-roles" id="pf-sec-routing" data-pf-sec="routing" data-flow="roles">' + routingEditor(v, dv, edit, ro) + '</div>' +
      modelLane(dv, edit, ro) + mainModel(dv, edit, ro) + summarizer(v, edit, ro) + applyBar(v, edit, ro) + '</section>';
  }
  // ---- public renderers --------------------------------------------------------------------------------------------
  function render(view, edit) {
    var v = obj(view), e = obj(edit) || {};
    var state = viewState(v, e);
    var ro = state === 'view' ? readonly(v, e) : true;
    var stale = !!(v && (v.banner === STALE_BANNER || (obj(v.inventory) && v.inventory.stale === true) || v.readOnlyReason === 'INVENTORY_STALE'));
    return '<div class="pf" data-pf-root data-pf-state="' + state + '" data-pf-busy="' + (e.busy === true) + '" data-pf-conflict="' + (e.conflict === true) + '" data-readonly="' + ro + '">' + header(v, e) +
      (state === 'loading' ? loadingBlock() : '') +
      (state === 'error' ? errorBlock(e) : '') +
      (state === 'view' ? loaded(v, e, ro, stale) : '') +
      '</div>';
  }
  // The WinForms screen in the board look: status strip, cards | detail over the message strip (one client area, so the
  // strip is a bottom row under both panes, PS:4438), then the board extras.
  function loaded(v, e, ro, stale) {
    var dv = detailView(v, e);
    return statusStrip(v, e, ro, stale) + webDeepseek(v, e) + guideDialog(dv, e) +
      '<div class="pf-panes">' + profileCards(v, e, ro) + detailPane(v, dv, e, ro) + tray(v, e, ro) + '</div>' +
      homes(v);
  }
  function webDeepseek(v, edit) {
    var state = obj(v.webDeepseek) || {};
    var active = arr(state.active).length;
    var enabled = state.enabled === true;
    var installed = state.installed === true;
    var label = !installed ? 'Install required' : enabled ? (active ? 'ON · Active ' + active : 'ON · Idle')
      : active ? 'OFF · Stopping ' + active : 'OFF';
    var busy = edit.busy === true;
    var canWrite = edit.live === true && installed && !busy;
    return '<section class="pf-sec pf-web" id="pf-sec-web-deepseek" aria-label="웹딥식 수동 제어">' +
      '<div class="pf-web-row"><h2>웹딥식 <span class="cnt num">' + active + '</span></h2>' +
      '<p class="pf-web-status" role="status" id="pf-web-status" tabindex="-1">' +
      chip(enabled ? 'pf-c-green' : 'pf-c-gray', label) + '</p>' +
      '<div class="pf-web-actions">' +
      button('web-deepseek-on', ' aria-label="웹딥식 켜기"', '켜기', !canWrite || enabled, 'pf-btn' + (!enabled ? ' pf-btn-primary' : '')) +
      button('web-deepseek-off', ' aria-label="웹딥식 끄기"', '끄기', !canWrite || !enabled, 'pf-btn' + (enabled ? ' pf-btn-primary' : '')) +
      button('reload-state', ' aria-label="웹딥식 상태 새로고침"', '상태 새로고침', busy, 'pf-btn') +
      '</div></div>' +
      '<details class="fold pf-web-fold"><summary>' + ic('chevron-right', 'ic-xs chev') + ' <span>작동 방식 안내</span></summary>' +
      '<div class="fold-body"><p class="pf-note">로그인된 Orca DeepSeek 탭이 필요합니다. 켜기는 사용 허용이며 gateway는 모델 요청 때만 실행됩니다.</p>' +
      '<p class="pf-note">끄기는 새 호출을 막고 이 기능의 요청만 취소합니다. 사용자 브라우저와 다른 세션은 유지됩니다.</p></div></details></section>';
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
        '<span class="pf-nav-t">' + esc(s[1]) + '</span>' + (count !== '' ? '<span class="pf-count">' + count + '</span>' : '') + '</button>';
    }).join('');
    var loadState = viewState(v, e);
    var state = loadState === 'loading' ? chip('pf-c-gray', loadState)
      : loadState === 'error' ? chip('pf-c-red', loadState)
      : ro ? chip('pf-c-amber', STATUS_TEXT.readOnly) : chip('pf-c-green', STATUS_TEXT.editable);
    return '<div class="pf-nav" data-pf-side>' + emptyNote('섹션 이동', 'pf-nav-h') +
      '<div class="pf-nav-state">' + state + (pending ? chip('pf-c-amber', STATUS_TEXT.pending + ' ' + pending) : '') + '</div>' +
      nav +
      (e.conflict ? '<p class="pf-nav-warn">' + esc(CONFLICT_TEXT) + '</p>' : '') +
      (e.error && !e.conflict ? '<p class="pf-nav-warn">' + errorHtml(e.error) + '</p>' : '') +
      '</div>';
  }

  // ---- controller (no DOM, no timers) ------------------------------------------------------------------------------
  function createController(options) {
    var opt = obj(options) || {};
    var fetchFn = opt.fetch;
    var tokenFn = opt.token;
    var notify = typeof opt.onChange === 'function' ? opt.onChange : function () {};
    var s = { view: null, shown: '', pending: [], draft: map(), memoryErrors: map(), memorySaved: map(), preview: null, conflict: false, error: '', errorKind: '', status: '', result: null, loading: false, busy: false, confirmClear: false, openRow: '', tab: 'primary', query: '' };
    var seq = 0;

    function snapshot() {
      return {
        view: s.view, shown: s.shown || str(obj(s.view && s.view.activeProfile) && s.view.activeProfile.key),
        pending: s.pending.slice(), draft: copyMap(s.draft),
        memoryErrors: copyMap(s.memoryErrors), memorySaved: copyMap(s.memorySaved),
        preview: s.preview, conflict: s.conflict, error: s.error, errorKind: s.errorKind,
        status: s.status, result: s.result, loading: s.loading, busy: s.busy, confirmClear: s.confirmClear,
        openRow: s.openRow, tab: s.tab, query: s.query
      };
    }
    function changed() { notify(snapshot()); }
    function token() { return typeof tokenFn === 'function' ? str(tokenFn()) : str(tokenFn); }
    function responseJson(res) {
      if (!res || typeof res.json !== 'function') return Promise.resolve(null);
      return Promise.resolve(res.json()).then(null, function () { return null; });
    }
    function statusOf(res) { return res && num(res.status) !== null ? res.status : (res && res.ok ? 200 : 0); }

    function failureKind(err) {
      var message = str(err && err.message);
      if (/^HTTP \d{3}$/.test(message)) return 'http';
      if (/abort|failed to fetch|network|offline|fetch/i.test(message)) return 'network';
      return 'unknown';
    }
    function failureCopy(err) {
      var message = str(err && err.message);
      if (/^HTTP \d{3}$/.test(message)) return '프로필 상태를 불러오지 못했습니다. 서버가 응답하지 않았습니다. 다시 시도해 주십시오.';
      if (/abort|failed to fetch|network|offline|fetch/i.test(message)) return '프로필 상태를 불러오지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주십시오.';
      return '프로필 상태를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주십시오.';
    }

    function load() {
      if (typeof fetchFn !== 'function') {
        s.error = '상태를 불러올 수 없습니다.'; s.errorKind = 'unavailable'; s.loading = false; changed(); return Promise.resolve(snapshot());
      }
      s.loading = true; s.error = ''; s.errorKind = ''; changed();
      var mine = ++seq;
      function settleFailure(err) {
        if (mine !== seq) return snapshot();
        // Expected fetch failures get plain user copy; the diagnostic stays in the console as a warning.
        // Unexpected exceptions raised while handling a response are not caught here.
        if (g.console && g.console.warn) g.console.warn('[profiles] state read failed', err);
        s.loading = false;
        s.errorKind = failureKind(err);
        s.error = failureCopy(err);
        changed();
        return snapshot();
      }
      var request;
      try { request = fetchFn('/profiles/state', { cache: 'no-store', headers: { Accept: 'application/json' } }); }
      catch (err) { return settleFailure(err); }
      return Promise.resolve(request).then(function (res) {
        if (mine !== seq) return snapshot();
        var status = statusOf(res);
        if (!res || (status !== 200 && res.ok !== true)) return settleFailure({ message: 'HTTP ' + status });
        return responseJson(res).then(function (json) {
          if (mine !== seq) return snapshot();
          if (!obj(json)) return settleFailure({ message: 'invalid-json' });
          s.view = obj(json);
          if (!s.shown) s.shown = str(obj(s.view && s.view.activeProfile) && s.view.activeProfile.key);
          s.loading = false;
          s.error = '';
          s.errorKind = '';
          // A successful state read is the 409 recovery: the stale conflict and its banner are gone.
          s.conflict = false;
          if (s.status === STATUS_TEXT.conflict) s.status = '';
          changed();
          return snapshot();
        });
      }, settleFailure);
    }

    function isGlobalKind(kind) {
      return kind === 'setSummarizer' || kind === 'setMemoryRow' || kind === 'setAgentLane' || kind === 'setAgentPin' || kind === 'resetAgentMemory' || kind === 'migrateReviewerKeys' || kind === 'setAdvisor';
    }
    // setRoute names its profile by the omo layer key (store routeChange), setMain by the card key (getProfile);
    // both mean the same card here.
    function cardKeyOf(key) {
      var list = arr(s.view && s.view.profiles);
      for (var i = 0; i < list.length; i++) if (obj(list[i]) && (list[i].key === key || list[i].omoProfile === key)) return list[i].key;
      return key;
    }
    function sameTarget(a, b) {
      if (!obj(a) || !obj(b) || a.kind !== b.kind) return false;
      if (a.kind === 'setSummarizer') return true;
      if (!isGlobalKind(a.kind)) {
        var aProf = cardKeyOf(str(a.profileKey || a.omoProfile));
        var bProf = cardKeyOf(str(b.profileKey || b.omoProfile));
        if (aProf !== bProf) return false;
      }
      if (a.kind === 'setRoute' || a.kind === 'setRoleBackup') return a.section === b.section && a.role === b.role;
      if (a.kind === 'setAgentLane' || a.kind === 'setAgentPin' || a.kind === 'resetAgentMemory') return a.agentId === b.agentId;
      if (a.kind === 'setMemoryRow') return (str(a.row) || 'kibitzer') === (str(b.row) || 'kibitzer');
      if (a.kind === 'selectProfile' || a.kind === 'setMain' || a.kind === 'setModelProfile') return true;
      if (a.kind === 'migrateReviewerKeys') return true;
      if (a.kind === 'setAdvisor') return a.advisor === b.advisor;
      return false;
    }
    function agentKind(kind) { return kind === 'setAgentLane' || kind === 'setAgentPin' || kind === 'resetAgentMemory'; }

    function add(change) {
      if (s.busy) return snapshot();
      if (!obj(change) || typeof change.kind !== 'string') return snapshot();
      var next = s.pending.filter(function (c) {
        if (!obj(c)) return false;
        if (change.kind === 'selectProfile') return c.kind !== 'selectProfile';
        if (agentKind(change.kind) && agentKind(c.kind) && c.agentId === change.agentId) return false;
        return !sameTarget(c, change);
      });
      if (change.kind === 'setMemoryRow') {
        var mRow = str(change.row) || 'kibitzer';
        delete s.memoryErrors[mRow];
        delete s.memorySaved[mRow];
      }
      next.push(change);
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
    function draftKeyOfChange(c) {
      if (!obj(c)) return null;
      if (c.kind === 'setRoleBackup') return 'backup:' + str(c.profileKey) + ':' + str(c.section) + '/' + str(c.role);
      if (c.kind === 'setRoute') return 'route:' + str(c.section) + '/' + str(c.role);
      if (c.kind === 'setAgentLane' || c.kind === 'setAgentPin') return 'agent:' + str(c.agentId);
      if (c.kind === 'setMain') return 'main';
      if (c.kind === 'setModelProfile') return 'lane';
      if (c.kind === 'setSummarizer') return 'summarizer';
      if (c.kind === 'setMemoryRow') return 'memory:' + (str(c.row) || 'kibitzer');
      if (c.kind === 'setAdvisor') return 'advisor:' + str(c.advisor);
      return null;
    }
    function drop(index) {
      if (s.busy) return snapshot();
      var i = typeof index === 'string' && /^\d+$/.test(index) ? Number(index) : num(index);
      if (i === null || i < 0 || i >= s.pending.length) return snapshot();
      var removed = s.pending[i];
      s.pending = s.pending.slice(0, i).concat(s.pending.slice(i + 1));
      var dKey = draftKeyOfChange(removed);
      if (dKey && has(s.draft, dKey)) delete s.draft[dKey];
      s.preview = null; s.result = null;
      if (!s.conflict) { s.error = ''; s.status = ''; }
      s.confirmClear = false;
      changed();
      return snapshot();
    }
    function clear() {
      // Discarding removes pending edits but does not make the loaded targets/revision fresh.
      if (s.busy) return snapshot();
      s.pending = []; s.draft = map(); s.memoryErrors = map(); s.memorySaved = map(); s.preview = null; s.result = null;
      if (!s.conflict) { s.error = ''; s.status = ''; }
      s.confirmClear = false;
      changed();
      return snapshot();
    }
    function askClear() {
      if (s.busy) return snapshot();
      if (!s.pending.length && !Object.keys(s.draft).some(function (key) { return key.indexOf('backup:') === 0; })) return snapshot();
      s.confirmClear = true;
      changed();
      return snapshot();
    }
    function cancelClear() {
      if (s.busy) return snapshot();
      s.confirmClear = false;
      changed();
      return snapshot();
    }
    function setDraft(key, patch) {
      if (s.busy) return snapshot();
      var k = str(key);
      if (!k) return snapshot();
      if (patch === null) { delete s.draft[k]; s.preview = null; return snapshot(); }
      if (k.indexOf('memory:') === 0) {
        var mKey = k.slice(7);
        delete s.memoryErrors[mKey];
        delete s.memorySaved[mKey];
      }
      s.draft[k] = Object.assign({}, draftOf({ draft: s.draft }, k) || {}, obj(patch) || {});
      s.preview = null;
      return snapshot();
    }
    function touch() { if (s.busy) return snapshot(); s.preview = null; changed(); return snapshot(); }
    // With a profile key only that profile's edit of the kind goes: a lane edit belongs to one profile.
    function removeKind(kind, profileKey) {
      if (s.busy) return snapshot();
      var targetProf = profileKey ? cardKeyOf(str(profileKey)) : '';
      s.pending = s.pending.filter(function (c) {
        return !obj(c) || c.kind !== kind || (!!targetProf && cardKeyOf(str(c.profileKey || c.omoProfile)) !== targetProf);
      });
      s.preview = null; s.result = null;
      if (!s.conflict) { s.error = ''; s.status = ''; }
      s.confirmClear = false;
      changed();
      return snapshot();
    }
    function removeRoute(section, role, profileKey, kind) {
      if (s.busy) return snapshot();
      var targetProf = cardKeyOf(str(profileKey || s.shown));
      s.pending = s.pending.filter(function (c) {
        return !obj(c) || c.kind !== (kind || 'setRoute') || c.section !== section || c.role !== role || cardKeyOf(str(c.profileKey || c.omoProfile)) !== targetProf;
      });
      s.preview = null; s.result = null;
      if (!s.conflict) { s.error = ''; s.status = ''; }
      s.confirmClear = false;
      changed();
      return snapshot();
    }
    function removeAdvisor(name) {
      if (s.busy) return snapshot();
      s.pending = s.pending.filter(function (c) { return !obj(c) || c.kind !== 'setAdvisor' || c.advisor !== name; });
      s.preview = null; s.result = null;
      if (!s.conflict) { s.error = ''; s.status = ''; }
      s.confirmClear = false;
      changed();
      return snapshot();
    }
    function removeMemoryRow(row) {
      if (s.busy) return snapshot();
      var target = str(row) || 'kibitzer';
      s.pending = s.pending.filter(function (c) {
        return !obj(c) || c.kind !== 'setMemoryRow' || (str(c.row) || 'kibitzer') !== target;
      });
      s.preview = null; s.result = null;
      if (!s.conflict) { s.error = ''; s.status = ''; }
      s.confirmClear = false;
      changed();
      return snapshot();
    }

    function isGlobalKind(kind) {
      return kind === 'setSummarizer' || kind === 'setMemoryRow' || kind === 'setAgentLane' || kind === 'setAgentPin' || kind === 'resetAgentMemory' || kind === 'migrateReviewerKeys' || kind === 'setAdvisor';
    }
    // A role backup and an advisor are saved selections: saving only those does not activate the shown profile.
    function saveOnly(change) { return change.kind === 'setRoleBackup' || change.kind === 'setAdvisor'; }
    function changesForProfile(targetProfileKey, activateProfile) {
      var activeKey = str(obj(s.view && s.view.activeProfile) && s.view.activeProfile.key);
      var profKey = cardKeyOf(str(targetProfileKey || s.shown || activeKey));
      var list = [];
      s.pending.forEach(function (c) {
        if (!obj(c)) return;
        var cProf = cardKeyOf(str(c.profileKey || c.omoProfile));
        if (isGlobalKind(c.kind) || !cProf || cProf === profKey) {
          list.push(c);
        }
      });
      var backupSave = s.pending.length > 0 ? s.pending.every(saveOnly)
        : Object.keys(s.draft).some(function (key) { return key.indexOf('backup:') === 0; });
      if (profKey && (activateProfile || !backupSave && !(list.length && list.every(saveOnly)))) {
        list.push({ kind: 'selectProfile', profileKey: profKey });
      }
      return list;
    }
    function send(action, changesOverride, options) {
      var opt = obj(options) || {};
      var reapply = opt.reapply === true;
      var applyProfileKey = opt.profileKey || s.shown || (obj(s.view && s.view.activeProfile) && s.view.activeProfile.key);
      var list = Array.isArray(changesOverride)
        ? changesOverride.slice()
        : action === 'apply' || action === 'preview'
          ? changesForProfile(applyProfileKey, Boolean(opt.profileKey))
          : s.pending.slice();
      if (s.busy) return Promise.resolve(snapshot());
      // A 409 makes the loaded roster revision stale: neither preview nor apply may post it again
      // until a successful state read. The latch survives add/drop/removeKind/clear; only load() lifts it.
      if (s.conflict) return Promise.resolve(snapshot());
      if (typeof fetchFn !== 'function') {
        s.error = '실시간 상황판에서만 보낼 수 있습니다.'; s.errorKind = 'unavailable'; changed(); return Promise.resolve(snapshot());
      }
      if (!list.length) {
        s.error = reapply ? '다시 적용할 변경 기록이 없습니다.' : '바꾼 값을 먼저 골라 주십시오.';
        s.errorKind = 'input';
        changed(); return Promise.resolve(snapshot());
      }
      var body = {
        action: action,
        changes: list,
        expected: obj(s.view && s.view.targets) || {},
        rosterRevision: num(obj(s.view && s.view.roster) && s.view.roster.revision) || 0
      };
      s.busy = true; s.preview = null; s.result = null; s.conflict = false; s.error = ''; s.errorKind = ''; s.confirmClear = false;
      s.status = reapply ? STATUS_TEXT.reapplying : action === 'preview' ? STATUS_TEXT.previewing : STATUS_TEXT.applying;
      changed();
      var request;
      try {
        request = fetchFn('/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Board-Token': token() },
          body: JSON.stringify(body)
        });
      } catch (err) { request = Promise.reject(err); }
      return Promise.resolve(request).then(function (res) {
        var status = statusOf(res);
        return responseJson(res).then(function (json) {
          return { status: status, json: json };
        });
      }).then(function (res) {
        var json = obj(res.json);
        s.busy = false;
        if (res.status === 200 && json && json.ok === true) {
          if (action === 'preview') {
            s.preview = json; s.status = STATUS_TEXT.previewReady; s.conflict = false; s.error = ''; s.errorKind = '';
            changed();
            return snapshot();
          }
          s.result = json; s.preview = null; s.conflict = false; s.error = ''; s.errorKind = '';
          var savedRows = map();
          list.forEach(function (c) {
            if (c && c.kind === 'setMemoryRow') savedRows[str(c.row) || 'kibitzer'] = true;
          });
          s.memorySaved = savedRows;
          s.memoryErrors = map();
          if (!reapply) {
            var sentSet = new Set(list);
            s.pending = s.pending.filter(function (c) { return !sentSet.has(c); });
            Object.keys(s.draft).forEach(function (key) {
              if (key.indexOf('backup:') !== 0 || list.some(function (c) { return draftKeyOfChange(c) === key; })) delete s.draft[key];
            });
          }
          s.status = reapply ? STATUS_TEXT.reapplied : STATUS_TEXT.applied;
          changed();
          return load().then(function () { return snapshot(); });
        }
        if (res.status === 409) {
          s.conflict = true; s.status = STATUS_TEXT.conflict; s.error = CONFLICT_TEXT; s.errorKind = 'conflict';
          changed();
          return snapshot();
        }
        s.status = STATUS_TEXT.failure;
        s.errorKind = 'server';
        s.error = (json && (str(json.message) || str(json.code))) || ('HTTP ' + res.status + ' - 다시 시도해 주십시오.');
        var memInList = list.filter(function (c) { return c && c.kind === 'setMemoryRow'; });
        if (json && (json.row === 'kibitzer' || json.row === 'reflection')) {
          s.memoryErrors[json.row] = s.error;
        } else if (/reflection/i.test(s.error)) {
          s.memoryErrors.reflection = s.error;
        } else if (/kibitzer|recall/i.test(s.error)) {
          s.memoryErrors.kibitzer = s.error;
        } else if (memInList.length === 1) {
          s.memoryErrors[str(memInList[0].row) || 'kibitzer'] = s.error;
        }
        changed();
        return snapshot();
      }).catch(function (err) {
        s.busy = false;
        s.status = STATUS_TEXT.failure;
        if (g.console && g.console.warn) g.console.warn('[profiles] send failed', err);
        s.errorKind = 'network';
        s.error = '보내지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주십시오.';
        changed();
        return snapshot();
      });
    }

    function setWebDeepseek(enabled) {
      var state = obj(s.view && s.view.webDeepseek);
      if (s.busy || !state || state.installed !== true || typeof enabled !== 'boolean') return Promise.resolve(snapshot());
      var body = { action: 'apply', changes: [{ kind: 'setWebDeepseekEnabled',
        enabled: enabled, expectedRevision: state.revision }], expected: {}, rosterRevision: 0 };
      s.busy = true; s.error = ''; s.errorKind = ''; changed();
      var request;
      try {
        request = fetchFn('/profiles', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Board-Token': token() },
          body: JSON.stringify(body) });
      } catch (error) { request = Promise.reject(error); }
      return Promise.resolve(request).then(function (response) {
        return responseJson(response).then(function (json) { return { status: statusOf(response), json: json }; });
      }).then(function (result) {
        s.busy = false;
        if (result.status === 200 && result.json && result.json.ok === true && obj(result.json.webDeepseek)) {
          s.view.webDeepseek = result.json.webDeepseek;
          s.status = enabled ? '웹딥식 켜짐' : '웹딥식 꺼짐';
        } else {
          s.errorKind = 'server';
          s.error = result.status === 409 ? '웹딥식 상태가 바뀌었습니다. 상태를 새로고침하세요.' : '웹딥식 상태를 바꾸지 못했습니다.';
        }
        changed();
        return snapshot();
      }, function () {
        s.busy = false; s.errorKind = 'network'; s.error = '웹딥식 요청을 보내지 못했습니다.';
        changed();
        return snapshot();
      });
    }

    return {
      snapshot: snapshot,
      load: load,
      setWebDeepseek: setWebDeepseek,
      add: add,
      drop: drop,
      clear: clear,
      askClear: askClear,
      cancelClear: cancelClear,
      setDraft: setDraft,
      touch: touch,
      removeKind: removeKind,
      removeRoute: removeRoute,
      removeMemoryRow: removeMemoryRow,
      removeAdvisor: removeAdvisor,
      selectTab: function (tab) {
        if (!ROUTING_TABS.some(function (t) { return t[0] === tab; })) return snapshot();
        s.tab = tab;
        changed();
        return snapshot();
      },
      search: function (query) {
        s.query = str(query);
        if (s.openRow && s.view && routingEditor(s.view, detailView(s.view, s), s, readonly(s.view, s))
          .indexOf('data-row="' + esc(s.openRow) + '"') < 0) s.openRow = '';
        changed();
        return snapshot();
      },
      show: function (profileKey) {
        if (s.busy) return snapshot();
        // A main, lane or role draft is the shown profile's row in the making. WinForms rebuilds the rows and the
        // model_profile combo for each shown profile (PS:6058-6077), so another profile starts from its own saved and
        // pending values, never from that draft.
        if (str(profileKey) !== s.shown) {
          Object.keys(s.draft).forEach(function (k) { if (k === 'main' || k === 'lane' || k.indexOf('route:') === 0) delete s.draft[k]; });
        }
        s.shown = str(profileKey);
        changed();
        return snapshot();
      },
      openRow: function (rowKey) {
        var k = str(rowKey);
        s.openRow = s.openRow === k ? '' : k;
        changed();
        return snapshot();
      },
      preview: function (profileKey) { return send('preview', null, { profileKey: profileKey }); },
      apply: function (profileKey) { return send('apply', null, { profileKey: profileKey }); },
      reapply: function () {
        if (s.busy || s.conflict) return Promise.resolve(snapshot());
        var journal = obj(s.view && s.view.applyJournal);
        var payload = obj(journal && journal.reapply);
        var changes = arr(payload && payload.changes);
        if (!changes.length) {
          s.status = STATUS_TEXT.failure; s.error = '다시 적용할 변경 기록이 없습니다.'; changed();
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
    function focusLost() {
      var doc = root.ownerDocument, active = doc && doc.activeElement;
      if (!active) return true;
      if (active === doc.body || active === doc.documentElement) return true;
      return !!(doc.body && typeof doc.body.contains === 'function' && !doc.body.contains(active));
    }
    // Preview/apply re-render synchronously with their actions disabled. The focus status chip is the
    // same tag/id in busy and result states, so page.js region() carries focus into the next render.
    function restoreStatusFocus() {
      var doc = root.ownerDocument;
      if (!doc || !focusLost()) return;
      var target = root.querySelector('#pf-focus-status');
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }
    function onClick(ev) {
      var t = actOf(ev && ev.target);
      if (!t || !root.contains(t)) return;
      var act = t.getAttribute('data-pf');
      var c = controller();
      if (!c) return;
      // A held apply/preview owns the state until its response settles. Disabled controls also
      // reject synthetic change/input events here, so a newer edit cannot be discarded by the
      // older response's pending/draft reset.
      if (c.snapshot().busy && ['select-profile', 'apply-card', 'reset-memory', 'preview', 'apply', 'reapply',
        'clear', 'clear-cancel', 'clear-confirm', 'drop', 'reload-state'].indexOf(act) >= 0) return;
      if (act === 'web-deepseek-on' || act === 'web-deepseek-off') {
        if (c.snapshot().busy) return;
        c.setWebDeepseek(act === 'web-deepseek-on').then(function () {
          var statusTarget = root.querySelector('#pf-web-status');
          if (statusTarget && focusLost()) statusTarget.focus({ preventScroll: true });
        });
      } else if (act === 'tab') {
        var tab = str(t.getAttribute('data-tab'));
        c.selectTab(tab);
        var tabTarget = root.querySelector('#pf-tab-' + tab);
        if (tabTarget && typeof tabTarget.focus === 'function') tabTarget.focus({ preventScroll: true });
      } else if (act === 'row-toggle' || act === 'row-close') {
        var rowKey = str(t.getAttribute('data-row'));
        if (!rowKey) {
          var rBox = t.closest('[data-pf-route]');
          var mBox = t.closest('[data-pf-memory-row]');
          rowKey = rBox ? 'route:' + str(rBox.getAttribute('data-pf-route')) : mBox ? 'memory:' + str(mBox.getAttribute('data-pf-memory-row')) : '';
        }
        var wasOpen = str(c.snapshot().openRow) === rowKey;
        c.openRow(act === 'row-close' ? '' : rowKey);
        if (wasOpen || act === 'row-close') {
          var sumTarget = root.querySelector('.pf-row-sum[data-row="' + rowKey + '"]');
          if (sumTarget && typeof sumTarget.focus === 'function') sumTarget.focus({ preventScroll: true });
        }
      } else if (act === 'guide-open' || (act === 'jump' && t.getAttribute('data-target') === 'guide')) {
        var guideBox = root.querySelector('#pf-guide-dlg');
        if (guideBox && typeof guideBox.showModal === 'function' && !guideBox.open) guideBox.showModal();
      } else if (act === 'guide-close') {
        var openBox = root.querySelector('#pf-guide-dlg');
        if (openBox && typeof openBox.close === 'function') openBox.close();
        var guideCall = root.querySelector('[data-pf="guide-open"]');
        if (guideCall && typeof guideCall.focus === 'function') guideCall.focus({ preventScroll: true });
      } else if (act === 'jump') {
        var target = str(t.getAttribute('data-target'));
        var jumpTab = { routing: 'agents', memory: 'memory', agents: 'primary' }[target];
        if (jumpTab) {
          if (c.snapshot().query) c.search('');
          c.selectTab(jumpTab);
        }
        var id = 'pf-sec-' + target;
        var doc = root.ownerDocument;
        var el = doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null;
        if (!el && doc && typeof doc.querySelector === 'function') el = doc.querySelector('#' + id);
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
      } else if (act === 'select-profile') {
        c.show(t.getAttribute('data-profile'));
      } else if (act === 'apply-card') {
        // WinForms card 적용 (PS:7167-7182): show that profile, then write its edits and the shared ones and activate it.
        c.show(t.getAttribute('data-profile'));
        c.apply(t.getAttribute('data-profile'));
        restoreStatusFocus();
      } else if (act === 'reset-memory') {
        c.add({ kind: 'resetAgentMemory', agentId: t.getAttribute('data-agent') });
      } else if (act === 'preview') {
        c.preview();
        restoreStatusFocus();
      } else if (act === 'apply') {
        c.apply();
        restoreStatusFocus();
      } else if (act === 'reapply') {
        c.reapply();
        restoreStatusFocus();
      } else if (act === 'clear') {
        c.askClear();
      } else if (act === 'clear-cancel') {
        c.cancelClear();
      } else if (act === 'clear-confirm') {
        c.clear();
      } else if (act === 'drop') {
        c.drop(t.getAttribute('data-index'));
      } else if (act === 'reload') {
        // An inline error retry re-reads in place; the conflict recovery keeps the full reload hand-off.
        if (typeof t.closest === 'function' && t.closest('.pf-error')) {
          c.load();
          restoreStatusFocus();
        } else if (typeof h.reload === 'function') h.reload();
        else if (g.location && typeof g.location.reload === 'function') g.location.reload();
      } else if (act === 'reload-state') {
        c.load();
        restoreStatusFocus();
      }
    }
    function onInput(ev) {
      var t = ev && ev.target;
      if (t && t.getAttribute('data-pf') === 'routing-search') {
        var searchController = controller();
        if (searchController) searchController.search(str(t.value));
        return;
      }
      if (!t || t.getAttribute('data-pf') !== 'lane-literal') return;
      var c = controller();
      if (!c || c.snapshot().busy) return;
      c.setDraft('lane', { literal: str(t.value) });
    }
    function selectVal(el) {
      if (!el) return '';
      var v = str(el.value);
      if (v) return v;
      if (typeof el.querySelectorAll === 'function') {
        var opts = el.querySelectorAll('option');
        for (var i = 0; i < opts.length; i++) {
          if (opts[i].hasAttribute && opts[i].hasAttribute('selected')) return str(opts[i].getAttribute('value'));
        }
      }
      return '';
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
      if (!c || c.snapshot().busy) return;
      if (act === 'agent-lane') {
        c.setDraft('agent:' + t.getAttribute('data-agent'), { lane: t.value });
        c.add({ kind: 'setAgentLane', agentId: t.getAttribute('data-agent'), lane: t.value });
      } else if (act === 'agent-provider') {
        var providerAgent = t.getAttribute('data-agent');
        c.setDraft('agent:' + providerAgent, { provider: str(t.value), pin: '', thinking: '' });
        c.add({ kind: 'setAgentPin', agentId: providerAgent, pin: null });
      } else if (act === 'agent-pin') {
        var agentId = t.getAttribute('data-agent');
        var value = str(t.value);
        var thinking = rowValue(t, '[data-pf-agent]', '[data-pf="agent-pin-thinking"]') || 'medium';
        if (agentId === 'hephaestus' && value && value.slice(value.indexOf('|') + 1).indexOf('gpt-') !== 0) return;
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
          if (agent === 'hephaestus' && pinValue.slice(cutAt + 1).indexOf('gpt-') !== 0) return;
          c.setDraft('agent:' + agent, { thinking: str(t.value) });
          if (cutAt > 0) c.add({ kind: 'setAgentPin', agentId: agent, pin: { provider: pinValue.slice(0, cutAt), modelId: pinValue.slice(cutAt + 1), thinking: t.value } });
        }
      } else if (act === 'route-backup') {
        var backupRoute = str(t.getAttribute('data-route'));
        var backupSlash = backupRoute.indexOf('/');
        var backupProfile = profileOf(c.snapshot().view, str(c.snapshot().shown));
        if (backupSlash > 0 && backupProfile && t.value !== '__direct__') {
          c.setDraft('backup:' + str(backupProfile.omoProfile) + ':' + backupRoute, null);
          c.add({
            kind: 'setRoleBackup', profileKey: str(backupProfile.omoProfile),
            section: backupRoute.slice(0, backupSlash), role: backupRoute.slice(backupSlash + 1), alias: str(t.value)
          });
        }
      } else if (act === 'backup-provider' || act === 'backup-model' || act === 'backup-thinking') {
        var backupBox = t.closest('[data-backup-route]');
        var directRoute = str(t.getAttribute('data-route'));
        var directProfile = profileOf(c.snapshot().view, str(c.snapshot().shown));
        var directSlash = directRoute.indexOf('/');
        if (!backupBox || !directProfile || directSlash < 1) return;
        var bp = selectVal(backupBox.querySelector('[data-pf="backup-provider"]'));
        var bm = selectVal(backupBox.querySelector('[data-pf="backup-model"]'));
        var bt = selectVal(backupBox.querySelector('[data-pf="backup-thinking"]'));
        if (act === 'backup-provider') { bp = str(t.value); bm = ''; bt = ''; }
        else if (act === 'backup-model') { bm = str(t.value); bt = ''; }
        else bt = str(t.value);
        c.setDraft('backup:' + str(directProfile.omoProfile) + ':' + directRoute, { provider: bp, model: bm, thinking: bt });
        var directChange = { kind: 'setRoleBackup', profileKey: str(directProfile.omoProfile),
          section: directRoute.slice(0, directSlash), role: directRoute.slice(directSlash + 1) };
        if (!bp) c.add(Object.assign(directChange, { alias: '' }));
        else if (bm && bt) c.add(Object.assign(directChange, { provider: bp, model: bareModel(bm), thinking: bt }));
        else c.removeRoute(directChange.section, directChange.role, directChange.profileKey, 'setRoleBackup');
      } else if (act === 'route-provider' || act === 'route-model' || act === 'route-thinking') {
        var route = t.getAttribute('data-route');
        var row = t.closest('[data-pf-route]');
        var prevDraft = draftOf(c.snapshot(), 'route:' + route);
        var curProv = prevDraft ? str(prevDraft.provider) : (row ? selectVal(row.querySelector('[data-pf="route-provider"]')) : '');
        var curMdl = prevDraft ? str(prevDraft.model) : (row ? selectVal(row.querySelector('[data-pf="route-model"]')) : '');
        var curThk = prevDraft ? str(prevDraft.thinking) : (row ? selectVal(row.querySelector('[data-pf="route-thinking"]')) : '');
        var provider = curProv;
        var model = curMdl;
        var thinking = curThk;
        var profKey = str(c.snapshot().shown);
        if (act === 'route-provider') {
          // WinForms: service change clears model and effort, with no first-model pick
          provider = str(t.value);
          model = '';
          thinking = '';
        } else if (act === 'route-model') {
          // WinForms: model change picks first supported level of the new model
          model = str(t.value);
          var modelEntries = catalogEntries(c.snapshot().view);
          var matchEntry = entryOf(modelEntries, model, model);
          var levels = matchEntry && Array.isArray(matchEntry.levels) && matchEntry.levels.length
            ? matchEntry.levels
            : THINKING;
          thinking = levels[0] || 'off';
        } else if (act === 'route-thinking') {
          thinking = str(t.value);
        }
        c.setDraft('route:' + route, { provider: provider, model: model, thinking: thinking });
        var slash = route.indexOf('/');
        if (slash > 0 && provider && model && thinking) {
          // The store writes a role into the omo layer named by profileKey (store.mjs routeChange), not the card key.
          var layer = profileOf(c.snapshot().view, profKey);
          c.add({ kind: 'setRoute', profileKey: layer && str(layer.omoProfile) ? str(layer.omoProfile) : profKey, section: route.slice(0, slash), role: route.slice(slash + 1), provider: provider, model: model, thinking: thinking });
        } else {
          // Incomplete row stages removal of pending route edit
          if (slash > 0) {
            c.removeRoute(route.slice(0, slash), route.slice(slash + 1), profKey);
          }
          c.touch();
        }
      } else if (act === 'main-provider' || act === 'main-model' || act === 'main-thinking') {
        var main = t.closest('[data-pf-main]');
        var mainPrevDraft = draftOf(c.snapshot(), 'main');
        var curMainProv = mainPrevDraft ? str(mainPrevDraft.provider) : (main ? selectVal(main.querySelector('[data-pf="main-provider"]')) : '');
        var curMainMdl = mainPrevDraft ? str(mainPrevDraft.model) : (main ? selectVal(main.querySelector('[data-pf="main-model"]')) : '');
        var curMainThk = mainPrevDraft ? str(mainPrevDraft.thinking) : (main ? str(main.getAttribute('data-thinking')) : '');
        var mp = curMainProv;
        var mm = curMainMdl;
        var mt = curMainThk;
        var mainProfKey = str(c.snapshot().shown);
        var entries = servedEntries(c.snapshot().view);
        if (act === 'main-provider') {
          // WinForms: service change keeps model whose last id segment survives in new list and clamps current effort, else empties model
          mp = str(t.value);
          var oldModel = mm;
          var oldThinking = mt;
          var surviving = null;
          entries.forEach(function (e) {
            if (providerOf(e.model) !== mp) return;
            var id = bareModel(e.model);
            if (oldModel && (id === oldModel || e.model === oldModel || id.split('/').pop() === oldModel.split('/').pop())) {
              surviving = id;
            }
          });
          if (surviving) {
            mm = surviving;
            // Levels come from the provider-qualified id, as WinForms passes the model item's Tag
            mt = clampedThinking(entryOf(entries, '', mp + '/' + mm), oldThinking);
          } else {
            mm = '';
          }
        } else if (act === 'main-model') {
          // WinForms: model change clamps current effort to the new model
          mm = str(t.value);
          mt = clampedThinking(entryOf(entries, '', mp + '/' + mm), mt);
        } else if (act === 'main-thinking') {
          mt = str(t.value);
        }
        c.setDraft('main', { provider: mp, model: mm, thinking: mt });
        if (mp && mm && mt) {
          c.add({ kind: 'setMain', profileKey: mainProfKey, provider: mp, model: mm, thinking: mt });
        } else {
          // When any of the three is empty the row stages removal of the main override
          c.add({ kind: 'setMain', profileKey: mainProfKey, provider: '', model: '', thinking: '' });
        }
      } else if (act === 'lane-select') {
        var lane = str(t.value);
        var literalEl = t.closest('[data-pf-lane]') && t.closest('[data-pf-lane]').querySelector('[data-pf="lane-literal"]');
        var literal = literalEl ? str(literalEl.value) : '';
        // A lane edit belongs to the shown profile and names it by the card key, as setMain does (WinForms
        // Set-PendingModelProfile -OmoProfile of the shown profile, PS:6099-6104).
        var laneProfKey = str(c.snapshot().shown);
        c.setDraft('lane', { selection: lane, literal: literal });
        if (lane !== 'custom-literal' || literal) c.add({ kind: 'setModelProfile', profileKey: laneProfKey, selection: lane, literal: lane === 'custom-literal' ? literal : '' });
        else c.touch();
      } else if (act === 'lane-literal') {
        var sel = t.closest('[data-pf-lane]') && t.closest('[data-pf-lane]').querySelector('[data-pf="lane-select"]');
        var selection = sel ? str(sel.value) : '';
        var literalProfKey = str(c.snapshot().shown);
        c.setDraft('lane', { selection: selection, literal: str(t.value) });
        if (selection === 'custom-literal' && str(t.value)) c.add({ kind: 'setModelProfile', profileKey: literalProfKey, selection: 'custom-literal', literal: str(t.value) });
        else if (selection === 'custom-literal' && !str(t.value)) c.removeKind('setModelProfile', literalProfKey);
      } else if (act === 'summarizer-provider') {
        var sumProvider = str(t.value);
        c.setDraft('summarizer', { provider: sumProvider, model: '' });
        if (!sumProvider) c.add({ kind: 'setSummarizer', modelId: '' });
        else { c.removeKind('setSummarizer'); c.touch(); }
      } else if (act === 'summarizer-model') {
        var sumModel = str(t.value);
        var sumRow = t.closest('[data-pf-sum]');
        var sumProvEl = sumRow ? sumRow.querySelector('[data-pf="summarizer-provider"]') : null;
        var sumProv = (sumProvEl ? selectVal(sumProvEl) : '') || providerOf(sumModel);
        c.setDraft('summarizer', { provider: sumProv, model: sumModel });
        if (sumModel) c.add({ kind: 'setSummarizer', modelId: sumModel });
        else if (!sumProv) c.add({ kind: 'setSummarizer', modelId: '' });
        else { c.removeKind('setSummarizer'); c.touch(); }
      } else if (act === 'advisor-provider' || act === 'advisor-model' || act === 'advisor-thinking') {
        var advisor = str(t.getAttribute('data-advisor'));
        var advBox = t.closest('[data-pf-advisor]');
        if (!advisor || !advBox) return;
        var ap = selectVal(advBox.querySelector('[data-pf="advisor-provider"]'));
        var am = selectVal(advBox.querySelector('[data-pf="advisor-model"]'));
        var at = selectVal(advBox.querySelector('[data-pf="advisor-thinking"]'));
        // Same order as a role row: a service change clears model and effort, a model change takes its first level.
        if (act === 'advisor-provider') { ap = str(t.value); am = ''; at = ''; }
        else if (act === 'advisor-model') {
          am = str(t.value);
          var advCand = memoryRowCandidates(c.snapshot().view, true).filter(function (x) { return x.model === am; })[0];
          at = advCand && advCand.levels.length ? advCand.levels[0] : '';
        } else at = str(t.value);
        c.setDraft('advisor:' + advisor, { provider: ap, model: am, thinking: at });
        if (ap && am && at) c.add({ kind: 'setAdvisor', advisor: advisor, provider: ap, model: am, thinking: at });
        else { c.removeAdvisor(advisor); c.touch(); }
      } else if (act === 'memory-mode' || act === 'memory-service' || act === 'memory-model' || act === 'memory-thinking') {
        var memRow = t.closest('[data-pf-memory]');
        var key = memRow ? str(memRow.getAttribute('data-pf-memory')) : str(t.getAttribute('data-memory'));
        if (!key) return;
        var prevDraft = draftOf(c.snapshot(), 'memory:' + key);
        var modeEl = memRow ? memRow.querySelector('[data-pf="memory-mode"]') : null;
        var serviceEl = memRow ? memRow.querySelector('[data-pf="memory-service"]') : null;
        var modelEl = memRow ? memRow.querySelector('[data-pf="memory-model"]') : null;
        var thinkEl = memRow ? memRow.querySelector('[data-pf="memory-thinking"]') : null;
        var mode = act === 'memory-mode' ? str(t.value) : (selectVal(modeEl) || str(prevDraft && prevDraft.mode) || 'quick');
        var serviceValue = '';
        var modelValue = '';
        var thinkValue = '';
        if (act === 'memory-mode') {
          c.setDraft('memory:' + key, { mode: mode, service: '', model: '', reasoning: '' });
          if (mode === 'quick') c.add({ kind: 'setMemoryRow', row: key, mode: 'quick' });
          else { c.removeMemoryRow(key); c.touch(); }
          return;
        }
        if (act === 'memory-service') {
          serviceValue = str(t.value);
          c.setDraft('memory:' + key, { mode: 'custom', service: serviceValue, model: '', reasoning: '' });
          c.removeMemoryRow(key);
          c.touch();
          return;
        }
        if (act === 'memory-model') {
          modelValue = str(t.value);
          serviceValue = selectVal(serviceEl) || str(prevDraft && prevDraft.service) || providerOf(modelValue);
          c.setDraft('memory:' + key, { mode: 'custom', service: serviceValue, model: modelValue, reasoning: '' });
          c.removeMemoryRow(key);
          c.touch();
          return;
        }
        thinkValue = str(t.value);
        modelValue = selectVal(modelEl) || str(prevDraft && prevDraft.model);
        serviceValue = selectVal(serviceEl) || str(prevDraft && prevDraft.service) || providerOf(modelValue);
        c.setDraft('memory:' + key, { mode: mode, service: serviceValue, model: modelValue, reasoning: thinkValue });
        if (mode === 'quick') c.add({ kind: 'setMemoryRow', row: key, mode: 'quick' });
        else if (modelValue && thinkValue) c.add({ kind: 'setMemoryRow', row: key, mode: 'custom', model: modelValue, reasoning: thinkValue });
        else { c.removeMemoryRow(key); c.touch(); }
      }
    }
    // A render replaces the detail pane and its role box. An edit inside them keeps both scrolls like the WinForms
    // panes; showing another profile starts at the top (PS:6168 AutoScrollPosition = Empty). The cards panel keeps its
    // scroll either way: a WinForms selection never rebuilds that panel (PS:7006-7014).
    var KEEP = ['detail', 'roles'];
    function keepScroll(fn) {
      return function (ev) {
        var list = root.querySelector('[data-flow="cards"]'), listTop = list ? list.scrollTop : 0;
        var boxes = KEEP.map(function (id) { return root.querySelector('[data-flow="' + id + '"]'); });
        var tops = boxes.map(function (b) { return b ? b.scrollTop : 0; });
        if (!tops[0] && !tops[1] && !listTop) return fn(ev);
        var c = controller(), shown = c ? c.snapshot().shown : '';
        fn(ev);
        var nowList = root.querySelector('[data-flow="cards"]');
        if (nowList && nowList !== list && listTop) nowList.scrollTop = listTop;
        if (!c || c.snapshot().shown !== shown) return;
        KEEP.forEach(function (id, i) {
          var now = root.querySelector('[data-flow="' + id + '"]');
          if (now && now !== boxes[i] && tops[i]) now.scrollTop = tops[i];
        });
      };
    }
    // Keys 1-6 show cards 1-6 like WinForms (PS:7382-7395, Must have 9): only while the card buttons are on screen and
    // enabled, never from a text or select control, with a modifier, during an IME composition or behind the guide.
    function onKey(ev) {
      if (!ev || ev.defaultPrevented || ev.isComposing || ev.keyCode === 229) return;
      var keyTarget = ev.target;
      var keyController = controller();
      // The read-only guide has one tab stop. Keep Tab and Shift+Tab on it
      // rather than letting the browser move focus to the document body.
      var openGuide = root.querySelector('#pf-guide-dlg[open]');
      if (openGuide && ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        openGuide.querySelector('[data-pf="guide-close"]').focus();
        return;
      }
      if (keyTarget && keyTarget.getAttribute && keyTarget.getAttribute('data-pf') === 'tab' &&
          !ev.ctrlKey && !ev.altKey && !ev.metaKey && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End)$/.test(str(ev.key))) {
        var index = ROUTING_TABS.map(function (t) { return t[0]; }).indexOf(keyTarget.getAttribute('data-tab'));
        index = ev.key === 'Home' ? 0 : ev.key === 'End' ? ROUTING_TABS.length - 1 :
          (index + (/Left|Up/.test(ev.key) ? -1 : 1) + ROUTING_TABS.length) % ROUTING_TABS.length;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        keyController.selectTab(ROUTING_TABS[index][0]);
        var nextTab = root.querySelector('#pf-tab-' + ROUTING_TABS[index][0]);
        if (nextTab && typeof nextTab.focus === 'function') nextTab.focus({ preventScroll: true });
        return;
      }
      if (str(ev.key) === 'Escape') {
        if (keyController && keyController.snapshot().query && !root.querySelector('#pf-guide-dlg[open]')) {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          keyController.search('');
          return;
        }
        var cEsc = controller();
        var curRow = cEsc ? str(cEsc.snapshot().openRow) : '';
        if (curRow && !root.querySelector('#pf-guide-dlg[open]')) {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          cEsc.openRow('');
          var sumBtn = root.querySelector('.pf-row-sum[data-row="' + curRow + '"]');
          if (sumBtn && typeof sumBtn.focus === 'function') sumBtn.focus({ preventScroll: true });
          return;
        }
      }
      if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey || !/^[1-6]$/.test(str(ev.key))) return;
      var t = ev.target;
      if (t && (t.isContentEditable || (typeof t.closest === 'function' && t.closest('input,select,textarea,[contenteditable]')))) return;
      if (root.querySelector('#pf-guide-dlg[open]')) return;
      var buttons = root.querySelectorAll('[data-pf="select-profile"]');
      var c = buttons.length ? controller() : null;
      var view = c ? obj(c.snapshot().view) : null;
      var p = arr(view && view.profiles).filter(function (x) { return obj(x) && x.num === Number(ev.key); })[0];
      for (var i = 0; p && i < buttons.length; i++) {
        if (buttons[i].getAttribute('data-profile') !== p.key || buttons[i].hasAttribute('disabled')) continue;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        c.show(p.key);
        return;
      }
    }
    // Repeated alias titles are constructed from the current view before native select use.
    function prepareBackupTitles(ev) {
      var target = ev && ev.target;
      if (!target || target.tagName !== 'SELECT' || target.getAttribute('data-pf') !== 'route-backup') return;
      var c = controller();
      if (!c) return;
      var entries = catalogEntries(c.snapshot().view);
      Array.prototype.forEach.call(target.options, function (option) {
        var entry = entryOf(entries, option.value);
        if (!entry) return;
        var title = option.textContent !== bareModel(entry.model) ? entry.model : '';
        if (title && entry.off) title += ' · ' + offTitle(entry.off);
        if (title) option.setAttribute('title', title);
        else option.removeAttribute('title');
      });
    }
    root.addEventListener('pointerdown', prepareBackupTitles, true);
    root.addEventListener('focusin', prepareBackupTitles, true);
    root.addEventListener('keydown', prepareBackupTitles, true);
    var doc = root.ownerDocument;
    var click = keepScroll(onClick), change = keepScroll(onChange), input = keepScroll(onInput), keydown = keepScroll(onKey);
    root.addEventListener('click', click);
    function guideClosed(ev) {
      if (!ev.target || ev.target.id !== 'pf-guide-dlg') return;
      var call = root.querySelector('[data-pf="guide-open"]');
      if (call && typeof call.focus === 'function') call.focus({ preventScroll: true });
    }
    root.addEventListener('close', guideClosed, true);
    root.addEventListener('change', change);
    root.addEventListener('input', input);
    if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('keydown', keydown);
    return function unbind() {
      root.removeEventListener('pointerdown', prepareBackupTitles, true);
      root.removeEventListener('focusin', prepareBackupTitles, true);
      root.removeEventListener('keydown', prepareBackupTitles, true);
      root.removeEventListener('click', click);
      root.removeEventListener('close', guideClosed, true);
      root.removeEventListener('change', change);
      root.removeEventListener('input', input);
      if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', keydown);
    };
  }

  g.BriefProfiles = {
    render: render,
    side: side,
    createController: createController,
    bind: bind,
    STALE_BANNER: STALE_BANNER,
    CONFLICT_TEXT: CONFLICT_TEXT,
    displayModelLabels: displayModelLabels,
    escapeHtml: esc
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
