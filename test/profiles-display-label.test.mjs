import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../src/page/icons.js', import.meta.url), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(new URL('../src/page/profiles-view.js', import.meta.url), 'utf8'), ctx);
const labels = (options) => Array.from(ctx.BriefProfiles.displayModelLabels(options));
const option = (model, extra = {}) => ({ value: model, model, ...extra });
const texts = (options) => labels(options).map((entry) => entry.text);

// R: public display API; a leaf-only implementation loses path identity.
test('uses the shortest unique suffix while preserving spelling, versions and tags', () => {
  const input = [
    'anthropic-subscription/claude-opus-5-5',
    'antigravity-ocx/google-antigravity/gemini-3.8-flash',
    'commandcode/zai-org/GLM-5.3', 'commandcode/z-ai/glm-5.3',
    'p/v4', 'p/v4.1', 'p/v41', 'p/model:0731', 'p/model:free',
  ].map((model) => option(model));
  const actual = texts(input);
  assert.deepEqual(actual, [
    'claude-opus-5-5', 'gemini-3.8-flash', 'zai-org/GLM-5.3', 'z-ai/glm-5.3',
    'v4', 'v4.1', 'v41', 'model:0731', 'model:free',
  ]);
  assert.equal(new Set(actual.map((text) => text.toLowerCase())).size, input.length);
});

// R: the completed pool includes disabled and unknown stored choices.
test('includes disabled and stored-missing models but excludes placeholders from collisions', () => {
  const input = [
    option('p/team/shared'),
    option('q/other/shared', { disabled: true }),
    option('retired/vendor/model:old', { missing: true }),
    option('p/model:old'),
    option('p/shared', { placeholder: true, text: '(선택)' }),
    option('p/deepseek-v4-flash', { disabled: true, off: { label: 'REGISTRY_UNKNOWN' } }),
  ];
  assert.deepEqual(texts(input), [
    'team/shared', 'other/shared', 'retired/vendor/model:old', 'model:old [ID 1]',
    '(선택)', 'deepseek-v4-flash · REGISTRY_UNKNOWN',
  ]);
});

// R: preservation of option payload and input immutability at the public boundary.
test('copies descriptors without changing values, order, state or provider metadata', () => {
  const input = Object.freeze([
    Object.freeze(option('p/vendor/a', { value: 'alias-a', selected: true, provider: 'p', text: 'old' })),
    Object.freeze(option('p/b', { disabled: true, dataProvider: 'p', off: Object.freeze({ label: 'UNSUPPORTED_MODEL' }) })),
  ]);
  const before = JSON.stringify(input);
  const actual = labels(input);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(actual, input);
  actual.forEach((entry, index) => {
    assert.notEqual(entry, input[index]);
    assert.deepEqual({ ...entry, text: input[index].text }, { ...input[index], text: input[index].text });
  });
  assert.deepEqual(actual.map((entry) => entry.text), ['a', 'b · UNSUPPORTED_MODEL']);
});

// R: stable numbering uses code-unit ordering rather than locale or option order.
test('case-only and provider-only collisions receive deterministic distinct ID numbers', () => {
  const input = ['z/model', 'p/Model', 'p/model'].map((model) => option(model));
  const actual = labels(input);
  assert.deepEqual(actual.map((entry) => entry.text), ['model [ID 3]', 'Model [ID 1]', 'model [ID 2]']);
  const reversed = labels([...input].reverse());
  assert.deepEqual(
    Object.fromEntries(reversed.map((entry) => [entry.model, entry.text])),
    Object.fromEntries(actual.map((entry) => [entry.model, entry.text])),
  );
});

// R: generated suffixes must not take existing display text (case insensitive).
test('ID numbering skips existing labels without regard to case', () => {
  const input = [
    option('p/Model'), option('p/model'),
    option('q/model [ID 1]'),
    option('q/MODEL [ID 2]', { missing: true }),
    option('r/model [ID 3]'),
  ];
  const actual = texts(input);
  assert.deepEqual(actual, [
    'Model [ID 2]', 'model [ID 4]', 'model [ID 1]', 'q/MODEL [ID 2]', 'model [ID 3]',
  ]);
  assert.equal(new Set(actual.map((text) => text.toLowerCase())).size, input.length);
});

// R: text remains raw data; escaping belongs to the later HTML rendering boundary.
test('preserves raw special characters and repeated model identity across aliases', () => {
  const model = 'p/vendor/<Model&"\'`>:free';
  const input = [option(model, { value: 'first' }), option(model, { value: 'second' })];
  assert.deepEqual(texts(input), ['<Model&"\'`>:free', '<Model&"\'`>:free']);
  assert.deepEqual(texts([option('retired/<&>/old', { missing: true })]), ['retired/<&>/old']);
});

// R: no-model states require neither invented choices nor mutable shared output.
test('empty pools and placeholder-only pools retain their shape and text', () => {
  assert.deepEqual(labels([]), []);
  const placeholder = { value: '', placeholder: true, text: '(선택)', selected: true };
  assert.deepEqual(labels([placeholder]).map((entry) => ({ ...entry })), [placeholder]);
});

// R: a literal stored ID reserves text even when it equals another model's path.
test('stored literals cannot be claimed by a shortened known model', () => {
  const input = [option('p/q/model'), option('q/model', { missing: true })];
  assert.deepEqual(texts(input), ['q/model [ID 1]', 'q/model']);
});

// R: the original order must not decide which sibling owns a label.
test('mixed completed pools have permutation-stable labels for every model', () => {
  const input = [
    option('p/a/leaf'), option('q/b/leaf', { disabled: true }),
    option('p/Model'), option('p/model'),
    option('retired/model:old', { missing: true }),
    option('p/model:old'), option('q/model [ID 1]'),
  ];
  const actual = [input, [...input].reverse(), [...input.slice(3), ...input.slice(0, 3)]]
    .map((pool) => Object.fromEntries(labels(pool).map((entry) => [entry.model, entry.text])));
  assert.equal(new Set(Object.values(actual[0]).map((text) => text.toLowerCase())).size, input.length);
  assert.deepEqual(actual[1], actual[0]);
  assert.deepEqual(actual[2], actual[0]);
});

// R: unsupported annotation is part of visible text and may occur literally in an ID.
test('unsupported annotations cannot collide with literal model text', () => {
  const input = [
    option('p/team/model', { disabled: true, off: { label: 'REGISTRY_UNKNOWN' } }),
    option('q/model · REGISTRY_UNKNOWN'),
  ];
  assert.deepEqual(texts(input), ['team/model · REGISTRY_UNKNOWN', 'model · REGISTRY_UNKNOWN']);
});

const state = JSON.parse(fs.readFileSync(new URL('./fixtures/profiles-view-state.json', import.meta.url), 'utf8'));
const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39|#96);/g,
  (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#96': '`' })[key]);
const attrs = (text) => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)]
  .map((match) => [match[1], decode(match[2])]));
const render = (value, edit = {}) => ctx.BriefProfiles.render(value, { live: true, pending: [], draft: {}, ...edit });
const picks = (html) => [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)]
  .map((match) => ({ attrs: attrs(match[1]), options: [...match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)]
    .map((entry) => ({ attrs: attrs(entry[1]), selected: /\bselected\b/.test(entry[1]), text: decode(entry[2]) })) }));

// R: every model picker points to its own full-ID description; values determine titles.
test('rendered model callers retain full selected titles and unique code descriptions', () => {
  const kinds = new Set();
  for (const tab of ['agents', 'categories', 'memory']) {
    const html = render(state, { tab });
    const descriptions = [...html.matchAll(/<p class="pf-fullid"([^>]*)><code>([\s\S]*?)<\/code><\/p>/g)];
    const byId = Object.fromEntries(descriptions.map((match) => [attrs(match[1]).id, decode(match[2])]));
    assert.equal(Object.keys(byId).length, descriptions.length, 'full-ID descriptions must have unique IDs');
    for (const pick of picks(html)) {
      const kind = pick.attrs['data-pf'];
      if (!['route-model', 'route-backup', 'backup-model', 'main-model', 'summarizer-model',
        'memory-model', 'agent-pin', 'advisor-model'].includes(kind)) continue;
      kinds.add(kind);
      const selected = pick.options.find((entry) => entry.selected);
      assert.ok(selected, kind + ' has a selected option');
      assert.equal(pick.attrs['aria-describedby'], pick.attrs.id + '-fullid');
      assert.ok(Object.hasOwn(byId, pick.attrs['aria-describedby']), kind + ' description exists');
      const value = selected.attrs.value;
      const mainProvider = kind === 'main-model' ? picks(html)
        .find((entry) => entry.attrs.id === pick.attrs.id.replace(/-model$/, '-provider'))
        .options.find((entry) => entry.selected).attrs.value : '';
      for (const option of pick.options) {
        const optionValue = option.attrs.value;
        if (!optionValue || optionValue === '__direct__') continue;
        if (kind === 'route-backup' && Object.hasOwn(state.catalog, optionValue)) continue;
        const model = kind === 'main-model' ? mainProvider + '/' + optionValue
          : kind === 'agent-pin' ? optionValue.replace('|', '/') : optionValue;
        const entry = Object.values(state.catalog).find((candidate) => candidate.model === model);
        const detail = entry?.unsupported ? ' · ' + entry.unsupportedReason
          + (entry.unsupportedHome ? ' · ' + entry.unsupportedHome : '') : '';
        const title = option.text === model.split('/').slice(1).join('/') ? undefined : model + detail;
        assert.equal(option.attrs.title, title, kind + ' ' + optionValue + ' serialized title');
      }
      if (!value || value === '__direct__') continue;
      const full = kind === 'main-model' ? mainProvider + '/' + value
        : kind === 'agent-pin' ? value.replace('|', '/')
        : kind === 'route-backup' ? state.catalog[value]?.model || value : value;
      assert.ok(byId[pick.attrs['aria-describedby']].includes(full), kind + ' code retains the full ID');
      if (kind === 'route-model') {
        assert.ok(pick.attrs.title.endsWith(full));
        if (Object.values(state.catalog).some((entry) => entry.model === full)) {
          assert.ok(pick.attrs.title.includes(' · '), 'registered role title retains its alias');
        }
      } else {
        assert.equal(pick.attrs.title, full, kind + ' title is the full ID');
      }
    }
  }
  assert.deepEqual([...kinds].sort(), ['agent-pin', 'backup-model', 'main-model', 'memory-model',
    'route-backup', 'route-model', 'summarizer-model'].sort());
});

// R: actual HTML output, not the raw helper, owns escaping and shortening.
test('role rendering escapes raw model and alias once across options titles and code', () => {
  const value = structuredClone(state);
  const alias = 'raw<&"\'`>', model = 'escape/vendor/<model&"\'`>:free';
  value.catalog[alias] = { model, variant: 'high' };
  const row = value.routing.rows.find((entry) => entry.section === 'agents');
  row.model = alias;
  const html = render(value, { tab: 'agents' });
  const pick = picks(html).find((entry) => entry.attrs['data-route'] === row.section + '/' + row.role
    && entry.attrs['data-pf'] === 'route-model');
  const selected = pick.options.find((entry) => entry.selected);
  assert.equal(selected.attrs.value, model);
  assert.equal(selected.text, '<model&"\'`>:free');
  assert.equal(pick.attrs.title, alias + ' · ' + model);
  assert.equal(selected.attrs.title, model);
  assert.ok(html.includes('<code>' + ctx.BriefProfiles.escapeHtml(model) + ' · ' + ctx.BriefProfiles.escapeHtml(alias) + '</code>'));
  assert.ok(!html.includes('&amp;lt;model'), 'render boundary must not escape twice');
  assert.ok(!html.includes('<model&'), 'raw model cannot become markup');
});

// R: registered aliases retain effort while ordinary model options omit alias repetition.
test('registered backup labels keep alias effort and the short model', () => {
  const html = render(state, { tab: 'agents' });
  const backups = picks(html).filter((pick) => pick.attrs['data-pf'] === 'route-backup');
  assert.ok(backups.length > 0, 'registered backup pickers exist');
  assert.equal(backups[0].attrs['data-route'], 'primary/sisyphus', 'retain the first Primary control');
  for (const backup of backups) {
  const [section, role] = backup.attrs['data-route'].split('/');
  const row = section === 'primary' ? null
    : state.routing.rows.find((entry) => entry.section === section && entry.role === role);
  if (section !== 'primary') assert.ok(row, 'routing fixture owns ' + backup.attrs['data-route']);
  const expected = Object.keys(state.catalog).filter((alias) => (section === 'primary' || alias !== row.model)
    && (section !== 'primary' || role !== 'hephaestus'
      || state.catalog[alias].model.split('/').slice(1).join('/').startsWith('gpt-'))
    && (!state.catalog[alias].model.startsWith('opencode-go/')
      || /^(?:ocg-)?muse-/i.test(state.catalog[alias].model.split('/').slice(1).join('/'))));
  const aliases = backup.options.filter((entry) => entry.attrs.value);
  assert.deepEqual(aliases.map((entry) => entry.attrs.value), expected);
  for (const option of aliases) {
    const entry = state.catalog[option.attrs.value];
    assert.ok(option.text.startsWith(option.attrs.value + ' · '));
    if (entry.variant) assert.ok(option.text.includes(' / ' + entry.variant));
    assert.equal(Object.hasOwn(option.attrs, 'title'), false,
      'alias titles are verified at trusted use in profiles-deferred-titles.test.mjs');
  }
  }
});

// R: full-scale annotated pools may repeat aliases while retaining model identity.
test('large annotated alias pools retain all descriptors and distinct model text', () => {
  const input = Array.from({ length: 128 }, (_, index) => option('p/vendor/model-' + index,
    { value: 'alias-' + index, off: { label: 'REGISTRY_UNKNOWN' } }));
  input.push({ ...input[0], value: 'second-alias' });
  const actual = labels(input);
  assert.deepEqual(actual.map((entry) => entry.value), input.map((entry) => entry.value));
  assert.equal(new Set(actual.map((entry) => entry.text.toLowerCase())).size, 128);
  assert.equal(actual[128].text, actual[0].text);
  assert.equal(actual[127].text, 'model-127 · REGISTRY_UNKNOWN');
});
