// One case per recommendation status, plus revision tracking.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareRecommendation, getRecommendationManifestShape, normalizeModelName, testRecommendationRevision,
} from '../src/profiles/recommend.mjs';

const manifest = {
  schemaVersion: 1,
  title: 'guide',
  sources: [
    { path: 'a', blobSha: 'aaa', webUrl: 'https://example/a' },
    { path: 'b', blobSha: 'bbb', webUrl: 'https://example/b' },
  ],
  coverage: [
    { route: true, section: 'agents', role: 'explore', recommendation: 'primary', expectationRole: 'explore' },
    { route: true, section: 'agents', role: 'librarian', recommendation: 'fallback', expectationRole: 'librarian' },
    { route: true, section: 'agents', role: 'oracle', recommendation: 'primary', expectationRole: 'oracle' },
    { route: true, section: 'categories', role: 'quick', recommendation: 'primary', expectationRole: 'quick' },
    { route: true, section: 'categories', role: 'unspecified-low', recommendation: 'primary', expectationRole: 'unspecified-low' },
    { route: true, section: 'categories', role: 'deep-low', recommendation: 'primary', expectationRole: 'deep-low' },
  ],
  expectations: [
    { role: 'explore', candidates: [{ model: 'anthropic/claude-opus-5-5', tier: 'recommended', variants: ['medium'] }] },
    { role: 'librarian', candidates: [{ model: 'kimi/kimi-k3', tier: 'fallback', variants: ['max'] }] },
    { role: 'oracle', candidates: [{ model: 'openai/gpt-6.1-sol', tier: 'recommended', variants: ['high'] }] },
    { role: 'quick', candidates: [{ model: 'x/glm-5.3', tier: 'recommended', variants: ['max'] }] },
    { role: 'unspecified-low', candidates: [{ model: 'x/deepseek-v4', tier: 'recommended', variants: ['high'] }] },
    { role: 'deep-low', candidates: [{ model: 'x/claude-fable-5-1', tier: 'recommended', variants: [] }] },
  ],
};

function route(overrides) {
  return {
    Section: 'agents', Role: 'explore', ModelKey: 'alias', ModelId: 'p/m', Variant: 'medium',
    BadgeEn: 'Provider · Model', EffectiveAlias: '', EffectiveCategory: '', Unresolved: false,
    ...overrides,
  };
}

const routes = [
  route({ Role: 'explore', ModelId: 'anthropic/claude-opus-5-5', Variant: 'medium' }),
  route({ Role: 'librarian', ModelId: 'kimi/kimi-k3', Variant: 'max' }),
  route({ Role: 'oracle', ModelId: 'openai/gpt-6.1-sol', Variant: 'low' }),
  route({ Section: 'categories', Role: 'quick', ModelId: 'x/deepseek-v4', Variant: 'max' }),
  route({ Section: 'categories', Role: 'unspecified-low', ModelId: '', Variant: '' }),
  route({ Section: 'categories', Role: 'deep-low', ModelId: 'x/claude-fable-5-1', ModelKey: 'ghost', Unresolved: true }),
  route({ Section: 'categories', Role: 'writing', ModelId: 'x/whatever', ModelKey: 'w' }),
];

test('every recommendation status has a case', () => {
  const result = compareRecommendation(routes, manifest);
  const byRole = Object.fromEntries(result.Items.map((item) => [`${item.Section}/${item.Role}`, item]));
  assert.equal(byRole['agents/explore'].Status, 'recommended');
  assert.equal(byRole['agents/librarian'].Status, 'fallback');
  assert.equal(byRole['agents/oracle'].Status, 'variant-different');
  assert.equal(byRole['categories/quick'].Status, 'different');
  assert.equal(byRole['categories/unspecified-low'].Status, 'unassigned');
  assert.equal(byRole['categories/deep-low'].Status, 'unresolved');
  assert.equal(byRole['categories/writing'].Status, 'untracked');
  assert.equal(byRole['agents/explore'].Tier, 'recommended');
  assert.equal(byRole['agents/oracle'].Tier, 'recommended');
  assert.equal(byRole['categories/deep-low'].Tier, '');
  assert.equal(byRole['agents/explore'].Official, 'anthropic/claude-opus-5-5 / medium');
  assert.equal(byRole['agents/explore'].Current, 'Provider · Model [alias]');
  assert.equal(byRole['categories/writing'].Official, '공식 권장 없음');
});

test('summary counts and the partial/aligned/none states', () => {
  const result = compareRecommendation(routes, manifest);
  assert.equal(result.AlignedCount, 2);
  assert.equal(result.VariantDifferentCount, 1);
  assert.equal(result.DifferentCount, 1);
  assert.equal(result.ErrorCount, 1);
  assert.equal(result.UnassignedCount, 1);
  assert.equal(result.UntrackedCount, 1);
  assert.equal(result.TrackedCount, 6);
  assert.equal(result.Summary, 'partial');

  const aligned = compareRecommendation([routes[0], routes[1]], manifest);
  assert.equal(aligned.Summary, 'aligned');
  assert.equal(aligned.AlignedCount, 2);

  const none = compareRecommendation([routes[6]], manifest);
  assert.equal(none.Summary, 'none');
  assert.equal(none.UntrackedCount, 1);
});

test('unresolved wins even without a tracked expectation, and effective routes render', () => {
  const result = compareRecommendation([
    route({ Role: 'ouroboros', ModelKey: 'ghost', ModelId: '', Unresolved: true }),
    route({ Role: 'omo-native-code-reviewer', ModelKey: '', ModelId: '', EffectiveAlias: 'kimi-max', EffectiveCategory: 'unspecified-high' }),
  ], manifest);
  assert.equal(result.Items[0].Status, 'unresolved');
  assert.equal(result.Items[0].HasRecommendation, false);
  assert.match(result.Items[1].Current, /유효 경로: unspecified-high \/ kimi-max/);
  assert.equal(result.ErrorCount, 1);
});

test('model names normalize by their last path segment', () => {
  assert.equal(normalizeModelName('provider/sub/GPT-6.1-SOL'), 'gpt-6.1-sol');
  assert.equal(normalizeModelName(''), '');
});

test('revision tracking reports current, changed and incomplete', () => {
  assert.equal(testRecommendationRevision(manifest, { a: 'aaa', b: 'bbb' }).Status, 'current');
  const changed = testRecommendationRevision(manifest, { a: 'aaa', b: 'new' });
  assert.equal(changed.Status, 'changed');
  assert.deepEqual(changed.ChangedSources, [{ Path: 'b', Baseline: 'bbb', Latest: 'new' }]);
  const incomplete = testRecommendationRevision(manifest, { a: 'aaa' });
  assert.equal(incomplete.Status, 'incomplete');
  assert.deepEqual(incomplete.MissingSources, ['b']);
});

test('the manifest shape guard rejects the wrong schema and source count', () => {
  assert.equal(getRecommendationManifestShape(manifest), manifest);
  assert.throws(() => getRecommendationManifestShape({ schemaVersion: 2, sources: [] }), /Unsupported/);
  assert.throws(() => getRecommendationManifestShape({ schemaVersion: 1, sources: [] }), /both installed/);
});
