/* One page per inventory and one selected detail, shared by HTTP and offline snapshots. */
(function (g) {
  'use strict';
  var snapshot = null, cache = {}, flights = {}, page = null;
  var MAX_BYTES = 2 * 1024 * 1024;
  // Arriving data replaces the region; keep keyboard focus on the detail heading the user was taken to.
  function refresh() {
    if (!page) return;
    var active = g.document && g.document.activeElement;
    var keep = Boolean(active && active.classList && active.classList.contains('rmi-title'));
    page.render();
    var heading = keep && g.document.querySelector('.rmi-title');
    if (heading && heading !== g.document.activeElement) heading.focus({ preventScroll: true });
  }
  function cancel(kind) {
    var flight = flights[kind];
    if (!flight) return;
    delete flights[kind];
    flight.dispose();
  }
  function current(body, flight) {
    return snapshot && body && body.schema === 1 && body.key === snapshot.key &&
      body.gen === snapshot.gen && body.kind === flight.kind && body.id === flight.id &&
      Array.isArray(body.items);
  }
  function finish(flight, body, error) {
    if (flights[flight.kind] !== flight) return;
    cancel(flight.kind);
    if (!snapshot || snapshot.key !== flight.key) return;
    if (!error && !current(body, flight)) error = '응답 세대 또는 구조가 일치하지 않습니다.';
    cache[flight.kind] = { id: flight.id, items: error ? [] : body.items, error: error };
    refresh();
  }
  function load(kind, id) {
    id = String(id);
    if (cache[kind] && cache[kind].id === id) return cache[kind];
    if (flights[kind] && flights[kind].id === id) return null;
    cancel(kind);
    delete cache[kind];
    var flight = { kind: kind, id: id, key: snapshot.key, dispose: function () {} };
    flights[kind] = flight;
    var stem = 'roadmap-data/' + snapshot.key + '/' + kind + '-' + id;
    var http = g.location && /^https?:$/.test(g.location.protocol);
    if (http) {
      var req = new g.XMLHttpRequest();
      req.open('GET', '/' + stem + '.json', true);
      req.timeout = 10000;
      flight.dispose = function () { req.onload = req.onerror = req.ontimeout = null; req.abort(); };
      req.onload = function () {
        if (req.status !== 200) { finish(flight, null, '자료를 읽지 못했습니다 (HTTP ' + req.status + ').'); return; }
        if (new g.TextEncoder().encode(req.responseText).length > MAX_BYTES) {
          finish(flight, null, '자료가 읽기 용량 한도를 넘었습니다.'); return;
        }
        var body;
        try { body = JSON.parse(req.responseText); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          finish(flight, null, '자료 형식이 잘못되었습니다.'); return;
        }
        finish(flight, body, null);
      };
      req.onerror = req.ontimeout = function () { finish(flight, null, '자료를 읽지 못했습니다. 다시 시도하세요.'); };
      req.send();
    } else {
      var sc = g.document.createElement('script');
      var timer = g.setTimeout(function () { finish(flight, null, '파일 읽기 시간이 초과되었습니다.'); }, 10000);
      flight.dispose = function () { g.clearTimeout(timer); sc.remove(); };
      sc.src = stem + '.js';
      sc.onload = function () { finish(flight, null, '파일에서 현재 자료를 찾지 못했습니다.'); };
      sc.onerror = function () { finish(flight, null, '파일을 읽지 못했습니다. 스냅샷 폴더를 함께 보존하세요.'); };
      g.document.head.appendChild(sc);
    }
    return null;
  }
  g.__briefRoadmap = function (body) {
    var flight = body && flights[body.kind];
    if (flight && current(body, flight)) finish(flight, body, null);
  };
  function view(model, ui) {
    var descriptor = model.roadmapCatalogue;
    if (!descriptor) {
      Object.keys(flights).forEach(cancel);
      snapshot = null; cache = {};
      return model;
    }
    if (!snapshot || snapshot.key !== descriptor.key || snapshot.gen !== model.gen) {
      Object.keys(flights).forEach(cancel);
      snapshot = { key: descriptor.key, gen: model.gen };
      cache = {};
    }
    var plans = ui.roadmapSubView === 'plans';
    var filtered = !plans && !ui.catalogueSelected && ((ui.catalogueQuery || '').trim() ||
      ui.catalogueTopic && ui.catalogueTopic !== 'all');
    var kind = plans ? 'plans' : ui.catalogueSelected ? 'detail' : filtered ? 'search' : 'catalogue';
    var id = plans ? ui.roadmapPlanPage || 0 : ui.catalogueSelected || (filtered ? ui.roadmapSearchPage || 0 : ui.roadmapCataloguePage || 0);
    if (kind === 'plans' || kind === 'catalogue') {
      var last = (plans ? descriptor.planPages : descriptor.cataloguePages) - 1;
      id = Math.max(0, Math.min(id, last));
      if (plans) ui.roadmapPlanPage = id; else ui.roadmapCataloguePage = id;
    }
    if (kind === 'catalogue' && id === 0 && !cache.catalogue) cache.catalogue = { id: '0', items: model.roadmaps };
    var topicPage = Math.max(0, Math.min(ui.roadmapTopicPage || 0, descriptor.topicPages - 1));
    var topics = !plans && !ui.catalogueSelected ? load('topics', topicPage) : null;
    var loaded = filtered ? g.BriefRoadmapSearch.read(model, ui, load) : load(kind, id);
    var roadmaps = kind === 'catalogue' || kind === 'search' ? loaded && loaded.items || [] : model.roadmaps;
    if (kind === 'detail' && loaded && !loaded.error) roadmaps = loaded.items;
    return Object.assign({}, model, { roadmaps: roadmaps, roadmapPlans: plans ? loaded && loaded.items || [] : undefined,
      roadmapTopics: topics ? topics.items : undefined, roadmapTopicPage: topicPage, roadmapTopicError: topics && topics.error,
      roadmapLoad: { kind: kind, id: id, loading: !loaded || loaded.loading === true, error: loaded && loaded.error,
        total: filtered ? loaded.total : descriptor.total, pages: filtered ? loaded.pages : undefined } });
  }
  function controls(model) {
    var loadState = model.roadmapLoad, descriptor = model.roadmapCatalogue;
    if (!loadState || !descriptor) return '';
    var html = '<nav class="rmi-paging" aria-label="로드맵 자료 탐색">';
    if (loadState.kind !== 'detail') {
      var count = loadState.kind === 'plans' ? descriptor.planPages : loadState.kind === 'search' ? loadState.pages || 1 : descriptor.cataloguePages;
      var index = Number(loadState.id);
      html += '<p role="status">' + (loadState.kind === 'plans' ? '전체 연결 계획' : '등록 로드맵 ' + descriptor.total + '개') +
        ' · ' + (index + 1) + '/' + count + '쪽 · 검색·주제는 전체 로드맵에 적용됩니다.</p>';
      if (index > 0) html += '<button type="button" class="more" data-key="prev-' + loadState.kind + '" data-rm-page="' + (index - 1) + '" data-rm-kind="' + loadState.kind + '">이전 쪽</button> ';
      if (index + 1 < count) html += '<button type="button" class="more" data-key="next-' + loadState.kind + '" data-rm-page="' + (index + 1) + '" data-rm-kind="' + loadState.kind + '">다음 쪽</button>';
    }
    if (loadState.kind !== 'detail' && loadState.kind !== 'plans' && descriptor.topicPages > 1) {
      var topicPage = model.roadmapTopicPage;
      html += '<p>전체 주제 목록 · ' + (topicPage + 1) + '/' + descriptor.topicPages + '쪽</p>';
      if (topicPage > 0) html += '<button type="button" class="more" data-key="prev-topics" data-rm-page="' + (topicPage - 1) + '" data-rm-kind="topics">이전 주제</button> ';
      if (topicPage + 1 < descriptor.topicPages) html += '<button type="button" class="more" data-key="next-topics" data-rm-page="' + (topicPage + 1) + '" data-rm-kind="topics">다음 주제</button>';
    }
    if (model.roadmapTopicError) html += '<p role="alert">' + model.roadmapTopicError + '</p><button type="button" class="more" data-rm-retry="topics">주제 다시 읽기</button>';
    if (loadState.loading) html += '<p role="status">자료를 읽는 중입니다.</p>';
    if (loadState.error) html += '<p role="alert">' + loadState.error + '</p><button type="button" class="more" data-rm-retry="' + loadState.kind + '">다시 읽기</button>';
    return html + '</nav>';
  }
  function bind(root, controller) {
    page = controller;
    root.addEventListener('click', function (ev) {
      var target = ev.target.closest('[data-rm-page], [data-rm-retry]');
      if (!target) return;
      var retry = target.getAttribute('data-rm-retry');
      // Retry and a page edge remove the pressed control; give keyboard focus a deliberate destination.
      if (retry) { delete cache[retry]; refresh(); focusOn('.rmi-title'); return; }
      var dir = target.getAttribute('data-key') || '', other = dir.replace(/^(prev|next)-/, function (m, d) { return (d === 'prev' ? 'next' : 'prev') + '-'; });
      {
        var ui = page.state.ui, index = Number(target.getAttribute('data-rm-page'));
        if (target.getAttribute('data-rm-kind') === 'plans') ui.roadmapPlanPage = index;
        else if (target.getAttribute('data-rm-kind') === 'topics') ui.roadmapTopicPage = index;
        else if (target.getAttribute('data-rm-kind') === 'search') ui.roadmapSearchPage = index;
        else { ui.roadmapCataloguePage = index; ui.catalogueSelected = null; }
      }
      refresh();
      if (dir && !g.document.querySelector('[data-key="' + dir + '"]')) focusOn('[data-key="' + other + '"]') || focusOn('.rmi-title');
    });
  }
  function focusOn(selector) {
    var el = g.document.querySelector(selector);
    if (el) el.focus({ preventScroll: true });
    return Boolean(el);
  }
  g.BriefRoadmapData = { view: view, controls: controls, bind: bind };
})(typeof globalThis !== 'undefined' ? globalThis : this);
