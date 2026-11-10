// Shared browser measurements for the additive F8 grid/navigation checks.
import assert from 'node:assert/strict';

// Shared page-side measurement for the grid and WinForms comparison probes.
export const ROUTE_EDITOR_PROBE = `(route) => {
  const fields = [...route.querySelectorAll('select')].map(select => {
    const rect = select.getBoundingClientRect();
    return { name: select.dataset.pf, route: select.dataset.route,
      caption: select.closest('label')?.querySelector('.pf-sel-t')?.textContent || '',
      width: rect.width, height: rect.height,
      topmost: select.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
  });
  const backup = route.querySelector('.pf-backup');
  return { order: fields.map(field => field.name),
    primary: fields.filter(field => field.name.startsWith('route-') && field.name !== 'route-backup'),
    directBackup: fields.filter(field => field.name.startsWith('backup-')),
    alias: fields.filter(field => field.name === 'route-backup'),
    backupWidth: backup ? backup.getBoundingClientRect().width : 0 };
}`;

export function routeEditorDifferences(editor, route) {
  const differences = [];
  const compare = (check, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) differences.push({ check, expected, actual });
  };
  const groups = [
    ['primary', ['route-provider', 'route-model', 'route-thinking'], ['1. 구독 서비스', '2. AI 모델', '3. 추론 강도']],
    ['directBackup', ['backup-provider', 'backup-model', 'backup-thinking'], ['백업 1. 서비스', '백업 2. 모델', '백업 3. 추론강도']],
    ['alias', ['route-backup'], ['기존 등록 별칭']],
  ];
  compare('editor control order', editor.order, groups.flatMap(([, names]) => names));
  for (const [group, names, captions] of groups) {
    const fields = editor[group];
    compare(group + ' identities', fields.map(field => field.name), names);
    compare(group + ' captions', fields.map(field => field.caption), captions);
    compare(group + ' route binding', fields.map(field => field.route), names.map(() => route));
    compare(group + ' positive dimensions', fields.map(field => field.width > 0 && field.height > 0), names.map(() => true));
    compare(group + ' topmost', fields.map(field => field.topmost), names.map(() => true));
  }
  for (const group of ['primary', 'directBackup']) {
    const widths = editor[group].map(field => field.width);
    if (!(Math.min(...widths) > 0 && Math.max(...widths) - Math.min(...widths) <= 1)) {
      differences.push({ check: group + ' equal widths', expected: 'positive widths within 1px', actual: widths });
    }
  }
  if (!(editor.backupWidth > 0)) differences.push({ check: 'backup container width', expected: '> 0', actual: editor.backupWidth });
  if (editor.alias.length === 1) {
    const width = editor.alias[0].width;
    if (!(Math.abs(width - editor.backupWidth) <= 1 && width >= Math.max(...editor.primary.map(field => field.width)))) {
      differences.push({ check: 'alias spans backup container', expected: editor.backupWidth, actual: width });
    }
  }
  return differences;
}

export async function measurePurposeGrid(page, { boundary = false } = {}) {
  const paint = () => page.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const saved = await page.eval(`({
    tab: document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab,
    query: document.querySelector('#pf-routing-search').value,
    detailTop: document.querySelector('.pf-detail').scrollTop,
    rolesTop: document.querySelector('.pf-roles').scrollTop
  })`);
  await page.eval(`(() => {
    const input = document.querySelector('#pf-routing-search');
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.pf-row-sum[aria-expanded="true"]')?.click();
  })()`);
  const tabs = {};
  for (const tab of ['primary', 'agents', 'categories', 'memory']) {
    await page.eval(`document.querySelector('[data-tab="${tab}"]').click()`);
    await paint();
    tabs[tab] = await page.eval(`(() => {
      const grid = document.querySelector('#pf-panel-${tab}');
      const groups = [...grid.querySelectorAll('.pf-group')];
      const box = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; };
      const roles = document.querySelector('.pf-roles');
      return {
        containerWidth: roles.clientWidth,
        columns: getComputedStyle(grid).gridTemplateColumns.split(/\\s+/).length,
        visualColumns: new Set(groups.map(g => Math.round(g.getBoundingClientRect().left))).size,
        tracks: getComputedStyle(grid).gridTemplateColumns,
        gap: parseFloat(getComputedStyle(grid).columnGap),
        groups: groups.map(g => ({ id: g.dataset.flowSec, ...box(g), span: getComputedStyle(g).gridColumn,
          rows: [...g.querySelectorAll('.pf-row-sum')].map(s => s.dataset.row),
          scroll: getComputedStyle(g).overflowY })),
        maxRowHeight: Math.max(...[...grid.querySelectorAll('.pf-row-sum')].map(s => s.getBoundingClientRect().height)),
        horizontalScroll: Math.max(0, document.documentElement.scrollWidth - innerWidth, roles.scrollWidth - roles.clientWidth)
      };
    })()`);
  }
  const expanded = [];
  // Move the one open row between groups without resetting the page.
  for (const row of ['route:agents/explore', 'route:agents/plan-consultant', 'route:categories/deep-high']) {
    const tab = row.split(':')[1].split('/')[0];
    await page.eval(`(() => {
      document.querySelector('[data-tab="${tab}"]').click();
      document.querySelector('[data-row="${row}"]').click();
      document.querySelector('[data-row="${row}"]').parentElement.querySelector('.pf-tri').scrollIntoView({ block: 'nearest' });
    })()`);
    await paint();
    expanded.push(await page.eval(`(() => {
      const summary = document.querySelector('[data-row="${row}"]'), group = summary.closest('.pf-group');
      const editor = (${ROUTE_EDITOR_PROBE})(summary.parentElement);
      return { row: '${row}', group: group.dataset.flowSec, span: getComputedStyle(group).gridColumn,
        openGroups: [...document.querySelectorAll('.pf-group:has(.pf-row-sum[aria-expanded="true"])')].map(g => g.dataset.flowSec),
        editor, widths: editor.primary.map(field => field.width), topmost: editor.primary.map(field => field.topmost),
        overflowNodes: [...group.querySelectorAll('*')].filter(n => n.getBoundingClientRect().right >
          document.querySelector('.pf-roles').getBoundingClientRect().right).map(n => n.className),
        horizontalScroll: Math.max(0, document.documentElement.scrollWidth - innerWidth,
          document.querySelector('.pf-roles').scrollWidth - document.querySelector('.pf-roles').clientWidth) };
    })()`));
  }
  await page.eval(`document.querySelector('.pf-row-sum[aria-expanded="true"]').click()`);
  const navigation = {};
  for (const [mode, query, tab] of [
    ...['primary', 'agents', 'categories', 'memory'].map(tab => ['closed-' + tab, '', tab]),
    ['closed', '', 'categories'], ['search', 'r', 'categories'],
    ['searchDeep', 'deep', 'categories'], ['searchUltrabrain', 'ultrabrain', 'categories'],
    ['searchAllTabs', 'a', 'primary'],
  ]) {
    await page.eval(`(() => {
      const input = document.querySelector('#pf-routing-search');
      input.value = ${JSON.stringify(query)}; input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-tab="${tab}"]').click();
    })()`);
    await paint();
    const order = await page.eval(`(() => {
      const panels = [...document.querySelectorAll('.pf-tab-panel:not([hidden])')];
      const groups = panels.flatMap(p => [...p.querySelectorAll('.pf-group')]);
      const visual = panels.slice().sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        .flatMap(p => [...p.querySelectorAll('.pf-group')].sort((a,b) => {
          const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
          return x.top - y.top || x.left - y.left;
        }));
      const rows = list => list.flatMap(g => [...g.querySelectorAll('.pf-row-sum')].map(s => s.dataset.row));
      return { dom: rows(groups), visual: rows(visual), panels: panels.map(p => p.dataset.pfPanel) };
    })()`);
    if (mode === 'searchAllTabs') assert.equal(order.panels.length, 4, 'the cross-panel query covers every tab');
    await page.eval(`document.querySelector('.pf-tab-panel:not([hidden]) .pf-row-sum').focus()`);
    const keyboard = [];
    for (let i = 0; i < order.dom.length; i++) {
      keyboard.push(await page.eval('document.activeElement.dataset.row || null'));
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    }
    navigation[mode] = { ...order, keyboard };
  }
  const boundaries = [];
  if (boundary) {
    for (const width of [611, 612]) {
      await page.eval(`(() => {
        const roles = document.querySelector('.pf-roles');
        roles.style.width = '${width}px'; roles.style.boxSizing = 'content-box';
        roles.style.overflow = 'visible';
      })()`);
      await paint();
      boundaries.push(await page.eval(`({
        width: document.querySelector('.pf-roles').clientWidth,
        columns: getComputedStyle(document.querySelector('#pf-panel-categories')).gridTemplateColumns.split(/\\s+/).length,
        tracks: getComputedStyle(document.querySelector('#pf-panel-categories')).gridTemplateColumns
      })`));
    }
    await page.eval(`document.querySelector('.pf-roles').removeAttribute('style')`);
  }
  await page.eval(`(() => {
    const input = document.querySelector('#pf-routing-search');
    input.value = ${JSON.stringify(saved.query)}; input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-tab="${saved.tab}"]').click();
    document.querySelector('.pf-detail').scrollTop = ${saved.detailTop};
    document.querySelector('.pf-roles').scrollTop = ${saved.rolesTop};
  })()`);
  return { tabs, expanded, navigation, boundaries };
}

export function assertPurposeGrid(result, label, expectedColumns) {
  const baselineRows = ['primary', 'agents', 'categories', 'memory']
    .flatMap(tab => result.tabs[tab].groups.flatMap(group => group.rows));
  for (const [tab, m] of Object.entries(result.tabs)) {
    assert.equal(m.columns, expectedColumns, `${label} ${tab}: expected ${expectedColumns} columns`);
    if (tab !== 'primary' && m.groups.length > 1) {
      assert.equal(m.visualColumns, expectedColumns, `${label} ${tab}: rendered group columns`);
    }
    assert.equal(m.horizontalScroll, 0, `${label} ${tab}: horizontal scroll`);
    assert.ok(m.maxRowHeight > 0 && m.maxRowHeight <= 32, `${label} ${tab}: summary height ${m.maxRowHeight}`);
    assert.equal(m.gap, 12);
    if (expectedColumns === 2) assert.equal(m.tracks, '300px 300px');
    assert.ok(m.groups.every(g => g.scroll === 'visible'), 'groups never scroll independently');
  }
  assert.equal(result.tabs.primary.groups[0].span, '1 / -1');
  for (const m of result.expanded) {
    assert.equal(m.span, '1 / -1', `${label} ${m.row}: full span`);
    assert.deepEqual(m.openGroups, [m.group], `${label}: no stale expanded group`);
    assert.deepEqual(routeEditorDifferences(m.editor, m.row.slice('route:'.length)), [], `${label} ${m.row}: primary and backup fields`);
    assert.equal(m.horizontalScroll, 0);
  }
  for (const [mode, m] of Object.entries(result.navigation)) {
    assert.deepEqual(m.dom, m.visual, `${label}: visual group order`);
    assert.deepEqual(m.keyboard, m.visual, `${label}: native Tab order`);
    if (mode === 'closed') {
      assert.deepEqual(m.dom.filter(r => /categories\/(deep-low|deep-high|ultrabrain)$/.test(r)),
        ['route:categories/deep-low', 'route:categories/deep-high', 'route:categories/ultrabrain']);
    } else if (mode.startsWith('search') && mode !== 'searchAllTabs') {
      assert.ok(m.dom.length > 0, `${label}: search has real results`);
      assert.deepEqual(m.dom, baselineRows.filter(row => m.dom.includes(row)), `${label}: search preserves group subsequence`);
    }
  }
  for (const b of result.boundaries) assert.equal(b.columns, b.width === 612 ? 2 : 1, `container boundary ${b.width}`);
}
