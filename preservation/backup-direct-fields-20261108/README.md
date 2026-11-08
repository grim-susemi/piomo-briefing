# Backup direct fields: preserved implementation delta

This patch contains only the backup selection changes against the recorded working-tree baseline at `b2166f652cf0a2cc00101483ff049307eb3235c9`. That baseline already contains unrelated uncommitted board and DeepSeek work. Those changes are not included as new changes in this archive.

This is a preservation commit, not a source merge into `main`. It does not claim the complete installed board can be rebuilt from a clean checkout of that commit alone.

The candidate was approved by the existing A/B reviewers and installed through the official installer as generation35. It adds explicit backup provider, model and reasoning selection on Primary, Agents and Categories, explicit save/reload, legacy string-alias compatibility, cancellation and preservation of unfinished drafts when another profile is saved. It assigns no user values and adds no automatic switching.

## Reconstruction

1. Use the preserved dirty baseline, not clean HEAD. Check the seven existing-file hashes in `manifest.json`; the other five paths must be absent.
2. Run `git apply changes.patch` only in an owned copy of that baseline.
3. Compare all twelve resulting SHA256 hashes with `candidate_sha256`.

This exact reconstruction was executed in an isolated copy: apply exit0, all twelve hashes matched. No tests or broad visual reviews were rerun for this archive. The earlier candidate checks and A/B approvals remain the feature evidence.

The original dirty worktree and approved candidate stay preserved. Shared-original ownership remains unresolved, so this archive must not be applied over another writer's files.

한국어: 백업 세 필드의 우리 변경만 보존한 패치입니다. 원본 코드 통합·원격 반영 완료가 아닙니다. 미커밋 기준선 사본에 적용해 최종 12개 파일이 바이트 동일하게 복원됨을 확인했습니다.
