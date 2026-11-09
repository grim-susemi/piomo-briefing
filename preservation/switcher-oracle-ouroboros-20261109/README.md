# Switcher: oracle / ouroboros roles and the two Oracle advisors

This archive keeps only the switcher change that lets the owner pick service, model and reasoning effort for the `oracle` and `ouroboros` agent rows and for the two Oracle advisors (`claude`, `gpt`). It is a preservation commit, not a source merge into `main`.

## What changed
- `src/profiles/refresh.mjs`: profile-declared and file-defined agents become editable role rows (they were read-only).
- `src/profiles/oracle-advisors.mjs` (new): reads advisor rows from `agent/oracle-advisor/routing.json` and writes only `profiles.<advisor>.model` as `provider/model:level`. A model of another family, an unknown advisor or a missing file is refused (`ADVISOR_FAMILY` and others).
- `src/profiles/store.mjs`: a `setAdvisor` change kind in the same transaction as the other switcher files (hash compare-and-swap, backup, atomic write, journal).
- `src/page/profiles-view.js` and its generated artifact: the advisor group in the Agents tab, same-family model lists, the advisor-only save label, and a Korean message for the family refusal.
- Tests for the three modules.

## Rebuild
1. Take the baseline of `../backup-direct-fields-20261108/` and apply that archive's patch.
2. Run `git apply changes.patch` in an owned copy of the result.
3. Compare the nine resulting SHA256 hashes with `candidate_sha256` in `manifest.json`.

This exact reconstruction was executed in an isolated copy: apply exit 0, all nine hashes matched.

## Evidence (kept on the owner's machine)
- Full suite once on the candidate: 2240 tests, 2199 passed, 41 failed. The same 41 tests fail on the unchanged baseline, so this change adds no new failure. It is not a full pass.
- Isolated UI QA and two independent visual reviewers (behavior, layout) both approved after fixes.
- Installed through `scripts/install.mjs` as generation-000036. Live settings hashes were unchanged by the install.

한국어: 스위처에서 oracle·ouroboros 역할과 오라클 자문가 2명(claude/gpt)의 모델·추론강도를 고르게 한 변경만 보존한 패치입니다. 원본 코드 통합이나 main 반영이 아닙니다. 기준선 사본에 적용해 9개 파일이 바이트 동일하게 복원되는 것을 확인했습니다.
