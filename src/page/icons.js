/* omo-briefing icons: the Lucide symbols src/render.mjs inlines once per page (<symbol id="i-<name>">, PAGE_ICONS).
 * Classic script (file:// safe, no modules), loaded before the other page scripts; they draw icons in their templates.
 *   g.BriefIcons.icon(name, cls?) -> '<svg class="ic[ cls]" aria-hidden="true" focusable="false"><use href="#i-<name>"></use></svg>'
 *     decorative: the text or the aria-label beside it says what it is. name and cls are the scripts' own constants.
 *     cls: page.css size modifiers ic-xs / ic-sm / ic-md / ic-rail, ic-fill (the favourite star when on), ic-sel (the
 *     selected rail item); without one an icon is a little taller than the text around it.
 *   g.BriefIcons.timed(text) -> html   a status line render.mjs writes ('전달됨 <stopwatch>09:12'), escaped, with its
 *     stopwatch (U+23F1) drawn as the clock icon. */
(function (g) {
  'use strict';

  function icon(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false"><use href="#i-' + name + '"></use></svg>';
  }
  function esc(v) {
    return String(v).replace(/[&<>"'`]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c];
    });
  }
  function timed(text) { return esc(text).split('\u23F1').join(icon('clock', 'ic-xs')); }

  g.BriefIcons = { icon: icon, timed: timed };
})(typeof globalThis !== 'undefined' ? globalThis : this);
