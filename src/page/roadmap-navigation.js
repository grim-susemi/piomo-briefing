/* Catalogue-only input and history. Existing decision and plan actions stay in page.js. */
(function (g) {
  'use strict';
  function bind(root, page, main) {
    if (g.BriefRoadmapData) g.BriefRoadmapData.bind(root, page);
    var ui = page.state.ui, composing = false;
    function listen(type, handler, capture) {
      root.addEventListener(type, function (ev) { ui = page.state.ui; handler(ev); }, capture);
    }
    function refresh() { page.render(); }
    function heading() { var el = main.querySelector('.rmi-title'); if (el) el.focus({ preventScroll: true }); }
    function restore() {
      Object.keys(ui.expanded).forEach(function (key) { if (key.indexOf('rm-stage:') === 0) delete ui.expanded[key]; });
      ui.roadmapSheetReturnKey = null; ui.roadmapSheetVanished = false;
      ui.catalogueSelected = null; ui.roadmapSubView = 'board'; refresh();
      var saved = ui.catalogueReturn;
      if (!saved) return;
      var target = saved.search ? main.querySelector('#rmi-query') : Array.prototype.find.call(main.querySelectorAll('[data-act="rmi-open"]'), function (el) { return el.getAttribute('data-id') === saved.id; });
      if (target) target.focus({ preventScroll: true }); else heading();
      main.scrollTop = saved.scroll;
    }
    function open(id, search, push) {
      var roadmaps = page.state.model && page.state.model.roadmaps || [];
      if (!roadmaps.some(function (rm) { return rm.roadmapId === id; }) &&
        !(page.state.model.roadmapCatalogue && /^rm[a-f0-9]{12}$/.test(id))) return;
      if (push) {
        ui.catalogueReturn = { id: id, search: search, scroll: main.scrollTop };
        g.history.replaceState(Object.assign({}, g.history.state, { briefingCatalogue: true, roadmap: null }), '');
        g.history.pushState(Object.assign({}, g.history.state, { briefingCatalogue: true, roadmap: id }), '');
      }
      ui.catalogueSelected = id; ui.roadmapSubView = 'detail:' + id; refresh(); main.scrollTop = 0; heading();
    }
    listen('click', function (ev) {
      var t = ev.target.closest('[data-act]'); if (!t || !main.contains(t)) return;
      var act = t.getAttribute('data-act');
      if (act === 'rmi-open' || act === 'rmi-suggest') {
        ev.preventDefault(); open(t.getAttribute('data-id'), act === 'rmi-suggest', true);
      } else if (act === 'rmi-back') {
        if (g.history.state && g.history.state.briefingCatalogue && g.history.state.roadmap) g.history.back();
        else restore();
      } else if (act === 'rmi-find') {
        ui.catalogueTools = true; ui.catalogueSuggestions = true; refresh();
        var input = main.querySelector('#rmi-query'); if (input) input.focus();
      } else if (act === 'rmi-clear') {
        ui.catalogueQuery = ''; ui.catalogueTopic = 'all'; ui.catalogueActive = -1; ui.roadmapSearchPage = 0; refresh();
        main.querySelector('#rmi-query').focus();
      }
    });
    listen('mousedown', function (ev) {
      if (ev.target.closest('[data-act="rmi-suggest"]')) ev.preventDefault();
    });
    listen('toggle', function (ev) {
      if (ev.target.id === 'rmi-tools') {
        ui.catalogueTools = ev.target.open;
        if (!ev.target.open) ui.catalogueSuggestions = false;
      }
    }, true);
    function search(t) {
      ui.catalogueQuery = t.value; ui.catalogueSuggestions = true; ui.catalogueActive = -1; ui.roadmapSearchPage = 0; refresh();
    }
    listen('compositionstart', function (ev) { if (ev.target.id === 'rmi-query') composing = true; });
    listen('compositionend', function (ev) { if (ev.target.id === 'rmi-query') { composing = false; search(ev.target); } });
    listen('input', function (ev) { if (ev.target.id === 'rmi-query' && !composing && !ev.isComposing) search(ev.target); });
    listen('change', function (ev) {
      if (ev.target.id === 'rmi-topic') { ui.catalogueTopic = ev.target.value; ui.catalogueSuggestions = false; ui.roadmapSearchPage = 0; refresh(); }
    });
    listen('keydown', function (ev) {
      if (ev.target.id !== 'rmi-query' || composing || ev.isComposing) return;
      var options = main.querySelectorAll('[data-act="rmi-suggest"]');
      if (ev.key === 'Escape' || ev.key === 'Tab') {
        ui.catalogueSuggestions = false; ui.catalogueActive = -1;
        if (ev.key === 'Escape') ev.preventDefault();
        refresh();
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault(); ui.catalogueSuggestions = true;
        if (!options.length) { refresh(); options = main.querySelectorAll('[data-act="rmi-suggest"]'); }
        if (!options.length) return;
        var index = typeof ui.catalogueActive === 'number' ? ui.catalogueActive : -1;
        ui.catalogueActive = index < 0 ? (ev.key === 'ArrowDown' ? 0 : options.length - 1) : (index + (ev.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        refresh();
      } else if (ev.key === 'Enter' && options[ui.catalogueActive]) {
        ev.preventDefault(); open(options[ui.catalogueActive].getAttribute('data-id'), true, true);
      }
    });
    g.addEventListener('popstate', function (ev) {
      ui = page.state.ui;
      if (!ev.state || !ev.state.briefingCatalogue || ui.view !== 'plans') return;
      if (ev.state.roadmap) open(ev.state.roadmap, false, false); else restore();
    });
  }
  g.BriefRoadmapNavigation = { bind: bind };
})(typeof globalThis !== 'undefined' ? globalThis : this);
