/* Stream every global index page; retain one byte-bounded result page, never the entire index. */
(function (g) {
  'use strict';
  var state = null, PAGE_BYTES = 128 * 1024;
  function read(model, ui, load) {
    var descriptor = model.roadmapCatalogue, wanted = ui.roadmapSearchPage || 0;
    var query = (ui.catalogueQuery || '').trim().toLocaleLowerCase(), topic = ui.catalogueTopic || 'all';
    var signature = JSON.stringify([descriptor.key, model.gen, query, topic, wanted]);
    if (!state || state.signature !== signature) {
      state = { signature: signature, next: 0, total: 0, resultPage: 0, bytes: 2, items: [], done: false };
    }
    while (state.next < descriptor.searchPages) {
      var loaded = load('search', state.next);
      if (!loaded || loaded.error) return { items: [], loading: !loaded, error: loaded && loaded.error };
      loaded.items.forEach(function (item) {
        if (!g.BriefRoadmapIndex.visible([item], ui).length) return;
        var bytes = new g.TextEncoder().encode(JSON.stringify(item)).length + 1;
        if (state.bytes + bytes > PAGE_BYTES) { state.resultPage++; state.bytes = 2; }
        state.bytes += bytes;
        if (state.resultPage === wanted) state.items.push(item);
        state.total++;
      });
      state.next++;
    }
    state.done = true;
    return { items: state.items, loading: false, error: null, total: state.total, pages: state.resultPage + 1, page: wanted };
  }
  g.BriefRoadmapSearch = { read: read };
})(typeof globalThis !== 'undefined' ? globalThis : this);
