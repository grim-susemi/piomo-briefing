/* Title catalogue and ordered detail. Uses collected roadmaps, never sample data.
 * #main remains the scroll owner; navigation state belongs to the page controller. */
(function (g) {
  'use strict';
  function text(value) { return typeof value === 'string' ? value : ''; }
  function title(rm) { return rm.tracks.map(function (t) { return t.label; }).join(' · ') || rm.roadmapId; }
  function topic(rm) { return rm.tracks.length ? rm.tracks[0].label : '미분류'; }
  function visible(roadmaps, ui) {
    var query = text(ui.catalogueQuery).trim().toLocaleLowerCase();
    return roadmaps.filter(function (rm) {
      return (!ui.catalogueTopic || ui.catalogueTopic === 'all' || topic(rm) === ui.catalogueTopic) &&
        title(rm).toLocaleLowerCase().indexOf(query) >= 0;
    });
  }
  function render(roadmaps, ui, api) {
    var e = api.esc, selected = roadmaps.find(function (rm) { return rm.roadmapId === ui.catalogueSelected; });
    var html = '<div class="roadmap-view rm-catalogue">';
    if (api.legacy) return html + '<h1 class="rm-title rmi-title" tabindex="-1">로드맵</h1><p class="rm-banner rm-legacy" role="status">구세대 데이터 · 이 스냅샷에는 로드맵 정보가 없습니다. 연결 계획에서 기존 대화별 계획을 확인하세요.</p>' + api.plansButton + '</div>';
    if (ui.catalogueSelected) {
      html += '<button type="button" class="more rmi-back" data-act="rmi-back">전체 목록으로</button>';
      if (!selected && api.loading) return html + '<h1 class="rm-title rmi-title" tabindex="-1">로드맵을 여는 중</h1><p role="status">상세 자료를 읽는 중입니다.</p></div>';
      if (!selected && api.loadError) return html + '<h1 class="rm-title rmi-title" tabindex="-1">로드맵을 읽지 못했습니다</h1><p>다시 읽기를 누르거나 전체 목록으로 돌아가세요.</p></div>';
      if (!selected) return html + '<h1 class="rm-title rmi-title" tabindex="-1">로드맵을 찾을 수 없습니다</h1><p>등록이 변경되었습니다. 전체 목록으로 돌아가 다시 선택하세요.</p></div>';
      html += '<h1 class="rm-title rmi-title" tabindex="-1">' + e(title(selected)) + '</h1>';
      if (selected.error || selected.stale) html += '<p class="rm-banner" role="status">' +
        (selected.error ? '상태 수집 오류 · 마지막 유효 구조를 보존했습니다.' : '오래된 근거 · 현재 착수 가능 여부는 확인이 필요합니다.') + '</p>';
      selected.tracks.forEach(function (track) {
        html += '<section class="rmi-track" aria-label="' + e(track.label) + '">' +
          (selected.tracks.length > 1 ? '<p class="rmi-track-label">' + e(track.label) + '</p>' : '');
        track.stages.forEach(function (stage) {
          var entry = api.entries.find(function (item) { return item.roadmapId === selected.roadmapId && item.stage.id === stage.id; });
          var key = 'rm-stage:' + selected.roadmapId + ':' + stage.id;
          var badges = entry ? entry.badges.map(function (b) { return b.label; }).join(' · ') : '확인 필요';
          html += '<article class="rmi-stage" data-rm-stage="' + e(stage.id) + '"><header class="rmi-stage-heading"><h2>' +
            e(stage.label) + '</h2><span class="rmi-state">' + e(badges || '확인 필요') + '</span></header>' +
            '<p>' + e(stage.goal) + '</p><p class="rmi-meta">' + e(api.progress(stage)) + '</p>';
          if (entry && entry.reasons.length) html += '<p class="rmi-meta">' + e(entry.reasons.map(function (r) { return r.text; }).join(' · ')) + '</p>';
          if (!stage.plans.length) html += '<p class="rmi-meta">연결된 계획 없음 · 작업 미작성</p>';
          stage.plans.forEach(function (plan) {
            var match = api.matchPlan(plan), tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
            html += '<ul class="rmi-tasks">';
            tasks.forEach(function (task) {
              var known = match && match.plan && Array.isArray(match.plan.tasks) ? match.plan.tasks.find(function (t) { return String(t.id) === String(task.id); }) : null;
              var state = task.conflict ? '충돌 · 확인 필요' : task.mark === '~' ? '제외' : task.mark === 'x' ? '작업 완료' : task.last === 'dispatch' ? '진행' : '미완료';
              html += '<li><strong>' + e(known ? known.what || known.label : '작업 ' + task.id) + '</strong><span>' + e(state) + '</span></li>';
            });
            html += '</ul>';
          });
          html += '<details class="rmi-evidence" data-open-key="rmi-evidence:' + e(key) + '"' + (ui.expanded && ui.expanded['rmi-evidence:' + key] ? ' open' : '') +
            '><summary>결정·근거·계획 원문</summary><ul class="rm-conds">' +
            stage.requires.concat(stage.accepts).map(function (c) { return api.condition(c, selected); }).join('') + '</ul><ul class="rm-plan-list">' +
            stage.plans.map(api.planItem).join('') + '</ul>' +
            '<button type="button" class="more" data-act="exp" data-key="' + e(key) + '" aria-expanded="' + (ui.expanded && ui.expanded[key] ? 'true' : 'false') + '">단계 상세 열기</button></details></article>';
        });
        html += '</section>';
      });
      return html + api.plansButton + '<div id="rm-sheet-host">' + api.sheets(selected) + '</div></div>';
    }
    var list = visible(roadmaps, ui), topics = api.topics ? api.topics.slice() : [], groups = [];
    if (!api.topics) roadmaps.forEach(function (rm) { if (topics.indexOf(topic(rm)) < 0) topics.push(topic(rm)); });
    if (ui.catalogueTopic && ui.catalogueTopic !== 'all' && topics.indexOf(ui.catalogueTopic) < 0) topics.push(ui.catalogueTopic);
    list.forEach(function (rm) { if (groups.indexOf(topic(rm)) < 0) groups.push(topic(rm)); });
    html += '<header class="rmi-head"><h1 class="rm-title rmi-title" tabindex="-1">로드맵</h1><button type="button" class="more" data-act="rmi-find">제목 찾기</button></header>';
    if (api.readErrors.length) html += '<p role="alert">로드맵 읽기 오류: ' + e(api.readErrors.join(', ')) + '</p>';
    if (!roadmaps.length && !api.total && !api.loading) html += '<p class="rmi-empty">등록된 로드맵이 없습니다. 연결 계획에서 기존 계획을 확인할 수 있습니다.</p>';
    groups.forEach(function (name) {
      var group = list.filter(function (rm) { return topic(rm) === name; });
      if (!group.length) return;
      html += '<section class="rmi-topic"><h2>' + e(name) + '</h2><div class="rmi-cards">' + group.map(function (rm) {
        return '<button type="button" class="rmi-card" data-act="rmi-open" data-id="' + e(rm.roadmapId) + '">' + e(title(rm)) + '</button>';
      }).join('') + '</div></section>';
    });
    if ((roadmaps.length || api.total > 0) && !list.length && !api.loading) html += '<p class="rmi-empty" role="status">일치하는 제목이 없습니다. 검색어나 주제 조건을 지워 보세요.</p>';
    var suggestions = ui.catalogueSuggestions ? list.slice(0, 4) : [];
    html += '<details class="rmi-tools" id="rmi-tools"' + (ui.catalogueTools ? ' open' : '') + '><summary>제목 검색·주제</summary>' +
      '<div class="rmi-fields"><div><label for="rmi-query">로드맵 제목</label><input type="search" id="rmi-query" data-act="rmi-query" role="combobox" autocomplete="off" aria-autocomplete="list" aria-controls="rmi-suggestions" aria-expanded="' + Boolean(suggestions.length) + '"' +
      (suggestions[ui.catalogueActive] ? ' aria-activedescendant="rmi-option-' + ui.catalogueActive + '"' : '') + ' value="' + e(ui.catalogueQuery || '') + '" placeholder="현재 로드맵 제목 찾기">' +
      '<ul id="rmi-suggestions" class="rmi-suggestions" role="listbox" aria-label="현재 제목 제안">' + suggestions.map(function (rm, i) {
        return '<li id="rmi-option-' + i + '" role="option" aria-selected="' + (ui.catalogueActive === i) + '" data-act="rmi-suggest" data-id="' + e(rm.roadmapId) + '">' + e(title(rm)) + '</li>';
      }).join('') + '</ul></div><div><label for="rmi-topic">주제</label><select id="rmi-topic" data-act="rmi-topic"><option value="all">전체 주제</option>' +
      topics.map(function (name) { return '<option value="' + e(name) + '"' + (ui.catalogueTopic === name ? ' selected' : '') + '>' + e(name) + '</option>'; }).join('') +
      '</select></div></div><p class="rmi-meta" role="status">현재 조건에서 ' + (typeof api.matchedCount === 'number' ? api.matchedCount : list.length) + '개 제목</p><button type="button" class="more" data-act="rmi-clear">검색·주제 지우기</button></details>' +
      '<footer class="rmi-footer">' + api.plansButton + '</footer></div>';
    return html;
  }
  g.BriefRoadmapIndex = { render: render, visible: visible, title: title };
})(typeof globalThis !== 'undefined' ? globalThis : this);
