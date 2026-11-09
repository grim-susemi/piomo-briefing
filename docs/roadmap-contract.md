# 로드맵 투영 계약 v1

## 운영과 후보 수용

원문 구조를 읽어 투영을 생성한 뒤 `roadmap_brief({projectionPath,expectedRevision:null})`로 최초 등록한다. 기존 등록은 현재 revision을 조회해 같은 경로와 `expectedRevision`으로 갱신한다. 구조가 바뀌면 section 해시와 연결 계획을 다시 조사해 투영을 갱신한다. 등록 해제는 `unregister:true`와 현재 revision을 명시하며 원문과 결정 기록은 삭제하지 않는다. CLI의 `--state-dir`은 격리 검증에서만 사용하고 실사용 등록은 명시적으로 승인된 범위에서만 수행한다.

확인 필요는 성공이나 착수 가능으로 바꾸지 않는다. 원문과 계획의 최신 해시, 작업 소속, 의존성, 영수증의 operation과 subjectHash를 확인하고 실제 읽기에 성공한 뒤 재등록하거나 새로고침한다. 기존 비구조화 결정은 승인을 추론하지 않는다. 범위가 명확한 새 질문이 필요하면 `requestGate`로 실제 질문을 만들고 그 응답 ID를 투영에 연결한다. 보류 또는 무응답은 승인이 아니다.

후보 수용은 저장소 루트에서 `node scripts/qa-roadmap-gate.mjs --fixture test/fixtures/roadmap/full.json --out <E>/final`로 실행한다. 기본 캡처 경로는 `<E>/task-6-r1`이며 다른 라운드는 `--evidence <capture-directory>`로 명시한다. 독립 검토 파일은 out의 `visual-a.json`, `visual-b.json`으로 제공한다. `npm test`, `npm run build`, `npm run check:timing`, 브라우저 수용과 sibling 검사를 각각 실행하고 로그 및 종료코드를 기록한다. 브라우저는 단일 소유자만 실행하므로 다른 캡처가 진행 중일 때 gate를 실행하지 않는다. `verdict.json`의 pass가 true이고 failures가 0일 때만 exit 0이다. 두 독립 시각 검토 영수증은 같은 캡처의 경로별 SHA256, source 및 HTML payload 해시, 실제 캡처와 검토 시각, 담당 범위와 findings를 포함해야 한다. 누락, 불일치, 실패는 통과가 아니다. 시험이나 시각 수용이 실패하면 설치하지 않는다.

설치는 후보 수용과 실제 agentDir, payload 해시, dry-run 및 중단·복귀 조건을 포함한 승인 범위를 확인한 후에만 한다. 복귀는 보존한 양호 payload의 SHA256을 확인하고 별도 recovery checkout의 dist로 복사한 뒤 그 checkout의 `node scripts/install.mjs --agent-dir <approvedAgentDir>`로 더 높은 새 세대를 만든다. shim을 옛 디렉터리로 되돌리거나 현재 state를 옛 사본으로 덮지 않는다. current/shim/server/page 세대, seq, 결정과 roadmaps 기록 보존을 확인한다. 상세 격리 리허설과 구세대 데이터 열화는 `docs/roadmap-install-gate.md`를 따른다.

이 문서는 구조와 증거의 계약이다. 투영은 상태, 완료, 착수 가능, 실행 승인 여부를 소유하지 않는다. 원문을 읽은 에이전트가 투영을 만들고 구조 변경 후 명시적으로 갱신한다. 등록 도구는 입력을 검증하고 등록하며 원문과 투영을 수정하지 않는다. 현재 후보는 설치되거나 등록된 것이 아니다.

## 구조

모든 객체는 알 수 없는 키를 거부한다. 문자열은 NFC, ID는 `[a-zA-Z0-9_-]{1,48}`이다. label은 유니코드 글자 14개 이하, goal은 80개 이하, note는 120개 이하이며 generatedBy는 1~80개다. 시각은 UTC RFC3339, 해시는 SHA256 64자리 16진수다. 배열 순서는 표시 순서다.

```
Projection = { schemaVersion: 1, generatedAt, generatedBy,
  sources: [{ id, path, headingPath: [string], sha256 }],
  tracks: [{ id, label, stageIds: [id] }],
  stages: [{ id, label, goal, sourceId, requires: [Condition],
    accepts: [Condition], plans: [{ path, taskIds: [string] | null }],
    requirementsKnown: boolean, note }] }
Condition = { kind: "stage", id }
  | { kind: "decision", gateId, decisionId: positiveInteger | null, scope, operation }
  | { kind: "receipt", path, sha256, subjectHash, operation }
Operation = "implement" | "install" | "publish" | "accept" | "other"
```

투영은 최대 8개, 각 파일은 UTF-8 256KiB 이하, 트랙은 6개 이하, 단계는 40개 이하, 단계별 계획은 4개 이하, 조건과 근거는 각각 16개 이하다. 전체 VM은 기존 2MiB 한도를 유지한다. 초과하면 이유와 경로를 표시하고 이전 유효 스냅샷을 보존한다. 조용히 자르지 않는다.

경로는 입력 프로젝트 루트 안 정규화된 절대경로다. 원문은 `.omo/drafts/*.md`, 계획은 `.omo/plans/*.md` 또는 `.omo/drafts/*.md`, 영수증은 `.omo/` 아래 명시 파일이다. `..`, 심볼릭 링크나 junction을 통한 탈출, 임의 URI를 거부한다. 결정은 해당 프로젝트와 세션의 소유권을 확인한다.

headingPath는 H1부터 하위 제목까지 정확한 경로이며 각 단계에서 제목이 유일해야 한다. BOM 제거와 LF 정규화 후 지정 제목 시작부터 다음 동급 또는 상위 제목 직전까지 UTF-8 SHA256을 계산한다. 자유 형식 표는 제품 파서의 입력이 아니다.

로드맵 ID는 정규화된 투영 경로의 SHA256 앞 12자리 앞에 `rm`을 붙인다. 파일 안 ID는 받지 않는다. 단계 ID는 투영 안에서 유일하며 순환, 없는 참조, 중복 소속, 소속 누락과 다른 투영의 단계 참조를 거부한다. 같은 계획이 여러 단계에 연결되면 taskIds를 명시한다. `null`은 전체 정규 작업 집합이며 중복 참조는 제거하고 중복 작업 정의는 집계 오류다.

## 조건과 증거

`requires`는 진입 조건이고 `accepts`는 출구 조건이다. 출구 시험은 자기 구현의 진입을 막지 않는다. 선행 단계는 현재 accepts 근거로 충족 여부를 판단한다. accepts가 비면 수용은 미확인이다.

결정 gateId는 단계 내 유일하다. `decisionId: null`은 아직 질문하지 않은 승인 요구이며 유효하다. 자동 질문이나 임의 번호를 만들지 않는다. 실제 질문 후 같은 gateId, scope, operation을 유지하며 실제 ID로 갱신하고 재등록한다. 질문의 소유권, 범위, operation이 일치해야 한다. revision 검사로 오래된 갱신이 최신 연결을 덮지 못하게 한다. 무응답 폐쇄와 보류는 승인이 아니다.

영수증 본문은 `{schemaVersion:1,result:"pass"|"fail",operation,subjectHash,checkedAt}` JSON이다. 조건과 본문의 operation, 파일 해시, 본문과 조건의 subjectHash가 모두 일치해야 한다. 기대 subjectHash는 다음 키 순서 그대로 `SHA256(UTF8(JSON.stringify(...)))`로 계산한다.

```
{schemaVersion:1,roadmapId,stageId,operation,sources,plans}
```

sources는 해당 단계 및 연결 source의 `{id,sha256}`를 ID 오름차순으로 정렬한다. plans는 `{path,sha256,taskIds}`를 정규화 경로 오름차순으로 정렬하고 taskIds는 고유 ID의 문자열 오름차순이다. null은 현재 완전한 inventory에서 확장한다. 계획이 없는 과거 단계는 `plans:[]`다. 읽기 또는 coverage 부족으로 기대 해시를 계산할 수 없다면 확인 필요다. 비정형 영수증을 pass로 추측하지 않는다.

## 판단과 집계

가능은 미완료 작업이 있고 현재 진입 조건, 의존성과 승인이 모두 충족되며 실행 중이 아닐 때만 참이다. 결정필요와 막힘은 독립적이고 동시 참일 수 있다. 열린 비보류 결정과 미질문 승인 요구는 결정필요다. 확인된 미완료 선행, 외부 실패 또는 거절은 막힘이다. held는 결정필요 목록에서 숨기되 승인 대기와 확인 필요로 착수를 막는다. 오래된 근거, 원문 변경, 누락, 계획 미작성과 불완전 집계는 확인 필요이며 가능하지 않다. running은 가능이나 완료의 증거가 아니다. 완료 또는 폐기 단계는 전체에는 남고 오늘 필터에서는 제외된다.

진척은 `{doneConfirmed,denominator,observedUniqueIds,excluded,unconfirmed,conflicts}`다. 파싱 누락, 중복, coverage 불명 또는 원장 tail 절단 시 denominator는 null이다. `[~]`는 분모에서 제외하고 excluded에 표시한다. `[x]` 뒤 검증 실패는 완료에서 제외하고 충돌을 표시한다. 완전한 빈 집합은 작업 없음, 계획 부재는 계획 미작성이지 100%가 아니다. D=N도 수용 통과는 아니다. 단계 간 비율을 합산하지 않는다.

## 갱신과 보존

실제 읽기 성공 시각만 checkedAt으로 쓴다. 60초 공유 캐시가 만료되거나 경로, section hash, 계획 hash, 영수증 hash가 바뀌거나 읽기에 실패하면 오래됨 또는 확인 필요로 표시한다. generatedAt만 바뀌어서는 근거가 갱신되지 않는다. 저장은 `<agentDir>/briefing/state/roadmaps/<rid>/{definition.json,status.json}`에 원자적으로 하고 단조 revision을 보존한다. 수집 실패는 마지막 유효 구조와 오류를 남기며 빈 성공 화면으로 바꾸지 않는다. 명시적 unregister는 원문, 기존 결정, 투영을 삭제하지 않는다.

## 작업 2의 명시적 계약 보완

`roadmap_brief({projectionPath,expectedRevision})`는 경로만 받아 등록한다. expectedRevision은 등록 기록 자체가 없을 때만 null이다. 갱신·재등록·등록 해제는 현재 양의 정수 revision과 정확히 일치해야 한다. 등록 해제는 `{projectionPath,expectedRevision,unregister:true}`로 요청한다. 해제는 registered=false인 기록을 남기고 revision을 증가시킨다. 같은 경로를 다시 등록할 때도 해제 기록의 revision을 사용하므로 오래된 등록·해제가 새 등록을 덮을 수 없다. 현재 revision에서 내용과 검증 증거가 같은 재등록은 같은 revision을 반환한다. 오래된 expectedRevision은 내용이 같아도 거부한다.

모든 등록 경로는 정규화된 realpath로 식별한다. Windows에서는 경로 ID를 계산할 때 대소문자를 구별하지 않는다. 전역 roadmaps/registry.lock을 배타 생성해 CAS 검사, 전체 개수·용량 검사와 definition.json의 원자적 replace를 같은 임계구역에 둔다. 다른 writer가 있으면 BUSY를 반환하고 상태를 바꾸지 않는다. 종료한 프로세스의 선점은 기존 store.reclaimStale 규칙으로만 회수한다. 원문·투영·결정·답·status.json은 등록 해제에서도 보존한다.

새 승인은 `roadmap_brief({projectionPath,expectedRevision,requestGate:{stageId,gateId}})`라는 별도 명시 요청으로만 질문한다. 현재 투영을 먼저 등록해야 하고 해당 gate의 decisionId는 null이어야 한다. 질문 요청은 투영을 수정하거나 decisionId를 자동 연결하지 않는다. 반환된 실제 decisionId를 에이전트가 같은 stageId·gateId·scope·operation으로 투영에 넣고 현재 revision으로 다시 등록한다. 같은 단계의 같은 gateId는 갱신 때 scope·operation을 바꿀 수 없다.

질문은 기존 결정 저장소에 새 불변 결정으로 생성한다. source="roadmap", approvalOption="A", rejectionOption="B"와 roadmapBinding={projectRoot,roadmapId,stageId,gateId,scope,operation}을 질문 생성 시 함께 저장한다. 질문 카드에 operation과 scope를 보여 주며 A는 해당 범위·작업만 승인, B는 거절이다. 번호만으로 답할 때의 기본 추천도 B이며 승인으로 추정하지 않는다. 요청을 반복하면 동일 binding의 닫히지 않은 결정 또는 보류한 결정을 재사용한다. held는 기존 closure.reason="held"이고 reopen은 기존 결정 API를 따른다. 승인 기록이나 검증 영수증은 생성하지 않는다.

일반 등록·갱신은 질문을 만들지 않는다. 기존 brief·plan_brief·question 결정에 roadmapBinding이 없으면 같은 프로젝트의 실제 결정이어도 bindingState="unknown"으로 등록하며 착수 승인에 사용할 수 없다. 질문 문구·메모리·에이전트의 승인 주장·answered closure에서 scope·operation을 추론하거나 사후 binding을 붙이지 않는다. 다른 프로젝트의 결정은 OWNERSHIP 오류다. binding이 있는 결정의 projectRoot·roadmapId·stageId·gateId·scope·operation이 조건과 다르면 BINDING 오류다. 원래 질문 세션의 meta.cwd가 같은 프로젝트인지 검증하므로 다른 세션에서도 전역 등록을 유지할 수 있다.

수집기는 `roadmapDecisionEvidence({definition,stage,store},gate)`로 unasked/open/held/approved/rejected/unknown을 읽는다. source="roadmap"의 정확한 binding이 있고 실제 answers/<id>.json의 A/B 응답이 있어야만 approved/rejected다. 답 없는 폐쇄와 비정형 기존 결정은 unknown이다. 등록 시 읽은 evidence.decisions의 bindingState는 승인 상태가 아니므로 수집할 때 현재 답·보류·폐쇄를 다시 읽는다. 영수증의 실제 subjectHash 재계산과 계획 inventory coverage 판정은 작업 3의 수집 경계에서 수행하며 등록 결과 자체는 수용 통과를 뜻하지 않는다.

scope는 NFC 1~120자, headingPath는 최대 6개 segment(각 1~200자), taskIds는 최대 400개 정규 작업 ID다. sources는 근거 한도 16개를 따른다. 동일 계획의 반복 참조와 taskIds는 canonical path 기준으로 중복 제거하되 서로 다른 단계의 명시 소속은 보존한다. 조건별 requires·accepts 배열은 각각 16개 이하다. 원문·계획 읽기는 파일당 2MiB, 투영·영수증 읽기는 파일당 256KiB로 제한한다. 등록 시 기존 게시 VM bytes와 활성 definition 전체 예상 bytes를 합산해 2MiB를 넘으면 LIMIT로 거절한다. 이는 보수적인 등록 예약 한도이며 작업 3·4의 최종 결합 VM 한도 검사를 대체하지 않는다.

## 경로 CLI와 수집기 인터페이스

CLI는 `node scripts/roadmap-check.mjs <projectionPath> --project-root <root>`로 읽기 전용 검증을 한다. 실제 번호가 있는 결정의 소유권 검증에는 `--state-dir <isolatedState>`가 필요하다. `--inspect --state-dir <state>`는 현재 revision과 registered를 반환한다. 등록은 `--register --expected-revision null|N --state-dir <state>`, 해제는 `--unregister --expected-revision N --state-dir <state>`다. 명시 질문은 `--request-stage <stageId> --request-gate <gateId> --session-id <sid> --expected-revision N --state-dir <state>`다. JSON 객체·승인 값·scope를 CLI 매개변수로 받지 않는다. 실패는 exit 1과 code/path/message를 반환한다.

`readRoadmaps(store)`는 해제 기록을 포함한 전역 definition 배열을 읽는다. 각 기록은 `{schema:"omo-roadmap/1",roadmapId,projectionPath,projectRoot,projectionHash,projection,evidence,revision,registered,checkedAt}`다. evidence는 sources의 section/file hash, plans의 현재 파일 hash, receipts의 본문과 hash, decisions의 bindingState를 보존한다. 수집 대상은 registered=true인 기록만이다. `roadmapDefinitionRel(id)`는 definition.json의 상대 경로다. task 3의 status writer는 이 구조 revision을 결속하고 별도 status.json을 원자적으로 저장하며 definition.json을 덮지 않는다. `roadmapSection`, `roadmapHash`, `roadmapFilePath`, `readRoadmapFile`은 수집기에서도 같은 경로·해시 경계로 재사용할 수 있다.
