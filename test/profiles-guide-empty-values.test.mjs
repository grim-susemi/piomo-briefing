import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeController } from './fixtures/controller-dom.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/profiles-view-state.json', import.meta.url), 'utf8'));
const emptyWords = /\b(?:none|empty|unset|unassigned)\b|\bnot (?:set|assigned)\b|없음|비어|미지정|설정 안/i;

function valueFields(current) {
  const e = makeController({ modules: ['icons', 'view', 'plan-view', 'convo-view', 'shell', 'profiles-view', 'annotate'] });
  const row = {
    id: 'primary/sisyphus', group: 'primary', role: 'sisyphus', applyScope: 'primary-agent',
    current: { ...current, origin: 'unknown', reason: 'no-registry' },
    recommended: { HasRecommendation: false, status: 'untracked' },
    linked: { active: false, effective: false, candidates: [], reason: 'not-applicable' },
  };
  const model = e.ctx.BriefProfiles.guideRowModel(row, structuredClone(fixture), { live: true, pending: [] });
  e.byId.main.innerHTML = '<table><tbody>' + e.ctx.BriefProfiles.guideRowHtml(model) + '</tbody></table>';
  const main = e.byId.main.querySelector('[data-guide-row="primary/sisyphus"]');
  const detailId = main.querySelector('[data-pf="guide-row-toggle"]').getAttribute('aria-controls');
  const detail = e.document.getElementById(detailId);
  const saved = main.querySelector('[data-guide-field="CURRENT"]');
  const metadata = detail.querySelector('p').querySelectorAll('code').filter(code => !code.hasAttribute('data-guide-scope'));
  const effective = detail.querySelector('[data-guide-field="EFFECTIVE"]');
  const effectiveModel = effective.querySelector('code');
  // Isolate the thinking value from the field label and independently checked model.
  effective.querySelector('b').remove();
  effectiveModel.remove();
  return {
    'CURRENT.model': saved.querySelector('code'),
    'CURRENT.thinking': saved.querySelector('i'),
    'DETAIL.alias': metadata[0],
    'DETAIL.model': metadata[1],
    'EFFECTIVE.model': effectiveModel,
    'EFFECTIVE.thinking': effective,
  };
}

test('guide empty current, alias and effective values retain explicit empty information while nonempty values survive', () => {
  const populated = valueFields({ alias: 'sentinel-alias', modelId: 'probe/sentinel-model', thinking: 'sentinel-effort' });
  for (const [field, sentinel] of [
    ['CURRENT.model', 'sentinel-model'], ['CURRENT.thinking', 'sentinel-effort'],
    ['DETAIL.alias', 'sentinel-alias'], ['DETAIL.model', 'probe/sentinel-model'],
    ['EFFECTIVE.model', 'probe/sentinel-model'], ['EFFECTIVE.thinking', 'sentinel-effort'],
  ]) assert.ok(populated[field].textContent.includes(sentinel), `${field}: nonempty sentinel survives`);

  const empty = valueFields({ alias: '', modelId: '', thinking: '' });
  for (const [field, value] of Object.entries(empty)) {
    assert.ok(value, `${field}: actual rendered value location exists`);
    // Check explicit field information, not a computed accessibility name or a class inventory.
    const elements = [value, ...value.querySelectorAll('[aria-label], [aria-description], [title]')];
    const descriptions = [value.textContent, ...elements.flatMap(element =>
      ['aria-label', 'aria-description', 'title'].map(attribute => element.getAttribute(attribute) || ''))];
    assert.ok(descriptions.some(description => emptyWords.test(description)),
      `${field}: explicit empty-value description survives; actual ${value.innerHTML}`);
  }
});
