// Pure port of OMO_Native_Recommendation.psm1 Compare-OmoRecommendation / Test-OmoRecommendationRevision.
// Statuses: recommended, fallback (from expectation tier), variant-different, different,
// unresolved, unassigned, untracked. No file I/O and no network.

export function normalizeModelName(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim()) return '';
  return modelId.split('/').at(-1).toLowerCase();
}

function coverageFor(manifest, route) {
  return (manifest?.coverage ?? []).find((entry) => entry?.route &&
    entry.section === route.Section && entry.role === route.Role) ?? null;
}

export function compareRecommendation(routes, manifest) {
  const items = [];
  for (const route of routes) {
    const coverage = coverageFor(manifest, route);
    const expectation = coverage?.recommendation
      ? (manifest?.expectations ?? []).find((entry) => entry.role === coverage.expectationRole) ?? null
      : null;
    let status = 'untracked';
    let tier = '';
    let official = '공식 권장 없음';
    const alias = String(route.ModelKey ?? '');
    const effectiveAlias = String(route.EffectiveAlias ?? '');
    const effectiveCategory = String(route.EffectiveCategory ?? '');
    const unresolved = Boolean(route.Unresolved);

    if (expectation) {
      official = (expectation.candidates ?? []).map((candidate) => {
        const variant = (candidate.variants ?? []).length > 0 ? ` / ${candidate.variants[0]}` : '';
        return `${candidate.model}${variant}`;
      }).join(' > ');

      const modelName = normalizeModelName(route.ModelId);
      const candidate = (expectation.candidates ?? []).find((entry) => normalizeModelName(entry.model) === modelName) ?? null;
      if (!candidate) {
        status = 'different';
      } else {
        tier = String(candidate.tier ?? '');
        const acceptedVariants = candidate.variants ?? [];
        if (acceptedVariants.length > 0 && !acceptedVariants.includes(String(route.Variant ?? '').toLowerCase())) {
          status = 'variant-different';
        } else {
          status = tier;
        }
      }
    }

    // An unresolved stored alias is an error even when no expectation exists.
    if (unresolved) {
      status = 'unresolved';
      tier = '';
    } else if (expectation && !String(route.ModelId ?? '')) {
      status = 'unassigned';
      tier = '';
    }

    let current = String(route.BadgeEn ?? '');
    if (alias) current += ` [${alias}]`;
    if (effectiveAlias) current += ` · 유효 경로: ${effectiveCategory} / ${effectiveAlias}`;
    items.push({
      Section: route.Section, Role: route.Role, ModelKey: alias,
      EffectiveAlias: effectiveAlias, EffectiveCategory: effectiveCategory,
      Current: current, Official: official, Status: status, Tier: tier,
      HasRecommendation: expectation !== null,
    });
  }

  const count = (predicate) => items.filter(predicate).length;
  const aligned = count((item) => item.Status === 'recommended' || item.Status === 'fallback');
  const variantDifferent = count((item) => item.Status === 'variant-different');
  const different = count((item) => item.Status === 'different');
  const errors = count((item) => item.Status === 'unresolved');
  const unassigned = count((item) => item.Status === 'unassigned');
  const untracked = count((item) => !item.HasRecommendation);
  const tracked = count((item) => item.HasRecommendation);
  const summary = tracked > 0 && aligned === tracked && errors === 0 ? 'aligned'
    : (tracked > 0 || errors > 0 ? 'partial' : 'none');

  return {
    Summary: summary,
    AlignedCount: aligned,
    VariantDifferentCount: variantDifferent,
    DifferentCount: different,
    TrackedCount: tracked,
    ErrorCount: errors,
    UnassignedCount: unassigned,
    UntrackedCount: untracked,
    Items: items,
  };
}

export function testRecommendationRevision(manifest, latestRevisions = {}) {
  const changed = [];
  const missing = [];
  for (const source of manifest?.sources ?? []) {
    if (!Object.hasOwn(latestRevisions, String(source.path))) {
      missing.push(String(source.path));
      continue;
    }
    if (String(latestRevisions[String(source.path)]) !== String(source.blobSha)) {
      changed.push({
        Path: String(source.path),
        Baseline: String(source.blobSha),
        Latest: String(latestRevisions[String(source.path)]),
      });
    }
  }
  const status = missing.length > 0 ? 'incomplete' : (changed.length > 0 ? 'changed' : 'current');
  return { Status: status, ChangedSources: changed, MissingSources: missing };
}

export function getRecommendationManifestShape(manifest) {
  if (manifest?.schemaVersion !== 1) {
    throw new Error(`Unsupported OMO recommendation manifest schema: ${manifest?.schemaVersion}`);
  }
  if ((manifest.sources ?? []).length !== 2) {
    throw new Error('The OMO recommendation manifest must track both installed model-chain bundles.');
  }
  return manifest;
}
